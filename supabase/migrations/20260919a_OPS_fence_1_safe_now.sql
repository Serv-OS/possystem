-- 20260919a_OPS_fence_1_safe_now.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  DATABASE FENCE, STAGE 1, FILE 1 OF 2 (Ops).                              #
-- #  ONLY AFTER the app release in docs/FENCE_STAGE_1_APP.md is on EVERY till #
-- #  (the runbook says how to check). Run it OUTSIDE SERVICE.                 #
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
-- WHY THE APP GOES FIRST: the live app (v5.9.8) can swap a till's login when a token
-- refresh fails on the network, and it pairs by reading the code off the devices table.
-- After this file neither works any more (codes are hidden, old codes are retired), so a
-- till still on the old app that loses its login stays unlinked with no banner. The
-- release never swaps a till's login, re-links with a device secret, and shows a red
-- banner with "Pair again" whenever a till is not linked.
--
-- WHAT THIS FILE CHANGES:
--   0. Guards: right project; STOPS if file 2 (20260919b) has already run; takes its
--      locks up front, busy tables first, so it can never deadlock with a till; 3 second
--      lock wait with a plain "press Run again" message.
--   1. Grants: TRUNCATE, REFERENCES, TRIGGER taken from anon and authenticated on
--      every table (and for future tables). The raw anon key (no login at all) loses
--      INSERT, UPDATE, DELETE on devices, organisations and locations.
--   2. Private support tables (no browser access at all): fence_state, fence_attempts
--      (throttles), device_claim_log, device_unlinked_pings, payment_proofs,
--      public_order_tokens, public_order_pending_checks, qr_tab_members,
--      print_agent_tokens.
--   3. Identity: venue access is user_locations only, plus every venue for a verified
--      super admin. user_profiles.location_id is only "the venue Back Office opens on".
--      Profiles are row scoped; teammates are logins linked to the same venue (a staff
--      record alone never reaches a login). A login can never move a venue link, change
--      its own company, or give itself Back Office access. A new venue can only be
--      claimed by the login that created it (created_by, written by the server).
--   4. organisations and locations: no more "allow all". Read rules unchanged for
--      venues (customer pages need them). Writes: the venue's own Back Office logins;
--      create: a real login inside a company it created; delete: super admin only.
--   5. devices: no more forged rows. Only Back Office adds, edits or removes a device.
--      A device's venue is PINNED: it moves only by super admin, or by a Back Office
--      login that manages BOTH venues, and a move always unlinks it (pair it again).
--      Only the claim functions link a device to a session. A linked till may only
--      touch its own heartbeat columns. pos_can_access() trusts a devices row only when
--      a claim bound it (bound_via is set). Pairing codes are made by the server (about
--      60 bits), last 60 minutes, are single use, and NOBODY but that venue's Back
--      Office and the super admin can read them. Every code issued before this file is
--      retired: an old code never links a till again. Wrong codes are throttled per
--      session; per network and platform wide counters refuse only wrong codes, never a
--      live one. Existing tills used in the last 14 days keep working (grandfathered)
--      and collect a device secret on their first check; the rest must be paired again.
--   6. New server functions the app release calls: claim_device_v2, reclaim_device,
--      device_issue_secret, issue_pairing_code, device_heartbeat, device_status,
--      place_public_order, verify_public_order_payment, confirm_public_order_payment,
--      settle_qr_tab, order_track_row, order_track_check, qr_table_open_tabs,
--      qr_tab_rounds, qr_tab_join, qr_table_tab_count, catering_day_load, print agent
--      functions.
--   7. closed_checks accepts source 'qr' (QR paid checks were silently refused), and
--      every order_queue row records who wrote it (placed_via: rpc, staff, server or
--      public), which file 2 checks before it closes the table.
--
-- WHAT IT DOES NOT CHANGE YET (file 2, 20260919b, a day after this file):
--   order_queue, kds_tickets, active_sessions, table_reservations keep "allow all";
--   print_jobs keeps its open policies; closed_checks keeps its open insert.
--
-- RULES OF THE FILE: no begin or commit (the SQL editor runs the whole paste as one
-- transaction, so any error means NOTHING changed and you can simply run it again);
-- every statement can run twice; functions are SECURITY DEFINER with search_path
-- pinned and EXECUTE only for the roles that need it; verification at the bottom;
-- roll back block in the comments at the very end.


-- ============================================================================
-- 0. Guards, locks, and the two busy tables first
-- ============================================================================
set lock_timeout = '3s';

do $guard$
declare
  v_file_b boolean := false;
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
  -- File 2 closes the orders and tables. Running this file again after it would put back
  -- things file 2 finished, so it refuses.
  if to_regclass('public.fence_state') is not null then
    execute 'select exists (select 1 from public.fence_state where key = ''file_b'')' into v_file_b;
  end if;
  if v_file_b
     or exists (select 1 from pg_policies where schemaname = 'public'
                 and policyname in ('order_queue_staff', 'kds_tickets_staff', 'closed_checks_insert_staff')) then
    raise exception 'STOPPED, NOTHING WAS CHANGED. File 2 (20260919b) has already run on this database, so this file must not run again. Nothing is wrong: there is nothing to do here.';
  end if;
end
$guard$;

-- 0b. Every lock this file needs, taken now, in one fixed order: the two busy tables a
-- till writes first, then the identity tables its policies read. A till always takes
-- them in that same order (the table it writes, then the identity tables), so the two
-- can never wait on each other in a circle (a deadlock). If a till holds one of them for
-- more than 3 seconds the file stops, changes nothing, and says so.
do $locks$
begin
  lock table public.closed_checks, public.order_queue, public.locations, public.organisations,
             public.user_profiles, public.user_locations, public.devices
    in access exclusive mode;
exception when lock_not_available then
  raise exception 'STOPPED, NOTHING WAS CHANGED. A till was busy with the orders or devices tables for more than 3 seconds. Wait 10 seconds and press Run again.';
end
$locks$;

-- 0c. closed_checks accepts QR (gap G15). closed_checks_source_check had no 'qr', so
-- every QR paid check was refused and never reached reports. Widening a check cannot
-- break an existing row.
alter table public.closed_checks drop constraint if exists closed_checks_source_check;
alter table public.closed_checks add constraint closed_checks_source_check
  check (source = any (array['pos', 'kiosk', 'online', 'mobile', 'catering', 'hubrise', 'pax_table_pay',
                             'pos_send_to_terminal', 'adyen_pay_at_table', 'ezcater', 'qr']));

-- 0d. order_queue remembers who wrote each row, set by the database, never by the
-- writer: 'rpc' (place_public_order), 'staff' (a linked till, kiosk or Back Office of
-- that venue), 'server' (an edge function, for example ezCater or HubRise) or 'public'
-- (anyone else, which today means an old customer page). File 2 refuses to close the
-- table while 'public' rows still arrive. It never changes once written.
alter table public.order_queue add column if not exists placed_via text;
comment on column public.order_queue.placed_via is
  '20260919a fence: who wrote the row, set by order_queue_placed_via: rpc (place_public_order), staff (linked device or Back Office of the venue), server (service role or the SQL editor) or public (anyone else). Never changes.';

create or replace function public.order_queue_placed_via_tg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if tg_op = 'UPDATE' then
    new.placed_via := old.placed_via;
    return new;
  end if;
  if coalesce(current_setting('servos.public_order', true), '') = 'on' then
    new.placed_via := 'rpc';
  elsif v_role not in ('anon', 'authenticated') then
    new.placed_via := 'server';
  else
    begin
      new.placed_via := case when public.pos_can_access(new.location_id) then 'staff' else 'public' end;
    exception when others then
      new.placed_via := 'public';
    end;
  end if;
  return new;
end;
$fn$;
revoke all on function public.order_queue_placed_via_tg() from public, anon, authenticated;

drop trigger if exists order_queue_placed_via on public.order_queue;
create trigger order_queue_placed_via
  before insert or update of placed_via on public.order_queue
  for each row execute function public.order_queue_placed_via_tg();


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
-- (On 18 Sep anon already had no INSERT, UPDATE or DELETE on user_locations and
-- user_profiles; revoking again is harmless, and the roll back does not give them.)
revoke insert, update, delete on table public.devices, public.organisations, public.locations,
  public.user_locations, public.user_profiles from anon;


-- ============================================================================
-- 2. Private support tables (service role and definer functions only)
-- ============================================================================

-- Which fence files have run (file 1 refuses to run again once file 2 has).
create table if not exists public.fence_state (
  key    text primary key,
  value  text,
  set_at timestamptz not null default now()
);
insert into public.fence_state (key, value) values ('file_a', '20260919a')
on conflict (key) do update set value = excluded.value, set_at = now();

-- Throttle buckets: wrong pairing codes, wrong tracking keys, wrong table codes,
-- public order spam. One row per bucket.
create table if not exists public.fence_attempts (
  bucket            text primary key,
  window_started_at timestamptz not null default now(),
  misses            integer not null default 0,
  locked_until      timestamptz,
  updated_at        timestamptz not null default now()
);

