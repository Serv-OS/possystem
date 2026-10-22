// src/backoffice/sections/reports/StockCogs.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Cost of sales and GP. Per site: net sales,
// theoretical cost, actual cost (needs counts), GP both ways; the Loyalty, staff and comps line with
// GP before and after it (their cost sits in theoretical cost already, so it is shown apart, never
// taken off twice); food, drink, other; the weekly trend against the target; Flash GP with labour
// where Workforce clocks exist ('No labour data' per site otherwise). Every figure is
// stock_report_cogs's, from the stored day totals.

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Segmented, EmptyLine } from '../stock/stockUi';
import { BarRow } from './_charts';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, overrideValue, groupRows, weekWords, fmtPct, initialPick } from '../../../lib/stock/reportView.js';

const TITLE = 'Cost of sales and GP';
const SUB = 'Theoretical cost from the recipes at the cost on the day; actual cost from opening stock, purchases and transfers to closing stock. Loyalty, staff and comps on their own line.';

const GP_COLS = [
  col('sales_net', 'Sales', 'money'), col('theo_cost', 'Theoretical cost', 'money'), col('theo_pct', 'Theo %', 'pct'),
  col('actual_cost', 'Actual cost', 'money', { hint: 'needs counts' }), col('actual_pct', 'Actual %', 'pct'),
  col('gp_pct_theo', 'GP % theo', 'pct'), col('gp_pct_actual', 'GP % actual', 'pct'),
  col('labour', 'Labour', 'money'), col('_labour_pct', 'Labour %', 'text'), col('flash_gp_pct', 'Flash GP %', 'pct', { hint: 'GP actual less labour' }),
];
const COMPS_COLS = [
  col('sales_net', 'Sales', 'money'), col('comps_cost', 'Loyalty, staff and comps', 'money'), col('loyalty_cost', 'Loyalty', 'money'),
  col('staff_cost', 'Staff', 'money'), col('comp_cost', 'Comps', 'money'), col('comps_qty', 'Items', 'qty'),
  col('gp_before', 'GP before', 'money'), col('gp_after', 'GP after', 'money'), col('gp_pct_theo', 'GP % theo', 'pct'),
];
const TYPE_COLS = [col('site', 'Site'), col('_type', 'Type'), col('sales_net', 'Sales', 'money'), col('theo_cost', 'Theoretical cost', 'money'), col('gp_pct_theo', 'GP % theo', 'pct'), col('_actual', 'GP % actual', 'text')];
const WEEK_COLS = [
  col('site', 'Site'), col('_week', 'Week', 'text'), col('sales_net', 'Sales', 'money'), col('theo_cost', 'Theoretical cost', 'money'),
  col('actual_cost', 'Actual cost', 'money'), col('gp_pct_theo', 'GP % theo', 'pct'), col('gp_pct_actual', 'GP % actual', 'pct'), col('target_gp', 'Target GP %', 'pct'),
];
const TABS = [{ id: 'site', label: 'By site' }, { id: 'comps', label: 'Loyalty, staff and comps' }, { id: 'type', label: 'Food, drink, other' }, { id: 'week', label: 'Weekly trend' }];
const MODES = [{ value: false, label: 'The period days' }, { value: true, label: 'Between two counts' }];
const RAG = { gp_pct_theo: 'gp_pct', gp_pct_actual: 'gp_pct' };
const TYPE_WORDS = { food: 'Food', drink: 'Drink', other: 'Other' };
const SORT_KEYS = { _week: 'week_start', _type: 'type' };
const LEVEL_OF_TAB = { site: 'site', comps: 'site', type: 'type', week: 'week' };

export default function StockCogs({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const rangeKey = `${range.fromDay}:${range.toDay}:${range.betweenCounts ? 1 : 0}`;
  const [modePick, setModePick] = useState(() => {
    const b = initialPick(initialOpts, 'between_counts', [true, false], null);
    return b == null ? null : { key: rangeKey, value: b };
  });
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'tab', Object.keys(LEVEL_OF_TAB), initialPick(initialOpts, 'level', ['site', 'week', 'type'], 'site')));
  const [sort, setSort] = useState(null);

  const between = overrideValue(modePick, rangeKey, !!range.betweenCounts);
  const level = LEVEL_OF_TAB[tab] || 'site';
  const opts = { between_counts: between, level };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'cogs', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'cogs', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.({ ...opts, tab });

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownTotals = (totals || []).map((t) => ({ ...t, _labour_pct: t.labour_pct == null ? (t.location_id == null ? '' : 'No labour data') : fmtPct(t.labour_pct) }));
  const shownRows = withSites(rows, meta, siteById).map((r) => ({
    ...r,
    _type: TYPE_WORDS[r.type] || r.type || '',
    _actual: 'Comes with counts by type',
    _week: weekWords(r.week_start),
  }));
  const notes = notesOf(meta);
  // The trend reads each site's weeks oldest first, whatever order the table is sorted in.
  const weekGroups = level === 'week' ? groupRows(sortLoaded(shownRows, { key: 'week_start', dir: 'asc' }), 'location_id') : [];

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <Segmented small value={between} options={MODES} onChange={(v) => { setModePick({ key: rangeKey, value: v }); setSort(null); }} />
        <span style={{ fontSize: 12, color: 'var(--t4)' }}>Actual cost needs an opening and a closing count; between two counts uses each site's own.</span>
      </div>
      <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading the sales and stock day totals" />}

      {totals && (
        <>
          {tab === 'comps' ? (
            <>
              <div style={{ fontSize: 12.5, color: 'var(--t3)', margin: '0 2px 8px' }}>
                Free loyalty drinks, staff drinks and comps still take stock off but bring in little or no sales. Their cost is shown here on its own line: GP before it, and GP after it.
              </div>
              <SiteTotalsTable meta={meta} totals={shownTotals} columns={COMPS_COLS} layout={layout} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
            </>
          ) : (
            <SiteTotalsTable meta={meta} totals={shownTotals} columns={GP_COLS} layout={layout} rag={RAG} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          )}

          {tab === 'type' && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, margin: '0 2px 8px' }}>Food, drink, other <span style={{ fontWeight: 400, color: 'var(--t4)', fontSize: 12 }}>from each product's sales category; actual cost by type comes with counts by type</span></div>
              <DrillTable columns={TYPE_COLS} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
            </div>
          )}
          {tab === 'week' && (
            <div style={{ marginTop: 14, display: 'grid', gap: 14 }}>
              {weekGroups.length === 0 && <EmptyLine>No weeks with sales in this period.</EmptyLine>}
              {weekGroups.map((g) => {
                const target = g.rows.find((r) => r.target_gp != null)?.target_gp;
                return (
                  <div key={g.key} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 16 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 10 }}>
                      <b style={{ fontSize: 13 }}>{nameOf(g.key)}</b>
                      <span style={{ fontSize: 12, color: 'var(--t4)' }}>GP % actual by week from the ledger{target != null ? `, target ${fmtPct(target)}` : ''}</span>
                    </div>
                    {g.rows.map((r) => {
                      const v = r.gp_pct_actual ?? r.gp_pct_theo;
                      const under = target != null && v != null && v < target;
                      return (
                        <BarRow key={r.week_start} label={r._week} value={v == null ? 0 : v} max={100} format={() => (v == null ? 'No sales' : fmtPct(v))}
                          color={v == null ? 'var(--bdr2)' : under ? 'var(--amber, #F5A623)' : 'var(--grn, #16a34a)'} />
                      );
                    })}
                  </div>
                );
              })}
              <DrillTable columns={WEEK_COLS} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
            </div>
          )}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
