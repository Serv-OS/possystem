-- Made up logins in every state the live Ops database has (13 real logins, 7 of them dormant).
insert into auth.users (id, email, is_anonymous, last_sign_in_at) values
  ('10000000-0000-4000-8000-000000000001', 'peter@posup.co.uk',  false, now() - interval '1 day'),
  ('10000000-0000-4000-8000-000000000002', 'owner@acme.test',    false, now() - interval '200 days'),
  ('10000000-0000-4000-8000-000000000003', 'manager@acme.test',  false, now() - interval '2 days'),
  ('10000000-0000-4000-8000-000000000004', 'chef@acme.test',     false, now() - interval '3 days'),
  ('10000000-0000-4000-8000-000000000005', null,                 true,  now() - interval '1 hour');

insert into public.locations (id, name) values ('20000000-0000-4000-8000-000000000001', 'Acme One');

-- Peter: the only super admin. Owner: a venue link, dormant, no second step (the blocker).
-- Manager: a venue link AND a verified authenticator app. Chef: the staff app only.
insert into public.user_profiles (id, email, role, location_id) values
  ('10000000-0000-4000-8000-000000000001', 'peter@posup.co.uk', 'super_admin', null),
  ('10000000-0000-4000-8000-000000000002', 'owner@acme.test',   'owner',       '20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000003', 'manager@acme.test', 'manager',     null),
  ('10000000-0000-4000-8000-000000000004', 'chef@acme.test',    'staff',       null);
insert into public.user_locations (user_id, location_id, role) values
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'owner'),
  ('10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'manager');
insert into public.wf_staff (id, portal_user_id, location_id, status) values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', 'active');

insert into auth.mfa_factors (id, user_id, status, factor_type) values
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 'verified', 'totp');

insert into public.menu_items (id, location_id, name) values ('mi-burger', '20000000-0000-4000-8000-000000000001', 'Burger');
