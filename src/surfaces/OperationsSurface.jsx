// src/surfaces/OperationsSurface.jsx
//
// ServOS Operations — the mobile "manage on shift" surface (?mode=ops). Dark glass,
// thumb-first. Flow: pair the tablet → staff PIN → Home (compliance ring + area tiles)
// → Temperature checks (FSA-guided entry, °C/°F) → on a breach, a BLOCKED corrective
// screen (the compliance backbone) that auto-raises maintenance + alerts a manager via
// the ops_submit_reading RPC → Deliveries check-in that gates the stock receive.
//
// Thresholds/units/schedules are READ from admin config; this surface never defines them.

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  opsHeartbeat, opsRegisterDevice, opsPinLogin,
  fetchTempUnits, fetchSchedules, fetchReadings, submitReading,
  fetchExpectedDeliveries, checkDelivery, fetchAlerts,
} from '../lib/ops/data';
import {
  displayTemp, toStoredC, breach, typeDefault, hhmmToMin, runsOnDay, windowStatus, summarize,
} from '../lib/ops/temp';

// unit-type → glyph + category hue (the OKLCH identity scale, --h)
const TYPE_META = {
  fridge:    { glyph: '❄', h: 210 }, freezer: { glyph: '❄', h: 230 }, cold_hold: { glyph: '❄', h: 200 },
  hot_hold:  { glyph: '🔥', h: 38 }, cooking: { glyph: '🔥', h: 32 }, chill_down: { glyph: '❄', h: 220 },
  delivery:  { glyph: '📦', h: 48 },
};
const AREA_HUE = { Temperature: 200, Deliveries: 48, Checklists: 150, Cleaning: 285, Maintenance: 28 };
const CORRECTIVE_OPTIONS = [
  { key: 'moved_stock', label: 'Moved stock to spare unit' },
  { key: 'adjusted_thermostat', label: 'Adjusted thermostat' },
  { key: 'discarded', label: 'Discarded affected stock' },
  { key: 'called_engineer', label: 'Called engineer' },
];
const todayBounds = () => {
  const s = new Date(); s.setHours(0, 0, 0, 0);
  const e = new Date(s); e.setDate(e.getDate() + 1);
  return { fromIso: s.toISOString(), toIso: e.toISOString() };
};
const mono = { fontFamily: 'var(--font-mono)' };

export default function OperationsSurface() {
  const [stage, setStage] = useState('boot');      // boot | pair | pin | app
  const [loc, setLoc] = useState(null);
  const [venueName, setVenueName] = useState('');
  const [claimCode, setClaimCode] = useState('');
  const [operator, setOperator] = useState(null);  // { id, name, role }
  const [view, setView] = useState('home');        // home | temperature | delivery
  const [unitView, setUnitView] = useState(null);  // a unit being logged

  // dark ServOS skin for the whole surface
  useEffect(() => {
    const el = document.documentElement;
    const prevSkin = el.getAttribute('data-skin'), prevTheme = el.getAttribute('data-theme');
    el.setAttribute('data-skin', 'servos'); el.removeAttribute('data-theme'); // dark default
    return () => { if (prevSkin) el.setAttribute('data-skin', prevSkin); else el.removeAttribute('data-skin'); if (prevTheme) el.setAttribute('data-theme', prevTheme); };
  }, []);

  // boot: heartbeat → claimed? → PIN : pair
  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await opsHeartbeat();
      if (!live) return;
      if (data?.claimed && data.location_id) { setLoc(data.location_id); setVenueName(data.name || ''); setStage('pin'); }
      else {
        const reg = await opsRegisterDevice();
        if (!live) return;
        setClaimCode(reg.data?.claim_code || '');
        setStage('pair');
      }
    })();
    return () => { live = false; };
  }, []);

  // while pairing, poll until a manager claims this tablet
  useEffect(() => {
    if (stage !== 'pair') return;
    const t = setInterval(async () => {
      const { data } = await opsHeartbeat();
      if (data?.claimed && data.location_id) { setLoc(data.location_id); setVenueName(data.name || ''); setStage('pin'); }
    }, 5000);
    return () => clearInterval(t);
  }, [stage]);

  if (stage === 'boot') return <Screen><div style={{ color: 'var(--t3)', ...mono }}>Starting…</div></Screen>;
  if (stage === 'pair') return <PairScreen code={claimCode} />;
  if (stage === 'pin') return <PinScreen loc={loc} venueName={venueName} onOk={(op) => { setOperator(op); setStage('app'); }} />;

  return (
    <AppShell loc={loc} venueName={venueName} operator={operator} onLogout={() => { setOperator(null); setStage('pin'); }}>
      {unitView ? (
        <LogUnit loc={loc} unit={unitView} operator={operator} onDone={() => setUnitView(null)} />
      ) : view === 'temperature' ? (
        <Temperature loc={loc} onBack={() => setView('home')} onPick={(u) => setUnitView(u)} />
      ) : view === 'delivery' ? (
        <Deliveries loc={loc} operator={operator} onBack={() => setView('home')} />
      ) : (
        <Home loc={loc} venueName={venueName} operator={operator} onOpen={setView} />
      )}
    </AppShell>
  );
}

