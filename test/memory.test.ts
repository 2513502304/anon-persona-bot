import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactIfNeeded, contextEstimate, memoryTurns, COMPACT_THRESHOLD } from '../src/memory.ts';
import { initialSettings, command } from '../src/commands.ts';
import { Engine, sessionKey } from '../src/engine.ts';
import { MemoryStore } from '../src/store.ts';
import { AccountsService } from '../src/accounts.ts';
import { imageCommand } from '../src/images.ts';
import type { Turn, Session, Incoming } from '../src/types.ts';

const pair = (text: string): Turn[] => [{ role: 'user', content: text }, { role: 'assistant', content: text }];
function fullSettings() {
  const settings = initialSettings();
  // Many small recent messages must survive; no fixed 20-turn cutoff is allowed.
  settings.history.anon = [...Array.from({ length: 260 }, () => pair('a '.repeat(500))).flat(),
    ...Array.from({ length: 100 }, (_, i) => pair(`recent-${i}`)).flat()];
  settings.history.furina = pair('other persona');
  return settings;
}

test('under-budget histories retain every turn, including beyond twenty exchanges', async () => {
  const settings = initialSettings(); settings.history.anon = Array.from({ length: 100 }, () => pair('hello')).flat();
  const result = await compactIfNeeded(settings, 'persona', 'next', async () => { throw Error('must not compact'); });
  assert.equal(result.compacted, false); assert.equal(result.settings.history.anon!.length, 200);
});
test('compaction selects recent dialogue by tokens and keeps personas isolated', async () => {
  const settings = fullSettings(); const original = structuredClone(settings); let calls = 0;
  assert.ok(contextEstimate('', memoryTurns(settings)) > COMPACT_THRESHOLD);
  const result = await compactIfNeeded(settings, 'persona', 'next', async (selection, turns) => {
    calls++; assert.deepEqual(selection, settings.model); assert.ok(turns.length > 0); return '用户喜欢蓝色围巾。';
  });
  assert.equal(calls, 1); assert.ok(result.settings.history.anon!.length > 40);
  assert.deepEqual(result.settings.history.anon!.slice(-200), settings.history.anon!.slice(-200));
  assert.deepEqual(result.settings.history.furina, settings.history.furina);
  assert.deepEqual(settings, original); assert.ok(contextEstimate('persona', memoryTurns(result.settings)) < COMPACT_THRESHOLD);
  assert.equal(result.settings.memories!.anon!.compactions, 1);
  const reset = command('/reset --confirm', result.settings)!.next;
  assert.equal(reset.memories!.anon, undefined); assert.deepEqual(reset.history.anon, []); assert.deepEqual(reset.history.furina, settings.history.furina);
});
test('failed or oversized summaries preserve all original history', async () => {
  const settings = fullSettings(); const before = structuredClone(settings);
  await assert.rejects(compactIfNeeded(settings, '', 'next', async () => { throw Error('timeout'); }), /timeout/);
  await assert.rejects(compactIfNeeded(settings, '', 'next', async () => '中'.repeat(6000)), /Invalid/);
  assert.deepEqual(settings, before);
});
test('a compacted chat reserves only once and remembers the durable summary', async () => {
  const store = new MemoryStore(); const now = Date.now(); const binding = { group: 'g', owner: 'owner', pairedAt: now };
  await store.write('config/binding.json', binding, null);
  const input: Incoming = { id: 'chat', platform: 'qq', group: 'g', user: 'member', text: 'next', timestamp: now };
  const key = sessionKey(input); await store.write<Session>(key, { settings: fullSettings(), jobs: [], completed: [], updatedAt: now }, null);
  let compactCalls = 0; let chatCalls = 0;
  const engine = new Engine(store, { pairingCode: '', enabled: true, deliver: async () => 'ok',
    summarize: async () => { compactCalls++; return '旧话题摘要'; },
    generate: async (_s, _p, turns) => { chatCalls++; assert.match(turns[0]!.content, /旧话题摘要/); return { text: 'hello', actualModel: 'gpt-6.1-sol', inputTokens: 1, outputTokens: 1 }; },
  });
  await engine.accept(input); await engine.run(key); await engine.accept(input); await engine.run(key);
  assert.equal(compactCalls, 1); assert.equal(chatCalls, 1);
  assert.equal((await new AccountsService(store).inspect(input, binding)).used, 1);
  assert.equal((await store.read<Session>(key))!.value.settings.memories!.anon!.summary, '旧话题摘要');
});
test('image listing is free and examples stay on the command line', () => {
  const listing = imageCommand('/image --ls')!; assert.equal(listing.request, undefined);
  assert.match(listing.reply!, /openai:gpt-image-2.6-flare/); assert.match(listing.reply!, /openai:gpt-image-2.6-sunburst/);
  assert.doesNotMatch(command('/help', initialSettings())!.reply, /\n例：/);
  assert.doesNotMatch(imageCommand('/image --help')!.reply!, /\n例：/);
});

