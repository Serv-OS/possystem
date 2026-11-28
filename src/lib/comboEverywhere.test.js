// comboEverywhere.test.js: a Combo with steps on QR at the table, the phone POS and the bar screen
// (5.12.126, stage 4). Peter, 27 Nov 2026: "make it so it works across all ordering platforms".
//   QR at the table   the online page's own sheet and basket (stage 3); the QR checkout sends the
//                     Combo words and leaves picks out of deals; settle_qr_tab values with the same
//                     server function (SQL 20261217a)
//   the phone POS     the POS's own ComboFlow, full screen, and the store's own addCombo
//   the bar screen    the POS's own ComboFlow in the product panel, priced as a bar tab on the bar's
//                     menu, counting the round being built; the lines go on the round as one Combo
// The kiosk and the delivery platforms still leave it out (comboSurfaces.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { comboPosContext, comboOrderLines } from './comboLines.js';
import { addToRoundLines } from './tillLine.js';
import { entryState, comboTotal } from './combo.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const step = (id, name, selectionType, min, max, pricing, products) => ({ id, name, selectionType, min, max, pricing, products: products.map((p) => (typeof p === 'string' ? { itemId: p, bump: 0 } : p)) });
const BOX = { id: 'box', name: 'Pizza party', type: 'combo', cat: 'c', pricing: { base: 30 }, combo: { v: 1, steps: [step('st', 'Pick 2', 'quantity', 2, 2, 'set', ['marg', { itemId: 'pep', bump: 1.5 }])] } };
const ROWS = [BOX, { id: 'marg', name: 'Margherita', cat: 'c', pricing: { base: 9 } }, { id: 'pep', name: 'Pepperoni', cat: 'c', pricing: { base: 10 } }];

test('the bar: what the round being built holds counts against the daily counts, and its lines never merge', () => {
  // Two Margheritas are in the round (not sent, so not off the daily count yet): one is left.
  const held = new Map([['marg', 2]]);
  const ctx = comboPosContext({ item: BOX, menuItems: ROWS, dailyCounts: { marg: { remaining: 3 } }, orderType: 'bar-tab', held });
  assert.equal(ctx.remainingOf('marg'), 1);
  assert.equal(entryState({ itemId: 'marg' }, ctx).words, '1 left');
  // Without anything held, as before (the POS passes none).
  assert.equal(comboPosContext({ item: BOX, menuItems: ROWS, dailyCounts: { marg: { remaining: 3 } } }).remainingOf('marg'), 3);
  // The Combo's lines, priced by the bar's own rule, come to what the POS charges for it.
  const barPrice = (r) => (r.id === 'box' ? 32 : Number(r.pricing?.base) || 0);
  let n = 0;
  const picks = [{ key: 'a', stepId: 'st', entryId: 'marg', itemId: 'marg', mods: [] }, { key: 'b', stepId: 'st', entryId: 'pep', itemId: 'pep', mods: [] }];
  const { lines } = comboOrderLines({ item: BOX, comboId: 'cb-bar-1', picks, setPrice: barPrice(BOX), priceOf: barPrice, uid: () => `u${++n}`, menuItems: ROWS });
  assert.deepEqual(lines.map((l) => [l.itemId, l.price, l.comboRole, !!l.noKitchen]), [['box', 32, 'parent', true], ['marg', 0, 'pick', false], ['pep', 1.5, 'pick', false]]);
  assert.equal(lines.reduce((s, l) => s + l.price, 0), comboTotal({ setPrice: 32, steps: BOX.combo.steps, picks, rowsById: new Map(ROWS.map((r) => [r.id, r])), priceOf: barPrice }).total);
  // A plain Margherita added to the round never joins the Combo's pick, and a Combo's line never joins anything.
  const round = [...lines];
  const plain = { uid: 'p1', itemId: 'marg', name: 'Margherita', price: 0, qty: 1, mods: [] };
  assert.deepEqual(addToRoundLines(round, plain).map((l) => [l.itemId, l.qty, l.comboId || null]), [['box', 1, 'cb-bar-1'], ['marg', 1, 'cb-bar-1'], ['pep', 1, 'cb-bar-1'], ['marg', 1, null]]);
  assert.equal(addToRoundLines([plain], { ...lines[1] }).length, 2);
  // Two plain lines still join as before.
  assert.deepEqual(addToRoundLines([plain], { ...plain, uid: 'p2' }).map((l) => l.qty), [2]);
});

