#!/usr/bin/env python3
"""File 1 (20260919a) on the local throwaway copy: every check runs as a PostgREST caller
would (set local role plus request.jwt.claims), rolled back unless the test needs it."""
import json, os
import t
from t import as_, as_commit, expect, last, UID, L1, L2, L3, L4, run

HERE = os.path.dirname(os.path.abspath(__file__))
DEV = {'till1': '40000000-0000-4000-8000-000000000001', 'kds1': '40000000-0000-4000-8000-000000000002',
       'beta': '40000000-0000-4000-8000-000000000003', 'kiosk1': '40000000-0000-4000-8000-000000000004',
       'dupa': '40000000-0000-4000-8000-000000000005', 'dupb': '40000000-0000-4000-8000-000000000006',
       'o1beta': '40000000-0000-4000-8000-000000000007', 'o1acme': '40000000-0000-4000-8000-000000000008',
       'oldactive': '40000000-0000-4000-8000-000000000009', 'never': '40000000-0000-4000-8000-00000000000a',
       'novenue': '40000000-0000-4000-8000-00000000000b'}

def j(o):
    try:
        return json.loads(last(o))
    except Exception:
        return {}

t.reset()

# ---------- the runbook's read only pre-check says exactly what the file will do
pre = open(os.path.join(HERE, 'precheck_devices.sql')).read()
o, e, r = run(pre)
predicted = {}
for line in o.splitlines():
    parts = line.split('|')
    if len(parts) >= 5:
        predicted[parts[1]] = parts[3]
expect('runbook pre-check query runs', r == 0 and len(predicted) >= 8, e + o)

out, err, rc = t.apply('20260919a_OPS_fence_1_safe_now.sql')
expect('file A applies cleanly (one transaction)', rc == 0, err[-2000:])
print('   verify row:', last(out))
out2, err2, rc2 = t.apply('20260919a_OPS_fence_1_safe_now.sql')
expect('file A applies a second time (idempotent)', rc2 == 0, err2[-2000:])
expect('verify row: 4 allow all left, codes not readable, no truncate, no untrusted links, stamp trigger',
       last(out2).split('|')[0] == 'active_sessions, kds_tickets, order_queue, table_reservations'
       and last(out2).split('|')[4:] == ['f', '0', '0', '0', '0', 't'], last(out2))

# ---------- grandfathering
o, e, r = run("select name, coalesce(bound_via,'-'), status, coalesce(pairing_code,'-') from public.devices order by name")
state = dict((l.split('|')[0], (l.split('|')[1], l.split('|')[2])) for l in o.splitlines())
expect('Till 1 (anon, seen 1h) kept', state['Till 1'][0] == 'grandfathered')
expect('Beta Till (anon, 2 days) kept', state['Beta Till'][0] == 'grandfathered')
expect('Kiosk 1 kept', state['Kiosk 1'][0] == 'grandfathered')
expect('Owner1 at Acme (linked login) kept', state['Owner1 at Acme'][0] == 'grandfathered')
expect('Dup A (newest of the two rows) kept', state['Dup A'][0] == 'grandfathered')
expect('KDS 1 (20 days) removed', state['KDS 1'] == ('-', 'removed'), str(state['KDS 1']))
expect('No venue row removed', state['No venue'] == ('-', 'removed'), str(state['No venue']))
expect('Old unbound active row removed', state['Old unbound active'] == ('-', 'removed'), str(state['Old unbound active']))
expect('Owner1 at Beta (in use this week, login not linked there) waits to pair, not removed',
       state['Owner1 at Beta'] == ('-', 'unpaired'), str(state['Owner1 at Beta']))
expect('Dup B (in use this week) waits to pair, not removed', state['Dup B'] == ('-', 'unpaired'), str(state['Dup B']))
o, _, _ = run("select count(*) from public.devices where pairing_code is not null")
expect('every code from before the fence is retired (none left on the table)', o == '0', o)
o, _, _ = run("select to_regclass('public.device_heal_codes') is null")
expect('no saved codes are kept anywhere (no heal table)', o == 't', o)
actual = {}
o, _, _ = run("select name, case when bound_via is not null then 'kept' when status in ('unpaired','awaiting_pairing') and id in (select device_id from public.device_claim_log where event='unbound_by_fence') then 'unpaired_in_use' when status = 'removed' then 'removed' else 'untouched' end from public.devices")
for line in o.splitlines():
    n, f = line.split('|')
    actual[n] = f
mismatch = [(n, predicted.get(n), actual[n]) for n in actual if actual[n] != 'untouched' and predicted.get(n) != actual[n]]
expect('the pre-check predicted every device the file changed', not mismatch, str(mismatch))
o, e, r = as_('owner1', f"select count(*) from public.devices where id = '{DEV['o1beta']}';")
expect('the till unlinked at a venue its login is not linked to cannot read its own row (banner, never a blank pairing screen)', last(o) == '0', o + e)
o, e, r = as_('dup', f"select count(*) from public.devices where id = '{DEV['dupb']}';")
expect('nor can the till whose login moved to a newer row', last(o) == '0', o + e)
o, e, r = as_('dup', "select public.device_status()->>'device_id';")
expect('device_status names the row that login is really linked to (the app compares it with its own id)', last(o) == DEV['dupa'], o + e)

# ---------- identity: organisations and locations
o, e, r = as_('rawanon', "delete from public.organisations;")
expect('raw anon key cannot delete organisations', r != 0 and 'permission denied' in e, e)
o, e, r = as_('attacker', "with d as (delete from public.organisations returning 1) select count(*) from d;")
expect('anonymous session deletes 0 organisations', last(o) == '0', o + e)
o, e, r = as_('attacker', "with d as (delete from public.locations returning 1) select count(*) from d;")
expect('anonymous session deletes 0 venues', last(o) == '0', o + e)
o, e, r = as_('attacker', "with u as (update public.locations set name = 'pwned' returning 1) select count(*) from u;")
expect('anonymous session updates 0 venues', last(o) == '0', o + e)
o, e, r = as_('attacker', "select count(*) from public.locations;")
expect('anonymous session still reads venues (customer pages)', last(o) == '4', o + e)
o, e, r = as_('attacker', "select count(*) from public.organisations;")
expect('anonymous session reads no organisations', last(o) == '0', o + e)
o, e, r = as_('owner1', f"with u as (update public.locations set name = 'Acme One!' where id = '{L1}' returning 1) select count(*) from u;")
expect('owner saves own venue', last(o) == '1', o + e)
o, e, r = as_('owner1', f"with u as (update public.locations set name = 'x' where id = '{L3}' returning 1) select count(*) from u;")
expect('owner cannot save another venue', last(o) == '0', o + e)
o, e, r = as_('owner1', f"update public.locations set org_id = '00000000-0000-4000-8000-0000000000b2' where id = '{L1}';")
expect('owner cannot move a venue to another company', r != 0 and 'Only the platform' in e, e)
o, e, r = as_('owner1', f"with d as (delete from public.locations where id = '{L1}' returning 1) select count(*) from d;")
expect('owner cannot delete a venue', last(o) == '0', o + e)
o, e, r = as_('super', f"with u as (update public.locations set name = 'y' where id = '{L3}' returning 1) select count(*) from u;")
expect('super admin saves an unlinked venue', last(o) == '1', o + e)
o, e, r = as_('owner1', "select count(*) from public.organisations;")
expect('owner reads only their own company', last(o) == '1', o + e)

