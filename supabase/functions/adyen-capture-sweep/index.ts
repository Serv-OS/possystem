// supabase/functions/adyen-capture-sweep
//
// v5.7.5 TIP ON PRINTED RECEIPT - the safety net. Four nets in one pass:
//
//   1. 'pending'/'adjusting' past deadline_at - the classic deadline sweep:
//      capture at final_minor ?? auth_minor. A forgotten tip loses the TIP,
//      never the SALE - the same morning-sweep behaviour every vendor
//      (Lightspeed, Toast) ships.
//   2. 'failed' past deadline_at - a CAPTURE_FAILED webhook reverted the tip
//      and nobody retried from History: capture the plain auth so the sale
//      still lands. (If the tip somehow never came off the closed check, it
//      comes off here first - exactly once, gated by the CAS claim.)
//   3. 'capturing' whose updated_at is older than 45 minutes - a stranded
//      claim (crashed function, lost webhook): re-attempt with a FRESH
//      attempts-salted key. An "already captured" refusal counts as SUCCESS -
//      default merchant accounts are single-capture, so that refusal is proof
//      the earlier request landed.
//   4. An 'adjusting' row whose capture at the INFLATED amount is refused
//      (not dead) retries ONCE at the plain auth, reverts the tip off the
//      closed check, and settles at auth - never a forever-loop on an amount
//      the account will keep refusing.
//
// Card scheme reality: a restaurant auth can die in as little as 5 days
// (Visa), Amex 7, Adyen hard-expires at 28 - the venue window is 1..72 hours,
// so this sweep always runs long before any of those.
//
// CAS DISCIPLINE (shared with adyen-modify tip_capture and adyen-webhook's
// post-adjust kick): read the row, then claim it with
// update(status:'capturing', attempts: read+1).eq(status, read).eq(attempts,
// read) BEFORE any Adyen call - zero rows updated means another claimant won
// and this row is skipped. Every Adyen Idempotency-Key carries the attempts
// number, so a RETRY is always a fresh key while a retransmit replays.
//
// Called by pg_cron every 30 minutes (migration 20260823_tip_on_receipt.sql)
// via net.http_post with the x-sweep-token header. Also callable manually with
// the service-role bearer. Optional body { location_id } narrows to one venue.
//
// Per-row try/catch: one bad row records its error and the sweep moves on -
// this function never throws the whole batch away. A THROWN Adyen fetch
// restores the row to its pre-claim status (with the error text), so a
// network abort can never strand a row at 'capturing'.
//
// 'cancelled' / 'captured' / 'expired' rows are never selected - final states
// stay final (a voided sale must never be captured by the safety net).
//
// ⚠ DEPLOY ME (edge fns deploy manually and drift silently):
//   npx supabase functions deploy adyen-capture-sweep --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
// And set the shared secret (same value the migration hardcodes in the cron job):
//   npx supabase secrets set ADYEN_SWEEP_TOKEN=<token> --project-ref tbetcegmszzotrwdtqhi

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adyenConfigured, checkoutBase, adyenFetch } from '../_shared/adyen.ts';
import { applyTipToClosedCheck } from '../_shared/tip_capture.ts';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SWEEP_TOKEN = Deno.env.get('ADYEN_SWEEP_TOKEN') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// A row stuck at 'capturing' longer than this is a stranded claim, not an
// in-flight capture (the whole claim->capture round trip is seconds).
const STALE_CAPTURING_MS = 45 * 60_000;

// Refusal classifiers, checked in this order: "already captured" FIRST (it is
// success in disguise on single-capture accounts, and its wording can also
// trip the dead-auth patterns), then "auth provably dead".
const isAlreadyCaptured = (bodyText: string) =>
  /already (been )?captur|previously captur|has been captured|already processed/i.test(bodyText);
const isDeadAuth = (bodyText: string) =>
  /expire|no longer|too old|cannot be captured/i.test(bodyText);

