import { createHash } from 'node:crypto';
import { mutate, type Store } from './store.ts';
import type { Binding, Incoming } from './types.ts';

const KEY = 'config/accounts.json';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const dayAt = (now: number) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
interface Profile {
  member: boolean;
  owner: boolean;
  role: 'member' | 'admin';
  roleAt: number;
  limit?: number;
  day: string;
  used: number;
  reservations: Record<string, number>;
}
interface Accounts {
  identities: Record<string, string>;
  profiles: Record<string, Profile>;
  links?: Record<string, unknown>; // Retired linking tokens are discarded during migration.
}
export interface Usage { account: string; role: string; limit: number | null; used: number; member: boolean }
const empty = (): Accounts => ({ identities: {}, profiles: {} });
function fresh(now: number): Profile {
  return { member: false, owner: false, role: 'member', roleAt: 0, day: dayAt(now), used: 0, reservations: {} };
}
/** Quotas follow the Beijing calendar, independently of the runtime timezone. */
function resetDay(p: Profile, now: number) {
  if (p.day !== dayAt(now)) { p.day = dayAt(now); p.used = 0; p.reservations = {}; }
}
/** Apply expiring administrator status without downgrading the bound owner. */
function usage(id: string, p: Profile, now: number): Usage {
  resetDay(p, now);
  const role = p.owner ? '群主' : p.role === 'admin' && now - p.roleAt < 86400_000 ? '管理员' : '普通成员';
  return { account: id.slice(0, 12), role, limit: p.owner ? null : p.limit ?? (role === '管理员' ? 100 : 10), used: p.used, member: p.member };
}
/** Merge identity aliases inside one CAS transaction, retaining usage and grants. */
function merge(a: Accounts, from: string, into: string, now: number) {
  if (from === into) return;
  const src = a.profiles[from]!; const dst = a.profiles[into]!;
  resetDay(src, now); resetDay(dst, now);
  dst.used += src.used;
  dst.reservations = { ...src.reservations, ...dst.reservations };
  dst.member ||= src.member; dst.owner ||= src.owner;
  if (src.roleAt > dst.roleAt) { dst.role = src.role; dst.roleAt = src.roleAt; }
  // Preserve the group-side quota override when joining a private identity.
  dst.limit ??= src.limit;
  for (const [key, value] of Object.entries(a.identities)) if (value === from) a.identities[key] = into;
  delete a.profiles[from];
}
/** Trust platform IDs only; migrate legacy namespaces without user-supplied binding codes. */
function resolve(a: Accounts, input: Incoming, binding: Binding, now: number): string {
  // One application's authenticated QQ user OpenID is the personal identity.
  // Migrate both old scene namespaces atomically, preserving used quota and owner grants.
  const key = hash(`qq-user:${input.user}`);
  const oldGroup = hash(`group:${binding.group}:${input.user}`);
  const oldPrivate = hash(`c2c:${input.user}`);
  let id = a.identities[oldGroup] ?? a.identities[key] ?? a.identities[oldPrivate] ?? key;
  a.profiles[id] ??= fresh(now);
  for (const alias of [oldGroup, oldPrivate, key]) {
    const existing = a.identities[alias];
    if (existing && existing !== id) merge(a, existing, id, now);
    a.identities[alias] = id;
  }
  delete a.links;
  // Only Tencent-authenticated union identifiers can automatically join identities.
  if (input.union) {
    const unionKey = hash(`union:${input.union}`);
    const existing = a.identities[unionKey];
    if (existing && existing !== id) { merge(a, id, existing, now); id = existing; }
    a.identities[unionKey] = id;
  }
  const p = a.profiles[id]!;
  if (input.scope !== 'private' && input.group === binding.group) {
    p.member = true;
    if (input.user === binding.owner) p.owner = true;
    if (input.role && input.timestamp >= p.roleAt) { p.role = input.role === 'admin' ? 'admin' : 'member'; p.roleAt = input.timestamp; }
  }
  // The original group binding already authenticates the owner's OpenID.
  if (input.user === binding.owner) { p.member = true; p.owner = true; }
  resetDay(p, now);
  return id;
}

