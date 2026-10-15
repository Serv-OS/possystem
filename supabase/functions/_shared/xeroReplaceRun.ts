// supabase/functions/_shared/xeroReplaceRun.ts
//
// Removes a day's old bank transactions from Xero so the day can be posted as a daily sales
// invoice (2 Oct 2026, Peter at Coffee Boy Leeds: "these are supposed to be invoices, I cannot
// find the invoice at all"). The rules are in _shared/xeroReplacePlan.js; this file makes the
// Xero calls, inside the SyncRun lease (_shared/syncRun.ts), in this order:
//   a. GET  /BankTransactions/{id}   each old transaction as Xero holds it now. ANY reconciled
//                                    one refuses the whole day before anything is changed. One
//                                    already DELETED counts as done.
//   b. the intent is saved on the log row (detail.replace, state 'deleting') BEFORE any delete,
//      so a crash is visible and a retry resumes.
//   c. POST /BankTransactions/{id}   { Status: 'DELETED' }, one at a time; the answer must say
//                                    DELETED. Each one is recorded as it goes. A refusal stops
//                                    the run and the row says which were removed and which not.
//                                    Any answer short of DELETED is checked with a second read
//                                    before ServOS says the transaction is still in Xero.
//   d. only when every one is DELETED: the old postings move to detail.replaced and the row is
//      left as "old transactions removed, invoice not sent yet" for the invoice path to finish.
// Xero facts honoured: a bank transaction can only be deleted while it is not reconciled, and a
// deleted one cannot be restored. Nothing here creates anything in Xero.
//
// `api` is (path, init) => the Accounting API answer (xeroApi with the token and tenant bound),
// passed in so the whole sequence is tested against a fake Xero (xeroReplaceRun.test.js).

import { bankPostings, classifyOld, replaceVerdict, intentPatch, deletedPatch, stoppedPatch, allDeletedPatch, xeroErrorWords } from './xeroReplacePlan.js';

type Api = (path: string, init?: Record<string, unknown>) => Promise<any>;

const txPath = (id: string) => `/BankTransactions/${encodeURIComponent(id)}`;
const UNRECONCILE = 'Sort that out in Xero first (unreconcile it, or move the lock date).';

/** Step a: each old posting with what Xero holds for it now (classifyOld). */
export async function readOldTransactions(api: Api, old: any[]) {
  const out: any[] = [];
  for (const o of old) {
    if (o.status === 'deleted' || !o.id) { out.push(classifyOld(o, null)); continue; }
    let bt: any = null;
    try { bt = (await api(txPath(o.id)))?.BankTransactions?.[0] || null; }
    catch (e) { if ((e as any)?.status !== 404) throw e; }   // not in this organisation: 'missing'
    out.push(classifyOld(o, bt));
  }
  return out;
}

/**
 * The invoice or credit note number the day would use, when Xero already holds a sales document
 * under it (at any status: Xero keeps a voided number too). Checked before anything is deleted,
 * so the old transactions are never removed for an invoice that could not then be sent.
 */
export async function numbersTaken(api: Api, numbers: { invoice?: string | null; creditNote?: string | null }) {
  const out: { type: string; number: string; status: string }[] = [];
  if (numbers.invoice) {
    const res = await api(`/Invoices?InvoiceNumbers=${encodeURIComponent(numbers.invoice)}`);
    const inv = (res?.Invoices || []).find((i: any) => i?.InvoiceNumber === numbers.invoice && String(i?.Type || 'ACCREC') === 'ACCREC');
    if (inv) out.push({ type: 'invoice', number: numbers.invoice, status: String(inv.Status || '') });
  }
  if (numbers.creditNote) {
    const res = await api(`/CreditNotes?where=${encodeURIComponent(`CreditNoteNumber=="${String(numbers.creditNote).replace(/"/g, '')}"`)}`);
    const cn = (res?.CreditNotes || []).find((c: any) => c?.CreditNoteNumber === numbers.creditNote && String(c?.Type || 'ACCRECCREDIT') === 'ACCRECCREDIT');
    if (cn) out.push({ type: 'credit_note', number: numbers.creditNote, status: String(cn.Status || '') });
  }
  return out;
}

/** The sentence for a number Xero already holds. */
export const takenMessage = (taken: { type: string; number: string; status: string }[]) => taken
  .map((t) => `Xero already has ${t.type === 'invoice' ? 'an invoice' : 'a credit note'} numbered ${t.number}${t.status ? ` (${t.status.toLowerCase()})` : ''}.`).join(' ')
  + (taken.length ? ' Check it in Xero before replacing this day.' : '');

type Stop = { words: string; certain: boolean; advice?: string };
/** How a replace run ended: every old transaction removed (ok), or stopped with the reason. */
export type RemoveResult = { ok: boolean; removed?: { key: string; reference: string; total: number | null }[]; code?: string; message?: string; nothingChanged?: boolean; checked?: any[] };
const attempt = (extra: Record<string, unknown>) => ({ action: 'replace_day', auto: false, ...extra });

/**
 * The run stopped, and the lease is released. With the intent recorded the row says how far it
 * got (stoppedPatch); before it, nothing was changed and the row stays exactly as it was (the
 * attempt is kept in its history). Also used by xero-sales when its own checks fail.
 */
