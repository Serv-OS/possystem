// supabase/functions/booking-widget/manage.ts
//
// The guest's own link (16 Oct 2026): https://<venue>.<root>/book?manage=<token>.
// Every booking gets a code in booking_manage_tokens from the database when it is made
// (migration 20261016c), whoever makes it. The code IS the credential: this file never takes a
// booking id, a venue id or anything else from the page. The codes live in their own table,
// closed to the anon key, because bookings itself is still readable with that key.
//
// Actions (all answer 200 with { ok, error?, message? } so the page can always read the words):
//   manage_info    the booking, what the guest may do and, when not, why in words; the venue's
//                  phone and address; a calendar link and an .ics file
//   manage_slots   { date, party }: the times the booking could move to, quoted with the same
//                  optimiser as the booking page, the booking's own tables counted as free
//   manage_change  { date, time, party }: moves the booking through edit_booking, the same
//                  guarded write the host stand uses (venue lock, free check, seats, floor plan)
//   manage_cancel  cancels it
//
// THE RULES (pure, tested: _shared/bookingGuest.js)
//   - Online changes close cancellation_window_hours before the booking (0 = until it starts),
//     and the venue can switch them off (booking_rules.guest_manage_enabled). Then the page says
//     to call the venue, with the number.
//   - Money is never refunded by itself. A cancel in time flags every captured prepay or deposit
//     row as owed back and raises it on the venue's activity feed ("Refund the guest in Adyen").
//     Fewer guests on a per guest prepay or deposit stores the difference as owed back unless the
//     bill uses it (the till's close works out the final figure). More guests on a paid booking
//     needs a top up, which cannot be paid online yet: the page refuses and gives the phone.
//   - A booking still being paid online (pending_payment) can be cancelled, never changed.
//   - The guest is told by text and email (booking-reminders notify), the team by the activity
//     feed, and the booking's edit stamp reads "Guest online".

import {
  suggestTables, paceAt, paceFull, turnFor, toMin, sessionsToBlocks, maxPartyForCap,
} from '../_shared/bookingOptimiser.js';
import {
  manageState, moneyOnBooking, owedBackOnBooking, cancelMoney, changeMoney, packageOnDate, calendarLinks,
  venueContact, moneyWords, fmtDateWords,
} from '../_shared/bookingGuest.js';
import { isMissingColumnError, isMissingFunctionError } from '../_shared/bookingPromote.ts';
import { GUEST_CANCEL_REASON, isMissingTable, readBookingPayments, healGuestCancel } from '../_shared/bookingGuestDb.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Deps = {
  db: any;
  json: (b: unknown, s?: number) => Response;
  // deno-lint-ignore no-explicit-any
  loadVenue: (locationId: string) => Promise<any>;
  // deno-lint-ignore no-explicit-any
  loadDayBookings: (locationId: string, date: string) => Promise<any[]>;
  venueToday: (tz: string) => string;
  venueNowMin: (tz: string) => number;
  epochToVenueMin: (tz: string) => (epochMs: number) => number;
};

const hm = (s: unknown) => String(s || '').slice(0, 5);
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const NOT_READY = 'Online changes are not switched on for this venue yet. Please call the venue.';
const callLine = (phone: string) => (phone ? ` Please call the venue on ${phone}.` : ' Please call the venue.');

