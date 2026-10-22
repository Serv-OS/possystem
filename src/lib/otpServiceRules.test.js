// node --test: the pure rules of a venue's loyalty code text service (22 Oct 2026, v5.11.94,
// supabase/functions/_shared/otpServiceRules.js). What name a venue's Twilio Verify service must
// carry, what to do when it is missing, gone or drifted, who may run the nightly check, and the
// words Back Office shows. The module is driven end to end in otpServiceEdge.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  twilioName, sameServiceName, desiredName, decideService, auditAccess, venueWords, alertDue, alertRow,
  auditSummary, verifySidOf, isMissingRelation, mapLimit, sidRowType, overrideRowType, isOkState,
  classifyOtpRows, auditRunRow, auditRow, sendShouldRecord, recordable,
  AUDIT_KEY_CHECK, AUDIT_TABLE, AUDIT_RUNS_TABLE, AUDIT_STALE_MINUTES, ALERT_REF_TYPE, ALERT_REPEAT_MS, TWILIO_NAME_MAX,
} from '../../supabase/functions/_shared/otpServiceRules.js';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const SHARED = 'VA00000000000000000000000000000000';
const OWN = 'VA11111111111111111111111111111111';
const LOC = '10000000-0000-4000-8000-000000000001';
const NO_DASH = /[\u2013\u2014]/;

test('twilioName: trimmed, runs of white space made one, cut to 30 (the names Twilio will show)', () => {
  assert.equal(twilioName('  Coffee Shop   Station Road North End  '), 'Coffee Shop Station Road North');
  assert.equal(twilioName('Coffee Shop  Leeds'), 'Coffee Shop Leeds');
  assert.equal(twilioName('A\t\nB'), 'A B');
  assert.equal(twilioName(null), '');
  assert.equal(twilioName(undefined), '');
  assert.equal(twilioName('x'.repeat(40)).length, TWILIO_NAME_MAX);
});

test('sameServiceName: same words, case and spacing aside; an unread name is never good enough', () => {
  assert.equal(sameServiceName('Coffee Shop Leeds', 'coffee shop  leeds '), true);
  assert.equal(sameServiceName('Demo Cafe', 'Coffee Shop Leeds'), false);
  assert.equal(sameServiceName(null, 'Coffee Shop Leeds'), false);
  assert.equal(sameServiceName('', ''), false);
  // the 30 character cut: two long names that agree on their first 30 characters are the same text
  assert.equal(sameServiceName('Coffee Shop Barnsley Train Station', 'Coffee Shop Barnsley Train Stat'), true);
});

test('desiredName: the override when enabled and not blank, else the Ops name, Platform name, company name; never made up', () => {
  assert.equal(desiredName({ override: ' Coffee Stn ', opsName: 'Coffee Shop Station', platformName: 'Coffee Shop - Station', companyName: 'Coffee Co' }), 'Coffee Stn');
  assert.equal(desiredName({ override: 'Coffee Stn', overrideEnabled: false, opsName: 'Coffee Shop Station' }), 'Coffee Shop Station', 'a disabled override is ignored');
  assert.equal(desiredName({ override: '   ', opsName: '', platformName: 'Coffee Shop - Station', companyName: 'Coffee Co' }), 'Coffee Shop - Station');
  assert.equal(desiredName({ companyName: 'Coffee Co' }), 'Coffee Co');
  assert.equal(desiredName({}), '', 'no name anywhere: nothing, never "our venue"');
  assert.equal(desiredName(), '');
  assert.equal(desiredName({ opsName: 'Coffee Shop Barnsley Train Station' }), 'Coffee Shop Barnsley Train Sta', 'cut to what Twilio shows');
});

