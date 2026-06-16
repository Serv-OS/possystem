// supabase/functions/wifi-capture/index.ts
//
// PUBLIC WiFi captive-portal endpoint (anonymous — the guest is not logged in).
// Actions:
//   portal_config { platform_location_id }
//     → public branding/fields/copy to render the portal (from wifi_portal_settings).
//   capture { platform_location_id, email?, phone?, first_name?, last_name?, dob?,
//             is_local?, marketing_consent:bool, client_mac?, ap_mac?, ssid?, user_agent? }
//     → upsert the unified CRM contact (customers), write an append-only consent record,
//       log the capture, then authorize the guest onto WiFi (wifi-authorize).
//
// Scoping: client sends the PLATFORM location id (loc.id); we resolve the authoritative
// ops_location_id + company_id + org_id server-side and scope every write by them — the
// client can't spoof which venue a guest belongs to. Writes use the service role.
// Mirrors review-submit (the Review Manager anon pattern).
//
// UK GDPR/PECR: WiFi access is NEVER conditional on marketing consent (capture + authorize
// proceed regardless of marketing_consent); marketing is explicit opt-in only (no soft
// opt-in for WiFi); under-18s (DOB age-gate) are captured but never opted in to marketing.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

const FN_BASE = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1`;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Resolve platform location id → authoritative scoping keys. Never trust client copies.
async function resolveLocation(platformLocationId: string): Promise<{ opsLocationId: string; companyId: string | null } | null> {
  const { data } = await platformAdmin.from('locations')
    .select('id, ops_location_id, company_id')
    .or(`id.eq.${platformLocationId},ops_location_id.eq.${platformLocationId}`)
    .maybeSingle();
  if (!data) return null;
  return { opsLocationId: (data.ops_location_id || data.id) as string, companyId: (data.company_id ?? null) as string | null };
}

// Basic UK-leaning phone normalisation → E.164-ish digits; mirrors the spirit of customerLookup.
function normalisePhone(raw?: string): string | null {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('0')) s = '+44' + s.slice(1);          // UK national → +44
  if (!s.startsWith('+') && s.length >= 10) s = '+' + s;
  return s;
}

function ageFromDob(dob?: string): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? 'capture').trim();

  // ── portal_config: branding/fields/copy to render the portal ──────────────
  if (action === 'portal_config') {
    const loc = await resolveLocation(String(body.platform_location_id ?? '').trim());
    if (!loc) return json({ error: 'location not found' }, 404);
    const { data: cfg } = await opsAdmin.from('wifi_portal_settings')
      .select('enabled, headline, subtext, bg_image_url, logo_url, accent_color, button_style, fields, age_gate, marketing_copy, success_copy, redirect_url, terms_url, privacy_url, privacy_version, loyalty_offer, loyalty_copy')
      .eq('location_id', loc.opsLocationId).maybeSingle();
    return json({
      enabled: cfg?.enabled ?? true,
      headline: cfg?.headline ?? 'Connect to free WiFi',
      subtext: cfg?.subtext ?? null,
      bg_image_url: cfg?.bg_image_url ?? null,
      logo_url: cfg?.logo_url ?? null,
      accent_color: cfg?.accent_color ?? null,
      button_style: cfg?.button_style ?? 'dark',
      fields: cfg?.fields ?? null,                 // null → portal uses its built-in defaults
      age_gate: cfg?.age_gate ?? true,
      marketing_copy: cfg?.marketing_copy ?? 'Keep me updated with news, offers and events by email and SMS.',
      success_copy: cfg?.success_copy ?? "You're connected. Enjoy your visit!",
      redirect_url: cfg?.redirect_url ?? null,
      terms_url: cfg?.terms_url ?? null,
      privacy_url: cfg?.privacy_url ?? null,
      privacy_version: cfg?.privacy_version ?? 'v1',
      loyalty_offer: cfg?.loyalty_offer ?? false,
      loyalty_copy: cfg?.loyalty_copy ?? 'Join our rewards — earn points and get exclusive offers by email & SMS.',
    });
  }

  // ── reconnect: a device we've captured before → authorise instantly, no form (seamless return) ──
  if (action === 'reconnect') {
    const loc = await resolveLocation(String(body.platform_location_id ?? '').trim());
    if (!loc) return json({ error: 'location not found' }, 404);
    const clientMac = body.client_mac ? String(body.client_mac).slice(0, 40) : null;
    if (!clientMac) return json({ returning: false });
    // Seen this device sign up here before?
    const { data: prior } = await opsAdmin.from('wifi_captures')
      .select('customer_id').eq('location_id', loc.opsLocationId).eq('client_mac', clientMac)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!prior) return json({ returning: false });
    // Authorise straight onto WiFi — no details needed.
    let authorized = false, authMethod: string | null = null, voucherRedirectUrl: string | null = null;
    try {
      const r = await fetch(`${FN_BASE}/wifi-authorize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ ops_location_id: loc.opsLocationId, client_mac: clientMac, ap_mac: body.ap_mac ?? null, ssid: body.ssid ?? null }),
      });
      const j = await r.json().catch(() => ({}));
      authorized = !!j.authorized; authMethod = j.auth_method ?? null; voucherRedirectUrl = j.voucher_redirect_url ?? null;
    } catch (_e) { /* fall through to needs-form on the client if not authorised */ }
    await opsAdmin.from('wifi_captures').insert({
      location_id: loc.opsLocationId, company_id: loc.companyId, customer_id: prior.customer_id ?? null,
      client_mac: clientMac, ap_mac: body.ap_mac ? String(body.ap_mac).slice(0, 40) : null,
      ssid: body.ssid ? String(body.ssid).slice(0, 64) : null,
      is_return: true, marketing_opt_in: false, authorized, auth_method: authMethod,
    });
    return json({ returning: true, authorized, auth_method: authMethod, voucher_redirect_url: voucherRedirectUrl, customer_id: prior.customer_id ?? null });
  }

  // ── capture: upsert contact + consent + log + authorize ───────────────────
  if (action === 'capture') {
    const loc = await resolveLocation(String(body.platform_location_id ?? '').trim());
    if (!loc) return json({ error: 'location not found' }, 404);

    // org_id (ops) is the customers tenant key.
    const { data: opsLoc } = await opsAdmin.from('locations').select('org_id').eq('id', loc.opsLocationId).maybeSingle();
    const orgId = opsLoc?.org_id ?? null;
    if (!orgId) return json({ error: 'location not provisioned' }, 400);

    const email = body.email ? String(body.email).trim().toLowerCase().slice(0, 200) : null;
    const phone = normalisePhone(body.phone);
    const firstName = body.first_name ? String(body.first_name).trim().slice(0, 80) : null;
    const lastName = body.last_name ? String(body.last_name).trim().slice(0, 80) : null;
    const dob = body.dob ? String(body.dob).slice(0, 10) : null;       // YYYY-MM-DD
    const isLocal = typeof body.is_local === 'boolean' ? body.is_local : null;
    if (!email && !phone) return json({ error: 'email or phone required' }, 400);

    // 18+ gate: under-18s may use WiFi but are never opted into marketing or loyalty marketing.
    const age = ageFromDob(dob);
    const isMinor = age != null && age < 18;
    // "Join rewards" = loyalty enrolment AND marketing consent (one opt-in, per product spec).
    const joinLoyalty = body.join_loyalty === true && !isMinor;
    const wantsMarketing = (body.marketing_consent === true || joinLoyalty) && !isMinor;

    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || null;
    const nowIso = new Date().toISOString();

    // ── upsert the unified CRM contact (customers) ──
    // Match by phone first, else by (org_id, lower(email)). Fill blanks; don't clobber.
    let existing: any = null;
    if (phone) {
      const { data } = await opsAdmin.from('customers').select('*').eq('org_id', orgId).eq('phone', phone).is('deleted_at', null).maybeSingle();
      existing = data || null;
    }
    if (!existing && email) {
      const { data } = await opsAdmin.from('customers').select('*').eq('org_id', orgId).ilike('email', email).is('deleted_at', null).maybeSingle();
      existing = data || null;
    }

    let customerId: string;
    if (existing) {
      const patch: Record<string, unknown> = { updated_at: nowIso };
      if (email && !existing.email) patch.email = email;
      if (phone && !existing.phone) { patch.phone = phone; patch.phone_raw = String(body.phone).slice(0, 40); }
      if (firstName && !existing.first_name) patch.first_name = firstName;
      if (lastName && !existing.last_name) patch.last_name = lastName;
      if (fullName && !existing.name) patch.name = fullName;
      if (dob && !existing.birthday) patch.birthday = dob;
      if (isLocal != null && existing.is_local == null) patch.is_local = isLocal;
      const sources: string[] = Array.isArray(existing.sources) ? existing.sources : [];
      if (!sources.includes('wifi')) patch.sources = [...sources, 'wifi'];
      if (!existing.source) patch.source = 'wifi';
      if (wantsMarketing && !existing.marketing_opt_in) { patch.marketing_opt_in = true; patch.marketing_opt_in_at = nowIso; }
      await opsAdmin.from('customers').update(patch).eq('id', existing.id);
      customerId = existing.id;
    } else {
      const { data: ins, error: insErr } = await opsAdmin.from('customers').insert({
        org_id: orgId,
        email, phone, phone_raw: phone ? String(body.phone).slice(0, 40) : null,
        name: fullName, first_name: firstName, last_name: lastName,
        birthday: dob, is_local: isLocal,
        source: 'wifi', sources: ['wifi'],
        marketing_opt_in: wantsMarketing, marketing_opt_in_at: wantsMarketing ? nowIso : null,
      }).select('id').single();
      if (insErr) return json({ error: insErr.message }, 500);
      customerId = ins.id;
    }

    // ── visit tracking (customer_locations uses uuid location_id) ──
    try {
      const { data: cl } = await opsAdmin.from('customer_locations')
        .select('customer_id, visit_count').eq('customer_id', customerId).eq('location_id', loc.opsLocationId).maybeSingle();
      if (cl) {
        await opsAdmin.from('customer_locations').update({ last_visit_at: nowIso, visit_count: (cl.visit_count ?? 0) + 1 }).eq('customer_id', customerId).eq('location_id', loc.opsLocationId);
      } else {
        await opsAdmin.from('customer_locations').insert({ customer_id: customerId, location_id: loc.opsLocationId, first_visit_at: nowIso, last_visit_at: nowIso, visit_count: 1 });
      }
    } catch (_e) { /* visit tracking is best-effort */ }

    // ── append-only consent ledger (record the explicit decision, opt-in OR refusal) ──
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    await opsAdmin.from('customer_consents').insert({
      customer_id: customerId, org_id: orgId, location_id: loc.opsLocationId, company_id: loc.companyId,
      channel: 'both', purpose: 'marketing', consented: wantsMarketing,
      source: 'wifi', method: 'explicit_optin',
      consent_text: body.consent_text ? String(body.consent_text).slice(0, 1000) : null,
      privacy_version: body.privacy_version ? String(body.privacy_version).slice(0, 40) : null,
      ip, user_agent: body.user_agent ? String(body.user_agent).slice(0, 400) : (req.headers.get('user-agent') || null),
    });

    // ── capture log (de-dup / analytics) ──
    const clientMac = body.client_mac ? String(body.client_mac).slice(0, 40) : null;
    let isReturn = false;
    if (clientMac) {
      const { count } = await opsAdmin.from('wifi_captures').select('id', { count: 'exact', head: true })
        .eq('location_id', loc.opsLocationId).eq('client_mac', clientMac);
      isReturn = (count ?? 0) > 0;
    }

    // ── authorize onto WiFi (proceeds regardless of marketing consent) ──
    let authorized = false, authMethod: string | null = null, voucherRedirectUrl: string | null = null;
    try {
      const r = await fetch(`${FN_BASE}/wifi-authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ ops_location_id: loc.opsLocationId, client_mac: clientMac, ap_mac: body.ap_mac ?? null, ssid: body.ssid ?? null }),
      });
      const j = await r.json().catch(() => ({}));
      authorized = !!j.authorized; authMethod = j.auth_method ?? null; voucherRedirectUrl = j.voucher_redirect_url ?? null;
    } catch (_e) { /* never block capture on authorize failure */ }

    await opsAdmin.from('wifi_captures').insert({
      location_id: loc.opsLocationId, company_id: loc.companyId, customer_id: customerId,
      client_mac: clientMac, ap_mac: body.ap_mac ? String(body.ap_mac).slice(0, 40) : null,
      ssid: body.ssid ? String(body.ssid).slice(0, 64) : null,
      is_return: isReturn, marketing_opt_in: wantsMarketing, authorized, auth_method: authMethod,
    });

    // "Join rewards" → enrol in loyalty (reuses the same machinery as purchase auto-enrol).
    let loyaltyEnrolled = false, memberCode: string | null = null;
    if (joinLoyalty && loc.companyId) {
      try {
        const r = await fetch(`${FN_BASE}/loyalty-enroll`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
          body: JSON.stringify({ customer_id: customerId, company_id: loc.companyId, location_id: loc.opsLocationId, source: 'wifi' }),
        });
        const j = await r.json().catch(() => ({}));
        loyaltyEnrolled = !!j.enrolled; memberCode = j.member_code ?? null;
      } catch (_e) { /* never block capture on loyalty enrol failure */ }
    }

    // Optional welcome on a brand-new, opted-in contact (fire-and-forget; send-welcome dedups).
    // Skipped when loyalty enrolled — ensureMembership already sends its own welcome credit/message.
    if (!existing && wantsMarketing && !loyaltyEnrolled) {
      fetch(`${FN_BASE}/send-welcome`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ customer_id: customerId, company_id: loc.companyId, location_id: loc.opsLocationId }),
      }).catch(() => {});
    }

    return json({ ok: true, customer_id: customerId, is_return: isReturn, marketing_opt_in: wantsMarketing, is_minor: isMinor, loyalty_enrolled: loyaltyEnrolled, member_code: memberCode, authorized, auth_method: authMethod, voucher_redirect_url: voucherRedirectUrl });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
