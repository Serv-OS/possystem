// supabase/tests/multi_site_menu/round2.mjs
//
// ROUND 2 of the Multi site menu (20261017c_OPS_multi_site_menu_groups.sql) on the same throwaway
// Postgres as run.mjs, driven end to end with the real planner and push builder. Called by run.mjs
// once the round 1 checks have run (its database, people and helpers are passed in).
//
// What it proves:
//   * the staging guard for the four new targets, and VAT per order type;
//   * an option price at one site writes ONLY that option, by its venue id; an option the group
//     menu does not know stays where it is; the till push entry of every written group equals the
//     row the database now holds;
//   * a new option gets opt-msm-<12 hex>, recorded centrally in the same transaction; the same
//     version twice gives one option; off and back on keeps the same id;
//   * a sub item missing at a site is added there as option only and recorded;
//   * VAT by order type: only the four keys, the site's counter key and explicit null stay, rates of
//     THIS site only; the tax profile copy cleared and put back (Undo), a real profile refused;
//   * the row lock comes before the fingerprint (a save holding the row makes publish wait);
//   * the contract: keys this database does not know are refused;
//   * the managed lists, sold recently, trading now;
//   * public.msm__is_legacy_mirror against the shared fixture list (msmMirrorFixtures.js);
//   * the one time refresh (public.msm_import_groups): saved only when every site is as read, once,
//     never while a draft holds option group changes, and then publishing would change nothing.
//   * Peter's repro (UI issues 8, 10, 11): a product with three sizes sold at site A1 only (marked
//     the way round 1 imported it) is ticked with its sizes, turned on at A2 and one size priced
//     there: staged, published through msm_apply_site, and A2 holds the product and its sizes.
//   * 17 Oct recheck: a site's missing price is kept (the guard and the import take kept no_price,
//     publish never gives it a price nobody set there, a price set there lands, Undo writes no price
//     again); a turn on over a site's own product is refused at once in words; a takeaway Zero
//     Rate on a product with sizes lands on the product and every size, and Undo puts them back.

import { spawn, spawnSync } from 'node:child_process';
import { planSite, touchedFromChanges } from '../../functions/_shared/msmPlan.js';
import { refreshGroupsPayload, touchEverything, proposeImport, buildCentral, importPayload } from '../../functions/_shared/msmImport.js';
import { newOptionId, longOptionId, newItemId } from '../../functions/_shared/msmModel.js';
import { activeMany, siteActiveChange, sitePriceChange } from '../../../src/lib/msm/msmEdit.js';
import { mapModifierGroupRow } from '../../functions/_shared/venueMenuCore.js';
import { MIRROR_CASES, MIRROR_RATE_ID, MIRROR_OTHER_RATE_ID } from '../../../src/lib/msm/msmMirrorFixtures.js';
import { ownProducts, bringInChanges } from '../../../src/lib/msm/msmBringIn.js';
import { randomUUID } from 'node:crypto';

