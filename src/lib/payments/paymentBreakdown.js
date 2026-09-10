/**
 * paymentBreakdown.js: how ONE card payment was split, proven from Adyen's
 * own records. PURE: no network, no React, no Deno.
 *
 * MIRROR: supabase/functions/_shared/paymentBreakdown.ts carries the SAME
 * helpers (Deno cannot import from src/). KEEP IN SYNC: change both or
 * neither. paymentBreakdown.test.js is the contract for both copies.
 *
 * OWNER BRIEF (10 Sep 2026): "tell me how £1 is broken down at 0.8% + 5p
 * where I can see what the customer has paid and that equals that and then
 * how much we made on that transaction", "I need this proven not just
 * calculations I need to see it on the back office", "we should be making on
 * both % + txn".
 *
 * THE MONEY. The venue pays a card rate, applied on Adyen as a split rule on
 * the venue store. For each payment Adyen books Balance Platform transfers
 * (GET /btl/v4/transfers, category platformPayment, categoryData.
 * pspPaymentReference = the payment):
 *   BalanceAccount (or Remainder)  the rest of the sale, to the VENUE balance account
 *   Tip, Surcharge                 to the venue in full, on the VENUE balance account
 *   Commission                     the venue fee, to the platform LIABLE account.
 *                                  Adyen books it as TWO transfers: the fixed
 *                                  part (its value is the rule fixedAmount) and
 *                                  the percent part
 *   PaymentFee, AcquiringFees, AdyenFees, Interchange, SchemeFee,
 *   AdyenCommission, AdyenMarkup   Adyen's fees, taken from the liable account
 * FranPOS owns the platform and keeps its margin (resellerRate.js: 0.10% plus
 * a fixed fee per payment, 3p in GBP). ServOS earns what is left: venue fee
 * minus Adyen fees minus FranPOS margin, on BOTH parts.
 *
 * PROOF, NOT A GUESS (review, 10 Sep 2026):
 *   - only records Adyen has captured or booked count. A hold (authorised,
 *     capturePending, bookingPending) is "not booked yet"; expired, reversed,
 *     refused and the like are ignored
 *   - every record is checked against the account it sits on. Venue money,
 *     tips and surcharges must be on the venue account; the venue fee and
 *     Adyen's fees must be on the platform account. A fee taken from the
 *     venue lowers what the venue receives, not the ServOS share. Anything
 *     off that pattern is named and the state is mismatch
 *   - when the server could not read all of Adyen's records (a listing was
 *     refused, timed out, was cut off, or could not be tried) the state is
 *     incomplete: no sums, no gap sentence, because a failed read is not a gap
 *
 * THE PROVO £1.00 (10 Sep 2026, psp FSPKMNZ492CWX7Z3), the main fixture:
 *   customer paid 100, venue fee 6 (percent 1, fixed 5), venue receives 94,
 *   94 + 6 = 100, Adyen fees 1, left on the platform account 5, FranPOS 3
 *   (percent 0, fixed 3), ServOS share 2 (percent 1, fixed 2, minus fees 1).
 */

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const lower = (v) => str(v).toLowerCase();
const curOf = (c) => str(c).toUpperCase() || 'GBP';
const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const halfUp = (x) => Math.floor(x + 0.5);

// ── THE WORDS ───────────────────────────────────────────────────────────────
export const BREAKDOWN_LABELS = Object.freeze({
  customer_paid: 'Customer paid',
  venue_fee: 'Venue fee',
  tip: 'Tip',
  surcharge: 'Surcharge',
  venue_receives: 'Venue receives',
  venue_adyen_fees: 'Adyen fees taken from the venue',
  adyen_fees: 'Adyen fees',
  left_on_platform: 'Left on the platform account',
  franpos_rate: 'FranPOS rate',
  servos_share: 'ServOS share',
  refunded: 'Refunded',
});
// The small grey word next to every money line.
export const SOURCE_WORDS = Object.freeze({
  adyen: 'From Adyen',
  rate: 'Rate on Adyen',
  franpos: 'FranPOS rate on file',
  computed: 'Worked out',
});
export const WAITING_SENTENCE = 'Adyen has not booked this payment yet. Check again in a few minutes.';
export const INCOMPLETE_SENTENCE = 'Some of Adyen\'s records could not be read, so this check is not finished.';

