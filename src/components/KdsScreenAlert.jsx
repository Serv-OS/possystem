// src/components/KdsScreenAlert.jsx
//
// 12 Oct 2026, Coffee Boy Barnsley (K6): the drinks screen stopped showing orders for half an hour
// and nothing told the till. This bar tells it: a red bar across the top of the till naming the
// screen, a chime when it comes up and again every five minutes while it lasts, and a green line
// when the screen is back. OK hides the bar until the next chime. It is a bar, not a pop up: it
// never takes a tap away from the till, so it cannot get in the way of a payment.
//
// The rules are in lib/kds/kdsScreenWatch.js (watchLook), with their tests. Local first, and
// nothing here is on the order path:
//   the orders waiting  the till's own list (store kdsTickets). No read.
//   READ 1              the venue's devices rows (a handful), once a minute, only while an order
//                       has waited over two minutes in trading hours, and once more when a bar is
//                       about to come down (so "back" is only said for a screen heard from again).
//   READ 2              the status of up to 20 of the oldest waiting tickets, when a chime is due
//                       (or while the last check showed this till's own list is behind). A till
//                       whose own list is behind must not cry wolf.
// A read that fails changes nothing. Each read is given up after 10 seconds.
//
// Mounted inside components/KioskStaffAlert.jsx (the fixed slot App.jsx gives every till body). It
// runs on counter tills only: never on a kitchen screen, a kiosk, a handheld or a clock.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { supabase, isMock } from '../lib/supabase';
import { withTimeout } from '../lib/withTimeout';
import { isOpenNow } from '../lib/openingHours';
import { venueBusinessDayStart } from '../lib/kds/kdsTicket';
import { playOrderChime } from '../lib/orderChime';
import {
  WATCH_TICK_MS, BACK_LINE_MS, MAX_WAIT_MS, watchRunsOn, isTrading, leftWaiting, newWatch, watchLook,
  hideAlert, alertWords, backWords,
} from '../lib/kds/kdsScreenWatch';

const READ_LIMIT_MS = 10000;
const FIRST_LOOK_MS = 15000;
const readDevice = () => { try { return JSON.parse(localStorage.getItem('rpos-device') || 'null'); } catch { return null; } };

// One small read with a time limit. null means "could not tell" (an error, or no answer in time).
async function limitedRead(build, label) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    let q = build();
    // ONE request per look. A read that fails is asked again a minute later, so the client's own
    // three repeats (1, 2 and 4 seconds apart) are not wanted here.
    if (typeof q.retry === 'function') q = q.retry(false);
    if (ctrl && typeof q.abortSignal === 'function') q = q.abortSignal(ctrl.signal);
    const res = await withTimeout(q, READ_LIMIT_MS, label);
    return res && !res.error && Array.isArray(res.data) ? res.data : null;
  } catch {
    // Given up: cancel it, so a request that hung does not stay open on the till.
    try { if (ctrl) ctrl.abort(); } catch { /* nothing to cancel */ }
    return null;
  }
}

