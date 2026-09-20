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

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useStore } from '../../store';
import { VERSION } from '../../lib/version';
import { supabase, isMock } from '../../lib/supabase';
import { updateDeviceHeartbeat } from '../../lib/db';
import { isDeviceLinkUncertain } from '../../lib/deviceLink';
import { trustSharedRead } from '../../lib/deviceFence';
import { mustChangeRow, writeErrorOf } from '../../lib/rowWrites';
import { loadStaffRoster } from '../../lib/staffRoster';
import { getLocationConfig } from '../../lib/locationTime';
import {
  ticketMeta, ticketView, needsTypeLookup, minutesSince, sortTickets, typeCounts, rollUp, venueBusinessDayStart,
} from '../../lib/kds/kdsTicket';
import {
  normaliseKdsSettings, kdsSettingsStorageKey, isMissingColumnError,
} from '../../lib/kds/kdsSettings';
import { gridColumnWidth, cardScale } from '../../lib/kds/kdsFit';
import { KdsTicketCard, KdsTicketModal } from './KdsTicketCard';
import { KdsSettingsSheet, KdsManagerPin } from './KdsSettingsSheet';
import { C, SANS, MONO, ghostBtn, pill, monoLabel, KDS_KEYFRAMES } from './kdsStyles';

// Database fence stage 1, fix round 2 (the zero row blocker): every kds_tickets update here counts
// the rows it changed. One that changes nothing while this screen is not linked is kept and sent
// once it is linked again (the banner shows), never counted as done. Resolves { error, outcome }.
const ticketWrite = (id, payload, label) =>
  mustChangeRow({ table: 'kds_tickets', type: 'update', payload, match: { id }, kind: 'kds_ticket', label })
    .then((r) => ({ error: writeErrorOf(r), outcome: r.outcome }));

