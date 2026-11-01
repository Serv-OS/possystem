// supabase/functions/_shared/websiteRules.js
//
// WEBSITE BUILDER (v5.12.0): the rules every writer shares, with no database in them.
// Plain JS so the same file runs in the Deno functions (website-admin, website-domain),
// in the browser (src/lib/website/validatePatch.js re-exports it), in the Vercel Node
// function (api/website-designer.js) and in node tests (src/lib/website/*.test.js).
//
// WHY ONE FILE. The contract (docs/website-builder/ARCHITECTURE.md section 10) says every
// refused write returns 400 with a plain reason, never a silent drop. Three writers
// (edge function, AI function, Back Office) must refuse the SAME things, or a patch the
// designer accepted is refused by the editor and the owner sees a site that will not save.
//
// Block schema import contract (owned by agent B, src/surfaces/website/blocks/schema.js):
//   BLOCK_SCHEMAS = { [type]: { props: { [name]: { type:'string'|'text'|'href'|'location'|'number'|'boolean'|
//                    'enum'|'array'|'object', enum?:[] (or options:[]), required?:bool, max?:number,
//                    min?:number, item?:rule (array), fields?:{...} (object), default? } } } }
//   BLOCK_TYPES   = Object.keys(BLOCK_SCHEMAS)
// This file never imports it (the browser bundle targets Chrome 80, so no top level await
// and no optional import). Callers pass `schemas`; without one the block TYPES still have to
// be on the contract list below and props are only checked for shape and size.

// ── Limits (contract section 10) ──────────────────────────────────────────────────────────
export const LIMITS = Object.freeze({
  LAYOUT_MAX_BYTES: 400 * 1024,
  MAX_PAGES: 60,
  MAX_POSTS: 500,
  MAX_STRING: 20 * 1024,
  MAX_BLOCKS_PER_PAGE: 200,
  MAX_NAV_ITEMS: 30,
  MAX_TAGS: 20,
  PREVIEW_TOKEN_MS: 30 * 60 * 1000,
});

// Site slug: 3 to 40, lower case letters, digits and hyphens, no hyphen at either end
// (the same shape as online_slug in src/lib/customerUrl.js).
// 5.12.8: header options (settings.header), mirrored in src/surfaces/website/routes.js headerOptions.
export const HEADER_BRANDS = Object.freeze(['logo', 'name', 'both']);
export const HEADER_CTAS = Object.freeze(['none', 'order', 'book']);

export const SITE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
// Page and post slugs: 1 to 60. '' is the home page and is allowed only for kind 'home'.
export const PAGE_SLUG_RE = /^[a-z0-9-]{1,60}$/;

export const RESERVED_SITE_SLUGS = Object.freeze([
  'www', 'app', 'api', 'admin', 'sites', 'order', 'cater', 'dev', 'stage', 'test', 'servos', 'serv-os',
]);

// Page paths the server owns (contract section 3). A page cannot take them. 'blog' is the one
// exception: the kind 'blog' page holds the blog list layout and lives at /blog.
export const RESERVED_PAGE_SLUGS = Object.freeze(['blog', 'locations', 'preview', 'sitemap.xml', 'robots.txt', 'api', 'assets']);

export const PAGE_KINDS = Object.freeze(['home', 'menu', 'order', 'catering', 'loyalty', 'gift', 'findus', 'blog', 'location', 'custom']);
export const PAGE_STATUSES = Object.freeze(['draft', 'published']);
export const POST_STATUSES = Object.freeze(['draft', 'published']);
export const SITE_STATUSES = Object.freeze(['draft', 'live', 'offline']);

// Contract section 6, the one registry. Used when no schema module is at hand.
export const CONTRACT_BLOCK_TYPES = Object.freeze([
  'Hero', 'OrderBar', 'LiveMenu', 'Specials', 'OrderEmbed', 'LoyaltyJoin', 'GiftCards', 'BookTable',
  'Waitlist', 'Hours', 'FindUs', 'Reviews', 'BlogList',
  'Text', 'Columns', 'Gallery', 'Button', 'FAQ', 'Instagram', 'Divider', 'Spacer', 'CustomHtml',
]);

export const THEME_LAYOUTS = Object.freeze(['ember', 'ledger', 'marquee']);
export const THEME_TYPES = Object.freeze(['warm-serif', 'clean-sans', 'classic']);
export const THEME_BUTTONS = Object.freeze(['pill', 'rounded', 'square']);
export const THEME_MOODS = Object.freeze(['light', 'dark', 'brand']);

