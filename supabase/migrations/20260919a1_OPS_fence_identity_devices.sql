-- 20260919a1_OPS_fence_identity_devices.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  DATABASE FENCE, STAGE 1, FILE A1: IDENTITY, VENUES AND DEVICES.          #
-- #  ONLY AFTER 20260919_OPS_fence_0_caps.sql (step 1b) and the app release in #
-- #  docs/FENCE_STAGE_1_APP.md are live on EVERY till. The file checks that    #
-- #  itself and stops while any device switched on in the last 2 hours has     #
-- #  not reported the release. Run it OUTSIDE SERVICE.                         #
-- #  Peter pastes it into the Ops SQL editor and presses Run. Claude never    #
-- #  runs it. The runbook is docs/FENCE_STAGE_1.md (runbook one).             #
-- ############################################################################
--
-- THE SPLIT (20 Sep 2026). This file and 20260919a2_OPS_fence_public_orders.sql are the two
-- halves of what used to be one file, 20260919a_OPS_fence_1_after_release.sql. Peter asked for
-- the split so the biggest holes close now instead of waiting for the payment rules to finish.
-- Not a line of either half's rules changed in the cut. This half stands on its own: a2 refuses
-- to run until it is in, and file 2 (20260919b) still counts its full day from THIS file.
--
-- WHAT THIS HALF CLOSES: a stranger holding the public app key can no longer delete a company
-- or its venues, forge a till and become staff of any venue, read or reuse pairing codes, move
-- their own login into a venue, give themselves Back Office access, or TRUNCATE a table.
--
-- WHAT IT DOES NOT CLOSE YET: online, QR and catering orders still decide their own price and
-- their own "paid", because that is the other half (20260919a2). Until a2 is in, the customer
-- pages carry on exactly as they do today, through the same direct writes, and the order tables
-- keep their open rules until file 2 (20260919b).
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
--   0. Guards: right project; STOPS if file 2 (20260919b) has already run; STOPS while any
--      device switched on in the last 2 hours has not reported the app release (the test is the
--      capability the app itself records, client_caps 'fence_v1', or a device secret it already
--      holds, NOT a version string, because 5.9.10 and 5.9.11 both shipped without a line of the
--      fence app and every till would have sailed through); takes its locks up front, busy
--      tables first; 3 second lock wait with a plain "press Run again" message. It also
--      remembers when it first ran: file 2 refuses to run until a full day later. It needs
--      20260919_OPS_fence_0_caps.sql (runbook step 1b, which goes out with the release so the
--      app can record its capability) and says so if it is missing.
--   1. Grants: TRUNCATE, REFERENCES, TRIGGER taken from anon and authenticated on
--      every table (and for future tables). The raw anon key (no login at all) loses
--      INSERT, UPDATE, DELETE on devices, organisations and locations.
--   2. Private support tables (no browser access at all): fence_state, fence_attempts
--      (throttles), device_claim_log, device_unlinked_pings, device_secret_stash,
--      payment_proofs, public_order_tokens, public_order_pending_checks, qr_tab_members,
--      print_agent_tokens. The four order tables are created here, empty and private, so
--      a2 has them waiting and nothing has to be created while orders are running.
--   3. Small internal helpers, callable only by the fence's own functions (numbers, codes,
--      throttles, the venue clock, and the menu price helpers a2 uses).
--   4. Identity: venue access is user_locations only, plus every venue for a verified
--      super admin. user_profiles.location_id is only "the venue Back Office opens on".
--      Profiles are row scoped; teammates are logins linked to the same venue (a staff
--      record alone never reaches a login). A login can never move a venue link, change
--      its own company, or give itself Back Office access. A new venue can only be
--      claimed by the login that created it (created_by, written by the server).
--   5. organisations and locations: no more "allow all". Read rules unchanged for
--      venues (customer pages need them). Writes: the venue's own Back Office logins;
--      create: a real login inside a company it created; delete: super admin only.
--   6. devices: no more forged rows. Only Back Office adds, edits or removes a device.
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
--      New functions the release calls: claim_device_v2, reclaim_device,
--      device_issue_secret, issue_pairing_code, device_heartbeat, device_status.
--   7. closed_checks accepts source 'qr' (QR paid checks were silently refused), and
--      every order_queue row records who wrote it (placed_via: rpc, staff, server or
--      public), which file 2 checks before it closes the table.
--   8. Print agents get their own key, so the bare anon key is no longer a print agent.
--
-- WHAT IT DOES NOT CHANGE (the other two files):
--   20260919a2: what a customer order is worth and whether it is paid, the QR tab functions,
--   the tracker, and the rules on discount_rules and stamp_transactions.
--   20260919b, a full day after THIS file: order_queue, kds_tickets, active_sessions,
--   table_reservations keep "allow all"; print_jobs keeps its open policies; closed_checks
--   keeps its open insert.
--
-- RULES OF THE FILE: no begin or commit (the SQL editor runs the whole paste as one
-- transaction, so any error means NOTHING changed and you can simply run it again);
-- every statement can run twice; functions are SECURITY DEFINER with search_path
-- pinned and EXECUTE only for the roles that need it; verification at the bottom;
-- roll back block in the comments at the very end (its heading says how to run it).

