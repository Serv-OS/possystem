/**
 * reportColumns.test.js: Drop 4a (contract section 7, web-reports). Every Stock report component in
 * src/backoffice/sections/reports/ reads only keys its stock_report_* function answers (contract
 * 1.6.3), checked against a fixture of each answer, as source text (there is no React harness in the
 * repo). Also pins: one function per component through useStockReport, the two placeholders make no
 * call and say 'Comes with the recipes update', the props are the contract's, the words carry no long
 * dash, no window.confirm, the cap line and the export button are on every report.
 * Run: npm test, or node --test src/lib/stock/reportColumns.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS = resolve(here, '../../backoffice/sections/reports');
const read = (name) => readFileSync(resolve(REPORTS, name), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// What every totals row carries (contract 1.6.1): the site, its currency, and the report's columns.
const TOTAL_BASE = ['location_id', 'site', 'currency'];
// What the screen adds itself (reportView.withSites) and the meta it reads.
const SCREEN_ADDS = ['site', 'currency'];
const WINDOW_KEYS = ['location_id', 'from_day', 'to_day', 'opening_counted', 'closing_counted', 'window_missing', 'snapshot', 'part_locked', 'takes_from'];

/**
 * The fixture of each answer: the report function's totals columns and every drill level's row keys,
 * as supabase/migrations/20261026a_OPS_stock_native_4a.sql answers them (contract 1.6.3; where the
 * file says it differently, the file wins, and the last test below pins every fixture key to it).
 */