export async function handleManage(action: string, body: Row, d: Deps): Promise<Response> {
  const say = (error: string, message: string, extra: Row = {}) => d.json({ ok: false, error, message, ...extra });
  const token = String(body.token || '');
  if (!/^[0-9a-f]{32,128}$/i.test(token)) return say('unknown_link', 'This link is not valid. Please check the link in your message.');

  const { data: tok, error: tokErr } = await d.db.from('booking_manage_tokens').select('booking_id').eq('token', token).maybeSingle();
  if (tokErr) {
    if (isMissingTable(tokErr)) return say('not_ready', NOT_READY);
    console.error('[booking-widget] manage lookup failed:', tokErr.message);
    return say('lookup_failed', 'We could not load your booking just now. Please try again in a minute.');
  }
  if (!tok?.booking_id) return say('unknown_link', 'We could not find this booking. Please check the link in your message.');
  const { data: bk, error: bkErr } = await d.db.from('bookings').select('*').eq('id', tok.booking_id).maybeSingle();
  if (bkErr) {
    console.error('[booking-widget] manage booking read failed:', bkErr.message);
    return say('lookup_failed', 'We could not load your booking just now. Please try again in a minute.');
  }
  if (!bk) return say('unknown_link', 'We could not find this booking. Please check the link in your message.');

  const locationId = String(bk.location_id);
  const venue = await d.loadVenue(locationId);
  if (!venue) return say('unknown_link', 'We could not find this booking. Please check the link in your message.');
  const tz = String(venue.loc?.timezone || 'Europe/London');
  const [{ data: rawRules }, { data: locExtra }, pays, { data: ownTables }] = await Promise.all([
    d.db.from('booking_rules').select('*').eq('location_id', locationId).maybeSingle(),
    d.db.from('locations').select('address, receipt_branding').eq('id', locationId).maybeSingle(),
    readBookingPayments(d.db, String(bk.id)),
    d.db.from('booking_tables').select('table_id').eq('booking_id', bk.id),
  ]);
  // A guest cancel whose refund flag was lost is flagged now (the guest was told it would be).
  await healGuestCancel(d.db, bk, pays);
  const rr = (rawRules || {}) as Row;
  const rules = venue.rules || {};
  const contact = venueContact({ rules: rr, receiptBranding: locExtra?.receipt_branding, address: locExtra?.address || '' });
  const state = manageState({ booking: bk, rules: rr, tz });
  const pkg = bk.package_id
    ? (venue.packages || []).find((p: Row) => String(p.id) === String(bk.package_id))
      || (await d.db.from('packages').select('*').eq('id', bk.package_id).maybeSingle()).data || null
    : null;
  const currency = String(venue.loc?.currency || 'GBP').toUpperCase();
  const money = moneyOnBooking(pays || []);
  const hold = (pays || []).some((p: Row) => p.kind === 'hold' && p.status === 'authorised');
  // Money already flagged to go back (a cancel in time): said as such, never as "paid".
  const owedBackMinor = () => owedBackOnBooking(pays || []).owedBackMinor;
  const cust = (bk.customer || {}) as Row;
  const today = d.venueToday(tz);
  const maxCovers = Math.max(1, Math.min(maxPartyForCap(rules.pacingCap, 12), Number(pkg?.max_covers) || 12));
  const minCovers = Math.max(1, Number(pkg?.min_covers) || 1);
  const pkgTurn = pkg?.turn_minutes && Number(pkg.turn_minutes) > 0 ? Number(pkg.turn_minutes) : null;
  const myTables = (ownTables || []).map((r: Row) => String(r.table_id));
  if (!myTables.length && bk.primary_table_id) myTables.push(String(bk.primary_table_id));

  const summary = () => {
    const cal = calendarLinks({
      uid: `${bk.id}@serv-os.app`, title: `Table at ${venue.loc?.name || 'the venue'}`,
      date: bk.booking_date, time: bk.start_time, minutes: bk.turn_minutes, tz, address: contact.address,
    });
    return {
      ok: true,
      venue: venue.loc?.name || 'the venue',
      phone: contact.phone || null,
      address: contact.address || null,
      date: bk.booking_date,
      dateWords: fmtDateWords(bk.booking_date),
      time: hm(bk.start_time),
      party: bk.covers,
      status: bk.status,
      view: state.view,
      guestName: String(cust.name || '').trim().split(/\s+/)[0] || null,
      packageName: pkg?.name || null,
      canCancel: state.canCancel,
      canChange: state.canChange,
      why: state.why ? `${state.why}${/call the venue/i.test(state.why) && contact.phone ? ` The number is ${contact.phone}.` : ''}` : null,
      windowHours: state.windowHours,
      paidLine: money.capturedMinor > 0 ? `${moneyWords(money.capturedMinor, money.currency || currency)} paid`
        : owedBackMinor() > 0 ? `${moneyWords(owedBackMinor(), currency)} paid, to be refunded by the venue`
        : hold ? 'Card saved, nothing taken' : null,
      cancelNote: money.capturedMinor > 0
        ? `The ${moneyWords(money.capturedMinor, money.currency || currency)} you paid will be refunded by the venue.`
        : hold ? 'Nothing was taken from your card.' : null,
      today,
      maxDaysAhead: rules.maxDaysAhead ?? 90,
      minCovers,
      maxCovers: Math.max(maxCovers, Number(bk.covers) || 1),
      currency,
      calendar: { google: cal.google, ics: cal.ics },
    };
  };

  if (action === 'manage_info') return d.json(summary());

  // ── the day's quote, shared by slots and change ─────────────────────────────
  const dayContext = async (date: string, party: number) => {
    const bookings = await d.loadDayBookings(locationId, date);
    if (date === today) {
      try {
        const { data: sess } = await d.db.from('active_sessions').select('table_id, session').eq('location_id', locationId);
        const sessTables = (sess || []).filter((r: Row) => r.table_id).map((r: Row) => ({
          id: r.table_id,
          session: { seatedAt: r.session?.seatedAt, covers: r.session?.covers },
        }));
        bookings.push(...sessionsToBlocks(sessTables, bookings, rules.turnBands, d.venueNowMin(tz), d.epochToVenueMin(tz)));
      } catch { /* bookings only, as the booking page does */ }
    }
    // The tables a guest may be moved onto: the online ones, plus the ones this booking already
    // holds (the team may have put it on a table that is never sold online).
    const noOnline = new Set((rules.noOnlineTables || []).map(String));
    const tables = (venue.tables || []).filter((t: Row) => !noOnline.has(String(t.id)) || myTables.includes(String(t.id)));
    const sameCovers = Number(party) === Number(bk.covers);
    const turn = sameCovers && Number(bk.turn_minutes) > 0 ? Number(bk.turn_minutes) : (pkgTurn || turnFor(party, rules.turnBands));
    const others = bookings.filter((b: Row) => b.id !== bk.id);
    const candidates = (time: string) => {
      const start = toMin(time);
      const byId = new Map((venue.tables || []).map((t: Row) => [String(t.id), t]));
      // Keep the booking's own tables when they still seat the party and are free.
      const seats = myTables.reduce((s: number, id: string) => s + (Number(byId.get(id)?.covers) || 0), 0);
      const mineFree = myTables.length > 0 && seats >= party && myTables.every((id: string) => byId.has(id))
        && !others.some((b: Row) => !['departed', 'cancelled', 'no_show', 'expired'].includes(b.status)
          && (b.tables || []).some((t: string) => myTables.includes(String(t)))
          && b.startMin < start + turn && b.startMin + (Number(b.turnMinutes) || 90) > start);
      const list = suggestTables({
        party, time, tables, bookings, joinGroups: rules.joinGroups, turnBands: rules.turnBands, rules,
        limit: 3, turnMinutes: turn, skipBookingId: bk.id,
      });
      const sets = list.map((c: Row) => c.set as string[]);
      return mineFree ? [myTables, ...sets.filter((s: string[]) => s.join('+') !== myTables.join('+'))] : sets;
    };
    const kitchenFull = (time: string) => paceFull(paceAt(toMin(time), others), party, rules.pacingCap);
    return { turn, candidates, kitchenFull };
  };

  const checkInputs = (date: string, party: number) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Pick a date.';
    const ahead = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
    if (ahead < 0) return 'That date has gone. Pick today or a later day.';
    if (ahead > (rules.maxDaysAhead ?? 90)) return `Bookings open ${rules.maxDaysAhead ?? 90} days ahead. Pick an earlier date.`;
    if (party < minCovers) return `${pkg?.name || 'This booking'} is for ${minCovers} guests or more.`;
    if (party > Math.max(maxCovers, Number(bk.covers) || 1)) {
      return `For more than ${Math.max(maxCovers, Number(bk.covers) || 1)} guests, please call the venue${contact.phone ? ` on ${contact.phone}` : ''}.`;
    }
    if (date !== String(bk.booking_date) && (rules.blockedDates || []).includes(date)) return 'The venue is not taking bookings online on that date. Pick another day.';
    if (pkg && date !== String(bk.booking_date) && !packageOnDate(pkg, date)) return `${pkg.name} is not available on that date. Pick another day.`;
    return null;
  };

  if (action === 'manage_slots') {
    if (!state.canChange) return say('not_changeable', summary().why || 'This booking cannot be changed online.');
    const date = String(body.date || bk.booking_date);
    const party = Math.max(1, Math.round(Number(body.party) || Number(bk.covers) || 2));
    const bad = checkInputs(date, party);
    if (bad) return d.json({ ok: true, date, party, slots: [], message: bad });
    const ctx = await dayContext(date, party);
    const start = toMin(rules.serviceStart || '17:00'), end = toMin(rules.serviceEnd || '23:00');
    const step = Number(rules.slotMinutes) || 15;
    const nowGuard = date === today ? d.venueNowMin(tz) : -1;
    const slots: Row[] = [];
    for (let t = start; t < end; t += step) {
      const time = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      const reason = t <= nowGuard ? 'past' : ctx.kitchenFull(time) ? 'kitchen' : ctx.candidates(time).length === 0 ? 'tables' : null;
      slots.push({
        time, full: reason !== null, reason,
        current: date === String(bk.booking_date) && time === hm(bk.start_time) && party === Number(bk.covers),
      });
    }
    return d.json({ ok: true, date, party, slots });
  }

  if (action === 'manage_change') {
    if (!state.canChange) return say('not_changeable', summary().why || 'This booking cannot be changed online.');
    const date = String(body.date || '');
    const time = hm(body.time);
    const party = Math.max(1, Math.round(Number(body.party) || 0));
    if (!/^\d{2}:\d{2}$/.test(time)) return say('bad_input', 'Pick a time.');
    const bad = checkInputs(date, party);
    if (bad) return say('bad_input', bad);
    if (date === String(bk.booking_date) && time === hm(bk.start_time) && party === Number(bk.covers)) {
      return d.json({ ...summary(), unchanged: true });
    }
    // The party the money was taken for: the booking page's own request row (no browser can
    // write it). Only online bookings take money, so a booking without one falls back to its
    // party now.
    let paidCovers: number | null = null;
    if (money.capturedMinor > 0) {
      const { data: req } = await d.db.from('booking_requests').select('payload').eq('booking_id', bk.id)
        .order('created_at', { ascending: true }).limit(1);
      paidCovers = Number(req?.[0]?.payload?.party) || null;
    }
    const m = changeMoney({ pkg, oldCovers: bk.covers, newCovers: party, paidCovers, payments: pays || [] });
    if (m.state === 'needs_top_up') {
      return say('needs_top_up', `Adding guests to this booking needs ${moneyWords(m.diffMinor, m.currency || currency)} more, which cannot be paid online yet.${callLine(contact.phone)} The team can add them for you.`);
    }
    const tMin = toMin(time);
    const startMin = toMin(rules.serviceStart || '17:00'), endMin = toMin(rules.serviceEnd || '23:00');
    const timeKept = time === hm(bk.start_time);
    if (!timeKept && (tMin < startMin || tMin >= endMin)) return say('bad_input', 'That time is outside the venue\'s booking hours. Pick another.');
    if (date === today && tMin <= d.venueNowMin(tz)) return say('bad_input', 'That time has gone. Pick a later one.');
    const ctx = await dayContext(date, party);
    if (ctx.kitchenFull(time)) return say('slot_full', 'That time is fully booked. Please pick another.');
    const sets = ctx.candidates(time);
    if (!sets.length) return say('slot_gone', 'No table is free at that time. Please pick another.');

    // The edit stamp the Inspector shows: "Edited 17:42 by Guest online". It is written over the
    // guest details as they are NOW: edit_booking refuses with 'stale' when the host saved them
    // since this read (p_expected_edited_at), and the details are read again once.
    let cur = (bk.customer || {}) as Row;
    const stampOf = (c: Row) => ({ ...c, edited_by: 'Guest online', edited_at: new Date().toISOString() });
    let withStamp = true;       // an edit_booking older than 20261016b has no p_expected_edited_at
    let reread = false;
    const callEdit = async (set: string[]) => {
      const args: Row = {
        p_id: bk.id, p_location_id: locationId, p_booking_date: date, p_start_time: time,
        p_turn_minutes: ctx.turn, p_covers: party, p_table_ids: set, p_primary_table_id: set[0],
        p_note: null, p_customer: stampOf(cur),
      };
      if (withStamp) {
        const r = await d.db.rpc('edit_booking', { ...args, p_expected_edited_at: String(cur.edited_at ?? '') });
        if (!r.error || !isMissingFunctionError(r.error)) return r;
        withStamp = false;
      }
      return await d.db.rpc('edit_booking', args);
    };
    let done: Row | null = null;
    let last = '';
    for (let i = 0; i < sets.length; i++) {
      const set = sets[i];
      const { data, error } = await callEdit(set);
      if (error) {
        if (isMissingFunctionError(error)) return say('not_ready', NOT_READY);
        console.error('[booking-widget] manage_change edit_booking failed:', error.message);
        return say('failed', 'We could not change your booking just now. Please try again in a minute.');
      }
      if (data?.ok) { done = data; break; }
      last = String(data?.error || '');
      if (last === 'stale' && !reread) {
        // The host saved the guest's details a moment ago: keep their edit, try this table again.
        reread = true;
        const { data: fresh } = await d.db.from('bookings').select('customer').eq('id', bk.id).maybeSingle();
        cur = ((fresh?.customer) || {}) as Row;
        i -= 1;
        continue;
      }
      if (last === 'table_taken') continue;   // someone booked it between the quote and now
      if (last === 'no access') return say('not_ready', NOT_READY);   // migration 20261016c not run yet
      if (last === 'not_editable' || last === 'awaiting_payment') return say('not_changeable', 'This booking can no longer be changed online.');
      break;
    }
    if (!done) {
      return say(last === 'table_taken' ? 'slot_gone' : 'failed',
        last === 'table_taken' ? 'That time has just gone. Please pick another.' : 'We could not change your booking. Please pick another time, or call the venue.');
    }

    const before = `${fmtDateWords(bk.booking_date)} ${hm(bk.start_time)}, ${bk.covers} ${Number(bk.covers) === 1 ? 'guest' : 'guests'}`;
    const after = `${fmtDateWords(date)} ${time}, ${party} ${party === 1 ? 'guest' : 'guests'}`;
    // Fewer guests: pre-orders for seats that are no longer coming would still reach the kitchen
    // at seating (each pre-order row becomes a kitchen line). The guest said they are not coming.
    if (party < Number(bk.covers)) {
      const { error: poErr } = await d.db.from('booking_preorders').delete().eq('booking_id', bk.id).gt('seat', party);
      if (poErr) console.warn('[booking-widget] pre-orders past the new party not removed:', poErr.message);
    }
    // The figure stored on the rows is always the WHOLE amount owed back now: any older figure
    // is cleared first (these rows are captured and unused, so no close has written them), then
    // the new one is stored. 6 to 4 then back to 6 leaves nothing owed.
    let moneyText = '';
    if (money.rows.length && party !== Number(bk.covers)) {
      const { error: clrErr } = await d.db.from('booking_payments')
        .update({ refund_due_minor: null, refund_reason: null }).in('id', money.rows.map((r) => r.id));
      if (clrErr && !isMissingColumnError(clrErr)) console.error('[booking-widget] owed back not cleared:', clrErr.message);
    }
    if (m.state === 'owed_back') {
      moneyText = await flagOwedBack(d, money.rows, m.diffMinor, m.currency || currency, `The guest changed the party online from ${bk.covers} to ${party}`);
    }
    await d.db.from('activity_events').insert({
      location_id: locationId, kind: 'system', severity: moneyText ? 'action' : 'info',
      title: 'Guest changed their booking online',
      body: `${cust.name || 'A guest'}: ${before} is now ${after}.${moneyText ? ` ${moneyText}` : ''}`,
      ref_type: 'booking', ref_id: String(bk.id),
    }).then(({ error }: Row) => { if (error) console.warn('[booking-widget] change alert not written:', error.message); });
    const told = await notify(bk.id, 'changed');
    // Answer with the booking as it is now.
    const { data: fresh } = await d.db.from('bookings').select('*').eq('id', bk.id).maybeSingle();
    if (fresh) Object.assign(bk, fresh);
    return d.json({ ...summary(), changed: true, told, moneyNote: m.state === 'owed_back' ? `${moneyWords(m.diffMinor, m.currency || currency)} of what you paid will be refunded by the venue, unless you use it on the night.` : null });
  }

  if (action === 'manage_cancel') {
    if (!state.canCancel) return say('not_cancellable', summary().why || 'This booking cannot be cancelled online.');
    // Two writes: the cancel, then the refund flag. If the second is lost, healGuestCancel
    // flags it on the guest's next visit and the booking-reminders sweep within 5 minutes.
    const { data: moved, error: upErr } = await d.db.from('bookings')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: GUEST_CANCEL_REASON })
      .eq('id', bk.id).eq('status', bk.status).select('id');
    if (upErr) {
      console.error('[booking-widget] manage_cancel failed:', upErr.message);
      return say('failed', 'We could not cancel your booking just now. Please try again in a minute.');
    }
    if (!moved?.length) return say('changed_meanwhile', 'Your booking changed a moment ago. Please reload the page.');
    bk.status = 'cancelled';
    bk.cancel_reason = GUEST_CANCEL_REASON;
    // The urgent "refund the guest" alert on the venue's activity feed, and the rows kept out of
    // any bill (needs_refund). Nothing is refunded by itself.
    const owed = cancelMoney(pays || []);
    await healGuestCancel(d.db, bk, pays);
    await d.db.from('activity_events').insert({
      location_id: locationId, kind: 'system', severity: 'info',
      title: GUEST_CANCEL_REASON,
      body: `${cust.name || 'A guest'} cancelled ${fmtDateWords(bk.booking_date)} at ${hm(bk.start_time)}, ${bk.covers} ${Number(bk.covers) === 1 ? 'guest' : 'guests'}. The table is free again.`,
      ref_type: 'booking', ref_id: String(bk.id),
    }).then(({ error }: Row) => { if (error) console.warn('[booking-widget] cancel alert not written:', error.message); });
    const told = await notify(bk.id, 'cancelled');
    const s = manageState({ booking: bk, rules: rr, tz });
    const after = summary();
    return d.json({
      ...after, view: s.view, canCancel: false, canChange: false, why: s.why, cancelled: true, told,
      paidLine: owed.owedBackMinor > 0 ? `${moneyWords(owed.owedBackMinor, owed.currency || currency)} paid, to be refunded by the venue` : after.paidLine,
    });
  }

  return say('unknown_action', 'Unknown action.');
}

