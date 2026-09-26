// v5.9.69: the Back Office sidebar's open-group height comes from the row count. A fixed 460px
// cap (June 2026 reskin) clipped the tail of any group past 13 rows: Channels reached 14 and
// "Print menu" vanished under Hardware (Peter, 26 Sep 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../backoffice/BackOfficeApp.jsx', import.meta.url), 'utf8');

test('the open height is computed from the row count, never a fixed number', () => {
  assert.match(src, /export const navGroupMaxHeight = \(rows\) => Math\.max\(1, Number\(rows\) \|\| 0\) \* 44 \+ 24;/);
  assert.match(src, /maxHeight: open \? navGroupMaxHeight\(sec\.children\.length\) : 0/);
  assert.doesNotMatch(src, /maxHeight: open \? \d+ : 0/, 'no fixed cap left');
});

test('every group fits: 44px per row is above the real row height (8px padding, 12.8px text, 1px gap)', () => {
  const groups = [...src.matchAll(/\{ label:'([A-Za-z &]+)',\s*icon:'[a-z-]+',\s*children:\[((?:\[[^\]]*\],?\s*)+)\]/g)];
  assert.ok(groups.length >= 8, `found ${groups.length} sidebar groups`);
  const rowPx = 8 + 8 + Math.ceil(12.8 * 1.3) + 1;   // padding, line box, gap
  for (const g of groups) {
    const rows = (g[2].match(/\['/g) || []).length;
    const cap = Math.max(1, rows) * 44 + 24;
    assert.ok(cap >= rows * rowPx + 9, `${g[1]}: ${rows} rows need ${rows * rowPx + 9}px, cap ${cap}px`);
  }
});
