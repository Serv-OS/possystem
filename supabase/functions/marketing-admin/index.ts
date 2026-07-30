// supabase/functions/marketing-admin/index.ts
//
// Back-office marketing admin (offers + promo codes). Auth mirrors wifi-admin/review-admin: a staff
// user with access to the active location (user_locations) or super_admin; offers are org-scoped, org
// resolved server-side from the location. Actions:
//   list_offers { ops_location_id }
//   save_offer  { ops_location_id, offer:{...} }                       → upsert (org from location)
//   issue_code  { ops_location_id, offer_id, customer_id?, uses_allowed?, expires_at? } → { code }
//   lookup_code { ops_location_id, code }                              → code + offer + redemptions
//   void_code   { ops_location_id, code }
//   offer_stats { ops_location_id, offer_id }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { genCode } from '../_shared/promo.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// Non-secret offer fields the BO may set directly.
const OFFER_FIELDS = ['name', 'description', 'reward_type', 'reward_value', 'reward_item_id', 'reward_label',
  'min_spend', 'include_category_ids', 'exclude_category_ids', 'valid_from', 'valid_to', 'venue_ids',
  'per_customer_limit', 'total_cap', 'code_prefix', 'code_length', 'stackable', 'active'];

async function authed(req: Request, opsLocationId: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return false;
  const { data: ul } = await opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', opsLocationId).maybeSingle();
  if (ul) return true;
  const { data: prof } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  return prof?.role === 'super_admin';
}

