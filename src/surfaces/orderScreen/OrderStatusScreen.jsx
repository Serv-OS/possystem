// src/surfaces/orderScreen/OrderStatusScreen.jsx
//
// Order screen container: a TV paired in Back Office, Channels, Order screens. Rendered by
// MenuBoardSurface when its own menu_board_screens row carries an order_display_id, so the
// menu board APK and ?mode=orderscreen share one pairing flow.
//
// Data: ONLY the order_status_feed RPC. It finds this device's own screen row by auth.uid(),
// its venue and config, and returns masked rows (names are shortened in SQL). The screen
// never reads or subscribes to order_queue. Rows live in memory only, never in storage.
//
// Liveness (iPads and Android WebViews suspend apps and kill websockets):
//   1. poll every 5 s, single flight, out of order responses dropped
//   2. refetch on visibilitychange (visible) and on online
//   3. realtime on order_status_pings (no personal data) is only a 400 ms debounced nudge
//   4. every await has a timeout, and a watchdog abandons a flight that still hangs, so a
//      half open socket or a stalled auth lock after wake can never freeze the board
//   5. no good feed for 15 s shows the offline strip, even while the browser says online
// Time: every "now" is server_now plus elapsed device time. Clock text uses the venue zone.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, ensureAuthToken } from '../../lib/supabase';
import { fetchOrderScreenFeed } from '../../lib/orderScreen/orderScreenData';
import { normaliseDisplay, rowFromFeed, visibleRows, sortRows } from '../../lib/orderScreen/orderScreenStatus';
import { readyArrivals, stageSize } from '../../lib/orderScreen/orderScreenLayout';
import { fetchVenueTimezone } from '../../lib/venueTimezone';
import { playOrderChime } from '../../lib/orderChime';
import { withTimeout } from '../../lib/withTimeout';
import OrderBoard from './OrderBoard';

const POLL_MS = 5000;
const AUTH_TIMEOUT_MS = 5000;
const FEED_TIMEOUT_MS = 8000;
const FLIGHT_STALL_MS = 15000;     // longer than auth + feed timeouts together: only a true hang
const STALE_FEED_MS = 15000;       // no good feed for this long means the board may be out of date
const NUDGE_DEBOUNCE_MS = 400;
const UNASSIGNED_THROTTLE_MS = 10000;
const TZ_REFRESH_MS = 30 * 60000;
const CHIME_GAP_MS = 3000;
const JUST_READY_MS = 4000;
const TZ_KEY = 'rpos-osd-tz';
const STAGE_KEY = 'rpos-osd-stage';  // layout only ({ orientation, rotate }), never personal data
const FALLBACK_TZ = 'Europe/London';
const LOCATION_KEY_RE = /^[0-9a-f-]{36}$/i;
const EMPTY_SET = new Set();
let warnedNoTz = false;

function validTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}
function readStoredTz() {
  try { const v = localStorage.getItem(TZ_KEY); return validTz(v) ? v : null; } catch { return null; }
}
// Only a zone from fetchVenueTimezone (the platform venue record) is ever cached. The feed's
// venue.timezone is the legacy ops column and must never overwrite a good cached zone.
function storeTz(tz) {
  try { localStorage.setItem(TZ_KEY, tz); } catch { /* storage blocked, keep in memory */ }
}
function readStoredStage() {
  try {
    const v = JSON.parse(localStorage.getItem(STAGE_KEY) || 'null');
    return v && typeof v === 'object' ? { orientation: v.orientation, rotate: Number(v.rotate) } : null;
  } catch { return null; }
}
const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

