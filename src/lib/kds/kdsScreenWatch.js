// src/lib/kds/kdsScreenWatch.js
//
// 12 Oct 2026, Coffee Boy Barnsley (K6): the drinks screen stopped showing orders for half an hour
// and nothing told the till. Staff found out from customers, pressed Test KDS five times ("Test
// ticket sent" every time) and one order was rung twice.
//
// The rule: a till watches the kitchen screens of its venue. It says so, with a sound, when a
// screen has orders waiting and
//   silent  the screen has not been heard from for 2 minutes (and no other live screen shows
//           those orders), or
//   stuck   its oldest order has waited past that screen's late time plus 5 minutes and nothing
//           has been bumped there in that time. Built, tested and SWITCHED OFF (STUCK_RULE below).
// The sound repeats every 5 minutes while it lasts, three times at most for the same orders, and
// OK stops it until a new order is sent to that screen. A line says when the screen is back.
// Never outside trading hours, never with nothing waiting.
//
// Local first: the orders waiting come from the till's own list (store kdsTickets). The screens'
// last heartbeat is ONE small read of the venue's devices rows, once a minute, only while an order
// has waited over 2 minutes. Before a sound, the oldest waiting orders are checked once against
// the database, so a till whose own list is behind never raises a false alarm.
//
// No React, no Supabase, no timers: the two reads are handed in (watchLook). The till wiring is
// components/KdsScreenAlert.jsx and the status drawer (components/StatusDrawer.jsx).

export const WATCH_TICK_MS = 60 * 1000;
export const SILENT_MS = 2 * 60 * 1000;
/** An order counts once it has waited this long (a new order on a healthy screen never arms the watch). */
export const MIN_WAIT_MS = 2 * 60 * 1000;
/** Older than this is a leftover, not an order waiting (12 Oct 2026: the live database held 423 pending tickets over a day old). */
export const MAX_WAIT_MS = 3 * 60 * 60 * 1000;
export const STUCK_EXTRA_MIN = 5;
/**
 * The switch for the "stuck" rule (a screen that is heard from but bumps nothing). OFF.
 * 12 Oct 2026, review: replayed minute by minute on the real rows of 39 normal venue days (5 to
 * 12 Oct, five Coffee Boy venues, every screen beating, the Barnsley incident day left out) this
 * rule alone chimed on 25 of the 39 days, 275 chimes per counter till, with a red bar up for
 * 1,238 minutes: an order nobody bumped at a quiet station, or cards left at closing time. Staff
 * would learn to ignore the bar, and the "silent" rule, which is what would have caught 12 Oct
 * (at about 14:47), would be ignored with it. The builder's own count agreed (81 of 9,373 tickets
 * on 24 of 40 days). With a flat wait of 45 minutes it is still 11 tickets on 6 of 40 days.
 * The rule and its tests stay (they pass stuckRule: true). To switch it on: make this true, and
 * raise STUCK_EXTRA_MIN to 30 first. That is the owner's call.
 */
export const STUCK_RULE = false;
export const DEFAULT_LATE_MIN = 15;
export const REPEAT_MS = 5 * 60 * 1000;
export const BACK_LINE_MS = 20 * 1000;
export const TRADING_MARGIN_MS = 30 * 60 * 1000;
export const CONFIRM_MAX_IDS = 20;
/**
 * At most this many chimes for the same waiting orders. 12 Oct 2026, review: nothing on the till
 * could stop the chime. Staff switch the kitchen tablet off at closing with the last card not
 * bumped (4 of 45 venue days), the till stays on, and it chimed every 5 minutes for 3 hours,
 * 36 times. A new order sent to that screen starts the count again.
 */
export const MAX_CHIMES = 3;
/**
 * A kitchen screen row not heard from for this long, or never, is a leftover (a tablet that was
 * replaced, a test screen), not a screen staff rely on: never an alarm. 12 Oct 2026, review: 3 of
 * the 16 live kitchen screen rows had been silent for over a week, and each would have raised
 * "is not showing orders" with a chime whenever an order of its station waited two minutes.
 */
