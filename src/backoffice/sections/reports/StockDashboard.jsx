// src/backoffice/sections/reports/StockDashboard.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.2, map 8.5, design 5.3, the mockup scrReport): the head office
// dashboard, the first page of Back Office > Reports > Stock and GP for a multi site company.
//
// One call: stock_report_dashboard through useStockReport (page one plus the compare call). The
// answer's totals are site rows then one company row per currency; rows carry the league, GP by
// type, the key item ratios and the attention rows. Every figure is the server's, from the stored
// day totals on each venue's own business day: nothing here adds two currencies (a block of cards
// per currency), works a GP out, or paints a zero before the answer lands.
//
// Pieces: the cards (the mockup kpi), a GP or cost of sales switch, the key item tiles, the site
// league (Side by side) or the company rows per currency (Company total), Needs attention with Fix
// (level all), GP by type, the All 20 reports grid, the rules line. The Targets panel opens from the
// Targets button (read only below level all). The top bar controls (sites, period, compare, layout,
// Export, Share) are BOReports' and StockReportFrame's; this screen fills the frame.

import { useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { CATEGORIES } from './Catalog';
import { LATER_WORDS } from '../../../lib/stock/reportLink';
import { SegToggle, Callout } from './reportKit';
import { StockReportFrame, SiteTotalsTable, CompareDelta, NeedsUpdateLine, useStockReport, exportCsvNow } from './_stockKit';
import { Btn, Pill, TableWrap, Th, Td, ErrorLine, EmptyLine, ui } from '../stock/stockUi';
import { stockApi } from '../../../lib/stock/stockApi';
import StockKeyItemTiles from './StockKeyItemTiles';
import StockSiteLeague from './StockSiteLeague';
import StockTargetsPanel from './StockTargetsPanel';
import {
  RULES_LINE, DEMO_LINE, DEMO_SALES_LINE, NOT_SHOWN, PER_CURRENCY_LINE, REPORTS_NOTE, BY_TYPE_ACTUAL_NOTE, GP_MODES,
  cardBlocks, compareRowFor, compareTotalsOf, dashboardArgs, subLine, scopeWords, periodWords,
  groupAttention, attentionSitesWords, byTypeRows, reportGrid, wholeMoney, pctText, siteNameOf,
} from '../../../lib/stock/dashboardRules';

const cardsGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 16 };
// The cards wear _charts StatTile's look (label, mono figure, line under), drawn here because a card
// also carries a red, amber or green pill and opens the report behind its figure.
const kpi = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, textAlign: 'left', fontFamily: 'inherit', color: 'var(--t1)' };
const kpiLabel = { fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.08em' };
const kpiValue = { fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-.02em', lineHeight: 1.1 };
const kpiLine = { fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };
const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, minWidth: 0 };
const cardHead = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--bdr)' };
const cardTitle = { margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--t1)' };
const note = { fontSize: 12.5, color: 'var(--t3)' };
const two = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginBottom: 16 };
const rgrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8, padding: 14 };
const rbtn = { textAlign: 'left', border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t1)', borderRadius: 8, padding: '9px 11px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600 };
const rsmall = { display: 'block', color: 'var(--t3)', fontSize: 11.5, marginTop: 2, fontWeight: 400, whiteSpace: 'normal' };

/** The company total table colours its cells from the row's rag: { column key: rag metric }. */
const TOTALS_RAG = Object.freeze({ gp_pct_actual: 'gp_pct', gap_pct: 'gap_pct', waste_pct: 'waste_pct', comps_pct: 'comps_pct', days_on_hand: 'days_on_hand' });

/**
 * Props (contract 2.3 stockProps): orgId, sites (the ticked site ids), siteById (Map), groups, range
 * ({ fromDay, toDay, betweenCounts }), compare ({ from, to, label } | null), layout ('side' |
 * 'total'), level (the stock level), canFix (level all), onOpenReport(viewId, opts, sites),
 * onSites(ids) (a site click: the same dashboard for that one site), onShare, api (stockReportsApi).
 * The dashboard is not a background export (stock_report_export_start does not take it): its Export
 * is the on screen CSV of the totals, every column of meta.columns, site rows then company rows.
 */
