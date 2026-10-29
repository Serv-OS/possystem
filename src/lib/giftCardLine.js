// giftCardLine.js: the gift card sold at the till (Drop C, v5.11.118, 29 Oct 2026).
//
// Peter: "button sell gift card, click it, Pay, payment completed, asks for the code from the gift
// card that is already printed, or you can say print a gift card receipt". The sale is one order
// line per card. The line is money in, not sales: no VAT at the sale (a multi purpose voucher is
// taxed when it is spent), no discount ever touches it, no loyalty is earned on it, it never goes
// to the kitchen and it has no stock. Every rule that must leave the line alone reads these
// predicates, so the till, the tax engines, the discount basis, the receipt and History agree.
// PURE: no imports, runs under node --test.

export const GIFT_CARD_ITEM_ID = 'gift_card';
export const GIFT_CARD_SALE_KIND = 'gift_card_sale';
export const GIFT_CARD_NAME = 'Gift card';

/** Minor units (pence / cents). */
export const GIFT_CARD_MIN_MINOR = 500;
export const GIFT_CARD_MAX_MINOR = 50000;
export const GIFT_CARD_PRESETS_MINOR = Object.freeze([1000, 2000, 2500, 5000]);

/** A gift card sold on this check (one line per card). */
export function isGiftCardSaleLine(line) {
  return !!line && typeof line === 'object' && line.kind === GIFT_CARD_SALE_KIND;
}

/** Outside tax entirely: no VAT inside it, no sales tax on it, in no rate breakdown. */
export function isTaxExemptLine(line) {
  return !!line && typeof line === 'object' && (line.taxExempt === true || line.kind === GIFT_CARD_SALE_KIND);
}

/** No check discount, auto discount or item discount may take anything off it. */
export function isNoDiscountLine(line) {
  return !!line && typeof line === 'object' && (line.noDiscount === true || line.kind === GIFT_CARD_SALE_KIND);
}

/** The live (not voided) gift card lines of a check. */
export function giftLinesOf(items) {
  return (Array.isArray(items) ? items : []).filter((i) => i && !i.voided && isGiftCardSaleLine(i));
}

/** Major units the gift card lines of a check come to. */
export function giftLinesTotal(items) {
  return giftLinesOf(items).reduce((s, i) => s + (Number(i.price) || 0) * (i.qty || 1), 0);
}

/** The minor amount of one gift card line (price x qty, rounded to the minor unit). */
export function giftLineAmountMinor(line) {
  return Math.round((Number(line?.price) || 0) * (line?.qty || 1) * 100);
}

/**
 * The order line the till adds for one card. `amountMinor` is a whole number of minor units
 * already checked by cleanGiftAmountMinor. The caller (store.addGiftCardLine) stamps the uid.
 */
export function giftCardSaleLine(amountMinor, uid) {
  return {
    uid,
    itemId: GIFT_CARD_ITEM_ID,
    kind: GIFT_CARD_SALE_KIND,
    name: GIFT_CARD_NAME,
    price: Math.round(Number(amountMinor) || 0) / 100,
    qty: 1,
    mods: [],
    notes: '',
    allergens: [],
    seat: 'shared',
    course: 1,
    taxExempt: true,
    noDiscount: true,
    noStock: true,
    noKitchen: true,   // store.sendToKitchen leaves noKitchen lines off every docket (v5.7.28)
    fired: false,
    status: 'pending',
  };
}

/**
 * A typed or preset amount (major units as a string or number) as whole minor units, or null
 * when it is not a money amount or is outside 5.00 .. 500.00.
 */
export function cleanGiftAmountMinor(input) {
  if (input == null || input === '') return null;
  const s = String(input).replace(/[^0-9.]/g, '');
  if (!s || !/^\d*(\.\d{0,2})?$/.test(s) || s === '.') return null;
  const minor = Math.round(Number(s) * 100);
  if (!Number.isFinite(minor) || minor < GIFT_CARD_MIN_MINOR || minor > GIFT_CARD_MAX_MINOR) return null;
  return minor;
}

/** The plain words for the amount rule, for the modal and a toast. */
export function giftAmountRuleWords(fmtMinor = (m) => (m / 100).toFixed(2)) {
  return `Between ${fmtMinor(GIFT_CARD_MIN_MINOR)} and ${fmtMinor(GIFT_CARD_MAX_MINOR)}`;
}

/** A card code as the staff typed or scanned it: 16 letters or digits, dashes and spaces optional. */
export function normaliseGiftCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 16) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/** What the code box shows as the staff type: groups of four with dashes, never more than 16. */
export function formatGiftCodeInput(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return (s.match(/.{1,4}/g) || []).join('-');
}

/** The last four characters of a card code (for "Card ending WXYZ"). */
export function giftCodeLast4(code) {
  const s = String(code || '').replace(/[^A-Za-z0-9]/g, '');
  return s.slice(-4).toUpperCase();
}
