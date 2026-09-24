// shareCopy.js — what a shared or global product carries to every venue.
//
// Peter, 23 Sep 2026: "we need to ensure that when you share a product if it
// has modifiers those go across with the groups and rules fully" and "when
// something is global its global across the shared locations properly".
//
// Two faults were found:
//   1. The first copy dropped fields: visibility, tags, tax rate, tax profile,
//      tax overrides, item code, print centre, instruction groups, and the
//      order of option groups. A shared product arrived at a peer venue as a
//      lesser version of itself.
//   2. Edits after that never propagated at all. propagateGlobalEdit existed
//      and nothing called it. "Global" was a label on a one-time copy.
//
// This file is the single classification of every menu_items column, so the
// copy and the propagation cannot disagree, and a column added later fails a
// test until somebody says what happens to it.

/** Copied as they are. Same value at every venue. */
export const VERBATIM_FIELDS = Object.freeze([
  'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type',
  'pricing', 'allergens', 'tags', 'visibility', 'sold_alone', 'image',
  'item_code', 'lock_pricing', 'locked_fields',
  // Instruction group ids are copied as they are: their definitions live in each
  // venue's config snapshot, not in a table, so they cannot be created at a peer
  // from here. An id the peer does not know is ignored by every surface.
  'assigned_instruction_groups',
]);

/** Per-venue ids. Copied only after translation to the peer's own ids. */
export const REMAPPED_FIELDS = Object.freeze([
  'cat', 'cats', 'parent_id', 'assigned_modifier_groups', 'option_group_order',
  'tax_rate_id', 'tax_profile_id', 'centre_id',
  // Its VALUES are tax rate ids (one per order type), so it is translated too.
  // Carried as it was, a peer's takeaway sales pointed at a rate it did not have.
  'tax_overrides',
]);

/**
 * Written on the FIRST copy and on a deliberate re-send, never on an edit.
 *   archived   a venue may retire its own copy of a Shared product and a master
 *              rename must not bring it back; a re-send restores it only when
 *              the source is live (that is what repairs Location 2's July copy).
 *   sort_order the peer's own category order is its own.
 */
export const RESEND_ONLY_FIELDS = Object.freeze(['archived', 'sort_order']);

/** Identity and ownership. Never copied, never propagated. */
export const NEVER_FIELDS = Object.freeze([
  'id', 'location_id', 'org_id', 'master_id', 'scope', 'created_at', 'updated_at',
]);

/** A Shared peer may override these; a Global peer may not. */
export const SHARED_OVERRIDABLE = Object.freeze(['pricing', 'cat', 'cats', 'image']);

/**
 * Which fields an edit at the owning venue pushes to its siblings.
 * Global: everything. Shared: everything a venue may not override; with
 * "Lock pricing" on, the price follows too (the toggle was cosmetic before).
 */
export function propagatedFields(scope, { lockPricing = false } = {}) {
  const all = [...VERBATIM_FIELDS, ...REMAPPED_FIELDS];
  // Global has no local decisions: a size or product retired at the owner is
  // retired everywhere. Shared keeps archived as the venue's own (RESEND_ONLY).
  if (scope === 'global') return [...all, 'archived'];
  if (scope === 'shared') return all.filter((f) => !SHARED_OVERRIDABLE.includes(f) || (lockPricing && f === 'pricing'));
  return [];
}

/**
 * Which fields a RE-SEND may write onto a peer row that already exists.
 * A new row gets everything. Shared keeps the peer's own overrides.
 */
export function resendFields(scope, { exists = false, lockPricing = false } = {}) {
  const all = [...VERBATIM_FIELDS, ...REMAPPED_FIELDS, ...RESEND_ONLY_FIELDS];
  if (!exists || scope === 'global') return all;
  return all.filter((f) => !SHARED_OVERRIDABLE.includes(f) || (lockPricing && f === 'pricing'))
    .filter((f) => f !== 'sort_order');
}

/** Only the master row may share, re-send or propagate. A copy carries master_id. */
export function isMasterRow(row) {
  const m = fieldOf(row, 'master_id');
  return !m || m === row.id;
}

const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/**
 * Read a field off a row that may be snake_case (db) or camelCase (store).
 *
 * CAMEL WINS when both are present. A Back Office store item is built by
 * spreading the raw database row (`...item`) and then adding camelCase keys,
 * and every edit updates the camelCase one, so the snake key is the value at
 * load time. Reading it first pushed pre-edit values to every venue.
 */
