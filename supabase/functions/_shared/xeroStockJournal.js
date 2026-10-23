// supabase/functions/_shared/xeroStockJournal.js
//
// MULTI SITE STOCK Drop 4b (release 5.11.100, contract 4): the closing stock journal rules. PURE (no Deno,
// no network): xero-stock-journal imports it and node --test drives every branch
// (src/lib/stock/xeroStockJournal.test.js).
//
// The journal is ONE Xero ManualJournal per legal company per month, ALWAYS a DRAFT (the accountant posts
// it in Xero; ServOS never posts it): the stock account takes the movement (closing stock less opening
// stock), the stock movement account the other side. A rise in stock is a debit on the stock account.

/** The Xero scope a closing stock journal needs. */
export const JOURNAL_SCOPE = 'accounting.manualjournals';

/** The only status a journal is ever sent with. */
export const JOURNAL_STATUS = 'DRAFT';

/** The words each state shows on the Month end screen (exact, plain). */
export const STATUS_WORDS = Object.freeze({
  not_connected: 'Connect this legal company to Xero first.',
  needs_reconnect: 'Reconnect Xero to allow stock journals.',
  not_locked: 'Lock the month at every site of this legal company first.',
  sent: 'Sent to Xero as a draft. Your accountant posts it in Xero.',
  ready: 'Ready to send to Xero as a draft.',
  already: 'This month was already sent to Xero.',
  sending: 'This journal is already being sent.',
  nothing: 'No change in stock: nothing to send.',
  accounts: 'Pick the stock account and the stock movement account.',
});

/** Do the granted scopes (xero_connections.scopes, space separated) allow manual journals? */
export function scopesOk(scopes) {
  if (Array.isArray(scopes)) return scopes.map((s) => String(s).trim()).includes(JOURNAL_SCOPE);
  return String(scopes || '').split(/\s+/).filter(Boolean).includes(JOURNAL_SCOPE);
}

const MOVEMENT_RE = /closing stock|stock movement|opening stock|change in stock/i;
const COST_RE = /cost of (goods|sales)/i;
const isActive = (a) => !a?.Status || String(a.Status).toUpperCase() === 'ACTIVE';
const typeOf = (a) => String(a?.Type || a?.type || '').toUpperCase();
const codeOf = (a) => (a?.Code ?? a?.code ?? null) == null ? null : String(a.Code ?? a.code);
const nameOf = (a) => String(a?.Name ?? a?.name ?? '');

/** Xero's Accounts list as the screen shows it: [{ code, name, type }], only accounts with a code. */
export function accountList(accounts) {
  return (Array.isArray(accounts) ? accounts : [])
    .filter((a) => isActive(a) && codeOf(a))
    .map((a) => ({ code: codeOf(a), name: nameOf(a), type: typeOf(a) }));
}

/**
 * The suggested accounts: stock = the first ACTIVE account of Type INVENTORY; movement = the first ACTIVE
 * DIRECTCOSTS account named like closing stock or stock movement, else the first DIRECTCOSTS named cost of
 * goods or cost of sales, else null.
 */
