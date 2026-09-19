# Offline tests for the stage 1 fence migrations

These run the four `20260919*` migrations against a **local, throwaway Postgres 17** that copies the live shape of the tables they touch. They never connect to Supabase.

- `schema/*.json`: read only catalog dumps of the stage 1 tables (columns, constraints, policies, functions, triggers, grants; no rows). They are NOT kept in git: produce them with the read only queries in `schema_queries.sql` and save each result under the name it gives.
- `build_baseline.py`: turns the dumps into `.baseline.sql` (roles `anon`, `authenticated`, `service_role`, an `auth` schema with `uid()`, `users` and `sessions`, the tables, the live policies, functions and grants).
- `seed.sql`: made up companies, venues, logins and devices in every state the live data has (grandfathered, stale, duplicate, no venue, a till signed in with a login from another venue, a stranger who signs up with a real login).
- `precheck_devices.sql`: the runbook's read only pre-check (what file A will do to each device). `testA.py` proves it predicts the file exactly.
- `testA.py` (file 1: identity, the device exploit of 18 Sep and every variant, pairing codes, throttles, public orders, QR tabs, payment being checked), `testTrip.py` (file 1 stops, changing nothing: an unlinked profile venue, a busy till), `testB.py` (file 2: its gates, what it closes, file 1 refusing to run after it), `testP.py` (both Platform files), `testRollback.py` (every roll back block, run twice, compared with the state before its file).

## Run

```sh
initdb -D /some/scratch/pgdata -U postgres --auth=trust -E UTF8
LC_ALL=en_US.UTF-8 pg_ctl -D /some/scratch/pgdata -o "-p 55432 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start
python3 build_baseline.py
python3 testA.py && python3 testTrip.py && python3 testB.py && python3 testP.py && python3 testRollback.py
pg_ctl -D /some/scratch/pgdata stop    # and delete the folder
```

`FENCE_PGHOST` and `FENCE_PGPORT` override the address. Every migration is applied the way the Supabase SQL editor runs a paste: the whole file as ONE transaction (`psql -1 -f`), so a file that stops has changed nothing.

On 19 Sep (fix round): 232, 7, 53, 20 and 24 checks (336), all passing.

Each check runs as a PostgREST caller would: `set local role` plus `request.jwt.claims` (and `request.headers` for the caller's network), inside a transaction that is rolled back unless the test needs the change to stay.