# ---------- identity: profiles and links
o, e, r = as_('owner1', f"with u as (update public.user_profiles set location_id = '{L1}' where id = '{UID['owner2']}' returning 1) select count(*) from u;")
expect('owner cannot edit another company login', last(o) == '0', o + e)
o, e, r = as_('owner1', f"update public.user_profiles set location_id = '{L3}' where id = '{UID['owner1']}';")
expect('owner cannot point own profile at an unlinked venue', r != 0 and 'linked to' in e, e)
o, e, r = as_('owner1', f"with u as (update public.user_profiles set location_id = '{L1}', full_name = 'O1' where id = '{UID['owner1']}' returning 1) select count(*) from u;")
expect('owner can switch own profile venue to a linked venue and rename', last(o) == '1', o + e)
o, e, r = as_('owner1', f"update public.user_profiles set org_id = '00000000-0000-4000-8000-0000000000b2' where id = '{UID['owner1']}';")
expect('owner cannot change own company', r != 0 and 'Only the platform' in e, e)
o, e, r = as_('staff1', f"update public.user_profiles set bo_access = true where id = '{UID['staff1']}';")
expect('staff login cannot switch own Back Office access on', r != 0, e)
o, e, r = as_('owner1', "select count(*) from public.user_profiles;")
expect('owner reads own profile plus the logins linked to their venue (3)', last(o) == '3', o + e)
o, e, r = as_('attacker', "select count(*) from public.user_profiles;")
expect('anonymous session reads only its own profile', last(o) == '1', o + e)
o, e, r = as_('super', "select count(*) from public.user_profiles;")
expect('super admin reads all profiles', last(o) == '18', o + e)
o, e, r = as_('manager1', f"with u as (update public.user_profiles set bo_access = true where id = '{UID['staff1']}' returning 1) select count(*) from u;")
expect('manager switches a staff login Back Office access (linked as staff)', last(o) == '1', o + e)
o, e, r = as_('manager1', f"with u as (update public.user_profiles set bo_access = false where id = '{UID['owner1']}' returning 1) select count(*) from u;")
expect('manager cannot switch the owner off', last(o) == '0', o + e)
o, e, r = as_('manager1', f"update public.user_profiles set full_name = 'x' where id = '{UID['staff1']}';")
expect('manager cannot rename a teammate', r != 0, e)
o, e, r = as_('owner1', f"with u as (update public.user_locations set location_id = '{L3}' where user_id = '{UID['owner1']}' returning 1) select count(*) from u;")
expect('self move matches 0 rows', last(o) == '0' or r != 0, o + e)
o, e, r = as_('owner1', "select string_agg(x, ',' order by x) from public.user_accessible_locations() x;")
expect('owner reaches only L1', last(o) == L1, o + e)
o, e, r = as_('super', "select count(*) from public.user_accessible_locations();")
expect('super admin reaches every venue', last(o) == '4', o + e)
o, e, r = as_('attacker', "select count(*) from public.user_accessible_locations();")
expect('anonymous session reaches no venue by login', last(o) == '0', o + e)

# HIGH (18 Sep): a staff record naming a login at another venue reaches nothing
o, e, r = as_('owner2', f"""
insert into public.staff_members (id, location_id, org_id, name, role, pin, auth_user_id, active)
values (gen_random_uuid(), '{L3}', '00000000-0000-4000-8000-0000000000b2', 'Bait', 'server', '9999', '{UID['owner1']}', true);
select count(*) from public.user_profiles where id = '{UID['owner1']}';""")
expect('owner who writes a staff record naming another venue login still cannot read their email', r == 0 and last(o) == '0', o + e)
o, e, r = as_('owner2', f"""
insert into public.staff_members (id, location_id, org_id, name, role, pin, auth_user_id, active)
values (gen_random_uuid(), '{L3}', '00000000-0000-4000-8000-0000000000b2', 'Bait', 'server', '9999', '{UID['owner1']}', true);
with u as (update public.user_profiles set bo_access = false where id = '{UID['owner1']}' returning 1) select count(*) from u;""")
expect('and cannot switch off that login Back Office access', r == 0 and last(o) == '0', o + e)
o, e, r = as_('dev1', f"""
insert into public.staff_members (id, location_id, org_id, name, role, pin, auth_user_id, active)
values (gen_random_uuid(), '{L1}', '00000000-0000-4000-8000-0000000000a1', 'Bait', 'server', '9999', '{UID['owner2']}', true);
select 1;""")
expect('a paired till can still write a staff record (stage 2 table)', r == 0, e)
o, e, r = as_('owner1', f"""
insert into public.staff_members (id, location_id, org_id, name, role, pin, auth_user_id, active)
values (gen_random_uuid(), '{L1}', '00000000-0000-4000-8000-0000000000a1', 'Bait', 'server', '9999', '{UID['owner2']}', true);
select (select count(*) from public.user_profiles where id = '{UID['owner2']}') || ':' ||
       (select count(*) from public.bo_manageable_ids() x where x = '{UID['owner2']}');""")
expect('a staff record at my venue naming another venue owner gives neither read nor switch', last(o) == '0:0', o + e)
o, e, r = as_('manager1', f"""
insert into public.user_locations (user_id, location_id, role) select '{UID['owner2']}', '{L1}', 'staff' where false;
select count(*) from public.bo_manageable_ids() x where x = '{UID['owner2']}';""")
run(f"insert into public.user_locations (user_id, location_id, role) values ('{UID['owner2']}', '{L1}', 'staff')")
o, e, r = as_('manager1', f"with u as (update public.user_profiles set bo_access = false where id = '{UID['owner2']}' returning 1) select count(*) from u;")
expect('a manager cannot switch off a login that owns another venue, even when it is staff here', last(o) == '0', o + e)
o, e, r = as_('owner1', f"with u as (update public.user_profiles set bo_access = false where id = '{UID['owner2']}' returning 1) select count(*) from u;")
expect('the owner of the shared venue can', last(o) == '1', o + e)
run(f"delete from public.user_locations where user_id = '{UID['owner2']}' and location_id = '{L1}'")

# new operator bootstrap (CompanyAdmin.jsx) keeps working
o, e, r = as_('newbie', f"""
do $$ declare v_org uuid; v_loc uuid; n int; begin
  insert into public.organisations (name, slug, status) values ('Newco', 'newco-x', 'active') returning id into v_org;
  update public.user_profiles set org_id = v_org where id = auth.uid();
  insert into public.locations (id, org_id, name) values ('10000000-0000-4000-8000-0000000000ff', v_org, 'Newco One') returning id into v_loc;
  if v_loc = '10000000-0000-4000-8000-0000000000ff' then raise exception 'client id kept'; end if;
  update public.user_profiles set location_id = v_loc where id = auth.uid();
  insert into public.user_locations (user_id, location_id, role) values (auth.uid(), v_loc, 'owner');
  select count(*) into n from public.user_accessible_locations();
  if n <> 1 then raise exception 'expected 1 venue, got %', n; end if;
  raise notice 'BOOTSTRAP_OK';
end $$;
""")
expect('new operator bootstrap: company, profile company, venue (server id), claim', r == 0 and 'BOOTSTRAP_OK' in e, e)
o, e, r = as_('newbie', f"insert into public.locations (org_id, name) values ('00000000-0000-4000-8000-0000000000b2', 'sneaky');")
expect('login cannot create a venue in another company', r != 0, e)
o, e, r = as_('newbie', f"insert into public.user_locations (user_id, location_id, role) values (auth.uid(), '{L4}', 'owner');")
expect('login cannot claim an unlinked venue it did not create', r != 0, e)
o, e, r = as_('newbie', "update public.user_profiles set org_id = '00000000-0000-4000-8000-0000000000b2' where id = auth.uid();")
expect('login with no company cannot adopt someone else company', r != 0, e)

