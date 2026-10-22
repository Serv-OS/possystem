// src/backoffice/sections/reports/StockPar.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Par and availability. Below par and below
// minimum now (par by weekday where set); Stock outs in the period (item days at or below zero, a day
// by day replay of up to 93 days); Over par (overstock); Negative stock now. Every figure is
// stock_report_par's.

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, EmptyLine } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, dayWords, rangeDaysCount, initialPick, initialSite } from '../../../lib/stock/reportView.js';

const TITLE = 'Par and availability';
const SUB = 'Below par and below minimum now, stock outs in the period, over par, negative stock.';

const TOTALS = [
  col('below_par', 'Below par', 'int'), col('below_min', 'Below minimum', 'int'), col('stock_outs', 'Stock outs', 'int', { hint: 'item days at or below zero' }),
  col('over_par', 'Over par', 'int'), col('negative', 'Negative stock', 'int'),
];
const BELOW_COLS = [col('site', 'Site'), col('name', 'Item'), col('_on_hand', 'On hand', 'qty'), col('par', 'Par', 'qty', { hint: 'today\'s weekday where set' }), col('min_level', 'Minimum', 'qty'), col('short_by', 'Short by', 'qty')];
const STOCKOUT_COLS = [col('site', 'Site'), col('name', 'Item'), col('days_at_zero', 'Days at zero', 'int'), col('_first', 'First', 'text'), col('_last', 'Last', 'text')];
const OVER_COLS = [col('site', 'Site'), col('name', 'Item'), col('_on_hand', 'On hand', 'qty'), col('par', 'Par', 'qty'), col('_over_by', 'Over by', 'qty')];
const NEG_COLS = [col('site', 'Site'), col('name', 'Item'), col('_on_hand', 'On hand', 'qty')];
const TABS = [{ id: 'below', label: 'Below par and minimum' }, { id: 'stockout', label: 'Stock outs' }, { id: 'over', label: 'Over par' }, { id: 'negative', label: 'Negative stock' }];
const STOCKOUT_DAYS = 93;
const SORT_KEYS = { _on_hand: 'on_hand', _first: 'first_day', _last: 'last_day' };

export default function StockPar({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'below'));
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [sort, setSort] = useState(null);

  const tooLong = tab === 'stockout' && rangeDaysCount(range.fromDay, range.toDay) > STOCKOUT_DAYS;
  // A stock out window over 93 days is refused by the database in words; the screen reads the site level then and says why.
  const opts = { level: tooLong ? 'site' : tab, site: site || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'par', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'par', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.({ ...opts, level: tab });

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownRows = withSites(rows, meta, siteById).map((r) => ({
    ...r,
    _on_hand: r.unit ? `${r.on_hand ?? ''} ${r.unit}` : r.on_hand,
    _first: dayWords(r.first_day),
    _last: dayWords(r.last_day),
    _over_by: r.on_hand != null && r.par != null ? Number(r.on_hand) - Number(r.par) : null,
  }));
  const notes = notesOf(meta, tooLong ? ['Stock outs cover up to'] : []);
  const cols = tab === 'below' ? BELOW_COLS : tab === 'stockout' ? STOCKOUT_COLS : tab === 'over' ? OVER_COLS : NEG_COLS;

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading on hand, pars and the period" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={totals} columns={TOTALS} layout={layout} onSite={(id) => { setSite(id); setSort(null); }} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
            <b style={{ fontSize: 14 }}>{TABS.find((x) => x.id === tab)?.label}{site ? ` at ${nameOf(site)}` : ''}</b>
            {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
            {tab === 'below' && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Par is today's weekday par where one is set, else the item's par. Biggest shortfall first.</span>}
            {tab === 'stockout' && !tooLong && <span style={{ fontSize: 12, color: 'var(--t4)' }}>How many days each item sat at or below zero, from a day by day replay of the ledger.</span>}
          </div>
          {tooLong ? (
            <EmptyLine>Stock outs cover up to {STOCKOUT_DAYS} days. Pick a shorter period.</EmptyLine>
          ) : (
            <>
              <DrillTable columns={cols} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
            </>
          )}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
