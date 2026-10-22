-- 20261023a_OPS_stock_drainer_v2_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand, OUTSIDE SERVICE, only if the drainer release    #
-- #  (20261023a_OPS_stock_drainer_v2.sql) has to be undone. Run it BEFORE any #
-- #  0a rollback (the 0a rollback refuses while this release is in). One      #
-- #  paste, one transaction: any error and nothing changes. A second paste    #
-- #  refuses and changes nothing. It waits at most 3 s for a busy table, then #
-- #  gives up and changes nothing: run it again a minute later.               #
-- ############################################################################
--
-- Undoes 20261023a_OPS_stock_drainer_v2.sql (multi site stock, the drainer release, map 8.1). Every
-- object is named exactly; nothing is found by a pattern.
--
-- WHAT IT DOES, IN ORDER
--   1. Guard: Ops database; some part of this release is in; then all seven function bodies it saved
--      (stock_native_backup rows named drainer_v2:<name>) are there.
--   2. Cron: unschedules stock-day-sums-drain by name.
--   3. Triggers: drops the nine triggers of the release by name and table (three on stock_movements,
--      two on closed_checks, two on venue_clock, the two option table guards).
--   4. Function bodies: replays the seven bodies saved on the night (stock_qty_to_base, stock_explode,
--      stock_explode_skipped, _stock_outbox_apply, stock_day_sums_rebuild, sales_day_sums_rebuild,
--      sales_day_sums_check), so what was live that night comes back, and checks each one against the
--      md5 saved with it. Their grants are set back exactly as live (owner only; the three day total
--      functions also to service_role).
--   5. Drops the new functions and the drain procedure, each by its exact signature.
--   6. Drops the tables stock_sale_takes, stock_co_option_rule_sites and stock_co_option_rules.
--   7. stock_day_sums: deletes its rows (all derived from the ledger; the nightly run rebuilds
--      yesterday), drops its key, drops the demo column, and puts back its old key.
--   8. stock_day_sums_repair and sales_day_sums_queue: drops the due indexes and the attempts, due_at
--      and last_error columns. Their rows stay (the old rebuild clears them day by day).
--   9. Deletes the seven drainer_v2: backup rows. 0a's own seven rows are never touched.
--  10. The check row, last: bodies_restored 7, triggers_left 0, functions_left 0, tables_left 0,
--      drain_job false, discounts_kind_kept true.
--
-- KEPT, ON PURPOSE (the check row says so)
--   * discounts.kind and its CHECK discounts_kind_known: they hold Peter's settings in Back Office >
--     Discounts, and older code never reads them.
--   * Every stock movement, waste row and outbox event the release booked: the ledger stays whole.
--     What each sale took (stock_sale_takes) goes with its table; a part refund after this rollback
--     gives back by today's recipe, as before the release.
--
-- WEB AND EDGE: the web release of that night and the retired stock-deplete keep working with this
-- rollback (every venue is central, the database books every sale). stock-nightly records
-- {"missing": true} for drainer_health and carries on.
--
-- If a later release replaced one of the seven bodies above, roll that release back first.

do $guard$
declare
  v_any boolean;
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('cron.unschedule(bigint)') is null then
    raise exception 'pg_cron is not there (cron.unschedule). Nothing was changed.';
  end if;
  v_any := to_regclass('public.stock_sale_takes') is not null
        or to_regclass('public.stock_co_option_rules') is not null
        or to_regclass('public.stock_co_option_rule_sites') is not null
        or to_regprocedure('public.stock_explode_lines(uuid,jsonb,text,text)') is not null
        or to_regprocedure('public._stock_explode_made(uuid,uuid,numeric,text,uuid[])') is not null
        or to_regprocedure('public._stock_takes_share(jsonb,jsonb)') is not null
        or to_regprocedure('public._stock_day_sums_apply()') is not null
        or to_regprocedure('public._venue_clock_requeue()') is not null
        or to_regprocedure('public.stock_drainer_health(uuid)') is not null
        or to_regprocedure('public._sales_js_round(double precision)') is not null
        or to_regprocedure('public._sales_js_num(jsonb)') is not null
        or to_regprocedure('public._sales_check_parts(public.closed_checks)') is not null
        or to_regprocedure('public._sales_day_sums_enqueue()') is not null
        or to_regprocedure('public.stock_co__option_org_guard()') is not null
        or to_regprocedure('public.stock_day_sums_drain(integer,integer)') is not null
        or exists (select 1 from pg_trigger g
                    where not g.tgisinternal
                      and g.tgname in ('stock_movements_day_sums_ins', 'stock_movements_day_sums_upd', 'stock_movements_day_sums_del',
                                       'closed_checks_sales_day_ins', 'closed_checks_sales_day_upd',
                                       'venue_clock_requeue_ins', 'venue_clock_requeue_upd', 'stock_co_option_org_guard'))
        or exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public'
                      and ((c.table_name = 'stock_day_sums' and c.column_name = 'demo')
                           or (c.table_name in ('stock_day_sums_repair', 'sales_day_sums_queue')
                               and c.column_name in ('attempts', 'due_at', 'last_error'))));
  if not v_any then
    v_any := exists (select 1 from cron.job c where c.jobname = 'stock-day-sums-drain');
  end if;
  if not v_any then
    raise exception 'The drainer release (20261023a) is not in this database. Nothing was changed.';
  end if;
  if to_regclass('public.stock_native_backup') is null then
    raise exception 'The function bodies this release saved are missing. Nothing was changed. Ask Claude.';
  end if;
