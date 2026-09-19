-- 20260919b_OPS_fence_2_after_app.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  DATABASE FENCE, STAGE 1, FILE 2 OF 2 (Ops).                              #
-- #  ONLY AFTER the app release in docs/FENCE_STAGE_1_APP.md is live on EVERY #
-- #  till, KDS, kiosk and clock, and on the customer pages. Outside service.  #
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
--     (place_public_order, settle_qr_tab, order_track_row, qr_* and catering_day_load),
--     each keyed to something the customer holds. QR tabs reach the floor plan through
--     a trigger, never from a phone.
--   * devices stops being readable by everyone: a till reads its own row, its venue's
--     devices and nothing else. Pairing codes are single use, made by the server, and
--     a till whose login changes re-links with its device secret only (the saved code
--     path from file 1 ends here).
--   * The raw anon key loses INSERT, UPDATE, DELETE on these tables. Print agents use
--     print_agent_claim and print_agent_report with a key from Back Office.
--
-- WHY IT WAITS FOR THE APP (see docs/FENCE_STAGE_1_APP.md): a till that briefly loses
-- its link must not wipe its pairing (gap B3), must show staff a banner, must keep its
-- unsent work and send it once the link is back (gaps G23, B1), and must re-link with
-- its device secret; the customer pages must use the new functions (gaps B2, B3, B12,
-- G4, G5, G6, G16, G17); the print agents need their key (gap G24).
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
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.devices') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS project (tbetcegmszzotrwdtqhi). This is not it. Nothing was changed.';
  end if;
  if to_regprocedure('public.place_public_order(uuid, jsonb, jsonb, uuid[])') is null
     or to_regclass('public.payment_proofs') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'devices' and column_name = 'bound_via') then
    raise exception 'Run 20260919a_OPS_fence_1_safe_now.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('public.online_kitchen_load(text)') is null then
    raise exception 'online_kitchen_load(text) is missing (20260902_online_kitchen_load.sql). The storefront busy time needs it once order_queue is closed. Nothing was changed.';
  end if;

  -- Every active till, KDS, kiosk and clock must be running the release (it reports
  -- fence_v1 through device_heartbeat) and be linked by a claim.
  select count(*),
         string_agg(format('%s: %s (%s)%s', coalesce(l.name, 'no venue'), d.name, coalesce(d.type, '?'),
                           case when d.bound_via is null then ', not paired'
                                when not coalesce(d.client_caps @> array['fence_v1'], false) then ', old app'
                                else '' end), '; ' order by l.name, d.name)
    into v_n, v_list
    from public.devices d
    left join public.locations l on l.id = d.location_id
   where d.status in ('active', 'online')
     and (d.bound_via is null or not coalesce(d.client_caps @> array['fence_v1'], false));
  if v_n > 0 then
    raise exception 'STOPPED, NOTHING WAS CHANGED. % device(s) are not ready: %. Switch each one on and let it load the new app for 2 minutes (or pair it again). If a device is not used any more, press Remove in Back Office. Then run this file again.', v_n, v_list;
  end if;

  -- The customer pages must be placing orders through place_public_order. Any online,
  -- QR or catering order in the last 24 hours written straight into the table means an
  -- old page is still out there.
  select count(*) into v_n
    from public.order_queue q
   where q.source in ('online', 'qr', 'catering')
     and q.created_at > now() - interval '24 hours'
     and q.placed_via is distinct from 'rpc';
  if v_n > 0 then
    raise exception 'STOPPED, NOTHING WAS CHANGED. % online, QR or catering order(s) in the last 24 hours were written by the old customer pages. Wait until the new pages have been live for a full day with no old orders, then run this file again.', v_n;
  end if;
end
$guard$;


-- ============================================================================
-- 1. devices: final shape
-- ============================================================================

-- 1a. Codes are single use, made by the server, and there is no more re-link by code.
delete from public.device_heal_codes;

