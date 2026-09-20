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

out, err, rc = t.apply('20260919a_OPS_fence_1_after_release.sql')
expect('file A applies cleanly (one transaction)', rc == 0, err[-2000:])
print('   verify row:', last(out))
out2, err2, rc2 = t.apply('20260919a_OPS_fence_1_after_release.sql')
expect('file A applies a second time (idempotent)', rc2 == 0, err2[-2000:])
expect('verify row: 4 allow all left, codes not readable, no truncate, no untrusted links, stamp trigger, rules and stamp ledger closed',
       last(out2).split('|')[0] == 'active_sessions, kds_tickets, order_queue, table_reservations'
       and last(out2).split('|')[4:] == ['f', '0', '0', '0', '0', 't', 'f', 'f'], last(out2))
o, _, _ = run("select set_at < now() - interval '1 second' or true, count(*) from public.fence_state where key = 'file_a' group by 1")
o2, _, _ = run("update public.fence_state set set_at = now() - interval '5 hours' where key = 'file_a' returning 1")
out3, err3, rc3 = t.apply('20260919a_OPS_fence_1_after_release.sql')
o3, _, _ = run("select set_at < now() - interval '4 hours' from public.fence_state where key = 'file_a'")
expect('running file A again keeps the time it FIRST ran (file 2 counts its day from that)', rc3 == 0 and o3 == 't', o3 + err3[-500:])

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
# LOW (fix round 2): a new venue never chooses its venue code (the Adyen store reference)
beta_code, _, _ = run(f"select venue_code from public.locations where id = '{L3}'")
o, e, r = as_('mallory', f"""
do $$ declare v_org uuid; v_code text; v_future text; begin
  insert into public.organisations (name, slug) values ('Mal code', 'mal-code') returning id into v_org;
  insert into public.locations (org_id, name, venue_code) values (v_org, 'Copycat', '{beta_code}') returning venue_code into v_code;
  if v_code = '{beta_code}' then raise exception 'COPIED %', v_code; end if;
  insert into public.locations (org_id, name, venue_code) values (v_org, 'Squatter', 'SV-9999') returning venue_code into v_future;
  if v_future = 'SV-9999' then raise exception 'SQUATTED %', v_future; end if;
  raise notice 'CODES_OK % %', v_code, v_future;
end $$;""")
expect('LOW: a new venue cannot copy another venue\'s code, nor take a future one: the server gives it the next code', r == 0 and 'CODES_OK' in e, e)
o, e, r = as_('newbie', """
do $$ declare v_org uuid; v_code text; begin
  insert into public.organisations (name, slug) values ('Plain', 'plain-co') returning id into v_org;
  insert into public.locations (org_id, name) values (v_org, 'Plain One') returning venue_code into v_code;
  if v_code !~ '^SV-[0-9]{4}$' then raise exception 'BAD CODE %', v_code; end if;
  raise notice 'PLAIN_OK %', v_code;
end $$;""")
expect('a venue made the normal way keeps the code the database gave it', r == 0 and 'PLAIN_OK' in e, e)

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
# LOW (fix round 2): the same session asking again gets the SAME secret, never a new one
o, e, r = as_commit('dev4', "select (public.device_issue_secret()->>'device_secret');")
expect('LOW: asking again (a second boot check at the same moment) returns the same secret', last(o) == secret, o + e)
o, e, r = as_commit('dev4', "select (public.claim_device_v2('')->>'device_secret');")
expect('LOW: so does claim_device_v2 on the already linked kiosk', last(o) == secret, o + e)
o, _, _ = run(f"select device_secret_hash = encode(sha256(convert_to('{secret}', 'UTF8')), 'hex') from public.devices where id = '{DEV['kiosk1']}'")
expect('and the server still holds that secret', o == 't', o)
o, _, _ = run(f"select count(*) from public.device_claim_log where device_id = '{DEV['kiosk1']}' and event = 'secret_issued'")
expect('only the first issue is logged', o == '1', o)
import threading, time as _time
holder_out = {}
def _issue(tag, delay, hold):
    _time.sleep(delay)
    oo, ee, rr = as_commit('dup', f"select (public.device_issue_secret()->>'device_secret'); select pg_sleep({hold});")
    holder_out[tag] = [l for l in oo.splitlines() if len(l.strip()) == 64]
th1 = threading.Thread(target=_issue, args=('a', 0, 2))
th2 = threading.Thread(target=_issue, args=('b', 0.5, 0))
th1.start(); th2.start(); th1.join(); th2.join()
sa, sb = (holder_out.get('a') or [''])[0], (holder_out.get('b') or [''])[0]
o, _, _ = run(f"select device_secret_hash = encode(sha256(convert_to('{sa}', 'UTF8')), 'hex') from public.devices where id = '{DEV['dupa']}'")
expect('LOW: two calls from one till at the same moment both get the secret the server keeps', len(sa) == 64 and sa == sb and o == 't', f'{sa} {sb} {o}')
run(f"update public.device_secret_stash set issued_at = now() - interval '11 minutes' where device_id = '{DEV['kiosk1']}'")
o, e, r = as_commit('dev4', "select (public.device_issue_secret()->>'device_secret');")
secret2 = last(o)
expect('after 10 minutes a till that still asks (it has none) gets a new one', len(secret2) == 64 and secret2 != secret, o + e)
o, e, r = as_('dev1b', f"select public.reclaim_device('{DEV['kiosk1']}', '{secret}')->>'reason';")
expect('and the old one no longer re-links', last(o) == 'invalid', o + e)
secret = secret2
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

# ---------- place_public_order: the server decides paid, from ITS OWN valuation (fix round 2)
def proof(ref, kind, amount, loc=L1, proc='stripe', order_ref=None, meta=None):
    m = dict(meta or {})
    if order_ref is not None:
        m['order_ref'] = order_ref
    mj = 'null' if not m else f"'{json.dumps(m)}'::jsonb"
    run(f"insert into public.payment_proofs (processor, payment_ref, kind, location_id, amount_minor, verified_by, meta) values ('{proc}', '{ref}', '{kind}', '{loc}', {amount}, 'test', {mj})")
    o, _, _ = run(f"select id from public.payment_proofs where payment_ref = '{ref}' and kind = '{kind}'")
    return o

def q(x):
    return json.dumps(x).replace("'", "''")

def place(who, order, check=None, proofs=(), commit=True, ip=None):
    fn = as_commit if commit else as_
    c = 'null' if check is None else f"'{q(check)}'::jsonb"
    ids = "array[" + ','.join(f"'{p}'" for p in proofs) + "]::uuid[]" if proofs else "'{}'::uuid[]"
    return fn(who, f"select public.place_public_order('{L1}', '{q(order)}'::jsonb, {c}, {ids});", ip=ip)

NAMES = {'mi-burger': 'Burger', 'mi-feast': 'Feast', 'mi-tea': 'Tea', 'mi-beer': 'Beer', 'mi-pizza': 'Pizza',
         'mi-meal': 'Meal', 'mi-coffee': 'Coffee', 'mi-tray': 'Tray', 'mi-wine': 'Wine', 'mi-chips': 'Chips',
         'mi-wrap': 'Wrap', 'mi-fries': 'Fries', 'mi-donut': 'Donut', 'mi-cake': 'Cake',
         'mi-cola-half': 'Cola \u2014 Half', 'mi-cola-pint': 'Cola \u2014 Pint'}

def line(item, price, qty=1, **kw):
    return dict({'itemId': item, 'name': NAMES.get(item, item), 'price': price, 'qty': qty}, **kw)

def chk(ref, tail='a1b2'):
    return f'chk-{ref}-{tail}'

def pricing(ref):
    o, _, _ = run(f"select coalesce(customer->'order_pricing', '{{}}'::jsonb) from public.order_queue where ref = '{ref}'")
    return json.loads(o or '{}')

def state(ref):
    o, _, _ = run(f"select paid::text || '|' || coalesce(customer->>'payment_state', '-') from public.order_queue where ref = '{ref}'")
    return o

def online(ref, items, total, discounts=None, customer=None, type_='collection'):
    o = {'ref': ref, 'source': 'online', 'type': type_, 'items': items, 'total': total, 'customer': customer or {}}
    if discounts is not None:
        o['discounts'] = discounts
    return o

burger = [line('mi-burger', 20)]

# A real paid online order: the menu price, an option, forged server fields ignored.
p1 = proof('pi_card_1', 'card', 2500, order_ref='OL-OK1')
o, e, r = place('customer', {'ref': 'OL-OK1', 'source': 'online', 'type': 'collection', 'status': 'collected', 'staff': 'Evil',
                             'items': [line('mi-burger', 20, mods=[{'id': 'opt-bacon', 'name': 'Bacon', 'price': 5}])], 'total': 25,
                             'customer': {'name': 'Ann', 'phone': '07700 900123', 'paid': True, 'order_pricing': {'due_minor': 1}}},
                {'id': 'chk-ok-1', 'total': 25, 'subtotal': 20.83, 'tax_amount': 4.17, 'processor': 'stripe',
                 'stripe_payment_intent_id': 'pi_card_1', 'status': 'refunded', 'staff_id': 'x'}, [p1])
res = j(o)
expect('a real paid online order with a covering card proof is paid', res.get('paid') is True and res.get('check_id') == 'chk-ok-1', o + e)
tok = res.get('track_token', '')
o, _, _ = run("select status, staff is null, paid, placed_via, customer ? 'paid', (customer->'order_pricing'->>'due_minor') from public.order_queue where ref = 'OL-OK1'")
expect('order row: server status, no staff, paid, rpc, phone paid flag stripped, amount due from the server', o == 'prep|t|t|rpc|f|2500', o)
o, _, _ = run("select status, source, total from public.closed_checks where id = 'chk-ok-1'")
expect('paid check written by the server', o.startswith('paid|online|25'), o)
o, _, _ = run("select items->0->'voided' from public.closed_checks where id = 'chk-ok-1'")
expect('the check carries the server lines (voided false)', o == 'false', o)

# ----- normal orders, priced by the server
p = proof('pi_mods', 'card', 2450, order_ref='OL-MODS')
o, e, r = place('customer', online('OL-MODS', [line('mi-burger', 20, mods=[{'id': 'opt-bacon', 'name': 'Bacon', 'price': 5},
                                                                         {'id': 'opt-noonion', 'name': 'No onions', 'price': -0.5}])], 24.5),
                {'id': chk('OL-MODS'), 'total': 24.5}, [p])
