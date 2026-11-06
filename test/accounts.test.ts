import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { AccountsService } from '../src/accounts.ts';
import { MemoryStore } from '../src/store.ts';
import { parseEvent, replyContent } from '../src/qq.ts';
import { command, initialSettings } from '../src/commands.ts';
import type { Incoming } from '../src/types.ts';
import { deliverThroughChat } from '../src/chat.ts';
import { sessionKey } from '../src/engine.ts';
const now = Date.UTC(2026,10,6,10);
const binding = { group: 'g', owner: 'owner', pairedAt: now };
const input = (user: string, extra: Partial<Incoming> = {}): Incoming => ({ platform: 'qq', scope: 'group', group: 'g', user,
  id: 'm', text: 'hello', timestamp: now, role: 'member', ...extra });

test('member/admin/owner quotas are atomic, daily and individually isolated', async () => {
  let clock = now; const service = new AccountsService(new MemoryStore(), () => clock);
  const results = await Promise.all(Array.from({ length: 14 }, (_, n) => service.reserve(input('member', { id: String(n) }), binding)));
  assert.equal(results.filter(Boolean).length, 10);
  assert.equal((await service.inspect(input('other'), binding)).used, 0);
  assert.equal((await service.inspect(input('admin', { role: 'admin' }), binding)).limit, 100);
  assert.equal((await service.inspect(input('owner'), binding)).limit, null);
  clock += 86400_000;
  assert.equal((await service.inspect(input('member'), binding)).used, 0);
});
test('only bound owner can grant quotas; override does not reset usage', async () => {
  const service = new AccountsService(new MemoryStore(), () => now);
  await service.reserve(input('target'), binding);
  const grant = { text: '/usage-limit 100 <@target>', mentions: [{ id: 'target' }] };
  assert.match((await service.command(input('attacker', grant), binding))!, /只有/);
  assert.equal((await service.inspect(input('target'), binding)).limit, 10);
  await service.command(input('owner', grant), binding);
  assert.equal((await service.inspect(input('target'), binding)).limit, 100);
  assert.equal((await service.inspect(input('target'), binding)).used, 1);
  await service.command(input('owner', { ...grant, text: '/usage-limit --reset <@target>' }), binding);
  assert.equal((await service.inspect(input('target'), binding)).limit, 10);
});
test('authenticated union identity shares quota between private and group events', async () => {
  const service = new AccountsService(new MemoryStore(), () => now);
  const group = input('group_id', { union: 'unified_id' });
  const dm = input('private_id', { scope: 'private', group: 'private', union: 'unified_id', role: undefined });
  await service.reserve(group, binding);
  assert.equal((await service.inspect(dm, binding)).used, 1);
  await service.reserve({ ...dm, id: 'dm2' }, binding);
  assert.equal((await service.inspect(group, binding)).used, 2);
  assert.equal(await service.reserve({ ...dm, id: 'dm2' }, binding), true);
  assert.equal((await service.inspect(group, binding)).used, 2);
});
test('the same QQ OpenID automatically shares private/group quota and owner status', async () => {
  const service = new AccountsService(new MemoryStore(), () => now);
  const dm = input('member', { scope: 'private', group: 'private', role: undefined });
  assert.equal(await service.reserve(dm, binding), false);
  await service.reserve(input('member'), binding);
  assert.equal((await service.inspect(dm, binding)).used, 1);
  assert.equal(await service.reserve({ ...dm, id: 'private2' }, binding), true);
  assert.equal((await service.inspect(input('member'), binding)).used, 2);
  const owner = await service.inspect({ ...dm, user: 'owner' }, binding);
  assert.equal(owner.role, '群主'); assert.equal(owner.limit, null); assert.equal(owner.member, true);
  assert.equal(await service.command({ ...dm, text: '/link' }, binding), null);
});
test('legacy scene accounts merge once without losing usage, grants or ownership', async () => {
  const store = new MemoryStore(); const service = new AccountsService(store, () => now);
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const groupKey = hash('group:g:member'); const dmKey = hash('c2c:member');
  const profile = { member: true, owner: false, role: 'member', roleAt: now, day: '2026-11-06', reservations: {} };
  await store.write('config/accounts.json', {
    identities: { [groupKey]: groupKey, [dmKey]: dmKey },
    profiles: { [groupKey]: { ...profile, used: 3, limit: 100 }, [dmKey]: { ...profile, member: false, used: 2 } },
    links: { obsolete: { expires: now + 1000 } },
  }, null);
  const dm = input('member', { scope: 'private', group: 'private', role: undefined });
  assert.equal((await service.inspect(dm, binding)).used, 5);
  assert.equal((await service.inspect(dm, binding)).limit, 100);
  assert.equal((await service.inspect(input('member'), binding)).used, 5);
  const saved = (await store.read<{ profiles: object; links?: unknown }>('config/accounts.json'))!.value;
  assert.equal(Object.keys(saved.profiles).length, 1); assert.equal(saved.links, undefined);
});
test('QQ parses authenticated roles and mention targets, never role claims in text', () => {
  const event = parseEvent({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'msg', group_openid: 'g', timestamp: new Date(now).toISOString(),
    author: { member_openid: 'owner', member_role: 'owner', union_openid: 'unified' }, content: '/usage-limit 100 <@target>', mentions: [{ member_openid: 'target', username: '朋友' }] } })!;
  assert.equal(event.role, 'owner'); assert.equal(event.union, 'unified'); assert.equal(event.mentions![0]!.id, 'target');
  const dm = parseEvent({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'msg', timestamp: new Date(now).toISOString(), author: { user_openid: 'uid' }, content: '/help' } })!;
  assert.equal(dm.scope, 'private');
  assert.equal(replyContent(event, '标题\n正文'), '\n标题\n正文');
  assert.equal(replyContent(dm, '标题'), '标题');
  assert.equal(replyContent(input('x'), 'hi'), 'hi');
  assert.match(command('/help', initialSettings())!.reply, /【模型与推理强度】[\s\S]*【人格】/);
});

