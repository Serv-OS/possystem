/**
 * payoutsRowCap.test.js: the Payouts tab and the 1,000 row answer.
 *
 * 13 Oct 2026, owner: "payouts have stopped registering on the back office". Nothing had
 * stopped. supabase/functions/adyen-financial/index.ts read a venue's payout lines with
 * `.limit(5000)`; hosted PostgREST answers at most 1,000 rows a request whatever the limit
 * says, and every venue was past 1,000 lines. Each venue's list stopped at the batch holding
 * its 1,000th line and showed that batch short (Barnsley: batch 19 came back with 64 of its
 * 168 lines, so its gross read at about a third of what the database held).
 *
 * These tests run the SHIPPED function, not a copy. Two small module hooks give it a fake
 * supabase-js in place of the esm.sh import (as offlineQueueFence.test.js does for the app),
 * and a stand in for Deno keeps the handler it serves. The fake database answers like the
 * real one where it matters here: at most 1,000 rows a request, in table order when no order
 * is asked for, and `eq` never matches a null. The last block pins the source.
 *
 * Run: `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';

const FN_URL = new URL('../../../supabase/functions/adyen-financial/index.ts', import.meta.url);
const SRC = fs.readFileSync(FN_URL, 'utf8');

// ── A PostgREST that answers at most 1,000 rows a request ───────────────────────────────────────
const MAX_ROWS = 1000;
let world = null;   // { ops: { table: rows }, platform: { table: rows }, requests: [], failOn }

class Query {
  constructor(side, table) {
    this.side = side; this.table = table;
    this.filters = []; this.orders = []; this.window = null; this.single = false;
  }
  select() { return this; }
  eq(col, val) { this.filters.push({ op: 'eq', col, val }); return this; }
  in(col, vals) { this.filters.push({ op: 'in', col, val: [...vals] }); return this; }
  not(col, op, val) {
    assert.equal(op, 'is', 'the fake only knows not(col, is, value)');
    this.filters.push({ op: 'not_is', col, val }); return this;
  }
  order(col, { ascending = true } = {}) { this.orders.push({ col, ascending }); return this; }
  range(from, to) { this.window = { from, to }; return this; }
  limit(n) { this.window = { from: 0, to: n - 1 }; this.bareLimit = n; return this; }
  maybeSingle() { this.single = true; return this; }
  then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }

  matching() {
    // One filter and sort per distinct query, so a 200,000 row read is not sifted 200 times.
    const key = JSON.stringify([this.side, this.table, this.filters, this.orders]);
    const cached = world.cache.get(key);
    if (cached) return cached;
    const keep = (row) => this.filters.every(({ op, col, val }) => {
      const v = row[col] ?? null;
      if (op === 'eq') return v !== null && v === val;             // SQL: null equals nothing
      if (op === 'in') return v !== null && val.includes(v);
      return v !== val;                                             // IS NOT true / IS NOT false
    });
    let rows = (world[this.side][this.table] ?? []).filter(keep);
    if (this.orders.length) {
      rows = [...rows].sort((a, b) => {
        for (const { col, ascending } of this.orders) {
          const x = a[col] ?? null; const y = b[col] ?? null;
          if (x === y) continue;
          if (x === null) return ascending ? 1 : -1;                // Postgres: nulls last going up
          if (y === null) return ascending ? -1 : 1;
          return (x < y ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
    }
    world.cache.set(key, rows);
    return rows;
  }

  run() {
    const request = { side: this.side, table: this.table, filters: this.filters, orders: this.orders, window: this.window, bareLimit: this.bareLimit ?? null, rows: [] };
    world.requests.push(request);
    const fail = world.failOn ? world.failOn(request, world.requests.filter((r) => r.table === this.table).length) : null;
    if (fail) return { data: null, error: { message: fail } };
    const all = this.matching();
    const from = this.window ? this.window.from : 0;
    const to = this.window ? this.window.to : all.length - 1;
    const rows = all.slice(from, Math.min(to + 1, from + MAX_ROWS));   // the server's own ceiling
    request.rows = rows;
    if (this.single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

const USER = 'user-1';
globalThis.__payoutsRowCapClient = (url) => {
  const side = String(url).includes('platform') ? 'platform' : 'ops';
  return {
    from: (table) => new Query(side, table),
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
  };
};

// ── Load the shipped function ───────────────────────────────────────────────────────────────────
const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2';
const STUB_URL = 'payouts-row-cap:supabase-js';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SUPABASE_JS) return { url: STUB_URL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === STUB_URL) {
      return { format: 'module', shortCircuit: true, source: 'export const createClient = (url, key) => globalThis.__payoutsRowCapClient(url, key);' };
    }
    return nextLoad(url, context);
  },
});

let handler = null;
const ENV = { SUPABASE_URL: 'https://ops.fake', SUPABASE_SERVICE_ROLE_KEY: 'ops-key', PLATFORM_SUPABASE_URL: 'https://platform.fake', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'platform-key' };
globalThis.Deno = { env: { get: (name) => ENV[name] }, serve: (h) => { handler = h; } };
await import(FN_URL.href);
assert.equal(typeof handler, 'function', 'the function handed its handler to Deno.serve');

// ── Venues and rows ─────────────────────────────────────────────────────────────────────────────
const BARNSLEY = { ops: 'ops-barnsley', id: 'loc-barnsley' };
const LEEDS = { ops: 'ops-leeds', id: 'loc-leeds' };
const VENUES = [BARNSLEY, LEEDS];

function newWorld({ environment = 'live' } = {}) {
  world = {
    ops: {
      user_locations: VENUES.map((v) => ({ user_id: USER, location_id: v.ops })),
      user_profiles: [{ id: USER, role: 'manager' }],
    },
    platform: {
      locations: VENUES.map((v) => ({ id: v.id, ops_location_id: v.ops, name: v.id, timezone: 'Europe/London', currency: 'GBP' })),
      merchant_adyen_accounts: VENUES.map((v) => ({ location_id: v.id, environment, region: 'UK' })),
      adyen_payouts: [],
      adyen_payout_lines: [],
      adyen_payments: [],
    },
    requests: [],
    cache: new Map(),
    failOn: null,
    nextLine: 1,
  };
  return world;
}

const day = (n) => new Date(Date.UTC(2026, 8, 12 + n)).toISOString().slice(0, 10);   // batch 1 = 13 Sep 2026

/** A settlement batch as adyen-report-ingest writes it. owner null = shared across venues. */
function addBatch(n, { owner = null, live = true } = {}) {
  const row = {
    id: `batch-${String(n).padStart(4, '0')}`, location_id: owner, payout_date: day(n), batch_number: n,
    reference: `settlement:FranPOS_QSR_UK:${n}`, merchant_account: 'FranPOS_QSR_UK', report_name: `settlement_detail_report_batch_${n}.csv`,
    amount_minor: 0, currency: 'GBP', status: 'settled', live,
  };
  world.platform.adyen_payouts.push(row);
  return row;
}

