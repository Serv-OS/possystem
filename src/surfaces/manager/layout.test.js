// layout.test.js: the Manager app's one layout function.
//
// What must stay true:
//   - a phone gets the PHONE object, whose fragments change nothing (the phone guard);
//   - no full screen iPad is ever a phone, in either orientation;
//   - height never matters, so the on screen keyboard cannot flip the layout;
//   - the same layout returns the very same frozen object (no re render inside a band);
//   - the file stays pure: no hooks and no browser globals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BP, RAIL, GUTTER, CONTENT_MAX, CAP_MIN, CAP_KEYPAD, CAP_FORM, CAP_RUN, CAP_CTL, EMPTY,
  cols, bandFor, contentWidthFor, layoutFor, PHONE,
} from './layout.js';

const PHONES = [320, 375, 390, 430, 507, 590, 639, 659];
const TABLETS = [660, 678, 744, 820, 834, 981, 999];
const WIDES = [1000, 1024, 1133, 1180, 1194, 1271];
const CAPPED = [1272, 1366, 1376, 1920];
const ALL = [...PHONES, ...TABLETS, ...WIDES, ...CAPPED];
// One width per distinct layout outside the phone band.
const SAMPLES = [660, 744, 820, 1024, 1194, 1366];

test('constants', () => {
  assert.deepEqual(BP, { tablet: 660, wide: 1000 });
  assert.equal(RAIL, 96);
  assert.deepEqual(GUTTER, { tablet: 24, wide: 28 });
  assert.equal(CONTENT_MAX, 1120);
  assert.equal(CAP_MIN, 1272);
  assert.deepEqual([CAP_KEYPAD, CAP_FORM, CAP_RUN, CAP_CTL], [440, 520, 640, 360]);
  assert.equal(cols(3), 'repeat(3, minmax(0, 1fr))');
  assert.ok(Object.isFrozen(EMPTY) && Object.keys(EMPTY).length === 0);
});

test('bands', () => {
  for (const w of PHONES) assert.equal(bandFor(w), 'phone', `${w}`);
  for (const w of TABLETS) assert.equal(bandFor(w), 'tablet', `${w}`);
  for (const w of WIDES) { assert.equal(bandFor(w), 'wide', `${w}`); assert.equal(layoutFor(w).capped, false, `${w} not capped`); }
  for (const w of CAPPED) { assert.equal(bandFor(w), 'wide', `${w}`); assert.equal(layoutFor(w).capped, true, `${w} capped`); }
  for (const w of [...PHONES, ...TABLETS]) assert.equal(layoutFor(w).capped, false, `${w} not capped`);
  for (const w of ALL) {
    const L = layoutFor(w);
    assert.equal(L.band, bandFor(w));
    assert.equal(L.phone, L.band === 'phone');
    assert.equal(L.panes, L.band === 'wide' ? 2 : 1, `panes at ${w}`);
    assert.equal(L.navIcon, L.phone ? 20 : 24);
    assert.equal(L.deviceWord, L.phone ? 'phone' : 'device');
    assert.ok(!('contentW' in L), 'content width is not stored (it varies inside a key)');
  }
});