// ── chrome ───────────────────────────────────────────────────────────────────
function Screen({ children }) {
  return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)', color: 'var(--t1)' }}>{children}</div>;
}
function AppShell({ venueName, operator, onLogout, children }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--t1)', maxWidth: 480, margin: '0 auto', padding: '0 14px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 4px 12px' }}>
        <div className="sv-glass" style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', fontFamily: 'Syne, Space Grotesk, sans-serif', fontWeight: 800, color: 'var(--acc)' }}>S</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>{venueName || 'ServOS Ops'}</div>
          {operator && <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>{operator.name}</div>}
        </div>
        {operator && <button onClick={onLogout} className="btn btn-ghost btn-sm" style={{ padding: '6px 12px', fontSize: 12 }}>Switch</button>}
      </div>
      {children}
    </div>
  );
}

function PairScreen({ code }) {
  return (
    <Screen>
      <div className="sv-glass" style={{ padding: 28, textAlign: 'center', maxWidth: 340 }}>
        <div style={{ fontSize: 13, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>Pair this tablet</div>
        <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: '.12em', margin: '14px 0', color: 'var(--acc)', ...mono }}>{code || '······'}</div>
        <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5 }}>In Back Office → Operations → Sites, claim this device with the code above. This screen updates automatically once it's linked to a venue.</div>
      </div>
    </Screen>
  );
}

function PinScreen({ loc, venueName, onOk }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const submit = async (p) => {
    const { data, error } = await opsPinLogin(loc, p);
    if (error || !data?.ok) { setErr('PIN not recognised'); setPin(''); return; }
    onOk({ id: data.id, name: data.name, role: data.role });
  };
  const tap = (d) => { setErr(''); const next = (pin + d).slice(0, 6); setPin(next); if (next.length === 4) submit(next); };
  return (
    <Screen>
      <div style={{ textAlign: 'center', width: 280 }}>
        <div style={{ fontSize: 13, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>{venueName || 'ServOS'}</div>
        <div style={{ fontSize: 18, fontWeight: 800, margin: '6px 0 18px' }}>Enter your PIN</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 18 }}>
          {[0, 1, 2, 3].map(i => <div key={i} style={{ width: 14, height: 14, borderRadius: 999, background: i < pin.length ? 'var(--acc)' : 'var(--inset)', border: '1px solid var(--bdr2)' }} />)}
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => <PinKey key={n} onClick={() => tap(String(n))}>{n}</PinKey>)}
          <div /><PinKey onClick={() => tap('0')}>0</PinKey>
          <PinKey onClick={() => setPin(pin.slice(0, -1))}>⌫</PinKey>
        </div>
      </div>
    </Screen>
  );
}
const PinKey = ({ children, onClick }) => (
  <button onClick={onClick} className="sv-glass" style={{ height: 60, fontSize: 22, fontWeight: 700, color: 'var(--t1)', cursor: 'pointer', border: '1px solid var(--bdr)', ...mono }}>{children}</button>
);

