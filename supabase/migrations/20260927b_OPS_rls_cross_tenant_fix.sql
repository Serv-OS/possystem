-- 20260927b (Ops): close the cross company hole on 3 stock tables, and make the booking_payments
-- device read require a PAIRED device.
-- Project tbetcegmszzotrwdtqhi. Drafted 27 Sep 2026 from the LIVE policy text (pg_policies).
-- Peter runs this; Claude cannot run DDL on production.
--
-- WHY
--   item_cost_history.item_cost_history_rls, stock_count_lines.stock_count_lines_rls and
--   supplier_invoice_lines.supplier_invoice_lines_rls are FOR ALL with USING = WITH CHECK =
--       (location_id IN ( SELECT <this table>.location_id
--                           FROM user_accessible_locations() user_accessible_locations(user_accessible_locations)))
--   - Root cause: 20260621d (stock foundation) wrote "select location_id from user_accessible_locations()".
--     That function returns ONE text column called user_accessible_locations. It has no location_id,
--     so Postgres took location_id from the OUTER row: the subquery compares the row with itself.
--   - Result: true for EVERY row as soon as the login has at least one venue. Any venue login
--     reads, edits, deletes and inserts cost history, stock count lines and invoice lines of
--     EVERY company.
--   booking_payments "paired device read" (SELECT) is
--       EXISTS (SELECT 1 FROM devices d WHERE d.device_uid = auth.uid() AND d.location_id = booking_payments.location_id)
--   - No bound_via or status check, so an unpaired or revoked device row that still carries the
--     tablet's session id keeps reading that venue's booking payments.
--
-- PROOF (read live 27 Sep 2026, SQL as the authenticated role with that login's claims, rolled back)
--   - mike (Coffee Boy owner, 6 venues, none of them with stock rows) sees all 23 item_cost_history
--     rows (Provo 20, Wing Fest Birmingham 3) and all 8 stock_count_lines (Provo 6, Birmingham 2).
--   - Wing Fest Birmingham owner (a2594a65...) sees Provo's 20 cost rows; the Provo manager
--     (4ef6fcd5...) sees Birmingham's 3.
--   - Self test over all 14 venue logins: 11 of them see rows at a venue they cannot access.
--   - Writes: for any login with one venue the old WITH CHECK accepts a row at all 13 venues.
--   - supplier_invoice_lines has 0 rows today; same bug, so it would leak the first invoice.
--   - booking_payments: no device row with a session id is unpaired or revoked today (the unpair
--     flow clears device_uid), so this one is latent. With a simulated revoked row at Provo the
--     old rule reads all 8 Provo payments, the new rule 0.
--
-- WHO USES THESE TABLES (every caller keeps working)
--   - Back Office users at the venue (the only real users of the 3 stock tables):
--       src/lib/stock/counts.js      stock_count_lines   (Stock counts screen)
--       src/lib/stock/data.js        item_cost_history   (recomputeItemCost: Stock items, Recipes)
--       src/lib/stock/recipes.js     item_cost_history   (recomputeMadeItemCost)
--       src/lib/stock/purchasing.js  item_cost_history, supplier_invoice_lines (receive PO, post invoice)
--       src/backoffice/sections/PriceChanges.jsx  reads item_cost_history
--     user_accessible_locations() covers them: user_locations, the owner of the company, super admin.
--   - Ops module (?mode=ops) delivery accept calls receivePurchaseOrder, which writes
--     item_cost_history. As a signed in manager: covered as above. As an anonymous ops tablet it
--     never gets that far: purchase_orders and po_lines are user only, so it stops at "No lines",
--     and user_accessible_locations() is empty for anonymous sessions. Devices had NO working
--     access to these 3 tables before and have none after (proven: tills and the Provo ops
--     tablet see 0 before and 0 after). Mirroring pos_can_access would have GIVEN tills write
--     access to cost history, so this uses user_accessible_locations() only, like the parent
--     tables (stock_counts, supplier_invoices, purchase_orders, po_lines, inventory_items writes).
--   - supabase/functions/xero-bills reads supplier_invoice_lines with the service role key:
--     bypasses RLS, unaffected.
--   - No trigger, view or database function reads or writes the 3 stock tables.
--   - booking_payments: tills (anonymous, paired: bound_via set, status active or online) read it
--     through "paired device read" (bookingsData.js loadBookings / loadBookingCredit, the seat a
--     booking credit on the till); host stands through "host stand read"; Back Office through
--     "bo read". booking-widget and adyen-webhook write it as the service role;
--     apply_booking_payment and bookings_payment_gate are SECURITY DEFINER. All unchanged except
--     that an unpaired device row no longer reads. Every Provo till is bound and active or online.
--
-- WHAT CHANGES (same policy names, commands, roles, permissive; second_step_fence untouched)
--   - The 3 stock policies, USING and WITH CHECK:
--       ((location_id)::text in (select public.user_accessible_locations()))
--     Byte for byte the rule on the parent tables (stock_counts_rls, supplier_invoices_rls) and on
--     booking_payments "bo read". Set form: an UNCORRELATED subselect, so the function runs once per
--     statement and each row is a hashed lookup (EXPLAIN: HashAggregate over one ProjectSet).
--   - booking_payments "paired device read":
--       (location_id in (select d.location_id from public.devices d
--                         where d.device_uid = (select auth.uid()) and d.bound_via is not null
--                           and d.status in ('active', 'online') and d.location_id is not null))
--     The same device rule as pos_can_access, in the same set form as 20260927a.
--   Before and after, per login (rows seen: item_cost_history / stock_count_lines):
--       super admin 23/8 -> 23/8        Provo manager 23/8 -> 20/6      Provo org owner 23/8 -> 20/6
--       Provo owner who also holds Birmingham 23/8 -> 23/8               neil (holds Provo) 23/8 -> 20/6
--       Wing Fest Birmingham owner 23/8 -> 3/2    mike 23/8 -> 0/0      duncan 23/8 -> 0/0
--       Provo tills, Provo ops tablet, anon key 0/0 -> 0/0
--       booking_payments: identical for every login today (tills 8 -> 8).
--   No login gains a row anywhere (new but not old = 0 for every login and table).
--
-- DOES NOT DEPEND ON 20260927a. It uses only user_accessible_locations() and devices, both live.
--
-- ORDER WITH 20260927a (READ THIS)
--   - 20260927a -> 20260927b: fine. This file accepts 20260927a's version of "paired device read".
--   - 20260927b -> 20260927a: 20260927a's GUARD stops ("policies differ from 26 Sep:
--     booking_payments.paired device read") and applies nothing, because it pins the old text.
--     Fix in 20260927a before running it: delete its guard row ('booking_payments', 'paired device
--     read', 'b9328c1833183616dae8cc914b41a101') and its drop/create "paired device read" block.
--   - 20260927a_OPS_rls_set_form_ROLLBACK.sql also recreates the OLD unpaired "paired device read".
--     If it is ever run after this file, run this file again afterwards (it is safe to run twice),
--     or delete that block from the 20260927a rollback too.
--
-- SAFETY
--   - One transaction. The GUARD first checks it is the Ops database, that
--     user_accessible_locations() is the text set function this relies on, that these 4 tables have
--     no policy other than the known ones, and that each policy is still the 26 Sep text (or
--     20260927a's version, or this fix already applied). Anything else: it stops, NOTHING changes.
--   - lock_timeout 3 s: if a table is busy it stops and NOTHING changes (just run it again). Run it
--     outside service: booking_payments is read by tills when a booking is seated.
--     04:00 to 06:00 UK is 20:00 to 22:00 in California the evening before.
--   - POST CHECK (undoes everything on failure):
--       1) the 3 stock policies are no longer self referencing and USING = WITH CHECK;
--          "paired device read" checks bound_via and status and is uncorrelated;
--       2) SELF TEST as every venue login (user_locations and company owners): each sees exactly
--          the rows at its own venues and nothing at anyone else's;
--       3) SELF TEST as every paired till: it still sees the booking payments it saw before
--          (catches a till locked out by the devices table's own RLS).
--   - Rollback: 20260927b_rollback.sql restores the 26 Sep text exactly. It REOPENS the hole: use it
--     only if a real caller breaks, then fix forward.
--
-- VERIFY AFTER RUNNING (paste each block into the SQL editor)
--   1) The text. Expect the 3 stock rows to read
--        ((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))
--      in both columns, and "paired device read" to mention bound_via and status:
--        select tablename, policyname, cmd, qual, with_check from pg_policies
--         where schemaname = 'public'
--           and tablename in ('item_cost_history', 'stock_count_lines', 'supplier_invoice_lines', 'booking_payments')
--         order by 1, 2;
--   2) The hole is closed. As mike, expect 0 and 0 (it was 23 and 8):
--        begin;
--        set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"c86a1c29-e582-4ccf-a9c1-fbfa0cb918b2","role":"authenticated","aal":"aal2"}', true);
--        select (select count(*) from public.item_cost_history) as cost_rows,
--               (select count(*) from public.stock_count_lines) as count_lines;
--        rollback;
--   3) The venue still works. As the Provo manager, expect 20 and 6:
--        begin;
--        set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"4ef6fcd5-03fc-471e-ba92-0453549de878","role":"authenticated","aal":"aal2"}', true);
--        select (select count(*) from public.item_cost_history) as cost_rows,
--               (select count(*) from public.stock_count_lines) as count_lines;
--        rollback;
--   4) A Provo till still reads its booking payments. Expect 8:
--        begin;
--        set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"706437ac-62c1-48c9-9419-0a79381a8550","role":"authenticated","is_anonymous":true}', true);
--        select count(*) from public.booking_payments;
--        rollback;
--   5) In the app: Back Office > Stock > Price changes at Provo shows its cost history, and a stock
--      count at Provo opens with its lines.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '120s';
set local search_path = public;

