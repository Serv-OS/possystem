#!/usr/bin/env python3
"""Tiny test driver for the LOCAL throwaway Postgres (127.0.0.1:55432 unless FENCE_PGHOST /
FENCE_PGPORT say otherwise). Never Supabase."""
import json, subprocess, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
PSQL = ['psql', '-h', os.environ.get('FENCE_PGHOST', '127.0.0.1'), '-p', os.environ.get('FENCE_PGPORT', '55432'), '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']
WT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
MIG = os.path.join(WT, 'supabase', 'migrations')

# The stage 1 files. Fix round 2 made the names match their headers (A and C wait for the app
# release); the 20 Sep split cut file A in half, so Peter can run the identity and device half
# on its own and the payment half when it is ready. a1 goes in first; a2 refuses without it.
FILE_A1 = '20260919a1_OPS_fence_identity_devices.sql'
FILE_A2 = '20260919a2_OPS_fence_public_orders.sql'
FILE_B = '20260919b_OPS_fence_2_after_app.sql'
FILE_C = '20260919c_PLATFORM_fence_1_after_release.sql'
FILE_D = '20260919d_PLATFORM_fence_2_after_app.sql'

UID = {
    'owner1': '20000000-0000-4000-8000-000000000001',
    'manager1': '20000000-0000-4000-8000-000000000002',
    'owner2': '20000000-0000-4000-8000-000000000003',
    'super': '20000000-0000-4000-8000-000000000004',
    'newbie': '20000000-0000-4000-8000-000000000005',
    'staff1': '20000000-0000-4000-8000-000000000006',
    'mallory': '20000000-0000-4000-8000-000000000007',
    'dev1': '30000000-0000-4000-8000-000000000001',
    'dev2': '30000000-0000-4000-8000-000000000002',
    'dev3': '30000000-0000-4000-8000-000000000003',
    'dev4': '30000000-0000-4000-8000-000000000004',
    'dup': '30000000-0000-4000-8000-000000000005',
    'attacker': '30000000-0000-4000-8000-000000000009',
    'customer': '30000000-0000-4000-8000-00000000000a',
    'newtill': '30000000-0000-4000-8000-00000000000b',
    'dev1b': '30000000-0000-4000-8000-00000000000c',
    'joiner': '30000000-0000-4000-8000-00000000000d',
    'stranger': '30000000-0000-4000-8000-00000000000e',
}
SID = {'dev1b': '50000000-0000-4000-8000-00000000000c', 'attacker': '50000000-0000-4000-8000-000000000009',
       'dev1': '50000000-0000-4000-8000-000000000001'}
ANON = {'dev1', 'dev2', 'dev3', 'dev4', 'dup', 'attacker', 'customer', 'newtill', 'dev1b', 'joiner', 'stranger'}
L1 = '10000000-0000-4000-8000-000000000001'
L2 = '10000000-0000-4000-8000-000000000002'
L3 = '10000000-0000-4000-8000-000000000003'
L4 = '10000000-0000-4000-8000-000000000004'

