// supabase/functions/booking-host
//
// HOST TOOLS (16 Oct 2026, v5.11.70 host track). The host stand is a paired
// tablet (a waitlist_devices row, an anonymous session), so the database's own
// rules refuse it the customers table, booking_requests and most of
// booking_payments. This function answers for it, fenced to the venue, with the
// service role, and returns only what the screens show.
//
// Caller, for the venue in location_id: a signed in Back Office user with
// access (isVenueWriter), a paired till (devices) or a paired host stand
// (waitlist_devices). Anything else is 403.
//
//   guest_facts      { customer_ids }            -> { facts: { [id]: { tags, visits, noShows } } }
//   money            { booking_id }              -> { rows, partialAllowed }   the booking's payments with what each can still refund
//   requests         {}                          -> { rows }                   the requests inbox
//   request_accept   { request_id, time?, by? }  -> { ok, bookingId, table }   books it through create_booking
//   request_decline  { request_id, message?, by? } -> { ok, sms }
//   pay_link         { booking_id, package_id?, kind?, by? } -> { ok, link, sms, status, due }
//
// Pure rules: ../_shared/bookingHost.js and ../_shared/payLink.js (node tested).
// Deploy: npx supabase functions deploy booking-host --project-ref tbetcegmszzotrwdtqhi

import { createClient } from 'npm:@supabase/supabase-js@2';
import { isVenueWriter } from '../_shared/venueWriter.js';
import { suggestTables, turnFor, toMin, sessionsToBlocks, DEFAULT_TURN_BANDS } from '../_shared/bookingOptimiser.js';
import { phoneMatchKey, phoneRegionFromCurrency, phoneRawText } from '../_shared/phoneKey.js';
import { readCustomerByPhone } from '../_shared/customerPhoneRead.js';
import { paymentDue, packagePaymentNeed } from '../_shared/bookingPayment.js';
import { isMissingColumnError } from '../_shared/bookingPromote.ts';
import {
  visibleTags, inboxRows, declineText, refundableMinor, refundRowsFor, refundedMinorFor,
  isRefundableRow, refundSuggestion, amountMinorOf, PAY_LINK_HOURS, payLinkText,
} from '../_shared/bookingHost.js';
import { payLinkToken, payLinkUrl } from '../_shared/payLink.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CUSTOMER_ROOT = Deno.env.get('CUSTOMER_ROOT') || 'dev.serv-os.app';
const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SERVICE_KEY') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platform = PLATFORM_URL && PLATFORM_KEY ? createClient(PLATFORM_URL, PLATFORM_KEY, { auth: { autoRefreshToken: false, persistSession: false } }) : null;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const venueToday = (tz: string) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
};
const venueNowMin = (tz: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [h, m] = parts.split(':').map(Number);
  return ((h === 24 ? 0 : h) || 0) * 60 + (m || 0);
};
const epochToVenueMin = (tz: string) => (ms: number) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  const [h, m] = parts.split(':').map(Number);
  return ((h === 24 ? 0 : h) || 0) * 60 + (m || 0);
};
const sayDate = (iso: string) => {
  try { return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00`)); } catch { return iso; }
};
const SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
const moneyText = (minor: number, currency: string) => {
  const c = String(currency || 'GBP').toUpperCase();
  const v = (Math.max(0, minor) / 100).toFixed(2);
  return SYMBOL[c] ? `${SYMBOL[c]}${v}` : `${c} ${v}`;
};

async function sendSms(to: string, message: string, locationId: string, type: string): Promise<{ sent: boolean; reason?: string }> {
  if (!to) return { sent: false, reason: 'no phone on the booking' };
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ to, message, location_id: locationId, type }),
    });
    if (!res.ok) return { sent: false, reason: `the text service answered ${res.status}` };
    return { sent: true };
  } catch {
    return { sent: false, reason: 'the text service could not be reached' };
  }
}

// The guest link base: the venue's own subdomain on the platform DB (the same
// lookup booking-reminders uses for the pre-order link).
async function linkBase(opsLocationId: string): Promise<string | null> {
  if (!platform) return null;
  try {
    let { data } = await platform.from('locations').select('online_slug').eq('ops_location_id', opsLocationId).maybeSingle();
    if (!data) ({ data } = await platform.from('locations').select('online_slug').eq('id', opsLocationId).maybeSingle());
    return data?.online_slug ? `https://${data.online_slug}.${CUSTOMER_ROOT}` : null;
  } catch { return null; }
}

