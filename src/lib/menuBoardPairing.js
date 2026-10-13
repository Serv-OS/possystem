// src/lib/menuBoardPairing.js
//
// The rules a TV (menu board or order screen) follows to keep its pairing.
//
// 12 Oct 2026, WHY THIS FILE EXISTS. On the night of 11 to 12 Oct every Coffee Boy menu
// board but one dropped to the pairing code. The hosted realtime service sent ONE change
// with an error and no record. The realtime library hands that to the page as new = {}
// (an empty object, which is truthy). The page saved it as its screen, so the id and the
// board were gone, and one tick later it made itself a brand new unpaired row. The rules
// here are what stops that:
//   1. A live update is a hint, never the truth. It is used only when it has no errors,
//      the SAME id as the screen this TV holds, and every field the TV needs.
//   2. A TV never gives up its pairing on something it cannot check. A failed read, a read
//      with no sign in, or one empty answer is "unknown": keep the screen, try again.
//   3. Before it makes a new row, the TV looks for rows it already owns and uses one.
//   4. A saved screen with no id is never written.
//   5. (review, 12 Oct 2026) A TV whose sign in changed keeps its board AND gets a way out: it
//      makes one spare row under its new sign in and tells Back Office that row's code. See
//      decideStandby below.
//
// NO imports, so node:test can load it. Every function takes plain values and returns a
// plain value. runPairingTick talks to the outside only through the `io` it is given.

export const TICK_MS = 12000;
export const MISS_SPACING_MS = 10000;      // a "gone" answer counts at most once per 10 s
export const MISSES_TO_UNPAIR = 3;         // three spaced "gone" answers mean Back Office removed it
// 12 Oct 2026 (review), WHY HALF A TICK AND NOT 10 s. The gap is measured from when a tick
// STARTED (not from when its read came back), and the floor is half the 12 s tick. With a 10 s
// floor measured after the read, a read 2 s slower than the next one left under 10 s between two
// stamps, so every other tick sent no heartbeat (one per 24 s). "Last seen" is the one sign
// support has that a TV is alive. A burst (wake, online and the interval at once) still sends one.
export const HEARTBEAT_MIN_MS = 6000;
export const EARLY_READ_MIN_MS = 10000;    // a live update may ask for one early read per 10 s
export const EARLY_READ_DELAY_MS = 1000;
export const CREATE_TRIES = 3;
export const LIVE_FIELDS = ['id', 'code', 'board_id', 'order_display_id', 'location_id'];
export const NOTE_GAP_MS = { live_ignored: 3600000, adopted: 300000, unpaired: 300000, sign_in_changed: 86400000 };
export const NOTE_RETRY_MS = 60000;        // a note whose write failed is tried again a minute later,
export const NOTE_RETRY_MAX_MS = 3600000;  // then 2, 4, 8 minutes ... up to once an hour (a write that is refused for good must not be sent every minute for ever)
export const CODE_NOTE_FRESH_MS = 2 * 86400000;   // Back Office shows a "pair it again" code for 2 days after the TV last said it

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** Has a board or an order screen to show. */
export const hasAssignment = (s) => !!(s && (s.board_id || s.order_display_id));

/**
 * How good a database row is to this TV. 1 = paired (a venue AND a board or order screen),
 * 2 = idle (Back Office knows it, a venue but nothing to show), 3 = never claimed, 0 = not a row.
 * Status is NOT used: deleting a board leaves status 'paired' with no board.
 */
export function rowRank(row) {
  if (!row || typeof row !== 'object' || !isUuid(row.id)) return 0;
  if (row.location_id && hasAssignment(row)) return 1;
  if (row.location_id) return 2;
  return 3;
}

/** The screen the TV keeps (state and storage). null when the row has no usable id. */
export function screenFromRow(row) {
  if (!row || typeof row !== 'object' || !isUuid(row.id)) return null;
  return {
    id: row.id,
    code: typeof row.code === 'string' && row.code ? row.code : null,
    board_id: row.board_id || null,
    order_display_id: row.order_display_id || null,
    location_id: row.location_id || null,
    device_uid: row.device_uid || null,
  };
}

