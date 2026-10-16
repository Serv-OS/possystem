// supabase/functions/booking-reminders/index.ts
//
// Every message a booking guest gets: the confirmation, the reminders, the change and cancel
// messages, and the pre-order link.
//
// Actions:
//   confirm   {booking_id}, booking confirmation SMS + email, each channel at most once via the
//             booking_reminders ledger (safe to re-fire). Called by the booking page, the payment
//             promote paths, and (16 Oct 2026) the web app right after the host stand, the till or
//             Back Office makes a booking.
//   notify    {booking_id, kind: 'changed' | 'cancelled'}, 16 Oct 2026: tell the guest their
//             booking changed or was cancelled. Called by the guest's own manage page
//             (booking-widget). The words, the money line and whether anything changed are all
//             worked out here from the booking itself, never from the caller, so a repeated or a
//             made up call can only ever send the true message once.
//   send_link {booking_id}, v5.7.21 link-first flow: mints preorder_token if missing, sends the
//             guest their choose-your-menu link by email + SMS, and answers HONEST per-channel
//             results. Called by the Diary Inspector's "Send pre-order link" button and the
//             booking page. Resendable: a 60s per-channel throttle stops accidental double-taps.
//   send_due , the sweep, run by pg_cron every 5 minutes (migration 20261016c; it was every 15)
//             with NO host stand open. 17 Oct 2026 (v5.11.73): behind a cron key. Only the
//             service role, or the cron job's x-cron-key header (a random key kept only in the
//             database vault, checked by public.booking_reminders_cron_ok, migration 20261017a),
//             may start it; until that migration runs it stays open as before
//             (_shared/cronKey.js). The host stand no longer starts it.
//               1. the pre-order nag (choices outstanding once the deadline window opens)
//               2. 16 Oct 2026: visit reminders, the day before (10:00 to 21:00 venue time) and
//                  2 hours before; the confirmation backstop for a booking made in the last 2
//                  hours that never had one; a change or cancel made by the team, told within 5
//                  minutes
//               3. 16 Oct 2026: retries. A failed send is kept on the ledger with its reason and
//                  tried again after 10 then 30 minutes, at most 3 times, and never again for a
//                  number that can never work. (It used to delete the ledger row and retry every
//                  15 minutes for ever: 101 failed texts to one demo number on 16 Oct.)
//             The response lists what it sent and why it skipped the rest.
//
// THE LEDGER. booking_reminders, one row per booking, kind and channel. Before migration
// 20261016c it has no status column: this function then runs exactly the old pre-order nag and
// confirmations, and everything new waits (each request checks which ledger it has).
//
// Pure rules (when a reminder is due, when to retry, the merge tags, the calendar link) live in
// _shared/bookingGuest.js, tested in src/lib/bookings/bookingGuest.test.js.
//
// Transport mirrors order-notify: SMS via the send-sms fn (lands in the sms_messages audit, with
// the booking id as reference_id), email via Resend/Postmark (RECEIPT_EMAIL_* envs). The words
// come from Back Office > Message templates (company scoped); a template switched off there is
// really not sent.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { resolveAndRender, wrapInEmailHtml, substituteTags } from '../_shared/template-resolver.ts';
import { getDefaultTemplate } from '../_shared/message-types.ts';
import { platformAdmin } from '../_shared/gift-card-utils.ts';
import { pagedRows } from '../_shared/pagedRows.js';
import {
  LIVE_FOR_GUEST, MAX_SEND_ATTEMPTS, reminderDue, confirmationToSend, cancelToTell, changeToTell,
  snapshotOf, sameSnapshot, reminderIsStale, nextAttempt, isPermanentFailure, calendarLinks, guestTemplateData, manageUrl,
  venueContact, moneyWords, zonedToEpoch, owedBackOnBooking,
} from '../_shared/bookingGuest.js';
import { manageTokenFor, readBookingPayments, healGuestCancel, GUEST_CANCEL_REASON } from '../_shared/bookingGuestDb.ts';
import { CRON_KEY_HEADER, CRON_KEY_CHECK, isServiceRoleBearer, sweepAccess } from '../_shared/cronKey.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const EMAIL_PROVIDER = (Deno.env.get('RECEIPT_EMAIL_PROVIDER') || 'log').toLowerCase();
const EMAIL_FROM = Deno.env.get('RECEIPT_EMAIL_FROM') || 'hello@posup.co.uk';
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const POSTMARK_KEY = Deno.env.get('POSTMARK_API_TOKEN') ?? '';
const CUSTOMER_ROOT = Deno.env.get('CUSTOMER_ROOT') || 'dev.serv-os.app';

const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SERVICE_KEY') ?? '';

