// src/lib/useVenueMessages.js: one venue's messages from ServOS, kept current on this screen.
//
// Three ways in, so a missed live event is caught within a minute or two (the same belt and
// braces as the config push and the open orders reconciler):
//   1. a read when the screen loads,
//   2. the live channel (and a fresh read every time it connects again),
//   3. a read every POLL_MS, and when the tab comes back to the front.
//
// Got it clears the pop up on THIS screen at once and is then sent to the server. If it does not
// get through (a till with no internet) the tap is kept in this browser and sent again on the
// next read, so the till is never held up for more than the tap. The hook only lives inside the
// signed in till shell, so a till that has gone back to the PIN screen sends its saved taps
// through flushVenueMessageTaps() (lib/venueMessageTaps.js, called by the always mounted sync/SyncBridge.jsx).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchVenueMessages, confirmVenueMessage, subscribeVenueMessages } from './venueMessages';
import { applyMessageRow, mergeFetched, openQueue, addTapped, tappedOutcome, tapsToSend, pruneTapped } from './venueMessageRules';
import { readTapped, writeTapped, hookStarted, hookStopped } from './venueMessageTaps';

export const POLL_MS = 60 * 1000;
const EMPTY = [];

export function useVenueMessages(locationId, { enabled = true, days = 30 } = {}) {
  const [rows, setRows] = useState(EMPTY);
  const [ready, setReady] = useState(false);     // the database has the table
  const [loaded, setLoaded] = useState(false);   // the first read came back
  const [tapped, setTapped] = useState(readTapped);
  const rowsRef = useRef(EMPTY);
  const tappedRef = useRef(tapped);
  const sendingRef = useRef(new Set());
  const aliveRef = useRef(true);

  const setTappedBoth = useCallback((next) => { tappedRef.current = next; writeTapped(next); setTapped(next); }, []);
  const setRowsBoth = useCallback((next) => { rowsRef.current = next; setRows(next); }, []);

  // Send one tap. Whatever happens the pop up is already gone from this screen.
  const sendTap = useCallback(async (id) => {
    if (!id || sendingRef.current.has(id)) return;
    const t = tappedRef.current[id];
    if (!t) return;
    sendingRef.current.add(id);
    try {
      const res = await confirmVenueMessage(id, t.name);
      if (!aliveRef.current) return;
      const outcome = tappedOutcome(res);
      if (outcome === 'refused') {
        setTappedBoth({ ...tappedRef.current, [id]: { ...t, refused: true } });
      } else if (outcome === 'done') {
        const next = { ...tappedRef.current };
        delete next[id];
        const base = rowsRef.current.find((r) => r.id === id) || { id, location_id: locationId };
        // The row is marked finished BEFORE the tap is forgotten, so the pop up cannot flash back.
        if (res.state === 'withdrawn') {
          setRowsBoth(applyMessageRow(rowsRef.current, { ...base, withdrawn_at: new Date().toISOString() }, locationId));
        } else {
          setRowsBoth(applyMessageRow(rowsRef.current, {
            ...base, confirmed_at: res.confirmedAt || new Date().toISOString(), confirmed_by: res.confirmedBy || t.name || 'Someone',
          }, locationId));
        }
        setTappedBoth(next);
      }
    } finally {
      sendingRef.current.delete(id);
    }
  }, [locationId, setRowsBoth, setTappedBoth]);

  const refresh = useCallback(async () => {
    if (!enabled || !locationId) return;
    const res = await fetchVenueMessages(locationId, { days });
    if (!aliveRef.current) return;
    setLoaded(true);
    if (!res.ok) return;                       // the read failed: keep what is on screen
    setReady(res.ready);
    if (!res.ready) { setRowsBoth(EMPTY); return; }
    const merged = mergeFetched(rowsRef.current, res.rows, locationId);
    setRowsBoth(merged);
    const pruned = pruneTapped(tappedRef.current, merged);
    if (Object.keys(pruned).length !== Object.keys(tappedRef.current).length) setTappedBoth(pruned);
    for (const id of tapsToSend(pruned)) sendTap(id);     // taps that did not get through earlier
  }, [enabled, locationId, days, sendTap, setRowsBoth, setTappedBoth]);

  useEffect(() => {
    aliveRef.current = true;
    if (!enabled || !locationId) return () => { aliveRef.current = false; };
    hookStarted();
    const first = setTimeout(refresh, 0);
    const iv = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) refresh(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) refresh(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    const unsubscribe = subscribeVenueMessages(locationId, {
      onRow: (row) => { if (aliveRef.current) setRowsBoth(applyMessageRow(rowsRef.current, row, locationId)); },
      onSubscribed: refresh,
    });
    return () => {
      aliveRef.current = false;
      hookStopped();
      clearTimeout(first); clearInterval(iv);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      unsubscribe();
    };
  }, [enabled, locationId, refresh, setRowsBoth]);

  /** Got it: gone from this screen now, recorded on the server as soon as it gets through. */
  const confirm = useCallback((id, name) => {
    if (!id) return;
    setTappedBoth(addTapped(tappedRef.current, id, name, new Date().toISOString()));
    sendTap(id);
  }, [sendTap, setTappedBoth]);

  const tappedIds = useMemo(() => new Set(Object.keys(tapped)), [tapped]);
  // Only ever this venue's rows, whatever is still in memory from a venue the person switched from.
  const mine = useMemo(() => rows.filter((r) => String(r.location_id) === String(locationId)), [rows, locationId]);
  const queue = useMemo(() => (enabled ? openQueue(mine, locationId, tappedIds) : EMPTY), [enabled, mine, locationId, tappedIds]);

  return { rows: mine, queue, ready, loaded, confirm, refresh };
}
