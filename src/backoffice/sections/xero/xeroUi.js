// src/backoffice/sections/xero/xeroUi.js
//
// Shared look for the Back Office Xero screens (XeroIntegration.jsx and the xero/ tabs):
// styles and small pure helpers. Plain JS, no components.

import { DISCOUNT_GROUPS } from '../../../../supabase/functions/_shared/accountingGroups.js';

export const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  h2: { fontSize: 15, fontWeight: 800, color: 'var(--t1)', margin: '0 0 6px' },
  h3: { fontSize: 13, fontWeight: 800, color: 'var(--t1)', margin: '16px 0 4px' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18, maxWidth: 620, lineHeight: 1.5 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 20, marginBottom: 14, maxWidth: 620 },
  wide: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 20, marginBottom: 14, maxWidth: 980 },
  btn: { padding: '11px 18px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '9px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  small: { padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  note: { fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.55 },
  pill: (bg, fg) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 800, background: bg, color: fg }),
  banner: (ok) => ({ padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700, marginBottom: 14, maxWidth: 620, background: ok ? 'rgba(46,143,78,.14)' : 'rgba(200,60,60,.14)', color: ok ? '#2f8f4e' : '#c33', border: `1px solid ${ok ? 'rgba(46,143,78,.3)' : 'rgba(200,60,60,.3)'}` }),
  info: { padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600, marginBottom: 14, maxWidth: 620, background: 'rgba(80,120,200,.12)', color: 'var(--t2)', border: '1px solid rgba(80,120,200,.3)' },
  warn: { marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(200,150,40,.12)', border: '1px solid rgba(200,150,40,.3)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--bdr)', color: 'var(--t3)', fontWeight: 700, whiteSpace: 'nowrap' },
  td: { padding: '6px 8px', borderBottom: '1px solid var(--bdr)', color: 'var(--t1)', verticalAlign: 'top' },
  num: { padding: '6px 8px', borderBottom: '1px solid var(--bdr)', color: 'var(--t1)', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  pre: { fontSize: 11.5, background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 8, padding: 10, overflow: 'auto', maxHeight: 360, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
};

/** The main button, greyed out when it cannot be pressed. */
export const btn = (off) => ({ ...S.btn, opacity: off ? 0.45 : 1, cursor: off ? 'not-allowed' : 'pointer' });

export const sel = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 9, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' };
export const input = { ...sel };
export const fieldRow = { display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, alignItems: 'center', marginBottom: 10 };
export const flabel = { fontSize: 12.5, fontWeight: 700, color: 'var(--t2)' };

/** An account as a select shows it. */
export const accountLabel = (a) => (a ? `${a.code ? `${a.code} · ` : ''}${a.name}` : '');

/** The account a saved value names (a code, or an id for accounts with no code). */
export function findAccount(accounts, ref) {
  const v = String(ref || '').trim();
  if (!v) return null;
  return (accounts || []).find((a) => a.id === v || (a.code && a.code.toUpperCase() === v.toUpperCase())) || null;
}

/** The value a select saves for an account: its code, else its id. */
export const accountRef = (a) => (a ? (a.code || a.id) : '');

/** Accounts that can receive a payment in Xero: bank accounts, or "Enable payments to this account". */
export const canTakePayments = (a) => !!a && (a.bank || String(a.type || '').toUpperCase() === 'BANK' || a.pay === true);

// 8 Oct 2026 (D5): a day with sales and no posting is 'missing' (red, with a Push button); a
// day with nothing to post is 'quiet'. Before this both read a grey "Not posted", and Leeds
// 30 Sep (143 sales) looked like a quiet Sunday for a week.
export const STATUS_LABEL = {
  posted: 'Posted', partly_posted: 'Partly posted', blocked: 'Blocked', failed: 'Failed', sending: 'Sending', waiting: 'Not posted',
  missing: 'Not posted', quiet: 'Nothing to post',
  // 13 Oct 2026: a day held back for a card fee that has not arrived yet. It posts by itself.
  fees_wait: 'Waiting for card fees',
};
export const STATUS_COLOUR = {
  posted: ['rgba(46,143,78,.16)', '#2f8f4e'], partly_posted: ['rgba(200,150,40,.16)', '#c89628'], blocked: ['rgba(200,150,40,.16)', '#c89628'],
  failed: ['rgba(200,60,60,.16)', '#c33'], sending: ['rgba(80,120,200,.16)', '#4a6fc0'], waiting: ['rgba(120,120,120,.16)', 'var(--t3)'],
  missing: ['rgba(200,60,60,.16)', '#c33'], quiet: ['rgba(120,120,120,.16)', 'var(--t3)'],
  fees_wait: ['rgba(80,120,200,.16)', '#4a6fc0'],
};

/** The outline on a field ServOS filled in for the person to check. */
export const suggested = (on) => (on ? { outline: '2px solid rgba(200,150,40,.65)', outlineOffset: 1 } : undefined);

// ── a day's refunds on the screens (13 Oct 2026) ────────────────────────────────
// What the invoice preview and the Postings history say about a day's refunds is decided here,
// in one place, so it is tested (src/lib/accounting/xeroRefundLines.test.js): a new day has its
// refunds as minus lines on the invoice, a day that fell back and every day posted before this
// keep their credit note, and an answer from an older xero-sales (no refundWay) reads as before.

const LINE_KIND = { sales: 'Sales', discount: 'Discount', gift: 'Gift cards', tip: 'Tips', service: 'Service', fee: 'Card fees' };

// 13 Oct 2026, card fees. The sentence under the payments of an invoice that carries the Card
// fees line: how much, and what it does to the payment it comes off. `view` is the plan view and
// `fee` its cardFees (major units). The fee comes off the ONE payment into the card clearing
// account, and that payment is named for what it holds: "The card payment" when it is card
// money alone, "The Card and Cash payment" where they share an account (the kinds, as the
// payment's own reference has them).
// "What the card processor pays for this day" is said ONLY when it is true: the payment is card
// money alone, every card payment of the day has its fee (fee.unknown is empty, so not on a day
// still waiting for one), and the day's card refunds are on the invoice. On a credit note day
// they are not in this payment, so the sentence says where they are instead.
const CARD_KIND = /^Card\b/;
const allCard = (kinds) => kinds.length > 0 && kinds.every((k) => CARD_KIND.test(String(k)));
function feeNoteWords(view, fee, fmt) {
  const before = fmt(fee.cardBefore || 0), after = fmt(fee.cardAfter || 0);
  const onAccount = (list) => (list || []).find((p) => p?.account && p.account === fee.cardAccount) || null;
  const kinds = onAccount(view.payments)?.kinds || [];
  const what = !kinds.length ? 'The payment into the card clearing account' : allCard(kinds) ? 'The card payment' : `The ${kinds.join(' and ')} payment`;
  const apart = view.creditNote ? onAccount(view.refundPayments) : null;
  const apartWords = apart ? ` ${allCard(apart.kinds || []) ? 'The card refunds' : `The ${(apart.kinds || []).join(' and ')} refunds`} of this day (${fmt(apart.amount || 0)}) are on the credit note.` : '';
  if (fee.net < 0) return `Card fees returned ${fmt(-fee.net)}: more fee came back on refunds (${fmt(fee.returned || 0)}) than this day's sales paid (${fmt(fee.charged || 0)}). ${what} is ${before} plus that: ${after}.${apartWords}`;
  const split = fee.returned > 0 ? `, ${fmt(fee.charged || 0)} on sales less ${fmt(fee.returned)} given back on refunds` : '';
  const whole = allCard(kinds) && !apart && !(fee.unknown || []).length;
  return `Card fees ${fmt(fee.net)}${split}. ${what} is ${before} less card fees: ${after}${whole ? ', what the card processor pays for this day.' : '.'}${apartWords}`;
}

/**
 * The words and choices of the invoice preview for one plan view (planView of xero-sales).
 * `tw` is 'VAT' or 'Tax'; `fmt` turns an amount into money as the screen shows it.
 *   asLines         the day's refunds are minus lines on the invoice
 *   note            the sentence under the invoice, only when its refunds are on it ('' otherwise)
 *   paymentsTitle   the heading of the payments on the invoice
 *   creditNote      the credit note to show, or null: a day with one always shows it
 *   refundPayments  its refund payments ([] on a day with none)
 *   refundTieTitle  the heading of the VAT per rate table of the refund side
 *   tagFor(line)    the small word under a line: 'Refund' only on a refund line
 *   feeNote         the sentence under the payments when the invoice carries the Card fees line
 *                   (13 Oct 2026), '' otherwise
 * Card fees: `note` and `paymentsTitle` speak of them ONLY when the invoice carries the line
 * (view.cardFees.line). With no cardFees (a site with card fees off, or an older xero-sales)
 * every word is exactly as before.
 */
export function previewWords(view, { tw = 'VAT', fmt = (n) => Number(n || 0).toFixed(2) } = {}) {
  const asLines = view?.refundWay === 'lines';
  const fee = view?.cardFees?.line && view.invoice ? view.cardFees : null;
  const feeWords = fee ? `${fee.net < 0 ? 'plus card fees returned' : 'less card fees'} ${fmt(Math.abs(fee.net))}` : '';
  return {
    asLines,
    note: !(asLines && view.invoice) ? ''
      : fee ? `Refunds are the minus lines before the card fees line. Sales ${fmt(view.totals?.sales || 0)} less refunds ${fmt(view.totals?.refunds || 0)} ${feeWords} makes the invoice total.`
        : `Refunds are the minus lines at the end. Sales ${fmt(view.totals?.sales || 0)} less refunds ${fmt(view.totals?.refunds || 0)} makes the invoice total.`,
    paymentsTitle: fee ? (asLines ? 'Payments on the invoice, takings less refunds and card fees (it shows as Paid)' : 'Payments on the invoice, takings less card fees (it shows as Paid)')
      : asLines ? 'Payments on the invoice, takings less refunds (it shows as Paid)' : 'Payments on the invoice (it shows as Paid)',
    feeNote: fee ? feeNoteWords(view, fee, fmt) : '',
    creditNote: view?.creditNote || null,
    refundPayments: view?.refundPayments || [],
    refundTieTitle: asLines ? `${tw} per rate on the refund lines` : `${tw} per rate on refunds`,
    tagFor: (line) => (line?.refund ? 'Refund' : (LINE_KIND[line?.kind] || line?.kind || '')),
  };
}

/**
 * The line an opened day shows in the Postings history when its refunds are on its invoice: only
 * once that invoice IS in Xero. A day Xero refused, or one whose answer was lost, says nothing
 * here (its own message says what happened); a credit note day never shows it.
 */
export const historyRefundNote = (d) => (d?.refundWay === 'lines' && d.postings?.INVOICE?.status === 'posted' ? 'Refunds are on the invoice as minus lines.' : '');

// ── card fees on the screens (13 Oct 2026) ──────────────────────────────────────
// Decided here, in one place, so it is tested (src/lib/accounting/xeroCardFees.test.js).

const FEE_LINE = new Set(['Card fees', 'Card fees returned']);
// The Card fees line of an invoice as it was SENT (the payload kept with its posting), or null.
const sentFeeLine = (posting, account) => (posting?.payload?.LineItems || [])
  .find((l) => FEE_LINE.has(l?.Description) && l.TaxType === 'NONE' && (!account || l.AccountCode === account || l.AccountID === account)) || null;

/**
 * The line an opened day shows in the Postings history about its card fees: only for a day
 * planned with them (d.cardFees, from xero-config history_detail) and only once its invoice IS
 * in Xero. What it says comes from the invoice as it was sent, when the row kept it, so it is
 * true whatever happened between attempts; else from what the day recorded. A day posted
 * without card fees, and every day posted before this, says nothing.
 */
export function historyFeeNote(d, fmt = (n) => Number(n || 0).toFixed(2)) {
  const c = d?.cardFees;
  const invoice = d?.postings?.INVOICE;
  if (!c || invoice?.status !== 'posted') return '';
  const sent = invoice.payload ? sentFeeLine(invoice, c.account) : null;
  const line = invoice.payload ? !!sent : !!c.line;
  const net = sent ? -Number(sent.UnitAmount) : Number(c.net) || 0;
  if (line) {
    return net < 0 ? `Card fees returned ${fmt(-net)} are on the invoice as a plus line, and the payment into the card clearing account includes them.`
      : `Card fees ${fmt(net)} are on the invoice as a minus line, and the payment into the card clearing account is net of them.`;
  }
  return c.reason && c.reason !== 'none' ? 'Card fees were not put on this invoice. The warnings below say why.' : '';
}

/**
 * Check figures: whether "I have checked these figures" can be pressed, and the words beside it
 * when it cannot. `res` is the xero-sales answer on screen. A day that is only waiting for a
 * card fee has nothing for the person to fix, so it says to pick an earlier day.
 */
export function figuresTick(res, { dirty = false, savedHash = '', checked = null } = {}) {
  // Worked out before the last save: the choices have changed since.
  const stale = !!res?.ok && !!savedHash && !!res.mappingHash && res.mappingHash !== savedHash;
  const ticked = !!res?.ok && !!checked?.hash && checked.hash === res.mappingHash && checked.date === res.date;
  const problems = res?.problems || [], notReady = res?.notReady || [];
  const canTick = !!res?.ok && !res.empty && !dirty && !stale && !ticked && !problems.length && !notReady.length;
  const onlyWaiting = !problems.length && notReady.length > 0 && notReady.every((n) => n?.code === 'card_fees_wait');
  const why = canTick || ticked ? ''
    : onlyWaiting ? 'This day is still waiting for a card fee. Pick an earlier day to check.'
      : problems.length || notReady.length ? 'Fix what stops this day first.'
        : dirty ? 'Save your changes first.'
          : stale ? 'These figures were worked out before your last save. Press Check figures again.' : '';
  return { stale, ticked, canTick, why };
}

/**
 * Postings: whether a row shows the red "not in Xero" line and its Push button. Every gap day
 * does, but not a day still waiting for a card fee: it is tried again by itself and a push only
 * repeats the wait. Once the wait is over (`until` on its not ready entry) the button is back,
 * so a day is never left waiting with nothing to press.
 */
export function showsGap(r, nowMs = Date.now()) {
  if (!r?.gap) return false;
  if (r.status !== 'fees_wait') return true;
  const until = Date.parse(r.notReady?.[0]?.until);
  return !(Number.isFinite(until) && nowMs < until);
}

/** The form after the "Put card fees on the daily invoice" tick changes. Off keeps the account it had, so ticking again brings it back. */
export function setCardFeesOn(map, on) {
  const next = { ...(map || {}) };
  const account = String(next.cardFees?.account || '').trim();
  if (on) next.cardFees = { enabled: true, ...(account ? { account } : {}) };
  else if (account) next.cardFees = { enabled: false, account };
  else delete next.cardFees;
  return next;
}

/** The form after the card fees account is chosen ('' clears it). */
export function setCardFeesAccount(map, account) {
  const cardFees = { ...(map?.cardFees || {}) };
  if (account) cardFees.account = account; else delete cardFees.account;
  return { ...(map || {}), cardFees };
}

/** The accounts the Card fees line can post to: Xero's expense accounts, never a bank account. */
export const expenseAccounts = (accounts) => (accounts || []).filter((a) => !a.bank && String(a.cls || '').toUpperCase() === 'EXPENSE');

// ── suggested choices merged into the Setup form ────────────────────────────────
// (Moved here from SiteSetup.jsx on 13 Oct 2026, unchanged but for 'cardFees', so it is tested.)

const NESTED = ['groups', 'clearing', 'itemGroups', 'cardFees'];

/**
 * Merge suggested choices into the form: nested maps merge, category choices already made stay.
 * cardFees is nested, so the account "Create a Card fees account" fills in never wipes the
 * person's own tick (`enabled`).
 */
export function mergePatch(map, patch) {
  const next = { ...map };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'discountAccount') {
      const accounts = { ...(next.discounts?.accounts || {}) };
      for (const d of DISCOUNT_GROUPS) if (!accounts[d]) accounts[d] = v;
      next.discounts = { ...(next.discounts || {}), accounts };
    } else if (k === 'discounts') {
      next.discounts = { ...(next.discounts || {}), ...v, accounts: { ...(next.discounts?.accounts || {}), ...(v?.accounts || {}) }, labels: { ...(next.discounts?.labels || {}), ...(v?.labels || {}) } };
    } else if (k === 'categoryGroups') {
      next.categoryGroups = { ...(v || {}), ...(next.categoryGroups || {}) };
    } else if (NESTED.includes(k)) {
      next[k] = { ...(next[k] || {}), ...(v || {}) };
    } else next[k] = v;
  }
  return next;
}
