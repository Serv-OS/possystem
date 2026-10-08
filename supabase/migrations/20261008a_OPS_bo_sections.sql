-- 20261008a_OPS_bo_sections.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 1 column, 1 check, 1 small guard and 1 function to user_profiles.   #
-- #  No row is changed and nobody's access changes, so it is safe any time,   #
-- #  service included.                                                        #
-- ############################################################################
--
-- WHY (Peter, 8 Oct 2026: "from the back office when we can invite someone to the back office
-- we need to be able to limit what they can see via each tab. MO is a franchisee, we want him to
-- be able to login to the back office. But he cannot mess with menus, inventory, produce etc. We
-- only want to give him access to workforce, reports, team and customers, nothing else.")
--   Until today Back Office access was all or nothing (user_profiles.bo_access).
--
-- THIS IS A SCREEN LOCK, NOT A DATABASE LOCK.
--   The list decides which parts of Back Office a login is SHOWN. It does not change what the
--   database lets that login read or write: that is still the venue fence (user_locations), as
--   before. What this file does protect is the list itself, so a limited login cannot widen it.
--
-- WHAT THIS FILE DOES
--   user_profiles.bo_sections     text[], null by default. NULL = everything (every login that
--                                 exists today, and every new one). A list = ONLY those parts.
--                                 Checked: every entry is one of the 15 keys below.
--   Who can read it               a login reads its own row and its teammates' rows, as it
--                                 already can (the read rule on user_profiles is not touched).
--   Who can write it              nobody, straight from the browser. The column has NO update
--                                 grant for a signed in login, and a small guard on the table
--                                 (user_profiles_bo_sections_guard) refuses a change to it that
--                                 does not come from the function below, so the rule holds even
--                                 on a database where the grants differ. The service role
--                                 (the create-user function) and this editor are not checked.
--   public.set_bo_sections        the ONE way a person changes it. Allowed for an OWNER of the
--                                 same company, or ServOS staff. Refused for: nobody signed in,
--                                 an anonymous session, your own login, a login in another
--                                 company, an owner's or ServOS's login (they always open
--                                 everything), and any key that is not one of the 15.
--                                 Null clears the list (everything again).
--
-- THE 15 KEYS (the sidebar, top to bottom). The same list is in
-- supabase/functions/_shared/boSectionRules.js; src/lib/boSections.test.js fails if they differ.
--   overview, menu, floorplan, inventory, produce, purchasing, operations, team, workforce,
--   customers, channels, hardware, reports, card-payments, settings
--
-- OWNERS ALWAYS OPEN EVERYTHING
--   The app ignores the list for role 'owner' and 'super_admin', and the function will not set
--   one on them. So the person being limited MUST have role 'manager' on user_profiles. A login
--   made in Back Office, Team gets 'manager'. A login made in the admin portal, or one that
--   signed itself up, has 'owner': ServOS changes that role first (only ServOS can).
--
-- THE TWO EXISTING GUARDS ON user_profiles, AND WHY THE FUNCTION PASSES THEM
--   The function runs as its owner, but the guards look at the REQUEST (the API role in the
--   sign in token), so they still run for the owner who called it. Checked on 8 Oct 2026:
--   * user_profiles_fence_guard (20260921u): for a row that is not the caller's own it pins
--     org_id, location_id, full_name, email and role, and nothing else. The function changes
--     bo_sections only, and refuses the caller's own row before it writes, so the guard lets it
--     through with no bypass and is not changed here.
--   * user_profiles_role_guard (20260915c): only looks at role. Not changed.
--   * Row level security: user_profiles does not force it on its owner, so the function's own
--     update is not filtered by up_update_scoped. Not changed.
--
-- BEFORE AND AFTER IT RUNS
--   Before: the app works as today. Every login opens everything, and Back Office, Team says
--   limiting a login needs a database update.
--   After: refresh Back Office. Team shows "What can they open?" on each login for an owner.
--   Deploy the create-user function BEFORE limiting anybody: the old one makes every new login
--   open everything, whoever asked.
--
-- Rollback: 20261008a_OPS_bo_sections_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.user_profiles') is null then
    raise exception 'This is not the Ops database (device_profiles or user_profiles is missing). Nothing was changed.';
  end if;
  if to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.is_anon_session()') is null then
    raise exception 'The helpers is_super_admin and is_anon_session are missing. This is not the database this file was written for. Nothing was changed.';
  end if;
end
$guard$;

-- Fail fast on a busy table instead of making every sign in queue behind this script.
set local lock_timeout = '3s';

-- ── The column ──────────────────────────────────────────────────────────────
-- Null by default and no rewrite of the table: adding it is instant.
alter table public.user_profiles add column if not exists bo_sections text[];

comment on column public.user_profiles.bo_sections is
  'Which top level parts of Back Office this login is shown (8 Oct 2026). NULL = everything. A list = only those (keys: supabase/functions/_shared/boSectionRules.js). Ignored for role owner and super_admin. A screen lock, not a database lock. Written only by public.set_bo_sections() and by the create-user function.';

do $shape$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'user_profiles_bo_sections_known'
                    and conrelid = 'public.user_profiles'::regclass) then
    -- <@ is "every entry is in this list" (a null entry is in no list, so it is refused too).
    -- One flat list only, never more entries than there are keys.
    alter table public.user_profiles add constraint user_profiles_bo_sections_known
      check (bo_sections is null
        or (bo_sections <@ array['overview', 'menu', 'floorplan', 'inventory', 'produce', 'purchasing', 'operations', 'team', 'workforce', 'customers', 'channels', 'hardware', 'reports', 'card-payments', 'settings']::text[]
            and coalesce(array_ndims(bo_sections), 1) = 1
            and cardinality(bo_sections) <= 15));
  end if;
