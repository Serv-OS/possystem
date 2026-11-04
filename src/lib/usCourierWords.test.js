/**
 * usCourierWords.test.js - decision 9.5 (4 Nov 2026): the delivery courier is Stuart, UK and
 * Europe only. A US venue is never offered Stuart setup in the Back Office; it sees one line
 * instead, and its deliveries are driven by its own staff.
 *
 *   1. the one line of words is pinned
 *   2. each changed screen has the US branch (activeRegionPack().country === 'US') and shows the
 *      line where the courier setup was; HubRise says "your delivery apps" at a US venue
 *   3. no long dash (em or en) on any line this change wrote
 *   4. the UK words are still there, unchanged
 *
 * Run: `node --test src/lib/usCourierWords.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { US_COURIER_LINE } from './usCourierWords.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const LINE = 'A US courier is not built yet. Delivery orders still work and are driven by your own staff.';
const GATE = "activeRegionPack().country === 'US'";
// Built from code points so this file never carries a long dash itself (en 0x2013, em 0x2014).
const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');

const SCREENS = {
  UberDirect: '../backoffice/sections/UberDirect.jsx',
  DeliveriesBoard: '../backoffice/sections/DeliveriesBoard.jsx',
  HubRise: '../backoffice/sections/HubRise.jsx',
  CateringSettings: '../backoffice/sections/CateringSettings.jsx',
  OnlineOrdering: '../backoffice/sections/OnlineOrdering.jsx',
};

// ── 1. the words ────────────────────────────────────────────────────────────────

test('the US courier line is pinned, plain, and has no long dash', () => {
  assert.equal(US_COURIER_LINE, LINE);
  assert.doesNotMatch(US_COURIER_LINE, LONG_DASH);
  assert.doesNotMatch(read('./usCourierWords.js'), LONG_DASH);
});

// ── 2. the US branch in each screen ─────────────────────────────────────────────

test('every changed screen reads the venue through the region pack and has the US branch', () => {
  for (const [name, file] of Object.entries(SCREENS)) {
    const src = read(file);
    assert.match(src, /import \{ activeRegionPack \} from '\.\.\/\.\.\/lib\/regionPack';/, name);
    assert.ok(src.includes(`const usVenue = ${GATE};`), `${name}: no usVenue gate`);
  }
});

test('Delivery (UberDirect): a US venue is never offered Stuart; it sees the one line instead', () => {
  const src = read(SCREENS.UberDirect);
  assert.match(src, /import \{ US_COURIER_LINE \} from '\.\.\/\.\.\/lib\/usCourierWords';/);
  // The courier mode is off at a US venue, so every Stuart card (how it works, connect, live
  // pricing, fallback) is gated away by isCourier.
  assert.ok(src.includes("const isCourier = !usVenue && form.delivery_mode === 'uber';"));
  // The Stuart option is not offered; the one line sits under the self-delivery choice.
  assert.ok(src.includes(".filter(([val]) => !usVenue || val === 'self')"));
  assert.ok(src.includes('{usVenue && <div style={{ ...S.infoNote, marginTop: 10 }}>{US_COURIER_LINE}</div>}'));
  // A save from a US venue never persists the courier mode.
  assert.ok(src.includes("delivery_mode: usVenue ? 'self' : form.delivery_mode"));
  // No courier in the pickup words either.
  assert.ok(src.includes("{usVenue ? 'Business name' : 'Business name (shown to the courier)'}"));
  assert.ok(src.includes("usVenue ? 'Pick your address from the suggestions so the radius check uses exact coordinates."));
  assert.ok(src.includes("usVenue ? 'Set your delivery charge, pickup address and radius. Used identically across POS, online and catering.'"));
});

test('Deliveries (live): a US venue sees the heading and the one line, and the board never polls', () => {
  const src = read(SCREENS.DeliveriesBoard);
  assert.match(src, /import \{ US_COURIER_LINE \} from '\.\.\/\.\.\/lib\/usCourierWords';/);
  assert.ok(src.includes('if (!locId || usVenue) return;'));
  assert.ok(src.includes('{US_COURIER_LINE}'));
  // The US return sits before the loading state, so a US venue never waits on a fetch it skips.
  assert.ok(src.indexOf('if (usVenue) {') < src.indexOf("if (rows === null) return"));
});

test('HubRise: a US venue reads "your delivery apps", never Deliveroo, Uber Eats or Just Eat', () => {
  const src = read(SCREENS.HubRise);
  const usLines = src.split('\n').filter((l) => l.includes('usVenue') || l.trim().startsWith('? \''));
  assert.ok(usLines.length >= 2);
  const usCopy = usLines.join('\n');
  assert.match(usCopy, /receive orders from your delivery apps and HubRise online orders/);
  assert.match(usCopy, /a per-menu tier for one delivery app/);
  // The US words name no UK app.
  for (const l of usLines) {
    const usWords = l.replace(/: '[^']*'/g, '');   // drop the UK branch of a ternary
    assert.doesNotMatch(usWords, /Deliveroo|Just Eat|Uber Eats/, l.trim());
  }
});

test('Catering and Online ordering: the US delivery words name no courier', () => {
  const cs = read(SCREENS.CateringSettings);
  assert.ok(cs.includes('? <div style={S.hint}>The delivery <b>charge and range</b> are set once in <b>Channels → Delivery</b> and apply to catering automatically, so there is no separate catering delivery fee to keep in sync. Catering events are charged your configured fee and delivered by your own staff.</div>'));
  const oo = read(SCREENS.OnlineOrdering);
  assert.ok(oo.includes("Show Delivery alongside Pickup at checkout. The delivery fee is set in <b>Channels → Delivery</b> and is added to the customer's total automatically."));
  assert.ok(oo.includes("where the radius{usVenue ? ' and the pricing live' : ', the pricing and the courier live'}."));
});

// ── 3. no long dash on a line this change wrote ─────────────────────────────────

// The UK copy on these screens carries its own long dashes from before and must read byte for
// byte as it did, so the rule is held on the lines this change wrote: a line that carries the
// US gate, the US words or the one line. A UK ternary branch on the same line is dropped first.
const US_MARK = /usVenue|US_COURIER_LINE|Decision 9\.5|^\s*\? ['<]/;

for (const [name, file] of Object.entries(SCREENS)) {
  test(`${name}: no long dash on any line of the US words`, () => {
    const bad = [];
    read(file).split('\n').forEach((line, i) => {
      if (!US_MARK.test(line)) return;
      const usOnly = line.replace(/: '[^']*'/g, '').replace(/: "[^"]*"/g, '').replace(/: <div[\s\S]*$/, '');
      if (LONG_DASH.test(usOnly)) bad.push(`${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(bad, []);
  });
}

test('the test file and the words file carry no long dash', () => {
  assert.doesNotMatch(read('./usCourierWords.test.js'), LONG_DASH);
});

// ── 4. the UK words still stand ─────────────────────────────────────────────────

test('a UK venue reads the Stuart words exactly as before', () => {
  const ud = read(SCREENS.UberDirect);
  assert.ok(ud.includes("Quote the delivery fee from the customer's address at order time, surcharge it under your policy, and dispatch a Stuart courier with live tracking. Used identically across POS, online and catering."));
  assert.ok(ud.includes("['uber', 'car', 'Stuart courier', \"A Stuart courier is dispatched automatically with a live price + ETA and a tracking link. Connect this venue's Stuart account below.\"],"));
  assert.ok(ud.includes("<h2 style={S.h2}>{form.stuart_connected ? '✓ This venue is connected to Stuart' : 'Connect this venue to Stuart'}</h2>"));
  const hr = read(SCREENS.HubRise);
  assert.ok(hr.includes("'Connect this venue to HubRise to receive Deliveroo / Uber Eats / Just Eat and HubRise online orders straight into the Orders Hub + kitchen, publish your menu to those channels, and keep stock in sync. Orders flow back their status automatically as you advance them.'"));
  assert.ok(hr.includes("'a per-menu “Deliveroo +0.50” tier'"));
  assert.ok(read(SCREENS.DeliveriesBoard).includes("Couriers dispatched for delivery orders. Status updates live from the courier."));
});
