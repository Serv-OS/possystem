// src/lib/venueMessageRules.js: messages from ServOS to venues, the app side rules.
//
// WHY (Peter, 5 Oct 2026): "a POP UP from the admin: send a message ... 'Hi, I have just made an
// update, you need to do XYZ'." It pops up in Back Office and on tills, stays until someone taps
// Got it, and one confirmation clears it for the whole venue.
//
// Pure helpers only (no Supabase, no window, no React), so node:test drives every branch. The
// rules the server also needs (draft check, recipients, the Sent list rollup) live in
// supabase/functions/_shared/venueMessageRules.js and are re-exported here.
//
// THE CARD PATH IS OFF LIMITS. The pop up must never open over a checkout, a card screen, a tab
// capture or any payment in progress. Every pay flow already holds lib/paymentBusy.js (v5.11.1,
// written for UpdateGuard), and the open checkout holds it for as long as it is on screen, so
// the pop up asks the very same question an app update asks: canApplyUpdate().

import { NAME_MAX, isOpenMessage, oneLine } from '../../supabase/functions/_shared/venueMessageRules.js';

export * from '../../supabase/functions/_shared/venueMessageRules.js';

/** A database that has not had 20261005a yet: the table or the function is not there. */
export function isMissingVenueMessages(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST202' || code === '42883') return true;
  const msg = String(error.message || error.hint || '');
  return /venue_messages?/i.test(msg) && /(does not exist|could not find|schema cache)/i.test(msg);
}

/** Shown wherever the feature needs the database update first. Never an error on a till. */
export const NEEDS_UPDATE_LINE = 'Messages to venues need a ServOS database update first (20261005a). Nothing was sent.';

const timeOf = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

/**
 * Waiting messages for this venue, oldest first (the order they are shown in). `tappedIds` are
 * messages somebody on THIS screen already tapped Got it on, whose confirmation has not reached
 * the server yet (a till with no internet): they are done as far as this screen goes.
 */
export function openQueue(rows, locationId, tappedIds = null) {
  const loc = locationId ? String(locationId) : null;
  const tapped = tappedIds instanceof Set ? tappedIds : new Set(tappedIds || []);
  return (rows || [])
    .filter((r) => isOpenMessage(r) && !tapped.has(r.id) && (!loc || String(r.location_id) === loc))
    .sort((a, b) => (timeOf(a.sent_at) - timeOf(b.sent_at)) || String(a.id).localeCompare(String(b.id)));
}

/** The one message to show now: the oldest still waiting. Null when there is none. */
export function nextMessage(rows, locationId, tappedIds = null) {
  return openQueue(rows, locationId, tappedIds)[0] || null;
}

/**
 * Got it taps that have not reached the server yet: { [messageId]: { name, at } }.
 * WHY: a till must never be held up by this for more than the tap. With no internet the tap
 * still clears the pop up on that till at once, and the confirmation is sent when the till is
 * back (the name is the person who tapped; the time recorded is when it arrived).
 */
export function addTapped(pending, id, name, at) {
  if (!id) return pending || {};
  return { ...(pending || {}), [id]: { name: name || null, at: at || null } };
}

/**
 * What to do with one pending tap after a send attempt.
 *   'done'     the server has it (or the message is finished some other way): forget the tap
 *   'retry'    it did not get through: keep it and try again later
 *   'refused'  the server said this screen may not confirm: keep the tap so the pop up stays
 *              away from THIS screen, and never ask again (asking again can never succeed, and
 *              a pop up that cannot be cleared would hold the till). It stays waiting for the
 *              venue, so Back Office and the other tills still show it.
 */
export function tappedOutcome(result) {
  if (result && result.ok) return 'done';
  if (result && result.reason === 'not_allowed') return 'refused';
  return 'retry';
}

/** The taps still to be sent (a refused one is never sent again). */
export function tapsToSend(pending) {
  return Object.entries(pending || {}).filter(([, t]) => !(t && t.refused)).map(([id]) => id);
}

/** Drop taps for messages that are finished or no longer exist on this venue's list. */
export function pruneTapped(pending, rows, { now = Date.now(), maxAgeMs = 45 * 24 * 60 * 60 * 1000 } = {}) {
  const out = {};
  const byId = new Map((rows || []).filter((r) => r && r.id).map((r) => [r.id, r]));
  for (const [id, t] of Object.entries(pending || {})) {
    const row = byId.get(id);
    if (row && !isOpenMessage(row)) continue;                          // confirmed or withdrawn
    if (t && t.at && now - Date.parse(t.at) > maxAgeMs) continue;      // far too old to matter
    out[id] = t;
  }
  return out;
}

/**
 * One live row (or a fresh read of one) folded into the list a screen holds. A row for another
 * venue is ignored: a device only ever keeps its own venue's messages, whatever arrives.
 * A confirmed or withdrawn row never goes back to waiting: the newer state always wins.
 */