test('columns: the reference table', () => {
  // width: [band, contentW, statCols, rowCols, textCols, tileCols]. Rows are 340 wide at least,
  // so the iPad mini in landscape (981) shows two across and document titles are not cut.
  const table = {
    660: ['tablet', 516, 2, 1, 1, 2],
    678: ['tablet', 534, 2, 1, 1, 2],
    744: ['tablet', 600, 2, 1, 1, 3],
    820: ['tablet', 676, 4, 2, 1, 3],
    834: ['tablet', 690, 4, 2, 1, 3],
    981: ['tablet', 837, 4, 2, 1, 3],
    1024: ['wide', 872, 4, 2, 2, 3],
    1133: ['wide', 981, 4, 2, 2, 4],
    1180: ['wide', 1028, 4, 3, 2, 4],
    1194: ['wide', 1042, 4, 3, 2, 4],
    1366: ['wide', 1120, 4, 3, 2, 4],
    1376: ['wide', 1120, 4, 3, 2, 4],
  };
  for (const [w, [band, cw, stat, row, text, tile]] of Object.entries(table)) {
    const L = layoutFor(Number(w));
    assert.equal(L.band, band, `band at ${w}`);
    assert.equal(contentWidthFor(Number(w)), cw, `content width at ${w}`);
    assert.deepEqual([L.statCols, L.rowCols, L.textCols, L.tileCols], [stat, row, text, tile], `columns at ${w}`);
  }
  for (const w of PHONES) {
    const L = layoutFor(w);
    assert.deepEqual([L.statCols, L.rowCols, L.textCols, L.tileCols], [2, 1, 1, 2], `phone columns at ${w}`);
  }
  // The counts reach the fragments that carry them.
  const t = layoutFor(820).s, w = layoutFor(1194).s;
  assert.equal(t.rows.gridTemplateColumns, cols(2));
  assert.equal(t.statGrid.gridTemplateColumns, cols(4));
  assert.equal(t.opsTiles.gridTemplateColumns, cols(3));
  assert.equal(t.textRows.gridTemplateColumns, cols(1));
  assert.equal(t.paneRows, t.rows);
  assert.equal(w.rows.gridTemplateColumns, cols(3));
  assert.equal(w.textRows.gridTemplateColumns, cols(2));
  assert.equal(w.opsTiles.gridTemplateColumns, cols(4));
  assert.equal(Object.keys(w.statGrid).length, 0, 'stats stay 2 by 2 inside a pane');
  assert.equal(Object.keys(w.paneRows).length, 0);
  assert.deepEqual(w.statGridSpan, { gridTemplateColumns: cols(4), gridColumn: '1 / -1' });
});

test('content width', () => {
  const want = { 678: 534, 744: 600, 834: 690, 1024: 872, 1194: 1042, 1272: 1120, 1366: 1120 };
  for (const [w, cw] of Object.entries(want)) assert.equal(contentWidthFor(Number(w)), cw, `${w}`);
  assert.equal(contentWidthFor(390), 362);
  assert.equal(contentWidthFor(659), 452);
  for (let w = BP.tablet; w <= 2600; w += 1) {
    const cw = contentWidthFor(w);
    assert.ok(cw <= CONTENT_MAX, `never above 1120 (${w})`);
    assert.ok(cw >= 516, `at least 516 outside the phone band (${w})`);
  }
});

test('THE PHONE GUARD: a phone gets fragments that change nothing', () => {
  for (const w of [320, 390, 430, 507, 659]) assert.equal(layoutFor(w, 844), PHONE, `${w}`);
  assert.deepEqual(PHONE.s.shell, {
    maxWidth: 480,
    paddingTop: 'env(safe-area-inset-top, 0px)',
    paddingRight: 14,
    paddingBottom: 'calc(92px + env(safe-area-inset-bottom, 0px))',
    paddingLeft: 14,
  });
  for (const n of ['pane', 'paneA', 'paneB']) assert.deepEqual(PHONE.s[n], { display: 'contents' }, n);
  for (const [name, frag] of Object.entries(PHONE.s)) {
    if (['shell', 'pane', 'paneA', 'paneB'].includes(name)) continue;
    assert.ok(frag === undefined || Object.keys(frag).length === 0, `PHONE.s.${name} must be undefined or empty`);
  }
  // Whole style fragments are undefined (no style attribute at all), spread ones are empty.
  for (const n of ['page2', 'teamPage2', 'capKeypad', 'capForm', 'capRun', 'homeSplit']) assert.equal(PHONE.s[n], undefined, n);
  assert.equal(PHONE.navIcon, 20);
  assert.equal(PHONE.deviceWord, 'phone');
  assert.equal(PHONE.panes, 1);
});

test('every band carries the same fragment names', () => {
  const names = Object.keys(PHONE.s).sort();
  for (const w of SAMPLES) assert.deepEqual(Object.keys(layoutFor(w).s).sort(), names, `${w}`);
  // Spread fragments are never undefined outside the phone band either (spreading is safe,
  // but a builder may read a key).
  const whole = new Set(['page2', 'teamPage2', 'homeSplit']);
  for (const w of SAMPLES) {
    for (const [name, frag] of Object.entries(layoutFor(w).s)) {
      if (whole.has(name)) continue;
      assert.equal(typeof frag, 'object', `${name} at ${w}`);
    }
  }
  assert.equal(layoutFor(820).s.page2, undefined, 'one column on tablet');
  assert.equal(layoutFor(820).s.homeSplit, undefined);
  assert.deepEqual(layoutFor(820).s.pane, { display: 'contents' });
  assert.equal(layoutFor(1024).s.page2.display, 'grid');
  assert.deepEqual(layoutFor(1024).s.paneA, { minWidth: 0, order: 1 });
  assert.deepEqual(layoutFor(1024).s.paneB, { minWidth: 0, order: 2 });
});