end
$shape$;

-- No update grant on the new column for a signed in login, said out loud. On production this
-- changes nothing (a new column gets no grant, and the table has column grants only); it is here
-- so the intent is written down.
revoke update (bo_sections) on table public.user_profiles from public, anon, authenticated;

-- ── The guard on the column ─────────────────────────────────────────────────
-- The second lock. The grant above is the first, but the fence guard pins five named columns
-- and lets any OTHER column of a teammate's row (or the caller's own) through, so if this table
-- ever got a table wide update grant, a manager could clear his own list with one request.
-- This says the rule itself: through the API, bo_sections changes only inside set_bo_sections().
-- Not checked: the service role (create-user), this editor, cron. Everything else on the row is
-- left to the guards that already own it; this one reads and changes nothing but bo_sections.
create or replace function public.user_profiles_bo_sections_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_api_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  -- Only requests made with a person's (or the public) key through the API are checked.
  if v_api_role not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.bo_sections is not null then
      raise exception 'A new login starts with everything. Limit it in Back Office, Team.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.bo_sections is distinct from old.bo_sections
     and coalesce(current_setting('servos.bo_sections_write', true), '') <> 'on' then
    raise exception 'What a login can open is changed by the owner, in Back Office, Team.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.user_profiles_bo_sections_guard() from public, anon, authenticated;

drop trigger if exists user_profiles_bo_sections_guard on public.user_profiles;
create trigger user_profiles_bo_sections_guard
  before insert or update on public.user_profiles
  for each row execute function public.user_profiles_bo_sections_guard();

