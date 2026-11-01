// src/surfaces/website/blocks/schema.js
//
// THE block registry schema for the website builder (ARCHITECTURE.md section 6). Plain JS, no
// React, no DOM: agent A's validator (src/lib/website/validatePatch.js), agent D's designer tool
// schema (api/website-designer.js), the Puck config (blocks/puckConfig.jsx), the React renderer
// and the SSR renderer all read this one file, so a block added here exists everywhere at once.
//
// Prop types (the small language every consumer understands):
//   string   one line of text            text     paragraphs (markdown allowed where noted)
//   number   finite number               boolean  true/false
//   enum     one of `options`            href     a link: '/path', 'https://…', 'page:<id>',
//                                                 'servos:order|catering|loyalty|gift|book|waitlist'
//   array    list of `item` objects      object   fixed `fields`
// Every prop has a default so defaultPropsFor(type) always gives a complete, renderable block.

const s = (def = '', extra = {}) => ({ type: 'string', default: def, ...extra });
const t = (def = '', extra = {}) => ({ type: 'text', default: def, ...extra });
const n = (def = 0, extra = {}) => ({ type: 'number', default: def, ...extra });
const b = (def = false, extra = {}) => ({ type: 'boolean', default: def, ...extra });
const e = (options, def, extra = {}) => ({ type: 'enum', options, default: def ?? options[0], ...extra });
const h = (def = '', extra = {}) => ({ type: 'href', default: def, ...extra });
const arr = (item, def = [], extra = {}) => ({ type: 'array', item, default: def, ...extra });
const obj = (fields, extra = {}) => ({ type: 'object', fields, default: objectDefault(fields), ...extra });

function objectDefault(fields) {
  const out = {};
  for (const [k, f] of Object.entries(fields)) out[k] = cloneDefault(f);
  return out;
}
function cloneDefault(f) {
  const d = f.default;
  if (Array.isArray(d)) return d.map((x) => (x && typeof x === 'object' ? { ...x } : x));
  if (d && typeof d === 'object') return { ...d };
  return d;
}

// A location picker: 'default' = settings.default_location_id; 'all' where the block allows it.
// 5.12.8: its own field type, so the editor shows a dropdown of the venues (puckFields.js) while
// the stored value stays a string ('default', 'all' or a location id) for the AI and the renderers.
const locationPick = (def = 'default', extra = {}) => ({ type: 'location', default: def, label: 'Venue', hint: "'default' = the site's default venue, 'all' = every venue, or a venue id", ...extra });
const linkObj = (label = '', href = '') => obj({ label: s(label, { label: 'Label' }), href: h(href, { label: 'Link' }) });

