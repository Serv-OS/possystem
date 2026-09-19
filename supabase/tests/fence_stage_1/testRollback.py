#!/usr/bin/env python3
"""Every ROLL BACK block, run for real on the local throwaway copy: each one must put back
exactly the policies, grants, functions and triggers its file changed (TRUNCATE,
REFERENCES and TRIGGER grants excepted, on purpose), and must run twice."""
import json, os, re
import t
from t import as_commit, expect, last, run, L1
import testP

OPS_A_TABLES = ['devices', 'organisations', 'locations', 'user_profiles', 'user_locations', 'order_queue', 'closed_checks']
OPS_A_FUNCS = ['user_accessible_locations()', 'user_accessible_orgs()', 'can_claim_location(uuid)',
               'pos_can_access(text)', 'pos_can_access(uuid)', 'claim_device(text)']
OPS_B_TABLES = ['order_queue', 'kds_tickets', 'print_jobs', 'active_sessions', 'table_reservations', 'closed_checks', 'bar_tabs', 'devices']
PLAT_TABLES = ['gift_card_purchases', 'location_reader_settings', 'locations', 'gift_cards']

def norm(s):
    s = re.sub(r'\s+', ' ', s or '').strip()
    return re.sub(r'\s*([(),;=])\s*', r'\1', s)

def snapshot(tables, funcs=(), db='ops', skip_triggers=()):
    tl = ','.join(f"'{x}'" for x in tables)
    pol, _, _ = run(f"select tablename, policyname, permissive, roles::text, cmd, coalesce(qual,''), coalesce(with_check,'') from pg_policies where schemaname = 'public' and tablename in ({tl}) order by 1, 2", db=db)
    gr, _, _ = run(f"""select c.relname, r, p from pg_class c join pg_namespace n on n.oid = c.relnamespace
                        cross join unnest(array['anon','authenticated']) r cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
                        where n.nspname = 'public' and c.relname in ({tl}) and has_table_privilege(r, c.oid, p) order by 1, 2, 3""", db=db)
    cg, _, _ = run(f"""select c.relname, r, a.attname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                        cross join unnest(array['anon','authenticated']) r
                        where n.nspname = 'public' and c.relname in ({tl}) and has_column_privilege(r, c.oid, a.attname, 'UPDATE')
                          and not has_table_privilege(r, c.oid, 'UPDATE') order by 1, 2, 3""", db=db)
    tg, _, _ = run(f"select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ({tl}) and not t.tgisinternal order by 1, 2", db=db)
    tg = '\n'.join(l for l in tg.splitlines() if l.split('|')[1] not in skip_triggers)
    ix, _, _ = run(f"select tablename, indexname from pg_indexes where schemaname = 'public' and tablename in ({tl}) order by 1, 2", db=db)
    fn = {}
    for f in funcs:
        o, _, _ = run(f"""select prosrc, prosecdef, coalesce(array_to_string(proconfig, ','), ''), provolatile,
                                 has_function_privilege('anon', 'public.{f}', 'execute'), has_function_privilege('authenticated', 'public.{f}', 'execute')
                            from pg_proc where oid = 'public.{f}'::regprocedure""", db=db)
        parts = o.split('|')
        fn[f] = (norm('|'.join(parts[:-5])),) + tuple(parts[-5:])
    return {'policies': pol, 'grants': gr, 'column_grants': cg, 'triggers': tg, 'indexes': ix, 'functions': fn}

def diff(a, b):
    out = []
    for k in a:
        if a[k] != b[k]:
            if isinstance(a[k], dict):
                for f in a[k]:
                    if a[k][f] != b[k].get(f):
                        out.append(f'{k} {f}: {a[k][f]} != {b[k].get(f)}')
            else:
                sa, sb = set(a[k].splitlines()), set(b[k].splitlines())
                out.append(f'{k}: missing {sorted(sa - sb)} extra {sorted(sb - sa)}')
    return '; '.join(out)

# ---------- Ops file 1
t.reset()
s0 = snapshot(OPS_A_TABLES, OPS_A_FUNCS)
o, e, r = t.apply('20260919a_OPS_fence_1_safe_now.sql')
expect('file A applies', r == 0, e[-800:])
s_after = snapshot(OPS_A_TABLES, OPS_A_FUNCS)
expect('file A really changed things (policies, functions)', s_after['policies'] != s0['policies'] and s_after['functions'] != s0['functions'])
o, e, r = t.apply_rollback('20260919a_OPS_fence_1_safe_now.sql')
expect('file A roll back runs', r == 0, e[-800:])
s1 = snapshot(OPS_A_TABLES, OPS_A_FUNCS)
d = diff(s0, s1)
expect('file A roll back puts back exactly the 18 Sep policies, grants, functions, triggers and indexes', not d, d)
gr, _, _ = run("select has_table_privilege('anon', 'public.user_profiles', 'INSERT') or has_table_privilege('anon', 'public.user_profiles', 'UPDATE') or has_table_privilege('anon', 'public.user_locations', 'INSERT') or has_table_privilege('anon', 'public.user_locations', 'DELETE')")
expect('file A roll back gives anon no write on user_profiles or user_locations (it never had one)', gr == 'f', gr)
o, e, r = t.apply_rollback('20260919a_OPS_fence_1_safe_now.sql')
expect('file A roll back runs a second time', r == 0, e[-800:])
d = diff(s0, snapshot(OPS_A_TABLES, OPS_A_FUNCS))
expect('and still leaves exactly the 18 Sep state', not d, d)
o, e, r = t.apply('20260919a_OPS_fence_1_safe_now.sql')
expect('file A can be applied again after its roll back', r == 0, e[-800:])

