// supabase/functions/auth-before-user-created/index.ts
//
// 5.11.123 (30 Oct 2026): the Ops project's "Before User Created" auth hook. Sign ups are closed:
// anonymous users (kiosk, online, QR, gift, catering) are allowed, every other new account is
// refused with a plain message. The whole decision and the signature check live in
// _shared/signupGate.js (tested in src/lib/signupGate.test.js). Deploy with --no-verify-jwt:
// Supabase Auth signs the request (Standard Webhooks) and sends no user JWT.
//
// Set up (Peter, dashboard, Authentication > Hooks > Before User Created): HTTPS, URI
//   https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/auth-before-user-created
// Generate secret, then: npx supabase secrets set BEFORE_USER_CREATED_HOOK_SECRET=<it>.
// Hook timeout is 5 s with retries, so this does nothing but decide and answer.

import { decideUserCreation, verifyStandardWebhook, parseHookSecrets } from '../_shared/signupGate.js';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const secrets = parseHookSecrets(Deno.env.get('BEFORE_USER_CREATED_HOOK_SECRET') ?? '');

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: { message: 'method not allowed', http_code: 405 } }, 405);
  const rawBody = await req.text();
  let payload: any = null;
  try { payload = JSON.parse(rawBody); } catch { payload = null; }

  const sig = await verifyStandardWebhook({ headers: req.headers, rawBody, secrets });
  const d = decideUserCreation(payload);
  // One line per call. The address is masked; the reason and the signature state are the point.
  console.log(JSON.stringify({ hook: 'before-user-created', decision: d.reason, who: d.who, signature: sig.why,
    provider: payload?.user?.app_metadata?.provider ?? null, ip: payload?.metadata?.ip_address ?? null }));
  return json(d.body, d.status);
});
