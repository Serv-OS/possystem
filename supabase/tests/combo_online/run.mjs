#!/usr/bin/env node
// run.mjs: proves 20261217a (5.12.125, the server values a Combo's picks) on a local, throwaway
// PostgreSQL, before Peter runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/combo_online/run.mjs
//
// It builds only what public._public_order_value reads (menu_items with the combo column of
// 20261215a, menus, modifier_groups, eighty_six and the pricing helpers, word for word from the
// files the live ones are), loads the function as live has it (20261020a, md5 checked), then:
//   1. before 20261217a a Combo's picks are valued at their full menu price (the gap);
//   2. 20261217a applies twice, its check row reads true, and it refuses a body it does not know;
//   3. a basket the page builds (src/lib/online/comboCart.js) comes to the server's own figure,
//      to the penny, with its options, price bumps, sizes and kept prices;
//   4. a doctored basket never gets a product for less (too many picks, a product the step does not
//      list, a second Combo line, a Combo that is not one, a pick past "each only once");
//   5. an order with no Combo is valued exactly as the live function values it;
//   6. the ROLLBACK puts the live body back byte for byte and drops public_order_features, twice.
// Exit code 0 only when every check holds.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comboCartLines } from '../../../src/lib/online/comboCart.js';
import { resolveItemPrice } from '../../../src/lib/menuPricing.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const mig = (f) => readFileSync(join(repo, 'supabase/migrations', f), 'utf8');
const FWD = mig('20261217a_OPS_public_order_combo_steps.sql');
const BACK = mig('20261217a_OPS_public_order_combo_steps_ROLLBACK.sql');
const LIVE_MD5 = 'db3790dba28aaef13a346a11d0a59a36';
const NEW_MD5 = (FWD.match(/'([0-9a-f]{32})' from pg_proc p where p\.oid = to_regprocedure\('public\._public_order_value\(text, text, text, jsonb, text\)'\)\) as pricer_knows_combos/) || [])[1]
  || (FWD.match(/md5\(p\.prosrc\) = '([0-9a-f]{32})' from pg_proc/) || [])[1];

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg, more = '') => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}${more ? `\n       ${more}` : ''}`); } };

const port = String(55800 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgc.'));
const data = join(dir, 'data');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir} -c timezone=UTC`, 'start'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
}
function stop() { spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env, encoding: 'utf8' }); rmSync(dir, { recursive: true, force: true }); }
function psql({ input, allowFail = false }) {
  const r = spawnSync(bin('psql'), ['-h', dir, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At'], { env, input, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) { console.error('psql failed:\n', (input || '').slice(0, 400), '\n', r.stderr || r.stdout); stop(); process.exit(2); }
  return r;
}
const sql = (q) => psql({ input: q }).stdout.trim();
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const jlit = (v) => `${lit(JSON.stringify(v))}::jsonb`;
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) throw new Error(`missing ${a}`); return s.slice(i, s.indexOf(b, i) + b.length); };
const md5Now = () => sql("select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public._public_order_value(text, text, text, jsonb, text)')");

const LOC = 'loc-1';
const value = (items, { type = 'collection', fn = '_public_order_value' } = {}) =>
  JSON.parse(sql(`select public.${fn}(${lit(LOC)}, 'online', ${lit(type)}, ${jlit(items)}, null)::text`));

