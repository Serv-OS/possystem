#!/usr/bin/env python3
import json, sys
import t
from t import as_, as_commit, expect, last, UID, L1, L2, L3, L4, run

t.reset()
out, err, rc = t.apply('20260919a_OPS_fence_1_safe_now.sql')
expect('file A applies cleanly', rc == 0, err[-2000:])
print('   verify row:', last(out))
out2, err2, rc2 = t.apply('20260919a_OPS_fence_1_safe_now.sql')
expect('file A applies a second time (idempotent)', rc2 == 0, err2[-2000:])
print('   verify row 2:', last(out2))

# ---------- grandfathering
o, e, r = run("select name, coalesce(bound_via,'-'), coalesce(device_uid::text,'-'), status, coalesce(pairing_code,'-') from public.devices order by name")
print(o)
kept = dict((l.split('|')[0], l.split('|')[1]) for l in o.splitlines())
expect('Till 1 (anon, seen 1h) kept', kept['Till 1'] == 'grandfathered')
expect('Beta Till (anon, 2 days) kept', kept['Beta Till'] == 'grandfathered')
expect('Kiosk 1 kept', kept['Kiosk 1'] == 'grandfathered')
expect('KDS 1 (20 days) not kept', kept['KDS 1'] == '-')
expect('Owner1 at Acme (linked login) kept', kept['Owner1 at Acme'] == 'grandfathered')
expect('Owner1 at Beta (login not linked there) not kept', kept['Owner1 at Beta'] == '-')
expect('Dup A (newest of the two rows) kept', kept['Dup A'] == 'grandfathered')
expect('Dup B not kept', kept['Dup B'] == '-')
expect('No venue row not kept', kept['No venue'] == '-')
o, _, _ = run("select count(*) from public.devices where pairing_code is not null")
expect('no pairing code left readable on the table', o == '0', o)
o, _, _ = run("select count(*) from public.device_heal_codes")
expect('heal codes kept for grandfathered tills with a code', o == '4', o)

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
expect('owner reads own profile plus teammates (3)', last(o) == '3', o + e)
o, e, r = as_('attacker', "select count(*) from public.user_profiles;")
expect('anonymous session reads only its own profile', last(o) == '1', o + e)
o, e, r = as_('super', "select count(*) from public.user_profiles;")
expect('super admin reads all profiles', last(o) == '15', o + e)
o, e, r = as_('manager1', f"with u as (update public.user_profiles set bo_access = true where id = '{UID['staff1']}' returning 1) select count(*) from u;")
expect('manager switches a staff login Back Office access', last(o) == '1', o + e)
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

# new operator bootstrap (CompanyAdmin.jsx) keeps working
o, e, r = as_('newbie', f"""
with o as (insert into public.organisations (name, slug, status) values ('Newco', 'newco', 'active') returning id)
select id from o;
""")
new_org_ok = r == 0 and len(last(o)) == 36
expect('new operator creates a company (insert returning)', new_org_ok, o + e)
o, e, r = as_('newbie', f"""
create temp table t_org as select id from (insert into public.organisations (name, slug) values ('Newco2','newco2') returning id) x;
""") if False else ('', '', 0)
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

