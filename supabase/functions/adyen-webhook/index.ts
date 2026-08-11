// supabase/functions/adyen-webhook/index.ts
//
// Adyen programme SLICE 0 — the webhook receiver (ADYEN_INTEGRATION_PLAN.md).
// Registered in the Customer Area (Developers → Webhooks → Standard webhook)
// as: https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/adyen-webhook
//
// PHILOSOPHY (the Ryft lesson): durability first, semantics second. Every
// notification is stored RAW in adyen_events before anything interprets it,
// then acknowledged. Consumers mark rows processed later; anything missed or
// misparsed can be replayed from the table forever.
//
// SECURITY, staged deliberately:
//   - Basic auth: if ADYEN_WEBHOOK_USER/_PASS secrets are set, requests must
//     match (Adyen sends the credentials you configure on the webhook).
//   - HMAC (ADYEN_HMAC_KEY): the standard-webhook signature is computed over
//     the SIGNING STRING pspReference:originalReference:merchantAccountCode:
//     merchantReference:value:currency:eventCode:success (key = hex → binary,
//     HMAC-SHA256, Base64). We VERIFY AND RECORD hmac_valid on every item but
//     do NOT reject yet — verification is confirmed against real test events
//     first, then rejection is armed before live (flip REJECT_INVALID_HMAC).
//     Never guess-reject during setup: a wrong signing recipe would silently
//     drop every payment notification.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const HMAC_KEY = Deno.env.get('ADYEN_HMAC_KEY') ?? '';
const BASIC_USER = Deno.env.get('ADYEN_WEBHOOK_USER') ?? '';
const BASIC_PASS = Deno.env.get('ADYEN_WEBHOOK_PASS') ?? '';
const REJECT_INVALID_HMAC = false;   // arm before LIVE, after test events verify green

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacOk(item: any): Promise<boolean | null> {
  if (!HMAC_KEY) return null;
  const sig = item?.additionalData?.hmacSignature;
  if (!sig) return null;
  try {
    const amount = item.amount ?? {};
    const signing = [
      item.pspReference ?? '', item.originalReference ?? '',
      item.merchantAccountCode ?? '', item.merchantReference ?? '',
      String(amount.value ?? ''), amount.currency ?? '',
      item.eventCode ?? '', item.success ?? '',
    ].join(':');
    const key = await crypto.subtle.importKey('raw', hexToBytes(HMAC_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signing));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return b64 === sig;
  } catch (e) {
    console.error('[adyen-webhook] hmac check failed:', (e as Error).message);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  // Basic auth, when configured on the webhook in the Customer Area.
  if (BASIC_USER) {
    const got = req.headers.get('authorization') || '';
    const want = 'Basic ' + btoa(`${BASIC_USER}:${BASIC_PASS}`);
    if (got !== want) return new Response('unauthorized', { status: 401 });
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const items = Array.isArray(body?.notificationItems) ? body.notificationItems : [];
  for (const wrap of items) {
    const item = wrap?.NotificationRequestItem ?? wrap;
    if (!item) continue;
    const valid = await hmacOk(item);
    if (REJECT_INVALID_HMAC && valid === false) {
      console.error('[adyen-webhook] REJECTED invalid HMAC', item.pspReference);
      return new Response('invalid hmac', { status: 401 });
    }
    const { error } = await admin.from('adyen_events').insert({
      live: String(body.live) === 'true',
      event_code: item.eventCode ?? null,
      psp_reference: item.pspReference ?? null,
      merchant_account: item.merchantAccountCode ?? null,
      merchant_reference: item.merchantReference ?? null,
      success: String(item.success) === 'true',
      hmac_present: !!item?.additionalData?.hmacSignature,
      hmac_valid: valid,
      raw: item,
    });
    // Storage failure = do NOT ack; Adyen retries, which is exactly what we want.
    if (error) {
      console.error('[adyen-webhook] store failed:', error.message);
      return new Response('store failed', { status: 500 });
    }
  }

  // Adyen's expected acknowledgement for standard webhooks.
  return new Response(JSON.stringify({ notificationResponse: '[accepted]' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
