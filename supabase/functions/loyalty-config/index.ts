// supabase/functions/loyalty-config/index.ts
//
// Read or update loyalty configuration for a company.
//
// GET:  ?location_id=xxx           → returns config
// POST: { location_id, ...patch }  → updates config, returns updated
//
// Also returns rewards catalog and tiers for the "full config" read.

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
  getOrCreateConfig,
} from '../_shared/loyalty-utils.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // Auth
  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  // ── GET: read config ───────────────────────────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const locationId = url.searchParams.get('location_id');

    const resolved = await resolveCompanyForLocation(caller.id, locationId);
    if (resolved instanceof Response) return resolved;
    const companyId = resolved;

    const config = await getOrCreateConfig(companyId);
    if (!config) return json({ error: 'Failed to load config' }, 500);

    // Also fetch rewards and tiers
    const [{ data: rewards }, { data: tiers }] = await Promise.all([
      platformAdmin.from('loyalty_rewards')
        .select('*')
        .eq('company_id', companyId)
        .order('sort_order'),
      platformAdmin.from('loyalty_tiers')
        .select('*')
        .eq('company_id', companyId)
        .order('sort_order'),
    ]);

    return json({
      config,
      rewards: rewards || [],
      tiers: tiers || [],
    });
  }

  // ── POST: update config ────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const { location_id, ...patch } = body as any;

    const resolved = await resolveCompanyForLocation(caller.id, location_id);
    if (resolved instanceof Response) return resolved;
    const companyId = resolved;

    // Ensure config exists
    await getOrCreateConfig(companyId);

    // Whitelist fields that can be updated
    const allowed = [
      'enabled', 'points_enabled', 'points_per_currency_unit', 'points_currency_value',
      'points_rounding', 'points_expiry_months',
      'earn_on_gift_card_purchase', 'earn_on_staff_discount', 'earn_on_comps',
      'earn_on_delivery_fee', 'earn_on_service_charge', 'earn_on_tax',
      'excluded_category_ids', 'excluded_item_ids',
      'registration_bonus', 'birthday_bonus', 'referral_bonus', 'referral_referee_bonus',
      'branding',
    ];

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (key in patch) updates[key] = patch[key];
    }

    const { data, error } = await platformAdmin
      .from('loyalty_config')
      .update(updates)
      .eq('company_id', companyId)
      .select()
      .single();

    if (error) return json({ error: error.message }, 500);

    return json({ config: data });
  }

  return json({ error: 'method not allowed' }, 405);
});
