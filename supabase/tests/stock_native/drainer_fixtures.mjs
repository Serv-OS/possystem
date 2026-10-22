// drainer_fixtures.mjs: the rows the drainer proof adds on top of the Drop 0 fixtures (fixtures.mjs),
// written the way a demo file or the SQL editor writes them (as postgres, after 0a and its revalue
// file, so 0a's orphan and mirror triggers give every row its company record, as live). Ids and
// neutral words only (the repo is public).
//
//   basketSql()       what the every channel basket needs beyond Drop 0's rows: a sealed item with
//                     returns_to_shelf, a modifier with its own recipe, a dish with drive thru and
//                     takeaway lines, and the Back Office discount presets
//   deliberateSql()   part A of the deliberate cases (map 8.1, drainer contract 6.1 D1 to D4): the rows
//                     that will be archived, three made to order levels, a loop, a chain past the depth
//                     cap, a made item with no recipe, the oat milk and no cheese dishes
//   deliberateArchiveSql(), deliberateToOrderSql(), optionRulesSql()   part B (after the release)
//   speedSql(n)       the synthetic company of the speed part
//   PARITY_ROWS       check rows for the JS against SQL parity of checkSalesParts (every legacy path)

import { id, ORG_T, PROVO, LOC2, I, R, M } from './fixtures.mjs';

// -- the basket ------------------------------------------------------------------------------------------
export const BI = { juice: id('41000000', 'a01'), tray: id('41000000', 'a02') };
export const BR = { shot: id('67000000', 'a01'), juice: id('67000000', 'a02'), drive: id('67000000', 'a03') };
export const BM = { shot: 'm-shot', juice: 'm-juice', drive: 'm-drive' };
export const DISC = {
  pStaff: id('69000000', 'a01'), pComp: id('69000000', 'a02'), pLoyalty: id('69000000', 'a03'), pHappy: id('69000000', 'a04'),
  lStaff: id('69000000', 'b01'),
};
// shelf prices of the basket's till products
export const PRICE = {
  [M.pLatte]: 3.2, [M.pFlat]: 3.1, [M.pBoard]: 2.5, [M.pSoup]: 4.5, [BM.juice]: 2.8, [BM.shot]: 0.6, [BM.drive]: 3.4,
  [M.lLatte]: 3.3, [M.lSoup]: 4.6, [M.lBread]: 3.0, [M.sWater]: 1.5,
};

const receipt = (loc, item, qty, cost, key, type = 'PURCHASE_RECEIPT') =>
  `select public._post_stock_movement('${loc}', '${item}', ${qty}, '${type}', ${cost}, 'purchase_order', 'dfx', '${key}', now() - interval '3 days', null, null, null);
   update inventory_items set current_cost = ${cost} where id = '${item}';`;

