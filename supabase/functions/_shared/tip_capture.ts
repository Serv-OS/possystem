// supabase/functions/_shared/tip_capture.ts
//
// v5.7.5 TIP ON PRINTED RECEIPT (United States signature tip flow) - shared
// helpers for the manual-capture ledger (ops public.terminal_captures).
//
// The flow in one line: a main-POS Adyen sale authorises with manualCapture
// (adyen-terminal-charge), a terminal_captures row tracks the open window,
// adyen-modify 'tip_capture' applies the written tip (direct capture <= 20
// percent, amountUpdates above), adyen-webhook confirms the async legs, and
// adyen-capture-sweep captures anything the venue forgot before the auth dies.
//
// Used by: adyen-terminal-charge, adyen-modify, adyen-webhook, adyen-capture-sweep.

// deno-lint-ignore-file no-explicit-any

/** Venue setting shape on ops locations.pos_settings.tip_on_receipt. */
export interface TipOnReceiptSetting {
  enabled: boolean;
  capture_hours: number; // clamped 1..72, default 24
  // v5.7.6 - which main-POS sales go paper. 'all_pos' = every card payment at
  // the till (the v5.7.5 behaviour, and the default for any missing or unknown
  // value so venues that enabled the setting before scope existed keep exactly
  // what they had). 'table_checks' = only checks attached to a table; counter
  // and walk-in sales keep the tip prompt on the reader.
  scope: 'all_pos' | 'table_checks';
}

export function clampCaptureHours(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 24;
  return Math.max(1, Math.min(72, n));
}

/** Parse locations.pos_settings jsonb into the venue tip-on-receipt setting. Fail closed. */
export function readTipOnReceipt(posSettings: unknown): TipOnReceiptSetting {
  const s = (posSettings && typeof posSettings === 'object')
    ? (posSettings as Record<string, any>).tip_on_receipt : null;
  if (!s || typeof s !== 'object') return { enabled: false, capture_hours: 24, scope: 'all_pos' };
  return {
    enabled: s.enabled === true,
    capture_hours: clampCaptureHours(s.capture_hours),
    // Only the one recognised narrowing value counts; anything else (missing,
    // typo, future value) falls back to 'all_pos' so an enabled venue never
    // silently loses the flow it turned on.
    scope: s.scope === 'table_checks' ? 'table_checks' : 'all_pos',
  };
}

/**
 * Does a refused direct capture smell like "overcapture not enabled on the
 * account" (or an amount-above-auth refusal)? Adyen recommends capturing
 * auth+tip in one call but gates it behind Support enablement; when the
 * account lacks it the refusal talks about the amount or the feature, never
 * about the card. On a match the caller falls back to the amountUpdates path.
 */
export function isOvercaptureRefusal(status: number, data: any): boolean {
  if (status < 400 || status >= 500) return false;
  const text = JSON.stringify(data ?? {}).toLowerCase();
  return /overcapture|over-capture|exceed|higher than|greater than|above the|insufficient balance|amount.*not.*(allow|valid|support)|not (allowed|enabled|permitted).*amount|capture amount/.test(text);
}

/**
 * Reflect a tip onto the closed check, server-side (adyen-modify tip_capture
 * and the webhook failure-revert both use this - the same mechanics the refund
 * path uses on closed_checks: read fresh, mutate, keyed update).
 *
 *   tip   += tipMinor/100        (numeric pounds, may be negative on revert)
 *   total += tipMinor/100
 *   payment_intents leg (matched by captureId, else psp, else single leg):
 *     amountMinor += tipMinor, capture = legFlag, tipError set/cleared.
 *
 * Best-effort by contract: failures log and return false, they never throw.
 */