export default function StockDashboard({
  orgId, sites, siteById, groups = [], range, compare = null, layout = 'side', level = 'sites', canFix = false,
  onOpenReport, onSites, onShare, api,
}) {
  const showToast = useStore((s) => s.showToast);
  const [mode, setMode] = useState('gp');
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [fixing, setFixing] = useState({});   // { [location_id]: 'busy' | 'done' }

  // The call's args on primitives, so a parent re render with the same sites and days asks nothing again.
  const siteKey = (sites || []).filter(Boolean).join(',');
  const fromDay = range?.fromDay || null;
  const toDay = range?.toDay || null;
  const between = range?.betweenCounts === true;
  const cFrom = compare?.from || null;
  const cTo = compare?.to || null;
  const cLabel = compare?.label || '';
  const args = useMemo(
    () => dashboardArgs({
      orgId, sites: siteKey ? siteKey.split(',') : [], range: { fromDay, toDay, betweenCounts: between },
      compare: cFrom || cTo ? { from: cFrom, to: cTo, label: cLabel } : null,
    }),
    [orgId, siteKey, fromDay, toDay, between, cFrom, cTo, cLabel],
  );
  const report = useStockReport(api, 'dashboard', args);
  const { meta = null, totals = null, rows = null, loading = false, error = null, needsUpdate = false, thenLoaded = false } = report || {};

  const canEditTargets = level === 'all';
  const scope = scopeWords(sites, siteById, groups);
  const sub = subLine({ scope, period: periodWords(range), compare });
  const blocks = cardBlocks(totals, { mode });
  const thenTotals = compareTotalsOf(report);
  const demo = meta?.demo_left_out === true;
  const mixed = meta?.mixed_currency === true || blocks.length > 1;
  const grid = useMemo(() => reportGrid(CATEGORIES, LATER_WORDS), []);
  const league = Array.isArray(rows?.league) ? rows.league : [];
  const attention = groupAttention(rows?.attention);
  const byType = byTypeRows(rows?.by_type);
  const oneCurrency = Array.isArray(meta?.currencies) && meta.currencies.length === 1 ? meta.currencies[0] : (blocks.length === 1 ? blocks[0].currency : null);
  const ready = !!totals && !loading;

  // A card or tile opens the report behind it over the same sites; a league number opens it for
  // that row's site; a site name gives the same dashboard for that one site.
  const open = (viewId, opts = null, siteIds = null) => onOpenReport?.(viewId, opts && typeof opts === 'object' ? opts : null, siteIds);
  const openSite = (locationId) => {
    if (!locationId) return;
    if (onSites) onSites([locationId]);
    else open('stock_home', null, [locationId]);
  };
  const exportNow = ready && Array.isArray(totals) && totals.length ? () => exportCsvNow('dashboard', meta, totals, []) : null;

  const fix = async (s) => {
    if (!s?.location_id) return;
    setFixing((f) => ({ ...f, [s.location_id]: 'busy' }));
    const r = await stockApi.resyncSite(s.location_id);
    if (r.error) {
      setFixing((f) => ({ ...f, [s.location_id]: null }));
      showToast?.(r.error.message || 'It did not start. Try again.', 'error');
      return;
    }
    setFixing((f) => ({ ...f, [s.location_id]: 'done' }));
    showToast?.(`${s.site || siteNameOf(siteById, s.location_id)} catching up. The site matches its company records within a minute.`, 'success');
  };

  return (
    <>
      <StockReportFrame title="Stock and GP" sub={sub} meta={meta} onExport={exportNow} onShare={onShare ? () => onShare() : null}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <SegToggle value={mode} onChange={setMode} options={GP_MODES} />
          <span style={note}>{mode === 'gp' ? 'GP % on the cards' : 'Cost of sales % on the cards'}</span>
          <span style={{ flex: 1 }} />
          <Btn kind="soft" small onClick={() => setTargetsOpen(true)} title={canEditTargets ? 'Targets and key items' : 'Targets and key items, read only'}>
            {canEditTargets ? 'Targets' : 'Targets (read only)'}
          </Btn>
        </div>

        {needsUpdate && <NeedsUpdateLine />}
        {error && !needsUpdate && <ErrorLine error={error} />}
        {!totals && loading && <EmptyLine>Loading the dashboard: every site on its own business day{'…'}</EmptyLine>}
        {!totals && !loading && !error && !needsUpdate && <EmptyLine>Pick the sites and a period to see the dashboard.</EmptyLine>}
        {ready && !blocks.length && !error && <EmptyLine>No company total came back for these sites.</EmptyLine>}

        {!!totals && (
          <>
            {blocks.map((b) => {
              const then = compareRowFor(thenTotals, b.currency);
              return (
                <section key={b.currency || 'one'} aria-label={`Cards${b.currency ? ` in ${b.currency}` : ''}`}>
                  {mixed && (
                    <div style={{ ...note, marginBottom: 6 }}>
                      <b style={{ color: 'var(--t1)' }}>{b.currency || 'No currency'}</b> {'·'} {PER_CURRENCY_LINE}
                    </div>
                  )}
                  <div style={cardsGrid}>
                    {b.cards.map((c) => (
                      <Card key={c.key} card={c} nowRow={b.row} thenRow={thenLoaded ? then : null} compare={compare} onOpen={c.report ? () => open(c.report) : null} />
                    ))}
                  </div>
                </section>
              );
            })}

            <StockKeyItemTiles keyItems={rows?.key_items} onOpenReport={open} onOpenTargets={() => setTargetsOpen(true)} canEdit={canEditTargets} />

            {layout === 'total'
              ? (
                <div style={{ marginBottom: 16 }}>
                  <SiteTotalsTable meta={meta} totals={totals} columns={meta?.columns || []} layout="total" rag={TOTALS_RAG} onSite={openSite}
                    then={thenLoaded ? thenTotals : null} thenLoaded={thenLoaded} compare={compare} />
                </div>
              )
              : <StockSiteLeague rows={league} onSite={openSite} onCell={(reportId, row) => open(reportId, null, row.location_id ? [row.location_id] : null)} />}

            <div style={two}>
              <div style={card} data-testid="stock-attention">
                <div style={cardHead}>
                  <h3 style={cardTitle}>Needs attention</h3>
                  <span style={note}>{attention.length ? `${attention.reduce((a, g) => a + g.count, 0).toLocaleString('en-GB')} things to look at` : 'Nothing waiting'}</span>
                </div>
                <div style={{ padding: '6px 16px 12px' }}>
                  {!attention.length && <EmptyLine>Nothing needs attention in this scope.</EmptyLine>}
                  {attention.map((g) => (
                    <div key={g.kind} style={{ padding: '9px 0', borderBottom: '1px solid var(--bdr)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {g.report
                          ? <button type="button" onClick={() => open(g.report, g.opts)} style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700, color: 'var(--acc)', cursor: 'pointer' }}>{g.label}</button>
                          : <span style={{ fontWeight: 700, color: 'var(--t1)' }}>{g.label}</span>}
                        <Pill tone={g.kind === 'demo_history' ? 'neutral' : 'warn'}>{g.count.toLocaleString('en-GB')}</Pill>
                        <span style={{ ...note, flex: 1 }}>{attentionSitesWords(g.sites)}</span>
                      </div>
                      {g.fixable && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                          {g.sites.map((s) => {
                            const st = fixing[s.location_id];
                            return (
                              <span key={s.location_id || s.site} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                                <span style={{ color: 'var(--t2)' }}>{s.site}</span>
                                {st === 'done'
                                  ? <Pill tone="neutral">{`${s.site} catching up`}</Pill>
                                  : canFix
                                    ? <Btn kind="soft" small disabled={st === 'busy'} onClick={() => fix(s)}>{st === 'busy' ? 'Starting…' : 'Fix'}</Btn>
                                    : <span style={ui.grey}>Fix needs Stock control All sites</span>}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div style={card} data-testid="stock-gp-by-type">
                <div style={cardHead}>
                  <h3 style={cardTitle}>GP by type</h3>
                  <span style={note}>Food, drink, other</span>
                </div>
                <div style={{ padding: 0 }}>
                  {!byType.length ? <EmptyLine>No sales by type in this period.</EmptyLine> : (
                    <TableWrap>
                      <thead>
                        <tr>
                          <Th>Type</Th>
                          <Th right>Sales</Th>
                          <Th right>Theo cost</Th>
                          <Th right hint="Over the sales with a plate cost">GP % theo</Th>
                          <Th right hint={BY_TYPE_ACTUAL_NOTE}>GP % actual</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {byType.map((r) => {
                          const cur = r.currency || oneCurrency;
                          const canMoney = !!cur;
                          return (
                            <tr key={r.type}>
                              <Td strong>{r.label}</Td>
                              <Td right num>{r.demo_sales ? <span style={ui.grey}>{DEMO_SALES_LINE}</span> : canMoney ? wholeMoney(r.sales_net, cur) : <span style={ui.grey}>{PER_CURRENCY_LINE}</span>}</Td>
                              <Td right num>{r.demo_sales ? '' : canMoney ? wholeMoney(r.theo_cost, cur) : <span style={ui.grey}>{PER_CURRENCY_LINE}</span>}</Td>
                              <Td right num>{r.demo_sales ? <span style={ui.grey}>{NOT_SHOWN}</span> : pctText(r.gp_pct_theo) || <span style={ui.grey}>No sales</span>}</Td>
                              <Td right num grey>comes with counts by type</Td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </TableWrap>
                  )}
                </div>
              </div>
            </div>

            <div style={{ ...card, marginBottom: 16 }} data-testid="stock-all-reports">
              <div style={cardHead}>
                <h3 style={cardTitle}>All 20 reports</h3>
                <span style={note}>{REPORTS_NOTE}</span>
              </div>
              <div style={rgrid}>
                {grid.map((r) => (
                  <button key={r.id} type="button" style={{ ...rbtn, ...(r.later ? { opacity: 0.6, cursor: 'default' } : {}) }}
                    disabled={!!r.later} aria-disabled={!!r.later} onClick={r.later ? undefined : () => open(r.id)}
                    title={r.later ? r.laterWords : `Open ${r.label}`}>
                    {r.label}
                    <small style={rsmall}>{r.later ? r.laterWords : r.desc}</small>
                  </button>
                ))}
              </div>
            </div>

            <Callout>
              <b style={{ color: 'var(--t1)' }}>The rules behind every number.</b> {RULES_LINE.replace(/^The rules behind every number\. /, '')}
              {demo && <> <b style={{ color: 'var(--t1)' }}>{DEMO_LINE}.</b></>}
            </Callout>
          </>
        )}
      </StockReportFrame>

      {targetsOpen && (
        <StockTargetsPanel orgId={orgId} sites={sites} siteById={siteById} level={level} api={api}
          onClose={() => setTargetsOpen(false)}
          onSaved={() => report?.reload?.()} />
      )}
    </>
  );
}

/**
 * One card (the mockup kpi): label, big figure, a pill or a grey line, and the compare delta once the
 * compare call has landed (never before: no figure is painted before its answer).
 */
function Card({ card, nowRow, thenRow, compare, onOpen }) {
  const Tag = onOpen ? 'button' : 'div';
  const [metric, kind] = card.compare || [null, null];
  const hasThen = !!compare && !!metric && !!thenRow && thenRow[metric] != null && !!nowRow && nowRow[metric] != null;
  return (
    <Tag type={onOpen ? 'button' : undefined} onClick={onOpen || undefined} title={onOpen ? 'Open the report behind this figure' : undefined}
      style={{ ...kpi, cursor: onOpen ? 'pointer' : 'default' }} data-card={card.key}>
      <span style={kpiLabel}>{card.label}</span>
      <span style={kpiValue}>{card.value}</span>
      <span style={kpiLine}>
        {card.tone ? <Pill tone={card.tone}>{card.sub}</Pill> : <span style={{ color: 'var(--t4)' }}>{card.sub}</span>}
        {hasThen && <CompareDelta now={nowRow[metric]} then={thenRow[metric]} kind={kind} vs={compare} />}
      </span>
    </Tag>
  );
}
