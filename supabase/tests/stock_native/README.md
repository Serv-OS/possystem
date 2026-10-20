# stock_native: the Drop 0 proof (multi site stock, native records)

Local, throwaway PostgreSQL 17 only. Nothing here connects to Supabase except `fetch_demo.sh`,
which READS (Management API, `read_only: true`) and writes its copy outside the repo.

## Run it

```
node supabase/tests/stock_native/run.mjs --base-only    # the base database only (green before 0a exists)
node supabase/tests/stock_native/run.mjs --quick        # the whole proof, 10 sites in the scale part
node supabase/tests/stock_native/run.mjs                # the whole proof, 50 sites and 5,000 items
node supabase/tests/stock_native/run.mjs --seed=1234    # replay the random runs of a seed

zsh supabase/tests/stock_native/fetch_demo.sh /some/scratch/demo.json a59a6d97-ffaa-470e-8bb7-04cba789f335 fcbddcfd-a025-407b-9727-9e9139250767
STOCKN_DEMO=/some/scratch/demo.json node supabase/tests/stock_native/rehearse.mjs              # 0a, revalue, 0b on the live rows
STOCKN_DEMO=/some/scratch/demo.json node supabase/tests/stock_native/rehearse.mjs --base-only  # load the copy only

node --test src/lib/stock/stockNativeMigration.test.js  # the CI text test of the six files
```

Exit code 0 only when every check holds. Needs `/opt/homebrew/bin` (initdb, pg_ctl, postgres, psql,
pg_config) and a C compiler (the pg-safeupdate stand in).

Environment: `STOCKN_MIGRATION`, `STOCKN_ROLLBACK`, `STOCKN_REVALUE`, `STOCKN_REVALUE_ROLLBACK`,
`STOCKN_0B`, `STOCKN_0B_ROLLBACK` point at other copies of the six files (default: this repo's
`supabase/migrations`); `STOCKN_KEEP=1` keeps the cluster and prints how to reach it;
`STOCKN_STOP_AT=n` stops after section n; `STOCKN_NO_GUARD=1` runs without the pg-safeupdate stand in
(and says so); `STOCKN_PGPORT` fixes the port.

## The base database (base.mjs)

Built the way Ops is on 20 Oct 2026, then checked against what 0a's guard reads:

