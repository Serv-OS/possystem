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
import { applyTipToClosedCheck, isOvercaptureRefusal } from '../_shared/tip_capture.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // v5.7.5: 'tip_capture' identifies the payment by `reference` (terminal_captures
  // id OR pspReference), not psp_reference - see the block below the fence.
  // v5.7.8: 'capture_status' is READ ONLY - it identifies by closed_check_id and
  // needs no psp_reference either.
  const isTipCapture = action === 'tip_capture';
  const isCaptureStatus = action === 'capture_status';
  if (!locationId || !['capture', 'cancel', 'refund', 'adjust', 'tip_capture', 'capture_status'].includes(action) || (!isTipCapture && !isCaptureStatus && !psp)) {
    return json({ error: "action ('capture'|'cancel'|'refund'|'adjust'|'tip_capture'|'capture_status'), psp_reference and location_id required" }, 400);
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

  // ── v5.7.8 READ action 'capture_status' ────────────────────────────────────
  // History self-heal: a check that closed through the background reconciler can
  // hold a live terminal_captures row whose leg stamping never reached the
  // closed check, so the till sees no tip window at all. This hands the fenced
  // caller the capture rows for one closed check so the client can re-stamp its
  // in-memory legs. STRICTLY READ ONLY: no writes, no adyenFetch, and the query
  // is pinned to the fenced venue so no cross-venue check id can leak rows.
  if (isCaptureStatus) {
    const closedCheckId = String(body.closed_check_id ?? '').trim();
    if (!closedCheckId) return json({ error: 'closed_check_id required' }, 400);
    const { data: rows, error: qErr } = await opsAdmin.from('terminal_captures')
      .select('id, psp_reference, status, auth_minor, tip_minor, final_minor, deadline_at, error, simulated')
      .eq('closed_check_id', closedCheckId)
      .eq('location_id', opsLocationId)
      .order('created_at', { ascending: true });
    if (qErr) return json({ error: qErr.message }, 500);
    return json({ ok: true, captures: rows ?? [] });
  }

  // ── v5.7.5 TIP ON PRINTED RECEIPT: action 'tip_capture' ────────────────────
  // Applies the tip a guest wrote on the merchant slip to an uncaptured
  // manual-capture authorisation (terminal_captures row), then captures:
  //   tip == 0                 plain capture at the auth amount (close, no tip)
  //   tip <= 20% of auth       ONE direct capture at auth+tip (overcapture -
  //                            Adyen's recommended path, lower scheme fees);
  //                            an enablement-shaped refusal falls back to the
  //                            amountUpdates path automatically, noted in error
  //   tip  > 20% of auth       amountUpdates at the NEW TOTAL (delayedCharge);
  //                            the capture fires from the
  //                            AUTHORISATION_ADJUSTMENT webhook, never here
  // The closed check is updated HERE (tip/total/payment leg), mirroring how the
  // refund path reflects money moves onto the check server-side. This block
  // sits BEFORE the merchant-account requirement so a SIMULATED row (demo
  // venue, possibly no Adyen account) short-circuits without touching Adyen.
  if (isTipCapture) {
    const ref = String(body.reference ?? '').trim();
    const tipMinorRaw = Number(body.tip_minor);
    if (!ref || !Number.isFinite(tipMinorRaw) || !Number.isInteger(tipMinorRaw) || tipMinorRaw < 0 || tipMinorRaw > 100_000_000) {
      return json({ error: 'reference (terminal_captures id or pspReference) and tip_minor (whole minor units, >= 0) required' }, 400);
    }
    const tipMinor = tipMinorRaw;

    let { data: cap, error: capErr } = await opsAdmin.from('terminal_captures')
      .select('*').eq(UUID_RE.test(ref) ? 'id' : 'psp_reference', ref).maybeSingle();
    if (capErr) return json({ error: capErr.message }, 500);
    if (!cap) {
      // REFERENCE HEALING: a client leg may only carry the POI transaction id
      // (terminal_jobs.transaction_id), not the pspReference the capture row is
      // keyed on. Translate via terminal_jobs at THIS venue - the exact same
      // id-space translation the refund path performs below - and retry the
      // capture-row lookup with the true pspReference.
      const { data: healJob } = await opsAdmin.from('terminal_jobs')
        .select('payment_session_id, transaction_id')
        .eq('location_id', opsLocationId)
        .or(`transaction_id.eq.${ref},payment_session_id.eq.${ref}`)
        .maybeSingle();
      const translated = healJob?.payment_session_id || null;
      if (translated && translated !== ref) {
        const retry = await opsAdmin.from('terminal_captures')
          .select('*').eq('psp_reference', translated).maybeSingle();
        if (retry.error) return json({ error: retry.error.message }, 500);
        cap = retry.data ?? null;
      }
    }
    if (!cap) return json({ error: 'no tip window found for that reference' }, 404);
    if (String(cap.location_id) !== String(opsLocationId)) {
      // Fail closed: the row is real but belongs to another venue.
      return json({ error: 'that payment belongs to a different venue' }, 403);
    }
    if (['captured', 'cancelled', 'expired'].includes(cap.status)) {
      return json({ ok: false, error: `tip window closed - payment already ${cap.status}`, status: cap.status, capture_id: cap.id }, 409);
    }
    if (['adjusting', 'capturing'].includes(cap.status)) {
      return json({ ok: false, error: 'a tip is already being applied to this payment', status: cap.status, capture_id: cap.id }, 409);
    }
    // status is 'pending' (or 'failed' - a retry after an honest failure).

    const auth = Number(cap.auth_minor);
    const finalMinor = auth + tipMinor;
    const capCurrency = String(cap.currency || body.currency || 'USD').toUpperCase();
    const done = (extra: Record<string, unknown>) => json({
      ok: true, capture_id: cap.id, psp_reference: cap.psp_reference,
      auth_minor: auth, tip_minor: tipMinor, final_minor: finalMinor,
      deadline_at: cap.deadline_at, ...extra,
    });

    // SIMULATED (demo) rows: settle the whole thing locally. This return is
    // unconditional, so no simulated row can ever reach adyenFetch.
    if (cap.simulated === true) {
      const { data: simDone } = await opsAdmin.from('terminal_captures')
        .update({ status: 'captured', tip_minor: tipMinor, final_minor: finalMinor, error: null, updated_at: new Date().toISOString() })
        .eq('id', cap.id).in('status', ['pending', 'failed']).select('id').maybeSingle();
      if (!simDone) return json({ ok: false, error: 'tip window changed underneath - reload and try again' }, 409);
      await applyTipToClosedCheck(opsAdmin, {
        closedCheckId: cap.closed_check_id, captureId: cap.id, psp: cap.psp_reference,
        tipMinor, legFlag: 'captured',
      });
      return done({ mode: 'simulated', status: 'captured' });
    }

    // Real rows need a merchant account (stored at auth, else the venue's).
    let merchant = (cap.merchant_account as string | null) ?? null;
    if (!merchant) {
      const { data: maa0 } = await platformAdmin.from('merchant_adyen_accounts')
        .select('merchant_account').eq('location_id', ploc.id).maybeSingle();
      merchant = maa0?.merchant_account ?? null;
    }
    if (!merchant) return json({ error: 'venue has no Adyen account' }, 409);
    const base = checkoutBase();

    // tip > 20 percent of auth => the schemes call it a fresh risk decision -
    // amountUpdates first, capture only after the webhook confirms.
    const wantAdjust = tipMinor > 0 && tipMinor * 5 > auth;

    // CAS-claim the row BEFORE any network call - two concurrent tip entries
    // can never both reach Adyen. Losing the race is a 409, not a double move.
    // attempts is the CAS token AND the idempotency-key salt: a retry after an
    // honest failure claims a NEW attempt number, so its Adyen key is fresh
    // (never a replay of the stale first response), while a retransmit of the
    // SAME attempt keeps the same key and replays harmlessly.
    const prevAttempts = Number(cap.attempts ?? 0);
    const attempt = prevAttempts + 1;
    const { data: claimed } = await opsAdmin.from('terminal_captures')
      .update({
        status: wantAdjust ? 'adjusting' : 'capturing', attempts: attempt,
        tip_minor: tipMinor, final_minor: finalMinor, updated_at: new Date().toISOString(),
      })
      .eq('id', cap.id).eq('status', cap.status).eq('attempts', prevAttempts)
      .select('id').maybeSingle();
    if (!claimed) return json({ ok: false, error: 'tip window changed underneath - reload and try again' }, 409);

    // On a definitive refusal the row goes BACK to pending (with the reason),
    // and the money fields are cleared so the deadline sweep still captures at
    // the plain auth amount - the sale is never lost to a failed tip attempt.
    const revert = async (err: string) => {
      await opsAdmin.from('terminal_captures')
        .update({ status: 'pending', tip_minor: null, final_minor: null, error: err.slice(0, 500), updated_at: new Date().toISOString() })
        .eq('id', cap.id).in('status', ['adjusting', 'capturing']);
    };

    if (!wantAdjust) {
      // Direct capture at auth + tip (tip 0 = plain capture at auth).
      const res = await adyenFetch('POST', `${base}/payments/${encodeURIComponent(cap.psp_reference)}/captures`,
        { merchantAccount: merchant, amount: { value: finalMinor, currency: capCurrency }, reference: `tipcap:${cap.id}`.slice(0, 80) },
        { idempotencyKey: `tipcap:${cap.id}:${finalMinor}:${attempt}` });
      if (res.ok) {
        if (tipMinor > 0) {
          await applyTipToClosedCheck(opsAdmin, {
            closedCheckId: cap.closed_check_id, captureId: cap.id, psp: cap.psp_reference,
            tipMinor, legFlag: 'capturing',
          });
        } else {
          await applyTipToClosedCheck(opsAdmin, {
            closedCheckId: cap.closed_check_id, captureId: cap.id, psp: cap.psp_reference,
            tipMinor: 0, legFlag: 'capturing',
          });
        }
        return done({ mode: tipMinor === 0 ? 'capture_no_tip' : 'direct_capture', status: 'capturing' });
      }
      if (res.status >= 500) {
        await revert(`adyen ${res.status} on capture - retry`);
        return json({ ok: false, error: `adyen ${res.status}`, detail: res.data }, 502);
      }
      if (tipMinor > 0 && isOvercaptureRefusal(res.status, res.data)) {
        // Overcapture not enabled on the account (or the amount rule bit) -
        // fall back to the adjust path automatically and say so in error.
        const note = `overcapture capture refused (adyen ${res.status}) - fell back to amountUpdates: ${JSON.stringify(res.data).slice(0, 200)}`;
        const adj = await adyenFetch('POST', `${base}/payments/${encodeURIComponent(cap.psp_reference)}/amountUpdates`,
          { merchantAccount: merchant, amount: { value: finalMinor, currency: capCurrency }, industryUsage: 'delayedCharge', reference: `tipadj:${cap.id}`.slice(0, 80) },
          // amountUpdates keys must be unique per attempt (Adyen replays the
          // first response for a reused key - the hold_increase lesson). The
          // attempts salt gives exactly that, deterministically.
          { idempotencyKey: `tipadj:${cap.id}:${finalMinor}:${attempt}` });
        if (adj.ok) {
          await opsAdmin.from('terminal_captures')
            .update({ status: 'adjusting', error: note, updated_at: new Date().toISOString() })
            .eq('id', cap.id).eq('status', 'capturing');
          await applyTipToClosedCheck(opsAdmin, {
            closedCheckId: cap.closed_check_id, captureId: cap.id, psp: cap.psp_reference,
            tipMinor, legFlag: 'adjusting',
          });
          return done({ mode: 'adjust_fallback', status: 'adjusting', note });
        }
        await revert(`${note}; adjust also refused (adyen ${adj.status}): ${JSON.stringify(adj.data).slice(0, 200)}`);
        return json({ ok: false, error: `adyen ${adj.status}`, detail: adj.data }, adj.status >= 500 ? 502 : 200);
      }
      await revert(`capture refused (adyen ${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
      return json({ ok: false, error: `adyen ${res.status}`, detail: res.data }, 200);
    }

    // tip > 20 percent: amountUpdates at the NEW TOTAL. ASYNC - the
    // AUTHORISATION_ADJUSTMENT webhook kicks the capture on success.
    const adj = await adyenFetch('POST', `${base}/payments/${encodeURIComponent(cap.psp_reference)}/amountUpdates`,
      { merchantAccount: merchant, amount: { value: finalMinor, currency: capCurrency }, industryUsage: 'delayedCharge', reference: `tipadj:${cap.id}`.slice(0, 80) },
      { idempotencyKey: `tipadj:${cap.id}:${finalMinor}:${attempt}` });
    if (!adj.ok) {
      await revert(`adjust refused (adyen ${adj.status}): ${JSON.stringify(adj.data).slice(0, 300)}`);
      return json({ ok: false, error: `adyen ${adj.status}`, detail: adj.data }, adj.status >= 500 ? 502 : 200);
    }
    await applyTipToClosedCheck(opsAdmin, {
      closedCheckId: cap.closed_check_id, captureId: cap.id, psp: cap.psp_reference,
      tipMinor, legFlag: 'adjusting',
    });
    return done({ mode: 'adjust', status: 'adjusting' });
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

  // v5.7.5 REFUND GUARD: a card whose tip window is still open (manual-capture
  // auth not yet captured) cannot be refunded - there is nothing captured to
  // refund yet, and racing the capture would strand money. Close the window
  // first (add the tip, close with no tip, or let the sweep capture), then
  // refund normally. Fails closed only when a live capture row exists.
  if (action === 'refund') {
    const refs = [...new Set([psp, effectivePsp].filter(Boolean))];
    const { data: openCap } = await opsAdmin.from('terminal_captures')
      .select('id, status').in('psp_reference', refs)
      .in('status', ['pending', 'adjusting', 'capturing'])
      .limit(1).maybeSingle();
    if (openCap) {
      return json({
        ok: false,
        error: 'Tip window open for this card. Add the tip or close it with no tip first.',
        code: 'TIP_WINDOW_OPEN',
        capture_id: openCap.id,
        capture_status: openCap.status,
      }, 409);
    }
  }

  const amountMinor = body.amount_minor != null ? Math.round(Number(body.amount_minor)) : null;
  // v5.7.82: a refund MUST be in the currency the payment was taken in. Falling
  // back to GBP silently refunded US dollar sales as pounds, which Adyen either
  // refuses or, worse, processes at the wrong value. The original payment is the
  // only authority; the caller's value is honoured only when it agrees, and the
  // GBP default now applies solely when nothing else is known.
  let currency = String(body.currency || '').toUpperCase();
  if (!currency) {
    const { data: paid } = await platformAdmin.from('adyen_payments')
      .select('currency').eq('psp_reference', psp).maybeSingle();
    currency = String(paid?.currency || '').toUpperCase();
  }
  if (!currency) {
    console.warn(`adyen-modify: no currency known for ${psp}, defaulting to GBP`);
    currency = 'GBP';
  }
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
  // v5.7.5: a cancelled (voided) manual-capture auth closes its tip window for
  // good - the sweep must never try to capture a payment that no longer exists.
  // Only ever from an OPEN state (pending/adjusting/failed); a 'captured' row
  // stays captured (money moved - a cancel after capture is Adyen's problem to
  // refuse, not ours to mask), and 'capturing' stays so the webhook settles it.
  if (action === 'cancel') {
    const cancelRefs = [...new Set([psp, effectivePsp].filter(Boolean))];
    const { error: ccErr } = await opsAdmin.from('terminal_captures')
      .update({ status: 'cancelled', error: 'payment cancelled - tip window closed', updated_at: new Date().toISOString() })
      .in('psp_reference', cancelRefs)
      .in('status', ['pending', 'adjusting', 'failed']);
    if (ccErr) console.error('adyen-modify: cancel could not close the capture row -', ccErr.message);
  }
  return json({ ok: true, status: res.data?.status ?? 'received', modification_psp: res.data?.pspReference ?? null, reference });
});
