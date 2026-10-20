-- stock_usage_rates as the Ops catalog showed it on 19 Oct 2026 (pg_get_functiondef, read only).
create or replace function public.stock_usage_rates(p_location_id uuid, p_days integer default 28)
returns table(inventory_item_id uuid, avg_daily_base numeric)
language sql
stable
set search_path to 'public'
as $function$
  select inventory_item_id,
         sum(-qty_base) / nullif(p_days, 0)::numeric as avg_daily_base
  from public.stock_movements
  where location_id = p_location_id
    and movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME')
    and qty_base < 0
    and occurred_at >= now() - make_interval(days => greatest(p_days, 1))
  group by inventory_item_id;
$function$;