export function sameScreen(a, b) {
  if (!a || !b) return a === b;
  return a.id === b.id && a.code === b.code && a.board_id === b.board_id
    && a.order_display_id === b.order_display_id && a.location_id === b.location_id && a.device_uid === b.device_uid;
}

/**
 * Read the saved text of 'rpos-mbscreen'. broken = something was saved but it has no id
 * (what the 12 Oct fault left behind: {"board_id":null,"order_display_id":null}).
 */
export function readSavedScreen(text) {
  if (text == null || text === '') return { screen: null, broken: false };
  let v = null;
  try { v = JSON.parse(text); } catch { return { screen: null, broken: true }; }
  if (v == null) return { screen: null, broken: false };
  const screen = screenFromRow(v);
  return { screen, broken: !screen };
}

/**
 * Who a sign in token belongs to. ok = it names a real device user (the public key names nobody).
 *
 * 12 Oct 2026, WHY THE EXPIRY IS NOT JUDGED HERE. Every pairing request carries this token, so a
 * token that has run out is refused by the server with an error, and an error is "unknown, keep
 * the pairing". Judging it here would mean trusting the TV's own clock: a TV stick whose clock is
 * an hour fast would see every token as run out, never read its row, never heartbeat and never
 * get a pairing code. expMs is handed back for information only.
 */
export function readToken(token) {
  const none = { ok: false, uid: null, expMs: 0 };
  if (typeof token !== 'string') return none;
  const parts = token.split('.');
  // typeof guards the lookup: an old TV browser with no atob gives "no sign in", never a throw.
  if (parts.length !== 3 || typeof atob !== 'function') return none;
  let claims = null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
  } catch { return none; }
  if (!claims || !isUuid(claims.sub)) return none;
  return { ok: true, uid: claims.sub, expMs: typeof claims.exp === 'number' ? claims.exp * 1000 : 0 };
}

/** What to do with one realtime message about our row. */
export function decideLiveUpdate({ payload, screen }) {
  const ignore = (reason, detail = '') => ({ action: 'ignore', reason, detail });
  if (!payload || typeof payload !== 'object') return ignore('empty');
  const errs = payload.errors;
  if (errs != null && !(Array.isArray(errs) && errs.length === 0)) {
    return ignore('errors', String(Array.isArray(errs) ? errs[0] : errs).slice(0, 80));
  }
  const rec = payload.new;
  if (!rec || typeof rec !== 'object' || Object.keys(rec).length === 0) return ignore('empty');
  if (!screen || !isUuid(screen.id)) return ignore('no_screen_held');
  if (rec.id !== screen.id) return ignore('other_id');
  for (const f of LIVE_FIELDS) if (!(f in rec)) return ignore('missing_fields', f);
  if (typeof rec.code !== 'string' || !rec.code) return ignore('missing_fields', 'code');
  // Taking the board down needs the server's own word: ask for one read instead.
  if (hasAssignment(screen) && !hasAssignment(rec)) return { action: 'confirm', reason: 'unassign', detail: '' };
  return { action: 'apply', row: rec, reason: '', detail: '' };
}

/** First step of a tick. */
export function decideTickStart({ screen, who }) {
  if (!who || !who.ok) return { action: 'wait', reason: 'no_sign_in' };
  if (!screen || !isUuid(screen.id)) return { action: 'find_owned', why: 'no_id' };
  if (screen.device_uid && screen.device_uid !== who.uid) {
    // A new sign in cannot see the old row at all. A menu board can still draw its board
    // (boards are readable by any device), so it is kept. An order screen cannot work under
    // a new sign in, so it goes the removed way and ends on a code that can be paired.
    // The hold is not a dead end: see decideStandby. (To go back to "code after three misses"
    // for menu boards too, return count_miss here for both.)
    return screen.board_id ? { action: 'hold', reason: 'sign_in_changed' } : { action: 'count_miss', reason: 'sign_in_changed' };
  }
  return { action: 'read_row' };
}