export function basketSql() {
  return `
insert into inventory_items (id, location_id, org_id, name, kind, base_unit, category, accounting_group, returns_to_shelf) values
  ('${BI.juice}', '${PROVO}', '${ORG_T}', 'Bottled Juice', 'PURCHASED', 'each', 'Soft drinks', 'Drink', true),
  ('${BI.tray}', '${PROVO}', '${ORG_T}', 'Carrier Tray', 'PURCHASED', 'each', 'Packaging', 'Packaging', false);
insert into recipes (id, location_id, name, recipe_type, yield_qty, yield_unit) values
  ('${BR.shot}', '${PROVO}', 'Extra Shot', 'MENU', 1, 'each'), ('${BR.juice}', '${PROVO}', 'Juice', 'MENU', 1, 'each'),
  ('${BR.drive}', '${PROVO}', 'Drive Coffee', 'MENU', 1, 'each');
insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, sort_order, order_types) values
  ('${PROVO}', '${BR.shot}', '${I.pBeans}', 9, 'g', 0, null),
  ('${PROVO}', '${BR.juice}', '${BI.juice}', 1, 'each', 0, null),
  ('${PROVO}', '${BR.drive}', '${I.pBeans}', 18, 'g', 0, null),
  ('${PROVO}', '${BR.drive}', '${I.pCups}', 1, 'each', 1, '["takeaway"]'),
  ('${PROVO}', '${BR.drive}', '${BI.tray}', 1, 'each', 2, '["drive-thru"]');
insert into menu_items (id, location_id, name) values ('${BM.shot}', '${PROVO}', 'Extra Shot'), ('${BM.juice}', '${PROVO}', 'Juice'), ('${BM.drive}', '${PROVO}', 'Drive Coffee');
insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion) values
  ('${PROVO}', '${BM.shot}', '${BR.shot}', 1), ('${PROVO}', '${BM.juice}', '${BR.juice}', 1), ('${PROVO}', '${BM.drive}', '${BR.drive}', 1);
${receipt(PROVO, BI.juice, 24, 0.9, 'dfx:juice')}
${receipt(PROVO, BI.tray, 100, 0.05, 'dfx:tray')}
insert into discounts (id, location_id, name, type, value, scope) values
  ('${DISC.pStaff}', '${PROVO}', 'Staff meal', 'percent', 50, 'global'), ('${DISC.pComp}', '${PROVO}', 'Manager comp', 'percent', 100, 'global'),
  ('${DISC.pLoyalty}', '${PROVO}', 'Loyalty treat', 'amount', 2, 'global'), ('${DISC.pHappy}', '${PROVO}', 'Happy hour', 'percent', 10, 'global'),
  ('${DISC.lStaff}', '${LOC2}', 'Staff meal', 'percent', 50, 'global');
`;
}

// The kinds a Back Office login sets once discounts.kind exists (contract 3.2).
export const presetKindsSql = `update discounts set kind = 'staff' where id in ('${DISC.pStaff}', '${DISC.lStaff}');
update discounts set kind = 'comp' where id = '${DISC.pComp}';
update discounts set kind = 'loyalty' where id = '${DISC.pLoyalty}'`;

// -- the deliberate cases (Provo unless named) -------------------------------------------------------------
export const DI = {
  teaOld: id('41000000', 'a10'), chicken: id('41000000', 'a11'), oil: id('41000000', 'a12'), garlic: id('41000000', 'a13'),
  fill: id('41000000', 'a14'), mayo: id('41000000', 'a15'), goil: id('41000000', 'a16'), pieMix: id('41000000', 'a17'),
  pieBase: id('41000000', 'a18'), sauce: id('41000000', 'a19'), caramel: id('41000000', 'a1a'), cheddar: id('41000000', 'a1b'),
  sliced: id('41000000', 'a1c'), cocoa: id('41000000', 'a1d'),
};
export const DEEP = Array.from({ length: 8 }, (_, k) => id('41000000', `b0${k + 1}`));   // G1..G8, each made to order
export const DPACK = { scoop: id('62100000', 'a01'), block: id('62100000', 'a02') };
export const DCONV = { caramel: id('64100000', 'a01') };
export const DR = {
  muffin: id('67000000', 'b01'), lemonTea: id('67000000', 'b02'), scoop: id('67000000', 'b03'), caramel: id('67000000', 'b04'),
  club: id('67000000', 'b05'), fill: id('67000000', 'b06'), mayo: id('67000000', 'b07'), goil: id('67000000', 'b08'),
  pie: id('67000000', 'b09'), pieMix: id('67000000', 'b0a'), pieBase: id('67000000', 'b0b'), deep: id('67000000', 'b0c'),
  sauce: id('67000000', 'b0d'), toastie: id('67000000', 'b0e'), oat: id('67000000', 'b0f'), milkShot: id('67000000', 'b10'),
  foreign: id('67000000', 'b11'),
};
export const DEEPR = Array.from({ length: 8 }, (_, k) => id('67000000', `c0${k + 1}`));
export const DM = {
  muffin: 'm-muffin', lemonTea: 'm-lemontea', scoop: 'm-scoop', caramel: 'm-caramel', club: 'm-club', pie: 'm-pie', deep: 'm-deep',
  sauce: 'm-sauce', toastie: 'm-toastie', oat: 'm-oat', milkShot: 'm-milkshot', foreign: 'm-foreign',
};
export const DOPT = { a: id('68000000', 'a01'), b: id('68000000', 'a02'), c: id('68000000', 'a03'), d: id('68000000', 'a04'), e: id('68000000', 'a05') };

