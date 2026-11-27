// supabase/tests/multi_site_menu/combo.mjs
//
// COMBO STEPS IN THE MULTI SITE MENU (5.12.124, 20261216a_OPS_multi_site_menu_combo_steps.sql), on
// the local rig, run from run.mjs after menus.mjs. Every check is named COMBO.
//
// 20261216a is made from the LIVE text of three functions (read read only from Ops on 27 Nov 2026,
// ~/.claude/servos-release/combo_stage2/live) and refuses unless the functions are exactly those
// bodies. So this module first puts the rig where Ops is: 20261211a, 20261213a and 20261214a applied
// (as menus.mjs does), the company wipe check the live guard calls (a stand in that says "no wipe"
// when the rig has none), and then the three functions AS LIVE HAS THEM (their md5 must be the ones
// read on live). Then, through the database and the REAL planner, health check and snapshot builder:
//   * 20261216a refuses before 20261215a, and refuses a function that is not the body read;
//   * it applies as one transaction, twice; its check row reads as the file says; the bodies it
//     makes are the ones the generator worked out (so Ops gets exactly what was rehearsed);
//   * the guard: steps that name a product outside the menu, the Combo itself, or a bad shape are
//     refused; a site may keep its own steps; a new product a Combo's step names cannot be thrown
//     away on its own;
//   * publish: a new Combo lands at each site with that site's own items in its steps, a product a
//     site does not sell is left out there, a steps change writes only the steps, a second publish
//     writes nothing, a product turned on at a site joins the step there, the steps taken off come
//     off; the write path refuses a Combo naming another site's item;
//   * the roll back refuses while steps are anywhere in the group menu, then puts all three
//     functions back exactly as live has them and drops the column; twice.
// At the end the rig is put back as menus.mjs left it (the functions byte for byte, the three
// files rolled back), so run.mjs's own roll back checks run on what they expect.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { newItemId } from '../../functions/_shared/msmModel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGS = path.resolve(HERE, '..', '..', 'migrations');
const file = (n) => path.join(MIGS, n);
// The live text the migration was made from (outside the repo: production function text).
const LIVE = process.env.COMBO_LIVE_DIR || path.join(os.homedir(), '.claude', 'servos-release', 'combo_stage2', 'live');
const READ = {
  msm_changes_guard: 'e36061b4ce3b7974741e5e39b8dca496',
  msm_start_version: '188ea598a5d54f40932f5eae8583aeb0',
  msm_apply_site: '87be2da005dea0d49a4d068660ac8b8c',
};
const AFTER = {
  msm_changes_guard: 'c71ea4a7fb8e221617b42ef0725aa8f2',
  msm_start_version: '2abda0780f63ce0ae2080ee49a0021f8',
  msm_apply_site: 'cded0bbdf09a050156cb9674ab0e815b',
};
const NAMES = Object.keys(READ);
// jsonb keeps its keys in its own order: compare values, never key order.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