# ---------- devices
o, e, r = as_('attacker', f"insert into public.devices (location_id, name, type, status, device_uid) values ('{L1}', 'evil', 'pos', 'active', auth.uid());")
expect('anonymous session cannot add a device', r != 0, e)
o, e, r = as_('rawanon', f"insert into public.devices (location_id, name) values ('{L1}', 'evil');")
expect('raw anon key cannot add a device', r != 0, e)
o, e, r = as_('attacker', "with u as (update public.devices set device_uid = auth.uid() returning 1) select count(*) from u;")
expect('anonymous session cannot take over a device row', last(o) == '0', o + e)
o, e, r = as_('attacker', "with d as (delete from public.devices returning 1) select count(*) from d;")
expect('anonymous session cannot delete devices', last(o) == '0', o + e)
o, e, r = as_('attacker', f"select public.pos_can_access('{L1}'::text);")
expect('attacker is not staff of L1', last(o) == 'f', o + e)
o, e, r = as_('dev1', f"select public.pos_can_access('{L1}'::text), public.pos_can_access('{L1}'::uuid);")
expect('grandfathered till keeps access', last(o) == 't|t', o + e)
o, e, r = as_('dev2', f"select public.pos_can_access('{L1}'::text);")
expect('unbound stale till has no access', last(o) == 'f', o + e)
o, e, r = as_('dev1', "with u as (update public.devices set status = 'online', last_seen = now(), app_version = '5.9.8' where id = '40000000-0000-4000-8000-000000000001' returning 1) select count(*) from u;")
expect('till heartbeat on own row works', last(o) == '1', o + e)
o, e, r = as_('dev1', "with u as (update public.devices set session_token = 'sess-new' where id = '40000000-0000-4000-8000-000000000001' returning 1) select count(*) from u;")
expect('till writes its session token', last(o) == '1', o + e)
o, e, r = as_('dev1', "update public.devices set kds_settings = '{\"a\":1}' where id = '40000000-0000-4000-8000-000000000001';")
expect('till writes its screen settings', r == 0, e)
o, e, r = as_('dev1', f"update public.devices set location_id = '{L3}' where id = '40000000-0000-4000-8000-000000000001';")
expect('till cannot move itself to another venue', r != 0, e)
o, e, r = as_('dev1', "update public.devices set name = 'x' where id = '40000000-0000-4000-8000-000000000001';")
expect('till cannot rename itself', r != 0, e)
o, e, r = as_('dev1', "with u as (update public.devices set status = 'online' where id = '40000000-0000-4000-8000-000000000003' returning 1) select count(*) from u;")
expect('till cannot touch another till row', last(o) == '0', o + e)
# rotated login re-links with its saved code (live app boot)
o, e, r = as_('attacker', "select public.claim_device_v2('APPLE-1111')->>'reason'; select public.pos_can_access('10000000-0000-4000-8000-000000000001'::text);")
expect('someone holding an old code, off the venue network, cannot take the till', last(o) == 'f', o + e)
run("update auth.sessions set updated_at = now() where user_id = '" + UID['dev1'] + "'")
o, e, r = as_('dev1b', "select public.claim_device('APPLE-1111'); select public.pos_can_access('10000000-0000-4000-8000-000000000001'::text);")
expect('no re-link while the till login is still active', last(o) == 'f', o + e)
run("update auth.sessions set updated_at = now() - interval '2 hours', refreshed_at = (now() - interval '2 hours') at time zone 'UTC' where user_id = '" + UID['dev1'] + "'")
o, e, r = as_('dev1b', "select public.claim_device('APPLE-1111'); select public.pos_can_access('10000000-0000-4000-8000-000000000001'::text);")
expect('till whose login changed re-links with its saved code (idle, same network)', last(o) == 't', o + e)
o, e, r = as_('dev1', "select public.claim_device('APPLE-1111');")
expect('same till re-claim is idempotent (B8)', last(o) == L1, o + e)
o, e, r = as_('dev1', "select public.claim_device('');")
expect('same till with no code is idempotent', last(o) == L1, o + e)
# brute force lock
o, e, r = as_('attacker', "select public.claim_device('APPLE-0001'); select public.claim_device('APPLE-0002'); select public.claim_device('APPLE-0003'); select public.claim_device('APPLE-0004'); select public.claim_device('APPLE-0005'); select public.claim_device('APPLE-0006'); select public.claim_device_v2('APPLE-1111')->>'reason';")
expect('6 wrong codes lock the session (even the right code is refused)', last(o) == 'locked', o + e)
# heal limit
IDLE = "update auth.sessions set created_at = now() - interval '3 hours', updated_at = now() - interval '2 hours', refreshed_at = (now() - interval '2 hours') at time zone 'UTC'"
run(IDLE); o, e, r = as_commit('dev1b', "select public.claim_device('APPLE-1111');")
run(IDLE); o, e, r = as_commit('dev1', "select public.claim_device('APPLE-1111');")
run(IDLE); o, e, r = as_commit('dev1b', "select public.claim_device('APPLE-1111');")
run(IDLE); o, e, r = as_commit('dev1', "select public.claim_device_v2('APPLE-1111')->>'reason';")
expect('re-link limit: 3 per till per day', last(o) == 'heal_limit', o + e)
run("delete from public.device_heal_codes where device_id = '40000000-0000-4000-8000-000000000001'; update public.devices set device_uid = null where id = '40000000-0000-4000-8000-000000000001';")

