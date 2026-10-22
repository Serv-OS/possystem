// src/backoffice/sections/reports/StockDaysOnHand.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Days on hand, slow and dead stock. Days on
// hand per site and category = stock value now over the average daily cost of use (the last 28 venue
// days); stock turn a year. Slow and dead: items with no use in 14, 30 or 60 days, with the value tied
// up and a 'Transfer to <site>' suggestion where another site in scope used the item. Every figure is
// stock_report_days_on_hand's.

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, Segmented, EmptyLine } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, currencyOf, toggleSort, sortLoaded, notesOf, dayWords, transferWords, initialPick, initialSite } from '../../../lib/stock/reportView.js';
import { money } from '../../../lib/currency';

const TITLE = 'Days on hand, slow and dead stock';
const SUB = 'Stock value now over the average daily cost of use in the last 28 days, per site and category. Slow and dead stock with where it could go.';

const TOTALS = [
  col('stock_value_now', 'Stock value now', 'money'), col('daily_use', 'Daily use', 'money', { hint: '28 day average' }),
  col('_doh', 'Days on hand', 'text'), col('_turn', 'Stock turn a year', 'text'), col('slow_value', 'Slow and dead', 'money'),
];
const CATEGORY_COLS = [col('site', 'Site'), col('name', 'Category'), col('stock_value_now', 'Stock value now', 'money'), col('daily_use', 'Daily use', 'money'), col('_doh', 'Days on hand', 'text'), col('_turn', 'Stock turn', 'text')];
const SLOW_COLS = [
  col('site', 'Site'), col('name', 'Item'), col('_qty', 'On hand', 'qty'), col('value', 'Value tied up', 'money'), col('_last_use', 'Last used', 'text'),
  col('idle_days', 'Idle days', 'int'), col('_transfer', 'Suggestion', 'text'),
];
const TABS = [{ id: 'site', label: 'By site' }, { id: 'category', label: 'By category' }, { id: 'slow', label: 'Slow and dead' }];
const IDLE = [{ value: 14, label: '14 days' }, { value: 30, label: '30 days' }, { value: 60, label: '60 days' }];
const RAG = { _doh: 'days_on_hand' };
const SORT_KEYS = { _doh: 'days_on_hand', _turn: 'stock_turn', _qty: 'qty', _last_use: 'last_use_day', _transfer: '_transfer_n' };

const dohWords = (v) => (v == null ? 'No use' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 1 }));
const turnWords = (v) => (v == null ? '' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 1 }));

export default function StockDaysOnHand({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'site'));
  const [idle, setIdle] = useState(() => initialPick(initialOpts, 'idle_days', [14, 30, 60], 30));
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [sort, setSort] = useState(null);

  const opts = { level: tab, site: site || undefined, idle_days: idle };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'days_on_hand', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'days_on_hand', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownTotals = (totals || []).map((t) => ({ ...t, _doh: dohWords(t.days_on_hand), _turn: turnWords(t.stock_turn) }));
  const shownRows = withSites(rows, meta, siteById).map((r) => ({
    ...r,
    _doh: dohWords(r.days_on_hand),
    _turn: turnWords(r.stock_turn),
    _qty: r.unit ? `${r.qty ?? ''} ${r.unit}` : r.qty,
    _last_use: r.last_use_day ? dayWords(r.last_use_day) : 'Never',
    // use_28d is the cost of what the other site used in 28 days, in that site's own currency.
    _transfer: transferWords(r.transfer_to, nameOf, (v, t) => money(v, currencyOf(meta, siteById, t.location_id) || r.currency)) || 'No other site uses it',
    _transfer_n: Array.isArray(r.transfer_to) ? r.transfer_to.length : 0,
  }));
  const notes = notesOf(meta);

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
        {tab === 'slow' && <Segmented small value={idle} options={IDLE} onChange={(v) => { setIdle(v); setSort(null); }} />}
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading stock on hand and the last 28 days of use" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={shownTotals} columns={TOTALS} layout={layout} rag={RAG} onSite={(id) => { setSite(id); if (tab === 'site') setTab('category'); setSort(null); }} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          <div style={{ display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--t3)', margin: '8px 2px' }}>
            <div>Days on hand = stock value now over the average daily cost of sales and batch use in the last 28 venue days. 'No use' when nothing was used.</div>
          </div>

          {tab !== 'site' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
                <b style={{ fontSize: 14 }}>{tab === 'category' ? 'By category' : `No use in ${idle} days`}{site ? ` at ${nameOf(site)}` : ''}</b>
                {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
                {tab === 'slow' && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Biggest value tied up first. A Transfer to suggestion names a site in scope that used the item in the last 28 days.</span>}
              </div>
              <DrillTable columns={tab === 'category' ? CATEGORY_COLS : SLOW_COLS} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
            </>
          )}
          {tab === 'site' && <EmptyLine>Pick By category or Slow and dead, or click a site.</EmptyLine>}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