const db = createClient(SUPABASE_URL, SERVICE_ROLE);
const platform = PLATFORM_URL && PLATFORM_KEY ? createClient(PLATFORM_URL, PLATFORM_KEY) : null;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${iso}T12:00:00`));

const venueToday = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Honest transport results: {sent, reason?}. A false without a reason is a
// bug, every failure path names itself so callers can surface it.
type SendResult = { sent: boolean; reason?: string };
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

type Kind = 'confirmation' | 'preorder' | 'reminder_day' | 'reminder_2h' | 'changed' | 'cancelled';
type Channel = 'email' | 'sms';
const TYPE_OF: Record<Kind, string> = {
  confirmation: 'booking_confirmation',
  preorder: 'booking_preorder_reminder',
  reminder_day: 'booking_reminder',
  reminder_2h: 'booking_reminder',
  changed: 'booking_changed',
  cancelled: 'booking_cancelled',
};
// The kinds the ledger allowed before migration 20261016c.
const V1_KINDS: Kind[] = ['confirmation', 'preorder'];

async function sendSms(to: string, message: string, locationId: string, type = 'booking_preorder_reminder', referenceId: string | null = null): Promise<SendResult> {
  if (!to) return { sent: false, reason: 'no_phone_on_booking' };
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ to, message, location_id: locationId, type, ...(referenceId ? { reference_id: referenceId } : {}) }),
    });
    if (!res.ok) {
      // The provider's words ride along, so a number that can never work is not retried.
      let why = '';
      try { why = String((await res.json())?.error || '').slice(0, 200); } catch { /* no body */ }
      return { sent: false, reason: `send-sms_http_${res.status}${why ? `: ${why}` : ''}` };
    }
    return { sent: true };
  } catch {
    return { sent: false, reason: 'send-sms_unreachable' };
  }
}

async function sendEmail(to: string, subject: string, html: string): Promise<SendResult> {
  if (!to) return { sent: false, reason: 'no_email_on_booking' };
  try {
    if (EMAIL_PROVIDER === 'resend' && RESEND_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
      });
      if (!res.ok) return { sent: false, reason: `resend_http_${res.status}` };
      return { sent: true };
    }
    if (EMAIL_PROVIDER === 'postmark' && POSTMARK_KEY) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'X-Postmark-Server-Token': POSTMARK_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ From: EMAIL_FROM, To: to, Subject: subject, HtmlBody: html }),
      });
      if (!res.ok) return { sent: false, reason: `postmark_http_${res.status}` };
      return { sent: true };
    }
    // The old silent killer: provider 'log' (the default) or a provider whose
    // key is missing meant every email quietly went nowhere.
    return { sent: false, reason: `email_provider_not_configured_(${EMAIL_PROVIDER})` };
  } catch {
    return { sent: false, reason: 'email_provider_unreachable' };
  }
}

// The guest link lives on the venue's own subdomain (platform slug); the same
// platform row carries company_id, which scopes the operator's custom
// message templates (message_templates is company-keyed). base:null always
// comes with a reason now, the old nulls were the silent-skip trap.
async function venueMeta(opsLocationId: string): Promise<{ base: string | null; companyId: string; reason?: string }> {
  if (!platform) return { base: null, companyId: '', reason: 'platform_env_missing_(PLATFORM_SUPABASE_URL/KEY)' };
  try {
    const select = 'online_slug, company_id';
    let { data } = await platform.from('locations').select(select).eq('ops_location_id', opsLocationId).maybeSingle();
    if (!data) ({ data } = await platform.from('locations').select(select).eq('id', opsLocationId).maybeSingle());
    if (!data) return { base: null, companyId: '', reason: 'no_platform_location_row' };
    if (!data.online_slug) return { base: null, companyId: (data.company_id as string) || '', reason: 'no_online_slug_on_platform_location' };
    return {
      base: `https://${data.online_slug}.${CUSTOMER_ROOT}`,
      companyId: (data.company_id as string) || '',
    };
  } catch {
    return { base: null, companyId: '', reason: 'platform_lookup_failed' };
  }
}

// ── the venue, read once per request ─────────────────────────────────────────
type Venue = {
  id: string; name: string; tz: string; currency: string; phone: string; address: string;
  base: string | null; baseReason?: string; companyId: string;
  messagesOn: boolean; manageOn: boolean;
};
async function loadVenue(locationId: string, cache: Map<string, Promise<Venue>>): Promise<Venue> {
  if (!cache.has(locationId)) {
    cache.set(locationId, (async () => {
      const [{ data: loc }, { data: rules }, meta] = await Promise.all([
        db.from('locations').select('id, name, timezone, currency, address, receipt_branding').eq('id', locationId).maybeSingle(),
        // '*' so the 20261016c columns are read when they exist and simply absent before.
        db.from('booking_rules').select('*').eq('location_id', locationId).maybeSingle(),
        venueMeta(locationId),
      ]);
      const r = (rules || {}) as Row;
      const contact = venueContact({ rules: r, receiptBranding: loc?.receipt_branding, address: loc?.address || '' });
      return {
        id: locationId,
        name: loc?.name || 'the venue',
        tz: loc?.timezone || 'Europe/London',
        currency: String(loc?.currency || 'GBP').toUpperCase(),
        phone: contact.phone,
        address: contact.address,
        base: meta.base,
        baseReason: meta.reason,
        companyId: meta.companyId,
        messagesOn: r.guest_messages_enabled !== false,
        manageOn: r.guest_manage_enabled !== false,
      };
    })());
  }
  return await cache.get(locationId)!;
}

// A template the operator switched off in Back Office > Message templates is not sent.
// (resolveAndRender alone falls back to the default for a switched off row.)
async function templateOff(companyId: string, type: string, channel: Channel): Promise<boolean> {
  if (!companyId) return false;
  try {
    const { data } = await platformAdmin.from('message_templates').select('enabled')
      .eq('company_id', companyId).eq('message_type', type).eq('channel', channel).maybeSingle();
    return data?.enabled === false;
  } catch { return false; }
}

// The operator's words, else the registry default (rendered here when the template store
// cannot be reached, so a platform blip never blocks a booking message).
async function renderTpl(companyId: string, type: string, channel: Channel, data: Record<string, string>): Promise<{ subject?: string; body: string } | null> {
  try {
    const r = await resolveAndRender(companyId, type, channel, data);
    if (r) return r;
  } catch { /* fall through to the default */ }
  const def = getDefaultTemplate(type, channel);
  return def ? { subject: def.subject ? substituteTags(def.subject, data) : undefined, body: substituteTags(def.body, data) } : null;
}

const unescapeHtml = (s: string) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const escapeHtml = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Bare links become buttons with short words (a calendar link is 300 characters long).
const linkWords = (url: string) => (/calendar\.google\.com/.test(url) ? 'Google Calendar'
  : /\/book\?manage=/.test(url) ? 'open your booking'
  : /\/book\?preorder=/.test(url) ? 'pick your dishes' : url);
const linkify = (html: string) => html.replace(/(?<![="'>])(https?:\/\/[^\s<"]+)/g,
  (u) => `<a href="${u}" style="color:#15C26A;font-weight:600;">${linkWords(u)}</a>`);
