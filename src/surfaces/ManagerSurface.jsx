// src/surfaces/ManagerSurface.jsx
//
// ServOS Manager (?mode=manager): the owner app and the ops tablet merged into one role-adaptive
// phone and tablet app. Flow mirrors the Ops surface: pair the device (Back Office, Operations,
// Devices), then staff PIN, then the app.
// Floating bottom tab bar: Home · Reports · Team · Ops · Kitchen, shown per the signed-in role.
// From 660 wide the same bar is a left rail and the content fills the screen. Every width
// decision lives in manager/layout.js and reaches the screens as style values only, so a
// rotation or a Split View drag never re mounts anything.
//
// ADDITIVE + reuse-first: pairing/PIN reuse the ops device layer (opsHeartbeat/opsRegisterDevice/
// opsPinLogin); the liquid-glass skin + tokens are the shared [data-skin="servos"] system; the
// pure decisions live in src/lib/manager/* (unit-tested). Feature tabs land in following slices —
// this slice is the shell, role gating, theme, Home, and a live Ops tab (reuses the ops engine).

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { opsHeartbeat, opsRegisterDevice, opsPinLogin, opsClaimDemo } from '../lib/ops/data';
import { ensureAuthToken } from '../lib/supabase';
import { fetchManagerSnapshot } from '../lib/manager/data';
import { roleFlags, TABS } from '../lib/manager/access';
import { regionPack } from '../lib/regionPack';
import CardErrorBoundary from '../components/CardErrorBoundary';
import { Icon } from '../components/ServOSIcons';
import ManagerHome from './manager/ManagerHome';
import ManagerReports from './manager/ManagerReports';
import ManagerTeam from './manager/ManagerTeam';
import ManagerOps from './manager/ManagerOps';
import ManagerKitchen from './manager/ManagerKitchen';
import ManagerChat from './manager/ManagerChat';
import { LayoutContext, useLayout, useViewportLayout } from './manager/useLayout';

const mono = { fontFamily: 'var(--font-mono)' };