test('height never matters', () => {
  for (const w of ALL) assert.equal(layoutFor(w, 300), layoutFor(w, 2000), `${w}`);
  for (const w of ALL) assert.equal(layoutFor(w), layoutFor(w, 844), `${w}`);
});

test('bad input is a phone', () => {
  for (const bad of [undefined, null, NaN, 0, -5, Infinity, -Infinity, '800', {}, []]) {
    assert.equal(layoutFor(bad, 800), PHONE, String(bad));
    assert.equal(bandFor(bad), 'phone', String(bad));
    assert.ok(Number.isFinite(contentWidthFor(bad)), String(bad));
  }
  assert.equal(layoutFor(), PHONE);
});

test('identity and freezing', () => {
  assert.equal(layoutFor(820, 1180), layoutFor(834, 1194));
  assert.equal(layoutFor(1180, 820), layoutFor(1194, 834));
  assert.notEqual(layoutFor(1133, 744), layoutFor(1194, 834));
  assert.equal(layoutFor(1366, 1024), layoutFor(1376, 1032));
  assert.notEqual(layoutFor(744, 1133), layoutFor(820, 1180));
  assert.notEqual(layoutFor(1194, 834), layoutFor(1366, 1024));
  for (const w of [390, ...SAMPLES]) {
    const L = layoutFor(w);
    assert.ok(Object.isFrozen(L), `layout frozen at ${w}`);
    assert.ok(Object.isFrozen(L.s), `s frozen at ${w}`);
    for (const [name, frag] of Object.entries(L.s)) {
      if (frag !== undefined) assert.ok(Object.isFrozen(frag), `${name} frozen at ${w}`);
    }
  }
});

test('rotation: no full screen iPad is ever a phone', () => {
  for (const [a, b] of [[744, 1133], [820, 1180], [834, 1194], [1024, 1366], [1032, 1376]]) {
    assert.notEqual(layoutFor(a, b).band, 'phone', `${a}x${b}`);
    assert.notEqual(layoutFor(b, a).band, 'phone', `${b}x${a}`);
  }
});

