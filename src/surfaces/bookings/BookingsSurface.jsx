// src/surfaces/bookings/BookingsSurface.jsx
//
// Table Bookings — the host-stand surface shell. Renders INSIDE the POS app
// shell (SyncBridge present for floor/menu data), but the surface itself is
// GATED exactly like the Tables Ready host stand (WaitlistSurface): device
// pairing (claim code, reusing the waitlist_devices plumbing wholesale — a
// paired host stand is a paired host stand, one pairing covers both surfaces)
// then a staff PIN. Stage machine: boot | pair | pin | app.
//
//   ensureAuthToken()  → stable auth.uid() for device_uid + RLS
//   waitlistHeartbeat()→ claimed? → PIN : register + show claim code + poll
//   waitlistPinLogin() → staff identity (PIN never reaches the client)
//
// CRITICAL (the waitlist lesson): a stand paired via waitlist_devices has no
// rpos-device row, so getLocationId() returns null and every store write would
// silently no-op. Before the app stage loads any data we seed the resolver +
// current location from the claimed device location.
//
// The app stage is the original shell: left nav rail (Diary / Floor / Book /
// Rules / Events / Reports / Widget — all live), a top bar (venue, live
// clock, New booking), seven screens switched by in-component state. Screens
// stay MOUNTED and hide with display:none so their local state survives nav
// switches (handoff "Interactions": state persists across switches).
//
// Skin: data-skin='servos' on <html> with the WaitlistSurface save+restore
// pattern, applied for ALL stages (pair + PIN look servos too), so leaving the
// surface puts the app's original skin/theme back.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { ensureAuthToken, setResolvedLocationId, isMock, supabase } from '../../lib/supabase';
import {
  registerWaitlistDevice, waitlistHeartbeat, waitlistPinLogin,
} from '../../lib/waitlist/waitlistData';
import { Icon } from '../../components/ServOSIcons';
import { startSessionReconciler } from '../../sync/SessionReconciler';
import { isSessionClosed } from '../../sync/sessionClosure';
import { startRealtime } from '../../lib/realtime.js';
import { startStandSessionSync } from '../../lib/bookings/standSessionSync.js';
import { startBookingsCatchUp } from '../../lib/bookings/bookingsCatchUp.js';
import { getLocationConfig } from '../../lib/locationTime';
import { venueClockText, ymdLabel } from '../../lib/bookings/venueClock.js';
import { channelPill, pinPadState, venuePinLength, pinLengthKey, PIN_MIN, PIN_MAX } from '../../lib/bookings/standRules.js';
import { mono, tintBg, tintBd } from './bits.jsx';
import { useVenueClock } from './useVenueClock.js';
import DiaryScreen from './DiaryScreen.jsx';
import ServiceScreen from './ServiceScreen.jsx';
import BookScreen from './BookScreen.jsx';
import RulesScreen from './RulesScreen.jsx';
import EventsScreen from './EventsScreen.jsx';
import ReportsScreen from './ReportsScreen.jsx';
import WidgetScreen from './WidgetScreen.jsx';
// 17 Oct 2026 (v5.11.73, PR 295 follow up): the booking requests inbox lives in the top bar, so
// its count, its button and its alert are on every screen (it was in the Timeline header only).
import RequestsInbox from './RequestsInbox.jsx';

const NAV = [
  { k: 'service',  label: 'Service',  icon: 'home' },
  { k: 'timeline', label: 'Timeline', icon: 'floor' },
  { k: 'book',    label: 'Book',    icon: 'plus' },
  { k: 'rules',   label: 'Rules',   icon: 'settings' },
  { k: 'events',  label: 'Events',  icon: 'inventory' },
  { k: 'reports', label: 'Reports', icon: 'reports' },
  { k: 'widget',  label: 'Widget',  icon: 'channels' },
];

