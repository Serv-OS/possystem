# Offline proof of 20261018a (stock function fences)

`run.mjs` applies `supabase/migrations/20261018a_OPS_stock_function_fences.sql` to a **local,
throwaway PostgreSQL 17** that carries the live shape of the stock tables and the text of the
three functions it replaces, then calls them the way the API does. It never connects to Supabase.

```sh
node supabase/tests/stock_function_fences/run.mjs
```

It starts its own cluster in a temp folder (`initdb`, `pg_ctl` and `psql` from PATH or
`/opt/homebrew/bin`) and stops it at the end. Exit code 0 only when every check holds.
`--print-md5` prints the guard constants (the md5 of each function text, spaces folded) and stops.

## How a call is made

Like PostgREST: log in as `authenticator`, `SET LOCAL ROLE` to `anon`, `authenticated` or
`service_role`, set `request.jwt.claims`, and the live statement timeouts (authenticated 8 s,
anon 3 s). A paired till is an anonymous session (`is_anonymous` true) whose uid is on a `devices`
row with `bound_via` set and status active or online. "SQL editor" logs in as `postgres` with no
claims, the way the demo files run.

## What is in here

- `live/post_stock_movement_20261016.sql` and `live/post_stock_transfer_leg_20261016.sql`: the two
  function texts of `20261016_OPS_stock_areas.sql`, byte for byte (the copy Peter pasted on 16 Oct,
  `~/.claude/servos-release/stock_areas/1_migration_ops.sql`, has the same text).
- `live/set_inventory_on_hand_20260805.sql`: the function as read from the Ops catalog on 5 Aug
  2026 (`000_baseline_ops.sql`); no migration has changed it since.
- `live/helpers.sql`: `is_anon_session`, `is_super_admin` (20260805c), `user_accessible_locations`
  (20260921u), `accessible_location_ids` and `accessible_location_uuids` (20260927a), verbatim.
- `schema.sql`: the tables those functions read and write, with the live column types, Supabase's
  roles and `auth.uid()`.

The live Ops database could not be read on 18 Oct (read only queries were refused in that
session), so these texts come from the migrations that ran. The migration's guard is the safety
net: it compares the live bodies with these md5s and changes nothing if any differs.

## What it proves

1. The guard constants are the md5s of these texts.
2. BEFORE: a stranger, the bare anon key, an unbound till, a retired till, a till of another
   venue, a login of another company and an API call with no claims can all post stock or set on
   hand; an item or area of another venue is accepted; transfers go between companies. Every
   refusal case of step 4 fails here.
3. The migration applies as the SQL editor runs a paste (one transaction, stop on error), its
   self test included, leaves the role and claims as they were, and its visible check reads
   `1|3|0|0|3|3|2|0|1` on this seed.
4. AFTER: the bound till, kiosk and ops tablet, the Back Office login, the owner (no link row),
   the super admin, the service role and the SQL editor still post; every stranger is refused
   with 42501; another venue's item or area is refused with 22023; the use area lookup stays in
   the venue. The till's own call (the 11 named arguments deplete.js sends) books one
   SALE_DEPLETION row, moves on hand and the area holding, a repeat is a duplicate, a refund puts
   it back, and on hand still equals the ledger.
5. Transfers: same rule (a bound till may now move its own stock between areas), one company only
   between venues, the sender's own lines and areas, a draft can always be cancelled, a sent
   transfer can always be taken back.
6. Scale (2,000 venues, 5,000 devices, 20,000 venue links): well under a millisecond a call for a
   till or a Back Office login, under 10 ms for a super admin, inside the live timeouts.
7. A second run passes its own guard. The ROLLBACK puts all three texts back (same md5), the
   doors open again, and the migration applies again after it.
8. The file stops with nothing changed when a function differs from these texts, when the reach
   rule is too wide (a stranger allowed), and when it is too narrow (user_accessible_locations
   only: every till would lose its stock).
