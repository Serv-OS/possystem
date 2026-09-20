#!/usr/bin/env python3
"""20260919s_OPS_second_step.sql on a LOCAL, throwaway Postgres 17. Never Supabase.

The same method as the database fence harness (supabase/tests/fence_stage_1): a copy of the
shape the live Ops database has (the Supabase roles, the auth tables the file reads, the public
tables the fence loop walks), the file pasted as ONE transaction the way the SQL editor runs it,
then every rule checked as the roles PostgREST really uses.

What it proves:
  * the file applies, twice, and its self test passes;
  * who is refused and who is never refused, with the switch off and on;
  * THE STAFF APP is never refused and is not counted (it signs in at aal1 by design);
  * a FIRST second step cannot be set up with only a password: the MFA verification attempt
    hook rejects it until the person proves they hold the account email, while adding a SECOND
    factor and signing in are untouched;
  * the switch on count and the lock out of logins that never set up;
  * Peter's break glass and his own recovery (clear his factors, make a second super admin);
  * the roll back puts the database back and leaves nothing that can break PostgREST.

Run:
  initdb -D /tmp/ssdata -U postgres --auth=trust -E UTF8
  pg_ctl -D /tmp/ssdata -o "-p 55988 -c listen_addresses=127.0.0.1" start
  python3 test_second_step.py          # SS_PGHOST / SS_PGPORT override the address
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
MIG = os.path.join(ROOT, 'supabase', 'migrations', '20260919s_OPS_second_step.sql')
PK_MIG = os.path.join(ROOT, 'supabase', 'migrations', '20260920p_OPS_passkey_second_step.sql')
PSQL = ['psql', '-h', os.environ.get('SS_PGHOST', '127.0.0.1'), '-p', os.environ.get('SS_PGPORT', '55988'),
        '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']

U_PETER  = '10000000-0000-4000-8000-000000000001'   # super admin, the only one
U_OWNER  = '10000000-0000-4000-8000-000000000002'   # owner of Acme, dormant, no second step
U_MGR    = '10000000-0000-4000-8000-000000000003'   # manager with a venue link and a factor
U_STAFF  = '10000000-0000-4000-8000-000000000004'   # staff app only (wf_staff.portal_user_id)
U_TILL   = '10000000-0000-4000-8000-000000000005'   # anonymous till session
L1       = '20000000-0000-4000-8000-000000000001'

RESULTS = []


def run(sql, db='ops', check=True):
    p = subprocess.run(PSQL + ['-d', db], input=sql, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(p.stderr.strip())
    return p.stdout.strip(), p.stderr.strip(), p.returncode


def run_file(path, db='ops', one_tx=True):
    args = PSQL + ['-d', db] + (['-1'] if one_tx else []) + ['-f', path]
    p = subprocess.run(args, capture_output=True, text=True)
    return p.stdout.strip(), p.stderr.strip(), p.returncode


def expect(name, cond, detail=''):
    RESULTS.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + (('  | ' + str(detail)) if (detail and not cond) else ''))


def claims(sub=None, anon=False, aal='aal1', role='authenticated'):
    c = {'role': role}
    if sub:
        c['sub'] = sub
        c['is_anonymous'] = anon
        c['aal'] = aal
    return json.dumps(c).replace("'", "''")


def as_(role, sub_claims, sql):
    """One statement as a PostgREST caller, always rolled back."""
    return run(f"begin;\nset local role {role};\nselect set_config('request.jwt.claims', '{sub_claims}', true);\n{sql}\nrollback;\n", check=False)


def last(out):
    ls = [l for l in out.splitlines() if l.strip() != '']
    return ls[-1] if ls else ''


def reset():
    run('drop database if exists ops', db='postgres')
    run('create database ops', db='postgres')
    run(open(os.path.join(HERE, 'baseline.sql')).read())
    run(open(os.path.join(HERE, 'seed.sql')).read())


# ── the file itself ──────────────────────────────────────────────────────────
reset()
out, err, rc = run_file(MIG)
expect('the file applies as one paste', rc == 0, err[-1200:])
expect('its self test ran (the fence loop reported)', 'second_step_fence' in err, err[-300:])
out2, err2, rc2 = run_file(MIG)
expect('it applies a second time (idempotent)', rc2 == 0, err2[-1200:])

o, _, _ = run("select enforce, app_gate, first_factor_needs_email from public.second_step_settings")
expect('the switch starts OFF, the app gate on, the email step on', o == 'f|t|t', o)
o, _, _ = run("select count(*) from pg_policy where polname = 'second_step_fence'")
expect('every table with row level security is fenced, storage too', int(o) >= 10, o)
o, _, _ = run("select unnest(rolconfig) from pg_roles where rolname = 'authenticator'")
expect('the Data API check is switched on', 'pgrst.db_pre_request=public.second_step_check_request' in o, o)

# ── who is refused, and who never is ─────────────────────────────────────────
def ok_for(c):
    o, e, r = as_('authenticated', c, 'select public.second_step_ok();')
    return last(o)

run("update public.second_step_settings set enforce = false where id")
expect('switch OFF: a password only login passes', ok_for(claims(U_OWNER)) == 't')
run("update public.second_step_settings set enforce = true where id")
expect('switch ON: a password only Back Office login is refused', ok_for(claims(U_OWNER)) == 'f')
expect('switch ON: the same login after its second step passes', ok_for(claims(U_OWNER, aal='aal2')) == 't')
expect('switch ON: an anonymous till is never refused', ok_for(claims(U_TILL, anon=True)) == 't')
o, e, r = as_('anon', claims(role='anon'), 'select public.second_step_ok();')
expect('switch ON: the bare public key is never refused', last(o) == 't', o + e)
o, e, r = as_('service_role', claims(role='service_role'), 'select public.second_step_ok();')
expect('switch ON: the service role is never refused', last(o) == 't', o + e)
expect('THE STAFF APP: aal1 and never refused (it is out of scope)', ok_for(claims(U_STAFF)) == 't')

o, e, r = as_('authenticated', claims(U_OWNER), 'select public.second_step_check_request();')
expect('the Data API check refuses that login with a plain message',
       r != 0 and 'second_step_required' in (e or ''), (e or '')[-200:])
o, e, r = as_('authenticated', claims(U_STAFF), 'select public.second_step_check_request();')
expect('and lets the staff app through', r == 0, (e or '')[-200:])
# The table fence is RESTRICTIVE: a read sees nothing and a write is refused outright. (The
# Data API check above is what raises on every request; this is the belt and braces that also
# covers Realtime and Storage, which do not run the pre-request check.)
o, e, r = as_('authenticated', claims(U_OWNER), "select count(*) from public.menu_items;")
expect('the table fence shows that login NOTHING', last(o) == '0', (o + e)[-160:])
o, e, r = as_('authenticated', claims(U_OWNER), "insert into public.menu_items (id, location_id, name) values ('mi-x', '" + L1 + "', 'X');")
expect('and refuses its writes', r != 0, (e or '')[-160:])
o, e, r = as_('authenticated', claims(U_TILL, anon=True), "select count(*) from public.menu_items;")
expect('and never the till', r == 0 and last(o) == '1', (o + e)[-160:])

# ── reach ────────────────────────────────────────────────────────────────────
for who, want in [(U_PETER, 'back_office'), (U_OWNER, 'back_office'), (U_MGR, 'back_office'),
                  (U_STAFF, 'staff_app')]:
    o, _, _ = run(f"select public.second_step_reach('{who}')")
    expect(f'reach of {who[-1]} is {want}', o == want, o)
o, _, _ = run("select public.second_step_reach(null)")
expect('reach of nobody is none', o == 'none', o)

# ── THE BLOCKER: a stolen password cannot set up the thief's own second step ─
run("update public.second_step_settings set first_factor_needs_email = true where id")
def hook(user, factor=None, valid=True):
    ev = {'user_id': user, 'valid': valid}
    if factor:
        ev['factor_id'] = factor
    o, _, _ = run("select public.second_step_mfa_hook('" + json.dumps(ev).replace("'", "''") + "'::jsonb)")
    return json.loads(o)

r = hook(U_OWNER, factor='30000000-0000-4000-8000-000000000001')
expect('a dormant login with a stolen password cannot verify its FIRST factor', r.get('decision') == 'reject', r)
expect('and is told, in plain words, to get the code from its email',
       'code' in (r.get('message') or '').lower() and 'email' in (r.get('message') or '').lower(), r)

# the person proves the email (second-step-invite writes this row), then it goes through
run(f"""insert into public.second_step_enrolment_proof (user_id, code_hash, sent_to, expires_at, proved_at)
        values ('{U_OWNER}', 'x', 'owner@acme.test', now() + interval '1 hour', now())
        on conflict (user_id) do update set proved_at = now(), used_at = null, expires_at = now() + interval '1 hour'""")
r = hook(U_OWNER, factor='30000000-0000-4000-8000-000000000001')
expect('with the emailed code typed in, the same first factor is accepted', r.get('decision') == 'continue', r)
run(f"update public.second_step_enrolment_proof set used_at = now() where user_id = '{U_OWNER}'")
r = hook(U_OWNER, factor='30000000-0000-4000-8000-000000000001')
expect('and that proof is single use: the next first factor is refused again', r.get('decision') == 'reject', r)
run(f"update public.second_step_enrolment_proof set used_at = null, expires_at = now() - interval '1 minute' where user_id = '{U_OWNER}'")
r = hook(U_OWNER)
expect('an expired proof is no proof', r.get('decision') == 'reject', r)

# the manager already holds a factor: adding a second one, and signing in, are untouched
r = hook(U_MGR, factor='30000000-0000-4000-8000-000000000099')
expect('ADDING Face ID when you already hold the app needs no new code', r.get('decision') == 'continue', r)
r = hook(U_MGR, factor='30000000-0000-4000-8000-000000000002')
expect('and SIGNING IN with the factor you hold is never touched', r.get('decision') == 'continue', r)
r = hook(U_OWNER, valid=False)
expect('a wrong code is left to the auth server to answer', r.get('decision') == 'continue', r)
r = hook(None)
expect('an event it cannot read is never turned into a refusal', r.get('decision') == 'continue', r)
run("update public.second_step_settings set first_factor_needs_email = false where id")
r = hook(U_OWNER)
expect('Peter can switch the email step off if it gets in the way', r.get('decision') == 'continue', r)
run("update public.second_step_settings set first_factor_needs_email = true where id")

o, _, _ = run("select has_function_privilege('supabase_auth_admin', 'public.second_step_mfa_hook(jsonb)', 'execute'),"
              " has_function_privilege('authenticated', 'public.second_step_mfa_hook(jsonb)', 'execute')")
expect('only the auth server may call the hook', o == 't|f', o)
o, e, r = as_('authenticated', claims(U_OWNER, aal='aal2'), "select count(*) from public.second_step_enrolment_proof;")
expect('a signed in login cannot read the proofs table', r != 0, (e or '')[-120:])

# ── the switch on count, and the lock out ────────────────────────────────────
COUNT = """select
  count(*) filter (where reach = 'back_office') as bo,
  count(*) filter (where reach = 'staff_app') as staff,
  count(*) filter (where reach = 'back_office' and not has_step and not banned) as bo_without
