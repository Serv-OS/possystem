// src/backoffice/sections/reports/StockBatches.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Batches and production. Per site: batches
// made, planned against actual yield, the value made (PRODUCTION_OUTPUT) against the value used
// (PRODUCTION_CONSUME) and the variance, theoretical against actual cost; per recipe (output item);
// per batch. Every figure is stock_report_batches's (production_batches and the ledger day totals).

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, EmptyLine } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, whenAt, initialPick, initialSite } from '../../../lib/stock/reportView.js';

const TITLE = 'Batches and production';
const SUB = 'Batches made per site, planned against actual yield, the value made against the value used, theoretical against actual cost.';

const TOTALS = [
  col('batches', 'Batches', 'int'), col('planned_qty', 'Planned', 'qty'), col('actual_qty', 'Actual', 'qty'), col('yield_pct', 'Yield', 'pct'),
  col('made_value', 'Made', 'money'), col('used_value', 'Used', 'money'), col('variance_value', 'Variance', 'money', { hint: 'made less used' }),
  col('theoretical_cost', 'Theoretical cost', 'money'), col('actual_cost', 'Actual cost', 'money'),
];
const RECIPE_COLS = [
  col('site', 'Site'), col('output_name', 'Recipe'), col('batches', 'Batches', 'int'), col('planned_qty', 'Planned', 'qty'), col('actual_qty', 'Actual', 'qty'),
  col('yield_pct', 'Yield', 'pct'), col('made_value', 'Made', 'money'), col('used_value', 'Used', 'money'),
];
const BATCH_COLS = [
  col('_when', 'Made', 'text'), col('site', 'Site'), col('output_name', 'Recipe'), col('_planned', 'Planned', 'qty'), col('_actual', 'Actual', 'qty'),
  col('theoretical_cost', 'Theoretical cost', 'money'), col('actual_cost', 'Actual cost', 'money'), col('lot_code', 'Lot'), col('produced_by_name', 'Made by'),
];
const TABS = [{ id: 'site', label: 'By site' }, { id: 'recipe', label: 'By recipe' }, { id: 'batch', label: 'Each batch' }];
const SORT_KEYS = { _when: 'produced_at', _planned: 'planned_qty', _actual: 'actual_qty' };

export default function StockBatches({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'site'));
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [sort, setSort] = useState(null);

  const opts = { level: tab, site: site || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'batches', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'batches', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownRows = withSites(rows, meta, siteById).map((r) => ({
    ...r,
    _when: whenAt(meta, r.location_id, r.produced_at),
    _planned: r.output_unit ? `${r.planned_qty ?? ''} ${r.output_unit}` : r.planned_qty,
    _actual: r.output_unit ? `${r.actual_qty ?? ''} ${r.output_unit}` : r.actual_qty,
  }));
  const notes = notesOf(meta);

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading the batches" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={totals} columns={TOTALS} layout={layout} onSite={(id) => { setSite(id); if (tab === 'site') setTab('recipe'); setSort(null); }} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />

          {tab !== 'site' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
                <b style={{ fontSize: 14 }}>{tab === 'recipe' ? 'By recipe' : 'Each batch'}{site ? ` at ${nameOf(site)}` : ''}</b>
                {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
                {tab === 'recipe' && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Yield = actual over planned.</span>}
              </div>
              <DrillTable columns={tab === 'recipe' ? RECIPE_COLS : BATCH_COLS} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
            </>
          )}
          {tab === 'site' && <EmptyLine>Pick By recipe or Each batch, or click a site.</EmptyLine>}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
