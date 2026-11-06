#!/usr/bin/env python3
"""Offline test for 20261126a_OPS_customer_app.sql and 20261126b_PLATFORM_customer_app.sql.

Runs both real files (twice each: safe to run twice) against a throwaway local Postgres 17 whose
tables copy the SHAPES that matter: the Ops customers row with every personal column, the
venue notes, the ledgers and checks that must survive, the Platform membership and stamp cards,
a referred member, a gift card, and a second customer who must come through untouched. Then the
rollbacks, then the files again.

    initdb -D /tmp/cadata -U postgres --auth=trust -E UTF8
    pg_ctl -D /tmp/cadata -o "-p 55997 -c listen_addresses=127.0.0.1" start
    LC_ALL=en_US.UTF-8 python3 test_customer_app.py     # CA_PGHOST / CA_PGPORT override the address
"""
import json
import os
import pathlib
import subprocess
import sys

HOST = os.environ.get('CA_PGHOST', '127.0.0.1')
PORT = os.environ.get('CA_PGPORT', '55997')
PSQL = ['psql', '-h', HOST, '-p', PORT, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q']
HERE = pathlib.Path(__file__).resolve().parent
MIGS = HERE.parent.parent / 'migrations'
OPS = MIGS / '20261126a_OPS_customer_app.sql'
OPS_BACK = MIGS / '20261126a_OPS_customer_app_ROLLBACK.sql'
PLAT = MIGS / '20261126b_PLATFORM_customer_app.sql'
PLAT_BACK = MIGS / '20261126b_PLATFORM_customer_app_ROLLBACK.sql'

passed = failed = 0
# Everything runs as ca_owner: like Supabase's postgres role, not a superuser, bypasses RLS,
# owns the tables and the functions.
AS_OWNER = 'set role ca_owner;'


def run(sql, db, want_error=False, owner=True):
    body = (AS_OWNER if owner else '') + sql
    p = subprocess.run(PSQL + ['-d', db, '-c', body], capture_output=True, text=True)
    if want_error:
        return p.returncode != 0, p.stderr.strip()
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip()[-900:])
    return p.stdout.strip()


def run_file(path, db):
    p = subprocess.run(PSQL + ['-d', db, '-1', '-c', AS_OWNER, '-f', str(path)], capture_output=True, text=True)
    return p.returncode == 0, (p.stderr.strip() or p.stdout.strip())[-900:]


def one(sql, db):
    p = subprocess.run(PSQL + ['-t', '-A', '-d', db, '-c', AS_OWNER + f"select ({sql})::text"], capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(p.stderr.strip())
    return p.stdout.strip()


def as_role(role, sql, db):
    """Run as anon / authenticated / service_role; (ok, stderr or stdout)."""
    body = f'set role {role}; ' + sql
    p = subprocess.run(PSQL + ['-t', '-A', '-d', db, '-c', body], capture_output=True, text=True)
    return p.returncode == 0, (p.stderr.strip() or p.stdout.strip())


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
  if not exists (select 1 from pg_roles where rolname = 'ca_owner') then create role ca_owner nologin bypassrls createrole; end if;
end
$roles$;
"""

ORG = 'aaaaaaaa-0000-4000-8000-00000000000a'
ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
LOC = '11111111-0000-4000-8000-000000000001'
CO = 'cccccccc-0000-4000-8000-000000000001'
ALICE = '66666666-0000-4000-8000-0000000000a1'   # deletes her account
BELLA = '66666666-0000-4000-8000-0000000000b1'   # untouched
CARL = '66666666-0000-4000-8000-0000000000c1'    # referred by Alice
PROG = '77777777-0000-4000-8000-000000000001'
HASH1 = 'a' * 64
HASH2 = 'b' * 64
HASH3 = 'c' * 64


def grants(db):
    return f"""
grant all on database {db} to ca_owner;
grant usage, create on schema public to ca_owner;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role ca_owner in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges for role ca_owner in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;
"""


OPS_SCHEMA = grants('ca_ops') + f"""
{AS_OWNER}
create table public.organisations (id uuid primary key, name text not null, slug text);
create table public.locations (id uuid primary key, org_id uuid references public.organisations(id), name text, status text default 'active', is_demo boolean default false);
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  phone text, phone_raw text, email text, name text not null, notes text,
  marketing_opt_in boolean default false, marketing_opt_in_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now(), deleted_at timestamptz,
  allergens text[] default '{{}}', birthday date, welcome_sent_at timestamptz,
  first_name text, last_name text, is_local boolean, source text, sources text[] default '{{}}' not null,
  tags text[] default '{{}}', no_shows integer not null default 0, shopper_reference text, stored_payment_method_id text);
