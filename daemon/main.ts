import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { gatewayLease } from '../src/gateway-lease.ts';
import { runtime } from '../src/runtime.ts';
import { parseEvent } from '../src/qq.ts';

// Only operational event names enter logs: never SDK error bodies, tokens, or user messages.
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
const engine = runtime();
const owner = randomUUID();
const stop = new AbortController();
const status: { connected: boolean; readyAt?: number } = { connected: false };
const inflight = new Set<Promise<unknown>>();
let leaseUntil = 0;
let lastTick = Date.now();
let bot: QQBot | undefined;
let recovering = false;

function track(task: Promise<unknown>) {
  const guarded = task.catch(error => {
    const name = error instanceof Error && /^[A-Za-z]{1,80}$/.test(error.name) ? error.name : 'Error';
    const message = error instanceof Error ? error.message : '';
    const known = ['Lease lost', 'State contention; retry later', 'Invalid outbox state'];
    log('task_failed', { name, reason: known.includes(message) ? message : 'see_stage',
      // Stack locations omit the first line (which contains the sensitive error message).
      location: error instanceof Error ? error.stack?.split('\n').slice(1, 3).map(line => line.match(/gateway\.mjs:\d+:\d+/)?.[0]).filter(Boolean) : [] });
  }).finally(() => inflight.delete(guarded));
  inflight.add(guarded);
  return guarded;
}
function shutdown() {
  if (stop.signal.aborted) return;
  log('gateway_stopping');
  stop.abort();
  bot?.stop();
  status.connected = false;
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Internal liveness is independent of Tencent availability; transient network errors use SDK backoff.
const server = createServer((req, res) => {
  res.statusCode = req.url === '/health' && Date.now() - lastTick < 90_000 ? 200 : 503;
  res.end('anon-gateway');
}).listen(1234, '0.0.0.0');
const watchdog = setInterval(() => {
  if (leaseUntil && Date.now() >= leaseUntil) {
    log('gateway_lease_expired'); shutdown();
  }
}, 1000);

async function main() {
  if (!process.env.QQ_APP_ID_ANON || !process.env.QQ_APP_SECRET_ANON) throw new Error('Missing QQ configuration');
  while (!stop.signal.aborted && !leaseUntil) {
    lastTick = Date.now();
    leaseUntil = await gatewayLease(engine.store, owner, 'acquire', status);
    if (!leaseUntil) await delay(5000, undefined, { signal: stop.signal });
  }
  if (stop.signal.aborted) return;
  log('gateway_lease_acquired');
  bot = new QQBot({ appId: process.env.QQ_APP_ID_ANON, appSecret: process.env.QQ_APP_SECRET_ANON,
    transport: 'websocket', intents: 1 << 25 });
  bot.on('ready', () => {
    status.connected = true; status.readyAt = Date.now(); log('gateway_ready');
  });
  bot.on('resumed', () => { status.connected = true; log('gateway_resumed'); });
  bot.on('disconnected', event => {
    status.connected = false;
    log('gateway_disconnected', { code: event.code, willReconnect: event.willReconnect });
  });
  bot.on('error', () => log('gateway_transport_error'));
  bot.on('message', (_ctx, message) => {
    if (stop.signal.aborted || Date.now() >= leaseUntil) return;
    const input = parseEvent({ op: 0, t: message.rawEventType, d: message.raw });
    if (!input) return;
    return track((async () => {
      const accepted = await engine.accept(input);
      log('gateway_message', { accepted: accepted.accepted });
      if (accepted.key) await engine.run(accepted.key);
    })()).then(() => {});
  });
  // SDK owns heartbeat, token refresh and reconnect/RESUME in memory. Disk sessions are not used.
  const running = bot.start(stop.signal).catch((error: unknown) => {
    // Whitelist SDK codes; arbitrary upstream error messages may contain sensitive payloads.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    log('gateway_terminal_failure', { code: code === 'GATEWAY_FATAL_CLOSE' || code === 'GATEWAY_RETRY_EXHAUSTED' ? code : 'startup_failed' });
    process.exitCode = 1;
  }).finally(shutdown);
  let lastRecovery = 0;
  try {
    while (!stop.signal.aborted) {
      lastTick = Date.now();
      const renewed = await gatewayLease(engine.store, owner, 'renew', status);
      if (!renewed || stop.signal.aborted) { shutdown(); break; }
      leaseUntil = renewed;
      if (!recovering && Date.now() - lastRecovery >= 60_000) {
        recovering = true; lastRecovery = Date.now();
        void track(engine.recover().finally(() => { recovering = false; }));
      }
      await delay(30_000, undefined, { signal: stop.signal });
    }
  } finally { shutdown(); await running; }
}

try { await main(); }
catch { if (!stop.signal.aborted) { log('gateway_worker_failed'); process.exitCode = 1; } }
finally {
  shutdown();
  clearInterval(watchdog);
  // Finish already accepted work before releasing the gateway; bound by Vercel's 120s grace.
  const drainTimeout = setTimeout(() => process.exit(1), 110_000);
  await Promise.allSettled([...inflight]);
  try { if (leaseUntil) await gatewayLease(engine.store, owner, 'release', status); }
  catch { log('gateway_release_failed'); }
  clearTimeout(drainTimeout);
  server.close();
}
