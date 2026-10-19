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
// The lists below are pinned to the migrations (supabase/migrations/20261017_OPS_multi_site_menu.sql
// and, from round 2, 20261017c_OPS_multi_site_menu_groups.sql: the NEWEST definition of each
// function wins) by src/lib/msm/msmMigration.test.js: change one and that test says which differs.
//
// ROUND 2 (17 Oct 2026, same release): option groups become central like products (a group, its
// options as rows, a default option price and a price per site, kept site values), sub items, and
// VAT per order type on products (tax_by_type, written into menu_items.tax_overrides, four keys
// only, every other key left as the site has it).

// ── Staging ─────────────────────────────────────────────────────────────────

// What a change can target. 'menu' is the central menu's own details; 'menu_site' adds a site;
// 'product_site' is one product at one site (price, active, channel prices, kept venue values).
// Round 2 adds the option groups: a group, a group at one site (its venue id and what it keeps),
// an option, and an option at one site (on or off there, its own price, what it keeps).
export const TARGETS = Object.freeze([
  'menu', 'menu_site', 'category', 'product', 'product_site',
  'modifier_group', 'modifier_group_site', 'modifier_option', 'modifier_option_site',
]);

// The targets that are about ONE site (they need a location; every other target is for every site).
export const SITE_TARGETS = Object.freeze(['menu_site', 'product_site', 'modifier_group_site', 'modifier_option_site']);

export const OPS = Object.freeze(['create', 'update', 'remove']);

// Which ops each target allows.
export const TARGET_OPS = Object.freeze({
  menu: ['update'],
  menu_site: ['create'],
  category: ['create', 'update', 'remove'],
  product: ['create', 'update', 'remove'],
  product_site: ['create', 'update'],
  modifier_group: ['create', 'update', 'remove'],
  modifier_group_site: ['create', 'update'],
  modifier_option: ['create', 'update', 'remove'],
  modifier_option_site: ['create', 'update'],
});

// A category the group menu already has (18 Oct follow up): only "send like" and removed or back.
// No screen edits an existing category's name, place or colour yet, and the import keeps no per site
// category differences (products have kept values, categories do not), so publish would write the
// group's value over every site's own. A NEW category takes every field. The database refuses the
// rest (trigger msm_changes_guard_category, 20261018, after msm_changes_guard); the screens say it
// first (msmDiff.mergeStaged).
export const CATEGORY_UPDATE_FIELDS = Object.freeze(['archived', 'route_like_id']);
/** Words when a change to a category the group menu already has carries any other field ('' when fine). */
export function categoryUpdateWords(change, op = change?.op) {
  if (!change || change.target !== 'category' || op === 'create') return '';
  const bad = Object.keys(change.after && typeof change.after === 'object' ? change.after : {}).filter((k) => !CATEGORY_UPDATE_FIELDS.includes(k));
  return bad.length ? "A category's name, place and colour stay as each site has them for now. Only a new category takes them here." : '';
}

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
    'site_only_location_id', 'archived', 'sort_order', 'family_base', 'tax_by_type',
  ],
  product_site: ['venue_item_id', 'active', 'price', 'channel_prices', 'kept'],
  modifier_group: ['name', 'min', 'max', 'selection_type', 'sort_order', 'archived', 'family_base'],
  modifier_group_site: ['venue_group_id', 'kept'],
  modifier_option: ['group_id', 'name', 'price', 'product_id', 'sub_group_id', 'sort_order', 'archived'],
  modifier_option_site: ['venue_option_id', 'active', 'price', 'kept'],
});

// The channel price keys a venue's pricing jsonb carries (lib/menuPricing.js reads the same).
export const CHANNELS = Object.freeze(['dineIn', 'takeaway', 'collection', 'delivery', 'driveThru']);

// The order type prices the group menu sets and publish writes (Peter, 17 Oct 2026, UI issue 2):
// Delivery is a PLATFORM price, set by the menu chosen for that platform at each site, exactly as
// the normal menu builder does it, so publish never writes pricing.delivery (or a product's
// visibility on an existing row): whatever the site has stays. Eat in, Takeaway, Collection and
// Drive thru are order types at the till and stay.
export const PUBLISHED_CHANNELS = Object.freeze(['dineIn', 'takeaway', 'collection', 'driveThru']);

// VAT per order type (design 5.3): the ONLY menu_items.tax_overrides keys publish writes. The till,
// kiosk and server read collection and drive thru through takeaway, and a bar tab through bar
// (src/lib/taxRule.js TAX_ORDER_TYPE_ALIASES; 20261009a _vat_order_type_key), so one Takeaway row is
// right everywhere. Every other key a site holds (counter, drive-thru, collection, an explicit null)
// is copied as it is, always.
export const ORDER_TYPE_TAX_KEYS = Object.freeze(['dine-in', 'takeaway', 'delivery', 'bar']);

// The order types a group menu can show (msm_menus.order_types, public.msm_set_order_types): the
// price keys the tills read, plus the bar tab (a VAT row only).
export const ORDER_TYPES = Object.freeze([...CHANNELS, 'bar']);

