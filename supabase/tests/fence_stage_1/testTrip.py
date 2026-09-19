#!/usr/bin/env python3
import sys
import t
from t import run, expect, last, UID, L1, L3

t.reset()
# a login whose only way into L3 is its profile venue
run(f"update public.user_profiles set location_id = '{L3}' where id = '{UID['newbie']}'")
o, e, r = t.apply('20260919a_OPS_fence_1_safe_now.sql')
expect('tripwire stops file A and names the login', r != 0 and 'newbie@x.test' in e and 'STOPPED' in e, e[-400:])
o2, _, _ = run("select count(*) from pg_policies where tablename = 'devices' and policyname = 'allow all'")
expect('nothing changed when it stopped (single transaction)', o2 == '1', o2)
# Peter confirms the login: paste the id into v_keep
src = open(t.MIG + '/20260919a_OPS_fence_1_safe_now.sql').read()
src2 = src.replace("v_keep uuid[] := array[]::uuid[];", f"v_keep uuid[] := array['{UID['newbie']}']::uuid[];")
o, e, r = run(src2, check=False)
expect('with the id confirmed the file runs and links the login', r == 0, e[-400:])
o3, _, _ = run(f"select count(*) from public.user_locations where user_id = '{UID['newbie']}' and location_id = '{L3}'")
expect('confirmed login now has a real venue link', o3 == '1', o3)
fails = [n for n, ok, d in t.RESULTS if not ok]
print(f"\n{len(t.RESULTS) - len(fails)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
