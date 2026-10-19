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

import { resolveLineTaxRate } from '../tax.js';
import { isScaledTaxRecord } from '../taxShare.js';

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
  let items = 0, tip = 0, service = 0, total = 0, addedTax = 0;
  for (const r of list) {
    const amount = num(r?.amount);
    const t = num(r?.tipAmount);
    const s = num(r?.serviceAmount);
    // v5.9.12: the added-on sales tax that went back. Entries before v5.9.12
    // (and every inclusive-VAT entry) have none, read as 0.
    const x = num(r?.addedTaxAmount);
    total += amount;
    tip += t;
    service += s;
    addedTax += x;
    // The items portion is whatever the entry was NOT tip, service or added tax.
    items += amount - t - s - x;
  }
  return { items: r2(items), tip: r2(tip), service: r2(service), addedTax: r2(addedTax), total: r2(total) };
}

/**
 * v5.9.12: the ADDED-ON sales tax this check charged (US exclusive tax, rounded
 * as it was charged). 0 for an inclusive-only check (every UK check: VAT is
 * inside the prices, so a refund of the items already returns it) and for a
 * check with no stored breakdown.
 */
export function addedOnTaxOf(check) {
  const t = check?.taxBreakdown;
  if (!t || !t.hasExclusiveTax) return 0;
  return r2(Math.max(0, num(t.exclusiveTax)));
}

/**
 * v5.9.12: the added-on tax a PART refund gives back. Each selected line returns
 * the tax its goods carried (taxBreakdown.lineTaxes, raw, one per live check
 * item, written at close) times the share of its quantity returned; the tax on
 * the service charge goes back in proportion to the service refunded (the
 * operator may keep the service, and then its tax stays too); delivery is not
 * refunded on a part refund, so neither is its tax. A check without per-line
 * figures falls back to pro rata by value (the same rule as the tip and the
 * service), over the goods part when the service tax is known. Unrounded: the
 * caller rounds once.
 */
export function selectedAddedOnTax(check, items, share, serviceRefunded = 0) {
  const total = addedOnTaxOf(check);
  if (!(total > 0)) return 0;
  const tb = check?.taxBreakdown || {};
  const svcTax = num(tb.serviceTax);
  const svcTotal = num(check?.service);
  const svcPart = svcTax > 0 && svcTotal > 0 ? svcTax * Math.min(1, num(serviceRefunded) / svcTotal) : 0;
  const goodsTotal = Math.max(0, total - svcTax - num(tb.deliveryTax));
  const lineTaxes = tb.lineTaxes;
  const live = (Array.isArray(check?.items) ? check.items : []).filter((i) => !i?.voided);
  if (Array.isArray(lineTaxes) && lineTaxes.length === live.length) {
    let sum = 0;
    for (const i of (Array.isArray(items) ? items : [])) {
      const idx = live.findIndex((c) => c === i || (c?.uid != null && c.uid === i?.uid));
      if (idx < 0) return goodsTotal * share + svcPart;   // cannot place a line: pro rata instead
      const qty = num(live[idx]?.qty) || 1;
      sum += num(lineTaxes[idx]) * Math.min(1, (num(i?.refundQty) || 0) / qty);
    }
    return sum + svcPart;
  }
  return svcTax > 0 ? goodsTotal * share + svcPart : total * share;
}

/**
 * 27 Sep 2026 (review of the Leeds VAT fix): the bill a refund's VAT is pro rated
 * against. A reader close stores `total` as the CARD part only (the gift card taken
 * before the job was sent is not in it), so pro rating the check's whole VAT against
 * that total reversed far too much: a £10 sale paid £8 gift card plus £2 card gave back
 * all £1.67 of its VAT on a £2 refund. The money that settled the whole bill is the
 * tenders (every one: gift card, card, credits) less the tip; `total` stays the basis
 * whenever it is the larger (the till stores the gross, so its total already includes
 * every tender plus the tip, and nothing changes there), and for rows with no tenders.
 */