// save_site may touch these and nothing else (contract section 10).
export const SITE_PATCH_KEYS = Object.freeze(['theme', 'nav', 'footer', 'seo', 'settings', 'slug']);
export const PAGE_PATCH_KEYS = Object.freeze(['slug', 'title', 'kind', 'layout', 'seo', 'sort_order', 'status', 'location_id']);
export const POST_PATCH_KEYS = Object.freeze(['slug', 'title', 'excerpt', 'body_md', 'cover_url', 'author', 'tags', 'status']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_COLOUR_RE = /^#[0-9a-fA-F]{6}$/;

export function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Bytes of the JSON form. TextEncoder exists in Deno, browsers and Node. */
export function jsonBytes(v) {
  try { return new TextEncoder().encode(JSON.stringify(v ?? null)).length; } catch { return Infinity; }
}

// ── Slugs ─────────────────────────────────────────────────────────────────────────────────

/** '' when the site slug is fine, else the plain reason. */
export function siteSlugProblem(slug) {
  if (typeof slug !== 'string') return 'Site address must be text.';
  if (!SITE_SLUG_RE.test(slug)) return 'Site address must be 3 to 40 lower case letters, numbers or hyphens, with no hyphen at either end.';
  if (RESERVED_SITE_SLUGS.includes(slug)) return `The address "${slug}" is reserved. Pick another.`;
  return '';
}

/** '' when the page slug is fine for that kind, else the plain reason. */
export function pageSlugProblem(slug, kind = 'custom') {
  if (typeof slug !== 'string') return 'Page address must be text.';
  if (slug === '') return kind === 'home' ? '' : 'Only the home page can have an empty address.';
  if (!PAGE_SLUG_RE.test(slug)) return 'Page address must be 1 to 60 lower case letters, numbers or hyphens.';
  if (slug === 'blog' && kind === 'blog') return '';
  if (RESERVED_PAGE_SLUGS.includes(slug)) return `The address "${slug}" is used by the site itself. Pick another.`;
  return '';
}

/** '' when the post slug is fine, else the plain reason. */
export function postSlugProblem(slug) {
  if (typeof slug !== 'string' || slug === '') return 'Post address is needed.';
  if (!PAGE_SLUG_RE.test(slug)) return 'Post address must be 1 to 60 lower case letters, numbers or hyphens.';
  return '';
}

/** A slug from free text: "Mozz Pizza, Leeds!" -> "mozz-pizza-leeds". '' when nothing is left. */
export function slugify(text, max = 40) {
  const s = String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/g, '');
}

// ── Layout (Puck data) ────────────────────────────────────────────────────────────────────

// One prop against its rule. The registry (schema.js) writes rules as
//   { type, default, label?, hint?, max?, min?, options? (enum), item? (array), fields? (object) }
// and the contract header names `enum` and `required`; both spellings are read here so the two
// files can never disagree about what a valid patch is. 'text' and 'href' are strings.
function propProblem(blockType, name, rule, value) {
  const where = `${blockType}.${name}`;
  if (value === undefined || value === null) return rule.required ? `${where} is required.` : '';
  switch (rule.type) {
    case 'string':
    case 'text':
    case 'href':
    case 'location': // 5.12.8: the venue picker ('default', 'all' or a venue id) is a string
      if (typeof value !== 'string') return `${where} must be text.`;
      if (rule.max && value.length > rule.max) return `${where} is longer than ${rule.max} characters.`;
      return '';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${where} must be a number.`;
      if (rule.max !== undefined && value > rule.max) return `${where} is above ${rule.max}.`;
      if (rule.min !== undefined && value < rule.min) return `${where} is below ${rule.min}.`;
      return '';
    case 'boolean':
      return typeof value === 'boolean' ? '' : `${where} must be true or false.`;
    case 'enum': {
      const choices = Array.isArray(rule.enum) ? rule.enum : (Array.isArray(rule.options) ? rule.options : []);
      return choices.includes(value) ? '' : `${where} must be one of: ${choices.join(', ')}.`;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${where} must be a list.`;
      if (rule.max && value.length > rule.max) return `${where} has more than ${rule.max} entries.`;
      const item = isPlainObject(rule.item) ? rule.item : null;
      if (item) {
        for (let i = 0; i < value.length; i++) {
          const why = item.type === 'object' && isPlainObject(item.fields)
            ? objectProblem(`${where}[${i + 1}]`, item.fields, value[i])
            : propProblem(blockType, `${name}[${i + 1}]`, item, value[i]);
          if (why) return why;
        }
      }
      return '';
    }
    case 'object':
      if (!isPlainObject(value)) return `${where} must be an object.`;
      return isPlainObject(rule.fields) ? objectProblem(where, rule.fields, value) : '';
    default:
      return '';
  }
}

/** A fixed shape object: every field checked, unknown fields refused. '' when fine. */
function objectProblem(where, fields, value) {
  if (!isPlainObject(value)) return `${where} must be an object.`;
  for (const [k, rule] of Object.entries(fields)) {
    if (!isPlainObject(rule)) continue;
    const why = propProblem(where, k, rule, value[k]);
    if (why) return why;
  }
  for (const k of Object.keys(value)) if (!(k in fields)) return `${where} has no setting called "${k}".`;
  return '';
}

/**
 * Validate one page layout: Puck shape { root:{props:{}}, content:[{type, props:{id,...}}] }.
 * `schemas` is BLOCK_SCHEMAS when the caller has it; without it only the contract type list
 * and generic shape and size rules apply. `allowCustomCode` false refuses CustomHtml.
 * Returns { ok, errors:[plain English] }.
 */
