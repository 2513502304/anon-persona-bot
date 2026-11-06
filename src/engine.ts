import { createHash, randomUUID } from 'node:crypto';
import { mutate, type Store } from './store.ts';
import { initialSettings, command } from './commands.ts';
import { generate, ProviderFailure } from './models.ts';
import { personaPrompt } from './personas.ts';
import { secretEquals, QQFailure } from './qq.ts';
import type { Binding, Incoming, Job, Session, Settings } from './types.ts';
import { AccountsService } from './accounts.ts';
import { imageCommand, generateImage } from './images.ts';
import { uploadQQImage, replyQQImage } from './qq.ts';
import { compactIfNeeded, memoryTurns, summarize } from './memory.ts';

const LEASE_MS = 240_000;
export function sessionKey(input: Incoming): string {
  const scope = input.scope === 'private' ? `${input.platform}:private:${input.user}` : `${input.platform}:${input.group}:${input.user}`;
  return `sessions/${createHash('sha256').update(scope).digest('hex')}.json`;
}
function initialSession(): Session { return { settings: initialSettings(), jobs: [], completed: [], updatedAt: Date.now() }; }
export interface EngineOptions {
  pairingCode: string;
  enabled: boolean;
  generate?: typeof generate;
  deliver: (input: Incoming, text: string) => Promise<string>;
  now?: () => number;
  generateImage?: typeof generateImage;
  uploadImage?: typeof uploadQQImage;
  deliverImage?: typeof replyQQImage;
  summarize?: typeof summarize;
}

/** Durable inbox owns correctness; SDK-local routing state is never used as persistence. */
export class Engine {
  private now: () => number;
  private accounts: AccountsService;
  constructor(public readonly store: Store, private readonly options: EngineOptions) {
    this.now = options.now ?? Date.now; this.accounts = new AccountsService(store, this.now);
  }

  async accept(input: Incoming): Promise<{ accepted: boolean; key?: string; busy?: boolean }> {
    if (Math.abs(this.now() - input.timestamp) > 240_000) return { accepted: false };
    let binding = (await this.store.read<Binding>('config/binding.json'))?.value;
    if (input.scope !== 'private' && input.text.startsWith('/bind ')) {
      if (!secretEquals(input.text.slice(6).trim(), this.options.pairingCode)) return { accepted: false };
      if (!binding) {
        await this.store.write<Binding>('config/binding.json', { group: input.group, owner: input.user, pairedAt: this.now() }, null);
        binding = (await this.store.read<Binding>('config/binding.json'))?.value;
      }
      if (binding?.group !== input.group || binding.owner !== input.user) return { accepted: false };
      input = { ...input, text: '/help' }; // Do not persist the pairing credential in chat history.
    }
    if (!binding || (input.scope !== 'private' && binding.group !== input.group)) return { accepted: false };
    await this.accounts.inspect(input, binding);
    const key = sessionKey(input);
    return mutate<Session, { accepted: boolean; key?: string; busy?: boolean }>(this.store, key, initialSession, state => {
      if (state.completed.includes(input.id) || state.jobs.some(j => j.input.id === input.id)) return { value: state, result: { accepted: true, key }, unchanged: true };
      if (state.jobs.length >= 5) return { value: state, result: { accepted: false, busy: true }, unchanged: true };
      state.jobs.push({ input, stage: 'pending' });
      state.updatedAt = this.now();
      return { value: state, result: { accepted: true, key } };
    });
  }

