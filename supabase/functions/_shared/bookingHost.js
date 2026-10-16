// supabase/functions/_shared/bookingHost.js
//
// HOST TOOLS (16 Oct 2026, v5.11.70 host track). The pure rules behind the host
// stand's guest tags, booking refunds, the requests inbox, large party requests,
// the late party prompt, dragging a party onto a table on the floor, the
// manager PIN and the consent channel. No database, no network, no Deno: the
// web app imports this file directly and node:test covers every branch
// (src/lib/bookings/bookingHost.test.js), and the edge functions import the
// same file, so the screens and the servers can never disagree.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

// ── guest tags (plan item 8) ─────────────────────────────────────────────────
// customers.tags also carries the merge trail and import markers. Those are
// records of what the system did, never words about the guest, so they are
// never shown (bookings audit, auditor 4).
const TRAIL_TAG = /^(merge_|merged_|merged:|email_join|join_notice|demo$|import_)/i;
export const REGULAR_VISITS = 3;

export function visibleTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = String(raw ?? '').trim();
    if (!t || t.length > 30 || t.includes(':') || TRAIL_TAG.test(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.slice(0, 8);
}

// The chips a host sees beside a guest's name, most important first.
//   { key, label, tone }   tone: 'gold' | 'green' | 'grey' | 'red'
export function guestChips({ tags = [], visits = null, noShows = 0 } = {}) {
  const shown = visibleTags(tags);
  const lower = new Set(shown.map((t) => t.toLowerCase()));
  const v = Math.max(0, Math.round(num(visits)));
  const chips = [];
  if (lower.has('vip')) chips.push({ key: 'vip', label: 'VIP', tone: 'gold' });
  if (lower.has('regular') || v >= REGULAR_VISITS) chips.push({ key: 'regular', label: 'Regular', tone: 'green' });
  if (v > 0) chips.push({ key: 'visits', label: `${v} visit${v === 1 ? '' : 's'}`, tone: 'grey' });
  const ns = Math.max(0, Math.round(num(noShows)));
  if (ns > 0) chips.push({ key: 'no_shows', label: `${ns} no-show${ns === 1 ? '' : 's'}`, tone: 'red' });
  for (const t of shown) {
    const k = t.toLowerCase();
    if (k === 'vip' || k === 'regular') continue;
    chips.push({ key: `tag:${k}`, label: t.replace(/[-_]+/g, ' '), tone: 'grey' });
  }
  return chips;
}

// ── booking refunds (plan item 4) ────────────────────────────────────────────
// A refund is its own booking_payments row: kind 'refund', status pending until
// Adyen's REFUND webhook says refunded (or failed). Its merchant reference names
// the payment it gives back, so the link needs no new column:
//   bkrf-<payment row uuid>-<n>        (at most 46 characters, inside Adyen's 80
//                                       and adyen-modify's 60 character key rule)
// A hold took no money (amount 0 since 16 Oct 2026, the rule figure before), so
// it is never refundable whatever its amount says.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REFUND_REF = new RegExp(`^bkrf-(${UUID})-(\\d{1,4})$`, 'i');
export const REFUNDABLE_KINDS = ['prepay', 'deposit', 'no_show_charge'];

export function refundReference(parentId, n) {
  return `bkrf-${String(parentId)}-${Math.max(1, Math.round(num(n)) || 1)}`;
}

export function parseRefundReference(ref) {
  const m = REFUND_REF.exec(String(ref || ''));
  return m ? { parentId: m[1].toLowerCase(), n: Number(m[2]) } : null;
}

export const amountMinorOf = (row) => Math.round(num(row?.amount) * 100);

// The refund rows that give back THIS payment: linked by refund_of (after the
// migration) or by the merchant reference (always).
export function refundRowsFor(parent, rows = []) {
  const id = String(parent?.id || '').toLowerCase();
  if (!id) return [];
  return (rows || []).filter((r) => r && r.kind === 'refund' && (
    String(r.refund_of || '').toLowerCase() === id
    || parseRefundReference(r.merchant_reference)?.parentId === id));
}

// Money already given back, or on its way (a pending refund counts, so two
// taps can never refund the same pound twice). A refund that failed does not.
export function refundedMinorFor(parent, rows = []) {
  const fromRows = refundRowsFor(parent, rows)
    .filter((r) => r.status === 'pending' || r.status === 'refunded')
    .reduce((s, r) => s + amountMinorOf(r), 0);
  const fromColumn = Math.max(0, Math.round(num(parent?.amount_refunded_minor)));
  return Math.max(fromRows, fromColumn);
}

export function isRefundableRow(row) {
  if (!row || !REFUNDABLE_KINDS.includes(row.kind)) return false;
  return row.status === 'captured' || row.status === 'needs_refund';
}

// The part of a payment that paid a closed bill. Never refundable from here:
// the check still books it as booking_prepaid or booking_deposit tender. A row
// applied under the old rule (no applied_minor, or the column not there yet)
// was used in full.
export function usedMinor(parent) {
  if (!parent?.applied_to_check) return 0;
  if (parent.applied_minor === null || parent.applied_minor === undefined || parent.applied_minor === '') return amountMinorOf(parent);
  return Math.max(0, Math.min(amountMinorOf(parent), Math.round(num(parent.applied_minor))));
}

export function refundableMinor(parent, rows = []) {
  if (!isRefundableRow(parent)) return 0;
  return Math.max(0, amountMinorOf(parent) - usedMinor(parent) - refundedMinorFor(parent, rows));
}

// What the Refund box offers first: everything still refundable. On a payment
// the bill used, that is exactly the unused part still owed back (refunds
// already made or on their way are taken off), so it can never be offered twice.
export function refundSuggestion(parent, rows = []) {
  return refundableMinor(parent, rows);
}

// The money still owed back on a payment the bill used less of (what the host
// stand shows in orange). 0 once it has been refunded, or on any other payment.
export function refundDueLeftMinor(parent, rows = []) {
  if (!parent?.applied_to_check) return 0;
  return refundableMinor(parent, rows);
}

// The refund_due_minor to store after a refund: the unused part less what has
// gone back, null at 0. undefined when the row is not one the bill used with a
// known applied_minor (nothing to write).
export function refundDueAfter(parent, refundedMinor) {
  if (!parent?.applied_to_check) return undefined;
  if (parent.applied_minor === null || parent.applied_minor === undefined || parent.applied_minor === '') return undefined;
  const left = amountMinorOf(parent) - usedMinor(parent) - Math.max(0, Math.round(num(refundedMinor)));
  return left > 0 ? left : null;
}

// May this refund go ahead? { ok, error } with the error in plain words.
//   partialAllowed  false until the migration adds amount_refunded_minor: the
//                   till and the reader still count the whole payment as
//                   credit before it, so only a full refund is safe
//   fmt             minor units to money words, e.g. (m) => '£12.50'
export function refundCheck({ parent, rows = [], amountMinor, partialAllowed = true, fmt = (m) => (m / 100).toFixed(2) } = {}) {
  if (!parent) return { ok: false, error: 'That payment could not be found.' };
  if (parent.kind === 'hold') return { ok: false, error: 'A saved card took no money, so there is nothing to refund.' };
  if (parent.kind === 'refund') return { ok: false, error: 'This row is a refund already.' };
  if (!isRefundableRow(parent)) {
    if (parent.status === 'refunded') return { ok: false, error: 'This payment has been refunded in full already.' };
    return { ok: false, error: 'Only money that was taken can be refunded.' };
  }
  const left = refundableMinor(parent, rows);
  if (left <= 0) {
    return { ok: false, error: usedMinor(parent) > 0 ? 'This payment paid the bill, so nothing is left to refund on it.' : 'Nothing is left to refund on this payment.' };
  }
  const amt = Math.round(num(amountMinor));
  if (!(amt > 0) || amt !== num(amountMinor)) return { ok: false, error: 'Enter an amount above zero.' };
  if (amt > left) return { ok: false, error: `Only ${fmt(left)} can still be refunded on this payment.` };
  if (!partialAllowed && amt !== left) {
    return { ok: false, error: `Part refunds arrive with the database update. Refund the full ${fmt(left)}, or refund in Adyen.` };
  }
  return { ok: true, error: null, amountMinor: amt, leftAfterMinor: left - amt };
}

// The parent payment once its refunds have settled: refunded only when the
// whole amount went back. A part refund keeps it captured, and the credit on
// the bill is the amount less what was refunded.
export function parentAfterRefund(parent, refundedMinor) {
  const total = amountMinorOf(parent);
  const back = Math.max(0, Math.round(num(refundedMinor)));
  return { status: back >= total && total > 0 ? 'refunded' : parent?.status || 'captured', refundedMinor: Math.min(back, total) };
}

// The credit a captured, unapplied payment still carries onto the bill.
export function creditMinorOf(row) {
  return Math.max(0, amountMinorOf(row) - Math.max(0, Math.round(num(row?.amount_refunded_minor))));
}

// ── large parties and the requests inbox (plan item 5) ───────────────────────
export const WIDGET_PARTY_DEFAULTS = { min: 1, max: 12 };

// The party sizes the booking page offers. maxForCap: the most the pacing cap
// can ever take (a party above it could never be booked anyway).
export function widgetPartyBounds(rules = {}, maxForCap = null) {
  const rawMin = Math.round(num(rules?.widgetMinParty ?? rules?.widget_min_party));
  const rawMax = Math.round(num(rules?.widgetMaxParty ?? rules?.widget_max_party));
  const min = Math.min(50, Math.max(1, rawMin || WIDGET_PARTY_DEFAULTS.min));
  let max = Math.min(50, Math.max(min, rawMax || WIDGET_PARTY_DEFAULTS.max));
  const cap = Math.round(num(maxForCap));
  if (cap > 0) max = Math.max(min, Math.min(max, cap));
  return { min, max };
}

export const partyNeedsRequest = (party, bounds) => Math.round(num(party)) > Math.round(num(bounds?.max || WIDGET_PARTY_DEFAULTS.max));

// One inbox row from a booking_requests row. kind:
//   'large_party'  the guest asked through "Larger party? Send a request"
//   'slot_gone'    an older widget build told the guest the venue would confirm
//   'request'      anything else pending with no booking
export function requestRow(r) {
  const p = (r && typeof r.payload === 'object' && r.payload) || {};
  const kind = p.kind === 'large_party' ? 'large_party' : p.reason === 'slot_gone' ? 'slot_gone' : 'request';
  return {
    id: String(r?.id || ''),
    createdAt: r?.created_at || null,
    status: r?.status || 'pending',
    kind,
    date: typeof p.date === 'string' ? p.date : null,
    time: typeof p.time === 'string' ? p.time.slice(0, 5) : null,
    party: Math.max(1, Math.round(num(p.party)) || 1),
    name: String(p.name || '').trim() || 'Guest',
    phone: String(p.phone || '').trim() || null,
    email: String(p.email || '').trim() || null,
    note: String(p.note || '').trim(),
  };
}

// The inbox: pending, no booking made, and not for a day already gone at the
// venue. Newest first. A widget booking waiting for its payment also writes a
// pending row, but it carries its booking id, so it never shows here.
export function inboxRows(rows = [], todayYmd = null) {
  return (rows || [])
    .filter((r) => r && r.status === 'pending' && !r.booking_id)
    .map(requestRow)
    .filter((r) => !todayYmd || !r.date || r.date >= todayYmd)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export const DECLINE_DEFAULT = (venue) =>
  `Sorry, ${venue || 'we'} cannot take this booking. Please call us if another time would work.`;

// The SMS text for a declined request, kept short and in plain words.
export function declineText({ venue, name, message } = {}) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const body = String(message || '').trim() || DECLINE_DEFAULT(venue);
  return `Hi ${first}, ${body}`.slice(0, 480);
}

// ── late parties (plan item 11) ──────────────────────────────────────────────
export const LATE_RELEASE_DEFAULT = 15;

// null when the booking is not late. release is true once the party is late by
// the venue's release minutes: the stand asks "Still waiting?".
export function lateState({ booking, nowMin, releaseMinutes = LATE_RELEASE_DEFAULT } = {}) {
  if (!booking || !Number.isFinite(nowMin)) return null;
  if (!['confirmed', 'prepaid'].includes(booking.status)) return null;
  const start = toMin(booking.startTime);
  if (!Number.isFinite(start)) return null;
  const lateBy = nowMin - start;
  if (lateBy <= 0) return null;
  const rel = Math.max(1, Math.round(num(releaseMinutes)) || LATE_RELEASE_DEFAULT);
  return { lateBy, release: lateBy >= rel, releaseMinutes: rel };
}

// ── drag a party onto a table on the floor (plan, Later) ─────────────────────
// mode 'move'  keep the time, change the table
// mode 'seat'  the party is here: move it to this table and seat it now
// others: the day's bookings in the store's shape ({ id, status, tables,
// startTime, turnMinutes, customer, covers }).
const NON_BLOCKING = ['departed', 'cancelled', 'no_show', 'expired'];
const nameOf = (b) => b?.customer?.name || (b?.source === 'walk_in' ? 'Walk-in' : `Party of ${b?.covers || '?'}`);

export function floorDrop({ booking, table, others = [], nowMin = null, mode = 'move' } = {}) {
  if (!booking || !table) return { ok: false, reason: 'Drop the party on a table.' };
  const label = table.label || String(table.id);
  const current = Array.isArray(booking.tables) ? booking.tables : [];
  if (current.length === 1 && current[0] === table.id && mode === 'move') return { ok: false, unchanged: true, reason: `Already on ${label}.` };
  const seats = Math.round(num(table.maxCovers ?? table.covers));
  const covers = Math.round(num(booking.covers)) || 1;
  if (seats > 0 && seats < covers) return { ok: false, reason: `${label} seats ${seats}, this party is ${covers}.` };
  const start = toMin(booking.startTime);
  const turn = Math.max(15, Math.round(num(booking.turnMinutes)) || 90);
  let from = start, to = start + turn;
  if (mode === 'seat' && Number.isFinite(nowMin)) {
    if (table.session) return { ok: false, reason: `${label} has an open tab on the till.` };
    from = Math.min(start, nowMin);
    to = Math.max(start, nowMin) + turn;
  }
  if (!Number.isFinite(from)) return { ok: false, reason: 'This booking has no time.' };
  const clash = (others || []).find((o) => o && o.id !== booking.id
    && !NON_BLOCKING.includes(o.status)
    && (o.tables || []).includes(table.id)
    && toMin(o.startTime) < to
    && toMin(o.startTime) + (Math.round(num(o.turnMinutes)) || 90) > from);
  if (clash) {
    const at = String(clash.startTime || '').slice(0, 5);
    return { ok: false, clash: clash.id, reason: `${label} is booked for ${nameOf(clash)} at ${at}.` };
  }
  return { ok: true, reason: null, tables: [table.id], label, mode };
}

// ── manager PIN (plan item 11) ───────────────────────────────────────────────
const MANAGER_ROLES = new Set(['manager', 'owner', 'admin', 'super_admin', 'general manager', 'gm', 'assistant manager', 'supervisor']);
export function isManagerRole(role) {
  return MANAGER_ROLES.has(String(role || '').trim().toLowerCase());
}

// ── consent (plan item 11) ───────────────────────────────────────────────────
// The channel recorded is the one the guest actually gave: ticking the box
// with only a mobile is consent for texts, never for email.
export function consentChannel({ phone, email } = {}) {
  const p = !!String(phone || '').trim();
  const e = !!String(email || '').trim();
  if (p && e) return 'both';
  if (p) return 'sms';
  if (e) return 'email';
  return null;
}

// A privacy link a venue typed: only http(s), trimmed, or null.
export function safeLink(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  return /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null;
}

// ── pay link from the stand (plan item 9) ────────────────────────────────────
// How long a pay link sent from the stand stays live: 24 hours, never past the
// booking's own start. A booking still waiting online (pending_payment) is not
// released by the 20 minute sweep while its link is live. A confirmed phone
// booking stays confirmed throughout.
export const PAY_LINK_HOURS = 24;
export const PAY_LINK_MIN_MINUTES = 30;

// A wall clock time at the venue (YYYY-MM-DD, HH:MM, IANA zone) as epoch ms.
// Never the device clock or zone. NaN when the input is not a date and time.
export function venueWallToEpochMs(ymd, hhmm, tz = 'Europe/London') {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  const t = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!d || !t) return NaN;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const offsetAt = (ms) => {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz || 'Europe/London', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).formatToParts(new Date(ms));
      const g = (k) => Number(parts.find((p) => p.type === k)?.value);
      return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - ms;
    } catch { return 0; }
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return ms;
}

// The pay link window: { ok, untilMs } or { ok:false, error } in plain words.
export function payLinkWindow({ nowMs, startMs, hours = PAY_LINK_HOURS } = {}) {
  const now = num(nowMs);
  let until = now + Math.max(1, num(hours)) * 3600000;
  if (Number.isFinite(startMs)) until = Math.min(until, startMs);
  if (until - now < PAY_LINK_MIN_MINUTES * 60000) {
    return { ok: false, error: 'The booking starts too soon for a pay link. Take payment when the guest arrives.' };
  }
  return { ok: true, untilMs: until };
}

// The words on the SMS. amountText is already in the venue's money.
export function payLinkText({ venue, name, date, time, kind, amountText, link } = {}) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const what = kind === 'hold' ? 'save a card to hold your table (nothing is taken)'
    : kind === 'deposit' ? `pay your ${amountText} deposit`
    : `pay ${amountText} for your booking`;
  return `Hi ${first}, to confirm your table at ${venue || 'the venue'} on ${date} at ${time}, please ${what}: ${link}`.slice(0, 600);
}
