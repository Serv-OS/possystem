/**
 * uom.js — unit resolver. The whole point of the stock system: staff work in
 * friendly, named units ("Keg", "Case", "Bottle", "175ml glass") while the engine
 * does all maths in a tiny base unit (ml / g / each) they never see.
 *
 * A "unit token" is either:
 *   • a per-item packaging format, encoded "@<formatId>" (Keg = 50 l, Case = 4500 ml…)
 *   • a global unit code (l, ml, g, each, pt…)  — same-dimension auto-converts.
 *
 * An `item` here means { baseUnit, itemConversions?, formats? } where
 *   formats = [{ id, name, qtyInBase }]  (qtyInBase = size of one in the base unit).
 *
 * Every quantity in recipes, counts, purchasing and waste passes through toBase()
 * so the maths is consistent no matter which unit the operator typed in.
 */

import { convert } from './conversion.js';

const PREFIX = '@';
export const isFormatToken = (t) => typeof t === 'string' && t.startsWith(PREFIX);
export const formatToken = (id) => `${PREFIX}${id}`;
export const tokenToFormatId = (t) => (isFormatToken(t) ? t.slice(1) : null);

const trimNum = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return (Math.round(v * 1000) / 1000).toString();
};

/** Convert `qty` of `token` into the item's base unit. Throws if it can't resolve. */
export function toBase(qty, token, item) {
  const n = Number(qty);
  if (!Number.isFinite(n)) throw new Error('quantity must be a number');
  if (isFormatToken(token)) {
    const f = (item?.formats || []).find((x) => String(x.id) === tokenToFormatId(token));
    if (!f || !(Number(f.qtyInBase) > 0)) throw new Error('unknown pack unit');
    return n * Number(f.qtyInBase);
  }
  return convert(n, token, item.baseUnit, { itemConversions: item?.itemConversions || [] });
}

/** Convert a base-unit quantity back into `token` (for display). Null if not resolvable. */
export function fromBase(qtyBase, token, item) {
  const n = Number(qtyBase);
  if (!Number.isFinite(n)) return null;
  if (isFormatToken(token)) {
    const f = (item?.formats || []).find((x) => String(x.id) === tokenToFormatId(token));
    if (!f || !(Number(f.qtyInBase) > 0)) return null;
    return n / Number(f.qtyInBase);
  }
  try { return convert(n, item.baseUnit, token, { itemConversions: item?.itemConversions || [] }); }
  catch { return null; }
}

/** The unit on-hand should be shown in: the count-default pack, else the base unit. */
export function preferredDisplayToken(item) {
  const f = (item?.formats || []).find((x) => x.isCountDefault) || null;
  return f ? formatToken(f.id) : (item?.baseUnit || 'each');
}

/** Format a base quantity in the item's friendly display unit, e.g. "6 Bottle". */
export function displayInUnits(qtyBase, item) {
  const tok = preferredDisplayToken(item);
  const v = fromBase(Number(qtyBase) || 0, tok, item);
  if (v == null) return { qty: Math.round((Number(qtyBase) || 0) * 1000) / 1000, label: item?.baseUnit || '' };
  return { qty: Math.round(v * 1000) / 1000, label: unitLabel(tok, item) };
}

/** Human label for a token in the context of an item. */
export function unitLabel(token, item) {
  if (isFormatToken(token)) return (item?.formats || []).find((x) => String(x.id) === tokenToFormatId(token))?.name || '?';
  return token;
}

/**
 * Dropdown options for an item: its named packs first (largest size first), then
 * the base unit, then a few sensible same-dimension global units (so a litres item
 * also offers ml / pt). Returns [{ token, label }].
 */
export function unitOptions(item, globals = []) {
  const opts = [];
  const fmts = [...(item?.formats || [])].sort((a, b) => Number(b.qtyInBase) - Number(a.qtyInBase));
  for (const f of fmts) opts.push({ token: formatToken(f.id), label: `${f.name} (${trimNum(f.qtyInBase)} ${item.baseUnit})` });
  opts.push({ token: item.baseUnit, label: item.baseUnit });
  for (const g of globals) if (g !== item.baseUnit) opts.push({ token: g, label: g });
  return opts;
}
