// src/lib/commitRedemptions.js
//
// COMMIT-TIME loyalty / promo redemption for every channel (POS, kiosk, online, catering).
// The gift-card sibling of this is lib/giftCommit.js — same house pattern, same guarantees.
//
// The bug this fixes (audited 5 Aug 2026): all four channels showed the customer the
// discount, took the payment, then fired the redeem call WITHOUT awaiting it or looking at
// the result. `fetch` does NOT reject on 4xx/5xx, so the kiosk's lone `.catch()` saw nothing
// at all. A failed call left the stamp / points / one-time code UNCONSUMED — the discount was
// given away and the same reward could be redeemed again, indefinitely. The old comment
// ("idempotent, so a retry can't double-deduct") was answering the wrong question: there was
// no retry, so the only real failure mode was UNDER-deduction.
//
// IDEMPOTENCY — read before changing the payload. Both edge functions key on the CHECK ID:
//   loyalty-redeem  points → `redeem:<closed_check_id>:<reward_id>`
//                   stamps → `stampredeem:<closed_check_id>:<stamp_program_id>`
//   promo-redeem    `<order_id>:<CODE>` (we send it explicitly; the server derives the same)
// Without a closed_check_id, loyalty-redeem falls back to a 30-SECOND TIME WINDOW key — so a
// retry a minute later would deduct a SECOND time. That is why `closedCheckId` is mandatory
// here and why the queued retry replays the ORIGINAL body byte-for-byte instead of re-minting
// anything. (Note for the kiosk: pass the closed-check id, not the R1–R99 order ref — those
// recycle, and a recycled key would collapse two different orders into one redemption.)

import { queueWrite, getFailedItems, dismissItem } from '../sync/OfflineQueue';
import { reportSave } from './saveHealth';

const KIND = 'redemption';
const MAX_RETRIES = 5;
const POST_TIMEOUT_MS = 8000;

// Channels whose queue lives in a CUSTOMER's browser for a single order. Parking is still worth
// doing (a returning guest's next order would flush it), but it must never be REPORTED as queued:
// there is no second order to trigger the replay, so the caller has to surface the failure itself.
const NON_REPLAYABLE_CHANNELS = new Set(['online', 'catering']);

// Read the browser's OWN connectivity flag, never OfflineQueue.isOnline(): that one is a
// module-level snapshot taken at import time and only moved by listeners registered inside
// initOfflineQueue(), which is called from SyncBridge alone — and the public kiosk path renders
// KioskSurface with no SyncBridge, so on a real kiosk the flag is frozen at its page-load value
// forever. The gate is only worth having to stop an offline replay burning one of the five
// attempts, so anything we can't determine (no navigator) counts as online.
function browserOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

// Will anything in THIS browser ever actually replay a parked item? Two things can: a later
// successful commitRedemption here, and SyncBridge's boot/reconnect flush. A till gets both, a
// standalone kiosk mounts no SyncBridge but takes the next order minutes later — a one-order-per-
// visit customer checkout gets neither. A surface can answer explicitly with canReplay.
function isReplayable(spec) {
  if (typeof spec?.canReplay === 'boolean') return spec.canReplay;
  return !NON_REPLAYABLE_CHANNELS.has(String(spec?.channel || 'pos'));
}

// Build the edge-function call from a channel-agnostic spec. Returns null when the spec can't
// produce a safely-retryable call (no stable check id, no target, no code).
function buildCall(spec) {
  const checkId = String(spec?.closedCheckId || '').trim();
  if (!checkId) return null;

  if (spec.kind === 'promo') {
    const code = String(spec.code || '').trim().toUpperCase();
    if (!code) return null;
    return {
      fn: 'promo-redeem',
      id: `redeem:promo:${checkId}:${code}`,
      entity: 'promo redemption',
      name: `Promo code ${code}`,
      label: `Promo code ${code} — discount given, not yet deducted`,
      body: {
        action: 'redeem',
        code,
        order_id: checkId,
        location_id: spec.locationId || null,
        customer_id: spec.customerId || null,
        staff_id: spec.staffId || null,
        channel: spec.channel || 'pos',
        basket_value: Number(spec.basketValue) || 0,
        idempotency_key: `${checkId}:${code}`,
      },
    };
  }

  const target = spec.stampProgramId
    ? { stamp_program_id: spec.stampProgramId }
    : (spec.rewardId ? { reward_id: spec.rewardId } : null);
  if (!target) return null;
  const name = spec.stampProgramId ? 'Stamp card reward' : 'Loyalty reward';
  return {
    fn: 'loyalty-redeem',
    id: `redeem:loyalty:${checkId}:${spec.stampProgramId || spec.rewardId}`,
    entity: 'loyalty redemption',
    name,
    label: `${name} — discount given, not yet deducted`,
    body: {
      customer_id: spec.customerId || null,
      location_id: spec.locationId || null,
      ...target,
      channel: spec.channel || 'pos',
      closed_check_id: checkId,
      staff_id: spec.staffId || null,
    },
  };
}