from (select u.id, public.second_step_reach(u.id) as reach,
             exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified') as has_step,
             coalesce(u.banned_until > now(), false) as banned
        from auth.users u where not u.is_anonymous) p"""
o, _, _ = run(COUNT)
expect('the count sees 3 Back Office logins, 1 staff app, 2 still to set up', o == '3|1|2', o)
run("""update auth.users u set banned_until = 'infinity'
        where not u.is_anonymous and public.second_step_reach(u.id) = 'back_office'
          and not exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified')""")
o, _, _ = run(COUNT)
expect('the lock out step takes it to zero, so enforcement can go on', o.endswith('|0'), o)
o, _, _ = run(f"select coalesce(banned_until > now(), false) from auth.users where id = '{U_STAFF}'")
expect('and the staff app login is NOT locked out', o == 'f', o)
run(f"update auth.users set banned_until = null where id = '{U_OWNER}'")
o, _, _ = run(f"select coalesce(banned_until > now(), false) from auth.users where id = '{U_OWNER}'")
expect('one can be let back in on its own (the invite line)', o == 'f', o)

# ── Peter cannot lock himself out ────────────────────────────────────────────
run(f"insert into auth.mfa_factors (id, user_id, status, factor_type) values ('30000000-0000-4000-8000-0000000000aa', '{U_PETER}', 'verified', 'totp')")
run("update public.second_step_settings set enforce = true where id")
expect('with enforcement on, Peter at aal1 is refused like anyone else', ok_for(claims(U_PETER)) == 'f')
run("update public.second_step_settings set enforce = false, app_gate = false where id")
expect('BREAK GLASS 1: the switch lets him straight back in, no phone needed', ok_for(claims(U_PETER)) == 't')
o, _, _ = run("select enforce, app_gate from public.second_step_settings")
expect('and the app stops asking too (app_gate false)', o == 'f|f', o)
run(f"delete from auth.mfa_factors where user_id = '{U_PETER}'")
o, _, _ = run(f"select count(*) from auth.mfa_factors where user_id = '{U_PETER}'")
expect('BREAK GLASS 2: his lost phone factor can be cleared from the SQL editor', o == '0', o)
run(f"""insert into auth.users (id, email, is_anonymous) values ('10000000-0000-4000-8000-000000000009', 'second.admin@servos.test', false)
        on conflict (id) do nothing;
        insert into public.user_profiles (id, email, role) values ('10000000-0000-4000-8000-000000000009', 'second.admin@servos.test', 'super_admin')
        on conflict (id) do update set role = 'super_admin';""")