export async function applyTipToClosedCheck(ops: any, o: {
  closedCheckId: string | null;
  captureId: string;
  psp: string | null;
  tipMinor: number;          // 0 allowed = flag-only update
  legFlag: string;           // 'pending'|'adjusting'|'capturing'|'captured'|'failed'
  tipError?: string | null;  // set on a failed tip attempt, cleared otherwise
}): Promise<boolean> {
  if (!o.closedCheckId) return false;
  try {
    const { data: check, error } = await ops.from('closed_checks')
      .select('id, tip, total, payment_intents')
      .eq('id', o.closedCheckId).maybeSingle();
    if (error || !check) {
      console.error('[tip_capture] closed check read failed:', error?.message ?? 'not found', o.closedCheckId);
      return false;
    }
    const tipPounds = o.tipMinor / 100;
    const patch: Record<string, unknown> = {};
    if (o.tipMinor !== 0) {
      patch.tip = +((Number(check.tip) || 0) + tipPounds).toFixed(2);
      patch.total = +((Number(check.total) || 0) + tipPounds).toFixed(2);
    }
    const legs: any[] = Array.isArray(check.payment_intents) ? check.payment_intents : [];
    let matched = false;
    const next = legs.map((leg) => {
      if (matched || !leg || typeof leg !== 'object') return leg;
      const hit = (leg.captureId && leg.captureId === o.captureId)
        || (o.psp && leg.id && leg.id === o.psp)
        || (legs.length === 1);
      if (!hit) return leg;
      matched = true;
      const out: Record<string, unknown> = {
        ...leg,
        capture: o.legFlag,
        captureId: leg.captureId ?? o.captureId,
      };
      if (o.tipMinor !== 0 && Number.isFinite(Number(leg.amountMinor))) {
        out.amountMinor = Number(leg.amountMinor) + o.tipMinor;
      }
      if (o.tipError) out.tipError = o.tipError; else delete out.tipError;
      return out;
    });
    if (matched) patch.payment_intents = next;
    else if (o.tipMinor === 0) return false;     // nothing to write at all
    else console.error('[tip_capture] no payment leg matched capture', o.captureId, 'on check', o.closedCheckId, '- tip/total updated without a leg patch');
    const { error: upErr } = await ops.from('closed_checks').update(patch).eq('id', o.closedCheckId);
    if (upErr) { console.error('[tip_capture] closed check update failed:', upErr.message, o.closedCheckId); return false; }
    return true;
  } catch (e) {
    console.error('[tip_capture] applyTipToClosedCheck:', (e as Error).message);
    return false;
  }
}

/**
 * Insert the capture-ledger row for a freshly settled manual-capture auth.
 * Idempotent on psp_reference (unique): a webhook backstop racing the charge
 * path lands harmlessly. Never throws.
 */
export async function insertCaptureRow(ops: any, o: {
  jobId: string | null;
  closedCheckId: string | null;
  locationId: string;
  psp: string;
  merchantAccount?: string | null;
  currency?: string | null;
  authMinor: number;
  simulated: boolean;
}): Promise<void> {
  try {
    let hours = 24;
    try {
      const { data: loc } = await ops.from('locations')
        .select('pos_settings').eq('id', o.locationId).maybeSingle();
      hours = readTipOnReceipt(loc?.pos_settings).capture_hours;
    } catch { /* default window */ }
    const { error } = await ops.from('terminal_captures').upsert({
      job_id: o.jobId,
      closed_check_id: o.closedCheckId,
      location_id: o.locationId,
      psp_reference: o.psp,
      merchant_account: o.merchantAccount ?? null,
      currency: o.currency ?? null,
      auth_minor: Math.round(o.authMinor),
      status: 'pending',
      deadline_at: new Date(Date.now() + hours * 3_600_000).toISOString(),
      simulated: o.simulated,
    }, { onConflict: 'psp_reference', ignoreDuplicates: true });
    if (error) {
      // LOUD: a lost row is an auth that could die uncaptured. The adyen-webhook
      // AUTHORISATION backstop re-ensures it when the notification arrives.
      console.error('[tip_capture] capture row insert FAILED:', error.message, o.psp);
    }
  } catch (e) {
    console.error('[tip_capture] insertCaptureRow:', (e as Error).message);
  }
}