end
$guard$;

-- a separate statement: stock_native_backup is read only once it is known to be there
do $saved$
begin
  if (select count(distinct b.name) from public.stock_native_backup b
       where b.name in ('drainer_v2:stock_qty_to_base', 'drainer_v2:stock_explode', 'drainer_v2:stock_explode_skipped',
                        'drainer_v2:_stock_outbox_apply', 'drainer_v2:stock_day_sums_rebuild',
                        'drainer_v2:sales_day_sums_rebuild', 'drainer_v2:sales_day_sums_check')) <> 7
     or (select count(*) from public.stock_native_backup b where left(b.name, 11) = 'drainer_v2:') <> 7 then
    raise exception 'The function bodies this release saved are missing. Nothing was changed. Ask Claude.';
  end if;
end
$saved$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------- 2. the drain job
do $cron$
declare
  j record;
begin
  for j in select c.jobid from cron.job c where c.jobname = 'stock-day-sums-drain' loop
    perform cron.unschedule(j.jobid);
  end loop;
end
$cron$;

-- ---------------------------------------------------------------- 3. the nine triggers, by name and table
drop trigger if exists stock_movements_day_sums_ins on public.stock_movements;
drop trigger if exists stock_movements_day_sums_upd on public.stock_movements;
drop trigger if exists stock_movements_day_sums_del on public.stock_movements;
drop trigger if exists closed_checks_sales_day_ins on public.closed_checks;
drop trigger if exists closed_checks_sales_day_upd on public.closed_checks;
drop trigger if exists venue_clock_requeue_ins on public.venue_clock;
drop trigger if exists venue_clock_requeue_upd on public.venue_clock;
drop trigger if exists stock_co_option_org_guard on public.stock_co_option_rules;
drop trigger if exists stock_co_option_org_guard on public.stock_co_option_rule_sites;

-- ---------------------------------------------------------------- 4. the seven bodies as they were on the night
-- Each saved body is the pg_get_functiondef text of the live function the release replaced, so
-- running it gives back that exact function (same text, same search_path). Then each one is checked
-- against the md5 saved with it (the house rule: white space runs made one space).
create temp table _drainer_rb_bodies (
  name      text primary key,
  sig       text not null,
  md5_saved text not null,
  md5_now   text
) on commit drop;

do $replay$
declare
  r      record;
  v_bad  text;
begin
  for r in
    select e.name, e.sig, b.body, b.md5
      from (values ('drainer_v2:stock_qty_to_base', 'public.stock_qty_to_base(numeric,text,uuid)'),
                   ('drainer_v2:stock_explode', 'public.stock_explode(uuid,jsonb,text,text)'),
                   ('drainer_v2:stock_explode_skipped', 'public.stock_explode_skipped(uuid,jsonb,text)'),
                   ('drainer_v2:_stock_outbox_apply', 'public._stock_outbox_apply(bigint)'),
                   ('drainer_v2:stock_day_sums_rebuild', 'public.stock_day_sums_rebuild(uuid,date,date)'),
                   ('drainer_v2:sales_day_sums_rebuild', 'public.sales_day_sums_rebuild(uuid,date,date)'),
                   ('drainer_v2:sales_day_sums_check', 'public.sales_day_sums_check(uuid,date)')) as e(name, sig)
      join public.stock_native_backup b on b.name = e.name
     order by e.name
  loop
    execute r.body;
    insert into _drainer_rb_bodies (name, sig, md5_saved, md5_now)
    select r.name, r.sig, r.md5, md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
      from pg_proc p
     where p.oid = to_regprocedure(r.sig);
  end loop;
  select string_agg(e.name, ', ' order by e.name) into v_bad
    from (values ('drainer_v2:stock_qty_to_base'), ('drainer_v2:stock_explode'), ('drainer_v2:stock_explode_skipped'),
                 ('drainer_v2:_stock_outbox_apply'), ('drainer_v2:stock_day_sums_rebuild'),
                 ('drainer_v2:sales_day_sums_rebuild'), ('drainer_v2:sales_day_sums_check')) as e(name)
    left join _drainer_rb_bodies k on k.name = e.name
   where k.name is null or k.md5_now is distinct from k.md5_saved;
  if v_bad is not null then
    raise exception 'A stock function did not come back as it was saved: %. Nothing was changed. Ask Claude.', v_bad;
  end if;
end
$replay$;

