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
  fetchExpectedDeliveries, checkDelivery, fetchAlerts, createMaintenance, fetchMaintenance, ackAlert,
} from '../lib/ops/data';
import { fetchTodayChecklists, openRun, completeTask, signOffRun } from '../lib/ops/checklists';
import {
  displayTemp, toStoredC, breach, typeDefault, hhmmToMin, runsOnDay, windowStatus, summarize,
} from '../lib/ops/temp';
import { Icon } from '../components/ServOSIcons';
import { ensureAuthToken } from '../lib/supabase';

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
  const [view, setView] = useState('home');        // home | temperature | delivery | checklists | maintenance | alerts
  const [unitView, setUnitView] = useState(null);  // a unit being logged
  const [maintPrefill, setMaintPrefill] = useState(null); // {unitName, temp} when raising off a breach
  const [clFilter, setClFilter] = useState(null);  // checklist tile → which kind to show

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
      await ensureAuthToken();   // anon session → stable auth.uid() for device_uid + RLS (mirrors menu-board pairing)
      if (!live) return;
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

  const openView = (v, opts = {}) => { if ('clFilter' in opts) setClFilter(opts.clFilter ?? null); setView(v); };
  return (
    <AppShell loc={loc} venueName={venueName} operator={operator}
      onLogout={() => { setOperator(null); setStage('pin'); }}
      onBell={() => setView('alerts')}>
      {unitView ? (
        <LogUnit loc={loc} unit={unitView} operator={operator} onDone={() => setUnitView(null)} />
      ) : view === 'temperature' ? (
        <Temperature loc={loc} onBack={() => setView('home')} onPick={(u) => setUnitView(u)} />
      ) : view === 'delivery' ? (
        <Deliveries loc={loc} operator={operator} onBack={() => setView('home')} />
      ) : view === 'checklists' ? (
        <Checklists loc={loc} operator={operator} filter={clFilter} onBack={() => setView('home')} />
      ) : view === 'maintenance' ? (
        <Maintenance loc={loc} operator={operator} prefill={maintPrefill}
          onBack={() => { setMaintPrefill(null); setView('home'); }} />
      ) : view === 'alerts' ? (
        <Alerts loc={loc} operator={operator} onBack={() => setView('home')} />
      ) : (
        <Home loc={loc} venueName={venueName} operator={operator} onOpen={openView} />
      )}
    </AppShell>
  );
}

// ── chrome ───────────────────────────────────────────────────────────────────
function Screen({ children }) {
  return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)', color: 'var(--t1)' }}>{children}</div>;
}
function AppShell({ loc, venueName, operator, onLogout, onBell, children }) {
  const [alerts, setAlerts] = useState(0);
  useEffect(() => { if (loc) fetchAlerts(loc, true).then(({ data }) => setAlerts((data || []).length)); }, [loc]);
  return (
    <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', background: 'var(--bg)', color: 'var(--t1)', maxWidth: 480, margin: '0 auto', padding: '0 14px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 4px 12px' }}>
        <div className="sv-glass" style={{ width: 36, height: 36, borderRadius: 11, display: 'grid', placeItems: 'center', fontFamily: 'Syne, Space Grotesk, sans-serif', fontWeight: 800, color: 'var(--acc)', flexShrink: 0 }}>S</div>
        <button onClick={onLogout} title="Tap to switch user" style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontFamily: 'inherit' }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venueName || 'ServOS Ops'}</div>
          {operator && <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>{operator.name}</div>}
        </button>
        {operator && (
          <button onClick={onBell} aria-label="Alerts" className="sv-glass" style={{ position: 'relative', width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)', flexShrink: 0 }}>
            <Icon name="bell" size={19} />
            {alerts > 0 && <span style={{ position: 'absolute', top: 7, right: 8, width: 8, height: 8, borderRadius: 999, background: 'var(--coral, var(--red))', boxShadow: '0 0 6px var(--coral, var(--red))' }} />}
          </button>
        )}
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
        <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5 }}>In Back Office → Operations → Devices, enter this code to pair this tablet. This screen updates automatically once it's linked to a venue.</div>
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