create table public.customer_locations (customer_id uuid not null, location_id uuid not null, first_visit_at timestamptz, last_visit_at timestamptz, visit_count integer default 0, lifetime_revenue numeric default 0, notes text);
create table public.closed_checks (id text primary key, location_id text not null, customer_id uuid, total numeric);
create table public.customer_orders (id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.customers(id), location_id text, total numeric);
create table public.loyalty_transactions (id uuid primary key default gen_random_uuid(), customer_id uuid not null, company_id uuid not null, location_id text not null, type text not null, points integer not null, balance_after integer not null, created_at timestamptz default now());
create table public.stamp_transactions (id uuid primary key default gen_random_uuid(), customer_id uuid not null, program_id uuid not null, location_id uuid not null, stamps integer default 1, type text default 'earn', created_at timestamptz default now());
alter table public.customers enable row level security;
"""

OPS_SEED = f"""
{AS_OWNER}
insert into public.organisations (id, name, slug) values ('{ORG}', 'Alpha Cafe', 'alpha'), ('{ORG_B}', 'Beta Bar', 'beta');
insert into public.locations (id, org_id, name) values ('{LOC}', '{ORG}', 'Alpha One');
insert into public.customers (id, org_id, phone, phone_raw, email, name, notes, marketing_opt_in, marketing_opt_in_at, allergens, birthday, first_name, last_name, is_local, tags, shopper_reference, stored_payment_method_id) values
  ('{ALICE}', '{ORG}', '+447700900001', '07700 900001', 'alice@x', 'Alice Smith', 'likes window seat', true, now(), '{{nuts}}', '1990-01-02', 'Alice', 'Smith', true, '{{vip}}', 'shop_1', 'pm_1'),
  ('{BELLA}', '{ORG}', '+447700900002', '07700 900002', 'bella@x', 'Bella Jones', 'regular', true, now(), '{{}}', '1991-02-03', 'Bella', 'Jones', false, '{{}}', 'shop_2', 'pm_2');
insert into public.customer_locations (customer_id, location_id, visit_count, lifetime_revenue, notes) values
  ('{ALICE}', '{LOC}', 12, 240.50, 'prefers oat milk'), ('{BELLA}', '{LOC}', 3, 30, 'ask about dog');
insert into public.closed_checks (id, location_id, customer_id, total) values ('R1', '{LOC}', '{ALICE}', 10), ('R2', '{LOC}', '{ALICE}', 20), ('R3', '{LOC}', '{BELLA}', 30);
insert into public.customer_orders (customer_id, location_id, total) values ('{ALICE}', '{LOC}', 9), ('{ALICE}', '{LOC}', 11), ('{BELLA}', '{LOC}', 9);
insert into public.loyalty_transactions (customer_id, company_id, location_id, type, points, balance_after) values
  ('{ALICE}', '{CO}', '{LOC}', 'earn', 100, 100), ('{ALICE}', '{CO}', '{LOC}', 'earn', 350, 450), ('{BELLA}', '{CO}', '{LOC}', 'earn', 10, 10);
insert into public.stamp_transactions (customer_id, program_id, location_id, stamps, type) values
  ('{ALICE}', '{PROG}', '{LOC}', 1, 'earn'), ('{ALICE}', '{PROG}', '{LOC}', 1, 'earn'), ('{BELLA}', '{PROG}', '{LOC}', 1, 'earn');
insert into public.customer_app_sessions (customer_id, company_id, refresh_token_hash) values
  ('{ALICE}', '{CO}', '{HASH1}'), ('{ALICE}', '{CO}', '{HASH2}'), ('{BELLA}', '{CO}', '{HASH3}');
update public.customer_app_sessions set revoked_at = now() where refresh_token_hash = '{HASH2}';
"""

PLAT_SCHEMA = grants('ca_plat') + f"""
{AS_OWNER}
create table public.companies (id uuid primary key, name text not null);
create table public.loyalty_tiers (id uuid primary key default gen_random_uuid(), company_id uuid, name text);
create table public.stamp_card_programs (id uuid primary key, company_id uuid not null, name text);
create table public.customer_loyalty (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null, company_id uuid not null references public.companies(id) on delete cascade,
  points_balance integer default 0, points_earned_total integer default 0, points_redeemed_total integer default 0,
  tier_id uuid references public.loyalty_tiers(id) on delete set null, visit_count integer default 0,
  member_code text unique, referral_code text unique, referred_by uuid references public.customer_loyalty(id) on delete set null,
  wallet_pass_serial text, enrolled_at timestamptz default now(),
  constraint customer_loyalty_customer_id_company_id_key unique (customer_id, company_id));
