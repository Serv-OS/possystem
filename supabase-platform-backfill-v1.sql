-- ═══════════════════════════════════════════════════════════════════════════
-- Platform DB backfill from Ops DB
-- Run on: yhzjgyrkyjabvhblqxzu (RPOS Platform)
--
-- Brings Platform DB into sync with reality from Ops DB (tbetcegmszzotrwdtqhi):
--   Ops orgs (3)                  → Platform companies        (currently 1)
--   Ops locations (4)             → Platform locations        (currently 1)
--   Ops user_profiles (active)    → Platform user_company_roles + user_access
--   ALL active locations          → Platform billing_state    (so GMV bumps land)
--
-- ID strategy:
--   - Existing Platform "POSUP Test" company keeps its UUID a1b2c3d4-0001-...
--     (already mapped to Ops org a59a6d97-...). Don't disturb.
--   - Existing Platform "Location 1" keeps its UUID a1b2c3d4-0002-...
--     (already mapped to Ops loc 7218c716-... via ops_location_id).
--   - NEW companies/locations use the Ops DB UUIDs as Platform DB UUIDs
--     (clean 1:1 going forward). For these new locations,
--     locations.id = locations.ops_location_id.
--
-- Idempotent: re-running is safe — every insert uses ON CONFLICT DO NOTHING.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Companies ─────────────────────────────────────────────────────────
insert into companies (id, name, slug, plan, created_at) values
  ('523d842a-053e-4e9d-92ef-09b59508cbc0'::uuid, 'Doboy Donuts',     'doboy-donuts',     'free', now()),
  ('a209442b-3617-42e1-92ab-25c27d25ab00'::uuid, 'DX Test Location', 'dx-test-location', 'free', now())
on conflict (id) do nothing;

-- ── 2. Locations ─────────────────────────────────────────────────────────
-- Each new location: id = ops_location_id. Each points back to Ops DB.
insert into locations (id, company_id, name, ops_db_url, ops_location_id, timezone, created_at) values
  -- Doboy Donuts → Leeds
  ('aa7835ea-9798-4d38-8e69-e0186ae523ea'::uuid,
   '523d842a-053e-4e9d-92ef-09b59508cbc0'::uuid,
   'Leeds', 'https://tbetcegmszzotrwdtqhi.supabase.co',
   'aa7835ea-9798-4d38-8e69-e0186ae523ea'::uuid, 'Europe/London', now()),
  -- DX Test Location → Huddersfield
  ('5d9864db-e627-42bc-90af-d76ba3b78241'::uuid,
   'a209442b-3617-42e1-92ab-25c27d25ab00'::uuid,
   'Huddersfield', 'https://tbetcegmszzotrwdtqhi.supabase.co',
   '5d9864db-e627-42bc-90af-d76ba3b78241'::uuid, 'Europe/London', now()),
  -- POSUP Test → Location 2 (existing company)
  ('c3ebfa7f-61b3-4fbc-a192-e7e3949f370e'::uuid,
   'a1b2c3d4-0001-0001-0001-000000000001'::uuid,
   'Location 2', 'https://tbetcegmszzotrwdtqhi.supabase.co',
   'c3ebfa7f-61b3-4fbc-a192-e7e3949f370e'::uuid, 'Europe/London', now())
on conflict (id) do nothing;

-- ── 3. billing_state for EVERY location (so GMV bumps have somewhere to land)
insert into billing_state (location_id, company_id, current_period_currency)
select l.id, l.company_id, 'gbp'
  from locations l
 where not exists (select 1 from billing_state bs where bs.location_id = l.id);

-- ── 4. Roles for known users ─────────────────────────────────────────────
-- peter@posup.co.uk (47b713cc-...): super_admin in Ops → admin everywhere in Platform.
-- pwar2804@gmail.com (8b27b32a-...): owner of POSUP Test only — leave existing mapping.

-- Give peter admin access to the 2 new companies
insert into user_company_roles (id, user_id, company_id, role, created_at)
select gen_random_uuid(),
       '47b713cc-a000-4bc5-b83b-74bac7af5526'::uuid,
       c.id, 'admin', now()
  from companies c
 where c.id in (
   '523d842a-053e-4e9d-92ef-09b59508cbc0'::uuid,
   'a209442b-3617-42e1-92ab-25c27d25ab00'::uuid
 )
   and not exists (
     select 1 from user_company_roles ucr
      where ucr.user_id = '47b713cc-a000-4bc5-b83b-74bac7af5526'::uuid
        and ucr.company_id = c.id
   );

-- Give peter location-level access to all locations (super_admin should see everything)
insert into user_access (id, user_id, email, company_id, location_id, role, created_at)
select gen_random_uuid(),
       '47b713cc-a000-4bc5-b83b-74bac7af5526'::uuid,
       'peter@posup.co.uk',
       l.company_id, l.id, 'admin', now()
  from locations l
 where not exists (
   select 1 from user_access ua
    where ua.user_id = '47b713cc-a000-4bc5-b83b-74bac7af5526'::uuid
      and ua.location_id = l.id
 );

-- ── 5. Verification view ─────────────────────────────────────────────────
-- (Not persisted — just runs to show the result. Caller can read the output.)
select 'companies' as kind, count(*)::text as n from companies
union all
select 'locations',         count(*)::text from locations
union all
select 'platform_users',    count(*)::text from platform_users
union all
select 'user_company_roles', count(*)::text from user_company_roles
union all
select 'user_access',       count(*)::text from user_access
union all
select 'billing_state',     count(*)::text from billing_state
order by kind;
