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
//
// 12 Oct 2026 (review): the rules (what is skipped, the limit, the row) are makeNoteStamper in
// menuBoardPairing.js, so node:test can run them. This file only hands them the real client and
// the real storage. The limit now starts when the insert WORKED, so a note written while the TV
// was offline is tried again a minute later and not lost for an hour or a day.

import { supabase, isMock } from './supabase';
import { VERSION } from './version';
import { makeNoteStamper, noteCode } from './menuBoardPairing';

const LS_NOTES = 'rpos-mbscreen-notes';   // { kind (or kind:code): last written ms }

const stamp = makeNoteStamper({
  write: (row) => supabase.from('activity_events').insert(row),
  now: () => Date.now(),
  load: () => JSON.parse(localStorage.getItem(LS_NOTES) || '{}'),
  save: (o) => localStorage.setItem(LS_NOTES, JSON.stringify(o)),
  version: VERSION,
});

/** Fire and forget. Never throws, never blocks the TV. */
export function stampScreenNote(note) {
  try {
    if (isMock || !supabase) return;
    stamp(note);
  } catch { /* a note must never break the TV */ }
}

/**
 * Back Office: what the TVs at this venue said in the last 14 days, by screen id:
 * { title, body, at } of the newest note, plus { code, codeAt } of the newest "pair it again
 * with code" note (a TV that lost its sign in). {} on any failure.
 */
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
    for (const r of data || []) {
      if (!r.ref_id) continue;
      if (!out[r.ref_id]) out[r.ref_id] = { title: r.title, body: r.body || '', at: r.created_at, code: null, codeAt: null };
      const code = noteCode(r.title);
      if (code && !out[r.ref_id].code) { out[r.ref_id].code = code; out[r.ref_id].codeAt = r.created_at; }
    }
    return out;
  } catch { return {}; }
}
