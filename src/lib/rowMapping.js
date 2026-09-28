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
//   - BackOfficeApp.loadLocationData (the Back Office's own loader, since 27 Sep 2026
//     through lib/venueMenuRead.js and mapMenuRow below)
//   - lib/menuItemWrite.js menuRow, the menus writer (a stale tab may hold snake-only
//     rows; reading only the camel spelling silently un-starred the default on ANY save)
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
    // v5.9.12 (migration 20260919t): does this line also tax its share of the
    // service charge / delivery fee? null = the column is not there yet (or an
    // old tab saved the row), and the engine applies the US default once, in
    // taxEngine.lineBasisSettings: service ON for added-on rate lines, delivery OFF.
    taxServiceCharge: typeof (l.taxServiceCharge ?? l.tax_service_charge) === 'boolean' ? (l.taxServiceCharge ?? l.tax_service_charge) : null,
    taxDeliveryFee: typeof (l.taxDeliveryFee ?? l.tax_delivery_fee) === 'boolean' ? (l.taxDeliveryFee ?? l.tax_delivery_fee) : null,
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

// ── Menu rows with their database time (27 Sep 2026) ────────────────────────
//
// Peter, 27 Sep 2026: "I archived choc babychino but its still on the menu board".
// A second Back Office, loaded before the archive, wrote its whole in memory menu back
// over the database (Push to POS), and nothing could tell that the row had changed since
// that tab read it. Every door a menu row enters through now keeps the row's database
// updated_at as `srvAt`: the compare and set token every Back Office write sends back
// (lib/menuRowWrite.js, `... where updated_at = srvAt`). It is the RAW string exactly as
// the database returned it, never a Date, so the equality test matches to the digit.
// null means "not known", and a row without it is re-read before any write.
export const srvAtOf = (row) => {
  if (!row || typeof row !== 'object') return null;
  const v = row.srvAt ?? row.updated_at ?? null;
  return v == null || v === '' ? null : String(v);
};

// A database time as a number, for ordering two copies of the same row (newer wins).
// Accepts the Data API form (2026-09-27T14:05:44.964+00:00) and the realtime form
// (2026-09-27 14:05:44.964+00). NaN when unknown, so every comparison with it is false.
export const srvTimeOf = (v) => {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(' ', 'T');
  if (/[+-]\d\d$/.test(s)) s += ':00';
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
};

// Is copy `a` NEWER than copy `b` by the database clock? Unknown on either side: no.
export const srvNewer = (a, b) => {
  const x = srvTimeOf(srvAtOf(a)), y = srvTimeOf(srvAtOf(b));
  return Number.isFinite(x) && Number.isFinite(y) && x > y;
};

// ONE mapper for a menu_items row (raw database row, snake_case) into the camelCase
// shape the app reads: the union of what the Back Office loader, SyncBridge,
// useSupabaseInit and realtime each mapped by hand. The snake originals are kept
// (spread), and srvAt carries the row's database time.
export const mapMenuItemRow = (item) => {
  if (!item || typeof item !== 'object') return item;
  return {
    ...item,
    price:        item.pricing?.base ?? item.price ?? 0,
    menuName:     item.menu_name    ?? item.menuName    ?? item.name ?? 'Item',
    receiptName:  item.receipt_name ?? item.receiptName ?? item.name ?? 'Item',
    kitchenName:  item.kitchen_name ?? item.kitchenName ?? item.name ?? 'Item',
    sortOrder:    item.sort_order   ?? item.sortOrder   ?? 0,
    isDefault:    item.is_default   ?? item.isDefault,
    parentId:     item.parent_id    ?? item.parentId    ?? null,
    soldAlone:    item.sold_alone   ?? item.soldAlone,
    centreId:     item.centre_id    ?? item.centreId    ?? null,
    taxRateId:    item.tax_rate_id  ?? item.taxRateId   ?? null,
    taxOverrides: item.tax_overrides ?? item.taxOverrides ?? {},
    taxProfileId: item.tax_profile_id ?? item.taxProfileId ?? null,
    assignedModifierGroups:    item.assigned_modifier_groups    ?? item.assignedModifierGroups    ?? [],
    assignedInstructionGroups: item.assigned_instruction_groups ?? item.assignedInstructionGroups ?? [],
    optionGroupOrder: item.option_group_order ?? item.optionGroupOrder ?? null,
    image:        item.image ?? null,
    tags:         Array.isArray(item.tags) ? item.tags : [],
    // item_code is CONDITIONAL: before 20260917_OPS_menu_item_code.sql the column is not in
    // the row, and the item must then carry no field (the write leaves the column alone).
    ...(item.item_code !== undefined ? { itemCode: item.item_code ?? null } : {}),
    scope:        item.scope         ?? 'local',
    orgId:        item.org_id        ?? item.orgId        ?? null,
    masterId:     item.master_id     ?? item.masterId     ?? null,
    lockPricing:  item.lock_pricing  ?? item.lockPricing  ?? false,
    lockedFields: item.locked_fields ?? item.lockedFields ?? [],
    srvAt:        item.updated_at    ?? item.srvAt        ?? null,
  };
};

