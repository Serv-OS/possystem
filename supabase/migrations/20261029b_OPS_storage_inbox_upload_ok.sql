-- 20261029b_OPS_storage_inbox_upload_ok.sql
-- REPO MIRROR of the storage fix Peter ran on live on 23 Oct 2026
-- (~/.claude/servos-release/hotfix_storage_policy/1_fix_invoice_inbox_upload_policy.sql), byte for byte
-- below this header. It is already live: nothing to run. Running it again changes nothing.
-- There is no rollback file on purpose: putting the old rule back would break every upload again.
-- Drop 3's own file (20261027a) now makes this same rule, so a re-run after the Drop 3 rollback is safe,
-- and Drop 4b (20261030a) refuses to run while any storage rule still calls stock_level().
-- KNOWN SLIP in the text below (kept as it ran): it compares stock_reach_orgs() (text) with a uuid, so an
-- upload into the invoice inbox raises 'operator does not exist: text = uuid'. 20261030a corrects the
-- function (o = v_org::text); the rule and the grants stay as here.
--
-- 1_fix_invoice_inbox_upload_policy.sql
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Peter pastes this in the SQL editor. 23 Oct 2026.
--
-- WHY: Drop 3's storage rule stock_invoice_inbox_files_add (INSERT on storage.objects) calls
-- public.stock_level(), which signed in users may not run. Postgres checks that permission for
-- EVERY file upload, in any bucket, so uploads elsewhere (a menu board logo) failed with
-- "permission denied for function stock_level".
--
-- FIX: the rule calls one small check function that signed in users may run. It does the same
-- three checks as before (org folder, a company the user reaches, Stock control level 'all') and
-- answers false for any other name. Nothing else changes. Safe to run twice.

set lock_timeout = '3s';

do $$ begin
  if to_regclass('public.order_queue') is null or to_regprocedure('public.stock_level(uuid,uuid)') is null then
    raise exception 'This must be run against the OPS DB after Drop 3. Nothing was changed.';
  end if;
end $$;

create or replace function public.stock_invoice_inbox_upload_ok(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_parts text[] := storage.foldername(p_name);
  v_org uuid;
begin
  if v_parts is null or v_parts[1] is distinct from 'org' then return false; end if;
  if v_parts[2] is null or not (v_parts[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return false; end if;
  v_org := v_parts[2]::uuid;
  if not exists (select 1 from public.stock_reach_orgs() o where o = v_org) then return false; end if;
  return coalesce(public.stock_level(auth.uid(), v_org) = 'all', false);
end
$fn$;

revoke all on function public.stock_invoice_inbox_upload_ok(text) from public, anon;
grant execute on function public.stock_invoice_inbox_upload_ok(text) to authenticated;

drop policy if exists stock_invoice_inbox_files_add on storage.objects;
create policy stock_invoice_inbox_files_add on storage.objects
  for insert to authenticated
  with check (bucket_id = 'stock-invoice-inbox' and public.stock_invoice_inbox_upload_ok(name));

-- VISIBLE CHECK. Expected: policy_fixed true, signed_in_can_check true, old_call_gone true.
select
  exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
          and policyname = 'stock_invoice_inbox_files_add'
          and with_check ~ 'stock_invoice_inbox_upload_ok') as policy_fixed,
  has_function_privilege('authenticated', 'public.stock_invoice_inbox_upload_ok(text)', 'execute') as signed_in_can_check,
  not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
          and coalesce(with_check, '') || coalesce(qual, '') ~ 'stock_level') as old_call_gone;
