import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlobStore } from '../src/store.ts';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

test('state reads bypass caching and compression to preserve the strong version validator', async () => {
  const previousDispatcher = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const oldToken = process.env.BLOB_READ_WRITE_TOKEN;
  const oldStore = process.env.BLOB_STORE_ID;
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore_testcredential';
  delete process.env.BLOB_STORE_ID;
  mock.get('https://teststore.private.blob.vercel-storage.com').intercept({
    path: '/diagnostics/test.json?cache=0', method: 'GET',
    headers: { 'accept-encoding': 'identity' },
  }).reply(200, { content: '中文帮助'.repeat(1000) }, { headers: { etag: '"strong-version"' } });
  try {
    const snapshot = await new BlobStore().read<{ content: string }>('diagnostics/test.json');
    assert.equal(snapshot!.etag, '"strong-version"');
    assert.equal(snapshot!.value.content.length, 4000);
    mock.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await mock.close();
    if (oldToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = oldToken;
    if (oldStore === undefined) delete process.env.BLOB_STORE_ID; else process.env.BLOB_STORE_ID = oldStore;
  }
});

test('missing or weak ETags cannot degrade into an unconditional overwrite', async () => {
  const store = new BlobStore();
  await assert.rejects(store.write('test', {}, ''), /strong ETag/);
  await assert.rejects(store.write('test', {}, 'W/"version"'), /strong ETag/);
});

test('session enumeration continues beyond five hundred objects', async () => {
  const previousDispatcher = getGlobalDispatcher(); const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
  const oldToken = process.env.BLOB_READ_WRITE_TOKEN; const oldUrl = process.env.VERCEL_BLOB_API_URL;
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore_testcredential'; process.env.VERCEL_BLOB_API_URL = 'https://blob-test.invalid';
  for (let page = 0; page < 6; page++) {
    const query = new URLSearchParams({ limit: '100', prefix: 'sessions/', ...(page ? { cursor: String(page) } : {}) });
    mock.get('https://blob-test.invalid').intercept({ path: `/?${query}`, method: 'GET' }).reply(200, {
      hasMore: page < 5, cursor: page < 5 ? String(page + 1) : undefined,
      blobs: Array.from({ length: 100 }, (_, i) => ({ pathname: `sessions/${page * 100 + i}.json`, uploadedAt: new Date().toISOString(), size: 1, url: 'https://test.invalid/blob', downloadUrl: 'https://test.invalid/blob' })),
    });
  }
  try {
    const keys = await new BlobStore().keys('sessions/'); assert.equal(keys.length, 600); assert.equal(keys.at(-1), 'sessions/599.json'); mock.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previousDispatcher); await mock.close();
    if (oldToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.VERCEL_BLOB_API_URL; else process.env.VERCEL_BLOB_API_URL = oldUrl;
  }
});
