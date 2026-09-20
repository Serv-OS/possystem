// companyStaffAccess.test.js: database fence stage 1, contract P3. The Back Office online gift
// purchases list is served only to staff of the company, never to "any JWT", and never carries
// the spendable fulfilled_code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decideCompanyStaff, PURCHASE_LIST_COLUMNS } from '../../supabase/functions/_shared/companyStaffAccess.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const base = { user: { id: 'u1' }, role: 'owner', userLocationIds: [], companyOpsLocationIds: ['L1', 'L2'], companyRoleCompanyIds: [], companyId: 'C1' };

test('staff of the company: a linked venue, a super admin, or a company role', () => {
  assert.deepEqual(decideCompanyStaff({ ...base, userLocationIds: ['L2'] }), { ok: true, via: 'user_locations' });
  assert.deepEqual(decideCompanyStaff({ ...base, role: 'super_admin' }), { ok: true, via: 'super_admin' });
  assert.deepEqual(decideCompanyStaff({ ...base, companyRoleCompanyIds: ['C1'] }), { ok: true, via: 'company_role' });
});

test('not staff: anonymous, another company, no link, or only a profile venue', () => {
  assert.equal(decideCompanyStaff({ ...base, user: { id: 'u1', is_anonymous: true }, role: 'super_admin' }).ok, false, 'an anonymous session is never staff');
  assert.equal(decideCompanyStaff({ ...base, user: null }).ok, false);
  assert.equal(decideCompanyStaff({ ...base, userLocationIds: ['L9'] }).ok, false);
  assert.equal(decideCompanyStaff({ ...base, companyRoleCompanyIds: ['C2'] }).ok, false);
  assert.equal(decideCompanyStaff({ ...base, companyId: null, userLocationIds: ['L1'] }).ok, false);
  assert.equal(decideCompanyStaff(base).ok, false, 'a login with no link is not staff (the profile venue is not access)');
});

test('the list never carries fulfilled_code, and gift-list checks staff before reading', () => {
  assert.ok(!PURCHASE_LIST_COLUMNS.includes('fulfilled_code'));
  for (const c of ['id', 'amount_minor', 'currency', 'status', 'code_last4', 'created_at']) assert.ok(PURCHASE_LIST_COLUMNS.includes(c));
  const fn = read('../../supabase/functions/gift-list/index.ts');
  // Money function fence (19 Sep 2026): ONE staff gate for every action, before any read.
  const gate = fn.indexOf('const staff = await callerIsStaffFor(caller,');
  assert.ok(gate > 0, 'gift-list asks callerIsStaffFor');
  assert.ok(fn.indexOf('decideGiftListAuthority({ user: caller, staff })') > gate);
  assert.ok(gate < fn.indexOf(".from('gift_card_purchases')"), 'the staff check comes before the purchases read');
  assert.ok(gate < fn.indexOf(".from('gift_cards')"), 'the staff check comes before the cards read');
  const i = fn.indexOf("if (body.action === 'purchases' || body.kind === 'purchases') {");
  assert.ok(i > gate);
  const block = fn.slice(i, i + 900);
  assert.ok(block.includes('.select(PURCHASE_LIST_COLUMNS)'));
  assert.ok(!read('../../supabase/functions/gift-fulfill/index.ts').includes('fulfilled_code: normalized'), 'fulfil no longer copies the code onto the purchase');
  assert.ok(read('../../supabase/functions/gift-resend/index.ts').includes('const resendCode = (card as any).code_plain || purchase.fulfilled_code || null;'));
});