function ManagerApp() {
  const [stage, setStage] = useState('boot');     // boot | pair | pin | app
  const [loc, setLoc] = useState(null);
  const [venueName, setVenueName] = useState('');
  const [claimCode, setClaimCode] = useState('');
  const [demoErr, setDemoErr] = useState('');
  const [operator, setOperator] = useState(null); // { id, name, role, permissions }
  const [tab, setTab] = useState('home');
  // Deep-link into the Ops tab (e.g. Home's "needs you now" → straight to the Alerts view).
  // {view, k} — k changes per jump so OpsContent's effect re-fires even for the same view.
  const [opsJump, setOpsJump] = useState(null);
  const [dark, setDark] = useState(() => localStorage.getItem('mgr-theme') !== 'light');
  const [snap, setSnap] = useState(null);     // one shared snapshot for every tab
  const [snapErr, setSnapErr] = useState('');
  const [chatFull, setChatFull] = useState(false);   // 5.11.102: a chat is open, the tab bar steps aside for its composer

  // ServOS glass skin for the whole surface; dark default, per-device light toggle.
  useEffect(() => {
    const el = document.documentElement;
    const prevSkin = el.getAttribute('data-skin'), prevTheme = el.getAttribute('data-theme');
    el.setAttribute('data-skin', 'servos');
    if (dark) el.removeAttribute('data-theme'); else el.setAttribute('data-theme', 'light');
    return () => { if (prevSkin) el.setAttribute('data-skin', prevSkin); else el.removeAttribute('data-skin'); if (prevTheme) el.setAttribute('data-theme', prevTheme); else el.removeAttribute('data-theme'); };
  }, [dark]);

  // Manager is the one app that runs on a PHONE with a notch, so it goes edge to
  // edge and pads its own chrome with env(safe-area-inset-*). Without
  // viewport-fit=cover iOS insets the whole web view instead, which left a band
  // above the app painted in the shell's colour: dark, even in light mode, and
  // visibly not part of the app (Peter, 26 Aug).
  //
  // Set HERE and reverted on unmount rather than in index.html, because
  // viewport-fit=cover is global: every env() in the app is 0 today, so turning
  // it on everywhere would slide MPOS (which has no fixed chrome and no insets)
  // straight under the notch.
  useEffect(() => {
    const m = document.querySelector('meta[name="viewport"]');
    if (!m) return undefined;
    const prev = m.getAttribute('content');
    m.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
    return () => { if (prev) m.setAttribute('content', prev); };
  }, []);

  // boot: anon session → heartbeat → claimed? PIN : pair
  useEffect(() => {
    let live = true;
    (async () => {
      await ensureAuthToken();
      if (!live) return;
      const { data } = await opsHeartbeat();
      if (!live) return;
      if (data?.claimed && data.location_id) { setLoc(data.location_id); setVenueName(data.name || ''); setStage('pin'); }
      else { const reg = await opsRegisterDevice(); if (!live) return; setClaimCode(reg.data?.claim_code || ''); setStage('pair'); }
    })();
    return () => { live = false; };
  }, []);

  // poll for a manager to claim the device while pairing
  useEffect(() => {
    if (stage !== 'pair') return;
    const t = setInterval(async () => {
      const { data } = await opsHeartbeat();
      if (data?.claimed && data.location_id) { setLoc(data.location_id); setVenueName(data.name || ''); setStage('pin'); }
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
  if (stage === 'pair') {
    // "Try the demo" pairs this phone to the demo venue itself, so somebody with no
    // Back Office (an App Store reviewer, a prospect on a call) can still get in. The
    // staff PIN still stands between them and the venue's data.
    const tryDemo = async () => {
      setDemoErr('');
      const { data, error } = await opsClaimDemo();
      if (error || !data?.ok) { setDemoErr(data?.message || error?.message || 'Could not open the demo. Try again.'); return; }
      setLoc(data.location_id); setVenueName(data.name || 'Demo'); setStage('pin');
    };
    return <PairScreen code={claimCode} onDemo={tryDemo} demoErr={demoErr} />;
  }
  if (stage === 'pin') return <PinScreen loc={loc} venueName={venueName} onOk={(op) => { setOperator(op); setStage('app'); }} />;

  const flags = roleFlags(operator?.role, operator?.permissions);
  const visibleTabs = TABS.filter((t) => flags[t.flag]);
  // If the active tab isn't allowed for this role, fall back to the first visible one.
  const activeTab = visibleTabs.some((t) => t.key === tab) ? tab : (visibleTabs[0]?.key || 'home');
  // Returns the promise so a caller can show progress until it actually lands.
  const refreshSnap = () => {
    if (!loc) return Promise.resolve();
    return fetchManagerSnapshot(loc).then((r) => {
      if (r?.ok) { setSnap(r); setSnapErr(''); } else setSnapErr(r?.error || 'Could not load');
    });
  };
  // 5.11.102 review fix A8: dates the venue's way (en-US for a US venue), from its currency.
  const ctx = { loc, venueName, operator, flags, setTab, snap, snapErr, refreshSnap, dark, setChatFull, locale: regionPack(snap?.money?.currency || 'GBP').locale,
    opsJump,
    goOps: (view) => { setOpsJump({ view, k: Date.now() }); setTab('ops'); },
    toggleTheme: () => { const n = !dark; setDark(n); localStorage.setItem('mgr-theme', n ? 'dark' : 'light'); } };

  return (
    <Shell ctx={ctx} tabs={visibleTabs} active={activeTab} onTab={setTab} hideNav={activeTab === 'chat' && chatFull}
      onLogout={() => { setOperator(null); setTab('home'); setStage('pin'); }}>
      <CardErrorBoundary>
        {activeTab === 'home' ? <ManagerHome ctx={ctx} />
          : activeTab === 'reports' ? <ManagerReports ctx={ctx} />
          : activeTab === 'team' ? <ManagerTeam ctx={ctx} />
          : activeTab === 'ops' ? <ManagerOps ctx={ctx} />
          : activeTab === 'kitchen' ? <ManagerKitchen ctx={ctx} />
          : activeTab === 'chat' ? <ManagerChat ctx={ctx} />
          : <ManagerHome ctx={ctx} />}
      </CardErrorBoundary>
    </Shell>
  );
}

// The ONE viewport subscription. ManagerApp never reads the layout, so its stage, operator,
// tab, snapshot and the skin and viewport effects cannot be disturbed by a resize.
export default function ManagerSurface() {
  const layout = useViewportLayout();
  return <LayoutContext.Provider value={layout}><ManagerApp /></LayoutContext.Provider>;
}

// ── chrome ───────────────────────────────────────────────────────────────────
// v5.5.971 — THE MANAGER APP NEVER RENDERED TOASTS. store.showToast() sets `toast`,
// but the only <Toast> in the app lives inside the POS shell (App.jsx ValidatedPOSApp)
// and this surface returns from an EARLIER branch (App.jsx:272) — so every message
// raised anywhere in the Manager tree (the Ops tab included) has been silently
// discarded. Same family as the vanishing-categories saga: the app knew, the manager
// never did. Mirrors BackOfficeToast in src/backoffice/BackOfficeApp.jsx.
function ManagerToast({ rail }) {
  const L = useLayout();
  const toast = useStore(s => s.toast);
  if (!toast) return null;
  const map = {
    success: { bg: 'var(--grn-d)', bdr: 'var(--grn-b)', color: 'var(--grn)' },
    error:   { bg: 'var(--red-d)', bdr: 'var(--red-b)', color: 'var(--red)' },
    warning: { bg: 'var(--acc-d)', bdr: 'var(--acc-b)', color: 'var(--acc)' },
    info:    { bg: 'var(--bg3)',   bdr: 'var(--bdr2)',  color: 'var(--t1)'  },
  };
  const c = map[toast.type] || map.info;
  return (
    <div className="toast" key={toast.key}
      style={{ background: c.bg, border: `1px solid ${c.bdr}`, color: c.color, zIndex: 100003, ...(rail ? L.s.toastRail : L.s.toastPlain) }}>
      {toast.msg}
    </div>
  );
}

function Screen({ children }) {
  const L = useLayout();
  return <div style={{
    minHeight: '100vh', display: 'grid', placeItems: 'center',
    padding: 'calc(24px + env(safe-area-inset-top, 0px)) 24px calc(24px + env(safe-area-inset-bottom, 0px))',
    background: 'var(--bg)', color: 'var(--t1)', ...L.s.screen,
  }}>{children}<ManagerToast /></div>;
}

function Shell({ ctx, tabs, active, onTab, onLogout, hideNav, children }) {
  const L = useLayout();
  return (
    <div data-mgr-layout={L.phone ? undefined : L.band} style={{
      height: '100%', minHeight: '100vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch',
      background: 'var(--bg)', color: 'var(--t1)', margin: '0 auto',
      // The notch eats the top and the home indicator eats the bottom. The page
      // paints its own background through both, so the app looks continuous.
      // Width and the four paddings come from the layout: the 480 column with the
      // tab bar reserve on a phone, the full screen right of the rail from 660 wide.
      ...L.s.shell,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 4px 12px', ...L.s.header }}>
        <div className="sv-glass" style={{ width: 36, height: 36, borderRadius: 11, display: 'grid', placeItems: 'center', fontFamily: 'Syne, Space Grotesk, sans-serif', fontWeight: 800, color: 'var(--acc)', flexShrink: 0 }}>S</div>
        <button onClick={onLogout} title="Switch user" style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontFamily: 'inherit', ...L.s.switchUser }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...L.s.venueName }}>{ctx.venueName || 'ServOS Manager'}</div>
          {ctx.operator && <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono, ...L.s.operatorLine }}>{ctx.operator.name} · {ctx.operator.role || 'staff'}</div>}
        </button>
        {/* The snapshot refreshes itself every 30s, but there was no way to ASK
            for fresh numbers, which is the first thing anyone does when a figure
            looks stale (Peter, 26 Aug). Spins while it fetches so the tap is
            visibly acknowledged. */}
        <RefreshButton onRefresh={ctx.refreshSnap} />
        <button onClick={ctx.toggleTheme} aria-label="Theme" className="sv-glass" style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)', flexShrink: 0, ...L.s.hit }}>
          {ctx.dark ? '☾' : '☀'}
        </button>
        <button onClick={onLogout} aria-label="Sign out" title="Sign out" className="sv-glass" style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--red)', border: '1px solid var(--bdr)', flexShrink: 0, ...L.s.hit }}>
          <Icon name="signout" size={18} />
        </button>
      </div>
      {children}
      {!hideNav && <TabBar tabs={tabs} active={active} onTab={onTab} />}
      <ManagerToast rail />
    </div>
  );
}

