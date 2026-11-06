import { test } from 'node:test';
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
test('unlinked private identity cannot get an extra allowance; linking needs private confirmation', async () => {
  const service = new AccountsService(new MemoryStore(), () => now);
  const dm = input('private_id', { scope: 'private', group: 'private', role: undefined, text: '/link' });
  assert.equal(await service.reserve(dm, binding), false);
  const text = (await service.command(dm, binding))!;
  const code = text.match(/\/link ([a-f0-9]{32})/)![1];
  await service.reserve(input('member'), binding);
  const proposal = (await service.command(input('member', { text: `/link ${code}` }), binding))!;
  assert.equal(await service.reserve(dm, binding), false);
  const account = proposal.match(/--confirm ([a-f0-9]{12})/)![1];
  await service.command({ ...dm, text: `/link --confirm ${account}` }, binding);
  assert.equal((await service.inspect(dm, binding)).used, 1);
  assert.equal((await service.inspect(dm, binding)).member, true);
  assert.match((await service.command(input('attacker', { text: `/link ${code}` }), binding))!, /过期/);
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
