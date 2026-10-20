-- 20261021a_OPS_stock_native_0a.sql
-- Multi site stock, Drop 0, migration 0a: native company stock records (no screens change).
--
-- WHAT IT IS
--   Every company that holds stock gets company records made from its own site rows; every
--   catalogue write gets a save function (the Drop 0 web build calls them); Stock control is stored,
--   guarded and settable, but its levels switch on in Drop 1, so NOBODY'S RIGHTS CHANGE tonight;
--   the demo company's two sites (Provo and Location 2) become one list with no number moving (the
--   one deliberate change: Location 2 gets its own copies of the shared packs and unit bridges);
--   every cost change writes a REVALUE line; the venue clock, day totals, the save queue, the
--   nightly upkeep and the manager PIN for count approval are added. One lock is here already:
--   company_ref (which company record a stock row belongs to) is set only by the stock save
--   functions from tonight; no screen writes it.
--   Not in this file: the company field lock triggers and the count approval revoke (20261022a 0b, a later night)
--   and the one off ledger line (20261021a_OPS_stock_native_0a_revalue.sql, straight after this).
--
-- WHERE AND WHEN
--   OPS DATABASE ONLY (tbetcegmszzotrwdtqhi). The guard refuses anywhere else.
--   Run AFTER UK CLOSE, never in service. NEVER on 25 Oct 2026 (UK clocks) or 1 Nov 2026 (US clocks).
--   Run before_stock_native.sql first and save its answer (a record only, not the test).
--
-- NEEDS THESE FILES LIVE FIRST (all already run on Ops by 20 Oct 2026; the guard and the body
-- check at the top stop the file, changing nothing, when what it needs from them is missing)
--   20260921u_OPS_owner_holds_own_company.sql   (the profile guard body this file checks)
--   20261005b_OPS_report_day_sums.sql           (the sales day totals check compares with it)
--   20261017_OPS_multi_site_menu.sql            (msm__second_step_ok, msm_product_sites)
--   20261018a_OPS_stock_function_fences.sql
--   20261018c_OPS_central_stock_depletion.sql   (stock_outbox, stock_explode)
--   20261019_OPS_central_stock_default.sql
--   20261019b_OPS_stock_phase0.sql              (_post_stock_movement and the cost writers)
--   20261019a_OPS_channel_parity.sql
--   20261020a_OPS_channel_parity_2.sql          (hubrise_menu_fingerprint)
--   pg_cron, pg_net and the vault (all live on Ops).
--   The rejected Phase 1 file (20261019c) must NOT have been run: the guard refuses if it was.
--
-- HOW IT RUNS
--   Paste the whole file into the SQL editor and run it once: the editor runs one paste as ONE
--   TRANSACTION, so it all lands or none of it does. No begin or commit in here on purpose.
--   The first statement is the guard. Straight after it:
--     set local lock_timeout = '3s';       (it waits at most 3 s for a busy table, then stops and
--                                            changes nothing: run it again a minute later)
--     set local statement_timeout = '300s';
--   It then checks that the seven stock bodies it rebuilds are still the text it was written
--   against (else: 'A stock function changed since this file was written. Ask Claude for a new
--   file.'), saves them in stock_native_backup for the rollback, takes the row lock on the stock
--   items of every company that holds stock (sales wait, the drainer retries, nothing is lost) and
--   snapshots 33 figures per venue. Before the end it compares every figure with that snapshot and
--   stops (undoing everything) on any difference other than the Location 2 pack and bridge fills.
--   The last statement is the check row: one row per venue that holds stock. Paste it back.
--   Expect it to take a few seconds. While it runs, signed in requests that read user_profiles or
--   the stock tables wait for it, so keep it to a quiet moment.
--
-- THE OPTIONAL BLOCK
--   Part 1 holds one clearly marked OPTIONAL block (the profile guard org_id fix, open question 22).
--   To leave it out, delete from its START line to its END line, both included. Nothing else
--   depends on it; the check row column profile_guard_closed then reads false.
--
-- IF IT STOPS
--   Any error means nothing changed. A stop on a lock wait ('canceling statement due to lock
--   timeout') or 'deadlock detected' only means a stock screen or a sale was busy at that moment:
--   run it again in a quieter minute. Any other words: send them to Claude.
--
-- IF SOMETHING IS WRONG AFTER IT RAN
--   20261021a_OPS_stock_native_0a_ROLLBACK.sql (run the 0b rollback first if 0b has run).
--
-- Built from five parts, in order, byte for byte (each starts with a '-- == 0a part N:' line).

-- == 0a part 1: foundation (steps 0, 1, the profile guard block, 2, 3, 4) ==
--
-- Step 0  The guard (first statement), the time limits, the check that seven live stock bodies are
--         still the text this file was built against, a backup of those seven bodies, the row locks
--         on the stock items of every company that holds stock, and the snapshot that part 5
--         compares against before the check row.
-- Step 1  Stock control: user_profiles.stock_control, its guard trigger, set_stock_control,
--         stock_level, stock_reach_locations, stock_reach_orgs.
-- Block   OPTIONAL: the profile guard org_id fix (open question 22). Peter may leave it out.
-- Step 2  Company settings, site settings and site groups, the settings backfill, and the trigger
--         that marks a company as multi site the moment it has two open sites.
-- Step 3  New columns on the site tables (company_ref, row_version, archived_at, supplier extras,
--         the PIN holder on counts) and the company_ref indexes.
-- Step 4  Foreign key indexes.
--
-- Nothing here moves an on hand, cost, ledger or count number, and nothing changes anyone's rights:
-- Stock control starts empty (null means sites) for every login, so stock_reach_locations() returns
-- exactly what user_accessible_locations() returns today. Function grants and revokes are all in
-- part 5 (the grant block); the table grants for the tables made here are here.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)') is null
     or to_regclass('public.stock_outbox') is null
     or not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'stock_explode')
     or not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'hubrise_menu_fingerprint') then
    raise exception 'Stock Phase 0 (20261019b), central stock (20261018c) and channel parity 2 (20261020a) must be live first. Nothing was changed.';
  end if;
  if to_regclass('public.msm_stock_items') is not null or to_regclass('public.stock_company') is not null then
    raise exception 'The rejected Phase 1 stock file (20261019c) has been run here. Run its rollback, then ask Claude. Nothing was changed.';
  end if;
  if to_regclass('public.stock_co_items') is not null or to_regclass('public.stock_co_settings') is not null
     or to_regclass('public.stock_save_queue') is not null or to_regclass('public.stock_native_backup') is not null
     or exists (select 1 from information_schema.columns c
                 where c.table_schema = 'public' and c.table_name = 'inventory_items' and c.column_name = 'company_ref')
     or exists (select 1 from information_schema.columns c
                 where c.table_schema = 'public' and c.table_name = 'user_profiles' and c.column_name = 'stock_control') then
    raise exception 'Multi site stock Drop 0 (20261021a) has already run here. Nothing was changed.';
  end if;
  if to_regprocedure('public.msm__second_step_ok()') is null or to_regclass('public.msm_product_sites') is null then
    raise exception 'Run 20261017_OPS_multi_site_menu.sql first (the Multi site menu). Nothing was changed.';
  end if;
  if to_regprocedure('public.stock_qty_to_base(numeric,text,uuid)') is null
     or to_regprocedure('public.stock_convert_qty(numeric,text,text,uuid[])') is null
     or to_regprocedure('public.user_accessible_locations()') is null
     or to_regprocedure('public.accessible_location_uuids()') is null
     or to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.is_anon_session()') is null
     or to_regprocedure('public._org_created_by_me(uuid)') is null
     or to_regprocedure('public.stock_same_company(uuid,uuid)') is null
     or to_regprocedure('public.stock_js_key(jsonb)') is null
     or to_regprocedure('public.stock_js_num(jsonb)') is null
     or to_regprocedure('public.stock_js_qty(jsonb)') is null
     or to_regprocedure('public.stock_js_truthy(jsonb)') is null
     or to_regprocedure('public._rds_num(jsonb)') is null
     or to_regprocedure('public.report_day_sums(text[],date,date,jsonb)') is null
     or to_regclass('public.stock_site_settings') is null then
    raise exception 'A stock or sign in helper this file needs is missing. Nothing was changed. Send this line to Claude.';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not there (cron.schedule). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ============================================================================
-- STEP 0. THE BODIES THIS FILE CHANGES OR DEPENDS ON, STILL AS BUILT
-- ============================================================================
-- Each body is compared by the house rule: md5 of the function source with every run of white space
-- made one space (the same text the repo migration holds, so the harness gets the same answer). The
-- first seven are replaced later in this file (user_profiles_fence_guard only by the optional block);
-- _post_stock_movement is checked only, because the REVALUE rule depends on it posting a receipt at
-- the delivered price. Read live 20 Oct 2026.
do $bodies$
declare
  v_bad text;
begin
  select string_agg(e.name, ', ' order by e.name) into v_bad
    from (values
      ('_stock_receive_lines', 'public._stock_receive_lines(uuid,text,text,jsonb,uuid,text)', '188d811b62552b501a42c7948ad46a22'),
      ('approve_stock_count', 'public.approve_stock_count(uuid,text,text,jsonb,boolean)', 'd920cc8d432e65a1373fd1548e7cfc7e'),
      ('post_stock_transfer_leg', 'public.post_stock_transfer_leg(uuid,text,text)', 'f321c21b48115a8de8fbfcb021ab4577'),
      ('stock_office_reaches', 'public.stock_office_reaches(uuid)', 'f822b368352f2cc5d307c6aba9917429'),
      ('stock_caller_reaches', 'public.stock_caller_reaches(uuid)', '6f7553102dbaf750eb13e82fdd5d5149'),
      ('stock_cost_rule', 'public.stock_cost_rule(uuid)', '8fdd834c5814089d6baaa46c2660e5c7'),
      ('user_profiles_fence_guard', 'public.user_profiles_fence_guard()', '79ed2f68e3504dc1f38e98aee31a7baa'),
      ('_post_stock_movement', 'public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)', '2974176b3ea49b90065dc0c20572e343')
    ) as e(name, sig, want)
    left join pg_proc p on p.oid = to_regprocedure(e.sig)
   where p.oid is null
      or md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) is distinct from e.want;
  if v_bad is not null then
    raise exception 'A stock function changed since this file was written. Ask Claude for a new file. Changed: %. Nothing was changed.', v_bad;
  end if;
end
$bodies$;

-- The seven bodies as they are tonight, replayable (pg_get_functiondef text). The 0a rollback runs
-- each one back, so it restores what was live on the night, not what was live at build time. Owner
-- only: no API role can read it.
create table public.stock_native_backup (
  name      text primary key,
  body      text not null,
  md5       text not null,
  saved_at  timestamptz not null default now()
);
comment on table public.stock_native_backup is 'Multi site stock Drop 0 (20261021a): the seven live function bodies 0a replaced or may replace, saved before it changed them (pg_get_functiondef text, replayable) with the checked md5. The 0a rollback replays every row, then drops this table. Owner only.';
alter table public.stock_native_backup enable row level security;
revoke all on table public.stock_native_backup from public, anon, authenticated, service_role;
do $fence_backup$
begin
  if to_regprocedure('public.second_step_ok()') is not null then
    create policy second_step_fence on public.stock_native_backup as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
  end if;
end
$fence_backup$;

insert into public.stock_native_backup (name, body, md5)
select p.proname, pg_get_functiondef(p.oid), md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
  from (values
    ('public._stock_receive_lines(uuid,text,text,jsonb,uuid,text)'),
    ('public.approve_stock_count(uuid,text,text,jsonb,boolean)'),
    ('public.post_stock_transfer_leg(uuid,text,text)'),
    ('public.stock_office_reaches(uuid)'),
    ('public.stock_caller_reaches(uuid)'),
    ('public.stock_cost_rule(uuid)'),
    ('public.user_profiles_fence_guard()')
  ) as s(sig)
  join pg_proc p on p.oid = to_regprocedure(s.sig);

do $backup_check$
begin
  if (select count(*) from public.stock_native_backup) <> 7 then
    raise exception 'The backup of the seven stock bodies is not complete. Nothing was changed. Send this line to Claude.';
  end if;
end
$backup_check$;

-- ============================================================================
-- STEP 0. ROW LOCKS AND THE SNAPSHOT (same transaction)
-- ============================================================================
-- The snapshot part 5 compares against: per venue of every company that holds stock (a company with
-- any inventory_items or suppliers row at any of its venues), 26 row counts and 7 sums. Null sums
-- are stored as 0. Dropped at commit.
create temp table _stock_native_snap (
  location_id  uuid not null,
  metric       text not null,
  value        numeric,
  primary key (location_id, metric)
) on commit drop;

-- First the row lock on every stock item of those companies, in id order. The drainer and every
-- stock function take this same lock before they post (_post_stock_movement), so no sale can post
-- there until this file commits: the drainer waits 2 s, backs off and tries again later, so nothing
-- is lost. Then the snapshot, taken under the locks.
do $snap$
declare
  v_orgs uuid[];
begin
  select coalesce(array_agg(distinct l.org_id), '{}'::uuid[]) into v_orgs
    from public.locations l
   where l.org_id is not null
     and (exists (select 1 from public.inventory_items i where i.location_id = l.id)
          or exists (select 1 from public.suppliers s where s.location_id = l.id));

  perform 1
     from public.inventory_items i
    where i.location_id in (select l.id from public.locations l where l.org_id = any (v_orgs))
    order by i.id
      for no key update;

  insert into _stock_native_snap (location_id, metric, value)
  select l.id, m.metric, coalesce(m.value, 0)
    from public.locations l
   cross join lateral (values
     ('n:inventory_items',            (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('n:suppliers',                  (select count(*) from public.suppliers x where x.location_id = l.id)::numeric),
     ('n:supplier_products',          (select count(*) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('n:item_packaging_formats',     (select count(*) from public.item_packaging_formats x where x.location_id = l.id)::numeric),
     ('n:inventory_item_conversions', (select count(*) from public.inventory_item_conversions x where x.location_id = l.id)::numeric),
     ('n:recipes',                    (select count(*) from public.recipes x where x.location_id = l.id)::numeric),
     ('n:recipe_lines',               (select count(*) from public.recipe_lines x where x.location_id = l.id)::numeric),
     ('n:menu_item_recipes',          (select count(*) from public.menu_item_recipes x where x.location_id = l.id)::numeric),
     ('n:par_levels',                 (select count(*) from public.par_levels x where x.location_id = l.id)::numeric),
     ('n:storage_areas',              (select count(*) from public.storage_areas x where x.location_id = l.id)::numeric),
     ('n:inventory_item_areas',       (select count(*) from public.inventory_item_areas x where x.location_id = l.id)::numeric),
     ('n:inventory_item_area_stock',  (select count(*) from public.inventory_item_area_stock x where x.location_id = l.id)::numeric),
     ('n:stock_movements',            (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
     ('n:purchase_orders',            (select count(*) from public.purchase_orders x where x.location_id = l.id)::numeric),
     ('n:po_lines',                   (select count(*) from public.po_lines x where x.location_id = l.id)::numeric),
     ('n:supplier_invoices',          (select count(*) from public.supplier_invoices x where x.location_id = l.id)::numeric),
     ('n:supplier_invoice_lines',     (select count(*) from public.supplier_invoice_lines x where x.location_id = l.id)::numeric),
     ('n:waste_events',               (select count(*) from public.waste_events x where x.location_id = l.id)::numeric),
     ('n:item_cost_history',          (select count(*) from public.item_cost_history x where x.location_id = l.id)::numeric),
     ('n:stock_counts',               (select count(*) from public.stock_counts x where x.location_id = l.id)::numeric),
     ('n:stock_count_lines',          (select count(*) from public.stock_count_lines x where x.location_id = l.id)::numeric),
     ('n:stock_count_areas',          (select count(*) from public.stock_count_areas x where x.location_id = l.id)::numeric),
     ('n:production_batches',         (select count(*) from public.production_batches x where x.location_id = l.id)::numeric),
     ('n:prep_schedule',              (select count(*) from public.prep_schedule x where x.location_id = l.id)::numeric),
     ('n:stock_transfers',            (select count(*) from public.stock_transfers x where x.location_id = l.id)::numeric),
     ('n:stock_transfer_lines',       (select count(*) from public.stock_transfer_lines x where x.location_id = l.id)::numeric),
     ('s:on_hand',                    (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:current_cost',               (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:books',                      (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:mv_qty',                     (select sum(x.qty_base) from public.stock_movements x where x.location_id = l.id)),
     ('s:mv_value',                   (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
     ('s:area_on_hand',               (select sum(x.on_hand) from public.inventory_item_area_stock x where x.location_id = l.id)),
     ('s:recipe_base_qty',            (select sum(public.stock_qty_to_base(x.qty, x.unit, x.component_item_id))
                                         from public.recipe_lines x where x.location_id = l.id))
   ) as m(metric, value)
   where l.org_id = any (v_orgs);
end
$snap$;

-- ============================================================================
-- STEP 1. STOCK CONTROL (one setting per login: null or 'sites', 'sites_full', 'all')
-- ============================================================================
-- Null means sites. Owners of the company and ServOS staff are always 'all' whatever is stored
-- (stock_level). Drop 0 stores and guards the setting; the levels switch on in Drop 1. Signed in
-- logins have no UPDATE right on this column (user_profiles has column grants for bo_access,
-- full_name, location_id and org_id only), and the guard below also stops an insert that carries it.
do $stock_control_col$
begin
  if not exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = 'user_profiles' and c.column_name = 'stock_control') then
    alter table public.user_profiles add column stock_control text
      constraint user_profiles_stock_control_known check (stock_control is null or stock_control in ('sites', 'sites_full', 'all'));
    comment on column public.user_profiles.stock_control is 'Stock control for this login, in the company of its own profile only (multi site stock, 20261021a): null or sites = their sites, sites_full = their sites with price and supplier here, all = the company list at every site. Owners of the company and ServOS staff are always all. Set only through set_stock_control.';
  end if;
end
$stock_control_col$;

-- INVOKER on purpose (runs as the caller). The API role is read from the request claims here, the
-- same read as _fence_api_role(), because that function is open to postgres and service_role only
-- and a signed in caller could not run it. The SQL editor, pg_cron and the service role pass.
create or replace function public.user_profiles_stock_control_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_api_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if v_api_role not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.stock_control is null then
      return new;
    end if;
  elsif new.stock_control is not distinct from old.stock_control then
    return new;
  end if;
  -- The pass set by set_stock_control for this transaction only.
  if coalesce(current_setting('servos.stock_control_write', true), '') = txid_current()::text then
    return new;
  end if;
  if public.is_super_admin() then
    return new;
  end if;
  raise exception 'Stock control is set by the owner, in Back Office, Team.' using errcode = '42501';
end
$fn$;
comment on function public.user_profiles_stock_control_guard() is 'Refuses a Stock control value on a new profile, and any change of it, from an API session unless set_stock_control set its pass in this transaction or the caller is ServOS staff (multi site stock, 20261021a).';

create trigger user_profiles_stock_control_guard before insert or update on public.user_profiles
  for each row execute function public.user_profiles_stock_control_guard();

-- Pattern of the live set_bo_sections. The owner of the target's company (role owner, same profile
-- company) or ServOS staff; never your own login; never an owner or ServOS staff as the target.
-- Also needs the Back Office second step, as every stock save does.
create or replace function public.set_stock_control(p_user uuid, p_level text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_super    boolean;
  v_me_role  text;
  v_me_org   uuid;
  v_role     text;
  v_org      uuid;
  v_old      text;
  v_level    text;
  v_store    text;
  v_who      text;
  v_rows     integer;
begin
  -- Somebody real, signed in, with the second step. A device or a visitor (anonymous) never is.
  if v_uid is null or public.is_anon_session() or not public.msm__second_step_ok() then
    raise exception 'Sign in to Back Office to change stock.' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'Pick a login first.' using errcode = '22023';
  end if;
  v_level := lower(btrim(coalesce(p_level, 'sites')));
  if v_level not in ('sites', 'sites_full', 'all') then
    raise exception 'Stock control is one of sites, sites_full or all.' using errcode = '22023';
  end if;
  -- Nobody changes their own, ServOS staff included.
  if p_user = v_uid then
    raise exception 'Not allowed: you cannot change Stock control for your own login.' using errcode = '42501';
  end if;

  v_super := public.is_super_admin();
  select p.role, p.org_id into v_me_role, v_me_org from public.user_profiles p where p.id = v_uid;
  if not v_super and (v_me_role is distinct from 'owner' or v_me_org is null) then
    raise exception 'Not allowed: only the owner can change Stock control.' using errcode = '42501';
  end if;

  -- The login being changed, held so two people saving at once cannot cross. One answer for "no
  -- such login" and "not your company", so nobody can probe for ids. A login with no company has
  -- no Stock control (it applies only in the company of its own profile).
  select p.role, p.org_id, p.stock_control into v_role, v_org, v_old
    from public.user_profiles p where p.id = p_user for update;
  if not found or v_org is null or (not v_super and v_org is distinct from v_me_org) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if lower(coalesce(v_role, '')) in ('owner', 'super_admin') then
    raise exception 'Not allowed: an owner always has All sites.' using errcode = '42501';
  end if;

  v_store := case when v_level = 'sites' then null else v_level end;

  -- The pass for the guard trigger, for this one statement, then shut again. If the update fails
  -- the whole request is undone, the pass with it.
  perform set_config('servos.stock_control_write', txid_current()::text, true);
  update public.user_profiles set stock_control = v_store where id = p_user;
  get diagnostics v_rows = row_count;
  perform set_config('servos.stock_control_write', '', true);
  if v_rows <> 1 then
    raise exception 'Not saved. Nothing was changed.' using errcode = '42501';
  end if;

  if coalesce(v_old, 'sites') <> v_level then
    select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), '')) into v_who
      from public.user_profiles p where p.id = v_uid;
    insert into public.stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
    values (v_org, null, 'login', p_user, 'stock_control', to_jsonb(coalesce(v_old, 'sites')), to_jsonb(v_level), v_uid, v_who, 'save');
  end if;

  return jsonb_build_object('ok', true, 'user_id', p_user, 'level', v_level);
end
$fn$;
comment on function public.set_stock_control(uuid, text) is 'Sets Stock control (sites, sites_full, all) for a login of your own company. Owner of that company or ServOS staff only; never your own login; never an owner. Logged in stock_change_log (entity login). Multi site stock, 20261021a.';

-- The level of a login in ONE company. There is no one argument form, so no caller can forget the
-- company: an owner of company A linked into company B as a manager is sites in B.
create or replace function public.stock_level(p_uid uuid, p_org uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
           when p_uid is null then 'sites'
           when p_uid = auth.uid() and public.is_anon_session() then 'sites'
           else coalesce((select case
                                   when p.role = 'super_admin' then 'all'
                                   when p.role = 'owner' and p.org_id = p_org then 'all'
                                   when p.org_id = p_org then coalesce(p.stock_control, 'sites')
                                   else 'sites'
                                 end
                            from public.user_profiles p
                           where p.id = p_uid), 'sites')
         end;
$fn$;
comment on function public.stock_level(uuid, uuid) is 'Stock control level of a login in one company: all for ServOS staff and for an owner of that company; the stored level (null = sites) when the login''s profile is in that company; sites otherwise, and always sites for an anonymous session or a login with no profile. Multi site stock, 20261021a.';

-- Reach for STOCK tables only. user_accessible_locations() itself never changes, so sales, staff,
-- customers and bookings keep exactly today's reach. Empty for anonymous sessions.
create or replace function public.stock_reach_locations()
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select u.loc
    from public.user_accessible_locations() as u(loc)
  union
  select l.id::text
    from public.locations l
    join public.user_profiles p on p.id = auth.uid()
   where not public.is_anon_session()
     and p.stock_control = 'all'
     and p.org_id is not null
     and l.org_id = p.org_id;
$fn$;
comment on function public.stock_reach_locations() is 'Venues a login reaches for stock: user_accessible_locations() plus, for a login with Stock control all, every venue of its own profile''s company. Used by the stock read rules and stock reach checks only. Multi site stock, 20261021a.';

create or replace function public.stock_reach_orgs()
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select distinct l.org_id::text
    from public.locations l
   where l.org_id is not null
     and l.id::text in (select public.stock_reach_locations());
$fn$;
comment on function public.stock_reach_orgs() is 'Companies of the venues in stock_reach_locations(). The read rule of every company stock table. Multi site stock, 20261021a.';

-- ############################################################################
-- # OPTIONAL BLOCK START: profile guard org_id fix (open question 22)        #
-- # Replaces user_profiles_fence_guard() with one arm changed.               #
-- # A security fix outside stock, kept apart so Peter can leave it out: to   #
-- # leave it out, delete every line from this START line down to the END     #
-- # line below, both included. Nothing else in 0a depends on it.             #
-- ############################################################################
-- Today a login whose profile has no company may set its own company to ANY company it is linked
-- into (the user_accessible_orgs() arm of the own row rule), so a role owner with no company who is
-- linked as a manager to a venue could make itself owner of that venue's company. After this, a
-- login may set its own company only to a company it created (_org_created_by_me, the one path the
-- app uses); everything else goes through ServOS staff or a definer function. The live body is
-- rebuilt from pg_get_functiondef text (md5 checked at step 0, saved in stock_native_backup for the
-- rollback); the ONLY change is that arm. Same words, same search_path, live ACL kept.
CREATE OR REPLACE FUNCTION public.user_profiles_fence_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
begin
  if public._fence_api_role() not in ('authenticated', 'anon') or public._fence_bypass() then
    return new;
  end if;
  if public.is_super_admin() then
    return new;
  end if;
  if new.id is distinct from old.id then
    raise exception 'A profile id cannot change' using errcode = '42501';
  end if;
  if v_uid is null or old.id <> v_uid then
    -- A manager switching a teammate's Back Office access: that column only.
    if new.org_id is distinct from old.org_id or new.location_id is distinct from old.location_id
       or new.full_name is distinct from old.full_name or new.email is distinct from old.email
       or new.role is distinct from old.role then
      raise exception 'You can only switch Back Office access for a team member' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Own row.
  if new.bo_access is distinct from old.bo_access then
    raise exception 'Back Office access is switched by the venue owner or a manager' using errcode = '42501';
  end if;
  if new.email is distinct from old.email then
    raise exception 'Your email is changed through your login, not here' using errcode = '42501';
  end if;
  if new.org_id is distinct from old.org_id then
    if old.org_id is not null or new.org_id is null
       or not public._org_created_by_me(new.org_id) then
      raise exception 'Only the platform can change which company a login belongs to' using errcode = '42501';
    end if;
  end if;
  if new.location_id is distinct from old.location_id and new.location_id is not null then
    -- CHANGED 21 Sep 2026: one rule decides this, the same one every policy uses,
    -- so an owner's own venues are never refused here while the policies allow them.
    if new.location_id::text not in (select public.user_accessible_locations())
       and not exists (select 1 from public.locations l
                        where l.id = new.location_id and l.created_by = v_uid) then
      raise exception 'You can only switch to a venue you are linked to' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;
-- ############################################################################
-- # OPTIONAL BLOCK END: profile guard org_id fix (open question 22)          #

-- ============================================================================
-- STEP 2. COMPANY SETTINGS, SITE SETTINGS, SITE GROUPS
-- ============================================================================
create table public.stock_co_settings (
  org_id                      uuid primary key references public.organisations(id) on delete cascade,
  multi_since                 timestamptz,
  cost_rule                   text not null default 'price_list',
  week_start                  smallint not null default 1,
  waste_reasons               jsonb,
  usual_areas                 jsonb,
  invoice_tolerance_pct       numeric(6,3),
  invoice_tolerance_amount    numeric(12,2),
  send_unapproved_at_cutoff   boolean not null default true,
  waste_pin_over_value        numeric(12,2),
  count_second_approval_over  numeric(12,2),
  row_version                 integer not null default 1,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid,
  constraint stock_co_settings_cost_rule_ok check (cost_rule in ('price_list', 'deliveries')),
  constraint stock_co_settings_week_start_ok check (week_start between 0 and 6)
);
comment on table public.stock_co_settings is 'Stock settings of a company (multi site stock, 20261021a). multi_since: set the first time the company has 2 or more open sites, never cleared; null means a one site company that sees exactly today''s screens. cost_rule: price_list (default) or deliveries, overridden per site in stock_co_site_settings. Written only by definer functions.';
alter table public.stock_co_settings enable row level security;
revoke all on table public.stock_co_settings from public, anon, authenticated, service_role;
grant select on table public.stock_co_settings to authenticated, service_role;
create policy stock_co_settings_read on public.stock_co_settings as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
do $fence_settings$
begin
  if to_regprocedure('public.second_step_ok()') is not null then
    create policy second_step_fence on public.stock_co_settings as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
  end if;
end
$fence_settings$;

-- Definer only: no write grant and no write policy, so a site manager can never set the owner only
-- cost override or the company only site kind with one direct update (any linked login can write
-- stock_site_settings today). stock_site_settings is left as it is and is no longer read.
create table public.stock_co_site_settings (
  location_id                 uuid primary key references public.locations(id) on delete cascade,
  org_id                      uuid not null,
  cost_rule_override          text,
  site_kind                   text,
  waste_pin_over_value        numeric(12,2),
  count_second_approval_over  numeric(12,2),
  row_version                 integer not null default 1,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid,
  constraint stock_co_site_settings_cost_rule_ok check (cost_rule_override in ('price_list', 'deliveries')),
  constraint stock_co_site_settings_site_kind_ok check (site_kind in ('restaurant', 'central_kitchen', 'store_room'))
);
comment on table public.stock_co_site_settings is 'Stock settings of one site (multi site stock, 20261021a): the cost rule override (null follows the company rule), the site kind, and the site''s own money limits. Replaces stock_site_settings as the home of the cost override. Written only by definer functions.';
alter table public.stock_co_site_settings enable row level security;
revoke all on table public.stock_co_site_settings from public, anon, authenticated, service_role;
grant select on table public.stock_co_site_settings to authenticated, service_role;
create policy stock_co_site_settings_read on public.stock_co_site_settings as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
do $fence_site_settings$
begin
  if to_regprocedure('public.second_step_ok()') is not null then
    create policy second_step_fence on public.stock_co_site_settings as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
  end if;
end
$fence_site_settings$;

-- The one group list of a company (stock, reports, later the menu). The Multi site menu's own
-- msm_site_groups is left alone in this build.
create table public.stock_co_site_groups (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  name          text not null,
  location_ids  uuid[] not null default '{}',
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.stock_co_site_groups is 'Groups of sites of one company (region, brand) for the site picker and reports (multi site stock, 20261021a). Written only by definer functions.';
create unique index stock_co_site_groups_name_uniq on public.stock_co_site_groups (org_id, lower(name));
alter table public.stock_co_site_groups enable row level security;
revoke all on table public.stock_co_site_groups from public, anon, authenticated, service_role;
grant select on table public.stock_co_site_groups to authenticated, service_role;
create policy stock_co_site_groups_read on public.stock_co_site_groups as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
do $fence_site_groups$
begin
  if to_regprocedure('public.second_step_ok()') is not null then
    create policy second_step_fence on public.stock_co_site_groups as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
  end if;
end
$fence_site_groups$;

-- Settings backfill. One row per company that has any venue. A site with no stock_site_settings row
-- uses price_list today, so it counts as price_list here. The company rule is the rule most of its
-- sites use (a tie goes to price_list), and every site whose rule differs gets it as its own
-- override, so no site's cost rule changes. multi_since is set now for a company with 2 or more
-- open sites. (Live 20 Oct: stock_site_settings has 0 rows, so price_list everywhere and no
-- override; 2 companies are multi site.)
insert into public.stock_co_settings (org_id, cost_rule, multi_since)
select r.org_id,
       r.rule,
       case when (select count(*) from public.locations l2
                   where l2.org_id = r.org_id and coalesce(l2.status, 'active') = 'active') >= 2
            then now() end
  from (select distinct on (c.org_id) c.org_id, c.rule
          from (select l.org_id, coalesce(ss.cost_rule, 'price_list') as rule, count(*) as n
                  from public.locations l
                  left join public.stock_site_settings ss on ss.location_id = l.id
                 where l.org_id is not null
                 group by l.org_id, coalesce(ss.cost_rule, 'price_list')) c
         order by c.org_id, c.n desc, (c.rule = 'price_list') desc, c.rule) r;

insert into public.stock_co_site_settings (location_id, org_id, cost_rule_override)
select l.id, l.org_id, coalesce(ss.cost_rule, 'price_list')
  from public.locations l
  join public.stock_co_settings s on s.org_id = l.org_id
  left join public.stock_site_settings ss on ss.location_id = l.id
 where coalesce(ss.cost_rule, 'price_list') <> s.cost_rule;

-- From now on a company becomes multi site the moment it has 2 open sites, and stays so.
create or replace function public.stock_co__multi_mark()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.org_id is null or coalesce(new.status, 'active') <> 'active' then
    return null;
  end if;
  -- Never fails the venue save: anything that goes wrong here is a warning only.
  begin
    if (select count(*) from public.locations l
         where l.org_id = new.org_id and coalesce(l.status, 'active') = 'active') >= 2 then
      insert into public.stock_co_settings as s (org_id, multi_since)
      values (new.org_id, now())
      on conflict (org_id) do update set multi_since = now(), updated_at = now()
       where s.multi_since is null;
    end if;
  exception when others then
    raise warning 'stock_co__multi_mark: venue % of company %: % (the venue was saved; multi_since was not set)', new.id, new.org_id, sqlerrm;
  end;
  return null;
end
$fn$;
comment on function public.stock_co__multi_mark() is 'AFTER INSERT OR UPDATE OF status, org_id ON locations: sets stock_co_settings.multi_since when the venue''s company now has 2 or more open sites. Never clears it, never fails the venue save. Multi site stock, 20261021a.';

create trigger locations_stock_co_multi after insert or update of status, org_id on public.locations
  for each row execute function public.stock_co__multi_mark();

-- ============================================================================
-- STEP 3. NEW COLUMNS ON THE SITE TABLES (constant defaults: no table rewrite)
-- ============================================================================
-- Each only when missing: the 0a rollback keeps archived_at (when any row has it set) and the
-- stock_counts PIN holder columns, so a second 0a after a rollback adds only what is not there.
do $cols$
declare
  r record;
begin
  for r in
    select * from (values
      ('inventory_items', 'company_ref', 'uuid',
       'The company stock item (stock_co_items.id) this site row is. Stamped by the company writer, the backfill and the orphan trigger. No foreign key: the writer and the nightly check keep it right. Multi site stock, 20261021a.'),
      ('inventory_items', 'row_version', 'integer not null default 1',
       'Version stamp for "someone saved first". Bumped only by the stock save functions and the company writer, never by sales. 20261021a.'),
      ('suppliers', 'company_ref', 'uuid',
       'The company supplier (stock_co_suppliers.id) this site row is. 20261021a.'),
      ('suppliers', 'row_version', 'integer not null default 1',
       'Version stamp, bumped only by the stock save functions and the company writer. 20261021a.'),
      ('suppliers', 'cc_emails', 'text[]',
       'More order email addresses for this supplier at this site, copied on each order. 20261021a.'),
      ('suppliers', 'delivery_fee', 'numeric(12,2) constraint suppliers_delivery_fee_ok check (delivery_fee is null or delivery_fee >= 0)',
       'Delivery charge this supplier adds at this site. 20261021a.'),
      ('suppliers', 'approval_limit', 'numeric(12,2) constraint suppliers_approval_limit_ok check (approval_limit is null or approval_limit >= 0)',
       'Order value at this site above which an order to this supplier needs a second approval. Set by the company, never by the manager who raises the order. 20261021a.'),
      ('supplier_products', 'company_ref', 'uuid',
       'The company supplier item (stock_co_supplier_items.id) this site row is. 20261021a.'),
      ('supplier_products', 'row_version', 'integer not null default 1',
       'Version stamp, bumped only by the stock save functions and the company writer. 20261021a.'),
      ('supplier_products', 'archived_at', 'timestamptz',
       'Supplier pack switched off here. Archived, never deleted: orders and cost history keep the pack. Lists hide it. 20261021a.'),
      ('item_packaging_formats', 'company_ref', 'uuid',
       'The company pack (stock_co_packs.id) this site row is. 20261021a.'),
      ('item_packaging_formats', 'row_version', 'integer not null default 1',
       'Version stamp, bumped only by the stock save functions and the company writer. 20261021a.'),
      ('item_packaging_formats', 'archived_at', 'timestamptz',
       'Pack switched off here. Archived, never deleted. Lists hide it. 20261021a.'),
      ('inventory_item_conversions', 'company_ref', 'uuid',
       'The company unit bridge (stock_co_bridges.id) this site row is. 20261021a.'),
      ('inventory_item_conversions', 'row_version', 'integer not null default 1',
       'Version stamp, bumped only by the stock save functions and the company writer. 20261021a.'),
      ('inventory_item_conversions', 'archived_at', 'timestamptz',
       'Unit bridge switched off here. Archived, never deleted. 20261021a.'),
      ('recipes', 'company_ref', 'uuid',
       'The company recipe (stock_co_recipes.id) this site row is. 20261021a.'),
      ('recipes', 'row_version', 'integer not null default 1',
       'Version stamp, bumped only by the stock save functions and the company writer. 20261021a.'),
      ('stock_counts', 'approved_by_staff_id', 'uuid',
       'The staff member (staff_members.id) whose manager PIN approved this count. No foreign key. 20261021a.'),
      ('stock_counts', 'approved_by_staff_name', 'text',
       'The name of the staff member whose manager PIN approved this count. 20261021a.')
    ) as t(tbl, col, typ, note)
  loop
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col) then
      execute format('alter table public.%I add column %I %s', r.tbl, r.col, r.typ);
      execute format('comment on column public.%I.%I is %L', r.tbl, r.col, r.note);
    end if;
  end loop;
end
$cols$;

-- Site rows by company record, per site and (items) company wide.
create index if not exists inventory_items_company_ref_idx on public.inventory_items (location_id, company_ref) where company_ref is not null;
create index if not exists suppliers_company_ref_idx on public.suppliers (location_id, company_ref) where company_ref is not null;
create index if not exists supplier_products_company_ref_idx on public.supplier_products (location_id, company_ref) where company_ref is not null;
create index if not exists item_packaging_formats_company_ref_idx on public.item_packaging_formats (location_id, company_ref) where company_ref is not null;
create index if not exists inventory_item_conversions_company_ref_idx on public.inventory_item_conversions (location_id, company_ref) where company_ref is not null;
create index if not exists recipes_company_ref_idx on public.recipes (location_id, company_ref) where company_ref is not null;
create index if not exists inventory_items_company_ref_any_idx on public.inventory_items (company_ref) where company_ref is not null;

-- ============================================================================
-- STEP 4. FOREIGN KEY INDEXES (the Phase 1 rollback dropped them)
-- ============================================================================
-- On the columns that point at a site's stock rows, so a delete or archive check never reads a
-- whole table. Small tables today (the ledger has about 2,300 rows), so each is made in a moment.
-- recipe_lines needs none: live already has recipe_lines_loc_pack_unit_idx.
create index if not exists stock_movements_item_fk_idx on public.stock_movements (inventory_item_id);
create index if not exists stock_count_lines_item_fk_idx on public.stock_count_lines (inventory_item_id);
create index if not exists par_levels_item_fk_idx on public.par_levels (inventory_item_id);
create index if not exists po_lines_item_fk_idx on public.po_lines (inventory_item_id) where inventory_item_id is not null;
create index if not exists po_lines_sp_fk_idx on public.po_lines (supplier_product_id) where supplier_product_id is not null;
create index if not exists stock_transfer_lines_item_fk_idx on public.stock_transfer_lines (inventory_item_id);
create index if not exists stock_transfer_lines_to_item_fk_idx on public.stock_transfer_lines (to_inventory_item_id) where to_inventory_item_id is not null;
create index if not exists waste_events_item_fk_idx on public.waste_events (inventory_item_id) where inventory_item_id is not null;
create index if not exists supplier_invoice_lines_item_fk_idx on public.supplier_invoice_lines (matched_item_id) where matched_item_id is not null;
create index if not exists supplier_invoice_lines_sp_fk_idx on public.supplier_invoice_lines (supplier_product_id) where supplier_product_id is not null;
create index if not exists item_cost_history_sp_fk_idx on public.item_cost_history (supplier_product_id) where supplier_product_id is not null;
create index if not exists item_pack_fmt_parent_idx on public.item_packaging_formats (parent_format_id) where parent_format_id is not null;
create index if not exists purchase_orders_supplier_fk_idx on public.purchase_orders (supplier_id) where supplier_id is not null;
create index if not exists supplier_invoices_supplier_fk_idx on public.supplier_invoices (supplier_id) where supplier_id is not null;
create index if not exists deliveries_supplier_fk_idx on public.deliveries (supplier_id) where supplier_id is not null;
-- == 0a part 2: company tables, guards, stock reach, writer pass and save queue (steps 5 to 10) ==
--
-- Step 5. The company stock tables. A company row (item, pack, unit bridge, supplier, supplier
--   pack, recipe) is joined to each site's own row by a link table; the site row keeps its own id
--   for ever, so counts, orders, transfers, sales and reports read the sites exactly as today.
--   Plus the change log and the save queue.
-- Step 6. Guards. A company row and its links stay in one company. A company item's base unit
--   cannot change while a site holds stock, counts, pars or orders in the old unit.
-- Step 7. Row level security. Company rows are read by company, site links and site values by
--   site, the log and the queue by site where they carry one. The second sign in step on every
--   new table. No write rule on any of them: only definer functions write.
-- Step 8. Stock reach. stock_office_reaches, stock_caller_reaches and the 51 + 14 stock rules
--   also admit a Stock control All sites login of the venue's company. Nobody holds that level
--   yet (Drop 0 changes nobody's rights), so every login reaches exactly what it did before.
-- Step 9. The writer pass the 0b lock triggers ask (stock_co__writer_ok).
-- Step 9b. company_ref on the six site tables is written only by the stock writers (review fix).
-- Step 10. The change log and save queue helpers and the runner (pg_cron, every minute).
--
-- Function grants are made in part 5; this part grants only its own tables.

-- ============================================================================
-- Step 5. Company tables
-- ============================================================================

create table public.stock_co_items (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organisations(id) on delete cascade,
  local_location_id      uuid references public.locations(id),
  name                   text not null check (btrim(name) <> ''),
  category               text,
  accounting_group       text,
  type                   text check (type in ('food', 'drink', 'other')),
  base_unit              text not null references public.stock_units(code),
  sku                    text,
  barcode                text,
  shelf_life_days        integer check (shelf_life_days is null or shelf_life_days >= 0),
  purchase_vat_rate      numeric(8,6) check (purchase_vat_rate is null or (purchase_vat_rate >= 0 and purchase_vat_rate < 1)),
  allergens              jsonb not null default '[]'::jsonb,
  returns_to_shelf       boolean not null default false,
  exclude_from_gp        boolean not null default false,
  key_item               boolean not null default false,
  paused_from            date,
  paused_until           date,
  main_supplier_item_id  uuid,
  notes                  text,
  archived_at            timestamptz,
  row_version            integer not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  updated_by             uuid
);
create index stock_co_items_org_name on public.stock_co_items (org_id, lower(name), id);
comment on table public.stock_co_items is 'Company stock items (20261021a, multi site stock Drop 0). local_location_id set means a record of that one site only. Each site keeps its own inventory_items row, joined by stock_co_item_sites. Written only by definer functions.';

create table public.stock_co_item_sites (
  item_id           uuid not null references public.stock_co_items(id) on delete cascade,
  org_id            uuid not null references public.organisations(id) on delete cascade,
  location_id       uuid not null references public.locations(id),
  site_item_id      uuid not null unique references public.inventory_items(id) on delete cascade,
  on_here           boolean not null default true,
  paused            boolean not null default false,
  supply_mode       text not null default 'bought' check (supply_mode in ('bought', 'batches', 'to_order')),
  counted_here      boolean not null default true,
  stop_ordering_at  timestamptz,
  par_by_weekday    jsonb,
  cover_days        numeric,
  why_on            text,
  row_version       integer not null default 1,
  updated_at        timestamptz not null default now(),
  primary key (item_id, location_id)
);
create index stock_co_item_sites_loc on public.stock_co_item_sites (location_id, item_id);
comment on table public.stock_co_item_sites is 'A company stock item at one site (20261021a): the site''s own inventory_items row and that site''s own values (on here, supply mode, counted here, stop ordering).';

create table public.stock_co_packs (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organisations(id) on delete cascade,
  item_id              uuid not null references public.stock_co_items(id) on delete cascade,
  name                 text not null check (btrim(name) <> ''),
  qty_in_base          numeric not null check (qty_in_base > 0),
  parent_pack_id       uuid references public.stock_co_packs(id) on delete set null,
  is_count_default     boolean not null default false,
  is_purchase_default  boolean not null default false,
  archived_at          timestamptz,
  row_version          integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index stock_co_packs_item on public.stock_co_packs (org_id, item_id);
comment on table public.stock_co_packs is 'Company packs of a stock item (20261021a). Each site keeps its own item_packaging_formats row, joined by stock_co_pack_sites.';

create table public.stock_co_pack_sites (
  pack_id       uuid not null references public.stock_co_packs(id) on delete cascade,
  org_id        uuid not null references public.organisations(id) on delete cascade,
  location_id   uuid not null references public.locations(id),
  site_pack_id  uuid not null unique references public.item_packaging_formats(id) on delete cascade,
  updated_at    timestamptz not null default now(),
  primary key (pack_id, location_id)
);
create index stock_co_pack_sites_loc on public.stock_co_pack_sites (location_id, pack_id);

create table public.stock_co_bridges (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  item_id      uuid not null references public.stock_co_items(id) on delete cascade,
  from_qty     numeric not null check (from_qty > 0),
  from_unit    text not null references public.stock_units(code),
  to_qty       numeric not null check (to_qty > 0),
  to_unit      text not null references public.stock_units(code),
  archived_at  timestamptz,
  row_version  integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index stock_co_bridges_item on public.stock_co_bridges (org_id, item_id);
comment on table public.stock_co_bridges is 'Company unit bridges of a stock item, for example 1 each = 800 g (20261021a). Each site keeps its own inventory_item_conversions row, joined by stock_co_bridge_sites.';

create table public.stock_co_bridge_sites (
  bridge_id       uuid not null references public.stock_co_bridges(id) on delete cascade,
  org_id          uuid not null references public.organisations(id) on delete cascade,
  location_id     uuid not null references public.locations(id),
  site_bridge_id  uuid not null unique references public.inventory_item_conversions(id) on delete cascade,
  updated_at      timestamptz not null default now(),
  primary key (bridge_id, location_id)
);
create index stock_co_bridge_sites_loc on public.stock_co_bridge_sites (location_id, bridge_id);

create table public.stock_co_suppliers (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organisations(id) on delete cascade,
  local_location_id      uuid references public.locations(id),
  name                   text not null check (btrim(name) <> ''),
  contact_name           text,
  phone                  text,
  email                  text,
  payment_terms_days     integer check (payment_terms_days is null or payment_terms_days >= 0),
  accepts_price_changes  boolean not null default true,
  min_order_value        numeric(12,2),
  max_order_value        numeric(12,2),
  delivery_fee           numeric(12,2),
  order_method           text not null default 'email' check (order_method in ('email', 'held')),
  internal_location_id   uuid references public.locations(id),
  notes                  text,
  archived_at            timestamptz,
  row_version            integer not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index stock_co_suppliers_org_name on public.stock_co_suppliers (org_id, lower(name), id);
comment on table public.stock_co_suppliers is 'Company suppliers (20261021a). local_location_id set means a supplier of that one site only. Each site keeps its own suppliers row (account number, order email, minimum order stay site values), joined by stock_co_supplier_sites.';

create table public.stock_co_supplier_sites (
  supplier_id       uuid not null references public.stock_co_suppliers(id) on delete cascade,
  org_id            uuid not null references public.organisations(id) on delete cascade,
  location_id       uuid not null references public.locations(id),
  site_supplier_id  uuid not null unique references public.suppliers(id) on delete cascade,
  can_order         boolean not null default true,
  row_version       integer not null default 1,
  updated_at        timestamptz not null default now(),
  primary key (supplier_id, location_id)
);
create index stock_co_supplier_sites_loc on public.stock_co_supplier_sites (location_id, supplier_id);

create table public.stock_co_supplier_items (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organisations(id) on delete cascade,
  item_id                uuid not null references public.stock_co_items(id) on delete cascade,
  supplier_id            uuid not null references public.stock_co_suppliers(id) on delete cascade,
  supplier_product_name  text,
  sku                    text,
  pack_description       text,
  pack_qty               numeric not null default 1 check (pack_qty > 0),
  inner_qty              numeric not null default 1 check (inner_qty > 0),
  inner_unit             text not null references public.stock_units(code),
  pack_price             numeric(12,4) not null check (pack_price >= 0),
  currency               text not null check (currency ~ '^[A-Z]{3}$'),
  purchase_vat_rate      numeric(8,6) check (purchase_vat_rate is null or (purchase_vat_rate >= 0 and purchase_vat_rate < 1)),
  price_includes_tax     boolean not null default false,
  agreed_until           date,
  allowed_diff_pct       numeric(6,3),
  paused                 boolean not null default false,
  ck_price_rule          text,
  ck_markup_pct          numeric(6,3),
  allergens              text[] not null default '{}',
  may_contain            text[] not null default '{}',
  diets                  text[] not null default '{}',
  ingredients_text       text,
  nutrition              jsonb,
  facts_checked_by       uuid,
  facts_checked_at       timestamptz,
  archived_at            timestamptz,
  row_version            integer not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index stock_co_supplier_items_item on public.stock_co_supplier_items (org_id, item_id);
create index stock_co_supplier_items_supplier on public.stock_co_supplier_items (org_id, supplier_id);
comment on table public.stock_co_supplier_items is 'Company supplier packs and prices (20261021a). Each site keeps its own supplier_products row, joined by stock_co_supplier_item_sites, where a site may have its own price.';

create table public.stock_co_supplier_item_sites (
  supplier_item_id          uuid not null references public.stock_co_supplier_items(id) on delete cascade,
  org_id                    uuid not null references public.organisations(id) on delete cascade,
  location_id               uuid not null references public.locations(id),
  site_supplier_product_id  uuid not null unique references public.supplier_products(id) on delete cascade,
  price_here                numeric(12,4) check (price_here is null or price_here >= 0),
  off_here                  boolean not null default false,
  paused                    boolean not null default false,
  row_version               integer not null default 1,
  updated_at                timestamptz not null default now(),
  primary key (supplier_item_id, location_id)
);
create index stock_co_supplier_item_sites_loc on public.stock_co_supplier_item_sites (location_id, supplier_item_id);
comment on column public.stock_co_supplier_item_sites.price_here is 'This site''s own pack price. Null follows the company price.';

-- The company item's main supplier pack, now that supplier packs exist.
alter table public.stock_co_items
  add constraint stock_co_items_main_supplier_item_fk foreign key (main_supplier_item_id)
  references public.stock_co_supplier_items(id) on delete set null;

create table public.stock_co_recipes (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organisations(id) on delete cascade,
  local_location_id  uuid references public.locations(id),
  kind               text not null check (kind in ('dish', 'batch', 'prep')),
  food_kind          text check (food_kind in ('food', 'drink', 'meal_deal')),
  meal_food_pct      numeric(5,2),
  name               text not null check (btrim(name) <> ''),
  yield_qty          numeric,
  yield_unit         text,
  output_item_id     uuid references public.stock_co_items(id),
  portion_weight_g   numeric,
  cooking_yield_pct  numeric,
  wastage_pct        numeric,
  method             text,
  photo              text,
  gp_target_pct      numeric,
  shelf_life_days    integer,
  restricted         boolean not null default false,
  msm_product_id     uuid,
  archived_at        timestamptz,
  row_version        integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index stock_co_recipes_org_name on public.stock_co_recipes (org_id, lower(name), id);
comment on table public.stock_co_recipes is 'Company recipes (20261021a): kind dish is the site recipe_type MENU, batch is BATCH, prep is PREP. Each site keeps its own recipes row, joined by stock_co_recipe_sites. restricted stays false until Drop 3.';

create table public.stock_co_recipe_lines (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organisations(id) on delete cascade,
  recipe_id            uuid not null references public.stock_co_recipes(id) on delete cascade,
  component_item_id    uuid references public.stock_co_items(id),
  component_recipe_id  uuid references public.stock_co_recipes(id),
  qty                  numeric not null,
  unit                 text not null,
  pack_id              uuid references public.stock_co_packs(id),
  usable_pct           numeric,
  order_types          jsonb,
  note                 text,
  sort_order           integer not null default 0,
  base_qty             numeric,
  constraint stock_co_recipe_lines_one_component check ((component_item_id is not null) <> (component_recipe_id is not null)),
  constraint stock_co_recipe_lines_pack_unit check ((unit = '@') = (pack_id is not null))
);
create index stock_co_recipe_lines_recipe on public.stock_co_recipe_lines (recipe_id, sort_order);
create index stock_co_recipe_lines_item on public.stock_co_recipe_lines (component_item_id) where component_item_id is not null;
comment on table public.stock_co_recipe_lines is 'Company recipe lines (20261021a). unit is a stock unit code, or @ with pack_id when the line is in a pack (each site''s line then reads @ and that site''s own pack id).';

create table public.stock_co_recipe_sites (
  recipe_id          uuid not null references public.stock_co_recipes(id) on delete cascade,
  org_id             uuid not null references public.organisations(id) on delete cascade,
  location_id        uuid not null references public.locations(id),
  on_here            boolean not null default true,
  site_recipe_id     uuid not null unique references public.recipes(id) on delete cascade,
  site_menu_item_id  text,
  how                text check (how in ('bought', 'batches', 'to_order')),
  row_version        integer not null default 1,
  updated_at         timestamptz not null default now(),
  primary key (recipe_id, location_id)
);
create index stock_co_recipe_sites_loc on public.stock_co_recipe_sites (location_id, recipe_id);

-- Every change a save makes: one row per changed field. Rows of site values (price here, account
-- number, order email, approval limit, minimum order) carry their location_id and are read only by
-- logins that reach that site.
create table public.stock_change_log (
  id           bigint generated always as identity primary key,
  org_id       uuid not null,
  location_id  uuid,
  entity       text not null,
  entity_id    uuid not null,
  field        text,
  before       jsonb,
  after        jsonb,
  who          uuid,
  who_name     text,
  source       text not null default 'save',
  at           timestamptz not null default now()
);
create index stock_change_log_entity on public.stock_change_log (org_id, entity, entity_id, at desc);
create index stock_change_log_loc on public.stock_change_log (location_id, at desc) where location_id is not null;
comment on table public.stock_change_log is 'Stock changes, one row per field (20261021a). Written only by definer functions; read by site for site values, by company otherwise.';

-- Site steps a save could not finish inside its time (a busy site, or more sites than fit in 1.5 s).
-- The runner (stock_save_queue_run, pg_cron every minute) writes them, a few hundred site rows a
-- commit, so a sale never waits long on a stock item.
create table public.stock_save_queue (
  id           bigint generated always as identity primary key,
  org_id       uuid not null,
  location_id  uuid,
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  entity_ids   uuid[],
  status       text not null default 'waiting' check (status in ('waiting', 'running', 'done', 'failed')),
  attempts     integer not null default 0,
  due_at       timestamptz not null default now(),
  last_error   text,
  progress     jsonb not null default '{}'::jsonb,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  done_at      timestamptz
);
create index stock_save_queue_due on public.stock_save_queue (due_at) where status = 'waiting';
create index stock_save_queue_entity on public.stock_save_queue (org_id, status, location_id);
comment on table public.stock_save_queue is 'Site catch up jobs of the stock saves (20261021a). Drop 0 kind site_sync, payload {"item_ids", "supplier_ids", "recipe_ids", "change_log_id", "reason"} with company ids. Written only by definer functions and the runner.';

-- ============================================================================
-- Step 6. Guards on the company tables
-- ============================================================================

-- A company row's parents belong to the same company, and a link's site (or a local record's
-- site) is a site of that company. The company is always locations.org_id, never the org_id of a
-- site row (null on some live rows). A record never moves to another company.
create or replace function public.stock_co__org_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id then
      raise exception 'That stock record cannot move to another company.' using errcode = '22023';
    end if;
  end if;

  if tg_table_name = 'stock_co_items' then
    if tg_op = 'UPDATE' then
      if new.local_location_id is not distinct from old.local_location_id
         and new.main_supplier_item_id is not distinct from old.main_supplier_item_id then
        return new;
      end if;
    end if;
    if new.local_location_id is not null
       and not exists (select 1 from locations l where l.id = new.local_location_id and l.org_id = new.org_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
    if new.main_supplier_item_id is not null
       and not exists (select 1 from stock_co_supplier_items s
                        where s.id = new.main_supplier_item_id and s.org_id = new.org_id and s.item_id = new.id) then
      raise exception 'The main supplier pack must be a supplier pack of this stock item.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_packs' then
    if tg_op = 'UPDATE' then
      if new.item_id = old.item_id and new.parent_pack_id is not distinct from old.parent_pack_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_items i where i.id = new.item_id and i.org_id = new.org_id) then
      raise exception 'That stock item is not in this company.' using errcode = '22023';
    end if;
    if new.parent_pack_id is not null
       and (new.parent_pack_id = new.id
            or not exists (select 1 from stock_co_packs p where p.id = new.parent_pack_id and p.item_id = new.item_id)) then
      raise exception 'A pack can only sit inside a pack of the same item.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_bridges' then
    if tg_op = 'UPDATE' then
      if new.item_id = old.item_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_items i where i.id = new.item_id and i.org_id = new.org_id) then
      raise exception 'That stock item is not in this company.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_suppliers' then
    if tg_op = 'UPDATE' then
      if new.local_location_id is not distinct from old.local_location_id
         and new.internal_location_id is not distinct from old.internal_location_id then
        return new;
      end if;
    end if;
    if (new.local_location_id is not null
        and not exists (select 1 from locations l where l.id = new.local_location_id and l.org_id = new.org_id))
       or (new.internal_location_id is not null
        and not exists (select 1 from locations l where l.id = new.internal_location_id and l.org_id = new.org_id)) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_supplier_items' then
    if tg_op = 'UPDATE' then
      if new.item_id = old.item_id and new.supplier_id = old.supplier_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_items i where i.id = new.item_id and i.org_id = new.org_id) then
      raise exception 'That stock item is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from stock_co_suppliers s where s.id = new.supplier_id and s.org_id = new.org_id) then
      raise exception 'That supplier is not in this company.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_recipes' then
    if tg_op = 'UPDATE' then
      if new.local_location_id is not distinct from old.local_location_id
         and new.output_item_id is not distinct from old.output_item_id then
        return new;
      end if;
    end if;
    if new.local_location_id is not null
       and not exists (select 1 from locations l where l.id = new.local_location_id and l.org_id = new.org_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
    if new.output_item_id is not null
       and not exists (select 1 from stock_co_items i where i.id = new.output_item_id and i.org_id = new.org_id) then
      raise exception 'That stock item is not in this company.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_recipe_lines' then
    if tg_op = 'UPDATE' then
      if new.recipe_id = old.recipe_id
         and new.component_item_id is not distinct from old.component_item_id
         and new.component_recipe_id is not distinct from old.component_recipe_id
         and new.pack_id is not distinct from old.pack_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_recipes r where r.id = new.recipe_id and r.org_id = new.org_id)
       or (new.component_recipe_id is not null
           and not exists (select 1 from stock_co_recipes r where r.id = new.component_recipe_id and r.org_id = new.org_id)) then
      raise exception 'That recipe is not in this company.' using errcode = '22023';
    end if;
    if new.component_item_id is not null
       and not exists (select 1 from stock_co_items i where i.id = new.component_item_id and i.org_id = new.org_id) then
      raise exception 'That stock item is not in this company.' using errcode = '22023';
    end if;
    if new.pack_id is not null
       and not exists (select 1 from stock_co_packs p where p.id = new.pack_id and p.org_id = new.org_id) then
      raise exception 'That pack is not in this company.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_item_sites' then
    if tg_op = 'UPDATE' then
      if new.item_id = old.item_id and new.location_id = old.location_id and new.site_item_id = old.site_item_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_items i where i.id = new.item_id and i.org_id = new.org_id) then
      raise exception 'That stock item is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from locations l where l.id = new.location_id and l.org_id = new.org_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from inventory_items t where t.id = new.site_item_id and t.location_id = new.location_id) then
      raise exception 'That site record is not at this site.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_pack_sites' then
    if tg_op = 'UPDATE' then
      if new.pack_id = old.pack_id and new.location_id = old.location_id and new.site_pack_id = old.site_pack_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_packs p where p.id = new.pack_id and p.org_id = new.org_id) then
      raise exception 'That pack is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from locations l where l.id = new.location_id and l.org_id = new.org_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from item_packaging_formats x where x.id = new.site_pack_id and x.location_id = new.location_id) then
      raise exception 'That site record is not at this site.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_bridge_sites' then
    if tg_op = 'UPDATE' then
      if new.bridge_id = old.bridge_id and new.location_id = old.location_id and new.site_bridge_id = old.site_bridge_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_bridges b where b.id = new.bridge_id and b.org_id = new.org_id) then
      raise exception 'That stock item is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from locations l where l.id = new.location_id and l.org_id = new.org_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from inventory_item_conversions c where c.id = new.site_bridge_id and c.location_id = new.location_id) then
      raise exception 'That site record is not at this site.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_supplier_sites' then
    if tg_op = 'UPDATE' then
      if new.supplier_id = old.supplier_id and new.location_id = old.location_id and new.site_supplier_id = old.site_supplier_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_suppliers s where s.id = new.supplier_id and s.org_id = new.org_id) then
      raise exception 'That supplier is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from locations l where l.id = new.location_id and l.org_id = new.org_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from suppliers s where s.id = new.site_supplier_id and s.location_id = new.location_id) then
      raise exception 'That site record is not at this site.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_supplier_item_sites' then
    if tg_op = 'UPDATE' then
      if new.supplier_item_id = old.supplier_item_id and new.location_id = old.location_id
         and new.site_supplier_product_id = old.site_supplier_product_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_supplier_items s where s.id = new.supplier_item_id and s.org_id = new.org_id) then
      raise exception 'That stock item is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from locations l where l.id = new.location_id and l.org_id = new.org_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from supplier_products sp where sp.id = new.site_supplier_product_id and sp.location_id = new.location_id) then
      raise exception 'That site record is not at this site.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_recipe_sites' then
    if tg_op = 'UPDATE' then
      if new.recipe_id = old.recipe_id and new.location_id = old.location_id and new.site_recipe_id = old.site_recipe_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_recipes r where r.id = new.recipe_id and r.org_id = new.org_id) then
      raise exception 'That recipe is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from locations l where l.id = new.location_id and l.org_id = new.org_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
    if not exists (select 1 from recipes r where r.id = new.site_recipe_id and r.location_id = new.location_id) then
      raise exception 'That site record is not at this site.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_site_settings' then
    if tg_op = 'UPDATE' then
      if new.location_id = old.location_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from locations l where l.id = new.location_id and l.org_id = new.org_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_site_groups' then
    if tg_op = 'UPDATE' then
      if new.location_ids = old.location_ids then
        return new;
      end if;
    end if;
    if exists (select 1 from unnest(new.location_ids) g(location_id)
                where g.location_id is null
                   or not exists (select 1 from locations l where l.id = g.location_id and l.org_id = new.org_id)) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;

  else
    raise exception 'stock_co__org_guard is not set up for table %.', tg_table_name;
  end if;
  return new;
end
$fn$;

create trigger stock_co_org_guard before insert or update on public.stock_co_items
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_item_sites
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_packs
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_pack_sites
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_bridges
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_bridge_sites
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_suppliers
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_supplier_sites
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_supplier_items
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_supplier_item_sites
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_recipes
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_recipe_lines
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_recipe_sites
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_site_settings
  for each row execute function public.stock_co__org_guard();
create trigger stock_co_org_guard before insert or update on public.stock_co_site_groups
  for each row execute function public.stock_co__org_guard();

-- Base unit lock. Quantities at a site carry no unit of their own (on hand, the ledger, count
-- lines of any status, pars, open orders and transfers, the site's own packs are all in the base
-- unit), so once a site row is in use its base unit stays. stock_co__site_item_in_use: one site
-- row. stock_co__unit_in_use: any linked site row of a company item that is not in p_unit already
-- (p_unit null: any). The lock, the writer and the health check share them.
create or replace function public.stock_co__site_item_in_use(p_loc uuid, p_item uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (select 1 from inventory_items t where t.id = p_item and t.location_id = p_loc and coalesce(t.on_hand, 0) <> 0)
      or exists (select 1 from stock_movements m where m.location_id = p_loc and m.inventory_item_id = p_item)
      or exists (select 1 from stock_count_lines l where l.location_id = p_loc and l.inventory_item_id = p_item)
      or exists (select 1 from par_levels pl where pl.location_id = p_loc and pl.inventory_item_id = p_item)
      or exists (select 1 from po_lines l where l.inventory_item_id = p_item)
      or exists (select 1 from stock_transfer_lines l where l.inventory_item_id = p_item or l.to_inventory_item_id = p_item)
      or exists (select 1 from item_packaging_formats x where x.inventory_item_id = p_item and x.location_id = p_loc
                  and x.company_ref is null and x.archived_at is null);
$fn$;

create or replace function public.stock_co__unit_in_use(p_item uuid, p_unit text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (select 1 from stock_co_item_sites s
                   join inventory_items t on t.id = s.site_item_id and t.location_id = s.location_id
                  where s.item_id = p_item
                    and t.base_unit is distinct from p_unit
                    and public.stock_co__site_item_in_use(s.location_id, t.id));
$fn$;

create or replace function public.stock_co__base_unit_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.base_unit is distinct from old.base_unit and public.stock_co__unit_in_use(old.id, new.base_unit) then
    raise exception '% has stock, counts, pars or orders in % at a site, so its base unit cannot change to %. Make a new item instead.',
      old.name, old.base_unit, new.base_unit using errcode = '55000';
  end if;
  return new;
end
$fn$;

create trigger stock_co_base_unit_lock before update of base_unit on public.stock_co_items
  for each row execute function public.stock_co__base_unit_lock();

-- ============================================================================
-- Step 7. Row level security, the second sign in step, table grants
-- ============================================================================

do $rls$
declare
  t text;
begin
  foreach t in array array['stock_co_items', 'stock_co_item_sites', 'stock_co_packs', 'stock_co_pack_sites', 'stock_co_bridges',
                           'stock_co_bridge_sites', 'stock_co_suppliers', 'stock_co_supplier_sites', 'stock_co_supplier_items',
                           'stock_co_supplier_item_sites', 'stock_co_recipes', 'stock_co_recipe_lines', 'stock_co_recipe_sites',
                           'stock_change_log', 'stock_save_queue'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated, service_role', t);
  end loop;
end
$rls$;

-- The two identity sequences: nobody but the definer functions takes a number.
do $seq$
declare
  s text;
begin
  foreach s in array array[pg_get_serial_sequence('public.stock_change_log', 'id'), pg_get_serial_sequence('public.stock_save_queue', 'id')] loop
    execute format('revoke all on sequence %s from public, anon, authenticated, service_role', s);
  end loop;
end
$seq$;

-- Company rows: read by every login that reaches a site of the company.
create policy stock_co_items_read on public.stock_co_items as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_co_packs_read on public.stock_co_packs as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_co_bridges_read on public.stock_co_bridges as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_co_suppliers_read on public.stock_co_suppliers as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_co_supplier_items_read on public.stock_co_supplier_items as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_co_recipes_read on public.stock_co_recipes as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_co_recipe_lines_read on public.stock_co_recipe_lines as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));

-- Site links and site values: read only by logins that reach that site (a Location 2 manager never
-- reads Provo's price here or account number).
create policy stock_co_item_sites_read on public.stock_co_item_sites as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_co_pack_sites_read on public.stock_co_pack_sites as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_co_bridge_sites_read on public.stock_co_bridge_sites as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_co_supplier_sites_read on public.stock_co_supplier_sites as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_co_supplier_item_sites_read on public.stock_co_supplier_item_sites as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_co_recipe_sites_read on public.stock_co_recipe_sites as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));

-- The log and the queue hold site values (before and after of price here, account number, order
-- email; queued site steps): a row with a site by that site, a company row by company.
create policy stock_change_log_read on public.stock_change_log as permissive for select to authenticated
  using ((location_id is not null and location_id::text in (select public.stock_reach_locations()))
      or (location_id is null and org_id::text in (select public.stock_reach_orgs())));
create policy stock_save_queue_read on public.stock_save_queue as permissive for select to authenticated
  using ((location_id is not null and location_id::text in (select public.stock_reach_locations()))
      or (location_id is null and org_id::text in (select public.stock_reach_orgs())));

-- The second sign in step, as on every other table (20260919s). Skipped when that file has not run.
do $second_step$
declare
  t text;
begin
  if to_regprocedure('public.second_step_ok()') is null then
    return;
  end if;
  foreach t in array array['stock_co_items', 'stock_co_item_sites', 'stock_co_packs', 'stock_co_pack_sites', 'stock_co_bridges',
                           'stock_co_bridge_sites', 'stock_co_suppliers', 'stock_co_supplier_sites', 'stock_co_supplier_items',
                           'stock_co_supplier_item_sites', 'stock_co_recipes', 'stock_co_recipe_lines', 'stock_co_recipe_sites',
                           'stock_change_log', 'stock_save_queue'] loop
    if not exists (select 1 from pg_policy p where p.polrelid = format('public.%I', t)::regclass and p.polname = 'second_step_fence') then
      execute format('create policy second_step_fence on public.%I as restrictive for all to authenticated '
        || 'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
    end if;
  end loop;
end
$second_step$;

-- ============================================================================
-- Step 8. Stock reach: a Stock control All sites login reaches every site of its own company,
-- for stock only. user_accessible_locations(), accessible_location_ids() and
-- accessible_location_uuids() are not changed, so sales, staff, customers and bookings reach
-- stays exactly as today.
-- ============================================================================

-- Live body (20261019b) with user_accessible_locations() swapped for stock_reach_locations().
CREATE OR REPLACE FUNCTION public.stock_office_reaches(p_location_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_location_id is not null
     and (
          coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
       or (coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = ''
           and session_user::text not in ('authenticator', 'anon', 'authenticated'))
       or (p_location_id)::text in (select public.stock_reach_locations())
     );
$function$;

-- Live body (20261018a) with one arm added: a Stock control All sites login of the venue's company.
-- Devices and paired tills reach exactly as before.
CREATE OR REPLACE FUNCTION public.stock_caller_reaches(p_location_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_location_id is not null
     and (
          -- another edge function, with the service role key
          coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
          -- the database itself: no API claims, and not the login the API connects as
       or (coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = ''
           and session_user::text not in ('authenticator', 'anon', 'authenticated'))
          -- a Back Office login of the venue or its company, a super admin, or a device bound to it
       or p_location_id in (select public.accessible_location_uuids())
          -- a Stock control All sites login of the venue's company (stock only, 20261021a)
       or (p_location_id)::text in (select public.stock_reach_locations())
     );
$function$;

-- The 51 + 14 stock rules. The lists below were read from pg_policies on the live Ops database on
-- 20 Oct 2026 (read only). First a copy of every rule as it is now; this stops, changing nothing,
-- if the rules are not exactly those (a rule added, dropped, renamed, or already swapped).
create temp table _stock_native_pol on commit drop as
select p.tablename::text as tbl, p.policyname::text as pol, p.cmd::text as cmd, p.permissive::text as permissive,
       p.roles::text as roles, replace(p.qual, 'public.', '') as qual, replace(p.with_check, 'public.', '') as with_check,
       case when strpos(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''), 'user_accessible_locations()') > 0
            then 'ual' else 'alu' end as kind
  from pg_policies p
 where p.schemaname = 'public'
   and p.tablename in (
    'inventory_item_area_stock', 'inventory_item_areas', 'inventory_item_conversions', 'inventory_items',
    'item_cost_history', 'item_packaging_formats', 'menu_item_recipes', 'par_levels', 'po_lines',
    'prep_schedule', 'production_batches', 'purchase_orders', 'recipe_lines', 'recipes', 'stock_count_areas',
    'stock_count_lines', 'stock_counts', 'stock_movements', 'stock_site_settings', 'stock_transfer_lines',
    'stock_transfers', 'storage_areas', 'supplier_invoice_lines', 'supplier_invoices', 'supplier_products',
    'suppliers', 'waste_events')
   and (strpos(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''), 'user_accessible_locations()') > 0
        or strpos(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''), 'accessible_location_uuids()') > 0
        or strpos(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''), 'stock_reach_locations()') > 0);

do $pol_before$
declare
  v_ual text[] := array[
    'inventory_item_area_stock.inventory_item_area_stock_read',
    'inventory_item_areas.inventory_item_areas_rls',
    'inventory_item_conversions.inventory_item_conversions_del',
    'inventory_item_conversions.inventory_item_conversions_upd',
    'inventory_item_conversions.inventory_item_conversions_write', 'inventory_items.inventory_items_del',
    'inventory_items.inventory_items_upd', 'inventory_items.inventory_items_write',
    'item_cost_history.item_cost_history_rls', 'item_packaging_formats.item_packaging_formats_del',
    'item_packaging_formats.item_packaging_formats_upd',
    'item_packaging_formats.item_packaging_formats_write', 'menu_item_recipes.menu_item_recipes_del',
    'menu_item_recipes.menu_item_recipes_upd', 'menu_item_recipes.menu_item_recipes_write',
    'par_levels.par_levels_rls', 'po_lines.po_lines_rls', 'prep_schedule.prep_schedule_del',
    'prep_schedule.prep_schedule_ins', 'prep_schedule.prep_schedule_upd',
    'production_batches.production_batches_del', 'purchase_orders.purchase_orders_rls',
    'recipe_lines.recipe_lines_del', 'recipe_lines.recipe_lines_upd', 'recipe_lines.recipe_lines_write',
    'recipes.recipes_del', 'recipes.recipes_upd', 'recipes.recipes_write',
    'stock_count_areas.stock_count_areas_rls', 'stock_count_lines.stock_count_lines_rls',
    'stock_counts.stock_counts_rls', 'stock_movements.stock_movements_read',
    'stock_site_settings.stock_site_settings_insert', 'stock_site_settings.stock_site_settings_update',
    'stock_transfer_lines.stock_transfer_lines_delete', 'stock_transfer_lines.stock_transfer_lines_insert',
    'stock_transfer_lines.stock_transfer_lines_select', 'stock_transfer_lines.stock_transfer_lines_update',
    'stock_transfers.stock_transfers_delete', 'stock_transfers.stock_transfers_insert',
    'stock_transfers.stock_transfers_select', 'stock_transfers.stock_transfers_update',
    'storage_areas.storage_areas_rls', 'supplier_invoice_lines.supplier_invoice_lines_rls',
    'supplier_invoices.supplier_invoices_rls', 'supplier_products.supplier_products_del',
    'supplier_products.supplier_products_upd', 'supplier_products.supplier_products_write',
    'suppliers.suppliers_rls', 'waste_events.waste_events_del', 'waste_events.waste_events_upd'];
  v_alu text[] := array[
    'inventory_item_conversions.inventory_item_conversions_sel', 'inventory_items.inventory_items_sel',
    'item_packaging_formats.item_packaging_formats_sel', 'menu_item_recipes.menu_item_recipes_sel',
    'prep_schedule.prep_schedule_sel', 'production_batches.production_batches_ins',
    'production_batches.production_batches_sel', 'production_batches.production_batches_upd',
    'recipe_lines.recipe_lines_sel', 'recipes.recipes_sel', 'stock_site_settings.stock_site_settings_read',
    'supplier_products.supplier_products_sel', 'waste_events.waste_events_ins',
    'waste_events.waste_events_sel'];
  v_live_ual text[];
  v_live_alu text[];
  v_both integer;
  v_done integer;
  v_tables integer;
begin
  select coalesce(array_agg(s.tbl || '.' || s.pol order by s.tbl || '.' || s.pol) filter (where s.kind = 'ual'), '{}'),
         coalesce(array_agg(s.tbl || '.' || s.pol order by s.tbl || '.' || s.pol) filter (where s.kind = 'alu'), '{}'),
         count(*) filter (where strpos(coalesce(s.qual, '') || ' ' || coalesce(s.with_check, ''), 'user_accessible_locations()') > 0
                            and strpos(coalesce(s.qual, '') || ' ' || coalesce(s.with_check, ''), 'accessible_location_uuids()') > 0),
         count(*) filter (where strpos(coalesce(s.qual, '') || ' ' || coalesce(s.with_check, ''), 'stock_reach_locations()') > 0),
         count(distinct s.tbl)
    into v_live_ual, v_live_alu, v_both, v_done, v_tables
    from _stock_native_pol s;
  if v_done > 0 then
    raise exception 'The stock rules already name stock_reach_locations(). Nothing was changed.';
  end if;
  if v_both > 0 then
    raise exception 'A stock rule names both user_accessible_locations() and accessible_location_uuids(). Ask Claude for a new file. Nothing was changed.';
  end if;
  if v_live_ual is distinct from (select array_agg(x order by x) from unnest(v_ual) x)
     or v_live_alu is distinct from (select array_agg(x order by x) from unnest(v_alu) x)
     or cardinality(v_live_ual) <> 51 or cardinality(v_live_alu) <> 14 or v_tables <> 27 then
    raise exception 'The stock rules changed since this file was written (% and % found, 51 and 14 expected; not in the file: %; missing: %). Ask Claude for a new file. Nothing was changed.',
      cardinality(v_live_ual), cardinality(v_live_alu),
      coalesce((select string_agg(x, ', ') from unnest(v_live_ual || v_live_alu) x where x <> all (v_ual || v_alu)), 'none'),
      coalesce((select string_agg(x, ', ') from unnest(v_ual || v_alu) x where x <> all (v_live_ual || v_live_alu)), 'none');
  end if;
end
$pol_before$;

-- 8a. The 51 rules that named user_accessible_locations() now name stock_reach_locations().
alter policy inventory_item_area_stock_read on public.inventory_item_area_stock
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy inventory_item_areas_rls on public.inventory_item_areas
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy inventory_item_conversions_del on public.inventory_item_conversions
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy inventory_item_conversions_upd on public.inventory_item_conversions
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy inventory_item_conversions_write on public.inventory_item_conversions
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy inventory_items_del on public.inventory_items
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy inventory_items_upd on public.inventory_items
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy inventory_items_write on public.inventory_items
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy item_cost_history_rls on public.item_cost_history
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy item_packaging_formats_del on public.item_packaging_formats
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy item_packaging_formats_upd on public.item_packaging_formats
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy item_packaging_formats_write on public.item_packaging_formats
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy menu_item_recipes_del on public.menu_item_recipes
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy menu_item_recipes_upd on public.menu_item_recipes
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy menu_item_recipes_write on public.menu_item_recipes
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy par_levels_rls on public.par_levels
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy po_lines_rls on public.po_lines
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy prep_schedule_del on public.prep_schedule
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy prep_schedule_ins on public.prep_schedule
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy prep_schedule_upd on public.prep_schedule
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy production_batches_del on public.production_batches
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy purchase_orders_rls on public.purchase_orders
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy recipe_lines_del on public.recipe_lines
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy recipe_lines_upd on public.recipe_lines
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy recipe_lines_write on public.recipe_lines
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy recipes_del on public.recipes
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy recipes_upd on public.recipes
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy recipes_write on public.recipes
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy stock_count_areas_rls on public.stock_count_areas
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy stock_count_lines_rls on public.stock_count_lines
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy stock_counts_rls on public.stock_counts
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy stock_movements_read on public.stock_movements
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy stock_site_settings_insert on public.stock_site_settings
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy stock_site_settings_update on public.stock_site_settings
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy stock_transfer_lines_delete on public.stock_transfer_lines
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy stock_transfer_lines_insert on public.stock_transfer_lines
  with check ((((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)) AND ((to_location_id IS NULL) OR public.stock_same_company(location_id, to_location_id))));
alter policy stock_transfer_lines_select on public.stock_transfer_lines
  using ((((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)) OR ((to_location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy stock_transfer_lines_update on public.stock_transfer_lines
  using ((((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)) OR ((to_location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))))
  with check ((((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)) OR ((to_location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy stock_transfers_delete on public.stock_transfers
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy stock_transfers_insert on public.stock_transfers
  with check ((((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)) AND ((to_location_id IS NULL) OR public.stock_same_company(location_id, to_location_id))));
alter policy stock_transfers_select on public.stock_transfers
  using ((((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)) OR ((to_location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy stock_transfers_update on public.stock_transfers
  using ((((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)) OR ((to_location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))))
  with check ((((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)) OR ((to_location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy storage_areas_rls on public.storage_areas
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy supplier_invoice_lines_rls on public.supplier_invoice_lines
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy supplier_invoices_rls on public.supplier_invoices
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy supplier_products_del on public.supplier_products
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy supplier_products_upd on public.supplier_products
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy supplier_products_write on public.supplier_products
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy suppliers_rls on public.suppliers
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy waste_events_del on public.waste_events
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));
alter policy waste_events_upd on public.waste_events
  using (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)))
  with check (((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations)));

-- 8b. The 14 rules that named accessible_location_uuids() keep it (tills, KDS and the phone
--     app read exactly as today) and also let a Stock control All sites login read its company.
alter policy inventory_item_conversions_sel on public.inventory_item_conversions
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy inventory_items_sel on public.inventory_items
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy item_packaging_formats_sel on public.item_packaging_formats
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy menu_item_recipes_sel on public.menu_item_recipes
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy prep_schedule_sel on public.prep_schedule
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy production_batches_ins on public.production_batches
  with check (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy production_batches_sel on public.production_batches
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy production_batches_upd on public.production_batches
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))))
  with check (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy recipe_lines_sel on public.recipe_lines
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy recipes_sel on public.recipes
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy stock_site_settings_read on public.stock_site_settings
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy supplier_products_sel on public.supplier_products
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy waste_events_ins on public.waste_events
  with check (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));
alter policy waste_events_sel on public.waste_events
  using (((location_id IN ( SELECT public.accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT public.stock_reach_locations() AS stock_reach_locations))));

-- Every rule is now exactly the copy above with the one swap and nothing else (same command, same
-- roles, permissive as before), or this stops and nothing is changed.
do $pol_after$
declare
  v_bad text;
  v_left integer;
  v_reach integer;
  v_dev integer;
begin
  select string_agg(s.tbl || '.' || s.pol, ', ' order by s.tbl, s.pol) into v_bad
    from _stock_native_pol s
    left join pg_policies p on p.schemaname = 'public' and p.tablename = s.tbl and p.policyname = s.pol
   where p.policyname is null
      or p.cmd::text is distinct from s.cmd
      or p.permissive::text is distinct from s.permissive
      or p.roles::text is distinct from s.roles
      or replace(p.qual, 'public.', '') is distinct from
           case when s.kind = 'ual'
                then replace(s.qual, 'user_accessible_locations() AS user_accessible_locations', 'stock_reach_locations() AS stock_reach_locations')
                else replace(s.qual, '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
                             '((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT stock_reach_locations() AS stock_reach_locations)))')
           end
      or replace(p.with_check, 'public.', '') is distinct from
           case when s.kind = 'ual'
                then replace(s.with_check, 'user_accessible_locations() AS user_accessible_locations', 'stock_reach_locations() AS stock_reach_locations')
                else replace(s.with_check, '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
                             '((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)) OR ((location_id)::text IN ( SELECT stock_reach_locations() AS stock_reach_locations)))')
           end;
  if v_bad is not null then
    raise exception 'These stock rules did not come out as the file expects: %. Ask Claude for a new file. Nothing was changed.', v_bad;
  end if;
  select count(*) filter (where strpos(x.e, 'user_accessible_locations()') > 0),
         count(*) filter (where strpos(x.e, 'stock_reach_locations()') > 0),
         count(*) filter (where strpos(x.e, 'stock_reach_locations()') > 0 and strpos(x.e, 'accessible_location_uuids()') > 0)
    into v_left, v_reach, v_dev
    from (select coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') as e
            from pg_policies p
           where p.schemaname = 'public' and p.tablename in (select distinct s.tbl from _stock_native_pol s)) x;
  if v_left <> 0 or v_reach <> 65 or v_dev <> 14 then
    raise exception 'The stock rule swap counted % left on user_accessible_locations(), % on stock_reach_locations() (65 expected), % for devices (14 expected). Nothing was changed.',
      v_left, v_reach, v_dev;
  end if;
end
$pol_after$;

-- ============================================================================
-- Step 9. The writer pass
-- ============================================================================
-- Gets past the 0b lock triggers: a stock writer in THIS transaction (it sets
-- servos.stock_co_write to the transaction id and runs as the owner role, postgres), or the
-- database itself (SQL editor, pg_cron: no request claims and not logged in through the API). A
-- client can set the setting but cannot be postgres inside the API, and every other definer
-- function of postgres leaves the setting unset. INVOKER on purpose: the role check never lives
-- here, and current_user must be the caller's role.
create or replace function public.stock_co__writer_ok()
returns boolean
language sql
volatile
set search_path = public
as $fn$
  select (coalesce(current_setting('servos.stock_co_write', true), '') = txid_current()::text and current_user = 'postgres')
      or (session_user::text not in ('authenticator', 'anon', 'authenticated', 'service_role')
          and coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = '');
$fn$;

-- ============================================================================
-- Step 9b. company_ref is written only by the stock writers (review fix, 20 Oct)
-- ============================================================================
-- company_ref on the six site tables says which company record a site row belongs to. The save
-- functions, the writer, the orphan and mirror triggers, the backfill and the link set it (inside the
-- writer pass, or as the SQL editor and pg_cron). From 0a on a signed in login can no longer add a
-- site row that already names a company record, or change the company record a site row names; 0b
-- later adds the company fields. The save functions never read company_ref to decide anything (a
-- site row id resolves through its link row, stock_co__company_id), so this is a second wall. No
-- screen writes company_ref, so no open tab is affected; a row added without it still gets its own
-- company record from the orphan trigger. Fires only when company_ref is in the statement (a sale's
-- on hand update never fires it). INVOKER on purpose, like stock_co__writer_ok: current_user must be
-- the caller's role. No EXECUTE grant is needed (a trigger function is not checked when it fires).
create or replace function public.stock_co__ref_lock()
returns trigger
language plpgsql
volatile
set search_path = public, pg_temp
as $fn$
begin
  if public.stock_co__writer_ok() then
    return new;
  end if;
  raise exception 'The company record of a stock row is set by the stock screens only.'
    using errcode = '42501',
          detail = format('A direct %s of company_ref on %s.', lower(tg_op), tg_table_name),
          hint = 'Save it on the Back Office stock screens.';
end
$fn$;

create trigger stock_co_ref_lock_ins before insert on public.inventory_items
  for each row when (new.company_ref is not null) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_upd before update of company_ref on public.inventory_items
  for each row when (old.company_ref is distinct from new.company_ref) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_ins before insert on public.suppliers
  for each row when (new.company_ref is not null) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_upd before update of company_ref on public.suppliers
  for each row when (old.company_ref is distinct from new.company_ref) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_ins before insert on public.supplier_products
  for each row when (new.company_ref is not null) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_upd before update of company_ref on public.supplier_products
  for each row when (old.company_ref is distinct from new.company_ref) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_ins before insert on public.item_packaging_formats
  for each row when (new.company_ref is not null) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_upd before update of company_ref on public.item_packaging_formats
  for each row when (old.company_ref is distinct from new.company_ref) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_ins before insert on public.inventory_item_conversions
  for each row when (new.company_ref is not null) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_upd before update of company_ref on public.inventory_item_conversions
  for each row when (old.company_ref is distinct from new.company_ref) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_ins before insert on public.recipes
  for each row when (new.company_ref is not null) execute function public.stock_co__ref_lock();
create trigger stock_co_ref_lock_upd before update of company_ref on public.recipes
  for each row when (old.company_ref is distinct from new.company_ref) execute function public.stock_co__ref_lock();

-- ============================================================================
-- Step 10. Change log, save queue and the runner
-- ============================================================================

-- One change log row; who is the signed in login (null for the SQL editor and pg_cron), with the
-- name from the profile (else the email). Returns the row id (save queue payloads and REVALUE keys
-- carry it).
create or replace function public.stock_co__log(p_org uuid, p_loc uuid, p_entity text, p_entity_id uuid, p_field text,
                                                p_before jsonb, p_after jsonb, p_source text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid  uuid := auth.uid();
  v_name text;
  v_id   bigint;
begin
  if v_uid is not null then
    select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), '')) into v_name
      from user_profiles p
     where p.id = v_uid;
  end if;
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  values (p_org, p_loc, p_entity, p_entity_id, p_field, p_before, p_after, v_uid, v_name, coalesce(p_source, 'save'))
  returning id into v_id;
  return v_id;
end
$fn$;

-- One waiting save queue row. Drop 0 knows one kind, site_sync, always for one site of the company.
create or replace function public.stock_co__enqueue(p_org uuid, p_loc uuid, p_kind text, p_payload jsonb, p_entity_ids uuid[])
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id bigint;
begin
  if p_kind is distinct from 'site_sync' then
    raise exception 'This database does not know the save job kind %.', coalesce(p_kind, 'null') using errcode = '22023';
  end if;
  if p_org is null or p_loc is null
     or not exists (select 1 from locations l where l.id = p_loc and l.org_id = p_org) then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  insert into stock_save_queue (org_id, location_id, kind, payload, entity_ids, created_by)
  values (p_org, p_loc, p_kind, coalesce(p_payload, '{}'::jsonb), p_entity_ids, auth.uid())
  returning id into v_id;
  return v_id;
end
$fn$;

-- Runs one waiting job, one chunk of at most 300 site rows (a company item counts 1 plus its packs,
-- bridges and supplier packs; a supplier 1 plus its supplier packs; a recipe 2 plus its lines).
-- Items and suppliers go first, recipes once every item and supplier of the job is written. A job
-- with more left goes back to waiting, due now, and the runner commits and picks it up again;
-- progress keeps how far it got. Lock waits are 200 ms, so a sale never waits long on a stock item.
--   busy (lock_not_available, deadlock_detected, query_canceled): waiting again in a minute,
--     attempts kept;
--   any other error: attempts + 1, waiting again in that many minutes, failed at the 5th, with the
--     database's words kept in last_error.
-- Returns the status it left the job in ('done', 'waiting' or 'failed'), its present status when the
-- job was not waiting, or null when there is no such job.
create or replace function public.stock_co__run_job(p_job bigint)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  j          stock_save_queue%rowtype;
  v_items    uuid[];
  v_sups     uuid[];
  v_recs     uuid[];
  v_i        integer;
  v_s        integer;
  v_r        integer;
  v_ci       uuid[] := '{}';
  v_cs       uuid[] := '{}';
  v_cr       uuid[] := '{}';
  v_used     integer := 0;
  v_more     integer := 0;
  v_res      jsonb;
  v_writes   integer := 0;
  v_status   text;
  v_tries    integer;
  v_lock_was text := current_setting('lock_timeout');
begin
  select * into j from stock_save_queue q where q.id = p_job for update;
  if not found then
    return null;
  end if;
  if j.status <> 'waiting' then
    return j.status;
  end if;
  if j.kind is distinct from 'site_sync' or j.location_id is null
     or not exists (select 1 from locations l where l.id = j.location_id and l.org_id = j.org_id) then
    update stock_save_queue
       set status = 'failed', started_at = coalesce(started_at, now()), done_at = clock_timestamp(),
           last_error = case when j.kind is distinct from 'site_sync' then 'This database does not know this kind of save job.'
                             else 'That site is not in this company any more, so nothing was written there.' end
     where id = p_job;
    return 'failed';
  end if;

  begin
    perform set_config('lock_timeout', '200ms', true);

    -- the company ids of the job, each once, in the order given (a missing list means none)
    select coalesce(array_agg(x.id order by x.o), '{}') into v_items
      from (select e.v::uuid as id, min(e.o) as o
              from jsonb_array_elements_text(case when jsonb_typeof(j.payload -> 'item_ids') = 'array'
                                                  then j.payload -> 'item_ids' else '[]'::jsonb end) with ordinality e(v, o)
             group by 1) x;
    select coalesce(array_agg(x.id order by x.o), '{}') into v_sups
      from (select e.v::uuid as id, min(e.o) as o
              from jsonb_array_elements_text(case when jsonb_typeof(j.payload -> 'supplier_ids') = 'array'
                                                  then j.payload -> 'supplier_ids' else '[]'::jsonb end) with ordinality e(v, o)
             group by 1) x;
    select coalesce(array_agg(x.id order by x.o), '{}') into v_recs
      from (select e.v::uuid as id, min(e.o) as o
              from jsonb_array_elements_text(case when jsonb_typeof(j.payload -> 'recipe_ids') = 'array'
                                                  then j.payload -> 'recipe_ids' else '[]'::jsonb end) with ordinality e(v, o)
             group by 1) x;

    -- how far earlier chunks got
    v_i := least(greatest(coalesce((j.progress ->> 'items_done')::integer, 0), 0), cardinality(v_items));
    v_s := least(greatest(coalesce((j.progress ->> 'suppliers_done')::integer, 0), 0), cardinality(v_sups));
    v_r := least(greatest(coalesce((j.progress ->> 'recipes_done')::integer, 0), 0), cardinality(v_recs));

    -- this chunk: items first, then suppliers in the room left, at least one record
    if v_i < cardinality(v_items) then
      select coalesce(array_agg(c.id order by c.o), '{}'), coalesce(max(c.cum), 0) into v_ci, v_used
        from (select w.id, w.o, sum(w.wt) over (order by w.o) as cum
                from (select x.id, x.o,
                             1 + (select count(*) from stock_co_packs p where p.org_id = j.org_id and p.item_id = x.id)
                               + (select count(*) from stock_co_bridges b where b.org_id = j.org_id and b.item_id = x.id)
                               + (select count(*) from stock_co_supplier_items s where s.org_id = j.org_id and s.item_id = x.id) as wt
                        from unnest(v_items[v_i + 1 : v_i + 300]) with ordinality x(id, o)) w) c
       where c.cum <= 300 or c.o = 1;
    end if;
    if v_s < cardinality(v_sups) and v_used < 300 then
      select coalesce(array_agg(c.id order by c.o), '{}'), coalesce(max(c.cum), 0) into v_cs, v_more
        from (select w.id, w.o, sum(w.wt) over (order by w.o) as cum
                from (select x.id, x.o,
                             1 + (select count(*) from stock_co_supplier_items s where s.org_id = j.org_id and s.supplier_id = x.id) as wt
                        from unnest(v_sups[v_s + 1 : v_s + 300]) with ordinality x(id, o)) w) c
       where c.cum <= 300 - v_used or (c.o = 1 and v_used = 0);
      v_used := v_used + v_more;
    end if;
    if cardinality(v_ci) > 0 or cardinality(v_cs) > 0 then
      v_res := public.stock_co__sync_site(j.location_id, v_ci, v_cs, true, false);
      v_writes := v_writes + coalesce((v_res ->> 'writes')::integer, 0);
    end if;
    v_i := v_i + cardinality(v_ci);
    v_s := v_s + cardinality(v_cs);

    -- recipes once every item and supplier of the job is at the site (their lines point at them)
    if v_i >= cardinality(v_items) and v_s >= cardinality(v_sups) and v_r < cardinality(v_recs) and v_used < 300 then
      select coalesce(array_agg(c.id order by c.o), '{}'), coalesce(max(c.cum), 0) into v_cr, v_more
        from (select w.id, w.o, sum(w.wt) over (order by w.o) as cum
                from (select x.id, x.o,
                             2 + (select count(*) from stock_co_recipe_lines l where l.recipe_id = x.id) as wt
                        from unnest(v_recs[v_r + 1 : v_r + 300]) with ordinality x(id, o)) w) c
       where c.cum <= 300 - v_used or (c.o = 1 and v_used = 0);
      if cardinality(v_cr) > 0 then
        v_res := public.stock_co__sync_recipes(j.location_id, v_cr, true, false);
        v_writes := v_writes + coalesce((v_res ->> 'writes')::integer, 0);
      end if;
      v_r := v_r + cardinality(v_cr);
    end if;

    v_status := case when v_i >= cardinality(v_items) and v_s >= cardinality(v_sups) and v_r >= cardinality(v_recs)
                     then 'done' else 'waiting' end;
    update stock_save_queue
       set status = v_status,
           started_at = coalesce(started_at, now()),
           done_at = case when v_status = 'done' then clock_timestamp() end,
           due_at = case when v_status = 'waiting' then now() else due_at end,
           last_error = null,
           progress = progress || jsonb_build_object(
             'items_done', v_i, 'suppliers_done', v_s, 'recipes_done', v_r,
             'writes', coalesce((progress ->> 'writes')::integer, 0) + v_writes,
             'chunks', coalesce((progress ->> 'chunks')::integer, 0) + 1)
     where id = p_job;
    perform set_config('lock_timeout', v_lock_was, true);
    return v_status;
  exception
    when lock_not_available or deadlock_detected or query_canceled then
      update stock_save_queue
         set status = 'waiting', due_at = now() + interval '1 minute', started_at = coalesce(started_at, now()),
             last_error = 'The site was busy (a sale or a delivery held a stock item), so it gave way. It tries again in a minute.'
       where id = p_job;
      return 'waiting';
    when others then
      v_tries := j.attempts + 1;
      update stock_save_queue
         set attempts = v_tries,
             status = case when v_tries >= 5 then 'failed' else 'waiting' end,
             due_at = case when v_tries >= 5 then due_at else now() + make_interval(mins => v_tries) end,
             done_at = case when v_tries >= 5 then clock_timestamp() end,
             started_at = coalesce(started_at, now()),
             last_error = left(sqlerrm, 400),
             progress = progress || jsonb_build_object('error_code', sqlstate)
       where id = p_job;
      return case when v_tries >= 5 then 'failed' else 'waiting' end;
  end;
end
$fn$;

-- The runner. A PROCEDURE so it can COMMIT after each job chunk. Postgres refuses COMMIT inside a
-- SECURITY DEFINER procedure and inside one with a SET clause, so it is INVOKER, has no
-- search_path of its own and names every object with its schema; only its owner (postgres) runs
-- it: pg_cron and the SQL editor (part 5 revokes it from every API role). One runner at a time: a
-- transaction level advisory lock taken again in every transaction, so a cut off call frees it.
-- Stops after p_budget_s seconds (pg_cron starts it again next minute).
create or replace procedure public.stock_save_queue_run(p_budget_s integer default 45)
language plpgsql
as $proc$
declare
  v_t0     timestamptz := clock_timestamp();
  v_budget integer := greatest(coalesce(p_budget_s, 45), 0);
  v_lock   bigint := hashtext('stock_save_queue_run');
  v_id     bigint;
begin
  -- nothing due: return at once, holding nothing for the rest of the minute
  if not exists (select 1 from public.stock_save_queue q where q.status = 'waiting' and q.due_at <= now()) then
    return;
  end if;
  loop
    if not pg_try_advisory_xact_lock(v_lock) then
      exit;
    end if;
    v_id := null;
    select q.id into v_id
      from public.stock_save_queue q
     where q.status = 'waiting' and q.due_at <= now()
     order by q.due_at, q.id
     limit 1
     for update skip locked;
    if v_id is null then
      commit;
      exit;
    end if;
    begin
      perform public.stock_co__run_job(v_id);
    exception when others then
      -- run_job keeps its own errors; this only catches one in its own bookkeeping
      update public.stock_save_queue
         set attempts = attempts + 1,
             status = case when attempts + 1 >= 5 then 'failed' else 'waiting' end,
             due_at = now() + make_interval(mins => attempts + 1),
             done_at = case when attempts + 1 >= 5 then clock_timestamp() end,
             last_error = left(sqlerrm, 400)
       where id = v_id;
    end;
    commit;
    exit when clock_timestamp() - v_t0 > make_interval(secs => v_budget);
  end loop;
end
$proc$;

-- pg_cron: every minute, as postgres.
do $cron$
declare
  j record;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not there (cron.schedule). Nothing was changed.';
  end if;
  for j in select c.jobid from cron.job c where c.jobname = 'stock-save-queue' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('stock-save-queue', '* * * * *', 'call public.stock_save_queue_run(45);');
end
$cron$;
-- == 0a part 3: cost writers, the writer and the saves (steps 11, 11b, 12, 13) ==
-- What this part does (bare statements; no grants: part 5 owns every function grant and revoke):
--   step 11   REVALUE and COMPANY added to the two CHECK lists; _stock_revalue; the three live cost writers
--             (_stock_receive_lines, approve_stock_count, post_stock_transfer_leg) rebuilt from their live
--             text with one REVALUE call each, in the branch where cost resets only.
--   step 11b  stock_co__cost_rule_of and stock_cost_rule (the site override, else the company rule).
--   step 12   the writer: stock_co__sync_site (items, packs, bridges, suppliers, supplier packs, the cost
--             step) and stock_co__sync_recipes (recipes, lines, the till link), each with a check mode.
--   step 13   the validator, the common guard and the Drop 0 save and read functions.
-- It uses, from part 1: user_profiles.stock_control, stock_level, stock_reach_locations, stock_reach_orgs,
-- stock_co_settings, stock_co_site_settings, stock_co_site_groups and the site columns company_ref,
-- row_version, archived_at, cc_emails, delivery_fee, approval_limit; from part 2: the stock_co_ tables,
-- stock_change_log, stock_save_queue, stock_co__log, stock_co__enqueue, stock_co__site_item_in_use and the
-- replaced stock_caller_reaches.


-- ============================================================================
-- STEP 11. REVALUE: a movement that changes the value of stock held, never its quantity.
-- ============================================================================
-- The two lists are the live values (read 20 Oct 2026) plus one new value each. Added NOT VALID, then
-- validated (a short lock). Both values stay after a rollback: rows may carry them.
alter table public.stock_movements
  drop constraint if exists stock_movements_movement_type_check,
  add constraint stock_movements_movement_type_check check (movement_type = any (array[
    'OPENING_BALANCE'::text, 'PURCHASE_RECEIPT'::text, 'SALE_DEPLETION'::text, 'WASTE'::text, 'STOCK_COUNT_ADJ'::text,
    'PRODUCTION_CONSUME'::text, 'PRODUCTION_OUTPUT'::text, 'TRANSFER_IN'::text, 'TRANSFER_OUT'::text, 'RETURN'::text,
    'MANUAL_ADJ'::text, 'REVALUE'::text])) not valid;
alter table public.stock_movements validate constraint stock_movements_movement_type_check;

alter table public.item_cost_history
  drop constraint if exists item_cost_history_source_chk,
  add constraint item_cost_history_source_chk check (source = any (array[
    'INVOICE'::text, 'MANUAL'::text, 'CONTRACT'::text, 'CATALOG'::text, 'RECIPE_ROLLUP'::text, 'PO_RECEIPT'::text,
    'TRANSFER'::text, 'COMPANY'::text])) not valid;
alter table public.item_cost_history validate constraint item_cost_history_source_chk;

-- One REVALUE row: the stock held (p_qty_held, before the change) moves from the old cost to the new
-- one. Quantity 0, so on hand and area stock never move; written straight into the ledger, never
-- through _post_stock_movement (that adds the quantity to on hand and to area stock). The key makes a
-- second call with the same key write nothing. Returns the value written (0 when none). Owner only.
create or replace function public._stock_revalue(p_loc uuid, p_item uuid, p_qty_held numeric, p_old numeric, p_new numeric,
                                                 p_source text, p_key text, p_source_id text default null)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_value numeric;
  v_id uuid;
begin
  if p_loc is null or p_item is null or p_new is null then
    return 0;
  end if;
  if coalesce(p_qty_held, 0) = 0 or p_new is not distinct from p_old then
    return 0;
  end if;
  if not exists (select 1 from inventory_items i where i.id = p_item and i.location_id = p_loc) then
    raise exception '_stock_revalue: stock item % is not at venue %', p_item, p_loc using errcode = '22023';
  end if;
  v_value := round(p_qty_held * (p_new - coalesce(p_old, 0)), 4);
  insert into stock_movements (location_id, inventory_item_id, qty_base, unit_cost, value_delta, movement_type,
                               source_type, source_id, occurred_at, posted_at, created_by, idempotency_key, notes)
  values (p_loc, p_item, 0, p_new, v_value, 'REVALUE', p_source, p_source_id, now(), now(), auth.uid(), p_key,
          'Cost changed: the stock held is valued at the new cost')
  on conflict (location_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;
  return case when v_id is null then 0 else v_value end;
end
$fn$;

-- _stock_receive_lines: the live body (md5 checked in part 1, step 0) with the REVALUE call added in
-- the reset branch. Everything else is the live text.
CREATE OR REPLACE FUNCTION public._stock_receive_lines(p_location_id uuid, p_source_type text, p_source_id text, p_lines jsonb, p_area_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_line jsonb;
  v_item record;
  v_res jsonb;
  v_qty numeric;
  v_cost numeric;
  v_new numeric;
  v_before numeric;
  v_sp uuid;
  v_doc uuid;
  v_out jsonb := '[]'::jsonb;
  v_posted integer := 0;
  v_dupes integer := 0;
  v_reset boolean;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'stock_receive: lines must be a list' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e
              where nullif(e ->> 'key', '') is null
                 or not exists (select 1 from inventory_items i
                                 where i.id = nullif(e ->> 'item_id', '')::uuid and i.location_id = p_location_id)) then
    raise exception 'stock_receive: a line has no key or names a stock item that is not at this venue' using errcode = '22023';
  end if;
  v_doc := case when p_source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_source_id::uuid end;

  -- LOCK ORDER 20261019b: every item of this receipt, in id order, before the first post.
  perform 1 from inventory_items
   where location_id = p_location_id
     and id in (select (e ->> 'item_id')::uuid from jsonb_array_elements(p_lines) e)
   order by id
   for no key update;

  for v_line in
    select e from jsonb_array_elements(p_lines) e order by (e ->> 'item_id')::uuid, (e ->> 'key')
  loop
    v_qty := round(coalesce(nullif(v_line ->> 'qty_base', '')::numeric, 0), 4);
    if v_qty <= 0 then continue; end if;
    select id, on_hand, current_cost, cost_method into v_item from inventory_items
     where id = (v_line ->> 'item_id')::uuid and location_id = p_location_id;
    v_cost := nullif(v_line ->> 'unit_cost', '')::numeric;
    if v_cost is not null and v_cost <= 0 then v_cost := null; end if;
    v_before := coalesce(v_item.on_hand, 0);
    v_res := public._post_stock_movement(p_location_id, v_item.id, v_qty, 'PURCHASE_RECEIPT',
      coalesce(v_cost, v_item.current_cost, 0), p_source_type, p_source_id, v_line ->> 'key',
      null, null, p_notes, p_area_id);
    if coalesce((v_res ->> 'duplicate')::boolean, false) then
      v_dupes := v_dupes + 1;
      v_out := v_out || jsonb_build_array(jsonb_build_object('key', v_line ->> 'key', 'item_id', v_item.id, 'duplicate', true));
      continue;
    end if;
    v_posted := v_posted + 1;
    v_new := null;
    if v_cost is not null then
      if coalesce(v_item.cost_method, 'MOVING_AVG') = 'LAST_COST' or v_before <= 0
         or v_item.current_cost is null or v_item.current_cost <= 0 then
        v_new := v_cost;
        v_reset := true;
      else
        v_new := (v_before * v_item.current_cost + v_qty * v_cost) / (v_before + v_qty);
        v_reset := false;
      end if;
      v_new := round(v_new, 8);
      select sp.id into v_sp from supplier_products sp
       where sp.id = nullif(v_line ->> 'supplier_product_id', '')::uuid and sp.location_id = p_location_id;
      update item_cost_history set effective_to = now()
       where location_id = p_location_id and inventory_item_id = v_item.id and effective_to is null;
      insert into item_cost_history (location_id, inventory_item_id, supplier_product_id, pack_price, pack_label,
          base_unit_cost, moving_avg_cost, source, source_doc_id, effective_from)
        values (p_location_id, v_item.id, v_sp, round(nullif(v_line ->> 'pack_price', '')::numeric, 4),
          nullif(left(coalesce(v_line ->> 'pack_label', ''), 120), ''), v_new, v_new,
          case when p_source_type = 'purchase_order' then 'PO_RECEIPT' else 'INVOICE' end, v_doc, now());
      update inventory_items set current_cost = v_new, updated_at = now()
       where id = v_item.id and location_id = p_location_id;
      -- REVALUE 20261021a: only where the cost resets (last cost, stock at or below zero, or no cost
      -- before), the stock already held moves from the old cost to the new one, so the ledger value
      -- stays equal to on hand times cost. The moving average branch already agrees, so it writes none.
      if v_reset then
        perform public._stock_revalue(p_location_id, v_item.id, v_before, v_item.current_cost, v_new,
          p_source_type, 'revalue:' || (v_line ->> 'key'), p_source_id);
      end if;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('key', v_line ->> 'key', 'item_id', v_item.id,
      'duplicate', false, 'on_hand', v_res -> 'on_hand', 'cost', v_new));
  end loop;
  return jsonb_build_object('ok', true, 'posted', v_posted, 'duplicates', v_dupes, 'lines', v_out);
end $function$;

-- approve_stock_count: the live body with the REVALUE call added where an opening count sets a
-- cost that was null or zero. Everything else is the live text.
CREATE OR REPLACE FUNCTION public.approve_stock_count(p_count_id uuid, p_approved_by_name text DEFAULT NULL::text, p_approval_note text DEFAULT NULL::text, p_costs jsonb DEFAULT NULL::jsonb, p_preview boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_c record;
  v_l record;
  v_now timestamptz := now();
  v_delta numeric;
  v_expected numeric;
  v_cost numeric;
  v_type text;
  v_key text;
  v_res jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_needs jsonb := '[]'::jsonb;
  v_counted integer := 0;
  v_uncounted integer := 0;
  v_total integer := 0;
  v_posted integer := 0;
  v_opening integer := 0;
  v_var numeric := 0;
  v_open_val numeric := 0;
  v_given numeric;
  v_loc uuid;
  v_superseded integer := 0;
  v_held numeric;
  v_old_cost numeric;
begin
  -- Who is asking comes first: nothing is locked (and nothing says whether the count exists) for a
  -- caller who cannot approve at its venue.
  select c.location_id into v_loc from stock_counts c where c.id = p_count_id;
  if v_loc is null or not public.stock_office_reaches(v_loc) then
    raise exception 'approve_stock_count: that count was not found, or this login cannot approve counts at its venue' using errcode = '42501';
  end if;
  if p_preview then
    select * into v_c from stock_counts where id = p_count_id;
  else
    select * into v_c from stock_counts where id = p_count_id for no key update;
  end if;
  if not found or v_c.location_id is distinct from v_loc then
    raise exception 'approve_stock_count: that count was not found, or this login cannot approve counts at its venue' using errcode = '42501';
  end if;
  if v_c.status = 'APPROVED' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', 'APPROVED');
  end if;
  if v_c.status = 'CANCELLED' then
    return jsonb_build_object('ok', false, 'error', 'This count was cancelled, so it cannot be approved');
  end if;
  select count(*) filter (where l.counted_qty is not null), count(*) filter (where l.counted_qty is null)
    into v_counted, v_uncounted
    from stock_count_lines l where l.count_id = p_count_id and l.location_id = v_c.location_id;
  if v_counted = 0 then
    return jsonb_build_object('ok', false, 'error', 'Nothing has been counted on this sheet yet');
  end if;

  if not p_preview then
    -- LOCK ORDER 20261019b: every counted item, in id order, before anything is read for the plan.
    perform 1 from inventory_items
     where location_id = v_c.location_id
       and id in (select l.inventory_item_id from stock_count_lines l
                   where l.count_id = p_count_id and l.location_id = v_c.location_id and l.counted_qty is not null)
     order by id
     for no key update;
  end if;

  for v_l in
    with l as (
      select l.id, l.inventory_item_id, l.area_id, l.counted_qty, l.counted_at,
             coalesce(l.counted_at, v_now) as at, l.unit_cost as line_cost
        from stock_count_lines l
       where l.count_id = p_count_id and l.location_id = v_c.location_id and l.counted_qty is not null
    )
    select l.*, i.name, i.current_cost,
           (case when l.area_id is null then coalesce(i.on_hand, 0)
                 else coalesce((select s.on_hand from inventory_item_area_stock s
                                 where s.inventory_item_id = l.inventory_item_id and s.area_id = l.area_id), 0) end)
           - coalesce((select sum(m.qty_base) from stock_movements m
                        where m.location_id = v_c.location_id and m.inventory_item_id = l.inventory_item_id
                          and m.occurred_at > l.at
                          and (l.area_id is null or m.area_id = l.area_id)), 0) as expected,
           (not exists (select 1 from stock_movements m
                         where m.location_id = v_c.location_id and m.inventory_item_id = l.inventory_item_id
                           and m.movement_type in ('OPENING_BALANCE', 'STOCK_COUNT_ADJ'))
            and not exists (select 1 from stock_count_lines o join stock_counts oc on oc.id = o.count_id
                             where o.location_id = v_c.location_id and o.inventory_item_id = l.inventory_item_id
                               and o.count_id <> p_count_id and o.counted_qty is not null and oc.status = 'APPROVED')) as opening,
           -- SUPERSEDED 20261019b: a count of this item (this area, or the whole item) approved
           -- already and counted LATER than this line is the truth now; this older line posts nothing.
           exists (select 1 from stock_count_lines o join stock_counts oc on oc.id = o.count_id and upper(oc.status) = 'APPROVED'
                    where o.location_id = v_c.location_id and o.inventory_item_id = l.inventory_item_id
                      and o.count_id <> p_count_id and o.counted_qty is not null
                      and coalesce(o.counted_at, oc.approved_at) > l.at
                      and (o.area_id is null or l.area_id is null or o.area_id = l.area_id)) as superseded
      from l
      join inventory_items i on i.id = l.inventory_item_id and i.location_id = v_c.location_id
     order by l.inventory_item_id, l.area_id nulls first, l.id
  loop
    v_expected := round(v_l.expected, 4);
    v_delta := round(v_l.counted_qty - v_expected, 4);
    if v_l.superseded then
      v_delta := 0;
      v_superseded := v_superseded + 1;
    end if;
    v_cost := null;
    if v_l.opening then
      v_given := null;
      if p_costs is not null and jsonb_typeof(p_costs) = 'object' then
        v_given := nullif(p_costs ->> v_l.inventory_item_id::text, '')::numeric;
      end if;
      v_cost := coalesce(nullif(v_l.current_cost, 0), nullif(v_given, 0), nullif(v_l.line_cost, 0));
      if v_cost is not null and v_cost < 0 then v_cost := null; end if;
      if v_cost is null and v_delta <> 0 then
        v_needs := v_needs || jsonb_build_array(jsonb_build_object('item_id', v_l.inventory_item_id, 'name', v_l.name));
      end if;
      v_opening := v_opening + 1;
      v_open_val := v_open_val + v_delta * coalesce(v_cost, 0);
    else
      v_var := v_var + v_delta * coalesce(v_l.current_cost, 0);
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'line_id', v_l.id, 'item_id', v_l.inventory_item_id, 'area_id', v_l.area_id, 'counted', v_l.counted_qty,
      'expected', v_expected, 'delta', v_delta, 'opening', v_l.opening, 'cost', v_cost,
      'counted_at', v_l.counted_at, 'at', v_l.at, 'superseded', v_l.superseded));
  end loop;

  if jsonb_array_length(v_needs) > 0 then
    return jsonb_build_object('ok', false, 'code', 'needs_cost', 'needs_cost', v_needs,
      'error', 'Enter a cost for the items counted for the first time that have no price yet.',
      'opening', v_opening, 'lines', case when p_preview then v_lines else '[]'::jsonb end);
  end if;
  if p_preview then
    return jsonb_build_object('ok', true, 'preview', true, 'lines', v_lines, 'opening', v_opening,
      'variance_value', round(v_var, 2), 'opening_value', round(v_open_val, 2), 'uncounted', v_uncounted,
      'counted', v_counted, 'superseded', v_superseded);
  end if;

  for v_l in
    select (x ->> 'line_id')::uuid as line_id, (x ->> 'item_id')::uuid as item_id, nullif(x ->> 'area_id', '')::uuid as area_id,
           (x ->> 'expected')::numeric as expected, (x ->> 'delta')::numeric as delta, (x ->> 'opening')::boolean as opening,
           nullif(x ->> 'cost', '')::numeric as cost, (x ->> 'at')::timestamptz as at
      from jsonb_array_elements(v_lines) x
  loop
    -- REVALUE 20261021a: the stock held before this count and the cost before it, read before this
    -- line posts (an opening line with a cost may set the cost below).
    if v_l.opening and v_l.cost is not null then
      select coalesce(on_hand, 0), current_cost into v_held, v_old_cost from inventory_items
       where id = v_l.item_id and location_id = v_c.location_id;
    end if;
    if v_l.delta <> 0 then
      v_total := v_total + 1;
      v_type := case when v_l.opening then 'OPENING_BALANCE' else 'STOCK_COUNT_ADJ' end;
      v_key := case when v_l.area_id is null then 'count:' || p_count_id::text || ':' || v_l.item_id::text
                    else 'count:' || p_count_id::text || ':' || v_l.item_id::text || ':' || v_l.area_id::text end;
      v_res := public._post_stock_movement(v_c.location_id, v_l.item_id, v_l.delta, v_type,
        case when v_l.opening then v_l.cost else null end, 'stock_count', p_count_id::text, v_key,
        v_l.at, null, case when v_l.opening then 'Opening count' else 'Stock count' end, v_l.area_id);
      if not coalesce((v_res ->> 'duplicate')::boolean, false) then v_posted := v_posted + 1; end if;
    end if;
    -- An item with no cost takes the cost of its opening count (once, never over a known cost).
    if v_l.opening and v_l.cost is not null then
      update inventory_items set current_cost = round(v_l.cost, 8), updated_at = now()
       where id = v_l.item_id and location_id = v_c.location_id and (current_cost is null or current_cost <= 0);
      if found then
        update item_cost_history set effective_to = now()
         where location_id = v_c.location_id and inventory_item_id = v_l.item_id and effective_to is null;
        insert into item_cost_history (location_id, inventory_item_id, base_unit_cost, moving_avg_cost, source, source_doc_id, effective_from)
          values (v_c.location_id, v_l.item_id, round(v_l.cost, 8), round(v_l.cost, 8), 'MANUAL', p_count_id, now());
        -- REVALUE 20261021a: the cost was null or zero, so the stock already held is valued at the new cost.
        perform public._stock_revalue(v_c.location_id, v_l.item_id, v_held, v_old_cost, round(v_l.cost, 8),
          'stock_count', 'revalue:count:' || p_count_id::text || ':' || v_l.item_id::text, p_count_id::text);
      end if;
    end if;
    update stock_count_lines
       set expected_qty = v_l.expected, variance_qty = v_l.delta, is_opening = v_l.opening,
           unit_cost = coalesce(v_l.cost, unit_cost)
     where id = v_l.line_id;
  end loop;

  update stock_counts
     set status = 'APPROVED', approved_at = now(), updated_at = now(),
         approved_by_name = coalesce(nullif(btrim(coalesce(p_approved_by_name, '')), ''), approved_by_name),
         approval_note = coalesce(nullif(btrim(coalesce(p_approval_note, '')), ''), approval_note),
         variance_value = round(v_var, 2), opening_value = round(v_open_val, 2)
   where id = p_count_id;

  return jsonb_build_object('ok', true, 'posted', v_posted, 'total', v_total, 'opening', v_opening,
    'variance_value', round(v_var, 2), 'opening_value', round(v_open_val, 2), 'uncounted', v_uncounted,
    'superseded', v_superseded);
end $function$;

-- post_stock_transfer_leg: the live body with the REVALUE call added in the receiving leg's reset
-- branch. Everything else is the live text.
CREATE OR REPLACE FUNCTION public.post_stock_transfer_leg(p_transfer_id uuid, p_leg text, p_by_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_t record;
  v_l record;
  v_mine boolean;
  v_lines integer := 0;
  v_short_lines integer := 0;
  v_cost numeric;
  v_qty numeric;
  v_area uuid;
  v_item record;
  v_before numeric;
  v_new_avg numeric;
  v_res jsonb;
  v_factor numeric;
  v_from_unit text;
  v_to_unit text;
  v_sent_recv numeric;
  v_short numeric;
  v_bad text;
  v_out_id uuid;
  v_reset boolean;
begin
  if p_leg not in ('out', 'in', 'both', 'cancel') then
    raise exception 'post_stock_transfer_leg: leg must be out, in, both or cancel (got %)', coalesce(p_leg, 'null');
  end if;

  select * into v_t from stock_transfers where id = p_transfer_id for no key update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Transfer not found');
  end if;

  -- Who is asking (FENCE 20261018a): the same rule as post_stock_movement. The receiving leg
  -- belongs to the receiving venue; every other leg to the sending venue.
  if p_leg = 'in' then
    v_mine := v_t.to_location_id is not null and public.stock_caller_reaches(v_t.to_location_id);
  else
    v_mine := public.stock_caller_reaches(v_t.location_id);
  end if;
  if not coalesce(v_mine, false) then
    return jsonb_build_object('ok', false, 'error', 'This transfer belongs to a venue you cannot open');
  end if;

  -- Already past this step: nothing moves twice.
  if (p_leg in ('out', 'both') and v_t.status <> 'DRAFT') or (p_leg = 'in' and v_t.status <> 'SENT')
     or (p_leg = 'cancel' and v_t.status = 'CANCELLED') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_t.status);
  end if;
  if p_leg = 'cancel' and v_t.status not in ('DRAFT', 'SENT') then
    return jsonb_build_object('ok', false, 'error', 'A transfer that is ' || lower(v_t.status) || ' cannot be cancelled: move the stock back with a new transfer');
  end if;

  -- FENCE 20261018a: stock moves between venues of ONE company only. A cancel only puts the
  -- stock back at the sender, so it is never refused for this.
  if p_leg in ('out', 'in') and v_t.to_location_id is not null and v_t.to_location_id <> v_t.location_id
     and not exists (select 1 from locations a join locations b on b.org_id = a.org_id
                      where a.id = v_t.location_id and b.id = v_t.to_location_id and a.org_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'Stock can only move between venues of the same company');
  end if;
  -- FENCE 20261018a: the sender's own lines and areas, checked before anything posts (a return
  -- from plpgsql does not roll back, so a refusal half way through would leave a half leg).
  if (p_leg in ('out', 'both') or (p_leg = 'cancel' and v_t.status = 'SENT'))
     and v_t.from_area_id is not null
     and not exists (select 1 from storage_areas a where a.id = v_t.from_area_id and a.location_id = v_t.location_id) then
    return jsonb_build_object('ok', false, 'error', 'The area this transfer leaves from is not at the sending venue');
  end if;
  if p_leg = 'both' and v_t.to_area_id is not null
     and not exists (select 1 from storage_areas a where a.id = v_t.to_area_id and a.location_id = v_t.location_id) then
    return jsonb_build_object('ok', false, 'error', 'The area this transfer goes to is not at this venue');
  end if;
  if (p_leg in ('out', 'both') or (p_leg = 'cancel' and v_t.status = 'SENT'))
     and exists (select 1 from stock_transfer_lines l
                  where l.transfer_id = p_transfer_id and not l.dropped and coalesce(l.qty_base, 0) > 0
                    and not exists (select 1 from inventory_items i where i.id = l.inventory_item_id and i.location_id = v_t.location_id)) then
    return jsonb_build_object('ok', false, 'error', 'A line names a stock item that is not at the sending venue');
  end if;

  if p_leg = 'cancel' then
    -- A SENT transfer has already posted TRANSFER_OUT at the sender: put every line back where it came from.
    if v_t.status = 'SENT' then
      -- LOCK ORDER 20261019b
      perform 1 from inventory_items
       where location_id = v_t.location_id
         and id in (select l.inventory_item_id from stock_transfer_lines l where l.transfer_id = p_transfer_id and not l.dropped)
       order by id for no key update;
      for v_l in
        select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by case when p_leg = 'in' then to_inventory_item_id else inventory_item_id end, sort_order, id
      loop
        if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
        perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_l.qty_base, 'TRANSFER_IN',
          coalesce(v_l.unit_cost, (select current_cost from inventory_items where id = v_l.inventory_item_id), 0),
          'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':cancel',
          now(), null, 'Transfer ' || coalesce(v_t.reference, '') || ' cancelled, stock back', v_t.from_area_id);
        v_lines := v_lines + 1;
      end loop;
    end if;
    update stock_transfers set status = 'CANCELLED', cancelled_by_name = p_by_name, cancelled_at = now(), updated_at = now()
      where id = p_transfer_id;
    return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'CANCELLED', 'lines', v_lines);
  end if;
  if p_leg = 'both' and v_t.to_location_id is not null and v_t.to_location_id <> v_t.location_id then
    return jsonb_build_object('ok', false, 'error', 'A transfer to another venue is sent, then received there');
  end if;
  if p_leg = 'in' and (v_t.to_location_id is null or v_t.to_location_id = v_t.location_id) then
    return jsonb_build_object('ok', false, 'error', 'A transfer within one venue has no receiving step');
  end if;

  if p_leg in ('out', 'both') then
    -- LOCK ORDER 20261019b
    perform 1 from inventory_items
     where location_id = v_t.location_id
       and id in (select l.inventory_item_id from stock_transfer_lines l where l.transfer_id = p_transfer_id and not l.dropped)
     order by id for no key update;
    for v_l in
      select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by case when p_leg = 'in' then to_inventory_item_id else inventory_item_id end, sort_order, id
    loop
      if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
      v_cost := coalesce((select current_cost from inventory_items where id = v_l.inventory_item_id), 0);
      update stock_transfer_lines set unit_cost = v_cost,
             base_unit = coalesce(base_unit, (select i.base_unit from inventory_items i where i.id = v_l.inventory_item_id))
       where id = v_l.id;
      perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, -v_l.qty_base, 'TRANSFER_OUT',
        v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':out',
        now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_t.from_area_id);
      if p_leg = 'both' then
        perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_l.qty_base, 'TRANSFER_IN',
          v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':in',
          now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_t.to_area_id);
      end if;
      v_lines := v_lines + 1;
    end loop;
    if v_lines = 0 then
      return jsonb_build_object('ok', false, 'error', 'This transfer has no lines with a quantity');
    end if;
    if p_leg = 'both' then
      update stock_transfers set status = 'DONE', sent_by_name = p_by_name, sent_at = now(),
        received_by_name = p_by_name, received_at = now(), updated_at = now() where id = p_transfer_id;
      return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'DONE', 'lines', v_lines);
    end if;
    update stock_transfers set status = 'SENT', sent_by_name = p_by_name, sent_at = now(), updated_at = now()
      where id = p_transfer_id;
    return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'SENT', 'lines', v_lines);
  end if;

  -- p_leg = 'in'
  if exists (select 1 from stock_transfer_lines where transfer_id = p_transfer_id and not dropped and to_inventory_item_id is null) then
    return jsonb_build_object('ok', false, 'error', 'Every line must be matched to one of your items or dropped before you receive');
  end if;
  -- Every matched item must be at the receiving venue BEFORE anything posts: a return from
  -- plpgsql does not roll back, so a refusal half way through the loop would leave the lines
  -- already posted at the receiver with the head still SENT (16 Oct review).
  if exists (select 1 from stock_transfer_lines l
              where l.transfer_id = p_transfer_id and not l.dropped
                and not exists (select 1 from inventory_items i where i.id = l.to_inventory_item_id and i.location_id = v_t.to_location_id)) then
    return jsonb_build_object('ok', false, 'error', 'A matched item is not at the receiving venue');
  end if;
  -- UNITS 20261019b: every matched line must convert from the sender's unit to the receiver's.
  select string_agg(coalesce(l.name_snapshot, 'A line') || ' (' || coalesce(l.base_unit, s.base_unit) || ' to ' || r.base_unit || ')', ', ')
    into v_bad
    from stock_transfer_lines l
    join inventory_items s on s.id = l.inventory_item_id
    join inventory_items r on r.id = l.to_inventory_item_id
   where l.transfer_id = p_transfer_id and not l.dropped
     and public.stock_convert_qty(1, coalesce(l.base_unit, s.base_unit), r.base_unit, array[l.to_inventory_item_id, l.inventory_item_id]) is null;
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'error', 'These units cannot be converted, so nothing was received: ' || v_bad || '. Add a unit bridge on your item, or drop the line.');
  end if;

  -- LOCK ORDER 20261019b: both venues' items, one id order.
  perform 1 from inventory_items
   where id in (select l.inventory_item_id from stock_transfer_lines l where l.transfer_id = p_transfer_id
                union
                select l.to_inventory_item_id from stock_transfer_lines l where l.transfer_id = p_transfer_id and not l.dropped)
   order by id for no key update;

  -- Where it lands: the chosen area (only when it is a live area of the receiving venue), else
  -- the receiving area, else (null) the item's use area.
  v_area := v_t.to_area_id;
  if v_area is not null and not exists (select 1 from storage_areas a
      where a.id = v_area and a.location_id = v_t.to_location_id and a.archived_at is null) then
    v_area := null;
  end if;
  if v_area is null then
    select a.id into v_area from storage_areas a
      where a.location_id = v_t.to_location_id and a.is_receiving and a.archived_at is null limit 1;
  end if;
  for v_l in
    select * from stock_transfer_lines where transfer_id = p_transfer_id order by case when p_leg = 'in' then to_inventory_item_id else inventory_item_id end, sort_order, id
  loop
    if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
    v_cost := coalesce(v_l.unit_cost, (select current_cost from inventory_items where id = v_l.inventory_item_id), 0);
    v_short := 0;
    if v_l.dropped then
      v_short := v_l.qty_base;
    else
      select id, on_hand, current_cost, cost_method, base_unit into v_item from inventory_items
        where id = v_l.to_inventory_item_id and location_id = v_t.to_location_id;
      if not found then
        -- checked before the loop; a raise rolls the whole leg back
        raise exception 'post_stock_transfer_leg: matched item % is not at venue %', v_l.to_inventory_item_id, v_t.to_location_id;
      end if;
      v_from_unit := coalesce(v_l.base_unit, (select i.base_unit from inventory_items i where i.id = v_l.inventory_item_id));
      v_to_unit := v_item.base_unit;
      v_factor := public.stock_convert_qty(1, v_from_unit, v_to_unit, array[v_l.to_inventory_item_id, v_l.inventory_item_id]);
      if v_factor is null or v_factor <= 0 then
        raise exception 'post_stock_transfer_leg: % cannot be converted to %', v_from_unit, v_to_unit;
      end if;
      -- What arrived, in the receiver's unit, never more than was sent: rounded DOWN to the 4
      -- decimals the receiver holds (rounding to the nearest could land more than left the sender).
      v_qty := trunc(least(coalesce(v_l.qty_received_base, v_l.qty_base * v_factor), v_l.qty_base * v_factor), 4);
      if v_qty < 0 then v_qty := 0; end if;
      v_sent_recv := v_qty / v_factor;
      -- What did not arrive, in the sender's unit. A remainder under half a 4th decimal step of the
      -- coarser of the two units is rounding, not a loss: no Short on transfer for it.
      v_short := greatest(0, v_l.qty_base - v_sent_recv);
      if v_short < 0.00005 * greatest(1, 1 / v_factor) then
        v_short := 0;
      else
        v_short := round(v_short, 4);
      end if;
      if v_qty > 0 then
        v_before := coalesce(v_item.on_hand, 0);
        v_res := public._post_stock_movement(v_t.to_location_id, v_l.to_inventory_item_id, v_qty, 'TRANSFER_IN',
          v_cost / v_factor, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':in',
          now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_area);
        -- The receiver's cost moves the way a delivery moves it: moving average, or the last cost
        -- replaces; stock at or below zero, or an unknown cost, takes the transfer cost. A zero cost
        -- never re-costs the item.
        if coalesce((v_res ->> 'duplicate')::boolean, false) = false and v_cost > 0 then
          if coalesce(v_item.cost_method, 'MOVING_AVG') = 'LAST_COST' or v_before <= 0
             or v_item.current_cost is null or v_item.current_cost <= 0 then
            v_new_avg := v_cost / v_factor;
            v_reset := true;
          else
            v_new_avg := (v_before * v_item.current_cost + v_qty * (v_cost / v_factor)) / (v_before + v_qty);
            v_reset := false;
          end if;
          v_new_avg := round(v_new_avg, 8);
          update item_cost_history set effective_to = now()
            where location_id = v_t.to_location_id and inventory_item_id = v_l.to_inventory_item_id and effective_to is null;
          insert into item_cost_history (location_id, inventory_item_id, base_unit_cost, moving_avg_cost, source, source_doc_id, effective_from)
            values (v_t.to_location_id, v_l.to_inventory_item_id, v_new_avg, v_new_avg, 'TRANSFER', v_t.id, now());
          update inventory_items set current_cost = v_new_avg, updated_at = now()
            where id = v_l.to_inventory_item_id and location_id = v_t.to_location_id;
          -- REVALUE 20261021a: in the reset branch only, the receiver's stock already held moves to the new cost.
          if v_reset then
            perform public._stock_revalue(v_t.to_location_id, v_l.to_inventory_item_id, v_before, v_item.current_cost, v_new_avg,
              'stock_transfer', 'revalue:transfer:' || v_l.id::text, p_transfer_id::text);
          end if;
        end if;
      end if;
      update stock_transfer_lines set qty_received_base = v_qty, to_base_unit = v_to_unit,
             to_unit_cost = round(v_cost / v_factor, 8)
       where id = v_l.id;
      v_lines := v_lines + 1;
    end if;

    -- SHORT ON TRANSFER 20261019b: booked at the sender (only for stock that did leave it).
    v_out_id := null;
    if v_short > 0 then
      select m.id into v_out_id from stock_movements m
       where m.location_id = v_t.location_id
         and m.idempotency_key = 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':out';
      if v_out_id is null then v_short := 0; end if;
    end if;
    if v_short > 0 then
      v_res := public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_short, 'TRANSFER_OUT',
        v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':short-back',
        now(), null, 'Transfer ' || coalesce(v_t.reference, '') || ': not received, back on the books to be written off', v_t.from_area_id);
      if v_res ->> 'id' is not null then
        update stock_movements set reversal_of = v_out_id where id = (v_res ->> 'id')::uuid;
      end if;
      perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, -v_short, 'WASTE',
        v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':short',
        now(), null, 'Short on transfer ' || coalesce(v_t.reference, ''), v_t.from_area_id);
      insert into waste_events (location_id, inventory_item_id, item_name, qty, unit, qty_base, reason, note, cost_value, source, occurred_at)
        values (v_t.location_id, v_l.inventory_item_id,
          coalesce(v_l.name_snapshot, (select i.name from inventory_items i where i.id = v_l.inventory_item_id)),
          v_short, coalesce(v_l.base_unit, 'each'), v_short, 'Short on transfer',
          'Transfer ' || coalesce(v_t.reference, '') || case when v_l.dropped then ': line dropped at the receiving venue'
            else ': sent ' || round(v_l.qty_base, 4)::text || ', received ' || round(v_l.qty_base - v_short, 4)::text end,
          round(v_short * v_cost, 2), 'transfer', now());
      update stock_transfer_lines set short_qty_base = v_short where id = v_l.id;
      v_short_lines := v_short_lines + 1;
    end if;
  end loop;
  update stock_transfers set status = 'RECEIVED', received_by_name = p_by_name, received_at = now(), updated_at = now()
    where id = p_transfer_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'RECEIVED', 'lines', v_lines, 'short_lines', v_short_lines);
end $function$;

-- ============================================================================
-- STEP 11b. The cost rule: the site override, else the company rule, else price list.
-- ============================================================================
-- No caller check here: the writer runs for sites the caller may not reach. Owner only.
create or replace function public.stock_co__cost_rule_of(p_location uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select ss.cost_rule_override from stock_co_site_settings ss where ss.location_id = p_location),
    (select s.cost_rule from stock_co_settings s join locations l on l.org_id = s.org_id where l.id = p_location),
    'price_list');
$fn$;

-- stock_cost_rule: the live header and caller rule, now reading the company rule and the site override
-- (stock_co_site_settings, written only by definer functions) instead of stock_site_settings.
CREATE OR REPLACE FUNCTION public.stock_cost_rule(p_location_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- The venue's own rule only for a caller that reaches it; anyone else gets the default.
  -- 20261021a: the rule is the site override, else the company rule, else price list.
  select case when public.stock_caller_reaches(p_location_id)
              then public.stock_co__cost_rule_of(p_location_id)
              else 'price_list' end;
$function$;

-- ============================================================================
-- STEP 12. THE WRITER: company records to each site's own rows.
-- ============================================================================
-- The site's own tax_rates row for a VAT rate value: the row it has when that is at this site with the
-- same rate; else the live row at this site with that rate (default first, then by name); null when
-- there is no rate or no match. Owner only.
create or replace function public.stock_co__rate_id_for(p_loc uuid, p_rate numeric, p_keep uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
           when p_rate is null then null::uuid
           when p_keep is not null
                and exists (select 1 from tax_rates r where r.id = p_keep and r.location_id = p_loc and r.rate = p_rate) then p_keep
           else (select r.id from tax_rates r
                  where r.location_id = p_loc and coalesce(r.active, true) and r.rate = p_rate
                  order by r.is_default desc nulls last, r.name, r.id
                  limit 1)
         end;
$fn$;

-- A VAT rate row as words for the drift check ("20%"); null when there is none. Owner only.
create or replace function public.stock_co__rate_words(p_rate_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select trim(trailing '.' from trim(trailing '0' from to_char(r.rate * 100, 'FM990.000'))) || '%'
    from tax_rates r where r.id = p_rate_id;
$fn$;

-- What one site supplier pack costs per base unit of its item: net of VAT only when the price
-- includes VAT, through the item's units and bridges. Null when it cannot be worked out or is not
-- above 0. The same maths as the Back Office price save (data.js recomputeItemCost). Owner only.
create or replace function public.stock_co__sp_unit_cost(p_sp uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case when q.qb > 0 and n.net > 0 then n.net / q.qb end
    from supplier_products sp
    join inventory_items i on i.id = sp.inventory_item_id and i.location_id = sp.location_id
    cross join lateral (select case when sp.price_includes_tax
                                    then sp.pack_price / (1 + coalesce((select tr.rate from tax_rates tr
                                                                         where tr.id = coalesce(sp.purchase_tax_rate_id, i.purchase_tax_rate_id)), 0))
                                    else sp.pack_price end as net) n
    cross join lateral (select public.stock_convert_qty(sp.pack_qty * sp.inner_qty, sp.inner_unit, i.base_unit, array[i.id]) as qb) q
   where sp.id = p_sp;
$fn$;

-- The company cost step at one site for the given site items (inventory_items ids). The preferred live
-- supplier pack, else the cheapest; net of VAT only when the price includes it; per base unit; never 0.
-- The site's cost rule decides (price list: the price sets the cost; deliveries: only for an item with
-- no cost yet or never received). With p_write: closes the open cost history row, opens a 'COMPANY'
-- one, sets current_cost and writes a REVALUE for the stock held. p_log_id keys the REVALUE; when it
-- is null each changed item gets its own change log row (entity item_site, field current_cost) and that
-- id keys it. Owner only.
create or replace function public.stock_co__cost_step(p_location uuid, p_item_ids uuid[], p_log_id bigint, p_write boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_rule text := public.stock_co__cost_rule_of(p_location);
  v_org uuid;
  v_src text := case when auth.uid() is null then 'queue' else 'save' end;
  v_items jsonb := '[]'::jsonb;
  v_n integer := 0;
  v_log bigint;
  v_rev numeric;
  r record;
begin
  if p_location is null or p_item_ids is null or cardinality(p_item_ids) = 0 then
    return jsonb_build_object('changed', 0, 'items', '[]'::jsonb);
  end if;
  select l.org_id into v_org from locations l where l.id = p_location;
  if p_write then
    perform 1 from inventory_items i
     where i.location_id = p_location and i.id = any(p_item_ids)
     order by i.id
     for no key update;
  end if;
  for r in
    select x.item, x.company_ref, x.prev, x.on_hand, x.sp_id, x.net, round(x.net / x.qb, 8) as cost
      from (select distinct on (i.id) i.id as item, i.company_ref, i.current_cost as prev, coalesce(i.on_hand, 0) as on_hand,
                   sp.id as sp_id, n.net, q.qb
              from inventory_items i
              join supplier_products sp on sp.inventory_item_id = i.id and sp.location_id = p_location and sp.archived_at is null
              cross join lateral (select case when sp.price_includes_tax
                                              then sp.pack_price / (1 + coalesce((select tr.rate from tax_rates tr
                                                                                   where tr.id = coalesce(sp.purchase_tax_rate_id, i.purchase_tax_rate_id)), 0))
                                              else sp.pack_price end as net) n
              cross join lateral (select public.stock_convert_qty(sp.pack_qty * sp.inner_qty, sp.inner_unit, i.base_unit, array[i.id]) as qb) q
             where i.location_id = p_location and i.id = any(p_item_ids)
               and q.qb > 0 and n.net > 0 and round(n.net / q.qb, 8) > 0
             order by i.id, sp.is_preferred desc, n.net / q.qb, sp.id) x
     order by x.item
  loop
    continue when r.prev is not distinct from r.cost;
    if v_rule = 'deliveries' and coalesce(r.prev, 0) > 0
       and exists (select 1 from stock_movements m where m.location_id = p_location and m.inventory_item_id = r.item
                    and m.movement_type = 'PURCHASE_RECEIPT') then
      continue;
    end if;
    v_rev := 0;
    if p_write then
      v_log := p_log_id;
      if v_log is null then
        v_log := public.stock_co__log(v_org, p_location, 'item_site', coalesce(r.company_ref, r.item), 'current_cost',
                                      to_jsonb(r.prev), to_jsonb(r.cost), v_src);
      end if;
      update item_cost_history h set effective_to = now()
       where h.location_id = p_location and h.inventory_item_id = r.item and h.effective_to is null;
      insert into item_cost_history (location_id, inventory_item_id, supplier_product_id, pack_price, base_unit_cost, source, effective_from, created_by)
      values (p_location, r.item, r.sp_id, round(r.net, 4), r.cost, 'COMPANY', now(), auth.uid());
      update inventory_items i set current_cost = r.cost, updated_at = now()
       where i.id = r.item and i.location_id = p_location;
      v_rev := public._stock_revalue(p_location, r.item, r.on_hand, r.prev, r.cost, 'company_cost',
                                     'revalue:company:' || v_log::text || ':' || r.item::text, v_log::text);
    end if;
    v_n := v_n + 1;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', r.item, 'before', r.prev, 'after', r.cost, 'revalue', v_rev));
  end loop;
  return jsonb_build_object('changed', v_n, 'items', v_items);
end
$fn$;

-- The cost of one item per base unit at one site, rolled up the way the Back Office does it
-- (costing.js componentUnitCost): a MADE item with a live recipe that outputs it is its lines (to base
-- units through stock_qty_to_base, over the usable share, at their own cost), plus wastage, over the
-- yield; anything else is its current cost (no cost counts as 0, as the browser does). Null when a
-- line cannot be worked out, a recipe loops, or the yield is not above 0. Owner only.
create or replace function public.stock_co__made_cost(p_loc uuid, p_item uuid, p_path uuid[] default '{}'::uuid[])
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_item record;
  v_r record;
  v_l record;
  v_total numeric := 0;
  v_q numeric;
  v_u numeric;
  v_c numeric;
  v_y numeric;
begin
  if p_item is null or p_item = any(coalesce(p_path, '{}'::uuid[])) or coalesce(cardinality(p_path), 0) > 12 then
    return null;
  end if;
  select i.id, i.kind, i.base_unit, i.current_cost into v_item from inventory_items i where i.id = p_item and i.location_id = p_loc;
  if not found then
    return null;
  end if;
  select r.id, r.yield_qty, r.yield_unit, r.wastage_pct into v_r
    from recipes r
   where r.location_id = p_loc and r.output_item_id = p_item and r.archived_at is null
   order by (r.recipe_type in ('BATCH', 'PREP')) desc, r.updated_at desc, r.id
   limit 1;
  if v_item.kind is distinct from 'MADE' or v_r.id is null then
    return coalesce(v_item.current_cost, 0);
  end if;
  for v_l in
    select rl.component_item_id, rl.qty, rl.unit, rl.usable_pct from recipe_lines rl
     where rl.recipe_id = v_r.id and rl.location_id = p_loc
     order by rl.sort_order, rl.id
  loop
    if not exists (select 1 from inventory_items c where c.id = v_l.component_item_id and c.location_id = p_loc) then
      return null;
    end if;
    v_q := public.stock_qty_to_base(v_l.qty, v_l.unit, v_l.component_item_id);
    v_u := coalesce(v_l.usable_pct, 100) / 100.0;
    if v_q is null or v_u <= 0 then
      return null;
    end if;
    v_c := public.stock_co__made_cost(p_loc, v_l.component_item_id, coalesce(p_path, '{}'::uuid[]) || p_item);
    if v_c is null then
      return null;
    end if;
    v_total := v_total + (v_q / v_u) * v_c;
  end loop;
  v_total := v_total * (1 + coalesce(v_r.wastage_pct, 0) / 100.0);
  v_y := public.stock_qty_to_base(coalesce(v_r.yield_qty, 1), coalesce(nullif(v_r.yield_unit, ''), v_item.base_unit), p_item);
  if v_y is null or v_y <= 0 then
    return null;
  end if;
  return v_total / v_y;
end
$fn$;

-- Re rolls MADE item costs at one site (the server version of recipes.js recomputeMadeItemCost).
-- p_item_ids are site item ids (null = every live MADE item at the site). With p_write: cost history
-- 'RECIPE_ROLLUP', current_cost, and a REVALUE keyed 'revalue:rollup:<change log id>:<item>' (each
-- changed item gets its own change log row, entity item_site, field current_cost). Result
-- {"ok": true, "items": [{"item_id", "ok", "before", "after"}]}. Owner only.
create or replace function public.stock_co__recost(p_loc uuid, p_item_ids uuid[], p_write boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_src text := case when auth.uid() is null then 'queue' else 'save' end;
  v_items jsonb := '[]'::jsonb;
  v_cost numeric;
  v_log bigint;
  r record;
begin
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_org is null or (p_item_ids is not null and cardinality(p_item_ids) = 0) then
    return jsonb_build_object('ok', true, 'items', '[]'::jsonb);
  end if;
  if p_write then
    perform 1 from inventory_items i
     where i.location_id = p_loc and i.kind = 'MADE' and (p_item_ids is null or i.id = any(p_item_ids))
     order by i.id
     for no key update;
  end if;
  for r in
    select i.id, i.company_ref, i.current_cost as prev, coalesce(i.on_hand, 0) as on_hand
      from inventory_items i
     where i.location_id = p_loc and i.kind = 'MADE'
       and (p_item_ids is null or i.id = any(p_item_ids))
       and (p_item_ids is not null or i.archived_at is null)
     order by i.id
  loop
    v_cost := public.stock_co__made_cost(p_loc, r.id, '{}'::uuid[]);
    if v_cost is null then
      v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', r.id, 'ok', false, 'before', r.prev, 'after', null));
      continue;
    end if;
    v_cost := round(v_cost, 8);
    if r.prev is not distinct from v_cost then
      v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', r.id, 'ok', true, 'before', r.prev, 'after', v_cost));
      continue;
    end if;
    if p_write then
      v_log := public.stock_co__log(v_org, p_loc, 'item_site', coalesce(r.company_ref, r.id), 'current_cost',
                                    to_jsonb(r.prev), to_jsonb(v_cost), v_src);
      update item_cost_history h set effective_to = now()
       where h.location_id = p_loc and h.inventory_item_id = r.id and h.effective_to is null;
      insert into item_cost_history (location_id, inventory_item_id, base_unit_cost, source, effective_from, created_by)
      values (p_loc, r.id, v_cost, 'RECIPE_ROLLUP', now(), auth.uid());
      update inventory_items i set current_cost = v_cost, updated_at = now() where i.id = r.id and i.location_id = p_loc;
      perform public._stock_revalue(p_loc, r.id, r.on_hand, r.prev, v_cost, 'recipe_rollup',
                                    'revalue:rollup:' || v_log::text || ':' || r.id::text, v_log::text);
    end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', r.id, 'ok', true, 'before', r.prev, 'after', v_cost));
  end loop;
  return jsonb_build_object('ok', true, 'items', v_items);
end
$fn$;

-- ---------------------------------------------------------------------------
-- The plan: what each site row should hold. One set returning function per kind, so every step of
-- the writer reads the same plan with no temp tables. Filters are COMPANY ids; null means every row
-- of that kind at the site, an empty array means none. Owner only.
-- ---------------------------------------------------------------------------
-- Items: the company columns, the VAT rate by value, kind from the supply mode (bought PURCHASED,
-- batches or to order MADE), is_tracked from counted here, and archived when the company item is
-- archived or switched off here (never with stock: such a row is held).
create or replace function public.stock_co__plan_items(p_loc uuid, p_item_ids uuid[])
returns table (cid uuid, vid uuid, name text, category text, accounting_group text, base_unit text, allergens jsonb,
               sku text, barcode text, shelf_life_days integer, returns_to_shelf boolean, purchase_tax_rate_id uuid,
               kind text, is_tracked boolean, archived_at timestamptz, going_off boolean, held boolean, changed boolean,
               unit_change boolean, rate_change boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select i.id, t.id, i.name, i.category, i.accounting_group, i.base_unit, coalesce(i.allergens, '[]'::jsonb),
         i.sku, i.barcode, i.shelf_life_days, coalesce(i.returns_to_shelf, false), rr.rate_id,
         k.kind, s.counted_here, a.archived_at,
         (a.archived_at is not null and t.archived_at is null),
         (not al.alive and t.archived_at is null and coalesce(t.on_hand, 0) <> 0),
         ((t.company_ref, t.name, t.category, t.accounting_group, t.base_unit, t.allergens, t.sku, t.barcode,
           t.shelf_life_days, t.returns_to_shelf, t.purchase_tax_rate_id, t.kind, t.is_tracked, t.archived_at)
          is distinct from
          (i.id, i.name, i.category, i.accounting_group, i.base_unit, coalesce(i.allergens, '[]'::jsonb), i.sku, i.barcode,
           i.shelf_life_days, coalesce(i.returns_to_shelf, false), rr.rate_id, k.kind, s.counted_here, a.archived_at)),
         (t.base_unit is distinct from i.base_unit),
         (t.purchase_tax_rate_id is distinct from rr.rate_id)
    from stock_co_item_sites s
    join stock_co_items i on i.id = s.item_id
    join inventory_items t on t.id = s.site_item_id and t.location_id = p_loc
    cross join lateral (select public.stock_co__rate_id_for(p_loc, i.purchase_vat_rate, t.purchase_tax_rate_id) as rate_id) rr
    cross join lateral (select case s.supply_mode when 'bought' then 'PURCHASED' else 'MADE' end as kind) k
    cross join lateral (select (i.archived_at is null and s.on_here) as alive) al
    cross join lateral (select case when al.alive then null::timestamptz
                                    when t.archived_at is not null then t.archived_at
                                    when coalesce(t.on_hand, 0) = 0 then now()
                                    else null::timestamptz end as archived_at) a
   where s.location_id = p_loc
     and (p_item_ids is null or s.item_id = any(p_item_ids));
$fn$;

-- Suppliers: the company columns a site row carries (name, contact, phone, payment terms) and archived
-- with the company supplier. Email, account number, minimum order, delivery days, cut off and notes
-- are the site's own and never written here.
create or replace function public.stock_co__plan_suppliers(p_loc uuid, p_supplier_ids uuid[])
returns table (cid uuid, vid uuid, name text, contact_name text, phone text, payment_terms_days integer,
               archived_at timestamptz, changed boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select m.id, t.id, m.name, m.contact_name, m.phone, m.payment_terms_days, a.archived_at,
         ((t.company_ref, t.name, t.contact_name, t.phone, t.payment_terms_days, t.archived_at)
          is distinct from (m.id, m.name, m.contact_name, m.phone, m.payment_terms_days, a.archived_at))
    from stock_co_supplier_sites ss
    join stock_co_suppliers m on m.id = ss.supplier_id
    join suppliers t on t.id = ss.site_supplier_id and t.location_id = p_loc
    cross join lateral (select case when m.archived_at is null then null::timestamptz
                                    else coalesce(t.archived_at, now()) end as archived_at) a
   where ss.location_id = p_loc
     and (p_supplier_ids is null or ss.supplier_id = any(p_supplier_ids));
$fn$;

-- Packs of the items in scope that are set up here: the linked site pack, or (is_new) a live company
-- pack of a live item with no site pack here yet. parent_vid is the site id of the parent pack here
-- (null while the parent is new in this run).
create or replace function public.stock_co__plan_packs(p_loc uuid, p_item_ids uuid[])
returns table (cid uuid, vid uuid, is_new boolean, item_vid uuid, name text, qty_in_base numeric, parent_pack_id uuid,
               parent_vid uuid, is_count_default boolean, is_purchase_default boolean, archived_at timestamptz, changed boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.id, ps.site_pack_id, (ps.site_pack_id is null), s.site_item_id, p.name, p.qty_in_base, p.parent_pack_id,
         pv.parent_vid, p.is_count_default, p.is_purchase_default, a.archived_at,
         case when ps.site_pack_id is null then true
              else ((t.company_ref, t.inventory_item_id, t.name, t.qty_in_base, t.parent_format_id, t.is_count_default,
                     t.is_purchase_default, t.archived_at)
                    is distinct from (p.id, s.site_item_id, p.name, p.qty_in_base, pv.parent_vid, p.is_count_default,
                     p.is_purchase_default, a.archived_at)) end
    from stock_co_packs p
    join stock_co_items i on i.id = p.item_id
    join stock_co_item_sites s on s.item_id = p.item_id and s.location_id = p_loc
    left join stock_co_pack_sites ps on ps.pack_id = p.id and ps.location_id = p_loc
    left join item_packaging_formats t on t.id = ps.site_pack_id and t.location_id = p_loc
    cross join lateral (select (select pp.site_pack_id from stock_co_pack_sites pp
                                 where pp.pack_id = p.parent_pack_id and pp.location_id = p_loc) as parent_vid) pv
    cross join lateral (select case when p.archived_at is null then null::timestamptz
                                    else coalesce(t.archived_at, now()) end as archived_at) a
   where (p_item_ids is null or p.item_id = any(p_item_ids))
     and (ps.site_pack_id is not null or (p.archived_at is null and i.archived_at is null and s.on_here));
$fn$;

-- Unit bridges, the same way as packs, except an archived company bridge: archived_at not null on a
-- row with a site row (vid) means that site row is DELETED (review fix, 20 Oct). The live converters
-- (stock_qty_to_base for every sale on every channel, stock_convert_qty for transfers and the cost
-- step) read every bridge row of an item, archived or not, until the drainer release; an archived
-- site row would keep converting, and an older one would even beat a newer bridge for the same
-- units. Deleting is what Remove did before Drop 0. A restore adds new site rows (is_new).
create or replace function public.stock_co__plan_bridges(p_loc uuid, p_item_ids uuid[])
returns table (cid uuid, vid uuid, is_new boolean, item_vid uuid, from_qty numeric, from_unit text, to_qty numeric,
               to_unit text, archived_at timestamptz, changed boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select b.id, bs.site_bridge_id, (bs.site_bridge_id is null), s.site_item_id, b.from_qty, b.from_unit, b.to_qty, b.to_unit,
         a.archived_at,
         case when bs.site_bridge_id is null then true
              when b.archived_at is not null then true
              else ((t.company_ref, t.inventory_item_id, t.from_qty, t.from_unit, t.to_qty, t.to_unit, t.archived_at)
                    is distinct from (b.id, s.site_item_id, b.from_qty, b.from_unit, b.to_qty, b.to_unit, a.archived_at)) end
    from stock_co_bridges b
    join stock_co_items i on i.id = b.item_id
    join stock_co_item_sites s on s.item_id = b.item_id and s.location_id = p_loc
    left join stock_co_bridge_sites bs on bs.bridge_id = b.id and bs.location_id = p_loc
    left join inventory_item_conversions t on t.id = bs.site_bridge_id and t.location_id = p_loc
    cross join lateral (select case when b.archived_at is null then null::timestamptz
                                    else coalesce(t.archived_at, now()) end as archived_at) a
   where (p_item_ids is null or b.item_id = any(p_item_ids))
     and (bs.site_bridge_id is not null or (b.archived_at is null and i.archived_at is null and s.on_here));
$fn$;

-- Supplier packs and prices. In scope when the item is in p_item_ids or the supplier in p_supplier_ids.
-- The price here is the site's own price when it has one, else the company price, and never a company
-- price in another currency (the site keeps its own price; a new pack is skipped). Archived when the
-- company row is archived, switched off here, or the item has Stop ordering here. is_new rows need the
-- item set up and live here and the supplier set up here; the rest of the live company packs of items
-- set up here are listed as skipped.
create or replace function public.stock_co__plan_sps(p_loc uuid, p_item_ids uuid[], p_supplier_ids uuid[])
returns table (cid uuid, vid uuid, is_new boolean, skipped boolean, item_vid uuid, supplier_vid uuid, supplier_sku text,
               pack_description text, pack_qty numeric, inner_qty numeric, inner_unit text, pack_price numeric,
               price_includes_tax boolean, purchase_tax_rate_id uuid, archived_at timestamptz, rk bigint,
               changed boolean, cost_hit boolean, unpref boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select si.id, x.site_supplier_product_id,
         (x.site_supplier_product_id is null and ok.can_add),
         (x.site_supplier_product_id is null and not ok.can_add),
         s.site_item_id, coalesce(ss.site_supplier_id, t.supplier_id), si.sku, si.pack_description, si.pack_qty, si.inner_qty,
         si.inner_unit, pr.pack_price, si.price_includes_tax, rr.rate_id, a.archived_at,
         row_number() over (partition by s.site_item_id
                            order by (si.id is not distinct from i.main_supplier_item_id) desc, si.created_at, si.id),
         case when x.site_supplier_product_id is null then false
              else ((t.company_ref, t.supplier_id, t.inventory_item_id, t.supplier_sku, t.pack_description, t.pack_qty,
                     t.inner_qty, t.inner_unit, t.pack_price, t.price_includes_tax, t.purchase_tax_rate_id, t.archived_at)
                    is distinct from (si.id, coalesce(ss.site_supplier_id, t.supplier_id), s.site_item_id, si.sku, si.pack_description,
                     si.pack_qty, si.inner_qty, si.inner_unit, pr.pack_price, si.price_includes_tax, rr.rate_id, a.archived_at)) end,
         case when x.site_supplier_product_id is null then ok.can_add
              else ((t.pack_price, t.pack_qty, t.inner_qty, t.inner_unit, t.price_includes_tax, t.archived_at)
                    is distinct from (pr.pack_price, si.pack_qty, si.inner_qty, si.inner_unit, si.price_includes_tax, a.archived_at))
                   or (si.price_includes_tax and t.purchase_tax_rate_id is distinct from rr.rate_id) end,
         (x.site_supplier_product_id is not null and t.is_preferred and a.archived_at is not null and t.archived_at is null)
    from stock_co_supplier_items si
    join stock_co_items i on i.id = si.item_id
    join stock_co_item_sites s on s.item_id = si.item_id and s.location_id = p_loc
    join stock_co_suppliers m on m.id = si.supplier_id
    join locations l on l.id = p_loc
    left join stock_co_supplier_sites ss on ss.supplier_id = si.supplier_id and ss.location_id = p_loc
    left join stock_co_supplier_item_sites x on x.supplier_item_id = si.id and x.location_id = p_loc
    left join supplier_products t on t.id = x.site_supplier_product_id and t.location_id = p_loc
    cross join lateral (select case when x.price_here is not null then x.price_here
                                    when l.currency is not distinct from si.currency then si.pack_price
                                    else t.pack_price end as pack_price) pr
    cross join lateral (select public.stock_co__rate_id_for(p_loc, si.purchase_vat_rate, t.purchase_tax_rate_id) as rate_id) rr
    cross join lateral (select case when si.archived_at is not null or coalesce(x.off_here, false) or s.stop_ordering_at is not null
                                    then coalesce(t.archived_at, now()) else null::timestamptz end as archived_at) a
    cross join lateral (select (ss.site_supplier_id is not null and m.archived_at is null
                                and l.currency is not distinct from si.currency) as can_add) ok
   where ((p_item_ids is null or si.item_id = any(p_item_ids)) or (p_supplier_ids is null or si.supplier_id = any(p_supplier_ids)))
     and (x.site_supplier_product_id is not null
          or (si.archived_at is null and i.archived_at is null and s.on_here and s.stop_ordering_at is null));
$fn$;

-- The writer for items, packs, bridges, suppliers and supplier packs at one site.
--   p_write false: counts what it would write (nothing is written); with p_detail also the first 200
--   differing rows side by side (the drift check).
--   p_write true: sets the writer pass, locks every site row it will update (stock items first, each
--   table in id order), then writes only changed columns: suppliers, packs, bridges, supplier packs,
--   stock items last, then the cost step. Every written site row's row_version goes up by 1.
-- Site item and site supplier rows are made by the save functions (a link needs its site row); this
-- writer adds the packs, bridges and supplier packs those rows need. Never writes on hand, the ledger,
-- pars, counts, orders, invoices, waste or production; current_cost only through the cost step;
-- is_preferred only on insert (and taken off a pack it archives, the next live pack taking over);
-- default_supplier_id only for an item that had none or whose main pack it archived. Owner only.
create or replace function public.stock_co__sync_site(p_location uuid, p_item_ids uuid[], p_supplier_ids uuid[],
                                                      p_write boolean, p_detail boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_site text;
  v_counts jsonb;
  v_detail jsonb;
  v_bad text;
  v_pairs jsonb;
  v_cost_items uuid[];
  v_new_pref uuid[];
  v_promote uuid[];
  v_cost jsonb;
begin
  select l.org_id, l.name into v_org, v_site from locations l where l.id = p_location;
  if v_org is null then
    raise exception 'stock_co__sync_site: site % has no company', p_location using errcode = '22023';
  end if;

  select jsonb_build_object(
    'location_id', p_location,
    'items_new', 0,
    'items_changed', (select count(*) from public.stock_co__plan_items(p_location, p_item_ids) p where p.changed),
    'items_off', (select count(*) from public.stock_co__plan_items(p_location, p_item_ids) p where p.changed and p.going_off),
    'items_held', (select count(*) from public.stock_co__plan_items(p_location, p_item_ids) p where p.held),
    'packs_new', (select count(*) from public.stock_co__plan_packs(p_location, p_item_ids) p where p.is_new),
    'packs_changed', (select count(*) from public.stock_co__plan_packs(p_location, p_item_ids) p where not p.is_new and p.changed),
    'bridges_new', (select count(*) from public.stock_co__plan_bridges(p_location, p_item_ids) p where p.is_new),
    'bridges_changed', (select count(*) from public.stock_co__plan_bridges(p_location, p_item_ids) p where not p.is_new and p.changed),
    'suppliers_new', 0,
    'suppliers_changed', (select count(*) from public.stock_co__plan_suppliers(p_location, p_supplier_ids) p where p.changed),
    'prices_new', (select count(*) from public.stock_co__plan_sps(p_location, p_item_ids, p_supplier_ids) p where p.is_new),
    'prices_changed', (select count(*) from public.stock_co__plan_sps(p_location, p_item_ids, p_supplier_ids) p
                        where p.vid is not null and p.changed),
    'prices_skipped', (select count(*) from public.stock_co__plan_sps(p_location, p_item_ids, p_supplier_ids) p where p.skipped)
  ) into v_counts;
  v_counts := v_counts || jsonb_build_object('writes',
      (v_counts ->> 'items_new')::int + (v_counts ->> 'items_changed')::int
    + (v_counts ->> 'packs_new')::int + (v_counts ->> 'packs_changed')::int
    + (v_counts ->> 'bridges_new')::int + (v_counts ->> 'bridges_changed')::int
    + (v_counts ->> 'suppliers_new')::int + (v_counts ->> 'suppliers_changed')::int
    + (v_counts ->> 'prices_new')::int + (v_counts ->> 'prices_changed')::int);

  -- The items whose cost is checked after the write: a supplier pack added or changed in price, size,
  -- VAT or archive; a bridge added or changed; a new base unit or VAT rate on the item.
  v_cost_items := array(
    select p.item_vid from public.stock_co__plan_sps(p_location, p_item_ids, p_supplier_ids) p where p.cost_hit and not p.skipped
    union
    select p.item_vid from public.stock_co__plan_bridges(p_location, p_item_ids) p where p.changed
    union
    select p.vid from public.stock_co__plan_items(p_location, p_item_ids) p where p.unit_change or p.rate_change);

  if not p_write then
    v_cost := public.stock_co__cost_step(p_location, v_cost_items, null, false);
    v_counts := v_counts || jsonb_build_object('costs_changed', coalesce((v_cost ->> 'changed')::int, 0));
    if p_detail then
      select coalesce(jsonb_agg(d), '[]'::jsonb) into v_detail from (
        select * from (
          select 'item'::text as kind, p.vid as row_id, p.cid as company_id, p.name,
                 jsonb_build_object('name', t.name, 'category', t.category, 'accounting_group', t.accounting_group,
                   'base_unit', t.base_unit, 'allergens', t.allergens, 'sku', t.sku, 'barcode', t.barcode,
                   'shelf_life_days', t.shelf_life_days, 'returns_to_shelf', t.returns_to_shelf,
                   'purchase_tax_rate_id', t.purchase_tax_rate_id, 'vat', public.stock_co__rate_words(t.purchase_tax_rate_id),
                   'kind', t.kind, 'is_tracked', t.is_tracked, 'archived_at', t.archived_at, 'company_ref', t.company_ref) as site,
                 jsonb_build_object('name', p.name, 'category', p.category, 'accounting_group', p.accounting_group,
                   'base_unit', p.base_unit, 'allergens', p.allergens, 'sku', p.sku, 'barcode', p.barcode,
                   'shelf_life_days', p.shelf_life_days, 'returns_to_shelf', p.returns_to_shelf,
                   'purchase_tax_rate_id', p.purchase_tax_rate_id, 'vat', public.stock_co__rate_words(p.purchase_tax_rate_id),
                   'kind', p.kind, 'is_tracked', p.is_tracked, 'archived_at', p.archived_at, 'company_ref', p.cid) as company
            from public.stock_co__plan_items(p_location, p_item_ids) p
            join inventory_items t on t.id = p.vid
           where p.changed
          union all
          select 'supplier', p.vid, p.cid, p.name,
                 jsonb_build_object('name', t.name, 'contact_name', t.contact_name, 'phone', t.phone,
                   'payment_terms_days', t.payment_terms_days, 'archived_at', t.archived_at, 'company_ref', t.company_ref),
                 jsonb_build_object('name', p.name, 'contact_name', p.contact_name, 'phone', p.phone,
                   'payment_terms_days', p.payment_terms_days, 'archived_at', p.archived_at, 'company_ref', p.cid)
            from public.stock_co__plan_suppliers(p_location, p_supplier_ids) p
            join suppliers t on t.id = p.vid
           where p.changed
          union all
          select 'pack', p.vid, p.cid, p.name,
                 case when t.id is null then null else
                 jsonb_build_object('name', t.name, 'qty_in_base', t.qty_in_base, 'parent_format_id', t.parent_format_id,
                   'is_count_default', t.is_count_default, 'is_purchase_default', t.is_purchase_default,
                   'archived_at', t.archived_at, 'company_ref', t.company_ref) end,
                 jsonb_build_object('name', p.name, 'qty_in_base', p.qty_in_base, 'parent_format_id', p.parent_vid,
                   'is_count_default', p.is_count_default, 'is_purchase_default', p.is_purchase_default,
                   'archived_at', p.archived_at, 'company_ref', p.cid)
            from public.stock_co__plan_packs(p_location, p_item_ids) p
            left join item_packaging_formats t on t.id = p.vid
           where p.changed
          union all
          select 'bridge', p.vid, p.cid, p.from_qty::text || ' ' || p.from_unit || ' = ' || p.to_qty::text || ' ' || p.to_unit,
                 case when t.id is null then null else
                 jsonb_build_object('from_qty', t.from_qty, 'from_unit', t.from_unit, 'to_qty', t.to_qty, 'to_unit', t.to_unit,
                   'archived_at', t.archived_at, 'company_ref', t.company_ref) end,
                 jsonb_build_object('from_qty', p.from_qty, 'from_unit', p.from_unit, 'to_qty', p.to_qty, 'to_unit', p.to_unit,
                   'archived_at', p.archived_at, 'company_ref', p.cid)
            from public.stock_co__plan_bridges(p_location, p_item_ids) p
            left join inventory_item_conversions t on t.id = p.vid
           where p.changed
          union all
          select 'price', p.vid, p.cid, coalesce(p.pack_description, p.supplier_sku, 'supplier pack'),
                 case when t.id is null then null else
                 jsonb_build_object('supplier_id', t.supplier_id, 'supplier_sku', t.supplier_sku, 'pack_description', t.pack_description,
                   'pack_qty', t.pack_qty, 'inner_qty', t.inner_qty, 'inner_unit', t.inner_unit, 'pack_price', t.pack_price,
                   'price_includes_tax', t.price_includes_tax, 'purchase_tax_rate_id', t.purchase_tax_rate_id,
                   'vat', public.stock_co__rate_words(t.purchase_tax_rate_id),
                   'archived_at', t.archived_at, 'company_ref', t.company_ref) end,
                 jsonb_build_object('supplier_id', p.supplier_vid, 'supplier_sku', p.supplier_sku, 'pack_description', p.pack_description,
                   'pack_qty', p.pack_qty, 'inner_qty', p.inner_qty, 'inner_unit', p.inner_unit, 'pack_price', p.pack_price,
                   'price_includes_tax', p.price_includes_tax, 'purchase_tax_rate_id', p.purchase_tax_rate_id,
                   'vat', public.stock_co__rate_words(p.purchase_tax_rate_id),
                   'archived_at', p.archived_at, 'company_ref', p.cid)
            from public.stock_co__plan_sps(p_location, p_item_ids, p_supplier_ids) p
            left join supplier_products t on t.id = p.vid
           where (p.vid is not null and p.changed) or p.is_new
        ) a order by a.kind, a.name, a.company_id limit 200) d;
      v_counts := v_counts || jsonb_build_object('detail', v_detail);
    end if;
    return v_counts;
  end if;

  -- WRITE ---------------------------------------------------------------------
  perform set_config('servos.stock_co_write', txid_current()::text, true);

  -- Locks first: stock items (the sales lock order), then every other row this write updates.
  perform 1 from inventory_items t
   where t.location_id = p_location
     and t.id in (select p.vid from public.stock_co__plan_items(p_location, p_item_ids) p where p.changed
                  union select unnest(v_cost_items)
                  union select p.item_vid from public.stock_co__plan_sps(p_location, p_item_ids, p_supplier_ids) p where p.is_new or p.unpref)
   order by t.id
   for no key update;
  perform 1 from suppliers t
   where t.location_id = p_location
     and t.id in (select p.vid from public.stock_co__plan_suppliers(p_location, p_supplier_ids) p where p.changed)
   order by t.id
   for no key update;
  perform 1 from supplier_products t
   where t.location_id = p_location
     and t.id in (select p.vid from public.stock_co__plan_sps(p_location, p_item_ids, p_supplier_ids) p where p.vid is not null and p.changed)
   order by t.id
   for no key update;
  perform 1 from item_packaging_formats t
   where t.location_id = p_location
     and t.id in (select p.vid from public.stock_co__plan_packs(p_location, p_item_ids) p where not p.is_new and p.changed)
   order by t.id
   for no key update;
  perform 1 from inventory_item_conversions t
   where t.location_id = p_location
     and t.id in (select p.vid from public.stock_co__plan_bridges(p_location, p_item_ids) p where not p.is_new and p.changed)
   order by t.id
   for no key update;

  -- A site row in use in its unit never changes unit (the company base unit lock should have refused).
  select string_agg(format('%s is counted in %s there and has stock, counts, pars or orders, so it cannot change to %s',
                           x.name, x.site_unit, x.base_unit), '; ')
    into v_bad
    from (select p.name, t.base_unit as site_unit, p.base_unit
            from public.stock_co__plan_items(p_location, p_item_ids) p
            join inventory_items t on t.id = p.vid
           where p.unit_change and public.stock_co__site_item_in_use(p_location, p.vid)
           order by p.name limit 5) x;
  if v_bad is not null then
    raise exception 'Not written at %: %.', v_site, v_bad using errcode = '55000';
  end if;

  -- 1. suppliers
  update suppliers t
     set company_ref = p.cid, name = p.name, contact_name = p.contact_name, phone = p.phone,
         payment_terms_days = p.payment_terms_days, archived_at = p.archived_at,
         row_version = t.row_version + 1, updated_at = now()
    from public.stock_co__plan_suppliers(p_location, p_supplier_ids) p
   where t.id = p.vid and t.location_id = p_location and p.changed;

  -- 2. packs: new site packs (their own ids, the parent mapped here), their links, then changes
  select coalesce(jsonb_object_agg(p.cid, gen_random_uuid()), '{}'::jsonb) into v_pairs
    from public.stock_co__plan_packs(p_location, p_item_ids) p where p.is_new;
  if v_pairs <> '{}'::jsonb then
    insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base, parent_format_id,
                                        is_count_default, is_purchase_default, archived_at, company_ref)
    select (v_pairs ->> p.cid::text)::uuid, p_location, p.item_vid, p.name, p.qty_in_base,
           coalesce(p.parent_vid, (v_pairs ->> p.parent_pack_id::text)::uuid),
           p.is_count_default, p.is_purchase_default, null, p.cid
      from public.stock_co__plan_packs(p_location, p_item_ids) p
     where p.is_new;
    insert into stock_co_pack_sites (pack_id, org_id, location_id, site_pack_id)
    select e.key::uuid, v_org, p_location, e.value::uuid from jsonb_each_text(v_pairs) e;
  end if;
  update item_packaging_formats t
     set company_ref = p.cid, inventory_item_id = p.item_vid, name = p.name, qty_in_base = p.qty_in_base,
         parent_format_id = p.parent_vid, is_count_default = p.is_count_default, is_purchase_default = p.is_purchase_default,
         archived_at = p.archived_at, row_version = t.row_version + 1
    from public.stock_co__plan_packs(p_location, p_item_ids) p
   where t.id = p.vid and t.location_id = p_location and not p.is_new and p.changed;

  -- 3. unit bridges
  select coalesce(jsonb_object_agg(p.cid, gen_random_uuid()), '{}'::jsonb) into v_pairs
    from public.stock_co__plan_bridges(p_location, p_item_ids) p where p.is_new;
  if v_pairs <> '{}'::jsonb then
    insert into inventory_item_conversions (id, location_id, inventory_item_id, from_qty, from_unit, to_qty, to_unit,
                                            archived_at, company_ref)
    select (v_pairs ->> p.cid::text)::uuid, p_location, p.item_vid, p.from_qty, p.from_unit, p.to_qty, p.to_unit, null, p.cid
      from public.stock_co__plan_bridges(p_location, p_item_ids) p
     where p.is_new;
    insert into stock_co_bridge_sites (bridge_id, org_id, location_id, site_bridge_id)
    select e.key::uuid, v_org, p_location, e.value::uuid from jsonb_each_text(v_pairs) e;
  end if;
  -- an archived company bridge: its site row goes (its link row goes with it, on delete cascade), so
  -- no converter can still use it; nothing else points at a bridge row
  delete from inventory_item_conversions t
   using public.stock_co__plan_bridges(p_location, p_item_ids) p
   where t.id = p.vid and t.location_id = p_location and not p.is_new and p.archived_at is not null;
  update inventory_item_conversions t
     set company_ref = p.cid, inventory_item_id = p.item_vid, from_qty = p.from_qty, from_unit = p.from_unit,
         to_qty = p.to_qty, to_unit = p.to_unit, archived_at = null, row_version = t.row_version + 1
    from public.stock_co__plan_bridges(p_location, p_item_ids) p
   where t.id = p.vid and t.location_id = p_location and not p.is_new and p.changed and p.archived_at is null;

  -- 4. supplier packs: new ones (preferred only when the item has no live preferred pack here and this
  --    is its first new one, the company main pack first), their links, then changes
  select coalesce(jsonb_object_agg(p.cid, gen_random_uuid()), '{}'::jsonb) into v_pairs
    from public.stock_co__plan_sps(p_location, p_item_ids, p_supplier_ids) p where p.is_new;
  if v_pairs <> '{}'::jsonb then
    with ins as (
      insert into supplier_products (id, location_id, inventory_item_id, supplier_id, supplier_sku, pack_description, pack_qty,
                                     inner_qty, inner_unit, pack_price, is_preferred, purchase_tax_rate_id, price_includes_tax,
                                     archived_at, company_ref)
      select (v_pairs ->> q.cid::text)::uuid, p_location, q.item_vid, q.supplier_vid, q.supplier_sku, q.pack_description, q.pack_qty,
             q.inner_qty, q.inner_unit, q.pack_price,
             (q.rk2 = 1 and not exists (select 1 from supplier_products e
                                          where e.location_id = p_location and e.inventory_item_id = q.item_vid
                                            and e.is_preferred and e.archived_at is null)),
             q.purchase_tax_rate_id, coalesce(q.price_includes_tax, false), null, q.cid
        from (select p.*, row_number() over (partition by p.item_vid order by p.rk) as rk2
                from public.stock_co__plan_sps(p_location, p_item_ids, p_supplier_ids) p
               where p.is_new) q
      returning inventory_item_id, is_preferred)
    select array_agg(distinct ins.inventory_item_id) filter (where ins.is_preferred) into v_new_pref from ins;
    insert into stock_co_supplier_item_sites (supplier_item_id, org_id, location_id, site_supplier_product_id)
    select e.key::uuid, v_org, p_location, e.value::uuid from jsonb_each_text(v_pairs) e;
  end if;
  with u as (
    update supplier_products t
       set company_ref = p.cid, supplier_id = p.supplier_vid, inventory_item_id = p.item_vid, supplier_sku = p.supplier_sku,
           pack_description = p.pack_description, pack_qty = p.pack_qty, inner_qty = p.inner_qty, inner_unit = p.inner_unit,
           pack_price = p.pack_price, price_includes_tax = coalesce(p.price_includes_tax, false),
           purchase_tax_rate_id = p.purchase_tax_rate_id, archived_at = p.archived_at,
           is_preferred = case when p.unpref then false else t.is_preferred end,
           row_version = t.row_version + 1, updated_at = now()
      from public.stock_co__plan_sps(p_location, p_item_ids, p_supplier_ids) p
     where t.id = p.vid and t.location_id = p_location and p.vid is not null and p.changed
    returning p.item_vid, p.unpref)
  select array_agg(distinct u.item_vid) filter (where u.unpref) into v_promote from u;

  -- 4b. an item whose preferred pack was archived here takes its next live pack (cheapest per base
  --     unit) as preferred, and its default supplier follows.
  if v_promote is not null and cardinality(v_promote) > 0 then
    with c as (
      select distinct on (sp.inventory_item_id) sp.id, sp.supplier_id, sp.inventory_item_id
        from supplier_products sp
       where sp.location_id = p_location and sp.inventory_item_id = any(v_promote) and sp.archived_at is null
         and not exists (select 1 from supplier_products e
                          where e.location_id = p_location and e.inventory_item_id = sp.inventory_item_id
                            and e.is_preferred and e.archived_at is null)
       order by sp.inventory_item_id, public.stock_co__sp_unit_cost(sp.id) nulls last, sp.created_at, sp.id),
    u as (
      update supplier_products t set is_preferred = true, row_version = t.row_version + 1, updated_at = now()
        from c where t.id = c.id and t.location_id = p_location
      returning t.inventory_item_id, t.supplier_id)
    update inventory_items i
       set default_supplier_id = u.supplier_id, row_version = i.row_version + 1, updated_at = now()
      from u
     where i.id = u.inventory_item_id and i.location_id = p_location and i.default_supplier_id is distinct from u.supplier_id;
  end if;

  -- 5. stock items, last: the company columns, kind and is_tracked of the rows that differ
  update inventory_items t
     set company_ref = p.cid, name = p.name, category = p.category, accounting_group = p.accounting_group,
         base_unit = p.base_unit, allergens = p.allergens, sku = p.sku, barcode = p.barcode,
         shelf_life_days = p.shelf_life_days, returns_to_shelf = p.returns_to_shelf,
         purchase_tax_rate_id = p.purchase_tax_rate_id, kind = p.kind, is_tracked = p.is_tracked,
         archived_at = p.archived_at, row_version = t.row_version + 1, updated_at = now()
    from public.stock_co__plan_items(p_location, p_item_ids) p
   where t.id = p.vid and t.location_id = p_location and p.changed;

  -- 5b. an item that had no default supplier takes the supplier of the preferred pack added here
  if v_new_pref is not null and cardinality(v_new_pref) > 0 then
    update inventory_items i
       set default_supplier_id = sp.supplier_id, row_version = i.row_version + 1, updated_at = now()
      from supplier_products sp
     where i.id = any(v_new_pref) and i.location_id = p_location and i.default_supplier_id is null
       and sp.location_id = p_location and sp.inventory_item_id = i.id and sp.is_preferred and sp.archived_at is null;
  end if;

  -- 6. cost step (after the base unit, bridges and prices are written)
  v_cost := public.stock_co__cost_step(p_location, v_cost_items, null, true);
  return v_counts || jsonb_build_object('costs_changed', coalesce((v_cost ->> 'changed')::int, 0), 'cost', v_cost);
end
$fn$;

-- ---------------------------------------------------------------------------
-- Recipes: the plan and the recipe writer (recipes, their lines and the till link at one site).
-- ---------------------------------------------------------------------------
-- The company lines of one company recipe in the site's own form: component through the item link
-- here, a pack line as '@' plus the site pack id here. comp or unit null means it is not set up here.
create or replace function public.stock_co__plan_lines(p_loc uuid, p_recipe uuid)
returns table (component_item_id uuid, qty numeric, unit text, usable_pct numeric, sort_order integer, note text,
               order_types jsonb, company_item_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select (select s.site_item_id from stock_co_item_sites s where s.item_id = l.component_item_id and s.location_id = p_loc),
         l.qty,
         case when l.pack_id is null then l.unit
              else '@' || (select ps.site_pack_id from stock_co_pack_sites ps where ps.pack_id = l.pack_id and ps.location_id = p_loc)::text end,
         coalesce(l.usable_pct, 100), l.sort_order, l.note, l.order_types, l.component_item_id
    from stock_co_recipe_lines l
   where l.recipe_id = p_recipe and l.component_item_id is not null;
$fn$;

-- Site recipes linked to company recipes (p_recipe_ids company ids, null = all at the site).
create or replace function public.stock_co__plan_recipes(p_loc uuid, p_recipe_ids uuid[])
returns table (cid uuid, vid uuid, name text, recipe_type text, output_vid uuid, output_missing boolean, yield_qty numeric,
               yield_unit text, wastage_pct numeric, gp_target_pct numeric, method text, photo text, archived_at timestamptz,
               live boolean, menu_item_id text, changed boolean, lines_differ boolean, lines_blocked boolean,
               link_missing boolean, links_to_drop integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select r.id, t.id, r.name, k.recipe_type, ov.output_vid, (r.output_item_id is not null and ov.output_vid is null),
         coalesce(r.yield_qty, 1), coalesce(nullif(r.yield_unit, ''), 'each'), coalesce(r.wastage_pct, 0), r.gp_target_pct,
         r.method, r.photo, a.archived_at, lv.live, rs.site_menu_item_id,
         ((t.company_ref, t.name, t.recipe_type, t.output_item_id, t.yield_qty, t.yield_unit, t.wastage_pct, t.gp_target_pct,
           t.method, t.photo, t.archived_at)
          is distinct from (r.id, r.name, k.recipe_type, ov.output_vid, coalesce(r.yield_qty, 1), coalesce(nullif(r.yield_unit, ''), 'each'),
           coalesce(r.wastage_pct, 0), r.gp_target_pct, r.method, r.photo, a.archived_at)),
         (lv.live and exists (
            (select c.component_item_id, c.qty, c.unit, c.usable_pct, c.sort_order, c.note, c.order_types
               from public.stock_co__plan_lines(p_loc, r.id) c
             except all
             select sl.component_item_id, sl.qty, sl.unit, sl.usable_pct, sl.sort_order, sl.note, sl.order_types
               from recipe_lines sl where sl.recipe_id = t.id and sl.location_id = p_loc)
            union all
            (select sl.component_item_id, sl.qty, sl.unit, sl.usable_pct, sl.sort_order, sl.note, sl.order_types
               from recipe_lines sl where sl.recipe_id = t.id and sl.location_id = p_loc
             except all
             select c.component_item_id, c.qty, c.unit, c.usable_pct, c.sort_order, c.note, c.order_types
               from public.stock_co__plan_lines(p_loc, r.id) c))),
         (lv.live and exists (select 1 from public.stock_co__plan_lines(p_loc, r.id) c where c.component_item_id is null or c.unit is null)),
         (lv.live and rs.site_menu_item_id is not null
          and not exists (select 1 from menu_item_recipes m
                           where m.location_id = p_loc and m.menu_item_id = rs.site_menu_item_id and m.recipe_id = t.id)),
         case when lv.live then 0
              else (select count(*)::int from menu_item_recipes m where m.location_id = p_loc and m.recipe_id = t.id) end
    from stock_co_recipe_sites rs
    join stock_co_recipes r on r.id = rs.recipe_id
    join recipes t on t.id = rs.site_recipe_id and t.location_id = p_loc
    cross join lateral (select case r.kind when 'dish' then 'MENU' when 'batch' then 'BATCH' else 'PREP' end as recipe_type) k
    cross join lateral (select (select s.site_item_id from stock_co_item_sites s
                                 where s.item_id = r.output_item_id and s.location_id = p_loc) as output_vid) ov
    cross join lateral (select (r.archived_at is null and rs.on_here) as live) lv
    cross join lateral (select case when lv.live then null::timestamptz else coalesce(t.archived_at, now()) end as archived_at) a
   where rs.location_id = p_loc
     and (p_recipe_ids is null or rs.recipe_id = any(p_recipe_ids));
$fn$;

-- The recipe writer at one site: recipe columns, lines (replaced as a whole when they differ, pack
-- lines as '@' plus this site's pack id, components through the item links here) and the till link
-- (stock_co_recipe_sites.site_menu_item_id; an archived recipe loses its links). A recipe whose
-- output item or a line's item or pack is not set up here is refused at this site in words. With
-- p_write it also re rolls the cost of the made item of every recipe it wrote here (stock_co__recost).
-- Result as stock_co__sync_site with recipes_new, recipes_changed, lines_changed, links_changed (and
-- "cost" with p_write). Owner only.
create or replace function public.stock_co__sync_recipes(p_location uuid, p_recipe_ids uuid[], p_write boolean,
                                                         p_detail boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_site text;
  v_counts jsonb;
  v_detail jsonb;
  v_bad text;
  v_lines uuid[];
  v_recost uuid[];
  v_cost jsonb := jsonb_build_object('ok', true, 'items', '[]'::jsonb);
begin
  select l.org_id, l.name into v_org, v_site from locations l where l.id = p_location;
  if v_org is null then
    raise exception 'stock_co__sync_recipes: site % has no company', p_location using errcode = '22023';
  end if;
  if p_recipe_ids is not null and cardinality(p_recipe_ids) = 0 then
    return jsonb_build_object('location_id', p_location, 'writes', 0, 'recipes_new', 0, 'recipes_changed', 0,
                              'lines_changed', 0, 'links_changed', 0);
  end if;
  select jsonb_build_object(
    'location_id', p_location,
    'recipes_new', 0,
    'recipes_changed', count(*) filter (where p.changed),
    'lines_changed', count(*) filter (where p.lines_differ),
    'links_changed', count(*) filter (where p.link_missing) + coalesce(sum(p.links_to_drop), 0),
    'recipes_blocked', count(*) filter (where p.lines_blocked or (p.live and p.output_missing)))
    into v_counts
    from public.stock_co__plan_recipes(p_location, p_recipe_ids) p;
  v_counts := v_counts || jsonb_build_object('writes',
      (v_counts ->> 'recipes_new')::int + (v_counts ->> 'recipes_changed')::int
    + (v_counts ->> 'lines_changed')::int + (v_counts ->> 'links_changed')::int);

  if not p_write then
    if p_detail then
      select coalesce(jsonb_agg(d), '[]'::jsonb) into v_detail from (
        select 'recipe'::text as kind, p.vid as row_id, p.cid as company_id, p.name,
               jsonb_build_object('name', t.name, 'recipe_type', t.recipe_type, 'output_item_id', t.output_item_id,
                 'yield_qty', t.yield_qty, 'yield_unit', t.yield_unit, 'wastage_pct', t.wastage_pct,
                 'gp_target_pct', t.gp_target_pct, 'archived_at', t.archived_at, 'company_ref', t.company_ref,
                 'lines', (select count(*) from recipe_lines sl where sl.recipe_id = t.id and sl.location_id = p_location)) as site,
               jsonb_build_object('name', p.name, 'recipe_type', p.recipe_type, 'output_item_id', p.output_vid,
                 'yield_qty', p.yield_qty, 'yield_unit', p.yield_unit, 'wastage_pct', p.wastage_pct,
                 'gp_target_pct', p.gp_target_pct, 'archived_at', p.archived_at, 'company_ref', p.cid,
                 'lines', (select count(*) from public.stock_co__plan_lines(p_location, p.cid)),
                 'lines_differ', p.lines_differ, 'link_missing', p.link_missing, 'links_to_drop', p.links_to_drop,
                 'blocked', p.lines_blocked or (p.live and p.output_missing)) as company
          from public.stock_co__plan_recipes(p_location, p_recipe_ids) p
          join recipes t on t.id = p.vid
         where p.changed or p.lines_differ or p.link_missing or p.links_to_drop > 0 or p.lines_blocked or (p.live and p.output_missing)
         order by p.name, p.cid
         limit 200) d;
      v_counts := v_counts || jsonb_build_object('detail', v_detail);
    end if;
    return v_counts;
  end if;

  -- WRITE ---------------------------------------------------------------------
  select string_agg(x.words, '; ') into v_bad
    from (select case when p.output_missing
                      then format('%s makes an item that is not set up there', p.name)
                      else format('%s uses an item or a pack that is not set up there', p.name) end as words
            from public.stock_co__plan_recipes(p_location, p_recipe_ids) p
           where p.live and (p.output_missing or (p.lines_blocked and p.lines_differ))
           order by p.name limit 5) x;
  if v_bad is not null then
    raise exception 'Not written at %: %. Add the item at that site first.', v_site, v_bad using errcode = '55000';
  end if;

  perform set_config('servos.stock_co_write', txid_current()::text, true);
  perform 1 from recipes t
   where t.location_id = p_location
     and t.id in (select p.vid from public.stock_co__plan_recipes(p_location, p_recipe_ids) p
                   where p.changed or p.lines_differ or p.link_missing or p.links_to_drop > 0)
   order by t.id
   for no key update;

  v_lines := array(select p.vid from public.stock_co__plan_recipes(p_location, p_recipe_ids) p where p.lines_differ);
  v_recost := array(select p.output_vid from public.stock_co__plan_recipes(p_location, p_recipe_ids) p
                     where p.live and p.output_vid is not null and (p.changed or p.lines_differ));

  -- 1. recipe columns
  update recipes t
     set company_ref = p.cid, name = p.name, recipe_type = p.recipe_type, output_item_id = p.output_vid,
         yield_qty = p.yield_qty, yield_unit = p.yield_unit, wastage_pct = p.wastage_pct, gp_target_pct = p.gp_target_pct,
         method = p.method, photo = p.photo, archived_at = p.archived_at,
         row_version = t.row_version + 1, updated_at = now()
    from public.stock_co__plan_recipes(p_location, p_recipe_ids) p
   where t.id = p.vid and t.location_id = p_location and p.changed;

  -- 2. lines: replaced as a whole where they differ
  if cardinality(v_lines) > 0 then
    delete from recipe_lines sl where sl.location_id = p_location and sl.recipe_id = any(v_lines);
    insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, usable_pct, sort_order, note, order_types)
    select p_location, rs.site_recipe_id, c.component_item_id, c.qty, c.unit, c.usable_pct, c.sort_order, c.note, c.order_types
      from stock_co_recipe_sites rs
      cross join lateral public.stock_co__plan_lines(p_location, rs.recipe_id) c
     where rs.location_id = p_location and rs.site_recipe_id = any(v_lines)
     order by rs.site_recipe_id, c.sort_order;
  end if;

  -- 3. the till link: added where missing (the portion of an existing link is kept), and every link
  --    of an archived recipe removed
  insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion)
  select p_location, p.menu_item_id, p.vid, 1
    from public.stock_co__plan_recipes(p_location, p_recipe_ids) p
   where p.link_missing
  on conflict (location_id, menu_item_id) do update set recipe_id = excluded.recipe_id;
  delete from menu_item_recipes m
   where m.location_id = p_location
     and m.recipe_id in (select p.vid from public.stock_co__plan_recipes(p_location, p_recipe_ids) p where p.links_to_drop > 0);

  -- 4. the made item of every recipe written here is re costed
  if cardinality(v_recost) > 0 then
    v_cost := public.stock_co__recost(p_location, v_recost, true);
  end if;
  return v_counts || jsonb_build_object('cost', v_cost);
end
$fn$;

-- ============================================================================
-- STEP 13. THE SAVE AND READ FUNCTIONS (Drop 0 set), with the common guard.
-- ============================================================================
-- Allowed keys per save shape, with their types (contract section 3.4). Anything else is refused in
-- words. Types: text, bool, uuid, unit, array (a json list), textarray (a list of text), int (whole, 0
-- or more), pos (more than 0), money (0 or more, 4 decimals), nonneg (0 or more), num (any number),
-- rate (a fraction, 0 or more and below 1), currency (three capital letters), enum:a|b, object:<shape>.
create or replace function public.stock_co__allowed(p_target text)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case p_target
    when 'item' then '{"id":"uuid","site_item_id":"uuid","location_id":"uuid","name":"text","category":"text","accounting_group":"text","base_unit":"unit","sku":"text","barcode":"text","shelf_life_days":"int","allergens":"array","returns_to_shelf":"bool","purchase_tax_rate_id":"uuid","purchase_vat_rate":"rate","type":"enum:food|drink|other","exclude_from_gp":"bool","key_item":"bool","notes":"text","site":"object:item_site"}'::jsonb
    when 'item_site' then '{"kind":"enum:PURCHASED|MADE","is_tracked":"bool","is_sellable":"bool","cost_method":"enum:MOVING_AVG|LAST_COST","storage_location":"text","default_supplier_id":"uuid","notes":"text"}'::jsonb
    when 'item_site_patch' then '{"par_level":"nonneg","reorder_point":"nonneg","min_level":"nonneg","area_id":"uuid","move_holding":"bool","by_name":"text","counted_here":"bool"}'::jsonb
    when 'pack' then '{"id":"uuid","site_pack_id":"uuid","location_id":"uuid","item_id":"uuid","site_item_id":"uuid","name":"text","qty_in_base":"pos","parent_pack_id":"uuid","site_parent_pack_id":"uuid","is_count_default":"bool","is_purchase_default":"bool"}'::jsonb
    when 'bridge' then '{"id":"uuid","site_bridge_id":"uuid","location_id":"uuid","item_id":"uuid","site_item_id":"uuid","from_qty":"pos","from_unit":"unit","to_qty":"pos","to_unit":"unit"}'::jsonb
    when 'supplier' then '{"id":"uuid","site_supplier_id":"uuid","location_id":"uuid","name":"text","contact_name":"text","phone":"text","payment_terms_days":"int","email":"text","accepts_price_changes":"bool","max_order_value":"money","order_method":"enum:email|held","notes":"text","site":"object:supplier_site"}'::jsonb
    when 'supplier_site' then '{"account_number":"text","email":"text","cc_emails":"textarray","min_order_value":"money","delivery_fee":"money","delivery_days":"array","cutoff_time":"text","notes":"text"}'::jsonb
    when 'supplier_site_patch' then '{"account_number":"text","email":"text","cc_emails":"textarray","can_order":"bool","min_order_value":"money","delivery_fee":"money","approval_limit":"money"}'::jsonb
    when 'supplier_item' then '{"id":"uuid","site_supplier_product_id":"uuid","location_id":"uuid","item_id":"uuid","site_item_id":"uuid","supplier_id":"uuid","site_supplier_id":"uuid","supplier_sku":"text","supplier_product_name":"text","pack_description":"text","pack_qty":"pos","inner_qty":"pos","inner_unit":"unit","pack_price":"money","currency":"currency","purchase_tax_rate_id":"uuid","purchase_vat_rate":"rate","price_includes_tax":"bool","site":"object:supplier_item_site"}'::jsonb
    when 'supplier_item_site' then '{"is_preferred":"bool"}'::jsonb
    when 'supplier_item_site_patch' then '{"price_here":"money","off_here":"bool","paused":"bool"}'::jsonb
    when 'recipe' then '{"id":"uuid","site_recipe_id":"uuid","location_id":"uuid","name":"text","recipe_type":"enum:MENU|BATCH|PREP","output_item_id":"uuid","site_output_item_id":"uuid","yield_qty":"pos","yield_unit":"unit","wastage_pct":"nonneg","gp_target_pct":"num","method":"text","photo":"text","menu_item_id":"text","portion":"pos"}'::jsonb
    when 'recipe_line' then '{"component_item_id":"uuid","site_component_item_id":"uuid","qty":"num","unit":"text","pack_id":"uuid","usable_pct":"pos","sort_order":"int","note":"text","order_types":"array"}'::jsonb
    else null end;
$fn$;

-- Clean one save shape: allowed keys only, the right types, trimmed text, empty text as null. A key
-- that is not allowed is refused ("cannot be changed here", or "here yet" for the site patches, whose
-- other fields arrive in Drop 1).
create or replace function public.stock_co__clean(p_target text, p_data jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
declare
  v_allowed jsonb := public.stock_co__allowed(p_target);
  v_out jsonb := '{}'::jsonb;
  k text;
  v jsonb;
  t text;
  s text;
  n numeric;
begin
  if v_allowed is null then
    raise exception 'Unknown kind of stock save: %', coalesce(p_target, 'none') using errcode = '22023';
  end if;
  if p_data is null or jsonb_typeof(p_data) = 'null' then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(p_data) <> 'object' then
    raise exception 'A stock save needs its fields.' using errcode = '22023';
  end if;
  for k, v in select e.key, e.value from jsonb_each(p_data) e loop
    t := v_allowed ->> k;
    if t is null then
      if p_target like '%\_patch' then
        raise exception 'The field "%" cannot be changed here yet.', k using errcode = '22023';
      end if;
      raise exception 'The field "%" cannot be changed here.', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) = 'null' then
      -- a record id sent as null is the same as not sent (a new record)
      if k in ('id', 'location_id', 'item_id', 'supplier_id', 'site_item_id', 'site_supplier_id', 'site_supplier_product_id',
               'site_pack_id', 'site_bridge_id', 'site_recipe_id', 'component_item_id', 'site_component_item_id') then
        continue;
      end if;
      if t = 'bool' or k in ('name', 'base_unit', 'qty_in_base', 'from_qty', 'to_qty', 'from_unit', 'to_unit', 'inner_unit',
                             'pack_qty', 'inner_qty', 'pack_price', 'recipe_type', 'yield_qty', 'currency') then
        raise exception 'The field "%" cannot be empty.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, null);
      continue;
    end if;
    if t like 'object:%' then
      if jsonb_typeof(v) <> 'object' then
        raise exception 'The field "%" must be a group of fields.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, public.stock_co__clean(substr(t, 8), v));
      continue;
    end if;
    if t = 'array' then
      if jsonb_typeof(v) <> 'array' then
        raise exception 'The field "%" must be a list.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, v);
      continue;
    end if;
    if t = 'textarray' then
      if jsonb_typeof(v) <> 'array' or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
        raise exception 'The field "%" must be a list of text.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, (select coalesce(jsonb_agg(btrim(e)), '[]'::jsonb)
                                                  from jsonb_array_elements_text(v) e where btrim(e) <> ''));
      continue;
    end if;
    if jsonb_typeof(v) in ('object', 'array') then
      raise exception 'The field "%" must be a single value.', k using errcode = '22023';
    end if;
    s := btrim(v #>> '{}');
    if t = 'text' then
      if k = 'name' and coalesce(s, '') = '' then
        raise exception 'A name cannot be empty.' using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, nullif(s, ''));
    elsif t = 'bool' then
      if jsonb_typeof(v) <> 'boolean' then
        raise exception 'The field "%" must be yes or no.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, v);
    elsif t = 'uuid' then
      if s !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'The field "%" is not a valid id.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, lower(s));
    elsif t = 'unit' then
      if not exists (select 1 from stock_units u where u.code = lower(s)) then
        raise exception '"%" is not a unit ServOS knows (g, kg, ml, l, each, ...).', s using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, lower(s));
    elsif t like 'enum:%' then
      if not (s = any(string_to_array(substr(t, 6), '|'))) then
        raise exception 'The field "%" must be one of: %.', k, replace(substr(t, 6), '|', ', ') using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, s);
    elsif t = 'currency' then
      if upper(s) !~ '^[A-Z]{3}$' then
        raise exception 'The field "%" must be a three letter currency code such as GBP.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, upper(s));
    else
      -- an empty number box is the same as no number
      if coalesce(s, '') = '' then
        if k in ('qty_in_base', 'from_qty', 'to_qty', 'pack_qty', 'inner_qty', 'pack_price', 'yield_qty') then
          raise exception 'The field "%" cannot be empty.', k using errcode = '22023';
        end if;
        v_out := v_out || jsonb_build_object(k, null);
        continue;
      end if;
      begin
        n := s::numeric;
      exception when others then
        raise exception 'The field "%" must be a number.', k using errcode = '22023';
      end;
      if t = 'int' and (n <> trunc(n) or n < 0) then
        raise exception 'The field "%" must be a whole number, 0 or more.', k using errcode = '22023';
      end if;
      if t = 'pos' and n <= 0 then
        raise exception 'The field "%" must be more than 0.', k using errcode = '22023';
      end if;
      if t = 'money' and n < 0 then
        raise exception 'A price cannot be below 0.' using errcode = '22023';
      end if;
      if t = 'nonneg' and n < 0 then
        raise exception 'The field "%" cannot be below 0.', k using errcode = '22023';
      end if;
      if t = 'rate' and (n < 0 or n >= 1) then
        raise exception 'A VAT rate is a fraction such as 0.2 for 20%%.' using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, case when t = 'int' then to_jsonb(trunc(n)::integer)
                                                   when t = 'money' then to_jsonb(round(n, 4))
                                                   else to_jsonb(n) end);
    end if;
  end loop;
  return v_out;
end
$fn$;

-- A signed in Back Office session (not anonymous, second step done), else the sign in words. Owner only.
create or replace function public.stock_co__signed_in()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if auth.uid() is null or public.is_anon_session() or not public.msm__second_step_ok() then
    raise exception 'Sign in to Back Office to change stock.' using errcode = '42501';
  end if;
  return auth.uid();
end
$fn$;

-- The section a save runs under: the one the screen names (null = the function's first section),
-- which must be in the function's own list. Owner only.
create or replace function public.stock_co__section(p_given text, p_allowed text[])
returns text
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v text := coalesce(nullif(btrim(coalesce(p_given, '')), ''), p_allowed[1]);
begin
  if not (v = any(p_allowed)) then
    raise exception 'Not allowed: this screen cannot change %.',
      case p_allowed[1] when 'inventory' then 'stock items' when 'produce' then 'recipes' when 'purchasing' then 'suppliers' else 'stock' end
      using errcode = '42501';
  end if;
  return v;
end
$fn$;

-- The common guard inside every company save (map 5.1, contract 3.1). p_locations are the sites the
-- caller NAMES. Drop 0 form: every need ('company', 'site_facts', 'site_price') is met by reach; need
-- 'owner' (the site cost override) needs an owner of that company or ServOS staff; need 'read' skips the
-- section and level checks and sets no writer pass. p_section null skips the section check. The Drop 1
-- migration replaces this function (same signature) to switch the levels on. Owner only.
create or replace function public.stock_co__guard(p_org uuid, p_section text, p_need text, p_locations uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_reach text[];
  v_prof record;
  v_l record;
  v_owner boolean;
  v_super boolean;
  v_level text;
  v_open integer;
  v_since timestamptz;
begin
  if p_need is null or p_need not in ('read', 'company', 'site_facts', 'site_price', 'owner') then
    raise exception 'stock_co__guard: unknown need %', coalesce(p_need, 'null') using errcode = '22023';
  end if;
  if p_org is null or p_locations is null or cardinality(p_locations) = 0 then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_reach := array(select public.stock_reach_locations());
  for v_l in
    select u.id as want, l.id, l.name, l.org_id
      from (select distinct x.id from unnest(p_locations) x(id)) u
      left join locations l on l.id = u.id
     order by u.id
  loop
    if v_l.want is null or v_l.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    if not (v_l.id::text = any(v_reach)) then
      raise exception 'Not allowed: this login does not reach %.', v_l.name using errcode = '42501';
    end if;
    if v_l.org_id is distinct from p_org then
      raise exception 'Not allowed: % is in another company.', v_l.name using errcode = '42501';
    end if;
  end loop;
  select p.role, p.org_id, p.bo_sections, coalesce(p.full_name, p.email) as name into v_prof
    from user_profiles p where p.id = v_uid;
  v_super := public.is_super_admin();
  v_owner := coalesce(v_prof.role = 'owner' and v_prof.org_id = p_org, false);
  if p_need <> 'read' and p_section is not null and not (v_owner or v_super)
     and v_prof.bo_sections is not null and not (p_section = any(v_prof.bo_sections)) then
    raise exception 'Not allowed: this screen cannot change %.',
      case p_section when 'inventory' then 'stock items' when 'produce' then 'recipes' when 'purchasing' then 'suppliers' else 'stock' end
      using errcode = '42501';
  end if;
  v_level := public.stock_level(v_uid, p_org);
  if p_need = 'owner' and not (v_owner or v_super) then
    raise exception 'Not allowed: only the owner can do this.' using errcode = '42501';
  end if;
  if p_need <> 'read' then
    perform set_config('servos.stock_co_write', txid_current()::text, true);
  end if;
  select count(*) filter (where coalesce(l.status, 'active') = 'active') into v_open from locations l where l.org_id = p_org;
  select s.multi_since into v_since from stock_co_settings s where s.org_id = p_org;
  return jsonb_build_object('uid', v_uid, 'name', v_prof.name, 'level', v_level,
                            'multi', (coalesce(v_open, 0) >= 2 or v_since is not null), 'org_id', p_org);
end
$fn$;

-- The first of p_sites this login reaches (a save that names only a company record works from it).
-- Owner only.
create or replace function public.stock_co__reached_site(p_sites uuid[])
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v uuid;
begin
  perform public.stock_co__signed_in();
  select s.id into v
    from unnest(coalesce(p_sites, '{}'::uuid[])) s(id)
   where s.id is not null and s.id::text in (select public.stock_reach_locations())
   order by s.id
   limit 1;
  if v is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  return v;
end
$fn$;

-- "Someone saved first": nothing written, the other person and the version now. Owner only.
create or replace function public.stock_co__conflict(p_org uuid, p_entities text[], p_id uuid, p_row_version integer,
                                                     p_loc uuid, p_at timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_c record;
  v_at timestamptz;
  v_name text;
  v_tz text;
begin
  select c.who, c.who_name, c.at into v_c
    from stock_change_log c
   where c.org_id = p_org and c.entity = any(p_entities) and c.entity_id = p_id
   order by c.at desc, c.id desc
   limit 1;
  v_at := coalesce(v_c.at, p_at, now());
  v_name := coalesce(nullif(btrim(coalesce(v_c.who_name, '')), ''), 'Someone else');
  select coalesce(nullif(l.timezone, ''), 'Europe/London') into v_tz from locations l where l.id = p_loc;
  return jsonb_build_object(
    'ok', false,
    'conflict', jsonb_build_object('entity', p_entities[1], 'id', p_id, 'by', v_c.who, 'by_name', v_name, 'at', v_at,
                                   'row_version', p_row_version),
    'error', v_name || ' saved this first at ' || to_char(v_at at time zone coalesce(v_tz, 'Europe/London'), 'HH24:MI')
             || '. Reload to see the change, then save again.');
end
$fn$;

-- One change log row per changed field (a new record: one row, field 'created'). Returns the last id,
-- null when nothing changed. Owner only.
create or replace function public.stock_co__log_diff(p_org uuid, p_loc uuid, p_entity text, p_id uuid, p_before jsonb,
                                                     p_after jsonb, p_source text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_skip text[] := array['updated_at', 'row_version', 'created_at', 'updated_by'];
  v_last bigint;
  k text;
begin
  if p_after is null then
    return null;
  end if;
  if p_before is null then
    return public.stock_co__log(p_org, p_loc, p_entity, p_id, 'created', null, p_after - v_skip, p_source);
  end if;
  for k in select x from jsonb_object_keys(p_after) x where not (x = any(v_skip)) order by x loop
    if (p_before -> k) is distinct from (p_after -> k) then
      v_last := public.stock_co__log(p_org, p_loc, p_entity, p_id, k, p_before -> k, p_after -> k, p_source);
    end if;
  end loop;
  return v_last;
end
$fn$;

-- The site steps of one save: the caller's own site first (never queued), then every other site in
-- its own block with a 200 ms lock wait; a site that cannot get its locks, or any site after 1.5 s of
-- the call, goes to the save queue (kind 'site_sync'). The lock wait is put back after. Owner only.
create or replace function public.stock_co__run_sites(p_org uuid, p_own uuid, p_sites uuid[], p_item_ids uuid[],
                                                      p_supplier_ids uuid[], p_recipe_ids uuid[], p_log_id bigint,
                                                      p_t0 timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_prev text := current_setting('lock_timeout');
  v_set boolean := false;
  v_items uuid[] := coalesce(p_item_ids, '{}'::uuid[]);
  v_sups uuid[] := coalesce(p_supplier_ids, '{}'::uuid[]);
  v_recs uuid[] := coalesce(p_recipe_ids, '{}'::uuid[]);
  v_loc uuid;
  v_r jsonb;
  v_rr jsonb;
  v_reason text;
  v_job bigint;
  v_written integer := 0;
  v_queued jsonb := '[]'::jsonb;
  v_cost jsonb := '[]'::jsonb;
  v_rcost jsonb := '[]'::jsonb;
begin
  for v_loc in
    select x.id from (select distinct u.id from unnest(coalesce(p_sites, '{}'::uuid[]) || p_own) u(id) where u.id is not null) x
     order by (x.id = p_own) desc, x.id
  loop
    v_r := null;
    v_rr := null;
    v_reason := null;
    if v_loc = p_own then
      if cardinality(v_items) > 0 or cardinality(v_sups) > 0 then
        v_r := public.stock_co__sync_site(v_loc, v_items, v_sups, true, false);
      end if;
      if cardinality(v_recs) > 0 then
        v_rr := public.stock_co__sync_recipes(v_loc, v_recs, true, false);
      end if;
      v_written := v_written + 1;
    elsif clock_timestamp() - p_t0 > interval '1500 milliseconds' then
      v_reason := 'budget';
    else
      begin
        perform set_config('lock_timeout', '200ms', true);
        v_set := true;
        if cardinality(v_items) > 0 or cardinality(v_sups) > 0 then
          v_r := public.stock_co__sync_site(v_loc, v_items, v_sups, true, false);
        end if;
        if cardinality(v_recs) > 0 then
          v_rr := public.stock_co__sync_recipes(v_loc, v_recs, true, false);
        end if;
        v_written := v_written + 1;
      exception when lock_not_available or deadlock_detected then
        v_reason := 'lock';
        v_r := null;
        v_rr := null;
      end;
    end if;
    if v_reason is not null then
      v_job := public.stock_co__enqueue(p_org, v_loc, 'site_sync',
                 jsonb_build_object('item_ids', to_jsonb(v_items), 'supplier_ids', to_jsonb(v_sups), 'recipe_ids', to_jsonb(v_recs),
                                    'change_log_id', p_log_id, 'reason', v_reason),
                 v_items || v_sups || v_recs);
      v_queued := v_queued || jsonb_build_array(jsonb_build_object('location_id', v_loc, 'job_id', v_job));
    else
      v_cost := v_cost || coalesce((select jsonb_agg(e || jsonb_build_object('location_id', v_loc))
                                      from jsonb_array_elements(coalesce(v_r -> 'cost' -> 'items', '[]'::jsonb)) e), '[]'::jsonb);
      v_rcost := v_rcost || coalesce((select jsonb_agg(e || jsonb_build_object('location_id', v_loc))
                                        from jsonb_array_elements(coalesce(v_rr -> 'cost' -> 'items', '[]'::jsonb)) e), '[]'::jsonb);
    end if;
  end loop;
  if v_set then
    perform set_config('lock_timeout', v_prev, true);
  end if;
  return jsonb_build_object('sites_written', v_written, 'queued', v_queued, 'cost', v_cost, 'recipe_cost', v_rcost);
end
$fn$;

-- A company item set up at one more site: its site row (on hand 0, no cost) and its link, and its first
-- area when another site keeps it in an area of a kind this site has exactly one of. The save functions
-- call it (a link needs its site row first). Owner only.
create or replace function public.stock_co__new_site_item(p_item uuid, p_loc uuid, p_mode text, p_counted boolean)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_i record;
  v_org uuid;
  v_id uuid := gen_random_uuid();
begin
  select i.* into v_i from stock_co_items i where i.id = p_item;
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_i.id is null or v_org is null or v_org is distinct from v_i.org_id then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  insert into inventory_items (id, location_id, org_id, name, kind, base_unit, accounting_group, category, is_tracked, on_hand,
                               current_cost, allergens, shelf_life_days, sku, barcode, purchase_tax_rate_id, returns_to_shelf,
                               archived_at, company_ref)
  values (v_id, p_loc, v_org, v_i.name, case coalesce(p_mode, 'bought') when 'bought' then 'PURCHASED' else 'MADE' end,
          v_i.base_unit, v_i.accounting_group, v_i.category, coalesce(p_counted, true), 0, null,
          coalesce(v_i.allergens, '[]'::jsonb), v_i.shelf_life_days, v_i.sku, v_i.barcode,
          public.stock_co__rate_id_for(p_loc, v_i.purchase_vat_rate, null), coalesce(v_i.returns_to_shelf, false), null, v_i.id);
  insert into stock_co_item_sites (item_id, org_id, location_id, site_item_id, on_here, supply_mode, counted_here)
  values (p_item, v_org, p_loc, v_id, true, coalesce(p_mode, 'bought'), coalesce(p_counted, true));
  insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary)
  select p_loc, v_id, (select a.id from storage_areas a where a.location_id = p_loc and a.archived_at is null and a.kind = k.kind), true
    from (select a2.kind
            from stock_co_item_sites s2
            join inventory_item_areas ia on ia.inventory_item_id = s2.site_item_id and ia.is_primary
            join storage_areas a2 on a2.id = ia.area_id
           where s2.item_id = p_item and s2.location_id <> p_loc
           order by s2.location_id
           limit 1) k
   where (select count(*) from storage_areas a where a.location_id = p_loc and a.archived_at is null and a.kind = k.kind) = 1;
  return v_id;
end
$fn$;

-- A company supplier set up at one more site: its site row and its link. Owner only.
create or replace function public.stock_co__new_site_supplier(p_supplier uuid, p_loc uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_m record;
  v_org uuid;
  v_id uuid := gen_random_uuid();
begin
  select m.* into v_m from stock_co_suppliers m where m.id = p_supplier;
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_m.id is null or v_org is null or v_org is distinct from v_m.org_id then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  insert into suppliers (id, location_id, org_id, name, contact_name, phone, payment_terms_days, email, delivery_days,
                         archived_at, company_ref)
  values (v_id, p_loc, v_org, v_m.name, v_m.contact_name, v_m.phone, v_m.payment_terms_days, v_m.email, '[]'::jsonb,
          null, v_m.id);
  insert into stock_co_supplier_sites (supplier_id, org_id, location_id, site_supplier_id)
  values (p_supplier, v_org, p_loc, v_id);
  return v_id;
end
$fn$;

-- A company recipe set up at one more site: its site recipe (no lines yet: the recipe writer adds
-- them) and its link. Owner only.
create or replace function public.stock_co__new_site_recipe(p_recipe uuid, p_loc uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_r record;
  v_org uuid;
  v_out uuid;
  v_id uuid := gen_random_uuid();
begin
  select r.* into v_r from stock_co_recipes r where r.id = p_recipe;
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_r.id is null or v_org is null or v_org is distinct from v_r.org_id then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  if v_r.output_item_id is not null then
    select s.site_item_id into v_out from stock_co_item_sites s where s.item_id = v_r.output_item_id and s.location_id = p_loc;
    if v_out is null then
      raise exception 'This recipe makes an item that is not set up at that site. Add the item there first.' using errcode = '55000';
    end if;
  end if;
  insert into recipes (id, location_id, name, recipe_type, output_item_id, yield_qty, yield_unit, wastage_pct, gp_target_pct,
                       method, photo, status, archived_at, company_ref)
  values (v_id, p_loc, v_r.name, case v_r.kind when 'dish' then 'MENU' when 'batch' then 'BATCH' else 'PREP' end, v_out,
          coalesce(v_r.yield_qty, 1), coalesce(nullif(v_r.yield_unit, ''), 'each'), coalesce(v_r.wastage_pct, 0), v_r.gp_target_pct,
          v_r.method, v_r.photo, 'active', null, v_r.id);
  insert into stock_co_recipe_sites (recipe_id, org_id, location_id, on_here, site_recipe_id)
  values (p_recipe, v_org, p_loc, true, v_id);
  return v_id;
end
$fn$;

-- The unit dimensions an item's live bridges at one site connect to its base unit's dimension, leaving
-- out one bridge (p_skip, a site bridge id, or null). Owner only.
create or replace function public.stock_co__dims_reached(p_item uuid, p_skip uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with recursive
  b as (select uf.dimension as df, ut.dimension as dt
          from inventory_item_conversions c
          join stock_units uf on uf.code = lower(btrim(c.from_unit))
          join stock_units ut on ut.code = lower(btrim(c.to_unit))
         where c.inventory_item_id = p_item and c.archived_at is null and c.from_qty > 0 and c.to_qty > 0
           and (p_skip is null or c.id <> p_skip)),
  r(d) as (select u.dimension from inventory_items i join stock_units u on u.code = lower(btrim(i.base_unit)) where i.id = p_item
           union
           select case when b.df = r.d then b.dt else b.df end from r join b on b.df = r.d or b.dt = r.d)
  select coalesce(array_agg(distinct r.d), '{}'::text[]) from r;
$fn$;

-- True when, without this company bridge, a live recipe line or a live supplier pack of its item at
-- any site could no longer be turned into the item's base unit. Owner only.
create or replace function public.stock_co__bridge_needed(p_bridge uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  r record;
  v_all text[];
  v_wo text[];
begin
  for r in
    select bs.location_id, bs.site_bridge_id, c.inventory_item_id as item
      from stock_co_bridge_sites bs
      join inventory_item_conversions c on c.id = bs.site_bridge_id
     where bs.bridge_id = p_bridge
  loop
    v_all := public.stock_co__dims_reached(r.item, null);
    v_wo := public.stock_co__dims_reached(r.item, r.site_bridge_id);
    if exists (
      select 1
        from (select rl.unit from recipe_lines rl join recipes rr on rr.id = rl.recipe_id
               where rl.location_id = r.location_id and rl.component_item_id = r.item and rr.archived_at is null
                 and rl.unit not like '@%'
              union
              select sp.inner_unit from supplier_products sp
               where sp.location_id = r.location_id and sp.inventory_item_id = r.item and sp.archived_at is null) x
        join stock_units u on u.code = lower(btrim(x.unit))
       where u.dimension = any(v_all) and not (u.dimension = any(v_wo))) then
      return true;
    end if;
  end loop;
  return false;
end
$fn$;

-- The company id of a record named by its company id or by a site row id; null when neither. A site
-- row id resolves through its LINK ROW (stock_co_*_sites, written only by definer functions), never
-- through the site row's own company_ref (review fix, 20 Oct: a signed in login could write
-- company_ref before 0b, and point its own row at another site's record). Owner only.
create or replace function public.stock_co__company_id(p_kind text, p_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case p_kind
    when 'item' then coalesce((select x.id from stock_co_items x where x.id = p_id),
                              (select s.item_id from stock_co_item_sites s where s.site_item_id = p_id))
    when 'supplier' then coalesce((select x.id from stock_co_suppliers x where x.id = p_id),
                                  (select s.supplier_id from stock_co_supplier_sites s where s.site_supplier_id = p_id))
    when 'supplier_item' then coalesce((select x.id from stock_co_supplier_items x where x.id = p_id),
                                       (select s.supplier_item_id from stock_co_supplier_item_sites s
                                         where s.site_supplier_product_id = p_id))
    when 'pack' then coalesce((select x.id from stock_co_packs x where x.id = p_id),
                              (select s.pack_id from stock_co_pack_sites s where s.site_pack_id = p_id))
    when 'bridge' then coalesce((select x.id from stock_co_bridges x where x.id = p_id),
                                (select s.bridge_id from stock_co_bridge_sites s where s.site_bridge_id = p_id))
    when 'recipe' then coalesce((select x.id from stock_co_recipes x where x.id = p_id),
                                (select s.recipe_id from stock_co_recipe_sites s where s.site_recipe_id = p_id))
  end;
$fn$;

-- The site of a site row named by its id, through its link row (never the row's own location_id or
-- company_ref, which a signed in login could change before 0b); null when the row has no link.
-- Owner only.
create or replace function public.stock_co__site_loc(p_kind text, p_site_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case p_kind
    when 'item' then (select s.location_id from stock_co_item_sites s where s.site_item_id = p_site_id)
    when 'supplier' then (select s.location_id from stock_co_supplier_sites s where s.site_supplier_id = p_site_id)
    when 'supplier_item' then (select s.location_id from stock_co_supplier_item_sites s where s.site_supplier_product_id = p_site_id)
    when 'pack' then (select s.location_id from stock_co_pack_sites s where s.site_pack_id = p_site_id)
    when 'bridge' then (select s.location_id from stock_co_bridge_sites s where s.site_bridge_id = p_site_id)
    when 'recipe' then (select s.location_id from stock_co_recipe_sites s where s.site_recipe_id = p_site_id)
  end;
$fn$;

-- True when a company item is set up at that site (its link there, or a local record of that site).
-- A pack or unit bridge save names the site it is made from; the guard checks that site, and the
-- writer then writes every site of the item, so the item must be set up at the named site (review
-- fix, 20 Oct: a Location 2 login could change Provo's packs through an item set up only at Provo).
-- Owner only.
create or replace function public.stock_co__item_at(p_item uuid, p_loc uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_item is not null and p_loc is not null
     and (exists (select 1 from stock_co_item_sites s where s.item_id = p_item and s.location_id = p_loc)
          or exists (select 1 from stock_co_items x where x.id = p_item and x.local_location_id = p_loc));
$fn$;

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------
-- Company item save (contract 3.4). A new item is ticked at location_id only (one site company: a
-- company record; multi site company: a local record there). The site values apply at location_id.
-- Sections: inventory.
create or replace function public.stock_save_item(p_item jsonb, p_sites jsonb default null, p_version integer default null,
                                                  p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_d jsonb := public.stock_co__clean('item', p_item);
  v_site jsonb;
  v_co jsonb;
  v_loc uuid;
  v_id uuid;
  v_sid uuid;
  v_sloc uuid;
  v_srv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_items;
  v_new stock_co_items;
  v_created boolean := false;
  v_rate numeric;
  v_before_site jsonb;
  v_after_site jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_log bigint;
  v_l2 bigint;
  v_run jsonb;
  v_rv integer;
  v_row inventory_items;
begin
  if p_sites is not null and jsonb_typeof(p_sites) <> 'null' then
    raise exception 'Choosing the sites of an item comes with the company stock list.' using errcode = '22023';
  end if;
  v_site := coalesce(v_d -> 'site', '{}'::jsonb);
  if v_d ? 'id' and v_d ? 'site_item_id' then
    raise exception 'Send the item id or the site item id, not both.' using errcode = '22023';
  end if;
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_item_id')::uuid;
  v_id := public.stock_co__company_id('item', coalesce((v_d ->> 'id')::uuid, v_sid));
  if (v_d ->> 'id') is not null and v_id is distinct from (v_d ->> 'id')::uuid then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_sid is not null then
    if v_loc is null then
      raise exception 'location_id is needed with site_item_id.' using errcode = '22023';
    end if;
    select s.location_id, t.row_version into v_sloc, v_srv
      from stock_co_item_sites s join inventory_items t on t.id = s.site_item_id
     where s.site_item_id = v_sid and s.item_id = v_id;
    if v_id is null or v_sloc is null or v_sloc <> v_loc then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  if v_id is not null then
    select * into v_old from stock_co_items x where x.id = v_id;
    v_org := v_old.org_id;
    if v_loc is null then
      v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_id)
                                             || v_old.local_location_id);
    end if;
  else
    if (v_d ->> 'id') is not null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    if v_loc is null then
      raise exception 'A new item needs its site (location_id).' using errcode = '22023';
    end if;
    select l.org_id into v_org from locations l where l.id = v_loc;
    if v_org is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[v_loc]);

  if v_id is not null then
    select * into v_old from stock_co_items x where x.id = v_id for update;
    if p_version is not null then
      if v_sid is not null then
        select t.row_version into v_srv from inventory_items t where t.id = v_sid;
        if v_srv is distinct from p_version then
          return public.stock_co__conflict(v_org, array['item', 'item_site'], v_id, v_srv, v_loc, v_old.updated_at);
        end if;
      elsif v_old.row_version is distinct from p_version then
        return public.stock_co__conflict(v_org, array['item', 'item_site'], v_id, v_old.row_version, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;

  -- company fields: the VAT rate is stored as its value, from a rate row of this site or as a fraction
  if v_d ? 'purchase_tax_rate_id' and v_d ? 'purchase_vat_rate' then
    raise exception 'Send the VAT rate row or the VAT rate, not both.' using errcode = '22023';
  end if;
  v_co := v_d - array['id', 'site_item_id', 'location_id', 'site', 'purchase_tax_rate_id', 'purchase_vat_rate'];
  if v_d ? 'purchase_tax_rate_id' then
    v_rate := null;
    if (v_d ->> 'purchase_tax_rate_id') is not null then
      select r.rate into v_rate from tax_rates r where r.id = (v_d ->> 'purchase_tax_rate_id')::uuid and r.location_id = v_loc;
      if not found then
        raise exception 'That VAT rate is not one of this venue''s rates.' using errcode = '22023';
      end if;
    end if;
    v_co := v_co || jsonb_build_object('purchase_vat_rate', v_rate);
  elsif v_d ? 'purchase_vat_rate' then
    v_co := v_co || jsonb_build_object('purchase_vat_rate', v_d -> 'purchase_vat_rate');
  end if;

  if v_id is null then
    if coalesce(v_co ->> 'name', '') = '' or (v_co ->> 'base_unit') is null then
      raise exception 'A new item needs a name and a base unit.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_items,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org,
                                  'local_location_id', case when (v_g ->> 'multi')::boolean then v_loc end,
                                  'allergens', '[]'::jsonb, 'returns_to_shelf', false, 'exclude_from_gp', false, 'key_item', false,
                                  'row_version', 1, 'created_at', now(), 'updated_at', now(), 'updated_by', v_g ->> 'uid') || v_co);
    insert into stock_co_items select (v_new).*;
    v_id := v_new.id;
    v_created := true;
    v_sid := public.stock_co__new_site_item(v_id, v_loc,
               case when v_site ->> 'kind' = 'MADE' then 'batches' else 'bought' end,
               coalesce((v_site ->> 'is_tracked')::boolean, true));
    v_log := public.stock_co__log_diff(v_org, null, 'item', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.allergens := coalesce(v_new.allergens, '[]'::jsonb);
    v_new.returns_to_shelf := coalesce(v_new.returns_to_shelf, false);
    v_new.exclude_from_gp := coalesce(v_new.exclude_from_gp, false);
    v_new.key_item := coalesce(v_new.key_item, false);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    v_new.updated_by := (v_g ->> 'uid')::uuid;
    update stock_co_items x
       set (name, category, accounting_group, type, base_unit, sku, barcode, shelf_life_days, purchase_vat_rate, allergens,
            returns_to_shelf, exclude_from_gp, key_item, notes, row_version, updated_at, updated_by)
         = (v_new.name, v_new.category, v_new.accounting_group, v_new.type, v_new.base_unit, v_new.sku, v_new.barcode,
            v_new.shelf_life_days, v_new.purchase_vat_rate, v_new.allergens, v_new.returns_to_shelf, v_new.exclude_from_gp,
            v_new.key_item, v_new.notes, v_new.row_version, v_new.updated_at, v_new.updated_by)
     where x.id = v_id;
    select s.site_item_id into v_sid from stock_co_item_sites s where s.item_id = v_id and s.location_id = v_loc;
    if v_sid is null then
      raise exception 'This item is not set up at that site.' using errcode = '22023';
    end if;
    v_log := public.stock_co__log_diff(v_org, null, 'item', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
  end if;

  -- the site values at location_id: kind and is_tracked through the link, the rest on the site row
  if v_site <> '{}'::jsonb then
    if (v_site ->> 'default_supplier_id') is not null
       and not exists (select 1 from suppliers s where s.id = (v_site ->> 'default_supplier_id')::uuid and s.location_id = v_loc) then
      raise exception 'That supplier is not set up at this site.' using errcode = '22023';
    end if;
    perform 1 from inventory_items t where t.id = v_sid for no key update;
    select jsonb_build_object('supply_mode', s.supply_mode, 'counted_here', s.counted_here, 'is_sellable', t.is_sellable,
                              'cost_method', t.cost_method, 'storage_location', t.storage_location,
                              'default_supplier_id', t.default_supplier_id, 'notes', t.notes)
      into v_before_site
      from stock_co_item_sites s join inventory_items t on t.id = s.site_item_id
     where s.item_id = v_id and s.location_id = v_loc;
    update stock_co_item_sites s
       set supply_mode = case when not (v_site ? 'kind') then s.supply_mode
                              when v_site ->> 'kind' = 'MADE' then case when s.supply_mode = 'bought' then 'batches' else s.supply_mode end
                              else 'bought' end,
           counted_here = case when v_site ? 'is_tracked' then (v_site ->> 'is_tracked')::boolean else s.counted_here end,
           row_version = s.row_version + 1, updated_at = now()
     where s.item_id = v_id and s.location_id = v_loc
       and (s.supply_mode, s.counted_here) is distinct from (
             case when not (v_site ? 'kind') then s.supply_mode
                  when v_site ->> 'kind' = 'MADE' then case when s.supply_mode = 'bought' then 'batches' else s.supply_mode end
                  else 'bought' end,
             case when v_site ? 'is_tracked' then (v_site ->> 'is_tracked')::boolean else s.counted_here end);
    update inventory_items t
       set is_sellable = case when v_site ? 'is_sellable' then (v_site ->> 'is_sellable')::boolean else t.is_sellable end,
           cost_method = case when v_site ? 'cost_method' then v_site ->> 'cost_method' else t.cost_method end,
           storage_location = case when v_site ? 'storage_location' then v_site ->> 'storage_location' else t.storage_location end,
           default_supplier_id = case when v_site ? 'default_supplier_id' then (v_site ->> 'default_supplier_id')::uuid else t.default_supplier_id end,
           notes = case when v_site ? 'notes' then v_site ->> 'notes' else t.notes end,
           row_version = t.row_version + 1, updated_at = now()
     where t.id = v_sid and t.location_id = v_loc
       and (t.is_sellable, t.cost_method, t.storage_location, t.default_supplier_id, t.notes) is distinct from (
             case when v_site ? 'is_sellable' then (v_site ->> 'is_sellable')::boolean else t.is_sellable end,
             case when v_site ? 'cost_method' then v_site ->> 'cost_method' else t.cost_method end,
             case when v_site ? 'storage_location' then v_site ->> 'storage_location' else t.storage_location end,
             case when v_site ? 'default_supplier_id' then (v_site ->> 'default_supplier_id')::uuid else t.default_supplier_id end,
             case when v_site ? 'notes' then v_site ->> 'notes' else t.notes end);
    select jsonb_build_object('supply_mode', s.supply_mode, 'counted_here', s.counted_here, 'is_sellable', t.is_sellable,
                              'cost_method', t.cost_method, 'storage_location', t.storage_location,
                              'default_supplier_id', t.default_supplier_id, 'notes', t.notes)
      into v_after_site
      from stock_co_item_sites s join inventory_items t on t.id = s.site_item_id
     where s.item_id = v_id and s.location_id = v_loc;
    if not v_created then
      v_l2 := public.stock_co__log_diff(v_org, v_loc, 'item_site', v_id, v_before_site, v_after_site, v_src);
      v_log := coalesce(v_l2, v_log);
    end if;
  end if;

  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_id),
                                      array[v_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  -- the VAT rate row picked on this site's screen stays the one picked (same rate value, so the writer keeps it)
  if (v_d ->> 'purchase_tax_rate_id') is not null then
    update inventory_items t
       set purchase_tax_rate_id = (v_d ->> 'purchase_tax_rate_id')::uuid, row_version = t.row_version + 1, updated_at = now()
     where t.id = v_sid and t.location_id = v_loc and t.purchase_tax_rate_id is distinct from (v_d ->> 'purchase_tax_rate_id')::uuid;
  end if;

  if (v_d ->> 'site_item_id') is not null then
    select t.row_version into v_rv from inventory_items t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update inventory_items t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from inventory_items t where t.id = v_sid;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'created', v_created,
                            'local_location_id', v_new.local_location_id, 'site_item_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'sites_written', v_run -> 'sites_written', 'queued', v_run -> 'queued');
end
$fn$;

-- Archive (or restore) a company item and every linked site row. Refused while any site holds stock or
-- a live recipe uses it. Sections: inventory.
create or replace function public.stock_archive_item(p_item uuid, p_version integer default null, p_archived boolean default true,
                                                     p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_id uuid := public.stock_co__company_id('item', p_item);
  v_old stock_co_items;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_bad text;
  v_n integer;
  v_at timestamptz;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_items x where x.id = v_id;
  if p_item <> v_id then
    v_loc := public.stock_co__site_loc('item', p_item);
    select t.row_version into v_srv from inventory_items t where t.id = p_item;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_id)
                                           || v_old.local_location_id);
  end if;
  v_g := public.stock_co__guard(v_old.org_id, v_section, 'company', array[v_loc]);
  select * into v_old from stock_co_items x where x.id = v_id for update;
  if p_version is not null then
    v_rv := case when p_item <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_old.org_id, array['item', 'item_site'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  if coalesce(p_archived, true) then
    select format('Count it or write it off first: %s holds %s %s.', l.name, trim_scale(t.on_hand), t.base_unit)
      into v_bad
      from stock_co_item_sites s
      join inventory_items t on t.id = s.site_item_id
      join locations l on l.id = s.location_id
     where s.item_id = v_id and coalesce(t.on_hand, 0) <> 0
     order by l.name
     limit 1;
    if v_bad is not null then
      raise exception '%', v_bad using errcode = '55000';
    end if;
    select count(*) into v_n from (
      select coalesce(r.company_ref, r.id) as rid
        from recipe_lines rl
        join recipes r on r.id = rl.recipe_id
       where rl.component_item_id in (select s.site_item_id from stock_co_item_sites s where s.item_id = v_id)
         and r.archived_at is null
      union
      select l.recipe_id
        from stock_co_recipe_lines l
        join stock_co_recipes r on r.id = l.recipe_id
       where l.component_item_id = v_id and r.archived_at is null) u;
    if v_n > 0 then
      raise exception 'Used in % recipes. Swap it out first.', v_n using errcode = '55000';
    end if;
    v_at := coalesce(v_old.archived_at, now());
  else
    v_at := null;
  end if;
  update stock_co_items x
     set archived_at = v_at, row_version = x.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
   where x.id = v_id
  returning x.row_version into v_rv;
  v_log := public.stock_co__log(v_old.org_id, null, 'item', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_old.org_id, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_id),
                                      array[v_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  if p_item <> v_id then
    update inventory_items t set row_version = t.row_version + 1 where t.id = p_item and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_item_sites s where s.item_id = v_id),
                            'queued', v_run -> 'queued');
end
$fn$;

-- Site values of one item at one site (Drop 0 keys: par, reorder point, minimum, area with the holding
-- moved, counted here). The version is the item's site link (stock_co_item_sites.row_version), the
-- one stock_item_detail shows. Sections: inventory.
create or replace function public.stock_save_item_site(p_item uuid, p_location uuid, p_patch jsonb, p_version integer default null,
                                                       p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_d jsonb := public.stock_co__clean('item_site_patch', p_patch);
  v_id uuid := public.stock_co__company_id('item', p_item);
  v_org uuid;
  v_link stock_co_item_sites;
  v_item inventory_items;
  v_g jsonb;
  v_par record;
  v_pl numeric;
  v_rp numeric;
  v_ml numeric;
  v_old_area uuid;
  v_new_area uuid;
  v_area_row uuid;
  v_moved numeric := 0;
  v_qty numeric;
  v_tr uuid;
  v_ref text;
  v_res jsonb;
  v_by text;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_before jsonb;
  v_after jsonb;
  v_rv integer;
begin
  if v_id is null or p_location is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_item <> v_id and public.stock_co__site_loc('item', p_item) is distinct from p_location then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select x.org_id into v_org from stock_co_items x where x.id = v_id;
  select * into v_link from stock_co_item_sites s where s.item_id = v_id and s.location_id = p_location;
  if v_link.item_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'site_facts', array[p_location]);
  select * into v_item from inventory_items t where t.id = v_link.site_item_id for no key update;
  select * into v_link from stock_co_item_sites s where s.item_id = v_id and s.location_id = p_location for update;
  if p_version is not null and v_link.row_version is distinct from p_version then
    return public.stock_co__conflict(v_org, array['item_site', 'item'], v_id, v_link.row_version, p_location, v_link.updated_at);
  end if;
  v_by := coalesce(v_d ->> 'by_name', v_g ->> 'name');
  select par_level, reorder_point, min_level into v_par from par_levels p
   where p.location_id = p_location and p.inventory_item_id = v_item.id;
  select ia.area_id into v_old_area from inventory_item_areas ia
   where ia.location_id = p_location and ia.inventory_item_id = v_item.id and ia.is_primary
   limit 1;
  v_before := jsonb_build_object('par_level', v_par.par_level, 'reorder_point', v_par.reorder_point, 'min_level', v_par.min_level,
                                 'area_id', v_old_area, 'counted_here', v_link.counted_here);

  -- pars: a key left out keeps its value, an explicit null clears it, all three are always written
  if v_d ? 'par_level' or v_d ? 'reorder_point' or v_d ? 'min_level' then
    v_pl := case when v_d ? 'par_level' then (v_d ->> 'par_level')::numeric else v_par.par_level end;
    v_rp := case when v_d ? 'reorder_point' then (v_d ->> 'reorder_point')::numeric else v_par.reorder_point end;
    v_ml := case when v_d ? 'min_level' then (v_d ->> 'min_level')::numeric else v_par.min_level end;
    insert into par_levels (location_id, inventory_item_id, par_level, reorder_point, min_level, updated_at)
    values (p_location, v_item.id, v_pl, v_rp, v_ml, now())
    on conflict (location_id, inventory_item_id)
      do update set par_level = excluded.par_level, reorder_point = excluded.reorder_point, min_level = excluded.min_level,
                    updated_at = now();
  end if;

  -- the use area; the old area's holding moves with it as a within venue transfer
  if v_d ? 'area_id' then
    v_new_area := (v_d ->> 'area_id')::uuid;
    if v_new_area is not null
       and not exists (select 1 from storage_areas a where a.id = v_new_area and a.location_id = p_location and a.archived_at is null) then
      raise exception 'That area is not one of this venue''s live areas.' using errcode = '22023';
    end if;
    if v_new_area is distinct from v_old_area then
      if v_new_area is null then
        delete from inventory_item_areas ia
         where ia.location_id = p_location and ia.inventory_item_id = v_item.id and ia.is_primary;
      else
        select ia.id into v_area_row from inventory_item_areas ia
         where ia.location_id = p_location and ia.inventory_item_id = v_item.id and ia.is_primary
         limit 1;
        if v_area_row is not null then
          update inventory_item_areas ia set area_id = v_new_area where ia.id = v_area_row;
        else
          insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary)
          values (p_location, v_item.id, v_new_area, true);
        end if;
        if coalesce((v_d ->> 'move_holding')::boolean, true) and v_old_area is not null then
          select coalesce(s.on_hand, 0) into v_qty from inventory_item_area_stock s
           where s.inventory_item_id = v_item.id and s.area_id = v_old_area;
          if coalesce(v_qty, 0) > 0 then
            v_ref := 'TR-' || (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::integer, 1), '')
                                 from generate_series(1, 6));
            insert into stock_transfers (location_id, to_location_id, from_area_id, to_area_id, status, reference, note, created_by_name)
            values (p_location, null, v_old_area, v_new_area, 'DRAFT', v_ref, 'Area changed', v_by)
            returning id into v_tr;
            insert into stock_transfer_lines (transfer_id, location_id, to_location_id, inventory_item_id, name_snapshot, sku_snapshot,
                                              base_unit, qty_base, sort_order)
            values (v_tr, p_location, null, v_item.id, v_item.name, v_item.sku, v_item.base_unit, v_qty, 0);
            v_res := public.post_stock_transfer_leg(v_tr, 'both', v_by);
            if not coalesce((v_res ->> 'ok')::boolean, false) then
              raise exception 'The area was not changed: its stock could not be moved (%).', coalesce(v_res ->> 'error', 'refused')
                using errcode = '55000';
            end if;
            v_moved := v_qty;
          end if;
        end if;
      end if;
    end if;
  end if;

  -- counted here: the link, then the writer sets is_tracked at this site
  update stock_co_item_sites s
     set counted_here = case when v_d ? 'counted_here' then (v_d ->> 'counted_here')::boolean else s.counted_here end,
         row_version = s.row_version + 1, updated_at = now()
   where s.item_id = v_id and s.location_id = p_location
  returning s.row_version into v_rv;
  if v_d ? 'counted_here' and (v_d ->> 'counted_here')::boolean is distinct from v_link.counted_here then
    perform public.stock_co__sync_site(p_location, array[v_id], '{}'::uuid[], true, false);
  end if;

  select p.par_level, p.reorder_point, p.min_level into v_par from par_levels p
   where p.location_id = p_location and p.inventory_item_id = v_item.id;
  select ia.area_id into v_new_area from inventory_item_areas ia
   where ia.location_id = p_location and ia.inventory_item_id = v_item.id and ia.is_primary
   limit 1;
  v_after := jsonb_build_object('par_level', v_par.par_level, 'reorder_point', v_par.reorder_point, 'min_level', v_par.min_level,
                                'area_id', v_new_area,
                                'counted_here', case when v_d ? 'counted_here' then (v_d ->> 'counted_here')::boolean else v_link.counted_here end);
  perform public.stock_co__log_diff(v_org, p_location, 'item_site', v_id, v_before, v_after, v_src);
  return jsonb_build_object('ok', true, 'item_id', v_id, 'location_id', p_location, 'row_version', v_rv,
                            'par', jsonb_build_object('par_level', v_par.par_level, 'reorder_point', v_par.reorder_point,
                                                      'min_level', v_par.min_level),
                            'area_id', v_new_area, 'moved_qty', v_moved, 'counted_here', v_after -> 'counted_here',
                            'queued', '[]'::jsonb);
end
$fn$;

-- ---------------------------------------------------------------------------
-- Packs
-- ---------------------------------------------------------------------------
-- Company pack and its site rows. One count default and one buy default per item. Sections: inventory.
create or replace function public.stock_save_pack(p_pack jsonb, p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_d jsonb := public.stock_co__clean('pack', p_pack);
  v_id uuid;
  v_item uuid;
  v_parent uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_packs;
  v_new stock_co_packs;
  v_co jsonb;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row item_packaging_formats;
begin
  if (v_d ? 'id' and v_d ? 'site_pack_id') or (v_d ? 'item_id' and v_d ? 'site_item_id')
     or (v_d ? 'parent_pack_id' and v_d ? 'site_parent_pack_id') then
    raise exception 'Send the company id or the site id of a field, not both.' using errcode = '22023';
  end if;
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_pack_id')::uuid;
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('pack', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_packs x where x.id = v_id;
    v_item := v_old.item_id;
    if v_sid is not null then
      select t.row_version into v_srv from item_packaging_formats t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('pack', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    end if;
  end if;
  if v_d ? 'item_id' or v_d ? 'site_item_id' then
    if v_item is not null and public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid)) is distinct from v_item then
      raise exception 'A pack cannot move to another item.' using errcode = '22023';
    end if;
    v_item := public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid));
  end if;
  if v_item is null then
    raise exception 'A pack needs its item.' using errcode = '22023';
  end if;
  select x.org_id into v_org from stock_co_items x where x.id = v_item;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_loc is null then
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_item));
  end if;
  if not public.stock_co__item_at(v_item, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[v_loc]);
  if v_id is not null then
    select * into v_old from stock_co_packs x where x.id = v_id for update;
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['pack'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;
  if v_d ? 'parent_pack_id' or v_d ? 'site_parent_pack_id' then
    v_parent := public.stock_co__company_id('pack', coalesce((v_d ->> 'parent_pack_id')::uuid, (v_d ->> 'site_parent_pack_id')::uuid));
    if coalesce((v_d ->> 'parent_pack_id'), (v_d ->> 'site_parent_pack_id')) is not null
       and (v_parent is null or v_parent is not distinct from v_id
            or not exists (select 1 from stock_co_packs x where x.id = v_parent and x.item_id = v_item)) then
      raise exception 'The parent pack must be another pack of the same item.' using errcode = '22023';
    end if;
  end if;
  v_co := v_d - array['id', 'site_pack_id', 'location_id', 'item_id', 'site_item_id', 'parent_pack_id', 'site_parent_pack_id'];
  if v_d ? 'parent_pack_id' or v_d ? 'site_parent_pack_id' then
    v_co := v_co || jsonb_build_object('parent_pack_id', v_parent);
  end if;
  if v_id is null then
    if coalesce(v_co ->> 'name', '') = '' or (v_co ->> 'qty_in_base') is null then
      raise exception 'A new pack needs a name and its size in the base unit.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_packs,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org, 'item_id', v_item, 'is_count_default', false,
                                  'is_purchase_default', false, 'row_version', 1, 'created_at', now(), 'updated_at', now()) || v_co);
    v_new.is_count_default := coalesce(v_new.is_count_default, false);
    v_new.is_purchase_default := coalesce(v_new.is_purchase_default, false);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
  end if;
  -- one count default and one buy default per item, on the company rows (the writer carries them)
  if v_new.is_count_default then
    update stock_co_packs x set is_count_default = false, row_version = x.row_version + 1, updated_at = now()
     where x.item_id = v_item and x.id is distinct from v_new.id and x.is_count_default;
  end if;
  if v_new.is_purchase_default then
    update stock_co_packs x set is_purchase_default = false, row_version = x.row_version + 1, updated_at = now()
     where x.item_id = v_item and x.id is distinct from v_new.id and x.is_purchase_default;
  end if;
  if v_id is null then
    insert into stock_co_packs select (v_new).*;
    v_id := v_new.id;
    v_log := public.stock_co__log_diff(v_org, null, 'pack', v_id, null, to_jsonb(v_new), v_src);
  else
    update stock_co_packs x
       set (name, qty_in_base, parent_pack_id, is_count_default, is_purchase_default, row_version, updated_at)
         = (v_new.name, v_new.qty_in_base, v_new.parent_pack_id, v_new.is_count_default, v_new.is_purchase_default,
            v_new.row_version, v_new.updated_at)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(v_org, null, 'pack', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
  end if;
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_item),
                                      array[v_item], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  select ps.site_pack_id into v_sid from stock_co_pack_sites ps where ps.pack_id = v_id and ps.location_id = v_loc;
  if (v_d ->> 'site_pack_id') is not null then
    select t.row_version into v_rv from item_packaging_formats t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update item_packaging_formats t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from item_packaging_formats t where t.id = v_sid;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_pack_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end, 'queued', v_run -> 'queued');
end
$fn$;

-- Archive (or restore) a company pack and its site rows; archiving clears both default flags. Refused
-- while any recipe line at any site is in that site's copy of the pack. Sections: inventory.
create or replace function public.stock_archive_pack(p_pack uuid, p_version integer default null, p_archived boolean default true,
                                                     p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_id uuid := public.stock_co__company_id('pack', p_pack);
  v_old stock_co_packs;
  v_org uuid;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_at timestamptz;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_packs x where x.id = v_id;
  v_org := v_old.org_id;
  if p_pack <> v_id then
    v_loc := public.stock_co__site_loc('pack', p_pack);
    select t.row_version into v_srv from item_packaging_formats t where t.id = p_pack;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id));
  end if;
  if not public.stock_co__item_at(v_old.item_id, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[v_loc]);
  select * into v_old from stock_co_packs x where x.id = v_id for update;
  if p_version is not null then
    v_rv := case when p_pack <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_org, array['pack'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  if coalesce(p_archived, true) then
    if exists (select 1 from stock_co_pack_sites ps
                 join recipe_lines rl on rl.location_id = ps.location_id and rl.unit = '@' || ps.site_pack_id::text
                where ps.pack_id = v_id)
       or exists (select 1 from stock_co_recipe_lines l join stock_co_recipes r on r.id = l.recipe_id
                   where l.pack_id = v_id and r.archived_at is null) then
      raise exception 'This pack is used in a recipe, so it cannot be archived. Change those recipe lines to another unit first.'
        using errcode = '55000';
    end if;
    v_at := coalesce(v_old.archived_at, now());
    update stock_co_packs x
       set archived_at = v_at, is_count_default = false, is_purchase_default = false,
           row_version = x.row_version + 1, updated_at = now()
     where x.id = v_id;
  else
    v_at := null;
    update stock_co_packs x set archived_at = null, row_version = x.row_version + 1, updated_at = now() where x.id = v_id;
  end if;
  v_log := public.stock_co__log(v_org, null, 'pack', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id),
                                      array[v_old.item_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  if p_pack <> v_id then
    update item_packaging_formats t set row_version = t.row_version + 1 where t.id = p_pack and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_pack_sites ps where ps.pack_id = v_id),
                            'queued', v_run -> 'queued');
end
$fn$;

-- Make one pack the count default or the buy default of its item (and no other), company and sites,
-- in one call. Sections: inventory.
create or replace function public.stock_set_pack_default(p_pack uuid, p_which text, p_version integer default null,
                                                         p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_id uuid := public.stock_co__company_id('pack', p_pack);
  v_old stock_co_packs;
  v_org uuid;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
begin
  if p_which is null or p_which not in ('count', 'purchase') then
    raise exception 'Say which default: count or purchase.' using errcode = '22023';
  end if;
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_packs x where x.id = v_id;
  v_org := v_old.org_id;
  if p_pack <> v_id then
    v_loc := public.stock_co__site_loc('pack', p_pack);
    select t.row_version into v_srv from item_packaging_formats t where t.id = p_pack;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id));
  end if;
  if not public.stock_co__item_at(v_old.item_id, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[v_loc]);
  select * into v_old from stock_co_packs x where x.id = v_id for update;
  if p_version is not null then
    v_rv := case when p_pack <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_org, array['pack'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  if v_old.archived_at is not null then
    raise exception 'This pack is archived, so it cannot be a default.' using errcode = '55000';
  end if;
  if p_which = 'count' then
    update stock_co_packs x set is_count_default = (x.id = v_id), row_version = x.row_version + 1, updated_at = now()
     where x.item_id = v_old.item_id and (x.id = v_id or x.is_count_default);
  else
    update stock_co_packs x set is_purchase_default = (x.id = v_id), row_version = x.row_version + 1, updated_at = now()
     where x.item_id = v_old.item_id and (x.id = v_id or x.is_purchase_default);
  end if;
  v_log := public.stock_co__log(v_org, null, 'pack', v_id, case when p_which = 'count' then 'is_count_default' else 'is_purchase_default' end,
                                to_jsonb(case when p_which = 'count' then v_old.is_count_default else v_old.is_purchase_default end),
                                to_jsonb(true), v_src);
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id),
                                      array[v_old.item_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  if p_pack <> v_id then
    update item_packaging_formats t set row_version = t.row_version + 1 where t.id = p_pack and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'which', p_which, 'queued', v_run -> 'queued');
end
$fn$;

-- ---------------------------------------------------------------------------
-- Unit bridges
-- ---------------------------------------------------------------------------
-- Company bridge and its site rows; the item's cost is checked at each site. Sections: inventory.
create or replace function public.stock_save_bridge(p_bridge jsonb, p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_d jsonb := public.stock_co__clean('bridge', p_bridge);
  v_id uuid;
  v_item uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_bridges;
  v_new stock_co_bridges;
  v_co jsonb;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row inventory_item_conversions;
  v_n integer;
begin
  if (v_d ? 'id' and v_d ? 'site_bridge_id') or (v_d ? 'item_id' and v_d ? 'site_item_id') then
    raise exception 'Send the company id or the site id of a field, not both.' using errcode = '22023';
  end if;
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_bridge_id')::uuid;
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('bridge', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_bridges x where x.id = v_id;
    v_item := v_old.item_id;
    if v_sid is not null then
      select t.row_version into v_srv from inventory_item_conversions t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('bridge', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    end if;
  end if;
  if v_d ? 'item_id' or v_d ? 'site_item_id' then
    if v_item is not null and public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid)) is distinct from v_item then
      raise exception 'A unit bridge cannot move to another item.' using errcode = '22023';
    end if;
    v_item := public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid));
  end if;
  if v_item is null then
    raise exception 'A unit bridge needs its item.' using errcode = '22023';
  end if;
  select x.org_id into v_org from stock_co_items x where x.id = v_item;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_loc is null then
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_item));
  end if;
  if not public.stock_co__item_at(v_item, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[v_loc]);
  if v_id is not null then
    select * into v_old from stock_co_bridges x where x.id = v_id for update;
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['bridge'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;
  v_co := v_d - array['id', 'site_bridge_id', 'location_id', 'item_id', 'site_item_id'];
  if v_id is null then
    if (v_co ->> 'from_qty') is null or (v_co ->> 'from_unit') is null or (v_co ->> 'to_qty') is null or (v_co ->> 'to_unit') is null then
      raise exception 'A new unit bridge needs both quantities and both units.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_bridges,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org, 'item_id', v_item, 'row_version', 1,
                                  'created_at', now(), 'updated_at', now()) || v_co);
    insert into stock_co_bridges select (v_new).*;
    v_id := v_new.id;
    v_log := public.stock_co__log_diff(v_org, null, 'bridge', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    update stock_co_bridges x
       set (from_qty, from_unit, to_qty, to_unit, row_version, updated_at)
         = (v_new.from_qty, v_new.from_unit, v_new.to_qty, v_new.to_unit, v_new.row_version, v_new.updated_at)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(v_org, null, 'bridge', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
  end if;
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_item),
                                      array[v_item], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  select bs.site_bridge_id into v_sid from stock_co_bridge_sites bs where bs.bridge_id = v_id and bs.location_id = v_loc;
  if (v_d ->> 'site_bridge_id') is not null then
    select t.row_version into v_rv from inventory_item_conversions t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update inventory_item_conversions t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from inventory_item_conversions t where t.id = v_sid;
  v_n := jsonb_array_length(v_run -> 'queued');
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_bridge_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'cost', jsonb_build_object('changed', (select count(*) from jsonb_array_elements(v_run -> 'cost')),
                                                       'items', v_run -> 'cost'),
                            'partial', case when v_n > 0 then format('Saved. %s site(s) catch up within a minute.', v_n) end,
                            'queued', v_run -> 'queued');
end
$fn$;

-- Archive (or restore) a company bridge. Its site rows are deleted, not archived (the writer, see
-- stock_co__plan_bridges), so the live converters stop using it at once; a restore makes new site
-- rows. Refused while a recipe line or a supplier pack needs it. Sections: inventory.
create or replace function public.stock_archive_bridge(p_bridge uuid, p_version integer default null, p_archived boolean default true,
                                                       p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_id uuid := public.stock_co__company_id('bridge', p_bridge);
  v_old stock_co_bridges;
  v_org uuid;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_at timestamptz;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_bridges x where x.id = v_id;
  v_org := v_old.org_id;
  if p_bridge <> v_id then
    v_loc := public.stock_co__site_loc('bridge', p_bridge);
    select t.row_version into v_srv from inventory_item_conversions t where t.id = p_bridge;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id));
  end if;
  if not public.stock_co__item_at(v_old.item_id, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[v_loc]);
  select * into v_old from stock_co_bridges x where x.id = v_id for update;
  if p_version is not null then
    v_rv := case when p_bridge <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_org, array['bridge'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  if coalesce(p_archived, true) then
    if public.stock_co__bridge_needed(v_id) then
      raise exception 'A recipe or a supplier pack needs this conversion.' using errcode = '55000';
    end if;
    v_at := coalesce(v_old.archived_at, now());
  else
    v_at := null;
  end if;
  update stock_co_bridges x set archived_at = v_at, row_version = x.row_version + 1, updated_at = now() where x.id = v_id;
  v_log := public.stock_co__log(v_org, null, 'bridge', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id),
                                      array[v_old.item_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  if p_bridge <> v_id then
    update inventory_item_conversions t set row_version = t.row_version + 1 where t.id = p_bridge and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_bridge_sites bs where bs.bridge_id = v_id),
                            'queued', v_run -> 'queued');
end
$fn$;

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------
-- Company supplier and its linked site rows. Drop 0, every company: the site fields of today's
-- Suppliers form (email, account number, minimum order, delivery days, cut off, notes) are written at
-- location_id's site row in the same call. Sections: purchasing; inventory too when creating (the
-- Stock items quick add).
create or replace function public.stock_save_supplier(p_supplier jsonb, p_sites jsonb default null, p_version integer default null,
                                                      p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_d jsonb := public.stock_co__clean('supplier', p_supplier);
  v_site jsonb;
  v_section text;
  v_id uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_suppliers;
  v_new stock_co_suppliers;
  v_co jsonb;
  v_before jsonb;
  v_after jsonb;
  v_log bigint;
  v_l2 bigint;
  v_run jsonb;
  v_created boolean := false;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row suppliers;
begin
  if p_sites is not null and jsonb_typeof(p_sites) <> 'null' then
    raise exception 'Choosing the sites of a supplier comes with the company stock list.' using errcode = '22023';
  end if;
  if v_d ? 'id' and v_d ? 'site_supplier_id' then
    raise exception 'Send the supplier id or the site supplier id, not both.' using errcode = '22023';
  end if;
  v_site := coalesce(v_d -> 'site', '{}'::jsonb);
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_supplier_id')::uuid;
  v_section := public.stock_co__section(p_section,
                 case when v_d ? 'id' or v_sid is not null then array['purchasing'] else array['purchasing', 'inventory'] end);
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('supplier', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_suppliers x where x.id = v_id;
    v_org := v_old.org_id;
    if v_sid is not null then
      select t.row_version into v_srv from suppliers t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('supplier', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    elsif v_loc is null then
      v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_supplier_sites s where s.supplier_id = v_id)
                                             || v_old.local_location_id);
    end if;
  else
    if v_loc is null then
      raise exception 'A new supplier needs its site (location_id).' using errcode = '22023';
    end if;
    select l.org_id into v_org from locations l where l.id = v_loc;
    if v_org is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[v_loc]);
  if v_id is not null then
    select * into v_old from stock_co_suppliers x where x.id = v_id for update;
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['supplier', 'supplier_site'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;
  v_co := v_d - array['id', 'site_supplier_id', 'location_id', 'site'];
  if v_id is null then
    if coalesce(v_co ->> 'name', '') = '' then
      raise exception 'A new supplier needs a name.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_suppliers,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org,
                                  'local_location_id', case when (v_g ->> 'multi')::boolean then v_loc end,
                                  'accepts_price_changes', true, 'order_method', 'email', 'row_version', 1,
                                  'created_at', now(), 'updated_at', now()) || v_co);
    v_new.accepts_price_changes := coalesce(v_new.accepts_price_changes, true);
    v_new.order_method := coalesce(v_new.order_method, 'email');
    insert into stock_co_suppliers select (v_new).*;
    v_id := v_new.id;
    v_created := true;
    v_sid := public.stock_co__new_site_supplier(v_id, v_loc);
    v_log := public.stock_co__log_diff(v_org, null, 'supplier', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.accepts_price_changes := coalesce(v_new.accepts_price_changes, true);
    v_new.order_method := coalesce(v_new.order_method, 'email');
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    update stock_co_suppliers x
       set (name, contact_name, phone, email, payment_terms_days, accepts_price_changes, max_order_value, order_method, notes,
            row_version, updated_at)
         = (v_new.name, v_new.contact_name, v_new.phone, v_new.email, v_new.payment_terms_days, v_new.accepts_price_changes,
            v_new.max_order_value, v_new.order_method, v_new.notes, v_new.row_version, v_new.updated_at)
     where x.id = v_id;
    select s.site_supplier_id into v_sid from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = v_loc;
    if v_sid is null then
      raise exception 'This supplier is not set up at that site.' using errcode = '22023';
    end if;
    v_log := public.stock_co__log_diff(v_org, null, 'supplier', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
  end if;

  -- the site fields at location_id
  if v_site <> '{}'::jsonb then
    select jsonb_build_object('account_number', t.account_number, 'email', t.email, 'cc_emails', to_jsonb(t.cc_emails),
                              'min_order_value', t.min_order_value, 'delivery_fee', t.delivery_fee, 'delivery_days', t.delivery_days,
                              'cutoff_time', t.cutoff_time, 'notes', t.notes)
      into v_before from suppliers t where t.id = v_sid for no key update;
    update suppliers t
       set account_number = case when v_site ? 'account_number' then v_site ->> 'account_number' else t.account_number end,
           email = case when v_site ? 'email' then v_site ->> 'email' else t.email end,
           cc_emails = case when v_site ? 'cc_emails'
                            then (select array_agg(e) from jsonb_array_elements_text(v_site -> 'cc_emails') e) else t.cc_emails end,
           min_order_value = case when v_site ? 'min_order_value' then (v_site ->> 'min_order_value')::numeric else t.min_order_value end,
           delivery_fee = case when v_site ? 'delivery_fee' then (v_site ->> 'delivery_fee')::numeric else t.delivery_fee end,
           delivery_days = case when v_site ? 'delivery_days' then coalesce(v_site -> 'delivery_days', '[]'::jsonb) else t.delivery_days end,
           cutoff_time = case when v_site ? 'cutoff_time' then v_site ->> 'cutoff_time' else t.cutoff_time end,
           notes = case when v_site ? 'notes' then v_site ->> 'notes' else t.notes end,
           row_version = t.row_version + 1, updated_at = now()
     where t.id = v_sid and t.location_id = v_loc;
    select jsonb_build_object('account_number', t.account_number, 'email', t.email, 'cc_emails', to_jsonb(t.cc_emails),
                              'min_order_value', t.min_order_value, 'delivery_fee', t.delivery_fee, 'delivery_days', t.delivery_days,
                              'cutoff_time', t.cutoff_time, 'notes', t.notes)
      into v_after from suppliers t where t.id = v_sid;
    v_l2 := public.stock_co__log_diff(v_org, v_loc, 'supplier_site', v_id, v_before, v_after, v_src);
    v_log := coalesce(v_l2, v_log);
  end if;

  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_supplier_sites s where s.supplier_id = v_id),
                                      '{}'::uuid[], array[v_id], '{}'::uuid[], v_log, v_t0);
  if (v_d ->> 'site_supplier_id') is not null then
    select t.row_version into v_rv from suppliers t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update suppliers t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from suppliers t where t.id = v_sid;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_supplier_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end, 'queued', v_run -> 'queued');
end
$fn$;

-- Archive (or restore) a company supplier and its site rows (never a delete). Sections: purchasing.
create or replace function public.stock_archive_supplier(p_supplier uuid, p_version integer default null, p_archived boolean default true,
                                                         p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['purchasing']);
  v_id uuid := public.stock_co__company_id('supplier', p_supplier);
  v_old stock_co_suppliers;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_at timestamptz;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_suppliers x where x.id = v_id;
  if p_supplier <> v_id then
    v_loc := public.stock_co__site_loc('supplier', p_supplier);
    select t.row_version into v_srv from suppliers t where t.id = p_supplier;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_supplier_sites s where s.supplier_id = v_id)
                                           || v_old.local_location_id);
  end if;
  v_g := public.stock_co__guard(v_old.org_id, v_section, 'company', array[v_loc]);
  select * into v_old from stock_co_suppliers x where x.id = v_id for update;
  if p_version is not null then
    v_rv := case when p_supplier <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_old.org_id, array['supplier', 'supplier_site'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  v_at := case when coalesce(p_archived, true) then coalesce(v_old.archived_at, now()) end;
  update stock_co_suppliers x set archived_at = v_at, row_version = x.row_version + 1, updated_at = now() where x.id = v_id;
  v_log := public.stock_co__log(v_old.org_id, null, 'supplier', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_old.org_id, v_loc, array(select s.location_id from stock_co_supplier_sites s where s.supplier_id = v_id),
                                      '{}'::uuid[], array[v_id], '{}'::uuid[], v_log, v_t0);
  if p_supplier <> v_id then
    update suppliers t set row_version = t.row_version + 1 where t.id = p_supplier and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_supplier_sites s where s.supplier_id = v_id),
                            'queued', v_run -> 'queued');
end
$fn$;

-- Site values of one supplier at one site (account number, email, copies, can order, minimum order,
-- delivery fee, approval limit). The version is the supplier's site link. Sections: purchasing.
create or replace function public.stock_save_supplier_site(p_supplier uuid, p_location uuid, p_patch jsonb, p_version integer default null,
                                                           p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['purchasing']);
  v_d jsonb := public.stock_co__clean('supplier_site_patch', p_patch);
  v_id uuid := public.stock_co__company_id('supplier', p_supplier);
  v_org uuid;
  v_link stock_co_supplier_sites;
  v_g jsonb;
  v_before jsonb;
  v_after jsonb;
  v_rv integer;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row suppliers;
begin
  if v_id is null or p_location is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_supplier <> v_id and public.stock_co__site_loc('supplier', p_supplier) is distinct from p_location then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select x.org_id into v_org from stock_co_suppliers x where x.id = v_id;
  select * into v_link from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = p_location;
  if v_link.supplier_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'site_facts', array[p_location]);
  select * into v_link from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = p_location for update;
  if p_version is not null and v_link.row_version is distinct from p_version then
    return public.stock_co__conflict(v_org, array['supplier_site', 'supplier'], v_id, v_link.row_version, p_location, v_link.updated_at);
  end if;
  select jsonb_build_object('account_number', t.account_number, 'email', t.email, 'cc_emails', to_jsonb(t.cc_emails),
                            'can_order', v_link.can_order, 'min_order_value', t.min_order_value, 'delivery_fee', t.delivery_fee,
                            'approval_limit', t.approval_limit)
    into v_before from suppliers t where t.id = v_link.site_supplier_id for no key update;
  update suppliers t
     set account_number = case when v_d ? 'account_number' then v_d ->> 'account_number' else t.account_number end,
         email = case when v_d ? 'email' then v_d ->> 'email' else t.email end,
         cc_emails = case when v_d ? 'cc_emails'
                          then (select array_agg(e) from jsonb_array_elements_text(v_d -> 'cc_emails') e) else t.cc_emails end,
         min_order_value = case when v_d ? 'min_order_value' then (v_d ->> 'min_order_value')::numeric else t.min_order_value end,
         delivery_fee = case when v_d ? 'delivery_fee' then (v_d ->> 'delivery_fee')::numeric else t.delivery_fee end,
         approval_limit = case when v_d ? 'approval_limit' then (v_d ->> 'approval_limit')::numeric else t.approval_limit end,
         row_version = t.row_version + 1, updated_at = now()
   where t.id = v_link.site_supplier_id and t.location_id = p_location
     and (v_d ? 'account_number' or v_d ? 'email' or v_d ? 'cc_emails' or v_d ? 'min_order_value' or v_d ? 'delivery_fee'
          or v_d ? 'approval_limit');
  update stock_co_supplier_sites s
     set can_order = case when v_d ? 'can_order' then (v_d ->> 'can_order')::boolean else s.can_order end,
         row_version = s.row_version + 1, updated_at = now()
   where s.supplier_id = v_id and s.location_id = p_location
  returning s.row_version into v_rv;
  select jsonb_build_object('account_number', t.account_number, 'email', t.email, 'cc_emails', to_jsonb(t.cc_emails),
                            'can_order', (select s.can_order from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = p_location),
                            'min_order_value', t.min_order_value, 'delivery_fee', t.delivery_fee, 'approval_limit', t.approval_limit)
    into v_after from suppliers t where t.id = v_link.site_supplier_id;
  perform public.stock_co__log_diff(v_org, p_location, 'supplier_site', v_id, v_before, v_after, v_src);
  select * into v_row from suppliers t where t.id = v_link.site_supplier_id;
  return jsonb_build_object('ok', true, 'supplier_id', v_id, 'location_id', p_location, 'row_version', v_rv,
                            'site_row', to_jsonb(v_row), 'queued', '[]'::jsonb);
end
$fn$;

-- ---------------------------------------------------------------------------
-- Supplier packs and prices
-- ---------------------------------------------------------------------------
-- A site whose currency differs from a company supplier pack's currency and has no price of its own
-- would follow a price in another currency: refused in words. Owner only.
create or replace function public.stock_co__currency_check(p_si uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_bad text;
begin
  select format('%s pays in %s. Give it its own price here.', l.name, coalesce(l.currency, 'GBP'))
    into v_bad
    from stock_co_supplier_item_sites x
    join stock_co_supplier_items si on si.id = x.supplier_item_id
    join locations l on l.id = x.location_id
   where x.supplier_item_id = p_si and x.price_here is null and l.currency is distinct from si.currency
   order by l.name
   limit 1;
  if v_bad is not null then
    raise exception '%', v_bad using errcode = '55000';
  end if;
end
$fn$;

-- is_preferred on one site supplier pack (true: it alone among the item's packs at that site, and the
-- item's default supplier follows; false: just this pack). Returns whether anything changed. Owner only.
create or replace function public.stock_co__set_preferred(p_loc uuid, p_site_item uuid, p_site_sp uuid, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_n integer := 0;
  v_m integer := 0;
  v_sup uuid;
begin
  perform 1 from inventory_items i where i.id = p_site_item and i.location_id = p_loc for no key update;
  if p_on then
    update supplier_products t set is_preferred = (t.id = p_site_sp), row_version = t.row_version + 1, updated_at = now()
     where t.location_id = p_loc and t.inventory_item_id = p_site_item and t.is_preferred is distinct from (t.id = p_site_sp);
    get diagnostics v_n = row_count;
    select t.supplier_id into v_sup from supplier_products t where t.id = p_site_sp;
    update inventory_items i set default_supplier_id = v_sup, row_version = i.row_version + 1, updated_at = now()
     where i.id = p_site_item and i.location_id = p_loc and i.default_supplier_id is distinct from v_sup;
    get diagnostics v_m = row_count;
  else
    update supplier_products t set is_preferred = false, row_version = t.row_version + 1, updated_at = now()
     where t.id = p_site_sp and t.location_id = p_loc and t.is_preferred;
    get diagnostics v_n = row_count;
  end if;
  return (v_n + v_m) > 0;
end
$fn$;

-- Company supplier pack, its site rows (price = the site's own price, else the company price), the main
-- flag as is_preferred at location_id only (one per item there, its default supplier kept in step), the
-- currency check, and the cost step at each site. From a site screen a new price goes to that site's
-- own price when it has one (or pays in another currency); otherwise it becomes the company price and
-- every site following it moves. Sections: inventory, purchasing.
create or replace function public.stock_save_supplier_item(p_si jsonb, p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory', 'purchasing']);
  v_d jsonb := public.stock_co__clean('supplier_item', p_si);
  v_site jsonb;
  v_id uuid;
  v_item uuid;
  v_sup uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_cur text;
  v_loc_cur text;
  v_g jsonb;
  v_old stock_co_supplier_items;
  v_new stock_co_supplier_items;
  v_co jsonb;
  v_rate numeric;
  v_here boolean := false;
  v_price numeric;
  v_log bigint;
  v_run jsonb;
  v_site_item uuid;
  v_site_sup uuid;
  v_pref boolean;
  v_pref_changed boolean := false;
  v_tmp boolean;
  v_cost jsonb;
  v_n integer;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row supplier_products;
begin
  if (v_d ? 'id' and v_d ? 'site_supplier_product_id') or (v_d ? 'item_id' and v_d ? 'site_item_id')
     or (v_d ? 'supplier_id' and v_d ? 'site_supplier_id') then
    raise exception 'Send the company id or the site id of a field, not both.' using errcode = '22023';
  end if;
  if v_d ? 'purchase_tax_rate_id' and v_d ? 'purchase_vat_rate' then
    raise exception 'Send the VAT rate row or the VAT rate, not both.' using errcode = '22023';
  end if;
  v_site := coalesce(v_d -> 'site', '{}'::jsonb);
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_supplier_product_id')::uuid;
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('supplier_item', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_supplier_items x where x.id = v_id;
    v_item := v_old.item_id;
    v_sup := v_old.supplier_id;
    if v_sid is not null then
      select t.row_version into v_srv from supplier_products t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('supplier_item', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    end if;
  end if;
  if v_d ? 'item_id' or v_d ? 'site_item_id' then
    if v_item is not null and public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid)) is distinct from v_item then
      raise exception 'A supplier pack cannot move to another item.' using errcode = '22023';
    end if;
    v_item := public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid));
  end if;
  if v_d ? 'supplier_id' or v_d ? 'site_supplier_id' then
    v_sup := public.stock_co__company_id('supplier', coalesce((v_d ->> 'supplier_id')::uuid, (v_d ->> 'site_supplier_id')::uuid));
    if v_sup is null then
      raise exception 'That supplier was not found.' using errcode = '22023';
    end if;
  end if;
  if v_item is null or v_sup is null then
    raise exception 'A supplier pack needs its item and its supplier.' using errcode = '22023';
  end if;
  select x.org_id into v_org from stock_co_items x where x.id = v_item;
  if v_org is null or not exists (select 1 from stock_co_suppliers m where m.id = v_sup and m.org_id = v_org) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_loc is null then
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_item));
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[v_loc]);
  if v_id is not null then
    select * into v_old from stock_co_supplier_items x where x.id = v_id for update;
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['supplier_item', 'supplier_item_site'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;
  select s.site_item_id into v_site_item from stock_co_item_sites s where s.item_id = v_item and s.location_id = v_loc;
  select s.site_supplier_id into v_site_sup from stock_co_supplier_sites s where s.supplier_id = v_sup and s.location_id = v_loc;
  if v_site_item is null or v_site_sup is null then
    raise exception 'That item or that supplier is not set up at this site.' using errcode = '22023';
  end if;
  select coalesce(l.currency, 'GBP') into v_loc_cur from locations l where l.id = v_loc;
  v_cur := coalesce(v_d ->> 'currency', v_old.currency, v_loc_cur);

  v_co := v_d - array['id', 'site_supplier_product_id', 'location_id', 'item_id', 'site_item_id', 'supplier_id', 'site_supplier_id',
                      'site', 'supplier_sku', 'purchase_tax_rate_id', 'purchase_vat_rate', 'currency', 'pack_price'];
  v_co := v_co || jsonb_build_object('item_id', v_item, 'supplier_id', v_sup, 'currency', v_cur);
  if v_d ? 'supplier_sku' then
    v_co := v_co || jsonb_build_object('sku', v_d -> 'supplier_sku');
  end if;
  if v_d ? 'purchase_tax_rate_id' then
    v_rate := null;
    if (v_d ->> 'purchase_tax_rate_id') is not null then
      select r.rate into v_rate from tax_rates r where r.id = (v_d ->> 'purchase_tax_rate_id')::uuid and r.location_id = v_loc;
      if not found then
        raise exception 'That VAT rate is not one of this venue''s rates.' using errcode = '22023';
      end if;
    end if;
    v_co := v_co || jsonb_build_object('purchase_vat_rate', v_rate);
  elsif v_d ? 'purchase_vat_rate' then
    v_co := v_co || jsonb_build_object('purchase_vat_rate', v_d -> 'purchase_vat_rate');
  end if;
  -- where a new price goes: this site's own price, or the company price
  if v_d ? 'pack_price' then
    v_price := (v_d ->> 'pack_price')::numeric;
    if v_id is not null
       and (exists (select 1 from stock_co_supplier_item_sites x
                     where x.supplier_item_id = v_id and x.location_id = v_loc and x.price_here is not null)
            or v_loc_cur is distinct from v_cur) then
      v_here := true;
    else
      v_co := v_co || jsonb_build_object('pack_price', v_price);
    end if;
  end if;

  if v_id is null then
    if (v_co ->> 'pack_price') is null or (v_co ->> 'inner_unit') is null then
      raise exception 'A new supplier pack needs a price and a unit.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_supplier_items,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org, 'pack_qty', 1, 'inner_qty', 1,
                                  'price_includes_tax', false, 'paused', false, 'allergens', '{}'::text[], 'may_contain', '{}'::text[],
                                  'diets', '{}'::text[], 'row_version', 1, 'created_at', now(), 'updated_at', now()) || v_co);
    v_new.pack_qty := coalesce(v_new.pack_qty, 1);
    v_new.inner_qty := coalesce(v_new.inner_qty, 1);
    v_new.price_includes_tax := coalesce(v_new.price_includes_tax, false);
    if v_loc_cur is distinct from v_new.currency then
      raise exception '% pays in %. Give it its own price here.', (select l.name from locations l where l.id = v_loc), v_loc_cur
        using errcode = '55000';
    end if;
    insert into stock_co_supplier_items select (v_new).*;
    v_id := v_new.id;
    v_log := public.stock_co__log_diff(v_org, null, 'supplier_item', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.price_includes_tax := coalesce(v_new.price_includes_tax, false);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    update stock_co_supplier_items x
       set (supplier_id, supplier_product_name, sku, pack_description, pack_qty, inner_qty, inner_unit, pack_price, currency,
            purchase_vat_rate, price_includes_tax, row_version, updated_at)
         = (v_new.supplier_id, v_new.supplier_product_name, v_new.sku, v_new.pack_description, v_new.pack_qty, v_new.inner_qty,
            v_new.inner_unit, v_new.pack_price, v_new.currency, v_new.purchase_vat_rate, v_new.price_includes_tax,
            v_new.row_version, v_new.updated_at)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(v_org, null, 'supplier_item', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
    if v_here then
      update stock_co_supplier_item_sites x
         set price_here = v_price, row_version = x.row_version + 1, updated_at = now()
       where x.supplier_item_id = v_id and x.location_id = v_loc and x.price_here is distinct from v_price;
      if found then
        v_log := coalesce(public.stock_co__log(v_org, v_loc, 'supplier_item_site', v_id, 'price_here', null, to_jsonb(v_price), v_src), v_log);
      end if;
    end if;
  end if;
  perform public.stock_co__currency_check(v_id);

  -- is_preferred at this site (an existing site row: before the writer, so the cost step sees it)
  v_pref := case when v_site ? 'is_preferred' then (v_site ->> 'is_preferred')::boolean end;
  select x.site_supplier_product_id into v_sid from stock_co_supplier_item_sites x where x.supplier_item_id = v_id and x.location_id = v_loc;
  if v_pref is not null and v_sid is not null then
    v_pref_changed := public.stock_co__set_preferred(v_loc, v_site_item, v_sid, v_pref);
  end if;

  v_run := public.stock_co__run_sites(v_org, v_loc,
             array(select s.location_id from stock_co_item_sites s where s.item_id = v_item),
             array[v_item], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);

  select x.site_supplier_product_id into v_sid from stock_co_supplier_item_sites x where x.supplier_item_id = v_id and x.location_id = v_loc;
  -- the VAT rate row picked on this site's screen stays the one picked (same rate value, so the writer keeps it)
  if (v_d ->> 'purchase_tax_rate_id') is not null and v_sid is not null then
    update supplier_products t
       set purchase_tax_rate_id = (v_d ->> 'purchase_tax_rate_id')::uuid, row_version = t.row_version + 1, updated_at = now()
     where t.id = v_sid and t.location_id = v_loc and t.purchase_tax_rate_id is distinct from (v_d ->> 'purchase_tax_rate_id')::uuid;
  end if;
  if v_pref is not null and v_sid is not null then
    v_tmp := public.stock_co__set_preferred(v_loc, v_site_item, v_sid, v_pref);
    v_pref_changed := v_pref_changed or v_tmp;
    if v_pref_changed then
      v_cost := public.stock_co__cost_step(v_loc, array[v_site_item], v_log, true);
      v_run := jsonb_set(v_run, '{cost}', (v_run -> 'cost')
                 || coalesce((select jsonb_agg(e || jsonb_build_object('location_id', v_loc))
                                from jsonb_array_elements(v_cost -> 'items') e), '[]'::jsonb));
    end if;
    if v_pref and not (v_g ->> 'multi')::boolean then
      update stock_co_items x set main_supplier_item_id = v_id where x.id = v_item and x.main_supplier_item_id is distinct from v_id;
    end if;
  end if;

  if (v_d ->> 'site_supplier_product_id') is not null then
    select t.row_version into v_rv from supplier_products t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update supplier_products t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from supplier_products t where t.id = v_sid;
  v_n := jsonb_array_length(v_run -> 'queued');
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_supplier_product_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'cost', v_run -> 'cost',
                            'partial', case when v_n > 0 then format('Saved. %s site(s) catch up within a minute.', v_n) end,
                            'queued', v_run -> 'queued');
end
$fn$;

-- The site's own price, off here and paused for one supplier pack at one site; the currency check and
-- the cost step there. The version is the pack's site link. Sections: inventory, purchasing.
create or replace function public.stock_save_supplier_item_site(p_si uuid, p_location uuid, p_patch jsonb,
                                                                p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['inventory', 'purchasing']);
  v_d jsonb := public.stock_co__clean('supplier_item_site_patch', p_patch);
  v_id uuid := public.stock_co__company_id('supplier_item', p_si);
  v_si stock_co_supplier_items;
  v_link stock_co_supplier_item_sites;
  v_g jsonb;
  v_before jsonb;
  v_after jsonb;
  v_rv integer;
  v_r jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row supplier_products;
begin
  if v_id is null or p_location is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_si <> v_id and public.stock_co__site_loc('supplier_item', p_si) is distinct from p_location then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_si from stock_co_supplier_items x where x.id = v_id;
  select * into v_link from stock_co_supplier_item_sites x where x.supplier_item_id = v_id and x.location_id = p_location;
  if v_link.supplier_item_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_si.org_id, v_section, 'site_price', array[p_location]);
  select * into v_link from stock_co_supplier_item_sites x where x.supplier_item_id = v_id and x.location_id = p_location for update;
  if p_version is not null and v_link.row_version is distinct from p_version then
    return public.stock_co__conflict(v_si.org_id, array['supplier_item_site', 'supplier_item'], v_id, v_link.row_version, p_location,
                                     v_link.updated_at);
  end if;
  v_before := jsonb_build_object('price_here', v_link.price_here, 'off_here', v_link.off_here, 'paused', v_link.paused);
  update stock_co_supplier_item_sites x
     set price_here = case when v_d ? 'price_here' then (v_d ->> 'price_here')::numeric else x.price_here end,
         off_here = case when v_d ? 'off_here' then (v_d ->> 'off_here')::boolean else x.off_here end,
         paused = case when v_d ? 'paused' then (v_d ->> 'paused')::boolean else x.paused end,
         row_version = x.row_version + 1, updated_at = now()
   where x.supplier_item_id = v_id and x.location_id = p_location
  returning x.row_version, jsonb_build_object('price_here', x.price_here, 'off_here', x.off_here, 'paused', x.paused)
       into v_rv, v_after;
  perform public.stock_co__currency_check(v_id);
  perform public.stock_co__log_diff(v_si.org_id, p_location, 'supplier_item_site', v_id, v_before, v_after, v_src);
  v_r := public.stock_co__sync_site(p_location, array[v_si.item_id], '{}'::uuid[], true, false);
  select * into v_row from supplier_products t where t.id = v_link.site_supplier_product_id;
  return jsonb_build_object('ok', true, 'supplier_item_id', v_id, 'location_id', p_location, 'row_version', v_rv,
                            'site_row', to_jsonb(v_row),
                            'cost', coalesce((select jsonb_agg(e || jsonb_build_object('location_id', p_location))
                                                from jsonb_array_elements(coalesce(v_r -> 'cost' -> 'items', '[]'::jsonb)) e), '[]'::jsonb),
                            'queued', '[]'::jsonb);
end
$fn$;

-- Archive (or restore) a company supplier pack and every site row (never a delete: order lines and
-- cost history keep the pack). Where it was the preferred pack, the next live pack takes over; cost
-- step at each site. Sections: inventory, purchasing.
create or replace function public.stock_archive_supplier_item(p_si uuid, p_version integer default null, p_archived boolean default true,
                                                              p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory', 'purchasing']);
  v_id uuid := public.stock_co__company_id('supplier_item', p_si);
  v_old stock_co_supplier_items;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_at timestamptz;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_supplier_items x where x.id = v_id;
  if p_si <> v_id then
    v_loc := public.stock_co__site_loc('supplier_item', p_si);
    select t.row_version into v_srv from supplier_products t where t.id = p_si;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s
                                                   join stock_co_supplier_sites ss on ss.location_id = s.location_id
                                                                                  and ss.supplier_id = v_old.supplier_id
                                                  where s.item_id = v_old.item_id));
  end if;
  if not public.stock_co__item_at(v_old.item_id, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_old.org_id, v_section, 'company', array[v_loc]);
  select * into v_old from stock_co_supplier_items x where x.id = v_id for update;
  if p_version is not null then
    v_rv := case when p_si <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_old.org_id, array['supplier_item', 'supplier_item_site'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  v_at := case when coalesce(p_archived, true) then coalesce(v_old.archived_at, now()) end;
  update stock_co_supplier_items x set archived_at = v_at, row_version = x.row_version + 1, updated_at = now() where x.id = v_id;
  if v_at is not null then
    update stock_co_items x set main_supplier_item_id = null where x.id = v_old.item_id and x.main_supplier_item_id = v_id;
  end if;
  v_log := public.stock_co__log(v_old.org_id, null, 'supplier_item', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_old.org_id, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id),
                                      array[v_old.item_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  if p_si <> v_id then
    update supplier_products t set row_version = t.row_version + 1 where t.id = p_si and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_supplier_item_sites x where x.supplier_item_id = v_id),
                            'cost', v_run -> 'cost', 'queued', v_run -> 'queued');
end
$fn$;

-- ---------------------------------------------------------------------------
-- Recipes, the till link, made item costs, the cost rule
-- ---------------------------------------------------------------------------
-- A recipe, its lines and its till link in ONE transaction, at every site it is set up at (through the
-- recipe writer); the made item's cost is re rolled at the caller's site (and at every site the
-- writer writes the recipe). Lines with no item or a quantity of 0 or less are dropped, as today. p_lines
-- null keeps the lines. Sections: produce; inventory too when the recipe has a made item.
create or replace function public.stock_save_recipe(p_recipe jsonb, p_lines jsonb, p_version integer default null,
                                                    p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_d jsonb := public.stock_co__clean('recipe', p_recipe);
  v_section text;
  v_id uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_recipes;
  v_new stock_co_recipes;
  v_co jsonb;
  v_out uuid;
  v_site_out uuid;
  v_lines jsonb := '[]'::jsonb;
  v_old_lines jsonb;
  v_line jsonb;
  v_ln jsonb;
  v_comp uuid;
  v_site_comp uuid;
  v_u text;
  v_unit text;
  v_site_unit text;
  v_pack uuid;
  v_n integer := 0;
  v_menu text;
  v_linked boolean := false;
  v_cost jsonb;
  v_c jsonb;
  v_before_cost numeric;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row recipes;
  v_q integer;
begin
  if (v_d ? 'id' and v_d ? 'site_recipe_id') or (v_d ? 'output_item_id' and v_d ? 'site_output_item_id') then
    raise exception 'Send the company id or the site id of a field, not both.' using errcode = '22023';
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) not in ('array', 'null') then
    raise exception 'The recipe lines must be a list.' using errcode = '22023';
  end if;
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_recipe_id')::uuid;
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('recipe', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_recipes x where x.id = v_id;
    v_org := v_old.org_id;
    if v_sid is not null then
      select t.row_version into v_srv from recipes t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('recipe', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    elsif v_loc is null then
      v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id)
                                             || v_old.local_location_id);
    end if;
  else
    if v_loc is null then
      raise exception 'A new recipe needs its site (location_id).' using errcode = '22023';
    end if;
    select l.org_id into v_org from locations l where l.id = v_loc;
    if v_org is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  if v_d ? 'output_item_id' or v_d ? 'site_output_item_id' then
    v_out := public.stock_co__company_id('item', coalesce((v_d ->> 'output_item_id')::uuid, (v_d ->> 'site_output_item_id')::uuid));
    if coalesce(v_d ->> 'output_item_id', v_d ->> 'site_output_item_id') is not null
       and (v_out is null or not exists (select 1 from stock_co_items x where x.id = v_out and x.org_id = v_org)) then
      raise exception 'That made item was not found in this company.' using errcode = '22023';
    end if;
  else
    v_out := v_old.output_item_id;
  end if;
  v_section := public.stock_co__section(p_section, case when v_out is not null then array['produce', 'inventory'] else array['produce'] end);
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[v_loc]);
  if v_id is not null then
    select * into v_old from stock_co_recipes x where x.id = v_id for update;
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['recipe', 'recipe_site', 'menu_link'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;

  v_co := v_d - array['id', 'site_recipe_id', 'location_id', 'recipe_type', 'output_item_id', 'site_output_item_id', 'menu_item_id', 'portion'];
  v_co := v_co || jsonb_build_object('output_item_id', v_out);
  if v_d ? 'recipe_type' then
    v_co := v_co || jsonb_build_object('kind', case v_d ->> 'recipe_type' when 'MENU' then 'dish' when 'BATCH' then 'batch' else 'prep' end);
  end if;

  -- the lines, in the company form
  if jsonb_typeof(p_lines) = 'array' then
    for v_line in select e.value from jsonb_array_elements(p_lines) with ordinality e(value, ord) order by e.ord loop
      v_ln := public.stock_co__clean('recipe_line', v_line);
      if v_ln ? 'component_item_id' and v_ln ? 'site_component_item_id' then
        raise exception 'Send the company id or the site id of a line''s item, not both.' using errcode = '22023';
      end if;
      continue when coalesce(v_ln ->> 'component_item_id', v_ln ->> 'site_component_item_id') is null
                 or coalesce((v_ln ->> 'qty')::numeric, 0) <= 0;
      if (v_ln ->> 'site_component_item_id') is not null then
        v_site_comp := (v_ln ->> 'site_component_item_id')::uuid;
        select s.item_id into v_comp from stock_co_item_sites s where s.site_item_id = v_site_comp and s.location_id = v_loc;
        if v_comp is null then
          raise exception 'A line names a stock item that is not at this site.' using errcode = '22023';
        end if;
      else
        v_comp := (v_ln ->> 'component_item_id')::uuid;
        if not exists (select 1 from stock_co_items x where x.id = v_comp and x.org_id = v_org) then
          raise exception 'A line names a stock item that is not in this company.' using errcode = '22023';
        end if;
        select s.site_item_id into v_site_comp from stock_co_item_sites s where s.item_id = v_comp and s.location_id = v_loc;
      end if;
      v_u := btrim(coalesce(v_ln ->> 'unit', ''));
      v_pack := null;
      if v_u like '@_%' then
        if substr(v_u, 2) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'A line is in a pack ServOS does not know.' using errcode = '22023';
        end if;
        select ps.pack_id into v_pack from stock_co_pack_sites ps
         where ps.site_pack_id = substr(v_u, 2)::uuid and ps.location_id = v_loc;
        v_unit := '@';
        v_site_unit := lower(v_u);
      elsif v_u = '@' then
        v_pack := (v_ln ->> 'pack_id')::uuid;
        v_unit := '@';
        v_site_unit := '@' || (select ps.site_pack_id from stock_co_pack_sites ps where ps.pack_id = v_pack and ps.location_id = v_loc)::text;
      else
        if (v_ln ->> 'pack_id') is not null then
          raise exception 'A line with a pack has the unit "@".' using errcode = '22023';
        end if;
        v_unit := lower(v_u);
        if not exists (select 1 from stock_units su where su.code = v_unit) then
          raise exception '"%" is not a unit ServOS knows (g, kg, ml, l, each, ...).', v_u using errcode = '22023';
        end if;
        v_site_unit := v_unit;
      end if;
      if v_unit = '@' and (v_pack is null or not exists (select 1 from stock_co_packs x where x.id = v_pack and x.item_id = v_comp)) then
        raise exception 'A line is in a pack that is not one of its item''s packs.' using errcode = '22023';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'component_item_id', v_comp, 'qty', (v_ln ->> 'qty')::numeric, 'unit', v_unit, 'pack_id', v_pack,
        'usable_pct', coalesce((v_ln ->> 'usable_pct')::numeric, 100), 'sort_order', v_n, 'note', v_ln ->> 'note',
        'order_types', case when jsonb_typeof(v_ln -> 'order_types') = 'array' and jsonb_array_length(v_ln -> 'order_types') > 0
                            then v_ln -> 'order_types' end,
        'base_qty', case when v_site_comp is not null and v_site_unit is not null
                         then public.stock_qty_to_base((v_ln ->> 'qty')::numeric, v_site_unit, v_site_comp) end));
      v_n := v_n + 1;
    end loop;
  end if;

  if v_id is null then
    if coalesce(v_co ->> 'name', '') = '' or (v_co ->> 'kind') is null then
      raise exception 'A new recipe needs a name and its type.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_recipes,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org,
                                  'local_location_id', case when (v_g ->> 'multi')::boolean then v_loc end,
                                  'yield_qty', 1, 'yield_unit', 'each', 'wastage_pct', 0, 'restricted', false, 'row_version', 1,
                                  'created_at', now(), 'updated_at', now()) || v_co);
    v_new.restricted := coalesce(v_new.restricted, false);
    insert into stock_co_recipes select (v_new).*;
    v_id := v_new.id;
    v_log := public.stock_co__log_diff(v_org, null, 'recipe', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    update stock_co_recipes x
       set (kind, name, yield_qty, yield_unit, output_item_id, wastage_pct, gp_target_pct, method, photo, row_version, updated_at)
         = (v_new.kind, v_new.name, v_new.yield_qty, v_new.yield_unit, v_new.output_item_id, v_new.wastage_pct, v_new.gp_target_pct,
            v_new.method, v_new.photo, v_new.row_version, v_new.updated_at)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(v_org, null, 'recipe', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
  end if;
  if jsonb_typeof(p_lines) = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object('component_item_id', l.component_item_id, 'qty', l.qty, 'unit', l.unit,
                                                 'pack_id', l.pack_id, 'usable_pct', l.usable_pct, 'sort_order', l.sort_order,
                                                 'note', l.note, 'order_types', l.order_types) order by l.sort_order, l.id), '[]'::jsonb)
      into v_old_lines from stock_co_recipe_lines l where l.recipe_id = v_id;
    delete from stock_co_recipe_lines l where l.recipe_id = v_id;
    insert into stock_co_recipe_lines (org_id, recipe_id, component_item_id, qty, unit, pack_id, usable_pct, order_types, note,
                                       sort_order, base_qty)
    select v_org, v_id, x.component_item_id, x.qty, x.unit, x.pack_id, x.usable_pct, x.order_types, x.note, x.sort_order, x.base_qty
      from jsonb_to_recordset(v_lines) as x(component_item_id uuid, qty numeric, unit text, pack_id uuid, usable_pct numeric,
                                            sort_order integer, note text, order_types jsonb, base_qty numeric);
    if v_old_lines is distinct from (select coalesce(jsonb_agg(e - 'base_qty'), '[]'::jsonb) from jsonb_array_elements(v_lines) e) then
      v_log := coalesce(public.stock_co__log(v_org, null, 'recipe', v_id, 'lines', v_old_lines,
                                             (select coalesce(jsonb_agg(e - 'base_qty'), '[]'::jsonb) from jsonb_array_elements(v_lines) e),
                                             v_src), v_log);
    end if;
  end if;

  -- the recipe at the caller's site, and its till product there
  select s.site_recipe_id into v_sid from stock_co_recipe_sites s where s.recipe_id = v_id and s.location_id = v_loc;
  if v_sid is null then
    if v_old.id is not null then
      raise exception 'This recipe is not set up at that site.' using errcode = '22023';
    end if;
    v_sid := public.stock_co__new_site_recipe(v_id, v_loc);
  end if;
  v_menu := v_d ->> 'menu_item_id';
  if v_menu is not null and v_new.kind = 'dish' then
    if not exists (select 1 from menu_items m where m.id = v_menu and m.location_id = v_loc::text) then
      raise exception 'That till product is not on this venue''s menu.' using errcode = '22023';
    end if;
    update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
     where s.location_id = v_loc and s.site_menu_item_id = v_menu and s.recipe_id <> v_id;
    update stock_co_recipe_sites s set site_menu_item_id = v_menu, row_version = s.row_version + 1, updated_at = now()
     where s.recipe_id = v_id and s.location_id = v_loc and s.site_menu_item_id is distinct from v_menu;
    if found then
      v_log := coalesce(public.stock_co__log(v_org, v_loc, 'menu_link', v_id, 'menu_item_id', null, to_jsonb(v_menu), v_src), v_log);
    end if;
  end if;

  select s.site_item_id into v_site_out from stock_co_item_sites s where s.item_id = v_new.output_item_id and s.location_id = v_loc;
  select t.current_cost into v_before_cost from inventory_items t where t.id = v_site_out;
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id),
                                      '{}'::uuid[], '{}'::uuid[], array[v_id], v_log, v_t0);

  if v_menu is not null and v_new.kind = 'dish' then
    update menu_item_recipes m set portion = coalesce((v_d ->> 'portion')::numeric, 1)
     where m.location_id = v_loc and m.menu_item_id = v_menu and m.recipe_id = v_sid
       and m.portion is distinct from coalesce((v_d ->> 'portion')::numeric, 1);
    v_linked := exists (select 1 from menu_item_recipes m where m.location_id = v_loc and m.menu_item_id = v_menu and m.recipe_id = v_sid);
  end if;

  -- the made item's cost at the caller's site, said back the way the screens say it today
  if v_site_out is not null then
    v_cost := public.stock_co__recost(v_loc, array[v_site_out], true);
    select e into v_c from jsonb_array_elements(v_cost -> 'items') e where (e ->> 'item_id')::uuid = v_site_out limit 1;
  end if;

  if (v_d ->> 'site_recipe_id') is not null then
    select t.row_version into v_rv from recipes t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update recipes t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from recipes t where t.id = v_sid;
  select count(*) into v_q from stock_co_recipe_lines l where l.recipe_id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_recipe_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'lines_saved', v_q, 'linked', v_linked,
                            'cost', case when v_site_out is null then null
                                         else jsonb_build_object('item_id', v_site_out, 'ok', coalesce((v_c ->> 'ok')::boolean, false),
                                                                 'before', to_jsonb(v_before_cost), 'after', v_c -> 'after') end,
                            'queued', v_run -> 'queued');
end
$fn$;

-- Archive (or restore) a company recipe and its site recipes, and remove their till links (a restore
-- does not link again). Sections: produce; inventory too when it has a made item.
create or replace function public.stock_archive_recipe(p_recipe uuid, p_version integer default null, p_archived boolean default true,
                                                       p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_id uuid := public.stock_co__company_id('recipe', p_recipe);
  v_old stock_co_recipes;
  v_section text;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_at timestamptz;
  v_before integer;
  v_after integer;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_recipes x where x.id = v_id;
  v_section := public.stock_co__section(p_section,
                 case when v_old.output_item_id is not null then array['produce', 'inventory'] else array['produce'] end);
  if p_recipe <> v_id then
    v_loc := public.stock_co__site_loc('recipe', p_recipe);
    select t.row_version into v_srv from recipes t where t.id = p_recipe;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id)
                                           || v_old.local_location_id);
  end if;
  v_g := public.stock_co__guard(v_old.org_id, v_section, 'company', array[v_loc]);
  select * into v_old from stock_co_recipes x where x.id = v_id for update;
  if p_version is not null then
    v_rv := case when p_recipe <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_old.org_id, array['recipe', 'recipe_site', 'menu_link'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  select count(*) into v_before from menu_item_recipes m
   where m.recipe_id in (select s.site_recipe_id from stock_co_recipe_sites s where s.recipe_id = v_id);
  v_at := case when coalesce(p_archived, true) then coalesce(v_old.archived_at, now()) end;
  update stock_co_recipes x set archived_at = v_at, row_version = x.row_version + 1, updated_at = now() where x.id = v_id;
  if v_at is not null then
    update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
     where s.recipe_id = v_id and s.site_menu_item_id is not null;
  end if;
  v_log := public.stock_co__log(v_old.org_id, null, 'recipe', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_old.org_id, v_loc, array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id),
                                      '{}'::uuid[], '{}'::uuid[], array[v_id], v_log, v_t0);
  select count(*) into v_after from menu_item_recipes m
   where m.recipe_id in (select s.site_recipe_id from stock_co_recipe_sites s where s.recipe_id = v_id);
  if p_recipe <> v_id then
    update recipes t set row_version = t.row_version + 1 where t.id = p_recipe and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_recipe_sites s where s.recipe_id = v_id),
                            'links_removed', greatest(v_before - v_after, 0), 'queued', v_run -> 'queued');
end
$fn$;

-- Link a till product at one site to a recipe there (p_recipe a company or a site recipe id), or unlink
-- it (p_recipe null); stock_co_recipe_sites.site_menu_item_id kept in step. Sections: produce.
create or replace function public.stock_link_menu_item(p_location uuid, p_menu_item_id text, p_recipe uuid, p_portion numeric default 1,
                                                       p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['produce']);
  v_org uuid;
  v_g jsonb;
  v_cid uuid;
  v_sid uuid;
  v_old text;
  v_src text := 'save_unversioned';
begin
  if p_location is null or nullif(btrim(coalesce(p_menu_item_id, '')), '') is null then
    raise exception 'Name the venue and the till product.' using errcode = '22023';
  end if;
  if p_portion is not null and p_portion <= 0 then
    raise exception 'The portion must be more than 0.' using errcode = '22023';
  end if;
  select l.org_id into v_org from locations l where l.id = p_location;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'site_facts', array[p_location]);
  select m.recipe_id::text into v_old from menu_item_recipes m where m.location_id = p_location and m.menu_item_id = p_menu_item_id;
  if p_recipe is null then
    delete from menu_item_recipes m where m.location_id = p_location and m.menu_item_id = p_menu_item_id;
    select s.recipe_id into v_cid from stock_co_recipe_sites s
     where s.location_id = p_location and s.site_menu_item_id = p_menu_item_id
     order by s.recipe_id limit 1;
    update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
     where s.location_id = p_location and s.site_menu_item_id = p_menu_item_id;
    if v_old is not null then
      perform public.stock_co__log(v_org, p_location, 'menu_link', coalesce(v_cid, v_old::uuid), 'menu_item_id',
                                   to_jsonb(p_menu_item_id), null, v_src);
    end if;
    return jsonb_build_object('ok', true, 'location_id', p_location, 'menu_item_id', p_menu_item_id, 'recipe_id', null,
                              'queued', '[]'::jsonb);
  end if;
  if exists (select 1 from stock_co_recipes x where x.id = p_recipe) then
    v_cid := p_recipe;
    select s.site_recipe_id into v_sid from stock_co_recipe_sites s where s.recipe_id = p_recipe and s.location_id = p_location;
  else
    select t.id into v_sid from recipes t where t.id = p_recipe and t.location_id = p_location;
    select s.recipe_id into v_cid from stock_co_recipe_sites s where s.site_recipe_id = v_sid and s.location_id = p_location;
  end if;
  if v_sid is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if exists (select 1 from recipes t where t.id = v_sid and t.archived_at is not null) then
    raise exception 'This recipe is archived, so it cannot be linked.' using errcode = '55000';
  end if;
  if not exists (select 1 from menu_items m where m.id = p_menu_item_id and m.location_id = p_location::text) then
    raise exception 'That till product is not on this venue''s menu.' using errcode = '22023';
  end if;
  update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
   where s.location_id = p_location and s.site_menu_item_id = p_menu_item_id and s.site_recipe_id <> v_sid;
  update stock_co_recipe_sites s set site_menu_item_id = p_menu_item_id, row_version = s.row_version + 1, updated_at = now()
   where s.site_recipe_id = v_sid and s.site_menu_item_id is distinct from p_menu_item_id;
  insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion)
  values (p_location, p_menu_item_id, v_sid, coalesce(p_portion, 1))
  on conflict (location_id, menu_item_id) do update set recipe_id = excluded.recipe_id, portion = excluded.portion;
  if v_old is distinct from v_sid::text then
    perform public.stock_co__log(v_org, p_location, 'menu_link', coalesce(v_cid, v_sid), 'menu_item_id', null, to_jsonb(p_menu_item_id), v_src);
  end if;
  return jsonb_build_object('ok', true, 'location_id', p_location, 'menu_item_id', p_menu_item_id, 'recipe_id', v_sid,
                            'queued', '[]'::jsonb);
end
$fn$;

-- Re roll MADE item costs at one site from their batch or prep recipes (null items = every live MADE
-- item there); item ids may be company or site ids. Sections: inventory, produce.
create or replace function public.stock_recost_made_items(p_location uuid, p_item_ids uuid[] default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['inventory', 'produce']);
  v_org uuid;
  v_ids uuid[];
  v_g jsonb;
begin
  select l.org_id into v_org from locations l where l.id = p_location;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'site_facts', array[p_location]);
  if p_item_ids is not null then
    if cardinality(p_item_ids) > 1000 then
      raise exception 'At most 1000 items in one call.' using errcode = '22023';
    end if;
    v_ids := array(select coalesce((select t.id from inventory_items t where t.id = u.id and t.location_id = p_location),
                                   (select s.site_item_id from stock_co_item_sites s where s.item_id = u.id and s.location_id = p_location))
                     from unnest(p_item_ids) u(id));
    if exists (select 1 from unnest(v_ids) x where x is null) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  return public.stock_co__recost(p_location, v_ids, true) || jsonb_build_object('queued', '[]'::jsonb);
end
$fn$;

-- The company cost rule (need: reach in Drop 0) or, with p_override_location, that site's override
-- (need: owner of that company or ServOS staff; p_rule null clears it). p_org null takes the org of
-- p_location. No section check (Overview is open to every Back Office login today).
create or replace function public.stock_save_cost_rule(p_org uuid, p_rule text, p_override_location uuid default null,
                                                       p_location uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid := p_org;
  v_loc uuid;
  v_g jsonb;
  v_old text;
  v_rv integer;
begin
  if v_org is null then
    select l.org_id into v_org from locations l where l.id = coalesce(p_override_location, p_location);
  end if;
  if v_org is null then
    raise exception 'Name the company or the venue.' using errcode = '22023';
  end if;
  if p_rule is not null and p_rule not in ('price_list', 'deliveries') then
    raise exception 'The cost rule is price_list or deliveries.' using errcode = '22023';
  end if;
  if p_override_location is null then
    if p_rule is null then
      raise exception 'The cost rule is price_list or deliveries.' using errcode = '22023';
    end if;
    v_loc := coalesce(p_location, public.stock_co__reached_site(array(select l.id from locations l where l.org_id = v_org)));
    v_g := public.stock_co__guard(v_org, null, 'company', array[v_loc]);
    select s.cost_rule into v_old from stock_co_settings s where s.org_id = v_org for update;
    insert into stock_co_settings (org_id, cost_rule, updated_by)
    values (v_org, p_rule, (v_g ->> 'uid')::uuid)
    on conflict (org_id) do update
      set cost_rule = excluded.cost_rule, row_version = stock_co_settings.row_version + 1, updated_at = now(),
          updated_by = excluded.updated_by
    returning row_version into v_rv;
    if v_old is distinct from p_rule then
      perform public.stock_co__log(v_org, null, 'settings', v_org, 'cost_rule', to_jsonb(v_old), to_jsonb(p_rule), 'save_unversioned');
    end if;
  else
    v_g := public.stock_co__guard(v_org, null, 'owner', array[p_override_location]);
    select s.cost_rule_override into v_old from stock_co_site_settings s where s.location_id = p_override_location for update;
    insert into stock_co_site_settings (location_id, org_id, cost_rule_override, updated_by)
    values (p_override_location, v_org, p_rule, (v_g ->> 'uid')::uuid)
    on conflict (location_id) do update
      set cost_rule_override = excluded.cost_rule_override, row_version = stock_co_site_settings.row_version + 1, updated_at = now(),
          updated_by = excluded.updated_by
    returning row_version into v_rv;
    if v_old is distinct from p_rule then
      perform public.stock_co__log(v_org, p_override_location, 'site_settings', p_override_location, 'cost_rule_override',
                                   to_jsonb(v_old), to_jsonb(p_rule), 'save_unversioned');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'org_id', v_org, 'rule', p_rule, 'override_location', p_override_location,
                            'row_version', v_rv, 'queued', '[]'::jsonb);
end
$fn$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
-- The stock scope of one venue for the signed in login (contract 3.6): its company, whether the company
-- is multi site, this login's Stock control level there, its sections, the company's sites it reaches
-- (open, then closed), the groups made only of those sites, the central kitchens, and the people who
-- can edit the company list (owners and Stock control all logins). Refuses like the guard.
create or replace function public.stock_site_scope(p_location_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_org uuid;
  v_reach text[];
  v_open integer;
  v_since timestamptz;
begin
  select l.org_id into v_org from locations l where l.id = p_location_id;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_org, null, 'read', array[p_location_id]);
  v_reach := array(select public.stock_reach_locations());
  select count(*) filter (where coalesce(l.status, 'active') = 'active') into v_open from locations l where l.org_id = v_org;
  select s.multi_since into v_since from stock_co_settings s where s.org_id = v_org;
  return jsonb_build_object(
    'org_id', v_org,
    'home_site', p_location_id,
    'open_count', coalesce(v_open, 0),
    'multi_since', v_since,
    'multi', (coalesce(v_open, 0) >= 2 or v_since is not null),
    'level', public.stock_level(v_uid, v_org),
    'sections', (select to_jsonb(p.bo_sections) from user_profiles p where p.id = v_uid),
    'sites', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'status', coalesce(l.status, 'active'),
                                                           'currency', l.currency, 'kind', coalesce(ss.site_kind, 'restaurant'))
                                        order by l.name, l.id), '[]'::jsonb)
                from locations l left join stock_co_site_settings ss on ss.location_id = l.id
               where l.org_id = v_org and l.id::text = any(v_reach) and coalesce(l.status, 'active') = 'active'),
    'closed_sites', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'status', coalesce(l.status, 'active'),
                                                                  'currency', l.currency, 'kind', coalesce(ss.site_kind, 'restaurant'))
                                               order by l.name, l.id), '[]'::jsonb)
                       from locations l left join stock_co_site_settings ss on ss.location_id = l.id
                      where l.org_id = v_org and l.id::text = any(v_reach) and coalesce(l.status, 'active') <> 'active'),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'location_ids', to_jsonb(g.location_ids),
                                                            'sort_order', g.sort_order) order by g.sort_order, g.name, g.id), '[]'::jsonb)
                 from stock_co_site_groups g
                where g.org_id = v_org
                  and not exists (select 1 from unnest(g.location_ids) x(id)
                                   where not (x.id::text = any(v_reach))
                                      or not exists (select 1 from locations l2 where l2.id = x.id and l2.org_id = v_org))),
    'kitchens', (select coalesce(jsonb_agg(ss.location_id order by ss.location_id), '[]'::jsonb)
                   from stock_co_site_settings ss
                  where ss.org_id = v_org and ss.site_kind = 'central_kitchen' and ss.location_id::text = any(v_reach)),
    'editors', (select coalesce(jsonb_agg(distinct btrim(p.full_name) order by btrim(p.full_name)), '[]'::jsonb)
                  from user_profiles p
                 where p.org_id = v_org and (p.role = 'owner' or p.stock_control = 'all')
                   and nullif(btrim(coalesce(p.full_name, '')), '') is not null));
end
$fn$;

-- One company item with its packs, bridges and supplier packs, and its site rows in this login's reach
-- (contract 3.6). p_item is the company id or a site row id.
create or replace function public.stock_item_detail(p_item uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_id uuid := public.stock_co__company_id('item', p_item);
  v_item stock_co_items;
  v_reach text[];
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_item from stock_co_items x where x.id = v_id;
  v_reach := array(select public.stock_reach_locations());
  if not exists (select 1 from stock_co_item_sites s where s.item_id = v_id and s.location_id::text = any(v_reach))
     and not coalesce(v_item.local_location_id::text = any(v_reach), false) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'item', to_jsonb(v_item),
    'row_version', v_item.row_version,
    'unit_locked', exists (select 1 from stock_co_item_sites s
                            where s.item_id = v_id and public.stock_co__site_item_in_use(s.location_id, s.site_item_id)),
    'packs', (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('sites',
                (select coalesce(jsonb_agg(jsonb_build_object('location_id', ps.location_id, 'site_pack_id', ps.site_pack_id)
                                           order by ps.location_id), '[]'::jsonb)
                   from stock_co_pack_sites ps where ps.pack_id = p.id and ps.location_id::text = any(v_reach)))
                order by p.name, p.id), '[]'::jsonb)
                from stock_co_packs p where p.item_id = v_id),
    'bridges', (select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('sites',
                  (select coalesce(jsonb_agg(jsonb_build_object('location_id', bs.location_id, 'site_bridge_id', bs.site_bridge_id)
                                             order by bs.location_id), '[]'::jsonb)
                     from stock_co_bridge_sites bs where bs.bridge_id = b.id and bs.location_id::text = any(v_reach)))
                  order by b.created_at, b.id), '[]'::jsonb)
                  from stock_co_bridges b where b.item_id = v_id),
    'supplier_items', (select coalesce(jsonb_agg(to_jsonb(si) || jsonb_build_object('supplier_name', m.name, 'sites',
                         (select coalesce(jsonb_agg(jsonb_build_object('location_id', x.location_id,
                                                                       'site_supplier_product_id', x.site_supplier_product_id,
                                                                       'price_here', x.price_here, 'off_here', x.off_here,
                                                                       'paused', x.paused, 'price', t.pack_price)
                                                    order by x.location_id), '[]'::jsonb)
                            from stock_co_supplier_item_sites x
                            join supplier_products t on t.id = x.site_supplier_product_id
                           where x.supplier_item_id = si.id and x.location_id::text = any(v_reach)))
                         order by m.name, si.created_at, si.id), '[]'::jsonb)
                         from stock_co_supplier_items si join stock_co_suppliers m on m.id = si.supplier_id
                        where si.item_id = v_id),
    'sites', (select coalesce(jsonb_agg(jsonb_build_object(
                'location_id', s.location_id, 'name', l.name, 'site_item_id', s.site_item_id, 'on_here', s.on_here, 'paused', s.paused,
                'supply_mode', s.supply_mode, 'counted_here', s.counted_here, 'stop_ordering_at', s.stop_ordering_at,
                'on_hand', t.on_hand, 'current_cost', t.current_cost, 'par_level', pl.par_level, 'reorder_point', pl.reorder_point,
                'min_level', pl.min_level,
                'area_id', (select ia.area_id from inventory_item_areas ia
                             where ia.inventory_item_id = s.site_item_id and ia.location_id = s.location_id and ia.is_primary limit 1),
                'row_version', s.row_version) order by l.name, l.id), '[]'::jsonb)
                from stock_co_item_sites s
                join locations l on l.id = s.location_id
                join inventory_items t on t.id = s.site_item_id
                left join par_levels pl on pl.location_id = s.location_id and pl.inventory_item_id = s.site_item_id
               where s.item_id = v_id and s.location_id::text = any(v_reach)));
end
$fn$;

-- The change log of one record (site rows only for sites this login reaches), plus the cost history of
-- an item's site rows in reach; newest first, keyset paged (p_after is a previous "next"), at most 200
-- rows a page. p_id is the company id or a site row id.
create or replace function public.stock_changes_page(p_entity text, p_id uuid, p_after jsonb default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_entities text[];
  v_id uuid;
  v_org uuid;
  v_reach text[];
  v_orgs text[];
  v_at timestamptz;
  v_key text;
  v_rows jsonb;
  v_n integer;
  v_last jsonb;
begin
  if p_entity is null or p_entity not in ('item', 'item_site', 'pack', 'bridge', 'supplier', 'supplier_site', 'supplier_item',
                                          'supplier_item_site', 'recipe', 'recipe_site', 'menu_link', 'settings', 'site_settings', 'login') then
    raise exception 'Unknown kind of record: %', coalesce(p_entity, 'none') using errcode = '22023';
  end if;
  v_entities := case p_entity
                  when 'item' then array['item', 'item_site']
                  when 'supplier' then array['supplier', 'supplier_site']
                  when 'supplier_item' then array['supplier_item', 'supplier_item_site']
                  when 'recipe' then array['recipe', 'recipe_site', 'menu_link']
                  else array[p_entity] end;
  v_id := case when p_entity in ('item', 'item_site') then public.stock_co__company_id('item', p_id)
               when p_entity in ('supplier', 'supplier_site') then public.stock_co__company_id('supplier', p_id)
               when p_entity in ('supplier_item', 'supplier_item_site') then public.stock_co__company_id('supplier_item', p_id)
               when p_entity = 'pack' then public.stock_co__company_id('pack', p_id)
               when p_entity = 'bridge' then public.stock_co__company_id('bridge', p_id)
               when p_entity in ('recipe', 'recipe_site', 'menu_link') then coalesce(public.stock_co__company_id('recipe', p_id), p_id)
               else p_id end;
  v_org := case when p_entity in ('item', 'item_site') then (select x.org_id from stock_co_items x where x.id = v_id)
                when p_entity in ('supplier', 'supplier_site') then (select x.org_id from stock_co_suppliers x where x.id = v_id)
                when p_entity in ('supplier_item', 'supplier_item_site') then (select x.org_id from stock_co_supplier_items x where x.id = v_id)
                when p_entity = 'pack' then (select x.org_id from stock_co_packs x where x.id = v_id)
                when p_entity = 'bridge' then (select x.org_id from stock_co_bridges x where x.id = v_id)
                when p_entity in ('recipe', 'recipe_site', 'menu_link') then coalesce((select x.org_id from stock_co_recipes x where x.id = v_id),
                                                                                       (select c.org_id from stock_change_log c
                                                                                         where c.entity = any(v_entities) and c.entity_id = v_id limit 1))
                when p_entity = 'settings' then v_id
                when p_entity = 'site_settings' then (select l.org_id from locations l where l.id = v_id)
                else (select c.org_id from stock_change_log c where c.entity = any(v_entities) and c.entity_id = v_id limit 1) end;
  v_orgs := array(select public.stock_reach_orgs());
  if v_id is null or v_org is null or not (v_org::text = any(v_orgs)) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_reach := array(select public.stock_reach_locations());
  if p_after is not null and jsonb_typeof(p_after) = 'object' then
    v_at := (p_after ->> 'at')::timestamptz;
    v_key := p_after ->> 'key';
  end if;
  with r as (
    select 'c:' || c.id::text as key, 'change'::text as kind, c.at, c.who_name, c.field, c.before, c.after, c.location_id, c.source
      from stock_change_log c
     where c.org_id = v_org and c.entity = any(v_entities) and c.entity_id = v_id
       and ((c.location_id is null and c.org_id::text = any(v_orgs)) or (c.location_id is not null and c.location_id::text = any(v_reach)))
       and not (p_entity = 'item' and c.field = 'current_cost')
    union all
    select 'h:' || h.id::text, 'cost'::text, h.effective_from,
           (select coalesce(pr.full_name, pr.email) from user_profiles pr where pr.id = h.created_by),
           'current_cost'::text, null::jsonb, to_jsonb(h.base_unit_cost), h.location_id, h.source
      from item_cost_history h
     where p_entity = 'item'
       and h.inventory_item_id in (select s.site_item_id from stock_co_item_sites s
                                    where s.item_id = v_id and s.location_id::text = any(v_reach))
  ),
  pg as (
    select r.* from r
     where v_at is null or (r.at, r.key) < (v_at, coalesce(v_key, ''))
     order by r.at desc, r.key desc
     limit v_lim + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('key', pg.key, 'kind', pg.kind, 'at', pg.at, 'who_name', pg.who_name,
                                               'field', pg.field, 'before', pg.before, 'after', pg.after,
                                               'location_id', pg.location_id, 'source', pg.source)
                            order by pg.at desc, pg.key desc), '[]'::jsonb),
         count(*)
    into v_rows, v_n
    from pg;
  if v_n > v_lim then
    v_rows := (select jsonb_agg(e order by o) from jsonb_array_elements(v_rows) with ordinality x(e, o) where o <= v_lim);
    v_last := v_rows -> (v_lim - 1);
    return jsonb_build_object('rows', v_rows, 'next', jsonb_build_object('at', v_last -> 'at', 'key', v_last -> 'key'));
  end if;
  return jsonb_build_object('rows', v_rows, 'next', null);
end
$fn$;

-- == 0a part 4: orphan rule, recipe line mirror, venue clock, day totals, periods, PIN (steps 14 to 18) ==
--
-- Part 4 of 20261021a_OPS_stock_native_0a.sql (multi site stock, Drop 0). Bare statements: the SQL
-- editor runs the whole file as one transaction, the guard at the top of part 1 has already run and
-- parts 1 to 3 sit above this one. Nothing in this part moves an on hand, cost, ledger or count number.
--
-- What this part adds:
--   14  stock_co__orphan: an AFTER INSERT row trigger on the six site tables. A site row saved with no
--       company record gets one (a company record ticked at its site in a one site company, a local
--       record of that site in a multi site company). It is AFTER, never BEFORE: the Back Office saves
--       with an upsert, and a BEFORE INSERT trigger fires for rows that turn out to be updates.
--       stock_co__mirror_lines: statement triggers on recipe_lines and menu_item_recipes that keep the
--       company recipe lines and the till link in step when lines are written straight to a site
--       (demo files, old tabs). Both skip their work when a company save is writing (the writer pass).
--       Neither ever fails the save that fired it: a problem is a warning and the site row stays as is.
--   15  venue_clock (the venue business day, synced from the Platform by the nightly run and by
--       location-admin), the nightly key in the vault, its check, the job that calls the stock-nightly
--       edge function at 03:40 UTC, and the nightly upkeep it calls.
--   16  Day totals: stock_day_sums and sales_day_sums with their rebuild and check functions. No live
--       triggers yet: those ship with the drainer release.
--   17  stock_periods and stock_period_snapshots (empty until Drop 3).
--   18  Manager PIN count approval (stock_pin_tries, stock_opening_costs, stock_approve_count_pin) and
--       one count line per item and area (the phone count support).
--
-- Function grants are not here: part 5 revokes every new function from public, anon, authenticated and
-- service_role by name and then grants exactly the contract list. Tables are granted here.

-- ---------------------------------------------------------------------------------------------------
-- What this part needs (raises with plain words, so the whole file rolls back and nothing changes)
-- ---------------------------------------------------------------------------------------------------
do $p4_needs$
begin
  if to_regclass('public.stock_co_recipe_sites') is null
     or to_regclass('public.stock_co_recipe_lines') is null
     or to_regprocedure('public.stock_co__log(uuid,uuid,text,uuid,text,jsonb,jsonb,text)') is null then
    raise exception 'Part 4 of the stock file needs parts 1 to 3 above it. Nothing was changed.';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regprocedure('vault.create_secret(text,text,text,uuid)') is null then
    raise exception 'The database vault is not there (vault.create_secret). Nothing was changed.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net is not there (net.http_post). Nothing was changed.';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null or to_regprocedure('cron.unschedule(bigint)') is null then
    raise exception 'pg_cron is not there (cron.schedule). Nothing was changed.';
  end if;
end
$p4_needs$;

-- ===================================================================================================
-- STEP 14. The orphan rule and the recipe line mirror
-- ===================================================================================================

-- The company record of one site row, made (with its link at that site) when the row has none.
-- Returns the company id, or null when the row is gone, its venue has no company, or a parent it needs
-- could not get one. The org is always locations.org_id of the row's venue, never the row's own org_id
-- (null on some live items and suppliers). Values are the site row's own, so the writer, run in check
-- mode afterwards, plans no write. Stamps company_ref and never bumps row_version. Internal: the orphan
-- trigger and the mirror call it, inside the writer pass they set.
create or replace function public.stock_co__orphan_row(p_table text, p_id uuid, p_depth integer default 0)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_loc     uuid;
  v_ref     uuid;
  v_org     uuid;
  v_multi   boolean;
  v_local   uuid;
  v_co      uuid;
  v_item    uuid;
  v_sup     uuid;
  v_parent  uuid;
  v_a       uuid;
  v_b       uuid;
  v_entity  text;
begin
  -- the depth stops a pack whose parent chain loops back on itself
  if p_id is null or coalesce(p_depth, 0) > 8 then
    return null;
  end if;
  if p_table is null or p_table not in ('inventory_items', 'suppliers', 'supplier_products', 'item_packaging_formats',
                                        'inventory_item_conversions', 'recipes') then
    raise exception 'stock_co__orphan_row: % is not a stock site table.', p_table using errcode = '22023';
  end if;

  execute format('select location_id, company_ref from public.%I where id = $1', p_table)
     into v_loc, v_ref using p_id;
  if v_loc is null then
    return null;
  end if;
  if v_ref is not null then
    return v_ref;
  end if;
  -- read again under the row lock, so two callers never make two company records for one row
  execute format('select location_id, company_ref from public.%I where id = $1 for no key update', p_table)
     into v_loc, v_ref using p_id;
  if v_loc is null then
    return null;
  end if;
  if v_ref is not null then
    return v_ref;
  end if;

  select l.org_id into v_org from locations l where l.id = v_loc;
  if v_org is null then
    return null;
  end if;
  -- multi site company: 2 or more open sites, or it has ever had 2 (the sticky flag)
  v_multi := exists (select 1 from stock_co_settings s where s.org_id = v_org and s.multi_since is not null)
          or (select count(*) from locations l where l.org_id = v_org and coalesce(l.status, 'active') = 'active') >= 2;
  v_local := case when v_multi then v_loc end;

  if p_table = 'inventory_items' then
    v_entity := 'item';
    insert into stock_co_items (org_id, local_location_id, name, category, accounting_group, base_unit, sku, barcode,
                                shelf_life_days, purchase_vat_rate, allergens, returns_to_shelf, archived_at)
    select v_org, v_local, i.name, i.category, i.accounting_group, i.base_unit, i.sku, i.barcode, i.shelf_life_days,
           (select t.rate from tax_rates t where t.id = i.purchase_tax_rate_id),
           coalesce(i.allergens, '[]'::jsonb), i.returns_to_shelf, i.archived_at
      from inventory_items i
     where i.id = p_id
    returning id into v_co;
    -- the site values are seeded from the row: MADE is made in batches, PURCHASED is bought
    insert into stock_co_item_sites (item_id, org_id, location_id, site_item_id, on_here, supply_mode, counted_here)
    select v_co, v_org, i.location_id, i.id, true,
           case when i.kind = 'MADE' then 'batches' else 'bought' end, i.is_tracked
      from inventory_items i
     where i.id = p_id;
    update inventory_items set company_ref = v_co where id = p_id;

  elsif p_table = 'suppliers' then
    v_entity := 'supplier';
    insert into stock_co_suppliers (org_id, local_location_id, name, contact_name, phone, email, payment_terms_days,
                                    min_order_value, delivery_fee, notes, archived_at)
    select v_org, v_local, s.name, s.contact_name, s.phone, s.email, s.payment_terms_days,
           s.min_order_value, s.delivery_fee, s.notes, s.archived_at
      from suppliers s
     where s.id = p_id
    returning id into v_co;
    insert into stock_co_supplier_sites (supplier_id, org_id, location_id, site_supplier_id, can_order)
    values (v_co, v_org, v_loc, p_id, true);
    update suppliers set company_ref = v_co where id = p_id;

  elsif p_table = 'supplier_products' then
    v_entity := 'supplier_item';
    -- a supplier pack needs the company item and the company supplier of its site rows first
    select sp.inventory_item_id, sp.supplier_id into v_a, v_b from supplier_products sp where sp.id = p_id;
    v_item := public.stock_co__orphan_row('inventory_items', v_a, coalesce(p_depth, 0) + 1);
    v_sup := public.stock_co__orphan_row('suppliers', v_b, coalesce(p_depth, 0) + 1);
    if v_item is null or v_sup is null then
      return null;
    end if;
    insert into stock_co_supplier_items (org_id, item_id, supplier_id, sku, pack_description, pack_qty, inner_qty,
                                         inner_unit, pack_price, currency, purchase_vat_rate, price_includes_tax,
                                         archived_at)
    select v_org, v_item, v_sup, sp.supplier_sku, sp.pack_description, sp.pack_qty, sp.inner_qty, sp.inner_unit,
           sp.pack_price, coalesce(nullif(upper(btrim(l.currency)), ''), 'GBP'),
           (select t.rate from tax_rates t where t.id = sp.purchase_tax_rate_id), sp.price_includes_tax, sp.archived_at
      from supplier_products sp
      join locations l on l.id = sp.location_id
     where sp.id = p_id
    returning id into v_co;
    -- price_here stays null: the site follows the company price, which is its own price
    insert into stock_co_supplier_item_sites (supplier_item_id, org_id, location_id, site_supplier_product_id)
    values (v_co, v_org, v_loc, p_id);
    update supplier_products set company_ref = v_co where id = p_id;

  elsif p_table = 'item_packaging_formats' then
    v_entity := 'pack';
    select pf.inventory_item_id, pf.parent_format_id into v_a, v_b from item_packaging_formats pf where pf.id = p_id;
    v_item := public.stock_co__orphan_row('inventory_items', v_a, coalesce(p_depth, 0) + 1);
    if v_item is null then
      return null;
    end if;
    if v_b is not null then
      v_parent := public.stock_co__orphan_row('item_packaging_formats', v_b, coalesce(p_depth, 0) + 1);
      -- a parent chain that loops back to this pack has made it already
      select pf.company_ref into v_ref from item_packaging_formats pf where pf.id = p_id;
      if v_ref is not null then
        return v_ref;
      end if;
    end if;
    insert into stock_co_packs (org_id, item_id, name, qty_in_base, parent_pack_id, is_count_default,
                                is_purchase_default, archived_at)
    select v_org, v_item, pf.name, pf.qty_in_base, v_parent, pf.is_count_default, pf.is_purchase_default, pf.archived_at
      from item_packaging_formats pf
     where pf.id = p_id
    returning id into v_co;
    insert into stock_co_pack_sites (pack_id, org_id, location_id, site_pack_id)
    values (v_co, v_org, v_loc, p_id);
    update item_packaging_formats set company_ref = v_co where id = p_id;

  elsif p_table = 'inventory_item_conversions' then
    v_entity := 'bridge';
    select c.inventory_item_id into v_a from inventory_item_conversions c where c.id = p_id;
    v_item := public.stock_co__orphan_row('inventory_items', v_a, coalesce(p_depth, 0) + 1);
    if v_item is null then
      return null;
    end if;
    insert into stock_co_bridges (org_id, item_id, from_qty, from_unit, to_qty, to_unit, archived_at)
    select v_org, v_item, c.from_qty, c.from_unit, c.to_qty, c.to_unit, c.archived_at
      from inventory_item_conversions c
     where c.id = p_id
    returning id into v_co;
    insert into stock_co_bridge_sites (bridge_id, org_id, location_id, site_bridge_id)
    values (v_co, v_org, v_loc, p_id);
    update inventory_item_conversions set company_ref = v_co where id = p_id;

  else
    v_entity := 'recipe';
    select r.output_item_id into v_a from recipes r where r.id = p_id;
    if v_a is not null then
      v_item := public.stock_co__orphan_row('inventory_items', v_a, coalesce(p_depth, 0) + 1);
    end if;
    -- site recipe_type MENU is a dish, BATCH a batch, PREP a prep
    insert into stock_co_recipes (org_id, local_location_id, kind, name, yield_qty, yield_unit, output_item_id,
                                  wastage_pct, method, photo, gp_target_pct, archived_at)
    select v_org, v_local,
           case r.recipe_type when 'BATCH' then 'batch' when 'PREP' then 'prep' else 'dish' end,
           r.name, r.yield_qty, r.yield_unit, v_item, r.wastage_pct, r.method, r.photo, r.gp_target_pct, r.archived_at
      from recipes r
     where r.id = p_id
    returning id into v_co;
    insert into stock_co_recipe_sites (recipe_id, org_id, location_id, on_here, site_recipe_id, site_menu_item_id)
    values (v_co, v_org, v_loc, true, p_id,
            (select m.menu_item_id from menu_item_recipes m
              where m.recipe_id = p_id and m.location_id = v_loc
              order by m.created_at, m.id limit 1));
    update recipes set company_ref = v_co where id = p_id;
  end if;

  perform public.stock_co__log(v_org, v_loc, v_entity, v_co, 'created', null,
                               jsonb_build_object('site_row', p_id, 'local', v_multi), 'orphan');

  -- a recipe that already has lines (only when called for an older recipe) gets its company lines too
  if p_table = 'recipes' and exists (select 1 from recipe_lines rl where rl.recipe_id = p_id) then
    perform public.stock_co__mirror_recipe(p_id, true);
  end if;
  return v_co;
end
$fn$;

-- The AFTER INSERT trigger itself. The WHEN on each trigger already skips rows that carry a company_ref
-- (the writer, the backfill and the fills insert with it set). Sets the writer pass while it stamps
-- company_ref (so the 0b locks let the stamp through), then puts back whatever was there before, so a
-- later recipe line insert in the same transaction is still mirrored. Never fails the insert.
create or replace function public.stock_co__orphan()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_prev text := current_setting('servos.stock_co_write', true);
begin
  if new.company_ref is not null then
    return null;
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  begin
    perform public.stock_co__orphan_row(tg_table_name, new.id, 0);
  exception when others then
    raise warning 'stock_co__orphan: % row % was saved without a company record (%).', tg_table_name, new.id, sqlerrm;
  end;
  perform set_config('servos.stock_co_write', coalesce(v_prev, ''), true);
  return null;
end
$fn$;

-- One site recipe brought into its company record: the till link always (site_menu_item_id), the lines
-- when p_lines. Pack lines ("@" and a site pack id) become "@" with the company pack. When the company
-- recipe is shared with another site, the change becomes this site's own local copy first (a new company
-- recipe, the link row moved to it), so no other site changes. Skips a recipe with no company_ref or no
-- link. Internal: the mirror trigger and stock_co__orphan_row call it inside the writer pass.
create or replace function public.stock_co__mirror_recipe(p_site_recipe uuid, p_lines boolean)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_loc    uuid;
  v_ref    uuid;
  v_org    uuid;
  v_site   uuid;
  v_co     uuid;
  v_copy   uuid;
  v_menu   text;
  v_old_menu text;
  v_want   jsonb;
  v_have   jsonb;
  v_x      uuid;
  v_n_old  integer := 0;
  v_n_new  integer := 0;
begin
  select r.location_id, r.company_ref into v_loc, v_ref from recipes r where r.id = p_site_recipe;
  if v_loc is null or v_ref is null then
    return 'skipped';
  end if;
  select s.recipe_id, s.org_id, s.location_id, s.site_menu_item_id
    into v_co, v_org, v_site, v_old_menu
    from stock_co_recipe_sites s
   where s.site_recipe_id = p_site_recipe;
  if v_co is null then
    return 'skipped';
  end if;
  -- one mirror of a company recipe at a time (two sessions editing one recipe never double its lines),
  -- then the link read again, as the other session may have moved it
  perform 1 from stock_co_recipes c where c.id = v_co for no key update;
  v_co := null;
  select s.recipe_id, s.org_id, s.location_id, s.site_menu_item_id
    into v_co, v_org, v_site, v_old_menu
    from stock_co_recipe_sites s
   where s.site_recipe_id = p_site_recipe;
  if v_co is null then
    return 'skipped';
  end if;

  -- the till link: the earliest link of this recipe at its site, or none
  select m.menu_item_id into v_menu
    from menu_item_recipes m
   where m.recipe_id = p_site_recipe and m.location_id = v_site
   order by m.created_at, m.id
   limit 1;
  if v_menu is distinct from v_old_menu then
    update stock_co_recipe_sites
       set site_menu_item_id = v_menu, row_version = row_version + 1, updated_at = now()
     where recipe_id = v_co and location_id = v_site;
    perform public.stock_co__log(v_org, v_site, 'menu_link', v_co, 'site_menu_item_id',
                                 to_jsonb(v_old_menu), to_jsonb(v_menu), 'mirror');
  end if;
  if not coalesce(p_lines, false) then
    return 'link';
  end if;

  -- every component item and pack used here gets its company record first
  for v_x in
    select distinct rl.component_item_id
      from recipe_lines rl
      join inventory_items i on i.id = rl.component_item_id
     where rl.recipe_id = p_site_recipe and rl.location_id = v_loc and i.company_ref is null
  loop
    perform public.stock_co__orphan_row('inventory_items', v_x, 1);
  end loop;
  for v_x in
    select distinct pf.id
      from recipe_lines rl
      join item_packaging_formats pf on pf.inventory_item_id = rl.component_item_id and pf.id::text = substr(rl.unit, 2)
     where rl.recipe_id = p_site_recipe and rl.location_id = v_loc and rl.unit like '@%' and pf.company_ref is null
  loop
    perform public.stock_co__orphan_row('item_packaging_formats', v_x, 1);
  end loop;

  -- what the company lines would be, and what they are; equal means nothing to do
  select coalesce(jsonb_agg(jsonb_build_object('c', s.c, 'q', s.q, 'u', s.u, 'p', s.p, 'up', s.up, 'ot', s.ot,
                                               'n', s.n, 'so', s.so)
                            order by s.so, s.c, s.q, s.u, s.p, s.up, s.n, s.ot::text), '[]'::jsonb)
    into v_want
    from (select i.company_ref as c, rl.qty as q,
                 case when pf.company_ref is not null then '@' else rl.unit end as u,
                 pf.company_ref as p, rl.usable_pct as up, rl.order_types as ot, rl.note as n, rl.sort_order as so
            from recipe_lines rl
            join inventory_items i on i.id = rl.component_item_id
            left join item_packaging_formats pf on rl.unit like '@%' and pf.inventory_item_id = rl.component_item_id
                                               and pf.id::text = substr(rl.unit, 2)
           where rl.recipe_id = p_site_recipe and rl.location_id = v_loc) s;
  select coalesce(jsonb_agg(jsonb_build_object('c', l.component_item_id, 'q', l.qty, 'u', l.unit, 'p', l.pack_id,
                                               'up', l.usable_pct, 'ot', l.order_types, 'n', l.note, 'so', l.sort_order)
                            order by l.sort_order, l.component_item_id, l.qty, l.unit, l.pack_id, l.usable_pct, l.note,
                                     l.order_types::text), '[]'::jsonb),
         count(*)
    into v_have, v_n_old
    from stock_co_recipe_lines l
   where l.recipe_id = v_co;
  if v_want = v_have then
    return 'same';
  end if;

  -- shared with another site: this site gets its own local copy, the other sites keep theirs
  if exists (select 1 from stock_co_recipe_sites o where o.recipe_id = v_co and o.location_id <> v_site) then
    insert into stock_co_recipes (org_id, local_location_id, kind, food_kind, meal_food_pct, name, yield_qty, yield_unit,
                                  output_item_id, portion_weight_g, cooking_yield_pct, wastage_pct, method, photo,
                                  gp_target_pct, shelf_life_days, restricted, msm_product_id, archived_at)
    select c.org_id, v_site, c.kind, c.food_kind, c.meal_food_pct, c.name, c.yield_qty, c.yield_unit,
           c.output_item_id, c.portion_weight_g, c.cooking_yield_pct, c.wastage_pct, c.method, c.photo,
           c.gp_target_pct, c.shelf_life_days, c.restricted, null, c.archived_at
      from stock_co_recipes c
     where c.id = v_co
    returning id into v_copy;
    update stock_co_recipe_sites
       set recipe_id = v_copy, row_version = row_version + 1, updated_at = now()
     where recipe_id = v_co and location_id = v_site;
    update recipes set company_ref = v_copy where id = p_site_recipe;
    perform public.stock_co__log(v_org, v_site, 'recipe', v_copy, 'local_copy',
                                 jsonb_build_object('recipe_id', v_co),
                                 jsonb_build_object('recipe_id', v_copy, 'site_recipe', p_site_recipe), 'mirror');
    v_co := v_copy;
    v_n_old := 0;
  end if;

  delete from stock_co_recipe_lines where recipe_id = v_co;
  insert into stock_co_recipe_lines (org_id, recipe_id, component_item_id, qty, unit, pack_id, usable_pct, order_types,
                                     note, sort_order, base_qty)
  select v_org, v_co, i.company_ref, rl.qty,
         case when pf.company_ref is not null then '@' else rl.unit end, pf.company_ref,
         rl.usable_pct, rl.order_types, rl.note, rl.sort_order,
         public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id)
    from recipe_lines rl
    join inventory_items i on i.id = rl.component_item_id
    left join item_packaging_formats pf on rl.unit like '@%' and pf.inventory_item_id = rl.component_item_id
                                       and pf.id::text = substr(rl.unit, 2)
   where rl.recipe_id = p_site_recipe and rl.location_id = v_loc
   order by rl.sort_order, rl.id;
  get diagnostics v_n_new = row_count;
  update stock_co_recipes set row_version = row_version + 1, updated_at = now() where id = v_co;
  perform public.stock_co__log(v_org, v_site, 'recipe', v_co, 'lines',
                               jsonb_build_object('lines', v_n_old), jsonb_build_object('lines', v_n_new), 'mirror');
  return 'lines';
end
$fn$;

-- The statement trigger on recipe_lines and menu_item_recipes (three per table, so the transition tables
-- are never in doubt). Returns at once while a company save or the writer is writing (they write both
-- sides themselves). The transition tables are read with EXECUTE so one function serves both tables.
create or replace function public.stock_co__mirror_lines()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_prev  text := current_setting('servos.stock_co_write', true);
  v_ids   uuid[] := '{}'::uuid[];
  v_more  uuid[];
  v_rid   uuid;
begin
  if current_setting('servos.stock_co_write', true) = txid_current()::text then
    return null;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    execute 'select coalesce(array_agg(distinct recipe_id), ''{}''::uuid[]) from new_rows' into v_more;
    v_ids := v_ids || v_more;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    execute 'select coalesce(array_agg(distinct recipe_id), ''{}''::uuid[]) from old_rows' into v_more;
    v_ids := v_ids || v_more;
  end if;
  if cardinality(v_ids) = 0 then
    return null;
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  for v_rid in select distinct u.x from unnest(v_ids) as u(x) where u.x is not null order by 1 loop
    begin
      perform public.stock_co__mirror_recipe(v_rid, tg_table_name = 'recipe_lines');
    exception when others then
      raise warning 'stock_co__mirror_lines: the company copy of recipe % was not brought in step (%).', v_rid, sqlerrm;
    end;
  end loop;
  perform set_config('servos.stock_co_write', coalesce(v_prev, ''), true);
  return null;
end
$fn$;

create trigger stock_co_orphan after insert on public.inventory_items
  for each row when (new.company_ref is null) execute function public.stock_co__orphan();
create trigger stock_co_orphan after insert on public.suppliers
  for each row when (new.company_ref is null) execute function public.stock_co__orphan();
create trigger stock_co_orphan after insert on public.supplier_products
  for each row when (new.company_ref is null) execute function public.stock_co__orphan();
create trigger stock_co_orphan after insert on public.item_packaging_formats
  for each row when (new.company_ref is null) execute function public.stock_co__orphan();
create trigger stock_co_orphan after insert on public.inventory_item_conversions
  for each row when (new.company_ref is null) execute function public.stock_co__orphan();
create trigger stock_co_orphan after insert on public.recipes
  for each row when (new.company_ref is null) execute function public.stock_co__orphan();

create trigger stock_co_mirror_ins after insert on public.recipe_lines
  referencing new table as new_rows
  for each statement execute function public.stock_co__mirror_lines();
create trigger stock_co_mirror_upd after update on public.recipe_lines
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.stock_co__mirror_lines();
create trigger stock_co_mirror_del after delete on public.recipe_lines
  referencing old table as old_rows
  for each statement execute function public.stock_co__mirror_lines();
create trigger stock_co_mirror_ins after insert on public.menu_item_recipes
  referencing new table as new_rows
  for each statement execute function public.stock_co__mirror_lines();
create trigger stock_co_mirror_upd after update on public.menu_item_recipes
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.stock_co__mirror_lines();
create trigger stock_co_mirror_del after delete on public.menu_item_recipes
  referencing old table as old_rows
  for each statement execute function public.stock_co__mirror_lines();

-- ===================================================================================================
-- STEP 15. The venue clock
-- ===================================================================================================

-- One row per Ops venue: its business day as the Platform says (time zone and the time the day starts).
-- Written only by venue_clock_sync (the nightly run, and location-admin after a save). A null Platform
-- start is stored as 06:00, the house default, so stock days and sales days always agree.
create table public.venue_clock (
  location_id           uuid primary key references public.locations(id) on delete cascade,
  platform_location_id  uuid,
  timezone              text not null,
  day_start             time not null default '06:00',
  synced_at             timestamptz not null,
  mismatch              text
);
comment on table public.venue_clock is
  'Venue business day clock (20261021a, multi site stock Drop 0): time zone and day start from the Platform, keyed by the Ops venue id. Written only by venue_clock_sync.';
alter table public.venue_clock enable row level security;
revoke all on table public.venue_clock from public, anon, authenticated, service_role;
grant select on table public.venue_clock to service_role;

-- The clock of one venue: venue_clock, else the Ops time zone (Europe/London when empty) and 06:00 with
-- clock_known false. Internal.
create or replace function public.stock_co__clock_of(p_location uuid)
returns table(timezone text, day_start time, clock_known boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(c.timezone, nullif(btrim(l.timezone), ''), 'Europe/London'),
         coalesce(c.day_start, time '06:00'),
         c.location_id is not null
    from (select p_location as id) x
    left join venue_clock c on c.location_id = x.id
    left join locations l on l.id = x.id;
$fn$;

-- The instant a business day starts: the first instant whose wall clock in p_tz reads p_day at p_start
-- (the same rule as report_day_sums, _rds_wall, so the two always cut a day in the same place, clock
-- changes included). Internal.
create or replace function public.stock_co__day_start_at(p_day date, p_start time, p_tz text)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case when ((b.g - interval '1 hour') at time zone p_tz) = a.w then b.g - interval '1 hour'
              when ((b.g - interval '30 minutes') at time zone p_tz) = a.w then b.g - interval '30 minutes'
              else b.g end
    from (select (p_day + p_start) as w) a
   cross join lateral (select a.w at time zone p_tz as g) b;
$fn$;

-- The venue business day of an instant.
create or replace function public.stock_co__venue_day(p_location uuid, p_at timestamptz)
returns table(business_day date, clock_known boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case when p_at < public.stock_co__day_start_at(d.d0, k.day_start, k.timezone) then d.d0 - 1
              when p_at >= public.stock_co__day_start_at(d.d0 + 1, k.day_start, k.timezone) then d.d0 + 1
              else d.d0 end,
         k.clock_known
    from public.stock_co__clock_of(p_location) k
   cross join lateral (select ((p_at at time zone k.timezone) - (k.day_start - time '00:00'))::date as d0) d;
$fn$;

-- Rows from the Platform: [{"ops_location_id", "platform_location_id", "timezone", "business_day_start"}].
-- Keyed by the Platform's ops_location_id, never the Platform id (some venues have different ids in the
-- two databases). A row with no matching Ops venue, a time zone this database does not know, or a start
-- that is not HH:MM is skipped. Sets mismatch when the Ops time zone differs from the Platform's.
-- Service role only (the stock-nightly and location-admin edge functions).
create or replace function public.venue_clock_sync(p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  r          jsonb;
  v_loc      uuid;
  v_pid      uuid;
  v_tz       text;
  v_start    text;
  v_m        text[];
  v_ds       time;
  v_ops_tz   text;
  v_n        integer := 0;
  v_mis      jsonb := '[]'::jsonb;
  v_missing  jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'The venue clock is set by the platform only.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'venue_clock_sync: p_rows must be a list of venues.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'venue_clock_sync: at most 1000 venues at a time.' using errcode = '22023';
  end if;

  for r in select e from jsonb_array_elements(p_rows) as e loop
    continue when jsonb_typeof(r) is distinct from 'object';
    v_loc := null;
    v_pid := null;
    begin
      v_loc := nullif(btrim(r ->> 'ops_location_id'), '')::uuid;
    exception when invalid_text_representation then
      v_loc := null;
    end;
    continue when v_loc is null;
    select l.timezone into v_ops_tz from locations l where l.id = v_loc;
    continue when not found;

    -- a real zone name, and one this database knows (asked by using it, as report_day_sums does)
    v_tz := nullif(btrim(r ->> 'timezone'), '');
    continue when v_tz is null or v_tz !~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$';
    begin
      perform timestamp '2026-01-01 12:00' at time zone v_tz;
    exception when others then
      continue;
    end;

    v_start := nullif(btrim(r ->> 'business_day_start'), '');
    if v_start is null then
      v_ds := time '06:00';
    else
      v_m := regexp_match(v_start, '^([0-9]{1,2}):([0-9]{2})(:[0-9]{2})?$');
      continue when v_m is null or v_m[1]::integer > 23 or v_m[2]::integer > 59;
      v_ds := make_time(v_m[1]::integer, v_m[2]::integer, 0);
    end if;

    begin
      v_pid := nullif(btrim(r ->> 'platform_location_id'), '')::uuid;
    exception when invalid_text_representation then
      v_pid := null;
    end;

    insert into venue_clock (location_id, platform_location_id, timezone, day_start, synced_at, mismatch)
    values (v_loc, v_pid, v_tz, v_ds, now(),
            case when coalesce(btrim(v_ops_tz), '') <> v_tz
                 then format('Ops says %s, the platform says %s.', coalesce(nullif(btrim(v_ops_tz), ''), 'nothing'), v_tz) end)
    on conflict (location_id) do update
       set platform_location_id = excluded.platform_location_id,
           timezone = excluded.timezone,
           day_start = excluded.day_start,
           synced_at = excluded.synced_at,
           mismatch = excluded.mismatch;
    v_n := v_n + 1;
    if coalesce(btrim(v_ops_tz), '') <> v_tz then
      v_mis := v_mis || jsonb_build_array(jsonb_build_object('location_id', v_loc, 'ops_timezone', v_ops_tz,
                                                             'platform_timezone', v_tz));
    end if;
  end loop;

  select coalesce(jsonb_agg(q.id order by q.id), '[]'::jsonb) into v_missing
    from (select l.id from locations l
           where not exists (select 1 from venue_clock c where c.location_id = l.id)
           order by l.id
           limit 1000) q;
  return jsonb_build_object('ok', true, 'upserted', v_n, 'mismatches', v_mis, 'missing', v_missing);
end
$fn$;

-- The nightly key, made here once, inside the vault (a second run keeps the same key). Nobody types it.
do $p4_key$
begin
  if not exists (select 1 from vault.secrets where name = 'stock_nightly_cron_key') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'stock_nightly_cron_key',
      'pg_cron stock-nightly proves itself to the stock-nightly edge function with this (20261021a). Made by the database, never typed.'
    );
  end if;
end
$p4_key$;

-- Is this the nightly key? Service role only (the stock-nightly edge function asks before it runs).
-- Never returns the key.
create or replace function public.stock_nightly_cron_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(length(p_key) >= 32 and exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'stock_nightly_cron_key' and s.decrypted_secret = p_key
  ), false);
$fn$;

-- What the 03:40 UTC job runs: reads the key from the vault at call time and posts {"action": "run"}
-- to stock-nightly with the header x-cron-key. The key is not in the job's text. Nobody may call it but
-- the job (part 5 revokes it from every API role). Waits up to 25 seconds for the answer.
create or replace function public.stock_nightly_send()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  k    text;
  req  bigint;
begin
  select s.decrypted_secret into k from vault.decrypted_secrets s where s.name = 'stock_nightly_cron_key' limit 1;
  if k is null or length(k) < 32 then
    raise exception 'stock_nightly_send: no stock_nightly_cron_key in the vault (run 20261021a again).';
  end if;
  select net.http_post(
    url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/stock-nightly',
    body := '{"action": "run"}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', k),
    timeout_milliseconds := 25000
  ) into req;
  return req;
end
$fn$;

-- ===================================================================================================
-- STEP 16. Day totals (tables and rebuild only; the live triggers ship with the drainer release)
-- ===================================================================================================

create table public.stock_day_sums (
  location_id        uuid not null,
  business_day       date not null,
  inventory_item_id  uuid not null,
  company_item_id    uuid,
  movement_type      text not null,
  source_type        text not null,
  qty_base           numeric not null default 0,
  value              numeric not null default 0,
  clock_known        boolean not null default true,
  updated_at         timestamptz not null default now(),
  primary key (location_id, business_day, inventory_item_id, movement_type, source_type)
);
comment on table public.stock_day_sums is
  'Stock ledger totals per venue business day, item, movement type and source (20261021a). Rebuilt by stock_day_sums_rebuild; live upkeep arrives with the drainer release.';

create table public.stock_day_sums_repair (
  location_id   uuid not null,
  business_day  date not null,
  reason        text,
  queued_at     timestamptz not null default now(),
  primary key (location_id, business_day)
);
comment on table public.stock_day_sums_repair is
  'Venue days whose stock day totals need a rebuild (20261021a). Filled by the live trigger from the drainer release; a rebuild clears its days.';

create table public.sales_day_sums (
  location_id      uuid not null,
  business_day     date not null,
  menu_item_id     text not null,
  order_type       text not null,
  qty              numeric,
  gross            numeric,
  net              numeric,
  discount_spread  numeric,
  reward_spread    numeric,
  tax              numeric,
  loyalty_qty      numeric,
  staff_qty        numeric,
  comp_qty         numeric,
  loyalty_cost     numeric,
  staff_cost       numeric,
  comp_cost        numeric,
  theo_cost        numeric,
  clock_known      boolean,
  updated_at       timestamptz not null default now(),
  primary key (location_id, business_day, menu_item_id, order_type)
);
comment on table public.sales_day_sums is
  'Sales per venue business day, menu item and order type (20261021a). Rebuilt by sales_day_sums_rebuild. In Drop 0 net and reward_spread are null, the loyalty, staff and comp columns 0 and theo_cost null: the drainer release fills them.';

create table public.sales_day_sums_queue (
  location_id   uuid not null,
  business_day  date not null,
  reason        text,
  queued_at     timestamptz not null default now(),
  primary key (location_id, business_day)
);
comment on table public.sales_day_sums_queue is
  'Venue days whose sales day totals need a rebuild (20261021a). Filled from the drainer release; a rebuild clears its days.';

alter table public.stock_day_sums enable row level security;
alter table public.stock_day_sums_repair enable row level security;
alter table public.sales_day_sums enable row level security;
alter table public.sales_day_sums_queue enable row level security;
revoke all on table public.stock_day_sums from public, anon, authenticated, service_role;
revoke all on table public.stock_day_sums_repair from public, anon, authenticated, service_role;
revoke all on table public.sales_day_sums from public, anon, authenticated, service_role;
revoke all on table public.sales_day_sums_queue from public, anon, authenticated, service_role;
grant select on table public.stock_day_sums to service_role;
grant select on table public.stock_day_sums_repair to service_role;
grant select on table public.sales_day_sums to service_role;
grant select on table public.sales_day_sums_queue to service_role;

-- Deletes and rebuilds stock_day_sums of one venue for p_from to p_to (venue days) from stock_movements,
-- each movement on the venue day of its occurred_at. A null source_type is kept as 'unknown'. Clears
-- the repair rows of those days. Service role only (the nightly run).
create or replace function public.stock_day_sums_rebuild(p_location uuid, p_from date, p_to date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tz     text;
  v_start  time;
  v_known  boolean;
  v_rows   integer := 0;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'Day totals are rebuilt by the nightly stock run only.' using errcode = '42501';
  end if;
  if p_location is null or p_from is null or p_to is null or p_to < p_from then
    raise exception 'stock_day_sums_rebuild: a venue, and from and to dates with from first.' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then
    raise exception 'stock_day_sums_rebuild: at most 400 days at a time.' using errcode = '22023';
  end if;
  if not exists (select 1 from locations l where l.id = p_location) then
    raise exception 'stock_day_sums_rebuild: that venue was not found.' using errcode = '22023';
  end if;
  select k.timezone, k.day_start, k.clock_known into v_tz, v_start, v_known from public.stock_co__clock_of(p_location) k;
  -- one rebuild of a venue at a time
  perform pg_advisory_xact_lock(hashtext('stock_day_sums:' || p_location::text));

  delete from stock_day_sums where location_id = p_location and business_day between p_from and p_to;
  delete from stock_day_sums_repair where location_id = p_location and business_day between p_from and p_to;

  with b as (
    select g::date as day,
           public.stock_co__day_start_at(g::date, v_start, v_tz) as lo,
           public.stock_co__day_start_at(g::date + 1, v_start, v_tz) as hi
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g
  )
  insert into stock_day_sums (location_id, business_day, inventory_item_id, company_item_id, movement_type, source_type,
                              qty_base, value, clock_known, updated_at)
  select p_location, b.day, m.inventory_item_id, i.company_ref, m.movement_type, coalesce(m.source_type, 'unknown'),
         sum(m.qty_base), sum(coalesce(m.value_delta, 0)), v_known, now()
    from b
    join stock_movements m on m.location_id = p_location and m.occurred_at >= b.lo and m.occurred_at < b.hi
    left join inventory_items i on i.id = m.inventory_item_id
   group by b.day, m.inventory_item_id, i.company_ref, m.movement_type, coalesce(m.source_type, 'unknown');
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'days', p_to - p_from + 1, 'rows', v_rows);
end
$fn$;

-- Deletes and rebuilds sales_day_sums of one venue for p_from to p_to (venue days) from the lines of
-- its closed checks, each check on the venue day it closed. Voided checks and voided lines never count
-- (the void test is report_day_sums': voided, or status void or voided). A line is price x qty (the
-- till folds modifier prices into price); a check with no live lines is read by its stored subtotal as
-- menu item 'unknown'. The check's discounts (report_day_sums' rule: amount, else value) and tax (its
-- tax_amount, else total less subtotal, service and tip) are spread over its lines by line value. A
-- null order_type is kept as 'unknown'. In Drop 0: net and reward_spread null, the loyalty, staff and
-- comp columns 0, theo_cost null (the drainer release fills them with the one sales rule). The column
-- named after the old card processor is never read. Service role only (the nightly run).
create or replace function public.sales_day_sums_rebuild(p_location uuid, p_from date, p_to date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tz     text;
  v_start  time;
  v_known  boolean;
  v_rows   integer := 0;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'Day totals are rebuilt by the nightly stock run only.' using errcode = '42501';
  end if;
  if p_location is null or p_from is null or p_to is null or p_to < p_from then
    raise exception 'sales_day_sums_rebuild: a venue, and from and to dates with from first.' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then
    raise exception 'sales_day_sums_rebuild: at most 400 days at a time.' using errcode = '22023';
  end if;
  if not exists (select 1 from locations l where l.id = p_location) then
    raise exception 'sales_day_sums_rebuild: that venue was not found.' using errcode = '22023';
  end if;
  select k.timezone, k.day_start, k.clock_known into v_tz, v_start, v_known from public.stock_co__clock_of(p_location) k;
  perform pg_advisory_xact_lock(hashtext('sales_day_sums:' || p_location::text));

  delete from sales_day_sums where location_id = p_location and business_day between p_from and p_to;
  delete from sales_day_sums_queue where location_id = p_location and business_day between p_from and p_to;

  with b as (
    select g::date as day,
           public.stock_co__day_start_at(g::date, v_start, v_tz) as lo,
           public.stock_co__day_start_at(g::date + 1, v_start, v_tz) as hi
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g
  ),
  chk as (
    select b.day, c.id,
           coalesce(c.order_type, 'unknown') as ot,
           coalesce(c.subtotal, 0) as sub,
           case when c.discounts is null or jsonb_typeof(c.discounts) <> 'array' then 0
                else (select coalesce(sum(coalesce(nullif(public._rds_num(d -> 'amount'), 0),
                                                   nullif(public._rds_num(d -> 'value'), 0), 0)), 0)
                        from jsonb_array_elements(c.discounts) as d) end as disc,
           case when c.tax_amount is not null then c.tax_amount
                else greatest(0, coalesce(c.total, 0) - coalesce(c.subtotal, 0) - coalesce(c.service, 0)
                                 - coalesce(c.tip, 0)) end as tax0,
           case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end as items
      from b
      join closed_checks c on c.location_id = p_location::text and c.closed_at >= b.lo and c.closed_at < b.hi
     where not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))
  ),
  ln as (
    select k.day, k.id, k.ot, k.disc, k.tax0,
           coalesce(public.stock_js_key(l -> 'itemId'), public.stock_js_key(l -> 'id'), 'unknown') as mid,
           public.stock_js_qty(l -> 'qty') as q,
           public.stock_js_num(l -> 'price') * public.stock_js_qty(l -> 'qty') as g
      from chk k
     cross join lateral jsonb_array_elements(k.items) as l
     where jsonb_typeof(l) = 'object' and not public.stock_js_truthy(l -> 'voided')
    union all
    select k.day, k.id, k.ot, k.disc, k.tax0, 'unknown', 0, k.sub
      from chk k
     where k.sub <> 0
       and not exists (select 1 from jsonb_array_elements(k.items) as l
                        where jsonb_typeof(l) = 'object' and not public.stock_js_truthy(l -> 'voided'))
  ),
  sh as (
    select n.day, n.id, n.ot, n.disc, n.tax0, n.mid, n.q, n.g,
           case when sum(n.g) over (partition by n.id) <> 0 then n.g / sum(n.g) over (partition by n.id)
                else 1.0 / count(*) over (partition by n.id) end as share
      from ln n
  )
  insert into sales_day_sums (location_id, business_day, menu_item_id, order_type, qty, gross, net, discount_spread,
                              reward_spread, tax, loyalty_qty, staff_qty, comp_qty, loyalty_cost, staff_cost, comp_cost,
                              theo_cost, clock_known, updated_at)
  select p_location, s.day, s.mid, s.ot, sum(s.q), sum(s.g), null, sum(s.disc * s.share), null, sum(s.tax0 * s.share),
         0, 0, 0, 0, 0, 0, null, v_known, now()
    from sh s
   group by s.day, s.mid, s.ot;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'days', p_to - p_from + 1, 'rows', v_rows);
end
$fn$;

-- Do the stock day totals of one venue day equal its ledger? Service role only.
create or replace function public.stock_day_sums_check(p_location uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tz     text;
  v_start  time;
  v_lo     timestamptz;
  v_hi     timestamptz;
  v_lq     numeric;
  v_lv     numeric;
  v_sq     numeric;
  v_sv     numeric;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'Day totals are checked by the nightly stock run only.' using errcode = '42501';
  end if;
  if p_location is null or p_day is null then
    raise exception 'stock_day_sums_check: a venue and a day.' using errcode = '22023';
  end if;
  select k.timezone, k.day_start into v_tz, v_start from public.stock_co__clock_of(p_location) k;
  v_lo := public.stock_co__day_start_at(p_day, v_start, v_tz);
  v_hi := public.stock_co__day_start_at(p_day + 1, v_start, v_tz);
  select coalesce(sum(m.qty_base), 0), coalesce(sum(coalesce(m.value_delta, 0)), 0)
    into v_lq, v_lv
    from stock_movements m
   where m.location_id = p_location and m.occurred_at >= v_lo and m.occurred_at < v_hi;
  select coalesce(sum(s.qty_base), 0), coalesce(sum(s.value), 0)
    into v_sq, v_sv
    from stock_day_sums s
   where s.location_id = p_location and s.business_day = p_day;
  return jsonb_build_object('ok', v_lq = v_sq and v_lv = v_sv,
                            'ledger_qty', v_lq, 'sums_qty', v_sq, 'ledger_value', v_lv, 'sums_value', v_sv);
end
$fn$;

-- Do the sales day totals of one venue day agree with report_day_sums on gross, discounts, voids and
-- tax? report_day_sums counts voided checks in its gross, discounts and tax, and sales_day_sums never
-- holds a voided check, so the voided checks of the same venue day (read here from closed_checks) are
-- added to the sums side; the voids line compares those voided checks with the report's voids, which
-- also proves both cut the day in the same place. report_day_sums takes the tax of refunds on the day's
-- checks off its tax, so its refunds_tax is added back on the report side. Net is checked from the
-- drainer release (the one sales rule), so net is null and net_checked false. Service role only.
create or replace function public.sales_day_sums_check(p_location uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tz       text;
  v_start    time;
  v_lo       timestamptz;
  v_hi       timestamptz;
  v_s_gross  numeric;
  v_s_disc   numeric;
  v_s_tax    numeric;
  v_v_sub    numeric;
  v_v_disc   numeric;
  v_v_tax    numeric;
  v_v_total  numeric;
  v_r_gross  numeric;
  v_r_disc   numeric;
  v_r_voids  numeric;
  v_r_tax    numeric;
  v_r_rtax   numeric;
  v_g1 numeric; v_g2 numeric; v_d1 numeric; v_d2 numeric; v_o1 numeric; v_o2 numeric; v_t1 numeric; v_t2 numeric;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'Day totals are checked by the nightly stock run only.' using errcode = '42501';
  end if;
  if p_location is null or p_day is null then
    raise exception 'sales_day_sums_check: a venue and a day.' using errcode = '22023';
  end if;
  if to_regprocedure('public.report_day_sums(text[],date,date,jsonb)') is null then
    raise exception 'sales_day_sums_check needs report_day_sums (20261005b).' using errcode = '55000';
  end if;
  select k.timezone, k.day_start into v_tz, v_start from public.stock_co__clock_of(p_location) k;
  v_lo := public.stock_co__day_start_at(p_day, v_start, v_tz);
  v_hi := public.stock_co__day_start_at(p_day + 1, v_start, v_tz);

  select coalesce(sum(s.gross), 0), coalesce(sum(s.discount_spread), 0), coalesce(sum(s.tax), 0)
    into v_s_gross, v_s_disc, v_s_tax
    from sales_day_sums s
   where s.location_id = p_location and s.business_day = p_day;

  select coalesce(sum(coalesce(c.subtotal, 0)), 0),
         coalesce(sum(case when c.discounts is null or jsonb_typeof(c.discounts) <> 'array' then 0
                           else (select coalesce(sum(coalesce(nullif(public._rds_num(d -> 'amount'), 0),
                                                              nullif(public._rds_num(d -> 'value'), 0), 0)), 0)
                                   from jsonb_array_elements(c.discounts) as d) end), 0),
         coalesce(sum(case when c.tax_amount is not null then c.tax_amount
                           else greatest(0, coalesce(c.total, 0) - coalesce(c.subtotal, 0) - coalesce(c.service, 0)
                                            - coalesce(c.tip, 0)) end), 0),
         coalesce(sum(coalesce(c.total, 0)), 0)
    into v_v_sub, v_v_disc, v_v_tax, v_v_total
    from closed_checks c
   where c.location_id = p_location::text and c.closed_at >= v_lo and c.closed_at < v_hi
     and (c.voided is true or coalesce(c.status, '') in ('void', 'voided'));

  select r.gross, r.discounts, r.voids, r.tax, r.refunds_tax
    into v_r_gross, v_r_disc, v_r_voids, v_r_tax, v_r_rtax
    from public.report_day_sums(array[p_location::text], p_day, p_day,
                                jsonb_build_object(p_location::text,
                                                   jsonb_build_object('tz', v_tz, 'day_start', to_char(v_start, 'HH24:MI')))) r
   where r.business_day = p_day;

  v_g1 := round(v_s_gross + v_v_sub, 2);                 v_g2 := round(coalesce(v_r_gross, 0), 2);
  v_d1 := round(v_s_disc + v_v_disc, 2);                 v_d2 := round(coalesce(v_r_disc, 0), 2);
  v_o1 := round(v_v_total, 2);                           v_o2 := round(coalesce(v_r_voids, 0), 2);
  v_t1 := round(v_s_tax + v_v_tax, 2);                   v_t2 := round(coalesce(v_r_tax, 0) + coalesce(v_r_rtax, 0), 2);
  return jsonb_build_object('ok', v_g1 = v_g2 and v_d1 = v_d2 and v_o1 = v_o2 and v_t1 = v_t2,
                            'gross', jsonb_build_object('sums', v_g1, 'report', v_g2),
                            'discounts', jsonb_build_object('sums', v_d1, 'report', v_d2),
                            'voids', jsonb_build_object('sums', v_o1, 'report', v_o2),
                            'tax', jsonb_build_object('sums', v_t1, 'report', v_t2),
                            'net', null,
                            'net_checked', false);
end
$fn$;

-- ===================================================================================================
-- STEP 17. Period snapshots (used from Drop 3, empty until then)
-- ===================================================================================================

create table public.stock_periods (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  location_id  uuid not null references public.locations(id) on delete cascade,
  from_day     date not null,
  to_day       date not null,
  locked_at    timestamptz,
  locked_by    uuid,
  unlocked_at  timestamptz,
  unlocked_by  uuid,
  constraint stock_periods_days_ok check (from_day <= to_day)
);
create index stock_periods_loc on public.stock_periods (location_id, from_day);
comment on table public.stock_periods is
  'Stock periods per venue (20261021a). Locked and unlocked from Drop 3; empty until then.';

create table public.stock_period_snapshots (
  period_id    uuid not null references public.stock_periods(id) on delete cascade,
  location_id  uuid not null,
  metrics      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  primary key (period_id, location_id)
);
comment on table public.stock_period_snapshots is
  'Figures frozen when a stock period locks (20261021a). From Drop 3; empty until then.';

alter table public.stock_periods enable row level security;
alter table public.stock_period_snapshots enable row level security;
revoke all on table public.stock_periods from public, anon, authenticated, service_role;
revoke all on table public.stock_period_snapshots from public, anon, authenticated, service_role;
grant select on table public.stock_periods to authenticated, service_role;
grant select on table public.stock_period_snapshots to authenticated, service_role;
create policy stock_periods_read on public.stock_periods as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_period_snapshots_read on public.stock_period_snapshots as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));

-- ===================================================================================================
-- STEP 18. Manager PIN count approval and phone counting support
-- ===================================================================================================

-- Wrong manager PINs at count approval (5 in 15 minutes per login and venue, and the login waits).
-- Purged after a day by the nightly upkeep.
create table public.stock_pin_tries (
  id           bigint generated always as identity primary key,
  user_id      uuid,
  location_id  uuid not null,
  tried_at     timestamptz not null default now()
);
create index stock_pin_tries_recent on public.stock_pin_tries (location_id, user_id, tried_at desc);
comment on table public.stock_pin_tries is
  'Wrong manager PINs at count approval (20261021a). Written only by stock_approve_count_pin; purged after a day by stock_nightly_upkeep.';
alter table public.stock_pin_tries enable row level security;
revoke all on table public.stock_pin_tries from public, anon, authenticated, service_role;
-- its identity sequence too, as part 2 does for the change log and the save queue
do $p4_seq$
begin
  execute format('revoke all on sequence %s from public, anon, authenticated, service_role',
                 pg_get_serial_sequence('public.stock_pin_tries', 'id'));
end
$p4_seq$;

-- Costs for an opening count (lifted from Phase 1 msm_stock_opening_costs, renamed). For each counted
-- item at the count's venue that has no cost yet: its preferred live supplier price there (else the
-- cheapest), per base unit, net of VAT when the price includes it; with no price there, the average
-- cost of the same company item at the company's other sites (same base unit). { item id: cost },
-- never 0. approve_stock_count still puts the venue's own cost first, and a cost typed on the screen
-- wins over these. Service role only (manager-approve asks before it approves); logins get these
-- inside stock_approve_count_pin.
create or replace function public.stock_opening_costs(p_count_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with c as (
    select s.location_id from stock_counts s where s.id = p_count_id
  ), it as (
    select distinct t.id, t.base_unit, t.purchase_tax_rate_id, t.company_ref
      from stock_count_lines l
      join c on c.location_id = l.location_id
      join inventory_items t on t.id = l.inventory_item_id and t.location_id = c.location_id
     where l.count_id = p_count_id and l.counted_qty is not null and coalesce(t.current_cost, 0) = 0
  ), price as (
    select distinct on (i.id) i.id, round(n.net / q.qb, 5) as cost
      from it i
      join c on true
      join supplier_products sp on sp.location_id = c.location_id and sp.inventory_item_id = i.id and sp.archived_at is null
      cross join lateral (select case when coalesce(sp.price_includes_tax, false)
                                      then sp.pack_price / (1 + coalesce((select r.rate from tax_rates r where r.id = coalesce(sp.purchase_tax_rate_id, i.purchase_tax_rate_id)), 0))
                                      else sp.pack_price end as net) n
      cross join lateral (select public.stock_convert_qty(sp.pack_qty * sp.inner_qty, sp.inner_unit, i.base_unit, array[i.id]) as qb) q
     where q.qb > 0 and n.net > 0 and round(n.net / q.qb, 5) > 0
     order by i.id, sp.is_preferred desc nulls last, n.net / q.qb, sp.id
  ), company_avg as (
    select i.id, round(avg(o.current_cost), 5) as cost
      from it i
      join inventory_items o on o.company_ref = i.company_ref and o.id <> i.id and o.base_unit = i.base_unit and o.current_cost > 0
     where i.company_ref is not null and not exists (select 1 from price p where p.id = i.id)
     group by i.id
  )
  select coalesce(jsonb_object_agg(x.id, x.cost), '{}'::jsonb)
    from (select p.id, p.cost from price p union all select a.id, a.cost from company_avg a where a.cost > 0) x;
$fn$;

-- Count approval with a manager PIN (lifted from Phase 1, p_preview kept: the lifted counts.js sends
-- it). The Back Office login must reach the count's venue; the PIN must be an active staff member at
-- that venue with role manager or owner, or the manager_approvals permission. Five wrong PINs in 15
-- minutes and the login waits; an empty PIN is not a try; a preview needs no PIN. An opening count is
-- costed by stock_opening_costs, and a cost typed on the screen wins. After a real approval the PIN
-- holder is stamped on the count (approved_by_staff_id, approved_by_staff_name).
create or replace function public.stock_approve_count_pin(p_count_id uuid, p_pin text, p_approved_by_name text default null,
  p_approval_note text default null, p_costs jsonb default null, p_preview boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_loc         uuid;
  v_pin         text := btrim(coalesce(p_pin, ''));
  v_staff_id    uuid;
  v_staff_name  text;
  v_costs       jsonb;
  v_res         jsonb;
begin
  select c.location_id into v_loc from stock_counts c where c.id = p_count_id;
  if v_loc is null or not public.stock_office_reaches(v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_costs := public.stock_opening_costs(p_count_id)
             || case when jsonb_typeof(p_costs) = 'object' then p_costs else '{}'::jsonb end;
  if coalesce(p_preview, false) then
    return public.approve_stock_count(p_count_id, p_approved_by_name, p_approval_note, v_costs, true);
  end if;
  if v_pin = '' then
    return jsonb_build_object('ok', false, 'error', 'Type the manager PIN first.', 'pin', 'missing');
  end if;
  if (select count(*) from stock_pin_tries t
       where t.location_id = v_loc and t.user_id is not distinct from auth.uid()
         and t.tried_at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Wait 15 minutes, then try again.', 'pin', 'locked');
  end if;
  select s.id, s.name into v_staff_id, v_staff_name
    from staff_members s
   where s.location_id = v_loc and s.pin = v_pin and s.pin <> '' and coalesce(s.active, true)
     and (lower(coalesce(s.role, '')) in ('manager', 'owner')
          or (jsonb_typeof(s.permissions) = 'array' and s.permissions ? 'manager_approvals'))
   order by s.created_at, s.id
   limit 1;
  if v_staff_id is null then
    insert into stock_pin_tries (user_id, location_id) values (auth.uid(), v_loc);
    return jsonb_build_object('ok', false, 'error', 'That PIN is not a manager at this venue.', 'pin', 'wrong');
  end if;
  v_res := public.approve_stock_count(p_count_id, coalesce(nullif(btrim(p_approved_by_name), ''), v_staff_name),
                                      p_approval_note, v_costs, false);
  if coalesce((v_res ->> 'ok')::boolean, false) and not coalesce((v_res ->> 'duplicate')::boolean, false) then
    update stock_counts
       set approved_by_staff_id = v_staff_id, approved_by_staff_name = v_staff_name
     where id = p_count_id;
  end if;
  return v_res || jsonb_build_object('approved_by_pin', v_staff_name);
end
$fn$;

-- One count line per item and area on a count, so two phones or two overlapping flushes can never post
-- a variance twice (live 20 Oct: no duplicate groups). Checked first, with plain words.
do $p4_one_per_area$
begin
  if exists (select 1 from public.stock_count_lines
              group by count_id, inventory_item_id, coalesce(area_id, '00000000-0000-0000-0000-000000000000'::uuid)
             having count(*) > 1) then
    raise exception 'Some stock counts hold the same item twice in one area, so the one line per area rule cannot be added. Nothing was changed. Ask Claude for a clean up file first.';
  end if;
end
$p4_one_per_area$;
create unique index stock_count_lines_one_per_area on public.stock_count_lines
  (count_id, inventory_item_id, coalesce(area_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ===================================================================================================
-- The nightly upkeep and its job (last, because it touches tables of steps 14 to 18)
-- ===================================================================================================

-- Called by the stock-nightly edge function after the day totals. Sets the writer pass itself (so the
-- 0b locks let it through as postgres) and:
--   1  deletes wrong PIN tries older than a day;
--   2  archives a site item at zero once its site has Stop ordering set and passed, while no live recipe
--      at that site uses it or makes it (the site link turns off: on_here false), logged 'nightly';
--   3  archives company rows (items, suppliers, supplier items, packs, bridges, recipes) left with no
--      site link at all, logged 'nightly'. A local record lives only through its link at its own site,
--      so one whose site row was deleted is archived too. Never a delete.
-- A row a sale is holding is skipped and tried again the next night. Service role only.
create or replace function public.stock_nightly_upkeep()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_pins   integer := 0;
  v_sites  integer := 0;
  v_rows   integer := 0;
  r        record;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'This runs from the nightly stock job only.' using errcode = '42501';
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  perform set_config('lock_timeout', '200ms', true);

  delete from stock_pin_tries where tried_at < now() - interval '1 day';
  get diagnostics v_pins = row_count;

  for r in
    select i.id, i.location_id, s.item_id, s.org_id
      from stock_co_item_sites s
      join inventory_items i on i.id = s.site_item_id
     where s.stop_ordering_at is not null and s.stop_ordering_at <= now()
       and i.archived_at is null and i.on_hand = 0
       and not exists (select 1 from recipe_lines rl join recipes rc on rc.id = rl.recipe_id
                        where rl.location_id = i.location_id and rl.component_item_id = i.id and rc.archived_at is null)
       and not exists (select 1 from recipes rc
                        where rc.location_id = i.location_id and rc.output_item_id = i.id and rc.archived_at is null)
     order by i.id
     limit 2000
  loop
    begin
      update inventory_items
         set archived_at = now(), row_version = row_version + 1, updated_at = now()
       where id = r.id and archived_at is null and on_hand = 0;
      if found then
        update stock_co_item_sites
           set on_here = false, row_version = row_version + 1, updated_at = now()
         where item_id = r.item_id and location_id = r.location_id;
        perform public.stock_co__log(r.org_id, r.location_id, 'item_site', r.item_id, 'archived_at', null,
                                     to_jsonb(now()), 'nightly');
        v_sites := v_sites + 1;
      end if;
    exception when lock_not_available or deadlock_detected then
      null;
    end;
  end loop;

  for r in
    select 'stock_co_items'::text as t, 'item'::text as e, c.id, c.org_id
      from stock_co_items c
     where c.archived_at is null and not exists (select 1 from stock_co_item_sites s where s.item_id = c.id)
    union all
    select 'stock_co_suppliers', 'supplier', c.id, c.org_id
      from stock_co_suppliers c
     where c.archived_at is null and not exists (select 1 from stock_co_supplier_sites s where s.supplier_id = c.id)
    union all
    select 'stock_co_supplier_items', 'supplier_item', c.id, c.org_id
      from stock_co_supplier_items c
     where c.archived_at is null and not exists (select 1 from stock_co_supplier_item_sites s where s.supplier_item_id = c.id)
    union all
    select 'stock_co_packs', 'pack', c.id, c.org_id
      from stock_co_packs c
     where c.archived_at is null and not exists (select 1 from stock_co_pack_sites s where s.pack_id = c.id)
    union all
    select 'stock_co_bridges', 'bridge', c.id, c.org_id
      from stock_co_bridges c
     where c.archived_at is null and not exists (select 1 from stock_co_bridge_sites s where s.bridge_id = c.id)
    union all
    select 'stock_co_recipes', 'recipe', c.id, c.org_id
      from stock_co_recipes c
     where c.archived_at is null and not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = c.id)
    limit 5000
  loop
    begin
      execute format('update public.%I set archived_at = now(), row_version = row_version + 1, updated_at = now() '
                     || 'where id = $1 and archived_at is null', r.t) using r.id;
      if found then
        perform public.stock_co__log(r.org_id, null, r.e, r.id, 'archived_at', null, to_jsonb(now()), 'nightly');
        v_rows := v_rows + 1;
      end if;
    exception when lock_not_available or deadlock_detected then
      null;
    end;
  end loop;

  return jsonb_build_object('pin_tries_purged', v_pins, 'site_items_archived', v_sites, 'company_rows_archived', v_rows);
end
$fn$;

-- The job: 03:40 UTC every night, through stock_nightly_send (the key never appears in the job's text).
-- Any older job of that name is replaced. Until the stock-nightly edge function is deployed the call
-- answers not found, which changes nothing.
do $p4_cron$
declare
  j record;
begin
  for j in select jobid from cron.job where jobname = 'stock-nightly' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('stock-nightly', '40 3 * * *', 'select public.stock_nightly_send();');
end
$p4_cron$;

-- The second sign in step on every table of this part (the 20261016 pattern). Skipped when that file
-- has not run.
do $p4_fence$
declare
  t text;
begin
  if to_regprocedure('public.second_step_ok()') is null then
    return;
  end if;
  foreach t in array array['venue_clock', 'stock_day_sums', 'stock_day_sums_repair', 'sales_day_sums',
                           'sales_day_sums_queue', 'stock_periods', 'stock_period_snapshots', 'stock_pin_tries'] loop
    if not exists (select 1 from pg_policy p where p.polrelid = format('public.%I', t)::regclass
                                               and p.polname = 'second_step_fence') then
      execute format('create policy second_step_fence on public.%I as restrictive for all to authenticated '
        || 'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
    end if;
  end loop;
end
$p4_fence$;
-- == 0a part 5: company records, the demo link, grants and the check (steps 19 to 22) ==
--
-- Step 19: every company that holds stock gets company records made from its own site rows
--          (stock_co__backfill), with a zero write self check per site.
-- Step 20: the demo company's two sites (Provo 7218c716, Location 2 c3ebfa7f) become one list
--          (stock_co__link), with the two named fills at Location 2 (packs and unit conversions) and
--          the zero write self check again.
-- Step 21: who may call what. Production gives every new function to anon, so every new function is
--          revoked from every API role by exact name, then given back to exactly the roles it needs.
-- Step 22: every count and sum is compared with the snapshot part 1 took under the item row locks.
--          Any difference other than the recorded fills raises, and the whole file rolls back.
--          The last statement is the visible check row, one row per venue that holds stock.
--
-- Nothing in this part writes on_hand, current_cost, the ledger, pars, counts, orders, invoices,
-- waste or production. It writes the company tables, the change log, company_ref on site rows, and
-- (step 20 only) the new pack and unit conversion rows at Location 2.

-- ============================================================================
-- 19. Company records from the site rows
-- ============================================================================
-- For every site row of the company with no company record: one company row from the site row's
-- own values (local_location_id null), its link at that site with the site values seeded from the
-- site row, then company_ref stamped. Archived rows are included (an archived item still holding
-- stock becomes an archived company item, never dropped). Set based: one statement per table and
-- step; the site rows are stamped first (company_ref = a new id), and that stamp is the map from
-- site row to company row for the statements after it. Only company tables, the change log and the
-- company_ref column are written. Ends with the zero write self check at every site of the company.
create or replace function public.stock_co__backfill(p_org uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_locs uuid[];
  v_items uuid[];
  v_sups uuid[];
  v_sps uuid[];
  v_packs uuid[];
  v_bridges uuid[];
  v_recipes uuid[];
  v_lines integer := 0;
  v_bad text;
  v_loc record;
  v_plan jsonb;
begin
  if p_org is null or not exists (select 1 from organisations o where o.id = p_org) then
    raise exception 'Company records stopped: that company was not found. Nothing was changed.' using errcode = '22023';
  end if;
  select coalesce(array_agg(l.id order by l.id), '{}') into v_locs from locations l where l.org_id = p_org;
  perform set_config('servos.stock_co_write', txid_current()::text, true);

  -- Plain words first for anything the company tables would refuse (none live on 20 Oct).
  select string_agg(x.w, '; ' order by x.w) into v_bad from (
    select format('the stock item %s at %s has no name or a unit that is not a stock unit (%s)', t.id, l.name, t.base_unit) as w
      from inventory_items t join locations l on l.id = t.location_id
     where t.location_id = any(v_locs) and t.company_ref is null
       and (btrim(t.name) = '' or not exists (select 1 from stock_units u where u.code = t.base_unit))
    union all
    select format('the supplier %s at %s has no name', t.id, l.name)
      from suppliers t join locations l on l.id = t.location_id
     where t.location_id = any(v_locs) and t.company_ref is null and btrim(t.name) = ''
    union all
    select format('the supplier pack %s at %s has a unit that is not a stock unit, a size that is not above zero, or a price below zero', t.id, l.name)
      from supplier_products t join locations l on l.id = t.location_id
     where t.location_id = any(v_locs) and t.company_ref is null
       and (not exists (select 1 from stock_units u where u.code = t.inner_unit)
            or not (t.pack_qty > 0 and t.inner_qty > 0 and t.pack_price >= 0))
    union all
    select format('the pack %s at %s has no name or a size that is not above zero', t.id, l.name)
      from item_packaging_formats t join locations l on l.id = t.location_id
     where t.location_id = any(v_locs) and t.company_ref is null
       and (btrim(t.name) = '' or not (t.qty_in_base > 0))
    union all
    select format('the unit conversion %s at %s uses a unit that is not a stock unit or an amount that is not above zero', t.id, l.name)
      from inventory_item_conversions t join locations l on l.id = t.location_id
     where t.location_id = any(v_locs) and t.company_ref is null
       and (not exists (select 1 from stock_units u where u.code = t.from_unit)
            or not exists (select 1 from stock_units u where u.code = t.to_unit)
            or not (t.from_qty > 0 and t.to_qty > 0))
    union all
    select format('the recipe %s at %s has no name or the type "%s"', t.id, l.name, t.recipe_type)
      from recipes t join locations l on l.id = t.location_id
     where t.location_id = any(v_locs) and t.company_ref is null
       and (btrim(t.name) = '' or t.recipe_type not in ('MENU', 'BATCH', 'PREP'))
    union all
    select format('a stock row %s at %s points at a row of another site', x2.id, l.name)
      from (select sp.id, sp.location_id from supplier_products sp
             where sp.location_id = any(v_locs) and sp.company_ref is null
               and (not exists (select 1 from inventory_items i where i.id = sp.inventory_item_id and i.location_id = sp.location_id)
                    or not exists (select 1 from suppliers s where s.id = sp.supplier_id and s.location_id = sp.location_id))
            union all
            select f.id, f.location_id from item_packaging_formats f
             where f.location_id = any(v_locs) and f.company_ref is null
               and (not exists (select 1 from inventory_items i where i.id = f.inventory_item_id and i.location_id = f.location_id)
                    or (f.parent_format_id is not null
                        and not exists (select 1 from item_packaging_formats q where q.id = f.parent_format_id
                                           and q.inventory_item_id = f.inventory_item_id and q.location_id = f.location_id)))
            union all
            select c.id, c.location_id from inventory_item_conversions c
             where c.location_id = any(v_locs) and c.company_ref is null
               and not exists (select 1 from inventory_items i where i.id = c.inventory_item_id and i.location_id = c.location_id)
            union all
            select r.id, r.location_id from recipes r
             where r.location_id = any(v_locs) and r.company_ref is null and r.output_item_id is not null
               and not exists (select 1 from inventory_items i where i.id = r.output_item_id and i.location_id = r.location_id)
            union all
            select rl.id, rl.location_id from recipe_lines rl
              join recipes r on r.id = rl.recipe_id
             where rl.location_id = any(v_locs) and r.company_ref is null
               and (r.location_id <> rl.location_id
                    or not exists (select 1 from inventory_items i where i.id = rl.component_item_id and i.location_id = rl.location_id)
                    or (left(rl.unit, 1) = '@'
                        and not exists (select 1 from item_packaging_formats f where f.id::text = substr(rl.unit, 2)
                                           and f.inventory_item_id = rl.component_item_id and f.location_id = rl.location_id)))
           ) x2
      join locations l on l.id = x2.location_id
    union all
    select format('the stock item %s at %s has a purchase VAT rate of %s, which is not a fraction such as 0.2', t.id, l.name, r.rate)
      from inventory_items t join locations l on l.id = t.location_id join tax_rates r on r.id = t.purchase_tax_rate_id
     where t.location_id = any(v_locs) and t.company_ref is null and not (r.rate >= 0 and r.rate < 1)
    union all
    select format('the supplier pack %s at %s has a purchase VAT rate of %s, which is not a fraction such as 0.2', t.id, l.name, r.rate)
      from supplier_products t join locations l on l.id = t.location_id join tax_rates r on r.id = t.purchase_tax_rate_id
     where t.location_id = any(v_locs) and t.company_ref is null and not (r.rate >= 0 and r.rate < 1)
  ) x;
  if v_bad is not null then
    raise exception 'Company records stopped and nothing was changed: %.', left(v_bad, 900) using errcode = '22023';
  end if;

  -- -- stock items (archived ones too) ---------------------------------------
  with s as (
    update inventory_items t set company_ref = gen_random_uuid()
     where t.location_id = any(v_locs) and t.company_ref is null
    returning t.id
  ) select coalesce(array_agg(s.id), '{}') into v_items from s;
  insert into stock_co_items (id, org_id, local_location_id, name, category, accounting_group, base_unit, sku, barcode,
                              shelf_life_days, purchase_vat_rate, allergens, returns_to_shelf, notes, archived_at, created_at)
  select t.company_ref, p_org, null, t.name, t.category, t.accounting_group, t.base_unit, t.sku, t.barcode,
         t.shelf_life_days, (select r.rate from tax_rates r where r.id = t.purchase_tax_rate_id),
         coalesce(t.allergens, '[]'::jsonb), coalesce(t.returns_to_shelf, false), t.notes, t.archived_at, t.created_at
    from inventory_items t
   where t.id = any(v_items);
  -- site values seeded from the site row: MADE is made here in batches (today's behaviour), PURCHASED
  -- is bought; counted here follows is_tracked; on here at that site.
  insert into stock_co_item_sites (item_id, org_id, location_id, site_item_id, on_here, paused, supply_mode, counted_here)
  select t.company_ref, p_org, t.location_id, t.id, true, false,
         case when t.kind = 'MADE' then 'batches' else 'bought' end, coalesce(t.is_tracked, true)
    from inventory_items t
   where t.id = any(v_items);
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, t.location_id, 'item', t.company_ref, null, null, jsonb_build_object('site_row', t.id), null, 'Company setup', 'backfill'
    from inventory_items t
   where t.id = any(v_items);

  -- -- suppliers -------------------------------------------------------------
  with s as (
    update suppliers t set company_ref = gen_random_uuid()
     where t.location_id = any(v_locs) and t.company_ref is null
    returning t.id
  ) select coalesce(array_agg(s.id), '{}') into v_sups from s;
  insert into stock_co_suppliers (id, org_id, local_location_id, name, contact_name, phone, email, payment_terms_days,
                                  min_order_value, notes, archived_at, created_at)
  select t.company_ref, p_org, null, t.name, t.contact_name, t.phone, t.email, t.payment_terms_days,
         t.min_order_value, t.notes, t.archived_at, t.created_at
    from suppliers t
   where t.id = any(v_sups);
  insert into stock_co_supplier_sites (supplier_id, org_id, location_id, site_supplier_id, can_order)
  select t.company_ref, p_org, t.location_id, t.id, true
    from suppliers t
   where t.id = any(v_sups);
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, t.location_id, 'supplier', t.company_ref, null, null, jsonb_build_object('site_row', t.id), null, 'Company setup', 'backfill'
    from suppliers t
   where t.id = any(v_sups);

  -- -- supplier items (the item and the supplier have their company rows by now) ---
  with s as (
    update supplier_products t set company_ref = gen_random_uuid()
     where t.location_id = any(v_locs) and t.company_ref is null
    returning t.id
  ) select coalesce(array_agg(s.id), '{}') into v_sps from s;
  insert into stock_co_supplier_items (id, org_id, item_id, supplier_id, sku, pack_description, pack_qty, inner_qty, inner_unit,
                                       pack_price, currency, purchase_vat_rate, price_includes_tax, archived_at, created_at)
  select t.company_ref, p_org, i.company_ref, s.company_ref, t.supplier_sku, t.pack_description, t.pack_qty, t.inner_qty, t.inner_unit,
         t.pack_price, coalesce(nullif(upper(btrim(l.currency)), ''), 'GBP'),
         (select r.rate from tax_rates r where r.id = t.purchase_tax_rate_id), coalesce(t.price_includes_tax, false),
         t.archived_at, t.created_at
    from supplier_products t
    join inventory_items i on i.id = t.inventory_item_id
    join suppliers s on s.id = t.supplier_id
    join locations l on l.id = t.location_id
   where t.id = any(v_sps);
  -- price here null: the site follows the company price, which is its own price today
  insert into stock_co_supplier_item_sites (supplier_item_id, org_id, location_id, site_supplier_product_id, price_here, off_here, paused)
  select t.company_ref, p_org, t.location_id, t.id, null, false, false
    from supplier_products t
   where t.id = any(v_sps);
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, t.location_id, 'supplier_item', t.company_ref, null, null, jsonb_build_object('site_row', t.id), null, 'Company setup', 'backfill'
    from supplier_products t
   where t.id = any(v_sps);
  -- the main supplier item of each new company item is the preferred live supplier pack of its site row
  update stock_co_items c
     set main_supplier_item_id = sp.company_ref
    from inventory_items t
    join supplier_products sp on sp.inventory_item_id = t.id and sp.location_id = t.location_id
                             and sp.is_preferred and sp.archived_at is null and sp.company_ref is not null
   where t.id = any(v_items) and c.id = t.company_ref and c.main_supplier_item_id is null;

  -- -- packs (the parent is set in a second statement, so no row needs another row of the same
  --    statement to exist first) ------------------------------------------------
  with s as (
    update item_packaging_formats t set company_ref = gen_random_uuid()
     where t.location_id = any(v_locs) and t.company_ref is null
    returning t.id
  ) select coalesce(array_agg(s.id), '{}') into v_packs from s;
  insert into stock_co_packs (id, org_id, item_id, name, qty_in_base, parent_pack_id, is_count_default, is_purchase_default,
                              archived_at, created_at)
  select t.company_ref, p_org, i.company_ref, t.name, t.qty_in_base, null, coalesce(t.is_count_default, false),
         coalesce(t.is_purchase_default, false), t.archived_at, t.created_at
    from item_packaging_formats t
    join inventory_items i on i.id = t.inventory_item_id
   where t.id = any(v_packs);
  update stock_co_packs cp
     set parent_pack_id = pf.company_ref
    from item_packaging_formats t
    join item_packaging_formats pf on pf.id = t.parent_format_id
   where t.id = any(v_packs) and cp.id = t.company_ref and pf.company_ref is not null;
  insert into stock_co_pack_sites (pack_id, org_id, location_id, site_pack_id)
  select t.company_ref, p_org, t.location_id, t.id
    from item_packaging_formats t
   where t.id = any(v_packs);
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, t.location_id, 'pack', t.company_ref, null, null, jsonb_build_object('site_row', t.id), null, 'Company setup', 'backfill'
    from item_packaging_formats t
   where t.id = any(v_packs);

  -- -- unit conversions (bridges) ---------------------------------------------
  with s as (
    update inventory_item_conversions t set company_ref = gen_random_uuid()
     where t.location_id = any(v_locs) and t.company_ref is null
    returning t.id
  ) select coalesce(array_agg(s.id), '{}') into v_bridges from s;
  insert into stock_co_bridges (id, org_id, item_id, from_qty, from_unit, to_qty, to_unit, archived_at, created_at)
  select t.company_ref, p_org, i.company_ref, t.from_qty, t.from_unit, t.to_qty, t.to_unit, t.archived_at, t.created_at
    from inventory_item_conversions t
    join inventory_items i on i.id = t.inventory_item_id
   where t.id = any(v_bridges);
  insert into stock_co_bridge_sites (bridge_id, org_id, location_id, site_bridge_id)
  select t.company_ref, p_org, t.location_id, t.id
    from inventory_item_conversions t
   where t.id = any(v_bridges);
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, t.location_id, 'bridge', t.company_ref, null, null, jsonb_build_object('site_row', t.id), null, 'Company setup', 'backfill'
    from inventory_item_conversions t
   where t.id = any(v_bridges);

  -- -- recipes, their lines and their till link --------------------------------
  with s as (
    update recipes t set company_ref = gen_random_uuid()
     where t.location_id = any(v_locs) and t.company_ref is null
    returning t.id
  ) select coalesce(array_agg(s.id), '{}') into v_recipes from s;
  insert into stock_co_recipes (id, org_id, local_location_id, kind, name, yield_qty, yield_unit, output_item_id, wastage_pct,
                                method, photo, gp_target_pct, restricted, archived_at, created_at)
  select t.company_ref, p_org, null,
         case t.recipe_type when 'MENU' then 'dish' when 'BATCH' then 'batch' when 'PREP' then 'prep' end,
         t.name, t.yield_qty, t.yield_unit, (select i.company_ref from inventory_items i where i.id = t.output_item_id),
         t.wastage_pct, t.method, t.photo, t.gp_target_pct, false, t.archived_at, t.created_at
    from recipes t
   where t.id = any(v_recipes);
  -- a pack line is stored at the site as '@' plus that site's pack id; the company line is '@' with
  -- the company pack. base_qty is the line's base quantity as every sale works it out today.
  insert into stock_co_recipe_lines (org_id, recipe_id, component_item_id, component_recipe_id, qty, unit, pack_id, usable_pct,
                                     order_types, note, sort_order, base_qty)
  select p_org, r.company_ref, i.company_ref, null, rl.qty,
         case when left(rl.unit, 1) = '@' then '@' else rl.unit end,
         case when left(rl.unit, 1) = '@'
              then (select f.company_ref from item_packaging_formats f
                     where f.id::text = substr(rl.unit, 2) and f.inventory_item_id = rl.component_item_id) end,
         rl.usable_pct, rl.order_types, rl.note, rl.sort_order,
         public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id)
    from recipe_lines rl
    join recipes r on r.id = rl.recipe_id
    join inventory_items i on i.id = rl.component_item_id
   where r.id = any(v_recipes);
  get diagnostics v_lines = row_count;
  insert into stock_co_recipe_sites (recipe_id, org_id, location_id, on_here, site_recipe_id, site_menu_item_id)
  select t.company_ref, p_org, t.location_id, true, t.id,
         (select m.menu_item_id from menu_item_recipes m
           where m.recipe_id = t.id and m.location_id = t.location_id
           order by m.created_at, m.id limit 1)
    from recipes t
   where t.id = any(v_recipes);
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, t.location_id, 'recipe', t.company_ref, null, null, jsonb_build_object('site_row', t.id), null, 'Company setup', 'backfill'
    from recipes t
   where t.id = any(v_recipes);

  -- -- THE SELF CHECK: the writer, in check mode, plans no write at any site of the company ----
  for v_loc in select l.id, l.name from locations l where l.id = any(v_locs) order by l.name, l.id loop
    v_plan := public.stock_co__sync_site(v_loc.id, null, null, false, true);
    if coalesce((v_plan ->> 'writes')::integer, -1) <> 0 then
      raise exception 'Company records stopped and nothing was changed: at % the company list would still change % stock rows (first: %).',
        v_loc.name, coalesce(v_plan ->> 'writes', 'an unknown number of'), left(coalesce((v_plan -> 'detail')::text, ''), 400)
        using errcode = '55000';
    end if;
    v_plan := public.stock_co__sync_recipes(v_loc.id, null, false, true);
    if coalesce((v_plan ->> 'writes')::integer, -1) <> 0 then
      raise exception 'Company records stopped and nothing was changed: at % the company recipes would still change % recipe rows (first: %).',
        v_loc.name, coalesce(v_plan ->> 'writes', 'an unknown number of'), left(coalesce((v_plan -> 'detail')::text, ''), 400)
        using errcode = '55000';
    end if;
  end loop;

  return jsonb_build_object('org_id', p_org, 'items', cardinality(v_items), 'suppliers', cardinality(v_sups),
                            'supplier_items', cardinality(v_sps), 'packs', cardinality(v_packs),
                            'bridges', cardinality(v_bridges), 'recipes', cardinality(v_recipes), 'lines', v_lines);
end
$fn$;

comment on function public.stock_co__backfill(uuid) is
  'Multi site stock (20261021a): company records from every site row of a company that has none, with a zero write self check per site. Writes only company tables, the change log and company_ref.';

-- ============================================================================
-- 20. Two sites become one list, with no stock number moving
-- ============================================================================
-- Named sub step: the keep site's packs on items that are now at both sites become new
-- item_packaging_formats rows at p_to with their own ids. The parent of a nested pack points at the
-- new p_to parent. Flags are kept (packs and their defaults are company wide). Records its count in
-- _stock_native_fills when that table exists (inside 0a). Returns the rows inserted.
create or replace function public.stock_co__fill_packs(p_org uuid, p_from uuid, p_to uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_cpacks uuid[];
  v_new uuid[];
  v_n integer := 0;
begin
  if p_from is null or p_to is null or p_from = p_to
     or not exists (select 1 from locations l where l.id = p_from and l.org_id = p_org)
     or not exists (select 1 from locations l where l.id = p_to and l.org_id = p_org) then
    raise exception 'Pack fill stopped: both sites must be different sites of that company. Nothing was changed.' using errcode = '22023';
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);

  -- live company packs held at p_from, on items that are at both sites (and on at p_to), not yet at
  -- p_to; each gets its new p_to id here (the two arrays line up by company pack id)
  select coalesce(array_agg(cp.id order by cp.id), '{}'), coalesce(array_agg(gen_random_uuid() order by cp.id), '{}')
    into v_cpacks, v_new
    from stock_co_packs cp
   where cp.org_id = p_org and cp.archived_at is null
     and exists (select 1 from stock_co_pack_sites f where f.pack_id = cp.id and f.location_id = p_from)
     and exists (select 1 from stock_co_item_sites fs where fs.item_id = cp.item_id and fs.location_id = p_from)
     and exists (select 1 from stock_co_item_sites ts where ts.item_id = cp.item_id and ts.location_id = p_to and ts.on_here)
     and not exists (select 1 from stock_co_pack_sites x where x.pack_id = cp.id and x.location_id = p_to);

  insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base, parent_format_id,
                                      is_count_default, is_purchase_default, company_ref)
  select m.new_id, p_to, ts.site_item_id, cp.name, cp.qty_in_base,
         case when cp.parent_pack_id is null then null
              else coalesce((select m2.new_id from unnest(v_cpacks, v_new) as m2(cpack, new_id) where m2.cpack = cp.parent_pack_id),
                            (select x.site_pack_id from stock_co_pack_sites x where x.pack_id = cp.parent_pack_id and x.location_id = p_to)) end,
         cp.is_count_default, cp.is_purchase_default, cp.id
    from unnest(v_cpacks, v_new) as m(cpack, new_id)
    join stock_co_packs cp on cp.id = m.cpack
    join stock_co_item_sites ts on ts.item_id = cp.item_id and ts.location_id = p_to;
  get diagnostics v_n = row_count;

  insert into stock_co_pack_sites (pack_id, org_id, location_id, site_pack_id)
  select m.cpack, p_org, p_to, m.new_id from unnest(v_cpacks, v_new) as m(cpack, new_id);
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, p_to, 'pack', m.cpack, 'site_row', null, jsonb_build_object('site_row', m.new_id, 'from_site', p_from),
         null, 'Company setup', 'fill'
    from unnest(v_cpacks, v_new) as m(cpack, new_id);

  if to_regclass('pg_temp._stock_native_fills') is not null then
    update pg_temp._stock_native_fills f set n = f.n + v_n where f.location_id = p_to and f.metric = 'n:item_packaging_formats';
    if not found then
      insert into pg_temp._stock_native_fills (location_id, metric, n) values (p_to, 'n:item_packaging_formats', v_n);
    end if;
  end if;
  return v_n;
end
$fn$;

-- Named sub step: the keep site's unit conversions (bridges) on items that are now at both sites
-- become new inventory_item_conversions rows at p_to with their own ids. Records its count in
-- _stock_native_fills when that table exists (inside 0a). Returns the rows inserted.
create or replace function public.stock_co__fill_bridges(p_org uuid, p_from uuid, p_to uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_cbridges uuid[];
  v_new uuid[];
  v_n integer := 0;
begin
  if p_from is null or p_to is null or p_from = p_to
     or not exists (select 1 from locations l where l.id = p_from and l.org_id = p_org)
     or not exists (select 1 from locations l where l.id = p_to and l.org_id = p_org) then
    raise exception 'Unit conversion fill stopped: both sites must be different sites of that company. Nothing was changed.' using errcode = '22023';
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);

  select coalesce(array_agg(cb.id order by cb.id), '{}'), coalesce(array_agg(gen_random_uuid() order by cb.id), '{}')
    into v_cbridges, v_new
    from stock_co_bridges cb
   where cb.org_id = p_org and cb.archived_at is null
     and exists (select 1 from stock_co_bridge_sites f where f.bridge_id = cb.id and f.location_id = p_from)
     and exists (select 1 from stock_co_item_sites fs where fs.item_id = cb.item_id and fs.location_id = p_from)
     and exists (select 1 from stock_co_item_sites ts where ts.item_id = cb.item_id and ts.location_id = p_to and ts.on_here)
     and not exists (select 1 from stock_co_bridge_sites x where x.bridge_id = cb.id and x.location_id = p_to);

  insert into inventory_item_conversions (id, location_id, inventory_item_id, from_qty, from_unit, to_qty, to_unit, company_ref)
  select m.new_id, p_to, ts.site_item_id, cb.from_qty, cb.from_unit, cb.to_qty, cb.to_unit, cb.id
    from unnest(v_cbridges, v_new) as m(cbridge, new_id)
    join stock_co_bridges cb on cb.id = m.cbridge
    join stock_co_item_sites ts on ts.item_id = cb.item_id and ts.location_id = p_to;
  get diagnostics v_n = row_count;

  insert into stock_co_bridge_sites (bridge_id, org_id, location_id, site_bridge_id)
  select m.cbridge, p_org, p_to, m.new_id from unnest(v_cbridges, v_new) as m(cbridge, new_id);
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, p_to, 'bridge', m.cbridge, 'site_row', null, jsonb_build_object('site_row', m.new_id, 'from_site', p_from),
         null, 'Company setup', 'fill'
    from unnest(v_cbridges, v_new) as m(cbridge, new_id);

  if to_regclass('pg_temp._stock_native_fills') is not null then
    update pg_temp._stock_native_fills f set n = f.n + v_n where f.location_id = p_to and f.metric = 'n:inventory_item_conversions';
    if not found then
      insert into pg_temp._stock_native_fills (location_id, metric, n) values (p_to, 'n:inventory_item_conversions', v_n);
    end if;
  end if;
  return v_n;
end
$fn$;

-- The link (design 3.2, map 7.3 step 20). p_keep_location is the site whose company rows are kept;
-- the link site's matching rows join them, and the company rows the backfill made for the link site
-- (now spare) are deleted. Only company_ref and link rows change on site rows, plus the two fills.
--   items: same name and same base unit, exactly one live match on each side (no SKU pass). Two of a
--     name at one site never merge (merging would move stock). A pair also needs every company column
--     the writer carries to a site to be the same on both sides, and the link site row to have no
--     packs or unit conversions of its own (it takes the keep site's in the fills), so linking never
--     plans a site write; a pair that fails this stays two company items.
--   suppliers: same name, exactly one each side, and the same company columns.
--   supplier items: same item pair, supplier pair, pack size and SKU, exactly one each side, same
--     pack words, VAT rate value, tax flag and currency. A link site price that differs becomes its
--     price_here, so no site row changes. An item with a live supplier pack from a paired supplier
--     that finds no pair stays two company items (else the writer would add that pack at the other
--     site).
--   dish recipes: the same till product through the Multi site menu (msm_product_sites maps both
--     venue_item_ids to one product_id), else the same menu_items master (master_id, or the item's own
--     id when it is the master). Batch and prep recipes: same kind, name and output item (by the item
--     link above). A pair whose recipe columns and lines are identical merges; a pair that differs
--     stays two company recipes; a link site recipe with no pair stays its own (link_only).
create or replace function public.stock_co__link(p_org uuid, p_keep_location uuid, p_link_location uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_keep_name text;
  v_link_name text;
  v_ik uuid[]; v_il uuid[];                         -- item pairs: kept company id, spare company id
  v_sk uuid[]; v_sl uuid[];                         -- supplier pairs
  v_pk uuid[]; v_pl uuid[]; v_price numeric[];      -- supplier item pairs, link site price when it differs
  v_lonely uuid[];                                  -- paired items with a supplier pack that found no pair
  v_rk uuid[]; v_rl uuid[]; v_rsame boolean[];      -- recipe pairs, identical or not
  v_merged integer := 0;
  v_differ integer := 0;
  v_link_only integer := 0;
  v_packs integer := 0;
  v_bridges integer := 0;
  v_loc record;
  v_plan jsonb;
begin
  select l.name into v_keep_name from locations l where l.id = p_keep_location and l.org_id = p_org;
  select l.name into v_link_name from locations l where l.id = p_link_location and l.org_id = p_org;
  if v_keep_name is null or v_link_name is null or p_keep_location = p_link_location then
    raise exception 'Linking stopped: both sites must be different sites of that company. Nothing was changed.' using errcode = '22023';
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);

  -- -- which rows pair (worked out on the rows as the backfill left them) ------
  with k as (
    select t.company_ref as cid, t.name, t.base_unit
      from inventory_items t
     where t.location_id = p_keep_location and t.archived_at is null and t.company_ref is not null
  ), l as (
    select t.company_ref as cid, t.name, t.base_unit, t.id as site_id
      from inventory_items t
     where t.location_id = p_link_location and t.archived_at is null and t.company_ref is not null
  ), m as (
    select k.cid as keep_cid, l.cid as link_cid, l.site_id,
           count(*) over (partition by k.cid) as choices, count(*) over (partition by l.cid) as venue_choices
      from k join l on l.name = k.name and l.base_unit = k.base_unit
  )
  select coalesce(array_agg(m.keep_cid order by m.keep_cid), '{}'), coalesce(array_agg(m.link_cid order by m.keep_cid), '{}')
    into v_ik, v_il
    from m
    join stock_co_items kc on kc.id = m.keep_cid and kc.org_id = p_org
    join stock_co_items lc on lc.id = m.link_cid and lc.org_id = p_org
   where m.choices = 1 and m.venue_choices = 1 and m.keep_cid <> m.link_cid
     and kc.local_location_id is null and lc.local_location_id is null
     and (kc.name, kc.base_unit, kc.category, kc.accounting_group, kc.type, kc.allergens, kc.sku, kc.barcode, kc.shelf_life_days,
          kc.returns_to_shelf, kc.purchase_vat_rate, kc.notes, kc.archived_at)
         is not distinct from
         (lc.name, lc.base_unit, lc.category, lc.accounting_group, lc.type, lc.allergens, lc.sku, lc.barcode, lc.shelf_life_days,
          lc.returns_to_shelf, lc.purchase_vat_rate, lc.notes, lc.archived_at)
     and not exists (select 1 from stock_co_item_sites s where s.item_id = m.keep_cid and s.location_id <> p_keep_location)
     and not exists (select 1 from stock_co_item_sites s where s.item_id = m.link_cid and s.location_id <> p_link_location)
     and not exists (select 1 from item_packaging_formats f where f.inventory_item_id = m.site_id)
     and not exists (select 1 from inventory_item_conversions c where c.inventory_item_id = m.site_id)
     and not exists (select 1 from stock_co_packs p where p.item_id = m.link_cid)
     and not exists (select 1 from stock_co_bridges b where b.item_id = m.link_cid);

  with k as (
    select t.company_ref as cid, t.name from suppliers t
     where t.location_id = p_keep_location and t.archived_at is null and t.company_ref is not null
  ), l as (
    select t.company_ref as cid, t.name from suppliers t
     where t.location_id = p_link_location and t.archived_at is null and t.company_ref is not null
  ), m as (
    select k.cid as keep_cid, l.cid as link_cid,
           count(*) over (partition by k.cid) as choices, count(*) over (partition by l.cid) as venue_choices
      from k join l on l.name = k.name
  )
  select coalesce(array_agg(m.keep_cid order by m.keep_cid), '{}'), coalesce(array_agg(m.link_cid order by m.keep_cid), '{}')
    into v_sk, v_sl
    from m
    join stock_co_suppliers kc on kc.id = m.keep_cid and kc.org_id = p_org
    join stock_co_suppliers lc on lc.id = m.link_cid and lc.org_id = p_org
   where m.choices = 1 and m.venue_choices = 1 and m.keep_cid <> m.link_cid
     and kc.local_location_id is null and lc.local_location_id is null
     and (kc.name, kc.contact_name, kc.phone, kc.email, kc.payment_terms_days, kc.min_order_value, kc.notes, kc.archived_at)
         is not distinct from
         (lc.name, lc.contact_name, lc.phone, lc.email, lc.payment_terms_days, lc.min_order_value, lc.notes, lc.archived_at)
     and not exists (select 1 from stock_co_supplier_sites s where s.supplier_id = m.keep_cid and s.location_id <> p_keep_location)
     and not exists (select 1 from stock_co_supplier_sites s where s.supplier_id = m.link_cid and s.location_id <> p_link_location);

  -- A company supplier pack is on at every site that has both its item and its supplier, so a live
  -- supplier pack of a paired item from a paired supplier that finds no pair on the other side would
  -- be planned as a new row there. Such an item stays two company items (its supplier stays shared),
  -- and the supplier packs are paired again without it. Two rounds at most: taking an item out never
  -- leaves another item's supplier pack without its pair.
  loop
    with ip as (
      select * from unnest(v_ik, v_il) as x(keep_cid, link_cid)
    ), sp as (
      select * from unnest(v_sk, v_sl) as x(keep_cid, link_cid)
    ), m as (
      select kc.id as keep_cid, lc.id as link_cid, kc.pack_price as keep_price, lc.pack_price as link_price,
             count(*) over (partition by kc.id) as choices, count(*) over (partition by lc.id) as venue_choices
        from stock_co_supplier_items lc
        join ip on ip.link_cid = lc.item_id
        join sp on sp.link_cid = lc.supplier_id
        join stock_co_supplier_items kc on kc.item_id = ip.keep_cid and kc.supplier_id = sp.keep_cid and kc.org_id = p_org
                                       and kc.pack_qty = lc.pack_qty and kc.inner_qty = lc.inner_qty and kc.inner_unit = lc.inner_unit
                                       and kc.sku is not distinct from lc.sku
       where lc.org_id = p_org and lc.archived_at is null and kc.archived_at is null
    )
    select coalesce(array_agg(m.keep_cid order by m.keep_cid), '{}'), coalesce(array_agg(m.link_cid order by m.keep_cid), '{}'),
           coalesce(array_agg(case when m.link_price is distinct from m.keep_price then m.link_price end order by m.keep_cid), '{}')
      into v_pk, v_pl, v_price
      from m
      join stock_co_supplier_items kc on kc.id = m.keep_cid
      join stock_co_supplier_items lc on lc.id = m.link_cid
     where m.choices = 1 and m.venue_choices = 1 and m.keep_cid <> m.link_cid
       and (kc.pack_description, kc.price_includes_tax, kc.purchase_vat_rate, kc.currency)
           is not distinct from (lc.pack_description, lc.price_includes_tax, lc.purchase_vat_rate, lc.currency)
       and not exists (select 1 from stock_co_supplier_item_sites s where s.supplier_item_id = m.keep_cid and s.location_id <> p_keep_location)
       and not exists (select 1 from stock_co_supplier_item_sites s where s.supplier_item_id = m.link_cid and s.location_id <> p_link_location);

    select coalesce(array_agg(p.keep_cid), '{}') into v_lonely
      from unnest(v_ik, v_il) as p(keep_cid, link_cid)
     where exists (select 1 from stock_co_supplier_items si
                    where si.org_id = p_org and si.archived_at is null
                      and ((si.item_id = p.keep_cid and si.supplier_id = any (v_sk))
                           or (si.item_id = p.link_cid and si.supplier_id = any (v_sl)))
                      and not (si.id = any (v_pk) or si.id = any (v_pl)));
    exit when cardinality(v_lonely) = 0;
    select coalesce(array_agg(p.keep_cid order by p.keep_cid), '{}'), coalesce(array_agg(p.link_cid order by p.keep_cid), '{}')
      into v_ik, v_il
      from unnest(v_ik, v_il) as p(keep_cid, link_cid)
     where not (p.keep_cid = any (v_lonely));
  end loop;

  -- -- items: the link site rows join the kept company items ---------------------
  update stock_co_item_sites s
     set item_id = p.keep_cid, updated_at = now()
    from unnest(v_ik, v_il) as p(keep_cid, link_cid)
   where s.item_id = p.link_cid and s.location_id = p_link_location;
  update inventory_items t
     set company_ref = p.keep_cid
    from unnest(v_ik, v_il) as p(keep_cid, link_cid)
   where t.location_id = p_link_location and t.company_ref = p.link_cid;
  update stock_co_supplier_items c
     set item_id = p.keep_cid, updated_at = now()
    from unnest(v_ik, v_il) as p(keep_cid, link_cid)
   where c.item_id = p.link_cid;
  update stock_co_recipes c
     set output_item_id = p.keep_cid, updated_at = now()
    from unnest(v_ik, v_il) as p(keep_cid, link_cid)
   where c.output_item_id = p.link_cid;
  update stock_co_recipe_lines c
     set component_item_id = p.keep_cid
    from unnest(v_ik, v_il) as p(keep_cid, link_cid)
   where c.component_item_id = p.link_cid;
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, p_link_location, 'item', p.keep_cid, 'company_ref',
         jsonb_build_object('company_id', p.link_cid), jsonb_build_object('company_id', p.keep_cid, 'site_row', t.id),
         null, 'Company setup', 'link'
    from unnest(v_ik, v_il) as p(keep_cid, link_cid)
    join inventory_items t on t.location_id = p_link_location and t.company_ref = p.keep_cid;
  delete from stock_change_log g using unnest(v_il) as p(link_cid)
   where g.source = 'backfill' and g.entity = 'item' and g.entity_id = p.link_cid;
  delete from stock_co_items c using unnest(v_il) as p(link_cid)
   where c.id = p.link_cid and not exists (select 1 from stock_co_item_sites s where s.item_id = c.id);

  -- -- suppliers -------------------------------------------------------------
  update stock_co_supplier_sites s
     set supplier_id = p.keep_cid, updated_at = now()
    from unnest(v_sk, v_sl) as p(keep_cid, link_cid)
   where s.supplier_id = p.link_cid and s.location_id = p_link_location;
  update suppliers t
     set company_ref = p.keep_cid
    from unnest(v_sk, v_sl) as p(keep_cid, link_cid)
   where t.location_id = p_link_location and t.company_ref = p.link_cid;
  update stock_co_supplier_items c
     set supplier_id = p.keep_cid, updated_at = now()
    from unnest(v_sk, v_sl) as p(keep_cid, link_cid)
   where c.supplier_id = p.link_cid;
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, p_link_location, 'supplier', p.keep_cid, 'company_ref',
         jsonb_build_object('company_id', p.link_cid), jsonb_build_object('company_id', p.keep_cid, 'site_row', t.id),
         null, 'Company setup', 'link'
    from unnest(v_sk, v_sl) as p(keep_cid, link_cid)
    join suppliers t on t.location_id = p_link_location and t.company_ref = p.keep_cid;
  delete from stock_change_log g using unnest(v_sl) as p(link_cid)
   where g.source = 'backfill' and g.entity = 'supplier' and g.entity_id = p.link_cid;
  delete from stock_co_suppliers c using unnest(v_sl) as p(link_cid)
   where c.id = p.link_cid and not exists (select 1 from stock_co_supplier_sites s where s.supplier_id = c.id);

  -- -- supplier items: a differing link site price becomes its price here ------
  update stock_co_supplier_item_sites s
     set supplier_item_id = p.keep_cid, price_here = p.price_here, updated_at = now()
    from unnest(v_pk, v_pl, v_price) as p(keep_cid, link_cid, price_here)
   where s.supplier_item_id = p.link_cid and s.location_id = p_link_location;
  update supplier_products t
     set company_ref = p.keep_cid
    from unnest(v_pk, v_pl) as p(keep_cid, link_cid)
   where t.location_id = p_link_location and t.company_ref = p.link_cid;
  update stock_co_items c
     set main_supplier_item_id = p.keep_cid, updated_at = now()
    from unnest(v_pk, v_pl) as p(keep_cid, link_cid)
   where c.main_supplier_item_id = p.link_cid;
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, p_link_location, 'supplier_item', p.keep_cid, 'company_ref',
         jsonb_build_object('company_id', p.link_cid),
         jsonb_build_object('company_id', p.keep_cid, 'site_row', t.id, 'price_here', p.price_here),
         null, 'Company setup', 'link'
    from unnest(v_pk, v_pl, v_price) as p(keep_cid, link_cid, price_here)
    join supplier_products t on t.location_id = p_link_location and t.company_ref = p.keep_cid;
  delete from stock_change_log g using unnest(v_pl) as p(link_cid)
   where g.source = 'backfill' and g.entity = 'supplier_item' and g.entity_id = p.link_cid;
  delete from stock_co_supplier_items c using unnest(v_pl) as p(link_cid)
   where c.id = p.link_cid and not exists (select 1 from stock_co_supplier_item_sites s where s.supplier_item_id = c.id);

  -- -- recipes (paired after the items, so output items and line components compare directly) ---
  with lr as (
    select r.id as site_id, c.id as cid, c.kind, c.name, c.output_item_id
      from recipes r
      join stock_co_recipes c on c.id = r.company_ref and c.org_id = p_org
     where r.location_id = p_link_location and r.archived_at is null and c.local_location_id is null
       and not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = c.id and s.location_id <> p_link_location)
  ), kr as (
    select r.id as site_id, c.id as cid, c.kind, c.name, c.output_item_id
      from recipes r
      join stock_co_recipes c on c.id = r.company_ref and c.org_id = p_org
     where r.location_id = p_keep_location and r.archived_at is null and c.local_location_id is null
       and not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = c.id and s.location_id <> p_keep_location)
  ), lprod as (
    select distinct lr.cid, ps.product_id
      from lr
      join menu_item_recipes mr on mr.recipe_id = lr.site_id and mr.location_id = p_link_location
      join msm_product_sites ps on ps.location_id = p_link_location::text and ps.venue_item_id = mr.menu_item_id
     where lr.kind = 'dish'
  ), kprod as (
    select distinct kr.cid, ps.product_id
      from kr
      join menu_item_recipes mr on mr.recipe_id = kr.site_id and mr.location_id = p_keep_location
      join msm_product_sites ps on ps.location_id = p_keep_location::text and ps.venue_item_id = mr.menu_item_id
     where kr.kind = 'dish'
  ), by_product as (
    select distinct kp.cid as keep_cid, lp.cid as link_cid
      from lprod lp join kprod kp on kp.product_id = lp.product_id
  ), lmaster as (
    select distinct lr.cid, coalesce(mi.master_id, mi.id) as mkey
      from lr
      join menu_item_recipes mr on mr.recipe_id = lr.site_id and mr.location_id = p_link_location
      join menu_items mi on mi.id = mr.menu_item_id and mi.location_id = p_link_location::text
     where lr.kind = 'dish' and not exists (select 1 from by_product b where b.link_cid = lr.cid)
  ), kmaster as (
    select distinct kr.cid, coalesce(mi.master_id, mi.id) as mkey
      from kr
      join menu_item_recipes mr on mr.recipe_id = kr.site_id and mr.location_id = p_keep_location
      join menu_items mi on mi.id = mr.menu_item_id and mi.location_id = p_keep_location::text
     where kr.kind = 'dish'
  ), by_master as (
    select distinct km.cid as keep_cid, lm.cid as link_cid
      from lmaster lm join kmaster km on km.mkey = lm.mkey
  ), by_name as (
    select kr.cid as keep_cid, lr.cid as link_cid
      from lr join kr on kr.kind = lr.kind and kr.name = lr.name and kr.output_item_id = lr.output_item_id
     where lr.kind in ('batch', 'prep')
  ), cand as (
    select b.keep_cid, b.link_cid from by_product b
    union select b.keep_cid, b.link_cid from by_master b
    union select b.keep_cid, b.link_cid from by_name b
  ), counted as (
    select c.keep_cid, c.link_cid,
           count(*) over (partition by c.keep_cid) as choices, count(*) over (partition by c.link_cid) as venue_choices
      from cand c
  ), pairs as (
    select c.keep_cid, c.link_cid,
           ((kc.kind, kc.food_kind, kc.meal_food_pct, kc.name, kc.yield_qty, kc.yield_unit, kc.output_item_id, kc.portion_weight_g,
             kc.cooking_yield_pct, kc.wastage_pct, kc.method, kc.photo, kc.gp_target_pct, kc.shelf_life_days, kc.restricted, kc.archived_at)
            is not distinct from
            (lc.kind, lc.food_kind, lc.meal_food_pct, lc.name, lc.yield_qty, lc.yield_unit, lc.output_item_id, lc.portion_weight_g,
             lc.cooking_yield_pct, lc.wastage_pct, lc.method, lc.photo, lc.gp_target_pct, lc.shelf_life_days, lc.restricted, lc.archived_at))
           and coalesce((select jsonb_agg(q.e order by q.e)
                           from (select jsonb_build_array(x.component_item_id, x.component_recipe_id, x.qty, x.unit, x.pack_id,
                                                          x.usable_pct, x.order_types, x.note, x.sort_order) as e
                                   from stock_co_recipe_lines x where x.recipe_id = kc.id) q), '[]'::jsonb)
             = coalesce((select jsonb_agg(q.e order by q.e)
                           from (select jsonb_build_array(x.component_item_id, x.component_recipe_id, x.qty, x.unit, x.pack_id,
                                                          x.usable_pct, x.order_types, x.note, x.sort_order) as e
                                   from stock_co_recipe_lines x where x.recipe_id = lc.id) q), '[]'::jsonb) as same
      from counted c
      join stock_co_recipes kc on kc.id = c.keep_cid
      join stock_co_recipes lc on lc.id = c.link_cid
     where c.choices = 1 and c.venue_choices = 1 and c.keep_cid <> c.link_cid
  )
  select coalesce(array_agg(p.keep_cid order by p.link_cid), '{}'), coalesce(array_agg(p.link_cid order by p.link_cid), '{}'),
         coalesce(array_agg(p.same order by p.link_cid), '{}')
    into v_rk, v_rl, v_rsame
    from pairs p;

  select count(*) filter (where p.same), count(*) filter (where not p.same)
    into v_merged, v_differ
    from unnest(v_rk, v_rl, v_rsame) as p(keep_cid, link_cid, same);
  -- link only: live link site recipes whose company recipe is at that site only and found no pair
  select count(*) - v_merged - v_differ into v_link_only
    from recipes r
    join stock_co_recipes c on c.id = r.company_ref and c.org_id = p_org
   where r.location_id = p_link_location and r.archived_at is null and c.local_location_id is null
     and not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = c.id and s.location_id <> p_link_location);

  -- identical pairs merge: the link site recipe joins the kept company recipe (its till link stays
  -- in its own recipe site row); the spare company recipe and its lines go
  update stock_co_recipe_sites s
     set recipe_id = p.keep_cid, updated_at = now()
    from unnest(v_rk, v_rl, v_rsame) as p(keep_cid, link_cid, same)
   where p.same and s.recipe_id = p.link_cid and s.location_id = p_link_location;
  update recipes t
     set company_ref = p.keep_cid
    from unnest(v_rk, v_rl, v_rsame) as p(keep_cid, link_cid, same)
   where p.same and t.location_id = p_link_location and t.company_ref = p.link_cid;
  insert into stock_change_log (org_id, location_id, entity, entity_id, field, before, after, who, who_name, source)
  select p_org, p_link_location, 'recipe', p.keep_cid, 'company_ref',
         jsonb_build_object('company_id', p.link_cid), jsonb_build_object('company_id', p.keep_cid, 'site_row', t.id),
         null, 'Company setup', 'link'
    from unnest(v_rk, v_rl, v_rsame) as p(keep_cid, link_cid, same)
    join recipes t on t.location_id = p_link_location and t.company_ref = p.keep_cid
   where p.same;
  delete from stock_change_log g using unnest(v_rl, v_rsame) as p(link_cid, same)
   where p.same and g.source = 'backfill' and g.entity = 'recipe' and g.entity_id = p.link_cid;
  delete from stock_co_recipes c using unnest(v_rl, v_rsame) as p(link_cid, same)
   where p.same and c.id = p.link_cid and not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = c.id);

  -- -- the two named fills at the link site ----------------------------------
  v_packs := public.stock_co__fill_packs(p_org, p_keep_location, p_link_location);
  v_bridges := public.stock_co__fill_bridges(p_org, p_keep_location, p_link_location);

  -- -- THE SELF CHECK again: no write planned at either site --------------------
  for v_loc in select l.id, l.name from locations l where l.id in (p_keep_location, p_link_location) order by l.name, l.id loop
    v_plan := public.stock_co__sync_site(v_loc.id, null, null, false, true);
    if coalesce((v_plan ->> 'writes')::integer, -1) <> 0 then
      raise exception 'Linking stopped and nothing was changed: at % the company list would still change % stock rows (first: %).',
        v_loc.name, coalesce(v_plan ->> 'writes', 'an unknown number of'), left(coalesce((v_plan -> 'detail')::text, ''), 400)
        using errcode = '55000';
    end if;
    v_plan := public.stock_co__sync_recipes(v_loc.id, null, false, true);
    if coalesce((v_plan ->> 'writes')::integer, -1) <> 0 then
      raise exception 'Linking stopped and nothing was changed: at % the company recipes would still change % recipe rows (first: %).',
        v_loc.name, coalesce(v_plan ->> 'writes', 'an unknown number of'), left(coalesce((v_plan -> 'detail')::text, ''), 400)
        using errcode = '55000';
    end if;
  end loop;

  return jsonb_build_object('items_shared', cardinality(v_ik), 'suppliers_shared', cardinality(v_sk),
                            'supplier_items_shared', cardinality(v_pk),
                            'recipe_pairs', jsonb_build_object('merged', v_merged, 'differ', v_differ, 'link_only', v_link_only),
                            'packs_filled', v_packs, 'bridges_filled', v_bridges);
end
$fn$;

comment on function public.stock_co__link(uuid, uuid, uuid) is
  'Multi site stock (20261021a): two sites of one company become one list. Re points company_ref and link rows, deletes the spare company rows, fills packs and unit conversions at the link site, zero write self check at both sites.';

-- State for this part only (dropped at the end of the transaction): the fills the compare allows,
-- what each run answered, and the figures after the runs.
create temp table _stock_native_fills (
  location_id uuid not null,
  metric text not null,
  n integer not null,
  primary key (location_id, metric)
) on commit drop;
create temp table _stock_native_runs (
  org_id uuid not null,
  step text not null,
  result jsonb not null,
  primary key (org_id, step)
) on commit drop;
create temp table _stock_native_now (
  location_id uuid not null,
  metric text not null,
  value numeric,
  primary key (location_id, metric)
) on commit drop;

-- Step 19 run: every company that holds stock (a venue with any stock item or supplier row; live
-- 20 Oct: the demo company a59a6d97 and fcbddcfd). Coffee Boy holds no stock: nothing to do.
do $step19$
declare
  v_org record;
  v_result jsonb;
begin
  for v_org in
    select distinct l.org_id from locations l
     where l.org_id is not null
       and (exists (select 1 from inventory_items i where i.location_id = l.id)
            or exists (select 1 from suppliers s where s.location_id = l.id))
     order by l.org_id
  loop
    v_result := public.stock_co__backfill(v_org.org_id);
    insert into pg_temp._stock_native_runs (org_id, step, result) values (v_org.org_id, 'backfill', v_result);
  end loop;
end
$step19$;

-- Step 20 run: Provo (kept) and Location 2 (linked) of the demo company. A database without the
-- demo company (a synthetic test database) has nothing to link; one site present but not the other,
-- or either site in another company, stops the whole file.
do $step20$
declare
  v_org constant uuid := 'a59a6d97-ffaa-470e-8bb7-04cba789f335';
  v_keep constant uuid := '7218c716-eeb4-4f96-b284-f3500823595c';
  v_link constant uuid := 'c3ebfa7f-61b3-4fbc-a192-e7e3949f370e';
  v_result jsonb;
begin
  if not exists (select 1 from public.locations l where l.id in (v_keep, v_link)) then
    raise notice 'The demo company sites are not in this database, so there is nothing to link.';
    return;
  end if;
  v_result := public.stock_co__link(v_org, v_keep, v_link);
  insert into pg_temp._stock_native_runs (org_id, step, result) values (v_org, 'link', v_result);
end
$step20$;

-- ============================================================================
-- 21. Who may call what
-- ============================================================================
-- Every new function (contract sections 2.1 to 2.5, by exact signature) is first taken from every
-- API role. A signature that does not exist stops the whole file. The seven replaced live functions
-- keep their live grants and are not named here.
revoke all on function public.user_profiles_stock_control_guard() from public, anon, authenticated, service_role;
revoke all on function public.set_stock_control(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_level(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_reach_locations() from public, anon, authenticated, service_role;
revoke all on function public.stock_reach_orgs() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__multi_mark() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__org_guard() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__site_item_in_use(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__unit_in_use(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__base_unit_lock() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__writer_ok() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__log(uuid, uuid, text, uuid, text, jsonb, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__enqueue(uuid, uuid, text, jsonb, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__run_job(bigint) from public, anon, authenticated, service_role;
revoke all on procedure public.stock_save_queue_run(integer) from public, anon, authenticated, service_role;
revoke all on function public._stock_revalue(uuid, uuid, numeric, numeric, numeric, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__cost_rule_of(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__rate_id_for(uuid, numeric, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__cost_step(uuid, uuid[], bigint, boolean) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__sync_site(uuid, uuid[], uuid[], boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__sync_recipes(uuid, uuid[], boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__allowed(text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__clean(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__bridge_needed(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__guard(uuid, text, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_item(jsonb, jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_archive_item(uuid, integer, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_item_site(uuid, uuid, jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_pack(jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_archive_pack(uuid, integer, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_set_pack_default(uuid, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_bridge(jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_archive_bridge(uuid, integer, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_supplier(jsonb, jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_archive_supplier(uuid, integer, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_supplier_site(uuid, uuid, jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_supplier_item(jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_supplier_item_site(uuid, uuid, jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_archive_supplier_item(uuid, integer, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_recipe(jsonb, jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_archive_recipe(uuid, integer, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_link_menu_item(uuid, text, uuid, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_recost_made_items(uuid, uuid[], text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_cost_rule(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_site_scope(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_item_detail(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_changes_page(text, uuid, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__orphan() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__mirror_lines() from public, anon, authenticated, service_role;
revoke all on function public.venue_clock_sync(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_nightly_cron_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.stock_nightly_send() from public, anon, authenticated, service_role;
revoke all on function public.stock_nightly_upkeep() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__venue_day(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.stock_day_sums_rebuild(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.sales_day_sums_rebuild(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_day_sums_check(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.sales_day_sums_check(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_opening_costs(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_approve_count_pin(uuid, text, text, text, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__backfill(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__link(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__fill_packs(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__fill_bridges(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Any other internal helper a part added (the stock_co__ prefix, two underscores, matched as a
-- regular expression where the underscore is a plain character): revoked too. A revoke, never a drop.
do $internals$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as sig, p.prokind
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname ~ '^stock_co__'
     order by p.oid
  loop
    execute format('revoke all on %s %s from public, anon, authenticated, service_role',
                   case when v_fn.prokind = 'p' then 'procedure' else 'function' end, v_fn.sig);
  end loop;
end
$internals$;

-- Then exactly these grants. Signed in Back Office logins (each function checks who is asking):
grant execute on function public.set_stock_control(uuid, text) to authenticated;
grant execute on function public.stock_save_item(jsonb, jsonb, integer, text) to authenticated;
grant execute on function public.stock_archive_item(uuid, integer, boolean, text) to authenticated;
grant execute on function public.stock_save_item_site(uuid, uuid, jsonb, integer, text) to authenticated;
grant execute on function public.stock_save_pack(jsonb, integer, text) to authenticated;
grant execute on function public.stock_archive_pack(uuid, integer, boolean, text) to authenticated;
grant execute on function public.stock_set_pack_default(uuid, text, integer, text) to authenticated;
grant execute on function public.stock_save_bridge(jsonb, integer, text) to authenticated;
grant execute on function public.stock_archive_bridge(uuid, integer, boolean, text) to authenticated;
grant execute on function public.stock_save_supplier(jsonb, jsonb, integer, text) to authenticated;
grant execute on function public.stock_archive_supplier(uuid, integer, boolean, text) to authenticated;
grant execute on function public.stock_save_supplier_site(uuid, uuid, jsonb, integer, text) to authenticated;
grant execute on function public.stock_save_supplier_item(jsonb, integer, text) to authenticated;
grant execute on function public.stock_save_supplier_item_site(uuid, uuid, jsonb, integer, text) to authenticated;
grant execute on function public.stock_archive_supplier_item(uuid, integer, boolean, text) to authenticated;
grant execute on function public.stock_save_recipe(jsonb, jsonb, integer, text) to authenticated;
grant execute on function public.stock_archive_recipe(uuid, integer, boolean, text) to authenticated;
grant execute on function public.stock_link_menu_item(uuid, text, uuid, numeric, text) to authenticated;
grant execute on function public.stock_recost_made_items(uuid, uuid[], text) to authenticated;
grant execute on function public.stock_save_cost_rule(uuid, text, uuid, uuid) to authenticated;
grant execute on function public.stock_site_scope(uuid) to authenticated;
grant execute on function public.stock_item_detail(uuid) to authenticated;
grant execute on function public.stock_changes_page(text, uuid, jsonb, integer) to authenticated;
grant execute on function public.stock_approve_count_pin(uuid, text, text, text, jsonb, boolean) to authenticated;
-- The reach helpers. Exception 1: stock_reach_locations keeps EXECUTE for anon, because the 51 + 14
-- swapped policies are TO public and an anon request to a stock table evaluates them; it returns no
-- rows for an anonymous session.
grant execute on function public.stock_reach_locations() to anon, authenticated, service_role;
grant execute on function public.stock_reach_orgs() to authenticated, service_role;
-- Exception 2: the 0b lock triggers run as the caller and call stock_co__writer_ok.
grant execute on function public.stock_co__writer_ok() to authenticated, service_role;
-- The service role (edge functions and the nightly run):
grant execute on function public.stock_level(uuid, uuid) to service_role;
grant execute on function public.venue_clock_sync(jsonb) to service_role;
grant execute on function public.stock_nightly_cron_ok(text) to service_role;
grant execute on function public.stock_nightly_upkeep() to service_role;
grant execute on function public.stock_day_sums_rebuild(uuid, date, date) to service_role;
grant execute on function public.sales_day_sums_rebuild(uuid, date, date) to service_role;
grant execute on function public.stock_day_sums_check(uuid, date) to service_role;
grant execute on function public.sales_day_sums_check(uuid, date) to service_role;
grant execute on function public.stock_opening_costs(uuid) to service_role;

notify pgrst, 'reload schema';

-- ============================================================================
-- 22. The compare against the snapshot part 1 took under the item row locks
-- ============================================================================
-- The same 33 figures per venue as part 1 (26 row counts, 7 sums, null sums as 0). Every figure must
-- equal its snapshot plus the fill recorded for it (only Location 2's packs and unit conversions),
-- or this raises and the whole file rolls back by itself.
do $compare$
declare
  v_bad text;
begin
  if to_regclass('pg_temp._stock_native_snap') is null then
    raise exception 'The snapshot from the start of this file is missing. Run the whole file in one go. Nothing was changed.';
  end if;

  insert into pg_temp._stock_native_now (location_id, metric, value)
  select v.location_id, f.metric, coalesce(f.value, 0)
    from (select distinct s.location_id from pg_temp._stock_native_snap s) v
    cross join lateral (
      select 'n:inventory_items'::text as metric, (select count(*) from inventory_items t where t.location_id = v.location_id)::numeric as value
      union all select 'n:suppliers', (select count(*) from suppliers t where t.location_id = v.location_id)
      union all select 'n:supplier_products', (select count(*) from supplier_products t where t.location_id = v.location_id)
      union all select 'n:item_packaging_formats', (select count(*) from item_packaging_formats t where t.location_id = v.location_id)
      union all select 'n:inventory_item_conversions', (select count(*) from inventory_item_conversions t where t.location_id = v.location_id)
      union all select 'n:recipes', (select count(*) from recipes t where t.location_id = v.location_id)
      union all select 'n:recipe_lines', (select count(*) from recipe_lines t where t.location_id = v.location_id)
      union all select 'n:menu_item_recipes', (select count(*) from menu_item_recipes t where t.location_id = v.location_id)
      union all select 'n:par_levels', (select count(*) from par_levels t where t.location_id = v.location_id)
      union all select 'n:storage_areas', (select count(*) from storage_areas t where t.location_id = v.location_id)
      union all select 'n:inventory_item_areas', (select count(*) from inventory_item_areas t where t.location_id = v.location_id)
      union all select 'n:inventory_item_area_stock', (select count(*) from inventory_item_area_stock t where t.location_id = v.location_id)
      union all select 'n:stock_movements', (select count(*) from stock_movements t where t.location_id = v.location_id)
      union all select 'n:purchase_orders', (select count(*) from purchase_orders t where t.location_id = v.location_id)
      union all select 'n:po_lines', (select count(*) from po_lines t where t.location_id = v.location_id)
      union all select 'n:supplier_invoices', (select count(*) from supplier_invoices t where t.location_id = v.location_id)
      union all select 'n:supplier_invoice_lines', (select count(*) from supplier_invoice_lines t where t.location_id = v.location_id)
      union all select 'n:waste_events', (select count(*) from waste_events t where t.location_id = v.location_id)
      union all select 'n:item_cost_history', (select count(*) from item_cost_history t where t.location_id = v.location_id)
      union all select 'n:stock_counts', (select count(*) from stock_counts t where t.location_id = v.location_id)
      union all select 'n:stock_count_lines', (select count(*) from stock_count_lines t where t.location_id = v.location_id)
      union all select 'n:stock_count_areas', (select count(*) from stock_count_areas t where t.location_id = v.location_id)
      union all select 'n:production_batches', (select count(*) from production_batches t where t.location_id = v.location_id)
      union all select 'n:prep_schedule', (select count(*) from prep_schedule t where t.location_id = v.location_id)
      union all select 'n:stock_transfers', (select count(*) from stock_transfers t where t.location_id = v.location_id)
      union all select 'n:stock_transfer_lines', (select count(*) from stock_transfer_lines t where t.location_id = v.location_id)
      union all select 's:on_hand', (select sum(t.on_hand) from inventory_items t where t.location_id = v.location_id)
      union all select 's:current_cost', (select sum(t.current_cost) from inventory_items t where t.location_id = v.location_id)
      union all select 's:books', (select sum(t.on_hand * t.current_cost) from inventory_items t where t.location_id = v.location_id)
      union all select 's:mv_qty', (select sum(t.qty_base) from stock_movements t where t.location_id = v.location_id)
      union all select 's:mv_value', (select sum(t.value_delta) from stock_movements t where t.location_id = v.location_id)
      union all select 's:area_on_hand', (select sum(t.on_hand) from inventory_item_area_stock t where t.location_id = v.location_id)
      union all select 's:recipe_base_qty', (select sum(public.stock_qty_to_base(t.qty, t.unit, t.component_item_id))
                                                from recipe_lines t where t.location_id = v.location_id)
    ) f;

  -- the snapshot and the figures now must name the same 33 figures per venue
  select string_agg(format('%s %s', coalesce(l.name, x.location_id::text), x.metric), ', ' order by l.name, x.metric) into v_bad
    from (select n.location_id, n.metric from pg_temp._stock_native_now n
           where not exists (select 1 from pg_temp._stock_native_snap s where s.location_id = n.location_id and s.metric = n.metric)
          union all
          select s.location_id, s.metric from pg_temp._stock_native_snap s
           where not exists (select 1 from pg_temp._stock_native_now n where n.location_id = s.location_id and n.metric = s.metric)) x
    left join locations l on l.id = x.location_id;
  if v_bad is not null then
    raise exception 'The snapshot from the start of this file does not hold the same figures as the check (%). Ask Claude for a new file. Nothing was changed.',
      left(v_bad, 600);
  end if;

  -- a fill may only be recorded against a figure the snapshot holds
  select string_agg(format('%s %s', f.location_id, f.metric), ', ') into v_bad
    from pg_temp._stock_native_fills f
   where not exists (select 1 from pg_temp._stock_native_snap s where s.location_id = f.location_id and s.metric = f.metric);
  if v_bad is not null then
    raise exception 'A fill was recorded for a figure the snapshot does not hold (%). Nothing was changed.', left(v_bad, 600);
  end if;

  -- THE COMPARE
  select string_agg(format('%s %s was %s and is now %s (allowed change %s)', coalesce(l.name, s.location_id::text), s.metric,
                           s.value, n.value, coalesce(f.n, 0)), '; ' order by l.name, s.metric)
    into v_bad
    from pg_temp._stock_native_snap s
    join pg_temp._stock_native_now n on n.location_id = s.location_id and n.metric = s.metric
    left join pg_temp._stock_native_fills f on f.location_id = s.location_id and f.metric = s.metric
    left join locations l on l.id = s.location_id
   where n.value is distinct from coalesce(s.value, 0) + coalesce(f.n, 0);
  if v_bad is not null then
    raise exception 'Stopped and nothing was changed: a stock number moved while the company records were made: %.', left(v_bad, 1500);
  end if;
end
$compare$;

-- ============================================================================
-- VISIBLE CHECK (the SQL editor shows this last result), one row per venue that holds stock.
-- Expected on Ops (20 Oct 2026):
--   delta {} everywhere except Location 2 {"n:item_packaging_formats": 55, "n:inventory_item_conversions": 7};
--   packs_filled 55 and bridges_filled 7 at Location 2 (0 elsewhere); site_rows_without_company_ref 0;
--   company_rows_without_sites 0; sync_planned_writes 0; recipe_planned_writes 0;
--   items_shared 26, suppliers_shared 4, supplier_items_shared 25 on the demo company rows (0 at
--   Birmingham); recipe_pairs {"merged": 1, "differ": 5, "link_only": 2} on the demo company rows
--   (null elsewhere); multi_since set for the demo company; policies_swapped 51;
--   policies_swapped_devices 14; internals_open_to_api false; approve_open_to_logins true (until 0b);
--   profile_guard_closed true when the optional block in part 1 ran; cron_jobs both true;
--   nightly_key_present true.
-- ============================================================================
with venues as (
  select distinct s.location_id from pg_temp._stock_native_snap s
), fig as (
  select n.location_id, jsonb_object_agg(n.metric, n.value) as figures
    from pg_temp._stock_native_now n group by n.location_id
), dlt as (
  select s.location_id,
         jsonb_object_agg(s.metric, n.value - coalesce(s.value, 0)) filter (where n.value is distinct from coalesce(s.value, 0)) as delta
    from pg_temp._stock_native_snap s
    left join pg_temp._stock_native_now n on n.location_id = s.location_id and n.metric = s.metric
   group by s.location_id
), stock_tables as (
  select unnest(array['inventory_items', 'supplier_products', 'item_packaging_formats', 'inventory_item_conversions', 'recipes',
                      'recipe_lines', 'menu_item_recipes', 'prep_schedule', 'suppliers', 'par_levels', 'purchase_orders', 'po_lines',
                      'supplier_invoices', 'supplier_invoice_lines', 'item_cost_history', 'stock_counts', 'stock_count_lines',
                      'stock_count_areas', 'storage_areas', 'inventory_item_areas', 'inventory_item_area_stock', 'stock_movements',
                      'stock_site_settings', 'stock_transfers', 'stock_transfer_lines', 'production_batches', 'waste_events']) as tablename
), pol as (
  select coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') as expr
    from pg_policies p join stock_tables t on t.tablename = p.tablename
   where p.schemaname = 'public'
), new_fns as (
  select p.oid, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname ~ '^stock_co__'
          or p.proname in ('user_profiles_stock_control_guard', 'set_stock_control', 'stock_level', 'stock_reach_locations',
                           'stock_reach_orgs', 'stock_save_queue_run', '_stock_revalue', 'stock_save_item', 'stock_archive_item',
                           'stock_save_item_site', 'stock_save_pack', 'stock_archive_pack', 'stock_set_pack_default',
                           'stock_save_bridge', 'stock_archive_bridge', 'stock_save_supplier', 'stock_archive_supplier',
                           'stock_save_supplier_site', 'stock_save_supplier_item', 'stock_save_supplier_item_site',
                           'stock_archive_supplier_item', 'stock_save_recipe', 'stock_archive_recipe', 'stock_link_menu_item',
                           'stock_recost_made_items', 'stock_save_cost_rule', 'stock_site_scope', 'stock_item_detail',
                           'stock_changes_page', 'venue_clock_sync', 'stock_nightly_cron_ok', 'stock_nightly_send',
                           'stock_nightly_upkeep', 'stock_day_sums_rebuild', 'sales_day_sums_rebuild', 'stock_day_sums_check',
                           'sales_day_sums_check', 'stock_opening_costs', 'stock_approve_count_pin'))
), new_tables as (
  select c.oid, c.relname::text as relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname in ('stock_native_backup', 'stock_co_settings', 'stock_co_site_settings', 'stock_co_site_groups',
                       'stock_co_items', 'stock_co_item_sites', 'stock_co_packs', 'stock_co_pack_sites', 'stock_co_bridges',
                       'stock_co_bridge_sites', 'stock_co_suppliers', 'stock_co_supplier_sites', 'stock_co_supplier_items',
                       'stock_co_supplier_item_sites', 'stock_co_recipes', 'stock_co_recipe_lines', 'stock_co_recipe_sites',
                       'stock_change_log', 'stock_save_queue', 'venue_clock', 'stock_day_sums', 'stock_day_sums_repair',
                       'sales_day_sums', 'sales_day_sums_queue', 'stock_periods', 'stock_period_snapshots', 'stock_pin_tries')
), globals as (
  select
    (select count(*) from pol where strpos(pol.expr, 'stock_reach_locations()') > 0
                               and strpos(pol.expr, 'accessible_location_uuids()') = 0
                               and strpos(pol.expr, 'user_accessible_locations()') = 0) as policies_swapped,
    (select count(*) from pol where strpos(pol.expr, 'stock_reach_locations()') > 0
                               and strpos(pol.expr, 'accessible_location_uuids()') > 0
                               and strpos(pol.expr, 'user_accessible_locations()') = 0) as policies_swapped_devices,
    (exists (select 1 from new_fns f cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as r(role_name)
              where ((f.proname ~ '^stock_co__' and f.proname <> 'stock_co__writer_ok')
                     or f.proname in ('user_profiles_stock_control_guard', '_stock_revalue', 'stock_save_queue_run', 'stock_nightly_send'))
                and has_function_privilege(r.role_name, f.oid, 'execute'))
     or exists (select 1 from new_fns f
                 where f.proname <> 'stock_reach_locations' and has_function_privilege('anon', f.oid, 'execute'))
     or exists (select 1 from new_fns f
                 where f.proname = 'stock_level' and has_function_privilege('authenticated', f.oid, 'execute'))
     -- the new tables (parts 1, 2 and 4): no API role writes any of them, anon reads none, the backup and
     -- the PIN tries are owner only, the venue clock and the day totals are for the service role only
     or exists (select 1 from new_tables t cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role_name)
                 where has_table_privilege(r.role_name, t.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
     or exists (select 1 from new_tables t where has_table_privilege('anon', t.oid, 'SELECT'))
     or exists (select 1 from new_tables t cross join unnest(array['authenticated', 'service_role']) as r(role_name)
                 where t.relname in ('stock_native_backup', 'stock_pin_tries') and has_table_privilege(r.role_name, t.oid, 'SELECT'))
     or exists (select 1 from new_tables t
                 where t.relname in ('venue_clock', 'stock_day_sums', 'stock_day_sums_repair', 'sales_day_sums', 'sales_day_sums_queue')
                   and has_table_privilege('authenticated', t.oid, 'SELECT'))) as internals_open_to_api,
    coalesce(has_function_privilege('authenticated', to_regprocedure('public.approve_stock_count(uuid,text,text,jsonb,boolean)'), 'execute'),
             false) as approve_open_to_logins,
    (select strpos(p.prosrc, 'user_accessible_orgs') = 0 from pg_proc p
      where p.oid = to_regprocedure('public.user_profiles_fence_guard()')) as profile_guard_closed,
    jsonb_build_object('stock-save-queue', exists (select 1 from cron.job j where j.jobname = 'stock-save-queue'),
                       'stock-nightly', exists (select 1 from cron.job j where j.jobname = 'stock-nightly')) as cron_jobs,
    exists (select 1 from vault.secrets s where s.name = 'stock_nightly_cron_key') as nightly_key_present
)
select
  l.name as venue,
  l.id as location_id,
  l.org_id,
  fig.figures,
  coalesce(dlt.delta, '{}'::jsonb) as delta,
  coalesce((select f.n from pg_temp._stock_native_fills f where f.location_id = l.id and f.metric = 'n:item_packaging_formats'), 0) as packs_filled,
  coalesce((select f.n from pg_temp._stock_native_fills f where f.location_id = l.id and f.metric = 'n:inventory_item_conversions'), 0) as bridges_filled,
  (select count(*) from inventory_items t where t.location_id = l.id and t.company_ref is null)
    + (select count(*) from suppliers t where t.location_id = l.id and t.company_ref is null)
    + (select count(*) from supplier_products t where t.location_id = l.id and t.company_ref is null)
    + (select count(*) from item_packaging_formats t where t.location_id = l.id and t.company_ref is null)
    + (select count(*) from inventory_item_conversions t where t.location_id = l.id and t.company_ref is null)
    + (select count(*) from recipes t where t.location_id = l.id and t.company_ref is null) as site_rows_without_company_ref,
  (select count(*) from stock_co_items c where c.org_id = l.org_id
      and not exists (select 1 from stock_co_item_sites s where s.item_id = c.id))
    + (select count(*) from stock_co_suppliers c where c.org_id = l.org_id
      and not exists (select 1 from stock_co_supplier_sites s where s.supplier_id = c.id))
    + (select count(*) from stock_co_supplier_items c where c.org_id = l.org_id
      and not exists (select 1 from stock_co_supplier_item_sites s where s.supplier_item_id = c.id))
    + (select count(*) from stock_co_packs c where c.org_id = l.org_id
      and not exists (select 1 from stock_co_pack_sites s where s.pack_id = c.id))
    + (select count(*) from stock_co_bridges c where c.org_id = l.org_id
      and not exists (select 1 from stock_co_bridge_sites s where s.bridge_id = c.id))
    + (select count(*) from stock_co_recipes c where c.org_id = l.org_id
      and not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = c.id)) as company_rows_without_sites,
  (public.stock_co__sync_site(l.id, null, null, false, false) ->> 'writes')::integer as sync_planned_writes,
  (public.stock_co__sync_recipes(l.id, null, false, false) ->> 'writes')::integer as recipe_planned_writes,
  (select count(*) from stock_co_items c where c.org_id = l.org_id
      and (select count(*) from stock_co_item_sites s where s.item_id = c.id) >= 2) as items_shared,
  (select count(*) from stock_co_suppliers c where c.org_id = l.org_id
      and (select count(*) from stock_co_supplier_sites s where s.supplier_id = c.id) >= 2) as suppliers_shared,
  (select count(*) from stock_co_supplier_items c where c.org_id = l.org_id
      and (select count(*) from stock_co_supplier_item_sites s where s.supplier_item_id = c.id) >= 2) as supplier_items_shared,
  (select r.result -> 'recipe_pairs' from pg_temp._stock_native_runs r where r.org_id = l.org_id and r.step = 'link') as recipe_pairs,
  (select s.multi_since from stock_co_settings s where s.org_id = l.org_id) as multi_since,
  g.policies_swapped,
  g.policies_swapped_devices,
  g.internals_open_to_api,
  g.approve_open_to_logins,
  g.profile_guard_closed,
  g.cron_jobs,
  g.nightly_key_present
from venues v
join locations l on l.id = v.location_id
left join fig on fig.location_id = l.id
left join dlt on dlt.location_id = l.id
cross join globals g
order by l.org_id, l.name, l.id;