/** The read of our own row by id. */
export function decideRowRead({ result, id }) {
  if (!result || result.error) return { action: 'wait', reason: 'read_failed' };
  const row = result.data;
  if (row == null) return { action: 'check_gone' };
  if (typeof row !== 'object' || row.id !== id) return { action: 'wait', reason: 'odd_answer' };
  return { action: 'found', row };
}

/**
 * The second opinion after an empty read: order_status_feed runs as the database owner, so
 * row level security cannot hide a row from it, and it says who is asking. Only
 * { paired: false, reason: 'no_screen' } means "signed in as you, and you own no such row".
 */
export function decideGoneCheck({ result }) {
  if (!result || result.error) return { verdict: 'unknown', reason: 'check_failed' };
  const d = result.data;
  if (!d || typeof d !== 'object') return { verdict: 'unknown', reason: 'odd_answer' };
  if (d.paired === false && d.reason === 'no_screen') return { verdict: 'gone', reason: 'no_screen' };
  if (d.paired === false && d.reason === 'no_session') return { verdict: 'unknown', reason: 'no_session' };
  return { verdict: 'unknown', reason: 'row_exists' };
}

/** One confirmed "gone" answer. unpair is true from the third spaced one. */
export function countMiss({ misses, lastMissAt, now }) {
  const had = Number(misses) || 0;
  if (had > 0 && now - lastMissAt < MISS_SPACING_MS) {
    return { misses: had, lastMissAt, counted: false, unpair: had >= MISSES_TO_UNPAIR };
  }
  const next = Math.min(had + 1, MISSES_TO_UNPAIR);
  return { misses: next, lastMissAt: now, counted: true, unpair: next >= MISSES_TO_UNPAIR };
}

/** Once per page load: a TV sitting on a row it made itself looks for a better one it owns. */
export function decideSelfHeal({ row, checked }) {
  if (checked) return { action: 'none' };
  return rowRank(row) === 3 ? { action: 'find_owned', why: 'self_heal' } : { action: 'none' };
}

const stamp = (v) => { const n = Date.parse(v); return Number.isFinite(n) ? n : 0; };

/** The best row this device owns: paired first (the most recently paired), then idle, then never claimed. */
export function pickOwnedRow(rows, uid) {
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => rowRank(r) > 0 && r.device_uid === uid);
  mine.sort((a, b) => (rowRank(a) - rowRank(b))
    || (rowRank(a) === 1 ? stamp(b.paired_at) - stamp(a.paired_at) : 0)
    || (stamp(b.last_seen_at) - stamp(a.last_seen_at))
    || (stamp(b.created_at) - stamp(a.created_at))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return mine[0] || null;
}

/** After reading the rows this device owns. why: 'no_id' | 'removed' | 'self_heal'. */
export function decideOwned({ result, uid, held, why }) {
  if (!result || result.error || !Array.isArray(result.data)) return { action: 'wait', reason: 'owned_read_failed' };
  const heldId = held && isUuid(held.id) ? held.id : null;
  if (why === 'removed' && heldId && result.data.some((r) => r && r.id === heldId && r.device_uid === uid)) {
    return { action: 'wait', reason: 'row_still_there' };
  }
  const best = pickOwnedRow(result.data, uid);
  if (why === 'self_heal') {
    return best && best.id !== heldId && rowRank(best) < 3 ? { action: 'adopt', row: best } : { action: 'stay' };
  }
  return best ? { action: 'adopt', row: best } : { action: 'create' };
}

/** One insert attempt. attempt counts from 1. Only a code collision (23505) is tried again. */
export function decideInsert({ result, attempt }) {
  if (result && !result.error && rowRank(result.data) > 0) return { action: 'made', row: result.data };
  if (result && result.error && result.error.code === '23505' && attempt < CREATE_TRIES) return { action: 'retry' };
  return { action: 'give_up' };
}

