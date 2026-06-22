/**
 * conversion.js — the unit-conversion engine.
 *
 * This is the most error-prone part of stock costing, so it is centralised and
 * unit-tested hard. Three layers (see src/lib/stock/README.md):
 *
 *   (a) Global same-dimension factor math (units.js): kg↔g, l↔ml, oz↔g …
 *   (b) Item-specific CROSS-dimension bridges (volume↔weight↔count) supplied per
 *       call as `itemConversions` — e.g. "1 each onion = 110 g", "1 L oil = 920 g".
 *   (c) Yield / usable-% (trim & cooking loss) is NOT handled here — it lives on
 *       recipe lines so it never gets folded into a physical conversion factor.
 *
 * The resolver builds a tiny graph whose nodes are {from, to} ∪ every bridge
 * endpoint, with edges for (a) same-dimension global conversions between nodes and
 * (b) each item bridge (both directions), then BFS-multiplies factors along the
 * shortest path. If no path exists it throws — we never silently guess.
 */

import { UNITS, normUnit, globalFactor } from './units.js';

/**
 * Convert `qty` from unit `from` to unit `to`.
 *
 * @param {number} qty
 * @param {string} from           source unit code
 * @param {string} to             target unit code
 * @param {object} [opts]
 * @param {Array<{fromQty:number,fromUnit:string,toQty:number,toUnit:string}>} [opts.itemConversions]
 *        item-specific cross-dimension bridges (e.g. {fromQty:1,fromUnit:'each',toQty:110,toUnit:'g'})
 * @returns {number}
 * @throws if no conversion path can be resolved.
 */
export function convert(qty, from, to, opts = {}) {
  const n = Number(qty);
  if (!Number.isFinite(n)) throw new Error(`convert: qty must be a finite number (got ${qty})`);
  const f = normUnit(from);
  const t = normUnit(to);
  if (!f || !t) throw new Error(`convert: missing unit (from="${from}", to="${to}")`);
  if (f === t) return n;

  // Fast path: same-dimension global conversion.
  const direct = globalFactor(f, t);
  if (direct != null) return n * direct;

  const bridges = Array.isArray(opts.itemConversions) ? opts.itemConversions : [];

  // Build the node set and adjacency (edge factor = "to-per-from").
  const nodes = new Set([f, t]);
  for (const b of bridges) { nodes.add(normUnit(b.fromUnit)); nodes.add(normUnit(b.toUnit)); }
  const arr = [...nodes];
  /** @type {Map<string, Array<{to:string,factor:number}>>} */
  const adj = new Map();
  const addEdge = (a, b, factor) => {
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, factor });
  };

  // (a) global same-dimension edges between known units in the node set
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const g = globalFactor(arr[i], arr[j]);
      if (g != null) addEdge(arr[i], arr[j], g);
    }
  }
  // (b) item bridge edges (both directions)
  for (const b of bridges) {
    const fu = normUnit(b.fromUnit), tu = normUnit(b.toUnit);
    const fq = Number(b.fromQty), tq = Number(b.toQty);
    if (!fu || !tu || !(fq > 0) || !(tq > 0)) continue;
    const toPerFrom = tq / fq;          // 1 fu = toPerFrom tu
    addEdge(fu, tu, toPerFrom);
    addEdge(tu, fu, 1 / toPerFrom);
  }

  // BFS shortest path, multiplying factors.
  const queue = [[f, 1]];
  const seen = new Set([f]);
  while (queue.length) {
    const [u, acc] = queue.shift();
    if (u === t) return n * acc;
    for (const e of adj.get(u) || []) {
      if (!seen.has(e.to)) { seen.add(e.to); queue.push([e.to, acc * e.factor]); }
    }
  }
  const knownF = UNITS[f] ? '' : ' (unknown unit)';
  const knownT = UNITS[t] ? '' : ' (unknown unit)';
  throw new Error(
    `No conversion path from "${f}"${knownF} to "${t}"${knownT}. ` +
    `Add an item unit conversion bridge (e.g. 1 ${f} = N ${t}).`
  );
}

/**
 * Convenience: can these units be converted given the supplied bridges?
 * Never throws — returns boolean. Useful for UI validation before save.
 */
export function canConvert(from, to, opts = {}) {
  try { convert(1, from, to, opts); return true; } catch { return false; }
}
