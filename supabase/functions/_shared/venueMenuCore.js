// supabase/functions/_shared/venueMenuCore.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the server's copy of what Push to POS reads and
// sends, so a scheduled publish (msm-publish, no browser open) gives the tills EXACTLY the
// snapshot a person pressing Push to POS would.
//
// WHY A COPY AND NOT A MOVE. The design said to move src/lib/rowMapping.js and
// src/lib/venueMenuRead.js here and leave shims. Both files are pinned by source tests
// (src/lib/staleTabWiring.test.js and taxVenueWiring.test.js read their text), and the rule for
// this release is that existing tests pass untouched and Push to POS does not change. So the
// few pure functions the server needs are copied here, and src/lib/msm/msmSnapshot.test.js
// runs BOTH copies over the same rows and fails if they ever give different answers. Change a
// mapper in src/lib/rowMapping.js and that test tells you to change this one too.
//
// Pure: the Supabase client is passed in. No Deno, no imports beyond this folder.

// ── The row mappers (copies of src/lib/rowMapping.js, kept equal by test) ───

export const normaliseMenuRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    isDefault: row.isDefault ?? row.is_default ?? false,
    isActive: row.isActive ?? row.is_active ?? true,
    sortOrder: row.sortOrder ?? row.sort_order ?? 0,
  };
};

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
    taxServiceCharge: typeof (l.taxServiceCharge ?? l.tax_service_charge) === 'boolean' ? (l.taxServiceCharge ?? l.tax_service_charge) : null,
    taxDeliveryFee: typeof (l.taxDeliveryFee ?? l.tax_delivery_fee) === 'boolean' ? (l.taxDeliveryFee ?? l.tax_delivery_fee) : null,
    orderTypes: Array.isArray(orderTypes) && orderTypes.length ? orderTypes : ['all'],
    sortOrder: l.sortOrder ?? l.sort_order ?? 0,
    active: l.active !== false,
  };
};

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
    ...(item.item_code !== undefined ? { itemCode: item.item_code ?? null } : {}),
    scope:        item.scope         ?? 'local',
    orgId:        item.org_id        ?? item.orgId        ?? null,
    masterId:     item.master_id     ?? item.masterId     ?? null,
    lockPricing:  item.lock_pricing  ?? item.lockPricing  ?? false,
    lockedFields: item.locked_fields ?? item.lockedFields ?? [],
    srvAt:        item.updated_at    ?? item.srvAt        ?? null,
  };
};

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

export const mapMenuRow = (m) => {
  if (!m || typeof m !== 'object') return m;
  return { ...normaliseMenuRow(m), srvAt: m.updated_at ?? m.srvAt ?? null };
};

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

// The same list as src/lib/menuItemWrite.js ITEM_EXTRA_KEYS (pinned equal by test).
export const ITEM_EXTRA_KEYS = Object.freeze([
  'variantLabel', 'pizzaSizes', 'pizzaBases', 'pizzaCrusts', 'defaultToppings',
  'subGroup', 'variants', 'modifierGroups', 'hidden',
]);

const same = (a, b) => a != null && b != null && String(a) === String(b);
const rowVenue = (r) => (r ? (r.locationId ?? r.location_id ?? null) : null);

// src/lib/venueTaxRates.js taggedVenueRows.
export function taggedVenueRows(rows, venue) {
  if (!venue || !Array.isArray(rows)) return [];
  return rows.filter((r) => r && same(rowVenue(r), venue));
}

// src/lib/venueMenuRead.js withItemExtras.
export function withItemExtras(rows, from, keys = ITEM_EXTRA_KEYS) {
  if (!Array.isArray(rows) || !Array.isArray(from) || !from.length) return rows;
  const byId = new Map(from.filter((r) => r && r.id != null).map((r) => [r.id, r]));
  let changed = false;
  const out = rows.map((r) => {
    const src = r ? byId.get(r.id) : null;
    if (!src || src === r) return r;
    let next = r;
    for (const k of keys) {
      if (src[k] === undefined || next[k] !== undefined) continue;
      if (next === r) next = { ...r };
      next[k] = src[k];
    }
    if (next !== r) changed = true;
    return next;
  });
  return changed ? out : rows;
}