export function deliberateSql() {
  const item = (iid, name, kind, unit, returns = false) => `('${iid}', '${PROVO}', '${ORG_T}', '${name}', '${kind}', '${unit}', 'Test', 'Food', ${returns})`;
  const recipe = (rid, name, type = 'MENU', out = null, yq = 1, yu = 'each') => `('${rid}', '${PROVO}', '${name}', '${type}', ${out ? `'${out}'` : 'null'}, ${yq}, '${yu}')`;
  const line = (rid, iid, qty, unit, sort = 0, usable = 100) => `('${PROVO}', '${rid}', '${iid}', ${qty}, '${unit}', ${usable}, ${sort})`;
  const deepLines = DEEP.map((g, k) => [k < 7 ? line(DEEPR[k], DEEP[k + 1], 1, 'each', 0) : null, line(DEEPR[k], DI.garlic, 1, 'each', 1)].filter(Boolean).join(',\n  ')).join(',\n  ');
  return `
insert into inventory_items (id, location_id, org_id, name, kind, base_unit, category, accounting_group, returns_to_shelf) values
  ${item(DI.teaOld, 'Old Tea Bags', 'PURCHASED', 'each')}, ${item(DI.chicken, 'Chicken Breast', 'PURCHASED', 'kg')},
  ${item(DI.oil, 'Sunflower Oil', 'PURCHASED', 'l')}, ${item(DI.garlic, 'Garlic', 'PURCHASED', 'each')},
  ${item(DI.fill, 'Sandwich Filling', 'MADE', 'each')}, ${item(DI.mayo, 'Garlic Mayo', 'MADE', 'kg')}, ${item(DI.goil, 'Garlic Oil', 'MADE', 'l')},
  ${item(DI.pieMix, 'Pie Mix', 'MADE', 'each')}, ${item(DI.pieBase, 'Pie Base', 'MADE', 'each')}, ${item(DI.sauce, 'Mystery Sauce', 'MADE', 'kg')},
  ${item(DI.caramel, 'Caramel Syrup', 'PURCHASED', 'ml')}, ${item(DI.cheddar, 'Cheddar', 'PURCHASED', 'kg')},
  ${item(DI.sliced, 'Sliced Bread', 'PURCHASED', 'each')}, ${item(DI.cocoa, 'Cocoa Powder', 'PURCHASED', 'kg')},
  ${DEEP.map((g, k) => item(g, `Deep Layer ${k + 1}`, 'MADE', 'each')).join(', ')};
insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base) values
  ('${DPACK.scoop}', '${PROVO}', '${DI.cocoa}', 'Scoop', 0.05), ('${DPACK.block}', '${PROVO}', '${DI.cheddar}', 'Block', 0.5);
insert into inventory_item_conversions (id, location_id, inventory_item_id, from_qty, from_unit, to_qty, to_unit) values
  ('${DCONV.caramel}', '${PROVO}', '${DI.caramel}', 1, 'ml', 1.2, 'g');
insert into recipes (id, location_id, name, recipe_type, output_item_id, yield_qty, yield_unit) values
  ${recipe(DR.muffin, 'Old Muffin')}, ${recipe(DR.lemonTea, 'Lemon Tea')}, ${recipe(DR.scoop, 'Cocoa Scoop')}, ${recipe(DR.caramel, 'Caramel Shot')},
  ${recipe(DR.club, 'Club Sandwich')}, ${recipe(DR.fill, 'Sandwich Filling', 'PREP', DI.fill, 2, 'each')},
  ${recipe(DR.mayo, 'Garlic Mayo', 'PREP', DI.mayo, 0.5, 'kg')}, ${recipe(DR.goil, 'Garlic Oil', 'PREP', DI.goil, 1, 'l')},
  ${recipe(DR.pie, 'Loop Pie')}, ${recipe(DR.pieMix, 'Pie Mix', 'PREP', DI.pieMix)}, ${recipe(DR.pieBase, 'Pie Base', 'PREP', DI.pieBase)},
  ${recipe(DR.deep, 'Deep Dish')}, ${DEEP.map((g, k) => recipe(DEEPR[k], `Deep Layer ${k + 1}`, 'PREP', g)).join(', ')},
  ${recipe(DR.sauce, 'Sauce Pot')}, ${recipe(DR.toastie, 'Cheese Toastie')}, ${recipe(DR.oat, 'Oat Swap')}, ${recipe(DR.milkShot, 'Milk Shot')},
  ${recipe(DR.foreign, 'Foreign Pack Test')};
insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, usable_pct, sort_order) values
  ${line(DR.muffin, I.pEggs, 1, 'each')},
  ${line(DR.lemonTea, I.pLemons, 1, 'each')}, ${line(DR.lemonTea, DI.teaOld, 1, 'each', 1)},
  ${line(DR.scoop, DI.cocoa, 1, `@${DPACK.scoop}`)},
  ${line(DR.caramel, DI.caramel, 12, 'g')},
  ${line(DR.club, DI.fill, 1, 'each')},
  ${line(DR.fill, DI.mayo, 100, 'g')}, ${line(DR.fill, DI.chicken, 300, 'g', 1, 80)},
  ${line(DR.mayo, I.pEggs, 2, 'each')}, ${line(DR.mayo, DI.goil, 200, 'ml', 1)},
  ${line(DR.goil, DI.oil, 1, 'l')}, ${line(DR.goil, DI.garlic, 2, 'each', 1)},
  ${line(DR.pie, DI.pieMix, 1, 'each')},
  ${line(DR.pieMix, DI.pieBase, 1, 'each')}, ${line(DR.pieMix, DI.garlic, 1, 'each', 1)},
  ${line(DR.pieBase, DI.pieMix, 0.5, 'each')}, ${line(DR.pieBase, I.pEggs, 1, 'each', 1)},
  ${line(DR.deep, DEEP[0], 1, 'each')},
  ${deepLines},
  ${line(DR.sauce, DI.sauce, 0.1, 'kg')},
  ${line(DR.toastie, DI.cheddar, 40, 'g')}, ${line(DR.toastie, DI.sliced, 2, 'each', 1)}, ${line(DR.toastie, I.pButter, 10, 'g', 2)},
  ${line(DR.oat, I.pOat, 0.25, 'l')},
  ${line(DR.milkShot, I.pMilk, 0.05, 'l')},
  ${line(DR.foreign, DI.sliced, 1, `@${DPACK.block}`)};
insert into menu_items (id, location_id, name) values
  ${Object.entries(DM).map(([k, v]) => `('${v}', '${PROVO}', '${k}')`).join(', ')};
insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion) values
  ${Object.keys(DM).map((k) => `('${PROVO}', '${DM[k]}', '${DR[k]}', 1)`).join(', ')};
${receipt(PROVO, DI.teaOld, 50, 0.05, 'dfx:tea')}
${receipt(PROVO, DI.chicken, 5, 8, 'dfx:chicken')}
${receipt(PROVO, DI.oil, 5, 2, 'dfx:oil')}
${receipt(PROVO, DI.garlic, 100, 0.1, 'dfx:garlic')}
${receipt(PROVO, DI.caramel, 1000, 0.01, 'dfx:caramel')}
${receipt(PROVO, DI.cheddar, 3, 9, 'dfx:cheddar')}
${receipt(PROVO, DI.sliced, 40, 0.1, 'dfx:sliced')}
${receipt(PROVO, DI.cocoa, 2, 6, 'dfx:cocoa')}
${receipt(PROVO, DI.fill, 10, 1.5, 'dfx:fill', 'PRODUCTION_OUTPUT')}
${receipt(PROVO, DI.mayo, 2, 4, 'dfx:mayo', 'PRODUCTION_OUTPUT')}
${receipt(PROVO, DI.goil, 2, 2.5, 'dfx:goil', 'PRODUCTION_OUTPUT')}
${receipt(PROVO, DI.pieMix, 10, 1, 'dfx:piemix', 'PRODUCTION_OUTPUT')}
${receipt(PROVO, DI.pieBase, 10, 1, 'dfx:piebase', 'PRODUCTION_OUTPUT')}
${receipt(PROVO, DI.sauce, 2, 3, 'dfx:sauce', 'PRODUCTION_OUTPUT')}
${DEEP.map((g, k) => receipt(PROVO, g, 10, 1, `dfx:deep${k + 1}`, 'PRODUCTION_OUTPUT')).join('\n')}
`;
}

