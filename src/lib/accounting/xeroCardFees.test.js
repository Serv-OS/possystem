/**
 * xeroCardFees.test.js: the "Card fees" line on the day's Xero sales invoice (13 Oct 2026).
 * Run: `npm test`, or `node --test src/lib/accounting/xeroCardFees.test.js`.
 *
 * The owner: "We should create a new account in Xero called card fees". The venue's accountant
 * used to get, from the last till, a minus line for the card fees on each day's invoice, so the
 * card money on the invoice was what the card processor paid out. A site switches this on
 * itself (mapping.cardFees). Every figure here is made up.
 *
 * Pinned:
 *   1 to 5    OFF changes nothing, byte for byte (the golden file was made from the refund lines
 *             planner BEFORE the card fees change touched it), adds no key anywhere, and no live
 *             site loses its figures tick. Switching on asks for Check figures again.
 *   6 to 16   The line and the money: one last line, No VAT, on the fee account; the card
 *             payment is takings less refunds less fees; total, lines and payments tie to the
 *             penny. Fee given back on a refund is the Back Office Payouts figure. Nothing is
 *             ever negative; a day that cannot carry the line posts without it and says why.
 *   17 to 20  Which fees: the same card sales the invoice counts, matched by PSP reference, read
 *             200 at a time, fenced to the venue. Adyen's own cost is never read.
 *   21 to 23  The wait: only for a fee that can still arrive, for 16 hours after the day ended,
 *             then the day posts with what is known and a warning.
 *   24 to 32  A day is never mixed: the marker AND the figures are on its log row. Half posted
 *             days, lost answers, days already posted, the history, replace day, and Xero
 *             refusing the invoice.
 *   33 to 38  The screens, the US shape, awkward pennies on 200 days, the account button, the
 *             words (no dashes), and the wiring of xero-sales and xero-config.
 *
 * To make the golden again (only if the refund lines planner itself changes): check out that
 * planner with no card fees code in it, then write cardFeesOffGolden(planner) from
 * xeroInvoiceFixtures.js to xeroCardFeesOff.golden.json, one entry per line. Made at any other
 * commit, test 1 proves nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as planner from '../../../supabase/functions/_shared/xeroInvoicePlan.js';
import {
  pspOf, cardFeeItems, sumCardFees, CARD_FEE_WAIT_MS, cardFeesWait, loadCardFees, cardFeesFor, CARD_FEE_COLS,
} from '../../../supabase/functions/_shared/xeroCardFees.ts';
import { postInvoiceDay, NotReadyError } from '../../../supabase/functions/_shared/xeroInvoicePost.ts';
import { claimSyncRun, readSyncRow } from '../../../supabase/functions/_shared/syncRun.ts';
import { RECOMMENDED, recommendedKeys, createRecommendedAccounts, canTakeCardFees, cardFeesAccountRefusal } from '../../../supabase/functions/_shared/xeroSiteAccounts.ts';
import { allDeletedPatch, previewView, xeroErrorWords } from '../../../supabase/functions/_shared/xeroReplacePlan.js';
import { venuePayoutLine as payoutLineEdge } from '../../../supabase/functions/_shared/venueFees.ts';
import { venuePayoutLine, venueFeeFor } from '../payments/venueFees.js';
import {
  previewWords, historyFeeNote, historyRefundNote, mergePatch, setCardFeesOn, setCardFeesAccount, expenseAccounts, STATUS_LABEL, STATUS_COLOUR,
} from '../../backoffice/sections/xero/xeroUi.js';
import { buildGroupedDay, makeGroupResolver } from '../../../supabase/functions/_shared/accountingGroups.js';
import { businessDayWindow } from '../../../supabase/functions/_shared/businessDay.js';
import {
  UK, DAY, DATE, UK_TAX, CATEGORIES, saleRows, mapping, DETAIL, SITE, at, atMs, breakdown, rng, generatedCheck,
  cardLeg, refundEntry, refundOf, usDay, cardFeesOffGolden, STARTED_WAYS, psp, tillRef, paymentRow,
} from './xeroInvoiceFixtures.js';

const {
  planXeroInvoiceDay, planView, planSteps, stepIdempotencyKey, retryConflicts, mappingHash, validateInvoiceMapping, invoiceReadiness, seenFromGrouped,
  refundWayStarted, refundWayToRecord, invoiceRefusal, refusalPatch, refusalWords, postedDayChanges, historyDocs, clearingFor,
  withCardFees, cardFeeWayStarted, cardFeesToRecord, cardFeesPatch, cardFeesChangedWords, cardFeesForCompare, cardFeesView, cardFeesMissingWords, cardFeesNotPostedWords,
} = planner;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);   // an en dash or an em dash
const H = 3600000;
const AT = '2026-10-14T03:10:00.000Z';
const sumBy = (list, f) => list.reduce((s, x) => s + f(x), 0);
const cents = (n) => Math.round(n * 100);
const row = (l) => [l.description, l.account, l.taxType, l.amount, l.tax];
const pays = (p) => p.payments.map((x) => [x.key, x.amount]);
const steps = (p) => planSteps(p).map((s) => s.key);
const warned = (p, code) => p.warnings.filter((w) => w.code === code);
const without = (p) => { const { cardFees: _gone, ...rest } = p; return rest; };

// ── the made up days ─────────────────────────────────────────────────────────

const ON = { enabled: true, account: 'SOSFEES' };
const mOn = (extra = {}) => mapping({ cardFees: ON, ...extra });
const groupedOf = (sales, refunds = [], m = mapping(), day = DAY) =>
  buildGroupedDay({ day, saleRows: sales, refundRows: refunds, venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(m, CATEGORIES) });

/** Every card tender of the rows gets the till's key for a reader payment, holding a made up PSP reference. */
function referenced(rows, from = 0) {
  let n = from;
  const refs = [];
  const out = rows.map((r) => ({ ...r, tenders: (r.tenders || []).map((t) => {
    if (t.method !== 'card') return t;
    n += 1;
    refs.push({ check: r.id, n, minor: Math.round((t.amount + (t.tip || 0)) * 100) });
    return { ...t, psp_ref: tillRef(n) };
  }) }));
  return { rows: out, refs };
}
const payMap = (refs, feeOf) => new Map(refs.map((r) => [psp(r.n), paymentRow(r.n, r.minor, feeOf(r))]));

// The fixture day: five checks, 28.01 of sales, 23.10 of it by card on four payments (A 8.30
// with its tip, C 4.00, D 2.80, E 8.00) and 4.91 in cash. Made up fees: 0.43 in all.
const REF = referenced(saleRows());
const [A, B, C, D, E] = REF.rows;
const FEE = { A: 13, C: 9, D: 8, E: 13 };
const PAYMENTS = payMap(REF.refs, (r) => FEE[r.check]);
const cardRef = (check) => check.tenders.find((t) => t.method === 'card').psp_ref;
const legOf = (check, minor, extra = {}) => cardLeg(minor, { id: cardRef(check), ref: `REFUND-${check.id}`, ...extra });
const LATTE = { cat: 'cat-hot_1e945c26', itemId: 'm-latte', price: 3.8, qty: 1, refundQty: 1, taxRateId: 'r20' };
const AMERICANO = { cat: 'cat-hot_1e945c26', itemId: 'm-americano', price: 2.0, qty: 1, refundQty: 1, taxRateId: 'r20' };
const BEFORE = new Date(DAY.fromMs - 5 * H).toISOString();
/** A check closed the day before, paid by card on payment `n`, with its own fee. */
const earlier = (check, id, n, minor) => ({ ...check, id, closed_at: BEFORE, tenders: [{ method: 'card', amount: minor / 100, tip: 0, processor: 'adyen', psp_ref: tillRef(n) }] });
const withPay = (base, ...rows) => new Map([...base, ...rows.map((r) => [r.psp_reference, r])]);

/** A day as xero-sales has it after loadInvoiceDay, with its fee items and fees worked out. */
function dayOf(sales, refunds = [], { m = mOn(), payments = PAYMENTS, day = DAY } = {}) {
  const loaded = { grouped: groupedOf(sales, refunds, m, day), rows: { sale: sales, refund: refunds }, day };
  const items = cardFeeItems({ day, saleRows: sales, refundRows: refunds, clearing: m.clearing });
  const fees = { ...sumCardFees(items, payments), account: m.cardFees?.account };
  return { loaded, g: loaded.grouped, items, fees, m, payments };
}
const plan = (g, cardFees, extra = {}, m = mOn()) => planXeroInvoiceDay(g, { mapping: m, detail: DETAIL, site: SITE, date: DATE, currency: 'GBP', cardFees, ...extra });

/** No refunds. */
const plainDay = (o) => dayOf(REF.rows, [], o);
/** The 3.80 latte of check A refunded to its card the same day. */
const latteRefund = () => refundOf(A, { id: 'ref1', amount: 3.8, taxAmount: 0.63, legs: [legOf(A, 380)], items: [LATTE] });
const refundDay = (o) => dayOf(REF.rows, latteRefund(), o);

// ── a made up Platform database, a made up xero_sync_log and a made up Xero ──

/** The two reads xeroCardFees.ts makes: the venue's Platform location, and its card payments by reference. */
function fakePlatform({ payments = PAYMENTS, location = { id: 'platform-leeds', name: 'Coffee Boy Leeds', online_slug: 'coffee-boy-leeds', company_id: 'co-1' }, byOps = true, fail = null } = {}) {
  const calls = [];
  const rows = payments instanceof Map ? [...payments.values()] : payments;
  return {
    calls,
    reads: () => calls.filter((c) => c.table === 'adyen_payments'),
    from(table) {
      const q = { table, cols: null, eq: [], in: null };
      const api = {
        select(cols) { q.cols = cols; return api; },
        eq(k, v) { q.eq.push([k, v]); return api; },
        in(k, v) { q.in = [k, v]; return api; },
        maybeSingle() {
          calls.push({ ...q });
          const hit = table === 'locations' && location && (q.eq[0][0] === 'ops_location_id') === byOps ? location : null;
          return Promise.resolve({ data: hit, error: fail && table === 'locations' ? { message: fail } : null });
        },
        then(res, rej) {
          calls.push({ ...q });
          const data = rows.filter((r) => q.eq.every(([k, v]) => r[k] === v) && (!q.in || q.in[1].includes(r[q.in[0]])));
          return Promise.resolve(fail ? { data: null, error: { message: fail } } : { data, error: null }).then(res, rej);
        },
      };
      return api;
    },
  };
}

// xero_sync_log in memory: the calls SyncRun makes (as xeroRefundLines.test.js has it).
function fakeTable(seed) {
  const rows = [];
  let clock = Date.parse('2026-10-14T03:00:00Z');
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
        else if (op === 'insert') { const made = { id: `row-${rows.length + 1}`, xero_id: null, ...structuredClone(payload), updated_at: stamp() }; rows.push(made); out = { data: [view(made)], error: null }; }
        else { for (const r of hit) Object.assign(r, structuredClone(payload), { updated_at: stamp() }); out = { data: hit.map(view), error: null }; }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  const sb = { rows, from: () => ({ select: () => builder('select'), insert: (p) => builder('insert', p), update: (p) => builder('update', p) }) };
  if (seed) rows.push({ id: 'row-1', location_id: 'leeds', kind: 'daily_sales', ref_date: DATE, ref_id: null, xero_id: null, ...structuredClone(seed), updated_at: stamp() });
  return sb;
}
const KEY = { table: 'xero_sync_log', locationId: 'leeds', kind: 'daily_sales', refDate: DATE };
const CONTACT = DETAIL.site.contactId;
const CTX = { token: 't', tenantId: 'T', locationId: 'leeds', date: DATE, contactId: CONTACT, shortCode: null };

// A made up Xero behind fetch, with the rules Xero keeps: a number is used once, an invoice is
// never below zero, a payment is above zero and no more than what is still due.
async function withXero(fn, { refuse = () => null, lose = () => false } = {}) {
  const real = globalThis.fetch;
  const x = { invoices: [], creditNotes: [], payments: [], calls: [], puts: () => x.calls.filter((c) => c.startsWith('PUT')) };
  let n = 0;
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const invalid = (message) => answer(400, { ErrorNumber: 10, Type: 'ValidationException', Elements: [{ ValidationErrors: [{ Message: message }] }] });
  const total = (p) => Math.round(sumBy(p.LineItems, (l) => l.UnitAmount) * 100) / 100;
  const due = (doc, id) => Math.round((doc.Total - sumBy(x.payments.filter((p) => (p.Invoice?.InvoiceID || p.CreditNote?.CreditNoteID) === id), (p) => p.Amount)) * 100) / 100;
  const handle = (method, where, body) => {
    if (method === 'PUT' && where === '/Invoices') {
      const p = body.Invoices[0];
      if (x.invoices.some((i) => i.InvoiceNumber === p.InvoiceNumber)) return invalid('Invoice # must be unique.');
      if (total(p) < 0) return invalid('Invoice total must not be negative.');
      const inv = { InvoiceID: `inv-${++n}`, InvoiceNumber: p.InvoiceNumber, Type: 'ACCREC', Status: 'AUTHORISED', Total: total(p), Contact: { ContactID: p.Contact.ContactID }, sent: p };
      x.invoices.push(inv);
      return answer(200, { Invoices: [inv] });
    }
    if (method === 'GET' && where.startsWith('/Invoices?InvoiceNumbers=')) {
      const number = decodeURIComponent(where.split('=')[1]);
      return answer(200, { Invoices: x.invoices.filter((i) => i.InvoiceNumber === number) });
    }
    if (method === 'PUT' && where === '/CreditNotes') {
      const p = body.CreditNotes[0];
      if (x.creditNotes.some((c) => c.CreditNoteNumber === p.CreditNoteNumber)) return invalid('Credit Note # must be unique.');
      const cn = { CreditNoteID: `cn-${++n}`, CreditNoteNumber: p.CreditNoteNumber, Type: 'ACCRECCREDIT', Status: 'AUTHORISED', Total: total(p), Contact: { ContactID: p.Contact.ContactID }, sent: p };
      x.creditNotes.push(cn);
      return answer(200, { CreditNotes: [cn] });
    }
    if (method === 'GET' && where.startsWith('/CreditNotes?where=')) {
      const number = /CreditNoteNumber=="([^"]+)"/.exec(decodeURIComponent(where))[1];
      return answer(200, { CreditNotes: x.creditNotes.filter((c) => c.CreditNoteNumber === number) });
    }
    if (method === 'PUT' && where === '/Payments') {
      const p = body.Payments[0];
      const doc = p.Invoice ? x.invoices.find((i) => i.InvoiceID === p.Invoice.InvoiceID) : x.creditNotes.find((c) => c.CreditNoteID === p.CreditNote?.CreditNoteID);
      if (!doc) return invalid('The document for this payment could not be found.');
      if (!(p.Amount > 0)) return invalid('Payment amount must be greater than 0.');
      if (p.Amount > due(doc, doc.InvoiceID || doc.CreditNoteID) + 0.001) return invalid('Payment amount exceeds the amount outstanding.');
      const pay = { PaymentID: `pay-${++n}`, Status: 'AUTHORISED', Amount: p.Amount, Reference: p.Reference, Invoice: p.Invoice, CreditNote: p.CreditNote, Account: p.Account };
      x.payments.push(pay);
      return answer(200, { Payments: [pay] });
    }
    if (method === 'GET' && where.startsWith('/Payments?where=')) {
      const reference = /Reference=="([^"]+)"/.exec(decodeURIComponent(where))[1];
      return answer(200, { Payments: x.payments.filter((p) => p.Reference === reference) });
    }
    return answer(500, { Message: `unexpected ${method} ${where}` });
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const where = u.pathname.replace('/api.xro/2.0', '') + u.search;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    x.calls.push(`${method} ${where.split('?')[0]}`);
    const refused = refuse(method, where, body);
    if (refused) return refused;
    const res = handle(method, where, body);
    if (lose(method, where)) throw new Error('network connection lost');
    return res;
  };
  try { return await fn(x); } finally { globalThis.fetch = real; }
}
const xero400 = (message) => new Response(JSON.stringify({ ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ InvoiceNumber: 'SOS-LEEDS-20260929', ValidationErrors: [{ Message: message }] }] }), { status: 400 });
const posted = (r) => Object.entries(r.detail.postings).map(([k, p]) => [k, p.status, p.total]);

// One attempt, as xero-sales makes it (the same calls in the same order; test 38 pins them
// there): claim the row, read the refund way and the card fees from the row this run HOLDS,
// wait if a fee can still arrive, plan, record both ways in one save, then post.
async function attempt(sb, w, runId, { m = w.m, platform = fakePlatform({ payments: w.payments }), nowMs = DAY.toMs + 20 * H } = {}) {
  const { run, done } = await claimSyncRun(sb, KEY, { runId });
  if (done) return { already: true, row: done };
  const started = refundWayStarted(run.detail);
  const refusedBefore = run.postings.INVOICE?.refusedNotLines || null;
  let p = null, cf = null;
  try {
    cf = await cardFeesFor(platform, { detailRow: run.detail, mapping: m, locationId: 'leeds', loaded: w.loaded, venue: UK, site: { platformId: 'platform-leeds' }, nowMs, noWait: !!run.detail?.replace });
    const grouped = withCardFees(w.loaded.grouped, cf.cardFees);
    if (cf.wait) throw new NotReadyError([{ code: cf.wait.code, message: cf.wait.message }]);
    p = planXeroInvoiceDay(grouped, { mapping: m, detail: DETAIL, site: SITE, date: DATE, currency: 'GBP', started });
    await run.save({ detail: { model: 'sales_invoice', warnings: p.warnings, notReady: null, refundWay: refundWayToRecord(started, p), ...cardFeesPatch(cf.started, run.detail.cardFees, cf.cardFees, p, AT) } });
    const res = await postInvoiceDay(run, p, CTX);
    await run.finish('ok', { detail: { documents: res.documents, error: null, notReady: null } }, { ok: true, posted: res.posted, skipped: res.skipped });
    return { ok: true, res, plan: p, started, cf, platform };
  } catch (e) {
    const notReady = e instanceof NotReadyError ? e.notReady : null;
    const done2 = Object.values(run.postings).filter((x) => x?.status === 'posted').length;
    const xeroWords = xeroErrorWords(e.message);
    const refusal = invoiceRefusal(p, { started, postings: run.postings, before: refusedBefore, error: { status: e?.status, message: e.message, words: xeroWords } });
    const feesWait = notReady?.[0]?.code === 'card_fees_wait';
    const error = refusal ? refusalWords(refusal, xeroWords) : feesWait ? e.message : notReady ? `This site is not ready to post its sales invoice, so nothing was sent. ${e.message}` : e.message;
    const refused = refusalPatch(refusal, run.postings, { at: AT, message: e.message, words: xeroWords });
    await run.finish(done2 ? 'partial' : 'error', { detail: { error, notReady, ...refused } }, { ok: false, posted: done2 });
    return { ok: false, e, plan: p, started, refusal, error, cf, platform, notReady };
  }
}
// The row as the Postings history gets it (xero-config history_detail).
const asHistory = (r) => ({ refundWay: r.detail.refundWay || null, postings: r.detail.postings, ...(r.detail.cardFees ? { cardFees: cardFeesView(r.detail.cardFees) } : {}) });

// ── 1 to 5: off changes nothing ──────────────────────────────────────────────

test('1. card fees OFF is byte for byte the refund lines planner: plans, views, steps and Idempotency-Keys', () => {
  const golden = JSON.parse(read('src/lib/accounting/xeroCardFeesOff.golden.json'));
  const keys = Object.keys(golden);
  assert.equal(keys.length, 11 * STARTED_WAYS.length, 'eleven days, each started every way');
  const variants = {
    'no cardFees key': {},
    'cardFees {}': { mappingExtra: { cardFees: {} } },
    'enabled false': { mappingExtra: { cardFees: { enabled: false } } },
    'enabled false with an account remembered': { mappingExtra: { cardFees: { enabled: false, account: 'SOSFEES' } } },
    // A site that HAS switched card fees on, planning a day that started without them (cardFees null).
    'enabled, the day planned with cardFees null': { mappingExtra: { cardFees: ON }, options: { cardFees: null } },
    // The same, the way xero-sales does it: nothing on the grouped day (withCardFees(grouped, null) is the day itself).
    'enabled, nothing on the grouped day': { mappingExtra: { cardFees: ON } },
  };
  for (const [name, v] of Object.entries(variants)) {
    const now = cardFeesOffGolden(planner, v);
    assert.deepEqual(Object.keys(now), keys, name);
    for (const k of keys) {
      // A mapping that carries cardFees differs from the golden's in nothing the plan holds.
      assert.equal(JSON.stringify(now[k]), JSON.stringify(golden[k]), `${name}: ${k}`);
    }
  }
  // The golden holds every refund way and every step kind, so "nothing moved" covers them all.
  const all = Object.values(golden);
  assert.deepEqual([...new Set(all.map((e) => e.plan.refundWay))].sort(), ['credit_note', 'lines', null].sort());
  assert.deepEqual([...new Set(all.flatMap((e) => e.steps.map((s) => s[0].split(':')[0])))].sort(), ['CREDIT', 'INVOICE', 'PAY', 'REFUND']);
  assert.ok(all.some((e) => e.plan.invoice?.lineAmountTypes === 'Exclusive'), 'a US day is in it');
  const g = plainDay().g;
  assert.equal(withCardFees(g, null), g, 'no fees: the grouped day itself, not a copy');
  assert.equal(withCardFees(g, undefined), g);
});

