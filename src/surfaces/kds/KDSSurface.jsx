// src/surfaces/kds/KDSSurface.jsx
//
// Kitchen display, redesigned in v5.8.66 from design_handoff_kds (README.md is the spec).
// Moved out of OtherSurfaces.jsx, which re-exports it, so App.jsx is unchanged.
//
// What carried over from the old board, unchanged in behaviour:
//   heartbeat every 60s · load pending + held for this location (and centre) · realtime
//   INSERT / UPDATE with the centre guards (v5.5.913) · the self heal refetch on wake,
//   on network return and every 20s (v5.7.39) · per item ticks, where ticking the last
//   item bumps the ticket · History with Recall · station buttons when the screen is not
//   tied to one centre · the TO MAKE list split by modifiers · mock mode from the store.
//
// What Peter decided on 14 Sep 2026 (see project memory "KDS redesign"):
//   five order types (Delivery pink) · resume and recall keep counting from first sent ·
//   Recall last = last ticket bumped at this station today, from any screen · History
//   shows today only · Undo for 5 seconds after a bump · held tickets dim in place and
//   move to the end (switch) · held tickets do not count in TO MAKE · settings behind a
//   manager PIN, saved per screen in devices.kds_settings · auto columns as before.
//
// 30 Sep 2026 (Peter, Coffee Boy), three things:
//   · a note for the kitchen on the pop out, saved on every row of the order (lib/kds/kdsOrderNote.js)
//   · the venue can have the LAST bump mark the order ready, and collected (lib/kds/kdsAutoStatus.js)
//   · the type filter can no longer hide tickets unnoticed: banner, snap back after three minutes
//     or when a hidden type arrives, never saved (lib/kds/kdsTypeFilter.js). The list load has a
//     15 s timeout, an in flight guard, a "can't reach" banner and a refetch when realtime rejoins.
//
// 12 Oct 2026 (Coffee Boy Barnsley, drinks screen: "recalling items without us touching anything"):
//   the tablet's link hung requests for 30 to 380 seconds and the board coped badly. The list
//   reads, the live changes and every status write now run through lib/kds/kdsBoardEngine.js
//   (rules in kdsWriteLane.js, kdsBoardRows.js, kdsLinkHealth.js), which this file feeds and
//   paints. A bumped ticket never comes back by itself, every write has a time limit and a count
//   on screen, a large banner says slow or offline, and "Kitchen clear" is only said when sure.
//   On a healthy link the board looks and behaves as before.
//
// 12 Oct 2026, review of that build (three reviewers, each fault reproduced on the real engine):
//   a write the tablet's network gave up on is still delivered when a stalled link lets go, in
//   any order, so every Hold, Resume and recall now carries a guard in the write itself and can
//   no longer undo a newer tap (ticketWrite below, lib/kds/kdsWriteLane.js guardFor) · a bump that
//   is saved is not painted back by a late live echo · "N more orders below" is a strip under the
//   board, not a pill over the Bump buttons · the red banner does not blame the WiFi when ServOS
//   itself answers with an error · the empty board says nothing while its last bump is unsaved.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useStore } from '../../store';
import { VERSION } from '../../lib/version';
import { supabase, isMock, kitchenClient } from '../../lib/supabase';
import { liveRow } from '../../lib/liveRow';
import { updateDeviceHeartbeat } from '../../lib/db';
import { playOrderChime } from '../../lib/orderChime';
import { withTimeout } from '../../lib/withTimeout';
import { hubrisePushStatus } from '../../lib/hubrise';
import { isDeviceLinkUncertain } from '../../lib/deviceLink';
import { trustSharedRead } from '../../lib/deviceFence';
import { mustChangeRow, writeErrorOf } from '../../lib/rowWrites';
import { loadStaffRoster } from '../../lib/staffRoster';
import { logActivity } from '../../lib/activity';
import { getLocationConfig } from '../../lib/locationTime';
import {
  ticketMeta, ticketView, needsTypeLookup, minutesSince, sortTickets, typeCounts, rollUp, venueBusinessDayStart, kdsTypeKey,
} from '../../lib/kds/kdsTicket';
import { cleanKdsNote, kdsNoteOf, metaWithKdsNote, orderKeyOf, rowsOfSameOrder, SAME_SEND_WINDOW_MS } from '../../lib/kds/kdsOrderNote';
import { autoStatusSettings, autoStatusAfterBump, autoStatusSteps, bumpedWithoutRef } from '../../lib/kds/kdsAutoStatus';
import { filterAfterIdle, filterAfterArrival, hiddenCount, filterBanner } from '../../lib/kds/kdsTypeFilter';
import {
  normaliseKdsSettings, kdsSettingsStorageKey, isMissingColumnError, shouldBumpAfterTick,
} from '../../lib/kds/kdsSettings';
import {
  toggleTick, touchedTicks, mergeIncomingTicks, overlayTicks, tickFlags, ticksActive, LOCAL_TICKS_GRACE_MS,
} from '../../lib/kds/kdsItemTicks';
import { gridColumnWidth, cardScale } from '../../lib/kds/kdsFit';
import { createBoardEngine } from '../../lib/kds/kdsBoardEngine';
import { bannerWords, savingWords, emptyWords, countBelow, belowWords, traceWords } from '../../lib/kds/kdsLinkHealth';
import { KdsTicketCard, KdsTicketModal } from './KdsTicketCard';
import { KdsSettingsSheet, KdsManagerPin } from './KdsSettingsSheet';
import { C, SANS, MONO, ghostBtn, pill, monoLabel, KDS_KEYFRAMES } from './kdsStyles';

// Database fence stage 1, fix round 2 (the zero row blocker): every kds_tickets update here counts
// the rows it changed. One that changes nothing while this screen is not linked is kept and sent
// once it is linked again (the banner shows), never counted as done. Resolves { error, outcome }.
//
// 12 Oct 2026, Barnsley (K8): the board's own ticket reads and writes go through the kitchen
// screen client (lib/supabase.js kitchenClient). It sends the device's own stored sign in while
// that is still valid, so they never queue behind a sign in renewal that cannot reach the server
// (that queue held one bump for 3.5 minutes). `signal` lets the board cancel a send that hangs.
//
// 12 Oct 2026, review (K3): `guard` is more filters for the SAME write (lib/kds/kdsWriteLane.js
// guardFor): a Hold or Resume only changes a ticket that is not bumped, a recall only undoes the
// very bump it names. A request the tablet's network gave up on is still delivered when a stalled
// link lets go, in any order, and without the guard a late Hold un bumped a ticket. A write its
// guard refuses changes 0 rows and answers 'gone'. match and notMatch are the two filters a copy
// parked in the offline queue keeps, so that copy is guarded too.
let kitchenDbClient = null;
const kitchenDb = () => (kitchenDbClient || (kitchenDbClient = kitchenClient() || supabase));
const guarded = (id, guard) => (guard ? { match: { id, ...guard.match }, notMatch: { ...guard.notMatch } } : null);
const ticketWrite = (id, payload, label, signal, guard = null) =>
  mustChangeRow({ table: 'kds_tickets', type: 'update', payload, match: { id }, kind: 'kds_ticket', label, signal, ...guarded(id, guard) }, { client: kitchenDb() })
    .then((r) => ({ error: writeErrorOf(r), outcome: r.outcome }));

const UNDO_MS = 5000;
const MANAGER_GRACE_MS = 90 * 1000;
const HISTORY_LIMIT = 200;
// 30 Sep 2026: a read that hangs (a woken tablet, a stalled auth lock) used to hold the 20 s
// poll for ever with nothing on screen to say so. Every list read now gives up after this.
const LOAD_TIMEOUT_MS = 15000;
const AUTO_STATUS_SETTINGS_POLL_MS = 60000;
// 12 Oct 2026, Barnsley (K8): after a late sign in renewal the drinks tablet held NO live
// subscriptions for hours and nothing joined them again. A live channel that has not been joined
// for this long, while the socket itself is connected, is thrown away and made again.
const REJOIN_AFTER_MS = 60000;
const CHANNEL_CHECK_MS = 20000;
// Unsaved bumps and unsaved recalls are kept here across a restart of the app (lib/kds/kdsWriteLane.js toJournal).
const unsavedKey = (deviceId) => `rpos-kds-unsaved-${deviceId || 'screen'}`;
const GAVE_UP_WORD = { hold: 'Hold', resume: 'Resume', restore: 'Recall' };
/** An id for one activity feed row (a version 4 uuid), made here so a repeated insert is the same row. */
const traceId = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.floor(Math.random() * 16);
  return (c === 'x' ? r : (r % 4) + 8).toString(16);
});
const EMPTY_BOARD = Object.freeze({ rows: [], level: 'ok', sure: false, everApplied: false, unsavedBumps: 0, unsavedOthers: 0, failedBumps: 0, showSaving: false, serverFault: false });