// Part B, on both copies once the release is in (on the copy without it, the same rows, so v1's figure
// can be shown beside v2's): the archived rows (D1) and the made to order site links (D2).
export const deliberateArchiveSql = `
update recipes set archived_at = now() where id = '${DR.muffin}';
update inventory_items set archived_at = now() where id = '${DI.teaOld}';
update item_packaging_formats set archived_at = now() where id = '${DPACK.scoop}';
update inventory_item_conversions set archived_at = now() where id = '${DCONV.caramel}';`;
export const deliberateToOrderSql = `
update stock_co_item_sites set supply_mode = 'to_order'
 where location_id = '${PROVO}' and site_item_id in ('${DI.fill}', '${DI.mayo}', '${DI.goil}', '${DI.pieMix}', '${DI.pieBase}', '${DI.sauce}',
   ${DEEP.map((g) => `'${g}'`).join(', ')}, '${I.pSoup}');`;

// The option rules (D3), as Drop 2's save function will write them (here as the SQL editor). A: oat milk
// at Provo (the till modifier m-oat, which also has its own recipe), B: oat milk at Location 2 (its own
// oat milk item, kept in ml), C: no cheese, D: no milk (remove wins over replace), E: a rule whose
// modifier was not found at Provo (does nothing). { toastie: false } leaves out C, for a copy without
// the deliberate rows (the toastie and its cheddar are deliberateSql() rows).
export function optionRulesSql({ toastie = true } = {}) {
  const co = (t, x) => `(select company_ref from public.${t} where id = '${x}')`;
  const rules = [
    `('${DOPT.a}', '${ORG_T}', ${co('recipes', R.pLatte)}, 'replace', 'Oat milk', ${co('inventory_items', I.pOat)}, ${co('inventory_items', I.pMilk)}, null)`,
    `('${DOPT.b}', '${ORG_T}', ${co('recipes', R.pLatte)}, 'replace', 'Oat milk', ${co('inventory_items', I.lOat)}, ${co('inventory_items', I.lMilk)}, null)`,
    toastie ? `('${DOPT.c}', '${ORG_T}', ${co('recipes', DR.toastie)}, 'remove', 'No cheese', null, null, ${co('inventory_items', DI.cheddar)})` : null,
    `('${DOPT.d}', '${ORG_T}', ${co('recipes', R.pLatte)}, 'remove', 'No milk', null, null, ${co('inventory_items', I.pMilk)})`,
    `('${DOPT.e}', '${ORG_T}', ${co('recipes', R.pLatte)}, 'replace', 'Oat milk (not found)', ${co('inventory_items', I.pOat)}, ${co('inventory_items', I.pMilk)}, null)`,
  ].filter(Boolean);
  const sites = [
    `('${DOPT.a}', '${ORG_T}', '${PROVO}', '${DM.oat}', 'hand')`, `('${DOPT.b}', '${ORG_T}', '${LOC2}', 'mod-oat-l2', 'name')`,
    toastie ? `('${DOPT.c}', '${ORG_T}', '${PROVO}', 'mod-nocheese', 'hand')` : null, `('${DOPT.d}', '${ORG_T}', '${PROVO}', 'mod-nomilk', 'hand')`,
    `('${DOPT.e}', '${ORG_T}', '${PROVO}', null, null)`,
  ].filter(Boolean);
  return `
insert into stock_co_option_rules (id, org_id, recipe_id, kind, option_name, option_company_item_id, replaces_item_id, removes_item_id) values
  ${rules.join(',\n  ')};
insert into stock_co_option_rule_sites (rule_id, org_id, location_id, site_modifier_id, resolved_by) values
  ${sites.join(', ')};`;
}