/** A bank transfer as adyen-bp-webhook writes it: the venue's own, no report, no lines. */
function addBankTransfer(n, venue) {
  const row = { id: `transfer-${String(n).padStart(5, '0')}`, location_id: venue.id, payout_date: day(n % 400), reference: `TR${n}`, amount_minor: 1000 + n, currency: 'GBP', status: 'booked', destination_last4: '1234', live: true };
  world.platform.adyen_payouts.push(row);
  return row;
}

/**
 * One Settled line in a batch, with the venue's payment behind it (its card rate fee).
 * `stamp` is the location on the LINE: the venue, or null for a line the ingest could not tie
 * to a venue (those only reach a venue through a batch it owns outright).
 */
function addLine(batch, venue, { stamp = venue.id, payment = true } = {}) {
  const id = world.nextLine++;
  const gross = 150 + (id % 850);
  const fee = 2 + (id % 9);
  const psp = `PSP${String(id).padStart(13, '0')}`;
  world.platform.adyen_payout_lines.push({ id, payout_id: batch.id, psp_reference: payment ? psp : null, line_type: 'Settled', gross_minor: gross, currency: 'GBP', location_id: stamp });
  if (payment) {
    world.platform.adyen_payments.push({ psp_reference: psp, location_id: venue.id, merchant_reference: `R${id}`, channel: 'pos', success: true, last_event_code: 'AUTHORISATION', amount_minor: gross, amount_refunded_minor: 0, commission_minor: fee, created_at: `${batch.payout_date}T12:00:00Z`, live: batch.live });
  }
  return { gross, fee };
}

