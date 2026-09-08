// src/lib/rowMapping.js — ONE shared normaliser for `menus` rows.
//
// WHY: on 20 Aug 2026 three production bugs shipped from the same class in one
// day: rows arriving snake_case while screens and writers read camelCase.
// menus.is_default was dropped by three separate loaders (v5.7.11 + v5.7.14)
// and then wiped by the sbUpsertMenu writer (v5.7.15). The fixes were correct
// but hand-copied at every site, which is exactly how the class keeps
// re-shipping. This is the single copy. Every door a menus row can enter
// through MUST use it:
//   - SyncBridge boot load (raw Supabase rows)
//   - store applyConfigUpdate (push snapshots carry raw snake rows)
//   - BackOfficeApp.loadLocationData (the Back Office's own loader)
//   - _sbUpsertMenuNow (a stale tab may hold snake-only rows; reading only
//     the camel spelling silently un-starred the default on ANY save)
// If you add a new menus loader or writer, call this, never re-type the chain.

// Normalise one `menus` row to the camelCase shape the app reads (MenuManager,
// menu resolvers), KEEPING the snake originals via spread. The camel spelling
// wins when both are present: an already-normalised store row must never be
// overridden by a stale snake field riding along on the same object.
// Accepts snake-only, camel-only and mixed rows.
export const normaliseMenuRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    isDefault: row.isDefault ?? row.is_default ?? false,
    isActive: row.isActive ?? row.is_active ?? true,
    sortOrder: row.sortOrder ?? row.sort_order ?? 0,
  };
};

// ── Tax profiles (v5.7.33, delivery only — nothing computes with these yet) ──
//
// One shared normaliser for tax_profiles + tax_profile_lines rows, same lesson
// as normaliseMenuRow above: every door a profile row can enter through
// (SyncBridge boot, App.jsx self-heal, BackOfficeApp.loadLocationData, the
// config-push snapshot, the customer surfaces' own fetches) MUST call these,
// never re-type the snake→camel chain. Output matches the shape
// src/lib/taxEngine.js computeTax expects for profilesById values.

// Normalise one tax_profile_lines row. Accepts snake-only, camel-only and
// mixed rows; camel wins when both are present (already-normalised store rows
// must never be overridden by a stale snake field riding along).
export const normaliseTaxProfileLineRow = (l) => {
  if (!l || typeof l !== 'object') return l;
  const orderTypes = l.orderTypes ?? l.order_types;
  return {
    id: l.id,
    name: l.name || 'Tax',
    jurisdiction: l.jurisdiction ?? null,
    lineType: l.lineType ?? l.line_type ?? 'rate',
    rate: parseFloat(l.rate) || 0,
    flatAmount: parseFloat(l.flatAmount ?? l.flat_amount) || 0,
    mode: (l.mode === 'inclusive') ? 'inclusive' : 'exclusive',
    compound: (l.compound === true),
    taxable: (l.taxable === true),
    taxBasis: l.taxBasis ?? l.tax_basis ?? 'pre_discount',
    orderTypes: Array.isArray(orderTypes) && orderTypes.length ? orderTypes : ['all'],
    sortOrder: l.sortOrder ?? l.sort_order ?? 0,
    active: l.active !== false,
  };
};

// Assemble tax_profiles + tax_profile_lines rows (either casing) into the
// store's taxProfiles slice shape: one camelCase profile object per row with
// its lines nested, sorted by sortOrder. Also accepts already-assembled
// profiles (rows carrying their own `lines` array) so a push snapshot built
// from the store round-trips unchanged.
export const assembleTaxProfiles = (profileRows, lineRows) => {
  const linesByProfile = {};
  for (const l of (lineRows || [])) {
    const pid = l.profileId ?? l.profile_id;
    if (!pid) continue;
    (linesByProfile[pid] = linesByProfile[pid] || []).push(normaliseTaxProfileLineRow(l));
  }
  const bySort = (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0);
  return (profileRows || []).map(p => ({
    id: p.id,
    name: p.name || 'Tax profile',
    description: p.description ?? null,
    rounding: p.rounding || { mode: 'half_up', level: 'invoice' },
    active: p.active !== false,
    sortOrder: p.sortOrder ?? p.sort_order ?? 0,
    generatedFromRateId: p.generatedFromRateId ?? p.generated_from_rate_id ?? null,
    lines: (linesByProfile[p.id] || (Array.isArray(p.lines) ? p.lines.map(normaliseTaxProfileLineRow) : [])).sort(bySort),
  })).sort(bySort);
};
