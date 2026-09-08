// supabase/functions/challenge21-counter/index.ts
//
// The TILL's Challenge 21 counter: +1 on an alcohol sale, back to 0 after an ID
// check. The only path by which a POS may move
// platform.locations.challenge_21_counter.
//
// WHY THIS EXISTS
//   Migration 20260805c section B dropped `locations_anon_update` (USING(true)
//   WITH CHECK(true)) and revoked anon's UPDATE grant on the platform
//   `locations` table. Two of the writes that policy carried were not Back
//   Office writes but LIVE TILL writes:
//     src/store/index.js       triggerChallenge21Check — +1 per alcohol check
//     src/components/Challenge21Modal.jsx             — reset after an ID check
//   Both failed SILENTLY once the policy went: an RLS-blocked PostgREST UPDATE
//   resolves with 0 rows rather than throwing, so the counter simply stopped
//   counting and the ID prompt stopped appearing at every venue, with nothing on
//   screen to say so. Challenge 21 is a LICENSING control — this path must fail
//   loudly or not at all.
//
// WHY NOT location-admin
//   A till holds no Back Office JWT. ensureAuthToken() signs the device in with
//   signInAnonymously(), so the bearer is a real auth.uid() carrying
//   is_anonymous:true — exactly what location-admin's authed() refuses, and
//   rightly so for a Back Office writer. The fence here is the DEVICE, not the
//   user.
//
// THE FENCE (in this order — do not reorder)
//   1. A bearer token is required and must resolve to an auth user.
//   2. That user's own paired device row is loaded via devices.device_uid.
//      claim_device() (migration 20260713c) stamps that column from the JWT and
//      nothing else ever writes it, so a session cannot forge a link to a venue
//      it never held the pairing code for.
//   3. THE OPS LOCATION COMES FROM THAT ROW. `ops_location_id` in the body is
//      diagnostic only — logged when it disagrees, never used to resolve. Were
//      the body allowed to name the venue, every holder of the bundled anon key
//      that the migration just evicted could bump or zero any venue's counter:
//      the same licensing failure by another route.
//   4. Only then is the ops id mapped to the platform row, SERVER-side.
//
// SCOPE
//   challenge_21_counter, and nothing else, is ever written. Two actions:
//     { action: 'bump'  } → { ok, counter, should_prompt }
//     { action: 'reset' } → { ok, counter: 0 }
//   THE PROMPT DECISION IS THE SERVER'S: should_prompt compares the new counter
//   against challenge_21_trigger_every read from the same row, so a till holding
//   a stale config cannot decide the prompt is never due.
//
//   No RPC dependency, deliberately — this is the licensing path, and it has to
//   keep working on a platform DB where a later migration has not been run.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// The till's own default for an unset threshold (store loadChallenge21Config),
// so the two never disagree about what "not configured" means.
const DEFAULT_TRIGGER_EVERY = 10;
const MAX_CAS_ATTEMPTS = 5;

/**
 * The caller's paired device row IS the location authority. Returns the ops
 * location id, or null when this session holds no device.
 *
 * `status <> 'removed'` mirrors claim_device() and PairingScreen: a device whose
 * pairing code Back Office has reissued goes back to 'unpaired' while the till
 * carries on trading, and refusing there would stop the licensing counter for a
 * venue that still owns the device. Only an explicitly removed device is out.
 *
 * A browser that has been re-paired keeps its auth session (rpos-auth survives
 * the tenant fence), so one uid can be stamped on more than one device row over
 * time. The most recently seen row is the live pairing — claim_device() touches
 * last_seen on every boot.
 */