export function refundTaxBasis(check) {
  const total = num(check?.total);
  const tenders = Array.isArray(check?.tenders) ? check.tenders : [];
  if (!tenders.length) return total;
  const settled = r2(tenders.reduce((s, t) => s + num(t?.amount) + num(t?.tip), 0) - num(check?.tip));
  return Math.max(total, settled);
}

/**
 * 19 Oct 2026 (v5.11.78, channel parity): each live line's own share of a check's booked UK VAT,
 * so a part refund gives back the VAT of the lines it returns (Peter, 8 Oct: "VAT ... should
 * follow the Tax rules set on the back office per menu item"; the sale already did, the refund
 * did not). A line's weight is its goods (price x qty) times its own rate's fraction r / (1 + r),
 * the rate resolved by the one line rule (tax.js resolveLineTaxRate) for the check's order type.
 *
 * The weights are only used when they reproduce the record the sale booked: every rate bucket in
 * taxBreakdown.breakdown must equal the weights for that rate (times the record's share when the
 * bill was discounted, taxShare). Anything else (added on US tax, a real tax profile assigned by
 * category, a line that cannot be placed, an older row with no breakdown) returns null and the
 * caller keeps the money pro rata rule. Rates are the record's own first, then the venue's.
 */
export function lineVatWeights(check, taxRates = []) {
  const t = check?.taxBreakdown;
  if (!t || typeof t !== 'object' || t.hasExclusiveTax) return null;
  const breakdown = Array.isArray(t.breakdown) ? t.breakdown : [];
  if (!breakdown.length) return null;
  const live = (Array.isArray(check?.items) ? check.items : []).filter((i) => i && !i.voided);
  if (!live.length) return null;
  const rates = [
    ...breakdown.map((b) => b?.rate).filter((r) => r && r.id != null),
    ...(Array.isArray(taxRates) ? taxRates : []),
  ];
  const orderType = check?.orderType || check?.order_type || 'dine-in';
  const share = isScaledTaxRecord(t) ? Number(t.share) : 1;
  const perRate = new Map();
  const lines = [];
  for (const l of live) {
    const { rate } = resolveLineTaxRate(l, rates, orderType);
    const r = rate ? num(rate.rate) : 0;
    if (rate && rate.type && rate.type !== 'inclusive' && r > 0) return null;
    const unitVat = num(l.price) * (r > 0 ? r / (1 + r) : 0);
    const qty = num(l.qty) || 1;
    if (rate) perRate.set(rate.id, (perRate.get(rate.id) || 0) + unitVat * qty);
    lines.push({ line: l, unitVat, qty });
  }
  // The weights must BE the booked record, bucket for bucket, or they are not used.
  for (const b of breakdown) {
    const id = b?.rate?.id;
    if (id == null) return null;
    if (Math.abs((perRate.get(id) || 0) * share - num(b.tax)) > 0.01) return null;
  }
  for (const [id, v] of perRate) {
    if (v * share > 0.01 && !breakdown.some((b) => b?.rate?.id === id)) return null;
  }
  const totalRaw = lines.reduce((s, x) => s + x.unitVat * x.qty, 0);
  return { lines, totalRaw };
}

/** The VAT already given back on this check (the refunds[].taxAmount recorded so far). */
export function vatRefundedSoFar(check) {
  return (Array.isArray(check?.refunds) ? check.refunds : []).reduce((s, r) => s + num(r?.taxAmount), 0);
}