/**
 * A menu board whose sign in changed (the hold): what to do with the rows it owns under its NEW
 * sign in. rows = those rows, held = the screen it keeps showing.
 *
 * 12 Oct 2026 (review), WHY A STANDBY ROW. The first build held the board for ever and sent
 * nothing: Back Office could never change or remove that TV again, short of clearing the app on
 * the TV by hand. And a new sign in is not rare (Leeds, 28 Sep and 4 Oct). Now the TV keeps its
 * board AND makes ONE spare, unclaimed row under its new sign in, keeps that row seen, and tells
 * Back Office its code in a note. When someone pairs that code the TV moves to that row, which it
 * CAN read, and from then on Back Office can change it or remove it like any other TV.
 *
 * WHY "AT THIS VENUE" ONLY. The code is written where the venue's tills can read it, so it is not
 * the secret a code on the TV's own glass is. The TV therefore obeys a pairing of that code only
 * when it was made at the venue it was already paired to (Back Office can only pair to a venue the
 * login may use). A pairing made anywhere else is ignored and no second code is offered.
 *
 *   adopt   a row at this venue: Back Office paired the new code. Use it.
 *   none    no code can be offered (the code was used at another venue, or the venue is unknown)
 *   offer   an unclaimed row it already owns: that is the standby
 *   create  it owns nothing yet: make the standby (one per page load at most, the caller counts)
 */
export function decideStandby({ rows, uid, held }) {
  const venue = held && isUuid(held.location_id) ? held.location_id : null;
  if (!venue) return { action: 'none', reason: 'no_venue' };
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => rowRank(r) > 0 && r.device_uid === uid);
  const here = pickOwnedRow(mine.filter((r) => r.location_id === venue), uid);
  if (here) return { action: 'adopt', row: here };
  if (mine.some((r) => r.location_id)) return { action: 'none', reason: 'code_used_elsewhere' };
  const spare = pickOwnedRow(mine, uid);
  return spare ? { action: 'offer', row: spare } : { action: 'create' };
}

export const shouldHeartbeat = ({ now, lastAt }) => now - (Number(lastAt) || 0) >= HEARTBEAT_MIN_MS;
export const shouldReadEarly = ({ now, lastAt, pending }) => !pending && now - (Number(lastAt) || 0) >= EARLY_READ_MIN_MS;
export const shouldNote = ({ kind, now, lastAt }) => !!NOTE_GAP_MS[kind] && now - (Number(lastAt) || 0) >= NOTE_GAP_MS[kind];

/** The words Back Office shows for a note the TV left. */
export function noteText(kind, detail = '') {
  if (kind === 'live_ignored') return { title: 'TV kept its pairing', body: `It ignored a bad live update${detail ? ` (${detail})` : ''}. Nothing to do.` };
  if (kind === 'adopted') {
    return detail === 'new_code'
      ? { title: 'TV paired again', body: 'It was paired with its new code. Its old screen in this list can be removed.' }
      : { title: 'TV found its pairing again', body: 'It went back to the screen it was paired as. Nothing to do.' };
  }
  if (kind === 'unpaired') {
    return { title: 'TV shows its code', body: detail === 'sign_in_changed'
      ? 'It lost its sign in. Pair it again to use it.'
      : 'Its screen was removed in Back Office. Pair it again to use it.' };
  }
  if (kind === 'sign_in_changed') {
    // With a code (the standby row's): Back Office can pair the TV again from the desk.
    return detail
      ? { title: `TV lost its sign in. Pair it again with code ${detail}`, body: 'It still shows its board. To change it or remove it, pair it again first: type the code under Paired screens and pick a board.' }
      : { title: 'TV lost its sign in', body: 'It still shows its board. To change it, clear the app on the TV and pair it again.' };
  }
  return null;
}

const CODE_NOTE_RE = /^TV lost its sign in\. Pair it again with code ([A-Z0-9]{4}-[A-Z0-9]{4})$/;
/** The code a "lost its sign in" note carries in its title, or null. The reader of noteText above. */
export const noteCode = (title) => { const m = CODE_NOTE_RE.exec(typeof title === 'string' ? title : ''); return m ? m[1] : null; };

/** The limit a note is counted under. A new code is news, so each code has its own. */
export const noteSlot = (kind, detail) => (kind === 'sign_in_changed' && detail ? `${kind}:${detail}` : kind);

