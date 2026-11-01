// api/_lib/website/schemaToTool.js: the apply_site_patch tool schema the AI designer hands Claude,
// generated from the block registry (src/surfaces/website/blocks/schema.js, agent B) so the model
// can only name blocks and props the renderer knows. One schema, one validator, one tool.
//
// WHY a normaliser: the registry describes props the way Puck fields do (text, number, select with
// options, array of objects) while Claude needs JSON Schema. blockPropsSchema() reads either shape,
// so a registry change does not break the designer, and an unknown field type becomes a loose
// object rather than a crash (the validator still has the last word on the write path).
//
// FALLBACK_BLOCK_SCHEMAS is the contract's own block table (ARCHITECTURE.md section 6). It is used
// only when the registry module is missing (tests, or a build where B's file is not there yet).

export const TOOL_NAME = 'apply_site_patch';
export const NEVER_FOR_AI = ['CustomHtml'];

export const PAGE_KINDS = ['home', 'menu', 'order', 'catering', 'loyalty', 'gift', 'findus', 'blog', 'location', 'custom'];
export const LAYOUTS = ['ember', 'ledger', 'marquee'];
export const TYPE_PAIRINGS = ['warm-serif', 'clean-sans', 'classic'];
export const BUTTON_SHAPES = ['pill', 'rounded', 'square'];
export const MOODS = ['light', 'dark', 'brand'];

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const num = (description) => ({ type: 'number', description });
const link = (description) => ({
  type: 'object', description,
  properties: { label: str('Button words'), href: str('page:<slug>, servos:order|catering|loyalty|gift|book|waitlist, or a full URL') },
  required: ['label', 'href'],
});

// The contract's block table, as plain JSON Schema property maps.
export const FALLBACK_BLOCK_SCHEMAS = {
  Hero: { label: 'Hero', group: 'servos', properties: {
    headline: str('One line, the venue name or what it does'), sub: str('One or two short sentences'),
    photo_url: str('Photo URL; leave empty to use the branding hero photo'), show_status: bool('Show open or closed now'),
    slides: { type: 'array', items: { type: 'object', properties: { photo_url: str(''), headline: str(''), sub: str(''), button_label: str(''), button_href: str('') } } },
    slide_seconds: str('', { enum: ['0', '4', '6', '8', '10'] }),
    primary: link('Main button'), secondary: link('Second button'), height: str('tall or short', { enum: ['tall', 'short'] }),
  } },
  OrderBar: { label: 'Order bar', group: 'servos', properties: { collection: bool(''), delivery: bool(''), book: bool(''), catering: bool('') } },
  LiveMenu: { label: 'Live menu', group: 'servos', properties: {
    menu_id: str("A menu id or 'follow'"), categories: { type: 'array', items: { type: 'string' }, description: "Category ids, or empty for all" },
    layout: str('cards, list or board', { enum: ['cards', 'list', 'board'] }),
    show: { type: 'object', properties: { prices: bool(''), photos: bool(''), descriptions: bool(''), allergens: bool(''), dietary: bool(''), hide_sold_out: bool(''), add_button: bool('') } },
    price_mode: str('collection, dinein or delivery', { enum: ['collection', 'dinein', 'delivery'] }),
    location_id: str("A location id or 'default'"), max_items: num('Cap on items shown'),
  } },
  Specials: { label: 'Specials', group: 'servos', properties: { title: str(''), source: str('tagged or manual', { enum: ['tagged', 'manual'] }), ids: { type: 'array', items: { type: 'string' } } } },
  OrderEmbed: { label: 'Order embed', group: 'servos', properties: { mode: str('online or catering', { enum: ['online', 'catering'] }), location_id: str(''), height: num('') } },
  LoyaltyJoin: { label: 'Loyalty join', group: 'servos', properties: { headline: str(''), sub: str(''), show_card_preview: bool('') } },
  GiftCards: { label: 'Gift cards', group: 'servos', properties: { headline: str(''), sub: str(''), show_art: bool('') } },
  BookTable: { label: 'Book a table', group: 'servos', properties: { location_id: str(''), height: num('') } },
  Waitlist: { label: 'Waitlist', group: 'servos', properties: { location_id: str('') } },
  Hours: { label: 'Opening hours', group: 'servos', properties: { location_id: str("A location id or 'all'"), show_today_first: bool('') } },
  FindUs: { label: 'Find us', group: 'servos', properties: { show_map: bool(''), show_nearest: bool(''), show_hours: bool(''), show_order_buttons: bool(''), cta: str("'order', 'catering' or 'book': what the first button on each venue opens"), location_id: str('Only this location, or empty for all') } },
  Reviews: { label: 'Reviews', group: 'servos', properties: { min_stars: num(''), count: num('') } },
  BlogList: { label: 'Blog list', group: 'servos', properties: { count: num(''), show_excerpt: bool('') } },
  Text: { label: 'Text', group: 'content', properties: { md: str('Markdown text') } },
  Columns: { label: 'Columns', group: 'content', properties: { cols: str('2 or 3', { enum: ['2', '3'] }), items: { type: 'array', items: { type: 'object', properties: { md: str('') } } } } },
  Gallery: { label: 'Gallery', group: 'content', properties: { photos: { type: 'array', items: { type: 'object', properties: { url: str(''), alt: str('') } } }, cols: num('') } },
  Image: { label: 'Image', group: 'content', properties: { url: str('Photo URL (https)'), alt: str(''), caption: str(''), fit: str('cover or contain', { enum: ['cover', 'contain'] }), height: str('', { enum: ['natural', 'short', 'medium', 'tall'] }), width: str('', { enum: ['page', 'wide', 'full'] }), rounded: bool(''), href: str('') } },
  Heading: { label: 'Heading', group: 'content', properties: { text: str(''), level: str('2 or 3', { enum: ['2', '3'] }), align: str('', { enum: ['left', 'center'] }), sub: str('') } },
  Button: { label: 'Button', group: 'content', properties: { label: str(''), href: str(''), style: str('primary or secondary', { enum: ['primary', 'secondary'] }) } },
  FAQ: { label: 'FAQ', group: 'content', properties: { items: { type: 'array', items: { type: 'object', properties: { q: str(''), a: str('') }, required: ['q', 'a'] } } } },
  Instagram: { label: 'Instagram', group: 'content', properties: { handle: str('Without the @') } },
  Divider: { label: 'Divider', group: 'content', properties: {} },
  Spacer: { label: 'Spacer', group: 'content', properties: { size: str('', { enum: ['s', 'm', 'l'] }) } },
};

