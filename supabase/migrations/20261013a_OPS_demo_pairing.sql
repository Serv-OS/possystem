-- 20261013a_OPS_demo_pairing.sql
--
-- WHY. Apple's reviewer cannot pair the Manager app. Manager (like Waitlist and
-- Bookings) shows a code on the phone that somebody must then type into Back
-- Office, Operations, Devices. A reviewer has no Back Office, so they sit on the
-- pairing screen and reject the app for incomplete access. On 13 Oct 2026 Apple
-- said exactly that again, and device_claim_log shows their taps never even
-- reached us.
--
-- WHAT. One venue is marked as the demo venue. Any app can then bind ITSELF to
-- that venue, with no Back Office step, by calling claim_demo_ops_device().
--
-- WHAT IT DOES NOT OPEN. The call only links the device to the demo venue. The
-- app still asks for a staff PIN at that venue (ops_pin_login), so the data
-- behind it stays shut to anyone without the demo PIN. Only a venue flagged by
-- hand is reachable, so no real venue can be demoed by accident.
--
-- AFTER RUNNING THIS, pick the demo venue (never a trading one):
--   update public.locations set is_demo = true where id = '<the demo venue id>';
-- and check it:
--   select id, name, is_demo from public.locations where is_demo;

-- 1. The flag. Off everywhere until somebody sets it.
alter table public.locations add column if not exists is_demo boolean not null default false;
comment on column public.locations.is_demo is
  'Demo venue: any app may self-pair to it (claim_demo_ops_device). Never set this on a trading venue.';

-- 2. Self-pairing for the demo venue.
create or replace function public.claim_demo_ops_device()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_loc uuid;
  v_org uuid;
  v     public.ops_devices%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session',
                              'message', 'Open the app again to start a session.');
  end if;

  -- A caller hammering this is still a caller: the fence counts them like any
  -- other claim. _fence_count raises when the bucket is over its limit.
  begin
    perform public._fence_count('demo:uid:' || auth.uid()::text, 30, interval '10 minutes', interval '10 minutes');
  exception when undefined_function then
    null;   -- an older database without the fence helpers: no counter, same behaviour
  end;

  select id, org_id into v_loc, v_org
    from public.locations
   where is_demo is true
   order by created_at
   limit 1;

  if v_loc is null then
    return jsonb_build_object('ok', false, 'reason', 'no_demo_venue',
                              'message', 'No demo venue is set up yet.');
  end if;

  -- The row this session registered for itself (register_ops_device writes
  -- device_uid = auth.uid()). Re-running this is harmless: it re-links the same
  -- row, so a reviewer can pair again after reinstalling, for ever.
  update public.ops_devices
     set location_id = v_loc,
         org_id      = v_org,
         claimed_at  = now(),
         active      = true,
         name        = coalesce(nullif(btrim(name), ''), 'Demo device')
   where device_uid = auth.uid()
  returning * into v;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_registered',
                              'message', 'This device has not registered yet. Close and open the app, then try again.');
  end if;

  return jsonb_build_object('ok', true, 'id', v.id, 'location_id', v.location_id,
                            'name', coalesce((select name from public.locations where id = v_loc), 'Demo'));
end;
$fn$;

revoke all on function public.claim_demo_ops_device() from public;
grant execute on function public.claim_demo_ops_device() to anon, authenticated;

-- 3. Verification (read only, paste after applying)
-- select id, name, is_demo from public.locations where is_demo;
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc where proname = 'claim_demo_ops_device';
-- select has_function_privilege('anon', 'public.claim_demo_ops_device()', 'execute') as anon_can_call;
