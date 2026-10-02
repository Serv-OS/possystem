/**
 * xeroReplaceDay.test.js: replace a day that is in Xero as bank transactions (the old way) with
 * its daily sales invoice (2 Oct 2026). Peter, Coffee Boy Leeds, after switching the site to the
 * sales invoice from 27 Sep and pushing 27 Sep again: "these are supposed to be invoices, I
 * cannot find the invoice at all".
 * Run: `npm test`, or `node --test src/lib/accounting/xeroReplaceDay.test.js`.
 *
 * The fixture is the real Leeds 27 Sep row shape: RECEIVE card 986.83, RECEIVE cash 111.00,
 * SPEND refunds 3.80, references with no site name, status 'ok'.
 *
 * Pinned:
 *   1. Which postings are replaceable, and the reason when a day is not (the site still posts
 *      bank transactions, the day is before the first invoice day, figures not checked, an
 *      answer Xero never gave, a day that is already an invoice).
 *   2. The "already" answer carries replaceable true or false and why; the Back Office shows a
 *      button, a plain line, or nothing, and an honest line while xero-sales cannot replace yet.
 *   3. ANY reconciled transaction refuses the whole day before anything is changed, naming the
 *      references. One already deleted counts as done.
 *   4. detail.replace: the intent is written before the first delete; each delete is recorded;
 *      a refusal with nothing removed puts the row back; a refusal part way keeps which were
 *      removed and which were not; the record is cleared only when every one is gone, and the
 *      old postings are kept in detail.replaced. dayModel then resolves to the sales invoice.
 *   5. The whole sequence against a fake Xero and the real SyncRun: the happy path, a reconciled
 *      day (no delete is ever sent), a refusal part way and the retry that resumes, a delete
 *      whose answer was lost, and a row that never looks posted when nothing is in Xero.
 *   6. xero-sales ships the two new files; the pure one imports nothing from outside.
 *   7. The 2 Oct review: a refusal from Xero is checked with a second read before the row goes
 *      back to "posted" (a 400 can mean it was already deleted); one found deleted while another
 *      is reconciled is recorded, not left as posted; a run that lost its lease part way never
 *      says "Nothing was changed"; the Posting tab takes "Already pushed" down once old entries
 *      were removed; a site that has never posted a sales invoice cannot start a replace.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bankPostings, replaceability, replaceAnswer, replaceInFlight, classifyOld, replaceVerdict, intentPatch, deletedPatch,
  stoppedPatch, allDeletedPatch, replaceDone, pendingInvoiceError, replacedWarning, progressMessage, xeroErrorWords,
  previewView, offerForAnswer, offerForRow, answerAfterFailure, interrupted,
  OLD_WAY, REPLACE_QUESTION, REPLACE_RESUME, REPLACE_PENDING, BEFORE_START, NEEDS_UPDATE, OLD_REMOVED, INVOICE_PENDING, NO_INVOICE_YET,
} from '../../../supabase/functions/_shared/xeroReplacePlan.js';
import { dayModel, mappingHash } from '../../../supabase/functions/_shared/xeroInvoicePlan.js';
import { removeOldDay, readOldTransactions, numbersTaken, takenMessage, stopRun } from '../../../supabase/functions/_shared/xeroReplaceRun.ts';
import { claimSyncRun, readSyncRow } from '../../../supabase/functions/_shared/syncRun.ts';
import { sharedDepsOf } from '../../../scripts/edgeFnDeps.mjs';

// ── the real Leeds 27 Sep shape ──────────────────────────────────────────────
const CARD = '6026f133-3895-4787-9b7a-31497b0d8fc9';
const CASH = '7785f1b2-11b4-4352-b2f4-e3dfa4f5e86f';
const K_CARD = `RECEIVE:${CARD}`, K_CASH = `RECEIVE:${CASH}`, K_REFUND = `SPEND:${CARD}`;
const ID = { [K_CARD]: '18478a67-a9c2-4a56-9b18-f298567c5b70', [K_CASH]: '5308752f-2def-4b7f-a0c8-fc29d60e029a', [K_REFUND]: 'c13dbadb-0185-4a69-9004-33cef94c97b8' };
const REF = { [K_CARD]: 'ServOS takings 2026-09-27 (6026f133)', [K_CASH]: 'ServOS takings 2026-09-27 (7785f1b2)', [K_REFUND]: 'ServOS refunds 2026-09-27 (6026f133)' };
const TOTAL = { [K_CARD]: 986.83, [K_CASH]: 111, [K_REFUND]: 3.8 };
const DATE = '2026-09-27';

const leedsDetail = () => ({
  date: DATE, error: null, sample: false,
  venue: { currency: 'GBP', dayStart: '06:30', timezone: 'Europe/London' },
  window: { from: '2026-09-27T05:30:00.000Z', to: '2026-09-28T05:30:00.000Z' },
  lines: [K_CARD, K_CASH, K_REFUND].map((key) => ({ key, total: TOTAL[key], reference: REF[key], bankTransactionID: ID[key], direction: key.startsWith('SPEND') ? 'refunds' : 'takings', link: `https://go.xero.com/Bank/ViewTransaction.aspx?bankTransactionID=${ID[key]}` })),
  postings: {
    // Stored in this order on the live row: the refund first.
    [K_REFUND]: { at: '2026-09-28T17:00:56.682Z', id: ID[K_REFUND], vat: { 'OUTPUT2|20%': 3.8 }, total: 3.8, status: 'posted', reference: REF[K_REFUND], xeroStatus: 'AUTHORISED' },
    [K_CARD]: { at: '2026-09-28T17:00:55.058Z', id: ID[K_CARD], vat: { 'OUTPUT2|20%': 977.34 }, total: 986.83, status: 'posted', reference: REF[K_CARD], xeroStatus: 'AUTHORISED' },
    [K_CASH]: { at: '2026-09-28T17:00:55.749Z', id: ID[K_CASH], vat: { 'OUTPUT2|20%': 111 }, total: 111, status: 'posted', reference: REF[K_CASH], xeroStatus: 'AUTHORISED' },
  },
  warnings: [{ code: 'vat_differs', message: 'The VAT Xero works out from these lines differs from the VAT ServOS booked.' }],
  history: [{ ok: true, auto: false, posted: 3, status: 'ok' }],
});
const leedsRow = (patch = {}) => ({ status: 'ok', xero_id: Object.values(ID).join(','), detail: { ...leedsDetail(), ...patch } });

const baseMapping = { site: { code: 'LEEDS', name: 'Coffee Boy Leeds' }, clearing: { card: 'SOSCARDCLR', cash: 'SOSCASHCLR' }, tipsAccount: 'SOSTIPS', invoiceStartDate: '2026-09-27' };
const leedsMapping = (patch = {}) => { const m = { ...baseMapping, ...patch }; return { ...m, figuresChecked: { hash: mappingHash(m), date: '2026-10-01' } }; };
// provenInvoice: the site already has a day in Xero as a sales invoice (see the 2 Oct review tests).
const can = (o = {}) => replaceability({ row: leedsRow(), postMode: 'sales_invoice', mapping: leedsMapping(), date: DATE, provenInvoice: true, ...o });

// ── 1. which postings are replaceable ────────────────────────────────────────

test('bankPostings: the Leeds 27 Sep day is two Receive Money and one Spend Money, takings first', () => {
  const old = bankPostings(leedsDetail());
  assert.deepEqual(old.map((o) => [o.key, o.direction, o.total, o.status]), [
    [K_CARD, 'RECEIVE', 986.83, 'posted'], [K_CASH, 'RECEIVE', 111, 'posted'], [K_REFUND, 'SPEND', 3.8, 'posted'],
  ]);
  assert.deepEqual(old.map((o) => o.id), [ID[K_CARD], ID[K_CASH], ID[K_REFUND]], 'each with the Xero BankTransactionID to remove');
  assert.equal(old[0].reference, 'ServOS takings 2026-09-27 (6026f133)');
  // An invoice day has none.
  assert.deepEqual(bankPostings({ postings: { INVOICE: { status: 'posted', id: 'i1' }, 'PAY:SOSCARDCLR': { status: 'posted', id: 'p1' } } }), []);
  assert.deepEqual(bankPostings(null), []);
});

test('replaceability: Leeds 27 Sep can be replaced, and would become SOS-LEEDS-20260927', () => {
  const r = can();
  assert.equal(r.replaceable, true);
  assert.equal(r.reason, null);
  assert.equal(r.resume, false);
  assert.equal(r.number, 'SOS-LEEDS-20260927');
  assert.equal(r.message, REPLACE_QUESTION);
  assert.equal(r.old.length, 3);
  // A half posted old day whose three are all recorded in Xero can be replaced as well.
  assert.equal(can({ row: { ...leedsRow(), status: 'partial' } }).replaceable, true);
});

test('replaceability: each reason a day cannot be replaced, in plain words', () => {
  // Huddersfield: the site still posts bank transactions.
  const hudd = can({ postMode: 'invoice', mapping: { paymentMap: { card: CARD, cash: CASH } }, date: '2026-09-28' });
  assert.deepEqual([hudd.replaceable, hudd.reason], [false, 'site_not_invoice']);
  // 26 Sep at Leeds: before the first invoice day (27 Sep).
  const before = can({ date: '2026-09-26' });
  assert.deepEqual([before.replaceable, before.reason, before.message], [false, 'before_start', BEFORE_START]);
  assert.equal(before.message, 'Move the first invoice day back to include this day first.');
  assert.equal(can({ mapping: leedsMapping({ invoiceStartDate: undefined }) }).reason, 'before_start', 'no first invoice day at all');
  // The choices changed after the figures were checked: not Ready.
  const lapsed = can({ mapping: { ...leedsMapping(), tipsAccount: '9999' } });
  assert.deepEqual([lapsed.replaceable, lapsed.reason], [false, 'figures']);
  assert.equal(can({ mapping: baseMapping }).reason, 'figures', 'never checked');
  // An old posting Xero never answered for: ServOS does not know its id, so it cannot remove it.
  const sending = leedsRow();
  sending.status = 'partial';
  sending.detail.postings[K_CASH] = { status: 'sending', reference: REF[K_CASH] };
  const unsure = can({ row: sending });
  assert.deepEqual([unsure.replaceable, unsure.reason], [false, 'unfinished']);
  assert.match(unsure.message, /ServOS takings 2026-09-27 \(7785f1b2\)/);
  // Already an invoice, never posted, and a day from before ServOS recorded what it sent.
  assert.equal(can({ row: { status: 'ok', detail: { model: 'sales_invoice', postings: { INVOICE: { status: 'posted', id: 'i1' } } } } }).reason, 'not_old_way');
  assert.equal(can({ row: null }).reason, 'not_old_way');
  assert.equal(can({ row: { status: 'ok', detail: {} } }).reason, 'no_record');
});

// ── 2. the "already" answer and what the Back Office shows ───────────────────

test('the already answer carries replaceable true or false, and why', () => {
  const yes = replaceAnswer(can());
  assert.deepEqual([yes.replaceable, yes.reason, yes.number, yes.startDate], [true, null, 'SOS-LEEDS-20260927', '2026-09-27']);
  assert.deepEqual(yes.old.map((o) => [o.reference, o.total]), [[REF[K_CARD], 986.83], [REF[K_CASH], 111], [REF[K_REFUND], 3.8]]);
  assert.equal(yes.old[0].id, undefined, 'Xero ids are not needed by the screen');
  const no = replaceAnswer(can({ date: '2026-09-26' }));
  assert.deepEqual([no.replaceable, no.reason, no.message], [false, 'before_start', BEFORE_START]);
});

test('offerForAnswer: a button, a plain line, or nothing; an honest line before xero-sales is deployed', () => {
  const site = { postMode: 'sales_invoice', startDate: '2026-09-27' };
  const answer = (replace, date = DATE) => ({ ok: true, already: true, model: 'bank_tx', date, ...(replace ? { replace } : {}) });
  assert.deepEqual(offerForAnswer(answer(replaceAnswer(can())), site), { show: 'button', text: REPLACE_QUESTION, resume: false });
  assert.equal(REPLACE_QUESTION, 'This day is in Xero as bank transactions (the old way). Replace it with a daily sales invoice?');
  const before = offerForAnswer(answer(replaceAnswer(can({ date: '2026-09-26' })), '2026-09-26'), site);
  assert.deepEqual([before.show, before.text], ['note', `${OLD_WAY} ${BEFORE_START}`]);
  // The xero-sales in production today answers with no `replace`: no button, an honest line.
  assert.deepEqual(offerForAnswer(answer(null), site), { show: 'note', text: `${OLD_WAY} ${NEEDS_UPDATE}`, resume: false });
  assert.equal(offerForAnswer(answer(null, '2026-09-26'), site).text, `${OLD_WAY} ${BEFORE_START}`);
  // A site on bank transactions, and an invoice day, are offered nothing.
  assert.equal(offerForAnswer(answer(replaceAnswer(can())), { postMode: 'bank_tx' }).show, 'none');
  assert.equal(offerForAnswer({ already: true, model: 'sales_invoice', date: DATE }, site).show, 'none');
  // A day from before ServOS recorded what it sent says so only from the first invoice day on.
  const noRecord = replaceAnswer(can({ row: { status: 'ok', detail: {} } }));
  assert.equal(offerForAnswer(answer(noRecord), site).show, 'note');
  assert.equal(offerForAnswer(answer(noRecord, '2026-09-10'), site).show, 'none');
  // A replace that stopped part way offers to finish.
  const row = leedsRow(); row.status = 'partial'; row.detail = { ...row.detail, ...intentPatch(row.detail, { by: { id: 'u1' }, at: 'T0', runId: 'A' }) };
  assert.deepEqual(offerForAnswer(answer(replaceAnswer(can({ row }))), site), { show: 'button', text: REPLACE_RESUME, resume: true });
});

test('offerForRow: old way days get "Replace with invoice" from the first invoice day on', () => {
  const site = { postMode: 'sales_invoice', startDate: '2026-09-27' };
  assert.equal(offerForRow({ model: 'bank_tx', status: 'posted', date: '2026-09-27' }, site).show, 'button');
  assert.equal(offerForRow({ model: 'bank_tx', status: 'posted', date: '2026-10-01' }, site).show, 'button');
  assert.equal(offerForRow({ model: 'bank_tx', status: 'partly_posted', date: '2026-09-28' }, site).show, 'button');
  assert.deepEqual(offerForRow({ model: 'bank_tx', status: 'posted', date: '2026-09-26' }, site), { show: 'note', text: `${OLD_WAY} ${BEFORE_START}`, resume: false });
  assert.equal(offerForRow({ model: 'sales_invoice', status: 'posted', date: '2026-09-29' }, site).show, 'none');
  assert.equal(offerForRow({ model: 'bank_tx', status: 'waiting', date: '2026-09-29' }, site).show, 'none');
  assert.equal(offerForRow({ model: 'bank_tx', status: 'posted', date: '2026-09-28' }, { postMode: 'bank_tx', startDate: null }).show, 'none', 'Huddersfield keeps the old way');
});

// ── 3. what Xero holds, and the refusal when reconciled ──────────────────────

const xeroTx = (key, patch = {}) => ({ BankTransactionID: ID[key], Type: key.startsWith('SPEND') ? 'SPEND' : 'RECEIVE', Status: 'AUTHORISED', IsReconciled: false, Reference: REF[key], Total: TOTAL[key], ...patch });

test('classifyOld: live, reconciled, already deleted, missing, not ours, changed in Xero', () => {
  const [card, cash, refund] = bankPostings(leedsDetail());
  assert.equal(classifyOld(card, xeroTx(K_CARD)).state, 'live');
  const rec = classifyOld(card, xeroTx(K_CARD, { IsReconciled: true }));
  assert.deepEqual([rec.state, rec.reconciled], ['reconciled', true]);
  assert.equal(classifyOld(card, xeroTx(K_CARD, { IsReconciled: 'true' })).state, 'reconciled');
  assert.equal(classifyOld(cash, xeroTx(K_CASH, { Status: 'DELETED' })).state, 'deleted', 'already deleted counts as done');
  assert.equal(classifyOld(cash, xeroTx(K_CASH, { Status: 'DELETED', IsReconciled: true })).state, 'deleted');
  assert.equal(classifyOld(refund, null).state, 'missing');
  assert.equal(classifyOld(refund, xeroTx(K_REFUND, { Type: 'RECEIVE' })).state, 'not_ours');
  assert.equal(classifyOld(refund, xeroTx(K_CARD)).state, 'not_ours', 'another id');
  const edited = classifyOld(card, xeroTx(K_CARD, { Total: 990 }));
  assert.deepEqual([edited.state, edited.edited, edited.xeroTotal], ['live', true, 990]);
  assert.equal(classifyOld({ ...card, status: 'deleted' }, null).state, 'deleted', 'recorded as removed by an earlier attempt');
});

test('replaceVerdict: any reconciled transaction refuses the whole day, naming the references', () => {
  const old = bankPostings(leedsDetail());
  const live = old.map((o) => classifyOld(o, xeroTx(o.key)));
  assert.deepEqual(replaceVerdict(live), { ok: true, code: null, refs: [], message: '' });
  const one = old.map((o) => classifyOld(o, xeroTx(o.key, { IsReconciled: o.key === K_CARD })));
  const v = replaceVerdict(one);
  assert.deepEqual([v.ok, v.code, v.refs], [false, 'reconciled', [REF[K_CARD]]]);
  assert.equal(v.message, 'Reconciled in Xero: "ServOS takings 2026-09-27 (6026f133)" (986.83). Unreconcile it in Xero first, then press again.');
  const two = replaceVerdict(old.map((o) => classifyOld(o, xeroTx(o.key, { IsReconciled: o.key !== K_CASH }))));
  assert.match(two.message, /^Reconciled in Xero: "ServOS takings 2026-09-27 \(6026f133\)" \(986\.83\), "ServOS refunds 2026-09-27 \(6026f133\)" \(3\.80\)\. Unreconcile these in Xero first, then press again\.$/);
  // One already deleted and the rest live: fine.
  assert.equal(replaceVerdict(old.map((o) => classifyOld(o, xeroTx(o.key, o.key === K_CASH ? { Status: 'DELETED' } : {})))).ok, true);
  assert.equal(replaceVerdict(old.map((o) => classifyOld(o, o.key === K_CASH ? null : xeroTx(o.key)))).code, 'missing');
});

// ── 4. the state machine of detail.replace ───────────────────────────────────

const WHO = { by: { id: 'u-peter', email: 'peter@example.test' }, at: '2026-10-02T10:00:00.000Z', runId: 'A', status: 'ok' };
const apply = (detail, patch) => ({ ...detail, ...patch });

test('detail.replace: intent first, each delete recorded, cleared only when all are gone', () => {
  let d = leedsDetail();
  // b. the intent
  d = apply(d, intentPatch(d, WHO));
  assert.equal(d.replace.state, 'deleting');
  assert.deepEqual([d.replace.by, d.replace.at, d.replace.runId], [WHO.by, WHO.at, 'A']);
  assert.deepEqual(d.replace.old.map((o) => [o.key, o.id, o.reference, o.total, o.state]), [
    [K_CARD, ID[K_CARD], REF[K_CARD], 986.83, 'pending'], [K_CASH, ID[K_CASH], REF[K_CASH], 111, 'pending'], [K_REFUND, ID[K_REFUND], REF[K_REFUND], 3.8, 'pending'],
  ]);
  assert.equal(d.replace.was.status, 'ok');
  assert.equal(d.replace.was.lines.length, 3);
  assert.match(d.error, /was started for this day and has not finished/);
  assert.equal(replaceInFlight({ status: 'partial', detail: d }), true);
  assert.equal(Object.keys(d.postings).length, 3, 'nothing is cleared at the intent');
  assert.throws(() => allDeletedPatch(d, 'T'), /Still in Xero/, 'the record is never cleared while a transaction is still in Xero');

  // c. one delete confirmed
  d = apply(d, deletedPatch(d, K_CARD, '2026-10-02T10:00:01.000Z'));
  assert.equal(d.postings[K_CARD].status, 'deleted');
  assert.equal(d.postings[K_CARD].id, ID[K_CARD], 'its Xero id is kept');
  assert.deepEqual(d.lines.map((l) => l.key), [K_CASH, K_REFUND], 'its Open in Xero line goes');
  assert.deepEqual(d.replace.old.map((o) => o.state), ['deleted', 'pending', 'pending']);
  assert.equal(d.error, `This day is part way through being replaced with a daily sales invoice. Removed from Xero: "${REF[K_CARD]}". Not removed yet: "${REF[K_CASH]}", "${REF[K_REFUND]}". Press Replace with invoice again to finish.`);
  assert.equal(dayModel({ status: 'partial', detail: d }, 'sales_invoice', '2026-09-27', DATE), 'bank_tx', 'still the old way until every one is gone');
  assert.throws(() => allDeletedPatch(d, 'T'), /Still in Xero/);

  // A retry resumes: who started it and when are kept, what is gone stays gone.
  const again = intentPatch(d, { by: { id: 'u-other' }, at: '2026-10-02T11:00:00.000Z', runId: 'B', status: 'partial' });
  assert.deepEqual([again.replace.by, again.replace.at, again.replace.runId], [WHO.by, WHO.at, 'B']);
  assert.deepEqual([again.replace.resumedBy, again.replace.resumedAt], [{ id: 'u-other' }, '2026-10-02T11:00:00.000Z']);
  assert.deepEqual(again.replace.old.map((o) => o.state), ['deleted', 'pending', 'pending']);
  assert.equal(again.replace.was.status, 'ok', 'the row as it was before the FIRST attempt');
  d = apply(d, again);

  // the rest
  d = apply(d, deletedPatch(d, K_CASH, '2026-10-02T11:00:01.000Z'));
  d = apply(d, deletedPatch(d, K_REFUND, '2026-10-02T11:00:02.000Z'));
  assert.deepEqual(d.lines, []);

  // d. every one is DELETED: the record is cleared and the old postings are kept for audit.
  const cleared = allDeletedPatch(d, '2026-10-02T11:00:03.000Z');
  d = apply(d, cleared);
  assert.deepEqual(d.postings, {});
  assert.equal(d.replaced.length, 1);
  assert.deepEqual([d.replaced[0].model, d.replaced[0].by, d.replaced[0].startedAt, d.replaced[0].removedAt], ['bank_tx', WHO.by, WHO.at, '2026-10-02T11:00:03.000Z']);
  assert.deepEqual(Object.keys(d.replaced[0].postings).sort(), [K_CARD, K_CASH, K_REFUND].sort());
  assert.ok(Object.values(d.replaced[0].postings).every((p) => p.status === 'deleted' && p.id && p.deletedAt));
  assert.equal(d.replaced[0].lines.length, 3, 'the lines as they were posted');
  assert.equal(d.replace.state, 'deleted');
  assert.equal(d.replace.was, undefined);
  assert.equal(d.model, 'sales_invoice');
  assert.equal(d.error, INVOICE_PENDING);
  assert.equal(INVOICE_PENDING, 'The old bank transactions were removed from Xero. The sales invoice has not been sent yet. Press Push sales to Xero to send it.');
  // Saved as an error (never ok), the day now resolves to the sales invoice, and a push finishes it.
  const row = { status: 'error', detail: d };
  assert.equal(dayModel(row, 'sales_invoice', '2026-09-27', DATE), 'sales_invoice');
  assert.equal(replaceInFlight(row), false);
  const pending = replaceability({ row, postMode: 'sales_invoice', mapping: leedsMapping(), date: DATE });
  assert.deepEqual([pending.replaceable, pending.reason, pending.message], [false, 'invoice_pending', INVOICE_PENDING]);

  // e. the invoice post failed: the row says so plainly; part sent: Xero's own "press again".
  assert.equal(pendingInvoiceError(d.replace, 'Xero API /Invoices failed: 500 oops'),
    'The old bank transactions were removed from Xero. The sales invoice has not been sent yet: Xero API /Invoices failed: 500 oops. Press Push sales to Xero to send it.');
  assert.match(pendingInvoiceError(d.replace, 'Part of the day reached Xero before this failed: x. Press again to finish.', true), /^The old bank transactions were removed from Xero\. Part of the day reached Xero/);
  assert.equal(pendingInvoiceError(null, 'plain'), 'plain', 'a day that never replaced anything keeps its own words');
  assert.equal(pendingInvoiceError({ state: 'done' }, 'plain'), 'plain');

  // The invoice is in Xero: done, with its number; the day keeps a note of what it replaced.
  const done = replaceDone(d.replace, { at: '2026-10-02T11:00:09.000Z', documents: [{ type: 'invoice', number: 'SOS-LEEDS-20260927' }, { type: 'payment' }] });
  assert.deepEqual([done.state, done.doneAt, done.invoice], ['done', '2026-10-02T11:00:09.000Z', 'SOS-LEEDS-20260927']);
  assert.equal(replaceDone(null, {}), null);
  assert.equal(replaceDone({ state: 'deleting' }, {}).state, 'deleting', 'only a cleared day becomes done');
  const note = replacedWarning(d.replace);
  assert.equal(note.code, 'replaced_old_way');
  assert.match(note.message, /first in Xero as bank transactions \("ServOS takings 2026-09-27 \(6026f133\)", .*\)\. They were removed from Xero on 2026-10-02 and this sales invoice replaced them\./);
  assert.equal(replacedWarning({ state: 'deleting', old: [] }), null);
  assert.equal(replacedWarning(null), null);
});

test('a refusal with nothing removed puts the row back; part way it keeps which were removed', () => {
  let d = leedsDetail();
  d = apply(d, intentPatch(d, WHO));
  // Xero refused the first delete outright: nothing changed, the day is as it was.
  const first = stoppedPatch(d, { words: 'Xero would not remove "x": locked.', certain: true, advice: 'Move the lock date first.' }, 'T1');
  assert.deepEqual([first.status, first.nothingChanged], ['ok', true]);
  assert.equal(first.patch.replace.state, 'refused');
  assert.equal(first.patch.error, null, 'the row is as it was: posted, no error');
  assert.equal(first.message, 'Xero would not remove "x": locked. Nothing was changed in Xero. Move the lock date first. Then press Replace with invoice again.');
  // A reconciled one found when reading (no advice needed: the words already say what to do).
  assert.equal(stoppedPatch(d, { words: 'Reconciled in Xero: "x" (1.00). Unreconcile it in Xero first, then press again.', certain: true }, 'T1').message,
    'Reconciled in Xero: "x" (1.00). Unreconcile it in Xero first, then press again. Nothing was changed in Xero.');
  assert.equal(replaceInFlight({ detail: apply(d, first.patch) }), false);
  // Xero never answered: ServOS does not know, so the row stays part way and says so.
  const lost = stoppedPatch(d, { words: 'Xero did not answer.', certain: false }, 'T1');
  assert.deepEqual([lost.status, lost.nothingChanged, lost.patch.replace.state], ['partial', false, 'deleting']);
  assert.match(lost.patch.error, /was started for this day and has not finished\. Xero did not answer\. Press Replace with invoice again\./);
  // One removed, then a refusal: part way, naming both lists and what to do.
  d = apply(d, deletedPatch(d, K_CARD, 'T2'));
  const mid = stoppedPatch(d, { words: `Xero would not remove "${REF[K_CASH]}": This Bank Transaction cannot be edited as it has been reconciled.`, certain: true, advice: 'Unreconcile it in Xero first.' }, 'T3');
  assert.deepEqual([mid.status, mid.nothingChanged, mid.patch.replace.state], ['partial', false, 'deleting']);
  assert.match(mid.message, /Removed from Xero: "ServOS takings 2026-09-27 \(6026f133\)"\. Not removed yet: "ServOS takings 2026-09-27 \(7785f1b2\)", "ServOS refunds 2026-09-27 \(6026f133\)"\. Xero would not remove/);
  assert.equal(mid.patch.error, mid.message);
  assert.match(mid.message, /reconciled\. Unreconcile it in Xero first\. Press Replace with invoice again to finish\.$/, 'press again is said once');
  assert.match(stoppedPatch(d, { words: 'Reconciled in Xero: "y" (2.00). Unreconcile it in Xero first, then press again.', certain: true }, 'T3').message, /Unreconcile it in Xero first\. Press Replace with invoice again to finish\.$/);
  assert.match(progressMessage(apply(d, mid.patch).replace), /Press Replace with invoice again to finish\.$/);
});

test('xeroErrorWords: Xero\'s own sentence out of an API error', () => {
  const body = JSON.stringify({ ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ ValidationErrors: [{ Message: 'This Bank Transaction cannot be edited as it has been reconciled with a Bank Statement.' }] }] });
  assert.equal(xeroErrorWords(`Xero API /BankTransactions/abc failed: 400 ${body}`), 'This Bank Transaction cannot be edited as it has been reconciled with a Bank Statement.');
  assert.equal(xeroErrorWords('Xero API /BankTransactions/abc failed: 400 {"Message":"Nope"}'), 'Nope');
  assert.equal(xeroErrorWords('Xero API /BankTransactions/abc failed: 403 Forbidden'), 'Forbidden');
  assert.equal(xeroErrorWords(''), 'Xero gave no reason.');
});

test('previewView: the old entries with references and totals, and the invoice it will create', () => {
  const old = bankPostings(leedsDetail());
  const plan = { invoice: { number: 'SOS-LEEDS-20260927', total: 109783 }, creditNote: { number: 'SOS-LEEDS-20260927-R', total: 380 } };
  const ok = previewView({ checked: old.map((o) => classifyOld(o, xeroTx(o.key))), verdict: { ok: true }, plan });
  assert.equal(ok.canReplace, true);
  assert.deepEqual(ok.old.map((o) => [o.kind, o.reference, o.total, o.reconciled]), [
    ['Receive money', REF[K_CARD], 986.83, false], ['Receive money', REF[K_CASH], 111, false], ['Spend money', REF[K_REFUND], 3.8, false],
  ]);
  assert.deepEqual(ok.invoice, { number: 'SOS-LEEDS-20260927', total: 1097.83 });
  assert.deepEqual(ok.creditNote, { number: 'SOS-LEEDS-20260927-R', total: 3.8 });
  const checked = old.map((o) => classifyOld(o, xeroTx(o.key, { IsReconciled: o.key === K_CASH })));
  const no = previewView({ checked, verdict: replaceVerdict(checked), plan, problems: ['Choose the tips account.'] });
  assert.equal(no.canReplace, false);
  assert.equal(no.old[1].reconciled, true);
  assert.equal(no.problems.length, 2);
  assert.match(no.problems[0], /^Reconciled in Xero: "ServOS takings 2026-09-27 \(7785f1b2\)" \(111\.00\)/);
});

// ── 5. the whole sequence: a fake Xero and the real SyncRun ──────────────────

// One xero_sync_log table with compare and set on updated_at (as syncRun.test.js).
function fakeTable(seed) {
  const rows = [];
  let clock = Date.parse('2026-10-02T10:00:00Z');
  const stamp = () => new Date(clock++).toISOString().replace('Z', '+00:00');
  const match = (r, f) => Object.entries(f).every(([k, v]) => (k === 'updated_at' ? Date.parse(r[k]) === Date.parse(v) : r[k] === v));
  const view = (r) => ({ id: r.id, status: r.status, xero_id: r.xero_id, detail: structuredClone(r.detail), updated_at: r.updated_at });
  const builder = (op, payload) => {
    const f = {};
    const q = {
      eq(k, v) { f[k] = v; return q; },
      select() { return q; },
      maybeSingle() { return q; },
      then(res, rej) {
        const hit = rows.filter((r) => match(r, f));
        let out;
        if (op === 'select') out = { data: hit.length ? view(hit[0]) : null, error: null };
        else if (op === 'insert') { const row = { id: `row-${rows.length + 1}`, xero_id: null, ...structuredClone(payload), updated_at: stamp() }; rows.push(row); out = { data: [view(row)], error: null }; }
        else { for (const r of hit) Object.assign(r, structuredClone(payload), { updated_at: stamp() }); out = { data: hit.map(view), error: null }; }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  const sb = { rows, from: () => ({ select: () => builder('select'), insert: (p) => builder('insert', p), update: (p) => builder('update', p) }) };
  if (seed) rows.push({ id: 'row-1', location_id: 'leeds', kind: 'daily_sales', ref_date: DATE, ref_id: null, ...structuredClone(seed), updated_at: stamp() });
  return sb;
}
const KEY = { table: 'xero_sync_log', locationId: 'leeds', kind: 'daily_sales', refDate: DATE };

// A fake Xero holding the three bank transactions. `onDelete(id, tx)` may throw to refuse.
function fakeXero(patch = {}, onDelete = null) {
  const txs = new Map([K_CARD, K_CASH, K_REFUND].map((k) => [ID[k], xeroTx(k, patch[k] || {})]));
  const calls = [];
  const api = async (pathname, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${pathname}`);
    const m = /^\/BankTransactions\/([^/?]+)$/.exec(pathname);
    if (!m) throw Object.assign(new Error(`unexpected call ${method} ${pathname}`), { status: 500 });
    const tx = txs.get(decodeURIComponent(m[1]));
    if (!tx) throw Object.assign(new Error(`Xero API ${pathname} failed: 404 `), { status: 404 });
    if (method === 'GET') return { BankTransactions: [structuredClone(tx)] };
    const body = JSON.parse(init.body);
    assert.deepEqual(body, { BankTransactions: [{ BankTransactionID: tx.BankTransactionID, Status: 'DELETED' }] }, 'the only change ever sent is Status DELETED');
    if (onDelete) await onDelete(tx.BankTransactionID, tx);
    if (tx.IsReconciled) throw Object.assign(new Error(`Xero API ${pathname} failed: 400 ${JSON.stringify({ Elements: [{ ValidationErrors: [{ Message: 'This Bank Transaction cannot be edited as it has been reconciled with a Bank Statement.' }] }] })}`), { status: 400 });
    tx.Status = 'DELETED';
    return { BankTransactions: [structuredClone(tx)] };
  };
  return { api, calls, txs, deletes: () => calls.filter((c) => c.startsWith('POST')) };
}
const claim = async (sb, runId) => (await claimSyncRun(sb, KEY, { allowDone: true, runId })).run;
let tick = 0;
const now = () => new Date(Date.parse('2026-10-02T10:00:00Z') + (tick++) * 1000).toISOString();

test('the happy path: three read, three deleted, the record cleared and left waiting for the invoice', async () => {
  const sb = fakeTable(leedsRow());
  const xero = fakeXero();
  const run = await claim(sb, 'A');
  const res = await removeOldDay(run, xero.api, { by: WHO.by, now });
  assert.equal(res.ok, true);
  assert.deepEqual(res.removed.map((r) => [r.reference, r.total]), [[REF[K_CARD], 986.83], [REF[K_CASH], 111], [REF[K_REFUND], 3.8]]);
  assert.deepEqual(xero.calls, [
    `GET /BankTransactions/${ID[K_CARD]}`, `GET /BankTransactions/${ID[K_CASH]}`, `GET /BankTransactions/${ID[K_REFUND]}`,
    `POST /BankTransactions/${ID[K_CARD]}`, `POST /BankTransactions/${ID[K_CASH]}`, `POST /BankTransactions/${ID[K_REFUND]}`,
  ], 'every transaction is read before the first delete');
  assert.ok([...xero.txs.values()].every((t) => t.Status === 'DELETED'));
  const row = await readSyncRow(sb, KEY);
  assert.equal(row.status, 'error', 'never ok while nothing is in Xero');
  assert.equal(row.xero_id, null);
  assert.deepEqual(row.detail.postings, {});
  assert.equal(row.detail.error, INVOICE_PENDING);
  assert.equal(row.detail.replace.state, 'deleted');
  assert.deepEqual(row.detail.replace.by, WHO.by);
  assert.equal(row.detail.replaced[0].lines.length, 3);
  assert.equal(row.detail.lock, undefined, 'the lease is released for the invoice path');
  assert.equal(dayModel(row, 'sales_invoice', '2026-09-27', DATE), 'sales_invoice');
  const last = row.detail.history.at(-1);
  assert.deepEqual([last.action, last.ok, last.removed, last.status], ['replace_day', true, 3, 'error']);
  // The invoice path can claim it like any failed day.
  assert.ok((await claimSyncRun(sb, KEY, { runId: 'INV' })).run);
});

test('reconciled: the whole day is refused before anything is changed; no delete is ever sent', async () => {
  const sb = fakeTable(leedsRow());
  const xero = fakeXero({ [K_CASH]: { IsReconciled: true } });
  const res = await removeOldDay(await claim(sb, 'A'), xero.api, { by: WHO.by, now });
  assert.deepEqual([res.ok, res.code, res.nothingChanged], [false, 'reconciled', true]);
  assert.equal(res.message, 'Reconciled in Xero: "ServOS takings 2026-09-27 (7785f1b2)" (111.00). Unreconcile it in Xero first, then press again. Nothing was changed.');
  assert.deepEqual(xero.deletes(), []);
  const row = await readSyncRow(sb, KEY);
  assert.equal(row.status, 'ok', 'the day is still posted the old way, exactly as it was');
  assert.equal(row.detail.replace, undefined, 'no intent was recorded');
  assert.equal(Object.values(row.detail.postings).filter((p) => p.status === 'posted').length, 3);
  assert.equal(row.detail.lines.length, 3);
  assert.equal(row.detail.lock, undefined);
  assert.deepEqual([row.detail.history.at(-1).action, row.detail.history.at(-1).ok], ['replace_day', false], 'the attempt is kept in the history');
});

test('a refusal part way: the row says which were removed; the retry resumes with the rest', async () => {
  const sb = fakeTable(leedsRow());
  // Reconciled between the read and the delete: Xero refuses the second one.
  const xero = fakeXero({}, (id, tx) => { if (id === ID[K_CASH] && !tx.unlocked) tx.IsReconciled = true; });
  const first = await removeOldDay(await claim(sb, 'A'), xero.api, { by: WHO.by, now });
  assert.deepEqual([first.ok, first.code, first.nothingChanged], [false, 'delete_failed', false]);
  assert.match(first.message, /Removed from Xero: "ServOS takings 2026-09-27 \(6026f133\)"\. Not removed yet: "ServOS takings 2026-09-27 \(7785f1b2\)", "ServOS refunds 2026-09-27 \(6026f133\)"\./);
  assert.match(first.message, /Xero would not remove "ServOS takings 2026-09-27 \(7785f1b2\)": This Bank Transaction cannot be edited as it has been reconciled with a Bank Statement\./);
  assert.match(first.message, /Press Replace with invoice again to finish\.$/);
  assert.deepEqual(xero.deletes().length, 2, 'it stopped at the refusal: the refund was not touched');
  let row = await readSyncRow(sb, KEY);
  assert.equal(row.status, 'partial', 'not ok: part of the day is gone from Xero');
  assert.equal(row.detail.replace.state, 'deleting');
  assert.equal(row.detail.error, first.message);
  assert.deepEqual(row.detail.lines.map((l) => l.key), [K_CASH, K_REFUND], 'only what is still in Xero is linked');
  assert.equal(replaceInFlight(row), true, 'a normal push is refused meanwhile');
  assert.equal(replaceability({ row, postMode: 'sales_invoice', mapping: leedsMapping(), date: DATE }).resume, true);

  // Peter unreconciles it in Xero and presses again: only the two that are left are deleted.
  const cash = xero.txs.get(ID[K_CASH]); cash.IsReconciled = false; cash.unlocked = true;
  xero.calls.length = 0;
  const second = await removeOldDay(await claim(sb, 'B'), xero.api, { by: { id: 'u-other' }, now });
  assert.equal(second.ok, true);
  assert.deepEqual(xero.calls, [
    `GET /BankTransactions/${ID[K_CASH]}`, `GET /BankTransactions/${ID[K_REFUND]}`,
    `POST /BankTransactions/${ID[K_CASH]}`, `POST /BankTransactions/${ID[K_REFUND]}`,
  ], 'the one already removed is neither read nor deleted again');
  row = await readSyncRow(sb, KEY);
  assert.equal(row.status, 'error');
  assert.deepEqual(row.detail.postings, {});
  assert.equal(row.detail.replace.state, 'deleted');
  assert.deepEqual(row.detail.replace.by, WHO.by, 'who started it');
  assert.deepEqual(row.detail.replace.resumedBy, { id: 'u-other' });
  assert.equal(Object.keys(row.detail.replaced[0].postings).length, 3);
  assert.equal(row.detail.replaced[0].lines.length, 3);
});

test('a refusal on the very first delete changes nothing: the row goes back to posted', async () => {
  const sb = fakeTable(leedsRow());
  const xero = fakeXero({}, (id, tx) => { if (id === ID[K_CARD]) tx.IsReconciled = true; });
  const res = await removeOldDay(await claim(sb, 'A'), xero.api, { by: WHO.by, now });
  assert.deepEqual([res.ok, res.nothingChanged], [false, true]);
  assert.equal(res.message, 'Xero would not remove "ServOS takings 2026-09-27 (6026f133)": This Bank Transaction cannot be edited as it has been reconciled with a Bank Statement. Nothing was changed in Xero. Sort that out in Xero first (unreconcile it, or move the lock date). Then press Replace with invoice again.');
  const row = await readSyncRow(sb, KEY);
  assert.equal(row.status, 'ok');
  assert.equal(row.detail.error, null);
  assert.equal(row.detail.replace.state, 'refused');
  assert.equal(replaceInFlight(row), false);
  assert.equal(Object.values(row.detail.postings).filter((p) => p.status === 'posted').length, 3);
  assert.equal(replaceability({ row, postMode: 'sales_invoice', mapping: leedsMapping(), date: DATE, provenInvoice: true }).replaceable, true, 'and can be tried again');
});

test('a delete whose answer was lost: the row does not claim either way, and the retry finds it DELETED', async () => {
  const sb = fakeTable(leedsRow());
  let dropped = false;
  const xero = fakeXero({}, (id, tx) => { if (id === ID[K_CARD] && !dropped) { dropped = true; tx.Status = 'DELETED'; throw new Error('network connection lost'); } });
  const first = await removeOldDay(await claim(sb, 'A'), xero.api, { by: WHO.by, now });
  assert.deepEqual([first.ok, first.nothingChanged], [false, false]);
  assert.match(first.message, /Xero did not answer when asked to remove "ServOS takings 2026-09-27 \(6026f133\)", so ServOS does not know yet whether it was removed\./);
  let row = await readSyncRow(sb, KEY);
  assert.equal(row.status, 'partial', 'not put back to posted: Xero may have removed it');
  assert.equal(row.detail.replace.state, 'deleting');
  xero.calls.length = 0;
  const second = await removeOldDay(await claim(sb, 'B'), xero.api, { by: WHO.by, now });
  assert.equal(second.ok, true);
  assert.deepEqual(xero.deletes(), [`POST /BankTransactions/${ID[K_CASH]}`, `POST /BankTransactions/${ID[K_REFUND]}`], 'the one Xero already deleted is not deleted twice');
  row = await readSyncRow(sb, KEY);
  assert.deepEqual([row.status, row.detail.replace.state], ['error', 'deleted']);
});

test('one already deleted in Xero by hand counts as done', async () => {
  const sb = fakeTable(leedsRow());
  const xero = fakeXero({ [K_REFUND]: { Status: 'DELETED' } });
  const res = await removeOldDay(await claim(sb, 'A'), xero.api, { by: WHO.by, now });
  assert.equal(res.ok, true);
  assert.deepEqual(xero.deletes(), [`POST /BankTransactions/${ID[K_CARD]}`, `POST /BankTransactions/${ID[K_CASH]}`]);
  assert.equal((await readSyncRow(sb, KEY)).detail.replace.state, 'deleted');
});

test('a transaction that is not in this Xero organisation refuses the day', async () => {
  const sb = fakeTable(leedsRow());
  const xero = fakeXero();
  xero.txs.delete(ID[K_CASH]);
  const checked = await readOldTransactions(xero.api, bankPostings(leedsDetail()));
  assert.deepEqual(checked.map((c) => c.state), ['live', 'missing', 'live']);
  const res = await removeOldDay(await claim(sb, 'A'), xero.api, { by: WHO.by, now });
  assert.deepEqual([res.ok, res.code, res.nothingChanged], [false, 'missing', true]);
  assert.deepEqual(xero.deletes(), []);
  assert.equal((await readSyncRow(sb, KEY)).status, 'ok');
});

test('stopRun: a check that fails before the intent changes nothing; after it the row says how far it got', async () => {
  const sb = fakeTable(leedsRow());
  const a = await stopRun(await claim(sb, 'A'), 'error', { words: 'This site is not ready to post its sales invoice.', certain: false });
  assert.deepEqual([a.nothingChanged, a.message], [true, 'This site is not ready to post its sales invoice. Nothing was changed.']);
  assert.equal((await readSyncRow(sb, KEY)).status, 'ok');
  const run = await claim(sb, 'B');
  await run.save({ status: 'partial', detail: intentPatch(run.detail, { ...WHO, status: run.status }) });
  await run.save({ detail: deletedPatch(run.detail, K_CARD, 'T') });
  const b = await stopRun(run, 'error', { words: 'Xero is busy.', certain: false });
  assert.equal(b.nothingChanged, false);
  const row = await readSyncRow(sb, KEY);
  assert.deepEqual([row.status, row.detail.replace.state], ['partial', 'deleting']);
  assert.match(row.detail.error, /Removed from Xero: .* Xero is busy\. Press Replace with invoice again to finish\./);
});

test('numbersTaken: an invoice or credit note already under the day\'s number stops the replace first', async () => {
  const api = async (p) => {
    if (p.startsWith('/Invoices?InvoiceNumbers=SOS-LEEDS-20260927')) return { Invoices: [{ InvoiceNumber: 'SOS-LEEDS-20260927', Type: 'ACCREC', Status: 'VOIDED' }, { InvoiceNumber: 'SOS-LEEDS-20260927', Type: 'ACCPAY', Status: 'PAID' }] };
    if (p.startsWith('/CreditNotes?where=')) { assert.equal(decodeURIComponent(p.split('where=')[1]), 'CreditNoteNumber=="SOS-LEEDS-20260927-R"'); return { CreditNotes: [] }; }
    return { Invoices: [] };
  };
  const taken = await numbersTaken(api, { invoice: 'SOS-LEEDS-20260927', creditNote: 'SOS-LEEDS-20260927-R' });
  assert.deepEqual(taken, [{ type: 'invoice', number: 'SOS-LEEDS-20260927', status: 'VOIDED' }]);
  assert.equal(takenMessage(taken), 'Xero already has an invoice numbered SOS-LEEDS-20260927 (voided). Check it in Xero before replacing this day.');
  assert.deepEqual(await numbersTaken(api, { invoice: 'SOS-LEEDS-20260928', creditNote: null }), []);
  // A supplier bill that happens to share the number is not a sales invoice.
  const bill = async () => ({ Invoices: [{ InvoiceNumber: 'SOS-LEEDS-20260927', Type: 'ACCPAY', Status: 'PAID' }] });
  assert.deepEqual(await numbersTaken(bill, { invoice: 'SOS-LEEDS-20260927' }), []);
});

// ── 7. the 2 Oct review ──────────────────────────────────────────────────────

const refusal400 = (words) => Object.assign(new Error(`Xero API /BankTransactions/x failed: 400 ${JSON.stringify({ Elements: [{ ValidationErrors: [{ Message: words }] }] })}`), { status: 400 });

test('review: a 400 to the first delete for one that is already DELETED counts as done, never "nothing changed"', async () => {
  const sb = fakeTable(leedsRow());
  // Removed by hand in Xero between the read and the delete: Xero answers 400 and holds it as DELETED.
  const xero = fakeXero({}, (id, tx) => { if (id === ID[K_CARD]) { tx.Status = 'DELETED'; throw refusal400('This Bank Transaction cannot be edited as it has been deleted.'); } });
  const res = await removeOldDay(await claim(sb, 'A'), xero.api, { by: WHO.by, now });
  assert.equal(res.ok, true, 'the refusal was read again, Xero shows DELETED, the run carries on');
  assert.deepEqual(xero.calls.slice(3, 5), [`POST /BankTransactions/${ID[K_CARD]}`, `GET /BankTransactions/${ID[K_CARD]}`], 'read again before deciding');
  assert.ok([...xero.txs.values()].every((t) => t.Status === 'DELETED'));
  const row = await readSyncRow(sb, KEY);
  assert.deepEqual([row.status, row.detail.replace.state], ['error', 'deleted']);
  assert.deepEqual(row.detail.postings, {});
});

test('review: a 400 that cannot be read again is not known: the row stays part way, never back to posted', async () => {
  const sb = fakeTable(leedsRow());
  let refused = false;
  const xero = fakeXero({}, (id, tx) => { if (id === ID[K_CARD]) { refused = true; tx.Status = 'DELETED'; throw refusal400('A validation exception occurred'); } });
  const api = async (p, init = {}) => {
    if (refused && !init.method && p.endsWith(ID[K_CARD]) && !xero.readable) throw Object.assign(new Error('Xero API failed: 503 '), { status: 503 });
    return xero.api(p, init);
  };
  const first = await removeOldDay(await claim(sb, 'A'), api, { by: WHO.by, now });
  assert.deepEqual([first.ok, first.nothingChanged], [false, false]);
  assert.match(first.message, /Xero would not remove "ServOS takings 2026-09-27 \(6026f133\)": A validation exception occurred\. ServOS could not then read it from Xero, so it does not know yet whether it was removed\./);
  assert.doesNotMatch(first.message, /Nothing was changed/);
  let row = await readSyncRow(sb, KEY);
  assert.deepEqual([row.status, row.detail.replace.state], ['partial', 'deleting'], 'not ok: Xero may no longer hold it');
  // The next press reads Xero, finds it DELETED and finishes with the other two.
  xero.readable = true; xero.calls.length = 0;
  const second = await removeOldDay(await claim(sb, 'B'), api, { by: WHO.by, now });
  assert.equal(second.ok, true);
  assert.deepEqual(xero.deletes(), [`POST /BankTransactions/${ID[K_CASH]}`, `POST /BankTransactions/${ID[K_REFUND]}`]);
  row = await readSyncRow(sb, KEY);
  assert.deepEqual([row.status, row.detail.replace.state], ['error', 'deleted']);
});

test('review: a real refusal is still certain after the second read, and the row goes back as it was', async () => {
  const sb = fakeTable(leedsRow());
  const xero = fakeXero({}, (id, tx) => { if (id === ID[K_CARD]) tx.IsReconciled = true; });
  const res = await removeOldDay(await claim(sb, 'A'), xero.api, { by: WHO.by, now });
  assert.deepEqual([res.ok, res.nothingChanged], [false, true]);
  assert.deepEqual(xero.calls.slice(3), [`POST /BankTransactions/${ID[K_CARD]}`, `GET /BankTransactions/${ID[K_CARD]}`], 'one delete asked, read again, nothing more sent');
  assert.equal(xero.txs.get(ID[K_CARD]).Status, 'AUTHORISED');
  assert.equal((await readSyncRow(sb, KEY)).status, 'ok');
});

test('review: one already deleted in Xero and another reconciled: refused, but the row no longer says all three are posted', async () => {
  const sb = fakeTable(leedsRow());
  const xero = fakeXero({ [K_REFUND]: { Status: 'DELETED' }, [K_CASH]: { IsReconciled: true } });
  const res = await removeOldDay(await claim(sb, 'A'), xero.api, { by: WHO.by, now });
  assert.deepEqual([res.ok, res.code, res.nothingChanged], [false, 'reconciled', false]);
  assert.deepEqual(xero.deletes(), [], 'ServOS deleted nothing');
  assert.match(res.message, /Removed from Xero: "ServOS refunds 2026-09-27 \(6026f133\)"\. Not removed yet: "ServOS takings 2026-09-27 \(6026f133\)", "ServOS takings 2026-09-27 \(7785f1b2\)"\. Reconciled in Xero: "ServOS takings 2026-09-27 \(7785f1b2\)" \(111\.00\)\. Unreconcile it in Xero first\. Press Replace with invoice again to finish\.$/);
  const row = await readSyncRow(sb, KEY);
  assert.equal(row.status, 'partial', 'not ok: the refund is gone from Xero');
  assert.equal(row.detail.replace.state, 'deleting');
  assert.equal(row.detail.replace.was.status, 'ok', 'the row as it was before this attempt');
  assert.equal(row.detail.postings[K_REFUND].status, 'deleted');
  assert.deepEqual(row.detail.lines.map((l) => l.key), [K_CARD, K_CASH]);
  assert.equal(row.detail.lock, undefined);
  // Unreconciled in Xero, pressed again: the two that are left go, the record is cleared.
  xero.txs.get(ID[K_CASH]).IsReconciled = false;
  const second = await removeOldDay(await claim(sb, 'B'), xero.api, { by: WHO.by, now });
  assert.equal(second.ok, true);
  assert.deepEqual(xero.deletes(), [`POST /BankTransactions/${ID[K_CARD]}`, `POST /BankTransactions/${ID[K_CASH]}`]);
});

test('review: a run that lost its lease part way never says "Nothing was changed"', async () => {
  const sb = fakeTable(leedsRow());
  // Another run takes the row over while the second delete is with Xero.
  const xero = fakeXero({}, (id) => { if (id === ID[K_CASH]) sb.rows[0].updated_at = '2026-10-02T12:00:00.000+00:00'; });
  const run = await claim(sb, 'A');
  await assert.rejects(() => removeOldDay(run, xero.api, { by: WHO.by, now }), /Another run took over this posting/);
  assert.equal(run.lost, true);
  assert.deepEqual([...xero.txs.values()].map((t) => t.Status), ['DELETED', 'DELETED', 'AUTHORISED']);
  const said = interrupted(run.detail.replace, 'Another run took over this posting. Nothing more was sent; try again in a few minutes.');
  assert.equal(said.partial, true);
  assert.match(said.message, /^This day is part way through being replaced with a daily sales invoice\. Removed from Xero: "ServOS takings 2026-09-27 \(6026f133\)"\./);
  assert.match(said.message, /Another run took over this posting\. Nothing more was sent; try again in a few minutes\. Press Replace with invoice again to finish\.$/);
  assert.doesNotMatch(said.message, /Nothing was changed/);
  // Before the intent is recorded nothing was changed, and it says so.
  assert.deepEqual(interrupted(undefined, 'This site is not ready to post its sales invoice.'), { partial: false, message: 'This site is not ready to post its sales invoice. Nothing was changed.' });
  assert.equal(interrupted({ state: 'refused' }, 'x.').partial, false);
  // Intent recorded, nothing removed yet: still part way (the retry reads Xero).
  const started = interrupted(intentPatch(leedsDetail(), WHO).replace, 'Xero is busy.');
  assert.deepEqual([started.partial, started.message], [true, 'A replace with a daily sales invoice was started for this day and has not finished. Xero is busy. Press Replace with invoice again.']);
  // The words xero-sales answers with come from this, not a fixed sentence.
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../supabase/functions/xero-sales/index.ts'), 'utf8');
  assert.match(src, /interrupted\(run\.detail\?\.replace, words\)/);
  assert.doesNotMatch(src, /let error = `\$\{words\} Nothing was changed\.`/);
});

test('review: the Posting tab takes "Already pushed" down once old entries were removed', () => {
  const site = { postMode: 'sales_invoice', startDate: '2026-09-27' };
  const already = { ok: true, already: true, model: 'bank_tx', date: DATE, lines: leedsDetail().lines, replace: replaceAnswer(can()) };
  // Refused with nothing changed (reconciled, not ready): the answer on screen is still true.
  assert.equal(answerAfterFailure(already, { message: 'Reconciled in Xero', replace: { ...replaceAnswer(can()), resume: false } }), null);
  assert.equal(answerAfterFailure(already, { message: 'This site is not ready', notReady: [{ message: 'x' }] }), null);
  assert.equal(answerAfterFailure(already, new Error('network')), null);
  // All three removed, then the invoice was not sent: no "Already pushed", no old lines, the panel stays.
  const pending = answerAfterFailure(already, { message: `${OLD_REMOVED} The sales invoice has not been sent yet: Xero 500.`, invoicePending: true, model: 'sales_invoice' });
  assert.deepEqual([pending.model, pending.date, pending.already, pending.lines], ['bank_tx', DATE, undefined, undefined]);
  assert.deepEqual([pending.replace.replaceable, pending.replace.resume, pending.replace.pending], [true, true, true]);
  assert.deepEqual(offerForAnswer(pending, site), { show: 'button', text: REPLACE_PENDING, resume: true });
  assert.equal(REPLACE_PENDING, 'The old bank transactions were removed from Xero. The sales invoice is not in Xero yet.');
  // One of three removed, then Xero refused: part way, offered to finish.
  const part = answerAfterFailure(already, { message: 'part way', replace: { ...replaceAnswer(can()), resume: true } });
  assert.deepEqual([part.replace.replaceable, part.replace.resume, part.replace.pending], [true, true, false]);
  assert.deepEqual(offerForAnswer(part, site), { show: 'button', text: REPLACE_RESUME, resume: true });
  // The screen is wired to it, and only a real attempt (never the preview) reports a failure.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const page = fs.readFileSync(path.join(root, 'src/backoffice/sections/XeroIntegration.jsx'), 'utf8');
  assert.match(page, /answerAfterFailure\(oldDay, e\)/);
  assert.match(page, /onFail=\{replaceFailed\}/);
  const panel = fs.readFileSync(path.join(root, 'src/backoffice/sections/xero/ReplaceDay.jsx'), 'utf8');
  assert.equal((panel.match(/onFail\?\.\(e\)/g) || []).length, 2, 'confirm and Push again');
  assert.doesNotMatch(panel.slice(panel.indexOf('const loadPreview'), panel.indexOf('const confirm')), /onFail/);
});

test('review: a site that has never posted a sales invoice cannot start a replace; one part way can always finish', () => {
  // Leeds on 2 Oct: every check passes, but no day is in Xero as a sales invoice yet.
  const never = can({ provenInvoice: false });
  assert.deepEqual([never.replaceable, never.reason, never.message], [false, 'no_invoice_yet', NO_INVOICE_YET]);
  assert.equal(NO_INVOICE_YET, 'This site has not posted a sales invoice to Xero yet. Post one day as a sales invoice first (a day that is not in Xero yet), then replace this one.');
  assert.equal(replaceability({ row: leedsRow(), postMode: 'sales_invoice', mapping: leedsMapping(), date: DATE }).reason, 'no_invoice_yet', 'not said is not proven');
  assert.equal(can({ provenInvoice: 'yes' }).reason, 'no_invoice_yet');
  // The other reasons come first: they are what to put right first.
  assert.equal(can({ provenInvoice: false, date: '2026-09-26' }).reason, 'before_start');
  // The screen says it plainly, with no button.
  const offer = offerForAnswer({ already: true, model: 'bank_tx', date: DATE, replace: replaceAnswer(never) }, { postMode: 'sales_invoice', startDate: '2026-09-27' });
  assert.deepEqual([offer.show, offer.text], ['note', `${OLD_WAY} ${NO_INVOICE_YET}`]);
  // A replace that already stopped part way is never locked out by this.
  const row = leedsRow(); row.status = 'partial';
  row.detail = { ...row.detail, ...intentPatch(row.detail, WHO) };
  row.detail = { ...row.detail, ...deletedPatch(row.detail, K_CARD, 'T') };
  const part = replaceability({ row, postMode: 'sales_invoice', mapping: leedsMapping(), date: DATE, provenInvoice: false });
  assert.deepEqual([part.replaceable, part.resume], [true, true]);
  // xero-sales asks the log before any replace, in the already answer, the preview and the run.
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../supabase/functions/xero-sales/index.ts'), 'utf8');
  assert.match(src, /\.eq\('status', 'ok'\)\.eq\('detail->>model', 'sales_invoice'\)/);
  assert.equal((src.match(/await canReplace\(/g) || []).length, 4);
  assert.equal((src.match(/replaceability\(/g) || []).length, 2, 'only inside canReplace');
});

// ── 6. deploys ───────────────────────────────────────────────────────────────

test('xero-sales ships the replace files; the pure one imports nothing from outside', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const io = {
    read: (p) => fs.readFileSync(path.join(root, p), 'utf8'),
    exists: (p) => { try { return fs.statSync(path.join(root, p)).isFile(); } catch { return false; } },
    list: (d) => { try { return fs.readdirSync(path.join(root, d)); } catch { return []; } },
  };
  const sales = sharedDepsOf('xero-sales', io);
  for (const f of ['xeroReplacePlan.js', 'xeroReplaceRun.ts']) assert.ok(sales.includes(`supabase/functions/_shared/${f}`), `xero-sales ships ${f}`);
  // xero-config does not use them, so only xero-sales needs deploying for this.
  for (const f of ['xeroReplacePlan.js', 'xeroReplaceRun.ts']) assert.ok(!sharedDepsOf('xero-config', io).includes(`supabase/functions/_shared/${f}`));
  assert.doesNotMatch(io.read('supabase/functions/_shared/xeroReplacePlan.js'), /from\s+['"](?!\.\/)/);
  const src = io.read('supabase/functions/xero-sales/index.ts');
  // Only a signed in person replaces a day: never the nightly run or the service key.
  assert.match(src, /replacing && \(auto \|\| !acc\.user\)/);
  assert.equal(OLD_REMOVED, 'The old bank transactions were removed from Xero.');
});
