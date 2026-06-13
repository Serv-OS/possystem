// supabase/functions/review-submit/index.ts
//
// PUBLIC review card endpoint (anonymous — the customer is not logged in).
// Three actions:
//   card_config  { platform_location_id }            → public copy/config to render the card
//   submit       { platform_location_id, rating, comment, customer_* , channel? }
//                  → THE ROUTING RULE: is_public = rating >= venue threshold, enforced
//                    HERE (never trusted from the client). Stores the feedback; for a
//                    public review returns the connected platforms it's being posted to.
//   add_contact  { feedback_id, private_detail?, customer_email?, customer_phone? }
//                  → attach recovery detail/contact to a PRIVATE (under-threshold) review.
//
// Scoping: the client sends the PLATFORM location id (loc.id). We resolve the
// authoritative ops_location_id + company_id from the platform locations row and
// scope the Ops review_* rows by ops_location_id — so a client can't spoof which
// venue a review belongs to. Writes use the service role (RLS is read-only for
// clients). Mirrors the gift-redeem anonymous pattern.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

const DEFAULT_THRESHOLD = 3;

// Resolve the platform location id → { opsLocationId, companyId }. Authoritative;
// never trust the client's own copy of these for the scoping key.
async function resolveLocation(platformLocationId: string): Promise<{ opsLocationId: string; companyId: string | null } | null> {
  const { data } = await platformAdmin.from('locations')
    .select('id, ops_location_id, company_id')
    .or(`id.eq.${platformLocationId},ops_location_id.eq.${platformLocationId}`)
    .maybeSingle();
  if (!data) return null;
  return { opsLocationId: (data.ops_location_id || data.id) as string, companyId: (data.company_id ?? null) as string | null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? 'submit').trim();

  // ── card_config: public copy + config for rendering the card ──────────────
  if (action === 'card_config') {
    const loc = await resolveLocation(String(body.platform_location_id ?? '').trim());
    if (!loc) return json({ error: 'location not found' }, 404);
    const { data: cfg } = await opsAdmin.from('review_settings')
      .select('enabled, threshold, page_title, intro_copy, thanks_public_copy, thanks_private_copy, custom_copy')
      .eq('location_id', loc.opsLocationId).maybeSingle();
    return json({
      enabled: cfg?.enabled ?? true,
      page_title: cfg?.page_title ?? null,
      intro_copy: cfg?.intro_copy ?? null,
      thanks_public_copy: cfg?.thanks_public_copy ?? null,
      thanks_private_copy: cfg?.thanks_private_copy ?? null,
      custom_copy: cfg?.custom_copy ?? {},
    });
  }

  // ── submit: store feedback + route by rating vs threshold ─────────────────
  if (action === 'submit') {
    const loc = await resolveLocation(String(body.platform_location_id ?? '').trim());
    if (!loc) return json({ error: 'location not found' }, 404);
    const rating = Math.round(Number(body.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) return json({ error: 'rating must be 1–5' }, 400);

    const { data: cfg } = await opsAdmin.from('review_settings')
      .select('threshold, enabled').eq('location_id', loc.opsLocationId).maybeSingle();
    if (cfg?.enabled === false) return json({ error: 'reviews are not enabled for this venue' }, 400);
    const threshold = Number(cfg?.threshold ?? DEFAULT_THRESHOLD);
    const isPublic = rating >= threshold;   // ← THE invariant, server-side

    const channel = ['email', 'sms', 'qr', 'wifi', 'web'].includes(body.channel) ? body.channel : 'web';
    const { data: row, error } = await opsAdmin.from('review_feedback').insert({
      location_id: loc.opsLocationId,
      company_id: loc.companyId,
      customer_name: body.customer_name?.toString().slice(0, 120) || null,
      customer_email: body.customer_email?.toString().slice(0, 200) || null,
      customer_phone: body.customer_phone?.toString().slice(0, 40) || null,
      rating,
      comment: body.comment?.toString().slice(0, 4000) || null,
      is_public: isPublic,
      origin: 'card',
      channel,
      status: 'new',
    }).select('id').single();
    if (error) return json({ error: error.message }, 500);

    // For a public review, surface the platforms it's being auto-published to
    // (intent recorded; real posting is stubbed until the platform OAuth lands).
    let platforms: Array<{ platform: string; status: string }> = [];
    if (isPublic) {
      const { data: links } = await opsAdmin.from('review_platform_links')
        .select('platform').eq('location_id', loc.opsLocationId).eq('enabled', true);
      platforms = (links ?? []).map((l: any) => ({ platform: l.platform, status: 'posting' }));
      if (platforms.length) {
        await opsAdmin.from('review_feedback').update({
          published_to: platforms.map((p) => ({ platform: p.platform, status: 'posting', at: new Date().toISOString() })),
        }).eq('id', row.id);
      }
    }
    return json({ ok: true, feedback_id: row.id, is_public: isPublic, platforms }, 201);
  }

  // ── add_contact: attach recovery detail/contact to a PRIVATE review ───────
  if (action === 'add_contact') {
    const id = String(body.feedback_id ?? '').trim();
    if (!id) return json({ error: 'feedback_id required' }, 400);
    const { data: fb } = await opsAdmin.from('review_feedback').select('id, is_public').eq('id', id).maybeSingle();
    if (!fb) return json({ error: 'not found' }, 404);
    if (fb.is_public) return json({ error: 'not a private review' }, 400);   // never accept contact on a public one here
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.private_detail != null) patch.private_detail = String(body.private_detail).slice(0, 4000);
    if (body.customer_email != null) patch.customer_email = String(body.customer_email).slice(0, 200);
    if (body.customer_phone != null) patch.customer_phone = String(body.customer_phone).slice(0, 40);
    const { error } = await opsAdmin.from('review_feedback').update(patch).eq('id', id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