// Puck style field types to JSON Schema. Unknown types become a free object so the tool still loads.
const FIELD_TYPES = {
  text: 'string', textarea: 'string', markdown: 'string', url: 'string', image: 'string', color: 'string', href: 'string',
  number: 'number', boolean: 'boolean', toggle: 'boolean', checkbox: 'boolean',
};

export function fieldToJsonSchema(field) {
  if (!field || typeof field !== 'object') return { type: 'string' };
  const t = String(field.type || 'text');
  const description = field.hint || field.description || field.label || undefined;
  // The registry's enum (options, possibly aliased as enum for the validator) comes first, so the
  // JSON Schema short cut below does not mistake it for a finished schema.
  // 5.12.8: the registry's venue picker is a string to the AI ('default', 'all' or a venue id).
  if (t === 'location' || t === 'image' || t === 'color' || t === 'menu') return { type: 'string', ...(description ? { description } : {}) };
  if (t === 'categories') return { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } }, ...(description ? { description } : {}) };
  if (t === 'slot') return { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, props: { type: 'object' } }, required: ['type', 'props'] }, description: `${description || 'Blocks inside this block'}: each item is { type, props } like a page block` };
  if (t === 'select' || t === 'radio' || t === 'enum') {
    const options = Array.isArray(field.options) ? field.options.map((o) => (o && typeof o === 'object' ? o.value : o)) : [];
    const allStrings = options.every((v) => typeof v === 'string');
    return { type: allStrings ? 'string' : 'number', ...(options.length ? { enum: options } : {}), ...(description ? { description } : {}) };
  }
  // Already JSON Schema (has properties or items, a plain enum, or anyOf).
  if (field.properties || field.items || field.enum || field.anyOf) return field;
  if (t === 'array') {
    // B's registry says `item` (a field map); Puck says arrayFields.
    const inner = field.item || field.arrayFields || field.fields || field.of || null;
    const items = inner && typeof inner === 'object'
      ? (inner.type && !inner.properties ? fieldToJsonSchema(inner) : { type: 'object', properties: mapFields(inner) })
      : { type: 'string' };
    return { type: 'array', items, ...(description ? { description } : {}) };
  }
  if (t === 'object') {
    const inner = field.objectFields || field.fields || null;
    return { type: 'object', ...(inner ? { properties: mapFields(inner) } : {}), ...(description ? { description } : {}) };
  }
  if (FIELD_TYPES[t]) return { type: FIELD_TYPES[t], ...(description ? { description } : {}) };
  if (['string', 'number', 'boolean', 'integer'].includes(t)) return { type: t, ...(description ? { description } : {}) };
  return { type: 'object', ...(description ? { description } : {}) };
}

