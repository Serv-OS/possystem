// src/lib/accounting/tenders.js
//
// closed_checks.tenders (v5.9.11, 19 Sep 2026): WHAT PAID THE CHECK, one entry per tender,
//   [{ method, amount, tip, gift_card_id?, psp_ref?, processor? }]
// in major units (pounds, dollars; 2 decimals, like every other money column on the row).
//   amount  the bill money this tender settled (goods, tax, service)
//   tip     the gratuity taken on this tender
// A single tender check has one entry. Every surface that writes a check builds its list
// with these helpers, at the moment it knows the real figures.
//
// THE RULE: tenders list EVERYTHING that settled the bill, money or not, so their sum is the
// full bill plus tips. That holds even where a surface's own `total` column is net of credits
// (kiosk, online, terminal jobs store the card amount there, the till stores the gross):
// tenders do not depend on which convention a surface used.
//
// Methods (one spelling each; the accounting aggregator in
// supabase/functions/_shared/accountingDay.js decides where each posts):
//   card, cash                        money taken now
//   gift_card                         a gift card redemption (money taken when it was SOLD)
//   booking_prepaid, booking_deposit  booking credit paid online before the visit
//   loyalty, promo                    credits that are DISCOUNTS, not money; never posted as takings
//   <delivery platform name>          channel payments (deliveroo, uber_eats, ...), paid out by the platform
//
// A tip captured AFTER the close (US tip on the printed receipt) raises closed_checks.tip and
// total server side but not the tenders; the accounting layer adds that gap to the card tender.
//
// Why this exists: before v5.9.11 a split bill was written as method 'split' with its
// portions dropped (the closed check kept no per tender figures), so Xero could not post a
// split's card and cash to the right clearing accounts.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** One spelling per method (matches canonicalMethod in _shared/accountingDay.js). */
export function tenderMethod(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return 'card';
  if (s === 'gift' || s === 'giftcard' || s === 'gift_cards') return 'gift_card';
  return s;
}

/**
 * One tender entry, or null when it carries no money. `amount` and `tip` are major units.
 * extra: { giftCardId, pspRef, processor }.
 */
export function tender(method, amount, tip = 0, extra = {}) {
  const a = Math.max(0, r2(amount));
  const t = Math.max(0, r2(tip));
  if (a <= 0 && t <= 0) return null;
  const out = { method: tenderMethod(method), amount: a, tip: t };
  if (extra.giftCardId) out.gift_card_id = String(extra.giftCardId);
  if (extra.pspRef) out.psp_ref = String(extra.pspRef);
  if (extra.processor) out.processor = String(extra.processor);
  return out;
}

/** Drop empty entries. Returns null for an empty list (the column stays null, never []). */
export function finishTenders(list) {
  const out = (list || []).filter(Boolean);
  return out.length ? out : null;
}

/** Sum of amount + tip across tenders, in minor units. */
export function tendersTotalMinor(list) {
  return (list || []).reduce((s, t) => s + Math.round((Number(t?.amount) || 0) * 100) + Math.round((Number(t?.tip) || 0) * 100), 0);
}

/** The whole check on one tender: total includes the tip. */
export function singleTender(method, total, tip = 0, extra = {}) {
  const t = Math.max(0, r2(tip));
  return finishTenders([tender(method, Math.max(0, r2(total) - t), t, extra)]);
}

/** A gift card record (giftCardCheckRecord / giftRecordFrom shape, `applied` in MINOR units) to tenders, one per leg. */
export function giftTenders(giftRecord) {
  if (!giftRecord) return [];
  const legs = Array.isArray(giftRecord.legs) && giftRecord.legs.length ? giftRecord.legs : [giftRecord];
  return legs
    .filter((g) => g && !g.commit_error)
    .map((g) => tender('gift_card', (Number(g.applied) || 0) / 100, 0, { giftCardId: g.card_id }));
}

/** Booking credit legs ({ method, amountMinor }) to tenders. */
export function bookingTenders(bookingPayment) {
  return (bookingPayment?.legs || [])
    .filter(Boolean)
    .map((l) => tender(l.method || 'booking_prepaid', (Number(l.amountMinor) || 0) / 100));
}

/**
 * The till's checkout (CheckoutModal complete()). Every figure is what was really taken:
 *   method        the till leg's method ('card' | 'cash' | 'gift_card' | 'booking')
 *   tillMoney     money the till leg took, tip included (dueAfterGift)
 *   tip           the till leg's tip
 *   giftRecord    committed gift card record (applied = what was debited)
 *   loyaltyCredit, promoCredit   major units (discount credits)
 *   bookingPayment               { legs:[{method, amountMinor}] }
 *   readerLegs    card reader split legs [{ chargeMinor (due + tip), tipMinor, transactionId }]
 *   pspRef, processor            the till leg's card reference
 */
