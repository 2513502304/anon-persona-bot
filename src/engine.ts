import { createHash, randomUUID } from 'node:crypto';
import { mutate, type Store } from './store.ts';
import { initialSettings, command } from './commands.ts';
import { generate, ProviderFailure } from './models.ts';
import { personaPrompt } from './personas.ts';
import { secretEquals, QQFailure } from './qq.ts';
import type { Binding, Incoming, Job, Session, Settings } from './types.ts';

const LEASE_MS = 240_000;
export function sessionKey(input: Incoming): string {
  return `sessions/${createHash('sha256').update(`${input.platform}:${input.group}:${input.user}`).digest('hex')}.json`;
}
function initialSession(): Session { return { settings: initialSettings(), jobs: [], completed: [], updatedAt: Date.now() }; }
export interface EngineOptions {
  pairingCode: string;
  enabled: boolean;
  generate?: typeof generate;
  deliver: (input: Incoming, text: string) => Promise<string>;
  now?: () => number;
  dailyLimit?: number;
}

/** Durable inbox owns correctness; SDK-local routing state is never used as persistence. */
export class Engine {
  private now: () => number;
  constructor(public readonly store: Store, private readonly options: EngineOptions) { this.now = options.now ?? Date.now; }

  async accept(input: Incoming): Promise<{ accepted: boolean; key?: string; busy?: boolean }> {
    if (Math.abs(this.now() - input.timestamp) > 240_000) return { accepted: false };
    let binding = (await this.store.read<Binding>('config/binding.json'))?.value;
    if (input.text.startsWith('/bind ')) {
      if (!secretEquals(input.text.slice(6).trim(), this.options.pairingCode)) return { accepted: false };
      if (!binding) {
        await this.store.write<Binding>('config/binding.json', { group: input.group, owner: input.user, pairedAt: this.now() }, null);
        binding = (await this.store.read<Binding>('config/binding.json'))?.value;
      }
      if (binding?.group !== input.group || binding.owner !== input.user) return { accepted: false };
      input = { ...input, text: '/help' }; // Do not persist the pairing credential in chat history.
    }
    if (!binding || binding.group !== input.group) return { accepted: false };
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
  private async reserveDailyCall(): Promise<boolean> {
    // UTC+8 calendar boundary; a reserved call counts even if a provider times out.
    const day = new Date(this.now() + 8 * 3600_000).toISOString().slice(0,10);
    return mutate(this.store, `quota/${day}.json`, () => ({ calls: 0 }), quota => {
      if (quota.calls >= (this.options.dailyLimit ?? 100)) return { value: quota, result: false, unchanged: true };
      quota.calls++; return { value: quota, result: true };
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
        const parsed = command(job.input.text, state.settings, state.lastResult);
        let reply: string;
        let next: Settings | undefined;
        let result = '命令已处理';
        if (parsed) { reply = parsed.reply; next = parsed.next; }
        else if (!this.options.enabled) { reply = '机器人正在完成部署验收，暂未启用模型调用。/help 和 /ping 可用。'; }
        else if (!(await this.reserveDailyCall())) { reply = '今天的模型调用上限已到，暂不继续调用。没有切换到其他模型。'; }
        else {
          await this.underLease(key, token, s => { s.jobs[0]!.stage = 'generating'; });
          try {
            const turns = [...(state.settings.history[state.settings.persona] ?? []), { role: 'user' as const, content: job.input.text }];
            const generated = await (this.options.generate ?? generate)(state.settings.model, personaPrompt(state.settings.persona), turns);
            reply = generated.text;
            next = structuredClone(state.settings);
            next.history[next.persona] = [...turns, { role: 'assistant' as const, content: reply }].slice(-24);
            result = `${state.settings.model.key} ${state.settings.model.effort}；API返回 ${generated.actualModel}；tokens ${generated.inputTokens}/${generated.outputTokens}`;
          } catch (error) {
            result = error instanceof ProviderFailure ? error.message : '模型请求失败';
            reply = `${state.settings.model.key} ${state.settings.model.effort} 调用失败（${result}）。没有自动切换模型。可使用 /model --ls 查看其他选择。`;
          }
        }
        state = await this.underLease(key, token, s => {
          Object.assign(s.jobs[0]!, { reply, next, result, stage: 'prepared' });
        });
      }
      const prepared = state.jobs[0]!;
      if (prepared.stage !== 'prepared' || !prepared.reply) throw new Error('Invalid outbox state');
      await this.underLease(key, token, s => { s.jobs[0]!.stage = 'sending'; });
      // Persist before posting: after an ambiguous network failure we never resend automatically.
      try {
        await this.options.deliver(prepared.input, prepared.reply);
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