test('shorthand safety: no fragment mixes a shorthand with its longhands', () => {
  const union = {};
  for (const w of [390, ...SAMPLES]) {
    for (const [name, frag] of Object.entries(layoutFor(w).s)) {
      union[name] = union[name] || new Set();
      for (const k of Object.keys(frag || {})) union[name].add(k);
    }
  }
  const clash = [
    ['padding', /^padding(Top|Right|Bottom|Left)$/],
    ['margin', /^margin(Top|Right|Bottom|Left)$/],
    ['flex', /^flex(Grow|Shrink|Basis)$/],
    ['gridColumn', /^gridColumn(Start|End)$/],
    ['gridRow', /^gridRow(Start|End)$/],
    ['gap', /^(row|column)Gap$/],
  ];
  for (const [name, keys] of Object.entries(union)) {
    for (const [short, longs] of clash) {
      if (!keys.has(short)) continue;
      for (const k of keys) assert.ok(!longs.test(k), `s.${name} holds ${short} together with ${k}`);
    }
  }
  // The Shell padding is four longhands in every band, so shrinking back cannot leave one behind.
  for (const w of [390, ...SAMPLES]) {
    const sh = layoutFor(w).s.shell;
    for (const k of ['maxWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) assert.ok(k in sh, `${k} at ${w}`);
    assert.ok(!('padding' in sh));
  }
});

test('caps are the same in tablet, wide and capped', () => {
  for (const w of SAMPLES) {
    const s = layoutFor(w).s;
    assert.deepEqual(s.capKeypad, { maxWidth: 440, margin: '0 auto' }, `${w}`);
    assert.deepEqual(s.capForm, { maxWidth: 520, margin: '0 auto' }, `${w}`);
    assert.deepEqual(s.capRun, { maxWidth: 640, margin: '0 auto' }, `${w}`);
    assert.deepEqual(s.ctl, { maxWidth: 360 }, `${w}`);
    assert.deepEqual(s.hit, { width: 44, height: 44 }, `${w}`);
  }
  // From 664 wide the form column is always its full 520, so rotation cannot resize it.
  assert.ok(CAP_FORM <= contentWidthFor(664));
});

test('shell padding and capped continuity', () => {
  assert.equal(CAP_MIN, RAIL + CONTENT_MAX + 2 * GUTTER.wide);
  const t = layoutFor(820).s.shell, w = layoutFor(1194).s.shell, c = layoutFor(1366).s.shell;
  assert.equal(t.paddingLeft, 'calc(120px + env(safe-area-inset-left, 0px))');
  assert.equal(t.paddingRight, 'calc(24px + env(safe-area-inset-right, 0px))');
  assert.equal(w.paddingLeft, 'calc(124px + env(safe-area-inset-left, 0px))');
  assert.equal(w.paddingRight, 'calc(28px + env(safe-area-inset-right, 0px))');
  assert.equal(c.paddingLeft, 'calc(96px + (100% - 1216px) / 2 + env(safe-area-inset-left, 0px))');
  assert.equal(c.paddingRight, 'calc((100% - 1216px) / 2 + env(safe-area-inset-right, 0px))');
  for (const sh of [t, w, c]) {
    assert.equal(sh.maxWidth, 'none');
    assert.equal(sh.paddingTop, 0);
    assert.equal(sh.paddingBottom, 'calc(28px + env(safe-area-inset-bottom, 0px))');
    assert.equal(sh.overflowX, 'hidden');
  }
  // At exactly 1272 the capped sides equal the wide gutter: (1272 - 1216) / 2 = 28.
  assert.equal((CAP_MIN - (RAIL + CONTENT_MAX)) / 2, GUTTER.wide);
});

test('purity: no hooks and no browser globals in layout.js', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./layout.js', import.meta.url)), 'utf8');
  for (const word of ['react', 'window', 'document', 'navigator', 'userAgent', 'RposIOS', 'maxTouchPoints']) {
    assert.ok(!src.includes(word), `layout.js must not mention ${word}`);
  }
  assert.ok(!/[–—]/.test(src), 'no long dashes');
});

test('Kitchen stat pair spans the page and takes the pane gap on wide only', () => {
  assert.equal(Object.keys(PHONE.s.kitchenStats).length, 0);
  assert.deepEqual(layoutFor(820, 1180).s.kitchenStats, { gridColumn: '1 / -1' });
  assert.deepEqual(layoutFor(1194, 834).s.kitchenStats, { gridColumn: '1 / -1', gap: 28 });
});

test('review fixes: fit at the band edges', () => {
  // Home takings figure scales just above 1000 so the forecast pill stays inside the card.
  assert.deepEqual(layoutFor(820).s.heroValue, { fontSize: 44 });
  for (const w of [1000, 1024, 1194, 1366]) assert.deepEqual(layoutFor(w).s.heroValue, { fontSize: 'clamp(36px, 3.6vw, 44px)' }, `${w}`);
  assert.deepEqual(layoutFor(820).s.heroTop, { flexWrap: 'wrap' });
  // Home tiles: four in a row only from 820 of content (964 wide); two by two below it.
  assert.deepEqual([660, 820, 834, 963, 964, 999].map((w) => layoutFor(w).homeCols), [2, 2, 2, 2, 4, 4]);
  assert.equal(PHONE.homeCols, 2);
  assert.equal(layoutFor(834).s.tileSub.minHeight, undefined);
  assert.equal(layoutFor(981).s.tileSub.minHeight, 32);
  assert.deepEqual(layoutFor(1024).s.tileSub, { fontSize: 'clamp(11px, 1.1vw, 12px)' });
  // Team: the approvals pane is the wider one, and the lock card fills it.
  assert.equal(layoutFor(820).s.teamPage2, undefined);
  assert.equal(layoutFor(1024).s.teamPage2.gridTemplateColumns, 'minmax(0, 0.9fr) minmax(0, 1.1fr)');
  assert.deepEqual(layoutFor(820).s.lockCard, { maxWidth: 440 });
  assert.equal(Object.keys(layoutFor(1194).s.lockCard).length, 0);
  // Kitchen order sheet lines up with the rows: no cap in any band.
  for (const w of SAMPLES) assert.equal(Object.keys(layoutFor(w).s.orderSheet).length, 0, `${w}`);
  // The C / F switch.
  for (const w of SAMPLES) { assert.deepEqual(layoutFor(w).s.ctlNarrow, { maxWidth: 220 }); assert.deepEqual(layoutFor(w).s.segLabel, { fontSize: 14 }); }
});
