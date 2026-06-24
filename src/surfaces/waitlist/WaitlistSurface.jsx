// src/surfaces/waitlist/WaitlistSurface.jsx
//
// Tables Ready — the host-stand surface (?mode=waitlist). ServOS "Liquid Glass",
// dark skin, thumb-first. Flow mirrors OperationsSurface: pair the tablet
// (claim-code + heartbeat) → staff PIN → the live waitlist board.
//
//   ensureAuthToken()  → stable auth.uid() for device_uid + RLS
//   waitlistHeartbeat()→ claimed? → PIN : register + show claim code + poll
//   waitlistPinLogin() → staff identity (PIN never reaches the client)
//
// Once in the app this surface reads the live queue straight from the Zustand
// store (s.waitlist, s.tables, s.waitlistConfig) and drives every change through
// store actions (addParty / setWaitlistStatus / seatWaitlistParty /
// cancelWaitlistParty / lookupGuestByPhone). The store + WaitlistSync own all DB
// I/O and realtime fan-out; this file is pure presentation + intent.
//
// All RPC wrappers come from ../../lib/waitlist/waitlistData.js and are
// table-absent-safe (they return null/empty if the migration isn't applied yet),
// so this surface never throws at boot on a venue without the schema.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { ensureAuthToken, setResolvedLocationId } from '../../lib/supabase';
import { startRealtime, stopRealtime } from '../../lib/realtime';
import {
  registerWaitlistDevice, waitlistHeartbeat, waitlistPinLogin,
} from '../../lib/waitlist/waitlistData';
import { currentAverageWait, isActive } from '../../lib/waitlist/waitlist';
import { Icon } from '../../components/ServOSIcons';
import AddPartyDrawer from './AddPartyDrawer';
import SeatModal from './SeatModal';
import QueueBoard from './QueueBoard';
import FloorView from './FloorView';

const mono = { fontFamily: 'var(--font-mono)' };

