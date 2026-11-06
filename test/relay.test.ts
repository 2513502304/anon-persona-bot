import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relay } from '../cloudflare/qq-entry/index.ts';

test('relay preserves signed bytes and upstream rejection without forwarding unrelated credentials', async () => {
  const raw = '{ "op":0, "d":{"content":"你好"} }';
  let calls = 0;
  const response = await relay(new Request('https://entry.example/api/qq?target=https://other.example', {
    method: 'POST', body: raw, headers: { 'x-signature-ed25519': 'sig', 'x-signature-timestamp': '123',
      Authorization: 'unrelated', Cookie: 'private' },
  }), async (url, init) => {
    calls++;
    assert.equal(url, 'https://anon-persona-bot.vercel.app/api/qq');
    assert.equal(new TextDecoder().decode(init!.body as Uint8Array), raw);
    const headers = new Headers(init!.headers);
    assert.equal(headers.get('x-signature-ed25519'), 'sig');
    assert.equal(headers.get('x-signature-timestamp'), '123');
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    assert.equal(init!.redirect, 'manual');
    return new Response('rejected', { status: 401 });
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 401);
  assert.equal(await response.text(), 'rejected');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('relay bounds streamed bodies and never forwards other routes or methods', async () => {
  const unexpected: typeof fetch = async () => { throw new Error('unexpected upstream request'); };
  for (const [path, method, status] of [['/health', 'GET', 200], ['/admin', 'POST', 404], ['/api/qq', 'GET', 405]] as const) {
    assert.equal((await relay(new Request(`https://entry.example${path}`, { method }), unexpected)).status, status);
  }
  let calls = 0;
  assert.equal((await relay(new Request('https://entry.example/api/qq', {
    method: 'POST', body: 'x'.repeat(65_537),
  }), async () => { calls++; return new Response(); })).status, 413);
  assert.equal(calls, 0);
});

test('relay returns the exact challenge and does not acknowledge redirects or retry failures', async () => {
  const request = () => new Request('https://entry.example/api/qq', { method: 'POST', body: '{"op":13}' });
  const challenge = '{"plain_token":"challenge","signature":"signed"}';
  assert.equal(await (await relay(request(), async () => new Response(challenge))).text(), challenge);
  assert.equal((await relay(request(), async () => new Response(null, {
    status: 302, headers: { Location: 'https://elsewhere.example' },
  }))).status, 502);
  let attempts = 0;
  assert.equal((await relay(request(), async () => { attempts++; throw new Error('network'); })).status, 502);
  assert.equal(attempts, 1);
});