o, _, _ = run("select count(*) from public.user_profiles where role = 'super_admin'")
expect('BREAK GLASS 3: a second super admin can be made in one line', o == '2', o)
o, _, _ = run("select public.second_step_reach('10000000-0000-4000-8000-000000000009')")
expect('and the new super admin counts as a Back Office login', o == 'back_office', o)
run("update public.second_step_settings set enforce = true, app_gate = true where id")

# ── PASSKEYS: 20260920p on top of the live file ──────────────────────────────
# Peter, 20 Sep 2026: "I just want it more secure I hate multi factor auth apps, this is what
# toast does I want this". A passkey sign in is a FIRST factor, so the session is aal1, so the
# aal2 rule on its own would lock out every single person the day they switch to passkeys. This
# section proves the passkey file fixes exactly that and nothing else.
S_PASS = '50000000-0000-4000-8000-00000000000a'     # a session that signed in with a passkey
S_PW   = '50000000-0000-4000-8000-00000000000b'     # a session that signed in with a password

out, err, rc = run_file(PK_MIG)
expect('PASSKEYS: the file applies as one paste, on top of the live one', rc == 0, err[-1200:])
out2, err2, rc2 = run_file(PK_MIG)
expect('PASSKEYS: it applies a second time (idempotent)', rc2 == 0, err2[-1200:])
# Running it again puts right anything that has drifted: a stray grant on the passkey record
# is taken away, and the self test at the end of the file would abort the whole paste if it
# could not be. (Every statement is in one transaction, so a failed apply changes nothing.)
run("grant select on table public.second_step_passkeys to authenticated")
_, err3, rc3 = run_file(PK_MIG)
expect('PASSKEYS: applying it again takes back a stray grant on the passkey record', rc3 == 0, (err3 or '')[-600:])
o, _, _ = run("select has_table_privilege('authenticated', 'public.second_step_passkeys', 'select')")
expect('PASSKEYS: so a signed in login can never read who holds which passkey', o == 'f', o)