export function validateLayout(layout, { schemas = null, allowCustomCode = false } = {}) {
  const errors = [];
  if (!isPlainObject(layout)) return { ok: false, errors: ['Layout must be an object with root and content.'] };
  const bytes = jsonBytes(layout);
  if (bytes > LIMITS.LAYOUT_MAX_BYTES) errors.push(`Layout is ${Math.round(bytes / 1024)} KB, the limit is ${LIMITS.LAYOUT_MAX_BYTES / 1024} KB.`);
  if (layout.root !== undefined && !isPlainObject(layout.root)) errors.push('Layout root must be an object.');
  if (isPlainObject(layout.root) && layout.root.props !== undefined && !isPlainObject(layout.root.props)) errors.push('Layout root.props must be an object.');
  if (!Array.isArray(layout.content)) {
    errors.push('Layout content must be a list of blocks.');
    return { ok: false, errors };
  }
  if (layout.content.length > LIMITS.MAX_BLOCKS_PER_PAGE) errors.push(`A page can hold at most ${LIMITS.MAX_BLOCKS_PER_PAGE} blocks.`);
  const known = schemas && isPlainObject(schemas) ? Object.keys(schemas) : CONTRACT_BLOCK_TYPES;
  const seenIds = new Set();
  let heroes = 0;
  layout.content.forEach((block, i) => {
    const at = `Block ${i + 1}`;
    if (!isPlainObject(block)) { errors.push(`${at} is not an object.`); return; }
    const type = block.type;
    if (typeof type !== 'string' || !known.includes(type)) { errors.push(`${at}: unknown block type "${String(type)}".`); return; }
    if (type === 'CustomHtml' && !allowCustomCode) errors.push(`${at}: custom code is switched off for this site.`);
    if (type === 'Hero') heroes += 1;
    const props = block.props;
    if (!isPlainObject(props)) { errors.push(`${at} (${type}): props must be an object.`); return; }
    if (typeof props.id !== 'string' || !props.id) errors.push(`${at} (${type}): props.id is required.`);
    else if (seenIds.has(props.id)) errors.push(`${at} (${type}): props.id "${props.id}" is used twice on this page.`);
    else seenIds.add(props.id);
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === 'string' && v.length > LIMITS.MAX_STRING) errors.push(`${at} (${type}): ${k} is longer than ${LIMITS.MAX_STRING / 1024} KB.`);
    }
    const schema = schemas && isPlainObject(schemas[type]) && isPlainObject(schemas[type].props) ? schemas[type].props : null;
    if (schema) {
      for (const [name, rule] of Object.entries(schema)) {
        if (!isPlainObject(rule)) continue;
        const why = propProblem(type, name, rule, props[name]);
        if (why) errors.push(`${at}: ${why}`);
      }
      for (const name of Object.keys(props)) {
        if (name !== 'id' && !(name in schema)) errors.push(`${at}: ${type} has no setting called "${name}".`);
      }
    }
  });
  if (heroes > 1) errors.push('A page can have one Hero block, this one has ' + heroes + '.');
  return { ok: errors.length === 0, errors };
}

// ── Site level objects ────────────────────────────────────────────────────────────────────

function strProblem(where, v, max = LIMITS.MAX_STRING, { allowNull = true } = {}) {
  if (v === undefined || (v === null && allowNull)) return '';
  if (typeof v !== 'string') return `${where} must be text.`;
  if (v.length > max) return `${where} is longer than ${max} characters.`;
  return '';
}

export function themeProblems(theme) {
  const errors = [];
  if (theme === undefined) return errors;
  if (!isPlainObject(theme)) return ['Theme must be an object.'];
  const check = (k, list) => { if (theme[k] !== undefined && theme[k] !== null && !list.includes(theme[k])) errors.push(`Theme ${k} must be one of: ${list.join(', ')}.`); };
  check('layout', THEME_LAYOUTS); check('type', THEME_TYPES); check('buttons', THEME_BUTTONS); check('mood', THEME_MOODS);
  if (theme.brand_color !== undefined && theme.brand_color !== null && !(typeof theme.brand_color === 'string' && HEX_COLOUR_RE.test(theme.brand_color))) {
    errors.push('Theme brand_color must be a hex colour like #15C26A, or null to follow the venue branding.');
  }
  for (const k of Object.keys(theme)) {
    if (!['layout', 'type', 'buttons', 'mood', 'brand_color'].includes(k)) errors.push(`Theme has no setting called "${k}".`);
  }
  return errors;
}

