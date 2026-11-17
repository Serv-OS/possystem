// src/backoffice/sections/headoffice/HqNumbers.jsx
//
// Head office, Daily numbers: "Feed the scorecard". Every reading the tills cannot know comes
// from here: one short entry per site per day (Log a day), or a pasted export (Import a CSV,
// src/lib/hq/numbersCsv.js: every row checked first, a single bad row stops the whole paste).
// Rows upsert on site + business date, so saving a day again replaces it.

import { useEffect, useMemo, useState } from 'react';
import { fetchDailyNumbers, saveDailyNumbers } from '../../../lib/hq/data.js';
import { primeCostPct } from '../../../lib/hq/primeCost.js';
import { parseNumbersCsv, CSV_TEMPLATE, CSV_COLUMNS } from '../../../lib/hq/numbersCsv.js';
import {
  page, card, mono, accBtn, btn, field, th, td, disabled, exactMoney, pct, num, dateText, addDays, NA,
  PageHead, SectionHead, Chip, AbsentCard, AmberLine, GreenLine, LoadingLine, TabRow, Field, hqHandoff,
} from './hqUi';

const NUMBER_KEYS = ['net_sales', 'cogs', 'labour', 'projected_lunch', 'projected_dinner', 'projected_late', 'cash_on_hand', 'reviews_count', 'review_rating', 'turnover_pct', 'morale_score', 'hires_needed'];
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

const formFromRow = (row) => Object.fromEntries([...NUMBER_KEYS, 'notes'].map((k) => [k, row?.[k] === null || row?.[k] === undefined ? '' : String(row[k])]));

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

      <SectionHead title="Last 14 days" sub="What is logged per site. Prime cost here is the typed figures only; the scorecard lets the till win." />
      {recent.loading && <LoadingLine>Loading</LoadingLine>}
      <AmberLine>{recent.error}</AmberLine>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead><tr>
            <th style={th}>Site</th><th style={th}>Date</th><th style={th}>Net sales</th><th style={th}>COGS</th><th style={th}>Labour</th><th style={th}>Prime</th>
            <th style={th}>Cash</th><th style={th}>Morale</th><th style={th}>Hires</th><th style={th}>Rating</th><th style={th}>Source</th>
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
                  <td style={{ ...td, ...mono }}>{exactMoney(r.cash_on_hand, hq.currency)}</td>
                  <td style={{ ...td, ...mono }}>{r.morale_score === null ? NA : r.morale_score}</td>
                  <td style={{ ...td, ...mono }}>{num(r.hires_needed)}</td>
                  <td style={{ ...td, ...mono }}>{r.review_rating === null ? NA : `${Number(r.review_rating).toFixed(1)}${r.reviews_count !== null ? ` (${r.reviews_count})` : ''}`}</td>
                  <td style={td}><Chip tone={r.source === 'csv' ? 'acc' : 't3'}>{r.source === 'csv' ? 'CSV' : 'Typed'}</Chip></td>
                </tr>
              );
            })}
            {!recent.loading && !recent.rows.length && <tr><td style={{ ...td, color: 'var(--t3)' }} colSpan={11}>Nothing logged in the last 14 days.</td></tr>}
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