# ---------- Ops file 2
t.reset()
o, e, r = t.apply('20260919a_OPS_fence_1_safe_now.sql')
for who in ['dev1', 'dev3', 'dev4', 'dup', 'owner1']:
    as_commit(who, "select public.device_issue_secret();")
run("update public.devices set client_caps = array['fence_v1','device_secret'] where status in ('active','online') and bound_via is not null")
run(f"insert into public.payment_proofs (processor, payment_ref, kind, location_id, amount_minor, verified_by) values ('stripe', 'pi_rb_1', 'card', '{L1}', 1000, 'test')")
pid, _, _ = run("select id from public.payment_proofs where payment_ref = 'pi_rb_1'")
order = json.dumps({'ref': 'OL-RB', 'source': 'online', 'items': [{'name': 'Tea', 'price': 10, 'qty': 1}], 'total': 10, 'customer': {}})
as_commit('customer', f"select public.place_public_order('{L1}', '{order}'::jsonb, '{{\"id\":\"chk-rb\",\"total\":10}}'::jsonb, array['{pid}']::uuid[]);")
b0 = snapshot(OPS_B_TABLES)
o, e, r = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('file B applies', r == 0, e[-800:])
b_after = snapshot(OPS_B_TABLES)
expect('file B really changed the policies', b_after['policies'] != b0['policies'])
o, e, r = t.apply_rollback('20260919b_OPS_fence_2_after_app.sql')
expect('file B roll back runs', r == 0, e[-800:])
b1 = snapshot(OPS_B_TABLES, skip_triggers=('order_queue_qr_floor',))
b0x = dict(b0, triggers='\n'.join(l for l in b0['triggers'].splitlines() if l.split('|')[1] != 'order_queue_qr_floor'))
d = diff(b0x, b1)
expect('file B roll back puts back exactly the open policies and grants (the QR floor trigger stays, as it says)', not d, d)
o, _, _ = run("select count(*) from public.fence_state where key = 'file_b'")
expect('file B roll back clears its mark', o == '0', o)
o, e, r = t.apply_rollback('20260919b_OPS_fence_2_after_app.sql')
expect('file B roll back runs a second time', r == 0, e[-800:])
o, e, r = t.apply('20260919a_OPS_fence_1_safe_now.sql')
expect('after file B is rolled back, file A may run again', r == 0, e[-800:])
o, e, r = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('and file B can be applied again', r == 0, e[-800:])

# ---------- Platform files
testP.build_platform()
p0 = snapshot(PLAT_TABLES, db='plat')
o, e, r = testP.apply('20260919c_PLATFORM_fence_1_safe_now.sql')
expect('Platform file 1 applies', r == 0, e[-800:])
open(os.path.join(t.HERE, '.rbc.sql'), 'w').write(t.rollback_sql('20260919c_PLATFORM_fence_1_safe_now.sql'))
o, e, r = t.run_file(os.path.join(t.HERE, '.rbc.sql'), db='plat')
expect('Platform file 1 roll back runs', r == 0, (e or '')[-800:])
d = diff(p0, snapshot(PLAT_TABLES, db='plat'))
expect('Platform file 1 roll back puts back exactly the live policies and write grants', not d, d)
o, e, r = t.run_file(os.path.join(t.HERE, '.rbc.sql'), db='plat')
expect('Platform file 1 roll back runs a second time', r == 0, (e or '')[-800:])
os.remove(os.path.join(t.HERE, '.rbc.sql'))
o, e, r = testP.apply('20260919c_PLATFORM_fence_1_safe_now.sql')
p1 = snapshot(PLAT_TABLES, db='plat')
o, e, r = testP.apply('20260919d_PLATFORM_fence_2_after_app.sql')
expect('Platform file 2 applies', r == 0, e[-800:])
open(os.path.join(t.HERE, '.rbd.sql'), 'w').write(t.rollback_sql('20260919d_PLATFORM_fence_2_after_app.sql'))
o, e, r = t.run_file(os.path.join(t.HERE, '.rbd.sql'), db='plat')
expect('Platform file 2 roll back runs', r == 0, (e or '')[-800:])
d = diff(p1, snapshot(PLAT_TABLES, db='plat'))
expect('Platform file 2 roll back puts back exactly the state after file 1', not d, d)
o, e, r = t.run_file(os.path.join(t.HERE, '.rbd.sql'), db='plat')
expect('Platform file 2 roll back runs a second time', r == 0, (e or '')[-800:])
os.remove(os.path.join(t.HERE, '.rbd.sql'))

t.finish()