// src/lib/venueMenuRead.js menuSnapshotFromRead.
export function menuSnapshotFromRead(read, { extrasFrom = null } = {}) {
  return {
    menus: read.menus || [],
    menuItems: withItemExtras(read.menuItems || [], extrasFrom),
    menuCategories: read.menuCategories || [],
    modifierGroupDefs: read.modifierGroupDefs || [],
    taxRates: read.locationId ? taggedVenueRows(read.taxRates || [], read.locationId) : (read.taxRates || []),
    ...(Array.isArray(read.taxProfiles) ? { taxProfiles: read.taxProfiles } : {}),
    ...(read.venueDefaultTaxProfileId !== undefined ? { venueDefaultTaxProfileId: read.venueDefaultTaxProfileId } : {}),
  };
}

// The printers rows in the shape Push to POS sends (BackOfficeApp handlePush, the same mapping).
export const mapPrinterRow = (r) => ({
  id: r.id, name: r.name, model: r.meta?.model, connectionType: r.connection, address: r.ip,
  port: r.port || 9100, paperWidth: r.paper_width || 80, roles: r.meta?.roles || [], location: r.meta?.location || '',
});

export const printRoutingFromRow = (row) => (row ? { centres: row.centres || [], routing: row.routing || {} } : null);

// ── Reading a venue, paged past the 1,000 row cap ───────────────────────────

export const PAGE = 1000;

// src/lib/venueMenuRead.js readAllRows: every row of a query, page by page. `make()` builds a
// fresh query each time. Returns { rows, error }: rows null when any page failed.
export async function readAllRows(make, { page = PAGE, max = 50 } = {}) {
  const rows = [];
  for (let i = 0; i < max; i++) {
    let res;
    try { res = await make().range(i * page, i * page + page - 1); }
    catch (e) { return { rows: null, error: e }; }
    if (res?.error) return { rows: null, error: res.error };
    const data = Array.isArray(res?.data) ? res.data : null;
    if (!data) return { rows: null, error: new Error('no rows came back') };
    rows.push(...data);
    if (data.length < page) return { rows, error: null };
  }
  return { rows: null, error: new Error('too many rows to read') };
}

/**
 * Everything publish needs about one venue, as the database holds it, in RAW rows (snake case):
 *   menus, categories, items (archived included), links (of this venue's menus), groups,
 *   taxRates (active), taxProfiles + taxProfileLines (null when unreadable), location
 *   (default_tax_profile_id, timezone, org_id, name), printRouting (row or null), printers.
 * ok is true only when every required part read. The orders match readVenueMenu so the menu part
 * of the snapshot is the same as Push to POS for the same rows.
 */
