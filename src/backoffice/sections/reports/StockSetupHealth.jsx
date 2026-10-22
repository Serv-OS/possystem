// src/backoffice/sections/reports/StockSetupHealth.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Setup health and recipe coverage. Per site:
// sales with no recipe (money and %), items with no supplier, supplier items with no allergens or
// ingredients, allergen checks waiting, archived items still holding stock, sites out of step (the
// nightly check mode writer found site rows that no longer match the company record) with Fix (the
// Drop 1 stock_resync_site, level all only), clocks that disagree. Recipes over target and recipes
// missing a cost come with the recipes update. Every figure is stock_report_setup_health's.

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { Btn, Pill, Notice } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { stockApi } from '../../../lib/stock/stockApi';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, whenAt, fixWords, fmtInt, initialSite, LATER_WORDS } from '../../../lib/stock/reportView.js';

const TITLE = 'Setup health and recipe coverage';
const SUB = 'What stops a number being right: sales with no recipe, items with no supplier, missing allergens, sites out of step, clocks that disagree.';

const TOTALS = [
  col('no_recipe_sales_net', 'Sales with no recipe', 'money'), col('no_recipe_pct', 'No recipe %', 'pct'),
  col('_over_target', 'Recipes over target', 'text'), col('_missing_cost', 'Recipes missing a cost', 'text'),
  col('items_no_supplier', 'Items with no supplier', 'int'), col('supplier_items_no_allergens', 'Supplier items, no allergens', 'int'),
  col('allergen_check_waiting', 'Allergen checks waiting', 'int'), col('archived_holding', 'Archived items holding stock', 'int'),
  col('out_of_step', 'Rows out of step', 'int'), col('_checked', 'Last checked', 'text'), col('_clock', 'Clock', 'text'),
];
const PRODUCT_COLS = [col('name', 'Product sold with no recipe'), col('sales_net', 'Sales', 'money')];
const LINE_COLS = [col('_line', 'What is out of step')];
const RAG = { no_recipe_pct: 'no_recipe_pct' };
const SORT_KEYS = {};
// The database says this in meta.notes; the screen prints it in its own place, so the rules line does not repeat it.
const OWN_LINE = 'Recipes over target and recipes with no cost come with the recipes update';

export default function StockSetupHealth({ orgId, sites, siteById, range, compare, layout, canFix, initialOpts, onExport, onShare, api }) {
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [sort, setSort] = useState(null);
  const [fixing, setFixing] = useState({});     // location_id -> 'busy' | 'done' | { error }

  const opts = { level: site ? 'detail' : 'site', site: site || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'setup_health', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'setup_health', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownTotals = (totals || []).map((t) => ({
    ...t,
    _over_target: t.recipes_over_target == null ? LATER_WORDS.recipes : fmtInt(t.recipes_over_target),
    _missing_cost: t.recipes_missing_cost == null ? LATER_WORDS.recipes : fmtInt(t.recipes_missing_cost),
    _checked: t.checked_at ? whenAt(meta, t.location_id, t.checked_at) : (t.location_id == null ? '' : 'Not yet'),
    _clock: t.clock_disagrees ? `Disagrees: ${t.clock_disagrees}` : (t.location_id == null ? '' : 'Agrees'),
  }));
  const outOfStep = shownTotals.filter((t) => t.location_id != null && Number(t.out_of_step) > 0);
  const clocks = shownTotals.filter((t) => t.location_id != null && t.clock_disagrees);
  const detail = withSites(rows, meta, siteById);
  const products = detail.filter((r) => r.menu_item_id != null);
  // The nightly check's plain lines for the drilled site (meta.health_lines, the first 50).
  const lines = healthLines(meta, site);
  const notes = notesOf(meta, [OWN_LINE]);

  const fix = async (locationId) => {
    setFixing((f) => ({ ...f, [locationId]: 'busy' }));
    const ans = await stockApi.resyncSite(locationId);
    setFixing((f) => ({ ...f, [locationId]: ans?.error ? { error: ans.error } : 'done' }));
  };

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>Recipes over target and recipes missing a cost: {LATER_WORDS.recipes.toLowerCase()}.</span>
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading the setup checks" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={shownTotals} columns={TOTALS} layout={layout} rag={RAG} onSite={(id) => { setSite(id); setSort(null); }} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />

          <div style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
            {outOfStep.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Sites out of step: none. Every site row matches its company record.</div>}
            {outOfStep.map((t) => {
              const st = fixing[t.location_id];
              return (
                <Notice key={t.location_id} tone="warn"
                  actions={[canFix && st !== 'done' && { label: st === 'busy' ? 'Fixing' : 'Fix', kind: 'primary', onClick: () => fix(t.location_id), disabled: st === 'busy' }]}>
                  <b>{nameOf(t.location_id)}</b> is out of step: {fmtInt(t.out_of_step)} row{Number(t.out_of_step) === 1 ? '' : 's'} no longer match the company record.
                  {st === 'done' && <Pill tone="good" style={{ marginLeft: 8 }}>{fixWords(nameOf(t.location_id))}</Pill>}
                  {st && typeof st === 'object' && st.error && <span style={{ color: 'var(--red)', marginLeft: 8 }}>{st.error?.message || String(st.error)}</span>}
                  {!canFix && <span style={{ color: 'var(--t3)', marginLeft: 8 }}>A company editor can fix it.</span>}
                </Notice>
              );
            })}
            {clocks.map((t) => (
              <Notice key={`clock:${t.location_id}`} tone="bad">
                <b>{nameOf(t.location_id)}</b>: clocks that disagree. {t.clock_disagrees}. Its day totals are rebuilt once the clock is agreed.
              </Notice>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
            <b style={{ fontSize: 14 }}>{site ? `Detail for ${nameOf(site)}` : 'Detail'}</b>
            {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
            {!site && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Click a site for the products sold with no recipe and the rows out of step.</span>}
          </div>
          {site && (
            <>
              {lines.length > 0 && <div style={{ marginBottom: 12 }}><DrillTable columns={LINE_COLS} rows={lines} next={null} /></div>}
              <DrillTable columns={PRODUCT_COLS} rows={sortLoaded(products, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
            </>
          )}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}

/** The site health lines of one site as rows for the table: plain words, never raw data. */
function healthLines(meta, siteId) {
  if (!siteId || !meta || !Array.isArray(meta.health_lines)) return [];
  const h = meta.health_lines.find((x) => x && String(x.location_id) === String(siteId));
  const list = h && Array.isArray(h.lines) ? h.lines : [];
  return list
    .map((l, i) => ({ id: `line:${i}`, _line: typeof l === 'string' ? l : (l && (l.words || l.line)) || '' }))
    .filter((l) => l._line);
}
