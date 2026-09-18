// supabase/functions/gift-config/index.ts
//
// v5.5.200: Manages gift_brand_config via edge function.
// Back office users authenticate on Ops DB but gift_brand_config lives on
// Platform DB where they have no auth session. This function bridges the gap
// using service_role access to Platform DB.
//
// Body: { action, ...data }
// Actions:
//   'get'      → returns current config
//   'enable'   → creates or enables gift_brand_config
//   'disable'  → sets enabled=false
//   'settings' → updates min/max/expiry/currency
//   'branding' → updates branding JSONB

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation, generateHmacSecret,
} from '../_shared/gift-card-utils.ts';
import { requireStaff } from '../_shared/loyalty-utils.ts';

// The per company HMAC secret gift codes are looked up with never leaves the server
// (INVARIANTS: "Never log or expose these"). Back Office never read it.
function withoutSecret(c: any) {
  if (!c || typeof c !== 'object') return c;
  const { hmac_secret: _drop, ...rest } = c;
  return rest;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  // v5.5.207: resolve company via location_id (reliable) with user fallback
  const companyResult = await resolveCompanyForLocation(caller.id, body.location_id as string);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  // ── Staff only, every action (18 Sep 2026, round three, enforced now) ──
  // Any session could switch a venue's gift cards off, change the card value limits or the
  // branding, and 'get' returned the whole row (including the HMAC secret the codes are looked
  // up with). The only caller is Back Office (GiftCards.jsx). Customer pages read
  // gift-branding-public instead.
  const refused = await requireStaff({
    fn: 'gift-config', caller, locationId: (body.location_id as string) || null, companyId,
    what: 'change gift card settings', body,
  });
  if (refused) return refused;

  const action = body.action as string;

  // ── GET — return current config ──────────────────────────────────────
  if (action === 'get') {
    const { data } = await platformAdmin
      .from('gift_brand_config')
      .select('*')
      .eq('company_id', companyId)
      .maybeSingle();
    return json({ config: withoutSecret(data) });
  }

  // ── ENABLE — create or enable ────────────────────────────────────────
  if (action === 'enable') {
    let { data: config } = await platformAdmin
      .from('gift_brand_config')
      .select('*')
      .eq('company_id', companyId)
      .maybeSingle();

    if (config) {
      const { error } = await platformAdmin
        .from('gift_brand_config')
        .update({ enabled: true })
        .eq('company_id', companyId);
      if (error) return json({ error: error.message }, 500);
      config.enabled = true;
    } else {
      const hmacSecret = generateHmacSecret();
      const { data: newConfig, error } = await platformAdmin
        .from('gift_brand_config')
        .insert({ company_id: companyId, enabled: true, hmac_secret: hmacSecret })
        .select('*')
        .single();
      if (error) return json({ error: error.message }, 500);
      config = newConfig;
    }
    return json({ config: withoutSecret(config) });
  }

  // ── DISABLE ──────────────────────────────────────────────────────────
  if (action === 'disable') {
    const { data: config } = await platformAdmin
      .from('gift_brand_config')
      .select('*')
      .eq('company_id', companyId)
      .maybeSingle();
    if (config) {
      const { error } = await platformAdmin
        .from('gift_brand_config')
        .update({ enabled: false })
        .eq('company_id', companyId);
      if (error) return json({ error: error.message }, 500);
    }
    return json({ config: config ? withoutSecret({ ...config, enabled: false }) : null });
  }

  // ── SETTINGS — update min/max/expiry/currency ────────────────────────
  if (action === 'settings') {
    const updates: Record<string, unknown> = {};
    if (body.min_card_value_minor !== undefined) updates.min_card_value_minor = body.min_card_value_minor;
    if (body.max_card_value_minor !== undefined) updates.max_card_value_minor = body.max_card_value_minor;
    if (body.default_expiry_months !== undefined) updates.default_expiry_months = body.default_expiry_months;
    if (body.currency !== undefined) updates.currency = body.currency;

    const { error } = await platformAdmin
      .from('gift_brand_config')
      .update(updates)
      .eq('company_id', companyId);
    if (error) return json({ error: error.message }, 500);

    // Return updated config
    const { data: config } = await platformAdmin
      .from('gift_brand_config')
      .select('*')
      .eq('company_id', companyId)
      .maybeSingle();
    return json({ config: withoutSecret(config) });
  }

  // ── BRANDING — update branding JSONB ─────────────────────────────────
  if (action === 'branding') {
    const { error } = await platformAdmin
      .from('gift_brand_config')
      .update({ branding: body.branding })
      .eq('company_id', companyId);
    if (error) return json({ error: error.message }, 500);

    const { data: config } = await platformAdmin
      .from('gift_brand_config')
      .select('*')
      .eq('company_id', companyId)
      .maybeSingle();
    return json({ config: withoutSecret(config) });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
