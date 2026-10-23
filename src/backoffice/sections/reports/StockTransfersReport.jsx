// src/backoffice/sections/reports/StockTransfersReport.jsx
//
// MULTI SITE STOCK, Drop 4b (v5.11.100, design 5.14): Transfers and central kitchen. Per site: sent
// out (at the sender's cost), received in (at the price the site paid), in transit, short, disputed
// and open requests; the from and to grid; every transfer with its status; the central kitchen (fill
// rate, shorts, on time, internal sales and margin, made, kitchen stock and waste); recharges between
// legal companies. Every figure is stock_report_transfers's. A locked period's site figures are the
// snapshot's (the rules line says so).

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, EmptyLine, Segmented } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, whenAt, initialPick, initialSite } from '../../../lib/stock/reportView.js';
import { money } from '../../../lib/currency';

const TITLE = 'Transfers and central kitchen';
const SUB = 'What moved between sites, what is still on the road, shorts and disputes, the central kitchen\'s fill rate and margin, and recharges between companies.';

const TOTALS = [
  col('sent_out', 'Sent out', 'money', { hint: 'at the sender\'s cost' }), col('received_in', 'Received in', 'money', { hint: 'at the price paid' }),
  col('in_transit', 'In transit', 'money'), col('in_transit_count', 'On the road', 'int'), col('short', 'Short', 'money'), col('short_lines', 'Short lines', 'int'),
  col('disputed', 'Disputed', 'int'), col('requests_open', 'Requests open', 'int'), col('transfers', 'Transfers', 'int'),
];
const GRID_COLS = [col('from_site', 'From'), col('to_site', 'To'), col('value', 'Received value', 'money'), col('sent_value', 'Sent value', 'money'), col('transfers', 'Transfers', 'int')];
const LIST_COLS = [
  col('reference', 'Transfer'), col('_kind', 'Kind'), col('words', 'Status'), col('from_site', 'From'), col('to_site', 'To'),
  col('_sent', 'Sent', 'text'), col('_received', 'Received', 'text'), col('value', 'Value', 'money'), col('short_value', 'Short', 'money'), col('lines', 'Lines', 'int'),
];
const KITCHEN_COLS = [
  col('kitchen', 'Kitchen'), col('site', 'Site'), col('orders', 'Orders', 'int'), col('ordered_qty', 'Ordered', 'qty'), col('sent_qty', 'Sent', 'qty'),
  col('fill_rate', 'Fill rate', 'pct'), col('short_lines', 'Short lines', 'int'), col('on_time_pct', 'On time', 'pct'),
  col('internal_sales', 'Internal sales', 'money'), col('kitchen_cost', 'Kitchen cost', 'money'), col('margin', 'Margin', 'money'),
];
const KITCHEN_SELF_COLS = [
  col('kitchen', 'Kitchen'), col('made_value', 'Made', 'money'), col('planned_qty', 'Planned, ticked', 'qty'),
  col('kitchen_stock_value', 'Kitchen stock value', 'money'), col('kitchen_waste', 'Kitchen waste', 'money'),
];
const RECHARGE_COLS = [col('from_legal', 'From company'), col('to_legal', 'To company'), col('amount', 'Recharge', 'money'), col('transfers', 'Transfers', 'int')];
const TABS = [
  { id: 'site', label: 'By site' }, { id: 'grid', label: 'From and to' }, { id: 'list', label: 'Every transfer' },
  { id: 'kitchen', label: 'Central kitchen' }, { id: 'recharges', label: 'Recharges' },
];
const STATUSES = [
  { value: '', label: 'All' }, { value: 'SENT', label: 'In transit' }, { value: 'RECEIVED', label: 'Received' }, { value: 'short', label: 'Short' },
  { value: 'DISPUTED', label: 'Disputed' }, { value: 'REQUESTED', label: 'Requested' },
];
const KIND_WORDS = { transfer: 'Transfer', request: 'Request', central_kitchen: 'Central kitchen' };
const SORT_KEYS = { _kind: 'kind', _sent: 'sent_at', _received: 'received_at' };

export default function StockTransfersReport({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'site'));
  const [status, setStatus] = useState(() => initialPick(initialOpts, 'status', STATUSES.map((x) => x.value).filter(Boolean), ''));
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [sort, setSort] = useState(null);

  const opts = { level: tab, site: site || undefined, status: tab === 'list' && status ? status : undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'transfers', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'transfers', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownRows = withSites(rows, meta, siteById).map((r) => ({
    ...r,
    from_site: r.from_site || (r.from_location_id ? nameOf(r.from_location_id) : ''),
    to_site: r.to_site || (r.to_location_id ? nameOf(r.to_location_id) : ''),
    kitchen: r.kitchen || (r.kitchen_location_id ? nameOf(r.kitchen_location_id) : ''),
    _kind: KIND_WORDS[r.kind] || r.kind || '',
    _sent: whenAt(meta, r.from_location_id, r.sent_at),
    _received: whenAt(meta, r.to_location_id, r.received_at),
  }));
  // The kitchen tab answers one row per ordering site and one row for the kitchen itself
  // (location_id equals kitchen_location_id): two tables.
  const kitchenSelf = tab === 'kitchen' ? shownRows.filter((r) => r.kitchen_location_id && String(r.location_id) === String(r.kitchen_location_id)) : [];
  const kitchenSites = tab === 'kitchen' ? shownRows.filter((r) => !(r.kitchen_location_id && String(r.location_id) === String(r.kitchen_location_id))) : [];
  const cols = tab === 'grid' ? GRID_COLS : tab === 'list' ? LIST_COLS : tab === 'recharges' ? RECHARGE_COLS : KITCHEN_COLS;
  const drillRows = tab === 'kitchen' ? kitchenSites : shownRows;
  const notes = notesOf(meta);
  const transitTotal = (totals || []).filter((t) => t.location_id == null && Number(t.in_transit) > 0);

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
        {tab === 'list' && <Segmented small value={status} options={STATUSES} onChange={(v) => { setStatus(v); setSort(null); }} />}
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading transfers between sites" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={totals} columns={TOTALS} layout={layout}
            onSite={(id) => { setSite(id); if (tab === 'site') setTab('list'); setSort(null); }}
            then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          {transitTotal.map((t, i) => (
            <div key={t.currency || i} style={{ fontSize: 12.5, color: 'var(--t3)', margin: '8px 2px' }}>
              {money(t.in_transit, t.currency)} of stock is on the road between sites at the end of the period: it has left the sender and is not yet received.
            </div>
          ))}

          {tab !== 'site' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
                <b style={{ fontSize: 14 }}>{TABS.find((x) => x.id === tab)?.label}{site ? ` at ${nameOf(site)}` : ''}</b>
                {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
                {tab === 'recharges' && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Only between sites in different legal companies (Xero organisations), at the price the site paid.</span>}
                {tab === 'kitchen' && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Fill rate is what was sent against what was ordered.</span>}
              </div>
              {tab === 'kitchen' && kitchenSelf.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <DrillTable columns={KITCHEN_SELF_COLS} rows={kitchenSelf} next={null} />
                </div>
              )}
              <DrillTable columns={cols} rows={sortLoaded(drillRows, sort, SORT_KEYS)} next={tab === 'list' ? next : null} onMore={more} busy={moreBusy} capped={capped}
                sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))}
                empty={tab === 'kitchen' ? 'No central kitchen orders in these days.' : tab === 'recharges' ? 'No recharges between legal companies in these days.' : 'No transfers in these days.'} />
            </>
          )}
          {tab === 'site' && <EmptyLine>Pick a tab, or click a site for its transfers.</EmptyLine>}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