// -- the speed company ------------------------------------------------------------------------------------
export const SPEED_ORG = id('0f000000', 'f1');
export const speedLoc = (n) => `e5000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export function speedSql(sites) {
  const L = (n) => `('e5000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
  return `
insert into organisations (id, name) values ('${SPEED_ORG}', 'Speed group');
insert into locations (id, org_id, name, timezone, currency, status) select ${L('n')}, '${SPEED_ORG}', 'Speed site ' || n, 'Europe/London', 'GBP', 'active' from generate_series(1, ${sites}) n;
insert into inventory_items (id, location_id, org_id, name, base_unit, current_cost)
  select ('e6000000-0000-4000-8000-' || lpad(to_hex(n * 16 + k), 12, '0'))::uuid, ${L('n')}, '${SPEED_ORG}', 'Item ' || k, 'each', 1
    from generate_series(1, ${sites}) n, generate_series(1, 8) k;
insert into recipes (id, location_id, name, recipe_type, yield_qty, yield_unit)
  select ('e7000000-0000-4000-8000-' || lpad(to_hex(n * 16 + d), 12, '0'))::uuid, ${L('n')}, 'Dish ' || d, 'MENU', 1, 'each'
    from generate_series(1, ${sites}) n, generate_series(1, 4) d;
insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, sort_order)
  select ${L('n')}, ('e7000000-0000-4000-8000-' || lpad(to_hex(n * 16 + d), 12, '0'))::uuid,
         ('e6000000-0000-4000-8000-' || lpad(to_hex(n * 16 + ((d + j) % 8) + 1), 12, '0'))::uuid, 1 + j, 'each', j
    from generate_series(1, ${sites}) n, generate_series(1, 4) d, generate_series(0, 2) j;
insert into menu_items (id, location_id, name) select 'sp-' || n || '-' || d, ${L('n')}::text, 'Dish ' || d from generate_series(1, ${sites}) n, generate_series(1, 4) d;
insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion)
  select ${L('n')}, 'sp-' || n || '-' || d, ('e7000000-0000-4000-8000-' || lpad(to_hex(n * 16 + d), 12, '0'))::uuid, 1
    from generate_series(1, ${sites}) n, generate_series(1, 4) d;
select public._post_stock_movement(i.location_id, i.id, 1000000, 'PURCHASE_RECEIPT', 1, 'purchase_order', 'sp', 'sp:' || i.id::text, now() - interval '1 day', null, null, null)
  from inventory_items i where i.org_id = '${SPEED_ORG}';
analyze inventory_items; analyze recipes; analyze recipe_lines; analyze menu_item_recipes; analyze stock_movements;
`;
}
// k checks from number `from`, spread over the sites, three lines each, as the tills write them (a
// trusted writer: the SQL editor here, one statement per batch).
export function speedChecksSql(from, k, sites, prefix = 'spd') {
  return `insert into closed_checks (id, location_id, items, order_type, source, ref, closed_at, subtotal, total, tax_amount, tenders)
  select '${prefix}-' || g, ('e5000000-0000-4000-8000-' || lpad(to_hex((g % ${sites}) + 1), 12, '0')),
         jsonb_build_array(jsonb_build_object('itemId', 'sp-' || ((g % ${sites}) + 1) || '-' || ((g % 4) + 1), 'qty', 1 + (g % 2), 'price', 3, 'uid', 'u1'),
                           jsonb_build_object('itemId', 'sp-' || ((g % ${sites}) + 1) || '-' || (((g + 1) % 4) + 1), 'qty', 1, 'price', 3, 'uid', 'u2'),
                           jsonb_build_object('itemId', 'sp-' || ((g % ${sites}) + 1) || '-' || (((g + 2) % 4) + 1), 'qty', 1, 'price', 3, 'uid', 'u3')),
         'dine-in', 'pos', '${prefix.toUpperCase()}' || g, now() - interval '1 minute', 9, 9, 1.5, '[{"method": "card", "amount": 9}]'::jsonb
    from generate_series(${from}, ${from + k - 1}) g`;
}