export default function WaitlistSurface() {
  const [stage, setStage] = useState('boot');      // boot | pair | pin | app
  const [loc, setLoc] = useState(null);
  const [venueName, setVenueName] = useState('');
  const [claimCode, setClaimCode] = useState('');
  const [operator, setOperator] = useState(null);  // { id, name, role }
  const [view, setView] = useState('queue');        // queue | floor
  const [addOpen, setAddOpen] = useState(false);
  const [seatTarget, setSeatTarget] = useState(null); // a waitlist entry being seated
  // Dark by default (Liquid Glass); the host can switch to light for bright daylight. Persisted per device.
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('rpos-waitlist-theme') !== 'light'; } catch { return true; } });

  // ── apply the ServOS skin once (capture + restore the app's original on unmount) ──
  const origThemeRef = useRef(null);
  useEffect(() => {
    const el = document.documentElement;
    origThemeRef.current = { skin: el.getAttribute('data-skin'), theme: el.getAttribute('data-theme') };
    el.setAttribute('data-skin', 'servos');
    return () => {
      const o = origThemeRef.current || {};
      if (o.skin) el.setAttribute('data-skin', o.skin); else el.removeAttribute('data-skin');
      if (o.theme) el.setAttribute('data-theme', o.theme); else el.removeAttribute('data-theme');
    };
  }, []);
  // ── dark/light toggle: servos is dark by default; data-theme="light" flips it. ──
  useEffect(() => {
    const el = document.documentElement;
    if (dark) el.removeAttribute('data-theme'); else el.setAttribute('data-theme', 'light');
    try { localStorage.setItem('rpos-waitlist-theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);

  // ── boot: heartbeat → claimed? → PIN : pair ─────────────────────────────────
  useEffect(() => {
    let live = true;
    (async () => {
      await ensureAuthToken();
      if (!live) return;
      const data = await waitlistHeartbeat();
      if (!live) return;
      if (data?.claimed && data.location_id) {
        setLoc(data.location_id); setVenueName(data.name || ''); setStage('pin');
      } else {
        const reg = await registerWaitlistDevice('Host stand');
        if (!live) return;
        setClaimCode(reg?.claim_code || '');
        // if the device row already carries a location (re-register), skip straight to PIN
        if (reg?.location_id) { setLoc(reg.location_id); setStage('pin'); }
        else setStage('pair');
      }
    })();
    return () => { live = false; };
  }, []);

  // ── while pairing, poll until a manager claims this tablet ───────────────────
  useEffect(() => {
    if (stage !== 'pair') return;
    const t = setInterval(async () => {
      const data = await waitlistHeartbeat();
      if (data?.claimed && data.location_id) {
        setLoc(data.location_id); setVenueName(data.name || ''); setStage('pin');
      }
    }, 5000);
    return () => clearInterval(t);
  }, [stage]);

  // ── keep the device alive + hydrate the queue once paired+logged in ──────────
  const loadFromDB = useStore(s => s.loadWaitlistFromDB);
  const loadFloor = useStore(s => s.loadWaitlistFloor);
  const recompute = useStore(s => s.recomputeWaitlistQuotes);
  useEffect(() => {
    if (stage !== 'app' || !loc) return;
    // CRITICAL: the stand pairs via waitlist_devices (anon auth, no rpos-device / user_profiles),
    // so getLocationId() would return null and EVERY store write/SMS/sync would silently no-op.
    // Seed the resolver + current location from the claimed device location.
    setResolvedLocationId(loc);
    useStore.getState().setCurrentLocation?.(loc);
    waitlistHeartbeat().catch(() => {});
    const hb = setInterval(() => waitlistHeartbeat().catch(() => {}), 60000);
    // The host stand renders WITHOUT SyncBridge, so hydrate the board + floor here and
    // open the realtime stream (waitlist entries + table turns from every other device).
    loadFromDB?.(loc);
    loadFloor?.(loc);
    const stopRT = startRealtime(useStore, loc) || (() => {});
    // Fallbacks: re-sync the floor + re-quote on a timer so table turns + ETAs stay fresh
    // even if a realtime event is missed (brief: recompute at least every 1-2 min).
    const floorPoll = setInterval(() => { loadFloor?.(loc); }, 30000);
    const requote = setInterval(() => { recompute?.(); }, 60000);
    return () => { clearInterval(hb); clearInterval(floorPoll); clearInterval(requote); try { stopRT(); } catch {} stopRealtime(); };
  }, [stage, loc, loadFromDB, loadFloor, recompute]);

  if (stage === 'boot') return <Screen><div style={{ color: 'var(--t3)', ...mono }}>Starting…</div></Screen>;
  if (stage === 'pair') return <PairScreen code={claimCode} />;
  if (stage === 'pin') return <PinScreen loc={loc} venueName={venueName} onOk={(op) => { setOperator(op); setStage('app'); }} />;

  return (
    <AppShell
      venueName={venueName}
      operator={operator}
      view={view}
      onView={setView}
      dark={dark}
      onToggleTheme={() => setDark(d => !d)}
      onLogout={() => { setOperator(null); setStage('pin'); }}
      onAdd={() => setAddOpen(true)}
    >
      {view === 'floor'
        ? <FloorView loc={loc} onSeatEntry={(e) => setSeatTarget(e)} />
        : <QueueBoard loc={loc} operator={operator} onSeat={(e) => setSeatTarget(e)} />}

      {addOpen && (
        <AddPartyDrawer
          loc={loc}
          operator={operator}
          onClose={() => setAddOpen(false)}
        />
      )}
      {seatTarget && (
        <SeatModal
          entry={seatTarget}
          operator={operator}
          onClose={() => setSeatTarget(null)}
        />
      )}
    </AppShell>
  );
}

// ── chrome ─────────────────────────────────────────────────────────────────────
function Screen({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)', color: 'var(--t1)' }}>
      {children}
    </div>
  );
}

// Top bar: live hero stats (avg wait now in UV, waiting count, tables open) +
// Queue/Floor toggle + the big "Add party" CTA. Stats read live from the store.
function AppShell({ venueName, operator, view, onView, dark, onToggleTheme, onLogout, onAdd, children }) {
  const waitlist = useStore(s => s.waitlist) || [];
  const tables = useStore(s => s.tables) || [];

  const active = waitlist.filter(e => isActive(e.status));
  const avgWait = currentAverageWait(active);
  const tablesOpen = tables.filter(t => !t.parentId && t.status === 'available').length;

  return (
    <div style={{ height: '100%', minHeight: '100vh', overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', background: 'var(--bg)', color: 'var(--t1)', maxWidth: 1100, margin: '0 auto', padding: '0 16px 110px' }}>
      {/* header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 4px 14px' }}>
        <div className="sv-glass" style={{ width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 800, color: 'var(--acc)', flexShrink: 0 }}>S</div>
        <button onClick={onLogout} title="Tap to switch user" style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontFamily: 'inherit' }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venueName || 'Tables Ready'}</div>
          <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>
            {operator?.name ? operator.name : 'Host stand'} · {new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()}
          </div>
        </button>
        <button
          onClick={onToggleTheme}
          title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="sv-glass"
          style={{ width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center', cursor: 'pointer', fontSize: 17, color: 'var(--t2)', flexShrink: 0, border: 'none' }}
        >{dark ? '☀️' : '🌙'}</button>
      </div>

      {/* hero stat strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 14 }}>
        <HeroStat label="Avg wait now" value={avgWait} unit="min" accent="uv" big />
        <HeroStat label="Waiting" value={active.length} unit="parties" accent="acc" />
        <HeroStat label="Tables open" value={tablesOpen} unit="now" accent={tablesOpen > 0 ? 'grn' : 't3'} />
      </div>

      {/* view toggle */}
      <div className="sv-glass sv-pill" style={{ display: 'flex', padding: 4, marginBottom: 14, gap: 4 }}>
        {[{ k: 'queue', l: 'Queue', i: 'list' }, { k: 'floor', l: 'Floor', i: 'floor' }].map(t => (
          <button key={t.k} onClick={() => onView(t.k)} style={{ flex: 1, padding: '10px', borderRadius: 999, border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: view === t.k ? 'var(--acc)' : 'transparent', color: view === t.k ? '#06130C' : 'var(--t2)' }}>
            <Icon name={t.i} size={17} /> {t.l}
          </button>
        ))}
      </div>

      {children}

      {/* floating Add-party CTA */}
      <button onClick={onAdd} className="btn btn-acc" style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 22, zIndex: 40, display: 'flex', alignItems: 'center', gap: 9, padding: '15px 28px', fontSize: 15, fontWeight: 800, borderRadius: 999, boxShadow: '0 10px 30px rgba(21,194,106,0.40)' }}>
        <Icon name="plus" size={18} /> Add party
      </button>
    </div>
  );
}

const ACCENT = {
  uv: 'var(--uv)', acc: 'var(--acc)', grn: 'var(--grn)', red: 'var(--red)', amber: 'var(--amber, var(--orn))', t3: 'var(--t3)',
};
function HeroStat({ label, value, unit, accent = 'acc', big = false }) {
  const col = ACCENT[accent] || ACCENT.acc;
  return (
    <div className="sv-glass" style={{ padding: '14px 16px', borderRadius: 18, textAlign: 'left' }}>
      <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: big ? 40 : 30, fontWeight: 800, lineHeight: 1, color: col, textShadow: accent === 'uv' ? '0 0 24px var(--blu-b)' : 'none' }}>{value}</span>
        <span style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{unit}</span>
      </div>
    </div>
  );
}

