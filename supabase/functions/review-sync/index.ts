// supabase/functions/review-sync/index.ts
//
// INBOUND sync — pulls reviews left directly on connected platforms into the
// same unified queue. For each enabled platform_link: fetch reviews (adapter),
// DEDUP by external_review_id, upsert review_feedback (origin='synced',
// source_platform, is_public=true — a platform review is already public), and
// create a pending review_replies row so it shows in the Approval Queue with an
// AI draft to approve. Idempotent: re-running never double-imports.
//
//   (no action) { ops_location_id }  — one venue (staff or service-role)
//   sync_all    {}                   — every venue with a connected platform (service-role; cron)
//
// Auth: a staff user with access to the location (user_locations or super_admin),
// OR the service-role key (for a scheduled cron). `simulated_reviews` lets an
// authed caller inject test reviews so the whole loop is exercisable before
// platform OAuth is wired.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchReviews, PLATFORM_CAPS, type Platform, type PlatformReview } from '../_shared/review-platforms.ts';
import { accessTokenFrom, listReviews } from '../_shared/google-reviews.ts';

// Pull live Google Business Profile reviews for a connected venue (token stored
// by review-google). Returns [] (never throws) so one platform can't break sync.
async function googleReviewsFor(opsLocationId: string, opsAdmin: any): Promise<PlatformReview[]> {
  try {
    const { data: t } = await opsAdmin.from('review_google_tokens').select('refresh_token, location_name').eq('location_id', opsLocationId).maybeSingle();
    if (!t?.refresh_token || !t?.location_name) return [];
    const at = await accessTokenFrom(t.refresh_token);
    return await listReviews(at, t.location_name);
  } catch (e) { console.error('[review-sync] google pull failed', (e as Error).message); return []; }
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

async function authorize(req: Request, opsLocationId: string): Promise<boolean> {
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

async function syncLocation(opsLocationId: string, injected: Record<string, PlatformReview[]> = {}) {
  const { data: links } = await opsAdmin.from('review_platform_links')
    .select('platform, url, external_place_id, company_id, enabled')
    .eq('location_id', opsLocationId).eq('enabled', true);
  if (!links?.length) return { synced: 0, by_platform: {}, note: 'no connected platforms' };

  const byPlatform: Record<string, number> = {};
  let synced = 0;
  for (const link of links) {
    const platform = link.platform as Platform;
    const reviews = injected[platform]
      ?? (platform === 'google'
        ? await googleReviewsFor(opsLocationId, opsAdmin)
        : await fetchReviews({ platform, url: link.url, external_place_id: link.external_place_id }));
    let added = 0;
    for (const rv of reviews) {
      if (!rv.external_review_id) continue;
      // DEDUP: external_review_id is globally unique on review_feedback.
      const { data: exists } = await opsAdmin.from('review_feedback').select('id').eq('external_review_id', rv.external_review_id).maybeSingle();
      if (exists) continue;
      const { data: fb, error } = await opsAdmin.from('review_feedback').insert({
        location_id: opsLocationId, company_id: link.company_id ?? null,
        customer_name: rv.customer_name, rating: rv.rating, comment: rv.comment,
        is_public: true, origin: 'synced', source_platform: platform,
        external_review_id: rv.external_review_id, status: 'new',
        created_at: rv.created_at,
      }).select('id').single();
      if (error) continue;
      // Queue a pending reply (AI draft filled on demand in the Approval Queue).
      await opsAdmin.from('review_replies').insert({
        feedback_id: fb.id, location_id: opsLocationId, kind: 'public_reply', status: 'pending',
      });
      added++; synced++;
    }
    byPlatform[platform] = added;
    await opsAdmin.from('review_platform_links').update({ last_synced_at: new Date().toISOString() })
      .eq('location_id', opsLocationId).eq('platform', platform);
  }

  return { synced, by_platform: byPlatform };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();

  // sync_all — cron only (service-role). Bounded to venues with a connected
  // platform; one location can have several links, so sync each venue once.
  if (action === 'sync_all') {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    // !token matters: SERVICE_ROLE is '' when the env var is unset, so a bare
    // unauthenticated POST would otherwise compare equal and walk straight through.
    if (!token || token !== SERVICE_ROLE) return json({ error: 'service role required' }, 403);
    const { data: rows } = await opsAdmin.from('review_platform_links').select('location_id').eq('enabled', true);
    const out: Record<string, unknown> = {};
    for (const id of new Set((rows || []).map((r) => r.location_id))) out[id] = await syncLocation(id);
    return json({ ok: true, locations: out });
  }

  const opsLocationId = String(body.ops_location_id ?? '').trim();
  if (!opsLocationId) return json({ error: 'ops_location_id required' }, 400);
  if (!(await authorize(req, opsLocationId))) return json({ error: 'no access to this location' }, 403);

  const injected: Record<string, PlatformReview[]> = {};
  if (Array.isArray(body.simulated_reviews)) {
    for (const r of body.simulated_reviews) {
      const p = String(r.platform);
      (injected[p] ||= []).push({
        external_review_id: String(r.external_review_id),
        rating: Math.max(1, Math.min(5, Math.round(Number(r.rating)))),
        comment: r.comment ?? null, customer_name: r.customer_name ?? null,
        created_at: r.created_at ?? new Date().toISOString(),
      });
    }
  }

  return json({ ok: true, ...(await syncLocation(opsLocationId, injected)), caps: PLATFORM_CAPS });
});
