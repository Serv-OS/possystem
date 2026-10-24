// src/backoffice/sections/reports/StockCountCompliance.jsx
//
// MULTI SITE STOCK, Drop 4b (v5.11.100, design 5.15): Count compliance. Per site: counts due from the
// count plans, done on time, late, missed; the last full count; lines counted against estimated; the
// time a count took; variance at approval; second approvals. A calendar marks each site's plan days
// (done, late, missed, due) on its own business day, and each approved count is listed with who
// approved it. Every figure is stock_report_count_compliance's.

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, EmptyLine, TableWrap, Th, Td } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, whenAt, dayWords, daysOfRange, initialPick, initialSite } from '../../../lib/stock/reportView.js';

const TITLE = 'Count compliance';
const SUB = 'Counts due from the count plans, done on time, late or missed; lines counted against estimated; time taken, variance and second approvals.';

const TOTALS = [
  col('due', 'Due', 'int'), col('on_time', 'On time', 'int'), col('late', 'Late', 'int'), col('missed', 'Missed', 'int'), col('waiting', 'Due today', 'int'),
  col('last_full_words', 'Last full count'), col('counts', 'Counts approved', 'int'), col('lines_counted', 'Lines counted', 'int'),
  col('lines_estimated', 'Lines estimated', 'int'), col('counted_pct', 'Counted', 'pct'), col('minutes_avg', 'Minutes a count', 'qty'),
  col('variance_value', 'Variance at approval', 'money'), col('second_approvals', 'Second approvals', 'int'),
];
const COUNT_COLS = [
  col('name', 'Count'), col('site', 'Site'), col('_type', 'Type'), col('plan_name', 'Plan'), col('_started', 'Started', 'text'),
  col('_approved', 'Approved', 'text'), col('approved_by_name', 'Approved by'), col('minutes', 'Minutes', 'qty'), col('lines', 'Lines', 'int'),
  col('counted', 'Counted', 'int'), col('estimated', 'Estimated', 'int'), col('variance_value', 'Variance', 'money'),
  col('second_approved_by_name', 'Second approval'),
];
const CAL_COLS = [col('_day', 'Day', 'text'), col('site', 'Site'), col('plan_name', 'Plan'), col('_status', 'Status')];
const TABS = [{ id: 'site', label: 'By site' }, { id: 'calendar', label: 'Calendar' }, { id: 'count', label: 'Counts' }];
const TYPE_WORDS = { FULL: 'Full', PARTIAL: 'Part', SPOT: 'Spot', AREA: 'Area', SUPPLIER: 'Supplier' };
const STATUS = {
  done: { words: 'On time', bg: 'var(--grn-bg, rgba(22,163,74,.16))', fg: 'var(--grn, #16a34a)' },
  late: { words: 'Late', bg: 'var(--amber-bg, rgba(245,166,35,.18))', fg: 'var(--amber, #b7791f)' },
  missed: { words: 'Missed', bg: 'var(--red-bg, rgba(220,38,38,.14))', fg: 'var(--red)' },
  due: { words: 'Due', bg: 'var(--bg3)', fg: 'var(--t2)' },
};
const RANK = { missed: 4, late: 3, due: 2, done: 1 };
const SORT_KEYS = { _type: 'count_type', _started: 'started_at', _approved: 'approved_at', _day: 'day', _status: 'status' };

/** The worst status of the plan days in one cell (missed over late over due over done). */
function worst(list) {
  return (list || []).reduce((w, r) => ((RANK[r.status] || 0) > (RANK[w] || 0) ? r.status : w), null);
}