// ── pairing ─────────────────────────────────────────────────────────────────────
function PairScreen({ code }) {
  return (
    <Screen>
      <div className="sv-glass" style={{ padding: 28, textAlign: 'center', maxWidth: 360 }}>
        <div style={{ fontSize: 13, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>Pair this host stand</div>
        <div style={{ fontSize: 42, fontWeight: 800, letterSpacing: '.12em', margin: '16px 0', color: 'var(--acc)', ...mono }}>{code || '······'}</div>
        <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5 }}>
          In Back Office → Tables Ready → Devices, enter this code to pair this tablet. This screen links automatically once it's attached to a venue.
        </div>
      </div>
    </Screen>
  );
}

// ── staff PIN ─────────────────────────────────────────────────────────────────
function PinScreen({ loc, venueName, onOk }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const submit = async (p) => {
    const data = await waitlistPinLogin(loc, p);
    if (!data?.ok) { setErr('PIN not recognised'); setPin(''); return; }
    onOk({ id: data.id, name: data.name, role: data.role });
  };
  const tap = (d) => { setErr(''); const next = (pin + d).slice(0, 6); setPin(next); if (next.length === 4) submit(next); };
  return (
    <Screen>
      <div style={{ textAlign: 'center', width: 280 }}>
        <div style={{ fontSize: 13, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>{venueName || 'Tables Ready'}</div>
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
