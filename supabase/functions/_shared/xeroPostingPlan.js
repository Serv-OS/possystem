// supabase/functions/_shared/xeroPostingPlan.js
//
// Turns one neutral accounting day (_shared/accountingDay.js buildAccountingDay) into the
// Xero bank transactions xero-sales posts. Pure JS, no network: xero-sales provisions any
// default accounts the plan needs, then sends the payloads. A QuickBooks integration writes
// its own planner over the SAME day summary; nothing in accountingDay.js is Xero shaped.
//
// The model (unchanged in spirit since v5.5.782, reconciliation first):
//   - every tender method lands in a Xero BANK "clearing" account (operator mapping, else a
//     default per tender KIND), so each processor payout or cash banking reconciles there;
//   - per clearing account, ONE "Receive Money" transaction for the day's takings and, when
//     there were refunds that day, ONE "Spend Money" transaction for the money that went back
//     (Xero will not take a negative bank transaction, and a separate refund line lets the
//     accountant see both sides of the payout);
//   - lines split the money into goods (revenue account, VAT via the tax rate, amounts are
//     tax INCLUSIVE), tips (never revenue, never VAT) and service charge.
//
// v5.9.11 defaults (19 Sep 2026): gift card redemptions, booking deposits and money we
// cannot place ('unallocated', old split bills) each get their own clearing account instead
// of falling into card clearing, which never matched the card payout. Unmapped tips and
// service charge post to their own liability accounts instead of revenue.

export const DEFAULT_ACCOUNTS = {
  cardClearing: { name: 'ServOS Card Clearing', type: 'BANK', number: 'SERVOS-CARD-CLR', code: 'SOSCARDCLR', detailKey: 'cardClearingId' },
  cashClearing: { name: 'ServOS Cash Clearing', type: 'BANK', number: 'SERVOS-CASH-CLR', code: 'SOSCASHCLR', detailKey: 'cashClearingId' },
  giftClearing: { name: 'ServOS Gift Card Clearing', type: 'BANK', number: 'SERVOS-GIFT-CLR', code: 'SOSGIFTCLR', detailKey: 'giftClearingId' },
  depositClearing: { name: 'ServOS Deposits Clearing', type: 'BANK', number: 'SERVOS-DEP-CLR', code: 'SOSDEPCLR', detailKey: 'depositClearingId' },
  unallocatedClearing: { name: 'ServOS Unallocated Clearing', type: 'BANK', number: 'SERVOS-UNALLOC', code: 'SOSUNALLOC', detailKey: 'unallocatedClearingId' },
  tipsPayable: { name: 'ServOS Tips Payable', type: 'CURRLIAB', code: 'SOSTIPS', detailKey: 'tipsAccountCode' },
  servicePayable: { name: 'ServOS Service Charge Payable', type: 'CURRLIAB', code: 'SOSSVCCHG', detailKey: 'serviceAccountCode' },
};

/** Default clearing account per tender kind. 'other' (a method we do not recognise) keeps the old card default and is flagged. */
export const KIND_ACCOUNT = { card: 'cardClearing', cash: 'cashClearing', gift_card: 'giftClearing', deposit: 'depositClearing', unallocated: 'unallocatedClearing', other: 'cardClearing' };

// Loyalty rewards and promo codes lower the sale; they are not money and never post as takings.
const isMoney = (r) => r.kind !== 'discount';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A mapped account value: a Xero AccountID (the mapping screen stores the id when an account has no code) or a code. */
export function accountRef(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  return UUID.test(v) ? { AccountID: v } : { AccountCode: v };
}

/**
 * The mapped bank account for a tender row. An older row's method exactly as the till wrote
 * it comes first (that is the key the mapping screen showed before v5.9.11), then the method.
 */
function mappedBank(row, paymentMap) {
  const keys = [...(row.rawMethods || []), row.method];
  for (const k of keys) {
    const v = paymentMap?.[k];
    if (v) return v;
  }
  return null;
}

/**
 * Which default accounts the day needs (so xero-sales creates only those in Xero).
 * Returns an array of DEFAULT_ACCOUNTS keys.
 */
export function requiredDefaults(summary, mapping = {}) {
  const need = new Set();
  const rows = [...(summary?.sales?.byMethod || []), ...(summary?.refunds?.byMethod || [])];
  for (const r of rows) {
    if (!r.gross || !isMoney(r)) continue;
    if (!mappedBank(r, mapping.paymentMap)) need.add(KIND_ACCOUNT[r.kind] || 'cardClearing');
    if (r.tip > 0 && !mapping.tipsAccount) need.add('tipsPayable');
    if (r.service > 0 && !mapping.serviceAccount) need.add('servicePayable');
  }
  return [...need];
}

const minorToMajor = (m) => Math.round(m) / 100;

/** Short, stable, readable id for a reference: the first 8 characters of the bank account id. */
const shortId = (id) => String(id || '').replace(/-/g, '').slice(0, 8) || 'none';

/**
 * Plan the day. `detail` holds the resolved default account ids and codes (xero_config.detail);
 * `mapping` is xero_config.mapping. Returns { transactions, warnings } where each transaction
 * is { key, direction, accountId, accountDefault, methods, totals:{gross,tip,service,sales},
 * reference, payload } and payload is the Xero BankTransaction object (no wrapper).
 */