export async function run(h) {
  const { q, one, json, lit, expect, central, readRaw, mkSet, stage, runSite, menuId, ORG_A, ORG_B, LA1, LA2, LB1, U, as, SERVICE, sfx, VAT_A1, VAT_A2, VAT_B1, DB, CONN } = h;
  let r;
  const settle = () => one(`update msm_version_sites set status = 'done' where status in ('scheduled', 'running')`);
  const publish = (set) => {
    const V = json(`select msm_publish_now('${set}', true)`, as(U.E)).version_id;
    one(`select count(*) from msm_claim_due(20)`, SERVICE);
    json(`select msm_start_version('${V}')`, SERVICE);
    return V;
  };
  const groupRow = (id) => json(`select to_json(g) from modifier_groups g where id = '${id}'`);
  const canonJ = (v) => JSON.stringify((function c(x) { return Array.isArray(x) ? x.map(c) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, c(x[k])])) : x; })(v));
  // The planner's picture of every group it wrote equals the row the database now holds (design
  // review: the till push and the table can never disagree).
  const planMatchesDb = (run) => (run.plan.writtenGroupIds || []).every((id) => {
    const mine = run.plan.applied.groups.find((g) => g.id === id);
    const db = groupRow(id);
    return mine && db && canonJ(mine.options) === canonJ(db.options) && Number(mine.min ?? 0) === Number(db.min) && Number(mine.max ?? 1) === Number(db.max) && mine.name === db.name;
  });
  settle();

  let C = central();
  const milk = C.groups.find((g) => g.name === 'Milk');
  const oat = C.options.find((o) => o.group_id === milk.id && o.name === 'Oat milk');
  const latte = C.products.find((p) => p.name === 'Latte');
  expect('ROUND 2 import: the Milk options are rows, on at site A1 with the venue id kept',
    !!oat && C.optionSites.some((x) => x.option_id === oat.id && x.location_id === LA1 && x.venue_option_id === 'opt-1' && x.active === true), JSON.stringify(C.options));
  expect('ROUND 2 import: the menu is ready for round 2 changes (refreshed)', one(`select refreshed_at is not null from msm_menus where id = '${menuId}'`) === 't');
  expect('ROUND 2: msm_sql_contract() is 2 for the server and a signed in person', one(`select msm_sql_contract()`, SERVICE) === '2' && one(`select msm_sql_contract()`, as(U.E)) === '2');

  // ── the guard ─────────────────────────────────────────────────────────────
  const G0 = mkSet('Round 2 guard');
  r = stage({ set: G0, target: 'modifier_option', entity: oat.id, op: 'update', after: { group_id: milk.id } });
  expect('guard: an option cannot move to another group', r.code !== 0 && /cannot move to another group/.test(r.err), r.err);
  r = stage({ set: G0, target: 'modifier_option_site', entity: oat.id, loc: LB1, op: 'update', after: { price: 1 } });
  expect('guard: an option at a site of another company is refused', r.code !== 0 && /not in this company/.test(r.err), r.err);
  r = stage({ set: G0, target: 'modifier_group', entity: milk.id, op: 'update', after: { selection_type: 'lots' } });
  expect('guard: an option group\'s choice kind is one of three', r.code !== 0 && /one choice, several choices/.test(r.err), r.err);
  r = stage({ set: G0, target: 'modifier_group', entity: milk.id, op: 'update', after: { colour: 'red' } });
  expect('guard: a field the option group target does not allow is refused', r.code !== 0 && /cannot be changed here/.test(r.err), r.err);
  r = stage({ set: G0, target: 'product', entity: latte.id, op: 'update', after: { tax_by_type: { counter: { name: 'VAT', percent: 20 } } } });
  expect('guard: VAT by order type takes only eat in, takeaway, delivery and bar', r.code !== 0 && /Unknown order type for VAT: counter/.test(r.err), r.err);
  r = stage({ set: G0, target: 'product', entity: latte.id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate' } } } });
  expect('guard: VAT by order type needs a rate name and a percent', r.code !== 0 && /rate name and a percent/.test(r.err), r.err);
  r = stage({ set: G0, target: 'product_site', entity: latte.id, loc: LA1, op: 'update', after: { kept: { tax_overrides: { takeaway: true } } } });
  expect('guard: kept VAT by order type is a rate id, null or false, never true', r.code !== 0 && /Kept VAT by order type/.test(r.err), r.err);
  r = stage({ set: G0, target: 'modifier_option_site', entity: oat.id, loc: LA1, op: 'update', after: { venue_option_id: 'opt-x' } });
  expect('guard: a site\'s own option id never changes', r.code !== 0 && /never changes/.test(r.err), r.err);
  r = stage({ set: G0, target: 'product', entity: latte.id, op: 'update', after: { modifier_groups: [{ groupId: '00000000-0000-4000-8000-0000000000ff' }] } });
  expect('guard: a product\'s option groups are this menu\'s own', r.code !== 0 && /option group is not in this group menu/.test(r.err), r.err);
  // A new option thrown away takes its site rows with it.
  const OX = 'f1000000-0000-4000-8000-0000000000aa';
  stage({ set: G0, target: 'modifier_option', entity: OX, op: 'create', after: { group_id: milk.id, name: 'Throw away', price: 0.1 } });
  stage({ set: G0, target: 'modifier_option_site', entity: OX, loc: LA1, op: 'create', after: { active: true } });
  r = q(`delete from msm_changes where change_set_id = '${G0}' and target = 'modifier_option' and entity_id = '${OX}'`, as(U.E));
  expect('guard: throwing away a new option takes its site rows with it', r.code === 0 && one(`select count(*) from msm_changes where change_set_id = '${G0}'`) === '0', r.err);
  one(`delete from msm_change_sets where id = '${G0}'`);

  // ── an option price at one site, written option by option ─────────────────
  one(`update modifier_groups set options = options || '[{"id": "opt-venue", "name": "Hemp milk", "price": 0.6}]'::jsonb where id = 'mgd-milk'`);
  const G1 = mkSet('Oat milk at A1');
  r = stage({ set: G1, target: 'modifier_option_site', entity: oat.id, loc: LA1, op: 'update', after: { price: 0.55 }, before: { price: null } });
  expect('an option price at one site is staged', r.code === 0, r.err);
  const V1 = publish(G1);
  const a1 = runSite(V1, LA1);
  expect('publish: the option price at A1 lands (one option patched by its venue id)', a1.out?.ok === true && a1.out.push_id, a1.res.err || JSON.stringify(a1.health));
  const g1 = groupRow('mgd-milk');
  expect('the planner\'s picture of the group equals the database row (patch)', planMatchesDb(a1));
  expect('only the oat option changed, ONLY its price; the venue\'s own Hemp milk is where it was',
    JSON.stringify(g1.options) === JSON.stringify([{ id: 'opt-1', name: 'Oat milk', price: 0.55, itemId: 'm-oat' }, { id: 'opt-venue', name: 'Hemp milk', price: 0.6 }]), JSON.stringify(g1.options));
  const push1 = json(`select snapshot from config_pushes where id = '${a1.out.push_id}'`);
  const def1 = push1.modifierGroupDefs.find((d) => d.id === 'mgd-milk');
  // The same shape venueMenuCore.mapModifierGroupRow gives (key order aside: jsonb sorts keys).
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  expect('the till push entry of the written group equals the row the database holds (mapped as Push to POS maps it)',
    JSON.stringify(canon(def1)) === JSON.stringify(canon(mapModifierGroupRow(g1))), `${JSON.stringify(canon(def1))} vs ${JSON.stringify(canon(mapModifierGroupRow(g1)))}`);
  expect('the audit keeps the group before and after', json(`select writes from msm_version_sites where version_id = '${V1}' and location_id = '${LA1}'`).some((w) => w.table === 'groups' && w.before.options[0].price === 0.4 && w.after.options[0].price === 0.55));
  r = q(`select msm_apply_site('${V1}', '${LA1}', '{}'::jsonb, null, 'x')`, SERVICE);
  expect('the same version again does nothing (idempotent)', r.code === 0 && JSON.parse(r.out).already === true, r.err);
  expect('site A2 has no Milk group: nothing there', one(`select status from msm_version_sites where version_id = '${V1}' and location_id = '${LA2}'`) === '' || one(`select count(*) from msm_version_sites where version_id = '${V1}' and location_id = '${LA2}'`) === '0');
  settle();

  // ── a new option: its id, recorded centrally; twice gives one; off and back on keeps it ──
  const SOYA = 'f1000000-0000-4000-8000-00000000050a';
  const G2 = mkSet('Soya');
  stage({ set: G2, target: 'modifier_option', entity: SOYA, op: 'create', after: { group_id: milk.id, name: 'Soya milk', price: 0.45, sort_order: 1 } });
  stage({ set: G2, target: 'modifier_option_site', entity: SOYA, loc: LA1, op: 'create', after: { active: true } });
  const V2 = publish(G2);
  const a2 = runSite(V2, LA1);
  expect('publish: a new option at A1', a2.out?.ok === true, a2.res.err || JSON.stringify(a2.health));
  const g2 = groupRow('mgd-milk');
  expect('its id is opt-msm-<12 hex>, right after the option before it; the venue\'s own still last',
    g2.options.map((o) => o.id).join(',') === ['opt-1', newOptionId(SOYA), 'opt-venue'].join(','), JSON.stringify(g2.options));
  expect('the planner\'s picture equals the database row (add)', planMatchesDb(a2));
  expect('its venue id is recorded centrally in the same transaction', one(`select venue_option_id from msm_modifier_option_sites where option_id = '${SOYA}' and location_id = '${LA1}'`) === newOptionId(SOYA));
  r = q(`select msm_apply_site('${V2}', '${LA1}', '{}'::jsonb, null, 'x')`, SERVICE);
  expect('the same version twice: one option, not two', r.code === 0 && JSON.parse(r.out).already === true && groupRow('mgd-milk').options.filter((o) => o.id === newOptionId(SOYA)).length === 1);
  settle();
  const G3 = mkSet('Soya off');
  stage({ set: G3, target: 'modifier_option_site', entity: SOYA, loc: LA1, op: 'update', after: { active: false }, before: { active: true } });
  const a3 = runSite(publish(G3), LA1);
  expect('the planner\'s picture equals the database row (off)', planMatchesDb(a3));
  expect('off at A1: the entry leaves the list', a3.out?.ok === true && !groupRow('mgd-milk').options.some((o) => o.id === newOptionId(SOYA)), a3.res.err);
  settle();
  const G4 = mkSet('Soya on');
  stage({ set: G4, target: 'modifier_option_site', entity: SOYA, loc: LA1, op: 'update', after: { active: true }, before: { active: false } });
  const a4 = runSite(publish(G4), LA1);
  expect('the planner\'s picture equals the database row (back on)', planMatchesDb(a4));
  expect('back on: the SAME id, in its place', a4.out?.ok === true && groupRow('mgd-milk').options.map((o) => o.id).join(',') === ['opt-1', newOptionId(SOYA), 'opt-venue'].join(','), a4.res.err || JSON.stringify(groupRow('mgd-milk').options));
  settle();

  // ── a sub item missing at the site: added there as option only, and recorded ──
  const ALM = 'f1000000-0000-4000-8000-0000000000a1';
  const ALMO = 'f1000000-0000-4000-8000-0000000000a2';
  const G5 = mkSet('Almond');
  stage({ set: G5, target: 'product', entity: ALM, op: 'create', after: { name: 'Almond milk', type: 'subitem', sold_alone: false, default_price: 0.5, visibility: { pos: false, kiosk: false, online: false, onlineDelivery: false } } });
  stage({ set: G5, target: 'modifier_option', entity: ALMO, op: 'create', after: { group_id: milk.id, name: 'Almond milk', price: 0.5, product_id: ALM, sort_order: 2 } });
  stage({ set: G5, target: 'modifier_option_site', entity: ALMO, loc: LA1, op: 'create', after: { active: true } });
  const a5 = runSite(publish(G5), LA1);
  expect('publish: the option with its sub item', a5.out?.ok === true, a5.res.err || JSON.stringify(a5.health));
  const almRow = json(`select to_json(i) from menu_items i where i.location_id = '${LA1}' and i.name = 'Almond milk'`);
  expect('the sub item is at A1 as option only (a sub item, not sold on its own, hidden everywhere)',
    almRow && almRow.type === 'subitem' && almRow.sold_alone === false && almRow.visibility.pos === false && almRow.cat === null, JSON.stringify(almRow));
  expect('Almond and Soya share their first 12 characters: Almond gets the whole id, Soya\'s entry is untouched',
    groupRow('mgd-milk').options.find((o) => o.id === newOptionId(SOYA))?.name === 'Soya milk' && groupRow('mgd-milk').options.some((o) => o.id === longOptionId(ALMO)), JSON.stringify(groupRow('mgd-milk').options));
  expect('and recorded centrally; the option points at it', one(`select venue_item_id from msm_product_sites where product_id = '${ALM}' and location_id = '${LA1}'`) === almRow?.id
    && groupRow('mgd-milk').options.find((o) => o.name === 'Almond milk')?.itemId === almRow?.id);
  settle();

  // ── a new order: the group menu's options take the places they hold; the venue's own stays ──
  {
    C = central();
    const before = groupRow('mgd-milk').options.map((o) => o.id);
    const G12 = mkSet('New order');
    const want = [ALMO, oat.id, SOYA];
    want.forEach((id, i) => stage({ set: G12, target: 'modifier_option', entity: id, op: 'update', after: { sort_order: i }, before: { sort_order: C.options.find((o) => o.id === id).sort_order } }));
    const a12 = runSite(publish(G12), LA1);
    const now = groupRow('mgd-milk').options.map((o) => o.id);
    const venueSlot = before.indexOf('opt-venue');
    expect('reorder: the planner\'s picture equals the database row', a12.out?.ok === true && planMatchesDb(a12), a12.res.err || JSON.stringify(now));
    expect('reorder: the group menu\'s options in its new order, the venue\'s own Hemp milk in its own place',
      now[venueSlot] === 'opt-venue' && now.filter((x) => x !== 'opt-venue').join(',') === [longOptionId(ALMO), 'opt-1', newOptionId(SOYA)].join(','), `${before} -> ${now}`);
    settle();
  }

  // ── review: a product SOLD on its own that an option adds at a site is recorded OFF there (not on
  //    sale); turned on there later, its option only row is written whole so the till shows it ──
  {
    const HAZ = 'e2a10000-0000-4000-8000-0000000000b1';
    const HAZO = 'e2a20000-0000-4000-8000-0000000000b2';
    const cat = central().categories.find((c) => !c.archived && !c.parent_id);
    const G5b = mkSet('Hazelnut');
    stage({ set: G5b, target: 'product', entity: HAZ, op: 'create', after: { name: 'Hazelnut shot', type: 'subitem', sold_alone: true, default_price: 1.2, category_id: cat.id, visibility: { pos: true, kiosk: true, online: true, onlineDelivery: true } } });
    stage({ set: G5b, target: 'modifier_option', entity: HAZO, op: 'create', after: { group_id: milk.id, name: 'Hazelnut shot', price: 0.6, product_id: HAZ, sort_order: 3 } });
    stage({ set: G5b, target: 'modifier_option_site', entity: HAZO, loc: LA1, op: 'create', after: { active: true } });
    const h1 = runSite(publish(G5b), LA1);
    expect('publish: a sold on its own sub item added at A1 only for an option', h1.out?.ok === true, h1.res.err || JSON.stringify(h1.health));
    const hazPs = one(`select active::text from msm_product_sites where product_id = '${HAZ}' and location_id = '${LA1}'`);
    expect("recorded at A1 as OFF: the grid and the sales checks never count it there", hazPs === "false", `${hazPs} ${JSON.stringify(h1.plan?.problems)}`);
    settle();
    const G5c = mkSet('Hazelnut on at A1');
    const st = stage({ set: G5c, target: 'product_site', entity: HAZ, loc: LA1, op: 'update', after: { active: true }, before: { active: false } });
    if (st.code) console.log('stage refused:', st.err);
    const h2 = runSite(publish(G5c), LA1);
    const hz = json(`select to_json(i) from menu_items i where i.location_id = '${LA1}' and i.name = 'Hazelnut shot'`);
    expect('turned on at A1: written whole, so the till shows it (visibility, sold on its own, category, price)',
      h2.out?.ok === true && hz && hz.visibility.pos === true && hz.sold_alone === true && hz.cat != null && Number(hz.pricing.base) === 1.2, h2.res.err || JSON.stringify(hz));
    settle();
  }

  // ── which order types the screens show (a setting, never a venue write) ──
  r = q(`select msm_set_order_types('${menuId}', array['takeaway', 'dineIn', 'takeaway'])`, as(U.E));
  expect('the menu\'s order types are saved (once each)', r.code === 0 && one(`select order_types::text from msm_menus where id = '${menuId}'`) === '{dineIn,takeaway}', r.err);
  r = q(`select msm_set_order_types('${menuId}', array['curbside'])`, as(U.E));
  expect('an order type the tills do not have is refused', r.code !== 0 && /not an order type/.test(r.err), r.err);
  r = q(`select msm_set_order_types('${menuId}', array['delivery'])`, as(U.V));
  expect('a viewer cannot change them', r.code !== 0, r.err);

  // ── VAT by order type ─────────────────────────────────────────────────────
  const Z1 = 'c0000000-0000-4000-8000-0000000000e1', Z2 = 'c0000000-0000-4000-8000-0000000000e2', ZB = 'c0000000-0000-4000-8000-0000000000e3';
  one(`insert into tax_rates (id, location_id, name, rate) values ('${Z1}', '${LA1}', 'Zero Rate', 0), ('${Z2}', '${LA2}', 'Zero Rate', 0), ('${ZB}', '${LB1}', 'Zero Rate', 0)`);
  one(`update menu_items set tax_overrides = '{"counter": "${VAT_A1}", "drive-thru": null}'::jsonb where id = 'm-latte'`);
  const G6 = mkSet('Latte takeaway VAT');
  r = stage({ set: G6, target: 'product', entity: latte.id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } }, before: { tax_by_type: null } });
  expect('VAT by order type is staged', r.code === 0, r.err);
  const V6 = publish(G6);
  const v6a = runSite(V6, LA1);
  const v6b = runSite(V6, LA2);
  expect('publish: VAT by order type at both sites', v6a.out?.ok === true && v6b.out?.ok === true, (v6a.res.err || '') + (v6b.res.err || ''));
  expect('A1: takeaway is A1\'s own Zero Rate; its counter key and its explicit null stay exactly as they were',
    one(`select tax_overrides::text from menu_items where id = 'm-latte'`) === JSON.stringify({ counter: VAT_A1, takeaway: Z1, 'drive-thru': null }).replace(/,/g, ', ').replace(/:/g, ': '), one(`select tax_overrides::text from menu_items where id = 'm-latte'`));
  expect('A2: its own Zero Rate (by name and rate, never A1\'s id)', one(`select tax_overrides->>'takeaway' from menu_items where id = 'm-latte_${sfx(LA2)}'`) === Z2);
  const push6 = json(`select snapshot from config_pushes where id = '${v6a.out.push_id}'`);
  const it6 = push6.menuItems.find((i) => i.id === 'm-latte');
  expect('the till push carries the VAT the row now holds', it6.taxOverrides.takeaway === Z1 && it6.taxOverrides.counter === VAT_A1 && 'drive-thru' in it6.taxOverrides, JSON.stringify(it6.taxOverrides));
  settle();
  // Refusals at the write.
  const G7 = mkSet('VAT probe');
  stage({ set: G7, target: 'product', entity: latte.id, op: 'update', after: { description: 'probe 2' }, before: { description: 'probe' } });
  const V7 = publish(G7);
  const probe = (writes) => runSite(V7, LA1, { writesOverride: writes }).res;
  r = probe({ items: { update: [{ id: 'm-latte', set: {}, tax_overrides: { set: { takeaway: ZB }, remove: [] } }] } });
  expect('apply refuses a VAT rate of another site', r.code !== 0 && /not a rate at this site/.test(r.err), r.err);
  r = probe({ items: { update: [{ id: 'm-latte', set: {}, tax_overrides: { set: { counter: Z1 }, remove: [] } }] } });
  expect('apply refuses a key outside the four (counter is the site\'s own)', r.code !== 0 && /not a rate at this site/.test(r.err), r.err);
  r = probe({ maps: { mystery: [] } });
  expect('apply refuses a map it does not know', r.code !== 0 && /map this database does not know \(mystery\)/.test(r.err), r.err);
  r = probe({ groups: { delete: [{ id: 'mgd-milk' }] } });
  expect('apply refuses a group delete (never a delete)', r.code !== 0 && /does not know \(groups\.delete\)/.test(r.err), r.err);
  r = probe({ groups: { update: [{ id: 'mgd-milk', set: {}, options: [{ op: 'add', entry: { id: 'opt-1', name: 'Twice', price: 1 } }] }] } });
  expect('apply refuses a second option with an id already in the group', r.code !== 0 && /already in this site's group/.test(r.err), r.err);
  r = probe({ groups: { update: [{ id: 'mgd-milk', set: {}, options: [{ op: 'patch', id: 'opt-1', set: { itemId: 'm-b' } }] }] } });
  expect('apply refuses an option pointing at another site\'s product', r.code !== 0 && /not at this site/.test(r.err), r.err);
  one(`insert into modifier_groups (id, location_id, name, options) values ('mgd-own-a1', '${LA1}', 'Site A1 own', '[]')`);
  r = probe({ groups: { update: [{ id: 'mgd-own-a1', set: { name: 'hijack' }, options: [] }] } });
  expect('apply refuses to write a site\'s OWN option group', r.code !== 0 && /does not manage/.test(r.err), r.err);
  settle();

  // ── the tax profile copy: cleared, put back by Undo, a real one refused ────
  const PF = 'd1000000-0000-4000-8000-0000000000f1', PF2 = 'd1000000-0000-4000-8000-0000000000f2';
  one(`insert into tax_profiles (id, location_id, name, rounding, active, sort_order, generated_from_rate_id) values
       ('${PF}', '${LA1}', 'VAT', '{"mode": "half_up", "level": "invoice"}', true, 0, '${VAT_A1}'),
       ('${PF2}', '${LA1}', 'VAT and levy', '{"mode": "half_up", "level": "invoice"}', true, 1, '${VAT_A1}');
       insert into tax_profile_lines (profile_id, location_id, name, rate, mode, tax_basis) values
       ('${PF}', '${LA1}', 'VAT', 20, 'inclusive', 'pre_discount'),
       ('${PF2}', '${LA1}', 'VAT', 20, 'inclusive', 'pre_discount'), ('${PF2}', '${LA1}', 'Levy', 1, 'inclusive', 'pre_discount');
       update menu_items set tax_profile_id = '${PF}' where id = 'm-latte'`);
  const G8 = mkSet('Latte eat in VAT');
  stage({ set: G8, target: 'product', entity: latte.id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 }, 'dine-in': { name: 'VAT', percent: 20 } } }, before: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } } });
  const V8 = publish(G8);
  const v8 = runSite(V8, LA1);
  expect('publish: order type VAT over a generated copy of the item\'s own rate', v8.out?.ok === true, v8.res.err || JSON.stringify(v8.health));
  expect('the copy is cleared (it hid the order type VAT) and remembered for Undo',
    one(`select coalesce(tax_profile_id::text, 'none') from menu_items where id = 'm-latte'`) === 'none'
    && one(`select cleared_tax_profile_id from msm_product_sites where product_id = '${latte.id}' and location_id = '${LA1}'`) === PF);
  expect('the audit keeps the profile it cleared', json(`select writes from msm_version_sites where version_id = '${V8}' and location_id = '${LA1}'`).some((w) => w.table === 'items' && w.before.tax_profile_id === PF));
  settle();
  const G9 = mkSet('Put the VAT back');
  stage({ set: G9, target: 'product', entity: latte.id, op: 'update', after: { tax_by_type: null }, before: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 }, 'dine-in': { name: 'VAT', percent: 20 } } } });
  const v9 = runSite(publish(G9), LA1);
  expect('Undo: the order type keys go and the SAME copy comes back', v9.out?.ok === true
    && one(`select tax_profile_id from menu_items where id = 'm-latte'`) === PF
    && one(`select coalesce(cleared_tax_profile_id::text, 'none') from msm_product_sites where product_id = '${latte.id}' and location_id = '${LA1}'`) === 'none'
    && one(`select tax_overrides::text from menu_items where id = 'm-latte'`) === `{"counter": "${VAT_A1}", "drive-thru": null}`, v9.res.err || one(`select tax_overrides::text from menu_items where id = 'm-latte'`));
  settle();
  one(`update menu_items set tax_profile_id = '${PF2}' where id = 'm-latte'`);
  const G10 = mkSet('Profile probe');
  stage({ set: G10, target: 'product', entity: latte.id, op: 'update', after: { description: 'probe 3' }, before: { description: 'probe 2' } });
  const V10 = publish(G10);
  r = runSite(V10, LA1, { writesOverride: { items: { update: [{ id: 'm-latte', set: { tax_profile_id: null }, tax_overrides: { set: { takeaway: Z1 }, remove: [] } }] } } }).res;
  expect('apply refuses to clear a REAL tax profile', r.code !== 0 && /only clear an old copy/.test(r.err), r.err);
  one(`update menu_items set tax_profile_id = null where id = 'm-latte'`);
  r = runSite(V10, LA1, { writesOverride: { items: { update: [{ id: 'm-latte', set: { tax_profile_id: PF2 } }] } } }).res;
  expect('apply refuses to put back a profile it never cleared', r.code !== 0 && /only put back the old VAT profile copy it cleared/.test(r.err), r.err);
  settle();

  // ── 17 Oct verification: a new VAT RATE over a generated copy of the OLD rate ──
  //    The till reads the item's profile first, so the copy is cleared in the same write (the
  //    database now accepts clearing a copy of the rate BEFORE the write too).
  {
    C = central();
    const lat = C.products.find((p) => p.name === 'Latte');
    one(`update menu_items set tax_profile_id = '${PF}' where id = 'm-latte';
         update msm_product_sites set cleared_tax_profile_id = null where product_id = '${lat.id}' and location_id = '${LA1}'`);
    const GR = mkSet('Latte zero rated');
    stage({ set: GR, target: 'product', entity: lat.id, op: 'update', after: { tax_rate_name: 'Zero Rate', tax_rate_percent: 0 }, before: { tax_rate_name: lat.tax_rate_name, tax_rate_percent: lat.tax_rate_percent } });
    const VR = publish(GR);
    const vr = runSite(VR, LA1);
    expect('VERIFY: a new VAT rate over a copy of the old rate publishes (the copy cleared in the same write)', vr.out?.ok === true, vr.res.err || JSON.stringify(vr.health));
    expect('VERIFY: A1 now holds its own Zero Rate and no profile, so the till charges the new rate',
      one(`select tax_rate_id from menu_items where id = 'm-latte'`) === Z1 && one(`select coalesce(tax_profile_id::text, 'none') from menu_items where id = 'm-latte'`) === 'none'
      && one(`select cleared_tax_profile_id from msm_product_sites where product_id = '${lat.id}' and location_id = '${LA1}'`) === PF,
      `${one(`select tax_rate_id from menu_items where id = 'm-latte'`)} ${one(`select tax_profile_id from menu_items where id = 'm-latte'`)}`);
    runSite(VR, LA2);
    settle();
    // Back to the old rate (as Undo would): the rate goes back; the cleared copy is not needed.
    const GR2 = mkSet('Latte back to VAT');
    stage({ set: GR2, target: 'product', entity: lat.id, op: 'update', after: { tax_rate_name: lat.tax_rate_name, tax_rate_percent: lat.tax_rate_percent }, before: { tax_rate_name: 'Zero Rate', tax_rate_percent: 0 } });
    const VR2 = publish(GR2);
    const vr2 = runSite(VR2, LA1);
    runSite(VR2, LA2);
    expect('VERIFY: and back to the old rate', vr2.out?.ok === true && one(`select tax_rate_id from menu_items where id = 'm-latte'`) === VAT_A1, vr2.res.err || JSON.stringify(vr2.health));
    one(`update msm_product_sites set cleared_tax_profile_id = null where product_id = '${lat.id}' and location_id = '${LA1}'`);
    settle();
  }

  // ── 17 Oct verification: a run whose worker died is not claimed for ever; Retry starts again ──
  {
    C = central();
    const lat = C.products.find((p) => p.name === 'Latte');
    const GS = mkSet('Stuck run');
    stage({ set: GS, target: 'product', entity: lat.id, op: 'update', after: { description: 'stuck' }, before: { description: lat.description ?? '' } });
    const VS = json(`select msm_publish_now('${GS}', true)`, as(U.E)).version_id;
    one(`update msm_version_sites set status = 'running', claimed_at = now() - interval '11 minutes', attempts = 5 where version_id = '${VS}' and location_id = '${LA1}'`);
    one(`update msm_version_sites set status = 'done' where version_id = '${VS}' and location_id <> '${LA1}'`);
    const claimed = json(`select coalesce(json_agg(c), '[]'::json) from msm_claim_due(20) c`, SERVICE);
    expect('VERIFY: a stale run that has had 5 tries is not claimed again', !claimed.some((c) => c.version_id === VS), JSON.stringify(claimed));
    expect('VERIFY: it is failed, in words, with Retry', one(`select status from msm_version_sites where version_id = '${VS}' and location_id = '${LA1}'`) === 'failed'
      && /stopped part way at this site 5 times\. Nothing was changed there\. Press Retry\./.test(one(`select error from msm_version_sites where version_id = '${VS}' and location_id = '${LA1}'`)));
    const back = json(`select msm_retry_site('${VS}', '${LA1}')`, as(U.E));
    expect('VERIFY: Retry starts the count again (attempts 0)', back.status === 'scheduled' && one(`select attempts from msm_version_sites where version_id = '${VS}' and location_id = '${LA1}'`) === '0');
    const again = json(`select coalesce(json_agg(c), '[]'::json) from msm_claim_due(20) c`, SERVICE);
    expect('VERIFY: and the next claim is its first try', again.some((c) => c.version_id === VS && c.location_id === LA1 && c.attempts === 1), JSON.stringify(again));
    // A busy moment right after a Retry is tried again, not failed at once.
    const f = json(`select msm_fail_site('${VS}', '${LA1}', 'Someone was saving', 1)`, SERVICE);
    expect('VERIFY: a busy moment after a Retry goes back in the queue', f.status === 'scheduled', JSON.stringify(f));
    settle();
  }

  // ── 17 Oct verification: an import from a page still running round 1 (no options) is refused ──
  {
    r = q(`select msm_import_commit(${lit({ org_id: ORG_A, name: 'Old page', sites: [{ location_id: LA1 }], products: [], categories: [], groups: [] })})`, as(U.E));
    expect('VERIFY: an import without its options (a page still on round 1) is refused in words', r.code !== 0 && /This page is out of date\. Reload the page/.test(r.err), r.err);
  }

  // ── 17 Oct verification: sales and trading are behind the second sign in step too ──
  {
    r = q(`select * from msm_sold_recently('${menuId}', 7, null)`, as(U.V, 'aal1'));
    expect('VERIFY: sold recently needs the second step', r.code !== 0 && /second step/.test(r.err), r.err || r.out);
    r = q(`select * from msm_sites_trading('${menuId}')`, as(U.V, 'aal1'));
    expect('VERIFY: trading now needs the second step', r.code !== 0 && /second step/.test(r.err), r.err || r.out);
  }

  // ── the row lock comes BEFORE the fingerprint ───────────────────────────
  {
    const G11 = mkSet('Lock probe');
    stage({ set: G11, target: 'product', entity: latte.id, op: 'update', after: { description: 'lock' }, before: { description: 'probe 3' } });
    const V11 = publish(G11);
    const holder = spawn('psql', [...CONN, '-d', DB], { stdio: ['pipe', 'ignore', 'ignore'] });
    holder.stdin.write(`begin; select 1 from menu_items where id = 'm-latte' for update; select pg_sleep(3); commit;\n`);
    holder.stdin.end();
    spawnSync('sleep', ['0.8']);
    const fp = one(`select msm_venue_fingerprint('${LA1}')`, SERVICE);
    const raw = readRaw(LA1);
    const changes = json(`select json_agg(x) from msm_changes x where change_set_id = '${G11}'`);
    const p = planSite({ central: central(), touched: touchedFromChanges(changes || []), locationId: LA1, orgId: ORG_A, venue: raw });
    const lastId = one(`select id from config_pushes where location_id = '${LA1}' order by created_at desc limit 1`);
    r = q(`set local lock_timeout = '1s'; select msm_apply_site('${V11}', '${LA1}', ${lit(p.writes)}, '{}'::jsonb, '${fp}', '{}'::jsonb, 'x', null, '${lastId}')`, SERVICE);
    expect('a save holding a product row makes publish WAIT on the lock before the fingerprint is read', r.code !== 0 && /lock timeout/.test(r.err), r.err || r.out);
    await new Promise((res) => holder.on('exit', res));
    settle();
  }

  // ── the managed lists, sold recently, trading now ───────────────────────
  const mg = json(`select coalesce(json_agg(m), '[]'::json) from msm_managed_groups('${LA1}') m`, as(U.O));
  expect('the Menu Manager lock list: the managed group with the option ids the group menu owns there',
    mg.length === 1 && mg[0].venue_group_id === 'mgd-milk' && mg[0].option_ids.includes('opt-1') && mg[0].option_ids.includes(newOptionId(SOYA)) && !mg[0].option_ids.includes('opt-venue'), JSON.stringify(mg));
  expect('nothing for a venue the caller does not use', one(`select count(*) from msm_managed_groups('${LA1}')`, as(U.EB)) === '0');
  const at = json(`select msm_managed_at(array['${LA1}', '${LA2}'])`, as(U.O));
  expect('the sharing engine gate: on, the managed group and products at the venues asked', at.on === true && at.groups.some((x) => x.venue_group_id === 'mgd-milk') && at.items.some((x) => x.venue_item_id === 'm-latte'), JSON.stringify(at));
  expect('the gate says nothing about venues the caller does not use', json(`select msm_managed_at(array['${LA1}'])`, as(U.EB)).groups.length === 0);
  one(`insert into closed_checks (id, location_id, items, closed_at) values ('cc-1', '${LA1}', '[{"itemId": "m-latte", "qty": 2}, {"itemId": "m-oat", "qty": 1}]', now() - interval '10 minutes'),
       ('cc-2', '${LA1}', '[{"itemId": "m-latte", "qty": 1}]', now() - interval '9 days'), ('cc-3', '${LA1}', '[{"itemId": "m-latte", "qty": 5}]', now()) ;
       update closed_checks set voided = true where id = 'cc-3'`);
  const sold = json(`select coalesce(json_agg(s), '[]'::json) from msm_sold_recently('${menuId}', 7, null) s`, as(U.V));
  expect('sold in the last 7 days: per site and product, voids and older sales left out', sold.find((x) => x.venue_item_id === 'm-latte' && x.location_id === LA1)?.sold === 2, JSON.stringify(sold));
  r = q(`select * from msm_sold_recently('${menuId}', 7, null)`, as(U.O));
  expect('an owner who is not named cannot read sales through it', r.code !== 0 && /cannot see this group menu/.test(r.err), r.err);
  const trading = json(`select coalesce(json_agg(t order by t.location_id), '[]'::json) from msm_sites_trading('${menuId}') t`, as(U.V));
  expect('trading now: A1 had a sale 10 minutes ago, A2 none', trading.find((t) => t.location_id === LA1)?.trading === true && trading.find((t) => t.location_id === LA2)?.trading === false && !!trading[0].local_time, JSON.stringify(trading));

  // ── the mirror check against the shared fixture list ─────────────────────
  let agree = 0;
  for (const [i, c] of MIRROR_CASES.entries()) {
    const n = String(i + 1).padStart(4, '0');
    const rate = `e2000000-0000-4000-8000-00000000${n}`, other = `e3000000-0000-4000-8000-00000000${n}`, prof = `e4000000-0000-4000-8000-00000000${n}`;
    const map = (id) => (id === MIRROR_RATE_ID ? rate : id === MIRROR_OTHER_RATE_ID ? other : id);
    one(`insert into tax_rates (id, location_id, name, rate, type, active) values ('${rate}', '${c.rate.location_id}', 'M${n}', ${c.rate.rate}, '${c.rate.type}', ${c.rate.active !== false}), ('${other}', '${c.rate.location_id}', 'O${n}', 5, 'inclusive', true);
         insert into tax_profiles (id, location_id, name, rounding, active, sort_order, generated_from_rate_id) values ('${prof}', '${c.profile.location_id}', 'P${n}', ${lit(c.profile.rounding)}, true, 0, ${c.profile.generated_from_rate_id ? `'${map(c.profile.generated_from_rate_id)}'` : 'null'})`);
    for (const l of c.lines) {
      one(`insert into tax_profile_lines (profile_id, location_id, name, line_type, rate, mode, compound, taxable, tax_basis, order_types, active, tax_service_charge, tax_delivery_fee)
           values ('${prof}', '${c.profile.location_id}', '${l.name}', '${l.line_type}', ${l.rate}, '${l.mode}', ${l.compound}, ${l.taxable}, '${l.tax_basis}', array[${l.order_types.map((x) => `'${x}'`).join(',')}]::text[], ${l.active !== false},
                   ${l.tax_service_charge == null ? 'null' : l.tax_service_charge}, ${l.tax_delivery_fee == null ? 'null' : l.tax_delivery_fee})`);
    }
    const got = one(`select msm__is_legacy_mirror('${prof}', '${map(c.itemRate)}')`) === 't';
    if (got === c.expect) agree++; else expect(`mirror case: ${c.name}`, false, `database says ${got}, the fixture ${c.expect}`);
  }
  expect(`the database reads every mirror case as the planner and the engine do (${agree} of ${MIRROR_CASES.length})`, agree === MIRROR_CASES.length);

  // ── the one time refresh (msm_import_groups) on a group menu made before round 2 ──
  {
    // Company B: imported now, then put back to how a round 1 import left it (groups as jsonb).
    one(`insert into modifier_groups (id, location_id, name, options) values ('mgd-shot', '${LB1}', 'Extra shot', '[{"id": "opt-shot", "name": "Extra shot", "price": 0.5}]');
         update menu_items set assigned_modifier_groups = '[{"groupId": "mgd-shot"}]', tax_overrides = '{"takeaway": "${ZB}"}' where id = 'm-b'`);
    const rawB = readRaw(LB1);
    let k = 0;
    const gen = () => `e5000000-0000-4000-8000-${String(++k).padStart(12, '0')}`;
    const sitesB = [{ location_id: LB1, name: 'Site B1', venue_menu_id: 'menu-b1', raw: rawB }];
    const builtB = buildCentral(proposeImport(sitesB, { idGen: gen }), sitesB, {}, { idGen: gen });
    expect('company B imports with zero writes', builtB.check.ok, JSON.stringify(builtB.check));
    const bMenu = json(`select msm_import_commit(${lit(importPayload(builtB.central, { orgId: ORG_B, name: 'B menu' }))})`, as(U.EB)).menu_id;
    // ... and is put back to how a round 1 import left it: groups as a jsonb list, no option rows,
    // no VAT by order type, nothing kept on the group.
    one(`delete from msm_modifier_option_sites where option_id in (select id from msm_modifier_options where menu_id = '${bMenu}');
         delete from msm_modifier_options where menu_id = '${bMenu}';
         update msm_modifier_groups set options = '[{"id": "opt-shot", "name": "Extra shot", "price": 0.5}]' where menu_id = '${bMenu}';
         update msm_modifier_group_sites set kept = '{}' where group_id in (select id from msm_modifier_groups where menu_id = '${bMenu}');
         update msm_products set tax_by_type = null where menu_id = '${bMenu}';
         update msm_product_sites set kept = kept - 'tax_overrides' where product_id in (select id from msm_products where menu_id = '${bMenu}');
         update msm_menus set refreshed_at = null where id = '${bMenu}'`);
    const bProduct = one(`select id from msm_products where menu_id = '${bMenu}' and name = 'B coffee'`);
    const bGroup = one(`select id from msm_modifier_groups where menu_id = '${bMenu}'`);
    const centralB = json(`select json_build_object(
      'menu', (select to_json(m) from msm_menus m where m.id = '${bMenu}'),
      'sites', (select json_agg(s) from msm_menu_sites s where s.menu_id = '${bMenu}'),
      'categories', (select json_agg(c) from msm_categories c where c.menu_id = '${bMenu}'),
      'catSites', (select json_agg(x) from msm_category_sites x join msm_categories c on c.id = x.category_id where c.menu_id = '${bMenu}'),
      'groups', (select json_agg(g) from msm_modifier_groups g where g.menu_id = '${bMenu}'),
      'groupSites', (select json_agg(x) from msm_modifier_group_sites x join msm_modifier_groups g on g.id = x.group_id where g.menu_id = '${bMenu}'),
      'options', '[]'::json, 'optionSites', '[]'::json,
      'products', (select json_agg(p) from msm_products p where p.menu_id = '${bMenu}'),
      'productSites', (select json_agg(x) from msm_product_sites x join msm_products p on p.id = x.product_id where p.menu_id = '${bMenu}'))`);
    let n = 0;
    const ref = refreshGroupsPayload(centralB, [{ location_id: LB1, name: 'Site B1', raw: rawB }], { idGen: () => `e6000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
    expect('the refresh plans zero writes at the site', ref.ok === true, ref.words);
    const fp = { [LB1]: one(`select msm_venue_fingerprint('${LB1}')`, SERVICE) };
    r = q(`select msm_import_groups('${bMenu}', ${lit({ ...ref.payload, fingerprints: { [LB1]: 'stale' } })})`, as(U.EB));
    expect('refused when a site saved its menu since it was read (fingerprint)', r.code !== 0 && /saved its menu while the option groups were being read/.test(r.err), r.err);
    r = q(`select msm_import_groups('${bMenu}', ${lit({ ...ref.payload, fingerprints: fp })})`, as(U.V));
    expect('a viewer (of another company) cannot refresh', r.code !== 0, r.err);
    const setB = json(`insert into msm_change_sets (menu_id, org_id, title) values ('${bMenu}', '${ORG_B}', 'B draft') returning to_json(id)`, as(U.EB));
    r = q(`insert into msm_changes (change_set_id, menu_id, org_id, target, entity_id, op, after) values ('${setB}', '${bMenu}', '${ORG_B}', 'modifier_group', '${bGroup}', 'update', '{"name": "Shot"}')`, as(U.EB));
    expect('before the refresh, round 2 changes wait for it', r.code !== 0 && /Refresh the option groups from the sites first/.test(r.err), r.err);
    r = q(`insert into msm_changes (change_set_id, menu_id, org_id, target, entity_id, op, after) values ('${setB}', '${bMenu}', '${ORG_B}', 'product', '${bProduct}', 'update', '{"modifier_groups": []}')`, as(U.EB));
    expect('a draft may still change which products carry a group before the refresh', r.code === 0, r.err);
    r = q(`select msm_import_groups('${bMenu}', ${lit({ ...ref.payload, fingerprints: fp })})`, as(U.EB));
    expect('refused while a draft changes option groups', r.code !== 0 && /draft or a scheduled push changes option groups/.test(r.err), r.err);
    one(`delete from msm_change_sets where id = '${setB}'`);
    const done = json(`select msm_import_groups('${bMenu}', ${lit({ ...ref.payload, fingerprints: fp })})`, as(U.EB));
    expect('the refresh saves: option rows, a version, the menu ready for round 2', done.ok === true && one(`select count(*) from msm_modifier_options where menu_id = '${bMenu}'`) === '1'
      && one(`select refreshed_at is not null from msm_menus where id = '${bMenu}'`) === 't' && one(`select count(*) from msm_versions where menu_id = '${bMenu}' and title = 'Option groups brought in'`) === '1', JSON.stringify(done));
    expect('the takeaway VAT the site has becomes the group\'s (the only site), nothing kept', JSON.stringify(json(`select to_json(tax_by_type) from msm_products where id = '${bProduct}'`)) === JSON.stringify({ takeaway: { name: 'Zero Rate', percent: 0 } }));
    r = q(`select msm_import_groups('${bMenu}', ${lit({ ...ref.payload, fingerprints: fp })})`, as(U.EB));
    expect('a second refresh is refused', r.code !== 0 && /already brought in/.test(r.err), r.err);
    const cB = json(`select json_build_object(
      'menu', (select to_json(m) from msm_menus m where m.id = '${bMenu}'), 'sites', (select json_agg(s) from msm_menu_sites s where s.menu_id = '${bMenu}'),
      'categories', (select json_agg(c) from msm_categories c where c.menu_id = '${bMenu}'),
      'catSites', (select json_agg(x) from msm_category_sites x join msm_categories c on c.id = x.category_id where c.menu_id = '${bMenu}'),
      'groups', (select json_agg(g) from msm_modifier_groups g where g.menu_id = '${bMenu}'),
      'groupSites', (select json_agg(x) from msm_modifier_group_sites x join msm_modifier_groups g on g.id = x.group_id where g.menu_id = '${bMenu}'),
      'options', (select json_agg(o) from msm_modifier_options o where o.menu_id = '${bMenu}'),
      'optionSites', (select json_agg(x) from msm_modifier_option_sites x join msm_modifier_options o on o.id = x.option_id where o.menu_id = '${bMenu}'),
      'products', (select json_agg(p) from msm_products p where p.menu_id = '${bMenu}'),
      'productSites', (select json_agg(x) from msm_product_sites x join msm_products p on p.id = x.product_id where p.menu_id = '${bMenu}'))`);
    const after = planSite({ central: cB, touched: touchedFromChanges(touchEverything(cB)), locationId: LB1, orgId: ORG_B, venue: readRaw(LB1) });
    expect('after the refresh, publishing everything would change nothing at the site', after.lines.length === 0, JSON.stringify(after.lines.slice(0, 3)));
    void VAT_A2; void VAT_B1;
  }

  // ── Peter's repro: House Red and its sizes, sold at A1 only, turned on at A2 ─────
  {
    settle();
    let CC = central();
    const hotCat = CC.categories.find((c) => c.label === 'Hot drinks');
    const RED = 'f2a10000-0000-4000-8000-0000000000a1';
    const SZ = [['f2a20000-0000-4000-8000-0000000000a2', '175 ml glass', 5.5], ['f2a30000-0000-4000-8000-0000000000a3', '250 ml glass', 7.5], ['f2a40000-0000-4000-8000-0000000000a4', 'Bottle', 22]];
    const R1 = mkSet('House Red at A1');
    r = stage({ set: R1, target: 'product', entity: RED, op: 'create', after: { name: 'House Red', menu_name: 'House Red', category_id: hotCat.id, type: 'variants', default_price: 0, tax_rate_name: 'VAT', tax_rate_percent: 20, sold_alone: true } });
    expect('repro: House Red is staged', r.code === 0, r.err);
    SZ.forEach(([id, name, price], i) => stage({ set: R1, target: 'product', entity: id, op: 'create', after: { name, menu_name: name, category_id: hotCat.id, parent_product_id: RED, type: 'simple', default_price: price, tax_rate_name: 'VAT', tax_rate_percent: 20, sold_alone: true, sort_order: i + 1 } }));
    for (const id of [RED, ...SZ.map((x) => x[0])]) stage({ set: R1, target: 'product_site', entity: id, loc: LA1, op: 'create', after: { venue_item_id: newItemId({ id }, LA1), active: true } });
    const VR1 = publish(R1);
    const ra1 = runSite(VR1, LA1);
    expect('repro: House Red and its sizes are on at A1', ra1.out?.ok === true && one(`select count(*) from menu_items where location_id = '${LA1}' and name in ('House Red', '175 ml glass', '250 ml glass', 'Bottle')`) === '4', ra1.res.err || JSON.stringify(ra1.health));
    settle();
    one(`update msm_products set site_only_location_id = '${LA1}' where id = '${RED}'`);   // as a round 1 import left it
    CC = central();
    const on = activeMany({ live: CC, eff: CC }, [RED, ...SZ.map((x) => x[0])], [LA2], true);
    expect('repro: Turn on at A2 stages all four rows, nothing silently skipped, the old mark cleared once',
      on.words.length === 0 && on.changes.filter((c) => c.target === 'product_site' && c.op === 'create').length === 4 && on.changes.filter((c) => c.target === 'product').length === 1, JSON.stringify(on));
    const glass = on.changes.find((c) => c.target === 'product_site' && c.entity_id === SZ[1][0]);
    glass.after = { ...glass.after, price: 8 };                                    // the 250 ml price at A2, on its new row
    const R2 = mkSet('House Red at A2');
    const bad = on.changes.map((c) => stage({ set: R2, target: c.target, entity: c.entity_id, loc: c.location_id, op: c.op, after: c.after, before: c.before })).filter((x) => x.code !== 0);
    expect('repro: the database takes every staged change', bad.length === 0, bad.map((x) => x.err).join(' | '));
    const VR2 = publish(R2);
    const ra2 = runSite(VR2, LA2);
    expect('repro: publish at A2 passes its health check and lands with a push', ra2.health.ok && ra2.out?.ok === true && !!ra2.out.push_id, ra2.res.err || JSON.stringify(ra2.health));
    const rows = json(`select json_agg(i) from menu_items i where location_id = '${LA2}' and name in ('House Red', '175 ml glass', '250 ml glass', 'Bottle')`) || [];
    const parent = rows.find((x) => x.name === 'House Red');
    expect('repro: A2 now holds House Red and its three sizes, the sizes under it, A2\'s own VAT rate, the 250 ml at 8.00',
      rows.length === 4 && parent && parent.type === 'variants' && rows.filter((x) => x.parent_id === parent.id).length === 3
        && rows.every((x) => x.archived === false && x.tax_rate_id === VAT_A2 && x.id.endsWith(`_${sfx(LA2)}`))
        && Number(rows.find((x) => x.name === '250 ml glass').pricing.base) === 8 && Number(rows.find((x) => x.name === 'Bottle').pricing.base) === 22,
      JSON.stringify(rows.map((x) => [x.id, x.name, x.parent_id, x.tax_rate_id, x.pricing?.base])));
    expect('repro: House Red is a normal product now (the one site mark gone)', one(`select site_only_location_id is null from msm_products where id = '${RED}'`) === 't');
    expect('repro: nothing written at A1 by the second publish', one(`select count(*) from msm_version_sites where version_id = '${VR2}' and location_id = '${LA1}' and status = 'done'`) === '0');
  }

  // ── Builder 3 (design 3.1): a site's own product, with an option group of its own, brought in ─
  // The draft holds a new product, its row at A1 with the EXISTING venue id, a new option group
  // linked to A1's own group and its options with their EXISTING venue option ids (the guard looks
  // them up through the draft). Publishing writes nothing at A1.
  {
    settle();
    one(`insert into modifier_groups (id, location_id, name, min, max, min_select, max_select, selection_type, options, sort_order) values ('mgd-bring', '${LA1}', 'Toppings', 0, 2, 0, 2, 'multiple', '[{"id": "opt-b1", "name": "Sprinkles", "price": 0.20}, {"id": "opt-b2", "name": "Cream", "price": 0.50}]', 5)`);
    one(`insert into menu_items (id, location_id, name, menu_name, receipt_name, kitchen_name, cat, pricing, tax_rate_id, type, sold_alone, assigned_modifier_groups, scope) values ('m-bring', '${LA1}', 'Hot chocolate', 'Hot chocolate', 'Hot chocolate', 'HOT CHOC', 'cat-hot', '{"base": 3.30}', '${VAT_A1}', 'modifiable', true, '[{"groupId": "mgd-bring"}]', 'local')`);
    const CC = central();
    const raw = readRaw(LA1);
    expect('bring in: the site\'s own product is listed', ownProducts(CC, LA1, raw).some((o) => o.id === 'm-bring'));
    const b = bringInChanges(CC, LA1, raw, 'm-bring', { idGen: randomUUID, siteName: 'A1' });
    expect('bring in: the changes are worked out with nothing written at the site', b.ok, b.problems.join(' | '));
    const BI = mkSet('Bring in hot chocolate');
    const bad = b.changes.map((c) => stage({ set: BI, target: c.target, entity: c.entity_id, loc: c.location_id, op: c.op, after: c.after, before: c.before })).filter((x) => x.code !== 0);
    expect('bring in: the database takes every change (a new group and options carrying the site\'s own ids)', bad.length === 0, bad.map((x) => x.err).join(' | '));
    r = stage({ set: BI, target: 'product_site', entity: CC.products.find((p) => p.name === 'Latte').id, loc: LA1, op: 'create', after: { venue_item_id: 'm-bring', active: true } });
    expect('bring in: a product already at the site cannot take a second venue item', r.code !== 0, r.err);
    const itemBefore = json(`select to_json(i) from menu_items i where id = 'm-bring'`);
    const groupBefore = groupRow('mgd-bring');
    const VB = publish(BI);
    const rb = runSite(VB, LA1);
    const itemAfter = json(`select to_json(i) from menu_items i where id = 'm-bring'`);
    const groupAfter = groupRow('mgd-bring');
    expect('bring in: publishing plans zero writes at A1 and passes its health check', rb.plan.lines.length === 0 && rb.health.ok && rb.res.code === 0, JSON.stringify(rb.plan.lines.slice(0, 3)) + (rb.res.err || ''));
    expect('bring in: A1\'s product and option group are exactly as they were', canonJ(itemBefore.pricing) === canonJ(itemAfter.pricing) && itemBefore.name === itemAfter.name
      && canonJ(itemBefore.assigned_modifier_groups) === canonJ(itemAfter.assigned_modifier_groups) && canonJ(groupBefore.options) === canonJ(groupAfter.options), JSON.stringify([itemAfter, groupAfter]));
    expect('bring in: the group menu now manages it at A1 (product, group and both options by their venue ids)',
      one(`select count(*) from msm_product_sites where location_id = '${LA1}' and venue_item_id = 'm-bring'`) === '1'
        && one(`select count(*) from msm_modifier_group_sites where location_id = '${LA1}' and venue_group_id = 'mgd-bring'`) === '1'
        && one(`select count(*) from msm_modifier_option_sites where location_id = '${LA1}' and venue_option_id in ('opt-b1', 'opt-b2') and active`) === '2');
  }

  // ── 17 Oct recheck: no price at a site, a turn on over a site's own product, VAT on sizes ──
  {
    settle();
    // A site's own product with NO Standard price at A1, brought in: the site keeps "no price".
    one(`insert into menu_items (id, location_id, name, menu_name, receipt_name, kitchen_name, cat, pricing, tax_rate_id, type, sold_alone, assigned_modifier_groups, scope) values ('m-water', '${LA1}', 'Tap water', 'Tap water', 'Tap water', 'WATER', 'cat-hot', '{"base": null}', '${VAT_A1}', 'simple', true, '[]', 'local')`);
    let CC = central();
    const b = bringInChanges(CC, LA1, readRaw(LA1), 'm-water', { idGen: randomUUID, siteName: 'A1' });
    const bps = b.changes.find((c) => c.target === 'product_site');
    expect('RECHECK: bring in keeps no price for a row that has none', b.ok && bps?.after.kept?.no_price === true && bps.after.price === null, b.problems.join(' | ') + JSON.stringify(bps));
    const NW = mkSet('Bring in tap water');
    let bad = b.changes.map((c) => stage({ set: NW, target: c.target, entity: c.entity_id, loc: c.location_id, op: c.op, after: c.after, before: c.before })).filter((x) => x.code !== 0);
    expect('RECHECK: the guard takes kept no_price', bad.length === 0, bad.map((x) => x.err).join(' | '));
    const water = b.changes.find((c) => c.target === 'product' && c.op === 'create').entity_id;
    const VW = publish(NW);
    const rw = runSite(VW, LA1);
    expect('RECHECK: publishing it writes nothing at A1 (its missing price is a fact, not a difference)', rw.plan.lines.length === 0 && rw.health.ok && rw.res.code === 0, JSON.stringify(rw.plan.lines) + (rw.res.err || ''));
    expect('RECHECK: kept no_price saved centrally', one(`select kept->>'no_price' from msm_product_sites where product_id = '${water}' and location_id = '${LA1}'`) === 'true');
    settle();
    // A group price change never gives it one there, and the write path refuses one nobody set.
    CC = central();
    const wp = CC.products.find((p) => p.id === water);
    const GP = mkSet('Tap water group price');
    r = stage({ set: GP, target: 'product_site', entity: water, loc: LA1, op: 'update', after: { kept: { no_price: false } } });
    expect('RECHECK: the guard refuses no_price that is not true', r.code !== 0 && /no price cannot have a price/.test(r.err), r.err);
    r = stage({ set: GP, target: 'product_site', entity: water, loc: LA1, op: 'update', after: { price: 1, kept: { no_price: true } } });
    expect('RECHECK: the guard refuses no price together with a price of its own', r.code !== 0 && /no price cannot have a price/.test(r.err), r.err);
    r = stage({ set: GP, target: 'product', entity: water, op: 'update', after: { default_price: 0.5 }, before: { default_price: wp.default_price } });
    const VP = publish(GP);
    const probeNp = runSite(VP, LA1, { writesOverride: { items: { update: [{ id: 'm-water', set: {}, pricing: { base: 0.5 } }] } } }).res;
    expect('RECHECK: the write path refuses a price nobody set at a site with no price', probeNp.code !== 0 && /would get one that nobody set there/.test(probeNp.err), probeNp.err);
    const rp = runSite(VP, LA1);
    expect('RECHECK: a group price change leaves A1 with no price (said, nothing written)', rp.res.code === 0 && rp.plan.lines.length === 0 && rp.health.warnings.some((w) => w.code === 'no_price_kept')
      && one(`select pricing->>'base' from menu_items where id = 'm-water'`) === '', (rp.res.err || '') + JSON.stringify(rp.health));
    settle();
    // A price set at A1 on purpose lands, and no_price goes.
    CC = central();
    const setP = sitePriceChange({ live: CC, eff: CC }, water, LA1, 0.6).change;
    const SP = mkSet('Tap water at A1');
    r = stage({ set: SP, target: setP.target, entity: setP.entity_id, loc: setP.location_id, op: setP.op, after: setP.after, before: setP.before });
    expect('RECHECK: a price set at a site with no price is staged with no_price taken away', r.code === 0, r.err);
    const rs = runSite(publish(SP), LA1);
    expect('RECHECK: and publish writes it', rs.res.code === 0 && Number(one(`select pricing->>'base' from menu_items where id = 'm-water'`)) === 0.6
      && one(`select coalesce(kept->>'no_price', 'gone') from msm_product_sites where product_id = '${water}' and location_id = '${LA1}'`) === 'gone', rs.res.err || JSON.stringify(rs.health));
    settle();
    // Undo of that price: no price again at the venue (never a missing price block).
    const UN = mkSet('Put back before tap water price');
    r = stage({ set: UN, target: 'product_site', entity: water, loc: LA1, op: 'update', after: { price: null, kept: { no_price: true } }, before: { price: 0.6, kept: {} } });
    const ru = runSite(publish(UN), LA1);
    expect('RECHECK: Undo writes no price again at the venue', ru.res.code === 0 && ru.health.ok && one(`select pricing->>'base' from menu_items where id = 'm-water'`) === '' && one(`select pricing ? 'base' from menu_items where id = 'm-water'`) === 't', ru.res.err || JSON.stringify(ru.health));
    settle();

    // A turn on over a site's own product (same id, in this menu): refused at once, in words.
    one(`insert into menu_items (id, location_id, name, menu_name, cat, pricing, tax_rate_id, type, sold_alone, scope) values ('m-water_${sfx(LA2)}', '${LA2}', 'Tap water', 'Tap water', 'cat-hot_${sfx(LA2)}', '{"base": 0.9}', '${VAT_A2}', 'simple', true, 'local')`);
    CC = central();
    const ton = siteActiveChange({ live: CC, eff: CC }, water, LA2, true);
    expect('RECHECK: the turn on would use the site\'s own id', ton.change?.after.venue_item_id === `m-water_${sfx(LA2)}`, JSON.stringify(ton));
    const TO = mkSet('Tap water at A2');
    r = stage({ set: TO, target: 'product_site', entity: water, loc: LA2, op: 'create', after: ton.change.after });
    expect('RECHECK: the guard refuses a turn on that would take over the site\'s own product, in words', r.code !== 0 && /already sells its own product with this id\. To use it, bring it in from the Sites tab/.test(r.err), r.err);
    r = stage({ set: TO, target: 'product_site', entity: water, loc: LA2, op: 'create', after: { ...ton.change.after, kept: {} } });
    expect('RECHECK: a Bring in shaped change (it carries what the site keeps) is taken', r.code === 0, r.err);
    one(`delete from msm_change_sets where id = '${TO}'`);
    expect('RECHECK: the site\'s own price untouched', one(`select pricing->>'base' from menu_items where id = 'm-water_${sfx(LA2)}'`) === '0.9');

    // A takeaway Zero Rate on House Red (a product with sizes at A1 and A2): the product and every
    // size at each site, only the four keys; Undo puts every row back exactly.
    CC = central();
    const red = CC.products.find((p) => p.name === 'House Red');
    const redRows = (loc) => json(`select json_agg(json_build_object('id', id, 'tax_overrides', tax_overrides, 'pricing', pricing, 'name', name) order by id) from menu_items where location_id = '${loc}' and (id like 'msm-f2a%' or name = 'House Red')`) || [];
    one(`update menu_items set tax_overrides = '{"counter": "${VAT_A1}"}'::jsonb where location_id = '${LA1}' and name = 'Bottle'`);
    const before1 = redRows(LA1), before2 = redRows(LA2);
    const RV = mkSet('House Red takeaway');
    r = stage({ set: RV, target: 'product', entity: red.id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } }, before: { tax_by_type: null } });
    const VRV = publish(RV);
    const rv1 = runSite(VRV, LA1), rv2 = runSite(VRV, LA2);
    const after1 = redRows(LA1), after2 = redRows(LA2);
    expect('RECHECK: takeaway VAT on a product with sizes lands at both sites', rv1.res.code === 0 && rv2.res.code === 0 && rv1.health.ok && rv2.health.ok, (rv1.res.err || '') + (rv2.res.err || ''));
    expect('RECHECK: the product and its three sizes carry each site\'s own Zero Rate for takeaway',
      after1.length === 4 && after2.length === 4 && after1.every((x) => x.tax_overrides.takeaway === Z1) && after2.every((x) => x.tax_overrides.takeaway === Z2), JSON.stringify([after1, after2]));
    expect('RECHECK: nothing else changed on those rows (prices, names), and the size\'s counter key stays',
      after1.every((x) => canonJ(x.pricing) === canonJ(before1.find((y) => y.id === x.id).pricing) && x.name === before1.find((y) => y.id === x.id).name)
        && after1.find((x) => x.name === 'Bottle').tax_overrides.counter === VAT_A1, JSON.stringify(after1));
    expect('RECHECK: one VAT change per row in the counts', rv1.plan.counts.vat === 4, JSON.stringify(rv1.plan.counts));
    settle();
    const RU = mkSet('Put back House Red takeaway');
    r = stage({ set: RU, target: 'product', entity: red.id, op: 'update', after: { tax_by_type: null }, before: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } } });
    const VRU = publish(RU);
    const ru1 = runSite(VRU, LA1), ru2 = runSite(VRU, LA2);
    expect('RECHECK: Undo puts the product and every size back exactly', ru1.res.code === 0 && ru2.res.code === 0
      && canonJ(redRows(LA1).map((x) => x.tax_overrides)) === canonJ(before1.map((x) => x.tax_overrides)) && canonJ(redRows(LA2).map((x) => x.tax_overrides)) === canonJ(before2.map((x) => x.tax_overrides)),
      JSON.stringify([redRows(LA1), before1]) + (ru1.res.err || '') + (ru2.res.err || ''));
    settle();
    // A size following an explicit null on its product (the site's default VAT) is written as null.
    const NU = mkSet('Null probe');
    stage({ set: NU, target: 'product', entity: red.id, op: 'update', after: { description: 'probe' }, before: { description: '' } });
    const VNU = publish(NU);
    const sizeId = after1.find((x) => x.name === 'Bottle').id;
    const nr = runSite(VNU, LA1, { writesOverride: { items: { update: [{ id: sizeId, set: {}, tax_overrides: { set: { 'dine-in': null }, remove: [] } }] } } }).res;
    expect('RECHECK: the write path takes an explicit null a size copies from its product', nr.code === 0 && one(`select tax_overrides ? 'dine-in' and tax_overrides->'dine-in' = 'null'::jsonb from menu_items where id = '${sizeId}'`) === 't', nr.err);
    settle();
  }
}
