-- ═══════════════════════════════════════════════════════════════════════════
-- Table Bookings — move_booking: manually re-table a booking (Peter, 12 Aug:
-- "there needs a way to move peoples table manually").
--
-- Same shape as create_booking: the availability check and the membership
-- rewrite are atomic under the per-location advisory lock, excluding the
-- booking's OWN footprint — so a move can never land on tables another
-- booking holds for the window, and two devices can't cross-move onto the
-- same table. Idempotent + re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════
begin;

create or replace function public.move_booking(
  p_id text,
  p_location_id uuid,
  p_table_ids text[],
  p_primary_table_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_bk record;
  v_conflict record;
  v_start_min int;
  v_end_min int;
begin
  if p_table_ids is null or array_length(p_table_ids, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no tables supplied');
  end if;
  if not (p_primary_table_id = any(p_table_ids)) then
    return jsonb_build_object('ok', false, 'error', 'primary table must be a member');
  end if;

  perform pg_advisory_xact_lock(hashtext('bookings:' || p_location_id::text));

  select * into v_bk from bookings where id = p_id and location_id = p_location_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown booking');
  end if;
  if v_bk.status in ('departed','cancelled','no_show') then
    return jsonb_build_object('ok', false, 'error', 'booking is closed');
  end if;

  v_start_min := extract(hour from v_bk.start_time)::int * 60 + extract(minute from v_bk.start_time)::int;
  v_end_min := v_start_min + v_bk.turn_minutes;

  select b.id, bt.table_id into v_conflict
  from bookings b
  join booking_tables bt on bt.booking_id = b.id
  where b.location_id = p_location_id
    and b.id != p_id
    and b.booking_date = v_bk.booking_date
    and b.status not in ('departed','cancelled','no_show')
    and bt.table_id = any(p_table_ids)
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) < v_end_min
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) + b.turn_minutes > v_start_min
  limit 1;

  if found then
    return jsonb_build_object('ok', false, 'error', 'table_taken',
      'table_id', v_conflict.table_id, 'booking_id', v_conflict.id);
  end if;

  delete from booking_tables where booking_id = p_id;
  insert into booking_tables (location_id, booking_id, table_id, is_primary)
  select p_location_id, p_id, t, (t = p_primary_table_id) from unnest(p_table_ids) as t;
  update bookings set primary_table_id = p_primary_table_id where id = p_id;

  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

revoke all on function public.move_booking(text, uuid, text[], text) from public;
grant execute on function public.move_booking(text, uuid, text[], text) to anon, authenticated;

commit;
