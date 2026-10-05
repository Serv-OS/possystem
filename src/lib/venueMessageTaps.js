// src/lib/venueMessageTaps.js: Got it taps on a message from ServOS that have not reached the
// server yet, kept in this browser, and the way to send them when no screen is showing messages.
//
// WHY (review, 5 Oct 2026): WiFi drops, staff tap Got it (the pop up clears on that till and the
// tap is saved), the till signs out to the PIN screen, WiFi returns. The messages hook
// only lives inside the signed in till shell, so the tap would wait until somebody signed in on
// that same till again, and meanwhile the other tills, Back Office and Company Admin all still
// show the message as waiting although the venue did confirm.
//
// So sync/SyncBridge.jsx (mounted once, PIN screen included) calls flushVenueMessageTaps() when
// the till comes back online and on its existing 60 second tick. It costs one localStorage read
// when nothing is saved, and no request at all.
//
// This file never reads a message. It only sends a confirmation this very browser already made.
//
// No Supabase import here (node tests load this file): the caller passes the send, which is
// lib/venueMessages.js confirmVenueMessage.
import { tapsToSend, tapsAfterFlush } from './venueMessageRules.js';

export const TAPPED_KEY = 'rpos-venue-message-taps';

export const readTapped = () => {
  try { const v = JSON.parse(localStorage.getItem(TAPPED_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
};
export const writeTapped = (v) => { try { localStorage.setItem(TAPPED_KEY, JSON.stringify(v || {})); } catch { /* storage full or private mode */ } };

// How many screens on this page are running the hook right now. While one is, it owns the saved
// taps (it sends them on every read), and the flush stands back.
let liveHooks = 0;
let flushing = false;
export const hookStarted = () => { liveHooks += 1; };
export const hookStopped = () => { liveHooks = Math.max(0, liveHooks - 1); };

/**
 * Send any saved Got it taps. Never throws, never more than one run at a time.
 * `send(id, name)` is confirmVenueMessage; `read` and `write` are for tests only.
 * @returns {Promise<number>} how many taps were tried
 */
export async function flushVenueMessageTaps({ send, read = readTapped, write = writeTapped } = {}) {
  if (typeof send !== 'function') return 0;
  if (flushing || liveHooks > 0) return 0;
  let ids = [];
  try { ids = tapsToSend(read()); } catch { return 0; }
  if (!ids.length) return 0;
  flushing = true;
  try {
    const saved = read();
    const results = {};
    for (const id of ids) {
      try { results[id] = await send(id, saved[id]?.name || null); }
      catch { /* stays saved for the next try */ }
    }
    // Read again before writing: a tap made while this was sending must not be lost. If a
    // screen started the hook meanwhile it owns the list now, and it sends these again itself
    // (the server answers "already", which is done).
    if (liveHooks === 0) write(tapsAfterFlush(read(), results));
    return ids.length;
  } catch {
    return 0;
  } finally {
    flushing = false;
  }
}
