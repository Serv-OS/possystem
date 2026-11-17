// src/backoffice/sections/headoffice/HqNumbers.jsx
//
// Head office, Daily numbers: "Feed the scorecard". Every reading the tills cannot know comes
// from here: one short entry per site per day (Log a day), or a pasted export (Import a CSV,
// src/lib/hq/numbersCsv.js: every row checked first, a single bad row stops the whole paste).
// Rows upsert on site + business date, so saving a day again replaces it.
// Slice 2: cash on hand is no longer typed here. It comes from the safe ledger (Safe and banking).
// The column stays in the database and in the CSV import (numbersCsv.js) for the sites that paste it.
// Slice 3: every box shows what the system already knows for the site and day (the till by the Daily
// trading rule, approved timesheets, the stock ledger or the venue's COGS %, the sales forecast split
// by the site's own pattern, public reviews, Workforce turnover; src/lib/hq/systemDay.js) and only
// takes an override. A saved day keeps every figure plus where each came from (sources jsonb,
// migration 20261202a), so the scorecard tags an override and only an override.

import { useEffect, useMemo, useState } from 'react';
import { fetchDailyNumbers, saveDailyNumbers, fetchSystemDay } from '../../../lib/hq/data.js';
import { systemFields, resolveDay, typedBoxes, sourceWord, SYSTEM_KEYS } from '../../../lib/hq/systemDay.js';
import { primeCostPct } from '../../../lib/hq/primeCost.js';
import { parseNumbersCsv, CSV_TEMPLATE, CSV_COLUMNS } from '../../../lib/hq/numbersCsv.js';
import {
  page, card, mono, accBtn, btn, field, lbl, th, td, disabled, exactMoney, pct, num, dateText, addDays, NA,
  PageHead, SectionHead, Chip, AbsentCard, AmberLine, GreenLine, LoadingLine, TabRow, Field, hqHandoff,
} from './hqUi';

export const NUMBER_KEYS = ['net_sales', 'cogs', 'labour', 'projected_lunch', 'projected_dinner', 'projected_late', 'reviews_count', 'review_rating', 'turnover_pct', 'morale_score', 'hires_needed'];
const EMPTY = Object.fromEntries([...NUMBER_KEYS, 'notes'].map((k) => [k, '']));
const DAYS_BACK = 14;

/** Boxes to a row: blank is null (never a guessed zero), everything else a number. */
export function rowFromForm(form, locationId, businessDate) {
  const out = { location_id: locationId, business_date: businessDate, source: 'typed', notes: String(form.notes || '').trim() || null };
  for (const k of NUMBER_KEYS) {
    const s = String(form[k] ?? '').trim().replace(/[$£€,\s]/g, '').replace(/%$/, '');
    out[k] = s === '' ? null : Number(s);
  }
  return out;
}


