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
// v5.6.96 — FINANCIAL SERVICES PHASE 1: the receiver now also PARSES money
// events into the platform ledger (`adyen_payments`, one row per payment keyed
// on the ORIGINAL pspReference) and chargebacks into `merchant_adyen_disputes`,
// so per-venue payment + dispute reports have server truth to read. Parsing is
// best-effort ON TOP of the stored raw event — a parse bug can never lose an
// event, only delay its ledger row until a replay.
//
// v5.6.99 — FINANCIAL SERVICES PHASE 2: REPORT_AVAILABLE notifications are
// queued durably into platform `adyen_reports` and adyen-report-ingest is
// kicked to download + parse the Settlement details CSV (fees, payouts,
// payout lines). See queueReport below.
//
// v5.7.3 — TIERED PRICING: every AUTHORISATION is classified into one of the
// four pricing tiers (card_present / card_not_present / amex / keyed — see
// classifyRateCategory) and stamped with rate_category + commission_minor
// (the venue's resolved tier rate applied to the amount). Both recompute on
// every apply, so the backfill re-stamps them idempotently.
//
// BACKFILL: POST .../adyen-webhook?backfill=1 with a SERVICE-ROLE bearer reruns
// every stored adyen_events row (received_at order) through the same parsing
// path. Idempotent by construction (see modKey below); also re-classifies and
// re-stamps commission on every payment. Add &dry=1 to only count
// what it would process.
//
// SECURITY, staged deliberately:
//   - Basic auth: if ADYEN_WEBHOOK_USER/_PASS secrets are set, requests must
//     match (Adyen sends the credentials you configure on the webhook).
//   - HMAC (ADYEN_HMAC_KEY): verified per-item via _shared/adyen.ts
//     verifyNotificationItem (same signing recipe this file used to inline).
//     We VERIFY AND RECORD hmac_valid on every item but do NOT reject yet —
//     ⚠ GO-LIVE TASK: flip REJECT_INVALID_HMAC to true once real test events
//     verify green. Until then an invalid signature is logged LOUDLY below.
//     Never guess-reject during setup: a wrong signing recipe would silently
//     drop every payment notification.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyNotificationItem, cardFromWebhookAdditionalData, resolveAdyenRateCard, commissionForAmount, adyenFetch, checkoutBase } from '../_shared/adyen.ts';
import { insertCaptureRow, applyTipToClosedCheck } from '../_shared/tip_capture.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const HMAC_KEY = Deno.env.get('ADYEN_HMAC_KEY') ?? '';
const BASIC_USER = Deno.env.get('ADYEN_WEBHOOK_USER') ?? '';
const BASIC_PASS = Deno.env.get('ADYEN_WEBHOOK_PASS') ?? '';
// ARMED 19 Aug (was the go-live task): 51/51 signed events in adyen_events
// verified hmac_valid=true with the shared recipe, so a bad signature is now an
// attack or a key rotation, not a setup doubt — and either must bounce.
const REJECT_INVALID_HMAC = true;   // ⚠ arm before LIVE, after test events verify green

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// The payments ledger + dispute queue live in the PLATFORM DB (20260801_PLATFORM_adyen_foundation.sql).
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// null = unverifiable (no key configured / item carries no signature) — kept
// distinct from false so adyen_events.hmac_valid preserves the old semantics.
async function hmacOk(item: any): Promise<boolean | null> {
  if (!HMAC_KEY) return null;
  if (!item?.additionalData?.hmacSignature) return null;
  try { return await verifyNotificationItem(item, HMAC_KEY); }
  catch (e) { console.error('[adyen-webhook] hmac check failed:', (e as Error).message); return false; }
}

// ── Money-event parsing → adyen_payments / merchant_adyen_disputes ──────────
//
// ONE ledger row per PAYMENT, keyed on the original payment's pspReference.
// Modification events (capture/refund/cancel/chargeback…) carry the parent in
// originalReference — they PATCH the parent's row, never mint a sibling.
//
// IDEMPOTENCY: every modification event is identified by
//   modKey = `${eventCode}:${item.pspReference}:${item.success}`
// (each Adyen modification has its OWN pspReference, so two partial refunds
// never share a key while a redelivery of the same refund always does). Keys
// already present in raw.applied_modifications are skipped, which is what makes
// the REFUND `amount_refunded_minor` increment replay-safe and lets the
// backfill rerun the entire event history without double counting.
// AUTHORISATION needs no key, but its re-apply is NOT a plain rewrite: it must
// never shrink a tip-bumped amount (capBumped guard) and never erase a
// successful cancel (wasCancelled guard). Together with the duplicate-CAPTURE
// re-raise above, that pair is what makes ?backfill=1 genuinely idempotent.
//
// KNOWN NARROW RACE: two CONCURRENT deliveries of the SAME refund could both
// read the row before either writes. Adyen retries minutes apart and per-venue
// event rates are low, so this is accepted for Phase 1 (same stance as
// ryft-webhook's delta narrowing).

