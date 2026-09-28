/**
 * wfAudit.test.js: the wf_audit hash chain writer (supabase/functions/_shared/wfAudit.js, v5.10.3).
 * Run: `npm test`, or `node --test src/lib/wfAudit.test.js`.
 *
 * 28 Sep 2026: INVARIANTS says wf_audit rows form a prev_hash/row_hash chain and are only written
 * by the edge function's writeAudit. manager-approve inserted its own rows (Manager app approvals,
 * time off, clock outs, purchase orders) with no hash and never read the insert error. The writer
 * now lives in _shared and both workforce-compute and manager-approve call it. The recipe is
 * pinned to the hash workforce-compute always wrote, so rows already in the chain still verify.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeWfAudit, auditHashInput, sha256Hex } from '../../supabase/functions/_shared/wfAudit.js';
import { fakeWfDb } from './fixtures/fakeWfDb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (fn) => fs.readFileSync(path.join(here, `../../supabase/functions/${fn}/index.ts`), 'utf8');

const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';
const ORG = 'a1b2c3d4-0001-0001-0001-000000000001';
const TRONC = {
  actorId: '11111111-1111-4111-8111-111111111111', amount: 120.5, currency: 'GBP', entity: 'wf_tronc_runs',
  entityId: '22222222-2222-4222-8222-222222222222', reason: 'pool £120.50 over 3 staff, residual £0.00',
  after: { week_start: '2026-09-21', pool: 120.5, total_paid: 120.5 },
};
// workforce-compute's own recipe before v5.10.3, computed with node's hash, not the writer's.
const oldHash = (loc, org, action, d, prev) => crypto.createHash('sha256').update(JSON.stringify({ loc, org, action, ...d, prev })).digest('hex');

test('the hash is the one workforce-compute always wrote (rows already in the chain still verify)', async () => {
  assert.equal(oldHash(LOC, ORG, 'tronc.run', TRONC, ''), 'fb4f141e3c74327ba4c59ef3d9552fc813569751c40d83e9d6d3496c61507741');
  assert.equal(await sha256Hex(auditHashInput(LOC, ORG, 'tronc.run', TRONC, '')), 'fb4f141e3c74327ba4c59ef3d9552fc813569751c40d83e9d6d3496c61507741');
  const db = fakeWfDb();
  const r = await writeWfAudit(db, LOC, ORG, 'tronc.run', TRONC);
  assert.equal(r.error, null);
  assert.equal(r.row_hash, 'fb4f141e3c74327ba4c59ef3d9552fc813569751c40d83e9d6d3496c61507741');
  const [row] = db.rows('wf_audit');
  assert.deepEqual(
    { ...row, id: undefined, at: undefined },
    {
      id: undefined, at: undefined, location_id: LOC, org_id: ORG, action: 'tronc.run',
      actor_id: TRONC.actorId, actor_name: null, amount: 120.5, currency: 'GBP', reason: TRONC.reason,
      entity: 'wf_tronc_runs', entity_id: TRONC.entityId, before: null, after: TRONC.after,
      prev_hash: '', row_hash: 'fb4f141e3c74327ba4c59ef3d9552fc813569751c40d83e9d6d3496c61507741',
    },
  );
});

test('rows chain per location: each prev_hash is the latest row_hash at that venue, and every hash recomputes', async () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const db = fakeWfDb();
  const approve = { actorId: '33333333-3333-4333-8333-333333333333', actorName: 'Sam (manager)', entity: 'wf_timesheets', entityId: 'ts-a', before: { status: 'pending' }, after: { status: 'approved' } };
  const clockOut = { actorId: approve.actorId, actorName: 'Sam (manager)', entity: 'wf_timesheets', entityId: 'ts-b', before: { clock_in: '2026-09-27T08:00:00.000Z', clock_out: null }, after: { clock_out: '2026-09-27T16:00:00.000Z', actual_hours: 7.5, break_taken: 30, by: 'Sam (manager)' } };
  const steps = [
    [LOC, 'timesheet.approve', approve],
    [OTHER, 'tronc.run', TRONC],
    [LOC, 'timesheet.manager_clock_out', clockOut],
    [LOC, 'tronc.run', TRONC],
  ];
  for (const [loc, action, d] of steps) assert.equal((await writeWfAudit(db, loc, ORG, action, d)).error, null);
  const rows = db.rows('wf_audit');
  const at = (loc) => rows.filter((r) => r.location_id === loc).sort((a, b) => (a.at < b.at ? -1 : 1));
  const leeds = at(LOC);
  assert.equal(leeds.length, 3);
  assert.equal(leeds[0].prev_hash, '');
  assert.equal(leeds[1].prev_hash, leeds[0].row_hash);
  assert.equal(leeds[2].prev_hash, leeds[1].row_hash);
  assert.equal(at(OTHER)[0].prev_hash, '', 'another venue starts its own chain');
  // Recompute from what was given: the chain is checkable.
  const given = [approve, clockOut, TRONC];
  const actions = ['timesheet.approve', 'timesheet.manager_clock_out', 'tronc.run'];
  leeds.forEach((r, i) => assert.equal(r.row_hash, oldHash(LOC, ORG, actions[i], given[i], r.prev_hash)));
  // An edited row no longer matches its hash.
  const tampered = { ...clockOut, after: { ...clockOut.after, actual_hours: 9.5 } };
  assert.notEqual(leeds[1].row_hash, oldHash(LOC, ORG, 'timesheet.manager_clock_out', tampered, leeds[1].prev_hash));
});

test('a failed insert is reported, never dropped', async () => {
  // The (location_id, org_id) pair must exist in locations; a wrong org is refused by the database.
  const db = fakeWfDb();
  db.fail['wf_audit.insert'] = 'insert or update on table "wf_audit" violates foreign key constraint "wf_audit_loc_org_fk"';
  const r = await writeWfAudit(db, LOC, ORG, 'timesheet.approve', { actorId: TRONC.actorId });
  assert.match(r.error, /^audit write failed: .*wf_audit_loc_org_fk/);
  assert.equal(db.rows('wf_audit').length, 0);
  // A throw anywhere (network, bad client) is answered the same way, never thrown on.
  const thrown = { from: () => { throw new Error('fetch failed'); } };
  assert.equal((await writeWfAudit(thrown, LOC, ORG, 'x', {})).error, 'audit write failed: fetch failed');
});

test('a failed chain read writes nothing (a row hashed onto "" would look like a new chain) and says so', async () => {
  const db = fakeWfDb({ wf_audit: [{ id: 'a1', location_id: LOC, org_id: ORG, action: 'x', row_hash: 'abc', at: '2026-09-27T00:00:00.000Z' }] });
  db.fail['wf_audit.select'] = 'canceling statement due to statement timeout';
  const r = await writeWfAudit(db, LOC, ORG, 'timesheet.approve', { actorId: TRONC.actorId });
  assert.equal(r.error, 'audit chain read failed: canceling statement due to statement timeout');
  assert.equal(db.rows('wf_audit').length, 1);
});

test('the chain read is the one workforce-compute always made', async () => {
  const db = fakeWfDb();
  await writeWfAudit(db, LOC, ORG, 'tronc.run', TRONC);
  assert.deepEqual(db.log[0], [
    ['from', 'wf_audit'], ['select', 'row_hash'], ['eq', 'location_id', LOC],
    ['order', 'at', { ascending: false }], ['limit', 1], ['maybeSingle'],
  ]);
});

test('every wf_audit write in the edge functions goes through the chain writer', () => {
  // workforce-compute and manager-approve import it and keep no copy of their own.
  for (const fn of ['workforce-compute', 'manager-approve']) {
    const src = read(fn);
    assert.match(src, /import \{ writeWfAudit \} from '\.\.\/_shared\/wfAudit\.js';/, fn);
    assert.equal((src.match(/from\('wf_audit'\)/g) || []).length, 0, `${fn} writes wf_audit itself`);
    assert.doesNotMatch(src, /crypto\.subtle/, `${fn} hashes on its own`);
  }
  // manager-approve reads the result of every audit and answers a failure.
  const ma = read('manager-approve');
  const calls = ma.match(/await audit\(/g) || [];
  const checked = ma.match(/const auditErr = await audit\(/g) || [];
  assert.equal(calls.length, 4, 'timesheet.clock_out, timesheet.approve, timeoff.decide, po.raise');
  assert.equal(checked.length, calls.length, 'an audit result is ignored');
  assert.equal((ma.match(/if \(auditErr\)/g) || []).length, 4);
});

test("manager-approve's audit failure words do not send the Manager app back to the PIN pad", () => {
  // ManagerTeam onResult and ManagerKitchen submitPO clear the PIN on /pin|not allowed|approve/i.
  const ma = read('manager-approve');
  const whats = [...ma.matchAll(/auditFailed\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(whats, ['The clock out', 'The timesheet sign off', 'The time off decision']);
  const template = ma.match(/error: `\$\{what\} ([^`]+)`/)[1];
  for (const w of whats) assert.doesNotMatch(`${w} ${template}`, /pin|not allowed|approve/i);
  for (const m of ma.matchAll(/error: [`'](Order \$\{reference\}[^`']*|could not raise the order: its audit record did not save)[`']/g)) {
    assert.doesNotMatch(m[1], /pin|not allowed|approve/i);
  }
});