-- ============================================================================
-- 0. Guards, locks, and the two busy tables first
-- ============================================================================
set local lock_timeout = '3s';

do $guard$
declare
  v_file_b  boolean := false;
  v_caps    boolean := false;
  v_n       integer;
  v_list    text;
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

  -- The app release must be on every device that is switched on (runbook step 2): an old app
  -- cannot pair or re-link once this file has run, so a device left behind is stranded with no
  -- way back. THE TEST IS WHAT THE APP ITSELF RECORDED, NOT A VERSION STRING (fix round 3, 19
  -- Sep): the old check compared app_version with a constant, and 5.9.10 and 5.9.11 both
  -- shipped without a line of the fence app, so every till on the floor sailed through it. A
  -- device is ready only when
  --   * its row carries the capability the release reports (client_caps 'fence_v1'), which is
  --     exactly what file 2 (20260919b) asks for, or
  --   * it already holds a device secret, which only this file's own functions hand out (so a
  --     re-run never strands a till that was kept the first time).
  -- Those two columns come from 20260919_OPS_fence_0_caps.sql, which goes out WITH the release
  -- (runbook step 1b) so the app can write to them before this file exists. Without it no
  -- device can prove anything and this file stops, saying so.
  -- A device counts as switched on when it was seen in the last 2 hours, on its own row
  -- (last_seen) or through the heartbeat tills send every few seconds (device_heartbeats,
  -- which also catches a Sunmi till that has run for days without a restart). The version it
  -- reports is printed with it, so you can see which build is on the floor.
  -- Only devices rows count. A device_heartbeats row with no devices row behind it was never
  -- paired, so this file cannot strand it, and anyone with the public key can write one, so one
  -- must not be able to hold this file shut either.
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'devices' and column_name = 'client_caps')
         and exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'devices' and column_name = 'device_secret_hash')
    into v_caps;
  if not v_caps then
    raise exception 'STOPPED, NOTHING WAS CHANGED. Run 20260919_OPS_fence_0_caps.sql first (runbook step 1b, with the app release), then leave every till, KDS, kiosk and clock switched on for two minutes so each one reports the new app. Until that file is in, no device can prove it runs the release and this file cannot tell a stranded till from a safe one.';
  end if;

  execute $q$
    with seen as (
      select coalesce(l.name, 'no venue') as venue, d.name as device, coalesce(d.type, '?') as dtype,
             case when h.last_seen is not null and (d.last_seen is null or h.last_seen >= d.last_seen)
                  then h.version else d.app_version end as version,
             (coalesce(d.client_caps @> array['fence_v1'], false) or d.device_secret_hash is not null) as ready
        from public.devices d
        left join public.locations l on l.id = d.location_id
        left join lateral (select hb.version, hb.last_seen
                             from public.device_heartbeats hb
                            where hb.device_id = d.id::text
                            order by hb.last_seen desc nulls last
                            limit 1) h on true
       where greatest(d.last_seen, h.last_seen) > now() - interval '2 hours'
    )
    select count(*),
           string_agg(format('%s: %s (%s, %s)', venue, device, dtype,
                             coalesce('v' || nullif(btrim(version), ''), 'no version reported')), '; ' order by venue, device)
      from seen
     where not ready
  $q$ into v_n, v_list;
  if v_n > 0 then
    raise exception 'STOPPED, NOTHING WAS CHANGED. % device(s) switched on in the last 2 hours have not reported the app release: %. The version each one last reported is in brackets. Update each one (a Sunmi till: force stop the app and open it again) and leave it on for two minutes, or switch it off, then run this file again. A device that is switched off stops counting 2 hours after it was last seen.', v_n, v_list;
  end if;
