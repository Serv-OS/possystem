// Floor plan SECTIONS (Main dining, Bar, Patio, ...): the saved list per venue, and the rules for
// which list a screen shows.
//
// Why (Peter, 18 Sep 2026: "I change the name of main dining to up", and on refresh it was back):
// the section list only ever lived in the store (three built in defaults) and in Push to POS
// snapshots. public.sections existed but nothing wrote it, and its key was id ALONE, so two venues
// could never both keep 'main'. Migration 20260918c makes the key (location_id, id) and adds
// `hidden`; from then on every Back Office section change writes the venue's WHOLE list at once.
//
// THE RULES
//   1. A venue's saved list (public.sections rows) wins over the built in defaults and over any
//      pushed list, on every screen. A venue with no saved rows keeps today's behaviour exactly
//      (the pushed list if there is one, else the defaults).
//   2. A failed or empty read never replaces a saved list this device already has (in the store,
//      or in the per venue copy kept in localStorage for an offline boot).
//   3. A save writes the whole on screen list (upsert on location_id + id, sort_order = position),
//      then deletes this venue's rows that are no longer in it. The first save for a venue that
//      only had the defaults therefore writes EVERY section, not just the edited one.
//   4. A save is checked: it reads the saved list first. If another screen changed it since this
//      tab read it, nothing is written and the tab is shown the latest list. Before the migration
//      the write fails (no unique key on location_id + id) and says so plainly.
//   5. A section that still has tables cannot be removed (the tables would drop out of every
//      section view). Move them first.

export const DEFAULT_SECTIONS = [
  { id: 'main',  label: 'Main dining', color: '#3b82f6', icon: '🍽' },
  { id: 'bar',   label: 'Bar',         color: '#e8a020', icon: '🍸' },
  { id: 'patio', label: 'Patio',       color: '#22c55e', icon: '🌿' },
];
export const defaultSections = () => DEFAULT_SECTIONS.map(s => ({ ...s }));

export const MIGRATION_TEXT = 'Run the sections database update first (20260918c): the section change was NOT saved';
export const TILLS_TEXT = 'Tills pick section changes up on Push to POS or their next floor plan read (within a few minutes)';

const CACHE_KEY = 'rpos-saved-sections';
// A table filed under a section id that is not in the list (or no section at all) is shown under
// this chip on a till, so it is always reachable from a section filtered view too.
export const OTHER_SECTION = '__other';

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────
export function normaliseSection(s) {
  if (!s || s.id == null || String(s.id) === '') return null;
  return {
    id: String(s.id),
    label: String(s.label ?? s.id),
    color: s.color || '#3b82f6',
    icon: s.icon || '🍽',
    ...(s.hidden ? { hidden: true } : {}),
  };
}
// Rows read from public.sections (already ordered by sort_order), or a pushed list.
export function normaliseSections(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const n = normaliseSection(s);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}
export function sectionRowsFor(list, locationId) {
  return (normaliseSections(list) || []).map((s, i) => ({
    id: s.id, location_id: locationId, label: s.label, color: s.color, icon: s.icon,
    hidden: !!s.hidden, sort_order: i,
  }));
}
// Everything a person can change, in order. Two lists with the same signature are the same list.
export function sectionsSignature(list) {
  const n = normaliseSections(list);
  if (!n) return null;
  return JSON.stringify(n.map(s => [s.id, s.label, s.color, s.icon, !!s.hidden]));
}

