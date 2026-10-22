// node --test: the head office dashboard's words and sums (src/lib/stock/dashboardRules.js, Drop 4a).
// Synthetic ids and neutral site names only: the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RULES_LINE, DEMO_LINE, LEAGUE_NOTE, GP_MODES, CHOOSE_KEY_ITEMS, KEY_ITEMS_HINT, BUDGET_LATER, KEY_ITEMS_FULL,
  num, pctText, signedPctText, qtyText, wholeMoney, moneyText, toneOf, notPostedWords, dayWords,
  companyRows, siteRows, siteNameOf,
  CARD_COMPARE, cardsOf, cardBlocks, compareRowFor,
  tileRows, tileOf, countNoun,
  LEAGUE_COLUMNS, leagueCell, leagueSortValue, sortLeague,
  ATTENTION_KINDS, groupAttention, attentionSitesWords,
  byTypeRows,
  scopeWords, periodWords, compareWords, subLine,
  dashboardArgs, compareTotalsOf, reportGrid,
  targetKey, splitTargetKey, metricList, defaultTarget, savedTarget, effectiveTarget, betterHigh, targetRange,
  parseTargetCell, targetProblem, targetProblems, targetSaveRows, targetCellWords, targetConflictRows, withFreshVersions,
  USED_UNITS, SOLD_RULE_CHOICES, soldRuleChoice, soldRuleWords, keyRatioProblem, keyRatioSaveRow, keyRatioDraft,
  likeWords, searchMenuProducts,
} from './dashboardRules.js';
import { RULES_LINE as REPORT_RULES_LINE } from './reportRules.js';

const ORG = 'a0000000-0000-4000-8000-00000000000a';
const S1 = '10000000-0000-4000-8000-000000000001';
const S2 = '10000000-0000-4000-8000-000000000002';
const S3 = '10000000-0000-4000-8000-000000000003';
const K1 = '20000000-0000-4000-8000-000000000001';
const K2 = '20000000-0000-4000-8000-000000000002';
const K3 = '20000000-0000-4000-8000-000000000003';
const I1 = '30000000-0000-4000-8000-000000000001';

const noDash = (s) => assert.doesNotMatch(String(s), /[\u2013\u2014]/, `long dash in: ${s}`);

const site1 = {
  location_id: S1, site: 'North Site', currency: 'GBP', sales_net: 18420, sales_with_recipe_pct: 96.8,
  theo_cost: 4770.78, theo_pct: 25.9, actual_cost: 5010.24, actual_pct: 27.2, gp_pct_theo: 74.1, gp_pct_actual: 72.8,
  gap_value: -240, gap_pct: 1.3, waste_value: 350, waste_pct: 1.9, unaccounted: -300, surplus: 60,
  comps_cost: 147.36, comps_pct: 0.8, purchases: 4880, budget: null, stock_value_now: 3210, days_on_hand: 6.2,
  not_posted_count: 0, not_posted_value: 0,
  rag: { gp_pct: 'green', gap_pct: 'green', waste_pct: 'green', comps_pct: 'green', days_on_hand: 'green' },
};
const site2 = {
  ...site1, location_id: S2, site: 'South Site', sales_net: 9105, gp_pct_theo: 73.0, gp_pct_actual: 69.9,
  gap_value: -282, gap_pct: 3.1, waste_pct: 2.8, comps_pct: 1.4, purchases: 2640, budget: 2500, stock_value_now: 2050,
  days_on_hand: 8.4, rag: { gp_pct: 'amber', gap_pct: 'red', waste_pct: 'amber', comps_pct: 'green', days_on_hand: 'green' },
};
const company = {
  ...site1, location_id: null, site: null, sales_net: 27525, gp_pct_actual: 71.8, gp_pct_theo: 73.7,
  gap_value: -522, gap_pct: 1.9, purchases: 7520, stock_value_now: 5260, days_on_hand: 7.1, not_posted_count: 2, not_posted_value: 41.5,
  rag: { gp_pct: 'green', gap_pct: 'amber', waste_pct: 'green', comps_pct: 'green', days_on_hand: 'amber' },
};
const companyUsd = { ...company, currency: 'USD', sales_net: 1200, gap_value: 10, gap_pct: -0.8, purchases: 900, budget: 800 };

test('the fixed words are the mockup\'s, with no long dash anywhere', () => {
  assert.equal(RULES_LINE, 'The rules behind every number. Product GP adds up to site GP. Loyalty, staff and comps sit on their own line. Each venue uses its own business day. A locked month never changes. Two currencies are never added together.');
  assert.equal(DEMO_LINE, 'Demo history left out');
  assert.equal(LEAGUE_NOTE, 'Click a site to drill down: site, category, item, each movement, the invoice');
  assert.equal(CHOOSE_KEY_ITEMS, 'Choose your key items');
  assert.equal(KEY_ITEMS_HINT, 'Coffee groups usually track milk per milk drink, beans per shot and cups against cup drinks sold');
  assert.equal(KEY_ITEMS_FULL, 'That is 20 key items. Archive one first.');
  assert.deepEqual(GP_MODES.map((m) => m.id), ['gp', 'cost']);
  for (const w of [RULES_LINE, DEMO_LINE, LEAGUE_NOTE, KEY_ITEMS_HINT, BUDGET_LATER, ...ATTENTION_KINDS.map((k) => k.label), ...LEAGUE_COLUMNS.map((c) => c.label)]) noDash(w);
  assert.ok(Object.isFrozen(LEAGUE_COLUMNS) && Object.isFrozen(LEAGUE_COLUMNS[0]) && Object.isFrozen(GP_MODES));
});

test('numbers to words: percents, signed percents, quantities, whole money in the row\'s currency', () => {
  assert.equal(num('12.5'), 12.5);
  assert.equal(num(''), null);
  assert.equal(num(null), null);
  assert.equal(num('abc'), null);
  assert.equal(num(Infinity), null);
  assert.equal(pctText(74.14), '74.1%');
  assert.equal(pctText(0), '0.0%');
  assert.equal(pctText(null), '');
  assert.equal(signedPctText(7), '+7%');
  assert.equal(signedPctText(6.54), '+6.5%');
  assert.equal(signedPctText(-3), '-3%');
  assert.equal(signedPctText(0), '0%');
  assert.equal(signedPctText(null), '');
  assert.equal(qtyText(2288, 0), '2,288');
  assert.equal(qtyText(18.6), '18.6');
  assert.equal(qtyText(200), '200');
  assert.equal(qtyText(null), '');
  assert.equal(wholeMoney(18420, 'GBP'), '£18,420');
  assert.equal(wholeMoney(1234.5, 'USD'), '$1,235');
  assert.equal(wholeMoney(-240, 'GBP'), '-£240');
  assert.equal(wholeMoney(-0.2, 'GBP'), '£0', 'never minus zero');
  assert.equal(wholeMoney(null, 'GBP'), '');
  assert.equal(moneyText(12.345, 'EUR'), '€12.35');
  assert.equal(moneyText(-19.63, 'GBP'), '-£19.63');
  assert.equal(moneyText(null, 'GBP'), '');
  assert.deepEqual([toneOf('green'), toneOf('amber'), toneOf('red'), toneOf(null), toneOf('blue')], ['good', 'warn', 'bad', null, null]);
  assert.equal(notPostedWords(0), '0 sales waiting');
  assert.equal(notPostedWords(1), '1 sale waiting');
  assert.equal(notPostedWords(1200), '1,200 sales waiting');
  assert.equal(notPostedWords(null), '0 sales waiting');
  assert.equal(dayWords('2026-10-13'), 'Tue 13 Oct');
  assert.equal(dayWords('2026-10-12'), 'Mon 12 Oct');
  assert.equal(dayWords('nonsense'), '');
  assert.equal(dayWords(null), '');
});

