#!/usr/bin/env python3
# Builds a LOCAL throwaway copy of the live Ops shape (tables, constraints, policies,
# functions, triggers, grants) from read only catalog dumps, for offline testing of the
# fence migrations. Nothing here ever touches a Supabase project.
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
cols = json.load(open(os.path.join(HERE, 'schema', 'columns.json')))
cons = json.load(open(os.path.join(HERE, 'schema', 'constraints.json')))
pols = json.load(open(os.path.join(HERE, 'schema', 'policies.json')))
fns = json.load(open(os.path.join(HERE, 'schema', 'functions.json')))
trg = json.load(open(os.path.join(HERE, 'schema', 'triggers.json')))
grants = json.load(open(os.path.join(HERE, 'schema', 'grants.json')))
_ix_path = os.path.join(HERE, 'schema', 'indexes.json')
idxs = json.load(open(_ix_path)) if os.path.exists(_ix_path) else []

out = []
w = out.append

w("""
-- roles like Supabase
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists net;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
create table if not exists auth.users (
  id uuid primary key, email text, is_anonymous boolean not null default false,
  created_at timestamptz not null default now(), raw_user_meta_data jsonb default '{}'::jsonb
);
create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), refreshed_at timestamp, ip inet, user_agent text
);
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$f$;
create or replace function auth.role() returns text language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$f$;
create or replace function auth.jwt() returns jsonb language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$f$;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;
create or replace function extensions.uuid_generate_v4() returns uuid language sql volatile as $f$ select gen_random_uuid() $f$;
grant execute on function extensions.uuid_generate_v4() to anon, authenticated, service_role;
create or replace function net.http_post(url text, body jsonb, headers jsonb) returns bigint language sql as $f$ select 1::bigint $f$;
create sequence if not exists public.venue_code_seq;
grant usage on sequence public.venue_code_seq to anon, authenticated, service_role;
-- minimal extra tables some functions read
create table if not exists public.floor_table_tombstones (location_id text, table_id text, deleted_at timestamptz);
create table if not exists public.menu_board_screens (id uuid primary key default gen_random_uuid(), device_uid uuid, status text, order_display_id uuid, location_id uuid);
""")

# tables
tables = {}
for c in cols:
    tables.setdefault(c['t'], []).append(c)
order = ['organisations', 'locations', 'user_profiles', 'user_locations', 'devices', 'device_heartbeats',
         'ops_devices', 'waitlist_devices', 'staff_members', 'floor_tables', 'order_queue', 'closed_checks',
         'kds_tickets', 'print_jobs', 'active_sessions', 'table_reservations', 'bar_tabs', 'activity_events',
         'order_status_marks', 'order_status_pings', 'subscriptions',
         # fix round 2: what the server's own order valuation reads
         'menu_items', 'modifier_groups', 'discount_rules', 'offers', 'promo_codes', 'promo_redemptions',
         'loyalty_transactions', 'stamp_transactions']
for t in order:
    if t not in tables:
        continue
    parts = []
    for c in tables[t]:
        s = f'  "{c["col"]}" {c["typ"]}'
        if c['def'] is not None:
            s += f' default {c["def"]}'
        if c['nn']:
            s += ' not null'
        parts.append(s)
    w(f'create table public.{t} (\n' + ',\n'.join(parts) + '\n);')

# constraints: p, u, c first, then f (only when both ends exist)
known = set(tables.keys())
for kind in ('p', 'u', 'c', 'f'):
    for c in cons:
        if c['contype'] != kind:
            continue
        t = c['t']
        if kind == 'f':
            m = re.search(r'REFERENCES\s+([a-z_.]+)\(', c['def'])
            ref = m.group(1).split('.')[-1] if m else None
            if ref == 'users' and 'auth.users' in c['def']:
                pass
            elif ref not in known:
                continue
            d = c['def']
            if 'REFERENCES users(' in d:
                d = d.replace('REFERENCES users(', 'REFERENCES auth.users(')
            w(f'alter table public.{t} add constraint "{c["conname"]}" {d};')
        else:
            w(f'alter table public.{t} add constraint "{c["conname"]}" {c["def"]};')

# unique indexes that are not constraints (promo code, idempotency keys)
for ix in idxs:
    if ix['t'] in tables:
        w(ix['def'] + ';')

# functions (order matters little for plpgsql; sql functions are validated at create time)
sql_first = ['is_anon_session', 'is_super_admin', 'user_accessible_locations', 'user_accessible_orgs',
             '_terminal_user_has_location']
done = set()
for name in sql_first:
    for f in fns:
        if f['proname'] == name:
            w(f['def'].rstrip() + ';')
            done.add((f['proname'], f['args']))
for f in fns:
    if (f['proname'], f['args']) in done:
        continue
    w(f['def'].rstrip() + ';')

# RLS + policies
for t in order:
    if t in tables:
        w(f'alter table public.{t} enable row level security;')
for p in pols:
    if p['t'] == 'order_status_pings':
        continue
    roles = p['roles'].strip('{}')
    s = f'create policy "{p["p"]}" on public.{p["t"]} as {p["permissive"].lower()} for {p["cmd"].lower()} to {roles}'
    if p['qual'] is not None:
        s += f' using ({p["qual"]})'
    if p['with_check'] is not None:
        s += f' with check ({p["with_check"]})'
    w(s + ';')

# triggers (skip floor_tables ones, they need more schema)
for t in trg:
    if t['t'] == 'floor_tables':
        continue
    w(t['def'] + ';')

# grants: Supabase default is everything to anon, authenticated, service_role
w('grant all on all tables in schema public to anon, authenticated, service_role;')
w('grant all on all sequences in schema public to anon, authenticated, service_role;')
w('grant execute on all functions in schema public to anon, authenticated, service_role;')
for g in grants:
    t, role, privs = g['t'], g['role'], set(filter(None, g['privs'].split(',')))
    allp = {'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'}
    missing = allp - privs
    if missing:
        w(f'revoke {", ".join(sorted(missing)).lower()} on public.{t} from {role};')
    if g['col_upd']:
        w(f'grant update ({g["col_upd"]}) on public.{t} to {role};')
for f in fns:
    sig = f'public.{f["proname"]}({f["args"]})'
    if f.get('acl'):
        # Fix round 2: the live ACL exactly (PUBLIC included), so the roll back test can
        # compare function grants item by item.
        w(f'revoke all on function {sig} from public, anon, authenticated, service_role;')
        for item in f['acl'].strip('{}').split(','):
            grantee, _, rest = item.partition('=')
            privs = rest.split('/')[0]
            if 'X' not in privs or grantee == 'postgres':
                continue
            w(f'grant execute on function {sig} to {grantee or "public"};')
        continue
    if not f['anon_x']:
        w(f'revoke execute on function {sig} from public, anon;')
    if not f['auth_x']:
        w(f'revoke execute on function {sig} from authenticated;')

open(os.path.join(HERE, '.baseline.sql'), 'w').write('\n'.join(out) + '\n')
print('wrote .baseline.sql', len(out), 'statements')
