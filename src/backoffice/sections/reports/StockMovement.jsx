// src/backoffice/sections/reports/StockMovement.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Stock movement (reconciliation). One row
// per site: Opening | Received | From central kitchen | Transfers in | Made | Sold (theoretical) |
// Used in batches | Transfers out | Wasted | Revalued | Count adjustment | Expected closing | Counted
// closing | Gap. Between two counts is the default. Drill to the items at one site, then the deep
// dive: every movement with its document. Every figure is stock_report_movement's (the ledger day
// totals); 'Counted' or 'Estimated (ledger)' under Opening and Closing from the site's window.

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { Btn, Segmented, EmptyLine } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, metaSite, crumbsFor, toggleSort, sortLoaded, notesOf, overrideValue, documentWords, whenWords, initialPick, initialSite, LATER_WORDS } from '../../../lib/stock/reportView.js';

const TITLE = 'Stock movement';
const SUB = 'Opening to closing at every site, between two counts by default. Expected closing = opening + received + transfers in + made + revalued, less sold, used in batches, transfers out and waste. Gap = counted closing less expected.';

const MOVE_COLS = [
  col('opening_value', 'Opening', 'money'),
  col('received', 'Received', 'money'), col('from_kitchen', 'From central kitchen', 'money', { hint: LATER_WORDS.purchasing }),
  col('transfers_in', 'Transfers in', 'money'), col('made', 'Made', 'money'), col('sold_cost', 'Sold (theoretical)', 'money'),
  col('used_in_batches', 'Used in batches', 'money'), col('transfers_out', 'Transfers out', 'money'), col('waste_value', 'Wasted', 'money'),
  col('revalue', 'Revalued', 'money'), col('count_adj', 'Count adjustment', 'money'), col('expected_closing', 'Expected closing', 'money'),
  col('closing_value', 'Counted closing', 'money'), col('gap', 'Gap', 'money'),
];
const ITEM_COLS = [col('name', 'Item'), ...MOVE_COLS.filter((c) => !c.key.startsWith('_'))];
const DEEP_COLS = [
  col('_when', 'When', 'when'), col('business_day', 'Business day', 'day'), col('movement_type', 'Movement'), col('source_type', 'From'),
  col('qty_base', 'Quantity', 'qty'), col('unit_cost', 'Unit cost', 'money'), col('value_delta', 'Value', 'money'), col('_document', 'Document'), col('notes', 'Notes'),
];
const MODES = [{ value: true, label: 'Between two counts' }, { value: false, label: 'The period days' }];
const SORT_KEYS = { _when: 'occurred_at', _document: 'movement_type' };

export default function StockMovement({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const rangeKey = `${range.fromDay}:${range.toDay}:${range.betweenCounts ? 1 : 0}`;
  const [modePick, setModePick] = useState(() => {
    const b = initialPick(initialOpts, 'between_counts', [true, false], null);
    return b == null ? null : { key: rangeKey, value: b };
  });
  // A league click or a share link may open one site's items, or one item's movements.
  const [drill, setDrill] = useState(() => {
    const site = initialSite(initialOpts, sites);
    const item = site ? initialPick(initialOpts, 'item_id', null, null) : null;
    return { level: item ? 'movement' : site ? 'item' : 'site', site, item_id: item, item_name: null };
  });
  const [sort, setSort] = useState(null);

  // Between two counts is this screen's default (contract 3.4); the switch shows the period days instead.
  const between = overrideValue(modePick, rangeKey, true);
  const level = drill.level;
  const opts = { between_counts: between, level, site: drill.site || undefined, item_id: drill.item_id || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'movement', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'movement', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownTotals = totals || [];
  const shownRows = withSites(rows, meta, siteById);
  const tz = drill.site ? metaSite(meta, drill.site)?.timezone : undefined;
  const deepRows = level === 'movement' ? shownRows.map((r) => ({ ...r, _when: whenWords(r.occurred_at, tz), _document: documentWords(r.document) })) : null;
  const crumbs = crumbsFor(drill, nameOf);
  const goTo = (id) => {
    if (id === 'company') setDrill({ level: 'site', site: null, item_id: null, item_name: null });
    else if (id === 'site') setDrill((d) => ({ level: 'item', site: d.site, item_id: null, item_name: null }));
    setSort(null);
  };
  const openSite = (id) => { setDrill({ level: 'item', site: id, item_id: null, item_name: null }); setSort(null); };
  const openItem = (row) => { setDrill((d) => ({ level: 'movement', site: row.location_id || d.site, item_id: row.company_item_id, item_name: row.name })); setSort(null); };
  const notes = notesOf(meta);

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <Segmented small value={between} options={MODES} onChange={(v) => { setModePick({ key: rangeKey, value: v }); setSort(null); }} />
        <span style={{ fontSize: 12, color: 'var(--t4)' }}>{between ? 'Each site: its latest two full approved counts up to the period end.' : 'Opening and closing from the ledger at the period ends.'}</span>
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading the movement day totals" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={shownTotals} columns={MOVE_COLS} layout={layout} onSite={openSite} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
            {crumbs.map((c, i) => (
              <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {i > 0 && <span style={{ color: 'var(--t4)' }}>/</span>}
                {i < crumbs.length - 1 ? <Btn kind="link" small onClick={() => goTo(c.id)}>{c.label}</Btn> : <b style={{ fontSize: 13 }}>{c.label}</b>}
              </span>
            ))}
            <span style={{ fontSize: 12, color: 'var(--t4)' }}>
              {level === 'site' ? 'Click a site for its items' : level === 'item' ? 'Click an item for every movement and its document' : 'Every movement in the window, oldest first'}
            </span>
          </div>

          {level === 'site' && <EmptyLine>Pick a site above to see its items, biggest gap first.</EmptyLine>}
          {level === 'item' && (
            <DrillTable columns={ITEM_COLS} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} onRow={openItem} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
          )}
          {level === 'movement' && (
            <DrillTable columns={DEEP_COLS} rows={sortLoaded(deepRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
          )}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