function mapFields(fields) {
  const out = {};
  for (const [name, f] of Object.entries(fields || {})) out[name] = fieldToJsonSchema(f);
  return out;
}

/** JSON Schema property map for one block, from either a JSON Schema or a Puck style definition. */
export function blockPropsSchema(def) {
  if (!def || typeof def !== 'object') return {};
  if (def.properties && typeof def.properties === 'object') return def.properties;
  if (def.props && typeof def.props === 'object' && !def.props.type) return mapFields(def.props);
  if (def.fields && typeof def.fields === 'object') return mapFields(def.fields);
  if (def.input_schema?.properties) return def.input_schema.properties;
  return {};
}

/** Pick the block schemas out of whatever the registry module exports. */
export function schemasFromModule(mod) {
  if (!mod) return null;
  const s = mod.BLOCK_SCHEMAS || mod.default?.BLOCK_SCHEMAS || mod.default || null;
  if (!s || typeof s !== 'object') return null;
  const types = Array.isArray(mod.BLOCK_TYPES) ? mod.BLOCK_TYPES : Object.keys(s);
  const out = {};
  // CustomHtml is owner only, off by default, never placed by the AI (contract section 4 and 11).
  for (const t of types) if (s[t] && !NEVER_FOR_AI.includes(t)) out[t] = aliasEnums(s[t]);
  return Object.keys(out).length ? out : null;
}

// The registry writes enum choices as `options`; the validator's import contract reads `enum`.
// Both keys are carried so the same object satisfies the tool builder and the validator.
function aliasEnums(def) {
  if (!def || typeof def !== 'object' || !def.props || typeof def.props !== 'object') return def;
  const props = {};
  for (const [k, f] of Object.entries(def.props)) {
    props[k] = f && typeof f === 'object' && f.type === 'enum' && Array.isArray(f.options) && !f.enum ? { ...f, enum: f.options.slice() } : f;
  }
  return { ...def, props };
}

function blockItemSchema(type, def) {
  const properties = blockPropsSchema(def);
  return {
    type: 'object',
    description: def.label ? `${def.label} block` : `${type} block`,
    properties: {
      type: { type: 'string', enum: [type] },
      // id is Puck's per block key; the validator requires it, the server fills it in when missing.
      props: { type: 'object', properties: { id: { type: 'string', description: 'Unique on the page, e.g. hero-1' }, ...properties }, additionalProperties: false },
    },
    required: ['type', 'props'],
  };
}

const pageSchema = (blockSchemas) => ({
  type: 'object',
  properties: {
    slug: str("Page address: '' for home, else [a-z0-9-]{1,60}. Never 'blog' or 'locations' (the site serves those itself). Location pages use the location's online slug."),
    title: str('Page title shown in the browser tab and nav'),
    kind: str('Page kind', { enum: PAGE_KINDS }),
    location_id: str('Only for kind location: the location id from the facts'),
    status: str('published or draft', { enum: ['published', 'draft'] }),
    brief: str('PLAN MODE only: 4 to 8 lines on what this page shows, section by section, with the exact headline words and which blocks to use. Empty in every other mode.'),
    seo: { type: 'object', properties: { title: str('<= 60 characters, includes the town'), description: str('<= 155 characters: cuisine, town, order online'), og_image_url: str(''), noindex: bool('') } },
    layout: {
      type: 'object',
      properties: {
        root: { type: 'object', properties: { props: { type: 'object' } } },
        content: { type: 'array', items: { anyOf: Object.entries(blockSchemas).map(([t, d]) => blockItemSchema(t, d)) } },
      },
      required: ['content'],
    },
  },
  required: ['slug', 'title', 'kind', 'layout'],
});