function LogDay({ hq, recent, onSaved }) {
  const firstSite = hq.sites.some((s) => s.id === hq.locationId) ? hq.locationId : (hq.sites[0]?.id || '');
  const [siteId, setSiteId] = useState(firstSite);
  const [date, setDate] = useState(hq.today);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [saved, setSaved] = useState(null);
  const key = `${siteId}|${date}`;
  const local = recent.find((r) => r.location_id === siteId && r.business_date === date) || null;

  // The boxes follow the picked site and day: when the pick changes the form is reset in render
  // (React's pattern for state that follows a prop), from the recent list when the day is in it.
  const [form, setForm] = useState(() => (local ? formFromRow(local) : EMPTY));
  const [formKey, setFormKey] = useState(key);
  if (formKey !== key) { setFormKey(key); setForm(local ? formFromRow(local) : EMPTY); setSaved(null); setMsg(null); }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // An older day is read from the database; the boxes fill when it answers, if the pick is unchanged.
  const [fetchedKey, setFetchedKey] = useState(local ? key : null);
  const loadingRow = !local && fetchedKey !== key;
  useEffect(() => {
    if (local || !siteId || !date) return undefined;
    let live = true;
    fetchDailyNumbers([siteId], date, date).then((r) => {
      if (!live) return;
      setFetchedKey(key);
      if (r.data?.[0]) setForm(formFromRow(r.data[0]));
    });
    return () => { live = false; };
  }, [siteId, date, key, local]);

  // The preview reads the boxes the way the save does ("$5,230" is a number, not a blank).
  const cleaned = rowFromForm(form, siteId, date);
  const prime = primeCostPct({ net: cleaned.net_sales, cogs: cleaned.cogs, labour: cleaned.labour });
  const save = async () => {
    setSaving(true); setMsg(null); setSaved(null);
    const res = await saveDailyNumbers(rowFromForm(form, siteId, date), hq.orgId, hq.userName);
    setSaving(false);
    if (res.error) setMsg(res.message); else { setSaved(`Saved ${hq.sites.find((s) => s.id === siteId)?.name || 'the site'} for ${dateText(date, hq.currency)}.`); onSaved(); }
  };
  const money = (k, label) => <Field key={k} label={label}><input style={field} inputMode="decimal" value={form[k]} onChange={set(k)} placeholder="0" /></Field>;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, maxWidth: 560 }}>
        <Field label="Site"><select style={field} value={siteId} onChange={(e) => setSiteId(e.target.value)}>{hq.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Business date"><input type="date" style={field} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {loadingRow && <LoadingLine>Loading that day</LoadingLine>}
      <Group title="Prime cost inputs" note="Leave these blank at a site whose tills and stock are on ServOS, the till's figures win.">
        {money('net_sales', 'Net sales')}{money('cogs', 'COGS')}{money('labour', 'Labour')}
        <div style={{ alignSelf: 'end', fontSize: 13, color: prime === null ? 'var(--t4)' : prime < 60 ? 'var(--grn)' : 'var(--orn)', fontWeight: 600 }}>
          {prime === null ? 'Prime cost needs all three' : `Prime cost reads ${prime}% as you type`}
        </div>
      </Group>
      <Group title="Projected dayparts">
        {money('projected_lunch', 'Lunch')}{money('projected_dinner', 'Dinner')}{money('projected_late', 'Late night')}
      </Group>
      <Group title="Team and guests">
        {money('cash_on_hand', 'Cash on hand')}
        <Field label="New reviews"><input style={field} inputMode="numeric" value={form.reviews_count} onChange={set('reviews_count')} placeholder="0" /></Field>
        <Field label="Average rating"><input style={field} inputMode="decimal" value={form.review_rating} onChange={set('review_rating')} placeholder="0 to 5" /></Field>
        <Field label="Turnover %"><input style={field} inputMode="decimal" value={form.turnover_pct} onChange={set('turnover_pct')} placeholder="0" /></Field>
        <Field label="Leadership morale /10"><input style={field} inputMode="decimal" value={form.morale_score} onChange={set('morale_score')} placeholder="0 to 10" /></Field>
        <Field label="Hires still needed"><input style={field} inputMode="numeric" value={form.hires_needed} onChange={set('hires_needed')} placeholder="0" /></Field>
        <Field label="Notes for the owner" style={{ gridColumn: '1 / -1' }}><textarea style={{ ...field, minHeight: 56, resize: 'vertical' }} value={form.notes} onChange={set('notes')} /></Field>
      </Group>
      <AmberLine>{msg}</AmberLine>
      <GreenLine>{saved}</GreenLine>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" style={{ ...accBtn, ...disabled(saving || !siteId || !date) }} disabled={saving || !siteId || !date} onClick={save}>{saving ? 'Saving' : 'Save the day'}</button>
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