export default function OrderStatusScreen({ screenId, onUnassigned }) {
  const [feed, setFeed] = useState(null);                 // last good feed: { ...data, display, rows }
  const [phase, setPhase] = useState('loading');          // loading | ok | absent | error | unpaired
  const [offsetMs, setOffsetMs] = useState(0);
  const [lastOkServerMs, setLastOkServerMs] = useState(null);
  const [lastOkDeviceMs, setLastOkDeviceMs] = useState(null);
  const [failures, setFailures] = useState(0);
  const [fetchedTz, setFetchedTz] = useState(null);
  const [storedTz] = useState(readStoredTz);
  const [justReady, setJustReady] = useState(EMPTY_SET);
  const [clock, setClock] = useState(() => Date.now());   // device ms, ticks every second
  const [online, setOnline] = useState(isOnline);
  const [wakeSeq, setWakeSeq] = useState(0);

  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);
  const flightSeqRef = useRef(0);
  const flightStartRef = useRef(0);
  const pendingRef = useRef(false);
  const reqSeqRef = useRef(0);
  const prevRowsRef = useRef(null);                        // null until the first good feed: no chime on first load
  const lastUnassignedRef = useRef(0);
  const lastChimeRef = useRef(0);
  const justReadyUntilRef = useRef(new Map());
  const subSeqRef = useRef(0);
  const wakeLockRef = useRef(null);
  const stageKeyRef = useRef('');
  const screenIdRef = useRef(screenId);
  const onUnassignedRef = useRef(onUnassigned);

  useEffect(() => { screenIdRef.current = screenId; }, [screenId]);
  useEffect(() => { onUnassignedRef.current = onUnassigned; }, [onUnassigned]);

  const applyResult = useCallback((res) => {
    if (res?.absent) {
      prevRowsRef.current = null;
      setFeed(null);
      setPhase('absent');
      return;
    }
    const data = res?.data;
    if (res?.error || !data || typeof data !== 'object') {
      setFailures((f) => f + 1);
      setPhase((p) => (p === 'ok' || p === 'error' ? 'error' : p === 'loading' ? 'error' : p));
      return;
    }
    if (data.paired === false) {
      // Unpaired, reassigned or retired: drop every row at once, then let the parent
      // re-read its own row (it shows the pairing code or the menu board).
      prevRowsRef.current = null;
      setFeed(null);
      setFailures(0);
      setPhase('unpaired');
      const now = Date.now();
      if (now - lastUnassignedRef.current >= UNASSIGNED_THROTTLE_MS) {
        lastUnassignedRef.current = now;
        try { onUnassignedRef.current?.(); } catch { /* parent tick is best effort */ }
      }
      return;
    }

    const serverMs = Date.parse(data.server_now);
    if (Number.isFinite(serverMs)) {
      setOffsetMs(serverMs - Date.now());
      setLastOkServerMs(serverMs);
    }
    setLastOkDeviceMs(Date.now());
    setFailures(0);
    const display = normaliseDisplay(data.display);
    const rows = Array.isArray(data.rows) ? data.rows.map(rowFromFeed) : [];

    if (display.settings.chime === true && prevRowsRef.current) {
      const arrivals = readyArrivals(prevRowsRef.current, rows);
      if (arrivals.length) {
        const now = Date.now();
        const until = justReadyUntilRef.current;
        for (const k of arrivals) until.set(k, now + JUST_READY_MS);
        setJustReady(new Set(until.keys()));
        if (now - lastChimeRef.current >= CHIME_GAP_MS) {
          lastChimeRef.current = now;
          playOrderChime();
        }
      }
    }
    prevRowsRef.current = rows;

    // Layout only, so the splash screens turn with the board after a restart.
    const stageKey = JSON.stringify({ orientation: display.orientation, rotate: display.rotate });
    if (stageKey !== stageKeyRef.current) {
      stageKeyRef.current = stageKey;
      try { localStorage.setItem(STAGE_KEY, stageKey); } catch { /* storage blocked */ }
    }

    const venueTz = data.venue?.timezone;
    setFeed({
      location_key: typeof data.location_key === 'string' ? data.location_key : null,
      active: data.active !== false,
      venue: { name: data.venue?.name || '', timezone: validTz(venueTz) ? venueTz : null },
      display,
      rows,
    });
    setPhase('ok');
  }, []);

  // Single flight: a call while one is running asks for exactly one more run after it.
  // Watchdog: a flight running longer than FLIGHT_STALL_MS is abandoned (counted as a
  // failure, its late answer dropped) and a fresh request starts at once.
  const load = useCallback(async () => {
    if (inFlightRef.current) {
      if (Date.now() - flightStartRef.current <= FLIGHT_STALL_MS) { pendingRef.current = true; return; }
      reqSeqRef.current += 1;
      setFailures((f) => f + 1);
      setPhase((p) => (p === 'loading' ? 'error' : p === 'ok' ? 'error' : p));
    }
    const flight = ++flightSeqRef.current;
    inFlightRef.current = true;
    try {
      do {
        pendingRef.current = false;
        flightStartRef.current = Date.now();
        const seq = ++reqSeqRef.current;
        const sid = screenIdRef.current;
        try { await withTimeout(ensureAuthToken(), AUTH_TIMEOUT_MS, 'Auth session'); } catch { /* the feed call reports the failure */ }
        let res;
        if (!sid) {
          res = { data: { paired: false } };
        } else {
          try {
            res = await withTimeout(fetchOrderScreenFeed(sid, { timeoutMs: FEED_TIMEOUT_MS }), FEED_TIMEOUT_MS + 1000, 'Order screen feed');
          } catch (e) {
            res = { data: null, error: e };
          }
        }
        if (!aliveRef.current || flight !== flightSeqRef.current) return;
        if (seq !== reqSeqRef.current || sid !== screenIdRef.current) continue;
        applyResult(res);
      } while (pendingRef.current && aliveRef.current);
    } finally {
      if (flight === flightSeqRef.current) inFlightRef.current = false;
    }
  }, [applyResult]);

  const requestWakeLock = useCallback(() => {
    try {
      const wl = typeof navigator !== 'undefined' ? navigator.wakeLock : null;
      if (!wl || typeof wl.request !== 'function') return;
      wl.request('screen').then((sentinel) => {
        if (!aliveRef.current) { sentinel?.release?.().catch?.(() => {}); return; }
        wakeLockRef.current = sentinel;
      }).catch(() => {});
    } catch { /* no wake lock on this browser */ }
  }, []);

  // Poll, wake and network. Mount only: load and requestWakeLock are stable.
  useEffect(() => {
    aliveRef.current = true;
    const kick = setTimeout(() => { load(); }, 0);
    requestWakeLock();
    const poll = setInterval(() => { load(); }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      load();
      setWakeSeq((s) => s + 1);   // resubscribe realtime: the socket may have died while asleep
      requestWakeLock();
    };
    const onOnline = () => { setOnline(true); load(); };
    const onOffline = () => setOnline(false);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      aliveRef.current = false;
      clearTimeout(kick);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      if (sentinel) { try { sentinel.release().catch(() => {}); } catch { /* already released */ } }
    };
  }, [load, requestWakeLock]);

  // One second clock for expiry, paging and the footer; also ends the Ready pulse.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setClock(now);
      setOnline(isOnline());
      const until = justReadyUntilRef.current;
      if (until.size) {
        let changed = false;
        for (const [k, exp] of until) if (exp <= now) { until.delete(k); changed = true; }
        if (changed) setJustReady(until.size ? new Set(until.keys()) : EMPTY_SET);
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const locationKey = feed?.location_key || null;

  // Realtime nudge. A fresh topic per subscription (a reused topic can attach to the
  // channel that is still leaving). Never breaks the poll.
  useEffect(() => {
    if (!supabase || !locationKey || !LOCATION_KEY_RE.test(locationKey)) return undefined;
    let ch = null;
    let timer = null;
    try {
      ch = supabase.channel(`orderscreen:${locationKey}:${++subSeqRef.current}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'order_status_pings', filter: `location_id=eq.${locationKey}` }, () => {
          clearTimeout(timer);
          timer = setTimeout(() => { load(); }, NUDGE_DEBOUNCE_MS);
        })
        .subscribe();
    } catch (e) {
      console.warn('[orderscreen] realtime', e?.message);
    }
    return () => {
      clearTimeout(timer);
      if (ch) { try { supabase.removeChannel(ch); } catch { /* already gone */ } }
    };
  }, [locationKey, wakeSeq, load]);

  // Venue zone from the platform venue record, on the first good feed and every 30 minutes.
  useEffect(() => {
    if (!locationKey) return undefined;
    let alive = true;
    const run = async () => {
      try {
        const tz = await fetchVenueTimezone(locationKey);
        if (alive && validTz(tz)) { setFetchedTz(tz); storeTz(tz); }
      } catch { /* keep the last good zone */ }
    };
    run();
    const t = setInterval(run, TZ_REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, [locationKey]);

  // Platform zone, then the cached platform zone, then the legacy ops zone, then London.
  const tz = fetchedTz || storedTz || feed?.venue?.timezone || FALLBACK_TZ;
  const usingFallbackTz = !!feed && !fetchedTz && !storedTz && !feed?.venue?.timezone;
  useEffect(() => {
    if (usingFallbackTz && !warnedNoTz) {
      warnedNoTz = true;
      console.warn('[orderscreen] venue timezone unknown, the clock shows Europe/London time');
    }
  }, [usingFallbackTz]);

  const nowMs = clock + offsetMs;
  const rows = useMemo(() => (feed ? sortRows(visibleRows(feed.rows, nowMs)) : []), [feed, nowMs]);
  const staleFeed = lastOkDeviceMs != null && clock - lastOkDeviceMs > STALE_FEED_MS;
  const offline = failures >= 2 || !online || staleFeed;

  if (phase === 'absent') {
    return <Splash title="Order screens are not set up yet." sub="Ask your manager to finish setup in Back Office." />;
  }
  if (phase === 'unpaired') return <Splash title="Checking this screen" />;
  if (!feed) {
    if (phase === 'error') return <Splash title="Cannot reach ServOS right now." sub="This screen will keep trying." />;
    return <Splash title="Connecting to the venue" />;
  }
  if (!feed.active || feed.display.is_active === false) {
    return <Splash title="This order screen is turned off." sub="Turn it on in Back Office to show orders." />;
  }
  if (!feed.display.sections.length) {
    return <Splash title="No sections are set up yet." sub="Add one in Back Office." />;
  }
  return (
    <OrderBoard
      mode="screen"
      display={feed.display}
      venueName={feed.venue.name}
      rows={rows}
      nowMs={nowMs}
      tz={tz}
      lastUpdatedMs={lastOkServerMs}
      offline={offline}
      justReady={justReady}
    />
  );
}

// Full screen message. Turns with the last known layout, so a portrait TV hung on a landscape
// app reads it the right way up, like the board.
function Splash({ title, sub }) {
  const [saved] = useState(readStoredStage);
  const vw = typeof window !== 'undefined' ? window.innerWidth || 0 : 0;
  const vh = typeof window !== 'undefined' ? window.innerHeight || 0 : 0;
  const stage = stageSize({ vw, vh, orientation: saved?.orientation, rotate: saved?.rotate });
  return (
    <div role="status" style={{
      position: 'fixed', inset: 0, background: '#0F1211', color: '#FFFFFF', overflow: 'hidden',
      fontFamily: "'Space Grotesk', 'Plus Jakarta Sans', system-ui, sans-serif",
    }}>
      <div style={{
        position: 'absolute', left: '50%', top: '50%',
        width: stage.w || '100%', height: stage.h || '100%', transform: stage.transform, transformOrigin: 'center center',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', padding: '8vmin', boxSizing: 'border-box',
      }}>
        <div style={{ fontSize: 'clamp(22px, 4.2vmin, 48px)', fontWeight: 700, lineHeight: 1.2 }}>{title}</div>
        {sub && <div style={{ fontSize: 'clamp(16px, 2.6vmin, 28px)', color: '#9AA39F', marginTop: '1.2vmin', maxWidth: 900, lineHeight: 1.4 }}>{sub}</div>}
      </div>
    </div>
  );
}
