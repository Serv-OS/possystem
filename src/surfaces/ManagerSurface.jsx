// src/surfaces/ManagerSurface.jsx
//
// ServOS Manager (?mode=manager) — the owner app + ops tablet merged into one role-adaptive phone
// app. Flow mirrors the Ops surface: pair the phone (Back Office → Devices) → staff PIN → app.
// Floating bottom tab bar: Home · Reports · Team · Ops · Kitchen, shown per the signed-in role.
//
// ADDITIVE + reuse-first: pairing/PIN reuse the ops device layer (opsHeartbeat/opsRegisterDevice/
// opsPinLogin); the liquid-glass skin + tokens are the shared [data-skin="servos"] system; the
// pure decisions live in src/lib/manager/* (unit-tested). Feature tabs land in following slices —
// this slice is the shell, role gating, theme, Home, and a live Ops tab (reuses the ops engine).

import { useEffect, useState } from 'react';
import { opsHeartbeat, opsRegisterDevice, opsPinLogin } from '../lib/ops/data';
import { ensureAuthToken } from '../lib/supabase';
import { fetchManagerSnapshot } from '../lib/manager/data';
import { roleFlags, TABS } from '../lib/manager/access';
import CardErrorBoundary from '../components/CardErrorBoundary';
import { Icon } from '../components/ServOSIcons';
import ManagerHome from './manager/ManagerHome';
import ManagerReports from './manager/ManagerReports';
import ManagerTeam from './manager/ManagerTeam';
import ManagerOps from './manager/ManagerOps';
import ManagerKitchen from './manager/ManagerKitchen';

const mono = { fontFamily: 'var(--font-mono)' };

