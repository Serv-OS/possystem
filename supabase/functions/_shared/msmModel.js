// supabase/functions/_shared/msmModel.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the shared vocabulary of the central menu.
// Pure, no imports, no Deno, no network. Imported by the msm-publish edge function, by the
// other _shared/msm*.js modules and by src/lib/msm (the screens), so the browser preview and
// the server publish use the SAME rules.
//
// Peter, 17 Oct 2026: "build a multi site menu builder where if you want to manage a menu
// centrally you can: a list of products, their categories, if it is active at each location,
// what the price is at each location". And: "not just schedule price increase but schedule
// menu push so we can add items then say these items need to be on the POS by X date and time".
//
// THE MODEL IN ONE PARAGRAPH
//   A company owned central menu (msm_ tables, Ops) sits ON TOP of each venue's own menu rows
//   (menus, menu_categories, menu_items, menu_category_links, modifier_groups). Edits are staged
//   as msm_changes in a change set. Publish (now, or at a time on each site's clock) runs on the
//   server: it plans each venue's writes with msmPlan.js, writes the venue rows IN PLACE by
//   their existing ids and inserts that venue's config push, in one transaction per venue
//   (public.msm_apply_site). Every surface keeps reading exactly what it reads today.
//
// The lists below are pinned to the migration (supabase/migrations/20261017_OPS_multi_site_menu.sql)
// by src/lib/msm/msmMigration.test.js: change one and that test says which list differs.

// ── Staging ─────────────────────────────────────────────────────────────────

// What a change can target. 'menu' is the central menu's own details; 'menu_site' adds a site;
// 'product_site' is one product at one site (price, active, channel prices, kept venue values).
export const TARGETS = Object.freeze(['menu', 'menu_site', 'category', 'product', 'product_site']);

export const OPS = Object.freeze(['create', 'update', 'remove']);

// Which ops each target allows.
export const TARGET_OPS = Object.freeze({
  menu: ['update'],
  menu_site: ['create'],
  category: ['create', 'update', 'remove'],
  product: ['create', 'update', 'remove'],
  product_site: ['create', 'update'],
});

// The fields a change may carry in `after`, per target. Anything else is refused by the
// database (trigger msm_changes_guard) and dropped here (stageableFields).
export const STAGE_FIELDS = Object.freeze({
  menu: ['name', 'description', 'use_name_everywhere'],
  menu_site: ['venue_menu_id'],
  category: ['parent_id', 'label', 'icon', 'color', 'accounting_group', 'default_course', 'sort_order', 'image', 'archived', 'route_like_id'],
  product: [
    'category_id', 'extra_category_ids', 'parent_product_id', 'type', 'name', 'menu_name', 'receipt_name',
    'kitchen_name', 'description', 'default_price', 'default_channels', 'tax_rate_name', 'tax_rate_percent',
    'allergens', 'tags', 'image', 'modifier_groups', 'visibility', 'sold_alone', 'item_code',
    'site_only_location_id', 'archived', 'sort_order', 'family_base',
  ],
  product_site: ['venue_item_id', 'active', 'price', 'channel_prices', 'kept'],
});

// The channel price keys a venue's pricing jsonb carries (lib/menuPricing.js reads the same).
export const CHANNELS = Object.freeze(['dineIn', 'takeaway', 'collection', 'delivery', 'driveThru']);

// ── How a central field lands on a venue row (design 1.3) ───────────────────

// Product field -> venue menu_items column. null = central only (never written to a venue).
export const PRODUCT_COLUMN = Object.freeze({
  name: 'name', menu_name: 'menu_name', receipt_name: 'receipt_name', kitchen_name: 'kitchen_name',
  description: 'description', category_id: 'cat', extra_category_ids: 'cats', parent_product_id: 'parent_id',
  type: 'type', default_price: 'pricing', default_channels: 'pricing', tax_rate_name: 'tax_rate_id',
  tax_rate_percent: 'tax_rate_id', allergens: 'allergens', tags: 'tags', image: 'image',
  modifier_groups: 'assigned_modifier_groups', visibility: 'visibility', sold_alone: 'sold_alone',
  item_code: 'item_code', archived: 'archived', site_only_location_id: null, sort_order: null, family_base: null,
});

export const PRODUCT_SITE_COLUMN = Object.freeze({
  venue_item_id: null, active: 'archived', price: 'pricing', channel_prices: 'pricing', kept: null,
});

export const CATEGORY_COLUMN = Object.freeze({
  parent_id: 'parent_id', label: 'label', icon: 'icon', color: 'color', accounting_group: 'accounting_group',
  default_course: 'default_course', sort_order: 'sort_order', image: 'image', archived: 'menu_id', route_like_id: null,
});

