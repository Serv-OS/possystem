-- 20260919a_OPS_fence_1_safe_now.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  DATABASE FENCE, STAGE 1, FILE 1 OF 2 (Ops).                              #
-- #  Safe with the app that is live today (v5.9.8). Run it OUTSIDE SERVICE.   #
-- #  Peter pastes it into the Ops SQL editor and presses Run. Claude never    #
-- #  runs it. The runbook is docs/FENCE_STAGE_1.md.                           #
-- ############################################################################
--
-- WHY (18 Sep 2026 audit, read only):
--   * devices had "allow all". Anyone with the public anon key could add a devices
--     row bound to their own session at any venue, and pos_can_access() trusted it,
--     so an anonymous session became staff of any venue (41 policies on 29 tables).
--   * claim_device(code) rebound ANY paired till to the caller, and every pairing
--     code was readable through "allow all".
--   * organisations and locations had "allow all": the anon key could delete a
--     company, and the delete cascades to its venues, menus, staff and subscriptions.
--   * user_profiles "Allow authenticated access" let any login rewrite location_id or
--     org_id on ANY profile, and user_accessible_locations() trusted that column.
--   * ul_update_self let a login move its own venue link to any venue.
--   * anon and authenticated held TRUNCATE on 168 of 190 tables (TRUNCATE ignores RLS).
--
-- WHAT THIS FILE CHANGES (all of it works with the live app):
--   0. Guards: right project, 3 second lock wait.
--   1. Grants: TRUNCATE, REFERENCES, TRIGGER taken from anon and authenticated on
--      every table (and for future tables). The raw anon key (no login at all) loses
--      INSERT, UPDATE, DELETE on devices, organisations, locations, user_locations and
--      user_profiles.
--   2. Private support tables (no browser access at all): fence_attempts (throttles),
--      device_heal_codes, device_claim_log, payment_proofs, public_order_tokens,
--      print_agent_tokens.
--   3. Identity: venue access is user_locations only, plus every venue for a verified
--      super admin. user_profiles.location_id is only "the venue Back Office opens on".
--      Profiles are row scoped. A login can never move a venue link, change its own
--      company, or give itself Back Office access. A new venue can only be claimed by
--      the login that created it (created_by, written by the server).
--   4. organisations and locations: no more "allow all". Read rules unchanged for
--      venues (customer pages need them). Writes: the venue's own Back Office logins;
--      create: a real login inside a company it created; delete: super admin only.
--   5. devices: no more forged rows. Only Back Office adds, edits or removes a device.
--      A till may only touch its own heartbeat columns. pos_can_access() trusts a
--      devices row only when it was bound by a claim (bound_via is set). Pairing codes
--      last 60 minutes, are single use, are not readable once used, and wrong codes are
--      throttled (per session and platform wide). A till that is already paired can
--      never be taken by someone who read its old code: the live app's "re-link with
--      my saved code after my login changed" still works, but only when the till's
--      old login has been idle for 75 minutes AND the new login signed in from the
--      same venue network. Existing tills used in the last 14 days keep working
--      (grandfathered); the rest must be paired again (listed at the end).
--   6. New server functions the app release will call (they change nothing until
--      called): claim_device_v2, reclaim_device, device_issue_secret, issue_pairing_code,
--      device_heartbeat, device_status, place_public_order, settle_qr_tab,
--      order_track_row, order_track_check, qr_table_open_tabs, qr_tab_rounds,
--      qr_tab_join, qr_table_tab_count, catering_day_load, print agent functions.
--   7. closed_checks now accepts source 'qr' (QR paid checks were silently refused).
--
-- WHAT IT DOES NOT CHANGE YET (file 2, 20260919b, after the app release):
--   order_queue, kds_tickets, active_sessions, table_reservations keep "allow all";
--   print_jobs keeps its open policies; closed_checks keeps its open insert; the
--   devices table stays readable. Closing those before the app handles a till that
--   briefly loses its link would lose kitchen tickets and tables.
--
-- RULES OF THE FILE: no begin or commit (the SQL editor runs the whole paste as one
-- transaction, so any error means NOTHING changed and you can simply run it again);
-- every statement can run twice; functions are SECURITY DEFINER with search_path
-- pinned and EXECUTE only for the roles that need it; verification at the bottom;
-- roll back block in the comments at the very end.


-- ============================================================================
-- 0. Guards
-- ============================================================================
set lock_timeout = '3s';

do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.devices') is null
     or to_regclass('public.order_queue') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS project (tbetcegmszzotrwdtqhi). This is not it. Nothing was changed.';
  end if;
  if to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.is_anon_session()') is null
     or to_regprocedure('public.pos_can_access(text)') is null then
    raise exception 'is_super_admin(), is_anon_session() or pos_can_access() is missing. This is not the database the fence was written for. Nothing was changed.';
  end if;
end
$guard$;


-- ============================================================================
-- 1. Grants
-- ============================================================================
-- TRUNCATE ignores RLS entirely; REFERENCES and TRIGGER are DDL rights no browser
-- needs. Nothing in the app uses any of the three. service_role keeps everything.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;

-- The raw anon key (no session at all) never writes these five. Every real writer
-- has a session: Back Office logins, paired tills (anonymous session), the admin
-- portal (super admin session). Checkout and print agent tables are left for file 2.
revoke insert, update, delete on table public.devices, public.organisations, public.locations,
  public.user_locations, public.user_profiles from anon;


-- ============================================================================
-- 2. Private support tables (service role and definer functions only)
-- ============================================================================

-- Throttle buckets: wrong pairing codes, wrong tracking keys, wrong table codes,
-- public order spam. One row per bucket.
create table if not exists public.fence_attempts (
  bucket            text primary key,
  window_started_at timestamptz not null default now(),
  misses            integer not null default 0,
  locked_until      timestamptz,
  updated_at        timestamptz not null default now()
);

-- The pairing code a till used, kept only as a salted hash so the live app can
-- re-link a till whose login changed (it re-sends the code it saved). Deleted by
-- file 2, which switches every till to a device secret.
create table if not exists public.device_heal_codes (
  device_id            uuid primary key references public.devices(id) on delete cascade,
  code_hash            text not null,
  salt                 text not null,
  created_at           timestamptz not null default now(),
  heal_count           integer not null default 0,
  heal_window_start    timestamptz,
  last_heal_at         timestamptz
);

-- Every bind, re-link, refusal and fence action on a device, for review.
create table if not exists public.device_claim_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  device_id   uuid,
  location_id uuid,
  event       text not null,
  old_uid     uuid,
  new_uid     uuid,
  detail      text
);

-- Proof that money was really taken, written ONLY by the payment-proof edge function
-- (service role) after it asked the card processor, or the gift or loyalty ledger.
-- place_public_order and settle_qr_tab trust nothing else.
create table if not exists public.payment_proofs (
  id            uuid primary key default gen_random_uuid(),
  processor     text not null,
  payment_ref   text not null,
  kind          text not null check (kind in ('card', 'preauth', 'capture', 'gift', 'loyalty')),
  location_id   text not null,
  amount_minor  bigint not null check (amount_minor >= 0),
  currency      text,
  verified_at   timestamptz not null default now(),
  verified_by   text,
  used_by_ref   text,
  used_at       timestamptz,
  meta          jsonb,
  unique (processor, payment_ref, kind)
);
create index if not exists payment_proofs_location_idx on public.payment_proofs (location_id, verified_at desc);