export function applyMessageRow(list, row, locationId) {
  const cur = list || [];
  if (!row || !row.id) return cur;
  if (locationId && String(row.location_id) !== String(locationId)) return cur;
  const i = cur.findIndex((r) => r.id === row.id);
  if (i === -1) return [...cur, row];
  const old = cur[i];
  const merged = { ...old, ...row };
  if (old.confirmed_at && !row.confirmed_at) {
    merged.confirmed_at = old.confirmed_at; merged.confirmed_by = old.confirmed_by; merged.confirmed_via = old.confirmed_via;
  }
  if (old.withdrawn_at && !row.withdrawn_at) merged.withdrawn_at = old.withdrawn_at;
  const next = cur.slice();
  next[i] = merged;
  return next;
}

/**
 * A full read folded into the list. Anything this screen already knows to be confirmed or
 * withdrawn stays that way, so a slow read can never bring a pop up back.
 */
export function mergeFetched(list, fetched, locationId) {
  const loc = locationId ? String(locationId) : null;
  let out = (list || []).filter((r) => r && r.id && (r.confirmed_at || r.withdrawn_at)
    && (!loc || String(r.location_id) === loc));
  for (const r of fetched || []) out = applyMessageRow(out, r, locationId);
  return out;
}

/**
 * Which screens may show the pop up at all.
 *   'backoffice'  the Back Office of a signed in person
 *   'till'        the till shell (Floor, POS, Bar, Orders) with a member of staff signed in
 * Everything else never does: kiosk, kitchen screen, customer display, menu board, order
 * screen, time clock, the phone till (it is handed to customers), and every customer page.
 */
export const POPUP_HOSTS = Object.freeze(['till', 'backoffice']);

export function tillMayHostPopup({ deviceMode, deviceType, defaultSurface, surface, isKdsDevice = false, staffSignedIn = false } = {}) {
  if (deviceMode !== 'pos') return false;
  if (isKdsDevice || deviceType === 'kds' || deviceType === 'kiosk' || deviceType === 'clock') return false;
  if (defaultSurface === 'kiosk' || defaultSurface === 'mpos') return false;
  if (surface === 'kiosk' || surface === 'kds') return false;
  return staffSignedIn === true;
}

/**
 * May the pop up be on screen right now?
 * Never while a payment holds (an open checkout holds too), nor in the quiet seconds after one
 * ended, nor while the till is in a customer's hands. It waits and shows after.
 * `paymentQuiet` is lib/paymentBusy.js canApplyUpdate(): the same answer an app update gets.
 * Anything but a clear yes is a no.
 */
export function mayShowPopup({ paymentQuiet = false, customerFacing = false, changeDueShowing = false } = {}) {
  if (customerFacing) return false;
  // CHANGE DUE parks over the till AFTER the checkout has closed (components/ChangeDueOverlay.jsx),
  // so no hold covers it, and staff can still be counting coins when the quiet seconds end. The
  // cash handover is part of the payment: wait until somebody has tapped it away.
  if (changeDueShowing !== false) return false;
  return paymentQuiet === true;
}

/**
 * What a key press does while the pop up is on screen.
 *   'block'   swallowed: it reaches neither the card nor the screen behind it
 *   'button'  Tab in Back Office: focus goes to Got it (and nowhere else)
 *   'press'   Enter or Space on Got it itself, in Back Office only
 *   'browser' a key with Ctrl, Cmd or Alt held, or a function key: hidden from the screen
 *             behind like the rest, but the browser may still act on it (reload, copy)
 * WHY: the card covers the screen, but keys do not care. A manager typing a price would keep
 * typing into a hidden field (and Enter would save it unseen); on a till a staff card swipe
 * (lib/useCardScan.js listens on window) would switch the signed in user behind the card and a
 * barcode scan would add an item. And a USB wedge (card or barcode) ENDS WITH ENTER: if Enter
 * could ever press Got it on a till, a swipe would confirm the message for the whole venue with
 * nobody having read it. So a till takes no keys at all: Got it is a tap there, nothing else.
 */
export function popupKeyAction({ host, key, onButton = false, armed = false, modifier = false } = {}) {
  // The browser's own keys (reload, dev tools, copy) stay the browser's: hidden from the screen
  // behind, but not cancelled. A wedge never sends these.
  if (modifier === true || /^F\d{1,2}$/.test(String(key || ''))) return 'browser';
  if (host !== 'backoffice') return 'block';
  if (key === 'Tab') return 'button';
  if ((key === 'Enter' || key === ' ' || key === 'Spacebar') && onButton === true && armed === true) return 'press';
  return 'block';
}