// The venue values a site may KEEP as its own (msm_product_sites.kept, keyed by venue column).
// Import writes every difference it finds here instead of refusing (design review, blocker 3),
// and publish never writes a kept column at that site unless a change clears it there.
export const KEPT_COLUMNS = Object.freeze([
  'cat', 'cats', 'image', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'tax_rate_id',
  'allergens', 'tags', 'visibility', 'sold_alone', 'item_code', 'assigned_modifier_groups', 'type', 'parent_id',
]);

// Venue columns publish may write (public.msm_apply_site refuses anything else).
export const VENUE_INSERT = Object.freeze({
  menus: ['id', 'name', 'description', 'is_default', 'is_active', 'sort_order', 'scope', 'org_id'],
  categories: ['id', 'menu_id', 'parent_id', 'label', 'icon', 'color', 'accounting_group', 'sort_order', 'default_course', 'image', 'scope', 'org_id'],
  items: [
    'id', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type', 'cat', 'cats', 'parent_id',
    'sort_order', 'pricing', 'allergens', 'assigned_modifier_groups', 'visibility', 'sold_alone', 'archived',
    'tax_rate_id', 'image', 'scope', 'org_id', 'tags', 'item_code',
  ],
  groups: ['id', 'name', 'min', 'max', 'min_select', 'max_select', 'selection_type', 'options', 'sort_order'],
});
export const VENUE_UPDATE = Object.freeze({
  menus: ['name', 'description'],
  categories: ['menu_id', 'parent_id', 'label', 'icon', 'color', 'accounting_group', 'sort_order', 'default_course', 'image'],
  items: [
    'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type', 'cat', 'cats', 'parent_id',
    'allergens', 'assigned_modifier_groups', 'visibility', 'sold_alone', 'archived', 'tax_rate_id', 'image', 'tags', 'item_code',
  ],
});
// pricing is never sent whole on an update: only these keys, merged in SQL (pricing || patch),
// so a venue's own menu tier prices (pricing.menus) are never touched.
export const PRICING_KEYS = Object.freeze(['base', ...CHANNELS]);

// Never written by publish, whatever a change says (design 1.3, venue owned).
export const VENUE_OWNED = Object.freeze([
  'pricing.menus', 'sort_order (existing products)', 'centre_id', 'tax_overrides', 'tax_profile_id',
  'option_group_order', 'lock_pricing', 'locked_fields', 'scope', 'master_id', 'org_id',
]);

// The same check as menu_categories_image_shape on the live table (read 17 Oct 2026). A central
// category image that would not pass it is a blocking problem, never a failed transaction.
export const CATEGORY_IMAGE_RE = /^https:\/\/[^/?#]+\/storage\/v1\/object\/public\/product-images\/[^/?#]+\/categories\/[A-Za-z0-9_-]+-[0-9]+\.(jpg|png|webp)$/;

// ── Ids: never change (design 1.4) ──────────────────────────────────────────

// The venue suffix the sharing engine already uses: the last 8 characters of the venue id.
export const suffixOf = (locationId) => String(locationId || '').slice(-8);

// The first 12 hex characters of a uuid.
export const hex12 = (uuid) => String(uuid || '').replace(/-/g, '').toLowerCase().slice(0, 12);

// A product's base id: an imported family keeps its master id, a new product gets msm-<12 hex>.
export const productBase = (product) => (product && product.family_base) || `msm-${hex12(product && product.id)}`;
export const newItemId = (product, locationId) => `${productBase(product)}_${suffixOf(locationId)}`;
export const newCategoryId = (categoryId, locationId) => `msmc-${hex12(categoryId)}_${suffixOf(locationId)}`;
export const newMenuId = (menuId, locationId) => `menu-msm-${hex12(menuId)}_${suffixOf(locationId)}`;
export const newGroupId = (groupId, locationId) => `msmg-${hex12(groupId)}_${suffixOf(locationId)}`;

// The same ids with the WHOLE central uuid, for when the short one is already taken at that venue
// (two central ids can share their first 12 characters; found by the edge harness, 17 Oct 2026).
const hex32 = (uuid) => String(uuid || '').replace(/-/g, '').toLowerCase();
export const longCategoryId = (categoryId, locationId) => `msmc-${hex32(categoryId)}_${suffixOf(locationId)}`;
export const longMenuId = (menuId, locationId) => `menu-msm-${hex32(menuId)}_${suffixOf(locationId)}`;
export const longGroupId = (groupId, locationId) => `msmg-${hex32(groupId)}_${suffixOf(locationId)}`;

/** The short id, or the long one when the short one is taken (taken(id) says). null when both are. */
export function freeId(short, long, taken) {
  if (!taken(short)) return short;
  if (!taken(long)) return long;
  return null;
}

// The family a venue id belongs to: its master id, or the id with a `_<8 hex>` venue suffix
// removed (copies whose master was demoted to local still match this way).
export const familyOf = (row) => {
  if (!row) return null;
  const master = row.master_id ?? row.masterId ?? null;
  if (master) return String(master);
  const id = String(row.id || '');
  const m = /^(.+)_[0-9a-f]{8}$/i.exec(id);
  return m ? m[1] : id;
};

// ── Small value helpers ─────────────────────────────────────────────────────

export const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

// Whole pence from a price (number or numeric string). null stays null; NaN stays NaN.
export const toPence = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100 + (n >= 0 ? 1e-9 : -1e-9));
};
export const fromPence = (p) => (p === null || p === undefined ? null : Math.round(p) / 100);