end
$guard$;

-- 0b. Every lock this file needs, taken now, in one fixed order: the two busy tables a
-- till writes first, then the identity tables its policies read, then the two tables the
-- server prices orders from. A till's ordinary write takes them in that same order (the
-- table it writes, then the identity tables), so the two rarely wait on each other in a
-- circle; a card terminal table close reads the identity tables first, so a deadlock is
-- still possible, if unlikely outside service. If a till holds one of them for more than
-- 3 seconds, or a deadlock is found, the file stops, changes nothing, and says so.
do $locks$
begin
  lock table public.closed_checks, public.order_queue, public.locations, public.organisations,
             public.user_profiles, public.user_locations, public.devices
    in access exclusive mode;
exception when lock_not_available or deadlock_detected then
  raise exception 'STOPPED, NOTHING WAS CHANGED. A till was busy with the orders or devices tables for more than 3 seconds. Wait 10 seconds and press Run again.';
end
$locks$;

-- 0c. closed_checks accepts QR (gap G15). closed_checks_source_check had no 'qr', so
-- every QR paid check was refused and never reached reports. Widening a check cannot
-- break an existing row.
--
-- NOT VALID, on purpose (fix round 5, 19 Sep). A plain ADD CONSTRAINT re-reads every row in
-- closed_checks, the largest table in the Ops DB, while this file holds ACCESS EXCLUSIVE on
-- it, and the runbook promises step 3 locks the busy tables for about 5 seconds. On a venue
-- with a long history it would take far longer. NOT VALID skips that scan and costs nothing
-- here: the new list is a strict superset of the live one, so no existing row can break it,
-- and a NOT VALID check still refuses every INSERT and UPDATE from now on, which is the only
-- thing the fence needs. There is no VALIDATE step to come back for.
alter table public.closed_checks drop constraint if exists closed_checks_source_check;
alter table public.closed_checks add constraint closed_checks_source_check
  check (source = any (array['pos', 'kiosk', 'online', 'mobile', 'catering', 'hubrise', 'pax_table_pay',
                             'pos_send_to_terminal', 'adyen_pay_at_table', 'ezcater', 'qr'])) not valid;

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

-- Which fence files have run (file 1 refuses to run again once file 2 has). set_at of
-- 'file_a' is when this file FIRST ran: running it again keeps that time, and file 2
-- refuses to run until a full day after it (the roll back clears it).
create table if not exists public.fence_state (
  key    text primary key,
  value  text,
  set_at timestamptz not null default now()
);
insert into public.fence_state (key, value) values ('file_a', '20260919a')
on conflict (key) do update set value = excluded.value;

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
-- money it can no longer save). Only real device ids are recorded, and only from a
-- session that was once linked to that device (fix round 2: a stranger naming a device
-- id must not be able to hold file 2 shut).
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
-- the card processor's webhook was late), or whose proven money is short of what the
-- server says the order is worth. The order reaches the venue marked "payment being
-- checked" or "short"; verify_public_order_payment writes this check once proofs cover
-- the amount due, or confirm_public_order_payment when staff confirm it by hand. pricing
-- is the server's own valuation (goods, each proven discount, the amount the page said),
-- so a loyalty redemption that lands late is counted when the payment is checked again.
create table if not exists public.public_order_pending_checks (
  location_id   text not null,
  ref           text not null,
  check_row     jsonb not null,
  due_minor     bigint not null,
  client_total  numeric,
  payment_refs  text[] not null default '{}',
  placed_by     uuid,
  pricing       jsonb,
  unknown_lines integer not null default 0,
  created_at    timestamptz not null default now(),
  primary key (location_id, ref)
);
alter table public.public_order_pending_checks add column if not exists pricing jsonb;
alter table public.public_order_pending_checks add column if not exists unknown_lines integer not null default 0;

-- A device secret issued to a session, kept in plain for 10 minutes only, so that the
-- same session asking again (a till runs its link check from more than one place at boot)
-- gets the SAME secret back instead of a new one that no longer matches what it saved
-- (fix round 2). No browser role can read this table.
create table if not exists public.device_secret_stash (
  device_id uuid primary key references public.devices(id) on delete cascade,
  uid       uuid not null,
  secret    text not null,
  issued_at timestamptz not null default now()
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
                           'qr_tab_members', 'print_agent_tokens', 'device_secret_stash'] loop
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

