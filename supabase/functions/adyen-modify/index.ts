// supabase/functions/adyen-modify
//
// Post-payment modifications on Checkout v72 (ADYEN_INTEGRATION_PLAN.md Phase 4,
// built ahead of keys): capture (tab close, with tip), cancel (release a hold),
// refund (referenced), adjust (bar-tab step-up via /amountUpdates).
//
// All results are ASYNC at Adyen — success here means "accepted"; the truth
// lands via CAPTURE/REFUND/CANCELLATION webhooks into adyen_payments and the
// closed-check reflection in adyen-webhook. Callers must treat 'received' as
// in-flight, exactly like the Ryft fire-and-forget refund contract.
//
// AUTH (Phase 4, v5.6.79 — the POS refund path has now joined): service role, a
// signed-in BACK OFFICE user with access to the location (user_locations), or a
// PAIRED POS DEVICE at the location (the same devices.device_uid fence
// adyen-terminal-charge uses). See the block above the check for why the device
// arm is required rather than optional.
//
// ⚠️ DEPLOY ME. Edge functions deploy MANUALLY and drift silently. Until this is
// deployed, POS refunds of Adyen sales get 403 and Back Office refunds get 404
// (see the ledger note below) — both now surface as a LOUD failed reversal on the
// check rather than a false success, but no money moves.
//   npx supabase functions deploy adyen-modify --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adyenConfigured, checkoutBase, adyenFetch } from '../_shared/adyen.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!adyenConfigured()) return json({ error: 'Adyen not configured — set ADYEN_API_KEY' }, 503);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);
  const isServiceRole = token === SERVICE_ROLE;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body.action ?? '');
  const psp = String(body.psp_reference ?? '');
  const locationId = String(body.location_id ?? '');
  if (!psp || !locationId || !['capture', 'cancel', 'refund', 'adjust'].includes(action)) {
    return json({ error: "action ('capture'|'cancel'|'refund'|'adjust'), psp_reference and location_id required" }, 400);
  }

  // Resolve venue + merchant account (either id space).
  let { data: ploc } = await platformAdmin.from('locations').select('id, ops_location_id').eq('ops_location_id', locationId).maybeSingle();
  if (!ploc) {
    const fb = await platformAdmin.from('locations').select('id, ops_location_id').eq('id', locationId).maybeSingle();
    ploc = fb.data ?? null;
  }
  if (!ploc) return json({ error: 'location not found' }, 404);

  const opsLocationId = ploc.ops_location_id ?? locationId;

  // ── AUTH (Phase 4, v5.6.79) ───────────────────────────────────────────────
  // Service role, OR a Back Office user with access to the venue, OR — new — a
  // PAIRED POS DEVICE at the venue. The header comment above has always promised
  // the POS refund path "joins in Phase 4 with the same device fence
  // adyen-terminal-charge uses"; this is that fence, character for character
  // (devices.device_uid = auth.uid() AND devices.location_id = the venue).
  //
  // It is needed because a till runs on an ANONYMOUS session: its uid is in
  // `devices`, never in `user_locations`, so every POS refund of an Adyen sale
  // was a guaranteed 403. Back Office refunds were already inside the old fence
  // and are unaffected.
  if (!isServiceRole) {
    const { data: u } = await opsAdmin.auth.getUser(token);
    const uid = u?.user?.id;
    if (!uid) return json({ error: 'unauthorized' }, 401);
    const [{ data: ul }, { data: dev }] = await Promise.all([
      opsAdmin.from('user_locations')
        .select('user_id').eq('user_id', uid).eq('location_id', opsLocationId).maybeSingle(),
      opsAdmin.from('devices')
        .select('id').eq('device_uid', uid).eq('location_id', opsLocationId).maybeSingle(),
    ]);
    if (!ul && !dev) return json({ error: 'no access to this location' }, 403);
  }

  const { data: maa } = await platformAdmin.from('merchant_adyen_accounts')
    .select('merchant_account').eq('location_id', ploc.id).maybeSingle();
  if (!maa?.merchant_account) return json({ error: 'venue has no Adyen account' }, 409);

  // ── VENUE BINDING + PSP RESOLUTION ────────────────────────────────────────
  //
  // v968 review hardening: bind the reference to the CALLER'S venue. Under AfP
  // every venue shares the regional merchant account, so Adyen itself will NOT
  // reject a cross-venue reference — we must. Service role still bypasses (server
  // flows can act before the AUTHORISATION webhook lands).
  //
  // v5.6.79 — TWO REAL PROBLEMS THE LEDGER-ONLY VERSION HID:
  //
  //   1. `adyen_payments` was never written when this fence was built, so a
  //      ledger-only check 404'd every non-service-role caller. AS OF v5.6.96
  //      adyen-webhook DOES populate the ledger (one row per payment, keyed on
  //      the original pspReference, location_id resolved per venue) and history
  //      was backfilled — so the ledger arm below is now the NORMAL hit and
  //      terminal_jobs is the fallback it was always meant to be. Fence logic
  //      unchanged; only this note is updated.
  //   2. THE ID SPACES DIFFER. A POS check records its card leg as
  //      `terminal_jobs.transaction_id`, which adyen-terminal-charge sets to the
  //      POI transaction id (`p.poiTransactionId ?? p.pspReference`). Adyen's
  //      /payments/{psp}/refunds needs the PSP REFERENCE, which rides the
  //      `payment_session_id` column instead. Refunding by the leg id as-is would
  //      call a path Adyen cannot resolve.
  //
  // `terminal_jobs` fixes both: it is written server-side by the settle RPC, it
  // carries location_id (a real per-venue binding), and it holds BOTH ids on the
  // same row so one can be translated into the other. The ledger stays the first
  // authority for when it is eventually populated; terminal_jobs is the fallback,
  // and if NEITHER can vouch for the reference we still fail closed.
  let effectivePsp = psp;
  if (!isServiceRole) {
    const { data: ledger } = await platformAdmin.from('adyen_payments')
      .select('location_id').eq('psp_reference', psp).maybeSingle();
    if (ledger) {
      if (ledger.location_id !== ploc.id) return json({ error: 'payment belongs to a different venue' }, 403);
    } else {
      const { data: job, error: jobErr } = await opsAdmin.from('terminal_jobs')
        .select('payment_session_id, transaction_id, location_id, processor, status')
        .eq('location_id', opsLocationId)
        .or(`transaction_id.eq.${psp},payment_session_id.eq.${psp}`)
        .maybeSingle();
      if (jobErr) console.warn('adyen-modify: terminal_jobs lookup failed —', jobErr.message);
      if (!job) return json({ error: 'unknown payment — no Adyen transaction with that reference at this venue' }, 404);
      if (job.processor !== 'adyen') {
        return json({ error: `that payment was taken on ${job.processor}, not Adyen` }, 409);
      }
      // Prefer the true pspReference; fall back to what the caller sent only when
      // the job never captured one (then Adyen refuses, which is the honest answer).
      effectivePsp = job.payment_session_id || psp;
    }
  }

  const amountMinor = body.amount_minor != null ? Math.round(Number(body.amount_minor)) : null;
  const currency = String(body.currency || 'GBP').toUpperCase();
  const reference = String(body.reference || `${action}:${psp}:${amountMinor ?? 'full'}`).slice(0, 80);
  // v968: the Idempotency-Key is only deterministic when the CALLER supplied a
  // reference (their operation id). A derived (action,psp,amount) key made two
  // legitimate equal-amount refunds collapse into one — the second was silently
  // swallowed by Adyen's replay semantics and no money moved.
  //
  // v5.6.79 — REFUSE an over-long reference instead of truncating it. Adyen caps
  // the Idempotency-Key at 64 chars and `mod:` costs 4, so a caller reference must
  // be ≤ 60. Silently slicing would be worse than useless here: our references end
  // with the distinguishing leg id, so truncation could make two DIFFERENT legs
  // share a key — and Adyen replays the first response for a reused key, so the
  // second leg would report success having moved no money at all.
  if (body.reference && String(body.reference).length > 60) {
    return json({ error: 'reference must be 60 characters or fewer (Adyen Idempotency-Key limit)' }, 400);
  }
  const idempotencyKey = body.reference ? `mod:${reference}` : `mod:${action}:${psp}:${crypto.randomUUID()}`;
  const base = checkoutBase();

  let path: string; let payload: any;
  if (action === 'capture') {
    if (!Number.isFinite(amountMinor)) return json({ error: 'amount_minor required for capture' }, 400);
    path = `/payments/${encodeURIComponent(effectivePsp)}/captures`;
    payload = { merchantAccount: maa.merchant_account, amount: { value: amountMinor, currency }, reference };
  } else if (action === 'refund') {
    if (!Number.isFinite(amountMinor)) return json({ error: 'amount_minor required for refund' }, 400);
    path = `/payments/${encodeURIComponent(effectivePsp)}/refunds`;
    payload = { merchantAccount: maa.merchant_account, amount: { value: amountMinor, currency }, reference };
  } else if (action === 'cancel') {
    path = `/payments/${encodeURIComponent(effectivePsp)}/cancels`;
    payload = { merchantAccount: maa.merchant_account, reference };
  } else { // adjust — bar-tab hold step-up/down to a NEW TOTAL (not a delta)
    if (!Number.isFinite(amountMinor)) return json({ error: 'amount_minor (new total) required for adjust' }, 400);
    path = `/payments/${encodeURIComponent(effectivePsp)}/amountUpdates`;
    payload = { merchantAccount: maa.merchant_account, amount: { value: amountMinor, currency }, industryUsage: 'delayedCharge', reference };
  }

  const res = await adyenFetch('POST', `${base}${path}`, payload, { idempotencyKey });
  if (!res.ok) {
    // Graceful-fallback contract (mirrors stripe-increment-authorization): the
    // caller decides what a refusal means — never a thrown 5xx for a scheme
    // that simply doesn't support the modification.
    return json({ ok: false, error: `adyen ${res.status}`, detail: res.data }, res.status >= 500 ? 502 : 200);
  }
  return json({ ok: true, status: res.data?.status ?? 'received', modification_psp: res.data?.pspReference ?? null, reference });
});
