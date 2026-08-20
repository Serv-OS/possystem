// supabase/functions/booking-reminders/index.ts
//
// Pre-order reminders + booking confirmations + the guest pre-order LINK.
//
// Actions:
//   confirm   {booking_id} — booking confirmation SMS + email, each channel at
//             most once via the booking_reminders ledger (safe to re-fire).
//   send_link {booking_id} — v5.7.21 link-first flow: mints preorder_token if
//             missing, sends the guest their choose-your-menu link by email +
//             SMS, and answers HONEST per-channel results — every skip has a
//             returned + logged reason. Called by the widget (choices
//             deferred / choose-later skip), the promote paths, and the Diary
//             Inspector's "Send pre-order link" button. Resendable: a 60s
//             per-channel throttle stops accidental double-taps, nothing else.
//   send_due  — sweep: every live tokened booking whose deadline window has
//             opened and whose choices are incomplete gets one email + one
//             SMS ever (ledger-gated). The response lists every booking it
//             looked at and why each was skipped — NO silent skips (v5.7.21).
//
// TRIGGER: no scheduler runs this fn (pg_cron only runs the SQL-only
// bookings-expire-unpaid sweep). The bookings host stand invokes
// {action:'send_due'} on boot + hourly (BookingsSurface), which covers real
// venues — a stand is open all service.
//
// Transport mirrors order-notify: SMS via the send-sms fn (lands in the
// sms_messages audit), email via Resend/Postmark (RECEIPT_EMAIL_* envs).
// EMAIL_PROVIDER default is 'log' which CANNOT send — that is now a returned
// reason, never a silent false.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { resolveAndRender, wrapInEmailHtml } from '../_shared/template-resolver.ts';

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

const venueToday = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Honest transport results: {sent, reason?}. A false without a reason is a
// bug — every failure path names itself so callers can surface it.
type SendResult = { sent: boolean; reason?: string };

async function sendSms(to: string, message: string, locationId: string, type = 'booking_preorder_reminder'): Promise<SendResult> {
  if (!to) return { sent: false, reason: 'no_phone_on_booking' };
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ to, message, location_id: locationId, type }),
    });
    if (!res.ok) return { sent: false, reason: `send-sms_http_${res.status}` };
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
// comes with a reason now — the old nulls were the silent-skip trap.
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

// Resolve an operator-edited template (empty companyId just falls through to
// the registry default). Returns null only when the type/channel is unknown,
// so callers keep a hardcoded fallback for safety.
async function renderTpl(
  companyId: string, type: string, channel: 'email' | 'sms', data: Record<string, string>,
): Promise<{ subject?: string; body: string } | null> {
  try { return await resolveAndRender(companyId, type, channel, data); } catch { return null; }
}