export const ANSWERS = {
  value: {
    totals: ['stock_value', 'negative_value', 'archived_holding_value', 'items', 'counted', 'at_day', 'snapshot', 'legal_company'],
    levels: {
      site: ['location_id', 'stock_value', 'negative_value', 'by_category', 'by_area', 'legal_company', 'at_day', 'snapshot', 'counted'],
      legal: ['legal_company', 'currency', 'stock_value', 'negative_value', 'archived_holding_value', 'sites'],
      category: ['location_id', 'category_id', 'name', 'value', 'items'],
      item: ['location_id', 'company_item_id', 'inventory_item_id', 'name', 'category', 'category_id', 'qty', 'unit', 'cost', 'value', 'archived'],
    },
    nested: { by_category: ['category_id', 'name', 'value'], by_area: ['area_id', 'name', 'value'] },
  },
  movement: {
    totals: ['opening_value', 'opening_counted', 'received', 'from_kitchen', 'transfers_in', 'made', 'sold_cost', 'used_in_batches', 'transfers_out', 'waste_value', 'revalue', 'count_adj', 'expected_closing', 'closing_value', 'closing_counted', 'gap'],
    levels: {
      item: ['location_id', 'company_item_id', 'inventory_item_id', 'name', 'unit', 'archived', 'opening_value', 'opening_qty', 'received', 'from_kitchen', 'transfers_in', 'made', 'sold_cost', 'sold_qty', 'used_in_batches', 'transfers_out', 'waste_value', 'revalue', 'count_adj', 'opening_balance', 'expected_closing', 'closing_value', 'closing_qty', 'gap', 'abs_gap'],
      movement: ['id', 'occurred_at', 'business_day', 'movement_type', 'source_type', 'source_id', 'qty_base', 'unit_cost', 'value_delta', 'notes', 'document'],
    },
    nested: { document: ['kind', 'ref', 'who'] },
  },
  gap: {
    totals: ['sales_net', 'gap_value', 'gap_pct', 'positive', 'negative', 'net', 'waste_value', 'unaccounted', 'surplus', 'counted_both_ends'],
    levels: {
      item: ['company_item_id', 'name', 'category', 'key_item', 'gap_value', 'gap_qty', 'unit', 'best_site', 'best_gap', 'worst_site', 'worst_gap', 'use_per_1000', 'counted_sites', 'not_counted_sites', 'not_counted'],
    },
  },
  cogs: {
    totals: ['sales_net', 'theo_cost', 'theo_pct', 'actual_cost', 'actual_pct', 'comps_cost', 'loyalty_cost', 'staff_cost', 'comp_cost', 'comps_qty', 'gp_before', 'gp_after', 'gp_pct_theo', 'gp_pct_actual', 'labour', 'labour_pct', 'flash_gp_pct', 'labour_has_data', 'rag'],
    levels: {
      week: ['location_id', 'week_start', 'sales_net', 'theo_cost', 'actual_cost', 'gp_pct_theo', 'gp_pct_actual', 'target_gp'],
      type: ['location_id', 'type', 'sales_net', 'theo_cost', 'gp_pct_theo'],
    },
  },
  product_gp: {
    totals: ['sales_net', 'theo_cost', 'gp', 'gp_pct', 'products', 'known_from'],
    levels: {
      product: ['menu_item_id', 'product_key', 'key', 'name', 'type', 'sold_qty', 'sales_net', 'theo_cost', 'gp', 'gp_pct', 'plate_cost_avg', 'plate_cost_low', 'plate_cost_low_site', 'plate_cost_high', 'plate_cost_high_site', 'popularity_share', 'class'],
      site_product: ['location_id', 'menu_item_id', 'product_key', 'key', 'name', 'type', 'sold_qty', 'sales_net', 'theo_cost', 'gp', 'gp_pct', 'plate_cost_avg', 'plate_cost_low', 'plate_cost_low_site', 'plate_cost_high', 'plate_cost_high_site', 'popularity_share', 'class'],
    },
    // menuEngineering.classifyProducts adds gp_per_unit to every row before the screen reads it.
    derived: ['gp_per_unit'],
  },
  waste: {
    totals: ['waste_value', 'waste_pct_sales', 'waste_pct_purchases', 'refund_waste', 'closedown_waste', 'events', 'sales_net', 'purchases', 'ledger_waste'],
    levels: {
      reason: ['location_id', 'key', 'name', 'reason', 'value', 'qty', 'events'],
      category: ['location_id', 'key', 'name', 'value', 'qty', 'events'],
      item: ['location_id', 'key', 'company_item_id', 'name', 'value', 'qty', 'unit', 'top_reason', 'events'],
      person: ['location_id', 'key', 'logged_by', 'name', 'value', 'qty', 'events'],
      day: ['location_id', 'key', 'day', 'name', 'value', 'qty', 'events'],
    },
  },
  purchases: {
    totals: ['ordered', 'received', 'invoiced', 'on_time_pct', 'short_pct', 'orders', 'sent_unapproved', 'substitutions'],
    levels: {
      supplier: ['location_id', 'key', 'supplier_name', 'name', 'ordered', 'received', 'invoiced', 'orders'],
      category: ['location_id', 'key', 'name', 'ordered', 'received', 'invoiced', 'orders'],
      week: ['location_id', 'key', 'name', 'week_start', 'ordered', 'received', 'invoiced', 'orders'],
      order: ['location_id', 'key', 'po_id', 'reference', 'supplier_name', 'status', 'ordered_at', 'expected_date', 'received_at', 'subtotal', 'tax', 'received', 'invoice_id', 'invoiced'],
    },
  },
  prices: {
    totals: ['items_priced', 'paid_over_agreed', 'spread_pct_avg'],
    levels: {
      item: ['company_item_id', 'key', 'name', 'supplier_name', 'agreed_price', 'paid_avg', 'paid_low', 'paid_low_site', 'paid_high', 'paid_high_site', 'spread_pct', 'over_agreed_sites'],
      change: ['id', 'at', 'location_id', 'company_item_id', 'name', 'source', 'old_price', 'new_price', 'pct', 'use_qty', 'cost_effect', 'who'],
      coming: ['id', 'at', 'location_id', 'company_item_id', 'name', 'source', 'old_price', 'new_price', 'pct', 'use_qty', 'cost_effect', 'who'],
    },
  },
  days_on_hand: {
    totals: ['stock_value_now', 'daily_use', 'days_on_hand', 'stock_turn', 'slow_value', 'rag'],
    levels: {
      category: ['location_id', 'key', 'category_id', 'name', 'stock_value_now', 'value', 'daily_use', 'days_on_hand', 'stock_turn', 'slow_value'],
      slow: ['location_id', 'company_item_id', 'inventory_item_id', 'name', 'qty', 'unit', 'value', 'last_use_day', 'idle_days', 'transfer_to'],
    },
    nested: { transfer_to: ['location_id', 'site', 'use_28d'] },
  },
  par: {
    totals: ['below_par', 'below_min', 'stock_outs', 'stock_out_items', 'over_par', 'negative'],
    levels: {
      below: ['location_id', 'company_item_id', 'inventory_item_id', 'name', 'on_hand', 'unit', 'par', 'min_level', 'short_by'],
      stockout: ['location_id', 'company_item_id', 'inventory_item_id', 'name', 'days_at_zero', 'first_day', 'last_day'],
      over: ['location_id', 'company_item_id', 'inventory_item_id', 'name', 'on_hand', 'unit', 'par', 'min_level', 'short_by'],
      negative: ['location_id', 'company_item_id', 'inventory_item_id', 'name', 'on_hand', 'unit', 'par', 'min_level', 'short_by'],
    },
  },
  key_ratios: {
    totals: ['ratio_id', 'name', 'used_qty', 'used_unit', 'sold_qty', 'per_sold', 'recipe_amount', 'diff_pct', 'rag'],
    levels: {
      week: ['location_id', 'week_start', 'ratio_id', 'name', 'used_qty', 'used_unit', 'sold_qty', 'per_sold', 'recipe_amount', 'diff_pct', 'rag'],
    },
  },
  setup_health: {
    totals: ['sales_net', 'no_recipe_sales_net', 'no_recipe_pct', 'recipes_over_target', 'recipes_missing_cost', 'items_no_supplier', 'supplier_items_no_allergens', 'allergen_check_waiting', 'archived_holding', 'out_of_step', 'checked_at', 'fix_job_id', 'clock_disagrees', 'rag'],
    levels: {
      detail: ['location_id', 'key', 'menu_item_id', 'name', 'sales_net'],
    },
  },
  batches: {
    totals: ['batches', 'planned_qty', 'actual_qty', 'yield_pct', 'made_value', 'used_value', 'variance_value', 'theoretical_cost', 'actual_cost'],
    levels: {
      recipe: ['location_id', 'output_item_id', 'output_name', 'batches', 'planned_qty', 'actual_qty', 'yield_pct', 'made_value', 'used_value'],
      batch: ['id', 'location_id', 'produced_at', 'output_name', 'planned_qty', 'actual_qty', 'output_unit', 'theoretical_cost', 'actual_cost', 'lot_code', 'produced_by_name'],
    },
  },
};

