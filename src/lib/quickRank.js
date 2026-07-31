// quickRank.js — v5.5.962 Smart Quick Screen ranking engine.
// Pure functions, no store/DB access: the Back Office feeds it closed_checks rows
// and stores the result on locations.quick_screen_auto; the till only ever reads
// that stored jsonb (fast, offline-safe, no heavy queries on the POS).

// Same boundaries as data/seed.js getDaypart() — keep in lockstep.
export const DAYPARTS = ['breakfast', 'lunch', 'dinner', 'late'];

export function daypartOfHour(h) {
  if (h >= 6 && h < 11) return 'breakfast';
  if (h >= 11 && h < 17) return 'lunch';
  if (h >= 17 && h < 23) return 'dinner';
  return 'late';
}

// The canonical line key is `itemId` (store shape; lines also carry a `uid`
// line-instance id we must NOT rank on). Older history may use other keys —
// resolve defensively, and never count ad-hoc 'custom' lines.
const lineItemId = (l) => {
  const id = l?.itemId || l?.menuItemId || l?.id || null;
  return id && id !== 'custom' ? id : null;
};
const lineQty = (l) => {
  const q = Number(l?.qty ?? l?.quantity ?? 1);
  return Number.isFinite(q) && q > 0 ? q : 1;
};

/**
 * Rank menu items by units sold per daypart.
 * @param {Array} checks  closed_checks rows: { items: [...lines], closed_at | created_at }
 * @param {Object} opts   { top = 24 }  how many ids to keep per daypart
 * @returns {{ breakfast: string[], lunch: string[], dinner: string[], late: string[] }}
 *          ids ranked best-seller first (ties broken by id for stable output)
 */
export function rankQuickPicks(checks, { top = 24 } = {}) {
  const counts = { breakfast: {}, lunch: {}, dinner: {}, late: {} };

  for (const chk of checks || []) {
    const ts = chk?.closed_at || chk?.closedAt || chk?.created_at || chk?.createdAt;
    const d = ts ? new Date(ts) : null;
    if (!d || isNaN(d.getTime())) continue;
    const dp = daypartOfHour(d.getHours());
    const lines = Array.isArray(chk?.items) ? chk.items : [];
    for (const l of lines) {
      if (l?.voided) continue;
      const id = lineItemId(l);
      if (!id) continue;
      counts[dp][id] = (counts[dp][id] || 0) + lineQty(l);
    }
  }

  const out = {};
  for (const dp of DAYPARTS) {
    out[dp] = Object.entries(counts[dp])
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, top)
      .map(([id]) => id);
  }
  return out;
}

/**
 * Resolve what the till should actually show, given the venue's mode.
 * Pure so the POS memo and any preview share one truth.
 *
 * Returns { items, source, pinnedCount, rankedCount } — `source` says what the
 * grid REALLY holds ('pins' | 'ranked' | 'mixed'), so the header/badge can't
 * claim "best sellers" while a fallback quietly showed the pins (empty daypart,
 * everything 86'd, no rankings computed yet, demo mode…).
 *
 * @param {Object} p
 *   mode:        'manual' | 'auto' | 'hybrid'
 *   pinnedIds:   locations.quick_screen_ids (operator's pins, in pin order)
 *   autoLists:   quick_screen_auto.lists ({daypart: ids[]}) or null
 *   daypart:     current daypart string
 *   findItem:    id => item | undefined  (caller decides the item source)
 *   isBlocked:   item => bool            (86'd / archived / hidden-from-POS)
 *   slots:       grid size (default 16)
 */
export function resolveQuickItems({ mode, pinnedIds, autoLists, daypart, findItem, isBlocked, slots = 16 }) {
  const ok = (id) => {
    const it = findItem(id);
    return it && !isBlocked(it) ? it : null;
  };
  const asPins = (items) => ({ items, source: 'pins', pinnedCount: items.length, rankedCount: 0 });

  const pinned = (pinnedIds || []).map(ok).filter(Boolean);
  if ((mode || 'manual') === 'manual') return asPins(pinned.slice(0, slots));

  const auto = (autoLists?.[daypart] || []).map(ok).filter(Boolean);
  if (mode === 'auto') {
    // No sales history for this daypart → fall back to the pins rather than an
    // empty grid — and SAY SO via source:'pins'.
    if (!auto.length) return asPins(pinned.slice(0, slots));
    const items = auto.slice(0, slots);
    return { items, source: 'ranked', pinnedCount: 0, rankedCount: items.length };
  }
  // hybrid: pins keep their slots, best sellers fill the rest
  const seen = new Set(pinned.map(i => i.id));
  const items = [...pinned, ...auto.filter(i => !seen.has(i.id))].slice(0, slots);
  const pinnedCount = Math.min(pinned.length, items.length);
  const rankedCount = items.length - pinnedCount;
  if (rankedCount === 0) return asPins(items);
  if (pinnedCount === 0) return { items, source: 'ranked', pinnedCount: 0, rankedCount };
  return { items, source: 'mixed', pinnedCount, rankedCount };
}
