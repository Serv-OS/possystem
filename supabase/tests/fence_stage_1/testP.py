#!/usr/bin/env python3
"""LOCAL test of the two Platform files on a throwaway database (never Supabase)."""
import json, os
import t
from t import run, expect, last

HERE = os.path.dirname(os.path.abspath(__file__))

def build_platform():
    """A throwaway copy of the Platform tables the two files touch, with the live policies
    and the live anon and authenticated grants (schema/p_*.json, read only catalog dumps)."""
    cols = json.load(open(os.path.join(HERE, 'schema', 'p_columns.json')))
    pols = json.load(open(os.path.join(HERE, 'schema', 'p_policies.json')))
    grants_path = os.path.join(HERE, 'schema', 'p_grants.json')
    grants = json.load(open(grants_path)) if os.path.exists(grants_path) else None
    run('drop database if exists plat', db='postgres')
    run('create database plat', db='postgres')
    ddl = ["""
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $f$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $f$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create table public.user_company_roles (user_id uuid, company_id uuid);
create table public.user_location_access (user_id uuid, location_id uuid);
create table public.gift_card_transactions (id uuid default gen_random_uuid(), card_id uuid, created_at timestamptz default now());
"""]
    tables = {}
    for c in cols:
        tables.setdefault(c['t'], []).append(c)
    for tname, cs in tables.items():
        parts = []
        for c in cs:
            s = f'"{c["col"]}" {c["typ"]}'
            if c['def'] is not None and 'nextval' not in c['def']:
                s += f' default {c["def"]}'
            if tname == 'location_reader_settings' and c['col'] == 'location_id':
                s += ' primary key'
            parts.append(s)
        ddl.append(f'create table public.{tname} (' + ', '.join(parts) + ');')
        ddl.append(f'alter table public.{tname} enable row level security;')
    for p in pols:
        s = f'create policy "{p["p"]}" on public.{p["t"]} as {p["permissive"].lower()} for {p["cmd"].lower()} to {p["roles"].strip("{}")}'
        if p['qual'] is not None:
            s += f' using ({p["qual"]})'
        if p['with_check'] is not None:
            s += f' with check ({p["with_check"]})'
        ddl.append(s + ';')
    ddl.append('grant usage on schema public to anon, authenticated, service_role;')
    ddl.append('grant all on all tables in schema public to anon, authenticated, service_role;')
    if grants:
        allp = {'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'}
        for g in grants:
            missing = allp - set(filter(None, g['privs'].split(',')))
            if missing:
                ddl.append(f'revoke {", ".join(sorted(missing)).lower()} on public.{g["t"]} from {g["role"]};')
    else:
        ddl.append('revoke update on public.locations from anon;')
    run('\n'.join(ddl), db='plat')
    run("insert into public.gift_cards (id, company_id, code_plain, code_hash, code_lookup, code_last4, initial_amount_minor, balance_minor) values ('11111111-0000-4000-8000-000000000001', gen_random_uuid(), 'ABCD1234ABCD1234', 'h', 'l', '1234', 1000, 800)", db='plat')
    run("insert into public.gift_card_purchases (id, company_id, location_id, gift_card_id, fulfilled_code, amount_minor, status, sender_name, sender_email, recipient_name, recipient_email, fulfilled_at) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '11111111-0000-4000-8000-000000000001', 'abcd1234abcd1234', 1000, 'fulfilled', 's', 's@x', 'r', 'r@x', now())", db='plat')
    run("insert into public.location_reader_settings (location_id) values (gen_random_uuid())", db='plat')

def apply(f):
    return t.run_file(os.path.join(t.MIG, f), db='plat')

def as_anon(sql):
    body = "begin; set local role anon; select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true);\n" + sql + "\nrollback;"
    return run(body, db='plat', check=False)

