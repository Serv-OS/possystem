#!/usr/bin/env python3
"""Every ROLL BACK block, run for real on the local throwaway copy the way Peter runs it:
the WHOLE section from its heading to the end of the file, with each line's first "-- "
removed (select all, Cmd+/ in the SQL editor). Each one must put back exactly the policies,
grants, function grants (the full ACL, PUBLIC included), functions, triggers and indexes its
file changed (TRUNCATE, REFERENCES and TRIGGER grants excepted, on purpose), must run twice,
and must refuse, changing nothing, while the file that came after it is still in."""
import json, os, re
import t
from t import as_commit, expect, last, run, L1
import testP

OPS_A_TABLES = ['devices', 'organisations', 'locations', 'user_profiles', 'user_locations', 'order_queue', 'closed_checks',
                'discount_rules', 'stamp_transactions']
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
                                 (select string_agg(x::text, ',' order by x::text) from unnest(coalesce(proacl, acldefault('f', proowner))) x)
                            from pg_proc where oid = 'public.{f}'::regprocedure""", db=db)
        parts = o.split('|')
        fn[f] = (norm('|'.join(parts[:-4])),) + tuple(parts[-4:])
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

# ---------- every roll back section is paste able as it stands
for f in (t.FILE_A, t.FILE_B, t.FILE_C, t.FILE_D):
    block = t.rollback_block(f)
    prose = [l for l in block if l.startswith('-- -- ')]
    expect(f'{f}: the whole ROLL BACK section is comment lines, its notes double commented (one Cmd+/ leaves them notes)',
           all(l.startswith('--') for l in block if l.strip()) and len(prose) >= 3 and block[0].startswith('-- -- ===='), block[0])

# ---------- Ops file 1
t.reset()
s0 = snapshot(OPS_A_TABLES, OPS_A_FUNCS)
o, _, _ = run("select string_agg(x::text, ',' order by x::text) from unnest((select proacl from pg_proc where oid = 'public.pos_can_access(text)'::regprocedure)) x")
expect('the copy starts with the live function grants (PUBLIC may run pos_can_access)', o.startswith('=X/postgres,'), o)
o, e, r = t.apply(t.FILE_A)
expect('file A applies', r == 0, e[-800:])
s_after = snapshot(OPS_A_TABLES, OPS_A_FUNCS)
expect('file A really changed things (policies, functions, function grants)', s_after['policies'] != s0['policies'] and s_after['functions'] != s0['functions'])
o, e, r = t.apply_rollback(t.FILE_A)
expect('file A roll back runs (the whole pasted section, notes included)', r == 0, e[-800:])
s1 = snapshot(OPS_A_TABLES, OPS_A_FUNCS)
d = diff(s0, s1)
expect('file A roll back puts back exactly the 18 Sep policies, grants, function grants (PUBLIC too), functions, triggers and indexes', not d, d)
gr, _, _ = run("select has_table_privilege('anon', 'public.user_profiles', 'INSERT') or has_table_privilege('anon', 'public.user_profiles', 'UPDATE') or has_table_privilege('anon', 'public.user_locations', 'INSERT') or has_table_privilege('anon', 'public.user_locations', 'DELETE')")
expect('file A roll back gives anon no write on user_profiles or user_locations (it never had one)', gr == 'f', gr)
o, _, _ = run("select count(*) from public.fence_state where key = 'file_a'")
expect('file A roll back clears when file A ran (file 2 counts a new day from the next run)', o == '0', o)
o, e, r = t.apply_rollback(t.FILE_A)
expect('file A roll back runs a second time', r == 0, e[-800:])
d = diff(s0, snapshot(OPS_A_TABLES, OPS_A_FUNCS))
expect('and still leaves exactly the 18 Sep state', not d, d)
o, e, r = t.apply(t.FILE_A)
expect('file A can be applied again after its roll back', r == 0, e[-800:])
o, _, _ = run("select set_at > now() - interval '1 minute' from public.fence_state where key = 'file_a'")
expect('and records a fresh time', o == 't', o)

# ---------- Ops file 2, and the order of the roll backs
t.reset()
o, e, r = t.apply(t.FILE_A)
t.age_file_a(25)
for who in ['dev1', 'dev3', 'dev4', 'dup', 'owner1']:
    as_commit(who, "select public.device_issue_secret();")
run("update public.devices set client_caps = array['fence_v1','device_secret'] where status in ('active','online') and bound_via is not null")
run(f"insert into public.payment_proofs (processor, payment_ref, kind, location_id, amount_minor, verified_by, meta) values ('stripe', 'pi_rb_1', 'card', '{L1}', 1000, 'test', '{{\"order_ref\": \"OL-RB\"}}')")
pid, _, _ = run("select id from public.payment_proofs where payment_ref = 'pi_rb_1'")
order = json.dumps({'ref': 'OL-RB', 'source': 'online', 'items': [{'itemId': 'mi-tea', 'name': 'Tea', 'price': 10, 'qty': 1}], 'total': 10, 'customer': {}})
o, e, r = as_commit('customer', f"select public.place_public_order('{L1}', '{order}'::jsonb, '{{\"id\":\"chk-OL-RB-1\",\"total\":10}}'::jsonb, array['{pid}']::uuid[]);")
expect('a paid test order goes through the new function', '"paid": true' in o, o + e)
b0 = snapshot(OPS_B_TABLES)
a_state = snapshot(OPS_A_TABLES, OPS_A_FUNCS)
o, e, r = t.apply(t.FILE_B)
expect('file B applies', r == 0, e[-800:])
b_after = snapshot(OPS_B_TABLES)
expect('file B really changed the policies', b_after['policies'] != b0['policies'])
a_with_b = snapshot(OPS_A_TABLES, OPS_A_FUNCS)
o, e, r = t.apply_rollback(t.FILE_A)
expect('MEDIUM: file A roll back refuses while file B is in, and says to roll back file 2 first',
       r != 0 and 'Roll back file 2 first' in e and 'NOTHING WAS CHANGED' in e, e[-600:])
d = diff(a_with_b, snapshot(OPS_A_TABLES, OPS_A_FUNCS))
expect('and changes nothing', not d, d)
o, e, r = t.apply_rollback(t.FILE_B)
expect('file B roll back runs', r == 0, e[-800:])
b1 = snapshot(OPS_B_TABLES, skip_triggers=('order_queue_qr_floor',))
b0x = dict(b0, triggers='\n'.join(l for l in b0['triggers'].splitlines() if l.split('|')[1] != 'order_queue_qr_floor'))
d = diff(b0x, b1)
expect('file B roll back puts back exactly the open policies and grants (the QR floor trigger stays, as it says)', not d, d)
o, _, _ = run("select count(*) from public.fence_state where key = 'file_b'")
expect('file B roll back clears its mark', o == '0', o)
o, e, r = t.apply_rollback(t.FILE_B)
expect('file B roll back runs a second time', r == 0, e[-800:])
o, e, r = t.apply_rollback(t.FILE_A)
expect('with file B rolled back, file A roll back runs', r == 0, e[-800:])
o, e, r = t.apply(t.FILE_A)
expect('after both roll backs, file A may run again', r == 0, e[-800:])
t.age_file_a(25)
o, e, r = t.apply(t.FILE_B)
expect('and file B can be applied again a day later', r == 0, e[-800:])

# the roll back pair returns the database to the 18 Sep state for file A's tables too
t.reset()
s0 = snapshot(OPS_A_TABLES, OPS_A_FUNCS)
t.apply(t.FILE_A)
t.age_file_a(25)
for who in ['dev1', 'dev3', 'dev4', 'dup', 'owner1']:
    as_commit(who, "select public.device_issue_secret();")
run("update public.devices set client_caps = array['fence_v1','device_secret'] where status in ('active','online') and bound_via is not null")
as_commit('customer', f"select public.place_public_order('{L1}', '{order}'::jsonb, null, '{{}}'::uuid[]);")
o, e, r = t.apply(t.FILE_B)
t.apply_rollback(t.FILE_B)
o, e, r = t.apply_rollback(t.FILE_A)
d = diff(s0, snapshot(OPS_A_TABLES, OPS_A_FUNCS, skip_triggers=('order_queue_qr_floor',)))
expect('B then A roll back leaves file A\'s tables and functions exactly as on 18 Sep (only the QR floor trigger stays, as file B says)',
       r == 0 and not d, d or e[-500:])

# ---------- Platform files
testP.build_platform()
p0 = snapshot(PLAT_TABLES, db='plat')
o, e, r = testP.apply(t.FILE_C)
expect('Platform file 1 applies', r == 0, e[-800:])
open(os.path.join(t.HERE, '.rbc.sql'), 'w').write(t.rollback_sql(t.FILE_C))
o, e, r = t.run_file(os.path.join(t.HERE, '.rbc.sql'), db='plat')
expect('Platform file 1 roll back runs', r == 0, (e or '')[-800:])
d = diff(p0, snapshot(PLAT_TABLES, db='plat'))
expect('Platform file 1 roll back puts back exactly the live policies and write grants', not d, d)
o, e, r = t.run_file(os.path.join(t.HERE, '.rbc.sql'), db='plat')
expect('Platform file 1 roll back runs a second time', r == 0, (e or '')[-800:])
o, e, r = testP.apply(t.FILE_C)
p1 = snapshot(PLAT_TABLES, db='plat')
o, e, r = testP.apply(t.FILE_D)
expect('Platform file 2 applies', r == 0, e[-800:])
pd = snapshot(PLAT_TABLES, db='plat')
o, e, r = t.run_file(os.path.join(t.HERE, '.rbc.sql'), db='plat')
expect('Platform file 1 roll back refuses while Platform file 2 is in, and says to roll back file 2 first',
       r != 0 and 'Roll back file 2 first' in (e or ''), (e or '')[-600:])
d = diff(pd, snapshot(PLAT_TABLES, db='plat'))
expect('and changes nothing', not d, d)
os.remove(os.path.join(t.HERE, '.rbc.sql'))
open(os.path.join(t.HERE, '.rbd.sql'), 'w').write(t.rollback_sql(t.FILE_D))
o, e, r = t.run_file(os.path.join(t.HERE, '.rbd.sql'), db='plat')
expect('Platform file 2 roll back runs', r == 0, (e or '')[-800:])
d = diff(p1, snapshot(PLAT_TABLES, db='plat'))
expect('Platform file 2 roll back puts back exactly the state after file 1', not d, d)
o, e, r = t.run_file(os.path.join(t.HERE, '.rbd.sql'), db='plat')
expect('Platform file 2 roll back runs a second time', r == 0, (e or '')[-800:])
os.remove(os.path.join(t.HERE, '.rbd.sql'))
open(os.path.join(t.HERE, '.rbc.sql'), 'w').write(t.rollback_sql(t.FILE_C))
o, e, r = t.run_file(os.path.join(t.HERE, '.rbc.sql'), db='plat')
d = diff(p0, snapshot(PLAT_TABLES, db='plat'))
expect('then Platform file 1 roll back puts back the live state', r == 0 and not d, d or (e or '')[-500:])
os.remove(os.path.join(t.HERE, '.rbc.sql'))

t.finish()