/**
 * The writer behind a TV's notes (menuBoardNotes.js gives it the real client and storage).
 * deps = { write(row) gives a promise of { error }, now(), load() gives { slot: ms }, save(obj), version }.
 * Returns stamp({ screen, kind, detail }) which answers 'sent', 'limited' or 'skipped' and never throws.
 *
 * 12 Oct 2026 (review), WHY THE LIMIT IS SET WHEN THE WRITE ANSWERS. It used to be set before the
 * insert was sent, with every outcome swallowed. A note written while the TV was offline was lost
 * and not tried again for the whole gap (an hour, or a day for "lost its sign in"), and that note
 * now carries the code Back Office needs. So: one insert at a time per kind, the limit starts only
 * when the insert worked, and a failed one is tried again a minute later (then 2, 4, 8 minutes,
 * up to once an hour, so a write the server refuses for good is not sent every minute for ever).
 */
export function makeNoteStamper({ write, now, load, save, version }) {
  const written = {};   // slot: when the last note was WRITTEN (kept here too, so blocked storage cannot switch the limit off)
  const failed = {};    // slot: { at, n } when the last try failed, and how many have failed in a row
  const flying = {};    // slot: true while an insert is on its way
  return function stamp({ screen, kind, detail = '' } = {}) {
    try {
      if (!screen || !isUuid(screen.id) || !isUuid(screen.location_id)) return 'skipped';   // a note needs the venue
      const words = noteText(kind, detail);
      if (!words) return 'skipped';
      const slot = noteSlot(kind, detail);
      const at = now();
      // The cheap checks first: this runs every tick while a TV holds.
      if (flying[slot] || !shouldNote({ kind, now: at, lastAt: written[slot] })) return 'limited';
      const f = failed[slot];
      if (f && at - f.at < Math.min(NOTE_RETRY_MS * 2 ** (f.n - 1), NOTE_RETRY_MAX_MS)) return 'limited';
      let stored = {};
      try { stored = load() || {}; } catch { stored = {}; }
      if (!shouldNote({ kind, now: at, lastAt: stored[slot] })) { written[slot] = Number(stored[slot]) || 0; return 'limited'; }
      flying[slot] = true;
      const done = (ok) => {
        flying[slot] = false;
        if (!ok) { failed[slot] = { at: now(), n: (failed[slot] ? failed[slot].n : 0) + 1 }; return; }
        written[slot] = at; delete failed[slot];
        try {
          const keep = {};
          for (const [k, v] of Object.entries(load() || {})) if (at - (Number(v) || 0) < CODE_NOTE_FRESH_MS) keep[k] = v;
          save({ ...keep, [slot]: at });
        } catch { /* storage blocked: the limit in memory still holds */ }
      };
      // Written ALREADY READ (acked_at set) and as 'info', so no till bell counts it or chimes.
      Promise.resolve(write({
        location_id: screen.location_id, kind: 'system', severity: 'info',
        title: words.title, body: `${words.body} (v${version})`,
        ref_type: 'menu_board_screen', ref_id: screen.id, actor_name: 'TV',
        acked_at: new Date(at).toISOString(), acked_by: 'auto',
      })).then((res) => done(!(res && res.error)), () => done(false));
      return 'sent';
    } catch { return 'skipped'; }   // a note must never break the TV
  };
}

/**
 * What Back Office shows from the notes TVs left. notes = { screen id: { title, body, at, code, codeAt } }
 * (newest note per screen, plus the newest "pair it again" code it said), screens = the screen rows
 * listed at this venue. Gives { byScreen: { id: { text, body } }, lost: [{ id, code, text, body }] }.
 *
 * A "pair it again" code is shown while it is open: said in the last 2 days (a held TV says it
 * again every day) and not yet the code of a screen in the list (then it was used). It wins over
 * a newer note of another kind, because it is the one thing someone has to do. "lost" is for a
 * TV whose old screen was already removed from the list: its code would otherwise be nowhere.
 */
