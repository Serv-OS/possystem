-- 20261125a_OPS_admin_wipe.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 3 functions, service role only. Changes no data by itself.         #
-- ############################################################################
--
-- WHY (Peter, 5 Nov 2026)
--   "Cant delete organizations from the back office. Delete button doesn't do anything, this
--   should say delete organizations - all locations and wipe all data."
--   Until now Company Admin deleted 13 hand listed tables from the browser and ignored every
--   error. Two hundred other tables point at a venue, so the locations row could not go, the
--   organisation row could not go, and the screen said "deleted" while nothing had changed.
--
-- WHAT THIS FILE ADDS
--   public.admin_wipe_tables(ids, keys, skip, extra, dry_run)   the engine, see its own header
--   public.admin_wipe_locations(location_ids, dry_run)
--     One or more venues: every row keyed by location_id (and local_location_id,
--     internal_location_id, kitchen_location_id), every row that points at those, then the
--     locations rows. Logins keep their profile; a profile whose home venue this was loses
--     that pointer only.
--   public.admin_wipe_organisation(org_id, org_name, dry_run)
--     The whole company: its venues as above, then every row keyed by org_id, then the
--     profiles of its people (never a ServOS super admin, whose profile is only unlinked),
--     then the organisations row. The name typed on the screen must match the organisation's
--     name or nothing happens. The answer carries login_ids: the org-admin edge function
--     removes those sign ins through the auth admin API afterwards (this file never touches
--     schema auth). A dry run cannot delete the venues first, so a row with both a venue and
--     a company lineage (a customer's order) is counted twice; the wipe deletes it once.
--
-- WHO MAY CALL
--   The service role only (the org-admin edge function, behind the second sign in step and
--   the super_admin role). Revoked from public, anon and authenticated.
--
-- WHAT IT DOES NOT DO
--   Files in storage buckets, the Platform database rows (payments, gift cards, loyalty, the
--   Platform locations and company) and the auth.users rows are the edge function's job.
--   20261125b_PLATFORM_admin_wipe.sql is the Platform twin of this file.
--
-- ALL OR NOTHING: each function call is one transaction. A foreign key that still refuses
-- after every pass raises, and the raise rolls the whole call back.
--
-- Rollback: 20261125a_OPS_admin_wipe_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.organisations') is null or to_regclass('public.user_profiles') is null then
    raise exception 'This is not the Ops database (organisations or user_profiles is missing). Nothing was changed.';
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
create or replace function public.admin_wipe_locations(p_location_ids uuid[], p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  found int;
  report jsonb;
  profiles bigint := 0;
begin
  if p_location_ids is null or array_length(p_location_ids, 1) is null then
    raise exception 'No location given.';
  end if;
  select count(*) into found from public.locations where id = any(p_location_ids);
  if found <> array_length(p_location_ids, 1) then
    raise exception 'Location not found (% of % given exist).', found, array_length(p_location_ids, 1);
  end if;

  -- A login's profile is the person's, not the venue's: only its home venue pointer goes.
  if p_dry_run then
    select count(*) into profiles from public.user_profiles where location_id = any(p_location_ids);
  else
    update public.user_profiles set location_id = null where location_id = any(p_location_ids);
    get diagnostics profiles = row_count;
  end if;

  report := public.admin_wipe_tables(
    p_location_ids::text[],
    array['location_id', 'local_location_id', 'internal_location_id', 'kitchen_location_id'],
    array['locations', 'user_profiles'],
    jsonb_build_object('locations', 'id::text = any($1)'),
    p_dry_run
  );
  return report || jsonb_build_object('locations', array_length(p_location_ids, 1), 'profiles_unlinked', profiles);
end
$fn$;

-- ===== The whole company =====
create or replace function public.admin_wipe_organisation(p_org_id uuid, p_org_name text, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  org record;
  loc_ids uuid[];
  login_ids uuid[];
  venues jsonb := '{}'::jsonb;
  people jsonb := '{}'::jsonb;
  company jsonb := '{}'::jsonb;
  staff_unlinked bigint := 0;
begin
  select id, name into org from public.organisations where id = p_org_id;
  if org.id is null then
    raise exception 'Organisation not found.';
  end if;
  if lower(trim(coalesce(p_org_name, ''))) <> lower(trim(coalesce(org.name, ''))) then
    raise exception 'The name typed does not match the organisation name.'
      using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(id), '{}') into loc_ids from public.locations where org_id = p_org_id;

  -- 1. The venues.
  if array_length(loc_ids, 1) is not null then
    venues := public.admin_wipe_locations(loc_ids, p_dry_run);
  end if;

  -- 2. The people: every profile of this company that is not ServOS staff, with whatever
  --    points at those profiles. Their sign ins (auth.users) are the edge function's job.
  select coalesce(array_agg(id), '{}') into login_ids
  from public.user_profiles
  where org_id = p_org_id and coalesce(role, '') <> 'super_admin';
  if array_length(login_ids, 1) is not null then
    people := public.admin_wipe_tables(
      login_ids::text[],
      '{}'::text[],
      '{}'::text[],
      jsonb_build_object('user_profiles', 'id::text = any($1)'),
      p_dry_run
    );
  end if;

  -- 3. Everything keyed by org_id, then the organisations row. A ServOS super admin whose
  --    profile sits on this company keeps the profile and loses the company pointer.
  if p_dry_run then
    select count(*) into staff_unlinked from public.user_profiles where org_id = p_org_id and role = 'super_admin';
  else
    update public.user_profiles set org_id = null, location_id = null where org_id = p_org_id and role = 'super_admin';
    get diagnostics staff_unlinked = row_count;
  end if;
  --    locations is skipped here: the venues step owns it (and a dry run would count its
  --    children twice).
  company := public.admin_wipe_tables(
    array[p_org_id::text],
    array['org_id'],
    array['organisations', 'user_profiles', 'locations'],
    jsonb_build_object('organisations', 'id::text = any($1)'),
    p_dry_run
  );

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'organisation', org.name,
    'locations', coalesce(array_length(loc_ids, 1), 0),
    'logins', coalesce(array_length(login_ids, 1), 0),
    'login_ids', to_jsonb(login_ids),
    'staff_unlinked', staff_unlinked,
    'venues', venues,
    'people', people,
    'company', company,
    'total', coalesce((venues ->> 'total')::bigint, 0) + coalesce((people ->> 'total')::bigint, 0) + coalesce((company ->> 'total')::bigint, 0)
  );
end
$fn$;

-- ===== Who may call: the service role only =====
revoke all on function public.admin_wipe_tables(text[], text[], text[], jsonb, boolean) from public, anon, authenticated;
revoke all on function public.admin_wipe_locations(uuid[], boolean) from public, anon, authenticated;
revoke all on function public.admin_wipe_organisation(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.admin_wipe_tables(text[], text[], text[], jsonb, boolean) to service_role;
grant execute on function public.admin_wipe_locations(uuid[], boolean) to service_role;
grant execute on function public.admin_wipe_organisation(uuid, text, boolean) to service_role;

comment on function public.admin_wipe_organisation(uuid, text, boolean) is
  'Company Admin: delete an organisation, all its locations and wipe all its data (Ops side). Service role only; the org-admin edge function calls it. dry_run = true only counts.';
comment on function public.admin_wipe_locations(uuid[], boolean) is
  'Company Admin: delete one or more locations and wipe all their data (Ops side). Service role only.';

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): 3 functions, and only the service role can run the wipe.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('admin_wipe_tables', 'admin_wipe_locations', 'admin_wipe_organisation')) as functions_added,
  has_function_privilege('anon', 'public.admin_wipe_organisation(uuid, text, boolean)', 'execute') as anon_can_wipe,
  has_function_privilege('authenticated', 'public.admin_wipe_organisation(uuid, text, boolean)', 'execute') as login_can_wipe,
  has_function_privilege('service_role', 'public.admin_wipe_organisation(uuid, text, boolean)', 'execute') as service_can_wipe;