export default function BookingsSurface() {
  const [stage, setStage] = useState('boot');      // boot | pair | pin | app
  const [loc, setLoc] = useState(null);
  const [venueName, setVenueName] = useState('');
  const [claimCode, setClaimCode] = useState('');
  const [operator, setOperator] = useState(null);  // { id, name, role }
  const [screen, setScreen] = useState('service');
  const [sel, setSel] = useState(null); // selected booking id (Diary inspector)

  // ── apply the ServOS skin once, for ALL stages (capture + restore the app's original on unmount) ──
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
        const reg = await registerWaitlistDevice('Bookings host stand');
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

  // ── once paired + logged in: seed the location, hydrate the diary, keep-alive ──
  useEffect(() => {
    if (stage !== 'app' || !loc) return;
    // CRITICAL: the stand pairs via waitlist_devices (anon auth, no rpos-device / user_profiles),
    // so getLocationId() would return null and EVERY store write would silently no-op.
    // Seed the resolver + current location from the claimed device location BEFORE loading data.
    setResolvedLocationId(loc);
    useStore.getState().setCurrentLocation?.(loc);
    // 16 Oct 2026 (audit item 8): the stand's clock is the VENUE's. A stand that
    // booted before pairing read the London fallback and never the venue's own
    // timezone, so load it for the paired venue, then the diary on its today.
    let live = true;
    (async () => {
      try {
        const cfg = await getLocationConfig(loc);
        if (live && cfg) useStore.setState({ locationConfig: cfg });
      } catch { /* London fallback stays */ }
      if (live) useStore.getState().loadBookingsFromDB?.(loc);
    })();
    // A FRESH stand boots with no resolvable location: SyncBridge's one-shot boot
    // and App's realtime retry window both ran and gave up BEFORE pairing finished,
    // so the floor never hydrated and the session machinery that makes it LIVE
    // never started (Peter, 13 Aug: opened table invisible on the stand). Hydrate
    // the floor directly if it's missing, then kick reconciler + realtime — both
    // are idempotent, so a stand that DID boot with a location is unaffected.
    // 16 Oct 2026: once the stream is up, the stand replaces every floor table's session from
    // active_sessions every 30 seconds (lib/bookings/standSessionSync.js). A stand never owns a
    // session, so a copy the server no longer holds (the till cashed the table off) heals here
    // whatever realtime delivered. Started after the async hydration; stopped with the effect.
    let stopStandSync = null;
    // 16 Oct 2026 (audit item 9): catch up the viewed day on wake, network back,
    // a 60 second timer and the venue's midnight (lib/bookings/bookingsCatchUp.js).
    const stopCatchUp = startBookingsCatchUp({ store: useStore });
    (async () => {
      try {
        if (!(useStore.getState().tables || []).length && supabase) {
          const [{ data: floor }, { data: sess }] = await Promise.all([
            supabase.from('floor_tables').select('*').eq('location_id', loc).order('sort_order'),
            supabase.from('active_sessions').select('table_id, session').eq('location_id', loc),
          ]);
          if (floor?.length) {
            const sMap = Object.fromEntries((sess || []).map((r) => [r.table_id, r.session]));
            useStore.setState({
              tables: floor.map((t) => ({
                ...t,
                maxCovers: t.max_covers ?? t.maxCovers ?? 4,
                sortOrder: t.sort_order ?? t.sortOrder ?? 0,
                locationId: t.location_id ?? loc,
                status: sMap[t.id] ? 'occupied' : 'available',
                session: sMap[t.id] || null,
              })),
            });
          }
        }
      } catch { /* the reconciler converges within 10s either way */ }
      startSessionReconciler();
      startRealtime(useStore, loc);
      if (live && supabase) {
        let storage = null;
        try { storage = window.localStorage; } catch { storage = null; }
        stopStandSync = startStandSessionSync({ store: useStore, client: supabase, locationId: loc, isClosed: isSessionClosed, storage });
      }
    })();
    waitlistHeartbeat().catch(() => {});
    const hb = setInterval(() => waitlistHeartbeat().catch(() => {}), 60000);
    // 17 Oct 2026 (v5.11.73, PR 295 follow up): the stand no longer starts the reminders sweep.
    // pg_cron runs booking-reminders send_due every 5 minutes (stand or no stand) with its own key
    // (migration 20261017a), and the sweep refuses anyone else once that runs.
    return () => { live = false; stopStandSync?.(); stopCatchUp(); clearInterval(hb); };
  }, [stage, loc]);

  const locations = useStore((s) => s.locations) || [];
  const currentLocationId = useStore((s) => s.currentLocationId);
  const bookingsDate = useStore((s) => s.bookingsDate);
  const venue = locations.find((l) => l.id === currentLocationId) || locations[0];
  const { ymd: venueYmd } = useVenueClock();

  const goBook = () => setScreen('book');
  const onBooked = (id) => { setSel(id); setScreen('service'); };

  // The toast rides EVERY stage, not just the app: a pairing or PIN failure raised
  // through showToast would be just as invisible as the seating refusal was.
  if (stage === 'boot') return <><GateScreen><div style={{ color: 'var(--t3)', ...mono }}>Starting…</div></GateScreen><BookingsToast /></>;
  if (stage === 'pair') return <><PairScreen code={claimCode} /><BookingsToast /></>;
  if (stage === 'pin') return <><PinScreen loc={loc} venueName={venueName || venue?.name || ''} onOk={(op) => { setOperator(op); useStore.getState().setBookingsOperator?.(op); setStage('app'); }} /><BookingsToast /></>;

  return (
    <div style={{ height: '100vh', display: 'flex', overflow: 'hidden', background: 'var(--bg)', color: 'var(--t1)' }}>
      {/* position:fixed, so it sits outside this flex row and over everything. */}
      <BookingsToast />
      {/* ── nav rail ── */}
      <div style={{
        width: 64, flexShrink: 0, background: 'var(--bg1)', borderRight: '1px solid var(--bdr)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '12px 0',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 11, display: 'grid', placeItems: 'center', marginBottom: 8,
          background: 'var(--acc)', color: 'var(--bg)', fontSize: 15, fontWeight: 800, fontFamily: 'var(--font-display, inherit)',
        }}>S</div>
        {NAV.map((n) => {
          const active = screen === n.k;
          return (
            <button
              key={n.k}
              onClick={() => { if (!n.soon) setScreen(n.k); }}
              disabled={n.soon}
              title={n.soon ? `${n.label} — coming soon` : n.label}
              style={{
                width: 48, height: 52, borderRadius: 12, cursor: n.soon ? 'not-allowed' : 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
                background: active ? tintBg('var(--acc)') : 'transparent',
                border: `1px solid ${active ? tintBd('var(--acc)') : 'transparent'}`,
                color: active ? 'var(--acc)' : n.soon ? 'var(--t4)' : 'var(--t3)',
                transition: 'all 140ms cubic-bezier(.2,.8,.3,1)',
              }}
            >
              <Icon name={n.icon} size={18} stroke={1.7} />
              <span style={{ fontSize: 9, fontWeight: 700 }}>{n.soon ? 'soon' : n.label}</span>
            </button>
          );
        })}
      </div>

      {/* ── main column ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* top bar */}
        <div style={{
          height: 60, flexShrink: 0, background: 'var(--bg1)', borderBottom: '1px solid var(--bdr)',
          display: 'flex', alignItems: 'center', gap: 16, padding: '0 18px',
        }}>
          <button
            onClick={() => { setOperator(null); useStore.getState().setBookingsOperator?.(null); setStage('pin'); }}
            title="Tap to switch user"
            style={{ minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontFamily: 'inherit' }}
          >
            <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {venueName || venue?.name || 'Table bookings'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--t3)' }}>
              {operator?.name ? `${operator.name} · ` : ''}Table bookings · {!bookingsDate || bookingsDate === venueYmd ? `Today, ${ymdLabel(venueYmd, { long: true })}` : ymdLabel(bookingsDate, { long: true })}
            </div>
          </button>
          <LinkPill />
          <div style={{ flex: 1 }} />
          <RequestsInbox bar />
          <LiveClock />
          <button className="btn btn-acc" onClick={goBook} style={{ height: 40, borderRadius: 11, padding: '0 18px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="plus" size={16} /> New booking
          </button>
        </div>

        {/* screens — kept mounted so their state persists across nav switches */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <Pane show={screen === 'service'}><ServiceScreen sel={sel} onSelect={setSel} onBook={goBook} /></Pane>
          <Pane show={screen === 'timeline'}><DiaryScreen sel={sel} onSelect={setSel} onBook={goBook} /></Pane>
          <Pane show={screen === 'book'}><BookScreen onBooked={onBooked} /></Pane>
          <Pane show={screen === 'rules'}><RulesScreen /></Pane>
          <Pane show={screen === 'events'}><EventsScreen /></Pane>
          <Pane show={screen === 'reports'}><ReportsScreen /></Pane>
          <Pane show={screen === 'widget'}><WidgetScreen show={screen === 'widget'} /></Pane>
        </div>
      </div>
    </div>
  );
}

// v5.7.52 — store.showToast() sets `toast`, but the only <Toast> in the app lives
// inside the POS shell (App.jsx ValidatedPOSApp), and the host stand returns from
// its own branch. So every refusal raised anywhere in this tree was discarded
// silently. That is why "Seat now" looked dead: seatBooking REFUSES when a table
// still has an open POS tab and says so through a toast that never rendered.
// Same family as the vanishing-categories saga and the invisible BO toasts:
// control-test the feedback channel before debugging the feature.
// Mirrors MPOSToast in src/surfaces/MPOSSurface.jsx.
function BookingsToast() {
  const toast = useStore((s) => s.toast);
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
      style={{ background: c.bg, border: `1px solid ${c.bdr}`, color: c.color, zIndex: 100003 }}>
      {toast.msg}
    </div>
  );
}

function Pane({ show, children }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: show ? 'flex' : 'none', flexDirection: 'column', minHeight: 0 }}>
      {children}
    </div>
  );
}

