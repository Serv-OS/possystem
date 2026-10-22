/**
 * stock/purchasingWords.js: the words and pills of the multi site Purchasing screens (multi site
 * stock Drop 3, v5.11.96, contract 4.1 and 4.2). Pure: the only import is the shared purchasing
 * rules (dayWords, moneyWords), so node --test drives every word here. Plain words, never a dash.
 *
 * Pill tones are the stockUi Pill tones: good, neutral, warn, bad, blue.
 */
import { dayWords, moneyWords } from './purchasingRules.js';

const pill = (text, tone) => Object.freeze({ text, tone });

/** stock_due_to_order statuses (map 4.3, mockup scrDue). */
export const DUE_PILLS = Object.freeze({
  ordered: pill('Ordered', 'good'),
  not_yet: pill('Not yet', 'neutral'),
  waiting_approval: pill('Waiting approval', 'warn'),
  missed: pill('Missed cut off', 'bad'),
  standing: pill('Standing order', 'blue'),
  held: pill('Held by supplier', 'blue'),
});
export const duePill = (status) => DUE_PILLS[status] || pill('Not yet', 'neutral');

/** stock_po_approvals statuses. */
export const APPROVAL_PILLS = Object.freeze({
  waiting: pill('Waiting approval', 'warn'),
  approved: pill('Approved', 'good'),
  sent_back: pill('Sent back', 'neutral'),
  sent_anyway: pill('Sent anyway', 'warn'),
  sent_unapproved: pill('Sent unapproved', 'warn'),
  missed: pill('Missed cut off', 'bad'),
  cancelled: pill('Cancelled', 'neutral'),
});
export const approvalPill = (status) => APPROVAL_PILLS[status] || null;

/** purchase_orders.status in words. */
export const ORDER_STATUS_WORDS = Object.freeze({ DRAFT: 'Draft', SENT: 'Sent', PARTIAL: 'Part received', RECEIVED: 'Received', CANCELLED: 'Cancelled' });
export const ORDER_STATUS_TONES = Object.freeze({ DRAFT: 'neutral', SENT: 'blue', PARTIAL: 'warn', RECEIVED: 'good', CANCELLED: 'neutral' });
export const orderStatusPill = (status) => pill(ORDER_STATUS_WORDS[status] || String(status || ''), ORDER_STATUS_TONES[status] || 'neutral');

/** supplier_invoices.match_status (H7). */
export const MATCH_PILLS = Object.freeze({
  matched: pill('Matched', 'good'),
  price_issue: pill('Price issue', 'warn'),
  qty_issue: pill('Quantity issue', 'warn'),
  both: pill('Both', 'bad'),
  by_hand: pill('Approved by hand', 'neutral'),
});
export const matchPill = (status) => MATCH_PILLS[status] || null;
export const LOCKED_PILL = pill('Locked', 'neutral');

/** stock_credit_requests.status and reason. */
export const CREDIT_PILLS = Object.freeze({ asked: pill('Asked', 'warn'), received: pill('Received', 'good'), written_off: pill('Written off', 'neutral') });
export const creditPill = (status) => CREDIT_PILLS[status] || pill('Asked', 'warn');
export const CREDIT_TABS = Object.freeze([['asked', 'Asked'], ['received', 'Received'], ['written_off', 'Written off']]);
export const CREDIT_REASONS = Object.freeze([['overcharge', 'Overcharge'], ['short', 'Short delivery'], ['not_coming', 'Not coming'], ['damaged', 'Damaged'], ['other', 'Other']]);
export const creditReasonWords = (r) => (CREDIT_REASONS.find(([id]) => id === r) || [null, 'Other'])[1];

/** Forecast reasons (4.2): the stored word and what the screen says. */
export const FORECAST_REASONS = Object.freeze([['weather', 'Weather'], ['local_event', 'Local event'], ['booking', 'Pre order or booking'], ['promotion', 'Promotion'], ['closure', 'Closure'], ['other', 'Other']]);
export const forecastReasonWords = (r) => (FORECAST_REASONS.find(([id]) => id === r) || [null, ''])[1];