-- ============================================================ guard

do $guard$
declare
  v_bad text;
begin
  -- Ops has user_locations and no billing_state; Platform is the other way round.
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception '20260927b stopped, nothing changed: this is not the OPS database (tbetcegmszzotrwdtqhi).';
  end if;

  -- The rule below relies on user_accessible_locations() returning a set of text.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'user_accessible_locations'
       and p.pronargs = 0 and p.proretset and p.prorettype = 'text'::regtype) then
    raise exception '20260927b stopped, nothing changed: public.user_accessible_locations() is missing or no longer returns setof text.';
  end if;

  -- No policy on these 4 tables other than the known ones (an extra permissive policy would
  -- keep the hole open behind this fix).
  select string_agg(p.tablename || '.' || p.policyname, ', ' order by p.tablename, p.policyname) into v_bad
    from pg_policies p
   where p.schemaname = 'public'
     and p.tablename in ('item_cost_history', 'stock_count_lines', 'supplier_invoice_lines', 'booking_payments')
     and (p.tablename, p.policyname) not in (
       ('item_cost_history', 'item_cost_history_rls'),
       ('item_cost_history', 'second_step_fence'),
       ('stock_count_lines', 'stock_count_lines_rls'),
       ('stock_count_lines', 'second_step_fence'),
       ('supplier_invoice_lines', 'supplier_invoice_lines_rls'),
       ('supplier_invoice_lines', 'second_step_fence'),
       ('booking_payments', 'bo read'),
       ('booking_payments', 'host stand read'),
       ('booking_payments', 'paired device read'),
       ('booking_payments', 'second_step_fence'));
  if v_bad is not null then
    raise exception '20260927b stopped, nothing changed: unexpected policies: %', v_bad;
  end if;

  -- Each policy this file replaces must be the 26 Sep text, or already this fix (re-run).
  -- sig = md5(permissive|roles|cmd|qual|with_check), the same signature 20260927a uses.
  select string_agg(m.tbl || '.' || m.pol, ', ' order by m.tbl) into v_bad
    from (values
      ('item_cost_history',      'item_cost_history_rls',      '0e6791962251766b358a4a879e7dd580'),
      ('stock_count_lines',      'stock_count_lines_rls',      '4c67e6e4bc410814cf95f22a93ecce84'),
      ('supplier_invoice_lines', 'supplier_invoice_lines_rls', '491c944f2a19db16d477cc461fa04fc2')
    ) as m(tbl, pol, sig)
    left join pg_policies p
      on p.schemaname = 'public' and p.tablename = m.tbl and p.policyname = m.pol
   where p.policyname is null
      or not (
           md5(concat_ws('|', p.permissive, p.roles::text, p.cmd,
                         coalesce(p.qual, '-'), coalesce(p.with_check, '-'))) = m.sig
        or (p.cmd = 'ALL' and p.permissive = 'PERMISSIVE' and p.roles::text = '{public}'
            and p.qual = p.with_check
            and p.qual like '%user_accessible_locations()%'
            and p.qual not like '%' || m.tbl || '.location_id%'));
  if v_bad is not null then
    raise exception '20260927b stopped, nothing changed: these policies differ from 26 Sep: %', v_bad;
  end if;

  -- "paired device read": the 26 Sep text, 20260927a's text (auth.uid() wrapped in a select),
  -- or this fix already applied.
  if not exists (
    select 1 from pg_policies p
     where p.schemaname = 'public' and p.tablename = 'booking_payments' and p.policyname = 'paired device read'
       and (
             md5(concat_ws('|', p.permissive, p.roles::text, p.cmd,
                           replace(coalesce(p.qual, '-'), '( SELECT auth.uid() AS uid)', 'auth.uid()'),
                           coalesce(p.with_check, '-'))) = 'b9328c1833183616dae8cc914b41a101'
          or (p.cmd = 'SELECT' and p.permissive = 'PERMISSIVE' and p.roles::text = '{public}'
              and p.qual like '%bound_via IS NOT NULL%'
              and p.qual not like '%booking_payments.location_id%'))) then
    raise exception '20260927b stopped, nothing changed: booking_payments."paired device read" differs from 26 Sep.';
  end if;
