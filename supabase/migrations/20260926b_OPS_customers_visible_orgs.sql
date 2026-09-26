-- 20260926b (Ops): the customers row security check runs ONCE per statement, not once per row.
--
-- Peter, 26 Sep 2026, the day 8,028 customers were imported at Coffee Boy: Back Office Customers
-- "beyond slow" then "says no customers but there is 8000". The policy customers_venue used
-- customer_org_visible(org_id) with the row's column as the argument, so Postgres called it for
-- every row: 8,028 calls, 7.5 s as a venue owner (pos_can_access per venue per row), over the
-- API's 8 s statement_timeout, so the read failed. Measured with EXPLAIN ANALYZE as the owner.
--
-- Same rule, set form: the orgs a caller may see are computed once (an uncorrelated subselect
-- becomes a hashed InitPlan) and each row is a hash lookup. Super admins see every org, as
-- before; a venue login sees the orgs of the venues it can access (pos_can_access), as before;
-- a null org_id is never visible, as before. Nothing about WHO may see WHAT changes.
--
-- Rollback (if anything looks wrong): the old policy is recreated at the bottom, commented.

create or replace function public.visible_customer_orgs()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select l.org_id
    from public.locations l
   where l.org_id is not null
     and (public.is_super_admin() or public.pos_can_access(l.id::text))
   group by l.org_id
$$;

revoke all on function public.visible_customer_orgs() from public;
grant execute on function public.visible_customer_orgs() to authenticated, service_role;

drop policy if exists customers_venue on public.customers;
create policy customers_venue on public.customers
  for all to authenticated
  using (org_id in (select public.visible_customer_orgs()))
  with check (org_id in (select public.visible_customer_orgs()));

-- Newest first without touching every row (the list and the import both order this way).
create index if not exists customers_org_updated_idx on public.customers (org_id, updated_at desc);

-- Check (as any venue owner, should be milliseconds now):
--   explain analyze select id from customers where org_id = '<org>' and deleted_at is null order by updated_at desc limit 1000;
--
-- ROLLBACK:
-- drop policy if exists customers_venue on public.customers;
-- create policy customers_venue on public.customers for all to authenticated
--   using (customer_org_visible(org_id)) with check (customer_org_visible(org_id));