# ---------- BLOCKER 1: a login pairs itself as a till, then points the row at a victim venue
# Steps 1 to 5, exactly as the reviewer ran them, committed (mallory is a real login).
o, e, r = as_commit('mallory', """
do $$ declare v_org uuid; v_loc uuid; v_dev uuid; v_code jsonb; v_claim jsonb; begin
  insert into public.organisations (name, slug) values ('Mal', 'mal-co') returning id into v_org;                 -- 1
  insert into public.locations (org_id, name) values (v_org, 'Mal Cafe') returning id into v_loc;                 -- 2
  insert into public.user_locations (user_id, location_id, role) values (auth.uid(), v_loc, 'owner');            -- 3
  insert into public.devices (location_id, name, type) values (v_loc, 'Mal till', 'pos') returning id into v_dev; -- 4
  v_code := public.issue_pairing_code(v_dev);                                                                    -- 5
  v_claim := public.claim_device_v2(v_code ->> 'code');
  if coalesce((v_claim ->> 'ok')::boolean, false) is not true then raise exception 'claim failed %', v_claim; end if;
  raise notice 'MAL_READY %', v_dev;
end $$;""")
expect('steps 1 to 5 work (a real login may be a till identity: one browser serves Back Office and POS)', r == 0 and 'MAL_READY' in e, e)
mal_dev, _, _ = run("select id from public.devices where name = 'Mal till'")
mal_loc, _, _ = run("select location_id from public.devices where name = 'Mal till'")
o, _, _ = run(f"select bound_via, device_uid = '{UID['mallory']}' from public.devices where id = '{mal_dev}'")
expect('her own till is bound to her login at her own venue', o == 'code|t', o)
o, e, r = as_('mallory', f"update public.devices set location_id = '{L1}' where id = '{mal_dev}';")
expect('step 6 (PostgREST update of location_id) is refused', r != 0 and 'both venues' in e, e)
o, e, r = as_('mallory', f"with u as (update public.devices set location_id = '{L1}', last_seen = now() where id = '{mal_dev}' returning 1) select count(*) from u;")
expect('step 6 with a heartbeat column alongside is refused too', r != 0, e)
o, e, r = as_('mallory', f"insert into public.devices (id, location_id, name, type) values ('{mal_dev}', '{L1}', 'Mal till', 'pos') on conflict (id) do update set location_id = excluded.location_id;")
expect('step 6 as an upsert (insert on conflict do update) is refused', r != 0, e)
o, e, r = as_('mallory', f"insert into public.devices (location_id, name, type) values ('{L1}', 'Mal 2', 'pos');")
expect('she cannot add a device at the victim venue', r != 0, e)
o, e, r = as_('mallory', f"with u as (update public.devices set device_uid = auth.uid() where id = '{DEV['till1']}' returning 1) select count(*) from u;")
expect('she cannot link herself to a victim device', last(o) == '0' or r != 0, o + e)
o, e, r = as_('mallory', f"select count(*) from public.devices where location_id = '{L1}';")
expect('she cannot even see the victim venue devices', last(o) == '0', o + e)
o, e, r = as_('mallory', f"select public.issue_pairing_code('{DEV['till1']}', true);")
expect('issue_pairing_code refuses a device of a venue she does not manage', r != 0 and 'do not manage' in e, e)
o, e, r = as_('mallory', f"select public.reclaim_device('{DEV['till1']}', 'guess')->>'reason';")
expect('reclaim_device without the secret is refused', last(o) == 'invalid', o + e)
o, e, r = as_('mallory', f"select public.device_heartbeat('9', array['fence_v1'], '{DEV['till1']}')->>'bound'; select public.pos_can_access('{L1}'::text);")
expect('device_heartbeat naming a victim device links nothing', last(o) == 'f', o + e)
o, e, r = as_('mallory', f"select public.claim_device('APPLE-1111'); select public.pos_can_access('{L1}'::text);")
expect('the old claim_device with a victim old code gives her nothing', last(o) == 'f', o + e)
o, e, r = as_('mallory', "select public.device_issue_secret()->>'device_id';")
expect('device_issue_secret only ever returns her own device', last(o) == mal_dev, o + e)
o, e, r = as_('mallory', "select public.claim_device_v2('ABCD-EFGH-JKLM')->>'device_id';")
expect('claim_device_v2 with a guessed code only ever answers with her own till', last(o) == mal_dev, o + e)
o, e, r = as_('mallory', f"select public.pos_can_access('{L1}'::text) or public.pos_can_access('{L1}'::uuid) or '{L1}' in (select public.pos_accessible_location_keys());")
expect('after every variant she is still not staff of the victim venue', last(o) == 'f', o + e)
o, e, r = as_('mallory', f"select public.pos_can_access('{mal_loc}'::text);")
expect('she is still staff of her own venue', last(o) == 't', o + e)
o, e, r = as_('owner1', f"update public.devices set location_id = '{L3}' where id = '{DEV['o1acme']}';")
expect('a Back Office login bound as a till cannot move its row to a venue it does not manage', r != 0 and 'both venues' in e, e)
o, e, r = as_('owner1', f"update public.devices set name = 'Front till' where id = '{DEV['o1acme']}'; select name from public.devices where id = '{DEV['o1acme']}';")
expect('the same login can still rename that till (Back Office of its venue)', last(o) == 'Front till', o + e)
run(f"insert into public.user_locations (user_id, location_id, role) values ('{UID['owner1']}', '{L2}', 'manager')")
o, e, r = as_('owner1', f"update public.devices set location_id = '{L2}' where id = '{DEV['till1']}'; select location_id || '|' || status || '|' || (device_uid is null)::text || '|' || coalesce(bound_via, '-') from public.devices where id = '{DEV['till1']}';")
expect('Back Office of BOTH venues may move a device, and the move unlinks it (pair again there)',
       last(o) == f"{L2}|unpaired|true|-", o + e)
run(f"delete from public.user_locations where user_id = '{UID['owner1']}' and location_id = '{L2}'")
o, e, r = as_commit('super', f"update public.devices set location_id = '{L4}' where id = '{DEV['beta']}'; select (device_uid is null)::text || '|' || status from public.devices where id = '{DEV['beta']}';")
expect('super admin may move a device, and it is unlinked too', last(o) == 'true|unpaired', o + e)
o, e, r = as_('super', f"update public.devices set device_uid = '{UID['super']}' where id = '{DEV['never']}';")
expect('not even the super admin links a device by hand (only a claim)', r != 0, e)

# ---------- the linked till itself: heartbeat columns only
o, e, r = as_('dev1', f"with u as (update public.devices set status = 'online', last_seen = now(), app_version = '5.9.9' where id = '{DEV['till1']}' returning 1) select count(*) from u;")
expect('till heartbeat on own row works', last(o) == '1', o + e)
o, e, r = as_('dev1', f"with u as (update public.devices set session_token = 'sess-new' where id = '{DEV['till1']}' returning 1) select count(*) from u;")
expect('till writes its session token', last(o) == '1', o + e)
o, e, r = as_('dev1', f"update public.devices set kds_settings = '{{\"a\":1}}' where id = '{DEV['till1']}';")
expect('till writes its screen settings', r == 0, e)
o, e, r = as_('dev1', f"update public.devices set paired_at = now(), pairing_code = null where id = '{DEV['till1']}';")
expect('till writes paired_at and clears its own code (live kiosk pairing update)', r == 0, e)
for col, val in [('location_id', f"'{L3}'"), ('name', "'x'"), ('profile_id', "'p9'"), ('receipt_printer_id', "'pr9'"),
                 ('centre_id', "'pc9'"), ('type', "'kds'"), ('created_at', "now()"), ('status', "'removed'"),
                 ('pairing_expires_at', "now() + interval '1 hour'"), ('client_caps', "array['fence_v1']"),
                 ('bound_via', "'secret'")]:
    o, e, r = as_('dev1', f"update public.devices set {col} = {val} where id = '{DEV['till1']}';")
    expect(f'till cannot change its own {col}', r != 0, e)
o, e, r = as_('dev1', f"with u as (update public.devices set status = 'online' where id = '{DEV['beta']}' returning 1) select count(*) from u;")
expect('till cannot touch another till row', last(o) == '0', o + e)
o, e, r = as_('attacker', "with u as (update public.devices set device_uid = auth.uid() returning 1) select count(*) from u;")
expect('anonymous session cannot take over a device row', last(o) == '0', o + e)
o, e, r = as_('attacker', "with d as (delete from public.devices returning 1) select count(*) from d;")
expect('anonymous session cannot delete devices', last(o) == '0', o + e)
o, e, r = as_('attacker', f"insert into public.devices (location_id, name, type, status, device_uid) values ('{L1}', 'evil', 'pos', 'active', auth.uid());")
expect('anonymous session cannot add a device', r != 0, e)
o, e, r = as_('rawanon', f"insert into public.devices (location_id, name) values ('{L1}', 'evil');")
expect('raw anon key cannot add a device', r != 0, e)
o, e, r = as_('attacker', f"select public.pos_can_access('{L1}'::text);")
expect('attacker is not staff of L1', last(o) == 'f', o + e)
o, e, r = as_('dev3', f"select public.pos_can_access('{L3}'::text);")
expect('a till moved by the super admin lost its old venue at once', last(o) == 'f', o + e)
o, e, r = as_('dev2', f"select public.pos_can_access('{L1}'::text);")
expect('unbound stale till has no access', last(o) == 'f', o + e)
o, e, r = as_('dup', f"select public.pos_can_access('{L1}'::text), public.pos_can_access('{L3}'::text);")
expect('duplicate login keeps only its newest row (Dup A at L1)', last(o) == 't|f', o + e)

