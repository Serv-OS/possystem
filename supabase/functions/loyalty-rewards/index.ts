// supabase/functions/loyalty-rewards/index.ts
//
// CRUD for loyalty rewards catalog (back office).
//
// GET:    ?location_id=xxx                      → list all rewards
// POST:   { location_id, ...reward }            → create reward
// PATCH:  { location_id, id, ...patch }         → update reward
// DELETE: { location_id, id }                   → soft-delete (set active=false)

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
} from '../_shared/loyalty-utils.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // Auth
  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  // ── GET: list rewards ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const locationId = url.searchParams.get('location_id');
    const resolved = await resolveCompanyForLocation(caller.id, locationId);
    if (resolved instanceof Response) return resolved;

    const { data, error } = await platformAdmin
      .from('loyalty_rewards')
      .select('*')
      .eq('company_id', resolved)
      .order('sort_order');

    if (error) return json({ error: error.message }, 500);
    return json({ rewards: data || [] });
  }

  // ── Parse body for POST/PATCH/DELETE ───────────────────────────────────
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { location_id } = body as any;
  const resolved = await resolveCompanyForLocation(caller.id, location_id as string);
  if (resolved instanceof Response) return resolved;
  const companyId = resolved;

  // ── POST: create reward ────────────────────────────────────────────────
  if (req.method === 'POST') {
    const {
      name, description, icon, points_cost, reward_type, reward_value,
      location_ids, channels, min_order_minor, max_per_order,
      max_per_customer, total_available, sort_order, starts_at, ends_at,
    } = body as any;

    if (!name || !points_cost || !reward_type) {
      return json({ error: 'name, points_cost, and reward_type are required' }, 400);
    }

    const { data, error } = await platformAdmin
      .from('loyalty_rewards')
      .insert({
        company_id: companyId,
        name,
        description: description || '',
        icon: icon || 'gift',
        points_cost: Math.round(Number(points_cost)),
        reward_type,
        reward_value: reward_value || {},
        location_ids: location_ids || [],
        channels: channels || ['pos', 'kiosk', 'online', 'qr'],
        min_order_minor: min_order_minor || 0,
        max_per_order: max_per_order || 1,
        max_per_customer: max_per_customer || null,
        total_available: total_available || null,
        sort_order: sort_order || 0,
        starts_at: starts_at || null,
        ends_at: ends_at || null,
      })
      .select()
      .single();

    if (error) return json({ error: error.message }, 500);
    return json({ reward: data }, 201);
  }

  // ── PATCH: update reward ───────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id, ...patch } = body as any;
    if (!id) return json({ error: 'id required' }, 400);

    // Remove non-updatable fields
    delete patch.location_id;
    delete patch.company_id;
    delete patch.total_redeemed;
    delete patch.created_at;

    patch.updated_at = new Date().toISOString();

    const { data, error } = await platformAdmin
      .from('loyalty_rewards')
      .update(patch)
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single();

    if (error) return json({ error: error.message }, 500);
    return json({ reward: data });
  }

  // ── DELETE: deactivate reward ──────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = body as any;
    if (!id) return json({ error: 'id required' }, 400);

    const { error } = await platformAdmin
      .from('loyalty_rewards')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId);

    if (error) return json({ error: error.message }, 500);
    return json({ status: 'deactivated' });
  }

  return json({ error: 'method not allowed' }, 405);
});
