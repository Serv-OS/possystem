-- register_terminal_device: a registration guard that forgets stale rows.
-- OPS project (tbetcegmszzotrwdtqhi).
--
-- The guard in 20260722c_terminal_rpcs.sql refuses a new registration with
-- 'too many pending registrations for this device' once auth.uid() holds 5
-- or more terminal_devices rows with status unpaired, whatever their age. The
-- browser demo reader (src/surfaces/ReaderDemoSurface.jsx) mints DEMO-<serial>
-- per browser profile, so unpaired rows pile up across browsers and profiles
-- and the fifth one locks the uid out for good (8 Sep 2026).
--
-- Same function, same body as 20260722c (the live definition, read off
-- 000_baseline_ops.sql) with two changes:
--   (a) the guard counts only unpaired rows seen within the last 24 hours
--       (coalesce(last_seen_at, created_at): a row is always stamped on
--       insert and refreshed on every re-registration);
--   (b) before the guard, this uid's unpaired rows not seen for 7 days are
--       deleted (never a paired or retired row, never a row a terminal_jobs
--       row still names).
-- Signature, security definer, search_path and grants copied from the live
-- definition. Idempotent, bare statements, no transaction wrapper.

create or replace function public.register_terminal_device(p_serial text, p_app_version text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_serial text := btrim(coalesce(p_serial, ''));
  v_row    terminal_devices;
  v_code   text;
  v_open   integer;
begin
  if v_uid is null then raise exception 'no session'; end if;
  if v_serial = '' then raise exception 'serial required'; end if;
  if length(v_serial) > 64 then raise exception 'serial too long'; end if;

  -- Already paired to THIS device_uid: re-adopt (app restart / reboot).
  select * into v_row from terminal_devices
   where serial_number = v_serial and device_uid = v_uid and status = 'paired' and active
   limit 1;
  if v_row.id is not null then
    update terminal_devices
       set app_version = coalesce(p_app_version, app_version), last_seen_at = now(), updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('device_id', v_row.id, 'claim_code', null, 'status', 'paired',
                              'location_id', v_row.location_id, 'label', v_row.label);
  end if;

  -- Already registered-but-unpaired by THIS device_uid: return the SAME code
  -- (idempotent: a retry must not churn the code the operator is reading).
  select * into v_row from terminal_devices
   where serial_number = v_serial and device_uid = v_uid and status = 'unpaired'
   order by created_at desc limit 1;
  if v_row.id is not null then
    -- Refresh the TTL clock so a terminal left on the pairing screen stays claimable.
    update terminal_devices
       set app_version = coalesce(p_app_version, app_version), last_seen_at = now(), updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('device_id', v_row.id, 'claim_code', v_row.claim_code, 'status', 'unpaired',
                              'location_id', null, 'label', v_row.label);
  end if;

  -- Sweep (8 Sep 2026): this uid's unpaired rows nobody has seen for 7 days
  -- are gone for good (a paired or retired row is never touched, nor a row
  -- a terminal_jobs row still names).
  delete from terminal_devices t
   where t.device_uid = v_uid
     and t.status = 'unpaired'
     and coalesce(t.last_seen_at, t.created_at) < now() - interval '7 days'
     and not exists (select 1 from terminal_jobs j where j.target_terminal_id = t.id);

  -- Cheap abuse guard: one auth.uid() has no legitimate reason to hold a pile of
  -- pending registrations. (Anonymous sessions are free to mint, so bound them.)
  -- Only rows seen in the last 24 hours count (8 Sep 2026): stale demo readers
  -- from other browsers used to lock a uid out for good.
  select count(*) into v_open from terminal_devices
   where device_uid = v_uid
     and status = 'unpaired'
     and coalesce(last_seen_at, created_at) >= now() - interval '24 hours';
  if v_open >= 5 then raise exception 'too many pending registrations for this device'; end if;

  -- Fresh unpaired row. Retry on the (astronomically unlikely) code collision.
  for i in 1..5 loop
    v_code := _terminal_gen_code();
    begin
      insert into terminal_devices (device_uid, serial_number, claim_code, status, app_version, last_seen_at)
      values (v_uid, v_serial, v_code, 'unpaired', p_app_version, now())
      returning * into v_row;
      exit;
    exception when unique_violation then
      v_row := null; -- code clash: try again
    end;
  end loop;
  if v_row.id is null then raise exception 'could not allocate a pairing code'; end if;

  return jsonb_build_object('device_id', v_row.id, 'claim_code', v_row.claim_code, 'status', 'unpaired',
                            'location_id', null, 'label', v_row.label);
end; $$;

-- Grants as the live definition has them (000_baseline_ops.sql): the terminal
-- registers on an anonymous session, so anon stays in.
revoke all on function public.register_terminal_device(p_serial text, p_app_version text) from public, anon, authenticated, service_role;
grant execute on function public.register_terminal_device(p_serial text, p_app_version text) to anon;
grant execute on function public.register_terminal_device(p_serial text, p_app_version text) to authenticated;
grant execute on function public.register_terminal_device(p_serial text, p_app_version text) to service_role;
