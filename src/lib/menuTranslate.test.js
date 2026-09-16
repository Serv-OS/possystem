// Menu translations for the kiosk (supabase/functions/_shared/menuTranslate.js): which venue
// text gets translated, when a translation is stale, how a run is batched and how the
// model's reply is checked.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MENU_LANGS, LANG_NAMES, RUN_LIMIT, BATCH_SIZE, BATCH_CHARS, TRANSLATE_TOOL,
  sourceHash, itemMenuName, menuEntities, instructionOptionId, planTranslations, batchPlan, splitBatch,
  orphanedRows, translationPrompt, parseTranslations, normaliseDashes,
} from '../../supabase/functions/_shared/menuTranslate.js';

const ITEMS = [
  { id: 'm-1', name: 'Pepperoni', menu_name: null, description: 'Tomato Sauce, Mozzarella, Pepperoni, Oregano', archived: false },
  { id: 'm-1-1', name: 'Regular', parent_id: 'm-1', description: '' },
  { id: 'm-2', name: 'Heineken', menu_name: 'Heineken 330ml', description: null },
  { id: 'm-old', name: 'Gone', archived: true },
  { id: 'm-blank', name: '   ' },
];
const CATS = [{ id: 'cat-1', label: 'Sourdough Pizza' }, { id: 'cat-2', label: '' }];
const GROUPS = [{ id: 'mg-1', name: 'Milk', options: [{ id: 'opt-oat', name: 'Oat milk', price: 0.4 }, { id: 'opt-x', name: '' }] }];
const DEFS = [{ id: 'igd-cook', name: 'Cooking preference', options: ['Rare', 'Medium rare', ''] }];

test('the languages are the market ones: Spanish, French and Simplified Chinese', () => {
  assert.deepEqual(MENU_LANGS, ['es', 'fr', 'zh']);
  for (const l of MENU_LANGS) assert.ok(LANG_NAMES[l]);
  assert.match(LANG_NAMES.zh, /Simplified/);
});

test('every kind of venue text becomes an entity, blanks and archived rows do not', () => {
  const ents = menuEntities({ items: ITEMS, categories: CATS, groups: GROUPS, instructionDefs: DEFS });
  assert.deepEqual(ents.map(e => `${e.type}:${e.id}`), [
    'item:m-1', 'item:m-1-1', 'item:m-2',
    'category:cat-1',
    'modifier_group:mg-1', 'modifier_option:opt-oat',
    'instruction_group:igd-cook', 'instruction_option:igd-cook|Rare', 'instruction_option:igd-cook|Medium rare',
  ]);
  assert.deepEqual(ents[0].text, { name: 'Pepperoni', description: 'Tomato Sauce, Mozzarella, Pepperoni, Oregano' });
  // The menu name wins over the name, as on the kiosk card.
  assert.deepEqual(ents[2].text, { name: 'Heineken 330ml', description: '' });
  assert.equal(ents[5].group, 'Milk', 'an option knows its group');
  assert.equal(ents[7].group, 'Cooking preference', 'a choice knows its group');
  assert.equal(ents[0].group, undefined);
  assert.equal(itemMenuName({ name: 'A', menu_name: ' ' }), 'A');
  assert.equal(instructionOptionId('igd-cook', ' Rare '), 'igd-cook|Rare');
  assert.deepEqual(menuEntities(), []);
});

test('the hash follows the English text only', () => {
  const a = sourceHash({ name: 'Pepperoni', description: 'Tomato' });
  assert.equal(a, sourceHash({ name: 'Pepperoni ', description: ' Tomato' }));
  assert.notEqual(a, sourceHash({ name: 'Pepperoni', description: 'Tomato sauce' }));
  assert.notEqual(a, sourceHash({ name: 'Pepperoni' }));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(sourceHash({ name: 'x' }), sourceHash({ name: 'x', description: '' }));
});

