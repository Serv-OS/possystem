-- 20260806_PLATFORM_location_rpcs.sql
--
-- ⚠ PLATFORM DB ONLY — project ref yhzjgyrkyjabvhblqxzu
--   (the guard below aborts if you run it against the Ops DB)
--
-- WHY THIS EXISTS
-- 20260805c Section B dropped `locations_anon_update` and revoked anon's UPDATE
-- grant on platform `locations`, so the Back Office no longer writes that table
-- from the browser — every write now goes through the service_role edge function
-- supabase/functions/location-admin/index.ts. Two of its three actions are RPC
-- calls into this database:
--     location-admin/index.ts:348   location_branding_merge(p_location_id, p_patch)
--     location-admin/index.ts:359   challenge21_reset(p_location_id)
-- Neither function exists here, so `patch_branding` and `reset_challenge21_counter`
-- return 500 on every call — Back Office → Appearance, the Review card logo, and
-- the Challenge 21 counter reset are all dead until this is applied.
--
-- WHY RPCS RATHER THAN TWO MORE UPDATE STATEMENTS IN THE EDGE FUNCTION
--   online_branding: Menu appearance (MenuAppearance.jsx:173) and the Review card
--   (review/ReviewCard.jsx:157) write DIFFERENT keys of the SAME jsonb column.
--   Any read-modify-write — in the browser or in the edge function — has a window
--   where the second saver writes the object it read before the first saved, and
--   the first screen's keys vanish with no error anywhere. `online_branding ||
--   p_patch` inside ONE statement is the only version with no window.
--   challenge21_reset: nothing to merge, but keeping it here means
--   challenge_21_counter stays on the edge function's DENIED column list and 0
--   remains the only value any caller can set it to. It is a licensing control:
--   set it high and the ID prompt fires early, low and it never fires at all.
--
-- SECURITY
--   Both are SECURITY DEFINER with a pinned search_path, and EXECUTE is revoked
--   from public, anon and authenticated — only service_role (i.e. the edge
--   function) may call them. The platform browser client reaches this database
--   as the `anon` role with no JWT at all (src/lib/supabase.js:20 sets
--   persistSession:false), so anything anon can execute is reachable by anyone
--   who copies the anon key out of the bundle. `from public` must be named
--   explicitly: a newly created function carries a default EXECUTE grant to
--   PUBLIC, and revoking from anon/authenticated alone leaves that intact — the
--   same trap 20260805c B2 documents on increment_gmv.
--
-- Every statement is idempotent and the file is re-runnable.

begin;

-- Wrong-database guard. Platform has billing_state and no user_locations; Ops is
-- the other way round (verified 5 Aug 2026, same test as 20260805c Section B).
do $guard$
begin
  if to_regclass('public.billing_state') is null
     or to_regclass('public.user_locations') is not null then
    raise exception
      'This migration must be run against the PLATFORM DB (yhzjgyrkyjabvhblqxzu). This is not it — aborting.';
  end if;
end
$guard$;

-- Precondition. A plpgsql body is NOT parsed when the function is created, so a
-- missing or wrongly-typed column would create cleanly here and fail only when a
-- Back Office user pressed Save. Fail at apply time instead.
do $precheck$
declare
  branding_type text;
begin
  if to_regclass('public.locations') is null then
    raise exception 'public.locations does not exist on this database — aborting.';
  end if;

  select data_type into branding_type
    from information_schema.columns
   where table_schema = 'public' and table_name = 'locations' and column_name = 'online_branding';

  if branding_type is null then
    raise exception 'locations.online_branding does not exist — aborting.';
  end if;
  -- The `||` merge operator exists for jsonb only; on a `json` column the RPC
  -- would fail at runtime with "operator does not exist".
  if branding_type <> 'jsonb' then
    raise exception 'locations.online_branding is "%", not jsonb — the merge below needs jsonb. Aborting.', branding_type;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'locations' and column_name = 'challenge_21_counter'
  ) then
    raise exception 'locations.challenge_21_counter does not exist — aborting.';
  end if;
end
$precheck$;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. location_branding_merge — MERGE, never replace
-- ──────────────────────────────────────────────────────────────────────────
-- Returns the merged value so the caller can put it straight back into state
-- without a second read (MenuAppearance.jsx:176 and ReviewCard.jsx:166 both do),
-- and NULL when p_location_id matched no row — that null is what makes the
-- caller's `if (!data) return json({ error: 'update matched 0 rows' }, 500)`
-- meaningful. A PostgREST UPDATE that matches nothing resolves happily with 0
-- rows, so without a returned value a no-op save looks identical to a real one.
--
-- The merge is TOP-LEVEL (jsonb `||` is shallow): a key present in p_patch
-- replaces that key wholesale, keys absent from p_patch are left alone. That is
-- what the two writers need — Menu appearance owns whole sub-objects
-- (`portal`, `gift`) and sends each of them complete, while the Review card
-- sends flat keys (review_logo_url, hero_image_url) it alone writes.
--
-- Dropped rather than CREATE OR REPLACEd so the file stays re-runnable if the
-- return type ever changes. Nothing depends on these functions but the edge fn.
drop function if exists public.location_branding_merge(uuid, jsonb);

create function public.location_branding_merge(p_location_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_merged jsonb;
begin
  -- The edge function already rejects a non-object patch, but once the write is
  -- remote that check is advisory. `'{}'::jsonb || '3'::jsonb` raises a bare
  -- "invalid concatenation of jsonb objects" that says nothing about where it
  -- came from.
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'p_patch must be a JSON object' using errcode = '22023';
  end if;

  update public.locations
     set online_branding = coalesce(online_branding, '{}'::jsonb) || p_patch
   where id = p_location_id
   returning online_branding into v_merged;

  return v_merged;
end
$fn$;

revoke all on function public.location_branding_merge(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.location_branding_merge(uuid, jsonb) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. challenge21_reset — counter to 0, and nothing else
-- ──────────────────────────────────────────────────────────────────────────
-- The Back Office "reset counter" button — Challenge21.jsx:166 → locationAdmin.js
-- → location-admin. The till's own reset after an ID check (Challenge21Modal.jsx:52)
-- goes through the separate challenge21-counter function and does not come here.
--
-- ⚠ RETURN SHAPE IS LOAD-BEARING: it must be a single jsonb OBJECT, not
--   `returns table(...)` or `returns setof`. PostgREST wraps a set-returning
--   function's result in an ARRAY, so `data.ok` on the caller
--   (location-admin/index.ts:361 tests `!data?.ok`) would be undefined and every
--   SUCCESSFUL reset would be reported to the operator as a 500.
--   NULL on 0 rows drives that same check the other way, correctly.
drop function if exists public.challenge21_reset(uuid);

create function public.challenge21_reset(p_location_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id uuid;
begin
  update public.locations
     set challenge_21_counter = 0
   where id = p_location_id
   returning id into v_id;

  if v_id is null then
    return null;
  end if;

  return jsonb_build_object('ok', true, 'location_id', v_id, 'challenge_21_counter', 0);
end
$fn$;

revoke all on function public.challenge21_reset(uuid) from public, anon, authenticated;
grant execute on function public.challenge21_reset(uuid) to service_role;

commit;


-- ── Post-apply verification (run separately) ──────────────────────────────
-- Both must be prosecdef = true, and proacl must show service_role only
-- (no "=X/" entry, which would mean PUBLIC can still execute):
--
--   select proname, prosecdef, proconfig, proacl
--     from pg_proc
--    where proname in ('location_branding_merge', 'challenge21_reset');
--
-- Merge must ADD a key, not replace the object (run on a throwaway row):
--
--   select public.location_branding_merge('<platform location id>'::uuid,
--                                         '{"review_logo_url":"x"}'::jsonb);
--   -- expect the venue's existing branding keys to still be present
--
-- Unknown id must return null, not raise:
--
--   select public.challenge21_reset('00000000-0000-0000-0000-000000000000'::uuid);
--
-- ── Smoke test ────────────────────────────────────────────────────────────
-- 1. Back Office → Appearance: change the brand colour, Save, reload — it sticks.
-- 2. Review Manager → Review card: upload a logo. Then re-save Appearance and
--    confirm the review logo is STILL there (this is the whole point of the merge).
-- 3. Back Office → Challenge 21: reset the counter — the screen must report
--    success, and the stored counter must read 0. (The till's own reset after an
--    ID check is the challenge21-counter function's job, not this migration's.)
