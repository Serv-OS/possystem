// v5.9.76: filling the columns (lib/menuBoardSections.js packBoard) and the sold out pill.
// Peter's photo of the Coffee Boy Leeds board, 26 Sep 2026: two columns of whole categories left
// the bottom right corner empty and the type could not grow; an 86'd item only greyed its name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packBoard, boardKeepsWhole } from './menuBoardSections.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// A category as the packer sees it: heading 40px, a size header row 24px, rows 30px, 30px below.
const cat = (runs) => ({ head: 40, after: 30, runs: runs.map(([hdr, k]) => ({ sizes: hdr ? 24 : 0, items: Array(k).fill(30) })) });
// The Leeds board: Coffee (13 rows in three size runs), Iced Coffee 8, Autumn 6, Matcha (1 + 5).
const leeds = () => [cat([[1, 5], [1, 2], [1, 6]]), cat([[1, 8]]), cat([[1, 6]]), cat([[1, 1], [1, 5]])];
const shape = (r) => r.bands.map((b) => (b.wide ? `wide:${b.sec}` : b.cols.map((c) => c.map((p) => `${p.sec}${p.kind[0]}${p.kind === 'run' ? `${p.run}:${p.from}-${p.to}` : ''}${p.last ? '.' : ''}`).join(' ')).join(' | ')));

test('a long category continues in the next column with its size header, and the columns end level', () => {
  const r = packBoard(leeds(), { cols: 2, height: 800 });
  assert.equal(r.fits, true);
  assert.deepEqual(shape(r), ['0h 0r0:0-5 0r1:0-2 0r2:0-6. 1h 1r0:0-5 | 1r0:5-8. 2h 2r0:0-6. 3h 3r0:0-1 3r1:0-5.']);
  // Iced Coffee: heading + 5 rows in the first column, rows 5..8 in the second, drawn with the header again.
  const cont = r.bands[0].cols[1][0];
  assert.deepEqual(cont, { sec: 1, kind: 'run', run: 0, from: 5, to: 8, last: true });
  const heights = r.bands[0].cols.map((c) => c.length);   // both columns used
  assert.equal(heights.length, 2);
  assert.ok(r.height <= 800 && r.height > 700, `levelled near the top: ${r.height}`);
});

test('the packing is the lowest height that holds everything, so the fit can grow the type', () => {
  // Whole categories (the look before v5.9.76) need 906px for two columns; filling needs 746.
  assert.equal(packBoard(leeds(), { cols: 2, height: 800, whole: true }).fits, false);
  assert.equal(packBoard(leeds(), { cols: 2, height: 920, whole: true }).fits, true);
  assert.deepEqual(shape(packBoard(leeds(), { cols: 2, height: 920, whole: true })), ['0h 0r0:0-5 0r1:0-2 0r2:0-6. 1h 1r0:0-8. | 2h 2r0:0-6. 3h 3r0:0-1 3r1:0-5.'], 'whole keeps every category in one column (the lowest height: Coffee + Iced 866, then Autumn + Matcha 572)');
  assert.equal(packBoard(leeds(), { cols: 2, height: 300 }).fits, false, 'too small for two columns');
  assert.equal(packBoard(leeds(), { cols: 3, height: 560 }).fits, true, 'a third column makes room');
});

test('a heading never ends a column and a size header never ends a column', () => {
  // Column height 130: heading (40) + header (24) + one row (30) = 94 fit; the heading alone would
  // have fitted after the first category's rows, but it moves with its first row.
  const m = [cat([[1, 1]]), cat([[1, 3]])];   // 40+24+30+30 = 124 then 40+24+30+30+30+30
  const r = packBoard(m, { cols: 3, height: 130 });
  assert.equal(r.fits, true);
  for (const col of r.bands[0].cols) {
    const last = col[col.length - 1];
    assert.notEqual(last.kind, 'head', 'no heading at the foot of a column');
    if (last.kind === 'run') assert.ok(last.to > last.from, 'no size header at the foot of a column');
  }
});

