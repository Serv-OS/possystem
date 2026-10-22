-- 20261029a_OPS_reports_align_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand, after UK close, only if Reports align           #
-- #  (20261029a_OPS_reports_align.sql) has to be undone. Run it BEFORE any    #
-- #  4a or drainer rollback. One paste, one transaction: any error and        #
-- #  nothing changes. A second paste refuses and changes nothing. It waits    #
-- #  at most 3 s for a busy table, then gives up: run it again a minute later.#
-- ############################################################################
--
-- Undoes 20261029a_OPS_reports_align.sql. Every object is named exactly; nothing is found by a pattern.
--
-- WHAT IT DOES, IN ORDER
--   1. Guard: Ops database; some part of Reports align is in; then all fourteen rows it saved
--      (stock_native_backup rows named align:<name>: twelve function bodies and two policies) are there.
--   2. Function bodies: replays the twelve bodies saved on the night (sales_day_sums_rebuild,
--      sales_day_sums_check, _sales_day_sums_enqueue, _sales_check_parts, report_day_sums, stock_rp__labour,
--      stock_rp__site_sales, stock_rp__site_figures, stock_rp__derive, stock_rp__demo_sales,
--      stock_rp__meta, stock_report_waste) and checks each against the md5 saved with it. Their grants
--      were never changed.
--   3. Policies: puts back waste_events_ins and waste_events_upd exactly as they were.
--   4. Queues for the drain (15 venue days a minute, newest first) the same days the forward file
--      queued (every day a refund was made, every day holding a demo check), so the old rule rebuilds
--      them; until then those days read as the new rule left them.
--   5. Drops the six helpers by exact signature and the seven sales_day_sums columns.
--   6. Deletes the fourteen align: backup rows. Nobody else's rows are touched.
--   7. The check row, last: bodies_restored 12, policies_back 2, helpers_left 0, columns_left 0,
--      days_queued (about 180 live), site_rows_changed 0.
--
-- WEB AND EDGE: the 5.11.99 app and functions keep working with this rollback (they read only what was
-- there before; the Back Office day sums and every function read the same columns as 5.11.98).

do $guard$
declare
  v_any boolean;
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_native_backup') is null then
    raise exception 'stock_native_backup is not there, so the report functions cannot be put back. Nothing was changed. Ask Claude.';
  end if;
  v_any := to_regprocedure('public._sales_refund_parts(public.closed_checks,jsonb)') is not null
        or to_regprocedure('public._sales_is_demo(text)') is not null
        or exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = 'sales_day_sums' and c.column_name = 'refund_net')
        or exists (select 1 from public.stock_native_backup b where left(b.name, 6) = 'align:');
  if not v_any then
    raise exception 'Reports align (20261029a) is not in. Nothing was changed.';
  end if;
  if (select count(*) from public.stock_native_backup b
       where b.name in ('align:sales_day_sums_rebuild', 'align:sales_day_sums_check', 'align:_sales_day_sums_enqueue', 'align:report_day_sums', 'align:_sales_check_parts',
                        'align:stock_rp__labour', 'align:stock_rp__site_sales', 'align:stock_rp__site_figures', 'align:stock_rp__derive',
                        'align:stock_rp__demo_sales', 'align:stock_rp__meta', 'align:stock_report_waste',
                        'align:policy:waste_events_ins', 'align:policy:waste_events_upd')) <> 14 then
    raise exception 'stock_native_backup does not hold all fourteen rows Reports align saved. Nothing was changed. Ask Claude.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ---------------------------------------------------------------- the figures this must leave alone