expect('NORMAL: a burger with bacon (+5) and no onions (-0.50) at 24.50 is paid', j(o).get('paid') is True and pricing('OL-MODS').get('goods_minor') == 2450, o + e)
p = proof('pi_var1', 'card', 302, order_ref='OL-VAR1')
o, e, r = place('customer', online('OL-VAR1', [line('mi-cola-half', 3.02)], 3.02), {'id': chk('OL-VAR1'), 'total': 3.02}, [p])
expect('NORMAL: a size (its own menu row) at its collection price is paid', j(o).get('paid') is True, o + e)
p = proof('pi_var2', 'card', 285, order_ref='OL-VAR2')
o, e, r = place('customer', online('OL-VAR2', [line('mi-cola-half', 2.85)], 2.85, type_='delivery'), {'id': chk('OL-VAR2'), 'total': 2.85}, [p])
expect('NORMAL: the same size on delivery at its delivery price (2.85) is paid', j(o).get('paid') is True, o + e)
p = proof('pi_var3', 'card', 285, order_ref='OL-VAR3')
o, e, r = place('customer', online('OL-VAR3', [line('mi-cola-half', 2.85)], 2.85), {'id': chk('OL-VAR3'), 'total': 2.85}, [p])
expect('the delivery price sent on a collection order counts at the collection price (short)', j(o).get('paid') is False and state('OL-VAR3') == 'false|short', o + e)
o, _, _ = run("select items->0->>'name' from public.order_queue where ref = 'OL-VAR1'")
expect('a size keeps the storefront name "Cola - Half" (a long dash)', o == 'Cola \u2014 Half', o)
p = proof('pi_tier', 'card', 250, order_ref='OL-TIER')
o, e, r = place('customer', online('OL-TIER', [line('mi-chips', 2.5)], 2.5), {'id': chk('OL-TIER'), 'total': 2.5}, [p])
expect('NORMAL: an item at its happy hour menu tier price (2.50, base 4) is paid', j(o).get('paid') is True, o + e)
p = proof('pi_tier2', 'card', 200, order_ref='OL-TIER2')
o, e, r = place('customer', online('OL-TIER2', [line('mi-chips', 2)], 2), {'id': chk('OL-TIER2'), 'total': 2}, [p])
expect('below every price the menu gives it: short', j(o).get('paid') is False, o + e)
p = proof('pi_deal', 'card', 1000, order_ref='OL-DEAL')
o, e, r = place('customer', online('OL-DEAL', [line('mi-wrap', 8), line('mi-fries', 3.5)], 10,
                                   discounts=[{'type': 'auto', 'label': 'Meal deal', 'amount_minor': 150}]),
                {'id': chk('OL-DEAL'), 'total': 10}, [p])
expect('NORMAL: a meal deal (bundle rule: wrap and fries for 10) is paid at 10', j(o).get('paid') is True and pricing('OL-DEAL').get('auto_minor') == 150, o + e)
p = proof('pi_donut', 'card', 500, order_ref='OL-DONUT')
o, e, r = place('customer', online('OL-DONUT', [line('mi-donut', 2, qty=3)], 5), {'id': chk('OL-DONUT'), 'total': 5}, [p])
expect('NORMAL: buy two donuts, third half price (buy X rule) is paid at 5', j(o).get('paid') is True and pricing('OL-DONUT').get('auto_minor') == 100, o + e)
p = proof('pi_cake', 'card', 1, order_ref='OL-CAKE')
o, e, r = place('attacker', online('OL-CAKE', [line('mi-cake', 4)], 0.01, discounts=[{'type': 'auto', 'label': 'free cake', 'amount_minor': 399}]),
                {'id': chk('OL-CAKE'), 'total': 0.01}, [p])
expect('rules for the till only, expired, or never live never apply online: a cake is due in full', j(o).get('paid') is False and pricing('OL-CAKE').get('auto_minor') == 0, o + e)

# ----- promo codes: proven, and used up once
p = proof('pi_promo', 'card', 1500, order_ref='OL-PROMO')
o, e, r = place('customer', online('OL-PROMO', [line('mi-meal', 25)], 15, discounts=[{'type': 'promo', 'label': 'SAVE10', 'amount_minor': 1000}]),
                {'id': chk('OL-PROMO'), 'total': 15}, [p])
expect('NORMAL: a real promo code (10 off a 25 meal) is paid at 15', j(o).get('paid') is True and pricing('OL-PROMO').get('promo_minor') == 1000, o + e)
o, _, _ = run("select uses_count, status from public.promo_codes where code = 'SAVE10'")
o2, _, _ = run(f"select count(*) from public.promo_redemptions where idempotency_key = '{chk('OL-PROMO')}:SAVE10' and order_id = '{chk('OL-PROMO')}'")
expect('the code is used up by the order, under the key the page\'s own promo-redeem call sends', o == '1|redeemed' and o2 == '1', o + ' ' + o2)
o, e, r = as_('service', f"select public.promo_redeem_atomic('81000000-0000-4000-8000-000000000001', 0, '80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'SAVE10', null, '{L1}', '{chk('OL-PROMO')}', null, 25, 10, '{chk('OL-PROMO')}:SAVE10')->>'result';")
expect('so the page\'s later promo-redeem finds it done (idempotent), never a second use', last(o) == 'idempotent_hit', o + e)
p = proof('pi_promo2', 'card', 1500, order_ref='OL-PROMO2')
o, e, r = place('attacker', online('OL-PROMO2', [line('mi-meal', 25)], 15, discounts=[{'type': 'promo', 'label': 'SAVE10', 'amount_minor': 1000}]),
                {'id': chk('OL-PROMO2'), 'total': 15}, [p])
expect('EXPLOIT: a spent single use code on a second order is not a discount (short)', j(o).get('paid') is False and pricing('OL-PROMO2').get('promo_reason') == 'already_used', o + e)
p = proof('pi_multi', 'card', 2250, order_ref='OL-MULTI')
o, e, r = place('customer', online('OL-MULTI', [line('mi-meal', 25)], 22.5, discounts=[{'type': 'promo', 'label': 'multi10', 'amount_minor': 250}]),
                {'id': chk('OL-MULTI'), 'total': 22.5}, [p])
expect('NORMAL: a 10 percent code (2.50 off 25) is paid at 22.50', j(o).get('paid') is True, o + e)
run("insert into public.fence_attempts (bucket, misses, locked_until) values ('order:unproven:ip:198.51.100.9', 0, now() + interval '10 minutes') on conflict (bucket) do update set locked_until = excluded.locked_until")
u0, _, _ = run("select uses_count from public.promo_codes where code = 'MULTI10'")
p = proof('pi_rate', 'card', 1, order_ref='OL-RATE')
o, e, r = place('attacker', online('OL-RATE', [line('mi-meal', 25)], 22.5, discounts=[{'type': 'promo', 'label': 'MULTI10', 'amount_minor': 250}]),
                {'id': chk('OL-RATE'), 'total': 22.5}, [p], ip='198.51.100.9')
u1, _, _ = run("select uses_count from public.promo_codes where code = 'MULTI10'")
expect('an order refused for its network (too many unproven orders) never uses a promo code up', j(o).get('reason') == 'rate' and u0 == u1, o + e + f' {u0} {u1}')
run("delete from public.fence_attempts where bucket = 'order:unproven:ip:198.51.100.9'")
p = proof('pi_beta', 'card', 1500, order_ref='OL-BETA')
o, e, r = place('attacker', online('OL-BETA', [line('mi-meal', 25)], 15, discounts=[{'type': 'promo', 'label': 'BETA10', 'amount_minor': 1000}]),
                {'id': chk('OL-BETA'), 'total': 15}, [p])
expect('EXPLOIT: another company\'s promo code counts for nothing here', j(o).get('paid') is False and pricing('OL-BETA').get('promo_reason') == 'wrong_venue', o + e)
o, _, _ = run("select uses_count from public.promo_codes where code = 'BETA10'")
expect('and is not used up', o == '0', o)
p = proof('pi_old', 'card', 1500, order_ref='OL-OLDC')
o, e, r = place('attacker', online('OL-OLDC', [line('mi-meal', 25)], 15, discounts=[{'type': 'promo', 'label': 'OLDCODE', 'amount_minor': 1000}]),
                {'id': chk('OL-OLDC'), 'total': 15}, [p])
expect('a code whose offer ended counts for nothing', j(o).get('paid') is False, o + e)

# ----- loyalty: only a redemption recorded for THIS order
run(f"insert into public.loyalty_transactions (customer_id, company_id, location_id, type, points, balance_after, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), '{L1}', 'redeem', -100, 0, 'redeem:{chk('OL-LOY')}:rw1')")
lp = proof(f"redeem:{chk('OL-LOY')}:rw1", 'loyalty', 300, proc='loyalty')
o, e, r = place('customer', online('OL-LOY', [line('mi-coffee', 3)], 0, discounts=[{'type': 'loyalty', 'label': 'Free coffee', 'amount_minor': 300}]),
                {'id': chk('OL-LOY'), 'total': 0, 'loyalty': {'idempotency_key': f"redeem:{chk('OL-LOY')}:rw1", 'discount_value': 300}}, [lp])
expect('NORMAL: a points reward worth 3 (its redemption row names this order) pays for a coffee', j(o).get('paid') is True and pricing('OL-LOY').get('loyalty_minor') == 300, o + e)
run(f"insert into public.stamp_transactions (customer_id, program_id, location_id, stamps, type, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), '{L1}', 0, 'redeem', 'stampredeem:{chk('OL-STAMP')}:prog1')")
p = proof('pi_stamp', 'card', 2500, order_ref='OL-STAMP')
# Fix round 4: the stamp card's proof says WHAT the reward is (payment-proof reads the
# programme's reward_config), so the server values the free coffee from the coffee on the order.
sp = proof(f"stampredeem:{chk('OL-STAMP')}:prog1", 'loyalty', 1, proc='loyalty',
           meta={'reward': {'type': 'free_item', 'items': [{'id': None, 'name': 'Coffee'}]}})
o, e, r = place('customer', online('OL-STAMP', [line('mi-coffee', 3), line('mi-meal', 25)], 25, discounts=[{'type': 'loyalty', 'label': 'Free coffee', 'amount_minor': 300}]),
                {'id': chk('OL-STAMP'), 'total': 25}, [p, sp])
expect('NORMAL: a stamp card free coffee (its proof names the free item) is paid at 25',
       j(o).get('paid') is True and pricing('OL-STAMP').get('loyalty_minor') == 300, o + e)
p = proof('pi_stamp2', 'card', 500, order_ref='OL-STAMP2')
o, e, r = place('attacker', online('OL-STAMP2', [line('mi-coffee', 3), line('mi-meal', 25)], 5, discounts=[{'type': 'loyalty', 'label': 'x', 'amount_minor': 2300}]),
                {'id': chk('OL-STAMP2'), 'total': 5}, [p])
expect('EXPLOIT: another order\'s real stamp redemption never discounts this one', j(o).get('paid') is False and pricing('OL-STAMP2').get('loyalty_minor') == 0, o + e)
run(f"insert into public.stamp_transactions (customer_id, program_id, location_id, stamps, type, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), '{L1}', 0, 'redeem', 'stampredeem:{chk('OL-BIGLOY')}:prog1')")
p = proof('pi_bigloy', 'card', 1, order_ref='OL-BIGLOY')
o, e, r = place('attacker', online('OL-BIGLOY', [line('mi-coffee', 3), line('mi-meal', 25)], 0.01, discounts=[{'type': 'loyalty', 'label': 'x', 'amount_minor': 2800}]),
                {'id': chk('OL-BIGLOY'), 'total': 0.01}, [p])