# Back Office adds a till, the live pairing screen pairs it
o, e, r = as_commit('owner1', f"insert into public.devices (location_id, name, type, pairing_code, status) values ('{L1}', 'New till', 'pos', 'apple-4242', 'unpaired');")
expect('Back Office adds a device with a code', r == 0, e)
o, e, r = run("select pairing_code, pairing_expires_at > now() + interval '55 minutes', status, device_uid is null from public.devices where name = 'New till'")
expect('code stored upper case, 60 minute expiry, unpaired, no link', o == 'APPLE-4242|t|unpaired|t', o)
o, e, r = as_('newtill', "select id is not null from public.devices where pairing_code = 'APPLE-4242';")
expect('live pairing screen can look the fresh code up', last(o) == 't', o + e)
o, e, r = as_('newtill', "with u as (update public.devices set status = 'active', paired_at = now() where pairing_code = 'APPLE-4242' returning 1) select count(*) from u;")
expect('live pre-claim update quietly matches 0 rows', last(o) == '0', o + e)
o, e, r = as_commit('newtill', "select public.claim_device('APPLE-4242');")
expect('live claim_device binds the new till', last(o) == L1, o + e)
o, e, r = run("select status, bound_via, pairing_code is null, device_uid = '" + UID['newtill'] + "' from public.devices where name = 'New till'")
expect('new till active, bound by code, code gone', o == 'active|code|t|t', o)
o, e, r = as_('attacker', "select public.claim_device_v2('APPLE-4242')->>'reason';")
expect('used code cannot be claimed by anyone else', last(o) in ('not_found',), o + e)
o, e, r = as_('owner1', f"update public.devices set device_uid = '{UID['attacker']}' where name = 'New till';")
expect('Back Office cannot link a device to a login directly', r != 0, e)
o, e, r = as_('owner1', "select public.issue_pairing_code(id)->>'reason' from public.devices where name = 'New till';")
expect('issuing a code for a paired till needs force', last(o) == 'paired', o + e)
o, e, r = as_commit('owner1', "select public.issue_pairing_code(id, true)->>'ok' from public.devices where name = 'New till';")
expect('forced new code', last(o) == 'true', o + e)
o, e, r = run("select device_uid is null, bound_via is null, pairing_code ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$' from public.devices where name = 'New till'")
expect('forced new code unlinks the old till and is a 12 symbol server code', o == 't|t|t', o)
o, e, r = as_('newtill', f"select public.pos_can_access('{L1}'::text);")
expect('moved till lost access at once', last(o) == 'f', o + e)
code, _, _ = run("select pairing_code from public.devices where name = 'New till'")
o, e, r = as_commit('newtill', f"select (public.claim_device_v2('{code.replace('-', ' ').lower()}')->>'device_secret') is not null;")
expect('claim_device_v2 accepts the code with spaces and lower case, returns a secret', last(o) == 't', o + e)
# expired code
run("update public.devices set pairing_code = 'BAKER-7070', status = 'unpaired' where name = 'KDS 1'; update public.devices set pairing_expires_at = now() - interval '1 minute' where name = 'KDS 1';")
o, e, r = as_('newtill', "select public.claim_device_v2('BAKER-7070')->>'reason';")
expect('expired code refused', last(o) == 'expired', o + e)
# device secret
o, e, r = as_commit('dev3', "select (public.device_issue_secret()->>'device_secret');")
secret = last(o)
expect('bound till collects a device secret', len(secret) == 64, o + e)
o, e, r = as_('dev1b', f"select public.reclaim_device('40000000-0000-4000-8000-000000000003', '{secret}')->>'ok'; select public.pos_can_access('{L3}'::text);")
expect('reclaim with the device secret re-links a changed login', last(o) == 't', o + e)
o, e, r = as_('dev1b', "select public.reclaim_device('40000000-0000-4000-8000-000000000003', 'nope')->>'reason';")
expect('wrong secret refused', last(o) == 'invalid', o + e)
o, e, r = as_('dev3', "select public.device_heartbeat('5.9.9', array['fence_v1','device_secret'])->>'bound'; select array_to_string(client_caps, ',') from public.devices where id = '40000000-0000-4000-8000-000000000003';")
expect('heartbeat reports version and caps', last(o) == 'fence_v1,device_secret', o + e)
o, e, r = as_('dev3', "select public.device_status()->>'bound';")
expect('device_status says bound', last(o) == 'true', o + e)
o, e, r = as_('attacker', "select public.device_status()->>'bound';")
expect('device_status says not bound for a stranger', last(o) == 'false', o + e)
# BO removes a till: link gone everywhere
o, e, r = as_commit('owner1', "update public.devices set status = 'removed' where id = '40000000-0000-4000-8000-000000000004';")
o, e, r = run("select device_uid is null, bound_via is null from public.devices where id = '40000000-0000-4000-8000-000000000004'")
expect('removing a device drops its link', o == 't|t', o)
# kiosk live flow
o, e, r = as_commit('owner1', f"insert into public.devices (location_id, name, type, profile_id, pairing_code, status) values ('{L1}', 'Kiosk 2', 'kiosk', null, 'CEDAR-5151', 'awaiting_pairing');")
o, e, r = as_('newtill', """
select id from public.devices where pairing_code = 'CEDAR-5151' and type = 'kiosk';
select public.claim_device('CEDAR-5151');
update public.devices set paired_at = now(), pairing_code = null, session_token = 'tok', last_seen = now(), status = 'online' where name = 'Kiosk 2';
select status || '|' || coalesce(bound_via, '-') from public.devices where name = 'Kiosk 2';
""")
expect('live kiosk pairing flow still works', last(o) == 'online|code', o + e)