o, _, _ = run("select passkey_methods from public.second_step_settings")
expect('PASSKEYS: the method names are a setting, not a guess in the code',
       o == '{webauthn,passkey,webauthn_credential}', o)

# The pure rule, every branch.
o, _, _ = run("select public.second_step_decide('{\"role\":\"authenticated\",\"sub\":\"x\",\"aal\":\"aal1\"}'::jsonb, true, true)")
expect('PASSKEYS: a passkey session passes with enforcement ON, at aal1', o == 't', o)
o, _, _ = run("select public.second_step_decide('{\"role\":\"authenticated\",\"sub\":\"x\",\"aal\":\"aal1\"}'::jsonb, true, false)")
expect('PASSKEYS: a password only session is still refused', o == 'f', o)
o, _, _ = run("select public.second_step_decide('{\"role\":\"authenticated\",\"sub\":\"x\",\"aal\":\"aal1\"}'::jsonb, true)")
expect('PASSKEYS: the old two argument call still means "no passkey"', o == 'f', o)

# The proof itself: the session, not anything the app says about itself.
run(f"""insert into auth.mfa_amr_claims (session_id, authentication_method) values
        ('{S_PASS}', 'password'), ('{S_PASS}', 'webauthn'), ('{S_PW}', 'password')""")
def claims_session(sub, session, amr=None, aal='aal1'):
    c = {'role': 'authenticated', 'sub': sub, 'is_anonymous': False, 'aal': aal, 'session_id': session}
    if amr:
        c['amr'] = amr
    return json.dumps(c).replace("'", "''")