export async function readVenueRaw(client, locationId) {
  const out = { ok: false, failed: [], error: null, locationId: locationId || null };
  if (!client || !locationId || locationId === 'loc-demo') {
    out.failed.push(client ? 'location' : 'database');
    out.error = new Error(client ? 'No location' : 'No database');
    return out;
  }
  const from = (t) => client.from(t);
  const [menus, cats, items, groups, rates, routing, printers, loc] = await Promise.all([
    readAllRows(() => from('menus').select('*').eq('location_id', locationId).order('sort_order').order('id')),
    readAllRows(() => from('menu_categories').select('*').eq('location_id', locationId).order('sort_order').order('label').order('id')),
    readAllRows(() => from('menu_items').select('*').eq('location_id', locationId).order('sort_order').order('id')),
    readAllRows(() => from('modifier_groups').select('*').eq('location_id', locationId).order('sort_order').order('id')),
    readAllRows(() => from('tax_rates').select('*').eq('location_id', locationId).eq('active', true).order('rate', { ascending: false }).order('id')),
    readAllRows(() => from('print_routing').select('*').eq('location_id', locationId).order('id')),
    readAllRows(() => from('printers').select('*').eq('location_id', locationId).order('id')),
    readAllRows(() => from('locations').select('id,org_id,name,timezone,default_tax_profile_id').eq('id', locationId).order('id')),
  ]);
  const legs = { menus, categories: cats, items, 'modifier groups': groups, 'tax rates': rates, 'print routing': routing, printers, venue: loc };
  for (const [name, r] of Object.entries(legs)) if (!r.rows) { out.failed.push(name); out.error = out.error || r.error; }
  out.menus = menus.rows; out.categories = cats.rows; out.items = items.rows; out.groups = groups.rows;
  out.taxRates = rates.rows; out.printers = printers.rows;
  out.printRouting = routing.rows ? (routing.rows[0] || null) : null;
  out.location = loc.rows ? (loc.rows[0] || null) : null;
  if (loc.rows && !loc.rows.length) { out.failed.push('venue'); out.error = out.error || new Error('No such venue'); }
  // Links have no venue column: they are read through this venue's menus.
  out.links = null;
  if (menus.rows) {
    const ids = menus.rows.map((m) => m.id);
    if (!ids.length) out.links = [];
    else {
      const l = await readAllRows(() => from('menu_category_links').select('menu_id,category_id,sort_order').in('menu_id', ids).order('menu_id').order('category_id'));
      if (l.rows) out.links = l.rows;
      else { out.failed.push('category links'); out.error = out.error || l.error; }
    }
  }
  // Tax profiles are optional, as in readVenueMenu: unreadable means "not sent".
  out.taxProfiles = null; out.taxProfileLines = null;
  try {
    const [prof, lines] = await Promise.all([
      readAllRows(() => from('tax_profiles').select('*').eq('location_id', locationId).order('sort_order').order('id')),
      readAllRows(() => from('tax_profile_lines').select('*').eq('location_id', locationId).order('sort_order').order('id')),
    ]);
    if (prof.rows && lines.rows) { out.taxProfiles = prof.rows; out.taxProfileLines = lines.rows; }
  } catch { /* optional */ }
  out.ok = out.failed.length === 0;
  return out;
}

// Sort the way the database orders the reads (sort_order, then the tie breaks), for rows the
// planner inserted in memory.
const bySortThenId = (a, b) => (Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)) || String(a.id).localeCompare(String(b.id));

/**
 * The raw venue (as readVenueRaw returns it, or with publish's writes applied in memory) in the
 * shape readVenueMenu resolves, so menuSnapshotFromRead builds the same snapshot Push to POS does.
 * Live products only (archived = false), like readVenueMenu.
 */
export function menuReadFromRaw(raw, { resort = false } = {}) {
  const sortIf = (rows) => (resort ? [...rows].sort(bySortThenId) : rows);
  return {
    ok: true,
    locationId: raw.locationId,
    menus: sortIf(raw.menus || []).map(mapMenuRow),
    menuCategories: sortIf(raw.categories || []).map(mapCategoryRow),
    menuItems: sortIf((raw.items || []).filter((i) => i && i.archived === false)).map(mapMenuItemRow),
    modifierGroupDefs: sortIf(raw.groups || []).map(mapModifierGroupRow),
    taxRates: (raw.taxRates || []).map(mapTaxRateRow),
    ...(Array.isArray(raw.taxProfiles) && Array.isArray(raw.taxProfileLines)
      ? { taxProfiles: assembleTaxProfiles(raw.taxProfiles, raw.taxProfileLines) } : {}),
    ...(raw.location ? { venueDefaultTaxProfileId: raw.location.default_tax_profile_id || null } : {}),
  };
}
