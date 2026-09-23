// supabase/functions/_shared/ezcaterScope.js
//
// WHOSE EZCATER CONNECTION IS THIS?
//
// 23 Sep 2026, live: Peter connected ezCater at Provo, then opened Back Office
// at Coffee Boy Barnsley Train Station, a different company entirely, and saw
// "Connected". Every venue on the platform did. The connection row carried no
// company, and the lookup fell back to "the single connected row" for any venue
// that had nothing mapped, which is every venue that is not Provo.
//
// Seeing it was the small part. Disconnect at any of those venues would have
// deleted Provo's connection, and ezCater cannot reissue that token. And
// "map caterer" upserted on the caterer id alone, so another company could have
// adopted Provo's caterer and received Provo's real orders.
//
// These three rules are the whole fix. They are pure so they can be tested from
// node, and the edge function does nothing with a connection they did not hand it.

/**
 * The connection a venue is allowed to see and act on.
 *
 * A connection belongs to ONE organisation (company_id = locations.org_id).
 * A venue gets its mapped caterer's connection only if that connection is in
 * its own organisation, otherwise its organisation's own connected row,
 * otherwise nothing. A row with no company belongs to nobody, so it is never
 * served: that is what let one company's connection appear everywhere.
 *
 * @param {{ orgId: string, mappedConnection?: object|null, orgConnection?: object|null }} f
 * @returns {object|null}
 */
export function chooseConnection({ orgId, mappedConnection = null, orgConnection = null }) {
  if (!orgId) return null;
  if (mappedConnection && mappedConnection.company_id === orgId) return mappedConnection;
  if (orgConnection && orgConnection.company_id === orgId) return orgConnection;
  return null;
}

/**
 * May this venue point this caterer at itself?
 *
 * Only a caterer that belongs to one of the organisation's own connections, and
 * only if nobody else has it: unmapped, or already mapped to this very venue.
 * A caterer mapped to another venue is never silently re-pointed, because the
 * orders would follow it.
 *
 * @param {{ caterer: object|null, orgConnectionIds: string[], opsLocationId: string }} f
 * @returns {{ ok: boolean, reason: string }}
 */
export function canAdoptCaterer({ caterer, orgConnectionIds = [], opsLocationId }) {
  if (!caterer) return { ok: false, reason: 'unknown caterer. Press Refresh list first so ezCater tells us about it.' };
  if (!caterer.connection_id || !orgConnectionIds.includes(caterer.connection_id)) {
    return { ok: false, reason: 'that caterer belongs to a different ezCater connection.' };
  }
  if (caterer.location_id && caterer.location_id !== opsLocationId) {
    return { ok: false, reason: 'that caterer is already mapped to another venue. Unmap it there first.' };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * The unmapped caterers a venue may be offered: only its own organisation's.
 *
 * @param {object[]} caterers
 * @param {string[]} orgConnectionIds
 */
export function visibleUnmapped(caterers, orgConnectionIds = []) {
  return (caterers || []).filter((c) => !c.location_id && c.connection_id && orgConnectionIds.includes(c.connection_id));
}
