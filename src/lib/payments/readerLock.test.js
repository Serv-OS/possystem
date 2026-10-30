/**
 * readerLock.test.js - a card machine is never left locked by a payment it never had
 * (supabase/functions/_shared/readerLock.js), run under plain node like terminalKick.test.js.
 *
 * The money rules these protect:
 *   - 13 Oct 2026, Coffee Boy Huddersfield Drive Thru, job df9c6528: a 6.00 payment the reader
 *     never received held the reader for 310 s. It must clear by itself, quickly, with staff told.
 *   - 15 Aug 2026, jobs 7908d1ab and a742204b: the reader said "not found" 25 s and 28 s after
 *     the send and Adyen APPROVED both 5 s later. "Not found" while the send is still open is
 *     NOT proof, and must never cancel or re send a payment.
 *   - 6 and 12 Oct 2026, jobs e4fddb92 and 4ade11f6: real approvals 132 s after the send. A timer
 *     must never touch them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS_ASK_TIMEOUT_MS, TENDER_STALL_MS, SEND_DEAD_AFTER_MS, READER_ASK_FIRST_MS, READER_ASK_EVERY_MS,
  READER_ASK_HORIZON_MS, READER_ASK_MAX_SINCE_SEND_MS, READER_ASK_LIMIT, SEND_ENDED_ASK_AFTER_MS,
  BUSY_CLEARS_AFTER_MS, LATE_MONEY_WINDOW_MS, LATE_MONEY_LIMIT, NEVER_RECEIVED_REASON, NEVER_RECEIVED_ERROR,
  LEDGER_RECHECK_MS, BUSY_PRESS_ASK_UNTIL_MS,
  sendEndedKey, sendEndedRecord, sendAnswered, neverReceivedVerdict, timerMustWait,
  planReaderAsks, planBusyPressAsks, busyPressAskDelays, selectReaderAskJobs, roundUpToMinute, busyClearsAtMs, heldWords,
  noPaymentNote, noPaymentNoteKey, lateMoneyAlert, lateMoneyAlertKey,
} from '../../../supabase/functions/_shared/readerLock.js';
import { LOST_CAS_ASK_AFTER_MS } from '../../../supabase/functions/_shared/terminalKick.js';

const TZ = 'Europe/London';
const NO_DASH = /[–—]| - /;
const JOB = 'df9c6528-0000-4000-8000-000000000000';
const SVC = 'svc-0737';

// ── the verdict ──────────────────────────────────────────────────────────────

test('15 Aug: not found 25 s after the send, the send still open (no marker), ledger empty, is NOT proven', () => {
  for (const sinceSendMs of [25_000, 28_000]) {
    const v = neverReceivedVerdict({ ledgerReadOk: true, ledgerRowCount: 0, sendAnswered: false, sinceSendMs });
    assert.deepEqual(v, { proven: false, why: 'not_found_waiting' });
  }
});

test('13 Oct: not found 229 s after the send with no marker is proven, because the send is dead', () => {
  assert.deepEqual(
    neverReceivedVerdict({ ledgerReadOk: true, ledgerRowCount: 0, sendAnswered: false, sinceSendMs: 229_000 }),
    { proven: true, by: 'send_dead' },
  );
});

test('a marker that says Adyen answered the send proves it at 40 s; the other two kinds of marker do not at 60 s', () => {
  const answered = sendEndedRecord({ how: 'answered_no_payment', httpStatus: 200, body: { SaleToPOIRequest: { EventNotification: { EventToNotify: 'Reject' } } } });
  assert.deepEqual(
    neverReceivedVerdict({ ledgerReadOk: true, ledgerRowCount: 0, sendAnswered: sendAnswered(answered), sinceSendMs: 40_000 }),
    { proven: true, by: 'send_answered' },
  );
  for (const how of ['no_answer', 'adyen_error']) {
    const m = sendEndedRecord({ how, httpStatus: how === 'adyen_error' ? 503 : null, error: how === 'no_answer' ? 'The signal has been aborted' : null });
    assert.deepEqual(
      neverReceivedVerdict({ ledgerReadOk: true, ledgerRowCount: 0, sendAnswered: sendAnswered(m), sinceSendMs: 60_000 }),
      { proven: false, why: 'not_found_waiting' }, how,
    );
  }
});

test('the ledger decides first: a failed read or any row is ledger_unclear, whatever else is true', () => {
  for (const sinceSendMs of [10_000, 229_000]) {
    for (const answered of [false, true]) {
      assert.deepEqual(neverReceivedVerdict({ ledgerReadOk: false, ledgerRowCount: 0, sendAnswered: answered, sinceSendMs }), { proven: false, why: 'ledger_unclear' });
      assert.deepEqual(neverReceivedVerdict({ ledgerReadOk: true, ledgerRowCount: 1, sendAnswered: answered, sinceSendMs }), { proven: false, why: 'ledger_unclear' });
    }
  }
  // A read that says nothing clear about itself is not "read OK", and a count that is not a number is not "zero".
  assert.equal(neverReceivedVerdict({ ledgerRowCount: 0, sendAnswered: true, sinceSendMs: 999_000 }).proven, false);
  assert.equal(neverReceivedVerdict({ ledgerReadOk: true, ledgerRowCount: null, sendAnswered: true, sinceSendMs: 999_000 }).proven, false);
  assert.equal(neverReceivedVerdict({ ledgerReadOk: true, sendAnswered: true, sinceSendMs: 999_000 }).proven, false);
  assert.equal(neverReceivedVerdict().proven, false);
});

test('exactly 155,000 ms is proven, 154,999 is not; an unknown time since the send is never "dead"', () => {
  const at = (sinceSendMs) => neverReceivedVerdict({ ledgerReadOk: true, ledgerRowCount: 0, sendAnswered: false, sinceSendMs });
  assert.deepEqual(at(155_000), { proven: true, by: 'send_dead' });
  assert.deepEqual(at(154_999), { proven: false, why: 'not_found_waiting' });
  for (const odd of [null, undefined, NaN, '200000']) assert.deepEqual(at(odd), { proven: false, why: 'not_found_waiting' }, String(odd));
  // Only the boolean true counts as "answered".
  assert.equal(neverReceivedVerdict({ ledgerReadOk: true, ledgerRowCount: 0, sendAnswered: 'yes', sinceSendMs: 1_000 }).proven, false);
});

// ── the marker ───────────────────────────────────────────────────────────────

test('sendEndedRecord: answered is true only for answered_no_payment; the body is cut to 2000 characters', () => {
  const now = Date.parse('2026-10-13T06:40:21.000Z');
  const a = sendEndedRecord({ how: 'answered_no_payment', httpStatus: 200, body: { note: 'x'.repeat(5000) }, now });
  assert.equal(a.answered, true);
  assert.equal(a.how, 'answered_no_payment');
  assert.equal(a.http_status, 200);
  assert.equal(a.at, '2026-10-13T06:40:21.000Z');
  assert.equal(typeof a.adyen, 'string');
  assert.equal(a.adyen.length, 2000);
  assert.ok(a.adyen.startsWith('{"note":"xxx'));
  assert.equal(a.error, null);

  const b = sendEndedRecord({ how: 'adyen_error', httpStatus: 502, body: { errorCode: '000' }, now });
  assert.equal(b.answered, false);
  assert.equal(b.http_status, 502);
  assert.equal(b.adyen, '{"errorCode":"000"}');

  const c = sendEndedRecord({ how: 'no_answer', error: 'The signal has been aborted', now });
  assert.equal(c.answered, false);
  assert.equal(c.http_status, null);
  assert.equal(c.adyen, null);
  assert.equal(c.error, 'The signal has been aborted');
  assert.equal(sendEndedRecord({ how: 'no_answer', error: 'e'.repeat(900), now }).error.length, 300);

  // A kind nobody defined is never proof.
  assert.equal(sendEndedRecord({ how: 'something_else', httpStatus: 200, now }).answered, false);
  assert.equal(sendEndedRecord().answered, false);
});

test('sendEndedKey is stable and carries the job id and the service id; another attempt has another key', () => {
  assert.equal(sendEndedKey(JOB, SVC), `send-ended:${JOB}:${SVC}`);
  assert.equal(sendEndedKey(JOB, SVC), sendEndedKey(JOB, SVC));
  assert.notEqual(sendEndedKey(JOB, SVC), sendEndedKey(JOB, 'svc-later'));
  assert.notEqual(sendEndedKey(JOB, SVC), sendEndedKey('another-job', SVC));
});

test('sendAnswered is false for null, a missing field and the other two kinds; a missing or failed marker means "not answered"', () => {
  assert.equal(sendAnswered(null), false);
  assert.equal(sendAnswered(undefined), false);
  assert.equal(sendAnswered({}), false);
  assert.equal(sendAnswered({ how: 'answered_no_payment' }), false, 'no answered field');
  assert.equal(sendAnswered({ answered: 'true', how: 'answered_no_payment' }), false, 'only the boolean');
  assert.equal(sendAnswered({ answered: true }), false, 'answered with no kind is an odd row, not proof');
  assert.equal(sendAnswered('answered'), false);
  assert.equal(sendAnswered(sendEndedRecord({ how: 'no_answer' })), false);
  assert.equal(sendAnswered(sendEndedRecord({ how: 'adyen_error', httpStatus: 500 })), false);
  assert.equal(sendAnswered(sendEndedRecord({ how: 'answered_no_payment', httpStatus: 200 })), true);
});

// ── the timer ────────────────────────────────────────────────────────────────

test('timerMustWait: a timer waits under 155 s, not at 155 s; an ask from a till or a person never waits here', () => {
  assert.equal(timerMustWait({ conservative: true, sinceSendMs: 0 }), true);
  assert.equal(timerMustWait({ conservative: true, sinceSendMs: 121_000 }), true, 'past the 120 s line a timer still waits');
  assert.equal(timerMustWait({ conservative: true, sinceSendMs: 154_999 }), true);
  assert.equal(timerMustWait({ conservative: true, sinceSendMs: 155_000 }), false);
  assert.equal(timerMustWait({ conservative: true, sinceSendMs: 400_000 }), false);
  for (const sinceSendMs of [0, 60_000, 154_999, 155_000, null]) {
    assert.equal(timerMustWait({ conservative: false, sinceSendMs }), false);
    assert.equal(timerMustWait({ sinceSendMs }), false);
    assert.equal(timerMustWait({ conservative: 'true', sinceSendMs }), false, 'only the boolean marks a timer');
  }
  // A timer that cannot tell how long ago the send was waits.
  for (const odd of [null, undefined, NaN]) assert.equal(timerMustWait({ conservative: true, sinceSendMs: odd }), true);
  assert.equal(timerMustWait(), false);
});

test('planReaderAsks: the asks fall at 45 s then every 20 s since the send, inside the next minute only', () => {
  const at = (sinceSendMs) => planReaderAsks({ sinceSendMs }).map((d) => (sinceSendMs + d) / 1000);
  assert.deepEqual(at(5_000), [45]);
  // Past 45 s a tick also asks at once, for the ask time that passed just before it (see below).
  assert.deepEqual(at(50_000), [50, 65, 85, 105]);
  assert.deepEqual(at(130_000), [130, 145, 165, 185]);
  assert.deepEqual(planReaderAsks({ sinceSendMs: 5_000 }), [40_000]);
  assert.deepEqual(planReaderAsks({ sinceSendMs: 45_000 }), [0, 20_000, 40_000], 'an ask that is due now has no delay, and is not doubled');
  assert.deepEqual(planReaderAsks({ sinceSendMs: 65_000 }), [0, 20_000, 40_000], 'exactly on a later ask time: one ask now, not two');
  assert.deepEqual(planReaderAsks({ sinceSendMs: 0 }), [45_000]);
  assert.deepEqual(planReaderAsks({ sinceSendMs: 44_999 }), [1, 20_001, 40_001], 'nothing is asked before 45 s');
  // Nothing past 320 s since the send: the database sweep owns the job by then.
  assert.deepEqual(at(290_000), [290, 305]);
  assert.deepEqual(planReaderAsks({ sinceSendMs: 305_001 }), [0]);
  assert.deepEqual(planReaderAsks({ sinceSendMs: 320_000 }), [0]);
  assert.deepEqual(planReaderAsks({ sinceSendMs: 320_001 }), []);
  assert.deepEqual(planReaderAsks({ sinceSendMs: 3_600_000 }), []);
  for (const odd of [null, undefined, NaN, '50000']) assert.deepEqual(planReaderAsks({ sinceSendMs: odd }), [], String(odd));
  assert.deepEqual(planReaderAsks(), []);
});

test('planReaderAsks: delays are never negative and never 60 s or more; ticks a minute apart plan every ask time, plus one ask at each tick', () => {
  for (let since = 0; since <= 400_000; since += 1_700) {
    const delays = planReaderAsks({ sinceSendMs: since });
    for (const d of delays) {
      assert.ok(d >= 0, `since ${since}: ${d}`);
      assert.ok(d < READER_ASK_HORIZON_MS, `since ${since}: ${d}`);
      assert.ok(since + d <= READER_ASK_MAX_SINCE_SEND_MS, `since ${since}: ${d}`);
    }
    assert.ok(delays.filter((d) => d === 0).length <= 1, `since ${since}: at most one ask at once`);
    assert.ok(delays.length <= 4, `since ${since}: at most four asks a tick`);
  }
  // A job sent 7 s before a cron tick, then ticks every 60 s: every ask time from 45 s to 305 s is
  // planned once, and each tick past 45 s adds its own ask at once (67 s, 127 s, 187 s, 247 s, 307 s).
  const planned = [];
  const ticks = [];
  for (let since = 7_000; since <= 400_000; since += 60_000) {
    if (since > READER_ASK_FIRST_MS && since <= READER_ASK_MAX_SINCE_SEND_MS) ticks.push(since);
    for (const d of planReaderAsks({ sinceSendMs: since })) planned.push(since + d);
  }
  const grid = [];
  for (let t = READER_ASK_FIRST_MS; t <= READER_ASK_MAX_SINCE_SEND_MS; t += READER_ASK_EVERY_MS) grid.push(t);
  assert.deepEqual(planned, [...grid, ...ticks].sort((a, b) => a - b));
  assert.deepEqual(ticks, [67_000, 127_000, 187_000, 247_000, 307_000]);
  assert.equal(grid.at(-1), 305_000);
});

test('Barnsley, 12 Oct: the cron call due at 11:44:00 arrived 4.6 s late, and the 165 s ask it missed is asked at once', () => {
  // Sent 11:41:17.73 UTC. The calls arrived at 11:42:00.04, 11:43:00.04 and 11:44:04.63.
  const sent = Date.parse('2026-10-12T11:41:17.730Z');
  const plan = (iso) => { const since = Date.parse(iso) - sent; return planReaderAsks({ sinceSendMs: since }).map((d) => Math.round((since + d) / 100) / 10); };
  assert.deepEqual(plan('2026-10-12T11:42:00.040Z'), [45, 65, 85]);
  assert.deepEqual(plan('2026-10-12T11:43:00.040Z'), [102.3, 105, 125, 145]);
  // 166.9 s after the send: 165 s passed 1.9 s ago and the tick before this one could not plan it.
  assert.deepEqual(plan('2026-10-12T11:44:04.630Z'), [166.9, 185, 205, 225]);
  // The first ask a silent reader can be freed by is the one that starts at 165 s or later.
  assert.equal(timerMustWait({ conservative: true, sinceSendMs: 166_900 }), false);
  // A tick a whole gap late (20 s or more) has nothing just missed to ask for: its own minute only.
  assert.deepEqual(planReaderAsks({ sinceSendMs: 85_000 + READER_ASK_EVERY_MS }), [0, 20_000, 40_000], 'on an ask time');
  assert.deepEqual(planReaderAsks({ sinceSendMs: 85_000 + READER_ASK_EVERY_MS - 1 }), [0, 1, 20_001, 40_001], 'one millisecond inside the gap');
});

test('planBusyPressAsks: a refused Pay press asks now, then at each timer ask time up to 185 s after the send', () => {
  const at = (sinceSendMs) => planBusyPressAsks({ sinceSendMs }).map((d) => (sinceSendMs + d) / 1000);
  // 13 Oct, the 07:39:32 press, 102 s after the send.
  assert.deepEqual(at(102_000), [102, 105, 125, 145, 165, 185]);
  assert.deepEqual(planBusyPressAsks({ sinceSendMs: 102_000 })[0], 0, 'the first ask is now');
  // Under 45 s the payment is young: nobody is asked (99% of real payments are done by 41 s).
  assert.deepEqual(planBusyPressAsks({ sinceSendMs: 44_999 }), []);
  assert.deepEqual(at(45_000), [45, 65, 85, 105, 125, 145, 165, 185]);
  // Past 185 s there is only the ask now; past the 5 minute lease the database sweep owns the job.
  assert.deepEqual(at(200_000), [200]);
  assert.deepEqual(at(320_000), [320]);
  assert.deepEqual(planBusyPressAsks({ sinceSendMs: 320_001 }), []);
  for (const odd of [null, undefined, NaN, '102000']) assert.deepEqual(planBusyPressAsks({ sinceSendMs: odd }), [], String(odd));
  assert.deepEqual(planBusyPressAsks(), []);
  // Whenever the press comes, an ask starts at 125 s or later (it comes back from a silent reader
  // at 155 s) and one at 165 s or later (the first that can act on "not found" with no marker),
  // unless the press itself is already past those times.
  for (let since = 45_000; since <= 320_000; since += 1_300) {
    const times = planBusyPressAsks({ sinceSendMs: since }).map((d) => since + d);
    assert.ok(times.some((t) => t + STATUS_ASK_TIMEOUT_MS >= SEND_DEAD_AFTER_MS), `since ${since}`);
    assert.ok(times.some((t) => t >= SEND_DEAD_AFTER_MS) || since > BUSY_PRESS_ASK_UNTIL_MS, `since ${since}`);
    for (const d of planBusyPressAsks({ sinceSendMs: since })) assert.ok(d >= 0 && d <= BUSY_PRESS_ASK_UNTIL_MS - READER_ASK_FIRST_MS, `since ${since}: ${d}`);
  }
});

test('busyPressAskDelays: only an Adyen job that was really sent, 45 s or more ago, and never the local bridge', () => {
  const now = Date.parse('2026-10-13T06:39:32.000Z');
  const busy = (over = {}) => ({ job_id: JOB, status: 'charging', processor: 'adyen', sent_at: '2026-10-13T06:37:50.000Z', source: 'pos_send_to_terminal', ...over });
  assert.deepEqual(busyPressAskDelays(busy(), { now }), [0, 3_000, 23_000, 43_000, 63_000, 83_000]);
  for (const [why, over] of [
    ['no processor (an old read)', { processor: null }],
    ['not sent yet', { status: 'charging_unsent' }],
    ['a PAX status', { status: 'tipping' }],
    ['settled', { status: 'approved' }],
    ['no send time', { sent_at: null }],
    ['a bad send time', { sent_at: 'not a date' }],
    ['no job id', { job_id: null }],
    ['young', { sent_at: '2026-10-13T06:39:00.000Z' }],
    ['past the lease', { sent_at: '2026-10-13T06:30:00.000Z' }],
    ['MPOS on its own reader, by the draft source', { source: 'mpos_adyen_local' }],
  ]) assert.deepEqual(busyPressAskDelays(busy(over), { now }), [], why);
  // The reader row and the till row share one sign in: the device drives the reader itself.
  assert.deepEqual(busyPressAskDelays(busy(), { now, terminalDeviceUid: 'uid-one-session', posDeviceUid: 'uid-one-session' }), []);
  assert.equal(busyPressAskDelays(busy(), { now, terminalDeviceUid: 'random-uid-from-admin', posDeviceUid: 'uid-till' }).length, 6);
  // The MPOS CLOUD flow is a cloud job like any other.
  assert.equal(busyPressAskDelays(busy({ source: 'mpos_cloud_terminal' }), { now }).length, 6);
  assert.deepEqual(busyPressAskDelays(null, { now }), []);
  assert.deepEqual(busyPressAskDelays(undefined), []);
});

test('13 Oct replay: sent 07:37:50, the timer asks at 45, 65, 70, 85, 105 and 125 s; the 125 s ask comes back past the 155 s line', () => {
  const sent = Date.parse('2026-10-13T06:37:50.000Z');
  // The cron ticks on the minute: 06:38:00 (10 s after the send), 06:39:00 (70 s), 06:40:00 (130 s).
  const asks = [];
  for (const tick of ['06:38:00', '06:39:00', '06:40:00']) {
    const since = Date.parse(`2026-10-13T${tick}.000Z`) - sent;
    for (const d of planReaderAsks({ sinceSendMs: since })) asks.push((since + d) / 1000);
  }
  assert.deepEqual(asks.slice(0, 7), [45, 65, 70, 85, 105, 125, 130]);
  // A silent reader costs each ask the 30 s limit. The 105 s ask returns at 135 s: a timer must wait.
  assert.equal(timerMustWait({ conservative: true, sinceSendMs: 105_000 + STATUS_ASK_TIMEOUT_MS }), true);
  // The 125 s ask returns at 155 s: the send is dead, the job may be cancelled as "no answer".
  assert.equal(timerMustWait({ conservative: true, sinceSendMs: 125_000 + STATUS_ASK_TIMEOUT_MS }), false);
  // Staff were told it clears by itself by about 07:41 (venue clock).
  assert.equal(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }).format(new Date(busyClearsAtMs(sent))), '07:41');
});

const NOW = Date.parse('2026-10-13T06:39:00.000Z');
const ago = (msAgo) => new Date(NOW - msAgo).toISOString();
const sentJob = (over = {}) => ({
  id: 'job-1', processor: 'adyen', status: 'charging', nexo_service_id: SVC, simulated: false, training: false,
  target_terminal_id: 'term-cloud', pos_device_id: 'dev-till', dispatched_at: ago(70_000), created_at: ago(71_000),
  check_draft: { source: 'pos_send_to_terminal', orderRef: 'R14202' }, ...over,
});
const maps = {
  terminalsById: new Map([['term-cloud', { id: 'term-cloud', device_uid: 'random-uid-from-admin' }], ['term-mpos', { id: 'term-mpos', device_uid: 'uid-one-session' }]]),
  devicesById: new Map([['dev-till', { id: 'dev-till', device_uid: 'uid-till' }], ['dev-mpos', { id: 'dev-mpos', device_uid: 'uid-one-session' }]]),
};

test('selectReaderAskJobs keeps only Adyen jobs that were really sent, never simulated or training', () => {
  const pick = (jobs, over = {}) => selectReaderAskJobs(jobs, { now: NOW, ...maps, ...over });
  assert.deepEqual(pick([sentJob()]), [{ id: 'job-1', delays: [0, 15_000, 35_000, 55_000] }]);
  for (const [why, over] of [
    ['no processor', { processor: null }],
    ['not sent yet', { status: 'charging_unsent' }],
    ['the till gave up on it', { status: 'unknown' }],
    ['settled', { status: 'approved' }],
    ['no service id', { nexo_service_id: null }],
    ['empty service id', { nexo_service_id: '' }],
    ['simulated', { simulated: true }],
    ['training', { training: true }],
    ['no send time', { dispatched_at: null }],
    ['a bad send time', { dispatched_at: 'not a date' }],
    ['past the lease', { dispatched_at: ago(321_000) }],
  ]) assert.deepEqual(pick([sentJob(over)]), [], why);
  // A job sent 10 s ago is planned (its first ask is 35 s away); nothing is asked before 45 s.
  assert.deepEqual(pick([sentJob({ dispatched_at: ago(10_000) })]), [{ id: 'job-1', delays: [35_000, 55_000] }]);
  assert.deepEqual(pick([]), []);
  assert.deepEqual(pick(null), []);
  assert.deepEqual(selectReaderAskJobs([sentJob()]).length <= 1, true, 'works without options');
});

test('selectReaderAskJobs leaves the local bridge alone: the draft source and the shared uid signal', () => {
  const pick = (jobs) => selectReaderAskJobs(jobs, { now: NOW, ...maps });
  assert.deepEqual(pick([sentJob({ check_draft: { source: 'mpos_adyen_local' } })]), [], 'MPOS on its own reader');
  assert.deepEqual(pick([sentJob({ target_terminal_id: 'term-mpos', pos_device_id: 'dev-mpos' })]), [], 'terminal row and device row share one sign in');
  // The MPOS CLOUD flow is a cloud job like any other: it is asked about.
  assert.equal(pick([sentJob({ check_draft: { source: 'mpos_cloud_terminal' } })]).length, 1);
  // A plain record works as well as a Map.
  assert.deepEqual(selectReaderAskJobs([sentJob({ target_terminal_id: 'term-mpos', pos_device_id: 'dev-mpos' })], {
    now: NOW, terminalsById: { 'term-mpos': { device_uid: 'u' } }, devicesById: { 'dev-mpos': { device_uid: 'u' } },
  }), []);
});

test('selectReaderAskJobs: oldest send first, and the limit is respected', () => {
  const jobs = [
    sentJob({ id: 'newer', dispatched_at: ago(50_000) }),
    sentJob({ id: 'oldest', dispatched_at: ago(200_000) }),
    sentJob({ id: 'middle', dispatched_at: ago(90_000) }),
  ];
  const all = selectReaderAskJobs(jobs, { now: NOW, ...maps });
  assert.deepEqual(all.map((j) => j.id), ['oldest', 'middle', 'newer']);
  assert.deepEqual(selectReaderAskJobs(jobs, { now: NOW, ...maps, limit: 2 }).map((j) => j.id), ['oldest', 'middle']);
  assert.deepEqual(selectReaderAskJobs(jobs, { now: NOW, ...maps, limit: 0 }), []);
  const many = Array.from({ length: 30 }, (_, i) => sentJob({ id: `j${i}`, dispatched_at: ago(60_000 + i * 1000) }));
  assert.equal(selectReaderAskJobs(many, { now: NOW, ...maps }).length, READER_ASK_LIMIT);
  for (const j of all) assert.ok(j.delays.length > 0 && Object.keys(j).sort().join() === 'delays,id');
});

// ── the numbers hold together ────────────────────────────────────────────────

test('the numbers hold together', () => {
  assert.equal(STATUS_ASK_TIMEOUT_MS, 30_000);
  assert.equal(TENDER_STALL_MS, 120_000);
  assert.ok(SEND_DEAD_AFTER_MS > 150_000, 'Adyen ends a cloud payment request at 150 s');
  assert.ok(SEND_DEAD_AFTER_MS > TENDER_STALL_MS);
  assert.ok(SEND_DEAD_AFTER_MS > 132_200, 'the slowest real approval in 14 days was 132.2 s after the send');
  assert.ok(READER_ASK_FIRST_MS >= LOST_CAS_ASK_AFTER_MS, 'the timer never asks before the one shot that already exists');
  assert.ok(READER_ASK_FIRST_MS > 41_300, '99% of real payments are finished before the timer first asks');
  assert.ok(READER_ASK_EVERY_MS * 3 <= READER_ASK_HORIZON_MS, 'three ask times fit one cron minute');
  assert.equal(READER_ASK_HORIZON_MS, 60_000, 'the cron runs every minute');
  assert.ok(BUSY_CLEARS_AFTER_MS >= SEND_DEAD_AFTER_MS + READER_ASK_EVERY_MS, 'what staff are told covers the line plus one ask gap');
  assert.ok(READER_ASK_MAX_SINCE_SEND_MS >= 5 * 60_000, 'the timer covers the whole 5 minute lease');
  assert.ok(READER_ASK_LIMIT > 0 && READER_ASK_LIMIT <= 50);
  assert.equal(SEND_ENDED_ASK_AFTER_MS, 3_000);
  assert.equal(LATE_MONEY_WINDOW_MS, 3 * 24 * 60 * 60 * 1000, 'as far back as the "confirmed late" cover it replaces (3 days)');
  assert.equal(LATE_MONEY_LIMIT, 50);
  assert.ok(LEDGER_RECHECK_MS >= 7_600, "the second look waits past the 99th centile of Adyen's webhook lag (7.6 s)");
  assert.ok(LEDGER_RECHECK_MS <= READER_ASK_EVERY_MS, 'and is over before the next ask');
  assert.equal(BUSY_PRESS_ASK_UNTIL_MS, SEND_DEAD_AFTER_MS + STATUS_ASK_TIMEOUT_MS, 'a refused press asks until the line plus one status ask');
  assert.ok(BUSY_CLEARS_AFTER_MS >= SEND_DEAD_AFTER_MS + LEDGER_RECHECK_MS, 'what staff are told covers the line and the second look');
  // A silent reader: the last ask that starts before the line returns after it, within one ask gap.
  const lastBefore = [...Array(20).keys()].map((k) => READER_ASK_FIRST_MS + k * READER_ASK_EVERY_MS).filter((t) => t + STATUS_ASK_TIMEOUT_MS >= SEND_DEAD_AFTER_MS)[0];
  assert.ok(lastBefore + STATUS_ASK_TIMEOUT_MS <= BUSY_CLEARS_AFTER_MS, 'a silent reader is cleared inside what staff are told');
});

// ── words ────────────────────────────────────────────────────────────────────

test('roundUpToMinute, busyClearsAtMs and heldWords', () => {
  const t = Date.parse('2026-10-13T06:40:50.000Z');
  assert.equal(roundUpToMinute(t), Date.parse('2026-10-13T06:41:00.000Z'));
  assert.equal(roundUpToMinute('2026-10-13T06:41:00.000Z'), Date.parse('2026-10-13T06:41:00.000Z'), 'a whole minute stays');
  assert.ok(Number.isNaN(roundUpToMinute(null)));
  assert.equal(busyClearsAtMs('2026-10-13T06:37:50.000Z'), Date.parse('2026-10-13T06:41:00.000Z'));
  assert.equal(busyClearsAtMs('2026-10-13T06:37:00.000Z'), Date.parse('2026-10-13T06:40:00.000Z'));
  assert.ok(Number.isNaN(busyClearsAtMs('nope')));
  assert.equal(heldWords(156_000), '2 minutes 36 seconds');
  assert.equal(heldWords(36_400), '36 seconds');
  assert.equal(heldWords(61_000), '1 minute 1 second');
  assert.equal(heldWords(120_000), '2 minutes');
  assert.equal(heldWords(0), '0 seconds');
  assert.equal(heldWords(3_725_000), '1 hour 2 minutes');
  assert.equal(heldWords(7_200_000), '2 hours');
  assert.equal(heldWords(null), '');
  assert.equal(heldWords(-5), '');
});

const noteFacts = {
  amountMinor: 600, currency: 'GBP', sentAt: '2026-10-13T06:37:50.000Z', tz: TZ, ref: 'R14202',
  tableLabel: null, readerLabel: 'Drive Thru', heldMs: 156_000,
};

test('noPaymentNote, never received: the amount, the venue time, the ref, the reader and the held time; nothing was charged', () => {
  const n = noPaymentNote({ kind: 'never_received', ...noteFacts });
  assert.equal(n.severity, 'action');
  // The till shows the title then the body in one toast for 2.8 s: the title says the card
  // machine is free, and the body opens with what to do.
  assert.equal(n.title, 'Card machine is free. £6.00 (R14202) was not charged.');
  assert.equal(n.body,
    'If the customer has not paid another way, take the payment again. '
    + '£6.00 for the order was sent to the Drive Thru card machine at 07:37. The card machine never received it. Nothing was charged. '
    + 'The payment was cancelled after 2 minutes 36 seconds and the card machine is free.');
});

test('noPaymentNote, no answer: says the card machine did not answer and Adyen has no record', () => {
  const n = noPaymentNote({ kind: 'no_answer', ...noteFacts });
  assert.equal(n.severity, 'action');
  assert.equal(n.title, 'Card machine is free. £6.00 (R14202) was not charged.');
  // "Take the payment again" only for a customer who has not paid another way (on 13 Oct they
  // had, on the other till), and only after a look at the card machine: silence is not proof.
  assert.equal(n.body,
    'If the customer has not paid another way, check the card machine screen, then take the payment again. '
    + '£6.00 for the order was sent to the Drive Thru card machine at 07:37. The card machine did not answer and Adyen has no record of a payment. Nothing was charged. '
    + 'The payment was cancelled after 2 minutes 36 seconds and the card machine is free.');
});

test('noPaymentNote: USD, a table label, a reader whose name says what it is, and facts that are missing', () => {
  const us = noPaymentNote({ kind: 'never_received', ...noteFacts, amountMinor: 1250, currency: 'USD', tz: 'America/Los_Angeles', tableLabel: 'T3', ref: 'R88' });
  assert.equal(us.title, 'Card machine is free. $12.50 (R88) was not charged.');
  assert.ok(us.body.includes(' $12.50 for T3 was sent to the Drive Thru card machine at 23:37.'), us.body);
  assert.ok(noPaymentNote({ kind: 'no_answer', ...noteFacts, readerLabel: 'Reader 1' }).body.includes(' £6.00 for the order was sent to Reader 1 at 07:37.'));
  const bare = noPaymentNote({ kind: 'never_received', amountMinor: 600 });
  assert.equal(bare.title, 'Card machine is free. £6.00 was not charged.');
  assert.equal(bare.body, 'If the customer has not paid another way, take the payment again. £6.00 for the order was sent to the card machine. The card machine never received it. Nothing was charged. The payment was cancelled and the card machine is free.');
  for (const kind of ['never_received', 'no_answer']) {
    for (const facts of [noteFacts, { ...noteFacts, currency: 'USD', tableLabel: 'T3' }, { amountMinor: 600 }]) {
      const n = noPaymentNote({ kind, ...facts });
      assert.ok(n.title.startsWith('Card machine is free. '), n.title);
      assert.ok(n.body.startsWith('If the customer has not paid another way, '), 'never a bare "take the payment again"');
      assert.equal(n.body.split('take the payment again').length, 2, 'said once');
      assert.ok(n.body.includes('Nothing was charged.'));
      assert.ok(n.body.endsWith('the card machine is free.'));
      assert.ok(n.title.split(/\s+/).length <= 10, `a title short enough for a 2.8 s toast: ${n.title}`);
      assert.ok(!NO_DASH.test(n.title) && !NO_DASH.test(n.body), `${n.title} ${n.body}`);
    }
  }
});

test('the note keys are stable per job, and the two notes never share one', () => {
  assert.equal(noPaymentNoteKey(JOB), `reader-no-payment:${JOB}`);
  assert.equal(lateMoneyAlertKey(JOB), `late-money:${JOB}`);
  assert.equal(noPaymentNoteKey(JOB), noPaymentNoteKey(JOB));
  assert.notEqual(noPaymentNoteKey(JOB), noPaymentNoteKey('another'));
  assert.notEqual(noPaymentNoteKey(JOB), lateMoneyAlertKey(JOB));
});

test('lateMoneyAlert: urgent, names the amount, card and time, and tells the manager what to do in both cases', () => {
  const a = lateMoneyAlert({ amountMinor: 600, currency: 'GBP', card: { brand: 'visa', last4: '1234' }, paidAt: '2026-10-13T06:44:02.000Z', tz: TZ, ref: 'R14202' });
  assert.equal(a.severity, 'urgent');
  assert.equal(a.title, 'Card payment taken after it was cancelled: £6.00');
  assert.equal(a.body,
    'Adyen shows the card machine took £6.00 (Visa ••1234) for order R14202 at 07:44. '
    + 'The till had already cancelled that payment as not charged, so no sale was recorded. '
    + 'If the customer also paid another way, refund this card payment in Adyen. If they did not, record the sale by hand.');
  const bare = lateMoneyAlert({ amountMinor: 1250, currency: 'USD' });
  assert.equal(bare.title, 'Card payment taken after it was cancelled: $12.50');
  assert.ok(bare.body.startsWith('Adyen shows the card machine took $12.50 for an order. '), bare.body);
  for (const x of [a, bare]) {
    assert.ok(x.body.includes('refund this card payment in Adyen'));
    assert.ok(x.body.includes('record the sale by hand'));
    assert.ok(!NO_DASH.test(x.title) && !NO_DASH.test(x.body));
  }
});

test('the two texts written on the job have no dash and say nothing was charged', () => {
  assert.equal(NEVER_RECEIVED_REASON, 'The card machine never received this payment, so nothing was charged');
  assert.equal(NEVER_RECEIVED_ERROR, 'terminal never received the payment (Adyen: not found)', 'the text old searches look for');
  assert.ok(!NO_DASH.test(NEVER_RECEIVED_REASON) && !NO_DASH.test(NEVER_RECEIVED_ERROR));
});
