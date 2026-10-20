// supabase/functions/_shared/promoMath.js
//
// v5.11.81 (channel parity, confirmed minor: "promo offer category rules and non money rewards are
// ignored on every channel"): what a promo code takes off a basket. Pure, no imports: promo-redeem
// (promo.ts computeDiscount) ships it, and `npm test` and the apps load the same file. The SQL twin
// for a public order is public._public_order_promo (migration 20261020a), the same steps in pence.
//
// Before: the offer's own category rules (Back Office offer form: "Only these categories",
// "Not these categories") were never read, so a "20% off coffee" code took 20% off the whole bill;
// a free item code ("Welcome: free hot drink") said "Free item" and took nothing off; a free
// delivery code took nothing off; a bonus points code credited no points.
//
// The basket a code is worked out on (lib/promoBasis.js): `subtotal` is the goods after the
// automatic deals, before service, tax and tip, in pounds. `lines` (optional) are the basket's
// lines: { itemId, parentId, cat, cats, price (unit, before deals), qty }. `deliveryFee` (optional)
// is the order's delivery fee in pounds. A caller that sends no lines gets exactly the old answer.
//
//   percent        the percent of the ELIGIBLE goods (all of them with no category rule)
//   fixed          the value, never more than the eligible goods
//   free_item      one of the reward item (or one of its sizes) free: the cheapest such line's
//                  unit price, after the basket's deals share; nothing when it is not in the basket
//                  (missing: true, so the checkout can say "add it first")
//   free_delivery  the order's delivery fee
//   points_bonus   no money off; the bonus points are credited with the sale (loyalty-earn)
// With category rules, the eligible goods are the subtotal times the share of the lines' value
// in those categories (so the basket's deals come off pro rata, as the server values it).

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const minor = (v) => Math.round(num(v) * 100);
const idList = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

/** Does a line sit in any of these categories (its own category or an "Also in" one)? */
export function lineInCategories(line, ids) {
  if (!ids.length) return false;
  if (line?.cat != null && ids.includes(String(line.cat))) return true;
  return Array.isArray(line?.cats) && line.cats.some((c) => ids.includes(String(c)));
}

/** The basket lines a code with category rules applies to. No rule: every line. */
export function promoEligibleLines(offer, lines) {
  const inc = idList(offer?.include_category_ids);
  const exc = idList(offer?.exclude_category_ids);
  return (Array.isArray(lines) ? lines : []).filter((l) => l && typeof l === 'object'
    && (!inc.length || lineInCategories(l, inc))
    && !(exc.length && lineInCategories(l, exc)));
}

const lineGrossMinor = (l) => minor(l?.price) * Math.max(1, Math.round(num(l?.qty) || 1));

/**
 * What a promo code takes off this basket: { type, value, amount, label, item_id?, missing?, points? }
 * (amount in pounds, as promo-redeem has always answered).
 */