export const BLOCK_SCHEMAS = {
  // ── ServOS blocks (live data) ──────────────────────────────────────────────
  Hero: {
    label: 'Hero', group: 'servos',
    props: {
      headline: s('', { label: 'Headline' }),
      sub: t('', { label: 'Sub heading' }),
      photo_url: s('', { label: 'Photo URL', hint: 'Empty = the branding hero photo' }),
      show_status: b(true, { label: 'Show open or closed now' }),
      primary: linkObj('Order now', 'servos:order'),
      secondary: linkObj('See the menu', '/menu'),
      height: e(['tall', 'short'], 'tall', { label: 'Height' }),
    },
  },
  OrderBar: {
    label: 'Order bar', group: 'servos',
    props: {
      collection: b(true, { label: 'Collection' }),
      delivery: b(true, { label: 'Delivery' }),
      book: b(false, { label: 'Book a table' }),
      catering: b(false, { label: 'Catering' }),
    },
  },
  LiveMenu: {
    label: 'Live menu', group: 'servos',
    props: {
      title: s('Menu', { label: 'Heading' }),
      menu_id: s('follow', { label: 'Menu', hint: "'follow' = the menu live right now" }),
      categories: arr({ id: s('', { label: 'Category id' }) }, [], { label: 'Categories', hint: 'Empty = all' }),
      layout: e(['cards', 'list', 'board'], 'cards', { label: 'Layout' }),
      show: obj({
        prices: b(true, { label: 'Prices' }),
        photos: b(true, { label: 'Photos' }),
        descriptions: b(true, { label: 'Descriptions' }),
        allergens: b(false, { label: 'Allergen words' }),
        dietary: b(true, { label: 'Dietary badges' }),
        hide_sold_out: b(false, { label: 'Hide sold out' }),
        add_button: b(false, { label: 'Order button on each item' }),
      }, { label: 'Show' }),
      price_mode: e(['collection', 'dinein', 'delivery'], 'collection', { label: 'Price shown' }),
      location_id: locationPick('default'),
      // 5.12.8 (Peter, 1 Nov): on a site with several venues the visitor picks whose menu to see.
      // Buttons or a dropdown above the menu; 'none' hides it. A block pinned to one venue never shows it.
      venue_switch: e(['buttons', 'dropdown', 'none'], 'buttons', { label: 'Venue switch', hint: 'Several venues: how the visitor picks whose menu to see' }),
      max_items: n(0, { label: 'Max items', hint: '0 = no cap', min: 0, max: 1000 }),
    },
  },
  Specials: {
    label: 'Specials', group: 'servos',
    props: {
      title: s('Specials', { label: 'Heading' }),
      source: e(['tagged', 'manual'], 'tagged', { label: 'Source' }),
      ids: arr({ id: s('', { label: 'Item id' }) }, [], { label: 'Items (manual)' }),
      location_id: locationPick('default'),
    },
  },
  OrderEmbed: {
    label: 'Order online', group: 'servos',
    props: {
      mode: e(['online', 'catering'], 'online', { label: 'Mode' }),
      location_id: locationPick('default'),
      height: n(900, { label: 'Height (px)', min: 400, max: 3000 }),
    },
  },
  LoyaltyJoin: {
    label: 'Loyalty', group: 'servos',
    props: {
      headline: s('Join our loyalty club', { label: 'Headline' }),
      sub: t('Earn rewards every time you visit.', { label: 'Sub heading' }),
      show_card_preview: b(true, { label: 'Show card preview' }),
      location_id: locationPick('default'),
    },
  },
  GiftCards: {
    label: 'Gift cards', group: 'servos',
    props: {
      headline: s('Gift cards', { label: 'Headline' }),
      sub: t('Treat someone. Sent by email in seconds.', { label: 'Sub heading' }),
      show_art: b(true, { label: 'Show card art' }),
      location_id: locationPick('default'),
    },
  },
  BookTable: {
    label: 'Book a table', group: 'servos',
    props: {
      location_id: locationPick('default'),
      height: n(760, { label: 'Height (px)', min: 400, max: 3000 }),
    },
  },
  Waitlist: {
    label: 'Join the waitlist', group: 'servos',
    props: { location_id: locationPick('default') },
  },
  Hours: {
    label: 'Opening hours', group: 'servos',
    props: {
      title: s('Opening hours', { label: 'Heading' }),
      location_id: locationPick('all'),
      show_today_first: b(true, { label: 'Today first' }),
    },
  },
  FindUs: {
    label: 'Find us', group: 'servos',
    props: {
      title: s('Find us', { label: 'Heading' }),
      show_map: b(true, { label: 'Map links' }),
      show_nearest: b(true, { label: 'Nearest shop button' }),
      show_hours: b(true, { label: 'Opening hours' }),
      show_order_buttons: b(true, { label: 'Order buttons' }),
      cta: e(['order', 'catering', 'book'], 'order', { label: 'Main button', hint: 'What the first button on each venue opens' }),
      location_id: locationPick('all'),
    },
  },
  Reviews: {
    label: 'Reviews', group: 'servos',
    props: {
      title: s('What people say', { label: 'Heading' }),
      min_stars: n(4, { label: 'Minimum stars', min: 1, max: 5 }),
      count: n(6, { label: 'How many', min: 1, max: 24 }),
    },
  },
  BlogList: {
    label: 'Latest posts', group: 'servos',
    props: {
      title: s('News', { label: 'Heading' }),
      count: n(3, { label: 'How many', min: 1, max: 50 }),
      show_excerpt: b(true, { label: 'Show excerpt' }),
    },
  },

  // ── Content blocks ─────────────────────────────────────────────────────────
  Text: {
    label: 'Text', group: 'content',
    props: { md: t('', { label: 'Text (markdown)', markdown: true }) },
  },
  Columns: {
    label: 'Columns', group: 'content',
    props: {
      cols: e(['2', '3'], '2', { label: 'Columns' }),
      items: arr({ md: t('', { label: 'Text (markdown)', markdown: true }) }, [{ md: '' }, { md: '' }], { label: 'Columns' }),
    },
  },
  Gallery: {
    label: 'Gallery', group: 'content',
    props: {
      title: s('', { label: 'Heading' }),
      photos: arr({ url: s('', { label: 'Photo URL' }), alt: s('', { label: 'Alt text' }) }, [], { label: 'Photos' }),
      cols: n(3, { label: 'Columns', min: 1, max: 4 }),
    },
  },
  Button: {
    label: 'Button', group: 'content',
    props: {
      label: s('Order now', { label: 'Label' }),
      href: h('servos:order', { label: 'Link' }),
      style: e(['primary', 'secondary', 'link'], 'primary', { label: 'Style' }),
    },
  },
  FAQ: {
    label: 'FAQ', group: 'content',
    props: {
      title: s('Questions', { label: 'Heading' }),
      items: arr({ q: s('', { label: 'Question' }), a: t('', { label: 'Answer', markdown: true }) }, [], { label: 'Questions' }),
    },
  },
  Instagram: {
    label: 'Instagram', group: 'content',
    props: { handle: s('', { label: 'Handle', hint: 'Without the @' }) },
  },
  Divider: { label: 'Divider', group: 'content', props: {} },
  Spacer: {
    label: 'Spacer', group: 'content',
    props: { size: e(['s', 'm', 'l'], 'm', { label: 'Size' }) },
  },
  CustomHtml: {
    label: 'Custom HTML', group: 'content',
    props: { html: t('', { label: 'HTML', hint: 'Owner only. Shown only when custom code is allowed.' }) },
  },
};