/** The other pills of 4.1 used by more than one screen. */
export const PILLS = Object.freeze({
  overBudget: pill('Over budget', 'bad'),
  sentUnapproved: pill('Sent unapproved', 'warn'),
  priceRose: pill('Price rose', 'warn'),
  coming: pill('Coming', 'blue'),
  ourKitchen: pill('Our kitchen', 'blue'),
  partReceived: pill('Part received', 'warn'),
});
export const needsApprovalPill = (limit, symbol = '£') => pill(`Needs approval: over ${moneyWords(limit, symbol)}`, 'warn');

/** 'Standing order 6 a day' (every day of the week) or 'Standing order 6'. */
export function standingPillWords(qty, everyDay = false) {
  const q = Math.round((Number(qty) || 0) * 1000) / 1000;
  return everyDay ? `Standing order ${q} a day` : `Standing order ${q}`;
}

const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** 'every day', 'every Monday and Thursday', 'every Mon, Wed and Fri' for delivery_dows. */
export function dowsWords(dows) {
  const ds = [...new Set((dows || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (!ds.length) return 'no days';
  if (ds.length === 7) return 'every day';
  const names = ds.length > 2 ? ds.map((d) => LONG_DAYS[d].slice(0, 3)) : ds.map((d) => LONG_DAYS[d]);
  return `every ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}`;
}

/**
 * One standing order line on the supplier page (4.2): '<site>: 6 x 2 L whole milk every day. Sent by
 * us at the order by time, changeable until then.' or, for a supplier who holds it, 'Held by the
 * supplier, no email.'
 */
export function standingRowWords({ siteName = '', lines = [], dows = [], held = false } = {}) {
  const what = (lines || []).map((l) => `${Math.round((Number(l.qty_packs) || 0) * 1000) / 1000} x ${l.label || l.name || 'item'}`).join(', ') || 'nothing yet';
  const tail = held ? 'Held by the supplier, no email.' : 'Sent by us at the order by time, changeable until then.';
  return `${siteName ? `${siteName}: ` : ''}${what} ${dowsWords(dows)}. ${tail}`;
}

/**
 * The Order pad's budget card (4.2): null when there is no budget (the card is not drawn).
 * { title, rule, right, over }: '£2,140 spent + £320 basket of £2,600'.
 */
export function budgetWords(budget, basketTotal = 0, symbol = '£') {
  if (!budget || budget.budget === null || budget.budget === undefined) return null;
  const spent = Number(budget.spent) || 0;
  const basket = Number(basketTotal) || 0;
  const total = Number(budget.budget) || 0;
  return {
    title: 'Budget this week',
    rule: budget.rule === 'fixed' ? '(fixed)' : '(a % of forecast sales)',
    right: `${moneyWords(spent, symbol)} spent + ${moneyWords(basket, symbol)} basket of ${moneyWords(total, symbol)}`,
    over: spent + basket > total + 0.004,
  };
}

/** The Budgets screen's rule words. */
export const BUDGET_RULES = Object.freeze([['pct_of_forecast', '% of forecast'], ['fixed', 'Fixed']]);
export const budgetRuleWords = (b) => (b?.rule === 'fixed' ? 'Fixed' : b?.rule === 'pct_of_forecast' ? `${Number(b.pct)}% of forecast` : 'No budget');

/** A timestamp in the venue's time as 'Tue 14:00' (and 'Tue 22 Oct 14:00' with withDate). */
export function atWords(iso, tz = null, { withDate = false } = {}) {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(t);
    const g = (k) => parts.find((p) => p.type === k)?.value;
    const ymd = `${g('year')}-${g('month')}-${g('day')}`;
    const words = dayWords(ymd);
    return `${withDate ? words : words.slice(0, 3)} ${g('hour')}:${g('minute')}`;
  } catch { return ''; }
}

/** 'Coming 1 Nov' for a dated price that has not started. */
export function comingWords(ymd) {
  const w = dayWords(ymd);
  return w ? `Coming ${w.slice(4)}` : 'Coming';
}

/** A percentage change as '+6.2%' or '-3%'; '' when unknown. Over 5% is a "Price rose" pill. */
export function pctWords(pct) {
  const p = Number(pct);
  if (pct === null || pct === undefined || !Number.isFinite(p)) return '';
  const r = Math.round(p * 10) / 10;
  return `${r > 0 ? '+' : ''}${r}%`;
}
export const priceRose = (pct) => Number(pct) > 5;

/** The split total check (stock_invoice_split's words): ok within 1p. */
export function splitCheck(splits, total, symbol = '£') {
  const sum = Math.round((splits || []).reduce((s, x) => s + (Number(x.amount) || 0), 0) * 100) / 100;
  const t = Math.round((Number(total) || 0) * 100) / 100;
  const ok = Math.round(Math.abs(sum - t) * 100) <= 1;
  return { ok, sum, words: ok ? '' : `The splits add up to ${moneyWords(sum, symbol)}, the invoice is ${moneyWords(t, symbol)}.` };
}

/** The goods in temperature rule (the phone's): over 8 C is turned away. */
export const ACCEPT_MAX_C = 8;
export function tempCheck(tempC, dryGoods = false) {
  if (dryGoods) return { known: true, tooWarm: false };
  const n = tempC === '' || tempC === null || tempC === undefined ? null : Number(tempC);
  const known = n !== null && Number.isFinite(n);
  return { known, tooWarm: known && n > ACCEPT_MAX_C };
}

/** A receive line that is not the product ordered needs its allergens checked (4.2). */
export const SUBSTITUTE_NOTICE = 'This is a different product. Check its allergens before it goes on the shelf.';

/** The Order pad and Orders words of 4.2. */
export const PAD_WORDS = Object.freeze({
  noSiteTitle: 'Order pad',
  noSiteSub: 'An order belongs to one site.',
  whichSite: 'Which site?',
  manyNoteBefore: 'Head office can also order for many sites at once (launch allocations, central cups and beans) from ',
  manyButton: 'Order for many sites',
  manyNoteAfter: '.',
  approvalsNoticeBold: 'Approvals never cost a delivery.',
  approvalsNotice: ' The approver is told at once. 60 minutes before the order by time it passes to the area manager; 30 minutes before, head office gets ',
  approvalsNoticeSend: 'Send anyway',
  approvalsNoticeEnd: '; at the order by time it is sent and marked "sent unapproved".',
  sentForApprovalBold: 'Sent for approval.',
  sentForApproval: ' The approver is told now; it passes up 60 and 30 minutes before the cut off.',
  orderSentBold: 'Order sent',
  orderSent: ' to the site\'s order email with CC, account number and a CSV attached.',
  sendOrder: 'Send order',
  savedLists: 'Saved lists',
  saveAsList: 'Save this basket as a list',
  repeatLast: 'Repeat last order',
});
export const HEADERS_MULTI_OF = (deliveryDow) => ['Item', 'On hand', 'Forecast use', `Par (${deliveryDow == null ? 'next' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][deliveryDow]})`, 'Suggested', 'Order', 'Supplier', 'Line £ (ex VAT)'];
export const noRulesWords = (supplier) => `No delivery days set for ${supplier || 'this supplier'}.`;
export const sendBackToast = (name) => `Sent back to ${name || 'the person who raised it'} to change.`;
export const manyOrdersWords = (orders, suppliers) => `${orders} order${orders === 1 ? '' : 's'} to ${suppliers} supplier${suppliers === 1 ? '' : 's'}`;

/** Plain words for the toast after submitOrder answered, per order. */
export function submitToast({ approvals = 0, sent = 0, internal = 0, failed = 0 } = {}) {
  const parts = [];
  if (sent) parts.push(`${sent} order${sent === 1 ? '' : 's'} sent`);
  if (internal) parts.push(`${internal} sent to the central kitchen`);
  if (approvals) parts.push(`${approvals} sent for approval`);
  if (failed) parts.push(`${failed} could not be sent`);
  return parts.length ? `${parts.join(', ')}.` : 'Nothing was sent.';
}
