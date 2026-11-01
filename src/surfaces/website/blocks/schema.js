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

// 5.12.9 field types the editor turns into pickers (puckFields.js); stored values stay plain:
//   image      a photo URL (the editor uploads and fills it)      → string
//   color      a hex colour like #c8493b, '' = none                → string
//   menu       a menu id, or 'follow' = the menu live right now    → string
//   categories menu category ids to show, [] = all                 → [{ id }]
//   slot       blocks dropped inside this block (Puck slot)        → [{ type, props }]
const img = (def = '', extra = {}) => ({ type: 'image', default: def, ...extra });
const color = (def = '', extra = {}) => ({ type: 'color', default: def, hint: 'A colour like #c8493b. Empty = none', ...extra });
const slot = (extra = {}) => ({ type: 'slot', default: [], ...extra });
export const FIELD_HELPERS = Object.freeze({ s, t, n, b, e, h, arr, obj, img, color, slot });

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
      photo_url: img('', { label: 'Photo', hint: 'Empty = the branding hero photo' }),
      use_photo: b(true, { label: 'Show a photo', hint: 'Off = a plain colour header' }),
      bg_color: color('', { label: 'Background colour', hint: 'Shows when there is no photo' }),
      show_status: b(true, { label: 'Show open or closed now' }),
      primary: linkObj('Order now', 'servos:order'),
      secondary: linkObj('See the menu', '/menu'),
      height: e(['tall', 'short'], 'tall', { label: 'Height' }),
      // 5.12.10: more slides make the hero a slideshow. The fields above are slide 1.
      slides: arr({
        photo_url: img('', { label: 'Photo' }),
        headline: s('', { label: 'Headline' }),
        sub: t('', { label: 'Line under it' }),
        button_label: s('', { label: 'Button label' }),
        button_href: h('', { label: 'Button link' }),
      }, [], { label: 'More slides', hint: 'Add slides to make the hero a slideshow. The fields above are slide 1', max: 9 }),
      slide_seconds: e(['0', '4', '6', '8', '10'], '6', { label: 'Seconds per slide', hint: '0 = no auto play' }),
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
      menu_id: { type: 'menu', default: 'follow', label: 'Menu', hint: "'follow' = the menu live right now, else a menu id" },
      categories: { type: 'categories', default: [], item: { id: s('', { label: 'Category id' }) }, label: 'Categories', hint: 'Empty = all' },
      layout: e(['cards', 'list', 'board'], 'cards', { label: 'Layout' }),
      show: obj({
        prices: b(true, { label: 'Prices' }),
        photos: b(true, { label: 'Photos' }),
        descriptions: b(true, { label: 'Descriptions' }),
        allergens: b(false, { label: 'Allergen words' }),
        dietary: b(true, { label: 'Dietary badges' }),
        hide_sold_out: b(false, { label: 'Hide sold out' }),
        add_button: b(false, { label: 'Order button on each item' }),
        store_finder: b(false, { label: 'Find my local store button', hint: 'Opens your Find us page' }),
      }, { label: 'Show' }),
      button: linkObj('', ''),
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
      button: linkObj('View full menu', '/menu'),
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
      show_book: b(true, { label: 'Book button', hint: 'Only venues that take bookings show it anyway' }),
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
    // 5.12.16 (Peter: "all I want is to add padding left and right so it is not right against
    // the edge of the image"): space either side of the text when it sits in a column.
    props: { md: t('', { label: 'Text (markdown)', markdown: true }), pad: e(['auto', 'none', 'small', 'normal', 'large'], 'auto', { label: 'Space left and right', hint: 'Inside a column: auto = normal (20px), so text sits off the edge of a photo above it. On the page itself the page edges already give space' }), },
  },
  Columns: {
    label: 'Columns', group: 'content',
    props: {
      cols: e(['2', '3'], '2', { label: 'Columns' }),
      items: arr({ md: t('', { label: 'Text (markdown)', markdown: true }) }, [{ md: '' }, { md: '' }], { label: 'Columns' }),
    },
  },
  // 5.12.9 (Peter, 1 Nov): "create columns and rows, set background images and colours on rows and
  // columns, drag and drop things into columns". A Row holds up to four slot columns; each slot is a
  // list of ordinary blocks ({ type, props }) the owner drops in. One level deep: a Row never holds a Row.
  Row: {
    label: 'Row', group: 'content',
    props: {
      columns: e(['1', '2', '3', '4'], '2', { label: 'Columns' }),
      gap: e(['none', 'small', 'normal', 'large'], 'normal', { label: 'Space between columns' }),
      padding: e(['none', 'small', 'normal', 'large'], 'normal', { label: 'Space above and below' }),
      align: e(['top', 'center'], 'top', { label: 'Line columns up at the' }),
      col_padding: e(['auto', 'none', 'small', 'normal', 'large'], 'auto', { label: 'Space inside columns', hint: 'Auto = normal (20px). Pick none for columns that should touch' }),
      width: e(['page', 'wide', 'full'], 'page', { label: 'Content width', hint: 'Page = the normal column, Wide = a wider column, Full = edge to edge' }),
      full_width: b(false, { label: 'Background edge to edge', hint: 'The content keeps the page width' }),
      background: obj({
        color: color('', { label: 'Background colour' }),
        image: img('', { label: 'Background photo' }),
        darken: b(false, { label: 'Darken the photo so text reads' }),
        tone: e(['auto', 'light', 'dark'], 'auto', { label: 'Text colour', hint: 'auto = light text on a dark background' }),
      }, { label: 'Background' }),
      col_bg: obj({
        col1: color('', { label: 'Column 1' }),
        col2: color('', { label: 'Column 2' }),
        col3: color('', { label: 'Column 3' }),
        col4: color('', { label: 'Column 4' }),
      }, { label: 'Column backgrounds' }),
      col1: slot({ label: 'Column 1' }),
      col2: slot({ label: 'Column 2' }),
      col3: slot({ label: 'Column 3' }),
      col4: slot({ label: 'Column 4' }),
    },
  },
  Gallery: {
    label: 'Gallery', group: 'content',
    props: {
      title: s('', { label: 'Heading' }),
      photos: arr({ url: img('', { label: 'Photo' }), alt: s('', { label: 'Alt text' }) }, [], { label: 'Photos' }),
      cols: n(3, { label: 'Columns', min: 1, max: 4 }),
    },
  },
  // 5.12.10 (Peter, 1 Nov: "still no image element", "a different image in each column"): the
  // small building blocks a drag and drop layout needs. Drop them into a Row column or on the page.
  Image: {
    label: 'Image', group: 'content',
    props: {
      url: img('', { label: 'Photo' }),
      alt: s('', { label: 'Describe the photo', hint: 'Read out by screen readers and shown if the photo fails' }),
      caption: s('', { label: 'Caption' }),
      fit: e(['cover', 'contain'], 'cover', { label: 'Fit', hint: 'Cover fills the box, contain shows the whole photo' }),
      height: e(['natural', 'short', 'medium', 'tall'], 'natural', { label: 'Height' }),
      width: e(['page', 'wide', 'full'], 'page', { label: 'Width', hint: 'On the page: Page = the normal column, Wide = a wider column, Full = edge to edge. In a Row column the photo fills the column' }),
      rounded: b(true, { label: 'Rounded corners' }),
      href: h('', { label: 'Link (optional)' }),
    },
  },
  Heading: {
    label: 'Heading', group: 'content',
    props: {
      text: s('Heading', { label: 'Text' }),
      level: e(['2', '3'], '2', { label: 'Size', hint: '2 = section heading, 3 = smaller' }),
      align: e(['left', 'center'], 'left', { label: 'Align' }),
      sub: s('', { label: 'Line under it' }),
      pad: e(['auto', 'none', 'small', 'normal', 'large'], 'auto', { label: 'Space left and right', hint: 'Inside a column: auto = normal (20px), so text sits off the edge of a photo above it. On the page itself the page edges already give space' }),
    },
  },
  Button: {
    label: 'Button', group: 'content',
    props: {
      label: s('Order now', { label: 'Label' }),
      href: h('servos:order', { label: 'Link' }),
      style: e(['primary', 'secondary', 'link'], 'primary', { label: 'Style' }),
      pad: e(['auto', 'none', 'small', 'normal', 'large'], 'auto', { label: 'Space left and right', hint: 'Inside a column: auto = normal (20px), so text sits off the edge of a photo above it. On the page itself the page edges already give space' }),
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

// 5.12.19 (Peter, 1 Nov: "no way to set a section to full width like the menu on the home page"):
// every page level block takes a width. Row and Image already had one; the Hero is edge to edge
// unless told otherwise. Inside a Row column the column decides, so the setting does nothing there.
export const WIDTHS = Object.freeze(['page', 'wide', 'full']);
const WIDTH_HINT = 'Page = the normal column, Wide = a wider column, Full = edge to edge. Inside a Row column the column decides';
for (const [type, def] of Object.entries(BLOCK_SCHEMAS)) {
  if (type === 'Spacer' || type === 'CustomHtml' || def.props.width) continue;
  def.props.width = e(WIDTHS, type === 'Hero' ? 'full' : 'page', { label: 'Width', hint: WIDTH_HINT });
}

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
    case 'string': case 'href': case 'location': case 'image': case 'color': case 'menu': return typeof v === 'string' ? v : (v == null ? f.default : String(v));
    case 'categories': return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && typeof x.id === 'string').map((x) => ({ id: x.id })) : [];
    case 'slot': {
      // Blocks dropped inside a block: each one normalised like a top level block, junk dropped.
      // In the Puck editor the slot arrives as Puck's own drop zone component (a function): kept as is.
      if (typeof v === 'function') return v;
      if (!Array.isArray(v)) return [];
      return v.filter((x) => x && typeof x === 'object' && typeof x.type === 'string' && isBlockType(x.type))
        .map((x) => ({ type: x.type, props: normaliseProps(x.type, x.props || {}) }));
    }
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

/** The slot prop names of a block type (the columns of a Row); [] for blocks with none. */
export function slotKeysOf(type) {
  const schema = isBlockType(type) ? BLOCK_SCHEMAS[type] : null;
  return schema ? Object.keys(schema.props).filter((k) => schema.props[k].type === 'slot') : [];
}

/**
 * 5.12.9: every block of a layout, top level and inside slots (a Row's columns), depth first, as
 * [{type, props}] with normalised props. Readers that look for "the first LiveMenu on the page"
 * (menuForPage.js, WebsiteSurface, routes.layoutHasHero) use this so a block inside a Row counts.
 * Never throws: junk slots are already [] after normaliseProps.
 */
export function walkBlocks(layout, maxDepth = 3) {
  const out = [];
  const visit = (blocks, depth) => {
    for (const b of blocks) {
      out.push(b);
      if (depth >= maxDepth) continue;
      for (const k of slotKeysOf(b.type)) {
        const kids = Array.isArray(b.props[k]) ? b.props[k] : [];
        visit(kids.filter((c) => c && isBlockType(c.type)).map((c) => ({ type: c.type, props: normaliseProps(c.type, c.props) })), depth + 1);
      }
    }
  };
  visit(layoutBlocks(layout), 0);
  return out;
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
    case 'string': case 'text': case 'href': case 'location': case 'image': case 'color': case 'menu': return { type: 'string', ...desc };
    case 'categories': return { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false }, ...desc };
    case 'slot': return { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, props: { type: 'object' } }, required: ['type', 'props'] }, description: `${f.hint || 'Blocks inside this block'}: each item is { type, props } like a page block` };
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
