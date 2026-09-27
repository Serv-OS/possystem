// boSessions.js: say so when Back Office is open twice on the same venue.
//
// Peter, 27 Sep 2026: "for some reason every products tax rate has been removed
// but they where there earlier". They were there for about a minute: Peter had
// two Back Office sessions open at Leeds. The bulk tax apply saved in one, and
// about 70 seconds later the other one, loaded before it, pressed Push to POS
// and wrote its own old copy of every product back. The writes are now guarded
// (every edit is a compare and set of the columns it changed, lib/menuWriters.js,
// and Push to POS writes no menu row at all), but a second tab still SHOWS stale
// products and can confuse whoever looks at it. So every Back Office tab of
// this browser announces its venue on a BroadcastChannel, and each tab shows a
// warning while another tab is open on the same venue.
//
// BroadcastChannel only reaches tabs of the same browser on the same device; a
// session on another computer is not seen (the write guards cover that case).
//
// Pure: the channel class is injected, so node:test proves it.

export const BO_SESSION_CHANNEL = 'rpos-bo-sessions';

const same = (a, b) => a != null && b != null && String(a) === String(b);

/** Is this message from ANOTHER Back Office tab on this venue? Returns 'open', 'closed' or null. */
export function otherSessionEvent(msg, { venue, tab }) {
  if (!msg || typeof msg !== 'object' || !msg.tab || same(msg.tab, tab) || !same(msg.venue, venue)) return null;
  if (msg.kind === 'hello' || msg.kind === 'here') return 'open';
  if (msg.kind === 'bye') return 'closed';
  return null;
}

/**
 * Watch for other Back Office tabs on `venue`. `onChange(n)` is told how many
 * other tabs are open on it whenever that changes. Returns stop(), which tells
 * the others this tab has gone. Does nothing (and stop is harmless) where the
 * browser has no BroadcastChannel.
 */
export function startBoSessionWatch({ venue, onChange, Channel = typeof BroadcastChannel === 'function' ? BroadcastChannel : null, tab = null } = {}) {
  if (!venue || typeof Channel !== 'function') return () => {};
  const me = tab || `bo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let ch;
  try { ch = new Channel(BO_SESSION_CHANNEL); } catch { return () => {}; }
  const others = new Set();
  const post = (kind) => { try { ch.postMessage({ kind, venue: String(venue), tab: me }); } catch { /* closed */ } };
  ch.onmessage = (e) => {
    const msg = e && e.data;
    const ev = otherSessionEvent(msg, { venue, tab: me });
    if (!ev) return;
    const before = others.size;
    if (ev === 'open') others.add(String(msg.tab));
    else others.delete(String(msg.tab));
    if (msg.kind === 'hello') post('here');
    if (others.size !== before && onChange) onChange(others.size);
  };
  post('hello');
  return () => {
    post('bye');
    try { ch.close(); } catch { /* already closed */ }
  };
}

/**
 * 27 Sep 2026 (final review of the stale tab fix): supabase-js raises an auth event for the
 * SAME sign in when any tab loads or comes to the front, and on every token refresh, each
 * with a fresh user object. Back Office resolves its venue in an effect keyed on the user
 * object, and that effect reads the venue key every tab shares, so another tab's venue
 * switch quietly moved this tab to that venue (a tax rate or discount saved here could then
 * move to the other venue). Keep the user object while it is the same person, so the venue
 * is resolved once per sign in per tab. A different person (or signing out) still changes it.
 */
export function sameAuthUser(prev, next) {
  return !!prev && !!next && prev.id === next.id && (prev.email || null) === (next.email || null);
}
