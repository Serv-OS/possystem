-- 20260721d_handle_new_user_no_client_role.sql
--
-- SECURITY (critical): privilege escalation at row creation, bypassing RLS entirely.
--
-- public.handle_new_user() is SECURITY DEFINER and ran:
--
--     coalesce(new.raw_user_meta_data->>'role', 'owner')
--
-- raw_user_meta_data is CLIENT-SUPPLIED at sign-up. Anonymous sign-ins are enabled
-- (kiosk / online / QR all call supabase.auth.signInAnonymously() -- see
-- src/lib/supabase.js:122, src/surfaces/qr/QrCheckout.jsx:264,
-- src/surfaces/online/OnlineCheckout.jsx:321), so ANY member of the public could call
--
--     signInAnonymously({ options: { data: { role: 'super_admin' } } })
--
-- and be minted a super_admin. public.is_super_admin() reads exactly that column, and
-- essentially every RLS policy in this database is "pos_can_access(...) or is_super_admin()".
--
-- Because the escalation happens INSIDE a SECURITY DEFINER trigger at INSERT time, no RLS
-- policy could ever have caught it. Tightening user_profiles' policies alone does NOT fix this.
--
-- FIX: the role is now a server-side literal. It can never come from the client.
--
-- WHY THIS IS SAFE (verified against the live DB before writing, 21 Jul 2026):
--   * 'owner' was ALREADY the effective default for every legitimate sign-up, so behaviour
--     for real users is unchanged.
--   * There is NO check constraint on user_profiles.role, so no value can be rejected.
--   * NO RLS policy anywhere references 'owner' (queried pg_policies) -- the only database
--     object that mentioned it was this function. So 'owner' grants nothing by itself;
--     'super_admin' was the dangerous value and it is now unreachable from the client.
--   * NO client code inserts or upserts user_profiles (grepped src/) -- provisioning happens
--     server-side in the create-user edge function using the service role, which bypasses RLS
--     and sets the real role afterwards. So nothing legitimate needed the metadata passthrough.
--   * The rest of the body is preserved byte-for-byte from the live definition.
--
-- Also adds SET search_path -- a SECURITY DEFINER function without one is a search-path
-- injection risk. Everything referenced is schema-qualified, so this changes no behaviour.
--
-- FORENSICS at time of writing: 1 super_admin (non-anonymous, the owner), 0 anonymous users
-- holding user_locations rows. No evidence this was ever exploited.
--
-- NOT FIXED HERE (deliberately): the always-true RLS policies on user_profiles and
-- user_locations. Those need three coordinated client changes shipped in the same release
-- (CompanyAdmin.jsx, StaffManager.jsx), two of which fail SILENTLY if the SQL lands first.
-- This migration is the part that is safe to ship alone.
--
-- ROLLBACK: see 20260721d_rollback below the commit.

begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
  begin
    insert into public.user_profiles (id, email, full_name, role, bo_access)
    values (new.id, new.email,
            coalesce(new.raw_user_meta_data->>'full_name', new.email),
            'owner',  -- SERVER-SIDE LITERAL. Never from raw_user_meta_data.
            case when new.is_anonymous then false else true end)
    on conflict (id) do update set email = coalesce(public.user_profiles.email, excluded.email);
    return new;
  end;
$function$;

commit;

-- ── ROLLBACK (restores the vulnerable definition -- do not run without reason) ──
-- begin;
-- create or replace function public.handle_new_user()
-- returns trigger language plpgsql security definer
-- as $function$
--   begin
--     insert into public.user_profiles (id, email, full_name, role, bo_access)
--     values (new.id, new.email,
--             coalesce(new.raw_user_meta_data->>'full_name', new.email),
--             coalesce(new.raw_user_meta_data->>'role','owner'),
--             case when new.is_anonymous then false else true end)
--     on conflict (id) do update set email = coalesce(public.user_profiles.email, excluded.email);
--     return new;
--   end;
-- $function$;
-- commit;
