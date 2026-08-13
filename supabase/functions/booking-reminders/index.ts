// supabase/functions/booking-reminders/index.ts
//
// Pre-order reminders (Peter, 12 Aug): a guest who booked a choice-menu
// package far out gets an email + SMS nudge with their completion link once
// the deadline window opens (visit date − packages.preorder_days_before).
//
// action 'send_due': finds every live booking whose package requires
// pre-orders, whose deadline has arrived (venue timezone), and whose choices
// are still incomplete — sends each channel AT MOST ONCE, enforced by the
// booking_reminders (booking_id, kind, channel) unique ledger, so this is
// safe to invoke from anywhere, any number of times.
//
// TRIGGER: no scheduler runs on this project yet (known gap — see
// PRE_STAGE_READINESS). The bookings host stand invokes {action:'send_due'}
// on boot + hourly, which covers real venues (a stand is open all service).
// Attach a real cron to this same action when scheduling lands.
//
// Transport mirrors order-notify: SMS via the send-sms fn (lands in the
// sms_messages audit), email via Resend/Postmark (RECEIPT_EMAIL_* envs).

import { createClient } from 'npm:@supabase/supabase-js@2';

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

async function sendSms(to: string, message: string, locationId: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ to, message, location_id: locationId, type: 'booking_preorder_reminder' }),
    });
    return res.ok;
  } catch { return false; }
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    if (EMAIL_PROVIDER === 'resend' && RESEND_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
      });
      return res.ok;
    }
    if (EMAIL_PROVIDER === 'postmark' && POSTMARK_KEY) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'X-Postmark-Server-Token': POSTMARK_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ From: EMAIL_FROM, To: to, Subject: subject, HtmlBody: html }),
      });
      return res.ok;
    }
    return false;
  } catch { return false; }
}

// The guest link lives on the venue's own subdomain (platform slug).
async function guestBase(opsLocationId: string): Promise<string | null> {
  if (!platform) return null;
  try {
    let { data } = await platform.from('locations').select('online_slug').eq('ops_location_id', opsLocationId).maybeSingle();
    if (!data) ({ data } = await platform.from('locations').select('online_slug').eq('id', opsLocationId).maybeSingle());
    return data?.online_slug ? `https://${data.online_slug}.${CUSTOMER_ROOT}` : null;
  } catch { return null; }
}

