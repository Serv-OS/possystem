-- 20260919b_OPS_fence_2_after_app.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  DATABASE FENCE, STAGE 1, FILE 2 OF 2 (Ops).                              #
-- #  ONLY AFTER file 1 (20260919a) has been in for a full day, the app        #
-- #  release is on EVERY till, KDS, kiosk and clock, and the customer pages   #
-- #  place orders through the new server functions. Outside service.         #
-- #  The file checks this itself and stops (changing nothing) if it is not.   #
-- ############################################################################
--
-- WHAT THIS FILE CLOSES
--   * order_queue, kds_tickets, active_sessions, table_reservations lose "allow all";
--     print_jobs loses its open read, insert and update; closed_checks loses its open
--     insert. From now on only a paired till, kiosk or KDS of that venue, a Back
--     Office login of that venue, a host stand of that venue (tables only), the super
--     admin, or a server function can read or write them.
--   * Customer pages reach them only through the functions file 1 created
--     (place_public_order, verify_public_order_payment, settle_qr_tab, order_track_row,
--     qr_* and catering_day_load), each keyed to something the customer holds. QR tabs
--     reach the floor plan through a trigger, never from a phone.
--   * The raw anon key loses INSERT, UPDATE, DELETE on these tables. Print agents use
--     print_agent_claim and print_agent_report with a key from Back Office.
--   (devices were finished by file 1: codes hidden, old codes retired, venues pinned,
--   re-link by device secret only. Nothing here changes them.)
--
-- WHY IT WAITS FOR THE APP (see docs/FENCE_STAGE_1_APP.md): a till that briefly loses
-- its link must not wipe its pairing (gap B3), must show staff a banner, must keep its
-- unsent work and send it once the link is back (gaps G23, B1), and must hold a device
-- secret to re-link with; the customer pages must use the new functions (gaps B2, B3,
-- B12, G4, G5, G6, G16, G17); the print agents need their key (gap G24).
--
-- RULES OF THE FILE: no begin or commit (any error means nothing changed); every
-- statement can run twice; 3 second lock wait; verification and roll back at the end.


-- ============================================================================
-- 0. Guards: right project, file 1 in place, the app release really is live
-- ============================================================================
set lock_timeout = '3s';