expect('EXPLOIT: a real redemption the server cannot value (no proof at all) takes off NOTHING (fix round 4)',
       j(o).get('paid') is False and pricing('OL-BIGLOY').get('loyalty_minor') == 0 and pricing('OL-BIGLOY').get('due_minor', 0) >= 2790, o + e)
run(f"insert into public.loyalty_transactions (customer_id, company_id, location_id, type, points, balance_after, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), '{L1}', 'redeem', -100, 0, 'redeem:{chk('OL-FIXLOY')}:rw2')")
lp2 = proof(f"redeem:{chk('OL-FIXLOY')}:rw2", 'loyalty', 200, proc='loyalty')
p = proof('pi_fixloy', 'card', 1, order_ref='OL-FIXLOY')
o, e, r = place('attacker', online('OL-FIXLOY', [line('mi-meal', 25)], 0.01, discounts=[{'type': 'loyalty', 'label': 'x', 'amount_minor': 2499}]),
                {'id': chk('OL-FIXLOY'), 'total': 0.01}, [p, lp2])
expect('EXPLOIT: a points reward worth 2 (recorded on its loyalty proof) never takes off more than 2',
       j(o).get('paid') is False and pricing('OL-FIXLOY').get('loyalty_minor') == 200, o + e)
o, e, r = as_('attacker', f"insert into public.stamp_transactions (customer_id, program_id, location_id, stamps, type, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), '{L1}', 0, 'redeem', 'stampredeem:chk-OL-FORGE-1:p');")
expect('EXPLOIT: nobody can forge a stamp redemption from the browser any more', r != 0, e)
o, e, r = as_('rawanon', f"insert into public.stamp_transactions (customer_id, program_id, location_id, stamps, type) values (gen_random_uuid(), gen_random_uuid(), '{L1}', 0, 'redeem');")
expect('not even with the raw anon key', r != 0, e)
o, e, r = as_('attacker', "select count(*) >= 0 from public.stamp_transactions;")
expect('stamp ledger reads are unchanged (stage 2)', last(o) == 't', o + e)

# A loyalty redemption that lands after the order: the payment check counts it then.
p = proof('pi_late', 'card', 2500, order_ref='OL-LATE')
o, e, r = place('customer', online('OL-LATE', [line('mi-coffee', 3), line('mi-meal', 25)], 25, discounts=[{'type': 'loyalty', 'label': 'Free coffee', 'amount_minor': 300}]),
                {'id': chk('OL-LATE'), 'total': 25}, [p])
expect('a reward redeemed too slowly: the order arrives short, never paid', j(o).get('paid') is False and state('OL-LATE') == 'false|short', o + e)
run(f"insert into public.stamp_transactions (customer_id, program_id, location_id, stamps, type, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), '{L1}', 0, 'redeem', 'stampredeem:{chk('OL-LATE')}:prog1')")
proof(f"stampredeem:{chk('OL-LATE')}:prog1", 'loyalty', 1, proc='loyalty',
      meta={'reward': {'type': 'free_item', 'items': [{'id': 'mi-coffee', 'name': 'Coffee'}]}})
o, e, r = as_commit('customer', f"select public.verify_public_order_payment('{L1}', 'OL-LATE', array['{p}']::uuid[]);")
expect('once the redemption row lands, Check payment values it from the kept check\'s own lines and the order is paid',
       j(o).get('paid') is True and state('OL-LATE').startswith('true|verified'), o + e)

# ----- discount rules can prove a discount because nobody but Back Office writes them now
o, e, r = as_('attacker', f"insert into public.discount_rules (location_id, name, trigger_type, trigger_category_ids, trigger_qty, reward_type, reward_value, reward_qty) values ('{L1}', 'evil', 'buy_x', '{{cat-mains}}', 0, 'free', 0, 1);")
expect('EXPLOIT: an anonymous session cannot add a discount rule any more', r != 0, e)
o, e, r = as_('attacker', "with u as (update public.discount_rules set reward_value = 100 returning 1) select count(*) from u;")
expect('nor change one', last(o) == '0' or r != 0, o + e)
o, e, r = as_('rawanon', f"insert into public.discount_rules (location_id, name) values ('{L1}', 'evil');")
expect('nor the raw anon key', r != 0, e)
o, e, r = as_('owner2', f"insert into public.discount_rules (location_id, name) values ('{L1}', 'evil');")
expect('nor another venue\'s owner', r != 0, e)
o, e, r = as_('owner1', f"insert into public.discount_rules (location_id, name) values ('{L1}', 'Staff rule'); select count(*) from public.discount_rules where location_id = '{L1}';")
expect('the venue\'s own Back Office still adds and reads its rules', r == 0 and last(o) == '6', o + e)
o, e, r = as_('customer', f"select count(*) from public.discount_rules where location_id = '{L1}' and active;")
expect('customer pages still read the active rules', last(o) == '5', o + e)

# ----- THE SEVEN WAYS (18 Sep review): a 95 pound Feast, 1p paid, a 1p card proof for the order
def seven(ref, items, total=0.01, check=None, discounts=None):
    p = proof(f'pi_{ref}', 'card', 1, order_ref=ref)
    c = check if check is not None else {'id': chk(ref), 'total': 0.01}
    return place('attacker', online(ref, items, total, discounts=discounts), c, [p])
feast = [line('mi-feast', 95)]
cases = [
    ('OL-W1', 'promo declared in p_order.discounts (9499)', feast, None, [{'type': 'promo', 'label': 'FAKE', 'amount_minor': 9499}], 'due'),
    ('OL-W2', 'the same through p_check.discounts (94.99)', feast, {'id': chk('OL-W2'), 'total': 0.01, 'discounts': [{'type': 'promo', 'value': 94.99}]}, None, 'due'),
    ('OL-W3', 'a made up option priced -94.99', [line('mi-feast', 95, mods=[{'name': 'No onions', 'price': -94.99}])], None, None, 'due'),
    ('OL-W3B', 'a real option (No onions, -0.50) sent at -94.99', [line('mi-feast', 95, mods=[{'id': 'opt-noonion', 'name': 'No onions', 'price': -94.99}])], None, None, 'due'),
    ('OL-W4', 'a second line priced -94.99', feast + [line('mi-tea', -94.99)], None, None, 'due'),
    ('OL-W4B', 'a second line with no id priced -94.99', feast + [{'name': 'Refund', 'price': -94.99, 'qty': 1}], None, None, 'unknown'),
    ('OL-W5', 'quantity 0.0001', [line('mi-feast', 95, qty=0.0001)], None, None, 'due'),
    ('OL-W6', 'the line flagged voided', [line('mi-feast', 95, voided=True)], None, None, 'due'),
    ('OL-W7', "price '£95' (read as 0)", [line('mi-feast', '£95')], None, None, 'due'),
    ('OL-W8', 'an unknown item id named Feast at 1p', [{'itemId': 'mi-nope', 'name': 'Feast', 'price': 0.01, 'qty': 1}], None, None, 'unknown'),
    ('OL-W9', "another venue's item id", [{'itemId': 'mi-beta-soup', 'name': 'Feast', 'price': 0.01, 'qty': 1}], None, None, 'unknown'),
    ('OL-W10', 'a declared automatic discount (9499)', feast, None, [{'type': 'auto', 'label': 'x', 'amount_minor': 9499}], 'due'),
    ('OL-W11', "another venue's option (-50)", [line('mi-feast', 95, mods=[{'id': 'opt-beta-free', 'name': 'Free thing', 'price': -50}])], None, None, 'due'),
    ('OL-W12', 'a line discount on the item', [line('mi-feast', 95, discount={'type': 'amount', 'value': 94.99})], None, None, 'due'),
]
for ref, what, items, check, discounts, kind in cases:
    o, e, r = seven(ref, items, check=check, discounts=discounts)
    res = j(o)
    pr = pricing(ref)
    why = (pr.get('due_minor', 0) >= 9440) if kind == 'due' else (pr.get('unknown_lines', 0) >= 1)
    expect(f'SEVEN WAYS {ref}: {what}: NOT paid, "short", ' + ('about 95 due' if kind == 'due' else 'an item not on the menu'),
           res.get('ok') is True and res.get('paid') is False and state(ref) == 'false|short' and why and pr.get('proven_minor') == 1,
           o + e + json.dumps(pr))
o, _, _ = run("select count(*) from public.closed_checks where ref like 'OL-W%'")
expect('none of them wrote a paid check', o == '0', o)
o, _, _ = run("select total from public.order_queue where ref = 'OL-W1'")
expect('staff see what the order is worth (total 94.96, not 0.01)', o.startswith('94.9'), o)
o, _, _ = run("select items->0->>'qty', items->0 ? 'voided', items->0->>'price' from public.order_queue where ref = 'OL-W5'")
expect('the stored line has a whole quantity and the server price', o == '1|f|95.00', o)
o, _, _ = run("select items->0 ? 'voided' from public.order_queue where ref = 'OL-W6'")
expect('the stored line is not voided (the kitchen makes what was counted)', o == 'f', o)
o, _, _ = run("select items->0 ? 'discount' from public.order_queue where ref = 'OL-W12'")
expect('and carries no line discount', o == 'f', o)
o, _, _ = run("select customer->'order_pricing'->>'unknown_lines' from public.order_queue where ref = 'OL-W8'")
expect('an item not on the menu is counted for staff to see', o == '1', o)
tokw, _, _ = run("select token from public.public_order_tokens where ref = 'OL-W1'")
o, e, r = as_('rawanon', f"select public.order_track_row('{L1}', 'OL-W1', '{tokw}')->>'payment_state';")
expect('the customer\'s tracker says the venue is checking the payment (never "short", never pay again)', last(o) == 'checking', o + e)

# ----- THE EIGHTH WAY (fix round 3, 19 Sep): repeat the venue's OWN minus priced option
# until the line prices itself to zero. An option only counts when the item really has it,
# and only as many times as its group allows.
def mods(*specs):
    out = []
    for oid, price, n in specs:
        out += [{'id': oid, 'name': 'x', 'price': price} for _ in range(n)]
    return out

p = proof('pi_neg', 'card', 1, order_ref='OL-NEG')
o, e, r = place('attacker', online('OL-NEG', [line('mi-feast', 95, mods=mods(('opt-noonion', -0.5, 190)))], 0.01),
                {'id': chk('OL-NEG'), 'total': 0.01}, [p])
pr = pricing('OL-NEG')
expect('EIGHTH WAY: the venue own "No onions" (-0.50) sent 190 times on a 95 pound Feast: NOT paid, "short", 95 due',
       j(o).get('paid') is False and state('OL-NEG') == 'false|short' and pr.get('goods_minor') == 9500 and pr.get('due_minor') >= 9440,
       o + e + json.dumps(pr))
o, _, _ = run("select count(*) from public.closed_checks where id = 'chk-OL-NEG-a1b2'")
expect('and no 1p check was written', o == '0', o)
p = proof('pi_neg2', 'card', 1, order_ref='OL-NEG2')
o, e, r = place('attacker', online('OL-NEG2', [line('mi-burger', 20, mods=mods(('opt-noonion', -0.5, 190)))], 0.01),
                {'id': chk('OL-NEG2'), 'total': 0.01}, [p])
