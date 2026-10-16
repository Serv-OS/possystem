// src/lib/bookings/requestAlerts.js
//
// When the host stand raises a booking request (17 Oct 2026, v5.11.73, PR 295 follow up "request
// alerts on every stand screen"). Pure, tested (requestAlerts.test.js); RequestsInbox.jsx runs it
// on every poll.
//
// The inbox used to sit in the Timeline screen's header, so its count and its button were only
// seen on that one screen. It now sits in the stand's top bar, on every screen, and a request
// that arrives stays marked New on the button until someone opens the inbox (the toast alone
// was gone after 6 seconds).

// One poll's answer against what the stand already knew.
//   seen     Set of request ids already known, or null before the first good load
//   unseen   Set of ids that arrived since the inbox was last opened
//   res      loadRequests() answer: { ok, rows } or { ok:false, error }
// Returns { seen, unseen, toast }: toast is the words to raise, or null.
// The first load raises nothing (the count shows what is waiting). A failed load changes
// nothing, so the next good one does not raise everything again.
export function requestAlert({ seen = null, unseen = new Set(), res } = {}) {
  if (!res?.ok) return { seen, unseen, toast: null };
  const rows = Array.isArray(res.rows) ? res.rows : [];
  const ids = new Set(rows.map((r) => r.id));
  const fresh = seen ? rows.filter((r) => !seen.has(r.id)) : [];
  // Answered or withdrawn requests stop being New.
  const nextUnseen = new Set([...unseen].filter((id) => ids.has(id)));
  for (const r of fresh) nextUnseen.add(r.id);
  let toast = null;
  if (fresh.length === 1) toast = `New booking request: ${fresh[0].name || 'a guest'}, party of ${fresh[0].party}`;
  else if (fresh.length > 1) toast = `${fresh.length} new booking requests`;
  return { seen: ids, unseen: nextUnseen, toast };
}
