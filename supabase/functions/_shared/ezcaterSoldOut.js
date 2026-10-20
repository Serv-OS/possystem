// supabase/functions/_shared/ezcaterSoldOut.js: an ezCater order that names a sold out item
// (v5.11.81, channel parity round 2).
//
// ezCater has no menu or stock API for this integration (ezCater confirmed in writing, 17 Sep
// 2026), so an item 86'd on the till keeps selling on ezCater: nothing can be sent there. What we
// CAN do is tell staff the moment such an order lands, so they call the customer or ezCater before
// the event day instead of finding out at the pass. A line counts when it, or an option on it, is
// matched to one of our items (itemId, from the item matching) that is in the venue's 86 list.
//
// PURE: no imports (src/lib/parity/availability.parity.test.js loads it).

const s = (v) => (v == null ? '' : String(v));

/** The names of the lines (and options) of a queue row that are sold out now, without repeats. */
export function ezcaterSoldOutNames(items, soldOutIds) {
  const out = new Set(Array.isArray(soldOutIds) ? soldOutIds.map(s) : soldOutIds instanceof Set ? [...soldOutIds].map(s) : []);
  if (!out.size) return [];
  const names = [];
  const add = (n) => { const t = s(n).trim(); if (t && !names.includes(t)) names.push(t); };
  for (const l of (Array.isArray(items) ? items : [])) {
    if (!l || l.voided) continue;
    if (l.itemId != null && out.has(s(l.itemId))) add(l.name || l.itemId);
    for (const m of (Array.isArray(l.mods) ? l.mods : [])) {
      if (m && m.itemId != null && out.has(s(m.itemId))) add(`${s(l.name)}: ${s(m.name || m.label || m.itemId)}`);
    }
  }
  return names;
}

/** The staff alert text, or null when nothing is sold out. */
export function ezcaterSoldOutAlert(badge, names) {
  if (!Array.isArray(names) || !names.length) return null;
  const list = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
  return `${badge || 'ezCater'}: sold out here but ordered on ezCater: ${list}. ezCater cannot be told, call the customer or ezCater.`;
}