test('2. off adds no key: not to the plan, its view, its totals or the row that is saved', async () => {
  const w = refundDay({ m: mapping() });
  for (const m of [mapping(), mapping({ cardFees: { enabled: false, account: 'SOSFEES' } })]) {
    const p = plan(w.g, null, {}, m);
    assert.ok(!('cardFees' in p) && !('fees' in p.totals));
    const v = planView(p);
    assert.ok(!('cardFees' in v) && !('fees' in v.totals));
    assert.ok(p.invoice.lines.every((l) => l.kind !== 'fee'));
    assert.equal(cardFeesToRecord(null, undefined, null, p, AT), null);
    assert.deepEqual(cardFeesPatch(null, undefined, null, p, AT), {});
    assert.deepEqual(cardFeesPatch('off', undefined, null, p, AT), {});
  }
  // The real attempt at a site with card fees off: no read of the Platform database, and the
  // row it saves has no cardFees key at any point.
  await withXero(async (x) => {
    const sb = fakeTable();
    const res = await attempt(sb, w, 'O1');
    assert.equal(res.ok, true, res.e?.message);
    assert.deepEqual(res.cf, { cardFees: null, wait: null, started: null });
    assert.deepEqual(res.platform.calls, [], 'nothing is read for a site with card fees off');
    const r = await readSyncRow(sb, KEY);
    assert.ok(!('cardFees' in r.detail));
    assert.deepEqual(x.invoices.map((i) => i.Total), [24.21]);
    assert.deepEqual(x.payments.map((p) => p.Amount), [19.3, 4.91]);
    assert.equal(historyFeeNote(asHistory(r)), '');
  });
});

test('3. the figures tick: no live site loses it, and switching card fees on asks for Check figures again', () => {
  const m = mapping();
  assert.equal(mappingHash(m), 'f637af9c', 'the hash of the fixture choices is what it was on 12 Oct 2026');
  for (const cardFees of [undefined, null, {}, { enabled: false }, { enabled: false, account: 'SOSFEES' }, { account: 'SOSFEES' }]) {
    assert.equal(mappingHash({ ...m, cardFees }), 'f637af9c', JSON.stringify(cardFees));
  }
  const on = mappingHash({ ...m, cardFees: ON });
  assert.notEqual(on, 'f637af9c', 'switching on changes the figures, so it changes the hash');
  assert.notEqual(mappingHash({ ...m, cardFees: { enabled: true, account: 'FEES2' } }), on, 'another account changes it again');
  assert.equal(mappingHash({ ...m, cardFees: { enabled: true, account: ' SOSFEES ' } }), on);
  assert.equal(mappingHash({ ...m, cardFees: { account: 'SOSFEES', enabled: true } }), on, 'key order does not matter');
  // A site ticked before the switch: Ready before, not Ready after, and told to check a day again.
  const seen = seenFromGrouped(plainDay().g);
  const ticked = { ...m, figuresChecked: { hash: mappingHash(m) }, invoiceStartDate: '2026-09-01' };
  const before = invoiceReadiness(ticked, { seen });
  assert.equal(before.ready, true);
  const after = invoiceReadiness({ ...ticked, cardFees: ON }, { seen });
  assert.equal(after.ready, false);
  assert.deepEqual(after.items.filter((i) => !i.ok).map((i) => [i.key, i.detail]), [['figures', 'The choices changed after the figures were checked. Check a day again under VAT and accounts, Check figures.']]);
  // Ticked again with card fees on: Ready.
  const reticked = { ...ticked, cardFees: ON, figuresChecked: { hash: on } };
  assert.equal(invoiceReadiness(reticked, { seen }).ready, true);
  // Off again: the tick made while it was on has lapsed (the invoice loses the line), on purpose.
  assert.equal(invoiceReadiness({ ...reticked, cardFees: { enabled: false, account: 'SOSFEES' } }, { seen }).ready, false);
  // The checklist of a site with card fees off is the one it had.
  for (const cardFees of [{}, { enabled: false }, { enabled: false, account: 'SOSFEES' }]) {
    assert.deepEqual(invoiceReadiness({ ...ticked, cardFees }, { seen }), before);
  }
  assert.deepEqual(before.items.map((i) => i.key), ['site', 'tracking', 'groups', 'discounts', 'tips', 'clearing', 'figures', 'start']);
});

test('4. the choice as it is saved: { enabled, account } and nothing else', () => {
  const ok = (cardFees) => assert.equal(validateInvoiceMapping(mapping({ cardFees })), null, JSON.stringify(cardFees));
  const bad = (cardFees, words) => assert.equal(validateInvoiceMapping(mapping({ cardFees })), words, JSON.stringify(cardFees));
  ok(undefined); ok(null); ok({}); ok({ enabled: false }); ok({ enabled: false, account: 'SOSFEES' }); ok(ON); ok({ enabled: true, account: '429' });
  ok({ enabled: true, account: 'a1b2c3d4-0000-4000-8000-000000000000' });
  bad('yes', 'The card fees choice is not valid.');
  bad([], 'The card fees choice is not valid.');
  bad({ enabled: 'true', account: 'SOSFEES' }, 'The card fees choice is not valid.');
  bad({ enabled: 1 }, 'The card fees choice is not valid.');
  bad({ enabled: true, account: 'SOSFEES', percent: 1.4 }, 'The card fees choice is not valid.');
  bad({ enabled: true, account: 'bad;account' }, 'The account chosen for card fees is not valid.');
  bad({ enabled: false, account: 42 }, 'The account chosen for card fees is not valid.');
  bad({ enabled: true }, 'Choose the account for card fees, or switch card fees off.');
  bad({ enabled: true, account: '' }, 'Choose the account for card fees, or switch card fees off.');
  bad({ enabled: true, account: null }, 'Choose the account for card fees, or switch card fees off.');
  bad({ enabled: true, account: '  ' }, 'The account chosen for card fees is not valid.');
  // The older, parked idea (one supplier bill per payout) is still refused, and still a hook that plans nothing.
  assert.equal(validateInvoiceMapping(mapping({ feeBill: { enabled: true } })), 'The card fee bill is not available yet. It will follow once a payout has been checked.');
  assert.deepEqual(plan(plainDay().g, plainDay().fees).hooks, { feeBill: null, cashVariance: null });
});

test('5. the Ready checklist: a Card fees account item only while card fees are on', () => {
  const seen = seenFromGrouped(plainDay().g);
  const base = { ...mapping(), invoiceStartDate: '2026-09-01' };
  const tick = (m) => ({ ...m, figuresChecked: { hash: mappingHash(m) } });
  const item = (m, ctx = {}) => invoiceReadiness(tick(m), { seen, ...ctx }).items.find((i) => i.key === 'cardFees');
  assert.equal(item(base), undefined);
  assert.equal(item({ ...base, cardFees: { enabled: false, account: 'SOSFEES' } }), undefined);
  // On, with only the choices to go on (the nightly post): an account is enough.
  assert.deepEqual(item({ ...base, cardFees: ON }), { key: 'cardFees', ok: true, label: 'Card fees account', detail: '' });
  assert.deepEqual(item({ ...base, cardFees: { enabled: true } }), { key: 'cardFees', ok: false, label: 'Card fees account', detail: 'Choose the card fees account under VAT and accounts, Payments.' });
  assert.equal(item({ ...base, cardFees: { enabled: true } }, { addedOn: true }).detail, 'Choose the card fees account under Tax and accounts, Payments.');
  // It sits after the clearing accounts.
  assert.deepEqual(invoiceReadiness(tick({ ...base, cardFees: ON }), { seen }).items.map((i) => i.key), ['site', 'tracking', 'groups', 'discounts', 'tips', 'clearing', 'cardFees', 'figures', 'start']);
  // With Xero's (active) accounts to hand: it must be one of them, and an expense account.
  const accounts = [
    { id: 'a1', code: 'SOSFEES', name: 'Card fees', type: 'EXPENSE', cls: 'EXPENSE', pay: false, status: 'ACTIVE' },
    { id: 'a2', code: '200', name: 'Sales', type: 'REVENUE', cls: 'REVENUE', pay: false, status: 'ACTIVE' },
    { id: 'a3', code: '090', name: 'Bank', type: 'BANK', cls: 'ASSET', pay: true, status: 'ACTIVE' },
    { id: 'a4', code: '404', name: 'Bank fees', type: 'OVERHEADS', cls: 'EXPENSE', pay: false, status: 'ACTIVE' },
  ];
  assert.equal(item({ ...base, cardFees: ON }, { accounts }).ok, true);
  assert.equal(item({ ...base, cardFees: { enabled: true, account: 'sosfees' } }, { accounts }).ok, true, 'a code is matched case blind');
  assert.equal(item({ ...base, cardFees: { enabled: true, account: '404' } }, { accounts }).ok, true, 'any expense account will do');
  assert.equal(item({ ...base, cardFees: { enabled: true, account: 'a1' } }, { accounts }).ok, true, 'by id, for an account with no code');
  assert.equal(item({ ...base, cardFees: { enabled: true, account: 'GONE' } }, { accounts }).detail, 'The card fees account is not an active account in Xero. Choose another, or create one.');
  assert.equal(item({ ...base, cardFees: { enabled: true, account: '200' } }, { accounts }).detail, 'The card fees account must be an expense account in Xero.');
  assert.equal(item({ ...base, cardFees: { enabled: true, account: '090' } }, { accounts }).detail, 'The card fees account must be an expense account in Xero.');
  // A plan with fees and no account anywhere is not ready, in the same words.
  const p = plan(plainDay().g, { ...plainDay().fees, account: undefined }, {}, mapping({ cardFees: { enabled: true } }));
  assert.deepEqual(p.notReady, [{ code: 'card_fees_account', message: 'Choose the card fees account under VAT and accounts, Payments.' }]);
});

// ── 6 to 16: the line and the money ──────────────────────────────────────────

test('6. on, a plain day: ONE last line, Card fees, and the card payment is card takings less fees', () => {
  const w = plainDay();
  assert.deepEqual(w.fees, { charged: 43, returned: 0, cardSales: 2310, cardRefunds: 0, sales: { count: 4, known: 4 }, refunds: { count: 0, known: 0 }, unknown: [], account: 'SOSFEES' });
  const off = plan(w.g, null);
  const p = plan(w.g, w.fees);
  assert.deepEqual([p.blocked, p.notReady], [[], []]);
  assert.deepEqual(p.invoice.lines.map(row), [
    ['Food 20%', '202', 'OUTPUT2', 596, 99],
    ['Hot drinks 20%', '201', 'OUTPUT2', 1935, 323],
    ['Customer discounts 20%', '401', 'OUTPUT2', -30, -5],
    ['Loyalty rewards 20%', '403', 'OUTPUT2', -100, -17],
    ['Staff discounts 20%', '402', 'OUTPUT2', -150, -25],
    ['Food 0%', '202', 'ZERORATEDOUTPUT', 400, 0],
    ['Tips and gratuities', '825', 'NONE', 50, 0],
    ['Service charge', '826', 'NONE', 100, 0],
    ['Card fees', 'SOSFEES', 'NONE', -43, 0],
  ]);
  assert.equal(p.invoice.lines.filter((l) => l.kind === 'fee').length, 1);
  assert.deepEqual(p.invoice.lines.at(-1), { kind: 'fee', group: null, rateKey: null, description: 'Card fees', account: 'SOSFEES', taxType: 'NONE', amount: -43, tax: 0, xeroCalc: 0 });
  // Exactly what Xero receives for it: quantity 1, a minus amount, No VAT, the site's tracking.
  assert.deepEqual(p.invoice.payload.LineItems.at(-1), { Description: 'Card fees', Quantity: 1, UnitAmount: -0.43, AccountCode: 'SOSFEES', TaxType: 'NONE', TaxAmount: 0, Tracking: [{ Name: 'Location', Option: 'Leeds' }] });
  // Every sales line, every VAT figure and the tie to the till are the day planned without fees.
  assert.deepEqual(p.invoice.lines.slice(0, -1), off.invoice.lines);
  assert.deepEqual(p.invoice.payload.LineItems.slice(0, -1), off.invoice.payload.LineItems);
  assert.deepEqual(p.vatTie, off.vatTie);
  assert.deepEqual([p.totals.sales, p.totals.refunds, p.totals.vat, p.totals.refundVat], [off.totals.sales, off.totals.refunds, off.totals.vat, off.totals.refundVat]);
  assert.equal(p.totals.fees, 43);
  assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.TaxAmount)), 375, 'the VAT on the invoice does not move');
  // The money: the card clearing payment is 23.10 less 0.43; cash is untouched.
  assert.deepEqual(pays(off), [['PAY:CARDCLR', 2310], ['PAY:CASHTILL', 491]]);
  assert.deepEqual(pays(p), [['PAY:CARDCLR', 2267], ['PAY:CASHTILL', 491]]);
  assert.deepEqual(p.payments[0].payload, { Invoice: { InvoiceNumber: 'SOS-LEEDS-20260929' }, Account: { Code: 'CARDCLR' }, Date: DATE, Amount: 22.67, Reference: 'SOS-LEEDS-20260929 Card' });
  assert.deepEqual(p.payments.map((x) => x.reference), off.payments.map((x) => x.reference), 'the references are the ones the day had');
  assert.deepEqual(p.payments[1], off.payments[1]);
  // The invoice is the sum of its lines and the sum of its payments, to the penny.
  assert.equal(p.invoice.total, 2758);
  assert.equal(sumBy(p.invoice.lines, (l) => l.amount), 2758);
  assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.UnitAmount)), 2758);
  assert.equal(sumBy(p.payments, (x) => x.amount), 2758);
  assert.deepEqual(steps(p), ['INVOICE', 'PAY:CARDCLR', 'PAY:CASHTILL']);
  assert.deepEqual(p.cardFees, { line: true, reason: null, charged: 43, returned: 0, net: 43, account: 'SOSFEES', cardAccount: 'CARDCLR', cardBefore: 2310, cardAfter: 2267, unknown: [] });
  assert.deepEqual(p.warnings, off.warnings, 'nothing to warn about');
  // The same plan whether the fees are handed in or ride on the grouped day (as xero-sales does).
  assert.deepEqual(planXeroInvoiceDay(withCardFees(w.g, w.fees), { mapping: w.m, detail: DETAIL, site: SITE, date: DATE, currency: 'GBP' }), p);
  // The view for the Back Office, in major units.
  const v = planView(p);
  assert.deepEqual(v.totals, { sales: 28.01, refunds: 0, vat: 3.75, fees: 0.43 });
  assert.deepEqual(v.cardFees, { line: true, reason: null, account: 'SOSFEES', cardAccount: 'CARDCLR', charged: 0.43, returned: 0, net: 0.43, cardBefore: 23.1, cardAfter: 22.67, unknown: [] });
  assert.deepEqual(v.invoice.lines.at(-1), { kind: 'fee', refund: false, description: 'Card fees', account: 'SOSFEES', taxType: 'NONE', amount: -0.43, vat: 0, xeroVat: 0 });
  // No tracking chosen (a site alone on its Xero): the fee line has none either.
  const alone = plan(w.g, w.fees, {}, mOn({ tracking: { none: true } }));
  assert.ok(!('Tracking' in alone.invoice.payload.LineItems.at(-1)));
  // A fee account with no code is named by its id.
  const byId = plan(w.g, { ...w.fees, account: 'a1b2c3d4-0000-4000-8000-000000000000' });
  assert.equal(byId.invoice.payload.LineItems.at(-1).AccountID, 'a1b2c3d4-0000-4000-8000-000000000000');
});

test('7. on, with refunds as minus lines: sales lines, the refund lines, then Card fees', () => {
  const w = refundDay();
  // 0.13 was charged on the 8.30 payment; refunding 3.80 of it gives 0.06 back (the Payouts figure).
  assert.deepEqual([w.fees.charged, w.fees.returned, w.fees.cardSales, w.fees.cardRefunds, w.fees.unknown], [43, 6, 2310, 380, []]);
  const off = plan(w.g, null);
  const p = plan(w.g, w.fees);
  assert.deepEqual([p.refundWay, p.refundWayReason], [off.refundWay, off.refundWayReason]);
  assert.deepEqual([p.refundWay, p.refundWayReason, p.blocked], ['lines', null, []]);
  assert.deepEqual(p.invoice.lines.slice(-3).map(row), [
    ['Service charge', '826', 'NONE', 100, 0],
    ['Refund: Hot drinks 20%', '201', 'OUTPUT2', -380, -63],
    ['Card fees', 'SOSFEES', 'NONE', -37, 0],
  ]);
  assert.deepEqual(p.invoice.lines.slice(0, -1), off.invoice.lines);
  assert.deepEqual(p.invoice.lines.map((l) => l.kind === 'fee'), [...off.invoice.lines.map(() => false), true]);
  // Card: 23.10 taken, 3.80 refunded, 0.37 of fees. Cash as it was.
  assert.deepEqual(pays(off), [['PAY:CARDCLR', 1930], ['PAY:CASHTILL', 491]]);
  assert.deepEqual(pays(p), [['PAY:CARDCLR', 1893], ['PAY:CASHTILL', 491]]);
  assert.equal(p.invoice.total, 2384);
  assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.UnitAmount)), 2384);
  assert.equal(sumBy(p.payments, (x) => x.amount), 2384);
  assert.equal(p.creditNote, null);
  assert.deepEqual(p.vatTie, off.vatTie);
  assert.deepEqual(p.cardFees, { line: true, reason: null, charged: 43, returned: 6, net: 37, account: 'SOSFEES', cardAccount: 'CARDCLR', cardBefore: 1930, cardAfter: 1893, unknown: [] });
  // A day started with its refunds on the invoice: the same.
  assert.deepEqual(plan(w.g, w.fees, { started: 'lines' }).invoice, p.invoice);
});

test('8. a full refund gives the whole fee back; a sale fully refunded the same day leaves no fee and no line', () => {
  // The 8.00 card sale (fee 0.13) and a cash sale; the card sale refunded in full the same day.
  const refunds = refundOf(E, { id: 'f', amount: 8.0, taxAmount: 1.34, isFullRefund: true, legs: [legOf(E, 800)] });
  const w = dayOf([B, E], refunds);
  assert.deepEqual([w.fees.charged, w.fees.returned], [13, 13]);
  const off = plan(w.g, null);
  const p = plan(w.g, w.fees);
  assert.deepEqual(p.cardFees, { line: false, reason: 'none', charged: 13, returned: 13, net: 0, account: 'SOSFEES', cardAccount: 'CARDCLR', cardBefore: 0, cardAfter: 0, unknown: [] });
  assert.deepEqual(without(p), off, 'nothing about the day changes: no line, no warning');
  assert.ok(!('fees' in p.totals));
  // The card account nets to nothing, so (as before) it gets no payment at all.
  assert.deepEqual(pays(p), [['PAY:CASHTILL', 266]]);
  assert.equal(p.invoice.total, 266);
  // A day with no card sales at all, at a site with card fees on: the same.
  const cash = dayOf([B]);
  assert.deepEqual([cash.items.sales, cash.fees.charged], [[], 0]);
  assert.deepEqual(without(plan(cash.g, cash.fees)), plan(cash.g, null));
});

test('9. the fee given back on a refund is the Back Office Payouts figure, to the penny', () => {
  // [payment, fee, refunded]: the first two are the owner's own examples (11 Sep 2026).
  const table = [[250, 7, 125, 3], [100, 1, 50, 0], [830, 13, 380, 6], [800, 13, 800, 13], [800, 13, 400, 6], [999, 13, 1, 0], [333, 8, 111, 3], [1000, 15, 999, 15], [1, 5, 1, 5], [640, 0, 320, 0], [2599, 41, 1300, 21]];
  for (const [amount, fee, refunded, back] of table) {
    const pay = paymentRow(1, amount, fee);
    const items = { cardAccount: 'CARDCLR', sales: [], refunds: [{ checkId: 'c', minor: refunded, psp: psp(1) }], cardSales: 0, cardRefunds: refunded };
    const got = sumCardFees(items, new Map([[psp(1), pay]]));
    assert.equal(got.returned, back, `${refunded} of ${amount} at ${fee}`);
    assert.deepEqual([got.charged, got.unknown, got.refunds], [0, [], { count: 1, known: 1 }]);
    // The refund line of Back Office Payouts (both copies of venueFees), and the Payments tab:
    // the fee left on the payment is what was charged less what this refund gave back.
    const line = venuePayoutLine({ line_type: 'Refunded', gross_minor: -refunded }, pay);
    assert.equal(Math.abs(line.fee_minor), back);
    assert.deepEqual(payoutLineEdge({ line_type: 'Refunded', gross_minor: -refunded }, pay), line);
    assert.equal(venueFeeFor({ ...pay, amount_refunded_minor: refunded }), fee - back);
    // And the sale: the full fee, the sale line of Payouts.
    const sale = sumCardFees({ sales: [{ checkId: 'c', minor: amount, psp: psp(1) }], refunds: [], cardSales: amount, cardRefunds: 0 }, { [psp(1)]: pay });
    assert.equal(sale.charged, fee);
    assert.equal(venuePayoutLine({ line_type: 'Settled', gross_minor: amount }, pay).fee_minor, fee);
  }
  // 2.50 at 0.07, half refunded: 0.04 is left and 0.03 comes back.
  assert.equal(venueFeeFor(paymentRow(1, 250, 7, { amount_refunded_minor: 125 })), 4);
  // A payment already part refunded in our records still charges its FULL fee on the day of the
  // sale (the refund day carries what came back), so the two days never count a refund twice.
  const refundedSince = paymentRow(1, 250, 7, { amount_refunded_minor: 125 });
  assert.equal(sumCardFees({ sales: [{ checkId: 'c', minor: 250, psp: psp(1) }], refunds: [], cardSales: 250, cardRefunds: 0 }, new Map([[psp(1), refundedSince]])).charged, 7);
});