export default function ManagerSurface() {
  const [stage, setStage] = useState('boot');     // boot | pair | pin | app
  const [loc, setLoc] = useState(null);
  const [venueName, setVenueName] = useState('');
  const [claimCode, setClaimCode] = useState('');
  const [operator, setOperator] = useState(null); // { id, name, role, permissions }
  const [tab, setTab] = useState('home');
  // Deep-link into the Ops tab (e.g. Home's "needs you now" → straight to the Alerts view).
  // {view, k} — k changes per jump so OpsContent's effect re-fires even for the same view.
  const [opsJump, setOpsJump] = useState(null);
  const [dark, setDark] = useState(() => localStorage.getItem('mgr-theme') !== 'light');
  const [snap, setSnap] = useState(null);     // one shared snapshot for every tab
  const [snapErr, setSnapErr] = useState('');

  // ServOS glass skin for the whole surface; dark default, per-device light toggle.
  useEffect(() => {
    const el = document.documentElement;
    const prevSkin = el.getAttribute('data-skin'), prevTheme = el.getAttribute('data-theme');
    el.setAttribute('data-skin', 'servos');
    if (dark) el.removeAttribute('data-theme'); else el.setAttribute('data-theme', 'light');
    return () => { if (prevSkin) el.setAttribute('data-skin', prevSkin); else el.removeAttribute('data-skin'); if (prevTheme) el.setAttribute('data-theme', prevTheme); else el.removeAttribute('data-theme'); };
  }, [dark]);


// v5.5.917 — PUBLISH THE PAIRED VENUE SO THE SHARED DATA LAYER CAN SEE IT.
// The Manager app pairs through its OWN ops_devices record, and until now it kept the resolved
// location in React state only. Everything under src/lib/ops resolves the venue with
// getActiveLocationSync(), which reads localStorage 'rpos-device' — a key this surface never
// wrote. So on a manager tablet the venue resolved to NULL, every ops write went out with
// location_id: null, and row-level security refused it. Staff saw the raw
// "new row violates row-level security policy" under a checklist that otherwise looked fine.
// Merge rather than overwrite: a tablet that is ALSO paired as a till must keep its own record.
function publishManagerLocation(locationId, venueName) {
  if (!locationId) return;
  try {
    const prev = JSON.parse(localStorage.getItem('rpos-device') || '{}') || {};
    if (prev.locationId === locationId) return;
    localStorage.setItem('rpos-device', JSON.stringify({
      ...prev, locationId, locationName: venueName || prev.locationName || null,
    }));
  } catch { /* storage unavailable — the ops writes will surface a clear error instead */ }
}

  // boot: anon session → heartbeat → claimed? PIN : pair
  useEffect(() => {
    let live = true;
    (async () => {
      await ensureAuthToken();
      if (!live) return;
      const { data } = await opsHeartbeat();
      if (!live) return;
      if (data?.claimed && data.location_id) { publishManagerLocation(data.location_id, data.name); setLoc(data.location_id); setVenueName(data.name || ''); setStage('pin'); }
      else { const reg = await opsRegisterDevice(); if (!live) return; setClaimCode(reg.data?.claim_code || ''); setStage('pair'); }
    })();
    return () => { live = false; };
  }, []);

  // poll for a manager to claim the device while pairing
  useEffect(() => {
    if (stage !== 'pair') return;
    const t = setInterval(async () => {
      const { data } = await opsHeartbeat();
      if (data?.claimed && data.location_id) { publishManagerLocation(data.location_id, data.name); setLoc(data.location_id); setVenueName(data.name || ''); setStage('pin'); }
    }, 5000);
    return () => clearInterval(t);
  }, [stage]);

  // one shared snapshot poll for all tabs — instant tab switches, a single network call
  useEffect(() => {
    if (stage !== 'app' || !loc) return;
    let live = true;
    const load = () => fetchManagerSnapshot(loc).then((r) => {
      if (!live) return;
      if (r?.ok) { setSnap(r); setSnapErr(''); } else setSnapErr(r?.error || 'Could not load');
    });
    load();
    const t = setInterval(load, 30000);
    return () => { live = false; clearInterval(t); };
  }, [stage, loc]);

  if (stage === 'boot') return <Screen><div style={{ color: 'var(--t3)', ...mono }}>Starting…</div></Screen>;
  if (stage === 'pair') return <PairScreen code={claimCode} />;
  if (stage === 'pin') return <PinScreen loc={loc} venueName={venueName} onOk={(op) => { setOperator(op); setStage('app'); }} />;

  const flags = roleFlags(operator?.role, operator?.permissions);
  const visibleTabs = TABS.filter((t) => flags[t.flag]);
  // If the active tab isn't allowed for this role, fall back to the first visible one.
  const activeTab = visibleTabs.some((t) => t.key === tab) ? tab : (visibleTabs[0]?.key || 'home');
  const refreshSnap = () => { if (loc) fetchManagerSnapshot(loc).then((r) => { if (r?.ok) { setSnap(r); setSnapErr(''); } else setSnapErr(r?.error || 'Could not load'); }); };
  const ctx = { loc, venueName, operator, flags, setTab, snap, snapErr, refreshSnap, dark,
    opsJump,
    goOps: (view) => { setOpsJump({ view, k: Date.now() }); setTab('ops'); },
    toggleTheme: () => { const n = !dark; setDark(n); localStorage.setItem('mgr-theme', n ? 'dark' : 'light'); } };

  return (
    <Shell ctx={ctx} tabs={visibleTabs} active={activeTab} onTab={setTab}
      onLogout={() => { setOperator(null); setTab('home'); setStage('pin'); }}>
      <CardErrorBoundary>
        {activeTab === 'home' ? <ManagerHome ctx={ctx} />
          : activeTab === 'reports' ? <ManagerReports ctx={ctx} />
          : activeTab === 'team' ? <ManagerTeam ctx={ctx} />
          : activeTab === 'ops' ? <ManagerOps ctx={ctx} />
          : activeTab === 'kitchen' ? <ManagerKitchen ctx={ctx} />
          : <ManagerHome ctx={ctx} />}
      </CardErrorBoundary>
    </Shell>
  );
}