# ---------- customer server functions
run(f"""insert into public.payment_proofs (processor, payment_ref, kind, location_id, amount_minor, verified_by)
        values ('stripe', 'pi_card_1', 'card', '{L1}', 2500, 'test'),
               ('stripe', 'pi_tab_1', 'preauth', '{L1}', 5000, 'test'),
               ('stripe', 'pi_small', 'card', '{L1}', 100, 'test');""")
pid, _, _ = run("select id from public.payment_proofs where payment_ref = 'pi_card_1'")
small, _, _ = run("select id from public.payment_proofs where payment_ref = 'pi_small'")
order = json.dumps({'ref': 'OL-TEST1', 'source': 'online', 'type': 'collection', 'status': 'collected', 'staff': 'Evil',
                    'items': [{'name': 'Burger', 'price': 20, 'qty': 1}], 'total': 25,
                    'customer': {'name': 'Ann', 'phone': '07700 900123', 'paid': True}}).replace("'", "''")
check = json.dumps({'id': 'chk-test-1', 'total': 25, 'subtotal': 20.83, 'tax_amount': 4.17, 'method': 'card', 'staff_id': 'x',
                    'processor': 'stripe', 'stripe_payment_intent_id': 'pi_card_1', 'status': 'refunded'}).replace("'", "''")
