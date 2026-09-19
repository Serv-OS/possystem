#!/usr/bin/env python3
"""LOCAL test of the two Platform files on a throwaway database (never Supabase)."""
import json, os, sys
import t
from t import run, expect, last

HERE = os.path.dirname(os.path.abspath(__file__))
cols = json.load(open(os.path.join(HERE, 'schema', 'p_columns.json')))
pols = json.load(open(os.path.join(HERE, 'schema', 'p_policies.json')))

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
ddl.append('revoke update on public.locations from anon;')
run('\n'.join(ddl), db='plat')
run("insert into public.gift_cards (id, company_id, code_plain) values ('11111111-0000-4000-8000-000000000001', gen_random_uuid(), 'ABCD1234ABCD1234')", db='plat') if any(c['col'] == 'code_plain' for c in tables['gift_cards']) else None
run("insert into public.gift_card_purchases (id, gift_card_id, fulfilled_code, amount_minor, status) values (gen_random_uuid(), '11111111-0000-4000-8000-000000000001', 'abcd1234abcd1234', 1000, 'fulfilled')", db='plat')
run("insert into public.location_reader_settings (location_id) values (gen_random_uuid())", db='plat')

def apply(f):
    return run(open(os.path.join(t.MIG, f)).read(), db='plat', check=False)

o, e, r = apply('20260919c_PLATFORM_fence_1_safe_now.sql')
expect('Platform file 1 applies', r == 0, e[-1500:])
print('   verify:', last(o))
o, e, r = apply('20260919c_PLATFORM_fence_1_safe_now.sql')
expect('Platform file 1 applies twice', r == 0, e[-1500:])
expect('verify row', last(o).startswith('f|gift_card_purchases_company_read SELECT, gift_card_purchases_read_interim SELECT, gift_card_purchases_server ALL|f|0'), last(o))

def as_anon(sql):
    body = "begin; set local role anon; select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true);\n" + sql + "\nrollback;"
    return run(body, db='plat', check=False)

o, e, r = as_anon("update public.gift_card_purchases set status = 'fulfilled';")
expect('anon cannot write gift purchases', r != 0, e)
o, e, r = as_anon("select count(*) from public.gift_card_purchases;")
expect('anon still reads gift purchases (Back Office list, until file 2)', last(o) == '1', o + e)
o, e, r = as_anon("update public.location_reader_settings set tipping_enabled = false, tip_percentages = array[10];")
expect('Back Office tipping save still works', r == 0, e)
o, e, r = as_anon("update public.location_reader_settings set stripe_configuration_id = 'x';")
expect('browser cannot touch the Stripe configuration id', r != 0, e)
o, e, r = as_anon("insert into public.location_reader_settings (location_id, idle_screen_image_url) select location_id, 'u2' from public.location_reader_settings limit 1 on conflict (location_id) do update set location_id = excluded.location_id, idle_screen_image_url = excluded.idle_screen_image_url;")
expect('PAX idle image upsert (PaxTerminals.jsx) still works', r == 0, e)
o, e, r = as_anon("delete from public.location_reader_settings;")
expect('browser cannot delete reader settings', r != 0, e)
o, e, r = as_anon("insert into public.locations (id) values (gen_random_uuid());")
expect('browser cannot insert Platform venues', r != 0, e)

o, e, r = apply('20260919d_PLATFORM_fence_2_after_app.sql')
expect('Platform file 2 applies', r == 0, e[-1500:])
print('   verify:', last(o))
o, e, r = apply('20260919d_PLATFORM_fence_2_after_app.sql')
expect('Platform file 2 applies twice', r == 0, e[-1500:])
expect('verify row 2', last(o) == 'gift_card_purchases_server ALL|f|0|0|location_reader_settings_read SELECT|f', last(o))
o, e, r = as_anon("select count(*) from public.gift_card_purchases;")
expect('anon cannot read gift purchases any more', r != 0, e)
o, e, r = as_anon("update public.location_reader_settings set tipping_enabled = false;")
expect('browser cannot change tip prompts any more', r != 0, e)
o, e, r = as_anon("select count(*) from public.location_reader_settings;")
expect('Back Office still reads reader settings', r == 0 and last(o) == '1', o + e)

fails = [n for n, ok, d in t.RESULTS if not ok]
print(f"\n{len(t.RESULTS) - len(fails)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