export function planXeroDay(summary, { mapping = {}, detail = {}, sample = false } = {}) {
  const warnings = [];
  const date = summary.date;
  const paymentMap = mapping.paymentMap || {};
  const revenueRef = accountRef(mapping.revenueAccount) || accountRef(detail.salesAccountCode) || { AccountCode: '200' };
  const tipsRef = accountRef(mapping.tipsAccount) || accountRef(detail.tipsAccountCode);
  const serviceRef = accountRef(mapping.serviceAccount) || accountRef(detail.serviceAccountCode);
  const taxDefault = mapping.taxDefault || detail.taxType || 'NONE';
  const serviceTax = mapping.serviceTaxable === false ? 'NONE' : (mapping.serviceTax || taxDefault);

  const defaulted = new Set();
  const groups = new Map();   // key -> group
  const add = (direction, rows) => {
    for (const r of rows || []) {
      if (!r.gross || !isMoney(r)) continue;
      const mapped = mappedBank(r, paymentMap);
      const def = mapped ? null : (KIND_ACCOUNT[r.kind] || 'cardClearing');
      if (!mapped && r.kind === 'other') defaulted.add(r.method);
      const accountId = mapped || detail[DEFAULT_ACCOUNTS[def].detailKey] || null;
      const key = `${direction}:${accountId || def}`;
      const g = groups.get(key) || { key, direction, accountId, accountDefault: def, methods: [], totals: { gross: 0, tip: 0, service: 0, sales: 0 } };
      if (!g.methods.includes(r.method)) g.methods.push(r.method);
      g.totals.gross += r.gross; g.totals.tip += r.tip; g.totals.service += r.service; g.totals.sales += r.sales;
      groups.set(key, g);
    }
  };
  add('RECEIVE', summary.sales?.byMethod);
  add('SPEND', summary.refunds?.byMethod);

  if (defaulted.size) {
    warnings.push({ code: 'method_defaulted', message: `Payment methods with no bank account chosen went to Card Clearing: ${[...defaulted].join(', ')}. Choose an account for them under Account mapping.`, methods: [...defaulted] });
  }
  const anyTip = [...groups.values()].some((g) => g.totals.tip > 0);
  const anyService = [...groups.values()].some((g) => g.totals.service > 0);
  if (anyTip && !mapping.tipsAccount) warnings.push({ code: 'tips_unmapped', message: 'Tips have no account chosen, so they post to ServOS Tips Payable (money owed to staff, never sales).' });
  if (anyService && !mapping.serviceAccount) warnings.push({ code: 'service_unmapped', message: 'Service charge has no account chosen, so it posts to ServOS Service Charge Payable. Choose where it belongs under Account mapping.' });

  const transactions = [];
  for (const g of groups.values()) {
    const refund = g.direction === 'SPEND';
    const label = refund ? 'Refunds' : 'Takings';
    const what = g.methods.join(', ');
    const li = [];
    if (g.totals.sales > 0) {
      li.push({ Description: `${refund ? 'Refunded sales' : 'Sales'} ${date} (${what})`, Quantity: 1, UnitAmount: minorToMajor(g.totals.sales), ...revenueRef, TaxType: taxDefault });
      if (g.totals.tip > 0) li.push({ Description: `${refund ? 'Refunded tips' : 'Tips and gratuities'} ${date}`, Quantity: 1, UnitAmount: minorToMajor(g.totals.tip), ...(tipsRef || revenueRef), TaxType: 'NONE' });
      if (g.totals.service > 0) li.push({ Description: `${refund ? 'Refunded service charge' : 'Service charge'} ${date}`, Quantity: 1, UnitAmount: minorToMajor(g.totals.service), ...(serviceRef || revenueRef), TaxType: serviceTax });
    } else {
      // Odd data (tips plus service at or above the money): one line for the whole amount, as before.
      li.push({ Description: `${label} ${date} (${what})`, Quantity: 1, UnitAmount: minorToMajor(g.totals.gross), ...revenueRef, TaxType: taxDefault });
    }
    const reference = `ServOS ${label.toLowerCase()} ${date} (${shortId(g.accountId || g.accountDefault)})${sample ? ' TEST' : ''}`;
    transactions.push({
      key: g.key,
      direction: g.direction,
      accountId: g.accountId,
      accountDefault: g.accountDefault,
      methods: g.methods,
      totals: g.totals,
      reference,
      payload: {
        Type: g.direction,
        Contact: detail.contactId ? { ContactID: detail.contactId } : undefined,
        BankAccount: g.accountId ? { AccountID: g.accountId } : undefined,
        Date: date,
        Reference: reference,
        LineAmountTypes: 'Inclusive',
        LineItems: li,
      },
    });
  }
  // Takings before refunds, then by account, so the order is the same on every retry.
  transactions.sort((a, b) => (a.direction === b.direction ? a.key.localeCompare(b.key) : a.direction === 'RECEIVE' ? -1 : 1));
  return { transactions, warnings };
}

/** A short deterministic hash of a string (FNV-1a, hex), for idempotency keys. */
export function shortHash(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