export const BLOCK_TYPES = Object.freeze(Object.keys(BLOCK_SCHEMAS));

export const GROUPS = Object.freeze({
  servos: Object.freeze(BLOCK_TYPES.filter((k) => BLOCK_SCHEMAS[k].group === 'servos')),
  content: Object.freeze(BLOCK_TYPES.filter((k) => BLOCK_SCHEMAS[k].group === 'content')),
});

/** True when `type` is a block we know. */
export function isBlockType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(BLOCK_SCHEMAS, type);
}

/** A complete default props object for a block type (fresh copies, safe to mutate). {} for unknown types. */
export function defaultPropsFor(type) {
  const schema = isBlockType(type) ? BLOCK_SCHEMAS[type] : null;
  if (!schema) return {};
  const out = {};
  for (const [k, f] of Object.entries(schema.props)) out[k] = cloneDefault(f);
  return out;
}

// Coerce one value to its prop schema; the default when the value does not fit. Never throws:
// a page saved with an odd value still renders (customer facing never fails).
function coerceValue(f, v) {
  switch (f.type) {
    case 'string': case 'href': case 'location': return typeof v === 'string' ? v : (v == null ? f.default : String(v));
    case 'text': return typeof v === 'string' ? v : f.default;
    case 'number': { const x = Number(v); return Number.isFinite(x) ? x : f.default; }
    case 'boolean': return typeof v === 'boolean' ? v : (v === 'true' ? true : v === 'false' ? false : f.default);
    case 'enum': return f.options.includes(v) ? v : (f.options.includes(String(v)) ? String(v) : f.default);
    case 'array': {
      if (!Array.isArray(v)) return cloneDefault(f);
      return v.filter((x) => x && typeof x === 'object').map((x) => coerceFields(f.item, x));
    }
    case 'object': return coerceFields(f.fields, v && typeof v === 'object' ? v : {});
    default: return v;
  }
}
function coerceFields(fields, v) {
  const out = {};
  for (const [k, f] of Object.entries(fields)) out[k] = coerceValue(f, v ? v[k] : undefined);
  return out;
}

/**
 * Fill and coerce a block's props: unknown keys dropped (id kept), missing keys defaulted,
 * wrong types replaced by the default. The renderers call this so every block sees the full shape.
 */
export function normaliseProps(type, props) {
  const schema = isBlockType(type) ? BLOCK_SCHEMAS[type] : null;
  if (!schema) return { ...(props || {}) };
  const out = coerceFields(schema.props, props || {});
  if (props && typeof props.id === 'string') out.id = props.id;
  return out;
}

/** The blocks of a Puck layout as [{type, props}], unknown types and bad rows dropped. */
export function layoutBlocks(layout) {
  const content = layout && Array.isArray(layout.content) ? layout.content : [];
  return content
    .filter((c) => c && isBlockType(c.type))
    .map((c) => ({ type: c.type, props: normaliseProps(c.type, c.props) }));
}

/**
 * JSON Schema for one block's props (draft 7 subset), for the designer's tool and the validator.
 * `additionalProperties:false` so the model cannot invent props.
 */
export function jsonSchemaFor(type) {
  const schema = isBlockType(type) ? BLOCK_SCHEMAS[type] : null;
  if (!schema) return null;
  return { type: 'object', properties: mapProps(schema.props), additionalProperties: false };
}
function mapProps(fields) {
  const out = { id: { type: 'string' } };
  for (const [k, f] of Object.entries(fields)) out[k] = mapField(f);
  return out;
}
function mapField(f) {
  const desc = f.hint ? { description: f.hint } : {};
  switch (f.type) {
    case 'string': case 'text': case 'href': case 'location': return { type: 'string', ...desc };
    case 'number': return { type: 'number', ...(f.min != null ? { minimum: f.min } : {}), ...(f.max != null ? { maximum: f.max } : {}), ...desc };
    case 'boolean': return { type: 'boolean', ...desc };
    case 'enum': return { type: 'string', enum: f.options.slice(), ...desc };
    case 'array': return { type: 'array', items: { type: 'object', properties: mapPropsNoId(f.item), additionalProperties: false }, ...desc };
    case 'object': return { type: 'object', properties: mapPropsNoId(f.fields), additionalProperties: false, ...desc };
    default: return {};
  }
}
function mapPropsNoId(fields) {
  const out = {};
  for (const [k, f] of Object.entries(fields)) out[k] = mapField(f);
  return out;
}

/** JSON Schema for a whole Puck layout: {root:{props:{}}, content:[oneOf block]}. */
export function layoutJsonSchema() {
  return {
    type: 'object',
    properties: {
      root: { type: 'object', properties: { props: { type: 'object' } } },
      content: {
        type: 'array',
        items: {
          oneOf: BLOCK_TYPES.map((type) => ({
            type: 'object',
            properties: { type: { const: type }, props: jsonSchemaFor(type) },
            required: ['type', 'props'],
            additionalProperties: false,
          })),
        },
      },
    },
    required: ['content'],
  };
}