expect('PASSKEYS: a passkey sign in passes, enforcement ON, no authenticator app anywhere',
       ok_for(claims_session(U_OWNER, S_PASS)) == 't')
expect('PASSKEYS: the same login on a password only session is still refused',
       ok_for(claims_session(U_OWNER, S_PW)) == 'f')
expect('PASSKEYS: a made up session id proves nothing',
       ok_for(claims_session(U_OWNER, '50000000-0000-4000-8000-0000000000ff')) == 'f')
expect('PASSKEYS: a token that carries its own amr is enough (no table read needed)',
       ok_for(claims_session(U_OWNER, '50000000-0000-4000-8000-0000000000ff',
                             amr=[{'method': 'password'}, {'method': 'webauthn'}])) == 't')
expect('PASSKEYS: an amr of ordinary methods is NOT a passkey',
       ok_for(claims_session(U_OWNER, S_PW, amr=[{'method': 'password'}, {'method': 'otp'}])) == 'f')
o, e, r = as_('authenticated', claims_session(U_OWNER, S_PASS), 'select count(*) from public.menu_items;')
expect('PASSKEYS: and the tables open up for that session', r == 0 and last(o) == '1', (o + e)[-160:])
expect('PASSKEYS: the staff app is still never refused', ok_for(claims(U_STAFF)) == 't')
expect('PASSKEYS: an anonymous till is still never refused', ok_for(claims(U_TILL, anon=True)) == 't')

# Who has finished: an authenticator app OR a passkey, so the lock out never takes a passkey user.
run(f"""insert into public.second_step_passkeys (user_id, credential_id, friendly_name)
        values ('{U_OWNER}', 'cred-owner-1', 'Mac') on conflict do nothing""")
o, _, _ = run(f"select public.second_step_has_second_step('{U_OWNER}')")
expect('PASSKEYS: a passkey counts as a finished second step', o == 't', o)
o, _, _ = run(f"select public.second_step_has_second_step('{U_MGR}')")
expect('PASSKEYS: so does the authenticator app set up before this file', o == 't', o)
o, _, _ = run(f"select public.second_step_has_second_step('{U_PETER}')")
expect('PASSKEYS: and somebody with neither still counts as not set up', o == 'f', o)

# Our own record is ours alone: it never lets anybody in, and nobody can read anyone else's.
o, e, r = as_('authenticated', claims(U_MGR), "select count(*) from public.second_step_passkeys;")
expect('PASSKEYS: a signed in login cannot read the passkey table at all', r != 0, (e or '')[-160:])
o, e, r = as_('anon', claims(role='anon'), "select count(*) from public.second_step_passkeys;")
expect('PASSKEYS: nor can the public key', r != 0, (e or '')[-160:])
o, e, r = as_('authenticated', claims_session(U_MGR, S_PASS),
              f"select public.second_step_passkey_record('cred-mgr-1', 'iPhone', 'iPhone');")
expect('PASSKEYS: a login records its OWN passkey', r == 0, (e or '')[-200:])
o, _, _ = run("select count(*) from public.second_step_passkeys where user_id = '" + U_MGR + "'")
expect('PASSKEYS: and the row is written for that login only', o == '0', o)   # rolled back in as_()

