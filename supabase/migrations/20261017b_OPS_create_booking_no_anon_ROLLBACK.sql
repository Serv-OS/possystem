-- 20261017b_OPS_create_booking_no_anon_ROLLBACK.sql
--
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Only if a booking is refused with "permission denied for
-- function create_booking" after 20261017b. Gives anon back exactly what 20261016e granted.

begin;

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
end
$guard$;

do $grants$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking'
  loop
    execute format('grant execute on function %s to anon, authenticated, service_role', r.sig);
  end loop;
end
$grants$;

commit;

notify pgrst, 'reload schema';

-- Expected: anon_can_call 1
select (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking'
          and has_function_privilege('anon', p.oid, 'execute')) as anon_can_call;
