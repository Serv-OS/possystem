# Offline tests for the stage 1 fence migrations

These run the four `20260919*` migrations (`20260919a_OPS_fence_1_after_release.sql`, `20260919b_OPS_fence_2_after_app.sql`, `20260919c_PLATFORM_fence_1_after_release.sql`, `20260919d_PLATFORM_fence_2_after_app.sql`) against a **local, throwaway Postgres 17** that copies the live shape of the tables they touch. They never connect to Supabase.

- `schema/*.json`: read only catalog dumps of the stage 1 tables (columns, constraints, unique indexes, policies, functions with their full ACL, triggers, grants; no rows). They are NOT kept in git: produce them with the read only queries in `schema_queries.sql` and save each result under the name it gives. Fix round 2 added the tables the server prices orders from (menu_items, modifier_groups, discount_rules, offers, promo_codes, promo_redemptions, loyalty_transactions, stamp_transactions), `indexes.json`, and `acl` on `functions.json`.
- `build_baseline.py`: turns the dumps into `.baseline.sql` (roles `anon`, `authenticated`, `service_role`, an `auth` schema with `uid()`, `users` and `sessions`, the tables, the live policies, functions, function ACLs and grants).
- `seed.sql`: made up companies, venues, logins and devices in every state the live data has (grandfathered, stale, duplicate, no venue, a till signed in with a login from another venue, a stranger who signs up with a real login), every device switched on in the last 2 hours reporting the fence app (fix round 3: `20260919_OPS_fence_0_caps.sql` has run and `client_caps` carries `fence_v1`, which is what file A gates on), and a small menu (items, a size, a menu tier, modifier groups of every kind: pick many, pick with qty and a nested sub group, with free and minus priced options), automatic deals, offers and promo codes.
- `precheck_devices.sql`: the runbook's read only pre-check (what file A will do to each device). `testA.py` proves it predicts the file exactly.
- `testA.py` (file 1: identity, the device exploit of 18 Sep and every variant, pairing codes, throttles, device secrets, venue codes, public orders priced by the server: normal orders with options, sizes, tiers, deals, promo codes and loyalty, the seven ways "paid" was forged plus the eighth of fix round 3 (a minus priced option repeated until the line is free, on an order and on a tab round, with the group and group-max rules and every legitimate option beside it), QR tabs and their hold, closing a tab, payment being checked and short), `testTrip.py` (file 1 stops, changing nothing: an unlinked profile venue, the fleet as it is today with no fence capability, a till with no capability, a heartbeat that cannot hold the file shut, step 1b skipped, a busy till), `testB.py` (file 2: its gates, what it closes, file 1 refusing to run after it), `testP.py` (both Platform files), `testRollback.py` (every roll back section, pasted whole and uncommented once, run twice, compared with the state before its file, function ACLs included, and each one refusing while the later file is in).

## Run

```sh
initdb -D /some/scratch/pgdata -U postgres --auth=trust -E UTF8
LC_ALL=en_US.UTF-8 pg_ctl -D /some/scratch/pgdata -o "-p 55432 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start
python3 build_baseline.py
python3 testA.py && python3 testTrip.py && python3 testB.py && python3 testP.py && python3 testRollback.py
pg_ctl -D /some/scratch/pgdata stop    # and delete the folder
```

`FENCE_PGHOST` and `FENCE_PGPORT` override the address. Every migration is applied the way the Supabase SQL editor runs a paste: the whole file as ONE transaction (`psql -1 -f`), so a file that stops has changed nothing. A roll back is run the way the runbook says: the whole section from its `-- -- ====` rule to the end of the file, each line losing its first `-- `.

On 19 Sep (fix round 2): 325, 12, 56, 20 and 39 checks (452), all passing.
On 19 Sep (fix round 3, rebased on v5.9.11): 349, 25, 56, 21 and 39 checks (490), all passing. `20260919_OPS_fence_0_caps.sql` (step 1b) is run by `testTrip.py`; `seed.sql` does what it does, because it is the state of the database on the night file A is pasted.

Each check runs as a PostgREST caller would: `set local role` plus `request.jwt.claims` (and `request.headers` for the caller's network), inside a transaction that is rolled back unless the test needs the change to stay.
