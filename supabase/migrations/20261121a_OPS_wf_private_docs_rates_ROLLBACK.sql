-- ROLLBACK for 20261121a_OPS_wf_private_docs_rates.sql. Puts back the 20261120a storage rule (any login
-- of the venue opens any file), the 20261120a re grant (rate_override readable again), and removes the
-- rates door and the two helpers. ASCII only.
begin;
set local lock_timeout = '3s';

drop policy if exists wf_docs_select on storage.objects;
create policy wf_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'wf-documents' and (storage.foldername(objects.name))[1] in (select public.user_accessible_locations()));

create or replace function public.wf_staff_regrant_select()
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
     and c.column_name not in ('ni_number', 'ssn_last4', 'tax_ref', 'bank_sort_code', 'bank_account', 'bank_account_name');
  if v_n is null or v_n = 0 then
    raise exception 'wf_staff has no columns to grant';
  end if;
  revoke select on table public.wf_staff from anon, authenticated;
  execute format('grant select (%s) on table public.wf_staff to anon, authenticated', v_cols);
  return v_n;
end
$f$;
revoke all on function public.wf_staff_regrant_select() from public, anon, authenticated, service_role;
select public.wf_staff_regrant_select();

drop function if exists public.wf_staff_rates(uuid);
drop function if exists public.wf_is_identity_doc(text);
drop function if exists public.wf_can_see_payroll_details_at(text);
notify pgrst, 'reload schema';
commit;