/**
 * v5.11.100 (Drop 4b, contract_4b sections 1 and 2): what supabase/migrations/20261030a_OPS_stock_native_4b.sql
 * adds. `adds` extends a 4a answer (the same function, replaced in 4b); the five new functions are whole
 * answers. The 4b pin test below checks every key against the 4b file.
 */
export const ANSWERS_4B = {
  value: { adds: { totals: ['in_transit', 'in_transit_count', 'total_value', 'internal_margin', 'company_value'], levels: { legal: ['in_transit', 'internal_margin'] } } },
  purchases: { adds: { totals: ['sent_unapproved_value', 'credit_notes', 'invoiced_after_credits', 'invoice_missing'], levels: { order: ['sent_unapproved', 'substitutions'] } } },
  prices: {
    adds: {
      totals: ['overcharge_asked', 'credits_received', 'written_off', 'credit_requests'],
      levels: {
        credits: ['request_id', 'location_id', 'supplier_name', 'reason', 'status', 'amount', 'received', 'created_at', 'invoice_number'],
        credit_suppliers: ['supplier_name', 'location_id', 'asked', 'received', 'written_off', 'requests'],
      },
    },
  },
  off_contract: {
    totals: ['spend', 'off_contract', 'off_pct', 'not_contract', 'local', 'over_agreed', 'over_agreed_lines', 'lines', 'invoices'],
    levels: {
      supplier: ['location_id', 'supplier_name', 'spend', 'off_contract', 'not_contract', 'local', 'over_agreed'],
      item: ['company_item_id', 'inventory_item_id', 'location_id', 'name', 'spend', 'off_contract', 'over_agreed', 'why'],
      line: ['line_id', 'invoice_id', 'invoice_number', 'invoice_date', 'location_id', 'supplier_name', 'name', 'qty', 'unit_price', 'agreed_price', 'line_total', 'why', 'over_by'],
      week: ['location_id', 'week_start', 'spend', 'off_contract', 'off_pct'],
    },
  },
  budget: {
    totals: ['budget', 'spent', 'pct_used', 'left', 'over', 'forecast', 'sales_net', 'spent_pct_sales', 'rule', 'rag'],
    levels: { week: ['location_id', 'week_start', 'days', 'budget', 'spent', 'pct_used', 'left', 'over', 'forecast', 'sales_net'] },
  },
  transfers: {
    totals: ['sent_out', 'received_in', 'in_transit', 'in_transit_count', 'short', 'short_lines', 'disputed', 'requests_open', 'transfers'],
    levels: {
      grid: ['from_location_id', 'to_location_id', 'from_site', 'to_site', 'value', 'sent_value', 'transfers'],
      list: ['id', 'reference', 'kind', 'status', 'words', 'from_location_id', 'to_location_id', 'from_site', 'to_site', 'sent_at', 'received_at', 'value', 'short_value', 'lines'],
      kitchen: ['kitchen_location_id', 'kitchen', 'location_id', 'site', 'orders', 'ordered_qty', 'sent_qty', 'fill_rate', 'short_lines', 'on_time_pct',
        'internal_sales', 'kitchen_cost', 'margin', 'made_value', 'planned_qty', 'kitchen_stock_value', 'kitchen_waste'],
      recharges: ['from_tenant', 'to_tenant', 'from_legal', 'to_legal', 'amount', 'transfers'],
    },
  },
  count_compliance: {
    totals: ['due', 'on_time', 'late', 'missed', 'waiting', 'last_full', 'last_full_words', 'counts', 'lines_counted', 'lines_estimated', 'counted_pct',
      'minutes_avg', 'variance_value', 'second_approvals'],
    levels: {
      calendar: ['location_id', 'day', 'plan_id', 'plan_name', 'status', 'count_id'],
      count: ['count_id', 'location_id', 'name', 'count_type', 'started_at', 'submitted_at', 'approved_at', 'approved_by_name', 'minutes', 'lines', 'counted',
        'estimated', 'variance_value', 'second_approved_by_name', 'plan_name'],
    },
  },
  month_end: {
    totals: ['locked', 'locked_at', 'opening_value', 'closing_value', 'movement', 'purchases', 'transfers_in', 'transfers_out', 'waste_value', 'recharges_in',
      'recharges_out', 'grni', 'credits_outstanding', 'in_transit', 'legal_company', 'tenant_id'],
    levels: {
      legal: ['tenant_id', 'legal_company', 'currency', 'sites', 'locked_all', 'opening_value', 'closing_value', 'internal_margin', 'movement', 'purchases',
        'waste_value', 'grni', 'credits_outstanding', 'recharges_in', 'recharges_out', 'journal'],
      category: ['location_id', 'category_id', 'name', 'closing_value'],
      // 5.11.100 review: the By legal company tab reads stock_month_end_journal's legal rows (every site of
      // each legal company): the month end legal row plus the journal's own keys
      journal: ['status', 'amount', 'words', 'narration', 'location_ids', 'connection_location_id', 'scopes_ok', 'missing_lock', 'already'],
    },
  },
};