function RefreshButton({ onRefresh }) {
  const L = useLayout();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy || !onRefresh) return;
    setBusy(true);
    // Always hold the spinner briefly: a snapshot that returns in 40ms would
    // otherwise flash and read as "nothing happened".
    const started = Date.now();
    try { await onRefresh(); } catch { /* the surface shows its own error line */ }
    const held = Date.now() - started;
    if (held < 450) await new Promise((r) => setTimeout(r, 450 - held));
    setBusy(false);
  };
  return (
    <button
      onClick={go} disabled={busy} aria-label="Refresh" title="Refresh"
      className="sv-glass"
      style={{
        width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center',
        cursor: busy ? 'default' : 'pointer', color: busy ? 'var(--acc)' : 'var(--t1)',
        border: '1px solid var(--bdr)', flexShrink: 0, fontSize: 17, lineHeight: 1, ...L.s.hit,
      }}
    >
      <span style={{ display: 'block', animation: busy ? 'spin .7s linear infinite' : 'none' }}>↻</span>
    </button>
  );
}

// One component, one set of elements: a floating pill along the bottom on a phone, the same
// pill stood up as a rail on the left edge from 660 wide. Only the styles differ.
function TabBar({ tabs, active, onTab }) {
  const L = useLayout();
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, display: 'flex', justifyContent: 'center', padding: '0 14px calc(14px + env(safe-area-inset-bottom, 0px))', pointerEvents: 'none', zIndex: 30, ...L.s.navWrap }}>
      <div className="sv-glass" style={{ pointerEvents: 'auto', display: 'flex', gap: 2, padding: 6, borderRadius: 999, maxWidth: 480, width: '100%', justifyContent: 'space-around', ...L.s.navPill }}>
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <button key={t.key} onClick={() => onTab(t.key)} style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '8px 4px',
              background: on ? 'var(--acc-d)' : 'transparent', border: 'none', borderRadius: 999, cursor: 'pointer',
              color: on ? 'var(--acc)' : 'var(--t3)', fontFamily: 'inherit', minWidth: 44, ...L.s.navBtn,
            }}>
              <Icon name={t.icon} size={L.navIcon} />
              <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', ...mono, ...L.s.navLabel }}>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PairScreen({ code, onDemo, demoErr }) {
  const L = useLayout();
  return (
    <Screen>
      <div className="sv-glass" style={{ padding: 28, textAlign: 'center', maxWidth: 340, ...L.s.pairCard }}>
        <div style={{ fontSize: 13, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono, ...L.s.pairLabel }}>Pair this {L.deviceWord}</div>
        <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: '.12em', margin: '14px 0', color: 'var(--acc)', ...mono, ...L.s.pairCode }}>{code || '······'}</div>
        {/* Operations → Devices, NOT Settings → Devices. Manager registers through
            the ops device layer (opsRegisterDevice), which is the same list the
            Ops tablet pairs into. The Settings group has no Devices page at all. */}
        <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5, ...L.s.pairBody }}>In Back Office → Operations → Devices, enter this code to link this {L.deviceWord} to your venue. This screen updates automatically once it&apos;s paired.</div>
        {onDemo && (
          <>
            <button type="button" onClick={onDemo}
              style={{ marginTop: 18, width: '100%', padding: '12px 14px', borderRadius: 12, border: '1px solid var(--bdr)', background: 'transparent', color: 'var(--t2)', fontSize: 14, fontFamily: 'inherit', cursor: 'pointer', ...L.s.pairBtn }}>
              No venue yet? Try the demo
            </button>
            {demoErr && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--red)' }}>{demoErr}</div>}
          </>
        )}
      </div>
    </Screen>
  );
}

