import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyWebhookSignature, signValidationResponse } from '@tencent-connect/qqbot-nodejs/protocol';
import type { Incoming } from './types.ts';

export class QQFailure extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(`QQ HTTP ${status} ${code}`); }
}
/** Constant-time comparison also handles unequal-length inputs without exceptions. */
/** Compare equally sized credential digests without leaking a differing prefix. */
export function secretEquals(a: string, b: string): boolean {
  return Boolean(a && b) && timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
/** Verify the untouched webhook bytes and reject replay timestamps outside the retention window. */
export function verify(body: Buffer, headers: Headers, secret: string, now = Date.now()): boolean {
  const timestamp = headers.get('x-signature-timestamp') ?? '';
  const signature = headers.get('x-signature-ed25519') ?? '';
  if (!secret || !/^\d{10}$/.test(timestamp) || !/^[a-f\d]{128}$/i.test(signature)) return false;
  // A signed replay must not reopen a pruned completed-message entry.
  if (Math.abs(now - Number(timestamp) * 1000) > 10 * 60_000) return false;
  return verifyWebhookSignature({ body, timestamp, signature, botSecret: secret });
}
/** Challenge text must never be an event JSON object: both protocols share a signing key. */
export function challenge(data: unknown, secret: string): object | null {
  if (!secret || !data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.plain_token !== 'string' || typeof d.event_ts !== 'string' || d.plain_token.length > 256 || !/^\d{10}$/.test(d.event_ts)) return null;
  // Every JSON object accepted by JSON.parse starts with '{' after JSON whitespace.
  // Restrict the dangerous message domain without guessing Tencent's random-token alphabet.
  if (!d.plain_token.length || /^\s*\{/.test(d.plain_token)) return null;
  return signValidationResponse({ plainToken: d.plain_token, eventTs: d.event_ts, botSecret: secret });
}
/** QQ group_openid differs from the visible group number; it comes from a signed event. */
export function parseEvent(payload: unknown): Incoming | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, any>;
  if (p.op !== 0 || !['GROUP_AT_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE'].includes(p.t)) return null;
  const d = p.d;
  const privateChat = p.t === 'C2C_MESSAGE_CREATE';
  const user = (privateChat ? d?.author?.user_openid : d?.author?.member_openid) || d?.author?.id;
  const group = privateChat ? 'private' : d?.group_openid;
  // Tencent identifiers are opaque, not usernames or fixed-format base64 strings.
  // Hash them for local keys and encode them at URL boundaries; don't reject valid punctuation.
  const valid = (x: unknown): x is string => {
    if (typeof x !== 'string' || !x.length || x.length > 2048 || /[\u0000-\u0020\u007f]/.test(x)) return false;
    try { encodeURIComponent(x); return true; } catch { return false; }
  };
  if (!d || !valid(d.id) || !valid(group) || !valid(user) || typeof d.content !== 'string' || d.author?.bot === true) return null;
  const timestamp = Date.parse(d.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  // Only remove a leading bot mention. Preserve user message contents otherwise.
  const text = d.content.replace(/^\s*<@!?[^>]+>\s*/, '').trim();
  if (!text || text.length > 2000) return null;
  const mentions = !privateChat && Array.isArray(d.mentions) ? d.mentions.filter((m: any) => !m.bot && !m.is_you && m.scope !== 'all')
    .map((m: any) => ({ id: m.member_openid ?? m.id, name: typeof m.username === 'string' ? m.username : typeof m.nickname === 'string' ? m.nickname : undefined,
      union: valid(m.union_openid) ? m.union_openid : undefined })).filter((m: any) => valid(m.id)) : [];
  return { id: d.id, platform: 'qq', group, user, text, timestamp, scope: privateChat ? 'private' : 'group',
    role: !privateChat && ['member','admin','owner'].includes(d.author.member_role) ? d.author.member_role : undefined,
    union: valid(d.author.union_openid) ? d.author.union_openid : undefined, mentions };
}

/** QQ adds the passive-reply mention itself; a leading newline separates structured command output. */
export function replyContent(input: Incoming, text: string): string {
  return input.scope !== 'private' && input.text.startsWith('/') ? '\n' + text.replace(/^\n+/, '') : text;
}
let cachedToken: { value: string; until: number } | undefined;
/** Cache access tokens only until shortly before Tencent expiry; never persist credentials. */
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
    response = await fetch(`https://api.sgroup.qq.com/v2/${input.scope === 'private' ? 'users' : 'groups'}/${encodeURIComponent(input.scope === 'private' ? input.user : input.group)}/messages`, {
      method: 'POST', headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', 'X-Union-Appid': process.env.QQ_APP_ID_ANON! },
      body: JSON.stringify({ content: replyContent(input, text), msg_type: 0, msg_id: input.id, msg_seq: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new QQFailure(0, 'delivery_unknown'); }
  const data = await response.json() as { id?: string; code?: number };
  if (!response.ok || data.code) throw new QQFailure(response.status, String(data.code ?? 'send_error'));
  return data.id ?? input.id;
}

/** Direct byte upload avoids asking Tencent to fetch a potentially unreachable Vercel URL. */
export async function uploadQQImage(input: Incoming, bytes: Buffer): Promise<{ fileInfo: string; expiresAt: number }> {
  const token = await qqToken();
  const scope = input.scope === 'private' ? 'users' : 'groups';
  const target = input.scope === 'private' ? input.user : input.group;
  const response = await fetch(`https://api.sgroup.qq.com/v2/${scope}/${encodeURIComponent(target)}/files`, {
    method: 'POST', headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', 'X-Union-Appid': process.env.QQ_APP_ID_ANON! },
    body: JSON.stringify({ file_type: 1, file_name: 'anon-image.jpg', file_data: bytes.toString('base64'), srv_send_msg: false }),
    signal: AbortSignal.timeout(25_000),
  });
  const data = await response.json() as { file_info?: string; ttl?: number; code?: number };
  if (!response.ok || data.code || !data.file_info) throw new QQFailure(response.status, String(data.code ?? 'image_upload_failed'));
  return { fileInfo: data.file_info, expiresAt: Date.now() + (data.ttl === 0 ? 86400 : Math.max(0, (data.ttl ?? 300) - 10)) * 1000 };
}

/** Persist the sending stage before this POST, just as with text replies. */
export async function replyQQImage(input: Incoming, text: string, fileInfo: string): Promise<string> {
  const token = await qqToken();
  const scope = input.scope === 'private' ? 'users' : 'groups';
  const target = input.scope === 'private' ? input.user : input.group;
  const response = await fetch(`https://api.sgroup.qq.com/v2/${scope}/${encodeURIComponent(target)}/messages`, {
    method: 'POST', headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', 'X-Union-Appid': process.env.QQ_APP_ID_ANON! },
    body: JSON.stringify({ content: replyContent(input, text), msg_type: 7, media: { file_info: fileInfo }, msg_id: input.id, msg_seq: 1 }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json() as { id?: string; code?: number };
  if (!response.ok || data.code || !data.id) throw new QQFailure(response.status, String(data.code ?? 'image_send_failed'));
  return data.id;
}
