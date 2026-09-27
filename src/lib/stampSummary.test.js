// stampSummary.test.js: a member sees their stamps after typing their number (v5.9.89).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stampSummary, stampDots, stampChip, showPoints } from './stampSummary.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('stamp cards from the balance lookup, cleaned and ready ones first', () => {
  const s = stampSummary([
    { id: 'p1', name: 'Coffee card', icon: '☕', stamps_required: 9, stamps_collected: 2, rewards_available: 0 },
    { id: 'p2', name: 'Cake card', stamps_required: 5, stamps_collected: 7, rewards_available: 1, reward_description: 'cake' },
    { id: 'bad', stamps_required: 0, stamps_collected: 3 },
    null,
  ]);
  assert.deepEqual(s.map((x) => [x.id, x.have, x.need, x.ready]), [['p2', 5, 5, 1], ['p1', 2, 9, 0]], 'have is capped at need; a card with no size is dropped');
  assert.equal(s[1].icon, '☕');
  assert.deepEqual(stampSummary(undefined), []);
});

test('dots and the staff chip', () => {
  assert.deepEqual(stampDots(2, 5), [true, true, false, false, false]);
  assert.equal(stampDots(3, 40).length, 20, 'a long card is capped');
  assert.deepEqual(stampDots(null, null), []);
  assert.equal(stampChip(stampSummary([{ id: 'p', name: 'Coffee', stamps_required: 9, stamps_collected: 2 }])), '☕ 2/9');
  assert.equal(stampChip(stampSummary([{ id: 'p', name: 'Coffee', stamps_required: 9, stamps_collected: 9, rewards_available: 1 }])), '☕ 9/9 · 1 free');
  assert.equal(stampChip([]), '');
});

test('points are shown only where the venue runs points', () => {
  assert.equal(showPoints({ pointsEnabled: false, points: 0 }), false, 'Coffee Boy: stamps only, never "0 points"');
  assert.equal(showPoints({ pointsEnabled: true, points: 12 }), true);
  assert.equal(showPoints({ points: null }), false);
});

test('pins: the lookup carries the stamps and flags to the display, and the display draws them', () => {
  const look = read('./customerLookup.js');
  assert.match(look, /return \{ ok: true, known: true, name, points, rewards, customerId, stampCards, pointsEnabled, stampsEnabled \};/);
  assert.match(look, /pointsEnabled: loyaltyData\?\.points_enabled !== false,/);
  const pos = read('../surfaces/POSSurface.jsx');
  assert.match(pos, /const stamps = res\.stampsEnabled === false \? \[\] : stampSummary\(res\.stampCards\);/);
  assert.match(pos, /publishLoyalty\(\{[^}]*stamps, pointsEnabled: res\.pointsEnabled !== false/);
  assert.match(pos, /stampChip\(customer\.stampSummary\)/, 'staff see 2/9 under the name');
  const disp = read('../surfaces/CustomerDisplaySurface.jsx');
  assert.match(disp, /\{showPoints\(result\) && /);
  assert.match(disp, /data-stamp-card/);
  assert.match(disp, /\{s\.have\} of \{s\.need\}/);
});
