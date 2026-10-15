import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stationNameMap, stationLabel } from './kdsStationNames.js';
import { hourBarHeightPx, HOUR_BAR_TRACK_PX } from './hourBar.js';

// The real Barnsley centres (print_routing.centres, 5 Oct 2026).
const BARNSLEY = [
  { id: 'pc-1790752941614-i9vh', name: 'KDS drinks' },
  { id: 'pc-1790753187262-ucql', name: 'kds food' },
  { id: 'pc-1790776924043-cnae', name: 'Frozen Drinks KDS' },
];

test('a ticket centre id shows under the name the venue gave it', () => {
  const map = stationNameMap(BARNSLEY);
  assert.equal(stationLabel('pc-1790752941614-i9vh', map), 'KDS drinks');
  assert.equal(stationLabel('pc-1790753187262-ucql', map), 'kds food');
  assert.equal(stationLabel('pc-1790776924043-cnae', map), 'Frozen Drinks KDS');
});

test('no centre, and a centre that has since been removed, read as words not ids', () => {
  const map = stationNameMap(BARNSLEY);
  assert.equal(stationLabel(null, map), 'No station');
  assert.equal(stationLabel('', map), 'No station');
  assert.equal(stationLabel('pc-1700000000000-zzzz', map), 'Removed station (zzzz)');
});

test('later lists win, and bad rows are ignored', () => {
  const map = stationNameMap(
    [{ id: 'a', name: 'Old name' }, { id: 'b', name: '  ' }, null, { name: 'no id' }],
    [{ id: 'a', name: 'New name' }],
    'not a list',
  );
  assert.deepEqual(map, { a: 'New name' });
});

test('the KDS report names stations from production centres, never menu categories', () => {
  const src = readFileSync(new URL('../backoffice/sections/reports/KDSPerformance.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes("from '../../../lib/kdsStationNames'"), 'uses the station name helper');
  assert.ok(src.includes("from('print_routing')"), 'reads the venue production centres');
  assert.ok(!src.includes('menuCategories'), 'no lookup among menu categories');
  assert.ok(!/>p50<|>p90</.test(src), 'no p50 / p90 column headings');
});

test('hour bars are drawn with real pixel heights, so they cannot collapse to a line', () => {
  const src = readFileSync(new URL('../backoffice/sections/reports/_charts.jsx', import.meta.url), 'utf8');
  const i = src.indexOf('export function HourBar');
  const body = src.slice(i, src.indexOf('\nexport', i + 10) === -1 ? undefined : src.indexOf('\nexport', i + 10));
  assert.ok(body.includes('hourBarHeightPx('), 'bar height comes from the pixel helper');
  assert.ok(!/height:`\$\{[^`]*%`/.test(body), 'no percent height on the bar (it resolves to nothing in an auto height column)');
});

test('bar heights: tallest fills the track, others in proportion, a tiny value still shows, none is flat', () => {
  assert.equal(hourBarHeightPx(100, 100), HOUR_BAR_TRACK_PX);
  assert.equal(hourBarHeightPx(50, 100), Math.round(HOUR_BAR_TRACK_PX / 2));
  assert.equal(hourBarHeightPx(1, 100000), 4);
  assert.equal(hourBarHeightPx(0, 100), 0);
  assert.equal(hourBarHeightPx(-5, 100), 0);
  assert.equal(hourBarHeightPx(120, 100), HOUR_BAR_TRACK_PX, 'a value above the max is capped at the track');
  // The KDS report's real shape: average bump times in milliseconds by hour.
  const ms = [0, 0, 288000, 311000, 442000, 319000, 522000];
  const max = Math.max(...ms);
  const px = ms.map(v => hourBarHeightPx(v, max));
  assert.deepEqual(px.slice(0, 2), [0, 0]);
  assert.ok(px[6] === HOUR_BAR_TRACK_PX && px[2] > 40 && px[2] < px[4], 'bars differ visibly');
});
