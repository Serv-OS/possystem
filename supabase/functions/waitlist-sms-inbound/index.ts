// supabase/functions/waitlist-sms-inbound/index.ts
//
// Tables Ready — two-way waitlist SMS. Twilio POSTs every inbound text here (Messaging webhook
// "A message comes in"). Public (verify_jwt=false / deploy --no-verify-jwt) because Twilio sends
// no JWT. Service-role client so it can write across tenants (it resolves the tenant itself).
//
// Guest replies (case-insensitive, leading/trailing junk tolerated):
//   C | CANCEL | X | NO            -> cancel their entry          (status -> 'cancelled')
//   OK | HERE | Y | YES | OMW
//      | "ON MY WAY" | "ON THE WAY"-> confirm / on-the-way        (stamps confirmed_at; no status change)
//   STOP | STOPALL | UNSUBSCRIBE
//      | END | QUIT | CANCEL(*)    -> opt out                     (marketing_suppressions row)
//   (*) "CANCEL" is treated as cancel-entry here, NOT STOP — a waiting guest cancelling their
//       table should not be opted out of all SMS. Pure unsubscribe keywords are the STOP set.
//
// Venue + entry resolution (NO number->venue table exists in RPOS; mirrors marketing-webhook's
// STOP handler which looks up marketing_messages by to_address): we read the most-recent OUTBOUND
// waitlist text we sent this guest from sms_messages (type='waitlist', to_number = inbound From),
// which yields location_id and reference_id (= waitlist_entries.id). location_id -> org_id via
// locations. This is robust to the single shared TWILIO_FROM_NUMBER and to per-venue numbers alike.
//
// Reply: empty TwiML so Twilio does NOT auto-reply (same as marketing-webhook). Any guest-facing
// acknowledgement is sent as a fresh outbound via send-sms so it is audited + carries STOP copy.
//
// Optional hardening: if MARKETING_WEBHOOK_SECRET is set, the operator appends ?key=<secret> to the
// Messaging webhook URL (Twilio's true X-Twilio-Signature HMAC validation can land in a later slice,
// exactly as noted in marketing-webhook).
//
// Deploys to the Ops DB project (tbetcegmszzotrwdtqhi).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('MARKETING_WEBHOOK_SECRET') || '';
const TWILIO_AUTH = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// Constant-time string compare (don't leak the secret via timing).
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Real Twilio request validation: base64(HMAC-SHA1(authToken, fullURL + sorted(key+value) POST params))
// must equal the X-Twilio-Signature header. Proves the POST actually came from Twilio.
async function validTwilioSignature(req: Request, authToken: string, params: Record<string, string>): Promise<boolean> {
  const sig = req.headers.get('X-Twilio-Signature') || '';
  if (!sig) return false;
  let data = req.url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    let bin = ''; const bytes = new Uint8Array(mac);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return ctEq(btoa(bin), sig);
  } catch { return false; }
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
// Empty TwiML — acknowledges receipt to Twilio without an auto-reply.
const emptyTwiml = () => new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', { status: 200, headers: { ...cors, 'Content-Type': 'text/xml' } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// E.164-ish normaliser: strip spaces. (Outbound store side already normalises to +<digits>.)
const normPhone = (p: string) => (p || '').replace(/\s/g, '');

// Statuses that are STILL on the live board — only these can be cancelled/confirmed by a guest reply.
const ACTIVE = ['waiting', 'notified', 'ready'];

type Intent = 'cancel' | 'confirm' | 'stop' | 'unknown';
function classify(body: string): Intent {
  const t = (body || '').trim().toLowerCase().replace(/[.!,]+$/g, '');
  if (/^(stop|stopall|unsubscribe|end|quit|stopit)$/.test(t)) return 'stop';
  if (/^(c|cancel|x|no)$/.test(t)) return 'cancel';
  if (/^(ok|okay|k|here|y|yes|omw|coming|on my way|on the way|onmyway|ontheway)$/.test(t)) return 'confirm';
  return 'unknown';
}

