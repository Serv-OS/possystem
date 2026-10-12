// src/lib/menuBoardNotes.js
//
// A TV (menu board or order screen) leaves a short note when it protects its own pairing,
// so Back Office and support can see that it happened. Nobody can read a TV's console.
//
// 12 Oct 2026, WHY activity_events AND NOT A NEW TABLE. The screen row itself cannot carry a
// note: a TV may only stamp last_seen on it, and a new column or function is a schema change.
// activity_events already takes writes from devices (the same table the tills' bell reads) and
// has ref_type and ref_id, so a note is one small row tied to the screen it is about.
// Each note is written ALREADY READ (acked_at set), so no till's bell counts it: it is a record
// for Back Office and support, not a job for the floor staff. Severity is 'info', which never
// toasts or chimes. A note needs the venue, so only a TV that has been paired can leave one.
//
// Each kind of note has its own limit per TV (NOTE_GAP_MS in menuBoardPairing.js: a bad live
// update once an hour, found again or shows its code once in 5 minutes, lost its sign in once a
// day). One bad realtime change reaches every TV at once and may repeat, so no limit would
// mean a row per TV per message.

import { supabase, isMock } from './supabase';
import { VERSION } from './version';
import { noteText, shouldNote, isUuid } from './menuBoardPairing';

const LS_NOTES = 'rpos-mbscreen-notes';   // { kind: last written ms }
const lastInMemory = {};                  // so blocked storage cannot switch the limit off

/** Fire and forget. Never throws, never blocks the TV. */
export function stampScreenNote({ screen, kind, detail = '' }) {
  try {
    if (isMock || !supabase || !screen || !isUuid(screen.id) || !isUuid(screen.location_id)) return;
    const words = noteText(kind, detail);
    if (!words) return;
    const now = Date.now();
    if (!shouldNote({ kind, now, lastAt: lastInMemory[kind] })) return;   // the cheap check first: this runs every tick while a TV holds
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(LS_NOTES) || '{}') || {}; } catch { stored = {}; }
    const lastAt = Math.max(Number(lastInMemory[kind]) || 0, Number(stored[kind]) || 0);
    if (!shouldNote({ kind, now, lastAt })) return;
    lastInMemory[kind] = now;
    try { localStorage.setItem(LS_NOTES, JSON.stringify({ ...stored, [kind]: now })); } catch { /* storage blocked */ }
    supabase.from('activity_events').insert({
      location_id: screen.location_id, kind: 'system', severity: 'info',
      title: words.title, body: `${words.body} (v${VERSION})`,
      ref_type: 'menu_board_screen', ref_id: screen.id, actor_name: 'TV',
      acked_at: new Date(now).toISOString(), acked_by: 'auto',
    }).then(() => {}, () => {});
  } catch { /* a note must never break the TV */ }
}

/** Back Office: the newest note per screen at this venue, last 14 days. {} on any failure. */
export async function fetchScreenNotes(locationId) {
  if (isMock || !supabase || !locationId) return {};
  try {
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data, error } = await supabase.from('activity_events')
      .select('ref_id, title, body, created_at')
      .eq('location_id', locationId).eq('ref_type', 'menu_board_screen')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(200);
    if (error) return {};
    const out = {};
    for (const r of data || []) if (r.ref_id && !out[r.ref_id]) out[r.ref_id] = { title: r.title, body: r.body || '', at: r.created_at };
    return out;
  } catch { return {}; }
}
