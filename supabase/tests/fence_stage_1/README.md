# Offline tests for the stage 1 fence migrations

These run the four `20260919*` migrations against a **local, throwaway Postgres 17** that copies the live shape of the tables they touch. They never connect to Supabase.

- `schema/*.json`: read only catalog dumps of the stage 1 tables (columns, constraints, policies, functions, triggers, grants; no rows). They are NOT kept in git: produce them with the read only queries in `schema_queries.sql` and save each result under the name it gives.
- `build_baseline.py`: turns the dumps into `.baseline.sql` (roles `anon`, `authenticated`, `service_role`, an `auth` schema with `uid()`, `users` and `sessions`, the tables, the live policies and functions).
- `seed.sql`: made up companies, venues, logins and devices in every state the live data has (grandfathered, stale, duplicate, no venue, a till signed in with a login from another venue, a till whose login changed).
- `testA.py` (file 1), `testTrip.py` (file 1 stops on an unlinked profile venue), `testB.py` (file 2), `testP.py` (both Platform files).

## Run

```sh
initdb -D /some/scratch/pgdata -U postgres --auth=trust -E UTF8
LC_ALL=en_US.UTF-8 pg_ctl -D /some/scratch/pgdata -o "-p 55432 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start
python3 build_baseline.py
python3 testA.py && python3 testTrip.py && python3 testB.py && python3 testP.py
```

`FENCE_PGHOST` and `FENCE_PGPORT` override the address. On 18 Sep: 125, 4, 40 and 16 checks, all passing.

Each check runs as a PostgREST caller would: `set local role` plus `request.jwt.claims`, inside a transaction that is rolled back unless the test needs the change to stay.
