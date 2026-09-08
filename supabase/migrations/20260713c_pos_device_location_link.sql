-- 20260713c_pos_device_location_link.sql
--
-- POS-CORE RLS CUTOVER — STAGE 1 (foundation only; ADDITIVE, changes NO access).
--
-- Problem: POS-family devices (POS/KDS/bar/tables) pair via the `devices` table but the
-- resulting location lives ONLY in browser localStorage — the anonymous Supabase session
-- has no server-verified location, so RLS cannot scope these devices. (The ops/manager
-- tablets already solve this via ops_devices.device_uid = auth.uid(); we mirror that here
-- for the `devices` table rather than a fragile custom-access-token/JWT hook.)
--
-- This migration ONLY establishes the secure device→location link. It flips NO policies
-- and revokes NO grants, so deploying it cannot change current behaviour. Stage 2 adds the
-- scoped policies alongside the existing allow-all; Stage 3 removes allow-all.

-- A device's live anonymous auth.uid(), stamped ONLY via the claim RPC below (never client-set).
alter table public.devices add column if not exists device_uid uuid;
create index if not exists devices_device_uid_idx on public.devices (device_uid) where device_uid is not null;

-- Securely bind the calling anon session to a device row by its pairing code. SECURITY
-- DEFINER so it can update the row without the client holding write access to `devices`.
-- device_uid is taken from the JWT (auth.uid()), never from client input, so a device
-- cannot forge a link to a venue it doesn't hold the code for. Returns the location_id.
create or replace function public.claim_device(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loc uuid;
  v_id  uuid;
begin
  if auth.uid() is null then
    raise exception 'no auth session';
  end if;
  select id, location_id into v_id, v_loc
  from public.devices
  where pairing_code = upper(trim(p_code)) and status <> 'removed'
  limit 1;
  if v_id is null then
    return null;
  end if;
  update public.devices
    set device_uid = auth.uid(), last_seen = now()
    where id = v_id;
  return v_loc;
end;
$$;

grant execute on function public.claim_device(text) to anon, authenticated;

-- RLS helper (used by Stage 2 policies): true when the caller may act for p_loc — either a
-- back-office user with access to it, OR the currently-claimed device for that location.
-- SECURITY DEFINER + STABLE so it can read the mapping tables regardless of their own RLS.
create or replace function public.pos_can_access(p_loc uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_loc is null then
    return false;
  end if;
  -- back-office user (same predicate the wf_*/ops_* tables use)
  if p_loc::text in (select user_accessible_locations()) then
    return true;
  end if;
  -- a paired, active POS-family device holding this location
  return exists (
    select 1 from public.devices d
    where d.device_uid = auth.uid()
      and d.status = 'active'
      and d.location_id = p_loc
  );
end;
$$;

grant execute on function public.pos_can_access(uuid) to anon, authenticated;