/** What the screen must show for one venue's lines in one batch, added up here by hand. */
function tally(parts) {
  const gross = parts.reduce((s, p) => s + p.gross, 0);
  const fees = parts.reduce((s, p) => s + p.fee, 0);
  return { line_count: parts.length, gross_minor: gross, fees_minor: fees, receives_minor: gross - fees };
}

async function call(venue, body) {
  const res = await handler(new Request('https://fn.fake/adyen-financial', {
    method: 'POST',
    headers: { Authorization: 'Bearer a-signed-in-session', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops_location_id: venue.ops, ...body }),
  }));
  return { status: res.status, body: await res.json() };
}
const lineReads = () => world.requests.filter((r) => r.table === 'adyen_payout_lines');
const figures = (p) => ({ line_count: p.line_count, gross_minor: p.gross_minor, fees_minor: p.fees_minor, receives_minor: p.receives_minor });

/**
 * Barnsley as it was on 13 Oct 2026, in small: 2,199 lines over 8 shared batches, the 1,000th
 * line 64 lines into a batch of 168. Leeds trades in the same batches, its lines mixed through
 * Barnsley's, and the batch of 168 holds 3,100 lines in all.
 */
const BARNSLEY_LINES = [312, 312, 312, 168, 280, 280, 280, 255];
const SHORT_BATCH = 4;
function barnsleyWorld(opts) {
  newWorld(opts);
  const expected = new Map();   // batch id -> Barnsley's tally
  const batches = BARNSLEY_LINES.map((count, i) => {
    const batch = addBatch(i + 1);
    const leeds = i + 1 === SHORT_BATCH ? 3100 - count : Math.round(count * 1.3);
    const mine = [];
    // Spread Barnsley's lines evenly through the batch, as a real report does.
    let owed = 0;
    for (let k = 0; k < count + leeds; k++) {
      owed += count;
      if (owed >= count + leeds) { owed -= count + leeds; mine.push(addLine(batch, BARNSLEY)); }
      else addLine(batch, LEEDS);
    }
    assert.equal(mine.length, count);
    expected.set(batch.id, tally(mine));
    return batch;
  });
  return { batches, expected };
}

// ── The list ────────────────────────────────────────────────────────────────────────────────────

test('the fake really is the fault: a bare limit(5000) comes back as the first 1,000 rows', async () => {
  barnsleyWorld();
  const { data } = await new Query('platform', 'adyen_payout_lines').select('id').eq('location_id', BARNSLEY.id).limit(5000);
  assert.equal(data.length, 1000);
  assert.equal(world.platform.adyen_payout_lines.filter((l) => l.location_id === BARNSLEY.id).length, 2199);
  // The 1,000th line falls 64 lines into the batch of 168, as it did for Barnsley's batch 19.
  const short = data.filter((l) => l.payout_id === `batch-000${SHORT_BATCH}`).length;
  assert.equal(short, 64);
});