export function promoDiscountForBasket(offer, basket = {}) {
  const v = num(offer?.reward_value);
  const sub = Math.max(0, num(basket?.subtotal));
  const subMinor = Math.max(0, minor(sub));
  const lines = Array.isArray(basket?.lines) ? basket.lines.filter((l) => l && typeof l === 'object') : null;
  const hasCatRule = idList(offer?.include_category_ids).length > 0 || idList(offer?.exclude_category_ids).length > 0;
  const grossMinor = lines ? lines.reduce((s, l) => s + lineGrossMinor(l), 0) : 0;
  // The eligible goods, in pence: the whole subtotal unless a category rule narrows it (and the
  // basket's lines say which goods are in it).
  const eligibleMinor = (hasCatRule && lines && grossMinor > 0)
    ? Math.round(subMinor * promoEligibleLines(offer, lines).reduce((s, l) => s + lineGrossMinor(l), 0) / grossMinor)
    : subMinor;
  const narrowed = eligibleMinor !== subMinor;
  switch (offer?.reward_type) {
    case 'percent': {
      // No category rule: exactly the old figure (pounds, rounded once).
      const amount = narrowed ? Math.round(eligibleMinor * v / 100) / 100 : Math.round(sub * (v / 100) * 100) / 100;
      return { type: 'percent', value: v, amount, label: offer?.reward_label || `${v}% off` };
    }
    case 'fixed': {
      const amount = narrowed ? Math.min(minor(v), eligibleMinor) / 100 : Math.min(v, sub);
      return { type: 'amount', value: v, amount, label: offer?.reward_label || `£${v.toFixed(2)} off` };
    }
    case 'free_item': {
      const itemId = offer?.reward_item_id != null ? String(offer.reward_item_id) : null;
      const out = { type: 'free_item', value: v, amount: 0, item_id: offer?.reward_item_id ?? null, label: offer?.reward_label || 'Free item' };
      if (!itemId || !lines) return out;   // an older caller sends no lines: as before
      const hits = lines.filter((l) => String(l.itemId ?? l.item_id ?? l.id ?? '') === itemId || String(l.parentId ?? l.parent_id ?? '') === itemId);
      if (!hits.length) return { ...out, missing: true };
      const unitMinor = Math.min(...hits.map((l) => minor(l.price)));
      // After the basket's deals (the subtotal is after them), never more than the eligible goods.
      // Multiply first, then divide (the order the database works it in, so both give the same penny).
      const dealt = grossMinor > 0 && subMinor < grossMinor ? Math.round((unitMinor * subMinor) / grossMinor) : unitMinor;
      return { ...out, amount: Math.max(0, Math.min(dealt, eligibleMinor)) / 100 };
    }
    case 'free_delivery': {
      const fee = Math.max(0, minor(basket?.deliveryFee ?? basket?.delivery_fee));
      return { type: 'free_delivery', value: 0, amount: fee / 100, label: offer?.reward_label || 'Free delivery' };
    }
    case 'points_bonus':
      return { type: 'points_bonus', value: v, amount: 0, points: Math.max(0, Math.round(v)), label: offer?.reward_label || `${v} bonus points` };
    default:
      return { type: 'amount', value: 0, amount: 0, label: offer?.reward_label || 'Offer' };
  }
}

/**
 * The basket lines a checkout sends with a code (the shape above), from any till, kiosk or page line.
 * `price` is the line's unit price WITH its paid options, as the server values a line: a till or
 * kiosk line already holds them (the till's line contract); an online, QR or catering page line
 * holds them apart (pass { modsInPrice: false } and they are added).
 */
export function promoBasketLines(lines, { modsInPrice = true } = {}) {
  return (Array.isArray(lines) ? lines : [])
    .filter((l) => l && typeof l === 'object' && !l.voided)
    .map((l) => {
      const mods = !modsInPrice && Array.isArray(l.mods)
        ? l.mods.reduce((s, m) => s + num(m?.price) * Math.max(1, Math.round(num(m?.qty) || 1)), 0) : 0;
      return {
        itemId: l.itemId ?? l.item_id ?? l.variant?.id ?? l.item?.id ?? l.id ?? null,
        parentId: l.parentId ?? l.parent_id ?? (l.variant ? (l.item?.id ?? null) : null),
        cat: l.cat ?? l.item?.cat ?? null,
        cats: Array.isArray(l.cats) ? l.cats : (Array.isArray(l.item?.cats) ? l.item.cats : null),
        price: Math.round((num(l.price ?? l.linePrice) + mods) * 100) / 100,
        qty: Math.max(1, Math.round(num(l.qty) || 1)),
      };
    })
    .slice(0, 300);
}

/** The promo codes a booked sale used (its promo discount lines, and the record's promo). */
export function promoCodesOnCheck(check) {
  const out = new Set();
  for (const d of (Array.isArray(check?.discounts) ? check.discounts : [])) {
    if (d && typeof d === 'object' && (d.source === 'promo' || d.type === 'promo') && d.code) out.add(String(d.code).trim().toUpperCase());
  }
  if (check?.promo?.code) out.add(String(check.promo.code).trim().toUpperCase());
  return [...out].filter(Boolean).slice(0, 5);
}