-- The same number rule as _fence_num, but NULL (never 0) when there is no plain number
-- there. Fix round 4 (19 Sep): the difference between "the venue priced this at zero" and
-- "the server has nothing to go on" is the difference between free food and a short order.
create or replace function public._fence_num_or_null(p text)
returns numeric
language sql
immutable
set search_path = pg_catalog
as $fn$
  select case when p ~ '^\s*-?[0-9]{1,12}(\.[0-9]{1,6})?\s*$' then trim(p)::numeric end;
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

-- The helpers below mirror the app's own price and discount rules (src/lib/menuPricing.js
-- and src/lib/discountEngine.js), so the server works out an order's worth the way the
-- storefront did. Change them together.

-- JavaScript truthiness of a JSON value (the discount engine tests rule.channels[channel]
-- and schedule fields that way).
create or replace function public._fence_js_truthy(p jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $fn$
  select case jsonb_typeof(p)
           when 'boolean' then p = 'true'::jsonb
           when 'number'  then (p #>> '{}')::numeric <> 0
           when 'string'  then (p #>> '{}') <> ''
           when 'object'  then true
           when 'array'   then true
           else false end;
$fn$;

-- 'HH:MM' as minutes after midnight, the way the discount engine reads a schedule window
-- (String(v).split(':').map(Number)); NULL when it is not a time.
create or replace function public._fence_hhmm(p jsonb)
returns integer
language plpgsql
immutable
set search_path = pg_catalog
as $fn$
declare
  v_parts text[];
  v_h     text;
  v_m     text;
begin
  if not public._fence_js_truthy(p) or jsonb_typeof(p) in ('object', 'array') then
    return null;
  end if;
  v_parts := string_to_array(p #>> '{}', ':');
  if coalesce(cardinality(v_parts), 0) < 2 then
    return null;
  end if;
  v_h := btrim(v_parts[1]);
  v_m := btrim(v_parts[2]);
  if v_h !~ '^[0-9]{0,4}$' or v_m !~ '^[0-9]{0,4}$' then
    return null;
  end if;
  return coalesce(nullif(v_h, '')::integer, 0) * 60 + coalesce(nullif(v_m, '')::integer, 0);
end;
$fn$;

-- Does a line belong to any of these categories (discountEngine itemMatchesCategories:
-- its cat, or any of its cats)? An empty list matches nothing.
create or replace function public._fence_cat_match(p_cat text, p_cats jsonb, p_ids text[])
returns boolean
language sql
immutable
set search_path = pg_catalog
as $fn$
  select coalesce(cardinality(p_ids), 0) > 0
     and (coalesce(p_cat = any(p_ids), false)
          or exists (select 1
                       from jsonb_array_elements_text(case when jsonb_typeof(p_cats) = 'array' then p_cats else '[]'::jsonb end) c
                      where c = any(p_ids)));
$fn$;

-- Is an automatic discount rule live at this moment, on the venue's clock
-- (discountEngine isRuleActiveNow: start and expiry dates, weekdays, time windows)?
create or replace function public._fence_rule_live(p_schedule jsonb, p_tz text, p_at timestamptz)
returns boolean
language plpgsql
stable
set search_path = pg_catalog
as $fn$
declare
  v_local timestamp;
  v_min   integer;
  v_day   integer;
  v_ymd   text;
  v_any   boolean := false;
  v_st    integer;
  v_en    integer;
  w       jsonb;
begin
  if p_schedule is null or not public._fence_js_truthy(p_schedule) then
    return true;
  end if;
  begin
    v_local := p_at at time zone coalesce(nullif(p_tz, ''), 'Europe/London');
  exception when others then
    v_local := p_at at time zone 'Europe/London';
  end;
  v_min := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  v_day := extract(isodow from v_local)::integer;
  v_ymd := to_char(v_local, 'YYYY-MM-DD');
  if jsonb_typeof(p_schedule -> 'startsAt') = 'string' and (p_schedule ->> 'startsAt') <> ''
     and v_ymd collate "C" < (p_schedule ->> 'startsAt') collate "C" then
    return false;
  end if;
  if jsonb_typeof(p_schedule -> 'expiresAt') = 'string' and (p_schedule ->> 'expiresAt') <> ''
     and v_ymd collate "C" > (p_schedule ->> 'expiresAt') collate "C" then
    return false;
  end if;
  if jsonb_typeof(p_schedule -> 'days') = 'array' and jsonb_array_length(p_schedule -> 'days') > 0
     and not ((p_schedule -> 'days') @> to_jsonb(v_day)) then
    return false;
  end if;
  if jsonb_typeof(p_schedule -> 'windows') = 'array' and jsonb_array_length(p_schedule -> 'windows') > 0 then
    for w in select x from jsonb_array_elements(p_schedule -> 'windows') x loop
      continue when jsonb_typeof(w) is distinct from 'object';
      v_st := public._fence_hhmm(w -> 'start');
      v_en := public._fence_hhmm(w -> 'end');
      continue when v_st is null or v_en is null;
      if (v_en > v_st and v_min >= v_st and v_min < v_en)
         or (v_en <= v_st and (v_min >= v_st or v_min < v_en)) then
        v_any := true;
      end if;
    end loop;
    if not v_any then
      return false;
    end if;
  end if;
  return true;
end;
$fn$;

-- The price channel the till's resolver uses for an order type (menuPricing channelKey:
-- exact keys only, anything else is dineIn).
create or replace function public._menu_channel_key(p_type text)
returns text
language sql
immutable
set search_path = pg_catalog
as $fn$
  select case coalesce(p_type, '')
           when 'dineIn' then 'dineIn' when 'dine-in' then 'dineIn' when 'dine_in' then 'dineIn'
           when 'takeaway' then 'takeaway' when 'collection' then 'collection' when 'delivery' then 'delivery'
           when 'driveThru' then 'driveThru' when 'drive-thru' then 'driveThru' when 'drive_thru' then 'driveThru'
           when 'drive-through' then 'driveThru'
           else 'dineIn' end;
$fn$;

-- The LOWEST price the resolver (menuPricing resolveItemPrice) can give this item on this
-- channel, whichever menu is active: every menu tier's price for the channel (the channel,
-- then all, then base) and the item's own channel price (then base). Drive thru falls to
-- takeaway. Catering prices from base only (CateringSurface). In pence. A line priced below
-- this counts at this.
--
-- NULL means the server cannot work out what this item is worth (fix round 4, 19 Sep): no
-- pricing object, no plain number where a price should be, or nothing above zero anywhere.
-- A ZERO IS NOT A PRICE. Every ordering screen already reads a zero as "unpriced"
-- (lib/menuPricing.js variantFromPrice skips zeros, which is exactly why a variants parent
-- carries base 0 and menu_items.pricing defaults to {"base": 0}), so returning 0 here made
-- a row the storefront never sells worth nothing and it rode along free on a paid ticket.
-- On a row the storefront does NOT sell, NULL is never free: the line is UNKNOWN, it counts
-- at no less than what the page said, and the order comes out SHORT for staff to confirm.
-- On a row the storefront DOES sell, the caller (_public_order_value) reads NULL as 0,
-- because 0.00 is what the customer was charged: resolveItemPrice answers 0 for {"base": 0}
-- and for a row with no pricing at all, and a genuinely free side is a real thing on a menu.
--
-- A ZERO TYPED INTO A MENU TIER IS A PRICE ONLY ON ITS OWN MENU (fix round 6, narrowed in fix
-- round 7). The "a zero is not a price" rule above is about the item's OWN price, where a 0 is
-- the default a variants parent and menu_items.pricing both carry. A per menu tier is
-- different: it only exists because a manager typed it, and the storefront charges it as
-- typed. src/lib/menuPricing.js menuTierPrice (lines 78 to 80) takes the tier's channel key,
-- then `all`, then `base` with isSet(), which accepts 0, and resolveItemPrice (line 90)
-- returns that tier and never looks further. So {"base": 4, "menus": {"menu-kids": {"all": 0}}}
-- is 0.00 on the kids menu on every screen, while the round 5 floor said 4.00 and put the
-- honest, fully paid order into "Payment short".
--
-- Round 6 accepted a 0.00 tier into the SMALLEST-price-of-any-menu floor, and the two together
-- made an item that is free on one menu free to order on all of them: a page could send ten
-- Kids Squash at 0.00 beside one real Coffee and walk off with 40.00 of stock for 3.00. The
-- two directions only both hold if the server knows which menu the basket was priced on, so
-- the storefronts now send it (`menu_id` on the order, OnlineSurface's effectiveMenuId, which
-- is exactly what resolveItemPrice was given: OnlineCheckout.jsx and QrCheckout.jsx):
--   * p_menu_id given: price from THAT menu's tier, exactly as resolveItemPrice does (the
--     tier wins and nothing else is looked at), and a 0.00 there is a real price. An item with
--     no tier on that menu falls to its own channel or base price. No other menu's tier counts.
--   * p_menu_id null (an older page, catering, or a re-valuation of a round placed before this
--     release): 0.00 tiers are IGNORED and the floor is the lowest price ABOVE zero any tier
--     or the item itself gives. The honest kids menu order then comes out SHORT for staff to
--     confirm, which is the safe way round: short is a question, free is a loss.
-- A negative tier is still ignored: no storefront pays a customer to take an item.
drop function if exists public._menu_item_floor_minor(jsonb, text, boolean);
create or replace function public._menu_item_floor_minor(p_pricing jsonb, p_channel text, p_base_only boolean,
                                                         p_menu_id text default null)
returns bigint
language plpgsql
immutable
set search_path = pg_catalog
as $fn$
declare
  v_keys text[] := case when p_channel = 'driveThru' then array['driveThru', 'takeaway'] else array[p_channel] end;
  v_min  numeric;
  v_val  numeric;
  v_tier jsonb;
  k      text;
begin
  if jsonb_typeof(p_pricing) is distinct from 'object' then
    return null;
  end if;
  if p_base_only then
    v_min := public._fence_num_or_null(p_pricing ->> 'base');
    return case when coalesce(v_min, 0) > 0 then round(v_min * 100)::bigint end;
  end if;
  -- The menu the basket was built on: its tier is the price, 0.00 included, and nothing else
  -- is looked at (mirrors src/lib/menuPricing.js resolveItemPrice:86-93 with menuTierPrice).
  if nullif(btrim(coalesce(p_menu_id, '')), '') is not null
     and jsonb_typeof(p_pricing -> 'menus' -> p_menu_id) = 'object' then
    v_tier := p_pricing -> 'menus' -> p_menu_id;
    foreach k in array v_keys || array['all', 'base'] loop
      if v_val is null and v_tier ? k then
        v_val := public._fence_num_or_null(v_tier ->> k);
      end if;
    end loop;
    if v_val is not null and v_val >= 0 then
      return round(v_val * 100)::bigint;
    end if;
    v_val := null;
  end if;
  foreach k in array v_keys loop
    if v_val is null and p_pricing ? k then
      v_val := public._fence_num_or_null(p_pricing ->> k);
    end if;
  end loop;
  v_min := coalesce(v_val, public._fence_num_or_null(p_pricing ->> 'base'));
  if coalesce(v_min, 0) <= 0 then
    v_min := null;
  end if;
  -- The menu is known: that menu priced this row off its own price, so no other menu's tier
  -- can lower it. The menu is NOT known: the lowest tier ABOVE zero is the floor (a 0.00 tier
  -- is a price only on its own menu, or one free row on a kids menu is free everywhere).
  if nullif(btrim(coalesce(p_menu_id, '')), '') is null and jsonb_typeof(p_pricing -> 'menus') = 'object' then
    for v_tier in select t.value from jsonb_each(p_pricing -> 'menus') t loop
      continue when jsonb_typeof(v_tier) is distinct from 'object';
      v_val := null;
      foreach k in array v_keys || array['all', 'base'] loop
        if v_val is null and v_tier ? k then
          v_val := public._fence_num_or_null(v_tier ->> k);
        end if;
      end loop;
      if v_val is not null and v_val > 0 then
        v_min := least(v_min, v_val);   -- least() skips a NULL v_min
      end if;
    end loop;
  end if;
  return case when v_min is not null then round(v_min * 100)::bigint end;
end;
$fn$;

do $revoke_internal$
declare
  f text;
begin
  foreach f in array array[
    'public._fence_api_role()', 'public._fence_bypass()', 'public._fence_norm_code(text)',
    'public._fence_num(text)', 'public._fence_num_or_null(text)', 'public._fence_bool(text)', 'public._fence_is_uuid(text)',
    'public._fence_is_server_code(text)', 'public._fence_client_ip()',
    'public._fence_random_code(integer)', 'public._fence_random_digits(integer)', 'public._fence_is_locked(text)',
    'public._fence_count(text, integer, interval, interval)', 'public._fence_clear(text)',
    'public._fence_js_truthy(jsonb)', 'public._fence_hhmm(jsonb)', 'public._fence_cat_match(text, jsonb, text[])',
    'public._fence_rule_live(jsonb, text, timestamp with time zone)', 'public._menu_channel_key(text)',
    'public._menu_item_floor_minor(jsonb, text, boolean, text)'] loop
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
    -- A server venue code too (fix round 2): adyen-onboard and payments-admin find a venue
    -- by it, so a new venue may not choose one (copy another venue's, or take a future one
    -- from the sequence). The column default already drew the next code in this statement;
    -- anything else the browser sent is replaced by a fresh one.
    if to_regclass('public.venue_code_seq') is not null then
      begin
        if new.venue_code is distinct from ('SV-' || lpad(currval('public.venue_code_seq')::text, 4, '0')) then
          new.venue_code := 'SV-' || lpad(nextval('public.venue_code_seq')::text, 4, '0');
        end if;
      exception when object_not_in_prerequisite_state then
        -- currval has no value in this session: the default did not run, the code came from
        -- the browser.
        new.venue_code := 'SV-' || lpad(nextval('public.venue_code_seq')::text, 4, '0');
      end;
    end if;
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

-- The device secret for a session (fix round 2). A till's boot runs its link check from
-- more than one place at once, and each call used to write a new secret: a till could
-- save secret 1 while the server held secret 2, which stays hidden until its login
-- changes and it drops to the pairing screen in service. Now a secret issued to THIS
-- session for this device in the last 10 minutes, that still matches the device, is
-- handed back as it is; only when there is none (or it no longer matches, for example a
-- new pairing code cleared it) is a new one made. The device row is locked first, so two
-- calls at once see each other's secret. The caller turns the fence bypass on.
create or replace function public._device_mint_secret(p_device_id uuid, p_uid uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_secret text;
  v_hash   text;
begin
  select d.device_secret_hash into v_hash from public.devices d where d.id = p_device_id for update;
  delete from public.device_secret_stash where issued_at < now() - interval '10 minutes';
  select s.secret into v_secret
    from public.device_secret_stash s
   where s.device_id = p_device_id and s.uid = p_uid;
  if v_secret is not null and v_hash is not null
     and v_hash = encode(sha256(convert_to(v_secret, 'UTF8')), 'hex') then
    return v_secret;
  end if;
  v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update public.devices
     set device_secret_hash = encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'),
         secret_issued_at   = now()
   where id = p_device_id;
  insert into public.device_secret_stash (device_id, uid, secret, issued_at)
  values (p_device_id, p_uid, v_secret, now())
  on conflict (device_id) do update
     set uid = excluded.uid, secret = excluded.secret, issued_at = excluded.issued_at;
  return v_secret;
end;
$fn$;
revoke all on function public._device_mint_secret(uuid, uuid) from public, anon, authenticated;

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
      v_secret := public._device_mint_secret(v_own.id, v_uid);
    end if;
    update public.devices set last_seen = now() where id = v_own.id;
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
           device_secret_hash = null,
           secret_issued_at   = null
     where id = v_row.id;
    if p_mint_secret then
      v_secret := public._device_mint_secret(v_row.id, v_uid);
    end if;
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
-- on its first check with the release, so it never needs a pairing code again. The
-- same session asking again within 10 minutes (calls made at the same moment at boot)
-- gets the same secret back, never a new one that no longer matches what it saved.
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
  v_had    text;
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
  v_had := v.device_secret_hash;
  perform set_config('servos.fence_bypass', 'on', true);
  v_secret := public._device_mint_secret(v.id, v_uid);
  if v_had is distinct from encode(sha256(convert_to(v_secret, 'UTF8')), 'hex') then
    insert into public.device_claim_log (device_id, location_id, event, new_uid, detail)
    values (v.id, v.location_id, 'secret_issued', v_uid, 'bound till collected a device secret');
  end if;
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
-- device_unlinked_pings (only for a real device id, and only when this session was once
-- linked to that device: device_claim_log names it), so file 2 can see a till or kiosk
-- that is switched on but no longer linked, and nobody else can pretend to be one.
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
         and exists (select 1 from public.device_claim_log g
                      where g.device_id = d.id and v_uid in (g.old_uid, g.new_uid))
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
    -- shows the red banner): that device counts as switched on but unpaired, when this
    -- session was once linked to it.
    insert into public.device_unlinked_pings (device_id, uid, last_at, app_version, caps)
    select d.id, v_uid, now(), left(p_app_version, 40), p_caps[1:20]
      from public.devices d
     where d.id = p_device_id
       and exists (select 1 from public.device_claim_log g
                    where g.device_id = d.id and v_uid in (g.old_uid, g.new_uid))
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
-- untrusted_links_left = 0; placed_via_trigger = true; print_agent_table = true.
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
  exists (select 1 from pg_trigger where tgname = 'order_queue_placed_via' and not tgisinternal)             as placed_via_trigger,
  (to_regclass('public.print_agent_tokens') is not null)                                                      as print_agent_table;

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
--                      'issue_pairing_code','device_heartbeat','device_status','_device_claim_core','_fence_count')
--  order by 1;