end
$guard$;

-- ============================================================ policies
-- Same lock order every time: booking_payments, item_cost_history, stock_count_lines, supplier_invoice_lines.

-- booking_payments: a device reads only while it is PAIRED (bound, active or online), like pos_can_access.
drop policy if exists "paired device read" on public.booking_payments;
create policy "paired device read" on public.booking_payments
  as permissive
  for select
  to public
  using ((location_id in (
    select d.location_id
      from public.devices d
     where d.device_uid = (select auth.uid())
       and d.bound_via is not null
       and d.status in ('active', 'online')
       and d.location_id is not null)));

-- item_cost_history: the caller's own venues only.
drop policy if exists item_cost_history_rls on public.item_cost_history;
create policy item_cost_history_rls on public.item_cost_history
  as permissive
  for all
  to public
  using (((location_id)::text in (select public.user_accessible_locations())))
  with check (((location_id)::text in (select public.user_accessible_locations())));

-- stock_count_lines: the caller's own venues only.
drop policy if exists stock_count_lines_rls on public.stock_count_lines;
create policy stock_count_lines_rls on public.stock_count_lines
  as permissive
  for all
  to public
  using (((location_id)::text in (select public.user_accessible_locations())))
  with check (((location_id)::text in (select public.user_accessible_locations())));