-- A running app that says "I am device X" while its session is NOT linked to X (the
-- heartbeat carries its local device id). File 2 refuses to run while a device that is
-- not linked was switched on in the last 24 hours (a till or kiosk that would take
-- money it can no longer save). Only real device ids are recorded.
create table if not exists public.device_unlinked_pings (
  device_id   uuid primary key references public.devices(id) on delete cascade,
  uid         uuid,
  last_at     timestamptz not null default now(),
  app_version text,
  caps        text[]
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

-- The paid check of a public order whose payment could not be proven yet (for example
-- the card processor's webhook was late). The order reaches the venue marked "payment
-- being checked"; verify_public_order_payment writes this check once a proof covers the
-- amount due, or confirm_public_order_payment when staff confirm it by hand.
create table if not exists public.public_order_pending_checks (
  location_id  text not null,
  ref          text not null,
  check_row    jsonb not null,
  due_minor    bigint not null,
  client_total numeric,
  payment_refs text[] not null default '{}',
  placed_by    uuid,
  created_at   timestamptz not null default now(),
  primary key (location_id, ref)
);

-- Phones that joined a QR tab with its table code (qr_tab_join), so their rounds are
-- accepted without sending the code again. The tab is named by an md5 of its card
-- payment id, never the id itself.
create table if not exists public.qr_tab_members (
  location_id text not null,
  pi_hash     text not null,
  uid         uuid not null,
  joined_at   timestamptz not null default now(),
  primary key (location_id, pi_hash, uid)
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
  foreach t in array array['fence_state', 'fence_attempts', 'device_unlinked_pings', 'device_claim_log',
                           'payment_proofs', 'public_order_tokens', 'public_order_pending_checks',
                           'qr_tab_members', 'print_agent_tokens'] loop
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

-- A code in the server format: 12 symbols from the alphabet _fence_random_code uses.
-- Every code issued before this file is retired, so anything else can never match: it
-- is a till re-sending an old saved code, not a guess, and is never counted as a miss.
create or replace function public._fence_is_server_code(p_norm text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $fn$
  select coalesce(p_norm, '') ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{12}$';
$fn$;

-- The caller's network address as the API gateway reports it (Cloudflare first). Used
-- only to scope throttles, never to grant anything. NULL when there is no request.
create or replace function public._fence_client_ip()
returns text
language plpgsql
stable
set search_path = pg_catalog
as $fn$
declare
  h jsonb;
begin
  begin
    h := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  exception when others then
    return null;
  end;
  return nullif(left(btrim(coalesce(h ->> 'cf-connecting-ip', h ->> 'x-real-ip',
                                    split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1))), 64), '');
end;
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
    'public._fence_is_server_code(text)', 'public._fence_client_ip()',
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

-- 4d. Teammates: logins LINKED (user_locations) to a venue the caller can manage in
-- Back Office. Used so the Staff screen can still show a teammate's email and switch
-- their Back Office access. A staff record (staff_members.auth_user_id) is never
-- trusted on its own: any till or owner can write one naming any login, so it would
-- reach logins at other venues. A real staff login always has a venue link too
-- (create-user makes one), so the Staff screen loses nothing.
create or replace function public.bo_teammate_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select ul.user_id
    from public.user_locations ul
   where ul.location_id::text in (select public.user_accessible_locations());
$fn$;

-- Logins whose Back Office access the caller may switch: teammates linked to a venue
-- where the caller is owner, or where the caller is manager and the teammate is not an
-- owner of any venue (Back Office access is one switch for the whole login). Again
-- only venue links count, never a staff record.
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
     and (me.role = 'owner'
          or (me.role = 'manager'
              and not exists (select 1 from public.user_locations o
                               where o.user_id = other.user_id and o.role = 'owner')));
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
  '20260919a fence: how device_uid was bound: code (a server pairing code from Back Office), secret (the device secret, reclaim_device), grandfathered (bound before the fence and used in the last 14 days). NULL = not trusted. Only the claim functions write it.';
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
-- Everything else loses its link:
--   * a row seen in the last 14 days at a venue (a till in use this week, for example
--     one signed in with a Back Office login that is not linked to that venue) becomes
--     'unpaired' ('awaiting_pairing' for a kiosk). With the release on it, that till
--     cannot read its row any more and shows the red "not linked" banner, keeps every
--     open table and unsent order, and is paired again with "Pair again" and a new code
--     (Back Office: "New pairing code"). It is never thrown to a blank pairing screen.
--   * everything older, or with no venue, becomes 'removed'.
-- Every pairing code on the table before this file was readable by anyone, so NONE is
-- kept, not even as a hash: a kept till re-links with its device secret (it collects
-- one on its first check with the release), never with an old code.
-- On 18 Sep (read only dry run, the runbook has the query): 10 kept, 13 to pair again.
-- Runs once per row: rows already handled (bound_via set) are skipped on a re-run.
do $grandfather$
declare
  r        record;
  v_keep   boolean;
  v_recent boolean;
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
    v_recent := r.location_id is not null and r.status in ('active', 'online')
                and r.seen_at is not null and r.seen_at > now() - interval '14 days';
    if v_keep then
      update public.devices
         set bound_via = 'grandfathered',
             bound_at = coalesce(r.paired_at, r.created_at, now()),
             pairing_code = null,
             pairing_expires_at = null
       where id = r.id;
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
             status = case when not v_recent then 'removed'
                           when r.type = 'kiosk' then 'awaiting_pairing' else 'unpaired' end,
             pairing_code = null, pairing_expires_at = null, session_token = null
       where id = r.id;
      insert into public.device_claim_log (device_id, location_id, event, old_uid, detail)
      values (r.id, r.location_id, 'unbound_by_fence', r.device_uid, v_reason);
    end if;
  end loop;

  -- Rows marked active or online that no till ever claimed (no link to keep): the
  -- same, so a till still using one is told to pair.
  for r in
    select d.id, d.location_id, d.type,
           greatest(d.last_seen, (select max(h.last_seen) from public.device_heartbeats h where h.device_id = d.id::text)) as seen_at
      from public.devices d
     where d.device_uid is null and d.status in ('active', 'online')
  loop
    v_recent := r.location_id is not null and r.seen_at is not null and r.seen_at > now() - interval '14 days';
    update public.devices
       set status = case when not v_recent then 'removed'
                         when r.type = 'kiosk' then 'awaiting_pairing' else 'unpaired' end,
           pairing_code = null, pairing_expires_at = null
     where id = r.id;
    insert into public.device_claim_log (device_id, location_id, event, detail)
    values (r.id, r.location_id, 'unbound_by_fence', 'marked active but never claimed by a till');
  end loop;

  -- Every other code issued before this file (no expiry means a browser made it, and
  -- anyone could read it): retired. Back Office issues a fresh one when that device is
  -- set up.
  update public.devices
     set pairing_code = null
   where pairing_code is not null and pairing_expires_at is null;

  perform set_config('servos.fence_bypass', 'off', true);
end
$grandfather$;

-- One physical till, one link.
create unique index if not exists devices_one_link_per_session
  on public.devices (device_uid)
  where device_uid is not null;

-- 6c. The trigger that guards devices for API callers and runs the pairing lifecycle.
-- THE VENUE IS PINNED (blocker 1 of the 18 Sep review: a login paired itself as a till,
-- then pointed its devices row at another venue and became staff there):
--   * device_uid, bound_via, bound_at, the secret and the caps are written ONLY by the
--     claim functions. Back Office and the super admin can only clear a link, never set
--     one. No caller can change a row's id (super admin excepted).
--   * location_id changes only for the super admin, or a Back Office login that manages
--     BOTH the old and the new venue, and a move always unlinks the device (pair it
--     again at the new venue). Whatever else the caller may do, including a real login
--     that is itself the linked till.
--   * a linked till writing its own row may change ONLY its heartbeat columns:
--     last_seen, app_version, status (active or online), session_token, kds_settings,
--     paired_at, and clearing its own pairing code. Everything else must stay as it is.
-- Every writer goes through this, whether it updates, upserts (insert on conflict do
-- update) or inserts: an insert never carries a link, and its venue must be one the
-- caller manages (policy devices_insert_bo).
create or replace function public.devices_fence_tg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_api     boolean := public._fence_api_role() in ('authenticated', 'anon');
  v_uid     uuid := auth.uid();
  v_admin   boolean := false;
  v_bo_old  boolean := false;
  v_bo_new  boolean := false;
  v_self    boolean := false;
  v_self_cols constant text[] := array['last_seen', 'app_version', 'status', 'session_token', 'kds_settings',
                                       'paired_at', 'pairing_code', 'pairing_expires_at'];
begin
  -- The claim functions set everything themselves.
  if public._fence_bypass() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    return old;   -- who may delete is the policy's job
  end if;

  if v_api then
    v_admin := public.is_super_admin();
    if tg_op = 'INSERT' then
      if v_uid is null or public.is_anon_session() then
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
      v_self := old.device_uid is not null and old.device_uid = v_uid and old.bound_via is not null;
      v_bo_old := v_uid is not null and not public.is_anon_session()
                  and old.location_id is not null
                  and old.location_id::text in (select public.user_accessible_locations());
      v_bo_new := v_uid is not null and not public.is_anon_session()
                  and new.location_id is not null
                  and new.location_id::text in (select public.user_accessible_locations());

      -- 1. Links are made only by the claim functions.
      if new.id is distinct from old.id and not v_admin then
        raise exception 'A device id cannot change' using errcode = '42501';
      end if;
      if new.device_uid is not null and new.device_uid is distinct from old.device_uid then
        raise exception 'A device is linked to a till only by pairing it with a code' using errcode = '42501';
      end if;
      if (new.bound_via is not null and new.bound_via is distinct from old.bound_via)
         or (new.bound_at is not null and new.bound_at is distinct from old.bound_at)
         or (new.device_secret_hash is not null and new.device_secret_hash is distinct from old.device_secret_hash)
         or (new.secret_issued_at is not null and new.secret_issued_at is distinct from old.secret_issued_at)
         or new.client_caps is distinct from old.client_caps
         or new.last_heartbeat_at is distinct from old.last_heartbeat_at then
        raise exception 'These device columns are written only by the pairing functions' using errcode = '42501';
      end if;

      -- 2. The venue is pinned.
      if new.location_id is distinct from old.location_id then
        if not (v_admin or (v_bo_old and v_bo_new)) then
          raise exception 'A device moves to another venue only in Back Office, by someone who manages both venues' using errcode = '42501';
        end if;
        insert into public.device_claim_log (device_id, location_id, event, old_uid, detail)
        values (old.id, old.location_id, 'unbound_moved_venue', old.device_uid,
                'moved to venue ' || coalesce(new.location_id::text, 'none') || ': pair it again there');
        new.device_uid := null;
        new.pairing_code := null;
        new.pairing_expires_at := null;
        new.session_token := null;
        new.status := case when new.type = 'kiosk' then 'awaiting_pairing' else 'unpaired' end;
      end if;

      -- 3. Everyone who is not Back Office of the device's venue: only the linked till
      -- itself, and only its heartbeat columns.
      if not v_admin and not v_bo_old then
        if not v_self then
          raise exception 'This device row belongs to another till' using errcode = '42501';
        end if;
        if (to_jsonb(new) - v_self_cols) is distinct from (to_jsonb(old) - v_self_cols)
           or (new.status is distinct from old.status and new.status not in ('active', 'online'))
           or (new.pairing_code is not null and new.pairing_code is distinct from old.pairing_code)
           or (new.pairing_expires_at is not null and new.pairing_expires_at is distinct from old.pairing_expires_at) then
          raise exception 'A till can only update its own heartbeat. Everything else is set in Back Office.' using errcode = '42501';
        end if;
      end if;
    end if;
  end if;

  -- Lifecycle, for every caller outside the claim functions.
  if new.pairing_code is not null
     and (tg_op = 'INSERT' or new.pairing_code is distinct from old.pairing_code) then
    -- A new code means "pair this again": it lasts 60 minutes and drops the old link.
    -- Only issue_pairing_code keeps its own code; any other code (an old Back Office tab
    -- that makes codes in the browser) is replaced by a server code, which that tab
    -- shows after a reload. So a code is always about 60 bits and never guessable.
    if coalesce(current_setting('servos.device_issue', true), '') = 'on' then
      new.pairing_code := upper(btrim(new.pairing_code));
    else
      new.pairing_code := public._device_gen_pairing_code();
    end if;
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
    new.client_caps := null;
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
           device_secret_hash = null, secret_issued_at = null, client_caps = null,
           status = case when status in ('active', 'online')
                         then case when type = 'kiosk' then 'awaiting_pairing' else 'unpaired' end
                         else status end
     where id = r.id;
    insert into public.device_claim_log (device_id, location_id, event, old_uid, detail)
    values (r.id, r.location_id, 'unbound_moved', p_uid, 'the same till was paired to another device row');
  end loop;
end;
$fn$;
revoke all on function public._device_unbind_others(uuid, uuid) from public, anon, authenticated;

-- A miss (wrong, expired or taken code): counted per session (6 in 10 minutes lock that
-- session for 15 minutes), per network (30 in 10 minutes) and platform wide (5000 in 10
-- minutes, a circuit breaker far above normal use, which is a handful a day). The
-- network and platform counters only ever turn away wrong codes: a live code on a free
-- device always pairs (gap G22 and the 18 Sep throttle finding). Returns true when the
-- caller should be told 'locked'.
create or replace function public._device_claim_miss(p_uid uuid, p_ip text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public._fence_count('claim:uid:' || p_uid::text, 6, interval '10 minutes', interval '15 minutes');
  if p_ip is not null then
    perform public._fence_count('claim:ip:' || p_ip, 30, interval '10 minutes', interval '15 minutes');
  end if;
  perform public._fence_count('claim:global', 5000, interval '10 minutes', interval '10 minutes');
  return public._fence_is_locked('claim:uid:' || p_uid::text)
      or (p_ip is not null and public._fence_is_locked('claim:ip:' || p_ip))
      or public._fence_is_locked('claim:global');
end;
$fn$;
revoke all on function public._device_claim_miss(uuid, text) from public, anon, authenticated;

-- The core. Refusals RETURN (never raise) so the miss counters are kept.
-- Order of checks:
--   1. the caller is already bound: idempotent (tills re-send their saved code on every
--      boot, gap B8), and v2 callers can collect a device secret;
--   2. this session is locked (6 misses in 10 minutes): refused, even a right code;
--   3. a code that is not in the server format can never match (every code issued
--      before this file was retired), so it is "not found" and NOT counted: that is a
--      till re-sending an old saved code, not a guess;
--   4. a live code on a free device: bind, clear the code (single use). Never refused by
--      the network or platform counters;
--   5. anything else is a miss.
-- There is NO re-link by an old code any more (18 Sep review): every code on the table
-- before this file was readable by anyone. A till whose login changed re-links with its
-- device secret (reclaim_device), or is paired again.
create or replace function public._device_claim_core(p_code text, p_mint_secret boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_norm    text := public._fence_norm_code(p_code);
  v_ip      text := public._fence_client_ip();
  v_own     public.devices%rowtype;
  v_row     public.devices%rowtype;
  v_secret  text := null;
  v_locked  boolean;
begin
  if v_uid is null then
    raise exception 'no auth session' using errcode = '28000';
  end if;
  perform set_config('servos.fence_bypass', 'on', true);

  select * into v_own
    from public.devices d
   where d.device_uid = v_uid and d.bound_via is not null and d.status in ('active', 'online')
   order by d.bound_at desc nulls last
   limit 1;

  if public._fence_is_server_code(v_norm) then
    select * into v_row
      from public.devices d
     where d.pairing_code is not null
       and public._fence_norm_code(d.pairing_code) = v_norm
       and d.status <> 'removed'
     limit 1
     for update;
  end if;

  -- 1. Already bound, and the code is its own, used, old or unknown: nothing to do.
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

  -- 2. This session made too many wrong tries.
  if public._fence_is_locked('claim:uid:' || v_uid::text) then
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_refusal('locked', 'Too many pairing attempts. Wait 15 minutes and try again.');
  end if;

  -- 3. An old code (not the server format): it was retired by this file. Not a guess.
  if not public._fence_is_server_code(v_norm) then
    insert into public.device_claim_log (event, new_uid, detail) values ('refused_old_code', v_uid, 'a code from before the fence');
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_refusal('not_found', 'That pairing code is no longer valid. Ask a manager for a new code from Back Office.');
  end if;

  -- 4. A live code on a free device: pair.
  if v_row.id is not null and v_row.device_uid is null
     and v_row.pairing_expires_at is not null and v_row.pairing_expires_at > now() then
    if p_mint_secret then
      v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    end if;
    perform public._device_unbind_others(v_uid, v_row.id);
    delete from public.device_unlinked_pings where uid = v_uid or device_id = v_row.id;
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
           client_caps        = null,
           device_secret_hash = case when v_secret is null then null else encode(sha256(convert_to(v_secret, 'UTF8')), 'hex') end,
           secret_issued_at   = case when v_secret is null then null else now() end
     where id = v_row.id;
    perform public._fence_clear('claim:uid:' || v_uid::text);
    insert into public.device_claim_log (device_id, location_id, event, new_uid, detail)
    values (v_row.id, v_row.location_id, 'bound', v_uid, 'paired with a Back Office code');
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_result(v_row.id, false, v_secret);
  end if;

  -- 5. A miss.
  v_locked := public._device_claim_miss(v_uid, v_ip);
  if v_row.id is null then
    insert into public.device_claim_log (event, new_uid, detail) values ('refused_not_found', v_uid, 'code not found');
  elsif v_row.device_uid is not null then
    insert into public.device_claim_log (device_id, location_id, event, old_uid, new_uid, detail)
    values (v_row.id, v_row.location_id, 'refused_already_paired', v_row.device_uid, v_uid, 'code of a till that is paired');
  else
    insert into public.device_claim_log (device_id, location_id, event, new_uid, detail)
    values (v_row.id, v_row.location_id, 'refused_expired', v_uid, 'code expired');
  end if;
  perform set_config('servos.fence_bypass', 'off', true);
  if v_locked then
    return public._device_claim_refusal('locked', 'Too many pairing attempts. Wait 15 minutes and try again.');
  end if;
  if v_row.id is null then
    return public._device_claim_refusal('not_found', 'Pairing code not found. Check the code in Back Office.');
  elsif v_row.device_uid is not null then
    return public._device_claim_refusal('already_paired', 'This device is already paired to another till. Issue a new code in Back Office to move it.');
  end if;
  return public._device_claim_refusal('expired', 'This pairing code has expired. Issue a new one in Back Office.');
end;
$fn$;
revoke all on function public._device_claim_core(text, boolean) from public, anon, authenticated;

-- Same name, arguments and return type as the live function, so an old WebView's boot
-- claim still gets its idempotent answer. NULL means "not paired".
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

-- For the app release (contract A3, A4): returns the device, its venue and a one time
-- device secret, or ok=false with a reason and a message to show.
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

-- Re-link with the device secret when the login changed (contract A2). A wrong
-- secret counts as a miss like a wrong code. The venue never changes: the secret re-links
-- the same row, at the same venue.
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
  delete from public.device_unlinked_pings where uid = v_uid or device_id = v.id;
  perform public._fence_clear(v_bucket);
  perform set_config('servos.fence_bypass', 'off', true);
  return public._device_claim_result(v.id, v.device_uid = v_uid, null);
end;
$fn$;

-- A till that is already bound (every grandfathered till) collects a device secret
-- on its first check with the release, so it never needs a pairing code again.
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

-- Back Office: issue a server code for a device you manage (contract A6). A device
-- that is paired right now is only moved when p_force is true (the Back Office asks
-- "this till will be disconnected" first). The code is readable by that venue's Back
-- Office and the super admin only (policy devices_read).
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

-- The running app reports itself (contract A10). The last_seen, version and what the
-- app can do are what file 2's release gate checks. p_device_id is the device id the
-- app has saved locally: when this session is NOT linked to it, the call is recorded in
-- device_unlinked_pings (only for a real device id), so file 2 can see a till or kiosk
-- that is switched on but no longer linked.
create or replace function public.device_heartbeat(p_app_version text default null, p_caps text[] default null,
                                                   p_device_id uuid default null)
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
    if p_device_id is not null then
      insert into public.device_unlinked_pings (device_id, uid, last_at, app_version, caps)
      select d.id, v_uid, now(), left(p_app_version, 40), p_caps[1:20]
        from public.devices d
       where d.id = p_device_id
      on conflict (device_id) do update
         set uid = excluded.uid, last_at = excluded.last_at,
             app_version = excluded.app_version, caps = excluded.caps;
    end if;
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
  delete from public.device_unlinked_pings where device_id = v.id;
  if p_device_id is not null and p_device_id <> v.id then
    -- The app thinks it is another device, which is not linked to this session (it
    -- shows the red banner): that device counts as switched on but unpaired.
    insert into public.device_unlinked_pings (device_id, uid, last_at, app_version, caps)
    select d.id, v_uid, now(), left(p_app_version, 40), p_caps[1:20]
      from public.devices d
     where d.id = p_device_id
    on conflict (device_id) do update
       set uid = excluded.uid, last_at = excluded.last_at,
           app_version = excluded.app_version, caps = excluded.caps;
  else
    delete from public.device_unlinked_pings where uid = v_uid;
  end if;
  return jsonb_build_object('bound', true, 'device_id', v.id, 'location_id', v.location_id,
                            'status', v.status, 'name', v.name, 'has_secret', v.device_secret_hash is not null);
end;
$fn$;

-- Read only: "am I still the paired till for my venue?" for the lapse banner (contract A7).
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
                           'public.issue_pairing_code(uuid, boolean)', 'public.device_heartbeat(text, text[], uuid)',
                           'public.device_status()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end
$claim_grants$;

-- 6g. devices policies. INSERT and DELETE: Back Office of that venue (or super admin).
-- UPDATE: the bound till on its own row (the trigger limits it to the heartbeat
-- columns), or Back Office of the device's venue (the trigger pins the venue).
-- SELECT (blocker 2 of the 18 Sep review): a pairing code is readable ONLY by the Back
-- Office of that venue and the super admin, ever. A row that holds a live code is hidden
-- from everyone else, tills of the same venue included (a code is a capability: whoever
-- reads it first can pair). Rows without a code: the till reads its own row and its
-- venue's devices (the status drawer lists the venue's KDS screens); nobody outside the
-- venue reads any row, so device ids and links stay private too. The release reads
-- nothing else: it pairs with claim_device_v2 alone, and treats a hidden own row as
-- "unknown", never as "removed" (contract A5). A till still on the OLD app cannot pair
-- after this file (its pairing screen looks the code up first): force stop and reopen
-- it so it loads the release.
alter table public.devices enable row level security;

drop policy if exists devices_read_interim on public.devices;
drop policy if exists devices_read on public.devices;
create policy devices_read on public.devices
  for select
  using ((pairing_code is null
          and (device_uid = (select auth.uid())
               or location_id in (select public.pos_accessible_location_ids())))
         or (not (select public.is_anon_session()) and location_id::text in (select public.user_accessible_locations()))
         or (select public.is_super_admin()));

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
-- customer's name, phone, email, address or card ids.

-- 7a. The order tracker. p_key is the tracking token from place_public_order (128 bits),
-- the tab's card payment id (QR), or the last 4 digits of the phone (old share links).
-- Only the guessable last 4 path is throttled: 10 wrong tries per order per hour lock
-- that order's last 4 path for an hour (gap G6), and a platform wide breaker far above
-- normal use (20000 in 10 minutes) turns away only last 4 guesses. A token or payment id
-- always works, so nobody can lock a customer out of their own tracker.
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
  select * into v_q from public.order_queue q where q.location_id = p_location_id and q.ref = p_ref;
  if v_q.ref is not null then
    if exists (select 1 from public.public_order_tokens t
                where t.location_id = p_location_id and t.ref = p_ref and t.token = p_key) then
      return true;
    end if;
    if length(p_key) >= 12
       and (coalesce(v_q.customer ->> 'payment_intent_id', '') = p_key
            or coalesce(v_q.customer ->> 'payment_ref', '') = p_key) then
      return true;
    end if;
  end if;
  if length(v_digits) = 4 and length(p_key) <= 8 then
    if public._fence_is_locked(v_bucket) or public._fence_is_locked('track:last4:global') then
      return false;
    end if;
    if v_q.ref is not null
       and right(regexp_replace(coalesce(v_q.customer ->> 'phone', ''), '\D', '', 'g'), 4) = v_digits then
      return true;
    end if;
    perform public._fence_count('track:last4:global', 20000, interval '10 minutes', interval '5 minutes');
  end if;
  perform public._fence_count(v_bucket, 10, interval '1 hour', interval '1 hour');
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
-- 4 phone digits, so 'phone' carries only those. payment_state 'checking' means the
-- venue is still confirming the payment (the page says so, never "unpaid").
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
             'payment_state', q.customer ->> 'payment_state',
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
-- tab without revealing the payment id, the table code or any name (gap G4). A tab is
-- the set of open QR rows with tab_open true and the same card payment id; a pay now
-- order never counts as a round of anyone's tab (18 Sep review: a public order could
-- carry another tab's payment id and add itself to that tab).
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

-- Is this session the tab's opener, or a phone that joined it with the table code?
create or replace function public._qr_tab_is_member(p_location_id text, p_pi text, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select p_uid is not null and (
         exists (select 1 from public.qr_tab_members m
                  where m.location_id = p_location_id and m.pi_hash = md5(p_pi) and m.uid = p_uid)
      or exists (select 1
                   from public.order_queue q
                   join public.public_order_tokens t on t.location_id = q.location_id and t.ref = q.ref
                  where q.location_id = p_location_id and q.source = 'qr'
                    and public._fence_bool(q.customer ->> 'tab_open')
                    and q.customer ->> 'payment_intent_id' = p_pi
                    and coalesce(q.customer ->> 'tab_ref', q.ref) = q.ref
                    and t.placed_by = p_uid));
$fn$;
revoke all on function public._qr_tab_is_member(text, text, uuid) from public, anon, authenticated;

-- The tab and its rounds, for a caller who has proven the tab (internal). The tab block
-- carries the fields the close path needs (gap G16): payment id, processor, Stripe
-- account, Ryft ids, saved card id, hold amount, tab ref. The table code is included
-- only for the tab's opener and its members (p_with_code): anyone else holding the
-- payment id must not learn the code that lets a phone add rounds.
create or replace function public._qr_tab_payload(p_location_id text, p_pi text, p_with_code boolean)
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
       and public._fence_bool(q.customer ->> 'tab_open')
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
              'tab_join_code', case when p_with_code then (select max(x.customer ->> 'tab_join_code') from r x) end,
              'has_join_code', exists (select 1 from r x where coalesce(x.customer ->> 'tab_join_code', '') <> ''),
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
revoke all on function public._qr_tab_payload(text, text, boolean) from public, anon, authenticated;

-- The tab's owner, who holds its card payment id (their own stash). The table code
-- comes back only to the opener's session or a member.
create or replace function public.qr_tab_rounds(p_location_id text, p_payment_intent_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select case when coalesce(p_payment_intent_id, '') = '' then null
              else public._qr_tab_payload(p_location_id, p_payment_intent_id,
                                          public._qr_tab_is_member(p_location_id, p_payment_intent_id, auth.uid())) end;
$fn$;

-- Another phone at the table, with the table code the owner shared (gap G5).
-- 8 wrong codes per tab per hour lock that tab for an hour. A tab with no code (old
-- tabs) cannot be joined by phone; staff can add to it or close it. A phone that joins
-- with a session is remembered as a member, so its rounds need no code again.
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
     and public._fence_bool(q.customer ->> 'tab_open')
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
  if auth.uid() is not null then
    insert into public.qr_tab_members (location_id, pi_hash, uid)
    values (p_location_id, md5(v_pi), auth.uid())
    on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true) || public._qr_tab_payload(p_location_id, v_pi, true);
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
--   * "paid" is decided by the SERVER (18 Sep review: a 95 pound order with a check
--     total of 1p and a 1p card proof came back paid). The server works out the amount
--     due as the largest of: the order total staff see on the till, the check total,
--     and the value of the order's own lines (price plus options, times quantity)
--     less the discounts the order declares (declared discounts are written on the
--     order for staff to see). Paid means the verified money (card and gift card
--     proofs, read from the processor or our ledger by the payment-proof edge
--     function) covers that amount. A loyalty reward is a discount, never money: it
--     lowers the line value only when a loyalty redemption proof is attached. A bill
--     of zero needs a gift or loyalty proof. The paid check books the verified card
--     amount, never a number the phone sent;
--   * without proof the order still reaches the venue (money may have been taken), but
--     UNPAID and marked payment_state 'checking' (the till shows "Payment being
--     checked", never "unpaid"), with its paid check kept aside until
--     verify_public_order_payment proves it or staff confirm it
--     (confirm_public_order_payment);
--   * a QR tab (open or a new round) needs a preauth proof for its card payment id, and
--     a new round is accepted only from the tab's opener, a phone that joined it with
--     the table code, or a round that carries the code (18 Sep review: rounds could be
--     added to someone else's tab). The table code is minted here (gap G5);
--   * a card payment id stays on a pay now order only when it is the order's own proven
--     payment, so no order can pose as part of another customer's tab;
--   * nothing the customer sends can set staff, the venue, the status, paid, or a
--     server field. Numbers that are not numbers become 0 (gaps G10, G11).

-- The value of the lines, worked out the way the tills and customer pages do: (price
-- plus the price of each option) times quantity, voided lines left out. In pence.
create or replace function public._public_order_goods_minor(p_items jsonb)
returns bigint
language sql
immutable
set search_path = public
as $fn$
  select coalesce(sum(round(
           (public._fence_num(it ->> 'price')
            + coalesce((select sum(public._fence_num(m ->> 'price'))
                          from jsonb_array_elements(case when jsonb_typeof(it -> 'mods') = 'array' then it -> 'mods' else '[]'::jsonb end) m), 0))
           * (case when public._fence_num(it ->> 'qty') > 0 then least(public._fence_num(it ->> 'qty'), 999) else 1 end)
           * 100)), 0)::bigint
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) it
   where jsonb_typeof(it) = 'object'
     and not public._fence_bool(it ->> 'voided');
$fn$;

-- The discounts an order declares, in pence: p_order.discounts when the page sends
-- them ([{type, label, amount_minor}] for the release), else the check's discounts
-- (auto discounts carry value, a catering promo carries amount, both in pounds). A
-- loyalty discount counts only with a loyalty redemption proof, and never above that
-- proof's money value when the proof carries one.
create or replace function public._public_order_discount_minor(p_order jsonb, p_check jsonb, p_loyalty_ok boolean, p_loyalty_cap bigint)
returns bigint
language plpgsql
immutable
set search_path = public
as $fn$
declare
  v_list   jsonb := '[]'::jsonb;
  v_sum    bigint := 0;
  v_amt    bigint;
  v_listed boolean := false;
  e        jsonb;
begin
  if jsonb_typeof(p_order -> 'discounts') = 'array' then
    v_list := p_order -> 'discounts';
  elsif p_check is not null and jsonb_typeof(p_check -> 'discounts') = 'array' then
    v_list := p_check -> 'discounts';
  end if;
  for e in select x from jsonb_array_elements(v_list) as t(x) loop
    continue when jsonb_typeof(e) <> 'object';
    v_amt := case when e ? 'amount_minor' then round(public._fence_num(e ->> 'amount_minor'))::bigint
                  else round(public._fence_num(coalesce(e ->> 'amount', e ->> 'value')) * 100)::bigint end;
    v_amt := greatest(0, least(v_amt, 10000000));
    if lower(coalesce(e ->> 'type', '')) = 'loyalty' then
      v_listed := true;
      continue when not p_loyalty_ok;
      if p_loyalty_cap > 0 then v_amt := least(v_amt, p_loyalty_cap); end if;
    end if;
    v_sum := v_sum + v_amt;
  end loop;
  if not v_listed and p_loyalty_ok and p_check is not null and jsonb_typeof(p_check -> 'loyalty') = 'object' then
    v_amt := greatest(0, least(round(public._fence_num(p_check -> 'loyalty' ->> 'discount_value'))::bigint, 10000000));
    if p_loyalty_cap > 0 then v_amt := least(v_amt, p_loyalty_cap); end if;
    v_sum := v_sum + v_amt;
  end if;
  return v_sum;
end;
$fn$;

-- The payment references a check names (card payment ids, gift and loyalty ledger
-- keys). verify_public_order_payment finds a late proof by them.
create or replace function public._public_order_payment_refs(p_check jsonb, p_pi text)
returns text[]
language sql
immutable
set search_path = public
as $fn$
  select coalesce(array_agg(distinct x) filter (where coalesce(x, '') <> ''), '{}'::text[])
    from (
      select p_check ->> 'stripe_payment_intent_id' as x
      union all select p_pi
      union all select p_check -> 'gift_card' ->> 'idempotency_key'
      union all select p_check -> 'loyalty' ->> 'idempotency_key'
      union all select e ->> 'id'
        from jsonb_array_elements(case when jsonb_typeof(p_check -> 'payment_intents') = 'array' then p_check -> 'payment_intents' else '[]'::jsonb end) e
      union all select l ->> 'idempotency_key'
        from jsonb_array_elements(case when jsonb_typeof(p_check -> 'gift_card' -> 'legs') = 'array' then p_check -> 'gift_card' -> 'legs' else '[]'::jsonb end) l
    ) refs;
$fn$;

-- The closed check of a public order, built from what the page sent but with every
-- server field forced. id, total, status and closed_at are added when it is written.
create or replace function public._public_order_check_row(p_loc text, p_ref text, p_source text, p_type text,
                                                          p_check jsonb, p_items jsonb, p_customer jsonb)
returns jsonb
language sql
stable
set search_path = public
as $fn$
  select jsonb_build_object(
      'id', left(coalesce(nullif(btrim(p_check ->> 'id'), ''), 'chk-' || p_source || '-' || p_ref), 80),
      'ref', p_ref,
      'location_id', p_loc,
      'table_id', left(p_check ->> 'table_id', 80),
      'table_label', left(p_check ->> 'table_label', 80),
      'staff_name', null,
      'items', case when jsonb_typeof(p_check -> 'items') = 'array' then p_check -> 'items' else p_items end,
      'subtotal', round(public._fence_num(p_check ->> 'subtotal'), 2),
      'tax', round(public._fence_num(p_check ->> 'tax'), 2),
      'payment_method', left(p_check ->> 'payment_method', 200),
      'covers', greatest(1, least(99, public._fence_num(p_check ->> 'covers')::int)),
      'voided', false,
      'refunded', false,
      'server', left(coalesce(nullif(p_check ->> 'server', ''), initcap(p_source)), 40),
      'order_type', left(coalesce(nullif(p_check ->> 'order_type', ''), p_type), 40),
      'customer', case when jsonb_typeof(p_check -> 'customer') = 'object'
                       then (p_check -> 'customer') - 'paid' - 'staff' - 'payment_state' - 'payment_unverified'
                            - 'payment_confirmed_by' - 'order_pricing' - 'placed_via'
                       else p_customer end,
      'discounts', case when jsonb_typeof(p_check -> 'discounts') = 'array' then p_check -> 'discounts' else '[]'::jsonb end,
      'service', round(public._fence_num(p_check ->> 'service'), 2),
      'tip', round(public._fence_num(p_check ->> 'tip'), 2),
      'method', left(coalesce(nullif(p_check ->> 'method', ''), 'card'), 40),
      'refunds', '[]'::jsonb,
      'tax_breakdown', case when jsonb_typeof(p_check -> 'tax_breakdown') = 'array' then p_check -> 'tax_breakdown' else '[]'::jsonb end,
      'tax_amount', case when p_check ? 'tax_amount' and p_check ->> 'tax_amount' is not null
                         then round(public._fence_num(p_check ->> 'tax_amount'), 2) end,
      'source', p_source,
      'gift_card', case when jsonb_typeof(p_check -> 'gift_card') = 'object' then p_check -> 'gift_card' end,
      'loyalty', case when jsonb_typeof(p_check -> 'loyalty') = 'object' then p_check -> 'loyalty' end,
      'promo', case when jsonb_typeof(p_check -> 'promo') = 'object' then p_check -> 'promo' end,
      'stripe_payment_intent_id', left(p_check ->> 'stripe_payment_intent_id', 120),
      'payment_intents', case when jsonb_typeof(p_check -> 'payment_intents') = 'array' then p_check -> 'payment_intents' end,
      'processor', case when p_check ->> 'processor' in ('stripe', 'ryft', 'adyen') then p_check ->> 'processor' else 'stripe' end,
      'customer_phone', left(p_check ->> 'customer_phone', 40),
      'closed_at_wanted', p_check ->> 'closed_at');
$fn$;

-- Write a public order's paid check: total = the verified card amount (in pence). A
-- catering check keeps the event time as its sales date (the old catering page did
-- this), within a year ahead; every other check is dated now.
create or replace function public._public_order_write_check(p_cc jsonb, p_total_minor bigint, p_extra_customer jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id     text := left(coalesce(nullif(p_cc ->> 'id', ''), 'chk-' || coalesce(p_cc ->> 'ref', 'public')), 80);
  v_closed timestamptz := now();
  v_want   timestamptz;
  v_row    jsonb;
begin
  if p_cc ->> 'source' = 'catering' then
    begin
      v_want := nullif(p_cc ->> 'closed_at_wanted', '')::timestamptz;
    exception when others then
      v_want := null;
    end;
    if v_want is not null and v_want > now() - interval '1 day' and v_want < now() + interval '400 days' then
      v_closed := v_want;
    end if;
  end if;
  if exists (select 1 from public.closed_checks c where c.id = v_id) then
    v_id := left(v_id, 75) || '-' || public._fence_random_code(4);
  end if;
  v_row := (p_cc - 'closed_at_wanted')
           || jsonb_build_object('id', v_id, 'total', round(greatest(0, p_total_minor) / 100.0, 2),
                                 'status', 'paid', 'closed_at', v_closed);
  if coalesce(p_extra_customer, '{}'::jsonb) <> '{}'::jsonb then
    v_row := jsonb_set(v_row, '{customer}', coalesce(v_row -> 'customer', '{}'::jsonb) || p_extra_customer);
  end if;
  insert into public.closed_checks
  select * from jsonb_populate_record(null::public.closed_checks, v_row);
  return v_id;
end;
$fn$;

do $order_helper_grants$
declare
  f text;
begin
  foreach f in array array['public._public_order_goods_minor(jsonb)',
                           'public._public_order_discount_minor(jsonb, jsonb, boolean, bigint)',
                           'public._public_order_payment_refs(jsonb, text)',
                           'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)',
                           'public._public_order_write_check(jsonb, bigint, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end
$order_helper_grants$;

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
  v_raw         jsonb := case when jsonb_typeof(p_order -> 'customer') = 'object' then p_order -> 'customer' else '{}'::jsonb end;
  v_customer    jsonb;
  v_items       jsonb := case when jsonb_typeof(p_order -> 'items') = 'array' then p_order -> 'items' else '[]'::jsonb end;
  v_total       numeric := round(public._fence_num(p_order ->> 'total'), 2);
  v_type        text := left(coalesce(nullif(p_order ->> 'type', ''), 'collection'), 40);
  v_check       jsonb := case when jsonb_typeof(p_check) = 'object' then p_check end;
  v_ip          text := public._fence_client_ip();
  v_tab         boolean;
  v_pi          text;
  v_proof_ids   uuid[] := coalesce(p_proof_ids, '{}'::uuid[]);
  v_card_minor  bigint := 0;
  v_gift_minor  bigint := 0;
  v_loyal_n     integer := 0;
  v_loyal_cap   bigint := 0;
  v_card_refs   text[] := '{}'::text[];
  v_goods_minor bigint := 0;
  v_disc_minor  bigint := 0;
  v_floor_minor bigint := 0;
  v_due_minor   bigint := 0;
  v_paid        boolean := false;
  v_unverified  boolean := false;
  v_status      text;
  v_token       text;
  v_join        text := null;
  v_tab_ref     text;
  v_check_id    text := null;
  v_sent_at     timestamptz;
  v_event_date  date;
  v_existing    public.public_order_tokens%rowtype;
  v_first       public.order_queue%rowtype;
  v_hold        public.payment_proofs%rowtype;
  v_code_given  text;
  v_bucket      text;
  v_cc          jsonb;
  v_pay_ref     text;
  v_processor   text;
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
      return (select jsonb_build_object('ok', true, 'idempotent', true, 'ref', v_ref, 'paid', q.paid,
                                        'status', q.status,
                                        'payment_unverified', coalesce(q.customer ->> 'payment_state', '') = 'checking',
                                        'track_token', v_existing.token,
                                        'tab_join_code', q.customer ->> 'tab_join_code')
                from public.order_queue q where q.location_id = v_loc and q.ref = v_ref);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'ref_taken');
  end if;
  if exists (select 1 from public.order_queue q where q.location_id = v_loc and q.ref = v_ref) then
    return jsonb_build_object('ok', false, 'reason', 'ref_taken');
  end if;

  if jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 200 or pg_column_size(v_items) > 262144 then
    return jsonb_build_object('ok', false, 'reason', 'items');
  end if;
  if pg_column_size(v_raw) > 32768 then
    return jsonb_build_object('ok', false, 'reason', 'customer');
  end if;
  if v_total < 0 or v_total > 100000 then
    return jsonb_build_object('ok', false, 'reason', 'total');
  end if;
  if public._fence_is_locked('order:uid:' || v_uid::text) then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many orders from this device. Please wait a few minutes.');
  end if;

  -- Server fields a phone must never set, on any order. Tab fields and the card payment
  -- id are put back below only where the server has checked them.
  v_customer := v_raw - 'paid' - 'payment_verified' - 'payment_unverified' - 'payment_state' - 'payment_ref'
                      - 'payment_processor' - 'payment_confirmed_by' - 'payment_confirmed_note'
                      - 'payment_verified_at' - 'order_pricing' - 'tab_join_code' - 'staff' - 'placed_via'
                      - 'tab_open' - 'tab_ref' - 'round_ref' - 'tab_opened_at' - 'pre_auth_amount'
                      - 'tab_running_total' - 'payment_intent_id';
  v_tab := v_source = 'qr' and public._fence_bool(v_raw ->> 'tab_open');
  v_pi := nullif(left(btrim(coalesce(v_raw ->> 'payment_intent_id', '')), 200), '');

  -- Money proofs named by the caller: this venue, not used before, and not a payment
  -- the processor says belongs to another order.
  perform 1 from public.payment_proofs p where p.id = any(v_proof_ids) for update;
  select coalesce(sum(p.amount_minor) filter (where p.kind = 'card'), 0),
         coalesce(sum(p.amount_minor) filter (where p.kind = 'gift'), 0),
         (count(*) filter (where p.kind = 'loyalty'))::int,
         coalesce(sum(p.amount_minor) filter (where p.kind = 'loyalty' and p.amount_minor > 1), 0),
         coalesce(array_agg(p.payment_ref) filter (where p.kind = 'card'), '{}'::text[])
    into v_card_minor, v_gift_minor, v_loyal_n, v_loyal_cap, v_card_refs
    from public.payment_proofs p
   where p.id = any(v_proof_ids)
     and p.location_id = v_loc
     and p.kind in ('card', 'gift', 'loyalty')
     and p.used_by_ref is null
     and p.verified_at > now() - interval '24 hours'
     and coalesce(p.meta ->> 'order_ref', v_ref) = v_ref;

  if v_tab then
    -- A QR tab: the card hold must be proven by the server.
    if v_pi is null then
      return jsonb_build_object('ok', false, 'reason', 'tab_not_verified',
                                'message', 'We could not confirm the card hold for this tab. Please ask a member of staff.');
    end if;
    select * into v_hold
      from public.payment_proofs p
     where p.kind = 'preauth' and p.payment_ref = v_pi and p.location_id = v_loc
     order by p.verified_at desc
     limit 1
     for update;
    if v_hold.id is null then
      return jsonb_build_object('ok', false, 'reason', 'tab_not_verified',
                                'message', 'We could not confirm the card hold for this tab. Please ask a member of staff.');
    end if;
    -- A hold that was already captured is a closed tab: no new rounds on it.
    if exists (select 1 from public.payment_proofs p
                where p.kind = 'capture' and p.payment_ref = v_pi and p.location_id = v_loc) then
      return jsonb_build_object('ok', false, 'reason', 'tab_closed',
                                'message', 'This tab is already closed. Please start a new order.');
    end if;
    select * into v_first
      from public.order_queue q
     where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
       and public._fence_bool(q.customer ->> 'tab_open')
       and q.customer ->> 'payment_intent_id' = v_pi
     order by q.created_at
     limit 1;
    if v_first.ref is not null then
      -- A new round on an open tab: only the tab's opener, a phone that joined it with
      -- the table code, or a round that carries the code.
      select max(q.customer ->> 'tab_join_code') into v_join
        from public.order_queue q
       where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
         and public._fence_bool(q.customer ->> 'tab_open')
         and q.customer ->> 'payment_intent_id' = v_pi;
      if not public._qr_tab_is_member(v_loc, v_pi, v_uid) then
        v_bucket := 'join:' || v_loc || ':' || md5(v_pi);
        if public._fence_is_locked(v_bucket) then
          return jsonb_build_object('ok', false, 'reason', 'locked', 'message', 'Too many wrong codes. Ask a member of staff.');
        end if;
        v_code_given := nullif(public._fence_norm_code(coalesce(p_order ->> 'tab_join_code', v_raw ->> 'tab_join_code')), '');
        if v_code_given is null or coalesce(v_join, '') = '' or v_code_given <> public._fence_norm_code(v_join) then
          if v_code_given is not null then
            perform public._fence_count(v_bucket, 8, interval '1 hour', interval '1 hour');
          end if;
          return jsonb_build_object('ok', false, 'reason', 'tab_not_yours',
                                    'message', 'Ask the person who opened this tab for the table code.');
        end if;
        insert into public.qr_tab_members (location_id, pi_hash, uid)
        values (v_loc, md5(v_pi), v_uid)
        on conflict do nothing;
      end if;
      v_tab_ref := coalesce(v_first.customer ->> 'tab_ref', v_first.ref);
      v_customer := v_customer || jsonb_build_object('tab_opened_at',
                      coalesce(v_first.customer ->> 'tab_opened_at', v_first.created_at::text));
    else
      -- Opening a tab. The hold must have been checked in the last 30 minutes (the
      -- phone asks for the proof just before it places the first round) and must not
      -- have opened another tab already (a tab whose rounds were all collected).
      if v_hold.used_by_ref is not null then
        return jsonb_build_object('ok', false, 'reason', 'tab_closed',
                                  'message', 'This tab is already closed. Please start a new order.');
      end if;
      if v_hold.verified_at < now() - interval '30 minutes' then
        return jsonb_build_object('ok', false, 'reason', 'tab_not_verified',
                                  'message', 'We could not confirm the card hold for this tab. Please try again.');
      end if;
      update public.payment_proofs set used_by_ref = v_loc || ':' || v_ref, used_at = now() where id = v_hold.id;
      v_join := public._fence_random_digits(6);
      v_tab_ref := v_ref;
      v_customer := v_customer || jsonb_build_object('tab_opened_at', now());
    end if;
    v_customer := v_customer || jsonb_build_object(
                    'tab_open', true, 'payment_intent_id', v_pi, 'tab_join_code', v_join,
                    'tab_ref', v_tab_ref, 'round_ref', v_ref,
                    'pre_auth_amount', round(v_hold.amount_minor / 100.0, 2));
    v_paid := false;
    v_status := 'prep';
  else
    -- QR has no pay later: a QR order is either paid now or a round of a tab. Online
    -- always pays too; an online order that arrives without its check (the page could
    -- not build it) is treated as paid now with an empty check, so it is proven or
    -- checked like any other. Only catering has pay later.
    if v_check is null and v_source = 'qr' then
      return jsonb_build_object('ok', false, 'reason', 'payment', 'message', 'Please pay for your order to send it.');
    end if;
    if v_check is null and v_source = 'online' then
      v_check := '{}'::jsonb;
    end if;
    -- The card payment id stays only when it is this order's own proven payment.
    if v_pi is not null and v_pi = any(v_card_refs) then
      v_customer := v_customer || jsonb_build_object('payment_intent_id', v_pi);
    end if;
    v_goods_minor := public._public_order_goods_minor(v_items);
    v_disc_minor := least(v_goods_minor, public._public_order_discount_minor(p_order, v_check, v_loyal_n > 0, v_loyal_cap));
    v_floor_minor := greatest(0, v_goods_minor - v_disc_minor - (jsonb_array_length(v_items) + 2));
    v_due_minor := greatest(round(v_total * 100)::bigint,
                            case when v_check is not null
                                 then round(greatest(0, public._fence_num(v_check ->> 'total')) * 100)::bigint else 0 end,
                            v_floor_minor);
    if v_check is not null then
      if v_due_minor > 0 then
        v_paid := (v_card_minor + v_gift_minor) >= v_due_minor;
      else
        v_paid := (v_card_minor + v_gift_minor) > 0 or v_loyal_n > 0;
      end if;
      v_unverified := not v_paid;
      v_status := case when v_paid and v_source <> 'catering' then 'prep' else 'received' end;
      -- Money may have been taken: never refused for the venue, but one network can
      -- only send so many orders it cannot prove.
      if v_unverified and v_ip is not null and public._fence_is_locked('order:unproven:ip:' || v_ip) then
        return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many orders from this network. Please ask a member of staff.');
      end if;
    else
      -- Catering pay later: no money taken, so the venue collects it later.
      v_paid := false;
      v_status := 'received';
      if (v_ip is not null and public._fence_is_locked('order:later:ip:' || v_ip))
         or public._fence_is_locked('order:later:loc:' || v_loc) then
        return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many orders right now. Please try again in a few minutes.');
      end if;
    end if;
    v_customer := v_customer || jsonb_build_object('order_pricing', jsonb_build_object(
                    'goods_minor', v_goods_minor, 'discount_minor', v_disc_minor,
                    'due_minor', v_due_minor, 'proven_minor', v_card_minor + v_gift_minor));
  end if;

  if v_check is not null then
    v_cc := public._public_order_check_row(v_loc, v_ref, v_source, v_type, v_check, v_items, v_customer);
    v_pay_ref := coalesce(nullif(v_check ->> 'stripe_payment_intent_id', ''),
                          case when jsonb_typeof(v_check -> 'payment_intents') = 'array'
                               then nullif(v_check -> 'payment_intents' -> 0 ->> 'id', '') end,
                          v_pi);
    v_processor := case when coalesce(v_check ->> 'processor', v_raw ->> 'processor') in ('stripe', 'ryft', 'adyen')
                        then coalesce(v_check ->> 'processor', v_raw ->> 'processor') end;
  end if;
  if v_unverified then
    v_customer := v_customer || jsonb_strip_nulls(jsonb_build_object(
                    'payment_unverified', true, 'payment_state', 'checking',
                    'payment_ref', left(v_pay_ref, 200), 'payment_processor', v_processor));
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

  perform set_config('servos.public_order', 'on', true);
  insert into public.order_queue
    (ref, location_id, type, customer, items, total, status, staff, sent_at, collection_time, is_asap,
     source, paid, payment_method, event_date)
  values
    (v_ref, v_loc, v_type, v_customer, v_items, v_total, v_status, null, v_sent_at,
     left(nullif(p_order ->> 'collection_time', ''), 40), public._fence_bool(p_order ->> 'is_asap'),
     v_source, v_paid, case when v_paid then left(coalesce(nullif(p_order ->> 'payment_method', ''), 'card'), 40) else null end,
     v_event_date);
  perform set_config('servos.public_order', 'off', true);

  if v_paid and v_check is not null then
    v_check_id := public._public_order_write_check(v_cc, least(v_card_minor, v_due_minor), '{}'::jsonb);
    update public.payment_proofs
       set used_by_ref = v_loc || ':' || v_ref, used_at = now()
     where id = any(v_proof_ids) and location_id = v_loc
       and kind in ('card', 'gift', 'loyalty') and used_by_ref is null
       and coalesce(meta ->> 'order_ref', v_ref) = v_ref;
  elsif v_check is not null then
    insert into public.public_order_pending_checks
      (location_id, ref, check_row, due_minor, client_total, payment_refs, placed_by)
    values
      (v_loc, v_ref, v_cc, v_due_minor, round(public._fence_num(v_check ->> 'total'), 2),
       public._public_order_payment_refs(v_check, v_pi), v_uid)
    on conflict (location_id, ref) do nothing;
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '');
  insert into public.public_order_tokens (location_id, ref, token, placed_by, paid)
  values (v_loc, v_ref, v_token, v_uid, v_paid);

  perform public._fence_count('order:uid:' || v_uid::text, 30, interval '10 minutes', interval '10 minutes');
  if v_unverified and v_ip is not null then
    perform public._fence_count('order:unproven:ip:' || v_ip, 60, interval '10 minutes', interval '10 minutes');
  end if;
  if not v_tab and v_check is null then
    if v_ip is not null then
      perform public._fence_count('order:later:ip:' || v_ip, 20, interval '10 minutes', interval '10 minutes');
    end if;
    perform public._fence_count('order:later:loc:' || v_loc, 200, interval '10 minutes', interval '10 minutes');
  end if;

  return jsonb_build_object('ok', true, 'ref', v_ref, 'paid', v_paid, 'status', v_status,
                            'payment_unverified', v_unverified, 'track_token', v_token,
                            'tab_join_code', v_join, 'check_id', v_check_id,
                            'due_minor', case when v_tab then null else v_due_minor end);
end;
$fn$;

-- 7e. A public order whose payment was being checked. verify_public_order_payment is
-- called by the page that placed it (retrying while the processor catches up) or by a
-- till or Back Office of the venue ("Check payment" after payment-proof wrote the
-- proof). It counts the proofs named plus any proof of the payments the order's check
-- names; when they cover the amount due it writes the paid check (the verified card
-- amount), marks the order paid and the state 'verified'. Nothing else about the order
-- changes (the till moves it on as usual).
create or replace function public.verify_public_order_payment(p_location_id uuid, p_ref text, p_proof_ids uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_loc      text := p_location_id::text;
  v_q        public.order_queue%rowtype;
  v_pend     public.public_order_pending_checks%rowtype;
  v_ids      uuid[];
  v_card     bigint := 0;
  v_gift     bigint := 0;
  v_loyal    integer := 0;
  v_paid     boolean;
  v_check_id text;
  v_pi       text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;
  select * into v_q from public.order_queue q where q.location_id = v_loc and q.ref = p_ref for update;
  if v_q.ref is null
     or not (exists (select 1 from public.public_order_tokens t
                      where t.location_id = v_loc and t.ref = p_ref and t.placed_by = v_uid)
             or public.pos_can_access(v_loc) or public.is_super_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_q.paid then
    return jsonb_build_object('ok', true, 'paid', true, 'already', true);
  end if;
  select * into v_pend from public.public_order_pending_checks c
   where c.location_id = v_loc and c.ref = p_ref for update;
  if v_pend.ref is null then
    return jsonb_build_object('ok', false, 'reason', 'no_check',
                              'message', 'This order was not paid online. Take the payment on the till.');
  end if;
  select coalesce(array_agg(p.id), '{}'::uuid[]) into v_ids
    from public.payment_proofs p
   where p.location_id = v_loc
     and p.kind in ('card', 'gift', 'loyalty')
     and p.used_by_ref is null
     and p.verified_at > now() - interval '7 days'
     and coalesce(p.meta ->> 'order_ref', p_ref) = p_ref
     and (p.id = any(coalesce(p_proof_ids, '{}'::uuid[])) or p.payment_ref = any(v_pend.payment_refs));
  perform 1 from public.payment_proofs p where p.id = any(v_ids) for update;
  select coalesce(sum(p.amount_minor) filter (where p.kind = 'card'), 0),
         coalesce(sum(p.amount_minor) filter (where p.kind = 'gift'), 0),
         (count(*) filter (where p.kind = 'loyalty'))::int,
         max(p.payment_ref) filter (where p.kind = 'card')
    into v_card, v_gift, v_loyal, v_pi
    from public.payment_proofs p
   where p.id = any(v_ids);
  v_paid := case when v_pend.due_minor > 0 then (v_card + v_gift) >= v_pend.due_minor
                 else (v_card + v_gift) > 0 or v_loyal > 0 end;
  if not v_paid then
    return jsonb_build_object('ok', true, 'paid', false, 'due_minor', v_pend.due_minor,
                              'proven_minor', v_card + v_gift,
                              'message', 'The payment is not confirmed yet.');
  end if;
  v_check_id := public._public_order_write_check(v_pend.check_row, least(v_card, v_pend.due_minor),
                                                 jsonb_build_object('payment_verified_at', now()));
  update public.payment_proofs set used_by_ref = v_loc || ':' || p_ref, used_at = now() where id = any(v_ids);
  update public.order_queue
     set paid = true,
         payment_method = coalesce(payment_method, left(coalesce(nullif(v_pend.check_row ->> 'method', ''), 'card'), 40)),
         customer = (customer - 'payment_unverified')
                    || jsonb_build_object('payment_state', 'verified', 'payment_verified_at', now())
                    || case when source = 'qr' and v_pi is not null and v_pi = customer ->> 'payment_ref'
                            then jsonb_build_object('payment_intent_id', v_pi) else '{}'::jsonb end
   where location_id = v_loc and ref = p_ref;
  update public.public_order_tokens set paid = true where location_id = v_loc and ref = p_ref;
  delete from public.public_order_pending_checks where location_id = v_loc and ref = p_ref;
  return jsonb_build_object('ok', true, 'paid', true, 'check_id', v_check_id);
end;
$fn$;

-- Staff of the venue saw the money (for example in the card processor's dashboard) but
-- no proof arrived. Writes the kept check as paid for the card amount the order still
-- needed, and records who confirmed it and why. Tills and Back Office of the venue only,
-- never the customer.
create or replace function public.confirm_public_order_payment(p_location_id uuid, p_ref text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_loc      text := p_location_id::text;
  v_q        public.order_queue%rowtype;
  v_pend     public.public_order_pending_checks%rowtype;
  v_gift     bigint := 0;
  v_check_id text;
begin
  if v_uid is null or not (public.pos_can_access(v_loc) or public.is_super_admin()) then
    raise exception 'Only staff of this venue can confirm a payment' using errcode = '42501';
  end if;
  select * into v_q from public.order_queue q where q.location_id = v_loc and q.ref = p_ref for update;
  if v_q.ref is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_q.paid then
    return jsonb_build_object('ok', true, 'paid', true, 'already', true);
  end if;
  select * into v_pend from public.public_order_pending_checks c
   where c.location_id = v_loc and c.ref = p_ref for update;
  if v_pend.ref is null then
    return jsonb_build_object('ok', false, 'reason', 'no_check',
                              'message', 'This order was not paid online. Take the payment on the till.');
  end if;
  select coalesce(sum(p.amount_minor), 0) into v_gift
    from public.payment_proofs p
   where p.location_id = v_loc and p.kind = 'gift' and p.used_by_ref is null
     and p.payment_ref = any(v_pend.payment_refs);
  v_check_id := public._public_order_write_check(
                  v_pend.check_row, greatest(0, v_pend.due_minor - v_gift),
                  jsonb_strip_nulls(jsonb_build_object('payment_confirmed_by', v_uid, 'payment_confirmed_at', now(),
                                                       'payment_confirmed_note', left(p_note, 200))));
  update public.order_queue
     set paid = true,
         payment_method = coalesce(payment_method, left(coalesce(nullif(v_pend.check_row ->> 'method', ''), 'card'), 40)),
         customer = (customer - 'payment_unverified')
                    || jsonb_strip_nulls(jsonb_build_object('payment_state', 'confirmed_by_staff',
                                                            'payment_confirmed_by', v_uid,
                                                            'payment_confirmed_note', left(p_note, 200)))
   where location_id = v_loc and ref = p_ref;
  update public.public_order_tokens set paid = true where location_id = v_loc and ref = p_ref;
  delete from public.public_order_pending_checks where location_id = v_loc and ref = p_ref;
  insert into public.device_claim_log (location_id, event, new_uid, detail)
  values (p_location_id, 'payment_confirmed_by_staff', v_uid, left('order ' || p_ref || coalesce(': ' || p_note, ''), 300));
  return jsonb_build_object('ok', true, 'paid', true, 'check_id', v_check_id);
end;
$fn$;

-- 7f. Closing a QR tab from the customer's phone after the card was captured
-- (gap G17: only after a capture the server has seen). Marks the tab's rounds
-- collected and writes one closed check for what was really taken; a shortfall is
-- recorded for staff, never booked as paid. Only rounds of that tab (tab_open) count.
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
     and public._fence_bool(q.customer ->> 'tab_open')
     and q.customer ->> 'payment_intent_id' = p_payment_intent_id
   for update;
  select array_agg(q.ref order by q.created_at) into v_refs
    from public.order_queue q
   where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
     and public._fence_bool(q.customer ->> 'tab_open')
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

-- 7g. QR tabs on the floor plan, worked out on the server from the open QR rounds
-- (gap G17: no public function writes active_sessions). Only ever writes or deletes a
-- session whose source is 'qr', so a till's own session on that table is never
-- touched (tables must never be lost). Only rounds of an open tab and paid pay now
-- orders count: an order whose payment is still being checked never puts a guest on
-- the floor plan. If a till is writing that table's row it waits up to 2 seconds for
-- it (a till's write takes milliseconds), so a closed tab does not stay on the floor
-- as a ghost. File 2 attaches it as a trigger on order_queue, when the phone's own sync
-- (src/lib/qrTableSession.js) is gone.
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
  v_timeout  text;
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
         and (q.paid or public._fence_bool(q.customer ->> 'tab_open'))
    ) x;

  v_timeout := current_setting('lock_timeout');
  perform set_config('lock_timeout', '2s', true);
  begin
    select * into v_existing
      from public.active_sessions a
     where a.location_id = p_location_id and a.table_id = v_floor
     for update;
  exception when lock_not_available then
    perform set_config('lock_timeout', v_timeout, true);
    raise notice 'QR floor sync skipped table % at %: a till held it for 2 seconds', v_floor, p_location_id;
    return;
  end;
  perform set_config('lock_timeout', v_timeout, true);

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
           * (case when public._fence_num(it ->> 'qty') > 0 then least(public._fence_num(it ->> 'qty'), 999) else 1 end)), 0)
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
  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.items is not distinct from old.items
     and new.paid is not distinct from old.paid then
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
  -- Writes need a session (anonymous sign in first). confirm_public_order_payment checks
  -- inside that the caller is staff of the venue.
  foreach f in array array['public.place_public_order(uuid, jsonb, jsonb, uuid[])',
                           'public.settle_qr_tab(uuid, text, jsonb, uuid[])',
                           'public.verify_public_order_payment(uuid, text, uuid[])',
                           'public.confirm_public_order_payment(uuid, text, text)'] loop
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
-- Back Office (contract G1 to G3). On 16 Sep no venue ran an agent.
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

-- A key is 256 random bits, so a wrong key can never be guessed into a right one, and
-- a right key ALWAYS works: no platform wide lock that one caller could trip to stop
-- every venue's agents (18 Sep review). Wrong keys are only counted, for review.
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
  select t.location_id into v_loc
    from public.print_agent_tokens t
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and t.revoked_at is null;
  if v_loc is null then
    perform public._fence_count('print_agent:bad_keys', 1000000000, interval '1 day', interval '1 second');
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


reset lock_timeout;


-- ============================================================================
-- V. Verification (read only). The editor shows this last result.
-- ============================================================================
-- Expect: allow_all_left = active_sessions, kds_tickets, order_queue, table_reservations
-- (file 2 closes those); devices_kept about 10 and to_pair_in_use / removed as the
-- runbook's pre-check listed them; codes_readable_by_strangers = false;
-- truncate_left = 0; profile_policy_left = 0; self_move_left = 0;
-- untrusted_links_left = 0; placed_via_trigger = true.
select
  (select string_agg(tablename, ', ' order by tablename) from pg_policies
    where schemaname = 'public' and policyname = 'allow all'
      and tablename in ('devices', 'organisations', 'locations', 'order_queue', 'kds_tickets',
                        'active_sessions', 'table_reservations', 'user_profiles', 'user_locations'))        as allow_all_left,
  (select count(*) from public.devices where bound_via is not null)                                           as devices_kept,
  (select string_agg(coalesce(l.name, 'no venue') || ': ' || d.name || ' (' || coalesce(d.type, '?') || ')', '; '
                     order by l.name, d.name)
     from public.devices d left join public.locations l on l.id = d.location_id
    where d.device_uid is null and d.status in ('unpaired', 'awaiting_pairing')
      and d.id in (select device_id from public.device_claim_log where event = 'unbound_by_fence'))          as to_pair_in_use,
  (select count(*) from public.devices d
    where d.status = 'removed'
      and d.id in (select device_id from public.device_claim_log where event = 'unbound_by_fence'))          as removed_not_used,
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'devices'
           and cmd in ('SELECT', 'ALL') and btrim(coalesce(qual, '')) = 'true')                             as codes_readable_by_strangers,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))) as truncate_left,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'user_profiles'
      and policyname in ('Allow authenticated access', 'allow all'))                                          as profile_policy_left,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'user_locations'
      and policyname = 'ul_update_self')                                                                      as self_move_left,
  (select count(*) from public.devices where device_uid is not null and bound_via is null)                    as untrusted_links_left,
  exists (select 1 from pg_trigger where tgname = 'order_queue_placed_via' and not tgisinternal)             as placed_via_trigger;

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
-- 3. Kept tills that have not collected their device secret yet (expect this to empty
--    within a minute of each till being switched on):
-- select l.name as venue, d.name, d.type, d.last_seen
--   from public.devices d left join public.locations l on l.id = d.location_id
--  where d.bound_via is not null and d.device_secret_hash is null order by 1, 2;
--
-- 4. The claim functions and who may call them (anon must be false):
-- select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('claim_device','claim_device_v2','reclaim_device','device_issue_secret',
--                      'issue_pairing_code','device_heartbeat','device_status','place_public_order',
--                      'verify_public_order_payment','confirm_public_order_payment',
--                      'settle_qr_tab','_device_claim_core','_fence_count')
--  order by 1;


-- ============================================================================
-- ROLL BACK (only if something is wrong; paste in the Ops SQL editor)
-- ============================================================================
-- Remove the "-- " at the start of each line, paste, Run. It puts back exactly the
-- policies, functions and write grants this file changed (as they were on 18 Sep),
-- and can run twice. It does NOT put back pairing codes (they were retired on purpose:
-- issue new ones in Back Office) or links the fence removed from old devices (pair
-- those devices again). TRUNCATE, REFERENCES and TRIGGER are not given back (nothing
-- uses them). The new tables, columns and functions stay: nothing needs them gone.
--
-- set lock_timeout = '3s';
-- -- identity
-- drop policy if exists up_select_scoped on public.user_profiles;
-- drop policy if exists up_update_scoped on public.user_profiles;
-- drop policy if exists up_insert_super_admin on public.user_profiles;
-- drop policy if exists up_delete_super_admin on public.user_profiles;
-- drop policy if exists "Allow authenticated access" on public.user_profiles;
-- create policy "Allow authenticated access" on public.user_profiles for all to public using (auth.role() = 'authenticated');
-- drop trigger if exists user_profiles_fence_guard on public.user_profiles;
-- drop policy if exists ul_update_self on public.user_locations;
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
-- drop policy if exists organisations_select on public.organisations;
-- drop policy if exists organisations_insert on public.organisations;
-- drop policy if exists organisations_update on public.organisations;
-- drop policy if exists organisations_delete on public.organisations;
-- drop policy if exists "allow all" on public.organisations;
-- drop policy if exists "Allow authenticated access" on public.organisations;
-- create policy "allow all" on public.organisations for all to public using (true) with check (true);
-- create policy "Allow authenticated access" on public.organisations for all to public using (auth.role() = 'authenticated');
-- drop policy if exists locations_read on public.locations;
-- drop policy if exists locations_update on public.locations;
-- drop policy if exists locations_insert on public.locations;
-- drop policy if exists locations_delete on public.locations;
-- drop policy if exists "allow all" on public.locations;
-- drop policy if exists "Allow authenticated access" on public.locations;
-- drop policy if exists "Users can update own location settings" on public.locations;
-- create policy "allow all" on public.locations for all to public using (true) with check (true);
-- create policy "Allow authenticated access" on public.locations for all to public using (auth.role() = 'authenticated');
-- create policy "Users can update own location settings" on public.locations for update to public
--   using (id in (select user_profiles.location_id from user_profiles where user_profiles.id = auth.uid()))
--   with check (id in (select user_profiles.location_id from user_profiles where user_profiles.id = auth.uid()));
-- drop trigger if exists organisations_fence_guard on public.organisations;
-- drop trigger if exists locations_fence_guard on public.locations;
-- -- devices
-- drop policy if exists devices_read on public.devices;
-- drop policy if exists devices_insert_bo on public.devices;
-- drop policy if exists devices_update_own_or_bo on public.devices;
-- drop policy if exists devices_delete_bo on public.devices;
-- drop policy if exists "allow all" on public.devices;
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
-- -- the raw anon key had INSERT, UPDATE and DELETE on these three only (user_locations and
-- -- user_profiles never had them, so they are not given)
-- grant insert, update, delete on table public.devices, public.organisations, public.locations to anon;
-- -- claim_device back to the live body of 13 Jul
-- create or replace function public.claim_device(p_code text) returns uuid language plpgsql security definer
--   set search_path to 'public' as $f$ declare v_loc uuid; v_id uuid; begin
--   if auth.uid() is null then raise exception 'no auth session'; end if;
--   select id, location_id into v_id, v_loc from public.devices where pairing_code = upper(trim(p_code)) and status <> 'removed' limit 1;
--   if v_id is null then return null; end if;
--   update public.devices set device_uid = auth.uid(), last_seen = now() where id = v_id;
--   return v_loc; end; $f$;
-- grant execute on function public.claim_device(text) to anon, authenticated;
-- -- order_queue: the who-wrote-it stamp stops (the column stays)
-- drop trigger if exists order_queue_placed_via on public.order_queue;
-- reset lock_timeout;
--
-- The closed_checks 'qr' value stays (it is a fix).
