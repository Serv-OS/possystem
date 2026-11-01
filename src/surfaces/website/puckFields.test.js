// Schema prop → Puck 0.20 field mapping (the editor's fields come from the one schema).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { puckField, puckFields, rendererFor } from './blocks/puckFields.js';
import { BLOCK_SCHEMAS, BLOCK_TYPES } from './blocks/schema.js';

const PUCK_TYPES = new Set(['text', 'textarea', 'number', 'select', 'radio', 'array', 'object', 'custom', 'slot']);

test('every prop of every block maps to a Puck field type Puck 0.20 knows', () => {
  for (const type of BLOCK_TYPES) {
    const fields = puckFields(BLOCK_SCHEMAS[type].props);
    for (const [k, f] of Object.entries(fields)) assert.ok(PUCK_TYPES.has(f.type), `${type}.${k} → ${f.type}`);
  }
});

test('field shapes: enum → select options, boolean → yes/no radio, array → arrayFields with defaults, object → objectFields', () => {
  assert.deepEqual(puckField({ type: 'enum', options: ['a', 'b'], label: 'L' }), { label: 'L', type: 'select', options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }] });
  const b = puckField({ type: 'boolean', default: true, label: 'B' });
  assert.equal(b.type, 'radio');
  assert.deepEqual(b.options.map((o) => o.value), [true, false]);
  const n = puckField({ type: 'number', min: 0, max: 9 });
  assert.equal(n.type, 'number');
  assert.equal(n.max, 9);
  assert.equal(puckField({ type: 'text' }).type, 'textarea');
  assert.equal(puckField({ type: 'href', hint: 'h' }).placeholder, 'h');
  const a = puckField({ type: 'array', item: { q: { type: 'string', default: '' }, a: { type: 'text', default: 'x' } }, label: 'Qs' });
  assert.equal(a.type, 'array');
  assert.deepEqual(Object.keys(a.arrayFields), ['q', 'a']);
  assert.deepEqual(a.defaultItemProps, { q: '', a: 'x' });
  assert.equal(a.getItemSummary({ q: 'Why?', a: 'Because' }, 0), 'Why?');
  assert.equal(a.getItemSummary({}, 2), 'Item 3');
  const o = puckField({ type: 'object', fields: { label: { type: 'string' }, href: { type: 'href' } } });
  assert.equal(o.type, 'object');
  assert.equal(o.objectFields.href.type, 'text');
});

// 5.12.8: venue props are a dropdown of the company's venues in the editor.
test('location field: a select of default, all and every venue by name; a text box when the editor has no venues', async () => {
  const { locationOptions } = await import('./blocks/puckFields.js');
  const locs = [{ id: 'b', name: 'Zed' }, { id: 'a', name: 'Alpha', online_slug: 'alpha' }, null, { name: 'no id' }];
  const f = puckField({ type: 'location', default: 'default', label: 'Venue' }, { locations: locs });
  assert.equal(f.type, 'select');
  assert.deepEqual(f.options.map((o) => o.value), ['default', 'all', 'a', 'b']);
  assert.equal(f.options[2].label, 'Alpha');
  assert.deepEqual(locationOptions([]).map((o) => o.value), ['default', 'all']);
  const plain = puckField({ type: 'location', default: 'default', hint: 'h' });
  assert.equal(plain.type, 'text');
  assert.equal(plain.placeholder, 'h');
  const live = puckFields(BLOCK_SCHEMAS.LiveMenu.props, { locations: locs });
  assert.equal(live.location_id.type, 'select');
  assert.equal(live.venue_switch.type, 'select');
  assert.deepEqual(live.venue_switch.options.map((o) => o.value), ['buttons', 'dropdown', 'none']);
});

