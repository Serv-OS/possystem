/**
 * readerTipHeal.test.js - the I/O half of "a tip added on the card machine is never
 * lost" (supabase/functions/_shared/readerTipHeal.ts, v5.11.16), run against an
 * in-memory fake of the two databases so every ordering of the race can be played.
 *
 * The fake speaks just enough supabase-js: from(t).select/update/insert/delete with
 * eq/is/in/not/like/gte/lte/order/limit/maybeSingle, and rpc(). Faults are injected
 * per call: 'reset' (nothing written, an error back: the incident) and 'lost_reply'
 * (written, but the caller sees an error: the other half the verify step exists for).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SettleDeferred, isSettleDeferred, recordTipWithRetry, settleRpcWithRetry, logDurable,
  healReaderTip, correctHealedSale, alertOnce, ensureReportedMinor, reportParkedMismatch,
} from '../../../supabase/functions/_shared/readerTipHeal.ts';
import { healNote, healNoteState } from '../../../supabase/functions/_shared/readerTip.js';

// ── the fake ─────────────────────────────────────────────────────────────────

const RESET = { message: 'TypeError: error sending request for url: connection error: connection reset', code: '' };
const same = (a, b) => {
  if (a == null || b == null) return false;
  const na = Number(a); const nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb) && typeof a !== 'boolean' && typeof b !== 'boolean') return na === nb;
  return String(a) === String(b);
};

class Query {
  constructor(db, table) {
    Object.assign(this, { db, table, op: 'select', filters: [], patch: null, returning: false, single: false, lim: null, ord: null });
  }
  select() { if (this.op !== 'select') this.returning = true; return this; }
  update(p) { this.op = 'update'; this.patch = p; return this; }
  insert(p) { this.op = 'insert'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push((r) => same(r[c], v)); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  in(c, vs) { this.filters.push((r) => vs.some((v) => same(r[c], v))); return this; }
  not(c, op, v) { if (op === 'is' && v === null) this.filters.push((r) => r[c] != null); return this; }
  like(c, pat) {
    const re = new RegExp('^' + pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    this.filters.push((r) => typeof r[c] === 'string' && re.test(r[c]));
    return this;
  }
  gte(c, v) { this.filters.push((r) => r[c] != null && Date.parse(r[c]) >= Date.parse(v)); return this; }
  lte(c, v) { this.filters.push((r) => r[c] != null && Date.parse(r[c]) <= Date.parse(v)); return this; }
  order(c, o = {}) { this.ord = { c, asc: o.ascending !== false }; return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.single = true; return this; }
  then(res, rej) { return Promise.resolve().then(() => this.db.exec(this)).then(res, rej); }
}

class FakeDb {
  constructor(tables = {}) {
    this.tables = {};
    for (const [k, rows] of Object.entries(tables)) this.tables[k] = rows.map((r) => structuredClone(r));
    this.faults = [];   // (q) => 'reset' | 'lost_reply' | { error } | null, consumed when it fires
    this.calls = [];
    this.rpcs = {};
  }
  rows(t) { return (this.tables[t] ||= []); }
  from(t) { return new Query(this, t); }
  fault(match, kind, times = 1) { this.faults.push({ match, kind, times }); }
  takeFault(q) {
    const f = this.faults.find((x) => x.times > 0 && x.match(q));
    if (!f) return null;
    f.times -= 1;
    return f.kind;
  }
  exec(q) {
    this.calls.push({ table: q.table, op: q.op, patch: q.patch });
    const fault = this.takeFault(q);
    if (fault === 'reset') return { data: null, error: RESET };
    if (fault && typeof fault === 'object') return { data: null, error: fault };
    const out = this.apply(q);
    if (fault === 'lost_reply') return { data: null, error: RESET };
    return out;
  }
  apply(q) {
    const all = this.rows(q.table);
    const hit = all.filter((r) => q.filters.every((f) => f(r)));
    if (q.op === 'insert') {
      const list = Array.isArray(q.patch) ? q.patch : [q.patch];
      for (const row of list) {
        if (q.table === 'adyen_webhook_events' && all.some((r) => r.event_key === row.event_key)) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        }
        // Every table's primary key is `id`: an explicit id that exists is a 23505 too.
        if (row.id != null && all.some((r) => r.id === row.id)) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint "activity_events_pkey"', code: '23505' } };
        }
        all.push(structuredClone({ id: `${q.table}-${all.length + 1}`, ...row }));
      }
      return { data: null, error: null };
    }
    if (q.op === 'delete') {
      this.tables[q.table] = all.filter((r) => !hit.includes(r));
      return { data: null, error: null };
    }
    if (q.op === 'update') {
      for (const r of hit) Object.assign(r, structuredClone(q.patch));
      return { data: q.returning ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    let rows = hit.map((r) => structuredClone(r));
    if (q.ord) rows.sort((a, b) => (a[q.ord.c] > b[q.ord.c] ? 1 : -1) * (q.ord.asc ? 1 : -1));
    if (q.lim != null) rows = rows.slice(0, q.lim);
    if (q.single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
  async rpc(name, args) {
    const q = { table: `rpc:${name}`, op: 'rpc', patch: args, filters: [] };
    this.calls.push(q);
    const fault = this.takeFault(q);
    if (fault === 'reset') return { data: null, error: RESET };
    if (fault && typeof fault === 'object') return { data: null, error: fault };
    const out = await this.rpcs[name](args);
    if (fault === 'lost_reply') return { data: null, error: RESET };
    return out;
  }
  count(table, op) { return this.calls.filter((c) => c.table === table && c.op === op).length; }
}

// ── fixtures: R3618 (read-only SQL, 29 Sep 2026) ─────────────────────────────

const JOB_ID = '53ae162a-4c8e-4699-a694-3ef53b3ca60e';
const PSP = 'G8837M7KC3TTTQR9';
const TX = `TwkU001790675787051.${PSP}`;
const LOC = '5435c88e-6a58-4ebf-b2a0-b5ed5c9bdaa9';
const CHECK_ID = 'chk-1790675785198-b44c71';

const parkedJob = (over = {}) => ({
  id: JOB_ID, processor: 'adyen', simulated: false, training: false,
  status: 'approved', needs_human: true, last_error: 'amount mismatch: processor 797 vs server 725',
  tip_minor: null, charge_minor: 725, due_minor: 725, tip_basis_minor: 725, reported_minor: null,
  currency: 'GBP', tip_config: { enabled: true, allowCustom: true, percentBands: [5, 10, 15] },
  capture_mode: null, payment_session_id: PSP, transaction_id: TX, closed_check_id: CHECK_ID,
  location_id: LOC, check_draft: { source: 'pos_send_to_terminal' },
  settled_at: '2026-09-29T09:56:38.078Z', updated_at: '2026-09-29T09:56:38.078Z',
  ...over,
});
const ledgerRow = (over = {}) => ({
  psp_reference: PSP, merchant_reference: `tj-${JOB_ID}`, success: true, amount_minor: 797, currency: 'GBP',
  last_event_code: 'AUTHORISATION', merchant_account: 'ServOS_UK',
  card: { brand: 'visa', last4: '3814', authCode: '091258' },
  raw: { authorisation: { amount: { value: 797, currency: 'GBP' } } },
  created_at: '2026-09-29T09:56:43.455Z', ...over,
});
const bookedCheck = (over = {}) => ({
  id: CHECK_ID, ref: 'R3618', location_id: LOC, tip: 0, total: 7.25, subtotal: 7.25, tax_amount: 1.21,
  tenders: [{ tip: 0, amount: 7.25, method: 'card', psp_ref: TX, processor: 'adyen' }],
  payment_intents: null, status: 'paid', voided: false, refunds: [], ...over,
});

const world = ({ job = parkedJob(), check = null, ledger = [ledgerRow()] } = {}) => ({
  ops: new FakeDb({ terminal_jobs: [job], closed_checks: check ? [check] : [], activity_events: [] }),
  platform: new FakeDb({ adyen_payments: ledger, adyen_webhook_events: [] }),
});
const jobOf = (ops) => ops.rows('terminal_jobs').find((j) => j.id === JOB_ID);
const checkOf = (ops) => ops.rows('closed_checks').find((c) => c.id === CHECK_ID);
const keys = (platform) => platform.rows('adyen_webhook_events').map((e) => e.event_key);
const isJobWrite = (q) => q.table === 'terminal_jobs' && q.op === 'update';

// ── PREVENT: the tip write ───────────────────────────────────────────────────

const inflight = (over = {}) => parkedJob({ status: 'charging', needs_human: false, last_error: null, settled_at: null, ...over });
const TIP = { jobId: JOB_ID, tipMinor: 72, authorizedMinor: 797, chargeMinor: 725 };

test('recordTipWithRetry: a connection reset is retried and the tip lands', async () => {
  const { ops } = world({ job: inflight() });
  ops.fault(isJobWrite, 'reset');
  assert.equal(await recordTipWithRetry(ops, TIP), 'recorded');
  assert.equal(jobOf(ops).tip_minor, 72);
  assert.equal(jobOf(ops).charge_minor, 797);
  assert.equal(ops.count('terminal_jobs', 'update'), 2);
});

test('recordTipWithRetry: a write that landed with its reply lost is recorded, never written twice', async () => {
  const { ops } = world({ job: inflight() });
  ops.fault(isJobWrite, 'lost_reply');
  assert.equal(await recordTipWithRetry(ops, TIP), 'recorded');
  assert.equal(ops.count('terminal_jobs', 'update'), 1);
  assert.equal(jobOf(ops).tip_minor, 72);
});

test('recordTipWithRetry: a database that never answers leaves the job untouched and says unrecorded', async () => {
  const { ops } = world({ job: inflight() });
  ops.fault((q) => q.table === 'terminal_jobs', 'reset', 99);
  assert.equal(await recordTipWithRetry(ops, TIP), 'unrecorded');
  ops.faults = [];
  assert.equal(jobOf(ops).tip_minor, null);
  assert.equal(jobOf(ops).charge_minor, 725);
  assert.equal(ops.count('terminal_jobs', 'update'), 3, 'three attempts');
});

test('recordTipWithRetry: settled elsewhere, a conflicting tip, a definitive refusal', async () => {
  let w = world({ job: inflight({ status: 'approved' }) });
  assert.equal(await recordTipWithRetry(w.ops, TIP), 'settled_elsewhere');
  w = world({ job: inflight({ tip_minor: 50, charge_minor: 775 }) });
  assert.equal(await recordTipWithRetry(w.ops, TIP), 'conflict');
  w = world({ job: inflight() });
  w.ops.fault(isJobWrite, { message: 'violates check constraint "tj_charge_identity"', code: '23514' }, 5);
  assert.equal(await recordTipWithRetry(w.ops, TIP), 'conflict', 'no point retrying a constraint');
  assert.equal(w.ops.count('terminal_jobs', 'update'), 1);
});

test('settleRpcWithRetry: retries, reads a landed settle back, defers when nothing answers', async () => {
  const w = world({ job: inflight({ tip_minor: 72, charge_minor: 797 }) });
  w.ops.rpcs.terminal_job_settle_from_processor = async (a) => {
    const j = jobOf(w.ops);
    if (j.status === 'approved') return { data: { ok: true, idempotent: true, status: 'approved' }, error: null };
    Object.assign(j, { status: 'approved', needs_human: false, settled_at: '2026-09-29T09:56:38Z' });
    return { data: { ok: true, status: 'approved', needs_human: false, args: a }, error: null };
  };
  w.ops.fault((q) => q.op === 'rpc', 'lost_reply');
  const out = await settleRpcWithRetry(w.ops, { p_job_id: JOB_ID, p_outcome: 'approved' });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'approved');
  assert.equal(out.idempotent, true, 'read back after a lost reply');

  const d = world({ job: inflight() });
  d.ops.rpcs.terminal_job_settle_from_processor = async () => ({ data: { ok: true }, error: null });
  d.ops.fault((q) => q.op === 'rpc' || q.table === 'terminal_jobs', 'reset', 99);
  await assert.rejects(settleRpcWithRetry(d.ops, { p_job_id: JOB_ID }), (e) => e instanceof SettleDeferred && isSettleDeferred(e) && e.code === 'SETTLE_DEFERRED');

  const r = world({ job: inflight() });
  r.ops.rpcs.terminal_job_settle_from_processor = async () => ({ data: null, error: { message: 'job not found', code: 'P0001' } });
  await assert.rejects(settleRpcWithRetry(r.ops, { p_job_id: JOB_ID }), (e) => !isSettleDeferred(e) && /job not found/.test(e.message));
});

test('logDurable: a fixed key is written once, and a failure never throws', async () => {
  const { platform } = world();
  assert.equal(await logDurable(platform, 'k1', { a: 1 }), true);
  assert.equal(await logDurable(platform, 'k1', { a: 2 }), false);
  platform.fault(() => true, 'reset');
  assert.equal(await logDurable(platform, 'k2', {}), false);
  assert.deepEqual(keys(platform), ['k1']);
});

// ── SELF-CORRECT: every ordering of the race ─────────────────────────────────

test('till booked first (7.25): heal the job, correct the sale to 7.97, reconcile, one activity row', async () => {
  const { ops, platform } = world({ check: bookedCheck() });
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'corrected' });

  const j = jobOf(ops);
  assert.equal(j.tip_minor, 72);
  assert.equal(j.charge_minor, 797);
  assert.equal(j.reported_minor, 797);
  assert.equal(j.needs_human, false);
  assert.equal(j.status, 'reconciled');
  assert.equal(j.last_error, `tip added from the card machine: +72 (Adyen ${PSP} took 797, bill 725); sale R3618 corrected from 725 to 797`);

  const c = checkOf(ops);
  assert.equal(c.tip, 0.72);
  assert.equal(c.total, 7.97);
  assert.equal(c.tenders[0].tip, 0.72);
  assert.equal(c.tenders[0].amount, 7.25);
  assert.ok(c.tenders[0].tip_added_at);
  assert.equal(c.subtotal, 7.25);
  assert.equal(c.tax_amount, 1.21);

  const acts = ops.rows('activity_events');
  assert.equal(acts.length, 1);
  assert.equal(acts[0].severity, 'info');
  assert.equal(acts[0].title, 'Tip added from the card machine: R3618');
  assert.equal(acts[0].ref_id, JOB_ID);
  assert.ok(acts[0].body.includes('£7.25') && acts[0].body.includes('£7.97') && acts[0].body.includes('£0.72'));
  assert.deepEqual(keys(platform).sort(), [`tip-heal-check:${JOB_ID}`, `tip-heal:${JOB_ID}`]);

  // A replay (webhook redelivery, the next sweep) finds nothing to do.
  assert.equal((await healReaderTip(ops, platform, JOB_ID, { trigger: 'webhook' })).outcome, 'not_parked');
  assert.equal(ops.rows('activity_events').length, 1);
  assert.equal(checkOf(ops).tip, 0.72);
});

test('heal before the till books (the webhook case): pending, then the till books 7.97 and the sweep finds it right', async () => {
  const { ops, platform } = world({ check: null });
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'webhook' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'pending' });
  const j = jobOf(ops);
  assert.equal(j.status, 'approved');
  assert.equal(j.needs_human, false, 'the reconciler may book it now');
  assert.equal(healNoteState(j.last_error), 'pending');
  assert.equal(ops.rows('activity_events').length, 0);

  // The till's reconciler re-fetches the healed job and books from its integers.
  ops.rows('closed_checks').push(bookedCheck({ tip: 0.72, total: 7.97, tenders: [{ tip: 0.72, amount: 7.25, method: 'card', psp_ref: TX, processor: 'adyen' }] }));
  const s = await correctHealedSale(ops, platform, jobOf(ops), { trigger: 'sweep' });
  assert.deepEqual(s, { state: 'right' });
  assert.equal(checkOf(ops).tip, 0.72, 'never added twice');
  assert.equal(jobOf(ops).status, 'reconciled');
  assert.ok(jobOf(ops).last_error.endsWith('; sale R3618 already right'));
  assert.equal(ops.rows('activity_events').length, 1);
  assert.ok(!ops.rows('activity_events')[0].body.includes('Z report'));
});

test('the till read the job BEFORE the heal and booked 7.25 after it: the pending pass corrects it', async () => {
  const { ops, platform } = world({ check: null });
  await healReaderTip(ops, platform, JOB_ID, { trigger: 'webhook' });
  // Stale insert (DO NOTHING on the PK) from the pre-heal job, then the till marks it reconciled.
  ops.rows('closed_checks').push(bookedCheck());
  jobOf(ops).status = 'reconciled';
  const s = await correctHealedSale(ops, platform, jobOf(ops), { trigger: 'sweep' });
  assert.deepEqual(s, { state: 'corrected' });
  assert.equal(checkOf(ops).total, 7.97);
  assert.equal(jobOf(ops).status, 'reconciled');
  assert.equal(healNoteState(jobOf(ops).last_error), 'corrected');
});

test('concurrent healers (settle, webhook, sweep) at once: one correction, one activity row', async () => {
  const { ops, platform } = world({ check: bookedCheck() });
  const out = await Promise.all([
    healReaderTip(ops, platform, JOB_ID, { trigger: 'settle' }),
    healReaderTip(ops, platform, JOB_ID, { trigger: 'webhook' }),
    healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' }),
  ]);
  assert.ok(out.some((r) => r.outcome === 'healed' && r.reason === 'corrected'), JSON.stringify(out));
  const c = checkOf(ops);
  assert.equal(c.tip, 0.72, 'the tip is on the sale once');
  assert.equal(c.total, 7.97);
  assert.equal(c.tenders[0].tip, 0.72);
  assert.equal(ops.rows('activity_events').length, 1);
  assert.equal(jobOf(ops).tip_minor, 72);
  // Anything left pending is finished by the next pass, still exactly once.
  if (healNoteState(jobOf(ops).last_error) === 'pending') await correctHealedSale(ops, platform, jobOf(ops), { trigger: 'sweep' });
  assert.equal(checkOf(ops).tip, 0.72);
  assert.equal(ops.rows('activity_events').length, 1);
});

test('the heal write lands but its reply is lost: still healed, the sale corrected once', async () => {
  const { ops, platform } = world({ check: bookedCheck() });
  ops.fault((q) => isJobWrite(q) && q.patch?.tip_minor === 72, 'lost_reply');
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'corrected' });
  assert.equal(checkOf(ops).tip, 0.72);
});

test('the sale write fails: left pending for the next pass, nothing doubled', async () => {
  const { ops, platform } = world({ check: bookedCheck() });
  // The one sale write fails (applyTipToClosedCheck does not retry on its own).
  ops.fault((q) => q.table === 'closed_checks' && q.op === 'update', 'reset', 1);
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'pending' });
  assert.equal(checkOf(ops).tip, 0);
  assert.equal(healNoteState(jobOf(ops).last_error), 'pending');
  const s = await correctHealedSale(ops, platform, jobOf(ops), { trigger: 'sweep' });
  assert.deepEqual(s, { state: 'corrected' });
  assert.equal(checkOf(ops).tip, 0.72);
});

test('the sale changes between the plan and the write: the compare-and-set refuses, the next pass converges', async () => {
  const { ops, platform } = world({ check: bookedCheck() });
  let reads = 0;
  ops.fault((q) => {
    if (q.table === 'closed_checks' && q.op === 'select' && ++reads === 2) {
      // Someone else adds 0.50 of tip to the sale (a manual edit) right after our plan read it.
      Object.assign(checkOf(ops), { tip: 0.5, total: 7.75, tenders: [{ tip: 0.5, amount: 7.25, method: 'card', psp_ref: TX, processor: 'adyen' }] });
    }
    return false;
  }, 'reset');
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'pending' });
  assert.equal(checkOf(ops).tip, 0.5, 'the stale plan never wrote');
  // Next pass: target 0.72, current 0.50, so it adds exactly the 0.22 still missing.
  assert.deepEqual(await correctHealedSale(ops, platform, jobOf(ops), { trigger: 'sweep' }), { state: 'corrected' });
  assert.equal(checkOf(ops).tip, 0.72);
  assert.equal(checkOf(ops).total, 7.97);
  assert.equal(checkOf(ops).tenders[0].tip, 0.72);
});

test('a manager acknowledged it first: the heal never overrides a person', async () => {
  const { ops, platform } = world({ job: parkedJob({ needs_human: false, last_error: 'amount mismatch: processor 797 vs server 725' }), check: bookedCheck() });
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.equal(r.outcome, 'not_parked');
  assert.equal(jobOf(ops).tip_minor, null);
  assert.equal(checkOf(ops).tip, 0);
  assert.equal(ops.count('terminal_jobs', 'update'), 0);
});

test('a manager acknowledges between the plan and the write: stop, no alert', async () => {
  const { ops, platform } = world({ check: bookedCheck() });
  let flipped = false;
  ops.fault((q) => {
    if (!flipped && isJobWrite(q) && q.patch?.tip_minor === 72) { flipped = true; jobOf(ops).needs_human = false; }
    return false;
  }, 'reset');
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'refuse', reason: 'changed_meanwhile' });
  assert.equal(jobOf(ops).tip_minor, null);
  assert.equal(ops.rows('activity_events').length, 0);
});

test('a refunded sale is not corrected: the note says so and a manager is alerted once', async () => {
  const { ops, platform } = world({ check: bookedCheck({ refunds: [{ amount: 7.25 }], status: 'refunded' }) });
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'not_corrected' });
  assert.equal(healNoteState(jobOf(ops).last_error), 'not_corrected');
  assert.equal(jobOf(ops).status, 'approved', 'not reconciled by the heal');
  assert.equal(checkOf(ops).tip, 0);
  const acts = ops.rows('activity_events');
  assert.equal(acts.length, 1);
  assert.equal(acts[0].severity, 'action');
  assert.ok(acts[0].title.startsWith('Tip not on the sale'));
  assert.ok(keys(platform).includes(`amount-alert:${JOB_ID}:sale`));
});

// ── ALERT ────────────────────────────────────────────────────────────────────

test('over the cap: never healed, both amounts stored and alerted once', async () => {
  const job = parkedJob({ last_error: 'amount mismatch: processor 1300 vs server 725' });
  const { ops, platform } = world({ job, check: bookedCheck(), ledger: [ledgerRow({ amount_minor: 1300, raw: { authorisation: { amount: { value: 1300 } } } })] });
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'refuse', reason: 'over_cap' });
  const j = jobOf(ops);
  assert.equal(j.tip_minor, null);
  assert.equal(j.needs_human, true);
  assert.equal(j.reported_minor, 1300, 'Back Office now shows both figures');
  const acts = ops.rows('activity_events');
  assert.equal(acts.length, 1);
  assert.equal(acts[0].severity, 'action');
  assert.equal(acts[0].title, 'Card amount differs: R3618');
  assert.ok(acts[0].body.includes('£13.00') && acts[0].body.includes('£7.25'));
  await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  await healReaderTip(ops, platform, JOB_ID, { trigger: 'webhook' });
  assert.equal(ops.rows('activity_events').length, 1, 'exactly once');
});

test('Adyen has not confirmed it: quiet at settle time, alerted by the sweep after 5 minutes', async () => {
  const { ops, platform } = world({ ledger: [] });
  const settledAt = Date.parse('2026-09-29T09:56:38.078Z');
  assert.deepEqual(await healReaderTip(ops, platform, JOB_ID, { trigger: 'settle', now: settledAt + 1000 }), { outcome: 'wait', reason: 'no_ledger_row' });
  assert.deepEqual(await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep', now: settledAt + 60_000 }), { outcome: 'wait', reason: 'no_ledger_row' });
  assert.equal(ops.rows('activity_events').length, 0);
  await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep', now: settledAt + 6 * 60_000 });
  const acts = ops.rows('activity_events');
  assert.equal(acts.length, 1);
  assert.ok(acts[0].body.includes('Adyen has not confirmed this payment yet'));
  assert.equal(jobOf(ops).reported_minor, 797);
});

test('an unreadable ledger decides nothing', async () => {
  const { ops, platform } = world();
  platform.fault((q) => q.table === 'adyen_payments', 'reset');
  assert.deepEqual(await healReaderTip(ops, platform, JOB_ID, { trigger: 'webhook' }), { outcome: 'wait', reason: 'ledger_unreadable' });
  assert.equal(jobOf(ops).tip_minor, null);
});

test('alertOnce: an alert row that cannot be written is simply written by the next pass, once', async () => {
  const { ops, platform } = world();
  ops.fault((q) => q.table === 'activity_events' && q.op === 'insert', 'reset', 3);
  const facts = { reason: 'over_cap', reportedMinor: 1300, chargeMinor: 725 };
  assert.equal(await alertOnce(ops, platform, parkedJob(), 'refuse', facts), 'failed');
  assert.equal(keys(platform).length, 0, 'no gate left behind to go stale');
  assert.equal(await alertOnce(ops, platform, parkedJob(), 'refuse', facts), 'inserted');
  assert.equal(await alertOnce(ops, platform, parkedJob(), 'refuse', facts), 'exists');
  assert.equal(ops.rows('activity_events').length, 1);
  assert.ok(keys(platform).includes(`amount-alert:${JOB_ID}`), 'the audit copy');
});

test('alertOnce: an insert that lands with its reply lost is never written twice', async () => {
  const { ops, platform } = world();
  ops.fault((q) => q.table === 'activity_events' && q.op === 'insert', 'lost_reply', 1);
  assert.equal(await alertOnce(ops, platform, parkedJob(), 'refuse', { reason: 'over_cap', reportedMinor: 1300, chargeMinor: 725 }), 'exists');
  assert.equal(ops.rows('activity_events').length, 1, 'the retry met the primary key');
  // Even when EVERY reply is lost, the rows that landed stay one row.
  ops.fault((q) => q.table === 'activity_events' && q.op === 'insert', 'lost_reply', 3);
  assert.equal(await alertOnce(ops, platform, parkedJob(), 'wait', { reason: 'no_ledger_row', reportedMinor: 1300, chargeMinor: 725 }), 'failed');
  assert.equal(ops.rows('activity_events').length, 2, 'the wait alert landed once, not three times');
  // And the next sweep pass, every minute, adds nothing.
  ops.faults = [];
  assert.equal(await alertOnce(ops, platform, parkedJob(), 'wait', { reason: 'no_ledger_row', reportedMinor: 1300, chargeMinor: 725 }), 'exists');
  assert.equal(await alertOnce(ops, platform, parkedJob(), 'refuse', { reason: 'over_cap', reportedMinor: 1300, chargeMinor: 725 }), 'exists');
  assert.equal(ops.rows('activity_events').length, 2, 'one per subject, however often asked');
});

test('a "not confirmed yet" alert never swallows the real refusal that follows it', async () => {
  const job = parkedJob({ last_error: 'amount mismatch: processor 1300 vs server 725' });
  const { ops, platform } = world({ job, check: bookedCheck(), ledger: [] });
  const settledAt = Date.parse(job.settled_at);
  await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep', now: settledAt + 6 * 60_000 });
  assert.equal(ops.rows('activity_events').length, 1);
  assert.ok(ops.rows('activity_events')[0].body.includes('Adyen has not confirmed'));
  // Adyen's row lands 6 minutes late, over the cap.
  platform.rows('adyen_payments').push(ledgerRow({ amount_minor: 1300, raw: { authorisation: { amount: { value: 1300 } } } }));
  assert.deepEqual(await healReaderTip(ops, platform, JOB_ID, { trigger: 'webhook' }), { outcome: 'refuse', reason: 'over_cap' });
  const acts = ops.rows('activity_events');
  assert.equal(acts.length, 2);
  assert.ok(acts[1].body.includes('bigger than a tip is allowed'), acts[1].body);
});

test('ensureReportedMinor only fills an empty figure on a job still parked', async () => {
  const { ops } = world({ job: parkedJob({ reported_minor: 700 }) });
  await ensureReportedMinor(ops, JOB_ID, 797);
  assert.equal(jobOf(ops).reported_minor, 700);
  const w = world({ job: parkedJob({ needs_human: false }) });
  await ensureReportedMinor(w.ops, JOB_ID, 797);
  assert.equal(jobOf(w.ops).reported_minor, null);
});

test('reportParkedMismatch: only after a NEW park with a different amount', async () => {
  const { ops, platform } = world({ check: bookedCheck() });
  await reportParkedMismatch(ops, platform, JOB_ID, { ok: true, idempotent: true, status: 'approved', needs_human: true }, { success: true, authorizedMinor: 797, chargeMinor: 725, source: 'charge_sync' });
  assert.equal(jobOf(ops).reported_minor, null, 'an idempotent answer changes nothing');
  await reportParkedMismatch(ops, platform, JOB_ID, { ok: true, status: 'approved', needs_human: true }, { success: true, authorizedMinor: 797, chargeMinor: 725, source: 'charge_sync', evidence: { tipMinor: 72 } });
  assert.ok(keys(platform).includes(`amount-mismatch:${JOB_ID}`), 'the reader evidence is stored');
  assert.equal(jobOf(ops).tip_minor, 72, 'and the heal ran (Adyen had already answered)');
  assert.equal(checkOf(ops).total, 7.97);
});

// ── lost replies after the sale write (the incident's failure class) ────────

test('the sale correction lands but its reply is lost: still reported as CORRECTED, with the re-run advice', async () => {
  const { ops, platform } = world({ check: bookedCheck() });
  ops.fault((q) => q.table === 'closed_checks' && q.op === 'update', 'lost_reply', 1);
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'corrected' });
  assert.equal(checkOf(ops).total, 7.97, 'written once');
  assert.equal(checkOf(ops).tip, 0.72);
  assert.equal(jobOf(ops).last_error, `tip added from the card machine: +72 (Adyen ${PSP} took 797, bill 725); sale R3618 corrected from 725 to 797`);
  const acts = ops.rows('activity_events');
  assert.equal(acts.length, 1);
  assert.ok(acts[0].body.includes('Z report') && acts[0].body.includes('£7.25'), acts[0].body);
  const intent = platform.rows('adyen_webhook_events').find((e) => e.event_key === `tip-heal-check:${JOB_ID}`);
  assert.equal(intent.raw.delta_minor, 72);
  assert.equal(intent.raw.before.total, 7.25, 'the figures BEFORE the correction, written before it');
});

test('a later pass that finds the heal already on the sale (its reply lost AND the re-read failed) still says corrected', async () => {
  const { ops, platform } = world({ check: bookedCheck() });
  let n = 0;
  // The update lands with its reply lost, then the immediate re-read fails too.
  ops.fault((q) => q.table === 'closed_checks' && q.op === 'update', 'lost_reply', 1);
  ops.fault((q) => q.table === 'closed_checks' && q.op === 'select' && ++n === 3, 'reset', 1);
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'pending' });
  assert.equal(checkOf(ops).total, 7.97);
  assert.equal(ops.rows('activity_events').length, 0);
  // The next pass: tender tip = target, carrying the heal's own marker.
  assert.deepEqual(await correctHealedSale(ops, platform, jobOf(ops), { trigger: 'sweep' }), { state: 'corrected' });
  assert.ok(jobOf(ops).last_error.endsWith('; sale R3618 corrected from 725 to 797'));
  assert.ok(ops.rows('activity_events')[0].body.includes('Z report'));
  assert.equal(checkOf(ops).total, 7.97, 'never added twice');
});

test('the note write lands but its reply is lost: the pass still finishes (reconciled, one activity row)', async () => {
  const { ops, platform } = world({ check: bookedCheck() });
  ops.fault((q) => isJobWrite(q) && typeof q.patch?.last_error === 'string' && q.patch.last_error.includes('corrected from'), 'lost_reply', 1);
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'corrected' });
  assert.equal(healNoteState(jobOf(ops).last_error), 'corrected');
  assert.equal(jobOf(ops).status, 'reconciled');
  assert.equal(ops.rows('activity_events').length, 1);
});

test('a sale alert that cannot be written keeps the note pending, so the next pass tells them', async () => {
  const { ops, platform } = world({ check: bookedCheck({ refunds: [{ amount: 7.25 }] }) });
  ops.fault((q) => q.table === 'activity_events' && q.op === 'insert', 'reset', 3);
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'pending' });
  assert.equal(healNoteState(jobOf(ops).last_error), 'pending', 'still in the sweep');
  assert.equal(ops.rows('activity_events').length, 0);
  assert.deepEqual(await correctHealedSale(ops, platform, jobOf(ops), { trigger: 'sweep' }), { state: 'not_corrected', reason: 'refunded' });
  assert.equal(healNoteState(jobOf(ops).last_error), 'not_corrected');
  assert.equal(ops.rows('activity_events').length, 1);
  assert.ok(ops.rows('activity_events')[0].title.startsWith('Tip not on the sale'));
});

// ── a PARTIAL pay-at-table leg ───────────────────────────────────────────────

const LEG2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const KEY = `${LOC}:t12:ORD-7`;
const partialParked = () => parkedJob({ check_key: KEY, closed_check_id: 'chk-leg1', check_draft: { source: 'adyen_pay_at_table', partial: true } });
const finalJob = (priorTip, priorCharge) => ({
  id: LEG2, location_id: LOC, check_key: KEY, status: 'reconciled', processor: 'adyen', closed_check_id: 'chk-final',
  check_draft: { source: 'adyen_pay_at_table', priorLegs: [{ jobId: JOB_ID, transactionId: TX, dueMinor: 725, tipMinor: priorTip, chargeMinor: priorCharge }] },
});
const splitCheck = (priorTip) => ({
  id: 'chk-final', ref: 'R9001', location_id: LOC, status: 'paid', voided: false, refunds: [],
  tip: priorTip / 100, total: +(12.25 + priorTip / 100).toFixed(2),
  tenders: [{ method: 'card', amount: 5, tip: 0, psp_ref: 'POI2.LEG2PSP' }, { method: 'card', amount: 7.25, tip: priorTip / 100, psp_ref: TX }],
  payment_intents: [{ id: 'POI2.LEG2PSP', amountMinor: 500 }, { id: TX, amountMinor: 725 + priorTip }],
});
const finalCheckOf = (ops) => ops.rows('closed_checks').find((c) => c.id === 'chk-final');

test('split leg healed before the final leg: no alert, then the final sale (built from the healed snapshot) is already right', async () => {
  const { ops, platform } = world({ job: partialParked() });
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'webhook' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'pending' });
  assert.equal(ops.rows('activity_events').length, 0, 'no "correct it by hand" alert');
  // Guest 2 pays; terminal_start_table_payment_for snapshots the HEALED leg (tip 72, charge 797).
  ops.rows('terminal_jobs').push(finalJob(72, 797));
  ops.rows('closed_checks').push(splitCheck(72));
  assert.deepEqual(await correctHealedSale(ops, platform, jobOf(ops), { trigger: 'sweep' }), { state: 'right' });
  assert.equal(finalCheckOf(ops).tip, 0.72, 'never credited twice');
  assert.ok(jobOf(ops).last_error.endsWith('; sale R9001 already right'));
  assert.equal(ops.rows('activity_events').length, 1);
  assert.equal(ops.rows('activity_events')[0].severity, 'info');
});

test('split leg healed after the final leg booked it without the tip: the final sale gets the 72p on that leg', async () => {
  const { ops, platform } = world({ job: partialParked() });
  ops.rows('terminal_jobs').push(finalJob(0, 725));
  ops.rows('closed_checks').push(splitCheck(0));
  const r = await healReaderTip(ops, platform, JOB_ID, { trigger: 'sweep' });
  assert.deepEqual(r, { outcome: 'healed', reason: 'corrected' });
  const c = finalCheckOf(ops);
  assert.equal(c.tip, 0.72);
  assert.equal(c.total, 12.97);
  assert.equal(c.tenders[0].tip, 0);
  assert.equal(c.tenders[1].tip, 0.72);
  assert.deepEqual(c.payment_intents.map((l) => l.amountMinor), [500, 797]);
  assert.ok(jobOf(ops).last_error.endsWith('; sale R9001 corrected from 1225 to 1297'));
  assert.equal(ops.rows('activity_events').filter((a) => a.severity === 'action').length, 0);
});

test('notes stay machine readable after every step', () => {
  const pending = healNote({ tipMinor: 72, psp: PSP, amountMinor: 797, billMinor: 725 });
  assert.equal(healNoteState(pending), 'pending');
});
