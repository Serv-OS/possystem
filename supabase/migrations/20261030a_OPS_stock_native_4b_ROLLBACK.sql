-- 20261030a_OPS_stock_native_4b_ROLLBACK.sql
-- Undoes 20261030a_OPS_stock_native_4b.sql (release 5.11.100, multi site stock Drop 4b).
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand, after UK close, only if Drop 4b has to be       #
-- #  undone. Run it BEFORE any 4a, Reports align or Drop 3 rollback. One      #
-- #  paste, one transaction: any error and nothing changes. A second paste    #
-- #  refuses and changes nothing. Lock wait 3 s.                              #
-- ############################################################################
--
-- Every object is named exactly; nothing is found by a pattern.
--
-- WHAT IT DOES, IN ORDER
--   1. Guard: Ops; Drop 4b is in; all twelve rows it saved (stock_native_backup 4b:<name>) are there.
--   2. The eight public names 4b made are dropped and the renamed bodies get their public names back
--      (stock_report_league, stock_report_dashboard, stock_report_attention, stock_report_value,
--      stock_report_purchases, stock_report_prices, stock_notify_due, stock_notify_targets); each is
--      checked against the md5 saved on the night, and gets its grants of before.
--   3. The three replaced bodies are replayed from the backup (stock_rp__snapshot,
--      stock_report_export_start, stock_lock_period) and checked by md5. Their grants never changed.
--   4. The five new reports, the two journal functions and every 4b helper are dropped by signature.
--   5. Weekly email rows waiting or sent are deleted (they are alerts only), and the alert kind CHECK
--      goes back to the twelve Drop 3 kinds exactly as saved.
--   6. stock_month_end_journals is dropped. A draft journal already sent stays in Xero (delete it there
--      if it is not wanted).
--   7. The twelve 4b: backup rows are deleted. The check row is last.
--
-- KEPT, AND WHY
--   Locked periods and their snapshots (a snapshot written by the 4b lock has more keys; the 4a and
--   Drop 3 readers read the keys they know and ignore the rest). Export jobs of a 4b report that already
--   finished keep their file until it expires.
--
-- STORAGE: nothing here touches a storage policy. The storage fix of 23 Oct (20261029b) stays in.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_native_backup') is null then
    raise exception 'stock_native_backup is not there, so the stock functions cannot be put back. Nothing was changed. Ask Claude.';
  end if;
  if to_regprocedure('public.stock_rp__value_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)') is null
     and to_regclass('public.stock_month_end_journals') is null
     and not exists (select 1 from public.stock_native_backup b where left(b.name, 3) = '4b:') then
    raise exception 'Drop 4b (20261030a) is not in. Nothing was changed.';
  end if;
  if (select count(*) from public.stock_native_backup b
       where b.name in ('4b:stock_rp__snapshot', '4b:stock_report_league', '4b:stock_report_dashboard', '4b:stock_report_attention',
                        '4b:stock_report_value', '4b:stock_report_purchases', '4b:stock_report_prices', '4b:stock_report_export_start',
                        '4b:stock_lock_period', '4b:stock_notify_due', '4b:stock_notify_targets', '4b:check:stock_notify_sent_kind_check')) <> 12 then
    raise exception 'stock_native_backup does not hold all twelve rows Drop 4b saved. Nothing was changed. Ask Claude.';
  end if;
  if to_regprocedure('public.stock_rp__league_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)') is null
     or to_regprocedure('public.stock_rp__dashboard_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)') is null
     or to_regprocedure('public.stock_rp__attention_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)') is null
     or to_regprocedure('public.stock_rp__value_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)') is null
     or to_regprocedure('public.stock_rp__purchases_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)') is null
     or to_regprocedure('public.stock_rp__prices_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)') is null
     or to_regprocedure('public.stock_co__notify_due_d3()') is null
     or to_regprocedure('public.stock_co__notify_targets_d3(bigint)') is null then
    raise exception 'A renamed stock function is missing, so it cannot be given its name back. Nothing was changed. Ask Claude.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ---------------------------------------------------------------- the figures this must leave alone