/**
 * The tax a refund gives back, for refunds[].taxAmount (the VAT reports net off).
 *
 * A check whose tax is ALL added on (US) returns exactly the breakdown's figure for the refunded
 * lines (bd.tax, v5.9.12). Null when the check stored no tax.
 *
 * 19 Oct 2026 (v5.11.78, channel parity): UK VAT follows the lines refunded, not the money.
 *   - a part refund that names its lines gives back those lines' own VAT (lineVatWeights: each
 *     line's goods at its own rate, as the sale booked it, after any bill discount), times the
 *     share of them actually refunded when the refund was capped at what is left. The tip and
 *     the service charge carry no VAT (UK VAT is never charged on either, taxEngine), so a tip
 *     only refund gives back 0. Before, the check's whole VAT was spread over the money: on a
 *     takeaway 3.50 drink (20%) plus a 4.00 cold sandwich (0%), refunding the sandwich gave back
 *     0.31 of VAT it never carried, refunding the drink 0.27 of its 0.58, and a tip only refund
 *     gave VAT back;
 *   - the refund that brings the bill's money to nothing gives back all the VAT left, so line by
 *     line refunds of a discounted check never strand VAT;
 *   - anything that cannot be placed line by line (older rows, records the weights do not
 *     reproduce, a full refund of only the card part of a gift card split) keeps the pro rata
 *     rule against refundTaxBasis, with the tip taken out of both sides;
 *   - never more than the VAT still on the check.
 * A one rate check with no tip and no service charge gives back exactly what it did before.
 *
 * @param {object} check  the check BEFORE this refund
 * @param {object} bd     refundBreakdown(check, ...) for this refund
 * @param {object} [opts] { items: the refunded lines ({ uid, price, refundQty }), taxRates: the venue's rates }
 */