test('10. a refund on a later day than its sale: the sale day carries the full fee, the refund day less', () => {
  const day2 = businessDayWindow('2026-09-30', UK.timezone, UK.dayStart);
  const F = { ...E, id: 'F', closed_at: new Date(day2.fromMs + H).toISOString(), tenders: [{ method: 'card', amount: 8.0, tip: 0, processor: 'adyen', psp_ref: tillRef(10) }] };
  const payments = withPay(PAYMENTS, paymentRow(10, 800, 13));
  // Half of check E (sold on the 29th) is refunded on the 30th.
  const refunds = [{ ...E, refunds: [refundEntry({ id: 'late', amount: 4.0, taxAmount: 0.67, timestamp: day2.fromMs + 2 * H, legs: [legOf(E, 400)], items: [{ ...AMERICANO, refundQty: 2 }] })] }];
  const saleDay = dayOf(REF.rows, refunds, { payments });
  assert.deepEqual([saleDay.fees.charged, saleDay.fees.returned, saleDay.items.refunds], [43, 0, []], 'the refund is not on the day of the sale');
  const refundOn = dayOf([F], refunds, { payments, day: day2 });
  assert.deepEqual([refundOn.fees.charged, refundOn.fees.returned, refundOn.fees.cardRefunds], [13, 6, 400]);
  const p = planXeroInvoiceDay(refundOn.g, { mapping: refundOn.m, detail: DETAIL, site: SITE, date: '2026-09-30', currency: 'GBP', cardFees: refundOn.fees });
  assert.deepEqual([p.refundWay, p.blocked], ['lines', []]);
  assert.deepEqual(p.invoice.lines.at(-1), { kind: 'fee', group: null, rateKey: null, description: 'Card fees', account: 'SOSFEES', taxType: 'NONE', amount: -7, tax: 0, xeroCalc: 0 });
  assert.deepEqual(pays(p), [['PAY:CARDCLR', 800 - 400 - 7]]);
  // Over both days check E cost what the Payments tab shows for it: 0.13 less the 0.06 given back.
  assert.equal(FEE.E - refundOn.fees.returned, venueFeeFor({ ...PAYMENTS.get(psp(4)), amount_refunded_minor: 400 }));
});

test('11. no fee comes back without a payment to take it from, and the day says so', () => {
  // (a) Card money refunded with no processor reversal on record: nothing to match.
  const noLeg = dayOf([E], refundOf(E, { id: 'n', amount: 2.0, taxAmount: 0.34, legs: undefined, items: [AMERICANO] }));
  assert.deepEqual(noLeg.items.refunds, [{ checkId: 'E', minor: 200, psp: null }]);
  assert.deepEqual([noLeg.fees.returned, noLeg.fees.unknown], [0, [{ side: 'refund', reason: 'no_reference', count: 1, amount: 200, checkIds: ['E'] }]]);
  // (b) A reversal that failed moved no money: only the one that went through counts, and gives back.
  const partFailed = dayOf([E], refundOf(E, { id: 'p', amount: 4.0, taxAmount: 0.67, cardStatus: 'partial', legs: [legOf(E, 200), legOf(E, 200, { status: 'failed' })], items: [{ ...AMERICANO, refundQty: 2 }] }));
  assert.deepEqual(partFailed.items.refunds, [{ checkId: 'E', minor: 200, psp: psp(4) }]);
  assert.deepEqual([partFailed.fees.returned, partFailed.fees.unknown], [3, []]);
  assert.equal(partFailed.fees.returned, Math.abs(venuePayoutLine({ line_type: 'Refunded', gross_minor: -200 }, PAYMENTS.get(psp(4))).fee_minor));
  // A refund whose only reversal failed is not on the day at all.
  const failed = dayOf([E], refundOf(E, { id: 'x', amount: 2.0, taxAmount: 0.34, cardStatus: 'failed', legs: [legOf(E, 200, { status: 'failed' })], items: [AMERICANO] }));
  assert.deepEqual([failed.items.refunds, failed.g.summary.refunds.totals.gross], [[], 0]);
  // (c) The payment that was refunded has no row (yet).
  const Y = earlier(D, 'Y', 20, 380);
  const missing = dayOf([E], refundOf(Y, { id: 'm', amount: 3.8, taxAmount: 0.63, isFullRefund: true, legs: [legOf(Y, 380)] }));
  assert.deepEqual([missing.fees.returned, missing.fees.unknown], [0, [{ side: 'refund', reason: 'no_payment', count: 1, amount: 380, checkIds: ['Y'] }]]);
  // (d) The payment has a row and no fee stamped.
  const unstamped = dayOf([E], refundOf(Y, { id: 'm', amount: 3.8, taxAmount: 0.63, isFullRefund: true, legs: [legOf(Y, 380)] }), { payments: withPay(PAYMENTS, paymentRow(20, 380, null)) });
  assert.deepEqual(unstamped.fees.unknown, [{ side: 'refund', reason: 'no_fee', count: 1, amount: 380, checkIds: ['Y'] }]);
  // Each of them: the line carries the fees that ARE known, and one warning names what is not.
  for (const w of [noLeg, missing, unstamped]) {
    const p = plan(w.g, w.fees);
    assert.deepEqual([p.cardFees.line, p.cardFees.net, p.invoice.lines.at(-1).amount], [true, 13, -13]);
    assert.equal(warned(p, 'card_fees_missing').length, 1);
    assert.deepEqual(warned(p, 'card_fees_missing')[0].checkIds, w.fees.unknown[0].checkIds);
  }
  assert.equal(warned(plan(noLeg.g, noLeg.fees), 'card_fees_missing')[0].message,
    'No card fee was found for 1 card refund (2.00). It has no card processor reference on the till record. The Card fees line leaves it out, so the card clearing account will be out by its fee. Check it under Card payments and put the difference right in Xero.');
  // More reversed to the card than the invoice counts as card money is capped at what it counts.
  const over = cardFeeItems({ day: DAY, saleRows: [E], refundRows: refundOf(E, { id: 'o', amount: 2.0, taxAmount: 0.34, legs: [legOf(E, 500)], items: [AMERICANO] }), clearing: mOn().clearing });
  assert.deepEqual([over.refunds, over.cardRefunds], [[{ checkId: 'E', minor: 200, psp: psp(4) }], 200]);
});

test('12. more fee back than charged: ONE plus line, Card fees returned, and the card payment goes UP', () => {
  // The refunds on the invoice: an 8.00 card sale at a 0.02 fee, and 3.80 refunded from a
  // payment of the day before that had cost 0.50.
  const Y = earlier(D, 'Y', 20, 380);
  const cheap = withPay(new Map(), paymentRow(4, 800, 2), paymentRow(20, 380, 50));
  const w = dayOf([E], refundOf(Y, { id: 'ry', amount: 3.8, taxAmount: 0.63, isFullRefund: true, legs: [legOf(Y, 380)] }), { payments: cheap });
  assert.deepEqual([w.fees.charged, w.fees.returned], [2, 50]);
  const off = plan(w.g, null);
  const p = plan(w.g, w.fees);
  assert.deepEqual([p.refundWay, p.blocked], ['lines', []]);
  assert.deepEqual(p.invoice.lines.at(-1), { kind: 'fee', group: null, rateKey: null, description: 'Card fees returned', account: 'SOSFEES', taxType: 'NONE', amount: 48, tax: 0, xeroCalc: 0 });
  assert.deepEqual(p.invoice.payload.LineItems.at(-1), { Description: 'Card fees returned', Quantity: 1, UnitAmount: 0.48, AccountCode: 'SOSFEES', TaxType: 'NONE', TaxAmount: 0, Tracking: [{ Name: 'Location', Option: 'Leeds' }] });
  assert.deepEqual([pays(off), pays(p)], [[['PAY:CARDCLR', 420]], [['PAY:CARDCLR', 468]]]);
  assert.equal(p.invoice.total, 468);
  assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.UnitAmount)), 468);
  assert.equal(p.totals.fees, -48);
  assert.deepEqual([p.cardFees.net, p.cardFees.cardBefore, p.cardFees.cardAfter], [-48, 420, 468]);
  assert.equal(p.invoice.lines.filter((l) => l.kind === 'fee').length, 1, 'still one line, never two');
  // The credit note way: a 2.80 card sale (0.08) and cash, with 8.00 refunded from the day before (0.13 back).
  const Z = earlier(E, 'Z', 21, 800);
  const pay2 = withPay(PAYMENTS, paymentRow(21, 800, 13));
  const c = dayOf([B, D], refundOf(Z, { id: 'rz', amount: 8.0, taxAmount: 1.34, isFullRefund: true, legs: [legOf(Z, 800)] }), { payments: pay2 });
  const cOff = plan(c.g, null), cOn = plan(c.g, c.fees);
  assert.deepEqual([cOn.refundWay, cOn.refundWayReason], [cOff.refundWay, cOff.refundWayReason]);
  assert.equal(cOn.refundWay, 'credit_note');
  assert.deepEqual(cOn.invoice.lines.at(-1).description, 'Card fees returned');
  assert.deepEqual([pays(cOff), pays(cOn)], [[['PAY:CARDCLR', 280], ['PAY:CASHTILL', 266]], [['PAY:CARDCLR', 285], ['PAY:CASHTILL', 266]]]);
  assert.equal(cOn.invoice.total, 551);
  assert.equal(sumBy(cOn.payments, (x) => x.amount), 551);
  assert.deepEqual([cOn.creditNote, cOn.refundPayments], [cOff.creditNote, cOff.refundPayments]);
  // Nothing negative is sent, either way.
  for (const q of [p, cOn]) {
    assert.ok(q.invoice.total > 0 && q.payments.every((x) => x.amount > 0 && x.payload.Amount > 0));
    assert.ok(q.refundPayments.every((x) => x.amount > 0));
  }
});

test('13. the credit note way with fees: the line is on the INVOICE, the credit note is untouched', () => {
  const Y = earlier(D, 'YL', 20, 380), Z = earlier(E, 'Z', 21, 800);
  const zeroRated = { id: 'Z0', closed_at: at(2), total: 8.0, tip: 0, service: 0, tax_amount: 0, tax_breakdown: breakdown([{ id: 'r0', gross: 8.0, tax: 0 }], 'takeaway'),
    items: [{ uid: 'z1', cat: 'cat-food_1e945c26', itemId: 'm-sand', qty: 2, price: 4.0, taxRateId: 'r20', taxOverrides: { takeaway: 'r0', 'dine-in': 'r20' } }], tenders: [{ method: 'card', amount: 8.0, tip: 0, processor: 'adyen', psp_ref: tillRef(30) }] };
  const payments = withPay(PAYMENTS, paymentRow(20, 380, 9), paymentRow(21, 800, 13), paymentRow(30, 800, 13));
  const days = {
    // Card sales only, and 2.00 refunded in cash.
    account_short: [dayOf([A, E], refundOf(E, { id: 'r7', amount: 2.0, taxAmount: 0.34, tenderMethod: 'cash', cardStatus: null, items: [AMERICANO] }), { payments }), null, 26],
    // One 2.80 card sale, and 8.00 refunded from the day before.
    total_not_positive: [dayOf([D], refundOf(Z, { id: 'r8', amount: 8.0, taxAmount: 1.34, isFullRefund: true, legs: [legOf(Z, 800)] }), { payments }), null, -5],
    // A 0% sale, and a 20% check of the day before refunded.
    vat_negative: [dayOf([zeroRated], refundOf(Y, { id: 'r11', amount: 3.8, taxAmount: 0.63, isFullRefund: true, legs: [legOf(Y, 380)] }), { payments }), null, 4],
    // A day an earlier attempt started as a credit note (every day sent before 13 Oct 2026).
    started_credit_note: [refundDay(), 'credit_note', 37],
    xero_refused: [refundDay(), 'refused', 37],
  };
  for (const [reason, [w, started, net]] of Object.entries(days)) {
    const off = plan(w.g, null, { started });
    const p = plan(w.g, w.fees, { started });
    assert.deepEqual([p.refundWay, p.refundWayReason, p.blocked], ['credit_note', reason, []], reason);
    assert.deepEqual([off.refundWay, off.refundWayReason], ['credit_note', reason], `${reason}: fees never choose the way`);
    assert.equal(p.cardFees.net, net, reason);
    assert.equal(p.cardFees.line, true, reason);
    // On the invoice: the gross sales lines, then the fee line. No refund line.
    assert.deepEqual(p.invoice.lines.slice(0, -1), off.invoice.lines, reason);
    assert.deepEqual([p.invoice.lines.at(-1).kind, p.invoice.lines.at(-1).amount], ['fee', -net], reason);
    assert.ok(p.invoice.lines.every((l) => !l.refund), reason);
    assert.equal(p.invoice.total, off.invoice.total - net, reason);
    // The card clearing payment is its takings less the net fee; every other payment as it was.
    const card = (q) => q.payments.find((x) => x.account === 'CARDCLR').amount;
    assert.equal(card(p), card(off) - net, reason);
    assert.deepEqual(p.payments.filter((x) => x.account !== 'CARDCLR'), off.payments.filter((x) => x.account !== 'CARDCLR'), reason);
    assert.equal(sumBy(p.payments, (x) => x.amount), p.invoice.total, reason);
    // The credit note, its payload and its refund payments: deep equal, gross, exactly as before.
    assert.deepEqual(p.creditNote, off.creditNote, reason);
    assert.deepEqual(p.refundPayments, off.refundPayments, reason);
    assert.deepEqual(steps(p), steps(off), reason);
    assert.deepEqual(warned(p, 'refunds_as_credit_note'), warned(off, 'refunds_as_credit_note'), reason);
  }
  assert.deepEqual(pays(plan(days.started_credit_note[0].g, days.started_credit_note[0].fees, { started: 'credit_note' })), [['PAY:CARDCLR', 2310 - 37], ['PAY:CASHTILL', 491]]);
});

test('14. the card payment would be zero or less: the day posts WITHOUT the line and says so', () => {
  // (a) A 0.05 card sale whose fee is 0.05 (exactly zero left), then 0.06 (below zero).
  const tiny = { id: 'T', closed_at: at(2), total: 0.05, tip: 0, service: 0, tax_amount: 0.01, tax_breakdown: breakdown([{ id: 'r20', gross: 0.05, tax: 0.0083 }]),
    items: [{ uid: 't1', cat: 'cat-hot_1e945c26', itemId: 'm-sip', qty: 1, price: 0.05, taxRateId: 'r20' }], tenders: [{ method: 'card', amount: 0.05, tip: 0, processor: 'adyen', psp_ref: tillRef(40) }] };
  for (const fee of [5, 6]) {
    const w = dayOf([B, tiny], [], { payments: withPay(new Map(), paymentRow(40, 5, fee)) });
    const off = plan(w.g, null), p = plan(w.g, w.fees);
    assert.deepEqual(p.cardFees, { line: false, reason: 'card_short', charged: fee, returned: 0, net: fee, account: 'SOSFEES', cardAccount: 'CARDCLR', cardBefore: 5, cardAfter: 5, unknown: [] });
    const said = { code: 'card_fees_not_posted', reason: 'card_short', message: `The card fees of this day (0.0${fee}) are as much as the card money left on the invoice (0.05) or more, and Xero does not take a payment of zero or less. This day posts without the Card fees line. Put the fees in Xero by hand.` };
    assert.deepEqual(without(p), { ...off, warnings: [...off.warnings, said] }, 'the plan of the day without fees, and one more warning');
    assert.deepEqual(pays(p), [['PAY:CARDCLR', 5], ['PAY:CASHTILL', 266]]);
    assert.ok(!('fees' in p.totals));
  }
  // With 0.04 the line is carried and a penny is paid in.
  const just = dayOf([B, tiny], [], { payments: withPay(new Map(), paymentRow(40, 5, 4)) });
  assert.deepEqual(pays(plan(just.g, just.fees)), [['PAY:CARDCLR', 1], ['PAY:CASHTILL', 266]]);
  // (b) Refunds on the invoice leave less card money than the fee: 10.80 taken by card, 10.75
  // refunded from the day before (0.16 back), 0.21 charged. 0.05 of card money, 0.05 of fees.
  const big = { id: 'ZB', closed_at: BEFORE, total: 10.75, tip: 0, service: 0, tax_amount: 1.0, tax_breakdown: breakdown([{ id: 'r20', gross: 6.0, tax: 1.0 }, { id: 'r0', gross: 4.75, tax: 0 }], 'takeaway'),
    items: [{ uid: 'zb1', cat: 'cat-hot_1e945c26', itemId: 'm-tray', qty: 1, price: 6.0, taxRateId: 'r20' }, { uid: 'zb2', cat: 'cat-food_1e945c26', itemId: 'm-sand', qty: 1, price: 4.75, taxRateId: 'r20', taxOverrides: { takeaway: 'r0', 'dine-in': 'r20' } }],
    tenders: [{ method: 'card', amount: 10.75, tip: 0, processor: 'adyen', psp_ref: tillRef(41) }] };
  const w = dayOf([B, D, E], refundOf(big, { id: 'rb', amount: 10.75, taxAmount: 1.0, isFullRefund: true, legs: [legOf(big, 1075)] }), { payments: withPay(PAYMENTS, paymentRow(41, 1075, 16)) });
  const off = plan(w.g, null), p = plan(w.g, w.fees);
  assert.deepEqual([off.refundWay, off.blocked, pays(off)], ['lines', [], [['PAY:CARDCLR', 5], ['PAY:CASHTILL', 266]]]);
  assert.deepEqual([p.cardFees.line, p.cardFees.reason, p.cardFees.charged, p.cardFees.returned, p.cardFees.net, p.cardFees.cardBefore], [false, 'card_short', 21, 16, 5, 5]);
  assert.deepEqual(without(p), { ...off, warnings: [...off.warnings, warned(p, 'card_fees_not_posted')[0]] });
  assert.equal(warned(p, 'card_fees_not_posted').length, 1);
  assert.equal(p.refundWay, 'lines', 'the fees never push a day to a credit note');
});

test('15. refunds and no sales: no invoice to carry the fee given back, and the day says so', () => {
  const Z = earlier(E, 'Z', 21, 800);
  const payments = withPay(PAYMENTS, paymentRow(21, 800, 13));
  const w = dayOf([], refundOf(Z, { id: 'rz', amount: 8.0, taxAmount: 1.34, isFullRefund: true, legs: [legOf(Z, 800)] }), { payments });
  const off = plan(w.g, null), p = plan(w.g, w.fees);
  assert.deepEqual([p.invoice, p.payments, p.refundWay, p.refundWayReason], [null, [], 'credit_note', 'no_sales']);
  assert.deepEqual([p.creditNote, p.refundPayments, steps(p)], [off.creditNote, off.refundPayments, ['CREDIT', 'REFUND:CARDCLR']]);
  assert.deepEqual([p.cardFees.line, p.cardFees.reason, p.cardFees.net], [false, 'no_invoice', -13]);
  assert.deepEqual(warned(p, 'card_fees_not_posted'), [{ code: 'card_fees_not_posted', reason: 'no_invoice',
    message: 'This day has refunds and no sales, so it has no invoice to carry its card fees (0.13 given back on the refunds). They are not posted. Put them in Xero by hand.' }]);
  assert.deepEqual(without(p), { ...off, warnings: [...off.warnings, ...warned(p, 'card_fees_not_posted')] });
  // Nothing given back (a cash refund): nothing to say.
  const cash = dayOf([], refundOf(B, { id: 'rc', amount: 2.66, taxAmount: 0.44, tenderMethod: 'cash', cardStatus: null, isFullRefund: true }));
  assert.deepEqual(without(plan(cash.g, cash.fees)), plan(cash.g, null));
  assert.equal(plan(cash.g, cash.fees).cardFees.reason, 'none');
  // Sales, but none by card, and fee given back on a card refund: there is no card payment on
  // the invoice to carry it, so it is not posted either, and the day says so.
  const noCard = dayOf([B], refundOf(Z, { id: 'rz', amount: 8.0, taxAmount: 1.34, isFullRefund: true, legs: [legOf(Z, 800)] }), { payments });
  const nOff = plan(noCard.g, null), nOn = plan(noCard.g, noCard.fees);
  assert.deepEqual([nOn.cardFees.line, nOn.cardFees.reason, nOn.cardFees.net, nOn.cardFees.cardBefore], [false, 'no_card_payment', -13, 0]);
  assert.deepEqual(warned(nOn, 'card_fees_not_posted').map((x) => x.message), ['This day took no card payments, so its invoice cannot carry the card fees given back on its refunds (0.13). They are not posted. Put them in Xero by hand.']);
  assert.deepEqual([nOn.invoice, nOn.payments, nOn.creditNote, nOn.blocked], [nOff.invoice, nOff.payments, nOff.creditNote, []]);
});