// Empty *_line tags leave blank lines and double spaces behind: tidy them.
const tidyText = (s: string) => String(s || '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const pkgCache = new Map<string, Promise<Row | null>>();
const pkgRow = (id: string | null) => {
  if (!id) return Promise.resolve(null);
  if (!pkgCache.has(id)) {
    pkgCache.set(id, (async () => (await db.from('packages').select('id, name, requires_preorder, preorder_days_before').eq('id', id).maybeSingle()).data || null)());
  }
  return pkgCache.get(id)!;
};

// What the guest is owed back, worked out from the ledger (never from the caller). Net of any
// part refund already made (amount_refunded_minor, migration 20261016d).
async function moneyLineFor(kind: Kind, bookingId: string, currency: string): Promise<string> {
  if (kind !== 'cancelled' && kind !== 'changed') return '';
  try {
    if (kind === 'cancelled') {
      const owed = owedBackOnBooking(await readBookingPayments(db, bookingId));
      return owed.owedBackMinor > 0 ? `The ${moneyWords(owed.owedBackMinor, owed.currency || currency)} you paid will be refunded by the venue. ` : '';
    }
    const { data, error } = await db.from('booking_payments').select('currency, status, refund_due_minor').eq('booking_id', bookingId);
    if (error) return '';   // before 20261016b there is no refund_due_minor
    const due = (data || []).filter((p: Row) => p.status === 'captured' && Number(p.refund_due_minor) > 0);
    const minor = due.reduce((s: number, p: Row) => s + Number(p.refund_due_minor), 0);
    return minor > 0 ? `${moneyWords(minor, due[0]?.currency || currency)} of what you paid will be refunded, unless you use it on the night. ` : '';
  } catch { return ''; }
}

type Composed = { to: string; type: string; subject?: string; html?: string; text?: string; detail: Row } | { skip: string };

// Build one message for one channel, or say why it is not sent.
async function compose(kind: Kind, channel: Channel, bk: Row, venue: Venue, opts: { force?: boolean } = {}): Promise<Composed> {
  const type = TYPE_OF[kind];
  const cust = (bk.customer || {}) as Row;
  const to = channel === 'sms' ? String(cust.phone || '').trim() : String(cust.email || '').trim();
  if (!to) return { skip: channel === 'sms' ? 'no_phone_on_booking' : 'no_email_on_booking' };
  if (!venue.messagesOn && !opts.force) return { skip: 'venue_turned_booking_messages_off' };
  if (await templateOff(venue.companyId, type, channel)) return { skip: 'turned_off_in_message_templates' };
  const pkg = await pkgRow(bk.package_id || null);
  // The guest's code lives in booking_manage_tokens (closed to the anon key), not on bookings.
  const manageLink = venue.manageOn && kind !== 'cancelled' && venue.base
    ? manageUrl(venue.base, await manageTokenFor(db, bk)) : '';
  const cal = kind === 'cancelled' ? { google: null } : calendarLinks({
    uid: `${bk.id}@serv-os.app`, title: `Table at ${venue.name}`, date: bk.booking_date, time: bk.start_time,
    minutes: bk.turn_minutes, tz: venue.tz, address: venue.address,
    details: manageLink ? `Change or cancel: ${manageLink}` : '',
  });
  const preorderLink = (kind === 'confirmation' || kind === 'preorder') && bk.preorder_token && venue.base
    ? `${venue.base}/book?preorder=${bk.preorder_token}` : '';
  if (kind === 'preorder' && !preorderLink) return { skip: `no_link_base_${venue.baseReason || 'no_token'}` };
  const data = guestTemplateData({
    booking: bk, venueName: venue.name, venuePhone: venue.phone, venueAddress: venue.address,
    manageLink, calendarLink: cal.google || '', preorderLink,
    packageName: pkg?.name ? String(pkg.name) : (kind === 'preorder' ? 'your package' : ''),
    when: kind === 'reminder_day' ? 'tomorrow' : kind === 'reminder_2h' ? 'today' : '',
    moneyLine: await moneyLineFor(kind, String(bk.id), venue.currency),
  }) as Record<string, string>;
  if (channel === 'sms') {
    const r = await renderTpl(venue.companyId, type, 'sms', data);
    if (!r?.body) return { skip: 'no_template' };
    return { to, type, text: tidyText(r.body), detail: snapshotOf(bk) };
  }
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) safe[k] = escapeHtml(v);
  const r = await renderTpl(venue.companyId, type, 'email', safe);
  if (!r?.body) return { skip: 'no_template' };
  return {
    to, type, subject: unescapeHtml(tidyText(r.subject || `${venue.name}: your booking`)),
    html: linkify(wrapInEmailHtml(tidyText(r.body), { venueName: escapeHtml(venue.name) })),
    detail: snapshotOf(bk),
  };
}

// A 'sending' claim older than this never finished (the function hit its time limit, was
// stopped, or lost the database between claim and settle). It counts as a failed try.
const STALE_CLAIM_MS = 10 * 60000;
const claimIsStale = (sentAt: unknown) => {
  const t = Date.parse(String(sentAt || ''));
  return !Number.isFinite(t) || Date.now() - t >= STALE_CLAIM_MS;
};

const isUnique = (e: Row | null) => String(e?.code || '') === '23505' || /duplicate key/i.test(String(e?.message || ''));