export function navProblems(nav) {
  const errors = [];
  if (nav === undefined) return errors;
  if (!Array.isArray(nav)) return ['Nav must be a list.'];
  if (nav.length > LIMITS.MAX_NAV_ITEMS) errors.push(`Nav can hold at most ${LIMITS.MAX_NAV_ITEMS} items.`);
  nav.forEach((item, i) => {
    const at = `Nav item ${i + 1}`;
    if (!isPlainObject(item)) { errors.push(`${at} is not an object.`); return; }
    if (typeof item.label !== 'string' || !item.label.trim()) errors.push(`${at} needs a label.`);
    else if (item.label.length > 60) errors.push(`${at} label is longer than 60 characters.`);
    if (item.kind !== 'page' && item.kind !== 'link') errors.push(`${at} kind must be page or link.`);
    if (item.kind === 'page' && typeof item.page_id !== 'string') errors.push(`${at} needs a page_id.`);
    if (item.kind === 'link') {
      if (typeof item.href !== 'string' || !item.href.trim()) errors.push(`${at} needs an href.`);
      else if (item.href.length > 2048) errors.push(`${at} href is longer than 2048 characters.`);
    }
  });
  return errors;
}

export function footerProblems(footer) {
  if (footer === undefined) return [];
  if (!isPlainObject(footer)) return ['Footer must be an object.'];
  const errors = [];
  for (const k of ['text', 'instagram', 'facebook', 'email', 'phone']) errors.push(strProblem(`Footer ${k}`, footer[k], 2048));
  if (footer.show_powered_by !== undefined && typeof footer.show_powered_by !== 'boolean') errors.push('Footer show_powered_by must be true or false.');
  if (footer.links !== undefined) {
    if (!Array.isArray(footer.links)) errors.push('Footer links must be a list.');
    else footer.links.forEach((l, i) => {
      if (!isPlainObject(l) || typeof l.label !== 'string' || typeof l.href !== 'string') errors.push(`Footer link ${i + 1} needs a label and an href.`);
    });
  }
  return errors.filter(Boolean);
}

export function seoProblems(seo, { page = false } = {}) {
  if (seo === undefined) return [];
  if (!isPlainObject(seo)) return ['SEO must be an object.'];
  const errors = [
    strProblem('SEO title', seo.title, 200),
    strProblem('SEO description', seo.description, 500),
    strProblem('SEO og_image_url', seo.og_image_url, 2048),
  ];
  if (!page) {
    errors.push(strProblem('SEO google_site_verification', seo.google_site_verification, 200));
    errors.push(strProblem('SEO locale', seo.locale, 20));
    if (seo.keywords !== undefined && seo.keywords !== null) {
      if (!Array.isArray(seo.keywords) || seo.keywords.length > 30 || !seo.keywords.every((k) => typeof k === 'string' && k.length <= 60)) errors.push('SEO keywords must be a list of up to 30 short words.');
    }
  } else if (seo.noindex !== undefined && typeof seo.noindex !== 'boolean') errors.push('SEO noindex must be true or false.');
  return errors.filter(Boolean);
}

export function settingsProblems(settings) {
  if (settings === undefined) return [];
  if (!isPlainObject(settings)) return ['Settings must be an object.'];
  const errors = [];
  for (const k of ['allow_custom_code', 'nearest_store']) {
    if (settings[k] !== undefined && typeof settings[k] !== 'boolean') errors.push(`Settings ${k} must be true or false.`);
  }
  errors.push(strProblem('Settings custom_head_html', settings.custom_head_html, LIMITS.MAX_STRING));
  if (settings.default_location_id !== undefined && settings.default_location_id !== null && !isUuid(settings.default_location_id)) errors.push('Settings default_location_id must be a location id.');
  if (settings.order_mode !== undefined && settings.order_mode !== null && !['embed', 'link'].includes(settings.order_mode)) errors.push('Settings order_mode must be embed or link.');
  if (settings.channels !== undefined && !isPlainObject(settings.channels)) errors.push('Settings channels must be an object of switches.');
  if (settings.geo !== undefined && !isPlainObject(settings.geo)) errors.push('Settings geo must be an object.');
  if (settings.publish_terms !== undefined && settings.publish_terms !== null && !isPlainObject(settings.publish_terms)) errors.push('Settings publish_terms must be an object.');
  if (settings.cuisine !== undefined) errors.push(strProblem('Settings cuisine', settings.cuisine, 120));
  if (settings.price_range !== undefined) errors.push(strProblem('Settings price_range', settings.price_range, 10));
  // 5.12.8: the header options the owner sets in Back Office (brand mark, header button, sticky).
  if (settings.header !== undefined && settings.header !== null) {
    if (!isPlainObject(settings.header)) errors.push('Settings header must be an object.');
    else {
      const h = settings.header;
      if (h.brand !== undefined && !HEADER_BRANDS.includes(h.brand)) errors.push(`Settings header brand must be one of: ${HEADER_BRANDS.join(', ')}.`);
      if (h.cta !== undefined && !HEADER_CTAS.includes(h.cta)) errors.push(`Settings header cta must be one of: ${HEADER_CTAS.join(', ')}.`);
      if (h.sticky !== undefined && typeof h.sticky !== 'boolean') errors.push('Settings header sticky must be true or false.');
      for (const k of Object.keys(h)) if (!['brand', 'cta', 'sticky'].includes(k)) errors.push(`Settings header has no option called "${k}".`);
    }
  }
  return errors.filter(Boolean);
}