/** A generated day with references, refunds of every kind and made up fees, some of them missing. */
function randomDay(seed) {
  const r = rng(seed * 7919 + 3);
  const n = 4 + Math.floor(r() * 12);
  const raw = [];
  for (let i = 0; i < n; i++) raw.push(generatedCheck(r, `g${seed}-${i}`, 1 + (i % 18)));
  const { rows, refs } = referenced(raw, seed * 1000);
  const m = mOn({ clearing: { card: 'CARDCLR', cash: 'CASHTILL' } });
  const payments = new Map();
  for (const x of refs) {
    const roll = r();
    if (roll < 0.04) continue;                                             // no payment row
    payments.set(psp(x.n), paymentRow(x.n, x.minor, roll < 0.08 ? null : Math.floor(r() * (x.minor * 0.03 + 25))));
  }
  const refunds = [];
  rows.forEach((check, i) => {
    const roll = r();
    if (roll > 0.35) return;
    const card = check.tenders.find((t) => t.method === 'card');
    const cardMinor = card ? Math.round((card.amount + (card.tip || 0)) * 100) : 0;
    if (roll < 0.12 && cardMinor) {
      refunds.push({ ...check, refunds: [refundEntry({ id: 'f', amount: check.total, tipAmount: check.tip, serviceAmount: check.service, isFullRefund: true, timestamp: atMs(21),
        legs: [cardLeg(Math.min(cardMinor, Math.round(check.total * 100)), { id: card.psp_ref, ref: `R${i}` })] })] });
      return;
    }
    const amount = Math.min(check.total, check.items[0].price);
    const toCard = !!card && roll < 0.28;
    const legs = toCard && roll < 0.22 ? [cardLeg(Math.min(Math.round(amount * 100), cardMinor), { id: card.psp_ref, ref: `R${i}` })] : undefined;
    refunds.push({ ...check, refunds: [refundEntry({ id: 'x', amount, timestamp: atMs(21), legs, tenderMethod: toCard ? 'card' : 'cash', cardStatus: legs ? 'accepted' : null, items: [{ ...check.items[0], refundQty: 1 }] })] });
  });
  // One day in four also refunds, in full and to its card, a check of the day before, whose fee
  // may be far more than this day's sales paid.
  if (r() < 0.25) {
    const old = generatedCheck(r, `y${seed}`, 1);
    const nOld = seed * 1000 + 900;
    const totalMinor = Math.round(old.total * 100);
    const y = { ...old, closed_at: BEFORE, tenders: [{ method: 'card', amount: Math.round((old.total - old.tip) * 100) / 100, tip: old.tip, processor: 'adyen', psp_ref: tillRef(nOld) }] };
    payments.set(psp(nOld), paymentRow(nOld, totalMinor, Math.floor(r() * 400)));
    refunds.push({ ...y, refunds: [refundEntry({ id: 'y', amount: old.total, tipAmount: old.tip, serviceAmount: old.service, isFullRefund: true, timestamp: atMs(20), legs: [cardLeg(totalMinor, { id: tillRef(nOld), ref: 'RY' })] })] });
  }
  return dayOf(rows, refunds, { m, payments });
}
const RANDOM_DAYS = 200;
// The planner's own card money on the card clearing account, from the grouped day.
const cardMoney = (g, m, side) => sumBy(g.summary[side].byMethod.filter((x) => x.kind === 'card' && x.gross && clearingFor(x, m.clearing).account === clearingFor({ kind: 'card', processor: 'adyen' }, m.clearing).account), (x) => x.gross);

test('16. the fees must be for the SAME card sales the plan holds, or the line is not carried', () => {
  const w = refundDay();
  for (const fees of [{ ...w.fees, cardSales: w.fees.cardSales + 1 }, { ...w.fees, cardSales: 0 }, { ...w.fees, cardRefunds: w.fees.cardRefunds - 1 }, { ...w.fees, cardRefunds: 0 }]) {
    const off = plan(w.g, null), p = plan(w.g, fees);
    assert.deepEqual([p.cardFees.line, p.cardFees.reason], [false, 'sales_differ']);
    assert.deepEqual(warned(p, 'card_fees_not_posted'), [{ code: 'card_fees_not_posted', reason: 'sales_differ', message: "ServOS could not tie the card fees to this day's card sales, so this day posts without the Card fees line. Put the fees in Xero by hand." }]);
    assert.deepEqual(without(p), { ...off, warnings: [...off.warnings, ...warned(p, 'card_fees_not_posted')] });
  }
  // The fees of one day never land on another: the plain day's fees on the refund day do not tie.
  assert.equal(plan(w.g, plainDay().fees).cardFees.reason, 'sales_differ');
  // On 200 generated days (split bills, tips, loyalty credit, part and full refunds, refunds with
  // and without a reversal on record) the fee items ARE the planner's card money, both sides.
  let cardRefundDays = 0;
  for (let seed = 1; seed <= RANDOM_DAYS; seed++) {
    const d = randomDay(seed);
    assert.equal(d.items.cardSales, cardMoney(d.g, d.m, 'sales'), `seed ${seed}: card sales`);
    assert.equal(d.items.cardRefunds, cardMoney(d.g, d.m, 'refunds'), `seed ${seed}: card refunds`);
    assert.equal(sumBy(d.items.sales, (x) => x.minor), d.items.cardSales);
    if (d.items.cardRefunds) cardRefundDays += 1;
    assert.notEqual(plan(d.g, d.fees, {}, d.m).cardFees.reason, 'sales_differ', `seed ${seed}`);
  }
  assert.ok(cardRefundDays > 40, `${cardRefundDays} days with card refunds`);
});

// ── 17 to 20: which fees ─────────────────────────────────────────────────────

test('17. the fee items are the card money the invoice counts: no more, no less', () => {
  const clearing = mOn().clearing;
  const items = (sales, refunds = [], c = clearing) => cardFeeItems({ day: DAY, saleRows: sales, refundRows: refunds, clearing: c });
  // A split bill (check C: 4.00 card, 2.25 cash) gives its card part only; a tip on the card is card money.
  assert.deepEqual(items([C]).sales, [{ checkId: 'C', minor: 400, psp: psp(2) }]);
  assert.deepEqual(items([A]).sales, [{ checkId: 'A', minor: 830, psp: psp(1) }]);
  assert.deepEqual(items([B]).sales, [], 'cash is not card money');
  assert.deepEqual(items([D]).sales, [{ checkId: 'D', minor: 280, psp: psp(3) }], 'the loyalty credit is not card money');
  // A tip added after the close (US tip on the receipt): on the card it was captured on.
  const tipped = { id: 'TP', closed_at: at(3), total: 12, tip: 2, service: 0, tax_amount: 1.67, tenders: [{ method: 'card', amount: 10, tip: 0, processor: 'adyen', psp_ref: tillRef(50) }] };
  assert.deepEqual(items([tipped]).sales, [{ checkId: 'TP', minor: 1200, psp: psp(50) }]);
  // Voided, outside the business day, or the same row twice.
  assert.deepEqual(items([{ ...E, voided: true }, { ...E, id: 'V2', status: 'voided' }]).sales, []);
  assert.deepEqual(items([{ ...E, closed_at: BEFORE }, { ...E, id: 'L', closed_at: new Date(DAY.toMs).toISOString() }]).sales, []);
  assert.deepEqual(items([E, E, { ...E }]).sales, [{ checkId: 'E', minor: 800, psp: psp(4) }]);
  // A row written with no tenders (the kiosk): card money, and no reference to match.
  const kiosk = { id: 'K', closed_at: at(4), total: 6.5, tip: 0, service: 0, tax_amount: 1.08, source: 'kiosk', payment_method: 'card-external', method: 'card' };
  assert.deepEqual(items([kiosk]).sales, [{ checkId: 'K', minor: 650, psp: null }]);
  assert.equal(items([kiosk]).cardSales, cardMoney(groupedOf([kiosk]), mOn(), 'sales'));
  // A card tender mapped to ANOTHER clearing account is not in scope: its payment is not the one the fee comes off.
  const ryft = { ...E, id: 'R', tenders: [{ method: 'card', amount: 8.0, tip: 0, processor: 'ryft', psp_ref: 'pay_made_up' }] };
  const split = { card: 'CARDCLR', 'card:ryft': 'RYFTCLR', cash: 'CASHTILL' };
  assert.deepEqual(items([E, ryft], [], split).sales, [{ checkId: 'E', minor: 800, psp: psp(4) }]);
  // Mapped to the SAME account, another processor's payment is on the invoice's card money, and
  // can never have a fee in our records: counted, and never waited for.
  assert.deepEqual(items([E, ryft]).sales, [{ checkId: 'E', minor: 800, psp: psp(4) }, { checkId: 'R', minor: 800, psp: null, other: true }]);
  // card:adyen mapped on its own: only Adyen's tenders are in scope.
  const own = { card: 'OTHERCLR', 'card:adyen': 'ADYENCLR', cash: 'CASHTILL' };
  const none = { ...E, id: 'N', tenders: [{ method: 'card', amount: 8.0, tip: 0, psp_ref: tillRef(51) }] };
  assert.deepEqual([items([E, none, ryft], [], own).cardAccount, items([E, none, ryft], [], own).sales], ['ADYENCLR', [{ checkId: 'E', minor: 800, psp: psp(4) }]]);
  // No card clearing account chosen at all: nothing is in scope (the day is refused for that anyway).
  assert.deepEqual(items(REF.rows, latteRefund(), { cash: 'CASHTILL' }), { cardAccount: null, sales: [], refunds: [], cardSales: 0, cardRefunds: 0 });
  // Card and cash sharing ONE clearing account: the items are still the card money only, and the
  // fee comes off that account's one payment.
  const shared = mOn({ clearing: { card: 'TILL', cash: 'TILL', gift_card: '830' } });
  const w = dayOf(REF.rows, [], { m: shared });
  assert.deepEqual([w.items.cardAccount, w.items.cardSales, w.fees.charged], ['TILL', 2310, 43]);
  const p = plan(w.g, w.fees, {}, shared);
  assert.deepEqual([pays(plan(w.g, null, {}, shared)), pays(p)], [[['PAY:TILL', 2801]], [['PAY:TILL', 2758]]]);
  assert.deepEqual([p.cardFees.cardBefore, p.cardFees.cardAfter, p.invoice.total, p.blocked], [2801, 2758, 2758, []]);
  // Refunds: a duplicate entry counts once, a voided check's refund not at all.
  const twice = [{ ...A, refunds: [...latteRefund()[0].refunds, ...latteRefund()[0].refunds] }];
  assert.deepEqual(items(REF.rows, twice).refunds, [{ checkId: 'A', minor: 380, psp: psp(1) }]);
  assert.deepEqual(items(REF.rows, [{ ...latteRefund()[0], voided: true }]).refunds, []);
});

test('18. pspOf: the PSP reference after the last dot; one payment, one fee', () => {
  assert.equal(pspOf('D9Uy001791813744047.F3ZPBRZDSZP6TC24'), 'F3ZPBRZDSZP6TC24');
  assert.equal(pspOf('F3ZPBRZDSZP6TC24'), 'F3ZPBRZDSZP6TC24');
  assert.equal(pspOf('  a.b.C3  '), 'C3');
  for (const v of ['', '   ', null, undefined, 'abc.', '.']) assert.equal(pspOf(v), null, JSON.stringify(v));
  assert.equal(pspOf(tillRef(7)), psp(7));
  assert.equal(psp(7).length, 16);
  // The same payment on two tenders (a check split after it was paid): its fee is charged once.
  const pay = new Map([[psp(1), paymentRow(1, 1000, 15)]]);
  const two = { sales: [{ checkId: 'a', minor: 600, psp: psp(1) }, { checkId: 'b', minor: 400, psp: psp(1) }], refunds: [], cardSales: 1000, cardRefunds: 0 };
  assert.deepEqual(sumCardFees(two, pay), { charged: 15, returned: 0, cardSales: 1000, cardRefunds: 0, sales: { count: 2, known: 2 }, refunds: { count: 0, known: 0 }, unknown: [] });
  // And when that payment has no row, both tenders are missing it, not one.
  assert.deepEqual(sumCardFees(two, new Map()).unknown, [{ side: 'sale', reason: 'no_payment', count: 2, amount: 1000, checkIds: ['a', 'b'] }]);
  // No more than 25 check ids are kept on a warning.
  const many = { sales: Array.from({ length: 40 }, (_, i) => ({ checkId: `c${i}`, minor: 100, psp: null })), refunds: [], cardSales: 4000, cardRefunds: 0 };
  assert.deepEqual([sumCardFees(many, null).unknown[0].count, sumCardFees(many, null).unknown[0].checkIds.length], [40, 25]);
});

test('19. why a payment has no fee, and which of them can still arrive; Adyen\'s own cost is never read', () => {
  const one = (payment, item = { checkId: 'c', minor: 500, psp: psp(1) }) => sumCardFees({ sales: [item], refunds: [], cardSales: 500, cardRefunds: 0 }, payment ? new Map([[psp(1), payment]]) : new Map());
  const reason = (r) => (r.unknown[0] ? r.unknown[0].reason : null);
  assert.equal(reason(one(paymentRow(1, 500, 9))), null);
  assert.equal(one(paymentRow(1, 500, 9)).charged, 9);
  assert.equal(one(paymentRow(1, 500, 0)).charged, 0, 'a fee of nothing is a known fee');
  assert.equal(reason(one(paymentRow(1, 500, 0))), null);
  assert.equal(reason(one(null, { checkId: 'c', minor: 500, psp: null })), 'no_reference');
  assert.equal(reason(one(null, { checkId: 'c', minor: 500, psp: null, other: true })), 'other_processor');
  assert.equal(reason(one(null)), 'no_payment');
  assert.equal(reason(one(paymentRow(1, 500, null))), 'no_fee', 'taken, and not stamped yet');
  assert.equal(reason(one(paymentRow(1, 500, 9, { success: false }))), 'not_taken');
  assert.equal(reason(one(paymentRow(1, 500, null, { success: false }))), 'not_taken');
  assert.equal(reason(one(paymentRow(1, 500, 9, { last_event_code: 'CANCELLATION' }))), 'not_taken');
  assert.equal(reason(one(paymentRow(1, 500, 9, { last_event_code: 'CAPTURE_FAILED' }))), 'not_taken');
  assert.equal(reason(one(paymentRow(1, 500, 9, { capture_required: true, captured_at: null }))), 'not_taken', 'a hold never captured');
  assert.equal(reason(one(paymentRow(1, 500, 9, { capture_required: true, captured_at: at(2), captured_minor: 500 }))), null, 'a hold captured for what it held');
  assert.equal(one(paymentRow(1, 500, 9, { last_event_code: 'CAPTURE_FAILED', applied_mods: ['CAPTURE:x:true'] })).charged, 9, 'a later capture went through');
  // Only a fee that can still arrive makes a day wait.
  const waits = (r) => !!cardFeesWait({ unknown: [{ side: 'sale', reason: r, count: 1, amount: 500, checkIds: [] }] }, { dayEndMs: DAY.toMs, nowMs: DAY.toMs + 5 * H, timezone: UK.timezone });
  assert.deepEqual(['no_payment', 'no_fee', 'no_reference', 'other_processor', 'not_taken'].map(waits), [true, true, false, false, false]);
  // The sums are known fees only, never a guess: a day of unknowns charges nothing.
  const blind = sumCardFees(plainDay().items, new Map());
  assert.deepEqual([blind.charged, blind.returned, blind.sales, blind.unknown], [0, 0, { count: 4, known: 0 }, [{ side: 'sale', reason: 'no_payment', count: 4, amount: 2310, checkIds: ['A', 'C', 'D', 'E'] }]]);
  // What is read from adyen_payments: the venue's fee and what rates it. Never Adyen's cost.
  const cols = CARD_FEE_COLS.split(',').map((c) => c.trim().split(':')[0]);
  assert.ok(cols.includes('commission_minor') && cols.includes('psp_reference') && cols.includes('location_id'));
  assert.ok(!cols.some((c) => /^fee_|fee_breakdown|rate_category/.test(c)), cols.join(' '));
  assert.doesNotMatch(CARD_FEE_COLS, /fee_minor|fee_breakdown/);
  const src = read('supabase/functions/_shared/xeroCardFees.ts');
  assert.deepEqual(src.match(/\.from\('adyen_payments'\)\.select\(([A-Z_a-z]+)\)/g), [".from('adyen_payments').select(CARD_FEE_COLS)"], 'one read, with that list');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /fee_breakdown|\bpercent|rate_category|\* 0\.0/, 'no cost of Adyen, no percentage, no estimate');
  assert.doesNotMatch(src, /from '[^']*adyen-webhook|from 'https?:/, 'no remote import, nothing from the webhook');
});

test('20. reading the fees: fenced to the venue, 200 references at a time, and a failed read throws', async () => {
  const w = refundDay();
  const args = { day: DAY, rows: w.loaded.rows, clearing: w.m.clearing };
  // The Platform location: by ops_location_id first, then by id; or the one handed in.
  const byOps = fakePlatform();
  const { account: _mapped, ...read1 } = w.fees;
  assert.deepEqual(await loadCardFees(byOps, 'leeds', args), read1, 'the fees as read: the account is the setup\'s, added by cardFeesFor');
  assert.deepEqual(byOps.calls.map((c) => [c.table, c.eq[0]]), [['locations', ['ops_location_id', 'leeds']], ['adyen_payments', ['location_id', 'platform-leeds']]]);
  const byId = fakePlatform({ byOps: false });
  assert.equal((await loadCardFees(byId, 'leeds', args)).charged, 43);
  assert.deepEqual(byId.calls.map((c) => [c.table, c.eq[0]]), [['locations', ['ops_location_id', 'leeds']], ['locations', ['id', 'leeds']], ['adyen_payments', ['location_id', 'platform-leeds']]]);
  const given = fakePlatform();
  assert.equal((await loadCardFees(given, 'leeds', { ...args, platformId: 'platform-leeds' })).charged, 43);
  assert.deepEqual(given.calls.map((c) => c.table), ['adyen_payments'], 'no location read when the id is known');
  assert.equal(given.calls[0].cols, CARD_FEE_COLS);
  assert.deepEqual([given.calls[0].in[0], [...given.calls[0].in[1]].sort()], ['psp_reference', [psp(1), psp(2), psp(3), psp(4)]], 'each reference once (the refund is of payment 1)');
  // Another venue's payment under the same reference is never read: the fence is the location.
  const other = fakePlatform({ payments: [...PAYMENTS.values()].map((p) => ({ ...p, location_id: 'platform-barnsley' })) });
  const fenced = await loadCardFees(other, 'leeds', { ...args, platformId: 'platform-leeds' });
  assert.deepEqual([fenced.charged, fenced.unknown.map((u) => [u.side, u.reason, u.count])], [0, [['sale', 'no_payment', 4], ['refund', 'no_payment', 1]]]);
  // 450 references: three reads, of 200, 200 and 50.
  const many = referenced(Array.from({ length: 450 }, (_, i) => ({ id: `m${i}`, closed_at: at(1 + (i % 20)), total: 3, tip: 0, service: 0, tax_amount: 0.5, tenders: [{ method: 'card', amount: 3, tip: 0, processor: 'adyen' }] })), 5000);
  const big = fakePlatform({ payments: payMap(many.refs, () => 7) });
  const got = await loadCardFees(big, 'leeds', { day: DAY, rows: { sale: many.rows, refund: [] }, clearing: w.m.clearing, platformId: 'platform-leeds' });
  assert.deepEqual(big.reads().map((c) => c.in[1].length), [200, 200, 50]);
  assert.deepEqual([got.charged, got.sales, got.unknown], [450 * 7, { count: 450, known: 450 }, []]);
  // No card money, or none with a reference: nothing is read at all.
  const quiet = fakePlatform();
  assert.deepEqual(await loadCardFees(quiet, 'leeds', { day: DAY, rows: { sale: [B], refund: [] }, clearing: w.m.clearing }), { charged: 0, returned: 0, cardSales: 0, cardRefunds: 0, sales: { count: 0, known: 0 }, refunds: { count: 0, known: 0 }, unknown: [] });
  const kiosk = { id: 'K', closed_at: at(4), total: 6.5, tip: 0, service: 0, tax_amount: 1.08, source: 'kiosk', payment_method: 'card-external', method: 'card' };
  assert.deepEqual((await loadCardFees(quiet, 'leeds', { day: DAY, rows: { sale: [kiosk], refund: [] }, clearing: w.m.clearing })).unknown, [{ side: 'sale', reason: 'no_reference', count: 1, amount: 650, checkIds: ['K'] }]);
  assert.deepEqual(quiet.calls, []);
  assert.deepEqual((await loadCardFees(quiet, 'leeds', { day: DAY, rows: null, clearing: w.m.clearing })).cardSales, 0);
  // A read that fails throws, in plain words. Never a day of "no fees".
  await assert.rejects(loadCardFees(fakePlatform({ fail: 'connection reset' }), 'leeds', { ...args, platformId: 'platform-leeds' }), { message: 'Could not read the card fees: connection reset' });
  await assert.rejects(loadCardFees(fakePlatform({ fail: 'connection reset' }), 'leeds', args), { message: "Could not read the card fees: Could not read the venue's name: connection reset" });
  await assert.rejects(loadCardFees(fakePlatform({ location: null }), 'leeds', args), { message: 'This venue has no card payments record, so its card fees cannot be read.' });
});

// ── 21 to 23: the wait ───────────────────────────────────────────────────────

test('21. the wait: only for a fee that can still arrive, until 16 hours after the day ended', () => {
  assert.equal(CARD_FEE_WAIT_MS, 16 * H);
  const missing = (list) => ({ unknown: list.map(([side, reason, count, amount]) => ({ side, reason, count, amount, checkIds: [] })) });
  const at5 = { dayEndMs: DAY.toMs, nowMs: DAY.toMs + 5 * H, timezone: UK.timezone };
  // The day ended at 06:00 on Wed 30 Sep (BST); the nightly run first tries at about 10:10.
  const w = cardFeesWait(missing([['sale', 'no_payment', 2, 760]]), at5);
  assert.deepEqual([w.code, w.untilMs, w.count, w.amount], ['card_fees_wait', DAY.toMs + 16 * H, 2, 760]);
  assert.equal(w.message, 'Waiting for card fees. 2 card payments have no fee from the card processor yet (7.60). ServOS tries again every hour. If they are still missing at 22:00 on Wed 30 Sep 2026, this day posts with the fees it has and says what is missing. Nothing has been posted yet.');
  assert.equal(cardFeesWait(missing([['sale', 'no_fee', 1, 380]]), at5).message, 'Waiting for card fees. 1 card payment has no fee from the card processor yet (3.80). ServOS tries again every hour. If it is still missing at 22:00 on Wed 30 Sep 2026, this day posts with the fees it has and says what is missing. Nothing has been posted yet.');
  // In winter (GMT), and for a venue whose day starts at 06:30 (the Coffee Boy sites): its own clock.
  const nov = businessDayWindow('2026-11-10', UK.timezone, '06:30');
  assert.match(cardFeesWait(missing([['refund', 'no_payment', 1, 100]]), { dayEndMs: nov.toMs, nowMs: nov.toMs + 4 * H, timezone: UK.timezone }).message, /still missing at 22:30 on Wed 11 Nov 2026, /);
  const ny = businessDayWindow(DATE, 'America/New_York', '04:00');
  assert.match(cardFeesWait(missing([['sale', 'no_payment', 3, 100]]), { dayEndMs: ny.toMs, nowMs: ny.toMs + H, timezone: 'America/New_York' }).message, /still missing at 20:00 on Wed 30 Sep 2026, /);
  // Nothing that can never arrive holds a day: it posts at once, with the warning.
  assert.equal(cardFeesWait(missing([['sale', 'no_reference', 38, 20000], ['sale', 'not_taken', 1, 500], ['refund', 'other_processor', 1, 100]]), at5), null);
  assert.equal(cardFeesWait(missing([]), at5), null);
  assert.equal(cardFeesWait(null, at5), null);
  // Mixed: it waits, and counts only what it is waiting for.
  const mixed = cardFeesWait(missing([['sale', 'no_reference', 38, 20000], ['sale', 'no_payment', 1, 450], ['refund', 'no_fee', 2, 300]]), at5);
  assert.deepEqual([mixed.count, mixed.amount], [3, 750]);
  // The whole of the wait, and not a minute more: 12 hourly tries after the first, 12 left to post.
  for (const h of [0, 4, 15.99]) assert.ok(cardFeesWait(missing([['sale', 'no_payment', 1, 1]]), { ...at5, nowMs: DAY.toMs + h * H }), `${h} h`);
  for (const h of [16, 16.5, 28, 400]) assert.equal(cardFeesWait(missing([['sale', 'no_payment', 1, 1]]), { ...at5, nowMs: DAY.toMs + h * H }), null, `${h} h`);
});

