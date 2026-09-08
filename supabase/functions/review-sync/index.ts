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
//   sync_all    { limit? }           — a BATCH of the stalest venues (service-role; cron)
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

// sync_all bounds — one invocation must finish inside the edge function's wall
// clock however many venues exist, and must SAY whether it got through them all.
const SYNC_ALL_BATCH = 10;          // venues per invocation (override with `limit`)
const SYNC_ALL_BATCH_MAX = 50;
const VENUE_TIMEOUT_MS = 20_000;    // one venue's OAuth + fetch + upserts
const RUN_BUDGET_MS = 60_000;       // stop starting venues past this, report partial

/** Resolve to `{ error }` rather than hanging: one wedged venue must not eat the
 *  batch. syncLocation dedups on external_review_id, so abandoning it mid-way
 *  costs nothing — the next tick re-runs that venue from the top. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { error: string }> {
  let t: number | undefined;
  const timer = new Promise<{ error: string }>((res) => {
    t = setTimeout(() => res({ error: `timed out after ${ms}ms` }), ms);
  });
  return Promise.race([p, timer]).finally(() => { if (t !== undefined) clearTimeout(t); });
}

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
  // ATTEMPT stamp, written BEFORE any work — sync_all orders its queue by this.
  // Stamping the attempt rather than the success is what stops a venue that
  // always throws (or trips VENUE_TIMEOUT_MS, which abandons the promise and
  // loses everything after it) from keeping its old timestamp, sorting to the
  // front of every tick and starving every other venue forever.
  // last_synced_at below stays a SUCCESS stamp — do not conflate the two.
  // Needs: alter table review_platform_links add column last_attempt_at timestamptz;
  const { error: attemptErr } = await opsAdmin.from('review_platform_links')
    .update({ last_attempt_at: new Date().toISOString() })
    .eq('location_id', opsLocationId).eq('enabled', true);
  // Losing this write silently would put the starvation back, invisibly.
  if (attemptErr) console.error('[review-sync] attempt stamp failed', opsLocationId, attemptErr.message);

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

  // sync_all — cron only (service-role). Venues with a connected platform; one
  // location can have several links, so sync each venue once.
  //
  // BOUNDED. Every venue costs an OAuth token exchange plus a reviews fetch, so
  // the whole estate in one invocation dies at the wall clock the moment the
  // venue count grows — and a truncated run used to look exactly like a complete
  // one. A batch of the venues waiting LONGEST is processed per tick, ordered by
  // last_attempt_at, which syncLocation stamps up front whether or not the sync
  // then succeeds. That ordering IS the cursor — pg_cron carries no state, and
  // because it advances on ATTEMPT a broken venue rotates to the back like any
  // other, so it can't starve the estate.
  // `complete` + `processed`/`remaining` say how far it got.
  if (action === 'sync_all') {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    // !token matters: SERVICE_ROLE is '' when the env var is unset, so a bare
    // unauthenticated POST would otherwise compare equal and walk straight through.
    if (!token || token !== SERVICE_ROLE) return json({ error: 'service role required' }, 403);
    const limit = Math.max(1, Math.min(SYNC_ALL_BATCH_MAX, Math.trunc(Number(body?.limit)) || SYNC_ALL_BATCH));

    const { data: rows, error: rowsErr } = await opsAdmin.from('review_platform_links')
      .select('location_id, last_synced_at, last_attempt_at').eq('enabled', true);
    // Never swallow this. A failed queue read leaves rows null → empty queue →
    // `{ ok:true, complete:true, processed:0 }`, i.e. a run that synced nothing
    // reporting as a full pass — the exact false-complete `complete` exists to
    // rule out. Fail loudly so the cron surfaces it.
    if (rowsErr) return json({ error: `queue query failed: ${rowsErr.message}` }, 500);
    // One entry per venue, keyed on its OLDEST link attempt (a venue with a
    // never-attempted link is the stalest thing about it). Pre-backfill rows have
    // no last_attempt_at, so fall back to the old success stamp.
    const stalest = new Map<string, string>();
    for (const r of rows || []) {
      const at = r.last_attempt_at ?? r.last_synced_at ?? '';   // '' sorts before any ISO stamp
      const prev = stalest.get(r.location_id);
      if (prev === undefined || at < prev) stalest.set(r.location_id, at);
    }
    const queue = [...stalest.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([id]) => id);

    const deadline = Date.now() + RUN_BUDGET_MS;
    const out: Record<string, unknown> = {};
    let processed = 0;
    for (const id of queue.slice(0, limit)) {
      if (Date.now() > deadline) break;
      out[id] = await withTimeout(syncLocation(id), VENUE_TIMEOUT_MS)
        .catch((e) => ({ error: (e as Error).message }));
      processed++;
    }
    return json({
      ok: true,
      complete: processed >= queue.length,
      processed,
      total: queue.length,
      remaining: Math.max(0, queue.length - processed),
      locations: out,
    });
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