test('totals split: site rows first, company rows per currency; a site name from a Map, an object or a function', () => {
  const totals = [site1, site2, company, companyUsd];
  assert.deepEqual(siteRows(totals).map((r) => r.site), ['North Site', 'South Site']);
  assert.deepEqual(companyRows(totals).map((r) => r.currency), ['GBP', 'USD']);
  assert.deepEqual(companyRows(null), []);
  assert.equal(companyRows([{ location_id: '', currency: 'GBP' }]).length, 1, 'an empty id is the company row');
  const map = new Map([[S1, { id: S1, name: 'North Site' }]]);
  assert.equal(siteNameOf(map, S1), 'North Site');
  assert.equal(siteNameOf({ [S2]: { name: 'South Site' } }, S2), 'South Site');
  assert.equal(siteNameOf({ [S2]: 'South Site' }, S2), 'South Site');
  assert.equal(siteNameOf((id) => (id === S3 ? 'East Site' : ''), S3), 'East Site');
  assert.equal(siteNameOf(map, S3), 'A site');
  assert.equal(siteNameOf(map, S3, 'One site'), 'One site');
  assert.equal(siteNameOf(null, null), 'A site');
});

test('the seven cards, the mockup\'s words: GP mode and cost mode, pills from the server\'s rag, budget later', () => {
  const cards = cardsOf(company, { mode: 'gp' });
  assert.deepEqual(cards.map((c) => c.key), ['sales', 'gp', 'gap', 'comps', 'purchases', 'stock', 'not_posted']);
  assert.deepEqual(cards.map((c) => c.label), ['Sales', 'GP % actual', 'Gap', 'Loyalty, staff and comps', 'Purchases', 'Stock value now', 'Not yet posted to stock']);
  const by = Object.fromEntries(cards.map((c) => [c.key, c]));
  assert.equal(by.sales.value, '£27,525');
  assert.equal(by.sales.sub, '96.8% with a recipe');
  assert.equal(by.sales.tone, null);
  assert.equal(by.sales.report, 'stock_cogs');
  assert.deepEqual(by.sales.compare, ['sales_net', 'money']);
  assert.equal(by.gp.value, '71.8%');
  assert.equal(by.gp.sub, 'theoretical 73.7%');
  assert.equal(by.gp.tone, 'good');
  assert.equal(by.gap.value, '1.9% of sales');
  assert.equal(by.gap.sub, '£522 · waste 1.9%', 'stock missing shown as a positive amount');
  assert.equal(by.gap.tone, 'warn', 'amber over 1.8 from the server\'s rag');
  assert.equal(by.gap.report, 'stock_gap');
  assert.equal(by.comps.value, '£147');
  assert.equal(by.comps.sub, '0.8% of sales, own line');
  assert.equal(by.comps.tone, null, 'the comps card has no pill: it is its own line, not a judgement');
  assert.equal(by.purchases.value, '£7,520');
  assert.equal(by.purchases.sub, 'budget comes with the purchasing update');
  assert.equal(by.purchases.tone, null);
  assert.equal(by.stock.value, '£5,260');
  assert.equal(by.stock.sub, 'days on hand 7.1');
  assert.equal(by.stock.report, 'stock_value');
  assert.equal(by.not_posted.value, '£42');
  assert.equal(by.not_posted.sub, '2 sales waiting');
  assert.equal(by.not_posted.tone, 'warn');
  assert.equal(by.not_posted.report, null);
  for (const c of cards) { noDash(c.label); noDash(c.sub); noDash(c.value); }

  const cost = Object.fromEntries(cardsOf(company, { mode: 'cost' }).map((c) => [c.key, c]));
  assert.equal(cost.gp.label, 'Cost of sales % actual');
  assert.equal(cost.gp.value, '27.2%');
  assert.equal(cost.gp.sub, 'theoretical 25.9%');
  assert.deepEqual(cost.gp.compare, ['actual_pct', 'pct']);
  assert.equal(cost.sales.value, '£27,525', 'only the GP card swaps');

  const usd = Object.fromEntries(cardsOf(companyUsd).map((c) => [c.key, c]));
  assert.equal(usd.sales.value, '$1,200', 'the row\'s own currency');
  assert.equal(usd.gap.value, '-0.8% of sales');
  assert.equal(usd.gap.sub, '$10 surplus · waste 1.9%');
  assert.equal(usd.purchases.sub, 'of $800 budget');
  assert.equal(usd.purchases.tone, 'bad', 'over budget');
  assert.equal(cardsOf({ ...companyUsd, purchases: 700 }).find((c) => c.key === 'purchases').tone, 'good');
});

test('cards never paint a zero for a figure that was not given, and say No sales on no sales', () => {
  const by = Object.fromEntries(cardsOf({ currency: 'GBP' }).map((c) => [c.key, c]));
  assert.equal(by.sales.value, 'No data');
  assert.equal(by.sales.sub, 'Sales not read');
  assert.equal(by.gp.value, 'No sales');
  assert.equal(by.gp.sub, 'theoretical not known');
  assert.equal(by.gap.value, 'No sales');
  assert.equal(by.stock.value, 'No data');
  assert.equal(by.stock.sub, 'days on hand: no use yet');
  assert.equal(by.not_posted.value, '£0');
  assert.equal(by.not_posted.sub, '0 sales waiting');
  const zero = Object.fromEntries(cardsOf({ ...company, sales_net: 0, gp_pct_actual: null, gp_pct_theo: null, gap_pct: null }).map((c) => [c.key, c]));
  assert.equal(zero.sales.value, '£0');
  assert.equal(zero.sales.sub, 'No sales');
  assert.equal(zero.gp.value, 'No sales');
  assert.equal(zero.gap.value, 'No sales');
  assert.deepEqual(Object.keys(CARD_COMPARE), ['sales', 'gp', 'cost', 'gap', 'comps', 'purchases', 'stock']);
});

test('one block of cards per currency, never added; the compare row is the same currency\'s company row', () => {
  const blocks = cardBlocks([site1, site2, company, companyUsd], { mode: 'gp' });
  assert.deepEqual(blocks.map((b) => b.currency), ['GBP', 'USD']);
  assert.equal(blocks[0].cards[0].value, '£27,525');
  assert.equal(blocks[1].cards[0].value, '$1,200');
  assert.equal(blocks[0].row.sales_net, 27525, 'the row rides along for the compare delta');
  assert.equal(blocks[1].row, companyUsd);
  assert.deepEqual(cardBlocks([site1, site2]), [], 'no company row: no cards (never a sum worked out here)');
  const then = [{ ...company, sales_net: 25000 }, { ...companyUsd, sales_net: 1000 }];
  assert.equal(compareRowFor(then, 'USD').sales_net, 1000);
  assert.equal(compareRowFor(then, 'GBP').sales_net, 25000);
  assert.equal(compareRowFor(then, 'EUR'), null);
  assert.equal(compareRowFor([{ ...company, currency: null }], null).sales_net, 27525);
  assert.equal(compareRowFor(null, 'GBP'), null);
});

