// supabase/functions/_shared/xeroReplacePlan.js
//
// REPLACE AN OLD DAY WITH A DAILY SALES INVOICE (2 Oct 2026). Peter, Coffee Boy Leeds, after
// switching the site to the daily sales invoice from 27 Sep and pushing 27 Sep again: "these are
// supposed to be invoices, I cannot find the invoice at all". The day was already in Xero the old
// way (Receive Money and Spend Money into the clearing accounts), and a day is never mixed
// (dayModel), so the push answered "already" and sent nothing. Those days could never become
// invoices.
//
// This is the pure half of "Replace with a daily sales invoice" (xero-sales, action
// 'replace_day'; the Xero calls are in _shared/xeroReplaceRun.ts):
//   - which postings of a day can be replaced, and why not when they cannot (replaceability);
//   - what Xero says about each old transaction, and the refusal when one is reconciled
//     (classifyOld, replaceVerdict). Xero only deletes a bank transaction that is not
//     reconciled, and a deleted one cannot be restored, so the whole day is refused BEFORE
//     anything is changed;
//   - the record on the log row, detail.replace, written BEFORE the first delete so a crash is
//     visible and a retry resumes:
//       { by, at, runId, old: [{ key, id, reference, total, state }], state, was }
//     state 'deleting'  old transactions are being removed; a normal push is refused meanwhile
//           'refused'   Xero would not remove the first one: nothing changed, the day is as it was
//           'deleted'   every old transaction is gone, the invoice is not in Xero yet: the row
//                       says so and a normal push finishes it as an invoice
//           'done'      the invoice is in Xero
//   - the words for each of those, so a day never looks posted when nothing is in Xero.
// The old postings are never thrown away: they move to detail.replaced, with who and when.
// Pure JS, no network. Auto (nightly) runs never replace anything.

import { invoiceNumber, mappingHash } from './xeroInvoicePlan.js';

const BANK_KEY = /^(RECEIVE|SPEND):/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const money = (n) => Number(n || 0).toFixed(2);
const named = (list) => list.map((o) => `"${o.reference}"`).join(', ');
const isGone = (o) => o?.state === 'deleted';

export const OLD_WAY = 'This day is in Xero as bank transactions (the old way).';
export const REPLACE_QUESTION = `${OLD_WAY} Replace it with a daily sales invoice?`;
export const REPLACE_RESUME = 'This day is part way through being replaced with a daily sales invoice. Finish replacing it?';
export const BEFORE_START = 'Move the first invoice day back to include this day first.';
export const NEEDS_UPDATE = 'Replacing it with a daily sales invoice needs a ServOS update.';
export const OLD_REMOVED = 'The old bank transactions were removed from Xero.';
export const INVOICE_PENDING = `${OLD_REMOVED} The sales invoice has not been sent yet. Press Push sales to Xero to send it.`;
export const REPLACE_PENDING = `${OLD_REMOVED} The sales invoice is not in Xero yet.`;
export const NO_INVOICE_YET = 'This site has not posted a sales invoice to Xero yet. Post one day as a sales invoice first (a day that is not in Xero yet), then replace this one.';

/**
 * The day's postings made the old way: [{ key, direction 'RECEIVE' | 'SPEND', id, reference,
 * total, status, deletedAt }], takings first. `status` is 'posted', 'sending' (the answer never
 * came back) or 'deleted' (removed from Xero by a replace).
 */
export function bankPostings(detail) {
  const postings = detail?.postings && typeof detail.postings === 'object' ? detail.postings : {};
  const out = [];
  for (const [key, p] of Object.entries(postings)) {
    if (!BANK_KEY.test(key) || !p || typeof p !== 'object') continue;
    const total = Number(p.total);
    out.push({
      key, direction: key.startsWith('SPEND') ? 'SPEND' : 'RECEIVE', id: p.id || null, reference: p.reference || key,
      total: p.total != null && Number.isFinite(total) ? total : null, status: p.status || null, deletedAt: p.deletedAt || null,
    });
  }
  return out.sort((a, b) => (a.direction === b.direction ? a.key.localeCompare(b.key) : a.direction === 'RECEIVE' ? -1 : 1));
}

