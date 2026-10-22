-- live_discounts.sql: public.discounts as Ops has it (read only from pg_policies and pg_class, 20 Oct
-- 2026), so the drainer proof can show a Back Office login writing discounts.kind under the live rules.
-- Applied only by the drainer sections (drainer.mjs), after 0a and its revalue file.
--
-- Live: RLS on; ACL postgres=arwdDxtm, anon=arwdm, authenticated=arwdm, service_role=arwdDxtm;
-- policies "Allow authenticated access" (PERMISSIVE, ALL, TO public, using auth.role() =
-- 'authenticated') and second_step_fence (RESTRICTIVE, ALL, TO authenticated, using and with check
-- (select second_step_ok())).

-- auth.role() as Supabase has it (the role claim of the request)
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
grant execute on function auth.role() to anon, authenticated, service_role;

alter table public.discounts enable row level security;
revoke all on table public.discounts from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.discounts to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger on table public.discounts to service_role;
create policy "Allow authenticated access" on public.discounts as permissive for all to public
  using (auth.role() = 'authenticated');
create policy second_step_fence on public.discounts as restrictive for all to authenticated
  using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
