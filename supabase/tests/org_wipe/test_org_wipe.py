#!/usr/bin/env python3
"""Offline test for 20261125a_OPS_admin_wipe.sql and 20261125b_PLATFORM_admin_wipe.sql.

Runs both real files against a throwaway local Postgres 17 whose tables copy the SHAPES that
matter: uuid and text location columns, org keyed tables, children that have no location column
at all, reference columns pointing at a venue from another venue, cascading keys with blocking
grandchildren, a view, and a second company that must come through untouched.

    initdb -D /tmp/owdata -U postgres --auth=trust -E UTF8
    pg_ctl -D /tmp/owdata -o "-p 55998 -c listen_addresses=127.0.0.1" start
    python3 test_org_wipe.py        # OW_PGHOST / OW_PGPORT override the address
"""
import os, subprocess, sys, pathlib, json

HOST = os.environ.get('OW_PGHOST', '127.0.0.1')
PORT = os.environ.get('OW_PGPORT', '55998')
PSQL = ['psql', '-h', HOST, '-p', PORT, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q']
HERE = pathlib.Path(__file__).resolve().parent
MIGS = HERE.parent.parent / 'migrations'
OPS = MIGS / '20261125a_OPS_admin_wipe.sql'
OPS_BACK = MIGS / '20261125a_OPS_admin_wipe_ROLLBACK.sql'
PLAT = MIGS / '20261125b_PLATFORM_admin_wipe.sql'
PLAT_BACK = MIGS / '20261125b_PLATFORM_admin_wipe_ROLLBACK.sql'

passed = failed = 0
# Everything runs as wipe_owner: like Supabase's postgres role, not a superuser, bypasses RLS,
# owns the tables and the functions.
AS_OWNER = 'set role wipe_owner;'


def run(sql, db='ow', want_error=False, owner=True):
    body = (AS_OWNER if owner else '') + sql
    p = subprocess.run(PSQL + ['-d', db, '-c', body], capture_output=True, text=True)
    if want_error:
        return p.returncode != 0, p.stderr.strip()
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip()[-900:])
    return p.stdout.strip()


def run_file(path, db='ow'):
    p = subprocess.run(PSQL + ['-d', db, '-1', '-c', AS_OWNER, '-f', str(path)], capture_output=True, text=True)
    return p.returncode == 0, (p.stderr.strip() or p.stdout.strip())[-900:]