export function fieldOf(row, field) {
  if (!row) return undefined;
  const c = camel(field);
  if (c !== field && row[c] !== undefined) return row[c];
  if (row[field] !== undefined) return row[field];
  const s = snake(field);
  return row[s];
}

/** The verbatim part of a copy: present fields only, so a missing one is left to the column default. */
export function carryVerbatim(row, fields = VERBATIM_FIELDS) {
  const out = {};
  for (const f of fields) {
    // Only ever verbatim columns: a per-venue id can never leave here unmapped
    // (round-3 review: the owner's raw cat ids reached a Global peer).
    if (!VERBATIM_FIELDS.includes(f)) continue;
    const v = fieldOf(row, f);
    if (v !== undefined) out[f] = v;
  }
  return out;
}

/**
 * The re-send-only part. RESTORE ONLY: a live source writes archived:false so a
 * copy retired by accident (Location 2's July copy) comes back; a retired source
 * writes nothing, so no re-send path can ever archive a venue's product.
 */
export function carryResendOnly(row) {
  const out = {};
  const archived = fieldOf(row, 'archived');
  if (archived !== undefined && !archived) out.archived = false;
  const so = fieldOf(row, 'sort_order');
  if (so !== undefined) out.sort_order = so;
  return out;
}

/**
 * The four name columns, derived exactly as upsertMenuItem derives them, so a
 * copy or a propagation can never carry a name the owner's own row does not.
 * The main editor patches menuName only; `name` on a loaded store row is the
 * value at load time.
 */
export function nameColumnsFor(row) {
  const display = fieldOf(row, 'menu_name') || row?.name || 'Item';
  return {
    name: display,
    menu_name: display,
    receipt_name: fieldOf(row, 'receipt_name') || display,
    kitchen_name: fieldOf(row, 'kitchen_name') || display,
  };
}

/**
 * pricing.menus holds per-menu tier prices keyed by MENU ID, a per-venue id.
 * Keys are translated by menu name at the peer; a tier for a menu the peer
 * lacks is dropped and reported. Everything else in pricing is carried as is.
 */
export function remapPricingMenus(pricing, menuIdFor) {
  if (!pricing || typeof pricing !== 'object' || !pricing.menus || typeof pricing.menus !== 'object') return { pricing, unmapped: [] };
  const menus = {}; const unmapped = [];
  for (const [menuId, tier] of Object.entries(pricing.menus)) {
    const peer = menuIdFor ? menuIdFor(menuId) : null;
    if (peer) menus[peer] = tier; else unmapped.push(`pricing.menus:${menuId}`);
  }
  return { pricing: { ...pricing, menus }, unmapped };
}

/** The suffix a peer venue's copies carry: the last 8 characters of its id. */
export const peerSuffixOf = (locationId) => String(locationId || '').slice(-8);

/**
 * Translate the per-venue fields of a source row for one peer.
 *
 * `ctx` supplies the peer's answers; each returns null when the peer has no
 * equivalent, which is recorded in `unmapped` so the operator can be told
 * rather than silently getting a broken reference.
 *
 * @param {object} row  source row (snake or camel)
 * @param {{ catIdFor:(id)=>string|null, groupIdFor:(id)=>string|null, parentIdFor:(id)=>string|null,
 *           taxRateIdFor:(id)=>string|null, taxProfileIdFor:(id)=>string|null, centreIdFor:(id)=>string|null }} ctx
 * @param {string[]} [only]  restrict to these fields (propagation)
 */
