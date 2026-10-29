// demoDeviceCode.test.js: the reviewer has to be able to pair twice.
//
// 29 Oct 2026, Guideline 2.1(a): "The app cannot be verified using the provided code."
// _device_claim_core clears pairing_code the first time a code is used and then refuses a
// device that is already bound, while App Review's own instructions tell the reviewer to
// uninstall and install again. Migration 20261106b makes a code at a DEMO venue a standing
// invitation instead.
//
// What must stay true, or a real till's code stops being single use:
//   - the new branch fires only when the venue is flagged is_demo;
//   - it does not clear pairing_code or pairing_expires_at;
//   - the ordinary path below it is untouched: still a free device, still consumed;
//   - the rate limit, the code format fence and the expiry still come first;
//   - the rollback restores the old function exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const SQL = read('../../supabase/migrations/20261106b_OPS_demo_device_code_not_consumed.sql');
const BACK = read('../../supabase/migrations/20261106b_OPS_demo_device_code_not_consumed_ROLLBACK.sql');

const demoBranch = SQL.slice(SQL.indexOf('-- 3c. A DEMO VENUE'), SQL.indexOf('-- 4. A live code on a free device'));
const normalBranch = SQL.slice(SQL.indexOf('-- 4. A live code on a free device'), SQL.indexOf('-- 5. A miss.'));

test('the standing code branch only ever fires at a demo venue', () => {
  assert.match(demoBranch, /l\.is_demo is true/, 'guarded by the demo flag');
  assert.match(demoBranch, /v_row\.pairing_expires_at > now\(\)/, 'an out of date code is still refused');
  assert.match(demoBranch, /bound_via\s+= 'demo_code'/, 'the claim log and the row say how it was paired');
});

test('a demo code survives being used, so the reviewer can pair again', () => {
  assert.ok(!/pairing_code\s*=\s*null/.test(demoBranch), 'the code is not consumed');
  assert.ok(!/pairing_expires_at\s*=\s*null/.test(demoBranch), 'the expiry is left alone');
  assert.match(demoBranch, /pairing_code and pairing_expires_at are deliberately left in place/);
  // A device already bound to an earlier install is taken over rather than refused.
  assert.ok(!/v_row\.device_uid is null/.test(demoBranch), 'an already bound demo device is taken over');
});

test('the ordinary pairing path is exactly as it was', () => {
  assert.match(normalBranch, /v_row\.device_uid is null/, 'still only a free device');
  assert.match(normalBranch, /pairing_code\s+= null/, 'a real code is still used up');
  assert.match(normalBranch, /pairing_expires_at = null/);
  assert.match(normalBranch, /bound_via\s+= 'code'/);
});

test('the fences before the branch are untouched', () => {
  const head = SQL.slice(0, SQL.indexOf('-- 3c. A DEMO VENUE'));
  assert.match(head, /_fence_is_locked\('claim:uid:'/, 'the rate limit still runs first');
  assert.match(head, /_fence_is_server_code\(v_norm\)/, 'a code from before the fence is still refused');
  assert.match(head, /raise exception 'no auth session'/, 'still needs a session');
});

test('the demo KDS is given a code that fits the server format', () => {
  const m = SQL.match(/pairing_code\s+= '([A-Z0-9-]+)'/);
  assert.ok(m, 'the migration sets a code on the demo KDS');
  const norm = m[1].replace(/[^A-Z0-9]/g, '');
  assert.match(norm, /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{12}$/,
    'twelve characters, no I O 0 or 1, or _fence_is_server_code refuses it on sight');
  // It is given to the demo venue's KDS and nothing else.
  assert.match(SQL, /where name = 'Apple Review KDS'/);
  assert.match(SQL, /location_id in \(select id from public\.locations where is_demo is true\)/);
});

test('the rollback puts the old function back', () => {
  // The header tells Peter he can switch one venue off instead, so only the CODE is checked.
  const body = BACK.replace(/--.*$/gm, '');
  assert.ok(!body.includes('demo_code'), 'the demo branch is gone');
  assert.ok(!body.includes('is_demo'), 'and nothing of it is left behind in the function');
  assert.match(BACK, /CREATE OR REPLACE FUNCTION public\._device_claim_core\(p_code text, p_mint_secret boolean\)/);
  assert.match(BACK, /pairing_code\s+= null/, 'codes are single use again');
});