expect('the same on a burger, which DOES carry that group: only the one pick the group allows counts (19.50)',
       j(o).get('paid') is False and pricing('OL-NEG2').get('goods_minor') == 1950, o + e + json.dumps(pricing('OL-NEG2')))

# Legitimate options, used the way the storefront sends them, are untouched.
p = proof('pi_free', 'card', 2000, order_ref='OL-FREE')
o, e, r = place('customer', online('OL-FREE', [line('mi-burger', 20, mods=[{'id': 'opt-plain', 'name': 'No sauce', 'price': 0}])], 20),
                {'id': chk('OL-FREE'), 'total': 20}, [p])
expect('NORMAL: a free option (0.00) used once is paid at the item price', j(o).get('paid') is True and pricing('OL-FREE').get('goods_minor') == 2000, o + e)
p = proof('pi_minus', 'card', 1950, order_ref='OL-MINUS')
o, e, r = place('customer', online('OL-MINUS', [line('mi-burger', 20, mods=[{'id': 'opt-noonion', 'name': 'No onions', 'price': -0.5}])], 19.5),
                {'id': chk('OL-MINUS'), 'total': 19.5}, [p])
expect('NORMAL: a minus priced option (-0.50) used once really does take 50p off, and is paid',
       j(o).get('paid') is True and pricing('OL-MINUS').get('goods_minor') == 1950, o + e)
p = proof('pi_three', 'card', 2600, order_ref='OL-THREE')
o, e, r = place('customer', online('OL-THREE', [line('mi-burger', 20, mods=[{'id': 'opt-bacon', 'name': 'Bacon', 'price': 5},
                                                                           {'id': 'opt-cheese', 'name': 'Cheese', 'price': 1.5},
                                                                           {'id': 'opt-noonion', 'name': 'No onions', 'price': -0.5}])], 26),
                {'id': chk('OL-THREE'), 'total': 26}, [p])
expect('NORMAL: three different options, the most the group allows, all count (26.00)',
       j(o).get('paid') is True and pricing('OL-THREE').get('goods_minor') == 2600, o + e)
p = proof('pi_four', 'card', 1, order_ref='OL-FOUR')
o, e, r = place('attacker', online('OL-FOUR', [line('mi-burger', 20, mods=[{'id': 'opt-bacon', 'name': 'Bacon', 'price': 5},
                                                                          {'id': 'opt-cheese', 'name': 'Cheese', 'price': 1.5},
                                                                          {'id': 'opt-plain', 'name': 'No sauce', 'price': 0},
                                                                          {'id': 'opt-noonion', 'name': 'No onions', 'price': -0.5}])], 0.01),
                {'id': chk('OL-FOUR'), 'total': 0.01}, [p])
expect('GROUP MAX: a 4th pick in a group that allows 3 cannot take 50p off (26.50, not 26.00)',
       pricing('OL-FOUR').get('goods_minor') == 2650, o + e + json.dumps(pricing('OL-FOUR')))

# A "pick with qty" group: the SAME option may repeat, up to the group maximum.
p = proof('pi_qty', 'card', 460, order_ref='OL-QTY')
o, e, r = place('customer', online('OL-QTY', [line('mi-coffee', 3, mods=mods(('opt-shot', 0.8, 2)))], 4.6),
                {'id': chk('OL-QTY'), 'total': 4.6}, [p])
expect('NORMAL: a "pick with qty" group counts the same option twice when it allows 2 (4.60)',
       j(o).get('paid') is True and pricing('OL-QTY').get('goods_minor') == 460, o + e)
p = proof('pi_qtyneg', 'card', 250, order_ref='OL-QTYNEG')
o, e, r = place('customer', online('OL-QTYNEG', [line('mi-coffee', 3, mods=mods(('opt-lessice', -0.25, 2)))], 2.5),
                {'id': chk('OL-QTYNEG'), 'total': 2.5}, [p])
expect('NORMAL: two minus priced picks in a "pick with qty" group that allows 2 both count (2.50)',
       j(o).get('paid') is True and pricing('OL-QTYNEG').get('goods_minor') == 250, o + e)
p = proof('pi_qtymax', 'card', 1, order_ref='OL-QTYMAX')
o, e, r = place('attacker', online('OL-QTYMAX', [line('mi-coffee', 3, mods=mods(('opt-lessice', -0.25, 40)))], 0.01),
                {'id': chk('OL-QTYMAX'), 'total': 0.01}, [p])
expect('GROUP MAX: 40 of the same minus priced pick still only counts twice (2.50, never 0)',
       pricing('OL-QTYMAX').get('goods_minor') == 250 and j(o).get('paid') is False, o + e + json.dumps(pricing('OL-QTYMAX')))

# An option of ANOTHER item at the same venue can only add, never take anything off.
p = proof('pi_optother', 'card', 1, order_ref='OL-OTHER')
o, e, r = place('attacker', online('OL-OTHER', [line('mi-feast', 95, mods=[{'id': 'opt-noonion', 'name': 'No onions', 'price': -0.5}])], 0.01),
                {'id': chk('OL-OTHER'), 'total': 0.01}, [p])
expect('an option of another item at the same venue takes nothing off (95.00, not 94.50)',
       pricing('OL-OTHER').get('goods_minor') == 9500, o + e + json.dumps(pricing('OL-OTHER')))
p = proof('pi_othbac', 'card', 10000, order_ref='OL-OTHBAC')
o, e, r = place('customer', online('OL-OTHBAC', [line('mi-feast', 95, mods=[{'id': 'opt-bacon', 'name': 'Bacon', 'price': 5}])], 100),
                {'id': chk('OL-OTHBAC'), 'total': 100}, [p])
expect('and one with a real price still charges it, so an over charge is never a surprise (100.00)',
       j(o).get('paid') is True and pricing('OL-OTHBAC').get('goods_minor') == 10000, o + e)

# A size with no groups of its own uses the main product's, and a sub group pick counts.
p = proof('pi_size', 'card', 252, order_ref='OL-SIZE')
o, e, r = place('customer', online('OL-SIZE', [line('mi-cola-half', 3.02, mods=[{'id': 'opt-noonion', 'name': 'No onions', 'price': -0.5}])], 2.52),
                {'id': chk('OL-SIZE'), 'total': 2.52}, [p])
expect('NORMAL: a size with no groups of its own uses the main product\'s, so its option counts (2.52)',
       j(o).get('paid') is True and pricing('OL-SIZE').get('goods_minor') == 252, o + e + json.dumps(pricing('OL-SIZE')))
p = proof('pi_sub', 'card', 2080, order_ref='OL-SUB')
o, e, r = place('customer', online('OL-SUB', [line('mi-burger', 20, mods=[{'id': 'opt-sauce', 'name': 'Sauce', 'price': 1},
                                                                         {'id': 'opt-side', 'name': 'On the side', 'price': -0.2}])], 20.8),
                {'id': chk('OL-SUB'), 'total': 20.8}, [p])
expect('NORMAL: a nested sub group pick counts too (Sauce +1, On the side -0.20: 20.80)',
       j(o).get('paid') is True and pricing('OL-SUB').get('goods_minor') == 2080, o + e + json.dumps(pricing('OL-SUB')))
o, _, _ = run("select items->0->'mods'->1->>'name', items->0->'mods'->1->>'price' from public.order_queue where ref = 'OL-SUB'")
expect('the option still reaches the kitchen, under the menu\'s own name', o == 'On the side|-0.20', o)
# These 13 orders would otherwise use up the 30 per session the throttle allows, which the
# checks below are not about (the throttle has its own checks).
run("delete from public.fence_attempts where bucket like 'order:uid:%'")

# ----- THE NINTH WAY (fix round 3 review, fixed in round 4): a loyalty reward with no money
# value of its own was worth the DEAREST SINGLE ITEM on the basket, and stacked per redeem
# row. payment-proof writes the marker 1 for exactly the rewards that have no money value
# (free_item, the stamp card default, and discount_percent), so this was one genuine free
# coffee away from a free Feast. A reward is now worth what the SERVER can say it is worth.
def loy_row(check_id, key, stamp=False):
    if stamp:
        run(f"insert into public.stamp_transactions (customer_id, program_id, location_id, stamps, type, idempotency_key) "
            f"values (gen_random_uuid(), gen_random_uuid(), '{L1}', 0, 'redeem', 'stampredeem:{check_id}:{key}')")
        return f'stampredeem:{check_id}:{key}'
    run(f"insert into public.loyalty_transactions (customer_id, company_id, location_id, type, points, balance_after, idempotency_key) "
        f"values (gen_random_uuid(), gen_random_uuid(), '{L1}', 'redeem', -100, 0, 'redeem:{check_id}:{key}')")
    return f'redeem:{check_id}:{key}'

FREE_COFFEE = {'reward': {'type': 'free_item', 'items': [{'id': 'mi-coffee', 'name': 'Coffee'}]}}

# The reviewer's scenario, to the penny: a real free coffee redemption on a 95 pound Feast.
k = loy_row(chk('R4-LOY1'), 'rw-free-coffee')
lp = proof(k, 'loyalty', 1, proc='loyalty')                       # payment-proof's marker: no money value
cp = proof('pi_r4_loy1', 'card', 300, order_ref='R4-LOY1')
o, e, r = place('attacker', online('R4-LOY1', [line('mi-feast', 95), line('mi-coffee', 3)], 3,
                                   discounts=[{'type': 'loyalty', 'label': 'Free coffee', 'amount_minor': 9500}]),
                {'id': chk('R4-LOY1'), 'total': 3}, [lp, cp])
pr = pricing('R4-LOY1')
expect('NINTH WAY: a genuine free coffee redemption declared as 95 pounds off takes off NOTHING: not paid, "short", 95 still due',
       j(o).get('paid') is False and state('R4-LOY1') == 'false|short'
       and pr.get('loyalty_minor') == 0 and pr.get('due_minor', 0) >= 9700, o + e + json.dumps(pr))
o, _, _ = run(f"select count(*) from public.closed_checks where id = '{chk('R4-LOY1')}'")
expect('and no 3 pound check was written for a 98 pound basket', o == '0', o)

# The same reward, valued: its proof now says what it is (payment-proof reads the reward).
k = loy_row(chk('R4-LOY1B'), 'rw-free-coffee')
lp = proof(k, 'loyalty', 1, proc='loyalty', meta=FREE_COFFEE)
cp = proof('pi_r4_loy1b', 'card', 9500, order_ref='R4-LOY1B')
o, e, r = place('customer', online('R4-LOY1B', [line('mi-feast', 95), line('mi-coffee', 3)], 95,
                                   discounts=[{'type': 'loyalty', 'label': 'Free coffee', 'amount_minor': 9500}]),
                {'id': chk('R4-LOY1B'), 'total': 95}, [lp, cp])
expect('NORMAL: the same free coffee is worth the coffee (3), so the Feast is paid at 95',
       j(o).get('paid') is True and pricing('R4-LOY1B').get('loyalty_minor') == 300, o + e + json.dumps(pricing('R4-LOY1B')))