export const STALE_SCREEN_MS = 7 * 24 * 60 * 60 * 1000;
/** How many "the database says it is no longer waiting" ids a till remembers. The oldest are forgotten first. */
export const GONE_KEEP = 500;
/**
 * How long the till trusts what READ 1 told it about stations with no kitchen screen (a venue or
 * a station that only prints, so its tickets are never bumped and always "wait"). While every
 * waiting order is at such a station the devices rows are not read again.
 */
export const NO_SCREEN_RECHECK_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const ms = (v) => (v == null || v === '' ? NaN : typeof v === 'number' ? v : new Date(v).getTime());
// The till holds two shapes: database rows (centre_id, sent_at) and its own sent tickets (centreId, sentAt).
const centreOf = (t) => (t.centre_id != null ? t.centre_id : (t.centreId || null));
const sentOf = (t) => ms(t.sent_at != null ? t.sent_at : t.sentAt);
const isPending = (t) => (t.status || 'pending') === 'pending';

/** Only a counter till watches: never a kitchen screen, a kiosk, a handheld or a clock. */
export function watchRunsOn({ type, defaultSurface } = {}) {
  return type === 'pos' && defaultSurface !== 'kds' && defaultSurface !== 'kiosk';
}

/**
 * The orders waiting, from the till's own list, oldest first.
 *   skip  Set of ids the database said are no longer waiting
 */
export function waitingTickets(tickets, { now, dayStartMs = 0, skip = null } = {}) {
  const out = [];
  for (const t of tickets || []) {
    if (!t || !t.id || (skip && skip.has(t.id))) continue;
    if (!isPending(t)) continue;
    const sentAt = sentOf(t);
    if (!Number.isFinite(sentAt) || sentAt < dayStartMs) continue;
    const waited = now - sentAt;
    if (waited < MIN_WAIT_MS || waited > MAX_WAIT_MS) continue;
    out.push({ id: t.id, centreId: centreOf(t), sentAt });
  }
  return out.sort((a, b) => a.sentAt - b.sentAt);
}

/**
 * The stations ('' for none) where a ticket left the till's waiting list between two copies of
 * the list: it is gone from the list (bumped) or no longer pending (held). That is the till's
 * own proof that somebody is working that screen.
 */
export function leftWaiting(before, after) {
  const still = new Map();
  for (const t of after || []) if (t && t.id) still.set(t.id, isPending(t));
  const out = new Set();
  for (const t of before || []) {
    if (!t || !t.id) continue;
    const here = still.get(t.id);                       // undefined: gone. true: pending. false: not pending.
    if (here === undefined || (here === false && isPending(t))) out.add(centreOf(t) || '');
  }
  return [...out];
}

/**
 * Trading: no opening hours set, or open now, or open half an hour either side of now.
 * "No hours set" includes a week with no opening time on any day. 12 Oct 2026, review: Back Office
 * stores exactly that ({ weekly: { sun: [], mon: [], ... } }) the first time the Location page is
 * saved for any reason, and it reads as shut at every hour, so the till would never have raised an
 * alarm at such a venue. The kiosk treats that shape as "not set" too (surfaces/KioskSurface.jsx).
 */
export function isTrading({ openingHours, timeZone, now, isOpenNow } = {}) {
  const weekly = openingHours && openingHours.weekly;
  const hoursSet = !!weekly && typeof weekly === 'object' && Object.values(weekly).some((day) => Array.isArray(day) && day.length > 0);
  if (!hoursSet || typeof isOpenNow !== 'function') return true;
  const open = (t) => { try { return !!isOpenNow(openingHours, timeZone, new Date(t)).open; } catch { return true; } };
  return open(now) || open(now - TRADING_MARGIN_MS) || open(now + TRADING_MARGIN_MS);
}