test('key item tiles: the company row per ratio, recipe against actual, the count form for each', () => {
  const rows = [
    { ratio_id: K1, location_id: S1, name: 'Milk per milk drink', used_unit: 'ml', recipe_amount: 200, per_sold: 210, diff_pct: 5, rag: 'amber' },
    { ratio_id: K1, location_id: null, name: 'Milk per milk drink', used_unit: 'ml', recipe_amount: 200, per_sold: 214, diff_pct: 7, rag: 'amber' },
    { ratio_id: K2, location_id: null, name: 'Beans per shot', used_unit: 'g', recipe_amount: 18, per_sold: 18.6, diff_pct: 3.3, rag: 'green' },
    { ratio_id: K3, location_id: S1, name: 'Cups used against cup drinks sold', used_unit: 'each', recipe_amount: 1, sold_qty: 2288, used_qty: 2410, diff_pct: 5.3, rag: 'red' },
    { ratio_id: null, name: 'junk' },
  ];
  const tiles = tileRows(rows);
  assert.deepEqual(tiles.map((r) => [r.ratio_id, r.location_id]), [[K1, null], [K2, null], [K3, S1]], 'company row wins; a ratio with only site rows keeps its first site row');
  const milk = tileOf(tiles[0]);
  assert.deepEqual([milk.kind, milk.title, milk.recipeText, milk.actualText, milk.pillText, milk.tone, milk.ratioId], ['ratio', 'Milk per milk drink', '200 ml', '214 ml', '+7%', 'warn', K1]);
  const beans = tileOf(tiles[1]);
  assert.deepEqual([beans.recipeText, beans.actualText, beans.pillText, beans.tone], ['18 g', '18.6 g', '+3.3%', 'good']);
  const cups = tileOf(tiles[2]);
  assert.deepEqual([cups.kind, cups.recipeText, cups.actualText, cups.pillText, cups.tone], ['count', '2,288 sold', '2,410 used', '122 cups not rung through', 'bad']);
  // the cup recipe says two cups a drink: the extra is against that
  assert.equal(tileOf({ ...rows[3], recipe_amount: 2, used_qty: 4600 }).pillText, '24 cups not rung through');
  assert.equal(tileOf({ ...rows[3], name: 'Cups' }).pillText, '122 not rung through', 'a one word name: no noun');
  assert.equal(countNoun('Buns against burgers sold'), 'buns');
  assert.equal(countNoun('2 shot cups'), '');
  assert.equal(countNoun(null), '');
  assert.equal(tileOf({ ...rows[3], used_qty: 2288 }).pillText, '+5.3%', 'nothing extra: the server\'s diff');
  assert.equal(tileOf({ ...rows[3], used_qty: 2288, diff_pct: null, rag: null }).pillText, 'Matches the recipe');
  assert.equal(tileOf({ ...rows[3], sold_qty: null }).pillText, 'No sales');
  // not set, no sales, and the diff worked out when the server left it null
  const unset = tileOf({ ratio_id: K1, name: 'Milk', used_unit: 'ml', recipe_amount: null, per_sold: 214 });
  assert.deepEqual([unset.recipeText, unset.actualText, unset.pillText, unset.tone], ['Not set', '214 ml', 'Set the recipe amount', null]);
  const quiet = tileOf({ ratio_id: K1, name: 'Milk', used_unit: 'ml', recipe_amount: 200, per_sold: null });
  assert.deepEqual([quiet.actualText, quiet.pillText], ['No sales', 'No sales']);
  assert.equal(tileOf({ ratio_id: K1, name: 'Milk', used_unit: 'ml', recipe_amount: 200, per_sold: 190, diff_pct: null, rag: 'green' }).pillText, '-5%');
  assert.equal(tileOf({ ratio_id: K1, name: 'Milk', used_unit: 'EACH', sold_qty: 10, used_qty: 10 }).kind, 'count', 'unit words case blind');
  assert.deepEqual(tileRows(null), []);
});

test('the league: 13 columns exactly, the mockup\'s cells, a central kitchen row, the pills', () => {
  assert.deepEqual(LEAGUE_COLUMNS.map((c) => c.label), ['Site', 'Sales', 'GP % theo', 'GP % actual', 'Gap %', 'Waste %', 'Comps %', 'Purchases against budget', 'Stock value', 'Days on hand', 'Last full count', 'No recipe sales', 'Below par']);
  assert.deepEqual(LEAGUE_COLUMNS.filter((c) => c.rag).map((c) => c.key), ['gap_pct', 'waste_pct'], 'rag pills on Gap and Waste (Purchases Over and Last full count have their own rules)');
  assert.deepEqual(LEAGUE_COLUMNS.map((c) => c.report), [null, 'stock_cogs', 'stock_cogs', 'stock_cogs', 'stock_gap', 'stock_waste', 'stock_cogs', 'stock_purchases', 'stock_value', 'stock_days_on_hand', 'stock_movement', 'stock_setup_health', 'stock_par']);
  const col = (key) => LEAGUE_COLUMNS.find((c) => c.key === key);
  const row = { ...site2, last_full_count_day: '2026-10-12', last_full_count_words: 'Mon 12 Oct', no_recipe_pct: 6.5, below_par_count: 9 };
  assert.deepEqual(leagueCell(row, col('site')), { text: 'South Site', grey: false, pill: null, report: null });
  assert.deepEqual(leagueCell(row, col('sales_net')), { text: '£9,105', grey: false, pill: null, report: 'stock_cogs' });
  assert.deepEqual(leagueCell(row, col('gp_pct_theo')).text, '73.0%');
  assert.deepEqual(leagueCell(row, col('gap_pct')), { text: '3.1%', grey: false, pill: { text: '3.1%', tone: 'bad' }, report: 'stock_gap' });
  assert.deepEqual(leagueCell(row, col('waste_pct')).pill, { text: '2.8%', tone: 'warn' });
  assert.equal(leagueCell(row, col('comps_pct')).pill, null);
  assert.deepEqual(leagueCell(row, col('purchases')), { text: '£2,640 of £2,500', grey: false, pill: { text: 'Over', tone: 'bad' }, report: 'stock_purchases' });
  assert.deepEqual(leagueCell(site1, col('purchases')), { text: '£4,880', grey: false, pill: null, report: 'stock_purchases' }, 'no budget yet: the amount alone');
  assert.deepEqual(leagueCell(row, col('stock_value_now')).text, '£2,050');
  assert.deepEqual(leagueCell(row, col('days_on_hand')).text, '8.4');
  assert.deepEqual(leagueCell({ ...row, days_on_hand: null }, col('days_on_hand')), { text: 'No use', grey: true, pill: null, report: 'stock_days_on_hand' });
  assert.deepEqual(leagueCell(row, col('last_full_count_day')), { text: 'Mon 12 Oct', grey: false, pill: null, report: 'stock_movement' });
  assert.equal(leagueCell({ ...row, last_full_count_words: null }, col('last_full_count_day')).text, 'Mon 12 Oct', 'the day when the server sent no words');
  assert.deepEqual(leagueCell({ ...row, last_full_count_day: null, last_full_count_words: null }, col('last_full_count_day')), { text: 'None yet', grey: true, pill: null, report: 'stock_movement' });
  assert.equal(leagueCell(row, col('no_recipe_pct')).text, '6.5%');
  assert.equal(leagueCell(row, col('below_par_count')).text, '9');
  assert.equal(leagueCell({ ...row, below_par_count: null }, col('below_par_count')).text, '');
  // a central kitchen: None for sales, blanks for GP, gap, comps and no recipe; its own stock figures stay
  const kitchen = { ...row, site: 'Central Kitchen', kitchen: true, currency: 'GBP', sales_net: null };
  assert.deepEqual(leagueCell(kitchen, col('sales_net')), { text: 'None', grey: true, pill: null, report: 'stock_cogs' });
  for (const k of ['gp_pct_theo', 'gp_pct_actual', 'gap_pct', 'comps_pct', 'no_recipe_pct']) assert.deepEqual(leagueCell(kitchen, col(k)).text, '', k);
  assert.equal(leagueCell(kitchen, col('gap_pct')).pill, null);
  assert.equal(leagueCell(kitchen, col('stock_value_now')).text, '£2,050');
  assert.equal(leagueCell(kitchen, col('waste_pct')).text, '2.8%');
  // USD row keeps its own symbol
  assert.equal(leagueCell({ ...row, currency: 'USD' }, col('sales_net')).text, '$9,105');
});