// An option group's choice kinds (modifier_groups.selection_type).
export const SELECTION_TYPES = Object.freeze(['single', 'multiple', 'quantity']);

// What a site may keep as its own on a group (msm_modifier_group_sites.kept, keyed by venue column)
// and on an option (msm_modifier_option_sites.kept): its own name, its own sub item link
// (item_link: false = the site's option has no sub item; a text = the site's own item id), its own
// "Then ask" group (sub_group: false = none; a text = the site's own group id).
export const GROUP_KEPT_COLUMNS = Object.freeze(['name', 'min', 'max', 'selection_type']);
export const OPTION_KEPT_KEYS = Object.freeze(['name', 'item_link', 'sub_group']);

// The keys of one option inside a venue group's options jsonb that publish may write.
export const OPTION_ENTRY_KEYS = Object.freeze(['id', 'name', 'price', 'itemId', 'subGroupId']);
export const OPTION_PATCH_KEYS = Object.freeze(['name', 'price', 'itemId', 'subGroupId']);

// The top level keys of msm_apply_site's p_writes, and of p_writes.maps (the database refuses any
// other key, so a newer planner against an older SQL never half applies: design review).
export const WRITE_KEYS = Object.freeze(['menus', 'categories', 'items', 'links', 'groups', 'routing', 'maps']);
export const MAP_KEYS = Object.freeze(['categories', 'groups', 'menu_site', 'options', 'items']);

// public.msm_sql_contract() answers this once 20261017c has run. msm-publish refuses to plan
// against an older database ("Run 20261017c first").
export const SQL_CONTRACT = 2;

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
// Round 2: tax_overrides, as an object of the ORDER TYPE keys the site keeps (a rate id, null for
// "the venue default" as the site has it, or false for "no key here"), plus, for information only,
// the site's other keys (counter, drive-thru, collection) which publish never writes anyway.
// 17 Oct recheck: no_price (always true): the site's row has NO Standard price (pricing.base null,
// or no pricing.base at all). A missing price is a fact the import keeps, never a difference to fix:
// publish never writes a Standard price into that row until someone sets a price for it at that
// site in the multi site menu (that change takes no_price away), and a change that puts no_price
// back (Undo) writes "no price" again. A product with sizes never gets a Standard price written by
// publish at all (its sizes carry the price, as in Menu Manager), so it never needs this.
export const NO_PRICE = 'no_price';
export const KEPT_COLUMNS = Object.freeze([
  'cat', 'cats', 'image', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'tax_rate_id',
  'allergens', 'tags', 'visibility', 'sold_alone', 'item_code', 'assigned_modifier_groups', 'type', 'parent_id',
  'tax_overrides', 'no_price',
]);
/** Does this site keep "no price" for the product? (msm_product_sites.kept.no_price) */
export const keepsNoPrice = (ps) => !!ps && !!ps.kept && typeof ps.kept === 'object' && ps.kept[NO_PRICE] === true;
/** A site's kept values without no_price (for a change that sets a price there on purpose). */
export const keptWithoutNoPrice = (kept) => {
  const out = { ...(kept && typeof kept === 'object' ? kept : {}) };
  delete out[NO_PRICE];
  return out;
};
/**
 * A product priced by its sizes: typed 'variants', or any product with live sizes under it in the
 * group menu. Its own Standard price is never charged, never written by publish, and never moved by
 * Change prices (Menu Manager shows no Standard price box for it either).
 */
export const pricedBySizes = (product, products) => !!product && (product.type === 'variants'
  || (Array.isArray(products) && products.some((x) => x && x.parent_product_id === product.id && !x.archived)));

// Venue columns publish may write (public.msm_apply_site refuses anything else).
export const VENUE_INSERT = Object.freeze({
  menus: ['id', 'name', 'description', 'is_default', 'is_active', 'sort_order', 'scope', 'org_id'],
  categories: ['id', 'menu_id', 'parent_id', 'label', 'icon', 'color', 'accounting_group', 'sort_order', 'default_course', 'image', 'scope', 'org_id'],
  items: [
    'id', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type', 'cat', 'cats', 'parent_id',
    'sort_order', 'pricing', 'allergens', 'assigned_modifier_groups', 'visibility', 'sold_alone', 'archived',
    'tax_rate_id', 'image', 'scope', 'org_id', 'tags', 'item_code', 'tax_overrides',
  ],
  groups: ['id', 'name', 'min', 'max', 'min_select', 'max_select', 'selection_type', 'options', 'sort_order'],
});
export const VENUE_UPDATE = Object.freeze({
  menus: ['name', 'description'],
  categories: ['menu_id', 'parent_id', 'label', 'icon', 'color', 'accounting_group', 'sort_order', 'default_course', 'image'],
  items: [
    'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type', 'cat', 'cats', 'parent_id',
    'allergens', 'assigned_modifier_groups', 'visibility', 'sold_alone', 'archived', 'tax_rate_id', 'image', 'tags', 'item_code',
    'tax_profile_id',
  ],
  // A group is never written whole: these columns, then its options one by one (OPTION_PATCH_KEYS).
  groups: ['name', 'min', 'max', 'min_select', 'max_select', 'selection_type'],
});
// tax_overrides is never sent whole on an update either: { set: {key: rate id}, remove: [keys] },
// ORDER_TYPE_TAX_KEYS only, applied by the database to the row it has locked.
// tax_profile_id is written in exactly two ways (msm_apply_site checks both): null over a profile
// that is still a generated copy of the item's own rate (it hid the order type VAT), or that same
// copy put back by a later publish (Undo).
// pricing is never sent whole on an update: only these keys, merged in SQL (pricing || patch),
// so a venue's own menu tier prices (pricing.menus) are never touched.
export const PRICING_KEYS = Object.freeze(['base', ...CHANNELS]);

