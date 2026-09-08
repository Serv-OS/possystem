// Precise "what changed" summary between two config-push menu snapshots, for the activity feed.
//
// Why this exists: insertConfigPush() used to log a fixed "Menu & prices updated" note on EVERY
// Push to POS — so the feed cried "prices changed" even when nothing (let alone a price) had
// changed. This diffs the pushed snapshot against the previous one and speaks ONLY to real price
// changes (per the operator's choice: notify only when a price actually moves).
//
// Snapshots carry the full `menuItems` array (see PushToPOSButton in BackOfficeApp.jsx). Variants
// are SEPARATE menu-item rows (own id + own price), so a variant/size price change is caught like
// any other item — no special-casing needed. A price is `pricing.base` plus the per-order-type
// overrides (dineIn / takeaway / collection / delivery), so a takeaway-only change still counts.

const num = (v) => (v === null || v === undefined || v === '' ? null : (typeof v === 'number' ? v : Number(v)));

function basePrice(it) {
  const b = it?.pricing?.base;
  if (b !== undefined && b !== null && b !== '') return num(b);
  return num(it?.price) ?? 0;
}

// Per-menu / per-channel pricing tiers (pricing.menus[menuId][channel]) — e.g. a Deliveroo or a
// lunch-menu price. getItemPrice() resolves these AHEAD of base, so a tier change is a real price
// change. Serialised deterministically (sorted keys) so object key-order never causes a false diff.
function menuTiersSig(it) {
  const m = it?.pricing?.menus;
  if (!m || typeof m !== 'object') return '';
  return Object.keys(m).sort().map((mid) => {
    const chans = m[mid] || {};
    const keys = Object.keys(chans).sort();
    return `${mid}:${keys.map(k => `${k}=${num(chans[k])}`).join(',')}`;
  }).join('|');
}

// Stable signature of every price on an item: base + the four order-type overrides + per-menu tiers.
// Two items with the same signature have identical pricing; any difference is a genuine price change.
function priceSig(it) {
  const p = it?.pricing || {};
  return JSON.stringify([
    basePrice(it),
    num(p.dineIn), num(p.takeaway), num(p.collection), num(p.delivery),
    menuTiersSig(it),
  ]);
}

const nameOf = (it) => (it?.menuName || it?.name || 'Item');

// Real, sellable items only — skip layout spacers, and treat archived rows as absent (so archiving
// reads as a removal, not a phantom price change).
function indexItems(snapshot) {
  const out = new Map();
  const items = Array.isArray(snapshot?.menuItems) ? snapshot.menuItems : [];
  for (const it of items) {
    if (!it || !it.id) continue;
    if (it.type === 'spacer') continue;
    if (it.archived) continue;
    out.set(it.id, it);
  }
  return out;
}

const gbp = (n) => `£${(Number(n) || 0).toFixed(2)}`;

// Human "from → to" for one changed item. Prefer the base-price delta; if base is unchanged but an
// order-type override moved, name that instead so we never render a useless "£3.00 → £3.00".
export function priceDelta(prev, next, fmt = gbp) {
  const pb = basePrice(prev), nb = basePrice(next);
  if (pb !== nb) return `${nameOf(next)} ${fmt(pb)} → ${fmt(nb)}`;
  const fields = [['dineIn', 'dine-in'], ['takeaway', 'takeaway'], ['collection', 'collection'], ['delivery', 'delivery']];
  for (const [k, label] of fields) {
    const a = num(prev?.pricing?.[k]), b = num(next?.pricing?.[k]);
    if (a !== b) return `${nameOf(next)} (${label} ${a == null ? '—' : fmt(a)} → ${b == null ? '—' : fmt(b)})`;
  }
  if (menuTiersSig(prev) !== menuTiersSig(next)) return `${nameOf(next)} (menu price updated)`;
  return nameOf(next);
}

// Modifier-option surcharges (modifierGroupDefs[].options[].price) — e.g. "Extra cheese +£1.50" —
// are a real, customer-paid price and live in a SEPARATE snapshot key from menuItems. Diff them by
// (groupId::optionId). A NEW option is an addition, not a change, so it stays silent (like new items).
function diffModifierPrices(prev, next, fmt = gbp) {
  const index = (snap) => {
    const out = new Map();
    const groups = Array.isArray(snap?.modifierGroupDefs) ? snap.modifierGroupDefs : [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.options)) continue;
      for (const o of g.options) {
        if (!o || o.id == null) continue;
        out.set(`${g.id}::${o.id}`, o);
      }
    }
    return out;
  };
  const pv = index(prev);
  const nx = index(next);
  const changes = [];
  for (const [key, o] of nx) {
    const p = pv.get(key);
    if (!p) continue;                                  // new option → addition, not a price change
    const a = num(p.price) ?? 0, b = num(o.price) ?? 0;
    if (a !== b) changes.push(`${o.name || o.label || 'Option'} ${fmt(a)} → ${fmt(b)}`);
  }
  return changes;
}

// Full structural diff (prices / renames / adds / removes). Only prices drive the feed today, but
// the rest is computed + exported so it's testable and available if the policy widens later.
export function diffMenuSnapshots(prev, next) {
  const prevMap = indexItems(prev);
  const nextMap = indexItems(next);
  const priceChanges = [];
  const renamed = [];
  const added = [];
  const removed = [];
  for (const [id, nx] of nextMap) {
    const pv = prevMap.get(id);
    if (!pv) { added.push(nameOf(nx)); continue; }
    if (priceSig(pv) !== priceSig(nx)) priceChanges.push({ prev: pv, next: nx });
    if (nameOf(pv) !== nameOf(nx)) renamed.push({ from: nameOf(pv), to: nameOf(nx) });
  }
  for (const [id, pv] of prevMap) {
    if (!nextMap.has(id)) removed.push(nameOf(pv));
  }
  return { priceChanges, renamed, added, removed };
}

// Build the activity-feed event ({title, body}) — or null when nothing worth announcing changed.
// Policy (operator's choice): announce ONLY when a price actually moved. A no-op re-push, a
// structure-only edit (new / removed / renamed item), and the first-ever push (no baseline to diff
// against) all return null → the feed stays silent instead of falsely claiming a price change.
export function describeMenuChange(prev, next, fmt = gbp) {
  const hadPrev = !!prev && (
    (Array.isArray(prev.menuItems) && prev.menuItems.length > 0) ||
    (Array.isArray(prev.modifierGroupDefs) && prev.modifierGroupDefs.length > 0)
  );
  if (!hadPrev) return null;                       // first push — no baseline, stay silent

  const { priceChanges } = diffMenuSnapshots(prev, next);
  const deltas = [
    ...priceChanges.map(c => priceDelta(c.prev, c.next, fmt)),   // item base / order-type / per-menu tiers
    ...diffModifierPrices(prev, next, fmt),                      // modifier-option surcharges
  ];
  if (!deltas.length) return null;                 // no price moved anywhere — stay silent

  const n = deltas.length;
  const shown = deltas.slice(0, 4);
  let body = shown.join(', ');
  if (n > shown.length) body += `, +${n - shown.length} more`;
  return { title: `${n} price${n === 1 ? '' : 's'} updated`, body };
}
