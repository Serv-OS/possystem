/**
 * refundMath.js — the money maths behind a refund. Pure functions, no I/O.
 *
 * WHY THIS EXISTS (v5.6.79, tasks #107 + #108)
 *
 * `store.refundCheck` computed a refund from ITEMS ONLY and decided full-vs-partial
 * against `subtotal`. So a "full" refund never returned the tip or the service
 * charge: the customer kept paying a gratuity on a meal they did not have, the
 * check's tax stayed overstated, and the tronc pool still counted a tip that had
 * been given back. Every sale ever taken was affected.
 *
 * The maths lives here, apart from the store, because it is the part that must be
 * provably right: it is unit-tested (`refundMath.test.js`) rather than reasoned
 * about inside a 6000-line Zustand file.
 *
 * TWO UNITS, ONE RULE. Everything the operator sees is POUNDS (the store's idiom,
 * rendered with `money()`); everything a processor sees is MINOR UNITS. Convert
 * once, at the boundary, with `toMinor` — never round twice.
 */

/** Round to pennies. The single rounding point for pounds in this module. */
export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** £ → whole minor units. */
export const toMinor = (gbp) => {
  const n = Math.round((Number(gbp) || 0) * 100);
  return Number.isFinite(n) ? n : 0;
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * What has already been given back on this check, split three ways.
 *
 * LEGACY ENTRIES. Refunds written before v5.6.79 carry an items-only `amount` and
 * no `tipAmount`/`serviceAmount`. Reading a missing split as zero is correct for
 * them — the tip genuinely was not refunded — so old checks total up honestly and
 * a later refund can still return the tip that was never given back.
 *
 * A refund whose card reversal FAILED still counts here: the operator's decision
 * was recorded and the items are marked refunded. Retrying the reversal (see
 * `store.retryRefundReversal`) moves money without adding a second ledger entry.
 */
export function refundedSoFar(check) {
  const list = Array.isArray(check?.refunds) ? check.refunds : [];
  let items = 0, tip = 0, service = 0, total = 0;
  for (const r of list) {
    const amount = num(r?.amount);
    const t = num(r?.tipAmount);
    const s = num(r?.serviceAmount);
    total += amount;
    tip += t;
    service += s;
    // The items portion is whatever the entry was NOT tip or service.
    items += amount - t - s;
  }
  return { items: r2(items), tip: r2(tip), service: r2(service), total: r2(total) };
}

/**
 * The denominator for pro-rata. The sum of the check's own line values, because
 * that is the same basis the selected refund items are priced on. Falls back to
 * `subtotal` for a check whose items did not survive (a headless close).
 */
export function itemsBasis(check) {
  const items = Array.isArray(check?.items) ? check.items : [];
  const sum = items
    .filter((i) => !i?.voided)
    .reduce((s, i) => s + num(i?.price) * (num(i?.qty) || 1), 0);
  return r2(sum > 0 ? sum : num(check?.subtotal));
}

/**
 * Work out what a refund should actually return.
 *
 * FULL refund  → everything not yet given back: `total − alreadyRefunded`.
 *                `total` is what the customer PAID (items + service + tip, net of
 *                any discount), which is the only figure it can be. Refunding
 *                `subtotal` — the old behaviour — returned neither the tip nor the
 *                service charge, and on a discounted check returned more than was
 *                ever taken.
 *
 * PARTIAL refund → the selected items, PLUS a pro-rata slice of the tip and the
 *                service charge. Pro-rata is the default rather than the rule:
 *                a customer sending back one course of four has a fair claim to a
 *                quarter of the service charge, but the operator sees both figures
 *                and can override either (a goodwill full tip back, or none at all
 *                when the complaint is not about service). `tipOverride` /
 *                `serviceOverride` of `null` means "use pro-rata"; `0` is a real,
 *                deliberate zero.
 *
 * Every component is clamped to what actually remains, and the grand total is
 * clamped to the check's remaining value — cumulative refunds can never exceed
 * what the customer paid.
 *
 * @returns {{itemsAmount:number, tip:number, service:number, amount:number,
 *            proRataTip:number, proRataService:number,
 *            tipRemaining:number, serviceRemaining:number,
 *            maxRefund:number, share:number, isFullRefund:boolean}}
 */
export function refundBreakdown(check, {
  items = [],
  isFullRefund = false,
  tipOverride = null,
  serviceOverride = null,
} = {}) {
  const done = refundedSoFar(check);
  const total = num(check?.total);
  const maxRefund = r2(Math.max(0, total - done.total));
  const tipRemaining = r2(Math.max(0, num(check?.tip) - done.tip));
  const serviceRemaining = r2(Math.max(0, num(check?.service) - done.service));

  if (isFullRefund) {
    // Everything left, apportioned so the ledger keeps a truthful three-way split.
    // Items take the remainder rather than being computed independently, so the
    // three parts always re-sum to `amount` exactly (no penny drifting loose).
    const tip = r2(Math.min(tipRemaining, maxRefund));
    const service = r2(Math.min(serviceRemaining, Math.max(0, maxRefund - tip)));
    const itemsAmount = r2(Math.max(0, maxRefund - tip - service));
    return {
      itemsAmount, tip, service, amount: maxRefund,
      proRataTip: tip, proRataService: service,
      tipRemaining, serviceRemaining, maxRefund, share: 1, isFullRefund: true,
    };
  }

  const selected = r2(
    (Array.isArray(items) ? items : [])
      .reduce((s, i) => s + num(i?.price) * (num(i?.refundQty) || 0), 0),
  );
  const basis = itemsBasis(check);
  const share = basis > 0 ? clamp(selected / basis, 0, 1) : 0;

  const proRataTip = r2(tipRemaining * share);
  const proRataService = r2(serviceRemaining * share);

  const tip = clamp(r2(tipOverride == null ? proRataTip : num(tipOverride)), 0, tipRemaining);
  const service = clamp(r2(serviceOverride == null ? proRataService : num(serviceOverride)), 0, serviceRemaining);

  // Clamp the whole refund to what is left on the check, trimming the items
  // portion first — the tip and service figures are the ones the operator just
  // looked at and agreed to, so they are the last thing we quietly change.
  let itemsAmount = selected;
  let amount = r2(itemsAmount + tip + service);
  if (amount > maxRefund) {
    itemsAmount = r2(Math.max(0, maxRefund - tip - service));
    amount = r2(itemsAmount + tip + service);
  }

  return {
    itemsAmount: r2(itemsAmount), tip, service, amount,
    proRataTip, proRataService,
    tipRemaining, serviceRemaining, maxRefund, share, isFullRefund: false,
  };
}

/**
 * The check's card legs, normalised. One entry per card that paid.
 *
 * A split check carries `paymentIntents` = one entry per leg, the till/final leg
 * FIRST (that ordering is load-bearing: `attachCardToIntents` stamps the till's
 * own card block onto slot 0). A single-card check normalises to a 1-element list,
 * so every downstream path has exactly one shape to handle.
 *
 * PROCESSOR PER LEG. A leg may name its own processor; otherwise it inherits the
 * check's. That inheritance is what makes an Adyen check route to Adyen instead of
 * falling into the old `!== 'ryft' ? stripe` trap, which aimed every Adyen refund
 * at Stripe where it landed nowhere at all.
 */
export function cardLegsOf(check) {
  const fallbackProcessor = String(check?.processor || 'stripe').toLowerCase();
  const arr = (Array.isArray(check?.paymentIntents) && check.paymentIntents.length)
    ? check.paymentIntents
    : (check?.stripePaymentIntentId
        ? [{ id: check.stripePaymentIntentId, amountMinor: toMinor(check?.total) }]
        : []);
  return arr
    .filter((p) => p && p.id)
    .map((p, index) => ({
      index,
      id: String(p.id),
      amountMinor: Number.isFinite(Number(p.amountMinor)) && Number(p.amountMinor) > 0
        ? Math.round(Number(p.amountMinor)) : null,
      processor: String(p.processor || fallbackProcessor).toLowerCase(),
      card: p.card || null,
      brand: p.card?.brand || null,
      last4: p.card?.last4 || null,
    }));
}

/**
 * Leg outcomes that mean MONEY IS MOVING and the leg's headroom is spent.
 *
 *   'succeeded' the processor confirmed the refund synchronously (Stripe, Ryft).
 *   'accepted'  the processor took the request and will settle it asynchronously.
 *               Adyen answers `received` and the truth arrives later by webhook,
 *               so this is the strongest word we are entitled to use. It is NOT
 *               'succeeded' — presenting it as a completed refund would be the
 *               exact lie this rebuild exists to stop — but it absolutely counts
 *               against the leg's cap, or a retry would refund the card twice.
 */
export const MOVED_STATUSES = ['succeeded', 'accepted'];
export const legMoved = (leg) => MOVED_STATUSES.includes(leg?.status);

/** How much of a refund each leg has already had, keyed by leg id. */
export function legRefundedMinor(check) {
  const out = {};
  for (const r of (Array.isArray(check?.refunds) ? check.refunds : [])) {
    for (const leg of (Array.isArray(r?.legs) ? r.legs : [])) {
      // A FAILED reversal moved no money, so its headroom is still there to
      // retry into. Everything in MOVED_STATUSES is spent.
      if (!legMoved(leg)) continue;
      const id = leg?.id ? String(leg.id) : null;
      if (!id) continue;
      out[id] = (out[id] || 0) + (Number(leg.amountMinor) || 0);
    }
  }
  return out;
}

/**
 * Split a refund across the card legs.
 *
 * Without per-leg amounts from the operator this fills legs from the front, each
 * up to its own remaining captured amount — the pre-existing behaviour, so a
 * single-card check is unchanged. With `overrides` (the per-leg picker) each leg
 * takes exactly what the operator chose, still clamped to its own headroom so one
 * card can never be refunded with another card's money.
 *
 * THE CAP IS NEW AND DELIBERATE. A single leg used to be handed the whole
 * requested amount on the theory that the processor would enforce the real cap.
 * That was fine while the amount was items-only, but a full refund now returns
 * `total` — which on a part-gift-paid check is more than the card ever took. The
 * cap keeps the card reversal to the card's own money and hands the rest back to
 * the gift/loyalty reversal that owns it. A leg with an UNKNOWN captured amount
 * (`amountMinor: null`) is not capped: guessing there would under-refund, so the
 * processor stays the authority exactly as before.
 *
 * @param {Array} legs        from `cardLegsOf`
 * @param {number} amountMinor total card money to return
 * @param {object} overrides  { [legId]: minorUnits } from the per-leg picker
 * @param {object} already    { [legId]: minorUnits } from `legRefundedMinor`
 * @returns {{allocations: Array, unallocatedMinor: number}}
 */
export function allocateToLegs(legs, amountMinor, overrides = null, already = {}) {
  const list = Array.isArray(legs) ? legs : [];
  const headroom = (leg) => (leg.amountMinor == null
    ? null
    : Math.max(0, leg.amountMinor - (Number(already[leg.id]) || 0)));

  if (overrides && Object.keys(overrides).length) {
    const allocations = list
      .map((leg) => {
        const want = Math.max(0, Math.round(Number(overrides[leg.id]) || 0));
        const room = headroom(leg);
        return { ...leg, refundMinor: room == null ? want : Math.min(want, room) };
      })
      .filter((l) => l.refundMinor > 0);
    const used = allocations.reduce((s, l) => s + l.refundMinor, 0);
    return { allocations, unallocatedMinor: Math.max(0, Math.round(amountMinor) - used) };
  }

  let remain = Math.max(0, Math.round(Number(amountMinor) || 0));
  const allocations = [];
  for (const leg of list) {
    if (remain <= 0) break;
    const room = headroom(leg);
    const take = room == null ? remain : Math.min(remain, room);
    if (take <= 0) continue;
    allocations.push({ ...leg, refundMinor: take });
    remain -= take;
  }
  return { allocations, unallocatedMinor: remain };
}

/**
 * The idempotency key for one leg of one refund.
 *
 * Keyed on the REFUND ENTRY, not the check, so two separate partial refunds of the
 * same card are two different operations. Keyed on the leg too, so a retry after a
 * partial failure cannot re-refund a leg that already went through.
 *
 * LENGTH IS A HARD CONSTRAINT ON ADYEN. Its Idempotency-Key must be ≤ 64 chars,
 * and `adyen-modify` prefixes ours with `mod:` (4). Adyen also REPLAYS the first
 * response for a reused key — which is precisely what a retry wants: if the first
 * attempt actually succeeded and we simply lost the answer, the replay tells us so
 * instead of taking the money twice.
 */
export const ADYEN_REFERENCE_MAX = 58;   // 58 + 'mod:' = 62, inside Adyen's 64
export function refundReference(refundId, legId) {
  return `rf:${refundId}:${legId}`.slice(0, ADYEN_REFERENCE_MAX);
}

/**
 * Roll the per-leg outcomes into one verdict for the refund entry.
 *
 *   'none'      no card leg to reverse (a cash refund, or a check with no linked
 *               card payment) — the operator is told to handle it by hand.
 *   'succeeded' every leg came back CONFIRMED.
 *   'accepted'  every leg moved, but at least one is still settling at the
 *               processor. Money is on its way; nobody should call it done.
 *   'partial'   some legs moved and some FAILED. The dangerous one, and the whole
 *               reason this is not a boolean.
 *   'failed'    nothing moved.
 *
 * Only 'succeeded' may be presented as a completed refund.
 */
export function rollUpLegStatus(legs) {
  const list = (Array.isArray(legs) ? legs : []).filter((l) => l && l.status !== 'skipped');
  if (!list.length) return 'none';
  const moved = list.filter(legMoved);
  if (!moved.length) return 'failed';
  if (moved.length < list.length) return 'partial';
  return moved.some((l) => l.status === 'accepted') ? 'accepted' : 'succeeded';
}

/** Legs of a recorded refund that can still be retried (nothing moved on them). */
export function retryableLegs(refund) {
  return (Array.isArray(refund?.legs) ? refund.legs : []).filter((l) => l?.status === 'failed');
}
