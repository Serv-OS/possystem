-- DRAFT, DO NOT RUN (8 Sep 2026). The adversarial pass found 12 breaks and 25 gaps that are NOT applied yet;
-- they are listed at the end of docs/PRE_LIVE_SECURITY_MIGRATIONS.md. A fix pass must land before this file is run.

-- 20260907b_ops_rls_1_fences_and_rpcs.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Run this file FIRST. It needs NO app change and can run today.           #
-- #  The guard at the top aborts if you paste it into the Platform project.   #
-- ############################################################################
--
-- WHAT THIS FILE CLOSES (PRE_STAGE_READINESS.md, 4 Aug 2026 audit)
--   Finding 1  customers / customer_locations / customer_orders carry an
--              is_anonymous = true escape hatch, so any anonymous session (kiosk,
--              online, QR, menu board, review card, wifi portal) can read or
--              delete every venue's customer PII. Closed here with RESTRICTIVE
--              fences that only let a real Back Office user, a paired device at
--              the customer's venue, or a super admin through.
--   Finding 3  "allow all" policies on activity_events, kds_tickets,
--              table_reservations, eighty_six, item_variants, modifier_options,
--              stamp_transactions, organisations, locations and the WRITE half of
--              device_profiles are replaced with tenant fences. order_queue,
--              active_sessions and the read half of device_profiles get their
--              replacement policies and RPCs created here but keep "allow all"
--              until the app moves to the RPCs (file 3 drops them).
--   Extra      the catalog write policies that were fenced only on auth.role()
--              (menus, menu_categories, menu_category_links, stock_levels,
--              config_pushes, discount_rules, tax_rates, tax_profiles,
--              tax_profile_lines), the WITH CHECK (true) closed_checks insert,
--              decrement_stock / restore_stock without a search_path pin, and
--              the TRUNCATE / REFERENCES / TRIGGER grants held by anon and
--              authenticated on every table.
--
-- WHAT IT DOES NOT TOUCH (deliberately)
--   devices and claim_device        file 2 (20260907b_ops_rls_2_pairing.sql)
--   order_queue / active_sessions   "allow all" stays until file 3
--   customers_all trio              stays (now fenced by the restrictive
--                                   policies) until file 3 drops it
--   user_profiles read policy       only a restrictive no-anon-read-others fence
--                                   is added; the full 20260721c rework is a
--                                   separate step, now unblocked by A1 below
--
-- THE ONE FACT BEHIND EVERY PREDICATE
--   A signInAnonymously() session (kiosk, online, QR, catering, menu board,
--   customer display, and every paired POS / KDS / MPOS device) arrives as the
--   `authenticated` DB role with is_anonymous = true. A raw anon key with no
--   session arrives as `anon` with auth.uid() NULL. Real Back Office users are
--   `authenticated` with is_anonymous = false. Three identities, one role name.
--   Device class sessions prove their venue through devices.device_uid
--   (pos_can_access). Public class sessions cannot prove anything, so their
--   access is either a narrow INSERT carve-out or a SECURITY DEFINER RPC keyed
--   by a secret the customer already holds.
--
-- RULES OF THE FILE
--   * bare idempotent statements, no begin / commit (the SQL editor chokes on it)
--   * drop policy if exists before every create policy
--   * create or replace for every helper that live policies depend on
--   * nothing here assumes 20260721c objects exist (they do not, live)
--   * no statement here depends on 20260429_tenant_rls or any reverted file
--   * verification selects at the bottom, read only, paste after applying
--
-- Written against 000_baseline_ops.sql (live catalog, 5 Aug 2026) plus every
-- Ops migration dated after it, and a grep of every call site in src/ on
-- 7 Sep 2026. Line references in comments point at src/ as of that date.


-- ============================================================================
-- 0. Guards
-- ============================================================================

-- Wrong database guard. Ops has user_locations and no billing_state; Platform is
-- the other way round (same test 20260805c and 20260806_PLATFORM use).
do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS DB (tbetcegmszzotrwdtqhi). This is not it. Aborting.';
  end if;
end
$guard$;

-- Everything below assumes a client cannot pick its own role at signup. If the
-- metadata passthrough ever comes back, every fence here is decorative.
do $precheck$
declare
  def text;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'handle_new_user';
  if def is null then
    raise exception 'handle_new_user() not found. Aborting.';
  end if;
  if def like '%raw_user_meta_data->>''role''%' or def like '%raw_user_meta_data ->> ''role''%' then
    raise exception 'handle_new_user() reads raw_user_meta_data->>role again. Apply 20260721d first, then re-run.';
  end if;
end
$precheck$;


-- ============================================================================
-- A. Helpers
-- ============================================================================

-- A1. user_accessible_locations() becomes SECURITY DEFINER with a pinned
-- search_path. Body is byte for byte the live one. 136 policies on 63 tables
-- call it, so it is replaced in place, never dropped. Today it reads
-- user_locations and user_profiles as the caller; both queries are already
-- filtered on auth.uid(), so the rows it returns do not change. What changes is
-- that it keeps working when user_profiles / user_locations are locked down
-- later (readiness medium 4, Gate 0 item 2).
create or replace function public.user_accessible_locations()
returns setof text
language sql
stable
security definer
set search_path = public
as $fn$
  select location_id::text from user_locations where user_id = auth.uid()
  union
  select location_id::text from user_profiles where id = auth.uid() and location_id is not null;
$fn$;

-- A2. Same treatment for its org twin (reads locations).
create or replace function public.user_accessible_orgs()
returns setof text
language sql
stable
security definer
set search_path = public
as $fn$
  select distinct l.org_id::text
    from locations l
   where l.id::text in (select public.user_accessible_locations());
$fn$;

-- A3. Every location the caller may act for, as text keys: Back Office access
-- plus a claimed POS family device plus a claimed ops device. This is
-- pos_can_access() turned inside out so a policy can say
--   location_id in (select pos_accessible_location_keys())
-- and Postgres evaluates the set ONCE per statement instead of calling a
-- plpgsql function once per row. Same truth table as pos_can_access.
create or replace function public.pos_accessible_location_keys()
returns setof text
language sql
stable
security definer
set search_path = public
as $fn$
  select public.user_accessible_locations()
  union
  select d.location_id::text
    from public.devices d
   where d.device_uid = auth.uid()
     and d.status in ('active', 'online')
     and d.location_id is not null
  union
  select o.location_id::text
    from public.ops_devices o
   where o.device_uid = auth.uid()
     and o.active
     and o.location_id is not null;
$fn$;

-- A4. Same set as uuids, for the tables whose location_id is uuid.
create or replace function public.pos_accessible_location_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select k::uuid
    from public.pos_accessible_location_keys() as k
   where k ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
$fn$;

-- A5. Orgs reachable through those locations. customers is org scoped.
create or replace function public.pos_accessible_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select distinct l.org_id
    from public.locations l
   where l.id in (select public.pos_accessible_location_ids())
     and l.org_id is not null;
$fn$;

-- A6. The caller's own org, read as definer so a policy on user_profiles or
-- organisations can use it without recursing into user_profiles' own policies.
-- NULL for anonymous sessions and for the raw anon key.
create or replace function public.caller_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select up.org_id
    from public.user_profiles up
   where up.id = auth.uid()
     and not public.is_anon_session();
$fn$;

-- A7. The public storefront gate. Ops locations has no "publicly orderable"
-- flag (online_enabled / qr_enabled live on the Platform DB, which ops RLS
-- cannot see), so status = 'active' is the gate. Two overloads because
-- location_id is text on order_queue / closed_checks / eighty_six and uuid on
-- activity_events / active_sessions.
create or replace function public.is_active_public_location(p_loc text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from public.locations l where l.id::text = p_loc and l.status = 'active');
$fn$;

