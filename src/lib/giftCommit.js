// src/lib/giftCommit.js
//
// Shared gift-card APPLY-ONLY staging + COMMIT-TIME redemption. Used by:
//   • the kiosk gift/promo checkout step (ScreenGiftPromo → submitOrder), and
//   • online checkout (applyGiftCard → onGiftOnlyPayment / onPaymentSuccess).
//
// v5.5.901: APPLY-ONLY. Entering/tapping a gift card now only LOOKS THE BALANCE UP
// (gift-lookup — read-only) and stages the discount in client state. NOTHING is debited
// server-side. The real debit (gift-redeem → redeem_gift_card_atomic) fires when the order
// COMMITS, keyed to the closed-check id — exactly the promo-code + loyalty pattern
// (v5.5.896/898, see lib/loyaltyRedeem.js).
//
// The bug this fixes: gift-redeem was called with `order_id: null` the moment the customer
// entered a card. Abandon the basket, idle out, or fail the card payment and the gift-card
// value was GONE — no order, no reversal (the only gift-reverse-redeem caller is the POS
// refund path). v5.5.900 widened the exposure by giving every kiosk guest a gift/promo step.
//
// Idempotency is belt AND braces, so a retry can never double-debit:
//   1. `commit_key` is minted ONCE at apply time and rides in the staged object, so every
//      retry of the same order attempt sends the SAME idempotency_key (unique constraint on
//      gift_card_transactions.idempotency_key + the atomic RPC dedupe it).
//   2. `closed_check_id` makes gift-redeem derive its own key server-side
//      (`giftcommit:<check>:<card>`), the way loyalty-redeem keys on closed_check_id — so a
//      caller that mints a fresh key per attempt still can't debit twice for one order.
// Callers MUST pass a closedCheckId that is STABLE across retries of the same order.

