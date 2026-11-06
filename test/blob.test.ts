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