async function opsLocationForCaller(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return null;
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return null;
  const { data } = await opsAdmin
    .from('devices')
    .select('id, location_id, status, last_seen')
    .eq('device_uid', user.id)
    .neq('status', 'removed')
    .not('location_id', 'is', null)
    .order('last_seen', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return data?.location_id ?? null;
}

// ops id → platform row. ops_location_id FIRST, id as the legacy fallback — the
// same order every Back Office screen and location-admin uses. Resolving
// differently would move a different tenant's counter. Sequential, not .or():
// with .or() a row whose id equals another row's ops_location_id makes
// maybeSingle() error or pick arbitrarily.
async function resolvePlatformLocation(opsLocationId: string) {
  let { data } = await platformAdmin.from('locations')
    .select('id').eq('ops_location_id', opsLocationId).maybeSingle();
  if (!data) {
    const fb = await platformAdmin.from('locations')
      .select('id').eq('id', opsLocationId).maybeSingle();
    data = fb.data;
  }
  return data;
}

/**
 * +1, without a lost update. PostgREST cannot express `counter = counter + 1`
 * and this function depends on no RPC, so the increment is a compare-and-swap:
 * the UPDATE only matches while the counter still holds the value that was read.
 * Two tills closing alcohol checks in the same instant therefore cannot both
 * write the same `next` — the loser matches 0 rows, re-reads and retries, which
 * is what the old read-modify-write on the till could not do.
 */
async function bumpCounter(platformLocationId: string) {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const { data: row, error } = await platformAdmin.from('locations')
      .select('challenge_21_counter, challenge_21_trigger_every, challenge_21_enabled')
      .eq('id', platformLocationId).maybeSingle();
    if (error) return { err: error.message };
    if (!row) return { err: 'location not found' };

    const prev = row.challenge_21_counter;
    let q = platformAdmin.from('locations')
      .update({ challenge_21_counter: (Number(prev) || 0) + 1 })
      .eq('id', platformLocationId);
    // PostgREST has no `= null`; a counter that has never been set needs `is`.
    q = (prev === null || prev === undefined)
      ? q.is('challenge_21_counter', null)
      : q.eq('challenge_21_counter', prev);

    const { data: upd, error: uErr } = await q
      .select('challenge_21_counter, challenge_21_trigger_every, challenge_21_enabled')
      .maybeSingle();
    if (uErr) return { err: uErr.message };
    if (upd) return { row: upd };
    // 0 rows — another till moved the counter between the read and the write.
  }
  return { err: 'counter is contended — try again' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const action = String(body?.action ?? '').trim();
  if (action !== 'bump' && action !== 'reset') return json({ error: `unknown action: ${action}` }, 400);

  const ops = await opsLocationForCaller(req);
  if (!ops) return json({ error: 'no paired device for this session' }, 403);

  // Diagnostic only. A disagreement means the till's cached config belongs to
  // another venue — worth seeing in the logs, never worth obeying.
  const claimed = String(body?.ops_location_id ?? '').trim();
  if (claimed && claimed !== ops) {
    console.warn(`[challenge21-counter] body ops_location_id ${claimed} != device location ${ops} — using the device`);
  }

  const loc = await resolvePlatformLocation(ops);
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);

  // ── bump ──────────────────────────────────────────────────────────────────
  if (action === 'bump') {
    const res = await bumpCounter(loc.id);
    if ('err' in res) return json({ error: res.err }, 500);

    const counter = Number(res.row.challenge_21_counter) || 0;
    const every = Number(res.row.challenge_21_trigger_every) || DEFAULT_TRIGGER_EVERY;
    // `>=`, not `===`: if a reset failed, the counter keeps climbing and every
    // following alcohol sale must keep prompting — which is exactly what the
    // modal warns staff will happen. Over-prompting is the right way for an
    // age-verification control to fail.
    // challenge_21_enabled is read, never written; it gates the prompt so a till
    // on a stale config cannot demand ID at a venue that has switched it off.
    const shouldPrompt = res.row.challenge_21_enabled === true && counter >= every;
    return json({ ok: true, counter, should_prompt: shouldPrompt });
  }

  // ── reset ─────────────────────────────────────────────────────────────────
  // Forced to 0; the caller cannot supply a value. .select() forces a round-trip
  // on the actual mutated row — a PostgREST UPDATE matching nothing resolves
  // with 0 rows rather than erroring, and a reset that silently did nothing is
  // how this control died the first time.
  const { data, error } = await platformAdmin.from('locations')
    .update({ challenge_21_counter: 0 }).eq('id', loc.id)
    .select('challenge_21_counter').maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: 'update matched 0 rows' }, 500);
  return json({ ok: true, counter: 0 });
});