// Fewer guests on a paid booking: store what goes back on the captured rows (newest first) so the
// host stand shows "give back £X" and the till's close works out the final figure. Before
// migration 20261016b the columns are not there: the activity alert alone carries it.
async function flagOwedBack(d: Deps, rows: { id: string; amountMinor: number }[], diffMinor: number, currency: string, why: string): Promise<string> {
  const words = `${moneyWords(diffMinor, currency)} of what was paid goes back to the guest unless the bill uses it.`;
  let left = diffMinor;
  for (const r of [...rows].reverse()) {
    if (left <= 0) break;
    const take = Math.min(left, r.amountMinor);
    left -= take;
    const { error } = await d.db.from('booking_payments')
      .update({ refund_due_minor: take, refund_reason: `${why}: ${moneyWords(take, currency)} goes back to the guest unless the bill uses it.` })
      .eq('id', r.id);
    if (error) {
      if (!isMissingColumnError(error)) console.error('[booking-widget] owed back not stored:', error.message);
      break;
    }
  }
  return words;
}

// Tell the guest (booking-reminders works out the words, the money line and whether anything
// changed). Awaited with a short limit so the page can say "we have texted you".
async function notify(bookingId: string, kind: 'changed' | 'cancelled'): Promise<{ sms: boolean; email: boolean }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/booking-reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ action: 'notify', booking_id: bookingId, kind }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json().catch(() => ({}));
    return { sms: !!j?.results?.sms?.sent, email: !!j?.results?.email?.sent };
  } catch {
    return { sms: false, email: false };
  }
}