# ---------- BLOCKER 2: pairing codes are readable only by that venue's Back Office and the super admin
o, e, r = as_commit('owner1', f"insert into public.devices (location_id, name, type) values ('{L1}', 'New till', 'pos'); select public.issue_pairing_code(id)->>'code' from public.devices where name = 'New till';")
code = last(o)
expect('Back Office issues a 12 symbol server code', r == 0 and len(code) == 14 and code[4] == '-', o + e)
o, _, _ = run("select pairing_expires_at > now() + interval '55 minutes', status, device_uid is null from public.devices where name = 'New till'")
expect('60 minute expiry, unpaired, no link', o == 't|unpaired|t', o)
for who in ['attacker', 'stranger', 'rawanon', 'dev1', 'dev4', 'mallory', 'owner2']:
    o, e, r = as_(who, "select count(*) from public.devices where pairing_code is not null;")
    expect(f'{who} cannot read any live pairing code', last(o) == '0', o + e)
o, e, r = as_('dev1', "select count(*) from public.devices where name = 'New till';")
expect('a till of the same venue cannot even see the row while it holds a code', last(o) == '0', o + e)
o, e, r = as_('dev1', f"select count(*) from public.devices where location_id = '{L1}';")
expect('a till still sees its venue devices without codes (status drawer)', r == 0 and int(last(o) or 0) >= 2, o + e)
o, e, r = as_('owner1', "select pairing_code from public.devices where name = 'New till';")
expect('Back Office of the venue reads the code', last(o) == code, o + e)
o, e, r = as_('super', "select pairing_code from public.devices where name = 'New till';")
expect('super admin reads the code', last(o) == code, o + e)
o, e, r = as_('attacker', "select count(*) from public.devices;")
expect('a stranger reads no device row at all', last(o) == '0', o + e)
o, e, r = as_commit('newtill', f"select public.claim_device_v2('{code.replace('-', ' ').lower()}')->>'ok';")
expect('the real till pairs with the code (spaces and lower case are fine)', last(o) == 'true', o + e)
o, _, _ = run("select pairing_code is null, bound_via, status from public.devices where name = 'New till'")
expect('a code claimed once is cleared', o == 't|code|active', o)
o, e, r = as_('attacker', f"select public.claim_device_v2('{code}')->>'reason';")
expect('the used code cannot be claimed again', last(o) == 'not_found', o + e)
o, e, r = as_commit('owner1', "insert into public.devices (location_id, name, type, pairing_code, status) values ('" + L1 + "', 'Typed code till', 'pos', 'APPLE-4242', 'unpaired');")
o2, _, _ = run("select pairing_code from public.devices where name = 'Typed code till'")
expect('a code typed in an old Back Office tab is replaced by a server code', r == 0 and o2 != 'APPLE-4242' and len(o2) == 14, o2 + e)
o, e, r = as_('customer', "select public.claim_device_v2('APPLE-4242')->>'reason';")
expect('the typed code never pairs', last(o) == 'not_found', o + e)

# saved codes from before the fence never re-link (the old heal path is gone)
o, e, r = as_('attacker', f"select public.claim_device_v2('APPLE-1111')->>'reason'; select public.pos_can_access('{L1}'::text);")
expect('someone holding Till 1 old code gets nothing', last(o) == 'f', o + e)
o, e, r = as_('dev1b', f"select public.claim_device('APPLE-1111'); select public.pos_can_access('{L1}'::text);")
expect('the till own new login cannot re-link with its old code either (device secret only)', last(o) == 'f', o + e)
tries = ''.join("select public.claim_device_v2('APPLE-1111');" for _ in range(10))
o, e, r = as_('dev1b', tries + f"select public.claim_device_v2('{code}')->>'reason';")
expect('re-sending an old saved code is never counted as a guess (no lock after 10 boots)', last(o) != 'locked', o + e)

# ---------- throttles
guesses = ''.join(f"select public.claim_device_v2('ABCD-EFGH-JK{c}{c}');" for c in 'ABCDEF')
o, e, r = as_commit('owner1', f"insert into public.devices (location_id, name, type) values ('{L1}', 'Till T', 'pos'); select public.issue_pairing_code(id)->>'code' from public.devices where name = 'Till T';")
code_t = last(o)
o, e, r = as_('attacker', guesses + f"select public.claim_device_v2('{code_t}')->>'reason';")
expect('6 wrong codes lock that session (even the right code is refused)', last(o) == 'locked', o + e)
ip_guesses = ''.join(f"select public.claim_device_v2('ZZZZ-ZZZZ-ZZ{c}{c}');" for c in 'ABCDE')
for who in ['attacker', 'stranger', 'joiner', 'customer', 'dev2', 'owner2']:
    o, e, r = as_commit(who, ip_guesses, ip='198.51.100.77')
    expect(f'{who}: 5 wrong codes from the shared network are refused', r == 0 and 'not_found' in o, o + e)
o, e, r = as_('dev1b', "select public.claim_device_v2('ZZZZ-ZZZZ-ZZZZ')->>'reason';", ip='198.51.100.77')
expect('30 wrong codes from one network lock wrong codes from that network', last(o) == 'locked', o + e)
o, e, r = as_('dev1b', f"select public.claim_device_v2('{code_t}')->>'ok';", ip='198.51.100.77')
expect('but a live code from that network still pairs', last(o) == 'true', o + e)
run("insert into public.fence_attempts (bucket, misses, locked_until) values ('claim:global', 0, now() + interval '10 minutes') on conflict (bucket) do update set locked_until = excluded.locked_until")
o, e, r = as_('joiner', "select public.claim_device_v2('YYYY-YYYY-YYYY')->>'reason';")
expect('the platform breaker turns wrong codes away', last(o) == 'locked', o + e)
o, e, r = as_('joiner', f"select public.claim_device_v2('{code_t}')->>'ok';")
expect('but never a live code: pairing works everywhere during an attack', last(o) == 'true', o + e)
run("delete from public.fence_attempts")

# ---------- device secret, heartbeat, status
o, e, r = as_commit('dev4', "select (public.device_issue_secret()->>'device_secret');")
secret = last(o)
expect('a kept kiosk collects its device secret', len(secret) == 64, o + e)
o, e, r = as_commit('dev1b', f"select public.reclaim_device('{DEV['kiosk1']}', '{secret}')->>'ok'; select public.pos_can_access('{L1}'::text);")
expect('reclaim with the device secret re-links a changed login', last(o) == 't', o + e)
o, _, _ = run(f"select location_id, bound_via from public.devices where id = '{DEV['kiosk1']}'")
expect('the re-link keeps the same venue', o == f'{L1}|secret', o)
o, e, r = as_('dev1', f"select public.reclaim_device('{DEV['kiosk1']}', 'nope')->>'reason';")
expect('wrong secret refused', last(o) == 'invalid', o + e)
o, e, r = as_('dev1b', "select public.device_heartbeat('5.9.9', array['fence_v1','device_secret'])->>'bound'; select array_to_string(client_caps, ',') from public.devices where device_uid = auth.uid();")
expect('heartbeat reports version and caps', last(o) == 'fence_v1,device_secret', o + e)
o, e, r = as_('dev1b', "select public.device_status()->>'bound';")
expect('device_status says bound', last(o) == 'true', o + e)
o, e, r = as_('attacker', "select public.device_status()->>'bound';")
expect('device_status says not bound for a stranger', last(o) == 'false', o + e)
o, e, r = as_commit('dev2', f"select public.device_heartbeat('5.9.9', array['fence_v1'], '{DEV['kds1']}')->>'bound';")
o2, _, _ = run(f"select count(*) from public.device_unlinked_pings where device_id = '{DEV['kds1']}'")
expect('an unlinked device that is switched on is recorded for file 2', last(o) == 'false' and o2 == '1', o + o2)
o, e, r = as_commit('dev2', "select public.device_heartbeat('5.9.9', array['fence_v1'], gen_random_uuid())->>'bound';")
o2, _, _ = run("select count(*) from public.device_unlinked_pings")
expect('a made up device id is not recorded', o2 == '1', o2)
o, e, r = as_commit('dup', f"select public.device_heartbeat('5.9.9', array['fence_v1'], '{DEV['dupb']}')->>'device_id';")
o2, _, _ = run(f"select count(*) from public.device_unlinked_pings where device_id = '{DEV['dupb']}'")
expect('a till that thinks it is another device (linked elsewhere) counts that device as switched on but unpaired', last(o) == DEV['dupa'] and o2 == '1', o + o2)
o, e, r = as_commit('dup', f"select public.device_heartbeat('5.9.9', array['fence_v1'], '{DEV['dupa']}')->>'device_id';")
o2, _, _ = run(f"select count(*) from public.device_unlinked_pings where uid = '{UID['dup']}'")
expect('once it reports its own linked device again, its pings are cleared', o2 == '0', o2)
o, e, r = as_commit('owner1', f"update public.devices set status = 'removed' where id = '{DEV['dupa']}';")
o, e, r = run(f"select device_uid is null, bound_via is null from public.devices where id = '{DEV['dupa']}'")
expect('removing a device drops its link', o == 't|t', o)
o, e, r = as_('owner1', f"select public.issue_pairing_code('{DEV['o1acme']}')->>'reason';")
expect('issuing a code for a paired till needs force', last(o) == 'paired', o + e)

