-- 20260921_OPS_customers_fence.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Run AFTER the release that carries the app changes, outside service.     #
-- #  Database fence, stage 2, part 1: the customer records.                   #
-- ############################################################################
--
-- WHAT IS WRONG TODAY (found live, 20 Sep 2026, with nothing but the public app key)
--   customers, customer_locations and customer_orders each carry a policy that ends
--   "... or auth.uid() is null or the caller is anonymous". Every kiosk, online, QR and
--   catering visitor is an anonymous session, and the public key is in the page, so
--   anyone can read every customer of every venue: 18 people, 15 with phone numbers.
--   This is finding 1 of the 4 August audit, and stage 1 did not cover it.
--
-- WHAT THIS FILE DOES
--   1. Two server functions, so the customer pages never need the table:
--        customer_by_phone        a till, kiosk or Back Office of THAT venue looks one up
--        attribute_public_order   an online or QR order attaches itself to its customer,
--                                 proved by the same tracking key the order tracker uses
--   2. Replaces the three open policies with: staff of the venue, a paired device of the
--      venue, or a super admin. The service role (our edge functions) is unaffected.
--
-- ORDER
--   The app release goes FIRST (it calls the two functions and falls back to today's
--   path while they do not exist). Then this file. A page still on the old build keeps
--   working for reads it is allowed to make, and its direct writes stop: those are the
--   writes this file is closing.
--
-- RULES OF THE FILE
--   bare idempotent statements, no begin/commit (the SQL editor runs the paste as one
--   transaction), drop policy if exists before create, create or replace for functions,
--   every grant named (schema public grants EXECUTE on new functions to anon and
--   authenticated by default, so "revoke from public" is not enough), a self test that
--   aborts the whole file before anything changes, verification selects at the bottom,
--   and a roll back block in comments.

-- ============================================================================
-- 0. Guards
-- ============================================================================

do $guard$
begin
  if current_setting('server_version_num')::int < 140000 then
    raise exception 'Postgres 14 or newer is needed. Nothing was changed.';
  end if;
  if to_regclass('public.customers') is null
     or to_regclass('public.customer_locations') is null
     or to_regclass('public.customer_orders') is null then
    raise exception 'This is not the Ops database (customers tables are missing). Nothing was changed.';
  end if;
  if to_regprocedure('public.pos_can_access(text)') is null then
    raise exception 'Stage 1 file a1 has not run (pos_can_access is missing). Run it first. Nothing was changed.';
  end if;
  if to_regprocedure('public._order_track_ok(text, text, text)') is null then
    raise exception 'Stage 1 file a2 has not run (_order_track_ok is missing). Run it first. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- ============================================================================
-- 1. Who may see a venue's customers
-- ============================================================================

