-- Rollback of 20261109a_OPS_adyen_only.sql (Drop D, 29 Oct 2026). OPS project.
-- Re adds terminal_devices.ryft_terminal_id (nullable) and its partial unique index, and
-- restores claim_terminal_device and terminal_targets_for_pos exactly as
-- 20260801b_ops_adyen_terminals.sql wrote them (the Ryft carry forward and the ryft_terminal_id
-- output column), with the re grant.

begin;

alter table public.terminal_devices add column if not exists ryft_terminal_id text;
create unique index if not exists idx_td_ryft
  on public.terminal_devices using btree (ryft_terminal_id)
  where status = 'paired';

create or replace function public.claim_terminal_device(p_claim_code text, p_location_id uuid, p_label text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_row terminal_devices; v_org uuid; v_prior_ryft text; v_prior_adyen text;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if not _terminal_user_has_location(p_location_id) then raise exception 'no access to this location'; end if;

  select * into v_row from terminal_devices
   where lower(claim_code) = lower(btrim(coalesce(p_claim_code, ''))) and status = 'unpaired'
   limit 1;
  if v_row.id is null then raise exception 'pairing code not found'; end if;

  if coalesce(v_row.last_seen_at, v_row.created_at) < now() - interval '30 minutes' then
    raise exception 'pairing code expired — restart the terminal to get a new code';
  end if;

  select org_id into v_org from locations where id = p_location_id;

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

  update terminal_devices
     set status = 'retired', active = false, claim_code = null, updated_at = now()
   where serial_number = v_row.serial_number
     and id <> v_row.id
     and status = 'paired'
     and _terminal_user_has_location(location_id);

  update terminal_devices
     set location_id = p_location_id,
         org_id      = v_org,
         label       = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label, 'Card terminal'),
         status      = 'paired',
         active      = true,
         claim_code  = null,
         claimed_at  = now(),
         ryft_terminal_id  = coalesce(v_prior_ryft, ryft_terminal_id),
         adyen_terminal_id = coalesce(v_prior_adyen, adyen_terminal_id),
         updated_at  = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'device_id', v_row.id);
end; $function$;

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
