-- 20261109a_OPS_adyen_only.sql (29 Oct 2026, Drop D). OPS project.
--
-- ServOS works with Adyen only. This file removes the one Ryft configuration column on the Ops
-- side, terminal_devices.ryft_terminal_id (the soft link from a paired card terminal to a Ryft
-- hardware id), and the two RPCs that read it:
--
--   * claim_terminal_device: no longer carries a prior row's ryft_terminal_id forward on a
--     re pair (the Adyen carry forward, idx_td_adyen, stays exactly as 20260801b wrote it).
--   * terminal_targets_for_pos: its row type loses ryft_terminal_id (return type change, so
--     DROP + CREATE + the re grant to anon and authenticated, the 20260723 lesson).
--   * idx_td_ryft (the partial unique index on the column) goes with the column.
--
-- KEPT, never touched here: terminal_jobs.processor and its history ('ryft' on old PAX jobs),
-- closed_checks.processor, closed_checks.stripe_payment_intent_id (holds Adyen references, a
-- later RENAME, never a drop), bar_tabs.pre_auth_processor, ryft_payments (Platform).
--
-- Rollback: 20261109a_OPS_adyen_only_ROLLBACK.sql.

begin;

-- ── 1. claim_terminal_device: carry the Adyen link forward only ───────────────
create or replace function public.claim_terminal_device(p_claim_code text, p_location_id uuid, p_label text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_row terminal_devices; v_org uuid; v_prior_adyen text;
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

  -- Capture the prior paired row's Adyen link BEFORE retiring it, so a
  -- reinstall / re-pair carries it forward instead of re-NULLing. Scoped to
  -- the same serial and to locations this manager can see (never touch another
  -- tenant's row on a serial collision).
  select adyen_terminal_id into v_prior_adyen
    from terminal_devices
   where serial_number = v_row.serial_number
     and id <> v_row.id
     and status = 'paired'
     and adyen_terminal_id is not null
     and _terminal_user_has_location(location_id)
   limit 1;

  -- Retire any prior PAIRED row for the same physical serial (reinstall / re-pair).
  -- Also frees idx_td_serial AND idx_td_adyen for the new row. Only rows at a
  -- location this manager can see are touched.
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
         -- Carry the retiring row's Adyen link forward. coalesce keeps this
         -- row's own id if it already had one; the retire above freed the
         -- partial unique index so no collision.
         adyen_terminal_id = coalesce(v_prior_adyen, adyen_terminal_id),
         updated_at  = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'device_id', v_row.id);
end; $function$;

-- ── 2. terminal_targets_for_pos: the till's list of readers, Adyen link only ──
drop function if exists public.terminal_targets_for_pos(uuid);
create function public.terminal_targets_for_pos(p_location_id uuid)
 returns table(id uuid, label text, bound_pos_device_id uuid, last_seen_at timestamptz,
               tip_config jsonb, modes jsonb, adyen_terminal_id text)
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
           td.modes, td.adyen_terminal_id
      from terminal_devices td
     where td.location_id = p_location_id
       and td.status = 'paired'
       and td.active
     order by td.last_seen_at desc nulls last;
end; $function$;

grant execute on function public.terminal_targets_for_pos(uuid) to anon, authenticated;

-- ── 3. The column and its index ───────────────────────────────────────────────
drop index if exists public.idx_td_ryft;
alter table public.terminal_devices drop column if exists ryft_terminal_id;

commit;

-- VERIFY (read only):
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'terminal_devices' and column_name = 'ryft_terminal_id';
--                                                                     -- expect 0 rows
--   select indexname from pg_indexes where tablename = 'terminal_devices' and indexname = 'idx_td_ryft';
--                                                                     -- expect 0 rows
--   select pg_get_function_result('public.terminal_targets_for_pos(uuid)'::regprocedure);
--                                                                     -- no ryft_terminal_id in the row type
--   select grantee from information_schema.routine_privileges
--    where routine_name = 'terminal_targets_for_pos' and grantee in ('anon','authenticated');
--                                                                     -- expect both