test('failed compaction preserves history and spends no personal quota or chat request', async () => {
  const store = new MemoryStore(); const now = Date.now(); const binding = { group: 'g', owner: 'owner', pairedAt: now };
  await store.write('config/binding.json', binding, null);
  const input: Incoming = { id: 'failed-compact', platform: 'qq', group: 'g', user: 'member', text: 'next', timestamp: now };
  const settings = fullSettings(); const key = sessionKey(input);
  await store.write<Session>(key, { settings, jobs: [], completed: [], updatedAt: now }, null);
  let chatCalls = 0; let compactCalls = 0; let reply = '';
  const engine = new Engine(store, { pairingCode: '', enabled: true,
    deliver: async (_i, text) => { reply = text; return 'ok'; },
    summarize: async () => { compactCalls++; throw new Error('timeout'); },
    generate: async () => { chatCalls++; throw new Error('must not chat'); },
  });
  await engine.accept(input); await engine.run(key); await engine.accept(input); await engine.run(key);
  assert.equal(compactCalls, 1); assert.equal(chatCalls, 0);
  assert.equal((await new AccountsService(store).inspect(input, binding)).used, 0);
  assert.deepEqual((await store.read<Session>(key))!.value.settings, settings);
  assert.match(reply, /压缩失败/); assert.match(reply, /不扣个人次数/); assert.match(reply, /\/reset --confirm/);
});

test('compaction checks eligibility first and rechecks quota atomically before chatting', async () => {
  const store = new MemoryStore(); const now = Date.now(); const binding = { group: 'g', owner: 'owner', pairedAt: now };
  await store.write('config/binding.json', binding, null);
  const input: Incoming = { id: 'quota-race', platform: 'qq', group: 'g', user: 'member', text: 'next', timestamp: now };
  const accounts = new AccountsService(store);
  for (let i = 0; i < 9; i++) await accounts.reserve({ ...input, id: `earlier-${i}` }, binding);
  const key = sessionKey(input);
  await store.write<Session>(key, { settings: fullSettings(), jobs: [], completed: [], updatedAt: now }, null);
  let chatCalls = 0; let compactCalls = 0; let reply = '';
  const engine = new Engine(store, { pairingCode: '', enabled: true,
    deliver: async (_i, text) => { reply = text; return 'ok'; },
    summarize: async () => { compactCalls++; await accounts.reserve({ ...input, id: 'other-chat' }, binding); return 'summary'; },
    generate: async () => { chatCalls++; throw new Error('must not chat'); },
  });
  await engine.accept(input); await engine.run(key);
  assert.equal(compactCalls, 1); assert.equal(chatCalls, 0); assert.match(reply, /其他会话/);
  assert.equal((await accounts.inspect(input, binding)).used, 10);
  await engine.accept({ ...input, id: 'already-full' }); await engine.run(key);
  assert.equal(compactCalls, 1); assert.equal(chatCalls, 0); assert.match(reply, /额度已用完/);
});
