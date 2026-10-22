// src/backoffice/sections/reports/StockPurchases.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Purchases. Ordered, received and invoiced
// side by side per site; the supplier by site grid; by category; the weekly trend; each order. Net
// or with VAT. Supplier reliability: on time %, short %. 'Sent unapproved and substitutions come with
// the purchasing update'. Purchases are the delivery value until the purchasing update (the database
// says so in meta.notes). Every figure is stock_report_purchases's.

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, Segmented, EmptyLine } from '../stock/stockUi';
import { BarRow } from './_charts';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, dayWords, weekWords, whenAt, groupRows, maxAbs, initialPick, initialSite, LATER_WORDS } from '../../../lib/stock/reportView.js';
import { money } from '../../../lib/currency';

const TITLE = 'Purchases';
const SUB = 'Ordered, received and invoiced side by side per site; spend by supplier and site; supplier reliability.';

const TOTALS = [
  col('ordered', 'Ordered', 'money', { hint: 'sent orders, by order day' }), col('received', 'Received', 'money', { hint: 'delivery value' }),
  col('invoiced', 'Invoiced', 'money', { hint: 'posted invoices' }), col('on_time_pct', 'On time', 'pct'), col('short_pct', 'Short', 'pct'),
  col('_unapproved', 'Sent unapproved', 'text'), col('_subs', 'Substitutions', 'text'),
];
const SUPPLIER_COLS = [col('supplier_name', 'Supplier'), col('site', 'Site'), col('ordered', 'Ordered', 'money'), col('received', 'Received', 'money'), col('invoiced', 'Invoiced', 'money')];
const CATEGORY_COLS = [col('site', 'Site'), col('name', 'Category'), col('ordered', 'Ordered', 'money'), col('received', 'Received', 'money'), col('invoiced', 'Invoiced', 'money')];
const WEEK_COLS = [col('site', 'Site'), col('_week', 'Week', 'text'), col('ordered', 'Ordered', 'money'), col('received', 'Received', 'money'), col('invoiced', 'Invoiced', 'money')];
const ORDER_COLS = [
  col('reference', 'Order'), col('supplier_name', 'Supplier'), col('site', 'Site'), col('status', 'Status'), col('_ordered_at', 'Ordered', 'text'),
  col('_expected', 'Expected', 'text'), col('_received_at', 'Received', 'text'), col('subtotal', 'Net', 'money'), col('tax', 'VAT', 'money'), col('_invoiced', 'Invoice', 'text'),
];
const TABS = [{ id: 'site', label: 'By site' }, { id: 'supplier', label: 'Supplier by site' }, { id: 'category', label: 'By category' }, { id: 'week', label: 'Weekly trend' }, { id: 'order', label: 'Orders' }];
const VAT = [{ value: 'net', label: 'Net' }, { value: 'gross', label: 'With VAT' }];
const SORT_KEYS = { _week: 'week_start', _ordered_at: 'ordered_at', _expected: 'expected_date', _received_at: 'received_at', _invoiced: 'invoice_id' };
const OWN_LINE = 'Sent unapproved and substitutions come with the purchasing update';

/** Supplier rows (one per supplier and site) become one row per supplier with a received cell per site and the sum. */
function supplierGrid(rows, siteIds, nameOf) {
  const bySupplier = new Map();
  const ids = [...new Set([...(siteIds || []), ...rows.map((r) => r.location_id).filter((x) => x != null)])];
  for (const r of rows) {
    const k = r.supplier_name || 'No supplier';
    if (!bySupplier.has(k)) bySupplier.set(k, { supplier_name: k, ordered: 0, received: 0, invoiced: 0, currency: r.currency });
    const s = bySupplier.get(k);
    s.ordered += Number(r.ordered) || 0;
    s.received += Number(r.received) || 0;
    s.invoiced += Number(r.invoiced) || 0;
    if (r.location_id != null) s[`site:${r.location_id}`] = (s[`site:${r.location_id}`] || 0) + (Number(r.received) || 0);
    if (s.currency !== r.currency) s.currency = undefined;
  }
  const columns = [col('supplier_name', 'Supplier'), ...ids.map((id) => col(`site:${id}`, nameOf(id), 'money')), col('received', 'Received, all sites', 'money'), col('ordered', 'Ordered', 'money'), col('invoiced', 'Invoiced', 'money')];
  const out = [...bySupplier.values()].sort((a, b) => b.received - a.received);
  for (const row of out) for (const id of ids) if (!(`site:${id}` in row)) row[`site:${id}`] = null;
  return { columns, rows: out };
}