/** A replace is part way through removing the old transactions: a normal push must not touch the day. */
export const replaceInFlight = (row) => row?.detail?.replace?.state === 'deleting';

/**
 * Can this day be replaced with a sales invoice? Returns
 *   { replaceable, resume, reason, message, number, startDate, old }
 * reason (when it cannot): 'not_old_way' | 'no_record' | 'invoice_pending' | 'site_not_invoice' |
 * 'before_start' | 'figures' | 'unfinished' | 'no_invoice_yet'. `resume` is true when an earlier
 * replace stopped part way. `number` is the invoice it would create (SOS-LEEDS-20260927).
 *
 * provenInvoice (2 Oct 2026 review): true when this site already has a day in Xero as a sales
 * invoice. Xero cannot restore a deleted transaction, and Xero's own checks on the invoice and
 * its payments are only met when they are sent, so the first invoice a site ever sends is never
 * the one that follows a delete (Leeds had not sent one when this was built). Anything but true
 * refuses a new replace; one that already stopped part way may always be finished.
 */
export function replaceability({ row = null, postMode = null, mapping = null, date = '', provenInvoice = false } = {}) {
  const m = mapping && typeof mapping === 'object' ? mapping : {};
  const startDate = YMD_RE.test(String(m.invoiceStartDate || '')) ? String(m.invoiceStartDate) : null;
  const code = String(m.site?.code || '');
  const all = bankPostings(row?.detail);
  const base = {
    replaceable: false, resume: false, reason: null, message: '', startDate,
    number: code && YMD_RE.test(String(date)) ? invoiceNumber(code, date) : null,
    old: all.map((p) => ({ key: p.key, direction: p.direction, id: p.id, reference: p.reference, total: p.total, status: p.status })),
  };
  const no = (reason, message) => ({ ...base, reason, message });
  if (!all.length) {
    if (row?.detail?.replace?.state === 'deleted' && row?.status !== 'ok') return no('invoice_pending', INVOICE_PENDING);
    const keys = Object.keys(row?.detail?.postings || {});
    if (row?.status === 'ok' && !keys.length) {
      return no('no_record', 'This day was posted before ServOS kept a record of what it sent, so it cannot remove it from Xero. Remove it in Xero by hand, then ask for help to post the invoice.');
    }
    return no('not_old_way', 'This day is not in Xero as bank transactions.');
  }
  if (postMode !== 'sales_invoice') return no('site_not_invoice', 'This site posts bank transactions. Switch it to the daily sales invoice first.');
  if (!startDate || String(date) < startDate) return no('before_start', BEFORE_START);
  if (!m.figuresChecked?.hash || m.figuresChecked.hash !== mappingHash(m)) {
    return no('figures', "The choices changed after a day's figures were checked. Check a day's figures again first.");
  }
  const unsure = all.filter((p) => !((p.status === 'posted' && p.id) || p.status === 'deleted'));
  if (unsure.length) {
    return no('unfinished', `Part of this day was sent the old way and Xero never answered (${named(unsure)}). Press Push sales to Xero to finish the day first, then replace it.`);
  }
  const resume = replaceInFlight(row);
  if (!resume && provenInvoice !== true) return no('no_invoice_yet', NO_INVOICE_YET);
  return { ...base, replaceable: true, resume, message: resume ? REPLACE_RESUME : REPLACE_QUESTION };
}

/** What an "already" answer (and a refused push) carries about replacing: replaceable true or false, and why. */
export function replaceAnswer(can) {
  return {
    replaceable: !!can?.replaceable, resume: !!can?.resume, reason: can?.reason || null, message: can?.message || '',
    number: can?.number || null, startDate: can?.startDate || null,
    old: (can?.old || []).map((o) => ({ key: o.key, direction: o.direction, reference: o.reference, total: o.total, status: o.status })),
  };
}