test('a Full width block is its own band across every column; a panel moves whole', () => {
  const r = packBoard([{ atomic: true, span: 'all', h: 100 }, ...leeds(), { atomic: true, h: 90 }], { cols: 2, height: 900 });
  assert.equal(r.fits, true);
  assert.equal(r.bands.length, 2);
  assert.deepEqual(r.bands[0], { wide: true, sec: 0, height: 100 });
  const last = r.bands[1].cols[1].slice(-1)[0];
  assert.deepEqual(last, { sec: 5, kind: 'atomic', last: true });
  assert.equal(packBoard([null, { atomic: true, h: 50 }], { cols: 1, height: 60 }).fits, true, 'a section with nothing to show is skipped');
  assert.equal(packBoard([], { cols: 2, height: 100 }).fits, true);
  assert.equal(packBoard([{ atomic: true, h: 500 }], { cols: 2, height: 100 }).fits, false, 'a panel taller than the screen never fits');
});

test('Layout & display: fill is the default, whole is the old look', () => {
  assert.equal(boardKeepsWhole({}), false);
  assert.equal(boardKeepsWhole({ flow: 'fill' }), false);
  assert.equal(boardKeepsWhole({ flow: 'whole' }), true);
  assert.equal(boardKeepsWhole(undefined), false);
});

test('pins: the body measures a hidden copy, packs it and draws the pieces; sold out is a pill over every price', () => {
  const src = read('../surfaces/menuboard/BoardParts.jsx');
  assert.match(src, /export function BoardBody\(/);
  assert.match(src, /const best = fitFont\(\(px\) => layoutAt\(px\)\.fits, fontRange\);/, 'the fit loop asks the packer, not scrollHeight');
  assert.match(src, /const px = scaledFont\(best, textScale, fontRange\.min\);/);
  assert.match(src, /packBoard\(measured, \{ cols: n, height: H, whole \}\)/);
  assert.match(src, /visibility: 'hidden', pointerEvents: 'none'/, 'the measure copy is invisible');
  assert.match(src, /\{!measure && <Slideshow slides=\{sec\.slides\}/, 'no second video playing in the measure copy');
  assert.match(src, /if \(sig !== sigRef\.current\) \{ sigRef\.current = sig; setLayout\(final\); \}/, 'an unchanged layout is not set again (no render loop)');
  assert.match(src, /gridTemplateRows/, 'row heights come from the grid tracks');
  assert.match(src, /const rectH = \(el\) => \(el \? el\.offsetHeight : 0\);/, 'layout boxes, never client rects: a turned (portrait) stage turns the rects too');
  assert.doesNotMatch(src.slice(src.indexOf('const rectH')), /getBoundingClientRect/, 'no client rect in the measuring code');
  assert.match(src, /new ResizeObserver\(/, 'the preview refits when its frame changes');
  // Sold out (Peter, 26 Sep): the whole item gets ONE pill across the price columns, the name is struck.
  assert.match(src, /if \(s\) cells = \[cell\('so', <SoldOut em=\{nameSize \* 0\.72\} \/>, \{ gridColumn: '2 \/ -1' \}\)\];/);
  assert.match(src, /cell\(sname, sold\(v\.id\) \? <SoldOut em=\{sz\.item \* 0\.6\} \/> : priceOf\(v, sz\.item \* 0\.9\)\)/, 'one 86\'d size gets the pill in its own cell');
  assert.match(src, /const struck = \(s\) => \(s \? \{ textDecoration: 'line-through'/);
  assert.match(src, /background: SOLD_OUT_RED, color: '#fff'/, 'red, white text: reads from the counter');
  assert.match(src, /\{hasVar && !s && \(/, 'in list mode a sold out item shows the pill, not its sizes');
  // The size labels no longer set the price column width (the photo's wide, gappy grid).
  assert.match(src, /fontSize: `\$\{sz\.item \* 0\.5\}em`, fontWeight: 700, letterSpacing: '\.05em'[^\n]*maxWidth: '7\.5em'[^\n]*whiteSpace: 'normal'/);
});