/** Sites down, days across: each cell coloured by that day's worst plan status, blank when nothing was due. */
function CountCalendar({ rows, siteIds, from, to, nameOf }) {
  const days = daysOfRange(from, to, 62);
  const byCell = new Map();
  for (const r of rows || []) {
    const k = `${r.location_id}|${String(r.day).slice(0, 10)}`;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(r);
  }
  const ids = [...new Set([...(siteIds || []), ...(rows || []).map((r) => r.location_id).filter(Boolean)])];
  if (!days.length) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <TableWrap minWidth={Math.max(600, 160 + days.length * 34)}>
        <thead>
          <tr>
            <Th sticky>Site</Th>
            {days.map((d) => <Th key={d} right>{dayWords(d).replace(/^\w+ /, '')}</Th>)}
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => (
            <tr key={id}>
              <Td sticky strong>{nameOf(id)}</Td>
              {days.map((d) => {
                const list = byCell.get(`${id}|${d}`) || [];
                const s = STATUS[worst(list)] || null;
                return (
                  <Td key={d} right>
                    {s ? (
                      <span title={`${dayWords(d)}: ${list.map((r) => `${r.plan_name || 'Count'} ${STATUS[r.status]?.words || r.status}`).join(', ')}`}
                        style={{ display: 'inline-block', minWidth: 22, padding: '2px 4px', borderRadius: 6, background: s.bg, color: s.fg, fontSize: 11, fontWeight: 700, textAlign: 'center' }}>
                        {s.words.charAt(0)}
                      </span>
                    ) : <span style={{ color: 'var(--t4)' }}>{'·'}</span>}
                  </Td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </TableWrap>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--t3)', marginTop: 8 }}>
        {Object.entries(STATUS).map(([k, s]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 18, padding: '1px 0', borderRadius: 5, background: s.bg, color: s.fg, fontSize: 11, fontWeight: 700, textAlign: 'center' }}>{s.words.charAt(0)}</span>
            {s.words}
          </span>
        ))}
        {days.length >= 62 && <span>The calendar shows the first 62 days.</span>}
      </div>
    </div>
  );
}

export default function StockCountCompliance({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'site'));
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));
  const [sort, setSort] = useState(null);

  const opts = { level: tab, site: site || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'count_compliance', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'count_compliance', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  // Missed counts read red and late ones amber (the screen's colour: count compliance has no target).
  const shownTotals = (totals || []).map((t) => ({ ...t, rag: { missed: Number(t.missed) > 0 ? 'red' : null, late: Number(t.late) > 0 ? 'amber' : null } }));
  const shownRows = withSites(rows, meta, siteById).map((r) => ({
    ...r,
    _type: TYPE_WORDS[r.count_type] || r.count_type || '',
    _started: whenAt(meta, r.location_id, r.started_at),
    _approved: whenAt(meta, r.location_id, r.approved_at),
    _day: dayWords(r.day),
    _status: STATUS[r.status]?.words || r.status || '',
  }));
  const notes = notesOf(meta);
  const calendarSites = site ? [site] : sites;

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading count plans and counts" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={shownTotals} columns={TOTALS} layout={layout} rag={{ missed: 'missed', late: 'late' }}
            onSite={(id) => { setSite(id); if (tab === 'site') setTab('calendar'); setSort(null); }}
            then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          {tab !== 'site' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
                <b style={{ fontSize: 14 }}>{TABS.find((x) => x.id === tab)?.label}{site ? ` at ${nameOf(site)}` : ''}</b>
                {site && <Btn kind="link" small onClick={() => { setSite(null); setSort(null); }}>Every site</Btn>}
                {tab === 'calendar' && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Each site's plan days on its own business day.</span>}
              </div>
              {tab === 'calendar' && <CountCalendar rows={shownRows} siteIds={calendarSites} from={range.fromDay} to={range.toDay} nameOf={nameOf} />}
              <DrillTable columns={tab === 'calendar' ? CAL_COLS : COUNT_COLS} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped}
                sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} empty={tab === 'calendar' ? 'No count plan days in these days.' : 'No counts approved in these days.'} />
            </>
          )}
          {tab === 'site' && <EmptyLine>Click a site, or pick Calendar or Counts.</EmptyLine>}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