create or replace function public.is_active_public_location(p_loc uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from public.locations l where l.id = p_loc and l.status = 'active');
$fn$;

revoke all on function public.pos_accessible_location_keys() from public;
revoke all on function public.pos_accessible_location_ids()  from public;
revoke all on function public.pos_accessible_org_ids()       from public;
revoke all on function public.caller_org_id()                from public;
revoke all on function public.is_active_public_location(text) from public;
revoke all on function public.is_active_public_location(uuid) from public;
grant execute on function public.pos_accessible_location_keys() to anon, authenticated, service_role;
grant execute on function public.pos_accessible_location_ids()  to anon, authenticated, service_role;
grant execute on function public.pos_accessible_org_ids()       to anon, authenticated, service_role;
grant execute on function public.caller_org_id()                to anon, authenticated, service_role;
grant execute on function public.is_active_public_location(text) to anon, authenticated, service_role;
grant execute on function public.is_active_public_location(uuid) to anon, authenticated, service_role;

-- A8. decrement_stock / restore_stock: SECURITY DEFINER with no search_path pin
-- and EXECUTE granted to public (readiness item 6). Any key could zero any
-- venue's stock and auto 86 its menu. Bodies unchanged apart from the pin and
-- a caller fence. The online storefront (src/lib/db.js:1803 from
-- OnlineCheckout.jsx) calls decrement_stock as an anonymous session with no
-- device, so that path keeps a narrow arm: the item must exist, unarchived, at
-- an active location, and the quantity is capped. File 3 removes that arm once
-- OnlineCheckout stops calling it (stock-deplete already runs server side).
create or replace function public.decrement_stock(p_location_id text, p_item_id text, p_qty integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_new_remaining int;
  v_par int;
begin
  if p_qty is null or p_qty < 1 or p_qty > 50 then
    raise exception 'decrement_stock: p_qty must be between 1 and 50';
  end if;
  if not (
       public.pos_can_access(p_location_id)
       or public.is_super_admin()
       or (
         public.is_anon_session()
         and public.is_active_public_location(p_location_id)
         and exists (select 1 from public.menu_items mi
                      where mi.location_id = p_location_id
                        and mi.id = p_item_id
                        and coalesce(mi.archived, false) = false)
       )
  ) then
    raise exception 'decrement_stock: not allowed for this location';
  end if;

  update public.stock_levels
     set remaining = greatest(0, remaining - p_qty),
         updated_at = now()
   where location_id = p_location_id and item_id = p_item_id
  returning remaining, par into v_new_remaining, v_par;

  if not found then
    return jsonb_build_object('tracked', false);
  end if;

  if v_new_remaining <= 0 then
    insert into public.eighty_six (location_id, item_id)
    values (p_location_id, p_item_id)
    on conflict (location_id, item_id) do nothing;
  end if;

  return jsonb_build_object('tracked', true, 'remaining', v_new_remaining, 'par', v_par);
end;
$fn$;

create or replace function public.restore_stock(p_location_id text, p_item_id text, p_qty integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_new_remaining int;
  v_par int;
begin
  if p_qty is null or p_qty < 1 or p_qty > 500 then
    raise exception 'restore_stock: p_qty must be between 1 and 500';
  end if;
  if not (public.pos_can_access(p_location_id) or public.is_super_admin()) then
    raise exception 'restore_stock: not allowed for this location';
  end if;

  update public.stock_levels
     set remaining = least(par, remaining + p_qty),
         updated_at = now()
   where location_id = p_location_id and item_id = p_item_id
  returning remaining, par into v_new_remaining, v_par;

  if not found then
    return jsonb_build_object('tracked', false);
  end if;

  return jsonb_build_object('tracked', true, 'remaining', v_new_remaining, 'par', v_par);
end;
$fn$;

-- public must be named explicitly: a created function carries a default EXECUTE
-- grant to PUBLIC (the 20260805c B2 trap). The raw anon key loses both; every
-- real caller holds a session (authenticated).
revoke execute on function public.decrement_stock(text, text, integer) from public, anon;
revoke execute on function public.restore_stock(text, text, integer)   from public, anon;
grant  execute on function public.decrement_stock(text, text, integer) to authenticated, service_role;
grant  execute on function public.restore_stock(text, text, integer)   to authenticated, service_role;

-- A9. upsert_customer_visit is plain SECURITY INVOKER, has zero callers in src/
-- (store/index.js dropped it in v5.5.7) and EXECUTE is granted to everyone.
-- Nothing to keep.
revoke execute on function public.upsert_customer_visit(uuid, uuid, numeric, timestamp with time zone) from public, anon, authenticated;


-- ============================================================================
-- B. Finding 1: customers / customer_locations / customer_orders
-- ============================================================================
-- Live policies (customers_all, customer_locations_all, customer_orders_all):
--   USING      tenant OR auth.uid() IS NULL OR is_anonymous = true
--   WITH CHECK tenant OR auth.uid() IS NULL
-- So an anonymous session can SELECT and DELETE every row of every org, while
-- its INSERT and UPDATE are refused (no anonymous arm in WITH CHECK). Only a
-- raw anon key with no session gets full CRUD.
--
-- Consequence worth knowing before you apply: every customer side CRM write
-- already runs AFTER a session exists (OnlineCheckout.jsx:458 getAuthToken,
-- QrCheckout.jsx:291, kiosk and POS via ensureAuthToken), so
-- attributeOnlineOrder (src/lib/customerLookup.js:277) and the POS / kiosk
-- store writers (src/store/index.js:3380 onward) are being refused by RLS
-- today and only console.warn about it. customerLookup.js:292 also writes a
-- last_seen_at column that does not exist on customers. Nothing that works
-- today depends on the anonymous arm.
--
-- B1. RESTRICTIVE fences. Restrictive policies only ever subtract, so these
-- cannot widen anything. They close the hole NOW, without waiting for file 3:
--   * real Back Office user (session, not anonymous)  -> allowed, and the
--     permissive tenant policies still bind them to their own orgs
--   * paired device at the customer's venue           -> allowed via the
--     device arm (kiosk loyalty lookup, POS customer search and save)
--   * super admin                                     -> allowed
--   * anonymous public session, raw anon key          -> denied
-- What this changes for a paired kiosk / POS: their customer INSERT and
-- UPDATE start WORKING (B2 gives them a WITH CHECK arm they never had).
-- What it changes for online / QR attribution: nothing, it was already refused;
-- the fix for that path is the attribute_public_order RPC in B3 plus the app
-- change listed in docs/PRE_LIVE_SECURITY_MIGRATIONS.md.
-- What it changes for a POS device that never ran claim_device: customer search
-- returns nothing until it re-pairs. Such a device already cannot read
-- staff_members or closed_checks (both on pos_can_access since 13 Jul), so it
-- is not a new breakage class.

alter table public.customers          enable row level security;
alter table public.customer_locations enable row level security;
alter table public.customer_orders    enable row level security;

drop policy if exists customers_fence on public.customers;
create policy customers_fence on public.customers
  as restrictive for all
  using (
    (auth.uid() is not null and not public.is_anon_session())
    or org_id in (select public.pos_accessible_org_ids())
    or public.is_super_admin()
  )
  with check (
    (auth.uid() is not null and not public.is_anon_session())
    or org_id in (select public.pos_accessible_org_ids())
    or public.is_super_admin()
  );

drop policy if exists customer_locations_fence on public.customer_locations;
create policy customer_locations_fence on public.customer_locations
  as restrictive for all
  using (
    (auth.uid() is not null and not public.is_anon_session())
    or location_id in (select public.pos_accessible_location_ids())
    or public.is_super_admin()
  )
  with check (
    (auth.uid() is not null and not public.is_anon_session())
    or location_id in (select public.pos_accessible_location_ids())
    or public.is_super_admin()
  );

drop policy if exists customer_orders_fence on public.customer_orders;
create policy customer_orders_fence on public.customer_orders
  as restrictive for all
  using (
    (auth.uid() is not null and not public.is_anon_session())
    or location_id in (select public.pos_accessible_location_ids())
    or public.is_super_admin()
  )
  with check (
    (auth.uid() is not null and not public.is_anon_session())
    or location_id in (select public.pos_accessible_location_ids())
    or public.is_super_admin()
  );

-- B2. Permissive tenant policies, created ALONGSIDE the legacy *_all trio.
-- These are what remain after file 3 drops the trio. They also fix two gaps in
-- the legacy shape: a Back Office user whose only access is
-- user_profiles.location_id (no user_locations row) now sees customers, and a
-- paired device gets an INSERT / UPDATE arm.
drop policy if exists customers_tenant on public.customers;
create policy customers_tenant on public.customers
  for all
  using      (org_id in (select public.pos_accessible_org_ids()) or public.is_super_admin())
  with check (org_id in (select public.pos_accessible_org_ids()) or public.is_super_admin());

drop policy if exists customer_locations_tenant on public.customer_locations;
create policy customer_locations_tenant on public.customer_locations
  for all
  using      (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());

drop policy if exists customer_orders_tenant on public.customer_orders;
create policy customer_orders_tenant on public.customer_orders
  for all
  using      (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());

-- B3. RPCs for the public class (online, QR, catering), which cannot prove a
-- venue by policy. Additive: creating them changes nothing until the app calls
-- them.

-- Mirror of normalisePhone in src/lib/customerLookup.js:21 and
-- store._normalisePhone, so the RPC resolves the same customer key the POS and
-- kiosk write.
create or replace function public._normalise_phone(p_raw text)
returns text
language plpgsql
immutable
as $fn$
declare
  v text;
begin
  v := regexp_replace(coalesce(p_raw, ''), '[^0-9+]', '', 'g');
  if v = '' then return null; end if;
  if left(v, 1) = '+' then return v; end if;
  if left(v, 2) = '07' and length(v) = 11 then return '+44' || substr(v, 2); end if;
  if left(v, 2) = '44' then return '+' || v; end if;
  return v;
end;
$fn$;

revoke all on function public._normalise_phone(text) from public;
grant execute on function public._normalise_phone(text) to anon, authenticated, service_role;

-- Device class lookup (kiosk "welcome back", customer display phone capture).
-- The caller must be a paired device or a Back Office user at the location;
-- org_id is resolved server side so the client never chooses it. Returns only
-- what the kiosk pre-fills.
create or replace function public.customer_lookup_by_phone(p_location_id uuid, p_phone text)
returns table (id uuid, name text, email text, marketing_opt_in boolean, allergens text[])
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_org   uuid;
  v_phone text;
begin
  if not (public.pos_can_access(p_location_id) or public.is_super_admin()) then
    raise exception 'customer_lookup_by_phone: not allowed for this location';
  end if;
  v_phone := public._normalise_phone(p_phone);
  if v_phone is null then return; end if;
  select l.org_id into v_org from public.locations l where l.id = p_location_id;
  if v_org is null then return; end if;
  return query
    select c.id, c.name, c.email, c.marketing_opt_in, c.allergens
      from public.customers c
     where c.org_id = v_org
       and c.phone = v_phone
       and c.deleted_at is null
     limit 1;
end;
$fn$;

revoke all on function public.customer_lookup_by_phone(uuid, text) from public, anon;
grant execute on function public.customer_lookup_by_phone(uuid, text) to authenticated, service_role;

-- Public class attribution (online, QR, catering). The caller proves the order:
-- an order_queue row must exist at (location, ref) from a public source, placed
-- in the last 48 hours, whose stored phone ends with the same digits as the
-- phone being attributed. Then: upsert customers by (org, phone) filling blanks
-- only, bump customer_locations, insert customer_orders. Returns the customer
-- id. org_id is resolved server side from the location, never from the client.
create or replace function public.attribute_public_order(
  p_location_id      uuid,
  p_ref              text,
  p_phone            text,
  p_name             text default null,
  p_email            text default null,
  p_marketing_opt_in boolean default false,
  p_total            numeric default 0,
  p_items            jsonb default '[]'::jsonb,
  p_channel          text default 'online'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_org      uuid;
  v_phone    text;
  v_digits   text;
  v_cust     public.customers%rowtype;
  v_id       uuid;
  v_name     text;
  v_email    text;
  v_items    jsonb;
  v_total    numeric;
begin
  v_phone := public._normalise_phone(p_phone);
  if v_phone is null then return null; end if;
  v_digits := right(regexp_replace(v_phone, '\D', '', 'g'), 9);
  if length(v_digits) < 6 then return null; end if;

  if p_channel is null or p_channel not in ('online', 'qr', 'catering') then
    raise exception 'attribute_public_order: p_channel must be online, qr or catering';
  end if;

  -- Proof of order. Same last digits test the tracker gate uses, server side.
  if not exists (
      select 1
        from public.order_queue q
       where q.location_id = p_location_id::text
         and q.ref = p_ref
         and q.source in ('online', 'qr', 'catering')
         and q.created_at > now() - interval '48 hours'
         and right(regexp_replace(coalesce(q.customer->>'phone', ''), '\D', '', 'g'), 9) = v_digits
  ) then
    raise exception 'attribute_public_order: no recent order % at this location for this phone', p_ref;
  end if;

  select l.org_id into v_org
    from public.locations l
   where l.id = p_location_id and l.status = 'active';
  if v_org is null then return null; end if;

  v_name  := nullif(btrim(coalesce(p_name, '')), '');
  v_email := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_total := least(greatest(coalesce(p_total, 0), 0), 100000);
  v_items := case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end;
  if jsonb_array_length(v_items) > 200 then
    v_items := (select jsonb_agg(e) from (select e from jsonb_array_elements(v_items) e limit 200) s);
  end if;

  select * into v_cust
    from public.customers c
   where c.org_id = v_org and c.phone = v_phone and c.deleted_at is null
   limit 1;

  if found then
    v_id := v_cust.id;
    update public.customers
       set name             = case when (v_cust.name is null or v_cust.name = '' or v_cust.name = 'Customer') and v_name is not null then v_name else name end,
           email            = coalesce(email, v_email),
           marketing_opt_in = case when coalesce(marketing_opt_in, false) = false and coalesce(p_marketing_opt_in, false) then true else marketing_opt_in end,
           marketing_opt_in_at = case when coalesce(marketing_opt_in, false) = false and coalesce(p_marketing_opt_in, false) then now() else marketing_opt_in_at end,
           updated_at       = now()
     where id = v_id;
  else
    begin
      insert into public.customers (org_id, phone, phone_raw, name, email, marketing_opt_in, marketing_opt_in_at, source)
      values (v_org, v_phone, p_phone, coalesce(v_name, 'Customer'), v_email,
              coalesce(p_marketing_opt_in, false),
              case when coalesce(p_marketing_opt_in, false) then now() else null end,
              p_channel)
      returning id into v_id;
    exception when unique_violation then
      -- idx_customers_org_phone or idx_customers_org_email raced us; reuse the row.
      select c.id into v_id
        from public.customers c
       where c.org_id = v_org and c.deleted_at is null
         and (c.phone = v_phone or (v_email is not null and lower(c.email) = v_email))
       limit 1;
    end;
  end if;
  if v_id is null then return null; end if;

  insert into public.customer_locations (customer_id, location_id, first_visit_at, last_visit_at, visit_count, lifetime_revenue)
  values (v_id, p_location_id, now(), now(), 1, v_total)
  on conflict (customer_id, location_id) do update
     set visit_count      = coalesce(public.customer_locations.visit_count, 0) + 1,
         lifetime_revenue = coalesce(public.customer_locations.lifetime_revenue, 0) + v_total,
         last_visit_at    = now();

  insert into public.customer_orders (customer_id, location_id, closed_check_id, ordered_at, total, channel, item_summary)
  values (v_id, p_location_id, p_ref, now(), v_total, p_channel, v_items);

  return v_id;
end;
$fn$;

-- The tracker and QR links open on phones that never checked out in that
-- browser, so the raw anon key (no session) must be able to call the public
-- RPCs. The secret is the order proof, not the role.
revoke all on function public.attribute_public_order(uuid, text, text, text, text, boolean, numeric, jsonb, text) from public;
grant execute on function public.attribute_public_order(uuid, text, text, text, text, boolean, numeric, jsonb, text) to anon, authenticated, service_role;


-- ============================================================================
-- C. Finding 3: the "allow all" tables that can be swapped today
-- ============================================================================
-- Every predicate below is the shape already live on ~15 POS core tables
-- since 13 Jul (staff_members, cash_drawers, shifts, closed_checks reads,
-- bar_tabs, menu_items writes, floor_tables writes) and exercised daily by the
-- same paired anonymous devices. A device that never ran claim_device already
-- cannot reach those tables, so no new breakage class is introduced here.

-- C1. activity_events (uuid location_id). Readers and ackers are paired
-- devices and Back Office. Writers include the public class:
--   logOrderActivity  kind 'order'  severity 'info'   (online, QR, catering, kiosk)
--   logActivity       kind 'system' severity 'action' (OnlineCheckout.jsx:945/:970, CateringCheckout.jsx:181)
--   logActivity       kind 'loyalty'                  (OnlineCheckout.jsx:960)
-- so the anonymous INSERT carve-out covers exactly those kinds at an active
-- location. The order_queue trigger log_order_activity is SECURITY DEFINER and
-- unaffected.
alter table public.activity_events enable row level security;
drop policy if exists "allow all" on public.activity_events;
drop policy if exists activity_events_select_tenant on public.activity_events;
drop policy if exists activity_events_update_tenant on public.activity_events;
drop policy if exists activity_events_delete_tenant on public.activity_events;
drop policy if exists activity_events_insert on public.activity_events;

create policy activity_events_select_tenant on public.activity_events
  for select
  using (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());

create policy activity_events_update_tenant on public.activity_events
  for update
  using      (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());

create policy activity_events_delete_tenant on public.activity_events
  for delete
  using (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());

create policy activity_events_insert on public.activity_events
  for insert
  with check (
    location_id in (select public.pos_accessible_location_ids())
    or public.is_super_admin()
    or (
      (auth.uid() is null or public.is_anon_session())
      and kind in ('order', 'system', 'loyalty')
      and severity in ('info', 'action')
      and public.is_active_public_location(location_id)
    )
  );

-- C2. kds_tickets (text location_id, DEFAULT 'loc-demo'). Paired POS / KDS and
-- Back Office only. A ticket written without a location_id would land on
-- 'loc-demo' and be refused by WITH CHECK; every writer in src/ stamps it
-- (db.js:519, store/index.js:7135).
alter table public.kds_tickets enable row level security;
drop policy if exists "allow all" on public.kds_tickets;
drop policy if exists kds_tickets_tenant on public.kds_tickets;
create policy kds_tickets_tenant on public.kds_tickets
  for all
  using      (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin());

-- C3. table_reservations (uuid). ReservationSync on paired devices, bookings
-- module in Back Office. Also in the realtime publication; subscribers that
-- pass the SELECT keep receiving events.
alter table public.table_reservations enable row level security;
drop policy if exists "allow all" on public.table_reservations;
drop policy if exists table_reservations_tenant on public.table_reservations;
create policy table_reservations_tenant on public.table_reservations
  for all
  using      (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());

-- C4. eighty_six (text). Sold out item ids are public storefront data: kiosk,
-- online, catering and menu board read them and subscribe to them, so SELECT
-- stays open. Writes were open to any key; now paired devices and Back Office
-- only. decrement_stock inserts auto 86 rows as definer and is unaffected.
alter table public.eighty_six enable row level security;
drop policy if exists "allow all" on public.eighty_six;
drop policy if exists eighty_six_read on public.eighty_six;
drop policy if exists eighty_six_write_tenant on public.eighty_six;
create policy eighty_six_read on public.eighty_six
  for select using (true);
create policy eighty_six_write_tenant on public.eighty_six
  for all
  using      (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin());

-- C5. item_variants and modifier_options have no location column and ZERO call
-- sites in src/ or supabase/functions (grep 7 Sep 2026). Reads stay open (option
-- names and prices, no PII); writes go through the parent row's venue.
alter table public.item_variants enable row level security;
drop policy if exists "allow all" on public.item_variants;
drop policy if exists item_variants_read on public.item_variants;
drop policy if exists item_variants_write_tenant on public.item_variants;
create policy item_variants_read on public.item_variants
  for select using (true);
create policy item_variants_write_tenant on public.item_variants
  for all
  using (exists (select 1 from public.menu_items mi
                  where mi.id = item_variants.item_id
                    and (mi.location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())))
  with check (exists (select 1 from public.menu_items mi
                       where mi.id = item_variants.item_id
                         and (mi.location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())));

alter table public.modifier_options enable row level security;
drop policy if exists "allow all" on public.modifier_options;
drop policy if exists modifier_options_read on public.modifier_options;
drop policy if exists modifier_options_write_tenant on public.modifier_options;
create policy modifier_options_read on public.modifier_options
  for select using (true);
create policy modifier_options_write_tenant on public.modifier_options
  for all
  using (exists (select 1 from public.modifier_groups g
                  where g.id = modifier_options.group_id
                    and (g.location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())))
  with check (exists (select 1 from public.modifier_groups g
                       where g.id = modifier_options.group_id
                         and (g.location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())));

-- C6. stamp_transactions (uuid). Written only by loyalty edge functions
-- (service role), read by reports/LoyaltyReport.jsx:66 as a Back Office user.
-- service_all_stamp_tx was "to public", which includes anon. Dropped; the
-- service role bypasses RLS anyway.
alter table public.stamp_transactions enable row level security;
drop policy if exists service_all_stamp_tx on public.stamp_transactions;
drop policy if exists anon_read_stamp_tx on public.stamp_transactions;
drop policy if exists stamp_transactions_read_tenant on public.stamp_transactions;
create policy stamp_transactions_read_tenant on public.stamp_transactions
  for select
  using (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());

-- C7. device_profiles (uuid). Writes are Back Office only (DeviceProfiles.jsx,
-- KioskSettings.jsx). Reads stay OPEN for now: CustomerDisplaySurface.jsx:84
-- reads branding by profile id as an anonymous session that has not always
-- claimed a device, and KioskApp.jsx:85 reads before the kiosk's claim is
-- guaranteed. File 3 narrows the read once those two use
-- device_profile_public() below.
alter table public.device_profiles enable row level security;
drop policy if exists "allow all" on public.device_profiles;
drop policy if exists device_profiles_read_open on public.device_profiles;
drop policy if exists device_profiles_read_tenant on public.device_profiles;
drop policy if exists device_profiles_insert_bo on public.device_profiles;
drop policy if exists device_profiles_update_bo on public.device_profiles;
drop policy if exists device_profiles_delete_bo on public.device_profiles;
create policy device_profiles_read_open on public.device_profiles
  for select using (true);
create policy device_profiles_insert_bo on public.device_profiles
  for insert
  with check (location_id::text in (select public.user_accessible_locations()) or public.is_super_admin());
create policy device_profiles_update_bo on public.device_profiles
  for update
  using      (location_id::text in (select public.user_accessible_locations()) or public.is_super_admin())
  with check (location_id::text in (select public.user_accessible_locations()) or public.is_super_admin());
create policy device_profiles_delete_bo on public.device_profiles
  for delete
  using (location_id::text in (select public.user_accessible_locations()) or public.is_super_admin());

-- Branding only, for the customer display and a kiosk before its claim lands.
-- No printer targets, no reader assignment, no training_mode.
create or replace function public.device_profile_public(p_profile_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'id',                      p.id,
    'name',                    p.name,
    'kiosk_brand_name',        p.kiosk_brand_name,
    'kiosk_brand_logo_url',    p.kiosk_brand_logo_url,
    'kiosk_brand_color',       p.kiosk_brand_color,
    'kiosk_brand_accent_color',p.kiosk_brand_accent_color,
    'kiosk_brand_bg_color',    p.kiosk_brand_bg_color,
    'kiosk_theme_mode',        p.kiosk_theme_mode,
    'kiosk_banners',           p.kiosk_banners,
    'kiosk_attract_video_url', p.kiosk_attract_video_url,
    'customer_display_mode',   p.customer_display_mode,
    'customer_display_images', p.customer_display_images,
    'customer_display_cart_images', p.customer_display_cart_images
  )
  from public.device_profiles p
  where p.id = p_profile_id;
$fn$;

revoke all on function public.device_profile_public(text) from public;
grant execute on function public.device_profile_public(text) to anon, authenticated, service_role;

-- C8. organisations. No location column. Readers: Back Office bootstrap
-- (BackOfficeApp.jsx:428 own org, LocationSwitcher.jsx:97 accessible orgs,
-- CompanyAdmin.jsx:45) and the super admin portal. Writers: CompanyAdmin.jsx:65
-- INSERT (new operator bootstrap, a real user with no org yet), super admin
-- PATCH / DELETE (CompanyAdminApp.jsx:226/:266). No anonymous surface reads
-- organisations. This also restores the 20260430 super admin cross org read
-- intent that "allow all" was masking.
alter table public.organisations enable row level security;
drop policy if exists "allow all" on public.organisations;
drop policy if exists "Allow authenticated access" on public.organisations;
drop policy if exists organisations_select on public.organisations;
drop policy if exists organisations_insert on public.organisations;
drop policy if exists organisations_update on public.organisations;
drop policy if exists organisations_delete on public.organisations;
create policy organisations_select on public.organisations
  for select
  using (
    id in (select public.pos_accessible_org_ids())
    or id = public.caller_org_id()
    or public.is_super_admin()
  );
create policy organisations_insert on public.organisations
  for insert
  with check (auth.uid() is not null and not public.is_anon_session());
create policy organisations_update on public.organisations
  for update
  using      (public.is_super_admin() or (not public.is_anon_session() and id = public.caller_org_id()))
  with check (public.is_super_admin() or (not public.is_anon_session() and id = public.caller_org_id()));
create policy organisations_delete on public.organisations
  for delete
  using (public.is_super_admin());

-- C9. locations (Ops). Three OR'd policies, one of them "allow all". Readers
-- include every customer surface (org_id, receipt_branding,
-- default_tax_profile_id, timezone, show_item_images) and a PostgREST embed
-- `locations(*)` from PairingScreen.jsx:20, so a column level grant is NOT
-- possible without an app change (a column grant fails the whole `*` select
-- for Back Office users too). The read stays open for ACTIVE locations; the
-- row holds no secrets (pos_settings is takeaway_customer_details; payment
-- credentials live in the Platform DB and in vault).
-- Writes were open to any key. Now:
--   UPDATE  paired device (db.js:905 writes quick_screen_ids from the POS) or
--           Back Office access, or super admin
--   INSERT  a real user creating a location inside their OWN org
--           (CompanyAdmin.jsx:95, the new operator bootstrap) or super admin
--   DELETE  super admin only (CompanyAdminApp teardown)
alter table public.locations enable row level security;
drop policy if exists "allow all" on public.locations;
drop policy if exists "Allow authenticated access" on public.locations;
drop policy if exists "Users can update own location settings" on public.locations;
drop policy if exists locations_select on public.locations;
drop policy if exists locations_insert on public.locations;
drop policy if exists locations_update on public.locations;
drop policy if exists locations_delete on public.locations;
create policy locations_select on public.locations
  for select
  using (
    status = 'active'
    or id in (select public.pos_accessible_location_ids())
    or public.is_super_admin()
  );
create policy locations_insert on public.locations
  for insert
  with check (
    public.is_super_admin()
    or (not public.is_anon_session() and org_id is not null and org_id = public.caller_org_id())
  );
create policy locations_update on public.locations
  for update
  using      (id in (select public.pos_accessible_location_ids()) or public.is_super_admin())
  with check (id in (select public.pos_accessible_location_ids()) or public.is_super_admin());
create policy locations_delete on public.locations
  for delete
  using (public.is_super_admin());

-- C10. user_locations and user_profiles. Their "allow all" policies were
-- replaced by 20260805c Section A (verified in the 5 Aug baseline); the drops
-- are restated so this file is complete against the readiness list.
-- user_profiles still carries "Allow authenticated access" (FOR ALL on
-- auth.role() = 'authenticated'), which an anonymous session satisfies, so any
-- kiosk visitor can read all 366 profiles. The only anonymous reads of
-- user_profiles are the caller's OWN row (src/lib/supabase.js:115,
-- src/lib/db.js:951), so a restrictive fence on other people's rows is free.
-- The full per command rework of user_profiles is 20260721c's job and is now
-- unblocked by A1; it is not replayed here.
drop policy if exists "allow all" on public.user_locations;
drop policy if exists "allow all" on public.user_profiles;

alter table public.user_profiles enable row level security;
drop policy if exists up_no_anon_read_others on public.user_profiles;
create policy up_no_anon_read_others on public.user_profiles
  as restrictive for select
  using (not public.is_anon_session() or id = auth.uid());


-- ============================================================================
-- D. order_queue, active_sessions, closed_checks: replacements and RPCs
-- ============================================================================
-- order_queue and active_sessions KEEP "allow all" in this file. Their public
-- class callers read them directly today (order tracker, QR tab discovery and
-- resume, catering capacity, QR table session sync) and cannot be scoped by
-- policy. The replacement policies and the RPCs are created now, alongside,
-- so file 3 only has to drop the two legacy policies once the app calls the
-- RPCs. Creating a policy alongside "allow all" changes nothing today.

-- D1. order_queue (text location_id).
alter table public.order_queue enable row level security;
drop policy if exists order_queue_tenant on public.order_queue;
create policy order_queue_tenant on public.order_queue
  for all
  using      (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin());

-- Public checkout INSERT carve-out. Rows written by OnlineCheckout.jsx:1047 and
-- :1164 (source online, status prep), QrCheckout.jsx:252 and :459 (qr, prep),
-- CateringCheckout.jsx:232 and :270 (catering, received). None set `staff`.
-- 'kiosk' is included UNTIL FILE 3 so a kiosk whose best effort claim_device
-- failed cannot lose a paid order between this file and the pairing re-do;
-- file 3 recreates this policy without it.
drop policy if exists order_queue_public_insert on public.order_queue;
create policy order_queue_public_insert on public.order_queue
  for insert
  with check (
    (auth.uid() is null or public.is_anon_session())
    and source in ('online', 'qr', 'catering', 'kiosk')
    and status in ('prep', 'received')
    and staff is null
    and public.is_active_public_location(location_id)
  );

-- D2. closed_checks: 'insert closed checks' was WITH CHECK (true), so any key
-- could fabricate revenue rows that feed billing GMV (readiness medium 2).
-- SELECT / UPDATE / DELETE are already on pos_can_access. Public sources keep a
-- narrow carve-out: OnlineCheckout.jsx:1096/:1238, QrCheckout.jsx:474,
-- TabResumeScreen.jsx:153, CateringCheckout.jsx:286 all write status 'paid'
-- with staff_id null. The kiosk writes source 'kiosk' with kiosk_id set
-- (KioskApp.jsx:928); kept until file 3 for the same reason as D1.
-- Durable fix (app): write the row from the capture edge function.
alter table public.closed_checks enable row level security;
drop policy if exists "insert closed checks" on public.closed_checks;
drop policy if exists closed_checks_insert on public.closed_checks;
create policy closed_checks_insert on public.closed_checks
  for insert
  with check (
    location_id in (select public.pos_accessible_location_keys())
    or public.is_super_admin()
    or (
      (auth.uid() is null or public.is_anon_session())
      and status = 'paid'
      and staff_id is null
      and public.is_active_public_location(location_id)
      and (
        source in ('online', 'qr', 'catering')
        or (source = 'kiosk' and kiosk_id is not null)
      )
    )
  );

-- D3. active_sessions (uuid location_id). Alongside only; file 3 drops
-- "allow all" once qrTableSession.js calls sync_qr_table_session().
alter table public.active_sessions enable row level security;
drop policy if exists active_sessions_tenant on public.active_sessions;
create policy active_sessions_tenant on public.active_sessions
  for all
  using      (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());

-- D4. RPCs for the public class. Each is SECURITY DEFINER with a pinned
-- search_path, keyed by a secret the customer already holds, and returns the
-- minimum the screen renders. Granted to anon as well as authenticated because
-- tracker and QR links open on phones with no session.

-- Track gate: OnlineSurface.jsx:230 (?track=REF&p=LAST4). Boolean only.
create or replace function public.order_track_check(p_location_id text, p_ref text, p_last4 text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
      from public.order_queue q
     where q.location_id = p_location_id
       and q.ref = p_ref
       and length(regexp_replace(coalesce(p_last4, ''), '\D', '', 'g')) = 4
       and right(regexp_replace(coalesce(q.customer->>'phone', ''), '\D', '', 'g'), 4)
           = regexp_replace(p_last4, '\D', '', 'g')
  );
$fn$;

-- Tracker poll: OrderTracker.jsx:44. The customer block is REDACTED to the keys
-- the tracker renders (delivery_mode, collection_at, tip) plus the last 4 phone
-- digits the share link needs (OrderTracker.jsx:332). Name, full phone, email
-- and address never leave the database on this path.
create or replace function public.order_track_row(p_location_id text, p_ref text, p_last4 text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
           'ref',             q.ref,
           'status',          q.status,
           'total',           q.total,
           'items',           q.items,
           'collection_time', q.collection_time,
           'is_asap',         q.is_asap,
           'type',            q.type,
           'source',          q.source,
           'sent_at',         q.sent_at,
           'updated_at',      q.updated_at,
           'customer',        jsonb_strip_nulls(jsonb_build_object(
               'delivery_mode', q.customer->>'delivery_mode',
               'collection_at', q.customer->>'collection_at',
               'tip',           q.customer->'tip',
               'phone',         right(regexp_replace(coalesce(q.customer->>'phone', ''), '\D', '', 'g'), 4)
           ))
         )
    from public.order_queue q
   where q.location_id = p_location_id
     and q.ref = p_ref
     and length(regexp_replace(coalesce(p_last4, ''), '\D', '', 'g')) = 4
     and right(regexp_replace(coalesce(q.customer->>'phone', ''), '\D', '', 'g'), 4)
         = regexp_replace(p_last4, '\D', '', 'g')
   limit 1;
$fn$;

-- QR table discovery: OnlineSurface.jsx:141 ("Settle bill" list). One entry per
-- open tab at the table. Returns an opaque handle (md5 of the payment intent
-- id) instead of the payment ids, and never the join code, name or phone.
create or replace function public.qr_table_open_tabs(p_location_id text, p_table_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(jsonb_agg(t order by t.opened_at), '[]'::jsonb)
    from (
      select md5(q.customer->>'payment_intent_id')                                  as tab_handle,
             min(coalesce(q.customer->>'tab_ref', q.ref))                           as tab_ref,
             min(coalesce(q.customer->>'tableLabel', p_table_id))                   as table_label,
             min(coalesce(q.customer->>'tab_opened_at', q.created_at::text))        as opened_at,
             min(coalesce(q.customer->>'processor', 'stripe'))                      as processor,
             coalesce(sum(q.total), 0)                                              as total,
             count(*)::int                                                          as rounds,
             bool_or(coalesce(q.customer->>'tab_join_code', '') <> '')              as has_join_code,
             max(coalesce((q.customer->>'pre_auth_amount')::numeric, 0))            as pre_auth_amount
        from public.order_queue q
       where q.location_id = p_location_id
         and q.source = 'qr'
         and q.status <> 'collected'
         and q.customer->>'tableId' = p_table_id
         and q.customer->>'tab_open' = 'true'
         and coalesce(q.customer->>'payment_intent_id', '') <> ''
       group by q.customer->>'payment_intent_id'
    ) t;
$fn$;

-- QR tab rounds: OnlineSurface.jsx:187 (own stash, keyed by payment intent id)
-- and JoinTabScreen (another guest at the table, keyed by handle + join code).
-- Full rows come back only for the tab the caller has proven.
create or replace function public.qr_tab_rounds(
  p_location_id       text,
  p_payment_intent_id text default null,
  p_tab_handle        text default null,
  p_join_code         text default null
)
returns table (ref text, status text, items jsonb, total numeric, customer jsonb, location_id text, created_at timestamptz, sent_at timestamptz)
language sql
stable
security definer
set search_path = public
as $fn$
  select q.ref, q.status, q.items, q.total, q.customer, q.location_id, q.created_at, q.sent_at
    from public.order_queue q
   where q.location_id = p_location_id
     and q.source = 'qr'
     and q.status <> 'collected'
     and coalesce(q.customer->>'payment_intent_id', '') <> ''
     and (
       (p_payment_intent_id is not null and q.customer->>'payment_intent_id' = p_payment_intent_id)
       or (
         p_tab_handle is not null
         and md5(q.customer->>'payment_intent_id') = p_tab_handle
         and (
           coalesce(q.customer->>'tab_join_code', '') = ''
           or (p_join_code is not null and upper(btrim(q.customer->>'tab_join_code')) = upper(btrim(p_join_code)))
         )
       )
     )
   order by q.created_at;
$fn$;

-- QR sub numbering: QrCheckout.jsx:371 only needs the count of distinct tabs.
create or replace function public.qr_table_tab_count(p_location_id text, p_table_id text)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select count(distinct coalesce(nullif(q.customer->>'payment_intent_id', ''), 'ref:' || q.ref))::int
    from public.order_queue q
   where q.location_id = p_location_id
     and q.source = 'qr'
     and q.status <> 'collected'
     and q.customer->>'tableId' = p_table_id;
$fn$;

-- Catering capacity: CateringSurface.jsx:131 and :217. Count and value only.
create or replace function public.catering_day_load(p_location_id text, p_date date)
returns table (order_count integer, order_value numeric)
language sql
stable
security definer
set search_path = public
as $fn$
  select count(*)::int, coalesce(sum(q.total), 0)
    from public.order_queue q
   where q.location_id = p_location_id
     and q.source = 'catering'
     and q.event_date = p_date
     and q.status is distinct from 'cancelled';
$fn$;

-- Floor plan sync for QR tabs: src/lib/qrTableSession.js, moved server side.
-- Recomputes the active_sessions row for the table from open QR rounds and
-- only ever writes or deletes a row whose session->>'source' = 'qr', so an
-- operator's own dine in session on the same table is never touched (the
-- tables are never lost invariant). Idempotent; safe to call after every
-- round, close or force close.
create or replace function public.sync_qr_table_session(p_location_id uuid, p_table_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_floor_id  text;
  v_items     jsonb;
  v_subtotal  numeric := 0;
  v_rounds    int := 0;
  v_opened    timestamptz;
  v_existing  jsonb;
  v_session   jsonb;
begin
  if p_location_id is null or p_table_id is null or btrim(p_table_id) = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing args');
  end if;

  -- Resolve the QR carried table id or label to the canonical floor_tables.id.
  select f.id into v_floor_id
    from public.floor_tables f
   where f.location_id = p_location_id::text
     and (f.id = p_table_id or lower(btrim(f.label)) = lower(btrim(p_table_id)))
   order by (f.id = p_table_id) desc
   limit 1;
  v_floor_id := coalesce(v_floor_id, p_table_id);

  -- Every open QR round at this table, items tagged with their tab's payment intent.
  select coalesce(jsonb_agg(i.item || jsonb_build_object('tab_pi', i.tab_pi)), '[]'::jsonb),
         count(distinct i.ref)::int,
         min(i.sent_at)
    into v_items, v_rounds, v_opened
    from (
      select q.ref, q.sent_at, q.customer->>'payment_intent_id' as tab_pi, e.item
        from public.order_queue q
        cross join lateral jsonb_array_elements(coalesce(q.items, '[]'::jsonb)) e(item)
       where q.location_id = p_location_id::text
         and q.source = 'qr'
         and q.status <> 'collected'
         and q.customer->>'tableId' = p_table_id
    ) i;

  if v_items is null or jsonb_array_length(v_items) = 0 then
    select a.session into v_existing
      from public.active_sessions a
     where a.location_id = p_location_id and a.table_id = v_floor_id;
    if v_existing is not null and v_existing->>'source' = 'qr' then
      delete from public.active_sessions
       where location_id = p_location_id and table_id = v_floor_id;
      return jsonb_build_object('ok', true, 'action', 'deleted', 'table_id', v_floor_id);
    end if;
    return jsonb_build_object('ok', true, 'action', 'none', 'table_id', v_floor_id);
  end if;

  select coalesce(sum(
           (coalesce((it->>'price')::numeric, 0)
            + coalesce((select sum(coalesce((m->>'price')::numeric, 0))
                          from jsonb_array_elements(case when jsonb_typeof(it->'mods') = 'array' then it->'mods' else '[]'::jsonb end) m), 0))
           * coalesce((it->>'qty')::numeric, 1)
         ), 0)
    into v_subtotal
    from jsonb_array_elements(v_items) it;

  v_session := jsonb_build_object(
    'items',        v_items,
    'server',       'QR',
    'source',       'qr',
    'covers',       1,
    'openedAt',     (extract(epoch from coalesce(v_opened, now())) * 1000)::bigint,
    'sentAt',       (extract(epoch from now()) * 1000)::bigint,
    'subtotal',     v_subtotal,
    'total',        v_subtotal,
    'qr_tab_count', v_rounds
  );

  -- Never overwrite an operator's own session on this table.
  select a.session into v_existing
    from public.active_sessions a
   where a.location_id = p_location_id and a.table_id = v_floor_id;
  if v_existing is not null and coalesce(v_existing->>'source', '') <> 'qr' then
    return jsonb_build_object('ok', true, 'action', 'kept_pos_session', 'table_id', v_floor_id);
  end if;

  insert into public.active_sessions (location_id, table_id, session, updated_at)
  values (p_location_id, v_floor_id, v_session, now())
  on conflict (location_id, table_id) do update
     set session = excluded.session, updated_at = now();

  return jsonb_build_object('ok', true, 'action', 'upserted', 'table_id', v_floor_id, 'rounds', v_rounds);
end;
$fn$;

-- QR self close: TabResumeScreen.jsx:142. Marks collected only the rounds that
-- carry the caller's payment intent id, then re syncs the floor plan. The
-- closed_checks row stays a client insert under D2 for now.
create or replace function public.qr_close_tab(p_location_id text, p_payment_intent_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_refs    text[];
  v_tables  text[];
  v_t       text;
  v_loc     uuid;
begin
  if coalesce(p_payment_intent_id, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing payment intent');
  end if;

  with upd as (
    update public.order_queue q
       set status = 'collected'
     where q.location_id = p_location_id
       and q.source = 'qr'
       and q.status <> 'collected'
       and q.customer->>'payment_intent_id' = p_payment_intent_id
    returning q.ref, q.customer->>'tableId' as table_id
  )
  select array_agg(ref), array_agg(distinct table_id) into v_refs, v_tables from upd;

  begin
    v_loc := p_location_id::uuid;
  exception when others then
    v_loc := null;
  end;
  if v_loc is not null and v_tables is not null then
    foreach v_t in array v_tables loop
      if v_t is not null then
        perform public.sync_qr_table_session(v_loc, v_t);
      end if;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'closed', coalesce(array_length(v_refs, 1), 0), 'refs', to_jsonb(coalesce(v_refs, array[]::text[])));
end;
$fn$;

revoke all on function public.order_track_check(text, text, text)          from public;
revoke all on function public.order_track_row(text, text, text)            from public;
revoke all on function public.qr_table_open_tabs(text, text)               from public;
revoke all on function public.qr_tab_rounds(text, text, text, text)        from public;
revoke all on function public.qr_table_tab_count(text, text)               from public;
revoke all on function public.catering_day_load(text, date)                from public;
revoke all on function public.sync_qr_table_session(uuid, text)            from public;
revoke all on function public.qr_close_tab(text, text)                     from public;
grant execute on function public.order_track_check(text, text, text)       to anon, authenticated, service_role;
grant execute on function public.order_track_row(text, text, text)         to anon, authenticated, service_role;
grant execute on function public.qr_table_open_tabs(text, text)            to anon, authenticated, service_role;
grant execute on function public.qr_tab_rounds(text, text, text, text)     to anon, authenticated, service_role;
grant execute on function public.qr_table_tab_count(text, text)            to anon, authenticated, service_role;
grant execute on function public.catering_day_load(text, date)             to anon, authenticated, service_role;
grant execute on function public.sync_qr_table_session(uuid, text)         to anon, authenticated, service_role;
grant execute on function public.qr_close_tab(text, text)                  to anon, authenticated, service_role;


-- ============================================================================
-- E. Catalog write policies fenced only on auth.role() (readiness cause b)
-- ============================================================================
-- auth.role() = 'authenticated' is satisfied by every anonymous session, and
-- some of these also named 'anon', so any key could rewrite any venue's menus,
-- stock, config snapshots, discount rules and tax. Reads are public storefront
-- data and stay open. Writers are Back Office users and paired POS devices
-- (db.js upserts, store/index.js:195/:234, TaxManager.jsx, DiscountManager via
-- db.js:1747), all covered by the device / access set. Edge functions (HubRise
-- catalog sync, Lightspeed import runs in the browser as a Back Office user)
-- use service_role.

-- menus (text location_id)
alter table public.menus enable row level security;
drop policy if exists menus_auth_write on public.menus;
drop policy if exists menus_anon_read on public.menus;
drop policy if exists menus_write_tenant on public.menus;
create policy menus_anon_read on public.menus
  for select using (true);
create policy menus_write_tenant on public.menus
  for all
  using      (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin());

-- menu_categories (text)
alter table public.menu_categories enable row level security;
drop policy if exists menu_categories_auth_write on public.menu_categories;
drop policy if exists menu_categories_anon_read on public.menu_categories;
drop policy if exists menu_categories_write_tenant on public.menu_categories;
create policy menu_categories_anon_read on public.menu_categories
  for select using (true);
create policy menu_categories_write_tenant on public.menu_categories
  for all
  using      (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin());

-- menu_category_links has no location column; the venue is the menu's.
alter table public.menu_category_links enable row level security;
drop policy if exists menu_category_links_auth_write on public.menu_category_links;
drop policy if exists menu_category_links_anon_read on public.menu_category_links;
drop policy if exists menu_category_links_write_tenant on public.menu_category_links;
create policy menu_category_links_anon_read on public.menu_category_links
  for select using (true);
create policy menu_category_links_write_tenant on public.menu_category_links
  for all
  using (exists (select 1 from public.menus m
                  where m.id = menu_category_links.menu_id
                    and (m.location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())))
  with check (exists (select 1 from public.menus m
                       where m.id = menu_category_links.menu_id
                         and (m.location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())));

-- stock_levels (text). Public surfaces change stock only through
-- decrement_stock / stock-deplete, never by direct write.
alter table public.stock_levels enable row level security;
drop policy if exists stock_levels_auth_write on public.stock_levels;
drop policy if exists stock_levels_anon_read on public.stock_levels;
drop policy if exists stock_levels_write_tenant on public.stock_levels;
create policy stock_levels_anon_read on public.stock_levels
  for select using (true);
create policy stock_levels_write_tenant on public.stock_levels
  for all
  using      (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin());

-- config_pushes (text). The snapshot carries the whole menu, tables, tax,
-- discount presets, device profiles and booking rules (no staff, no PINs).
-- Customer surfaces read two fragments of the latest row; Back Office inserts
-- (db.js:821). Nothing updates or deletes from a client.
alter table public.config_pushes enable row level security;
drop policy if exists config_pushes_auth_write on public.config_pushes;
drop policy if exists config_pushes_read on public.config_pushes;
drop policy if exists config_pushes_insert_tenant on public.config_pushes;
create policy config_pushes_read on public.config_pushes
  for select using (true);
create policy config_pushes_insert_tenant on public.config_pushes
  for insert
  with check (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin());

-- discount_rules (text). Online and QR read active rules for auto discounts
-- (db.js:1716); Back Office needs inactive ones too, via the tenant arm.
alter table public.discount_rules enable row level security;
drop policy if exists "Allow authenticated access" on public.discount_rules;
drop policy if exists discount_rules_public_read on public.discount_rules;
drop policy if exists discount_rules_tenant on public.discount_rules;
create policy discount_rules_public_read on public.discount_rules
  for select using (coalesce(active, false) = true);
create policy discount_rules_tenant on public.discount_rules
  for all
  using      (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_keys()) or public.is_super_admin());

-- tax_rates (uuid)
alter table public.tax_rates enable row level security;
drop policy if exists "Allow authenticated access" on public.tax_rates;
drop policy if exists tax_rates_read on public.tax_rates;
drop policy if exists tax_rates_write_tenant on public.tax_rates;
create policy tax_rates_read on public.tax_rates
  for select using (true);
create policy tax_rates_write_tenant on public.tax_rates
  for all
  using      (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());

-- tax_profiles / tax_profile_lines (uuid, 20260825b). Reads stay as they are;
-- the three write policies were `to authenticated with check (true)`.
alter table public.tax_profiles      enable row level security;
alter table public.tax_profile_lines enable row level security;
drop policy if exists "tax_profiles insert" on public.tax_profiles;
drop policy if exists "tax_profiles update" on public.tax_profiles;
drop policy if exists "tax_profiles delete" on public.tax_profiles;
create policy "tax_profiles insert" on public.tax_profiles
  for insert to authenticated
  with check (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());
create policy "tax_profiles update" on public.tax_profiles
  for update to authenticated
  using      (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());
create policy "tax_profiles delete" on public.tax_profiles
  for delete to authenticated
  using (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());

drop policy if exists "tax_profile_lines insert" on public.tax_profile_lines;
drop policy if exists "tax_profile_lines update" on public.tax_profile_lines;
drop policy if exists "tax_profile_lines delete" on public.tax_profile_lines;
create policy "tax_profile_lines insert" on public.tax_profile_lines
  for insert to authenticated
  with check (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());
create policy "tax_profile_lines update" on public.tax_profile_lines
  for update to authenticated
  using      (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin())
  with check (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());
create policy "tax_profile_lines delete" on public.tax_profile_lines
  for delete to authenticated
  using (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());


-- ============================================================================
-- F. Grant hygiene (readiness medium 3)
-- ============================================================================
-- RLS covers SELECT / INSERT / UPDATE / DELETE only. TRUNCATE is governed purely
-- by the grant, and REFERENCES / TRIGGER are DDL privileges no client needs.
-- Nothing in the app uses any of the three. service_role keeps everything.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;


-- ============================================================================
-- V. Verification (read only, paste after applying)
-- ============================================================================
-- 1. Helpers are definer with a pinned search_path (expect t / {search_path=public} for all):
-- select proname, prosecdef, proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and proname in ('user_accessible_locations','user_accessible_orgs','pos_accessible_location_keys',
--                    'pos_accessible_location_ids','pos_accessible_org_ids','caller_org_id',
--                    'is_active_public_location','decrement_stock','restore_stock',
--                    'attribute_public_order','customer_lookup_by_phone','device_profile_public',
--                    'order_track_check','order_track_row','qr_table_open_tabs','qr_tab_rounds',
--                    'qr_table_tab_count','catering_day_load','sync_qr_table_session','qr_close_tab')
--  order by proname;
--
-- 2. No literal allow-all left on the tables this file owns (expect 0 rows):
-- select tablename, policyname from pg_policies
--  where schemaname = 'public' and policyname = 'allow all'
--    and tablename in ('activity_events','kds_tickets','table_reservations','eighty_six','item_variants',
--                      'modifier_options','stamp_transactions','organisations','locations','device_profiles',
--                      'user_locations','user_profiles');
--
-- 3. The two tables that keep allow-all until file 3 (expect exactly order_queue and active_sessions):
-- select tablename from pg_policies where schemaname = 'public' and policyname = 'allow all' order by 1;
--
-- 4. Customer fences present (expect 3 restrictive + 3 permissive tenant + the 3 legacy *_all):
-- select tablename, policyname, permissive, cmd from pg_policies
--  where tablename in ('customers','customer_locations','customer_orders') order by 1, 2;
--
-- 5. No auth.role() only write policy left except user_profiles "Allow authenticated access"
--    (expect exactly that one row; 20260721c replaces it, see C10):
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public' and cmd in ('ALL','INSERT','UPDATE','DELETE')
--    and (coalesce(qual,'') like '%auth.role()%' or coalesce(with_check,'') like '%auth.role()%');
--
-- 6. closed_checks insert is no longer WITH CHECK (true):
-- select policyname, with_check from pg_policies where tablename = 'closed_checks' and cmd = 'INSERT';
--
-- 7. TRUNCATE / REFERENCES / TRIGGER gone for anon and authenticated (expect 0 rows):
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_schema = 'public' and grantee in ('anon','authenticated')
--    and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER');
--
-- 8. Function EXECUTE (expect anon = false on decrement_stock / restore_stock / upsert_customer_visit,
--    anon = true on the public RPCs):
-- select p.proname,
--        has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
--        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('decrement_stock','restore_stock','upsert_customer_visit','attribute_public_order',
--                      'order_track_row','qr_tab_rounds','sync_qr_table_session','qr_close_tab')
--  order by 1;
