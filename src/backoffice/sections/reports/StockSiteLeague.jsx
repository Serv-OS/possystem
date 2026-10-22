// src/backoffice/sections/reports/StockSiteLeague.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.2, the mockup Site league): one row per site, the 13 columns
// exactly, sortable by any column, red amber green pills from the server's rag against the targets
// (Gap %, Waste %, Purchases 'Over'; 'Missed' on Last full count is Drop 3). A central kitchen row
// shows 'None' for sales and blanks for GP. A site click opens the same dashboard for that one site;
// a number click opens the report behind it with the row's site.
//
// Rows are stock_report_league's (inside stock_report_dashboard rows.league): every figure from the
// stored day totals on each venue's own business day, money in each row's own currency. The table
// scrolls inside its card, never the page. Words and sorting: dashboardRules.js.

import { useState } from 'react';
import { TableWrap, Th, Td, Pill, EmptyLine, ui } from '../stock/stockUi';
import { LEAGUE_COLUMNS, LEAGUE_NOTE, leagueCell, sortLeague } from '../../../lib/stock/dashboardRules';

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, marginBottom: 16, minWidth: 0 };
const head = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--bdr)' };
const sortBtn = { border: 'none', background: 'transparent', padding: 0, font: 'inherit', color: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 };
const linkBtn = { border: 'none', background: 'transparent', padding: 0, font: 'inherit', cursor: 'pointer', color: 'var(--acc)', fontWeight: 600, textAlign: 'left' };
const numBtn = { ...linkBtn, color: 'var(--t1)', fontWeight: 500, fontVariantNumeric: 'tabular-nums', textAlign: 'right', textDecoration: 'underline dotted var(--bdr2)' };

/**
 * rows: the league rows. onSite(locationId): the site click. onCell(report, row): a number click.
 * initialSort: { key, dir } (default sales desc).
 */
export default function StockSiteLeague({ rows, onSite, onCell, initialSort = null }) {
  const [sort, setSort] = useState(initialSort || { key: 'sales_net', dir: 'desc' });
  const list = sortLeague(rows, sort);
  const toggle = (key) => setSort((s) => (s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'site' || key === 'last_full_count_day' ? 'asc' : 'desc' }));
  return (
    <div style={card} data-testid="stock-site-league">
      <div style={head}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>Site league</h3>
        <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>{LEAGUE_NOTE}</span>
      </div>
      {!list.length ? <EmptyLine>No sites in this scope.</EmptyLine> : (
        <div style={{ padding: 0, borderRadius: '0 0 14px 14px', overflow: 'hidden' }}>
          <TableWrap minWidth={1180}>
            <thead>
              <tr>
                {LEAGUE_COLUMNS.map((c) => {
                  const right = c.kind !== 'text' && c.kind !== 'day' && c.kind !== 'budget';
                  const on = sort.key === c.key;
                  return (
                    <Th key={c.key} right={right} sticky={c.key === 'site'} hint={c.hint}>
                      <button type="button" style={sortBtn} onClick={() => toggle(c.key)} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        title={`Sort by ${c.label}`}>
                        {c.label}
                        {on && <span style={{ color: 'var(--acc)' }}>{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                      </button>
                    </Th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={r.location_id || i}>
                  {LEAGUE_COLUMNS.map((c) => {
                    const cell = leagueCell(r, c);
                    const right = c.kind !== 'text' && c.kind !== 'day' && c.kind !== 'budget';
                    if (c.key === 'site') {
                      return (
                        <Td key={c.key} sticky strong>
                          <button type="button" style={linkBtn} onClick={() => onSite?.(r.location_id, r)} title="Open this site's dashboard">{cell.text}</button>
                          {r.kitchen === true && <span style={{ ...ui.grey, fontSize: 11.5, marginLeft: 6 }}>Central kitchen</span>}
                        </Td>
                      );
                    }
                    const body = cell.pill && cell.pill.text === cell.text
                      ? <Pill tone={cell.pill.tone}>{cell.pill.text}</Pill>
                      : (
                        <>
                          <span style={cell.grey ? ui.grey : undefined}>{cell.text}</span>
                          {cell.pill && <Pill tone={cell.pill.tone} style={{ marginLeft: 6 }}>{cell.pill.text}</Pill>}
                        </>
                      );
                    const clickable = !!cell.report && cell.text !== '' && !cell.grey;
                    return (
                      <Td key={c.key} right={right} num={right}>
                        {clickable
                          ? <button type="button" style={numBtn} onClick={() => onCell?.(cell.report, r)} title="Open the report behind this number">{body}</button>
                          : body}
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      )}
    </div>
  );
}