test('22. after the wait the day posts with the fees that are known, and one warning says what is missing', async () => {
  // Payment 2 (4.00) has no row, payment 3 (2.80) no fee yet, and a kiosk sale (6.50) has no reference.
  const kiosk = { id: 'K', closed_at: at(4), total: 6.5, tip: 0, service: 0, tax_amount: 1.08, source: 'kiosk', payment_method: 'card-external', method: 'card',
    items: [{ uid: 'k1', cat: 'cat-hot_1e945c26', itemId: 'm-k', qty: 1, price: 6.5, taxRateId: 'r20' }] };
  const payments = new Map([[psp(1), PAYMENTS.get(psp(1))], [psp(3), paymentRow(3, 280, null)], [psp(4), PAYMENTS.get(psp(4))]]);
  const w = dayOf([...REF.rows, kiosk], [], { payments });
  assert.deepEqual([w.fees.charged, w.fees.sales], [26, { count: 5, known: 2 }]);
  assert.deepEqual(w.fees.unknown.map((u) => [u.side, u.reason, u.count, u.amount]), [['sale', 'no_payment', 1, 400], ['sale', 'no_fee', 1, 280], ['sale', 'no_reference', 1, 650]]);
  const platform = () => fakePlatform({ payments });
  const ask = (nowMs, extra = {}) => cardFeesFor(platform(), { detailRow: null, mapping: w.m, locationId: 'leeds', loaded: w.loaded, venue: UK, site: { platformId: 'platform-leeds' }, nowMs, ...extra });
  // Inside the wait: the fees are read, and the day is told to wait for the two that can arrive.
  const early = await ask(DAY.toMs + 5 * H);
  assert.deepEqual([early.started, early.wait.count, early.wait.amount, early.cardFees.charged, early.cardFees.account], [null, 2, 680, 26, 'SOSFEES']);
  // At the end of it: no wait. The line is the known fees to the penny, never an invented one.
  const late = await ask(DAY.toMs + 16 * H);
  assert.equal(late.wait, null);
  assert.deepEqual(late.cardFees, w.fees);
  const p = plan(w.g, late.cardFees);
  assert.deepEqual([p.cardFees.line, p.cardFees.net, p.invoice.lines.at(-1).amount, p.blocked], [true, 26, -26, []]);
  assert.equal(p.invoice.lines.at(-1).amount, -(FEE.A + FEE.E));
  assert.deepEqual(warned(p, 'card_fees_missing'), [{ code: 'card_fees_missing', checkIds: ['C', 'D', 'K'],
    message: 'No card fee was found for 3 card payments (13.30). 1 of them has no card processor reference on the till record. The Card fees line leaves them out, so the card clearing account will be out by their fees. Check them under Card payments and put the difference right in Xero.' }]);
  assert.equal(sumBy(p.payments, (x) => x.amount), p.invoice.total);
  // A replace day whose old entries are being removed never waits, even inside the time.
  assert.equal((await ask(DAY.toMs + 5 * H, { noWait: true })).wait, null);
  // Only payments that can never have a fee: no wait at any time, the warning at once.
  const only = dayOf([E, kiosk]);
  assert.equal((await cardFeesFor(fakePlatform(), { detailRow: null, mapping: only.m, locationId: 'leeds', loaded: only.loaded, venue: UK, nowMs: DAY.toMs + H })).wait, null);
  assert.match(warned(plan(only.g, only.fees), 'card_fees_missing')[0].message, /^No card fee was found for 1 card payment \(6\.50\)\. It has no card processor reference on the till record\. The Card fees line leaves it out, /);
});

test('23. a waiting day is recorded, sends nothing, and posts by itself once the fee arrives or the time is up', async () => {
  const stamped = PAYMENTS;
  const unstamped = new Map([...PAYMENTS].filter(([k]) => k !== psp(2)));   // payment 2 (4.00) has no row yet
  const w = plainDay();
  await withXero(async (x) => {
    const sb = fakeTable();
    // 10:10, four hours after the day ended: the nightly run's first try.
    const first = await attempt(sb, w, 'W1', { platform: fakePlatform({ payments: unstamped }), nowMs: DAY.toMs + 4 * H });
    assert.equal(first.ok, false);
    assert.deepEqual(first.notReady.map((n) => n.code), ['card_fees_wait']);
    assert.equal(first.plan, null, 'no plan was made, nothing was recorded as started');
    assert.deepEqual(x.calls, [], 'nothing was sent to Xero, not even a lookup');
    let r = await readSyncRow(sb, KEY);
    assert.equal(r.status, 'error');
    assert.deepEqual(r.detail.postings, {});
    assert.deepEqual(r.detail.notReady, [{ code: 'card_fees_wait', message: first.e.message }]);
    assert.equal(r.detail.error, 'Waiting for card fees. 1 card payment has no fee from the card processor yet (4.00). ServOS tries again every hour. If it is still missing at 22:00 on Wed 30 Sep 2026, this day posts with the fees it has and says what is missing. Nothing has been posted yet.');
    assert.doesNotMatch(r.detail.error, /not ready/, 'the wait in its own words, never "This site is not ready"');
    assert.ok(!('cardFees' in r.detail) && !('refundWay' in r.detail), 'no way is on the row: the day is free');
    assert.equal(cardFeeWayStarted(r.detail), null);
    // The next hours: still waiting, still nothing sent, one row.
    const second = await attempt(sb, w, 'W2', { platform: fakePlatform({ payments: unstamped }), nowMs: DAY.toMs + 9 * H });
    assert.deepEqual([second.ok, second.notReady[0].code, x.calls.length, sb.rows.length], [false, 'card_fees_wait', 0, 1]);
    // The webhook lands (Adyen sent it again): the next try posts, with the whole fee.
    const third = await attempt(sb, w, 'W3', { platform: fakePlatform({ payments: stamped }), nowMs: DAY.toMs + 10 * H });
    assert.equal(third.ok, true, third.e?.message);
    assert.deepEqual(x.invoices.map((i) => i.Total), [27.58]);
    assert.deepEqual(x.payments.map((p) => [p.Reference, p.Amount]), [['SOS-LEEDS-20260929 Card', 22.67], ['SOS-LEEDS-20260929 Cash', 4.91]]);
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.notReady, r.detail.error, r.detail.cardFees.way, r.detail.cardFees.net], ['ok', null, null, 'on', 43]);
  });
  // Or it never lands: the first try after 22:00 posts with the fees that are known, and says so.
  await withXero(async (x) => {
    const sb = fakeTable();
    await attempt(sb, w, 'V1', { platform: fakePlatform({ payments: unstamped }), nowMs: DAY.toMs + 15 * H });
    assert.equal(x.calls.length, 0);
    const res = await attempt(sb, w, 'V2', { platform: fakePlatform({ payments: unstamped }), nowMs: DAY.toMs + 16 * H + 600000 });
    assert.equal(res.ok, true, res.e?.message);
    assert.deepEqual(x.invoices.map((i) => i.Total), [27.67], '28.01 less the 0.34 of fees that are known');
    assert.equal(x.invoices[0].sent.LineItems.at(-1).UnitAmount, -0.34);
    const r = await readSyncRow(sb, KEY);
    assert.deepEqual(r.detail.warnings.filter((x2) => x2.code === 'card_fees_missing').map((x2) => x2.message), ['No card fee was found for 1 card payment (4.00). The Card fees line leaves it out, so the card clearing account will be out by its fee. Check it under Card payments and put the difference right in Xero.']);
    assert.deepEqual(r.detail.cardFees.unknown, [{ side: 'sale', reason: 'no_payment', count: 1, amount: 400, checkIds: ['C'] }]);
  });
  // A Platform read that fails is an ERROR, not a wait: nothing sent, the words on the row, and
  // the next hourly try reads again.
  await withXero(async (x) => {
    const sb = fakeTable();
    const down = await attempt(sb, w, 'D1', { platform: fakePlatform({ fail: 'connection reset' }) });
    assert.deepEqual([down.ok, down.notReady, down.error, x.calls.length], [false, null, 'Could not read the card fees: connection reset', 0]);
    const r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.error, r.detail.notReady, r.detail.postings], ['error', 'Could not read the card fees: connection reset', null, {}]);
    assert.equal((await attempt(sb, w, 'D2')).ok, true);
    assert.deepEqual(x.invoices.map((i) => i.Total), [27.58]);
  });
});

// ── 24 to 32: a day is never mixed ───────────────────────────────────────────

test('24. cardFeeWayStarted: free exactly when the refund way is free; a marker alone is not a start', () => {
  const sending = { status: 'sending' }, done = { status: 'posted', id: 'x' };
  const marker = { way: 'on', at: AT, account: 'SOSFEES', line: true, reason: null, net: 43, charged: 43, returned: 0, cardSales: 2310, cardRefunds: 0, unknown: [] };
  // Free: no row, a blocked or waiting attempt that sent nothing, a marker left over with nothing
  // sent, the older bank transaction keys only, and an invoice Xero refused for another cause.
  for (const d of [null, undefined, {}, { postings: {} }, { cardFees: marker, postings: {} }, { cardFees: marker, refundWay: 'lines', postings: {} }, { cardFees: marker, notReady: [{ code: 'card_fees_wait' }], postings: {} },
    { cardFees: marker, postings: { 'RECEIVE:a': done, 'SPEND:a': { status: 'deleted' } } },
    { cardFees: marker, refundWay: null, postings: { INVOICE: { status: 'sending', refusedNotLines: { at: AT, words: 'A lock date.' } } } }]) {
    assert.equal(cardFeeWayStarted(d), null, JSON.stringify(d));
  }
  // Started WITHOUT: any record of the sales invoice and no marker. That is every day sent before 13 Oct 2026.
  for (const d of [{ postings: { INVOICE: sending } }, { postings: { INVOICE: done, 'PAY:CARDCLR': done } }, { refundWay: 'lines', postings: { INVOICE: done } }, { postings: { CREDIT: sending } },
    { postings: { 'REFUND:CARDCLR': done } }, { cardFees: null, postings: { INVOICE: done } }, { cardFees: { way: 'off' }, postings: { INVOICE: done } }, { cardFees: { ...marker, way: undefined }, postings: { 'PAY:CARDCLR': sending } }]) {
    assert.equal(cardFeeWayStarted(d), 'off', JSON.stringify(d));
  }
  // Started WITH: a record and the marker.
  for (const d of [{ cardFees: marker, postings: { INVOICE: sending } }, { cardFees: marker, refundWay: 'lines', postings: { INVOICE: done, 'PAY:CARDCLR': sending } }, { cardFees: marker, refundWay: 'credit_note', postings: { INVOICE: done, CREDIT: sending } },
    { cardFees: marker, refundWay: 'lines', refundLinesRefused: { at: AT, message: 'm' }, postings: { INVOICE: sending } }]) {
    assert.equal(cardFeeWayStarted(d), 'on', JSON.stringify(d));
  }
  // Free exactly when the refund way is.
  const rows = [null, {}, { postings: { INVOICE: sending } }, { refundWay: 'lines', postings: { INVOICE: done } }, { postings: { CREDIT: done } }, { refundWay: 'lines', refundLinesRefused: { at: AT }, postings: { INVOICE: sending } },
    { postings: { INVOICE: { status: 'sending', refusedNotLines: { at: AT, words: 'w' } } } }, { postings: { 'RECEIVE:a': done } }, { refundWay: 'credit_note', postings: {} }];
  for (const d of rows) for (const cardFees of [undefined, marker]) {
    const row2 = d ? { ...d, cardFees } : d;
    assert.equal(cardFeeWayStarted(row2) === null, refundWayStarted(row2) === null, JSON.stringify(row2));
  }
  // What is recorded: a first plan with fees writes the marker and the figures; a started day keeps its own.
  const w = plainDay();
  const p = plan(w.g, w.fees);
  assert.deepEqual(cardFeesToRecord(null, undefined, w.fees, p, AT), { way: 'on', at: AT, account: 'SOSFEES', line: true, reason: null, net: 43, ...w.fees });
  assert.deepEqual(cardFeesPatch(null, undefined, w.fees, p, AT), { cardFees: { way: 'on', at: AT, account: 'SOSFEES', line: true, reason: null, net: 43, ...w.fees } });
  assert.equal(cardFeesToRecord('on', marker, { ...w.fees, charged: 99 }, p, 'later'), marker, 'what was started stands, to the letter');
  assert.deepEqual(cardFeesPatch('on', marker, marker, p, 'later'), { cardFees: marker });
  assert.equal(cardFeesToRecord('off', undefined, null, p, AT), null);
  assert.deepEqual(cardFeesPatch(null, marker, null, plan(w.g, null), AT), { cardFees: null }, 'a marker left on a free day is cleared');
  assert.deepEqual(cardFeesPatch(null, null, null, plan(w.g, null), AT), { cardFees: null });
});

test('25. a half posted day WITH fees finishes with the figures on its row: no fee is read again', async () => {
  const w = refundDay();
  let failed = false;
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, w, 'A1');
    assert.equal(first.ok, false);
    assert.equal(first.platform.reads().length, 1, 'the first attempt read the fees');
    let r = await readSyncRow(sb, KEY);
    assert.equal(r.status, 'partial');
    assert.deepEqual(posted(r), [['INVOICE', 'posted', 23.84], ['PAY:CARDCLR', 'sending', 18.93]]);
    assert.deepEqual([r.detail.refundWay, cardFeeWayStarted(r.detail)], ['lines', 'on']);
    assert.deepEqual(r.detail.cardFees, { way: 'on', at: AT, account: 'SOSFEES', line: true, reason: null, net: 37, ...w.fees }, 'the marker AND the figures are on the row');
    assert.equal(r.detail.postings.INVOICE.payload.LineItems.at(-1).Description, 'Card fees');
    // Since then the fees moved (a webhook replay restamped two payments) and card fees were even
    // switched off in the setup. Read fresh, the day would no longer be the invoice Xero holds.
    const moved = withPay(PAYMENTS, paymentRow(1, 830, 30), paymentRow(4, 800, 1));
    const fresh = { ...sumCardFees(w.items, moved), account: 'SOSFEES' };
    assert.notEqual(fresh.charged - fresh.returned, 37);
    assert.deepEqual(retryConflicts(plan(w.g, fresh, { started: 'lines' }), r.detail.postings).map((c) => c.code), ['posted_amount_changed'], 'this is why the figures are kept, not only the way');
    assert.deepEqual(retryConflicts(plan(w.g, r.detail.cardFees, { started: 'lines' }), r.detail.postings), []);
    x.calls.length = 0;
    const second = await attempt(sb, w, 'A2', { platform: fakePlatform({ payments: moved }), m: mapping({ cardFees: { enabled: false, account: 'SOSFEES' } }) });
    assert.equal(second.ok, true, second.e?.message);
    assert.deepEqual([second.started, second.cf.started, second.cf.wait], ['lines', 'on', null]);
    assert.deepEqual(second.platform.calls, [], 'no read at all');
    assert.deepEqual(second.cf.cardFees, r.detail.cardFees);
    assert.deepEqual(x.puts(), ['PUT /Payments', 'PUT /Payments'], 'only what was still to send: the card payment and the cash payment');
    assert.deepEqual(x.invoices.map((i) => i.Total), [23.84]);
    assert.deepEqual(x.payments.map((p) => [p.Reference, p.Amount]), [['SOS-LEEDS-20260929 Card', 18.93], ['SOS-LEEDS-20260929 Cash', 4.91]]);
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.cardFees.net, r.detail.cardFees.at], ['ok', 37, AT]);
    // A third push: already done, nothing read, nothing sent.
    assert.equal((await attempt(sb, w, 'A3')).already, true);
  }, { refuse: (method, where, body) => (method === 'PUT' && where === '/Payments' && /Card$/.test(body.Payments[0].Reference) && !failed ? (failed = true, new Response('Service Unavailable', { status: 503 })) : null) });
});

test('26. a day started WITHOUT fees finishes without them; a day started WITH them keeps its line and its account', async () => {
  const w = plainDay({ m: mapping() });
  // Card fees were off when the invoice went (28.01, no marker); the card payment failed.
  let failed = false;
  await withXero(async (x) => {
    const sb = fakeTable();
    assert.equal((await attempt(sb, w, 'B1')).ok, false);
    let r = await readSyncRow(sb, KEY);
    assert.deepEqual(posted(r), [['INVOICE', 'posted', 28.01], ['PAY:CARDCLR', 'sending', 23.1]]);
    assert.ok(!('cardFees' in r.detail));
    assert.equal(cardFeeWayStarted(r.detail), 'off');
    // Card fees are switched on. The day finishes as it was started: no line, the gross card payment.
    x.calls.length = 0;
    const second = await attempt(sb, w, 'B2', { m: mOn() });
    assert.equal(second.ok, true, second.e?.message);
    assert.deepEqual([second.cf.cardFees, second.cf.started, second.platform.calls], [null, 'off', []]);
    assert.ok(!('cardFees' in second.plan));
    assert.deepEqual(x.puts(), ['PUT /Payments', 'PUT /Payments']);
    assert.deepEqual(x.invoices.map((i) => i.Total), [28.01]);
    assert.ok(x.invoices[0].sent.LineItems.every((l) => l.Description !== 'Card fees'));
    assert.deepEqual(x.payments.map((p) => p.Amount), [23.1, 4.91]);
    r = await readSyncRow(sb, KEY);
    assert.ok(r.status === 'ok' && !('cardFees' in r.detail), 'still no key on the row');
  }, { refuse: (method, where, body) => (method === 'PUT' && where === '/Payments' && /Card$/.test(body.Payments[0].Reference) && !failed ? (failed = true, new Response('Service Unavailable', { status: 503 })) : null) });
  // The reverse: started with fees; then switched off, or the account cleared, or another chosen.
  for (const later of [mapping(), mapping({ cardFees: { enabled: false } }), mapping({ cardFees: { enabled: true, account: 'OTHERFEES' } })]) {
    let once = false;
    const on = plainDay();
    await withXero(async (x) => {
      const sb = fakeTable();
      assert.equal((await attempt(sb, on, 'C1')).ok, false);
      const second = await attempt(sb, on, 'C2', { m: later });
      assert.equal(second.ok, true, second.e?.message);
      assert.deepEqual([second.cf.started, second.platform.calls.length, second.plan.cardFees.account], ['on', 0, 'SOSFEES']);
      assert.deepEqual(second.plan.invoice.payload.LineItems.at(-1).AccountCode, 'SOSFEES', 'the account it was sent with');
      assert.deepEqual(x.invoices.map((i) => i.Total), [27.58]);
      assert.equal(x.puts().filter((c) => c === 'PUT /Invoices').length, 1, 'never a second invoice');
      assert.deepEqual(x.payments.map((p) => p.Amount), [22.67, 4.91]);
    }, { refuse: (method, where, body) => (method === 'PUT' && where === '/Payments' && /Card$/.test(body.Payments[0].Reference) && !once ? (once = true, new Response('Service Unavailable', { status: 503 })) : null) });
  }
});

test('27. a marker left on a free day is cleared when the day is planned without fees', async () => {
  // A first attempt with card fees on was blocked after it recorded the way (nothing was sent).
  // Card fees are then switched off, and the day is pushed.
  const w = plainDay();
  const left = cardFeesToRecord(null, undefined, w.fees, plan(w.g, w.fees), AT);
  const seed = { status: 'error', detail: { model: 'sales_invoice', history: [], postings: {}, refundWay: null, cardFees: left, error: 'A rate with no Xero rate.' } };
  assert.equal(cardFeeWayStarted(seed.detail), null);
  await withXero(async (x) => {
    const sb = fakeTable(seed);
    const res = await attempt(sb, w, 'F1', { m: mapping({ cardFees: { enabled: false, account: 'SOSFEES' } }) });
    assert.equal(res.ok, true, res.e?.message);
    assert.deepEqual([res.cf.cardFees, res.cf.started, res.platform.calls], [null, null, []]);
    const r = await readSyncRow(sb, KEY);
    assert.equal(r.detail.cardFees, null, 'cleared in the same save as refundWay');
    assert.equal(cardFeeWayStarted(r.detail), 'off', 'the invoice is in Xero without the line, and the row can never say otherwise');
    assert.deepEqual(x.invoices.map((i) => i.Total), [28.01]);
    assert.equal(historyFeeNote(asHistory(r)), '');
  });
  // Left as it was, the same row would have read as started with fees the moment the invoice went.
  assert.equal(cardFeeWayStarted({ ...seed.detail, postings: { INVOICE: { status: 'posted', id: 'i' } } }), 'on');
});