test('decideService: every branch', () => {
  const desired = 'Coffee Shop Leeds';
  assert.deepEqual(decideService({ sidRow: OWN, desired: '' }), { action: 'wait', state: 'no_name' }, 'no name: never create a service');
  assert.deepEqual(decideService({ sidRow: null, desired }), { action: 'create', state: 'no_service' });
  assert.deepEqual(decideService({ sidRow: 'not-a-sid', desired }), { action: 'create', state: 'no_service' }, 'a row that is not a sid counts as none');
  assert.deepEqual(decideService({ sidRow: SHARED, sharedSid: SHARED, desired }), { action: 'create', state: 'points_at_shared' }, 'the shared service is never this venue\'s own');
  assert.deepEqual(decideService({ sidRow: OWN, sharedSid: SHARED, twilio: { status: 'missing', name: null }, desired }), { action: 'recreate', state: 'missing_on_twilio' });
  assert.deepEqual(decideService({ sidRow: OWN, sharedSid: SHARED, twilio: { status: 'unreadable', name: null }, desired }), { action: 'wait', state: 'twilio_unreadable' });
  assert.deepEqual(decideService({ sidRow: OWN, sharedSid: SHARED, twilio: null, desired }), { action: 'wait', state: 'twilio_unreadable' }, 'not read at all: wait');
  assert.deepEqual(decideService({ sidRow: OWN, sharedSid: SHARED, twilio: { status: 'found', name: 'coffee shop  leeds' }, desired }), { action: 'none', state: 'ready' });
  assert.deepEqual(decideService({ sidRow: OWN, sharedSid: SHARED, twilio: { status: 'found', name: 'Coffee Shop Barnsley' }, desired }), { action: 'rename', state: 'name_drift' });
  assert.deepEqual(decideService({ sidRow: OWN, sharedSid: '', twilio: { status: 'found', name: desired }, desired }), { action: 'none', state: 'ready' }, 'no shared sid known: an own service is still judged');
});