export default function StockPurchases({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'site'));
  const [vat, setVat] = useState(() => initialPick(initialOpts, 'vat', ['net', 'gross'], 'net'));
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [sort, setSort] = useState(null);

  const level = tab;
  const opts = { level, site: site || undefined, vat };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'purchases', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'purchases', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownTotals = (totals || []).map((t) => ({ ...t, _unapproved: t.sent_unapproved == null ? LATER_WORDS.purchasing : String(t.sent_unapproved), _subs: t.substitutions == null ? LATER_WORDS.purchasing : String(t.substitutions) }));
  const base = withSites(rows, meta, siteById);
  const shownRows = base.map((r) => ({
    ...r,
    _week: weekWords(r.week_start),
    _ordered_at: whenAt(meta, r.location_id, r.ordered_at),
    _expected: dayWords(r.expected_date),
    _received_at: whenAt(meta, r.location_id, r.received_at),
    _invoiced: r.invoice_id ? 'Invoiced' : 'Not yet',
  }));
  const oneCurrency = !meta?.mixed_currency;
  const grid = tab === 'supplier' && oneCurrency ? supplierGrid(base, site ? [site] : sites, nameOf) : null;
  // The trend reads each site's weeks oldest first, whatever order the table is sorted in.
  const weekGroups = tab === 'week' ? groupRows(sortLoaded(shownRows, { key: 'week_start', dir: 'asc' }), 'location_id') : [];
  const notes = notesOf(meta, [OWN_LINE]);
  const cols = tab === 'supplier' ? (grid ? grid.columns : SUPPLIER_COLS) : tab === 'category' ? CATEGORY_COLS : tab === 'week' ? WEEK_COLS : ORDER_COLS;
  const drillRows = grid ? grid.rows : shownRows;

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
        <Segmented small value={vat} options={VAT} onChange={setVat} />
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading orders, deliveries and invoices" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={shownTotals} columns={TOTALS} layout={layout} onSite={(id) => { setSite(id); if (tab === 'site') setTab('supplier'); setSort(null); }} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          <div style={{ display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--t3)', margin: '8px 2px' }}>
            <div>{OWN_LINE}.</div>
          </div>

          {tab !== 'site' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
                <b style={{ fontSize: 14 }}>{TABS.find((x) => x.id === tab)?.label}{site ? ` at ${nameOf(site)}` : ''}</b>
                {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
                {tab === 'supplier' && !oneCurrency && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Shown per currency: the grid adds sites of one currency only, so each row is listed instead.</span>}
                {tab === 'supplier' && grid && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Received value per site; a company supplier first, else the site's own.</span>}
              </div>
              {tab === 'week' && (
                <div style={{ display: 'grid', gap: 14, marginBottom: 14 }}>
                  {weekGroups.map((g) => {
                    const max = maxAbs(g.rows, 'received');
                    return (
                      <div key={g.key} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 16 }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 10 }}>
                          <b style={{ fontSize: 13 }}>{nameOf(g.key)}</b><span style={{ fontSize: 12, color: 'var(--t4)' }}>received by week</span>
                        </div>
                        {g.rows.map((r) => <BarRow key={r.week_start} label={r._week} value={Number(r.received) || 0} max={max} format={(v) => money(v, r.currency)} />)}
                      </div>
                    );
                  })}
                </div>
              )}
              <DrillTable columns={cols} rows={sortLoaded(drillRows, sort, SORT_KEYS)} next={grid ? null : next} onMore={more} busy={moreBusy} capped={grid ? false : capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
            </>
          )}
          {tab === 'site' && <EmptyLine>Pick a tab for the split, or click a site for its suppliers.</EmptyLine>}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
