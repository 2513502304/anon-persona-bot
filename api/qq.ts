import { waitUntil } from '@vercel/functions';
import { verify, challenge, parseEvent } from '../src/qq.ts';
import { runtime } from '../src/runtime.ts';

let challenges = { since: 0, count: 0 };
/** Best-effort per-instance flood guard; signature-domain separation is the security boundary. */
function allowChallenge(now = Date.now()): boolean {
  if (now - challenges.since >= 60_000) challenges = { since: now, count: 0 };
  return ++challenges.count <= 30;
}

/** Reject unsigned events before touching storage or invoking any model. */
export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > 65536) return new Response(null, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 65536) { await reader.cancel(); return new Response(null, { status: 413 }); }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks);
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return new Response(null, { status: 400 }); }
  if (!payload || typeof payload !== 'object') return new Response(null, { status: 400 });
  const secret = process.env.QQ_APP_SECRET_ANON ?? '';
  if (payload.op === 13) {
    if (!allowChallenge()) return new Response(null, { status: 429 });
    const result = challenge(payload.d, secret);
    return result ? Response.json(result) : new Response(null, { status: 400 });
  }
  if (!verify(body, request.headers, secret)) return new Response(null, { status: 401 });
  const incoming = parseEvent(payload);
  if (!incoming) return Response.json({ op: 12 });
  try {
    const engine = runtime();
    const accepted = await engine.accept(incoming);
    if (accepted.busy) return new Response(null, { status: 429 });
    if (accepted.key) waitUntil(engine.run(accepted.key).catch(() => console.error('worker_failed; durable inbox retained')));
    return Response.json({ op: 12 });
  } catch {
    console.error('ingress_storage_failed');
    return new Response(null, { status: 503 }); // No acknowledgment until the inbox is durable.
  }
}
/** Public discovery endpoint exposes no binding or account information. */
export function GET() { return Response.json({ service: 'anon-persona-bot', transport: 'QQ webhook' }); }