/** The kitchen screens of the venue, from its devices rows. */
export function screensFrom(devices) {
  return (devices || []).filter((d) => d && d.type === 'kds' && (d.status === 'active' || d.status === 'online'))
    .map((d) => {
      let s = d.kds_settings;
      if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
      const late = Number(s && s.late);
      return { id: d.id, name: d.name || 'Kitchen screen', centreId: d.centre_id || null, lastSeenMs: ms(d.last_seen), lateMin: Number.isFinite(late) && late > 0 ? late : DEFAULT_LATE_MIN };
    });
}

/**
 * The server's clock, near enough: the newest heartbeat of ANY device at the venue (this till
 * beats once a minute itself). Heartbeats are compared with each other, never with the till's own
 * clock, so a till with a wrong clock cannot call a healthy screen silent.
 */
export function serverNowFrom(devices) {
  let best = NaN;
  for (const d of devices || []) { const t = ms(d && d.last_seen); if (Number.isFinite(t) && !(t <= best)) best = t; }
  return Number.isFinite(best) ? best : null;
}

/** When the till last saw a ticket leave the list at a screen's station. A screen with no station shows every ticket. */
function lastBumpAt(bumpSeenAt, centreId) {
  if (!bumpSeenAt) return 0;
  if (centreId) return bumpSeenAt.get(centreId) || 0;
  let best = 0;
  for (const v of bumpSeenAt.values()) if (v > best) best = v;
  return best;
}

/**
 * Which screens are in trouble now.
 *   bumpSeenAt     Map station id ('' for none) to when the till last saw a ticket of that station leave its list
 *   watchingSince  when this till started watching (a till that just started has seen no bump yet)
 *   stuckRule      false leaves the "stuck" rule out (STUCK_RULE when not given)
 * Returns [{ screenId, name, centreId, reason: 'silent' | 'stuck', count, oldestWaitMs, newestSentAt, silentMs, noBumpMs, ids }].
 *
 * 12 Oct 2026, review, two rules for "silent" (each one a false alarm on live rows):
 *   a row not heard from for a week, or never, is a leftover and is not judged (STALE_SCREEN_MS);
 *   an order that ANOTHER live screen also shows (the same station, or a screen with no station)
 *   is not stranded, so a second tablet used only at peak, switched off, raises nothing while the
 *   first one is working.
 */
export function watchProblems({ screens, waiting, serverNow, bumpSeenAt, watchingSince, now, stuckRule = STUCK_RULE } = {}) {
  const out = [];
  const known = serverNow !== null && serverNow !== undefined;
  const live = (s) => known && Number.isFinite(s.lastSeenMs) && serverNow - s.lastSeenMs < SILENT_MS;
  const shows = (s, w) => !s.centreId || w.centreId === s.centreId;
  for (const s of screens || []) {
    const mine = (waiting || []).filter((w) => shows(s, w));
    if (!mine.length) continue;
    // Heard from, but no clock to compare with: cannot tell, so not silent.
    const silentMs = Number.isFinite(s.lastSeenMs) ? (known ? Math.max(0, serverNow - s.lastSeenMs) : 0) : Infinity;
    const lastBump = Math.max(lastBumpAt(bumpSeenAt, s.centreId), watchingSince || 0);
    const about = (list) => {
      const oldestWaitMs = now - list[0].sentAt;
      return {
        screenId: s.id, name: s.name, centreId: s.centreId, count: list.length, oldestWaitMs, newestSentAt: list[list.length - 1].sentAt,
        silentMs, noBumpMs: Math.min(Math.max(0, now - lastBump), oldestWaitMs), ids: list.map((w) => w.id),
      };
    };
    if (silentMs >= SILENT_MS) {
      if (silentMs >= STALE_SCREEN_MS) continue;
      const stranded = mine.filter((w) => !(screens || []).some((o) => o.id !== s.id && live(o) && shows(o, w)));
      if (stranded.length) out.push({ ...about(stranded), reason: 'silent' });
      continue;
    }
    const limit = (s.lateMin + STUCK_EXTRA_MIN) * 60000;
    if (stuckRule && now - mine[0].sentAt >= limit && now - lastBump >= limit) out.push({ ...about(mine), reason: 'stuck' });
  }
  return out;
}

