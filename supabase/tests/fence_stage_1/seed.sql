-- Synthetic data only (no production data). Mirrors the SHAPE of the live states.
-- Orgs: O1 Acme (L1, L2), O2 Beta (L3), L4 in O2 unlinked.
insert into public.organisations (id, name, slug, status) values
  ('00000000-0000-4000-8000-0000000000a1', 'Acme', 'acme', 'active'),
  ('00000000-0000-4000-8000-0000000000b2', 'Beta', 'beta', 'active');
insert into public.locations (id, org_id, name, status) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'Acme One', 'active'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a1', 'Acme Two', 'active'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000b2', 'Beta One', 'active'),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000b2', 'Beta Spare', 'active');

-- auth users
insert into auth.users (id, email, is_anonymous) values
  ('20000000-0000-4000-8000-000000000001', 'owner1@x.test', false),   -- owner at L1
  ('20000000-0000-4000-8000-000000000002', 'manager1@x.test', false), -- manager at L1
  ('20000000-0000-4000-8000-000000000003', 'owner2@x.test', false),   -- owner at L3
  ('20000000-0000-4000-8000-000000000004', 'super@x.test', false),    -- super admin, linked L2
  ('20000000-0000-4000-8000-000000000005', 'newbie@x.test', false),   -- no links, no org
  ('20000000-0000-4000-8000-000000000006', 'staff1@x.test', false),   -- staff login at L1 (venue link role staff, and a staff record)
  ('20000000-0000-4000-8000-000000000007', 'mallory@x.test', false),  -- a stranger who signs up with a real login
  ('30000000-0000-4000-8000-000000000001', null, true),  -- dev1 POS L1 seen now
  ('30000000-0000-4000-8000-000000000002', null, true),  -- dev2 KDS L1 seen 20 days ago
  ('30000000-0000-4000-8000-000000000003', null, true),  -- dev3 POS L3 seen 2 days
  ('30000000-0000-4000-8000-000000000004', null, true),  -- dev4 kiosk L1 seen 1 day, no code
  ('30000000-0000-4000-8000-000000000005', null, true),  -- dupuid: bound on two rows
  ('30000000-0000-4000-8000-000000000009', null, true),  -- attacker
  ('30000000-0000-4000-8000-00000000000a', null, true),  -- customer
  ('30000000-0000-4000-8000-00000000000b', null, true),  -- new till
  ('30000000-0000-4000-8000-00000000000c', null, true),  -- rotated uid of dev1
  ('30000000-0000-4000-8000-00000000000d', null, true),  -- a friend who joins a QR tab
  ('30000000-0000-4000-8000-00000000000e', null, true);  -- another phone in the venue

insert into public.user_profiles (id, org_id, location_id, full_name, role, email, bo_access) values
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', 'Owner One', 'owner', 'owner1@x.test', true),
  ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', 'Manager One', 'owner', 'manager1@x.test', true),
  ('20000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000b2', '10000000-0000-4000-8000-000000000003', 'Owner Two', 'owner', 'owner2@x.test', true),
  ('20000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000003', 'Super', 'super_admin', 'super@x.test', true),
  ('20000000-0000-4000-8000-000000000005', null, null, 'Newbie', 'owner', 'newbie@x.test', true),
  ('20000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-0000000000a1', null, 'Staff One', 'owner', 'staff1@x.test', false),
  ('20000000-0000-4000-8000-000000000007', null, null, 'Mallory', 'owner', 'mallory@x.test', true),
  ('30000000-0000-4000-8000-000000000001', null, null, null, 'owner', null, false),
  ('30000000-0000-4000-8000-000000000002', null, null, null, 'owner', null, false),
  ('30000000-0000-4000-8000-000000000003', null, null, null, 'owner', null, false),
  ('30000000-0000-4000-8000-000000000004', null, null, null, 'owner', null, false),
  ('30000000-0000-4000-8000-000000000005', null, null, null, 'owner', null, false),
  ('30000000-0000-4000-8000-000000000009', null, null, null, 'owner', null, false),
  ('30000000-0000-4000-8000-00000000000a', null, null, null, 'owner', null, false),
  ('30000000-0000-4000-8000-00000000000b', null, null, null, 'owner', null, false),
  ('30000000-0000-4000-8000-00000000000c', null, null, null, 'owner', null, false),
  ('30000000-0000-4000-8000-00000000000d', null, null, null, 'owner', null, false),
  ('30000000-0000-4000-8000-00000000000e', null, null, null, 'owner', null, false);

insert into public.user_locations (user_id, location_id, role) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'manager'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'owner'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', 'owner'),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', 'staff');

insert into public.staff_members (id, location_id, org_id, name, role, pin, auth_user_id, active)
select gen_random_uuid(), '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'Staff One', 'server', '1234', '20000000-0000-4000-8000-000000000006', true;

-- devices
insert into public.devices (id, location_id, name, type, pairing_code, status, last_seen, paired_at, device_uid, session_token) values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Till 1', 'pos', 'APPLE-1111', 'active', now() - interval '1 hour', now() - interval '30 days', '30000000-0000-4000-8000-000000000001', 'sess-a'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'KDS 1', 'kds', 'BAKER-2222', 'online', now() - interval '20 days', now() - interval '60 days', '30000000-0000-4000-8000-000000000002', 'sess-b'),
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'Beta Till', 'pos', 'CEDAR-3333', 'active', now() - interval '2 days', now() - interval '10 days', '30000000-0000-4000-8000-000000000003', 'sess-c'),
  ('40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Kiosk 1', 'kiosk', null, 'online', now() - interval '1 day', now() - interval '10 days', '30000000-0000-4000-8000-000000000004', 'tok-k'),
  ('40000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Dup A', 'pos', 'DONUT-5555', 'active', now() - interval '1 hour', now() - interval '5 days', '30000000-0000-4000-8000-000000000005', null),
  ('40000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000003', 'Dup B', 'pos', 'EMBER-6666', 'active', now() - interval '3 days', now() - interval '9 days', '30000000-0000-4000-8000-000000000005', null),
  ('40000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000003', 'Owner1 at Beta', 'pos', 'FROST-7777', 'active', now() - interval '1 hour', now() - interval '9 days', '20000000-0000-4000-8000-000000000001', null),
  ('40000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001', 'Owner1 at Acme', 'pos', 'GROVE-8888', 'active', now() - interval '1 hour', now() - interval '9 days', '20000000-0000-4000-8000-000000000001', null),
  ('40000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'Old unbound active', 'pos', 'HONEY-9999', 'active', now() - interval '40 days', null, null, 'sess-x'),
  ('40000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'Never paired', 'handheld', 'IVORY-1010', 'unpaired', null, null, null, null),
  ('40000000-0000-4000-8000-00000000000b', null, 'No venue', 'pos', 'JAZZY-1212', 'active', now() - interval '40 days', now() - interval '50 days', '30000000-0000-4000-8000-000000000009', null);

-- auth sessions: dev1 used the venue network and has been idle for 2 hours; its new
-- login (dev1b) signed in from the same address; the attacker from elsewhere.
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at, ip) values
  ('50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '2 hours', (now() - interval '2 hours') at time zone 'UTC', '203.0.113.5'),
  ('50000000-0000-4000-8000-00000000000c', '30000000-0000-4000-8000-00000000000c', now() - interval '5 minutes', now() - interval '5 minutes', null, '203.0.113.5'),
  ('50000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000009', now() - interval '5 minutes', now() - interval '5 minutes', null, '198.51.100.7');
