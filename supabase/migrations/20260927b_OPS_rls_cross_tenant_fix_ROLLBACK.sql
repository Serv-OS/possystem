-- ROLLBACK for 20260927b_OPS_rls_cross_tenant_fix.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- WARNING: this REOPENS the hole. After it runs, any venue login can again read and write every
-- company's item_cost_history, stock_count_lines and supplier_invoice_lines, and an unpaired
-- device row can again read booking_payments. Use it only if a real caller broke, then fix forward.
--
-- Restores the 4 policies to the exact text read live from pg_policies on 27 Sep 2026 (same
-- names, commands, roles, permissive). With search_path = public the text comes back byte for
-- byte, so the 26 Sep signatures match again and 20260927a's guard still accepts
-- "paired device read" if 20260927a has not been run yet.
-- If 20260927a WAS run before 20260927b, this puts back the 26 Sep "paired device read" rather
-- than 20260927a's version: who can read is the same, it only checks auth.uid() per row
-- (booking_payments has 8 rows).
-- One transaction; safe to run twice. second_step_fence is not touched.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '120s';
set local search_path = public;

-- booking_payments
drop policy if exists "paired device read" on public.booking_payments;
create policy "paired device read" on public.booking_payments
  as permissive
  for select
  to public
  using ((EXISTS ( SELECT 1
   FROM devices d
  WHERE ((d.device_uid = auth.uid()) AND (d.location_id = booking_payments.location_id)))));

-- item_cost_history
drop policy if exists item_cost_history_rls on public.item_cost_history;
create policy item_cost_history_rls on public.item_cost_history
  as permissive
  for all
  to public
  using ((location_id IN ( SELECT item_cost_history.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))))
  with check ((location_id IN ( SELECT item_cost_history.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))));

-- stock_count_lines
drop policy if exists stock_count_lines_rls on public.stock_count_lines;
create policy stock_count_lines_rls on public.stock_count_lines
  as permissive
  for all
  to public
  using ((location_id IN ( SELECT stock_count_lines.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))))
  with check ((location_id IN ( SELECT stock_count_lines.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))));

-- supplier_invoice_lines
drop policy if exists supplier_invoice_lines_rls on public.supplier_invoice_lines;
create policy supplier_invoice_lines_rls on public.supplier_invoice_lines
  as permissive
  for all
  to public
  using ((location_id IN ( SELECT supplier_invoice_lines.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))))
  with check ((location_id IN ( SELECT supplier_invoice_lines.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))));

commit;

-- VERIFY: expect 4 rows, each with back_to_26_sep = true. (Not a blocking check on purpose: a
-- rollback must never be stopped by a whitespace difference. If one says false, compare its
-- qual with the text above; who can read and write is what matters.)
--   select p.tablename, p.policyname,
--          md5(concat_ws('|', p.permissive, p.roles::text, p.cmd, coalesce(p.qual, '-'), coalesce(p.with_check, '-')))
--            = case p.policyname
--                when 'paired device read'         then 'b9328c1833183616dae8cc914b41a101'
--                when 'item_cost_history_rls'      then '0e6791962251766b358a4a879e7dd580'
--                when 'stock_count_lines_rls'      then '4c67e6e4bc410814cf95f22a93ecce84'
--                when 'supplier_invoice_lines_rls' then '491c944f2a19db16d477cc461fa04fc2'
--              end as back_to_26_sep
--     from pg_policies p
--    where p.schemaname = 'public'
--      and p.policyname in ('paired device read', 'item_cost_history_rls', 'stock_count_lines_rls', 'supplier_invoice_lines_rls')
--    order by 1, 2;
--   (run it with search_path including public, as the SQL editor does)
