/**
 * receiptLines.js — consolidate EXACTLY-identical receipt lines into one "N× product" line,
 * regardless of when each was punched into the POS. Pure (no deps) so it's unit-tested and
 * reusable by the thermal + HTML receipt builders (printer.js).
 *
 * "Identical" = same name + same unit price + the same modifiers (order-independent) + same
 * notes + same variant. Any difference (a note, a modifier, a price) keeps lines separate.
 * Voided lines are dropped. First occurrence keeps its position + fields; quantities are summed.
 *
 * COMBOS (5.12.123): a Combo prints as its own line with its picks under it (lib/combo.js
 * displayOrder). A Combo line or a pick only ever merges with an identical pick of the SAME Combo
 * (two Pepperoni in one package print "2x Pepperoni" under it): it never merges with a line outside
 * it, or with another Combo. An order with no Combo consolidates exactly as it always did.
 */
import { displayOrder } from './combo.js';

/** Stable signature of a line's customer-visible identity. */
export function receiptLineSig(item) {
  let mods = [];
  if (Array.isArray(item.mods)) {
    mods = item.mods.map((m) => (typeof m === 'string' ? m : `${m.label || m.name || ''}:${Number(m.price) || 0}`));
  } else if (typeof item.mods === 'string' && item.mods) {
    mods = item.mods.split(' · ');
  }
  mods = mods.map((s) => String(s).trim()).filter(Boolean).sort();
  return JSON.stringify({
    n: item.name || '',
    p: Number(item.price) || 0,
    m: mods,
    note: String(item.notes || '').trim(),
    v: item.variant || item.variantName || '',
    ...(item.comboId ? { c: item.comboId, r: item.comboRole || '' } : {}),
  });
}

/** Merge identical (by receiptLineSig) non-voided lines, summing qty, preserving first order. */
export function consolidateReceiptLines(items) {
  const out = [];
  const idx = new Map();
  displayOrder((items || []).filter((i) => i && !i.voided)).forEach((item) => {
    const k = receiptLineSig(item);
    if (idx.has(k)) {
      const g = out[idx.get(k)];
      g.qty = (Number(g.qty) || 0) + (Number(item.qty) || 1);
    } else {
      idx.set(k, out.length);
      out.push({ ...item, qty: Number(item.qty) || 1 });
    }
  });
  return out;
}
