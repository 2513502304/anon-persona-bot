import { secretEquals, qqToken } from '../src/qq.ts';
import { BlobStore, mutate } from '../src/store.ts';
import { generate, DEFAULT_MODEL, ProviderFailure } from '../src/models.ts';
import type { Session, Binding } from '../src/types.ts';
import { GATEWAY_KEY, type GatewayState } from '../src/gateway-lease.ts';
import { randomUUID } from 'node:crypto';

/** Missing deployment credentials always deny operational access. */
function authorized(request: Request) {
  return !!process.env.CRON_SECRET && secretEquals(request.headers.get('authorization') ?? '', `Bearer ${process.env.CRON_SECRET}`);
}
/** Read-only operational status; requires a server-side administrator credential. */
export async function GET(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401 });
  const store = new BlobStore();
  const binding = (await store.read<Binding>('config/binding.json'))?.value;
  const gateway = (await store.read<GatewayState>(GATEWAY_KEY))?.value;
  const keys = await store.keys('sessions/');
  const readSummary = async (key: string) => {
    const snapshot = await store.read<Session>(key);
    const s = snapshot?.value;
    return { pending: s?.jobs.length ?? 0, stages: s?.jobs.map(j => j.stage),
      weakEtag: snapshot?.etag.startsWith('W/'),
      leaseUntil: s?.lease?.until, lastResult: s?.lastResult, updatedAt: s?.updatedAt };
  };
  const sessions: Awaited<ReturnType<typeof readSummary>>[] = [];
  // Bound private-origin reads even when a deployment has hundreds of retained sessions.
  for (let start = 0; start < keys.length; start += 8) {
    sessions.push(...await Promise.all(keys.slice(start, start + 8).map(readSummary)));
  }
  return Response.json({ enabled: process.env.BOT_ENABLED === 'true', bound: !!binding,
    gateway: gateway ? { connected: gateway.connected && gateway.until > Date.now(), readyAt: gateway.readyAt,
      updatedAt: gateway.updatedAt, leaseActive: gateway.until > Date.now() } : null,
    credentials: ['OPENAI_API_KEY','DEEPSEEK_API_KEY','QQ_APP_ID_ANON','QQ_APP_SECRET_ANON'].map(key => ({ key, present: !!process.env[key] })), sessions });
}
/** Fixed probes exercise this deployment's network and storage; no arbitrary URLs or prompts. */
export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401 });
  let action: string;
  try { action = (await request.json() as { action: string }).action; }
  catch { return new Response(null, { status: 400 }); }
  if (action === 'qq') {
    try {
      const token = await qqToken();
      const response = await fetch('https://api.sgroup.qq.com/users/@me', {
        headers: { Authorization: `QQBot ${token}`, 'X-Union-Appid': process.env.QQ_APP_ID_ANON! }, signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json() as { code?: number };
      return Response.json({ token: true, apiStatus: response.status, code: data.code ?? null });
    } catch { return Response.json({ tokenOrApi: false }, { status: 502 }); }
  }
  if (action === 'blob') {
    const store = new BlobStore();
    const key = `diagnostics/cas-${randomUUID()}.json`;
    try {
      // Settle every writer before cleanup, including when one probe fails.
      const writes = await Promise.allSettled(Array.from({ length: 4 }, () => mutate(store, key, () => ({ count: 0 }), value => {
        value.count++; return { value, result: undefined };
      })));
      const failed = writes.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const count = (await store.read<{ count: number }>(key))?.value.count;
      return Response.json({ cas: count === 4, count });
    } finally { await store.deleteDiagnostic(key); }
  }
  if (action === 'blob-large') {
    const store = new BlobStore();
    const key = `diagnostics/large-${randomUUID()}.json`;
    try {
    await store.write(key, { content: 'storage-probe-'.repeat(1000), count: 0 }, null);
    const snapshot = (await store.read<{ content: string; count: number }>(key))!;
    const weakEtag = snapshot.etag.startsWith('W/');
    const updated = await store.write(key, { ...snapshot.value, count: 1 }, snapshot.etag);
    return Response.json({ weakEtag, updated });
    } finally { await store.deleteDiagnostic(key); }
  }
  if (action === 'openai' || action === 'deepseek') {
    try {
      const result = await generate(action === 'openai' ? DEFAULT_MODEL : { key: 'deepseek:deepseek-flash', effort: 'high' }, '仅回复 OK。', [{ role: 'user', content: '连接验证，请仅回复 OK。' }]);
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: error instanceof ProviderFailure ? error.message : 'probe_failed' }, { status: 502 });
    }
  }
  return new Response(null, { status: 400 });
}
