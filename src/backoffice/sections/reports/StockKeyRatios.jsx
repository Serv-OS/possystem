// src/backoffice/sections/reports/StockKeyRatios.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Key item ratios, the dashboard tiles in
// full. Per site and per week: used against sold for each key ratio (milk per milk drink, beans per
// shot, cups per cup drink, buns per burger), recipe against actual, the trend. The ratios are chosen
// in the Targets panel (stock_key_ratios); with none set the database says 'Choose your key items in
// Targets'. Every figure is stock_report_key_ratios's.

import { useState } from 'react';
import { StockReportFrame, DrillTable, RagPill, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, Notice } from '../stock/stockUi';
import { BarRow } from './_charts';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, weekWords, groupRows, fmtQty, fmtPct, maxAbs, initialPick } from '../../../lib/stock/reportView.js';

const TITLE = 'Key item ratios';
const SUB = 'Used against sold for each key item, per site and per week, recipe against actual.';

const SITE_COLS = [
  col('site', 'Site'), col('name', 'Key item'), col('_used', 'Used', 'qty'), col('sold_qty', 'Sold', 'qty'), col('_per_sold', 'Actual per sold', 'text'),
  col('_recipe', 'Recipe', 'text'), col('diff_pct', 'Difference', 'pct'), col('_rag', 'Against target', 'text'),
];
const WEEK_COLS = [col('site', 'Site'), col('_week', 'Week', 'text'), ...SITE_COLS.slice(1)];
const TABS = [{ id: 'site', label: 'By site' }, { id: 'week', label: 'By week' }];
const SORT_KEYS = { _used: 'used_qty', _per_sold: 'per_sold', _recipe: 'recipe_amount', _rag: 'diff_pct', _week: 'week_start' };
// The database colours a ratio by how far actual is from the recipe either way: 5% green, 10% amber.
const RAG_WORDS = { green: 'Close to recipe', amber: 'Off recipe', red: 'Well off recipe' };