-- -- ============================================================================
-- -- ROLL BACK (only if something is wrong; paste in the Ops SQL editor)
-- -- ============================================================================
-- -- HOW: copy every line from the "-- -- ====" line just above this heading to the
-- -- very end of the file and paste it into the Ops SQL editor. Select all (Cmd+A)
-- -- and press Cmd+/ once: every line loses its first "-- ", and the notes (lines
-- -- that still start with "-- ") stay notes. Then press Run.
-- -- ORDER: this is the FIRST half, so it comes out LAST. If file 2 (20260919b) has run,
-- -- roll it back first; if the payment half (20260919a2) has run, roll THAT back next
-- -- (the block at the end of 20260919a2_OPS_fence_public_orders.sql). While either is
-- -- still in, this block stops at its first step and changes nothing.
-- -- WHAT: it puts back exactly the policies, functions, function grants and write
-- -- grants this file changed (as they were on 18 Sep), and can run twice. It does NOT
-- -- put back pairing codes (retired on purpose: issue new ones in Back Office) or
-- -- links the fence removed from old devices (pair those devices again). TRUNCATE,
-- -- REFERENCES and TRIGGER are not given back (nothing uses them). The new tables,
-- -- columns and functions stay: nothing needs them gone. If this file runs again
-- -- later, the full day file 2 waits for starts again then.
-- set local lock_timeout = '3s';
-- do $rb_guard$
-- declare
--   v_file_a2 boolean := false;
--   v_file_b  boolean := false;
-- begin
--   if to_regclass('public.fence_state') is not null then
--     execute 'select exists (select 1 from public.fence_state where key = ''file_b'')' into v_file_b;
--     execute 'select exists (select 1 from public.fence_state where key = ''file_a2'')' into v_file_a2;
--   end if;
--   if v_file_b or exists (select 1 from pg_policies where schemaname = 'public'
--                           and policyname in ('order_queue_staff', 'kds_tickets_staff', 'print_jobs_staff',
--                                              'active_sessions_staff', 'table_reservations_staff',
--                                              'closed_checks_insert_staff')) then
--     raise exception 'STOPPED, NOTHING WAS CHANGED. File 2 (20260919b) is still in. Roll back file 2 first (the ROLL BACK block at the end of 20260919b_OPS_fence_2_after_app.sql), then the payment half (20260919a2), then run this block again.';
--   end if;
--   if v_file_a2 or exists (select 1 from pg_policies where schemaname = 'public'
--                            and tablename = 'discount_rules' and policyname = 'discount_rules_write_bo') then
--     raise exception 'STOPPED, NOTHING WAS CHANGED. The payment half (20260919a2) is still in. Roll IT back first (the ROLL BACK block at the end of 20260919a2_OPS_fence_public_orders.sql), then run this block again.';
--   end if;
-- end
-- $rb_guard$;
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
-- -- function grants exactly as on 18 Sep: PUBLIC could run these five (this file took that away)
-- grant execute on function public.claim_device(text) to anon, authenticated;
-- grant execute on function public.claim_device(text), public.pos_can_access(text), public.pos_can_access(uuid),
--   public.user_accessible_locations(), public.user_accessible_orgs() to public;
-- -- order_queue: the who-wrote-it stamp stops (the column stays)
-- drop trigger if exists order_queue_placed_via on public.order_queue;
-- -- file 2 counts its full day from the next time this file runs
-- delete from public.fence_state where key = 'file_a';
-- reset lock_timeout;
-- -- The closed_checks 'qr' value stays (it is a fix).