/**
 * What a site charges for channel `ch` when it has NO `ch` price of its own, in pounds (null when
 * nothing is priced). The till's own chain (src/lib/menuPricing.js resolveItemPrice): the venue
 * row's pricing[ch] is the group's ch price; drive thru then reads takeaway (the site's own, then
 * the group's); then the In store price (the site's own, then the group's). One chain for the
 * Change prices tool, the grid and the product sheet.
 */
export function channelFallback(product, ps, ch) {
  const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const def = (product && product.default_channels) || {};
  const own = (ps && ps.channel_prices) || {};
  const defCh = n(def[ch]);
  if (defCh != null) return defCh;
  if (ch === 'driveThru') {
    const t = n(own.takeaway) ?? n(def.takeaway);
    if (t != null) return t;
  }
  return n(ps && ps.price) ?? n(product && product.default_price);
}

/** The group's own fallback for channel `ch` (no site): its ch price, takeaway for drive thru, its In store price. */
export function groupChannelPrice(product, ch) {
  return channelFallback(product, null, ch);
}

// Two prices the same to the penny (null and undefined are the same "no price").
export const samePrice = (a, b) => {
  const x = toPence(a), y = toPence(b);
  if (x === null || y === null) return x === y;
  return x === y;
};

// Normalised name for matching: lower case, trimmed, spaces collapsed, punctuation removed,
// "&" read as "and".
export const normName = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Deep equality for jsonb shaped values. null and undefined are equal; key order does not count.
export function sameValue(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') {
    const x = Number(a), y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && x === y;
  }
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!sameValue(a[k], b[k])) return false;
    return true;
  }
  return false;
}

// A copy of `after` with only the fields a target may stage.
export function stageableFields(target, after) {
  const allowed = STAGE_FIELDS[target] || [];
  const out = {};
  for (const k of allowed) if (has(after, k)) out[k] = after[k];
  return out;
}

// Is a change row acceptable? { ok, words } with plain words when not.
export function checkChange(change) {
  const c = change || {};
  if (!TARGETS.includes(c.target)) return { ok: false, words: `Unknown kind of change: ${c.target || '(none)'}.` };
  if (!(TARGET_OPS[c.target] || []).includes(c.op)) return { ok: false, words: `A ${c.target.replace('_', ' ')} cannot be changed that way (${c.op || 'no action'}).` };
  if ((c.target === 'menu_site' || c.target === 'product_site') && !c.location_id) return { ok: false, words: 'Pick a site for this change.' };
  if ((c.target === 'menu' || c.target === 'category' || c.target === 'product') && c.location_id) return { ok: false, words: 'This change is for every site, not one.' };
  const after = c.after && typeof c.after === 'object' ? c.after : {};
  const bad = Object.keys(after).filter((k) => !(STAGE_FIELDS[c.target] || []).includes(k));
  if (bad.length) return { ok: false, words: `These cannot be changed here: ${bad.join(', ')}.` };
  if (c.target === 'product_site' && c.op === 'create' && !after.venue_item_id) return { ok: false, words: 'A new product at a site needs its venue id.' };
  return { ok: true, words: '' };
}

// ── Status words (one place, so the screen, the emails and the activity feed agree) ──

export const SITE_STATUS = Object.freeze({
  scheduled: 'Scheduled',
  running: 'Running',
  done: 'Done',
  nothing: 'Nothing to change',
  failed: 'Failed',
  cancelled: 'Cancelled',
});

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Money for words: 2.95 -> "2.95". Never a currency symbol here (the screen adds it per venue).
export const money2 = (v) => {
  const p = toPence(v);
  if (p === null || Number.isNaN(p)) return '';
  const neg = p < 0;
  const a = Math.abs(p);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};