test('28. a lost answer with fees: the invoice is found by its number at the net total, never sent twice', async () => {
  const w = refundDay();
  let lost = false;
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, w, 'L1');
    assert.equal(first.ok, false);
    let r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, posted(r), cardFeeWayStarted(r.detail)], ['error', [['INVOICE', 'sending', 23.84]], 'on']);
    assert.equal(historyFeeNote(asHistory(r)), '', 'nothing is confirmed in Xero yet');
    const idem = r.detail.postings.INVOICE.idem;
    const second = await attempt(sb, w, 'L2', { platform: fakePlatform({ payments: withPay(PAYMENTS, paymentRow(1, 830, 30)) }) });
    assert.equal(second.ok, true, second.e?.message);
    assert.deepEqual(second.platform.calls, []);
    assert.equal(stepIdempotencyKey('leeds', DATE, planSteps(second.plan)[0]), idem, 'planned again with the stored figures, the invoice is the very same request');
    assert.equal(x.puts().filter((c) => c === 'PUT /Invoices').length, 1);
    assert.deepEqual(x.invoices.map((i) => i.Total), [23.84]);
    assert.deepEqual(x.payments.map((p) => p.Amount), [18.93, 4.91]);
    r = await readSyncRow(sb, KEY);
    assert.equal(r.status, 'ok');
    assert.equal(historyFeeNote(asHistory(r)), 'Card fees 0.37 are on the invoice as a minus line, and the card payment is net of them.');
    assert.equal(historyRefundNote(asHistory(r)), 'Refunds are on the invoice as minus lines.');
  }, { lose: (method, where) => (method === 'PUT' && where === '/Invoices' && !lost ? (lost = true) : false) });
});

test('29. a day already posted is never touched, and reads as changed only when it has', async () => {
  const doc = (key, type, number, reference, total, xeroId) => ({ key, type, number, reference, total, xeroId, status: 'AUTHORISED', link: null });
  const w = plainDay();
  const asked = (detailRow, m, payments = PAYMENTS, loaded = w.loaded) => {
    const platform = fakePlatform({ payments });
    return cardFeesFor(platform, { detailRow, storedOnly: true, mapping: m, locationId: 'leeds', loaded, venue: UK, site: { platformId: 'platform-leeds' } }).then((cf) => ({ cf, platform }));
  };
  // Posted WITHOUT card fees (28.01). Card fees are switched on afterwards.
  const oldDocs = [doc('INVOICE', 'invoice', 'SOS-LEEDS-20260929', 'r', 28.01, 'inv-1'), doc('PAY:CARDCLR', 'payment', null, 'SOS-LEEDS-20260929 Card', 23.1, 'p1'), doc('PAY:CASHTILL', 'payment', null, 'SOS-LEEDS-20260929 Cash', 4.91, 'p2')];
  const oldRow = { status: 'ok', detail: { model: 'sales_invoice', documents: oldDocs, postings: Object.fromEntries(oldDocs.map((d) => [d.key, { status: 'posted', id: d.xeroId, total: d.total }])) } };
  const a = await asked(oldRow.detail, mOn());
  assert.deepEqual([a.cf.cardFees, a.cf.started, a.platform.calls], [null, 'off', []]);
  assert.deepEqual(cardFeesForCompare(a.cf.cardFees, null), { cardFees: null, words: '' });
  assert.deepEqual(postedDayChanges(plan(withCardFees(w.g, a.cf.cardFees), undefined, { started: refundWayStarted(oldRow.detail) }), oldDocs), [], 'it does not read as changed');
  // Planned with today's setup instead, it would have: this is why a posted day reads only its own row.
  assert.deepEqual(postedDayChanges(plan(w.g, w.fees), oldDocs), ['SOS-LEEDS-20260929: posted 28.01, now 27.58']);
  // A row with nothing on it but its status (never the case for a sales invoice day) reads nothing either.
  assert.deepEqual((await asked({ model: 'sales_invoice' }, mOn())).platform.calls, []);
  // Posted WITH card fees (27.58).
  const marker = cardFeesToRecord(null, undefined, w.fees, plan(w.g, w.fees), AT);
  const newDocs = [doc('INVOICE', 'invoice', 'SOS-LEEDS-20260929', 'r', 27.58, 'inv-2'), doc('PAY:CARDCLR', 'payment', null, 'SOS-LEEDS-20260929 Card', 22.67, 'p3'), doc('PAY:CASHTILL', 'payment', null, 'SOS-LEEDS-20260929 Cash', 4.91, 'p4')];
  const newRow = { status: 'ok', detail: { model: 'sales_invoice', documents: newDocs, refundWay: null, cardFees: marker, postings: Object.fromEntries(newDocs.map((d) => [d.key, { status: 'posted', id: d.xeroId, total: d.total }])) } };
  // Asked with card fees since switched OFF: still compared with what it was posted with.
  const b = await asked(newRow.detail, mapping());
  assert.deepEqual([b.cf.cardFees, b.cf.started, b.platform.calls], [marker, 'on', []]);
  const compare = (fresh) => {
    const c = cardFeesForCompare(marker, fresh);
    return { ...c, changed: postedDayChanges(plan(withCardFees(w.g, c.cardFees), undefined, { started: refundWayStarted(newRow.detail) }, mapping()), newDocs) };
  };
  // Nothing has changed: no false alarm, of either kind.
  assert.deepEqual(compare({ ...w.fees }), { cardFees: marker, words: '', changed: [] });
  // The fresh read failed: the comparison goes on with the stored figures.
  assert.deepEqual(compare(null), { cardFees: marker, words: '', changed: [] });
  // A fee was restamped since (same sales): said in its OWN sentence, and not as checks that arrived later.
  const restamped = { ...sumCardFees(w.items, withPay(PAYMENTS, paymentRow(4, 800, 20))), account: 'SOSFEES' };
  const r1 = compare(restamped);
  assert.deepEqual([r1.cardFees, r1.changed], [marker, []]);
  assert.equal(r1.words, 'The card fees of this day now come to 0.50; 0.43 was posted. The difference is not in Xero. Adjust it there.');
  assert.equal(cardFeesChangedWords(marker, { ...w.fees }), '');
  assert.equal(cardFeesChangedWords({ ...marker, line: false, reason: 'card_short' }, restamped), '', 'a day that posted no fee line has no posted figure to compare');
  assert.equal(cardFeesChangedWords(null, restamped), '');
  // A check arrived later (8.00 by card, fee 0.13): the day as it comes to now carries that
  // check AND its fee, so the difference named is the money that is not in Xero.
  const late = { ...E, id: 'LATE', tenders: [{ method: 'card', amount: 8.0, tip: 0, processor: 'adyen', psp_ref: tillRef(60) }] };
  const more = dayOf([...REF.rows, late], [], { payments: withPay(PAYMENTS, paymentRow(60, 800, 13)) });
  const c = cardFeesForCompare(marker, more.fees);
  assert.deepEqual([c.cardFees.charged, c.cardFees.cardSales, c.cardFees.account], [56, 3110, 'SOSFEES']);
  assert.deepEqual(postedDayChanges(plan(withCardFees(more.g, c.cardFees), undefined, { started: null }, mapping()), newDocs), ['SOS-LEEDS-20260929: posted 27.58, now 35.45']);
  assert.equal(c.words, 'The card fees of this day now come to 0.56; 0.43 was posted. The difference is not in Xero. Adjust it there.');
  // The claim itself: an ok row is handed back as done, and nothing is planned or sent.
  await withXero(async (x) => {
    const sb = fakeTable(newRow);
    const res = await attempt(sb, w, 'Z1');
    assert.deepEqual([res.already, x.calls], [true, []]);
  });
});

test('30. the Postings history: an old day says nothing new, a day with the line says so once it is in Xero', () => {
  const w = plainDay();
  const p = plan(w.g, w.fees);
  const marker = cardFeesToRecord(null, undefined, w.fees, p, AT);
  const invoice = (status, payload = p.invoice.payload) => ({ status, type: 'invoice', id: status === 'posted' ? 'inv-1' : null, number: 'SOS-LEEDS-20260929', total: 27.58, payload });
  const day = (cardFees, postings) => ({ refundWay: null, postings, ...(cardFees ? { cardFees: cardFeesView(cardFees) } : {}) });
  const NOTE = 'Card fees 0.43 are on the invoice as a minus line, and the card payment is net of them.';
  assert.equal(historyFeeNote(day(marker, { INVOICE: invoice('posted'), 'PAY:CARDCLR': { status: 'posted' } })), NOTE);
  assert.equal(historyFeeNote(day(marker, { INVOICE: invoice('posted'), 'PAY:CARDCLR': { status: 'sending' } })), NOTE, 'partly posted: the invoice is in Xero');
  assert.equal(historyFeeNote(day(marker, { INVOICE: invoice('sending') })), '', 'refused by Xero, or the answer lost');
  assert.equal(historyFeeNote(day(marker, {})), '', 'waiting, or blocked before anything was sent');
  assert.equal(historyFeeNote(day(marker, null)), '');
  // A day sent before this, or with card fees off: no marker, no note, and its documents as before.
  const oldRow = { postings: { INVOICE: { status: 'posted', id: 'inv-0', number: 'SOS-LEEDS-20260929', total: 28.01 }, 'PAY:CARDCLR': { status: 'posted', id: 'p', reference: 'SOS-LEEDS-20260929 Card', total: 23.1 } } };
  assert.equal(historyFeeNote(oldRow), '');
  assert.equal(historyFeeNote({ ...oldRow, cardFees: null }), '');
  assert.equal(historyFeeNote(null), '');
  assert.deepEqual(historyDocs({ ...oldRow, documents: null }, null).map((d) => [d.type, d.number, d.total]), [['invoice', 'SOS-LEEDS-20260929', 28.01], ['payment', 'SOS-LEEDS-20260929 Card', 23.1]]);
  assert.deepEqual(historyDocs({ ...oldRow, documents: null, cardFees: marker }, null), historyDocs({ ...oldRow, documents: null }, null), 'the marker changes nothing about the documents');
  // More fee back than charged: a plus line.
  assert.equal(historyFeeNote(day({ ...marker, net: -48, charged: 2, returned: 50 }, { INVOICE: { status: 'posted' } })), 'Card fees returned 0.48 are on the invoice as a plus line, and the card payment includes them.');
  // A day that could not carry the line.
  const short = { ...marker, line: false, reason: 'card_short' };
  assert.equal(historyFeeNote(day(short, { INVOICE: invoice('posted', plan(w.g, null).invoice.payload) })), 'Card fees were not put on this invoice. The warnings below say why.');
  assert.equal(historyFeeNote(day({ ...marker, line: false, reason: 'none', net: 0 }, { INVOICE: { status: 'posted' } })), '', 'no fees that day: nothing to say');
  // What the note says comes from the invoice AS IT WAS SENT when the row kept it: a marker that
  // says otherwise (a day replanned between attempts) never makes the note untrue.
  assert.equal(historyFeeNote(day(short, { INVOICE: invoice('posted') })), NOTE);
  assert.equal(historyFeeNote(day(marker, { INVOICE: invoice('posted', plan(w.g, null).invoice.payload) })), '');
  // A sales group that happens to be called "Card fees" is not the fee line (it carries VAT, and is on another account).
  const lookalike = { ...p.invoice.payload, LineItems: [{ Description: 'Card fees', Quantity: 1, UnitAmount: 5, AccountCode: '201', TaxType: 'OUTPUT2', TaxAmount: 0.83 }] };
  assert.equal(historyFeeNote(day(short, { INVOICE: invoice('posted', lookalike) })), 'Card fees were not put on this invoice. The warnings below say why.');
  // history_detail hands the marker on in major units, and only when the row has one.
  assert.deepEqual(cardFeesView(marker), { way: 'on', at: AT, line: true, reason: null, account: 'SOSFEES', charged: 0.43, returned: 0, net: 0.43, cardSales: 23.1, cardRefunds: 0, sales: { count: 4, known: 4 }, refunds: { count: 0, known: 0 }, unknown: [] });
  assert.deepEqual(cardFeesView({ ...marker, unknown: [{ side: 'sale', reason: 'no_payment', count: 1, amount: 400, checkIds: ['C'] }] }).unknown, [{ side: 'sale', reason: 'no_payment', count: 1, amount: 4, checkIds: ['C'] }]);
  assert.equal(cardFeesView(null), null);
  assert.match(read('supabase/functions/xero-config/index.ts'), /\.\.\.\(d\.cardFees \? \{ cardFees: cardFeesView\(d\.cardFees\) \} : \{\}\),/);
});

test('31. replace day: the preview is net of fees, a wait refuses it before anything is removed, and it never waits after', async () => {
  const w = refundDay();
  const unstamped = new Map([...PAYMENTS].filter(([k]) => k !== psp(2)));
  // The day is in Xero the old way: bank transactions only.
  const bank = { model: 'bank_tx', lines: [], warnings: [], postings: { 'RECEIVE:acc': { status: 'posted', id: 'bt-1', reference: 'ServOS takings 2026-09-29', total: 28.01 }, 'SPEND:acc': { status: 'posted', id: 'bt-2', reference: 'ServOS refunds 2026-09-29', total: 3.8 } } };
  assert.equal(cardFeeWayStarted(bank), null, 'only the old bank transactions: free');
  const ask = (detailRow, payments, extra = {}) => cardFeesFor(fakePlatform({ payments }), { detailRow, mapping: w.m, locationId: 'leeds', loaded: w.loaded, venue: UK, site: { platformId: 'platform-leeds' }, nowMs: DAY.toMs + 5 * H, ...extra });
  // The preview: the invoice that would be sent, net of the day's refunds and fees.
  const ready = await ask(bank, PAYMENTS);
  assert.equal(ready.wait, null);
  const p = plan(withCardFees(w.g, ready.cardFees), undefined, { started: refundWayStarted(bank) });
  assert.deepEqual(previewView({ plan: p }).invoice, { number: 'SOS-LEEDS-20260929', total: 23.84 });
  assert.equal(previewView({ plan: p }).canReplace, true);
  // A fee is still awaited: it is a problem in the preview, so the replace cannot be confirmed.
  const waiting = await ask(bank, unstamped);
  assert.equal(waiting.wait.code, 'card_fees_wait');
  assert.deepEqual(previewView({ plan: p, problems: [waiting.wait.message] }).canReplace, false);
  // The real run refuses up front, before the old entries are touched (xero-sales, in this order).
  const replace = read('supabase/functions/xero-sales/index.ts');
  const run = replace.slice(replace.indexOf('async function replaceDay('), replace.indexOf('Deno.serve('));
  const order = ["const cf = await cardFeesFor(platform, { detailRow: run.detail, mapping, locationId, loaded, venue, site, nowMs: Date.now(), noWait: !!run.detail?.replace });",
    'if (cf.wait) throw new NotReadyError([{ code: cf.wait.code, message: cf.wait.message }]);', 'const res = await removeOldDay(run, api, { by: user });'].map((s) => run.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], `the wait is thrown before anything is removed: ${order}`);
  // Once the replace has its record on the row (old entries being removed, or gone) it never waits.
  const deleting = { ...bank, postings: Object.fromEntries(Object.entries(bank.postings).map(([k, v]) => [k, { ...v, status: 'deleted' }])),
    replace: { state: 'deleting', by: { id: 'u1' }, at: AT, old: [], was: { status: 'ok', lines: [], warnings: [] } } };
  assert.equal(cardFeeWayStarted(deleting), null);
  const mid = await ask(deleting, unstamped, { noWait: !!deleting.replace });
  assert.deepEqual([mid.wait, mid.cardFees.charged, mid.cardFees.unknown.map((u) => u.reason)], [null, 34, ['no_payment']]);
  // After the last one is gone the day is free, and takes its card fees by the setup as it is then.
  const after = { ...deleting, ...allDeletedPatch(deleting, AT) };
  assert.deepEqual([after.postings, after.replace.state, cardFeeWayStarted(after)], [{}, 'deleted', null]);
  const then = await ask(after, PAYMENTS, { noWait: !!after.replace });
  assert.deepEqual([then.wait, then.started, then.cardFees.charged, then.cardFees.returned], [null, null, 43, 6]);
  assert.equal((await ask(after, PAYMENTS, { mapping: mapping() })).cardFees, null, 'card fees off: none');
  // And the invoice day that follows writes the marker like any other.
  await withXero(async (x) => {
    const sb = fakeTable({ status: 'error', detail: { ...after, history: [] } });
    const res = await attempt(sb, w, 'R1', { platform: fakePlatform({ payments: unstamped }), nowMs: DAY.toMs + 5 * H });
    assert.equal(res.ok, true, res.e?.message);
    assert.equal(res.cf.wait, null, 'inside the time, and it did not wait');
    assert.deepEqual(x.invoices.map((i) => i.Total), [23.93], '28.01 less 3.80 less the 0.28 of fees that are known');
    assert.equal((await readSyncRow(sb, KEY)).detail.cardFees.way, 'on');
  });
});

test('32. Xero refuses the invoice: the refund lines ladder still holds, and a day with nothing in Xero is free again', async () => {
  const WHY = "Account code 'SOSFEES' is not a valid code for this document.";
  // (a) With refund lines AND a fee line. First the refund lines are blamed, then the invoice is
  // refused without them too, so the day is free: fees are read afresh once the cause is put right.
  let broken = true;
  const w = refundDay();
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, w, 'M1');
    assert.deepEqual([first.started, first.plan.refundWay, first.plan.cardFees.line, first.refusal], [null, 'lines', true, 'lines']);
    let r = await readSyncRow(sb, KEY);
    assert.deepEqual([refundWayStarted(r.detail), cardFeeWayStarted(r.detail)], ['refused', 'on']);
    const second = await attempt(sb, w, 'M2');
    assert.deepEqual([second.started, second.plan.refundWay, second.plan.refundWayReason, second.cf.started, second.platform.calls.length, second.refusal], ['refused', 'credit_note', 'xero_refused', 'on', 0, 'other']);
    assert.equal(second.plan.invoice.lines.at(-1).description, 'Card fees', 'the fee line goes with the day whichever way its refunds go');
    assert.equal(second.error, `Xero did not take this day: ${WHY} Nothing was posted. Put that right, then push again.`);
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([refundWayStarted(r.detail), cardFeeWayStarted(r.detail)], [null, null], 'free again, for its refunds and for its fees');
    assert.equal(r.detail.cardFees.way, 'on', 'the marker is still on the row, and is ignored');
    assert.equal(x.invoices.length + x.creditNotes.length + x.payments.length, 0);
    // Still broken: read afresh, tried with its refund lines, refused in the same words, still free.
    const third = await attempt(sb, w, 'M3');
    assert.deepEqual([third.started, third.cf.started, third.platform.reads().length, third.plan.refundWay, third.refusal], [null, null, 1, 'lines', 'other']);
    assert.equal(cardFeeWayStarted((await readSyncRow(sb, KEY)).detail), null);
    // The account is put right in Xero: the day posts, refunds and fees on the invoice.
    broken = false;
    const fourth = await attempt(sb, w, 'M4');
    assert.equal(fourth.ok, true, fourth.e?.message);
    assert.deepEqual(x.invoices.map((i) => i.Total), [23.84]);
    assert.deepEqual([x.creditNotes.length, x.payments.map((p) => p.Amount)], [0, [18.93, 4.91]]);
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.refundWay, cardFeeWayStarted(r.detail)], ['ok', 'lines', 'on']);
  }, { refuse: (method, where) => (broken && method === 'PUT' && where === '/Invoices' ? xero400(WHY) : null) });
  // (b) No refund lines, a fee line: Xero's own words on the row, and the day is free, so the
  // person can pick another account (or switch card fees off) and push again.
  const plain = plainDay();
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, plain, 'N1');
    assert.deepEqual([first.ok, first.e.status, first.plan.refundWay, first.refusal], [false, 400, null, 'other']);
    assert.equal(first.error, `Xero did not take this day: ${WHY} Nothing was posted. Put that right, then push again.`);
    let r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.error, posted(r)], ['error', first.error, [['INVOICE', 'sending', 27.58]]]);
    assert.equal(r.detail.postings.INVOICE.refusedNotLines.words, WHY);
    assert.ok(r.detail.postings.INVOICE.payload.LineItems.some((l) => l.Description === 'Card fees'), 'the row still shows exactly what was sent');
    assert.deepEqual([refundWayStarted(r.detail), cardFeeWayStarted(r.detail)], [null, null]);
    // Another account is chosen under Setup, and the day is pushed again.
    const second = await attempt(sb, plain, 'N2', { m: mOn({ cardFees: { enabled: true, account: 'FEES2' } }) });
    assert.equal(second.ok, true, second.e?.message);
    assert.deepEqual([second.cf.started, second.platform.reads().length], [null, 1]);
    assert.equal(x.invoices[0].sent.LineItems.at(-1).AccountCode, 'FEES2');
    assert.deepEqual(x.invoices.map((i) => i.Total), [27.58]);
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.cardFees.account, r.detail.postings.INVOICE.refusedNotLines], ['ok', 'FEES2', undefined]);
  }, { refuse: (method, where, body) => (method === 'PUT' && where === '/Invoices' && body.Invoices[0].LineItems.some((l) => l.AccountCode === 'SOSFEES') ? xero400(WHY) : null) });
  // Or card fees are switched off for good: the same day then posts without the line.
  await withXero(async (x) => {
    const sb = fakeTable();
    await attempt(sb, plain, 'P1');
    const second = await attempt(sb, plain, 'P2', { m: mapping() });
    assert.equal(second.ok, true, second.e?.message);
    assert.deepEqual(x.invoices.map((i) => i.Total), [28.01]);
    assert.equal((await readSyncRow(sb, KEY)).detail.cardFees, null);
  }, { refuse: (method, where, body) => (method === 'PUT' && where === '/Invoices' && body.Invoices[0].LineItems.some((l) => l.AccountCode === 'SOSFEES') ? xero400(WHY) : null) });
  // The rule on its own. Without a fee line a day with no refund lines goes on exactly as before.
  const alone = { INVOICE: { status: 'sending' } };
  const err = (words, status = 400) => ({ status, message: `Xero API /Invoices failed: ${status} ${JSON.stringify({ Elements: [{ ValidationErrors: [{ Message: words }] }] })}`, words });
  const withLine = plan(plain.g, plain.fees), noLine = plan(plain.g, null);
  assert.equal(invoiceRefusal(noLine, { postings: alone, error: err('A') }), null);
  assert.equal(invoiceRefusal(plan(refundDay().g, null, { started: 'credit_note' }), { started: 'credit_note', postings: alone, error: err('A') }), null);
  assert.equal(invoiceRefusal(withLine, { postings: alone, error: err('A') }), 'other');
  assert.equal(invoiceRefusal(withLine, { postings: alone, error: err('A', 503) }), null, "only Xero's own no");
  assert.equal(invoiceRefusal(withLine, { postings: { INVOICE: { status: 'posted', id: 'i' } }, error: err('A') }), null, 'the invoice is in Xero');
  assert.equal(invoiceRefusal(withLine, { postings: { ...alone, 'PAY:CARDCLR': { status: 'sending' } }, error: err('A') }), null);
  assert.equal(invoiceRefusal(withLine, { postings: alone, error: { ...err('A'), message: 'Xero API /Invoices failed: 400 {"Message":"Invoice # must be unique."}' } }), null, 'a number Xero says is taken says nothing');
  // A fee day whose line was not carried has no line to blame.
  const short = plan(plain.g, { ...plain.fees, cardSales: 1 });
  assert.equal(invoiceRefusal(short, { postings: alone, error: err('A') }), null);
});

