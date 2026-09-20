# Offline test for the Back Office second sign in step

`test_second_step.py` runs `supabase/migrations/20260919s_OPS_second_step.sql` against a **local,
throwaway Postgres 17** that copies the shape of the live Ops database (the Supabase roles, the
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

On 20 Sep 2026: **54 checks, all passing**, including the blocker this round closed (a stolen
password cannot set up the thief's own second step), the staff app never being refused, the lock
out at switch on time, Peter's own break glass and recovery, and a roll back that drops nothing.
