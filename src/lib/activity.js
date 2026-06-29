// src/lib/activity.js — the POS ACTIVITY FEED data layer.
// One operational timeline (orders / nudges / menu changes / ops) in activity_events. Any surface
// calls logActivity() to add an event; the tills read recent + subscribe via postgres_changes (same
// realtime as KDS) to show a bell + slide-over panel and chime/toast for action items. RLS on
// activity_events is permissive (matches kds_tickets), so anon devices can write + read it.
import { supabase, isMock } from './supabase';

const rowToEvent = (r) => ({
  id: r.id, kind: r.kind, severity: r.severity, title: r.title, body: r.body || '',
  refType: r.ref_type || null, refId: r.ref_id || null, actorName: r.actor_name || null,
  ackedAt: r.acked_at || null, ackedBy: r.acked_by || null, createdAt: r.created_at,
});
export const eventFromRow = rowToEvent;

/** Add one activity event. kind: order|nudge|menu|stock|ops|system. severity: info|action|urgent. */
export async function logActivity(locationId, { kind = 'system', severity = 'info', title, body = null, refType = null, refId = null, actorName = null } = {}) {
  if (isMock || !supabase || !locationId || !title) return { ok: false };
  const { error } = await supabase.from('activity_events').insert({
    location_id: locationId, kind, severity, title, body,
    ref_type: refType, ref_id: refId ? String(refId) : null, actor_name: actorName,
  });
  if (error) { console.warn('[activity] log failed', error.message); return { ok: false, error: error.message }; }
  return { ok: true };
}

/** Most recent events for a location (newest first). */
export async function fetchRecentActivity(locationId, limit = 60) {
  if (isMock || !supabase || !locationId) return [];
  const { data, error } = await supabase.from('activity_events').select('*')
    .eq('location_id', locationId).order('created_at', { ascending: false }).limit(limit);
  if (error) { console.warn('[activity] fetch failed', error.message); return []; }
  return (data || []).map(rowToEvent);
}

/** Acknowledge an action item (clears it from "needs action"). */
export async function ackActivity(id, who = null) {
  if (isMock || !supabase || !id) return { ok: false };
  const { error } = await supabase.from('activity_events').update({ acked_at: new Date().toISOString(), acked_by: who }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