-- A customer belongs to an ORG, not a venue, so the test is: does this caller reach any
-- venue of that org, either as a login linked to it or as a device bound to it? Both are
-- already answered by pos_can_access, which stage 1 made trustworthy.
create or replace function public.customer_org_visible(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(p_org_id is not null and (
           public.is_super_admin()
           or exists (select 1
                        from public.locations l
                       where l.org_id = p_org_id
                         and public.pos_can_access(l.id::text))
         ), false)
$fn$;
revoke all on function public.customer_org_visible(uuid) from public, anon, authenticated;
grant execute on function public.customer_org_visible(uuid) to authenticated, service_role;

-- ============================================================================
-- 2. The server function a till or Back Office calls instead of reading the table
-- ============================================================================

create or replace function public.customer_by_phone(p_location_id text, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_org    uuid;
  v_phone  text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_row    public.customers%rowtype;
begin
  if coalesce(p_location_id, '') = '' or length(v_phone) < 7 then
    return null;
  end if;
  -- the caller must reach THIS venue: a login linked to it, or a device bound to it
  if not public.pos_can_access(p_location_id) then
    return null;
  end if;
  select l.org_id into v_org from public.locations l where l.id::text = p_location_id;
  if v_org is null then
    return null;
  end if;
  select * into v_row
    from public.customers c
   where c.org_id = v_org
     and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') = v_phone
     and c.deleted_at is null
   limit 1;
  if v_row.id is null then
    return null;
  end if;
  -- only what the till screen shows: never the notes, the tags or the stored payment method
  return jsonb_build_object(
    'id', v_row.id,
    'name', coalesce(v_row.name, ''),
    'email', v_row.email,
    'marketing_opt_in', coalesce(v_row.marketing_opt_in, false)
  );
end
$fn$;
revoke all on function public.customer_by_phone(text, text) from public, anon, authenticated;
grant execute on function public.customer_by_phone(text, text) to authenticated, service_role;

-- ============================================================================
-- 3. The server function an online or QR order calls to attach itself
--
-- Proof is the tracking key the order already holds (the token place_public_order
-- returned, its payment reference, or the last 4 digits of the phone on the order, which
-- _order_track_ok rate limits). No proof, no write: the page cannot invent a customer.
-- ============================================================================

create or replace function public.attribute_public_order(
  p_location_id text,
  p_ref         text,
  p_key         text,
  p_customer    jsonb,
  p_order       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_org       uuid;
  v_phone     text := regexp_replace(coalesce(p_customer ->> 'phone', ''), '\D', '', 'g');
  v_name      text := btrim(coalesce(p_customer ->> 'name', ''));
  v_email     text := nullif(btrim(coalesce(p_customer ->> 'email', '')), '');
  v_opt_in    boolean := coalesce((p_customer ->> 'marketing_opt_in')::boolean, false);
  v_cust      uuid;
  v_created   boolean := false;
  v_existing  public.customers%rowtype;
  v_total     numeric := coalesce((p_order ->> 'total')::numeric, 0);
  v_items     jsonb := case when jsonb_typeof(p_order -> 'items') = 'array' then p_order -> 'items' else '[]'::jsonb end;
  v_channel   text := coalesce(nullif(btrim(coalesce(p_order ->> 'channel', '')), ''), 'online');
  v_loc_uuid  uuid;
  v_visits    int;
  v_revenue   numeric;
begin
  if coalesce(p_location_id, '') = '' or coalesce(p_ref, '') = '' or length(v_phone) < 7 then
    return jsonb_build_object('ok', false, 'reason', 'not_enough');
  end if;
  -- the caller must hold this order's key, or be the venue itself
  if not (public._order_track_ok(p_location_id, p_ref, p_key) or public.pos_can_access(p_location_id)) then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;
  -- the order must really exist at this venue
  if not exists (select 1 from public.order_queue q
                  where q.location_id = p_location_id and q.ref = p_ref) then
    return jsonb_build_object('ok', false, 'reason', 'no_order');
  end if;
  select l.org_id, l.id into v_org, v_loc_uuid from public.locations l where l.id::text = p_location_id;
  if v_org is null then
    return jsonb_build_object('ok', false, 'reason', 'no_venue');
  end if;

  -- 1. the customer: fill blanks only, never overwrite what the venue curated
  select * into v_existing
    from public.customers c
   where c.org_id = v_org
     and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') = v_phone
     and c.deleted_at is null
   limit 1;

  if v_existing.id is not null then
    v_cust := v_existing.id;
    update public.customers
       set name             = case when coalesce(btrim(name), '') = '' and v_name <> '' then v_name else name end,
           email            = coalesce(email, v_email),
           marketing_opt_in = case when coalesce(marketing_opt_in, false) then true else v_opt_in end,
           updated_at       = now()
     where id = v_cust;
  else
    -- customers.name is NOT NULL with no default (17 Sep 2026): an empty name, never null
    insert into public.customers (org_id, phone, phone_raw, name, email, marketing_opt_in, source)
    values (v_org, v_phone, coalesce(p_customer ->> 'phone', v_phone), v_name, v_email, v_opt_in,
            coalesce(nullif(btrim(coalesce(p_customer ->> 'source', '')), ''), v_channel))
    returning id into v_cust;
    v_created := true;
  end if;

  if v_cust is null then
    return jsonb_build_object('ok', false, 'reason', 'no_customer');
  end if;

  -- 2. the venue stats
  select cl.visit_count, cl.lifetime_revenue into v_visits, v_revenue
    from public.customer_locations cl
   where cl.customer_id = v_cust and cl.location_id = v_loc_uuid;

  if found then
    update public.customer_locations
       set visit_count      = coalesce(v_visits, 0) + 1,
           lifetime_revenue = coalesce(v_revenue, 0) + v_total,
           last_visit_at    = now()
     where customer_id = v_cust and location_id = v_loc_uuid;
  else
    insert into public.customer_locations (customer_id, location_id, first_visit_at, last_visit_at, visit_count, lifetime_revenue)
    values (v_cust, v_loc_uuid, now(), now(), 1, v_total)
    on conflict do nothing;
  end if;

  -- 3. the order row, once per ref
  if not exists (select 1 from public.customer_orders co
                  where co.customer_id = v_cust
                    and co.location_id = v_loc_uuid
                    and co.closed_check_id = p_ref) then
    insert into public.customer_orders (customer_id, location_id, closed_check_id, ordered_at, total, channel, item_summary)
    values (v_cust, v_loc_uuid, p_ref, now(), v_total, v_channel,
            (select coalesce(jsonb_agg(jsonb_build_object('name', i ->> 'name', 'qty', i -> 'qty', 'price', i -> 'price')), '[]'::jsonb)
               from jsonb_array_elements(v_items) i));
  end if;

  return jsonb_build_object('ok', true, 'customer_id', v_cust, 'created', v_created);
end
$fn$;
revoke all on function public.attribute_public_order(text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.attribute_public_order(text, text, text, jsonb, jsonb) to anon, authenticated, service_role;

-- ============================================================================
-- 4. The fence itself
-- ============================================================================

drop policy if exists customers_all on public.customers;
drop policy if exists customer_locations_all on public.customer_locations;
drop policy if exists customer_orders_all on public.customer_orders;

-- and the new names, so the file can be run twice (found by the offline test, 20 Sep)
drop policy if exists customers_venue on public.customers;
drop policy if exists customer_locations_venue on public.customer_locations;
drop policy if exists customer_orders_venue on public.customer_orders;

alter table public.customers enable row level security;
alter table public.customer_locations enable row level security;
alter table public.customer_orders enable row level security;

create policy customers_venue on public.customers
  for all to authenticated
  using (public.customer_org_visible(org_id))
  with check (public.customer_org_visible(org_id));

create policy customer_locations_venue on public.customer_locations
  for all to authenticated
  using (public.pos_can_access(location_id::text))
  with check (public.pos_can_access(location_id::text));

create policy customer_orders_venue on public.customer_orders
  for all to authenticated
  using (public.pos_can_access(location_id::text))
  with check (public.pos_can_access(location_id::text));

-- the raw public key (role anon, no session) has no business here at all
revoke all on table public.customers from anon;
revoke all on table public.customer_locations from anon;
revoke all on table public.customer_orders from anon;

-- ============================================================================
-- 5. Self test (aborts the WHOLE file, changing nothing, if anything is wrong)
-- ============================================================================

do $test$
begin
  if has_table_privilege('anon', 'public.customers', 'select')
     or has_table_privilege('anon', 'public.customer_locations', 'select')
     or has_table_privilege('anon', 'public.customer_orders', 'select') then
    raise exception 'Self test: the public key can still reach a customer table. Nothing was changed.';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public'
                and tablename in ('customers', 'customer_locations', 'customer_orders')
                and (qual like '%is_anonymous%' or qual like '%auth.uid() IS NULL%'
                     or coalesce(with_check, '') like '%is_anonymous%')) then
    raise exception 'Self test: an anonymous escape hatch is still on a customer table. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.customer_by_phone(text, text)', 'execute')
     or has_function_privilege('anon', 'public.customer_org_visible(uuid)', 'execute') then
    raise exception 'Self test: a customer function is callable by the public key. Nothing was changed.';
  end if;
  if not has_function_privilege('authenticated', 'public.customer_by_phone(text, text)', 'execute')
     or not has_function_privilege('anon', 'public.attribute_public_order(text, text, text, jsonb, jsonb)', 'execute') then
    raise exception 'Self test: a function the app needs was revoked. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customers' and policyname = 'customers_venue') then
    raise exception 'Self test: the customers fence is missing. Nothing was changed.';
  end if;
end
$test$;

-- ============================================================================
-- 6. Verification (run these after; each says what you should see)
-- ============================================================================

-- One row. open_policies must be 0, fns must be 3, anon_reads must be false.
select
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('customers','customer_locations','customer_orders')
      and (qual like '%is_anonymous%' or qual like '%auth.uid() IS NULL%')) as open_policies,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('customer_org_visible','customer_by_phone','attribute_public_order')) as fns,
  has_table_privilege('anon', 'public.customers', 'select') as anon_reads_customers,
  (select count(*) from public.customers where deleted_at is null) as customers_on_file;

