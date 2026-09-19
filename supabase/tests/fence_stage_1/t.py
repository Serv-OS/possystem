#!/usr/bin/env python3
"""Tiny test driver for the LOCAL throwaway Postgres (127.0.0.1:55432). Never Supabase."""
import json, subprocess, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
PSQL = ['psql', '-h', os.environ.get('FENCE_PGHOST', '127.0.0.1'), '-p', os.environ.get('FENCE_PGPORT', '55432'), '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']
WT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
MIG = os.path.join(WT, 'supabase', 'migrations')

UID = {
    'owner1': '20000000-0000-4000-8000-000000000001',
    'manager1': '20000000-0000-4000-8000-000000000002',
    'owner2': '20000000-0000-4000-8000-000000000003',
    'super': '20000000-0000-4000-8000-000000000004',
    'newbie': '20000000-0000-4000-8000-000000000005',
    'staff1': '20000000-0000-4000-8000-000000000006',
    'dev1': '30000000-0000-4000-8000-000000000001',
    'dev2': '30000000-0000-4000-8000-000000000002',
    'dev3': '30000000-0000-4000-8000-000000000003',
    'dev4': '30000000-0000-4000-8000-000000000004',
    'dup': '30000000-0000-4000-8000-000000000005',
    'attacker': '30000000-0000-4000-8000-000000000009',
    'customer': '30000000-0000-4000-8000-00000000000a',
    'newtill': '30000000-0000-4000-8000-00000000000b',
    'dev1b': '30000000-0000-4000-8000-00000000000c',
}
SID = {'dev1b': '50000000-0000-4000-8000-00000000000c', 'attacker': '50000000-0000-4000-8000-000000000009',
       'dev1': '50000000-0000-4000-8000-000000000001'}
ANON = {'dev1', 'dev2', 'dev3', 'dev4', 'dup', 'attacker', 'customer', 'newtill', 'dev1b'}
L1 = '10000000-0000-4000-8000-000000000001'
L2 = '10000000-0000-4000-8000-000000000002'
L3 = '10000000-0000-4000-8000-000000000003'
L4 = '10000000-0000-4000-8000-000000000004'

def run(sql, db='ops', check=True):
    p = subprocess.run(PSQL + ['-d', db], input=sql, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(p.stderr.strip())
    return p.stdout.strip(), p.stderr.strip(), p.returncode

def reset():
    run('drop database if exists ops', db='postgres')
    run('create database ops', db='postgres')
    run(open(os.path.join(HERE, '.baseline.sql')).read())
    run(open(os.path.join(HERE, 'seed.sql')).read())

def apply(fname):
    return run(open(os.path.join(MIG, fname)).read(), check=False)

def claims(who):
    if who == 'rawanon':
        return json.dumps({'role': 'anon'})
    if who == 'service':
        return json.dumps({'role': 'service_role'})
    c = {'sub': UID[who], 'role': 'authenticated', 'is_anonymous': who in ANON}
    if who in SID:
        c['session_id'] = SID[who]
    return json.dumps(c)

def as_(who, sql):
    """Run sql as a PostgREST caller, in a transaction that is always rolled back."""
    role = 'anon' if who == 'rawanon' else ('service_role' if who == 'service' else 'authenticated')
    c = claims(who).replace("'", "''")
    body = f"begin;\nset local role {role};\nselect set_config('request.jwt.claims', '{c}', true);\n{sql}\nrollback;\n"
    out, err, rc = run(body, check=False)
    lines = [l for l in out.splitlines() if l != '' and not l.startswith('{') or l.startswith('{"')]
    return out, err, rc

def as_commit(who, sql):
    role = 'anon' if who == 'rawanon' else ('service_role' if who == 'service' else 'authenticated')
    c = claims(who).replace("'", "''")
    body = f"begin;\nset local role {role};\nselect set_config('request.jwt.claims', '{c}', true);\n{sql}\ncommit;\n"
    return run(body, check=False)

RESULTS = []
def expect(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (('  | ' + detail) if (detail and not cond) else ''))

def last(out):
    """last non empty line of output (psql prints set_config result first)."""
    ls = [l for l in out.splitlines() if l.strip() != '']
    return ls[-1] if ls else ''