-- supplier_invoice_lines: the caller's own venues only.
drop policy if exists supplier_invoice_lines_rls on public.supplier_invoice_lines;
create policy supplier_invoice_lines_rls on public.supplier_invoice_lines
  as permissive
  for all
  to public
  using (((location_id)::text in (select public.user_accessible_locations())))
  with check (((location_id)::text in (select public.user_accessible_locations())));

-- ============================================================ post check

-- 1) Shape: nothing self referencing, USING = WITH CHECK, device rule present and uncorrelated.
do $post$
declare
  v_bad text;
begin
  select string_agg(m.tbl || '.' || m.pol, ', ') into v_bad
    from (values
      ('item_cost_history',      'item_cost_history_rls'),
      ('stock_count_lines',      'stock_count_lines_rls'),
      ('supplier_invoice_lines', 'supplier_invoice_lines_rls')
    ) as m(tbl, pol)
    left join pg_policies p
      on p.schemaname = 'public' and p.tablename = m.tbl and p.policyname = m.pol
   where p.policyname is null
      or p.cmd <> 'ALL' or p.permissive <> 'PERMISSIVE' or p.roles::text <> '{public}'
      or p.qual is distinct from p.with_check
      or p.qual not like '%user_accessible_locations()%'
      or p.qual like '%' || m.tbl || '.location_id%';
  if v_bad is not null then
    raise exception '20260927b: wrong shape after the rewrite: %', v_bad;
  end if;

  if not exists (
    select 1 from pg_policies p
     where p.schemaname = 'public' and p.tablename = 'booking_payments' and p.policyname = 'paired device read'
       and p.cmd = 'SELECT' and p.permissive = 'PERMISSIVE' and p.roles::text = '{public}'
       and p.qual like '%bound_via IS NOT NULL%'
       and p.qual like '%status%active%online%'
       and p.qual not like '%booking_payments.location_id%'
       and replace(p.qual, '( SELECT auth.uid() AS uid)', '') not like '%auth.uid()%') then
    raise exception '20260927b: booking_payments."paired device read" has the wrong shape after the rewrite.';
  end if;
