// src/backoffice/sections/stock/GoLivePlanCard.jsx
//
// MULTI SITE STOCK, Drop 1 (map 4.21, design 2.4 and A19, contract 3.5 and 4.4): the go live plan of
// one site, on that site's Overview in a multi site company. Five steps in order: Copy a site,
// Opening count, Train the trainer, Two weeks side by side, Switch the old system off. The first two
// tick themselves (stock_golive_plan facts: an item is on there, a count is approved); company
// editors set each step's day and tick the other three (stock_save_golive_step, with the step's
// row_version once it has a row). Everyone else sees the plan read only.
//
// Shown only when the site has steps, or nothing is on there yet (goLiveRules planShows), so an
// established site never grows a card. The days are venue days (the site's own clock). The day is
// always said in words beside the box: an empty date box in Safari shows today in grey, so the box
// alone never says whether a day is set.

import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { supabase } from '../../../lib/supabase';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { planLines, planShows, todayIn, goLiveStepPatch, isoDay } from '../../../lib/stock/goLiveRules';
import { Btn, Pill, ErrorLine, ui } from './stockUi';

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 };
const rowStyle = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', flexWrap: 'wrap' };

export default function GoLivePlanCard({ siteId }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const editable = sc.canEditCompany('inventory');
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [today, setToday] = useState(() => todayIn());
  const [busy, setBusy] = useState(null);       // the step being saved
  const [dayOpen, setDayOpen] = useState(null); // { step, day } of the day box that is open

  const [reloads, setReloads] = useState(0);
  const reload = () => setReloads((n) => n + 1);

  useEffect(() => {
    if (!siteId) return undefined;
    let live = true;
    stockApi.goLivePlan(siteId).then((r) => {
      if (!live) return;
      if (r.error) { setError(r.error); return; }
      setError(null);
      setPlan(r.data || { steps: [], facts: {} });
    });
    return () => { live = false; };
  }, [siteId, reloads]);

  // The site's own clock decides "late" (the venue day, not the browser's).
  useEffect(() => {
    if (!siteId || !supabase) return undefined;
    let live = true;
    Promise.resolve(supabase.from('locations').select('timezone').eq('id', siteId).maybeSingle())
      .then(({ data }) => { if (live && data?.timezone) setToday(todayIn(data.timezone)); })
      .catch(() => {});
    return () => { live = false; };
  }, [siteId]);

  const save = async (line, change) => {
    if (busy) return;
    setBusy(line.step);
    const r = await stockApi.saveGoLiveStep(siteId, goLiveStepPatch(line.step, change), line.exists ? line.rowVersion : null);
    setBusy(null);
    if (r.error) {
      showToast?.(r.error.message || 'It did not save. Try again.', 'error', 7000);
      if (r.conflict) reload();
      return;
    }
    setDayOpen(null);
    reload();
  };

  if (error) {
    return (
      <div style={card} data-testid="stock-golive-plan">
        <div style={ui.h2}>Go live plan for {sc.siteName(siteId) || 'this site'}</div>
        <ErrorLine error={error} />
      </div>
    );
  }
  if (!plan || !planShows(plan)) return null;
  const lines = planLines(plan, today);
  const left = lines.filter((l) => l.state !== 'done').length;

  return (
    <div style={card} data-testid="stock-golive-plan">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>Go live plan for {sc.siteName(siteId) || 'this site'}</div>
        <div style={{ fontSize: 12, color: 'var(--t3)' }}>{lines.length - left}/{lines.length} done</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {lines.map((l, i) => {
          const done = l.state === 'done';
          const canTick = editable && !l.auto;
          const saving = busy === l.step;
          return (
            <div key={l.step} style={rowStyle}>
              {canTick ? (
                <input type="checkbox" checked={done} disabled={!!busy} aria-label={`${l.label}: done`}
                  onChange={() => save(l, { done: !done })} style={{ width: 18, height: 18, flexShrink: 0, cursor: busy ? 'default' : 'pointer' }} />
              ) : (
                <div aria-hidden="true" style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 800,
                  background: done ? 'var(--grn, #16a34a)' : 'var(--bg4, var(--bg3))', color: done ? '#fff' : 'var(--t3)' }}>{done ? '✓' : i + 1}</div>
              )}
              <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{l.label}</div>
                <div style={{ fontSize: 11.5, color: l.late ? 'var(--red)' : 'var(--t3)', marginTop: 1 }}>
                  {saving ? 'Saving…' : l.words}
                  {l.auto && !done ? ' · Ticks itself when it happens.' : ''}
                </div>
                {l.note && <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 2 }}>{l.note}</div>}
              </div>
              {l.late && <Pill tone="bad">Late</Pill>}
              {done && !l.late && <Pill tone="good">Done</Pill>}
              {editable && !done && (dayOpen?.step === l.step ? (
                // The day saves on Save, never per key: a date box sends a new value for every
                // figure typed into its year, and each would be a save.
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' }} htmlFor={`golive-day-${l.step}`}>Due</label>
                  <input id={`golive-day-${l.step}`} type="date" value={dayOpen.day} disabled={!!busy}
                    onChange={(e) => setDayOpen({ step: l.step, day: e.target.value })}
                    style={{ ...ui.input, width: 150, padding: '5px 8px' }} />
                  <Btn small kind="primary" disabled={!!busy || !isoDay(dayOpen.day) || isoDay(dayOpen.day) === l.dueDay}
                    onClick={() => save(l, { dueDay: dayOpen.day })}>Save</Btn>
                  {l.dueDay && <Btn small kind="ghost" disabled={!!busy} onClick={() => save(l, { dueDay: '' })}>No day</Btn>}
                  <Btn small kind="link" disabled={!!busy} onClick={() => setDayOpen(null)}>Cancel</Btn>
                </span>
              ) : (
                <Btn small kind="soft" disabled={!!busy} onClick={() => setDayOpen({ step: l.step, day: l.dueDay || '' })}>{l.dueDay ? 'Change day' : 'Set a day'}</Btn>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
