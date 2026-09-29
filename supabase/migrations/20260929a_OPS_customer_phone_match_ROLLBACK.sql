-- ROLLBACK for 20260929a_OPS_customer_phone_match.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Puts back customer_by_phone and attribute_public_order EXACTLY as they are live on 29 Sep 2026
-- before 20260929a (word for word 20260921_OPS_customers_fence.sql sections 2 and 3, which is what
-- pg_get_functiondef returned for both that day), with the same grants, then drops the two
-- functions 20260929a added (nothing else uses them).
--
-- What stays: customers made while 20260929a was live are stored as the key ('+447931129015').
-- The old functions still find a +44 row from a number typed with 44 or +44 (the digits match),
-- but a number typed with 0 ('07931129015') makes a second customer again: that is the bug
-- 20260929a fixed, so roll back only if 20260929a itself is at fault.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.customers') is null or to_regclass('public.order_queue') is null then
    raise exception 'This is not the Ops database (customers tables are missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- ============================================================================
-- customer_by_phone, as live before 20260929a
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
-- attribute_public_order, as live before 20260929a
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
-- the two functions 20260929a added (after the two above no longer call them)
-- ============================================================================

drop function if exists public.phone_match_key(text, text);
drop function if exists public.phone_region_from_currency(text);

notify pgrst, 'reload schema';

-- Check (read only), after running. Expect 0 rows:
--   select p.oid::regprocedure from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('phone_match_key', 'phone_region_from_currency');
-- and customer_by_phone matches on the digits again (expect true):
--   select position($x$regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') = v_phone$x$
--                   in pg_get_functiondef('public.customer_by_phone(text,text)'::regprocedure)) > 0;