# live kiosk pairing (old flow's own row write after the claim) still works for the release
o, e, r = as_commit('owner1', f"insert into public.devices (location_id, name, type) values ('{L1}', 'Kiosk 2', 'kiosk'); select public.issue_pairing_code(id)->>'code' from public.devices where name = 'Kiosk 2';")
kcode = last(o)
o, e, r = as_('stranger', f"""
select public.claim_device_v2('{kcode}')->>'ok';
update public.devices set paired_at = now(), session_token = 'tok', last_seen = now(), status = 'online' where name = 'Kiosk 2';
select status || '|' || coalesce(bound_via, '-') from public.devices where name = 'Kiosk 2';
""")
expect('kiosk pairing with claim_device_v2 then its own row write works', last(o) == 'online|code', o + e)

# ---------- place_public_order: the server decides paid
def proof(ref, kind, amount, loc=L1, proc='stripe', order_ref=None):
    meta = 'null' if order_ref is None else f"'{json.dumps({'order_ref': order_ref})}'::jsonb"
    run(f"insert into public.payment_proofs (processor, payment_ref, kind, location_id, amount_minor, verified_by, meta) values ('{proc}', '{ref}', '{kind}', '{loc}', {amount}, 'test', {meta})")
    o, _, _ = run(f"select id from public.payment_proofs where payment_ref = '{ref}' and kind = '{kind}'")
    return o

def q(x):
    return json.dumps(x).replace("'", "''")

def place(who, order, check=None, proofs=(), commit=True, ip=None):
    fn = as_commit if commit else as_
    c = 'null' if check is None else f"'{q(check)}'::jsonb"
    ids = "array[" + ','.join(f"'{p}'" for p in proofs) + "]::uuid[]" if proofs else "'{}'::uuid[]"
    return fn(who, f"select public.place_public_order('{L1}', '{q(order)}'::jsonb, {c}, {ids});", ip=ip)

burger = [{'name': 'Burger', 'price': 20, 'qty': 1}]
p1 = proof('pi_card_1', 'card', 2500)
o, e, r = place('customer', {'ref': 'OL-OK1', 'source': 'online', 'type': 'collection', 'status': 'collected', 'staff': 'Evil',
                             'items': [{'name': 'Burger', 'price': 20, 'qty': 1, 'mods': [{'name': 'Bacon', 'price': 5}]}], 'total': 25,
                             'customer': {'name': 'Ann', 'phone': '07700 900123', 'paid': True}},
                {'id': 'chk-ok-1', 'total': 25, 'subtotal': 20.83, 'tax_amount': 4.17, 'processor': 'stripe',
                 'stripe_payment_intent_id': 'pi_card_1', 'status': 'refunded', 'staff_id': 'x'}, [p1])
res = j(o)
expect('a real paid online order with a covering card proof is paid', res.get('paid') is True and res.get('check_id') == 'chk-ok-1', o + e)
tok = res.get('track_token', '')
o, _, _ = run("select status, staff is null, paid, placed_via, customer ? 'paid', (customer->'order_pricing'->>'due_minor') from public.order_queue where ref = 'OL-OK1'")
expect('order row: server status, no staff, paid, rpc, phone paid flag stripped, amount due recorded', o == 'prep|t|t|rpc|f|2500', o)
o, _, _ = run("select status, source, total from public.closed_checks where id = 'chk-ok-1'")
expect('paid check written by the server', o.startswith('paid|online|25'), o)

# the exact 18 Sep exploit: 95 pound order, check total 1p, 1p card proof
p_small = proof('pi_1p', 'card', 1)
o, e, r = place('attacker', {'ref': 'OL-X95', 'source': 'online', 'items': [{'name': 'Feast', 'price': 95, 'qty': 1}], 'total': 95,
                             'customer': {'name': 'X'}}, {'id': 'chk-x95', 'total': 0.01}, [p_small])
res = j(o)
expect('EXPLOIT: a 95 pound order with a 1p check total and a 1p proof is NOT paid', res.get('ok') and res.get('paid') is False and res.get('payment_unverified') is True, o + e)
o, _, _ = run("select count(*) from public.closed_checks where id like 'chk-x95%'")
expect('and no paid check was written', o == '0', o)
o, _, _ = run("select paid, customer->>'payment_state', status from public.order_queue where ref = 'OL-X95'")
expect('the order reaches the venue marked "payment being checked", not paid', o == 'f|checking|received', o)
p_loy = proof('redeem:chk-x0:rw1', 'loyalty', 1, proc='loyalty')
o, e, r = place('attacker', {'ref': 'OL-X0', 'source': 'online', 'items': [{'name': 'Feast', 'price': 95, 'qty': 1}], 'total': 95,
                             'customer': {}}, {'id': 'chk-x0', 'total': 0}, [p_loy])
expect('EXPLOIT: a zero check total with a loyalty marker proof is NOT paid', j(o).get('paid') is False, o + e)
p_small2 = proof('pi_1p_b', 'card', 1)
o, e, r = place('attacker', {'ref': 'OL-XLINES', 'source': 'online', 'items': [{'name': 'Feast', 'price': 95, 'qty': 1}], 'total': 0.01,
                             'customer': {}}, {'id': 'chk-xl', 'total': 0.01}, [p_small2])
expect('EXPLOIT: an order total below its own lines (1p for a 95 pound line) is NOT paid', j(o).get('paid') is False and j(o).get('due_minor') >= 9000, o + e)
p_mid = proof('pi_15', 'card', 1500)
o, e, r = place('customer', {'ref': 'OL-DISC', 'source': 'online', 'items': burger, 'total': 15, 'customer': {}},
                {'id': 'chk-disc', 'total': 15, 'discounts': [{'label': 'Happy hour', 'type': 'amount', 'value': 5, 'amount': 5}]}, [p_mid])
expect('a declared auto discount lowers the amount due (20 of lines, 5 off, 15 paid)', j(o).get('paid') is True, o + e)
o, _, _ = run("select customer->'order_pricing'->>'discount_minor' from public.order_queue where ref = 'OL-DISC'")
expect('the declared discount is written on the order for staff to see', o == '500', o)
p_c15 = proof('pi_c15', 'card', 1500)
p_g10 = proof('giftcommit:chk-g:card1', 'gift', 1000, proc='gift')
o, e, r = place('customer', {'ref': 'OL-GIFT', 'source': 'online', 'items': [{'name': 'Meal', 'price': 25, 'qty': 1}], 'total': 25, 'customer': {}},
                {'id': 'chk-g', 'total': 15, 'gift_card': {'idempotency_key': 'giftcommit:chk-g:card1', 'applied': 1000}}, [p_c15, p_g10])