  private async underLease(key: string, token: string, fn: (state: Session) => void): Promise<Session> {
    return mutate(this.store, key, initialSession, state => {
      if (state.lease?.token !== token || state.lease.until <= this.now()) throw new Error('Lease lost');
      fn(state); state.updatedAt = this.now();
      return { value: state, result: state };
    });
  }
  /** At most one job per run; daemon recovery picks up queued work after a restart. */
  async run(key: string): Promise<void> {
    const token = randomUUID();
    const acquired = await mutate(this.store, key, initialSession, state => {
      if (!state.jobs.length || (state.lease && state.lease.until > this.now())) return { value: state, result: false, unchanged: true };
      state.lease = { token, until: this.now() + LEASE_MS };
      return { value: state, result: true };
    });
    if (!acquired) return;
    try {
      let state = await this.underLease(key, token, () => {});
      const job = state.jobs[0]!;
      if (job.stage === 'sending') {
        await this.finish(key, token, 'QQ 投递结果不确定，未自动重复发送'); return;
      }
      if (this.now() - job.input.timestamp > 270_000) {
        await this.finish(key, token, '超过 QQ 被动回复时限，请重新发送'); return;
      }
      if (job.stage === 'generating') {
        state = await this.underLease(key, token, s => {
          s.jobs[0]!.reply = '上一条请求中断，生成结果不确定，未自动重复扣费。请重新发送；模型没有切换。';
          s.jobs[0]!.stage = 'prepared';
          s.jobs[0]!.result = '生成中断，未自动重试';
        });
      } else if (job.stage === 'pending') {
        const binding = (await this.store.read<Binding>('config/binding.json'))?.value;
        if (!binding) throw new Error('Missing group binding');
        const accountReply = await this.accounts.command(job.input, binding);
        const image = imageCommand(job.input.text);
        const parsed = accountReply !== null ? { reply: accountReply, next: state.settings }
          : image ? image.reply ? { reply: image.reply, next: state.settings } : null
          : command(job.input.text, state.settings, state.lastResult, job.input.scope === 'private');
        let reply: string;
        let next: Settings | undefined;
        let media: Job['media'];
        let result = '命令已处理';
        if (parsed) { reply = parsed.reply; next = parsed.next; }
        else if (!this.options.enabled) { reply = '机器人正在完成部署验收，暂未启用模型调用。/help 和 /ping 可用。'; }
        else if (!(await this.accounts.reserve(job.input, binding))) {
          const usage = await this.accounts.inspect(job.input, binding);
          reply = usage.member ? `今日个人额度已用完（${usage.used}/${usage.limit}）。北京时间 00:00 重置；群聊和私聊共享额度。\n/usage 查看详情，或请群主调整额度。`
            : '请先在已绑定群里 @ANON 发 /usage，之后可直接私聊。系统自动按你的 QQ 身份共享每日额度，无需绑定码。';
          result = usage.member ? '个人额度不足，未调用模型' : '私聊未关联，未调用模型';
        }
        else {
          await this.underLease(key, token, s => { s.jobs[0]!.stage = 'generating'; });
          try {
            if (image?.request) {
              const request = image.request;
              const bytes = await (this.options.generateImage ?? generateImage)(request);
              media = await (this.options.uploadImage ?? uploadQQImage)(job.input, bytes);
              reply = `图片模型：openai:${request.model}\n质量：${request.quality}；尺寸：${request.size}；complexity：${request.complexity}`;
              result = `生图 openai:${request.model}；quality ${request.quality}；${request.size}`;
            } else {
            const prompt = personaPrompt(state.settings.persona);
            const compacted = await compactIfNeeded(state.settings, prompt, job.input.text, this.options.summarize);
            // Commit the successful summary before chatting. A crash never replays a possibly paid compaction.
            if (compacted.compacted) state = await this.underLease(key, token, s => { s.settings = compacted.settings; });
            const turns = [...memoryTurns(state.settings), { role: 'user' as const, content: job.input.text }];
            const generated = await (this.options.generate ?? generate)(state.settings.model, prompt, turns);
            reply = generated.text;
            next = structuredClone(state.settings);
            next.history[next.persona] = [...(next.history[next.persona] ?? []), { role: 'user' as const, content: job.input.text }, { role: 'assistant' as const, content: reply }];
            result = `${state.settings.model.key} ${state.settings.model.effort}；API返回 ${generated.actualModel}；tokens ${generated.inputTokens}/${generated.outputTokens}`;
            }
          } catch (error) {
            result = error instanceof ProviderFailure || error instanceof QQFailure ? error.message : '模型请求或图片上传失败';
            reply = image?.request ? `openai:${image.request.model} 生图或传图失败（${result}）。未自动重试，未切换模型。本次计 1 次额度；网络超时不代表模型没有产生费用。`
              : `${state.settings.model.key} ${state.settings.model.effort} 调用失败（${result}）。没有自动切换模型。可使用 /model --ls 查看其他选择。`;
          }
        }
        state = await this.underLease(key, token, s => {
          Object.assign(s.jobs[0]!, { reply, next, media, result, stage: 'prepared' });
        });
      }
      const prepared = state.jobs[0]!;
      if (prepared.stage !== 'prepared' || !prepared.reply) throw new Error('Invalid outbox state');
      if (prepared.media && prepared.media.expiresAt <= this.now()) {
        await this.finish(key, token, 'QQ 图片引用已过期，未自动重新生图或发送'); return;
      }
      await this.underLease(key, token, s => { s.jobs[0]!.stage = 'sending'; });
      // Persist before posting: after an ambiguous network failure we never resend automatically.
      try {
        if (prepared.media) await (this.options.deliverImage ?? replyQQImage)(prepared.input, prepared.reply, prepared.media.fileInfo);
        else await this.options.deliver(prepared.input, prepared.reply);
      } catch (error) {
        const safe = error instanceof QQFailure ? error.message : 'QQ 投递失败或结果不确定';
        console.error(JSON.stringify({ event: 'delivery_failed', status: safe }));
        await this.finish(key, token, safe); return;
      }
      await this.finish(key, token, prepared.result ?? '已回复', prepared.next);
    } finally {
      await mutate(this.store, key, initialSession, state => {
        if (state.lease?.token === token) delete state.lease;
        return { value: state, result: undefined };
      });
    }
  }
  private async finish(key: string, token: string, result: string, next?: Settings) {
    await this.underLease(key, token, state => {
      const job = state.jobs.shift();
      if (job) state.completed = [...state.completed, job.input.id].slice(-100);
      if (next) state.settings = next;
      state.lastResult = result;
    });
  }
  async recover(): Promise<number> {
    const keys = await this.store.keys('sessions/');
    let processed = 0;
    for (const key of keys) {
      const session = (await this.store.read<Session>(key))?.value;
      if (session?.jobs.length && (!session.lease || session.lease.until <= this.now())) {
        await this.run(key); processed++;
        if (processed >= 2) break;
      }
    }
    return processed;
  }
}
