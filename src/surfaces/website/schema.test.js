// The block schema is the one registry (ARCHITECTURE.md section 6): every block named there exists,
// every prop has a default, normaliseProps never throws, the JSON schema has no open props.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_SCHEMAS, BLOCK_TYPES, GROUPS, defaultPropsFor, normaliseProps, layoutBlocks, jsonSchemaFor, layoutJsonSchema, isBlockType } from './blocks/schema.js';

const SECTION_6 = ['Hero', 'OrderBar', 'LiveMenu', 'Specials', 'OrderEmbed', 'LoyaltyJoin', 'GiftCards', 'BookTable', 'Waitlist', 'Hours', 'FindUs', 'Reviews', 'BlogList',
  'Text', 'Columns', 'Gallery', 'Button', 'FAQ', 'Instagram', 'Divider', 'Spacer', 'CustomHtml'];

test('every block from section 6 exists, in the right group, and nothing else', () => {
  assert.deepEqual([...BLOCK_TYPES].sort(), [...SECTION_6].sort());
  assert.equal(GROUPS.servos.length, 13);
  assert.equal(GROUPS.content.length, 9);
  for (const t of GROUPS.servos) assert.equal(BLOCK_SCHEMAS[t].group, 'servos');
  for (const t of GROUPS.content) assert.equal(BLOCK_SCHEMAS[t].group, 'content');
  assert.ok(isBlockType('Hero') && !isBlockType('Carousel') && !isBlockType('__proto__'));
});

test('defaultPropsFor gives a complete fresh object for every block, {} for unknown', () => {
  for (const t of BLOCK_TYPES) {
    const d = defaultPropsFor(t);
    assert.deepEqual(Object.keys(d).sort(), Object.keys(BLOCK_SCHEMAS[t].props).sort(), t);
    const again = defaultPropsFor(t);
    assert.notEqual(d, again);
    for (const k of Object.keys(d)) if (d[k] && typeof d[k] === 'object') assert.notEqual(d[k], again[k], `${t}.${k} shares a default object`);
  }
  assert.deepEqual(defaultPropsFor('Nope'), {});
  assert.equal(defaultPropsFor('LiveMenu').show.prices, true);
  assert.equal(defaultPropsFor('Hero').height, 'tall');
  assert.equal(defaultPropsFor('Columns').items.length, 2);
});

test('normaliseProps fills, coerces and drops unknown keys; never throws on junk', () => {
  const p = normaliseProps('LiveMenu', { id: 'x', layout: 'carousel', max_items: '12', show: { prices: 'false' }, categories: 'all', evil: 1 });
  assert.equal(p.id, 'x');
  assert.equal(p.layout, 'cards');
  assert.equal(p.max_items, 12);
  assert.equal(p.show.prices, false);
  assert.equal(p.show.photos, true);
  assert.deepEqual(p.categories, []);
  assert.equal('evil' in p, false);
  assert.deepEqual(normaliseProps('Columns', { cols: 3 }).cols, '3');
  for (const junk of [null, undefined, 1, 'str', [], { props: null }]) assert.doesNotThrow(() => normaliseProps('Hero', junk));
  assert.deepEqual(normaliseProps('Unknown', { a: 1 }), { a: 1 });
});

test('layoutBlocks keeps known blocks in order and drops the rest', () => {
  const blocks = layoutBlocks({ content: [{ type: 'Hero', props: {} }, { type: 'Nope', props: {} }, null, { type: 'Text', props: { md: 'hi' } }] });
  assert.deepEqual(blocks.map((b) => b.type), ['Hero', 'Text']);
  assert.deepEqual(layoutBlocks(null), []);
  assert.deepEqual(layoutBlocks({ content: 'bad' }), []);
});

test('JSON schema: closed objects, enums carried, a layout schema the designer tool can use', () => {
  const s = jsonSchemaFor('Hero');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.height.enum, ['tall', 'short']);
  assert.equal(s.properties.primary.properties.href.type, 'string');
  const l = layoutJsonSchema();
  assert.equal(l.properties.content.items.oneOf.length, BLOCK_TYPES.length);
  assert.doesNotThrow(() => JSON.stringify(l));
  assert.equal(jsonSchemaFor('Nope'), null);
});
