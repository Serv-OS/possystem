// ezcaterScope.test.js — whose ezCater connection is this?
//
// 23 Sep 2026: Peter connected ezCater at Provo and every venue on the platform,
// Coffee Boy included, showed "Connected". Disconnect at any of them would have
// deleted Provo's connection (ezCater cannot reissue the token), and "map
// caterer" could have moved Provo's caterer, and its orders, to another company.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chooseConnection, canAdoptCaterer, visibleUnmapped } from '../../supabase/functions/_shared/ezcaterScope.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PROVO_ORG = 'a59a6d97';
const COFFEE_BOY_ORG = 'cd97f0f0';
const provoConn = { id: 'conn-provo', company_id: PROVO_ORG, status: 'connected' };

// ── the bug itself ──────────────────────────────────────────────────────────

test('a Coffee Boy venue is NOT shown Provo\'s connection', () => {
  // The old fallback handed "the single connected row" to any venue with
  // nothing mapped. That is exactly what put Provo on every screen.
  assert.equal(chooseConnection({ orgId: COFFEE_BOY_ORG, mappedConnection: null, orgConnection: provoConn }), null);
  assert.equal(chooseConnection({ orgId: COFFEE_BOY_ORG, mappedConnection: provoConn, orgConnection: null }), null,
    'even if a stray mapping pointed at it');
});

test('Provo still sees its own', () => {
  assert.equal(chooseConnection({ orgId: PROVO_ORG, orgConnection: provoConn }), provoConn);
  assert.equal(chooseConnection({ orgId: PROVO_ORG, mappedConnection: provoConn }), provoConn);
});

test('a connection with no owner is served to NOBODY', () => {
  // The live row had company_id null. Null belongs to no organisation, and
  // "no organisation" must never mean "every organisation".
  const orphan = { id: 'x', company_id: null, status: 'connected' };
  assert.equal(chooseConnection({ orgId: PROVO_ORG, orgConnection: orphan }), null);
  assert.equal(chooseConnection({ orgId: COFFEE_BOY_ORG, mappedConnection: orphan }), null);
  assert.equal(chooseConnection({ orgId: null, orgConnection: provoConn }), null, 'and a venue with no org gets nothing');
});

// ── adopting a caterer ──────────────────────────────────────────────────────

test('another organisation cannot adopt Provo\'s caterer', () => {
  // Their orders would follow it.
  const caterer = { caterer_uuid: 'c1', connection_id: 'conn-provo', location_id: 'provo-loc' };
  const v = canAdoptCaterer({ caterer, orgConnectionIds: ['conn-coffee-boy'], opsLocationId: 'barnsley' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /different ezCater connection/);
});

test('a caterer already mapped to another venue is never silently re-pointed', () => {
  const caterer = { caterer_uuid: 'c1', connection_id: 'conn-provo', location_id: 'provo-loc' };
  const v = canAdoptCaterer({ caterer, orgConnectionIds: ['conn-provo'], opsLocationId: 'location-2' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /already mapped to another venue/);
});

test('an unmapped caterer on your own connection may be adopted, and re-saving your own is fine', () => {
  const fresh = { caterer_uuid: 'c2', connection_id: 'conn-provo', location_id: null };
  assert.equal(canAdoptCaterer({ caterer: fresh, orgConnectionIds: ['conn-provo'], opsLocationId: 'provo-loc' }).ok, true);
  const mine = { caterer_uuid: 'c1', connection_id: 'conn-provo', location_id: 'provo-loc' };
  assert.equal(canAdoptCaterer({ caterer: mine, orgConnectionIds: ['conn-provo'], opsLocationId: 'provo-loc' }).ok, true);
});

test('a caterer nobody has heard of cannot be conjured from the request body', () => {
  // The old upsert would have CREATED it, mapped, from whatever uuid was posted.
  const v = canAdoptCaterer({ caterer: null, orgConnectionIds: ['conn-provo'], opsLocationId: 'provo-loc' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /Refresh list/);
});

test('the unmapped list only offers your own organisation\'s caterers', () => {
  const rows = [
    { caterer_uuid: 'a', connection_id: 'conn-provo', location_id: null },
    { caterer_uuid: 'b', connection_id: 'conn-coffee-boy', location_id: null },
    { caterer_uuid: 'c', connection_id: null, location_id: null },
    { caterer_uuid: 'd', connection_id: 'conn-provo', location_id: 'provo-loc' },
  ];
  assert.deepEqual(visibleUnmapped(rows, ['conn-provo']).map((r) => r.caterer_uuid), ['a']);
  assert.deepEqual(visibleUnmapped(rows, ['conn-coffee-boy']).map((r) => r.caterer_uuid), ['b']);
  assert.deepEqual(visibleUnmapped(rows, []), []);
});

// ── the edge function actually uses the rules ───────────────────────────────

test('ezcater-connect owns every connection and asks the rules, not a global fallback', () => {
  const fn = read('../../supabase/functions/ezcater-connect/index.ts');
  assert.match(fn, /from '\.\.\/_shared\/ezcaterScope\.js'/);
  assert.match(fn, /company_id: orgId,/, 'a new connection is stamped with its owner');
  assert.match(fn, /return chooseConnection\(\{ orgId, mappedConnection, orgConnection \}\);/);
  assert.doesNotMatch(fn, /\.eq\('status', 'connected'\)\.order\('connected_at'/, 'the "single connected row" fallback is gone');
  assert.match(fn, /canAdoptCaterer\(\{ caterer, orgConnectionIds: orgIds, opsLocationId \}\)/);
  assert.match(fn, /unmapped: visibleUnmapped\(/);
  assert.match(fn, /already connected to ezCater\. Disconnect it first/, 'one live connection per organisation');
});