if __name__ == '__main__':
    build_platform()
    o, e, r = apply('20260919c_PLATFORM_fence_1_after_release.sql')
    expect('Platform file 1 applies (one transaction)', r == 0, e[-1500:])
    print('   verify:', last(o))
    o, e, r = apply('20260919c_PLATFORM_fence_1_after_release.sql')
    expect('Platform file 1 applies twice', r == 0, e[-1500:])
    expect('verify row', last(o) == 'f|gift_card_purchases_company_read SELECT, gift_card_purchases_server ALL|f|location_reader_settings_read SELECT|0', last(o))

    o, e, r = as_anon("update public.gift_card_purchases set status = 'fulfilled';")
    expect('anon cannot write gift purchases', r != 0, e)
    # Fix round 3: file 1 no longer adds gift_card_purchases_read_interim (SELECT to anon
    # USING true). The reads it left are the venue's own company policy, which the Platform
    # browser client can never satisfy because it holds no login, so the anon key reads
    # nothing even though the SELECT grant is still there for file 2 to take.
    o, e, r = as_anon("select count(*) from pg_policies where tablename = 'gift_card_purchases' and policyname = 'gift_card_purchases_read_interim';")
    expect('no interim "anyone may read" policy is created on gift purchases', last(o) == '0', o + e)
    o, e, r = as_anon("select count(*) from public.gift_card_purchases;")
    expect('and the anon key reads no gift purchase rows at all', r == 0 and last(o) == '0', o + e)
    o, e, r = as_anon("update public.location_reader_settings set tipping_enabled = false, tip_percentages = array[10];")
    expect('nobody can change a venue tip prompts from the browser any more', r != 0, e)
    o, e, r = as_anon("update public.location_reader_settings set idle_screen_image_url = 'https://evil.example/scan-to-pay.png';")
    expect('nobody can put a fake idle screen on a venue card readers', r != 0, e)
    o, e, r = as_anon("insert into public.location_reader_settings (location_id, idle_screen_image_url) values (gen_random_uuid(), 'u2');")
    expect('nobody can add reader settings from the browser', r != 0, e)
    o, e, r = as_anon("update public.location_reader_settings set stripe_configuration_id = 'x';")
    expect('browser cannot touch the Stripe configuration id', r != 0, e)
    o, e, r = as_anon("delete from public.location_reader_settings;")
    expect('browser cannot delete reader settings', r != 0, e)
    o, e, r = as_anon("select count(*) from public.location_reader_settings;")
    expect('Back Office still reads reader settings', r == 0 and last(o) == '1', o + e)
    o, e, r = run("begin; set local role service_role; update public.location_reader_settings set tipping_enabled = false; rollback;", db='plat', check=False)
    expect('the server (location-admin on the service role) still saves them', r == 0, e)
    o, e, r = as_anon("insert into public.locations (id) values (gen_random_uuid());")
    expect('browser cannot insert Platform venues', r != 0, e)

    o, e, r = apply('20260919d_PLATFORM_fence_2_after_app.sql')
    expect('Platform file 2 applies', r == 0, e[-1500:])
    print('   verify:', last(o))
    o, e, r = apply('20260919d_PLATFORM_fence_2_after_app.sql')
    expect('Platform file 2 applies twice', r == 0, e[-1500:])
    expect('verify row 2', last(o) == 'gift_card_purchases_server ALL|f|0|0|f', last(o))
    o, e, r = as_anon("select count(*) from public.gift_card_purchases;")
    expect('anon cannot read gift purchases any more', r != 0, e)
    o, e, r = as_anon("select count(*) from public.location_reader_settings;")
    expect('Back Office still reads reader settings', r == 0 and last(o) == '1', o + e)
    src = open(os.path.join(t.MIG, '20260919d_PLATFORM_fence_2_after_app.sql')).read()
    start = src.index('-- 1. How many, per company')
    block = src[start:src.index('-- 2. The list for an owner')]
    sql1 = '\n'.join(l[3:] for l in block.split('\n') if l.startswith('-- ') and not l.startswith('-- 1.') and not l.startswith('--    '))
    o, e, r = run(sql1, db='plat', check=False)
    expect('the leaked gift card count query runs (read only) and finds the live card', r == 0 and o.endswith('|1|800'), o + e)
    block2 = src[src.index('-- 2. The list for an owner'):src.index('-- THE SAFE OPTION')]
    sql2 = '\n'.join(l[3:] for l in block2.split('\n') if l.startswith('-- ') and not l.startswith('-- 2.'))
    o, e, r = run(sql2, db='plat', check=False)
    expect('the owner review list query runs (read only)', r == 0 and '|1234|800|1000|' in o, o + e)
    t.finish()
