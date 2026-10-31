// 5.12.1: which company a website-admin call works on (pure rule, shared with the edge functions).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCompany } from '../../../supabase/functions/_shared/websiteRules.js';

const owner = { companyIds: ['c1', 'c2'], superAdmin: false, service: false };
const single = { companyIds: ['c1'], superAdmin: false, service: false };
const admin = { companyIds: [], superAdmin: true, service: false };

test('a login with several companies lands on the company of the venue it is open on', () => {
  assert.deepEqual(pickCompany(owner, { locationCompanies: ['c2'] }), { companyId: 'c2' });
});

test('without a venue, several companies still asks which one (the old message, with the list)', () => {
  const r = pickCompany(owner, {});
  assert.equal(r.status, 400);
  assert.match(r.problem, /more than one company/);
  assert.deepEqual(r.companies, ['c1', 'c2']);
});

test('the venue company must be one the login manages', () => {
  const r = pickCompany(owner, { locationCompanies: ['c9'] });
  assert.equal(r.status, 403);
});

test('an explicit company_id wins over the venue and must be managed', () => {
  assert.deepEqual(pickCompany(owner, { wanted: 'c1', locationCompanies: ['c2'] }), { companyId: 'c1' });
  assert.equal(pickCompany(owner, { wanted: 'c9', locationCompanies: ['c2'] }).status, 403);
});

test('one company never needs a venue or a pick', () => {
  assert.deepEqual(pickCompany(single, {}), { companyId: 'c1' });
  assert.deepEqual(pickCompany(single, { locationCompanies: [] }), { companyId: 'c1' });
});

test('a super admin may use the venue company or name one, and is asked otherwise', () => {
  assert.deepEqual(pickCompany(admin, { locationCompanies: ['c7'] }), { companyId: 'c7' });
  assert.deepEqual(pickCompany(admin, { wanted: 'c8' }), { companyId: 'c8' });
  assert.equal(pickCompany(admin, {}).status, 400);
});

test('a venue that maps to no company or two companies does not pick for an owner', () => {
  assert.equal(pickCompany(owner, { locationCompanies: [] }).status, 400);
  assert.equal(pickCompany(owner, { locationCompanies: ['c1', 'c2'] }).status, 400);
});