// ── 33 to 38: screens, shapes, words and wiring ──────────────────────────────

test('33. Back Office: what the preview says about card fees, and only when the invoice carries the line', () => {
  const fmt = (n) => `£${Number(n).toFixed(2)}`;
  const view = (w, started) => planView(plan(w.g, w.fees, { started }));
  // No refunds.
  const a = previewWords(view(plainDay()), { tw: 'VAT', fmt });
  assert.deepEqual([a.asLines, a.note, a.paymentsTitle], [false, '', 'Payments on the invoice, takings less card fees (it shows as Paid)']);
  assert.equal(a.feeNote, 'Card fees £0.43. The card payment is £23.10 less card fees: £22.67, what the card processor pays for this day.');
  assert.deepEqual(view(plainDay()).invoice.lines.map(a.tagFor), ['Sales', 'Sales', 'Discount', 'Discount', 'Discount', 'Sales', 'Tips', 'Service', 'Card fees']);
  // Refunds as minus lines.
  const b = previewWords(view(refundDay()), { tw: 'VAT', fmt });
  assert.equal(b.note, 'Refunds are the minus lines before the card fees line. Sales £28.01 less refunds £3.80 less card fees £0.37 makes the invoice total.');
  assert.equal(b.paymentsTitle, 'Payments on the invoice, takings less refunds and card fees (it shows as Paid)');
  assert.equal(b.feeNote, 'Card fees £0.37, £0.43 on sales less £0.06 given back on refunds. The card payment is £19.30 less card fees: £18.93, what the card processor pays for this day.');
  assert.deepEqual(view(refundDay()).invoice.lines.slice(-2).map(b.tagFor), ['Refund', 'Card fees']);
  assert.deepEqual([b.creditNote, b.refundPayments, b.refundTieTitle], [null, [], 'VAT per rate on the refund lines']);
  // The credit note way: the credit note shows as it did, and the payments are takings less card fees.
  const c = previewWords(view(refundDay(), 'credit_note'), { tw: 'VAT', fmt });
  assert.deepEqual([c.asLines, c.note, c.paymentsTitle], [false, '', 'Payments on the invoice, takings less card fees (it shows as Paid)']);
  assert.equal(c.feeNote, 'Card fees £0.37, £0.43 on sales less £0.06 given back on refunds. The card payment is £23.10 less card fees: £22.73, what the card processor pays for this day.');
  assert.equal(c.creditNote.number, 'SOS-LEEDS-20260929-R');
  // More fee back than charged.
  const Y = earlier(D, 'Y', 20, 380);
  const back = dayOf([E], refundOf(Y, { id: 'ry', amount: 3.8, taxAmount: 0.63, isFullRefund: true, legs: [legOf(Y, 380)] }), { payments: withPay(new Map(), paymentRow(4, 800, 2), paymentRow(20, 380, 50)) });
  const d = previewWords(view(back), { tw: 'VAT', fmt });
  assert.equal(d.note, 'Refunds are the minus lines before the card fees line. Sales £8.00 less refunds £3.80 plus card fees returned £0.48 makes the invoice total.');
  assert.equal(d.feeNote, "Card fees returned £0.48: more fee came back on refunds (£0.50) than this day's sales paid (£0.02). The card payment is £4.20 plus that: £4.68.");
  assert.equal(previewWords(view(back)).feeNote, "Card fees returned 0.48: more fee came back on refunds (0.50) than this day's sales paid (0.02). The card payment is 4.20 plus that: 4.68.");
  // The line is NOT carried (card fees on, but none that day, or a day that could not carry it):
  // every word is the one a site with card fees off reads.
  const offWords = previewWords(planView(plan(refundDay().g, null)), { tw: 'VAT', fmt });
  assert.deepEqual([offWords.note, offWords.paymentsTitle, offWords.feeNote], ['Refunds are the minus lines at the end. Sales £28.01 less refunds £3.80 makes the invoice total.', 'Payments on the invoice, takings less refunds (it shows as Paid)', '']);
  for (const fees of [{ ...refundDay().fees, charged: 6 }, { ...refundDay().fees, cardSales: 1 }]) {
    const v = planView(plan(refundDay().g, fees));
    assert.equal(v.cardFees.line, false);
    const w = previewWords(v, { tw: 'VAT', fmt });
    assert.deepEqual([w.note, w.paymentsTitle, w.feeNote, w.asLines], [offWords.note, offWords.paymentsTitle, '', true]);
  }
  // An answer from an older xero-sales (no cardFees): as before, and the tag of a line it does not know is its kind.
  const older = planView(plan(plainDay().g, null));
  assert.ok(!('cardFees' in older));
  const o = previewWords(older, { fmt });
  assert.deepEqual([o.note, o.paymentsTitle, o.feeNote], ['', 'Payments on the invoice (it shows as Paid)', '']);
  assert.deepEqual([previewWords(null).feeNote, previewWords(undefined).feeNote, previewWords({}).feeNote], ['', '', '']);
  assert.equal(o.tagFor({ kind: 'fee' }), 'Card fees');
  // No invoice on the screen: nothing about its lines.
  const none = previewWords({ refundWay: 'credit_note', invoice: null, cardFees: { line: true, net: 0.1 } });
  assert.deepEqual([none.feeNote, none.paymentsTitle], ['', 'Payments on the invoice (it shows as Paid)']);
  // Postings: the status of a waiting day.
  assert.equal(STATUS_LABEL.fees_wait, 'Waiting for card fees');
  assert.deepEqual(STATUS_COLOUR.fees_wait, STATUS_COLOUR.sending, 'the blue of a day on its way, not the red of a failed one');
  // The screens take the words from here and decide nothing themselves.
  const preview = read('src/backoffice/sections/xero/InvoicePreview.jsx');
  assert.match(preview, /<Payments list=\{view\.payments\} [^>]*title=\{words\.paymentsTitle\} \/>\n\s+\{words\.feeNote && <div [^>]*>\{words\.feeNote\}<\/div>\}/);
  assert.doesNotMatch(preview.replace(/^\s*\/\/.*$/gm, ''), /cardFees/, 'no card fees decision is made in the screen itself');
  const history = read('src/backoffice/sections/xero/PostingsHistory.jsx');
  assert.match(history, /const feeNote = historyFeeNote\(d\);/);
  assert.match(history, /\{feeNote && <div [^>]*>\{feeNote\}<\/div>\}/);
  assert.match(history, /const waiting = d\.status === 'fees_wait';/);
  assert.match(history, /\(r\.status === 'blocked' \|\| r\.status === 'fees_wait'\) && r\.notReady && /);
});

test('34. US (tax added on, Exclusive): the fee line has no tax, and the invoice is still the money', () => {
  const us = usDay();
  const ref = referenced(us.rows, 70);
  const [U1] = ref.rows;
  const refunds = [{ ...U1, refunds: [refundEntry({ id: 'r', amount: 11, taxAmount: 1, isFullRefund: true, timestamp: us.day.fromMs + 2 * H, legs: [legOf(U1, 1100)] })] }];
  const m = mapping({ taxDefault: 'TAX001', cardFees: ON });
  const g = buildGroupedDay({ day: us.day, saleRows: ref.rows, refundRows: refunds, venue: us.venue, taxRates: [{ id: 'st', name: 'Sales tax', code: 'ST', rate: 0.1, type: 'exclusive', is_default: true, active: true }], resolver: makeGroupResolver(m, CATEGORIES) });
  const items = cardFeeItems({ day: us.day, saleRows: ref.rows, refundRows: refunds, clearing: m.clearing });
  const fees = { ...sumCardFees(items, payMap(ref.refs, () => 29)), account: 'SOSFEES' };
  assert.deepEqual([fees.charged, fees.returned, fees.cardSales, fees.cardRefunds], [58, 29, 2200, 1100]);
  const args = { mapping: m, detail: us.detail, site: SITE, date: DATE, currency: 'USD' };
  const off = planXeroInvoiceDay(g, { ...args, cardFees: null });
  const p = planXeroInvoiceDay(g, { ...args, cardFees: fees });
  assert.deepEqual([p.refundWay, p.blocked, p.invoice.payload.LineAmountTypes], ['lines', [], 'Exclusive']);
  assert.deepEqual(p.invoice.payload.LineItems.map((l) => [l.Description, l.TaxType, l.UnitAmount, l.TaxAmount]), [
    ['Hot drinks', 'TAX001', 20, 2],
    ['Refund: Hot drinks', 'TAX001', -10, -1],
    ['Card fees', 'NONE', -0.29, 0],
  ]);
  assert.deepEqual(p.invoice.payload.LineItems.slice(0, -1), off.invoice.payload.LineItems);
  assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.UnitAmount + l.TaxAmount)), 1071, 'amounts before tax, plus the tax, is the money');
  assert.equal(p.invoice.total, 1071);
  assert.deepEqual(pays(p), [['PAY:CARDCLR', 1071]]);
  assert.deepEqual(p.vatTie, off.vatTie);
  assert.equal(p.invoice.payload.CurrencyCode, 'USD');
  assert.ok(!p.warnings.some((x) => x.code === 'vat_override_large'));
  // The need for an account names the US tab.
  assert.deepEqual(planXeroInvoiceDay(g, { ...args, mapping: mapping({ taxDefault: 'TAX001' }), cardFees: { ...fees, account: undefined } }).notReady, [{ code: 'card_fees_account', message: 'Choose the card fees account under Tax and accounts, Payments.' }]);
});

test('35. awkward pennies on 200 generated days: total, lines and payments tie, and nothing negative or malformed is sent', () => {
  const twoDecimals = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
  const seen = { minus: 0, plus: 0, none: 0, card_short: 0, no_card_payment: 0, no_invoice: 0, missing: 0, credit_note: 0, lines: 0 };
  for (let seed = 1; seed <= RANDOM_DAYS; seed++) {
    const d = randomDay(seed);
    const off = plan(d.g, null, {}, d.m);
    const p = plan(d.g, d.fees, {}, d.m);
    const name = `seed ${seed}`;
    assert.deepEqual(p.blocked, [], name);
    const c = p.cardFees;
    assert.equal(c.net, d.fees.charged - d.fees.returned, name);
    assert.ok(c.charged >= 0 && c.returned >= 0, name);
    // Fees never choose the way, never touch the VAT, the credit note or the sales lines.
    assert.deepEqual([p.refundWay, p.refundWayReason], [off.refundWay, off.refundWayReason], name);
    assert.deepEqual([p.vatTie, p.creditNote, p.refundPayments], [off.vatTie, off.creditNote, off.refundPayments], name);
    if (p.refundWay) seen[p.refundWay] += 1;
    if (d.fees.unknown.length) { seen.missing += 1; assert.equal(warned(p, 'card_fees_missing').length, 1, name); } else assert.equal(warned(p, 'card_fees_missing').length, 0, name);
    if (!c.line) {
      seen[c.reason] += 1;
      assert.deepEqual([p.invoice, p.payments, p.totals], [off.invoice, off.payments, off.totals], `${name}: nothing about the invoice changes`);
      assert.equal(warned(p, 'card_fees_not_posted').length, c.reason === 'none' ? 0 : 1, name);
      continue;
    }
    seen[c.net > 0 ? 'minus' : 'plus'] += 1;
    const fee = p.invoice.lines.at(-1);
    assert.deepEqual([fee.kind, fee.amount, fee.tax, fee.taxType, fee.description], ['fee', -c.net, 0, 'NONE', c.net > 0 ? 'Card fees' : 'Card fees returned'], name);
    assert.equal(p.invoice.lines.filter((l) => l.kind === 'fee').length, 1, name);
    assert.deepEqual(p.invoice.lines.slice(0, -1), off.invoice.lines, name);
    // To the penny: the invoice is the sum of its lines and the sum of its payments.
    assert.equal(p.invoice.total, off.invoice.total - c.net, name);
    assert.equal(sumBy(p.invoice.lines, (l) => l.amount), p.invoice.total, name);
    assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.UnitAmount)), p.invoice.total, name);
    assert.equal(sumBy(p.payments, (x) => x.amount), p.invoice.total, name);
    assert.equal(cents(sumBy(p.payments, (x) => x.payload.Amount)), p.invoice.total, name);
    assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.TaxAmount)), cents(sumBy(off.invoice.payload.LineItems, (l) => l.TaxAmount)), name);
    // The card clearing payment alone moved, by exactly the net fee.
    const byAccount = (q) => Object.fromEntries(q.payments.map((x) => [x.account, x.amount]));
    assert.deepEqual(byAccount(p), { ...byAccount(off), CARDCLR: (byAccount(off).CARDCLR || 0) - c.net }, name);
    assert.equal(c.cardAfter, byAccount(p).CARDCLR, name);
    for (const x of p.payments) assert.equal(x.reference, (off.payments.find((o) => o.key === x.key) || x).reference, name);
    // Nothing Xero would refuse for its shape: above zero, two decimals, never a minus zero.
    assert.ok(p.invoice.total > 0 && p.payments.every((x) => x.amount > 0 && x.payload.Amount > 0), name);
    for (const l of p.invoice.payload.LineItems) assert.ok(twoDecimals(l.UnitAmount) && twoDecimals(l.TaxAmount) && !Object.is(l.UnitAmount, -0) && !Object.is(l.TaxAmount, -0), `${name}: ${l.Description}`);
    for (const x of p.payments) assert.ok(twoDecimals(x.payload.Amount), name);
    assert.ok(p.invoice.lines.every((l) => !Object.is(l.amount, -0) && !Object.is(l.tax, -0)), name);
    const v = planView(p);
    assert.equal(cents(v.totals.fees), c.net, name);
    assert.ok(!Object.is(v.cardFees.net, -0) && twoDecimals(v.cardFees.cardAfter), name);
  }
  assert.ok(seen.minus >= 120, JSON.stringify(seen));
  assert.ok(seen.plus >= 5 && seen.missing >= 30 && seen.lines >= 40 && seen.credit_note >= 5, JSON.stringify(seen));
  assert.equal(seen.minus + seen.plus + seen.none + seen.card_short + seen.no_card_payment + seen.no_invoice, RANDOM_DAYS);
});

