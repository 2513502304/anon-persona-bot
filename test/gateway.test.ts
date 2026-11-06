import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.ts';
import { gatewayLease, GATEWAY_KEY, type GatewayState } from '../src/gateway-lease.ts';

test('only one rolling deployment acquires the QQ gateway', async () => {
  const store = new MemoryStore();
  const result = await Promise.all(['old', 'new'].map(owner => gatewayLease(store, owner, 'acquire', { connected: false }, 1000)));
  assert.equal(result.filter(Boolean).length, 1);
});
test('expired holder cannot renew or release its successor', async () => {
  const store = new MemoryStore();
  const expiry = await gatewayLease(store, 'old', 'acquire', { connected: true }, 1000);
  assert.equal(await gatewayLease(store, 'old', 'renew', { connected: true }, expiry), 0);
  const next = await gatewayLease(store, 'new', 'acquire', { connected: false }, expiry);
  assert.ok(next);
  await gatewayLease(store, 'old', 'release', { connected: false }, expiry + 1);
  assert.equal((await store.read<GatewayState>(GATEWAY_KEY))!.value.owner, 'new');
  assert.equal((await store.read<GatewayState>(GATEWAY_KEY))!.value.until, next);
});