# The reviewer's second scenario: two redemptions, two Feasts, a penny.
c = chk('R4-LOY2')
ids = [proof(loy_row(c, rw), 'loyalty', 1, proc='loyalty') for rw in ('rw-a', 'rw-b')]
cp = proof('pi_r4_loy2', 'card', 1, order_ref='R4-LOY2')
o, e, r = place('attacker', online('R4-LOY2', [line('mi-feast', 95, qty=2)], 0.01,
                                   discounts=[{'type': 'loyalty', 'label': 'Free coffee', 'amount_minor': 19000}]),
                {'id': c, 'total': 0.01}, ids + [cp])
pr = pricing('R4-LOY2')
expect('NINTH WAY: two free item redemptions on two 95 pound Feasts no longer pay for them (190 pounds for 1p)',
       j(o).get('paid') is False and pr.get('loyalty_minor') == 0 and pr.get('due_minor', 0) >= 18900, o + e + json.dumps(pr))

# A percent reward is worth its percent of the server's own goods value, never an item.
k = loy_row(chk('R4-LOYPCT'), 'rw-tenth')
lp = proof(k, 'loyalty', 1, proc='loyalty', meta={'reward': {'type': 'discount_percent', 'percent': 10}})
cp = proof('pi_r4_pct', 'card', 2250, order_ref='R4-LOYPCT')
o, e, r = place('customer', online('R4-LOYPCT', [line('mi-meal', 25)], 22.5,
                                   discounts=[{'type': 'loyalty', 'label': '10% off', 'amount_minor': 2500}]),
                {'id': chk('R4-LOYPCT'), 'total': 22.5}, [lp, cp])
expect('NORMAL: a 10% reward on a 25 pound meal is worth 2.50 (not the meal), and the order is paid at 22.50',
       j(o).get('paid') is True and pricing('R4-LOYPCT').get('loyalty_minor') == 250, o + e + json.dumps(pricing('R4-LOYPCT')))

# A free item reward for something that is not on this order is worth nothing.
k = loy_row(chk('R4-LOYMISS'), 'rw-lobster')
lp = proof(k, 'loyalty', 1, proc='loyalty', meta={'reward': {'type': 'free_item', 'items': [{'name': 'Lobster'}]}})
cp = proof('pi_r4_miss', 'card', 300, order_ref='R4-LOYMISS')
o, e, r = place('attacker', online('R4-LOYMISS', [line('mi-feast', 95), line('mi-coffee', 3)], 3,
                                   discounts=[{'type': 'loyalty', 'label': 'Free lobster', 'amount_minor': 9500}]),
                {'id': chk('R4-LOYMISS'), 'total': 3}, [lp, cp])
expect('a free item reward for something not on the order takes off nothing',
       j(o).get('paid') is False and pricing('R4-LOYMISS').get('loyalty_minor') == 0, o + e)

# Loyalty is per COMPANY and menu ids are per site, so a reward saved at another venue is
# matched by NAME, including the "Parent - Size" label with a dash of any kind.
k = loy_row(chk('R4-LOYNAME'), 'rw-size')
lp = proof(k, 'loyalty', 1, proc='loyalty',
           meta={'reward': {'type': 'free_item', 'items': [{'id': 'mi-other-venue-id', 'name': 'Cola - Half'}]}})
cp = proof('pi_r4_name', 'card', 2500, order_ref='R4-LOYNAME')
o, e, r = place('customer', online('R4-LOYNAME', [line('mi-cola-half', 3.02), line('mi-meal', 25)], 25,
                                   discounts=[{'type': 'loyalty', 'label': 'Free Cola', 'amount_minor': 302}]),
                {'id': chk('R4-LOYNAME'), 'total': 25}, [lp, cp])
expect('NORMAL: a free size saved at another venue matches this venue\'s "Cola - Half" by name and is worth 3.02',
       j(o).get('paid') is True and pricing('R4-LOYNAME').get('loyalty_minor') == 302, o + e + json.dumps(pricing('R4-LOYNAME')))

# The cheapest matching line, never the dearest.
k = loy_row(chk('R4-LOYCHEAP'), 'rw-drink')
lp = proof(k, 'loyalty', 1, proc='loyalty',
           meta={'reward': {'type': 'free_item', 'items': [{'name': 'Coffee'}, {'name': 'Wine'}]}})
cp = proof('pi_r4_cheap', 'card', 300, order_ref='R4-LOYCHEAP')
o, e, r = place('attacker', online('R4-LOYCHEAP', [line('mi-coffee', 3), line('mi-wine', 30)], 3,
                                   discounts=[{'type': 'loyalty', 'label': 'Free drink', 'amount_minor': 3000}]),
                {'id': chk('R4-LOYCHEAP'), 'total': 3}, [lp, cp])
pr = pricing('R4-LOYCHEAP')
expect('a free drink claimed as the 30 pound wine is worth the COFFEE (3), the cheapest it matches: 30 still due',
       j(o).get('paid') is False and pr.get('loyalty_minor') == 300 and pr.get('due_minor', 0) >= 2900, o + e + json.dumps(pr))

# The same rule on the QR path (a QR order that pays now is valued the same way; a round of
# an open tab never takes a loyalty discount at all, it is held under its card hold).
k = loy_row(chk('R4-QRLOY'), 'rw-free-coffee')
lp = proof(k, 'loyalty', 1, proc='loyalty')
cp = proof('pi_r4_qr', 'card', 300, order_ref='R4-QRLOY')
o, e, r = place('attacker', {'ref': 'R4-QRLOY', 'source': 'qr', 'type': 'dine-in', 'total': 3,
                             'items': [line('mi-feast', 95), line('mi-coffee', 3)],
                             'customer': {'tableId': 'T7', 'tableLabel': '7'},
                             'discounts': [{'type': 'loyalty', 'label': 'Free coffee', 'amount_minor': 9500}]},
                {'id': chk('R4-QRLOY'), 'total': 3}, [lp, cp])
expect('a QR order pays by the same rule: a reward the server cannot value takes off nothing',
       j(o).get('paid') is False and pricing('R4-QRLOY').get('loyalty_minor') == 0, o + e)

# A reward can never be made free against a line the server could not price.
k = loy_row(chk('R4-LOYUNK'), 'rw-water')
lp = proof(k, 'loyalty', 1, proc='loyalty', meta={'reward': {'type': 'free_item', 'items': [{'name': 'Water'}]}})
cp = proof('pi_r4_unk', 'card', 1, order_ref='R4-LOYUNK')
o, e, r = place('attacker', online('R4-LOYUNK', [line('mi-water', 95, name='Water')], 0.01,
                                   discounts=[{'type': 'loyalty', 'label': 'Free water', 'amount_minor': 9500}]),
                {'id': chk('R4-LOYUNK'), 'total': 0.01}, [lp, cp])
expect('a free item reward cannot be worth a line the server could not price (95 pound "Water")',
       j(o).get('paid') is False and pricing('R4-LOYUNK').get('loyalty_minor') == 0, o + e)
run("delete from public.fence_attempts where bucket like 'order:uid:%'")

# ----- THE TENTH WAY (fix round 3 review, fixed in round 4): a menu_items row of the venue
# that the storefront never sells (a variants parent, an option only sub item, an archived or
# hidden row, an 86'd row) priced at a floor of 0, so any number of them rode along free on a
# legitimately paid ticket. Only what the storefront really sells counts; anything else is
# UNKNOWN, so the order can never pay for itself and staff confirm it.
cp = proof('pi_r4_val1', 'card', 2000, order_ref='R4-VAL1')
o, e, r = place('attacker', online('R4-VAL1', [line('mi-burger', 20), line('mi-cola', 0, qty=10, name='Cola')], 20),
                {'id': chk('R4-VAL1'), 'total': 20}, [cp])
pr = pricing('R4-VAL1')
expect('TENTH WAY: ten free Colas (the variants parent, base 0) on a paid 20 pound ticket: NOT paid, "short", flagged',
       j(o).get('paid') is False and state('R4-VAL1') == 'false|short' and pr.get('unknown_lines') == 1, o + e + json.dumps(pr))
o, _, _ = run("select items->1->>'name' || ' x' || (items->1->>'qty') from public.order_queue where ref = 'R4-VAL1'")
expect('and the line still reaches the kitchen, under the menu\'s own name', o == 'Cola x10', o)
o, _, _ = run(f"select count(*) from public.closed_checks where id = '{chk('R4-VAL1')}'")
expect('and no check was written', o == '0', o)

def unsellable(ref, item, price, declared, expect_goods):
    cp = proof('pi_' + ref.lower(), 'card', int(round(declared * 100)), order_ref=ref)
    o, e, r = place('attacker', online(ref, [line('mi-burger', 20), line(item, price, name=item)], declared),
                    {'id': chk(ref), 'total': declared}, [cp])
    pr = pricing(ref)
    return (j(o).get('paid') is False and pr.get('unknown_lines') == 1
            and pr.get('goods_minor') == expect_goods), o + e + json.dumps(pr)

ok, d = unsellable('R4-OLD', 'mi-old', 0, 20, 3200)
expect('an archived item is not sellable, and still counts at its 12 pound menu price', ok, d)
ok, d = unsellable('R4-NOICE', 'mi-noice', 0, 20, 2000)
expect('an option only sub item (type subitem, not sold alone) is not sellable', ok, d)
ok, d = unsellable('R4-SECRET', 'mi-secret', 0, 20, 2900)
expect('an item hidden from online (visibility.online false) is not sellable, and counts at 9 pounds', ok, d)
ok, d = unsellable('R4-86', 'mi-soup', 0, 20, 2700)
expect('an 86\'d item is not sellable for value, and counts at its 7 pound menu price', ok, d)
ok, d = unsellable('R4-WATER', 'mi-water', 0, 20, 2000)
expect('an item with no pricing at all is UNKNOWN, never free', ok, d)
ok, d = unsellable('R4-BREAD', 'mi-bread', 0, 20, 2000)
expect('an item priced {"base": 0} is UNKNOWN too (a zero is not a price)', ok, d)
o, _, _ = run("select coalesce((customer->'order_pricing'->>'goods_minor')::int, -1) from public.order_queue where ref = 'R4-WATER'")
o2, _, _ = run("select items->1->>'price' from public.order_queue where ref = 'R4-WATER'")
expect('an unknown line is never worth zero: what the page said still counts', o == '2000' and o2 == '0.00', o + '|' + o2)
run("delete from public.fence_attempts where bucket like 'order:uid:%'")

# What the storefront DOES sell is untouched.
p = proof('pi_r4_salad', 'card', 2250, order_ref='R4-SALAD')
o, e, r = place('customer', online('R4-SALAD', [line('mi-burger', 20), line('mi-salad', 2.5, name='Side Salad')], 22.5),
                {'id': chk('R4-SALAD'), 'total': 22.5}, [p])
expect('NORMAL: a sub item the venue DOES sell on its own is priced and paid as usual',
       j(o).get('paid') is True and pricing('R4-SALAD').get('unknown_lines') == 0, o + e)