// ── chrome ───────────────────────────────────────────────────────────────────
function Screen({ children }) {
  return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)', color: 'var(--t1)' }}>{children}</div>;
}

function Shell({ ctx, tabs, active, onTab, onLogout, children }) {
  return (
    <div style={{ height: '100%', minHeight: '100vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch', background: 'var(--bg)', color: 'var(--t1)', maxWidth: 480, margin: '0 auto', padding: '0 14px 92px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 4px 12px' }}>
        <div className="sv-glass" style={{ width: 36, height: 36, borderRadius: 11, display: 'grid', placeItems: 'center', fontFamily: 'Syne, Space Grotesk, sans-serif', fontWeight: 800, color: 'var(--acc)', flexShrink: 0 }}>S</div>
        <button onClick={onLogout} title="Switch user" style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontFamily: 'inherit' }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ctx.venueName || 'ServOS Manager'}</div>
          {ctx.operator && <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>{ctx.operator.name} · {ctx.operator.role || 'staff'}</div>}
        </button>
        <button onClick={ctx.toggleTheme} aria-label="Theme" className="sv-glass" style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)', flexShrink: 0 }}>
          {ctx.dark ? '☾' : '☀'}
        </button>
        <button onClick={onLogout} aria-label="Sign out" title="Sign out" className="sv-glass" style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--red)', border: '1px solid var(--bdr)', flexShrink: 0 }}>
          <Icon name="signout" size={18} />
        </button>
      </div>
      {children}
      <TabBar tabs={tabs} active={active} onTab={onTab} />
    </div>
  );
}

function TabBar({ tabs, active, onTab }) {
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, display: 'flex', justifyContent: 'center', padding: '0 14px 14px', pointerEvents: 'none', zIndex: 30 }}>
      <div className="sv-glass" style={{ pointerEvents: 'auto', display: 'flex', gap: 2, padding: 6, borderRadius: 999, maxWidth: 480, width: '100%', justifyContent: 'space-around' }}>
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <button key={t.key} onClick={() => onTab(t.key)} style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '8px 4px',
              background: on ? 'var(--acc-d)' : 'transparent', border: 'none', borderRadius: 999, cursor: 'pointer',
              color: on ? 'var(--acc)' : 'var(--t3)', fontFamily: 'inherit', minWidth: 44,
            }}>
              <Icon name={t.icon} size={20} />
              <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', ...mono }}>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PairScreen({ code }) {
  return (
    <Screen>
      <div className="sv-glass" style={{ padding: 28, textAlign: 'center', maxWidth: 340 }}>
        <div style={{ fontSize: 13, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>Pair this phone</div>
        <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: '.12em', margin: '14px 0', color: 'var(--acc)', ...mono }}>{code || '······'}</div>
        <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5 }}>In Back Office → Settings → Devices, enter this code to link this phone to your venue. This screen updates automatically once it's paired.</div>
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
    onOk({ id: data.id, name: data.name, role: data.role, permissions: data.permissions || [] });
  };
  const tap = (d) => { setErr(''); const next = (pin + d).slice(0, 6); setPin(next); if (next.length === 4) submit(next); };
  return (
    <Screen>
      <div style={{ textAlign: 'center', width: 280 }}>
        <div style={{ fontSize: 13, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>{venueName || 'ServOS Manager'}</div>
        <div style={{ fontSize: 18, fontWeight: 800, margin: '6px 0 18px' }}>Enter your PIN</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 18 }}>
          {[0, 1, 2, 3].map((i) => <div key={i} style={{ width: 14, height: 14, borderRadius: 999, background: i < pin.length ? 'var(--acc)' : 'var(--inset)', border: '1px solid var(--bdr2)' }} />)}
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <PinKey key={n} onClick={() => tap(String(n))}>{n}</PinKey>)}
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