/**
 * Is a chime due for this problem now? The database check runs only then.
 *   new trouble                              yes
 *   OK was tapped                            no, until a NEW order has been sent to that screen
 *   said MAX_CHIMES times for the same orders  no, until a NEW order has been sent to that screen
 *   otherwise                                5 minutes after the last one
 * A screen that came back and went again is new trouble (its alert was taken down in between).
 */
function chimeDue(was, p, now) {
  if (!was) return true;
  const fresh = (p.newestSentAt || 0) > (was.newestSentAt || 0);
  if (!fresh && (was.acked || (was.sounds || 0) >= MAX_CHIMES)) return false;
  return now - was.lastSoundAt >= REPEAT_MS;
}
export const soundDue = (prev, p, now) => chimeDue(prev && prev[p.screenId], p, now);

/**
 * After the database was asked about one screen's oldest waiting orders.
 *   waiting  the till's waiting list (waitingTickets)
 *   ids      every waiting order of that screen (a problem's ids)
 *   checked  the ids that were asked about (the oldest, up to CONFIRM_MAX_IDS)
 *   pending  Set of the checked ids the database says are still pending
 *   found    Set of the checked ids the database holds a row for at all (left out: all of them)
 * Returns { waiting, gone, stations }: gone are the ids that are no longer waiting (never counted
 * again), stations ('' for none) are where a ticket the database HOLDS has left pending, which is
 * proof that tickets ARE being bumped there. A ticket the database does not hold (this till's own
 * send that never arrived) is gone from the count but proves nothing about the screen. When any
 * id was gone the till's own list is shown to be behind (its live updates are down), so the
 * orders of this screen that were NOT asked about are left out of this look as well: an alarm
 * only ever speaks about orders the database confirmed.
 */
export function confirmWaiting(waiting, { ids, checked, pending, found } = {}) {
  const asked = new Set(checked || []);
  const goneSet = new Set([...asked].filter((id) => !(pending && pending.has(id))));
  if (!goneSet.size) return { waiting: waiting || [], gone: [], stations: [] };
  const mine = new Set(ids || []);
  const stations = new Set();
  const kept = [];
  for (const w of waiting || []) {
    if (goneSet.has(w.id)) { if (!found || found.has(w.id)) stations.add(w.centreId || ''); continue; }
    if (mine.has(w.id) && !asked.has(w.id)) continue;
    kept.push(w);
  }
  return { waiting: kept, gone: [...goneSet], stations: [...stations] };
}

/**
 * Remember the ids the database said are no longer waiting, so they are never counted again. The
 * same Set comes back. It is kept small: past GONE_KEEP the oldest are forgotten (one that is
 * still in the till's list would only be asked about once more).
 */
export function rememberGone(gone, ids, keep = GONE_KEEP) {
  for (const id of ids || []) { gone.delete(id); gone.add(id); }
  for (const id of gone) { if (gone.size <= keep) break; gone.delete(id); }
  return gone;
}

/** Status drawer and the "back" line: one kitchen screen judged from the venue's heartbeats. */
export function screenStatus({ lastSeenMs, serverNow } = {}) {
  if (!Number.isFinite(lastSeenMs) || serverNow === null || serverNow === undefined) return { state: 'unknown', silentMs: null };
  const silentMs = Math.max(0, serverNow - lastSeenMs);
  return { state: silentMs >= SILENT_MS ? 'offline' : 'online', silentMs };
}

