// supabase/functions/review-request/index.ts
//
// The ASK engine — the POS-triggered review request, the growth moat. Scans a
// venue's recent closed checks (the close-of-visit moment only a POS sees) and
// sends a one-tap review ask by SMS, with dedup + frequency-cap + consent +
// send-window guards. Links to OUR /review card (so we capture the rating, route
// it de-gated, and measure the funnel).
//   scan      { ops_location_id }     — one venue (staff or service-role)
//   scan_all  {}                      — every ask-enabled venue (service-role; cron)
//   send_now  { ops_location_id, phone, name? } — fire a single test ask now
//
// Compliance: de-gated (links to the card which offers the public path to all);
// honours customers.marketing_opt_in=false; every SMS carries a STOP opt-out;
// frequency-capped so asks stay welcome (and don't get Google-filtered as spam).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CARD_BASE = (Deno.env.get('REVIEW_CARD_BASE') ?? 'https://possystem-liard.vercel.app').replace(/\/+$/, '');
const opsAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

const DEFAULT_MSG = 'Hi {name}, thanks for visiting {venue}! If you have a moment we’d love your feedback: {link} — reply STOP to opt out.';
function buildMsg(tpl: string | null, v: { name: string | null; venue: string; link: string }): string {
  return (tpl || DEFAULT_MSG).replace(/\{name\}/g, v.name || 'there').replace(/\{venue\}/g, v.venue).replace(/\{link\}/g, v.link);
}

async function sendSms(to: string, message: string, opsLocationId: string, ref: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ to, message, location_id: opsLocationId, type: 'review_ask', reference_id: ref }),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok && !j.error, error: j.error };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

async function venueInfo(opsLocationId: string) {
  const { data } = await platformAdmin.from('locations').select('name, timezone, online_slug, company_id')
    .or(`ops_location_id.eq.${opsLocationId},id.eq.${opsLocationId}`).maybeSingle();
  return data;
}

async function scanLocation(opsLocationId: string, opts: { test?: boolean } = {}) {
  const { data: cfg } = await opsAdmin.from('review_settings').select('*').eq('location_id', opsLocationId).maybeSingle();
  if (!cfg?.ask_enabled) return { skipped: 'ask_disabled' };
  const loc = await venueInfo(opsLocationId);
  const venue = loc?.name || 'us';
  const tz = loc?.timezone || 'Europe/London';
  const slug = loc?.online_slug;
  if (!slug) return { skipped: 'no_online_slug' };
  const link = `${CARD_BASE}/?loc=${slug}&surface=review`;

  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()));
  if (!opts.test && (hour < cfg.ask_window_start || hour >= cfg.ask_window_end)) return { skipped: 'outside_window', hour };

  const now = Date.now();
  const delayMs = Number(cfg.ask_delay_minutes ?? 45) * 60000;
  const { data: checks } = await opsAdmin.from('closed_checks')
    .select('id, customer, customer_phone, total, closed_at')
    .eq('location_id', opsLocationId)
    .gte('closed_at', new Date(now - 24 * 3600 * 1000).toISOString())
    .lte('closed_at', new Date(now - delayMs).toISOString())
    .order('closed_at', { ascending: false }).limit(300);

  let sent = 0, suppressed = 0, considered = 0;
  for (const c of checks || []) {
    const phone = c.customer_phone || (c.customer && c.customer.phone) || null;
    if (!phone || Number(c.total) <= 0) continue;
    considered++;
    const { data: dup } = await opsAdmin.from('review_requests').select('id').eq('location_id', opsLocationId).eq('source_kind', 'closed_check').eq('source_ref', c.id).maybeSingle();
    if (dup) continue;
    const name = (c.customer && c.customer.name) || null;
    const email = (c.customer && c.customer.email) || null;

    let reason: string | null = null;
    const { data: recent } = await opsAdmin.from('review_requests').select('id')
      .eq('location_id', opsLocationId).eq('customer_phone', phone).eq('status', 'sent')
      .gte('created_at', new Date(now - Number(cfg.ask_frequency_days ?? 60) * 86400000).toISOString()).limit(1).maybeSingle();
    if (recent) reason = 'frequency_cap';
    if (!reason) {
      const { data: cust } = await opsAdmin.from('customers').select('marketing_opt_in').eq('phone', phone).limit(1).maybeSingle();
      if (cust && cust.marketing_opt_in === false) reason = 'opted_out';
    }

    const base = { location_id: opsLocationId, company_id: loc?.company_id ?? null, source_kind: 'closed_check', source_ref: c.id, customer_name: name, customer_phone: phone, customer_email: email, channel: cfg.ask_channel };
    if (reason) {
      await opsAdmin.from('review_requests').insert({ ...base, status: 'suppressed', suppressed_reason: reason });
      suppressed++; continue;
    }
    const r = await sendSms(phone, buildMsg(cfg.ask_message, { name, venue, link }), opsLocationId, c.id);
    await opsAdmin.from('review_requests').insert({ ...base, status: r.ok ? 'sent' : 'failed', suppressed_reason: r.ok ? null : (r.error || 'send_failed'), link, sent_at: r.ok ? new Date().toISOString() : null });
    if (r.ok) sent++; else suppressed++;
    if (opts.test) break;
  }
  return { sent, suppressed, considered };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();

  // scan_all — cron only (service-role).
  if (action === 'scan_all') {
    if (token !== SERVICE_ROLE) return json({ error: 'service role required' }, 403);
    const { data: rows } = await opsAdmin.from('review_settings').select('location_id').eq('ask_enabled', true);
    const out: Record<string, unknown> = {};
    for (const r of rows || []) out[r.location_id] = await scanLocation(r.location_id);
    return json({ ok: true, locations: out });
  }

  const ops = String(body?.ops_location_id ?? '').trim();
  if (!ops) return json({ error: 'ops_location_id required' }, 400);
  // staff (user_locations) or service-role
  let ok = token === SERVICE_ROLE;
  if (!ok && token) {
    const { data: { user } } = await opsAdmin.auth.getUser(token);
    if (user) {
      const { data: ul } = await opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', ops).maybeSingle();
      ok = !!ul;
      if (!ok) { const { data: p } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle(); ok = p?.role === 'super_admin'; }
    }
  }
  if (!ok) return json({ error: 'no access to this location' }, 403);

  if (action === 'scan') return json({ ok: true, ...(await scanLocation(ops)) });

  if (action === 'send_now') {
    const phone = String(body.phone ?? '').trim();
    if (!phone) return json({ error: 'phone required' }, 400);
    const loc = await venueInfo(ops);
    const slug = loc?.online_slug;
    if (!slug) return json({ error: 'venue has no online_slug to build the review link' }, 400);
    const { data: cfg } = await opsAdmin.from('review_settings').select('ask_message').eq('location_id', ops).maybeSingle();
    const link = `${CARD_BASE}/?loc=${slug}&surface=review`;
    const msg = buildMsg(cfg?.ask_message ?? null, { name: body.name || null, venue: loc?.name || 'us', link });
    const ref = `manual_${Date.now()}`;
    const r = await sendSms(phone, msg, ops, ref);
    await opsAdmin.from('review_requests').insert({ location_id: ops, company_id: loc?.company_id ?? null, source_kind: 'manual', source_ref: ref, customer_name: body.name || null, customer_phone: phone, channel: 'sms', status: r.ok ? 'sent' : 'failed', suppressed_reason: r.ok ? null : (r.error || 'send_failed'), link, sent_at: r.ok ? new Date().toISOString() : null });
    return json({ ok: r.ok, error: r.error, link });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
