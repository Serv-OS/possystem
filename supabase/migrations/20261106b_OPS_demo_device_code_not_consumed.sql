-- 20261106b_OPS_demo_device_code_not_consumed.sql
--
-- WHY. Apple's reviewer cannot pair the ServOS KDS. Guideline 2.1(a), 29 Oct 2026:
-- "The app cannot be verified using the provided code." The code we sent them is gone
-- from the database: public.devices for the demo KDS shows pairing_code null and the
-- device bound since 13 Oct. _device_claim_core clears pairing_code the first time a
-- code is used, and then refuses a device that is already bound. App Review's own
-- instructions tell them to uninstall and install again, so the second attempt could
-- never work, and nobody can hand them a fresh code mid review.
--
-- WHAT. At a venue flagged locations.is_demo, and ONLY there, a pairing code is a
-- standing invitation: the claim does not consume it, and a device already bound is
-- taken over by the new one. Anyone holding the code can pair again, for ever.
--
-- WHAT IT DOES NOT OPEN. Nothing changes for a trading venue. is_demo is false
-- everywhere by default and is set by hand (20261013a). The rate limit, the code format
-- fence and the expiry are all still enforced on the demo path. A demo code still has to
-- exist and still has to be in date.
--
-- The branch is added BEFORE the normal "live code on a free device" step and that step
-- is left exactly as it was, so a real till pairs down the same path as yesterday.
--
-- VERIFY AFTER RUNNING (read only):
--   select name, type, status, pairing_code, pairing_expires_at
--     from public.devices where location_id in (select id from public.locations where is_demo);
--   select at, event, detail from public.device_claim_log order by at desc limit 10;

CREATE OR REPLACE FUNCTION public._device_claim_core(p_code text, p_mint_secret boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- 3c. A DEMO VENUE: the code is a standing invitation, not a one shot.
  -- WHY (29 Oct 2026). App Review pairs the KDS, is told to uninstall and install again,
  -- and the second attempt fails: step 4 below clears pairing_code the first time it is
  -- used, and refuses a device that is already bound. A reviewer cannot ask a manager for
  -- a fresh code. At a venue flagged locations.is_demo, and only there, the code survives
  -- the claim and a bound device is taken over, so anyone holding the code can pair again
  -- for ever. Trading venues are untouched: is_demo is false everywhere by default.
  if v_row.id is not null
     and v_row.pairing_expires_at is not null and v_row.pairing_expires_at > now()
     and exists (select 1 from public.locations l where l.id = v_row.location_id and l.is_demo is true)
  then
    perform public._device_unbind_others(v_uid, v_row.id);
    delete from public.device_unlinked_pings where uid = v_uid or device_id = v_row.id;
    update public.devices
       set device_uid         = v_uid,
           bound_via          = 'demo_code',
           bound_at           = now(),
           status             = case when type = 'kiosk' then 'online' else 'active' end,
           paired_at          = now(),
           last_seen          = now(),
           session_token      = null,
           client_caps        = null,
           device_secret_hash = null,
           secret_issued_at   = null
           -- pairing_code and pairing_expires_at are deliberately left in place
     where id = v_row.id;
    if p_mint_secret then
      v_secret := public._device_mint_secret(v_row.id, v_uid);
    end if;
    perform public._fence_clear('claim:uid:' || v_uid::text);
    insert into public.device_claim_log (device_id, location_id, event, new_uid, detail)
    values (v_row.id, v_row.location_id, 'bound', v_uid, 'paired with a demo venue code (code kept)');
    perform set_config('servos.fence_bypass', 'off', true);
    return public._device_claim_result(v_row.id, false, v_secret);
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
$function$;

-- The demo KDS gets its code back, in date for a year. device_uid is cleared too, so the
-- FIRST pair works down the ordinary path as well, not only the demo branch above.
update public.devices
   set pairing_code       = 'SGX6-H7R3-92T9',
       pairing_expires_at = now() + interval '1 year',
       device_uid         = null,
       bound_via          = null,
       status             = 'unpaired',
       session_token      = null,
       device_secret_hash = null,
       secret_issued_at   = null
 where name = 'Apple Review KDS'
   and type = 'kds'
   and location_id in (select id from public.locations where is_demo is true);
