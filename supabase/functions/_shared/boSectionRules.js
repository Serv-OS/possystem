// Back Office section access: the rules the browser AND the create-user function share.
//
// 8 Oct 2026 (Peter: "when we invite someone to the back office we need to be able to limit what
// they can see via each tab. MO is a franchisee, we want him to be able to login to the back
// office. But he cannot mess with menus, inventory, produce etc. We only want to give him access
// to workforce, reports, team and customers, nothing else.")
//
// THIS IS A SCREEN LOCK, NOT A DATABASE LOCK. It decides which parts of Back Office a login is
// shown. It does not change what the database lets that login read or write: that is still the
// venue fence (user_locations), exactly as before. Do not describe it as more than that.
//
// One list of keys, used by three places that must agree:
//   * here (the browser through src/lib/boSections.js, and create-user through this file),
//   * the CHECK on user_profiles.bo_sections,
//   * the list inside public.set_bo_sections()
//     (both in supabase/migrations/20261008a_OPS_bo_sections.sql).
// src/lib/boSections.test.js fails if any of them differs.
//
// Pure: no Deno, no React, no Supabase. Imported by the edge function and by the web app.

/** The 15 top level parts of Back Office, in sidebar order. A key never changes once it ships. */
export const BO_SECTION_KEYS = Object.freeze([
  'overview', 'menu', 'floorplan', 'inventory', 'produce', 'purchasing', 'operations', 'team',
  'workforce', 'customers', 'channels', 'hardware', 'reports', 'card-payments', 'settings',
]);

/** Roles that always open everything. A list of sections is ignored for them and never set on them. */
export const EVERYTHING_ROLES = Object.freeze(['owner', 'super_admin']);

export function isEverythingRole(role) {
  return EVERYTHING_ROLES.includes(String(role || '').toLowerCase());
}

/**
 * A list somebody sent, checked. null or undefined means "everything".
 *   { ok: true,  sections: null }            everything
 *   { ok: true,  sections: ['team', ...] }   only these, in sidebar order, no repeats
 *   { ok: false, unknown: ['menus'] }        a key that is not one of the 15, or not a list at all
 * Never guesses: a wrong key is an error, not something to drop quietly.
 */
export function checkSections(input) {
  if (input === null || input === undefined) return { ok: true, sections: null };
  if (!Array.isArray(input)) return { ok: false, unknown: [String(input)] };
  const unknown = input.filter((k) => typeof k !== 'string' || !BO_SECTION_KEYS.includes(k)).map((k) => String(k));
  if (unknown.length) return { ok: false, unknown };
  return { ok: true, sections: BO_SECTION_KEYS.filter((k) => input.includes(k)) };
}

/**
 * What is stored on a login, as read back. Fails closed: null is everything, a list is that list
 * with anything unknown dropped, and ANYTHING else (missing, a string, an object) is nothing.
 */
export function storedSections(value) {
  if (value === null) return null;
  if (!Array.isArray(value)) return [];
  return BO_SECTION_KEYS.filter((k) => value.includes(k));
}

/**
 * The sections a login may open: null = everything, else a list (which may be empty).
 * profile = { role, sections }. Owners and ServOS staff always get everything. Nothing known
 * about the login (no profile) is nothing open, never everything.
 */
export function allowedKeys(profile) {
  if (!profile || typeof profile !== 'object') return [];
  if (isEverythingRole(profile.role)) return null;
  return storedSections(profile.sections);
}

/**
 * Decision 7: a login made by a limited person can never open more than that person can.
 *   callerSections null (the creator opens everything): the new login gets what was asked for.
 *   callerSections a list: asked for nothing in particular = exactly the creator's list;
 *                          asked for a list = only the part of it the creator has too.
 * Only null means "everything" for the creator. A missing or broken value there is nothing, so
 * a mistake in the caller can only ever narrow the new login.
 */
export function capSections(requested, callerSections) {
  const cap = callerSections === null ? null : storedSections(callerSections);
  const want = requested === null || requested === undefined ? null : storedSections(requested);
  if (cap === null) return want;
  if (want === null) return [...cap];
  return cap.filter((k) => want.includes(k));
}

/**
 * True when `sections` opens nothing that `cap` does not. null = everything on either side.
 * An unknown value (undefined, not a list) is never "within": the caller must know what landed.
 */
export function withinSections(sections, cap) {
  if (sections !== null && !Array.isArray(sections)) return false;
  if (cap === null) return true;
  if (sections === null) return false;
  const capList = storedSections(cap);
  return storedSections(sections).every((k) => capList.includes(k));
}

/** Two stored values mean the same thing. An unknown value equals nothing, itself included. */
export function sameSections(a, b) {
  const known = (v) => v === null || Array.isArray(v);
  if (!known(a) || !known(b)) return false;
  if (a === null || b === null) return a === b;
  const x = storedSections(a);
  const y = storedSections(b);
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/**
 * PostgREST and Postgres wording for "the bo_sections column is not there yet" (the migration
 * has not run on this database). Only this means "not installed". Any other error is a failure.
 */
export function isSectionsColumnMissing(error) {
  if (!error) return false;
  const msg = `${error.code || ''} ${error.message || ''} ${error.details || ''}`;
  if (!msg.includes('bo_sections')) return false;
  return /PGRST204|42703/.test(msg) || /column .* does not exist|could not find the .* column/i.test(msg);
}

/**
 * create-user: the list a login made (or linked) by this call should have.
 *   asked           what the request sent as `sections`: undefined (nothing), null, or a list
 *   callerSections  what the CALLER may open: null = everything, else their own list
 *   role            the role the login will have after this call
 * Answers { ok: true, sections } (null = everything) or { ok: false, status, error }.
 *   * a key that is not one of the 15 is refused, before anything is created;
 *   * an owner (or ServOS staff) always opens everything: a list is never put on one;
 *   * decision 7: never more than the caller (capSections). A limited caller who asks for
 *     nothing in particular passes on exactly their own list;
 *   * a limited caller who asks only for parts they do not have gets a refusal, not a login
 *     that opens nothing.
 */
export function planLoginSections({ asked, callerSections, role } = {}) {
  const check = checkSections(asked);
  if (!check.ok) {
    return { ok: false, status: 400, error: `Unknown part of Back Office: ${check.unknown.join(', ')}` };
  }
  if (isEverythingRole(role)) return { ok: true, sections: null };
  const sections = capSections(check.sections, callerSections);
  if (callerSections !== null && sections.length === 0 && check.sections !== null && check.sections.length > 0) {
    return { ok: false, status: 403, error: 'You can only give the parts of Back Office you can open yourself.' };
  }
  return { ok: true, sections };
}

/**
 * A list as it came back in an answer (from create-user, set_bo_sections, or a read of somebody
 * else's row): null = everything, a list = that list, and anything else is UNKNOWN (undefined).
 * Unknown is never shown as "everything" and never counts as "limited".
 */
export function sectionsFromAnswer(value) {
  if (value === null) return null;
  return Array.isArray(value) ? storedSections(value) : undefined;
}