test('payouts: 2,199 lines over 8 batches come back as 8 full batches', async () => {
  const { batches, expected } = barnsleyWorld();
  const { status, body } = await call(BARNSLEY, { action: 'payouts' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.payouts.length, 8);
  assert.deepEqual(body.payouts.map((p) => p.batch_number), [8, 7, 6, 5, 4, 3, 2, 1], 'newest first, none missing');
  for (const p of body.payouts) {
    assert.deepEqual(figures(p), expected.get(p.id), `batch ${p.batch_number} is whole`);
    assert.equal(p.kind, 'settlement');
    assert.equal(p.shared, true);
    assert.equal(p.fees_unrated, 0);
  }
  assert.equal(body.payouts.reduce((s, p) => s + p.line_count, 0), 2199);
  assert.equal(body.payouts.find((p) => p.id === batches[SHORT_BATCH - 1].id).line_count, 168, 'the batch that showed short');

  // It got there in pages, in a stable order, and never asked for another venue's lines.
  const reads = lineReads();
  assert.deepEqual(reads.map((r) => r.window), [{ from: 0, to: 999 }, { from: 1000, to: 1999 }, { from: 2000, to: 2999 }]);
  for (const r of reads) {
    assert.deepEqual(r.orders, [{ col: 'id', ascending: true }]);
    assert.equal(r.bareLimit, null);
    assert.ok(r.rows.length <= MAX_ROWS);
    assert.ok(r.rows.every((l) => l.location_id === BARNSLEY.id));
  }
  // The response shape is the one the screen reads.
  assert.deepEqual(Object.keys(body).sort(), ['environment', 'ok', 'payouts', 'timezone']);
  assert.deepEqual(Object.keys(body.payouts[0]).sort(), [
    'batch_number', 'currency', 'destination_last4', 'fees_minor', 'fees_unrated', 'gross_minor', 'id', 'kind',
    'line_count', 'payout_date', 'receives_minor', 'reference', 'shared', 'status',
  ]);
});

test('payouts: batches a venue owns outright are whole too, lines the ingest could not place included', async () => {
  newWorld();
  const expected = new Map();
  // Three batches all Barnsley's own, 4,600 lines: every other line carries no venue, so only
  // the read by payout id finds it. The three ids travel in ONE request and page together.
  for (const [i, count] of [1400, 2300, 900].entries()) {
    const batch = addBatch(i + 1, { owner: BARNSLEY.id });
    const mine = [];
    for (let k = 0; k < count; k++) mine.push(addLine(batch, BARNSLEY, { stamp: k % 2 ? null : BARNSLEY.id }));
    expected.set(batch.id, tally(mine));
  }
  const { status, body } = await call(BARNSLEY, { action: 'payouts' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.payouts.length, 3);
  for (const p of body.payouts) {
    assert.deepEqual(figures(p), expected.get(p.id), `batch ${p.batch_number} is whole`);
    assert.equal(p.shared, false);
  }
  const byPayout = lineReads().filter((r) => r.filters.some((f) => f.op === 'in' && f.col === 'payout_id'));
  assert.deepEqual(byPayout.map((r) => r.window.from), [0, 1000, 2000, 3000, 4000]);
  assert.ok(byPayout.every((r) => r.orders.length === 1 && r.orders[0].col === 'id' && r.bareLimit === null));
});

test('payouts: batch 101 and payout 1,001 are not dropped', async () => {
  newWorld();
  // 130 shared batches with Barnsley lines in each (the old read asked for the first 100 ids).
  const expected = new Map();
  for (let n = 1; n <= 130; n++) {
    const batch = addBatch(n);
    expected.set(batch.id, tally([addLine(batch, BARNSLEY), addLine(batch, BARNSLEY)]));
    addLine(batch, LEEDS);
  }
  // 1,250 bank transfers of its own (the old read stopped at 100; one request stops at 1,000).
  for (let n = 1; n <= 1250; n++) addBankTransfer(n, BARNSLEY);
  const { status, body } = await call(BARNSLEY, { action: 'payouts' });
  assert.equal(status, 200, JSON.stringify(body));
  const settlements = body.payouts.filter((p) => p.kind === 'settlement');
  const transfers = body.payouts.filter((p) => p.kind === 'bank_transfer');
  assert.equal(settlements.length, 130);
  assert.equal(new Set(settlements.map((p) => p.id)).size, 130);
  for (const p of settlements) assert.deepEqual(figures(p), expected.get(p.id));
  assert.equal(transfers.length, 1250);
  assert.equal(new Set(transfers.map((p) => p.id)).size, 1250);
  assert.ok(transfers.every((p) => p.receives_minor > 1000 && p.gross_minor === null && p.line_count === null));
  // Newest first across both kinds.
  const dates = body.payouts.map((p) => p.payout_date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

// ── One payout ──────────────────────────────────────────────────────────────────────────────────

test('payout_detail: a venue gets all 168 of its lines from a shared batch of 3,100, and no other venue\'s line is ever fetched', async () => {
  const { batches, expected } = barnsleyWorld();
  const batch = batches[SHORT_BATCH - 1];
  assert.equal(world.platform.adyen_payout_lines.filter((l) => l.payout_id === batch.id).length, 3100);
  const { status, body } = await call(BARNSLEY, { action: 'payout_detail', payout_id: batch.id });
  assert.equal(status, 200, JSON.stringify(body));
  const want = expected.get(batch.id);
  assert.equal(body.lines.length, 168);
  assert.equal(body.payout.shared, true);
  assert.equal(body.payout.gross_minor, want.gross_minor);
  assert.equal(body.payout.fees_minor, want.fees_minor);
  assert.equal(body.payout.receives_minor, want.receives_minor);
  assert.equal(body.lines.reduce((s, l) => s + l.gross_minor, 0), want.gross_minor);
  assert.ok(body.lines.every((l) => l.payment && l.payment.merchant_reference), 'each line is joined to the venue\'s own payment');
  // The fence is in the query: the database was asked for Barnsley's lines of this batch alone.
  const reads = lineReads();
  assert.ok(reads.length >= 1);
  for (const r of reads) {
    assert.ok(r.filters.some((f) => f.op === 'eq' && f.col === 'payout_id' && f.val === batch.id));
    assert.ok(r.filters.some((f) => f.op === 'eq' && f.col === 'location_id' && f.val === BARNSLEY.id));
    assert.deepEqual(r.orders, [{ col: 'id', ascending: true }]);
    assert.equal(r.bareLimit, null);
    assert.ok(r.rows.every((l) => l.location_id === BARNSLEY.id), 'no line of another venue left the database');
  }
  assert.deepEqual(Object.keys(body).sort(), ['environment', 'lines', 'ok', 'payout', 'timezone']);
});

test('payout_detail: a batch the venue owns outright comes back whole past 1,000 lines', async () => {
  newWorld();
  const batch = addBatch(1, { owner: BARNSLEY.id });
  const mine = [];
  for (let k = 0; k < 2300; k++) mine.push(addLine(batch, BARNSLEY, { stamp: k % 2 ? null : BARNSLEY.id }));
  const { status, body } = await call(BARNSLEY, { action: 'payout_detail', payout_id: batch.id });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.lines.length, 2300);
  assert.equal(body.payout.shared, false);
  assert.equal(body.payout.gross_minor, tally(mine).gross_minor);
  assert.equal(body.payout.receives_minor, tally(mine).receives_minor);
  assert.deepEqual(lineReads().map((r) => r.window.from), [0, 1000, 2000]);
});

test('the fence holds: no lines in a batch is not found, and test and live never mix', async () => {
  // A shared batch with only Leeds lines: Barnsley cannot open it and it is not in its list.
  newWorld();
  const leedsOnly = addBatch(1);
  for (let k = 0; k < 1200; k++) addLine(leedsOnly, LEEDS);
  let out = await call(BARNSLEY, { action: 'payout_detail', payout_id: leedsOnly.id });
  assert.equal(out.status, 404);
  assert.equal(out.body.error, 'payout not found for this venue');
  assert.ok(lineReads().every((r) => r.rows.length === 0), 'and not one Leeds line was fetched to find that out');
  out = await call(BARNSLEY, { action: 'payouts' });
  assert.deepEqual(out.body.payouts, []);
  // A batch owned by Leeds is not Barnsley's either.
  const leedsOwn = addBatch(2, { owner: LEEDS.id });
  addLine(leedsOwn, LEEDS);
  world.cache.clear();
  out = await call(BARNSLEY, { action: 'payout_detail', payout_id: leedsOwn.id });
  assert.equal(out.status, 404);

  // A live venue holding lines in a TEST batch: not listed, not openable.
  newWorld({ environment: 'live' });
  const testBatch = addBatch(1, { live: false });
  const liveBatch = addBatch(2, { live: true });
  addLine(testBatch, BARNSLEY); addLine(liveBatch, BARNSLEY);
  out = await call(BARNSLEY, { action: 'payouts' });
  assert.deepEqual(out.body.payouts.map((p) => p.id), [liveBatch.id]);
  assert.equal(out.body.environment, 'live');
  assert.equal((await call(BARNSLEY, { action: 'payout_detail', payout_id: testBatch.id })).status, 404);
  assert.equal((await call(BARNSLEY, { action: 'payout_detail', payout_id: liveBatch.id })).status, 200);

  // And a test venue never sees the live one.
  newWorld({ environment: 'test' });
  const t = addBatch(1, { live: false });
  const l = addBatch(2, { live: true });
  addLine(t, BARNSLEY); addLine(l, BARNSLEY);
  out = await call(BARNSLEY, { action: 'payouts' });
  assert.deepEqual(out.body.payouts.map((p) => p.id), [t.id]);
  assert.equal((await call(BARNSLEY, { action: 'payout_detail', payout_id: l.id })).status, 404);
});

// ── Never a short list ──────────────────────────────────────────────────────────────────────────

test('a page that fails is an error answer, never the pages read so far', async () => {
  barnsleyWorld();
  // The second page of lines fails (the first 1,000 lines are already in hand).
  world.failOn = (r, nth) => (r.table === 'adyen_payout_lines' && nth === 2 ? 'upstream request timeout' : null);
  let out = await call(BARNSLEY, { action: 'payouts' });
  assert.equal(out.status, 500);
  assert.equal(out.body.error, 'payout lines read failed: upstream request timeout');
  assert.equal(out.body.payouts, undefined);

  const { batches } = barnsleyWorld();
  for (let k = 0; k < 1500; k++) addLine(batches[0], BARNSLEY);   // 1,812 of its lines in one batch
  world.failOn = (r, nth) => (r.table === 'adyen_payout_lines' && nth === 2 ? 'upstream request timeout' : null);
  out = await call(BARNSLEY, { action: 'payout_detail', payout_id: batches[0].id });
  assert.equal(out.status, 500);
  assert.equal(out.body.error, 'payout lines read failed: upstream request timeout');
  assert.equal(out.body.lines, undefined);

  // The venue's own payouts: same rule.
  newWorld();
  for (let n = 1; n <= 1250; n++) addBankTransfer(n, BARNSLEY);
  world.failOn = (r, nth) => (r.table === 'adyen_payouts' && nth === 2 ? 'upstream request timeout' : null);
  out = await call(BARNSLEY, { action: 'payouts' });
  assert.equal(out.status, 500);
  assert.equal(out.body.error, 'payouts read failed: upstream request timeout');
  assert.equal(out.body.payouts, undefined);
});

const ceilingOf = (name) => {
  const m = SRC.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `${name} is a plain number in the source`);
  return Number(m[1]);
};

test('the ceiling fails loudly: one line past it is an error answer, on the list and on the payout', async () => {
  const ceiling = ceilingOf('PAYOUT_LINES_CEILING');
  assert.ok(ceiling >= 100000, 'far above any venue (the busiest held about 3,400 lines after a month)');
  newWorld();
  const batch = addBatch(1);
  // Lines with no payment behind them keep this quick; the read is what is under test.
  for (let k = 0; k < ceiling; k++) addLine(batch, BARNSLEY, { payment: false });

  // Exactly at the ceiling the venue still gets every line.
  let out = await call(BARNSLEY, { action: 'payouts' });
  assert.equal(out.status, 200, JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.payouts[0].line_count, ceiling);

  addLine(batch, BARNSLEY, { payment: false });
  world.cache.clear(); world.requests = [];
  out = await call(BARNSLEY, { action: 'payouts' });
  assert.equal(out.status, 500);
  assert.match(out.body.error, /too many payout lines/);
  assert.match(out.body.error, /Contact ServOS support/);
  assert.equal(out.body.payouts, undefined, 'no list at all, not a short one');

  out = await call(BARNSLEY, { action: 'payout_detail', payout_id: batch.id });
  assert.equal(out.status, 500);
  assert.match(out.body.error, /too many payout lines/);
  assert.equal(out.body.lines, undefined);
  assert.equal(out.body.payout, undefined);
});

test('the ceiling fails loudly for the venue\'s own payouts too', async () => {
  const ceiling = ceilingOf('PAYOUT_BATCH_CEILING');
  assert.ok(ceiling >= 10000);
  newWorld();
  for (let n = 1; n <= ceiling + 1; n++) addBankTransfer(n, BARNSLEY);
  const out = await call(BARNSLEY, { action: 'payouts' });
  assert.equal(out.status, 500);
  assert.match(out.body.error, /too many payouts/);
  assert.equal(out.body.payouts, undefined);
});

// ── Source pins ─────────────────────────────────────────────────────────────────────────────────

/** The text of a call from its opening bracket to the matching close, quotes skipped. */
function callText(src, openAt) {
  let depth = 0; let quote = null;
  for (let i = openAt; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    if (c === ')') { depth--; if (depth === 0) return src.slice(openAt, i + 1); }
  }
  assert.fail('unbalanced call');
}
/** Code only: whole line comments are dropped so a note quoting the old read is not a hit. */
const CODE = SRC.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
const allIndexes = (s, text) => { const out = []; for (let i = s.indexOf(text); i >= 0; i = s.indexOf(text, i + 1)) out.push(i); return out; };

test('source: every read of adyen_payout_lines is inside readAllRows, ordered by id, with no limit', () => {
  const calls = allIndexes(CODE, 'readAllRows(')
    .filter((i) => !CODE.slice(Math.max(0, i - 15), i).includes('function '))
    .map((i) => ({ at: i, text: callText(CODE, i + 'readAllRows'.length) }));
  const lineReadsAt = allIndexes(CODE, "from('adyen_payout_lines')");
  assert.equal(lineReadsAt.length, 3, 'the venue\'s lines, the lines of owned batches, and one payout\'s lines');
  for (const at of lineReadsAt) {
    const inside = calls.find((c) => at > c.at && at < c.at + 'readAllRows'.length + c.text.length);
    assert.ok(inside, 'a read of payout lines outside readAllRows: ' + CODE.slice(at, at + 90));
    assert.ok(inside.text.includes(".order('id', { ascending: true })"), 'paged on the line id');
    assert.ok(!inside.text.includes('.limit('), 'no limit on a read of payout lines');
    assert.ok(/, PAYOUT_LINES_CEILING, 'payout lines'\)$/.test(inside.text), 'and under the lines ceiling');
  }
  // The venue's own payouts page too, newest first with the id as the tie break.
  const own = calls.find((c) => c.text.includes("from('adyen_payouts')"));
  assert.ok(own);
  assert.ok(own.text.includes(".order('payout_date', { ascending: false }).order('id', { ascending: true })"));
  assert.ok(/, PAYOUT_BATCH_CEILING, 'payouts'\)$/.test(own.text));
});

test('source: readAllRows is readPaged plus the rule that a short read is an error', () => {
  const at = CODE.indexOf('async function readAllRows(');
  assert.ok(at > 0);
  const body = CODE.slice(at, CODE.indexOf('\n}\n', at));
  assert.ok(body.includes('const read = await readPaged(build, ceiling);'));
  assert.ok(body.includes('if (read.error) return { rows: [], error:'), 'a failed page gives no rows');
  assert.ok(body.includes('if (read.capped) return { rows: [], error:'), 'the ceiling gives no rows');
  // And readPaged still asks one page past the ceiling to know.
  assert.ok(CODE.includes('await build().range(ceiling, ceiling)'));
});

test('source: nothing in the function asks for more than one request can carry, and no id list is cut short', () => {
  const limits = [...CODE.matchAll(/\.limit\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(limits.every((n) => n <= MAX_ROWS), 'a .limit above 1,000 is silently cut to 1,000: ' + limits.join(', '));
  assert.ok(!/Ids\.slice\(0,/.test(CODE), 'every batch id is read, a chunk at a time');
  assert.ok(CODE.includes('sharedIds.slice(i, i + PAYOUT_ID_CHUNK)'));
  assert.ok(CODE.includes('ownBatchIds.slice(i, i + PAYOUT_ID_CHUNK)'));
  // The detail asks the database for this venue's lines alone unless it owns the batch.
  assert.ok(CODE.includes("return (isOwner ? q : q.eq('location_id', loc.id)).order('id', { ascending: true });"));
});
