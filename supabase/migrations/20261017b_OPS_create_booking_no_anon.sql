-- 20261017b_OPS_create_booking_no_anon.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  RUN 20261016e_OPS_booking_service_periods.sql FIRST (it is live).        #
-- #  Safe to run twice. One transaction. Any time, in service too: it only    #
-- #  changes who may call create_booking; the function itself is untouched.   #
-- ############################################################################
--
-- WHY (PR 295 follow up, 17 Oct 2026; bookings audit item 7)
--   create_booking is SECURITY DEFINER and could be called with the bare public (anon) key, which
--   ships inside every web page. So its online only rules (notice, days ahead, the pacing cap the
--   booking page keeps) were not a hard boundary: anyone could call it directly as source 'host'.
--
-- WHO CALLS IT (checked 17 Oct 2026 in the code on main, v5.11.71)
--   * booking-widget (the public booking page and the guest's change page): the SERVICE ROLE.
--     The page itself never calls the database (BookingWidget.jsx talks only to the function).
--   * booking-host request_accept (the requests inbox): the SERVICE ROLE.
--   * The host stand, the till and Back Office (bookingsData.js createBookingAtomic): a signed in
--     session, role authenticated. Tills, kiosks and stands sign in anonymously when they pair
--     (an anonymous sign in is role authenticated, not anon), Back Office with a real login.
--     v5.11.73 also makes sure of a session right before the call (ensureAuthToken).
--   * No SQL function calls it, and nothing calls it with the bare public key.
--   So only anon loses it. authenticated and service_role keep it.
--
-- WHAT IT DOES NOT DO
--   It does not change what a signed in session may book (a fence on the venue is a separate,
--   careful release with the bookings table lock down). It does not touch edit_booking.
--
-- UNDO: 20261017b_OPS_create_booking_no_anon_ROLLBACK.sql

begin;

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking') then
    raise exception 'create_booking is not there. Nothing was changed.';
  end if;
end
$guard$;

-- By the function's own id, whatever its argument list is (16 arguments since 20261016b).
do $grants$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking'
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end
$grants$;

commit;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   create_booking_functions 1, anon_can_call 0, public_can_call 0, signed_in_can_call 1, service_role_can_call 1
select
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking') as create_booking_functions,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking'
     and has_function_privilege('anon', p.oid, 'execute')) as anon_can_call,
  (select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking'
      and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_call,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking'
     and has_function_privilege('authenticated', p.oid, 'execute')) as signed_in_can_call,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking'
     and has_function_privilege('service_role', p.oid, 'execute')) as service_role_can_call;