/** The answer a screen reads: the 4a fixture with the 4b additions, or a 4b answer whole. */
const answerOf = (fn) => {
  const a = ANSWERS[fn];
  const b = ANSWERS_4B[fn];
  if (!a) return b;
  if (!b?.adds) return a;
  const levels = { ...a.levels };
  for (const [lv, keys] of Object.entries(b.adds.levels || {})) levels[lv] = [...(levels[lv] || []), ...keys];
  return { ...a, totals: [...a.totals, ...(b.adds.totals || [])], levels };
};

/** Component file to the function it calls (contract 3.4). */
const COMPONENTS = {
  'StockValue.jsx': 'value',
  'StockMovement.jsx': 'movement',
  'StockGap.jsx': 'gap',
  'StockCogs.jsx': 'cogs',
  'StockProductGP.jsx': 'product_gp',
  'StockWaste.jsx': 'waste',
  'StockPurchases.jsx': 'purchases',
  'StockPrices.jsx': 'prices',
  'StockDaysOnHand.jsx': 'days_on_hand',
  'StockPar.jsx': 'par',
  'StockKeyRatios.jsx': 'key_ratios',
  'StockSetupHealth.jsx': 'setup_health',
  'StockBatches.jsx': 'batches',
  // v5.11.100 (Drop 4b)
  'StockOffContract.jsx': 'off_contract',
  'StockBudget.jsx': 'budget',
  'StockTransfersReport.jsx': 'transfers',
  'StockCountCompliance.jsx': 'count_compliance',
  'StockMonthEnd.jsx': 'month_end',
};
const PLACEHOLDERS = ['StockRecipeCost.jsx', 'StockAllergens.jsx'];
// Contract 3.4's props plus initialOpts, the options a share link or a drill hands the screen (the
// web-shell's stockProps carries it: a league click's site, a link's at day, tab and level).
const PROPS = ['orgId', 'sites', 'siteById', 'range', 'compare', 'layout', 'level', 'canFix', 'initialOpts', 'onOpenReport', 'onExport', 'onShare', 'api'];

const union = (answer) => {
  const all = new Set([...TOTAL_BASE, ...SCREEN_ADDS, ...answer.totals, ...(answer.derived || [])]);
  for (const keys of Object.values(answer.levels)) for (const k of keys) all.add(k);
  for (const keys of Object.values(answer.nested || {})) for (const k of keys) all.add(k);
  return all;
};