p = proof('pi_r4_size', 'card', 302, order_ref='R4-SIZE')
o, e, r = place('customer', online('R4-SIZE', [line('mi-cola-half', 3.02)], 3.02), {'id': chk('R4-SIZE'), 'total': 3.02}, [p])
expect('NORMAL: a SIZE of a variants parent is still sold (only the parent row is not)', j(o).get('paid') is True, o + e)

# A row the storefront never sells takes no part in the venue's automatic discounts either.
p = proof('pi_r4_deal', 'card', 600, order_ref='R4-DEAL')
o, e, r = place('attacker', online('R4-DEAL', [line('mi-donut', 2, qty=2), line('mi-donut-old', 2, name='Old Donut')], 6,
                                   discounts=[{'type': 'auto', 'label': 'Third half price', 'amount_minor': 100}]),
                {'id': chk('R4-DEAL'), 'total': 6}, [p])
expect('an archived donut cannot be the third donut that fires "buy two get the third half price"',
       pricing('R4-DEAL').get('auto_minor') == 0, o + e + json.dumps(pricing('R4-DEAL')))

# A QR tab round must be entirely on the menu (it is settled from its value later).
o, e, r = run(f"insert into public.payment_proofs (processor, payment_ref, kind, location_id, amount_minor, verified_by) "
              f"values ('stripe', 'pi_r4_tab', 'preauth', '{L1}', 5000, 'test')")
o, e, r = place('customer', {'ref': 'R4-TAB', 'source': 'qr', 'type': 'dineIn', 'total': 20,
                             'items': [line('mi-burger', 20), line('mi-cola', 0, qty=5, name='Cola')],
                             'customer': {'tab_open': True, 'payment_intent_id': 'pi_r4_tab', 'tableLabel': '9'}})
expect('a QR tab round with a row the storefront does not sell is refused, not carried on the tab',
       j(o).get('ok') is False and j(o).get('reason') == 'items', o + e)
run("delete from public.fence_attempts where bucket like 'order:uid:%'")

# A cheap item's id sent under a dear item's name goes to the kitchen under its own name.
p = proof('pi_swap', 'card', 1000, order_ref='OL-SWAP')
o, e, r = place('attacker', online('OL-SWAP', [line('mi-tea', 10, name='Feast', kitchenName='FEAST', receiptName='Feast')], 10), {'id': chk('OL-SWAP'), 'total': 10}, [p])
o2, _, _ = run("select items->0->>'name', coalesce(items->0->>'kitchenName', '-'), coalesce(items->0->>'receiptName', '-') from public.order_queue where ref = 'OL-SWAP'")
expect('EXPLOIT: a tea sent as "Feast" is paid as tea and reaches the kitchen as Tea', j(o).get('paid') is True and o2 == 'Tea|-|-', o + o2)
p = proof('pi_pz', 'card', 1200, order_ref='OL-PZ')
o, e, r = place('customer', online('OL-PZ', [line('mi-pizza', 12, kitchenName='PIZZA')], 12), {'id': chk('OL-PZ'), 'total': 12}, [p])
o2, _, _ = run("select items->0->>'name', items->0->>'kitchenName' from public.order_queue where ref = 'OL-PZ'")
expect('a real kitchen name is kept', o2 == 'Pizza|PIZZA', o2)

# ----- the 18 Sep exploit cases, the gift card, and the rest of the rules
p_small = proof('pi_1p', 'card', 1)
o, e, r = place('attacker', online('OL-X95', feast, 95), {'id': 'chk-x95', 'total': 0.01}, [p_small])
res = j(o)
expect('EXPLOIT: a 95 pound order with a 1p check total and a 1p proof is NOT paid', res.get('ok') and res.get('paid') is False and res.get('payment_unverified') is True, o + e)
o, _, _ = run("select count(*) from public.closed_checks where id like 'chk-x95%'")
expect('and no paid check was written', o == '0', o)
o, _, _ = run("select paid, customer->>'payment_state', status from public.order_queue where ref = 'OL-X95'")
expect('the order reaches the venue marked short (1p of 95 proven), not paid', o == 'f|short|received', o)
p_loy = proof('redeem:chk-x0:rw1', 'loyalty', 1, proc='loyalty')
o, e, r = place('attacker', online('OL-X0', feast, 95), {'id': 'chk-x0', 'total': 0}, [p_loy])
expect('EXPLOIT: a zero check total with a loyalty marker proof is NOT paid', j(o).get('paid') is False, o + e)
o, _, _ = run("select customer->>'payment_state' from public.order_queue where ref = 'OL-X0'")
expect('with no money proven it is "checking"', o == 'checking', o)
p_other = proof('pi_other', 'card', 2500, order_ref='OL-SOMEONE-ELSE')
o, e, r = place('attacker', online('OL-STEAL', [line('mi-meal', 25)], 25), {'id': chk('OL-STEAL'), 'total': 25}, [p_other])
expect('a card payment the processor says is for another order never pays this one', j(o).get('paid') is False, o + e)
p_c15 = proof('pi_c15', 'card', 1500, order_ref='OL-GIFT')
p_g10 = proof(f"giftcommit:{chk('OL-GIFT')}:card1", 'gift', 1000, proc='gift')
o, e, r = place('customer', online('OL-GIFT', [line('mi-meal', 25)], 25),
                {'id': chk('OL-GIFT'), 'total': 15, 'gift_card': {'idempotency_key': f"giftcommit:{chk('OL-GIFT')}:card1", 'applied': 1000}}, [p_c15, p_g10])
res = j(o)
expect('NORMAL: gift card plus card covering the order is paid', res.get('paid') is True, o + e)
o, _, _ = run(f"select total from public.closed_checks where id = '{res.get('check_id')}'")
expect('the check books the verified card part (15.00), net of the gift card', o.startswith('15'), o)
p_gv = proof(f"giftcommit:{chk('OL-GV')}:cardV", 'gift', 2500, proc='gift')
p_c1 = proof('pi_gx', 'card', 1, order_ref='OL-GX')
o, e, r = place('attacker', online('OL-GX', [line('mi-meal', 25)], 25),
                {'id': chk('OL-GX'), 'total': 0, 'gift_card': {'idempotency_key': f"giftcommit:{chk('OL-GV')}:cardV"}}, [p_c1, p_gv])
expect('EXPLOIT: a gift card debit made for another order never pays this one', j(o).get('paid') is False, o + e)
o, _, _ = run(f"select used_by_ref is null from public.payment_proofs where id = '{p_gv}'")
expect('and stays unused for its own order', o == 't', o)
p_c25 = proof('pi_c25', 'card', 2500, order_ref='OL-LIE')
o, e, r = place('customer', online('OL-LIE', [line('mi-meal', 25)], 25), {'id': chk('OL-LIE'), 'total': 0.01}, [p_c25])
res = j(o)
o2, _, _ = run(f"select total from public.closed_checks where id = '{res.get('check_id')}'")
expect('a check total the phone lowers is booked at the verified card amount', res.get('paid') is True and o2.startswith('25'), o + o2)
o, e, r = place('customer', online('OL-OK1', burger, 25), {'id': 'chk-ok-1', 'total': 25}, [p1], commit=False)
expect('retry by the same session returns the first answer', j(o).get('idempotent') is True and j(o).get('paid') is True, o + e)
o, e, r = place('attacker', online('OL-OK1', burger, 25), {'id': 'chk-ok-1', 'total': 25}, [p1], commit=False)
expect('another session cannot reuse the ref', j(o).get('reason') == 'ref_taken', o + e)
o, e, r = place('attacker', online('OL-REUSE', [line('mi-burger', 25)], 25), {'id': chk('OL-REUSE'), 'total': 25}, [p1])
expect('a used card proof cannot pay a second order', j(o).get('paid') is False, o + e)
o, e, r = place('customer', {'ref': 'QR-LATER', 'source': 'qr', 'items': burger, 'total': 20, 'customer': {'tableId': 'T5'}}, commit=False)
expect('QR has no pay later: an order with no payment is refused', j(o).get('reason') == 'payment', o + e)
p_nochk = proof('pi_nochk', 'card', 2000, order_ref='OL-NOCHK')
o, e, r = place('customer', online('OL-NOCHK', burger, 20), None, [p_nochk])
expect('an online order that arrives without its check is still proven and paid', j(o).get('paid') is True and j(o).get('check_id'), o + e)
cat = {'ref': 'CT-1', 'source': 'catering', 'type': 'delivery', 'event_date': '2099-01-01',
       'items': [line('mi-tray', 50)], 'total': 50, 'customer': {'name': 'C'}}
o, e, r = place('customer', cat)
expect('catering pay later is placed unpaid (received)', j(o).get('ok') and j(o).get('paid') is False and j(o).get('status') == 'received', o + e)
o, _, _ = run("select event_date is null, total from public.order_queue where ref = 'CT-1'")
expect('a far future event date is dropped; catering prices from base (50, not the delivery 60)', o == 't|50.00', o)
o, e, r = place('customer', {'ref': 'CT-PL', 'source': 'catering', 'type': 'collection', 'items': [line('mi-tray', 50)], 'total': 40,
                             'customer': {'name': 'C', 'promo_code': 'LATER10', 'promo_discount': 10}})
o2, _, _ = run("select total, (select uses_count from public.promo_codes where code = 'LATER10') from public.order_queue where ref = 'CT-PL'")
expect('NORMAL: catering pay later with a real code keeps its total (40); the page records the use', j(o).get('ok') and o2 == '40.00|0', o + o2)
o, e, r = place('attacker', {'ref': 'CT-PLX', 'source': 'catering', 'type': 'collection', 'items': [line('mi-tray', 50)], 'total': 1,
                             'customer': {'name': 'C', 'promo_code': 'NOPE', 'promo_discount': 49}})