test('league sorting: numbers both ways, names, nulls last, ties keep the server\'s order', () => {
  const kitchen = { location_id: S3, site: 'Central Kitchen', kitchen: true, sales_net: null, gap_pct: null, stock_value_now: 900, last_full_count_day: null };
  const rows = [site1, kitchen, site2];
  assert.deepEqual(sortLeague(rows).map((r) => r.site), ['North Site', 'South Site', 'Central Kitchen'], 'default sales desc, null last');
  assert.deepEqual(sortLeague(rows, { key: 'sales_net', dir: 'asc' }).map((r) => r.site), ['South Site', 'North Site', 'Central Kitchen'], 'null last going up too');
  assert.deepEqual(sortLeague(rows, { key: 'site', dir: 'asc' }).map((r) => r.site), ['Central Kitchen', 'North Site', 'South Site']);
  assert.deepEqual(sortLeague(rows, { key: 'site', dir: 'desc' }).map((r) => r.site), ['South Site', 'North Site', 'Central Kitchen']);
  assert.deepEqual(sortLeague(rows, { key: 'gap_pct', dir: 'desc' }).map((r) => r.site), ['South Site', 'North Site', 'Central Kitchen']);
  assert.deepEqual(sortLeague(rows, { key: 'stock_value_now', dir: 'asc' }).map((r) => r.site), ['Central Kitchen', 'South Site', 'North Site']);
  const tie = [{ site: 'B', sales_net: 5 }, { site: 'A', sales_net: 5 }, { site: 'C', sales_net: 5 }];
  assert.deepEqual(sortLeague(tie, { key: 'sales_net', dir: 'desc' }).map((r) => r.site), ['B', 'A', 'C']);
  assert.deepEqual(sortLeague(tie, { key: 'sales_net', dir: 'asc' }).map((r) => r.site), ['B', 'A', 'C']);
  assert.equal(leagueSortValue({ site: 'North Site' }, 'site'), 'north site');
  assert.equal(leagueSortValue({ last_full_count_day: '2026-10-12' }, 'last_full_count_day'), '2026-10-12');
  assert.equal(leagueSortValue({ sales_net: '12' }, 'sales_net'), 12);
  assert.deepEqual(sortLeague(null), []);
  const before = [site1, site2];
  sortLeague(before, { key: 'sales_net', dir: 'asc' });
  assert.deepEqual(before.map((r) => r.site), ['North Site', 'South Site'], 'never sorts in place');
});

test('needs attention: grouped by kind in the fixed order, counts added, Fix only on sites out of step', () => {
  const rows = [
    { kind: 'not_posted', location_id: S1, site: 'North Site', count: 2, words: '2 sales not yet posted to stock', ref: null },
    { kind: 'out_of_step', location_id: S2, site: 'South Site', count: 4, words: 'Site out of step. Fix.', ref: null },
    { kind: 'negative_stock', location_id: S1, site: 'North Site', count: 3, words: '3 items below zero', ref: null },
    { kind: 'negative_stock', location_id: S2, site: 'South Site', count: 1, words: '1 item below zero', ref: null },
    { kind: 'missed_count', location_id: S2, site: 'South Site', count: 1, words: 'Count missed', ref: null },
    { kind: 'below_minimum', location_id: S1, site: 'North Site', count: 0 },
    null,
  ];
  const g = groupAttention(rows);
  assert.deepEqual(g.map((x) => [x.kind, x.label, x.count, x.fixable, x.report]), [
    ['negative_stock', 'Negative stock', 4, false, 'stock_par'],
    ['out_of_step', 'Sites out of step', 4, true, 'stock_setup_health'],
    ['not_posted', 'Sales not yet posted to stock', 2, false, null],
    ['missed_count', 'Missed count', 1, false, null],
  ]);
  assert.deepEqual(g[0].sites, [
    { location_id: S1, site: 'North Site', count: 3, words: '3 items below zero', ref: null },
    { location_id: S2, site: 'South Site', count: 1, words: '1 item below zero', ref: null },
  ]);
  // v5.11.92 integration: a kind opens its report on the right tab (negative stock on Negative stock).
  assert.deepEqual(g.map((x) => x.opts), [{ level: 'negative' }, null, null, null]);
  assert.deepEqual(groupAttention(null), []);
  assert.deepEqual(ATTENTION_KINDS.map((k) => k.kind), ['negative_stock', 'below_minimum', 'out_of_step', 'invoice_review', 'clock_disagrees', 'demo_history', 'not_posted']);
  assert.equal(attentionSitesWords(g[0].sites), 'North Site: 3, South Site: 1');
  assert.equal(attentionSitesWords([{ site: 'A', count: 1 }, { site: 'B', count: 2 }, { site: 'C', count: 3 }, { site: 'D', count: 4 }]), 'A: 1, B: 2 and 2 more');
  assert.equal(attentionSitesWords([]), '');
});

test('GP by type: food, drink, other in that order with labels; a new type after them', () => {
  const rows = byTypeRows([{ type: 'other', sales_net: 1 }, { type: 'drink', sales_net: 2 }, { type: 'retail', sales_net: 4 }, { type: 'food', sales_net: 3 }, { type: null }]);
  assert.deepEqual(rows.map((r) => [r.type, r.label, r.sales_net]), [['food', 'Food', 3], ['drink', 'Drink', 2], ['other', 'Other', 1], ['retail', 'Retail', 4]]);
  assert.equal(Object.keys(rows[0]).includes('_i'), false);
  assert.deepEqual(byTypeRows(undefined), []);
});