/** One read with a real time limit: after `ms` the request is cancelled, not only left behind. */
function limitedRead(q, ms, label) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const req = ctl && typeof q?.abortSignal === 'function' ? q.abortSignal(ctl.signal) : q;
  return withTimeout(req, ms, label).catch((e) => { try { ctl?.abort(); } catch { /* already ended */ } throw e; });
}

const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };

/** A kds_tickets row (snake case) or a store ticket (camel case) → the board's shape. */
function mapRow(row) {
  let items = row.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  const sent = row.sent_at ?? row.sentAt;
  const bumped = row.bumped_at ?? row.bumpedAt;
  return {
    id: row.id,
    status: row.status || 'pending',
    held: row.status === 'held',
    table: row.table_label || row.table || '',
    server: row.server || '',
    covers: row.covers || 1,
    centreId: row.centre_id || row.centreId || null,
    sentAt: sent ? new Date(sent).getTime() : Date.now(),
    bumpedAt: bumped ? new Date(bumped).getTime() : null,
    firedCourses: row.fired_courses || row.firedCourses || [0, 1],
    allCourses: row.all_courses || row.allCourses || [],
    // filter(Boolean): 12 Oct 2026 review. One empty entry in the list (items: [null]) threw here,
    // and a list answer that cannot be mapped is a failed read for the whole board.
    items: (Array.isArray(items) ? items : []).filter(Boolean).map(i => ({ ...i, _bumped: i._bumped || false })),
    meta: ticketMeta(row),
    // 30 Sep 2026: the column as stored (the note write merges into it) and the kitchen's own note.
    rawMeta: row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : null,
    kdsNote: kdsNoteOf(row.meta),
  };
}

/** A production centre's name: the pushed routing in the store first, then the cached copy. */
function stationLabel(id) {
  const fromStore = useStore.getState().printRouting?.centres?.find(c => c.id === id)?.name;
  if (fromStore) return fromStore;
  const r = readJson('rpos-print-routing');
  return r?.centres?.find(c => c.id === id)?.name || null;
}

