-- v5.5.966 — ADYEN FOUNDATION (OPS DB tbetcegmszzotrwdtqhi)
-- Phase 0: terminal pairing carries an Adyen POIID exactly like the Ryft link;
-- bar-tab pre-auth hold identifiers finally persist (they lived only in Zustand).
begin;

-- ── 1. terminal_devices: the Adyen link (POIID, e.g. AMS1-000168243358252) ───
alter table terminal_devices add column if not exists adyen_terminal_id text;
create unique index if not exists idx_td_adyen
  on terminal_devices (adyen_terminal_id)
  where status = 'paired' and adyen_terminal_id is not null;

-- ── 2. bar_tabs: persist the pre-auth hold ───────────────────────────────────
-- Until now preAuthPaymentIntentId/held amount lived ONLY in the till's memory —
-- a reload on another device lost the hold reference. Adyen work is the moment
-- this stops being true, for every processor.
alter table bar_tabs add column if not exists pre_auth_ref text;         -- pi_ / ps_ / pspReference
alter table bar_tabs add column if not exists pre_auth_processor text;   -- stripe | ryft | adyen
alter table bar_tabs add column if not exists pre_auth_held_minor bigint;

-- ── 3. claim_terminal_device: carry the ADYEN link forward on re-pair too ────
-- (same rule the Ryft link earned in 20260731_terminal_ryft_link.sql — a
-- reinstall must never silently unlink the processor terminal id)
create or replace function public.claim_terminal_device(p_claim_code text, p_location_id uuid, p_label text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_row terminal_devices; v_org uuid; v_prior_ryft text; v_prior_adyen text;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  -- The manager must have access to the location they are pairing INTO. This is
  -- what stops a code from one venue being bound to another venue's terminal.
  if not _terminal_user_has_location(p_location_id) then raise exception 'no access to this location'; end if;

  select * into v_row from terminal_devices
   where lower(claim_code) = lower(btrim(coalesce(p_claim_code, ''))) and status = 'unpaired'
   limit 1;
  if v_row.id is null then raise exception 'pairing code not found'; end if;

  -- TTL — only a terminal that is actually live (or just registered) may be
  -- claimed. Stops abandoned codes being pre-claimed later.
  if coalesce(v_row.last_seen_at, v_row.created_at) < now() - interval '30 minutes' then
    raise exception 'pairing code expired — restart the terminal to get a new code';
  end if;

  select org_id into v_org from locations where id = p_location_id;

  -- Capture the prior paired row's processor links BEFORE retiring it, so a
  -- reinstall / re-pair carries them forward instead of re-NULLing. Scoped to
  -- the same serial and to locations this manager can see (never touch another
  -- tenant's row on a serial collision).
  select ryft_terminal_id into v_prior_ryft
    from terminal_devices
   where serial_number = v_row.serial_number
     and id <> v_row.id
     and status = 'paired'
     and ryft_terminal_id is not null
     and _terminal_user_has_location(location_id)
   limit 1;

  select adyen_terminal_id into v_prior_adyen
    from terminal_devices
   where serial_number = v_row.serial_number
     and id <> v_row.id
     and status = 'paired'
     and adyen_terminal_id is not null
     and _terminal_user_has_location(location_id)
   limit 1;

  -- Retire any prior PAIRED row for the same physical serial (reinstall / re-pair).
  -- Also frees idx_td_serial, idx_td_ryft AND idx_td_adyen for the new row. Only
  -- rows at a location this manager can see are touched.
  update terminal_devices
     set status = 'retired', active = false, claim_code = null, updated_at = now()
   where serial_number = v_row.serial_number
     and id <> v_row.id
     and status = 'paired'
     and _terminal_user_has_location(location_id);

  update terminal_devices
     set location_id = p_location_id,          -- SERVER-validated, never device-supplied
         org_id      = v_org,
         label       = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label, 'Card terminal'),
         status      = 'paired',
         active      = true,
         claim_code  = null,                   -- single use: the code cannot be replayed
         claimed_at  = now(),
         -- Carry the retiring row's processor links forward. coalesce keeps this
         -- row's own ids if it already had them; the retire above freed the
         -- partial unique indexes so no collision.
         ryft_terminal_id  = coalesce(v_prior_ryft, ryft_terminal_id),
         adyen_terminal_id = coalesce(v_prior_adyen, adyen_terminal_id),
         updated_at  = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'device_id', v_row.id);
end; $function$;

-- ── 4. terminal_targets_for_pos: expose the Adyen link to the till ───────────
-- Return-type change ⇒ DROP + CREATE ⇒ grants are LOST and must be re-issued
-- (the lesson from 20260723: forgetting the re-grant takes dispatch down).
drop function if exists public.terminal_targets_for_pos(uuid);
create function public.terminal_targets_for_pos(p_location_id uuid)
 returns table(id uuid, label text, bound_pos_device_id uuid, last_seen_at timestamptz,
               tip_config jsonb, modes jsonb, ryft_terminal_id text, adyen_terminal_id text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
#variable_conflict use_column
declare v_ok boolean;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if p_location_id is null then raise exception 'location required'; end if;

  select (
    _terminal_user_has_location(p_location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = p_location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this location'; end if;

  return query
    select td.id, td.label, td.bound_pos_device_id, td.last_seen_at, td.tip_config,
           td.modes, td.ryft_terminal_id, td.adyen_terminal_id
      from terminal_devices td
     where td.location_id = p_location_id
       and td.status = 'paired'
       and td.active
     order by td.last_seen_at desc nulls last;
end; $function$;

grant execute on function public.terminal_targets_for_pos(uuid) to anon, authenticated;

commit;
