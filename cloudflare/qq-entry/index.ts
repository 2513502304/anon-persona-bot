const UPSTREAM = 'https://anon-persona-bot.vercel.app/api/qq';
const MAX_BODY_BYTES = 65_536;

/** Relay signed QQ bytes unchanged to one fixed origin; Vercel owns authentication and acknowledgment. */
export async function relay(request: Request, upstreamFetch: typeof fetch = fetch): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/health' && request.method === 'GET') {
    return Response.json({ service: 'anon-qq-entry' });
  }
  if (path !== '/api/qq') return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
  } catch { return new Response(null, { status: 400 }); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const name of ['x-signature-ed25519', 'x-signature-timestamp']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    // Do not follow redirects, invent an ACK, or retry an event whose acceptance is uncertain.
    const upstream = await upstreamFetch(UPSTREAM, {
      method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return new Response(null, { status: 502 });
    }
    return new Response(upstream.body, { status: upstream.status, headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store',
    } });
  } catch { return new Response(null, { status: 502 }); }
}

export default { fetch: (request: Request) => relay(request) };
