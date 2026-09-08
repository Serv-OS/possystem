-- 20260623b_usage_rates.sql
-- Order Pad v2: server-side average-daily-usage aggregation.
--
-- The Order Pad needs each item's average daily consumption to suggest order
-- quantities. Aggregating thousands of movement rows in the browser doesn't
-- scale, so this RPC sums outbound movements (sales depletion + production
-- consumption) per item over a window and returns the per-day rate.
--
-- security invoker (default): runs as the caller, so existing stock_movements
-- RLS still fences each venue to its own data. The client passes its resolved
-- location_id (same pattern as the direct movements query it replaces).

create or replace function public.stock_usage_rates(p_location_id uuid, p_days int default 28)
returns table (inventory_item_id uuid, avg_daily_base numeric)
language sql
stable
set search_path = public
as $$
  select inventory_item_id,
         sum(-qty_base) / nullif(p_days, 0)::numeric as avg_daily_base
  from public.stock_movements
  where location_id = p_location_id
    and movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME')
    and qty_base < 0
    and occurred_at >= now() - make_interval(days => greatest(p_days, 1))
  group by inventory_item_id;
$$;

grant execute on function public.stock_usage_rates(uuid, int) to authenticated, anon;
