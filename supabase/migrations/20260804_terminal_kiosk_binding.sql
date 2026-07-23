-- 20260804_terminal_kiosk_binding.sql
--
-- KIOSK ↔ Ryft PAX terminal binding (v5.5.871).
--
-- A kiosk (devices.type='kiosk') could pair a Stripe reader but NOT a Ryft PAX
-- terminal: the "send to terminal" job path (terminal_targets_for_pos +
-- terminal-job-create) already accepts any paired device at the location
-- (devices.device_uid = auth.uid(), no type gate), so a kiosk with a stamped
-- device_uid can read terminals and mint jobs. The ONLY thing missing was a way to
-- BIND a terminal to a kiosk: set_terminal_settings validates the bound device with
-- `d.type = 'pos'`, so a kiosk could never be assigned one, and its whole-settings
-- write also clobbers tip_config/modes — wrong tool for a targeted bind from the
-- kiosk's own Back Office settings page.
--
-- This migration is ADDITIVE and changes NO existing behaviour:
--   * NEW set_terminal_bound_device(p_terminal_id, p_bound_pos_device_id) — a
--     TARGETED bind that updates ONLY bound_pos_device_id (never touches tip/modes/
--     label/idle), and accepts a bound device of type 'pos' OR 'kiosk'. Fenced to a
--     Back Office user with access to the terminal's location (the kiosk settings
--     page is a BO screen), exactly like set_terminal_settings. NULL unbinds.
--
-- set_terminal_settings itself is intentionally left untouched: BO's PaxTerminals
-- panel only lists 'pos' tills for assignment, so it never offers a kiosk, and the
-- kiosk bind flows through this dedicated RPC instead.

create or replace function set_terminal_bound_device(
  p_terminal_id         uuid,
  p_bound_pos_device_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t terminal_devices;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if p_terminal_id is null then raise exception 'terminal required'; end if;

  select * into t from terminal_devices where id = p_terminal_id;
  if t.id is null then raise exception 'terminal not found'; end if;

  -- ── THE FENCE ──────────────────────────────────────────────────────────────
  -- Same as set_terminal_settings: a manager with access to the terminal's OWN
  -- location (read off the row, never from an argument). Binding is a management
  -- decision — the kiosk device itself does not self-assign; a BO user does it
  -- from the kiosk's settings page.
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  -- ── CROSS-LOCATION + TYPE VALIDATION ───────────────────────────────────────
  -- A terminal bound to a device at another venue is a cross-tenant payment hazard
  -- (a card presented to the wrong customer). Both halves checked: same location
  -- AND a valid dispatch origin — a POS till OR a KIOSK (v5.5.871). NULL unbinds.
  if p_bound_pos_device_id is not null then
    if not exists (
      select 1 from devices d
       where d.id = p_bound_pos_device_id
         and d.location_id = t.location_id
         and d.type in ('pos', 'kiosk')
    ) then
      raise exception 'that device is not a POS or kiosk at this terminal''s venue';
    end if;
  end if;

  update terminal_devices
     set bound_pos_device_id = p_bound_pos_device_id,
         updated_at          = now()
   where id = t.id;

  return jsonb_build_object('ok', true, 'terminal_id', t.id,
                            'bound_pos_device_id', p_bound_pos_device_id);
end; $$;

revoke all on function set_terminal_bound_device(uuid, uuid) from public;
grant execute on function set_terminal_bound_device(uuid, uuid) to anon, authenticated;