// ── The menu: Mozz's catering "Build Your Own Package", made small ─────────────────────────────
const step = (id, name, selectionType, min, max, pricing, products) => ({ id, name, selectionType, min, max, pricing, products: products.map((p) => (typeof p === 'string' ? { itemId: p, bump: 0 } : p)) });
const STEPS = { v: 1, steps: [
  step('st-pizza', 'Pick 3 pizzas', 'quantity', 3, 3, 'set', ['marg', { itemId: 'pep', bump: 1.5 }, 'calz']),
  step('st-side', 'Up to 2 sides', 'multiple_once', 0, 2, 'set', ['bread', 'wings']),
  step('st-drink', 'Pick a drink', 'single', 1, 1, 'own', ['cola', 'lemon']),
] };
const row = (id, name, more = {}) => ({ id, location_id: LOC, name, menu_name: null, receipt_name: null, kitchen_name: null, parent_id: null, archived: false, type: 'simple', sold_alone: true, assigned_modifier_groups: [], cat: 'cat-main', cats: [], pricing: { base: 0 }, combo: null, ...more });
const ROWS = [
  row('box', 'Pizza party', { type: 'combo', pricing: { base: 30 }, combo: STEPS, cat: 'cat-packages' }),
  row('marg', 'Margherita', { pricing: { base: 9 }, assigned_modifier_groups: ['g-extra'], cat: 'cat-pizza' }),
  row('pep', 'Pepperoni', { pricing: { base: 10 }, cat: 'cat-pizza' }),
  row('calz', 'Calzone', { type: 'variants', pricing: { base: 0 }, cat: 'cat-pizza' }),
  row('calz-s', 'Small', { parent_id: 'calz', pricing: { base: 8 } }),
  row('calz-l', 'Large', { parent_id: 'calz', pricing: { base: 11 } }),
  row('bread', 'Garlic bread', { pricing: {}, cat: 'cat-sides' }),          // no price of its own: only ever in the box
  row('wings', 'Wings', { pricing: { base: 6 }, cat: 'cat-sides' }),
  row('cola', 'Cola', { pricing: { base: 2, collection: 2.2 }, cat: 'cat-drinks' }),
  row('lemon', 'Lemonade', { pricing: { base: 2.5 }, cat: 'cat-drinks' }),
  row('cake', 'Cake', { pricing: { base: 4 }, cat: 'cat-sides' }),
  row('soup', 'Soup', { pricing: { base: 5 }, cat: 'cat-sides' }),
  row('dip', 'Dip', { pricing: { base: 0.3 }, assigned_modifier_groups: ['g-extra'], cat: 'cat-sides' }),
  row('old-box', 'Old party', { type: 'combo', archived: true, pricing: { base: 1 }, combo: STEPS }),
  row('plain-combo', 'Meal deal', { type: 'combo', pricing: { base: 7 } }),   // a Combo with no steps: a plain product
  // Review of 27 Nov 2026: a step listing a product AND one of its sizes on their own, at different bumps.
  row('box2', 'Calzone pair', { type: 'combo', pricing: { base: 20 }, combo: { v: 1, steps: [
    step('st-c', 'Two calzones', 'multiple_once', 0, 2, 'set', ['calz', { itemId: 'calz-l', bump: 2 }]),
  ] } }),
  // Steps written by hand: no id, and two with the same id (the app reads them as step-1, x, x-2).
  row('box3', 'Hand box', { type: 'combo', pricing: { base: 12 }, combo: { v: 1, steps: [
    { name: 'A pizza', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: ['marg'] },
    { id: 'x', name: 'Another', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: 'pep', bump: 1 }] },
    { id: 'x', name: 'A side', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: ['wings'] },
  ] } }),
];
const GROUPS = [{ id: 'g-extra', location_id: LOC, options: [{ id: 'o-cheese', name: 'Extra cheese', price: 1 }, { id: 'o-basil', name: 'Basil', price: 0.5 }, { id: 'o-nocheese', name: 'No cheese', price: -0.5 }], max: 2, max_select: null, selection_type: 'multiple' }];
const priceFor = (r) => resolveItemPrice(r, 'collection', null);
const goodsOf = (lines) => Math.round(lines.reduce((s, l) => s + (l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0)) * (l.qty || 1), 0) * 100);
let uidN = 0;
const uid = (id) => `${id}-u${++uidN}`;
const pick = (stepId, entryId, itemId = entryId, mods = []) => ({ key: `k${++uidN}`, stepId, entryId, itemId, mods, notes: '', configured: true });
const cheese = { id: 'o-cheese', name: 'Extra cheese', label: 'Extra cheese', price: 1 };
const box = (picks, comboId = 'cb-1') => comboCartLines({ item: ROWS[0], picks, rows: ROWS, priceFor, comboId, uid });
const plain = (id, qty = 1, mods = []) => { const r = ROWS.find((x) => x.id === id); return { uid: uid(id), itemId: id, name: r.name, price: priceFor(r), qty, mods, cat: r.cat }; };

