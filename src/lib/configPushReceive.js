// configPushReceive.js: get the menu snapshot of a Push to POS, however it arrives (30 Sep 2026).
//
// Coffee Boy Barnsley, Peter: "we are clicking push to pos but the sync POS isn't coming up" and
// "they work if you close the APP". Supabase Realtime sends a row of at most 1 MB. Over that it
// still sends the INSERT but drops every large column, so push.snapshot arrived empty and the till
// quietly did nothing. Barnsley, Huddersfield and Preston menus passed 1 MB on 29 Sep; Leeds is
// close. A restart worked because boot reads the push over the normal API, which has no such limit.
// So: use the snapshot when it came with the event, otherwise read the row by its id.

/**
 * The push's snapshot: from the event if it is there, else read by id with fetchById(id) → snapshot.
 * Resolves null when there is none (a failed read, or a push that genuinely has no snapshot).
 */
export async function resolvePushSnapshot(push, fetchById) {
  if (!push) return null;
  if (push.snapshot && typeof push.snapshot === 'object') return push.snapshot;
  if (!push.id || typeof fetchById !== 'function') return null;
  try {
    const snap = await fetchById(push.id);
    return snap && typeof snap === 'object' ? snap : null;
  } catch {
    return null;
  }
}

/** Order guard: true when this push is not older than the newest one already taken (by created_at). */
export function isNewerPush(push, lastAtMs) {
  const at = Date.parse(push?.created_at || '');
  if (!Number.isFinite(at)) return true;           // no timestamp: never block a push
  return !(Number.isFinite(lastAtMs) && at < lastAtMs);
}