const PAYMENT_EVENTS = new Set(['AUTHORISATION']);
const MODIFICATION_EVENTS = new Set([
  'CAPTURE', 'CAPTURE_FAILED', 'CANCELLATION', 'REFUND', 'REFUND_FAILED',
  'CHARGEBACK', 'CHARGEBACK_REVERSED', 'NOTIFICATION_OF_CHARGEBACK',
  'SECOND_CHARGEBACK', 'REQUEST_FOR_INFORMATION',
  // v5.7.5 tip-on-receipt: the async outcome of a /amountUpdates tip adjust.
  // On success the capture is kicked from here (see applyTipOnReceiptEvent).
  'AUTHORISATION_ADJUSTMENT',
]);
const CHARGEBACK_EVENTS = new Set([
  'CHARGEBACK', 'CHARGEBACK_REVERSED', 'NOTIFICATION_OF_CHARGEBACK',
  'SECOND_CHARGEBACK', 'REQUEST_FOR_INFORMATION',
]);
export const LEDGER_EVENTS = new Set([...PAYMENT_EVENTS, ...MODIFICATION_EVENTS]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the venue (PLATFORM location id) for a notification item.
//   1. additionalData.store → merchant_adyen_accounts.store_id (terminal
//      payments send `store=<store_id>` in SaleToAcquirerData, and Adyen echoes
//      it back on the webhook — the strongest signal).
//   2. merchantAccountCode → merchant_adyen_accounts.merchant_account, but ONLY
//      when exactly one venue uses that account (under AfP every venue shares
//      the regional merchant account, so a multi-venue match is ambiguous).
//   3. a matched terminal_jobs row's OPS location → platform locations.ops_location_id.
// Unresolvable → location_id stays null: the payment still exists in the ledger
// and a later backfill replay re-resolves it (the upsert recomputes every time).
async function resolveLocation(item: any, jobOpsLocationId: string | null): Promise<string | null> {
  try {
    const store = item?.additionalData?.store ? String(item.additionalData.store) : '';
    if (store) {
      const { data, error } = await platformAdmin.from('merchant_adyen_accounts')
        .select('location_id').eq('store_id', store).maybeSingle();
      if (error) console.error('[adyen-webhook] store lookup failed:', error.message);
      if (data?.location_id) return data.location_id;
    }
    const merchant = item?.merchantAccountCode ? String(item.merchantAccountCode) : '';
    if (merchant) {
      const { data, error } = await platformAdmin.from('merchant_adyen_accounts')
        .select('location_id').eq('merchant_account', merchant).limit(2);
      if (error) console.error('[adyen-webhook] merchant lookup failed:', error.message);
      if (Array.isArray(data) && data.length === 1 && data[0]?.location_id) return data[0].location_id;
    }
    if (jobOpsLocationId) {
      const { data, error } = await platformAdmin.from('locations')
        .select('id').eq('ops_location_id', jobOpsLocationId).maybeSingle();
      if (error) console.error('[adyen-webhook] ops→platform lookup failed:', error.message);
      if (data?.id) return data.id;
    }
  } catch (e) { console.error('[adyen-webhook] resolveLocation:', (e as Error).message); }
  return null;
}

// Best-effort OPS lookup: the terminal job this payment settled (POS card leg).
// merchantReference `tj-<job id>` is stamped by adyen-terminal-charge at
// dispatch; payment_session_id carries the pspReference after settle.
async function matchTerminalJob(merchantReference: string, paymentPsp: string):
  Promise<{ id: string; closed_check_id: string | null; location_id: string | null; capture_mode?: string | null } | null> {
  try {
    if (merchantReference.startsWith('tj-')) {
      const jobId = merchantReference.slice(3);
      if (UUID_RE.test(jobId)) {
        const { data } = await admin.from('terminal_jobs')
          .select('id, closed_check_id, location_id, capture_mode').eq('id', jobId).maybeSingle();
        if (data?.id) return data;
      }
    }
    if (paymentPsp) {
      const { data } = await admin.from('terminal_jobs')
        .select('id, closed_check_id, location_id, capture_mode').eq('payment_session_id', paymentPsp).maybeSingle();
      if (data?.id) return data;
    }
  } catch (e) { console.error('[adyen-webhook] terminal_jobs match:', (e as Error).message); }
  return null;
}

function inferChannel(merchantReference: string, hasJob: boolean): string | null {
  if (merchantReference.startsWith('bkpay-')) return 'booking';
  if (merchantReference.startsWith('OL-')) return 'online';   // online-shop orders (v5.7.3)
  if (hasJob || merchantReference.startsWith('tj-') || merchantReference.startsWith('tabhold-')) return 'pos';
  return null;
}

// Postgres 42703 (column does not exist) — the rate-card columns until
// migration 20260821b_adyen_rate_card.sql is hand-applied. The ledger write
// retries without them; the rate reads retry without rate_card.
const isMissingColumn = (msg: unknown) => /does not exist|42703/i.test(String(msg ?? ''));

// ── v5.7.3 payment-type classification → adyen_payments.rate_category ───────
//
// Keyed on the fields REAL stored events carry (inspected in ops adyen_events,
// 19 Aug 2026 — 44 stored AUTHORISATIONs):
//   · every item: top-level paymentMethod ('visa') + additionalData
//     { paymentMethod, cardSummary, authCode, expiryDate, networkTxReference }
//   · TERMINAL payments (tj-/tabhold- refs) additionally carry
//     additionalData.paymentMethodVariant ('visa' on the test cards; business
//     cards arrive as variants like visacommercialcredit / visacorporate /
//     visabusiness / mccorporate)
//   · ECOMMERCE payments (OL-/bkpay- refs) additionally carry
//     additionalData['checkout.cardAddedBrand'], isCardCommercial ('unknown'
//     on the test cards), issuerCountry and threeds2.cardEnrolled — none of
//     which appear on terminal payments
//   · NO stored event carries shopperInteraction, posEntryMode, fundingSource
//     or store in additionalData — so the channel signal is the ledger channel
//     (merchantReference prefix) plus the ecommerce-only additionalData keys.
//     shopperInteraction/posEntryMode stay in as belt-and-braces for events
//     that may carry them later (e.g. a future MOTO flow).
//
// Priority: amex/business outranks channel (Amex is its own fee wherever the
// card is used), keyed outranks card_not_present (MOTO is ecommerce-shaped at
// Adyen), card_present is the default for POS/terminal payments.
function classifyRateCategory(item: any, channel: string | null): string {
  const ad = item?.additionalData ?? {};
  const brand = String(ad.paymentMethod ?? item?.paymentMethod ?? '').toLowerCase();
  const variant = String(ad.paymentMethodVariant ?? '').toLowerCase();
  const added = String(ad['checkout.cardAddedBrand'] ?? '').toLowerCase();
  if (brand.includes('amex') || variant.includes('amex') || added.includes('amex')) return 'amex';
  const commercial = String(ad.isCardCommercial ?? '').toLowerCase();
  if (commercial === 'true' || commercial === 'yes') return 'amex';
  if (/(business|corporate|commercial|purchasing|fleet)/.test(variant)) return 'amex';
  const si = String(ad.shopperInteraction ?? item?.shopperInteraction ?? '').toLowerCase();
  if (si === 'moto') return 'keyed';
  const entry = String(ad.posEntryMode ?? '').toLowerCase();
  if (entry.includes('key') || entry.includes('manual')) return 'keyed';
  const ch = String(channel ?? '').toLowerCase();
  if (['online', 'booking', 'qr', 'gift', 'web', 'ecommerce'].includes(ch)) return 'card_not_present';
  if (si === 'ecommerce') return 'card_not_present';
  if ('checkout.cardAddedBrand' in ad || 'threeds2.cardEnrolled' in ad || 'isCardCommercial' in ad || 'scaExemptionRequested' in ad) return 'card_not_present';
  return 'card_present';
}

// Venue tier rates, cached briefly so the backfill loop does not re-read
// platform_settings and the account row for every one of a venue's events.
const tierCache = new Map<string, { at: number; tiers: any }>();
let settingsCache: { at: number; row: any } | null = null;
const TIER_TTL_MS = 60_000;
async function resolveVenueTiers(locationId: string): Promise<any | null> {
  try {
    const hit = tierCache.get(locationId);
    if (hit && Date.now() - hit.at < TIER_TTL_MS) return hit.tiers;
    if (!settingsCache || Date.now() - settingsCache.at >= TIER_TTL_MS) {
      let { data: ps, error } = await platformAdmin.from('platform_settings')
        .select('default_adyen_rate_card, default_adyen_markup_percent, default_adyen_markup_fixed_pence')
        .eq('id', true).maybeSingle();
      if (error && isMissingColumn(error.message)) {
        ({ data: ps, error } = await platformAdmin.from('platform_settings')
          .select('default_adyen_markup_percent, default_adyen_markup_fixed_pence').eq('id', true).maybeSingle());
      }
      if (error) { console.error('[adyen-webhook] settings read failed:', error.message); return null; }
      settingsCache = { at: Date.now(), row: ps ?? {} };
    }
    let { data: acct, error: aErr } = await platformAdmin.from('merchant_adyen_accounts')
      .select('rate_card, markup_percent, markup_fixed_pence').eq('location_id', locationId).maybeSingle();
    if (aErr && isMissingColumn(aErr.message)) {
      ({ data: acct, error: aErr } = await platformAdmin.from('merchant_adyen_accounts')
        .select('markup_percent, markup_fixed_pence').eq('location_id', locationId).maybeSingle());
    }
    if (aErr) { console.error('[adyen-webhook] account rate read failed:', aErr.message); return null; }
    const tiers = resolveAdyenRateCard(acct ?? {}, settingsCache.row);
    tierCache.set(locationId, { at: Date.now(), tiers });
    return tiers;
  } catch (e) {
    console.error('[adyen-webhook] resolveVenueTiers:', (e as Error).message);
    return null;
  }
}

// ── v5.7.5 TIP ON PRINTED RECEIPT: capture-window side effects ───────────────
// Ops terminal_captures is the ledger of manual-capture auths (US signature
// tip flow). Three events drive it here:
//   AUTHORISATION (success, manual-capture job)  ensure the row exists - the
//     backstop for a charge-fn insert lost to a crash or an events-path settle.
//   AUTHORISATION_ADJUSTMENT  the async verdict on a tip > 20 percent adjust.
//     Success on an 'adjusting' row kicks the REAL capture at the new total
//     (never capture before this confirms - scheme rule). Refusal captures the
//     ORIGINAL amount instead (the sale is never lost to a failed tip) and
//     takes the tip back off the closed check.
//   CAPTURE / CAPTURE_FAILED  settle the row to captured/failed.
// Replay-safe: callers reach this only on non-duplicate events (modKey), the
// row updates are status-guarded, and the capture kick keys are deterministic.
// Best-effort by construction - never throws, never blocks the ack.
async function applyTipOnReceiptEvent(item: any, code: string, rowKey: string, okEvent: boolean, jobId: string | null): Promise<void> {
  try {
    if (code === 'AUTHORISATION') {
      if (!okEvent || !jobId) return;
      let j: any = null;
      try {
        const { data } = await admin.from('terminal_jobs')
          .select('id, capture_mode, closed_check_id, location_id, currency, simulated, charge_minor')
          .eq('id', jobId).maybeSingle();
        j = data;
      } catch { return; }   // capture_mode column pre-migration - nothing to do
      if (j?.capture_mode !== 'manual') return;
      const authMinor = Number(item?.amount?.value);
      await insertCaptureRow(admin, {
        jobId: j.id,
        closedCheckId: j.closed_check_id ?? null,
        locationId: j.location_id,
        psp: rowKey,
        merchantAccount: item?.merchantAccountCode ?? null,
        currency: j.currency ?? item?.amount?.currency ?? null,
        authMinor: Number.isFinite(authMinor) ? authMinor : Number(j.charge_minor ?? 0),
        simulated: j.simulated === true,
      });
      return;
    }

    if (!['AUTHORISATION_ADJUSTMENT', 'CAPTURE', 'CAPTURE_FAILED'].includes(code)) return;
    const { data: cap } = await admin.from('terminal_captures')
      .select('*').eq('psp_reference', rowKey).maybeSingle();
    if (!cap) return;   // not a tip-on-receipt payment (bar-tab holds, online, ...)
    const nowIso = new Date().toISOString();
    const cur = String(cap.currency || item?.amount?.currency || 'USD').toUpperCase();
    const merchant = (cap.merchant_account as string | null) ?? (item?.merchantAccountCode ? String(item.merchantAccountCode) : null);

    if (code === 'AUTHORISATION_ADJUSTMENT') {
      if (cap.status !== 'adjusting') return;   // only an armed adjust reacts - replays and stray adjustments no-op
      if (okEvent) {
        // The bank re-authorised the new total - NOW the capture is safe.
        const amount = Number(cap.final_minor ?? cap.auth_minor);
        if (!merchant) {
          await admin.from('terminal_captures').update({
            error: 'adjustment confirmed but no merchant account known - sweep will capture', updated_at: nowIso,
          }).eq('id', cap.id);
          return;
        }
        // CAS-claim BEFORE the Adyen call (adjusting -> capturing, attempts+1):
        // this webhook and the deadline sweep can never both fire the capture.
        // Losing the race means someone else owns the row - stop silently.
        const prevAttempts = Number(cap.attempts ?? 0);
        const attempt = prevAttempts + 1;
        const { data: claimed } = await admin.from('terminal_captures')
          .update({ status: 'capturing', attempts: attempt, updated_at: nowIso })
          .eq('id', cap.id).eq('status', 'adjusting').eq('attempts', prevAttempts)
          .select('id').maybeSingle();
        if (!claimed) return;
        // Key namespace 'tipcapw' is deliberately DISTINCT from adyen-modify's
        // 'tipcap': if the direct-capture attempt was refused there, reusing
        // its key would make Adyen replay the refusal forever. The attempts
        // salt makes every RETRY a fresh key too.
        let res;
        try {
          res = await adyenFetch('POST', `${checkoutBase()}/payments/${encodeURIComponent(rowKey)}/captures`,
            { merchantAccount: merchant, amount: { value: amount, currency: cur }, reference: `tipcapw:${cap.id}`.slice(0, 80) },
            { idempotencyKey: `tipcapw:${cap.id}:${amount}:${attempt}` });
        } catch (fe) {
          // Network abort must not strand the row at 'capturing' - put it back
          // to 'adjusting' so the deadline sweep retries at the final amount.
          await admin.from('terminal_captures').update({
            status: 'adjusting',
            error: `post-adjust capture call failed: ${(fe as Error).message}`.slice(0, 500),
            updated_at: new Date().toISOString(),
          }).eq('id', cap.id).eq('status', 'capturing');
          return;
        }
        if (res.ok) {
          await admin.from('terminal_captures')
            .update({ error: null, updated_at: new Date().toISOString() })
            .eq('id', cap.id).eq('status', 'capturing');
          await applyTipToClosedCheck(admin, {
            closedCheckId: cap.closed_check_id, captureId: cap.id, psp: rowKey,
            tipMinor: 0, legFlag: 'capturing',
          });
        } else {
          // The adjustment stood; only the capture call bounced. Back to
          // 'adjusting' - the deadline sweep retries at the same final amount.
          await admin.from('terminal_captures').update({
            status: 'adjusting',
            error: `post-adjust capture refused (adyen ${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`,
            updated_at: new Date().toISOString(),
          }).eq('id', cap.id).eq('status', 'capturing');
        }
      } else {
        // Adjust REFUSED (wallets and most debit cards do not support it).
        // Capture the ORIGINAL amount so the sale is never lost, mark the tip
        // failed, and take the tip back off the closed check.
        const tip = Number(cap.tip_minor ?? 0);
        const authAmount = Number(cap.auth_minor);
        const errNote = `tip adjustment refused (${item?.reason ?? 'no reason given'}) - captured the original amount, tip NOT charged`;
        // Same CAS discipline as the success arm: claim BEFORE the Adyen call,
        // and only the winner reverts the tip - exactly once.
        const prevAttempts = Number(cap.attempts ?? 0);
        const attempt = prevAttempts + 1;
        const { data: claimed } = await admin.from('terminal_captures')
          .update({ status: 'capturing', attempts: attempt, updated_at: nowIso })
          .eq('id', cap.id).eq('status', 'adjusting').eq('attempts', prevAttempts)
          .select('id').maybeSingle();
        if (!claimed) return;
        let captured = false;
        if (merchant) {
          try {
            const res = await adyenFetch('POST', `${checkoutBase()}/payments/${encodeURIComponent(rowKey)}/captures`,
              { merchantAccount: merchant, amount: { value: authAmount, currency: cur }, reference: `tipcapw:${cap.id}`.slice(0, 80) },
              { idempotencyKey: `tipcapw:${cap.id}:${authAmount}:${attempt}` });
            captured = res.ok;
            if (!res.ok) console.error('[adyen-webhook] fallback capture at auth refused:', res.status, JSON.stringify(res.data).slice(0, 200));
          } catch (fe) {
            console.error('[adyen-webhook] fallback capture at auth threw:', (fe as Error).message);
          }
        }
        await admin.from('terminal_captures').update({
          // 'pending' fallback keeps the row in the sweep's net: final_minor is
          // reset to the auth amount (and tip_minor cleared - the tip is being
          // reverted off the check right below), so the sweep captures exactly
          // the plain auth.
          status: captured ? 'capturing' : 'pending',
          final_minor: authAmount,
          tip_minor: null,
          error: errNote,
          updated_at: new Date().toISOString(),
        }).eq('id', cap.id).eq('status', 'capturing');
        await applyTipToClosedCheck(admin, {
          closedCheckId: cap.closed_check_id, captureId: cap.id, psp: rowKey,
          tipMinor: tip > 0 ? -tip : 0,
          legFlag: captured ? 'capturing' : 'pending',
          tipError: errNote,
        });
      }
      return;
    }

    // CAPTURE / CAPTURE_FAILED
    const failed = code === 'CAPTURE_FAILED' || !okEvent;
    if (!failed) {
      await admin.from('terminal_captures')
        .update({ status: 'captured', updated_at: nowIso })
        .eq('id', cap.id).in('status', ['pending', 'adjusting', 'capturing']);
      await applyTipToClosedCheck(admin, {
        closedCheckId: cap.closed_check_id, captureId: cap.id, psp: rowKey,
        tipMinor: 0, legFlag: 'captured',
      });
    } else {
      // CAPTURE FAILED - whatever tip was applied never charged. Mirror the
      // adjustment-refusal branch: take the applied tip back OFF the closed
      // check, reset the row's money to the plain auth (final_minor = auth,
      // tip_minor cleared), and mark it failed. A retry from History then
      // applies a FRESH tip exactly once, and the deadline sweep can still
      // rescue the sale at the auth amount if nobody retries.
      //
      // Replay-safe twice over: the modKey guard already blocks duplicate
      // deliveries before this runs, and the status-guarded update below
      // reverts ONLY when THIS event actually moved the row to 'failed'
      // (a CAPTURE success=false followed by its CAPTURE_FAILED sibling has
      // two different modKeys - the second finds the row already failed and
      // must never revert the tip twice).
      const tip = Number(cap.tip_minor ?? 0);
      // v5.7.10 - LIVE-OBSERVED on this account (20 Aug, the £20+£4 tip): a
      // capture ABOVE the auth is ACCEPTED at request time and refused HERE,
      // asynchronously, with "Insufficient balance on payment" - the wording
      // for overcapture-not-enabled. The request-time fallback in adyen-modify
      // never sees it, so the fallback must live in this branch: re-authorise
      // the new total with the bank (amountUpdates) and let the
      // AUTHORISATION_ADJUSTMENT success arm above kick the capture. ONE-SHOT:
      // never falls back when a successful adjustment already applied for this
      // psp (then a same-worded failure is genuine and must revert), so the
      // adjust -> capture -> fail -> adjust loop is impossible.
      const reasonTxt = String(item?.reason ?? '');
      const finalM = Number(cap.final_minor ?? cap.auth_minor);
      const authM = Number(cap.auth_minor);
      const overcaptureShaped = /insufficient balance|overcapture|over-capture|exceed|higher than|greater than/i.test(reasonTxt);
      if (overcaptureShaped && tip > 0 && finalM > authM && merchant) {
        let alreadyAdjusted = false;
        try {
          const { data: parent } = await platformAdmin.from('adyen_payments')
            .select('raw').eq('psp_reference', rowKey).maybeSingle();
          const mods: string[] = Array.isArray((parent?.raw as any)?.applied_modifications) ? (parent!.raw as any).applied_modifications : [];
          alreadyAdjusted = mods.some((m) => String(m).startsWith('AUTHORISATION_ADJUSTMENT:') && String(m).endsWith(':true'));
        } catch { /* unreadable parent = assume not adjusted; the one-shot still holds via applied_modifications next time */ }
        if (!alreadyAdjusted) {
          const prevAttempts = Number(cap.attempts ?? 0);
          const attempt = prevAttempts + 1;
          const { data: claimed } = await admin.from('terminal_captures')
            .update({ status: 'adjusting', attempts: attempt, updated_at: nowIso })
            .eq('id', cap.id).in('status', ['pending', 'capturing']).eq('attempts', prevAttempts)
            .select('id').maybeSingle();
          if (!claimed) return;   // someone else owns the row - stop silently
          let adj;
          try {
            adj = await adyenFetch('POST', `${checkoutBase()}/payments/${encodeURIComponent(rowKey)}/amountUpdates`,
              { merchantAccount: merchant, amount: { value: finalM, currency: cur }, industryUsage: 'delayedCharge', reference: `tipadjw:${cap.id}`.slice(0, 80) },
              { idempotencyKey: `tipadjw:${cap.id}:${finalM}:${attempt}` });
          } catch (fe) {
            adj = { ok: false, status: 0, data: { message: (fe as Error).message } };
          }
          if (adj.ok) {
            await admin.from('terminal_captures').update({
              error: 'direct capture refused (overcapture not enabled) - re-authorising the new total with the bank',
              updated_at: new Date().toISOString(),
            }).eq('id', cap.id).eq('status', 'adjusting');
            await applyTipToClosedCheck(admin, {
              closedCheckId: cap.closed_check_id, captureId: cap.id, psp: rowKey,
              tipMinor: 0, legFlag: 'adjusting',
            });
            return;   // the AUTHORISATION_ADJUSTMENT webhook takes it from here
          }
          // The adjust request itself bounced - restore and fall through to the
          // normal revert-to-failed below (fresh read keeps the CAS numbers right).
          await admin.from('terminal_captures').update({ status: 'capturing', updated_at: new Date().toISOString() })
            .eq('id', cap.id).eq('status', 'adjusting');
          cap.attempts = attempt;
        }
      }
      const err = `capture failed at Adyen (${item?.reason ?? 'no reason given'})${tip > 0 ? ' - tip reverted, NOT charged' : ''}`;
      const { data: nowFailed } = await admin.from('terminal_captures')
        .update({ status: 'failed', final_minor: Number(cap.auth_minor), tip_minor: null, error: err, updated_at: nowIso })
        .eq('id', cap.id).in('status', ['pending', 'adjusting', 'capturing'])
        .select('id').maybeSingle();
      if (nowFailed) {
        await applyTipToClosedCheck(admin, {
          closedCheckId: cap.closed_check_id, captureId: cap.id, psp: rowKey,
          tipMinor: tip > 0 ? -tip : 0, legFlag: 'failed', tipError: err,
        });
      }
    }
  } catch (e) { console.error('[adyen-webhook] tip-on-receipt apply:', (e as Error).message); }
}

// Apply ONE money event to the ledger (and, for the chargeback family, the
// dispute queue). NEVER throws — the raw event is already durable; a bug here
// costs a log line and a later replay, not an event.
async function applyMoneyEvent(item: any): Promise<'applied' | 'duplicate' | 'skipped' | 'failed'> {
  try {
    const code = String(item?.eventCode || '');
    if (!LEDGER_EVENTS.has(code)) return 'skipped';
    const isModification = MODIFICATION_EVENTS.has(code);
    const okEvent = String(item?.success) === 'true';
    const itemPsp = item?.pspReference ? String(item.pspReference) : '';
    // Row key = the ORIGINAL payment's pspReference. Modifications point at the
    // parent via originalReference (falling back to their own psp when Adyen
    // omits it — some CHARGEBACK notifications reuse the payment psp directly).
    const rowKey = isModification ? String(item?.originalReference || itemPsp) : itemPsp;
    if (!rowKey) { console.error('[adyen-webhook] money event with no psp — skipped', code); return 'skipped'; }

    const { data: existing, error: readErr } = await platformAdmin.from('adyen_payments')
      .select('psp_reference, location_id, amount_minor, currency, amount_refunded_minor, success, channel, card, merchant_reference, merchant_account, store, matched_terminal_job, matched_closed_check, rate_category, raw')
      .eq('psp_reference', rowKey).maybeSingle();
    if (readErr) { console.error('[adyen-webhook] ledger read failed:', readErr.message); return 'failed'; }

    const raw: Record<string, any> = (existing?.raw && typeof existing.raw === 'object') ? { ...existing.raw } : {};
    const applied: string[] = Array.isArray(raw.applied_modifications) ? [...raw.applied_modifications] : [];

    const modKey = `${code}:${itemPsp}:${okEvent}`;
    if (isModification) {
      if (applied.includes(modKey)) {
        // A duplicate successful CAPTURE above the stored amount re-applies its
        // bump. Idempotent, it only ever raises, and it touches nothing else,
        // so a backfill that replayed the AUTHORISATION first (flattening the
        // tip bump) heals the row when the CAPTURE replays after it.
        const capMinor = Number(item?.amount?.value);
        if (code === 'CAPTURE' && okEvent && Number.isFinite(capMinor)
            && existing?.amount_minor != null && capMinor > Number(existing.amount_minor)) {
          const patch: Record<string, unknown> = { amount_minor: capMinor, updated_at: new Date().toISOString() };
          const rc = (existing as any)?.rate_category as string | null;
          const loc = existing?.location_id ?? null;
          if (rc && loc) {
            const tiers = await resolveVenueTiers(loc);
            if (tiers) patch.commission_minor = commissionForAmount(capMinor, tiers[rc]);
          }
          const { error: fixErr } = await platformAdmin.from('adyen_payments').update(patch).eq('psp_reference', rowKey);
          if (fixErr) console.error('[adyen-webhook] duplicate-capture bump repair failed:', fixErr.message, rowKey);
        }
        return 'duplicate';
      }
      applied.push(modKey);
      raw.applied_modifications = applied;
      raw.last_modification = item;
    } else {
      raw.authorisation = item;
    }

    // The PAYMENT'S merchant reference. On modification events Adyen's
    // merchantReference is the MODIFICATION'S own reference (e.g. adyen-modify's
    // `refund:<psp>:<amount>`), which must never clobber the parent's — the
    // `tj-<job>` linkage and merchant_reference index live on the parent's.
    const merchantReference = isModification
      ? String(existing?.merchant_reference ?? '')
      : String(item?.merchantReference ?? '');
    const job = await matchTerminalJob(merchantReference, rowKey);
    const location_id = existing?.location_id ?? await resolveLocation(item, job?.location_id ?? null);

    const amountMinor = Number(item?.amount?.value);
    const currency = item?.amount?.currency ? String(item.amount.currency) : null;
    const channel = existing?.channel ?? inferChannel(merchantReference, !!job);

    const row: Record<string, unknown> = {
      psp_reference: rowKey,
      merchant_reference: merchantReference || null,
      merchant_account: item?.merchantAccountCode ?? existing?.merchant_account ?? null,
      store: item?.additionalData?.store ?? existing?.store ?? null,
      location_id,
      channel,
      matched_terminal_job: existing?.matched_terminal_job ?? job?.id ?? null,
      matched_closed_check: existing?.matched_closed_check ?? job?.closed_check_id ?? null,
      amount_refunded_minor: Number(existing?.amount_refunded_minor ?? 0),
      raw,
      updated_at: new Date().toISOString(),
    };

    if (!isModification) {
      // AUTHORISATION — the payment itself. Sets the money + card facts.
      // NEVER SHRINK on replay: if a successful CAPTURE already bumped this row
      // above the auth amount (US tip on receipt), a redelivered AUTHORISATION
      // or a ?backfill=1 replay must not flatten it back to the pre-tip amount.
      // The CAPTURE replay would then be a modKey duplicate and the tip would be
      // gone from the ledger, and from the FranPOS invoice, forever. Paired with
      // the re-raise in the duplicate path above, this makes backfill idempotent.
      const capBumped = applied.some((m) => String(m).startsWith('CAPTURE:') && String(m).endsWith(':true'))
        && existing?.amount_minor != null
        && Number(existing.amount_minor) > (Number.isFinite(amountMinor) ? amountMinor : -1);
      const effAmount = capBumped ? Number(existing!.amount_minor) : amountMinor;
      row.amount_minor = Number.isFinite(effAmount) ? effAmount : existing?.amount_minor ?? null;
      row.currency = currency ?? existing?.currency ?? null;
      row.success = okEvent;
      // A redelivered auth must not erase a cancel that already succeeded, or a
      // dead payment re-enters the reseller invoice.
      const wasCancelled = applied.some((m) => String(m).startsWith('CANCELLATION:') && String(m).endsWith(':true'));
      row.last_event_code = wasCancelled ? 'CANCELLATION' : 'AUTHORISATION';
      // Bucket the payment in the month it was AUTHORISED, not the month its
      // webhook happened to arrive (backfill mints rows at replay time, which
      // would bill an August payment in whatever month the backfill ran).
      const evDate = item?.eventDate ? new Date(String(item.eventDate)) : null;
      if (evDate && !isNaN(evDate.getTime())) row.authorised_at = evDate.toISOString();
      // Manual-capture flow (US tip on receipt): money only moves at CAPTURE,
      // so the reseller statement must not invoice an auth that never captured.
      // Only stamped when known true; omitting the key preserves the DB value.
      if ((job as any)?.capture_mode === 'manual') row.capture_required = true;
      const card = cardFromWebhookAdditionalData(item?.additionalData);
      row.card = card ?? existing?.card ?? null;
      // v5.7.3 — classify the payment into its pricing tier and stamp what we
      // earn on it. Both are RECOMPUTED (never incremented) on every
      // AUTHORISATION apply, which is what makes the ?backfill=1 replay a safe
      // re-stamp after a rate change or a classifier fix.
      const rateCategory = classifyRateCategory(item, channel as string | null);
      row.rate_category = rateCategory;
      row.commission_minor = null;
      if (okEvent && location_id && Number.isFinite(effAmount)) {
        const tiers = await resolveVenueTiers(location_id);
        // effAmount, not amountMinor: a replay on a tip-bumped row must re-stamp
        // commission on the CAPTURED total, or the invoice loses the tip margin.
        row.commission_minor = tiers ? commissionForAmount(effAmount, tiers[rateCategory]) : null;
      }
    } else {
      // Modifications never rewrite the payment amount or its success flag —
      // a failed refund is not a failed payment. They move last_event_code
      // (failed attempts land as their *_FAILED code) and, for refunds, the
      // cumulative amount_refunded_minor.
      row.amount_minor = existing?.amount_minor ?? null;
      row.currency = existing?.currency ?? currency;
      row.success = existing?.success ?? null;
      // v5.7.5 tip-on-receipt: a CAPTURE larger than the authorised amount is
      // the tip landing (overcapture / post-adjust capture). The payment's
      // true value is what was CAPTURED, so bump amount_minor and recompute
      // what we earn at the SAME tier (rate_category unchanged by contract).
      if (code === 'CAPTURE' && okEvent) row.captured_at = new Date().toISOString();
      if (code === 'CAPTURE' && okEvent && Number.isFinite(amountMinor)
          && existing?.amount_minor != null && amountMinor > Number(existing.amount_minor)) {
        row.amount_minor = amountMinor;
        const rc = (existing as any)?.rate_category as string | null;
        let restamped: number | null = null;
        if (rc && location_id) {
          const tiers = await resolveVenueTiers(location_id);
          if (tiers) restamped = commissionForAmount(amountMinor, tiers[rc]);
        }
        // ALWAYS stamp the column on the bump path. If the tier read failed we
        // write null (= unrated), so the reseller statement excludes and FLAGS
        // the payment instead of silently billing the stale pre-tip commission
        // beside the post-tip amount.
        row.commission_minor = restamped;
      }
      if (code === 'REFUND' && okEvent && Number.isFinite(amountMinor)) {
        row.amount_refunded_minor = Number(existing?.amount_refunded_minor ?? 0) + amountMinor;
      } else if (code === 'REFUND_FAILED' && okEvent && Number.isFinite(amountMinor)
        && applied.includes(`REFUND:${itemPsp}:true`)) {
        // A refund we previously counted has failed downstream — take it back.
        row.amount_refunded_minor = Math.max(0, Number(existing?.amount_refunded_minor ?? 0) - amountMinor);
      }
      row.last_event_code =
        (code === 'REFUND' && !okEvent) ? 'REFUND_FAILED'
        : (code === 'CAPTURE' && !okEvent) ? 'CAPTURE_FAILED'
        // A REFUSED cancel means the payment STANDS and settles. Stamping it
        // 'CANCELLATION' made a live payment vanish from the reseller invoice.
        : (code === 'CANCELLATION' && !okEvent) ? 'CANCELLATION_FAILED'
        : code;
    }

    let { error: upErr } = await platformAdmin.from('adyen_payments')
      .upsert(row, { onConflict: 'psp_reference' });
    if (upErr && isMissingColumn(upErr.message)
        && ('rate_category' in row || 'commission_minor' in row
          || 'authorised_at' in row || 'capture_required' in row || 'captured_at' in row)) {
      // Migrations 20260821b / 20260826 not applied yet — the ledger write must
      // never break while a deploy precedes its hand-applied DDL.
      delete row.rate_category;
      delete row.commission_minor;
      delete row.authorised_at;
      delete row.capture_required;
      delete row.captured_at;
      ({ error: upErr } = await platformAdmin.from('adyen_payments').upsert(row, { onConflict: 'psp_reference' }));
    }
    if (upErr) { console.error('[adyen-webhook] ledger upsert failed:', upErr.message, rowKey); return 'failed'; }

    // ── v5.7.5 tip-on-receipt capture window (best-effort, never blocks) ─────
    // Runs only on NON-duplicate events (the modKey guard above already
    // returned for replays), so the capture kick can never double-fire.
    await applyTipOnReceiptEvent(item, code, rowKey, okEvent, job?.id ?? existing?.matched_terminal_job ?? null);

    // ── Chargeback family → dispute queue (model: ryft-webhook Dispute.*) ────
    if (CHARGEBACK_EVENTS.has(code)) {
      const ad = item?.additionalData ?? {};
      // Adyen carries the defense deadline in additionalData when there is one.
      const defenseRaw = ad['defensePeriodEndsAt'] ?? ad['defensePeriodEndsDate'] ?? null;
      let respond_by: string | null = null;
      if (defenseRaw) { const d = new Date(String(defenseRaw)); if (!isNaN(d.getTime())) respond_by = d.toISOString(); }
      const status =
        code === 'CHARGEBACK_REVERSED' ? 'won'
        : code === 'SECOND_CHARGEBACK' ? 'lost'
        : code === 'REQUEST_FOR_INFORMATION' ? 'info_requested'
        : 'open'; // CHARGEBACK / NOTIFICATION_OF_CHARGEBACK
      const { error: dErr } = await platformAdmin.from('merchant_adyen_disputes').upsert({
        dispute_psp_reference: itemPsp || rowKey,
        payment_psp_reference: rowKey,
        location_id,
        status,
        reason_code: ad['chargebackReasonCode'] ?? null,
        reason: item?.reason ?? ad['chargebackReason'] ?? null,
        amount_minor: Number.isFinite(amountMinor) ? amountMinor : null,
        currency,
        respond_by,
        raw: item,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'dispute_psp_reference' });
      if (dErr) console.error('[adyen-webhook] dispute upsert failed:', dErr.message, itemPsp);
    }

    // Heartbeat: the venue's account row shows when Adyen last spoke about it.
    if (location_id) {
      const { error: hbErr } = await platformAdmin.from('merchant_adyen_accounts')
        .update({ last_webhook_at: new Date().toISOString() }).eq('location_id', location_id);
      if (hbErr) console.error('[adyen-webhook] last_webhook_at stamp failed:', hbErr.message);
    }

    return 'applied';
  } catch (e) {
    console.error('[adyen-webhook] applyMoneyEvent failed:', (e as Error).message);
    return 'failed';
  }
}

// ── REPORT_AVAILABLE → settlement report queue + ingest kick (Phase 2) ──────
//
// Adyen announces every generated report with a standard REPORT_AVAILABLE
// webhook: pspReference carries the report FILE NAME and reason carries the
// download URL (both parsed defensively — additionalData.downloadUrl is the
// fallback). The row lands durably in platform adyen_reports first (settlement
// reports 'pending', everything else 'skipped' but still visible), THEN the
// ingest fn is kicked fire-and-forget. A lost kick costs nothing: the queue
// row stays pending and adyen-report-ingest's process_pending sweeps it up.
async function queueReport(item: any, kick = true): Promise<void> {
  try {
    const reason = String(item?.reason ?? '');
    const adUrl = item?.additionalData?.downloadUrl;
    const url = /^https?:\/\//i.test(reason) ? reason
      : (typeof adUrl === 'string' && /^https?:\/\//i.test(adUrl) ? adUrl : null);
    let name = item?.pspReference ? String(item.pspReference) : '';
    if (!name && url) name = url.split('?')[0].split('/').pop() ?? '';
    if (!name) { console.error('[adyen-webhook] REPORT_AVAILABLE with no report name — ignored'); return; }
    const isSettlement = /settlement_detail/i.test(name);
    // Insert-if-new: a webhook redelivery must never reset an ingested/failed row.
    const { error } = await platformAdmin.from('adyen_reports').upsert({
      report_name: name,
      url,
      report_type: isSettlement ? 'settlement_details' : 'other',
      status: isSettlement ? 'pending' : 'skipped',
      raw: item,
    }, { onConflict: 'report_name', ignoreDuplicates: true });
    if (error) {
      // Durable path failed (e.g. 20260820_adyen_fees.sql not applied yet).
      // The raw event is already stored in adyen_events — a backfill replays it.
      console.error('[adyen-webhook] report queue insert failed:', error.message, name);
      return;
    }
    if (!isSettlement || !kick) return;
    // Same service-role kick pattern adyen-terminal-events uses for
    // adyen-terminal-charge; waitUntil keeps it alive past the ack.
    const kickP = fetch(`${SUPABASE_URL}/functions/v1/adyen-report-ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ action: 'ingest', report_name: name }),
    }).then(async (r) => {
      if (!r.ok) console.error('[adyen-webhook] report ingest kick returned', r.status, (await r.text()).slice(0, 300));
    }).catch((e) => console.error('[adyen-webhook] report ingest kick failed:', (e as Error).message));
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(kickP); else await kickP;
  } catch (e) {
    console.error('[adyen-webhook] queueReport failed:', (e as Error).message);
  }
}

// ── Backfill: replay stored adyen_events through the money parser ────────────
async function runBackfill(dry: boolean): Promise<Response> {
  const counts = { scanned: 0, money_events: 0, applied: 0, duplicates: 0, failed: 0, reports_queued: 0 };
  const BATCH = 500;
  let from = 0;
  for (;;) {
    const { data: rows, error } = await admin.from('adyen_events')
      .select('id, event_code, raw')
      .order('received_at', { ascending: true }).order('id', { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message, ...counts }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!rows?.length) break;
    for (const row of rows) {
      counts.scanned++;
      const code = String(row.event_code || row.raw?.eventCode || '');
      if (code === 'REPORT_AVAILABLE') {
        // Re-queue without kicking the ingest fn per row — after a backfill the
        // operator runs adyen-report-ingest process_pending once instead.
        counts.reports_queued++;
        if (!dry) await queueReport(row.raw, false);
        continue;
      }
      if (!LEDGER_EVENTS.has(code)) continue;
      counts.money_events++;
      if (dry) continue;
      const res = await applyMoneyEvent(row.raw);
      if (res === 'applied') {
        counts.applied++;
        const { error: pErr } = await admin.from('adyen_events')
          .update({ processed_at: new Date().toISOString() }).eq('id', row.id);
        if (pErr) console.error('[adyen-webhook] backfill processed_at stamp failed:', pErr.message);
      } else if (res === 'duplicate') counts.duplicates++;
      else if (res === 'failed') counts.failed++;
    }
    if (rows.length < BATCH) break;
    from += BATCH;
  }
  return new Response(JSON.stringify({ ok: true, dry, ...counts }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  // Backfill arm — service-role bearer ONLY, checked before webhook basic auth
  // (the operator invoking a backfill is not Adyen and has no basic credentials).
  const url = new URL(req.url);
  if (url.searchParams.get('backfill') === '1') {
    const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim();
    if (!SERVICE_ROLE || token !== SERVICE_ROLE) return new Response('unauthorized', { status: 401 });
    return await runBackfill(url.searchParams.get('dry') === '1');
  }

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
    if (valid === false) {
      // LOUD either way — this line is what proves the recipe against real
      // events so REJECT_INVALID_HMAC can be armed for go-live.
      console.error('[adyen-webhook] ⚠ INVALID HMAC on', item.eventCode, item.pspReference,
        REJECT_INVALID_HMAC ? '(rejecting)' : '(accepted — rejection not armed yet)');
    }
    if (REJECT_INVALID_HMAC && valid === false) {
      return new Response('invalid hmac', { status: 401 });
    }
    const { data: stored, error } = await admin.from('adyen_events').insert({
      live: String(body.live) === 'true',
      event_code: item.eventCode ?? null,
      psp_reference: item.pspReference ?? null,
      merchant_account: item.merchantAccountCode ?? null,
      merchant_reference: item.merchantReference ?? null,
      success: String(item.success) === 'true',
      hmac_present: !!item?.additionalData?.hmacSignature,
      hmac_valid: valid,
      raw: item,
    }).select('id').maybeSingle();
    // Storage failure = do NOT ack; Adyen retries, which is exactly what we want.
    if (error) {
      console.error('[adyen-webhook] store failed:', error.message);
      return new Response('store failed', { status: 500 });
    }

    // ── money events → platform ledger (+ disputes). Best-effort on top of the
    // stored raw row: parse failures log and NEVER block the ack.
    if (LEDGER_EVENTS.has(String(item.eventCode || ''))) {
      const res = await applyMoneyEvent(item);
      if ((res === 'applied' || res === 'duplicate') && stored?.id) {
        const { error: pErr } = await admin.from('adyen_events')
          .update({ processed_at: new Date().toISOString() }).eq('id', stored.id);
        if (pErr) console.error('[adyen-webhook] processed_at stamp failed:', pErr.message);
      }
    }

    // ── REPORT_AVAILABLE → queue + kick adyen-report-ingest (Phase 2 fees) ──
    if (String(item.eventCode || '') === 'REPORT_AVAILABLE') {
      await queueReport(item);
      if (stored?.id) {
        const { error: pErr } = await admin.from('adyen_events')
          .update({ processed_at: new Date().toISOString() }).eq('id', stored.id);
        if (pErr) console.error('[adyen-webhook] report processed_at stamp failed:', pErr.message);
      }
    }

    // ── bookings settlement (Phase 5): bkpay-<bookingId>-<kind>[-a<N>] refs ──
    // The ledger row was written at payment time; the webhook is the durable
    // confirmation that settles/corrects it. Idempotent: keyed updates only,
    // and the raw event is already stored above whatever happens here.
    const ref = String(item.merchantReference || '');
    if (ref.startsWith('bkpay-') && item.pspReference) {
      try {
        // Reference parse is for the BOOKING ID (status promote below) only.
        // Old refs have no -a suffix; new ones carry the attempt number.
        const refMatch = ref.match(/^bkpay-(.+)-(hold|deposit|prepay)(?:-a\d+)?$/);
        const bkKind = refMatch ? refMatch[2] : null;
        const okEvent = String(item.success) === 'true';
        const code = String(item.eventCode || '');
        let patch: Record<string, unknown> | null = null;
        if (code === 'AUTHORISATION') {
          patch = okEvent
            ? { authorised_at: new Date().toISOString(), psp_reference: item.pspReference }
            : { status: 'failed', refusal_reason: item.reason || 'refused' };
          // capture-on-auth kinds settle to captured on a successful auth
          if (okEvent && (bkKind === 'prepay' || bkKind === 'deposit')) {
            patch.status = 'captured'; patch.captured_at = new Date().toISOString();
          } else if (okEvent) {
            patch.status = 'authorised';
          }
        } else if (code === 'CAPTURE' && okEvent) {
          patch = { status: 'captured', captured_at: new Date().toISOString() };
        } else if (code === 'CANCELLATION' && okEvent) {
          patch = { status: 'cancelled', released_at: new Date().toISOString() };
        } else if (code === 'REFUND' && okEvent) {
          patch = { status: 'refunded' };
        }
        if (patch) {
          // v5.7.23 - settle by psp_reference (unique index), never by merchant
          // reference: booking_pay stores the sync response's psp on ITS row,
          // so the payment psp matches exactly one attempt. A reference-wide
          // update flipped EVERY attempt for the booking+kind at once (a
          // refused-then-retried card doubled or destroyed the credit).
          // Modifications (CAPTURE/CANCELLATION/REFUND) point at the parent
          // payment via originalReference - same rowKey rule as applyMoneyEvent.
          const settleKey = code === 'AUTHORISATION'
            ? String(item.pspReference)
            : String(item.originalReference || item.pspReference);
          const { data: settledRows } = await admin.from('booking_payments')
            .update(patch).eq('psp_reference', settleKey).select('id');
          if (!settledRows?.length) {
            // Async-only flow: the row was inserted before any psp was known.
            // Settle the single MOST RECENT still-open attempt for this
            // reference - never a blanket reference-wide update.
            const { data: cand } = await admin.from('booking_payments')
              .select('id').eq('merchant_reference', ref)
              .in('status', ['pending', 'failed'])
              .order('created_at', { ascending: false }).limit(1);
            if (cand?.length) {
              await admin.from('booking_payments').update(patch).eq('id', cand[0].id);
            }
          }
        }
        // ── pay-before-commit backstop (v5.7.21): a booking the widget wrote
        // as 'pending_payment' promotes here when the money confirms async
        // (3DS/redirect flows answer the browser 'pending'; this webhook is
        // the durable result). prepay → 'prepaid'; deposit/hold → 'confirmed'.
        // v5.7.23: 'expired' promotes too - a capture landing after the
        // 20-minute sweep RESURRECTS the booking (the money is captured, the
        // booking must live; the table-overlap risk is accepted). Cancelled
        // and no-show bookings still never come back.
        const settled = patch && (patch.status === 'captured' || patch.status === 'authorised');
        if (settled && refMatch) {
          const bkId = refMatch[1];
          const next = bkKind === 'prepay' ? 'prepaid' : 'confirmed';
          const { data: promoted } = await admin.from('bookings')
            .update({ status: next })
            .eq('id', bkId).in('status', ['pending_payment', 'expired'])
            .select('id');
          if (promoted?.length) {
            // The confirmation was deliberately NOT sent at booking time for
            // pending_payment — fire it now the money is real. Ledger-gated
            // inside booking-reminders, so racing the sync promote is safe.
            fetch(`${SUPABASE_URL}/functions/v1/booking-reminders`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
              body: JSON.stringify({ action: 'confirm', booking_id: bkId }),
            }).catch(() => {});
          }
        }
        // A stored card token can arrive on the webhook rather than the sync
        // response — enrich the guest record when we get it.
        const token = item?.additionalData?.['recurring.recurringDetailReference'];
        const shopper = item?.additionalData?.shopperReference;
        if (token && shopper && code === 'AUTHORISATION' && okEvent) {
          await admin.from('customers').update({ stored_payment_method_id: token, shopper_reference: shopper }).eq('id', shopper);
        }
      } catch (e) {
        // Settlement is best-effort on top of the stored raw event — never
        // block the ack (Adyen would retry forever on a code bug here).
        console.error('[adyen-webhook] bkpay settle failed:', (e as Error).message);
      }
    }
  }

  // Adyen's expected acknowledgement for standard webhooks.
  return new Response(JSON.stringify({ notificationResponse: '[accepted]' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
