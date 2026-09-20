#!/usr/bin/env python3
"""Offline test for 20260921_OPS_customers_fence.sql.

Runs the real migration against a throwaway local Postgres 17 that copies the shape of the
live tables it touches, including schema public's DEFAULT PRIVILEGES (Supabase grants every
new function to anon and authenticated, which is the trap that stopped 20260920p).

    initdb -D /tmp/cfdata -U postgres --auth=trust -E UTF8
    pg_ctl -D /tmp/cfdata -o "-p 55997 -c listen_addresses=127.0.0.1" start
    python3 test_customers_fence.py        # CF_PGHOST / CF_PGPORT override the address
"""
import os, subprocess, sys, pathlib

HOST = os.environ.get('CF_PGHOST', '127.0.0.1')
PORT = os.environ.get('CF_PGPORT', '55997')
PSQL = ['psql', '-h', HOST, '-p', PORT, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q']
HERE = pathlib.Path(__file__).resolve().parent
MIG = HERE.parent.parent / 'migrations' / '20260921_OPS_customers_fence.sql'

passed = failed = 0


def run(sql, db='cf', want_error=False):
    p = subprocess.run(PSQL + ['-d', db, '-c', sql], capture_output=True, text=True)
    if p.returncode != 0 and not want_error:
        raise RuntimeError(p.stderr.strip())
    if want_error:
        return p.returncode != 0, p.stderr.strip()
    return p.stdout.strip()


def run_file(path, db='cf', want_error=False):
    p = subprocess.run(PSQL + ['-d', db, '-1', '-f', str(path)], capture_output=True, text=True)
    if p.returncode != 0 and not want_error:
        raise RuntimeError(p.stderr.strip()[-900:])
    return p.returncode == 0, p.stderr.strip()


def check(name, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('PASS', name)
    else:
        failed += 1
        print('FAIL', name, extra)


def one(sql, db='cf'):
    p = subprocess.run(PSQL + ['-t', '-A', '-d', db, '-c', f"select ({sql})::text"], capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(p.stderr.strip())
    return p.stdout.strip()


BASELINE = """
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end
$roles$;
grant usage on schema public to anon, authenticated, service_role;

-- THE TRAP: Supabase grants every new object in public to anon and authenticated
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;

create table if not exists public.locations (id uuid primary key default gen_random_uuid(), org_id uuid, name text);
create table if not exists public.user_locations (user_id uuid, location_id uuid, role text);
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(), org_id uuid not null, phone text, phone_raw text,
  email text, name text not null, notes text, marketing_opt_in boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now(), deleted_at timestamptz,
  tags jsonb, source text, stored_payment_method_id text);
create table if not exists public.customer_locations (
  customer_id uuid not null, location_id uuid not null, first_visit_at timestamptz,
  last_visit_at timestamptz, visit_count int default 0, lifetime_revenue numeric default 0,
  primary key (customer_id, location_id));
create table if not exists public.customer_orders (
  id uuid primary key default gen_random_uuid(), customer_id uuid not null, location_id uuid not null,
  closed_check_id text, ordered_at timestamptz default now(), total numeric default 0,
  channel text, item_summary jsonb, created_at timestamptz default now());
create table if not exists public.order_queue (location_id text, ref text, customer jsonb);
create table if not exists public.public_order_tokens (location_id text, ref text, token text);

-- stage 1 helpers, stubbed to the same shapes the live ones have
create or replace function public.is_super_admin() returns boolean language sql stable as $$
  select coalesce(current_setting('test.super', true) = 'on', false) $$;
create or replace function public.pos_can_access(p_loc text) returns boolean language sql stable as $$
  select coalesce(p_loc = current_setting('test.device_loc', true), false)
      or exists (select 1 from public.user_locations ul where ul.user_id = auth.uid() and ul.location_id::text = p_loc)
      or public.is_super_admin() $$;
create or replace function public.pos_can_access(p_loc uuid) returns boolean language sql stable as $$
  select public.pos_can_access(p_loc::text) $$;
create or replace function public._order_track_ok(p_location_id text, p_ref text, p_key text) returns boolean language sql stable as $$
  select exists (select 1 from public.public_order_tokens t
                  where t.location_id = p_location_id and t.ref = p_ref and t.token = p_key) $$;

-- today's open rules, the ones the file replaces
alter table public.customers enable row level security;
alter table public.customer_locations enable row level security;
alter table public.customer_orders enable row level security;
drop policy if exists customers_all on public.customers;
create policy customers_all on public.customers for all to public
  using ((org_id in (select l.org_id from public.locations l join public.user_locations ul on ul.location_id = l.id where ul.user_id = auth.uid()))
         or (auth.uid() is null) or (((auth.jwt() ->> 'is_anonymous'))::boolean = true));
drop policy if exists customer_locations_all on public.customer_locations;
create policy customer_locations_all on public.customer_locations for all to public
  using ((location_id in (select ul.location_id from public.user_locations ul where ul.user_id = auth.uid()))
         or (auth.uid() is null) or (((auth.jwt() ->> 'is_anonymous'))::boolean = true));
drop policy if exists customer_orders_all on public.customer_orders;
create policy customer_orders_all on public.customer_orders for all to public
  using ((location_id in (select ul.location_id from public.user_locations ul where ul.user_id = auth.uid()))
         or (auth.uid() is null) or (((auth.jwt() ->> 'is_anonymous'))::boolean = true));
grant select, insert, update, delete on public.customers, public.customer_locations, public.customer_orders to anon, authenticated;
"""

SEED = """
insert into public.locations (id, org_id, name) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'Alpha'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002', 'Beta');
insert into public.user_locations (user_id, location_id, role) values
  ('dddddddd-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner');
insert into public.customers (id, org_id, phone, name, email, notes) values
  ('cccccccc-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', '07700900123', 'Alice', 'a@x.com', 'vip, allergic to nuts'),
  ('cccccccc-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000002', '07700900999', 'Bella', 'b@x.com', 'beta regular');
insert into public.order_queue (location_id, ref, customer) values
  ('11111111-1111-1111-1111-111111111111', 'OL-1', '{"phone":"07700900555"}'::jsonb);
insert into public.public_order_tokens (location_id, ref, token) values
  ('11111111-1111-1111-1111-111111111111', 'OL-1', 'tok-abc-123');
"""


def as_role(role, sql, claims=None, device_loc=None, want_error=False):
    """Run sql as anon or authenticated, with optional jwt claims and a bound device."""
    pre = [f"set local role {role};"]
    if claims:
        pre.insert(0, f"set local request.jwt.claims = '{claims}';")
        sub = claims.split('"sub":"')[1].split('"')[0] if '"sub":"' in claims else None
        if sub:
            pre.insert(0, f"set local request.jwt.claim.sub = '{sub}';")
    if device_loc:
        pre.insert(0, f"set local test.device_loc = '{device_loc}';")
    body = 'begin; ' + ' '.join(pre) + ' ' + sql + '; commit;'
    if want_error:
        return run(body, want_error=True)
    p = subprocess.run(PSQL + ['-t', '-A', '-d', 'cf', '-c', body], capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(p.stderr.strip())
    return p.stdout.strip()


print('== building the throwaway database')
run('drop database if exists cf', db='postgres')
run('create database cf', db='postgres')
b = subprocess.run(PSQL + ['-d', 'cf', '-c', BASELINE], capture_output=True, text=True)
if b.returncode: print(b.stderr.strip()[-600:]); sys.exit(1)
sd = subprocess.run(PSQL + ['-d', 'cf', '-c', SEED], capture_output=True, text=True)
if sd.returncode: print(sd.stderr.strip()[-600:]); sys.exit(1)

print('== before the file: the public key can read every customer')
before = as_role('authenticated', "select count(*) from public.customers",
                 claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}')
check('BEFORE: an anonymous session reads every customer of every venue', before.strip().endswith('2'), before)

print('== applying the migration')
ok, err = run_file(MIG)
check('the file applies', ok, err)
ok2, err2 = run_file(MIG)
check('and it applies twice (idempotent)', ok2, err2)

print('== after the file')
after_anon = as_role('authenticated', "select count(*) from public.customers",
                     claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}')
check('an anonymous session now reads NOTHING', after_anon.strip().endswith('0'), after_anon)

raw_anon_err, msg = run(
    "begin; set local role anon; select count(*) from public.customers; commit;", want_error=True)
check('the raw public key is refused outright', raw_anon_err and 'permission denied' in msg, msg[:120])

owner = as_role('authenticated', "select count(*) from public.customers",
                claims='{"role":"authenticated","sub":"dddddddd-0000-0000-0000-00000000000a","is_anonymous":false}')
check("a venue's own login still reads its own customers", owner.strip().endswith('1'), owner)

other = as_role('authenticated', "select name from public.customers where org_id = 'bbbbbbbb-0000-0000-0000-000000000002'",
                claims='{"role":"authenticated","sub":"dddddddd-0000-0000-0000-00000000000a","is_anonymous":false}')
check('and never another venue\'s', 'Bella' not in other, other)

till = as_role('authenticated', "select count(*) from public.customers",
               claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}',
               device_loc='11111111-1111-1111-1111-111111111111')
check('a till bound to the venue still reads its customers', till.strip().endswith('1'), till)

print('== the lookup function')
found = as_role('authenticated',
                "select public.customer_by_phone('11111111-1111-1111-1111-111111111111','07700900123')",
                claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}',
                device_loc='11111111-1111-1111-1111-111111111111')
check('a bound till finds the customer', 'Alice' in found, found)
check('and gets only what the till shows', 'allergic to nuts' not in found and 'notes' not in found, found)

stranger = as_role('authenticated',
                   "select coalesce(public.customer_by_phone('11111111-1111-1111-1111-111111111111','07700900123')::text, 'NULL')",
                   claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}')
check('a stranger with the public key gets nothing', 'NULL' in stranger, stranger)

cross = as_role('authenticated',
                "select coalesce(public.customer_by_phone('11111111-1111-1111-1111-111111111111','07700900999')::text, 'NULL')",
                claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}',
                device_loc='11111111-1111-1111-1111-111111111111')
check("and a venue cannot read another venue's customer by phone", 'NULL' in cross, cross)

print('== the attribution function')
attr = as_role('authenticated',
               "select public.attribute_public_order('11111111-1111-1111-1111-111111111111','OL-1','tok-abc-123',"
               "'{\"phone\":\"07700900555\",\"name\":\"Carl\",\"email\":\"c@x.com\"}'::jsonb,"
               "'{\"total\":12.5,\"channel\":\"online\",\"items\":[{\"name\":\"Tea\",\"qty\":1,\"price\":2.5}]}'::jsonb)",
               claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}')
check('an order that holds its own key attaches its customer', '"ok" : true' in attr or '"ok": true' in attr, attr)
check('and says it created the customer', '"created" : true' in attr or '"created": true' in attr, attr)
check('the customer row is there', one("select count(*) from public.customers where phone = '07700900555'") == '1')
check('the venue stats row is there', one("select visit_count::text from public.customer_locations where location_id = '11111111-1111-1111-1111-111111111111' and customer_id = (select id from public.customers where phone = '07700900555')") == '1')
check('the order row is there', one("select count(*) from public.customer_orders where closed_check_id = 'OL-1'") == '1')

again = as_role('authenticated',
                "select public.attribute_public_order('11111111-1111-1111-1111-111111111111','OL-1','tok-abc-123',"
                "'{\"phone\":\"07700900555\",\"name\":\"Carl\"}'::jsonb,'{\"total\":12.5}'::jsonb)",
                claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}')
check('sending it twice does not write the order twice',
      one("select count(*) from public.customer_orders where closed_check_id = 'OL-1'") == '1', again)

wrong = as_role('authenticated',
                "select public.attribute_public_order('11111111-1111-1111-1111-111111111111','OL-1','not-my-token',"
                "'{\"phone\":\"07700900777\",\"name\":\"Thief\"}'::jsonb,'{\"total\":99}'::jsonb)",
                claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}')
check('a page without the order key is refused', 'not_yours' in wrong, wrong)
check('and wrote nobody', one("select count(*) from public.customers where phone = '07700900777'") == '0')

noorder = as_role('authenticated',
                  "select public.attribute_public_order('11111111-1111-1111-1111-111111111111','OL-NOPE','tok-abc-123',"
                  "'{\"phone\":\"07700900888\"}'::jsonb,'{\"total\":5}'::jsonb)",
                  claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}')
check('an order that does not exist is refused', 'not_yours' in noorder or 'no_order' in noorder, noorder)

run("update public.customers set name = 'Carl Curated' where phone = '07700900555'")
as_role('authenticated',
        "select public.attribute_public_order('11111111-1111-1111-1111-111111111111','OL-1','tok-abc-123',"
        "'{\"phone\":\"07700900555\",\"name\":\"Robot\"}'::jsonb,'{\"total\":1}'::jsonb)",
        claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}')
check('a name the venue curated is never overwritten',
      one("select name from public.customers where phone = '07700900555'") == 'Carl Curated')

print('== grants, the trap that stopped the passkey file')
check('the public key cannot call the lookup',
      one("select has_function_privilege('anon','public.customer_by_phone(text, text)','execute')") == 'false')
check('nor the org test',
      one("select has_function_privilege('anon','public.customer_org_visible(uuid)','execute')") == 'false')
check('but a customer page can still attach its own order',
      one("select has_function_privilege('anon','public.attribute_public_order(text, text, text, jsonb, jsonb)','execute')") == 'true')
check('and a signed in person can still look one up',
      one("select has_function_privilege('authenticated','public.customer_by_phone(text, text)','execute')") == 'true')

print('== the roll back, run the way Peter runs it')
# Peter selects the block under the ROLL BACK banner and presses Cmd+/ once: every line
# loses its leading "-- ". The banner line itself is not part of the selection.
block = MIG.read_text().split('-- ROLL BACK', 1)[1]
block = block.split('\n', 1)[1]          # drop the rest of the banner line
lines = []
for raw in block.split('\n'):
    if raw.strip().startswith('-- ===='):
        continue
    lines.append(raw[3:] if raw.startswith('-- ') else ('' if raw.strip() == '--' else raw))
rb = '\n'.join(l for l in lines if not l.strip().startswith('--'))
p = subprocess.run(PSQL + ['-d', 'cf', '-1', '-c', rb], capture_output=True, text=True)
check('the roll back runs', p.returncode == 0, p.stderr.strip()[-300:])
back = as_role('authenticated', "select count(*) from public.customers",
               claims='{"role":"authenticated","sub":"99999999-0000-0000-0000-00000000000f","is_anonymous":true}')
check('and puts back exactly what was there before, including the open read', back.strip().endswith('3'), back)
ok3, err3 = run_file(MIG)
check('and the file can be applied again afterwards', ok3, err3)

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