do $guard$
declare
  v_n    integer;
  v_list text;
  v_null integer;
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.devices') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS project (tbetcegmszzotrwdtqhi). This is not it. Nothing was changed.';
  end if;
  if to_regprocedure('public.place_public_order(uuid, jsonb, jsonb, uuid[])') is null
     or to_regprocedure('public.verify_public_order_payment(uuid, text, uuid[])') is null
     or to_regclass('public.payment_proofs') is null
     or to_regclass('public.device_unlinked_pings') is null
     or to_regclass('public.fence_state') is null
     or not exists (select 1 from pg_trigger where tgname = 'order_queue_placed_via' and not tgisinternal) then
    raise exception 'Run 20260919a_OPS_fence_1_safe_now.sql (this version) first. Nothing was changed.';
  end if;
  if to_regprocedure('public.online_kitchen_load(text)') is null then
    raise exception 'online_kitchen_load(text) is missing (20260902_online_kitchen_load.sql). The storefront busy time needs it once order_queue is closed. Nothing was changed.';
  end if;

  -- 1. Every active till, KDS, kiosk and clock must be running the release (it reports
  --    fence_v1 through device_heartbeat), be linked by a claim, and hold its device
  --    secret (without one a till whose login changes can never re-link by itself).
  select count(*),
         string_agg(format('%s: %s (%s)%s', coalesce(l.name, 'no venue'), d.name, coalesce(d.type, '?'),
                           case when d.bound_via is null then ', not paired'
                                when not coalesce(d.client_caps @> array['fence_v1'], false) then ', old app'
                                when d.device_secret_hash is null then ', no device secret yet'
                                else '' end), '; ' order by l.name, d.name)
    into v_n, v_list
    from public.devices d
    left join public.locations l on l.id = d.location_id
   where d.status in ('active', 'online')
     and (d.bound_via is null
          or not coalesce(d.client_caps @> array['fence_v1'], false)
          or d.device_secret_hash is null);
  if v_n > 0 then
    raise exception 'STOPPED, NOTHING WAS CHANGED. % device(s) are not ready: %. Switch each one on and let it load the new app for 2 minutes (a Sunmi till: force stop the app and open it again). Not paired: pair it again. Not used any more: press Remove in Back Office. Then run this file again.', v_n, v_list;
  end if;

  -- 2. A device that is NOT linked but was switched on in the last 24 hours (its app said
  --    so through the heartbeat): after this file it could take a card payment it can
  --    no longer save.
  select count(*),
         string_agg(format('%s: %s (%s, status %s)', coalesce(l.name, 'no venue'), d.name, coalesce(d.type, '?'), d.status),
                    '; ' order by l.name, d.name)
    into v_n, v_list
    from public.device_unlinked_pings p
    join public.devices d on d.id = p.device_id
    left join public.locations l on l.id = d.location_id
   where p.last_at > now() - interval '24 hours'
     and not (d.status in ('active', 'online') and d.bound_via is not null);
  if v_n > 0 then
    raise exception 'STOPPED, NOTHING WAS CHANGED. % device(s) are switched on but not paired: %. Pair each one again (Pair again on its red banner), or switch it off and press Remove in Back Office. Then run this file again tomorrow.', v_n, v_list;
  end if;

  -- 3. The customer pages must be placing orders through place_public_order. Any online,
  --    QR or catering order in the last 24 hours that an old customer page wrote straight
  --    into the table means an old page is still out there. Orders written by the server
  --    (ezCater, HubRise, catering release: placed_via 'server') and by tills or Back
  --    Office ('staff') are fine.
  select count(*) filter (where q.placed_via = 'public'),
         count(*) filter (where q.placed_via is null)
    into v_n, v_null
    from public.order_queue q
   where q.source in ('online', 'qr', 'catering')
     and q.created_at > now() - interval '24 hours'
     and lower(coalesce(q.customer ->> 'channel', '')) <> 'ezcater';
  if v_null > 0 then
    raise exception 'STOPPED, NOTHING WAS CHANGED. File 1 has been in for less than a day (% customer order(s) in the last 24 hours were written before it). Run this file again once file 1 has been in for a full day.', v_null;
  end if;
  if v_n > 0 then
    raise exception 'STOPPED, NOTHING WAS CHANGED. % online, QR or catering order(s) in the last 24 hours were written by an old customer page. Wait until the new pages have been live for a full day with no old orders, then run this file again.', v_n;
  end if;

  -- 4. And the new path must really be working: at least one customer order placed
  --    through place_public_order in the last 7 days (a quiet day must not pass
  --    this check by itself).
  if not exists (select 1 from public.order_queue q
                  where q.placed_via = 'rpc' and q.created_at > now() - interval '7 days') then
    raise exception 'STOPPED, NOTHING WAS CHANGED. No customer order has gone through the new order function yet. Place one test online order (any venue, pay with a real card and refund it, or use a gift card), check it reached the till, then run this file again.';
  end if;
end
$guard$;


-- ============================================================================
-- 1. Mark this file as run (file 1 refuses to run again from now on)
-- ============================================================================
insert into public.fence_state (key, value) values ('file_b', '20260919b')
on conflict (key) do update set value = excluded.value, set_at = now();

-- Belt and braces: the interim read policy of an older draft of file 1 never comes back.
drop policy if exists devices_read_interim on public.devices;


-- ============================================================================
-- 2. Orders: order_queue, kds_tickets, print_jobs
-- ============================================================================
-- Tills, kiosks and KDS screens of the venue (a claimed device), the venue's Back
-- Office logins and the super admin. Customer pages use the file 1 functions; edge
-- functions use the service role; order screens use order_status_feed(). With no
-- policy of plain "true" left on order_queue, order_status_names_enabled() turns on
-- and the order screen TVs start showing first names (see INVARIANTS.md).
alter table public.order_queue enable row level security;
drop policy if exists order_queue_staff on public.order_queue;
create policy order_queue_staff on public.order_queue
  for all
  using      (location_id in (select public.pos_accessible_location_keys()) or (select public.is_super_admin()))
  with check (location_id in (select public.pos_accessible_location_keys()) or (select public.is_super_admin()));
drop policy if exists "allow all" on public.order_queue;
drop policy if exists order_queue_tenant on public.order_queue;
drop policy if exists order_queue_public_insert on public.order_queue;