// ONE mapper for a menu_categories row (the Back Office loader's and SyncBridge's, joined).
export const mapCategoryRow = (c) => {
  if (!c || typeof c !== 'object') return c;
  return {
    ...c,
    menuId:          c.menu_id ?? c.menuId ?? null,
    parentId:        c.parent_id ?? c.parentId ?? null,
    accountingGroup: c.accounting_group ?? c.accountingGroup ?? '',
    sortOrder:       c.sort_order ?? c.sortOrder ?? 0,
    label:           c.label ?? c.name ?? 'Category',
    icon:            c.icon ?? '🍽',
    color:           c.color ?? '#3b82f6',
    defaultCourse:   c.default_course ?? c.defaultCourse ?? 1,
    spacerSlots:     c.spacer_slots ?? c.spacerSlots ?? [],
    isSpecial:       c.is_special ?? c.isSpecial ?? false,
    taxProfileId:    c.tax_profile_id ?? c.taxProfileId ?? null,
    image:           c.image ?? null,
    srvAt:           c.updated_at ?? c.srvAt ?? null,
  };
};

// A menus row: the shared normaliser plus its database time.
export const mapMenuRow = (m) => {
  if (!m || typeof m !== 'object') return m;
  return { ...normaliseMenuRow(m), srvAt: m.updated_at ?? m.srvAt ?? null };
};

// A modifier_groups row. updated_at only exists once 20260927_OPS_menu_rows_server_time.sql
// has run; before that srvAt is null and every save re-reads the row first.
// 27 Sep 2026 (review round 3): it carries its venue, so a group kept on screen while its save
// was on its way never follows the person into another venue (venueMenuRead mergeReadRows).
export const mapModifierGroupRow = (g) => {
  if (!g || typeof g !== 'object') return g;
  return {
    id: g.id, name: g.name,
    min: g.min ?? 0, max: g.max ?? 1,
    selectionType: g.selection_type ?? g.selectionType ?? 'single',
    options: Array.isArray(g.options) ? g.options : [],
    sortOrder: g.sort_order ?? g.sortOrder ?? 0,
    srvAt: g.updated_at ?? g.srvAt ?? null,
    locationId: g.location_id ?? g.locationId ?? null,
  };
};

// A tax_rates row. It carries its VENUE: on 27 Sep 2026 Leeds had no rates of its own, the
// Back Office kept Train Station's from the last push, and "Apply to all" wrote Train
// Station's rate ids into 430 Leeds products. Screens list only the active venue's rates.
export const mapTaxRateRow = (r) => {
  if (!r || typeof r !== 'object') return r;
  return {
    id: r.id, name: r.name, code: r.code,
    rate: parseFloat(r.rate), type: r.type,
    appliesTo: r.applies_to || r.appliesTo || ['all'],
    isDefault: r.is_default ?? r.isDefault, active: r.active,
    locationId: r.location_id ?? r.locationId ?? null,
  };
};

// Only the rates that belong to `locationId`. A rate with no venue on it (an old push
// snapshot) is not offered: nobody can tell which venue it came from. 27 Sep 2026 (the tax
// root cause port): nor is one a till took unchecked from an old style push (`unverified`,
// lib/venueTaxRates.js ratesFromSnapshot): it is used to charge until the venue's own read
// answers, never offered, stamped on a new product or counted as this venue's.
export const venueTaxRates = (rates, locationId) =>
  (Array.isArray(rates) ? rates : []).filter((r) => r && locationId && !r.unverified && (r.locationId ?? r.location_id) === locationId);