create table public.customer_stamp_cards (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null, program_id uuid not null references public.stamp_card_programs(id) on delete cascade,
  company_id uuid not null, stamps_collected integer default 0, completed_count integer default 0, last_stamp_at timestamptz);
create table public.gift_cards (id uuid primary key default gen_random_uuid(), company_id uuid not null, code text, recipient_phone text, balance_minor integer, status text default 'active');
create table public.gift_card_transactions (id uuid primary key default gen_random_uuid(), gift_card_id uuid references public.gift_cards(id), amount_minor integer);
alter table public.customer_loyalty enable row level security;
"""

PLAT_SEED = f"""
{AS_OWNER}
insert into public.companies (id, name) values ('{CO}', 'Alpha Cafe');
insert into public.stamp_card_programs (id, company_id, name) values ('{PROG}', '{CO}', 'Coffee card');
insert into public.customer_loyalty (id, customer_id, company_id, points_balance, points_earned_total, member_code, referral_code, wallet_pass_serial) values
  ('88888888-0000-4000-8000-0000000000a1', '{ALICE}', '{CO}', 450, 450, 'SRV-ALICE1', 'REFALICE', 'serial-a'),
  ('88888888-0000-4000-8000-0000000000b1', '{BELLA}', '{CO}', 10, 10, 'SRV-BELLA1', 'REFBELLA', null);
insert into public.customer_loyalty (id, customer_id, company_id, points_balance, member_code, referral_code, referred_by) values
  ('88888888-0000-4000-8000-0000000000c1', '{CARL}', '{CO}', 5, 'SRV-CARL01', 'REFCARL0', '88888888-0000-4000-8000-0000000000a1');
insert into public.customer_stamp_cards (customer_id, program_id, company_id, stamps_collected, completed_count) values
  ('{ALICE}', '{PROG}', '{CO}', 7, 1), ('{BELLA}', '{PROG}', '{CO}', 2, 0);
insert into public.gift_cards (id, company_id, code, recipient_phone, balance_minor) values
  ('99999999-0000-4000-8000-000000000001', '{CO}', 'GIFT-ALICE', '+447700900001', 2500);