test('36. the Card fees account: created through the same loop as the clearing accounts, reused when it is there, never a wrong one', async () => {
  // A made up Xero chart of accounts.
  const chart = (extra = []) => [
    { AccountID: 'acc-1', Code: '200', Name: 'Sales', Type: 'REVENUE', Class: 'REVENUE', Status: 'ACTIVE' },
    { AccountID: 'acc-2', Code: '404', Name: 'Bank Fees', Type: 'OVERHEADS', Class: 'EXPENSE', Status: 'ACTIVE' },
    ...extra,
  ];
  const xero = (accounts) => {
    const api = async (where, init) => {
      api.calls.push(`${init?.method || 'GET'} ${where}`);
      if (!init) return { Accounts: accounts };
      const def = JSON.parse(init.body);
      if (init.method === 'PUT') {
        api.made.push(def);
        const cls = { EXPENSE: 'EXPENSE', REVENUE: 'REVENUE', BANK: 'ASSET', CURRENT: 'ASSET' }[def.Type] || 'LIABILITY';
        return { Accounts: [{ AccountID: `new-${api.made.length}`, Status: 'ACTIVE', Class: cls, ...def, EnablePaymentsToAccount: false }] };
      }
      return { Accounts: [{ AccountID: where.split('/').pop(), EnablePaymentsToAccount: true, Name: 'enabled', Code: 'X' }] };
    };
    api.calls = []; api.made = [];
    return api;
  };
  const who = { name: 'Coffee Boy Leeds', code: 'LEEDS' };
  assert.deepEqual(RECOMMENDED.cardFees(who), { Name: 'Card fees', Code: 'SOSFEES', Type: 'EXPENSE', Description: 'Card processing fees taken by the card processor before each payout (ServOS).' });
  // None there: ONE account is created, and the form is handed its code. Nothing is saved here.
  let api = xero(chart());
  assert.deepEqual(await createRecommendedAccounts(api, ['cardFees'], who), { ok: true, created: [{ key: 'cardFees', name: 'Card fees', code: 'SOSFEES', id: 'new-1', existed: false }], patch: { cardFees: { account: 'SOSFEES' } } });
  assert.deepEqual(api.calls, ['GET /Accounts', 'PUT /Accounts']);
  assert.deepEqual(api.made, [{ Name: 'Card fees', Code: 'SOSFEES', Type: 'EXPENSE', Description: 'Card processing fees taken by the card processor before each payout (ServOS).' }]);
  // Already there, by the same name (any case) or the same code: reused, nothing created.
  for (const there of [{ AccountID: 'acc-9', Code: '429', Name: 'CARD FEES', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ACTIVE' }, { AccountID: 'acc-9', Code: 'sosfees', Name: 'Merchant charges', Type: 'OVERHEADS', Class: 'EXPENSE', Status: 'ACTIVE' },
    { AccountID: 'acc-9', Name: 'Card fees', Type: 'EXPENSE', Class: 'EXPENSE' }]) {
    api = xero(chart([there]));
    const res = await createRecommendedAccounts(api, ['cardFees'], who);
    assert.deepEqual(res, { ok: true, created: [{ key: 'cardFees', name: there.Name, code: there.Code || '', id: 'acc-9', existed: true }], patch: { cardFees: { account: there.Code || 'acc-9' } } });
    assert.deepEqual(api.calls, ['GET /Accounts'], 'no write at all');
  }
  // An account of that name or code that is archived, or is not an expense account: refused in
  // plain words, and NOTHING is created, not even the other accounts asked for with it.
  for (const wrong of [{ AccountID: 'acc-9', Code: '429', Name: 'Card fees', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ARCHIVED' }, { AccountID: 'acc-9', Code: 'SOSFEES', Name: 'Card fee income', Type: 'REVENUE', Class: 'REVENUE', Status: 'ACTIVE' },
    { AccountID: 'acc-9', Code: '091', Name: 'card fees', Type: 'BANK', Class: 'ASSET', Status: 'ACTIVE' }]) {
    api = xero(chart([wrong]));
    const res = await createRecommendedAccounts(api, ['tipsPayable', 'cardFees'], who);
    assert.deepEqual(res, { ok: false, status: 400, created: [], error: `Xero already has an account called "${wrong.Name}" (code ${wrong.Code}) that is not an active expense account, so ServOS will not post card fees to it. Pick an expense account from the list, or change the name and code of that account in Xero and try again.` });
    assert.deepEqual(api.calls, ['GET /Accounts']);
    assert.equal(canTakeCardFees(wrong), false);
  }
  assert.equal(canTakeCardFees({ Status: 'ACTIVE', Class: 'EXPENSE' }), true);
  assert.equal(canTakeCardFees(null), false);
  assert.match(cardFeesAccountRefusal({ Name: 'Card fees' }), /^Xero already has an account called "Card fees" that is not an active expense account, /);
  // The clearing accounts go through the very same loop, as they always did.
  api = xero(chart([{ AccountID: 'acc-7', Code: 'CCLEEDS', Name: 'Old card clearing', Type: 'CURRENT', Class: 'ASSET', Status: 'ACTIVE' }]));
  const both = await createRecommendedAccounts(api, ['cardClearing', 'cashInTill', 'cardFees'], who);
  assert.deepEqual(both.created.map((c) => [c.key, c.existed]), [['cardClearing', true], ['cashInTill', false], ['cardFees', false]]);
  assert.deepEqual(both.patch, { clearing: { card: 'CCLEEDS', cash: 'CTLEEDS' }, cardFees: { account: 'SOSFEES' } });
  assert.deepEqual(api.made.map((d) => d.Name), ['Cash in till Coffee Boy Leeds', 'Card fees']);
  // A key ServOS does not know is ignored (and never reaches the loop).
  assert.deepEqual(recommendedKeys(['cardFees', 'constructor', 'toString', '__proto__', 'nope', 7, null]), ['cardFees']);
  assert.deepEqual(recommendedKeys('cardFees'), []);
  assert.deepEqual(Object.keys(RECOMMENDED), ['cardClearing', 'cashInTill', 'giftLiability', 'tipsPayable', 'servicePayable', 'discounts', 'cardFees']);
  // xero-config: the one loop, behind the same access fence, second step and site_create action as before.
  const config = read('supabase/functions/xero-config/index.ts');
  const create = config.slice(config.indexOf("if (action === 'site_create')"), config.indexOf("if (action === 'copy_site')"));
  assert.match(create, /const keys = recommendedKeys\(body\.keys\);\n\s+if \(!keys\.length\) return json\(\{ error: 'Choose which accounts to create\.' \}, 400\);/);
  assert.match(create, /const made = await createRecommendedAccounts\(\(path: string, init\?: any\) => xeroApi\(accessToken, tenantId, path, init\), keys, who\);\n\s+if \(!made\.ok\) return json\(\{ error: made\.error, created: made\.created \}, made\.status\);\n\s+return json\(\{ ok: true, created: made\.created, patch: made\.patch \}\);/);
  assert.doesNotMatch(create, /sb\.from\('xero_config'\)\.(update|upsert)/, 'nothing is saved: the form saves on Save');
  assert.doesNotMatch(config, /const RECOMMENDED/);
  assert.ok(config.indexOf('const secondStepBlock = await secondStepRefusal(req)') < config.indexOf('const acc = await requireAccess(req, locationId);') && config.indexOf('const acc = await requireAccess(req, locationId);') < config.indexOf("if (action === 'site_create')"));
  // Opting in is each site's own choice: copying another site's setup never brings card fees with it.
  const copy = config.slice(config.indexOf("if (action === 'copy_site')"), config.indexOf("if (action === 'options')"));
  assert.match(copy, /for \(const k of \['groups', 'discounts', 'tipsAccount', 'serviceAccount', 'giftLiabilityAccount', 'otherSalesAccount'\]\)/);
  assert.doesNotMatch(copy, /cardFees/);
  // The form: the account is merged in beside the person's own tick, never over it.
  assert.deepEqual(mergePatch({ cardFees: { enabled: true } }, { cardFees: { account: 'SOSFEES' } }), { cardFees: { enabled: true, account: 'SOSFEES' } });
  assert.deepEqual(mergePatch({ cardFees: { enabled: true, account: 'OLD' }, tipsAccount: '825' }, { cardFees: { account: 'SOSFEES' } }), { cardFees: { enabled: true, account: 'SOSFEES' }, tipsAccount: '825' });
  assert.deepEqual(mergePatch({}, { cardFees: { account: 'SOSFEES' } }), { cardFees: { account: 'SOSFEES' } }, 'creating the account never switches card fees on');
  assert.deepEqual(mergePatch({ clearing: { cash: 'C' }, groups: { a: { account: '1' } } }, { clearing: { card: 'K' }, tipsAccount: '825', discountAccount: '401' }),
    { clearing: { cash: 'C', card: 'K' }, groups: { a: { account: '1' } }, tipsAccount: '825', discounts: { accounts: { customer: '401', staff: '401', loyalty: '401', comp: '401', promo: '401' } } }, 'as it merged before it moved');
  // The tick: on keeps the account, off remembers it (and drops the key when there is none).
  assert.deepEqual(setCardFeesOn({ site: SITE }, true), { site: SITE, cardFees: { enabled: true } });
  assert.deepEqual(setCardFeesOn({ cardFees: { enabled: false, account: 'SOSFEES' } }, true), { cardFees: ON });
  assert.deepEqual(setCardFeesOn({ cardFees: ON }, false), { cardFees: { enabled: false, account: 'SOSFEES' } });
  assert.deepEqual(setCardFeesOn({ site: SITE, cardFees: { enabled: true } }, false), { site: SITE });
  assert.deepEqual(setCardFeesAccount({ cardFees: { enabled: true } }, 'SOSFEES'), { cardFees: ON });
  assert.deepEqual(setCardFeesAccount({ cardFees: ON }, ''), { cardFees: { enabled: true } });
  for (const form of [setCardFeesOn({}, true), setCardFeesOn({ cardFees: ON }, false), setCardFeesAccount(setCardFeesOn({}, true), 'SOSFEES'), setCardFeesOn({ cardFees: { enabled: true } }, false)]) {
    const said = validateInvoiceMapping(form);
    assert.ok(said === null || said === 'Choose the account for card fees, or switch card fees off.', said);
  }
  assert.equal(mappingHash(mapping(setCardFeesOn({ cardFees: ON }, false))), 'f637af9c', 'switched off again: the hash a site with no card fees has');
  // The list offered: Xero's expense accounts, never a bank account.
  const list = [{ id: '1', cls: 'EXPENSE', bank: false }, { id: '2', cls: 'REVENUE', bank: false }, { id: '3', cls: 'ASSET', bank: true }, { id: '4', cls: 'expense', bank: false }, { id: '5', cls: 'EXPENSE', bank: true }];
  assert.deepEqual(expenseAccounts(list).map((x) => x.id), ['1', '4']);
  assert.deepEqual(expenseAccounts(null), []);
  const setup = read('src/backoffice/sections/xero/SiteSetup.jsx');
  assert.match(setup, /const r = await xeroSiteCreate\(locId, \{ kind: 'accounts', keys: \['cardFees'\] \}\);\n\s+setMap\(\(m\) => mergePatch\(m, r\.patch\)\);/);
  assert.match(setup, /if \(!window\.confirm\('Create the account "Card fees" in Xero \(one that already exists is reused\)\?'\)\) return;/);
  assert.ok(setup.indexOf('<div style={S.h2}>6. Payments</div>') < setup.indexOf('<div style={S.h3}>Card fees</div>') && setup.indexOf('<div style={S.h3}>Card fees</div>') < setup.indexOf('<div style={S.h2}>7. Ready checklist</div>'), 'inside 6. Payments, nothing renumbered');
  assert.doesNotMatch(setup.slice(setup.indexOf('const RECOMMEND = ['), setup.indexOf('export default function SiteSetup')), /cardFees/, 'not in the "Create recommended accounts" list');
});

test('37. the words: plain, right for one and for many, and not a dash among them', () => {
  const said = [];
  const u = (side, reason, count, amount) => ({ side, reason, count, amount, checkIds: [] });
  // Missing fees.
  const END = 'so the card clearing account will be out by their fees. Check them under Card payments and put the difference right in Xero.';
  assert.equal(cardFeesMissingWords([u('sale', 'no_payment', 3, 1250), u('refund', 'no_fee', 2, 760)]), `No card fee was found for 3 card payments (12.50) and 2 card refunds (7.60). The Card fees line leaves them out, ${END}`);
  assert.equal(cardFeesMissingWords([u('sale', 'no_payment', 3, 1250), u('sale', 'no_reference', 38, 20000), u('refund', 'no_reference', 1, 100)]), `No card fee was found for 41 card payments (212.50) and 1 card refund (1.00). 39 of them have no card processor reference on the till record. The Card fees line leaves them out, ${END}`);
  assert.equal(cardFeesMissingWords([u('sale', 'no_payment', 1, 400), u('sale', 'no_reference', 1, 650)]), `No card fee was found for 2 card payments (10.50). 1 of them has no card processor reference on the till record. The Card fees line leaves them out, ${END}`);
  assert.equal(cardFeesMissingWords([u('sale', 'no_payment', 1, 400)]), 'No card fee was found for 1 card payment (4.00). The Card fees line leaves it out, so the card clearing account will be out by its fee. Check it under Card payments and put the difference right in Xero.');
  assert.equal(cardFeesMissingWords([u('sale', 'other_processor', 1, 800)]), 'No card fee was found for 1 card payment (8.00). It was taken by another card processor, so ServOS holds no fee for it. The Card fees line leaves it out, so the card clearing account will be out by its fee. Check it under Card payments and put the difference right in Xero.');
  assert.equal(cardFeesMissingWords([u('sale', 'other_processor', 2, 800), u('sale', 'not_taken', 1, 100)]), `No card fee was found for 3 card payments (9.00). 2 of them were taken by another card processor, so ServOS holds no fee for them. The Card fees line leaves them out, ${END}`);
  assert.equal(cardFeesMissingWords([u('sale', 'other_processor', 1, 800), u('sale', 'no_reference', 1, 100)]), `No card fee was found for 2 card payments (9.00). 1 of them has no card processor reference on the till record. 1 of them was taken by another card processor, so ServOS holds no fee for it. The Card fees line leaves them out, ${END}`);
  assert.equal(cardFeesMissingWords([u('refund', 'no_payment', 2, 300)]), `No card fee was found for 2 card refunds (3.00). The Card fees line leaves them out, ${END}`);
  for (const list of [[u('sale', 'no_payment', 3, 1250), u('refund', 'no_fee', 2, 760)], [u('sale', 'no_reference', 1, 5)], [u('refund', 'other_processor', 4, 5)], [], null]) said.push(cardFeesMissingWords(list));
  // Not posted.
  for (const reason of ['card_short', 'no_invoice', 'no_card_payment', 'sales_differ']) {
    const words = cardFeesNotPostedWords({ reason, net: 21, returned: 16, cardBefore: 5 });
    assert.ok(words.length > 40 && /by hand\.$/.test(words), reason);
    said.push(words);
  }
  assert.equal(cardFeesNotPostedWords({ reason: 'none' }), '');
  assert.equal(cardFeesNotPostedWords(null), '');
  // The wait, the change, the checklist, the save, the account button, the reads.
  const wait = (count, amount) => cardFeesWait({ unknown: [u('sale', 'no_payment', count, amount)] }, { dayEndMs: DAY.toMs, nowMs: DAY.toMs + H, timezone: UK.timezone }).message;
  said.push(wait(1, 380), wait(12, 9915));
  said.push(cardFeesChangedWords({ line: true, charged: 43, returned: 0 }, { charged: 50, returned: 0 }));
  said.push('Choose the card fees account under VAT and accounts, Payments.', 'The card fees account is not an active account in Xero. Choose another, or create one.', 'The card fees account must be an expense account in Xero.');
  said.push('The card fees choice is not valid.', 'The account chosen for card fees is not valid.', 'Choose the account for card fees, or switch card fees off.');
  said.push(cardFeesAccountRefusal({ Name: 'Card fees', Code: '429' }), 'This venue has no card payments record, so its card fees cannot be read.', 'Could not read the card fees: connection reset');
  said.push(STATUS_LABEL.fees_wait, RECOMMENDED.cardFees({}).Description, RECOMMENDED.cardFees({}).Name);
  // The screens.
  const fmt = (n) => Number(n).toFixed(2);
  for (const v of [{ refundWay: 'lines', invoice: {}, totals: { sales: 28.01, refunds: 3.8 }, cardFees: { line: true, net: 0.37, charged: 0.43, returned: 0.06, cardBefore: 19.3, cardAfter: 18.93 } },
    { refundWay: null, invoice: {}, totals: { sales: 28.01, refunds: 0 }, cardFees: { line: true, net: 0.43, charged: 0.43, returned: 0, cardBefore: 23.1, cardAfter: 22.67 } },
    { refundWay: 'lines', invoice: {}, totals: { sales: 8, refunds: 3.8 }, cardFees: { line: true, net: -0.48, charged: 0.02, returned: 0.5, cardBefore: 4.2, cardAfter: 4.68 } }]) {
    const w = previewWords(v, { fmt });
    said.push(w.note, w.paymentsTitle, w.feeNote);
  }
  for (const d of [{ cardFees: { line: true, net: 0.43 } }, { cardFees: { line: true, net: -0.48 } }, { cardFees: { line: false, reason: 'card_short', net: 0.05 } }]) said.push(historyFeeNote({ ...d, postings: { INVOICE: { status: 'posted' } } }));
  // Every sentence the plans of the made up days give.
  for (const w of [plainDay(), refundDay(), randomDay(3), randomDay(11), randomDay(42)]) {
    for (const started of STARTED_WAYS) {
      const p = plan(w.g, w.fees, { started }, w.m);
      for (const l of p.invoice?.lines || []) said.push(l.description);
      for (const x of [...p.warnings, ...p.blocked, ...p.notReady]) said.push(x.message);
    }
  }
  assert.ok(said.length > 150 && said.every((s) => typeof s === 'string'), `${said.length} sentences`);
  for (const s of said) {
    assert.doesNotMatch(s, DASH, s);
    assert.doesNotMatch(s, /\(s\)|undefined|NaN|null|\s{2,}|\s\./, s);
  }
  // On the Setup tab, exactly as written, and on lines with no dash.
  const screens = {
    'src/backoffice/sections/xero/SiteSetup.jsx': [
      "['Off:', 'the invoice shows card takings in full, so the card clearing account keeps the fees as a balance.'],",
      "['On:', 'each day’s invoice gets one minus line, Card fees, and the card payment is what the card processor pays you for that day.'],",
      "['The fee', 'is the one on each card payment under Card payments. It is never worked out from a percentage.'],",
      'Put card fees on the daily invoice', '<span style={flabel}>Card fees account</span>', "'Create a Card fees account in Xero'",
      'Posts with No {tw}. After you save, check a day’s figures again: the preview then shows the Card fees line and the card payment.',
      "' (already there)' : ' (created)'}`).join(', ')}. It is filled in below; press Save.`",
    ],
    'src/backoffice/sections/xero/xeroUi.js': ['Refunds are the minus lines before the card fees line. Sales ', 'Payments on the invoice, takings less refunds and card fees (it shows as Paid)', 'Payments on the invoice, takings less card fees (it shows as Paid)',
      'Card fees were not put on this invoice. The warnings below say why.', "fees_wait: 'Waiting for card fees',"],
    'supabase/functions/xero-sales/index.ts': ["{ code: 'card_fees_unread', message: `${String((e as Error)?.message || e).replace(/[.\\s]+$/, '')}. Try again.` }"],
  };
  for (const [file, phrases] of Object.entries(screens)) {
    const lines = read(file).split('\n');
    for (const phrase of phrases) {
      const on = lines.filter((l) => l.includes(phrase));
      assert.ok(on.length >= 1, `${file}: ${phrase}`);
      for (const l of on) assert.doesNotMatch(l, DASH, `${file}: ${phrase}`);
    }
  }
  // Nothing new that a person reads, or that explains the code, uses a dash as punctuation.
  for (const file of ['supabase/functions/_shared/xeroCardFees.ts', 'supabase/functions/_shared/xeroSiteAccounts.ts', 'src/lib/accounting/xeroCardFees.test.js']) {
    assert.doesNotMatch(read(file), DASH, file);
  }
});

test('38. xero-sales and xero-config are wired to the functions tested here', () => {
  const sales = read('supabase/functions/xero-sales/index.ts');
  const config = read('supabase/functions/xero-config/index.ts');
  assert.match(sales, /import \{ cardFeesFor, loadCardFees \} from '\.\.\/_shared\/xeroCardFees\.ts';/);
  assert.match(sales, /withCardFees, cardFeesPatch, cardFeesForCompare,\n\} from '\.\.\/_shared\/xeroInvoicePlan\.js';/);
  // Four places ask for a day's card fees: the already answer, Check figures, the real post, and replace day (its preview and its run).
  assert.equal((sales.match(/await cardFeesFor\(platform, /g) || []).length, 5);
  // Every plan of a day in xero-sales is made from the grouped day with its fees on it; the planner is never handed them another way there.
  assert.equal((sales.match(/const grouped = withCardFees\(loaded\.grouped, /g) || []).length, 5);
  assert.doesNotMatch(sales.replace(/^\s*\/\/.*$/gm, ''), /cardFees: cf\.cardFees \}|planXeroInvoiceDay\(loaded\.grouped/);
  assert.equal((sales.match(/const \{ grouped \}/g) || []).length, 0, 'no plan is made from a day without its fees');
  // The real post: on the row the run HOLDS, before the Ready check, the wait before any call to
  // Xero, and the marker in the very save that writes refundWay.
  const day = sales.slice(sales.indexOf('async function invoiceDay('), sales.indexOf('async function replaceDay('));
  const order = ['await claimSyncRun(sb, key)', 'const started = refundWayStarted(run.detail);',
    'const cf = await cardFeesFor(platform, { detailRow: run.detail, mapping, locationId, loaded, venue, site, nowMs, noWait: !!run.detail?.replace });',
    '\n    const grouped = withCardFees(loaded.grouped, cf.cardFees);\n', 'invoiceNotReady(grouped, mapping, cfgRow?.detail, siteArg, date, venue, started)',
    'if (cf.wait) throw new NotReadyError([{ code: cf.wait.code, message: cf.wait.message }]);', 'await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET)',
    '\n    plan = planXeroInvoiceDay(grouped, { mapping, detail, site: siteArg, date, currency: venue.currency, started });',
    'refundWay: refundWayToRecord(started, plan), ...cardFeesPatch(cf.started, run.detail.cardFees, cf.cardFees, plan, new Date().toISOString()) } });', 'await postInvoiceDay(run, plan,'];
  const real = day.slice(day.indexOf('await claimSyncRun(sb, key)') - 1);
  const at0 = order.map((s) => real.indexOf(s));
  assert.ok(at0.every((i) => i >= 0), `all there: ${at0}`);
  assert.deepEqual([...at0].sort((a, b) => a - b), at0, 'in this order');
  // A waiting day: the wait's own words, recorded not ready, HTTP 400.
  assert.match(day, /const feesWait = notReady\?\.\[0\]\?\.code === 'card_fees_wait';\n\s+const said = refusal \? refusalWords\(refusal, xeroWords\)\n\s+: feesWait \? msg\n/);
  assert.match(day, /\}, notReady \? 400 : 500\);/);
  // Check figures: the fees the way the row started, a failed read said as a problem, the wait under "would not be sent yet".
  assert.match(day, /try \{ cf = await cardFeesFor\(platform, \{ detailRow: prior\?\.detail, mapping, locationId, loaded, venue, site, nowMs \}\); \}\n\s+catch \(e\) \{ feeProblems\.push\(\{ code: 'card_fees_unread', /);
  assert.match(day, /problems: \[\.\.\.plan\.blocked, \.\.\.feeProblems\],\n\s+notReady: \[\.\.\.plan\.notReady, \.\.\.\(cf\.wait \? \[\{ code: cf\.wait\.code, message: cf\.wait\.message \}\] : \[\]\)\], readiness, seen,/);
  // The already answer: only what is on the day's own row, a fee change in its own sentence.
  const already = sales.slice(sales.indexOf('async function invoiceAlreadyAnswer('), sales.indexOf('function invoiceNotReady('));
  assert.match(already, /const cf = await cardFeesFor\(platform, \{ detailRow: prior\.detail, storedOnly: true, /);
  assert.match(already, /const fees = cardFeesForCompare\(cf\.cardFees, freshFees\);\n\s+const grouped = withCardFees\(loaded\.grouped, fees\.cardFees\);/);
  assert.match(already, /if \(fees\.words\) out\.warnings\.push\(\{ code: 'card_fees_changed_since_posted', message: fees\.words \}\);/);
  assert.match(already, /if \(cf\.started === 'on'\) \{\n\s+try \{ freshFees = await loadCardFees\(/);
  // Replace day: the preview lists a wait or a failed read as a problem.
  const replace = sales.slice(sales.indexOf('async function replaceDay('), sales.indexOf('Deno.serve('));
  assert.match(replace, /if \(cf\.wait\) feeProblems\.push\(cf\.wait\.message\);\n\s+const grouped = withCardFees\(loaded\.grouped, cf\.cardFees\);\n\s+const \{ pre: plan, notReady \} = invoiceNotReady\(/);
  assert.match(replace, /\.\.\.plan\.blocked\.map\(\(b: any\) => b\.message\), \.\.\.feeProblems, /);
  assert.match(replace, /const words = notReady && notReady\[0\]\?\.code !== 'card_fees_wait' \? /);
  // The loader hands back the rows the references are on.
  assert.match(read('supabase/functions/_shared/xeroInvoicePost.ts'), /return \{ grouped, taxRates: loaded\.taxRates, day: loaded\.day, categories, rows \};/);
  // xero-config: the status of a waiting day, the fees of a day in its detail, and nothing else new.
  assert.match(config, /if \(s === 'error' && row\.notReady\?\.\[0\]\?\.code === 'card_fees_wait'\) return 'fees_wait';\n\s+if \(s === 'error'\) return row\.notReady \|\| row\.problems \? 'blocked' : 'failed';/);
  assert.match(config, /siteCodeFromSlug, cardFeesView,\n\s+dayModel, historyDocs,\n\} from '\.\.\/_shared\/xeroInvoicePlan\.js';/);
  // Saving, the Ready checklist and the switch need no code of their own: the shared rules do it.
  for (const action of ['save', 'readiness', 'figures_checked', 'set_mode']) {
    const from = config.indexOf(`if (action === '${action}')`);
    assert.doesNotMatch(config.slice(from, config.indexOf("if (action === '", from + 10)), /cardFees/, action);
  }
  // The card fee BILL hook (a different, parked idea) is as it was: off, and never fed.
  const planSrc = read('supabase/functions/_shared/xeroInvoicePlan.js');
  assert.match(planSrc, /feeBill: m\.feeBill\?\.enabled === true && fees \? \{ planned: false, reason: 'not_available' \} : null,/);
  assert.doesNotMatch(sales, /feeBill/);
  const calls = sales.split('\n').filter((l) => l.includes('planXeroInvoiceDay(') && !l.trim().startsWith('//') && !l.trim().startsWith('planXeroInvoiceDay,'));
  assert.equal(calls.length, 5);
  for (const l of calls) assert.doesNotMatch(l, /\bfees:|\bcash:|cardFees:/, 'the hooks are fed nothing, and the fees ride on the grouped day');
  // The older bank transactions never carry card fees.
  assert.doesNotMatch(read('supabase/functions/_shared/xeroPostingPlan.js'), /cardFees/);
  // What takes and stamps the fee is not part of this: nothing there knows about the Xero line.
  for (const file of ['supabase/functions/adyen-webhook/index.ts', 'supabase/functions/adyen-financial/index.ts', 'supabase/functions/_shared/venueFees.ts', 'supabase/functions/_shared/adyenLink.ts', 'src/lib/payments/venueFees.js']) {
    assert.doesNotMatch(read(file), /xeroCardFees|cardFeeItems|card_fees_wait/, file);
  }
  // The split at Adyen that the refund rule rests on: refunds unwind the fee in the same ratio.
  assert.match(read('supabase/functions/_shared/adyenLink.ts'), /refund: 'deductAccordingToSplitRatio',/);
});