// ── compute today's due/missed per unit (reads schedules + readings) ──────────
function useTodayStatus(loc) {
  const [state, setState] = useState({ units: [], byUnit: {}, summary: { compliancePct: 100, due: 0, missed: 0, done: 0 }, loading: true });
  const reload = useCallback(async () => {
    const { fromIso, toIso } = todayBounds();
    const [{ data: units }, { data: scheds }, { data: readings }] = await Promise.all([
      fetchTempUnits(loc), fetchSchedules(loc), fetchReadings(fromIso, toIso, loc),
    ]);
    const now = new Date(); const nowMin = now.getHours() * 60 + now.getMinutes();
    const schedByUnit = {}; (scheds || []).forEach(s => { (schedByUnit[s.tempUnitId] ??= []).push(s); });
    const readByUnit = {}; (readings || []).forEach(r => { (readByUnit[r.tempUnitId] ??= []).push(r); });
    const byUnit = {}; const allStatuses = [];
    (units || []).forEach(u => {
      const windows = (schedByUnit[u.id] || []).filter(s => runsOnDay(s.daysOfWeek, now)).map(s => {
        const wMin = hhmmToMin(s.timeOfDay) ?? 0;
        const satisfied = (readByUnit[u.id] || []).some(r => { const rd = new Date(r.recordedAt); return rd.getHours() * 60 + rd.getMinutes() >= wMin - 5; });
        return windowStatus({ windowMin: wMin, graceMin: s.graceMinutes, nowMin, satisfied });
      });
      const lastReading = (readByUnit[u.id] || []).sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))[0] || null;
      const st = summarize(windows);
      byUnit[u.id] = { windows, status: windows.length ? st.state : 'idle', due: st.due, missed: st.missed, lastReading };
      windows.forEach(w => allStatuses.push(w));
    });
    setState({ units: units || [], byUnit, summary: summarize(allStatuses), loading: false });
  }, [loc]);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

// ── Home: compliance ring + area tiles ───────────────────────────────────────
function Home({ loc, operator, onOpen }) {
  const { units, summary } = useTodayStatus(loc);
  const [deliveryCount, setDeliveryCount] = useState(null);
  const [openAlerts, setOpenAlerts] = useState(0);
  useEffect(() => {
    fetchExpectedDeliveries(loc).then(({ data }) => setDeliveryCount((data || []).filter(d => !d.delivery || d.delivery.status === 'pending').length));
    fetchAlerts(loc, true).then(({ data }) => setOpenAlerts((data || []).length));
  }, [loc]);
  const tiles = [
    { key: 'temperature', label: 'Temperature', sub: `${summary.due + summary.missed} of ${summary.total} due`, state: summary.missed ? 'over' : summary.due ? 'due' : 'done', hue: AREA_HUE.Temperature, onClick: () => onOpen('temperature') },
    { key: 'delivery', label: 'Deliveries', sub: deliveryCount == null ? '—' : `${deliveryCount} to check`, state: deliveryCount ? 'due' : 'done', hue: AREA_HUE.Deliveries, onClick: () => onOpen('delivery') },
    { key: 'checklists', label: 'Checklists', sub: 'Coming soon', state: 'idle', hue: AREA_HUE.Checklists, onClick: () => {} },
    { key: 'maintenance', label: 'Maintenance', sub: `${openAlerts} alert${openAlerts === 1 ? '' : 's'}`, state: openAlerts ? 'over' : 'idle', hue: AREA_HUE.Maintenance, onClick: () => {} },
  ];
  const ring = summary.compliancePct;
  return (
    <div>
      <div className="sv-glass" style={{ padding: '18px 20px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 19, fontWeight: 800 }}>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}{operator?.name ? `, ${operator.name.split(' ')[0]}` : ''}</div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3, textTransform: 'uppercase', letterSpacing: '.06em', ...mono }}>{new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()} · {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <Ring pct={ring} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {tiles.map(t => <AreaTile key={t.key} {...t} />)}
      </div>
    </div>
  );
}
function Ring({ pct }) {
  const r = 26, c = 2 * Math.PI * r, off = c * (1 - (Number(pct) || 0) / 100);
  const col = pct >= 90 ? 'var(--grn)' : pct >= 80 ? 'var(--orn)' : 'var(--red)';
  return (
    <div style={{ position: 'relative', width: 64, height: 64 }}>
      <svg width="64" height="64" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--inset)" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={col} strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 14, fontWeight: 800, color: col, ...mono }}>{pct}%</div>
    </div>
  );
}
const STATE_DOT = { done: 'var(--grn)', due: 'var(--orn)', over: 'var(--red)', idle: 'var(--t4)' };
function AreaTile({ label, sub, state, hue, onClick }) {
  return (
    <button onClick={onClick} className="sv-tile" style={{ '--h': hue, textAlign: 'left', padding: 16, minHeight: 96, cursor: 'pointer', color: 'var(--t1)', borderRadius: 16, position: 'relative', fontFamily: 'inherit' }}>
      <span style={{ position: 'absolute', top: 12, right: 12, width: 9, height: 9, borderRadius: 999, background: STATE_DOT[state], boxShadow: `0 0 8px ${STATE_DOT[state]}` }} />
      <div style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--inset)', fontSize: 17, marginBottom: 22 }}>
        {label === 'Temperature' ? '🌡' : label === 'Deliveries' ? '📦' : label === 'Checklists' ? '☑' : '🛠'}
      </div>
      <div style={{ fontSize: 14, fontWeight: 800 }}>{label}</div>
      <div style={{ fontSize: 11, color: state === 'done' ? 'var(--grn)' : state === 'over' ? 'var(--red)' : 'var(--t3)', marginTop: 2, ...mono }}>{sub}</div>
    </button>
  );
}