// ── what Xero holds ──────────────────────────────────────────────────────────

/**
 * One old posting against Xero's own record of it (GET BankTransactions/{id}; null when Xero
 * has no such transaction). state: 'live' (can be removed), 'reconciled' (Xero will not remove
 * it), 'deleted' (already gone: treated as done), 'missing' (not in this organisation),
 * 'not_ours' (the id is another kind of transaction).
 */
export function classifyOld(old, bt) {
  const out = { ...old, state: 'missing', reconciled: false, xeroStatus: null, xeroTotal: null, edited: false };
  if (old?.status === 'deleted') return { ...out, state: 'deleted', xeroStatus: 'DELETED' };
  if (!bt || !bt.BankTransactionID) return out;
  const status = String(bt.Status || '').toUpperCase();
  const xeroTotal = bt.Total != null && Number.isFinite(Number(bt.Total)) ? Number(bt.Total) : null;
  const seen = { ...out, xeroStatus: status || null, xeroTotal };
  if (String(bt.BankTransactionID).toLowerCase() !== String(old.id || '').toLowerCase()) return { ...seen, state: 'not_ours' };
  if (bt.Type && String(bt.Type).toUpperCase() !== old.direction) return { ...seen, state: 'not_ours' };
  if (status === 'DELETED') return { ...seen, state: 'deleted' };
  const reconciled = bt.IsReconciled === true || String(bt.IsReconciled).toLowerCase() === 'true';
  // Changed in Xero since ServOS sent it: still removed, but the preview says so.
  const edited = xeroTotal != null && old.total != null && Math.abs(xeroTotal - old.total) >= 0.005;
  return { ...seen, state: reconciled ? 'reconciled' : 'live', reconciled, edited };
}

/**
 * May the day be replaced, given what Xero holds? ANY reconciled transaction refuses the whole
 * day before anything is changed, naming the references. { ok, code, message, refs }.
 */
export function replaceVerdict(checked) {
  const list = Array.isArray(checked) ? checked : [];
  const it = (l) => (l.length === 1 ? 'it' : 'these');
  const refs = (l) => l.map((o) => `"${o.reference}"${o.total != null ? ` (${money(o.total)})` : ''}`).join(', ');
  const rec = list.filter((o) => o.state === 'reconciled');
  if (rec.length) return { ok: false, code: 'reconciled', refs: rec.map((o) => o.reference), message: `Reconciled in Xero: ${refs(rec)}. Unreconcile ${it(rec)} in Xero first, then press again.` };
  const other = list.filter((o) => o.state === 'not_ours');
  if (other.length) return { ok: false, code: 'not_ours', refs: other.map((o) => o.reference), message: `Xero holds ${refs(other)} as a different kind of transaction from the one ServOS sent, so ${it(other) === 'it' ? 'it was' : 'they were'} left alone. Check ${it(other)} in Xero.` };
  const missing = list.filter((o) => o.state === 'missing');
  if (missing.length) return { ok: false, code: 'missing', refs: missing.map((o) => o.reference), message: `ServOS could not find ${refs(missing)} in this Xero organisation, so it cannot remove ${it(missing) === 'it' ? 'it' : 'them'}. Check that this venue is still connected to the organisation the day was posted to.` };
  return { ok: true, code: null, refs: [], message: '' };
}

// ── the record on the log row (detail.replace) ───────────────────────────────

/** The words on a day whose old transactions are part way through being removed. */
export function progressMessage(replace, why = '') {
  const old = Array.isArray(replace?.old) ? replace.old : [];
  const gone = old.filter(isGone);
  const left = old.filter((o) => !isGone(o));
  const because = why ? `${String(why).trim()} ` : '';
  if (!gone.length) return `A replace with a daily sales invoice was started for this day and has not finished. ${because}Press Replace with invoice again.`;
  return `This day is part way through being replaced with a daily sales invoice. Removed from Xero: ${named(gone)}.${left.length ? ` Not removed yet: ${named(left)}.` : ''} ${because}Press Replace with invoice again to finish.`;
}

