/** Health reveals no credentials, group IDs, chat content or account metadata. */
export function GET() { return Response.json({ ok: true, service: 'anon-persona-bot', version: '0.1.0' }); }