/** Every key a component reads: col('key') specs and row.key reads on the row variables the screens use. */
const keysRead = (src) => {
  const out = new Set();
  for (const m of code(src).matchAll(/\bcol\('([^']+)'/g)) out.add(m[1]);
  for (const m of code(src).matchAll(/\b(?:r|t|row|then|w)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) out.add(m[1]);
  return out;
};
const isScreenKey = (k) => k.startsWith('_') || k.startsWith('cat:') || k.startsWith('site:');

test('the fixture names every 4a report function once and the totals carry no long dashes', () => {
  assert.deepEqual(Object.keys(ANSWERS).sort(), ['batches', 'cogs', 'days_on_hand', 'gap', 'key_ratios', 'movement', 'par', 'prices', 'product_gp', 'purchases', 'setup_health', 'value', 'waste']);
  assert.deepEqual(new Set(Object.values(COMPONENTS)), new Set([...Object.keys(ANSWERS), ...Object.keys(ANSWERS_4B)]));
  for (const [fn, a] of Object.entries(ANSWERS)) {
    assert.ok(a.totals.length > 0, fn);
    assert.ok(Object.keys(a.levels).length > 0, fn);
    for (const k of [...a.totals, ...Object.values(a.levels).flat()]) assert.match(k, /^[a-z][a-z0-9_]*$/, `${fn}: ${k}`);
  }
});

for (const [file, fn] of Object.entries(COMPONENTS)) {
  test(`${file} reads only keys stock_report_${fn} answers`, () => {
    const src = read(file);
    const allowed = union(answerOf(fn));
    const windowKeys = new Set(WINDOW_KEYS);
    const bad = [];
    for (const k of keysRead(src)) {
      if (isScreenKey(k)) continue;
      if (allowed.has(k) || windowKeys.has(k)) continue;
      bad.push(k);
    }
    assert.deepEqual(bad, [], `${file} reads keys the function does not answer: ${bad.join(', ')}`);
  });

  test(`${file} calls exactly one function, stock_report_${fn}, through useStockReport`, () => {
    const src = code(read(file));
    const calls = [...src.matchAll(/useStockReport\(api, '([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(calls, [fn]);
    assert.match(src, /\{ StockReportFrame[^}]*useStockReport[^}]*\} from '\.\/_stockKit'/, 'the kit import');
    assert.match(src, new RegExp(`useExportFlow\\(\\{ api, report: '${fn}'`), 'the export flow names the same function');
    assert.match(src, /onExport=\{ex\.run\} exportLabel=\{ex\.atOnce \? 'Export CSV' : 'Export all rows as a file'\}/, 'the one export button, in the frame, runs the screen own export');
    assert.doesNotMatch(src, /<ExportBtn/, 'no second export button inside the screen (one Export a screen, the mockup)');
    assert.match(src, /capped=\{(grid \? false : )?capped\}/, 'the 1,000 row cap line (the kit prints it)');
    assert.match(src, /\{ex\.panel\}/, 'the export status panel renders');
    assert.match(src, /\{error && <StockError error=\{error\} \/>\}/, 'a missing function says NEEDS_UPDATE, never a zero');
    assert.match(src, /loading && !totals && !error && <StockLoading words=/, 'words while reading, never a figure before the answer');
    if (/<SiteTotalsTable/.test(src)) assert.match(src, /then=\{then\?\.totals \|\| null\} thenLoaded=\{thenLoaded\} compare=\{compare\}/, 'the compare delta beside each total');
    assert.match(src, /extraLines=\{notes\}/, 'meta.notes reach the rules line');
  });

  test(`${file} takes only the contract props and the component name matches the file`, () => {
    const src = read(file);
    const name = file.replace('.jsx', '');
    const m = /export default function (\w+)\(\{ ([^}]+) \}\)/.exec(src);
    assert.ok(m, 'one default export with destructured props');
    assert.equal(m[1], name);
    const props = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of props) assert.ok(PROPS.includes(p), `${file}: prop ${p} is not in contract 3.4`);
    for (const p of ['orgId', 'sites', 'siteById', 'range', 'compare', 'layout', 'onExport', 'onShare', 'api']) assert.ok(props.includes(p), `${file}: ${p}`);
  });
}

for (const file of PLACEHOLDERS) {
  test(`${file} makes no call and says Comes with the recipes update`, () => {
    const src = code(read(file));
    assert.doesNotMatch(src, /useStockReport|stock_report_|api\./);
    assert.match(src, /<LaterTile words=\{LATER_WORDS\.recipes\} \/>/);
    assert.match(src, /export default function Stock(RecipeCost|Allergens)\(\{ onShare \}\)/);
  });
}

test('every component and the export panel: plain words, no long dash, no window.confirm, no N/A', () => {
  for (const file of [...Object.keys(COMPONENTS), ...PLACEHOLDERS, 'ExportStatus.jsx']) {
    const src = read(file);
    assert.doesNotMatch(src, /[\u2013\u2014]/, `${file}: no long dashes`);
    assert.doesNotMatch(src, /window\.confirm/, `${file}: never window.confirm`);
    assert.doesNotMatch(src, /\bN\/A\b/, `${file}: never N/A`);
    assert.doesNotMatch(src, /\.(getHours|getDay|getDate|getMonth|getFullYear|setHours|setDate)\(/, `${file}: never the device clock`);
  }
});

test('the lines the contract names are on the screens that show them', () => {
  assert.match(read('StockCogs.jsx'), /'No labour data'/);
  assert.match(read('StockCogs.jsx'), /Loyalty, staff and comps/);
  assert.match(read('StockProductGP.jsx'), /Plate cost not known before/);
  assert.match(read('StockProductGP.jsx'), /classifyProducts|engineeringSummary/);
  // v5.11.100 (Drop 4b): the purchasing update is here, so no screen says it is coming
  for (const f of ['StockPurchases.jsx', 'StockPrices.jsx', 'StockValue.jsx']) assert.doesNotMatch(read(f), /purchasing update/, f);
  assert.match(read('StockPurchases.jsx'), /col\('sent_unapproved', 'Sent unapproved'/);
  assert.match(read('StockPurchases.jsx'), /col\('substitutions', 'Substitutions'/);
  assert.match(read('StockPrices.jsx'), /level: tab/);
  assert.match(read('StockPrices.jsx'), /id: 'credits', label: 'Credits'/);
  assert.match(read('StockValue.jsx'), /col\('in_transit', 'In transit'/);
  assert.match(read('StockValue.jsx'), /Internal kitchen margin taken out/);
  const me = read('StockMonthEnd.jsx');
  assert.match(me, /monthEndJournal\('preview'/);
  assert.match(me, /monthEndJournal\('send'/);
  assert.match(me, /Reconnect Xero to allow stock journals\./);
  assert.match(me, /Lock the month at every site first\./);
  assert.match(me, /await confirm\(/, 'Send asks first (ConfirmDialog), never by itself');
  // the only effect reads the legal companies from the database (stock_month_end_journal); Xero is read
  // (preview) and written (send) only on a press
  const effects = [...code(me).matchAll(/useEffect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\)/g)].map((m) => m[0]);
  assert.equal(effects.length, 1, 'one effect: the legal companies of the month');
  assert.match(effects[0], /api\.monthEndLegal\(/);
  assert.doesNotMatch(effects[0], /monthEndJournal\(/, 'nothing is sent or read from Xero on its own: only a press');
  assert.match(read('StockCountCompliance.jsx'), /CountCalendar/);
  assert.match(read('StockWaste.jsx'), /Refunded food/);
  assert.match(read('StockWaste.jsx'), /End of day close down/);
  assert.match(read('StockDaysOnHand.jsx'), /transferWords/);
  assert.match(read('StockMovement.jsx'), /col\('opening_value'/);
  assert.match(read('StockMovement.jsx'), /col\('closing_value'/);
  assert.match(read('StockValue.jsx'), /col\('stock_value'/);
  assert.match(read('StockValue.jsx'), /Negative stock/);
  assert.match(read('StockValue.jsx'), /Archived items still holding stock/);
  assert.match(read('StockValue.jsx'), /By area is today only\./);
  assert.match(read('StockSetupHealth.jsx'), /stockApi\.resyncSite\(locationId\)/);
  assert.match(read('StockSetupHealth.jsx'), /canFix/);
  assert.match(read('StockSetupHealth.jsx'), /LATER_WORDS\.recipes/);
  assert.match(read('StockPar.jsx'), /Stock outs cover up to \{STOCKOUT_DAYS\} days/);
  assert.match(read('StockKeyRatios.jsx'), /Choose your key items in Targets/);
  assert.match(read('StockGap.jsx'), /key_items_only/);
  const ex = read('ExportStatus.jsx');
  assert.match(ex, /Files are kept for 7 days/);
  assert.match(ex, /Building your file: /);
  assert.match(ex, /Ready: /);
  assert.match(ex, /downloadExport\(url, exportFileName\(/, 'the download goes through exportDownload.js with the session JWT');
  assert.match(ex, /exportCsvNow\(report, meta, totals \|\| \[\], rows \|\| \[\]\)/, 'under 1,000 rows the CSV is built at once');
  assert.match(ex, /api\.exportStart\(report, \{ org: args\.orgId, sites: args\.sites, from: args\.from, to: args\.to, opts: args\.opts \|\| \{\} \}\)/, 'the job stores the exact call');
});

// ── The fixture is the migration's answer, and the screens use it the way it is answered ──────────

const MIGRATION = resolve(here, '../../../supabase/migrations/20261026a_OPS_stock_native_4a.sql');
const fnBodies = (sql) => {
  const out = {};
  for (const part of sql.split(/(?=create or replace function public\.)/)) {
    const m = /^create or replace function public\.(\w+)/.exec(part);
    if (m) out[m[1]] = part;
  }
  return out;
};
const jsonKeys = (body) => new Set([...body.matchAll(/'([a-z_][a-z0-9_]*)'\s*[,)]/g)].map((m) => m[1]));
// The shared helpers every report builds its rows with (site figures, derived percents, totals, meta).
const SHARED = ['stock_rp__site_figures', 'stock_rp__derive', 'stock_rp__totals', 'stock_rp__sum_rows', 'stock_rp__cogs_rows', 'stock_rp__meta', 'stock_report_guard'];

test('every fixture key is a key the migration answers (the fixture follows the file, not a guess)', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const fns = fnBodies(sql);
  const shared = new Set();
  for (const n of SHARED) { assert.ok(fns[n], `${n} is in the migration`); for (const k of jsonKeys(fns[n])) shared.add(k); }
  for (const [fn, a] of Object.entries(ANSWERS)) {
    const body = fns[`stock_report_${fn}`];
    assert.ok(body, `stock_report_${fn} is in the migration`);
    const keys = jsonKeys(body);
    const missing = [...a.totals, ...Object.values(a.levels).flat(), ...Object.values(a.nested || {}).flat()]
      .filter((k) => !keys.has(k) && !shared.has(k));
    assert.deepEqual(missing, [], `stock_report_${fn} never answers: ${missing.join(', ')}`);
    for (const level of Object.keys(a.levels)) {
      if (level === 'legal') continue;  // a view of the site level, not a p_opts.level
      assert.match(body, new RegExp(`'${level}'`), `stock_report_${fn} knows the level ${level}`);
    }
  }
  assert.match(fns.stock_report_setup_health, /'health_lines'/, 'the site health lines come in meta.health_lines');
  assert.match(fns.stock_report_movement, /'waste_value', pg\.waste/, 'movement answers waste_value (the contract table said waste)');
});

const MIGRATION_4B = resolve(here, '../../../supabase/migrations/20261030a_OPS_stock_native_4b.sql');
test('every Drop 4b fixture key is a key the 4b migration answers', { skip: !existsSync(MIGRATION_4B) && 'the 4b migration is not written yet' }, () => {
  const sql = readFileSync(MIGRATION_4B, 'utf8');
  const fns = { ...fnBodies(readFileSync(MIGRATION, 'utf8')), ...fnBodies(sql) };
  const shared = new Set();
  for (const n of SHARED) if (fns[n]) for (const k of jsonKeys(fns[n])) shared.add(k);
  // the 4b helpers (stock_rp__*) the new reports build their rows with
  for (const [n, body] of Object.entries(fnBodies(sql))) if (n.startsWith('stock_rp__')) for (const k of jsonKeys(body)) shared.add(k);
  // the journal's legal rows (the Month end By legal company tab reads them)
  if (fnBodies(sql).stock_month_end_journal) for (const k of jsonKeys(fnBodies(sql).stock_month_end_journal)) shared.add(k);
  for (const [fn, b] of Object.entries(ANSWERS_4B)) {
    const body = fnBodies(sql)[`stock_report_${fn}`];
    assert.ok(body, `stock_report_${fn} is in the 4b migration`);
    const a = b.adds || b;
    const keys = jsonKeys(body);
    const missing = [...a.totals || [], ...Object.values(a.levels || {}).flat()].filter((k) => !keys.has(k) && !shared.has(k));
    assert.deepEqual(missing, [], `stock_report_${fn} (4b) never answers: ${missing.join(', ')}`);
    for (const level of Object.keys(a.levels || {})) {
      if (fn === 'value' && level === 'legal') continue;
      if (fn === 'month_end' && level === 'journal') continue;
      assert.match(body, new RegExp(`'${level}'`), `stock_report_${fn} knows the level ${level}`);
    }
  }
});

test('a header click sorts the rows on screen: no report function takes a sort, so none is sent', () => {
  for (const file of Object.keys(COMPONENTS)) {
    const src = code(read(file));
    assert.doesNotMatch(src, /sortOpts|\bsort: sort|\bdir: sort/, `${file}: the sort never goes to the database`);
    for (const m of src.matchAll(/<DrillTable[^\n]*onSort=/g)) {
      assert.match(m[0], /rows=\{sortLoaded\(/, `${file}: a sortable table sorts its loaded rows`);
    }
  }
});

test('a share link keeps the screen own options; a link or a drill opens the screen where it points', () => {
  for (const file of Object.keys(COMPONENTS)) {
    const src = code(read(file));
    assert.match(src, /const share = \(\) => onShare\?\.\(/, `${file}: Share hands the shell this screen's options`);
    assert.match(src, /onShare=\{onShare \? share : undefined\}/, `${file}: the frame's Share button is the screen's share`);
    assert.match(src, /initialOpts/, `${file}: takes the options a link or a drill hands it`);
    assert.match(src, /initialPick\(initialOpts|initialSite\(initialOpts/, `${file}: reads them only inside what the screen allows`);
  }
  assert.match(code(read('StockValue.jsx')), /initialPick\(initialOpts, 'at'/, 'See the report opens Stock value at the day it names');
});

test('a cell that names a site by name or id says the name, never a cut id', () => {
  for (const [file, keys] of Object.entries({
    'StockGap.jsx': ['best_site', 'worst_site'],
    'StockProductGP.jsx': ['plate_cost_low_site', 'plate_cost_high_site'],
    'StockPrices.jsx': ['paid_low_site', 'paid_high_site'],
  })) {
    const src = code(read(file));
    for (const k of keys) {
      assert.match(src, new RegExp(`siteLabel\\(meta, siteById, r\\.${k}\\)`), `${file}: ${k}`);
      assert.doesNotMatch(src, new RegExp(`nameOf\\(r\\.${k}\\)`), `${file}: ${k} is never read as an id only`);
    }
  }
});

test('the screens read the shapes the migration answers', () => {
  const setup = code(read('StockSetupHealth.jsx'));
  assert.match(setup, /meta\.health_lines/, 'the out of step lines are meta.health_lines');
  const value = code(read('StockValue.jsx'));
  assert.match(value, /'by_area'/, 'By area reads the site rows by_area');
  assert.match(value, /LEGAL_COLS/, 'By legal company reads one row per legal company');
  assert.match(code(read('StockMovement.jsx')), /col\('waste_value', 'Wasted', 'money'\)/);
  assert.match(code(read('StockWaste.jsx')), /r\.day \|\|/, 'the day level reads day');
  assert.match(code(read('StockDaysOnHand.jsx')), /transferWords\(r\.transfer_to, nameOf, \(v, t\) => money\(v,/, 'use in 28 days is money in that site currency');
  assert.match(code(read('StockPrices.jsx')), /unitMoney\(r\.paid_avg/, 'a price per base unit keeps its small places');
  for (const file of ['StockCogs.jsx', 'StockPurchases.jsx', 'StockKeyRatios.jsx']) {
    assert.match(code(read(file)), /sortLoaded\([^)]*\{ key: 'week_start', dir: 'asc' \}\)/, `${file}: the weekly trend runs oldest week first`);
  }
});

// Peter's review (21 Oct): a screen showed two Share buttons and up to three Export buttons, and the
// shell's own Share and 'Export all rows' read the options the report opened with, not the ones on
// screen. One Export and one Share a screen, both the report's (the frame's), as the mockup has.
test('one Export and one Share a stock screen: the frame holds them, the shell header holds neither', () => {
  const shell = code(readFileSync(resolve(here, '../../backoffice/sections/BOReports.jsx'), 'utf8'));
  assert.doesNotMatch(shell, />Export all rows</, 'the shell header has no Export all rows button');
  assert.doesNotMatch(shell, />Share</, 'the shell header has no Share button');
  assert.doesNotMatch(shell, /onClick=\{\(\) => shareLink\(\)\}/, 'nothing calls the share link without the screen options');
  assert.match(shell, /onShare: shareLink/, 'the screens still reach the share link through onShare');
  const kit = code(read('_stockKit.jsx'));
  assert.equal((kit.match(/<ExportBtn /g) || []).length, 1, 'the frame draws one Export');
  assert.equal((kit.match(/>Share</g) || []).length, 1, 'the frame draws one Share');
  for (const file of [...Object.keys(COMPONENTS), 'StockDashboard.jsx']) {
    const src = code(read(file));
    assert.doesNotMatch(src, /<ExportBtn|>Share</, `${file}: no Export or Share of its own beside the frame's`);
    assert.equal((src.match(/<StockReportFrame /g) || []).length, 1, `${file}: one frame`);
  }
});