o2, _, _ = run("select total from public.order_queue where ref = 'CT-PLX'")
expect('catering pay later with a made up code: the venue collects the menu price', j(o).get('ok') and o2.startswith('49.9'), o + o2)
p_cat = proof('pi_cat', 'card', 5000, order_ref='CT-2')
o, e, r = place('customer', {'ref': 'CT-2', 'source': 'catering', 'type': 'delivery', 'event_date': '2026-12-01',
                             'items': [line('mi-tray', 50)], 'total': 50, 'customer': {'payment_intent_id': 'pi_cat'}},
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
tok95, _, _ = run("select token from public.public_order_tokens where ref = 'OL-X0'")
o, e, r = as_('rawanon', f"select public.order_track_row('{L1}', 'OL-X0', '{tok95}')->>'payment_state';")
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
tokd, _, _ = run("select token from public.public_order_tokens where ref = 'OL-DEAL'")
o, e, r = as_('rawanon', f"select public.order_track_check('{L1}', 'OL-DEAL', '{tokd}');")
expect('the platform last 4 breaker never blocks a token', last(o) == 't', o + e)
run("delete from public.fence_attempts")

# ---------- QR tabs: only the tab's own people add rounds (HIGH, 18 Sep)
hold = proof('pi_tab_000000001', 'preauth', 5000)
tab = {'ref': 'QR-T1', 'source': 'qr', 'type': 'dine-in', 'items': [line('mi-beer', 6)], 'total': 6,
       'customer': {'name': 'Bob', 'tableId': 'T5', 'tableLabel': '5', 'tab_open': True, 'payment_intent_id': 'pi_tab_000000001',
                    'stripe_account': 'acct_1', 'payment_method_id': 'pm_1', 'tab_join_code': '1234', 'pre_auth_amount': 9999}}
o, e, r = place('customer', tab)
rt = j(o)
join = rt.get('tab_join_code') or ''
expect('QR tab opened with a server table code (the phone code is ignored)', rt.get('ok') and len(join) == 6 and join != '1234', o + e)
o, _, _ = run("select customer->>'pre_auth_amount', customer->>'tab_ref', customer->'order_pricing'->>'value_minor' from public.order_queue where ref = 'QR-T1'")
expect('the hold amount comes from the proof, not the phone; the round is valued by the server', o == '50.00|QR-T1|600', o)
tab2 = dict(tab, ref='QR-T2')
o, e, r = place('customer', tab2)
expect('the opener adds a round (no code needed)', j(o).get('ok') and j(o).get('tab_join_code') == join, o + e)
evil = dict(tab, ref='QR-EVIL1', customer=dict(tab['customer'], name='Eve', tab_join_code=None))
o, e, r = place('attacker', evil, commit=False)
expect('EXPLOIT: a stranger with only the tab payment id cannot add a round', j(o).get('reason') == 'tab_not_yours', o + e)
evil_code = dict(evil, ref='QR-EVIL2', tab_join_code='000000')
o, e, r = place('attacker', evil_code)
expect('a wrong table code is refused', j(o).get('reason') == 'tab_not_yours', o + e)
nontab = {'ref': 'QR-EVIL3', 'source': 'qr', 'type': 'dine-in', 'items': [line('mi-wine', 30)], 'total': 30,
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
o, e, r = place('customer', dict(tab, ref='QR-BIG', items=[line('mi-beer', 6, qty=5)], total=30), commit=False)
expect('LOW: a round that takes the tab past its 50 hold (24 on it, 30 more) is refused', j(o).get('reason') == 'over_hold'
       and j(o).get('hold_minor') == 5000 and j(o).get('running_minor') == 2400, o + e)
o, e, r = place('customer', dict(tab, ref='QR-UNK', items=[{'itemId': 'mi-nope', 'name': 'Beer', 'price': 0.01, 'qty': 1}], total=0.01), commit=False)
expect('a round with an item that is not on the menu is refused (nothing was charged yet)', j(o).get('reason') == 'items', o + e)
o, e, r = as_('customer', f"select public.place_public_order('{L1}', '{q(dict(tab, ref='QR-CHEAP', items=[line('mi-beer', 0.01, qty=4)], total=0.04))}'::jsonb)->>'ok'; select (customer->'order_pricing'->>'value_minor') || '|' || total from public.order_queue where ref = 'QR-CHEAP';")
expect('a round priced below the menu is recorded at the menu price (4 beers: 23.96 with rounding slack, never 0.04)', last(o) == '2396|23.96', o + e)
wrong = ''.join(f"select public.place_public_order('{L1}', '{q(dict(tab, ref='QR-W%d' % i, tab_join_code='11111%d' % i))}'::jsonb);" for i in range(8))
as_commit('dev2', wrong)
o, e, r = place('dup', dict(tab, ref='QR-W9', tab_join_code=join), commit=False)
expect('8 wrong codes lock the tab for codes (even the right one) for an hour', j(o).get('reason') == 'locked', o + e)
o, e, r = place('customer', dict(tab, ref='QR-T5'), commit=False)
expect('the opener is never locked out of their own tab', j(o).get('ok') is True, o + e)
o, e, r = as_('customer', f"select public.qr_table_tab_count('{L1}', 'T5');")
expect('tab count', r == 0, o + e)
# closing the tab (MEDIUM, 18 Sep: any 1p card proof closed any tab, whoever asked)
o, e, r = as_('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_000000001', '{{}}'::jsonb, '{{}}'::uuid[])->>'reason';")
expect('settle refused before the server saw a capture', last(o) == 'not_captured', o + e)
p_1p = proof('pi_1p_other', 'card', 1, order_ref='OL-ELSEWHERE')
o, e, r = as_('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_000000001', '{{}}'::jsonb, array['{p_1p}']::uuid[])->>'reason';")
expect('MEDIUM: a card payment made for another order never closes the tab', last(o) == 'not_captured', o + e)
p_1p_tab = proof('pi_1p_tab', 'card', 1, order_ref='QR-T1')
o, e, r = as_('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_000000001', '{{}}'::jsonb, array['{p_1p_tab}']::uuid[]);")
expect('MEDIUM: 1p that belongs to the tab does not cover its 24 balance: nothing closes', j(o).get('reason') == 'short' and j(o).get('due_minor') == 2400, o + e)
proof('pi_tab_000000001', 'capture', 1000)
o, e, r = as_('attacker', f"select public.settle_qr_tab('{L1}', 'pi_tab_000000001', '{{}}'::jsonb, '{{}}'::uuid[])->>'reason';")
expect('MEDIUM: a stranger who knows the payment id cannot close the tab', last(o) == 'not_yours', o + e)
o, e, r = as_commit('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_000000001', '{{}}'::jsonb, '{{}}'::uuid[]);")
expect('MEDIUM: a capture short of the tab balance (10 of 24) closes nothing', j(o).get('reason') == 'short' and j(o).get('paid_minor') == 1000, o + e)
o, _, _ = run("select count(*) filter (where status <> 'collected'), count(*) filter (where customer->>'payment_state' = 'short') from public.order_queue where customer->>'payment_intent_id' = 'pi_tab_000000001' and customer->>'tab_open' = 'true'")
expect('the rounds stay open and are marked short for staff', o == '4|4', o)
o, _, _ = run("select count(*) from public.payment_proofs where payment_ref = 'pi_tab_000000001' and kind = 'capture' and used_by_ref is null")
expect('and the capture is not used up', o == '1', o)
run("update public.payment_proofs set amount_minor = 2400 where payment_ref = 'pi_tab_000000001' and kind = 'capture'")
o, e, r = as_commit('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_000000001', '{{}}'::jsonb, '{{}}'::uuid[]);")
st = j(o)
expect('the opener closes the tab once the capture covers it: only the tab rounds (4), not the pay now order', st.get('closed') == 4 and st.get('ok') is True, o + e)
o, _, _ = run("select status from public.order_queue where ref = 'QR-EVIL3'")
expect('the pay now order is untouched', o != 'collected', o)
o, _, _ = run("select total from public.closed_checks where ref = 'QR-T1' and source = 'qr'")
expect('one check books what was taken (24.00)', o.startswith('24'), o)
o, _, _ = run("select count(*) from public.order_queue where customer->>'payment_intent_id' = 'pi_tab_000000001' and (customer ? 'payment_state' or customer ? 'payment_unverified')")
o2, _, _ = run("select customer ? 'payment_state' from public.closed_checks where ref = 'QR-T1' and source = 'qr'")
expect('the closed rounds and their check no longer say short', o == '0' and o2 == 'f', o + ' ' + o2)
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
proof('pi_tab_small', 'preauth', 500)
o, e, r = place('customer', dict(tab, ref='QR-SMALL', customer=dict(tab['customer'], payment_intent_id='pi_tab_small')), commit=False)
expect('LOW: a first round bigger than its hold (6 on a 5 hold) is refused', j(o).get('reason') == 'over_hold', o + e)
# a member and staff may close; an overage payment tied to the tab counts
proof('pi_tab_m', 'preauth', 5000)
place('customer', dict(tab, ref='QR-M1', customer=dict(tab['customer'], payment_intent_id='pi_tab_m', tableId='T6')))
jm, _, _ = run("select customer->>'tab_join_code' from public.order_queue where ref = 'QR-M1'")
place('stranger', dict(tab, ref='QR-M2', tab_join_code=jm, customer=dict(tab['customer'], payment_intent_id='pi_tab_m', tableId='T6')))
proof('pi_tab_m', 'capture', 600)
p_ov = proof('pi_overage_m', 'card', 600, meta={'parent_ref': 'pi_tab_m'})
o, e, r = as_commit('stranger', f"select public.settle_qr_tab('{L1}', 'pi_tab_m', '{{}}'::jsonb, array['{p_ov}']::uuid[]);")
expect('a phone that joined may close the tab; an overage charge tied to its hold counts (6 + 6 = 12)', j(o).get('closed') == 2, o + e)
proof('pi_tab_s', 'preauth', 5000)
place('customer', dict(tab, ref='QR-S1', customer=dict(tab['customer'], payment_intent_id='pi_tab_s', tableId='T7')))
proof('pi_tab_s', 'capture', 600)
o, e, r = as_commit('dev1b', f"select public.settle_qr_tab('{L1}', 'pi_tab_s', '{{}}'::jsonb, '{{}}'::uuid[]);")
expect('staff of the venue (a linked till) may close a tab', j(o).get('closed') == 1, o + e)

# THE EIGHTH WAY ON A TAB (fix round 3): a round whose minus priced option is repeated used to
# value itself at a penny, which walked straight past the card hold and let the whole tab close
# for pennies. The round is now valued at what it is really worth.
proof('pi_tab_neg', 'preauth', 5000)
negtab = dict(tab, ref='QR-NEG1', items=[line('mi-feast', 95, mods=mods(('opt-noonion', -0.5, 190)))], total=0.01,
              customer=dict(tab['customer'], payment_intent_id='pi_tab_neg', tableId='T8'))
o, e, r = place('customer', negtab, commit=False)
expect('EIGHTH WAY on a tab: a 95 pound round with 190 minus priced options is refused, it is past the 50 hold',
       j(o).get('reason') == 'over_hold' and j(o).get('round_minor') >= 9440, o + e)
negtab2 = dict(negtab, ref='QR-NEG2', items=[line('mi-burger', 20, mods=mods(('opt-noonion', -0.5, 50)))])
o, e, r = place('customer', negtab2)
o2, _, _ = run("select customer->'order_pricing'->>'value_minor' || '|' || total from public.order_queue where ref = 'QR-NEG2'")
expect('a round the hold does cover is recorded at the menu price (19.46, the menu price less the rounding slack), not the penny the phone declared',
       j(o).get('ok') is True and o2 == '1946|19.46', o + e + o2)
proof('pi_tab_neg', 'capture', 1)
o, e, r = as_commit('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_neg', '{{}}'::jsonb, '{{}}'::uuid[]);")
expect('and a 1p capture no longer closes that tab: it is 19.46 short', j(o).get('reason') == 'short' and j(o).get('due_minor') == 1946, o + e)
o, _, _ = run("select count(*) from public.closed_checks where ref = 'QR-NEG2'")
expect('no penny check was booked for the tab', o == '0', o)
run("update public.payment_proofs set amount_minor = 1946 where payment_ref = 'pi_tab_neg' and kind = 'capture'")
o, e, r = as_commit('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_neg', '{{}}'::jsonb, '{{}}'::uuid[]);")
expect('once the capture covers the real value the tab closes normally', j(o).get('ok') is True and j(o).get('closed') == 1, o + e)
o, _, _ = run("select total from public.closed_checks where ref = 'QR-NEG2' and source = 'qr'")
expect('and the check books 19.46', o.startswith('19.4'), o)

# ---------- closed_checks.tenders (v5.9.11, after the rebase onto main): what paid the check.
# The accounting layer posts card, cash, gift card and credits from it, so a check the SERVER
# writes must carry it or an online, QR or catering sale lands in Unallocated. The live column
# is added by 20260919n (Peter runs it by hand), so the baseline here does not have it: a check
# written without the column must still be written, and with it the tenders must land.
o, _, _ = run("select count(*) from information_schema.columns where table_name = 'closed_checks' and column_name = 'tenders'")
expect('the baseline has no tenders column yet, and every check above was still written', o == '0',
       o + '|' + run("select count(*) from public.closed_checks")[0])
run("alter table public.closed_checks add column if not exists tenders jsonb")
p = proof('pi_tend', 'card', 2500, order_ref='OL-TEND')
o, e, r = place('customer', online('OL-TEND', [line('mi-meal', 25)], 25),
                {'id': chk('OL-TEND'), 'total': 25, 'tip': 0, 'stripe_payment_intent_id': 'pi_tend', 'processor': 'stripe',
                 'tenders': [{'method': 'card', 'amount': 25, 'tip': 0, 'psp_ref': 'pi_tend', 'processor': 'stripe'}]}, [p])
o2, _, _ = run("select tenders from public.closed_checks where id = 'chk-OL-TEND-a1b2'")
expect('the tenders the page built are kept on the check the server writes',
       j(o).get('paid') is True and json.loads(o2 or 'null') == [{'method': 'card', 'amount': 25, 'tip': 0, 'psp_ref': 'pi_tend', 'processor': 'stripe'}],
       o + e + o2)
p = proof('pi_tend2', 'card', 2500, order_ref='OL-TEND2')
o, e, r = place('customer', online('OL-TEND2', [line('mi-meal', 25)], 25),
                {'id': chk('OL-TEND2'), 'total': 25, 'tip': 2, 'stripe_payment_intent_id': 'pi_tend2', 'processor': 'stripe'}, [p])
o2, _, _ = run("select tenders from public.closed_checks where id = 'chk-OL-TEND2-a1b2'")
expect('a check written with no tenders (an older page) still gets one card tender, its tip on it',
       j(o).get('paid') is True and json.loads(o2 or 'null') == [{'tip': 2.0, 'amount': 23.0, 'method': 'card', 'psp_ref': 'pi_tend2', 'processor': 'stripe'}],
       o + e + o2)
run("alter table public.closed_checks drop column if exists tenders")

# ---------- an unproven pay now order: checked, never looks unpaid, and gets its check once proven
qrpay = {'ref': 'QR-PAY1', 'source': 'qr', 'type': 'dine-in', 'items': [line('mi-pizza', 12)], 'total': 12,
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
proof('pi_qrpay_0001', 'card', 1200, order_ref='QR-PAY1')
o, e, r = as_commit('dev1b', f"select public.verify_public_order_payment('{L1}', 'QR-PAY1');")
expect('a till of the venue verifies once the proof arrived', j(o).get('paid') is True, o + e)
o, _, _ = run("select paid, customer->>'payment_state', customer->>'payment_intent_id' from public.order_queue where ref = 'QR-PAY1'")
expect('the order is paid, verified, and gets its own payment id back', o == 't|verified|pi_qrpay_0001', o)
o, _, _ = run("select total, status, source from public.closed_checks where id = 'chk-qrpay1'")
expect('the kept check is written with the verified amount', o.startswith('12') and o.endswith('|paid|qr'), o)
o, _, _ = run("select count(*) from public.public_order_pending_checks where ref = 'QR-PAY1'")
expect('the kept check is gone', o == '0', o)
# LOW: verify never uses a proof with no processor order reference just because the caller's check names it
o, e, r = place('customer', online('OL-VICT', [line('mi-meal', 25)], 25),
                {'id': chk('OL-VICT'), 'total': 0, 'gift_card': {'idempotency_key': f"giftcommit:{chk('OL-VICT')}:cardV"}})
p_vict = proof(f"giftcommit:{chk('OL-VICT')}:cardV", 'gift', 2500, proc='gift')
o, e, r = place('attacker', online('OL-G1', [line('mi-meal', 25)], 25),
                {'id': chk('OL-G1'), 'total': 0, 'gift_card': {'idempotency_key': f"giftcommit:{chk('OL-VICT')}:cardV"}})
o, e, r = as_commit('attacker', f"select public.verify_public_order_payment('{L1}', 'OL-G1', array['{p_vict}']::uuid[]);")
expect('LOW: another order\'s gift card debit, named by the attacker\'s check, does not verify it', j(o).get('paid') is False, o + e)
o, _, _ = run(f"select used_by_ref is null from public.payment_proofs where id = '{p_vict}'")
expect('and is not used up', o == 't', o)
o, e, r = as_commit('customer', f"select public.verify_public_order_payment('{L1}', 'OL-VICT');")
expect('its own order verifies with it', j(o).get('paid') is True, o + e)
# a card payment the processor tied to no order belongs to the first order that named it
o, e, r = place('customer', {'ref': 'QR-RY1', 'source': 'qr', 'type': 'dine-in', 'items': [line('mi-pizza', 12)], 'total': 12,
                             'customer': {'tableId': 'T9', 'payment_intent_id': 'ses_victim_01', 'processor': 'ryft'}},
                {'id': 'chk-ry1', 'total': 12, 'payment_intents': [{'id': 'ses_victim_01'}], 'processor': 'ryft'})
p_ry = proof('ses_victim_01', 'card', 1200, proc='ryft')
o, e, r = place('attacker', {'ref': 'QR-RY2', 'source': 'qr', 'type': 'dine-in', 'items': [line('mi-pizza', 12)], 'total': 12,
                             'customer': {'tableId': 'T8', 'payment_intent_id': 'ses_victim_01', 'processor': 'ryft'}},
                {'id': 'chk-ry2', 'total': 12, 'payment_intents': [{'id': 'ses_victim_01'}], 'processor': 'ryft'}, [p_ry])
expect('LOW: a card payment with no order reference another order named first never pays a copycat', j(o).get('paid') is False, o + e)
o, e, r = as_commit('attacker', f"select public.verify_public_order_payment('{L1}', 'QR-RY2', array['{p_ry}']::uuid[]);")
expect('not even through Check payment', j(o).get('paid') is False, o + e)
o, e, r = as_commit('customer', f"select public.verify_public_order_payment('{L1}', 'QR-RY1', array['{p_ry}']::uuid[]);")
expect('the order that named it first verifies with it', j(o).get('paid') is True, o + e)
o, e, r = as_('customer', f"select public.confirm_public_order_payment('{L1}', 'OL-X95', 'I paid');")
expect('a customer can never confirm a payment by hand', r != 0 and 'staff' in e, e)
o, e, r = as_commit('owner1', f"select public.confirm_public_order_payment('{L1}', 'OL-X95', 'took the rest on the till');")
expect('staff confirm a short order after taking the rest', j(o).get('paid') is True, o + e)
o, _, _ = run("select paid, customer->>'payment_state', customer->>'payment_confirmed_by' from public.order_queue where ref = 'OL-X95'")
expect('who confirmed it is on the order', o == f"t|confirmed_by_staff|{UID['owner1']}", o)
o, e, r = as_commit('owner1', f"select public.confirm_public_order_payment('{L1}', 'OL-W8', 'checked the order by hand');")
expect('an order with an item not on the menu is settled only by staff', j(o).get('paid') is True, o + e)
o, e, r = as_commit('owner1', f"select public.confirm_public_order_payment('{L1}', 'OL-W1', 'took the other 94.99 on the till', 1);")
o2, _, _ = run("select total from public.closed_checks where ref = 'OL-W1' and source = 'online'")
o3, _, _ = run("select customer->>'payment_confirmed_amount_minor' from public.order_queue where ref = 'OL-W1'")
expect('staff who took the rest on the till confirm with the amount the online payment really took: the online check books 0.01 (never counted twice)',
       j(o).get('paid') is True and o2 == '0.01' and o3 == '1', o + o2 + o3)
o, e, r = as_commit('owner1', f"select public.confirm_public_order_payment('{L1}', 'OL-W2', 'seen', 999999);")
o2, _, _ = run("select total from public.closed_checks where ref = 'OL-W2' and source = 'online'")
expect('a confirmed amount is never more than the order still needed', j(o).get('paid') is True and o2 == '94.96', o + o2)

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
o, e, r = run("select has_function_privilege('anon', 'public.claim_device(text)', 'execute'), has_function_privilege('anon', 'public._device_claim_core(text, boolean)', 'execute'), has_function_privilege('authenticated', 'public._device_claim_core(text, boolean)', 'execute'), has_function_privilege('anon', 'public.place_public_order(uuid, jsonb, jsonb, uuid[])', 'execute'), has_function_privilege('anon', 'public.confirm_public_order_payment(uuid, text, text, bigint)', 'execute')")
expect('function grants: claim not for raw anon, core private, order and confirm need a session', o == 'f|f|f|f|f', o)
o, e, r = run("select has_table_privilege('authenticated', 'public.payment_proofs', 'select'), has_table_privilege('anon', 'public.public_order_pending_checks', 'select'), has_table_privilege('authenticated', 'public.qr_tab_members', 'select'), has_table_privilege('authenticated', 'public.device_unlinked_pings', 'select'), has_table_privilege('authenticated', 'public.device_secret_stash', 'select'), has_table_privilege('anon', 'public.device_secret_stash', 'select')")
expect('private tables are private (the device secret stash too)', o == 'f|f|f|f|f|f', o)
helpers = ['_public_order_value(text, text, text, jsonb)', '_public_order_auto(text, text, jsonb)',
           '_public_order_promo(text, text, bigint, text, boolean)', '_public_order_loyalty(text, text, text, bigint, bigint, jsonb)',
           '_public_order_proof_bound(text, text, text, text, text, jsonb, timestamp with time zone)',
           '_loyalty_label_key(text)', '_loyalty_free_item_minor(jsonb, jsonb)', '_fence_num_or_null(text)',
           '_device_mint_secret(uuid, uuid)', '_menu_item_floor_minor(jsonb, text, boolean)', '_fence_rule_live(jsonb, text, timestamp with time zone)']
o, e, r = run("select bool_or(has_function_privilege(r, ('public.' || f)::regprocedure, 'execute')) from unnest(array[" +
              ','.join(f"'{h}'" for h in helpers) + "]) f cross join unnest(array['anon', 'authenticated']) r")
expect('the pricing, promo, loyalty, proof and secret helpers are private (only the order functions call them)', o == 'f', o)

t.finish()
