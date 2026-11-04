// src/lib/rotaCells12h.test.js
//
// 5.12.57 batch 8, Peter's decision 8.2 (4 Nov 2026): the rota grid at a US venue reads its shift
// cells, presets and clash words as "5:00 PM to 11:00 PM"; a UK venue reads "17:00" and "23:00"
// joined exactly as before. WfRota shows every shift time through the venue helper (venueSpan,
// venueHhmm), never a raw start and finish joined in the source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hhmmText, spanText, uses12h } from '../../supabase/functions/_shared/venueDates.js';
import * as browser from './venueDates.js';
import { otherSiteClashWords } from '../staff/crossSiteRota.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const ROTA = 'src/backoffice/sections/workforce/WfRota.jsx';
const EN = '\u2013';

test('the helper: 17:00 for GBP, 5:00 PM for USD', () => {
  assert.equal(hhmmText('17:00', 'GBP'), '17:00');
  assert.equal(hhmmText('23:00', 'GBP'), '23:00');
  assert.equal(hhmmText('17:00', 'USD'), '5:00 PM');
  assert.equal(hhmmText('23:00', 'USD'), '11:00 PM');
  assert.equal(hhmmText('09:00', 'USD'), '9:00 AM');
  assert.equal(hhmmText('00:00', 'USD'), '12:00 AM');
  assert.equal(hhmmText('12:30', 'USD'), '12:30 PM');
  assert.equal(uses12h('USD'), true);
  assert.equal(uses12h('GBP'), false);
});

test('a span: the UK bytes as before, "5:00 PM to 11:00 PM" at a US venue', () => {
  assert.equal(spanText('17:00', '23:00', 'GBP'), `17:00${EN}23:00`);     // the cell, the chips, the clash words
  assert.equal(spanText('17:00', '23:00', 'GBP', '-'), '17:00-23:00');     // the other site cell kept its hyphen
  assert.equal(spanText('17:00', '23:00'), `17:00${EN}23:00`);             // no venue: the UK, as before
  assert.equal(spanText('17:00', '23:00', 'EUR'), `17:00${EN}23:00`);      // Ireland reads as the UK did
  assert.equal(spanText('17:00', '23:00', 'USD'), '5:00 PM to 11:00 PM');
  assert.equal(spanText('17:00', '23:00', 'USD', '-'), '5:00 PM to 11:00 PM');
  assert.equal(spanText('09:00', '17:00', 'USD'), '9:00 AM to 5:00 PM');
  // a UK venue never has its bytes touched, even an odd value
  assert.equal(spanText('9:00', '17:00:00', 'GBP'), `9:00${EN}17:00:00`);
});

test('the clash words at another site follow the country', () => {
  const c = { start: '12:00', finish: '18:00', site: 'Daybreak' };
  assert.equal(otherSiteClashWords(c, 'Tue'), 'Clashes with their 12:00 to 18:00 shift at Daybreak on Tue. Change the times, or move that shift first.');
  assert.equal(otherSiteClashWords(c, 'Tue', 'UK'), otherSiteClashWords(c, 'Tue'));
  assert.equal(otherSiteClashWords(c, 'Tue', 'US'), 'Clashes with their 12:00 PM to 6:00 PM shift at Daybreak on Tue. Change the times, or move that shift first.');
});

test('the browser helper reads the active venue', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    store.set('rpos-active-currency', 'GBP');
    assert.equal(browser.venueSpan('17:00', '23:00'), `17:00${EN}23:00`);
    assert.equal(browser.venueHhmm('17:00'), '17:00');
    assert.equal(browser.active12h(), false);
    store.set('rpos-active-currency', 'USD');
    assert.equal(browser.venueSpan('17:00', '23:00'), '5:00 PM to 11:00 PM');
    assert.equal(browser.venueSpan('17:00', '23:00', undefined, '-'), '5:00 PM to 11:00 PM');
    assert.equal(browser.venueHhmm('17:00'), '5:00 PM');
    assert.equal(browser.active12h(), true);
    assert.equal(browser.venueSpan('17:00', '23:00', 'GBP'), `17:00${EN}23:00`);   // another venue, by name
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
});

test('WfRota shows no raw start and finish joined in the source: every shift time goes through the helper', () => {
  const src = fs.readFileSync(path.join(ROOT, ROTA), 'utf8');
  const lines = src.split('\n');
  // the old cell words: {s.start}<en dash>{s.finish}, `${clash.start}<en dash>${clash.finish}`, {o.start}-{o.finish}
  const RAW = new RegExp(`\\.start\\}?[${EN}\\u2014-]\\$?\\{?[a-zA-Z_.]*finish\\}?`);
  const found = lines.map((l, i) => (RAW.test(l) ? `${ROTA}:${i + 1} ${l.trim().slice(0, 100)}` : null)).filter(Boolean);
  assert.deepEqual(found, [], `a shift time joined raw in the source:\n${found.join('\n')}`);
  // a bare {x.start} on its own in the JSX (the section grid chip) reads through venueHhmm
  const bare = lines.map((l, i) => (/>\{[a-z]+\.start\}</.test(l) ? `${ROTA}:${i + 1}` : null)).filter(Boolean);
  assert.deepEqual(bare, [], `a bare start time in a cell: ${bare.join(', ')}`);
  // the helpers are in use, and the clash words at another site are given the country
  assert.match(src, /venueSpan\(start, finish, undefined, sep\)/);
  assert.match(src, /cellSpan\(sh\.start, sh\.finish\)/);
  assert.match(src, /venueHhmm\(s\.start\)/);
  assert.equal((src.match(/otherSiteClashWords\(away[^)]*activeCountry\(\)\)/g) || []).length, 2);
  // the time boxes keep their 24 hour value
  assert.ok((src.match(/<input type="time"/g) || []).length >= 4);
});

test('the US cell wraps only at " to " and only at a US venue', () => {
  const src = fs.readFileSync(path.join(ROOT, ROTA), 'utf8');
  assert.match(src, /active12h\(\) \? span\(start, finish\)\.replace\(\/ \(AM\|PM\)\/g, '\\u00a0\$1'\) : span\(start, finish, sep\)/);
  assert.match(src, /active12h\(\) \? \{ \.\.\.style, whiteSpace: 'normal', lineHeight: 1\.25 \} : style/);
  assert.match(src, /active12h\(\) \? \{ minWidth: 96 \} : \{\}/);
});

test('no long dashes in the files this change wrote', () => {
  for (const rel of ['src/lib/rotaCells12h.test.js', 'src/lib/venueDates.js', 'supabase/functions/_shared/venueDates.js', 'src/staff/crossSiteRota.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, rel), 'utf8'), /[\u2013\u2014]/, rel);
  }
  // and none on the WfRota lines this change touched (the UK joiner is written as an escape)
  const src = fs.readFileSync(path.join(ROOT, ROTA), 'utf8').split('\n');
  const touched = src.filter((l) => /span\(|cellSpan|cellWrap|active12h|venueHhmm/.test(l));
  assert.ok(touched.length >= 14, `expected the touched lines, saw ${touched.length}`);
  for (const l of touched) assert.doesNotMatch(l, /[\u2013\u2014]/, l.trim().slice(0, 100));
});