// org_id for a location (same pattern as the marketing-* edge fns).
async function orgForLocation(locationId: string | null): Promise<string | null> {
  if (!locationId) return null;
  const { data } = await sb.from('locations').select('org_id').eq('id', locationId).maybeSingle();
  return data?.org_id ?? null;
}

// Suppress (STOP) — idempotent, mirrors marketing-webhook.suppress contract.
async function suppress(orgId: string, address: string, customerId?: string | null) {
  await sb.from('marketing_suppressions').upsert(
    { org_id: orgId, channel: 'sms', address, reason: 'stop', customer_id: customerId || null, source: 'waitlist_reply' },
    { onConflict: 'org_id,channel,address', ignoreDuplicates: true },
  );
  if (customerId) {
    try {
      await sb.from('customer_consents').insert({ customer_id: customerId, org_id: orgId, channel: 'sms', purpose: 'marketing', consented: false, source: 'waitlist_reply', method: 'stop' });
    } catch { /* consent ledger best-effort */ }
  }
}

// Find the venue + the entry this guest most likely meant, from the outbound waitlist texts we sent.
// Returns the matched active entry (preferred) and the resolved location/org even if no active entry.
async function resolveContext(fromE164: string): Promise<{ locationId: string | null; entryId: string | null }> {
  // Most recent outbound waitlist SMS to this number -> its location_id + reference_id (entry id).
  const { data: msgs } = await sb
    .from('sms_messages')
    .select('location_id, reference_id, created_at')
    .eq('type', 'waitlist')
    .eq('to_number', fromE164)
    .order('created_at', { ascending: false })
    .limit(20);
  if (!msgs?.length) return { locationId: null, entryId: null };

  // Walk newest-first; the first message whose entry is still ACTIVE wins. If none are active,
  // fall back to the newest message's location (so STOP / unmatched still resolves a venue).
  for (const m of msgs) {
    if (!m.reference_id) continue;
    const { data: entry } = await sb
      .from('waitlist_entries')
      .select('id, status, location_id')
      .eq('id', m.reference_id)
      .maybeSingle();
    if (entry && ACTIVE.includes(entry.status)) {
      return { locationId: entry.location_id || m.location_id || null, entryId: entry.id };
    }
  }
  return { locationId: msgs[0].location_id || null, entryId: null };
}

