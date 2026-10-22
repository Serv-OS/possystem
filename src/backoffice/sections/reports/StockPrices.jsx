// src/backoffice/sections/reports/StockPrices.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Price paid and price changes. Per item: the
// price paid at each site (average, lowest, highest, spread %) against the agreed price; Price changes
// in the period (invoices, edits, dated prices: old, new, %, the cost effect on the period's use);
// Coming changes (dated prices waiting). 'Overcharges and credits come with the purchasing update'.
// Every figure is stock_report_prices's (item_cost_history, stock_change_log, stock_co_dated_prices).

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, siteLabel, toggleSort, sortLoaded, notesOf, whenAt, fmtInt, unitMoney, initialPick, initialSite } from '../../../lib/stock/reportView.js';

const TITLE = 'Price paid and price changes';
const SUB = 'What each site paid against the agreed price, and every price change in the period with its effect on the period\'s use.';

const TOTALS = [col('items_priced', 'Items priced', 'int'), col('paid_over_agreed', 'Paid over agreed', 'int', { hint: 'lines' }), col('spread_pct_avg', 'Spread, average', 'pct')];
// Price paid is per base unit (a ml, a g, each): four places under one so it never reads 0.00.
const ITEM_COLS = [
  col('name', 'Item'), col('supplier_name', 'Supplier'), col('_agreed', 'Agreed, per base unit', 'qty'), col('_paid_avg', 'Paid, average', 'qty'),
  col('_paid_low', 'Lowest', 'qty'), col('_low_site', 'At'), col('_paid_high', 'Highest', 'qty'), col('_high_site', 'At'),
  col('spread_pct', 'Spread', 'pct'), col('_over', 'Sites over agreed', 'text'),
];
const CHANGE_COLS = [
  col('_at', 'When', 'text'), col('site', 'Site'), col('name', 'Item'), col('_source', 'From'), col('old_price', 'Old', 'money'), col('new_price', 'New', 'money'),
  col('pct', 'Change', 'pct'), col('use_qty', 'Use in period', 'qty'), col('cost_effect', 'Cost effect', 'money', { hint: 'on the period use' }), col('who', 'Who'),
];
const COMING_COLS = [col('_at', 'From', 'text'), col('site', 'Site'), col('name', 'Item'), col('old_price', 'Now', 'money'), col('new_price', 'Coming', 'money'), col('pct', 'Change', 'pct'), col('who', 'Set by')];
const TABS = [{ id: 'item', label: 'Price paid' }, { id: 'change', label: 'Price changes' }, { id: 'coming', label: 'Coming changes' }];
const SOURCE_WORDS = { invoice: 'Invoice', edit: 'Edit', dated: 'Dated price' };
const SORT_KEYS = { _agreed: 'agreed_price', _paid_avg: 'paid_avg', _paid_low: 'paid_low', _paid_high: 'paid_high', _low_site: 'paid_low_site', _high_site: 'paid_high_site', _over: 'over_agreed_sites', _at: 'at', _source: 'source' };
const OWN_LINE = 'Overcharges and credits come with the purchasing update';

export default function StockPrices({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'item'));
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [item, setItem] = useState(() => {
    const id = initialPick(initialOpts, 'item_id', null, null);
    return id ? { id: String(id), name: 'One item' } : null;
  });
  const [sort, setSort] = useState(null);

  const opts = { level: tab, site: site || undefined, item_id: item?.id || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'prices', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'prices', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownRows = withSites(rows, meta, siteById).map((r) => ({
    ...r,
    _agreed: unitMoney(r.agreed_price, r.currency),
    _paid_avg: unitMoney(r.paid_avg, r.currency),
    _paid_low: unitMoney(r.paid_low, r.currency),
    _paid_high: unitMoney(r.paid_high, r.currency),
    _low_site: siteLabel(meta, siteById, r.paid_low_site),
    _high_site: siteLabel(meta, siteById, r.paid_high_site),
    _over: Array.isArray(r.over_agreed_sites) ? r.over_agreed_sites.map((x) => siteLabel(meta, siteById, x)).join(', ') : (r.over_agreed_sites == null ? '' : fmtInt(r.over_agreed_sites)),
    _at: whenAt(meta, r.location_id, r.at),
    _source: SOURCE_WORDS[r.source] || r.source || '',
  }));
  const notes = notesOf(meta, [OWN_LINE]);
  const cols = tab === 'item' ? ITEM_COLS : tab === 'change' ? CHANGE_COLS : COMING_COLS;
  const openItem = (row) => { if (tab === 'item' && row.company_item_id) { setItem({ id: row.company_item_id, name: row.name }); setTab('change'); setSort(null); } };

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading prices paid and price changes" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={totals} columns={TOTALS} layout={layout} onSite={(id) => { setSite(id); setSort(null); }} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          <div style={{ display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--t3)', margin: '8px 2px' }}>
            <div>{OWN_LINE}.</div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
            <b style={{ fontSize: 14 }}>
              {tab === 'item' ? 'Price paid per item' : tab === 'change' ? 'Price changes in the period' : 'Coming price changes'}
              {site ? ` at ${nameOf(site)}` : ''}{item ? `: ${item.name}` : ''}
            </b>
            {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
            {item && <Btn kind="link" small onClick={() => { setItem(null); setSort(null); }}>Every item</Btn>}
            {tab === 'item' && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Click an item for its price changes. Agreed = the company pack price, or the price here at a site.</span>}
          </div>
          <DrillTable columns={cols} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} onRow={openItem} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
