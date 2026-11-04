/**
 * usAppNames.test.js (4 Nov 2026, two leftovers from the US basics):
 *
 *   1. Open shifts: the preset chips in the open shift editor read their times the venue's way
 *      (venueSpan with ' to '): "17:00 to 23:00" at a UK venue, byte for byte as before,
 *      "5:00 PM to 11:00 PM" at a US one.
 *   2. Report and item copy: a US venue reads "your delivery apps" / "a delivery app" where a UK
 *      venue reads Deliveroo / Uber Eats / Just Eat (the Reports catalog tile, the per menu pricing
 *      example). The review source labels are data (a review from Deliveroo is still from
 *      Deliveroo) and stay as they are; the KDS toggle help is a constant read at module load and
 *      stays as it is.
 *
 * Each changed screen has the US branch, the UK words still stand, and no line this change wrote
 * carries a long dash.
 *
 * Run: `node --test src/lib/usAppNames.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { venueSpan } from './venueDates.js';
import { spanText } from '../../supabase/functions/_shared/venueDates.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const GATE = "activeRegionPack().country === 'US'";
// Built from code points so this file never carries a long dash itself (en 0x2013, em 0x2014).
const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');

const FILES = {
  WfOpenShifts: '../backoffice/sections/workforce/WfOpenShifts.jsx',
  Catalog: '../backoffice/sections/reports/Catalog.jsx',
  PerMenuPricingTiers: '../backoffice/sections/PerMenuPricingTiers.jsx',
  ReviewSettings: '../backoffice/sections/review/ReviewSettings.jsx',
  ReviewQueue: '../backoffice/sections/review/ReviewQueue.jsx',
  ReviewDashboard: '../backoffice/sections/review/ReviewDashboard.jsx',
  OrderSources: '../backoffice/sections/reports/OrderSources.jsx',
  kdsSettings: './kds/kdsSettings.js',
};
const src = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)]));

// ── 1. the helper ───────────────────────────────────────────────────────────────

test('venueSpan with " to ": 17:00 to 23:00 for GBP, 5:00 PM to 11:00 PM for USD', () => {
  assert.equal(venueSpan('17:00', '23:00', 'GBP', ' to '), '17:00 to 23:00');
  assert.equal(venueSpan('17:00', '23:00', 'USD', ' to '), '5:00 PM to 11:00 PM');
  assert.equal(venueSpan('09:00', '17:00', 'USD', ' to '), '9:00 AM to 5:00 PM');
  assert.equal(spanText('17:00', '23:00', 'GBP', ' to '), '17:00 to 23:00');
  // EUR (Ireland) reads the 24 hour clock, as the UK does.
  assert.equal(venueSpan('17:00', '23:00', 'EUR', ' to '), '17:00 to 23:00');
});

// ── 2. open shifts ──────────────────────────────────────────────────────────────

test('WfOpenShifts: the preset chip reads through venueSpan with " to " and no raw start to finish', () => {
  const s = src.WfOpenShifts;
  assert.match(s, /import \{ venueSpan \} from '\.\.\/\.\.\/\.\.\/lib\/venueDates';/);
  assert.ok(s.includes("{venueSpan(t.start, t.finish, undefined, ' to ')}"), 'the chip is routed');
  assert.ok(!s.includes('{t.start} to {t.finish}'), 'the raw chip words are gone');
  // No other raw shift time is joined in the source: the request words go through shiftWords
  // with the venue's country.
  assert.doesNotMatch(s, /\{(sh|r|s)\.start\} ?(to|-) ?\{(sh|r|s)\.finish\}/);
  assert.ok(s.includes('shiftWords(s, country)') && s.includes('shiftWords(sh, country)'), 'request words carry the country');
  // The time boxes keep their own values.
  assert.equal((s.match(/<input type="time" style=/g) || []).length, 2);
  assert.ok(s.includes('value={start} onChange={e => setStart(e.target.value)}'));
  assert.ok(s.includes('value={finish} onChange={e => setFinish(e.target.value)}'));
});

// ── 3. the reports catalog ──────────────────────────────────────────────────────

const UK_CATALOG_DESC = "desc:'Sales by till/surface and each delivery platform (Deliveroo, Uber Eats…)'";
const US_CATALOG_DESC = "descUs:'Sales by till/surface and each of your delivery apps'";

test('Catalog: the Order sources tile keeps its UK words and carries the US words', () => {
  const s = src.Catalog;
  assert.ok(s.includes(UK_CATALOG_DESC), 'UK desc byte for byte');
  assert.ok(s.includes(US_CATALOG_DESC), 'US desc');
  assert.ok(s.includes("import { activeRegionPack } from '../../../lib/regionPack';"));
  assert.ok(s.includes(`const usVenue = ${GATE};`), 'the US branch');
  assert.ok(s.includes('return usVenue && out.descUs ? { ...out, desc: out.descUs } : out;'), 'descUs replaces desc at a US venue only');
  // The swap sits inside the memo the screen renders from (search and rows read the resolved desc).
  const inside = s.slice(s.indexOf('export default function Catalog('));
  const memo = inside.slice(0, inside.indexOf('}, [canOpen]);'));
  assert.ok(memo.includes('const usVenue = '), 'the branch is read where the tiles are resolved');
  // Only one tile in the catalog names the UK apps.
  assert.equal((s.match(/Deliveroo|Just Eat|Uber Eats/g) || []).length, 2, 'the UK desc only');
});

// ── 4. per menu pricing tiers ───────────────────────────────────────────────────

test('PerMenuPricingTiers: the example names Deliveroo at a UK venue and a delivery app at a US one', () => {
  const s = src.PerMenuPricingTiers;
  assert.ok(s.includes("import { activeRegionPack } from '../../lib/regionPack';"));
  assert.ok(s.includes(`Override prices for this item on specific menus (e.g. {${GATE} ? 'a delivery app' : 'Deliveroo'} +0.50). Empty fields fall back to channel/base above.`));
  assert.ok(!s.includes('(e.g. Deliveroo +0.50)'), 'the raw UK only example is gone');
});

// ── 5. what stays as it is ──────────────────────────────────────────────────────

test('review source labels are data and stand unchanged in all three review screens', () => {
  const labels = "ubereats: 'Uber Eats', deliveroo: 'Deliveroo', justeat: 'Just Eat'";
  for (const k of ['ReviewSettings', 'ReviewQueue', 'ReviewDashboard']) assert.ok(src[k].includes(labels), `${k} labels`);
  // Review Settings offers only the platforms the server caps name (Google, TheFork, Trustpilot):
  // the UK delivery apps are never a choice to connect, so nothing is hidden at a US venue.
  assert.ok(src.ReviewSettings.includes('const platformKeys = Object.keys(caps);'));
  assert.ok(!src.ReviewSettings.includes(GATE), 'no US branch needed in Review settings');
});

test('OrderSources names no delivery app in its words; the code comment stays', () => {
  const s = src.OrderSources;
  assert.ok(s.includes('// QR, catering, and EACH delivery platform by name (Deliveroo / Uber Eats / Just Eat…).'));
  const noComments = s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(noComments, /Deliveroo|Just Eat|Uber Eats/);
});

test('KDS toggle help is a constant read at module load and stands unchanged', () => {
  const s = src.kdsSettings;
  // The help line holds its own old dash; this file pins the words either side of it.
  assert.match(s, /\['source', +'POS name', +'Where it came from . Till 1, Kiosk, Deliveroo'\],/);
  assert.ok(s.includes('export const KDS_TOGGLES = ['));
});

// ── 6. no long dash on the lines this change wrote ──────────────────────────────

test('no long dash on any line this change wrote', () => {
  const MARKS = ['4 Nov 2026', 'venueSpan', 'descUs', 'usVenue', GATE, 'a delivery app', 'your delivery apps'];
  for (const k of ['WfOpenShifts', 'Catalog', 'PerMenuPricingTiers']) {
    const lines = src[k].split('\n').filter((l) => MARKS.some((m) => l.includes(m)));
    assert.ok(lines.length >= 2, `${k} has the lines`);
    for (const l of lines) assert.doesNotMatch(l, LONG_DASH, `${k}: ${l.trim()}`);
  }
  assert.doesNotMatch(read('./usAppNames.test.js'), LONG_DASH);
});