-- 1b. The claim core without the saved code path (only claim by live code, or the
-- same till again). Same signature as file 1, so claim_device, claim_device_v2 and
-- the rest keep calling it.
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
  v_secret  text := null;
  v_bucket  text;
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
  if public._fence_is_locked(v_bucket) or public._fence_is_locked('claim:global') then
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_refusal('locked', 'Too many pairing attempts. Wait 15 minutes and try again.');
  end if;
  if v_row.id is null then
    perform public._fence_count(v_bucket, 6, interval '10 minutes', interval '15 minutes');
    perform public._fence_count('claim:global', 40, interval '10 minutes', interval '10 minutes');
    insert into public.device_claim_log (event, new_uid, detail) values ('refused_not_found', v_uid, 'code not found');
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_refusal('not_found', 'Pairing code not found or already used. Issue a new code in Back Office.');
  end if;
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
  perform public._fence_clear(v_bucket);
  insert into public.device_claim_log (device_id, location_id, event, new_uid, detail)
  values (v_row.id, v_row.location_id, 'bound', v_uid, 'paired with a Back Office code');
  perform set_config('servos.fence_bypass', 'off', true);
  return public._device_claim_result(v_row.id, false, v_secret);
end;
$fn$;
revoke all on function public._device_claim_core(text, boolean) from public, anon, authenticated;

-- 1c. Codes typed into Back Office are replaced by a server code (about 60 bits) unless
-- issue_pairing_code made it. The Back Office shows the code the database returns
-- (contract P1). Everything else in the trigger is unchanged from file 1.
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
  if public._fence_bypass() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    return old;
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

  if new.pairing_code is not null
     and (tg_op = 'INSERT' or new.pairing_code is distinct from old.pairing_code) then
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

-- 1d. Reads: a till sees its own row and its venue's devices (the status drawer lists
-- the venue's KDS screens); Back Office sees its venues; super admin sees all. No
-- stranger sees any row, so no pairing code is ever readable (gap B1).
drop policy if exists devices_read on public.devices;
create policy devices_read on public.devices
  for select
  using (device_uid = (select auth.uid())
         or location_id in (select public.pos_accessible_location_ids())
         or (select public.is_super_admin()));
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
-- only on a status or items change, never failing the order write.
drop trigger if exists order_queue_qr_floor on public.order_queue;
create trigger order_queue_qr_floor
  after insert or delete or update of status, items on public.order_queue
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
-- of the venue; customer pages go through place_public_order and settle_qr_tab.
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
-- Expect: open_policies_left = none; names_on_order_screens = true; devices_readable_by_all = false.
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
  (select count(*) from public.device_heal_codes)                                                 as saved_codes_left,
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
-- This puts back exactly the open policies and grants this file removed. The new
-- policies can stay (they only ever add access next to "allow all").
--
-- set lock_timeout = '3s';
-- create policy "allow all" on public.order_queue for all to public using (true) with check (true);
-- create policy "allow all" on public.kds_tickets for all to public using (true) with check (true);
-- create policy "allow all" on public.active_sessions for all to public using (true) with check (true);
-- create policy "allow all" on public.table_reservations for all to public using (true) with check (true);
-- create policy "agent update" on public.print_jobs for update to public using (true);
-- create policy "insert print jobs" on public.print_jobs for insert to public with check (true);
-- create policy "read print jobs" on public.print_jobs for select to public using (true);
-- create policy "insert closed checks" on public.closed_checks for insert to public with check (true);
-- create policy devices_read_interim on public.devices for select using (true);
-- grant insert, update, delete on table public.order_queue, public.kds_tickets, public.print_jobs,
--   public.active_sessions, public.table_reservations, public.closed_checks, public.bar_tabs to anon;
-- reset lock_timeout;
--
-- Leave the order_queue_qr_floor trigger in place: the new customer pages no longer
-- sync QR tabs to the floor plan themselves, the trigger does.
-- The saved codes deleted in 1a do not come back: a till whose login changed re-links
-- with its device secret, or is paired again. To go back to browser made codes and the
-- saved code re-link as well, re-run sections 6c and 6f of 20260919a (both are
-- create or replace).
