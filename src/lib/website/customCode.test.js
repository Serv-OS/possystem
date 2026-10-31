// node --test: custom code on the public site is an owner only switch (ARCHITECTURE.md sections 1
// and 4.8). settings.allow_custom_code and settings.custom_head_html run script on every visitor's
// page, so website-admin save_site refuses them from any Back Office login that is not the owner,
// a super admin or the service role. The rule is pure (websiteRules.js) and the edge function is
// read as text to make sure it is wired in front of the settings merge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { touchesCustomCode, mayChangeCustomCode, CUSTOM_CODE_KEYS, validateSitePatch } from '../../../supabase/functions/_shared/websiteRules.js';

const read = (rel) => fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

test('touchesCustomCode: only the two code keys, and only when present', () => {
  assert.deepEqual([...CUSTOM_CODE_KEYS], ['allow_custom_code', 'custom_head_html']);
  assert.equal(touchesCustomCode({ allow_custom_code: true }), true);
  assert.equal(touchesCustomCode({ allow_custom_code: false }), true, 'turning it off is still a code change (audit the same way)');
  assert.equal(touchesCustomCode({ custom_head_html: '<script src="https://evil.example/x.js"></script>' }), true);
  assert.equal(touchesCustomCode({ nearest_store: false, channels: { gift: false } }), false);
  assert.equal(touchesCustomCode(undefined), false);
  assert.equal(touchesCustomCode(null), false);
  assert.equal(touchesCustomCode('x'), false);
});

test('mayChangeCustomCode: owner, super admin and the service role only', () => {
  const base = { userId: 'u1', service: false, superAdmin: false, companyIds: ['c1'], opsLocationIds: ['l1'] };
  assert.equal(mayChangeCustomCode({ ...base, role: 'owner' }), true);
  assert.equal(mayChangeCustomCode({ ...base, role: 'super_admin', superAdmin: true }), true);
  assert.equal(mayChangeCustomCode({ userId: null, service: true, superAdmin: true, companyIds: [], opsLocationIds: [], role: null }), true);
  for (const role of ['manager', 'shift_lead', 'staff', 'admin', '', null, undefined]) {
    assert.equal(mayChangeCustomCode({ ...base, role }), false, String(role));
  }
  assert.equal(mayChangeCustomCode(null), false);
  assert.equal(mayChangeCustomCode({}), false);
});

test('the validator still accepts the keys (the role decides, not the shape)', () => {
  const v = validateSitePatch({ settings: { allow_custom_code: true, custom_head_html: '<meta name="x" content="y">' } });
  assert.equal(v.ok, true, v.errors.join(' '));
  assert.equal(touchesCustomCode(v.clean.settings), true);
});

test('website-admin refuses custom code from a non owner before the settings merge, and the caller carries the role', () => {
  const admin = read('supabase/functions/website-admin/index.ts');
  const auth = read('supabase/functions/_shared/websiteAuth.ts');
  const saveSite = admin.slice(admin.indexOf("action === 'save_site'"), admin.indexOf("action === 'save_page'"));
  const guard = saveSite.indexOf('touchesCustomCode(clean.settings) && !mayChangeCustomCode(caller)');
  const merge = saveSite.indexOf('row.settings = mergeObj(site.settings, clean.settings)');
  assert.ok(guard > 0, 'the guard exists in save_site');
  assert.ok(merge > guard, 'the guard runs before the merge');
  assert.match(saveSite, /Only the owner can change custom code\./);
  assert.match(auth, /role: string \| null;/, 'Caller carries the role');
  assert.match(auth, /opsLocationIds: \[\.\.\.opsIds\], role \}/, 'the user caller returns the profile role');
  assert.match(auth, /service: true, superAdmin: true, companyIds: \[\], opsLocationIds: \[\], role: null/, 'the service caller has no role');
});