export default function KdsScreenAlert() {
  const [device] = useState(readDevice);
  const defaultSurface = useStore(s => s.deviceConfig?.defaultSurface);
  // An MPOS style handover (the till is in a customer's hands): wait, as the kiosk alert does.
  const held = useStore(s => s.tillCustomerFacing === true);
  const locationId = device?.locationId || null;
  const on = !isMock && !!supabase && !!locationId && watchRunsOn({ type: device?.type, defaultSurface });
  const [alerts, setAlerts] = useState({});
  const [back, setBack] = useState([]);          // [{ key, text, until }]
  const [clock, setClock] = useState(0);         // when the bars were last worked out
  const alertsRef = useRef(alerts);
  useEffect(() => { alertsRef.current = alerts; }, [alerts]);

  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    let busy = false;
    const watch = newWatch(Date.now());
    const timers = new Set();
    // What the till already holds: a kitchen ticket that leaves its list was bumped.
    const unsub = useStore.subscribe((state, prev) => {
      if (state.kdsTickets === prev.kdsTickets) return;
      const at = Date.now();
      for (const station of leftWaiting(prev.kdsTickets, state.kdsTickets)) watch.bumpSeenAt.set(station, at);
    });
    // READ 1: the kitchen screens' last heartbeats (and this till's own, which is the clock they are judged by).
    const readDevices = () => limitedRead(
      () => supabase.from('devices').select('id,name,type,status,centre_id,last_seen,kds_settings').eq('location_id', locationId),
      'Kitchen screens');
    // READ 2: are the oldest waiting tickets really still waiting?
    const readStatuses = (ids) => limitedRead(
      () => supabase.from('kds_tickets').select('id,status').in('id', ids),
      'Kitchen tickets');
    const look = async () => {
      if (!alive || busy) return;
      busy = true;
      try {
        const now = Date.now();
        const st = useStore.getState();
        const cfg = st.locationConfig || {};
        const tz = cfg.timezone || 'Europe/London';
        let dayStartMs = now - MAX_WAIT_MS;
        try { dayStartMs = venueBusinessDayStart(now, tz, cfg.businessDayStart || '06:00').getTime(); } catch { /* keep the fallback */ }
        const next = await watchLook({
          tickets: st.kdsTickets,
          trading: isTrading({ openingHours: cfg.opening_hours, timeZone: tz, now, isOpenNow }),
          dayStartMs, getAlerts: () => alertsRef.current, watch, now, readDevices, readStatuses,
        });
        if (!alive || !next) return;               // nothing to watch, or it could not tell: nothing changes
        alertsRef.current = next.alerts;
        setAlerts(next.alerts);
        setClock(now);
        if (next.back.length) {
          setBack(list => [...list.filter(b => b.until > now), ...next.back.map(b => ({ key: `${b.screenId}-${now}`, text: backWords(b), until: now + BACK_LINE_MS }))]);
          const t = setTimeout(() => {
            timers.delete(t);
            if (!alive) return;
            const at = Date.now();
            setBack(list => list.filter(b => b.until > at));
            setClock(at);
          }, BACK_LINE_MS + 200);
          timers.add(t);
        }
        if (next.sound && !useStore.getState().tillCustomerFacing) playOrderChime();
      } catch { /* a look that failed changes nothing */ }
      finally { busy = false; }
    };
    const firstLook = setTimeout(look, FIRST_LOOK_MS);
    const every = setInterval(look, WATCH_TICK_MS);
    return () => {
      alive = false;
      unsub();
      clearTimeout(firstLook);
      clearInterval(every);
      timers.forEach(clearTimeout);
    };
  }, [on, locationId]);

  if (!on || held) return null;
  // OK: hidden until the next chime. The look in flight must see it too, so the ref is set at the tap.
  const ok = (screenId) => { const next = hideAlert(alertsRef.current, screenId); alertsRef.current = next; setAlerts(next); };
  const shown = Object.values(alerts).filter(a => !(a.hiddenUntil > clock));
  const lines = back.filter(b => b.until > clock);
  if (!shown.length && !lines.length) return null;

  return (
    // Under the "this till lost its link" bar (10040) and the offline bar: those are about this till itself.
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10030, display: 'flex', flexDirection: 'column', fontFamily: 'inherit' }}>
      {shown.map(a => {
        const w = alertWords(a);
        return (
          <div key={a.screenId} role="alert" style={{
            background: '#b91c1c', color: '#fff', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
            boxShadow: '0 2px 12px rgba(0,0,0,0.35)', borderBottom: '1px solid rgba(255,255,255,.25)',
          }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontWeight: 800, fontSize: 19, lineHeight: 1.25 }}>{w.title}</div>
              <div style={{ fontSize: 15, lineHeight: 1.35, marginTop: 3 }}>{w.body}</div>
            </div>
            <button type="button" onClick={() => ok(a.screenId)}
              style={{ padding: '10px 22px', minHeight: 44, borderRadius: 10, border: 'none', background: '#fff', color: '#b91c1c', fontWeight: 800, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}>
              OK
            </button>
          </div>
        );
      })}
      {lines.map(b => (
        <div key={b.key} role="status" style={{ background: '#14532d', color: '#fff', padding: '10px 16px', fontWeight: 800, fontSize: 16 }}>{b.text}</div>
      ))}
    </div>
  );
}