/**
 * The one tool the designer may call. blockSchemas: { [type]: def } from the registry (or the fallback).
 */
export function buildPatchTool(blockSchemas = FALLBACK_BLOCK_SCHEMAS) {
  const schemas = Object.fromEntries(Object.entries(blockSchemas && Object.keys(blockSchemas).length ? blockSchemas : FALLBACK_BLOCK_SCHEMAS).filter(([t]) => !NEVER_FOR_AI.includes(t)));
  return {
    name: TOOL_NAME,
    description: 'Apply changes to the venue website. Pages named here replace the existing page of the same slug in full. Leave out what should not change.',
    input_schema: {
      type: 'object',
      properties: {
        reply: str('What you tell the owner: short, plain English, what you did and why'),
        theme: { type: 'object', properties: {
          layout: str('', { enum: LAYOUTS }), type: str('', { enum: TYPE_PAIRINGS }),
          buttons: str('', { enum: BUTTON_SHAPES }), mood: str('', { enum: MOODS }),
          brand_color: { type: ['string', 'null'], description: 'null inherits the branding colour (default)' },
          bg_color: { type: ['string', 'null'], description: 'Page background hex over the mood; null lets the mood decide (default). Set it when the owner asks for a page or site background colour' },
          card_color: { type: ['string', 'null'], description: 'Card background hex; null follows the mood or the page colour' },
          text_color: { type: ['string', 'null'], description: 'Body text hex; null picks ink or paper so it reads; a colour that does not read on the page is nudged' },
        } },
        nav: { type: 'array', items: { type: 'object', properties: {
          label: str('Up to 60 characters'), kind: str("'page' for a site page, 'link' for a URL, 'locations' for a dropdown of every venue page, 'group' for a dropdown of the children listed", { enum: ['page', 'link', 'locations', 'group'] }),
          page_id: str("kind page: the page's slug ('' for home) or its id when the facts give one"), href: str("kind link: a URL or site path such as '/blog'"),
          children: { type: 'array', description: "kind group only: the items in the dropdown", items: { type: 'object', properties: {
            label: str(''), kind: str('', { enum: ['page', 'link'] }), page_id: str(''), href: str(''),
          }, required: ['label', 'kind'] } },
        }, required: ['label', 'kind'] } },
        footer: { type: 'object', properties: { text: str(''), links: { type: 'array', items: { type: 'object', properties: { label: str(''), href: str('') } } }, show_powered_by: bool(''), instagram: str(''), facebook: str(''), email: str(''), phone: str('') } },
        seo: { type: 'object', properties: { title: str('<= 60 characters'), description: str('<= 155 characters'), og_image_url: str(''), locale: str('en-GB or en-US'), keywords: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 30 } } },
        pages: { type: 'array', items: pageSchema(schemas) },
        delete_pages: { type: 'array', items: { type: 'string' }, description: 'Slugs of pages to remove' },
        posts: { type: 'array', items: { type: 'object', properties: {
          slug: str(''), title: str(''), excerpt: str(''), body_md: str('Markdown body'), tags: { type: 'array', items: { type: 'string' } },
          status: str('', { enum: ['draft', 'published'] }),
        }, required: ['slug', 'title', 'body_md'] } },
      },
      required: ['reply'],
    },
  };
}

/** Plain text list of blocks and their props for the system prompt. */
export function describeBlocks(blockSchemas = FALLBACK_BLOCK_SCHEMAS) {
  const schemas = blockSchemas && Object.keys(blockSchemas).length ? blockSchemas : FALLBACK_BLOCK_SCHEMAS;
  const lines = [];
  for (const [type, def] of Object.entries(schemas)) {
    const props = Object.entries(blockPropsSchema(def)).map(([k, v]) => (v && v.enum ? `${k} (${v.enum.join('|')})` : k));
    lines.push(`- ${type}${def.group ? ` [${def.group}]` : ''}: ${props.join(', ') || 'no props'}`);
  }
  return lines.join('\n');
}