def one(sql, db='ow'):
    p = subprocess.run(PSQL + ['-t', '-A', '-d', db, '-c', AS_OWNER + f"select ({sql})::text"], capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(p.stderr.strip())
    return p.stdout.strip()


def tx(sql, db='ow', want_error=False):
    """One transaction with set role lines inside it (set local role ... ; ...)."""
    body = 'begin; ' + AS_OWNER + ' ' + sql + ' commit;'
    p = subprocess.run(PSQL + ['-t', '-A', '-d', db, '-c', body], capture_output=True, text=True)
    if want_error:
        return p.returncode != 0, p.stderr.strip()
    if p.returncode:
        raise RuntimeError(p.stderr.strip())
    return p.stdout.strip()


def check(name, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('PASS', name)
    else:
        failed += 1
        print('FAIL', name, extra)


ROLES = """
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'wipe_owner') then create role wipe_owner nologin bypassrls createrole; end if;
end
$roles$;
"""

A = 'aaaaaaaa-0000-0000-0000-00000000000a'
B = 'bbbbbbbb-0000-0000-0000-00000000000b'
A1 = '11111111-0000-0000-0000-000000000001'
A2 = '11111111-0000-0000-0000-000000000002'
B1 = '22222222-0000-0000-0000-000000000001'
B2 = '22222222-0000-0000-0000-000000000002'
UA1 = 'dddddddd-0000-0000-0000-0000000000a1'   # owner, org A
UA2 = 'dddddddd-0000-0000-0000-0000000000a2'   # manager, org A, home venue A2
US = 'dddddddd-0000-0000-0000-0000000000ff'    # ServOS super admin sitting on org A
UB1 = 'dddddddd-0000-0000-0000-0000000000b1'   # owner, org B, home venue B1

OPS_SCHEMA = f"""
grant all on database ow to wipe_owner;
grant usage, create on schema public to wipe_owner;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role wipe_owner in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges for role wipe_owner in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;
create schema if not exists auth;
grant usage on schema auth to wipe_owner;
create table if not exists auth.users (id uuid primary key, email text);
grant select, insert, references on auth.users to wipe_owner;
{AS_OWNER}
create table public.organisations (id uuid primary key, name text not null, slug text);
create table public.locations (id uuid primary key, org_id uuid references public.organisations(id), name text);
create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid references public.organisations(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  role text default 'owner', full_name text);
create table public.user_locations (user_id uuid references public.user_profiles(id) on delete cascade, location_id uuid references public.locations(id), role text);
-- text keyed, no foreign key at all (closed_checks, kds_tickets, menus and friends are like this)
create table public.closed_checks (id text primary key, location_id text not null, total numeric);
create table public.kds_tickets (id uuid primary key default gen_random_uuid(), location_id text not null, status text);
create table public.menus (id uuid primary key, location_id text not null, name text);
create table public.menu_items (id uuid primary key, menu_id uuid not null references public.menus(id), location_id text, name text);
-- no location column: reached only through its parent
create table public.item_variants (id uuid primary key default gen_random_uuid(), item_id uuid not null references public.menu_items(id) on delete restrict, name text);
-- uuid keyed with a reference column pointing at another venue
create table public.stock_transfers (id uuid primary key default gen_random_uuid(), location_id uuid not null references public.locations(id), to_location_id uuid references public.locations(id), note text);
-- a cascading key whose own child blocks the cascade
create table public.floor_tables (id uuid primary key, location_id uuid not null references public.locations(id) on delete cascade, label text);
create table public.table_bookings (id uuid primary key default gen_random_uuid(), table_id uuid not null references public.floor_tables(id), guest text);
create table public.device_profiles (id uuid primary key default gen_random_uuid(), location_id uuid references public.locations(id) on delete cascade, name text);
-- org keyed
create table public.customers (id uuid primary key, org_id uuid not null, name text);
create table public.customer_orders (id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.customers(id), location_id text, total numeric);
create table public.wf_staff (id uuid primary key, org_id uuid not null, user_id uuid references public.user_profiles(id), name text);
create table public.wf_shifts (id uuid primary key default gen_random_uuid(), staff_id uuid not null references public.wf_staff(id), starts timestamptz default now());
-- a log that points at people from every company (nullable, no cascade): unlink, never delete
create table public.audit_log (id bigserial primary key, actor uuid references public.user_profiles(id), what text);
-- a view over a keyed table must be ignored
create view public.v_locations as select * from public.locations;
-- row level security on, no policy: only a bypassrls owner can delete
alter table public.closed_checks enable row level security;
alter table public.customers enable row level security;
"""

OPS_SEED = f"""
insert into auth.users (id, email) values
  ('{UA1}', 'a1@x'), ('{UA2}', 'a2@x'), ('{US}', 'staff@servos'), ('{UB1}', 'b1@x');
{AS_OWNER}
insert into public.organisations (id, name, slug) values ('{A}', 'Alpha Cafe', 'alpha'), ('{B}', 'Beta Bar', 'beta');
insert into public.locations (id, org_id, name) values
  ('{A1}', '{A}', 'Alpha One'), ('{A2}', '{A}', 'Alpha Two'), ('{B1}', '{B}', 'Beta One'), ('{B2}', '{B}', 'Beta Two');
insert into public.user_profiles (id, org_id, location_id, role, full_name) values
  ('{UA1}', '{A}', '{A1}', 'owner', 'Alpha owner'),
  ('{UA2}', '{A}', '{A2}', 'manager', 'Alpha manager'),
  ('{US}', '{A}', null, 'super_admin', 'ServOS staff'),
  ('{UB1}', '{B}', '{B1}', 'owner', 'Beta owner');
insert into public.user_locations (user_id, location_id, role) values
  ('{UA1}', '{A1}', 'owner'), ('{UA1}', '{A2}', 'owner'), ('{UA2}', '{A2}', 'manager'), ('{UB1}', '{B1}', 'owner'), ('{UB1}', '{B2}', 'owner');
insert into public.closed_checks (id, location_id, total) values
  ('R1', '{A1}', 10), ('R2', '{A1}', 20), ('R3', '{A2}', 30), ('R4', '{B1}', 40), ('R5', '{B2}', 50);
insert into public.kds_tickets (location_id, status) values ('{A1}', 'done'), ('{A2}', 'done'), ('{B1}', 'done');
insert into public.menus (id, location_id, name) values
  ('33333333-0000-0000-0000-0000000000a1', '{A1}', 'A1 menu'), ('33333333-0000-0000-0000-0000000000b1', '{B1}', 'B1 menu');
insert into public.menu_items (id, menu_id, location_id, name) values
  ('44444444-0000-0000-0000-0000000000a1', '33333333-0000-0000-0000-0000000000a1', '{A1}', 'Pie'),
  ('44444444-0000-0000-0000-0000000000b1', '33333333-0000-0000-0000-0000000000b1', '{B1}', 'Beer');
insert into public.item_variants (item_id, name) values
  ('44444444-0000-0000-0000-0000000000a1', 'Large'), ('44444444-0000-0000-0000-0000000000a1', 'Small'), ('44444444-0000-0000-0000-0000000000b1', 'Pint');
insert into public.stock_transfers (location_id, to_location_id, note) values
  ('{A1}', '{A2}', 'inside A'), ('{B1}', '{A1}', 'from B to A'), ('{B1}', '{B2}', 'inside B');
insert into public.floor_tables (id, location_id, label) values
  ('55555555-0000-0000-0000-0000000000a1', '{A1}', 'T1'), ('55555555-0000-0000-0000-0000000000b1', '{B1}', 'T1');
insert into public.table_bookings (table_id, guest) values
  ('55555555-0000-0000-0000-0000000000a1', 'Ann'), ('55555555-0000-0000-0000-0000000000b1', 'Bob');
insert into public.device_profiles (location_id, name) values ('{A1}', 'Till'), ('{B2}', 'Till');
insert into public.customers (id, org_id, name) values
  ('66666666-0000-0000-0000-0000000000a1', '{A}', 'Alice'), ('66666666-0000-0000-0000-0000000000b1', '{B}', 'Bella');
insert into public.customer_orders (customer_id, location_id, total) values
  ('66666666-0000-0000-0000-0000000000a1', '{A1}', 9), ('66666666-0000-0000-0000-0000000000b1', '{B1}', 9);
insert into public.wf_staff (id, org_id, user_id, name) values
  ('77777777-0000-0000-0000-0000000000a1', '{A}', '{UA2}', 'Alpha cook'), ('77777777-0000-0000-0000-0000000000b1', '{B}', '{UB1}', 'Beta cook');
insert into public.wf_shifts (staff_id) values ('77777777-0000-0000-0000-0000000000a1'), ('77777777-0000-0000-0000-0000000000b1');
insert into public.audit_log (actor, what) values ('{UA1}', 'a did'), ('{UB1}', 'b did'), ('{US}', 'staff did');
"""

TABLES = ['organisations', 'locations', 'user_profiles', 'user_locations', 'closed_checks', 'kds_tickets', 'menus', 'menu_items',
          'item_variants', 'stock_transfers', 'floor_tables', 'table_bookings', 'device_profiles', 'customers', 'customer_orders',
          'wf_staff', 'wf_shifts', 'audit_log']


def counts(db='ow', tables=TABLES):
    return {t: int(one(f'select count(*) from public.{t}', db)) for t in tables}


def b_rows():
    """Everything that belongs to Beta, as a signature that must not change."""
    return (one(f"select count(*) from public.locations where org_id = '{B}'") + '|'
            + one(f"select count(*) from public.closed_checks where location_id in ('{B1}', '{B2}')") + '|'
            + one(f"select count(*) from public.item_variants v join public.menu_items i on i.id = v.item_id where i.location_id = '{B1}'") + '|'
            + one(f"select count(*) from public.table_bookings b join public.floor_tables f on f.id = b.table_id where f.location_id = '{B1}'") + '|'
            + one(f"select count(*) from public.customers where org_id = '{B}'") + '|'
            + one(f"select count(*) from public.wf_shifts s join public.wf_staff w on w.id = s.staff_id where w.org_id = '{B}'") + '|'
            + one(f"select count(*) from public.user_profiles where id = '{UB1}' and org_id = '{B}' and location_id = '{B1}'") + '|'
            + one(f"select count(*) from public.audit_log where actor = '{UB1}'") + '|'
            + one(f"select count(*) from public.device_profiles where location_id = '{B2}'"))


print('== building the throwaway Ops database')
run('drop database if exists ow', db='postgres', owner=False)
run(ROLES, db='postgres', owner=False)
run('create database ow', db='postgres', owner=False)
p = subprocess.run(PSQL + ['-d', 'ow', '-c', OPS_SCHEMA], capture_output=True, text=True)
if p.returncode: print(p.stderr.strip()[-900:]); sys.exit(1)
p = subprocess.run(PSQL + ['-d', 'ow', '-c', OPS_SEED], capture_output=True, text=True)
if p.returncode: print(p.stderr.strip()[-900:]); sys.exit(1)
before = counts()
b_before = b_rows()

print('== the Ops file')
ok, err = run_file(OPS)
check('the Ops file applies', ok, err)
ok2, err2 = run_file(OPS)
check('and applies twice', ok2, err2)
check('anon cannot run the wipe', one("has_function_privilege('anon', 'public.admin_wipe_organisation(uuid, text, boolean)', 'execute')") == 'false')
check('a login cannot run the wipe', one("has_function_privilege('authenticated', 'public.admin_wipe_organisation(uuid, text, boolean)', 'execute')") == 'false')
check('a login cannot run the engine either', one("has_function_privilege('authenticated', 'public.admin_wipe_tables(text[], text[], text[], jsonb, boolean)', 'execute')") == 'false')
check('the service role can', one("has_function_privilege('service_role', 'public.admin_wipe_organisation(uuid, text, boolean)', 'execute')") == 'true')
denied, msg = tx(f"set local role authenticated; select public.admin_wipe_organisation('{A}', 'Alpha Cafe', true);", want_error=True)
check('a login calling it is refused outright', denied and 'permission denied' in msg, msg[:160])

print('== dry run')
dry = json.loads(tx(f"set local role service_role; select public.admin_wipe_organisation('{A}', 'alpha cafe ', true);"))
check('dry run answers as the service role, name check ignores case and spaces', dry.get('dry_run') is True and dry.get('organisation') == 'Alpha Cafe', json.dumps(dry)[:300])
check('dry run counts the venues and the logins', dry.get('locations') == 2 and dry.get('logins') == 2 and sorted(dry.get('login_ids') or []) == sorted([UA1, UA2]), json.dumps(dry)[:300])
vt = (dry.get('venues') or {}).get('tables') or {}
check('dry run counts text keyed rows (closed_checks 3, kds_tickets 2)', vt.get('closed_checks') == 3 and vt.get('kds_tickets') == 2, json.dumps(vt))
check('dry run counts the grandchildren with no location column (item_variants 2, table_bookings 1)', vt.get('item_variants') == 2 and vt.get('table_bookings') == 1, json.dumps(vt))
check('dry run lists the cascading rows too (floor_tables 1, device_profiles 1)', vt.get('floor_tables') == 1 and vt.get('device_profiles') == 1, json.dumps(vt))
vu = (dry.get('venues') or {}).get('unlinked') or {}
check('dry run counts the transfer from Beta that points at Alpha as an unlink, and only that one (rows the wipe deletes are not unlinks)', vu == {'stock_transfers.to_location_id': 1}, json.dumps(vu))
ct = (dry.get('company') or {}).get('tables') or {}
check('dry run counts the org keyed rows and their children (customers 1, customer_orders 1, wf_shifts 1, organisations 1)',
      ct.get('customers') == 1 and ct.get('customer_orders') == 1 and ct.get('wf_shifts') == 1 and ct.get('organisations') == 1, json.dumps(ct))
pu = (dry.get('people') or {}).get('unlinked') or {}
check("dry run counts the audit rows pointing at Alpha's people as unlinks, not deletes", pu.get('audit_log.actor') == 1, json.dumps(pu))
check('dry run reports the super admin as unlinked, not a login to remove', dry.get('staff_unlinked') == 1, json.dumps(dry)[:200])
check('dry run changed nothing', counts() == before and b_rows() == b_before)

print('== refusals that change nothing')
bad, msg = tx(f"set local role service_role; select public.admin_wipe_organisation('{A}', 'Alpha Cafe Ltd', false);", want_error=True)
check('the wrong name is refused', bad and 'does not match' in msg, msg[:160])
check('and nothing changed', counts() == before)
bad, msg = tx(f"set local role service_role; select public.admin_wipe_organisation('99999999-0000-0000-0000-000000000009', 'x', false);", want_error=True)
check('an unknown organisation is refused', bad and 'not found' in msg, msg[:160])
# a table the engine is told to leave alone still points at the venue: all or nothing
run("create table public.pinned (id serial primary key, location_id uuid references public.locations(id));")
run(f"insert into public.pinned (location_id) values ('{A1}');")
bad, msg = tx(f"set local role service_role; select public.admin_wipe_tables(array['{A1}'], array['location_id'], array['locations', 'pinned', 'user_profiles'], '{{\"locations\": \"id::text = any($1)\"}}'::jsonb, false);", want_error=True)
check('a row the engine may not touch stops the wipe with the table named', bad and 'Wipe stopped' in msg and 'locations' in msg, msg[:200])
check('and the stopped wipe rolled everything back', counts() == before, json.dumps(counts()))
run("drop table public.pinned;")

print('== the real wipe of Alpha')
rep = json.loads(tx(f"set local role service_role; select public.admin_wipe_organisation('{A}', 'Alpha Cafe', false);"))
check('the wipe answers with the totals', rep.get('dry_run') is False and rep.get('total', 0) > 0 and rep.get('locations') == 2, json.dumps(rep)[:300])
rct = (rep.get('company') or {}).get('tables') or {}
# A dry run cannot delete the venues first, so a row with both a venue and a company lineage (an
# order of a customer) is counted under the company too. The real wipe deletes each row once:
# the venue counts match exactly, every company count is at most the dry run's.
check('the wipe deleted what the dry run counted (venues exact, company never more than counted)',
      (rep.get('venues') or {}).get('tables') == vt and all(ct.get(k) == v for k, v in rct.items()) and set(rct) <= set(ct),
      'venues real ' + json.dumps((rep.get('venues') or {}).get('tables')) + ' dry ' + json.dumps(vt) + ' company real ' + json.dumps(rct) + ' dry ' + json.dumps(ct))
after = counts()
check('Alpha is gone: organisations 1, locations 2', after['organisations'] == 1 and after['locations'] == 2, json.dumps(after))
check('every Alpha row went (closed checks, tickets, menus, items, variants, tables, bookings, devices, customers, orders, staff, shifts)',
      one(f"select count(*) from public.closed_checks where location_id in ('{A1}', '{A2}')") == '0'
      and one(f"select count(*) from public.kds_tickets where location_id in ('{A1}', '{A2}')") == '0'
      and after['menus'] == 1 and after['menu_items'] == 1 and after['item_variants'] == 1
      and after['floor_tables'] == 1 and after['table_bookings'] == 1 and after['device_profiles'] == 1
      and after['customers'] == 1 and after['customer_orders'] == 1 and after['wf_staff'] == 1 and after['wf_shifts'] == 1, json.dumps(after))
check("Alpha's two logins lost their profiles, the super admin kept a profile with no company",
      after['user_profiles'] == 2 and one(f"select org_id is null and location_id is null from public.user_profiles where id = '{US}'") == 'true', json.dumps(after))
check('the wipe never touches auth.users (that is the edge function, through the admin API)', one('select count(*) from auth.users') == '4')
check('the transfer from Beta to Alpha stayed, pointing nowhere', one(f"select to_location_id is null from public.stock_transfers where note = 'from B to A'") == 'true')
check('the audit row of an Alpha person stayed, actor cleared; Beta and staff rows untouched', after['audit_log'] == 3 and one("select count(*) from public.audit_log where actor is null") == '1')
check('Beta came through untouched', b_rows() == b_before, b_rows() + ' vs ' + b_before)

print('== one venue of Beta')
rep = json.loads(tx(f"set local role service_role; select public.admin_wipe_locations(array['{B1}']::uuid[], false);"))
check('one venue wiped', rep.get('locations') == 1 and rep.get('profiles_unlinked') == 1, json.dumps(rep)[:300])
check('Beta One is gone and Beta Two, the Beta company and its customers stay',
      one(f"select count(*) from public.locations where id = '{B1}'") == '0' and one(f"select count(*) from public.locations where id = '{B2}'") == '1'
      and one(f"select count(*) from public.organisations where id = '{B}'") == '1' and one(f"select count(*) from public.customers where org_id = '{B}'") == '1')
check("Beta One's rows went, Beta Two's stayed",
      one(f"select count(*) from public.closed_checks where location_id = '{B1}'") == '0' and one(f"select count(*) from public.closed_checks where location_id = '{B2}'") == '1'
      and one(f"select count(*) from public.user_locations where location_id = '{B1}'") == '0' and one(f"select count(*) from public.user_locations where location_id = '{B2}'") == '1')
check("the Beta owner kept the profile, home venue cleared", one(f"select org_id = '{B}' and location_id is null from public.user_profiles where id = '{UB1}'") == 'true')
bad, msg = tx(f"set local role service_role; select public.admin_wipe_locations(array['{B1}']::uuid[], false);", want_error=True)
check('a venue already gone is refused by name', bad and 'not found' in msg, msg[:160])

print('== the Ops rollback')
ok, err = run_file(OPS_BACK)
check('the rollback applies', ok, err)
check('and the functions are gone', one("select count(*) from pg_proc where proname like 'admin_wipe%'") == '0')
ok, err = run_file(OPS)
check('the file applies again after the rollback', ok, err)

# ───────────────────────────────── Platform ─────────────────────────────────
C1 = A   # the Platform company shares the Ops organisation id
C2 = B
PLAT_SCHEMA = f"""
grant all on database pw to wipe_owner;
grant usage, create on schema public to wipe_owner;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role wipe_owner in schema public grant execute on functions to anon, authenticated, service_role;
{AS_OWNER}
create table public.companies (id uuid primary key, name text not null, slug text unique);
create table public.platform_users (id uuid primary key, email text);
create table public.locations (id uuid primary key default gen_random_uuid(), company_id uuid references public.companies(id) on delete cascade, ops_location_id uuid, name text);
create table public.billing_state (location_id uuid primary key references public.locations(id) on delete cascade, plan text);
create table public.payment_devices (id uuid primary key default gen_random_uuid(), location_id uuid references public.locations(id) on delete cascade, serial text);
create table public.adyen_payments (id uuid primary key default gen_random_uuid(), location_id uuid, amount numeric);
create table public.gift_cards (id uuid primary key, company_id uuid references public.companies(id) on delete cascade, code text);
create table public.gift_card_pins (card_id uuid primary key references public.gift_cards(id), pin text);
create table public.gift_card_purchases (id uuid primary key default gen_random_uuid(), company_id uuid references public.companies(id), location_id uuid, amount numeric);
create table public.web_sites (id uuid primary key, company_id uuid not null references public.companies(id), slug text);
create table public.web_posts (id uuid primary key default gen_random_uuid(), site_id uuid not null references public.web_sites(id), title text);
create table public.user_location_access (user_id uuid, location_id uuid references public.locations(id) on delete cascade);
insert into public.companies (id, name, slug) values ('{C1}', 'Alpha Cafe', 'alpha'), ('{C2}', 'Beta Bar', 'beta');
insert into public.locations (id, company_id, ops_location_id, name) values
  ('{A1}', '{C1}', '{A1}', 'Alpha One'),
  ('88888888-0000-0000-0000-0000000000a2', '{C1}', '{A2}', 'Alpha Two'),
  ('{B1}', '{C2}', '{B1}', 'Beta One');
insert into public.billing_state (location_id, plan) values ('{A1}', 'pro'), ('88888888-0000-0000-0000-0000000000a2', 'pro'), ('{B1}', 'pro');
insert into public.payment_devices (location_id, serial) values ('{A1}', 'S1'), ('{B1}', 'S2');
insert into public.adyen_payments (location_id, amount) values ('{A1}', 5), ('88888888-0000-0000-0000-0000000000a2', 6), ('{B1}', 7);
insert into public.gift_cards (id, company_id, code) values ('99999999-0000-0000-0000-0000000000a1', '{C1}', 'GA'), ('99999999-0000-0000-0000-0000000000b1', '{C2}', 'GB');
insert into public.gift_card_pins (card_id, pin) values ('99999999-0000-0000-0000-0000000000a1', '1'), ('99999999-0000-0000-0000-0000000000b1', '2');
insert into public.gift_card_purchases (company_id, location_id, amount) values ('{C1}', '{A1}', 10), ('{C2}', '{B1}', 10);
insert into public.web_sites (id, company_id, slug) values ('aaaa1111-0000-0000-0000-000000000001', '{C1}', 'alpha'), ('bbbb1111-0000-0000-0000-000000000001', '{C2}', 'beta');
insert into public.web_posts (site_id, title) values ('aaaa1111-0000-0000-0000-000000000001', 'Hi'), ('bbbb1111-0000-0000-0000-000000000001', 'Yo');
insert into public.user_location_access (user_id, location_id) values ('{UA1}', '{A1}'), ('{UB1}', '{B1}');
"""
PTABLES = ['companies', 'locations', 'billing_state', 'payment_devices', 'adyen_payments', 'gift_cards', 'gift_card_pins', 'gift_card_purchases', 'web_sites', 'web_posts', 'user_location_access']

print('== building the throwaway Platform database')
run('drop database if exists pw', db='postgres', owner=False)
run('create database pw', db='postgres', owner=False)
p = subprocess.run(PSQL + ['-d', 'pw', '-c', PLAT_SCHEMA], capture_output=True, text=True)
if p.returncode: print(p.stderr.strip()[-900:]); sys.exit(1)
pbefore = counts('pw', PTABLES)

print('== the Platform file')
ok, err = run_file(PLAT, db='pw')
check('the Platform file applies', ok, err)
ok2, err2 = run_file(PLAT, db='pw')
check('and applies twice', ok2, err2)
bad, msg = run_file(PLAT, db='ow')
check('the Platform file refuses the Ops database', not bad and 'not the Platform database' in msg, msg[:160])
bad, msg = run_file(OPS, db='pw')
check('the Ops file refuses the Platform database', not bad and 'not the Ops database' in msg, msg[:160])
check('a login cannot run the Platform wipe', one("has_function_privilege('authenticated', 'public.admin_wipe_platform_company(uuid, boolean)', 'execute')", 'pw') == 'false')

print('== Platform: the company is refused while it has venues, the venues go by Ops id, then the company')
bad, msg = tx(f"set local role service_role; select public.admin_wipe_platform_company('{C1}', false);", db='pw', want_error=True)
check('the company wipe is refused while locations remain', bad and 'Wipe the locations first' in msg, msg[:160])
dry = json.loads(tx(f"set local role service_role; select public.admin_wipe_platform_locations(array['{A1}', '{A2}']::uuid[], true);", db='pw'))
check('dry run finds both Alpha venues, one by id and one by ops_location_id', dry.get('locations') == 2 and (dry.get('tables') or {}).get('adyen_payments') == 2 and (dry.get('tables') or {}).get('billing_state') == 2, json.dumps(dry)[:300])
check('dry run changed nothing', counts('pw', PTABLES) == pbefore)
rep = json.loads(tx(f"set local role service_role; select public.admin_wipe_platform_locations(array['{A1}', '{A2}']::uuid[], false);", db='pw'))
check('Alpha venues wiped on the Platform', rep.get('locations') == 2 and one(f"select count(*) from public.locations where company_id = '{C1}'", 'pw') == '0', json.dumps(rep)[:300])
check('their payments, devices, billing and access rows went; Beta kept its own',
      one(f"select count(*) from public.adyen_payments where location_id = '{B1}'", 'pw') == '1' and one("select count(*) from public.adyen_payments", 'pw') == '1'
      and one("select count(*) from public.payment_devices", 'pw') == '1' and one("select count(*) from public.billing_state", 'pw') == '1' and one("select count(*) from public.user_location_access", 'pw') == '1')
rep = json.loads(tx(f"set local role service_role; select public.admin_wipe_platform_company('{C1}', false);", db='pw'))
check('the company wipe takes the gift cards, pins, purchases, site and posts', rep.get('company') is True and (rep.get('tables') or {}).get('gift_card_pins') == 1 and (rep.get('tables') or {}).get('web_posts') == 1 and (rep.get('tables') or {}).get('companies') == 1, json.dumps(rep)[:300])
pafter = counts('pw', PTABLES)
check('Alpha is gone from the Platform and Beta is whole', pafter == {'companies': 1, 'locations': 1, 'billing_state': 1, 'payment_devices': 1, 'adyen_payments': 1, 'gift_cards': 1, 'gift_card_pins': 1, 'gift_card_purchases': 1, 'web_sites': 1, 'web_posts': 1, 'user_location_access': 1}, json.dumps(pafter))
rep = json.loads(tx(f"set local role service_role; select public.admin_wipe_platform_company('{C1}', false);", db='pw'))
check('a company already gone answers company false and deletes nothing', rep.get('company') is False and rep.get('total') == 0, json.dumps(rep))
rep = json.loads(tx(f"set local role service_role; select public.admin_wipe_platform_locations(array['{A1}']::uuid[], false);", db='pw'))
check('a venue with no Platform row answers 0 locations', rep.get('locations') == 0, json.dumps(rep))

print('== the Platform rollback')
ok, err = run_file(PLAT_BACK, db='pw')
check('the rollback applies', ok, err)
check('and the functions are gone', one("select count(*) from pg_proc where proname like 'admin_wipe%'", 'pw') == '0')

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
