// src/backoffice/sections/reports/_stockKit.jsx
//
// MULTI SITE STOCK (v5.11.92, Drop 4a, contract 3.1): the pieces every Stock and GP report screen
// shares. The frame with its rules line, the site totals table (site rows then the company rows,
// one table per currency, never a sum across two), the keyset paged drill table, the RAG pill, the
// compare delta, the waiting tile, the NEEDS_UPDATE line, the hook that loads one report (page one
// and the compare call, more on demand, the newest call wins, no figure before the answer lands)
// and the on screen CSV export. Theme tokens only; every money figure in its row's currency; words
// from src/lib/stock/reportRules.js; nothing here works a number out from checks or movements.
//
// The day and hour of a figure are the database's (each venue's own business day): this file never
// reads the device clock.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Btn, Pill, ShowMore, TableWrap, Th, Td, ui } from '../stock/stockUi';
import { Tag } from './reportKit';
import { CompareChip, ExportBtn } from './_charts';
import { downloadCsv } from './_csv';
import { NEEDS_UPDATE } from '../../../lib/stock/saveRules';
import { ragTone } from '../../../lib/stock/targetRules';
import { DEMO_SALES_LINE } from '../../../lib/stock/dashboardRules';
import {
  metaLines, currencyBlocks, layoutRows, cellWords, countedWords, withSiteColumns, columnsToCsv, exportFileName,
  siteOf, matchingRow, CAP_LINE,
} from '../../../lib/stock/reportRules';

const NUMERIC = new Set(['money', 'pct', 'qty']);
const COUNTED_OF = { opening_value: 'opening_counted', closing_value: 'closing_counted', stock_value: 'counted' };

/** The grey rules line under a report's title: the lines metaLines gives, dot separated. */
export function RulesLine({ meta, extra = [] }) {
  const lines = [...metaLines(meta), ...(extra || []).filter(Boolean)];
  if (!lines.length) return null;
  return (
    <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6, lineHeight: 1.6 }} data-testid="stock-rules-line">
      {lines.map((l, i) => <span key={i}>{i > 0 && <span style={{ color: 'var(--t4)', margin: '0 6px' }}>{'·'}</span>}{l}</span>)}
    </div>
  );
}

/**
 * The title, the sub line, the Export and Share buttons on the right, the rules line, then the body.
 * `extraLines` are report specific lines ("Purchases at delivery value until the purchasing update").
 * The frame holds the screen's one Export and one Share (the mockup): the report passes its own
 * export run and label (exportLabel: "Export CSV" when every row is on screen, else "Export all rows
 * as a file") and its own share with its current options, so the link keeps the filters on screen.
 */