def run(sql, db='ops', check=True):
    p = subprocess.run(PSQL + ['-d', db], input=sql, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(p.stderr.strip())
    return p.stdout.strip(), p.stderr.strip(), p.returncode

def run_file(path, db='ops'):
    """Run a whole file as ONE transaction, the way the Supabase SQL editor runs a paste."""
    p = subprocess.run(PSQL + ['-d', db, '-1', '-f', path], capture_output=True, text=True)
    return p.stdout.strip(), p.stderr.strip(), p.returncode

def reset():
    run('drop database if exists ops', db='postgres')
    run('create database ops', db='postgres')
    run(open(os.path.join(HERE, '.baseline.sql')).read())
    run(open(os.path.join(HERE, 'seed.sql')).read())

def age_file_a(hours=25):
    """Pretend file A first ran this many hours ago (file B waits a full day after it)."""
    run(f"update public.fence_state set set_at = now() - interval '{int(hours)} hours' where key = 'file_a'")

def apply(fname, db='ops'):
    return run_file(os.path.join(MIG, fname), db=db)

def apply_a(db='ops'):
    """Both halves of the old file A, in the order the runbooks give them: a1 (runbook one,
    identity, venues and devices), then a2 (runbook two, the payment half). Stops at the first
    one that fails and hands back its result."""
    o, e, r = apply(FILE_A1, db=db)
    if r != 0:
        return o, e, r
    return apply(FILE_A2, db=db)

def rollback_a(db='ops'):
    """And out in the other order: the payment half first, then identity and devices."""
    o, e, r = apply_rollback(FILE_A2, db=db)
    if r != 0:
        return o, e, r
    return apply_rollback(FILE_A1, db=db)

def rollback_block(fname):
    """The ROLL BACK section exactly as Peter copies it: from the "-- -- ====" rule line
    just above its heading to the very end of the file."""
    lines = open(os.path.join(MIG, fname)).read().rstrip('\n').split('\n')
    heads = [i for i, l in enumerate(lines) if l.lstrip('- ').upper().startswith('ROLL BACK')]
    if not heads:
        raise RuntimeError('no roll back block in ' + fname)
    h = heads[-1]
    s = h - 1 if lines[h - 1].lstrip('- ').startswith('====') else h
    return lines[s:]

def rollback_sql(fname):
    """What the SQL editor runs after the pasted block is uncommented once (select all,
    Cmd+/): every line loses its first "-- " (a bare "--" line becomes empty). Fix round 2:
    the WHOLE section is run, prose included, so a note that is not a comment fails here
    just as it would in the editor."""
    block = rollback_block(fname)
    bad = [l for l in block if l.strip() and not l.startswith('--')]
    if bad:
        raise RuntimeError(f'{fname}: a roll back line is not a comment, the editor toggle would not work: {bad[0]}')
    out = []
    for l in block:
        if l.startswith('-- '):
            out.append(l[3:])
        elif l.startswith('--'):
            out.append(l[2:])
        else:
            out.append(l)
    return '\n'.join(out) + '\n'

def apply_rollback(fname, db='ops'):
    path = os.path.join(HERE, '.rollback_' + fname)
    open(path, 'w').write(rollback_sql(fname))
    try:
        return run_file(path, db=db)
    finally:
        os.remove(path)

def claims(who):
    if who == 'rawanon':
        return json.dumps({'role': 'anon'})
    if who == 'service':
        return json.dumps({'role': 'service_role'})
    c = {'sub': UID[who], 'role': 'authenticated', 'is_anonymous': who in ANON}
    if who in SID:
        c['session_id'] = SID[who]
    return json.dumps(c)

def _body(who, sql, ip, end):
    role = 'anon' if who == 'rawanon' else ('service_role' if who == 'service' else 'authenticated')
    c = claims(who).replace("'", "''")
    h = json.dumps({'cf-connecting-ip': ip} if ip else {}).replace("'", "''")
    return (f"begin;\nset local role {role};\nselect set_config('request.jwt.claims', '{c}', true);\n"
            f"select set_config('request.headers', '{h}', true);\n{sql}\n{end};\n")

def as_(who, sql, ip=None):
    """Run sql as a PostgREST caller, in a transaction that is always rolled back."""
    return run(_body(who, sql, ip, 'rollback'), check=False)

def as_commit(who, sql, ip=None):
    return run(_body(who, sql, ip, 'commit'), check=False)

RESULTS = []
def expect(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (('  | ' + detail) if (detail and not cond) else ''))

def last(out):
    """last non empty line of output (psql prints set_config results first)."""
    ls = [l for l in out.splitlines() if l.strip() != '']
    return ls[-1] if ls else ''

def finish():
    fails = [n for n, ok, d in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(fails)} passed, {len(fails)} failed")
    sys.exit(1 if fails else 0)