export default function HqNumbers({ hq }) {
  const [tab, setTab] = useState(() => { const t = hqHandoff.numbersTab === 'import' ? 'import' : 'log'; hqHandoff.numbersTab = null; return t; });
  const ids = useMemo(() => hq.sites.map((s) => s.id), [hq.sites]);
  const [recent, setRecent] = useState({ loading: true, absent: false, error: null, rows: [] });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    fetchDailyNumbers(ids, addDays(hq.today, -DAYS_BACK), hq.today).then((r) => {
      if (!live) return;
      setRecent({ loading: false, absent: !!r.absent, error: r.error && !r.absent ? r.message : null, rows: r.data || [] });
    });
    return () => { live = false; };
  }, [ids, hq.today, tick]);

  if (recent.absent) {
    return (
      <div style={page}>
        <PageHead title="Feed the scorecard" sub="Every reading the tills cannot know comes from here: one short entry per site per day, or a pasted export." />
        <AbsentCard message="Ask ServOS to run migration 20261130a." />
      </div>
    );
  }

  const reload = () => setTick((n) => n + 1);

  return (
    <div style={page}>
      <PageHead title="Feed the scorecard" sub="Every reading the tills cannot know comes from here: one short entry per site per day, or a pasted export."
        right={<TabRow tabs={[['log', 'Log a day'], ['import', 'Import a CSV']]} value={tab} onChange={setTab} />} />
      {tab === 'log' && <LogDay hq={hq} recent={recent.rows} onSaved={reload} />}
      {tab === 'import' && <ImportCsv hq={hq} onSaved={reload} />}

      <SectionHead title="Last 14 days" sub="Each saved day as it was kept: system figures, overrides or a pasted CSV. The scorecard still lets the live till win for today, this week and this month." />
      {recent.loading && <LoadingLine>Loading</LoadingLine>}
      <AmberLine>{recent.error}</AmberLine>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead><tr>
            <th style={th}>Site</th><th style={th}>Date</th><th style={th}>Net sales</th><th style={th}>COGS</th><th style={th}>Labour</th><th style={th}>Prime</th>
            <th style={th}>Morale</th><th style={th}>Hires</th><th style={th}>Rating</th><th style={th}>Source</th>
          </tr></thead>
          <tbody>
            {recent.rows.map((r) => {
              const site = hq.sites.find((s) => s.id === r.location_id);
              const prime = primeCostPct({ net: r.net_sales, cogs: r.cogs, labour: r.labour });
              return (
                <tr key={`${r.location_id}|${r.business_date}`}>
                  <td style={{ ...td, fontWeight: 600 }}>{site?.name || 'Site'}</td>
                  <td style={{ ...td, ...mono }}>{dateText(r.business_date, hq.currency, { day: 'numeric', month: 'short' })}</td>
                  <td style={{ ...td, ...mono }}>{exactMoney(r.net_sales, hq.currency)}</td>
                  <td style={{ ...td, ...mono }}>{exactMoney(r.cogs, hq.currency)}</td>
                  <td style={{ ...td, ...mono }}>{exactMoney(r.labour, hq.currency)}</td>
                  <td style={{ ...td, ...mono, color: prime === null ? 'var(--t4)' : prime < 60 ? 'var(--grn)' : 'var(--orn)', fontWeight: 700 }}>{pct(prime)}</td>
                  <td style={{ ...td, ...mono }}>{r.morale_score === null ? NA : r.morale_score}</td>
                  <td style={{ ...td, ...mono }}>{num(r.hires_needed)}</td>
                  <td style={{ ...td, ...mono }}>{r.review_rating === null ? NA : `${Number(r.review_rating).toFixed(1)}${r.reviews_count !== null ? ` (${r.reviews_count})` : ''}`}</td>
                  <td style={td} title={Object.entries(r.sources || {}).map(([k, v]) => `${k}: ${sourceWord(v)}`).join(', ')}><Chip tone={r.source === 'csv' ? 'acc' : r.source === 'system' ? 'grn' : 't3'}>{r.source === 'csv' ? 'CSV' : r.source === 'system' ? 'System' : (r.sources && Object.keys(r.sources).length ? 'Overrides' : 'Typed')}</Chip></td>
                </tr>
              );
            })}
            {!recent.loading && !recent.rows.length && <tr><td style={{ ...td, color: 'var(--t3)' }} colSpan={10}>Nothing logged in the last 14 days.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Group({ title, note, children }) {
  return (
    <div style={{ ...card, padding: 16 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>{children}</div>
      {note && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 10, lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}

/** One box: the system's figure and its source on top, the override underneath, the words beneath. */
function SysBox({ label, sys, value, onChange, format, inputMode = 'decimal', wide = false }) {
  const has = sys && sys.value !== null && sys.value !== undefined;
  const overriding = String(value ?? '').trim() !== '';
  return (
    <div style={{ display: 'grid', gap: 4, gridColumn: wide ? '1 / -1' : undefined }}>
      <span style={lbl}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minHeight: 22 }}>
        <span className="mono" style={{ ...mono, fontSize: 15, fontWeight: 700, color: has ? (overriding ? 'var(--t4)' : 'var(--t1)') : 'var(--t4)', textDecoration: has && overriding ? 'line-through' : 'none' }}>{has ? format(sys.value) : NA}</span>
        {has && sys.source && <Chip tone={overriding ? 't4' : 'acc'}>{sourceWord(sys.source)}</Chip>}
        {overriding && <Chip tone="orn">Override</Chip>}
      </div>
      <input style={{ ...field, borderColor: overriding ? 'var(--orn)' : undefined }} inputMode={inputMode} value={value} onChange={onChange} placeholder={has ? 'Override' : 'Type it'} title={sys?.words || ''} />
      <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.45 }}>{sys?.words || ''}{sys?.hint ? ` ${sys.hint}` : ''}</div>
    </div>
  );
}

function LogDay({ hq, recent, onSaved }) {
  const firstSite = hq.sites.some((s) => s.id === hq.locationId) ? hq.locationId : (hq.sites[0]?.id || '');
  const [siteId, setSiteId] = useState(firstSite);
  const [date, setDate] = useState(hq.today);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [saved, setSaved] = useState(null);
  const key = `${siteId}|${date}`;
  const site = hq.sites.find((s) => s.id === siteId) || null;
  const local = recent.find((r) => r.location_id === siteId && r.business_date === date) || null;

  // The boxes hold overrides only. They follow the picked site and day: when the pick changes the
  // form is reset in render (React's pattern for state that follows a prop).
  const [form, setForm] = useState(() => (local ? typedBoxes(local) : EMPTY));
  const [formKey, setFormKey] = useState(key);
  if (formKey !== key) { setFormKey(key); setForm(local ? typedBoxes(local) : EMPTY); setSaved(null); setMsg(null); }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // An older saved day is read from the database; the overrides fill when it answers.
  const [fetchedKey, setFetchedKey] = useState(local ? key : null);
  const loadingRow = !local && fetchedKey !== key;
  useEffect(() => {
    if (local || !siteId || !date) return undefined;
    let live = true;
    fetchDailyNumbers([siteId], date, date).then((r) => {
      if (!live) return;
      setFetchedKey(key);
      if (r.data?.[0]) setForm(typedBoxes(r.data[0]));
    });
    return () => { live = false; };
  }, [siteId, date, key, local]);

  // What the system knows for this site and day.
  // The site's own currency comes back with the trading figures; until then the active venue's.
  const [sys, setSys] = useState({ key: null, fields: null, problems: [], demoLeftOut: false, today: null, currency: null });
  useEffect(() => {
    if (!siteId || !date) return undefined;
    let live = true;
    const fallbackMoney = (n) => exactMoney(n, hq.currency, 2);
    const failed = (words) => { if (live) setSys({ key, fields: systemFields({ ymd: date, money: fallbackMoney }), problems: [words], demoLeftOut: false, today: null, currency: null }); };
    fetchSystemDay(siteId, date).then((r) => {
      if (!live) return;
      if (r.error || !r.data) { failed(r.message || 'The system figures could not be read.'); return; }
      const d = r.data;
      const cur = d.currency || hq.currency;
      setSys({ key, fields: systemFields({ ...d, ymd: date, money: (n) => exactMoney(n, cur, 2) }), problems: d.problems || [], demoLeftOut: d.demoLeftOut, today: d.today, currency: cur });
    }, () => failed('The system figures could not be read.'));
    return () => { live = false; };
  }, [siteId, date, key, hq.currency]);
  // The figures are for this pick once the answer carries its key; until then the screen is reading.
  const sysReady = sys.key === key;
  const fields = sysReady ? sys.fields : null;
  const currency = (sysReady && sys.currency) || hq.currency;
  const money = (n) => exactMoney(n, currency, 2);
  const f = (k) => fields?.[k] || null;

  // The preview reads the boxes the way the save does: an override wins, a blank takes the system figure.
  const resolved = resolveDay(form, fields || {}, siteId, date);
  const prime = primeCostPct({ net: resolved.net_sales, cogs: resolved.cogs, labour: resolved.labour });
  const overrides = SYSTEM_KEYS.filter((k) => String(form[k] ?? '').trim() !== '').length;
  const save = async () => {
    setSaving(true); setMsg(null); setSaved(null);
    const res = await saveDailyNumbers(resolveDay(form, fields || {}, siteId, date), hq.orgId, hq.userName);
    setSaving(false);
    if (res.error) { setMsg(res.message); return; }
    if (res.downgraded) setMsg(res.message);
    setSaved(`Saved ${site?.name || 'the site'} for ${dateText(date, currency)}${overrides ? ` with ${overrides} override${overrides === 1 ? '' : 's'}` : ', all from the system'}.`);
    onSaved();
  };
  const box = (k, label, format, opts = {}) => <SysBox key={k} label={label} sys={f(k)} value={form[k]} onChange={set(k)} format={format} {...opts} />;
  const partsTotal = f('projected_lunch')?.total;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, maxWidth: 560 }}>
        <Field label="Site"><select style={field} value={siteId} onChange={(e) => setSiteId(e.target.value)}>{hq.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Business date"><input type="date" style={field} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {loadingRow && <LoadingLine>Loading that day</LoadingLine>}
      {!sysReady && <LoadingLine>Reading the till, Workforce, stock, the forecast and reviews for this day</LoadingLine>}
      {sysReady && sys.problems.map((p, i) => <AmberLine key={i}>{p}</AmberLine>)}
      <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.5 }}>
        Each box shows what ServOS already knows for this site and day, and where it came from. Leave a box blank to keep that figure. Type in a box only to override it; the scorecard tags an override.
      </div>
      <Group title="Prime cost inputs" note={sys.demoLeftOut ? 'Demo sales are left out, the same as the reports.' : null}>
        {box('net_sales', 'Net sales', money)}{box('cogs', 'COGS', money)}{box('labour', 'Labour', money)}
        <div style={{ alignSelf: 'end', fontSize: 13, color: prime === null ? 'var(--t4)' : 'var(--t1)', fontWeight: 600 }}>
          {prime === null ? 'Prime cost needs all three' : `Prime cost reads ${prime}%`}
        </div>
      </Group>
      <Group title="Projected dayparts" note={partsTotal ? `The day's sales forecast is ${money(partsTotal)}. Change the forecast itself on the rota or under Purchasing, Forecast; type here only to override one daypart.` : null}>
        {box('projected_lunch', 'Lunch', money)}{box('projected_dinner', 'Dinner', money)}{box('projected_late', 'Late night', money)}
      </Group>
      <Group title="Team and guests">
        {box('reviews_count', 'New reviews', (n) => num(n), { inputMode: 'numeric' })}
        {box('review_rating', 'Average rating', (n) => Number(n).toFixed(2))}
        {box('turnover_pct', 'Turnover %', (n) => pct(n, 1))}
        {box('morale_score', 'Leadership morale /10', (n) => String(n))}
        {box('hires_needed', 'Hires still needed', (n) => num(n), { inputMode: 'numeric' })}
        <Field label="Notes for the owner" style={{ gridColumn: '1 / -1' }}><textarea style={{ ...field, minHeight: 56, resize: 'vertical' }} value={form.notes} onChange={set('notes')} /></Field>
      </Group>
      <AmberLine>{msg}</AmberLine>
      <GreenLine>{saved}</GreenLine>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Cash comes from the safe: see Safe and banking. Saving keeps today's figures as a record for the owner, overrides and all.</div>
        <button type="button" style={{ ...accBtn, ...disabled(saving || !siteId || !date || !sysReady) }} disabled={saving || !siteId || !date || !sysReady} onClick={save}>{saving ? 'Saving' : 'Save the day'}</button>
      </div>
    </div>
  );
}

