# Offline test for the Back Office second sign in step

`test_second_step.py` runs `supabase/migrations/20260919s_OPS_second_step.sql` and then
`20260920p_OPS_passkey_second_step.sql` against a **local, throwaway Postgres 17** that copies the shape of the live Ops database (the Supabase roles, the
`auth` tables the file reads, and enough public tables for the fence loop to have work to do). It
never connects to Supabase. The same method as `supabase/tests/fence_stage_1`.

- `baseline.sql`: the roles, the auth schema and the public tables.
- `seed.sql`: made up logins in every state the live database has (a super admin, a dormant owner
  with no second step, a manager who has one, a staff app only login, an anonymous till).
- `test_second_step.py`: the file applied as ONE paste, then every rule checked as the roles
  PostgREST really uses, then the roll back run exactly as Peter runs it.

## Run

```sh
initdb -D /some/scratch/ssdata -U postgres --auth=trust -E UTF8
LC_ALL=en_US.UTF-8 pg_ctl -D /some/scratch/ssdata -o "-p 55988 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start
python3 test_second_step.py
pg_ctl -D /some/scratch/ssdata stop    # and delete the folder
```

`SS_PGHOST` and `SS_PGPORT` override the address.

On 20 Sep 2026: **83 checks, all passing**, including the blocker this round closed (a stolen
password cannot set up the thief's own second step), the staff app never being refused, the lock
out at switch on time, Peter's own break glass and recovery, and a roll back that drops nothing.

## Passkeys

The last stretch of `test_second_step.py` applies the passkey file on top of the live one and
proves the thing that would otherwise lock everybody out: **a passkey sign in is aal1**, so the
rule has to read how the session signed in, not just its level.

- a passkey session passes with enforcement **on**, with no authenticator app anywhere;
- a password only session on the same login is still refused, and a made up session id proves nothing;
- the token's own `amr` claim counts too, so it works before `auth.mfa_amr_claims` is readable;
- a passkey counts as a finished second step, so the lock out never takes somebody who has done the work;
- nobody but the service role can read who holds which passkey;
- the roll back switches enforcement off first and puts the aal2 only rule back, dropping nothing.

## The browser proof

`passkey_browser_proof.mjs` is the other half, and it needs no database at all:

```sh
node supabase/tests/second_step/passkey_browser_proof.mjs
```

It drives headless Chromium with a **virtual authenticator** (a fake Touch ID sensor, through the
Chrome DevTools WebAuthn domain) against a fake GoTrue, running the real
`src/lib/secondStep/passkey.js` and `passkeyRules.js`. It proves a passkey is made on the device,
signs in with no password, a second device gets its own, one can be removed and the last cannot,
a forgotten passkey fails in plain words, a device with no sensor falls back to the code route,
and **a passkey cannot be made for a domain the page is not on**. On 20 Sep 2026: **17 of 17**.
