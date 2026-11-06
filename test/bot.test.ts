import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519Sign } from '@tencent-connect/qqbot-nodejs/protocol';
import { MemoryStore } from '../src/store.ts';
import { Engine, sessionKey } from '../src/engine.ts';
import { command, initialSettings } from '../src/commands.ts';
import { verify, challenge, parseEvent, QQFailure } from '../src/qq.ts';
import { generate } from '../src/models.ts';
import { deliverThroughChat } from '../src/chat.ts';
import type { Incoming, Session } from '../src/types.ts';

const secret = 'test-secret-not-a-real-credential';
test('callback signature matches the published QQ reference vector', () => {
  // Public example key/token, from QQ event-emit.html; not account credentials.
  assert.deepEqual(challenge({ plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' }, 'DG5g3B4j9X2KOErG'), {
    plain_token: 'Arq0D5A61EgUu4OxUvOp',
    signature: '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706',
  });
});
const incoming = (id: string, text = '你好'): Incoming => ({ id, text, platform: 'qq', group: 'group_a', user: 'user_a', timestamp: Date.now() });
async function fixture(deliver?: (input: Incoming, text: string) => Promise<string>) {
  const store = new MemoryStore();
  const sent: string[] = [];
  let calls = 0;
  const engine = new Engine(store, { pairingCode: 'pairing-code', enabled: true,
    generate: async () => { calls++; return { text: '今天也一起加油吧！', actualModel: 'gpt-6.1-sol', inputTokens: 10, outputTokens: 12 }; },
    deliver: deliver ?? (async (_input, text) => { sent.push(text); return 'sent'; }) });
  await store.write('config/binding.json', { group: 'group_a', owner: 'user_a', pairedAt: Date.now() }, null);
  return { store, sent, engine, calls: () => calls };
}

test('signed ingress rejects absent, altered and expired signatures', () => {
  const body = Buffer.from('{"op":0}');
  const timestamp = String(Math.floor(Date.now()/1000));
  const headers = new Headers({ 'x-signature-timestamp': timestamp,
    'x-signature-ed25519': ed25519Sign(secret, Buffer.concat([Buffer.from(timestamp), body])) });
  assert.equal(verify(body, headers, secret), true);
  assert.equal(verify(Buffer.from('{}'), headers, secret), false);
  assert.equal(verify(body, new Headers(), secret), false);
  assert.equal(verify(body, headers, secret, Date.now() + 11*60_000), false);
  assert.ok(challenge({ plain_token: 'abc', event_ts: timestamp }, secret));
  assert.equal(challenge({ plain_token: 'abc', event_ts: 'bad' }, secret), null);
});
test('QQ parsing retains request-local IDs and strips only leading mention', () => {
  const value = parseEvent({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'ROBOT1.0_message==', group_openid: 'g1', author: { member_openid: 'u1' }, timestamp: new Date().toISOString(), content: '<@123> /model deepseek high' } });
  assert.equal(value?.text, '/model deepseek high');
  assert.equal(value?.group, 'g1');
  assert.equal(parseEvent({ op: 0, t: 'GROUP_MESSAGE_CREATE' }), null);
});
test('commands validate exact effort without mutating on invalid arguments', () => {
  const initial = initialSettings();
  assert.equal(command('/model deepseek:deepseek-v4.1-flash low', initial)!.next.model.key, 'deepseek:deepseek-flash');
  assert.deepEqual(command('/model deepseek medium', initial)!.next.model, initial.model);
  assert.deepEqual(command('/model openai:gpt-6.1-sol high extra', initial)!.next, initial);
  const next = command('/persona 芙宁娜', initial)!.next;
  assert.equal(next.persona, 'furina');
  assert.deepEqual(next.model, initial.model);
  assert.ok(command('/model --ls', initial)!.reply.includes('none, low, high, max'));
});
test('one-time binding cannot be stolen by another group and does not store the code', async () => {
  const store = new MemoryStore();
  const engine = new Engine(store, { pairingCode: 'correct', enabled: false, deliver: async () => 'ok' });
  assert.equal((await engine.accept(incoming('1'))).accepted, false);
  assert.equal((await engine.accept(incoming('2','/bind wrong'))).accepted, false);
  const bound = await engine.accept(incoming('3','/bind correct'));
  assert.equal(bound.accepted, true);
  assert.equal((await engine.accept({ ...incoming('4','/bind correct'), group: 'other' })).accepted, false);
  assert.equal((await store.read<Session>(bound.key!))!.value.jobs[0]!.input.text, '/help');
});
test('concurrent duplicate webhooks and workers generate/send exactly once', async () => {
  const f = await fixture();
  const input = incoming('same');
  await Promise.all(Array.from({ length: 8 }, () => f.engine.accept(input)));
  await Promise.all(Array.from({ length: 8 }, () => f.engine.run(sessionKey(input))));
  assert.equal(f.calls(), 1); assert.equal(f.sent.length, 1);
  await f.engine.accept(input); await f.engine.run(sessionKey(input));
  assert.equal(f.calls(), 1);
  const saved = (await f.store.read<Session>(sessionKey(input)))!.value;
  assert.equal(saved.settings.history.anon!.length, 2);
});
test('cold starts preserve settings and isolate users/personas', async () => {
  const f = await fixture();
  const input = incoming('model','/model deepseek high');
  await f.engine.accept(input); await f.engine.run(sessionKey(input));
  const restarted = new Engine(f.store, { pairingCode: 'pairing-code', enabled: true, deliver: async () => 'ok' });
  await restarted.accept({ ...input, id: 'persona', text: '/persona 喜多郁代' });
  await restarted.run(sessionKey(input));
  const saved = (await f.store.read<Session>(sessionKey(input)))!.value;
  assert.equal(saved.settings.model.key, 'deepseek:deepseek-flash'); assert.equal(saved.settings.persona, 'kita');
  assert.notEqual(sessionKey(input), sessionKey({ ...input, user: 'user_b' }));
});
test('ambiguous delivery is never resent and failed reply is not added to history', async () => {
  let sends = 0;
  const f = await fixture(async () => { sends++; throw new QQFailure(0, 'delivery_unknown'); });
  const input = incoming('ambiguous');
  await f.engine.accept(input); await f.engine.run(sessionKey(input));
  await f.engine.accept(input); await f.engine.recover();
  assert.equal(f.calls(), 1); assert.equal(sends, 1);
  assert.deepEqual((await f.store.read<Session>(sessionKey(input)))!.value.settings.history, {});
});
test('recovery does not repeat a generation which may already have been charged', async () => {
  const f = await fixture(); const input = incoming('interrupted');
  await f.engine.accept(input);
  const snapshot = (await f.store.read<Session>(sessionKey(input)))!;
  snapshot.value.jobs[0]!.stage = 'generating';
  await f.store.write(sessionKey(input), snapshot.value, snapshot.etag);
  await f.engine.recover(); assert.equal(f.calls(), 0); assert.ok(f.sent[0]!.includes('未自动重复扣费'));
});
test('Chat SDK posts with original reply reference through the QQ adapter', async () => {
  const input = incoming('reference'); let called = false;
  await deliverThroughChat(input, 'hi', async (actual, text) => {
    assert.equal(actual.id, 'reference'); assert.equal(actual.group, 'group_a'); assert.equal(text, 'hi'); called = true; return 'out';
  }); assert.equal(called, true);
});
test('provider failure has no fallback request and never exposes secret/body', async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-key';
  let calls = 0;
  try {
    await assert.rejects(generate({ key: 'openai:gpt-6.1-sol', effort: 'high' }, 'system', [{ role: 'user', content: 'hi' }], async (_url, init) => {
      calls++; const body = JSON.parse(init!.body as string); assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.reasoning.effort, 'high'); assert.equal(body.store, false);
      return Response.json({ error: { code: 'insufficient_quota', message: 'test-key' } }, { status: 429 });
    }), /openai HTTP 429 insufficient_quota/);
    assert.equal(calls, 1);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});