test('auditAccess fails closed: the service role or staff pass; the cron key only when the database says true', () => {
  assert.deepEqual(auditAccess({ service: true }), { ok: true, by: 'service_role', status: 200, reason: null });
  assert.deepEqual(auditAccess({ staff: true }), { ok: true, by: 'staff', status: 200, reason: null });
  assert.deepEqual(auditAccess({ key: 'k', check: { data: true, error: null } }), { ok: true, by: 'cron_key', status: 200, reason: null });
  assert.deepEqual(auditAccess({}), { ok: false, by: null, status: 403, reason: 'not_allowed' }, 'no key, not staff: refused');
  assert.equal(auditAccess({ key: 'k', check: { data: false, error: null } }).reason, 'wrong_cron_key');
  assert.equal(auditAccess({ key: 'k', check: { data: 'true', error: null } }).ok, false, 'only a real true');
  assert.equal(auditAccess({ key: 'k', check: null }).ok, false, 'never asked: refused');
  assert.deepEqual(auditAccess({ key: 'k', check: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.loyalty_otp_cron_ok' } } }), { ok: false, by: null, status: 503, reason: 'needs_database_update' }, 'before 20261022b: refused, never open');
  assert.equal(auditAccess({ key: 'k', check: { data: null, error: { code: '57014', message: 'statement timeout' } } }).reason, 'cron_key_check_failed');
  assert.equal(AUDIT_KEY_CHECK, 'loyalty_otp_cron_ok');
});

test('venueWords has plain words for every state, quotes the names, and carries no dashes', () => {
  const states = ['ready', 'no_name', 'no_service', 'points_at_shared', 'missing_on_twilio', 'twilio_unreadable', 'name_drift', 'not_provisioned', 'not_configured', 'wrong_company', 'db_unreadable', 'something_else'];
  for (const state of states) {
    const w = venueWords({ state, name: 'Coffee Shop  Leeds', desired_name: 'Coffee Stn', twilio_error: 'Too many services' });
    assert.ok(w.length > 10, state);
    assert.doesNotMatch(w, NO_DASH, state);
  }
  assert.equal(venueWords({ state: 'ready', name: 'Coffee Shop  Leeds' }), 'Text service: ready as "Coffee Shop Leeds"');
  assert.match(venueWords({ state: 'no_service', twilio_error: 'Too many services' }), /^Not set up: .*The text provider said: Too many services\.$/);
  assert.match(venueWords({ state: 'name_drift', name: 'Old Name', desired_name: 'New Name' }), /named "Old Name" but should be "New Name"/);
  assert.match(venueWords({ state: 'twilio_unreadable' }), /^Could not check/);
  assert.ok(isOkState('ready') && !isOkState('name_drift'));
  // 22 Oct 2026 review: "loyalty is off, no code texts are sent" was not true (the kiosk, online and
  // QR sign in send codes whatever the switch says), so it is no longer a state, and never "ok"
  assert.equal(isOkState('loyalty_off'), false);
  assert.doesNotMatch(read('supabase/functions/_shared/otpServiceRules.js'), /case 'loyalty_off'/);
  assert.doesNotMatch(venueWords({ state: 'loyalty_off' }), /no code texts are sent/);
  assert.doesNotMatch(read('supabase/functions/_shared/otpService.ts'), /whenLoyaltyOff|loyalty_config/, 'the loyalty switch no longer decides which venues are checked');
  assert.match(venueWords({ state: 'wrong_company' }), /different company/);
});

test('alertDue: one open feed alert per venue per week', () => {
  const now = Date.parse('2026-10-22T04:10:00Z');
  assert.equal(alertDue({ latest: null, now }), true);
  assert.equal(alertDue({ latest: { created_at: '2026-10-21T04:10:00Z', acked_at: null }, now }), false, 'yesterday\'s is still open');
  assert.equal(alertDue({ latest: { created_at: '2026-10-21T04:10:00Z', acked_at: '2026-10-21T09:00:00Z' }, now }), true, 'acknowledged: say it again');
  assert.equal(alertDue({ latest: { created_at: new Date(now - ALERT_REPEAT_MS - 1000).toISOString(), acked_at: null }, now }), true, 'older than a week');
  assert.equal(alertDue({ latest: { created_at: 'garbage', acked_at: null }, now }), true);
  const row = alertRow({ state: 'no_service', location_id: LOC, twilio_error: 'Too many services' });
  assert.equal(row.location_id, LOC);
  assert.deepEqual([row.kind, row.severity, row.ref_type, row.ref_id], ['system', 'action', ALERT_REF_TYPE, LOC]);
  assert.match(row.body, /press Fix\.$/);
  assert.doesNotMatch(row.title + row.body, NO_DASH);
});

test('auditSummary: counts by state, the venues to alert, skipped venues, legacy and orphan rows', () => {
  const s = auditSummary([
    { location_id: 'a', company_id: 'c', state: 'ready', ok: true },
    { location_id: 'b', company_id: 'c', state: 'no_service', twilio_error: 'x' },
    { location_id: 'd', skipped: 'out of time' },
    null,
  ], { legacy_rows: [{ company_id: 'c', message_type: 'loyalty_otp' }] });
  assert.equal(s.ok, false);
  assert.equal(s.checked, 3, 'the null is counted as checked by position; the skipped one is not');
  assert.equal(s.ready, 1);
  assert.deepEqual(s.by_state, { ready: 1, no_service: 1 });
  assert.deepEqual(s.not_ready.map((n) => n.location_id), ['b']);
  assert.match(s.not_ready[0].words, /^Not set up/);
  assert.deepEqual(s.skipped, ['d']);
  assert.equal(s.legacy_rows.length, 1);
  assert.deepEqual(s.orphan_rows, []);
  assert.equal(auditSummary([{ location_id: 'a', state: 'ready' }]).ok, true);
});

test('small helpers: sids, row types, a missing table, mapLimit', async () => {
  assert.equal(verifySidOf(` ${OWN} `), OWN);
  assert.equal(verifySidOf('VAshort'), null);
  assert.equal(verifySidOf(null), null);
  assert.equal(sidRowType(LOC), `loyalty_otp_service:${LOC}`);
  assert.equal(overrideRowType(LOC), `loyalty_otp:${LOC}`);
  assert.equal(AUDIT_TABLE, 'loyalty_otp_service_audit');
  assert.equal(isMissingRelation({ code: 'PGRST205', message: "Could not find the table 'public.loyalty_otp_service_audit' in the schema cache" }), true);
  assert.equal(isMissingRelation({ code: '42P01', message: 'relation "loyalty_otp_service_audit" does not exist' }), true);
  assert.equal(isMissingRelation({ code: '23505', message: 'duplicate key' }), false);
  assert.equal(isMissingRelation(null), false);
  const out = await mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); return n * 10; });
  assert.deepEqual(out, [10, { error: 'boom' }, 30]);
});