test('private replies dispatch through Chat SDK with a separate session lock', async () => {
  const group = input('same-user');
  const dm = input('same-user', { scope: 'private', group: 'private', text: '/usage' });
  assert.notEqual(sessionKey(dm), sessionKey(group));
  let sends = 0;
  await deliverThroughChat(dm, 'usage result', async (actual, text) => {
    sends++; assert.equal(actual.scope, 'private'); assert.equal(actual.user, 'same-user');
    assert.equal(text, 'usage result'); return 'private-reply';
  });
  assert.equal(sends, 1);
});

test('private ingress accepts opaque Tencent message IDs and standard author ID fallback', () => {
  const payload = { op: 0, t: 'C2C_MESSAGE_CREATE', d: {
    id: 'c2c:message|' + 'x'.repeat(300), author: { id: 'opaque:user', user_openid: '' },
    content: '/usage', timestamp: new Date(now).toISOString(),
  } };
  assert.equal(parseEvent(payload)?.user, 'opaque:user');
  assert.equal(parseEvent(payload)?.text, '/usage');
  assert.equal(parseEvent({ ...payload, d: { ...payload.d, id: 'bad\nmessage' } }), null);
});

test('unchanged account inspection and denied reservations avoid extra CAS writes', async () => {
  class CountingStore extends MemoryStore {
    writes = 0;
    override async write<T>(key: string, value: T, etag: string | null) { this.writes++; return super.write(key, value, etag); }
  }
  const store = new CountingStore(); const now = Date.now();
  const service = new AccountsService(store, () => now);
  const binding = { group: 'g', owner: 'owner', pairedAt: now };
  const privateUser: Incoming = { platform: 'qq', scope: 'private', group: 'private', user: 'unknown', text: '/usage', id: 'u', timestamp: now };
  await service.inspect(privateUser, binding); const initialWrites = store.writes;
  await service.inspect(privateUser, binding); assert.equal(await service.reserve(privateUser, binding), false);
  assert.equal(store.writes, initialWrites);
});