/** The settings keys that let script run on every visitor's page. Owner only (contract sections 1 and 4.8). */
export const CUSTOM_CODE_KEYS = Object.freeze(['allow_custom_code', 'custom_head_html']);

/** Does a settings patch touch the custom code switch or the head HTML? */
export function touchesCustomCode(settings) {
  if (!isPlainObject(settings)) return false;
  return CUSTOM_CODE_KEYS.some((k) => k in settings);
}

/**
 * May this caller change custom code? The owner of the business, a super admin or the service role.
 * A manager or shift lead who holds a user_locations row for one venue may edit pages, never inject
 * script into every visitor's page.
 */
export function mayChangeCustomCode(caller) {
  if (!caller || typeof caller !== 'object') return false;
  return caller.service === true || caller.superAdmin === true || caller.role === 'owner';
}

/**
 * The save_site patch: only SITE_PATCH_KEYS, each checked. Returns { ok, errors, clean }.
 * `clean` holds the accepted keys only (never the whole body).
 */
export function validateSitePatch(patch) {
  if (!isPlainObject(patch)) return { ok: false, errors: ['Patch must be an object.'], clean: {} };
  const errors = [];
  const clean = {};
  for (const k of Object.keys(patch)) {
    if (!SITE_PATCH_KEYS.includes(k)) { errors.push(`Site has no setting called "${k}".`); continue; }
    clean[k] = patch[k];
  }
  if ('slug' in clean) { const why = siteSlugProblem(clean.slug); if (why) errors.push(why); }
  errors.push(...themeProblems(clean.theme), ...navProblems(clean.nav), ...footerProblems(clean.footer), ...seoProblems(clean.seo), ...settingsProblems(clean.settings));
  if (jsonBytes(clean) > LIMITS.LAYOUT_MAX_BYTES) errors.push('Site settings are too large to save.');
  return { ok: errors.length === 0, errors, clean };
}

/** The save_page patch. `existingKind` is the stored kind when the patch leaves kind out. */
export function validatePagePatch(patch, { schemas = null, allowCustomCode = false, existingKind = 'custom', isNew = false } = {}) {
  if (!isPlainObject(patch)) return { ok: false, errors: ['Patch must be an object.'], clean: {} };
  const errors = [];
  const clean = {};
  for (const k of Object.keys(patch)) {
    if (!PAGE_PATCH_KEYS.includes(k)) { errors.push(`Page has no setting called "${k}".`); continue; }
    clean[k] = patch[k];
  }
  const kind = clean.kind !== undefined ? clean.kind : existingKind;
  if (clean.kind !== undefined && !PAGE_KINDS.includes(clean.kind)) errors.push(`Page kind must be one of: ${PAGE_KINDS.join(', ')}.`);
  if (isNew && clean.slug === undefined) errors.push('A new page needs an address (slug).');
  if (isNew && (typeof clean.title !== 'string' || !clean.title.trim())) errors.push('A new page needs a title.');
  if (clean.slug !== undefined) { const why = pageSlugProblem(clean.slug, kind); if (why) errors.push(why); }
  if (clean.title !== undefined) { const why = strProblem('Page title', clean.title, 200, { allowNull: false }); if (why) errors.push(why); else if (!clean.title.trim()) errors.push('Page title cannot be empty.'); }
  if (clean.layout !== undefined) { const r = validateLayout(clean.layout, { schemas, allowCustomCode }); errors.push(...r.errors); }
  errors.push(...seoProblems(clean.seo, { page: true }));
  if (clean.sort_order !== undefined && !(Number.isInteger(clean.sort_order) && clean.sort_order >= 0 && clean.sort_order <= 10000)) errors.push('Page sort_order must be a whole number from 0 to 10000.');
  if (clean.status !== undefined && !PAGE_STATUSES.includes(clean.status)) errors.push('Page status must be draft or published.');
  if (clean.location_id !== undefined && clean.location_id !== null && !isUuid(clean.location_id)) errors.push('Page location_id must be a location id.');
  if (kind === 'location' && clean.location_id === null) errors.push('A location page needs a location_id.');
  return { ok: errors.length === 0, errors, clean };
}

