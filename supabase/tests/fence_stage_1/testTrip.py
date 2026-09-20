#!/usr/bin/env python3
"""File a1 (identity, venues and devices) stops, changing nothing, when a login reaches a venue only through its profile
venue; and it stops, changing nothing, when a till holds a table it needs for too long."""
import os, subprocess, threading, time
import t
from t import run, expect, last, UID, L1, L3

t.reset()
# a login whose only way into L3 is its profile venue
run(f"update public.user_profiles set location_id = '{L3}' where id = '{UID['newbie']}'")
o, e, r = t.apply(t.FILE_A1)
expect('tripwire stops file A and names the login', r != 0 and 'newbie@x.test' in e and 'STOPPED' in e, e[-400:])
o2, _, _ = run("select count(*) from pg_policies where tablename = 'devices' and policyname = 'allow all'")
o3, _, _ = run("select to_regclass('public.fence_attempts') is null and to_regclass('public.payment_proofs') is null")
expect('nothing changed when it stopped (one transaction: no policy, no new table)', o2 == '1' and o3 == 't', o2 + ' ' + o3)
# Peter confirms the login: paste the id into v_keep
src = open(os.path.join(t.MIG, t.FILE_A1)).read()
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

# THE APP RELEASE GATE (fix round 3). File A no longer trusts a version string: it asks for
# what the app itself recorded (client_caps fence_v1), or a device secret from an earlier run.
# 1. The fleet as it is TODAY: every device on 5.9.11, no capability. File A must STOP.
t.reset()
run("update public.devices set app_version = '5.9.11', client_caps = null, device_secret_hash = null")
run("update public.device_heartbeats set version = '5.9.11'")
o, e, r = t.apply(t.FILE_A1)
expect('THE CURRENT FLEET (every device on 5.9.11 with no fence capability) STOPS file A',
       r != 0 and 'STOPPED' in e and 'have not reported the app release' in e and 'Till 1' in e and 'v5.9.11' in e, e[-700:])
o2, _, _ = run("select count(*) from pg_policies where tablename = 'devices' and policyname = 'allow all'")
o3, _, _ = run("select to_regclass('public.fence_state') is null")
expect('and nothing changed', o2 == '1' and o3 == 't', o2 + ' ' + o3)

# 2. A fleet on the fence app passes (this is what seed.sql sets, so just put it back).
t.reset()
o, e, r = t.apply(t.FILE_A1)
expect('A FLEET ON THE FENCE APP (client_caps fence_v1) passes: file A runs', r == 0, e[-500:])

# 3. One till left behind on the old app stops it and is named, with the version it reports.
t.reset()
run("update public.devices set client_caps = null, app_version = '5.9.8' where name = 'Till 1'")
o, e, r = t.apply(t.FILE_A1)
expect('ONE till that has not reported the release stops file A and is named with its version',
       r != 0 and 'Till 1' in e and 'v5.9.8' in e, e[-600:])
# A till that already holds a device secret counts as ready (a re-run never strands a kept till).
run("update public.devices set device_secret_hash = 'x' where name = 'Till 1'")
o, e, r = t.apply(t.FILE_A1)
expect('a till with no capability but a device secret from an earlier run counts as ready', r == 0, e[-500:])

# 4. A heartbeat from a device that has no devices row cannot hold file A shut (anyone with
#    the public key can write one, and it can never be stranded by this file).
t.reset()
run("insert into public.device_heartbeats (device_id, location_id, device_name, role, last_seen, version) values ('lost-till-9', '" + L1 + "', 'Back room till', 'master', now() - interval '5 minutes', '5.8.40')")
o, e, r = t.apply(t.FILE_A1)
expect('a heartbeat row with no devices row behind it cannot hold file A shut', r == 0 and 'Back room till' not in e, e[-500:])