test('the plan translates what is missing or changed, keeps edited rows, and caps a run', () => {
  const ents = menuEntities({ items: ITEMS.slice(0, 3), categories: CATS });
  const hash = (e) => sourceHash(e.text);
  const existing = [
    // up to date auto row
    { entity_type: 'item', entity_id: 'm-1', lang: 'es', source: 'auto', source_hash: hash(ents[0]) },
    // stale auto row (English changed)
    { entity_type: 'item', entity_id: 'm-1', lang: 'fr', source: 'auto', source_hash: 'old' },
    // edited row, still current
    { entity_type: 'item', entity_id: 'm-2', lang: 'es', source: 'manual', source_hash: hash(ents[2]) },
    // edited row whose English changed: kept, reported
    { entity_type: 'category', entity_id: 'cat-1', lang: 'zh', source: 'manual', source_hash: 'old' },
  ];
  const plan = planTranslations({ entities: ents, existing });
  const keys = plan.todo.map(t => `${t.type}:${t.id}:${t.lang}`);
  assert.ok(!keys.includes('item:m-1:es'), 'up to date row is skipped');
  assert.ok(keys.includes('item:m-1:fr'), 'stale auto row is redone');
  assert.ok(!keys.includes('item:m-2:es'), 'edited row is never redone');
  assert.ok(!keys.includes('category:cat-1:zh'), 'edited stale row is never redone');
  assert.deepEqual(plan.staleManual, [{ lang: 'zh', type: 'category', id: 'cat-1' }]);
  assert.equal(plan.upToDate, 2);
  // 4 entities in 3 languages, less the up to date row and the two edited rows (the stale
  // auto row is redone, so it stays in the plan)
  assert.equal(plan.todo.length, 4 * 3 - 1 - 2);
  assert.equal(plan.remaining, 0);
  for (const t of plan.todo) assert.equal(t.hash, sourceHash(t.text));
  // force redoes auto rows but still not edited ones
  const forced = planTranslations({ entities: ents, existing, force: true });
  assert.ok(forced.todo.some(t => t.type === 'item' && t.id === 'm-1' && t.lang === 'es'));
  assert.ok(!forced.todo.some(t => t.type === 'item' && t.id === 'm-2' && t.lang === 'es'));
  // the cap
  const capped = planTranslations({ entities: ents, existing: [], limit: 5 });
  assert.equal(capped.todo.length, 5);
  assert.equal(capped.remaining, 12 - 5);
  assert.equal(RUN_LIMIT, 240);
  // one language only
  assert.equal(planTranslations({ entities: ents, existing: [], langs: ['zh'] }).todo.length, 4);
});

test('batches are per language and at most BATCH_SIZE long', () => {
  const todo = [];
  for (let i = 0; i < 95; i++) todo.push({ lang: i % 2 ? 'es' : 'fr', type: 'item', id: `m-${i}`, text: { name: `Item ${i}` } });
  const batches = batchPlan(todo);
  assert.equal(BATCH_SIZE, 40);
  assert.ok(batches.every(b => b.entries.length <= 40 && b.entries.every(e => e.lang === b.lang)));
  assert.equal(batches.reduce((n, b) => n + b.entries.length, 0), 95);
  assert.deepEqual(batches.map(b => `${b.lang}:${b.entries.length}`), ['fr:40', 'fr:8', 'es:40', 'es:7']);
  assert.deepEqual(batchPlan([]), []);
  // Long descriptions make smaller batches, so a reply never runs past the model's output cap.
  assert.equal(BATCH_CHARS, 2400);
  const long = Array.from({ length: 10 }, (_, i) => ({ lang: 'zh', type: 'item', id: `m-${i}`, text: { name: `Item ${i}`, description: 'x'.repeat(700) } }));
  const byChars = batchPlan(long);
  assert.ok(byChars.every(b => b.entries.reduce((n, e) => n + e.text.name.length + e.text.description.length, 0) <= 2400));
  assert.equal(byChars.reduce((n, b) => n + b.entries.length, 0), 10);
  assert.ok(byChars.length >= 3);
  // One entry longer than the cap still goes on its own.
  assert.equal(batchPlan([{ lang: 'es', type: 'item', id: 'big', text: { name: 'A', description: 'y'.repeat(5000) } }]).length, 1);
  // A batch cut at max_tokens is split in two; a single entry cannot be.
  assert.deepEqual(splitBatch({ lang: 'es', entries: [1, 2, 3, 4, 5] }).map(b => b.entries), [[1, 2, 3], [4, 5]]);
  assert.deepEqual(splitBatch({ lang: 'es', entries: [1] }), []);
  assert.deepEqual(splitBatch(null), []);
});