/** The save_post patch. */
export function validatePostPatch(patch, { isNew = false } = {}) {
  if (!isPlainObject(patch)) return { ok: false, errors: ['Patch must be an object.'], clean: {} };
  const errors = [];
  const clean = {};
  for (const k of Object.keys(patch)) {
    if (!POST_PATCH_KEYS.includes(k)) { errors.push(`Post has no setting called "${k}".`); continue; }
    clean[k] = patch[k];
  }
  if (isNew && (typeof clean.title !== 'string' || !clean.title.trim())) errors.push('A new post needs a title.');
  if (isNew && clean.slug === undefined && typeof clean.title === 'string') clean.slug = slugify(clean.title, 60) || `post-${Date.now()}`;
  if (clean.slug !== undefined) { const why = postSlugProblem(clean.slug); if (why) errors.push(why); }
  if (clean.title !== undefined) { const why = strProblem('Post title', clean.title, 200, { allowNull: false }); if (why) errors.push(why); else if (!clean.title.trim()) errors.push('Post title cannot be empty.'); }
  for (const k of ['excerpt', 'cover_url', 'author']) errors.push(strProblem(`Post ${k}`, clean[k], 2048));
  errors.push(strProblem('Post body', clean.body_md, LIMITS.MAX_STRING * 4, { allowNull: false }));
  if (clean.tags !== undefined && clean.tags !== null) {
    if (!Array.isArray(clean.tags) || clean.tags.length > LIMITS.MAX_TAGS || !clean.tags.every((t) => typeof t === 'string' && t.length <= 40)) errors.push(`Post tags must be a list of up to ${LIMITS.MAX_TAGS} short words.`);
  }
  if (clean.status !== undefined && !POST_STATUSES.includes(clean.status)) errors.push('Post status must be draft or published.');
  return { ok: errors.filter(Boolean).length === 0, errors: errors.filter(Boolean), clean };
}

/**
 * The AI designer patch (contract section 11):
 *   { reply, theme?, nav?, footer?, seo?, pages?:[{slug,title,kind,seo,layout}], delete_pages?:[slug],
 *     posts?:[{slug,title,excerpt,body_md,tags}] }
 * Returns { ok, errors, clean } with clean holding only accepted keys.
 */
export function validateAiPatch(patch, { schemas = null, allowCustomCode = false, existingPageCount = 0, existingPostCount = 0 } = {}) {
  if (!isPlainObject(patch)) return { ok: false, errors: ['Patch must be an object.'], clean: {} };
  const errors = [];
  const clean = {};
  const allowed = ['reply', 'theme', 'nav', 'footer', 'seo', 'pages', 'delete_pages', 'posts'];
  for (const k of Object.keys(patch)) {
    if (!allowed.includes(k)) { errors.push(`Patch has no key called "${k}".`); continue; }
    clean[k] = patch[k];
  }
  if (clean.reply !== undefined && typeof clean.reply !== 'string') errors.push('Patch reply must be text.');
  errors.push(...themeProblems(clean.theme), ...navProblems(clean.nav), ...footerProblems(clean.footer), ...seoProblems(clean.seo));
  const pageSlugs = new Set();
  if (clean.pages !== undefined) {
    if (!Array.isArray(clean.pages)) errors.push('Patch pages must be a list.');
    else {
      if (existingPageCount + clean.pages.length > LIMITS.MAX_PAGES) errors.push(`A site can hold at most ${LIMITS.MAX_PAGES} pages.`);
      clean.pages.forEach((p, i) => {
        const at = `Page ${i + 1}`;
        if (!isPlainObject(p)) { errors.push(`${at} is not an object.`); return; }
        if (typeof p.slug !== 'string') { errors.push(`${at} needs an address (slug).`); return; }
        if (pageSlugs.has(p.slug)) errors.push(`${at}: the address "${p.slug}" appears twice in the patch.`);
        pageSlugs.add(p.slug);
        const r = validatePagePatch({ slug: p.slug, title: p.title, kind: p.kind ?? 'custom', layout: p.layout ?? { content: [], root: { props: {} } }, ...(p.seo !== undefined ? { seo: p.seo } : {}), ...(p.status !== undefined ? { status: p.status } : {}), ...(p.location_id !== undefined ? { location_id: p.location_id } : {}), ...(p.sort_order !== undefined ? { sort_order: p.sort_order } : {}) }, { schemas, allowCustomCode, isNew: true });
        errors.push(...r.errors.map((e) => `${at} (${p.slug || 'home'}): ${e}`));
        for (const k of Object.keys(p)) if (!['slug', 'title', 'kind', 'seo', 'layout', 'status', 'location_id', 'sort_order'].includes(k)) errors.push(`${at}: pages have no key called "${k}".`);
      });
    }
  }
  if (clean.delete_pages !== undefined) {
    if (!Array.isArray(clean.delete_pages) || !clean.delete_pages.every((s) => typeof s === 'string')) errors.push('Patch delete_pages must be a list of page addresses.');
    else clean.delete_pages.forEach((s) => { if (s === '') errors.push('The home page cannot be deleted.'); });
  }
  if (clean.posts !== undefined) {
    if (!Array.isArray(clean.posts)) errors.push('Patch posts must be a list.');
    else {
      if (existingPostCount + clean.posts.length > LIMITS.MAX_POSTS) errors.push(`A site can hold at most ${LIMITS.MAX_POSTS} posts.`);
      clean.posts.forEach((p, i) => {
        const r = validatePostPatch(p, { isNew: true });
        errors.push(...r.errors.map((e) => `Post ${i + 1}: ${e}`));
      });
    }
  }
  if (jsonBytes(clean) > LIMITS.LAYOUT_MAX_BYTES * 4) errors.push('The patch is too large to apply in one go.');
  return { ok: errors.length === 0, errors, clean };
}

// ── Domains (contract section 3) ──────────────────────────────────────────────────────────