1. Table shapes: `../stock_phase0/schema.sql`, `policies.sql`, `central_schema.sql`, then
   `extra_schema.sql` here (the live columns those leave out, the stock tables they do not have, the
   tables 20261019a and 20261020a need, the vault and pg_net stand ins, a second step stand in that
   honours the token's `aal`).
2. Live function texts no repo file has in their live form: `live/helpers_20oct.sql` (fence helpers,
   the user_profiles role and sections guards and their triggers, set_bo_sections); the 20261016 /
   5 Aug texts from `../stock_function_fences/live`; the Multi site menu helpers copied word for word
   from the REAL 20261017 file at run time.
3. Every real migration Peter already ran, in his order: 20260921u, the fixtures, 20261005b
   (report_day_sums, which the 0a sales day check compares with; it makes the live body exactly),
   20261018a, 20261018c, 20261019, 20261019b, 20261019a, 20261020a (these two open their own
   transaction, so they run as they are; the rest as one transaction each).
4. `live_shape.sql` (the live constraints and indexes of the stock tables the migrations do not make
   here) and `live_policies.sql` (the 92 live policies of the 27 stock tables: 51 + 14 reach policies
   and 27 second step fences, exactly as pg_policies showed them).

The base section then proves the harness is Ops shaped where 0a looks: the seven bodies 0a checks
and the posting core have the live normalised md5 of contract section 4, their live ACLs and search
paths; the 51 / 14 / 92 policies; the user_profiles guards; every venue central. All columns, types
and nullability of the stock tables were compared with live (information_schema, read only) when the
files were written, and `rehearse.mjs --base-only` loads a copy of every live stock row into the same
database with every live column.

## The fixtures (fixtures.mjs)

The two site test company with its LIVE org, Provo and Location 2 ids (0a links exactly those),
a one site company holding stock, a seven site group with no stock, another company whose owner is a
manager at Provo, and the logins of map 7.9 (owner, owner of another company linked as a manager,
role owner with no company, each Stock control level, purchasing only, area manager, one site manager
and owner, ServOS staff, a login without the second step), bound till, kiosk, MPOS, ops tablet,
customer, anon key, service role. Stock rows are shaped so every link rule has a known answer:
6 shared items (Brioche Bun twins stay apart, Oat Milk in l and ml stays apart, eggs stay apart
because their two trays from the one shared supplier do not pair), 1 shared supplier, 2 shared
supplier items (milk with a price here), recipe pairs merged 2 / differ 3 / Location 2 only 2, fills
at Location 2 of 5 packs (one nested) and 2 bridges, negative stock, an archived keg
holding stock, an "@" pack recipe line at the one site venue, and two old cost writes the revalue
file must close (Provo 1.00, Location 2 2.00).

## What run.mjs proves (sections)

1. Base database (above), every order channel through the real central drainer, a seeded property
   run (sales, receipts, waste) keeping on hand = ledger. `--base-only` stops here.
2. 0a as the SQL editor runs a paste: the check row (every column of contract 5.3), no number moves
   on link (33 metrics plus every item's on hand, cost and ledger, every area holding, par and recipe
   base quantity, per venue; only Location 2's packs and bridges change), only the seven named bodies
   change, nobody's profile, link or reach changes.
3. Every column, index, CHECK, table (RLS, grants, read rule, second step fence, no write policy),
   trigger and function (definer or invoker, exact grants: contract 2.9 with its two exceptions) of
   contracts 1 and 2; the policy swap; cron; the vault key; the backup of the seven bodies.
4. The company records and the link (shared items, suppliers, supplier items, recipes, fills,
   nested packs remapped, VAT as a rate, supply mode from kind, zero write plans).
5. Every channel (till, kiosk, online, QR, catering, pay at table, MPOS, HubRise, ezCater, a refund,
   a void) books exactly the same movements, waste and outbox events before and after 0a.
6. A sale sent while 0a holds its item row locks waits and posts after it commits.
7. 0a stops, changing nothing: a second paste, a changed live body, Phase 1 present, not Ops.
8. The revalue file: one REVALUE per item off, ledger value = on hand x cost to the penny, a second
   run writes nothing.
9. Orphan rule (AFTER INSERT: an upsert of an existing row makes no company record, a new row exactly
   one), the demo style recipe then lines then link mirror, a company save keeps them, a change to a
   shared recipe at one site makes that site's own copy.
10. Real role tests through PostgREST style sessions with the live 8 s / 3 s / lock limits (the
    Drop 0 form of the guard: nobody's rights change), set_stock_control, the profile guard block.
    Review fixes (20 Oct): the browser rule `stockLevelOf` (boSectionRules.js) answers what
    `stock_level` answers for every test login in every company; a pack or unit bridge save must
    name a site where its item is set up (a Location 2 manager cannot change Provo's syrup packs);
    a signed in login cannot write company_ref; with company_ref forged (as the SQL editor) every
    archive and save by a Location 2 site id still stays on Location 2's own records (site ids
    resolve through the link rows).
11. Saves: version conflict, par save keeps the minimum, refusals (pack in a recipe, item holding
    stock, base unit in use, on hand), and REVALUE from every cost writer (moving average, LAST_COST,
    negative stock, two lines one item, invoice, transfer in, count setting a cost, company cost
    step) with ledger = books after each. Removing a unit bridge deletes its site rows, so
    `stock_qty_to_base` and `stock_convert_qty` use the newer bridge at once (review fix, 20 Oct).
12. Count approval with a manager PIN (missing, wrong, locked after 5, another venue's PIN, another
    company), one count line per item and area.
13. The one site company: today's rows and rights.
14. Venue clock, day totals, nightly key, nightly send and upkeep.
15. Seeded property run of company saves, site saves, receipts, waste and sales: ledger quantity =
    on hand, ledger value = on hand x cost, zero write plans after every company save.
16. Scale: one item saved at 10 (quick) or 50 sites with 5,000 company items under 3 s, the rest
    queued and finished by the runner, reads under 1 s, multi line sales during company saves with
    no deadlock or lock timeout.
17. 0b: the check row, the lock triggers and their WHEN lists, what a manager can and cannot change
    directly, the writer pass and the drainer still working under the locks, approval closed.
18. The rollbacks one by one and all three, no number moving, then everything applied again.

## Files

| File | What |
|---|---|
| run.mjs | the proof |
| base.mjs | the cluster, the psql helpers, the base database builder, the figures every link check compares |
| fixtures.mjs | ids, logins, devices and stock rows, and what 0a must find on them |
| channels.mjs | one sale per order channel, as each writer writes it, drained by the real drainer |
| rehearse.mjs | 0a, revalue and 0b on a copy of the live rows |
| fetch_demo.sh | the read only copy (written outside the repo; names of people left out) |
| extra_schema.sql, live_shape.sql, live_policies.sql, live/ | the live shapes and texts (no rows) |
| live_indexes.sql, safeupdate_guard.c | from the Phase 1 harness (live indexes, the pg-safeupdate stand in) |

The repo is public: ids and neutral words only; copies of live rows stay outside it.
