-- DRAFT, DO NOT RUN (8 Sep 2026). The adversarial pass found 12 breaks and 25 gaps that are NOT applied yet;
-- they are listed at the end of docs/PRE_LIVE_SECURITY_MIGRATIONS.md. A fix pass must land before this file is run.

-- 20260907b_ops_rls_2_pairing.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Run this file SECOND, after 20260907b_ops_rls_1_fences_and_rpcs.sql.     #
-- #  No app change is required, BUT read "WHAT CHANGES ON THE FLOOR" below:   #
-- #  every device that never ran claim_device must be re-paired right after. #
-- ############################################################################
--
-- WHAT THIS FILE CLOSES (PRE_STAGE_READINESS.md finding 4 / blocker 11)
--   * claim_device(p_code) matched ANY device whose status <> 'removed',
--     including active tills, and silently overwrote device_uid, so a guessed
--     code stole a live till's RLS identity. It had no expiry, no attempt
--     counter, and never cleared the code. All 14 active devices still carried
--     their code.
--   * devices had a single "allow all" policy: any key could read all pairing
--     codes and session tokens, rewrite location_id / device_uid on any row, or
--     delete a till. devices is the trust anchor of pos_can_access(), so until
--     it is fenced every pos_can_access policy in the database can be defeated
--     by forging a row.
--
-- WHAT IT DOES
--   A. columns: pairing_expires_at, device_secret_hash, secret_issued_at
--   B. device_claim_attempts: per caller miss counter with a 5 minute lockout
--      (the terminal_staff_login pattern)
--   C. _device_gen_pairing_code(): 12 character server side code, 32 symbol
--      unambiguous alphabet, about 60 bits (the browser's genCode is 10 x 9000)
--   D. trigger devices_pairing_code_issued: whenever a code is set or changed
--      the row gets a 4 hour expiry and loses its binding (device_uid, secret,
--      paired_at). Regenerate in Back Office therefore MOVES a device.
--   E. trigger devices_anon_guard: an anonymous session may only change
--      status, last_seen, paired_at, session_token, app_version and may clear
--      pairing_code. Everything else (location_id, device_uid, type, name,
--      profile_id, centre_id, receipt_printer_id, the new columns) is Back
--      Office only. Belt and braces under the policies.
--   F. claim_device(text): same signature, same return, new rules:
--        - bound to this session already   -> idempotent, returns location
--        - bound to another session        -> REFUSED, returns NULL (no theft)
--        - unbound, code live              -> binds, clears the code (single use)
--        - unbound, code expired or absent -> refused, returns NULL
--        - every refusal counts as a miss; 5 misses = 5 minute lock (raises)
--      claim_device_v2 returns {ok:false, reason, message} on a refusal so the
--      app can show why (reason is not_found, already_paired or expired).
--      claim_device_v2(text) does the same and also mints a device secret the
--      app can store, and reclaim_device(uuid, text) re binds with that secret
--      when the anonymous uid rotates, without a code. issue_pairing_code(uuid)
--      lets the Back Office mint a server side code.
--   G. devices policies: own row, or a paired device / Back Office user at the
--      same venue, or super admin. One INTERIM arm stays for the pre claim read
--      by code that PairingScreen.jsx:18 and KioskSurface.jsx:56 do today:
--      an anonymous session can read an UNBOUND row with a LIVE code. File 3
--      removes that arm once both screens use claim_device_v2.
--   H. data: codes on bound devices are cleared (they never needed one again);
--      legacy codes on unbound devices get a 7 day expiry so they can be
--      re-paired from the code the Back Office already shows.
--
-- WHAT CHANGES ON THE FLOOR (read before applying)
--   * A device whose devices row has device_uid = NULL (the readiness audit
--     counted 8, of which 6 were active or online) can no longer read its own
--     row. On its next device refresh the POS treats that as "device removed"
--     and shows the pairing screen. That is the loud failure Gate 1 asks for.
--     Fix: Back Office -> Devices -> show / regenerate the code, type it on the
--     till. The claim then binds the row and everything resumes.
--   * A till whose anonymous uid has rotated since it paired (rare: cleared
--     site data, revoked refresh token) is in the same position: regenerate
--     the code in Back Office and re-pair. Until the app stores the device
--     secret from claim_device_v2 this cannot self heal.
--   * Re-pairing a device now REQUIRES a fresh code from Back Office (the old
--     code is gone from the row). "Show code" on a paired device shows nothing;
--     press Regenerate.
--   * Codes issued from Back Office expire 4 hours after they are issued.
--   * The browser still generates the code text (DeviceRegistry.jsx:23,
--     KioskRegistry.jsx:28). Its weak 90,000 value space is tolerable for
--     now ONLY because codes are single use, expire in 4 hours, and each
--     anonymous uid is locked after 5 misses. File 3 makes the database
--     replace browser codes with server codes once the Back Office shows the
--     code from the returned row (two one line app changes, see the runbook).
--
-- RULES OF THE FILE: bare idempotent statements, no begin / commit, drop policy
-- if exists before create, create or replace for functions, verification at
-- the bottom.


-- ============================================================================
-- 0. Guards
-- ============================================================================
do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS DB (tbetcegmszzotrwdtqhi). This is not it. Aborting.';
  end if;
  if to_regprocedure('public.pos_accessible_location_ids()') is null then
    raise exception 'Run 20260907b_ops_rls_1_fences_and_rpcs.sql first (pos_accessible_location_ids() is missing).';
  end if;
end
$guard$;

-- Tell the operator which devices will bounce to the pairing screen.
do $notice$
declare
  r record;
  n int := 0;
begin
  for r in
    select id, name, type, status, location_id
      from public.devices
     where device_uid is null and status in ('active', 'online')
     order by name
  loop
    n := n + 1;
    raise notice 'UNBOUND ACTIVE DEVICE (will need re-pair): % [%] % at location %', r.name, r.type, r.id, r.location_id;
  end loop;
  raise notice '% active/online device(s) have no device_uid and must be re-paired after this file.', n;
end
$notice$;


-- ============================================================================
-- A. Columns
-- ============================================================================
alter table public.devices add column if not exists pairing_expires_at timestamptz;
alter table public.devices add column if not exists device_secret_hash text;
alter table public.devices add column if not exists secret_issued_at  timestamptz;

comment on column public.devices.pairing_expires_at is 'Set by trigger when pairing_code is issued (now + 4h). NULL once claimed.';
comment on column public.devices.device_secret_hash is 'sha256 hex of the secret returned once by claim_device_v2; used by reclaim_device when the anonymous uid rotates.';


-- ============================================================================
-- B. Per caller miss counter
-- ============================================================================
-- Keyed by auth.uid(). An attacker can mint anonymous uids, so this is not the
-- real defence (entropy and expiry are); it stops naive loops and makes the
-- limit explicit. Anonymous sign ins are also rate limited by Supabase Auth.
create table if not exists public.device_claim_attempts (
  uid          uuid primary key,
  fail_count   integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.device_claim_attempts enable row level security;
revoke all on table public.device_claim_attempts from public, anon, authenticated;
grant  all on table public.device_claim_attempts to service_role;

-- Internal: count a miss for the caller. 5 misses = 5 minute lock, then the
-- counter restarts clean (terminal_staff_login shape).
create or replace function public._device_claim_miss()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.device_claim_attempts (uid) values (auth.uid())
  on conflict (uid) do nothing;
  update public.device_claim_attempts
     set fail_count   = fail_count + 1,
         locked_until = case when fail_count + 1 >= 5 then now() + interval '5 minutes' else locked_until end,
         updated_at   = now()
   where uid = auth.uid();
  update public.device_claim_attempts
     set fail_count = 0
   where uid = auth.uid() and locked_until is not null and locked_until > now();
end;
$fn$;

create or replace function public._device_claim_check_lock()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_until timestamptz;
begin
  select locked_until into v_until from public.device_claim_attempts where uid = auth.uid();
  if v_until is not null and v_until > now() then
    raise exception 'too many pairing attempts, try again in a few minutes';
  end if;
end;
$fn$;

revoke all on function public._device_claim_miss()       from public, anon, authenticated;
revoke all on function public._device_claim_check_lock() from public, anon, authenticated;


-- ============================================================================
-- C. Server side code generator
-- ============================================================================
-- 12 symbols from a 32 symbol alphabet (no 0 O 1 I), shown as XXXX-XXXX-XXXX.
-- Bytes come from gen_random_uuid() (core Postgres, no pgcrypto dependency);
-- 256 is an exact multiple of 32 so `byte mod 32` is uniform.
create or replace function public._device_gen_pairing_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code  text;
  v_i     int;
begin
  loop
    v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    v_code := '';
    for v_i in 0..11 loop
      v_code := v_code || substr(v_alpha, (get_byte(v_bytes, v_i) % 32) + 1, 1);
    end loop;
    v_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4);
    exit when not exists (select 1 from public.devices d where d.pairing_code = v_code);
  end loop;
  return v_code;
end;
$fn$;

revoke all on function public._device_gen_pairing_code() from public, anon, authenticated;


-- ============================================================================
-- D. Trigger: issuing a code resets the binding and starts the clock
-- ============================================================================
-- Fires for the Back Office INSERT (DeviceRegistry.jsx:166, KioskRegistry.jsx:84)
-- and the regenerate UPDATEs (DeviceRegistry.jsx:207, KioskRegistry.jsx:108),
-- and for issue_pairing_code() below. A code being CLEARED (claim, or
-- KioskSurface.jsx:83) drops the expiry. File 3 upgrades this trigger to also
-- replace a browser generated code with a server one.
create or replace function public.devices_pairing_code_issued_tg()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.pairing_code is not null
     and (tg_op = 'INSERT' or new.pairing_code is distinct from old.pairing_code) then
    new.pairing_code       := upper(btrim(new.pairing_code));
    new.pairing_expires_at := now() + interval '4 hours';
    new.device_uid         := null;
    new.device_secret_hash := null;
    new.secret_issued_at   := null;
    new.paired_at          := null;
  elsif tg_op = 'UPDATE' and new.pairing_code is null and old.pairing_code is not null then
    new.pairing_expires_at := null;
  end if;
  return new;
end;
$fn$;

drop trigger if exists devices_pairing_code_issued on public.devices;
create trigger devices_pairing_code_issued
  before insert or update on public.devices
  for each row execute function public.devices_pairing_code_issued_tg();


-- ============================================================================
-- E. Trigger: what an anonymous session may change about a device
-- ============================================================================
-- Allowed for the device's own anonymous session (App.jsx:647/:662 kick token,
-- db.js:861 heartbeat, KioskSurface.jsx:83, PairingScreen.jsx:30):
--   status, last_seen, paired_at, session_token, app_version, pairing_code -> NULL
-- Everything else is Back Office only. claim_device and reclaim_device set a
-- transaction local flag so their own writes pass.
create or replace function public.devices_anon_guard_tg()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(current_setting('rpos.device_claim', true), '') = '1' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if not public.is_anon_session() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'devices: an anonymous session cannot register a device' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'devices: an anonymous session cannot remove a device' using errcode = '42501';
  end if;
  if new.id                 is distinct from old.id
     or new.location_id        is distinct from old.location_id
     or new.device_uid         is distinct from old.device_uid
     or new.type               is distinct from old.type
     or new.name               is distinct from old.name
     or new.profile_id         is distinct from old.profile_id
     or new.centre_id          is distinct from old.centre_id
     or new.receipt_printer_id is distinct from old.receipt_printer_id
     or new.pairing_expires_at is distinct from old.pairing_expires_at
     or new.device_secret_hash is distinct from old.device_secret_hash
     or new.secret_issued_at   is distinct from old.secret_issued_at
     or new.created_at         is distinct from old.created_at
     or (new.pairing_code is not null and new.pairing_code is distinct from old.pairing_code) then
    raise exception 'devices: this column can only be changed from the Back Office' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists devices_anon_guard on public.devices;