function PinScreen({ loc, venueName, onOk }) {
  const L = useLayout();
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
      <div style={{ textAlign: 'center', width: 280, ...L.s.pinBlock }}>
        <div style={{ fontSize: 13, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono, ...L.s.pinVenue }}>{venueName || 'ServOS Manager'}</div>
        <div style={{ fontSize: 18, fontWeight: 800, margin: '6px 0 18px', ...L.s.pinTitle }}>Enter your PIN</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 18 }}>
          {[0, 1, 2, 3].map((i) => <div key={i} style={{ width: 14, height: 14, borderRadius: 999, background: i < pin.length ? 'var(--acc)' : 'var(--inset)', border: '1px solid var(--bdr2)', ...L.s.pinDot }} />)}
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, ...L.s.pinGrid }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <PinKey key={n} onClick={() => tap(String(n))}>{n}</PinKey>)}
          <div /><PinKey onClick={() => tap('0')}>0</PinKey>
          <PinKey onClick={() => setPin(pin.slice(0, -1))}>⌫</PinKey>
        </div>
      </div>
    </Screen>
  );
}
const PinKey = ({ children, onClick }) => {
  const L = useLayout();
  return (
    <button onClick={onClick} className="sv-glass" style={{ height: 60, fontSize: 22, fontWeight: 700, color: 'var(--t1)', cursor: 'pointer', border: '1px solid var(--bdr)', ...mono, ...L.s.pinKey }}>{children}</button>
  );
};
