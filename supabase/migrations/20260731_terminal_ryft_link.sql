-- 20260731_terminal_ryft_link.sql   (OPS DB)
--
-- Pairing consolidation, slice 4 (behavioural only — NO new column). The Ryft link
-- lives on terminal_devices.ryft_terminal_id (the id the charge path already reads);
-- payment_devices is in the Platform DB so a real FK is impossible. Two fixes:
--
-- (a) RE-PAIR CARRY-FORWARD. A reinstall / re-pair claims a freshly-registered
--     terminal_devices row whose ryft_terminal_id is NULL, and retires the prior
--     paired row that HELD the Ryft link — silently re-breaking charging on every
--     reboot-with-reinstall (terminal-job-charge fails closed at the NULL link
--     before the payment_devices reconcile can help). This was the true generator of
--     the ops/platform drift. Capture the retiring row's ryft_terminal_id and carry
--     it onto the newly-claimed row.
--
-- (b) POS VISIBILITY. terminal_targets_for_pos gains ryft_terminal_id so the POS can
--     show "connected / not connected" and (later) refuse a NULL-link dispatch.
--     Changing the RETURNS TABLE shape needs DROP + CREATE, which drops grants — so
--     the grants are re-issued (forgetting this takes card dispatch down).

begin;

-- ── (a) claim_terminal_device: carry the Ryft link forward on re-pair ────────────
create or replace function claim_terminal_device(p_claim_code text, p_location_id uuid, p_label text default null)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare v_row terminal_devices; v_org uuid; v_prior_ryft text;
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

  -- Capture the prior paired row's Ryft link BEFORE retiring it, so a reinstall /
  -- re-pair carries the processor link forward instead of re-NULLing it. Scoped to
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

  -- Retire any prior PAIRED row for the same physical serial (reinstall / re-pair).
  -- Also frees idx_td_serial AND idx_td_ryft for the new row. Only rows at a location
  -- this manager can see are touched.
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
         -- Carry the retiring row's Ryft link forward. coalesce keeps this row's own
         -- id if it already had one (e.g. register reused the same row); the retire
         -- above freed the partial unique index so no idx_td_ryft collision.
         ryft_terminal_id = coalesce(v_prior_ryft, ryft_terminal_id),
         updated_at  = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'device_id', v_row.id);
end; $function$;

-- ── (b) terminal_targets_for_pos: expose ryft_terminal_id (DROP + CREATE + regrant) ─
drop function if exists terminal_targets_for_pos(uuid);
create function terminal_targets_for_pos(p_location_id uuid)
returns table(id uuid, label text, bound_pos_device_id uuid, last_seen_at timestamptz,
              tip_config jsonb, modes jsonb, ryft_terminal_id text)
language plpgsql stable security definer set search_path = public as $function$
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
           td.modes, td.ryft_terminal_id
      from terminal_devices td
     where td.location_id = p_location_id
       and td.status = 'paired'
       and td.active
     order by td.last_seen_at desc nulls last;
end; $function$;

revoke all on function terminal_targets_for_pos(uuid) from public;
grant execute on function terminal_targets_for_pos(uuid) to anon, authenticated, service_role;

commit;