# 5. A Sunmi till that has run for days: its own row is stale but its heartbeat is recent, so
#    it still counts as switched on, and without the capability it stops the file.
t.reset()
run("update public.devices set last_seen = now() - interval '3 days', client_caps = null where name = 'Beta Till'")
run("insert into public.device_heartbeats (device_id, location_id, device_name, role, last_seen, version) values ('40000000-0000-4000-8000-000000000003', '" + L3 + "', 'Beta Till', 'child', now() - interval '10 minutes', '5.9.8')")
o, e, r = t.apply(t.FILE_A1)
expect('a Sunmi till seen only through its heartbeat is still checked, and is named', r != 0 and 'Beta Till' in e and 'v5.9.8' in e, e[-600:])
run("update public.device_heartbeats set last_seen = now() - interval '3 hours' where device_id = '40000000-0000-4000-8000-000000000003'")
run("update public.devices set last_seen = now() - interval '3 days' where name = 'Beta Till'")
o, e, r = t.apply(t.FILE_A1)
expect('switched off for 2 hours, it stops counting: file A runs', r == 0, e[-500:])

# 6. Step 1b skipped: no device can prove anything, so file A stops and says which file to run.
t.reset()
run("alter table public.devices drop column if exists client_caps")
run("alter table public.devices drop column if exists device_secret_hash")
o, e, r = t.apply(t.FILE_A1)
expect('without step 1b (20260919_OPS_fence_0_caps.sql) file A stops and names it',
       r != 0 and '20260919_OPS_fence_0_caps.sql' in e and 'STOPPED' in e, e[-600:])
o, e, r = t.apply('20260919_OPS_fence_0_caps.sql')
expect('step 1b runs on its own and adds the two columns', r == 0 and 'client_caps,device_secret_hash' in o, (o + e)[-400:])
o2, _, _ = run("select count(*) from pg_policies where tablename = 'devices' and policyname = 'allow all'")
expect('step 1b changes no policy', o2 == '1', o2)
o, e, r = t.apply('20260919_OPS_fence_0_caps.sql')
expect('and it can run twice', r == 0, e[-300:])
run("update public.devices set client_caps = array['fence_v1'] where last_seen > now() - interval '2 hours'")
o, e, r = t.apply(t.FILE_A1)
expect('once the tills report the release, file A runs', r == 0, e[-500:])
# Step 1b's own roll back: it refuses while file A is in, and runs (twice) once file A is out.
o, e, r = t.apply_rollback('20260919_OPS_fence_0_caps.sql')
expect('step 1b roll back refuses while file A is in, and says to roll back file A first',
       r != 0 and 'Roll back 20260919a' in (e or ''), (e or '')[-400:])
o, _, _ = run("select count(*) from information_schema.columns where table_name = 'devices' and column_name in ('client_caps', 'device_secret_hash')")
expect('and changed nothing', o == '2', o)
o, e, r = t.apply_rollback(t.FILE_A1)
expect('file A roll back runs', r == 0, (e or '')[-500:])
o, e, r = t.apply_rollback('20260919_OPS_fence_0_caps.sql')
o2, _, _ = run("select count(*) from information_schema.columns where table_name = 'devices' and column_name in ('client_caps', 'device_secret_hash')")
expect('then step 1b roll back takes its two columns back', r == 0 and o2 == '0', (e or '')[-400:] + '|' + o2)
o, e, r = t.apply_rollback('20260919_OPS_fence_0_caps.sql')
expect('and it can run twice', r == 0, (e or '')[-300:])

# A till holding closed_checks longer than the 3 second lock wait: file A stops with a
# plain message and changes nothing.
t.reset()
def holder():
    run("begin; insert into public.closed_checks (id, location_id, source, status, total) values ('busy', '" + L1 + "', 'pos', 'paid', 1); select pg_sleep(6); rollback;", check=False)
th = threading.Thread(target=holder)
th.start()
time.sleep(1)
o, e, r = t.apply(t.FILE_A1)
th.join()
expect('a busy till: file A stops with "press Run again"', r != 0 and 'press Run again' in e, e[-400:])
o2, _, _ = run("select count(*) from pg_policies where tablename = 'devices' and policyname = 'allow all'")
expect('and nothing changed', o2 == '1', o2)
o, e, r = t.apply(t.FILE_A1)
expect('run again once the till is done: it applies', r == 0, e[-400:])

t.finish()