function ImportCsv({ hq, onSaved }) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState([]);
  const [ignored, setIgnored] = useState([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [done, setDone] = useState(null);

  const run = async () => {
    setMsg(null); setDone(null);
    const parsed = parseNumbersCsv(text, hq.sites);
    setErrors(parsed.errors); setIgnored(parsed.ignoredColumns);
    if (parsed.errors.length) return;
    setSaving(true);
    const res = await saveDailyNumbers(parsed.rows, hq.orgId, hq.userName);
    setSaving(false);
    if (res.error) setMsg(res.message); else { setDone(`Imported ${parsed.count} row${parsed.count === 1 ? '' : 's'}.`); setText(''); onSaved(); }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 14, alignItems: 'start' }}>
      <div style={{ ...card, padding: 16, display: 'grid', gap: 10 }}>
        <textarea style={{ ...field, minHeight: 220, resize: 'vertical', ...mono, fontSize: 12 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={CSV_TEMPLATE} spellCheck={false} />
        {errors.length > 0 && (
          <div style={{ border: '1px solid var(--orn)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: 'var(--orn)' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Nothing was imported. Fix these and try again:</div>
            {errors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}
        {ignored.length > 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>Columns left out: {ignored.join(', ')}</div>}
        <AmberLine>{msg}</AmberLine>
        <GreenLine>{done}</GreenLine>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={btn} onClick={() => { setText(CSV_TEMPLATE); setErrors([]); setDone(null); }}>Fill with the template</button>
          <button type="button" style={{ ...accBtn, ...disabled(saving || !text.trim()) }} disabled={saving || !text.trim()} onClick={run}>{saving ? 'Importing' : 'Import rows'}</button>
        </div>
      </div>
      <div style={{ ...card, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 8 }}>Columns</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.6 }}>One row per site per day. The header row is required; store and date must be there, the rest may be blank. Labor or labour, site or store, both read.</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 10 }}>
          {CSV_COLUMNS.map((c) => <span key={c} className="mono" style={{ ...mono, fontSize: 11, color: 'var(--t2)', border: '1px solid var(--bdr)', borderRadius: 5, padding: '1px 6px' }}>{c}</span>)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 10 }}>Your sites: {hq.sites.map((s) => s.name).join(', ') || 'none found'}</div>
      </div>
    </div>
  );
}
