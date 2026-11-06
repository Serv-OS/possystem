// marketingVenueScope.test.js (6 Nov 2026, 5.12.68): the site scope a campaign or automation carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteScopeIds, venueRule, withSiteScope, siteScopeLabel, keepOrgVenues } from '../../supabase/functions/_shared/venueScope.js';

const A = '33333333-3333-3333-3333-333333333333';
const B = '34333333-3333-3333-3333-333333333333';

test('siteScopeIds: campaign schedule, automation trigger, rubbish dropped, empty = every site', () => {
  assert.deepEqual(siteScopeIds({ schedule: { location_ids: [A, B, A] } }), [A, B]);
  assert.deepEqual(siteScopeIds({ entry_trigger: { location_ids: [B.toUpperCase()] } }), [B]);
  assert.deepEqual(siteScopeIds({ schedule: { location_ids: ['x', '', null, 42] } }), []);
  assert.deepEqual(siteScopeIds({ schedule: {} }), []);
  assert.deepEqual(siteScopeIds({ schedule: { location_ids: 'not a list' } }), []);
  assert.deepEqual(siteScopeIds(null), []);
});

test('venueRule and withSiteScope: one more rule through the same resolver, nothing when empty', () => {
  assert.deepEqual(venueRule([A]), { field: 'venue', op: 'in', value: { venues: [A] } });
  assert.deepEqual(venueRule([A], { days: 30 }), { field: 'venue', op: 'in', value: { venues: [A], days: 30 } });
  assert.deepEqual(venueRule([A], { mode: 'home', days: 30, op: 'not_in' }), { field: 'home_venue', op: 'not_in', value: { venues: [A] } });
  const def = { match: 'any', rules: [{ field: 'visit_count', op: 'gte', value: 3 }] };
  assert.equal(withSiteScope(def, []), def, 'empty scope: the definition itself');
  assert.deepEqual(withSiteScope(def, [A, 'junk']), { match: 'all', rules: [def, { field: 'venue', op: 'in', value: { venues: [A] } }] });
  assert.deepEqual(withSiteScope(null, [B]), { match: 'all', rules: [{ match: 'all', rules: [] }, { field: 'venue', op: 'in', value: { venues: [B] } }] });
});

test('siteScopeLabel: names from the venue list, All sites when empty', () => {
  const venues = [{ id: A, name: 'Leeds' }, { id: B, name: 'Hudds' }];
  assert.equal(siteScopeLabel([], venues), 'All sites');
  assert.equal(siteScopeLabel([B, A], venues), 'Hudds, Leeds');
  assert.equal(siteScopeLabel(['55555555-5555-5555-5555-555555555555'], venues), 'a venue no longer here');
});

test('keepOrgVenues (5.12.69): only the organisation\'s own venues survive a save', () => {
  assert.deepEqual(keepOrgVenues([A, B], [A]), [A]);
  assert.deepEqual(keepOrgVenues([A, B], [A.toUpperCase(), B]), [A, B]);
  assert.deepEqual(keepOrgVenues([], [A]), []);
  assert.deepEqual(keepOrgVenues(['junk', B], null), [B], 'no org list known: the valid ids as they are');
  assert.deepEqual(keepOrgVenues([A], []), [], 'an organisation with no venues keeps none');
  assert.deepEqual(keepOrgVenues(null, [A]), []);
});
