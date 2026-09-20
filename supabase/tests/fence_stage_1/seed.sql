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

-- Runbook step 1b (fix round 3): 20260919_OPS_fence_0_caps.sql went out with the release, so
-- devices has the two columns the app writes its capabilities to. Written here exactly as that
-- file writes them, because the seed is the state of the live database on the night file A is
-- pasted, and step 1b comes first.
alter table public.devices add column if not exists client_caps        text[];
alter table public.devices add column if not exists device_secret_hash text;

-- Fix round 3: every device switched on in the last 2 hours already runs the release (runbook
-- step 2) and has reported it, so file A's app check passes. The version is recorded too (file
-- A prints it with any device it names, but never gates on it: 5.9.10 and 5.9.11 both shipped
-- without the fence app). testTrip covers the fleet that has NOT reported it.
update public.devices
   set app_version = '5.9.12', client_caps = array['fence_v1', 'device_secret']
 where last_seen > now() - interval '2 hours';

-- Menu data the server prices public orders from (fix round 2). Acme One (L1).
insert into public.menu_items (id, location_id, name, menu_name, kitchen_name, type, cat, cats, parent_id, pricing, assigned_modifier_groups) values
  ('mi-burger', '10000000-0000-4000-8000-000000000001', 'Burger', null, null, 'simple', 'cat-mains', '{}', null, '{"base": 20, "collection": 20, "delivery": 22, "dineIn": 20}', '["mg-extras"]'),
  ('mi-feast', '10000000-0000-4000-8000-000000000001', 'Feast', null, null, 'simple', 'cat-mains', '{}', null, '{"base": 95}', '[]'),
  ('mi-tea', '10000000-0000-4000-8000-000000000001', 'Tea', null, null, 'simple', 'cat-drinks', '{}', null, '{"base": 10}', '[]'),
  ('mi-beer', '10000000-0000-4000-8000-000000000001', 'Beer', null, null, 'simple', 'cat-drinks', '{}', null, '{"base": 6}', '[]'),
  ('mi-pizza', '10000000-0000-4000-8000-000000000001', 'Pizza', null, 'PIZZA', 'simple', 'cat-mains', '{}', null, '{"base": 12}', '[]'),
  ('mi-meal', '10000000-0000-4000-8000-000000000001', 'Meal', null, null, 'simple', 'cat-mains', '{}', null, '{"base": 25}', '[]'),
  ('mi-coffee', '10000000-0000-4000-8000-000000000001', 'Coffee', null, null, 'simple', 'cat-drinks', '{}', null, '{"base": 3}', '[]'),
  ('mi-tray', '10000000-0000-4000-8000-000000000001', 'Tray', null, null, 'simple', 'cat-mains', '{}', null, '{"base": 50, "delivery": 60}', '[]'),
  ('mi-wine', '10000000-0000-4000-8000-000000000001', 'Wine', null, null, 'simple', 'cat-drinks', '{}', null, '{"base": 30}', '[]'),
  ('mi-cola', '10000000-0000-4000-8000-000000000001', 'Cola', null, null, 'variants', 'cat-drinks', '{}', null, '{"base": 0}', '[]'),
  ('mi-cola-half', '10000000-0000-4000-8000-000000000001', 'Half', null, null, 'simple', null, '{}', 'mi-cola', '{"base": 3.02, "collection": 3.02, "delivery": 2.85, "dineIn": 3.02}', '[]'),
  ('mi-cola-pint', '10000000-0000-4000-8000-000000000001', 'Pint', null, null, 'simple', null, '{}', 'mi-cola', '{"base": 5.5}', '[]'),
  ('mi-chips', '10000000-0000-4000-8000-000000000001', 'Chips', null, null, 'simple', 'cat-sides', '{}', null, '{"base": 4, "menus": {"menu-happy": {"all": 2.5}}}', '[]'),
  ('mi-wrap', '10000000-0000-4000-8000-000000000001', 'Wrap', null, null, 'simple', 'cat-deal-main', '{}', null, '{"base": 8}', '[]'),
  ('mi-fries', '10000000-0000-4000-8000-000000000001', 'Fries', null, null, 'simple', null, '{cat-deal-side}', null, '{"base": 3.5}', '[]'),
  ('mi-donut', '10000000-0000-4000-8000-000000000001', 'Donut', null, null, 'simple', 'cat-donuts', '{}', null, '{"base": 2}', '[]'),
  ('mi-cake', '10000000-0000-4000-8000-000000000001', 'Cake', null, null, 'simple', 'cat-cakes', '{}', null, '{"base": 4}', '[]'),
  -- Beta One (L3): the same id name at another venue is never this venue's item
  ('mi-beta-soup', '10000000-0000-4000-8000-000000000003', 'Soup', null, null, 'simple', 'cat-mains', '{}', null, '{"base": 1}', '[]');