async function venueOf(locationId: string): Promise<Row | null> {
  const { data } = await admin.from('locations').select('id, org_id, name, timezone, currency').eq('id', locationId).maybeSingle();
  return data || null;
}

// The day's bookings in the optimiser's shape (booking-widget loadDayBookings).
async function loadDayBookings(locationId: string, date: string) {
  const { data: rows } = await admin.from('bookings')
    .select('id, start_time, turn_minutes, covers, status, primary_table_id')
    .eq('location_id', locationId).eq('booking_date', date);
  const ids = (rows || []).map((b: Row) => b.id);
  const members = new Map<string, string[]>();
  if (ids.length) {
    const { data: bt } = await admin.from('booking_tables').select('booking_id, table_id').in('booking_id', ids);
    for (const r of bt || []) members.set(r.booking_id, [...(members.get(r.booking_id) || []), r.table_id]);
  }
  return (rows || []).map((b: Row) => ({
    id: b.id, tables: members.get(b.id) || [b.primary_table_id],
    startMin: toMin(String(b.start_time).slice(0, 5)), turnMinutes: b.turn_minutes, covers: b.covers, status: b.status,
  }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return json({ ok: false, error: 'Not signed in.' }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ ok: false, error: 'Not signed in.' }, 401);

  let body: Row = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
  const action = String(body.action || '');
  const locationId = String(body.location_id || '');
  if (!locationId || locationId === 'loc-demo') return json({ ok: false, error: 'location_id required' }, 400);

  const [asUser, till, host] = await Promise.all([
    isVenueWriter(admin, user, locationId).catch(() => false),
    admin.from('devices').select('id').eq('device_uid', user.id).eq('location_id', locationId).in('status', ['active', 'online']).limit(1).maybeSingle(),
    admin.from('waitlist_devices').select('id').eq('device_uid', user.id).eq('location_id', locationId).eq('active', true).limit(1).maybeSingle(),
  ]);
  if (!asUser && !till.data && !host.data) return json({ ok: false, error: 'This device is not paired to this venue.' }, 403);

  try {
    // ── guest tags and visits ────────────────────────────────────────────────
    if (action === 'guest_facts') {
      const ids = [...new Set((Array.isArray(body.customer_ids) ? body.customer_ids : []).map(String).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 30);
      if (!ids.length) return json({ ok: true, facts: {} });
      const venue = await venueOf(locationId);
      if (!venue?.org_id) return json({ ok: true, facts: {} });
      const { data: custs, error } = await admin.from('customers').select('id, tags, no_shows')
        .in('id', ids).eq('org_id', venue.org_id).is('deleted_at', null);
      if (error) return json({ ok: false, error: error.message }, 500);
      const facts: Record<string, unknown> = {};
      await Promise.all((custs || []).map(async (c: Row) => {
        // A visit is a closed check for the guest anywhere in the company (loyalty is company wide).
        const { count } = await admin.from('closed_checks').select('id', { count: 'exact', head: true }).eq('customer_id', c.id);
        facts[c.id] = { tags: visibleTags(c.tags), visits: count ?? null, noShows: Number(c.no_shows) || 0 };
      }));
      return json({ ok: true, facts });
    }

    // ── the booking's money, with what each payment can still refund ─────────
    if (action === 'money') {
      const bookingId = String(body.booking_id || '');
      if (!bookingId) return json({ ok: false, error: 'booking_id required' }, 400);
      const { data: bk } = await admin.from('bookings').select('id, location_id, status').eq('id', bookingId).maybeSingle();
      if (!bk || String(bk.location_id) !== locationId) return json({ ok: false, error: 'Booking not found at this venue.' }, 404);
      const BASE = 'id, kind, status, amount, currency, card_last4, card_brand, applied_to_check, psp_reference, merchant_reference, refusal_reason, created_at, refund_due_minor';
      // deno-lint-ignore no-explicit-any
      let res: any = await admin.from('booking_payments').select(`${BASE}, amount_refunded_minor, refund_of`).eq('booking_id', bookingId).order('created_at');
      let partialAllowed = true;
      if (res.error && isMissingColumnError(res.error)) {
        // Before 20261016d: no part refunds (the till would still count the whole payment).
        partialAllowed = false;
        res = await admin.from('booking_payments').select(BASE).eq('booking_id', bookingId).order('created_at');
        // Before 20261016b as well: no refund_due_minor either.
        if (res.error && isMissingColumnError(res.error)) res = await admin.from('booking_payments').select(BASE.replace(', refund_due_minor', '')).eq('booking_id', bookingId).order('created_at');
      }
      if (res.error) return json({ ok: false, error: res.error.message }, 500);
      const all = (res.data || []) as Row[];
      const rows = all.map((r) => ({
        id: r.id, kind: r.kind, status: r.status, amountMinor: amountMinorOf(r), currency: String(r.currency || 'gbp').toUpperCase(),
        card: [r.card_brand, r.card_last4 ? `···${r.card_last4}` : null].filter(Boolean).join(' ') || null,
        applied: !!r.applied_to_check, createdAt: r.created_at, reason: r.refusal_reason || null,
        refundDueMinor: Number(r.refund_due_minor) || 0,
        hasPsp: !!r.psp_reference,
        refundable: isRefundableRow(r),
        refundedMinor: r.kind === 'refund' ? 0 : refundedMinorFor(r, all),
        leftMinor: refundableMinor(r, all),
        suggestMinor: refundSuggestion(r, all),
        refunds: r.kind === 'refund' ? [] : refundRowsFor(r, all).map((x) => ({ id: x.id, status: x.status, amountMinor: amountMinorOf(x), createdAt: x.created_at, reason: x.refusal_reason || null })),
      }));
      return json({ ok: true, bookingStatus: bk.status, partialAllowed, rows });
    }

    // ── the requests inbox ───────────────────────────────────────────────────
    if (action === 'requests') {
      const venue = await venueOf(locationId);
      const since = new Date(Date.now() - 45 * 86400000).toISOString();
      const { data, error } = await admin.from('booking_requests').select('id, status, booking_id, payload, created_at')
        .eq('location_id', locationId).eq('status', 'pending').is('booking_id', null).gte('created_at', since)
        .order('created_at', { ascending: false }).limit(60);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, rows: inboxRows(data || [], venueToday(venue?.timezone || 'Europe/London')) });
    }

    if (action === 'request_accept' || action === 'request_decline') {
      const requestId = String(body.request_id || '');
      const by = String(body.by || '').slice(0, 60) || null;
      const { data: rq, error: rqErr } = await admin.from('booking_requests').select('id, location_id, status, booking_id, payload').eq('id', requestId).maybeSingle();
      if (rqErr) return json({ ok: false, error: rqErr.message }, 500);
      if (!rq || String(rq.location_id) !== locationId) return json({ ok: false, error: 'Request not found at this venue.' }, 404);
      if (rq.status !== 'pending' || rq.booking_id) return json({ ok: false, error: 'This request has been dealt with already.' });
      const p = (rq.payload || {}) as Row;
      const venue = await venueOf(locationId);
      if (!venue) return json({ ok: false, error: 'Venue not found.' }, 404);
      const region = phoneRegionFromCurrency(venue.currency);

      if (action === 'request_decline') {
        const message = String(body.message || '').slice(0, 400);
        const { data: moved } = await admin.from('booking_requests')
          .update({ status: 'rejected', payload: { ...p, declined: { by, at: new Date().toISOString(), message: message || null } } })
          .eq('id', requestId).eq('status', 'pending').select('id');
        if (!moved?.length) return json({ ok: false, error: 'This request has been dealt with already.' });
        const to = phoneMatchKey(String(p.phone || ''), region) || '';
        const sms = body.send_sms === false ? { sent: false, reason: 'not asked to text' }
          : await sendSms(to, declineText({ venue: venue.name, name: p.name, message }), locationId, 'booking_request_declined');
        return json({ ok: true, sms });
      }

      // request_accept: book it the way the booking page books, on the server.
      const date = String(p.date || '');
      const time = String(body.time || p.time || '').slice(0, 5);
      const party = Math.max(1, Math.round(Number(body.party || p.party) || 2));
      const tz = venue.timezone || 'Europe/London';
      const today = venueToday(tz);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) return json({ ok: false, error: 'This request is for a day that has gone. Call the guest to rebook.' });
      if (!/^\d{2}:\d{2}$/.test(time)) return json({ ok: false, error: 'The request has no time. Call the guest, then book on the Book screen.' });
      const [{ data: rulesRow }, { data: floor }] = await Promise.all([
        admin.from('booking_rules').select('*').eq('location_id', locationId).maybeSingle(),
        admin.from('floor_tables').select('id, label, max_covers, section').eq('location_id', locationId),
      ]);
      const turnBands = rulesRow
        ? { '1-2': rulesRow.turn_1_2, '3-4': rulesRow.turn_3_4, '5-6': rulesRow.turn_5_6, '7+': rulesRow.turn_7_plus }
        : DEFAULT_TURN_BANDS;
      const rules = {
        maxJoin: rulesRow?.max_join, tolerance: rulesRow?.waste_tolerance,
        protectLargeTables: rulesRow?.protect_large_tables !== false,
      };
      const tables = (floor || []).map((t: Row) => ({ id: t.id, label: t.label || t.id, covers: t.max_covers || 2, section: t.section || null }));
      const bookings = await loadDayBookings(locationId, date);
      if (date === today) {
        try {
          const { data: sess } = await admin.from('active_sessions').select('table_id, session').eq('location_id', locationId);
          const sessTables = (sess || []).filter((r: Row) => r.table_id).map((r: Row) => ({ id: r.table_id, session: { seatedAt: r.session?.seatedAt, covers: r.session?.covers } }));
          bookings.push(...sessionsToBlocks(sessTables, bookings, turnBands, venueNowMin(tz), epochToVenueMin(tz)));
        } catch { /* bookings only */ }
      }
      const candidates = suggestTables({ party, time, tables, bookings, joinGroups: Array.isArray(rulesRow?.join_groups) ? rulesRow.join_groups : [], turnBands, rules, limit: 3 });
      if (!candidates.length) {
        return json({ ok: false, error: `No table is free for ${party} at ${time} on ${sayDate(date)}. Call the guest to offer another time.` });
      }
      // The guest on the company's guest book (only fill blanks, the same as the booking page).
      const name = String(p.name || 'Guest').slice(0, 80);
      const phone = phoneMatchKey(String(p.phone || ''), region);
      const email = String(p.email || '').trim().toLowerCase() || null;
      let customerId: string | null = null;
      let allergens: string[] = [];
      if (phone) {
        const { data: existing } = await readCustomerByPhone(admin, { orgId: venue.org_id, phone: String(p.phone || ''), region, cols: 'id, name, email, allergens' });
        if (existing) {
          customerId = existing.id;
          allergens = existing.allergens || [];
          const patch: Row = {};
          if (!existing.name && name) patch.name = name;
          if (!existing.email && email) patch.email = email;
          if (Object.keys(patch).length) await admin.from('customers').update(patch).eq('id', existing.id);
        } else {
          const { data: created } = await admin.from('customers')
            .insert({ org_id: venue.org_id, name, phone, phone_raw: phoneRawText(p.phone) || phone, email, source: 'booking_widget' })
            .select('id').maybeSingle();
          customerId = created?.id || null;
        }
      }
      const note = [String(p.note || '').slice(0, 250), 'From an online request'].filter(Boolean).join(' · ');
      let bookedId: string | null = null;
      let tableLabel: string | null = null;
      for (const c of candidates) {
        const id = `bk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const { data: res } = await admin.rpc('create_booking', {
          p_id: id, p_location_id: locationId, p_booking_date: date, p_start_time: time,
          p_turn_minutes: turnFor(party, turnBands), p_covers: party, p_table_ids: c.set, p_primary_table_id: c.set[0],
          p_customer_id: customerId, p_customer: { name, phone, email, allergens },
          p_status: 'confirmed', p_source: 'host', p_package_id: null, p_note: note, p_created_by: by || 'request',
        });
        if (res?.ok) { bookedId = id; tableLabel = c.label; break; }
      }
      if (!bookedId) return json({ ok: false, error: `Those tables were just taken. Try again, or book ${party} by hand on the Book screen.` });
      await admin.from('booking_requests')
        .update({ status: 'accepted', booking_id: bookedId, payload: { ...p, accepted: { by, at: new Date().toISOString() } } })
        .eq('id', requestId);
      fetch(`${SUPABASE_URL}/functions/v1/booking-reminders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
        body: JSON.stringify({ action: 'confirm', booking_id: bookedId }),
      }).catch(() => {});
      return json({ ok: true, bookingId: bookedId, table: tableLabel, date, time, party });
    }

    // ── pay link from the stand ──────────────────────────────────────────────
    if (action === 'pay_link') {
      const bookingId = String(body.booking_id || '');
      const by = String(body.by || '').slice(0, 60) || null;
      const BASE = 'id, location_id, status, covers, customer, customer_id, package_id, booking_date, start_time, source, payment_kind, payment_due_minor, payment_currency';
      // deno-lint-ignore no-explicit-any
      let res: any = await admin.from('bookings').select(`${BASE}, pay_link_until`).eq('id', bookingId).maybeSingle();
      let windowColumn = true;
      if (res.error && isMissingColumnError(res.error)) { windowColumn = false; res = await admin.from('bookings').select(BASE).eq('id', bookingId).maybeSingle(); }
      if (res.error) return json({ ok: false, error: res.error.message }, 500);
      const bk = res.data as Row | null;
      if (!bk || String(bk.location_id) !== locationId) return json({ ok: false, error: 'Booking not found at this venue.' }, 404);
      if (!['confirmed', 'pending_payment'].includes(bk.status)) return json({ ok: false, error: 'A pay link can only go to a booking that is waiting, not one seated, finished or cancelled.' });
      const venue = await venueOf(locationId);
      if (!venue) return json({ ok: false, error: 'Venue not found.' }, 404);
      const region = phoneRegionFromCurrency(venue.currency);
      const to = phoneMatchKey(String(bk.customer?.phone || ''), region);
      if (!to) return json({ ok: false, error: 'This booking has no mobile number. Add one with Edit, then send the link.' });
      const { data: paidRows } = await admin.from('booking_payments').select('id').eq('booking_id', bookingId).in('status', ['authorised', 'captured']).neq('kind', 'refund');
      if (paidRows?.length) return json({ ok: false, error: 'This booking has a payment already.' });

      // What is due: a package that needs payment (picked now or already on the
      // booking), or a card hold at the venue's hold per cover.
      const [{ data: rulesRow }, pkgRes] = await Promise.all([
        admin.from('booking_rules').select('hold_per_cover').eq('location_id', locationId).maybeSingle(),
        (body.package_id || bk.package_id)
          ? admin.from('packages').select('*').eq('id', String(body.package_id || bk.package_id)).eq('location_id', locationId).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      const pkg = (pkgRes as { data: Row | null }).data;
      if (body.package_id && !pkg) return json({ ok: false, error: 'That package is not on this venue.' });
      const wantHold = body.kind === 'hold' || !packagePaymentNeed(pkg).needsPayment;
      const due = wantHold
        ? paymentDue({ covers: bk.covers, pkg: null, rules: { card_capture_enabled: true, card_capture_min_covers: 0, hold_per_cover: rulesRow?.hold_per_cover } })
        : paymentDue({ covers: bk.covers, pkg, rules: null });
      if (!due) return json({ ok: false, error: wantHold ? 'Set a card hold per cover in Rules first, or pick a package that takes a deposit or prepay.' : 'That package takes no payment.' });
      const currency = String(venue.currency || (region === 'US' ? 'USD' : 'GBP')).toUpperCase();

      const base = await linkBase(locationId);
      const tok = await payLinkToken(SERVICE_ROLE, bookingId);
      const link = payLinkUrl(base, bookingId, tok);
      if (!link) return json({ ok: false, error: 'This venue has no booking page address yet (Back Office, Location settings, venue slug).' });

      // Store what is due (the trigger lets only the service role write it).
      // After the migration the booking waits as pending_payment while the link
      // is live; before it, the booking stays confirmed and the link still works.
      const until = new Date(Date.now() + PAY_LINK_HOURS * 3600000).toISOString();
      const patch: Row = {
        payment_kind: due.kind, payment_due_minor: due.amountMinor, payment_currency: currency,
        ...(pkg && !wantHold && String(bk.package_id || '') !== String(pkg.id) ? { package_id: pkg.id } : {}),
        ...(windowColumn ? { status: 'pending_payment', pay_link_until: until, pay_link_sent_at: new Date().toISOString() } : {}),
      };
      const { error: upErr } = await admin.from('bookings').update(patch).eq('id', bookingId).in('status', ['confirmed', 'pending_payment']);
      if (upErr) return json({ ok: false, error: `Could not save what is due: ${upErr.message}` }, 500);
      // The audit row booking_pay reads (the package and party), so the charge
      // is checked against it like a booking made online.
      await admin.from('booking_requests').insert({
        location_id: locationId, status: 'accepted', booking_id: bookingId,
        payload: { kind: 'pay_link', party: bk.covers, package_id: pkg && !wantHold ? String(pkg.id) : null, by, due_kind: due.kind, due_minor: due.amountMinor },
      });
      const text = payLinkText({
        venue: venue.name, name: bk.customer?.name, date: sayDate(String(bk.booking_date)), time: String(bk.start_time).slice(0, 5),
        kind: due.kind, amountText: moneyText(due.amountMinor, currency), link,
      });
      const sms = await sendSms(to, text, locationId, 'booking_pay_link');
      return json({ ok: true, link, sms, status: windowColumn ? 'pending_payment' : bk.status, waitsUntil: windowColumn ? until : null, due: { ...due, currency } });
    }

    return json({ ok: false, error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[booking-host]', action, e);
    return json({ ok: false, error: (e as Error).message || 'server error' }, 500);
  }
});