# The roll back of the passkey file: back to aal2 only, nothing dropped.
pk_src = open(PK_MIG).read()
pk_block = pk_src[pk_src.index('-- -- ============================================================================\n-- -- ROLL BACK'):]
bad = [l for l in pk_block.split('\n') if l.strip() and not l.startswith('--')]
expect('PASSKEYS: every line of its roll back is a comment, so one Cmd+/ runs it', not bad, bad[:1])
pk_plain = '\n'.join((l[3:] if l.startswith('-- ') else (l[2:] if l.startswith('--') else l)) for l in pk_block.split('\n'))
pk_rb = os.path.join(HERE, '.rollback_pk.sql')
open(pk_rb, 'w').write(pk_plain + '\n')
try:
    o, e, r = run_file(pk_rb, one_tx=False)
finally:
    os.remove(pk_rb)
expect('PASSKEYS: the roll back runs exactly as it is written', r == 0, (e or '')[-600:])
o, _, _ = run("select enforce from public.second_step_settings")
expect('PASSKEYS: the roll back switches enforcement OFF first, so nobody is locked out by it', o == 'f', o)
run("update public.second_step_settings set enforce = true where id")
expect('PASSKEYS: with enforcement back on it is aal2 only again, as it was on 19 September',
       ok_for(claims_session(U_OWNER, S_PASS)) == 'f')
expect('PASSKEYS: and an aal2 sign in still passes, so nothing else moved',
       ok_for(claims(U_OWNER, aal='aal2')) == 't')
o, _, _ = run("select count(*) from public.second_step_passkeys")
expect('PASSKEYS: the record of who holds one is KEPT, not dropped', o == '1', o)

# ── the roll back ────────────────────────────────────────────────────────────
o, _, _ = run("select count(*) from pg_policy where polname = 'second_step_fence'")
before = int(o)
# Exactly as Peter runs it: copy the block, select all, Cmd+/ once (every line loses its
# first "-- "; the notes keep theirs and stay notes), press Run. PASTE 1, then PASTE 2.
src = open(MIG).read()
block = src[src.index('-- -- ============================================================================\n-- -- ROLL BACK'):]
bad = [l for l in block.split('\n') if l.strip() and not l.startswith('--')]
expect('every line of the roll back block is a comment, so one Cmd+/ runs it', not bad, bad[:1])
uncommented = []
for l in block.split('\n'):
    uncommented.append(l[3:] if l.startswith('-- ') else (l[2:] if l.startswith('--') else l))
whole = '\n'.join(uncommented)
p1 = whole[whole.index('-- PASTE 1'):whole.index('-- PASTE 2')]
p2 = whole[whole.index('-- PASTE 2'):]
r = 0
for part, name in ((p1, '.rollback1.sql'), (p2, '.rollback2.sql')):
    rb = os.path.join(HERE, name)
    open(rb, 'w').write(part + '\n')
    try:
        o, e, r = run_file(rb, one_tx=False)
    finally:
        os.remove(rb)
    if r != 0:
        break
expect('the roll back runs exactly as it is written in the file', r == 0, (e or '')[-600:])
o, _, _ = run("select count(*) from pg_policy where polname = 'second_step_fence'")
expect('every fence policy is gone', o == '0', f'{before} -> {o}')
o, _, _ = run("select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname = 'second_step_check_request'")
expect('the Data API check function STAYS (an empty body, so PostgREST can never call a missing one)', o == '1', o)
o, e, r = as_('authenticated', claims(U_OWNER), 'select public.second_step_check_request();')
expect('and it now refuses nobody', r == 0, (e or '')[-200:])
o, _, _ = run("select enforce, app_gate from public.second_step_settings")
expect('the app break glass is left OFF, so the screens stop asking', o == 'f|f', o)
o, _, _ = run("select count(*) from public.second_step_resets")
expect('the audit trail is kept', o == '0', o)
o, e, r = as_('authenticated', claims(U_OWNER), "select count(*) from public.menu_items;")
expect('a password only login can read again, as before the file', r == 0, (e or '')[-160:])

o, e, r = run_file(MIG)
expect('and the file can be applied again afterwards', r == 0, (e or '')[-600:])

bad = [n for n, ok in RESULTS if not ok]
print(f"\n{len(RESULTS) - len(bad)} passed, {len(bad)} failed")
sys.exit(1 if bad else 0)