o, e, r = as_commit('customer', f"select public.place_public_order('{L1}', '{order}'::jsonb, '{check}'::jsonb, array['{pid}']::uuid[]);")
res = json.loads(last(o)) if r == 0 else {}
expect('paid online order with card proof', res.get('paid') is True and res.get('check_id') == 'chk-test-1', o + e)
o, e, r = run("select status, staff is null, paid, placed_via, customer ? 'paid' from public.order_queue where ref = 'OL-TEST1'")
expect('order row: server status, no staff, paid, rpc, client paid flag stripped', o == 'prep|t|t|rpc|f', o)
o, e, r = run("select status, source, total, staff_id is null from public.closed_checks where id = 'chk-test-1'")
expect('closed check written as paid online', o == 'paid|online|25.00|t' or o == 'paid|online|25|t', o)
o, e, r = as_('customer', f"select public.place_public_order('{L1}', '{order}'::jsonb, '{check}'::jsonb, array['{pid}']::uuid[])->>'idempotent';")
expect('retry by the same session returns the same answer', last(o) == 'true', o + e)
o, e, r = as_('attacker', f"select public.place_public_order('{L1}', '{order}'::jsonb, '{check}'::jsonb, array['{pid}']::uuid[])->>'reason';")
expect('another session cannot reuse the ref', last(o) == 'ref_taken', o + e)
order2 = order.replace('OL-TEST1', 'OL-TEST2')
check2 = check.replace('chk-test-1', 'chk-test-2')
o, e, r = as_commit('attacker', f"select public.place_public_order('{L1}', '{order2}'::jsonb, '{check2}'::jsonb, array['{pid}']::uuid[]);")
res2 = json.loads(last(o)) if r == 0 else {}
expect('a used card proof cannot pay a second order', res2.get('paid') is False and res2.get('payment_unverified') is True, o + e)
o, e, r = run("select count(*) from public.closed_checks where id = 'chk-test-2'")
expect('no closed check for the unproven order', o == '0', o)
order3 = order.replace('OL-TEST1', 'OL-TEST3')
check3 = check.replace('chk-test-1', 'chk-test-3')
o, e, r = as_('attacker', f"select public.place_public_order('{L1}', '{order3}'::jsonb, '{check3}'::jsonb, array['{small}']::uuid[])->>'paid';")
expect('a proof smaller than the total does not make it paid', last(o) == 'false', o + e)
tok = res.get('track_token', '')
o, e, r = as_('rawanon', f"select public.order_track_row('{L1}', 'OL-TEST1', '{tok}')->>'status';")
expect('tracker works with the token and no session', last(o) == 'prep', o + e)
o, e, r = as_('rawanon', f"select public.order_track_row('{L1}', 'OL-TEST1', '0123')->'customer'->>'phone';")
expect('old share link (last 4) works and shows only 4 digits', last(o) == '0123', o + e)
o, e, r = as_('rawanon', f"select public.order_track_row('{L1}', 'OL-TEST1', '0123')->'customer' ? 'name';")
expect('tracker never returns the name', last(o) == 'f', o + e)
guesses = ''.join(f"select public.order_track_check('{L1}', 'OL-TEST1', '{i:04d}');" for i in range(10))
o, e, r = as_commit('rawanon', guesses)
o, e, r = as_('rawanon', f"select public.order_track_check('{L1}', 'OL-TEST1', '{tok}');")
expect('10 wrong keys lock that order tracker for an hour', last(o) == 'f', o + e)
# QR tab
tab = json.dumps({'ref': 'QR-T1', 'source': 'qr', 'type': 'dine-in', 'items': [{'name': 'Beer', 'price': 6, 'qty': 1}], 'total': 6,
                  'customer': {'name': 'Bob', 'tableId': 'T5', 'tableLabel': '5', 'tab_open': True, 'payment_intent_id': 'pi_tab_1',
                               'stripe_account': 'acct_1', 'payment_method_id': 'pm_1', 'tab_join_code': '1234'}}).replace("'", "''")