/**
 * Is the screen of an alert that just went away really back?
 *   silent  it has been heard from again (the same devices read)
 *   stuck   the till saw a ticket of its station leave the list since the alert came up
 * An alert can also go because nothing is waiting any more or the venue shut; that is not "back".
 */
export function isBack(was, { screens, serverNow, bumpSeenAt } = {}) {
  if (!was) return false;
  if (was.reason === 'silent') {
    const s = (screens || []).find((x) => x.id === was.screenId);
    return !!s && screenStatus({ lastSeenMs: s.lastSeenMs, serverNow }).state === 'online';
  }
  return lastBumpAt(bumpSeenAt, was.centreId) > (was.since || 0);
}

/**
 * The alerts after this look.
 *   prev      { [screenId]: problem plus { since, lastSoundAt, sounds, acked } }
 *             sounds  chimes so far for the orders waiting now (a new order starts it again)
 *             acked   OK was tapped: no bar and no chime until a new order is sent to that screen
 *   problems  watchProblems, already checked against the database where a sound is due
 *   carry     screens whose check against the database could not be made this time
 *   proof     { screens, serverNow, bumpSeenAt }: when given, a "back" line is only said for a
 *             screen that isBack proves is back. Left out, every alert that goes says it.
 * Returns { alerts, sound, back }: sound is true when a chime is due now; back lists the screens
 * that just recovered ({ screenId, name, reason }).
 */
export function nextAlerts(prev, problems, { now, carry = [], proof } = {}) {
  const alerts = {};
  const back = [];
  let sound = false;
  // carry: an alert that was already up stays exactly as it was (no new sound); one that was not
  // up is not raised. "Could not tell" changes nothing.
  for (const id of carry) if (prev && prev[id]) alerts[id] = prev[id];
  for (const p of problems || []) {
    if (alerts[p.screenId]) continue;
    const was = prev && prev[p.screenId];
    const fresh = !!was && (p.newestSentAt || 0) > (was.newestSentAt || 0);
    const due = chimeDue(was, p, now);
    if (due) sound = true;
    const sounds = was && !fresh ? (was.sounds || 0) : 0;
    alerts[p.screenId] = {
      ...p,
      since: was ? was.since : now,
      lastSoundAt: due ? now : was.lastSoundAt,
      sounds: due ? sounds + 1 : sounds,
      newestSentAt: Math.max(p.newestSentAt || 0, was ? was.newestSentAt || 0 : 0),
      // A new order for that screen shows the bar again; its chime waits for the 5 minutes.
      acked: !!was && !fresh && was.acked === true,
    };
  }
  for (const [id, was] of Object.entries(prev || {})) {
    if (alerts[id]) continue;
    if (proof === undefined || isBack(was, proof || {})) back.push({ screenId: id, name: was.name, reason: was.reason });
  }
  return { alerts, sound, back };
}

/** What a till remembers between looks. Made once when the watch starts. */
export function newWatch(now) {
  return {
    watchingSince: now,
    bumpSeenAt: new Map(),   // station id ('' for none) to when a ticket of that station last left the till's list
    gone: new Set(),         // ids the database said are no longer waiting
    behind: new Set(),       // screens for which the last check showed this till's own list is behind
    noScreen: new Set(),     // stations ('' for none) that the last READ 1 showed have no kitchen screen
    noScreenUntil: 0,        // how long that is trusted
  };
}

