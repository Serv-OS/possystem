// src/backoffice/sections/reports/StockOffContract.jsx
//
// MULTI SITE STOCK, Drop 4b (v5.11.100, design 5.12): Off contract spend. Per site: spend with a
// supplier that is not one of the item's company suppliers there, spend on local items and shop
// buys, and lines above the agreed price; money and % of all spend, by supplier, by item, each line
// and the weekly trend. Every figure is stock_report_off_contract's (posted invoices, net of VAT),
// never worked out here.

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, EmptyLine } from '../stock/stockUi';
import { BarRow } from './_charts';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, dayWords, weekWords, groupRows, maxAbs, initialPick, initialSite } from '../../../lib/stock/reportView.js';
import { money } from '../../../lib/currency';

const TITLE = 'Off contract spend';
const SUB = 'Spend with suppliers that are not the item\'s company supplier at the site, local items and shop buys, and lines above the agreed price.';

const TOTALS = [
  col('spend', 'Spend', 'money'), col('off_contract', 'Off contract', 'money'), col('off_pct', 'Off contract %', 'pct'),
  col('not_contract', 'Not a contract supplier', 'money'), col('local', 'Local and shop buys', 'money'),
  col('over_agreed', 'Above the agreed price', 'money', { hint: 'the money above it' }), col('over_agreed_lines', 'Lines above', 'int'),
  col('invoices', 'Invoices', 'int'),
];
const SUPPLIER_COLS = [
  col('supplier_name', 'Supplier'), col('site', 'Site'), col('spend', 'Spend', 'money'), col('off_contract', 'Off contract', 'money'),
  col('not_contract', 'Not a contract supplier', 'money'), col('local', 'Local and shop buys', 'money'), col('over_agreed', 'Above agreed', 'money'),
];
const ITEM_COLS = [
  col('name', 'Item'), col('site', 'Site'), col('spend', 'Spend', 'money'), col('off_contract', 'Off contract', 'money'),
  col('over_agreed', 'Above agreed', 'money'), col('_why', 'Why'),
];
const LINE_COLS = [
  col('_day', 'Invoice day', 'text'), col('invoice_number', 'Invoice'), col('site', 'Site'), col('supplier_name', 'Supplier'), col('name', 'Item'),
  col('qty', 'Qty', 'qty'), col('unit_price', 'Price', 'money'), col('agreed_price', 'Agreed', 'money'), col('line_total', 'Line', 'money'),
  col('over_by', 'Above agreed', 'money'), col('_why', 'Why'),
];
const WEEK_COLS = [col('site', 'Site'), col('_week', 'Week', 'text'), col('spend', 'Spend', 'money'), col('off_contract', 'Off contract', 'money'), col('off_pct', 'Off contract %', 'pct')];
const TABS = [{ id: 'site', label: 'By site' }, { id: 'supplier', label: 'By supplier' }, { id: 'item', label: 'Top items' }, { id: 'line', label: 'Each line' }, { id: 'week', label: 'Weekly trend' }];
const WHY = { not_contract: 'Not a contract supplier', local: 'Local or shop buy', over_agreed: 'Above the agreed price', mixed: 'More than one reason' };
const SORT_KEYS = { _why: 'why', _day: 'invoice_date', _week: 'week_start' };

export default function StockOffContract({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'site'));
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [sort, setSort] = useState(null);

  const opts = { level: tab, site: site || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'off_contract', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'off_contract', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownRows = withSites(rows, meta, siteById).map((r) => ({
    ...r, _why: WHY[r.why] || r.why || '', _day: dayWords(r.invoice_date), _week: weekWords(r.week_start),
  }));
  const weekGroups = tab === 'week' ? groupRows(sortLoaded(shownRows, { key: 'week_start', dir: 'asc' }), 'location_id') : [];
  const notes = notesOf(meta);
  const cols = tab === 'supplier' ? SUPPLIER_COLS : tab === 'item' ? ITEM_COLS : tab === 'line' ? LINE_COLS : WEEK_COLS;

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading invoices against the company suppliers and agreed prices" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={totals} columns={TOTALS} layout={layout}
            onSite={(id) => { setSite(id); if (tab === 'site') setTab('supplier'); setSort(null); }}
            then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          {tab !== 'site' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
                <b style={{ fontSize: 14 }}>{TABS.find((x) => x.id === tab)?.label}{site ? ` at ${nameOf(site)}` : ''}</b>
                {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
              </div>
              {tab === 'week' && (
                <div style={{ display: 'grid', gap: 14, marginBottom: 14 }}>
                  {weekGroups.map((g) => {
                    const max = maxAbs(g.rows, 'off_contract');
                    return (
                      <div key={g.key} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 16 }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 10 }}>
                          <b style={{ fontSize: 13 }}>{nameOf(g.key)}</b><span style={{ fontSize: 12, color: 'var(--t4)' }}>off contract by week</span>
                        </div>
                        {g.rows.map((r) => <BarRow key={r.week_start} label={r._week} value={Number(r.off_contract) || 0} max={max} format={(v) => money(v, r.currency)} />)}
                      </div>
                    );
                  })}
                </div>
              )}
              <DrillTable columns={cols} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped}
                sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} empty="No off contract spend in these days." />
            </>
          )}
          {tab === 'site' && <EmptyLine>Pick a tab for the split, or click a site for its suppliers.</EmptyLine>}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
