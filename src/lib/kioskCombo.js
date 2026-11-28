// src/lib/kioskCombo.js
//
// A COMBO ON THE KIOSK, BOTH DESIGNS (5.12.128). Peter, 27 Nov 2026: "yes build kiosk".
//
// The rules are the POS's own (lib/combo.js); the guest builds it in the same sheet as online
// (surfaces/online/OnlineComboSheet.jsx, with the kiosk's theme and big touch targets). This file
// turns a finished Combo into KIOSK basket lines: one cart line per order line, so the kiosk's own
// totals, payment and order write (the fingerprinted blocks in KioskApp.jsx) carry it as they carry
// any line:
//   * the Combo's own line: the set price, qty 1, never to the kitchen (noKitchen)
//   * one line per pick: the product (a size as the kiosk shapes a size: item = its product,
//     variant = kioskVariant), its options INSIDE linePrice (the kiosk's convention, as the POS's)
// Every line carries the Combo words and a key of its own, so two lines never merge.
//
// PURE: no React. Runs under node --test.

import { comboLinePlan, cents, isComboPick } from './combo.js';
import { kioskVariant } from './kioskLine.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
let seq = 0;
export const newKioskComboId = () => `cb-k-${Date.now().toString(36)}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The kiosk basket lines of one finished Combo.
 *   item      the Combo (a raw menu row)          picks   lib/combo.js picks
 *   rows      every menu row the kiosk holds      priceFor (row) => its price for this order type and menu
 * Returns the lines, the Combo's own first.
 */
export function kioskComboLines({ item, picks = [], rows = [], priceFor = () => 0, comboId = newKioskComboId() } = {}) {
  const rowsById = new Map(listOf(rows).filter(Boolean).map((r) => [r.id, r]));
  const plan = comboLinePlan({ item, comboId, setPrice: priceFor(item), picks, rowsById, priceOf: priceFor });
  let n = 0;
  const key = () => `combo:${comboId}:${++n}`;
  const lines = [{
    key: key(), item, variant: null, name: plan.parent.name, qty: 1, mods: '', modsArray: [], instructions: '',
    linePrice: plan.parent.price, lineTotal: plan.parent.price,
    comboId, comboRole: 'parent', noKitchen: true,
  }];
  for (const p of plan.picks) {
    const row = rowsById.get(p.itemId);
    const parent = row && (row.parent_id ?? row.parentId) ? rowsById.get(row.parent_id ?? row.parentId) : null;
    const mods = listOf(p.mods);
    lines.push({
      key: key(), item: parent || row, variant: parent ? kioskVariant(parent, row) : null,
      name: p.name, qty: 1,
      mods: mods.map((m) => m?.label || m?.name).filter(Boolean).join(', '),
      modsArray: mods, instructions: p.notes || '',
      linePrice: cents(p.price), lineTotal: cents(p.price),
      comboId, comboRole: 'pick', comboName: p.comboName,
      comboStepId: p.comboStepId, comboStepName: p.comboStepName, comboEntryId: p.comboEntryId,
      comboKeepsPrice: p.comboKeepsPrice, comboBump: p.comboBump,
    });
  }
  return lines;
}

/** The kiosk basket as the Combo builder's context reads it (lib/online/comboCart.js customerComboContext). */
export const kioskBasketForCombo = (cart) => listOf(cart).filter(Boolean).map((l) => ({
  itemId: l.variant?.id || l.item?.id, qty: l.qty || 1, mods: listOf(l.modsArray), noKitchen: !!l.noKitchen,
}));

/** How many things the kiosk basket holds: a Combo once, never once per pick. */
export const kioskItemCount = (cart) => listOf(cart).filter((l) => l && !isComboPick(l)).reduce((s, l) => s + (Number(l.qty) || 0), 0);

/** The basket without one Combo (every line of it). */
export const kioskWithoutCombo = (cart, comboId) => listOf(cart).filter((l) => !l || l.comboId !== comboId);

/**
 * The basket as a guest reads it on the kiosk: a Combo is ONE line (its name, its picks listed under
 * it, what the whole Combo comes to, comboWhole: true), every other line is itself. A Combo line has
 * no quantity of its own: minus or Remove takes the whole Combo (kioskWithoutCombo).
 */
export function kioskBasketView(cart) {
  const list = listOf(cart).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const l of list) {
    if (!l.comboId) { out.push(l); continue; }
    if (seen.has(l.comboId)) continue;
    seen.add(l.comboId);
    const lines = list.filter((x) => x.comboId === l.comboId);
    const parent = lines.find((x) => x.comboRole === 'parent') || lines[0];
    const picks = lines.filter((x) => x !== parent);
    const total = cents(lines.reduce((s, x) => s + (Number(x.lineTotal) || 0), 0));
    const summary = picks.map((p) => (p.mods ? `${p.variant?.lineName || p.name} (${p.mods})` : (p.variant?.lineName || p.name))).join(', ');
    out.push({ ...parent, mods: summary, lineTotal: total, linePrice: total, comboWhole: true });
  }
  return out;
}