-- QR tabs reach the floor plan from here, never from a phone (gap G17). Only QR rows,
-- only on a status, items or paid change, never failing the order write. A paid pay
-- now order (for example one whose payment was just verified) and every round of an
-- open tab count; an order whose payment is still being checked does not.
drop trigger if exists order_queue_qr_floor on public.order_queue;
create trigger order_queue_qr_floor
  after insert or delete or update of status, items, paid on public.order_queue
  for each row execute function public.order_queue_qr_floor_tg();

alter table public.kds_tickets enable row level security;
drop policy if exists kds_tickets_staff on public.kds_tickets;
create policy kds_tickets_staff on public.kds_tickets
  for all
  using      (location_id in (select public.pos_accessible_location_keys()) or (select public.is_super_admin()))
  with check (location_id in (select public.pos_accessible_location_keys()) or (select public.is_super_admin()));
drop policy if exists "allow all" on public.kds_tickets;
drop policy if exists kds_tickets_tenant on public.kds_tickets;

alter table public.print_jobs enable row level security;
drop policy if exists print_jobs_staff on public.print_jobs;
create policy print_jobs_staff on public.print_jobs
  for all
  using      (location_id in (select public.pos_accessible_location_ids()) or (select public.is_super_admin()))
  with check (location_id in (select public.pos_accessible_location_ids()) or (select public.is_super_admin()));
drop policy if exists "agent update" on public.print_jobs;
drop policy if exists "insert print jobs" on public.print_jobs;
drop policy if exists "read print jobs" on public.print_jobs;


-- ============================================================================
-- 3. Tables: active_sessions, table_reservations (bar_tabs is already fenced)
-- ============================================================================
-- Tills and Back Office of the venue, plus the venue's host stand (bookings and
-- Tables Ready iPads pair through waitlist_devices and seat guests, gap B4).
alter table public.active_sessions enable row level security;
drop policy if exists active_sessions_staff on public.active_sessions;
create policy active_sessions_staff on public.active_sessions
  for all
  using      (location_id in (select public.pos_accessible_location_ids())
              or public.waitlist_can_write(location_id) or (select public.is_super_admin()))
  with check (location_id in (select public.pos_accessible_location_ids())
              or public.waitlist_can_write(location_id) or (select public.is_super_admin()));
drop policy if exists "allow all" on public.active_sessions;
drop policy if exists active_sessions_tenant on public.active_sessions;

alter table public.table_reservations enable row level security;
drop policy if exists table_reservations_staff on public.table_reservations;
create policy table_reservations_staff on public.table_reservations
  for all
  using      (location_id in (select public.pos_accessible_location_ids())
              or public.waitlist_can_write(location_id) or (select public.is_super_admin()))
  with check (location_id in (select public.pos_accessible_location_ids())
              or public.waitlist_can_write(location_id) or (select public.is_super_admin()));
drop policy if exists "allow all" on public.table_reservations;
drop policy if exists table_reservations_tenant on public.table_reservations;


-- ============================================================================
-- 4. Payments: closed_checks insert
-- ============================================================================
-- Read, update and delete were already pos_can_access. The insert that took any row
-- from anyone (fake paid revenue, gap B3) is replaced: tills, kiosks and Back Office
-- of the venue; customer pages go through place_public_order, verify_public_order_payment
-- and settle_qr_tab.
alter table public.closed_checks enable row level security;
drop policy if exists closed_checks_insert_staff on public.closed_checks;
create policy closed_checks_insert_staff on public.closed_checks
  for insert
  with check (public.pos_can_access(location_id) or (select public.is_super_admin()));
drop policy if exists "insert closed checks" on public.closed_checks;
drop policy if exists closed_checks_insert on public.closed_checks;


-- ============================================================================
-- 5. The raw anon key (no session at all) writes none of them
-- ============================================================================
revoke insert, update, delete on table public.order_queue, public.kds_tickets, public.print_jobs,
  public.active_sessions, public.table_reservations, public.closed_checks, public.bar_tabs from anon;

reset lock_timeout;