test('the sub line: scope words, period words, compare words, joined with a middle dot', () => {
  const siteById = new Map([[S1, { id: S1, name: 'North Site' }], [S2, { id: S2, name: 'South Site' }], [S3, { id: S3, name: 'Old Site', status: 'closed' }]]);
  const groups = [{ id: 'g1', name: 'North', locationIds: [S1] }, { id: 'g2', name: 'Both', location_ids: [S1, S2] }];
  assert.equal(scopeWords([S1, S2], siteById, groups), 'All sites', 'every open site (the closed one does not count)');
  assert.equal(scopeWords([S2, S1], siteById, groups), 'All sites');
  assert.equal(scopeWords([S1], siteById, groups), 'North', 'a group of one wins over the site name');
  assert.equal(scopeWords([S2], siteById, groups), 'South Site');
  assert.equal(scopeWords([S1, S3], siteById, groups), '2 of 2 sites', 'a closed site ticked: n of m');
  assert.equal(scopeWords([S1, S2], new Map([...siteById, [K1, { id: K1, name: 'East Site' }]]), []), '2 of 3 sites');
  assert.equal(scopeWords([], siteById, groups), 'No sites');
  assert.equal(scopeWords([S1], {}, []), 'One site');
  assert.equal(periodWords({ fromDay: '2026-10-12', toDay: '2026-10-18' }), 'Mon 12 Oct to Sun 18 Oct');
  assert.equal(periodWords({ fromDay: '2026-10-12', toDay: '2026-10-12' }), 'Mon 12 Oct');
  assert.equal(periodWords({ from: '2026-10-12', to: '2026-10-18' }), 'Mon 12 Oct to Sun 18 Oct', 'either key shape');
  assert.equal(periodWords({ fromDay: '2026-10-12', toDay: '2026-10-18', betweenCounts: true }), 'Between two counts');
  assert.equal(periodWords(null), '');
  assert.equal(periodWords({}), '');
  assert.equal(compareWords({ label: 'vs last week' }), 'compared with last week');
  assert.equal(compareWords({ label: 'vs the same days last year' }), 'compared with the same days last year');
  assert.equal(compareWords({ label: '' }), null);
  assert.equal(compareWords(null), null);
  assert.equal(subLine({ scope: 'All sites', period: 'Mon 12 Oct to Sun 18 Oct', compare: { label: 'vs last week' } }),
    'Head office dashboard · All sites · Mon 12 Oct to Sun 18 Oct · compared with last week · each venue on its own business day');
  assert.equal(subLine({ scope: 'North Site' }), 'Head office dashboard · North Site · each venue on its own business day');
  assert.equal(subLine(), 'Head office dashboard · each venue on its own business day');
  noDash(subLine({ scope: 'x', period: 'y', compare: { label: 'vs z' } }));
});

test('the one call: the report args plus the compare range; the compare totals whichever key', () => {
  const a = dashboardArgs({ orgId: ORG, sites: [S1, null, S2], range: { fromDay: '2026-10-12', toDay: '2026-10-18', betweenCounts: false }, compare: { from: '2026-10-05', to: '2026-10-11', label: 'vs last week' } });
  assert.deepEqual(a, { orgId: ORG, sites: [S1, S2], from: '2026-10-12', to: '2026-10-18', opts: { between_counts: false }, compare: { from: '2026-10-05', to: '2026-10-11', label: 'vs last week' } });
  const b = dashboardArgs({ orgId: ORG, sites: [S1], range: { fromDay: '2026-07-20', toDay: '2026-10-18', betweenCounts: true } });
  assert.deepEqual([b.opts, b.compare, 'nonce' in b], [{ between_counts: true }, null, false]);
  assert.deepEqual(dashboardArgs({}).sites, []);
  assert.equal(dashboardArgs({ compare: { label: 'x' } }).compare, null, 'a compare with no days is no compare');
  assert.deepEqual(compareTotalsOf({ compare: { totals: [company] } }), [company]);
  assert.deepEqual(compareTotalsOf({ then: { totals: [company] } }), [company]);
  assert.equal(compareTotalsOf({ compare: { totals: [] } }), null);
  assert.equal(compareTotalsOf(null), null);
});

test('the all reports grid: the Catalog stock category minus the dashboard, later tiles carry their words', () => {
  const cats = [
    { id: 'sales', reports: [{ id: 'summary', label: 'Business summary' }] },
    { id: 'stock', reports: [
      { id: 'stock_home', label: 'Head office dashboard' },
      { id: 'stock_value', label: 'Stock value', desc: 'Any past date' },
      { id: 'stock_recipe_cost', label: 'Recipe cost alerts', desc: 'Cost rises', later: 'recipes' },
      { id: 'stock_budget', label: 'Purchase budget', desc: 'Per site', later: 'purchasing' },
      { id: 'stock_odd', label: 'Odd', later: 'other' },
    ] },
  ];
  const words = { recipes: 'Comes with the recipes update', purchasing: 'Comes with the purchasing update' };
  const grid = reportGrid(cats, words);
  assert.deepEqual(grid, [
    { id: 'stock_value', label: 'Stock value', desc: 'Any past date', later: null, laterWords: null },
    { id: 'stock_recipe_cost', label: 'Recipe cost alerts', desc: 'Cost rises', later: 'recipes', laterWords: 'Comes with the recipes update' },
    { id: 'stock_budget', label: 'Purchase budget', desc: 'Per site', later: 'purchasing', laterWords: 'Comes with the purchasing update' },
    { id: 'stock_odd', label: 'Odd', desc: '', later: 'other', laterWords: 'Comes with a later update' },
  ]);
  assert.deepEqual(reportGrid([], words), []);
  assert.deepEqual(reportGrid(null), []);
});

// ── targets ──────────────────────────────────────────────────────────────────────────────────────

const METRICS = [{ key: 'gp_pct', label: 'GP %' }, { key: 'gap_pct', label: 'Gap %' }, { key: 'days_on_hand', label: 'Days on hand' }];
const DEFAULTS = { gp_pct: { green_to: 70, amber_to: 65 }, gap_pct: { green_to: 1.8, amber_to: 2.5 }, days_on_hand: [7, 10] };
const SAVED = [
  { id: 't1', location_id: null, metric: 'gp_pct', green_to: 72, amber_to: 66, row_version: 2 },
  { id: 't2', location_id: S2, metric: 'gp_pct', green_to: 68, amber_to: 60, row_version: 1 },
  { id: 't3', location_id: null, metric: 'gap_pct', green_to: 1.5, amber_to: 2, row_version: 1 },
];