export async function stopRun(run: any, code: string, s: Stop, checked: any[] = [], now: () => string = () => new Date().toISOString()): Promise<RemoveResult> {
  if (run.detail?.replace?.state !== 'deleting') {
    const message = `${s.words} Nothing was changed.`;
    await run.finish(run.status, {}, attempt({ ok: false, error: message }));
    return { ok: false, code, message, nothingChanged: true, checked };
  }
  const st = stoppedPatch(run.detail, s, now());
  await run.finish(st.status, { detail: st.patch }, attempt({ ok: false, error: st.message }));
  return { ok: false, code, message: st.message, nothingChanged: st.nothingChanged, checked };
}

/**
 * Step c for one transaction: ask Xero to delete it. null when Xero holds it as DELETED,
 * otherwise why not (a Stop). Whatever Xero answered to the request, short of DELETED, the
 * transaction is read again before ServOS decides (2 Oct 2026 review): a 400 can also mean it was
 * already deleted (by hand in that second, or by this very request), and the row must never go
 * back to "posted, nothing changed" for a transaction Xero no longer holds. `certain` is only
 * true when that second read shows it is still there.
 */
async function deleteOne(api: Api, o: any): Promise<Stop | null> {
  const statusOf = (res: any) => String(res?.BankTransactions?.[0]?.Status || '').toUpperCase();
  let status = '';
  let refusal: any = null;
  try {
    status = statusOf(await api(txPath(o.id), { method: 'POST', body: JSON.stringify({ BankTransactions: [{ BankTransactionID: o.id, Status: 'DELETED' }] }) }));
  } catch (e) { refusal = e || new Error('no answer'); }
  if (status === 'DELETED') return null;
  const http = Number(refusal?.status);
  const refused = !!refusal && http >= 400 && http < 500;
  // No answer at all (a dropped connection, a 5xx): ServOS does not know. The next press reads Xero again.
  if (refusal && !refused) return { words: `Xero did not answer when asked to remove "${o.reference}", so ServOS does not know yet whether it was removed.`, certain: false };
  // Too many requests: Xero did not take the request, so it is still there.
  if (http === 429) return { words: (refusal as Error).message || 'Xero is busy.', certain: true, advice: 'Wait a minute first.' };
  const words = refusal ? `Xero would not remove "${o.reference}": ${xeroErrorWords((refusal as Error)?.message)}` : `Xero did not confirm that "${o.reference}" was removed`;
  try { status = statusOf(await api(txPath(o.id))); }
  catch { return { words: `${words}${/[.!?]$/.test(words) ? '' : '.'} ServOS could not then read it from Xero, so it does not know yet whether it was removed.`, certain: false }; }
  if (status === 'DELETED') return null;
  if (refusal) return { words, certain: true, advice: UNRECONCILE };
  return { words: `${words} (it shows ${status ? status.toLowerCase() : 'no status'}).`, certain: true, advice: 'Check it in Xero first.' };
}

/**
 * Steps a to d on a claimed SyncRun. Always releases the lease (a thrown error is the caller's
 * to release, with stopRun). Returns
 *   { ok: true, removed: [{ key, reference, total }] }               every old transaction is gone
 *   { ok: false, code, message, nothingChanged, checked }            stopped; the row says why
 * who: { by, now? }.
 */
export async function removeOldDay(run: any, api: Api, who: { by?: unknown; now?: () => string } = {}): Promise<RemoveResult> {
  const now = who.now || (() => new Date().toISOString());
  const stop = (code: string, s: Stop, checked: any[]) => stopRun(run, code, s, checked, now);

  // a. What Xero holds. Refused before anything is changed when one is reconciled.
  const checked = await readOldTransactions(api, bankPostings(run.detail));

  // b. The intent, before the first delete (once per run).
  let recorded = false;
  const record = async () => {
    if (recorded) return;
    recorded = true;
    await run.save({ status: 'partial', detail: intentPatch(run.detail, { by: who.by, at: now(), runId: run.runId, status: run.status }) });
  };

  // One that Xero already shows as DELETED and the row still shows as in Xero: a delete whose
  // answer was lost last time, or one removed by hand in Xero. Recorded before anything else, so
  // a refusal below never leaves the row saying "posted" for something Xero no longer holds
  // (2 Oct 2026 review: one deleted by hand and another reconciled left the row untouched as ok).
  const found = checked.filter((o) => o.state === 'deleted' && run.postings[o.key]?.status !== 'deleted');
  if (found.length) {
    await record();
    for (const o of found) await run.save({ detail: deletedPatch(run.detail, o.key, now()) });
  }
  const verdict = replaceVerdict(checked);
  if (!verdict.ok) return stop(verdict.code as string, { words: verdict.message, certain: true }, checked);
  await record();

  // c. Delete each one; the answer must say DELETED.
  for (const o of checked) {
    if (run.postings[o.key]?.status === 'deleted') continue;
    if (o.state !== 'deleted') {
      const failed = await deleteOne(api, o);
      if (failed) return stop('delete_failed', failed, checked);
    }
    await run.save({ detail: deletedPatch(run.detail, o.key, now()) });
  }

  // d. Every old transaction is DELETED: the record is cleared for the invoice.
  const removed = checked.map((o) => ({ key: o.key, reference: o.reference, total: o.total }));
  await run.finish('error', { xero_id: null, detail: allDeletedPatch(run.detail, now()) }, attempt({ ok: true, removed: removed.length }));
  return { ok: true, removed };
}
