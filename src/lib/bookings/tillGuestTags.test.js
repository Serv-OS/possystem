// tillGuestTags.test.js: guest tags on the till's check header (17 Oct 2026, v5.11.73).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tillChips, TILL_CHIP_KEYS } from './tillGuestTags.js';
import { guestChips } from '../../../supabase/functions/_shared/bookingHost.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the till shows VIP and Regular only, in the host stand order', () => {
  const all = guestChips({ tags: ['VIP', 'birthday', 'merged:abc'], visits: 7, noShows: 2 });
  assert.deepEqual(all.map((c) => c.key), ['vip', 'regular', 'visits', 'no_shows', 'tag:birthday']);
  assert.deepEqual(tillChips(all).map((c) => c.label), ['VIP', 'Regular']);
  assert.deepEqual(TILL_CHIP_KEYS, ['vip', 'regular']);
});

test('a Regular by visits alone, a VIP by tag alone, and a guest with nothing to say', () => {
  assert.deepEqual(tillChips(guestChips({ tags: [], visits: 3 })).map((c) => c.key), ['regular']);
  assert.deepEqual(tillChips(guestChips({ tags: ['vip'], visits: 0 })).map((c) => c.key), ['vip']);
  // Two visits, a no-show and a venue tag: nothing on the till.
  assert.deepEqual(tillChips(guestChips({ tags: ['allergy-nuts'], visits: 2, noShows: 1 })), []);
  // booking-host not deployed yet: the till reads the record itself (no visit count), so only a tag.
  assert.deepEqual(tillChips(guestChips({ tags: ['Regular'], visits: null })).map((c) => c.key), ['regular']);
  assert.deepEqual(tillChips(null), []);
});

test('the till header renders the till chips, display only, behind a boundary that renders nothing on a fault', () => {
  const pos = read('../../surfaces/POSSurface.jsx');
  assert.match(pos, /import \{ TillGuestTags \} from '\.\/bookings\/GuestTags\.jsx';/);
  assert.match(pos, /<TillGuestTags customer=\{customer\} \/>/);
  // Inside the customer row, under the phone line and the allergy warning.
  const row = pos.slice(pos.indexOf('const customerRow = () =>'), pos.indexOf('const customerRow = () =>') + 4000);
  assert.ok(row.indexOf('ALLERGY') < row.indexOf('<TillGuestTags'), 'after the allergy warning');
  const tags = read('../../surfaces/bookings/GuestTags.jsx');
  assert.match(tags, /export function TillGuestTags/);
  assert.match(tags, /componentDidCatch|getDerivedStateFromError/);
  assert.match(tags, /only=\{TILL_CHIP_KEYS\}/);
  // A failed read never leaves a promise hanging or an unhandled rejection.
  assert.match(tags, /\.catch\(\(\) => \{ if \(alive\) setLoaded/);
  const data = read('./hostData.js');
  assert.match(data, /finally \{ inFlight\.delete\(id\); \}/);
});