export function suggestAccounts(accounts) {
  const list = (Array.isArray(accounts) ? accounts : []).filter((a) => isActive(a) && codeOf(a));
  const stock = list.find((a) => typeOf(a) === 'INVENTORY');
  const direct = list.filter((a) => typeOf(a) === 'DIRECTCOSTS');
  const movement = direct.find((a) => MOVEMENT_RE.test(nameOf(a))) || direct.find((a) => COST_RE.test(nameOf(a)));
  return { stockAccount: stock ? codeOf(stock) : null, movementAccount: movement ? codeOf(movement) : null };
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * The ManualJournals body for one legal company: { ManualJournals: [ { Narration, Date, Status: 'DRAFT',
 * LineAmountTypes: 'NoTax', JournalLines: [stock +movement, movement account -movement] } ] }.
 * Throws on a missing account, a zero amount or a bad date (the caller checks first and shows the words).
 */
export function journalBody({ amount, date, narration, stockAccount, movementAccount }) {
  const amt = round2(amount);
  if (!Number.isFinite(amt) || amt === 0) throw new Error(STATUS_WORDS.nothing);
  if (!stockAccount || !movementAccount) throw new Error(STATUS_WORDS.accounts);
  if (String(stockAccount) === String(movementAccount)) throw new Error('The stock account and the stock movement account must be different.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('The journal needs the last day of the month.');
  const desc = 'Closing stock movement, ServOS';
  return {
    ManualJournals: [{
      Narration: String(narration || 'Closing stock, ServOS').slice(0, 500),
      Date: String(date),
      Status: JOURNAL_STATUS,
      LineAmountTypes: 'NoTax',
      ShowOnCashBasisReports: false,
      JournalLines: [
        { LineAmount: amt, AccountCode: String(stockAccount), Description: desc },
        { LineAmount: round2(-amt), AccountCode: String(movementAccount), Description: desc },
      ],
    }],
  };
}

/**
 * Xero's idempotency key for one send (a repeat of the same send returns the first answer, so a double
 * click never makes two drafts). The accounts and the amount are in it: Xero keeps a failed answer under its
 * key too, so a send again with corrected accounts must not reuse the key of the one that failed.
 */
export function journalKey(orgId, from, tenantId, { stockAccount = '', movementAccount = '', amount = 0 } = {}) {
  const amt = Number.isFinite(Number(amount)) ? round2(amount).toFixed(2) : '0.00';
  return `sj:${tenantId}:${from}:${stockAccount}:${movementAccount}:${amt}:${String(orgId).slice(0, 8)}`.slice(0, 128);
}

/** Is a Xero error a refusal of rights (401 or 403): the venue must reconnect Xero. */
export function needsReconnect(err) {
  const s = Number(err?.status);
  return s === 401 || s === 403;
}

/**
 * The state of one legal company's journal from stock_month_end_journal's legal row:
 * 'not_connected' | 'needs_reconnect' | 'sent' | 'not_locked' | 'ready', with the words.
 */
export function journalStatus(legal) {
  if (!legal) return { status: 'not_connected', words: STATUS_WORDS.not_connected };
  if (legal.already && legal.already.xero_journal_id) return { status: 'sent', words: STATUS_WORDS.sent };
  // 5.11.100 review: a send is claimed before Xero is called; while it runs nobody sends again
  if (legal.status === 'sending' || legal.journal?.status === 'sending') return { status: 'sending', words: STATUS_WORDS.sending };
  if (!legal.connection_location_id || !legal.tenant_id) return { status: 'not_connected', words: STATUS_WORDS.not_connected };
  if (legal.scopes_ok === false) return { status: 'needs_reconnect', words: STATUS_WORDS.needs_reconnect };
  if (!legal.locked_all) return { status: 'not_locked', words: `Lock the month at every site of ${legal.legal_company || 'this legal company'} first.` };
  return { status: 'ready', words: STATUS_WORDS.ready };
}

/** The words for a status (the screen and the function answer the same). */
export function statusWords(status, legalName = null) {
  if (status === 'not_locked' && legalName) return `Lock the month at every site of ${legalName} first.`;
  return STATUS_WORDS[status] || '';
}

/**
 * Why a send is refused (null = go): the legal row, the accounts chosen. Words exactly as the screen shows.
 */
export function sendRefusal(legal, { stockAccount, movementAccount } = {}) {
  const st = journalStatus(legal);
  if (st.status === 'sent') return STATUS_WORDS.already;
  if (st.status === 'sending') return STATUS_WORDS.sending;
  if (st.status !== 'ready') return st.words;
  if (!Number.isFinite(round2(legal.amount)) || round2(legal.amount) === 0) return STATUS_WORDS.nothing;
  if (!stockAccount || !movementAccount) return STATUS_WORDS.accounts;
  if (String(stockAccount) === String(movementAccount)) return 'The stock account and the stock movement account must be different.';
  return null;
}

/** The ManualJournalID from Xero's answer, or null. */
export function journalIdOf(answer) {
  const j = Array.isArray(answer?.ManualJournals) ? answer.ManualJournals[0] : null;
  return j?.ManualJournalID ? String(j.ManualJournalID) : null;
}