/**
 * A replace run ended on an error (a check that failed, a lost lease), not on Xero's answer to a
 * delete. The words come from what the run recorded (2 Oct 2026 review: a run that lost its lease
 * after two of three deletes answered "Nothing was changed"). With the intent recorded the day
 * is part way: { partial: true, message: which were removed, which not, press again }. Before
 * it, nothing was changed.
 */
export function interrupted(replace, words = '') {
  const why = String(words || '').trim();
  if (replace?.state === 'deleting') return { partial: true, message: progressMessage(replace, why) };
  return { partial: false, message: `${why} Nothing was changed.`.trim() };
}

/**
 * Step b: the intent, written BEFORE anything is deleted. A retry of a replace that stopped part
 * way keeps who started it and when, and what is already gone. Returns the detail patch.
 * who: { by, at, runId, status (the row's status before this run) }.
 */
export function intentPatch(detail, who = {}) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const prev = d.replace;
  const old = bankPostings(d).map((p) => ({
    key: p.key, id: p.id, reference: p.reference, total: p.total,
    state: p.status === 'deleted' ? 'deleted' : 'pending', ...(p.deletedAt ? { deletedAt: p.deletedAt } : {}),
  }));
  const replace = prev?.state === 'deleting'
    ? { ...prev, runId: who.runId || prev.runId || null, resumedBy: who.by || null, resumedAt: who.at || null, old }
    : {
      by: who.by || null, at: who.at || null, runId: who.runId || null, old, state: 'deleting',
      // The row as it was, so a refusal that changed nothing puts it back, and the audit keeps the old lines.
      was: { status: who.status || 'ok', error: d.error ?? null, lines: Array.isArray(d.lines) ? d.lines : [], warnings: Array.isArray(d.warnings) ? d.warnings : [] },
    };
  return { replace, error: progressMessage(replace) };
}

/** Step c, after Xero confirmed one transaction DELETED: the posting, its line and the record say so. */
export function deletedPatch(detail, key, at) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const postings = { ...(d.postings || {}) };
  if (postings[key]) postings[key] = { ...postings[key], status: 'deleted', deletedAt: at };
  const lines = Array.isArray(d.lines) ? d.lines.filter((l) => l?.key !== key) : [];
  const rep = d.replace || {};
  const replace = { ...rep, old: (rep.old || []).map((o) => (o.key === key ? { ...o, state: 'deleted', deletedAt: at } : o)) };
  return { postings, lines, replace, error: progressMessage(replace) };
}

/**
 * The run stopped before every old transaction was gone. stop: { words, certain, advice }:
 * `words` is why, `advice` what to put right first (a sentence, without "press again").
 * `certain` means ServOS knows what Xero holds (it has just read it, or Xero refused outright).
 * With nothing removed and that certainty the day is exactly as it was, so the row goes back to
 * how it was ('refused'). Otherwise it stays part way ('deleting') and says which were removed
 * and which were not; a retry continues with the rest.
 * Returns { status, patch, message, nothingChanged }.
 */
export function stoppedPatch(detail, stop = {}, at = null) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const rep = d.replace || {};
  const gone = (rep.old || []).filter(isGone);
  const why = String(stop.words || '').trim();
  const advice = String(stop.advice || '').trim();
  if (!gone.length && stop.certain) {
    const message = `${why} Nothing was changed in Xero.${advice ? ` ${advice} Then press Replace with invoice again.` : ''}`;
    return {
      status: rep.was?.status || 'ok', nothingChanged: true, message,
      patch: { replace: { ...rep, state: 'refused', refusedAt: at, refusal: why }, error: rep.was?.error ?? null },
    };
  }
  // The part way words end with their own "press again", so the reason does not say it twice.
  const error = progressMessage(rep, `${why.replace(/, then press again\.$/, '.')}${advice ? ` ${advice}` : ''}`);
  return { status: 'partial', nothingChanged: false, message: error, patch: { replace: { ...rep, stoppedAt: at, stopped: why }, error } };
}