// Never written by publish, whatever a change says (design 1.3, venue owned).
export const VENUE_OWNED = Object.freeze([
  'pricing.menus', 'sort_order (existing products)', 'centre_id', 'tax_overrides keys other than dine-in, takeaway, delivery, bar',
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
// A new option inside a venue group: the same id at every site (option ids are unique per group).
export const newOptionId = (optionId) => `opt-msm-${hex12(optionId)}`;

// The same ids with the WHOLE central uuid, for when the short one is already taken at that venue
// (two central ids can share their first 12 characters; found by the edge harness, 17 Oct 2026).
const hex32 = (uuid) => String(uuid || '').replace(/-/g, '').toLowerCase();
export const longCategoryId = (categoryId, locationId) => `msmc-${hex32(categoryId)}_${suffixOf(locationId)}`;
export const longMenuId = (menuId, locationId) => `menu-msm-${hex32(menuId)}_${suffixOf(locationId)}`;
export const longGroupId = (groupId, locationId) => `msmg-${hex32(groupId)}_${suffixOf(locationId)}`;
export const longOptionId = (optionId) => `opt-msm-${hex32(optionId)}`;

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

/**
 * Does a site have NO price for a product (17 Oct recheck)? It keeps no_price and has no Standard
 * price of its own; for an order type, it has no price of its own for it either and nothing but
 * its (missing) Standard price to fall back to.
 */
export function noPriceAt(product, ps, ch = null) {
  if (!keepsNoPrice(ps) || ps.price != null) return false;
  if (!ch || !CHANNELS.includes(ch)) return true;
  if (ps.channel_prices && ps.channel_prices[ch] != null) return false;
  return channelFallback({ ...(product || {}), default_price: null }, { ...ps, price: null }, ch) == null;
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
  if (SITE_TARGETS.includes(c.target) && !c.location_id) return { ok: false, words: 'Pick a site for this change.' };
  if (!SITE_TARGETS.includes(c.target) && c.location_id) return { ok: false, words: 'This change is for every site, not one.' };
  const after = c.after && typeof c.after === 'object' ? c.after : {};
  const bad = Object.keys(after).filter((k) => !(STAGE_FIELDS[c.target] || []).includes(k));
  if (bad.length) return { ok: false, words: `These cannot be changed here: ${bad.join(', ')}.` };
  if (c.target === 'product_site' && c.op === 'create' && !after.venue_item_id) return { ok: false, words: 'A new product at a site needs its venue id.' };
  if (c.target === 'modifier_group_site' && c.op === 'create' && !after.venue_group_id) return { ok: false, words: 'A group at a site needs that site\'s group.' };
  if ((c.target === 'modifier_group_site' && c.op !== 'create' && has(after, 'venue_group_id'))
      || (c.target === 'modifier_option_site' && c.op !== 'create' && has(after, 'venue_option_id'))) return { ok: false, words: 'A site\'s own id never changes.' };
  if (c.target === 'modifier_option' && c.op === 'create' && !after.group_id) return { ok: false, words: 'A new option needs its option group.' };
  if (c.target === 'modifier_option' && c.op !== 'create' && has(after, 'group_id')) return { ok: false, words: 'An option cannot move to another group. Remove it and add it there.' };
  if (c.target === 'modifier_group' && has(after, 'selection_type') && !SELECTION_TYPES.includes(after.selection_type)) return { ok: false, words: 'Pick one choice, several choices, or the same choice more than once.' };
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

// A VAT rate as a percent (17 Oct 2026 verification): live tax_rates.rate is a FRACTION (0.2 is 20%,
// lib/tax.js divides by 1 + rate), and the import copies it into msm_products.tax_rate_percent as it
// is. A value above 1 is already a percent (older rows, made up data). Used for words only: mapping
// a rate always compares the stored values as they are, so it never depends on this.
export const ratePercent = (r) => {
  if (r === null || r === undefined || r === '') return null;
  const n = Number(r);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n : Math.round(n * 100000) / 1000;
};
/** "20%", "8.875%", "0%" ('' when there is no rate). */
export const pctText = (r) => {
  const p = ratePercent(r);
  return p === null ? '' : `${Math.round(p * 1000) / 1000}%`;
};
/** The fraction to take off a VAT inclusive price (0.2 for 20%, whichever way the rate is stored). */
export const rateFraction = (r) => {
  const p = ratePercent(r);
  return p === null ? 0 : p / 100;
};
