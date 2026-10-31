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