// Adyen's platformPaymentType words, by what they do.
const VENUE_TYPES = Object.freeze(['balanceaccount', 'remainder', 'default']);
const FEE_TYPES = Object.freeze(['paymentfee', 'acquiringfees', 'adyenfees', 'interchange', 'schemefee', 'adyencommission', 'adyenmarkup']);
// Adyen's transfer types that are not the payment itself: listed on their own
// or named in a warning, never counted in the sums.
const REFUND_TYPES = Object.freeze(['refund', 'refundreversal']);
const CHARGEBACK_TYPES = Object.freeze(['chargeback', 'chargebackreversal', 'secondchargeback', 'chargebackcorrection', 'chargebackreversalcorrection']);
const REVERSAL_TYPES = Object.freeze(['capturereversal', 'manualcorrection', 'depositcorrection', 'balanceadjustment', 'reserveadjustment']);
// Adyen's transfer statuses. Only BOOKED money counts as money that moved.
const BOOKED_STATUSES = Object.freeze(['captured', 'booked']);
const PENDING_STATUSES = Object.freeze(['authorised', 'authorized', 'capturepending', 'bookingpending', 'pending', 'received', 'approvalpending']);
const DEAD_STATUSES = Object.freeze(['expired', 'capturereversed', 'refused', 'failed', 'cancelled', 'canceled', 'error', 'returned', 'rejected', 'reversed']);