-- Fix round 3: the groups the server checks a line's options against. mg-extras is a "pick
-- many" group (each option once, at most 3 picks) and carries a free option, a minus priced
-- one and one that opens a sub group; mg-shots is a "pick with qty" group (the SAME option up
-- to 2 times); mg-sauce is only ever reached as opt-sauce's sub group.
insert into public.modifier_groups (id, location_id, name, min, max, selection_type, options) values
  ('mg-extras', '10000000-0000-4000-8000-000000000001', 'Extras', 0, 3, 'multi',
   '[{"id": "opt-bacon", "name": "Bacon", "price": 5}, {"id": "opt-cheese", "name": "Cheese", "price": 1.5}, {"id": "opt-noonion", "name": "No onions", "price": -0.5}, {"id": "opt-plain", "name": "No sauce", "price": 0}, {"id": "opt-sauce", "name": "Sauce", "price": 1, "subGroupId": "mg-sauce"}]'),
  ('mg-sauce', '10000000-0000-4000-8000-000000000001', 'How', 0, 1, 'single',
   '[{"id": "opt-side", "name": "On the side", "price": -0.2}]'),
  ('mg-shots', '10000000-0000-4000-8000-000000000001', 'Extra shots', 0, 2, 'quantity',
   '[{"id": "opt-shot", "name": "Extra shot", "price": 0.8}, {"id": "opt-lessice", "name": "Less ice", "price": -0.25}]'),
  ('mg-beta', '10000000-0000-4000-8000-000000000003', 'Beta extras', 0, 1, 'single',
   '[{"id": "opt-beta-free", "name": "Free thing", "price": -50}]');

-- A drink with a "pick with qty" group, and a variants parent whose sizes carry no groups of
-- their own (so a size uses the main product's, lib/menuRules.js rule 2).
update public.menu_items set assigned_modifier_groups = '["mg-shots"]' where id = 'mi-coffee';
update public.menu_items set assigned_modifier_groups = '["mg-extras"]' where id = 'mi-cola';

-- Automatic discount rules at Acme One: a meal deal (a wrap and a side for 10), buy two
-- donuts get the third half price, and three that must never apply online: one for the
-- till only, one that expired, and one not live at any hour.
insert into public.discount_rules (id, location_id, name, active, trigger_type, trigger_category_ids, trigger_qty, reward_type,
                                   reward_value, reward_qty, reward_category_ids, channels, schedule, priority, trigger_groups) values
  ('70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Meal deal', true, 'bundle', '{}', 2, 'fixed_price',
   10, 1, '{}', '{"qr": true, "pos": true, "kiosk": true, "online": true}', null, 10,
   '[{"categoryIds": ["cat-deal-main"], "qty": 1}, {"categoryIds": ["cat-deal-side"], "qty": 1}]'),
  ('70000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Donut deal', true, 'buy_x', '{cat-donuts}', 2, 'percent',
   50, 1, '{}', '{"qr": true, "pos": true, "kiosk": true, "online": true}', null, 5, null),
  ('70000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Till only', true, 'buy_x', '{cat-cakes}', 1, 'free',
   0, 1, '{}', '{"qr": false, "pos": true, "kiosk": false, "online": false}', null, 4, null),
  ('70000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Expired', true, 'buy_x', '{cat-cakes}', 1, 'free',
   0, 1, '{}', null, '{"expiresAt": "2001-01-01"}', 3, null),
  ('70000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Never live', true, 'buy_x', '{cat-cakes}', 1, 'free',
   0, 1, '{}', null, '{"days": [8]}', 2, null);

-- Promo codes: a single use tenner off and a 10 percent code for Acme; a Beta code; an
-- expired one.
insert into public.offers (id, org_id, name, reward_type, reward_value, active, venue_ids) values
  ('80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'Tenner off', 'fixed', 10, true, '{}'),
  ('80000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a1', 'Ten percent', 'percent', 10, true, '{}'),
  ('80000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000b2', 'Beta tenner', 'fixed', 10, true, '{}'),
  ('80000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000a1', 'Old offer', 'fixed', 10, true, '{}');
update public.offers set valid_to = now() - interval '1 day' where id = '80000000-0000-4000-8000-000000000004';
insert into public.promo_codes (id, offer_id, org_id, code, status, uses_allowed, uses_count) values
  ('81000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'SAVE10', 'issued', 1, 0),
  ('81000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a1', 'MULTI10', 'issued', 5, 0),
  ('81000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000b2', 'BETA10', 'issued', 1, 0),
  ('81000000-0000-4000-8000-000000000004', '80000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000a1', 'OLDCODE', 'issued', 1, 0),
  ('81000000-0000-4000-8000-000000000005', '80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'LATER10', 'issued', 1, 0);

-- auth sessions: dev1 used the venue network and has been idle for 2 hours; its new
-- login (dev1b) signed in from the same address; the attacker from elsewhere.
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at, ip) values
  ('50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '2 hours', (now() - interval '2 hours') at time zone 'UTC', '203.0.113.5'),
  ('50000000-0000-4000-8000-00000000000c', '30000000-0000-4000-8000-00000000000c', now() - interval '5 minutes', now() - interval '5 minutes', null, '203.0.113.5'),
  ('50000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000009', now() - interval '5 minutes', now() - interval '5 minutes', null, '198.51.100.7');