/** One CAS document makes identity migration, owner-only grants and shared quota reservations atomic. */
export class AccountsService {
  constructor(private store: Store, private now: () => number = Date.now) {}
  /** Refresh authenticated membership and return quota; unchanged reads do not write. */
  async inspect(input: Incoming, binding: Binding): Promise<Usage> {
    const now = this.now();
    return mutate(this.store, KEY, empty, a => {
      const before = JSON.stringify(a);
      const id = resolve(a, input, binding, now);
      const result = usage(id, a.profiles[id]!, now);
      return { value: a, result, unchanged: before === JSON.stringify(a) };
    });
  }
  /** Reserve one paid interaction atomically; duplicate event reservations are idempotent. */
  async reserve(input: Incoming, binding: Binding): Promise<boolean> {
    const now = this.now();
    return mutate(this.store, KEY, empty, a => {
      const before = JSON.stringify(a);
      const id = resolve(a, input, binding, now); const p = a.profiles[id]!;
      const u = usage(id, p, now);
      const unchanged = () => before === JSON.stringify(a);
      if (!p.member) return { value: a, result: false, unchanged: unchanged() };
      const request = hash(`${input.scope ?? 'group'}:${input.group}:${input.id}`);
      if (p.reservations[request]) return { value: a, result: true, unchanged: unchanged() };
      if (u.limit !== null && p.used >= u.limit) return { value: a, result: false, unchanged: unchanged() };
      p.used++;
      // Event replay protection lasts longer than the accepted inbound-message window.
      p.reservations = Object.fromEntries(Object.entries(p.reservations).filter(([, at]) => now - at < 600_000));
      p.reservations[request] = now;
      return { value: a, result: true };
    });
  }
  /** Parse owner-only grants outside the model and require a native mention target. */
  async command(input: Incoming, binding: Binding): Promise<string | null> {
    const [name, ...args] = input.text.trim().split(/\s+/);
    if (!['/usage', '/usage-limit'].includes(name!)) return null;
    const now = this.now();
    return mutate(this.store, KEY, empty, a => {
      const id = resolve(a, input, binding, now); const p = a.profiles[id]!;
      const u = usage(id, p, now);
      const done = (result: string) => ({ value: a, result });
      if (name === '/usage') {
        if (args.length) return done('【个人额度】\n/usage：查看身份、今日用量与额度。\n北京时间每天 00:00 重置；群聊与私聊自动共用。\n一次模型请求计一次，帮助与设置命令不计。失败或超时请求也计次，避免重复调用。');
        return done(`【个人额度】\n个人编号：${u.account}\n身份：${u.role}\n今日已用：${u.used}\n每日上限：${u.limit ?? '无限次'}\n剩余：${u.limit === null ? '无限次' : Math.max(0, u.limit - u.used)}\n\n北京时间 00:00 重置。群聊与私聊自动共用。${p.member ? '' : '\n请先在已绑定群里 @ANON 发 /usage，之后私聊会自动共用该身份。'}`);
      }
      if (name === '/usage-limit') {
        const help = '【设置个人额度 · 仅群主】\n/usage-limit 100 @成员：设为每天 100 次，不是追加 100 次。\n/usage-limit --reset @成员：恢复身份默认额度。\n普通成员 10 次，管理员 100 次，群主无限次。\n需在群内使用 QQ 的真实 @；支持 0–10000。修改不清零今日用量，群聊与私聊同时生效。';
        if (!args.length || args[0] === '--help') return done(help);
        if (!p.owner || input.scope === 'private') return done('只有已绑定群的群主可以在群里设置额度。');
        if (input.mentions?.length !== 1) return done('请且仅真实 @ 一位成员。手打昵称或 QQ 号码不能确认身份。\n' + help);
        const target = input.mentions[0]!;
        const tail = args.slice(1).join(' ');
        // QQ clients may retain a native mention tag or its display name in content.
        const clean = tail.replace(/<qqbot-at-user\b[^>]*\/>|<@!?[^>]+>/g, '').trim();
        if (clean && clean !== `@${target.name ?? ''}`) return done('命令有多余参数。\n' + help);
        const limit = args[0] === '--reset' ? undefined : /^\d{1,5}$/.test(args[0]!) ? Number(args[0]) : NaN;
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000)) return done(help);
        const targetInput = { ...input, user: target.id, union: target.union, role: undefined };
        const targetId = resolve(a, targetInput, binding, now); const targetProfile = a.profiles[targetId]!;
        if (targetProfile.owner) return done('群主额度固定为无限次，无需设置。');
        if (limit === undefined) delete targetProfile.limit; else targetProfile.limit = limit;
        const updated = usage(targetId, targetProfile, now);
        return done(`【额度已更新】\n成员编号：${updated.account}\n每日上限：${updated.limit} 次${limit === undefined ? '（身份默认）' : ''}\n今日已用：${updated.used} 次\n群聊与私聊自动共用；今日用量不清零。`);
      }
      return done('使用 /usage 查看额度，或 /usage-limit --help 查看管理说明。');
    });
  }
}
