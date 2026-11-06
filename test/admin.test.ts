import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET, POST } from '../api/admin.ts';
import { BlobStore, MemoryStore } from '../src/store.ts';

test('admin batches status reads and deletes disposable diagnostics after success or failure', async () => {
  const previous = { read: BlobStore.prototype.read, write: BlobStore.prototype.write, keys: BlobStore.prototype.keys, del: BlobStore.prototype.deleteDiagnostic };
  const oldSecret = process.env.CRON_SECRET; process.env.CRON_SECRET = 'test-only';
  const memory = new MemoryStore(); let live = 0; let maxLive = 0; const deleted: string[] = []; let fail = false;
  BlobStore.prototype.keys = async () => Array.from({ length: 25 }, (_, i) => `sessions/${i}.json`);
  BlobStore.prototype.read = async function<T>(key: string) {
    live++; maxLive = Math.max(maxLive, live); await new Promise(r => setTimeout(r, 1)); live--;
    return memory.read<T>(key);
  };
  BlobStore.prototype.write = async function<T>(key: string, value: T, etag: string | null) {
    if (fail) throw Error('probe failed'); return memory.write(key, value, etag);
  };
  BlobStore.prototype.deleteDiagnostic = async key => { deleted.push(key); };
  const request = (action?: string) => new Request('https://example.invalid/admin', { method: action ? 'POST' : 'GET', headers: { authorization: 'Bearer test-only' }, ...(action ? { body: JSON.stringify({ action }) } : {}) });
  try {
    assert.equal((await GET(request())).status, 200); assert.ok(maxLive <= 8);
    for (const action of ['blob', 'blob-large']) {
      assert.equal((await POST(request(action))).status, 200);
      fail = true; await assert.rejects(POST(request(action)), /probe failed/); fail = false;
    }
    assert.equal(deleted.length, 4); assert.equal(new Set(deleted).size, 4);
  } finally {
    BlobStore.prototype.read = previous.read; BlobStore.prototype.write = previous.write; BlobStore.prototype.keys = previous.keys; BlobStore.prototype.deleteDiagnostic = previous.del;
    if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
  }
});