// Money the way a person reads it: pence below £1 ("6p"), pounds from £1
// ("£1.00"); cents for USD and EUR ("6c", "$1.00", "€1.00"). A loss reads
// "minus 3p", never with a dash.
export function formatMinor(minor, currency) {
  const n = num(minor);
  if (n === null) return 'Not known';
  const cur = curOf(currency);
  const abs = Math.abs(Math.round(n));
  const sign = n < 0 && abs > 0 ? 'minus ' : '';
  const small = cur === 'GBP' ? 'p' : 'c';
  const symbol = cur === 'GBP' ? '£' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : '';
  if (abs < 100) return `${sign}${abs}${small}`;
  const major = (abs / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return symbol ? `${sign}${symbol}${major}` : `${sign}${major} ${cur}`;
}

// A card as the payment list names it: "Visa Debit ending 1234", "Mastercard",
// "Mastercard on Apple Pay", "Card". Reads adyen_payments.card ({ brand,
// applicationName, last4 }); brand is Adyen's paymentMethod, which is a wallet
// code such as mc_applepay on wallet payments.
const BRAND_WORDS = Object.freeze({
  visa: 'Visa', visadebit: 'Visa Debit', visacredit: 'Visa', electron: 'Visa Electron', vpay: 'V Pay',
  mc: 'Mastercard', mastercard: 'Mastercard', mcdebit: 'Debit Mastercard', maestro: 'Maestro',
  amex: 'Amex', discover: 'Discover', diners: 'Diners', jcb: 'JCB', cup: 'UnionPay',
  applepay: 'Apple Pay', googlepay: 'Google Pay', paywithgoogle: 'Google Pay', interac_card: 'Interac',
});
const titleWords = (s) => str(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
export function paymentCardLabel(card) {
  const c = isObj(card) ? card : {};
  const brandRaw = lower(c.brand);
  const wallet = brandRaw.match(/^(.+?)_(applepay|googlepay|paywithgoogle)$/);
  const cardRaw = wallet ? wallet[1] : brandRaw;
  const brand = BRAND_WORDS[cardRaw] || (cardRaw ? titleWords(cardRaw.replace(/_/g, ' ')) : '');
  const app = titleWords(c.applicationName);
  let name;
  if (app && brand && !app.toLowerCase().includes(brand.toLowerCase().split(' ')[0])) name = `${brand}, ${app}`;
  else name = app || brand || 'Card';
  if (wallet) name = `${name} on ${wallet[2] === 'applepay' ? 'Apple Pay' : 'Google Pay'}`;
  const last4 = str(c.last4).replace(/\D/g, '').slice(-4);
  return last4 ? `${name} ending ${last4}` : name;
}

// ── THE RULE FOR A PAYMENT ───────────────────────────────────────────────────
// The split profile's rule for a payment's rate tier and currency, with the
// SAME mapping adyenLink.js profileTiers reads the profile with:
//   amex              paymentMethod amex (the ANY interaction rule wins)
//   card_not_present  paymentMethod ANY, shopperInteraction Ecommerce
//   keyed             paymentMethod ANY, shopperInteraction Moto
//   card_present      paymentMethod ANY, shopperInteraction ANY
// Null when the profile has no rule for that tier in that currency.
export function ruleForTier(profile, tier, currency) {
  const rules = (Array.isArray(profile?.rules) ? profile.rules : []).filter(isObj);
  const any = (v) => !str(v) || lower(v) === 'any';
  const cur = curOf(currency);
  const t = lower(tier);
  let pick = null;
  for (const r of rules) {
    if (str(r.currency) && str(r.currency).toUpperCase() !== cur) continue;
    const pm = lower(r.paymentMethod);
    const si = lower(r.shopperInteraction);
    const ruleTier = pm === 'amex' ? 'amex'
      : any(pm) && si === 'ecommerce' ? 'card_not_present'
      : any(pm) && si === 'moto' ? 'keyed'
      : any(pm) && any(si) ? 'card_present'
      : null;
    if (ruleTier !== t) continue;
    if (t === 'amex') {
      if (any(si)) return r;
      if (!pick) pick = r;
      continue;
    }
    return r;
  }
  return pick;
}

// The venue rate a rule holds: { percent, fixedMinor } (0 for a missing part).
export function ruleRate(rule) {
  const c = isObj(rule?.splitLogic) && isObj(rule.splitLogic.commission) ? rule.splitLogic.commission : {};
  const bp = num(c.variablePercentage);
  const fix = num(c.fixedAmount);
  return { percent: bp === null ? 0 : bp / 100, fixedMinor: fix === null ? 0 : Math.round(fix) };
}

// "0.8% + 5p", "5p", "0.8%", "0%". Cents for USD and EUR.
export function venueRateLine(rate, currency) {
  const pct = num(rate?.percent) ?? 0;
  const fix = num(rate?.fixedMinor) ?? 0;
  const small = curOf(currency) === 'GBP' ? 'p' : 'c';
  const parts = [];
  if (pct > 0) parts.push(`${Number(pct.toFixed(4))}%`);
  if (fix > 0) parts.push(`${Math.round(fix)}${small}`);
  return parts.length ? parts.join(' + ') : '0%';
}

// ── ONE TRANSFER ─────────────────────────────────────────────────────────────
// Adyen's transfer, raw or trimmed, in one flat shape.
function readTransfer(t) {
  const cd = isObj(t?.categoryData) ? t.categoryData : {};
  const amount = isObj(t?.amount) ? t.amount : {};
  const value = num(amount.value ?? t?.value ?? t?.amountMinor);
  const direction = lower(t?.direction);
  const minor = value === null ? null : Math.abs(Math.round(value));
  return {
    id: str(t?.id),
    reference: str(t?.reference),
    type: lower(t?.type),
    status: lower(t?.status),
    direction,
    currency: str(amount.currency ?? t?.currency).toUpperCase(),
    minor,
    // incoming adds, outgoing takes away; with no direction the sign of the value decides
    signed: minor === null ? 0 : (direction === 'outgoing' || (!direction && value < 0) ? -minor : minor),
    platformPaymentType: str(cd.platformPaymentType ?? t?.platformPaymentType),
    ppt: lower(cd.platformPaymentType ?? t?.platformPaymentType),
    psp: str(cd.pspPaymentReference ?? t?.pspPaymentReference),
    balanceAccountId: str((isObj(t?.balanceAccount) ? t.balanceAccount.id : null) ?? t?.balanceAccountId),
  };
}

// Plain words for a transfer in the references list.
const REFERENCE_WORDS = Object.freeze({
  balanceaccount: 'Venue receives', remainder: 'Venue receives', default: 'Venue receives',
  tip: 'Tip to the venue', surcharge: 'Surcharge to the venue',
  commission: 'Venue fee part',
  paymentfee: 'Adyen fee', acquiringfees: 'Adyen fee', adyenfees: 'Adyen fee', interchange: 'Adyen fee',
  schemefee: 'Adyen fee', adyencommission: 'Adyen fee', adyenmarkup: 'Adyen fee',
});
// The Adyen word in grey brackets after a reference. Never "commission" on
// screen (owner rule), so those records show their plain label alone.
const termOf = (t, fallback) => (/commission/i.test(t.platformPaymentType) ? null : (t.platformPaymentType || fallback));

// "Tip included.", "Tip and surcharge included."
const includedWords = (tip, surcharge) => {
  const words = [tip ? 'tip' : '', surcharge ? 'surcharge' : ''].filter(Boolean).join(' and ');
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)} included.` : null;
};

// ── THE BREAKDOWN ────────────────────────────────────────────────────────────
//   payment    the adyen_payments row, snake or camel case: psp_reference,
//              amount_minor (what the customer paid, tip included),
//              currency, gratuity_minor, amount_refunded_minor, rate_category
//   transfers  Adyen Balance Platform transfers for the payment
//   rule       the split rule for the payment tier (ruleForTier), or null
//   venueBalanceAccountId   the venue's balance account
//   liableBalanceAccountId  the platform's liable balance account, when known
//   reseller   resellerRateFor's answer for the payment currency and month
//   readComplete  false when the server could not read every Adyen listing it
//              needed; the answer is then 'incomplete' (default true)
// Answers { state: 'ok' | 'waiting' | 'incomplete' | 'mismatch', message,
// currency, amountMinor, lines, parts, checks, references, warnings, sumLine }.
export function buildPaymentBreakdown({ payment, transfers, rule, venueBalanceAccountId, liableBalanceAccountId, reseller, readComplete } = {}) {
  const p = isObj(payment) ? payment : {};
  const currency = curOf(p.currency);
  const psp = str(p.psp_reference ?? p.pspReference ?? p.psp);
  const amountMinor = Math.round(num(p.amount_minor ?? p.amountMinor) ?? 0);
  const tipOnRow = Math.max(0, Math.round(num(p.gratuity_minor ?? p.gratuityMinor) ?? 0));
  const refundedOnRow = Math.max(0, Math.round(num(p.amount_refunded_minor ?? p.refundedMinor ?? p.amountRefundedMinor) ?? 0));
  const venueBa = str(venueBalanceAccountId);
  const liableBa = str(liableBalanceAccountId);
  const warnings = [];
  // The payment first, then each booked record, the refunds, the accounts.
  const transferRefs = [];
  const refundRefs = [];

  // One record per transfer id (the listings overlap), this payment only.
  const seen = new Map();
  for (const raw of Array.isArray(transfers) ? transfers : []) {
    if (!isObj(raw)) continue;
    const t = readTransfer(raw);
    if (psp && t.psp && t.psp !== psp) continue;
    seen.set(t.id || `${seen.size}`, t);
  }
  const notInSums = (t) => REFUND_TYPES.includes(t.type) || CHARGEBACK_TYPES.includes(t.type) || REVERSAL_TYPES.includes(t.type);
  let otherCurrency = 0;
  let pending = 0;
  let chargebacks = 0;
  let reversals = 0;
  const counted = [];
  const refunds = [];
  const unknownTypes = new Set();
  const unknownStatuses = new Set();
  for (const t of seen.values()) {
    if (!BOOKED_STATUSES.includes(t.status)) {
      if (PENDING_STATUSES.includes(t.status)) { if (!notInSums(t)) pending++; }
      else if (!DEAD_STATUSES.includes(t.status)) unknownStatuses.add(t.status || 'no status');
      continue;
    }
    if (t.minor === null) continue;
    if (t.currency && t.currency !== currency) { otherCurrency++; continue; }
    if (REFUND_TYPES.includes(t.type)) { refunds.push(t); continue; }
    if (CHARGEBACK_TYPES.includes(t.type)) { chargebacks++; continue; }
    if (REVERSAL_TYPES.includes(t.type)) { reversals++; continue; }
    counted.push(t);
  }
  if (otherCurrency) {
    warnings.push(otherCurrency === 1
      ? `One Adyen record is not in ${currency}, so it is not counted.`
      : `${otherCurrency} Adyen records are not in ${currency}, so they are not counted.`);
  }
  if (unknownStatuses.size) warnings.push(`Adyen has a record in a state this page does not know, so it is not counted (${[...unknownStatuses].join(', ')}).`);
  if (pending) warnings.push('Adyen holds money for this payment but has not booked it yet.');
  if (chargebacks) warnings.push('The customer\'s bank took this payment back (chargeback). That is not counted in the sums.');
  if (reversals) warnings.push('Adyen reversed or corrected part of this payment. That is not counted in the sums.');

  const rate = rule ? ruleRate(rule) : null;
  const rateLine = rate ? venueRateLine(rate, currency) : null;
  const saleMinor = Math.max(0, amountMinor - tipOnRow);

  // Which account a record sits on. null when it cannot be told (an id is
  // not known), so nothing is judged on a guess.
  const onVenue = (t) => (venueBa && t.balanceAccountId ? t.balanceAccountId === venueBa : null);
  const onLiable = (t) => (liableBa && t.balanceAccountId ? t.balanceAccountId === liableBa : null);

  // Sort the records by what they do, and by where they landed.
  let venueMinor = 0;
  let tipMinor = 0;
  let surchargeMinor = 0;
  let feesMinor = 0;            // Adyen fees taken from the platform account
  let venueFeesMinor = 0;       // Adyen fees taken from the venue account
  let venueMoneyElsewhere = 0;  // venue money, tips, surcharges paid to another account
  let feeOnVenueMinor = 0;      // venue fee records booked on the venue account
  let feeElsewhereMinor = 0;    // venue fee records booked on a third account
  let adyenFeesElsewhere = 0;   // Adyen fees taken from a third account
  const commissions = [];
  for (const t of counted) {
    if (VENUE_TYPES.includes(t.ppt) || t.ppt === 'tip' || t.ppt === 'surcharge') {
      if (onVenue(t) === false) venueMoneyElsewhere += t.signed;
      else if (t.ppt === 'tip') tipMinor += t.signed;
      else if (t.ppt === 'surcharge') surchargeMinor += t.signed;
      else venueMinor += t.signed;
    } else if (t.ppt === 'commission') {
      if (onVenue(t) === true) { feeOnVenueMinor += t.signed; venueMinor += t.signed; }
      else if (onLiable(t) === false) feeElsewhereMinor += t.signed;
      else commissions.push(t);
    } else if (FEE_TYPES.includes(t.ppt)) {
      // outgoing: a positive fee
      if (onVenue(t) === true) venueFeesMinor += -t.signed;
      else if (onLiable(t) === false) adyenFeesElsewhere += -t.signed;
      else feesMinor += -t.signed;
    } else {
      unknownTypes.add(t.platformPaymentType || 'no type');
      continue;
    }
    transferRefs.push({
      label: REFERENCE_WORDS[t.ppt] || 'Adyen record',
      term: termOf(t, null),
      id: t.reference || t.id,
      key: t.id || t.reference,
    });
  }
  // Records off the pattern: each named in plain words, and each makes the
  // state mismatch (the first one is the sentence at the top).
  const offPattern = [];
  if (venueMoneyElsewhere) offPattern.push(`Adyen paid ${formatMinor(Math.abs(venueMoneyElsewhere), currency)} of this payment to an account that is not the venue.`);
  if (feeOnVenueMinor) offPattern.push(`Adyen booked ${formatMinor(Math.abs(feeOnVenueMinor), currency)} of the venue fee on the venue account, not the platform account.`);
  if (feeElsewhereMinor) offPattern.push(`Adyen booked ${formatMinor(Math.abs(feeElsewhereMinor), currency)} of the venue fee on an account that is not the platform account.`);
  if (venueFeesMinor) offPattern.push(`Adyen took ${formatMinor(Math.abs(venueFeesMinor), currency)} of fees from the venue account, not the platform account.`);
  if (adyenFeesElsewhere) offPattern.push(`Adyen took ${formatMinor(Math.abs(adyenFeesElsewhere), currency)} of fees from an account that is not the platform account.`);
  warnings.push(...offPattern);
  if (unknownTypes.size) warnings.push(`Adyen booked a record this page does not know, so it is not counted (${[...unknownTypes].join(', ')}).`);
  for (const t of refunds) refundRefs.push({ label: 'Refund', term: termOf(t, 'refund'), id: t.reference || t.id, key: t.id || t.reference });
  const references = () => [
    ...(psp ? [{ label: 'Payment', term: 'PSP reference', id: psp }] : []),
    ...transferRefs.map(({ label, term, id }) => ({ label, term, id })),
    ...refundRefs.map(({ label, term, id }) => ({ label, term, id })),
    ...(venueBa ? [{ label: 'Venue account', term: 'balance account', id: venueBa }] : []),
    ...(liableBa ? [{ label: 'Platform account', term: 'liable balance account', id: liableBa }] : []),
  ];

  const base = { currency, amountMinor, warnings };
  const notFinished = (state, message) => ({
    ...base,
    state,
    message,
    lines: [{ key: 'customer_paid', label: BREAKDOWN_LABELS.customer_paid, minor: amountMinor, source: 'adyen', detail: null }],
    parts: null,
    checks: { addsUp: null, feeMatchesRate: null },
    references: references(),
    sumLine: null,
  });
  // A failed read is not a gap: no sums until every listing was read.
  if (readComplete === false) return notFinished('incomplete', INCOMPLETE_SENTENCE);
  if (!counted.length || pending) return notFinished('waiting', WAITING_SENTENCE);

  // ── the venue fee, and its two parts ──
  const venueFeeMinor = commissions.reduce((s, t) => s + t.signed, 0);
  let percentVenue = null;
  let fixedVenue = null;
  let partsFrom = 'adyen';
  const expectedPercent = rate ? halfUp((saleMinor * rate.percent) / 100) : null;
  // Adyen rounds the percent part to the nearest penny; either base is
  // accepted (the sale without the tip, or the whole amount), since a tip is
  // added to the venue in full.
  const near = (booked, b) => (rate ? Math.abs(booked - (b * rate.percent) / 100) <= 0.5 + 1e-9 : false);
  const nearEither = (booked) => near(booked, saleMinor) || near(booked, amountMinor);
  const fixedT = commissions.length === 2 && rate && commissions[0].signed !== commissions[1].signed
    ? commissions.find((t) => t.signed === rate.fixedMinor) || null
    : null;
  const percentT = fixedT ? (commissions.find((t) => t !== fixedT) ?? null) : null;
  if (fixedT && percentT && nearEither(percentT.signed)) {
    // BOTH records check out against the rate: the fixed one equals the
    // fixed fee, the other is the percent to the nearest penny.
    fixedVenue = fixedT.signed;
    percentVenue = percentT.signed;
    for (const ref of transferRefs) {
      if (ref.key === (fixedT.id || fixedT.reference)) ref.label = 'Venue fee, fixed part';
      if (ref.key === (percentT.id || percentT.reference)) ref.label = 'Venue fee, percent part';
    }
  } else if (commissions.length === 0 && rate && rate.fixedMinor === 0 && expectedPercent === 0) {
    // Nothing to take (a 0% rule, or a sale too small): no venue fee record.
    percentVenue = 0;
    fixedVenue = 0;
  } else if (commissions.length === 1 && rate && (rate.fixedMinor === 0 || expectedPercent === 0)) {
    // A rule with one part priced (or a sale too small for the percent to
    // reach a penny) books ONE transfer, and it can only be that part.
    if (rate.fixedMinor === 0) { percentVenue = commissions[0].signed; fixedVenue = 0; }
    else { fixedVenue = commissions[0].signed; percentVenue = 0; }
  } else if (rate) {
    // The fallback: the fixed part is the rule's, the percent part is the rest
    // of what Adyen booked, so the two parts always add up to the venue fee.
    // feeMatchesRate below says whether that rest is what the rule gives.
    const why = commissions.length === 2 && commissions[0].signed === commissions[1].signed
      ? 'Adyen booked the venue fee as two equal records.'
      : commissions.length === 2
        ? 'The venue fee records do not match the rate on Adyen today, which may have changed since this payment.'
        : commissions.length === 0
          ? 'Adyen booked no venue fee record on the platform account.'
          : `Adyen booked the venue fee as ${commissions.length === 1 ? 'one record' : `${commissions.length} records`}.`;
    if (venueFeeMinor - rate.fixedMinor < 0) {
      // The rest would be below zero: the parts are not known, not negative.
      partsFrom = null;
      warnings.push(`${why} The percent and fixed parts cannot be split.`);
    } else {
      partsFrom = 'rate';
      fixedVenue = rate.fixedMinor;
      percentVenue = venueFeeMinor - rate.fixedMinor;
      warnings.push(`${why} The percent and fixed parts are worked out from the rate on Adyen instead.`);
    }
  } else {
    partsFrom = null;
    warnings.push('The rate on Adyen for this payment was not found, so the percent and fixed parts cannot be split.');
  }

  // ── the checks ──
  // What the venue nets: its money, tips and surcharges, less any Adyen fees
  // taken from its own account. Every penny the customer paid is one of: the
  // venue's, the venue fee, or a fee Adyen took from the venue.
  const receivesMinor = venueMinor + tipMinor + surchargeMinor - venueFeesMinor;
  const bookedMinor = receivesMinor + venueFeeMinor + venueFeesMinor;
  const addsUp = bookedMinor === amountMinor;
  let feeMatchesRate = null;
  if (rate) {
    if (percentVenue !== null && fixedVenue !== null && partsFrom === 'adyen') {
      feeMatchesRate = fixedVenue === rate.fixedMinor && nearEither(percentVenue);
    } else {
      feeMatchesRate = nearEither(venueFeeMinor - rate.fixedMinor);
    }
  }

  // ── what is left, what FranPOS keeps, what ServOS makes ──
  const leftMinor = venueFeeMinor - feesMinor;
  const r = isObj(reseller) ? reseller : null;
  const fpPct = r ? num(r.percent) : null;
  const fpFix = r ? num(r.fixedMinor) : null;
  const franpos = r && fpPct !== null && fpFix !== null
    ? { percentMinor: halfUp((amountMinor * fpPct) / 100), fixedMinor: Math.round(fpFix) }
    : null;
  if (!franpos) warnings.push('The FranPOS rate is not on file, so the ServOS share cannot be worked out.');
  const franposTotal = franpos ? franpos.percentMinor + franpos.fixedMinor : null;
  const servosTotal = franpos && franposTotal !== null ? leftMinor - franposTotal : null;
  const fpLine = franpos && fpPct !== null && fpFix !== null ? `${padPercent(fpPct)}% + ${Math.round(fpFix)}${currency === 'GBP' ? 'p' : 'c'}` : null;

  const lines = [
    { key: 'customer_paid', label: BREAKDOWN_LABELS.customer_paid, minor: amountMinor, source: 'adyen', detail: tipMinor > 0 ? `Includes a tip of ${formatMinor(tipMinor, currency)}.` : null },
    { key: 'venue_fee', label: BREAKDOWN_LABELS.venue_fee, minor: venueFeeMinor, source: 'adyen', detail: rateLine },
  ];
  if (tipMinor) lines.push({ key: 'tip', label: BREAKDOWN_LABELS.tip, minor: tipMinor, source: 'adyen', detail: 'Paid to the venue in full.' });
  if (surchargeMinor) lines.push({ key: 'surcharge', label: BREAKDOWN_LABELS.surcharge, minor: surchargeMinor, source: 'adyen', detail: 'Paid to the venue in full.' });
  lines.push({ key: 'venue_receives', label: BREAKDOWN_LABELS.venue_receives, minor: receivesMinor, source: 'adyen', detail: includedWords(tipMinor, surchargeMinor) });
  if (venueFeesMinor) lines.push({ key: 'venue_adyen_fees', label: BREAKDOWN_LABELS.venue_adyen_fees, minor: venueFeesMinor, source: 'adyen', detail: null });
  lines.push(
    { key: 'adyen_fees', label: BREAKDOWN_LABELS.adyen_fees, minor: feesMinor, source: 'adyen', detail: null },
    { key: 'left_on_platform', label: BREAKDOWN_LABELS.left_on_platform, minor: leftMinor, source: 'computed', detail: 'Venue fee minus Adyen fees.' },
    { key: 'franpos_rate', label: BREAKDOWN_LABELS.franpos_rate, minor: franposTotal, source: 'franpos', detail: fpLine },
    { key: 'servos_share', label: BREAKDOWN_LABELS.servos_share, minor: servosTotal, source: 'computed', detail: null },
  );
  // Refunds: money going back out adds, a refund reversal (money coming back
  // in) takes off. With no direction, the type decides.
  const refundFromRecords = refunds.reduce((s, t) => {
    if (FEE_TYPES.includes(t.ppt) || t.minor === null) return s;
    const hasDirection = t.direction === 'incoming' || t.direction === 'outgoing';
    return s + (hasDirection ? -t.signed : (t.type === 'refundreversal' ? -t.minor : t.minor));
  }, 0);
  const refundMinor = refundedOnRow || Math.max(0, refundFromRecords);
  if (refundMinor > 0) {
    lines.push({ key: 'refunded', label: BREAKDOWN_LABELS.refunded, minor: refundMinor, source: 'adyen', detail: 'Not counted in the sums above.' });
  }

  const split = (venue, fp) => (venue === null || fp === null ? null : venue - fp);
  const parts = {
    percent: { venue: percentVenue, franpos: franpos ? franpos.percentMinor : null, servos: split(percentVenue, franpos ? franpos.percentMinor : null) },
    fixed: { venue: fixedVenue, franpos: franpos ? franpos.fixedMinor : null, servos: split(fixedVenue, franpos ? franpos.fixedMinor : null) },
    adyenFees: feesMinor,
    servosTotal,
    from: partsFrom,
  };

  // ── the state, and the one sentence ──
  let state = 'ok';
  let message = null;
  // Money on the wrong account that exactly explains the gap is named, not
  // the gap: "Adyen paid 94p of this payment to an account that is not the venue."
  const explained = bookedMinor + venueMoneyElsewhere + feeElsewhereMinor === amountMinor;
  if (!addsUp && !(offPattern.length && explained)) {
    state = 'mismatch';
    const gap = Math.abs(amountMinor - bookedMinor);
    message = `Adyen booked ${formatMinor(bookedMinor, currency)}, but the customer paid ${formatMinor(amountMinor, currency)}. The gap is ${formatMinor(gap, currency)}.`;
  } else if (offPattern.length) {
    state = 'mismatch';
    message = offPattern[0];
  } else if (feeMatchesRate === false && rate) {
    state = 'mismatch';
    const expected = halfUp((saleMinor * rate.percent) / 100) + rate.fixedMinor;
    message = `Adyen took a venue fee of ${formatMinor(venueFeeMinor, currency)}, but the rate on Adyen gives ${formatMinor(expected, currency)}. The gap is ${formatMinor(Math.abs(venueFeeMinor - expected), currency)}.`;
  }

  const sumParts = [formatMinor(receivesMinor, currency), formatMinor(venueFeeMinor, currency)];
  if (venueFeesMinor) sumParts.push(formatMinor(venueFeesMinor, currency));
  return {
    ...base,
    state,
    message,
    lines,
    parts,
    checks: { addsUp, feeMatchesRate },
    references: references(),
    sumLine: `${sumParts.join(' + ')} = ${formatMinor(bookedMinor, currency)}`,
  };
}

// A percent with at least two decimals: 0.1 is "0.10".
function padPercent(p) {
  const plain = String(Number(Number(p).toFixed(4)));
  const [whole, dec = ''] = plain.split('.');
  return `${whole}.${dec.padEnd(2, '0')}`;
}
