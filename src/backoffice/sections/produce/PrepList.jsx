/**
 * The Prep list of one site (multi site stock Drop 2, v5.11.93, design 2.7, map 4.6, contract 3.3).
 *
 * Today's suggested amounts, through recipes, less what is on the shelf (stock_prep_list: made
 * items whose how at this site is Made here, for the venue's business day). The kitchen ticks each
 * one Done with a quantity; the tick records who and when (stock_prep_tick, need site_facts) and
 * never moves a stock number. Today's ticks can be undone (stock_prep_untick).
 *
 * A database without Drop 2 yet answers NEEDS_UPDATE: the list then falls back to the Batches.jsx
 * "needed today" rule in the browser (lib/stock/prepList.js prepRows, the same figures as today's
 * screen) and says that ticks need the database update.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { isMock, supabase } from '../../../lib/supabase';
import { getLocationConfig, getVenueClock, buildScheduleCtx } from '../../../lib/locationTime';
import { fmtYmd } from '../../../lib/venueDate';
import { stockApi } from '../../../lib/stock/stockApi';
import { fetchInventoryItems, fetchUsageByWeekday } from '../../../lib/stock/data';
import { fetchBatches } from '../../../lib/stock/production';
import { NEEDS_UPDATE } from '../../../lib/stock/saveRules';
import {
  PREP_COLUMNS, PREP_SUB, defaultTickQty, makeWords, prepFromServer, prepRows, prepTitle, r1, rowState, tickWords,
} from '../../../lib/stock/prepList';
import { useStockScope } from '../../StockScope';
import { Btn, Pill, Sheet, Notice, TableWrap, Th, Td, ErrorLine, EmptyLine, ui } from '../stock/stockUi';

const qtyBox = { ...ui.input, width: 74, padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const tickLine = { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--t3)', marginTop: 4, whiteSpace: 'nowrap' };
const undoBtn = { background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', padding: '0 4px', lineHeight: 1 };

/** Today's rule in the browser, for a database without stock_prep_list yet (ticks off). */
async function fallbackRows(siteId) {
  if (isMock || !supabase) return { rows: [], ymd: null, tz: null, error: null };
  const cfg = await getLocationConfig(siteId).catch(() => null);
  const ctx = buildScheduleCtx(cfg?.timezone || null);
  const dow = ctx.isoDay % 7;
  const [its, scheds, usage, bs] = await Promise.all([
    fetchInventoryItems(siteId),
    supabase.from('prep_schedule').select('output_item_id, qty, unit, days_of_week, active').eq('location_id', siteId).eq('active', true),
    fetchUsageByWeekday(8, siteId).then((r) => r.data || {}),
    fetchBatches(siteId, 300),
  ]);
  const error = its.error || scheds.error || bs.error || null;
  const rows = prepRows({ items: its.data || [], schedules: scheds.data || [], usageByItem: usage, batches: bs.data || [], ticks: [], dow, todayYmd: ctx.ymd });
  return { rows, ymd: ctx.ymd, tz: cfg?.timezone || null, error };
}

