// The first shift of the day was refused with "new row violates row-level security policy for
// table shifts" (Peter, 17 Sep 2026). The shifts policy needs this device linked to its location
// (pos_can_access), the link is made by claim_device at boot, and the staff PIN usually lands
// first. The write now waits for the claim and retries once if it is still refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('the device claim is awaitable, and never blocks boot for ever', () => {
  const src = read('./supabase.js');
  assert.ok(src.includes('export const whenDeviceClaimed = (waitMs = 4000)'), 'callers can wait for the claim');
  assert.ok(src.includes('if (!_claimPromise) return Promise.resolve(false);'), 'no claim in flight resolves at once');
  assert.ok(src.includes('Promise.race([_claimPromise.then(() => true).catch(() => false), timeout])'), 'a slow or failed claim times out instead of hanging');
  assert.ok(/export const claimPairedDeviceOnBoot = \(\) => \{\s*\n\s*_claimPromise = _claimDevice\(\);\s*\n\s*return _claimPromise;/.test(src), 'the claim hands back its promise');
});

test('opening a shift waits for the claim and retries once when row level security refuses it', () => {
  const src = read('../store/index.js');
  const i = src.indexOf("supabase.from('shifts').insert(row)");
  assert.ok(i > 0, 'the shift insert is still there');
  const before = src.slice(Math.max(0, i - 700), i);
  assert.ok(before.includes('await whenDeviceClaimed();'), 'the write waits for the device link');
  const after = src.slice(i, i + 700);
  assert.ok(after.includes("error?.code === '42501'"), 'a row level security refusal is caught');
  assert.ok(after.includes('await claimPairedDeviceOnBoot();'), 'the device is claimed again before the retry');
  assert.equal((after.match(/supabase\.from\('shifts'\)\.insert\(row\)/g) || []).length, 2, 'exactly one retry, not a loop');
  assert.ok(src.includes('whenDeviceClaimed, claimPairedDeviceOnBoot }') || /whenDeviceClaimed[^\n]*from '\.\.\/lib\/supabase'/.test(src), 'both are imported statically');
});