// Append the lifecycle event (same ledger the host stand writes to).
async function logEvent(locationId: string, entryId: string, from: string, to: string) {
  try {
    await sb.from('waitlist_status_events').insert({ location_id: locationId, waitlist_entry_id: entryId, from_status: from, to_status: to, actor: 'guest_sms' });
  } catch { /* best-effort */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Parse the body FIRST — the Twilio signature is computed over the POST params.
  // Twilio posts application/x-www-form-urlencoded; tolerate proxied JSON too.
  let payload: Record<string, string> = {};
  try {
    const f = await req.formData();
    for (const [k, v] of f.entries()) payload[k] = String(v);
  } catch {
    try { payload = await req.json(); } catch { /* leave empty */ }
  }

  // ── AUTH — FAIL-CLOSED. This webhook mutates prod across tenants with the service role, so it must
  // prove origin. At least one gate MUST be configured, and every configured gate must pass:
  //   • MARKETING_WEBHOOK_SECRET → require ?key=<secret>            (shared secret, like marketing-webhook)
  //   • TWILIO_AUTH_TOKEN        → require a valid X-Twilio-Signature (true Twilio-origin proof)
  // If NEITHER is configured the endpoint refuses — it is NEVER open-by-default.
  const keyOk = !!WEBHOOK_SECRET && ctEq(new URL(req.url).searchParams.get('key') || '', WEBHOOK_SECRET);
  const sigOk = !!TWILIO_AUTH && await validTwilioSignature(req, TWILIO_AUTH, payload);
  if (!WEBHOOK_SECRET && !TWILIO_AUTH) return json({ error: 'webhook not configured' }, 403);
  if (WEBHOOK_SECRET && !keyOk) return json({ error: 'forbidden' }, 403);
  if (TWILIO_AUTH && !sigOk) return json({ error: 'bad signature' }, 403);

  const from = normPhone(String(payload.From || ''));
  const to = normPhone(String(payload.To || ''));
  const body = String(payload.Body || '');
  const sid = String(payload.MessageSid || payload.SmsSid || '') || null;
  if (!from) return emptyTwiml();

  // M4 — idempotency BEFORE any mutation. Twilio retries on timeout; if we've already processed this
  // MessageSid, ack and do nothing (a retry must not clobber a newer reply or re-cancel).
  if (sid) {
    try {
      const { data: seen } = await sb.from('waitlist_sms_inbound').select('id').eq('provider_sid', sid).maybeSingle();
      if (seen) return emptyTwiml();
    } catch { /* audit table absent pre-migration — proceed */ }
  }

  const intent = classify(body);

  // Resolve venue + (ideally) the active entry from the outbound waitlist history.
  const { locationId, entryId } = await resolveContext(from);
  const orgId = await orgForLocation(locationId);

  let action = 'ignored';

  // ── STOP / opt out ──────────────────────────────────────────────────────────
  if (intent === 'stop') {
    if (orgId) {
      // Best-effort customer link for the consent ledger.
      let custId: string | null = null;
      if (entryId) {
        const { data: e } = await sb.from('waitlist_entries').select('customer_id').eq('id', entryId).maybeSingle();
        custId = e?.customer_id ?? null;
      }
      await suppress(orgId, from, custId);
      action = 'opted_out';
    }
  }

  // ── CANCEL the table ──────────────────────────────────────────────────────────
  else if (intent === 'cancel' && entryId && locationId) {
    const { data: e } = await sb.from('waitlist_entries').select('status').eq('id', entryId).maybeSingle();
    if (e && ACTIVE.includes(e.status)) {
      await sb.from('waitlist_entries').update({
        status: 'cancelled',
        last_guest_reply: 'cancel',
        last_reply_at: new Date().toISOString(),
      }).eq('id', entryId);
      await logEvent(locationId, entryId, e.status, 'cancelled');
      action = 'cancelled';
    }
  }

  // ── CONFIRM / on the way (no status change — just an attribute on the entry) ───
  else if (intent === 'confirm' && entryId && locationId) {
    await sb.from('waitlist_entries').update({
      confirmed_at: new Date().toISOString(),
      last_guest_reply: 'confirm',
      last_reply_at: new Date().toISOString(),
    }).eq('id', entryId);
    action = 'confirmed';
  }

  // ── unknown keyword against a known entry — record the reply so the host sees it ─
  else if (entryId && locationId) {
    await sb.from('waitlist_entries').update({
      last_guest_reply: body.slice(0, 200),
      last_reply_at: new Date().toISOString(),
    }).eq('id', entryId);
    action = 'noted';
  } else {
    action = entryId ? 'noted' : 'no_match';
  }

  // ── audit the inbound regardless of outcome ───────────────────────────────────
  try {
    await sb.from('waitlist_sms_inbound').upsert({
      location_id: locationId,
      org_id: orgId,
      waitlist_entry_id: entryId,
      from_number: from,
      to_number: to || null,
      body: body.slice(0, 1000),
      keyword: intent,
      action,
      provider_sid: sid,
    }, { onConflict: 'provider_sid', ignoreDuplicates: true });
  } catch { /* table-absent / audit best-effort — never block the ack */ }

  // Always ack Twilio with empty TwiML (no auto-reply). Operator-facing acknowledgements,
  // if desired, are sent via send-sms separately so they are audited + carry STOP copy.
  return emptyTwiml();
});