create temp table _stock_native4b_rb_snap (location_id uuid, metric text, value numeric) on commit drop;
create temp table _stock_native4b_rb_now (location_id uuid, metric text, value numeric) on commit drop;
create temp view _stock_native4b_rb_metrics as
select l.id as location_id, m.metric, m.value
  from public.locations l
 cross join lateral (values
   ('n:inventory_items',   (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
   ('n:stock_movements',   (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
   ('n:stock_counts',      (select count(*) from public.stock_counts x where x.location_id = l.id)::numeric),
   ('n:purchase_orders',   (select count(*) from public.purchase_orders x where x.location_id = l.id)::numeric),
   ('n:stock_periods',     (select count(*) from public.stock_periods x where x.location_id = l.id)::numeric),
   ('s:books',             (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
   ('s:mv_value',          (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
   ('s:day_value',         (select sum(x.value) from public.stock_day_sums x where x.location_id = l.id)),
   ('s:sales_net',         (select sum(x.net) from public.sales_day_sums x where x.location_id = l.id))
 ) as m(metric, value)
 where exists (select 1 from public.inventory_items i where i.location_id = l.id)
    or exists (select 1 from public.sales_day_sums s where s.location_id = l.id);
insert into _stock_native4b_rb_snap select * from _stock_native4b_rb_metrics;

-- ---------------------------------------------------------------- 2. the eight public names back
drop function public.stock_report_league(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_report_dashboard(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_report_attention(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_report_value(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_report_purchases(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_report_prices(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_notify_due();
drop function public.stock_notify_targets(bigint);
alter function public.stock_rp__league_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_report_league;
alter function public.stock_rp__dashboard_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_report_dashboard;
alter function public.stock_rp__attention_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_report_attention;
alter function public.stock_rp__value_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_report_value;
alter function public.stock_rp__purchases_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_report_purchases;
alter function public.stock_rp__prices_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_report_prices;
alter function public.stock_co__notify_due_d3() rename to stock_notify_due;
alter function public.stock_co__notify_targets_d3(bigint) rename to stock_notify_targets;
-- their grants of before (4a: the reports to authenticated, league and dashboard also to the service
-- role; Drop 3: stock_notify_targets to the service role, stock_notify_due to nobody)
revoke all on function public.stock_report_league(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_dashboard(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_attention(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_value(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_purchases(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_prices(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_notify_due() from public, anon, authenticated, service_role;
revoke all on function public.stock_notify_targets(bigint) from public, anon, authenticated, service_role;
grant execute on function public.stock_report_league(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated, service_role;
grant execute on function public.stock_report_dashboard(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated, service_role;
grant execute on function public.stock_report_attention(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_value(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_purchases(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_prices(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_notify_targets(bigint) to service_role;

-- ---------------------------------------------------------------- 3. the three replaced bodies, replayed
do $replay$
declare
  r record;
begin
  for r in select b.name, b.body from public.stock_native_backup b
            where b.name in ('4b:stock_rp__snapshot', '4b:stock_report_export_start', '4b:stock_lock_period') order by b.name loop
    execute r.body;
  end loop;
end
$replay$;

do $check_bodies$
declare
  v_bad text;
begin
  select string_agg(f.name, ', ' order by f.name) into v_bad
    from (values
      ('stock_rp__snapshot', 'public.stock_rp__snapshot(uuid,date,date)'),
      ('stock_report_league', 'public.stock_report_league(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
      ('stock_report_dashboard', 'public.stock_report_dashboard(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
      ('stock_report_attention', 'public.stock_report_attention(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
      ('stock_report_value', 'public.stock_report_value(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
      ('stock_report_purchases', 'public.stock_report_purchases(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
      ('stock_report_prices', 'public.stock_report_prices(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
      ('stock_report_export_start', 'public.stock_report_export_start(text,jsonb)'),
      ('stock_lock_period', 'public.stock_lock_period(uuid,date,date)'),
      ('stock_notify_due', 'public.stock_notify_due()'),
      ('stock_notify_targets', 'public.stock_notify_targets(bigint)')) f(name, sig)
    left join pg_proc p on p.oid = to_regprocedure(f.sig)
    left join public.stock_native_backup b on b.name = '4b:' || f.name
   where p.oid is null or b.name is null or md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) is distinct from b.md5;
  if v_bad is not null then
    raise exception 'A stock function did not come back as it was (%). Nothing was changed. Ask Claude.', v_bad;
  end if;
end
$check_bodies$;

-- ---------------------------------------------------------------- 4. what 4b made, by signature
drop function public.stock_report_off_contract(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_report_budget(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_report_transfers(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_report_count_compliance(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_report_month_end(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function public.stock_month_end_journal(uuid, date, date);
drop function public.stock_month_end_journal_record(uuid, date, date, text, jsonb);
drop function public.stock_rp__legal_of(uuid);
drop function public.stock_rp__in_transit(uuid[], date);
drop function public.stock_rp__kitchen_margin(uuid[], date);
drop function public.stock_rp__budget(uuid, date, date, boolean);
drop function public.stock_rp__grni(uuid[], date);
drop function public.stock_rp__credits_out(uuid[], date);
drop function public.stock_rp__recharges(uuid[], date, date);
drop function public.stock_rp__budget_merge(uuid, jsonb, jsonb, date, date);
drop function public.stock_rp__count_merge(uuid, jsonb, date);
drop function public.stock_rp__purchase_extra(uuid[], date, date, boolean);
drop function public.stock_rp__credit_figures(uuid[], date, date);
drop function public.stock_rp__notes_4b(jsonb);
drop function public.stock_rp__oc_lines(uuid[], date, date);
drop function public.stock_rp__margin_same_legal(uuid, date);
drop function public.stock_co__weekly_stage();

-- ---------------------------------------------------------------- 5. the weekly rows and the alert kind CHECK
create temp table _stock_native4b_rb (metric text, value integer) on commit drop;
with d as (delete from public.stock_notify_sent n where n.kind = 'weekly' returning 1)
insert into _stock_native4b_rb (metric, value) select 'weekly_rows_deleted', count(*) from d;

alter table public.stock_notify_sent drop constraint stock_notify_sent_kind_check;
do $kind$
declare
  v_def text := (select b.body from public.stock_native_backup b where b.name = '4b:check:stock_notify_sent_kind_check');
begin
  execute 'alter table public.stock_notify_sent add constraint stock_notify_sent_kind_check ' || v_def;
end
$kind$;

-- ---------------------------------------------------------------- 6. the journal table
drop table public.stock_month_end_journals;

-- ---------------------------------------------------------------- 7. the backup rows
with d as (delete from public.stock_native_backup b where left(b.name, 3) = '4b:' returning 1)
insert into _stock_native4b_rb (metric, value) select 'backup_rows_deleted', count(*) from d;

notify pgrst, 'reload schema';

insert into _stock_native4b_rb_now select * from _stock_native4b_rb_metrics;

-- VISIBLE CHECK. Expected: bodies_restored 11, functions_left 0, tables_left 0, kind_check_back true,
-- weekly_rows_deleted (0 or more), backup_rows_deleted 12, site_rows_changed 0.
select
  (select count(*)::integer from (values
     ('public.stock_rp__snapshot(uuid,date,date)'), ('public.stock_report_league(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
     ('public.stock_report_dashboard(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_attention(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
     ('public.stock_report_value(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_purchases(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
     ('public.stock_report_prices(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_export_start(text,jsonb)'),
     ('public.stock_lock_period(uuid,date,date)'), ('public.stock_notify_due()'), ('public.stock_notify_targets(bigint)')) f(sig)
    where to_regprocedure(f.sig) is not null) as bodies_restored,
  (select count(*)::integer from (values
     ('public.stock_report_off_contract(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_budget(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
     ('public.stock_report_transfers(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_count_compliance(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
     ('public.stock_report_month_end(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_month_end_journal(uuid,date,date)'),
     ('public.stock_month_end_journal_record(uuid,date,date,text,jsonb)'), ('public.stock_rp__league_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
     ('public.stock_rp__dashboard_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_rp__attention_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
     ('public.stock_rp__value_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_rp__purchases_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
     ('public.stock_rp__prices_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_co__notify_due_d3()'), ('public.stock_co__notify_targets_d3(bigint)'),
     ('public.stock_rp__legal_of(uuid)'), ('public.stock_rp__in_transit(uuid[],date)'), ('public.stock_rp__kitchen_margin(uuid[],date)'),
     ('public.stock_rp__budget(uuid,date,date,boolean)'), ('public.stock_rp__grni(uuid[],date)'), ('public.stock_rp__credits_out(uuid[],date)'),
     ('public.stock_rp__recharges(uuid[],date,date)'), ('public.stock_rp__budget_merge(uuid,jsonb,jsonb,date,date)'), ('public.stock_rp__count_merge(uuid,jsonb,date)'),
     ('public.stock_rp__purchase_extra(uuid[],date,date,boolean)'), ('public.stock_rp__credit_figures(uuid[],date,date)'), ('public.stock_rp__notes_4b(jsonb)'),
     ('public.stock_rp__oc_lines(uuid[],date,date)'), ('public.stock_rp__margin_same_legal(uuid,date)'), ('public.stock_co__weekly_stage()')) f(sig)
    where to_regprocedure(f.sig) is not null) as functions_left,
  (case when to_regclass('public.stock_month_end_journals') is null then 0 else 1 end) as tables_left,
  exists (select 1 from pg_constraint c where c.conrelid = 'public.stock_notify_sent'::regclass and c.conname = 'stock_notify_sent_kind_check'
           and pg_get_constraintdef(c.oid) not like '%weekly%') as kind_check_back,
  (select r.value from _stock_native4b_rb r where r.metric = 'weekly_rows_deleted') as weekly_rows_deleted,
  (select r.value from _stock_native4b_rb r where r.metric = 'backup_rows_deleted') as backup_rows_deleted,
  (select count(*)::integer from _stock_native4b_rb_snap b full join _stock_native4b_rb_now a on a.location_id = b.location_id and a.metric = b.metric
    where a.value is distinct from b.value) as site_rows_changed;