// Resolve the venue's merchant account when the row does not carry one.
async function merchantFor(opsLocationId: string): Promise<string | null> {
  try {
    const { data: ploc } = await platformAdmin.from('locations')
      .select('id').eq('ops_location_id', opsLocationId).maybeSingle();
    const { data: maa } = await platformAdmin.from('merchant_adyen_accounts')
      .select('merchant_account').eq('location_id', ploc?.id ?? opsLocationId).maybeSingle();
    return maa?.merchant_account ?? null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // AUTH: the pg_cron shared secret, or the service role. Nothing else.
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  const sweepHeader = (req.headers.get('x-sweep-token') ?? '').trim();
  const okBearer = !!SERVICE_ROLE && bearer === SERVICE_ROLE;
  const okToken = !!SWEEP_TOKEN && sweepHeader === SWEEP_TOKEN;
  if (!okBearer && !okToken) return json({ error: 'unauthorized' }, 401);

  let body: { location_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const locationId = body?.location_id ? String(body.location_id) : null;

  const counts = {
    scanned: 0, captured_simulated: 0, capture_requested: 0,
    rescued_failed: 0, rescued_capturing: 0, captured_already: 0,
    auth_fallback: 0, skipped: 0, errors: 0,
  };
  const errors: { id: string; error: string }[] = [];

  const sweepStart = new Date();
  const staleIso = new Date(sweepStart.getTime() - STALE_CAPTURING_MS).toISOString();
  let q = opsAdmin.from('terminal_captures')
    .select('*')
    .or(`and(status.in.(pending,adjusting,failed),deadline_at.lt.${sweepStart.toISOString()}),and(status.eq.capturing,updated_at.lt.${staleIso})`)
    .order('deadline_at', { ascending: true })
    .limit(200);
  if (locationId) q = q.eq('location_id', locationId);
  const { data: rows, error: qErr } = await q;
  if (qErr) return json({ ok: false, error: qErr.message }, 500);

  for (const row of rows ?? []) {
    counts.scanned++;
    const prevStatus = String(row.status);
    const prevAttempts = Number(row.attempts ?? 0);
    const attempt = prevAttempts + 1;
    try {
      const cur = String(row.currency || 'USD').toUpperCase();
      const authMinor = Number(row.auth_minor);
      // 'failed' rows capture the PLAIN AUTH (the tip was reverted when the
      // capture failed); everything else captures final_minor ?? auth_minor.
      const amount = prevStatus === 'failed' ? authMinor : Number(row.final_minor ?? row.auth_minor);

      // SIMULATED rows settle locally - nothing may ever reach Adyen.
      if (row.simulated === true) {
        const { data: done } = await opsAdmin.from('terminal_captures')
          .update({ status: 'captured', final_minor: amount, updated_at: new Date().toISOString() })
          .eq('id', row.id).eq('status', prevStatus).eq('attempts', prevAttempts)
          .select('id').maybeSingle();
        if (done) {
          counts.captured_simulated++;
          await applyTipToClosedCheck(opsAdmin, {
            closedCheckId: row.closed_check_id, captureId: row.id, psp: row.psp_reference,
            tipMinor: 0, legFlag: 'captured',
          });
        } else counts.skipped++;
        continue;
      }

      if (!adyenConfigured()) {
        counts.errors++; errors.push({ id: row.id, error: 'Adyen not configured' });
        continue;
      }
      const merchant = (row.merchant_account as string | null) ?? await merchantFor(row.location_id);
      if (!merchant) {
        counts.errors++; errors.push({ id: row.id, error: 'no merchant account' });
        await opsAdmin.from('terminal_captures')
          .update({ error: 'sweep: no merchant account for venue', updated_at: new Date().toISOString() }).eq('id', row.id);
        continue;
      }

      // CAS-claim BEFORE the network call (see the header): losing the race
      // means the webhook kick, a History retry, or another sweep owns this
      // row. A 'failed' claim also normalises the money fields to plain auth.
      const claimPatch: Record<string, unknown> = {
        status: 'capturing', attempts: attempt, final_minor: amount, updated_at: new Date().toISOString(),
      };
      if (prevStatus === 'failed') claimPatch.tip_minor = null;
      const { data: claimed } = await opsAdmin.from('terminal_captures')
        .update(claimPatch)
        .eq('id', row.id).eq('status', prevStatus).eq('attempts', prevAttempts)
        .select('id').maybeSingle();
      if (!claimed) { counts.skipped++; continue; }

      // 'failed' rescue: if the tip somehow never came back OFF the closed
      // check (the webhook's revert lost to a crash - tip_minor still set is
      // the tell), take it off now. Exactly once: only the claim winner runs
      // this, and the claim just cleared tip_minor.
      if (prevStatus === 'failed' && Number(row.tip_minor ?? 0) > 0) {
        await applyTipToClosedCheck(opsAdmin, {
          closedCheckId: row.closed_check_id, captureId: row.id, psp: row.psp_reference,
          tipMinor: -Number(row.tip_minor), legFlag: 'capturing',
          tipError: String(row.error ?? 'capture failed - tip reverted by sweep').slice(0, 300),
        });
      }

      // A THROWN fetch restores the row to its pre-claim status with the
      // error recorded - a network abort must never strand it at 'capturing'.
      const restore = async (msg: string) => {
        await opsAdmin.from('terminal_captures')
          .update({ status: prevStatus, error: `sweep: ${msg}`.slice(0, 500), updated_at: new Date().toISOString() })
          .eq('id', row.id).eq('status', 'capturing').eq('attempts', attempt);
      };

      let res;
      try {
        res = await adyenFetch('POST',
          `${checkoutBase()}/payments/${encodeURIComponent(row.psp_reference)}/captures`,
          { merchantAccount: merchant, amount: { value: amount, currency: cur }, reference: `sweep:${row.id}`.slice(0, 80) },
          { idempotencyKey: `sweep:${row.id}:${amount}:${attempt}` });
      } catch (fe) {
        const msg = (fe as Error).message;
        counts.errors++; errors.push({ id: row.id, error: msg });
        await restore(msg);
        continue;
      }

      if (res.ok) {
        counts.capture_requested++;   // ASYNC - the CAPTURE webhook settles the row to 'captured'
        if (prevStatus === 'failed') counts.rescued_failed++;
        if (prevStatus === 'capturing') counts.rescued_capturing++;
        await applyTipToClosedCheck(opsAdmin, {
          closedCheckId: row.closed_check_id, captureId: row.id, psp: row.psp_reference,
          tipMinor: 0, legFlag: 'capturing',
        });
        continue;
      }

      const bodyText = JSON.stringify(res.data ?? {});
      const detail = `sweep capture refused (adyen ${res.status}): ${bodyText.slice(0, 300)}`;

      if (isAlreadyCaptured(bodyText)) {
        // Success in disguise: the payment IS captured (an earlier request
        // landed; only its response/webhook was lost). Settle the row.
        counts.captured_already++;
        await opsAdmin.from('terminal_captures')
          .update({ status: 'captured', error: detail, updated_at: new Date().toISOString() })
          .eq('id', row.id).eq('status', 'capturing');
        await applyTipToClosedCheck(opsAdmin, {
          closedCheckId: row.closed_check_id, captureId: row.id, psp: row.psp_reference,
          tipMinor: 0, legFlag: 'captured',
        });
        continue;
      }

      if (isDeadAuth(bodyText)) {
        // Auth provably dead => 'expired' (visible, final).
        await opsAdmin.from('terminal_captures')
          .update({ status: 'expired', error: detail, updated_at: new Date().toISOString() })
          .eq('id', row.id).eq('status', 'capturing');
        counts.errors++; errors.push({ id: row.id, error: detail });
        continue;
      }

      // An 'adjusting' row refused at the INFLATED amount: retry ONCE at the
      // plain auth, revert the tip off the closed check, settle at auth with
      // the refusal on record - never loop forever on an amount the account
      // will keep refusing.
      if (prevStatus === 'adjusting' && amount !== authMinor) {
        let res2;
        try {
          res2 = await adyenFetch('POST',
            `${checkoutBase()}/payments/${encodeURIComponent(row.psp_reference)}/captures`,
            { merchantAccount: merchant, amount: { value: authMinor, currency: cur }, reference: `sweep:${row.id}`.slice(0, 80) },
            { idempotencyKey: `sweep:${row.id}:${authMinor}:${attempt}` });
        } catch (fe) {
          const msg = `${detail}; auth retry threw: ${(fe as Error).message}`;
          counts.errors++; errors.push({ id: row.id, error: msg });
          await restore(msg);
          continue;
        }
        const body2 = JSON.stringify(res2.data ?? {});
        if (res2.ok || isAlreadyCaptured(body2)) {
          counts.auth_fallback++;
          const tip = Number(row.tip_minor ?? 0);
          const note = `${detail}; captured the plain auth instead - tip NOT charged`;
          await opsAdmin.from('terminal_captures')
            .update({ status: 'captured', final_minor: authMinor, tip_minor: null, error: note.slice(0, 500), updated_at: new Date().toISOString() })
            .eq('id', row.id).eq('status', 'capturing');
          await applyTipToClosedCheck(opsAdmin, {
            closedCheckId: row.closed_check_id, captureId: row.id, psp: row.psp_reference,
            tipMinor: tip > 0 ? -tip : 0, legFlag: 'captured', tipError: note.slice(0, 300),
          });
          continue;
        }
        const detail2 = `${detail}; auth retry also refused (adyen ${res2.status}): ${body2.slice(0, 200)}`;
        await opsAdmin.from('terminal_captures')
          .update({ status: isDeadAuth(body2) ? 'expired' : prevStatus, error: detail2.slice(0, 500), updated_at: new Date().toISOString() })
          .eq('id', row.id).eq('status', 'capturing');
        counts.errors++; errors.push({ id: row.id, error: detail2 });
        continue;
      }

      // Anything else goes back to its previous bucket so the next sweep
      // retries with a fresh attempts-salted key.
      await opsAdmin.from('terminal_captures')
        .update({ status: prevStatus, error: detail, updated_at: new Date().toISOString() })
        .eq('id', row.id).eq('status', 'capturing');
      counts.errors++;
      errors.push({ id: row.id, error: detail });
    } catch (e) {
      counts.errors++;
      const msg = (e as Error).message;
      errors.push({ id: row.id, error: msg });
      // Best-effort un-strand: if this row holds a fresh claim, put it back.
      await opsAdmin.from('terminal_captures')
        .update({ status: prevStatus, error: `sweep: ${msg}`.slice(0, 500), updated_at: new Date().toISOString() })
        .eq('id', row.id).eq('status', 'capturing').eq('attempts', attempt)
        .then(() => {}, () => {});
    }
  }

  return json({ ok: true, ...counts, errors: errors.slice(0, 20) });
});
