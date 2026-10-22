// src/backoffice/sections/reports/StockGap.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Theoretical against actual, the gap. Per
// site: gap value, % of sales, positive, negative, net, and the split into logged waste, unaccounted
// and surplus. 'Top items across all sites' by gap value with the best and worst site and use per
// 1,000 of sales. Filters: category (on the loaded rows), key items only (the database). Between two
// counts compares each site's latest two full approved counts; an item not counted at both ends at a
// site is marked. Every figure is stock_report_gap's (count adjustments in the ledger day totals).

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { Btn, Segmented, Switch } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, siteLabel, crumbsFor, toggleSort, sortLoaded, notesOf, overrideValue, fmtInt, initialPick, initialSite } from '../../../lib/stock/reportView.js';

const TITLE = 'Theoretical against actual';
const SUB = 'The gap per site: what the recipes say was used against what the counts found. Negative = stock missing. Split into logged waste, unaccounted and surplus.';

const TOTALS = [
  col('sales_net', 'Sales', 'money'), col('gap_value', 'Gap', 'money', { hint: 'negative = missing' }), col('gap_pct', 'Gap % of sales', 'pct'),
  col('positive', 'Positive', 'money'), col('negative', 'Negative', 'money'), col('net', 'Net', 'money'),
  col('waste_value', 'Logged waste', 'money'), col('unaccounted', 'Unaccounted', 'money'), col('surplus', 'Surplus', 'money'),
  col('_counted', 'Counts', 'text', { hint: 'both ends counted' }),
];
const ITEM_COLS = [
  col('name', 'Item'), col('category', 'Category'), col('gap_value', 'Gap', 'money'), col('_qty', 'Gap quantity', 'qty'),
  col('_best', 'Best site'), col('best_gap', 'Best gap', 'money'), col('_worst', 'Worst site'), col('worst_gap', 'Worst gap', 'money'),
  col('use_per_1000', 'Use per 1,000 of sales', 'qty'), col('_counted_at', 'Counted at', 'text'), col('_not_counted', 'Not counted', 'text'),
];
const MODES = [{ value: true, label: 'Between two counts' }, { value: false, label: 'The period days' }];
const RAG = { gap_pct: 'gap_pct', waste_value: 'waste_pct' };
const SORT_KEYS = { _qty: 'gap_qty', _best: 'best_site', _worst: 'worst_site', _counted_at: 'counted_sites', _not_counted: 'not_counted_sites' };

const sitesWords = (v, nameOf) => {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.site || nameOf(x.location_id) : nameOf(x))).join(', ');
  // A count of sites (stock_report_gap answers how many sites counted the item at both ends).
  if (v == null) return '';
  return fmtInt(v);
};

export default function StockGap({ orgId, sites, siteById, range, compare, layout, initialOpts, onOpenReport, onExport, onShare, api }) {
  const rangeKey = `${range.fromDay}:${range.toDay}:${range.betweenCounts ? 1 : 0}`;
  const [modePick, setModePick] = useState(() => {
    const b = initialPick(initialOpts, 'between_counts', [true, false], null);
    return b == null ? null : { key: rangeKey, value: b };
  });
  const [keyOnly, setKeyOnly] = useState(() => initialPick(initialOpts, 'key_items_only', [true, false], false));
  const [category, setCategory] = useState('');
  const [drill, setDrill] = useState(() => {
    const site = initialSite(initialOpts, sites);
    return { level: site ? 'item' : 'site', site };
  });
  const [sort, setSort] = useState(null);

  const between = overrideValue(modePick, rangeKey, !!range.betweenCounts);
  // The item level is company wide (one row per company item across every site); a site drill narrows it.
  const opts = { between_counts: between, level: 'item', site: drill.site || undefined, key_items_only: keyOnly || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'gap', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'gap', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownTotals = (totals || []).map((t) => ({ ...t, _counted: t.location_id == null ? '' : t.counted_both_ends ? 'Counted both ends' : 'Not counted at both ends' }));
  const allRows = withSites(rows, meta, siteById).map((r) => ({
    ...r,
    _qty: r.unit ? `${r.gap_qty ?? ''} ${r.unit}` : r.gap_qty,
    _best: siteLabel(meta, siteById, r.best_site),
    _worst: siteLabel(meta, siteById, r.worst_site),
    _counted_at: sitesWords(r.counted_sites, nameOf),
    _not_counted: sitesWords(r.not_counted_sites, nameOf) || (r.not_counted ? 'Not counted' : ''),
  }));
  const categories = [...new Set(allRows.map((r) => r.category).filter(Boolean))].sort();
  const shownRows = category ? allRows.filter((r) => r.category === category) : allRows;
  const crumbs = crumbsFor(drill, nameOf);
  const goTo = () => { setDrill({ level: 'site', site: null }); setSort(null); };
  const openSite = (id) => { setDrill({ level: 'item', site: id }); setSort(null); };
  // v5.11.92 integration: at one site, an item opens Stock movement on that item's every movement and
  // its document, over the same window (the company gap, then a site, then an item, then a movement).
  const openMovement = drill.site && typeof onOpenReport === 'function'
    ? (row) => { if (row?.company_item_id) onOpenReport('stock_movement', { site: drill.site, item_id: row.company_item_id, between_counts: between }); }
    : undefined;
  const notes = notesOf(meta);

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <Segmented small value={between} options={MODES} onChange={(v) => { setModePick({ key: rangeKey, value: v }); setSort(null); }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t2)' }}>
          <Switch small on={keyOnly} onChange={(v) => setKeyOnly(!!v)} ariaLabel="Key items only" /> Key items only
        </label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category"
          style={{ padding: '6px 9px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13 }}>
          <option value="">Every category</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading the count adjustments" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={shownTotals} columns={TOTALS} layout={layout} rag={RAG} onSite={openSite} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
            <b style={{ fontSize: 14 }}>{drill.site ? `Items at ${nameOf(drill.site)}` : 'Top items across all sites'}</b>
            {crumbs.length > 1 && <Btn kind="link" small onClick={goTo}>Every site</Btn>}
            <span style={{ fontSize: 12, color: 'var(--t4)' }}>{openMovement ? 'Biggest loss first. Click an item for every movement and its document.' : 'Biggest loss first. An item not in both end counts at a site says so.'}</span>
          </div>
          <DrillTable columns={ITEM_COLS} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} onRow={openMovement} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
