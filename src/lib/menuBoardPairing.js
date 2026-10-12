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
//
// NO imports, so node:test can load it. Every function takes plain values and returns a
// plain value. runPairingTick talks to the outside only through the `io` it is given.

export const TICK_MS = 12000;
export const MISS_SPACING_MS = 10000;      // a "gone" answer counts at most once per 10 s
export const MISSES_TO_UNPAIR = 3;         // three spaced "gone" answers mean Back Office removed it
export const HEARTBEAT_MIN_MS = 10000;     // never stamp last_seen more often than this
export const EARLY_READ_MIN_MS = 10000;    // a live update may ask for one early read per 10 s
export const EARLY_READ_DELAY_MS = 1000;
export const CREATE_TRIES = 3;
export const LIVE_FIELDS = ['id', 'code', 'board_id', 'order_display_id', 'location_id'];
export const NOTE_GAP_MS = { live_ignored: 3600000, adopted: 300000, unpaired: 300000, sign_in_changed: 86400000 };

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

export const shouldHeartbeat = ({ now, lastAt }) => now - (Number(lastAt) || 0) >= HEARTBEAT_MIN_MS;
export const shouldReadEarly = ({ now, lastAt, pending }) => !pending && now - (Number(lastAt) || 0) >= EARLY_READ_MIN_MS;
export const shouldNote = ({ kind, now, lastAt }) => !!NOTE_GAP_MS[kind] && now - (Number(lastAt) || 0) >= NOTE_GAP_MS[kind];

/** The words Back Office shows for a note the TV left. */
export function noteText(kind, detail = '') {
  if (kind === 'live_ignored') return { title: 'TV kept its pairing', body: `It ignored a bad live update${detail ? ` (${detail})` : ''}. Nothing to do.` };
  if (kind === 'adopted') return { title: 'TV found its pairing again', body: 'It went back to the screen it was paired as. Nothing to do.' };
  if (kind === 'unpaired') {
    return { title: 'TV shows its code', body: detail === 'sign_in_changed'
      ? 'It lost its sign in. Pair it again to use it.'
      : 'Its screen was removed in Back Office. Pair it again to use it.' };
  }
  if (kind === 'sign_in_changed') return { title: 'TV lost its sign in', body: 'It still shows its board. To change it, clear the app on the TV and pair it again.' };
  return null;
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
  return { screen: screen || null, misses: 0, lastMissAt: 0, lastBeatAt: 0, healChecked: false, lastWait: '' };
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

function takeRow(mem, row, io, token) {
  const s = screenFromRow(row);
  if (!s) return mem;
  if (!sameScreen(mem.screen, s)) io.setScreen(s);
  io.subscribe(s.id);
  const now = io.now();
  let lastBeatAt = mem.lastBeatAt;
  if (shouldHeartbeat({ now, lastAt: lastBeatAt })) { io.heartbeat(s.id, token); lastBeatAt = now; }
  return { ...mem, screen: s, lastBeatAt };
}

/**
 * One tick. io = { now, getToken, readRow(id, token), checkGone(id, token), readOwned(uid, token),
 * insertRow(token), heartbeat(id, token), subscribe(id), setScreen(screen), say(line), note(kind, detail, screen) }.
 * The reads and the insert resolve to { data, error }. They, and the heartbeat, MUST run as the token given.
 * Returns the next memory. Never throws: anything unexpected is "unknown, keep the pairing".
 */
export async function runPairingTick(mem, io) {
  let m = { ...mem };
  const wait = (reason) => {
    if (m.lastWait !== reason) io.say(`[menuboard] cannot check this screen yet (${reason}). Pairing kept.`);
    return { ...m, lastWait: reason };
  };
  try {
    const token = await io.getToken();
    const who = readToken(token);
    const start = decideTickStart({ screen: m.screen, who });
    if (start.action === 'wait') return wait(start.reason);
    if (start.action === 'hold') {
      if (m.lastWait !== start.reason) io.say('[menuboard] sign in changed, this screen cannot be checked. Board kept.');
      io.note('sign_in_changed', '', m.screen);
      return { ...m, lastWait: start.reason };
    }
    let why = start.action === 'find_owned' ? start.why : null;
    const cause = start.action === 'count_miss' ? start.reason : '';
    if (why === 'no_id') {
      if (m.lastWait !== 'no_id') io.say('[menuboard] no screen id saved. Looking for my own rows first.');
      m.lastWait = 'no_id';
    } else {
      const id = m.screen.id;
      let gone = start.action === 'count_miss';
      if (!gone) {
        const read = decideRowRead({ result: await io.readRow(id, token), id });
        if (read.action === 'wait') return wait(read.reason);
        if (read.action === 'found') {
          m = takeRow({ ...m, misses: 0, lastMissAt: 0, lastWait: '' }, read.row, io, token);
          const heal = decideSelfHeal({ row: read.row, checked: m.healChecked });
          if (heal.action !== 'find_owned') return { ...m, healChecked: true };
          why = heal.why;
        } else {
          const chk = decideGoneCheck({ result: await io.checkGone(id, token) });
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
    const owned = decideOwned({ result: await io.readOwned(who.uid, token), uid: who.uid, held: before, why });
    if (owned.action === 'wait') {
      if (owned.reason === 'row_still_there') m = { ...m, misses: 0, lastMissAt: 0 };
      return wait(owned.reason);
    }
    if (owned.action === 'stay') return { ...m, healChecked: true };
    const fresh = { ...m, misses: 0, lastMissAt: 0, healChecked: true, lastWait: '' };
    if (owned.action === 'adopt') {
      m = takeRow(fresh, owned.row, io, token);
      io.say(`[menuboard] found my own screen again (${owned.row.id.slice(0, 8)}). Using it.`);
      if (rowRank(owned.row) === 1) io.note('adopted', '', m.screen);
      else if (why === 'removed') io.note('unpaired', cause, before);
      return m;
    }
    for (let attempt = 1; attempt <= CREATE_TRIES; attempt += 1) {
      const ins = decideInsert({ result: await io.insertRow(token), attempt });
      if (ins.action === 'made') {
        m = takeRow(fresh, ins.row, io, token);
        if (why === 'removed') {
          io.say(cause ? '[menuboard] sign in changed and this screen cannot be used. Showing a new code.'
            : '[menuboard] screen removed in Back Office. Showing a new code.');
          io.note('unpaired', cause, before);
        }
        return m;
      }
      if (ins.action === 'give_up') break;
    }
    return wait('create_failed');
  } catch (e) {
    // A timeout or a thrown client call. The name is enough to tell which (TimeoutError, TypeError).
    return wait(`error_${(e && e.name) || 'unknown'}`);
  }
}
