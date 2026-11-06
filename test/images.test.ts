import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageCommand, generateImage } from '../src/images.ts';
import { AccountsService } from '../src/accounts.ts';
import { Engine, sessionKey } from '../src/engine.ts';
import { MemoryStore } from '../src/store.ts';
import type { Incoming, Session } from '../src/types.ts';

test('image options reject invalid or duplicate values before any paid call', () => {
  assert.equal(imageCommand('画一只猫'), null);
  assert.match(imageCommand('/image --model unknown cat')!.reply!, /未调用/);
  assert.match(imageCommand('/image --quality high --quality low cat')!.reply!, /重复/);
  assert.match(imageCommand('/image --size 123 cat')!.reply!, /无效/);
  assert.equal(imageCommand('/image --model openai:gpt-image-2.6-sunburst --quality high 水彩猫')!.request!.model, 'gpt-image-2.6-sunburst');
  assert.equal(imageCommand('/image -- --help 海报')!.request!.prompt, '--help 海报');
});

test('image provider uses one explicit JPEG request and sanitizes provider failures', async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-only-image-key';
  const request = imageCommand('/image 小猫')!.request!;
  let calls = 0;
  try {
    const bytes = await generateImage(request, async (url, init) => {
      calls++; assert.equal(url, 'https://api.openai.com/v1/images/generations');
      const body = JSON.parse(init!.body as string);
      assert.equal(body.model, 'gpt-image-2.6-flare'); assert.equal(body.n, 1);
      assert.equal(body.output_format, 'jpeg'); assert.equal(body.response_format, undefined);
      assert.equal(body.reasoning, undefined);
      return Response.json({ data: [{ b64_json: Buffer.from([255, 216, 255, 0]).toString('base64') }] });
    });
    assert.equal(bytes[0], 255); assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(generateImage(request, async () => {
      calls++; return Response.json({ error: { code: 'insufficient_quota', message: 'private upstream body' } }, { status: 429 });
    }), /openai-image HTTP 429 insufficient_quota/);
    assert.equal(calls, 1);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test('images share the text allowance, deduplicate delivery and preserve chat settings', async () => {
  const store = new MemoryStore(); const now = Date.now();
  const binding = { group: 'g', owner: 'owner', pairedAt: now };
  await store.write('config/binding.json', binding, null);
  let images = 0; let uploads = 0; let deliveries = 0;
  const engine = new Engine(store, { pairingCode: '', enabled: true,
    generateImage: async () => { images++; return Buffer.from('test'); },
    uploadImage: async () => { uploads++; return { fileInfo: 'test-file-info', expiresAt: now + 60_000 }; },
    deliverImage: async (_input, caption, file) => { deliveries++; assert.match(caption, /gpt-image-2.6-flare/); assert.equal(file, 'test-file-info'); return 'sent'; },
    deliver: async () => 'sent', generate: async () => { throw new Error('Text model must not run'); },
  });
  const input: Incoming = { platform: 'qq', scope: 'group', user: 'member', group: 'g', id: 'image', text: '/image 小猫', timestamp: now };
  const accounts = new AccountsService(store);
  await accounts.reserve({ ...input, id: 'earlier-text', text: '你好' }, binding);
  await engine.accept(input); await engine.run(sessionKey(input));
  await engine.accept(input); await engine.run(sessionKey(input));
  assert.equal(images, 1); assert.equal(uploads, 1); assert.equal(deliveries, 1);
  assert.equal((await accounts.inspect(input, binding)).used, 2);
  const session = (await store.read<Session>(sessionKey(input)))!.value;
  assert.equal(session.settings.model.key, 'openai:gpt-6.1-sol'); assert.deepEqual(session.settings.history, {});
  await engine.accept({ ...input, id: 'invalid', text: '/image --model invalid 小猫' });
  await engine.run(sessionKey(input));
  assert.equal((await accounts.inspect(input, binding)).used, 2);
});

test('an interrupted image generation is never automatically charged a second time', async () => {
  const store = new MemoryStore(); const now = Date.now(); let generated = 0;
  await store.write('config/binding.json', { group: 'g', owner: 'owner', pairedAt: now }, null);
  const engine = new Engine(store, { pairingCode: '', enabled: true, deliver: async () => 'sent',
    generateImage: async () => { generated++; throw new Error('Must not retry'); } });
  const input: Incoming = { platform: 'qq', group: 'g', user: 'owner', id: 'interrupted-image', text: '/image 小猫', timestamp: now };
  await engine.accept(input);
  const snapshot = (await store.read<Session>(sessionKey(input)))!;
  snapshot.value.jobs[0]!.stage = 'generating';
  await store.write(sessionKey(input), snapshot.value, snapshot.etag);
  await engine.recover(); assert.equal(generated, 0);
});

test('image provider preserves HTTP status without leaking malformed upstream content', async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-only';
  try {
    await assert.rejects(generateImage(imageCommand('/image cat')!.request!, async () => new Response('private HTML error', { status: 503 })), /openai-image HTTP 503 invalid_response_body/);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});