o, e, r = as_commit('customer', f"select public.place_public_order('{L1}', '{tab}'::jsonb, null, '{{}}'::uuid[]);")
rt = json.loads(last(o)) if r == 0 else {}
join = rt.get('tab_join_code') or ''
expect('QR tab opened with a server table code (phone code ignored)', rt.get('ok') and len(join) == 6 and join != '1234', o + e)
tab2 = tab.replace('QR-T1', 'QR-T2')
o, e, r = as_commit('customer', f"select public.place_public_order('{L1}', '{tab2}'::jsonb, null, '{{}}'::uuid[])->>'tab_join_code';")
expect('second round keeps the same table code', last(o) == join, o + e)
o, e, r = as_('attacker', f"select public.qr_table_open_tabs('{L1}', 'T5');")
expect('open tabs list has no payment id, no code, no name', 'pi_tab_1' not in o and join not in o and 'Bob' not in o and 'tab_handle' in o, o + e)
handle = json.loads(last(o))[0]['tab_handle']
o, e, r = as_('attacker', f"select public.qr_tab_join('{L1}', '{handle}', 'WRONG1')->>'reason';")
expect('wrong table code refused', last(o) == 'wrong_code', o + e)
o, e, r = as_('attacker', f"select public.qr_tab_join('{L1}', '{handle}', '{join.lower()}')->'tab'->>'payment_intent_id';")
expect('right table code gives the tab', last(o) == 'pi_tab_1', o + e)
o, e, r = as_('customer', f"select jsonb_array_length(public.qr_tab_rounds('{L1}', 'pi_tab_1')->'rounds');")
expect('tab owner reads both rounds by payment id', last(o) == '2', o + e)
o, e, r = as_('customer', f"select public.qr_table_tab_count('{L1}', 'T5');")
expect('tab count', last(o) == '1', o + e)
o, e, r = as_('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_1', '{{}}'::jsonb, '{{}}'::uuid[])->>'reason';")
expect('settle refused before the server saw a capture', last(o) == 'not_captured', o + e)
run(f"insert into public.payment_proofs (processor, payment_ref, kind, location_id, amount_minor, verified_by) values ('stripe', 'pi_tab_1', 'capture', '{L1}', 1800, 'test');")
o, e, r = as_commit('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_1', '{{}}'::jsonb, '{{}}'::uuid[]);")
st = json.loads(last(o)) if r == 0 else {}
expect('settle tab after capture closes both rounds', st.get('closed') == 2 and st.get('ok') is True, o + e)
o, e, r = run("select total, source, (customer->>'shortfall')::numeric from public.closed_checks where id = (select id from public.closed_checks where source = 'qr' limit 1)")
expect('QR check books what was captured (12.00 of 12.00 claimed; capture 18.00)', o.startswith('12'), o)
o, e, r = as_('customer', f"select public.place_public_order('{L1}', '{tab.replace('QR-T1', 'QR-T3')}'::jsonb, null, '{{}}'::uuid[])->>'reason';")
expect('no new rounds on a captured tab', last(o) == 'tab_closed', o + e)
nopi = tab.replace('QR-T1', 'QR-T4').replace('pi_tab_1', 'pi_fake')
o, e, r = as_('attacker', f"select public.place_public_order('{L1}', '{nopi}'::jsonb, null, '{{}}'::uuid[])->>'reason';")
expect('tab without a server proven hold refused', last(o) == 'tab_not_verified', o + e)
cat = json.dumps({'ref': 'CT-1', 'source': 'catering', 'type': 'delivery', 'event_date': '2099-01-01',
                  'items': [{'name': 'Tray', 'price': 50, 'qty': 1}], 'total': 50, 'customer': {'name': 'C'}}).replace("'", "''")
o, e, r = as_commit('customer', f"select public.place_public_order('{L1}', '{cat}'::jsonb);")
rc_ = json.loads(last(o)) if r == 0 else {}
expect('catering pay later is placed unpaid (received)', rc_.get('ok') and rc_.get('paid') is False and rc_.get('status') == 'received', o + e)
o, e, r = run("select event_date is null from public.order_queue where ref = 'CT-1'")
expect('a far future event date is dropped', o == 't', o)
o, e, r = as_('rawanon', f"select * from public.catering_day_load('{L1}', current_date);")
expect('catering load works without a session', r == 0, e)
bad = json.dumps({'ref': 'OL-BAD', 'source': 'online', 'items': [{'n': 1}], 'total': 'abc', 'sent_at': 'garbage', 'is_asap': 'maybe',
                  'customer': {}}).replace("'", "''")