test('automatic rows whose entity is gone are orphans; edited rows and unread types are kept', () => {
  const ents = menuEntities({ items: ITEMS.slice(0, 1) });
  const existing = [
    { entity_type: 'item', entity_id: 'm-1', lang: 'es', source: 'auto' },
    { entity_type: 'item', entity_id: 'm-old', lang: 'es', source: 'auto' },
    { entity_type: 'item', entity_id: 'm-edited-gone', lang: 'es', source: 'manual' },
    { entity_type: 'modifier_option', entity_id: 'opt-deleted', lang: 'fr', source: 'auto' },
    { entity_type: 'instruction_option', entity_id: 'igd-x|Rare', lang: 'fr', source: 'auto' },
  ];
  assert.deepEqual(orphanedRows(ents, existing).map(r => r.entity_id), ['m-old', 'opt-deleted', 'igd-x|Rare']);
  // The instruction defs could not be read this run: their rows are not orphans.
  assert.deepEqual(orphanedRows(ents, existing, ['instruction_group', 'instruction_option']).map(r => r.entity_id), ['m-old', 'opt-deleted']);
});

test('dashes: kept when the English has them, otherwise a comma', () => {
  assert.equal(normaliseDashes('Pepsi Max – 500ml', 'Pepsi Max – 500ml', 'es'), 'Pepsi Max – 500ml');
  assert.equal(normaliseDashes('Hamburguesa – 8oz de ternera', 'Burger, 8oz beef', 'es'), 'Hamburguesa, 8oz de ternera');
  assert.equal(normaliseDashes('Hamburguesa — 8oz', 'Burger 8oz', 'fr'), 'Hamburguesa, 8oz');
  assert.equal(normaliseDashes('汉堡——8盎司牛肉', 'Burger 8oz beef', 'zh'), '汉堡，8盎司牛肉');
  assert.equal(normaliseDashes('plain', 'plain', 'es'), 'plain');
  assert.equal(normaliseDashes(null, '', 'es'), '');
});

test('the prompt numbers every entry, names the kind, and sets the rules', () => {
  const ents = menuEntities({ items: ITEMS.slice(0, 1), categories: CATS, groups: GROUPS, instructionDefs: DEFS });
  const p = translationPrompt('zh', ents, 'Provo');
  assert.match(p, /Simplified Chinese/);
  assert.match(p, /Provo/);
  assert.match(p, /1\. \[menu item\] name: Pepperoni\n {3}description: Tomato Sauce/);
  assert.match(p, /\[menu category\] name: Sourdough Pizza/);
  assert.match(p, /\[choice group heading\] name: Milk/);
  assert.match(p, /\[choice \(in the group "Milk"\)\] name: Oat milk/);
  assert.match(p, /\[choice \(in the group "Cooking preference"\)\] name: Medium rare/);
  assert.match(p, /Brand names/);
  assert.match(p, /Allergen/);
  assert.ok(!/[–—]/.test(p));
  assert.equal(TRANSLATE_TOOL.name, 'submit_translations');
  assert.equal(TRANSLATE_TOOL.strict, true);
  assert.equal(TRANSLATE_TOOL.input_schema.additionalProperties, false);
  assert.deepEqual(TRANSLATE_TOOL.input_schema.required, ['translations']);
});

