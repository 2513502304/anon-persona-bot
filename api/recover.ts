import { secretEquals } from '../src/qq.ts';
import { runtime } from '../src/runtime.ts';
/** Vercel Cron is authenticated; arbitrary callers cannot trigger recovery/model work. */
export async function GET(request: Request) {
  if (!secretEquals(request.headers.get('authorization') ?? '', `Bearer ${process.env.CRON_SECRET ?? ''}`) || !process.env.CRON_SECRET) return new Response(null, { status: 401 });
  const count = await runtime().recover();
  return Response.json({ processed: count });
}