const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${iso}T12:00:00`));

const CLOSED = ['cancelled', 'no_show', 'departed', 'expired'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'send_due';

    // ── booking confirmation (SMS + email, once per channel via the ledger) ──
    if (action === 'confirm') {
      const bookingId = String(body.booking_id || '');
      const { data: bk } = await db.from('bookings')
        .select('id, location_id, booking_date, start_time, covers, status, customer, package_id, preorder_token')
        .eq('id', bookingId).maybeSingle();
      if (!bk || CLOSED.includes(bk.status)) return json({ ok: false, error: 'unknown_or_closed' }, 404);
      // Pay-before-commit: never confirm a booking that has not paid — the
      // promote paths re-fire this action once the money lands.
      if (bk.status === 'pending_payment') return json({ ok: false, error: 'pending_payment_not_confirmable' }, 409);
      const [{ data: loc }, { data: pkg }] = await Promise.all([
        db.from('locations').select('name').eq('id', bk.location_id).maybeSingle(),
        bk.package_id ? db.from('packages').select('name, requires_preorder').eq('id', bk.package_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const venueName = loc?.name || 'the venue';
      const cust = (bk.customer || {}) as Record<string, unknown>;
      const first = String(cust.name || 'there').split(' ')[0];
      const when = `${fmtDate(bk.booking_date)} at ${String(bk.start_time).slice(0, 5)}`;
      const meta = await venueMeta(bk.location_id);
      const poLink = bk.preorder_token && meta.base ? `${meta.base}/book?preorder=${bk.preorder_token}` : null;
      if (bk.preorder_token && !meta.base) console.warn('[booking-reminders] confirm: no link base —', meta.reason, bookingId);
      const tplData: Record<string, string> = {
        customer_name: first,
        venue_name: venueName,
        date: fmtDate(bk.booking_date),
        time: String(bk.start_time).slice(0, 5),
        party_size: String(bk.covers),
        package_name: pkg?.name ? String(pkg.name) : '',
        package_line: pkg?.name ? `with ${pkg.name} ` : '',
        preorder_link: poLink || '',
        preorder_link_line: poLink ? `Choose your menu: ${poLink} ` : '',
      };
      const sent: string[] = [];
      const results: Record<string, SendResult> = {
        sms: { sent: false, reason: 'no_phone_on_booking' },
        email: { sent: false, reason: 'no_email_on_booking' },
      };

      const phone = String(cust.phone || '').trim();
      if (phone) {
        const { error: lg } = await db.from('booking_reminders')
          .insert({ location_id: bk.location_id, booking_id: bk.id, kind: 'confirmation', channel: 'sms', sent_to: phone });
        if (lg) {
          results.sms = { sent: false, reason: 'already_sent_(ledger)' };
        } else {
          const tpl = await renderTpl(meta.companyId, 'booking_confirmation', 'sms', tplData);
          const msg = tpl?.body ||
            (`${venueName}: table for ${bk.covers} booked${pkg ? ` with ${pkg.name}` : ''}, ${when}.` +
              (poLink ? ` Choose your menu: ${poLink}` : '') + ` Need to change it? Call the venue.`);
          results.sms = await sendSms(phone, msg, bk.location_id, 'booking_confirmation');
          if (!results.sms.sent) await db.from('booking_reminders').delete().eq('booking_id', bk.id).eq('kind', 'confirmation').eq('channel', 'sms');
          else sent.push('sms');
        }
      }
      const email = String(cust.email || '').trim();
      if (email) {
        const { error: lg } = await db.from('booking_reminders')
          .insert({ location_id: bk.location_id, booking_id: bk.id, kind: 'confirmation', channel: 'email', sent_to: email });
        if (lg) {
          results.email = { sent: false, reason: 'already_sent_(ledger)' };
        } else {
          const tpl = await renderTpl(meta.companyId, 'booking_confirmation', 'email', tplData);
          const subject = tpl?.subject || `Booking confirmed: ${venueName}, ${fmtDate(bk.booking_date)}`;
          const html = tpl?.body
            ? wrapInEmailHtml(tpl.body, { venueName })
            : (`<p>Hi ${first},</p><p>Your table for <b>${bk.covers}</b> at <b>${venueName}</b> is booked${pkg ? ` with <b>${pkg.name}</b>` : ''}, <b>${when}</b>.</p>` +
              (poLink ? `<p><a href="${poLink}">Choose your menu</a>, the kitchen needs everyone's choices.</p>` : '') +
              `<p>Need to change it? Just call the venue.</p>`);
          results.email = await sendEmail(email, subject, html);
          if (!results.email.sent) await db.from('booking_reminders').delete().eq('booking_id', bk.id).eq('kind', 'confirmation').eq('channel', 'email');
          else sent.push('email');
        }
      }
      for (const [ch, r] of Object.entries(results)) {
        if (!r.sent) console.warn(`[booking-reminders] confirm ${bookingId} ${ch} not sent:`, r.reason);
      }
      return json({ ok: true, sent, results });
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
        console.warn('[booking-reminders] send_link: no link base —', meta.reason, bookingId);
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

      // Per-channel: 60s throttle off the ledger's sent_at (send_link is
      // deliberately RE-sendable — the ledger is audit + throttle here, not a
      // once-ever gate; the once-ever gate belongs to send_due).
      const throttled = async (channel: 'email' | 'sms') => {
        const { data: prev } = await db.from('booking_reminders')
          .select('sent_at').eq('booking_id', bk.id).eq('kind', 'preorder').eq('channel', channel).maybeSingle();
        return !!(prev?.sent_at && Date.now() - Date.parse(prev.sent_at) < 60000);
      };
      const stamp = (channel: 'email' | 'sms', to: string) =>
        db.from('booking_reminders').upsert(
          { location_id: bk.location_id, booking_id: bk.id, kind: 'preorder', channel, sent_to: to, sent_at: new Date().toISOString() },
          { onConflict: 'booking_id,kind,channel' },
        );

      let emailRes: SendResult;
      const email = String(cust.email || '').trim();
      if (!email) emailRes = { sent: false, reason: 'no_email_on_booking' };
      else if (await throttled('email')) emailRes = { sent: false, reason: 'throttled_sent_under_60s_ago' };
      else {
        const tpl = await renderTpl(meta.companyId, 'booking_preorder_reminder', 'email', tplData);
        const subject = tpl?.subject || `Choose your menu: ${venueName}, ${fmtDate(bk.booking_date)}`;
        const html = tpl?.body
          ? wrapInEmailHtml(tpl.body, { venueName })
          : `<p>Hi ${first},</p><p>Your table for ${bk.covers} at <b>${venueName}</b> on <b>${when}</b> includes <b>${pkg.name}</b>, the kitchen needs everyone's choices by <b>${fmtDate(deadline)}</b>.</p><p><a href="${link}">Choose your menu</a></p><p>It takes a minute per guest.</p>`;
        emailRes = await sendEmail(email, subject, html);
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
        smsRes = await sendSms(phone, msg, bk.location_id);
        if (smsRes.sent) await stamp('sms', phone);
      }

      if (!emailRes.sent) console.warn(`[booking-reminders] send_link ${bookingId} email not sent:`, emailRes.reason);
      if (!smsRes.sent) console.warn(`[booking-reminders] send_link ${bookingId} sms not sent:`, smsRes.reason);
      return json({ ok: true, link, deadline, email: emailRes, sms: smsRes });
    }

    if (action !== 'send_due') return json({ error: 'unknown action' }, 400);

    // Live bookings with a token (deferred choices), joined to their package.
    // pending_payment is NOT nagged — no money, no reminders; the widget's
    // promote paths hand the guest their link once payment lands.
    const { data: rows } = await db.from('bookings')
      .select('id, location_id, booking_date, start_time, covers, status, customer, package_id, preorder_token')
      .not('preorder_token', 'is', null)
      .in('status', ['confirmed', 'prepaid'])
      .gte('booking_date', new Date(Date.now() - 86400000).toISOString().slice(0, 10));
    if (!rows?.length) return json({ ok: true, checked: 0, due: 0, sent: [], skipped: [] });

    const pkgIds = [...new Set(rows.map((r) => r.package_id).filter(Boolean))];
    const locIds = [...new Set(rows.map((r) => r.location_id))];
    const [{ data: pkgs }, { data: locs }, { data: pre }] = await Promise.all([
      db.from('packages').select('id, name, requires_preorder, preorder_days_before').in('id', pkgIds.length ? pkgIds : ['-']),
      db.from('locations').select('id, name, timezone').in('id', locIds),
      db.from('booking_preorders').select('booking_id').in('booking_id', rows.map((r) => r.id)),
    ]);
    const pkgBy = new Map((pkgs || []).map((p) => [String(p.id), p]));
    const locBy = new Map((locs || []).map((l) => [String(l.id), l]));
    const preCount = new Map<string, number>();
    for (const r of pre || []) preCount.set(r.booking_id, (preCount.get(r.booking_id) || 0) + 1);

    const sent: Record<string, unknown>[] = [];
    // EVERY skip is named here — the "why didn't the guest get a reminder"
    // answer lives in this array, not in a vanished log line.
    const skipped: { booking: string; reason: string }[] = [];
    for (const b of rows) {
      const pkg = pkgBy.get(String(b.package_id));
      if (!pkg?.requires_preorder) { skipped.push({ booking: b.id, reason: 'package_missing_or_not_preorder' }); continue; }
      const loc = locBy.get(String(b.location_id));
      const tz = (loc as { timezone?: string })?.timezone || 'Europe/London';
      const today = venueToday(tz);
      const dl = new Date(`${b.booking_date}T12:00:00`);
      dl.setDate(dl.getDate() - (Number(pkg.preorder_days_before) || 0));
      const deadline = dl.toISOString().slice(0, 10);
      if (today < deadline) { skipped.push({ booking: b.id, reason: `window_opens_${deadline}` }); continue; }
      if ((preCount.get(b.id) || 0) >= b.covers) { skipped.push({ booking: b.id, reason: 'choices_complete' }); continue; }

      const meta = await venueMeta(b.location_id);
      const link = meta.base ? `${meta.base}/book?preorder=${b.preorder_token}` : null;
      if (!link) {
        console.warn('[booking-reminders] send_due: no link base —', meta.reason, b.id);
        skipped.push({ booking: b.id, reason: `no_link_base_${meta.reason}` });
        continue;
      }
      const cust = (b.customer || {}) as Record<string, unknown>;
      const first = String(cust.name || 'there').split(' ')[0];
      const when = `${fmtDate(b.booking_date)} at ${String(b.start_time).slice(0, 5)}`;
      const venueName = loc?.name || 'the venue';
      const tplData: Record<string, string> = {
        customer_name: first,
        venue_name: venueName,
        date: fmtDate(b.booking_date),
        time: String(b.start_time).slice(0, 5),
        party_size: String(b.covers),
        package_name: String(pkg.name || 'your package'),
        preorder_link: link,
      };

      // Email leg (once, ledger-gated)
      const email = String(cust.email || '').trim();
      if (!email) skipped.push({ booking: b.id, reason: 'email_no_address' });
      else {
        const { error: ledgerErr } = await db.from('booking_reminders')
          .insert({ location_id: b.location_id, booking_id: b.id, kind: 'preorder', channel: 'email', sent_to: email });
        if (ledgerErr) skipped.push({ booking: b.id, reason: 'email_already_sent' });
        else {
          const tpl = await renderTpl(meta.companyId, 'booking_preorder_reminder', 'email', tplData);
          const subject = tpl?.subject || `Choose your menu: ${venueName}, ${fmtDate(b.booking_date)}`;
          const html = tpl?.body
            ? wrapInEmailHtml(tpl.body, { venueName })
            : `<p>Hi ${first},</p><p>Your table for ${b.covers} at <b>${venueName}</b> on <b>${when}</b> includes <b>${pkg.name}</b>, the kitchen needs everyone's choices.</p><p><a href="${link}">Choose your menu</a></p><p>It takes a minute per guest.</p>`;
          const r = await sendEmail(email, subject, html);
          if (!r.sent) {
            await db.from('booking_reminders').delete().eq('booking_id', b.id).eq('kind', 'preorder').eq('channel', 'email');
            console.warn(`[booking-reminders] send_due ${b.id} email failed:`, r.reason);
            skipped.push({ booking: b.id, reason: `email_${r.reason}` });
          } else sent.push({ booking: b.id, channel: 'email' });
        }
      }
      // SMS leg (once, ledger-gated)
      const phone = String(cust.phone || '').trim();
      if (!phone) skipped.push({ booking: b.id, reason: 'sms_no_phone' });
      else {
        const { error: ledgerErr } = await db.from('booking_reminders')
          .insert({ location_id: b.location_id, booking_id: b.id, kind: 'preorder', channel: 'sms', sent_to: phone });
        if (ledgerErr) skipped.push({ booking: b.id, reason: 'sms_already_sent' });
        else {
          const tpl = await renderTpl(meta.companyId, 'booking_preorder_reminder', 'sms', tplData);
          const msg = tpl?.body ||
            `${venueName}: your ${pkg.name} on ${fmtDate(b.booking_date)} needs everyone's menu choices. Pick here: ${link}`;
          const r = await sendSms(phone, msg, b.location_id);
          if (!r.sent) {
            await db.from('booking_reminders').delete().eq('booking_id', b.id).eq('kind', 'preorder').eq('channel', 'sms');
            console.warn(`[booking-reminders] send_due ${b.id} sms failed:`, r.reason);
            skipped.push({ booking: b.id, reason: `sms_${r.reason}` });
          } else sent.push({ booking: b.id, channel: 'sms' });
        }
      }
    }
    return json({ ok: true, checked: rows.length, due: sent.length, sent, skipped });
  } catch (e) {
    console.error('[booking-reminders]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