export default function StockKeyRatios({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api, onOpenReport }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'site'));
  const [ratio, setRatio] = useState(() => {
    const id = initialPick(initialOpts, 'ratio_id', null, null);
    return id ? { id: String(id), name: 'Key item' } : null;
  });
  const [sort, setSort] = useState(null);

  const opts = { level: tab, ratio_id: ratio?.id || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'key_ratios', args) || {};
  const { meta, totals, rows, next, loading, error, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'key_ratios', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shape = (r) => ({
    ...r,
    _used: fmtQty(r.used_qty, r.used_unit),
    _per_sold: r.per_sold == null ? 'Nothing sold' : fmtQty(r.per_sold, r.used_unit, 3),
    _recipe: r.recipe_amount == null ? 'Not set' : fmtQty(r.recipe_amount, r.used_unit, 3),
    _rag: r.rag == null ? '' : RAG_WORDS[r.rag] || '',
    _week: weekWords(r.week_start),
  });
  // The totals here are one row per site per ratio (contract 1.6.3), so they are listed, not one row a site.
  const siteRows = withSites(totals, meta, siteById).filter((t) => t.location_id != null).map(shape);
  const companyRows = withSites(totals, meta, siteById).filter((t) => t.location_id == null).map(shape);
  const weekRows = tab === 'week' ? withSites(rows, meta, siteById).map(shape) : [];
  // The key items on screen: from the site rows, else the company rows (the week level answers company totals only).
  const ratios = groupRows([...siteRows, ...companyRows], 'ratio_id').filter((g) => g.key).map((g) => ({ id: g.key, name: g.rows[0]?.name || 'Key item' }));
  const ratioName = ratio ? (ratios.find((x) => x.id === ratio.id)?.name || ratio.name) : null;
  const shownSite = layout === 'total' ? companyRows : (ratio ? siteRows.filter((r) => String(r.ratio_id) === String(ratio.id)) : siteRows);
  const shownWeek = ratio ? weekRows.filter((r) => String(r.ratio_id) === String(ratio.id)) : weekRows;
  const notes = notesOf(meta);
  const none = totals && siteRows.length === 0 && companyRows.length === 0;
  // The trend reads each site's weeks oldest first, whatever order the table is sorted in.
  const trendRatio = ratio || (ratios.length === 1 ? ratios[0] : null);
  const trend = tab === 'week' && trendRatio ? groupRows(sortLoaded(shownWeek, { key: 'week_start', dir: 'asc' }), 'location_id') : [];

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
        {ratios.length > 1 && (
          <select value={ratio?.id || ''} onChange={(e) => { const r = ratios.find((x) => x.id === e.target.value); setRatio(r || null); setSort(null); }} aria-label="Key item"
            style={{ padding: '6px 9px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13 }}>
            <option value="">Every key item</option>
            {ratios.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading used and sold" />}

      {none && (
        <Notice tone="info" actions={[typeof onOpenReport === 'function' && { label: 'Open the dashboard', kind: 'soft', onClick: () => onOpenReport('stock_home', { panel: 'targets' }) }]}>
          {notes[0] || 'Choose your key items in Targets'}. Coffee groups usually track milk per milk drink, beans per shot and cups against cup drinks sold.
        </Notice>
      )}

      {totals && !none && (
        <>
          {tab === 'site' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 10px' }}>
                <b style={{ fontSize: 14 }}>{layout === 'total' ? 'Company total per key item' : 'Per site and key item'}</b>
                {ratio && <Btn kind="link" small onClick={() => setRatio(null)}>Every key item</Btn>}
                <span style={{ fontSize: 12, color: 'var(--t4)' }}>Used = the stock the sales took off; sold = the products the ratio counts. Difference against the recipe amount.</span>
              </div>
              <DrillTable columns={SITE_COLS} rows={sortLoaded(shownSite, sort, SORT_KEYS)} next={null} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))}
                onRow={(r) => { if (!ratio && r.ratio_id) setRatio({ id: String(r.ratio_id), name: r.name }); }} />
              {layout !== 'total' && companyRows.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '0 2px 8px' }}>Company total</div>
                  <DrillTable columns={SITE_COLS.slice(1)} rows={ratio ? companyRows.filter((r) => String(r.ratio_id) === String(ratio.id)) : companyRows} next={null} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {shownSite.slice(0, 12).map((r, i) => <RagPill key={`${r.location_id}:${r.ratio_id}:${i}`} rag={r.rag}>{r.site}: {r.name} {fmtPct(r.diff_pct)}</RagPill>)}
              </div>
            </>
          )}
          {tab === 'week' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 10px' }}>
                <b style={{ fontSize: 14 }}>By week{ratio ? `: ${ratioName}` : ''}</b>
                {ratio && <Btn kind="link" small onClick={() => setRatio(null)}>Every key item</Btn>}
                {!ratio && ratios.length > 1 && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Pick one key item for its trend.</span>}
              </div>
              {trend.length > 0 && (
                <div style={{ display: 'grid', gap: 14, marginBottom: 14 }}>
                  {trend.map((g) => {
                    const max = Math.max(maxAbs(g.rows, 'per_sold'), maxAbs(g.rows, 'recipe_amount'));
                    const recipe = g.rows.find((r) => r.recipe_amount != null)?.recipe_amount;
                    return (
                      <div key={g.key} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 16 }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 10 }}>
                          <b style={{ fontSize: 13 }}>{nameOf(g.key)}</b>
                          <span style={{ fontSize: 12, color: 'var(--t4)' }}>actual per sold by week{recipe != null ? `, recipe ${fmtQty(recipe, g.rows[0]?.used_unit, 3)}` : ''}</span>
                        </div>
                        {g.rows.map((r) => (
                          <BarRow key={r.week_start} label={r._week} value={Number(r.per_sold) || 0} max={max || 1} format={() => r._per_sold}
                            color={r.rag === 'red' ? 'var(--red)' : r.rag === 'amber' ? 'var(--amber, #F5A623)' : 'var(--grn, #16a34a)'} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
              <DrillTable columns={WEEK_COLS} rows={sortLoaded(shownWeek, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
            </>
          )}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