// 16 Oct 2026 (audit item 8): the VENUE's wall clock, so a stand in California
// for a UK venue shows UK time like everything else on it.
function LiveClock() {
  const tz = useStore((s) => s.locationConfig?.timezone);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--acc)', ...mono }}>
        {venueClockText(tz, now)}
      </div>
      <div style={{ fontSize: 10, color: 'var(--t3)' }}>live service</div>
    </div>
  );
}

// 16 Oct 2026 (audit item 9): the pill shows the real link, not a fixed green:
// Connecting, POS linked, or Offline with when the diary last loaded.
function LinkPill() {
  const status = useStore((s) => s.bookingsChannelStatus);
  const refreshedAt = useStore((s) => s.bookingsRefreshedAt);
  const tz = useStore((s) => s.locationConfig?.timezone);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  const pill = channelPill(status, { online });
  const col = pill.tone === 'green' ? 'grn' : pill.tone === 'red' ? 'red' : 'orn';
  const sub = pill.tone === 'red' && refreshedAt
    ? `last updated ${venueClockText(tz, new Date(refreshedAt), { seconds: false })}`
    : pill.sub;
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: 7, padding: '5px 11px', borderRadius: 20,
      background: `var(--${col}-d, ${tintBg(`var(--${col})`)})`, border: `1px solid var(--${col}-b, ${tintBd(`var(--${col})`)})`,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: `var(--${col})` }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: `var(--${col})` }}>{pill.label}</span>
      <span style={{ fontSize: 11, color: 'var(--t3)' }}>{sub}</span>
    </div>
  );
}