// classify a checklist into a home-tile "kind" by its area/name keywords
const CL_KINDS = [
  { test: s => s.includes('clean'),                        key: 'cleaning', label: 'Cleaning',      icon: 'sparkle',   hue: 285, order: 2 },
  { test: s => s.includes('open'),                         key: 'opening',  label: 'Opening checks', icon: 'clipboard', hue: 150, order: 1 },
  { test: s => s.includes('clos') || s.includes('night'), key: 'closing',  label: 'Closing checks', icon: 'clipboard', hue: 40,  order: 4 },
];
const CL_FALLBACK = { key: 'checks', label: 'Checklists', icon: 'clipboard', hue: 150, order: 3 };
function classifyChecklist(c) {
  const s = `${c.area || ''} ${c.name || ''}`.toLowerCase();
  return CL_KINDS.find(k => k.test(s)) || CL_FALLBACK;
}

// ── Home: compliance ring + area tiles ───────────────────────────────────────
function Home({ loc, operator, onOpen }) {
  const { summary } = useTodayStatus(loc);
  const [deliveryCount, setDeliveryCount] = useState(null);
  const [openMaint, setOpenMaint] = useState(0);
  const [clKinds, setClKinds] = useState(null);   // [{key,label,icon,hue,order,due,total}]
  const [clTasks, setClTasks] = useState({ done: 0, total: 0 });
  useEffect(() => {
    fetchExpectedDeliveries(loc).then(({ data }) => setDeliveryCount((data || []).filter(d => !d.delivery || d.delivery.status === 'pending').length));
    fetchMaintenance(loc).then(({ data }) => setOpenMaint((data || []).filter(m => !['resolved', 'cancelled'].includes(m.status)).length));
    fetchTodayChecklists(loc).then(({ data }) => {
      const list = data || [];
      const groups = {}; let tDone = 0, tTotal = 0;
      list.forEach(c => {
        const k = classifyChecklist(c);
        const g = (groups[k.key] ??= { ...k, due: 0, total: 0 });
        g.due += (c.status !== 'done') ? 1 : 0; g.total += 1;
        tDone += (c.doneCount || 0); tTotal += (c.total || 0);
      });
      setClKinds(Object.values(groups).sort((a, b) => a.order - b.order));
      setClTasks({ done: tDone, total: tTotal });
    });
  }, [loc]);
  const clTiles = (clKinds || []).map(k => ({
    key: `cl-${k.key}`, label: k.label, icon: k.icon, hue: k.hue,
    sub: k.due === 0 ? 'All done' : `${k.total - k.due} / ${k.total} done`,
    state: k.due === 0 ? 'done' : 'due', onClick: () => onOpen('checklists', { clFilter: k.key }),
  }));
  const tiles = [
    { key: 'temperature', label: 'Temperature', icon: 'thermo', sub: `${summary.due + summary.missed} of ${summary.total} due`, state: summary.missed ? 'over' : summary.due ? 'due' : 'done', hue: AREA_HUE.Temperature, onClick: () => onOpen('temperature') },
    ...clTiles,
    { key: 'delivery', label: 'Deliveries', icon: 'inventory', sub: deliveryCount == null ? '—' : `${deliveryCount} to check`, state: deliveryCount ? 'due' : 'done', hue: AREA_HUE.Deliveries, onClick: () => onOpen('delivery') },
    { key: 'maintenance', label: 'Maintenance', icon: 'wrench', sub: openMaint ? `${openMaint} open` : 'All clear', state: openMaint ? 'over' : 'idle', hue: AREA_HUE.Maintenance, onClick: () => onOpen('maintenance') },
  ];
  // Overall today progress = temperature checks done + checklist tasks done, over everything due today.
  const tempReq = summary.done + summary.due + summary.missed;
  const reqAll = tempReq + clTasks.total;
  const ring = reqAll > 0 ? Math.round(((summary.done + clTasks.done) / reqAll) * 100) : 100;
  const ringOverdue = summary.missed > 0;
  return (
    <div>
      <div className="sv-glass" style={{ padding: '18px 20px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 19, fontWeight: 800 }}>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}{operator?.name ? `, ${operator.name.split(' ')[0]}` : ''}</div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3, textTransform: 'uppercase', letterSpacing: '.06em', ...mono }}>{new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()} · {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <Ring pct={ring} overdue={ringOverdue} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {tiles.map(t => <AreaTile key={t.key} {...t} />)}
      </div>
    </div>
  );
}
function Ring({ pct, overdue }) {
  const r = 26, c = 2 * Math.PI * r, off = c * (1 - (Number(pct) || 0) / 100);
  // progress ring: brand green; amber only when something is actually overdue
  const col = overdue ? 'var(--orn)' : 'var(--grn)';
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
function AreaTile({ label, icon, sub, state, hue, onClick }) {
  return (
    <button onClick={onClick} className="sv-tile" style={{ '--h': hue, textAlign: 'left', padding: 16, minHeight: 96, cursor: 'pointer', color: 'var(--t1)', borderRadius: 16, position: 'relative', fontFamily: 'inherit' }}>
      <span style={{ position: 'absolute', top: 12, right: 12, width: 9, height: 9, borderRadius: 999, background: STATE_DOT[state], boxShadow: `0 0 8px ${STATE_DOT[state]}` }} />
      <div style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'oklch(0.8 0.12 var(--h) / 0.18)', color: 'oklch(0.85 0.14 var(--h))', marginBottom: 22 }}>
        <Icon name={icon || 'list'} size={19} />
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
  const h = new Date().getHours();
  const roundName = h < 12 ? 'AM round' : h < 17 ? 'PM round' : 'Evening round';
  return (
    <div>
      <Header title="Temperature checks" sub={`${roundName} · ${summary.total} units`} right={`${summary.due + summary.missed} due`} rightState={summary.missed ? 'over' : 'due'} onBack={onBack} />
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
          const hot = u.type === 'hot_hold' || u.type === 'cooking';
          return (
            <button key={u.id} onClick={() => onPick({ ...u, _displayUnit: unit })} className="sv-tile" style={{ '--h': m.h, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, cursor: 'pointer', color: 'var(--t1)', textAlign: 'left', fontFamily: 'inherit' }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: `oklch(0.8 0.12 ${m.h} / 0.18)`, color: `oklch(0.85 0.14 ${m.h})` }}><Icon name={hot ? 'fire' : 'snow'} size={20} /></div>
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 11, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}><Icon name="warn" size={14} /> Out of safe range</div>
          <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--red)', margin: '6px 0', textShadow: '0 0 22px rgba(255,90,74,.4)', ...mono }}>{displayTemp(readingC, dUnit).label}</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', ...mono }}>target {displayTemp(unit.targetMinC ?? def.min, dUnit).value}–{displayTemp(unit.targetMaxC ?? def.max, dUnit).value}°{dUnit} · {b.deltaC}° {b.direction} · {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
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
            <div style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'oklch(0.8 0.12 48 / 0.18)', color: 'oklch(0.85 0.14 48)' }}><Icon name="inventory" size={20} /></div>
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

