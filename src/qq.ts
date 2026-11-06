import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyWebhookSignature, signValidationResponse } from '@tencent-connect/qqbot-nodejs/protocol';
import type { Incoming } from './types.ts';

export class QQFailure extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(`QQ HTTP ${status} ${code}`); }
}
/** Constant-time comparison also handles unequal-length inputs without exceptions. */
export function secretEquals(a: string, b: string): boolean {
  return Boolean(a && b) && timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function verify(body: Buffer, headers: Headers, secret: string, now = Date.now()): boolean {
  const timestamp = headers.get('x-signature-timestamp') ?? '';
  const signature = headers.get('x-signature-ed25519') ?? '';
  if (!secret || !/^\d{10}$/.test(timestamp) || !/^[a-f\d]{128}$/i.test(signature)) return false;
  // A signed replay must not reopen a pruned completed-message entry.
  if (Math.abs(now - Number(timestamp) * 1000) > 10 * 60_000) return false;
  return verifyWebhookSignature({ body, timestamp, signature, botSecret: secret });
}
export function challenge(data: unknown, secret: string): object | null {
  if (!secret || !data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.plain_token !== 'string' || typeof d.event_ts !== 'string' || d.plain_token.length > 256 || !/^\d{10}$/.test(d.event_ts)) return null;
  return signValidationResponse({ plainToken: d.plain_token, eventTs: d.event_ts, botSecret: secret });
}
/** QQ group_openid differs from the visible group number; it comes from a signed event. */
export function parseEvent(payload: unknown): Incoming | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, any>;
  if (p.op !== 0 || p.t !== 'GROUP_AT_MESSAGE_CREATE') return null;
  const d = p.d;
  if (!d || typeof d.id !== 'string' || typeof d.group_openid !== 'string' || typeof d.author?.member_openid !== 'string' || typeof d.content !== 'string') return null;
  if ([d.id,d.group_openid,d.author.member_openid].some(x => !/^[^\s\x00-\x1f]{1,256}$/.test(x))) return null;
  const timestamp = Date.parse(d.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  // Only remove a leading bot mention. Preserve user message contents otherwise.
  const text = d.content.replace(/^\s*<@!?[^>]+>\s*/, '').trim();
  if (!text || text.length > 2000) return null;
  return { id: d.id, platform: 'qq', group: d.group_openid, user: d.author.member_openid, text, timestamp };
}
/** QQ adds the passive-reply mention; separate structured command output from it. */
export function replyContent(input: Incoming, text: string): string {
  return input.text.startsWith('/') ? '\n' + text.replace(/^\n+/, '') : text;
}
let cachedToken: { value: string; until: number } | undefined;
export async function qqToken(fetcher: typeof fetch = fetch): Promise<string> {
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.value;
  const response = await fetcher('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: process.env.QQ_APP_ID_ANON, clientSecret: process.env.QQ_APP_SECRET_ANON }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json() as { access_token?: string; expires_in?: string | number; code?: number };
  if (!response.ok || !data.access_token) throw new QQFailure(response.status, String(data.code ?? 'token_error'));
  cachedToken = { value: data.access_token, until: Date.now() + (Number(data.expires_in ?? 7200) - 90) * 1000 };
  return data.access_token;
}
/** One passive reply uses the event's own msg_id/seq. Never automatically resend an ambiguous POST. */
export async function replyQQ(input: Incoming, text: string): Promise<string> {
  const token = await qqToken();
  let response: Response;
  try {
    response = await fetch(`https://api.sgroup.qq.com/v2/groups/${encodeURIComponent(input.group)}/messages`, {
      method: 'POST', headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', 'X-Union-Appid': process.env.QQ_APP_ID_ANON! },
      body: JSON.stringify({ content: replyContent(input, text), msg_type: 0, msg_id: input.id, msg_seq: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new QQFailure(0, 'delivery_unknown'); }
  const data = await response.json() as { id?: string; code?: number };
  if (!response.ok || data.code) throw new QQFailure(response.status, String(data.code ?? 'send_error'));
  return data.id ?? input.id;
}