-- ── The one way to change it ────────────────────────────────────────────────
-- Returns {"ok": true, "sections": null} or {"ok": true, "sections": ["team", ...]} (what is
-- stored now, in sidebar order, no repeats). Every refusal is an exception with a plain message
-- the Team screen shows as it is.
create or replace function public.set_bo_sections(p_user uuid, p_sections text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid       uuid := auth.uid();
  v_keys      constant text[] := array['overview', 'menu', 'floorplan', 'inventory', 'produce', 'purchasing', 'operations', 'team', 'workforce', 'customers', 'channels', 'hardware', 'reports', 'card-payments', 'settings'];
  v_super     boolean;
  v_me_role   text;
  v_me_org    uuid;
  v_role      text;
  v_org       uuid;
  v_clean     text[];
  v_bad       text;
  v_rows      integer;
begin
  -- Somebody real, signed in. A device or a visitor (anonymous session) is never an owner.
  if v_uid is null or public.is_anon_session() then
    raise exception 'Sign in to Back Office to change what a login can open.' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'Pick a login first.' using errcode = '22023';
  end if;
  -- Nobody changes their own, ServOS staff included.
  if p_user = v_uid then
    raise exception 'You cannot change what your own login can open.' using errcode = '42501';
  end if;

  v_super := public.is_super_admin();
  select p.role, p.org_id into v_me_role, v_me_org from public.user_profiles p where p.id = v_uid;
  if not v_super and (v_me_role is distinct from 'owner' or v_me_org is null) then
    raise exception 'Only the owner can change what a login can open.' using errcode = '42501';
  end if;

  -- The login being changed, held so two people saving at once cannot cross.
  select p.role, p.org_id into v_role, v_org from public.user_profiles p where p.id = p_user for update;
  -- One answer for "no such login" and "not your company", so nobody can probe for ids.
  if not found or (not v_super and v_org is distinct from v_me_org) then
    raise exception 'That login is not in your company.' using errcode = '42501';
  end if;
  if lower(coalesce(v_role, '')) in ('owner', 'super_admin') then
    raise exception 'An owner always opens everything. It cannot be limited.' using errcode = '42501';
  end if;

  -- Null = everything. A list is checked key by key, then kept in sidebar order with no repeats.
  if p_sections is null then
    v_clean := null;
  else
    if coalesce(array_ndims(p_sections), 1) <> 1 then
      raise exception 'The list of sections is not a plain list.' using errcode = '22023';
    end if;
    select s.k into v_bad from unnest(p_sections) as s(k) where s.k is null or s.k <> all (v_keys) limit 1;
    if found then
      raise exception 'Unknown part of Back Office: %', coalesce(v_bad, '(empty)') using errcode = '22023';
    end if;
    select coalesce(array_agg(k.key order by k.ord), '{}'::text[]) into v_clean
      from unnest(v_keys) with ordinality as k(key, ord)
     where k.key = any (p_sections);
  end if;

  -- The pass for the guard above, for this one statement, then shut again. It lasts for this
  -- request at most, and if the update fails the whole request is undone, the pass with it.
  perform set_config('servos.bo_sections_write', 'on', true);
  update public.user_profiles set bo_sections = v_clean where id = p_user;
  get diagnostics v_rows = row_count;
  perform set_config('servos.bo_sections_write', 'off', true);
  -- Never report a change that did not land (a rule on the table filtering this update away).
  if v_rows <> 1 then
    raise exception 'Not saved. Nothing was changed.' using errcode = '42501';
  end if;

  return jsonb_build_object('ok', true, 'sections', to_jsonb(v_clean));
end;
$fn$;

comment on function public.set_bo_sections(uuid, text[]) is
  'Sets which parts of Back Office a login is shown (8 Oct 2026). Owner of the same company or ServOS staff only; never your own login, never an owner''s. Null = everything. A screen lock, not a database lock. src/lib/boSections.js.';

-- A signed in login only. The function decides who among them.
revoke all on function public.set_bo_sections(uuid, text[]) from public, anon, service_role;
grant execute on function public.set_bo_sections(uuid, text[]) to authenticated;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): every answer is true, and
-- logins_limited is 0 the first time this runs (nobody is limited until an owner does it).
select
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'user_profiles'
             and column_name = 'bo_sections' and data_type = 'ARRAY' and is_nullable = 'YES') as column_added,
  exists (select 1 from pg_constraint
           where conname = 'user_profiles_bo_sections_known' and conrelid = 'public.user_profiles'::regclass) as check_added,
  not has_column_privilege('authenticated', 'public.user_profiles', 'bo_sections', 'UPDATE') as login_cannot_write_column,
  not has_column_privilege('anon', 'public.user_profiles', 'bo_sections', 'UPDATE') as public_key_cannot_write_column,
  exists (select 1 from pg_trigger
           where tgname = 'user_profiles_bo_sections_guard' and tgrelid = 'public.user_profiles'::regclass
             and not tgisinternal and tgenabled <> 'D') as guard_on,
  has_function_privilege('authenticated', 'public.set_bo_sections(uuid, text[])', 'EXECUTE') as login_can_call_function,
  not has_function_privilege('anon', 'public.set_bo_sections(uuid, text[])', 'EXECUTE') as public_key_cannot_call_function,
  (select p.prosecdef from pg_proc p where p.oid = 'public.set_bo_sections(uuid, text[])'::regprocedure) as function_runs_as_owner,
  (select count(*) from public.user_profiles where bo_sections is not null) as logins_limited;