export function screenNoteView({ notes, screens, now }) {
  const list = (Array.isArray(screens) ? screens : []).filter(Boolean);
  const ids = new Set(list.map((s) => s.id));
  const used = new Set(list.map((s) => s.code).filter(Boolean));
  const byScreen = {}; const lost = [];
  for (const [id, n] of Object.entries(notes || {})) {
    if (!n) continue;
    const open = n.code && !used.has(n.code) && now - stamp(n.codeAt) < CODE_NOTE_FRESH_MS ? n.code : null;
    const words = open ? noteText('sign_in_changed', open) : null;
    if (ids.has(id)) {
      if (open) byScreen[id] = { text: `${words.title} · ${agoLabel(n.codeAt, now)}`, body: words.body };
      else if (n.title && !noteCode(n.title)) byScreen[id] = { text: `${n.title} · ${agoLabel(n.at, now)}`, body: n.body || '' };
    } else if (open) {
      lost.push({ id, code: open, at: n.codeAt, text: `A ${words.title} · ${agoLabel(n.codeAt, now)}`, body: 'It still shows its board, and its old screen is no longer in this list. To change it, type the code above and pick a board.' });
    }
  }
  lost.sort((a, b) => stamp(b.at) - stamp(a.at) || (a.id < b.id ? -1 : 1));
  return { byScreen, lost };
}

