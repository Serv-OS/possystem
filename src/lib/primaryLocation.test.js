// src/lib/primaryLocation.test.js: holiday and PTO at a person's primary location (5.12.55).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primaryRecord, personBalance } from '../../supabase/functions/_shared/primaryLocation.js';

const rp = { id: 'rp', location_id: 'LP', primary_venue_id: 'LP', created_at: '2026-10-01' };
const rd = { id: 'rd', location_id: 'LD', primary_venue_id: 'LP', created_at: '2026-11-01' };

test('the primary location every linked record names', () => {
  assert.equal(primaryRecord([rd, rp]).id, 'rp');
  assert.equal(primaryRecord([{ ...rp, primary_venue_id: 'LD' }, { ...rd, primary_venue_id: 'LD' }]).id, 'rd');
});

test('none set or disagreeing: the record they were first added at', () => {
  assert.equal(primaryRecord([{ ...rd, primary_venue_id: null }, { ...rp, primary_venue_id: null }]).id, 'rp');
  assert.equal(primaryRecord([{ ...rp, primary_venue_id: 'LX' }, { ...rd, primary_venue_id: 'LY' }]).id, 'rp', 'a primary that is not one of their sites is ignored');
});

test('leavers never count, no records means none', () => {
  assert.equal(primaryRecord([{ ...rp, status: 'leaver' }, rd]).id, 'rd');
  assert.equal(primaryRecord([]), null);
});

test('one balance from every site: earned at both, taken at the primary', () => {
  // Provo earned 1.5, Daybreak earned 1, 2 taken at Provo.
  assert.equal(personBalance([{ accrued_hours: 1.5 }, { accrued_hours: 1 }, { accrued_hours: -2 }]), 0.5);
  assert.equal(personBalance([]), 0);
});