export function refundTaxAmount(check, bd, opts = {}) {
  const amount = num(bd?.amount);
  const addedOnly = num(bd?.tax) > 0 && check?.taxAmount != null
    && Math.abs(num(check.taxAmount) - addedOnTaxOf(check)) < 0.01;
  if (addedOnly) return bd.tax;
  if (check?.taxAmount == null) return null;
  const basis = refundTaxBasis(check);
  if (!(basis > 0)) return null;
  const taxAmount = num(check.taxAmount);
  const vatLeft = Math.max(0, taxAmount - vatRefundedSoFar(check));
  const checkTip = num(check?.tip);
  const bdTip = num(bd?.tip);
  const done = refundedSoFar(check);
  // Does this refund bring the money that settled the bill (less tip) to nothing?
  const basisExTip = Math.max(0, basis - checkTip);
  const clearsBill = basisExTip > 0 && (done.total - done.tip) + (amount - bdTip) >= basisExTip - 0.005;
  if (clearsBill) return r2(vatLeft);

  const items = Array.isArray(opts?.items) ? opts.items : [];
  if (!bd?.isFullRefund) {
    const plan = lineVatWeights(check, opts?.taxRates);
    if (plan) {
      if (!items.length) return 0;   // a tip or service only refund: no VAT went with it
      let selectedVat = 0;
      let selectedValue = 0;
      let placed = true;
      for (const it of items) {
        const hit = plan.lines.find((x) => x.line === it || (x.line?.uid != null && x.line.uid === it?.uid));
        if (!hit) { placed = false; break; }
        const q = Math.min(Math.max(0, num(it?.refundQty)), hit.qty);
        selectedVat += hit.unitVat * q;
        selectedValue += num(it?.price) * (num(it?.refundQty) || 0);
      }
      if (placed) {
        const lineVat = plan.totalRaw > 0 ? taxAmount * (selectedVat / plan.totalRaw) : 0;
        const capped = selectedValue > 0 ? Math.min(1, num(bd?.itemsAmount) / selectedValue) : 0;
        return r2(Math.min(vatLeft, Math.max(0, lineVat * capped)));
      }
    }
  }
  // Pro rata on the money, the tip left out of both sides (a tip carries no VAT).
  const money = Math.max(0, amount - bdTip);
  return basisExTip > 0 ? r2(Math.min(vatLeft, taxAmount * (money / basisExTip))) : null;
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
  // v5.9.12: added-on sales tax still held (0 on every inclusive-VAT check).
  const taxRemaining = r2(Math.max(0, addedOnTaxOf(check) - done.addedTax));

  if (isFullRefund) {
    // Everything left, apportioned so the ledger keeps a truthful split.
    // Items take the remainder rather than being computed independently, so the
    // parts always re-sum to `amount` exactly (no penny drifting loose).
    const tip = r2(Math.min(tipRemaining, maxRefund));
    const service = r2(Math.min(serviceRemaining, Math.max(0, maxRefund - tip)));
    const tax = r2(Math.min(taxRemaining, Math.max(0, maxRefund - tip - service)));
    const itemsAmount = r2(Math.max(0, maxRefund - tip - service - tax));
    return {
      itemsAmount, tip, service, tax, amount: maxRefund,
      proRataTip: tip, proRataService: service,
      tipRemaining, serviceRemaining, taxRemaining, maxRefund, share: 1, isFullRefund: true,
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
  // v5.9.12: the added-on sales tax those items carried goes back with them
  // (before, a partial refund returned the goods but kept their tax). Not an
  // operator choice: it is what the customer was charged on those lines.
  const tax = taxRemaining > 0 ? clamp(r2(selectedAddedOnTax(check, items, share, service)), 0, taxRemaining) : 0;

  // Clamp the whole refund to what is left on the check, trimming the items
  // portion first — the tip and service figures are the ones the operator just
  // looked at and agreed to, so they are the last thing we quietly change.
  let itemsAmount = selected;
  let amount = r2(itemsAmount + tip + service + tax);
  if (amount > maxRefund) {
    itemsAmount = r2(Math.max(0, maxRefund - tip - service - tax));
    amount = r2(itemsAmount + tip + service + tax);
  }

  return {
    itemsAmount: r2(itemsAmount), tip, service, tax, amount,
    proRataTip, proRataService,
    tipRemaining, serviceRemaining, taxRemaining, maxRefund, share, isFullRefund: false,
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
 *
 * WHERE THE LEGS COME FROM (28 Sep 2026, Leeds R6404). First the leg list, then the
 * single id, each under its camelCase name and then the row's own snake_case name (a
 * MasterSync copy or a raw row carries only those). Last, the card TENDERS: every reader
 * sale since v5.9.11 records its psp_ref there, so a copy that lost the other two can
 * still refund to the card instead of "issue the card refund manually". A check with
 * none of the three has no card leg, exactly as before. A leg built from a tender routes
 * by the processor that tender names (written where the card was taken). A copy with no
 * processor at all takes its matching tender's, never a guessed 'stripe'; copies made by
 * closedCheckRefundFields always carry the row's processor, so they route exactly as the
 * boot loaders always have. No row in the Ops DB on 28 Sep had a card tender as its only
 * card record, so this changes no existing sale; it is the fallback for short copies and
 * for writers that record only tenders (the QR force close in Orders).
 */
function cardTendersOf(check) {
  return (Array.isArray(check?.tenders) ? check.tenders : [])
    .filter((t) => t && t.method === 'card' && t.psp_ref);
}

export function cardLegsOf(check) {
  const cardTenders = cardTendersOf(check);
  const tenderProcessor = (id) =>
    cardTenders.find((t) => String(t.psp_ref) === String(id) && t.processor)?.processor || null;
  // A list counts only when it names a card (an id). One holding only booking credit legs
  // (id null) is what a reader close with a booking deposit writes, and its card is then the
  // single id or the tender: skipping them left that sale "manual" (28 Sep review).
  const intents = [check?.paymentIntents, check?.payment_intents]
    .find((list) => Array.isArray(list) && list.some((p) => p && p.id));
  const singleId = check?.stripePaymentIntentId || check?.stripe_payment_intent_id || null;
  const arr = intents
    || (singleId
      ? [{ id: singleId, amountMinor: toMinor(check?.total) }]
      : cardTenders.map((t) => ({
        id: t.psp_ref,
        amountMinor: toMinor((Number(t.amount) || 0) + (Number(t.tip) || 0)),
        processor: t.processor || null,
      })));
  return arr
    .filter((p) => p && p.id)
    .map((p, index) => ({
      index,
      id: String(p.id),
      amountMinor: Number.isFinite(Number(p.amountMinor)) && Number(p.amountMinor) > 0
        ? Math.round(Number(p.amountMinor)) : null,
      processor: String(p.processor || check?.processor || tenderProcessor(p.id) || 'stripe').toLowerCase(),
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