// 5.12.9: the editor's pickers. With opts.renderers a typed field is a Puck custom field whose render
// calls the renderer with Puck's props plus the schema field and the opts; without them the plain
// fields stay (node tests and the SSR side never see React).
test('renderers: image, color, menu, categories, href and markdown text become custom fields; plain fallbacks without them', () => {
  const calls = [];
  const mk = (name) => (p) => { calls.push({ name, p }); return `<${name}/>`; };
  const renderers = { image: mk('image'), color: mk('color'), menu: mk('menu'), categories: mk('categories'), href: mk('href'), markdown: mk('markdown') };
  const opts = { renderers, pages: [{ id: 'p1', slug: '', title: 'Home' }], menus: [{ id: 'm', name: 'M' }], categories: [{ id: 'c', label: 'C' }], uploadAsset: () => {} };
  const hero = puckFields(BLOCK_SCHEMAS.Hero.props, opts);
  assert.equal(hero.photo_url.type, 'custom');
  assert.equal(hero.photo_url.label, 'Photo');
  assert.equal(typeof hero.photo_url.render, 'function');
  assert.equal(hero.headline.type, 'text', 'a plain string stays a text box');
  assert.equal(hero.primary.type, 'object');
  assert.equal(hero.primary.objectFields.href.type, 'custom', 'an href inside an object gets the link picker');
  assert.equal(hero.primary.objectFields.label.type, 'text');
  const live = puckFields(BLOCK_SCHEMAS.LiveMenu.props, opts);
  assert.equal(live.menu_id.type, 'custom');
  assert.equal(live.categories.type, 'custom');
  assert.equal(live.title.type, 'text');
  const gallery = puckFields(BLOCK_SCHEMAS.Gallery.props, opts);
  assert.equal(gallery.photos.type, 'array');
  assert.equal(gallery.photos.arrayFields.url.type, 'custom', 'a photo inside an array gets the upload picker');
  assert.equal(gallery.photos.arrayFields.alt.type, 'text');
  const text = puckFields(BLOCK_SCHEMAS.Text.props, opts);
  assert.equal(text.md.type, 'custom', 'markdown text gets the toolbar');
  const cols = puckFields(BLOCK_SCHEMAS.Columns.props, opts);
  assert.equal(cols.items.arrayFields.md.type, 'custom');
  const faq = puckFields(BLOCK_SCHEMAS.FAQ.props, opts);
  assert.equal(faq.items.arrayFields.a.type, 'custom');
  assert.equal(faq.items.arrayFields.q.type, 'text');
  assert.equal(puckField({ type: 'text', default: '' }, opts).type, 'textarea', 'text without markdown stays a textarea');
  assert.equal(puckField({ type: 'color', default: '' }, opts).type, 'custom');
  assert.equal(puckField({ type: 'button', default: '' }, opts).type, 'text', 'an unknown type is a text box');

  // The render passes Puck's props through, plus the schema field and the opts.
  const out = hero.photo_url.render({ name: 'photo_url', id: 'x', value: 'https://a/b.jpg', onChange: () => {}, readOnly: false });
  assert.equal(out, '<image/>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p.value, 'https://a/b.jpg');
  assert.equal(calls[0].p.field.type, 'image');
  assert.equal(calls[0].p.field.hint, 'Empty = the branding hero photo');
  assert.equal(calls[0].p.opts, opts);
  assert.equal(calls[0].p.name, 'photo_url');

  // Without renderers: today's plain fields, and categories is a plain array field of ids.
  const plain = puckFields(BLOCK_SCHEMAS.LiveMenu.props);
  assert.equal(plain.menu_id.type, 'text');
  assert.equal(plain.categories.type, 'array');
  assert.deepEqual(Object.keys(plain.categories.arrayFields), ['id']);
  assert.deepEqual(plain.categories.defaultItemProps, { id: '' });
  assert.equal(puckFields(BLOCK_SCHEMAS.Hero.props).photo_url.type, 'text');
  assert.equal(puckFields(BLOCK_SCHEMAS.Text.props).md.type, 'textarea');
  assert.equal(puckField({ type: 'color', default: '' }, { renderers: {} }).type, 'text', 'a renderer that is not a function is ignored');
  assert.equal(puckField({ type: 'slot', default: [] }).type, 'slot');

  // rendererFor is the one rule.
  assert.equal(rendererFor({ type: 'image' }), 'image');
  assert.equal(rendererFor({ type: 'text', markdown: true }), 'markdown');
  assert.equal(rendererFor({ type: 'text' }), null);
  assert.equal(rendererFor({ type: 'string' }), null);
  assert.equal(rendererFor(null), null);
});