create temp table _reports_align_rb_snap (location_id uuid, metric text, value numeric) on commit drop;
create temp table _reports_align_rb_now (location_id uuid, metric text, value numeric) on commit drop;
create temp view _reports_align_rb_metrics as
select l.id as location_id, m.metric, m.value
  from public.locations l
 cross join lateral (values
   ('n:inventory_items',   (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
   ('n:stock_movements',   (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
   ('n:waste_events',      (select count(*) from public.waste_events x where x.location_id = l.id)::numeric),
   ('n:stock_day_sums',    (select count(*) from public.stock_day_sums x where x.location_id = l.id)::numeric),
   ('s:on_hand',           (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
   ('s:books',             (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
   ('s:mv_value',          (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
   ('s:waste_cost',        (select sum(x.cost_value) from public.waste_events x where x.location_id = l.id)),
   ('s:day_value',         (select sum(x.value) from public.stock_day_sums x where x.location_id = l.id))
 ) as m(metric, value)
 where exists (select 1 from public.inventory_items i where i.location_id = l.id);
insert into _reports_align_rb_snap select * from _reports_align_rb_metrics;

-- ---------------------------------------------------------------- 2. the twelve bodies, back as they were
do $restore$
declare
  r record;
  v_now text;
begin
  for r in
    select b.name, b.body, b.md5, s.sig
      from (values
        ('align:sales_day_sums_rebuild', 'public.sales_day_sums_rebuild(uuid,date,date)'),
        ('align:sales_day_sums_check', 'public.sales_day_sums_check(uuid,date)'),
        ('align:_sales_day_sums_enqueue', 'public._sales_day_sums_enqueue()'),
        ('align:_sales_check_parts', 'public._sales_check_parts(public.closed_checks)'),
        ('align:report_day_sums', 'public.report_day_sums(text[],date,date,jsonb)'),
        ('align:stock_rp__labour', 'public.stock_rp__labour(uuid,date,date)'),
        ('align:stock_rp__site_sales', 'public.stock_rp__site_sales(jsonb)'),
        ('align:stock_rp__site_figures', 'public.stock_rp__site_figures(jsonb,jsonb)'),
        ('align:stock_rp__derive', 'public.stock_rp__derive(uuid,jsonb)'),
        ('align:stock_rp__demo_sales', 'public.stock_rp__demo_sales(uuid,date,date)'),
        ('align:stock_rp__meta', 'public.stock_rp__meta(jsonb,text,date,date,boolean,text,jsonb,jsonb,jsonb)'),
        ('align:stock_report_waste', 'public.stock_report_waste(uuid,uuid[],date,date,jsonb,jsonb,integer)')
      ) as s(name, sig)
      join public.stock_native_backup b on b.name = s.name
     order by s.name
  loop
    execute r.body;
    select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_now from pg_proc p where p.oid = to_regprocedure(r.sig);
    if v_now is distinct from r.md5 then
      raise exception 'The saved body of % did not come back as it was (md5 % against %). Nothing was changed. Ask Claude.', r.sig, v_now, r.md5;
    end if;
  end loop;
end
$restore$;

-- ---------------------------------------------------------------- 3. the two waste_events policies
do $policies$
declare
  r record;
begin
  for r in
    select b.name, b.body from public.stock_native_backup b
     where b.name in ('align:policy:waste_events_ins', 'align:policy:waste_events_upd')
     order by b.name
  loop
    if not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'waste_events'
                      and p.policyname = substr(r.name, 14)) then
      execute r.body;
    end if;
  end loop;
end
$policies$;

-- ---------------------------------------------------------------- 4. the same days, queued for the old rule
create temp table _reports_align_rb_queued (days integer) on commit drop;
with v as (
  select s.location_id, min(s.business_day) as first_day
    from public.sales_day_sums s
   group by s.location_id
),
rday as (
  select distinct c.location_id::uuid as location_id,
         (select d.business_day from public.stock_co__venue_day(c.location_id::uuid,
            coalesce(public._rds_ms(e.r -> 'timestamp'), public._rds_ms(e.r -> 'at'), public._rds_ms(e.r -> 'created_at'), c.closed_at)) d) as business_day
    from public.closed_checks c
   cross join lateral jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) as e(r)
   where c.refunds is not null and c.refunds <> '[]'::jsonb and c.closed_at >= now() - interval '400 days'
     and c.location_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and jsonb_typeof(e.r) = 'object'
),
dday as (
  select distinct c.location_id::uuid as location_id,
         (select d.business_day from public.stock_co__venue_day(c.location_id::uuid, c.closed_at) d) as business_day
    from public.closed_checks c
   where c.id like 'demo-%' and c.closed_at >= now() - interval '400 days'
     and c.location_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
days as (
  select distinct x.location_id, x.business_day
    from (select r.location_id, r.business_day from rday r union all select d.location_id, d.business_day from dday d) x
    join v on v.location_id = x.location_id
   where x.business_day is not null and x.business_day >= v.first_day
     and x.business_day <= (select t.business_day from public.stock_co__venue_day(x.location_id, now()) t)
),
q as (
  insert into public.sales_day_sums_queue (location_id, business_day, reason, queued_at, attempts, due_at)
  select d.location_id, d.business_day, 'reports_align_rollback', now(), 0,
         now() + ((row_number() over (order by d.business_day desc, d.location_id) - 1) / 15) * interval '1 minute'
    from days d
   order by d.business_day desc, d.location_id
  on conflict (location_id, business_day) do update set due_at = least(public.sales_day_sums_queue.due_at, excluded.due_at)
  returning 1
)
insert into _reports_align_rb_queued select count(*) from q;

-- ---------------------------------------------------------------- 5. the helpers and the columns go
drop function public._sales_refund_parts(public.closed_checks, jsonb);
drop function public._sales_refund_at(jsonb, timestamptz);
drop function public._sales_check_tenders(public.closed_checks);
drop function public._sales_kind(text);
drop function public._sales_allocate(bigint, bigint[]);
drop function public._sales_is_demo(text);
alter table public.sales_day_sums
  drop column sale_net,
  drop column sale_theo,
  drop column refund_net,
  drop column refund_tax,
  drop column refund_gross,
  drop column refund_qty,
  drop column refund_cost;
comment on column public.sales_day_sums.net is null;
comment on column public.sales_day_sums.theo_cost is null;

-- ---------------------------------------------------------------- 6. its backup rows
delete from public.stock_native_backup b where left(b.name, 6) = 'align:';

notify pgrst, 'reload schema';

insert into _reports_align_rb_now select * from _reports_align_rb_metrics;
do $compare$
declare
  v_bad text;
begin
  select string_agg(coalesce(b.metric, a.metric) || ' at ' || coalesce(b.location_id, a.location_id)::text, ', ')
    into v_bad
    from _reports_align_rb_snap b
    full join _reports_align_rb_now a on a.location_id = b.location_id and a.metric = b.metric
   where a.metric is null or b.metric is null or a.value is distinct from b.value;
  if v_bad is not null then
    raise exception 'The rollback changed a site row (%). Nothing was changed. Send this line to Claude.', left(v_bad, 600);
  end if;
end
$compare$;

-- VISIBLE CHECK, last: bodies_restored 12, policies_back 2, helpers_left 0, columns_left 0, backup_rows_left 0,
-- days_queued about 180 live, site_rows_changed 0.
select
  (select count(*)::integer from (values
     ('public.sales_day_sums_rebuild(uuid,date,date)', '007c100176c9438b35c6531916555a79'),
     ('public.sales_day_sums_check(uuid,date)', '309f47ed5dc335eaea8b39fca077df25'),
     ('public._sales_day_sums_enqueue()', '35a05a622b0c4034f3a42f4fe18a6c5e'),
     ('public._sales_check_parts(public.closed_checks)', 'e8bf29d73eb072ae3ea7320e6db8d6ed'),
     ('public.report_day_sums(text[],date,date,jsonb)', '25a8daf22bd412c1a2579807d21b223c'),
     ('public.stock_rp__labour(uuid,date,date)', 'c517bbdaa5d045ee61da531288fa39df'),
     ('public.stock_rp__site_sales(jsonb)', '56b344ed1a153802e2b239a52b12b5b8'),
     ('public.stock_rp__site_figures(jsonb,jsonb)', '2682edc3b68ad1c9e1900c1ae174fe5b'),
     ('public.stock_rp__derive(uuid,jsonb)', '0e3d2aa719c32b9378a49a80567f832c'),
     ('public.stock_rp__demo_sales(uuid,date,date)', '38dc304d476f2d7892f2922cfbefdb9d'),
     ('public.stock_rp__meta(jsonb,text,date,date,boolean,text,jsonb,jsonb,jsonb)', '7dc410b654129a53de9ca72065a62bdf'),
     ('public.stock_report_waste(uuid,uuid[],date,date,jsonb,jsonb,integer)', '012537d5fb83c45c65f75ae3906cefba')) e(sig, want)
    join pg_proc p on p.oid = to_regprocedure(e.sig)
   where md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = e.want) as bodies_restored,
  (select count(*)::integer from pg_policies p where p.schemaname = 'public' and p.tablename = 'waste_events'
      and p.policyname in ('waste_events_ins', 'waste_events_upd')) as policies_back,
  (select count(*)::integer from (values ('public._sales_is_demo(text)'), ('public._sales_allocate(bigint,bigint[])'), ('public._sales_kind(text)'),
     ('public._sales_check_tenders(public.closed_checks)'), ('public._sales_refund_at(jsonb,timestamptz)'),
     ('public._sales_refund_parts(public.closed_checks,jsonb)')) f(sig) where to_regprocedure(f.sig) is not null) as helpers_left,
  (select count(*)::integer from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'sales_day_sums'
      and c.column_name in ('sale_net', 'sale_theo', 'refund_net', 'refund_tax', 'refund_gross', 'refund_qty', 'refund_cost')) as columns_left,
  (select count(*)::integer from public.stock_native_backup b where left(b.name, 6) = 'align:') as backup_rows_left,
  (select days from _reports_align_rb_queued) as days_queued,
  (select count(*)::integer from _reports_align_rb_snap b join _reports_align_rb_now a on a.location_id = b.location_id and a.metric = b.metric
    where a.value is distinct from b.value) as site_rows_changed;
