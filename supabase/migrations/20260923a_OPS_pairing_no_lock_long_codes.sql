-- 20260923a_OPS_pairing_no_lock_long_codes.sql
--
-- PAIRING A TILL MUST NEVER BE THE THING THAT STOPS A VENUE OPENING.
--
-- Peter, 23 Sep 2026, the day before 20 venues go live, from his own venue:
--   "too many pairing attempts please try again! we need to remove that"
--   "and make it so they dont expire after 60 mins"
--
-- The 19 Sep fence gave pairing codes a 60 minute life and locked a session for
-- 15 minutes after 6 wrong tries. Both are the right instinct against a stranger
-- guessing codes, and both are wrong against the person actually setting up a
-- venue: a code is 12 symbols from a 30 symbol alphabet (about 60 bits), single
-- use, and cleared the moment it is claimed. Nobody guesses that in a year, let
-- alone in an hour, so the hour bought nothing and cost a manager a trip back to
-- Back Office; and the lock caught Peter himself on 23 Sep, not an attacker.
--
-- WHAT THIS DOES
--   1. The pairing lock is switched off. Attempts are still COUNTED (fence_attempts
--      keeps its audit trail), they just never lock anyone out. Every other fence
--      bucket (orders, wallets, print agents) is untouched.
--   2. A new pairing code lasts a year. NULL still means "no live code", which is
--      why "never" is a far date rather than a null.
--   3. Codes that are live right now are extended to a year too, and any pairing
--      lock in force right now is released.
--
-- Additive only. Nothing is dropped. Safe to run while venues trade.

begin;

-- 1. The pairing lock is off. Counting continues; locking does not.
create or replace function public._fence_is_locked(p_bucket text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select case
           when p_bucket like 'claim:%' then false   -- pairing never locks (23 Sep 2026)
           else exists (select 1 from public.fence_attempts a where a.bucket = p_bucket and a.locked_until > now())
         end;
$fn$;
comment on function public._fence_is_locked(text) is
  'True when a fence bucket is locked. Pairing buckets (claim:*) never lock: attempts are counted for the audit trail only (23 Sep 2026).';

-- 2. A new pairing code lasts a year.
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
    -- A new code means "pair this again": it lasts a YEAR (23 Sep 2026, was 60 minutes)
    -- and drops the old link. NULL still means "no live code", so "never" is a far date.
    -- Only issue_pairing_code keeps its own code; any other code (an old Back Office tab
    -- that makes codes in the browser) is replaced by a server code, which that tab
    -- shows after a reload. So a code is always about 60 bits and never guessable.
    if coalesce(current_setting('servos.device_issue', true), '') = 'on' then
      new.pairing_code := upper(btrim(new.pairing_code));
    else
      new.pairing_code := public._device_gen_pairing_code();
    end if;
    new.pairing_expires_at := now() + interval '1 year';
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

comment on column public.devices.pairing_expires_at is
  'A pairing code works until this time (a year after Back Office issued it, since 23 Sep 2026; was 60 minutes). NULL = no live code.';

-- 3. What is live right now: extend the codes, release the locks.
update public.devices
   set pairing_expires_at = now() + interval '1 year'
 where pairing_code is not null
   and pairing_expires_at is not null
   and pairing_expires_at > now()
   and pairing_expires_at < now() + interval '1 year';

update public.fence_attempts
   set locked_until = null
 where bucket like 'claim:%' and locked_until is not null;

commit;
