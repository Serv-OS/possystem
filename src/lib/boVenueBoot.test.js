// boVenueBoot.test.js: a Back Office page holds one venue's data, the venue it resolved.
// 27 Sep 2026, Peter: "for some reason every products tax rate has been removed but they where
// there earlier ... please chase". A Leeds Back Office that booted Train Station's push (the
// browser was paired at Train Station, and sign out had removed rpos-bo-location) pushed Train
// Station's rates and discounts, and Provo's rules and packages, to the Leeds tills.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boVenueBootAction, settleBoVenue, foreignVenueSlices, venueRowsOnly, BO_VENUE_RELOAD_KEY } from './boVenueBoot.js';

const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const TS = '3f915972-7107-4f70-9b3d-de80ba9ab0c2';

const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
};

test('booted for the venue it resolved, or not booted at all: nothing to do', () => {
  assert.equal(boVenueBootAction({ bootedFor: LEEDS, venue: LEEDS }), 'none');
  assert.equal(boVenueBootAction({ bootedFor: null, venue: LEEDS }), 'none');
  assert.equal(boVenueBootAction({ bootedFor: TS, venue: null }), 'none');
});

test('THE LEEDS BACK OFFICE: booted Train Station\'s push, resolved Leeds: reload once, then never again', () => {
  const s = fakeStorage();
  assert.equal(settleBoVenue({ bootedFor: TS, venue: LEEDS, storage: s }), 'reload');
  assert.equal(s.getItem(BO_VENUE_RELOAD_KEY), LEEDS, 'the one reload is remembered for this tab');
  // After the reload SyncBridge boots for Leeds (rpos-bo-location now says Leeds):
  assert.equal(settleBoVenue({ bootedFor: LEEDS, venue: LEEDS, storage: s }), 'none');
  assert.equal(s.getItem(BO_VENUE_RELOAD_KEY), null, 'the marker is forgotten once the venues agree');
});

test('still different after the one reload: clear the other venue\'s slices, never loop', () => {
  const s = fakeStorage();
  s.setItem(BO_VENUE_RELOAD_KEY, LEEDS);
  assert.equal(settleBoVenue({ bootedFor: TS, venue: LEEDS, storage: s }), 'purge');
  assert.equal(settleBoVenue({ bootedFor: TS, venue: LEEDS, storage: s }), 'purge');
});

test('a tab that cannot keep the marker never reloads (it would loop): it clears instead', () => {
  assert.equal(settleBoVenue({ bootedFor: TS, venue: LEEDS, storage: null }), 'purge');
  const forgetful = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  assert.equal(settleBoVenue({ bootedFor: TS, venue: LEEDS, storage: forgetful }), 'purge');
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(settleBoVenue({ bootedFor: TS, venue: LEEDS, storage: throwing }), 'purge');
  assert.equal(settleBoVenue({ bootedFor: LEEDS, venue: LEEDS, storage: throwing }), 'none');
});

test('the cleared slices are the ones a push carried from the other venue', () => {
  assert.deepEqual(foreignVenueSlices(), {
    taxRates: [], taxProfiles: [], venueDefaultTaxProfileId: null,
    discountPresets: [], discountRules: [], packages: [],
  });
  assert.notEqual(foreignVenueSlices().taxRates, foreignVenueSlices().taxRates, 'fresh arrays each time');
});

test('a push and a till keep only this venue\'s packages (Leeds pushed Provo\'s)', () => {
  const PROVO = '7218c716-eeb4-4f96-b284-f3500823595c';
  const rows = [
    { id: 'tasting', name: 'Tasting Menu', locationId: PROVO },
    { id: 'preorder', name: 'Pre Order Dinner', locationId: PROVO },
    { id: 'brunch', name: 'Brunch', locationId: LEEDS },
    { id: 'old', name: 'Untagged' },
    { id: 'snake', name: 'Snake', location_id: PROVO },
  ];
  assert.deepEqual(venueRowsOnly(rows, LEEDS).map((r) => r.id), ['brunch', 'old']);
  assert.deepEqual(venueRowsOnly(rows, null).map((r) => r.id), rows.map((r) => r.id), 'no venue known: nothing dropped');
  assert.deepEqual(venueRowsOnly(undefined, LEEDS), []);
});
