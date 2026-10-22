// src/backoffice/sections/reports/StockValue.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Stock value. Any past date, by site,
// category, area (today only) or legal company; drill site, then category, then item. Every figure
// is the database's (stock_report_value reads the ledger day totals: on hand times cost at the end
// of that day), never worked out here. 'Negative stock' and 'Archived items still holding stock'
// sit on their own lines and never reduce a total. 'Counted' or 'Estimated (ledger)' on every site.
// For a multi site company this screen absorbs today's Valuation and By area (StockReports.jsx
// stays for one site companies).

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { Btn, Segmented } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, crumbsFor, toggleSort, sortLoaded, notesOf, dayWords, initialPick, initialSite } from '../../../lib/stock/reportView.js';
import { money } from '../../../lib/currency';

const TITLE = 'Stock value';
const SUB = 'Any past date, by site, category, area or legal company. Ledger value at the end of that day: on hand times the cost on the day.';

const TOTALS = [
  col('stock_value', 'Stock value', 'money'),
  col('negative_value', 'Negative stock', 'money', { hint: 'shown apart, never taken off' }),
  col('archived_holding_value', 'Archived items still holding stock', 'money'),
  col('items', 'Items', 'int'),
];
const CATEGORY_COLS = [col('site', 'Site'), col('name', 'Category'), col('value', 'Value', 'money'), col('items', 'Items', 'int')];
const ITEM_COLS = [
  col('name', 'Item'), col('category', 'Category'), col('_qty', 'On hand', 'qty'), col('cost', 'Cost', 'money'), col('value', 'Value', 'money'),
  col('_archived', 'Archived', 'text'),
];
const LEGAL_COLS = [col('legal_company', 'Legal company'), col('stock_value', 'Stock value', 'money'), col('negative_value', 'Negative stock', 'money'), col('sites', 'Sites', 'int')];
const VIEWS = [{ value: 'category', label: 'By category' }, { value: 'area', label: 'By area' }, { value: 'legal', label: 'By legal company' }];
const SORT_KEYS = { _qty: 'qty', _archived: 'archived' };
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export default function StockValue({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  // { key: range.toDay, value }: the picked day resets with the period. A See the report button or a
  // share link may hand the day ('at').
  const [atPick, setAtPick] = useState(() => {
    const at = initialPick(initialOpts, 'at', null, null) || initialPick(initialOpts, 'at_day', null, null);
    // Any past day (p_from is not used by this report), so a link's day is kept even past the period end.
    return isDay(at) ? { key: range.toDay, value: at } : null;
  });
  const [view, setView] = useState(() => initialPick(initialOpts, 'view', ['category', 'area', 'legal'], 'category'));
  const [drill, setDrill] = useState(() => {
    const site = initialSite(initialOpts, sites);
    return { level: site ? 'category' : 'site', site, category_id: null, category_name: null };
  });
  const [sort, setSort] = useState(null);

  const atDay = atPick && atPick.key === range.toDay && atPick.value ? atPick.value : range.toDay;
  const level = drill.level;
  const opts = { at_day: atDay, view, level, site: drill.site || undefined, category_id: drill.category_id || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'value', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'value', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.({ ...opts, at: atDay });

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownTotals = totals || [];
  const shownRows = withSites(rows, meta, siteById);
  const crumbs = crumbsFor(drill, nameOf);
  const goTo = (id) => {
    if (id === 'company') setDrill({ level: 'site', site: null, category_id: null, category_name: null });
    else if (id === 'site') setDrill((d) => ({ level: 'category', site: d.site, category_id: null, category_name: null }));
    setSort(null);
  };
  const openSite = (id) => { setDrill({ level: 'category', site: id, category_id: null, category_name: null }); setSort(null); };
  const openCategory = (row) => { setDrill((d) => ({ level: 'item', site: row.location_id || d.site, category_id: row.category_id, category_name: row.name })); setSort(null); };

  // Level 'site': one row per site with its categories across (the mockup's "sites down, categories across").
  // By area the site rows carry by_area (today only); by legal company the rows are one per legal company.
  const siteMatrix = level === 'site' && view !== 'legal' ? matrixOf(shownRows, view === 'area' ? 'by_area' : 'by_category', view === 'area' ? 'area_id' : 'category_id') : null;
  const legalRows = level === 'site' && view === 'legal' ? shownRows.filter((r) => r.legal_company != null) : null;
  const itemRows = level === 'item' ? shownRows.map((r) => ({ ...r, _qty: r.unit ? `${r.qty ?? ''} ${r.unit}` : r.qty, _archived: r.archived ? 'Archived' : '' })) : null;
  const nowCompany = shownTotals.filter((t) => t.location_id == null);
  const notes = notesOf(meta);

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t3)' }}>
          At the end of
          <input type="date" value={atDay} aria-label="At the end of"
            onChange={(e) => setAtPick({ key: range.toDay, value: e.target.value || null })}
            style={{ padding: '6px 9px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13 }} />
        </label>
        <Segmented small value={view} options={VIEWS} onChange={(v) => { setView(v); goTo('company'); }} />
        {view === 'area' && <span style={{ fontSize: 12, color: 'var(--t4)' }}>By area is today only.</span>}
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words={`Reading the stock value at the end of ${dayWords(atDay) || 'that day'}`} />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={shownTotals} columns={TOTALS} layout={layout} onSite={openSite} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          <div style={{ display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--t3)', margin: '8px 2px 14px' }}>
            {nowCompany.map((t, i) => (
              <div key={t.currency || i}>
                Negative stock {money(t.negative_value || 0, t.currency)} and archived items still holding stock {money(t.archived_holding_value || 0, t.currency)}
                {t.currency ? ` (${t.currency})` : ''}: shown apart, never taken off the total.
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 10px' }}>
            {crumbs.map((c, i) => (
              <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {i > 0 && <span style={{ color: 'var(--t4)' }}>/</span>}
                {i < crumbs.length - 1 ? <Btn kind="link" small onClick={() => goTo(c.id)}>{c.label}</Btn> : <b style={{ fontSize: 13 }}>{c.label}</b>}
              </span>
            ))}
            <span style={{ fontSize: 12, color: 'var(--t4)' }}>{level === 'site' ? 'Click a site for its categories' : level === 'category' ? 'Click a category for its items' : 'Items by value'}</span>
          </div>

          {level === 'site' && view !== 'legal' && siteMatrix && (
            <DrillTable columns={siteMatrix.columns} rows={sortLoaded(siteMatrix.rows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} onRow={(r) => openSite(r.location_id)} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
          )}
          {level === 'site' && view === 'legal' && legalRows && (
            <DrillTable columns={LEGAL_COLS} rows={sortLoaded(legalRows, sort, SORT_KEYS)} next={null} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))}
              empty="No stock at these sites on that day." />
          )}
          {level === 'category' && (
            <DrillTable columns={CATEGORY_COLS} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} onRow={openCategory} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
          )}
          {level === 'item' && (
            <DrillTable columns={ITEM_COLS} rows={sortLoaded(itemRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
          )}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}

/**
 * Site rows with `by_category` (or `by_area`) become one row per site and a money column per category
 * (or storage area), the total last.
 */
function matrixOf(rows, listKey = 'by_category', idKey = 'category_id') {
  const cats = new Map();
  for (const r of rows || []) for (const c of r[listKey] || []) if (!cats.has(c[idKey] || c.name)) cats.set(c[idKey] || c.name, c.name || (listKey === 'by_area' ? 'No area' : 'No category'));
  const columns = [col('site', 'Site'), ...[...cats.entries()].map(([id, name]) => col(`cat:${id}`, name, 'money')), col('stock_value', 'Total', 'money')];
  const out = (rows || []).map((r) => {
    const row = { ...r };
    for (const c of r[listKey] || []) row[`cat:${c[idKey] || c.name}`] = c.value;
    return row;
  });
  return { columns, rows: out };
}