// ── the gate (pairing + PIN, mirrors WaitlistSurface) ──────────────────────────
function GateScreen({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)', color: 'var(--t1)' }}>
      {children}
    </div>
  );
}

function PairScreen({ code }) {
  return (
    <GateScreen>
      <div className="sv-glass" style={{ padding: 28, textAlign: 'center', maxWidth: 360 }}>
        <div style={{ fontSize: 13, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>Pair this host stand</div>
        <div style={{ fontSize: 42, fontWeight: 800, letterSpacing: '.12em', margin: '16px 0', color: 'var(--acc)', ...mono }}>{code || '········'}</div>
        <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5 }}>
          In Back Office → Channels → Table bookings, enter this code under &ldquo;Pair a host stand&rdquo;. One pairing covers Bookings and Tables Ready on this tablet. This screen links automatically once it&rsquo;s attached to a venue.
        </div>
        {(isMock || !code) && (
          <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.5, marginTop: 14, ...mono }}>
            {isMock
              ? 'Demo mode — no pairing service connected, so no claim code can be issued here.'
              : 'No claim code yet — check the connection; this screen retries automatically.'}
          </div>
        )}
      </div>
    </GateScreen>
  );
}

// 16 Oct 2026 (audit item 19): the pad submits at the venue's PIN length (learnt
// from the last good login on this stand; until then only the OK key submits) and the OK key submits
// any PIN of 4 to 8 digits, so a venue with 6 digit PINs can log in.
function readPinLength(loc) {
  try { return venuePinLength(window.localStorage.getItem(pinLengthKey(loc))); } catch { return venuePinLength(null); }
}
function PinScreen({ loc, venueName, onOk }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pinLen, setPinLen] = useState(() => readPinLength(loc));
  const submit = async (p) => {
    if (busy) return;
    setBusy(true);
    const data = await waitlistPinLogin(loc, p);
    setBusy(false);
    if (!data?.ok) { setErr('PIN not recognised'); setPin(''); return; }
    try { window.localStorage.setItem(pinLengthKey(loc), String(p.length)); } catch { /* private mode */ }
    setPinLen(venuePinLength(p.length));
    onOk({ id: data.id, name: data.name, role: data.role });
  };
  const tap = (d) => {
    if (busy) return;
    setErr('');
    const next = (pin + d).slice(0, PIN_MAX);
    setPin(next);
    if (pinPadState(next, pinLen).auto) submit(next);
  };
  const canOk = pinPadState(pin, pinLen).ok && !busy;
  return (
    <GateScreen>
      <div style={{ textAlign: 'center', width: 280 }}>
        <div style={{ fontSize: 13, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>{venueName || 'Table bookings'}</div>
        <div style={{ fontSize: 18, fontWeight: 800, margin: '6px 0 18px' }}>Enter your PIN</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 18 }}>
          {Array.from({ length: Math.max(pinLen || PIN_MIN, pin.length) }, (_, i) => <div key={i} style={{ width: 14, height: 14, borderRadius: 999, background: i < pin.length ? 'var(--acc)' : 'var(--inset)', border: '1px solid var(--bdr2)' }} />)}
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => <PinKey key={n} onClick={() => tap(String(n))}>{n}</PinKey>)}
          <PinKey onClick={() => setPin(pin.slice(0, -1))}>⌫</PinKey>
          <PinKey onClick={() => tap('0')}>0</PinKey>
          <PinKey onClick={() => { if (canOk) submit(pin); }} disabled={!canOk}>OK</PinKey>
        </div>
      </div>
    </GateScreen>
  );
}
const PinKey = ({ children, onClick, disabled = false }) => (
  <button onClick={onClick} disabled={disabled} className="sv-glass" style={{ height: 60, fontSize: 22, fontWeight: 700, color: disabled ? 'var(--t4)' : 'var(--t1)', cursor: disabled ? 'default' : 'pointer', border: '1px solid var(--bdr)', ...mono }}>{children}</button>
);
