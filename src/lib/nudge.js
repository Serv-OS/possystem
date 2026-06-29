// src/lib/nudge.js — manager → tills "nudge" for a stalled table.
// DB-backed (reliable): the Manager app INSERTs a pos_nudges row; the tills pick it up via
// postgres_changes in lib/realtime.js (the same realtime they already use for KDS/sessions) and pop a
// toast + chime. No broadcast timing race. RLS on pos_nudges is permissive (matches kds_tickets), so
// the anonymous manager device can insert and the anonymous till can read it.
import { supabase, isMock } from './supabase';

/** Ping the tills about a stalled table. payload: { table, covers, waitMins, by }. */
export async function sendNudge(locationId, payload = {}) {
  if (isMock || !supabase || !locationId) return { ok: false, error: 'offline' };
  const { error } = await supabase.from('pos_nudges').insert({
    location_id: locationId,
    table_label: payload.table || null,
    covers: payload.covers != null ? Number(payload.covers) : null,
    wait_mins: payload.waitMins != null ? Math.round(Number(payload.waitMins)) : null,
    by_name: payload.by || null,
  });
  if (error) { console.warn('[nudge] send failed', error.message); return { ok: false, error: error.message }; }
  return { ok: true };
}