const newId = () => (
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

/**
 * Stage a gift card against the amount currently due. Pure — touches no server.
 * Partial balances are preserved: a card worth less than the bill applies what it has and
 * the remainder goes to the card reader / Stripe.
 *
 * @param {{ cardId:string, code?:string|null, codeLast4?:string|null,
 *           balanceMinor:number, amountDueMinor:number }} args
 * @returns staged { card_id, code, code_last4, applied, balance_at_apply,
 *                   remaining_balance, commit_key, pending_commit:true }
 */
export function stageGiftCard({ cardId, code = null, codeLast4 = null, balanceMinor = 0, amountDueMinor = 0 }) {
  const balance = Math.max(0, Math.round(balanceMinor || 0));
  const due = Math.max(0, Math.round(amountDueMinor || 0));
  const applied = Math.min(balance, due);
  return {
    card_id: cardId || null,
    code: code || null,
    code_last4: codeLast4 || (code ? String(code).slice(-4) : null),
    applied,
    balance_at_apply: balance,
    remaining_balance: Math.max(0, balance - applied),
    // Minted once, here — every commit attempt for this order reuses it.
    commit_key: `giftcommit:${cardId || code || 'card'}:${newId()}`,
    pending_commit: true,
  };
}

/**
 * Fire the real debit for a staged gift card. NEVER THROWS — a gift-card failure must never
 * stop an order the customer has already paid for. Returns what actually happened so the
 * caller can stamp the truth on closed_checks.
 *
 * @param {object} staged            the object from stageGiftCard()
 * @param {object} opts
 * @param {string} opts.functionsUrl `${VITE_SUPABASE_URL}/functions/v1`
 * @param {string} opts.token        bearer token (anon session is fine)
 * @param {string} opts.locationId   ops location id
 * @param {string} opts.channel      'kiosk' | 'online'
 * @param {string} opts.closedCheckId STABLE across retries — also used as order_id
 * @param {boolean} [opts.allowPartial=true] When the card lost value between apply and
 *        commit, take whatever IS left. Correct when the card leg has already been charged
 *        (kiosk, online+Stripe). Pass FALSE on a gift-only order, where a short card must
 *        debit NOTHING so the customer can go back and pay by card with the balance intact.
 * @returns {Promise<{ ok:boolean, applied:number, remaining_balance:number|null,
 *                     idempotency_key:string|null, card_id:string|null,
 *                     shortfall:number, error:string|null }>}
 */
export async function commitGiftCard(staged, { functionsUrl, token, locationId, channel, closedCheckId, allowPartial = true }) {
  const wanted = staged?.applied || 0;
  const fail = (error) => ({
    ok: false, applied: 0, remaining_balance: null, idempotency_key: null,
    card_id: staged?.card_id || null, shortfall: wanted, error,
  });

  if (!staged || !staged.pending_commit) {
    // Nothing staged, or an already-committed record (legacy consume-at-apply shape).
    return {
      ok: true, applied: wanted, remaining_balance: staged?.remaining_balance ?? null,
      idempotency_key: staged?.idempotency_key || staged?.commit_key || null,
      card_id: staged?.card_id || null, shortfall: 0, error: null,
    };
  }
  if (wanted <= 0) return fail('Nothing to redeem');
  if (!staged.card_id && !staged.code) return fail('Gift card reference missing');

  const post = async (amount) => {
    const res = await fetch(`${functionsUrl}/gift-redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        code: staged.code || undefined,
        card_id: staged.card_id || undefined,
        amount,
        order_id: closedCheckId,
        // v5.5.901: server derives its own idempotency key from this (see gift-redeem).
        closed_check_id: closedCheckId,
        location_id: locationId,
        channel,
        idempotency_key: staged.commit_key,
      }),
    });
    const j = await res.json().catch(() => ({}));
    return { res, j };
  };

  // One retry on a TRANSPORT failure. If the first call actually landed server-side and only
  // the response was lost, the same idempotency key comes back `already_applied` with the real
  // figures — so we record the debit that happened instead of reporting a false failure (which
  // would leave money off the card AND off the check).
  const postWithRetry = async (amount) => {
    try {
      return await post(amount);
    } catch (e) {
      console.warn('[giftCommit] transport error — retrying once:', e?.message || e);
      return post(amount);
    }
  };

  try {
    let { res, j } = await postWithRetry(wanted);

    // The card lost value between apply and commit (spent elsewhere in the meantime).
    // Recover what IS left rather than dropping the whole redemption — the customer has
    // already been charged the reduced amount, so every penny we can still claim counts.
    if (allowPartial && !res.ok && j?.error === 'Insufficient balance' && (j?.balance || 0) > 0) {
      const partial = Math.min(j.balance, wanted);
      console.warn(`[giftCommit] card short at commit — retrying with ${partial} of ${wanted}`);
      ({ res, j } = await postWithRetry(partial));
    }

    if (!res.ok || j?.error) return fail(j?.error || `HTTP ${res.status}`);

    const applied = j.applied ?? wanted;
    return {
      ok: true,
      applied,
      remaining_balance: j.remaining_balance ?? null,
      // The key the ledger row actually carries. gift-redeem derives its own from
      // closed_check_id, and gift-reverse-redeem (POS refund) needs the EXACT key to find
      // the transaction — so trust the server's echo, falling back to ours on an edge
      // function that predates v5.5.901 (which uses the key we sent).
      idempotency_key: j.idempotency_key || staged.commit_key,
      card_id: j.card_id || staged.card_id || null,
      shortfall: Math.max(0, wanted - applied),
      error: null,
    };
  } catch (e) {
    return fail(e?.message || 'Gift card redemption failed');
  }
}

/**
 * The closed_checks.gift_card jsonb for a committed (or failed) redemption.
 * `applied` is always what the server ACTUALLY debited, so reports never overstate
 * gift-card revenue. `idempotency_key` MUST be the key on the ledger row — the POS refund
 * path (store.refundCheck → gift-reverse-redeem) looks the original transaction up by it.
 */
export function giftCardCheckRecord(staged, commit) {
  if (!staged) return null;
  const failed = !!commit && !commit.ok;
  return {
    card_id: commit?.card_id || staged.card_id || null,
    code_last4: staged.code_last4 || null,
    applied: commit?.applied ?? staged.applied ?? 0,
    remaining_balance: commit?.remaining_balance ?? staged.remaining_balance ?? null,
    // Nothing was debited on a failed commit — leave the key null so a later refund SKIPS
    // the reversal rather than 404ing against a transaction that never existed.
    idempotency_key: failed ? null : (commit?.idempotency_key || staged.commit_key || null),
    ...(failed ? { commit_error: commit.error } : {}),
    ...(commit && commit.shortfall > 0 ? { uncollected: commit.shortfall } : {}),
  };
}

/**
 * v5.5.902 — the value for `closed_checks.gift_card`.
 *
 * ONE record for a normal check; the primary leg carrying `legs[]` when a SPLIT check was
 * part-paid by more than one gift card. Deliberately NOT a new column: `gift_card` keeps
 * its exact existing shape at the top level (card_id + idempotency_key, which the POS
 * refund reversal reads), so this ships with no migration to run first.
 *
 * @param {{giftCard?:object, giftCards?:Array}} paymentInfo
 */
export function giftRecordFrom(paymentInfo = {}) {
  const legs = (paymentInfo.giftCards || []).filter(Boolean);
  if (legs.length > 1) return { ...legs[0], legs };
  if (legs.length === 1) return legs[0];
  return paymentInfo.giftCard || null;
}

/**
 * Every gift card that paid toward a check — the one reader of the `legs` shape above.
 * A pre-v5.5.902 check has a bare record and no `legs`, so it yields exactly itself.
 */
export function giftLegs(check) {
  const g = check?.giftCard;
  if (!g) return [];
  return Array.isArray(g.legs) && g.legs.length ? g.legs : [g];
}