test('the reply is checked entry by entry: a bad entry waits for the next run', () => {
  const entries = [
    { lang: 'es', type: 'item', id: 'm-1', text: { name: 'Pepperoni', description: 'Tomato sauce' } },
    { lang: 'es', type: 'modifier_option', id: 'opt-oat', text: { name: 'Oat milk' }, group: 'Milk' },
    { lang: 'es', type: 'category', id: 'cat-1', text: { name: 'Sides' } },
    { lang: 'es', type: 'category', id: 'cat-2', text: { name: 'Mains' } },
    { lang: 'es', type: 'item', id: 'm-9', text: { name: 'Steak', description: 'Aged' } },
  ];
  const reply = { translations: [
    { n: 1, name: 'Pepperoni', description: 'Salsa de tomate' },
    { n: 2, name: 'Leche de avena', description: '' },
    { n: 3, name: '' },
    { n: 4, name: 'Principales – hoy' },
    { n: 5, name: 'Bistec', description: '' },
  ] };
  const { rows, problems } = parseTranslations('es', entries, reply);
  assert.deepEqual(rows.map(r => r.id), ['m-1', 'opt-oat', 'cat-2']);
  assert.deepEqual(rows[0].text, { name: 'Pepperoni', description: 'Salsa de tomate' });
  assert.deepEqual(rows[1].text, { name: 'Leche de avena' });
  assert.equal(rows[1].group, 'Milk');
  assert.equal(rows[0].group, undefined);
  assert.deepEqual(rows[2].text, { name: 'Principales, hoy' }, 'a dash the English did not have becomes a comma');
  assert.equal(rows[0].hash, sourceHash(entries[0].text));
  assert.equal(rows[0].lang, 'es');
  assert.deepEqual(problems, [
    'category cat-1: empty name',
    'item m-9: empty description',
  ]);
  assert.deepEqual(parseTranslations('es', entries, null).rows, []);
});

test('the edge function uses these rules, calls the model the way Sonnet 5 accepts, and pages its reads', () => {
  const fn = fs.readFileSync(new URL('../../supabase/functions/menu-translate/index.ts', import.meta.url), 'utf8');
  for (const s of ['menuEntities', 'planTranslations', 'batchPlan', 'splitBatch', 'parseTranslations', 'translationPrompt', 'TRANSLATE_TOOL', 'orphanedRows']) {
    assert.ok(fn.includes(s), `edge function uses ${s}`);
  }
  assert.ok(fn.includes("Deno.env.get('ANTHROPIC_API_KEY')"));
  assert.ok(fn.includes("'claude-sonnet-5'"));
  // claude-sonnet-5 rejects sampling parameters; thinking is off so the whole output cap is the tool call
  assert.ok(!/temperature|top_p|top_k/.test(fn), 'no sampling parameters');
  assert.ok(fn.includes("thinking: { type: 'disabled' }"));
  assert.ok(fn.includes("stop_reason === 'max_tokens'"), 'a cut reply splits the batch');
  assert.ok(fn.includes('AbortSignal.timeout('), 'a stalled model call ends');
  assert.ok(fn.includes('kiosk_new_design'), 'only venues with the new kiosk design are translated in the background');
  assert.ok(fn.includes("rpc('menu_translations_upsert_auto'"), 'writes never touch a manual row');
  assert.ok(fn.includes('readAll('), 'reads are paged past the 1000 row cap');
  assert.ok(fn.includes("neq('source', 'manual')"));
  const cron = fn.match(/const CRON_TIME_BUDGET_MS = ([0-9_]+);/);
  assert.ok(cron && Number(cron[1].replace(/_/g, '')) < 25000, 'the cron path answers before pg_net gives up (25 s)');
  const sql = fs.readFileSync(new URL('../../supabase/migrations/20260916_OPS_menu_translations.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes('create table if not exists public.menu_translations'));
  assert.ok(sql.includes("call_edge_fn('menu-translate'"));
  assert.ok(sql.includes('menu_translations_anon_read'));
  assert.ok(sql.includes('pos_can_access(location_id) or public.is_super_admin()'));
  assert.ok(sql.includes('revoke all on public.menu_translations from public, anon, authenticated;'));
  assert.ok(sql.includes("where public.menu_translations.source <> 'manual'"));
  assert.ok(sql.includes('grant execute on function public.menu_translations_upsert_auto(jsonb) to service_role;'));
});