export default function PrepList({ siteId, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const toast = useCallback((words, type = 'success') => { try { showToast?.(words, type); } catch { /* a toast never breaks a save */ } }, [showToast]);
  const siteName = sc.siteName(siteId);

  const [state, setState] = useState({ loading: true, rows: [], businessDay: null, error: null, fallback: false });
  const [tz, setTz] = useState(null);
  const [qty, setQty] = useState({});       // typed Done amounts by recipe id
  const [busy, setBusy] = useState(null);   // the recipe id or tick id being saved

  useEffect(() => {
    let live = true;
    getVenueClock(siteId).then((c) => { if (live) setTz(c?.timezone || null); }).catch(() => { /* London below */ });
    return () => { live = false; };
  }, [siteId]);

  const load = useCallback(async () => {
    const r = await stockApi.prepList(siteId);
    if (!r.error) {
      const out = prepFromServer(r.data);
      return { loading: false, rows: out.rows, businessDay: out.business_day, error: null, fallback: false };
    }
    if (!r.needsUpdate) return { loading: false, rows: [], businessDay: null, error: r.error, fallback: false };
    const fb = await fallbackRows(siteId);
    return { loading: false, rows: fb.rows, businessDay: fb.ymd, error: fb.error, fallback: true };
  }, [siteId]);

  useEffect(() => {
    let live = true;
    load().then((next) => { if (live) setState(next); });
    return () => { live = false; };
  }, [load]);

  const reload = async () => { const next = await load(); setState(next); };

  const tick = async (row) => {
    const typed = qty[row.recipe_id];
    const amount = Number(typed == null || typed === '' ? defaultTickQty(row) : typed);
    if (!(amount > 0)) { toast('Type how much was made.', 'error'); return; }
    setBusy(row.recipe_id);
    const r = await stockApi.prepTick(siteId, row.recipe_id, amount);
    setBusy(null);
    if (r.error) { toast(r.error.message || String(r.error), 'error'); return; }
    setQty((q) => { const next = { ...q }; delete next[row.recipe_id]; return next; });
    toast(`Done ${r1(amount)}${row.unit ? ` ${row.unit}` : ''} of ${row.name}.`);
    await reload();
  };

  const untick = async (t) => {
    setBusy(t.id);
    const r = await stockApi.prepUntick(t.id);
    setBusy(null);
    if (r.error) { toast(r.error.message || String(r.error), 'error'); return; }
    await reload();
  };

  const dayWords = state.businessDay ? fmtYmd(state.businessDay, { weekday: true }) : '';

  return (
    <Sheet title={prepTitle(siteName)} sub={PREP_SUB} onClose={onClose} width={860}>
      {dayWords && <div style={{ ...ui.sub, marginBottom: 10 }}>Business day {dayWords}.</div>}
      {state.fallback && (
        <div style={{ marginBottom: 12 }}>
          <Notice tone="warn">{NEEDS_UPDATE} Until then this list is today's figures and Done ticks are off.</Notice>
        </div>
      )}
      <ErrorLine error={state.error} />
      {state.loading && <EmptyLine>Loading…</EmptyLine>}
      {!state.loading && state.rows.length === 0 && !state.error && (
        <EmptyLine>Nothing to make today. Items made here show once they are expected to be used or scheduled.</EmptyLine>
      )}
      {!state.loading && state.rows.length > 0 && (
        <TableWrap minWidth={760}>
          <thead>
            <tr>
              {PREP_COLUMNS.map((c, i) => <Th key={c} right={i > 0 && i < 5}>{c}</Th>)}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row) => {
              const key = row.recipe_id || row.output_item_id;
              const st = rowState(row);
              const canTick = !state.fallback && !!row.recipe_id;
              return (
                <tr key={key}>
                  <Td strong>
                    {row.name}
                    {row.horizon && row.horizon !== 'end of today' && <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 3 }}>up to {row.horizon}</div>}
                  </Td>
                  <Td num>{r1(row.on_hand)} {row.unit}</Td>
                  <Td num grey={!(row.scheduled > 0)}>{row.scheduled > 0 ? `${r1(row.scheduled)} ${row.unit}` : ''}</Td>
                  <Td num>{r1(row.expected)} {row.unit}</Td>
                  <Td num>
                    {st === 'covered'
                      ? <span style={{ color: 'var(--acc)', fontWeight: 700 }}>{makeWords(row)}</span>
                      : <b style={{ color: st === 'done' ? 'var(--acc)' : 'var(--amber, #F5A623)' }}>{makeWords(row)}</b>}
                  </Td>
                  <Td>
                    {st === 'done' && <Pill tone="good">Done</Pill>}
                    {st === 'open' && canTick && (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input type="text" inputMode="decimal" aria-label={`Made of ${row.name}`} style={qtyBox}
                          value={qty[row.recipe_id] ?? defaultTickQty(row)}
                          onChange={(e) => setQty((q) => ({ ...q, [row.recipe_id]: e.target.value }))}
                          disabled={busy === row.recipe_id} />
                        <span style={{ fontSize: 12, color: 'var(--t3)' }}>{row.unit}</span>
                        <Btn small kind="primary" disabled={busy === row.recipe_id} onClick={() => tick(row)}>{busy === row.recipe_id ? 'Saving…' : 'Done'}</Btn>
                      </span>
                    )}
                    {st === 'open' && !canTick && <span style={{ fontSize: 12, color: 'var(--t4)' }}>{state.fallback ? 'Ticks need the database update' : 'No company recipe yet'}</span>}
                    {row.ticks.map((t) => (
                      <div key={t.id || `${t.at}-${t.qty}`} style={tickLine}>
                        <span>{tickWords(t, row.unit, tz)}</span>
                        {t.id && !state.fallback && (
                          <button type="button" style={undoBtn} aria-label={`Undo ${tickWords(t, row.unit, tz)}`} title="Undo this tick"
                            disabled={busy === t.id} onClick={() => untick(t)}>x</button>
                        )}
                      </div>
                    ))}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      <div style={{ ...ui.sub, marginTop: 12 }}>A Done tick records who made it and when. It never changes what is on hand: making the batch on this screen does that.</div>
    </Sheet>
  );
}
