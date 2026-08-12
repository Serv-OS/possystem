// src/surfaces/bookings/BookingsSurface.jsx
//
// Table Bookings — the host-stand surface shell. Renders INSIDE the POS app
// shell (SyncBridge present, store hydrated), so it has no pairing / PIN of its
// own: left nav rail (Diary / Floor / Book / Rules live; Events / Reports /
// Widget marked "soon"), a top bar (venue, live clock, New booking), and the
// four screens switched by in-component state. Screens stay MOUNTED and hide
// with display:none so their local state survives nav switches (handoff
// "Interactions": state persists across switches).
//
// Skin: data-skin='servos' on <html> with the WaitlistSurface save+restore
// pattern, so leaving the surface puts the app's original skin/theme back.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Icon } from '../../components/ServOSIcons';
import { mono, tintBg, tintBd } from './bits.jsx';
import DiaryScreen from './DiaryScreen.jsx';
import FloorScreen from './FloorScreen.jsx';
import BookScreen from './BookScreen.jsx';
import RulesScreen from './RulesScreen.jsx';

const NAV = [
  { k: 'diary',   label: 'Diary',   icon: 'home' },
  { k: 'floor',   label: 'Floor',   icon: 'floor' },
  { k: 'book',    label: 'Book',    icon: 'plus' },
  { k: 'rules',   label: 'Rules',   icon: 'settings' },
  { k: 'events',  label: 'Events',  icon: 'inventory', soon: true },
  { k: 'reports', label: 'Reports', icon: 'reports',   soon: true },
  { k: 'widget',  label: 'Widget',  icon: 'channels',  soon: true },
];

export default function BookingsSurface() {
  const [screen, setScreen] = useState('diary');
  const [sel, setSel] = useState(null); // selected booking id (Diary inspector)

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

  // ── hydrate the diary once (store + SyncBridge own everything else) ──────────
  useEffect(() => { useStore.getState().loadBookingsFromDB?.(); }, []);

  const locations = useStore((s) => s.locations) || [];
  const currentLocationId = useStore((s) => s.currentLocationId);
  const bookingsDate = useStore((s) => s.bookingsDate);
  const venue = locations.find((l) => l.id === currentLocationId) || locations[0];

  const goBook = () => setScreen('book');
  const onBooked = (id) => { setSel(id); setScreen('diary'); };

  return (
    <div style={{ height: '100vh', display: 'flex', overflow: 'hidden', background: 'var(--bg)', color: 'var(--t1)' }}>
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
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {venue?.name || 'Table bookings'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--t3)' }}>Table bookings · {bookingsDate || 'today'}</div>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7, padding: '5px 11px', borderRadius: 20,
            background: 'var(--grn-d)', border: '1px solid var(--grn-b)',
          }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--grn)' }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--grn)' }}>POS linked</span>
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>floor + menu live</span>
          </div>
          <div style={{ flex: 1 }} />
          <LiveClock />
          <button className="btn btn-acc" onClick={goBook} style={{ height: 40, borderRadius: 11, padding: '0 18px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="plus" size={16} /> New booking
          </button>
        </div>

        {/* screens — kept mounted so their state persists across nav switches */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <Pane show={screen === 'diary'}><DiaryScreen sel={sel} onSelect={setSel} onBook={goBook} /></Pane>
          <Pane show={screen === 'floor'}><FloorScreen /></Pane>
          <Pane show={screen === 'book'}><BookScreen onBooked={onBooked} /></Pane>
          <Pane show={screen === 'rules'}><RulesScreen /></Pane>
        </div>
      </div>
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

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--acc)', ...mono }}>
        {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--t3)' }}>live service</div>
    </div>
  );
}
