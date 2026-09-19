#!/usr/bin/env python3
"""File 1 stops, changing nothing, when a login reaches a venue only through its profile
venue; and it stops, changing nothing, when a till holds a table it needs for too long."""
import os, subprocess, threading, time
import t
from t import run, expect, last, UID, L1, L3

t.reset()
# a login whose only way into L3 is its profile venue
run(f"update public.user_profiles set location_id = '{L3}' where id = '{UID['newbie']}'")
o, e, r = t.apply('20260919a_OPS_fence_1_after_release.sql')
expect('tripwire stops file A and names the login', r != 0 and 'newbie@x.test' in e and 'STOPPED' in e, e[-400:])
o2, _, _ = run("select count(*) from pg_policies where tablename = 'devices' and policyname = 'allow all'")
o3, _, _ = run("select to_regclass('public.fence_attempts') is null and to_regclass('public.payment_proofs') is null")
expect('nothing changed when it stopped (one transaction: no policy, no new table)', o2 == '1' and o3 == 't', o2 + ' ' + o3)
# Peter confirms the login: paste the id into v_keep
src = open(os.path.join(t.MIG, '20260919a_OPS_fence_1_after_release.sql')).read()
src2 = src.replace("v_keep uuid[] := array[]::uuid[];", f"v_keep uuid[] := array['{UID['newbie']}']::uuid[];")
tmp = os.path.join(t.HERE, '.trip_keep.sql')
open(tmp, 'w').write(src2)
try:
    o, e, r = t.run_file(tmp)
finally:
    os.remove(tmp)
expect('with the id confirmed the file runs and links the login', r == 0, e[-400:])
o3, _, _ = run(f"select count(*) from public.user_locations where user_id = '{UID['newbie']}' and location_id = '{L3}'")
expect('confirmed login now has a real venue link', o3 == '1', o3)

# The app release must be on every device switched on in the last 2 hours (fix round 2).
t.reset()
run("insert into public.device_heartbeats (device_id, location_id, device_name, role, last_seen, version) values ('40000000-0000-4000-8000-000000000003', '" + L3 + "', 'Beta Till', 'child', now() - interval '10 minutes', '5.9.8')")
o, e, r = t.apply('20260919a_OPS_fence_1_after_release.sql')
expect('a till heartbeating an older app (5.9.8) in the last 2 hours stops file A and is named',
       r != 0 and 'older than v5.9.10' in e and 'Beta Till' in e and 'v5.9.8' in e, e[-500:])
o2, _, _ = run("select count(*) from pg_policies where tablename = 'devices' and policyname = 'allow all'")
o3, _, _ = run("select to_regclass('public.fence_state') is null")
expect('and nothing changed', o2 == '1' and o3 == 't', o2 + ' ' + o3)
run("update public.device_heartbeats set version = '5.9.10' where device_id = '40000000-0000-4000-8000-000000000003'")
run("update public.devices set last_seen = now() - interval '30 minutes', app_version = null where name = 'Kiosk 1'")
o, e, r = t.apply('20260919a_OPS_fence_1_after_release.sql')
expect('a device seen in the last 2 hours that reports no version stops it too', r != 0 and 'Kiosk 1' in e and 'no version reported' in e, e[-500:])
run("update public.devices set last_seen = now() - interval '3 hours' where name = 'Kiosk 1'")
run("insert into public.device_heartbeats (device_id, location_id, device_name, role, last_seen, version) values ('lost-till-9', '" + L1 + "', 'Back room till', 'master', now() - interval '5 minutes', '5.8.40')")
o, e, r = t.apply('20260919a_OPS_fence_1_after_release.sql')
expect('a till heartbeating with no devices row at all (old code) is caught by name', r != 0 and 'Back room till' in e, e[-500:])
run("update public.device_heartbeats set last_seen = now() - interval '3 hours' where device_id = 'lost-till-9'")
run("update public.devices set app_version = '5.10.0' where name = 'Till 1'")
o, e, r = t.apply('20260919a_OPS_fence_1_after_release.sql')
expect('devices switched off for 2 hours are not counted, and a newer version (5.10.0) passes: file A runs', r == 0, e[-500:])

# A till holding closed_checks longer than the 3 second lock wait: file A stops with a
# plain message and changes nothing.
t.reset()
def holder():
    run("begin; insert into public.closed_checks (id, location_id, source, status, total) values ('busy', '" + L1 + "', 'pos', 'paid', 1); select pg_sleep(6); rollback;", check=False)
th = threading.Thread(target=holder)
th.start()
time.sleep(1)
o, e, r = t.apply('20260919a_OPS_fence_1_after_release.sql')
th.join()
expect('a busy till: file A stops with "press Run again"', r != 0 and 'press Run again' in e, e[-400:])
o2, _, _ = run("select count(*) from pg_policies where tablename = 'devices' and policyname = 'allow all'")
expect('and nothing changed', o2 == '1', o2)
o, e, r = t.apply('20260919a_OPS_fence_1_after_release.sql')
expect('run again once the till is done: it applies', r == 0, e[-400:])

t.finish()
