-- 20260803_terminal_pos_close_session.sql   (OPS DB)
--
-- WHY: A PAX Table-Pay charge that SUCCEEDS books the closed_check, but the table
-- kept re-appearing OPEN on the floor. closeApprovedTerminalJob dropped the table in
-- LOCAL Zustand only (_dropTableFromFloor); the active_sessions ROW was never deleted
-- server-side. The only server-side cleanup was SessionReconciler's 10s ghost-sweep,
-- which only fires on a device that is awake, online, AND holding the just-written
-- closed_check in memory — the A50 terminal runs no reconciler, and the till that
-- learned the table via realtime/poll may not be the closer. Until some such device
-- ticked, the row survived and the 10s poll re-hydrated the table on every screen.
--
-- FIX: an idempotent, tightly-fenced RPC the POS calls the instant the sale is booked,
-- deleting the paid occupation's active_sessions row directly — no dependence on a
-- device's sweep timing. It is the ghost-sweep's delete, moved to close-time.
--
-- SAFETY — "tables MUST never be lost":
--   * Deletes ONLY the exact occupation the card paid for, keyed on BOTH the session id
--     AND seatedAt (write-once occupation identity). A DIFFERENT party re-seated at the
--     same table has a fresh id + seatedAt → WHERE matches nothing → no-op. A live order
--     is never destroyed.
--   * Requires the closed_check to EXIST → never deletes a session that was not actually
--     closed (belt-and-braces with the caller's own ok:true gate).
--   * Fenced identically to terminal_pos_mark_reconciled: an anon paired till proves
--     itself with a devices row at the location, a BO user via user_locations. No direct
--     write policy is added to active_sessions — the mutation lands in SECURITY DEFINER.
--   * location_id is passed by the caller (resolved-real) and matched — honours the
--     resolve-locationId invariant; never trusts a column default.

begin;

create or replace function terminal_pos_close_session(
  p_location_id     uuid,
  p_table_id        text,
  p_session_id      text,
  p_seated_at       bigint,
  p_closed_check_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ok boolean; v_n integer;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if p_location_id is null or p_table_id is null or p_closed_check_id is null then
    raise exception 'missing args';
  end if;
  -- No occupation identity → refuse (safe direction: never a blind table-scoped delete).
  if p_session_id is null or p_seated_at is null then
    return jsonb_build_object('ok', true, 'deleted', 0, 'skipped', 'no occupation identity');
  end if;

  select (
    _terminal_user_has_location(p_location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = p_location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this location'; end if;

  delete from active_sessions a
   where a.location_id = p_location_id
     and a.table_id    = p_table_id
     and (a.session ->> 'id') = p_session_id
     and (a.session ->> 'seatedAt') ~ '^[0-9]+$'
     and (a.session ->> 'seatedAt')::bigint = p_seated_at
     and exists (select 1 from closed_checks c where c.id = p_closed_check_id);
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'deleted', v_n);
end; $$;

-- Grants — anon paired till + BO user, same as terminal_pos_mark_reconciled. NOT
-- service_role-only: the paired POS device (anonymous session) is the caller.
revoke execute on function terminal_pos_close_session(uuid, text, text, bigint, text) from public;
grant  execute on function terminal_pos_close_session(uuid, text, text, bigint, text) to anon, authenticated;

commit;

-- ── CHECK ───────────────────────────────────────────────────────────────────
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as sec_def
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'terminal_pos_close_session';