// ── Which company (pure) ──────────────────────────────────────────────────────────────────
// 1 Nov 2026 (5.12.1): a login that manages several companies (Peter, a group owner) hit
// "Say which one (company_id)" on the first open, because the Back Office never said which
// venue it was open on. The client now sends location_id (the Ops venue it shows) and the
// server maps it to that venue's company. The body's company_id still works as an explicit pick.
/**
 * pickCompany(caller, { wanted, locationCompanies }) → { companyId } | { problem, status }.
 *   caller: { companyIds, superAdmin, service }
 *   wanted: body.company_id (an explicit pick), locationCompanies: the companies the body's
 *   location_id maps to (0, 1 or more; [] when no location_id was sent).
 */
export function pickCompany(caller, { wanted = '', locationCompanies = [] } = {}) {
  const ids = Array.isArray(caller?.companyIds) ? caller.companyIds.filter(Boolean) : [];
  const trusted = Boolean(caller?.service || caller?.superAdmin);
  const want = typeof wanted === 'string' && wanted.trim() ? wanted.trim() : '';
  const fromLoc = [...new Set((Array.isArray(locationCompanies) ? locationCompanies : []).filter(Boolean))];
  if (want) {
    if (trusted || ids.includes(want)) return { companyId: want };
    return { problem: 'This login does not manage that company.', status: 403 };
  }
  if (fromLoc.length === 1 && (trusted || ids.includes(fromLoc[0]))) return { companyId: fromLoc[0] };
  if (trusted) {
    if (ids.length === 1) return { companyId: ids[0] };
    return { problem: 'company_id is needed for this login.', status: 400 };
  }
  if (ids.length === 1) return { companyId: ids[0] };
  if (fromLoc.length === 1) return { problem: 'This login does not manage the company of the venue it is open on.', status: 403 };
  return { problem: 'This login manages more than one company. Say which one (company_id).', status: 400, companies: ids };
}

// ── Publishing terms (5.12.1) ─────────────────────────────────────────────────────────────
// Before a site goes live the owner accepts the publishing terms (accessibility and disability
// standards, content, law, intellectual property, domains, liability). The publish action
// refuses (428) until the body carries accept_terms equal to the current version or the site
// already recorded that version. The record lives in settings.publish_terms and is written by
// the publish action only: save_site strips the key so a browser copy can never change it.
export const PUBLISH_TERMS_VERSION = '2026-10-31';

/** True when the site's settings record acceptance of the CURRENT terms version. */
export function publishTermsAccepted(settings, version = PUBLISH_TERMS_VERSION) {
  const rec = isPlainObject(settings) && isPlainObject(settings.publish_terms) ? settings.publish_terms : null;
  return Boolean(rec && rec.version === version && typeof rec.accepted_at === 'string' && rec.accepted_at);
}

/** The record the publish action stores. */
export function publishTermsRecord({ userId = null, role = null, now = new Date() } = {}, version = PUBLISH_TERMS_VERSION) {
  return { version, accepted_at: new Date(now).toISOString(), accepted_by: userId, role };
}

export const WEBSITE_CNAME_TARGET = 'sites.serv-os.app';
export const WEBSITE_APEX_A = '76.76.21.21';
export const FREE_HOST_SUFFIX = '.sites.serv-os.app';
// Hosts the builder must never take as a custom domain: they are ours or Vercel's.
const OUR_SUFFIXES = ['serv-os.app', 'servos.app', 'pos-up.com', 'vercel.app', 'localhost'];
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A hostname from whatever the owner typed: "https://WWW.MozzPizza.com/menu" -> "www.mozzpizza.com".
 * Returns null when it is not a usable public hostname.
 */
export function normaliseHostname(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].split('@').pop().split(':')[0].replace(/\.$/, '');
  if (!s || s.length > 253) return null;
  const labels = s.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL_RE.test(l))) return null;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return null;
  if (OUR_SUFFIXES.some((suf) => s === suf || s.endsWith('.' + suf))) return null;
  return s;
}

/** mozzpizza.com for www.mozzpizza.com, else null (only www gets an apex redirect). */
export function apexFor(host) {
  const h = normaliseHostname(host);
  if (!h || !h.startsWith('www.')) return null;
  const rest = h.slice(4);
  return rest.split('.').length >= 2 ? rest : null;
}

/**
 * The DNS records the venue adds, each with ok:false until checked.
 * www host: CNAME www + A @. Any other host: one CNAME for that name.
 */
export function buildDomainRecords(customDomain) {
  const host = normaliseHostname(customDomain);
  if (!host) return [];
  const apex = apexFor(host);
  if (apex) {
    return [
      { type: 'CNAME', name: 'www', host, value: WEBSITE_CNAME_TARGET, ok: false },
      { type: 'A', name: '@', host: apex, value: WEBSITE_APEX_A, ok: false },
    ];
  }
  return [{ type: 'CNAME', name: host, host, value: WEBSITE_CNAME_TARGET, ok: false }];
}

export const DNS_TYPE_CODES = Object.freeze({ A: 1, CNAME: 5, TXT: 16 });