end
$post$;

-- 2) and 3) Behaviour, as the real logins. Runs as the authenticated role inside this
-- transaction, then returns to the running role. Any mismatch undoes everything.
do $selftest$
declare
  v_uid     uuid;
  v_anon    boolean;
  v_tbl     text;
  v_expect  bigint;
  v_seen    bigint;
  v_foreign bigint;
  v_bad     text := '';
begin
  -- 2) every venue login: exactly the rows at its own venues, none elsewhere.
  for v_uid in
    select ul.user_id from public.user_locations ul where ul.user_id is not null
    union
    select p.id from public.user_profiles p where p.role = 'owner' and p.org_id is not null
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    foreach v_tbl in array array['item_cost_history', 'stock_count_lines', 'supplier_invoice_lines'] loop
      execute format('select count(*) from public.%I t where (t.location_id)::text in (select public.user_accessible_locations())', v_tbl)
        into v_expect;
      execute 'set local role authenticated';
      execute format('select count(*), count(*) filter (where not coalesce((t.location_id)::text in (select public.user_accessible_locations()), false)) from public.%I t', v_tbl)
        into v_seen, v_foreign;
      execute 'reset role';
      if v_foreign > 0 or v_seen <> v_expect then
        v_bad := v_bad || format(' %s %s: sees %s, at own venues %s, elsewhere %s;', v_uid, v_tbl, v_seen, v_expect, v_foreign);
      end if;
    end loop;
  end loop;

  -- 3) every paired till (bound, active or online): still reads every booking payment it may
  -- (its paired venue, plus any Back Office or host stand access the same session holds).
  for v_uid, v_anon in
    select distinct d.device_uid, coalesce(u.is_anonymous, false)
      from public.devices d
      left join auth.users u on u.id = d.device_uid
     where d.device_uid is not null and d.bound_via is not null
       and d.status in ('active', 'online') and d.location_id is not null
  loop
    perform set_config('request.jwt.claims',
      case when v_anon
           then json_build_object('sub', v_uid, 'role', 'authenticated', 'is_anonymous', true)::text
           else json_build_object('sub', v_uid, 'role', 'authenticated', 'aal', 'aal2')::text end, true);
    select count(*) into v_expect
      from public.booking_payments t
     where t.location_id in (select d.location_id from public.devices d
                              where d.device_uid = v_uid and d.bound_via is not null
                                and d.status in ('active', 'online') and d.location_id is not null)
        or (t.location_id)::text in (select public.user_accessible_locations())
        or public.waitlist_can_write(t.location_id);
    execute 'set local role authenticated';
    select count(*) into v_seen from public.booking_payments;
    execute 'reset role';
    if v_seen <> v_expect then
      v_bad := v_bad || format(' till %s booking_payments: sees %s, should see %s;', v_uid, v_seen, v_expect);
    end if;
  end loop;

  perform set_config('request.jwt.claims', '', true);
  if v_bad <> '' then
    raise exception '20260927b self test failed, nothing changed:%', v_bad;
  end if;
end
$selftest$;

commit;