const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${iso}T12:00:00`));

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
      if (!bk || ['cancelled', 'no_show', 'departed'].includes(bk.status)) return json({ ok: false, error: 'unknown_or_closed' }, 404);
      const [{ data: loc }, { data: pkg }] = await Promise.all([
        db.from('locations').select('name').eq('id', bk.location_id).maybeSingle(),
        bk.package_id ? db.from('packages').select('name, requires_preorder') .eq('id', bk.package_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const venueName = loc?.name || 'the venue';
      const cust = (bk.customer || {}) as Record<string, unknown>;
      const first = String(cust.name || 'there').split(' ')[0];
      const when = `${fmtDate(bk.booking_date)} at ${String(bk.start_time).slice(0, 5)}`;
      const pkgLine = pkg ? ` with ${pkg.name}` : '';
      const base = await guestBase(bk.location_id);
      const poLink = bk.preorder_token && base ? `${base}/book?preorder=${bk.preorder_token}` : null;
      const sent: string[] = [];

      const phone = String(cust.phone || '').trim();
      if (phone) {
        const { error: lg } = await db.from('booking_reminders')
          .insert({ location_id: bk.location_id, booking_id: bk.id, kind: 'confirmation', channel: 'sms', sent_to: phone });
        if (!lg) {
          const msg = `${venueName}: table for ${bk.covers} booked${pkgLine} — ${when}.` +
            (poLink ? ` Choose your menu: ${poLink}` : '') + ` Need to change it? Call the venue.`;
          const ok = await sendSms(phone, msg, bk.location_id);
          if (!ok) await db.from('booking_reminders').delete().eq('booking_id', bk.id).eq('kind', 'confirmation').eq('channel', 'sms');
          else sent.push('sms');
        }
      }
      const email = String(cust.email || '').trim();
      if (email) {
        const { error: lg } = await db.from('booking_reminders')
          .insert({ location_id: bk.location_id, booking_id: bk.id, kind: 'confirmation', channel: 'email', sent_to: email });
        if (!lg) {
          const ok = await sendEmail(email, `Booking confirmed — ${venueName}, ${fmtDate(bk.booking_date)}`,
            `<p>Hi ${first},</p><p>Your table for <b>${bk.covers}</b> at <b>${venueName}</b> is booked${pkgLine ? `<b>${pkgLine}</b>` : ''} — <b>${when}</b>.</p>` +
            (poLink ? `<p><a href="${poLink}">Choose your menu</a> — the kitchen needs everyone's choices.</p>` : '') +
            `<p>Need to change it? Just call the venue.</p>`);
          if (!ok) await db.from('booking_reminders').delete().eq('booking_id', bk.id).eq('kind', 'confirmation').eq('channel', 'email');
          else sent.push('email');
        }
      }
      return json({ ok: true, sent });
    }

    if (action !== 'send_due') return json({ error: 'unknown action' }, 400);

    // Live bookings with a token (deferred choices), joined to their package.
    const { data: rows } = await db.from('bookings')
      .select('id, location_id, booking_date, start_time, covers, status, customer, package_id, preorder_token')
      .not('preorder_token', 'is', null)
      .in('status', ['confirmed', 'prepaid'])
      .gte('booking_date', new Date(Date.now() - 86400000).toISOString().slice(0, 10));
    if (!rows?.length) return json({ ok: true, due: 0, sent: [] });

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
    for (const b of rows) {
      const pkg = pkgBy.get(String(b.package_id));
      if (!pkg?.requires_preorder) continue;
      const loc = locBy.get(String(b.location_id));
      const tz = (loc as { timezone?: string })?.timezone || 'Europe/London';
      const today = venueToday(tz);
      const dl = new Date(`${b.booking_date}T12:00:00`);
      dl.setDate(dl.getDate() - (Number(pkg.preorder_days_before) || 0));
      const deadline = dl.toISOString().slice(0, 10);
      if (today < deadline) continue;                       // window not open yet
      if ((preCount.get(b.id) || 0) >= b.covers) continue;  // enough choices in — done

      const base = await guestBase(b.location_id);
      const link = base ? `${base}/book?preorder=${b.preorder_token}` : null;
      if (!link) continue;
      const cust = (b.customer || {}) as Record<string, unknown>;
      const first = String(cust.name || 'there').split(' ')[0];
      const when = `${fmtDate(b.booking_date)} at ${String(b.start_time).slice(0, 5)}`;
      const venueName = loc?.name || 'the venue';

      // Email leg (once, ledger-gated)
      const email = String(cust.email || '').trim();
      if (email) {
        const { error: ledgerErr } = await db.from('booking_reminders')
          .insert({ location_id: b.location_id, booking_id: b.id, kind: 'preorder', channel: 'email', sent_to: email });
        if (!ledgerErr) {
          const ok = await sendEmail(email,
            `Choose your menu — ${venueName}, ${fmtDate(b.booking_date)}`,
            `<p>Hi ${first},</p><p>Your table for ${b.covers} at <b>${venueName}</b> on <b>${when}</b> includes <b>${pkg.name}</b> — the kitchen needs everyone's choices.</p><p><a href="${link}">Choose your menu</a></p><p>It takes a minute per guest.</p>`);
          if (!ok) await db.from('booking_reminders').delete().eq('booking_id', b.id).eq('kind', 'preorder').eq('channel', 'email');
          else sent.push({ booking: b.id, channel: 'email' });
        }
      }
      // SMS leg (once, ledger-gated)
      const phone = String(cust.phone || '').trim();
      if (phone) {
        const { error: ledgerErr } = await db.from('booking_reminders')
          .insert({ location_id: b.location_id, booking_id: b.id, kind: 'preorder', channel: 'sms', sent_to: phone });
        if (!ledgerErr) {
          const ok = await sendSms(phone,
            `${venueName}: your ${pkg.name} on ${fmtDate(b.booking_date)} needs everyone's menu choices — pick here: ${link}`,
            b.location_id);
          if (!ok) await db.from('booking_reminders').delete().eq('booking_id', b.id).eq('kind', 'preorder').eq('channel', 'sms');
          else sent.push({ booking: b.id, channel: 'sms' });
        }
      }
    }
    return json({ ok: true, due: sent.length, sent });
  } catch (e) {
    console.error('[booking-reminders]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