export function StockReportFrame({ title, sub, meta, children, onExport, exportLabel = 'Export', onShare, actions = null, extraLines = [] }) {
  return (
    <div style={{ marginBottom: 18 }} data-testid="stock-report-frame">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <h2 style={{ ...ui.title, fontSize: 20 }}>{title}</h2>
          {sub && <div style={ui.pageSub}>{sub}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {actions}
          {onExport && <ExportBtn onClick={onExport} label={exportLabel} />}
          {onShare && <Btn kind="ghost" small onClick={onShare}>Share</Btn>}
        </div>
      </div>
      <RulesLine meta={meta} extra={extraLines} />
      <div style={{ marginTop: 14 }}>{children}</div>
    </div>
  );
}

/** A red, amber or green pill (targetRules.ragTone); a plain span when there is no colour. */
export function RagPill({ rag, children, title }) {
  const tone = ragTone(rag);
  if (!tone) return <span title={title}>{children}</span>;
  return <Pill tone={tone} title={title}>{children}</Pill>;
}

/**
 * The change against the compare period for one figure. A percent reads as points ('+1.2 pts');
 * money and quantities get the one percent rule's chip (never "New" when the compare did not load).
 */
export function CompareDelta({ now, then, kind = 'money', vs = null, noun = 'figures', loaded = true }) {
  if (kind === 'pct') {
    const a = Number(now), b = Number(then);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return <span style={{ fontSize: 10, color: 'var(--t4)' }}>{loaded ? '' : 'Not loaded'}</span>;
    const d = a - b;
    const color = d > 0 ? 'var(--grn, #16a34a)' : d < 0 ? 'var(--red)' : 'var(--t4)';
    return <span title={vs?.label || undefined} style={{ fontSize: 10, fontWeight: 600, color, fontFamily: 'var(--font-mono)' }}>{`${d > 0 ? '+' : ''}${d.toFixed(1)} pts`}</span>;
  }
  const cmp = loaded ? vs : { ...(vs || {}), loaded: false };
  return <CompareChip values={[now, then]} vs={cmp} noun={noun} short />;
}

/** The tile a report that waits for a later Drop shows (the Catalog's words). */
export function LaterTile({ words, title = null }) {
  return (
    <div style={{ ...ui.card, padding: 26, textAlign: 'center' }} data-testid="stock-later-tile">
      {title && <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>{title}</div>}
      <div style={{ fontSize: 13, color: 'var(--t3)' }}>{words}</div>
    </div>
  );
}

/** The one line a screen shows when the database does not have the report function yet. */
export function NeedsUpdateLine() {
  return <div role="alert" style={{ ...ui.err, padding: '8px 0' }}>{NEEDS_UPDATE}</div>;
}

/** A grey waiting line with words (never a spinner with none). */
export function StockLoading({ words = 'Loading the report' }) {
  return <div style={{ padding: '26px 4px', fontSize: 13, color: 'var(--t3)' }}>{words}{'…'}</div>;
}

/** The error words of a failed report call: NEEDS_UPDATE for a missing function, else the database's words. */
export function StockError({ error }) {
  if (!error) return null;
  if (error.needsUpdate || error.code === 'needs_update') return <NeedsUpdateLine />;
  return <div role="alert" style={{ ...ui.err, padding: '8px 0' }}>{error.message || String(error)}</div>;
}

const cellStyle = (c) => (NUMERIC.has(c.kind) ? { textAlign: 'right' } : {});

/**
 * The site totals: site rows then the company rows, one table per currency (two currencies are
 * never added), a sticky first column, 'Own cost rule' on a site with its own cost rule, 'Counted'
 * or 'Estimated (ledger)' under every opening and closing figure, RAG pills on the columns `rag`
 * names ({ column key: the rag metric key in row.rag }), and the compare delta under each figure
 * when `then` (the compare call's totals) is given.
 *   layout  'side' (sites then company) or 'total' (company rows only)
 *   onSite  (location_id) => void: a site name click
 */
export function SiteTotalsTable({ meta, totals, columns, layout = 'side', rag = {}, onSite, then = null, thenLoaded = true, compare = null }) {
  const cols = (columns || []).filter((c) => c && c.key && c.key !== 'site' && c.key !== 'currency' && c.key !== 'location_id');
  const blocks = currencyBlocks(layoutRows(totals, layout));
  if (!blocks.length) return <div style={{ padding: '18px 4px', fontSize: 13, color: 'var(--t3)' }}>Nothing to show for these sites and days.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {blocks.map((b) => {
        const rows = [...b.sites, ...(b.company ? [b.company] : [])];
        return (
          <div key={b.currency || 'unknown'}>
            {blocks.length > 1 && <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t3)', marginBottom: 6 }}>{b.currency || 'Currency not set'}</div>}
            <TableWrap>
              <thead>
                <tr>
                  <Th sticky>Site</Th>
                  {cols.map((c) => <Th key={c.key} right={NUMERIC.has(c.kind)}>{c.label || c.key}</Th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const company = row.location_id == null;
                  const site = company ? null : siteOf(meta, row.location_id);
                  const name = company ? 'Company total' : (row.site || site?.name || 'Site');
                  const prev = then ? matchingRow(row, then) : null;
                  return (
                    <tr key={company ? `company:${b.currency}` : `${row.location_id}:${i}`} style={company ? { fontWeight: 700 } : undefined}>
                      <Td sticky strong={company}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {!company && onSite
                            ? <button type="button" onClick={() => onSite(row.location_id)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--acc)', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>{name}</button>
                            : <span>{name}</span>}
                          {site?.cost_rule_own && <Tag label="Own cost rule" tone="warn" />}
                          {site?.kind === 'central_kitchen' && <Tag label="Central kitchen" />}
                          {row.demo_sales === true && <Tag label={DEMO_SALES_LINE} tone="warn" />}
                        </span>
                      </Td>
                      {cols.map((c) => {
                        const value = row[c.key];
                        // a row whose sales the database left out (a demo check in its days) shows a blank, not 'No sales'
                        const words = row.demo_sales === true && value == null ? '' : cellWords(c, value, row.currency || b.currency || undefined);
                        const metric = rag && rag[c.key];
                        const colour = metric && row.rag ? row.rag[metric] : (c.kind === 'rag' ? value : null);
                        const countedKey = COUNTED_OF[c.key];
                        return (
                          <Td key={c.key} right={NUMERIC.has(c.kind)}>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: NUMERIC.has(c.kind) ? 'flex-end' : 'flex-start', gap: 2, ...cellStyle(c) }}>
                              {colour ? <RagPill rag={colour}>{words}</RagPill> : <span>{words}</span>}
                              {countedKey && value != null && <span style={{ fontSize: 10, color: 'var(--t4)' }}>{countedWords(row[countedKey])}</span>}
                              {then && NUMERIC.has(c.kind) && <CompareDelta now={value} then={prev?.[c.key]} kind={c.kind} vs={compare} loaded={thenLoaded && !!prev} noun={c.noun || 'figures'} />}
                            </div>
                          </Td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A drill level: keyset paged ('Show more' while `next` is there), sortable by column (the caller
 * asks the database again with sort and dir), a row click when `onRow` is given.
 *   columns     meta.columns, or the subset a tab shows: [{ key, label, kind, noun }]
 *   currencyOf  (location_id) => currency, for rows that carry no currency of their own
 */
export function DrillTable({ columns, rows, next, onMore, onRow, sort, onSort, busy = false, empty = 'Nothing to show.', currencyOf = null, capped = false }) {
  const cols = (columns || []).filter((c) => c && c.key);
  const list = Array.isArray(rows) ? rows : [];
  return (
    <div>
      <TableWrap>
        <thead>
          <tr>
            {cols.map((c) => {
              const sortable = typeof onSort === 'function' && c.sortable !== false;
              const on = sort?.key === c.key;
              return (
                <th key={c.key} onClick={sortable ? () => onSort(c.key) : undefined}
                  style={{ ...ui.th, ...(NUMERIC.has(c.kind) ? { textAlign: 'right' } : {}), cursor: sortable ? 'pointer' : 'default', userSelect: 'none' }}
                  aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.label || c.key}{on && <span style={{ marginLeft: 5, color: 'var(--acc)' }}>{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && !busy && <tr><td colSpan={cols.length || 1} style={{ ...ui.td, textAlign: 'center', color: 'var(--t4)', padding: '30px 12px' }}>{empty}</td></tr>}
          {list.map((row, i) => (
            <tr key={row.id ?? row.key ?? i} onClick={onRow ? () => onRow(row) : undefined} style={onRow ? { cursor: 'pointer' } : undefined}>
              {cols.map((c) => {
                const value = row[c.key];
                const currency = row.currency || (currencyOf ? currencyOf(row.location_id) : null) || undefined;
                const words = cellWords(c, value, currency);
                return <Td key={c.key} right={NUMERIC.has(c.kind)}>{c.kind === 'rag' && value ? <RagPill rag={value}>{words}</RagPill> : words}</Td>;
              })}
            </tr>
          ))}
        </tbody>
      </TableWrap>
      {capped && <div style={{ padding: '10px 4px', fontSize: 12, color: 'var(--t3)' }}>{CAP_LINE}</div>}
      {!capped && <ShowMore next={next} busy={busy} onMore={onMore} />}
    </div>
  );
}

const EMPTY = Object.freeze({ meta: null, totals: null, rows: null, next: null, loading: true, error: null, needsUpdate: false, then: null, thenError: null, thenLoaded: false, capped: false, moreBusy: false });

/**
 * Load one report: page one (totals are complete on page one) and, when `args.compare` names a
 * range, the same call over the compare days (totals only). Follows `next` on demand (more()),
 * never shows a figure before the answer lands (a changed call clears the old answer first), and
 * the newest call wins over an older one still in flight.
 *   api   createStockReportsApi's answer (stockReportsApi)
 *   name  'gap', 'cogs', ... (reportFnOf)
 *   args  { orgId, sites, from, to, opts, compare: { from, to } | null }
 * Returns { meta, totals, rows, next, loading, error, needsUpdate, then, thenError, thenLoaded,
 * capped, more, moreBusy, reload }.
 */
// The hook rides along with the components (contract 3.1): one import for every screen.
// eslint-disable-next-line react-refresh/only-export-components
export function useStockReport(api, name, args) {
  const key = JSON.stringify([name, args?.orgId, args?.sites, args?.from, args?.to, args?.opts || null, args?.compare || null]);
  const [state, setState] = useState(EMPTY);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    const my = ++seq.current;
    const live = () => my === seq.current;
    setState(EMPTY);
    if (!api || !name || !args?.orgId || !Array.isArray(args.sites) || !args.sites.length || !args.from || !args.to) {
      setState({ ...EMPTY, loading: false });
      return undefined;
    }
    (async () => {
      const first = await api.report(name, { orgId: args.orgId, sites: args.sites, from: args.from, to: args.to, opts: args.opts || null, after: null, limit: 1000 });
      if (!live()) return;
      if (first.error) { setState({ ...EMPTY, loading: false, error: first.error, needsUpdate: !!first.needsUpdate }); return; }
      const d = first.data || {};
      let then = null, thenError = null, thenLoaded = false;
      if (args.compare?.from && args.compare?.to) {
        const c = await api.report(name, { orgId: args.orgId, sites: args.sites, from: args.compare.from, to: args.compare.to, opts: args.opts || null, after: null, limit: 1 });
        if (!live()) return;
        if (c.error) thenError = c.error; else { then = c.data || {}; thenLoaded = true; }
      }
      const rows = Array.isArray(d.rows) ? d.rows : d.rows ?? [];
      setState({
        meta: d.meta ?? null, totals: d.totals ?? [], rows, next: d.next ?? null, loading: false, error: null, needsUpdate: false,
        then: then ? { meta: then.meta ?? null, totals: then.totals ?? [], rows: then.rows ?? null } : null, thenError, thenLoaded,
        capped: Array.isArray(rows) && rows.length >= 1000 && !!d.next, moreBusy: false,
      });
    })();
    return undefined;
    // key holds every argument the call depends on (api is a module constant).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const more = useCallback(async () => {
    if (!api || !state.next || state.moreBusy || state.loading) return;
    const my = seq.current;
    const startKey = keyRef.current;
    setState((s) => ({ ...s, moreBusy: true }));
    const r = await api.report(name, { orgId: args.orgId, sites: args.sites, from: args.from, to: args.to, opts: args.opts || null, after: state.next, limit: 1000 });
    if (my !== seq.current || startKey !== keyRef.current) return;
    if (r.error) { setState((s) => ({ ...s, moreBusy: false, error: r.error })); return; }
    const d = r.data || {};
    const add = Array.isArray(d.rows) ? d.rows : [];
    setState((s) => {
      const rows = [...(Array.isArray(s.rows) ? s.rows : []), ...add];
      return { ...s, rows, next: d.next ?? null, moreBusy: false, capped: rows.length >= 1000 && !!d.next };
    });
    // args is read at call time on purpose: the latest call's arguments page on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, name, key, state.next, state.moreBusy, state.loading]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, more, reload };
}

/**
 * The on screen export (under 1,000 rows): the CSV over meta.columns with Site and Currency in
 * front, the totals first, then the drill rows, saved as <report>-<from>-<to>.csv.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function exportCsvNow(name, meta, totals, rows) {
  const columns = withSiteColumns(meta?.columns);
  const csv = columnsToCsv(columns, [...(Array.isArray(totals) ? totals : []), ...(Array.isArray(rows) ? rows : [])]);
  downloadCsv(exportFileName(name, meta?.from, meta?.to), csv);
}
