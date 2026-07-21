-- ─────────────────────────────────────────────────────────────────────────────
-- 20260723_terminal_settings.sql   (OPS DB)
--
-- v5.5.838: the WRITER that 20260722c assumed existed.
--
-- terminal_devices already carries `tip_config jsonb` and `bound_pos_device_id`,
-- and terminal_start_table_payment says "Back Office writes this cache when the
-- terminal is paired". Nothing ever wrote either column. The consequences, all
-- from the same missing writer:
--
--   1. tip_config NULL  → terminal_start_table_payment falls back to
--                         jsonb_build_object('enabled', false) → "tipping is off"
--                         on Table Pay at a venue that has tipping switched on.
--   2. bound_pos_device_id NULL → no way to say which till a terminal belongs to.
--   3. …so terminal_targets_for_pos returns rows nobody is bound to, and the POS
--      (findPaxTerminal) filtered on an exact bind and found nothing.
--
-- This migration adds the write surface. It does NOT change the NULL fallback in
-- terminal_start_table_payment — that fallback is the SAFE default and stays
-- exactly as written (spec: a missing config must never produce an invented tip
-- prompt; Tipping Act 2023 / HMRC E24). The fix is that Back Office now fills it.
--
-- RULES OBSERVED (same five as 20260722c — read that file's header first):
--   security definer + set search_path = public; caller re-derived from auth.uid();
--   location_id never accepted from an argument; execute revoked from public then
--   granted deliberately.
--
-- ⚠ terminal_devices has NO INSERT and NO UPDATE POLICY, deliberately: every
--   anonymous kiosk/QR/online session in this system holds a valid auth.uid(), so
--   a permissive policy on a payments table is unbounded public write access.
--   Everything here goes through SECURITY DEFINER instead. Do not "simplify" this
--   into a policy.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. columns ───────────────────────────────────────────────────────────────

-- Which of the three home-screen modes this terminal offers.
--   {"table_pay": true, "manual": true, "pos_dispatch": true}
--
-- NULL means ALL THREE ENABLED. That is deliberate and load-bearing: every
-- terminal paired before this migration has NULL here, and defaulting to
-- "everything off" would take the owner's one working terminal off the floor the
-- moment this ships. Absent config = current behaviour, everywhere.
-- WRAPPED IN A TRANSACTION (added on review).
-- This migration DROPs terminal_targets_for_pos before recreating it (a RETURNS TABLE
-- signature cannot be widened by CREATE OR REPLACE). Without begin/commit, a failure
-- between the drop and the create would leave every till unable to dispatch a card
-- payment. All-or-nothing is the only safe shape here.

begin;

alter table terminal_devices add column if not exists modes jsonb;

-- Idle screensaver cache: {"enabled": true, "imageUrl": "https://…"}.
--
-- WHY A CACHE AND NOT A LOOKUP: the venue-level setting lives in
-- location_reader_settings, which is in the PLATFORM DB. Ops SQL cannot read it
-- and neither can the PAX app (it only ever talks to the Ops project). This is
-- exactly the same reason tip_config is cached onto this row rather than read
-- live — see the comment in terminal_start_table_payment. Back Office writes both
-- in the same save.
--
-- NULL / absent / enabled=false → the terminal shows its ordinary home screen and
-- no placeholder. Fail quiet, not fail loud: a screensaver is decoration.
alter table terminal_devices add column if not exists idle_screen jsonb;

comment on column terminal_devices.modes is
  'Which home-screen modes this terminal offers: {"table_pay":bool,"manual":bool,"pos_dispatch":bool}. NULL = all enabled.';
comment on column terminal_devices.idle_screen is
  'Cached venue screensaver for the PAX home screen: {"enabled":bool,"imageUrl":text}. Source of truth is location_reader_settings in the Platform DB; Back Office mirrors it here because Ops SQL and the terminal cannot reach that project.';


-- ── 2. normalisers ───────────────────────────────────────────────────────────
-- The client sends what it likes; the ROW gets a known shape. Doing this in SQL
-- rather than in the panel means a second writer (a script, another surface, a
-- future mobile Back Office) cannot put a shape on the row that the terminal
-- silently fails to parse.

-- Tip config, written in BOTH vocabularies on purpose.
--
-- TipConfig.fromJobJson on the terminal accepts two spellings and no others:
--     {"enabled": …,         "percentBands":    [...]}   ← the paxpay module
--     {"tipping_enabled": …, "tip_percentages": [...]}   ← Back Office
-- It does NOT read "percentages". Anything it cannot parse FAILS CLOSED to
-- tipping-off — correct behaviour, but it means a near-miss key name is
-- indistinguishable from "this venue does not tip". So we write both spellings
-- and stop the ambiguity at the source.
create or replace function _terminal_norm_tip_config(p jsonb) returns jsonb
language plpgsql immutable security definer set search_path = public as $$
declare
  v_enabled  boolean;
  v_custom   boolean;
  v_thresh   bigint;
  v_pcts     jsonb := '[]'::jsonb;
  v_el       jsonb;
  v_n        numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    -- Same fail-closed default terminal_start_table_payment uses.
    return jsonb_build_object('enabled', false, 'tipping_enabled', false);
  end if;

  v_enabled := coalesce((p ->> 'enabled')::boolean, (p ->> 'tipping_enabled')::boolean, false);
  if not v_enabled then
    return jsonb_build_object('enabled', false, 'tipping_enabled', false);
  end if;

  -- Accept any of the three spellings on the way IN; emit two canonical ones OUT.
  for v_el in
    select value from jsonb_array_elements(
      coalesce(
        case when jsonb_typeof(p -> 'percentBands')    = 'array' then p -> 'percentBands'    end,
        case when jsonb_typeof(p -> 'tip_percentages') = 'array' then p -> 'tip_percentages' end,
        case when jsonb_typeof(p -> 'percentages')     = 'array' then p -> 'percentages'     end,
        '[]'::jsonb))
  loop
    -- A non-numeric band is a broken row, not a tip option. Null it and let the
    -- guard below drop it — deliberately NOT `continue` inside the handler, which
    -- is a plpgsql control-flow trap in an exception block.
    begin
      v_n := (v_el #>> '{}')::numeric;
    exception when others then
      v_n := null;
    end;
    -- 0%, a negative, or an absurd band is not a tip option (mirrors fromJobJson).
    if v_n is null or v_n <= 0 or v_n > 100 then continue; end if;
    if jsonb_array_length(v_pcts) >= 5 then exit; end if;   -- 5 buttons is all the screen has
    v_pcts := v_pcts || to_jsonb(v_n);
  end loop;

  -- Tipping on with no usable band is not a state the terminal can render, and
  -- inventing 10/12.5/15 would put percentages in front of a customer that
  -- nobody at the venue agreed to. Off is the honest answer.
  if jsonb_array_length(v_pcts) = 0 then
    return jsonb_build_object('enabled', false, 'tipping_enabled', false);
  end if;

  v_custom := coalesce((p ->> 'allowCustom')::boolean, (p ->> 'allow_custom')::boolean, true);

  begin
    v_thresh := nullif(p ->> 'smartThresholdMinor', '')::bigint;
  exception when others then
    v_thresh := null;
  end;
  if v_thresh is not null and v_thresh < 0 then v_thresh := null; end if;

  return jsonb_build_object(
    'enabled',             true,
    'tipping_enabled',     true,     -- Back Office vocabulary
    'percentBands',        v_pcts,
    'tip_percentages',     v_pcts,   -- Back Office vocabulary
    'allowCustom',         v_custom,
    'allow_custom',        v_custom,
    'smartThresholdMinor', case when v_thresh is null then null else to_jsonb(v_thresh) end,
    -- allowNoTip is NOT configurable and never will be. Trapping a customer on a
    -- tip screen is not a setting; the terminal hard-codes it true regardless.
    'allowNoTip',          true
  );
end; $$;

-- Mode toggles. Anything missing defaults to ENABLED — see the column comment.
create or replace function _terminal_norm_modes(p jsonb) returns jsonb
language sql immutable security definer set search_path = public as $$
  select case
    when p is null or jsonb_typeof(p) <> 'object' then null   -- NULL = all enabled
    else jsonb_build_object(
      'table_pay',    coalesce((p ->> 'table_pay')::boolean, true),
      'manual',       coalesce((p ->> 'manual')::boolean, true),
      'pos_dispatch', coalesce((p ->> 'pos_dispatch')::boolean, true)
    )
  end;
$$;

-- Screensaver cache. An enabled screensaver with no image is just "off".
create or replace function _terminal_norm_idle_screen(p jsonb) returns jsonb
language sql immutable security definer set search_path = public as $$
  select case
    when p is null or jsonb_typeof(p) <> 'object' then null
    when coalesce((p ->> 'enabled')::boolean, false) is not true then jsonb_build_object('enabled', false)
    when nullif(btrim(coalesce(p ->> 'imageUrl', '')), '') is null then jsonb_build_object('enabled', false)
    else jsonb_build_object(
      'enabled',  true,
      'imageUrl', btrim(p ->> 'imageUrl')
    )
  end;
$$;


-- ── 3. set_terminal_settings ─────────────────────────────────────────────────
-- Back Office writes a terminal's settings. Returns { ok, terminal_id }.
--
-- THIS IS A WHOLE-SETTINGS WRITE, not a patch. Every argument is applied as
-- given, so p_bound_pos_device_id => NULL genuinely means "not assigned to any
-- till" and p_modes => NULL genuinely means "all modes on". The Back Office panel
-- always sends the complete set. A partial caller would clear what it omits —
-- that is deliberate, because the alternative (a sentinel for "leave alone") is
-- the kind of subtlety that silently half-saves a payments config.
-- p_label is the ONE exception: blank/NULL keeps the existing label, matching
-- claim_terminal_device, because an empty name box must not wipe the name.
--
-- WHAT THIS FUNCTION DELIBERATELY CANNOT DO:
--   * change location_id — only claim_terminal_device writes that, after
--     validating the manager's access. Re-homing a paid-up terminal to another
--     venue is a pairing decision, not a settings one.
--   * touch status / active / claim_code / the PIN throttle counters.
create or replace function set_terminal_settings(
  p_terminal_id         uuid,
  p_tip_config          jsonb default null,
  p_bound_pos_device_id uuid  default null,
  p_modes               jsonb default null,
  p_label               text  default null,
  p_idle_screen         jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
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
         and d.type = 'pos'
    ) then
      raise exception 'that till is not a POS device at this terminal''s venue';
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
end; $$;


-- ── 4. terminal_targets_for_pos — now returns modes ──────────────────────────
-- Additive: one more column, so the till can honour "Send from POS: off" without
-- a second round trip. Everything else is byte-identical to 20260722c § 9a —
-- same fence, same ordering, same refusal to return claim_code.
--
-- A RETURNS TABLE signature cannot be widened by CREATE OR REPLACE, so this is a
-- drop-and-recreate. The grants are re-issued below because DROP takes them with
-- it — forget that line and every till loses card dispatch.
drop function if exists terminal_targets_for_pos(uuid);

create function terminal_targets_for_pos(p_location_id uuid)
returns table (
  id                  uuid,
  label               text,
  bound_pos_device_id uuid,
  last_seen_at        timestamptz,
  tip_config          jsonb,
  modes               jsonb
)
language plpgsql stable security definer set search_path = public as $$
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
    select td.id, td.label, td.bound_pos_device_id, td.last_seen_at, td.tip_config, td.modes
      from terminal_devices td
     where td.location_id = p_location_id
       and td.status = 'paired'
       and td.active
     order by td.last_seen_at desc nulls last;
end; $$;


-- ── grants ───────────────────────────────────────────────────────────────────
-- SECURITY DEFINER runs as the owner, so EXECUTE is the whole access control.

revoke execute on function _terminal_norm_tip_config(jsonb)   from public;
revoke execute on function _terminal_norm_modes(jsonb)        from public;
revoke execute on function _terminal_norm_idle_screen(jsonb)  from public;
revoke execute on function set_terminal_settings(uuid, jsonb, uuid, jsonb, text, jsonb) from public;
revoke execute on function terminal_targets_for_pos(uuid)     from public;

-- Back Office only. NOT anon: these settings decide what a card terminal offers
-- and which till owns it, exactly like pairing.
grant execute on function set_terminal_settings(uuid, jsonb, uuid, jsonb, text, jsonb) to authenticated;

-- Re-grant what the DROP above removed. The till runs on an ANONYMOUS session.
grant execute on function terminal_targets_for_pos(uuid) to anon, authenticated;


commit;