-- ============================================================================
-- ROLL BACK (paste the whole block, take off the leading "-- " with one Cmd+/)
--
-- -- This puts back exactly the rules of 20 Sep 2026, including the anonymous read.
-- -- Do it only if a customer page or a till cannot see a customer it needs.
--
-- drop policy if exists customers_venue on public.customers;
-- drop policy if exists customer_locations_venue on public.customer_locations;
-- drop policy if exists customer_orders_venue on public.customer_orders;
--
-- grant select, insert, update, delete on table public.customers to anon;
-- grant select, insert, update, delete on table public.customer_locations to anon;
-- grant select, insert, update, delete on table public.customer_orders to anon;
--
-- create policy customers_all on public.customers
--   for all to public
--   using ((org_id in ( select l.org_id from locations l
--                         join user_locations ul on ul.location_id = l.id
--                        where ul.user_id = auth.uid()))
--          or (auth.uid() is null)
--          or (((auth.jwt() ->> 'is_anonymous'::text))::boolean = true));
--
-- create policy customer_locations_all on public.customer_locations
--   for all to public
--   using ((location_id in ( select user_locations.location_id from user_locations
--                             where user_locations.user_id = auth.uid()))
--          or (auth.uid() is null)
--          or (((auth.jwt() ->> 'is_anonymous'::text))::boolean = true))
--   with check ((location_id in ( select user_locations.location_id from user_locations
--                                  where user_locations.user_id = auth.uid()))
--          or (auth.uid() is null));
--
-- create policy customer_orders_all on public.customer_orders
--   for all to public
--   using ((location_id in ( select user_locations.location_id from user_locations
--                             where user_locations.user_id = auth.uid()))
--          or (auth.uid() is null)
--          or (((auth.jwt() ->> 'is_anonymous'::text))::boolean = true))
--   with check ((location_id in ( select user_locations.location_id from user_locations
--                                  where user_locations.user_id = auth.uid()))
--          or (auth.uid() is null));
--
-- -- The two server functions can stay: nothing breaks if they are never called.
-- ============================================================================