res = j(o)
expect('gift card plus card covering the order total is paid', res.get('paid') is True, o + e)
o, _, _ = run(f"select total from public.closed_checks where id = '{res.get('check_id')}'")
expect('the check books the verified card part (15.00), net of the gift card', o.startswith('15'), o)
p_c25 = proof('pi_c25', 'card', 2500)
o, e, r = place('customer', {'ref': 'OL-LIE', 'source': 'online', 'items': [{'name': 'Meal', 'price': 25, 'qty': 1}], 'total': 25, 'customer': {}},
                {'id': 'chk-lie', 'total': 0.01}, [p_c25])
res = j(o)
o2, _, _ = run(f"select total from public.closed_checks where id = '{res.get('check_id')}'")
expect('a check total the phone lowers is booked at the verified card amount', res.get('paid') is True and o2.startswith('25'), o + o2)
p_loyr = proof('redeem:chk-l:rw9', 'loyalty', 1, proc='loyalty')
o, e, r = place('customer', {'ref': 'OL-LOY', 'source': 'online', 'items': [{'name': 'Coffee', 'price': 3, 'qty': 1}], 'total': 0,
                             'discounts': [{'type': 'loyalty', 'label': 'Free coffee', 'amount_minor': 300}], 'customer': {}},
                {'id': 'chk-l', 'total': 0, 'loyalty': {'idempotency_key': 'redeem:chk-l:rw9', 'discount_value': 300}}, [p_loyr])
expect('a reward that covers the whole bill, with its redemption proof, is paid', j(o).get('paid') is True, o + e)
o, e, r = place('customer', {'ref': 'OL-LOYX', 'source': 'online', 'items': [{'name': 'Coffee', 'price': 3, 'qty': 1}], 'total': 0,
                             'discounts': [{'type': 'loyalty', 'amount_minor': 300}], 'customer': {}}, {'id': 'chk-lx', 'total': 0})
expect('the same reward without a redemption proof is not paid', j(o).get('paid') is False, o + e)
p_other = proof('pi_other', 'card', 2500, order_ref='OL-SOMEONE-ELSE')
o, e, r = place('attacker', {'ref': 'OL-STEAL', 'source': 'online', 'items': [{'name': 'Meal', 'price': 25, 'qty': 1}], 'total': 25, 'customer': {}},
                {'id': 'chk-steal', 'total': 25}, [p_other])
expect('a card payment the processor says is for another order never pays this one', j(o).get('paid') is False, o + e)
o, e, r = place('customer', {'ref': 'OL-OK1', 'source': 'online', 'items': burger, 'total': 25, 'customer': {}}, {'id': 'chk-ok-1', 'total': 25}, [p1], commit=False)
expect('retry by the same session returns the first answer', j(o).get('idempotent') is True and j(o).get('paid') is True, o + e)
o, e, r = place('attacker', {'ref': 'OL-OK1', 'source': 'online', 'items': burger, 'total': 25, 'customer': {}}, {'id': 'chk-ok-1', 'total': 25}, [p1], commit=False)
expect('another session cannot reuse the ref', j(o).get('reason') == 'ref_taken', o + e)
o, e, r = place('attacker', {'ref': 'OL-REUSE', 'source': 'online', 'items': burger, 'total': 25, 'customer': {}}, {'id': 'chk-reuse', 'total': 25}, [p1])
expect('a used card proof cannot pay a second order', j(o).get('paid') is False, o + e)
o, e, r = place('customer', {'ref': 'QR-LATER', 'source': 'qr', 'items': burger, 'total': 20, 'customer': {'tableId': 'T5'}}, commit=False)
expect('QR has no pay later: an order with no payment is refused', j(o).get('reason') == 'payment', o + e)
p_nochk = proof('pi_nochk', 'card', 2000)
o, e, r = place('customer', {'ref': 'OL-NOCHK', 'source': 'online', 'items': burger, 'total': 20, 'customer': {}}, None, [p_nochk])
expect('an online order that arrives without its check is still proven and paid', j(o).get('paid') is True and j(o).get('check_id'), o + e)
cat = {'ref': 'CT-1', 'source': 'catering', 'type': 'delivery', 'event_date': '2099-01-01',
       'items': [{'name': 'Tray', 'price': 50, 'qty': 1}], 'total': 50, 'customer': {'name': 'C'}}
o, e, r = place('customer', cat)
expect('catering pay later is placed unpaid (received)', j(o).get('ok') and j(o).get('paid') is False and j(o).get('status') == 'received', o + e)
o, _, _ = run("select event_date is null from public.order_queue where ref = 'CT-1'")
expect('a far future event date is dropped', o == 't', o)
p_cat = proof('pi_cat', 'card', 5000)
o, e, r = place('customer', {'ref': 'CT-2', 'source': 'catering', 'type': 'delivery', 'event_date': '2026-12-01',
                             'items': [{'name': 'Tray', 'price': 50, 'qty': 1}], 'total': 50, 'customer': {'payment_intent_id': 'pi_cat'}},
                {'id': 'chk-cat', 'total': 50, 'closed_at': '2026-12-01T12:00:00Z'}, [p_cat])
o2, _, _ = run("select closed_at::date from public.closed_checks where id = 'chk-cat'")
expect('a paid catering check keeps its event day as the sales date', j(o).get('paid') is True and o2 == '2026-12-01', o + o2)
o, e, r = as_('rawanon', f"select * from public.catering_day_load('{L1}', current_date);")
expect('catering load works without a session', r == 0, e)
bad = {'ref': 'OL-BAD', 'source': 'online', 'items': [{'n': 1}], 'total': 'abc', 'sent_at': 'garbage', 'is_asap': 'maybe', 'customer': {}}
o, e, r = place('customer', bad, commit=False)
expect('bad numbers and dates never raise (G10, G11)', r == 0 and j(o).get('ok') is True, o + e)
o, e, r = as_('rawanon', f"select public.place_public_order('{L1}', '{q(bad)}'::jsonb);")
expect('raw anon key cannot place orders (needs a session)', r != 0, e)
for n in range(20):
    place('stranger', {'ref': f'CT-SPAM{n}', 'source': 'catering', 'items': burger, 'total': 20, 'customer': {}}, ip='203.0.113.99')
o, e, r = place('joiner', {'ref': 'CT-SPAMX', 'source': 'catering', 'items': burger, 'total': 20, 'customer': {}}, ip='203.0.113.99', commit=False)
expect('one network is limited to 20 unpaid orders in 10 minutes', j(o).get('reason') == 'rate', o + e)
o, e, r = place('joiner', {'ref': 'CT-OTHERNET', 'source': 'catering', 'items': burger, 'total': 20, 'customer': {}}, ip='203.0.113.100', commit=False)
expect('another network is not affected', j(o).get('ok') is True, o + e)

# the tracker
o, e, r = as_('rawanon', f"select public.order_track_row('{L1}', 'OL-OK1', '{tok}')->>'status';")
expect('tracker works with the token and no session', last(o) == 'prep', o + e)
tok95, _, _ = run("select token from public.public_order_tokens where ref = 'OL-X95'")
o, e, r = as_('rawanon', f"select public.order_track_row('{L1}', 'OL-X95', '{tok95}')->>'payment_state';")
expect('tracker shows "payment being checked" for an unproven order', last(o) == 'checking', o + e)
o, e, r = as_('rawanon', f"select public.order_track_row('{L1}', 'OL-OK1', '0123')->'customer'->>'phone';")
expect('old share link (last 4) works and shows only 4 digits', last(o) == '0123', o + e)
o, e, r = as_('rawanon', f"select public.order_track_row('{L1}', 'OL-OK1', '0123')->'customer' ? 'name';")
expect('tracker never returns the name', last(o) == 'f', o + e)
guesses = ''.join(f"select public.order_track_check('{L1}', 'OL-OK1', '{i:04d}');" for i in range(10))
as_commit('rawanon', guesses)
o, e, r = as_('rawanon', f"select public.order_track_check('{L1}', 'OL-OK1', '0123');")
expect('10 wrong last 4 guesses lock that order last 4 path', last(o) == 'f', o + e)
o, e, r = as_('rawanon', f"select public.order_track_check('{L1}', 'OL-OK1', '{tok}');")
expect('but the tracking token still works (nobody can lock a customer out)', last(o) == 't', o + e)
run("insert into public.fence_attempts (bucket, misses, locked_until) values ('track:last4:global', 0, now() + interval '5 minutes') on conflict (bucket) do update set locked_until = excluded.locked_until")
tokd, _, _ = run("select token from public.public_order_tokens where ref = 'OL-DISC'")
o, e, r = as_('rawanon', f"select public.order_track_check('{L1}', 'OL-DISC', '{tokd}');")
expect('the platform last 4 breaker never blocks a token', last(o) == 't', o + e)
run("delete from public.fence_attempts")

