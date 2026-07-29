-- 20260729c_usage_by_weekday.sql — OPS DB
--
-- THE WEEKDAY SHAPE OF USAGE. stock_usage_rates gives one flat average per item; a
-- venue that sells 12 bottles on a Friday and 3 on a Tuesday gets told "6.4/day" and
-- the Order Pad over-orders for Monday and under-orders for the weekend. This returns
-- the per-weekday average so the pad can walk the actual days it is covering.
--
-- Same maths discipline as stock_usage_rates: usage = SALE_DEPLETION + PRODUCTION_CONSUME
-- outflows only (waste is loss, not demand), divided by how many of THAT weekday fall in
-- the window — so a 8-week window divides Friday's total by 8, not 56.
-- Same security model too: STABLE sql, no definer, granted to authenticated + anon
-- (movements are already tenant-fenced by RLS; the function only aggregates).

create or replace function public.stock_usage_by_weekday(p_location_id uuid, p_weeks int default 8)
returns table (inventory_item_id uuid, dow int, avg_daily_base numeric)
language sql
stable
set search_path = public
as $$
  with w as (
    select greatest(p_weeks, 1) as weeks
  ), m as (
    select sm.inventory_item_id,
           extract(dow from sm.occurred_at)::int as dow,
           sum(-sm.qty_base) as total_base
    from public.stock_movements sm, w
    where sm.location_id = p_location_id
      and sm.movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME')
      and sm.qty_base < 0
      and sm.occurred_at >= now() - make_interval(weeks => w.weeks)
    group by sm.inventory_item_id, extract(dow from sm.occurred_at)::int
  )
  select m.inventory_item_id, m.dow, m.total_base / (select weeks from w)::numeric
  from m;
$$;

grant execute on function public.stock_usage_by_weekday(uuid, int) to authenticated, anon;
