// src/backoffice/sections/reports/StockBudget.jsx
//
// MULTI SITE STOCK, Drop 4b (v5.11.100, design 5.13): Purchase budget. Per site and week: the budget
// (fixed, or a percent of the forecast), what was ordered (the Order pad rule: sent orders and their
// delivery fee, by the day they were ordered), % used, what is left, and net sales after refunds
// (the Daily trading rule). Red when over. Every figure is stock_report_budget's.

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, EmptyLine, Pill } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, weekWords, groupRows, initialPick, initialSite, fmtPct } from '../../../lib/stock/reportView.js';
import { money } from '../../../lib/currency';

const TITLE = 'Purchase budget';
const SUB = 'Per site and week: the budget, what was ordered, % used and what is left, beside net sales. Red when over.';

const TOTALS = [
  col('budget', 'Budget', 'money'), col('spent', 'Ordered', 'money', { hint: 'sent orders and delivery fees' }), col('pct_used', 'Used', 'pct'),
  col('left', 'Left', 'money'), col('forecast', 'Forecast sales', 'money'), col('sales_net', 'Net sales', 'money', { hint: 'after refunds' }),
  col('spent_pct_sales', 'Ordered % of sales', 'pct'), col('_rule', 'Budget rule'),
];
const WEEK_COLS = [
  col('site', 'Site'), col('_week', 'Week', 'text'), col('days', 'Days', 'int'), col('budget', 'Budget', 'money'), col('spent', 'Ordered', 'money'),
  col('pct_used', 'Used', 'pct'), col('left', 'Left', 'money'), col('_over', 'Over', 'text'), col('forecast', 'Forecast sales', 'money'), col('sales_net', 'Net sales', 'money'),
];
const TABS = [{ id: 'site', label: 'By site' }, { id: 'week', label: 'By week' }];
const RULE_WORDS = { fixed: 'Fixed a week', pct_of_forecast: 'Percent of forecast' };
const SORT_KEYS = { _week: 'week_start', _over: 'over', _rule: 'rule' };

/** One week's bar: what was ordered against the budget, red when over. */
function BudgetBar({ row }) {
  const budget = Number(row.budget);
  const spent = Number(row.spent) || 0;
  const has = Number.isFinite(budget) && row.budget != null && budget > 0;
  const width = has ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  const over = row.over === true || (has && spent > budget);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 190px', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
      <span style={{ color: 'var(--t2)' }}>{weekWords(row.week_start)}</span>
      <div style={{ height: 10, borderRadius: 6, background: 'var(--bg3)', overflow: 'hidden' }}>
        {has && <div style={{ width: `${width}%`, height: '100%', background: over ? 'var(--red)' : 'var(--acc)' }} />}
      </div>
      <span style={{ textAlign: 'right', color: over ? 'var(--red)' : 'var(--t2)', fontVariantNumeric: 'tabular-nums' }}>
        {has ? `${money(spent, row.currency)} of ${money(budget, row.currency)}` : `${money(spent, row.currency)}, no budget`}
      </span>
    </div>
  );
}

export default function StockBudget({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'site'));
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [sort, setSort] = useState(null);

  const opts = { level: tab, site: site || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'budget', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'budget', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  // A site over its budget gets the red colour on Used even when the server sent no rag for it.
  const shownTotals = (totals || []).map((t) => ({
    ...t, _rule: RULE_WORDS[t.rule] || (t.location_id != null && t.budget == null ? 'No budget set' : ''),
    rag: { ...(t.rag || {}), budget_pct: (t.rag && t.rag.budget_pct) || (t.over === true ? 'red' : null) },
  }));
  const shownRows = withSites(rows, meta, siteById).map((r) => ({ ...r, _week: weekWords(r.week_start), _over: r.over === true ? 'Over' : '' }));
  const weekGroups = tab === 'week' ? groupRows(sortLoaded(shownRows, { key: 'week_start', dir: 'asc' }), 'location_id') : [];
  const notes = notesOf(meta);
  const overSites = shownTotals.filter((t) => t.location_id != null && t.over === true);

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading budgets, orders and sales" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={shownTotals} columns={TOTALS} layout={layout} rag={{ pct_used: 'budget_pct' }}
            onSite={(id) => { setSite(id); setTab('week'); setSort(null); }} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          {overSites.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '10px 2px' }}>
              <Pill tone="bad">Over budget</Pill>
              <span style={{ fontSize: 12.5, color: 'var(--t2)' }}>
                {overSites.map((t) => `${t.site || nameOf(t.location_id)} (${fmtPct(t.pct_used, 0) || 'over'})`).join(', ')}
              </span>
            </div>
          )}

          {tab === 'week' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
                <b style={{ fontSize: 14 }}>By week{site ? ` at ${nameOf(site)}` : ''}</b>
                {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
                <span style={{ fontSize: 12, color: 'var(--t4)' }}>A part week at the edge of the period is pro rata by days.</span>
              </div>
              <div style={{ display: 'grid', gap: 14, marginBottom: 14 }}>
                {weekGroups.map((g) => (
                  <div key={g.key} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 16, display: 'grid', gap: 8 }}>
                    <b style={{ fontSize: 13 }}>{nameOf(g.key)}</b>
                    {g.rows.map((r) => <BudgetBar key={r.week_start} row={r} />)}
                  </div>
                ))}
              </div>
              <DrillTable columns={WEEK_COLS} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped}
                sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} empty="No weeks in these days." />
            </>
          )}
          {tab === 'site' && <EmptyLine>Click a site, or pick By week, for each week against its budget.</EmptyLine>}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
