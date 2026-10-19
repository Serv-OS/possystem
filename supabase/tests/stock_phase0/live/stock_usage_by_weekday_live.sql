-- stock_usage_by_weekday as the Ops catalog showed it on 18 Oct 2026 (pg_get_functiondef, read only).
create or replace function public.stock_usage_by_weekday(p_location_id uuid, p_weeks integer default 8)
returns table(inventory_item_id uuid, dow integer, avg_daily_base numeric)
language sql
stable
set search_path to 'public'
as $function$
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
$function$;