async function orgFor(opsLocationId: string): Promise<{ org_id: string | null; company_id: string | null }> {
  // Ops `locations` has org_id only; company_id lives on the platform DB (not needed for slice-1 offers).
  const { data } = await opsAdmin.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  return { org_id: data?.org_id ?? null, company_id: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const ops = String(body?.ops_location_id ?? '').trim();
  if (!action || !ops) return json({ error: 'action and ops_location_id required' }, 400);
  if (!(await authed(req, ops))) return json({ error: 'no access to this location' }, 403);
  const { org_id, company_id } = await orgFor(ops);
  if (!org_id) return json({ error: 'location not provisioned (no org)' }, 400);

  if (action === 'list_offers') {
    const { data } = await opsAdmin.from('offers').select('*').eq('org_id', org_id).order('created_at', { ascending: false });
    return json({ offers: data ?? [] });
  }

  if (action === 'save_offer') {
    const incoming = body.offer || {};
    const row: Record<string, unknown> = { org_id, company_id, updated_at: new Date().toISOString() };
    for (const k of OFFER_FIELDS) if (k in incoming) row[k] = incoming[k];
    if (incoming.id) row.id = incoming.id;
    if (!row.name) return json({ error: 'name required' }, 400);
    const { data, error } = await opsAdmin.from('offers').upsert(row, { onConflict: 'id' }).select('*').maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, offer: data });
  }

  if (action === 'issue_code') {
    const offerId = String(body.offer_id ?? '').trim();
    if (!offerId) return json({ error: 'offer_id required' }, 400);
    const { data: offer } = await opsAdmin.from('offers').select('*').eq('id', offerId).eq('org_id', org_id).maybeSingle();
    if (!offer) return json({ error: 'offer not found' }, 404);
    // Generate a unique code (retry on the rare collision against the unique index).
    let code = '', inserted = null, lastErr = '';
    for (let attempt = 0; attempt < 6 && !inserted; attempt++) {
      code = genCode(offer.code_prefix || '', offer.code_length || 5);
      const { data, error } = await opsAdmin.from('promo_codes').insert({
        offer_id: offer.id, org_id, company_id, code,
        customer_id: body.customer_id ? String(body.customer_id) : null,
        uses_allowed: Number(body.uses_allowed) || 1,
        expires_at: body.expires_at || offer.valid_to || null,
        status: 'issued',
      }).select('id, code').maybeSingle();
      if (!error) inserted = data; else lastErr = error.message;
    }
    if (!inserted) return json({ error: `could not issue code: ${lastErr}` }, 500);
    try { await opsAdmin.from('offers').update({ issued_count: (offer.issued_count ?? 0) + 1, updated_at: new Date().toISOString() }).eq('id', offer.id); } catch (_e) {}
    return json({ ok: true, code: inserted.code, id: inserted.id });
  }

  if (action === 'lookup_code') {
    const code = String(body.code ?? '').trim();
    if (!code) return json({ error: 'code required' }, 400);
    const { data: row } = await opsAdmin.from('promo_codes').select('*').ilike('code', code).eq('org_id', org_id).maybeSingle();
    if (!row) return json({ found: false });
    const [{ data: offer }, { data: reds }] = await Promise.all([
      opsAdmin.from('offers').select('id, name, reward_type, reward_value, reward_label').eq('id', row.offer_id).maybeSingle(),
      opsAdmin.from('promo_redemptions').select('redeemed_at, location_id, order_id, discount_value, customer_id').eq('promo_code_id', row.id).order('redeemed_at', { ascending: false }),
    ]);
    return json({ found: true, code: row, offer, redemptions: reds ?? [] });
  }

  if (action === 'void_code') {
    const code = String(body.code ?? '').trim();
    if (!code) return json({ error: 'code required' }, 400);
    const { error } = await opsAdmin.from('promo_codes').update({ status: 'voided', voided_at: new Date().toISOString(), updated_at: new Date().toISOString() }).ilike('code', code).eq('org_id', org_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'offer_stats') {
    const offerId = String(body.offer_id ?? '').trim();
    const head = (q: any) => q.then((r: any) => r.count ?? 0);
    const [issued, redeemed] = await Promise.all([
      head(opsAdmin.from('promo_codes').select('id', { count: 'exact', head: true }).eq('offer_id', offerId).eq('org_id', org_id)),
      head(opsAdmin.from('promo_redemptions').select('id', { count: 'exact', head: true }).eq('offer_id', offerId).eq('org_id', org_id)),
    ]);
    const { data: reds } = await opsAdmin.from('promo_redemptions').select('discount_value').eq('offer_id', offerId).eq('org_id', org_id);
    const value = (reds ?? []).reduce((s: number, r: any) => s + (Number(r.discount_value) || 0), 0);
    return json({ issued, redeemed, redemption_rate: issued ? redeemed / issued : 0, discount_value: value });
  }

  // ── v5.5.946: codes report — used / left / who each code went to ─────────────
  // Per-code rows joined to customers + campaigns, filterable by offer/campaign/status,
  // paged. This is the org's code ledger; the UI (Marketing report → Codes) renders it.
  if (action === 'codes_report') {
    const offerId = String(body.offer_id ?? '').trim();
    const campaignId = String(body.campaign_id ?? '').trim();
    const status = String(body.status ?? '').trim();          // issued | redeemed | voided | expired
    const limit = Math.min(Number(body.limit) || 200, 500);
    const offset = Math.max(Number(body.offset) || 0, 0);

    let q = opsAdmin.from('promo_codes')
      .select('id, code, status, uses_allowed, uses_count, issued_at, expires_at, redeemed_at, redeemed_value, redeemed_location_id, customer_id, campaign_id, offer_id', { count: 'exact' })
      .eq('org_id', org_id)
      .order('issued_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (offerId) q = q.eq('offer_id', offerId);
    if (campaignId) q = q.eq('campaign_id', campaignId);
    if (status) q = q.eq('status', status);
    const { data: codes, error, count } = await q;
    if (error) return json({ error: error.message }, 500);

    // Resolve names in bulk — never per-row.
    const custIds = [...new Set((codes ?? []).map((c: any) => c.customer_id).filter(Boolean))];
    const campIds = [...new Set((codes ?? []).map((c: any) => c.campaign_id).filter(Boolean))];
    const offerIds = [...new Set((codes ?? []).map((c: any) => c.offer_id).filter(Boolean))];
    const [custs, camps, offs] = await Promise.all([
      custIds.length ? opsAdmin.from('customers').select('id, name, first_name, last_name, email, phone').in('id', custIds) : Promise.resolve({ data: [] }),
      campIds.length ? opsAdmin.from('campaigns').select('id, name').in('id', campIds) : Promise.resolve({ data: [] }),
      offerIds.length ? opsAdmin.from('offers').select('id, name, reward_label').in('id', offerIds) : Promise.resolve({ data: [] }),
    ]);
    const custBy = Object.fromEntries((custs.data ?? []).map((c: any) => [c.id, c]));
    const campBy = Object.fromEntries((camps.data ?? []).map((c: any) => [c.id, c.name]));
    const offBy = Object.fromEntries((offs.data ?? []).map((o: any) => [o.id, o]));

    const rows = (codes ?? []).map((c: any) => {
      const cu = c.customer_id ? custBy[c.customer_id] : null;
      return {
        ...c,
        customer_name: cu ? (cu.name || [cu.first_name, cu.last_name].filter(Boolean).join(' ') || null) : null,
        customer_email: cu?.email ?? null,
        customer_phone: cu?.phone ?? null,
        campaign_name: c.campaign_id ? (campBy[c.campaign_id] ?? null) : null,
        offer_name: c.offer_id ? (offBy[c.offer_id]?.name ?? null) : null,
        offer_reward: c.offer_id ? (offBy[c.offer_id]?.reward_label ?? null) : null,
      };
    });

    // Rollup for the header tiles (same filters, no paging).
    let rq = opsAdmin.from('promo_codes').select('status', { count: 'exact', head: false }).eq('org_id', org_id).limit(10000);
    if (offerId) rq = rq.eq('offer_id', offerId);
    if (campaignId) rq = rq.eq('campaign_id', campaignId);
    const { data: allStatuses } = await rq;
    const tally: Record<string, number> = {};
    for (const r of (allStatuses ?? [])) tally[r.status] = (tally[r.status] || 0) + 1;

    return json({ ok: true, rows, total: count ?? rows.length, tally });
  }

  // ── v5.5.946: one-time Resend wiring — open/click tracking + event webhook ───
  // 6 emails had been sent with ZERO delivered/opened events: the webhook endpoint was
  // never registered with Resend. This action does the whole job with the key the
  // function already holds: enables tracking on every domain, then creates the webhook
  // pointing at marketing-webhook (idempotent — skips if one already points there).
  if (action === 'resend_webhook_setup') {
    const key = Deno.env.get('RESEND_API_KEY') ?? '';
    if (!key) return json({ error: 'RESEND_API_KEY not configured' }, 400);
    const hookSecret = Deno.env.get('MARKETING_WEBHOOK_SECRET') || '';
    const endpoint = `${Deno.env.get('SUPABASE_URL')}/functions/v1/marketing-webhook?provider=resend${hookSecret ? `&key=${encodeURIComponent(hookSecret)}` : ''}`;
    const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

    const domRes = await fetch('https://api.resend.com/domains', { headers: H });
    const doms = await domRes.json().catch(() => null);
    const tracked: string[] = [];
    for (const d of (doms?.data ?? [])) {
      const r = await fetch(`https://api.resend.com/domains/${d.id}`, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({ open_tracking: true, click_tracking: true }),
      });
      if (r.ok) tracked.push(d.name);
    }

    const hooksRes = await fetch('https://api.resend.com/webhooks', { headers: H });
    const hooks = await hooksRes.json().catch(() => null);
    const existing = (hooks?.data ?? []).find((w: any) => String(w.endpoint || '').includes('/marketing-webhook'));
    if (existing) return json({ ok: true, already: true, webhook_id: existing.id, tracked, endpoint: existing.endpoint });

    const createRes = await fetch('https://api.resend.com/webhooks', {
      method: 'POST', headers: H,
      body: JSON.stringify({ endpoint, events: ['email.delivered', 'email.opened', 'email.clicked', 'email.bounced', 'email.complained'] }),
    });
    const created = await createRes.json().catch(() => null);
    if (!createRes.ok) return json({ error: `webhook create failed: ${JSON.stringify(created)}` }, 502);
    return json({ ok: true, webhook_id: created?.id ?? null, tracked, endpoint });
  }

  return json({ error: 'unknown action' }, 400);
});
