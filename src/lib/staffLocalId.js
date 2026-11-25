/**
 * staffLocalId.js: a team member added in Back Office, before and after the save answers.
 *
 * Peter, 25 Nov 2026, giving a new team member a Back Office login: "User created but linking
 * to staff member failed: invalid input syntax for type uuid: s-1795625033657".
 *
 * When a person is added the screen shows them at once, under a stand in id it makes itself
 * (`s-<time>`), and saves them in the background. The row's real id was never read back, so
 * until the page was reloaded the screen went on using the stand in. Anything done to that
 * person straight after adding them missed their row:
 *   a Back Office login was created and then linked to nobody (the error above)
 *   an edit was refused ("refresh the page")
 *   a remove took them off the screen and left them able to sign in on the till
 *
 * The save now reads the real id back and these helpers put it in the stand in's place.
 * Pure, import free, so node:test can load it (staffLocalId.test.js).
 */

/** True for an id the screen made itself: the person is not known to the database by it. */
export function isLocalStaffId(id) {
  return typeof id === 'string' && id.startsWith('s-');
}

/** The real id for an id a box may still be holding: the saved one when the stand in has been saved. */
export function resolveStaffId(id, savedIds) {
  if (!isLocalStaffId(id)) return id;
  const real = savedIds && typeof savedIds === 'object' ? savedIds[id] : null;
  return real || id;
}

/** The staff list with the stand in id replaced by the real one. Nothing else on the person changes. */
export function swapStaffId(staffMembers, localId, savedId) {
  const list = Array.isArray(staffMembers) ? staffMembers : [];
  if (!isLocalStaffId(localId) || !savedId) return list;
  return list.map(m => (m && m.id === localId ? { ...m, id: savedId } : m));
}

/** Said when something is asked of a person whose save has not answered yet. */
export const NOT_SAVED_YET = 'This team member is still being saved. Wait a moment and try again. If this message stays, reload the page.';