-- their grants exactly as live: owner only; the three day total functions also to service_role
revoke all on function public.stock_qty_to_base(numeric, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_explode(uuid, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_explode_skipped(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public._stock_outbox_apply(bigint) from public, anon, authenticated, service_role;
revoke all on function public.stock_day_sums_rebuild(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.sales_day_sums_rebuild(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.sales_day_sums_check(uuid, date) from public, anon, authenticated, service_role;
grant execute on function public.stock_day_sums_rebuild(uuid, date, date) to service_role;
grant execute on function public.sales_day_sums_rebuild(uuid, date, date) to service_role;
grant execute on function public.sales_day_sums_check(uuid, date) to service_role;

-- ---------------------------------------------------------------- 5. the new functions and the drain procedure
drop function if exists public.stock_drainer_health(uuid);
drop function if exists public._venue_clock_requeue();
drop function if exists public._stock_day_sums_apply();
drop function if exists public._sales_day_sums_enqueue();
drop procedure if exists public.stock_day_sums_drain(integer, integer);
drop function if exists public._sales_check_parts(public.closed_checks);
drop function if exists public._sales_js_num(jsonb);
drop function if exists public._sales_js_round(double precision);
drop function if exists public._stock_takes_share(jsonb, jsonb);
drop function if exists public.stock_explode_lines(uuid, jsonb, text, text);
drop function if exists public._stock_explode_made(uuid, uuid, numeric, text, uuid[]);
drop function if exists public.stock_co__option_org_guard();

-- ---------------------------------------------------------------- 6. the three tables
drop table if exists public.stock_sale_takes;
drop table if exists public.stock_co_option_rule_sites;
drop table if exists public.stock_co_option_rules;

-- ---------------------------------------------------------------- 7. stock_day_sums back to its 0a shape
-- Every row is a total of the ledger (stock_movements), so nothing is lost: the nightly run rebuilds
-- yesterday, and any other day is rebuilt from the ledger when asked.
delete from public.stock_day_sums where true;
alter table public.stock_day_sums drop constraint stock_day_sums_pkey;
alter table public.stock_day_sums drop column demo;
alter table public.stock_day_sums
  add constraint stock_day_sums_pkey primary key (location_id, business_day, inventory_item_id, movement_type, source_type);

-- ---------------------------------------------------------------- 8. the two day queues back to their 0a shape
drop index if exists public.stock_day_sums_repair_due;
drop index if exists public.sales_day_sums_queue_due;
alter table public.stock_day_sums_repair
  drop column attempts,
  drop column due_at,
  drop column last_error;
alter table public.sales_day_sums_queue
  drop column attempts,
  drop column due_at,
  drop column last_error;

-- discounts.kind and its CHECK discounts_kind_known are KEPT on purpose (Peter's settings; older code
-- never reads them).

-- ---------------------------------------------------------------- 9. this release's backup rows
delete from public.stock_native_backup where left(name, 11) = 'drainer_v2:';

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------- 10. the check row (paste it back to Claude)
select (select count(*)
          from _drainer_rb_bodies k
          join pg_proc p on p.oid = to_regprocedure(k.sig)
         where md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = k.md5_saved) as bodies_restored,
       (select count(*) from pg_trigger g
         where not g.tgisinternal
           and g.tgname in ('stock_movements_day_sums_ins', 'stock_movements_day_sums_upd', 'stock_movements_day_sums_del',
                            'closed_checks_sales_day_ins', 'closed_checks_sales_day_upd',
                            'venue_clock_requeue_ins', 'venue_clock_requeue_upd', 'stock_co_option_org_guard')) as triggers_left,
       (select count(*)
          from unnest(array['public.stock_explode_lines(uuid,jsonb,text,text)', 'public._stock_explode_made(uuid,uuid,numeric,text,uuid[])',
                            'public._stock_takes_share(jsonb,jsonb)', 'public._stock_day_sums_apply()', 'public._venue_clock_requeue()',
                            'public.stock_drainer_health(uuid)', 'public._sales_js_round(double precision)', 'public._sales_js_num(jsonb)',
                            'public._sales_check_parts(public.closed_checks)', 'public._sales_day_sums_enqueue()',
                            'public.stock_co__option_org_guard()', 'public.stock_day_sums_drain(integer,integer)']) as s(sig)
         where to_regprocedure(s.sig) is not null) as functions_left,
       (select count(*) from unnest(array['stock_sale_takes', 'stock_co_option_rules', 'stock_co_option_rule_sites']) as t(n)
         where to_regclass('public.' || t.n) is not null) as tables_left,
       exists (select 1 from cron.job c where c.jobname = 'stock-day-sums-drain') as drain_job,
       exists (select 1 from information_schema.columns c
                where c.table_schema = 'public' and c.table_name = 'discounts' and c.column_name = 'kind')
         and exists (select 1 from pg_constraint k
                      where k.conrelid = 'public.discounts'::regclass and k.conname = 'discounts_kind_known') as discounts_kind_kept,
       (select count(*) from public.stock_native_backup b where left(b.name, 11) = 'drainer_v2:') as backup_rows_left;