-- One tracking token per public order (the customer's key to the order tracker).
create table if not exists public.public_order_tokens (
  location_id text not null,
  ref         text not null,
  token       text not null,
  placed_by   uuid,
  paid        boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (location_id, ref)
);

-- Print agent keys, one per agent install, issued from Back Office. Stored hashed.
create table if not exists public.print_agent_tokens (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations(id) on delete cascade,
  label        text,
  token_hash   text not null unique,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

do $private$
declare
  t text;
begin
  foreach t in array array['fence_attempts', 'device_heal_codes', 'device_claim_log', 'payment_proofs',
                           'public_order_tokens', 'print_agent_tokens'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end
$private$;


-- ============================================================================
-- 3. Small internal helpers (callable only by other definer functions)
-- ============================================================================

-- The role PostgREST put on this request: 'anon', 'authenticated', 'service_role',
-- or '' when there is no API request (this editor, cron, a migration).
create or replace function public._fence_api_role()
returns text
language sql
stable
set search_path = pg_catalog
as $fn$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
$fn$;

-- True inside a definer function of this fence that is allowed to write guarded
-- columns (the claim functions set it for their own transaction only).
create or replace function public._fence_bypass()
returns boolean
language sql
stable
set search_path = pg_catalog
as $fn$
  select coalesce(current_setting('servos.fence_bypass', true), '') = 'on';
$fn$;

-- Codes are compared without spaces or dashes, in capitals.
create or replace function public._fence_norm_code(p text)
returns text
language sql
immutable
set search_path = pg_catalog
as $fn$
  select regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g');
$fn$;

-- Numbers from customer supplied JSON: anything that is not a plain number is 0,
-- so a bad value can never raise after a card was charged (gaps G10 and G11).
create or replace function public._fence_num(p text)
returns numeric
language sql
immutable
set search_path = pg_catalog
as $fn$
  select case when p ~ '^\s*-?[0-9]{1,12}(\.[0-9]{1,6})?\s*$' then trim(p)::numeric else 0 end;
$fn$;

create or replace function public._fence_bool(p text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $fn$
  select lower(coalesce(trim(p), '')) in ('true', 't', '1', 'yes', 'y', 'on');
$fn$;

create or replace function public._fence_is_uuid(p text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $fn$
  select coalesce(p, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$fn$;

-- Random code from an alphabet with no 0 O 1 I. Bytes come from gen_random_uuid()
-- (core Postgres, no extension). 256 is a multiple of 32, so byte mod 32 is even.
create or replace function public._fence_random_code(p_len integer)
returns text
language plpgsql
volatile
set search_path = pg_catalog
as $fn$
declare
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_out   text := '';
  i       integer;
begin
  for i in 0 .. least(greatest(p_len, 1), 32) - 1 loop
    v_out := v_out || substr(v_alpha, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_out;
end;
$fn$;

-- Random digits (the QR table code customers read out to each other).
create or replace function public._fence_random_digits(p_len integer)
returns text
language plpgsql
volatile
set search_path = pg_catalog
as $fn$
declare
  v_bytes bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_out   text := '';
  i       integer;
begin
  for i in 0 .. least(greatest(p_len, 1), 32) - 1 loop
    v_out := v_out || (get_byte(v_bytes, i) % 10)::text;
  end loop;
  return v_out;
end;
$fn$;

-- Throttle: is this bucket locked right now?
create or replace function public._fence_is_locked(p_bucket text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from public.fence_attempts a where a.bucket = p_bucket and a.locked_until > now());
$fn$;

-- Throttle: count one event; when p_max is reached inside p_window the bucket locks
-- for p_lock. Also clears a few stale buckets so the table never grows without end.
create or replace function public._fence_count(p_bucket text, p_max integer, p_window interval, p_lock interval)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.fence_attempts as a (bucket, window_started_at, misses, updated_at)
  values (p_bucket, now(), 1, now())
  on conflict (bucket) do update
     set misses            = case when a.window_started_at < now() - p_window then 1 else a.misses + 1 end,
         window_started_at = case when a.window_started_at < now() - p_window then now() else a.window_started_at end,
         updated_at        = now();
  update public.fence_attempts
     set locked_until = now() + p_lock, misses = 0, window_started_at = now()
   where bucket = p_bucket and misses >= p_max;
  delete from public.fence_attempts
   where ctid in (select ctid from public.fence_attempts
                   where updated_at < now() - interval '2 days'
                     and (locked_until is null or locked_until < now())
                   limit 20);
end;
$fn$;

create or replace function public._fence_clear(p_bucket text)
returns void
language sql
security definer
set search_path = public
as $fn$
  delete from public.fence_attempts where bucket = p_bucket;
$fn$;

do $revoke_internal$
declare
  f text;
begin
  foreach f in array array[
    'public._fence_api_role()', 'public._fence_bypass()', 'public._fence_norm_code(text)',
    'public._fence_num(text)', 'public._fence_bool(text)', 'public._fence_is_uuid(text)',
    'public._fence_random_code(integer)', 'public._fence_random_digits(integer)', 'public._fence_is_locked(text)',
    'public._fence_count(text, integer, interval, interval)', 'public._fence_clear(text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$revoke_internal$;


-- ============================================================================
-- 4. Identity: who may act for which venue
-- ============================================================================

-- 4a. Server written creator columns. A new company or venue remembers the login that
-- made it; the guard triggers below write it, a browser can never choose it. Existing
-- rows stay NULL (only the admin portal links logins to them, as today).
alter table public.organisations add column if not exists created_by uuid;
alter table public.organisations alter column created_by set default auth.uid();
alter table public.locations add column if not exists created_by uuid;
alter table public.locations alter column created_by set default auth.uid();

-- 4b. Tripwire before access changes. user_accessible_locations() stops trusting
-- user_profiles.location_id below, so a login whose ONLY way into a venue is its
-- profile venue would lose that venue. On 18 Sep there were none (13 real logins,
-- every profile venue also a venue link, apart from the super admin). If that is no
-- longer true the file stops here and changes nothing: send Claude the message, or,
-- for each person you KNOW works at that venue, paste their id into v_keep and run
-- again (they get a proper venue link).
do $identity_tripwire$
declare
  v_keep uuid[] := array[]::uuid[];   -- PETER: normally leave this empty
  v_n    integer;
  v_list text;
begin
  insert into public.user_locations (user_id, location_id, role)
  select p.id, p.location_id,
         case when p.role in ('owner', 'manager', 'staff', 'viewer') then p.role else 'manager' end
    from public.user_profiles p
   where p.id = any(v_keep) and p.location_id is not null
  on conflict (user_id, location_id) do nothing;

  select count(*),
         string_agg(format('%s (id %s) venue "%s"', coalesce(p.email, 'no email'), p.id, coalesce(l.name, '?')), '; ')
    into v_n, v_list
    from public.user_profiles p
    join auth.users u on u.id = p.id
    left join public.locations l on l.id = p.location_id
   where p.location_id is not null
     and not coalesce(u.is_anonymous, false)
     and coalesce(p.role, '') <> 'super_admin'
     and not exists (select 1 from public.user_locations ul where ul.user_id = p.id and ul.location_id = p.location_id);
  if v_n > 0 then
    raise exception 'STOPPED, NOTHING WAS CHANGED. % login(s) reach a venue only through their profile venue: %. Check each is a real member of that venue. Paste the ids you recognise into v_keep in step 4b and run the file again, or ask Claude.', v_n, v_list;
  end if;
end
$identity_tripwire$;

-- 4c. Venue access = user_locations, plus every venue for a verified super admin.
-- SECURITY DEFINER with a pinned search_path, so it never recurses into the RLS of
-- user_locations or locations (gap G21: one definition). Same signature, replaced in
-- place: 168 policies and pos_can_access, ops_can_write, waitlist_can_write use it.
create or replace function public.user_accessible_locations()
returns setof text
language sql
stable
security definer
set search_path = public
as $fn$
  select ul.location_id::text
    from public.user_locations ul
   where ul.user_id = auth.uid()
     and not public.is_anon_session()
  union
  select l.id::text
    from public.locations l
   where public.is_super_admin();
$fn$;

comment on function public.user_accessible_locations() is
  '20260919a fence: user_locations, plus every venue for a verified super admin. user_profiles.location_id is only the venue Back Office opens on, never access.';

create or replace function public.user_accessible_orgs()
returns setof text
language sql
stable
security definer
set search_path = public
as $fn$
  select distinct l.org_id::text
    from public.locations l
   where l.org_id is not null
     and l.id::text in (select public.user_accessible_locations());
$fn$;

revoke all on function public.user_accessible_locations() from public;
revoke all on function public.user_accessible_orgs() from public;
grant execute on function public.user_accessible_locations() to anon, authenticated, service_role;
grant execute on function public.user_accessible_orgs() to anon, authenticated, service_role;

-- 4d. Teammates: logins linked to, or staff at, a venue the caller can manage in
-- Back Office. Used so the Staff screen can still show a teammate's email and switch
-- their Back Office access.
create or replace function public.bo_teammate_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select ul.user_id
    from public.user_locations ul
   where ul.location_id::text in (select public.user_accessible_locations())
  union
  select sm.auth_user_id::uuid
    from public.staff_members sm
   where public._fence_is_uuid(sm.auth_user_id)
     and sm.location_id::text in (select public.user_accessible_locations());
$fn$;

-- Logins whose Back Office access the caller may switch: teammates at a venue where
-- the caller is owner, or where the caller is manager and the teammate is not an owner.
create or replace function public.bo_manageable_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select other.user_id
    from public.user_locations me
    join public.user_locations other on other.location_id = me.location_id
   where me.user_id = auth.uid()
     and not public.is_anon_session()
     and (me.role = 'owner' or (me.role = 'manager' and other.role <> 'owner'))
  union
  select sm.auth_user_id::uuid
    from public.user_locations me
    join public.staff_members sm on sm.location_id = me.location_id
   where me.user_id = auth.uid()
     and not public.is_anon_session()
     and me.role in ('owner', 'manager')
     and public._fence_is_uuid(sm.auth_user_id);
$fn$;

revoke all on function public.bo_teammate_ids() from public;
revoke all on function public.bo_manageable_ids() from public;
grant execute on function public.bo_teammate_ids() to anon, authenticated, service_role;
grant execute on function public.bo_manageable_ids() to anon, authenticated, service_role;

-- 4e. A venue can be self claimed only by the login that created it (created_by is
-- server written), and only while nobody else is linked. It no longer trusts
-- user_profiles.org_id, which any login could set (gap G19).
create or replace function public.can_claim_location(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select auth.uid() is not null
     and not public.is_anon_session()
     and not exists (select 1 from public.user_locations ul
                      where ul.location_id = p_location_id and ul.user_id is distinct from auth.uid())
     and exists (select 1 from public.locations l
                  where l.id = p_location_id and l.created_by = auth.uid());
$fn$;
revoke all on function public.can_claim_location(uuid) from public, anon;
grant execute on function public.can_claim_location(uuid) to authenticated, service_role;

create or replace function public._org_created_by_me(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select auth.uid() is not null
     and not public.is_anon_session()
     and exists (select 1 from public.organisations o where o.id = p_org and o.created_by = auth.uid());
$fn$;
revoke all on function public._org_created_by_me(uuid) from public;
grant execute on function public._org_created_by_me(uuid) to anon, authenticated, service_role;

-- 4f. user_profiles: a login reads its own row, its teammates, or (super admin) all;
-- it updates its own row, or a teammate's Back Office access when it manages them.
-- The guard trigger decides WHICH columns.
drop policy if exists up_select_scoped on public.user_profiles;
create policy up_select_scoped on public.user_profiles
  as permissive for select to public
  using (id = (select auth.uid()) or (select public.is_super_admin()) or id in (select public.bo_teammate_ids()));

drop policy if exists up_update_scoped on public.user_profiles;
create policy up_update_scoped on public.user_profiles
  as permissive for update to public
  using (id = (select auth.uid()) or (select public.is_super_admin()) or id in (select public.bo_manageable_ids()))
  with check (id = (select auth.uid()) or (select public.is_super_admin()) or id in (select public.bo_manageable_ids()));

drop policy if exists up_insert_super_admin on public.user_profiles;
create policy up_insert_super_admin on public.user_profiles
  as permissive for insert to public
  with check ((select public.is_super_admin()));

drop policy if exists up_delete_super_admin on public.user_profiles;
create policy up_delete_super_admin on public.user_profiles
  as permissive for delete to public
  using ((select public.is_super_admin()));

drop policy if exists "Allow authenticated access" on public.user_profiles;
drop policy if exists "allow all" on public.user_profiles;

create or replace function public.user_profiles_fence_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if public._fence_api_role() not in ('authenticated', 'anon') or public._fence_bypass() then
    return new;
  end if;
  if public.is_super_admin() then
    return new;
  end if;
  if new.id is distinct from old.id then
    raise exception 'A profile id cannot change' using errcode = '42501';
  end if;
  if v_uid is null or old.id <> v_uid then
    -- A manager switching a teammate's Back Office access: that column only.
    if new.org_id is distinct from old.org_id or new.location_id is distinct from old.location_id
       or new.full_name is distinct from old.full_name or new.email is distinct from old.email
       or new.role is distinct from old.role then
      raise exception 'You can only switch Back Office access for a team member' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Own row.
  if new.bo_access is distinct from old.bo_access then
    raise exception 'Back Office access is switched by the venue owner or a manager' using errcode = '42501';
  end if;
  if new.email is distinct from old.email then
    raise exception 'Your email is changed through your login, not here' using errcode = '42501';
  end if;
  if new.org_id is distinct from old.org_id then
    if old.org_id is not null or new.org_id is null
       or not (public._org_created_by_me(new.org_id) or new.org_id::text in (select public.user_accessible_orgs())) then
      raise exception 'Only the platform can change which company a login belongs to' using errcode = '42501';
    end if;
  end if;
  if new.location_id is distinct from old.location_id and new.location_id is not null then
    if not exists (select 1 from public.user_locations ul where ul.user_id = v_uid and ul.location_id = new.location_id)
       and not exists (select 1 from public.locations l where l.id = new.location_id and l.created_by = v_uid) then
      raise exception 'You can only switch to a venue you are linked to' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;
revoke all on function public.user_profiles_fence_guard() from public, anon, authenticated;

drop trigger if exists user_profiles_fence_guard on public.user_profiles;
create trigger user_profiles_fence_guard
  before update on public.user_profiles
  for each row execute function public.user_profiles_fence_guard();

-- 4g. user_locations: the self move is gone (gap G19, blocker 4). A link can never be
-- moved to another venue or login from the browser; the admin portal (super admin)
-- still can. Leaving a venue (ul_delete_self) and the creator's self claim stay.
drop policy if exists ul_update_self on public.user_locations;

create or replace function public.user_locations_fence_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if public._fence_api_role() not in ('authenticated', 'anon') or public._fence_bypass() then
    return new;
  end if;
  if public.is_super_admin() then
    return new;
  end if;
  if new.location_id is distinct from old.location_id or new.user_id is distinct from old.user_id then
    raise exception 'A venue link cannot be moved. Ask the venue owner to add you.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.user_locations_fence_guard() from public, anon, authenticated;

drop trigger if exists user_locations_fence_guard on public.user_locations;
create trigger user_locations_fence_guard
  before update on public.user_locations
  for each row execute function public.user_locations_fence_guard();


-- ============================================================================
-- 5. organisations and locations (anon could delete a company and every venue)
-- ============================================================================

-- 5a. organisations. No customer page or till reads it. Back Office reads its own
-- company; the admin portal (super admin) reads and writes all of them.
alter table public.organisations enable row level security;

drop policy if exists organisations_select on public.organisations;
create policy organisations_select on public.organisations
  for select
  using ((select public.is_super_admin())
         or id::text in (select public.user_accessible_orgs())
         or (created_by = (select auth.uid()) and not (select public.is_anon_session())));

drop policy if exists organisations_insert on public.organisations;
create policy organisations_insert on public.organisations
  for insert
  with check ((select auth.uid()) is not null and not (select public.is_anon_session()));

drop policy if exists organisations_update on public.organisations;
create policy organisations_update on public.organisations
  for update
  using ((select public.is_super_admin()) or (created_by = (select auth.uid()) and not (select public.is_anon_session())))
  with check ((select public.is_super_admin()) or (created_by = (select auth.uid()) and not (select public.is_anon_session())));

drop policy if exists organisations_delete on public.organisations;
create policy organisations_delete on public.organisations
  for delete
  using ((select public.is_super_admin()));

drop policy if exists "allow all" on public.organisations;
drop policy if exists "Allow authenticated access" on public.organisations;

create or replace function public.organisations_fence_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if public._fence_api_role() not in ('authenticated', 'anon') or public._fence_bypass() then
    return new;
  end if;
  if public.is_super_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.id := gen_random_uuid();
    new.created_by := auth.uid();
    new.status := 'active';
    return new;
  end if;
  if new.id is distinct from old.id or new.created_by is distinct from old.created_by
     or new.status is distinct from old.status then
    raise exception 'Only the platform can change a company''s id, owner or status' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.organisations_fence_guard() from public, anon, authenticated;

drop trigger if exists organisations_fence_guard on public.organisations;
create trigger organisations_fence_guard
  before insert or update on public.organisations
  for each row execute function public.organisations_fence_guard();

-- 5b. locations (Ops). Reads stay open: kiosk, online, QR, catering, the bookings
-- widget and the pairing screen read branding, tax profile, timezone and org_id with
-- no login, and the row holds no secrets. This policy must never call
-- user_accessible_locations() (that function reads this table).
-- Writes (audited 18 Sep): only Back Office screens write Ops locations; no till,
-- kiosk or customer page does (gap B5: no device write arm).
alter table public.locations enable row level security;

drop policy if exists locations_read on public.locations;
create policy locations_read on public.locations
  for select
  using (true);

drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations
  for update
  using      (not (select public.is_anon_session()) and id::text in (select public.user_accessible_locations()))
  with check (not (select public.is_anon_session()) and id::text in (select public.user_accessible_locations()));

drop policy if exists locations_insert on public.locations;
create policy locations_insert on public.locations
  for insert
  with check ((select public.is_super_admin())
              or (org_id is not null and public._org_created_by_me(org_id)));

drop policy if exists locations_delete on public.locations;
create policy locations_delete on public.locations
  for delete
  using ((select public.is_super_admin()));

drop policy if exists "allow all" on public.locations;
drop policy if exists "Allow authenticated access" on public.locations;
drop policy if exists "Users can update own location settings" on public.locations;
drop policy if exists locations_select on public.locations;

create or replace function public.locations_fence_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if public._fence_api_role() not in ('authenticated', 'anon') or public._fence_bypass() then
    return new;
  end if;
  if public.is_super_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- A server id, so nobody can create an Ops venue whose id copies another
    -- company's Platform location id (the drifted venues).
    new.id := gen_random_uuid();
    new.created_by := auth.uid();
    return new;
  end if;
  if new.id is distinct from old.id or new.org_id is distinct from old.org_id
     or new.created_by is distinct from old.created_by or new.venue_code is distinct from old.venue_code then
    raise exception 'Only the platform can change a venue''s id, company or code' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.locations_fence_guard() from public, anon, authenticated;

drop trigger if exists locations_fence_guard on public.locations;
create trigger locations_fence_guard
  before insert or update on public.locations
  for each row execute function public.locations_fence_guard();


-- ============================================================================
-- 6. devices: the root of trust
-- ============================================================================

-- 6a. Columns.
alter table public.devices add column if not exists pairing_expires_at timestamptz;
alter table public.devices add column if not exists bound_via          text;
alter table public.devices add column if not exists bound_at           timestamptz;
alter table public.devices add column if not exists device_secret_hash text;
alter table public.devices add column if not exists secret_issued_at   timestamptz;
alter table public.devices add column if not exists client_caps        text[];
alter table public.devices add column if not exists last_heartbeat_at  timestamptz;

comment on column public.devices.bound_via is
  '20260919a fence: how device_uid was bound: code (Back Office pairing code), heal (the live app re-sent its saved code after its login changed), secret (device secret), grandfathered (bound before the fence and used in the last 14 days). NULL = not trusted. Only the claim functions write it.';
comment on column public.devices.pairing_expires_at is '20260919a fence: a pairing code works until this time (60 minutes after Back Office issued it). NULL = no live code.';
comment on column public.devices.client_caps is '20260919a fence: what the running app on this device can do (reported by device_heartbeat). File 2 waits until every active device reports fence_v1.';

-- 6b. Existing devices: who keeps working (runs before the trust test changes).
-- GRANDFATHERED (keeps its link, nothing to do on the floor) when ALL of these hold:
--   * it has a venue, is active or online, and is this till's most recent row
--     (one physical till, one link);
--   * it was seen in the last 14 days (its own last_seen, or a device_heartbeats row);
--   * it is bound to an anonymous device session, OR to a Back Office login that is
--     itself linked to that venue, OR to the super admin. A login bound as a till at a
--     venue it is NOT linked to would give that login a venue it has no link for, so
--     that row must be paired again with a fresh code.
-- Everything else loses its link and is marked 'removed', which is the one status the
-- live app acts on: that till shows the pairing screen on its next boot (loud, never a
-- till that half works). Back Office "Regenerate" brings it back with a fresh code.
-- On 18 Sep: 11 kept, 9 lose their link (7 not seen for 14 days or more, and 2 tills
-- signed in with a Back Office login that is not linked to that venue), plus 3 rows
-- marked active that no till ever claimed (not seen for 30 days): 12 to pair again.
-- Codes of kept tills leave the table and are kept only as a salted hash (see 6f).
-- Runs once per row: rows already handled (bound_via set) are skipped on a re-run.
do $grandfather$
declare
  r        record;
  v_salt   text;
  v_keep   boolean;
  v_reason text;
begin
  perform set_config('servos.fence_bypass', 'on', true);
  for r in
    with facts as (
      select d.*,
             greatest(d.last_seen,
                      (select max(h.last_seen) from public.device_heartbeats h where h.device_id = d.id::text)) as seen_at,
             coalesce((select u.is_anonymous from auth.users u where u.id = d.device_uid), false) as uid_is_anon,
             exists (select 1 from public.user_locations ul
                      where ul.user_id = d.device_uid and ul.location_id = d.location_id) as uid_linked_here,
             exists (select 1 from public.user_profiles p
                      where p.id = d.device_uid and p.role = 'super_admin') as uid_is_super
        from public.devices d
       where d.device_uid is not null
         and d.bound_via is null
    ), judged as (
      select f.*,
             (f.location_id is not null
              and f.status in ('active', 'online')
              and f.seen_at > now() - interval '14 days'
              and (f.uid_is_anon or f.uid_linked_here or f.uid_is_super)) as eligible
        from facts f
    )
    select j.*,
           row_number() over (partition by j.device_uid
                              order by j.eligible desc, j.seen_at desc nulls last, j.paired_at desc nulls last, j.created_at desc) as rn
      from judged j
  loop
    v_keep := r.eligible and r.rn = 1;
    if v_keep then
      update public.devices
         set bound_via = 'grandfathered',
             bound_at = coalesce(r.paired_at, r.created_at, now()),
             pairing_code = null,
             pairing_expires_at = null
       where id = r.id;
      if r.pairing_code is not null then
        v_salt := replace(gen_random_uuid()::text, '-', '');
        insert into public.device_heal_codes (device_id, code_hash, salt)
        values (r.id, encode(sha256(convert_to(v_salt || ':' || public._fence_norm_code(r.pairing_code), 'UTF8')), 'hex'), v_salt)
        on conflict (device_id) do nothing;
      end if;
      insert into public.device_claim_log (device_id, location_id, event, new_uid, detail)
      values (r.id, r.location_id, 'grandfathered', r.device_uid, 'kept by the 20260919a fence');
    else
      v_reason := case
        when r.location_id is null then 'no venue'
        when r.status not in ('active', 'online') then 'status ' || coalesce(r.status, 'null')
        when r.seen_at is null or r.seen_at <= now() - interval '14 days' then 'not seen for 14 days'
        when not (r.uid_is_anon or r.uid_linked_here or r.uid_is_super) then 'signed in with a Back Office login that is not linked to this venue'
        else 'the same till is paired to a newer device row' end;
      update public.devices
         set device_uid = null, bound_via = null, bound_at = null,
             device_secret_hash = null, secret_issued_at = null,
             status = 'removed',
             pairing_code = null, pairing_expires_at = null, session_token = null
       where id = r.id;
      insert into public.device_claim_log (device_id, location_id, event, old_uid, detail)
      values (r.id, r.location_id, 'unbound_by_fence', r.device_uid, v_reason);
    end if;
  end loop;

  -- Rows marked active or online that no till ever claimed (no link to keep): the
  -- same, so a till still using one is told to pair.
  for r in select id, location_id from public.devices where device_uid is null and status in ('active', 'online') loop
    update public.devices
       set status = 'removed', pairing_code = null, pairing_expires_at = null
     where id = r.id;
    insert into public.device_claim_log (device_id, location_id, event, detail)
    values (r.id, r.location_id, 'unbound_by_fence', 'marked active but never claimed by a till');
  end loop;

  -- Old browser codes that were never used (no expiry means issued before the fence):
  -- retired. Back Office issues a fresh one when that device is set up.
  update public.devices
     set pairing_code = null
   where device_uid is null and pairing_code is not null and pairing_expires_at is null;

  perform set_config('servos.fence_bypass', 'off', true);
end
$grandfather$;

-- One physical till, one link.
create unique index if not exists devices_one_link_per_session
  on public.devices (device_uid)
  where device_uid is not null;

-- 6c. The trigger that guards devices for API callers and runs the pairing lifecycle.
create or replace function public.devices_fence_tg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_api     boolean := public._fence_api_role() in ('authenticated', 'anon');
  v_admin   boolean := false;
  v_bo      boolean := false;
  v_self    boolean := false;
begin
  -- The claim functions set everything themselves.
  if public._fence_bypass() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    return old;   -- who may delete is the policy's job; heal codes go by foreign key
  end if;

  if v_api then
    v_admin := public.is_super_admin();
    if tg_op = 'INSERT' then
      if public.is_anon_session() then
        raise exception 'Only Back Office can add a device' using errcode = '42501';
      end if;
      new.device_uid := null;
      new.bound_via := null;
      new.bound_at := null;
      new.device_secret_hash := null;
      new.secret_issued_at := null;
      new.client_caps := null;
      new.last_heartbeat_at := null;
      if new.status is null or new.status in ('active', 'online') then
        new.status := case when new.type = 'kiosk' then 'awaiting_pairing' else 'unpaired' end;
      end if;
    else
      v_self := old.device_uid is not null and old.device_uid = auth.uid();
      v_bo := not public.is_anon_session()
              and old.location_id is not null
              and old.location_id::text in (select public.user_accessible_locations());
      if not v_admin and not v_bo then
        -- The till itself: its heartbeat, session token, screen settings, and clearing
        -- its own used code. Nothing that decides which venue it belongs to.
        if not v_self then
          raise exception 'This device row belongs to another till' using errcode = '42501';
        end if;
        if new.id is distinct from old.id
           or new.location_id is distinct from old.location_id
           or new.device_uid is distinct from old.device_uid
           or new.bound_via is distinct from old.bound_via
           or new.bound_at is distinct from old.bound_at
           or new.device_secret_hash is distinct from old.device_secret_hash
           or new.secret_issued_at is distinct from old.secret_issued_at
           or new.client_caps is distinct from old.client_caps
           or new.name is distinct from old.name
           or new.type is distinct from old.type
           or new.profile_id is distinct from old.profile_id
           or new.centre_id is distinct from old.centre_id
           or new.receipt_printer_id is distinct from old.receipt_printer_id
           or new.created_at is distinct from old.created_at
           or (new.pairing_code is not null and new.pairing_code is distinct from old.pairing_code)
           or (new.status is distinct from old.status and new.status not in ('active', 'online')) then
          raise exception 'A till can only update its own heartbeat. Everything else is set in Back Office.' using errcode = '42501';
        end if;
      else
        -- Back Office (or super admin): never links a device to a login directly.
        if new.device_uid is not null and new.device_uid is distinct from old.device_uid then
          raise exception 'A device is linked to a till only by pairing it with a code' using errcode = '42501';
        end if;
        if (new.bound_via is not null and new.bound_via is distinct from old.bound_via)
           or (new.bound_at is not null and new.bound_at is distinct from old.bound_at)
           or (new.device_secret_hash is not null and new.device_secret_hash is distinct from old.device_secret_hash)
           or (new.secret_issued_at is not null and new.secret_issued_at is distinct from old.secret_issued_at)
           or new.client_caps is distinct from old.client_caps then
          raise exception 'These device columns are written only by the pairing functions' using errcode = '42501';
        end if;
      end if;
    end if;
  end if;

  -- Lifecycle, for every caller outside the claim functions.
  if new.pairing_code is not null
     and (tg_op = 'INSERT' or new.pairing_code is distinct from old.pairing_code) then
    -- A new code means "pair this again": it lasts 60 minutes and drops the old link.
    new.pairing_code := upper(btrim(new.pairing_code));
    new.pairing_expires_at := now() + interval '60 minutes';
    if tg_op = 'UPDATE' and old.device_uid is not null then
      insert into public.device_claim_log (device_id, location_id, event, old_uid, detail)
      values (old.id, old.location_id, 'unbound_new_code', old.device_uid, 'Back Office issued a new pairing code');
    end if;
    new.device_uid := null;
    new.bound_via := null;
    new.bound_at := null;
    new.device_secret_hash := null;
    new.secret_issued_at := null;
    if tg_op = 'UPDATE' then
      delete from public.device_heal_codes where device_id = new.id;
    end if;
  elsif tg_op = 'UPDATE' and new.pairing_code is null and old.pairing_code is not null then
    new.pairing_expires_at := null;
  end if;

  if tg_op = 'UPDATE'
     and new.status in ('removed', 'unpaired', 'awaiting_pairing')
     and old.status is distinct from new.status
     and new.device_uid is not null then
    -- Removing or un-pairing a device takes its rights away at once, everywhere
    -- (including the edge functions that only check device_uid).
    insert into public.device_claim_log (device_id, location_id, event, old_uid, detail)
    values (old.id, old.location_id, 'unbound_status', new.device_uid, 'status set to ' || new.status);
    new.device_uid := null;
  end if;

  if tg_op = 'UPDATE' and new.device_uid is null and old.device_uid is not null then
    new.bound_via := null;
    new.bound_at := null;
    new.device_secret_hash := null;
    new.secret_issued_at := null;
    delete from public.device_heal_codes where device_id = new.id;
  end if;
  return new;
end;
$fn$;
revoke all on function public.devices_fence_tg() from public, anon, authenticated;

drop trigger if exists devices_fence_tg on public.devices;
create trigger devices_fence_tg
  before insert or update or delete on public.devices
  for each row execute function public.devices_fence_tg();

-- 6d. Server pairing code: 12 symbols from 32 (about 60 bits), shown as XXXX-XXXX-XXXX.
-- Claims compare codes with dashes and spaces removed, so the pairing screen can
-- accept it with or without dashes (gap B10).
create or replace function public._device_gen_pairing_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_code text;
begin
  loop
    v_code := public._fence_random_code(12);
    v_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4);
    exit when not exists (select 1 from public.devices d where d.pairing_code = v_code);
  end loop;
  return v_code;
end;
$fn$;
revoke all on function public._device_gen_pairing_code() from public, anon, authenticated;

-- 6e. The trust test. A devices row counts only when a claim bound it (bound_via set).
create or replace function public.pos_can_access(p_loc text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if p_loc is null then return false; end if;
  if p_loc in (select public.user_accessible_locations()) then return true; end if;
  if exists (select 1 from public.devices d
              where d.device_uid = auth.uid()
                and d.bound_via is not null
                and d.status in ('active', 'online')
                and d.location_id::text = p_loc) then
    return true;
  end if;
  return exists (select 1 from public.ops_devices o
                  where o.device_uid = auth.uid() and o.active and o.location_id::text = p_loc);
end;
$fn$;

create or replace function public.pos_can_access(p_loc uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if p_loc is null then return false; end if;
  if p_loc::text in (select public.user_accessible_locations()) then return true; end if;
  if exists (select 1 from public.devices d
              where d.device_uid = auth.uid()
                and d.bound_via is not null
                and d.status in ('active', 'online')
                and d.location_id = p_loc) then
    return true;
  end if;
  return exists (select 1 from public.ops_devices o
                  where o.device_uid = auth.uid() and o.active and o.location_id = p_loc);
end;
$fn$;

-- Set versions of the same test, so a policy can say "location_id in (select ...)"
-- and Postgres works the set out once per statement instead of once per row.
create or replace function public.pos_accessible_location_keys()
returns setof text
language sql
stable
security definer
set search_path = public
as $fn$
  select public.user_accessible_locations()
  union
  select d.location_id::text
    from public.devices d
   where d.device_uid = auth.uid()
     and d.bound_via is not null
     and d.status in ('active', 'online')
     and d.location_id is not null
  union
  select o.location_id::text
    from public.ops_devices o
   where o.device_uid = auth.uid()
     and o.active
     and o.location_id is not null;
$fn$;

create or replace function public.pos_accessible_location_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select k::uuid
    from public.pos_accessible_location_keys() as k
   where public._fence_is_uuid(k);
$fn$;

revoke all on function public.pos_can_access(text) from public;
revoke all on function public.pos_can_access(uuid) from public;
revoke all on function public.pos_accessible_location_keys() from public;
revoke all on function public.pos_accessible_location_ids() from public;
grant execute on function public.pos_can_access(text) to anon, authenticated, service_role;
grant execute on function public.pos_can_access(uuid) to anon, authenticated, service_role;
grant execute on function public.pos_accessible_location_keys() to anon, authenticated, service_role;
grant execute on function public.pos_accessible_location_ids() to anon, authenticated, service_role;

-- 6f. The claim family.
-- Shared result for a device the caller may now act as.
create or replace function public._device_claim_result(p_id uuid, p_already boolean, p_secret text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
           'ok', true,
           'already_bound', p_already,
           'device_id', d.id,
           'location_id', d.location_id,
           'name', d.name,
           'type', d.type,
           'status', d.status,
           'profile_id', d.profile_id,
           'centre_id', d.centre_id,
           'receipt_printer_id', d.receipt_printer_id,
           'device_secret', p_secret,
           'location', case when l.id is null then null
                            else jsonb_build_object('id', l.id, 'name', l.name, 'org_id', l.org_id, 'timezone', l.timezone) end)
    from public.devices d
    left join public.locations l on l.id = d.location_id
   where d.id = p_id;
$fn$;
revoke all on function public._device_claim_result(uuid, boolean, text) from public, anon, authenticated;

create or replace function public._device_claim_refusal(p_reason text, p_message text)
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $fn$
  select jsonb_build_object('ok', false, 'reason', p_reason, 'message', p_message);
$fn$;
revoke all on function public._device_claim_refusal(text, text) from public, anon, authenticated;

-- A uid is bound to one device row at most (a tablet moved to another venue loses
-- the old venue).
create or replace function public._device_unbind_others(p_uid uuid, p_keep uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
begin
  for r in select id, location_id from public.devices where device_uid = p_uid and id <> p_keep loop
    update public.devices
       set device_uid = null, bound_via = null, bound_at = null,
           device_secret_hash = null, secret_issued_at = null,
           status = case when status in ('active', 'online')
                         then case when type = 'kiosk' then 'awaiting_pairing' else 'unpaired' end
                         else status end
     where id = r.id;
    delete from public.device_heal_codes where device_id = r.id;
    insert into public.device_claim_log (device_id, location_id, event, old_uid, detail)
    values (r.id, r.location_id, 'unbound_moved', p_uid, 'the same till was paired to another device row');
  end loop;
end;
$fn$;
revoke all on function public._device_unbind_others(uuid, uuid) from public, anon, authenticated;

-- May a till whose login changed re-link with its saved code? Every pairing code was
-- readable by anyone before this file, so a saved code alone proves nothing. The
-- re-link is allowed only when BOTH hold:
--   * the till's current login is idle: no auth session refresh in 75 minutes (a
--     running till refreshes about every hour; a till that woke up with a new login
--     left its old one behind);
--   * the new login signed in from the same network the old login used (same public
--     address, or the same IPv6 /64), i.e. from inside the venue.
-- Returns NULL when allowed, or the reason it is not.
create or replace function public._device_heal_block_reason(p_old_uid uuid, p_new_uid uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_sid    uuid;
  v_ip     inet;
begin
  if p_old_uid is null or p_new_uid is null then
    return 'missing';
  end if;
  if exists (select 1 from auth.sessions s
              where s.user_id = p_old_uid
                and greatest(s.updated_at, s.created_at, coalesce(s.refreshed_at at time zone 'UTC', s.created_at))
                    > now() - interval '75 minutes') then
    return 'old_login_active';
  end if;
  if public._fence_is_uuid(v_claims ->> 'session_id') then
    v_sid := (v_claims ->> 'session_id')::uuid;
  end if;
  select s.ip into v_ip
    from auth.sessions s
   where s.user_id = p_new_uid and (v_sid is null or s.id = v_sid)
   order by s.created_at desc
   limit 1;
  if v_ip is null then
    return 'no_network';
  end if;
  if not exists (select 1 from auth.sessions s
                  where s.user_id = p_old_uid
                    and s.ip is not null
                    and (host(s.ip) = host(v_ip)
                         or (family(s.ip) = 6 and family(v_ip) = 6
                             and network(set_masklen(s.ip, 64)) = network(set_masklen(v_ip, 64))))) then
    return 'different_network';
  end if;
  return null;
end;
$fn$;
revoke all on function public._device_heal_block_reason(uuid, uuid) from public, anon, authenticated;

-- The core. Refusals RETURN (never raise) so the miss counters are kept.
-- Order of checks:
--   1. the caller is already bound: idempotent (old tills re-send their saved code
--      on every boot, gap B8), and v2 callers can collect a device secret;
--   2. throttles: 6 misses in 10 minutes locks this session for 15 minutes; 40 misses
--      in 10 minutes across the platform pauses code claims for 10 minutes (gap G22);
--   3. a live code on an unbound row: bind, clear the code (single use), keep only a
--      salted hash of it so the live app can re-link after a login change;
--   4. a saved code of a bound till (re-link, "heal"): only when the old login is idle
--      and the new one is on the same network (above), at most 3 times a day.
create or replace function public._device_claim_core(p_code text, p_mint_secret boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_norm    text := public._fence_norm_code(p_code);
  v_own     public.devices%rowtype;
  v_row     public.devices%rowtype;
  v_heal    public.device_heal_codes%rowtype;
  v_secret  text := null;
  v_salt    text;
  v_bucket  text;
  v_block   text;
begin
  if v_uid is null then
    raise exception 'no auth session' using errcode = '28000';
  end if;
  v_bucket := 'claim:uid:' || v_uid::text;
  perform set_config('servos.fence_bypass', 'on', true);

  select * into v_own
    from public.devices d
   where d.device_uid = v_uid and d.bound_via is not null and d.status in ('active', 'online')
   order by d.bound_at desc nulls last
   limit 1;

  if v_norm <> '' then
    select * into v_row
      from public.devices d
     where public._fence_norm_code(d.pairing_code) = v_norm and d.status <> 'removed'
     limit 1
     for update;
  end if;

  -- 1. Already bound, and the code is its own, used, or unknown: nothing to do.
  if v_own.id is not null and (v_row.id is null or v_row.id = v_own.id) then
    if p_mint_secret then
      v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
      update public.devices
         set last_seen = now(),
             device_secret_hash = encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'),
             secret_issued_at = now()
       where id = v_own.id;
    else
      update public.devices set last_seen = now() where id = v_own.id;
    end if;
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_result(v_own.id, true, v_secret);
  end if;

  if v_norm = '' then
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_refusal('not_found', 'Enter the pairing code from Back Office.');
  end if;

  -- 2. Throttles.
  if public._fence_is_locked(v_bucket) or public._fence_is_locked('claim:global') then
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_refusal('locked', 'Too many pairing attempts. Wait 15 minutes and try again.');
  end if;

  if v_row.id is null then
    -- 4. Maybe the saved code of a bound till whose login changed.
    select h.* into v_heal
      from public.device_heal_codes h
      join public.devices d on d.id = h.device_id
     where h.code_hash = encode(sha256(convert_to(h.salt || ':' || v_norm, 'UTF8')), 'hex')
       and d.status in ('active', 'online')
     limit 1;
    if v_heal.device_id is null then
      perform public._fence_count(v_bucket, 6, interval '10 minutes', interval '15 minutes');
      perform public._fence_count('claim:global', 40, interval '10 minutes', interval '10 minutes');
      insert into public.device_claim_log (event, new_uid, detail) values ('refused_not_found', v_uid, 'code not found');
      perform set_config('servos.fence_bypass', 'off', true);
      return public._device_claim_refusal('not_found', 'Pairing code not found. Check the code in Back Office.');
    end if;
    select * into v_row from public.devices where id = v_heal.device_id for update;
    v_block := public._device_heal_block_reason(v_row.device_uid, v_uid);
    if v_block is not null then
      -- Counted like a wrong code: it is exactly what someone holding an old code
      -- would try. The answer looks like "not found", on purpose.
      perform public._fence_count(v_bucket, 6, interval '10 minutes', interval '15 minutes');
      perform public._fence_count('claim:global', 40, interval '10 minutes', interval '10 minutes');
      insert into public.device_claim_log (device_id, location_id, event, old_uid, new_uid, detail)
      values (v_row.id, v_row.location_id, 'refused_relink', v_row.device_uid, v_uid, v_block);
      perform set_config('servos.fence_bypass', 'off', true);
      return public._device_claim_refusal('not_found', 'Pairing code not found or already used. Issue a new code in Back Office.');
    end if;
    if v_heal.heal_window_start is not null and v_heal.heal_window_start > now() - interval '24 hours'
       and v_heal.heal_count >= 3 then
      insert into public.device_claim_log (device_id, location_id, event, old_uid, new_uid, detail)
      values (v_row.id, v_row.location_id, 'refused_heal_limit', v_row.device_uid, v_uid, 'more than 3 re-links in 24 hours');
      perform set_config('servos.fence_bypass', 'off', true);
      return public._device_claim_refusal('heal_limit', 'This till was re-linked too many times today. Ask a manager to pair it again from Back Office.');
    end if;
    perform public._device_unbind_others(v_uid, v_row.id);
    update public.devices
       set device_uid = v_uid, bound_via = 'heal', bound_at = now(), last_seen = now(),
           device_secret_hash = case when p_mint_secret then device_secret_hash else null end,
           secret_issued_at = case when p_mint_secret then secret_issued_at else null end
     where id = v_row.id;
    update public.device_heal_codes
       set heal_count = case when heal_window_start is null or heal_window_start < now() - interval '24 hours' then 1 else heal_count + 1 end,
           heal_window_start = case when heal_window_start is null or heal_window_start < now() - interval '24 hours' then now() else heal_window_start end,
           last_heal_at = now()
     where device_id = v_row.id;
    if p_mint_secret then
      v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
      update public.devices
         set device_secret_hash = encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), secret_issued_at = now()
       where id = v_row.id;
    end if;
    perform public._fence_clear(v_bucket);
    insert into public.device_claim_log (device_id, location_id, event, old_uid, new_uid, detail)
    values (v_row.id, v_row.location_id, 'healed', v_row.device_uid, v_uid, 're-linked with the saved pairing code');
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_result(v_row.id, false, v_secret);
  end if;

  -- 3. A code on a row. It must be live, and the row must not belong to another till.
  if v_row.device_uid is not null and v_row.device_uid <> v_uid then
    perform public._fence_count(v_bucket, 6, interval '10 minutes', interval '15 minutes');
    insert into public.device_claim_log (device_id, location_id, event, old_uid, new_uid, detail)
    values (v_row.id, v_row.location_id, 'refused_already_paired', v_row.device_uid, v_uid, 'code of a till that is paired');
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_refusal('already_paired', 'This device is already paired to another till. Issue a new code in Back Office to move it.');
  end if;
  if v_row.pairing_expires_at is null or v_row.pairing_expires_at <= now() then
    perform public._fence_count(v_bucket, 6, interval '10 minutes', interval '15 minutes');
    perform public._fence_count('claim:global', 40, interval '10 minutes', interval '10 minutes');
    insert into public.device_claim_log (device_id, location_id, event, new_uid, detail)
    values (v_row.id, v_row.location_id, 'refused_expired', v_uid, 'code expired');
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_refusal('expired', 'This pairing code has expired. Issue a new one in Back Office.');
  end if;

  if p_mint_secret then
    v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  end if;
  perform public._device_unbind_others(v_uid, v_row.id);
  update public.devices
     set device_uid         = v_uid,
         bound_via          = 'code',
         bound_at           = now(),
         status             = case when type = 'kiosk' then 'online' else 'active' end,
         paired_at          = now(),
         last_seen          = now(),
         session_token      = null,
         pairing_code       = null,
         pairing_expires_at = null,
         device_secret_hash = case when v_secret is null then null else encode(sha256(convert_to(v_secret, 'UTF8')), 'hex') end,
         secret_issued_at   = case when v_secret is null then null else now() end
   where id = v_row.id;
  -- Keep only a salted hash of the used code, so the LIVE app (which saved the code
  -- and re-sends it at boot) can re-link after its login changes. File 2 deletes these.
  v_salt := replace(gen_random_uuid()::text, '-', '');
  insert into public.device_heal_codes (device_id, code_hash, salt)
  values (v_row.id, encode(sha256(convert_to(v_salt || ':' || v_norm, 'UTF8')), 'hex'), v_salt)
  on conflict (device_id) do update
     set code_hash = excluded.code_hash, salt = excluded.salt, created_at = now(),
         heal_count = 0, heal_window_start = null, last_heal_at = null;
  perform public._fence_clear(v_bucket);
  insert into public.device_claim_log (device_id, location_id, event, new_uid, detail)
  values (v_row.id, v_row.location_id, 'bound', v_uid, 'paired with a Back Office code');
  perform set_config('servos.fence_bypass', 'off', true);
  return public._device_claim_result(v_row.id, false, v_secret);
end;
$fn$;
revoke all on function public._device_claim_core(text, boolean) from public, anon, authenticated;

-- Same name, arguments and return type as the live function, so the live pairing
-- screen, kiosk and boot re-claim keep working. NULL means "not paired".
create or replace function public.claim_device(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r jsonb;
begin
  r := public._device_claim_core(p_code, false);
  if r is null or coalesce((r ->> 'ok')::boolean, false) = false then
    return null;
  end if;
  return (r ->> 'location_id')::uuid;
end;
$fn$;

-- For the app release (contract A10, A11): returns the device, its venue and a one
-- time device secret, or ok=false with a reason and a message to show.
create or replace function public.claim_device_v2(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return public._device_claim_core(p_code, true);
end;
$fn$;

-- Re-link with the device secret when the login changed (contract A12). A wrong
-- secret counts as a miss like a wrong code.
create or replace function public.reclaim_device(p_device_id uuid, p_device_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v        public.devices%rowtype;
  v_bucket text;
begin
  if v_uid is null then
    raise exception 'no auth session' using errcode = '28000';
  end if;
  v_bucket := 'claim:uid:' || v_uid::text;
  if public._fence_is_locked(v_bucket) then
    return public._device_claim_refusal('locked', 'Too many attempts. Wait 15 minutes and try again.');
  end if;
  select * into v from public.devices where id = p_device_id and status in ('active', 'online') for update;
  if v.id is null
     or v.device_secret_hash is null
     or coalesce(p_device_secret, '') = ''
     or v.device_secret_hash <> encode(sha256(convert_to(p_device_secret, 'UTF8')), 'hex') then
    perform public._fence_count(v_bucket, 6, interval '10 minutes', interval '15 minutes');
    insert into public.device_claim_log (device_id, location_id, event, new_uid, detail)
    values (p_device_id, v.location_id, 'refused_secret', v_uid, 'wrong or missing device secret');
    return public._device_claim_refusal('invalid', 'This till needs to be paired again from Back Office.');
  end if;
  perform set_config('servos.fence_bypass', 'on', true);
  if v.device_uid is distinct from v_uid then
    perform public._device_unbind_others(v_uid, v.id);
    update public.devices
       set device_uid = v_uid, bound_via = 'secret', bound_at = now(), last_seen = now()
     where id = v.id;
    insert into public.device_claim_log (device_id, location_id, event, old_uid, new_uid, detail)
    values (v.id, v.location_id, 'reclaimed', v.device_uid, v_uid, 'device secret');
  else
    update public.devices set last_seen = now() where id = v.id;
  end if;
  perform public._fence_clear(v_bucket);
  perform set_config('servos.fence_bypass', 'off', true);
  return public._device_claim_result(v.id, v.device_uid = v_uid, null);
end;
$fn$;

-- A till that is already bound (every grandfathered till) collects a device secret
-- on its first boot of the new app, so it never needs a pairing code again.
create or replace function public.device_issue_secret()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v        public.devices%rowtype;
  v_secret text;
begin
  if v_uid is null then
    raise exception 'no auth session' using errcode = '28000';
  end if;
  select * into v from public.devices
   where device_uid = v_uid and bound_via is not null and status in ('active', 'online')
   order by bound_at desc nulls last limit 1 for update;
  if v.id is null then
    return public._device_claim_refusal('not_bound', 'This till is not paired. Pair it from Back Office.');
  end if;
  v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  perform set_config('servos.fence_bypass', 'on', true);
  update public.devices
     set device_secret_hash = encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), secret_issued_at = now()
   where id = v.id;
  insert into public.device_claim_log (device_id, location_id, event, new_uid, detail)
  values (v.id, v.location_id, 'secret_issued', v_uid, 'bound till collected a device secret');
  perform set_config('servos.fence_bypass', 'off', true);
  return public._device_claim_result(v.id, true, v_secret);
end;
$fn$;

-- Back Office: issue a server code for a device you manage (contract P1). A device
-- that is paired right now is only moved when p_force is true (the Back Office asks
-- "this till will be disconnected" first).
create or replace function public.issue_pairing_code(p_device_id uuid, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v      public.devices%rowtype;
  v_code text;
begin
  if auth.uid() is null or public.is_anon_session() then
    raise exception 'A Back Office login is needed to issue a pairing code' using errcode = '42501';
  end if;
  select * into v from public.devices where id = p_device_id for update;
  if v.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'message', 'Device not found.');
  end if;
  if not (public.is_super_admin() or v.location_id::text in (select public.user_accessible_locations())) then
    raise exception 'You do not manage this device''s venue' using errcode = '42501';
  end if;
  if v.device_uid is not null and not coalesce(p_force, false) then
    return jsonb_build_object('ok', false, 'reason', 'paired',
                              'message', 'This device is paired and in use. A new code disconnects it until it is paired again.');
  end if;
  v_code := public._device_gen_pairing_code();
  perform set_config('servos.device_issue', 'on', true);
  update public.devices
     set pairing_code = v_code,
         status = case when type = 'kiosk' then 'awaiting_pairing' else 'unpaired' end,
         paired_at = null,
         session_token = null
   where id = v.id;
  perform set_config('servos.device_issue', 'off', true);
  return jsonb_build_object('ok', true, 'code', v_code,
                            'expires_at', (select pairing_expires_at from public.devices where id = v.id));
end;
$fn$;

-- The running app reports itself (contract A15). The last_seen, version and what the
-- app can do are what file 2's release gate checks.
create or replace function public.device_heartbeat(p_app_version text default null, p_caps text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v     public.devices%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('bound', false, 'reason', 'no_session');
  end if;
  select * into v from public.devices
   where device_uid = v_uid and bound_via is not null
   order by bound_at desc nulls last limit 1;
  if v.id is null or v.status not in ('active', 'online') then
    return jsonb_build_object('bound', false, 'reason', case when v.id is null then 'not_bound' else 'status_' || v.status end);
  end if;
  perform set_config('servos.fence_bypass', 'on', true);
  update public.devices
     set last_seen = now(),
         last_heartbeat_at = now(),
         app_version = coalesce(left(p_app_version, 40), app_version),
         client_caps = coalesce(p_caps[1:20], client_caps)
   where id = v.id;
  perform set_config('servos.fence_bypass', 'off', true);
  return jsonb_build_object('bound', true, 'device_id', v.id, 'location_id', v.location_id,
                            'status', v.status, 'name', v.name, 'has_secret', v.device_secret_hash is not null);
end;
$fn$;

-- Read only: "am I still the paired till for my venue?" for the lapse banner (contract A16).
create or replace function public.device_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(
    (select jsonb_build_object('bound', true, 'device_id', d.id, 'location_id', d.location_id, 'status', d.status,
                               'name', d.name, 'has_secret', d.device_secret_hash is not null)
       from public.devices d
      where d.device_uid = auth.uid() and d.bound_via is not null and d.status in ('active', 'online')
      order by d.bound_at desc nulls last
      limit 1),
    jsonb_build_object('bound', false));
$fn$;

do $claim_grants$
declare
  f text;
begin
  foreach f in array array['public.claim_device(text)', 'public.claim_device_v2(text)',
                           'public.reclaim_device(uuid, text)', 'public.device_issue_secret()',
                           'public.issue_pairing_code(uuid, boolean)', 'public.device_heartbeat(text, text[])',
                           'public.device_status()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end
$claim_grants$;

-- 6g. devices policies. INSERT and DELETE: Back Office of that venue (or super admin).
-- UPDATE: the bound till on its own row (the trigger limits the columns), or Back
-- Office. SELECT stays open until file 2, ONLY because the live pairing screen looks a
-- code up before claiming and a till whose login changed must still read its own row
-- (otherwise the live app wipes its pairing, gap B3). Used codes are no longer on the
-- table, so what stays visible is: device names, and codes issued in the last 60
-- minutes that nobody has used yet.
alter table public.devices enable row level security;

drop policy if exists devices_read_interim on public.devices;
create policy devices_read_interim on public.devices
  for select
  using (true);

drop policy if exists devices_insert_bo on public.devices;
create policy devices_insert_bo on public.devices
  for insert
  with check (not (select public.is_anon_session()) and (select auth.uid()) is not null
              and location_id::text in (select public.user_accessible_locations()));

drop policy if exists devices_update_own_or_bo on public.devices;
create policy devices_update_own_or_bo on public.devices
  for update
  using ((device_uid = (select auth.uid()) and bound_via is not null)
         or (not (select public.is_anon_session()) and location_id::text in (select public.user_accessible_locations())))
  with check ((device_uid = (select auth.uid()) and bound_via is not null)
              or (not (select public.is_anon_session()) and location_id::text in (select public.user_accessible_locations())));

drop policy if exists devices_delete_bo on public.devices;
create policy devices_delete_bo on public.devices
  for delete
  using (not (select public.is_anon_session()) and location_id::text in (select public.user_accessible_locations()));

drop policy if exists "allow all" on public.devices;
drop policy if exists devices_select on public.devices;
drop policy if exists devices_insert on public.devices;
drop policy if exists devices_update on public.devices;
drop policy if exists devices_delete on public.devices;



-- ============================================================================
-- 7. Server functions for the customer pages (used by the app release)
-- ============================================================================
-- Every one is keyed to something the customer really holds: the tracking token
-- (or, for old links, the last 4 phone digits, throttled), the card payment id of
-- their own tab, or the table code the tab owner shared. None returns another
-- customer's name, phone, email, address or card ids. (The new order_queue column they
-- use, placed_via, is added in section 9, last, so the busy order table is locked for
-- the shortest time.)

-- 7a. The order tracker. p_key is the tracking token from place_public_order, the
-- tab's card payment id (QR), or the last 4 digits of the phone (old share links:
-- 10 wrong tries per order per hour, then that order locks for an hour, gap G6).
create or replace function public._order_track_ok(p_location_id text, p_ref text, p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_q      public.order_queue%rowtype;
  v_digits text := regexp_replace(coalesce(p_key, ''), '\D', '', 'g');
  v_bucket text := 'track:' || coalesce(p_location_id, '') || ':' || coalesce(p_ref, '');
begin
  if coalesce(p_location_id, '') = '' or coalesce(p_ref, '') = '' or coalesce(p_key, '') = '' then
    return false;
  end if;
  if public._fence_is_locked(v_bucket) or public._fence_is_locked('track:global') then
    return false;
  end if;
  select * into v_q from public.order_queue q where q.location_id = p_location_id and q.ref = p_ref;
  if v_q.ref is not null then
    if exists (select 1 from public.public_order_tokens t
                where t.location_id = p_location_id and t.ref = p_ref and t.token = p_key) then
      return true;
    end if;
    if length(p_key) >= 12 and coalesce(v_q.customer ->> 'payment_intent_id', '') = p_key then
      return true;
    end if;
    if length(v_digits) = 4 and length(p_key) <= 8
       and right(regexp_replace(coalesce(v_q.customer ->> 'phone', ''), '\D', '', 'g'), 4) = v_digits then
      return true;
    end if;
  end if;
  perform public._fence_count(v_bucket, 10, interval '1 hour', interval '1 hour');
  perform public._fence_count('track:global', 3000, interval '10 minutes', interval '5 minutes');
  return false;
end;
$fn$;
revoke all on function public._order_track_ok(text, text, text) from public, anon, authenticated;

create or replace function public.order_track_check(p_location_id text, p_ref text, p_key text)
returns boolean
language sql
security definer
set search_path = public
as $fn$
  select public._order_track_ok(p_location_id, p_ref, p_key);
$fn$;

-- What the tracker page renders, and nothing else. The share link needs the last
-- 4 phone digits, so 'phone' carries only those.
create or replace function public.order_track_row(p_location_id text, p_ref text, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public._order_track_ok(p_location_id, p_ref, p_key) then
    return null;
  end if;
  return (
    select jsonb_build_object(
             'ref', q.ref, 'status', q.status, 'total', q.total, 'items', q.items,
             'collection_time', q.collection_time, 'is_asap', q.is_asap, 'type', q.type,
             'source', q.source, 'sent_at', q.sent_at, 'updated_at', q.updated_at, 'paid', q.paid,
             'customer', jsonb_strip_nulls(jsonb_build_object(
                 'delivery_mode', q.customer ->> 'delivery_mode',
                 'collection_at', q.customer ->> 'collection_at',
                 'tip', q.customer -> 'tip',
                 'tableLabel', q.customer ->> 'tableLabel',
                 'phone', nullif(right(regexp_replace(coalesce(q.customer ->> 'phone', ''), '\D', '', 'g'), 4), ''))))
      from public.order_queue q
     where q.location_id = p_location_id and q.ref = p_ref);
end;
$fn$;

-- 7b. QR tabs. The handle is an opaque md5 of the tab's card payment id: it names a
-- tab without revealing the payment id, the table code or any name (gap G4).
create or replace function public.qr_table_open_tabs(p_location_id text, p_table_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(jsonb_agg(t order by t.opened_at), '[]'::jsonb)
    from (
      select md5(q.customer ->> 'payment_intent_id')                               as tab_handle,
             min(coalesce(q.customer ->> 'tab_ref', q.ref))                        as tab_ref,
             min(coalesce(q.customer ->> 'tableLabel', p_table_id))                as table_label,
             min(coalesce(q.customer ->> 'tab_opened_at', q.created_at::text))     as opened_at,
             min(coalesce(q.customer ->> 'processor', 'stripe'))                   as processor,
             coalesce(sum(q.total), 0)                                             as total,
             count(*)::int                                                         as rounds,
             bool_or(coalesce(q.customer ->> 'tab_join_code', '') <> '')           as has_join_code
        from public.order_queue q
       where q.location_id = p_location_id
         and q.source = 'qr'
         and q.status <> 'collected'
         and q.customer ->> 'tableId' = p_table_id
         and public._fence_bool(q.customer ->> 'tab_open')
         and coalesce(q.customer ->> 'payment_intent_id', '') <> ''
       group by q.customer ->> 'payment_intent_id'
    ) t;
$fn$;

-- The tab and its rounds, for a caller who has proven the tab (internal).
-- The tab block carries the fields the close path needs (gap G16): payment id,
-- processor, Stripe account, Ryft ids, saved card id, hold amount, tab ref, code.
create or replace function public._qr_tab_payload(p_location_id text, p_pi text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with r as (
    select q.*
      from public.order_queue q
     where q.location_id = p_location_id
       and q.source = 'qr'
       and q.status <> 'collected'
       and q.customer ->> 'payment_intent_id' = p_pi
  ), first_round as (
    select * from r order by created_at limit 1
  )
  select case when not exists (select 1 from r) then null else jsonb_build_object(
    'tab', (select jsonb_strip_nulls(jsonb_build_object(
              'payment_intent_id', f.customer ->> 'payment_intent_id',
              'processor', coalesce(f.customer ->> 'processor', 'stripe'),
              'stripe_account', f.customer ->> 'stripe_account',
              'payment_session_id', f.customer ->> 'payment_session_id',
              'ryft_customer_id', f.customer ->> 'ryft_customer_id',
              'ryft_payment_method_id', f.customer ->> 'ryft_payment_method_id',
              'payment_method_id', f.customer ->> 'payment_method_id',
              'pre_auth_amount', public._fence_num(f.customer ->> 'pre_auth_amount'),
              'tab_ref', coalesce(f.customer ->> 'tab_ref', f.ref),
              'table_id', f.customer ->> 'tableId',
              'table_label', f.customer ->> 'tableLabel',
              'tab_join_code', f.customer ->> 'tab_join_code',
              'opened_at', coalesce(f.customer ->> 'tab_opened_at', f.created_at::text)))
              from first_round f),
    'rounds', (select coalesce(jsonb_agg(jsonb_build_object(
                  'ref', x.ref, 'status', x.status, 'items', x.items, 'total', x.total,
                  'created_at', x.created_at, 'sent_at', x.sent_at, 'location_id', x.location_id,
                  'customer', jsonb_strip_nulls(jsonb_build_object(
                      'tip', public._fence_num(x.customer ->> 'tip'),
                      'service_charge', public._fence_num(x.customer ->> 'service_charge'),
                      'tableId', x.customer ->> 'tableId',
                      'tableLabel', x.customer ->> 'tableLabel',
                      'round_ref', x.customer ->> 'round_ref',
                      'processor', x.customer ->> 'processor',
                      'pre_auth_amount', public._fence_num(x.customer ->> 'pre_auth_amount'),
                      'payment_intent_id', x.customer ->> 'payment_intent_id')))
                  order by x.created_at), '[]'::jsonb)
                 from r x)) end;
$fn$;
revoke all on function public._qr_tab_payload(text, text) from public, anon, authenticated;

-- The tab's owner, who holds its card payment id (their own stash).
create or replace function public.qr_tab_rounds(p_location_id text, p_payment_intent_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select case when coalesce(p_payment_intent_id, '') = '' then null
              else public._qr_tab_payload(p_location_id, p_payment_intent_id) end;
$fn$;

-- Another phone at the table, with the table code the owner shared (gap G5).
-- 8 wrong codes per tab per hour lock that tab for an hour. A tab with no code (old
-- tabs) cannot be joined by phone; staff can add to it or close it.
create or replace function public.qr_tab_join(p_location_id text, p_tab_handle text, p_join_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_pi     text;
  v_code   text;
  v_bucket text := 'join:' || coalesce(p_location_id, '') || ':' || coalesce(p_tab_handle, '');
begin
  if coalesce(p_location_id, '') = '' or coalesce(p_tab_handle, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  if public._fence_is_locked(v_bucket) then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'message', 'Too many wrong codes. Ask a member of staff.');
  end if;
  select q.customer ->> 'payment_intent_id', max(q.customer ->> 'tab_join_code')
    into v_pi, v_code
    from public.order_queue q
   where q.location_id = p_location_id
     and q.source = 'qr'
     and q.status <> 'collected'
     and md5(q.customer ->> 'payment_intent_id') = p_tab_handle
   group by q.customer ->> 'payment_intent_id'
   limit 1;
  if v_pi is null then
    return jsonb_build_object('ok', false, 'reason', 'no_tab');
  end if;
  if coalesce(v_code, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'staff_only', 'message', 'This tab was opened on another phone. Ask a member of staff to help you join it.');
  end if;
  if public._fence_norm_code(p_join_code) <> public._fence_norm_code(v_code) then
    perform public._fence_count(v_bucket, 8, interval '1 hour', interval '1 hour');
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'message', 'That code did not match.');
  end if;
  perform public._fence_clear(v_bucket);
  return jsonb_build_object('ok', true) || public._qr_tab_payload(p_location_id, v_pi);
end;
$fn$;

create or replace function public.qr_table_tab_count(p_location_id text, p_table_id text)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select count(distinct coalesce(nullif(q.customer ->> 'payment_intent_id', ''), 'ref:' || q.ref))::int
    from public.order_queue q
   where q.location_id = p_location_id
     and q.source = 'qr'
     and q.status <> 'collected'
     and q.customer ->> 'tableId' = p_table_id;
$fn$;

-- 7c. Catering capacity: count and value only.
create or replace function public.catering_day_load(p_location_id text, p_date date)
returns table (order_count integer, order_value numeric)
language sql
stable
security definer
set search_path = public
as $fn$
  select count(*)::int, coalesce(sum(q.total), 0)
    from public.order_queue q
   where q.location_id = p_location_id
     and q.source = 'catering'
     and q.event_date = p_date
     and q.status is distinct from 'cancelled';
$fn$;

-- 7d. Placing a public order (online, QR, catering). Replaces the direct inserts the
-- customer pages make today (gaps B2, B3). The rules:
--   * a session is needed (anonymous is fine); 30 orders per session per 10 minutes;
--   * insert only: an order that exists is never changed (a retry by the same
--     session gets the same answer back);
--   * "paid" needs proof: payment_proofs rows written by the payment-proof edge
--     function after it asked the processor. Card proofs must cover the check total;
--     a zero total needs a gift or loyalty proof. Without proof the order still
--     reaches the kitchen (money may have been taken) but as UNPAID, marked
--     payment_unverified, with no closed check, so staff check it;
--   * a QR tab (open or a new round) needs a preauth proof for its card payment id;
--     the table code is minted here, never by the phone (gap G5);
--   * nothing the customer sends can set staff, the venue, the status, paid, or a
--     server field. Numbers that are not numbers become 0 (gaps G10, G11).
create or replace function public.place_public_order(
  p_location_id uuid,
  p_order       jsonb,
  p_check       jsonb default null,
  p_proof_ids   uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid         uuid := auth.uid();
  v_loc         text := p_location_id::text;
  v_source      text := lower(coalesce(p_order ->> 'source', ''));
  v_ref         text := btrim(coalesce(p_order ->> 'ref', ''));
  v_customer    jsonb := case when jsonb_typeof(p_order -> 'customer') = 'object' then p_order -> 'customer' else '{}'::jsonb end;
  v_items       jsonb := case when jsonb_typeof(p_order -> 'items') = 'array' then p_order -> 'items' else '[]'::jsonb end;
  v_total       numeric := round(public._fence_num(p_order ->> 'total'), 2);
  v_type        text := left(coalesce(nullif(p_order ->> 'type', ''), 'collection'), 40);
  v_tab         boolean;
  v_pi          text;
  v_proof_ids   uuid[] := coalesce(p_proof_ids, '{}'::uuid[]);
  v_card_minor  bigint := 0;
  v_other_minor bigint := 0;
  v_need_minor  bigint := 0;
  v_paid        boolean := false;
  v_unverified  boolean := false;
  v_status      text;
  v_token       text;
  v_join        text := null;
  v_check_id    text := null;
  v_sent_at     timestamptz;
  v_event_date  date;
  v_existing    public.public_order_tokens%rowtype;
  v_cc          jsonb;
  v_check_total numeric;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session', 'message', 'Please reload the page and try again.');
  end if;
  if p_location_id is null
     or not exists (select 1 from public.locations l where l.id = p_location_id and coalesce(l.status, 'active') = 'active') then
    return jsonb_build_object('ok', false, 'reason', 'venue', 'message', 'This venue is not taking orders.');
  end if;
  if v_source not in ('online', 'qr', 'catering') then
    return jsonb_build_object('ok', false, 'reason', 'source');
  end if;
  if v_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,39}$' then
    return jsonb_build_object('ok', false, 'reason', 'ref');
  end if;

  -- A retry by the same session gets the first answer back.
  select * into v_existing from public.public_order_tokens t where t.location_id = v_loc and t.ref = v_ref;
  if v_existing.ref is not null then
    if v_existing.placed_by = v_uid then
      return jsonb_build_object('ok', true, 'idempotent', true, 'ref', v_ref, 'paid', v_existing.paid,
                                'track_token', v_existing.token,
                                'tab_join_code', (select q.customer ->> 'tab_join_code' from public.order_queue q
                                                   where q.location_id = v_loc and q.ref = v_ref));
    end if;
    return jsonb_build_object('ok', false, 'reason', 'ref_taken');
  end if;
  if exists (select 1 from public.order_queue q where q.location_id = v_loc and q.ref = v_ref) then
    return jsonb_build_object('ok', false, 'reason', 'ref_taken');
  end if;

  if jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 200 or pg_column_size(v_items) > 262144 then
    return jsonb_build_object('ok', false, 'reason', 'items');
  end if;
  if pg_column_size(v_customer) > 32768 then
    return jsonb_build_object('ok', false, 'reason', 'customer');
  end if;
  if v_total < 0 or v_total > 100000 then
    return jsonb_build_object('ok', false, 'reason', 'total');
  end if;
  if public._fence_is_locked('order:uid:' || v_uid::text) then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many orders from this device. Please wait a few minutes.');
  end if;

  -- Server fields a phone must never set.
  v_customer := v_customer - 'paid' - 'payment_verified' - 'payment_unverified' - 'tab_join_code' - 'staff' - 'placed_via';
  v_tab := v_source = 'qr' and public._fence_bool(v_customer ->> 'tab_open');
  v_pi := nullif(btrim(coalesce(v_customer ->> 'payment_intent_id', '')), '');

  -- Money proofs named by the caller, for this venue, not used before.
  perform 1 from public.payment_proofs p where p.id = any(v_proof_ids) for update;
  select coalesce(sum(p.amount_minor) filter (where p.kind = 'card'), 0),
         coalesce(sum(p.amount_minor) filter (where p.kind in ('gift', 'loyalty')), 0)
    into v_card_minor, v_other_minor
    from public.payment_proofs p
   where p.id = any(v_proof_ids)
     and p.location_id = v_loc
     and p.kind in ('card', 'gift', 'loyalty')
     and p.used_by_ref is null
     and p.verified_at > now() - interval '24 hours';

  if v_tab then
    -- Open a tab or add a round: the card hold must be proven by the server.
    if v_pi is null or not exists (
         select 1 from public.payment_proofs p
          where p.kind = 'preauth' and p.payment_ref = v_pi and p.location_id = v_loc) then
      return jsonb_build_object('ok', false, 'reason', 'tab_not_verified',
                                'message', 'We could not confirm the card hold for this tab. Please ask a member of staff.');
    end if;
    -- A hold that was already captured is a closed tab: no new rounds on it.
    if exists (select 1 from public.payment_proofs p
                where p.kind = 'capture' and p.payment_ref = v_pi and p.location_id = v_loc) then
      return jsonb_build_object('ok', false, 'reason', 'tab_closed',
                                'message', 'This tab is already closed. Please start a new order.');
    end if;
    select max(q.customer ->> 'tab_join_code') into v_join
      from public.order_queue q
     where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
       and q.customer ->> 'payment_intent_id' = v_pi;
    if v_join is null then
      v_join := public._fence_random_digits(6);
    end if;
    v_customer := v_customer || jsonb_build_object('tab_join_code', v_join);
    v_paid := false;
    v_status := 'prep';
  elsif p_check is not null and jsonb_typeof(p_check) = 'object' then
    v_check_total := round(public._fence_num(p_check ->> 'total'), 2);
    v_need_minor := round(v_check_total * 100)::bigint;
    if v_need_minor > 0 then
      v_paid := v_card_minor >= v_need_minor;
    else
      v_paid := v_other_minor > 0;
    end if;
    v_unverified := not v_paid;
    v_status := case when not v_paid then 'received' when v_source = 'catering' then 'received' else 'prep' end;
  else
    -- Pay later (no payment taken online): the venue collects on collection.
    v_paid := false;
    v_status := 'received';
  end if;

  if v_unverified then
    v_customer := v_customer || jsonb_build_object('payment_unverified', true);
  end if;

  begin
    v_sent_at := nullif(p_order ->> 'sent_at', '')::timestamptz;
  exception when others then
    v_sent_at := null;
  end;
  if v_sent_at is null or v_sent_at < now() - interval '1 hour' or v_sent_at > now() + interval '400 days' then
    v_sent_at := now();
  end if;
  begin
    v_event_date := nullif(p_order ->> 'event_date', '')::date;
  exception when others then
    v_event_date := null;
  end;
  if v_event_date is not null and (v_event_date < current_date - 1 or v_event_date > current_date + 400) then
    v_event_date := null;
  end if;

  insert into public.order_queue
    (ref, location_id, type, customer, items, total, status, staff, sent_at, collection_time, is_asap,
     source, paid, payment_method, event_date, placed_via)
  values
    (v_ref, v_loc, v_type, v_customer, v_items, v_total, v_status, null, v_sent_at,
     left(nullif(p_order ->> 'collection_time', ''), 40), public._fence_bool(p_order ->> 'is_asap'),
     v_source, v_paid, case when v_paid then left(coalesce(nullif(p_order ->> 'payment_method', ''), 'card'), 40) else null end,
     v_event_date, 'rpc');

  if v_paid and p_check is not null and jsonb_typeof(p_check) = 'object' then
    v_check_id := left(coalesce(nullif(btrim(p_check ->> 'id'), ''), 'chk-' || v_source || '-' || v_ref), 80);
    if exists (select 1 from public.closed_checks c where c.id = v_check_id) then
      v_check_id := v_check_id || '-' || public._fence_random_code(4);
    end if;
    v_cc := jsonb_build_object(
      'id', v_check_id,
      'ref', v_ref,
      'location_id', v_loc,
      'table_id', left(p_check ->> 'table_id', 80),
      'table_label', left(p_check ->> 'table_label', 80),
      'staff_name', null,
      'items', case when jsonb_typeof(p_check -> 'items') = 'array' then p_check -> 'items' else v_items end,
      'subtotal', round(public._fence_num(p_check ->> 'subtotal'), 2),
      'tax', round(public._fence_num(p_check ->> 'tax'), 2),
      'total', v_check_total,
      'payment_method', left(p_check ->> 'payment_method', 200),
      'covers', greatest(1, least(99, public._fence_num(p_check ->> 'covers')::int)),
      'closed_at', now(),
      'voided', false,
      'refunded', false,
      'server', left(coalesce(nullif(p_check ->> 'server', ''), initcap(v_source)), 40),
      'order_type', left(coalesce(nullif(p_check ->> 'order_type', ''), v_type), 40),
      'customer', case when jsonb_typeof(p_check -> 'customer') = 'object'
                       then (p_check -> 'customer') - 'paid' - 'staff' else v_customer end,
      'discounts', case when jsonb_typeof(p_check -> 'discounts') = 'array' then p_check -> 'discounts' else '[]'::jsonb end,
      'service', round(public._fence_num(p_check ->> 'service'), 2),
      'tip', round(public._fence_num(p_check ->> 'tip'), 2),
      'method', left(coalesce(nullif(p_check ->> 'method', ''), 'card'), 40),
      'status', 'paid',
      'refunds', '[]'::jsonb,
      'tax_breakdown', case when jsonb_typeof(p_check -> 'tax_breakdown') = 'array' then p_check -> 'tax_breakdown' else '[]'::jsonb end,
      'tax_amount', case when p_check ? 'tax_amount' and p_check ->> 'tax_amount' is not null
                         then round(public._fence_num(p_check ->> 'tax_amount'), 2) end,
      'source', v_source,
      'gift_card', case when jsonb_typeof(p_check -> 'gift_card') = 'object' then p_check -> 'gift_card' end,
      'loyalty', case when jsonb_typeof(p_check -> 'loyalty') = 'object' then p_check -> 'loyalty' end,
      'promo', case when jsonb_typeof(p_check -> 'promo') = 'object' then p_check -> 'promo' end,
      'stripe_payment_intent_id', left(p_check ->> 'stripe_payment_intent_id', 120),
      'payment_intents', case when jsonb_typeof(p_check -> 'payment_intents') = 'array' then p_check -> 'payment_intents' end,
      'processor', case when p_check ->> 'processor' in ('stripe', 'ryft', 'adyen') then p_check ->> 'processor' else 'stripe' end,
      'customer_phone', left(p_check ->> 'customer_phone', 40));
    insert into public.closed_checks
    select * from jsonb_populate_record(null::public.closed_checks, v_cc);

    update public.payment_proofs
       set used_by_ref = v_loc || ':' || v_ref, used_at = now()
     where id = any(v_proof_ids) and location_id = v_loc
       and kind in ('card', 'gift', 'loyalty') and used_by_ref is null;
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '');
  insert into public.public_order_tokens (location_id, ref, token, placed_by, paid)
  values (v_loc, v_ref, v_token, v_uid, v_paid);

  perform public._fence_count('order:uid:' || v_uid::text, 30, interval '10 minutes', interval '10 minutes');

  return jsonb_build_object('ok', true, 'ref', v_ref, 'paid', v_paid, 'status', v_status,
                            'payment_unverified', v_unverified, 'track_token', v_token,
                            'tab_join_code', v_join, 'check_id', v_check_id);
end;
$fn$;

-- 7e. Closing a QR tab from the customer's phone after the card was captured
-- (gap G17: only after a capture the server has seen). Marks the tab's rounds
-- collected and writes one closed check for what was really taken; a shortfall is
-- recorded for staff, never booked as paid.
create or replace function public.settle_qr_tab(
  p_location_id       uuid,
  p_payment_intent_id text,
  p_check             jsonb default '{}'::jsonb,
  p_proof_ids         uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid        uuid := auth.uid();
  v_loc        text := p_location_id::text;
  v_refs       text[];
  v_first      public.order_queue%rowtype;
  v_taken      bigint := 0;
  v_claimed    numeric;
  v_booked     numeric;
  v_check_id   text;
  v_cc         jsonb;
  v_items      jsonb;
  v_tip        numeric;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;
  if coalesce(p_payment_intent_id, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  -- Lock the proofs and the tab's rounds first, so two phones closing the same tab
  -- one after the other get "already closed", never a second check.
  perform 1 from public.payment_proofs p
   where p.location_id = v_loc
     and ((p.kind = 'capture' and p.payment_ref = p_payment_intent_id) or (p.kind = 'card' and p.id = any(coalesce(p_proof_ids, '{}'::uuid[]))))
   for update;
  perform 1 from public.order_queue q
   where q.location_id = v_loc and q.source = 'qr'
     and q.customer ->> 'payment_intent_id' = p_payment_intent_id
   for update;
  select array_agg(q.ref order by q.created_at) into v_refs
    from public.order_queue q
   where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
     and q.customer ->> 'payment_intent_id' = p_payment_intent_id;
  if v_refs is null then
    return jsonb_build_object('ok', true, 'closed', 0, 'reason', 'already_closed');
  end if;
  select coalesce(sum(p.amount_minor), 0) into v_taken
    from public.payment_proofs p
   where p.location_id = v_loc
     and p.used_by_ref is null
     and ((p.kind = 'capture' and p.payment_ref = p_payment_intent_id)
          or (p.kind = 'card' and p.id = any(coalesce(p_proof_ids, '{}'::uuid[]))));
  if v_taken <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_captured',
                              'message', 'We could not confirm the payment yet. Please try again, or ask a member of staff.');
  end if;

  select * into v_first from public.order_queue q
   where q.location_id = v_loc and q.ref = v_refs[1];
  select coalesce(jsonb_agg(e.item), '[]'::jsonb) into v_items
    from public.order_queue q
    cross join lateral jsonb_array_elements(case when jsonb_typeof(q.items) = 'array' then q.items else '[]'::jsonb end) as e(item)
   where q.location_id = v_loc and q.ref = any(v_refs);
  select coalesce(sum(public._fence_num(q.customer ->> 'tip')), 0) into v_tip
    from public.order_queue q
   where q.location_id = v_loc and q.ref = any(v_refs);
  select coalesce(sum(q.total), 0) into v_claimed
    from public.order_queue q
   where q.location_id = v_loc and q.ref = any(v_refs);
  v_booked := least(v_claimed, round(v_taken::numeric / 100, 2));

  update public.order_queue
     set status = 'collected'
   where location_id = v_loc and ref = any(v_refs);

  v_check_id := 'chk-qr-' || left(md5(v_loc || ':' || p_payment_intent_id), 16);
  if not exists (select 1 from public.closed_checks c where c.id = v_check_id) then
    v_cc := jsonb_build_object(
      'id', v_check_id,
      'ref', coalesce(v_first.customer ->> 'tab_ref', v_first.ref),
      'location_id', v_loc,
      'table_id', null,
      'table_label', left(coalesce(p_check ->> 'table_label', 'Table ' || coalesce(v_first.customer ->> 'tableLabel', '')), 80),
      'items', v_items,
      'subtotal', greatest(0, v_booked - v_tip),
      'tax', 0,
      'total', v_booked,
      'covers', 1,
      'closed_at', now(),
      'voided', false,
      'refunded', false,
      'server', 'QR',
      'order_type', 'dine-in',
      'customer', (v_first.customer - 'tab_join_code') || jsonb_build_object(
                    'tab_closed_at', now(),
                    'shortfall', greatest(0, v_claimed - v_booked)),
      'discounts', '[]'::jsonb,
      'service', 0,
      'tip', least(v_tip, v_booked),
      'method', 'card',
      'status', 'paid',
      'refunds', '[]'::jsonb,
      'tax_breakdown', '[]'::jsonb,
      'source', 'qr',
      'stripe_payment_intent_id', case when coalesce(v_first.customer ->> 'processor', 'stripe') = 'stripe' then p_payment_intent_id end,
      'payment_intents', jsonb_build_array(jsonb_build_object('id', p_payment_intent_id, 'amountMinor', v_taken)),
      'processor', case when v_first.customer ->> 'processor' in ('stripe', 'ryft', 'adyen') then v_first.customer ->> 'processor' else 'stripe' end);
    insert into public.closed_checks
    select * from jsonb_populate_record(null::public.closed_checks, v_cc);
  end if;

  update public.payment_proofs
     set used_by_ref = v_loc || ':' || coalesce(v_first.customer ->> 'tab_ref', v_first.ref), used_at = now()
   where location_id = v_loc and used_by_ref is null
     and ((kind = 'capture' and payment_ref = p_payment_intent_id)
          or (kind = 'card' and id = any(coalesce(p_proof_ids, '{}'::uuid[]))));

  return jsonb_build_object('ok', true, 'closed', array_length(v_refs, 1), 'check_id', v_check_id,
                            'booked', v_booked, 'shortfall', greatest(0, v_claimed - v_booked));
end;
$fn$;

-- 7f. QR tabs on the floor plan, worked out on the server from the open QR rounds
-- (gap G17: no public function writes active_sessions). Only ever writes or deletes a
-- session whose source is 'qr', so a till's own session on that table is never
-- touched (tables must never be lost). Never waits on a till: a locked row is left
-- for the next order change. File 2 attaches it as a trigger on order_queue, when the
-- phone's own sync (src/lib/qrTableSession.js) is gone.
create or replace function public._qr_sync_table_session(p_location_id uuid, p_table_id text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_floor    text;
  v_items    jsonb;
  v_rounds   integer;
  v_opened   timestamptz;
  v_subtotal numeric := 0;
  v_existing public.active_sessions%rowtype;
  v_session  jsonb;
begin
  if p_location_id is null or coalesce(btrim(p_table_id), '') = '' then
    return;
  end if;
  select f.id into v_floor
    from public.floor_tables f
   where f.location_id = p_location_id::text
     and (f.id = p_table_id or lower(btrim(coalesce(f.label, ''))) = lower(btrim(p_table_id)))
   order by (f.id = p_table_id) desc
   limit 1;
  v_floor := coalesce(v_floor, p_table_id);

  select coalesce(jsonb_agg(x.item || jsonb_build_object('tab_pi', x.tab_pi)), '[]'::jsonb),
         count(distinct x.ref)::int,
         min(x.sent_at)
    into v_items, v_rounds, v_opened
    from (
      select q.ref, q.sent_at, q.customer ->> 'payment_intent_id' as tab_pi, e.item
        from public.order_queue q
        cross join lateral jsonb_array_elements(case when jsonb_typeof(q.items) = 'array' then q.items else '[]'::jsonb end) as e(item)
       where q.location_id = p_location_id::text
         and q.source = 'qr'
         and q.status <> 'collected'
         and q.customer ->> 'tableId' = p_table_id
    ) x;

  select * into v_existing
    from public.active_sessions a
   where a.location_id = p_location_id and a.table_id = v_floor
   for update skip locked;
  if not found and exists (select 1 from public.active_sessions a
                            where a.location_id = p_location_id and a.table_id = v_floor) then
    return;   -- a till is writing this table right now; the next order change catches up
  end if;

  if jsonb_array_length(v_items) = 0 then
    if v_existing.id is not null and coalesce(v_existing.session ->> 'source', '') = 'qr' then
      delete from public.active_sessions where id = v_existing.id;
    end if;
    return;
  end if;
  if v_existing.id is not null and coalesce(v_existing.session ->> 'source', '') <> 'qr' then
    return;   -- a till's own session on this table: never overwritten
  end if;

  select coalesce(sum(
           (public._fence_num(it ->> 'price')
            + coalesce((select sum(public._fence_num(m ->> 'price'))
                          from jsonb_array_elements(case when jsonb_typeof(it -> 'mods') = 'array' then it -> 'mods' else '[]'::jsonb end) m), 0))
           * greatest(1, public._fence_num(it ->> 'qty'))), 0)
    into v_subtotal
    from jsonb_array_elements(v_items) it;

  v_session := jsonb_build_object(
    'items', v_items, 'server', 'QR', 'source', 'qr', 'covers', 1,
    'openedAt', (extract(epoch from coalesce(v_opened, now())) * 1000)::bigint,
    'sentAt', (extract(epoch from now()) * 1000)::bigint,
    'subtotal', v_subtotal, 'total', v_subtotal, 'qr_tab_count', v_rounds);

  if v_existing.id is not null then
    update public.active_sessions set session = v_session, updated_at = now() where id = v_existing.id;
  else
    insert into public.active_sessions (location_id, table_id, session, updated_at)
    values (p_location_id, v_floor, v_session, now())
    on conflict (location_id, table_id) do nothing;
  end if;
end;
$fn$;
revoke all on function public._qr_sync_table_session(uuid, text) from public, anon, authenticated;

create or replace function public.order_queue_qr_floor_tg()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public.order_queue%rowtype;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  if v_row.source is distinct from 'qr' or coalesce(v_row.customer ->> 'tableId', '') = ''
     or not public._fence_is_uuid(v_row.location_id) then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.items is not distinct from old.items then
    return null;
  end if;
  begin
    perform public._qr_sync_table_session(v_row.location_id::uuid, v_row.customer ->> 'tableId');
  exception when others then
    null;   -- the floor plan must never break an order
  end;
  return null;
end;
$fn$;
revoke all on function public.order_queue_qr_floor_tg() from public, anon, authenticated;

do $public_grants$
declare
  f text;
begin
  -- Tracker and QR reads open on phones that may have no session: anon too.
  foreach f in array array['public.order_track_row(text, text, text)', 'public.order_track_check(text, text, text)',
                           'public.qr_table_open_tabs(text, text)', 'public.qr_tab_rounds(text, text)',
                           'public.qr_tab_join(text, text, text)', 'public.qr_table_tab_count(text, text)',
                           'public.catering_day_load(text, date)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;
  -- Writes need a session (anonymous sign in first).
  foreach f in array array['public.place_public_order(uuid, jsonb, jsonb, uuid[])',
                           'public.settle_qr_tab(uuid, text, jsonb, uuid[])'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end
$public_grants$;


-- ============================================================================
-- 8. Print agents get their own key (gap G24)
-- ============================================================================
-- print-agent.js and rpos-print-agent.js use the bare anon key with no session.
-- File 2 closes print_jobs, so they move to these functions with a key issued in
-- Back Office (contract C1, C2). On 16 Sep no venue ran an agent.
create or replace function public.issue_print_agent_token(p_location_id uuid, p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_token text;
  v_id    uuid;
begin
  if auth.uid() is null or public.is_anon_session()
     or not (public.is_super_admin() or p_location_id::text in (select public.user_accessible_locations())) then
    raise exception 'A Back Office login for this venue is needed' using errcode = '42501';
  end if;
  v_token := 'pa_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.print_agent_tokens (location_id, label, token_hash, created_by)
  values (p_location_id, left(p_label, 80), encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'token', v_token);
end;
$fn$;

create or replace function public.revoke_print_agent_token(p_token_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_loc uuid;
begin
  select location_id into v_loc from public.print_agent_tokens where id = p_token_id;
  if v_loc is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if auth.uid() is null or public.is_anon_session()
     or not (public.is_super_admin() or v_loc::text in (select public.user_accessible_locations())) then
    raise exception 'A Back Office login for this venue is needed' using errcode = '42501';
  end if;
  update public.print_agent_tokens set revoked_at = now() where id = p_token_id;
  return jsonb_build_object('ok', true);
end;
$fn$;

create or replace function public._print_agent_location(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_loc uuid;
begin
  if coalesce(p_token, '') = '' then return null; end if;
  if public._fence_is_locked('print_agent:global') then return null; end if;
  select t.location_id into v_loc
    from public.print_agent_tokens t
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and t.revoked_at is null;
  if v_loc is null then
    perform public._fence_count('print_agent:global', 200, interval '10 minutes', interval '10 minutes');
    return null;
  end if;
  update public.print_agent_tokens set last_used_at = now()
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return v_loc;
end;
$fn$;
revoke all on function public._print_agent_location(text) from public, anon, authenticated;

-- Claim up to p_limit jobs that are due at the agent's venue.
create or replace function public.print_agent_claim(p_token text, p_agent_id text, p_limit integer default 5, p_claim_seconds integer default 60)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_loc  uuid := public._print_agent_location(p_token);
  v_rows jsonb;
begin
  if v_loc is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_key');
  end if;
  with due as (
    select j.id
      from public.print_jobs j
     where j.location_id = v_loc
       and (j.claimed_by is null or j.claim_expires_at < now())
       and (j.status = 'pending' or (j.status = 'failed' and (j.next_retry_at is null or j.next_retry_at <= now())))
     order by j.created_at
     limit greatest(1, least(coalesce(p_limit, 5), 20))
     for update skip locked
  ), upd as (
    update public.print_jobs j
       set claimed_by = left(coalesce(p_agent_id, 'agent'), 80),
           claimed_at = now(),
           claim_expires_at = now() + make_interval(secs => greatest(10, least(coalesce(p_claim_seconds, 60), 600))),
           status = 'claimed'
      from due
     where j.id = due.id
    returning j.id, j.printer_id, j.printer_ip, j.printer_port, j.job_type, j.payload, j.attempts,
              j.idempotency_key, j.metadata, j.kind, j.created_at
  )
  select coalesce(jsonb_agg(to_jsonb(upd) order by upd.created_at), '[]'::jsonb) into v_rows from upd;
  return jsonb_build_object('ok', true, 'jobs', v_rows);
end;
$fn$;

-- Report the outcome of one job the agent claimed.
create or replace function public.print_agent_report(
  p_token text, p_job_id uuid, p_agent_id text, p_status text,
  p_attempts integer default null, p_error text default null, p_next_retry_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_loc uuid := public._print_agent_location(p_token);
  v_n   integer;
begin
  if v_loc is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_key');
  end if;
  if p_status not in ('sending', 'printed', 'done', 'failed', 'failed_permanent') then
    return jsonb_build_object('ok', false, 'reason', 'status');
  end if;
  update public.print_jobs j
     set status = p_status,
         attempts = coalesce(greatest(0, least(p_attempts, 100)), j.attempts),
         error = case when p_status like 'failed%' then left(p_error, 500) else null end,
         error_message = case when p_status like 'failed%' then left(p_error, 500) else null end,
         agent_id = left(coalesce(p_agent_id, j.agent_id), 80),
         next_retry_at = case when p_status = 'failed' then p_next_retry_at else null end,
         processed_at = case when p_status in ('printed', 'done', 'failed_permanent') then now() else j.processed_at end,
         printed_at = case when p_status in ('printed', 'done') then now() else j.printed_at end,
         claimed_by = case when p_status = 'sending' then j.claimed_by else null end,
         claim_expires_at = case when p_status = 'sending' then j.claim_expires_at else null end
   where j.id = p_job_id and j.location_id = v_loc;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1);
end;
$fn$;

do $agent_grants$
declare
  f text;
begin
  foreach f in array array['public.issue_print_agent_token(uuid, text)', 'public.revoke_print_agent_token(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- The agents run with the anon key and no session: the key IS the proof.
  foreach f in array array['public.print_agent_claim(text, text, integer, integer)',
                           'public.print_agent_report(text, uuid, text, text, integer, text, timestamp with time zone)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;
end
$agent_grants$;


-- ============================================================================
-- 9. The two busy tables, last (they are locked only for the end of the run)
-- ============================================================================
-- 9a. closed_checks accepts QR (gap G15). closed_checks_source_check had no 'qr', so
-- every QR paid check was refused and never reached reports. Widening a check cannot
-- break an existing row.
alter table public.closed_checks drop constraint if exists closed_checks_source_check;
alter table public.closed_checks add constraint closed_checks_source_check
  check (source = any (array['pos', 'kiosk', 'online', 'mobile', 'catering', 'hubrise', 'pax_table_pay',
                             'pos_send_to_terminal', 'adyen_pay_at_table', 'ezcater', 'qr']));

-- 9b. order_queue remembers which rows place_public_order wrote (file 2 checks that the
-- customer pages really use it before it closes the table).
alter table public.order_queue add column if not exists placed_via text;
comment on column public.order_queue.placed_via is '20260919a fence: rpc when place_public_order wrote the row; NULL for till, kiosk and server writes.';

reset lock_timeout;


-- ============================================================================
-- V. Verification (read only). The editor shows this last result.
-- ============================================================================
-- Expect: allow_all_left = active_sessions, kds_tickets, order_queue,
-- table_reservations (file 2 closes those); devices_kept and devices_to_pair match
-- the runbook; truncate_left = 0; profile_policy_left = 0; self_move_left = 0.
select
  (select string_agg(tablename, ', ' order by tablename) from pg_policies
    where schemaname = 'public' and policyname = 'allow all'
      and tablename in ('devices', 'organisations', 'locations', 'order_queue', 'kds_tickets',
                        'active_sessions', 'table_reservations', 'user_profiles', 'user_locations'))        as allow_all_left,
  (select count(*) from public.devices where bound_via is not null)                                           as devices_kept,
  (select string_agg(coalesce(l.name, 'no venue') || ': ' || d.name || ' (' || coalesce(d.type, '?') || ')', '; '
                     order by l.name, d.name)
     from public.devices d left join public.locations l on l.id = d.location_id
    where d.device_uid is null
      and d.id in (select device_id from public.device_claim_log where event = 'unbound_by_fence'))          as devices_to_pair,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))) as truncate_left,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'user_profiles'
      and policyname in ('Allow authenticated access', 'allow all'))                                          as profile_policy_left,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'user_locations'
      and policyname = 'ul_update_self')                                                                      as self_move_left,
  (select count(*) from public.devices where device_uid is not null and bound_via is null)                    as untrusted_links_left;

-- More checks you can paste one by one (all read only):
--
-- 1. Every policy now on the fenced identity tables:
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename in ('devices','organisations','locations','user_profiles','user_locations')
--  order by 1, 2;
--
-- 2. What happened to every device (one row each):
-- select l.name as venue, d.name, d.type, d.status, d.bound_via, d.last_seen,
--        (select event || ': ' || coalesce(detail, '') from public.device_claim_log g
--          where g.device_id = d.id order by g.at desc limit 1) as last_event
--   from public.devices d left join public.locations l on l.id = d.location_id
--  order by l.name, d.name;
--
-- 3. The trust test for a till still works (expect true, run as any bound till by
--    opening the till and checking tables still load). From the editor:
-- select count(*) from public.devices where bound_via is not null and status in ('active','online');
--
-- 4. The claim functions and who may call them (anon must be false):
-- select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('claim_device','claim_device_v2','reclaim_device','device_issue_secret',
--                      'issue_pairing_code','device_heartbeat','device_status','place_public_order',
--                      'settle_qr_tab','_device_claim_core','_fence_count')
--  order by 1;


-- ============================================================================
-- ROLL BACK (only if something is wrong; paste in the Ops SQL editor)
-- ============================================================================
-- It puts back the open policies. It does NOT put back pairing codes (they were
-- retired on purpose: issue new ones in Back Office) or links the fence removed from
-- old devices (pair those devices again).
--
-- set lock_timeout = '3s';
-- -- identity
-- create policy "Allow authenticated access" on public.user_profiles for all to public using (auth.role() = 'authenticated');
-- drop policy if exists up_select_scoped on public.user_profiles;
-- drop policy if exists up_update_scoped on public.user_profiles;
-- drop policy if exists up_insert_super_admin on public.user_profiles;
-- drop policy if exists up_delete_super_admin on public.user_profiles;
-- drop trigger if exists user_profiles_fence_guard on public.user_profiles;
-- create policy ul_update_self on public.user_locations for update to public
--   using ((user_id = auth.uid()) and (not is_anon_session())) with check ((user_id = auth.uid()) and (not is_anon_session()));
-- drop trigger if exists user_locations_fence_guard on public.user_locations;
-- create or replace function public.user_accessible_locations() returns setof text language sql stable security invoker
--   as $f$ select location_id::text from user_locations where user_id = auth.uid()
--          union select location_id::text from user_profiles where id = auth.uid() and location_id is not null; $f$;
-- alter function public.user_accessible_locations() reset search_path;
-- create or replace function public.user_accessible_orgs() returns setof text language sql stable security invoker
--   as $f$ select distinct l.org_id::text from locations l where l.id::text in (select public.user_accessible_locations()); $f$;
-- alter function public.user_accessible_orgs() reset search_path;
-- create or replace function public.can_claim_location(p_location_id uuid) returns boolean language sql stable
--   security definer set search_path to 'public' as $f$
--   select not public.is_anon_session()
--      and not exists (select 1 from public.user_locations ul where ul.location_id = p_location_id and ul.user_id is distinct from auth.uid())
--      and exists (select 1 from public.locations l join public.user_profiles up on up.id = auth.uid()
--                   where l.id = p_location_id and up.org_id is not null and l.org_id = up.org_id); $f$;
-- -- organisations and locations
-- create policy "allow all" on public.organisations for all to public using (true) with check (true);
-- create policy "allow all" on public.locations for all to public using (true) with check (true);
-- drop trigger if exists organisations_fence_guard on public.organisations;
-- drop trigger if exists locations_fence_guard on public.locations;
-- -- devices
-- create policy "allow all" on public.devices for all to public using (true) with check (true);
-- drop trigger if exists devices_fence_tg on public.devices;
-- drop index if exists public.devices_one_link_per_session;
-- create or replace function public.pos_can_access(p_loc text) returns boolean language plpgsql stable security definer
--   set search_path to 'public' as $f$ begin
--   if p_loc is null then return false; end if;
--   if p_loc in (select user_accessible_locations()) then return true; end if;
--   if exists (select 1 from public.devices d where d.device_uid = auth.uid() and d.status in ('active','online') and d.location_id::text = p_loc) then return true; end if;
--   return exists (select 1 from public.ops_devices o where o.device_uid = auth.uid() and o.active and o.location_id::text = p_loc);
--   end $f$;
-- create or replace function public.pos_can_access(p_loc uuid) returns boolean language plpgsql stable security definer
--   set search_path to 'public' as $f$ begin
--   if p_loc is null then return false; end if;
--   if p_loc::text in (select user_accessible_locations()) then return true; end if;
--   if exists (select 1 from public.devices d where d.device_uid = auth.uid() and d.status in ('active','online') and d.location_id = p_loc) then return true; end if;
--   return exists (select 1 from public.ops_devices o where o.device_uid = auth.uid() and o.active and o.location_id = p_loc);
--   end $f$;
-- grant insert, update, delete on table public.devices, public.organisations, public.locations,
--   public.user_locations, public.user_profiles to anon;
-- -- claim_device back to the live body of 13 Jul
-- create or replace function public.claim_device(p_code text) returns uuid language plpgsql security definer
--   set search_path to 'public' as $f$ declare v_loc uuid; v_id uuid; begin
--   if auth.uid() is null then raise exception 'no auth session'; end if;
--   select id, location_id into v_id, v_loc from public.devices where pairing_code = upper(trim(p_code)) and status <> 'removed' limit 1;
--   if v_id is null then return null; end if;
--   update public.devices set device_uid = auth.uid(), last_seen = now() where id = v_id;
--   return v_loc; end $f$;
-- grant execute on function public.claim_device(text) to anon, authenticated;
-- reset lock_timeout;
--
-- The new tables, columns and functions can stay: nothing calls them until the app
-- release. The closed_checks 'qr' value should stay (it is a fix).