export async function run(h) {
  const { q, one, json, lit, psql, expect: expectRaw, central, mkSet, stage, runSite, LA1, LA2, LB1, U, as, SERVICE, sfx, DB } = h;
  const expect = (name, cond, detail) => expectRaw(`COMBO ${name}`, cond, detail);
  if (!fs.existsSync(path.join(LIVE, 'live_msm_apply_site.sql'))) {
    expect('the live function text is here to rehearse against (set COMBO_LIVE_DIR)', false, LIVE);
    return;
  }
  let r;
  const MD5 = (n) => one(`select md5(p.prosrc) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = '${n}'`);
  const DEF = (n) => one(`select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = '${n}'`);
  const runFile = (n, single = true) => psql(['-d', DB, ...(single ? ['-1'] : []), '-At', '-f', file(n)]);
  const publish = (set) => {
    const V = json(`select msm_publish_now('${set}', true)`, as(U.E)).version_id;
    one(`select count(*) from msm_claim_due(20)`, SERVICE);
    json(`select msm_start_version('${V}')`, SERVICE);
    return V;
  };
  // The group menu may hold more sites than the two this module looks at (an earlier module joins a
  // third): each of the version's OTHER sites is run too, so the version and its set finish as they
  // do on Ops (each of those has nothing of these products, so it writes nothing).
  const finishOthers = (V, mine = [LA1, LA2]) => {
    for (const loc of (one(`select string_agg(location_id::text, ',') from msm_version_sites where version_id = '${V}'`) || '').split(',').filter(Boolean)) {
      if (!mine.includes(loc)) runSite(V, loc);
    }
  };
  one(`update msm_version_sites set status = 'done' where status in ('scheduled', 'running')`);

  // ── put the rig where Ops is ────────────────────────────────────────────────
  const rigDefs = Object.fromEntries(NAMES.map((n) => [n, DEF(n)]));
  const rigMd5 = Object.fromEntries(NAMES.map((n) => [n, MD5(n)]));
  for (const f of ['20261211a_OPS_multi_site_menu_category_rename.sql', '20261213a_OPS_option_group_once_each.sql', '20261214a_OPS_multi_site_menu_several_menus.sql']) {
    r = runFile(f);
    expect(`${f.slice(0, 9)} applies first, as on Ops`, r.code === 0, r.err);
  }
  const hadWipe = one(`select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'admin_wipe__active'`) !== '0';
  if (!hadWipe) one(`create function public.admin_wipe__active() returns boolean language sql stable set search_path to '' as $f$ select false $f$`);
  for (const n of NAMES) {
    r = psql(['-d', DB, '-1', '-At', '-f', path.join(LIVE, `live_${n}.sql`)]);
    if (r.code) expect(`the live ${n} loads`, false, r.err);
  }
  expect('the rig now runs the three functions exactly as read on live (md5 of each body)', NAMES.every((n) => MD5(n) === READ[n]), NAMES.map((n) => `${n} ${MD5(n)}`).join(' '));

  // ── refusals before anything is changed ─────────────────────────────────────
  const hasCol = (t) => one(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = '${t}' and column_name = 'combo'`) === '1';
  if (hasCol('menu_items')) one(`alter table public.menu_items drop column combo`);
  r = runFile('20261216a_OPS_multi_site_menu_combo_steps.sql');
  expect('20261216a refuses before 20261215a (menu_items.combo), in words, and adds nothing', r.code !== 0 && /Run 20261215a/.test(r.err) && !hasCol('msm_products'), r.err);
  r = runFile('20261215a_OPS_menu_item_combo_steps.sql', false);
  expect('20261215a (stage 1) applies', r.code === 0 && hasCol('menu_items'), r.err);
  // A function that is not the body read on live: refused whole.
  const liveStart = fs.readFileSync(path.join(LIVE, 'live_msm_start_version.sql'), 'utf8');
  one(liveStart.replace('declare\n', 'declare\n  -- changed on live after it was read\n'));
  r = runFile('20261216a_OPS_multi_site_menu_combo_steps.sql');
  expect('20261216a refuses when a function is not the body read on live, names it, and changes nothing',
    r.code !== 0 && /not the ones this file was made from: msm_start_version/.test(r.err) && !hasCol('msm_products') && MD5('msm_changes_guard') === READ.msm_changes_guard, r.err);
  r = psql(['-d', DB, '-1', '-At', '-f', path.join(LIVE, 'live_msm_start_version.sql')]);
  expect('the live body is put back', r.code === 0 && MD5('msm_start_version') === READ.msm_start_version, r.err);

  // ── the file ────────────────────────────────────────────────────────────────
  r = runFile('20261216a_OPS_multi_site_menu_combo_steps.sql');
  expect('20261216a applies as one transaction', r.code === 0, r.err);
  const once = NAMES.map(MD5).join(',');
  expect('the bodies it makes are the ones the generator worked out from the live text', NAMES.every((n) => MD5(n) === AFTER[n]), once);
  r = runFile('20261216a_OPS_multi_site_menu_combo_steps.sql');
  expect('20261216a applies a second time and changes nothing more', r.code === 0 && NAMES.map(MD5).join(',') === once, r.err);
  expect('the check row reads as the file says', r.out.split('\n').pop() === 't|t|t|t|t|3|0|t|0', r.out);
  // The read only check Peter can run any time after (a copy sits beside this file).
  const chk = psql(['-d', DB, '-At', '-f', path.join(HERE, 'combo_check_20261216a.sql')]);
  expect('the read only check reads the same (and no site keeps steps yet)', chk.code === 0 && chk.out.split('\n').pop().startsWith('t|t|t|t|t|3|0|t|0|0|'), chk.err || chk.out);
  expect('the wipe check live already has is still in the guard', DEF('msm_changes_guard').includes('public.admin_wipe__active()'));
  expect('only the three functions changed: their grants are as they were (service role runs publish)', one(`select has_function_privilege('authenticated', 'public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text,uuid)'::regprocedure, 'execute')::text`) === 'false');

  // ── products to build with ──────────────────────────────────────────────────
  let C = central();
  const menuId = C.menu.id;
  const hot = C.categories.find((c) => c.label === 'Hot drinks');
  const TEA = 'c0b10000-0000-4000-8000-000000000001';   // first 12 characters differ: each gets its own venue id
  const CAKE = 'c0b20000-0000-4000-8000-000000000002';
  const DEAL = 'c0b30000-0000-4000-8000-000000000003';
  const vid = (id, loc) => newItemId({ id }, loc);
  const product = (id, name, price, extra = {}) => ({ name, category_id: hot.id, default_price: price, tax_rate_name: 'VAT', tax_rate_percent: 20, type: 'simple', sold_alone: true, ...extra });
  const S0 = mkSet('Combo: tea and cake');
  for (const [id, name, price, locs] of [[TEA, 'Combo tea', 2, [LA1, LA2]], [CAKE, 'Combo cake', 3, [LA1]]]) {
    stage({ set: S0, target: 'product', entity: id, op: 'create', after: product(id, name, price) });
    for (const loc of locs) stage({ set: S0, target: 'product_site', entity: id, loc, op: 'create', after: { venue_item_id: vid(id, loc), active: true } });
  }
  let V = publish(S0);
  for (const loc of [LA1, LA2]) runSite(V, loc);
  finishOthers(V);
  expect('the tea is at both sites and the cake at A1 only', one(`select string_agg(id, ',' order by id) from menu_items where id in ('${vid(TEA, LA1)}', '${vid(TEA, LA2)}', '${vid(CAKE, LA1)}', '${vid(CAKE, LA2)}')`)
    === [vid(TEA, LA1), vid(TEA, LA2), vid(CAKE, LA1)].sort().join(','));

  const steps = (teaIds, cakeIds) => ({ v: 1, steps: [
    { id: 'st-tea', name: 'Pick a tea', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: teaIds.map((itemId) => ({ itemId, bump: 0 })) },
    { id: 'st-cake', name: 'Add cake?', selectionType: 'multiple', min: 0, max: 1, pricing: 'own', products: cakeIds.map((itemId) => ({ itemId, bump: 0 })) },
  ] });

  // ── the guard ───────────────────────────────────────────────────────────────
  const SG = mkSet('Combo: guard');
  const dealAfter = (combo) => ({ ...product(DEAL, 'Tea and cake', 4.5), type: 'combo', combo });
  r = stage({ set: SG, target: 'product', entity: DEAL, op: 'create', after: dealAfter(steps([TEA, '00000000-0000-4000-8000-0000000000ff'], [])) });
  expect('the guard refuses a step that names a product outside this group menu', r.code !== 0 && /names a product that is not in this group menu/.test(r.err), r.err);
  r = stage({ set: SG, target: 'product', entity: DEAL, op: 'create', after: dealAfter(steps([TEA, DEAL], [])) });
  expect('the guard refuses a Combo that names itself', r.code !== 0 && /not in this group menu/.test(r.err), r.err);
  r = stage({ set: SG, target: 'product', entity: DEAL, op: 'create', after: dealAfter(steps([TEA, 'not-a-uuid'], [])) });
  expect('the guard refuses a step product that is not an id', r.code !== 0 && /not in this group menu/.test(r.err), r.err);
  for (const bad of ['"x"', '{"v": 1}', '{"steps": "x"}', '[1]']) {
    r = stage({ set: SG, target: 'product', entity: DEAL, op: 'create', after: { ...dealAfter(null), combo: JSON.parse(bad) } });
    expect(`the guard refuses steps shaped ${bad}`, r.code !== 0 && /must be a list of steps/.test(r.err), r.err);
  }
  // A new product named by a new Combo's step in the same draft: allowed, and kept while it is used.
  const NEWP = 'c0b40000-0000-4000-8000-000000000004';
  r = stage({ set: SG, target: 'product', entity: NEWP, op: 'create', after: product(NEWP, 'Combo scone', 2.5) });
  expect('a new product is staged', r.code === 0, r.err);
  r = stage({ set: SG, target: 'product', entity: DEAL, op: 'create', after: dealAfter(steps([TEA], [NEWP])) });
  expect('the guard takes a Combo whose step names a product new in the same draft', r.code === 0, r.err);
  r = q(`delete from msm_changes where change_set_id = '${SG}' and target = 'product' and entity_id = '${NEWP}'`, as(U.E));
  expect('a new product a Combo\'s step still names cannot be thrown away on its own, in words', r.code !== 0 && /a step of a Combo/.test(r.err), r.err);
  // Throwing the whole draft away (the app deletes the set; its changes go with it) still works.
  r = q(`delete from msm_change_sets where id = '${SG}'`, as(U.E));
  expect('the whole draft is still thrown away in one go', r.code === 0 && one(`select count(*) from msm_changes where change_set_id = '${SG}'`) === '0', r.err);
  const SK = mkSet('Combo: a site keeps its own');
  r = stage({ set: SK, target: 'product_site', entity: TEA, loc: LA1, op: 'update', after: { kept: { combo: steps([vid(TEA, LA1)], []) } } });
  expect('a site may keep its own steps (kept combo)', r.code === 0, r.err);
  q(`delete from msm_change_sets where id = '${SK}'`, as(U.E));

  // ── publish: a new Combo at two sites ───────────────────────────────────────
  const S1 = mkSet('Combo: tea and cake deal');
  stage({ set: S1, target: 'product', entity: DEAL, op: 'create', after: dealAfter(steps([TEA], [CAKE])) });
  for (const loc of [LA1, LA2]) stage({ set: S1, target: 'product_site', entity: DEAL, loc, op: 'create', after: { venue_item_id: vid(DEAL, loc), active: true } });
  V = publish(S1);
  expect('the group menu holds the steps (the guard and the publish both took them)', same(json(`select combo from msm_products where id = '${DEAL}'`), steps([TEA], [CAKE])));
  const p1 = runSite(V, LA1);
  const p2 = runSite(V, LA2);
  finishOthers(V);
  expect('site A1 published, site A2 published', p1.out?.ok && p2.out?.ok, `${p1.res.err} | ${p2.res.err}`);
  const comboAt = (loc) => json(`select combo from menu_items where id = '${vid(DEAL, loc)}'`);
  expect('site A1: the Combo names A1\'s own tea and cake', same(comboAt(LA1), steps([vid(TEA, LA1)], [vid(CAKE, LA1)])), JSON.stringify(comboAt(LA1)));
  expect('site A2: the cake is not sold there, so the step that could be skipped is left out', same(comboAt(LA2), { v: 1, steps: [steps([vid(TEA, LA2)], []).steps[0]] }), JSON.stringify(comboAt(LA2)));
  expect('site A2: said as a warning, and the site still published', p2.plan.problems.some((x) => x.code === 'combo_pick_left_out' && x.level === 'warn') && p2.health.ok, JSON.stringify(p2.plan.problems));
  expect('the Combo is a Combo at both sites', one(`select string_agg(type, ',') from menu_items where id in ('${vid(DEAL, LA1)}', '${vid(DEAL, LA2)}')`) === 'combo,combo');
  expect('the POS gets the steps (the config push carries them)', json(`select snapshot from config_pushes where id = '${p1.out.push_id}'`).menuItems.some((i) => i.id === vid(DEAL, LA1) && i.combo && i.combo.steps.length === 2));

  // ── a steps change writes only the steps; a second publish writes nothing ───
  const S2 = mkSet('Combo: Latte in the tea step');
  C = central();
  const latte = C.products.find((p) => p.name === 'Latte' && !p.parent_product_id);
  stage({ set: S2, target: 'product', entity: DEAL, op: 'update', after: { combo: steps([TEA, latte.id], [CAKE]) }, before: { combo: steps([TEA], [CAKE]) } });
  V = publish(S2);
  const q1 = runSite(V, LA1);
  const q2 = runSite(V, LA2);
  finishOthers(V);
  const latteAt = (loc) => C.productSites.find((x) => x.product_id === latte.id && x.location_id === loc).venue_item_id;
  expect('a steps change writes only the steps, at each site', q1.out?.ok && q2.out?.ok && q1.plan.lines.every((l) => l.column === 'combo') && q2.plan.lines.every((l) => l.column === 'combo') && q1.plan.lines.length === 1, JSON.stringify(q1.plan.lines));
  expect('each site names its own Latte', comboAt(LA1).steps[0].products.map((x) => x.itemId).join(',') === `${vid(TEA, LA1)},${latteAt(LA1)}`
    && comboAt(LA2).steps[0].products.map((x) => x.itemId).join(',') === `${vid(TEA, LA2)},${latteAt(LA2)}`, JSON.stringify([comboAt(LA1), comboAt(LA2)]));
  const S2b = mkSet('Combo: the same again');
  stage({ set: S2b, target: 'product', entity: DEAL, op: 'update', after: { name: 'Tea and cake' } });
  V = publish(S2b);
  expect('a publish that touches the Combo again writes nothing new at either site', runSite(V, LA1).plan.lines.length === 0 && runSite(V, LA2).plan.lines.length === 0);
  finishOthers(V);

  // ── a product turned on at a site joins the step there ──────────────────────
  const S3 = mkSet('Combo: cake at A2');
  stage({ set: S3, target: 'product_site', entity: CAKE, loc: LA2, op: 'create', after: { venue_item_id: vid(CAKE, LA2), active: true } });
  V = publish(S3);
  const t2 = runSite(V, LA2);
  finishOthers(V, [LA2]);
  expect('the cake goes on sale at A2, and the Combo there takes it into its step in the same publish', t2.out?.ok && comboAt(LA2).steps.length === 2 && comboAt(LA2).steps[1].products[0].itemId === vid(CAKE, LA2), JSON.stringify(comboAt(LA2)));

  // ── the write path refuses another site's item ──────────────────────────────
  const SW = mkSet('Combo: tamper');
  stage({ set: SW, target: 'product', entity: DEAL, op: 'update', after: { name: 'Tea and cake deal' } });
  V = publish(SW);
  const bad = { items: { update: [{ id: vid(DEAL, LA1), set: { combo: steps([vid(TEA, LA2)], []) } }], insert: [] } };
  const w1 = runSite(V, LA1, { writesOverride: bad });
  expect('the write path refuses a Combo that names another site\'s item (change)', w1.res.code !== 0 && /A Combo would name a product that is not at this site/.test(w1.res.err), w1.res.err);
  expect('and writes nothing', JSON.stringify(comboAt(LA1).steps[0].products.map((x) => x.itemId)) === JSON.stringify([vid(TEA, LA1), latteAt(LA1)]));
  const badNew = { items: { insert: [{ id: `msm-c0b0bad00000_${sfx(LA1)}`, name: 'Bad deal', type: 'combo', cat: one(`select cat from menu_items where id = '${vid(DEAL, LA1)}'`), pricing: { base: 1 }, scope: 'local', combo: steps(['m-b'], []) }], update: [] } };
  const w2 = runSite(V, LA1, { writesOverride: badNew });
  expect('the write path refuses a new Combo that names another site\'s item', w2.res.code !== 0 && /A new Combo would name a product that is not at this site/.test(w2.res.err), w2.res.err);
  one(`update msm_version_sites set status = 'done' where status in ('scheduled', 'running', 'failed')`);

  // ── the roll back ───────────────────────────────────────────────────────────
  r = runFile('20261216a_OPS_multi_site_menu_combo_steps_ROLLBACK.sql');
  expect('the roll back refuses while a group product holds steps, in words, and changes nothing', r.code !== 0 && /still holds Combo steps/.test(r.err) && hasCol('msm_products') && MD5('msm_apply_site') === AFTER.msm_apply_site, r.err);
  const S4 = mkSet('Combo: steps off');
  stage({ set: S4, target: 'product', entity: DEAL, op: 'update', after: { combo: null }, before: { combo: steps([TEA, latte.id], [CAKE]) } });
  V = publish(S4);
  const u1 = runSite(V, LA1);
  runSite(V, LA2);
  finishOthers(V);
  expect('the steps come off at each site with the group menu\'s', u1.out?.ok && comboAt(LA1) === null && comboAt(LA2) === null);
  // A draft in which a site keeps its own steps also holds the roll back (review of 27 Nov 2026).
  const SR = mkSet('Combo: a site keeps its own, waiting');
  stage({ set: SR, target: 'product_site', entity: TEA, loc: LA1, op: 'update', after: { kept: { combo: steps([vid(TEA, LA1)], []) } } });
  r = runFile('20261216a_OPS_multi_site_menu_combo_steps_ROLLBACK.sql');
  expect('the roll back refuses while a draft keeps a site\'s own steps, in words', r.code !== 0 && /still carries Combo steps/.test(r.err) && hasCol('msm_products'), r.err);
  q(`delete from msm_change_sets where id = '${SR}'`, as(U.E));
  r = runFile('20261216a_OPS_multi_site_menu_combo_steps_ROLLBACK.sql');
  const holding = () => one(`select string_agg(s.title || ' (' || s.status || ')', ', ') from msm_changes x join msm_change_sets s on s.id = x.change_set_id where x.after ? 'combo' and jsonb_typeof(x.after -> 'combo') <> 'null'`);
  expect('the roll back runs', r.code === 0, `sets with steps: ${holding()} | ${r.err}`);
  expect('the roll back check row: the column gone, the three functions back as live has them', r.out.split('\n').pop() === 't|t|t|t', r.out);
  expect('every function is back byte for byte (md5 of each body as read on live)', NAMES.every((n) => MD5(n) === READ[n]), NAMES.map(MD5).join(','));
  r = runFile('20261216a_OPS_multi_site_menu_combo_steps_ROLLBACK.sql');
  expect('the roll back runs a second time and changes nothing', r.code === 0 && NAMES.every((n) => MD5(n) === READ[n]), r.err);
  expect('a site keeps its own menu_items.combo column (20261215a\'s), and every venue row', hasCol('menu_items'));

  // ── put the rig back as menus.mjs left it ───────────────────────────────────
  r = runFile('20261215a_OPS_menu_item_combo_steps_ROLLBACK.sql', false);
  expect('20261215a rolls back on the rig', r.code === 0 && !hasCol('menu_items'), r.err);
  for (const f of ['20261214a_OPS_multi_site_menu_several_menus_ROLLBACK.sql', '20261213a_OPS_option_group_once_each_ROLLBACK.sql', '20261211a_OPS_multi_site_menu_category_rename_ROLLBACK.sql']) {
    r = runFile(f);
    expect(`${f.slice(0, 9)} rolls back as menus.mjs did`, r.code === 0, r.err);
  }
  for (const n of NAMES) one(rigDefs[n]);
  if (!hadWipe) one(`drop function public.admin_wipe__active()`);
  expect('the rig is back as menus.mjs left it: the three functions byte for byte', NAMES.every((n) => MD5(n) === rigMd5[n]), NAMES.map(MD5).join(','));
  void LB1; void menuId;
}
