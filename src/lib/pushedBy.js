// src/lib/pushedBy.js: the name a Push to POS is stamped with.
//
// 27 Sep 2026. Peter: "I archived choc babychino but its still on the menu board". Every push
// said "Manager", so nobody could tell which of two Back Office windows had pushed. But the
// name goes into config_pushes.pushed_by and snapshot.pushedBy, and config_pushes can be read
// with the PUBLIC key (online ordering, the kiosk and the booking page read it), so it must never
// be an email address: a person's display name, a staff name, or "Manager". Pure.

const looksLikeEmail = (s) => /@/.test(s);

/** The first usable display name among the candidates; never an email; else "Manager". */
export function pushedByName(...candidates) {
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const s = c.trim();
    if (!s || looksLikeEmail(s)) continue;
    return s.slice(0, 80);
  }
  return 'Manager';
}
