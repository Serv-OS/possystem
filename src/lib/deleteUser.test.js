// src/lib/deleteUser.test.js
// 5.11.123: ServOS can remove a login, and deleting a company leaves no orphan logins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const FN = read('supabase/functions/delete-user/index.ts');
const APP = read('src/admin/CompanyAdminApp.jsx');

test('delete-user: super admin only, second step, never self, never a super admin, never an anonymous session', () => {
  assert.match(FN, /secondStepRefusal\(req\)/);
  assert.match(FN, /callerProfile\?\.role !== 'super_admin'\) return json\(\{ error: 'Only ServOS can remove a login' \}, 403\)/);
  assert.match(FN, /if \(userId === caller\.id\) return json\(\{ error: 'You cannot remove your own login' \}, 400\)/);
  assert.match(FN, /target\.user\.is_anonymous\) return json\(/);
  assert.match(FN, /targetProfile\?\.role === 'super_admin'\) return json\(\{ error: 'That login belongs to a platform administrator' \}, 403\)/);
  assert.match(FN, /admin\.auth\.admin\.deleteUser\(userId\)/);
  // The refusals all come before the delete.
  for (const guard of ["'Only ServOS can remove a login'", "'You cannot remove your own login'", 'is_anonymous', "'That login belongs to a platform administrator'"]) {
    assert.ok(FN.indexOf(guard) < FN.indexOf('admin.auth.admin.deleteUser('), `${guard} is checked before the delete`);
  }
  // Finds by email through the same lookup create-user uses (any user count).
  assert.match(FN, /findAuthUserByEmail\(\{/);
  for (const m of FN.matchAll(/error: '([^']+)'/g)) assert.ok(!m[1].includes('!'), `plain words, no exclamation: ${m[1]}`);
});

test('Admin: Remove login button (not on a super admin), confirm first, and deleteOrg removes the logins', () => {
  assert.match(APP, /functions\/v1\/delete-user/);
  assert.match(APP, /if \(!confirm\(`Remove the login \$\{u\.email\}\?/);
  assert.match(APP, /\{u\.role !== 'super_admin' && \(\s*<button type="button" disabled=\{working\}/);
  assert.match(APP, /Remove login\s*<\/button>/);
  // deleteOrg: every profile of the company goes through removeLogin; only a refusal falls back to the rows.
  const org = APP.slice(APP.indexOf('const deleteOrg = async (org) => {'), APP.indexOf('ok(`✓ "${org.name}" and all its data permanently deleted`)'));
  assert.match(org, /user_profiles\?org_id=eq\.\$\{org\.id\}&select=id,email,role/);
  assert.match(org, /const gone = up\.role !== 'super_admin' && await removeLogin\(\{ userId: up\.id \}, \{ quiet: true \}\);/);
  assert.match(org, /if \(!gone\) \{\s*await sbFetch\(`user_locations\?user_id=eq\.\$\{up\.id\}`/);
  assert.ok(!/user_profiles\?org_id=eq\.\$\{org\.id\}`, \{ method:'DELETE'/.test(org), 'no blanket profile delete that leaves logins behind');
});
