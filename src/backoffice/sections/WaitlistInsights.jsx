// src/backoffice/sections/WaitlistInsights.jsx
//
// Tables Ready — Insights (Back Office → Reports → Tables Ready).
// Walk-in performance for the selected period: parties added, seated +
// seat-through %, average wait, quote accuracy within ±5 min (the headline
// learning metric, rendered in ultraviolet), no-show rate and average party
// size — plus a waits/covers-by-hour view, the learned turn-time model
// (turn_time_stats), and a CSV export of the period.
//
// Reads come straight from the Ops DB under RLS and are table-absent / mock
// safe: every query is wrapped so a missing relation (migration not yet
// applied) or mock mode yields empty data and an informational note rather
// than throwing. Quote accuracy is computed by the shared learning engine
// (quoteAccuracy) so the Insights number matches what the estimator learns.

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase, isMock, getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { actualWaitMin, rowToWaitlist } from '../../lib/waitlist/waitlist';
import { quoteAccuracy } from '../../lib/waitlist/learning';
import { toCsv, downloadCsv } from './reports/_csv';
import { PERIODS, getPeriodRange, periodLabel } from './reports/_filters';

const FD = 'var(--font-display)';
const FM = 'var(--font-mono)';

const S = {
  wrap:  { height: '100%', overflowY: 'auto', padding: '22px 26px' },
  h1:    { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em', fontFamily: FD },
  sub:   { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18, maxWidth: 720 },
  bar:   { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 },
  seg:   { display: 'inline-flex', border: '1px solid var(--bdr2)', borderRadius: 999, overflow: 'hidden' },
  segBtn:(on) => ({ padding: '7px 14px', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: on ? 'var(--acc)' : 'transparent', color: on ? 'var(--ink, #06130C)' : 'var(--t2)' }),
  btn:   { padding: '8px 16px', borderRadius: 12, border: '1px solid var(--bdr2)', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--bg2)', color: 'var(--t1)' },
  sel:   { padding: '8px 12px', borderRadius: 12, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' },
  date:  { padding: '7px 10px', borderRadius: 10, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 12.5, fontFamily: FM },
  kpis:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 12, marginBottom: 18 },
  kpi:   { border: '1px solid var(--bdr)', borderRadius: 18, background: 'var(--bg1)', backgroundImage: 'var(--glass-bg)', padding: '14px 16px' },
  kLab:  { fontSize: 10.5, color: 'var(--t3)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', fontFamily: FM },
  kVal:  { fontSize: 28, fontWeight: 900, color: 'var(--t1)', marginTop: 6, fontFamily: FD, lineHeight: 1 },
  kSub:  { fontSize: 11, color: 'var(--t4)', marginTop: 5, fontWeight: 600, fontFamily: FM },
  card:  { border: '1px solid var(--bdr)', borderRadius: 18, background: 'var(--bg1)', backgroundImage: 'var(--glass-bg)', padding: 18, marginBottom: 16 },
  h2:    { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 14px', fontFamily: FD },
  empty: { textAlign: 'center', padding: '50px 20px', color: 'var(--t3)', fontSize: 14 },
  note:  { background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 12, padding: '10px 14px', fontSize: 12.5, color: 'var(--t3)', marginBottom: 16 },
  muted: { fontSize: 13, color: 'var(--t4)' },
  // by-hour bars
  hourRow: { display: 'grid', gridTemplateColumns: '54px 1fr 70px', gap: 12, alignItems: 'center', marginBottom: 6 },
  hourLab: { fontSize: 11.5, color: 'var(--t3)', fontFamily: FM, fontWeight: 700 },
  track:   { height: 18, background: 'var(--bg2)', borderRadius: 999, overflow: 'hidden', position: 'relative' },
  hourVal: { fontSize: 12, color: 'var(--t1)', textAlign: 'right', fontFamily: FM, fontWeight: 700 },
  // learned table
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th:    { textAlign: 'right', padding: '8px 10px', color: 'var(--t3)', fontWeight: 800, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '1px solid var(--bdr)', fontFamily: FM },
  thL:   { textAlign: 'left' },
  td:    { textAlign: 'right', padding: '9px 10px', color: 'var(--t1)', borderBottom: '1px solid var(--bdr)' },
  tdL:   { textAlign: 'left' },
};

const SEATED_SET = new Set(['seated', 'completed']);
const isMissingRelation = (err) =>
  err && /relation .* does not exist|could not find the table|schema cache|42P01/i.test(err.message || err.code || '');

export default function WaitlistInsights() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tableMissing, setTableMissing] = useState(false);
  const [entries, setEntries] = useState([]);   // period waitlist_entries (camelCase via rowToWaitlist)
  const [accuracy, setAccuracy] = useState([]);  // period quote_accuracy rows (snake_case from DB)
  const [turns, setTurns] = useState([]);        // turn_time_stats rows (per band; not period-scoped)

  const [periodId, setPeriodId] = useState('today');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [metric, setMetric] = useState('waits'); // 'waits' | 'covers'

  // Resolved [from,to] for the chosen period. No location config here — Insights
  // follows the simple calendar periods; business-day shifts live in the sales suite.
  const range = useMemo(() => getPeriodRange(periodId, custom), [periodId, custom]);

  const load = useCallback(async () => {
    setLoading(true);
    setTableMissing(false);
    try {
      const id = getActiveLocationSync() || (await getLocationId().catch(() => null));
      setLocId(id);
      if (isMock || !supabase || !id || id === 'loc-demo') {
        setEntries([]); setAccuracy([]); setTurns([]); setLoading(false); return;
      }
      const fromIso = range.from.toISOString();
      const toIso = range.to.toISOString();
      // Each read isolated so one absent relation never kills the others.
      const [eRes, aRes, tRes] = await Promise.all([
        supabase.from('waitlist_entries').select('*')
          .eq('location_id', id).gte('added_at', fromIso).lte('added_at', toIso)
          .order('added_at', { ascending: true }).limit(5000)
          .then((r) => r).catch((e) => ({ data: [], error: e })),
        supabase.from('quote_accuracy').select('*')
          .eq('location_id', id).gte('recorded_at', fromIso).lte('recorded_at', toIso)
          .limit(5000)
          .then((r) => r).catch((e) => ({ data: [], error: e })),
        supabase.from('turn_time_stats').select('*')
          .eq('location_id', id).order('party_band', { ascending: true }).limit(200)
          .then((r) => r).catch((e) => ({ data: [], error: e })),
      ]);
      setTableMissing(isMissingRelation(eRes.error));
      setEntries((eRes.data || []).map(rowToWaitlist).filter(Boolean));
      setAccuracy(aRes.data || []);
      setTurns(tRes.data || []);
    } catch {
      setEntries([]); setAccuracy([]); setTurns([]);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpi = useMemo(() => {
    const added = entries.length;
    const seated = entries.filter((e) => SEATED_SET.has(e.status));
    const noShow = entries.filter((e) => e.status === 'no_show');
    const waits = seated.map((e) => actualWaitMin(e)).filter((m) => Number.isFinite(m) && m >= 0);
    const avgWait = waits.length ? Math.round(waits.reduce((s, m) => s + m, 0) / waits.length) : null;
    const sizes = entries.map((e) => Number(e.size) || 0).filter((n) => n > 0);
    const avgSize = sizes.length ? (sizes.reduce((s, n) => s + n, 0) / sizes.length) : null;

    // Quote accuracy: prefer the recorded quote_accuracy rows; fall back to the
    // seated entries' first-quote vs actual when none have been logged yet.
    // Either way the maths goes through the shared learning engine.
    let accRows = accuracy.map((r) => ({ quoted: r.quoted_wait_min, actual: r.actual_wait_min }));
    if (!accRows.length) {
      accRows = seated.map((e) => ({ quoted: e.firstQuote ?? e.quoted, actual: actualWaitMin(e) }));
    }
    const acc = quoteAccuracy(accRows, { toleranceMin: 5 }); // { withinPct, mae, n }

    return {
      added,
      seated: seated.length,
      seatPct: added ? Math.round((seated.length / added) * 100) : null,
      avgWait,
      accPct: acc.n ? acc.withinPct : null,
      accMae: acc.n ? acc.mae : null,
      accN: acc.n,
      noShowPct: added ? Math.round((noShow.length / added) * 100) : 0,
      avgSize,
    };
  }, [entries, accuracy]);

  // ── by-hour (added parties → covers or average wait) ────────────────────────
  const byHour = useMemo(() => {
    const buckets = {};
    for (const e of entries) {
      if (!e.addedAt) continue;
      const h = new Date(e.addedAt).getHours();
      const b = (buckets[h] = buckets[h] || { parties: 0, covers: 0, waitSum: 0, waitN: 0 });
      b.parties += 1;
      b.covers += Number(e.size) || 0;
      if (SEATED_SET.has(e.status)) {
        const m = actualWaitMin(e);
        if (Number.isFinite(m)) { b.waitSum += m; b.waitN += 1; }
      }
    }
    const hours = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    if (!hours.length) return { rows: [], max: 0 };
    const lo = hours[0], hi = hours[hours.length - 1];
    const rows = [];
    for (let h = lo; h <= hi; h++) {
      const b = buckets[h] || { parties: 0, covers: 0, waitSum: 0, waitN: 0 };
      const val = metric === 'covers' ? b.covers : (b.waitN ? Math.round(b.waitSum / b.waitN) : 0);
      rows.push({ h, val, parties: b.parties, covers: b.covers });
    }
    return { rows, max: Math.max(1, ...rows.map((r) => r.val)) };
  }, [entries, metric]);

  // ── learned turn-time model (per party band) ────────────────────────────────
  const learnedRows = useMemo(() => (turns || [])
    .filter((t) => Number.isFinite(Number(t.avg_turn_min)))
    .sort((a, b) => String(a.party_band).localeCompare(String(b.party_band))), [turns]);

  const exportCsv = () => {
    const headers = [
      { label: 'Added', key: (e) => (e.addedAt ? new Date(e.addedAt).toLocaleString('en-GB') : '') },
      { label: 'Party', key: 'name' },
      { label: 'Size', key: 'size' },
      { label: 'Status', key: 'status' },
      { label: 'Quoted (min)', key: (e) => e.firstQuote ?? e.quoted ?? '' },
      { label: 'Actual wait (min)', key: (e) => { const m = actualWaitMin(e); return Number.isFinite(m) ? m : ''; } },
      { label: 'Zone', key: (e) => e.sectionPref || '' },
      { label: 'Source', key: 'source' },
      { label: 'Returning', key: (e) => (e.returning ? 'yes' : 'no') },
    ];
    const csv = toCsv(entries, headers);
    const tag = (periodId === 'custom' && custom.from) ? `${custom.from}_${custom.to || custom.from}` : periodId;
    downloadCsv(`tables-ready-${tag}.csv`, csv);
  };

  const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
  const rangeText = periodLabel(periodId, custom, range);

  if (loading) return <div style={S.empty}>Loading…</div>;

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>Tables Ready · Insights</h1>
      <div style={S.sub}>Walk-in performance — how many you took, how many you seated, and how close your quotes landed.</div>

      <div style={S.bar}>
        <select style={S.sel} value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
          {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {periodId === 'custom' && (
          <>
            <input type="date" style={S.date} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <span style={{ color: 'var(--t4)' }}>→</span>
            <input type="date" style={S.date} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </>
        )}
        <button style={S.btn} onClick={load}>↻ Refresh</button>
        <button style={S.btn} onClick={exportCsv} disabled={!entries.length}>↓ Export CSV</button>
        <span style={{ fontSize: 12, color: 'var(--t4)', marginLeft: 'auto', fontFamily: FM }}>{rangeText}</span>
      </div>

      {(isMock || !locId || locId === 'loc-demo') && (
        <div style={S.note}>Connect a real location to see live waitlist insights. (Demo / mock mode shows no data.)</div>
      )}
      {tableMissing && (
        <div style={S.note}>The waitlist tables aren't set up on this venue yet — insights will populate once the feature is live and parties start joining.</div>
      )}

      {/* KPI tiles */}
      <div style={S.kpis}>
        <Tile lab="Parties added" val={kpi.added} sub="walk-ins" />
        <Tile lab="Seated" val={kpi.seated} sub={kpi.seatPct != null ? `${kpi.seatPct}% of arrivals` : '—'} accent="grn" />
        <Tile lab="Avg wait" val={kpi.avgWait != null ? `${kpi.avgWait}m` : '—'} sub="seated parties" accent="uv" />
        <Tile
          lab="Quote accuracy"
          val={kpi.accPct != null ? `${kpi.accPct}%` : '—'}
          sub={kpi.accN
            ? `within ±5 min · ${kpi.accMae != null ? `${kpi.accMae}m MAE · ` : ''}${kpi.accN} samples`
            : 'within ±5 min'}
          accent="uv"
          big
        />
        <Tile lab="No-show rate" val={`${kpi.noShowPct}%`} sub="of parties added" accent={kpi.noShowPct >= 15 ? 'red' : undefined} />
        <Tile lab="Avg party size" val={kpi.avgSize != null ? kpi.avgSize.toFixed(1) : '—'} sub="guests / party" />
      </div>

      {/* by hour */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ ...S.h2, margin: 0 }}>By hour</h2>
          <div style={S.seg}>
            <button style={S.segBtn(metric === 'waits')} onClick={() => setMetric('waits')}>Avg wait</button>
            <button style={S.segBtn(metric === 'covers')} onClick={() => setMetric('covers')}>Covers</button>
          </div>
        </div>
        {byHour.rows.length === 0 ? (
          <div style={S.muted}>No parties added in this period.</div>
        ) : byHour.rows.map((r) => (
          <div key={r.h} style={S.hourRow}>
            <span style={S.hourLab}>{hourLabel(r.h)}</span>
            <div style={S.track}>
              <div style={{ height: '100%', width: `${Math.round((r.val / byHour.max) * 100)}%`, background: metric === 'covers' ? 'var(--uv)' : 'var(--grn)', borderRadius: 999, transition: 'width .2s' }} />
            </div>
            <span style={S.hourVal}>{metric === 'covers' ? `${r.val}` : (r.val ? `${r.val}m` : '—')}</span>
          </div>
        ))}
        <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8, fontFamily: FM }}>
          {metric === 'covers'
            ? 'Covers = total guests across parties added that hour (summed over the period).'
            : 'Average actual wait for parties seated in that hour (blank = none seated).'}
        </div>
      </div>

      {/* learned turn times */}
      <div style={S.card}>
        <h2 style={S.h2}>Learned turn times</h2>
        {learnedRows.length === 0 ? (
          <div style={S.muted}>
            No learned turn times yet. As tables are seated and closed, the system measures real dwell time per
            party size and feeds it back into the quote — replacing your seed values in Settings.
          </div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={{ ...S.th, ...S.thL }}>Party size</th>
                <th style={S.th}>Learned turn</th>
                <th style={S.th}>Samples</th>
                <th style={{ ...S.th, ...S.thL }}>Zone</th>
                <th style={S.th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {learnedRows.map((t) => (
                <tr key={t.id || `${t.party_band}-${t.section_id || 'all'}`}>
                  <td style={{ ...S.td, ...S.tdL }}><span style={{ fontWeight: 800, color: 'var(--uv)', fontFamily: FD }}>{t.party_band}</span></td>
                  <td style={{ ...S.td, fontFamily: FM, fontWeight: 800, color: 'var(--grn)' }}>{Math.round(Number(t.avg_turn_min))} min</td>
                  <td style={{ ...S.td, fontFamily: FM }}>{t.sample_count ?? 0}</td>
                  <td style={{ ...S.td, ...S.tdL, color: 'var(--t3)' }}>{t.section_id || 'all zones'}</td>
                  <td style={{ ...S.td, color: 'var(--t4)', fontSize: 12, fontFamily: FM }}>{t.updated_at ? new Date(t.updated_at).toLocaleDateString('en-GB') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Tile({ lab, val, sub, accent, big }) {
  const color = accent === 'grn' ? 'var(--grn)' : accent === 'uv' ? 'var(--uv)' : accent === 'red' ? 'var(--red)' : 'var(--t1)';
  return (
    <div style={{ ...S.kpi, ...(big ? { boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--uv) 38%, transparent)' } : null) }}>
      <div style={S.kLab}>{lab}</div>
      <div style={{ ...S.kVal, color }}>{val}</div>
      {sub && <div style={S.kSub}>{sub}</div>}
    </div>
  );
}