insert into public.gift_card_transactions (gift_card_id, amount_minor) values ('99999999-0000-4000-8000-000000000001', 2500);
"""


def main():
    run('drop database if exists ca_ops;', 'postgres', owner=False)
    run('drop database if exists ca_plat;', 'postgres', owner=False)
    run(ROLES, 'postgres', owner=False)
    run('create database ca_ops;', 'postgres', owner=False)
    run('create database ca_plat;', 'postgres', owner=False)
    run(OPS_SCHEMA, 'ca_ops', owner=False)
    run(PLAT_SCHEMA, 'ca_plat', owner=False)

    # ── The files apply, twice, on each database ────────────────────────
    ok, msg = run_file(OPS, 'ca_ops')
    check('Ops file applies', ok, msg)
    ok, msg = run_file(OPS, 'ca_ops')
    check('Ops file applies a second time', ok, msg)
    ok, msg = run_file(PLAT, 'ca_plat')
    check('Platform file applies', ok, msg)
    ok, msg = run_file(PLAT, 'ca_plat')
    check('Platform file applies a second time', ok, msg)
    # each file refuses the other database
    ok, msg = run_file(OPS, 'ca_plat')
    check('Ops file refuses the Platform database', not ok and 'not the Ops database' in msg, msg)
    ok, msg = run_file(PLAT, 'ca_ops')
    check('Platform file refuses the Ops database', not ok and 'not the Platform database' in msg, msg)

    # ── Who may call ────────────────────────────────────────────────────
    for role in ('anon', 'authenticated'):
        ok, msg = as_role(role, f"select public.customer_app_delete_account('{ALICE}');", 'ca_ops')
        check(f'{role} cannot run delete_account', not ok and 'permission denied' in msg, msg)
        ok, msg = as_role(role, f"select public.customer_app_end_loyalty('{ALICE}');", 'ca_plat')
        check(f'{role} cannot run end_loyalty', not ok and 'permission denied' in msg, msg)
        ok, msg = as_role(role, 'select count(*) from public.customer_app_sessions;', 'ca_ops')
        check(f'{role} cannot read customer_app_sessions', not ok and 'permission denied' in msg, msg)
        ok, msg = as_role(role, 'select count(*) from public.tenant_app_config;', 'ca_ops')
        check(f'{role} cannot read tenant_app_config', not ok and 'permission denied' in msg, msg)
        ok, msg = as_role(role, "insert into public.tenant_app_config (tenant_id, org_id) values ('evil', '" + ORG + "');", 'ca_ops')
        check(f'{role} cannot write tenant_app_config', not ok and 'permission denied' in msg, msg)
    ok, msg = as_role('service_role', 'select count(*) from public.customer_app_sessions;', 'ca_ops')
    check('service_role reads customer_app_sessions', ok, msg)

    # ── Seed ────────────────────────────────────────────────────────────
    run(OPS_SEED, 'ca_ops', owner=False)
    run(PLAT_SEED, 'ca_plat', owner=False)

    # ── Sessions table shape ────────────────────────────────────────────
    exp = one(f"select extract(epoch from (expires_at - created_at)) / 86400 from public.customer_app_sessions where refresh_token_hash = '{HASH1}'", 'ca_ops')
    # within an hour: interval '180 days' keeps the wall time, so a clock change inside the span moves it by one hour
    check('a session expires 180 days after it is made', abs(float(exp) - 180) < 0.05, exp)
    ok, msg = run("insert into public.customer_app_sessions (customer_id, company_id, refresh_token_hash) values ('" + ALICE + "', '" + CO + "', 'not-a-hash');", 'ca_ops', want_error=True)
    check('a refresh token hash must be 64 hex characters', ok and 'customer_app_sessions_hash_shape' in msg, msg)
    ok, msg = run("insert into public.customer_app_sessions (customer_id, company_id, refresh_token_hash) values ('" + ALICE + "', '" + CO + "', '" + HASH1 + "');", 'ca_ops', want_error=True)
    check('the same hash cannot be stored twice', ok and 'customer_app_sessions_hash_key' in msg, msg)
    fam = one("select count(distinct family_id) from public.customer_app_sessions", 'ca_ops')
    check('every row gets its own family by default', fam == '3', fam)

    # ── Tenant config: the pattern and the version trigger ─────────────
    for bad in ('Mozz', '1abc', 'a', 'mozz app', 'x' * 33):
        ok, msg = run(f"insert into public.tenant_app_config (tenant_id, org_id) values ('{bad}', '{ORG}');", 'ca_ops', want_error=True)
        check(f'tenant id {bad!r} is refused', ok and 'tenant_app_config_tenant_id_shape' in msg, msg)
    run(f"insert into public.tenant_app_config (tenant_id, org_id, payload) values ('mozz', '{ORG}', '{{\"displayName\": \"MOZZ\"}}');", 'ca_ops')
    check('a new tenant row starts at version 1', one("select version from public.tenant_app_config where tenant_id = 'mozz'", 'ca_ops') == '1')
    run("update public.tenant_app_config set payload = '{\"displayName\": \"MOZZ\", \"currency\": \"GBP\"}' where tenant_id = 'mozz';", 'ca_ops')
    check('a payload change bumps version to 2', one("select version from public.tenant_app_config where tenant_id = 'mozz'", 'ca_ops') == '2')
    run("update public.tenant_app_config set payload = '{\"currency\": \"GBP\", \"displayName\": \"MOZZ\"}' where tenant_id = 'mozz';", 'ca_ops')
    check('the same payload in another key order is not a change', one("select version from public.tenant_app_config where tenant_id = 'mozz'", 'ca_ops') == '2')
    run("update public.tenant_app_config set version = 99 where tenant_id = 'mozz';", 'ca_ops')
    check('version cannot be set by hand', one("select version from public.tenant_app_config where tenant_id = 'mozz'", 'ca_ops') == '2')
    run("update public.tenant_app_config set payload = '{}' where tenant_id = 'mozz';", 'ca_ops')
    check('another payload change bumps to 3', one("select version from public.tenant_app_config where tenant_id = 'mozz'", 'ca_ops') == '3')
    ok, msg = run("insert into public.tenant_app_config (tenant_id, org_id) values ('ghost', 'dddddddd-0000-4000-8000-00000000000d');", 'ca_ops', want_error=True)
    check('a tenant must point at a real organisation', ok and 'violates foreign key' in msg, msg)

    # ── Delete my account: Platform half ────────────────────────────────
    before_gift = one("select count(*) from public.gift_cards", 'ca_plat') + '|' + one("select count(*) from public.gift_card_transactions", 'ca_plat')
    rep = json.loads(one(f"select public.customer_app_end_loyalty('{ALICE}')", 'ca_plat'))
    check('end_loyalty answers ok', rep.get('ok') is True, rep)
    check('one membership ended, 450 points forfeited', rep.get('memberships_ended') == 1 and rep.get('points_forfeited') == 450, rep)
    check('one stamp card ended, 7 stamps forfeited', rep.get('stamp_cards_ended') == 1 and rep.get('stamps_forfeited') == 7, rep)
    check('the member Alice referred is unlinked, not deleted', rep.get('referrals_unlinked') == 1 and one(f"select count(*) from public.customer_loyalty where customer_id = '{CARL}' and referred_by is null", 'ca_plat') == '1', rep)
    check('Alice has no membership left', one(f"select count(*) from public.customer_loyalty where customer_id = '{ALICE}'", 'ca_plat') == '0')
    check('Alice has no stamp card left', one(f"select count(*) from public.customer_stamp_cards where customer_id = '{ALICE}'", 'ca_plat') == '0')
    check('Bella keeps her membership and stamps', one(f"select points_balance from public.customer_loyalty where customer_id = '{BELLA}'", 'ca_plat') == '10' and one(f"select stamps_collected from public.customer_stamp_cards where customer_id = '{BELLA}'", 'ca_plat') == '2')
    check('gift cards and their ledger survive', before_gift == one("select count(*) from public.gift_cards", 'ca_plat') + '|' + one("select count(*) from public.gift_card_transactions", 'ca_plat'))
    rep2 = json.loads(one(f"select public.customer_app_end_loyalty('{ALICE}')", 'ca_plat'))
    check('a second end_loyalty finds nothing and still answers ok', rep2.get('ok') is True and rep2.get('memberships_ended') == 0 and rep2.get('points_forfeited') == 0, rep2)

    # ── Delete my account: Ops half ─────────────────────────────────────
    sig_before = '|'.join([
        one("select count(*) from public.closed_checks", 'ca_ops'),
        one(f"select sum(total) from public.closed_checks where customer_id = '{ALICE}'", 'ca_ops'),
        one(f"select count(*) from public.customer_orders where customer_id = '{ALICE}'", 'ca_ops'),
        one(f"select sum(points) from public.loyalty_transactions where customer_id = '{ALICE}'", 'ca_ops'),
        one(f"select count(*) from public.stamp_transactions where customer_id = '{ALICE}'", 'ca_ops'),
        one(f"select visit_count || '/' || lifetime_revenue from public.customer_locations where customer_id = '{ALICE}'", 'ca_ops'),
    ])
    bella_before = one(f"select row(phone, email, name, notes, marketing_opt_in, deleted_at, first_name, tags)::text from public.customers where id = '{BELLA}'", 'ca_ops')
    rep = json.loads(one(f"select public.customer_app_delete_account('{ALICE}')", 'ca_ops'))
    check('delete_account answers ok', rep.get('ok') is True and rep.get('already_deleted') is False, rep)
    check('one customer row updated', rep.get('customers_updated') == 1, rep)
    cleared = set(rep.get('personal_columns_cleared') or [])
    want = {'name', 'email', 'phone', 'birthday', 'notes', 'marketing_opt_in', 'phone_raw', 'first_name', 'last_name', 'marketing_opt_in_at', 'shopper_reference', 'stored_payment_method_id', 'is_local', 'allergens', 'tags'}
    check('every personal column named in the report', cleared == want, sorted(cleared ^ want))
    row = one(f"select row(name, phone, phone_raw, email, notes, marketing_opt_in, marketing_opt_in_at, birthday, first_name, last_name, is_local, shopper_reference, stored_payment_method_id, allergens, tags, deleted_at is not null)::text from public.customers where id = '{ALICE}'", 'ca_ops')
    check('the personal fields are gone, the name is the placeholder, deleted_at is set', row == '("Deleted customer",,,,,f,,,,,,,,{},{},t)', row)
    check('the venue notes about Alice are gone', rep.get('notes_cleared') == 1 and one(f"select notes is null from public.customer_locations where customer_id = '{ALICE}'", 'ca_ops') == 'true', rep)
    check('the one live app session is revoked (the revoked one is not counted twice)', rep.get('sessions_revoked') == 1 and one(f"select count(*) from public.customer_app_sessions where customer_id = '{ALICE}' and revoked_at is null", 'ca_ops') == '0', rep)
    check("Bella's session is still live", one(f"select count(*) from public.customer_app_sessions where customer_id = '{BELLA}' and revoked_at is null", 'ca_ops') == '1')
    sig_after = '|'.join([
        one("select count(*) from public.closed_checks", 'ca_ops'),
        one(f"select sum(total) from public.closed_checks where customer_id = '{ALICE}'", 'ca_ops'),
        one(f"select count(*) from public.customer_orders where customer_id = '{ALICE}'", 'ca_ops'),
        one(f"select sum(points) from public.loyalty_transactions where customer_id = '{ALICE}'", 'ca_ops'),
        one(f"select count(*) from public.stamp_transactions where customer_id = '{ALICE}'", 'ca_ops'),
        one(f"select visit_count || '/' || lifetime_revenue from public.customer_locations where customer_id = '{ALICE}'", 'ca_ops'),
    ])
    check('closed checks, orders, loyalty and stamp ledgers, visits and revenue survive', sig_before == sig_after, f'{sig_before} != {sig_after}')
    check('Bella is untouched', bella_before == one(f"select row(phone, email, name, notes, marketing_opt_in, deleted_at, first_name, tags)::text from public.customers where id = '{BELLA}'", 'ca_ops'))
    rep2 = json.loads(one(f"select public.customer_app_delete_account('{ALICE}')", 'ca_ops'))
    check('a second delete_account says already deleted and revokes nothing more', rep2.get('ok') is True and rep2.get('already_deleted') is True and rep2.get('sessions_revoked') == 0 and rep2.get('notes_cleared') == 0, rep2)
    check('deleted_at did not move on the second run', one(f"select (select deleted_at from public.customers where id = '{ALICE}') = (select min(deleted_at) from public.customers where id = '{ALICE}')", 'ca_ops') == 'true')
    rep3 = json.loads(one("select public.customer_app_delete_account('dddddddd-0000-4000-8000-00000000000d')", 'ca_ops'))
    check('an unknown customer answers not_found, ok false', rep3.get('ok') is False and rep3.get('code') == 'not_found', rep3)
    ok, msg = run('select public.customer_app_delete_account(null);', 'ca_ops', want_error=True)
    check('a null customer id raises', ok and 'customer id required' in msg, msg)

    # a customers table without the optional columns still works (an older database)
    run("alter table public.customers drop column shopper_reference, drop column stored_payment_method_id, drop column tags;", 'ca_ops')
    rep4 = json.loads(one(f"select public.customer_app_delete_account('{BELLA}')", 'ca_ops'))
    check('delete works when optional personal columns are missing', rep4.get('ok') is True and 'tags' not in (rep4.get('personal_columns_cleared') or []) and 'first_name' in (rep4.get('personal_columns_cleared') or []), rep4)

    # ── Rollbacks, then the files again ─────────────────────────────────
    ok, msg = run_file(OPS_BACK, 'ca_ops')
    check('Ops rollback applies', ok, msg)
    check('Ops rollback left no table or function', one("select count(*) from pg_tables where schemaname = 'public' and tablename in ('customer_app_sessions', 'tenant_app_config')", 'ca_ops') == '0'
          and one("select count(*) from pg_proc where proname in ('customer_app_delete_account', 'tenant_app_config_bump')", 'ca_ops') == '0')
    ok, msg = run_file(OPS_BACK, 'ca_ops')
    check('Ops rollback applies a second time', ok, msg)
    ok, msg = run_file(PLAT_BACK, 'ca_plat')
    check('Platform rollback applies', ok, msg)
    check('Platform rollback left no function', one("select count(*) from pg_proc where proname = 'customer_app_end_loyalty'", 'ca_plat') == '0')
    ok, msg = run_file(PLAT_BACK, 'ca_plat')
    check('Platform rollback applies a second time', ok, msg)
    ok, msg = run_file(OPS, 'ca_ops')
    check('Ops file applies again after the rollback', ok, msg)
    ok, msg = run_file(PLAT, 'ca_plat')
    check('Platform file applies again after the rollback', ok, msg)
    check('the customers rows survived the rollback', one("select count(*) from public.customers", 'ca_ops') == '2')

    print(f'\n{passed} passed, {failed} failed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