/**
 * ONE look. The till runs it once a minute (components/KdsScreenAlert.jsx hands in its own list
 * and the two reads). Nothing here is on the order path.
 *   tickets            the till's own list (store kdsTickets)
 *   trading            is the venue trading now (isTrading)
 *   dayStartMs         the start of the venue's business day
 *   getAlerts()        the alerts showing now (asked again after each read: OK may be tapped meanwhile)
 *   watch              newWatch(), kept by the caller between looks
 *   readDevices()      READ 1: the venue's devices rows, or null when it could not tell
 *   readStatuses(ids)  READ 2: [{ id, status }] for those ticket ids, or null when it could not tell
 * Which reads are made:
 *   nothing has waited 2 minutes or the venue is shut, and no bar is up: none.
 *   READ 1 once per look while an order has waited 2 minutes, and once more when a bar is about to
 *     come down, so "back" is only said for a screen that was heard from again. Not made while
 *     every waiting order is at a station that READ 1 showed, in the last 10 minutes, has no
 *     kitchen screen (a station that only prints).
 *   READ 2 for a screen in trouble only when a sound is due (new, or 5 minutes since the last), or
 *     while the last check showed this till's own list is behind for that screen. Up to 20 ids.
 * Resolves to null when nothing changes (nothing to watch, or READ 1 could not tell), else to
 * { alerts, sound, back } as nextAlerts gives them.
 */
export async function watchLook({ tickets, trading, dayStartMs, getAlerts, watch, now, readDevices, readStatuses, stuckRule = STUCK_RULE } = {}) {
  const alertsNow = () => (typeof getAlerts === 'function' ? getAlerts() : getAlerts) || {};
  let waiting = waitingTickets(tickets, { now, dayStartMs, skip: watch.gone });
  const due = waiting.length > 0 && trading !== false;
  const barUp = Object.keys(alertsNow()).length > 0;
  if (!due && !barUp) return null;
  if (!barUp && now < watch.noScreenUntil && waiting.every((w) => watch.noScreen.has(w.centreId || ''))) return null;
  const devices = await readDevices();
  const told = Array.isArray(devices);
  const screens = told ? screensFrom(devices) : [];
  const serverNow = told ? serverNowFrom(devices) : null;
  const proof = { screens, serverNow, bumpSeenAt: watch.bumpSeenAt };
  // Nothing is waiting any more, or the venue shut: the bars come down whatever READ 1 said.
  if (!due) { watch.behind.clear(); return nextAlerts(alertsNow(), [], { now, proof }); }
  if (!told) return null;
  // A station that only prints: its tickets are never bumped, so they always "wait". There is
  // nothing to watch there and no reason to read the devices every minute for them alone.
  const onScreen = (w) => screens.some((sc) => !sc.centreId || sc.centreId === w.centreId);
  watch.noScreen = new Set(waiting.filter((w) => !onScreen(w)).map((w) => w.centreId || ''));
  watch.noScreenUntil = now + NO_SCREEN_RECHECK_MS;
  const judge = () => watchProblems({ screens, waiting, serverNow, bumpSeenAt: watch.bumpSeenAt, watchingSince: watch.watchingSince, now, stuckRule });
  const carry = [];
  for (const p of judge()) {
    if (!soundDue(alertsNow(), p, now) && !watch.behind.has(p.screenId)) continue;
    const live = new Set(waiting.map((w) => w.id));
    const ids = p.ids.filter((id) => live.has(id));       // an earlier screen's check may have dropped some
    if (!ids.length) continue;
    const checked = ids.slice(0, CONFIRM_MAX_IDS);
    const rows = await readStatuses(checked);
    if (!Array.isArray(rows)) { carry.push(p.screenId); continue; }
    const found = new Set(rows.map((r) => r.id));
    const pending = new Set(rows.filter((r) => r.status === 'pending').map((r) => r.id));
    const c = confirmWaiting(waiting, { ids, checked, pending, found });
    waiting = c.waiting;
    rememberGone(watch.gone, c.gone);
    c.stations.forEach((station) => watch.bumpSeenAt.set(station, now));
    if (c.gone.length) watch.behind.add(p.screenId); else watch.behind.delete(p.screenId);
  }
  return nextAlerts(alertsNow(), judge().filter((p) => !carry.includes(p.screenId)), { now, carry, proof });
}