export function KDSSurface() {
  const storeTickets = useStore(s => s.kdsTickets);
  const bumpTicket = useStore(s => s.bumpTicket);
  const showToast = useStore(s => s.showToast);
  const storeTz = useStore(s => s.locationConfig?.timezone);

  // Device identity, read once. A KDS is paired, so these do not change under it.
  const [device] = useState(() => {
    const paired = readJson('rpos-device');
    const cfg = readJson('rpos-device-config');
    return {
      id: paired?.id || null,
      name: paired?.name || cfg?.profileName || 'Kitchen display',
      locationId: paired?.locationId || null,
      centreId: cfg?.centreId || paired?.centreId || null,
      centreName: cfg?.centreName || null,
    };
  });
  const { locationId } = device;
  const live = !isMock && !!locationId;

  // v5.9.73: the CENTRE comes from this screen's own devices row, not only from the pairing
  // record. Back Office binds a screen to a centre in Print routing, usually AFTER pairing, and
  // the pairing record never learned it: both Leeds screens (26 Sep 2026) showed every
  // station's tickets. Read on boot, follow the row live, remember it for the next boot.
  const [centreId, setCentreId] = useState(device.centreId);
  useEffect(() => {
    if (!live || !device.id || !supabase) return undefined;
    let alive = true;
    const apply = (row) => {
      if (!alive || !row || !('centre_id' in row)) return;
      const id = row.centre_id || null;
      setCentreId(id);
      try {
        const cfg = readJson('rpos-device-config') || {};
        localStorage.setItem('rpos-device-config', JSON.stringify({ ...cfg, centreId: id }));
      } catch { /* the next boot reads the row again */ }
    };
    Promise.resolve(supabase.from('devices').select('centre_id').eq('id', device.id).maybeSingle())
      .then(({ data, error }) => { if (!error && data) apply(data); })
      .catch(() => { /* keep the paired value */ });
    const ch = supabase.channel(`kds-device-${device.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'devices', filter: `id=eq.${device.id}` }, (payload) => apply(payload.new))
      .subscribe();
    return () => { alive = false; supabase.removeChannel(ch); };
  }, [live, device.id]);

  // ── settings (per screen) ───────────────────────────────────────────────────
  const storageKey = kdsSettingsStorageKey(device.id);
  const [settings, setSettings] = useState(() => normaliseKdsSettings(readJson(storageKey)));
  const settingsRef = useRef(settings);   // v5.9.95: the tick handler reads the live setting
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const [settingsDb, setSettingsDb] = useState(() => (live && device.id ? 'loading' : 'local'));   // 'loading' | 'ok' | 'missing' | 'local'
  const saveTimer = useRef(null);
  const changedHere = useRef(false);     // a manager changed something since this screen opened
  // "unsynced" = the tablet holds settings the database has not accepted yet (a failed
  // save, or saved before the column existed). While it is set the tablet copy wins and
  // is pushed up; otherwise the database copy wins.
  const unsyncedKey = `${storageKey}-unsynced`;
  const pushSettings = useCallback(async (s) => {
    const { error } = await supabase.from('devices').update({ kds_settings: s }).eq('id', device.id);
    if (!error) {
      try { localStorage.removeItem(unsyncedKey); } catch { /* storage blocked */ }
      setSettingsDb('ok');
      return 'ok';
    }
    if (isMissingColumnError(error, 'kds_settings')) { setSettingsDb('missing'); return 'missing'; }
    return 'failed';
  }, [device.id, unsyncedKey]);

  useEffect(() => {
    if (!live || !device.id) return undefined;
    let alive = true;
    (async () => {
      const { data, error } = await supabase.from('devices').select('kds_settings').eq('id', device.id).maybeSingle();
      if (!alive) return;
      if (error) { setSettingsDb(isMissingColumnError(error, 'kds_settings') ? 'missing' : 'local'); return; }
      setSettingsDb('ok');
      const local = readJson(storageKey);
      const unsynced = (() => { try { return localStorage.getItem(unsyncedKey) === '1'; } catch { return false; } })();
      // A change made on this screen, or one the database never accepted, is newer: keep it
      // and send it up. Only a clean tablet takes the database copy.
      if (changedHere.current) return;
      if (local && (unsynced || !data?.kds_settings)) {
        await pushSettings(normaliseKdsSettings(local));
      } else if (data?.kds_settings) {
        const s = normaliseKdsSettings(data.kds_settings);
        setSettings(s);
        try { localStorage.setItem(storageKey, JSON.stringify(s)); } catch { /* storage full */ }
      }
    })();
    return () => { alive = false; };
  }, [live, device.id, storageKey, unsyncedKey, pushSettings]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const changeSettings = useCallback((next) => {
    const s = normaliseKdsSettings(next);
    changedHere.current = true;
    setSettings(s);
    try {
      localStorage.setItem(storageKey, JSON.stringify(s));
      localStorage.setItem(unsyncedKey, '1');
    } catch { /* storage full */ }
    if (!live || !device.id) return;
    // Stepper taps come in bursts: write once they stop.
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      // 'missing' (migration not run) is explained inside the settings sheet instead.
      if (await pushSettings(s) === 'failed') {
        useStore.getState().showToast?.('Settings did not save to the database. They are kept on this screen and sent again next time.', 'warning');
      }
    }, 600);
  }, [live, device.id, storageKey, unsyncedKey, pushSettings]);

  // ── venue time ──────────────────────────────────────────────────────────────
  const [venueCfg, setVenueCfg] = useState(null);
  useEffect(() => {
    let alive = true;
    getLocationConfig(locationId).then(c => { if (alive) setVenueCfg(c); }).catch(() => {});
    return () => { alive = false; };
  }, [locationId]);
  const tz = storeTz || venueCfg?.timezone || 'Europe/London';
  const clockFmt = useMemo(() => {
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }); }
    catch { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }); }
  }, [tz]);
  const dayStartIso = useCallback(() => {
    try { return venueBusinessDayStart(Date.now(), tz, venueCfg?.businessDayStart || '06:00').toISOString(); }
    catch { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
  }, [venueCfg, tz]);

  // ── venue: the last bump marks the order ready / collected (30 Sep 2026) ────
  // Two switches in locations.pos_settings (Back Office, Order screens). Read on boot and once a
  // minute (Back Office promises "within a minute"); the rule is lib/kds/kdsAutoStatus.js.
  const [autoStatus, setAutoStatus] = useState(() => autoStatusSettings(null));
  const autoStatusRef = useRef(autoStatus);
  useEffect(() => { autoStatusRef.current = autoStatus; }, [autoStatus]);
  useEffect(() => {
    if (!live || !supabase) return undefined;
    let alive = true;
    const read = async () => {
      try {
        const { data, error } = await withTimeout(
          supabase.from('locations').select('pos_settings').eq('id', locationId).maybeSingle(), LOAD_TIMEOUT_MS, 'Venue settings');
        // Only a successful read of the row may change it; offline keeps the last value.
        if (alive && !error && data) setAutoStatus(autoStatusSettings(data.pos_settings));
      } catch { /* keep the last value */ }
    };
    read();
    const id = setInterval(read, AUTO_STATUS_SETTINGS_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [live, locationId]);

  // Card text scale from the column width (Peter: keep today's columns, shrink the text).
  // One observer on whichever grid is showing; the value is rounded so cards re-render
  // only when the column width really changes.
  const [scale, setScale] = useState(1);
  const gridObserver = useRef(null);
  // 12 Oct 2026, Barnsley (K5): with nine or more cards the newest tickets sat below the fold with
  // nothing to say so (the test tickets staff sent were cards 10 to 13). The board counts the cards
  // that start below the visible area and says how many.
  const gridEl = useRef(null);
  const scrollRef = useRef(null);
  const [below, setBelow] = useState(0);
  const measureBelow = useCallback(() => {
    const box = scrollRef.current;
    const grid = gridEl.current;
    if (!box || !grid) { setBelow(b => (b === 0 ? b : 0)); return; }
    const bottom = box.getBoundingClientRect().bottom;
    const tops = Array.prototype.map.call(grid.children, (el) => el.getBoundingClientRect().top);
    const n = countBelow(tops, bottom);
    setBelow(b => (b === n ? b : n));
  }, []);
  const gridRef = useCallback((el) => {
    gridObserver.current?.disconnect();
    gridObserver.current = null;
    gridEl.current = el || null;
    if (!el) return;
    const apply = () => { setScale(cardScale(gridColumnWidth(el.clientWidth))); measureBelow(); };
    apply();
    if (typeof ResizeObserver !== 'undefined') {
      gridObserver.current = new ResizeObserver(apply);
      gridObserver.current.observe(el);
    }
  }, [measureBelow]);
  useEffect(() => () => gridObserver.current?.disconnect(), []);

  // One tick a second for the clock and the timers (cards are memoised on their minutes).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── heartbeat (Status drawer shows the KDS online) ──────────────────────────
  useEffect(() => {
    if (!device.id || isMock) return;
    // Database fence stage 1 (contract A10): device_heartbeat (with the old direct write as
    // the FENCE STAGE 1 FALLBACK inside updateDeviceHeartbeat while the function is missing).
    const beat = () => { updateDeviceHeartbeat(device.id).catch?.(() => {}); };
    beat();
    const id = setInterval(beat, 60000);
    return () => clearInterval(id);
  }, [device.id]);

  // ── tickets ─────────────────────────────────────────────────────────────────
  // live: rows from Supabase. Not live (mock / unpaired): the store's tickets, with the
  // board's own holds, ticks and bumps laid over them.
  // 12 Oct 2026, Barnsley: what the board paints and says now comes from the board engine
  // (lib/kds/kdsBoardEngine.js): the database's rows with this screen's unsaved changes on top,
  // how the link is doing, and how many changes are not saved yet.
  const engineRef = useRef(null);
  const [board, setBoard] = useState(EMPTY_BOARD);
  const [sel, setSel] = useState(null);                       // open pop out: { id, mode }
  const [localPatch, setLocalPatch] = useState({});          // not live only: id → partial row
  const [lastBumpedToday, setLastBumpedToday] = useState(false);

  // 12 Oct 2026: this read ran after EVERY list read with no time limit, so on the stalled link 14
  // of them left in one burst. One at a time now, cancelled after 15 s, and only a good answer
  // changes the Recall last button (a failed read used to hide it).
  const lastBumpedBusy = useRef(false);
  const loadLastBumped = useCallback(async () => {
    if (!live || lastBumpedBusy.current) return;
    lastBumpedBusy.current = true;
    try {
      let q = kitchenDb().from('kds_tickets').select('id').eq('location_id', locationId).eq('status', 'bumped')
        .gte('bumped_at', dayStartIso()).order('bumped_at', { ascending: false }).limit(1);
      if (centreId) q = q.eq('centre_id', centreId);
      const { data, error } = await limitedRead(q, LOAD_TIMEOUT_MS, 'Last bumped');
      if (!error) setLastBumpedToday(!!data?.length);
    } catch { /* keep the last answer */ }
    finally { lastBumpedBusy.current = false; }
  }, [live, locationId, centreId, dayStartIso]);
  const loadLastBumpedRef = useRef(loadLastBumped);
  useEffect(() => { loadLastBumpedRef.current = loadLastBumped; }, [loadLastBumped]);

  // v5.9.96 (item untick): this screen's item ticks that the database has not shown back yet, by
  // ticket id: { touched, items, sent, settledBy, chain }. Saves for one ticket run one after another
  // and each is built when it starts, so the database always ends on the last tap. Incoming rows keep these
  // ticks on top until they match (lib/kds/kdsItemTicks.js).
  const localTicks = useRef(new Map());
  const withLocalTicks = useCallback((row) => {
    const pending = localTicks.current.get(row.id);
    if (!pending) return row;
    const { row: out, settled } = mergeIncomingTicks(row, pending, Date.now());
    if (settled && localTicks.current.get(row.id) === pending) localTicks.current.delete(row.id);
    return out;
  }, []);
  const withLocalTicksRef = useRef(withLocalTicks);
  // Filled further down (they are declared after the engine effect).
  const scheduleAutoStatusRef = useRef(() => {});
  const writeFailedRef = useRef(() => {});
  // Ticket ids whose restore came from Undo: no "Ticket recalled" message when it is saved (Undo never had one).
  const quietRestores = useRef(new Set());

  // ── the board engine (12 Oct 2026, Barnsley) ─────────────────────────────────
  // The list reads, the live changes and every status write of this screen run through
  // lib/kds/kdsBoardEngine.js. What that fixes, each one reproduced on the build of 12 Oct:
  //   K1  a bumped ticket is never painted back while its bump is unsaved (the 20 s list read and
  //       the echo of an item tick both did that: "recalling items without us touching anything")
  //   K2  every write has a time limit, is sent again with the same body, and is counted on screen
  //   K3  writes of one ticket go one after another: a late Hold can never land after a Bump
  //   K4  every list answer is used, late or not, and a failed read is asked again in 5 s
  //   K5  the banner says slow or offline, and only a list read that was USED can clear it
  // `alive` goes false on cleanup: an engine still running for the old station (the screen was
  // re pointed in settings) must not paint over the new station's board.
  useEffect(() => {
    if (!live) return undefined;
    let alive = true;
    let eng = null;
    // K9: one trace per spell. A write that did not land is tried again a minute later, five times
    // at most. Every try carries the SAME id (review 12 Oct 2026: the insert had none, so one that
    // landed with its answer lost was written again, up to five rows for one spell). A second
    // insert of that id is refused by the database and counts as written (lib/activity.js).
    const writeTrace = (summary, triesLeft, id = traceId()) => {
      const w = traceWords({ name: device.name, summary });
      Promise.resolve(logActivity(locationId, {
        id, kind: 'system', severity: 'info', title: w.title, body: w.body, refType: 'kds_link', refId: device.id, actorName: device.name,
      })).then((r) => {
        if (alive && r && r.ok === false && triesLeft > 1) setTimeout(() => writeTrace(summary, triesLeft - 1, id), 60000);
      }).catch(() => {});
    };
    eng = createBoardEngine({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
      makeAbort: typeof AbortController === 'function'
        ? () => { const c = new AbortController(); return { signal: c.signal, abort: () => c.abort() }; }
        : null,
      readList: async ({ signal }) => {
        let q = kitchenDb().from('kds_tickets').select('*').eq('location_id', locationId).in('status', ['pending', 'held']).order('sent_at', { ascending: true });
        if (centreId) q = q.eq('centre_id', centreId);
        if (signal && typeof q.abortSignal === 'function') q = q.abortSignal(signal);
        // The engine asks again itself. The client's own repeats of a failed read (three more) are
        // switched off: on 12 Oct they helped put 14 list reads into one two second burst.
        if (typeof q.retry === 'function') q = q.retry(false);
        const { data, error, status } = await q;
        // status 0 = the request never completed (the tablet's network). Any other status with an
        // error is ServOS itself answering (a database restart, a 503): the banner then does not
        // tell staff to check the WiFi (review 12 Oct 2026).
        if (error) return { error, server: Number(status) >= 400 };
        // Database fence stage 1 (contract A9): an empty read while this screen may have lost
        // its link is unknown, never "no tickets". Keep what is on screen (the engine does not
        // use an answer of undefined, and it clears no warning).
        if (data && !trustSharedRead({ linkUncertain: isDeviceLinkUncertain(), rowCount: data.length })) return;
        return { data: data || [] };
      },
      writeTicket: ticketWrite,
      mapRow: (r) => withLocalTicksRef.current(mapRow(r)),
      centreId,
      journal: {
        load: () => { try { return localStorage.getItem(unsavedKey(device.id)); } catch { return null; } },
        save: (text) => { try { localStorage.setItem(unsavedKey(device.id), text); } catch { /* storage full: the bump is still sent from memory */ } },
      },
      onChange: () => { if (alive && eng) setBoard(eng.view()); },
      onApplied: () => { if (alive) loadLastBumpedRef.current().catch?.(() => {}); },
      // The auto ready step runs from the moment the bump is in the database, as before.
      onBumpSaved: (row) => { if (alive && row) scheduleAutoStatusRef.current(row); },
      onSaved: (entry) => {
        if (!alive || entry.kind !== 'restore') return;
        // Recall last and History say "Ticket recalled" once the database has it. Undo says nothing, as before.
        if (!quietRestores.current.delete(entry.id)) useStore.getState().showToast?.('Ticket recalled', 'success');
        loadLastBumpedRef.current().catch?.(() => {});
      },
      // A bump that passed ten minutes unsaved comes back on its card ("Bump not saved"). Anything else says so here.
      onGaveUp: (entry) => { if (alive && entry.kind !== 'bump') writeFailedRef.current(GAVE_UP_WORD[entry.kind] || 'Change'); },
      onBumpedLive: () => { if (alive) setLastBumpedToday(true); },
      onSpell: (summary) => { writeTrace(summary, 5); },
    });
    engineRef.current = eng;
    eng.start();
    setBoard(eng.view());

    // The live channel. A new name on every join: the client hands back the OLD channel object for
    // a name it still holds, and a closed one cannot be subscribed again.
    let channel = null;
    let joins = 0;
    let subscribedOnce = false;
    let notJoinedSince = 0;
    const join = () => {
      joins += 1;
      channel = supabase
        .channel(`kds-tickets-${locationId}${centreId ? `-${centreId}` : ''}-${joins}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'kds_tickets', filter: `location_id=eq.${locationId}` }, (payload) => {
          // 12 Oct 2026 (main, liveRow): a live change that carries an error has no record (new = {}),
          // and the server sends it to every screen on the table. Skipped; the list read decides.
          if (!liveRow(payload)) return;
          if (alive) eng.liveInsert(payload.new);
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'kds_tickets', filter: `location_id=eq.${locationId}` }, (payload) => {
          if (!liveRow(payload)) return;
          if (alive) eng.liveUpdate(payload.new);
        })
        .subscribe((status) => {
          // 30 Sep 2026: a channel that rejoins after a drop missed every change while it was down.
          // The first SUBSCRIBED is the boot (the engine is already reading); every later one is a
          // reconnect and reads the list again.
          if (status !== 'SUBSCRIBED') return;
          notJoinedSince = 0;
          if (subscribedOnce) eng.load();
          subscribedOnce = true;
        });
    };
    join();
    // K8: a channel the server closed is final for the client library; nothing joins it again.
    const channelCheck = setInterval(() => {
      if (!channel || channel.state === 'joined') { notJoinedSince = 0; return; }
      // While the socket itself is down the library reconnects it and rejoins by itself: the
      // 60 seconds only count while the socket is connected and this channel still is not joined.
      if (typeof supabase.realtime?.isConnected === 'function' && !supabase.realtime.isConnected()) { notJoinedSince = 0; return; }
      if (!notJoinedSince) { notJoinedSince = Date.now(); return; }
      if (Date.now() - notJoinedSince < REJOIN_AFTER_MS) return;
      notJoinedSince = 0;
      // The new channel first, then the old one goes: removing the last channel the client holds
      // would close the socket itself, only for the new join to open it again.
      const old = channel;
      join();
      try { supabase.removeChannel(old); } catch { /* already gone */ }
    }, CHANNEL_CHECK_MS);

    // v5.7.39 self heal: push is the fast path, never the only path. (The 20 s poll is the engine's.)
    const reload = () => { eng.load(); };
    const onVisible = () => { if (document.visibilityState === 'visible') eng.load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', reload);
    return () => {
      alive = false;
      eng.stop();
      if (engineRef.current === eng) engineRef.current = null;
      clearInterval(channelCheck);
      try { supabase.removeChannel(channel); } catch { /* already gone */ }
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', reload);
    };
  }, [live, locationId, centreId, device.id, device.name]);

  // A ticket that left the board (bumped here or on another screen) closes its pop out.
  useEffect(() => {
    if (!live) return;
    setSel(s => (s && s.mode === 'live' && !board.rows.some(r => r.id === s.id) ? null : s));
  }, [live, board.rows]);

  const tickets = useMemo(() => {
    if (live) return board.rows;
    return (storeTickets || []).map(mapRow)
      .map(t => (localPatch[t.id] ? { ...t, ...localPatch[t.id] } : t))
      .filter(t => t.status !== 'bumped');
  }, [live, board.rows, storeTickets, localPatch]);
  const ticketsRef = useRef(tickets);
  useEffect(() => { ticketsRef.current = tickets; }, [tickets]);

  // Legacy kiosk / online / HubRise / catering tickets carry no order type: ask
  // order_queue once per ref. `null` marks a ref that was asked and not found.
  const [queueRows, setQueueRows] = useState({});
  const askedRefs = useRef(new Set());
  useEffect(() => {
    if (!live) return;
    const refs = [...new Set(tickets.map(t => t.meta).filter(needsTypeLookup).map(m => m.orderRef))]
      .filter(r => !askedRefs.current.has(r));
    if (!refs.length) return;
    refs.forEach(r => askedRefs.current.add(r));
    (async () => {
      const { data, error } = await supabase.from('order_queue').select('ref, type, customer').eq('location_id', locationId).in('ref', refs);
      if (error) { refs.forEach(r => askedRefs.current.delete(r)); return; }
      setQueueRows(prev => {
        const next = { ...prev };
        refs.forEach(r => { next[r] = null; });
        (data || []).forEach(q => { next[q.ref] = q; });
        return next;
      });
    })();
  }, [live, locationId, tickets]);

  const views = useMemo(
    () => tickets.map(t => ticketView(t, needsTypeLookup(t.meta) ? queueRows[t.meta.orderRef] : null)),
    [tickets, queueRows],
  );

  // ── filters ─────────────────────────────────────────────────────────────────
  const [stationFilter, setStationFilter] = useState(centreId || 'all');
  useEffect(() => { setStationFilter(centreId || 'all'); }, [centreId]);   // v5.9.73: follow the centre
  // 30 Sep 2026: the type filter is plain state, never saved, and it snaps back to All three
  // minutes after the last pill tap (the 1 s clock below drives that) or the moment a ticket it
  // would hide arrives (the effect after `tickets`). See lib/kds/kdsTypeFilter.js.
  const [typeFilter, setTypeFilter] = useState('all');
  const typeFilterRef = useRef(typeFilter);
  useEffect(() => { typeFilterRef.current = typeFilter; }, [typeFilter]);
  const filterTapAt = useRef(0);
  const tapTypeFilter = useCallback((key) => { filterTapAt.current = Date.now(); setTypeFilter(key); }, []);
  useEffect(() => {
    setTypeFilter(f => filterAfterIdle({ filter: f, tappedAt: filterTapAt.current, now }));
  }, [now]);
  const knownIds = useRef(null);   // null until the first list has painted: the boot load is not an arrival
  useEffect(() => {
    const ids = new Set(tickets.map(t => t.id));
    const before = knownIds.current;
    knownIds.current = ids;
    if (!before) return;
    const arrived = tickets.filter(t => !before.has(t.id));
    if (!arrived.length) return;
    const { snapped } = filterAfterArrival({ filter: typeFilterRef.current, typeKeys: arrived.map(t => kdsTypeKey(t.meta)) });
    if (snapped) {
      filterTapAt.current = 0;
      setTypeFilter('all');
      playOrderChime();   // the new order chime: the board just changed under the kitchen's eyes
    }
  }, [tickets]);
  // Station buttons only when this board really holds tickets from two or more stations.
  // (The old board also showed "All stations" plus the one station on a screen tied to it.)
  const stations = useMemo(() => {
    const ids = [...new Set(views.map(t => t.centreId || 'pc1'))];
    return ids.length > 1 ? ['all', ...ids] : [];
  }, [views]);
  // With the buttons hidden (one station left) a stale pick must not hide the board.
  const activeStation = stations.length ? stationFilter : 'all';
  const inStation = useMemo(
    () => views.filter(t => activeStation === 'all' || (t.centreId || 'pc1') === activeStation),
    [views, activeStation],
  );
  const activeType = settings.show.counts ? typeFilter : 'all';
  const displayed = useMemo(
    () => sortTickets(inStation.filter(t => activeType === 'all' || t.typeKey === activeType), { heldToEnd: settings.show.heldToEnd }),
    [inStation, activeType, settings.show.heldToEnd],
  );
  const counts = useMemo(() => typeCounts(inStation, activeType), [inStation, activeType]);
  const filterNote = filterBanner(activeType, hiddenCount(inStation, activeType));
  const rail = useMemo(() => rollUp(displayed), [displayed]);
  const railTotal = rail.reduce((n, r) => n + r.qty, 0);

  // ── actions ─────────────────────────────────────────────────────────────────
  const [undo, setUndo] = useState(null);                     // { id, prevStatus, headline, row }

  const patchRow = useCallback((id, patch) => {
    if (live) engineRef.current?.patchRow(id, patch);
    else setLocalPatch(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }, [live]);

  const writeFailed = useCallback((what) => {
    useStore.getState().showToast?.(`${what} did not save. Check the connection, the board will catch up.`, 'error');
  }, []);
  useEffect(() => { writeFailedRef.current = writeFailed; }, [writeFailed]);

  // ── the last bump marks the order ready / collected (30 Sep 2026) ───────────
  // Runs UNDO_MS after this screen's bump landed, so an Undo (the ticket comes back) never leaves
  // the order marked ready. Then, only when EVERY kds_tickets row of the order is bumped, the
  // venue's steps run as conditional order_queue writes (lib/kds/kdsAutoStatus.js): the same
  // status write a tap on Orders Hub makes, so the ready message, the order screens and HubRise
  // behave exactly as for a manual tap. Two screens racing: the second changes 0 rows.
  //
  // One pending timer per ticket id (review 30 Sep 2026: a set of "undone" ids was never cleared,
  // so one Undo silenced every later bump of that ticket). Undo clears the ticket's timer; a new
  // bump of the same ticket replaces it and is judged afresh.
  const autoStatusTimers = useRef(new Map());
  useEffect(() => () => autoStatusTimers.current.forEach(clearTimeout), []);
  const cancelAutoStatus = useCallback((id) => {
    const timer = autoStatusTimers.current.get(id);
    if (timer) { clearTimeout(timer); autoStatusTimers.current.delete(id); }
  }, []);
  // Said once per boot: tills on a build before 30 Sep 2026 stamp no ref, so their orders cannot
  // be found in order_queue and never mark ready by themselves (Sunmi WebViews keep old bundles
  // for days). Without this the switch simply looks broken.
  const warnedNoRef = useRef(false);
  const scheduleAutoStatus = useCallback((t) => {
    if (!live || !autoStatusRef.current.ready) return;
    const key = orderKeyOf(t);
    if (key?.kind !== 'ref') {   // a table or bar tab send has no order_queue row
      if (!warnedNoRef.current && bumpedWithoutRef(t.meta)) {
        warnedNoRef.current = true;
        console.warn('[KDS] auto ready skipped: ticket has no meta.ref (till on an older build)', { id: t.id, channel: t.meta?.channel, orderNo: t.meta?.orderNo });
        useStore.getState().showToast?.('This order came from a till on an older version, so it will not mark ready by itself. Restart the tills to update them.', 'warning');
      }
      return;
    }
    cancelAutoStatus(t.id);
    const timer = setTimeout(async () => {
      autoStatusTimers.current.delete(t.id);
      const settings = autoStatusRef.current;
      if (!settings.ready) return;
      try {
        const [tk, oq] = await Promise.all([
          withTimeout(supabase.from('kds_tickets').select('id, status').eq('location_id', locationId).eq('meta->>ref', key.ref), LOAD_TIMEOUT_MS, 'Kitchen rows'),
          withTimeout(supabase.from('order_queue').select('ref, status, source, paid, customer').eq('location_id', locationId).eq('ref', key.ref).maybeSingle(), LOAD_TIMEOUT_MS, 'Order'),
        ]);
        if (tk.error || oq.error) return;   // unknown: staff, or the next bump, move it on
        const decision = autoStatusAfterBump({ ticketRows: tk.data || [], settings, order: oq.data || null });
        for (const step of autoStatusSteps(decision, oq.data?.status)) {
          // parkable false: a derived write. Replayed minutes later it could only be stale.
          // 12 Oct 2026 (K2): this write had no time limit either. It is cancelled after 15 s and
          // not sent again: sent late it could only be stale, and the order is still on Orders Hub.
          const ctl = typeof AbortController === 'function' ? new AbortController() : null;
          const r = await withTimeout(mustChangeRow({
            table: 'order_queue', type: 'update', payload: { status: step.to },
            match: { location_id: locationId, ref: key.ref }, inList: { column: 'status', values: step.from },
            parkable: false, kind: 'kds_auto_status', label: `Order ${key.ref} ${step.to} from the kitchen`,
            signal: ctl ? ctl.signal : undefined,
          }), LOAD_TIMEOUT_MS, 'Order status').catch((e) => { try { ctl?.abort(); } catch { /* already ended */ } throw e; });
          if (r.outcome !== 'applied') return;   // another screen got there first, or the order moved on
          // Channel orders mirror each step to HubRise, as Orders Hub does.
          if (oq.data?.source === 'hubrise') hubrisePushStatus(locationId, key.ref, step.to).catch(() => {});
        }
      } catch { /* best effort: the order is still on Orders Hub for staff */ }
    }, UNDO_MS);
    autoStatusTimers.current.set(t.id, timer);
  }, [live, locationId, cancelAutoStatus]);
  useEffect(() => { scheduleAutoStatusRef.current = scheduleAutoStatus; }, [scheduleAutoStatus]);

  // 12 Oct 2026, Barnsley: a bump, a hold, a resume and a recall are no longer written from here.
  // They are handed to the board engine, which hides or changes the card at once, sends the write
  // with a time limit, sends it again with the same body until the database answers, keeps the
  // writes of one ticket in tap order, and brings a bump that truly failed back on its card
  // ("Bump not saved. Tap to try again."). The auto ready step runs when the engine says the bump
  // is in the database (onBumpSaved above).
  const bump = useCallback((id) => {
    const t = ticketsRef.current.find(x => x.id === id);
    if (!t) return;
    setSel(s => (s?.id === id ? null : s));
    setUndo({ id, prevStatus: t.held ? 'held' : 'pending', headline: ticketView(t).headline, at: Date.now(), row: t });
    if (live) {
      const eng = engineRef.current;
      if (!eng) return;
      setLastBumpedToday(true);
      // A card that says "Bump not saved": the SAME bump goes again (same body, same bumped_at).
      if (t.unsaved === 'bump') eng.retryBump(id);
      else eng.bump(t);
    } else {
      patchRow(id, { status: 'bumped' });
      if (!isMock) bumpTicket(id);
    }
  }, [live, patchRow, bumpTicket]);

  const hold = useCallback((id) => {
    showToast('Ticket held', 'info');
    if (live) engineRef.current?.hold(id);
    else patchRow(id, { status: 'held', held: true });
  }, [live, patchRow, showToast]);

  // Resume keeps counting from when the order was first sent (Peter): sent_at is untouched.
  const resume = useCallback((id) => {
    showToast('Ticket back in queue', 'success');
    if (live) engineRef.current?.resume(id);
    else patchRow(id, { status: 'pending', held: false });
  }, [live, patchRow, showToast]);

  // v5.9.96 (Peter, 27 Sep 2026: "you can't untick an item if you click by accident"): a tap
  // ticks an item, a tap on a ticked item unticks it. Unticking never bumps.
  const bumpItem = useCallback((id, index) => {
    const t = ticketsRef.current.find(x => x.id === id);
    if (!t) return;
    const next = toggleTick(t.items, index);
    if (!next) return;
    const { items, ticked } = next;
    // v5.9.95: ticking the last item leaves the ticket up until someone presses Bump, unless this
    // screen switched "Bump when every item is ticked" on (voided lines do not count).
    if (ticked && shouldBumpAfterTick(items, settingsRef.current)) { bump(id); return; }
    ticketsRef.current = ticketsRef.current.map(x => (x.id === id ? { ...x, items } : x));
    patchRow(id, { items });
    if (!live) return;
    const prev = localTicks.current.get(id);
    const now = Date.now();
    const entry = {
      touched: touchedTicks(prev, index, items, now), items,
      sent: ticksActive(prev, now) ? [...(prev.sent || [])] : [], settledBy: null, chain: null,
    };
    localTicks.current.set(id, entry);
    entry.chain = (prev?.chain || Promise.resolve()).then(async () => {
      // Only the newest tap for this ticket saves; an older one that waited here has nothing to do.
      if (localTicks.current.get(id) !== entry) return;
      // Built now, not at tap time (review round): lines this screen did not touch come from the
      // newest copy on screen, so a tick another screen made while this save waited is kept.
      const cur = ticketsRef.current.find(x => x.id === id);
      const payload = cur ? overlayTicks(cur.items, entry.touched) : entry.items;
      entry.sent.push(tickFlags(payload));
      // 12 Oct 2026 (K2): a time limit on every send, the same payload up to three times, and the
      // save is counted in the header while it runs. A newer tap for this ticket stops the repeats.
      const send = (signal) => ticketWrite(id, { items: payload }, ticked ? 'Kitchen item ticked' : 'Kitchen item unticked', signal);
      const eng = engineRef.current;
      const { error } = eng
        ? await eng.limitedWrite(`tick:${id}`, send, { tries: 3, stillWanted: () => localTicks.current.get(id) === entry })
        : await send();
      if (error) writeFailed(ticked ? 'Item tick' : 'Item untick');
      if (localTicks.current.get(id) === entry) entry.settledBy = Date.now() + LOCAL_TICKS_GRACE_MS;
    }).catch(() => {});
  }, [live, patchRow, bump, writeFailed]);

  /** Bring a bumped ticket back. Recall keeps counting from first sent (Peter). */
  // 12 Oct 2026: the card is back at the tap and the write follows through the engine, behind
  // any write of this ticket still on its way (an Undo can never be overtaken by its own bump).
  // "Ticket recalled" is said when the database has it (onSaved above).
  const restore = useCallback((row, status = 'pending') => {
    if (!row) return false;
    if (live) {
      const eng = engineRef.current;
      if (!eng) return false;
      quietRestores.current.delete(row.id);   // doUndo marks its own restore quiet again, after this
      eng.restore(row, status);
    } else {
      patchRow(row.id, { status, held: status === 'held' });
    }
    return true;
  }, [live, patchRow]);

  // ── note for the kitchen (30 Sep 2026) ──────────────────────────────────────
  // Saved into meta.kdsNote on EVERY live row of the order at this venue (the food and the drinks
  // screen each hold one), read fresh so a newer meta is never overwritten. Never leaves kds_tickets.
  const [noteSaving, setNoteSaving] = useState(false);
  const saveKitchenNote = useCallback(async (id, text) => {
    const t = ticketsRef.current.find(x => x.id === id);
    if (!t) return false;
    const note = cleanKdsNote(text);
    if (!live) {
      rowsOfSameOrder(t, ticketsRef.current).forEach(r => patchRow(r.id, { kdsNote: note, rawMeta: metaWithKdsNote(r.rawMeta, note) }));
      return true;
    }
    setNoteSaving(true);
    try {
      const key = orderKeyOf(t);
      let q = kitchenDb().from('kds_tickets').select('id, table_label, sent_at, meta').eq('location_id', locationId).in('status', ['pending', 'held']);
      if (key?.kind === 'ref') q = q.eq('meta->>ref', key.ref);
      else if (key?.kind === 'send') {
        q = q.eq('table_label', key.tableLabel)
          .gte('sent_at', new Date(key.sentAt - SAME_SEND_WINDOW_MS).toISOString())
          .lte('sent_at', new Date(key.sentAt + SAME_SEND_WINDOW_MS).toISOString());
      } else q = q.eq('id', id);
      const { data, error } = await withTimeout(q, LOAD_TIMEOUT_MS, 'Kitchen note');
      if (error) throw error;
      const targets = rowsOfSameOrder(t, (data || []).map(mapRow));
      let failed = false;
      for (const r of targets) {
        const meta = metaWithKdsNote(r.rawMeta, note);
        // 12 Oct 2026 (K2): one send with a time limit. The editor is open and says when it did not save.
        const send = (signal) => ticketWrite(r.id, { meta }, note ? 'Kitchen note saved' : 'Kitchen note cleared', signal);
        const eng = engineRef.current;
        const { error: e } = eng ? await eng.limitedWrite(`note:${r.id}`, send) : await send();
        if (e) failed = true;
        else patchRow(r.id, { kdsNote: note, rawMeta: meta });
      }
      if (failed) { writeFailed('Note'); return false; }
      showToast(note ? 'Note saved. Every kitchen screen with this order shows it.' : 'Note cleared', 'success');
      return true;
    } catch {
      writeFailed('Note');
      return false;
    } finally { setNoteSaving(false); }
  }, [live, locationId, patchRow, writeFailed, showToast]);

  // Undo: the last bump, for 5 seconds. A bump changes only this row (no trigger and no
  // listener moves the order on), so putting the row back undoes it completely.
  const undoRef = useRef(undo);
  useEffect(() => { undoRef.current = undo; }, [undo]);
  useEffect(() => {
    if (!undo) return undefined;
    const t = setTimeout(() => setUndo(u => (u && u.at === undo.at ? null : u)), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);
  const doUndo = useCallback(() => {
    const u = undoRef.current;
    if (!u) return;
    setUndo(null);
    cancelAutoStatus(u.id);   // the auto ready / collected timer for this bump stands down
    if (live) {
      // 12 Oct 2026: Undo used to wait for the bump write with no limit, then read the row back.
      // The card goes back now with the ticket as it was at the bump, and the engine sends the
      // restore only once the bump's own send has ended, so the row always ends as shown.
      if (restore(u.row, u.prevStatus)) quietRestores.current.add(u.id);
    } else {
      patchRow(u.id, { status: u.prevStatus, held: u.prevStatus === 'held' });
    }
  }, [live, restore, patchRow, cancelAutoStatus]);

  // Recall last: the last ticket bumped at this station today, from any screen.
  const recallBusy = useRef(false);
  const recallLast = useCallback(async () => {
    if (!live) {
      const bumped = (storeTickets || []).map(mapRow).filter(t => localPatch[t.id]?.status === 'bumped');
      const last = bumped[bumped.length - 1];
      if (last) { patchRow(last.id, { status: 'pending', held: false }); showToast('Ticket recalled', 'success'); }
      return;
    }
    // 12 Oct 2026 (K1): a bump this screen has not saved yet is not in the database as bumped, so
    // the read below cannot find it and would bring back an OLDER ticket instead. The newest unsaved
    // bump of this screen IS the last ticket bumped here: its card comes back at once, with no read.
    // (On a healthy link a bump is saved in a tenth of a second, long before this button is back.)
    const mine = engineRef.current?.lastUnsavedBump();
    if (mine) {
      if (restore(mine) && undoRef.current?.id === mine.id) setUndo(null);
      return;
    }
    // 12 Oct 2026: on the slow link two impatient taps read "the last bumped" twice and recalled
    // two different tickets. One recall at a time, and the read is cancelled after 15 s.
    if (recallBusy.current) return;
    recallBusy.current = true;
    try {
      let q = kitchenDb().from('kds_tickets').select('*').eq('location_id', locationId).eq('status', 'bumped')
        .gte('bumped_at', dayStartIso()).order('bumped_at', { ascending: false }).limit(1);
      if (centreId) q = q.eq('centre_id', centreId);
      const { data, error } = await limitedRead(q, LOAD_TIMEOUT_MS, 'Recall last');
      if (error) { writeFailed('Recall'); return; }
      if (!data?.length) { setLastBumpedToday(false); showToast('Nothing bumped today to recall', 'info'); return; }
      if (restore(mapRow(data[0])) && undoRef.current?.id === data[0].id) setUndo(null);
    } catch { writeFailed('Recall'); }
    finally { recallBusy.current = false; }
  }, [live, storeTickets, localPatch, patchRow, showToast, locationId, centreId, dayStartIso, restore, writeFailed]);

  // History: today only (Peter), newest first.
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]);
  const openHistory = useCallback(async () => {
    setShowHistory(true);
    setSel(null);
    if (!live) { setHistory((storeTickets || []).map(mapRow).filter(t => localPatch[t.id]?.status === 'bumped')); return; }
    try {
      let q = kitchenDb().from('kds_tickets').select('*').eq('location_id', locationId).eq('status', 'bumped')
        .gte('bumped_at', dayStartIso()).order('bumped_at', { ascending: false }).limit(HISTORY_LIMIT);
      if (centreId) q = q.eq('centre_id', centreId);
      const { data, error } = await limitedRead(q, LOAD_TIMEOUT_MS, 'History');
      if (error) { writeFailed('History'); return; }
      setHistory((data || []).map(mapRow));
    } catch { writeFailed('History'); }
  }, [live, storeTickets, localPatch, locationId, centreId, dayStartIso, writeFailed]);
  const historyRef = useRef(history);
  useEffect(() => { historyRef.current = history; }, [history]);
  const recallFromHistory = useCallback((id) => {
    const row = historyRef.current.find(t => t.id === id);
    if (restore(row)) {
      setHistory(prev => prev.filter(t => t.id !== id));
      setShowHistory(false);
      setSel(null);
      // Not live (mock): nothing is written, so say it here. Live: said when the database has it.
      if (!live) showToast('Ticket recalled', 'success');
    }
  }, [live, restore, showToast]);
  const historyViews = useMemo(() => history.map(t => ({
    ...ticketView(t, needsTypeLookup(t.meta) ? queueRows[t.meta.orderRef] : null),
    bumpedLabel: t.bumpedAt ? clockFmt.format(t.bumpedAt) : null,
  })), [history, queueRows, clockFmt]);

  // The "more below" count follows the board: tickets in or out, History closing, a banner
  // pushing the cards down. (Scrolling and a resize measure too.) `below` itself is in the list:
  // the strip that says it takes its own height off the board, so the count is taken once more.
  useEffect(() => { measureBelow(); }, [measureBelow, displayed, scale, showHistory, board.level, filterNote, below]);

  // ── settings gate (manager PIN, 90 second grace) ────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const approvedAt = useRef(0);
  const openSettings = useCallback(() => {
    if (isMock || Date.now() - approvedAt.current < MANAGER_GRACE_MS) { setSettingsOpen(true); return; }
    setPinOpen(true);
  }, []);
  const loadStaff = useCallback(() => loadStaffRoster(locationId), [locationId]);
  const onManagerApproved = useCallback(() => {
    approvedAt.current = Date.now();
    setPinOpen(false);
    setSettingsOpen(true);
  }, []);

  const openTicket = useCallback((id) => setSel({ id, mode: 'live' }), []);
  const openHistoryTicket = useCallback((id) => setSel({ id, mode: 'history' }), []);
  const selView = sel
    ? (sel.mode === 'history' ? historyViews : views).find(v => v.id === sel.id) || null
    : null;

  // ── render ──────────────────────────────────────────────────────────────────
  const centreLabel = device.centreName || (centreId ? (stationLabel(centreId) || centreId) : null);
  const liveCount = inStation.length;
  const boardMeta = [centreLabel, `${liveCount} ${liveCount === 1 ? 'ticket' : 'tickets'}`, `v${VERSION}`].filter(Boolean).join(' · ');
  // 12 Oct 2026: a bump not saved yet can be recalled too (Recall last brings the newest one back),
  // though the database, which lastBumpedToday is read from, does not hold it as bumped yet.
  const canRecall = live ? (lastBumpedToday || board.unsavedBumps > 0) : Object.values(localPatch).some(p => p.status === 'bumped');
  const saveNote = settingsDb === 'missing'
    ? 'Saved on this screen only for now. They move to the database once the KDS database update has been run.'
    : null;

  const cardGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 18, alignContent: 'start' };

  // 12 Oct 2026, Barnsley (K5): the words the board says about its link. Not live (mock, unpaired)
  // there is no link to speak of, so the board reads as healthy.
  const linkBanner = live ? bannerWords({ level: board.level, unsavedBumps: board.unsavedBumps, serverFault: board.serverFault }) : null;
  const savingNote = live && board.showSaving ? savingWords({ bumps: board.unsavedBumps, others: board.unsavedOthers }) : null;
  // A bump tapped under 3 seconds ago is not yet said to be "not saved" (the header count waits the
  // same 3 seconds), so a healthy board that staff have just cleared never flashes "1 bump not saved
  // yet." for the tenth of a second its write takes. For those 3 seconds the empty board says
  // NOTHING, no tick and no words (review 12 Oct 2026: it said "Kitchen clear" with the green tick
  // while the last bump was not saved, on a hung link for the full 3 seconds).
  const empty = live
    ? emptyWords({ sure: board.sure, everApplied: board.everApplied, level: board.level, unsavedBumps: board.unsavedBumps, showSaving: board.showSaving })
    : emptyWords({ sure: true, everApplied: true, level: 'ok', unsavedBumps: 0 });
  const belowNote = showHistory ? null : belowWords(below);

  return (
    // v5.5.913: height:100% AND minHeight:0 are load bearing. On a paired kitchen screen
    // App.jsx renders this as a direct child of #root (display:block), where flex:1 alone
    // is inert and the board could never scroll. Keep both.
    <div style={{
      display: 'flex', flex: 1, flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden',
      position: 'relative', background: C.root, color: C.text, fontFamily: SANS,
    }}>
      <style>{KDS_KEYFRAMES}{`
        .kds-ghost:hover { background: rgba(255,255,255,.07) !important; }
        .kds-hold:hover { background: rgba(255,255,255,.12) !important; }
        .kds-bump-lg:hover { background: ${C.bumpHover} !important; }
        .kds-pills::-webkit-scrollbar { display: none; }
      `}</style>

      {/* ── header ── one row at every width: the pills scroll sideways on a small screen
          instead of wrapping (wrapped, the header took a third of a 1024 by 600 screen). */}
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 22, padding: '18px 26px', borderBottom: `1px solid ${C.line}`, background: C.header }}>
        <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 2, maxWidth: '32%' }}>
          <div style={{ font: `800 24px ${SANS}`, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{device.name}</div>
          <div style={{ font: `400 13px ${MONO}`, color: C.meta3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{boardMeta}</div>
        </div>

        <div className="kds-pills" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, overflowX: 'auto', scrollbarWidth: 'none' }}>
          {!showHistory && (settings.show.counts || stations.length > 1) && (
            <div style={{ flex: 'none', width: 1, height: 40, background: 'rgba(255,255,255,.1)', marginRight: 12 }} />
          )}
          {settings.show.counts && !showHistory && counts.map(c => (
            <button key={c.key} type="button" onClick={() => tapTypeFilter(c.key)} style={{ ...pill(activeType === c.key, c.c), flex: 'none' }}>
              <span style={{ width: 9, height: 9, borderRadius: 99, background: c.c }} />
              <span style={{ font: `700 15px ${SANS}`, whiteSpace: 'nowrap' }}>{c.label}</span>
              <span style={{ font: `700 15px ${MONO}`, color: activeType === c.key ? '#fff' : '#E6ECE9' }}>{c.count}</span>
            </button>
          ))}
          {settings.show.counts && stations.length > 1 && !showHistory && (
            <div style={{ flex: 'none', width: 1, height: 28, background: 'rgba(255,255,255,.1)', margin: '0 6px' }} />
          )}
          {stations.length > 1 && !showHistory && stations.map(st => (
            <button key={st} type="button" onClick={() => setStationFilter(st)} style={{ ...pill(activeStation === st, '#E6ECE9'), flex: 'none', whiteSpace: 'nowrap' }}>
              {st === 'all' ? 'All stations' : (stationLabel(st) || st)}
            </button>
          ))}
        </div>

        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* 12 Oct 2026 (K2): changes this screen has made that the database has not confirmed
              yet, once they have waited 3 seconds. A healthy screen never shows it. */}
          {savingNote && (
            <div role="status" style={{
              flex: 'none', display: 'flex', alignItems: 'center', minHeight: 44, padding: '0 16px', borderRadius: 999,
              border: '1px solid rgba(245,165,36,.6)', background: 'rgba(245,165,36,.16)', color: '#FFD79A',
              font: `800 15px ${SANS}`, whiteSpace: 'nowrap',
            }}>{savingNote}</div>
          )}
          {/* Undo sits in the header, in place of Recall last, for 5 seconds after a bump. As a
              floating bar it covered the Bump button of the card underneath it. */}
          {undo && !showHistory ? (
            <button type="button" onClick={doUndo} title={`Undo bump: ${undo.headline}`}
              style={{ ...ghostBtn(true), maxWidth: 320, font: `800 15px ${SANS}` }}>
              <span style={{ flex: 'none' }}>↺ Undo</span>
              <span style={{ fontWeight: 600, color: C.setting, overflow: 'hidden', textOverflow: 'ellipsis' }}>{undo.headline}</span>
            </button>
          ) : canRecall && !showHistory && (
            <button type="button" className="kds-ghost" onClick={recallLast} style={ghostBtn()}>↺ Recall last</button>
          )}
          <button type="button" className={showHistory ? undefined : 'kds-ghost'} onClick={showHistory ? () => { setShowHistory(false); setSel(null); } : openHistory} style={ghostBtn(showHistory)}>
            {showHistory ? '← Back to board' : '☰ History'}
          </button>
          <button type="button" className="kds-ghost" onClick={openSettings} style={ghostBtn()}>⚙ Settings</button>
          <div style={{ font: `700 15px ${MONO}`, color: C.clock, paddingLeft: 6 }}>{clockFmt.format(now)}</div>
        </div>
      </div>

      {/* ── banners ── 12 Oct 2026, Barnsley (K5): the old warning was a thin pale strip, on only
          while a list read was failing. This one is solid, large and in plain words: amber when the
          screen is slow, red when it is offline, with the bumps not saved yet. It shows on History
          too, and only a list read that was USED can clear it (lib/kds/kdsLinkHealth.js). */}
      {linkBanner && (
        <div role="alert" style={{
          flex: 'none', padding: '16px 26px',
          background: linkBanner.tone === 'offline' ? '#B91C1C' : '#F5A524',
          color: linkBanner.tone === 'offline' ? '#FFFFFF' : '#1A1200',
          font: `800 24px/1.25 ${SANS}`,
        }}>{linkBanner.text}</div>
      )}
      {filterNote && !showHistory && (
        <div role="status" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 18, padding: '12px 26px', background: 'rgba(245,165,36,.16)', borderBottom: '1px solid rgba(245,165,36,.4)' }}>
          <span style={{ flex: 1, minWidth: 0, font: `700 20px ${SANS}`, color: '#FFD79A' }}>{filterNote}</span>
          <button type="button" onClick={() => tapTypeFilter('all')} style={{
            flex: 'none', border: 0, background: C.bump, color: C.bumpInk, borderRadius: 12, padding: '0 28px', minHeight: 52,
            font: `800 19px ${SANS}`, cursor: 'pointer',
          }}>Show all</button>
        </div>
      )}

      {/* ── body ── */}
      {showHistory ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 22px' }}>
          <div style={{ ...monoLabel, paddingBottom: 14 }}>BUMPED TODAY · TAP RECALL TO BRING ONE BACK</div>
          {historyViews.length === 0 ? (
            <div style={{ padding: '120px 0', textAlign: 'center', color: C.empty, font: `600 22px ${SANS}` }}>Nothing bumped today.</div>
          ) : (
            <div ref={gridRef} style={cardGrid}>
              {historyViews.map(v => (
                <KdsTicketCard key={v.id} view={v} mins={0} settings={settings} scale={scale} mode="history"
                  onOpen={openHistoryTicket} onRecall={recallFromHistory} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div ref={scrollRef} onScroll={measureBelow} style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', padding: '20px 22px' }}>
              {displayed.length === 0 ? (
                inStation.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '120px 0' }}>
                    {/* 12 Oct 2026 (K5): the green tick and "Kitchen clear" only when the screen is sure. */}
                    {empty.clear && (
                      <div style={{ width: 72, height: 72, borderRadius: 20, background: 'rgba(34,197,94,.15)', border: `2px solid ${C.bump}`, display: 'flex', alignItems: 'center', justifyContent: 'center', font: `800 34px ${SANS}`, color: C.bump, marginBottom: 18 }}>✓</div>
                    )}
                    <div style={{ font: `800 26px ${SANS}`, color: C.setting }}>{empty.title}</div>
                    <div style={{ font: `600 16px ${SANS}`, color: C.empty, marginTop: 6 }}>{empty.sub}</div>
                  </div>
                ) : (
                  <div style={{ padding: '120px 0', textAlign: 'center', color: C.empty, font: `600 22px ${SANS}` }}>No tickets on this filter.</div>
                )
              ) : (
                <div ref={gridRef} style={cardGrid}>
                  {displayed.map(v => (
                    <KdsTicketCard key={v.id} view={v} mins={minutesSince(v.sentAt, now)} settings={settings} scale={scale} mode="live"
                      onOpen={openTicket} onBump={bump} onHold={hold} onResume={resume} onBumpItem={bumpItem} />
                  ))}
                </div>
              )}
            </div>
            {/* 12 Oct 2026, review: this was a pill floating over the bottom of the board. Measured
                on the real screen it lay over a card's Bump button at about a third of scroll
                positions, and a tap meant for Bump only scrolled the board. It is a strip UNDER the
                board now: the cards end above it and it covers nothing. */}
            {belowNote && (
              <button type="button" onClick={() => { const box = scrollRef.current; if (box) box.scrollTop += Math.round(box.clientHeight * 0.8); }}
                style={{
                  flex: 'none', width: '100%', border: 0, borderRadius: 0, padding: '0 28px', minHeight: 56,
                  background: '#F5A524', color: '#1A1200', font: `800 21px ${SANS}`, cursor: 'pointer', whiteSpace: 'nowrap',
                }}>{belowNote} ↓</button>
            )}
          </div>

          {settings.show.rail && (
            <div style={{ width: 300, flex: 'none', borderLeft: `1px solid ${C.line}`, background: C.rail, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ padding: '18px 20px 12px' }}>
                <div style={monoLabel}>TO MAKE</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
                  <span style={{ font: `800 34px ${SANS}`, color: C.railQty }}>{railTotal}</span>
                  <span style={{ font: `600 15px ${SANS}`, color: C.meta1 }}>{railTotal === 1 ? 'item' : 'items'}</span>
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 20px 20px', display: 'flex', flexDirection: 'column' }}>
                {rail.map(r => (
                  <div key={r.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '13px 0', borderTop: `1px solid ${C.row}` }}>
                    <span style={{ font: `800 22px/1.1 ${MONO}`, color: C.railQty, minWidth: 34 }}>{r.qty}</span>
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ font: `600 16px/1.25 ${SANS}`, color: C.railItem, overflowWrap: 'anywhere' }}>{r.name}</span>
                      {r.mods.map((m, i) => (
                        <span key={i} style={{ font: `600 14px/1.3 ${SANS}`, color: m.startsWith('⚠') ? C.allergen : C.meta1, overflowWrap: 'anywhere' }}>{m}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {selView && (
        <KdsTicketModal view={selView} mins={sel.mode === 'history' ? 0 : minutesSince(selView.sentAt, now)} settings={settings} mode={sel.mode}
          onClose={() => setSel(null)} onBump={bump} onHold={hold} onResume={resume} onBumpItem={bumpItem} onRecall={recallFromHistory}
          onSaveNote={sel.mode === 'live' ? saveKitchenNote : undefined} noteSaving={noteSaving} />
      )}

      {settingsOpen && (
        <KdsSettingsSheet settings={settings} onChange={changeSettings} onClose={() => setSettingsOpen(false)} saveNote={saveNote} />
      )}
      {pinOpen && <KdsManagerPin loadStaff={loadStaff} onApprove={onManagerApproved} onClose={() => setPinOpen(false)} />}
    </div>
  );
}