test('20261022b (Ops): the key is made inside the database, checked by the service role only, sent by the 04:10 job, and the audit table is closed', () => {
  const sql = read('supabase/migrations/20261022b_OPS_loyalty_otp_audit.sql');
  assert.match(sql, /to_regclass\('public\.user_locations'\) is null or to_regclass\('public\.billing_state'\) is not null/, 'the Ops guard');
  assert.match(sql, /vault\.create_secret\(\s*replace\(gen_random_uuid\(\)::text \|\| gen_random_uuid\(\)::text, '-', ''\),\s*'loyalty_otp_cron_key'/, 'the key is made by the database');
  assert.match(sql, new RegExp(`create or replace function public\\.${AUDIT_KEY_CHECK}\\(p_key text\\)`));
  assert.match(sql, new RegExp(`revoke all on function public\\.${AUDIT_KEY_CHECK}\\(text\\) from public, anon, authenticated;`));
  assert.match(sql, new RegExp(`grant execute on function public\\.${AUDIT_KEY_CHECK}\\(text\\) to service_role;`));
  assert.match(sql, /revoke all on function public\.loyalty_otp_audit_send\(\) from public, anon, authenticated, service_role;/, 'nobody may call the sender but the job');
  assert.match(sql, /cron\.schedule\('loyalty-otp-audit', '10 4 \* \* \*', 'select public\.loyalty_otp_audit_send\(\);'\)/);
  assert.match(sql, /'x-cron-key', k/, 'the key travels in the header, read at call time');
  assert.match(sql, /functions\/v1\/loyalty-otp'/);
  assert.match(sql, /"action": "audit"/);
  assert.match(sql, new RegExp(`create table if not exists public\\.${AUDIT_TABLE} \\(`));
  assert.match(sql, new RegExp(`alter table public\\.${AUDIT_TABLE} enable row level security;`));
  assert.match(sql, new RegExp(`revoke all on table public\\.${AUDIT_TABLE} from public, anon, authenticated;`));
  assert.doesNotMatch(sql, /create policy/, 'no policies: service role only');
  assert.doesNotMatch(sql, NO_DASH);
  const back = read('supabase/migrations/20261022b_OPS_loyalty_otp_audit_ROLLBACK.sql');
  assert.match(back, /drop function if exists public\.loyalty_otp_cron_ok\(text\);/);
  assert.match(back, new RegExp(`drop table if exists public\\.${AUDIT_TABLE};`));
  // the run table the watchdog reads (review, 22 Oct 2026): closed, service role only, in the check row
  assert.match(sql, new RegExp(`create table if not exists public\\.${AUDIT_RUNS_TABLE} \\(`));
  assert.match(sql, new RegExp(`alter table public\\.${AUDIT_RUNS_TABLE} enable row level security;`));
  assert.match(sql, new RegExp(`revoke all on table public\\.${AUDIT_RUNS_TABLE} from public, anon, authenticated;`));
  assert.match(sql, /grant select, insert, delete on table public\.loyalty_otp_audit_runs to service_role;/);
  assert.match(sql, /as runs_table_closed;/);
  for (const col of ['ran_at', 'run_by', 'company_id', 'fix', 'ok', 'checked', 'ready', 'not_ready', 'skipped', 'errors', 'ms']) {
    assert.ok(Object.prototype.hasOwnProperty.call(auditRunRow({}), col), `auditRunRow writes ${col}`);
    assert.match(sql.slice(sql.indexOf(`create table if not exists public.${AUDIT_RUNS_TABLE}`)), new RegExp(`\\n  ${col}\\s`), `the table has ${col}`);
  }
  assert.match(back, new RegExp(`drop table if exists public\\.${AUDIT_RUNS_TABLE};`));
});

test('classifyOtpRows: legacy rows, and venue rows that are not a venue of their own company', () => {
  const A = 'c0000000-0000-4000-8000-00000000000a';
  const B = 'c0000000-0000-4000-8000-00000000000b';
  const locs = [{ company_id: A, ops_location_id: 'L1' }, { company_id: B, ops_location_id: 'L2' }];
  const out = classifyOtpRows([
    { company_id: A, message_type: 'loyalty_otp_service' },
    { company_id: A, message_type: 'loyalty_otp' },
    { company_id: A, message_type: 'loyalty_otp_service:L1' },
    { company_id: A, message_type: 'loyalty_otp:L1' },
    { company_id: A, message_type: 'loyalty_otp_service:L2' },   // B's venue, written under A
    { company_id: B, message_type: 'loyalty_otp_service:L9' },   // gone
    { company_id: B, message_type: 'loyalty_otp_ready' },        // not ours
  ], locs);
  assert.deepEqual(out.legacy.map((r) => r.message_type), ['loyalty_otp_service', 'loyalty_otp']);
  assert.deepEqual(out.orphan.map((r) => `${r.company_id === A ? 'A' : 'B'} ${r.message_type}`), ['A loyalty_otp_service:L2', 'B loyalty_otp_service:L9']);
  assert.deepEqual(classifyOtpRows(null, null), { legacy: [], orphan: [] });
});

test('auditRunRow, auditRow, recordable, sendShouldRecord: what the watchdog can read, and only real venue states', () => {
  const run = auditRunRow({ ok: true, checked: 3, ready: 3, not_ready: [], skipped: [], errors: [], ms: 12.4 }, { by: 'cron_key', at: new Date('2026-10-22T04:10:00Z') });
  assert.deepEqual(run, { ran_at: '2026-10-22T04:10:00.000Z', run_by: 'cron_key', company_id: null, fix: true, ok: true, checked: 3, ready: 3, not_ready: 0, skipped: 0, errors: [], ms: 12 });
  const bad = auditRunRow({ ok: true, errors: ['x'.repeat(400)], skipped: ['a', 'b'] }, { companyId: 'c', fix: false });
  assert.deepEqual([bad.ok, bad.company_id, bad.fix, bad.skipped, bad.errors[0].length], [false, 'c', false, 2, 300], 'an error makes the run not ok; long words are cut');
  const row = auditRow({ location_id: LOC, company_id: 'c', state: 'no_service', twilio_error: 'nope' }, 'send');
  assert.deepEqual([row.ok, row.state, row.action_taken, row.run_by, row.twilio_error], [false, 'no_service', 'none', 'send', 'nope']);
  for (const st of ['not_provisioned', 'wrong_company', 'db_unreadable']) {
    assert.equal(recordable({ state: st }), false, st);
    assert.equal(sendShouldRecord({ state: st, action_taken: 'none' }, true), false, st);
  }
  assert.equal(sendShouldRecord({ state: 'no_service', action_taken: 'none' }, true), true, 'a refusal is recorded');
  assert.equal(sendShouldRecord({ state: 'ready', action_taken: 'created' }, false), true, 'a repair is recorded');
  assert.equal(sendShouldRecord({ state: 'ready', action_taken: 'none' }, false), false, 'a plain send is not');
  assert.equal(AUDIT_STALE_MINUTES, 26 * 60);
});

test('the new words in the rules module and the changelog entry carry no dashes', () => {
  const rules = read('supabase/functions/_shared/otpServiceRules.js');
  assert.doesNotMatch(rules, NO_DASH);
  const log = read('src/lib/changelog.js');
  const entry = log.slice(log.indexOf("v: '5.11.94'"), log.indexOf("v: '5.11.90'"));
  assert.ok(entry.length > 100, 'the 5.11.94 entry is at the top');
  assert.doesNotMatch(entry, NO_DASH);
  assert.match(read('src/lib/version.js'), /VERSION = '5\.11\.94'/);
});
