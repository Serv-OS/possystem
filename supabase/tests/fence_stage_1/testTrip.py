#!/usr/bin/env python3
"""File 1 stops, changing nothing, when a login reaches a venue only through its profile
venue; and it stops, changing nothing, when a till holds a table it needs for too long."""
import os, subprocess, threading, time
import t
from t import run, expect, last, UID, L1, L3

t.reset()
# a login whose only way into L3 is its profile venue
run(f"update public.user_profiles set location_id = '{L3}' where id = '{UID['newbie']}'")
o, e, r = t.apply('20260919a_OPS_fence_1_safe_now.sql')
expect('tripwire stops file A and names the login', r != 0 and 'newbie@x.test' in e and 'STOPPED' in e, e[-400:])
o2, _, _ = run("select count(*) from pg_policies where tablename = 'devices' and policyname = 'allow all'")
o3, _, _ = run("select to_regclass('public.fence_attempts') is null and to_regclass('public.payment_proofs') is null")
expect('nothing changed when it stopped (one transaction: no policy, no new table)', o2 == '1' and o3 == 't', o2 + ' ' + o3)
# Peter confirms the login: paste the id into v_keep
src = open(os.path.join(t.MIG, '20260919a_OPS_fence_1_safe_now.sql')).read()
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

# A till holding closed_checks longer than the 3 second lock wait: file A stops with a
# plain message and changes nothing.
t.reset()
def holder():
    run("begin; insert into public.closed_checks (id, location_id, source, status, total) values ('busy', '" + L1 + "', 'pos', 'paid', 1); select pg_sleep(6); rollback;", check=False)
th = threading.Thread(target=holder)
th.start()
time.sleep(1)
o, e, r = t.apply('20260919a_OPS_fence_1_safe_now.sql')
th.join()
expect('a busy till: file A stops with "press Run again"', r != 0 and 'press Run again' in e, e[-400:])
o2, _, _ = run("select count(*) from pg_policies where tablename = 'devices' and policyname = 'allow all'")
expect('and nothing changed', o2 == '1', o2)
o, e, r = t.apply('20260919a_OPS_fence_1_safe_now.sql')
expect('run again once the till is done: it applies', r == 0, e[-400:])

t.finish()
