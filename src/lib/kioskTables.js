/**
 * kioskTables — the real table list, for the kiosk table picker. (v5.5.912)
 *
 * WHY THIS EXISTS
 * The kiosk asked the customer to TYPE a table number on a DIGITS-ONLY keypad
 * (ScreenTableNumber, KioskApp.jsx). A venue with a bar and a restaurant has both a
 * "B5" and a "T5" — a digits-only keypad can only ever produce "5", which matches
 * neither. The order then carried a table label no table actually has, and staff were
 * left guessing which "5" the food was for.
 *
 * The DATA was never the problem: Back Office already refuses a duplicate label
 * anywhere in a location (FloorPlanBuilder.jsx labelTaken(), backstopped in
 * store/index.js addTableToLayout), so B5 and T5 are distinct, unambiguous rows. The
 * only defect was that the kiosk never showed the customer what those labels are.
 * So: show them. No schema change, no new endpoint.
 *
 * RLS — WHY AN ANONYMOUS KIOSK CAN READ THIS
 * floor_tables SELECT is open to anon on purpose. Post-hardening that is
 * `floor_tables_anon_read ... using (true)` (20260804c_rls_hardening.sql), kept
 * deliberately because src/lib/qrTableSession.js already does this exact read from an
 * anonymous CUSTOMER session in production. Pre-hardening the live policy is
 * floor_tables_auth_write (FOR ALL, auth.role() in authenticated/anon), which also
 * permits it — so this works whether or not that migration has been applied.
 *
 * SECTION NAMES COME FROM config_pushes, NOT THE `sections` TABLE.
 * `sections` is tenant-fenced and a kiosk does not satisfy that fence — reading it
 * would silently return zero rows. The config_pushes snapshot is already read
 * anonymously by the storefront, so it is the safe source for "Bar" / "Restaurant".
 * Section names are decoration here: if they are missing the picker still works, it
 * just doesn't group.
 */
import { supabase } from './supabase';

/**
 * Returns { ok, tables, sectionLabels }.
 *
 * ok=false means "could not read the list" — the caller MUST fall back to the keypad.
 * A customer standing at a kiosk must never be blocked from ordering because a table
 * lookup failed; losing the picker is an inconvenience, losing the order is not.
 */
export async function fetchKioskTables(locationId) {
  const empty = { ok: false, tables: [], sectionLabels: {} };
  if (!supabase || !locationId) return empty;

  // allSettled, never all: a missing or blocked config push must not take the table
  // list down with it — the names are optional, the tables are not.
  const [ftRes, cpRes] = await Promise.allSettled([
    supabase.from('floor_tables')
      .select('id,label,section,sort_order')
      .eq('location_id', locationId),
    supabase.from('config_pushes')
      .select('snapshot->locationSections')
      .eq('location_id', locationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (ftRes.status !== 'fulfilled' || ftRes.value?.error) {
    console.warn('[kioskTables] could not read floor_tables — kiosk falls back to the keypad:',
      ftRes.reason?.message || ftRes.value?.error?.message);
    return empty;
  }

  const tables = (ftRes.value.data || [])
    .filter(r => String(r.label ?? '').trim())
    .map(r => ({
      id: String(r.id),
      label: String(r.label).trim(),
      section: r.section || null,
      sortOrder: Number(r.sort_order ?? 0),
    }));

  let sectionLabels = {};
  if (cpRes.status === 'fulfilled' && Array.isArray(cpRes.value?.data?.locationSections)) {
    for (const s of cpRes.value.data.locationSections) {
      if (s?.id && s?.label) sectionLabels[String(s.id)] = String(s.label);
    }
  }

  return { ok: true, tables: sortKioskTables(tables), sectionLabels };
}

/**
 * Natural sort so T2 lands before T10 — a plain string sort puts T10 first, which on a
 * wall of touch targets reads as broken. Falls back to sort_order when set.
 */
export function sortKioskTables(tables) {
  const key = (t) => {
    const m = /^(\D*)(\d+)(.*)$/.exec(t.label);
    return m ? [m[1].toLowerCase(), Number(m[2]), m[3]] : [t.label.toLowerCase(), 0, ''];
  };
  return [...tables].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const [ap, an, as] = key(a); const [bp, bn, bs] = key(b);
    if (ap !== bp) return ap < bp ? -1 : 1;
    if (an !== bn) return an - bn;
    return as < bs ? -1 : as > bs ? 1 : 0;
  });
}

/** Group for display. Returns [{ sectionId, label, tables }] — one unnamed group when
 *  the venue has no sections, so the picker renders a flat grid without special-casing. */
export function groupKioskTables(tables, sectionLabels = {}) {
  const bySection = new Map();
  for (const t of tables) {
    const k = t.section || '';
    if (!bySection.has(k)) bySection.set(k, []);
    bySection.get(k).push(t);
  }
  // A single group, or groups we have no names for, render flat — an unlabelled
  // heading is worse than none.
  const named = [...bySection.keys()].filter(k => k && sectionLabels[k]);
  if (bySection.size <= 1 || named.length === 0) {
    return [{ sectionId: null, label: null, tables }];
  }
  return [...bySection.entries()].map(([k, ts]) => ({
    sectionId: k || null,
    label: k ? (sectionLabels[k] || null) : null,
    tables: ts,
  }));
}
