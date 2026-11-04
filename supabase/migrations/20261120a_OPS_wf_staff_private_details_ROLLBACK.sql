-- ROLLBACK for 20261120a_OPS_wf_staff_private_details.sql. Puts back the table read of every wf_staff
-- column for anon and authenticated (as before), the 20261111a wf_staff_regrant_api, and removes the
-- door, the tick and its guard. ASCII only.
begin;
set local lock_timeout = '3s';
grant select on table public.wf_staff to anon, authenticated;
create or replace function public.wf_staff_regrant_api()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_cols text;
  v_n integer;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position), count(*)
    into v_cols, v_n
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'wf_staff'
     and c.column_name not in ('portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires', 'person_id');
  if v_n is null or v_n = 0 then
    raise exception 'wf_staff has no columns to grant';
  end if;
  execute format('grant insert (%s), update (%s) on table public.wf_staff to authenticated', v_cols, v_cols);
  return v_n;
end
$f$;
revoke all on function public.wf_staff_regrant_api() from public, anon, authenticated, service_role;
drop function if exists public.wf_staff_private_details(uuid[]);
drop function if exists public.wf_staff_regrant_select();
drop function if exists public.wf_can_see_payroll_details(uuid);
drop function if exists public.set_payroll_details(uuid, boolean);
drop trigger if exists user_profiles_payroll_details_guard on public.user_profiles;
drop function if exists public.user_profiles_payroll_details_guard();
alter table public.user_profiles drop column if exists payroll_details;
notify pgrst, 'reload schema';
commit;
