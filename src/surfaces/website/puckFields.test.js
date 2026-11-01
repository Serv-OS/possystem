// Schema prop → Puck 0.20 field mapping (the editor's fields come from the one schema).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { puckField, puckFields } from './blocks/puckFields.js';
import { BLOCK_SCHEMAS, BLOCK_TYPES } from './blocks/schema.js';

const PUCK_TYPES = new Set(['text', 'textarea', 'number', 'select', 'radio', 'array', 'object']);

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