test('target keys, metric list shapes, defaults shapes, saved and effective targets', () => {
  assert.equal(targetKey(null, 'gp_pct'), 'company:gp_pct');
  assert.equal(targetKey(S1, 'gap_pct'), `${S1}:gap_pct`);
  assert.deepEqual(splitTargetKey('company:gp_pct'), { location_id: null, metric: 'gp_pct' });
  assert.deepEqual(splitTargetKey(`${S1}:gap_pct`), { location_id: S1, metric: 'gap_pct' });
  assert.deepEqual(splitTargetKey('gp_pct'), { location_id: null, metric: 'gp_pct' });
  assert.deepEqual(metricList(METRICS).map((m) => [m.key, m.label]), [['gp_pct', 'GP %'], ['gap_pct', 'Gap %'], ['days_on_hand', 'Days on hand']]);
  assert.deepEqual(metricList([{ id: 'gp_pct', label: 'GP %' }, { metric: 'gap_pct' }]).map((m) => [m.key, m.label]), [['gp_pct', 'GP %'], ['gap_pct', 'gap_pct']]);
  assert.deepEqual(metricList(['gp_pct']).map((m) => [m.key, m.label]), [['gp_pct', 'gp_pct']]);
  assert.deepEqual(metricList({ gp_pct: 'GP %', gap_pct: { label: 'Gap %' } }).map((m) => [m.key, m.label]), [['gp_pct', 'GP %'], ['gap_pct', 'Gap %']]);
  assert.deepEqual(metricList(null), []);
  assert.deepEqual(defaultTarget(DEFAULTS, 'gp_pct'), { green_to: 70, amber_to: 65 });
  assert.deepEqual(defaultTarget(DEFAULTS, 'days_on_hand'), { green_to: 7, amber_to: 10 });
  assert.deepEqual(defaultTarget({ x: { green: 1, amber: 2 } }, 'x'), { green_to: 1, amber_to: 2 });
  assert.deepEqual(defaultTarget(DEFAULTS, 'nope'), { green_to: null, amber_to: null });
  assert.equal(savedTarget(SAVED, null, 'gp_pct').id, 't1');
  assert.equal(savedTarget(SAVED, S2, 'gp_pct').id, 't2');
  assert.equal(savedTarget(SAVED, S1, 'gp_pct'), null);
  assert.deepEqual(effectiveTarget(SAVED, S2, 'gp_pct', DEFAULTS), { green_to: 68, amber_to: 60, source: 'site' });
  assert.deepEqual(effectiveTarget(SAVED, S1, 'gp_pct', DEFAULTS), { green_to: 72, amber_to: 66, source: 'company' });
  assert.deepEqual(effectiveTarget(SAVED, S1, 'days_on_hand', DEFAULTS), { green_to: 7, amber_to: 10, source: 'default' });
  assert.deepEqual(effectiveTarget(SAVED, null, 'gap_pct', DEFAULTS), { green_to: 1.5, amber_to: 2, source: 'company' });
  assert.equal(betterHigh('gp_pct'), true);
  assert.equal(betterHigh('gap_pct'), false);
  assert.equal(betterHigh('x', ['x']), true);
  assert.deepEqual(targetRange('days_on_hand'), { min: 0, max: 365 });
  assert.deepEqual(targetRange('gp_pct'), { min: 0, max: 100 });
});

test('a typed cell: both or neither, numbers in range, green on the better side of amber (the database\'s words)', () => {
  assert.deepEqual(parseTargetCell({ green_to: ' 70 ', amber_to: '' }), { green_to: 70, amber_to: null });
  assert.deepEqual(parseTargetCell({ green_to: 'abc', amber_to: 5 }), { green_to: 'abc', amber_to: 5 });
  assert.deepEqual(parseTargetCell(null), { green_to: null, amber_to: null });
  assert.equal(targetProblem('gp_pct', { green_to: '', amber_to: '' }), null, 'empty: follows the company');
  assert.equal(targetProblem('gp_pct', { green_to: '70', amber_to: '' }), 'Type both green and amber.');
  assert.equal(targetProblem('gp_pct', { green_to: 'x', amber_to: '65' }), 'Type a number from 0 to 100.');
  assert.equal(targetProblem('gp_pct', { green_to: '101', amber_to: '65' }), 'Type a number from 0 to 100.');
  assert.equal(targetProblem('days_on_hand', { green_to: '7', amber_to: '400' }), 'Type a number from 0 to 365.');
  assert.equal(targetProblem('gp_pct', { green_to: '65', amber_to: '70' }), 'Green must be the better side of amber.');
  assert.equal(targetProblem('gp_pct', { green_to: '70', amber_to: '65' }), null);
  assert.equal(targetProblem('gp_pct', { green_to: '70', amber_to: '70' }), null, 'equal is allowed, like the check');
  assert.equal(targetProblem('gap_pct', { green_to: '2.5', amber_to: '1.8' }), 'Green must be the better side of amber.');
  assert.equal(targetProblem('gap_pct', { green_to: '1.8', amber_to: '2.5' }), null);
  assert.equal(targetProblem('waste_pct', { green_to: '1', amber_to: '2' }, ['waste_pct']), 'Green must be the better side of amber.', 'the better high list is the caller\'s');
  assert.deepEqual(targetProblems({ 'company:gp_pct': { green_to: '70', amber_to: '65' }, [`${S1}:gap_pct`]: { green_to: '3', amber_to: '2' } }), { [`${S1}:gap_pct`]: 'Green must be the better side of amber.' });
  assert.deepEqual(targetProblems({}), {});
  assert.deepEqual(targetProblems(null), {});
});

test('the save rows: changed with its version, cleared as a delete, new with null, unchanged left out', () => {
  const draft = {
    'company:gp_pct': { green_to: '72', amber_to: '66' },           // unchanged
    [`${S2}:gp_pct`]: { green_to: '', amber_to: '' },               // cleared: back to the company row
    'company:gap_pct': { green_to: '1.8', amber_to: '2.5' },        // changed
    [`${S1}:gap_pct`]: { green_to: '1', amber_to: '2' },            // new
    [`${S1}:gp_pct`]: { green_to: '', amber_to: '' },               // never saved and empty: nothing
  };
  assert.deepEqual(targetSaveRows(draft, SAVED), [
    { location_id: S2, metric: 'gp_pct', delete: true, row_version: 1 },
    { location_id: null, metric: 'gap_pct', green_to: 1.8, amber_to: 2.5, row_version: 1 },
    { location_id: S1, metric: 'gap_pct', green_to: 1, amber_to: 2, row_version: null },
  ]);
  assert.deepEqual(targetSaveRows({ 'company:gp_pct': { green_to: '72.0', amber_to: '66' } }, SAVED), [], 'the same number in other letters is unchanged');
  assert.deepEqual(targetSaveRows({}, SAVED), []);
  assert.deepEqual(targetSaveRows(null, null), []);
  assert.deepEqual(targetSaveRows({ 'company:gp_pct': { green_to: '70', amber_to: '65' } }, [{ location_id: null, metric: 'gp_pct', green_to: 72, amber_to: 66 }]),
    [{ location_id: null, metric: 'gp_pct', green_to: 70, amber_to: 65, row_version: null }], 'a saved row with no version sends null (the database says reload)');
});