# ---------- QR tabs: only the tab's own people add rounds (HIGH, 18 Sep)
hold = proof('pi_tab_000000001', 'preauth', 5000)
tab = {'ref': 'QR-T1', 'source': 'qr', 'type': 'dine-in', 'items': [{'name': 'Beer', 'price': 6, 'qty': 1}], 'total': 6,
       'customer': {'name': 'Bob', 'tableId': 'T5', 'tableLabel': '5', 'tab_open': True, 'payment_intent_id': 'pi_tab_000000001',
                    'stripe_account': 'acct_1', 'payment_method_id': 'pm_1', 'tab_join_code': '1234', 'pre_auth_amount': 9999}}
o, e, r = place('customer', tab)
rt = j(o)
join = rt.get('tab_join_code') or ''
expect('QR tab opened with a server table code (the phone code is ignored)', rt.get('ok') and len(join) == 6 and join != '1234', o + e)
o, _, _ = run("select customer->>'pre_auth_amount', customer->>'tab_ref' from public.order_queue where ref = 'QR-T1'")
expect('the hold amount comes from the proof, not the phone', o == '50.00|QR-T1', o)
tab2 = dict(tab, ref='QR-T2')
o, e, r = place('customer', tab2)
expect('the opener adds a round (no code needed)', j(o).get('ok') and j(o).get('tab_join_code') == join, o + e)
evil = dict(tab, ref='QR-EVIL1', customer=dict(tab['customer'], name='Eve', tab_join_code=None))
o, e, r = place('attacker', evil, commit=False)
expect('EXPLOIT: a stranger with only the tab payment id cannot add a round', j(o).get('reason') == 'tab_not_yours', o + e)
evil_code = dict(evil, ref='QR-EVIL2', tab_join_code='000000')
o, e, r = place('attacker', evil_code)
expect('a wrong table code is refused', j(o).get('reason') == 'tab_not_yours', o + e)
nontab = {'ref': 'QR-EVIL3', 'source': 'qr', 'type': 'dine-in', 'items': [{'name': 'Wine', 'price': 30, 'qty': 1}], 'total': 30,
          'customer': {'tableId': 'T5', 'tab_open': False, 'payment_intent_id': 'pi_tab_000000001', 'tab_ref': 'QR-T1', 'round_ref': 'x'}}
o, e, r = place('attacker', nontab, {'id': 'chk-evil3', 'total': 30})
o2, _, _ = run("select customer ? 'payment_intent_id', customer ? 'tab_ref', customer->>'payment_ref' from public.order_queue where ref = 'QR-EVIL3'")
expect('EXPLOIT: a pay now order naming the tab payment id is stored without it (it cannot join the tab)', o2 == 'f|f|pi_tab_000000001', o2 + e)
o, e, r = as_('customer', f"select jsonb_array_length(public.qr_tab_rounds('{L1}', 'pi_tab_000000001')->'rounds');")
expect('the tab still has only its own 2 rounds', last(o) == '2', o + e)
o, e, r = as_('attacker', f"select public.qr_table_open_tabs('{L1}', 'T5');")
expect('open tabs list has no payment id, no code, no name', 'pi_tab_000000001' not in o and join not in o and 'Bob' not in o and 'tab_handle' in o, o + e)
handle = json.loads(last(o))[0]['tab_handle']
o, e, r = as_('attacker', f"select public.qr_tab_rounds('{L1}', 'pi_tab_000000001')->'tab' ? 'tab_join_code';")
expect('someone who only holds the payment id does not learn the table code', last(o) == 'f', o + e)
o, e, r = as_('customer', f"select public.qr_tab_rounds('{L1}', 'pi_tab_000000001')->'tab'->>'tab_join_code';")
expect('the opener does', last(o) == join, o + e)
o, e, r = as_('joiner', f"select public.qr_tab_join('{L1}', '{handle}', 'WRONG1')->>'reason';")
expect('wrong table code refused', last(o) == 'wrong_code', o + e)
o, e, r = as_commit('joiner', f"select public.qr_tab_join('{L1}', '{handle}', '{join}')->'tab'->>'payment_intent_id';")
expect('right table code gives the tab', last(o) == 'pi_tab_000000001', o + e)
o, e, r = place('joiner', dict(tab, ref='QR-T3', customer=dict(tab['customer'], name='Jo')))
expect('a phone that joined with the code adds rounds without sending it again', j(o).get('ok') is True, o + e)
o, e, r = place('stranger', dict(tab, ref='QR-T4', tab_join_code=join))
expect('a round that carries the right code is accepted', j(o).get('ok') is True, o + e)
wrong = ''.join(f"select public.place_public_order('{L1}', '{q(dict(tab, ref='QR-W%d' % i, tab_join_code='11111%d' % i))}'::jsonb);" for i in range(8))
as_commit('dev2', wrong)
o, e, r = place('dup', dict(tab, ref='QR-W9', tab_join_code=join), commit=False)
expect('8 wrong codes lock the tab for codes (even the right one) for an hour', j(o).get('reason') == 'locked', o + e)
o, e, r = place('customer', dict(tab, ref='QR-T5'), commit=False)
expect('the opener is never locked out of their own tab', j(o).get('ok') is True, o + e)
o, e, r = as_('customer', f"select public.qr_table_tab_count('{L1}', 'T5');")
expect('tab count', r == 0, o + e)
o, e, r = as_('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_000000001', '{{}}'::jsonb, '{{}}'::uuid[])->>'reason';")
expect('settle refused before the server saw a capture', last(o) == 'not_captured', o + e)
proof('pi_tab_000000001', 'capture', 3000)
o, e, r = as_commit('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_000000001', '{{}}'::jsonb, '{{}}'::uuid[]);")
st = j(o)
expect('settle closes only the tab rounds (4), not the pay now order that named its payment id', st.get('closed') == 4 and st.get('ok') is True, o + e)
o, _, _ = run("select status from public.order_queue where ref = 'QR-EVIL3'")
expect('the pay now order is untouched', o != 'collected', o)
o, e, r = place('customer', dict(tab, ref='QR-T6'), commit=False)
expect('no new rounds on a captured tab', j(o).get('reason') == 'tab_closed', o + e)
hold2 = proof('pi_tab_000000002', 'preauth', 4000)
t2 = dict(tab, ref='QR-U1', customer=dict(tab['customer'], payment_intent_id='pi_tab_000000002'))
place('customer', t2)
run("update public.order_queue set status = 'collected' where ref = 'QR-U1'")
o, e, r = place('customer', dict(t2, ref='QR-U2'), commit=False)
expect('a hold that already opened a tab (all rounds collected) cannot open a new one', j(o).get('reason') == 'tab_closed', o + e)
nopi = dict(tab, ref='QR-T8', customer=dict(tab['customer'], payment_intent_id='pi_fake'))
o, e, r = place('attacker', nopi, commit=False)
expect('tab without a server proven hold refused', j(o).get('reason') == 'tab_not_verified', o + e)

# ---------- an unproven pay now order: checked, never looks unpaid, and gets its check once proven
qrpay = {'ref': 'QR-PAY1', 'source': 'qr', 'type': 'dine-in', 'items': [{'name': 'Pizza', 'price': 12, 'qty': 1}], 'total': 12,
         'customer': {'name': 'Pat', 'tableId': 'T9', 'payment_intent_id': 'pi_qrpay_0001', 'processor': 'stripe', 'paid': True}}
