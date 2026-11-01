// The block schema is the one registry (ARCHITECTURE.md section 6): every block named there exists,
// every prop has a default, normaliseProps never throws, the JSON schema has no open props.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_SCHEMAS, BLOCK_TYPES, GROUPS, defaultPropsFor, normaliseProps, layoutBlocks, walkBlocks, slotKeysOf, jsonSchemaFor, layoutJsonSchema, isBlockType } from './blocks/schema.js';
import { puckField } from './blocks/puckFields.js';

// Section 6 plus Row (5.12.9: columns the owner drops blocks into).
const SECTION_6 = ['Hero', 'OrderBar', 'LiveMenu', 'Specials', 'OrderEmbed', 'LoyaltyJoin', 'GiftCards', 'BookTable', 'Waitlist', 'Hours', 'FindUs', 'Reviews', 'BlogList',
  'Text', 'Columns', 'Row', 'Gallery', 'Image', 'Heading', 'Button', 'FAQ', 'Instagram', 'Divider', 'Spacer', 'CustomHtml'];

test('every block from section 6 exists, in the right group, and nothing else', () => {
  assert.deepEqual([...BLOCK_TYPES].sort(), [...SECTION_6].sort());
  assert.equal(GROUPS.servos.length, 13);
  assert.equal(GROUPS.content.length, 12);
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

// ── Row block (5.12.9) ───────────────────────────────────────────────────────
test('Row: slot columns, backgrounds and defaults; junk columns normalise to [] and a Puck drop zone component passes through', () => {
  const d = defaultPropsFor('Row');
  assert.equal(d.columns, '2');
  assert.deepEqual(d.col1, []);
  assert.deepEqual(d.background, { color: '', image: '', darken: false, tone: 'auto' });
  assert.deepEqual(d.col_bg, { col1: '', col2: '', col3: '', col4: '' });
  assert.deepEqual(slotKeysOf('Row'), ['col1', 'col2', 'col3', 'col4']);
  assert.deepEqual(slotKeysOf('Text'), []);
  const p = normaliseProps('Row', { id: 'r', columns: 3, col1: 'junk', col2: [{ type: 'Text', props: { md: 'hi' } }, { type: 'Nope', props: {} }, null, 7], col3: [{ type: 'Row', props: {} }] });
  assert.equal(p.columns, '3');
  assert.deepEqual(p.col1, []);
  assert.equal(p.col2.length, 1);
  assert.equal(p.col2[0].type, 'Text');
  assert.equal(p.col2[0].props.md, 'hi');
  assert.equal(p.col3[0].type, 'Row', 'the schema keeps a nested Row; the validator and the renderers refuse it');
  // In the editor Puck hands the slot as its own drop zone component: normaliseProps must not wipe it.
  const Zone = () => null;
  assert.equal(normaliseProps('Row', { col1: Zone }).col1, Zone);
  // The editor gets a real Puck slot field for every column.
  assert.deepEqual(puckField(BLOCK_SCHEMAS.Row.props.col1), { type: 'slot', disallow: ['Row'] }, 'a Row is never offered inside a Row');
  assert.equal(jsonSchemaFor('Row').properties.col1.type, 'array');
});

test('walkBlocks yields top level and nested blocks depth first, normalised, junk dropped', () => {
  const layout = { content: [
    { type: 'Hero', props: { id: 'h' } },
    { type: 'Row', props: { id: 'r', columns: '2', col1: [{ type: 'Text', props: { id: 't', md: 'x' } }], col2: [{ type: 'LiveMenu', props: { id: 'm', location_id: 'loc-2' } }, { type: 'Nope', props: {} }], col3: [{ type: 'Specials', props: { id: 's' } }] } },
    { type: 'Text', props: { id: 't2' } },
  ] };
  const types = walkBlocks(layout).map((b) => b.type);
  // col3 is walked too (the block keeps its data even when columns says 2; the renderers skip it).
  assert.deepEqual(types, ['Hero', 'Row', 'Text', 'LiveMenu', 'Specials', 'Text']);
  const menu = walkBlocks(layout).find((b) => b.type === 'LiveMenu');
  assert.equal(menu.props.location_id, 'loc-2');
  assert.equal(menu.props.layout, 'cards', 'nested props are normalised');
  assert.deepEqual(walkBlocks(null), []);
  assert.deepEqual(walkBlocks({ content: [{ type: 'Row', props: { col1: 'junk' } }] }).map((b) => b.type), ['Row']);
});

// ── 5.12.10: Image, Heading, widths, hero slides ────────────────────────────────
test('Image and Heading: content blocks with sensible defaults; Row and Image carry a width enum; Hero has slides', () => {
  assert.equal(BLOCK_SCHEMAS.Image.group, 'content');
  assert.equal(BLOCK_SCHEMAS.Heading.group, 'content');
  const img = defaultPropsFor('Image');
  assert.deepEqual([img.url, img.fit, img.height, img.width, img.rounded, img.href], ['', 'cover', 'natural', 'page', true, '']);
  const hd = defaultPropsFor('Heading');
  assert.deepEqual([hd.text, hd.level, hd.align, hd.sub], ['Heading', '2', 'left', '']);
  assert.equal(BLOCK_SCHEMAS.Image.props.url.type, 'image', 'the editor shows an Upload photo button');
  assert.deepEqual(BLOCK_SCHEMAS.Row.props.width.options, ['page', 'wide', 'full']);
  assert.equal(defaultPropsFor('Row').width, 'page');
  assert.equal(normaliseProps('Image', { url: 'https://x/a.jpg', width: 'huge', level: 9 }).width, 'page');
  const hero = defaultPropsFor('Hero');
  assert.deepEqual(hero.slides, []);
  assert.equal(hero.slide_seconds, '6');
  assert.equal(BLOCK_SCHEMAS.Hero.props.slides.item.photo_url.type, 'image');
  const n = normaliseProps('Hero', { slides: [{ photo_url: 'https://x/2.jpg', headline: 'Two' }, 'junk'] });
  assert.equal(n.slides.length >= 1, true);
  assert.equal(n.slides[0].headline, 'Two');
});