/**
 * The answers in a dns.google/resolve reply, for one record type, lower case and without the
 * trailing dot. Anything odd gives []. TXT data arrives quoted: the quotes are removed.
 */
export function parseDnsAnswer(json, type) {
  if (!isPlainObject(json) || !Array.isArray(json.Answer)) return [];
  const want = DNS_TYPE_CODES[type];
  return json.Answer
    .filter((a) => isPlainObject(a) && (want === undefined || a.type === want) && typeof a.data === 'string')
    .map((a) => a.data.trim().replace(/^"|"$/g, '').toLowerCase().replace(/\.$/, ''));
}

/** Does the live DNS satisfy this record? Case and trailing dots do not matter. */
export function recordSatisfied(record, answers) {
  if (!isPlainObject(record) || !Array.isArray(answers)) return false;
  const want = String(record.value || '').toLowerCase().replace(/\.$/, '');
  return answers.some((a) => String(a).toLowerCase().replace(/\.$/, '') === want);
}

/**
 * Vercel's domain add reply may carry verification: [{type:'TXT', domain:'_vercel.x.com', value:'vc-domain-verify=...'}].
 * Those become TXT records in our list so the owner sees them.
 */
export function txtRecordsFromVercel(verification) {
  if (!Array.isArray(verification)) return [];
  return verification
    .filter((v) => isPlainObject(v) && String(v.type || '').toUpperCase() === 'TXT' && typeof v.domain === 'string' && typeof v.value === 'string')
    .map((v) => ({ type: 'TXT', name: v.domain, host: v.domain, value: v.value, ok: false }));
}

/**
 * One domain_status from the pieces (contract section 2):
 *   records   the list with ok set
 *   ssl       'none' | 'pending' | 'active'
 *   error     plain English or ''
 * state: error > pending (a record not ok) > verified (records ok, ssl not active) > live.
 */
export function domainStatusFrom({ records = [], ssl = 'none', error = '', checkedAt = new Date().toISOString(), vercel = null } = {}) {
  const recs = Array.isArray(records) ? records : [];
  let state = 'none';
  if (recs.length) {
    const allOk = recs.every((r) => r.ok === true);
    if (!allOk) state = 'pending';
    else state = ssl === 'active' ? 'live' : 'verified';
  }
  if (error) state = 'error';
  const out = { state, records: recs, ssl, checked_at: checkedAt };
  if (error) out.error = String(error);
  if (vercel) out.vercel = vercel;
  return out;
}

/** 'active' | 'pending' | 'none' from GET /v9/projects/{id}/domains/{name}/config and the domain row. */
export function sslStateFrom(config, domainRow = null) {
  // Vercel issues certificates once the domain is verified and DNS points at it.
  if (isPlainObject(config)) {
    if (config.misconfigured === false) return 'active';
    if (config.misconfigured === true) return 'pending';
  }
  if (isPlainObject(domainRow) && domainRow.verified === true) return 'pending';
  return 'none';
}

// ── Preview tokens (HMAC SHA-256, hex) ────────────────────────────────────────────────────

const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** `<site_id>.<expiry ms>.<hex>`; expiry is 30 minutes from `now` by default. */
export async function signPreviewToken(siteId, secret, { now = Date.now(), ttlMs = LIMITS.PREVIEW_TOKEN_MS } = {}) {
  if (!isUuid(siteId)) throw new Error('site id needed');
  if (!secret) throw new Error('WEBSITE_PREVIEW_SECRET is not set');
  const exp = now + ttlMs;
  const sig = await hmacHex(secret, `${siteId}.${exp}`);
  return { token: `${siteId}.${exp}.${sig}`, expires_at: new Date(exp).toISOString() };
}

/** { ok, site_id } or { ok:false, reason }. Never throws. */
export async function verifyPreviewToken(token, secret, { now = Date.now() } = {}) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [siteId, expStr, sig] = parts;
    if (!isUuid(siteId) || !/^\d+$/.test(expStr) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'malformed' };
    if (Number(expStr) < now) return { ok: false, reason: 'expired' };
    if (!secret) return { ok: false, reason: 'no_secret' };
    const want = await hmacHex(secret, `${siteId}.${expStr}`);
    // Constant time compare: same length is guaranteed by the regex above.
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0 ? { ok: true, site_id: siteId } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/** The free address for a site slug. */
export function freeHostFor(slug) {
  return `${slug}${FREE_HOST_SUFFIX}`;
}

/** Which site a host names: { custom_domain } | { apex_domain } | { slug } | null. Mirrors web_resolve_host. */
export function hostLookupKey(host) {
  const h = String(host || '').trim().toLowerCase().split(':')[0].replace(/\.$/, '');
  if (!h) return null;
  if (h.endsWith(FREE_HOST_SUFFIX)) {
    const slug = h.slice(0, -FREE_HOST_SUFFIX.length);
    return slug && !slug.includes('.') && SITE_SLUG_RE.test(slug) ? { slug } : null;
  }
  return { host: h };
}
