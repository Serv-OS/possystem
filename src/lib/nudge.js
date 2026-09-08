// src/lib/nudge.js — manager → tills "nudge" for a stalled table.
// Now a first-class ACTIVITY EVENT (kind=nudge, severity=action): the Manager app logs it to
// activity_events; the tills pick it up over postgres_changes (lib/realtime.js) → toast + chime AND
// it sits in the activity feed until acknowledged. Reliable (no broadcast race), durable, one timeline.
import { logActivity } from './activity';

/** Ping the tills about a stalled table. payload: { table, covers, waitMins, by }. */
export async function sendNudge(locationId, payload = {}) {
  if (!locationId) return { ok: false, error: 'offline' };
  const bits = [payload.covers ? `${payload.covers} covers` : null, payload.waitMins ? `waiting ${payload.waitMins}m` : null].filter(Boolean).join(' · ');
  return logActivity(locationId, {
    kind: 'nudge', severity: 'action',
    title: `${payload.table || 'A table'} needs attention`,
    body: bits || null,
    refType: 'table', refId: payload.table || null,
    actorName: payload.by || null,
  });
}