// Claim, send and settle one message.
//   mode 'once'    insert the ledger row first (the unique key means only one sender wins)
//   mode 'change'  re-claim the row when what the guest is told has changed since the last try
//   mode 'retry'   the caller already claimed the row (rowId, attempts)
async function deliver(p: {
  kind: Kind; channel: Channel; bk: Row; venue: Venue; v2: boolean;
  mode?: 'once' | 'change' | 'retry'; rowId?: string; attempts?: number; force?: boolean;
}): Promise<SendResult> {
  const { kind, channel, bk, venue, v2 } = p;
  const mode = p.mode || 'once';
  if (!v2 && !V1_KINDS.includes(kind)) return { sent: false, reason: 'needs_migration_20261016c' };
  const msg = await compose(kind, channel, bk, venue, { force: p.force });
  if ('skip' in msg) {
    if (mode === 'retry' && p.rowId) {
      await db.from('booking_reminders').update({ status: 'failed', attempts: MAX_SEND_ATTEMPTS, last_error: `not sent: ${msg.skip}`, next_try_at: null }).eq('id', p.rowId);
    }
    return { sent: false, reason: msg.skip };
  }
  let rowId = p.rowId || null;
  let attempts = p.attempts || 1;
  const nowIso = new Date().toISOString();
  if (!v2) {
    const { error } = await db.from('booking_reminders')
      .insert({ location_id: bk.location_id, booking_id: bk.id, kind, channel, sent_to: msg.to });
    if (error) return { sent: false, reason: 'already_sent_(ledger)' };
  } else if (mode === 'once') {
    const { data, error } = await db.from('booking_reminders')
      .insert({ location_id: bk.location_id, booking_id: bk.id, kind, channel, sent_to: msg.to, status: 'sending', attempts: 1, detail: msg.detail, sent_at: nowIso })
      .select('id').maybeSingle();
    if (error) return { sent: false, reason: isUnique(error) ? 'already_sent_(ledger)' : `ledger_refused_${error.code || 'write'}` };
    rowId = data?.id || null;
  } else if (mode === 'change') {
    const { data: prev } = await db.from('booking_reminders').select('id, status, sent_at, detail')
      .eq('booking_id', bk.id).eq('kind', kind).eq('channel', channel).maybeSingle();
    if (!prev) {
      const { data, error } = await db.from('booking_reminders')
        .insert({ location_id: bk.location_id, booking_id: bk.id, kind, channel, sent_to: msg.to, status: 'sending', attempts: 1, detail: msg.detail, sent_at: nowIso })
        .select('id').maybeSingle();
      if (error) return { sent: false, reason: isUnique(error) ? 'already_sent_(ledger)' : `ledger_refused_${error.code || 'write'}` };
      rowId = data?.id || null;
    } else {
      // A claim younger than 10 minutes is another sender at work. An older one never finished
      // (the function was stopped between claim and settle): it is claimed again below.
      if (prev.status === 'sending' && !claimIsStale(prev.sent_at)) return { sent: false, reason: 'already_sending' };
      const { data: claimed } = await db.from('booking_reminders')
        .update({ status: 'sending', attempts: 1, detail: msg.detail, sent_to: msg.to, sent_at: nowIso, last_error: null, next_try_at: null })
        .eq('id', prev.id).eq('sent_at', prev.sent_at).select('id');
      if (!claimed?.length) return { sent: false, reason: 'already_sending' };
      rowId = String(prev.id);
    }
    attempts = 1;
  }

  const res = channel === 'sms'
    ? await sendSms(msg.to, msg.text || '', bk.location_id, msg.type, String(bk.id))
    : await sendEmail(msg.to, msg.subject || '', msg.html || '');

  if (!v2) {
    // The old ledger: a failed send gives the row back (the old retry behaviour).
    if (!res.sent) await db.from('booking_reminders').delete().eq('booking_id', bk.id).eq('kind', kind).eq('channel', channel);
    return res;
  }
  if (rowId) {
    // detail and sent_to say what THIS try told the guest (a retry renders the booking as it is
    // now), so the change check never sends the same change twice.
    if (res.sent) {
      await db.from('booking_reminders').update({ status: 'sent', last_error: null, next_try_at: null, sent_at: new Date().toISOString(), detail: msg.detail, sent_to: msg.to }).eq('id', rowId);
    } else {
      const plan = nextAttempt({ attempts, permanent: isPermanentFailure(res.reason) });
      await db.from('booking_reminders').update({
        status: 'failed',
        detail: msg.detail,
        sent_to: msg.to,
        attempts: plan.giveUp ? MAX_SEND_ATTEMPTS : attempts,
        last_error: String(res.reason || 'failed').slice(0, 300),
        next_try_at: plan.nextTryAt,
      }).eq('id', rowId);
    }
  }
  return res;
}

// The guest's phone or email from their customer record, when the booking itself has none.
// The host stand writes the booking's guest as { name, phone } even when the guest record has
// an email, so without this every stand booking was told by text only. In memory only: the
// booking row is never rewritten.
async function withCrmContact(list: Row[]): Promise<Row[]> {
  const want = list.filter((b) => b?.customer_id && (!String(b.customer?.phone || '').trim() || !String(b.customer?.email || '').trim()));
  const ids = [...new Set(want.map((b) => String(b.customer_id)))];
  if (!ids.length) return list;
  const crm = new Map<string, Row>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db.from('customers').select('id, email, phone').in('id', ids.slice(i, i + 150));
    if (error) { console.warn('[booking-reminders] customer contact read failed:', error.message); return list; }
    for (const c of data || []) crm.set(String(c.id), c);
  }
  for (const b of want) {
    const c = crm.get(String(b.customer_id));
    if (!c) continue;
    const cur = (b.customer || {}) as Row;
    b.customer = {
      ...cur,
      phone: String(cur.phone || '').trim() || String(c.phone || '').trim() || null,
      email: String(cur.email || '').trim() || String(c.email || '').trim() || null,
    };
  }
  return list;
}

// Does this request see the 20261016c ledger (status, attempts, detail)?
async function ledgerIsV2(): Promise<boolean> {
  const { error } = await db.from('booking_reminders').select('status, attempts, detail, next_try_at, last_error').limit(1);
  return !error;
}

const CLOSED = ['cancelled', 'no_show', 'departed', 'expired'];
const channelsOf = (bk: Row): Channel[] => {
  const c = (bk.customer || {}) as Row;
  return [String(c.phone || '').trim() ? 'sms' : null, String(c.email || '').trim() ? 'email' : null].filter(Boolean) as Channel[];
};

