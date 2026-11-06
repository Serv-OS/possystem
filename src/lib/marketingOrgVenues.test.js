// marketingOrgVenues.test.js (6 Nov 2026, 5.12.69): a saved site scope is checked against the
// organisation's own venues, and a failed check or a foreign list REFUSES (never every site).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeForOrg } from '../../supabase/functions/_shared/orgVenues.ts';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const X = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const fakeSb = (answer, seen = []) => ({
  from: (t) => ({ select: () => ({ eq: (k, v) => ({ limit: async () => { seen.push([t, k, v]); return answer; } }) }) }),
});

test('no ids named = every site, and the database is never asked', async () => {
  const seen = [];
  assert.deepEqual(await scopeForOrg(fakeSb({ data: [{ id: A }] }, seen), 'org1', []), { ok: true, ids: [] });
  assert.deepEqual(await scopeForOrg(fakeSb({ data: [{ id: A }] }, seen), 'org1', null), { ok: true, ids: [] });
  assert.deepEqual(await scopeForOrg(fakeSb({ data: [{ id: A }] }, seen), 'org1', ['junk']), { ok: true, ids: [] }, 'rubbish ids are not a scope');
  assert.equal(seen.length, 0);
});

test('own venues survive, foreign ones are dropped, all foreign refuses', async () => {
  const seen = [];
  const sb = fakeSb({ data: [{ id: A }, { id: B }] }, seen);
  assert.deepEqual(await scopeForOrg(sb, 'org1', [A.toUpperCase(), X]), { ok: true, ids: [A] });
  assert.deepEqual(seen[0], ['locations', 'org_id', 'org1']);
  const r = await scopeForOrg(sb, 'org1', [X]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('a failed read refuses with 500 (a Leeds send must never widen to the company)', async () => {
  const r = await scopeForOrg(fakeSb({ data: null, error: { message: 'timeout' } }), 'org1', [A]);
  assert.deepEqual(r, { ok: false, error: 'Your sites could not be checked. Try again.', status: 500 });
  const r2 = await scopeForOrg(fakeSb({ data: [] }), 'org1', [A]);
  assert.equal(r2.ok, false, 'an organisation with no venues on record keeps nothing and says so');
});