-- ============================================================================
-- V. Verification (read only). The editor shows this last result.
-- ============================================================================
-- Expect: open_policies_left = none; names_on_order_screens = true;
-- devices_readable_by_all = false; tills_without_secret = 0; qr_floor_trigger = true.
select
  coalesce((select string_agg(tablename || ' ' || policyname, ', ' order by tablename, policyname)
              from pg_policies
             where schemaname = 'public'
               and tablename in ('devices', 'order_queue', 'kds_tickets', 'print_jobs', 'active_sessions',
                                 'table_reservations', 'closed_checks', 'bar_tabs', 'organisations', 'locations',
                                 'user_profiles', 'user_locations')
               and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE', 'SELECT')
               and (btrim(coalesce(qual, '')) = 'true' or btrim(coalesce(with_check, '')) = 'true')
               and tablename <> 'locations'), 'none')                                            as open_policies_left,
  public.order_status_names_enabled()                                                             as names_on_order_screens,
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'devices'
           and cmd = 'SELECT' and btrim(coalesce(qual, '')) = 'true')                              as devices_readable_by_all,
  (select count(*) from public.devices
    where status in ('active', 'online') and bound_via is not null and device_secret_hash is null)  as tills_without_secret,
  exists (select 1 from pg_trigger where tgname = 'order_queue_qr_floor' and not tgisinternal)   as qr_floor_trigger;

-- More checks (read only, paste one at a time):
-- 1. Every policy on the fenced tables:
-- select tablename, policyname, cmd, roles from pg_policies
--  where schemaname = 'public'
--    and tablename in ('devices','order_queue','kds_tickets','print_jobs','active_sessions','table_reservations','closed_checks','bar_tabs')
--  order by 1, 2;
-- 2. Raw anon key write grants left on them (expect 0 rows):
-- select c.relname, p from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  cross join unnest(array['INSERT','UPDATE','DELETE']) p
--  where n.nspname = 'public'
--    and c.relname in ('order_queue','kds_tickets','print_jobs','active_sessions','table_reservations','closed_checks','bar_tabs')
--    and has_table_privilege('anon', c.oid, p);


-- ============================================================================
-- ROLL BACK (only if the floor breaks; paste in the Ops SQL editor)
-- ============================================================================
-- Remove the "-- " at the start of each line, paste, Run. This puts back exactly the
-- open policies and grants this file removed, removes the ones it added, and can run
-- twice. File 1 may then be run again if ever needed.
-- It leaves the order_queue_qr_floor trigger in place on purpose: it only ever writes a
-- QR tab's own session on the floor plan, so it is safe next to the phone's own sync,
-- and once the release's cleanup has removed that sync it is the only thing keeping QR
-- tabs on the floor.
--
-- set lock_timeout = '3s';
-- drop policy if exists order_queue_staff on public.order_queue;
-- drop policy if exists kds_tickets_staff on public.kds_tickets;
-- drop policy if exists print_jobs_staff on public.print_jobs;
-- drop policy if exists active_sessions_staff on public.active_sessions;
-- drop policy if exists table_reservations_staff on public.table_reservations;
-- drop policy if exists closed_checks_insert_staff on public.closed_checks;
-- drop policy if exists "allow all" on public.order_queue;
-- drop policy if exists "allow all" on public.kds_tickets;
-- drop policy if exists "allow all" on public.active_sessions;
-- drop policy if exists "allow all" on public.table_reservations;
-- drop policy if exists "agent update" on public.print_jobs;
-- drop policy if exists "insert print jobs" on public.print_jobs;
-- drop policy if exists "read print jobs" on public.print_jobs;
-- drop policy if exists "insert closed checks" on public.closed_checks;
-- create policy "allow all" on public.order_queue for all to public using (true) with check (true);
-- create policy "allow all" on public.kds_tickets for all to public using (true) with check (true);
-- create policy "allow all" on public.active_sessions for all to public using (true) with check (true);
-- create policy "allow all" on public.table_reservations for all to public using (true) with check (true);
-- create policy "agent update" on public.print_jobs for update to public using (true);
-- create policy "insert print jobs" on public.print_jobs for insert to public with check (true);
-- create policy "read print jobs" on public.print_jobs for select to public using (true);
-- create policy "insert closed checks" on public.closed_checks for insert to public with check (true);
-- grant insert, update, delete on table public.order_queue, public.kds_tickets, public.print_jobs,
--   public.active_sessions, public.table_reservations, public.closed_checks, public.bar_tabs to anon;
-- delete from public.fence_state where key = 'file_b';
-- reset lock_timeout;