/**
 * Does this click on Got it count?
 * Never before the button is awake. On a till it must also be a real tap: a finger or a mouse
 * went DOWN on the button first (`pressed`). A click that a keyboard made has no press before it,
 * so a wedge's Enter can never confirm, even if focus somehow reached the button.
 */
export function gotItClickCounts({ host, armed = false, pressed = false } = {}) {
  if (armed !== true) return false;
  if (host === 'backoffice') return true;
  if (host === 'till') return pressed === true;
  return false;
}

/** How long one Got it send may take before it is given up and tried again later. */
export const CONFIRM_TIMEOUT_MS = 15 * 1000;

/**
 * The saved taps after one flush from outside the till shell (sync/SyncBridge.jsx).
 * `results` is { [messageId]: the confirmVenueMessage answer }. Done taps are forgotten, a
 * refused one is kept and never asked again, anything else stays for the next try.
 */
export function tapsAfterFlush(pending, results) {
  const out = {};
  for (const [id, t] of Object.entries(pending || {})) {
    if (!results || !(id in results)) { out[id] = t; continue; }
    const outcome = tappedOutcome(results[id]);
    if (outcome === 'done') continue;
    out[id] = outcome === 'refused' ? { ...t, refused: true } : t;
  }
  return out;
}

/**
 * Who may tap Got it, and the name that is recorded.
 *   till        a signed in member of staff (their till name)
 *   backoffice  a real Back Office login (never an anonymous session)
 * The server decides again (venue_message_confirm): it takes the Back Office name from the
 * login itself and only accepts a till that is paired to the message's own venue.
 */
export function confirmer({ host, staffName, user, userName } = {}) {
  if (host === 'till') {
    const name = oneLine(staffName).slice(0, NAME_MAX);
    return name ? { ok: true, via: 'till', name } : { ok: false, reason: 'no_staff' };
  }
  if (host === 'backoffice') {
    if (!user || !user.id || user.is_anonymous) return { ok: false, reason: 'not_signed_in' };
    const name = oneLine(userName || user.email || 'Back Office').slice(0, NAME_MAX);
    return { ok: true, via: 'backoffice', name };
  }
  return { ok: false, reason: 'wrong_screen' };
}

/** One chime per message, and one more each time ServOS sends it again. */
export function chimeKey(row) {
  return row && row.id ? `${row.id}:${row.resent_at || row.sent_at || ''}` : null;
}

/** "5 Oct, 14:32" on the venue's own clock (never the viewer's, never UTC). */
export function formatVenueTime(iso, timezone, { locale = 'en-GB' } = {}) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: timezone || 'Europe/London' }).format(new Date(t));
  } catch {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'Europe/London' }).format(new Date(t));
  }
}

/** "Confirmed by Sam at 5 Oct, 14:32", "Confirmed by Sam (sam@venue.com) at ...", "Waiting" or "Withdrawn". */
export function venueStatusLine(v, { timezone } = {}) {
  if (!v) return '';
  const when = v.confirmedAt ? formatVenueTime(v.confirmedAt, timezone || v.timezone) : '';
  // Company Admin only (a venue cannot read the email): the login behind a Back Office Got it.
  const email = v.confirmedVia === 'backoffice' && v.confirmedEmail && v.confirmedEmail !== v.confirmedBy ? ` (${v.confirmedEmail})` : '';
  const confirmed = v.confirmedAt ? `Confirmed by ${v.confirmedBy || 'someone'}${email}${when ? ` at ${when}` : ''}` : '';
  if (v.status === 'withdrawn') return confirmed ? `${confirmed}, then withdrawn` : 'Withdrawn';
  if (v.status === 'confirmed') return confirmed;
  return 'Waiting';
}

/** Received messages for the Back Office list: the last `days` days, newest first. */
export function receivedList(rows, { now = Date.now(), days = 30 } = {}) {
  const since = now - days * 24 * 60 * 60 * 1000;
  return (rows || [])
    .filter((r) => r && r.id && timeOf(r.sent_at) >= since)
    .sort((a, b) => timeOf(b.sent_at) - timeOf(a.sent_at));
}

/** The admin tick list: venues grouped by company, filtered by a search over both names. */
export function groupVenues(venues, search = '') {
  const term = String(search || '').trim().toLowerCase();
  const groups = new Map();
  for (const v of venues || []) {
    if (!v || !v.id) continue;
    const company = v.org_name || 'No company';
    if (term && !`${company} ${v.name || ''}`.toLowerCase().includes(term)) continue;
    const key = String(v.org_id || 'none');
    if (!groups.has(key)) groups.set(key, { orgId: v.org_id || null, company, venues: [] });
    groups.get(key).venues.push(v);
  }
  const out = [...groups.values()];
  for (const g of out) g.venues.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  out.sort((a, b) => a.company.localeCompare(b.company));
  return out;
}