/** "5m ago" for a note. */
export function agoLabel(iso, now) {
  const t = stamp(iso);
  if (!t) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** What the TV draws. Unchanged order from before 12 Oct 2026; only `screen` is now trustworthy. */
export function decideView({ pairing, screen, urlBoardId, hasData, resolving }) {
  if (pairing && screen && screen.order_display_id) return 'order_screen';
  if (pairing && !(urlBoardId || (screen && screen.board_id))) return 'pair';
  if (resolving && !hasData) return 'starting';
  if (!hasData) return 'loading';
  return 'board';
}

/**
 * Which of the board's content reads FAILED ('' when none did). Give it { name: result }.
 *
 * 12 Oct 2026, WHY. The same rule as the pairing, for what the board shows: a read that failed
 * says nothing about the menu, so the TV keeps the board it has. Before this a network drop
 * while a TV was running swapped the board (and its saved copy) for an empty one at the next
 * refresh. An empty answer with NO error is still an answer, and is used.
 */
export function failedBoardRead(reads) {
  for (const [name, res] of Object.entries(reads || {})) {
    if (!res || typeof res !== 'object' || res.error) return name;
  }
  return '';
}

/** What the TV remembers between ticks. Never saved. */
export function newPairingMemory(screen) {
  return { screen: screen || null, misses: 0, lastMissAt: 0, lastBeatAt: 0, healChecked: false, lastWait: '',
    // The hold only (sign in changed on a menu board): the spare row whose code Back Office can pair.
    standby: null, standbyMade: false, standbyOff: false };
}

/** A live update, applied to the memory. Returns { mem, action, reason, detail }. */
export function applyLiveUpdate(mem, payload) {
  const d = decideLiveUpdate({ payload, screen: mem.screen });
  if (d.action !== 'apply') return { mem, action: d.action, reason: d.reason, detail: d.detail };
  const s = screenFromRow(d.row);
  if (!s) return { mem, action: 'ignore', reason: 'empty', detail: '' };
  // A live record always carries device_uid; keep ours if this one somehow does not.
  const next = { ...s, device_uid: s.device_uid || mem.screen.device_uid || null };
  return { mem: { ...mem, screen: next }, action: 'apply', reason: '', detail: '', changed: !sameScreen(mem.screen, next) };
}

/** Stamp last_seen on a row, paced from when the tick started. Gives the new "last beat" time. */
function beat(lastBeatAt, id, io, token, at) {
  if (!shouldHeartbeat({ now: at, lastAt: lastBeatAt })) return lastBeatAt;
  io.heartbeat(id, token);
  return at;
}

function takeRow(mem, row, io, token, at) {
  const s = screenFromRow(row);
  if (!s) return mem;
  if (!sameScreen(mem.screen, s)) io.setScreen(s);
  io.subscribe(s.id);
  return { ...mem, screen: s, lastBeatAt: beat(mem.lastBeatAt, s.id, io, token, at) };
}

// Thrown inside a tick when the page has let go of it (io.alive() says no). Never leaves the tick.
const STOPPED = { name: 'Stopped' };

/**
 * One tick. io = { now, getToken, readRow(id, token), checkGone(id, token), readOwned(uid, token),
 * insertRow(token), heartbeat(id, token), subscribe(id), setScreen(screen), say(line), note(kind, detail, screen),
 * alive() (optional) }.
 * The reads and the insert resolve to { data, error }. They, and the heartbeat, MUST run as the token given.
 * Returns the next memory. Never throws: anything unexpected is "unknown, keep the pairing".
 *
 * 12 Oct 2026 (review), io.alive. When the page has let go of this tick (the effect was cleaned
 * up), the tick stops at its next answer: it sends nothing more, says nothing and hands back the
 * memory it was given. Before this a tick still in flight at clean up went on to insert a row,
 * while the new tick did the same: two rows for one new TV.
 */
export async function runPairingTick(mem, io) {
  let m = { ...mem };
  const at = io.now();                     // when this tick started: the heartbeat is paced from here
  const ask = async (p) => {
    const r = await p;
    if (typeof io.alive === 'function' && !io.alive()) throw STOPPED;
    return r;
  };
  // Said when the reason changes, not every tick. A TV with no screen has no pairing to keep.
  const wait = (reason) => {
    if (m.lastWait !== reason) {
      io.say(m.screen ? `[menuboard] cannot check this screen yet (${reason}). Pairing kept.`
        : `[menuboard] no screen yet (${reason}). Trying again.`);
    }
    return { ...m, lastWait: reason };
  };
  const makeRow = async (token) => {
    for (let attempt = 1; attempt <= CREATE_TRIES; attempt += 1) {
      const ins = decideInsert({ result: await ask(io.insertRow(token)), attempt });
      if (ins.action === 'made') return ins.row;
      if (ins.action === 'give_up') break;
    }
    return null;
  };
  // The hold: a menu board whose sign in changed. The board stays. See decideStandby for why
  // it keeps one spare row and what it does with it.
  const hold = async (token, who) => {
    const held = m.screen;
    if (!String(m.lastWait).startsWith('sign_in_changed')) io.say('[menuboard] sign in changed, this screen cannot be checked. Board kept.');
    m = { ...m, lastWait: 'sign_in_changed' };
    if (m.standbyOff) { io.note('sign_in_changed', '', held); return m; }
    const later = (reason) => {
      const w = `sign_in_changed_${reason}`;
      if (mem.lastWait !== w) io.say(`[menuboard] no new code for this TV yet (${reason}). Board kept.`);
      return { ...m, lastWait: w };
    };
    let rows = null;
    const sb = m.standby && m.standby.device_uid === who.uid ? m.standby : null;
    if (sb) {
      const read = decideRowRead({ result: await ask(io.readRow(sb.id, token)), id: sb.id });
      if (read.action === 'wait') return later(read.reason);
      if (read.action === 'found') rows = [read.row];
    }
    if (!rows) {
      // Rare: once per page load, or when the spare row is not there any more.
      const res = await ask(io.readOwned(who.uid, token));
      if (!res || res.error || !Array.isArray(res.data)) return later('owned_read_failed');
      rows = res.data;
    }
    const d = decideStandby({ rows, uid: who.uid, held });
    if (d.action === 'adopt') {
      m = takeRow({ ...m, standby: null, standbyMade: false, standbyOff: false, misses: 0, lastMissAt: 0, healChecked: true, lastWait: '' }, d.row, io, token, at);
      io.say(`[menuboard] the new code was paired in Back Office (${d.row.id.slice(0, 8)}). Using that screen.`);
      if (rowRank(d.row) === 1) io.note('adopted', 'new_code', m.screen);
      return m;
    }
    let row = d.action === 'offer' ? d.row : null;
    if (d.action === 'create' && !m.standbyMade) {
      row = await makeRow(token);
      if (!row) return later('create_failed');
      m = { ...m, standbyMade: true };
    }
    const spare = screenFromRow(row);
    if (!spare || !spare.code) {
      // Used at another venue, or the one row this page made is gone: offer no second code.
      io.say(`[menuboard] no new code for this TV (${d.reason || 'row_gone'}). Board kept.`);
      io.note('sign_in_changed', '', held);
      return { ...m, standby: null, standbyOff: true };
    }
    if (!sb || sb.id !== spare.id) io.say(`[menuboard] to change this TV, pair code ${spare.code} in Back Office.`);
    io.note('sign_in_changed', spare.code, held);
    return { ...m, standby: spare, lastBeatAt: beat(m.lastBeatAt, spare.id, io, token, at) };
  };
  try {
    const token = await ask(io.getToken());
    const who = readToken(token);
    const start = decideTickStart({ screen: m.screen, who });
    if (start.action === 'wait') return wait(start.reason);
    if (start.action === 'hold') return await hold(token, who);
    let why = start.action === 'find_owned' ? start.why : null;
    const cause = start.action === 'count_miss' ? start.reason : '';
    if (why === 'no_id') {
      // Said once. lastWait is left alone here: writing it made this line and the "no screen
      // yet" line take turns, two lines every tick, while the rows could not be read.
      if (!m.lastWait) io.say('[menuboard] no screen id saved. Looking for my own rows first.');
    } else {
      const id = m.screen.id;
      let gone = start.action === 'count_miss';
      if (!gone) {
        const read = decideRowRead({ result: await ask(io.readRow(id, token)), id });
        if (read.action === 'wait') return wait(read.reason);
        if (read.action === 'found') {
          m = takeRow({ ...m, misses: 0, lastMissAt: 0, lastWait: '' }, read.row, io, token, at);
          const heal = decideSelfHeal({ row: read.row, checked: m.healChecked });
          if (heal.action !== 'find_owned') return { ...m, healChecked: true };
          why = heal.why;
        } else {
          const chk = decideGoneCheck({ result: await ask(io.checkGone(id, token)) });
          if (chk.verdict !== 'gone') return wait(`not_confirmed_${chk.reason}`);
          gone = true;
        }
      }
      if (gone) {
        const c = countMiss({ misses: m.misses, lastMissAt: m.lastMissAt, now: io.now() });
        m = { ...m, misses: c.misses, lastMissAt: c.lastMissAt, lastWait: '' };
        if (c.counted) {
          io.say(cause ? `[menuboard] sign in changed, this screen cannot be read. Miss ${c.misses} of ${MISSES_TO_UNPAIR}.`
            : `[menuboard] the server says this screen is gone. Miss ${c.misses} of ${MISSES_TO_UNPAIR}.`);
        }
        if (!c.unpair) return m;
        why = 'removed';
      }
    }
    const before = m.screen;
    const owned = decideOwned({ result: await ask(io.readOwned(who.uid, token)), uid: who.uid, held: before, why });
    if (owned.action === 'wait') {
      if (owned.reason === 'row_still_there') m = { ...m, misses: 0, lastMissAt: 0 };
      return wait(owned.reason);
    }
    if (owned.action === 'stay') return { ...m, healChecked: true };
    const fresh = { ...m, misses: 0, lastMissAt: 0, healChecked: true, lastWait: '' };
    if (owned.action === 'adopt') {
      m = takeRow(fresh, owned.row, io, token, at);
      io.say(`[menuboard] found my own screen again (${owned.row.id.slice(0, 8)}). Using it.`);
      if (rowRank(owned.row) === 1) io.note('adopted', '', m.screen);
      else if (why === 'removed') io.note('unpaired', cause, before);
      return m;
    }
    const made = await makeRow(token);
    if (!made) return wait('create_failed');
    m = takeRow(fresh, made, io, token, at);
    if (why === 'removed') {
      io.say(cause ? '[menuboard] sign in changed and this screen cannot be used. Showing a new code.'
        : '[menuboard] screen removed in Back Office. Showing a new code.');
      io.note('unpaired', cause, before);
    }
    return m;
  } catch (e) {
    if (e === STOPPED) return mem;       // the page let go: nothing more is sent, said or changed
    // A timeout or a thrown client call. The name is enough to tell which (TimeoutError, TypeError).
    return wait(`error_${(e && e.name) || 'unknown'}`);
  }
}
