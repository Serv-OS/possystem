import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickConsentedOrg, organisationChoices } from '../../../supabase/functions/_shared/xeroOrg.js';

const retail = { id: 'c1', tenantId: 'b2d3', tenantType: 'ORGANISATION', tenantName: 'Coffeeboy Retail LTD', createdDateUtc: '2026-09-28T15:12:00Z', updatedDateUtc: '2026-09-28T15:12:00Z' };
const tdnz = { id: 'c2', tenantId: 'td01', tenantType: 'ORGANISATION', tenantName: 'TDNZ', createdDateUtc: '2026-10-02T11:05:00Z', updatedDateUtc: '2026-10-02T11:05:00Z' };

test('the organisation just consented to is the one Xero touched last, not the first in the list (Coffee Boy, 7 Oct 2026)', () => {
  assert.equal(pickConsentedOrg([retail, tdnz]).tenantId, 'td01');
  assert.equal(pickConsentedOrg([tdnz, retail]).tenantId, 'td01');
  // Re-consenting an older organisation moves its updated stamp forward.
  const again = { ...retail, updatedDateUtc: '2026-10-07T09:00:00Z' };
  assert.equal(pickConsentedOrg([again, tdnz]).tenantId, 'b2d3');
});

test('no stamps = the first organisation (the old rule); practices never win over organisations; empty = null', () => {
  const a = { tenantId: 'a', tenantType: 'ORGANISATION', tenantName: 'A' };
  const b = { tenantId: 'b', tenantType: 'ORGANISATION', tenantName: 'B' };
  assert.equal(pickConsentedOrg([a, b]).tenantId, 'a');
  const practice = { tenantId: 'p', tenantType: 'PRACTICE', tenantName: 'P', updatedDateUtc: '2027-01-01T00:00:00Z' };
  assert.equal(pickConsentedOrg([practice, a]).tenantId, 'a');
  assert.equal(pickConsentedOrg([practice]).tenantId, 'p', 'only a practice: still something to store');
  assert.equal(pickConsentedOrg([]), null);
  assert.equal(pickConsentedOrg(null), null);
});

test('organisationChoices: organisations only, no duplicates, current first then by name', () => {
  const out = organisationChoices([tdnz, retail, { ...retail, id: 'dup' }, { tenantId: 'p', tenantType: 'PRACTICE', tenantName: 'P' }], 'b2d3');
  assert.deepEqual(out, [
    { tenantId: 'b2d3', tenantName: 'Coffeeboy Retail LTD', current: true },
    { tenantId: 'td01', tenantName: 'TDNZ', current: false },
  ]);
  assert.deepEqual(organisationChoices(undefined, 'x'), []);
});