// ── Per venue copy on this device (offline boot, failed reads) ───────────────────────────────
function readCache() {
  try { const v = JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
}
export function loadSavedSections(locationId) {
  if (!locationId) return null;
  const e = readCache()[locationId];
  const list = normaliseSections(e?.sections);
  return list && list.length ? list : null;
}
export function storeSavedSections(locationId, list) {
  const n = normaliseSections(list);
  if (!locationId || !n || !n.length) return;   // never cache an empty list over a saved one
  try {
    const all = readCache();
    all[locationId] = { sections: n };
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* quota: best effort */ }
}

/**
 * Which list a device shows after a read of public.sections.
 *   read        the rows (null when the read failed or never ran)
 *   current     the store's list now, and currentLoc the venue it belongs to (null = unknown)
 *   cached      this device's saved copy for loc
 * Returns { sections, saved, base } where saved says the list is the venue's saved one, and base is
 * the signature a later save must still find in the database (undefined = leave the base alone).
 */
export function resolveSections({ loc, read, current, currentLoc = null, cached = null }) {
  const rows = normaliseSections(read);
  if (rows && rows.length) return { sections: rows, saved: true, base: sectionsSignature(rows), readOk: true };
  const readOk = Array.isArray(read);
  if (cached && cached.length) return { sections: cached, saved: true, base: readOk ? null : undefined, readOk };
  const cur = normaliseSections(current);
  const otherVenue = !!currentLoc && !!loc && currentLoc !== loc;
  if (!otherVenue && cur && cur.length) return { sections: cur, saved: false, base: readOk ? null : undefined, readOk };
  return { sections: defaultSections(), saved: false, base: readOk ? null : undefined, readOk };
}

/**
 * The list a Push to POS applies on a till. The venue's saved list (this device's copy) wins; the
 * pushed list applies only when the venue has none, and an absent or empty pushed list is a no-op.
 * A push is always followed by a fresh read of the saved list (TablePlanSync), which brings the
 * newest saved list in.
 */
export function pickPushedSections({ pushed, saved, current }) {
  if (saved && saved.length) return saved;
  const p = normaliseSections(pushed);
  if (p && p.length) return p;
  return current;
}

// ── Removing a section ───────────────────────────────────────────────────────────────────────
// Every table at this venue filed under the section counts, including one that is off the plan
// but still holds an open order on a till (planRemoved). Split child checks do not.
export function removeSectionRefusal(section, { tables = [], sections = [], locationId = null } = {}) {
  if (!section) return 'That section is not there any more';
  if ((sections || []).length <= 1) return 'Must keep at least one section';
  const n = (tables || []).filter(t => !t.parentId && t.section === section.id
    && (!locationId || !t.locationId || t.locationId === locationId)).length;
  if (n > 0) return `${section.label} still has ${n} table${n === 1 ? '' : 's'}, move them first`;
  return null;
}

// ── Till views ───────────────────────────────────────────────────────────────────────────────
// Tables whose section is not in the list (or is empty): they must never vanish.
export function orphanSectionTables(tables, sections) {
  const ids = new Set((sections || []).map(s => s.id));
  return (tables || []).filter(t => !t.parentId && !ids.has(t.section));
}
/**
 * Tables for a section view on a till.
 *   'all'           every table except those in a section the venue hid (hidden is a choice)
 *   OTHER_SECTION   tables whose section id is not in the list
 *   a section id    that section's tables; an id that is not in the list (a device profile's
 *                   assigned section that was removed) falls back to 'all', never to an empty view
 */
export function tablesForSectionView(tables, sections, view) {
  const list = sections || [];
  const ids = new Set(list.map(s => s.id));
  const hidden = new Set(list.filter(s => s.hidden).map(s => s.id));
  const top = (tables || []).filter(t => !t.parentId);
  if (view === OTHER_SECTION) return top.filter(t => !ids.has(t.section));
  if (view && view !== 'all' && ids.has(view)) return top.filter(t => t.section === view);
  return top.filter(t => !hidden.has(t.section));
}
export function effectiveSectionView(view, sections, tables) {
  if (!view || view === 'all') return 'all';
  if (view === OTHER_SECTION) return orphanSectionTables(tables, sections).length ? OTHER_SECTION : 'all';
  return (sections || []).some(s => s.id === view && !s.hidden) ? view : 'all';
}

// ── Database (client passed in: db.js passes the real one, tests an in-memory double) ────────
// Before 20260918c: the upsert on (location_id, id) has no unique key to use (42P10), or the
// `hidden` column is not there yet (PGRST204 / 42703).
export function isSectionsMigrationMissing(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  if (err.code === '42P10' || /no unique or exclusion constraint matching the ON CONFLICT/i.test(msg)) return true;
  if ((err.code === 'PGRST204' || err.code === '42703') && /hidden/.test(msg)) return true;
  return false;
}

export async function readSections(client, locationId) {
  if (!client || !locationId || locationId === 'loc-demo') return { sections: null, error: new Error('No location') };
  try {
    const res = await client.from('sections').select('*').eq('location_id', locationId).order('sort_order');
    if (res.error) return { sections: null, error: res.error };
    return { sections: normaliseSections(res.data || []), error: null };
  } catch (e) { return { sections: null, error: e }; }
}

/**
 * Save the venue's WHOLE section list. base is the signature of the saved list this tab last read
 * (null when it read none, undefined when it never read one).
 * Result: { ok: true, sections } or { ok: false, reason: 'migration' | 'changed' | 'read' | 'empty' | 'error', error, latest }
 * `latest` (on 'changed') is the saved list another screen wrote, for the tab to show.
 */
export async function saveSectionsChecked(client, locationId, list, { base } = {}) {
  if (!client) return { ok: false, reason: 'error', error: new Error('No database') };
  if (!locationId || locationId === 'loc-demo') return { ok: false, reason: 'error', error: new Error('No location') };
  const rows = sectionRowsFor(list, locationId);
  if (!rows.length) return { ok: false, reason: 'empty', error: new Error('Must keep at least one section') };
  const cur = await readSections(client, locationId);
  if (cur.error) return { ok: false, reason: 'read', error: cur.error };
  if (cur.sections.length && sectionsSignature(cur.sections) !== base) {
    return { ok: false, reason: 'changed', error: new Error('changed on another screen'), latest: cur.sections };
  }
  const up = await client.from('sections').upsert(rows, { onConflict: 'location_id,id' }).select('*');
  if (up.error) return { ok: false, reason: isSectionsMigrationMissing(up.error) ? 'migration' : 'error', error: up.error };
  // Only after every section on screen is stored: remove this venue's rows no longer in the list.
  const keep = rows.map(r => r.id);
  const gone = cur.sections.map(s => s.id).filter(id => !keep.includes(id));
  if (gone.length) {
    const del = await client.from('sections').delete().eq('location_id', locationId).in('id', gone);
    if (del.error) return { ok: false, reason: 'error', error: del.error };
  }
  return { ok: true, sections: normaliseSections(list) };
}