/**
 * Step d, only when EVERY old transaction is DELETED: the old postings move to detail.replaced
 * (kept for audit, with who and when), and postings are cleared so the day resolves to the sales
 * invoice. The row is saved as an error with INVOICE_PENDING until the invoice is in Xero, so it
 * never looks posted while nothing is there. Throws if a posting is still in Xero.
 */
export function allDeletedPatch(detail, at) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const left = bankPostings(d).filter((p) => p.status !== 'deleted');
  if (left.length) throw new Error(`Still in Xero: ${named(left)}. The day's record was not cleared.`);
  const rep = d.replace || {};
  const was = rep.was || {};
  const kept = { ...rep };
  delete kept.was;
  const entry = {
    model: 'bank_tx', by: rep.by || null, startedAt: rep.at || null, removedAt: at,
    postings: d.postings || {}, lines: was.lines || [], warnings: was.warnings || [],
  };
  return {
    replaced: [...(Array.isArray(d.replaced) ? d.replaced : []), entry],
    postings: {}, lines: [], documents: null, warnings: [], model: 'sales_invoice', notReady: null, problems: null,
    replace: { ...kept, state: 'deleted', deletedAt: at },
    error: INVOICE_PENDING,
  };
}

/** The invoice is in Xero: the replace is done. Any other state is returned as it is. */
export function replaceDone(replace, { at = null, documents = [] } = {}) {
  if (!replace || replace.state !== 'deleted') return replace || null;
  const doc = (documents || []).find((x) => x?.type === 'invoice') || (documents || []).find((x) => x?.type === 'credit_note');
  return { ...replace, state: 'done', doneAt: at, invoice: doc?.number || null };
}

/**
 * Step e: the invoice post failed after the old transactions were removed. The row must say so
 * plainly. `sent` is true when part of the invoice reached Xero (the error then already says
 * to press again).
 */
export function pendingInvoiceError(replace, error, sent = false) {
  if (replace?.state !== 'deleted') return error;
  const msg = String(error || '').trim();
  if (sent) return `${OLD_REMOVED} ${msg}`;
  return `${OLD_REMOVED} The sales invoice has not been sent yet: ${msg}${/[.!?]$/.test(msg) ? '' : '.'} Press Push sales to Xero to send it.`;
}

/** The note kept on the invoice day (shown under Postings): what it replaced, and when. */
export function replacedWarning(replace) {
  if (!replace || (replace.state !== 'deleted' && replace.state !== 'done')) return null;
  const old = Array.isArray(replace.old) ? replace.old : [];
  const when = String(replace.deletedAt || '').slice(0, 10);
  return { code: 'replaced_old_way', message: `This day was first in Xero as bank transactions (${named(old)}). They were removed from Xero${when ? ` on ${when}` : ''} and this sales invoice replaced them.` };
}

/** Xero's own words out of an error from _shared/xero.ts ("Xero API /x failed: 400 {json}"). */
export function xeroErrorWords(message) {
  const s = String(message || '');
  const i = s.indexOf('{');
  if (i >= 0) {
    try {
      const j = JSON.parse(s.slice(i));
      const said = [];
      for (const el of j.Elements || []) for (const v of el?.ValidationErrors || []) if (v?.Message) said.push(String(v.Message));
      if (said.length) return [...new Set(said)].join(' ');
      if (j.Message) return String(j.Message);
      if (j.Detail) return String(j.Detail);
    } catch { /* not JSON: the text below */ }
  }
  return s.replace(/^Xero API \S+ failed:\s*\d*\s*/, '').trim().slice(0, 300) || 'Xero gave no reason.';
}

// ── the preview and the Back Office ──────────────────────────────────────────

/**
 * The preview (a dry run, nothing changed): the old entries with references and totals,
 * reconciled or not, and the invoice that would be sent. `problems` are plain sentences that
 * stop the replace; canReplace is false while there is any.
 */
