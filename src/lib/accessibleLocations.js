// src/lib/accessibleLocations.js
//
// Which venues a login can reach, on the client, by the SAME rule as the database
// (public.user_accessible_locations(), migration 20260918d, lockdown step 1):
//   * a user_locations row for the venue; or
//   * a verified super admin, who reaches every venue.
// user_profiles.location_id is only the venue Back Office opens on. It is NEVER access: it was
// writable by the login itself, so honouring it let anyone become staff of any venue.
//
// PURE (no imports), so node tests load it directly.

/**
 * The accessible list for Back Office (location check at sign in, BackOfficeApp location
 * resolution). `junctionRows` are user_locations rows with an embedded `locations` row;
 * `profile` is the login's own user_profiles row with `role` and an embedded `locations` row.
 * For a super admin the opening venue is included too: he reaches every venue, and it is the
 * venue he last switched to (profile-admin set_active_location). For anyone else it is not.
 */
export function mergeAccessibleLocations(junctionRows, profile) {
  const byId = new Map();
  for (const r of junctionRows || []) {
    const l = r && r.locations;
    if (l && l.id) byId.set(l.id, { id: l.id, name: l.name, timezone: l.timezone, role: r.role });
  }
  const isSuperAdmin = profile && profile.role === 'super_admin';
  const own = profile && profile.locations;
  if (isSuperAdmin && own && own.id && !byId.has(own.id)) {
    byId.set(own.id, { id: own.id, name: own.name, timezone: own.timezone, role: 'super_admin' });
  }
  return Array.from(byId.values());
}

/** Admin portal: the logins with access to a venue (a user_locations row), never by profile venue. */
export function usersWithAccess(users, locationId) {
  return (users || []).filter((u) => (u && u.user_locations || []).some((ul) => ul && ul.location_id === locationId));
}