test('the Someone saved first table for targets, and the rows again with the fresh versions', () => {
  const mine = [
    { location_id: null, metric: 'gp_pct', green_to: 71, amber_to: 64, row_version: 2 },
    { location_id: S2, metric: 'gp_pct', delete: true, row_version: 1 },
    { location_id: S1, metric: 'gap_pct', green_to: 1, amber_to: 2, row_version: null },
  ];
  const fresh = [
    { id: 't1', location_id: null, metric: 'gp_pct', green_to: 75, amber_to: 70, row_version: 3 },
    { id: 't3', location_id: null, metric: 'gap_pct', green_to: 1.5, amber_to: 2, row_version: 1 },
  ];
  const nameOf = (id) => ({ [S1]: 'North Site', [S2]: 'South Site' })[id];
  assert.deepEqual(targetConflictRows(mine, fresh, METRICS, nameOf), [
    { label: 'GP %, company default', theirs: 'Green 75, amber 70', mine: 'Green 71, amber 64' },
    { label: 'GP %, at South Site', theirs: '(none)', mine: '(cleared)' },
    { label: 'Gap %, at North Site', theirs: '(none)', mine: 'Green 1, amber 2' },
  ]);
  assert.equal(targetCellWords(null), '(none)');
  assert.equal(targetCellWords({ green_to: '', amber_to: '' }), '(none)');
  assert.deepEqual(withFreshVersions(mine, fresh), [
    { location_id: null, metric: 'gp_pct', green_to: 71, amber_to: 64, row_version: 3 },
    { location_id: S1, metric: 'gap_pct', green_to: 1, amber_to: 2, row_version: null },
  ], 'a delete of a row someone already removed is dropped; a new row stays new');
  for (const r of targetConflictRows(mine, fresh, METRICS, nameOf)) noDash(r.label);
});

// ── key items ────────────────────────────────────────────────────────────────────────────────────

test('what counts as sold: the quick choices, reading a stored rule, its words', () => {
  assert.deepEqual(SOLD_RULE_CHOICES.map((c) => c.id), ['drinks', 'food', 'all', 'category', 'items']);
  assert.deepEqual(SOLD_RULE_CHOICES.map((c) => c.label), ['All drinks', 'All food', 'Every sale', 'A category', 'Chosen products']);
  assert.deepEqual(USED_UNITS, ['ml', 'g', 'each']);
  assert.equal(soldRuleChoice({ kind: 'category', accounting_group: 'Drinks' }), 'drinks');
  assert.equal(soldRuleChoice({ kind: 'category', accounting_group: 'food' }), 'food');
  assert.equal(soldRuleChoice({ kind: 'category', accounting_group: 'Retail' }), 'category');
  assert.equal(soldRuleChoice({ kind: 'all' }), 'all');
  assert.equal(soldRuleChoice({ kind: 'items', menu_item_ids: ['m1'] }), 'items');
  assert.equal(soldRuleChoice(null), 'all');
  assert.equal(soldRuleWords({ kind: 'category', accounting_group: 'Drinks' }), 'All drinks');
  assert.equal(soldRuleWords({ kind: 'category', accounting_group: 'Food' }), 'All food');
  assert.equal(soldRuleWords({ kind: 'category', accounting_group: 'Retail' }), 'Category: Retail');
  assert.equal(soldRuleWords({ kind: 'category', accounting_group: '' }), 'Not set');
  assert.equal(soldRuleWords({ kind: 'all' }), 'Every sale');
  assert.equal(soldRuleWords({ kind: 'items', menu_item_ids: ['m1'] }), '1 chosen product');
  assert.equal(soldRuleWords({ kind: 'items', menu_item_ids: ['m1', 'm2', 'm3'] }), '3 chosen products');
  assert.equal(soldRuleWords({}), 'Not set');
  assert.equal(soldRuleWords(null), 'Not set');
});

test('a key item: what stops it saving, the save row, the draft from a row', () => {
  const ok = { name: ' Milk per milk drink ', used_item_id: I1, used_unit: 'ml', sold_rule: { kind: 'category', accounting_group: 'Drinks' }, recipe_amount: '200' };
  assert.equal(keyRatioProblem(ok), null);
  assert.equal(keyRatioProblem({ ...ok, name: '  ' }), 'Give the key item a name.');
  assert.equal(keyRatioProblem({ ...ok, used_item_id: null }), 'Pick the stock item it uses.');
  assert.equal(keyRatioProblem({ ...ok, used_unit: 'litres' }), 'Pick the unit: ml, g or each.');
  assert.equal(keyRatioProblem({ ...ok, sold_rule: null }), 'Pick what counts as sold.');
  assert.equal(keyRatioProblem({ ...ok, sold_rule: { kind: 'category', accounting_group: ' ' } }), 'Pick what counts as sold.');
  assert.equal(keyRatioProblem({ ...ok, sold_rule: { kind: 'items', menu_item_ids: [] } }), 'Pick what counts as sold.');
  assert.equal(keyRatioProblem({ ...ok, sold_rule: { kind: 'items', menu_item_ids: ['m1'] } }), null);
  assert.equal(keyRatioProblem({ ...ok, sold_rule: { kind: 'all' } }), null);
  assert.equal(keyRatioProblem({ ...ok, recipe_amount: 'two' }), 'Type the recipe amount as a number.');
  assert.equal(keyRatioProblem({ ...ok, recipe_amount: '-1' }), 'Type the recipe amount as a number.');
  assert.equal(keyRatioProblem({ ...ok, recipe_amount: '' }), null, 'the recipe amount may wait');
  const twenty = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, archived_at: null }));
  assert.equal(keyRatioProblem(ok, twenty), KEY_ITEMS_FULL);
  assert.equal(keyRatioProblem({ ...ok, id: 'r1' }, twenty), null, 'editing one of the 20 is fine');
  assert.equal(keyRatioProblem(ok, [...twenty.slice(0, 19), { id: 'x', archived_at: '2026-01-01' }]), null, 'archived ones do not count');

  assert.deepEqual(keyRatioSaveRow(ok), {
    id: null, name: 'Milk per milk drink', used_item_id: I1, used_unit: 'ml', sold_rule: { kind: 'category', accounting_group: 'Drinks' },
    recipe_amount: 200, sort_order: 0, row_version: null, archive: false,
  });
  assert.deepEqual(keyRatioSaveRow({ ...ok, id: 'r1', row_version: '3', sort_order: '2.7', recipe_amount: '', sold_rule: { kind: 'items', menu_item_ids: ['m2', 'm1', 'm2', null] } }, { archive: true }), {
    id: 'r1', name: 'Milk per milk drink', used_item_id: I1, used_unit: 'ml', sold_rule: { kind: 'items', menu_item_ids: ['m2', 'm1'] },
    recipe_amount: null, sort_order: 2, row_version: 3, archive: true,
  });
  assert.deepEqual(keyRatioSaveRow({ ...ok, sold_rule: { kind: 'all', accounting_group: 'junk' } }).sold_rule, { kind: 'all' });
  assert.deepEqual(keyRatioSaveRow({ ...ok, sold_rule: { kind: 'category', accounting_group: ' Retail ' } }).sold_rule, { kind: 'category', accounting_group: 'Retail' });

  const row = { id: 'r1', name: 'Beans per shot', used_item_id: I1, used_unit: 'g', sold_rule: { kind: 'category', accounting_group: 'Drinks' }, recipe_amount: 18, sort_order: 1, row_version: 4 };
  assert.deepEqual(keyRatioDraft(row, 'Espresso beans 1kg'), {
    id: 'r1', name: 'Beans per shot', used_item_id: I1, used_item_name: 'Espresso beans 1kg', used_unit: 'g',
    sold_rule: { kind: 'category', accounting_group: 'Drinks' }, recipe_amount: '18', sort_order: 1, row_version: 4,
  });
  assert.deepEqual(keyRatioDraft(null), {
    id: null, name: '', used_item_id: null, used_item_name: '', used_unit: 'ml',
    sold_rule: { kind: 'category', accounting_group: 'Drinks' }, recipe_amount: '', sort_order: 0, row_version: null,
  });
  const copy = keyRatioDraft(row);
  copy.sold_rule.kind = 'all';
  assert.equal(row.sold_rule.kind, 'category', 'the draft never shares the row\'s rule object');
});