// ── the 16 Oct 2026 sweep: confirmations missed, reminders, the team's changes and cancels ──
async function guestSweep(venues: Map<string, Promise<Venue>>, out: { sent: Row[]; skipped: Row[] }) {
  const now = Date.now();
  const day = (n: number) => new Date(now + n * 86400000).toISOString().slice(0, 10);
  // Three reads, merged: the days a reminder can be due in, the bookings made in the last 2
  // hours (the confirmation backstop, any date), and the bookings changed or cancelled in the
  // last day (bookings_touch keeps updated_at), so a change to next month's booking is told too.
  const [near, recent, touched] = await Promise.all([
    pagedRows('bookings near today', () => db.from('bookings').select('*')
      .gte('booking_date', day(-1)).lte('booking_date', day(2))
      .in('status', ['confirmed', 'prepaid', 'cancelled']).order('id')),
    pagedRows('bookings made in the last 2 hours', () => db.from('bookings').select('*')
      .gte('created_at', new Date(now - 2 * 3600000).toISOString())
      .in('status', ['confirmed', 'prepaid']).order('id')),
    pagedRows('bookings changed in the last day', () => db.from('bookings').select('*')
      .gte('updated_at', new Date(now - 86400000).toISOString()).gte('booking_date', day(-1))
      .in('status', ['confirmed', 'prepaid', 'cancelled']).order('id')),
  ]);
  // A guest cancel whose refund flag was lost (two writes on the manage page): flag it now.
  const healed = new Set<string>();
  for (const b of [...near, ...touched]) {
    if (b.status !== 'cancelled' || b.cancel_reason !== GUEST_CANCEL_REASON || healed.has(String(b.id))) continue;
    healed.add(String(b.id));
    try {
      if (await healGuestCancel(db, b, await readBookingPayments(db, String(b.id)))) out.sent.push({ booking: b.id, kind: 'refund_flag_healed' });
    } catch (e) { console.error('[booking-reminders] refund flag heal failed for', b.id, (e as Error).message); }
  }
  await withCrmContact([...near, ...recent, ...touched]);
  const byId = new Map<string, Row>();
  for (const b of [...near, ...recent, ...touched]) if (b.source !== 'walk_in' && channelsOf(b).length) byId.set(String(b.id), b);
  if (!byId.size) return;
  const ids = [...byId.keys()];
  const ledger = new Map<string, Row[]>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db.from('booking_reminders').select('booking_id, kind, channel, status, detail, sent_at').in('booking_id', ids.slice(i, i + 150));
    if (error) throw new Error(`Could not read the message ledger: ${error.message}`);
    for (const r of data || []) ledger.set(String(r.booking_id), [...(ledger.get(String(r.booking_id)) || []), r]);
  }
  const note = (bk: Row, kind: Kind, channel: Channel, r: SendResult) => {
    if (r.sent) out.sent.push({ booking: bk.id, kind, channel });
    else if (r.reason !== 'already_sent_(ledger)' && out.skipped.length < 300) out.skipped.push({ booking: bk.id, reason: `${kind}_${channel}_${r.reason}` });
  };
  for (const bk of byId.values()) {
    try {
      const venue = await loadVenue(String(bk.location_id), venues);
      if (!venue.messagesOn) continue;
      const rows = ledger.get(String(bk.id)) || [];
      const has = (kind: Kind, ch: Channel) => rows.find((r) => r.kind === kind && r.channel === ch) || null;
      const tz = venue.tz;
      for (const ch of channelsOf(bk)) {
        if (confirmationToSend({ booking: bk, tz, now }).due && !has('confirmation', ch)) {
          note(bk, 'confirmation', ch, await deliver({ kind: 'confirmation', channel: ch, bk, venue, v2: true }));
        }
        for (const kind of ['reminder_day', 'reminder_2h'] as Kind[]) {
          // A reminder for a booking that already had its confirmation in the last few hours is
          // skipped inside reminderDue (booked_recently).
          // A reminder sent for the booking's old date or time goes again for the new one.
          const prev = has(kind, ch);
          const stale = reminderIsStale(prev, bk);
          if ((!prev || stale) && reminderDue({ kind, booking: bk, tz, now }).due) {
            note(bk, kind, ch, await deliver({ kind, channel: ch, bk, venue, v2: true, mode: stale ? 'change' : 'once' }));
          }
        }
        // What this guest was last told on this channel: the newest confirmation or change sent.
        const told = rows.filter((r) => r.channel === ch && (r.kind === 'confirmation' || r.kind === 'changed') && r.status === 'sent' && r.detail)
          .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))[0]?.detail || null;
        const tried = has('changed', ch)?.detail || null;
        if (changeToTell({ booking: bk, told, tried })) {
          note(bk, 'changed', ch, await deliver({ kind: 'changed', channel: ch, bk, venue, v2: true, mode: 'change' }));
        }
        const confirmationSent = rows.some((r) => r.kind === 'confirmation' && r.status === 'sent');
        if (!has('cancelled', ch) && cancelToTell({ booking: bk, confirmationSent, tz, now }).due) {
          note(bk, 'cancelled', ch, await deliver({ kind: 'cancelled', channel: ch, bk, venue, v2: true }));
        }
      }
    } catch (e) {
      console.error('[booking-reminders] sweep failed for', bk.id, (e as Error).message);
      if (out.skipped.length < 300) out.skipped.push({ booking: bk.id, reason: `error_${(e as Error).message}` });
    }
  }
}

// Is a message of this kind still worth sending for the booking as it is now?
function stillWanted(kind: Kind, bk: Row, tz: string): boolean {
  const live = LIVE_FOR_GUEST.includes(String(bk.status || ''));
  const start = zonedToEpoch(String(bk.booking_date || ''), bk.start_time, tz);
  const ahead = start > Date.now();
  if (kind === 'cancelled') return bk.status === 'cancelled' && ahead;
  if (kind === 'reminder_2h') return live && start - Date.now() > 15 * 60000;
  return live && ahead;
}

