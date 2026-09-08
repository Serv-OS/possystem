-- ============================================================================
-- v5.5.5 — Customer attribution diagnostics
-- ============================================================================
--
-- Read-only queries to check whether an order was correctly recorded against
-- a customer in the multi-location CRM. Run in the Supabase SQL editor.
--
-- Replace the placeholders in each query before running:
--   <PHONE>        — the phone number used (any format; query normalises)
--   <ORG_ID>       — the organisation uuid (look up via locations)
--   <LOC_1_ID>     — Location 1 uuid
--   <LOC_2_ID>     — Location 2 uuid
--
-- Project: tbetcegmszzotrwdtqhi (RPOS Ops DB)
-- ============================================================================


-- 1. Verify both locations are in the SAME org. If they're in different orgs,
-- customer dedupe by phone won't span them — that's by design (each org has
-- its own CRM).
-- ----------------------------------------------------------------------------

select id, name, org_id, timezone, currency
  from locations
 where id in ('<LOC_1_ID>', '<LOC_2_ID>')
 order by name;
-- Expect: same org_id on both rows.


-- 2. Look up the customer by phone (regardless of org). If it exists in BOTH
-- orgs, that's why the multi-location attribution didn't dedupe — confirm
-- step 1 first.
-- ----------------------------------------------------------------------------

select id, org_id, name, phone, phone_raw, email, created_at, updated_at,
       deleted_at, allergens, marketing_opt_in
  from customers
 where regexp_replace(phone, '[^0-9+]', '', 'g')
       like '%' || regexp_replace('<PHONE>', '[^0-9]', '', 'g') || '%'
    or phone_raw like '%' || '<PHONE>' || '%'
 order by created_at desc
 limit 5;
-- Expect: one row per org if attribution worked. If zero rows, the customer
-- was never written — check the POS / kiosk console for [upsertCustomer]
-- log lines after the order completes (v5.5.5 adds explicit failure logs).


-- 3. Check customer_locations — should have one row per location the customer
-- has visited.
-- ----------------------------------------------------------------------------

select cl.customer_id, c.name, c.phone, cl.location_id, l.name as loc_name,
       cl.visit_count, cl.lifetime_revenue, cl.last_visit_at
  from customer_locations cl
  join customers c on c.id = cl.customer_id
  join locations l on l.id = cl.location_id
 where c.phone_raw like '%' || '<PHONE>' || '%'
    or c.phone like '%' || regexp_replace('<PHONE>', '[^0-9]', '', 'g') || '%'
 order by cl.last_visit_at desc;
-- Expect: a row for each location the customer has ordered at. If Loc 2 is
-- missing after a Loc 2 order, the upsert_customer_visit RPC failed.
-- v5.5.5 adds a fallback path that writes customer_locations directly if the
-- RPC errors out, plus diagnostic logging — check the console after redeploy.


-- 4. Check customer_orders — every order the customer has placed.
-- ----------------------------------------------------------------------------

select co.id, co.customer_id, co.location_id, l.name as loc_name,
       co.closed_check_id, co.ordered_at, co.total, co.channel
  from customer_orders co
  join locations l on l.id = co.location_id
 where co.customer_id in (
   select id from customers where phone_raw like '%' || '<PHONE>' || '%'
 )
 order by co.ordered_at desc
 limit 20;
-- Expect: one row per closed_check that was attributed.


-- 5. Check closed_checks for Loc 2 orders — verify customer + customer_phone
-- are stamped on the row, and customer_id was patched in by attribution.
-- ----------------------------------------------------------------------------

select id, ref, customer, customer_phone, customer_id, total, source,
       closed_at, location_id
  from closed_checks
 where location_id = '<LOC_2_ID>'
   and (
     customer_phone like '%' || '<PHONE>' || '%' or
     customer ilike '%peter%roberts%'
   )
 order by closed_at desc
 limit 20;
-- Expect:
--   customer + customer_phone populated → the close path saw the customer name
--   customer_id NULL → attribution did NOT run or failed (most likely cause:
--     kiosk path didn't call attributeOrderToCustomer until v5.5.5, or
--     upsertCustomer silently failed due to RLS / permissions)
--   customer_id populated → attribution ran successfully


-- 6. Sanity: did the kiosk write the order at all?
-- ----------------------------------------------------------------------------

select id, ref, source, kiosk_id, customer, customer_phone, total, closed_at,
       location_id
  from closed_checks
 where source = 'kiosk'
   and location_id = '<LOC_2_ID>'
 order by closed_at desc
 limit 10;
-- Expect: the kiosk's order(s) at Loc 2. If not present, the kiosk
-- closed_checks insert itself failed (look at the kiosk console for [kiosk]
-- closed_checks insert error).


-- 7. RLS permission probe — check what policies are on customers + related.
-- This tells you whether RLS is hiding the rows from your authenticated session.
-- ----------------------------------------------------------------------------

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  from pg_policies
 where tablename in ('customers', 'customer_locations', 'customer_orders')
 order by tablename, policyname;


-- 8. Function probe — confirm upsert_customer_visit exists and is callable.
-- ----------------------------------------------------------------------------

select n.nspname as schema, p.proname as function_name,
       pg_get_function_arguments(p.oid) as arguments,
       p.prosecdef as security_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where p.proname = 'upsert_customer_visit';
-- If zero rows: the RPC doesn't exist. v5.5.5 adds a fallback path that
-- writes customer_locations directly when the RPC errors, so this is no
-- longer fatal — but you'll want to add the migration to get atomic upserts.

-- ============================================================================
-- INTERPRETATION GUIDE
-- ============================================================================
--
-- If query 1 shows different org_ids: that's expected and correct. Customers
-- don't bridge orgs. Each org's customer DB is independent.
--
-- If query 2 shows zero rows after the order completed: the upsertCustomer
-- call failed. Most common causes:
--   - The user couldn't read the customers table (RLS) — the lookup returned
--     null + no error, attribution thought nothing existed and tried to
--     insert, insert failed silently. v5.5.5 logs the lookup error explicitly.
--   - Phone normalisation mismatch — unlikely; _normalisePhone is deterministic.
--
-- If query 2 has a row but query 3 is missing the location: the
-- upsert_customer_visit RPC failed. v5.5.5 adds a fallback that writes
-- customer_locations directly. Reload the app and place a fresh order to
-- confirm.
--
-- If query 5 shows customer + customer_phone but customer_id is NULL: the
-- closed_check was written but attribution didn't run. For kiosk orders
-- pre-v5.5.5, this is expected — the kiosk submit path didn't call
-- attributeOrderToCustomer at all. v5.5.5 fixes this.
-- ============================================================================
