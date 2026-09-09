/**
 * terminalKick.test.js - which Adyen jobs the server may kick, and which
 * stranded jobs the sweep may re-kick (supabase/functions/_shared/terminalKick.js).
 *
 * The money rule these protect (9 Sep 2026 incident): a cloud job the till
 * never kicked MUST be kicked by the server, and a job the device drives over
 * the LOCAL nexo bridge must NEVER be cloud-kicked (that is a race for the
 * same CAS, not a duplicate).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isLocalBridgeJob, shouldServerKick, selectUnsentSweepCandidates, clientOwnsCreateKick,
  UNSENT_SWEEP_MIN_AGE_MS, UNSENT_SWEEP_MAX_AGE_MS, UNSENT_SWEEP_LIMIT,
} from '../../../supabase/functions/_shared/terminalKick.js';

const NOW = Date.parse('2026-09-09T22:34:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

const cloudTerm = { id: 'term-cloud', device_uid: 'random-uid-from-admin', adyen_terminal_id: 'AMS1-000168254080883', status: 'paired', active: true };
const mposTerm = { id: 'term-mpos', device_uid: 'uid-mpos-session', adyen_terminal_id: 'S1F2L-000000000000001', status: 'paired', active: true };
const paxTerm = { id: 'term-pax', device_uid: 'uid-pax', adyen_terminal_id: null, status: 'paired', active: true };

const job = (over = {}) => ({
  id: 'job-1',
  processor: 'adyen',
  status: 'charging_unsent',
  charge_minor: 1700,
  simulated: false,
  training: false,
  target_terminal_id: 'term-cloud',
  pos_device_id: 'dev-till',
  check_draft: { source: 'pos_send_to_terminal' },
  created_at: ago(60_000),
  updated_at: ago(60_000),
  ...over,
});

// ── isLocalBridgeJob ─────────────────────────────────────────────────────────

test('local bridge: the request flag alone is enough', () => {
  assert.equal(isLocalBridgeJob({ localBridge: true }), true);
  assert.equal(isLocalBridgeJob({ localBridge: false }), false);
  assert.equal(isLocalBridgeJob({}), false);
});

test('local bridge: the MPOS local draft source is recognised without the flag (stale bundle)', () => {
  assert.equal(isLocalBridgeJob({ checkDraft: { source: 'mpos_adyen_local' } }), true);
  // The MPOS CLOUD flow (v5.8.23, a reader bound to the MPOS) is NOT local.
  assert.equal(isLocalBridgeJob({ checkDraft: { source: 'mpos_cloud_terminal' } }), false);
  assert.equal(isLocalBridgeJob({ checkDraft: { source: 'pos_send_to_terminal' } }), false);
  assert.equal(isLocalBridgeJob({ checkDraft: null }), false);
  assert.equal(isLocalBridgeJob({ checkDraft: 'not-an-object' }), false);
});

test('local bridge: terminal row and POS device row sharing one auth uid means the till IS the reader', () => {
  assert.equal(isLocalBridgeJob({ terminalDeviceUid: 'u1', posDeviceUid: 'u1' }), true);
  assert.equal(isLocalBridgeJob({ terminalDeviceUid: 'u1', posDeviceUid: 'u2' }), false);
  // A missing side never matches (claim_device is best-effort; a cloud row has a random uid).
  assert.equal(isLocalBridgeJob({ terminalDeviceUid: 'u1', posDeviceUid: null }), false);
  assert.equal(isLocalBridgeJob({ terminalDeviceUid: null, posDeviceUid: 'u1' }), false);
  assert.equal(isLocalBridgeJob({ terminalDeviceUid: '', posDeviceUid: '' }), false);
});

// ── shouldServerKick ─────────────────────────────────────────────────────────

test('server kick: a fresh adyen cloud job in charging_unsent with a charge is kicked', () => {
  const r = shouldServerKick(job(), { localBridge: false, terminalDeviceUid: cloudTerm.device_uid, posDeviceUid: 'uid-till' });
  assert.equal(r.kick, true);
});

test('server kick: refuses every state the fn would refuse anyway', () => {
  const t = { localBridge: false, terminalDeviceUid: cloudTerm.device_uid, posDeviceUid: 'uid-till' };
  assert.equal(shouldServerKick(job({ processor: 'ryft' }), t).kick, false);
  assert.equal(shouldServerKick(job({ processor: undefined }), t).kick, false);
  assert.equal(shouldServerKick(job({ status: 'pending' }), t).kick, false);
  assert.equal(shouldServerKick(job({ status: 'charging' }), t).kick, false);
  assert.equal(shouldServerKick(job({ status: 'approved' }), t).kick, false);
  assert.equal(shouldServerKick(job({ charge_minor: null }), t).kick, false);
  assert.equal(shouldServerKick(job({ charge_minor: 'abc' }), t).kick, false);
  assert.equal(shouldServerKick(job({ simulated: true }), t).kick, false);
  assert.equal(shouldServerKick(job({ training: true }), t).kick, false);
  assert.equal(shouldServerKick(null, t).kick, false);
});

test('server kick: never for a local-bridge job, by any of the three signals', () => {
  const base = { terminalDeviceUid: cloudTerm.device_uid, posDeviceUid: 'uid-till' };
  assert.equal(shouldServerKick(job(), { ...base, localBridge: true }).kick, false);
  assert.equal(shouldServerKick(job({ check_draft: { source: 'mpos_adyen_local' } }), { ...base, localBridge: false }).kick, false);
  assert.equal(shouldServerKick(job(), { localBridge: false, terminalDeviceUid: 'same', posDeviceUid: 'same' }).kick, false);
  assert.match(shouldServerKick(job(), { ...base, localBridge: true }).reason, /local bridge/);
});

test('server kick: charge_minor may arrive as a bigint string from PostgREST', () => {
  const r = shouldServerKick(job({ charge_minor: '1700' }), { localBridge: false, terminalDeviceUid: 'a', posDeviceUid: 'b' });
  assert.equal(r.kick, true);
});

// ── clientOwnsCreateKick ─────────────────────────────────────────────────────

test('create-time kick: the MPOS cloud flow kicks itself, so terminal-job-create must not race it', () => {
  // v5.8.23 to v5.8.44 MPOS forgets the handle and throws on a lost CAS; a
  // server kick landing 1.5s later would open the v5.5.844 double-charge path.
  assert.equal(clientOwnsCreateKick(job({ check_draft: { source: 'mpos_cloud_terminal' } })), true);
  assert.equal(clientOwnsCreateKick(job({ check_draft: { source: 'pos_send_to_terminal' } })), false);
  assert.equal(clientOwnsCreateKick(job({ check_draft: { source: 'mpos_adyen_local' } })), false);
  assert.equal(clientOwnsCreateKick(job({ check_draft: null })), false);
  assert.equal(clientOwnsCreateKick(job({ check_draft: 'junk' })), false);
  assert.equal(clientOwnsCreateKick(null), false);
  // ...but shouldServerKick itself does NOT refuse it: the sweep uses that rule
  // and must still rescue an MPOS cloud job whose own kick never landed.
  assert.equal(shouldServerKick(job({ check_draft: { source: 'mpos_cloud_terminal' } }), { localBridge: false, terminalDeviceUid: 'a', posDeviceUid: 'b' }).kick, true);
});

// ── selectUnsentSweepCandidates ──────────────────────────────────────────────

const terms = new Map([[cloudTerm.id, cloudTerm], [mposTerm.id, mposTerm], [paxTerm.id, paxTerm]]);
const devs = new Map([
  ['dev-till', { id: 'dev-till', device_uid: 'uid-till' }],
  ['dev-mpos', { id: 'dev-mpos', device_uid: 'uid-mpos-session' }],
]);
const sweep = (jobs, extra = {}) => selectUnsentSweepCandidates(jobs, { terminalsById: terms, devicesById: devs, now: NOW, ...extra });

test('sweep: the 9 Sep Provo job qualifies (cloud reader, unsent 68s, nothing else touched it)', () => {
  const r = sweep([job({ created_at: ago(68_000), updated_at: ago(68_000) })]);
  assert.deepEqual(r.kick, ['job-1']);
  assert.deepEqual(r.skipped, []);
});

test('sweep: the ceiling sits inside the 120s stall rule of adyen-terminal-charge result', () => {
  // 'result' aborts an InProgress tender dispatched more than 120s ago, and a
  // till polls it from 8s after the job goes charging. A re-kick past this
  // ceiling is a prompt the next poll tears down under the customer.
  assert.ok(UNSENT_SWEEP_MAX_AGE_MS <= 100_000, `max age ${UNSENT_SWEEP_MAX_AGE_MS} must leave a margin under 120s`);
  // ...and the window is still wide enough for a 1-minute cron to land in it.
  assert.ok(UNSENT_SWEEP_MAX_AGE_MS - UNSENT_SWEEP_MIN_AGE_MS > 60_000, 'a 1-minute cron must land at least once');
});

test('sweep: age window is 20s to 100s on created_at', () => {
  const young = job({ id: 'young', created_at: ago(UNSENT_SWEEP_MIN_AGE_MS - 1), updated_at: ago(UNSENT_SWEEP_MIN_AGE_MS - 1) });
  const edge = job({ id: 'edge', created_at: ago(UNSENT_SWEEP_MIN_AGE_MS), updated_at: ago(UNSENT_SWEEP_MIN_AGE_MS) });
  const old = job({ id: 'old', created_at: ago(UNSENT_SWEEP_MAX_AGE_MS + 1), updated_at: ago(UNSENT_SWEEP_MAX_AGE_MS + 1) });
  const r = sweep([young, edge, old]);
  assert.deepEqual(r.kick, ['edge']);
  assert.deepEqual(r.skipped.map(s => s.id).sort(), ['old', 'young']);
  assert.equal(r.skipped.find(s => s.id === 'young').reason, 'too young');
  assert.match(r.skipped.find(s => s.id === 'old').reason, /too old/);
});

test('sweep: backs off for 20s after the row was last written (a CAS revert bumps updated_at)', () => {
  const reverted = job({ id: 'reverted', created_at: ago(60_000), updated_at: ago(5_000) });
  const r = sweep([reverted]);
  assert.deepEqual(r.kick, []);
  assert.equal(r.skipped[0].reason, 'recently touched');
  // ...and qualifies again once quiet.
  assert.deepEqual(sweep([job({ id: 'reverted', created_at: ago(60_000), updated_at: ago(20_000) })]).kick, ['reverted']);
  // A revert late in the window is NOT chased past the ceiling: the row is
  // left to terminal_jobs_sweep rather than re-kicked under a 'result' abort.
  const late = job({ id: 'late', created_at: ago(UNSENT_SWEEP_MAX_AGE_MS + 1), updated_at: ago(25_000) });
  assert.match(sweep([late]).skipped[0].reason, /too old/);
});

test('sweep: only a paired CLOUD reader qualifies', () => {
  const pax = job({ id: 'pax', target_terminal_id: 'term-pax' });
  const missing = job({ id: 'missing', target_terminal_id: 'term-nope' });
  const r = sweep([pax, missing]);
  assert.deepEqual(r.kick, []);
  assert.equal(r.skipped.find(s => s.id === 'pax').reason, 'terminal not a cloud reader');
  assert.equal(r.skipped.find(s => s.id === 'missing').reason, 'terminal row missing');
  const retired = new Map(terms);
  retired.set('term-cloud', { ...cloudTerm, status: 'retired', active: false });
  assert.deepEqual(sweep([job()], { terminalsById: retired }).kick, []);
});

test('sweep: an MPOS driving its own reader is skipped by the shared uid even with a plain draft', () => {
  // A stale MPOS bundle that sent neither local_bridge nor (hypothetically) the
  // local source: the terminal row and the POS device row still share one uid.
  const local = job({ id: 'local', target_terminal_id: 'term-mpos', pos_device_id: 'dev-mpos', check_draft: { source: 'something_else' } });
  const r = sweep([local]);
  assert.deepEqual(r.kick, []);
  assert.match(r.skipped[0].reason, /local bridge/);
});

test('sweep: an MPOS driving its own reader is skipped by the draft source when claim_device never stamped a devices row', () => {
  const local = job({ id: 'local', target_terminal_id: 'term-mpos', pos_device_id: null, check_draft: { source: 'mpos_adyen_local' } });
  assert.deepEqual(sweep([local]).kick, []);
});

test('sweep: the MPOS CLOUD flow (reader bound to the MPOS, v5.8.23) IS swept', () => {
  const cloudFromMpos = job({ id: 'mc', target_terminal_id: 'term-cloud', pos_device_id: 'dev-mpos', check_draft: { source: 'mpos_cloud_terminal' } });
  assert.deepEqual(sweep([cloudFromMpos]).kick, ['mc']);
});

test('sweep: bounded to ten per run, oldest first', () => {
  const jobs = [];
  for (let i = 0; i < 14; i++) jobs.push(job({ id: `j${i}`, created_at: ago(30_000 + i * 1000), updated_at: ago(30_000 + i * 1000) }));
  const r = sweep(jobs.reverse());   // handed newest-first on purpose
  assert.equal(r.kick.length, UNSENT_SWEEP_LIMIT);
  assert.deepEqual(r.kick, ['j13', 'j12', 'j11', 'j10', 'j9', 'j8', 'j7', 'j6', 'j5', 'j4']);
  assert.equal(r.skipped.filter(s => s.reason === 'over limit').length, 4);
});

test('sweep: re-checks the base rule even if the query was wider (processor, status, charge, simulated)', () => {
  const r = sweep([
    job({ id: 'ryft', processor: 'ryft' }),
    job({ id: 'charging', status: 'charging' }),
    job({ id: 'nocharge', charge_minor: null }),
    job({ id: 'demo', simulated: true }),
    job({ id: 'ok' }),
  ]);
  assert.deepEqual(r.kick, ['ok']);
});

test('sweep: tolerates junk input', () => {
  assert.deepEqual(sweep(null), { kick: [], skipped: [] });
  assert.deepEqual(sweep([null, {}, { id: 'x', processor: 'adyen', status: 'charging_unsent', charge_minor: 1, target_terminal_id: 'term-cloud' }]).kick, []);
  // plain-object maps work too
  const r = selectUnsentSweepCandidates([job()], { terminalsById: { 'term-cloud': cloudTerm }, devicesById: { 'dev-till': { device_uid: 'uid-till' } }, now: NOW });
  assert.deepEqual(r.kick, ['job-1']);
});