// -- the sales rule parity rows (JS checkSalesParts against the SQL port, contract 2.5) ----------------------
// Every path of accountingDay.js the port must follow: tenders, the post close tip gap, split, service,
// promo tender and its display line, loyalty and reward credits, gift cards, booking deposits, a 100%
// comp, strings and odd numbers inside the jsonb, and every legacy rule (kiosk, online credits, the
// name:amount list, composites, split, single method, the tax fallback).
export const PARITY_ROWS = [
  { id: 'sp-1', subtotal: 10, total: 10, tax_amount: 1.67, tenders: [{ method: 'cash', amount: 10 }] },
  { id: 'sp-2', subtotal: 20, total: 22.5, tax_amount: 3.33, tip: 2.5, tenders: [{ method: 'card', amount: 20, tip: 2.5 }] },
  { id: 'sp-3', subtotal: 30, total: 33, service: 3, tax_amount: 5, tenders: [{ method: 'Cash', amount: 16.5 }, { method: 'Card', amount: 16.5 }] },
  { id: 'sp-4', subtotal: 12, total: 14, tip: 2, tax_amount: 2, tenders: [{ method: 'card', amount: 12, tip: 0 }] },
  { id: 'sp-5', subtotal: 9, total: 9, tax_amount: 1.5, tenders: [{ method: 'loyalty', amount: 3 }, { method: 'card', amount: 6 }] },
  { id: 'sp-6', subtotal: 10, total: 9, tax_amount: 1.5, discounts: [{ source: 'promo', amount: 1 }], tenders: [{ method: 'promo', amount: 1 }, { method: 'card', amount: 9 }] },
  { id: 'sp-7', subtotal: 10, total: 9, tax_amount: 1.5, discounts: [{ type: 'promo', amount: 1 }], tenders: [{ method: 'card', amount: 9 }] },
  { id: 'sp-8', subtotal: 8, total: 8, tax_amount: 1.33, tenders: [{ method: 'Gift Card', amount: 5 }, { method: 'apple pay', amount: 3 }] },
  { id: 'sp-9', subtotal: 50, total: 50, tax_amount: 8.33, tenders: [{ method: 'booking_deposit', amount: 20 }, { method: 'card-external', amount: 30 }] },
  { id: 'sp-10', subtotal: 7, total: 0, tax_amount: 0, discounts: [{ amount: 7 }], tenders: [{ method: 'cash', amount: 7 }] },
  { id: 'sp-11', subtotal: 7, total: 3, tax_amount: 0.5, discounts: [{ amount: '4.00' }], tenders: [{ method: 'cash', amount: '3.00' }] },
  { id: 'sp-12', source: 'kiosk', subtotal: 15, total: 11, tip: 1, tax_amount: 1.67, payment_method: 'card-external', gift_card: { applied: 200 }, loyalty: { discount_value: 150 }, promo: { discount_value: 0.5 } },
  { id: 'sp-13', source: 'online', subtotal: 6, total: 0, tax_amount: 1, method: 'gift_card', payment_method: 'gift_card', gift_card: { legs: [{ applied: 400 }, { applied: 100, commit_error: 'x' }] }, loyalty: { discount_value: 200 } },
  { id: 'sp-14', subtotal: 30, total: 31, tip: 1, tax_amount: 5, payment_method: 'gift_card:10.00,loyalty:2.00,card:19.00' },
  { id: 'sp-15', subtotal: 20, total: 20, tax_amount: 3.33, payment_method: 'gift_card+card', gift_card: { applied: 500 } },
  { id: 'sp-16', subtotal: 40, total: 40, tax_amount: 6.67, payment_method: 'booking+cash', payment_intents: [{ id: null, amountMinor: 1500, method: 'booking_deposit' }] },
  { id: 'sp-17', subtotal: 25, total: 26, tip: 1, tax_amount: 4.17, payment_method: 'split' },
  { id: 'sp-18', subtotal: 10, total: 12, service: 1, tip: 0.5, payment_method: 'cash' },
  { id: 'sp-19', subtotal: 5, total: 5, tax_amount: 9, service: 7, tenders: [{ method: 'cash', amount: 5 }] },
  { id: 'sp-20', subtotal: 10, total: 10, tax_amount: 1.67, tenders: ['x', null, { method: 'cash', amount: 'abc' }, { method: 'card', amount: '1e1' }] },
  { id: 'sp-21', subtotal: 4, total: 4, tax_amount: 0.67, tenders: [], method: 'cash', payment_method: 'cash' },
  { id: 'sp-22', subtotal: 9, total: 9, tax_amount: 1.5, tenders: [{ method: 'terminal', amount: 4 }, { method: 'contactless', amount: 3 }, { method: 'voucher', amount: 2 }] },
  { id: 'sp-23', subtotal: 9, total: 9, tax_amount: 1.5, tenders: [{ method: 'rewards', amount: 2 }, { method: 'discount', amount: 1 }, { method: 'cash', amount: 6 }] },
  { id: 'sp-24', subtotal: 3.35, total: 3.35, tax_amount: 0.56, tenders: [{ method: 'cash', amount: 1.115 }, { method: 'card', amount: 2.235 }] },
  { id: 'sp-25', subtotal: 5, total: 5, tax_amount: 0.83, tenders: [{ method: 'cash', amount: -2 }, { method: 'card', amount: 7 }] },
  { id: 'sp-26', subtotal: 10, total: 11, tip: 1, tax_amount: 1.67, tenders: [{ method: 'cash', amount: 10, tip: 0 }] },
  { id: 'sp-27', source: 'kiosk', subtotal: 8, total: 8, tax_amount: 1.33, method: 'card' },
  { id: 'sp-28', subtotal: 12, total: 12, tax_amount: 2, payment_method: 'booking' },
  { id: 'sp-29', subtotal: 14, total: 14, tax_amount: 2.33, payment_method: 'gift card: 4.00, card: 10.00' },
  { id: 'sp-30', subtotal: 14, total: 14, tax_amount: 2.33, payment_method: 'loyalty+card' },
  { id: 'sp-31', subtotal: 6, total: 6, tax_amount: 1, tenders: [{ method: 'card', amount: 6 }], refunds: [{ id: 'r', amount: 3, items: [] }] },
  { id: 'sp-32', subtotal: 0, total: 0, tax_amount: 0, discounts: [{ amount: 1 }], tenders: [{ method: 'cash', amount: 0 }] },
  { id: 'sp-33', subtotal: 5, total: 5, tax_amount: 0.83, discounts: [{ value: 5 }], tenders: [{ method: 'cash', amount: 5 }] },
  { id: 'sp-34', subtotal: 18, total: 18, tax_amount: null, tip: 0, service: 0, payment_method: 'Card', method: 'card' },
  { id: 'sp-35', source: 'online', subtotal: 9, total: 4, tax_amount: 1.5, method: 'loyalty', payment_method: 'loyalty', loyalty: { discount_value: 500 } },
  { id: 'sp-36', subtotal: 11, total: 11, tax_amount: 1.83, tenders: [{ method: 'card', amount: 6, tip: 0.4 }, { method: 'gift', amount: 5 }], tip: 0.4 },
  { id: 'sp-37', subtotal: 2, total: 2, tax_amount: 0.33, tenders: [{ method: '', amount: 2 }] },
  { id: 'sp-38', subtotal: 6, total: 6, tax_amount: 1, tenders: [{ method: 'cash', amount: true }, { method: 'card', amount: 5 }] },
  { id: 'sp-39', subtotal: 6, total: 6, tax_amount: 1, tenders: [{ method: 'prepaid voucher', amount: 6 }] },
  { id: 'sp-40', subtotal: 5, total: 5, tax_amount: 0.83, tenders: [{ method: 'cash', amount: ' 5 ' }] },
];