o, e, r = as_('customer', f"select public.place_public_order('{L1}', '{bad}'::jsonb)->>'ok';")
expect('bad numbers and dates never raise (G10, G11)', r == 0 and last(o) == 'true', o + e)
o, e, r = as_('rawanon', f"select public.place_public_order('{L1}', '{bad}'::jsonb);")
expect('raw anon key cannot place orders (needs a session)', r != 0, e)

# ---------- print agents
run(f"insert into public.print_jobs (location_id, printer_id, printer_ip, job_type, payload, status) values ('{L1}', 'p1', '10.0.0.5', 'receipt', 'eA==', 'pending'), ('{L3}', 'p3', '10.0.0.6', 'receipt', 'eA==', 'pending');")
o, e, r = as_('attacker', f"select public.issue_print_agent_token('{L1}', 'x');")
expect('anonymous session cannot issue an agent key', r != 0, e)
o, e, r = as_commit('owner1', f"select public.issue_print_agent_token('{L1}', 'Kitchen agent')->>'token';")
agent = last(o)
expect('Back Office issues an agent key', agent.startswith('pa_'), o + e)
o, e, r = as_('rawanon', f"select jsonb_array_length(public.print_agent_claim('{agent}', 'agent-1', 5, 60)->'jobs');")
expect('agent claims only its own venue jobs', last(o) == '1', o + e)
o, e, r = as_('rawanon', "select public.print_agent_claim('pa_wrong', 'a', 5, 60)->>'reason';")
expect('wrong agent key refused', last(o) == 'bad_key', o + e)

# ---------- QR floor trigger function (attached in file 2, called directly here)
run(f"insert into public.floor_tables (id, location_id, label) values ('ft-5', '{L1}', 'T5') on conflict do nothing;")
run(f"insert into public.active_sessions (location_id, table_id, session) values ('{L1}', 'ft-9', '{{\"items\":[1],\"source\":\"pos\"}}');")
run(f"update public.order_queue set status = 'prep' where ref in ('QR-T1','QR-T2');")
run(f"select public._qr_sync_table_session('{L1}', 'T5');")
o, e, r = run(f"select table_id, session->>'source', session->>'qr_tab_count' from public.active_sessions where location_id = '{L1}' and table_id = 'ft-5'")
expect('QR floor sync writes a qr session on the canonical table', o == 'ft-5|qr|2', o)
run(f"update public.order_queue set customer = customer || '{{\"tableId\":\"ft-9\"}}' where ref = 'QR-T1';")
run(f"select public._qr_sync_table_session('{L1}', 'ft-9');")
o, e, r = run(f"select session->>'source' from public.active_sessions where location_id = '{L1}' and table_id = 'ft-9'")
expect('QR floor sync never overwrites a till session', o == 'pos', o)

# ---------- grants
o, e, r = run("select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('anon', c.oid, 'TRUNCATE')")
expect('no TRUNCATE left for anon', o == '0', o)
o, e, r = run("select has_function_privilege('anon', 'public.claim_device(text)', 'execute'), has_function_privilege('anon', 'public._device_claim_core(text, boolean)', 'execute'), has_function_privilege('authenticated', 'public._device_claim_core(text, boolean)', 'execute'), has_function_privilege('anon', 'public.place_public_order(uuid, jsonb, jsonb, uuid[])', 'execute')")
expect('function grants: claim not for raw anon, core private, place needs a session', o == 'f|f|f|f', o)
o, e, r = run("select has_table_privilege('authenticated', 'public.payment_proofs', 'select'), has_table_privilege('anon', 'public.device_heal_codes', 'select')")
expect('private tables are private', o == 'f|f', o)

fails = [n for n, ok, d in t.RESULTS if not ok]
print(f"\n{len(t.RESULTS) - len(fails)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