// ── Temperature list ─────────────────────────────────────────────────────────
function Temperature({ loc, onBack, onPick }) {
  const { units, byUnit, summary, loading, reload } = useTodayStatus(loc);
  const [unit, setUnit] = useState(localStorage.getItem('ops-temp-unit') || 'C');
  useEffect(() => { localStorage.setItem('ops-temp-unit', unit); }, [unit]);
  useEffect(() => { reload(); }, []);   // refresh on open
  return (
    <div>
      <Header title="Temperature checks" sub={`${summary.total} units`} right={`${summary.due + summary.missed} due`} rightState={summary.missed ? 'over' : 'due'} onBack={onBack} />
      <div className="sv-glass sv-pill" style={{ display: 'flex', padding: 4, marginBottom: 12, gap: 4 }}>
        {['C', 'F'].map(u => <button key={u} onClick={() => setUnit(u)} style={{ flex: 1, padding: '8px', borderRadius: 999, border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit', background: unit === u ? 'var(--acc)' : 'transparent', color: unit === u ? '#06130C' : 'var(--t2)' }}>°{u}</button>)}
      </div>
      {loading && <div style={{ color: 'var(--t3)', padding: 12, ...mono }}>Loading…</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {units.map(u => {
          const m = TYPE_META[u.type] || TYPE_META.fridge;
          const st = byUnit[u.id] || {};
          const lr = st.lastReading;
          const due = st.status === 'due' || st.status === 'over';
          const rd = lr ? displayTemp(lr.readingC, unit) : null;
          const range = `${displayTemp(u.targetMinC, unit).value}–${displayTemp(u.targetMaxC, unit).value}°${unit}`;
          return (
            <button key={u.id} onClick={() => onPick({ ...u, _displayUnit: unit })} className="sv-tile" style={{ '--h': m.h, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, cursor: 'pointer', color: 'var(--t1)', textAlign: 'left', fontFamily: 'inherit' }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--inset)', fontSize: 18 }}>{m.glyph}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{u.name}</div>
                <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{range}{lr ? ` · ${new Date(lr.recordedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
              </div>
              {due ? (
                <span className="btn btn-acc" style={{ padding: '8px 14px', fontSize: 13, fontWeight: 800, borderRadius: 999 }}>Log now</span>
              ) : lr ? (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 19, fontWeight: 800, color: lr.inRange ? 'var(--grn)' : 'var(--red)', ...mono }}>{rd.label}</div>
                  <div style={{ fontSize: 9.5, color: lr.inRange ? 'var(--grn)' : 'var(--red)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>{lr.inRange ? 'In range' : 'Breach'}</div>
                </div>
              ) : <span style={{ fontSize: 12, color: 'var(--t4)', ...mono }}>—</span>}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 14, lineHeight: 1.5, ...mono }}>✓ FSA: chilled ≤8°C (target 1–4); frozen ≤−18°C; hot holding ≥63°C.</div>
    </div>
  );
}

// ── Log a unit: keypad → in-range save, or BLOCKED corrective on breach ───────
function LogUnit({ loc, unit, operator, onDone }) {
  const dUnit = unit._displayUnit || 'C';
  const [raw, setRaw] = useState('');
  const [phase, setPhase] = useState('enter');   // enter | corrective
  const [corrective, setCorrective] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const def = typeDefault(unit.type);
  const readingC = toStoredC(raw, dUnit);
  const b = readingC == null ? null : breach(readingC, unit.targetMinC ?? def.min, unit.targetMaxC ?? def.max);

  const save = async () => {
    if (readingC == null) { setErr('Enter a reading'); return; }
    if (b && !b.inRange) { setPhase('corrective'); return; }   // breach → block, force corrective
    await commit(null);
  };
  const commit = async (corr) => {
    setBusy(true); setErr('');
    const { error } = await submitReading({ unitId: unit.id, readingC, source: 'manual', operatorId: operator?.id, operatorName: operator?.name, corrective: corr }, loc);
    setBusy(false);
    if (error) { setErr(error.message || 'Could not save'); return; }
    onDone();
  };

  if (phase === 'corrective') {
    return (
      <div>
        <Header title={unit.name} sub="Reading flagged" right="Blocked" rightState="over" onBack={() => setPhase('enter')} />
        <div className="sv-glass" style={{ padding: 18, marginBottom: 14, textAlign: 'center', border: '1px solid var(--red-b)', background: 'var(--red-d)' }}>
          <div style={{ fontSize: 11, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>⚠ Out of safe range</div>
          <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--red)', margin: '6px 0', textShadow: '0 0 22px rgba(255,90,74,.4)', ...mono }}>{displayTemp(readingC, dUnit).label}</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', ...mono }}>target {displayTemp(unit.targetMinC ?? def.min, dUnit).value}–{displayTemp(unit.targetMaxC ?? def.max, dUnit).value}°{dUnit} · {b.deltaC}° {b.direction}</div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 12, lineHeight: 1.5 }}>A reading above range needs a corrective action before the check can close.</div>
        <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8, ...mono }}>Corrective action — required</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {CORRECTIVE_OPTIONS.map(o => {
            const on = corrective === o.key;
            return (
              <button key={o.key} onClick={() => setCorrective(o.key)} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 14, cursor: 'pointer', textAlign: 'left', color: 'var(--t1)', border: `1px solid ${on ? 'var(--acc-b)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--glass-bg)' }}>
                <span style={{ width: 24, height: 24, borderRadius: 999, display: 'grid', placeItems: 'center', background: on ? 'var(--acc)' : 'transparent', border: `2px solid ${on ? 'var(--acc)' : 'var(--bdr3)'}`, color: '#06130C', fontWeight: 800, fontSize: 13 }}>{on ? '✓' : ''}</span>
                <span style={{ fontWeight: 600 }}>{o.label}</span>
              </button>
            );
          })}
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 12 }}>{err}</div>}
        <button onClick={() => corrective && commit({ action: corrective, description: CORRECTIVE_OPTIONS.find(o => o.key === corrective)?.label })} disabled={!corrective || busy}
          className="btn btn-acc" style={{ width: '100%', padding: 15, marginTop: 16, fontSize: 15, fontWeight: 800, borderRadius: 14, opacity: corrective && !busy ? 1 : 0.5 }}>
          {busy ? 'Saving…' : 'Confirm — raise maintenance & alert manager'}
        </button>
        <div style={{ fontSize: 11, color: 'var(--uv)', textAlign: 'center', marginTop: 8, ...mono }}>This auto-raises a maintenance request and alerts the duty manager.</div>
      </div>
    );
  }

  return (
    <div>
      <Header title={unit.name} sub={typeDefault(unit.type).label} onBack={onDone} />
      <div className="sv-glass" style={{ padding: 20, marginBottom: 14, textAlign: 'center' }}>
        <div style={{ fontSize: 48, fontWeight: 800, minHeight: 58, color: b && !b.inRange ? 'var(--red)' : b ? 'var(--grn)' : 'var(--t2)', ...mono }}>{raw ? `${raw}°${dUnit}` : <span style={{ color: 'var(--t4)' }}>—</span>}</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', ...mono }}>target {displayTemp(unit.targetMinC ?? def.min, dUnit).value}–{displayTemp(unit.targetMaxC ?? def.max, dUnit).value}°{dUnit}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>{unit.guidance || def.guidance}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '-', '0', '.'].map(k => (
          <button key={k} onClick={() => setRaw(r => (k === '.' && r.includes('.') ? r : k === '-' ? (r.startsWith('-') ? r.slice(1) : '-' + r) : (r + k)).slice(0, 6))}
            className="sv-glass" style={{ height: 56, fontSize: 22, fontWeight: 700, cursor: 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)', ...mono }}>{k}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <button onClick={() => setRaw(r => r.slice(0, -1))} className="btn btn-ghost" style={{ flex: '0 0 90px', padding: 14, fontSize: 15 }}>⌫</button>
        <button onClick={save} disabled={busy || readingC == null} className="btn btn-acc" style={{ flex: 1, padding: 14, fontSize: 15, fontWeight: 800, borderRadius: 14, opacity: readingC == null ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save reading'}</button>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 10 }}>{err}</div>}
    </div>
  );
}

// ── Deliveries: temp check gates the PO receive ──────────────────────────────
function Deliveries({ loc, operator, onBack }) {
  const [rows, setRows] = useState(null);
  const [active, setActive] = useState(null);
  const reload = useCallback(() => fetchExpectedDeliveries(loc).then(({ data }) => setRows(data || [])), [loc]);
  useEffect(() => { reload(); }, [reload]);
  if (active) return <DeliveryCheck loc={loc} operator={operator} row={active} onDone={() => { setActive(null); reload(); }} />;
  return (
    <div>
      <Header title="Deliveries" sub="Goods-in temperature check" onBack={onBack} />
      {rows == null && <div style={{ color: 'var(--t3)', padding: 12, ...mono }}>Loading…</div>}
      {rows && rows.length === 0 && <div className="sv-glass" style={{ padding: 18, color: 'var(--t3)', textAlign: 'center' }}>No deliveries due today.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(rows || []).map(({ po, delivery }) => (
          <button key={po.id} onClick={() => setActive({ po, delivery })} className="sv-tile" style={{ '--h': 48, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, cursor: 'pointer', color: 'var(--t1)', textAlign: 'left', fontFamily: 'inherit' }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--inset)', fontSize: 18 }}>📦</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{po.reference || `PO ${String(po.id).slice(0, 6)}`}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{po.lines?.length || 0} lines{po.expectedDate ? ` · ${po.expectedDate}` : ''}</div>
            </div>
            {delivery?.status === 'accepted' ? <Pill state="done">Accepted</Pill> : delivery?.status === 'rejected' ? <Pill state="over">Rejected</Pill> : <Pill state="due">Check</Pill>}
          </button>
        ))}
      </div>
    </div>
  );
}
function DeliveryCheck({ loc, operator, row, onDone }) {
  const { po } = row;
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const tempC = toStoredC(raw, 'C');
  const ACCEPT_MAX = 8;   // chilled delivery threshold (FSA)
  const overTemp = tempC != null && tempC > ACCEPT_MAX;
  const decide = async (accept) => {
    if (tempC == null) { setErr('Enter the delivery temperature'); return; }
    setBusy(true); setErr('');
    const { error } = await checkDelivery({
      poId: po.id, supplierId: po.supplierId, deliveryUnitId: null,   // no probe unit needed; gate by threshold
      temperatureC: tempC, accept, operatorId: operator?.id, operatorName: operator?.name,
      corrective: accept ? null : { action: 'rejected_delivery', description: 'Delivery over temperature' },
      rejectionReason: accept ? null : `Over ${ACCEPT_MAX}°C on arrival`,
    }, loc);
    setBusy(false);
    if (error) { setErr(error.message || 'Could not record'); return; }
    onDone();
  };
  return (
    <div>
      <Header title={po.reference || 'Delivery'} sub="Goods-in check" onBack={onDone} />
      <div className="sv-glass" style={{ padding: 18, marginBottom: 14, textAlign: 'center' }}>
        <div style={{ fontSize: 44, fontWeight: 800, color: overTemp ? 'var(--red)' : tempC != null ? 'var(--grn)' : 'var(--t2)', ...mono }}>{raw ? `${raw}°C` : <span style={{ color: 'var(--t4)' }}>—</span>}</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', ...mono }}>accept chilled ≤ {ACCEPT_MAX}°C</div>
      </div>
      {tempC != null && <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: overTemp ? 'var(--red)' : 'var(--grn)', marginBottom: 12 }}>{overTemp ? 'Recommend REJECT — over temperature' : 'OK to accept'}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '-', '0', '.'].map(k => (
          <button key={k} onClick={() => setRaw(r => (k === '.' && r.includes('.') ? r : k === '-' ? (r.startsWith('-') ? r.slice(1) : '-' + r) : (r + k)).slice(0, 6))}
            className="sv-glass" style={{ height: 52, fontSize: 20, fontWeight: 700, cursor: 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)', ...mono }}>{k}</button>
        ))}
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 10 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button onClick={() => decide(false)} disabled={busy} className="btn btn-red" style={{ flex: 1, padding: 14, fontWeight: 800, borderRadius: 14 }}>Reject</button>
        <button onClick={() => decide(true)} disabled={busy || tempC == null} className="btn btn-acc" style={{ flex: 1, padding: 14, fontWeight: 800, borderRadius: 14, opacity: tempC == null ? 0.5 : 1 }}>{busy ? '…' : 'Accept → stock'}</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--t3)', textAlign: 'center', marginTop: 8, ...mono }}>Accept receives the PO into stock. Reject posts no stock.</div>
    </div>
  );
}

// ── shared ───────────────────────────────────────────────────────────────────
function Header({ title, sub, right, rightState, onBack }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
      {onBack && <button onClick={onBack} className="sv-glass" style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--t1)', fontSize: 18, border: '1px solid var(--bdr)' }}>‹</button>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 800 }}>{title}</div>
        {sub && <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>{sub}</div>}
      </div>
      {right && <span style={{ fontSize: 13, fontWeight: 700, color: rightState === 'over' ? 'var(--red)' : rightState === 'due' ? 'var(--orn)' : 'var(--t3)', ...mono }}>{right}</span>}
    </div>
  );
}
const PILL_COL = { done: ['var(--grn-d)', 'var(--grn)', 'var(--grn-b)'], due: ['var(--acc-d)', 'var(--orn)', 'var(--bdr2)'], over: ['var(--red-d)', 'var(--red)', 'var(--red-b)'] };
function Pill({ state, children }) {
  const [bg, fg, bd] = PILL_COL[state] || PILL_COL.due;
  return <span style={{ fontSize: 11, fontWeight: 700, padding: '5px 11px', borderRadius: 999, background: bg, color: fg, border: `1px solid ${bd}`, ...mono }}>{children}</span>;
}
