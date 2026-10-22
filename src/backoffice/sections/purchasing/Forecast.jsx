// purchasing/Forecast.jsx: Purchasing > Forecast (multi site stock Drop 3, v5.11.96, contract 3.2 and
// 4.2, mockup INFO forecast). One number for staff and stock: the same forecast as the AI rota
// (suggestForecast over this site's venue day sales, stock_sales_history). A week from the company's
// week start: Suggested, the saved Forecast, Actual for past days, Reason and Edited by. A day opens
// ForecastDayModal; Use these saves the suggestion for every day with none. Saves go through
// stock_save_forecast (the rota reads the same rows, so edits show there too).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { getLocationConfig, buildScheduleCtx } from '../../../lib/locationTime';
import { suggestForecast, historyFromRows } from '../../../../supabase/functions/_shared/salesForecast.js';
import { dayWords, moneyWords } from '../../../lib/stock/purchasingRules';
import { forecastReasonWords } from '../../../lib/stock/purchasingWords';
import { PageHead, TableWrap, Th, Td, Btn, Notice, ErrorLine, EmptyLine, ui } from '../stock/stockUi';
import ForecastDayModal from './ForecastDayModal';
import ForecastSourceCard from './ForecastSourceCard';

const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dowOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

export default function Forecast({ orgCtx = null, siteId }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  void orgCtx; // the contract's prop; the forecast needs only the site
  const [today, setToday] = useState(null);
  const [weekStartDow, setWeekStartDow] = useState(1);
  const [weekStart, setWeekStart] = useState(null);
  const [week, setWeek] = useState(null);       // stock_forecast_week answer
  const [hist, setHist] = useState(null);       // stock_sales_history answer
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);       // a day row
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState(0);

  useEffect(() => {
    let on = true;
    Promise.all([getLocationConfig(siteId).catch(() => null), sc.orgId ? stockApi.settings(sc.orgId) : Promise.resolve({ data: null })]).then(([cfg, st]) => {
      if (!on) return;
      const t = buildScheduleCtx(cfg?.timezone || null).ymd;
      const ws = Number.isInteger(Number(st?.data?.settings?.week_start)) ? Number(st.data.settings.week_start) : 1;
      setToday(t); setWeekStartDow(ws);
      setWeekStart(addDays(t, -((dowOf(t) - ws + 7) % 7)));
    });
    return () => { on = false; };
  }, [siteId, sc.orgId]);

  useEffect(() => {
    if (!weekStart || !siteId) return undefined;
    let on = true;
    Promise.all([stockApi.forecastWeek(siteId, weekStart), stockApi.salesHistory(siteId, 84)]).then(([w, h]) => {
      if (!on) return;
      setError(w.error || h.error || null);
      setWeek(w.error ? null : w.data); setHist(h.error ? null : h.data);
    });
    return () => { on = false; };
  }, [siteId, weekStart, again]);

  const days = useMemo(() => (weekStart ? Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)) : []), [weekStart]);
  const suggested = useMemo(() => suggestForecast(historyFromRows(hist?.rows), days), [hist, days]);
  const byDay = useMemo(() => Object.fromEntries((week?.days || []).map((d) => [String(d.day).slice(0, 10), d])), [week]);
  const actualOf = useCallback((ymd) => {
    const a = week?.actuals;
    if (!a) return null;
    if (Array.isArray(a)) { const r = a.find((x) => String(x.business_day || x.day).slice(0, 10) === ymd); return r ? Number(r.net ?? r.amount) : null; }
    return a[ymd] != null ? Number(a[ymd]) : null;
  }, [week]);

  const saveDay = async ({ day, amount, reason, reason_note, hours }) => {
    const r = await stockApi.saveForecast(siteId, [{ day, amount, suggested: suggested[day]?.amount ?? null, reason, reason_note }], hours && hours.length ? hours : null);
    if (r.error) return { error: r.error };
    setOpen(null); setAgain((n) => n + 1);
    showToast?.(`Forecast saved for ${dayWords(day)}.`, 'success');
    return null;
  };
  const useThese = async () => {
    const rows = days.filter((d) => byDay[d]?.amount == null && suggested[d]).map((d) => ({ day: d, amount: suggested[d].amount, suggested: suggested[d].amount, reason: null, reason_note: null }));
    if (!rows.length) { showToast?.('Every day already has a forecast.', 'info'); return; }
    setBusy(true);
    const r = await stockApi.saveForecast(siteId, rows, null);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    setAgain((n) => n + 1);
    showToast?.(`Saved the suggestion for ${rows.length} day${rows.length === 1 ? '' : 's'}.`, 'success');
  };

  const editor = sc.canEditCompany('purchasing');
  return (
    <div style={ui.page}>
      <PageHead title="Forecast" sub="One number for staff and stock: the same forecast as the AI rota.">
        <Btn small disabled={!weekStart} onClick={() => setWeekStart(addDays(weekStart, -7))}>Last week</Btn>
        <Btn small disabled={!weekStart} onClick={() => setWeekStart(addDays(today, -((dowOf(today) - weekStartDow + 7) % 7)))}>This week</Btn>
        <Btn small disabled={!weekStart} onClick={() => setWeekStart(addDays(weekStart, 7))}>Next week</Btn>
        <Btn kind="primary" disabled={busy || !weekStart} onClick={useThese}>Use these</Btn>
      </PageHead>
      <div style={{ marginBottom: 14 }}><Notice tone="info">Managers edit a day (or hour) with a reason. Edits show on the rota too. It feeds the Order pad, prep list, central kitchen plan, pars by days of cover and the purchase budget.</Notice></div>
      <ErrorLine error={error} />
      {!weekStart ? <EmptyLine>Loading…</EmptyLine> : (
        <TableWrap minWidth={720}>
          <thead><tr><Th>Day</Th><Th right>Suggested</Th><Th right>Forecast</Th><Th right>Actual</Th><Th>Reason</Th><Th>Edited by</Th></tr></thead>
          <tbody>
            {days.map((d) => {
              const row = byDay[d] || {};
              const act = d < today ? actualOf(d) : null;
              return (
                <tr key={d}>
                  <Td strong>{dayWords(d)}</Td>
                  <Td num grey>{suggested[d] ? moneyWords(suggested[d].amount) : ''}</Td>
                  <Td num><Btn kind="link" small onClick={() => setOpen({ day: d, row })}>{row.amount != null ? moneyWords(row.amount) : 'Set'}</Btn>{(row.hours || []).length > 0 && <span style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 4 }}>by hour</span>}</Td>
                  <Td num>{act != null ? moneyWords(act) : ''}</Td>
                  <Td>{forecastReasonWords(row.reason)}{row.reason_note ? <span style={{ color: 'var(--t3)' }}>: {row.reason_note}</span> : null}</Td>
                  <Td grey>{row.edited_by_name || ''}</Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      {hist?.borrowed && <div style={{ ...ui.sub, marginTop: 10 }}>Suggestions use {hist.borrowed.from_name}'s sales times {hist.borrowed.scale} until this site has 4 weeks of its own.</div>}
      {editor && hist && Number(hist.own_days) < 28 && <ForecastSourceCard siteId={siteId} borrowed={hist.borrowed} onSaved={() => setAgain((n) => n + 1)} />}
      {open && <ForecastDayModal day={open.day} amount={open.row.amount ?? null} suggested={suggested[open.day]?.amount ?? null} reason={open.row.reason || null} note={open.row.reason_note || ''} hours={open.row.hours || []} onSave={saveDay} onClose={() => setOpen(null)} />}
    </div>
  );
}