// ── retries: a failed send is tried again after 10 then 30 minutes, at most 3 times ──
async function retryFailed(venues: Map<string, Promise<Venue>>, out: { sent: Row[]; skipped: Row[] }) {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await db.from('booking_reminders')
    .select('id, booking_id, kind, channel, attempts')
    .eq('status', 'failed').lt('attempts', MAX_SEND_ATTEMPTS).lte('next_try_at', nowIso)
    .order('next_try_at', { ascending: true }).limit(100);
  if (error) { console.error('[booking-reminders] retry read failed:', error.message); return; }
  // A claim that never finished counts as a failed try (it would otherwise block that message,
  // and every later change message on that channel, for ever).
  const { data: stuck, error: stuckErr } = await db.from('booking_reminders')
    .select('id, booking_id, kind, channel, attempts, sent_at')
    .eq('status', 'sending').lt('sent_at', new Date(Date.now() - STALE_CLAIM_MS).toISOString())
    .order('sent_at', { ascending: true }).limit(100);
  if (stuckErr) console.error('[booking-reminders] stale claim read failed:', stuckErr.message);
  const work = [
    ...(due || []).map((r: Row) => ({ ...r, from: 'failed' })),
    ...(stuck || []).map((r: Row) => ({ ...r, from: 'sending' })),
  ];
  for (const r of work) {
    const next = Number(r.attempts || 1) + 1;
    if (r.from === 'sending' && next > MAX_SEND_ATTEMPTS) {
      await db.from('booking_reminders').update({ status: 'failed', last_error: 'not sent: the last try never finished', next_try_at: null })
        .eq('id', r.id).eq('status', 'sending').eq('sent_at', r.sent_at);
      continue;
    }
    const claim = db.from('booking_reminders')
      .update({ status: 'sending', attempts: next, sent_at: new Date().toISOString() })
      .eq('id', r.id).eq('status', r.from);
    const { data: claimed } = await (r.from === 'sending' ? claim.eq('sent_at', r.sent_at) : claim.eq('attempts', r.attempts)).select('id');
    if (!claimed?.length) continue;
    const { data: bk0 } = await db.from('bookings').select('*').eq('id', r.booking_id).maybeSingle();
    const bk = bk0 ? (await withCrmContact([bk0]))[0] : null;
    const venue = bk ? await loadVenue(String(bk.location_id), venues) : null;
    if (!bk || !venue || !stillWanted(r.kind as Kind, bk, venue.tz)) {
      await db.from('booking_reminders').update({ status: 'failed', attempts: MAX_SEND_ATTEMPTS, last_error: 'not sent: no longer needed', next_try_at: null }).eq('id', r.id);
      continue;
    }
    const res = await deliver({ kind: r.kind as Kind, channel: r.channel as Channel, bk, venue, v2: true, mode: 'retry', rowId: String(r.id), attempts: next });
    if (res.sent) out.sent.push({ booking: bk.id, kind: r.kind, channel: r.channel, retry: next });
    else if (out.skipped.length < 300) out.skipped.push({ booking: bk.id, reason: `retry_${r.kind}_${r.channel}_${res.reason}` });
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'send_due';
    const venues = new Map<string, Promise<Venue>>();
    pkgCache.clear();

    // ── booking confirmation (SMS + email, once per channel via the ledger) ──
    if (action === 'confirm') {
      const bookingId = String(body.booking_id || '');
      const { data: bk0 } = await db.from('bookings').select('*').eq('id', bookingId).maybeSingle();
      if (!bk0 || CLOSED.includes(bk0.status)) return json({ ok: false, error: 'unknown_or_closed' }, 404);
      const [bk] = await withCrmContact([bk0]);
      // Pay-before-commit: never confirm a booking that has not paid, the
      // promote paths re-fire this action once the money lands.
      if (bk.status === 'pending_payment') return json({ ok: false, error: 'pending_payment_not_confirmable' }, 409);
      // A party seated at the door is not told it booked a table.
      if (bk.source === 'walk_in') return json({ ok: false, error: 'walk_in' }, 409);
      const v2 = await ledgerIsV2();
      const venue = await loadVenue(String(bk.location_id), venues);
      if (bk.preorder_token && !venue.base) console.warn('[booking-reminders] confirm: no link base:', venue.baseReason, bookingId);
      const sent: string[] = [];
      const results: Record<string, SendResult> = {
        sms: { sent: false, reason: 'no_phone_on_booking' },
        email: { sent: false, reason: 'no_email_on_booking' },
      };
      for (const ch of channelsOf(bk)) {
        results[ch] = await deliver({ kind: 'confirmation', channel: ch, bk, venue, v2 });
        if (results[ch].sent) sent.push(ch);
      }
      for (const [ch, r] of Object.entries(results)) {
        if (!r.sent) console.warn(`[booking-reminders] confirm ${bookingId} ${ch} not sent:`, r.reason);
      }
      return json({ ok: true, sent, results });
    }

    // ── notify: the guest changed or cancelled on their manage page ──────────
    if (action === 'notify') {
      // Only booking-widget (the guest's own manage page) calls this, with the service role. Anyone
      // else could make it text a guest about any booking (16 Oct 2026 release review).
      if ((req.headers.get('Authorization') || '') !== `Bearer ${SERVICE_ROLE}`) return json({ ok: false, error: 'forbidden' }, 403);
      const bookingId = String(body.booking_id || '');
      const kind = String(body.kind || '') as Kind;
      if (kind !== 'changed' && kind !== 'cancelled') return json({ ok: false, error: 'kind must be changed or cancelled' }, 400);
      const v2 = await ledgerIsV2();
      if (!v2) return json({ ok: false, error: 'needs_migration_20261016c' }, 409);
      const { data: bk0 } = await db.from('bookings').select('*').eq('id', bookingId).maybeSingle();
      if (!bk0) return json({ ok: false, error: 'unknown_booking' }, 404);
      const [bk] = await withCrmContact([bk0]);
      if (kind === 'cancelled' && bk.status !== 'cancelled') return json({ ok: false, error: 'not_cancelled' }, 409);
      // Only the guest's own online cancel is told here; a team cancel goes through the sweep's rules.
      if (kind === 'cancelled' && bk.cancel_reason !== GUEST_CANCEL_REASON) return json({ ok: false, error: 'not_a_guest_cancel' }, 409);
      if (kind === 'changed' && !LIVE_FOR_GUEST.includes(bk.status)) return json({ ok: false, error: 'not_live' }, 409);
      const venue = await loadVenue(String(bk.location_id), venues);
      const results: Record<string, SendResult> = {};
      for (const ch of channelsOf(bk)) {
        if (kind === 'changed') {
          // Only when it really differs from what this guest was last told on this channel.
          const { data: rows } = await db.from('booking_reminders').select('kind, status, detail, sent_at')
            .eq('booking_id', bk.id).eq('channel', ch).in('kind', ['confirmation', 'changed']);
          const told = (rows || []).filter((r: Row) => r.status === 'sent' && r.detail)
            .sort((a: Row, b: Row) => String(b.sent_at).localeCompare(String(a.sent_at)))[0]?.detail || null;
          const tried = (rows || []).find((r: Row) => r.kind === 'changed')?.detail || null;
          // A booking never confirmed on this channel is still told about a change the guest made.
          const changed = told ? changeToTell({ booking: bk, told, tried }) : !sameSnapshot(tried, snapshotOf(bk));
          results[ch] = changed ? await deliver({ kind, channel: ch, bk, venue, v2, mode: 'change' }) : { sent: false, reason: 'nothing_changed' };
        } else {
          results[ch] = await deliver({ kind, channel: ch, bk, venue, v2 });
        }
      }
      return json({ ok: true, results });
    }

    // ── send_link: mint (if missing) + send the guest their pre-order link ──
    // The Diary Inspector button, the widget's choose-later skip, and the
    // paid-promote paths all land here. Response is HONEST per channel:
    //   { ok, link, deadline, email: {sent, reason?}, sms: {sent, reason?} }
    if (action === 'send_link') {
      const bookingId = String(body.booking_id || '');
      const { data: bk } = await db.from('bookings')
        .select('id, location_id, booking_date, start_time, covers, status, customer, package_id, preorder_token')
        .eq('id', bookingId).maybeSingle();
      if (!bk || CLOSED.includes(bk.status)) return json({ ok: false, error: 'unknown_or_closed' }, 404);
      if (!bk.package_id) return json({ ok: false, error: 'no_package_on_booking' }, 400);
      const { data: pkg } = await db.from('packages')
        .select('id, name, requires_preorder, preorder_days_before').eq('id', bk.package_id).maybeSingle();
      if (!pkg?.requires_preorder) return json({ ok: false, error: 'package_has_no_preorder' }, 400);
      // v5.7.26 - pre-order on but no line marked "guest chooses": there is
      // nothing to pick, so there is no link to send. Legacy tokens from
      // before this rule land here too.
      {
        const { count: choiceLines } = await db.from('package_lines')
          .select('id', { count: 'exact', head: true })
          .eq('package_id', bk.package_id).eq('is_preorder_choice', true);
        if ((choiceLines || 0) === 0) return json({ ok: false, error: 'package_has_no_choices' }, 400);
      }

      // Mint the token when missing (host-created or legacy bookings).
      let token = bk.preorder_token as string | null;
      if (!token) {
        token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
        const { error: mintErr } = await db.from('bookings').update({ preorder_token: token }).eq('id', bk.id);
        if (mintErr) return json({ ok: false, error: `token_mint_failed: ${mintErr.message}` }, 500);
      }
      const dl = new Date(`${bk.booking_date}T12:00:00`);
      dl.setDate(dl.getDate() - (Number(pkg.preorder_days_before) || 0));
      const deadline = dl.toISOString().slice(0, 10);

      const meta = await venueMeta(bk.location_id);
      if (!meta.base) {
        console.warn('[booking-reminders] send_link: no link base:', meta.reason, bookingId);
        return json({
          ok: false, error: 'no_link_base', reason: meta.reason, link: null, deadline,
          email: { sent: false, reason: meta.reason }, sms: { sent: false, reason: meta.reason },
        });
      }
      const link = `${meta.base}/book?preorder=${token}`;
      const cust = (bk.customer || {}) as Record<string, unknown>;
      const first = String(cust.name || 'there').split(' ')[0];
      const when = `${fmtDate(bk.booking_date)} at ${String(bk.start_time).slice(0, 5)}`;
      const { data: loc } = await db.from('locations').select('name').eq('id', bk.location_id).maybeSingle();
      const venueName = loc?.name || 'the venue';
      const tplData: Record<string, string> = {
        customer_name: first,
        venue_name: venueName,
        date: fmtDate(bk.booking_date),
        time: String(bk.start_time).slice(0, 5),
        party_size: String(bk.covers),
        package_name: String(pkg.name || 'your package'),
        preorder_link: link,
      };
      const v2 = await ledgerIsV2();

      // Per-channel: 60s throttle off the ledger's sent_at (send_link is
      // deliberately RE-sendable, the ledger is audit + throttle here, not a
      // once-ever gate; the once-ever gate belongs to send_due).
      const throttled = async (channel: Channel) => {
        const { data: prev } = await db.from('booking_reminders')
          .select('sent_at').eq('booking_id', bk.id).eq('kind', 'preorder').eq('channel', channel).maybeSingle();
        return !!(prev?.sent_at && Date.now() - Date.parse(prev.sent_at) < 60000);
      };
      const stamp = (channel: Channel, to: string) =>
        db.from('booking_reminders').upsert(
          {
            location_id: bk.location_id, booking_id: bk.id, kind: 'preorder', channel, sent_to: to, sent_at: new Date().toISOString(),
            ...(v2 ? { status: 'sent', attempts: 1, last_error: null, next_try_at: null } : {}),
          },
          { onConflict: 'booking_id,kind,channel' },
        );

      let emailRes: SendResult;
      const email = String(cust.email || '').trim();
      if (!email) emailRes = { sent: false, reason: 'no_email_on_booking' };
      else if (await throttled('email')) emailRes = { sent: false, reason: 'throttled_sent_under_60s_ago' };
      else {
        const safe: Record<string, string> = {};
        for (const [k, v] of Object.entries(tplData)) safe[k] = escapeHtml(v);
        const tpl = await renderTpl(meta.companyId, 'booking_preorder_reminder', 'email', safe);
        const subject = tpl?.subject || `Choose your menu: ${venueName}, ${fmtDate(bk.booking_date)}`;
        const html = tpl?.body
          ? linkify(wrapInEmailHtml(tpl.body, { venueName: escapeHtml(venueName) }))
          : `<p>Hi ${escapeHtml(first)},</p><p>Your table for ${bk.covers} at <b>${escapeHtml(venueName)}</b> on <b>${when}</b> includes <b>${escapeHtml(pkg.name)}</b>, the kitchen needs everyone's choices by <b>${fmtDate(deadline)}</b>.</p><p><a href="${link}">Choose your menu</a></p><p>It takes a minute per guest.</p>`;
        emailRes = await sendEmail(email, unescapeHtml(subject), html);
        if (emailRes.sent) await stamp('email', email);
      }

      let smsRes: SendResult;
      const phone = String(cust.phone || '').trim();
      if (!phone) smsRes = { sent: false, reason: 'no_phone_on_booking' };
      else if (await throttled('sms')) smsRes = { sent: false, reason: 'throttled_sent_under_60s_ago' };
      else {
        const tpl = await renderTpl(meta.companyId, 'booking_preorder_reminder', 'sms', tplData);
        const msg = tpl?.body ||
          `${venueName}: your ${pkg.name} on ${fmtDate(bk.booking_date)} needs everyone's menu choices by ${fmtDate(deadline)}. Pick here: ${link}`;
        smsRes = await sendSms(phone, msg, bk.location_id, 'booking_preorder_reminder', String(bk.id));
        if (smsRes.sent) await stamp('sms', phone);
      }

      if (!emailRes.sent) console.warn(`[booking-reminders] send_link ${bookingId} email not sent:`, emailRes.reason);
      if (!smsRes.sent) console.warn(`[booking-reminders] send_link ${bookingId} sms not sent:`, smsRes.reason);
      return json({ ok: true, link, deadline, email: emailRes, sms: smsRes });
    }

    if (action !== 'send_due') return json({ error: 'unknown action' }, 400);

    // 17 Oct 2026 (v5.11.73): the sweep is the cron job's (or the service role's), nobody else's.
    // The key is checked by the database, so it is never copied anywhere else (_shared/cronKey.js).
    const service = isServiceRoleBearer(req.headers.get('Authorization'), SERVICE_ROLE);
    const key = String(req.headers.get(CRON_KEY_HEADER) || '').trim();
    const access = sweepAccess({ service, key, check: service ? null : await db.rpc(CRON_KEY_CHECK, { p_key: key }) });
    if (!access.ok) {
      console.warn('[booking-reminders] send_due refused:', access.reason);
      return json({ ok: false, error: 'send_due runs only from the scheduled job', reason: access.reason }, 403);
    }
    if (access.by === 'before_migration') console.warn('[booking-reminders] send_due is open until migration 20261017a runs');

    const v2 = await ledgerIsV2();
    const sent: Row[] = [];
    // EVERY skip is named here, the "why didn't the guest get a reminder"
    // answer lives in this array, not in a vanished log line.
    const skipped: Row[] = [];

    // ── 1. the pre-order nag ──────────────────────────────────────────────────
    // Live bookings with a token (deferred choices), joined to their package.
    // pending_payment is NOT nagged, no money, no reminders; the widget's
    // promote paths hand the guest their link once payment lands.
    // 16 Oct 2026: paged (PostgREST answers 1000 rows at most).
    const rows = await pagedRows('tokened bookings', () => db.from('bookings')
      .select('*')
      .not('preorder_token', 'is', null)
      .in('status', ['confirmed', 'prepaid'])
      .gte('booking_date', new Date(Date.now() - 86400000).toISOString().slice(0, 10))
      .order('id'));

    if (rows.length) {
      const pkgIds = [...new Set(rows.map((r) => r.package_id).filter(Boolean))];
      const [{ data: pkgs }, { data: pre }] = await Promise.all([
        db.from('packages').select('id, name, requires_preorder, preorder_days_before').in('id', pkgIds.length ? pkgIds : ['-']),
        db.from('booking_preorders').select('booking_id').in('booking_id', rows.map((r) => r.id)),
      ]);
      const pkgBy = new Map((pkgs || []).map((p) => [String(p.id), p]));
      const preCount = new Map<string, number>();
      for (const r of pre || []) preCount.set(r.booking_id, (preCount.get(r.booking_id) || 0) + 1);

      for (const b of rows) {
        const pkg = pkgBy.get(String(b.package_id));
        if (!pkg?.requires_preorder) { skipped.push({ booking: b.id, reason: 'package_missing_or_not_preorder' }); continue; }
        const venue = await loadVenue(String(b.location_id), venues);
        const today = venueToday(venue.tz);
        const dl = new Date(`${b.booking_date}T12:00:00`);
        dl.setDate(dl.getDate() - (Number(pkg.preorder_days_before) || 0));
        const deadline = dl.toISOString().slice(0, 10);
        if (today < deadline) { skipped.push({ booking: b.id, reason: `window_opens_${deadline}` }); continue; }
        if ((preCount.get(b.id) || 0) >= b.covers) { skipped.push({ booking: b.id, reason: 'choices_complete' }); continue; }
        if (!venue.base) {
          console.warn('[booking-reminders] send_due: no link base:', venue.baseReason, b.id);
          skipped.push({ booking: b.id, reason: `no_link_base_${venue.baseReason}` });
          continue;
        }
        for (const ch of ['email', 'sms'] as Channel[]) {
          const r = await deliver({ kind: 'preorder', channel: ch, bk: b, venue, v2 });
          if (r.sent) sent.push({ booking: b.id, channel: ch });
          else skipped.push({
            booking: b.id,
            reason: r.reason === 'already_sent_(ledger)' ? `${ch}_already_sent`
              : r.reason === 'no_email_on_booking' ? 'email_no_address'
              : r.reason === 'no_phone_on_booking' ? 'sms_no_phone'
              : `${ch}_${r.reason}`,
          });
        }
      }
    }

    // ── 2 and 3. reminders, backstops and retries (migration 20261016c) ──────
    const guest = { sent: [] as Row[], skipped: [] as Row[] };
    if (v2) {
      try { await guestSweep(venues, guest); } catch (e) { console.error('[booking-reminders] guest sweep failed:', (e as Error).message); guest.skipped.push({ reason: `sweep_error_${(e as Error).message}` }); }
      try { await retryFailed(venues, guest); } catch (e) { console.error('[booking-reminders] retry pass failed:', (e as Error).message); }
    }
    return json({
      ok: true, ledger: v2 ? 'v2' : 'v1_before_migration_20261016c',
      checked: rows.length, due: sent.length, sent, skipped: skipped.slice(0, 300),
      guest: { sent: guest.sent.length, list: guest.sent.slice(0, 100), skipped: guest.skipped.slice(0, 300) },
    });
  } catch (e) {
    console.error('[booking-reminders]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