// ── Checklists: today's lists → run-through with sign-off ─────────────────────
const CL_KIND_LABEL = { opening: 'Opening checks', closing: 'Closing checks', cleaning: 'Cleaning', checks: 'Checklists' };
function Checklists({ loc, operator, filter, onBack }) {
  const [all, setAll] = useState(null);
  const [active, setActive] = useState(null);
  const reload = useCallback(() => fetchTodayChecklists(loc).then(({ data }) => setAll(data || [])), [loc]);
  useEffect(() => { reload(); }, [reload]);
  if (active) return <ChecklistRun loc={loc} operator={operator} checklist={active} onDone={() => { setActive(null); reload(); }} />;
  const rows = all == null ? null : (filter ? all.filter(c => classifyChecklist(c).key === filter) : all);
  return (
    <div>
      <Header title={filter ? (CL_KIND_LABEL[filter] || 'Checklists') : 'Checklists'} sub="Today" onBack={onBack} />
      {rows == null && <div style={{ color: 'var(--t3)', padding: 12, ...mono }}>Loading…</div>}
      {rows && rows.length === 0 && <div className="sv-glass" style={{ padding: 18, color: 'var(--t3)', textAlign: 'center' }}>No {filter ? (CL_KIND_LABEL[filter] || 'checklists').toLowerCase() : 'checklists'} due today.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(rows || []).map(c => (
          <button key={c.id} onClick={() => setActive(c)} className="sv-tile" style={{ '--h': AREA_HUE.Checklists, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, cursor: 'pointer', color: 'var(--t1)', textAlign: 'left', fontFamily: 'inherit' }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: `oklch(0.8 0.12 ${AREA_HUE.Checklists} / 0.18)`, color: `oklch(0.85 0.14 ${AREA_HUE.Checklists})` }}><Icon name="clipboard" size={19} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{c.name}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{c.area} · {c.doneCount}/{c.total} done{c.timeOfDay ? ` · ${c.timeOfDay}` : ''}</div>
            </div>
            {c.status === 'done' ? <Pill state="done">Done</Pill> : c.status === 'missed' ? <Pill state="over">Overdue</Pill> : <Pill state="due">{c.doneCount > 0 ? 'Resume' : 'Start'}</Pill>}
          </button>
        ))}
      </div>
    </div>
  );
}
function ChecklistRun({ loc, operator, checklist, onDone }) {
  const [run, setRun] = useState(checklist.run || null);
  const [done, setDone] = useState(() => { const m = {}; (checklist.completions || []).forEach(c => { if (c.done) m[c.taskId] = c; }); return m; });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (!run) openRun(checklist.id, loc).then(({ data }) => setRun(data)); }, []);
  const total = checklist.tasks.length;
  const completed = Object.keys(done).length;
  const pct = total ? Math.round((completed / total) * 100) : 0;

  const toggle = async (task) => {
    if (!run) return;
    if (done[task.id]) { // untick
      const n = { ...done }; delete n[task.id]; setDone(n);
      await completeTask(run.id, task.id, { done: false, by: operator?.name, byId: operator?.id }, loc);
    } else {
      setDone(d => ({ ...d, [task.id]: { taskId: task.id, by: operator?.name, at: new Date().toISOString() } }));
      await completeTask(run.id, task.id, { done: true, by: operator?.name, byId: operator?.id }, loc);
    }
  };
  const sign = async () => {
    if (completed < total) { setErr('Complete every task before signing off'); return; }
    setBusy(true); const { error } = await signOffRun(run.id, operator?.name, operator?.id, loc); setBusy(false);
    if (error) { setErr(error.message || 'Could not sign off'); return; }
    onDone();
  };
  const cadence = (checklist.frequency || checklist.cadence || 'Daily').toUpperCase();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  return (
    <div>
      <Header title={checklist.name} sub={`${cadence} · ${completed} / ${total}`} right={checklist.timeOfDay || null} rightState="due" onBack={onDone} />
      <div className="sv-glass" style={{ padding: '12px 16px', marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--t3)', marginBottom: 6, ...mono }}><span>{completed}/{total} done</span><span>{pct}%</span></div>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--inset)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,var(--grn),var(--acc2,#2FD984))', borderRadius: 4 }} /></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {checklist.tasks.map(t => {
          const cm = done[t.id]; const on = !!cm;
          const overdue = !on && t.dueBy && (hhmmToMin(t.dueBy) ?? 1e9) < nowMin;
          const at = cm && (cm.at || cm.completedAt);
          const timeStr = at ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
          const meta = on ? [cm.by, timeStr].filter(Boolean).join(' · ')
            : t.evidenceRequired ? 'Photo required'
            : t.tempUnitId ? (t.tempUnitCount ? `Linked · ${t.tempUnitCount} units` : 'Linked')
            : overdue ? `Was due ${t.dueBy}` : null;
          const metaCol = overdue ? 'var(--red)' : (t.tempUnitId && !on) ? 'var(--uv)' : 'var(--t3)';
          return (
            <button key={t.id} onClick={() => toggle(t)} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderRadius: 14, cursor: 'pointer', textAlign: 'left', color: 'var(--t1)', border: `1px solid ${on ? 'var(--acc-b)' : overdue ? 'var(--red-b)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--glass-bg)' }}>
              <span style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center', background: on ? 'var(--acc)' : 'transparent', border: `2px solid ${on ? 'var(--acc)' : overdue ? 'var(--red)' : 'var(--bdr3)'}`, color: overdue && !on ? 'var(--red)' : '#06130C' }}>
                {on ? <Icon name="check" size={15} /> : overdue ? <Icon name="warn" size={13} /> : null}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, textDecoration: on ? 'line-through' : 'none', color: on ? 'var(--t3)' : 'var(--t1)' }}>{t.label}</div>
                {meta && <div style={{ fontSize: 11, color: metaCol, marginTop: 2, ...mono }}>{meta}</div>}
              </div>
              {t.evidenceRequired && <Icon name="camera" size={17} style={{ color: on ? 'var(--t4)' : 'var(--amber, var(--orn))' }} />}
            </button>
          );
        })}
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 10 }}>{err}</div>}
      <button onClick={sign} disabled={busy || completed < total} className="btn btn-acc" style={{ width: '100%', padding: 15, marginTop: 16, fontSize: 15, fontWeight: 800, borderRadius: 14, opacity: completed < total ? 0.5 : 1 }}>
        {busy ? 'Signing…' : `Sign off${operator?.name ? ` — ${operator.name.split(' ')[0]}` : ''}`}
      </button>
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

// ── Maintenance: list ongoing requests + raise a new one ─────────────────────
const MAINT_STATUS = { open: ['var(--red-d)', 'var(--red)'], assigned: ['var(--acc-d)', 'var(--orn)'], in_progress: ['var(--acc-d)', 'var(--acc)'], resolved: ['var(--grn-d)', 'var(--grn)'], cancelled: ['var(--inset)', 'var(--t3)'] };
function Maintenance({ loc, operator, prefill, onBack }) {
  const [rows, setRows] = useState(null);
  const [raising, setRaising] = useState(!!prefill);
  const reload = useCallback(() => fetchMaintenance(loc).then(({ data }) => setRows(data || [])), [loc]);
  useEffect(() => { reload(); }, [reload]);
  if (raising) return <RaiseMaintenance loc={loc} operator={operator} prefill={prefill} onBack={() => { setRaising(false); reload(); }} />;
  const open = (rows || []).filter(m => !['resolved', 'cancelled'].includes(m.status));
  const closed = (rows || []).filter(m => ['resolved', 'cancelled'].includes(m.status));
  return (
    <div>
      <Header title="Maintenance" sub={rows == null ? '' : `${open.length} open`} onBack={onBack} />
      <button onClick={() => setRaising(true)} className="btn btn-acc" style={{ width: '100%', padding: 13, marginBottom: 14, fontSize: 14, fontWeight: 800, borderRadius: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Icon name="plus" size={16} /> Raise a request</button>
      {rows == null && <div style={{ color: 'var(--t3)', padding: 12, ...mono }}>Loading…</div>}
      {rows && open.length === 0 && <div className="sv-glass" style={{ padding: 18, color: 'var(--t3)', textAlign: 'center' }}>No open maintenance.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {open.map(m => <MaintRow key={m.id} m={m} />)}
      </div>
      {closed.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '18px 0 8px', ...mono }}>Recently closed</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{closed.slice(0, 5).map(m => <MaintRow key={m.id} m={m} muted />)}</div>
        </>
      )}
    </div>
  );
}
function MaintRow({ m, muted }) {
  const [bg, fg] = MAINT_STATUS[m.status] || MAINT_STATUS.open;
  const prioCol = m.priority === 'urgent' ? 'var(--red)' : m.priority === 'high' ? 'var(--amber, var(--orn))' : 'var(--t3)';
  return (
    <div className="sv-glass" style={{ padding: '12px 14px', borderRadius: 14, opacity: muted ? 0.6 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: fg, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{m.title}</div>
          <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{m.reporterName || '—'} · {new Date(m.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}{m.assigneeName ? ` · ${m.assigneeName}` : ''}{m.source === 'temp_breach' ? ' · auto' : ''}</div>
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: prioCol, textTransform: 'uppercase', ...mono }}>{m.priority}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: fg, background: bg, padding: '3px 8px', borderRadius: 999, ...mono }}>{(m.status || '').replace('_', ' ')}</span>
      </div>
      {m.description && <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 6, paddingLeft: 19 }}>{m.description}</div>}
    </div>
  );
}

// ── Notifications (the bell): ops alerts, acknowledge inline ──────────────────
function Alerts({ loc, operator, onBack }) {
  const [rows, setRows] = useState(null);
  const reload = useCallback(() => fetchAlerts(loc, false).then(({ data }) => setRows(data || [])), [loc]);
  useEffect(() => { reload(); }, [reload]);
  const ack = async (a) => { await ackAlert(a.id, 'Acknowledged', operator?.name); reload(); };
  const unreadN = (rows || []).filter(a => a.status === 'sent').length;
  return (
    <div>
      <Header title="Notifications" sub={rows == null ? '' : `${unreadN} unread`} onBack={onBack} />
      {rows == null && <div style={{ color: 'var(--t3)', padding: 12, ...mono }}>Loading…</div>}
      {rows && rows.length === 0 && <div className="sv-glass" style={{ padding: 18, color: 'var(--t3)', textAlign: 'center' }}>No notifications.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(rows || []).map(a => {
          const unread = a.status === 'sent';
          const tone = (a.severity === 'critical' || a.type === 'temp_breach') ? 'var(--red)' : a.severity === 'major' ? 'var(--amber, var(--orn))' : 'var(--acc)';
          return (
            <div key={a.id} className="sv-glass" style={{ padding: '12px 14px', borderRadius: 14, borderLeft: `3px solid ${tone}`, opacity: unread ? 1 : 0.6 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{a.title}</div>
                  {a.body && <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 2 }}>{a.body}</div>}
                  <div style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 4, ...mono }}>{new Date(a.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{a.acknowledgedByName ? ` · ack ${a.acknowledgedByName}` : ''}</div>
                </div>
                {unread && <button onClick={() => ack(a)} className="btn btn-acc" style={{ padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 999, flexShrink: 0, border: 0, cursor: 'pointer', fontFamily: 'inherit' }}>Got it</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Raise maintenance (manual request, thumb-first) ───────────────────────────
const MAINT_ISSUES = ['Not holding temp', 'Door seal', 'Noise', 'Leak', 'Other'];
const MAINT_PRIOS = [['low', 'Low'], ['normal', 'Med'], ['high', 'High'], ['urgent', 'Urgent']];
const fieldStyle = { width: '100%', padding: '12px 14px', borderRadius: 12, color: 'var(--t1)', border: '1px solid var(--bdr)', fontFamily: 'inherit', fontSize: 14, background: 'var(--glass-bg)', outline: 'none' };
const fieldLbl = { fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 8px', ...mono };
function RaiseMaintenance({ loc, operator, prefill, onBack }) {
  const [units, setUnits] = useState([]);
  const [assetId, setAssetId] = useState('');
  const [issue, setIssue] = useState('Not holding temp');
  const [prio, setPrio] = useState('high');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');
  useEffect(() => { fetchTempUnits(loc).then(({ data }) => setUnits(data || [])); }, [loc]);

  const assetName = prefill?.unitName || units.find(u => u.id === assetId)?.name || 'General / other';
  const submit = async () => {
    setBusy(true); setErr('');
    const title = `${issue} — ${assetName}`;
    const desc = [note, prefill ? `Flagged from temp alert (${prefill.unitName} ${prefill.temp})` : ''].filter(Boolean).join(' · ');
    const res = await createMaintenance({ title, description: desc, priority: prio, reporterName: operator?.name, source: prefill ? 'temp_breach' : 'manual' }, loc);
    setBusy(false);
    if (res?.error) { setErr(res.error.message || 'Could not raise request'); return; }
    setOkMsg('Maintenance request raised'); setTimeout(onBack, 900);
  };

  return (
    <div>
      <Header title="Raise maintenance" sub="New request" onBack={onBack} />
      {prefill && (
        <div className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', marginBottom: 4, border: '1px solid color-mix(in srgb, var(--uv) 45%, transparent)', background: 'color-mix(in srgb, var(--uv) 12%, transparent)' }}>
          <span style={{ color: 'var(--uv)' }}><Icon name="thermo" size={18} /></span>
          <div style={{ fontSize: 12.5, color: 'var(--t2)' }}>Auto-created from temp alert · <b style={{ color: 'var(--t1)' }}>{prefill.unitName} {prefill.temp}</b></div>
        </div>
      )}

      <div style={fieldLbl}>Asset / unit</div>
      <select value={assetId} onChange={e => setAssetId(e.target.value)} style={fieldStyle}>
        <option value="">General / other</option>
        {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>

      <div style={fieldLbl}>Issue</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {MAINT_ISSUES.map(i => {
          const on = issue === i;
          return <button key={i} onClick={() => setIssue(i)} className={on ? '' : 'sv-glass'} style={{ padding: '9px 14px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, border: `1px solid ${on ? 'var(--acc-b)' : 'var(--bdr)'}`, color: on ? 'var(--acc)' : 'var(--t2)', background: on ? 'var(--acc-d)' : 'var(--glass-bg)' }}>{i}</button>;
        })}
      </div>

      <div style={fieldLbl}>Priority</div>
      <div className="sv-glass sv-pill" style={{ display: 'flex', padding: 4, gap: 4 }}>
        {MAINT_PRIOS.map(([v, l]) => {
          const on = prio === v;
          const onBg = v === 'urgent' ? 'var(--red)' : v === 'high' ? 'var(--amber, var(--orn))' : 'var(--acc)';
          return <button key={v} onClick={() => setPrio(v)} style={{ flex: 1, padding: '9px', borderRadius: 999, border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit', fontSize: 13, background: on ? onBg : 'transparent', color: on ? '#06130C' : 'var(--t2)' }}>{l}</button>;
        })}
      </div>

      <div style={fieldLbl}>Note (optional)</div>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Add any detail…" style={fieldStyle} />

      <div style={fieldLbl}>Photo evidence</div>
      <div style={{ border: '1.5px dashed var(--bdr3)', borderRadius: 14, padding: 22, textAlign: 'center', color: 'var(--t3)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <Icon name="camera" size={22} />
        <div style={{ fontSize: 12.5 }}>Add photo</div>
        <div style={{ fontSize: 10, ...mono }}>COMING SOON</div>
      </div>

      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 12 }}>{err}</div>}
      {okMsg && <div style={{ color: 'var(--grn)', fontSize: 13, marginTop: 12, fontWeight: 700 }}>{okMsg}</div>}
      <button onClick={submit} disabled={busy} className="btn btn-acc" style={{ width: '100%', padding: 15, marginTop: 16, fontSize: 15, fontWeight: 800, borderRadius: 14, opacity: busy ? 0.6 : 1 }}>{busy ? 'Raising…' : 'Raise request'}</button>
    </div>
  );
}