o, e, r = place('customer', qrpay, {'id': 'chk-qrpay1', 'total': 12, 'stripe_payment_intent_id': 'pi_qrpay_0001', 'processor': 'stripe'})
expect('QR pay now without proof is placed, marked unverified', j(o).get('payment_unverified') is True, o + e)
o, _, _ = run("select paid, customer->>'payment_state', customer->>'payment_ref', customer ? 'payment_intent_id', customer ? 'paid' from public.order_queue where ref = 'QR-PAY1'")
expect('the till sees "payment being checked" with the payment ref, never a pay-me order', o == 'f|checking|pi_qrpay_0001|f|f', o)
o, _, _ = run("select count(*) from public.public_order_pending_checks where ref = 'QR-PAY1'")
expect('its paid check is kept aside', o == '1', o)
run(f"insert into public.floor_tables (id, location_id, label) values ('ft-9', '{L1}', 'T9') on conflict do nothing;")
run(f"select public._qr_sync_table_session('{L1}', 'T9');")
o, _, _ = run(f"select count(*) from public.active_sessions where location_id = '{L1}' and table_id = 'ft-9'")
expect('an order whose payment is being checked puts nobody on the floor plan', o == '0', o)
o, e, r = as_('stranger', f"select public.verify_public_order_payment('{L1}', 'QR-PAY1')->>'reason';")
expect('a stranger cannot verify someone else order', last(o) == 'not_found', o + e)
o, e, r = as_('customer', f"select public.verify_public_order_payment('{L1}', 'QR-PAY1')->>'paid';")
expect('verify before the processor record arrives: still being checked', last(o) == 'false', o + e)
proof('pi_qrpay_0001', 'card', 1200)
o, e, r = as_commit('dev1b', f"select public.verify_public_order_payment('{L1}', 'QR-PAY1');")
expect('a till of the venue verifies once the proof arrived', j(o).get('paid') is True, o + e)
o, _, _ = run("select paid, customer->>'payment_state', customer->>'payment_intent_id' from public.order_queue where ref = 'QR-PAY1'")
expect('the order is paid, verified, and gets its own payment id back', o == 't|verified|pi_qrpay_0001', o)
o, _, _ = run("select total, status, source from public.closed_checks where id = 'chk-qrpay1'")
expect('the kept check is written with the verified amount', o.startswith('12') and o.endswith('|paid|qr'), o)
o, _, _ = run("select count(*) from public.public_order_pending_checks where ref = 'QR-PAY1'")
expect('the kept check is gone', o == '0', o)
o, e, r = as_('customer', f"select public.confirm_public_order_payment('{L1}', 'OL-X95', 'I paid');")
expect('a customer can never confirm a payment by hand', r != 0 and 'staff' in e, e)
o, e, r = as_commit('owner1', f"select public.confirm_public_order_payment('{L1}', 'OL-X95', 'seen in Stripe');")
expect('staff confirm a payment they saw', j(o).get('paid') is True, o + e)
o, _, _ = run("select paid, customer->>'payment_state', customer->>'payment_confirmed_by' from public.order_queue where ref = 'OL-X95'")
expect('who confirmed it is on the order', o == f"t|confirmed_by_staff|{UID['owner1']}", o)

# ---------- who wrote each order row (file 2's gate)
as_commit('attacker', f"insert into public.order_queue (ref, location_id, type, source, status, items) values ('OLD-PAGE', '{L1}', 'collection', 'online', 'prep', '[]');")
as_commit('dev1b', f"insert into public.order_queue (ref, location_id, type, source, status, items) values ('TILL-1', '{L1}', 'collection', 'pos', 'prep', '[]');")
as_commit('service', f"insert into public.order_queue (ref, location_id, type, source, status, items, customer) values ('EZ-1', '{L1}', 'delivery', 'catering', 'received', '[]', '{{\"channel\":\"ezcater\"}}');")
o, _, _ = run("select string_agg(ref || '=' || placed_via, ',' order by ref) from public.order_queue where ref in ('OLD-PAGE','TILL-1','EZ-1','OL-OK1')")
expect('placed_via: public for an old page, staff for a till, server for ezCater, rpc for the new page',
       o == 'EZ-1=server,OL-OK1=rpc,OLD-PAGE=public,TILL-1=staff', o)
o, e, r = as_('attacker', "update public.order_queue set placed_via = 'rpc' where ref = 'OLD-PAGE'; select placed_via from public.order_queue where ref = 'OLD-PAGE';")
expect('nobody can rewrite placed_via', last(o) == 'public', o + e)

# ---------- print agents
run(f"insert into public.print_jobs (location_id, printer_id, printer_ip, job_type, payload, status) values ('{L1}', 'p1', '10.0.0.5', 'receipt', 'eA==', 'pending'), ('{L3}', 'p3', '10.0.0.6', 'receipt', 'eA==', 'pending');")
o, e, r = as_('attacker', f"select public.issue_print_agent_token('{L1}', 'x');")
expect('anonymous session cannot issue an agent key', r != 0, e)
o, e, r = as_commit('owner1', f"select public.issue_print_agent_token('{L1}', 'Kitchen agent')->>'token';")
agent = last(o)
expect('Back Office issues an agent key', agent.startswith('pa_'), o + e)
bad = ''.join(f"select public.print_agent_claim('pa_wrong{i}', 'a', 5, 60);" for i in range(250))
as_commit('rawanon', bad)
o, e, r = as_('rawanon', f"select jsonb_array_length(public.print_agent_claim('{agent}', 'agent-1', 5, 60)->'jobs');")
expect('250 bad keys never stop a good key: the agent claims its own venue job', last(o) == '1', o + e)
o, e, r = as_('rawanon', "select public.print_agent_claim('pa_wrong', 'a', 5, 60)->>'reason';")
expect('wrong agent key refused', last(o) == 'bad_key', o + e)

# ---------- QR floor trigger function (attached in file 2, called directly here)
run(f"insert into public.floor_tables (id, location_id, label) values ('ft-5', '{L1}', 'T5') on conflict do nothing;")
hold3 = proof('pi_tab_000000003', 'preauth', 5000)
place('customer', dict(tab, ref='QR-F1', customer=dict(tab['customer'], payment_intent_id='pi_tab_000000003')))
run(f"select public._qr_sync_table_session('{L1}', 'T5');")
o, e, r = run(f"select table_id, session->>'source', session->>'qr_tab_count' from public.active_sessions where location_id = '{L1}' and table_id = 'ft-5'")
expect('QR floor sync writes a qr session on the canonical table', o == 'ft-5|qr|1', o)
run(f"insert into public.active_sessions (location_id, table_id, session) values ('{L1}', 'ft-7', '{{\"items\":[1],\"source\":\"pos\"}}');")
run(f"update public.order_queue set customer = customer || '{{\"tableId\":\"ft-7\"}}' where ref = 'QR-F1';")
run(f"select public._qr_sync_table_session('{L1}', 'ft-7');")
o, e, r = run(f"select session->>'source' from public.active_sessions where location_id = '{L1}' and table_id = 'ft-7'")
expect('QR floor sync never overwrites a till session', o == 'pos', o)

# ---------- grants
o, e, r = run("select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('anon', c.oid, 'TRUNCATE')")
expect('no TRUNCATE left for anon', o == '0', o)
o, e, r = run("select has_function_privilege('anon', 'public.claim_device(text)', 'execute'), has_function_privilege('anon', 'public._device_claim_core(text, boolean)', 'execute'), has_function_privilege('authenticated', 'public._device_claim_core(text, boolean)', 'execute'), has_function_privilege('anon', 'public.place_public_order(uuid, jsonb, jsonb, uuid[])', 'execute'), has_function_privilege('anon', 'public.confirm_public_order_payment(uuid, text, text)', 'execute')")
expect('function grants: claim not for raw anon, core private, order and confirm need a session', o == 'f|f|f|f|f', o)
o, e, r = run("select has_table_privilege('authenticated', 'public.payment_proofs', 'select'), has_table_privilege('anon', 'public.public_order_pending_checks', 'select'), has_table_privilege('authenticated', 'public.qr_tab_members', 'select'), has_table_privilege('authenticated', 'public.device_unlinked_pings', 'select')")
expect('private tables are private', o == 'f|f|f|f', o)

t.finish()