export function remapForPeer(row, ctx, only = REMAPPED_FIELDS) {
  const out = {}; const unmapped = [];
  const want = new Set(only);
  const map = (field, id, fn) => {
    if (!want.has(field)) return;
    if (id === undefined) return;
    if (id === null || id === '') { out[field] = null; return; }
    const v = fn(id);
    out[field] = v || null;
    if (!v) unmapped.push(`${field}:${id}`);
  };
  map('cat', fieldOf(row, 'cat'), ctx.catIdFor);
  if (want.has('cats')) {
    const cats = fieldOf(row, 'cats');
    if (cats !== undefined) {
      out.cats = (Array.isArray(cats) ? cats : []).map((c) => ctx.catIdFor(c)).filter(Boolean);
    }
  }
  map('parent_id', fieldOf(row, 'parent_id'), ctx.parentIdFor);
  if (want.has('assigned_modifier_groups')) {
    const ag = fieldOf(row, 'assigned_modifier_groups');
    if (ag !== undefined) {
      out.assigned_modifier_groups = (Array.isArray(ag) ? ag : []).map((a) => {
        const gid = typeof a === 'string' ? a : a && a.groupId;
        if (!gid) return a;
        const peer = ctx.groupIdFor(gid);
        if (!peer) { unmapped.push(`assigned_modifier_groups:${gid}`); return null; }
        return typeof a === 'string' ? peer : { ...a, groupId: peer };
      }).filter(Boolean);
    }
  }
  if (want.has('option_group_order')) {
    // The saved flow order mixes MODIFIER group ids (per venue, translated) with
    // INSTRUCTION group ids (config ids, the same everywhere). Only ids that are
    // modifier groups on this product are translated; everything else passes.
    const ogo = fieldOf(row, 'option_group_order');
    if (ogo !== undefined) {
      const ag = fieldOf(row, 'assigned_modifier_groups');
      const mine = new Set((Array.isArray(ag) ? ag : []).map((a) => (typeof a === 'string' ? a : a && a.groupId)).filter(Boolean));
      const ig = fieldOf(row, 'assigned_instruction_groups');
      const inst = new Set((Array.isArray(ig) ? ig : []).map((a) => (typeof a === 'string' ? a : a && a.groupId)).filter(Boolean));
      // a modifier group on the product → translated; an instruction group on
      // the product → the same id everywhere; anything else is stale → dropped.
      out.option_group_order = ogo === null ? null
        : (Array.isArray(ogo) ? ogo : []).map((g) => (mine.has(g) ? (ctx.groupIdFor(g) || null) : (inst.has(g) ? g : null))).filter(Boolean);
    }
  }
  map('tax_rate_id', fieldOf(row, 'tax_rate_id'), ctx.taxRateIdFor);
  map('tax_profile_id', fieldOf(row, 'tax_profile_id'), ctx.taxProfileIdFor);
  map('centre_id', fieldOf(row, 'centre_id'), ctx.centreIdFor);
  if (want.has('tax_overrides')) {
    const ov = fieldOf(row, 'tax_overrides');
    if (ov !== undefined) {
      if (!ov || typeof ov !== 'object') out.tax_overrides = null;
      else {
        const t = {};
        for (const [k, v] of Object.entries(ov)) {
          if (v == null) { t[k] = null; continue; }
          const peer = ctx.taxRateIdFor(v);
          // No equivalent: the key is DROPPED so the venue's normal rate applies,
          // never a rate id that belongs to another venue.
          if (peer) t[k] = peer; else unmapped.push(`tax_overrides.${k}:${v}`);
        }
        out.tax_overrides = t;
      }
    }
  }
  return { fields: out, unmapped };
}

/**
 * A modifier group's options translated for one peer: nested groups and
 * sold-alone sub-items point at the peer's copies. Everything else on an option
 * (name, price, allergens, image, limits) is carried as it is.
 */
export function remapGroupOptions(options, ctx) {
  const unmapped = [];
  const out = (Array.isArray(options) ? options : []).map((opt) => {
    const o = { ...opt };
    if (opt && opt.subGroupId) {
      const g = ctx.groupIdFor(opt.subGroupId);
      if (g) o.subGroupId = g; else unmapped.push(`subGroupId:${opt.subGroupId}`);
    }
    if (opt && opt.itemId) {
      const it = ctx.subItemIdFor(opt.itemId);
      if (it) o.itemId = it; else unmapped.push(`itemId:${opt.itemId}`);
    }
    return o;
  });
  return { options: out, unmapped };
}

/** The columns menu_items had on 23 Sep 2026. A new one must be classified above. */
export const LIVE_MENU_ITEM_COLUMNS = Object.freeze([
  'id', 'location_id', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type', 'cat', 'cats',
  'parent_id', 'sort_order', 'pricing', 'allergens', 'assigned_modifier_groups', 'assigned_instruction_groups',
  'visibility', 'sold_alone', 'archived', 'created_at', 'updated_at', 'tax_rate_id', 'tax_overrides', 'centre_id',
  'image', 'scope', 'org_id', 'master_id', 'lock_pricing', 'locked_fields', 'tags', 'option_group_order',
  'tax_profile_id', 'item_code',
]);