try {
  // ── The shape _public_order_value reads ──
  const fence = mig('20260919a1_OPS_fence_identity_devices.sql');
  const helpers = ['_fence_num', '_fence_num_or_null', '_menu_channel_key']
    .map((n) => between(fence, `create or replace function public.${n}(`, '$fn$;')).join('\n\n');
  const floor = between(fence, 'create or replace function public._menu_item_floor_minor(', '$fn$;');
  const parity2 = mig('20261020a_OPS_channel_parity_2.sql');
  const hasPrice = between(parity2, 'create or replace function public._menu_item_has_price(', '$function$;');
  const live = between(parity2, 'CREATE OR REPLACE FUNCTION public._public_order_value(', '$function$;');
  psql({ input: `
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.menu_items (id text primary key, location_id text, name text, menu_name text, receipt_name text, kitchen_name text,
      parent_id text, archived boolean, type text, sold_alone boolean, assigned_modifier_groups jsonb, cat text, cats text[], pricing jsonb, combo jsonb);
    create table public.menus (id text primary key, location_id text);
    create table public.modifier_groups (id text primary key, location_id text, options jsonb, max integer, max_select integer, selection_type text);
    create table public.eighty_six (item_id text, location_id text);
    ${helpers}
    ${floor}
    ${hasPrice}
    ${live}
    ${live.replace('FUNCTION public._public_order_value(', 'FUNCTION public._pov_live(')}
  ` });
  for (const r of ROWS) {
    sql(`insert into public.menu_items values (${lit(r.id)}, ${lit(r.location_id)}, ${lit(r.name)}, ${lit(r.menu_name)}, null, null, ${lit(r.parent_id)}, ${r.archived}, ${lit(r.type)}, ${r.sold_alone},
      ${jlit(r.assigned_modifier_groups)}, ${lit(r.cat)}, '{}', ${jlit(r.pricing)}, ${r.combo ? jlit(r.combo) : 'null'})`);
  }
  for (const g of GROUPS) sql(`insert into public.modifier_groups values (${lit(g.id)}, ${lit(g.location_id)}, ${jlit(g.options)}, ${g.max}, null, ${lit(g.selection_type)})`);
  ok(md5Now() === LIVE_MD5, 'the rig runs _public_order_value exactly as read on live (md5 of the body)');

  // The box the page builds: 3 pizzas (Margherita with extra cheese, Pepperoni +1.50, Calzone Large),
  // garlic bread (no price of its own), wings, and a Cola that keeps its price (2.20 on Collection).
  const picks = [
    pick('st-pizza', 'marg', 'marg', [cheese]), pick('st-pizza', 'pep'), pick('st-pizza', 'calz', 'calz-l'),
    pick('st-side', 'bread'), pick('st-side', 'wings'), pick('st-drink', 'cola'),
  ];
  const basket = box(picks);
  const pageGoods = goodsOf(basket);
  ok(pageGoods === 3000 + 100 + 150 + 0 + 0 + 0 + 220, `the page's basket comes to 34.70 (${pageGoods / 100})`);

  // ── 1. Before 20261217a: the gap ──
  {
    const v = value(basket);
    ok(v.goods_minor > pageGoods, `before 20261217a the server values the picks at full price (${v.goods_minor / 100} against the page's ${pageGoods / 100})`);
  }

  // ── 2. The file ──
  {
    const r = psql({ input: FWD, allowFail: true });
    ok(r.status === 0, '20261217a applies as the SQL editor runs it', r.stderr);
    const check = r.stdout.trim().split('\n').pop();
    ok(check === 't|t|t', `its check row reads true (${check})`);
    ok(md5Now() === NEW_MD5 && NEW_MD5 && NEW_MD5 !== LIVE_MD5, 'the body is the one the generator worked out');
    const again = psql({ input: FWD, allowFail: true });
    ok(again.status === 0 && again.stdout.trim().split('\n').pop() === 't|t|t', 'a second run is fine');
    ok(sql("select public.public_order_features()::text") === '{"combo_steps": true}', 'public_order_features answers combo_steps true');
    ok(sql("select has_function_privilege('anon', 'public.public_order_features()', 'execute')") === 't', 'a guest page may ask it');
  }

  // ── 3. The page and the server agree ──
  {
    const v = value(basket);
    ok(v.goods_minor === pageGoods, `the server values the box at the page's own figure (${v.goods_minor / 100})`);
    ok(v.unknown_lines === 0, 'no line is unknown (the garlic bread has no price of its own, and is part of the set price)');
    const items = v.items;
    ok(items.every((l, i) => l.comboId === basket[i].comboId && l.comboRole === basket[i].comboRole), 'every line keeps its Combo words');
    ok(items[0].noKitchen === true && Number(items[0].price) === 30, 'the Combo line keeps its set price and never goes to the kitchen');
    ok(items.slice(1).map((l) => Number(l.price)).join(',') === '0,1.5,0,0,0,2.2', `each pick at its rule (${items.slice(1).map((l) => l.price).join(', ')})`);
    ok(Number(items[1].mods[0].price) === 1, 'a pick\'s own option charges as the option charges');
    ok(v.lines.length === 1 && v.lines[0].id === 'box' && v.lines[0].unit === 3000, 'only the Combo\'s own line takes part in deals, promo codes and rewards');
    ok(v.max_unit_minor === 3000, 'a pick is never the dearest line a reward is capped at');
    // The same box twice in one order, each its own Combo.
    const two = [...box(picks, 'cb-a'), ...box(picks, 'cb-b')];
    ok(value(two).goods_minor === goodsOf(two), 'two boxes in one order: each valued on its own steps');
    // A box with a box quantity of 2 (never sent by the page, but the room doubles, never more).
    const dbl = box([...picks, pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-pizza', 'pep')]);
    dbl[0].qty = 2;
    ok(value(dbl).goods_minor === goodsOf(dbl), 'a Combo of quantity 2 has room for twice the picks');
  }

  // ── 4. A doctored basket never gets a product for less ──
  {
    // A 0.00 Pepperoni (its bump is 1.50): valued at the bump.
    const b = box([pick('st-pizza', 'pep'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'lemon')]);
    b[1].price = 0;
    ok(value(b).goods_minor === goodsOf(b) + 150, 'a pick priced below its bump is valued at its bump');
    // A fourth pizza in a step of 3: valued at its own price, and no longer in the Combo.
    const four = box([pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'cola')]);
    four.push({ ...four[1], uid: 'extra-pizza' });
    const v4 = value(four);
    ok(v4.goods_minor === goodsOf(four) + 900, `a pick past its step's room is valued at its menu price (${v4.goods_minor / 100})`);
    ok(!('comboId' in v4.items[5]) && !('comboRole' in v4.items[5]), 'and loses its Combo words (it is a line of its own)');
    ok(v4.lines.some((l) => l.id === 'marg'), 'and takes part in deals as any line');
    // The same side twice where each is taken once.
    const twice = box([pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-side', 'wings'), pick('st-side', 'wings'), pick('st-drink', 'cola')]);
    ok(value(twice).goods_minor === goodsOf(twice) + 600, '"each only once": the second Wings is valued at its menu price');
    // A product the step does not list (Cake claimed as a side).
    const cake = box([pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'cola')]);
    cake.push({ ...cake[4], uid: 'cake', itemId: 'cake', name: 'Cake', comboStepId: 'st-side', comboEntryId: 'cake', price: 0, comboKeepsPrice: false, comboBump: 0 });
    ok(value(cake).goods_minor === goodsOf(cake) + 400, 'a product the step does not list is valued at its menu price');
    // Wings claimed in the pizza step.
    const wrong = box([pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'cola')]);
    wrong.push({ ...wrong[1], uid: 'w', itemId: 'wings', name: 'Wings', comboEntryId: 'wings' });
    ok(value(wrong).goods_minor === goodsOf(wrong) + 600, 'a product claimed in a step that does not list it is valued at its menu price');
    // A Combo line that is not a real Combo: an archived one, a Combo with no steps, a plain product.
    for (const id of ['old-box', 'plain-combo', 'soup']) {
      const fake = box([pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'cola')]);
      const r = ROWS.find((x) => x.id === id);
      fake[0] = { ...fake[0], itemId: id, name: r.name, price: r.pricing.base ?? 0 };
      const v = value(fake);
      ok(v.goods_minor === goodsOf(fake) + 2700, `"${r.name}" claimed as the Combo: its picks are valued at their menu prices`);
      ok(v.items.every((l) => !('comboRole' in l)), `"${r.name}": no line keeps Combo words`);
    }
    // A second line claiming to be the same Combo: it is a line of its own.
    const second = box([pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'cola')]);
    second.push({ ...second[0], uid: 'again' });
    const vs = value(second);
    ok(vs.goods_minor === goodsOf(second) && !('comboRole' in vs.items[5]) && 'comboRole' in vs.items[0], 'a second Combo line for the same Combo is a line of its own, at its price');
    // A pick for a Combo that is not on the order at all.
    const orphan = [plain('soup'), { ...box([pick('st-pizza', 'marg')])[1], comboId: 'cb-nowhere' }];
    ok(value(orphan).goods_minor === 500 + 900, 'a pick of a Combo that is not on the order is valued at its menu price');
    // A size picked when the step lists it: fine. The product with sizes itself: never sold.
    const parentPick = box([pick('st-pizza', 'calz', 'calz'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'cola')]);
    ok(value(parentPick).unknown_lines === 1, 'a product with sizes is never sold without its size (unknown, as any line)');
    // A pick that keeps its price is valued as the same product would be as a line of its own.
    const own = value([...box([pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'cola')]), plain('cola')]);
    ok(Number(own.items[4].price) === Number(own.items[5].price), `a pick that keeps its price is valued as the product alone (${own.items[4].price})`);
    // A kept price pick cannot go under its menu price.
    const cheap = box([pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'lemon')]);
    cheap[4].price = 0;
    ok(value(cheap).goods_minor === goodsOf(cheap) + 250, 'a pick that keeps its price cannot be bought for less');
    // 86'd today: unknown, as any line.
    sql(`insert into public.eighty_six values ('wings', ${lit(LOC)})`);
    ok(value(box([pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-side', 'wings'), pick('st-drink', 'cola')])).unknown_lines === 1, 'a pick 86\'d since the page loaded is unknown, as any line');
    sql('delete from public.eighty_six');
    // Review of 27 Nov 2026, 1: a step lists Calzone (any size, no bump) AND its Large on its own (+2.00).
    // The guest's tap decides: Calzone then Large is 0.00, "Large" on its own is +2.00; both in one step.
    const box2 = ROWS.find((x) => x.id === 'box2');
    const pair = (picks) => comboCartLines({ item: box2, picks, rows: ROWS, priceFor, comboId: 'cb-p', uid });
    for (const [label, picks] of [
      ['Calzone then Large', [pick('st-c', 'calz', 'calz-l')]],
      ['Large on its own', [pick('st-c', 'calz-l', 'calz-l')]],
      ['both, each once', [pick('st-c', 'calz', 'calz-l'), pick('st-c', 'calz-l', 'calz-l')]],
    ]) {
      const b = pair(picks);
      const v = value(b);
      ok(v.goods_minor === goodsOf(b) && v.items.every((l) => 'comboRole' in l), `the entry the guest tapped decides the price: ${label} (${v.goods_minor / 100} = ${goodsOf(b) / 100})`);
    }
    // 2: the venue's own minus option on a 0.00 pick takes the line below zero, as on the POS and the page.
    const noCheese = { id: 'o-nocheese', name: 'No cheese', label: 'No cheese', price: -0.5 };
    const minus = box([pick('st-pizza', 'marg', 'marg', [noCheese]), pick('st-pizza', 'marg', 'marg', [noCheese]), pick('st-pizza', 'marg'), pick('st-drink', 'cola')]);
    ok(value(minus).goods_minor === goodsOf(minus) && goodsOf(minus) === 3000 - 100 + 220, `a minus option on a 0.00 pick: the server agrees with the page (${goodsOf(minus) / 100})`);
    // ...but a made up minus option never takes a penny off.
    const fake = box([pick('st-pizza', 'marg', 'marg', [{ id: 'o-free-money', name: 'Discount', price: -5 }]), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'cola')]);
    ok(value(fake).goods_minor === 3000 + 220, 'a minus option the venue does not have takes nothing off');
    // ...and a plain line still never goes below zero.
    const dip = [plain('dip', 1, [noCheese])];
    ok(value(dip).goods_minor === 0 && JSON.stringify(value(dip)) === JSON.stringify(value(dip, { fn: '_pov_live' })), 'a plain line still never goes below zero, exactly as live');
    // 5: steps written by hand are read as the app reads them (step-1, x, x-2).
    const box3 = ROWS.find((x) => x.id === 'box3');
    const hand = comboCartLines({ item: box3, picks: [pick('step-1', 'marg'), pick('x', 'pep'), pick('x-2', 'wings')], rows: ROWS, priceFor, comboId: 'cb-h', uid });
    ok(hand.slice(1).map((l) => l.comboStepId).join(',') === 'step-1,x,x-2', 'the page names hand written steps step-1, x, x-2');
    ok(value(hand).goods_minor === goodsOf(hand) && goodsOf(hand) === 1200 + 100, `hand written steps: the server reads them the same way (${value(hand).goods_minor / 100})`);
    // Junk in the Combo words never breaks the function.
    const junk = box([pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-pizza', 'marg'), pick('st-drink', 'cola')]);
    junk[1].comboStepId = 7; junk[2].comboId = ''; junk[3].comboRole = 'chief';
    const vj = value(junk);
    ok(vj.goods_minor === goodsOf(junk) + 900 + 900 + 900, `odd Combo words are valued as plain lines (${vj.goods_minor / 100})`);
    ok(vj.items.map((l) => ('comboId' in l || 'comboRole' in l ? 1 : 0)).join('') === '10001', 'and lose those words: only the Combo line and its real pick keep them');
  }

  // ── 5. An order with no Combo: the live function's own answer ──
  {
    const baskets = [
      [plain('soup'), plain('marg', 2, [cheese]), plain('wings')],
      [plain('cola'), plain('lemon', 3)],
      [{ ...plain('calz-l'), name: 'Calzone — Large' }, plain('bread')],
      [plain('plain-combo'), plain('cake', 1, [{ id: 'ig-1-note', name: 'No nuts', price: 0, _instruction: true }])],
      [{ itemId: 'nope', name: 'Ghost', price: 1, qty: 1 }, 'junk', plain('soup')],
    ];
    let same = 0;
    for (const b of baskets) {
      for (const type of ['collection', 'delivery', 'dine-in']) {
        if (JSON.stringify(value(b, { type })) === JSON.stringify(value(b, { type, fn: '_pov_live' }))) same++;
      }
    }
    ok(same === baskets.length * 3, `an order with no Combo is valued exactly as live values it (${same} of ${baskets.length * 3})`);
  }

  // ── 6. The roll back ──
  {
    let r = psql({ input: BACK, allowFail: true });
    ok(r.status === 0 && r.stdout.trim().split('\n').pop() === 't|t', 'the roll back applies and its check row reads true', r.stderr);
    ok(md5Now() === LIVE_MD5, 'the function is back byte for byte (md5 as read on live)');
    ok(sql("select to_regprocedure('public.public_order_features()') is null") === 't', 'public_order_features is gone (the pages hide Combos again)');
    r = psql({ input: BACK, allowFail: true });
    ok(r.status === 0, 'a second roll back is fine');
    r = psql({ input: FWD, allowFail: true });
    ok(r.status === 0 && md5Now() === NEW_MD5, '20261217a applies again after the roll back');
    // It refuses a body it does not know, and changes nothing.
    psql({ input: BACK });
    sql(`create or replace function public._public_order_value(p_loc text, p_source text, p_type text, p_items jsonb, p_menu_id text default null) returns jsonb language plpgsql stable as $f$ begin return '{}'::jsonb; end $f$`);
    const before = md5Now();
    r = psql({ input: FWD, allowFail: true });
    ok(r.status !== 0 && /is not the body read on live/.test(r.stderr) && md5Now() === before && sql("select to_regprocedure('public.public_order_features()') is null") === 't',
      '20261217a refuses a body it does not know, and changes nothing', r.stderr.slice(0, 300));
  }
} finally {
  stop();
}
console.log(`\n${passes} of ${passes + failures} checks passed`);
process.exit(failures ? 1 : 0);