export function previewView({ checked = [], verdict = null, plan = null, problems = [], resume = false } = {}) {
  const all = [...(verdict && !verdict.ok ? [verdict.message] : []), ...problems.filter(Boolean)];
  const doc = (x) => (x ? { number: x.number, total: Math.round(x.total) / 100 } : null);
  return {
    canReplace: !all.length, resume: !!resume, problems: all,
    old: checked.map((o) => ({
      key: o.key, kind: o.direction === 'SPEND' ? 'Spend money' : 'Receive money', reference: o.reference, total: o.total,
      state: o.state, reconciled: !!o.reconciled, xeroTotal: o.edited ? o.xeroTotal : null,
    })),
    invoice: doc(plan?.invoice), creditNote: doc(plan?.creditNote),
  };
}

const NONE = { show: 'none', text: '', resume: false };

/**
 * What the Posting tab shows under "Already pushed": { show 'button' | 'note' | 'none', text }.
 * answer: the push's answer ({ model, date, replace? }); site: { postMode, startDate }. An answer
 * with no `replace` comes from an xero-sales that cannot replace yet: an honest line, no button.
 */
export function offerForAnswer(answer, site = {}) {
  if (!answer || answer.model !== 'bank_tx' || site.postMode !== 'sales_invoice') return NONE;
  const r = answer.replace;
  if (!r) {
    const before = !site.startDate || String(answer.date || '') < String(site.startDate);
    return { show: 'note', text: `${OLD_WAY} ${before ? BEFORE_START : NEEDS_UPDATE}`, resume: false };
  }
  if (r.replaceable) return { show: 'button', text: r.pending ? REPLACE_PENDING : r.resume ? REPLACE_RESUME : REPLACE_QUESTION, resume: !!r.resume };
  // 7 Oct 2026: a day posted to another Xero organisation (before the site moved) cannot be
  // replaced from here; the answer's own warning says where it is.
  if (r.reason === 'not_old_way' || r.reason === 'other_organisation') return NONE;
  // A day from before ServOS recorded what it sent: only worth saying from the first invoice day on.
  if (r.reason === 'no_record' && (!site.startDate || String(answer.date || '') < String(site.startDate))) return NONE;
  if (r.reason === 'invoice_pending' || r.reason === 'no_record') return { show: 'note', text: r.message, resume: false };
  return { show: 'note', text: `${OLD_WAY} ${r.message}`, resume: false };
}

/**
 * The Posting tab after a replace attempt failed (2 Oct 2026 review). When old transactions were
 * removed (all of them: err.invoicePending; some, or ServOS does not know: err.replace.resume)
 * the "Already pushed" answer on screen is no longer true: the day must not look posted while
 * nothing, or only part, is in Xero. Returns the answer that takes its place, which keeps the
 * replace panel open ({ model, date, replace }), or null when nothing was changed and the answer
 * on screen still stands.
 */
export function answerAfterFailure(answer, err = {}) {
  const pending = !!err?.invoicePending;
  if (!pending && !err?.replace?.resume) return null;
  return {
    model: 'bank_tx', date: answer?.date || err?.date || null,
    replace: { ...(answer?.replace || {}), ...(err?.replace || {}), replaceable: true, resume: true, reason: null, pending },
  };
}

/**
 * What a Postings row offers: a day posted the old way at a site that now posts sales invoices
 * gets "Replace with invoice" from its first invoice day on, and the BEFORE_START line earlier.
 * row: { model, status, date }; site: { postMode, startDate }.
 */
export function offerForRow(row, site = {}) {
  if (!row || row.model !== 'bank_tx' || site.postMode !== 'sales_invoice') return NONE;
  if (row.status !== 'posted' && row.status !== 'partly_posted') return NONE;
  if (!site.startDate || String(row.date || '') < String(site.startDate)) return { show: 'note', text: `${OLD_WAY} ${BEFORE_START}`, resume: false };
  return { show: 'button', text: REPLACE_QUESTION, resume: false };
}
