// src/backoffice/sections/reports/StockWaste.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Waste. Per site: waste value, % of sales
// and % of purchases (spots over ordering); by reason, category, item (amount, value, top reason),
// person (who logs, how much) and day. 'Refunded food' (the drainer books a refund as waste) and
// 'End of day close down' on their own lines. Every figure is stock_report_waste's (waste_events, so
// the reason and the person exist; the database says in meta.notes when the ledger WASTE total differs).

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, EmptyLine } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, dayWords, initialPick, initialSite, LATER_WORDS } from '../../../lib/stock/reportView.js';
import { money } from '../../../lib/currency';

const TITLE = 'Waste';
const SUB = 'Logged waste per site, as money and as a share of sales and of purchases. By reason, category, item, person and day.';

const TOTALS = [
  col('waste_value', 'Waste', 'money'), col('waste_pct_sales', '% of sales', 'pct'), col('waste_pct_purchases', '% of purchases', 'pct'),
  col('refund_waste', 'Refunded food', 'money'), col('_closedown', 'End of day close down', 'text'), col('events', 'Entries', 'int'),
];
const LEVEL_COLS = {
  reason: [col('site', 'Site'), col('reason', 'Reason'), col('value', 'Value', 'money'), col('qty', 'Quantity', 'qty'), col('events', 'Entries', 'int')],
  category: [col('site', 'Site'), col('name', 'Category'), col('value', 'Value', 'money'), col('qty', 'Quantity', 'qty'), col('events', 'Entries', 'int')],
  item: [col('site', 'Site'), col('name', 'Item'), col('value', 'Value', 'money'), col('_qty', 'Quantity', 'qty'), col('top_reason', 'Top reason'), col('events', 'Entries', 'int')],
  person: [col('site', 'Site'), col('name', 'Who'), col('value', 'Value', 'money'), col('events', 'Entries', 'int')],
  day: [col('site', 'Site'), col('_day', 'Business day', 'text'), col('value', 'Value', 'money'), col('events', 'Entries', 'int')],
};
const TABS = [
  { id: 'site', label: 'By site' }, { id: 'reason', label: 'By reason' }, { id: 'category', label: 'By category' },
  { id: 'item', label: 'By item' }, { id: 'person', label: 'By person' }, { id: 'day', label: 'By day' },
];
const RAG = { waste_pct_sales: 'waste_pct' };
const SORT_KEYS = { _qty: 'qty', _day: '_day_key' };

export default function StockWaste({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'site'));
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [sort, setSort] = useState(null);

  const level = tab;
  const opts = { level, site: site || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'waste', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'waste', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownTotals = (totals || []).map((t) => ({ ...t, _closedown: t.closedown_waste == null ? LATER_WORDS.purchasing : money(t.closedown_waste, t.currency) }));
  const shownRows = withSites(rows, meta, siteById).map((r) => ({
    ...r,
    _qty: r.unit ? `${r.qty ?? ''} ${r.unit}` : r.qty,
    // The day level names each row by its business day ('YYYY-MM-DD' in day and in name).
    _day: dayWords(r.day || (level === 'day' ? r.name : null)),
    _day_key: r.day || (level === 'day' ? r.name : null),
    name: level === 'person' ? (r.name || 'Till') : r.name,
  }));
  const nowCompany = shownTotals.filter((t) => t.location_id == null);
  const notes = notesOf(meta);

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading the waste entries" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={shownTotals} columns={TOTALS} layout={layout} rag={RAG} onSite={(id) => { setSite(id); if (tab === 'site') setTab('reason'); setSort(null); }} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          <div style={{ display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--t3)', margin: '8px 2px' }}>
            {nowCompany.map((t, i) => (
              <div key={t.currency || i}>
                Refunded food {money(t.refund_waste || 0, t.currency)}{t.currency ? ` (${t.currency})` : ''}: booked as waste on the refund day, never put back in stock.
                End of day close down: {LATER_WORDS.purchasing.toLowerCase()}.
              </div>
            ))}
          </div>

          {tab !== 'site' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
                <b style={{ fontSize: 14 }}>{TABS.find((x) => x.id === tab)?.label}{site ? ` at ${nameOf(site)}` : ''}</b>
                {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
                {tab === 'person' && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Entries with no login are the till's.</span>}
              </div>
              <DrillTable columns={LEVEL_COLS[tab]} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
            </>
          )}
          {tab === 'site' && <EmptyLine>Pick a tab for the split, or click a site for its reasons.</EmptyLine>}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