/**
 * "OK" on the bar: staff know. No bar and no chime for that screen until a NEW order is sent to it,
 * or it has come back and gone again (nextAlerts). 12 Oct 2026, review: OK used to hide the bar for
 * five minutes only, and the chime could not be stopped at all.
 */
export function hideAlert(alerts, screenId) {
  const a = alerts && alerts[screenId];
  if (!a) return alerts;
  return { ...alerts, [screenId]: { ...a, acked: true } };
}

// "3 min", "1 h 36 min", "2 h", "22 days". Never under a minute: the till looks once a minute.
function span(msv) {
  const m = Math.max(1, Math.round((Number(msv) || 0) / 60000));
  if (m < 60) return `${m} min`;
  if (m < 2 * 24 * 60) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / (24 * 60))} days`;
}
const orders = (n) => `${n} ${n === 1 ? 'order' : 'orders'}`;

/** The words on the till. */
export function alertWords(a) {
  const waiting = `${orders(a.count)} waiting, the oldest ${span(a.oldestWaitMs)}.`;
  if (a.reason === 'silent') {
    // Silent for a whole day (or never heard from): "today" is true and reads better than a count of hours.
    const quiet = Number.isFinite(a.silentMs) && a.silentMs < DAY_MS ? `for ${span(a.silentMs)}` : 'today';
    return { title: `${a.name} is not showing orders`, body: `This till has not heard from it ${quiet}. ${waiting} Check that screen and its WiFi. Tell the kitchen the orders by hand.` };
  }
  const noBump = Number.isFinite(a.noBumpMs) ? a.noBumpMs : a.oldestWaitMs;
  return { title: `${a.name} has not bumped anything for ${span(noBump)}`, body: `${waiting} Check that screen is showing them.` };
}

/** The line when a screen is back. */
export const backWords = (b) => (b.reason === 'silent' ? `${b.name} is back online.` : `${b.name} is bumping orders again.`);

/** Status drawer: what the till's own list says is waiting on one screen (every pending ticket of today, however new). */
export function waitingSummary(tickets, { centreId = null, now, dayStartMs = 0 } = {}) {
  let count = 0; let oldest = null;
  for (const t of tickets || []) {
    if (!t || !isPending(t)) continue;
    if (centreId && centreOf(t) !== centreId) continue;
    const sentAt = sentOf(t);
    if (!Number.isFinite(sentAt) || sentAt < dayStartMs || now - sentAt > MAX_WAIT_MS) continue;
    count += 1;
    if (oldest === null || sentAt < oldest) oldest = sentAt;
  }
  return { count, oldestWaitMs: oldest === null ? 0 : Math.max(0, now - oldest) };
}

/** Status drawer: "3 orders waiting on it, the oldest 12 min". null for none. */
export const waitingWords = ({ count, oldestWaitMs } = {}) => (count > 0 ? `${orders(count)} waiting on it, the oldest ${span(oldestWaitMs)}` : null);

/** Status drawer: "Heard from just now" / "Heard from 2 min ago" / "Not heard from for 6 min" / "Not heard from yet". */
export function heardWords({ state, silentMs } = {}) {
  if (state === 'online') return silentMs < 90000 ? 'Heard from just now' : `Heard from ${span(silentMs)} ago`;
  if (state === 'offline') return `Not heard from for ${span(silentMs)}`;
  return 'Not heard from yet';
}

/** Status drawer: the test ticket, said honestly. state: 'sent' | 'silent' | 'bumped' | 'waiting'. */
export function testTicketWords({ state, name, silentMs = 0 } = {}) {
  if (state === 'bumped') return `${name} bumped the test ticket. It is working.`;
  if (state === 'silent') return `Sent, but this till has not heard from ${name} for ${span(silentMs)}. It may not show.`;
  if (state === 'waiting') return `Not bumped yet. If the test ticket is not on ${name}, that screen is not getting orders: check its WiFi and restart it.`;
  return `Test ticket sent. Bump it on ${name} to prove the screen is working.`;
}
