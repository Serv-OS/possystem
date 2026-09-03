-- Allow a card reader to be bound to an MPOS device, not only a till or kiosk.
-- The Card readers "till:" picker and this function both refused type mpos, so
-- an Adyen reader could never be pointed at a handset (3 Sep 2026).  OPS project.

CREATE OR REPLACE FUNCTION public.set_terminal_settings(p_terminal_id uuid, p_tip_config jsonb DEFAULT NULL::jsonb, p_bound_pos_device_id uuid DEFAULT NULL::uuid, p_modes jsonb DEFAULT NULL::jsonb, p_label text DEFAULT NULL::text, p_idle_screen jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if p_terminal_id is null then raise exception 'terminal required'; end if;

  select * into t from terminal_devices where id = p_terminal_id;
  if t.id is null then raise exception 'terminal not found'; end if;

  -- ── THE FENCE ──────────────────────────────────────────────────────────────
  -- Identical to claim_terminal_device: the manager must have access to the
  -- location, via user_locations or super_admin. Read off the TERMINAL'S OWN ROW,
  -- never from an argument — the caller does not get to nominate the location
  -- they are allowed to write to. (Rule 3 of 20260722c.)
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  -- ── CROSS-LOCATION VALIDATION ──────────────────────────────────────────────
  -- A terminal bound to another venue's till is a cross-tenant payment hazard:
  -- terminal_targets_for_pos would hand that till a terminal in a different
  -- building and a card would be presented to the wrong customer. Both halves are
  -- checked — same location AND actually a POS.
  --
  -- devices.location_id and terminal_devices.location_id are both uuid, so this
  -- compares directly. (floor_tables.location_id and closed_checks.location_id
  -- are TEXT in this schema — do not copy this line to those tables without
  -- casting the uuid side DOWN to text; 'loc-demo' is not a valid uuid and ::uuid
  -- throws 22P02.)
  if p_bound_pos_device_id is not null then
    if not exists (
      select 1 from devices d
       where d.id = p_bound_pos_device_id
         and d.location_id = t.location_id
         and d.type in ('pos', 'kiosk', 'mpos')
    ) then
      raise exception 'that device is not a POS till, MPOS or kiosk at this terminal''s venue';
    end if;
  end if;

  update terminal_devices
     set tip_config          = _terminal_norm_tip_config(p_tip_config),
         bound_pos_device_id = p_bound_pos_device_id,
         modes               = _terminal_norm_modes(p_modes),
         idle_screen         = _terminal_norm_idle_screen(p_idle_screen),
         label               = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label, 'Card terminal'),
         updated_at          = now()
   where id = t.id;

  return jsonb_build_object('ok', true, 'terminal_id', t.id);
end; $function$
;