// A hung socket does NOT reject — it hangs until the browser's own ~300s timeout. No surface
// awaits commitRedemption (POS, kiosk, online and catering all fire it alongside the sale), so the
// damage isn't a stalled order: it is that for those five minutes NOTHING happens — no park, no
// reportSave, and no "discounted but not deducted" warning to whoever is standing there — while in
// the replay loop one hung POST holds the pass's latch for just as long. The deadline turns that
// into a prompt AbortError, which both callers in this file treat as a retryable transport
// failure. Durability is unaffected: the parked body replays verbatim.
async function post(fn, body, { functionsUrl, token }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`${functionsUrl}/${fn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    // `bodyRead` matters: "the body said nothing was wrong" and "the body could not be read at
    // all" are different answers, and collapsing them into {} scores an unreadable 200 as a
    // successful deduction. The classic case is the deadline firing while the body is still
    // streaming — the headers already landed, so res.ok is true.
    let j = {};
    let bodyRead = true;
    try { j = (await res.json()) || {}; } catch { bodyRead = false; }
    return { res, j, bodyRead };
  } finally {
    clearTimeout(timer);   // the body read is inside the deadline too, so only clear once it's done
  }
}

// The status line alone proves nothing: fetch resolves on 4xx/5xx, and promo-redeem reports a
// refusal inside a 200 body ({ ok:false, reason }). Transport AND payload both have to agree.
// `retryable` is deliberately narrow — a business refusal ('already_used', 'Insufficient
// points', 'Reward already redeemed') will never succeed on a retry, and re-firing it forever
// would be noise. loyalty-redeem's 'already_processed' carries no error, so it reads as success.
function outcome(res, j, bodyRead) {
  // A 200 we never read is NOT a success — we have no idea whether the deduction was applied.
  // It is a transport failure, and a retryable one: the idempotency key means replaying a call
  // that did land comes back already-redeemed rather than deducting twice.
  if (res.ok && !bodyRead) return { ok: false, error: 'reply was cut off before it could be read', retryable: true };
  if (res.ok && !j?.error && j?.ok !== false) return { ok: true, error: null, retryable: false };
  return {
    ok: false,
    error: j?.error || j?.reason || `HTTP ${res.status}`,
    retryable: res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500,
  };
}

// Park a failed redemption in the SHARED durable queue (IndexedDB, survives reload).
//
// OfflineQueue's replay engine only speaks Supabase table ops — it cannot POST to an edge
// function — so the item is stored `permanentFailure: true` to keep that engine's hands off
// it. Left un-flagged it would burn five attempts on an "unknown item type" error and bury the
// real reason. retryPendingRedemptions() below owns the actual replay — and note that it is the
// ONLY reader of getFailedItems() in the app: there is no failure UI listing stranded writes, so a
// parked item is invisible to staff. That is why the caller is still told when !ok, and why a
// channel that can't replay reports queued:false rather than staying silent.
//
// The queue key is derived from the check id + target, so a repeat failure REPLACES the
// buffered copy instead of stacking a second deduction. Takes either a fresh call or a queue
// item read back out — same five fields, so a re-park is a straight rewrite. `attempts` at
// MAX_RETRIES is the TERMINAL park: the replay loop's guard skips it, so it is stored purely as
// the record that a discount was given and never deducted.
async function park(entry, lastError, attempts) {
  try {
    await queueWrite({
      id: entry.id,
      type: 'redeem',
      kind: KIND,
      fn: entry.fn,
      body: entry.body,           // replayed verbatim — this is the idempotency anchor
      entity: entry.entity,
      label: entry.label,
      lastError,
      redeemAttempts: attempts,   // queueWrite resets `attempts`, so we keep our own
      permanentFailure: true,
    });
    return true;
  } catch (e) {
    console.error('[commitRedemptions] could not buffer the undeducted redemption', e);
    return false;
  }
}

/**
 * Fire the real deduction for a staged loyalty reward or promo code. NEVER THROWS — a
 * redemption failure must not stop an order the customer has already paid for — but unlike the
 * old fire-and-forget calls it awaits the edge function's REPLY, checks it, and makes the failure
 * durable. No surface blocks the order on it — see post() for what that costs on a hung socket.
 *
 * @param {object} spec
 * @param {'loyalty'|'promo'} spec.kind
 * @param {string} spec.closedCheckId  REQUIRED. Globally unique and STABLE across retries of
 *                                     the same order — it is the server's idempotency anchor.
 * @param {string|null} spec.locationId      ops location id
 * @param {string|null} [spec.customerId]
 * @param {string|null} [spec.staffId]
 * @param {string} [spec.channel='pos']      'pos' | 'kiosk' | 'online' | 'qr' | 'catering'
 * @param {string} [spec.rewardId]           loyalty: points reward
 * @param {string} [spec.stampProgramId]     loyalty: stamp card (wins over rewardId)
 * @param {string} [spec.code]               promo: the code
 * @param {number} [spec.basketValue]        promo: subtotal the discount was granted against
 * @param {boolean} [spec.canReplay]         override the channel default (see isReplayable)
 * @param {object} opts
 * @param {string} opts.functionsUrl `${VITE_SUPABASE_URL}/functions/v1`
 * @param {string} opts.token        bearer token (anon session is fine)
 * @returns {Promise<{ ok:boolean, queued:boolean, error:string|null }>}
 *          ok       — the reward/code is provably consumed server-side
 *          queued   — not consumed, but buffered AND a replay really will be attempted. Once
 *                     buildCall() has produced a call every failure parks (including 'no auth
 *                     session', which never reaches the network); only some claim queued. False
 *                     for a terminal refusal (parked for the record, never re-sent) and for
 *                     'online'/'catering' (a customer-browser checkout never gets a second order
 *                     to trigger the replay). A spec buildCall() CAN'T turn into a call is the one
 *                     failure that parks nothing: there is no body to replay, so it returns
 *                     immediately with ok:false, queued:false and the caller must surface it.
 *          error    — what went wrong; !ok && !queued means the caller MUST surface it
 */
export async function commitRedemption(spec, { functionsUrl, token } = {}) {
  const call = buildCall(spec);
  if (!call) return { ok: false, queued: false, error: 'Redemption is missing its check id or target — nothing sent' };

  const replayable = isReplayable(spec);
  const fail = async (error, retryable) => {
    reportSave(call.entity, new Error(`${call.name} was discounted but NOT deducted — ${error}`));
    // Park either way, at different attempt counts. Retryable → 0, so the replay loop picks it up.
    // Terminal business refusal ('already_used', 'Reward already redeemed', any other 4xx) → the
    // cap, which the replay loop skips: not a retry, but the only DURABLE trace that a discount
    // was given away and never deducted. saveHealth is in-memory and no POS shell renders it, so
    // without this park a terminal refusal left nothing behind for the venue to find.
    const parked = await park(call, error, retryable ? 0 : MAX_RETRIES);
    // Only CLAIM queued when a replay is actually going to happen, because queued:true is what
    // tells the caller to stay silent. On online/catering that silence hid the failure completely.
    return { ok: false, queued: parked && retryable && replayable, error };
  };

  if (!functionsUrl || !token) return fail('no auth session', true);

  let result;
  try {
    result = await post(call.fn, call.body, { functionsUrl, token });
  } catch (e) {
    // A timeout has already spent the deadline; retrying inline would spend a second one before
    // anything is parked or reported. Park it and get out — the replay is the durability.
    if (e?.name === 'AbortError') return fail(`timed out after ${POST_TIMEOUT_MS / 1000}s`, true);
    // One retry on a TRANSPORT failure, same as giftCommit. The idempotency key is fixed, so a
    // first call that landed but lost its response comes back already-redeemed, not deducted twice.
    console.warn('[commitRedemptions] transport error — retrying once:', e?.message || e);
    try {
      result = await post(call.fn, call.body, { functionsUrl, token });
    } catch (e2) {
      return fail(e2?.message || 'network error', true);
    }
  }

  const o = outcome(result.res, result.j, result.bodyRead);
  if (!o.ok) return fail(o.error, o.retryable);

  reportSave(call.entity, null);
  // This call proves the network and the token are good — flush anything an earlier sale left
  // stranded. OfflineQueue's own engine cannot call an edge function, so this and SyncBridge's
  // boot/reconnect flush are the only two things that ever replay a parked deduction.
  retryPendingRedemptions({ functionsUrl, token }).catch(() => {});
  return { ok: true, queued: false, error: null };
}

// Two passes must never be in the air at once. This is fired unawaited after EVERY successful
// commit, so back-to-back sales overlap trivially — and both passes would read the same
// getFailedItems() snapshot and POST the same parked body, because dismissItem() only runs once
// the POST has returned. The SERVERS survive that: each path claims the idempotency key in ONE
// indivisible write, so the loser of a duplicate POST reports success having consumed nothing —
// promo-redeem in promo_redeem_atomic (Ops; the promo_codes row is locked FOR UPDATE and the
// ledger row + the use are one transaction) → 'idempotent_hit'; loyalty-redeem's POINTS path in
// loyalty_redeem_points (Platform; customer_loyalty locked, claim row + debit one transaction) →
// 'already_redeemed', with the Ops ledger row written AFTERWARDS as audit (upserted, so a replay
// re-lands it rather than colliding); loyalty-redeem's STAMP path still on the ledger insert
// itself, whose UNIQUE idempotency_key violation becomes 'already_processed'. This side is what
// doesn't survive it — two passes double-count redeemAttempts, and a slow pass's park() can
// rewrite a row the fast pass has already dismissed, resurrecting a deduction that is settled.
// Same latch as OfflineQueue.replayQueue.
let _replaying = false;
// Per-item ownership, held across the await. Belt-and-braces only: the latch above already turns
// every overlapping caller away, including SyncBridge's, so nothing reaches here concurrently
// today. It exists so that relaxing the latch (e.g. to queue a pass rather than drop it) cannot
// silently re-open the double-POST it was added to close.
const _inFlight = new Set();

// A replay has no caller to hand a result to, and nothing in the app renders getFailedItems() —
// so once an item stops being retried, reporting it here is the ONLY way anyone learns the
// discount was given and never deducted. Same channel commitRedemption's own fail() uses.
function reportTerminal(item, error) {
  reportSave(item.entity || 'redemption', new Error(`${item.label || 'Redemption'} — no longer being retried: ${error}`));
}

/**
 * Replay redemptions parked by commitRedemption. Safe to call at any time — every retry
 * replays the original body, so the server's per-check idempotency key makes a redemption that
 * actually landed come back as already-redeemed rather than deducting twice.
 *
 * Called automatically after each successful commit; exported so a surface can also flush on
 * boot or on reconnect. Re-entrant calls return immediately rather than queueing up.
 *
 * @param {{functionsUrl:string, token:string}} opts
 */
export async function retryPendingRedemptions({ functionsUrl, token } = {}) {
  if (!functionsUrl || !token || !browserOnline()) return;
  if (_replaying) return;
  _replaying = true;   // set before the first await, so an overlapping caller can't slip past
  try {
    let items;
    try { items = await getFailedItems(); } catch { return; }
    for (const it of items) {
      if (it.kind !== KIND || !it.fn || !it.body) continue;
      if ((it.redeemAttempts || 0) >= MAX_RETRIES) continue;   // retried out, or parked terminally — never re-send
      if (_inFlight.has(it.id)) continue;                      // someone else already owns this deduction
      _inFlight.add(it.id);
      try {
        let res, j, bodyRead;
        try {
          ({ res, j, bodyRead } = await post(it.fn, it.body, { functionsUrl, token }));
        } catch (e) {
          const error = e?.message || 'network error';
          const attempts = (it.redeemAttempts || 0) + 1;
          await park(it, error, attempts);
          if (attempts >= MAX_RETRIES) reportTerminal(it, error);
          continue;
        }
        const o = outcome(res, j, bodyRead);
        if (o.ok) {
          await dismissItem(it.id).catch(() => {});
          reportSave(it.entity || 'redemption', null);
          continue;
        }
        // A business refusal can never succeed later — park it at the cap (the terminal state the
        // guard above skips) rather than re-firing it on every subsequent sale.
        const attempts = o.retryable ? (it.redeemAttempts || 0) + 1 : MAX_RETRIES;
        await park(it, o.error, attempts);
        if (attempts >= MAX_RETRIES) reportTerminal(it, o.error);   // out of retries, or never had any
      } finally {
        _inFlight.delete(it.id);
      }
    }
  } finally {
    _replaying = false;
  }
}