// A stand in for the Ops client: records the chain and answers what it is told.
function fakeClient(answer) {
  const calls = [];
  const chain = {
    select: (c) => { calls.push(['select', c]); return chain; },
    in: (k, v) => { calls.push(['in', k, v]); return chain; },
    eq: (k, v) => { calls.push(['eq', k, v]); return chain; },
    ilike: (k, v) => { calls.push(['ilike', k, v]); return chain; },
    order: (k) => { calls.push(['order', k]); return chain; },
    limit: (n) => { calls.push(['limit', n]); return Promise.resolve(typeof answer === 'function' ? answer() : answer); },
  };
  return { calls, from: (t) => { calls.push(['from', t]); return chain; } };
}

test('the product search for Chosen products: live items at the sites in scope, like words made safe', async () => {
  assert.equal(likeWords(' 50% off_x '), '50\\% off\\_x');
  assert.equal(likeWords('a\\b'), 'a\\\\b');
  assert.equal(likeWords(null), '');

  const c = fakeClient({ data: [{ id: 101, name: 'Flat white', location_id: S1 }, { id: 'm2', name: null, location_id: S2 }, null, { name: 'no id' }], error: null });
  const r = await searchMenuProducts(c, { sites: [S1, null, S2], search: ' flat ', limit: 500 });
  assert.equal(r.error, null);
  assert.deepEqual(r.data, [{ id: '101', name: 'Flat white', location_id: S1 }, { id: 'm2', name: 'Product', location_id: S2 }]);
  assert.deepEqual(c.calls, [
    ['from', 'menu_items'], ['select', 'id, name, location_id'], ['in', 'location_id', [S1, S2]], ['eq', 'archived', false],
    ['ilike', 'name', '%flat%'], ['order', 'name'], ['limit', 50],
  ], 'at most 50 rows, never an archived product, only the sites in scope');

  const quiet = fakeClient({ data: [], error: null });
  assert.deepEqual(await searchMenuProducts(quiet, { sites: [S1], search: 'f' }), { data: [], error: null });
  assert.deepEqual(await searchMenuProducts(quiet, { sites: [], search: 'flat' }), { data: [], error: null });
  assert.equal(quiet.calls.length, 0, 'under two letters or no sites: nothing is asked');

  const refused = await searchMenuProducts(fakeClient({ data: null, error: { message: 'permission denied' } }), { sites: [S1], search: 'flat' });
  assert.deepEqual([refused.data, refused.error.message], [[], 'permission denied']);
  const thrown = await searchMenuProducts(fakeClient(() => { throw new Error('offline'); }), { sites: [S1], search: 'flat' });
  assert.deepEqual([thrown.data, thrown.error.message], [[], 'offline']);
  const none = await searchMenuProducts(null, { sites: [S1], search: 'flat' });
  assert.equal(none.error.message, 'No database');
});

test('one rules line for the dashboard and every report', () => {
  assert.equal(RULES_LINE, REPORT_RULES_LINE);
});

// The screens: the wiring that matters, read from the files (no React under node:test).
const src = (f) => readFileSync(new URL(`../../backoffice/sections/reports/${f}`, import.meta.url), 'utf8');

test('the dashboard screens: one call, the later words from reportLink, a site click keeps the dashboard', () => {
  const dash = src('StockDashboard.jsx');
  assert.match(dash, /useStockReport\(api, 'dashboard', args\)/);
  assert.equal((dash.match(/useStockReport\(/g) || []).length, 1, 'the dashboard is one call');
  assert.match(dash, /import \{ LATER_WORDS \} from '\.\.\/\.\.\/\.\.\/lib\/stock\/reportLink';/);
  assert.doesNotMatch(dash, /LATER_WORDS \} from '\.\/Catalog'/, 'Catalog.jsx does not export LATER_WORDS');
  assert.match(dash, /if \(onSites\) onSites\(\[locationId\]\);/);
  assert.match(dash, /onSaved=\{\(\) => report\?\.reload\?\.\(\)\}/, 'a Targets save asks the dashboard again');
  assert.doesNotMatch(dash, /\.rpc\(|from\('/, 'the call goes through the reports api, never a raw rpc or table read');
  for (const f of ['StockDashboard.jsx', 'StockTargetsPanel.jsx', 'StockKeyItemTiles.jsx', 'StockSiteLeague.jsx']) {
    const text = src(f);
    assert.doesNotMatch(text, /[\u2013\u2014]/, `${f} has a long dash`);
    assert.doesNotMatch(text, /window\.confirm|Date\.now\(|new Date\(/, `${f} reads the device clock or uses window.confirm`);
  }
  const league = src('StockSiteLeague.jsx');
  assert.match(league, /LEAGUE_COLUMNS\.map/);
  const panel = src('StockTargetsPanel.jsx');
  assert.match(panel, /api\.saveTargets\(orgId, toSave\)/);
  assert.match(panel, /api\.saveKeyRatios\(orgId, \[keyRatioSaveRow\(d, \{ archive \}\)\]\)/);
  assert.match(panel, /const canEdit = level === 'all';/);
  assert.match(panel, /<SavedFirstModal /);
});

// Peter's review (21 Oct): a site whose days hold a demo check has its sales and GP left out by the
// database (null, demo_sales true), and the loyalty, staff and comps cost of days with no plate cost
// is not known (null): the cards and the league say so in words, never a zero or a GP.
test('demo sales and an unknown comps cost read as words on the cards and in the league', () => {
  const demo = Object.fromEntries(cardsOf({ currency: 'GBP', demo_sales: true, sales_net: null, gp_pct_actual: null, gp_pct_theo: null, gap_pct: null, gap_value: -12,
    comps_cost: null, purchases: 300, stock_value_now: 900, days_on_hand: 4, not_posted_count: 0, not_posted_value: 0 }).map((c) => [c.key, c]));
  for (const k of ['sales', 'gp', 'gap', 'comps']) assert.equal(demo[k].value, 'Not shown', k);
  assert.equal(demo.sales.sub, 'Demo sales in these days');
  assert.equal(demo.purchases.value, '£300');
  assert.equal(demo.stock.value, '£900');
  assert.equal(Object.keys(demo).length, 7);
  const unknown = Object.fromEntries(cardsOf({ ...company, comps_cost: null, comps_pct: null }).map((c) => [c.key, c]));
  assert.equal(unknown.comps.value, 'Not known');
  assert.equal(unknown.comps.sub, 'known once every sale has its plate cost');
  const col = (key) => LEAGUE_COLUMNS.find((c) => c.key === key);
  const row = { site: 'North Site', currency: 'GBP', demo_sales: true, sales_net: null, gp_pct_theo: null };
  assert.equal(leagueCell(row, col('sales_net')).text, 'Demo sales in these days');
  assert.equal(leagueCell(row, col('sales_net')).grey, true);
  assert.equal(leagueCell(row, col('gp_pct_theo')).text, '');
});