const UNDO_MS = 5000;
const MANAGER_GRACE_MS = 90 * 1000;
const HISTORY_LIMIT = 200;

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
    items: (Array.isArray(items) ? items : []).map(i => ({ ...i, _bumped: i._bumped || false })),
    meta: ticketMeta(row),
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
  const { locationId, centreId } = device;
  const live = !isMock && !!locationId;

  // ── settings (per screen) ───────────────────────────────────────────────────
  const storageKey = kdsSettingsStorageKey(device.id);
  const [settings, setSettings] = useState(() => normaliseKdsSettings(readJson(storageKey)));
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

  // Card text scale from the column width (Peter: keep today's columns, shrink the text).
  // One observer on whichever grid is showing; the value is rounded so cards re-render
  // only when the column width really changes.
  const [scale, setScale] = useState(1);
  const gridObserver = useRef(null);
  const gridRef = useCallback((el) => {
    gridObserver.current?.disconnect();
    gridObserver.current = null;
    if (!el) return;
    const apply = () => setScale(cardScale(gridColumnWidth(el.clientWidth)));
    apply();
    if (typeof ResizeObserver !== 'undefined') {
      gridObserver.current = new ResizeObserver(apply);
      gridObserver.current.observe(el);
    }
  }, []);
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
  const [rows, setRows] = useState([]);
  const [sel, setSel] = useState(null);                       // open pop out: { id, mode }
  const [localPatch, setLocalPatch] = useState({});          // not live only: id → partial row
  const [lastBumpedToday, setLastBumpedToday] = useState(false);

  const loadLastBumped = useCallback(async () => {
    if (!live) return;
    let q = supabase.from('kds_tickets').select('id').eq('location_id', locationId).eq('status', 'bumped')
      .gte('bumped_at', dayStartIso()).order('bumped_at', { ascending: false }).limit(1);
    if (centreId) q = q.eq('centre_id', centreId);
    const { data } = await q;
    setLastBumpedToday(!!data?.length);
  }, [live, locationId, centreId, dayStartIso]);
  const loadLastBumpedRef = useRef(loadLastBumped);
  useEffect(() => { loadLastBumpedRef.current = loadLastBumped; }, [loadLastBumped]);

  // Every local write bumps this counter when it starts AND when it finishes. A refetch
  // that started before the last change finished is thrown away, or its older snapshot
  // would bring back a ticket just bumped (or undo a hold) for up to 20 seconds.
  const writeSeq = useRef(0);
  // In flight bump writes by ticket id, so Undo can wait for the bump to land first.
  const pendingBumps = useRef(new Map());
  /** Run one kds_tickets write, fenced by writeSeq. Resolves to { error }. */
  const tracked = useCallback((makeQuery) => {
    writeSeq.current += 1;
    // makeQuery returns a Supabase builder, which sends its request each time it is
    // awaited: the async wrapper adopts it exactly once.
    const p = (async () => makeQuery())();
    return p.finally(() => { writeSeq.current += 1; });
  }, []);

  useEffect(() => {
    if (!live) return;
    const load = async () => {
      const seqAtStart = writeSeq.current;
      try {
        let q = supabase.from('kds_tickets').select('*').eq('location_id', locationId).in('status', ['pending', 'held']).order('sent_at', { ascending: true });
        if (centreId) q = q.eq('centre_id', centreId);
        const { data } = await q;
        // Database fence stage 1 (contract A9): an empty read while this screen may have lost
        // its link is unknown, never "no tickets". Keep what is on screen.
        if (data && !trustSharedRead({ linkUncertain: isDeviceLinkUncertain(), rowCount: data.length })) return;
        if (data && writeSeq.current === seqAtStart) {
          setRows(data.map(mapRow));
          // A ticket bumped somewhere else while it was open closes the pop out.
          setSel(s => (s && s.mode === 'live' && !data.some(r => r.id === s.id) ? null : s));
        }
      } catch { /* keep what is on screen; the next poll retries */ }
      loadLastBumpedRef.current().catch?.(() => {});
    };
    load();
    const channel = supabase
      .channel(`kds-tickets-${locationId}${centreId ? `-${centreId}` : ''}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'kds_tickets', filter: `location_id=eq.${locationId}` }, (payload) => {
        const t = mapRow(payload.new);
        if (centreId && t.centreId !== centreId) return;
        if (t.status !== 'pending' && t.status !== 'held') return;
        setRows(prev => prev.some(r => r.id === t.id) ? prev.map(r => r.id === t.id ? t : r) : [...prev, t]);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'kds_tickets', filter: `location_id=eq.${locationId}` }, (payload) => {
        const t = mapRow(payload.new);
        if (payload.new.status === 'bumped') {
          // Unguarded on purpose: it also cleans up rows that leaked in before v5.5.913.
          setRows(prev => prev.filter(r => r.id !== t.id));
          setSel(s => (s && s.mode === 'live' && s.id === t.id ? null : s));
          if (!centreId || t.centreId === centreId) setLastBumpedToday(true);
          return;
        }
        if (centreId && t.centreId !== centreId) return;
        if (t.status === 'pending' || t.status === 'held') {
          setRows(prev => prev.some(r => r.id === t.id) ? prev.map(r => r.id === t.id ? t : r) : [...prev, t]);
        } else {
          setRows(prev => prev.map(r => r.id === t.id ? t : r));
        }
      })
      .subscribe();

    // v5.7.39 self heal: push is the fast path, never the only path.
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', load);
    const pollId = setInterval(load, 20000);
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', load);
      clearInterval(pollId);
    };
  }, [live, locationId, centreId]);

  const tickets = useMemo(() => {
    if (live) return rows;
    return (storeTickets || []).map(mapRow)
      .map(t => (localPatch[t.id] ? { ...t, ...localPatch[t.id] } : t))
      .filter(t => t.status !== 'bumped');
  }, [live, rows, storeTickets, localPatch]);
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
  const [typeFilter, setTypeFilter] = useState('all');
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
  const rail = useMemo(() => rollUp(displayed), [displayed]);
  const railTotal = rail.reduce((n, r) => n + r.qty, 0);

  // ── actions ─────────────────────────────────────────────────────────────────
  const [undo, setUndo] = useState(null);                     // { id, prevStatus, headline }

  const patchRow = useCallback((id, patch) => {
    if (live) setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
    else setLocalPatch(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }, [live]);

  const writeFailed = useCallback((what) => {
    useStore.getState().showToast?.(`${what} did not save. Check the connection, the board will catch up.`, 'error');
  }, []);

  const bump = useCallback(async (id) => {
    const t = ticketsRef.current.find(x => x.id === id);
    if (!t) return;
    setSel(s => (s?.id === id ? null : s));
    setUndo({ id, prevStatus: t.held ? 'held' : 'pending', headline: ticketView(t).headline, at: Date.now() });
    if (live) {
      setRows(prev => prev.filter(r => r.id !== id));
      setLastBumpedToday(true);
      const p = tracked(() => ticketWrite(id, { status: 'bumped', bumped_at: new Date().toISOString() }, 'Kitchen ticket bumped'));
      pendingBumps.current.set(id, p);
      const { error } = await p;
      if (pendingBumps.current.get(id) === p) pendingBumps.current.delete(id);
      if (error) writeFailed('Bump');
    } else {
      patchRow(id, { status: 'bumped' });
      if (!isMock) bumpTicket(id);
    }
  }, [live, patchRow, bumpTicket, writeFailed, tracked]);

  const hold = useCallback(async (id) => {
    patchRow(id, { status: 'held', held: true });
    showToast('Ticket held', 'info');
    if (live) {
      const { error } = await tracked(() => ticketWrite(id, { status: 'held' }, 'Kitchen ticket held'));
      if (error) writeFailed('Hold');
    }
  }, [live, patchRow, showToast, writeFailed, tracked]);

  // Resume keeps counting from when the order was first sent (Peter): sent_at is untouched.
  const resume = useCallback(async (id) => {
    patchRow(id, { status: 'pending', held: false });
    showToast('Ticket back in queue', 'success');
    if (live) {
      const { error } = await tracked(() => ticketWrite(id, { status: 'pending' }, 'Kitchen ticket resumed'));
      if (error) writeFailed('Resume');
    }
  }, [live, patchRow, showToast, writeFailed, tracked]);

  const bumpItem = useCallback(async (id, index) => {
    const t = ticketsRef.current.find(x => x.id === id);
    if (!t) return;
    const items = t.items.map((it, i) => (i === index ? { ...it, _bumped: true } : it));
    // Ticking the last item bumps the whole ticket (voided lines do not count).
    if (items.filter(i => !i.voided).every(i => i._bumped)) { bump(id); return; }
    patchRow(id, { items });
    if (live) {
      const { error } = await tracked(() => ticketWrite(id, { items }, 'Kitchen item ticked'));
      if (error) writeFailed('Item tick');
    }
  }, [live, patchRow, bump, writeFailed, tracked]);

  /** Bring a bumped ticket back. Recall keeps counting from first sent (Peter). */
  const restore = useCallback(async (row, status = 'pending') => {
    if (!row) return false;
    if (live) {
      const { error } = await tracked(() => ticketWrite(row.id, { status, bumped_at: null }, 'Kitchen ticket recalled'));
      if (error) { writeFailed('Recall'); return false; }
      const back = { ...row, status, held: status === 'held', bumpedAt: null };
      setRows(prev => (prev.some(r => r.id === row.id) ? prev : [...prev, back]));
    } else {
      patchRow(row.id, { status, held: status === 'held' });
    }
    return true;
  }, [live, patchRow, writeFailed, tracked]);

  // Undo: the last bump, for 5 seconds. A bump changes only this row (no trigger and no
  // listener moves the order on), so putting the row back undoes it completely.
  const undoRef = useRef(undo);
  useEffect(() => { undoRef.current = undo; }, [undo]);
  useEffect(() => {
    if (!undo) return undefined;
    const t = setTimeout(() => setUndo(u => (u && u.at === undo.at ? null : u)), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);
  const doUndo = useCallback(async () => {
    const u = undoRef.current;
    if (!u) return;
    setUndo(null);
    if (live) {
      // Wait for the bump write itself, or on slow Wi-Fi it could land after the restore
      // and leave the ticket bumped after the kitchen was shown it back.
      await pendingBumps.current.get(u.id)?.catch(() => {});
      const { data } = await supabase.from('kds_tickets').select('*').eq('id', u.id).maybeSingle();
      if (data) await restore(mapRow(data), u.prevStatus);
    } else {
      patchRow(u.id, { status: u.prevStatus, held: u.prevStatus === 'held' });
    }
    loadLastBumpedRef.current().catch?.(() => {});
  }, [live, restore, patchRow]);

  // Recall last: the last ticket bumped at this station today, from any screen.
  const recallLast = useCallback(async () => {
    if (!live) {
      const bumped = (storeTickets || []).map(mapRow).filter(t => localPatch[t.id]?.status === 'bumped');
      const last = bumped[bumped.length - 1];
      if (last) { patchRow(last.id, { status: 'pending', held: false }); showToast('Ticket recalled', 'success'); }
      return;
    }
    let q = supabase.from('kds_tickets').select('*').eq('location_id', locationId).eq('status', 'bumped')
      .gte('bumped_at', dayStartIso()).order('bumped_at', { ascending: false }).limit(1);
    if (centreId) q = q.eq('centre_id', centreId);
    const { data, error } = await q;
    if (error) { writeFailed('Recall'); return; }
    if (!data?.length) { setLastBumpedToday(false); showToast('Nothing bumped today to recall', 'info'); return; }
    if (await restore(mapRow(data[0]))) {
      if (undoRef.current?.id === data[0].id) setUndo(null);
      showToast('Ticket recalled', 'success');
      loadLastBumpedRef.current().catch?.(() => {});
    }
  }, [live, storeTickets, localPatch, patchRow, showToast, locationId, centreId, dayStartIso, restore, writeFailed]);

  // History: today only (Peter), newest first.
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]);
  const openHistory = useCallback(async () => {
    setShowHistory(true);
    setSel(null);
    if (!live) { setHistory((storeTickets || []).map(mapRow).filter(t => localPatch[t.id]?.status === 'bumped')); return; }
    let q = supabase.from('kds_tickets').select('*').eq('location_id', locationId).eq('status', 'bumped')
      .gte('bumped_at', dayStartIso()).order('bumped_at', { ascending: false }).limit(HISTORY_LIMIT);
    if (centreId) q = q.eq('centre_id', centreId);
    const { data, error } = await q;
    if (error) { writeFailed('History'); return; }
    setHistory((data || []).map(mapRow));
  }, [live, storeTickets, localPatch, locationId, centreId, dayStartIso, writeFailed]);
  const historyRef = useRef(history);
  useEffect(() => { historyRef.current = history; }, [history]);
  const recallFromHistory = useCallback(async (id) => {
    const row = historyRef.current.find(t => t.id === id);
    if (await restore(row)) {
      setHistory(prev => prev.filter(t => t.id !== id));
      setShowHistory(false);
      setSel(null);
      showToast('Ticket recalled', 'success');
      loadLastBumpedRef.current().catch?.(() => {});
    }
  }, [restore, showToast]);
  const historyViews = useMemo(() => history.map(t => ({
    ...ticketView(t, needsTypeLookup(t.meta) ? queueRows[t.meta.orderRef] : null),
    bumpedLabel: t.bumpedAt ? clockFmt.format(t.bumpedAt) : null,
  })), [history, queueRows, clockFmt]);

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
  const canRecall = live ? lastBumpedToday : Object.values(localPatch).some(p => p.status === 'bumped');
  const saveNote = settingsDb === 'missing'
    ? 'Saved on this screen only for now. They move to the database once the KDS database update has been run.'
    : null;

  const cardGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 18, alignContent: 'start' };

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
            <button key={c.key} type="button" onClick={() => setTypeFilter(c.key)} style={{ ...pill(activeType === c.key, c.c), flex: 'none' }}>
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
          <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '20px 22px' }}>
            {displayed.length === 0 ? (
              inStation.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '120px 0' }}>
                  <div style={{ width: 72, height: 72, borderRadius: 20, background: 'rgba(34,197,94,.15)', border: `2px solid ${C.bump}`, display: 'flex', alignItems: 'center', justifyContent: 'center', font: `800 34px ${SANS}`, color: C.bump, marginBottom: 18 }}>✓</div>
                  <div style={{ font: `800 26px ${SANS}`, color: C.setting }}>Kitchen clear</div>
                  <div style={{ font: `600 16px ${SANS}`, color: C.empty, marginTop: 6 }}>All orders bumped</div>
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
          onClose={() => setSel(null)} onBump={bump} onHold={hold} onResume={resume} onBumpItem={bumpItem} onRecall={recallFromHistory} />
      )}

      {settingsOpen && (
        <KdsSettingsSheet settings={settings} onChange={changeSettings} onClose={() => setSettingsOpen(false)} saveNote={saveNote} />
      )}
      {pinOpen && <KdsManagerPin loadStaff={loadStaff} onApprove={onManagerApproved} onClose={() => setPinOpen(false)} />}
    </div>
  );
}