test('the wiring: QR, the phone POS and the bar screen', () => {
  // QR: the checkout sends the Combo words (its own line on no course) and leaves picks out of deals.
  const qr = read('../surfaces/qr/QrCheckout.jsx');
  assert.match(qr, /course: l\.noKitchen \? 0 : 1,\n\s+\.\.\.comboFieldsOf\(l\),/);
  assert.match(qr, /const items = linesWithoutPicks\(cart\)\.map\(\(l, i\) => \(\{/);
  assert.equal((qr.match(/\{displayOrder\(cart\)\.map\(line => \{/g) || []).length, 2, 'both QR lists show a Combo with its picks under it');
  assert.match(qr, /\{linesWithoutPicks\(cart\)\.length\} item/);
  assert.match(read('../surfaces/qr/TabResumeScreen.jsx'), /linesWithoutPicks\(r\.items\)\.reduce\(\(s, it\) => s \+ \(it\.qty \|\| 1\), 0\)/);
  assert.match(read('./channelMenu.js'), /const CUSTOMER_COMBO_STEPS = new Set\(\['online', 'qr'\]\);/);
  assert.match(read('./channelMenu.js'), /const SELLS_COMBO_STEPS = new Set\(\['pos', 'till', 'mpos', 'bar'\]\);/);
  // The phone POS: the POS's own flow, the store's own addCombo; a Combo counts once.
  const mpos = read('../surfaces/MPOSSurface.jsx');
  assert.match(mpos, /if \(comboHasSteps\(item\)\) \{ openCombo\(item\); return; \}/);
  assert.match(mpos, /if \(flow\.screen === 'combo' && flow\.context\?\.item\) \{/);
  assert.match(mpos, /const r = st\.addCombo\(item, picks\);\n\s+if \(r\.ok\) \{ st\.showToast\?\.\(`\$\{item\.menuName \|\| item\.name\} added`, 'success'\); goBackToMenu\(\); \}/);
  assert.match(read('../surfaces/mpos/MMenu.jsx'), /const cartCount = activeItems\.filter\(i => !\(i\.comboRole === 'pick' && i\.comboId\)\)/);
  assert.match(read('../surfaces/mpos/MCartSheet.jsx'), /const counted = items\.filter\(i => !\(i\.comboRole === 'pick' && i\.comboId\)\);/);
  // The bar: the flow on the bar's terms; the round holds it as one Combo.
  const bar = read('../surfaces/BarSurface.jsx');
  assert.match(bar, /if \(comboHasSteps\(item\)\) \{ openBarCombo\(item\); return; \}/);
  assert.match(bar, /orderType="bar-tab" priceOf=\{barPriceOf\} held=\{roundHeld\}/);
  assert.match(bar, /const barPriceOf = \(row\) => tillLineUnitPrice\(row, 'bar-tab', barMenuId, null, 1\);/);
  assert.match(bar, /return line\?\.comboId \? p\.filter\(r=>r\.comboId!==line\.comboId\) : p\.filter\(r=>r\.uid!==uid\);/);
  assert.match(bar, /r\.uid===uid&&!r\.comboId\?\{\.\.\.r,qty:Math\.max\(1,r\.qty\+d\)\}:r/);
  assert.match(bar, /\{displayOrder\(roundItems\)\.map\(item=>\(isComboPick\(item\) \? \(/);
  // The POS's own flow takes the overrides; the POS itself passes none.
  const flow = read('../components/ComboFlow.jsx');
  assert.match(flow, /orderType: orderTypeOverride \|\| \(activeTableId \? 'dine-in' : orderType\),/);
  assert.match(flow, /const priceOf = priceOfOverride \|\| \(/);
  assert.doesNotMatch(read('../surfaces/POSSurface.jsx'), /<ComboFlow[^>]*(orderType=|priceOf=|held=)/);
});
