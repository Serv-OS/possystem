/**
 * readerRelease.test.js - what Back Office says after "Release stuck payment"
 * (src/lib/payments/readerRelease.js), run under plain node.
 *
 * 13 Oct 2026, Coffee Boy Huddersfield Drive Thru: a manager pressed Release at 07:41:18 and was
 * told "Nothing was stuck" while the till stayed locked for two more minutes. The two rules of
 * these words: never say the card machine can take payments again while a live payment remains,
 * and give a reason for every payment that was not released.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  releaseLines, askOutcome, jobsToAsk, RELEASE_LIVE_STATUSES, RELEASE_JOB_COLUMNS,
} from './readerRelease.js';
import { LIVE_STATUSES } from '../../../supabase/functions/_shared/repeatCharge.js';
import { NEVER_RECEIVED_REASON } from '../../../supabase/functions/_shared/readerLock.js';

const TZ = 'Europe/London';
const NO_DASH = /[–—]| - /;
const SENT = '2026-10-13T06:37:50.000Z';                 // 07:37:50 on the venue clock
const NOW = Date.parse('2026-10-13T06:38:40.000Z');      // 50 s after the send
const job = (over = {}) => ({
  id: 'df9c6528', status: 'charging', processor: 'adyen', charge_minor: 600, due_minor: 600, currency: 'GBP',
  dispatched_at: SENT, created_at: '2026-10-13T06:37:49.000Z', check_draft: { orderRef: 'R14202' }, ...over,
});
const settled = (job_status, extra = {}) => ({
  httpStatus: 200,
  body: { ok: true, state: job_status === 'reconciled' ? 'approved' : job_status === 'expired' ? 'cancelled' : job_status, status: job_status, job_status, decline_reason: null, ...extra },
});
const waiting = (why, extra = {}) => ({
  httpStatus: 200,
  body: {
    ok: true, state: 'processing', status: 'charging', why, since_send_ms: 50_000,
    retry_after: '2026-10-13T06:39:50.000Z', clears_by: '2026-10-13T06:40:50.000Z', ...extra,
  },
});
const lines = (asked, { still = [], rpc = { ok: true, expired: 0, released: 0 }, label = 'Drive Thru', now = NOW } = {}) =>
  releaseLines({ label, asked, rpc, still, tz: TZ, now });

test('the statuses and columns the page reads are the ones that hold a card machine', () => {
  assert.deepEqual([...RELEASE_LIVE_STATUSES], [...LIVE_STATUSES]);
  for (const col of ['id', 'status', 'processor', 'charge_minor', 'due_minor', 'currency', 'dispatched_at', 'created_at', 'check_draft']) {
    assert.ok(RELEASE_JOB_COLUMNS.split(', ').includes(col), col);
  }
});

test('jobsToAsk: only an Adyen payment that was sent is asked about', () => {
  const live = [
    job(), job({ id: 'unsent', status: 'charging_unsent' }), job({ id: 'none', processor: null }),
    job({ id: 'tip', processor: null, status: 'tipping' }),
  ];
  assert.deepEqual(jobsToAsk(live).map((j) => j.id), ['df9c6528']);
  assert.deepEqual(jobsToAsk(null), []);
  assert.deepEqual(jobsToAsk([null, {}]), []);
});

test('paid: it is recorded, do not take it again; the card machine is free', () => {
  for (const s of ['approved', 'reconciled']) {
    const out = lines([{ job: job(), ...settled(s) }]);
    assert.deepEqual(out.lines, ['£6.00 sent at 07:37 was paid. It is recorded. Do not take it again.', 'Drive Thru can take payments again.']);
    assert.equal(out.free, true);
  }
});

test('declined: nothing was charged', () => {
  const out = lines([{ job: job(), ...settled('declined', { decline_reason: 'Not enough balance' }) }]);
  assert.deepEqual(out.lines, ['£6.00 sent at 07:37 was declined. Nothing was charged.', 'Drive Thru can take payments again.']);
});

test("cancelled by the check: the server's own reason, then Released", () => {
  const never = lines([{ job: job(), ...settled('cancelled', { decline_reason: NEVER_RECEIVED_REASON }) }]);
  assert.deepEqual(never.lines, [
    '£6.00 sent at 07:37: The card machine never received this payment, so nothing was charged. Released.',
    'Drive Thru can take payments again.',
  ]);
  assert.equal(never.free, true);
  const silent = lines([{ job: job(), ...settled('cancelled', { decline_reason: 'Card machine could not be reached and Adyen has no record of this payment, so nothing was charged.' }) }]);
  assert.equal(silent.lines[0], '£6.00 sent at 07:37: Card machine could not be reached and Adyen has no record of this payment, so nothing was charged. Released.', 'one full stop, not two');
  const bare = lines([{ job: job(), ...settled('expired') }]);
  assert.equal(bare.lines[0], '£6.00 sent at 07:37 was cancelled. Nothing was charged. Released.');
});

test('in progress: the customer is paying, finish or cancel it on the card machine, not released', () => {
  const out = lines([{ job: job(), ...waiting('in_progress') }], { still: [job()] });
  assert.deepEqual(out.lines, [
    '£6.00 sent at 07:37 is on the card machine now and the card machine says the customer is paying. Finish or cancel it on the card machine. Not released.',
    'Drive Thru is still busy with the payment above.',
  ]);
  assert.equal(out.free, false);
});

test('no answer yet: when to press Release again and when it clears by itself, on the venue clock', () => {
  const out = lines([{ job: job(), ...waiting('no_answer_yet') }], { still: [job()] });
  assert.deepEqual(out.lines, [
    '£6.00 sent at 07:37 has had no answer from the card machine yet. It may still be in progress, so it was not released. '
    + 'Press Release again after 07:40. It clears by itself by about 07:41.',
    'Drive Thru is still busy with the payment above.',
  ]);
  // An answer with no times (an older server): the times come from the send.
  const old = lines([{ job: job(), ...waiting('no_answer_yet', { retry_after: undefined, clears_by: undefined }) }], { still: [job()] });
  assert.equal(old.lines[0], out.lines[0]);
  // A time that has passed is not promised.
  const late = lines([{ job: job(), ...waiting('no_answer_yet') }], { still: [job()], now: Date.parse('2026-10-13T06:45:00.000Z') });
  assert.equal(late.lines[0], '£6.00 sent at 07:37 has had no answer from the card machine yet. It may still be in progress, so it was not released. Press Release again in a minute.');
  // Another venue's clock.
  const la = releaseLines({ label: 'Counter', asked: [{ job: job({ currency: 'USD' }), ...waiting('no_answer_yet') }], rpc: {}, still: [job()], tz: 'America/Los_Angeles', now: NOW });
  assert.equal(la.lines[0], '$6.00 sent at 23:37 has had no answer from the card machine yet. It may still be in progress, so it was not released. Press Release again after 23:40. It clears by itself by about 23:41.');
});

test('not found, the send still open: not released, and when it clears by itself', () => {
  const out = lines([{ job: job(), ...waiting('not_found_waiting') }], { still: [job()] });
  assert.deepEqual(out.lines, [
    'The card machine says it has not started £6.00 sent at 07:37, but the request is still open with Adyen and could still appear on the card machine. Not released. It clears by itself by about 07:41.',
    'Drive Thru is still busy with the payment above.',
  ]);
});

test("ledger unclear, and an answer with no reason, both say why it was not released", () => {
  const unclear = lines([{ job: job(), ...waiting('ledger_unclear') }], { still: [job()] });
  assert.equal(unclear.lines[0], "Adyen's record for £6.00 sent at 07:37 could not be read or needs checking, so it was not released. Try again in a minute, or look in Payments that need checking.");
  for (const body of [
    { ok: true, state: 'processing', status: 'charging' },                               // an older server, or the ledger guard
    { ok: true, state: 'processing', status: 'charging', code: 'SETTLE_DEFERRED' },      // a settle the database could not record yet
    { ok: true, state: 'processing', status: 'charging', why: 'not_in_flight' },
    { ok: true, state: 'charging', status: 'charging', job_status: 'charging' },         // a cancel whose write did not land
  ]) {
    const out = lines([{ job: job(), httpStatus: 200, body }], { still: [job()] });
    assert.equal(out.lines[0], '£6.00 sent at 07:37 could not be confirmed yet, so it was not released. Try again in a minute, or look in Payments that need checking.', JSON.stringify(body));
    assert.equal(out.free, false);
  }
});

test('a failed ask says so with the reason, and never claims a release', () => {
  for (const [ask, reason] of [
    [{ httpStatus: 0, body: null, error: 'Failed to fetch' }, 'Failed to fetch'],
    [{ httpStatus: 403, body: { error: 'no access to this job' }, error: null }, 'no access to this job'],
    [{ httpStatus: 500, body: null, error: null }, 'HTTP 500'],
    [{ httpStatus: 200, body: { hello: 'world' }, error: null }, 'the answer was not understood'],
    [{ httpStatus: 409, body: { ok: false, error: 'in_flight' }, error: null }, 'in_flight'],
  ]) {
    const out = lines([{ job: job(), ...ask }], { still: [job()] });
    assert.deepEqual(out.lines, [
      `The card machine could not be asked about £6.00 sent at 07:37 (${reason}). Not released. Try again.`,
      'Drive Thru is still busy with the payment above.',
    ]);
    assert.equal(out.free, false);
  }
});

test('an older server answering 409 with safe true counts as never received', () => {
  const ask = { httpStatus: 409, body: { ok: false, safe: true, error: 'terminal never received the payment — retry' }, error: null };
  assert.deepEqual(askOutcome(ask), { kind: 'never_received_old' });
  // The old server put it back to "not sent", and the release that follows cleared it.
  const cleared = lines([{ job: job(), ...ask }], { still: [], rpc: { ok: true, expired: 1, released: 0 } });
  assert.deepEqual(cleared.lines, [
    '£6.00 sent at 07:37: The card machine never received this payment, so nothing was charged. Released.',
    'Released 1 stuck payment.',
    'Drive Thru can take payments again.',
  ]);
  // If it is somehow still live, the page does not claim a release.
  const stuck = lines([{ job: job(), ...ask }], { still: [job({ status: 'charging_unsent' })] });
  assert.deepEqual(stuck.lines, [
    'The card machine never received £6.00 sent at 07:37. Nothing was charged. It is not released yet. Press Release again.',
    'Drive Thru is still busy with the payment above.',
  ]);
  assert.ok(!NO_DASH.test(cleared.lines.join(' ')) && !NO_DASH.test(stuck.lines.join(' ')), "the old server's own dash is never shown");
});

test('"can take payments again" only when nothing live remains', () => {
  const asks = {
    paid: settled('approved'), declined: settled('declined'), cancelled: settled('cancelled', { decline_reason: NEVER_RECEIVED_REASON }),
    in_progress: waiting('in_progress'), no_answer_yet: waiting('no_answer_yet'), not_found_waiting: waiting('not_found_waiting'),
    ledger_unclear: waiting('ledger_unclear'), failed: { httpStatus: 0, body: null, error: 'offline' },
  };
  for (const [name, ask] of Object.entries(asks)) {
    for (const still of [[job()], [job(), job({ id: 'second' })]]) {
      const out = lines([{ job: job(), ...ask }], { still });
      assert.equal(out.free, false, name);
      assert.ok(!out.lines.join(' ').includes('can take payments again'), `${name}: ${out.lines.join(' | ')}`);
      assert.ok(!out.lines.join(' ').includes('Nothing was stuck'), name);
      assert.equal(out.lines.at(-1), still.length > 1 ? 'Drive Thru is still busy with the payments above.' : 'Drive Thru is still busy with the payment above.');
    }
    const free = lines([{ job: job(), ...ask }], { still: [] });
    assert.equal(free.free, true, name);
    assert.equal(free.lines.at(-1), 'Drive Thru can take payments again.', name);
  }
  // The second read failed: nothing is claimed either way.
  const blind = releaseLines({ label: 'Drive Thru', asked: [{ job: job(), ...settled('cancelled', { decline_reason: NEVER_RECEIVED_REASON }) }], rpc: {}, still: null, tz: TZ, now: NOW });
  assert.equal(blind.free, false);
  assert.equal(blind.lines.at(-1), 'Could not check if Drive Thru is free now. Press Release again.');
  assert.ok(!blind.lines.join(' ').includes('can take payments again'));
});

test('"Nothing was stuck" only when nothing was live and the release cleared nothing', () => {
  assert.deepEqual(lines([]).lines, ['Nothing was stuck on Drive Thru.']);
  assert.equal(lines([]).free, true);
  assert.deepEqual(releaseLines({ label: 'Counter', asked: [], rpc: null, still: [], tz: TZ, now: NOW }).lines, ['Nothing was stuck on Counter.']);
  // The release cleared something (a parked payment, or one that was never sent): today's words.
  assert.deepEqual(lines([], { rpc: { ok: true, expired: 0, released: 1 } }).lines, ['Released 1 stuck payment.', 'Drive Thru can take payments again.']);
  assert.deepEqual(lines([], { rpc: { ok: true, expired: 2, released: 1 } }).lines, ['Released 3 stuck payments.', 'Drive Thru can take payments again.']);
  // A payment was asked about: something WAS stuck, even though the release itself cleared nothing.
  assert.ok(!lines([{ job: job(), ...settled('cancelled') }]).lines.join(' ').includes('Nothing was stuck'));
});

test('a live payment nobody asked about still gets a reason', () => {
  const tipping = job({ id: 'tip-1', processor: null, status: 'tipping', charge_minor: null, due_minor: 1250 });
  assert.deepEqual(lines([], { still: [tipping] }).lines, [
    '£12.50 sent at 07:37 is waiting on the card machine. Finish or cancel it on the card machine. Not released.',
    'Drive Thru is still busy with the payment above.',
  ]);
  assert.equal(lines([], { still: [job({ id: 'noproc-2', processor: null })] }).lines[0],
    '£6.00 sent at 07:37 is on the card machine now. Finish or cancel it on the card machine. Not released.');
  assert.equal(lines([], { still: [job({ id: 'u', status: 'charging_unsent', dispatched_at: null, created_at: SENT })] }).lines[0],
    '£6.00 sent at 07:37 has not gone to the card machine yet. Not released. Try again in a minute.');
});

test('several payments: one line each, in order, then one closing line', () => {
  const a = job({ id: 'a' });
  const b = job({ id: 'b', charge_minor: 1250, dispatched_at: '2026-10-13T06:38:10.000Z' });
  const out = lines([{ job: a, ...settled('cancelled', { decline_reason: NEVER_RECEIVED_REASON }) }, { job: b, ...waiting('in_progress') }], { still: [b] });
  assert.deepEqual(out.lines, [
    '£6.00 sent at 07:37: The card machine never received this payment, so nothing was charged. Released.',
    '£12.50 sent at 07:38 is on the card machine now and the card machine says the customer is paying. Finish or cancel it on the card machine. Not released.',
    'Drive Thru is still busy with the payment above.',
  ]);
  // A payment the server's own timer cleared between the ask and the second read.
  const gone = lines([{ job: a, ...waiting('no_answer_yet') }], { still: [] });
  assert.deepEqual(gone.lines, ['£6.00 sent at 07:37 is no longer holding the card machine.', 'Drive Thru can take payments again.']);
});

test('13 Oct replay: Release at 07:41:18, 208 s after the send, the reader silent and the ledger empty', () => {
  // A person's ask past 120 s keeps the old rule: the server cancels it as "could not be reached".
  const out = lines([{ job: job(), ...settled('cancelled', { decline_reason: 'Card machine could not be reached and Adyen has no record of this payment, so nothing was charged' }) }],
    { still: [], now: Date.parse('2026-10-13T06:41:18.000Z') });
  assert.deepEqual(out.lines, [
    '£6.00 sent at 07:37: Card machine could not be reached and Adyen has no record of this payment, so nothing was charged. Released.',
    'Drive Thru can take payments again.',
  ]);
  assert.equal(out.free, true);
});

test('no em or en dash in any line', () => {
  const j = job();
  const every = [
    lines([{ job: j, ...settled('approved') }]),
    lines([{ job: j, ...settled('declined') }]),
    lines([{ job: j, ...settled('cancelled', { decline_reason: NEVER_RECEIVED_REASON }) }]),
    lines([{ job: j, ...settled('expired') }]),
    lines([{ job: j, ...waiting('in_progress') }], { still: [j] }),
    lines([{ job: j, ...waiting('no_answer_yet') }], { still: [j] }),
    lines([{ job: j, ...waiting('not_found_waiting') }], { still: [j] }),
    lines([{ job: j, ...waiting('ledger_unclear') }], { still: [j] }),
    lines([{ job: j, ...waiting(null) }], { still: [j] }),
    lines([{ job: j, httpStatus: 0, body: null, error: 'offline' }], { still: [j] }),
    lines([{ job: j, httpStatus: 409, body: { safe: true } }], { still: [j] }),
    lines([], { still: [job({ status: 'tipping' }), job({ id: 'x', status: 'charging_unsent' })] }),
    lines([], { rpc: { expired: 1, released: 1 } }),
    lines([]),
    releaseLines({ label: 'Drive Thru', asked: [], rpc: null, still: null, tz: TZ, now: NOW }),
    releaseLines(),
  ];
  for (const out of every) {
    assert.ok(out.lines.length >= 1);
    for (const l of out.lines) { assert.ok(l.length > 10, l); assert.ok(!NO_DASH.test(l), l); assert.ok(!/undefined|null|NaN/.test(l), l); }
  }
});
