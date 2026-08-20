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
 * @param {Object} opts
 *   top:      how many ids to keep per daypart (default 24)
 *   parentOf: optional id => masterId|null — checkout lines carry the VARIANT
 *             child's id ("Half", "Large"); mapping to the master here merges a
 *             product's variant sales into one rank ("Cappuccino" = Regular+Large)
 *   timezone: the VENUE's IANA timezone — dayparts are venue wall-clock, not the
 *             clock of whatever machine runs the ranking (v5.7.22: a Back Office
 *             session in another timezone was bucketing every sale into the wrong
 *             daypart and storing wrong lists for every till). Omitted = device
 *             hour, as before (legacy/tests).
 * @returns {{ breakfast: string[], lunch: string[], dinner: string[], late: string[] }}
 *          ids ranked best-seller first (ties broken by id for stable output)
 */
export function rankQuickPicks(checks, { top = 24, parentOf, timezone } = {}) {
  const counts = { breakfast: {}, lunch: {}, dinner: {}, late: {} };

  let hourOf = (d) => d.getHours();
  if (timezone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false });
      hourOf = (d) => { const h = parseInt(fmt.format(d), 10); return h === 24 ? 0 : h; }; // some runtimes emit "24" at midnight
    } catch { /* unknown tz id — fall back to device hour */ }
  }

  for (const chk of checks || []) {
    const ts = chk?.closed_at || chk?.closedAt || chk?.created_at || chk?.createdAt;
    const d = ts ? new Date(ts) : null;
    if (!d || isNaN(d.getTime())) continue;
    const dp = daypartOfHour(hourOf(d));
    const lines = Array.isArray(chk?.items) ? chk.items : [];
    for (const l of lines) {
      if (l?.voided) continue;
      let id = lineItemId(l);
      if (!id) continue;
      const master = parentOf?.(id);
      if (master) id = master;
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
    let it = findItem(id);
    if (!it) return null;
    // v5.5.963: stored lists (and old checks) can carry a VARIANT child's id —
    // a bare "Half"/"Large" tile is meaningless, so represent it by its master
    // product (tapping the master opens the size picker). Sub-items are NOT
    // promoted — they're modifier options; they show as themselves only if the
    // venue sells them standalone (the isBlocked visibility rule handles that).
    if (it.parentId && it.type !== 'subitem') {
      const master = findItem(it.parentId);
      if (!master) return null;
      it = master;
    }
    return !isBlocked(it) ? it : null;
  };
  // Promotion can map several children onto one master — keep first occurrence.
  const dedupe = (arr) => { const seen = new Set(); return arr.filter(i => !seen.has(i.id) && seen.add(i.id)); };
  const asPins = (items) => ({ items, source: 'pins', pinnedCount: items.length, rankedCount: 0 });

  const pinned = dedupe((pinnedIds || []).map(ok).filter(Boolean));
  if ((mode || 'manual') === 'manual') return asPins(pinned.slice(0, slots));

  const auto = dedupe((autoLists?.[daypart] || []).map(ok).filter(Boolean));
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
