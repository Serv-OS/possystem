// src/lib/kioskWaitZero.test.js (28 Oct 2026): a kiosk can show no wait at all.
// A customer asked for the "~8 min wait" line removed from the kiosk only, keeping the wait quoted online.
// Two things stopped that: Kiosk settings drew a 0 as 8 (`|| 8`), so a 0 could never be seen or kept, and
// the kiosk let the venue's online quote win over the kiosk profile. Reads the real files, like the other
// wiring tests, so a refactor that puts either back fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('Kiosk settings shows and keeps a typed 0 for the average wait', () => {
  const src = read('src/backoffice/sections/KioskSettings.jsx');
  assert.ok(src.includes('value={draft.kiosk_avg_wait_minutes ?? 8}'), 'the input must not turn 0 into 8');
  assert.ok(!src.includes('value={draft.kiosk_avg_wait_minutes || 8}'));
  assert.ok(src.includes("'no wait shown'"), 'the preview says so when the wait is 0');
  assert.ok(src.includes('Type 0 to show no wait on this kiosk'), 'the hint tells the operator');
});

test('on the kiosk a profile wait of 0 beats the venue online quote', () => {
  const src = read('src/surfaces/KioskApp.jsx');
  const i = src.indexOf('const avgWaitMinutes = kioskWaitFallback === 0 ? 0');
  assert.ok(i > 0, 'a kiosk 0 is decided before the venue quote is looked at');
  const block = src.slice(i, i + 400);
  assert.ok(block.includes('venueLeadMin > 0 && kioskLoad != null'), 'the venue quote still applies when the kiosk has a wait');
  // The start screen only draws the pill when the number is above 0, so 0 removes the text entirely.
  assert.ok(src.includes('{avgWaitMinutes ? ('), 'the attract screen draws the pill only for a number above 0');
});
