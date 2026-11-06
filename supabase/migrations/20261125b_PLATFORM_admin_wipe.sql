-- 20261125b_PLATFORM_admin_wipe.sql
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 3 functions, service role only. Changes no data by itself.         #
-- ############################################################################
--
-- The Platform twin of 20261125a_OPS_admin_wipe.sql (Peter, 5 Nov 2026: "delete organizations -
-- all locations and wipe all data"). The Platform project holds the venue's payments, gift
-- cards, loyalty, online ordering pages, readers and billing, keyed by its own locations row
-- (ops_location_id points at the Ops venue) and its companies row (the same id as the Ops
-- organisation, or found by slug when it was made before ids were shared).
--
-- WHAT THIS FILE ADDS
--   public.admin_wipe_tables(ids, keys, skip, extra, dry_run)   the engine, the same text as Ops
--   public.admin_wipe_platform_locations(ops_location_ids, dry_run)
--     The Platform locations whose id or ops_location_id is one of the given Ops venue ids,
--     every row keyed by location_id, every row that points at those, then the locations rows.
--   public.admin_wipe_platform_company(company_id, dry_run)
--     Every row keyed by company_id, every row that points at those, then the companies row.
--     Refused while the company still has a locations row (wipe the venues first).
--
-- WHO MAY CALL
--   The service role only (the org-admin edge function). Revoked from public, anon and
--   authenticated.
--
-- Rollback: 20261125b_PLATFORM_admin_wipe_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.companies') is null or to_regclass('public.platform_users') is null then
    raise exception 'This is not the Platform database (companies or platform_users is missing). Nothing was changed.';
  end if;
end
$guard$;

-- ENGINE BEGIN (the same text in 20261125a_OPS_admin_wipe.sql and 20261125b_PLATFORM_admin_wipe.sql; a test pins that)
-- public.admin_wipe_tables: delete every row that belongs to the given ids, whatever table it is in.
--
--   p_ids      the ids, as text (uuid or text keyed tables both match on value)
--   p_keys     column names that mean "this row belongs to that id" (location_id, org_id, ...)
--   p_skip     tables never touched by this call, whatever they contain
--   p_extra    { "table": "sql predicate" } for the parent rows themselves ("locations": "id::text = any($1)")
--   p_dry_run  true = count only; false = delete
--
-- How it finds the rows:
--   1. Every base table in schema public with a column named in p_keys (uuid, text or varchar):
--      rows where that column is one of the ids.
--   2. The p_extra tables with their own predicate.
--   3. Then, round after round until nothing new: every public table with a single column
--      foreign key pointing at a table already in the plan, through a key that does not cascade
--      or set null on delete. A column that cannot be null means the child row belongs to the
--      doomed parent row: it is deleted too. A column that can be null is set null first (the
--      row stays). A key that cascades is listed as well, so its rows are counted and deleted
--      explicitly rather than silently.
-- Then every nullable link is set null, and the deletes run in passes: a delete refused by a
-- foreign key waits for a later pass, after the child rows are gone. A pass that deletes
-- nothing ends the loop; anything still refused raises, and the raise rolls back the whole
-- call, so a wipe is all or nothing.
--
-- The answer: { dry_run, tables: { name: rows }, unlinked: { "table.column": rows }, total, passes }.
create or replace function public.admin_wipe_tables(
  p_ids text[],
  p_keys text[],
  p_skip text[] default '{}',
  p_extra jsonb default '{}'::jsonb,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  preds jsonb := '{}'::jsonb;     -- table -> delete predicate (sql text; $1 = p_ids)
  unlinks jsonb := '{}'::jsonb;   -- table -> { column: predicate } for the set null steps
  seen text[] := '{}';            -- foreign keys already planned (constraint oid::text)
  r record;
  fk record;
  added boolean;
  rounds int := 0;
  remaining text[];
  done text[] := '{}';
  pass int := 0;
  progress boolean;
  t text;
  k text;
  n bigint;
  counts jsonb := '{}'::jsonb;
  unlinked jsonb := '{}'::jsonb;
  total bigint := 0;
  child_pred text;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return jsonb_build_object('dry_run', p_dry_run, 'tables', counts, 'unlinked', unlinked, 'total', 0, 'passes', 0);
  end if;
  p_skip := coalesce(p_skip, '{}');

  -- 1. Direct: every base table in public with a column named in p_keys.
  for r in
    select c.table_name,
           string_agg(format('%I::text = any($1)', c.column_name), ' or ' order by c.column_name) as pred
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public'
      and c.column_name = any(coalesce(p_keys, '{}'))
      and c.data_type in ('uuid', 'text', 'character varying')
      and not (c.table_name = any(p_skip))
    group by c.table_name
  loop
    preds := preds || jsonb_build_object(r.table_name, r.pred);
  end loop;

  -- 2. The parent rows named by the caller (p_skip is for tables found by name; these are named on purpose).
  for r in select key as tbl, value #>> '{}' as pred from jsonb_each(coalesce(p_extra, '{}'::jsonb)) loop
    if to_regclass('public.' || quote_ident(r.tbl)) is not null then
      preds := preds || jsonb_build_object(r.tbl, coalesce(preds ->> r.tbl || ' or ', '') || r.pred);
    end if;
  end loop;

  -- 3. Transitive: rows that point at doomed rows.
  loop
    added := false;
    rounds := rounds + 1;
    for fk in
      select con.oid::text as fkid, child.relname as child, parent.relname as parent,
             a.attname as col, a.attnotnull as notnull, pa.attname as pcol, con.confdeltype as rule
      from pg_constraint con
      join pg_class child on child.oid = con.conrelid
      join pg_namespace ns on ns.oid = child.relnamespace
      join pg_class parent on parent.oid = con.confrelid
      join pg_namespace pns on pns.oid = parent.relnamespace
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = con.confkey[1]
      where con.contype = 'f'
        and ns.nspname = 'public' and pns.nspname = 'public'
        and array_length(con.conkey, 1) = 1
        and con.confdeltype not in ('n', 'd')
        and preds ? parent.relname
        and child.relname <> parent.relname
        and not (child.relname = any(p_skip))
        and not (con.oid::text = any(seen))
      order by child.relname, con.conname
    loop
      seen := seen || fk.fkid;
      child_pred := format('%I in (select %I from public.%I where %s)', fk.col, fk.pcol, fk.parent, preds ->> fk.parent);
      if fk.rule = 'c' or fk.notnull then
        preds := preds || jsonb_build_object(fk.child, coalesce(preds ->> fk.child || ' or ', '') || child_pred);
        added := true;
      else
        unlinks := jsonb_set(unlinks, array[fk.child], coalesce(unlinks -> fk.child, '{}'::jsonb) || jsonb_build_object(fk.col, child_pred));
      end if;
    end loop;
    exit when not added or rounds > 30;
  end loop;

  -- 4. Set the nullable links null (an update never trips a foreign key). A row the plan
  --    deletes anyway is left to the delete, or its key would be blanked before its turn.
  for r in select key as tbl, value as cols from jsonb_each(unlinks) loop
    for k in select key from jsonb_each(r.cols) loop
      child_pred := r.cols ->> k;
      if preds ? r.tbl then
        child_pred := format('(%s) and not coalesce((%s), false)', child_pred, preds ->> r.tbl);
      end if;
      if p_dry_run then
        execute format('select count(*) from public.%I where %s', r.tbl, child_pred) using p_ids into n;
      else
        execute format('update public.%I set %I = null where %s', r.tbl, k, child_pred) using p_ids;
        get diagnostics n = row_count;
      end if;
      if n > 0 then
        unlinked := unlinked || jsonb_build_object(r.tbl || '.' || k, n);
      end if;
    end loop;
  end loop;

  -- 5. Count, or delete in passes.
  select coalesce(array_agg(key order by key), '{}') into remaining from jsonb_each(preds);
  if p_dry_run then
    foreach t in array remaining loop
      execute format('select count(*) from public.%I where %s', t, preds ->> t) using p_ids into n;
      if n > 0 then counts := counts || jsonb_build_object(t, n); total := total + n; end if;
    end loop;
    return jsonb_build_object('dry_run', true, 'tables', counts, 'unlinked', unlinked, 'total', total, 'passes', 0);
  end if;

  while array_length(remaining, 1) is not null and pass < 60 loop
    pass := pass + 1;
    progress := false;
    foreach t in array remaining loop
      begin
        execute format('delete from public.%I where %s', t, preds ->> t) using p_ids;
        get diagnostics n = row_count;
        if n > 0 then counts := counts || jsonb_build_object(t, n); total := total + n; end if;
        done := done || t;
        progress := true;
      exception when foreign_key_violation then
        null;   -- a child still points here; again next pass
      end;
    end loop;
    remaining := array(select x from unnest(remaining) x where not (x = any(done)));
    exit when not progress;
  end loop;

  if array_length(remaining, 1) is not null then
    raise exception 'Wipe stopped: % still refused by a foreign key after % passes. Nothing was changed.',
      array_to_string(remaining, ', '), pass
      using errcode = 'foreign_key_violation';
  end if;

  return jsonb_build_object('dry_run', false, 'tables', counts, 'unlinked', unlinked, 'total', total, 'passes', pass);
end
$fn$;
-- ENGINE END

-- ===== Venues =====
create or replace function public.admin_wipe_platform_locations(p_ops_location_ids uuid[], p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  ids uuid[];
  report jsonb;
begin
  if p_ops_location_ids is null or array_length(p_ops_location_ids, 1) is null then
    raise exception 'No location given.';
  end if;
  select coalesce(array_agg(id), '{}') into ids
  from public.locations
  where id = any(p_ops_location_ids) or ops_location_id = any(p_ops_location_ids);
  if array_length(ids, 1) is null then
    return jsonb_build_object('dry_run', p_dry_run, 'tables', '{}'::jsonb, 'unlinked', '{}'::jsonb, 'total', 0, 'passes', 0, 'locations', 0);
  end if;
  report := public.admin_wipe_tables(
    ids::text[],
    array['location_id'],
    array['locations'],
    jsonb_build_object('locations', 'id::text = any($1)'),
    p_dry_run
  );
  return report || jsonb_build_object('locations', array_length(ids, 1));
end
$fn$;

-- ===== The company =====
create or replace function public.admin_wipe_platform_company(p_company_id uuid, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  left_over int;
  report jsonb;
begin
  if p_company_id is null then
    raise exception 'No company given.';
  end if;
  if not exists (select 1 from public.companies where id = p_company_id) then
    return jsonb_build_object('dry_run', p_dry_run, 'tables', '{}'::jsonb, 'unlinked', '{}'::jsonb, 'total', 0, 'passes', 0, 'company', false);
  end if;
  select count(*) into left_over from public.locations where company_id = p_company_id;
  if left_over > 0 and not p_dry_run then
    raise exception 'The company still has % location(s). Wipe the locations first.', left_over
      using errcode = 'foreign_key_violation';
  end if;
  report := public.admin_wipe_tables(
    array[p_company_id::text],
    array['company_id'],
    array['companies'],
    jsonb_build_object('companies', 'id::text = any($1)'),
    p_dry_run
  );
  return report || jsonb_build_object('company', true);
end
$fn$;

-- ===== Who may call: the service role only =====
revoke all on function public.admin_wipe_tables(text[], text[], text[], jsonb, boolean) from public, anon, authenticated;
revoke all on function public.admin_wipe_platform_locations(uuid[], boolean) from public, anon, authenticated;
revoke all on function public.admin_wipe_platform_company(uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_wipe_tables(text[], text[], text[], jsonb, boolean) to service_role;
grant execute on function public.admin_wipe_platform_locations(uuid[], boolean) to service_role;
grant execute on function public.admin_wipe_platform_company(uuid, boolean) to service_role;

comment on function public.admin_wipe_platform_company(uuid, boolean) is
  'Company Admin: wipe a company and its Platform data (after its locations). Service role only; the org-admin edge function calls it. dry_run = true only counts.';
comment on function public.admin_wipe_platform_locations(uuid[], boolean) is
  'Company Admin: wipe Platform locations (by id or ops_location_id) and all their data. Service role only.';

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): 3 functions, and only the service role can run the wipe.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('admin_wipe_tables', 'admin_wipe_platform_locations', 'admin_wipe_platform_company')) as functions_added,
  has_function_privilege('anon', 'public.admin_wipe_platform_company(uuid, boolean)', 'execute') as anon_can_wipe,
  has_function_privilege('authenticated', 'public.admin_wipe_platform_company(uuid, boolean)', 'execute') as login_can_wipe,
  has_function_privilege('service_role', 'public.admin_wipe_platform_company(uuid, boolean)', 'execute') as service_can_wipe;