create trigger devices_anon_guard
  before insert or update or delete on public.devices
  for each row execute function public.devices_anon_guard_tg();


-- ============================================================================
-- F. claim_device family
-- ============================================================================

-- Shared core. Returns a jsonb object or raises. p_mint_secret=true also
-- issues a fresh device secret (returned once, stored hashed).
create or replace function public._claim_device_core(p_code text, p_mint_secret boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v        public.devices%rowtype;
  v_code   text := upper(btrim(coalesce(p_code, '')));
  v_secret text := null;
  v_loc    public.locations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'no auth session';
  end if;
  if v_code = '' then
    return null;
  end if;

  perform public._device_claim_check_lock();

  select * into v
    from public.devices
   where pairing_code = v_code and status <> 'removed'
   limit 1
   for update;

  -- REFUSALS RETURN, THEY DO NOT RAISE. A RAISE rolls back the whole call,
  -- including the miss just counted, so a brute force loop would never trip
  -- the lockout. claim_device turns ok=false into NULL for the legacy callers;
  -- claim_device_v2 hands the reason to the app.
  if v.id is null then
    perform public._device_claim_miss();
    return jsonb_build_object('ok', false, 'reason', 'not_found',
                              'message', 'pairing code not found');
  end if;

  -- Same session again: idempotent, nothing to change.
  if v.device_uid = auth.uid() then
    perform set_config('rpos.device_claim', '1', true);
    update public.devices set last_seen = now() where id = v.id;
    select * into v_loc from public.locations where id = v.location_id;
    return jsonb_build_object(
      'ok', true, 'already_bound', true,
      'device_id', v.id, 'location_id', v.location_id, 'name', v.name, 'type', v.type,
      'profile_id', v.profile_id, 'centre_id', v.centre_id, 'receipt_printer_id', v.receipt_printer_id,
      'location', case when v_loc.id is null then null else jsonb_build_object('id', v_loc.id, 'name', v_loc.name, 'org_id', v_loc.org_id) end
    );
  end if;

  -- Bound to a different session: never steal. A bound row's code is cleared
  -- on claim and only comes back when the Back Office regenerates it, which
  -- also clears device_uid. So reaching here means a replayed or guessed code.
  if v.device_uid is not null then
    perform public._device_claim_miss();
    return jsonb_build_object('ok', false, 'reason', 'already_paired',
                              'message', 'this device is already paired to another till. Regenerate its pairing code in Back Office to move it.');
  end if;

  -- Unbound: the code must be live.
  if v.pairing_expires_at is null or v.pairing_expires_at <= now() then
    perform public._device_claim_miss();
    return jsonb_build_object('ok', false, 'reason', 'expired',
                              'message', 'pairing code expired. Regenerate it in Back Office.');
  end if;

  if p_mint_secret then
    v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  end if;

  perform set_config('rpos.device_claim', '1', true);
  update public.devices
     set device_uid         = auth.uid(),
         status             = case when type = 'kiosk' then 'online' else 'active' end,
         paired_at          = now(),
         last_seen          = now(),
         session_token      = null,
         pairing_code       = null,
         pairing_expires_at = null,
         device_secret_hash = case when v_secret is null then device_secret_hash else encode(sha256(convert_to(v_secret, 'UTF8')), 'hex') end,
         secret_issued_at   = case when v_secret is null then secret_issued_at else now() end
   where id = v.id;

  update public.device_claim_attempts
     set fail_count = 0, locked_until = null, updated_at = now()
   where uid = auth.uid();

  select * into v_loc from public.locations where id = v.location_id;
  return jsonb_build_object(
    'ok', true, 'already_bound', false,
    'device_id', v.id, 'location_id', v.location_id, 'name', v.name, 'type', v.type,
    'profile_id', v.profile_id, 'centre_id', v.centre_id, 'receipt_printer_id', v.receipt_printer_id,
    'device_secret', v_secret,
    'location', case when v_loc.id is null then null else jsonb_build_object('id', v_loc.id, 'name', v_loc.name, 'org_id', v_loc.org_id) end
  );
end;
$fn$;

revoke all on function public._claim_device_core(text, boolean) from public, anon, authenticated;

-- Same name, same signature, same return type as the live function, so the
-- three existing callers (PairingScreen.jsx:43, KioskSurface.jsx:76,
-- supabase.js:187) keep working unchanged. Only the rules changed.
create or replace function public.claim_device(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r jsonb;
begin
  r := public._claim_device_core(p_code, false);
  if r is null or coalesce((r->>'ok')::boolean, false) = false then return null; end if;
  return (r->>'location_id')::uuid;
end;
$fn$;

-- For the app change: returns the row fields the client stores in rpos-device
-- plus a one time device_secret. Replaces the pre claim SELECT by code AND
-- the pre claim UPDATE in PairingScreen / KioskSurface.
create or replace function public.claim_device_v2(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return public._claim_device_core(p_code, true);
end;
$fn$;

-- Boot re bind without a code, for claimPairedDeviceOnBoot once it stores the
-- secret. A wrong secret counts as a miss and is rate limited like a code.
create or replace function public.reclaim_device(p_device_id uuid, p_device_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v public.devices%rowtype;
begin
  if auth.uid() is null then
    raise exception 'no auth session';
  end if;
  perform public._device_claim_check_lock();

  select * into v from public.devices where id = p_device_id and status <> 'removed' for update;
  if v.id is null
     or v.device_secret_hash is null
     or coalesce(p_device_secret, '') = ''
     or v.device_secret_hash <> encode(sha256(convert_to(p_device_secret, 'UTF8')), 'hex') then
    perform public._device_claim_miss();
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  perform set_config('rpos.device_claim', '1', true);
  update public.devices set device_uid = auth.uid(), last_seen = now() where id = v.id;
  update public.device_claim_attempts set fail_count = 0, locked_until = null, updated_at = now() where uid = auth.uid();
  return jsonb_build_object('ok', true, 'device_id', v.id, 'location_id', v.location_id, 'status', v.status);
end;
$fn$;

-- Back Office: mint a server side code for a device you can manage. The
-- trigger in D resets the binding and sets the expiry; the transaction flag
-- tells file 3's upgraded trigger not to replace the code we just chose.
create or replace function public.issue_pairing_code(p_device_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v      public.devices%rowtype;
  v_code text;
begin
  if auth.uid() is null or public.is_anon_session() then
    raise exception 'issue_pairing_code: Back Office session required';
  end if;
  select * into v from public.devices where id = p_device_id;
  if v.id is null then
    raise exception 'issue_pairing_code: device not found';
  end if;
  if not (public.is_super_admin() or v.location_id::text in (select public.user_accessible_locations())) then
    raise exception 'issue_pairing_code: no access to this device''s location';
  end if;
  v_code := public._device_gen_pairing_code();
  perform set_config('rpos.device_issue', '1', true);
  update public.devices
     set pairing_code  = v_code,
         status        = case when type = 'kiosk' then 'awaiting_pairing' else 'unpaired' end,
         session_token = null
   where id = v.id;
  return v_code;
end;
$fn$;

-- public must be named explicitly (default EXECUTE to PUBLIC on new functions).
-- The raw anon key cannot claim: every caller has a session (ensureAuthToken
-- runs first at PairingScreen.jsx:42 and KioskSurface.jsx:75).
revoke all on function public.claim_device(text)              from public, anon;
revoke all on function public.claim_device_v2(text)           from public, anon;
revoke all on function public.reclaim_device(uuid, text)      from public, anon;
revoke all on function public.issue_pairing_code(uuid)        from public, anon;
grant execute on function public.claim_device(text)           to authenticated, service_role;
grant execute on function public.claim_device_v2(text)        to authenticated, service_role;
grant execute on function public.reclaim_device(uuid, text)   to authenticated, service_role;
grant execute on function public.issue_pairing_code(uuid)     to authenticated, service_role;


-- ============================================================================
-- G. devices policies
-- ============================================================================
alter table public.devices enable row level security;
drop policy if exists "allow all"     on public.devices;
drop policy if exists devices_select  on public.devices;
drop policy if exists devices_insert  on public.devices;
drop policy if exists devices_update  on public.devices;
drop policy if exists devices_delete  on public.devices;

-- SELECT: own row; any device or Back Office user at the same venue (tills list
-- their KDS peers, StatusDrawer.jsx:49; Back Office registry); super admin;
-- and the INTERIM anonymous arm: an unbound row with a live code, so
-- PairingScreen.jsx:18 / KioskSurface.jsx:56 can still look the code up before
-- claiming. File 3 removes that arm.
create policy devices_select on public.devices
  for select
  using (
    device_uid = auth.uid()
    or location_id in (select public.pos_accessible_location_ids())
    or public.is_super_admin()
    or (
      public.is_anon_session()
      and device_uid is null
      and pairing_code is not null
      and pairing_expires_at > now()
      and status <> 'removed'
    )
  );

-- INSERT: Back Office at a location you manage, or super admin. Never anonymous.
create policy devices_insert on public.devices
  for insert
  with check (
    public.is_super_admin()
    or (not public.is_anon_session() and location_id::text in (select public.user_accessible_locations()))
  );

-- UPDATE: own row (column set limited by the E trigger), Back Office at the
-- location, super admin. The pre claim UPDATE in PairingScreen.jsx:30 now
-- matches 0 rows silently; claim_device performs the same changes.
create policy devices_update on public.devices
  for update
  using (
    device_uid = auth.uid()
    or public.is_super_admin()
    or (not public.is_anon_session() and location_id::text in (select public.user_accessible_locations()))
  )
  with check (
    device_uid = auth.uid()
    or public.is_super_admin()
    or (not public.is_anon_session() and location_id::text in (select public.user_accessible_locations()))
  );

-- DELETE: Back Office at the location, or super admin.
create policy devices_delete on public.devices
  for delete
  using (
    public.is_super_admin()
    or (not public.is_anon_session() and location_id::text in (select public.user_accessible_locations()))
  );


-- ============================================================================
-- H. Data: retire the legacy codes
-- ============================================================================
-- Bound devices keep working with no code (boot re claim is a no op for the
-- same uid; a rotated uid needs a regenerate anyway). Unbound devices keep the
-- code the Back Office already shows, with a 7 day window to re-pair.
update public.devices
   set pairing_code = null
 where device_uid is not null
   and pairing_code is not null;

update public.devices
   set pairing_expires_at = now() + interval '7 days'
 where device_uid is null
   and pairing_code is not null
   and status <> 'removed';


-- ============================================================================
-- V. Verification (read only, paste after applying)
-- ============================================================================
-- 1. Policies on devices (expect devices_select / insert / update / delete, no "allow all"):
-- select policyname, cmd, qual from pg_policies where tablename = 'devices' order by policyname;
--
-- 2. Triggers present (expect devices_anon_guard, devices_pairing_code_issued):
-- select tgname from pg_trigger where tgrelid = 'public.devices'::regclass and not tgisinternal order by 1;
--
-- 3. claim family EXECUTE (expect anon false, authenticated true for the four; core and helpers false/false):
-- select p.proname,
--        has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
--        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('claim_device','claim_device_v2','reclaim_device','issue_pairing_code',
--                      '_claim_device_core','_device_gen_pairing_code','_device_claim_miss','_device_claim_check_lock')
--  order by 1;
--
-- 4. No bound device still carries a code (expect 0):
-- select count(*) from public.devices where device_uid is not null and pairing_code is not null;
--
-- 5. Devices that must be re-paired now (each row here bounces to the pairing screen):
-- select id, name, type, status, location_id, pairing_code, pairing_expires_at
--   from public.devices where device_uid is null and status <> 'removed' order by name;
--
-- 6. Live smoke test after re-pairing: as the till, select count(*) from public.devices
--    should return the venue's devices and nothing else; as a fresh anonymous
--    session (no device) it should return 0 rows unless a code is live.
--
-- 7. A wrong code five times from one anonymous session must return
--    'too many pairing attempts' on the sixth call:
-- select public.claim_device('NOPE-NOPE-0000');