export function tillTenders({ method, tillMoney = 0, tip = 0, giftRecord = null, loyaltyCredit = 0, promoCredit = 0, bookingPayment = null, readerLegs = [], pspRef = null, processor = null, readerProcessor = 'adyen' }) {
  const list = [
    ...bookingTenders(bookingPayment),
    ...giftTenders(giftRecord),
    tender('loyalty', loyaltyCredit),
    tender('promo', promoCredit),
    ...(readerLegs || []).filter((l) => l && Number(l.chargeMinor) > 0).map((l) => {
      const tipM = Math.max(0, Number(l.tipMinor) || 0);
      return tender('card', (Number(l.chargeMinor) - tipM) / 100, tipM / 100, { pspRef: l.transactionId, processor: readerProcessor });
    }),
  ];
  const money = Math.max(0, r2(tillMoney));
  const tipAll = Math.max(0, r2(tip));
  const tillTip = Math.min(tipAll, money);
  if (money > 0) {
    const m = tenderMethod(method);
    list.push(tender(m, money - tillTip, tillTip, m === 'card' ? { pspRef, processor } : {}));
  }
  // A tip the till leg did not take was paid from the gift card (a gift card that covered
  // the bill and the tip): it is still a tip, never sales.
  let tipLeft = r2(tipAll - tillTip);
  for (const g of list) {
    if (tipLeft <= 0) break;
    if (!g || g.method !== 'gift_card') continue;
    const move = Math.min(tipLeft, g.amount);
    g.amount = r2(g.amount - move);
    g.tip = r2(g.tip + move);
    tipLeft = r2(tipLeft - move);
  }
  return finishTenders(list);
}

/**
 * A split bill (SplitModal portions) closed at the till.
 *   portions   [{ id, method, total, paid, paymentIntentId }]
 *   legTip     (portion) => tip in major units (CheckoutModal re-reads it from the server row)
 *   giftLegs   committed gift records with portion_id (applied in minor units)
 * A gift portion records what the card REALLY gave (a short card is not money taken).
 */
export function splitTenders(portions, { legTip = (p) => Number(p?.tip) || 0, giftLegs = [], processor = null } = {}) {
  const giftByPortion = new Map((giftLegs || []).filter(Boolean).map((g) => [g.portion_id, g]));
  const list = [];
  for (const p of portions || []) {
    if (!p || p.paid === false) continue;
    const m = tenderMethod(p.method);
    if (m === 'gift_card') {
      const g = giftByPortion.get(p.id);
      if (g) list.push(...giftTenders(g));
      continue;
    }
    list.push(tender(m, p.total, legTip(p), m === 'card' ? { pspRef: p.paymentIntentId, processor } : {}));
  }
  return finishTenders(list);
}

/**
 * Channel (HubRise) payments decoded onto customer.payments [{ name, ref, amount }]. The
 * money is paid out by the PLATFORM, so the platform (`channel`: 'Deliveroo', 'Uber Eats')
 * is the method, and each platform can be mapped to its own clearing account. A payment
 * named 'POS <method>' is a till leg and keeps that method. The channel tip rides on the
 * first platform payment.
 */
export function channelTenders(payments, { tip = 0, channel = null } = {}) {
  const list = (payments || []).filter(Boolean).map((p) => {
    const name = String(p.name || '').trim();
    const pos = /^POS\s+(.+)$/i.exec(name);
    const method = pos ? pos[1] : (channel || name || 'delivery_platform');
    return tender(method, p.amount, 0, p.ref ? { pspRef: p.ref } : {});
  }).filter(Boolean);
  const t = Math.max(0, r2(tip));
  const first = list.find((x) => x.method !== 'card' && x.method !== 'cash') || list[0];
  if (t > 0 && first) {
    const move = Math.min(t, first.amount);
    first.amount = r2(first.amount - move);
    first.tip = r2(first.tip + move);
  }
  return finishTenders(list);
}

/**
 * Card legs taken on a tab (hold capture plus any overage) with the tab's tip placed on the
 * first leg that can hold it. legs: [{ amount (major, tip included), pspRef, processor }].
 */
export function cardLegTenders(legs, { tip = 0 } = {}) {
  let tipLeft = Math.max(0, r2(tip));
  const list = (legs || []).filter((l) => l && r2(l.amount) > 0).map((l) => {
    const amt = r2(l.amount);
    const t = Math.min(tipLeft, amt);
    tipLeft = r2(tipLeft - t);
    return tender('card', amt - t, t, { pspRef: l.pspRef, processor: l.processor });
  });
  return finishTenders(list);
}

/**
 * The fallback for a close that did not hand tenders over (MPOS card flow, a table closed
 * with no payment info, older callers): gift card and booking credit split out when the
 * payment info carries them, the rest on the base method. A composite method string
 * ('gift_card+card', 'loyalty+split') is never used as a method: its LAST part is the base.
 */
export function tendersFromPaymentInfo(paymentInfo = {}, { total = 0, tip = 0 } = {}) {
  if (Array.isArray(paymentInfo.tenders) && paymentInfo.tenders.length) return finishTenders(paymentInfo.tenders);
  const parts = String(paymentInfo.method || 'card').split('+').map((s) => s.trim()).filter(Boolean);
  const base = parts[parts.length - 1] || 'card';
  if (tenderMethod(base) === 'split') return null;   // the aggregator marks it unallocated
  const credits = [
    ...giftTenders(paymentInfo.giftCards?.length ? { legs: paymentInfo.giftCards } : paymentInfo.giftCard),
    ...bookingTenders(paymentInfo.bookingPayment),
  ].filter(Boolean);
  const creditSum = credits.reduce((s, t) => s + t.amount, 0);
  const rest = Math.max(0, r2(total) - creditSum);
  const t = Math.min(Math.max(0, r2(tip)), rest);
  const m = tenderMethod(base);
  const pspRef = paymentInfo.stripePaymentIntentId || paymentInfo.paymentIntentId || null;
  return finishTenders([...credits, tender(m, rest - t, t, m === 'card' ? { pspRef, processor: paymentInfo.processor } : {})]);
}
