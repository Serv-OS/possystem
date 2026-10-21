# stock_native: the Drop 0, Drop 1 and drainer release proofs (multi site stock, native records)

Local, throwaway PostgreSQL 17 only. Nothing here connects to Supabase except `fetch_demo.sh` and
`fetch_checks.sh`, which READ (Management API, `read_only: true`) and write their copies outside the repo.

## Run it

```
node supabase/tests/stock_native/run.mjs --base-only    # the base database only (green before 0a exists)
node supabase/tests/stock_native/run.mjs --quick        # the whole proof, 10 sites in the scale part
node supabase/tests/stock_native/run.mjs                # the whole proof, 50 sites and 5,000 items
node supabase/tests/stock_native/run.mjs --seed=1234    # replay the random runs of a seed

zsh supabase/tests/stock_native/fetch_demo.sh /some/scratch/demo.json a59a6d97-ffaa-470e-8bb7-04cba789f335 fcbddcfd-a025-407b-9727-9e9139250767
STOCKN_DEMO=/some/scratch/demo.json node supabase/tests/stock_native/rehearse.mjs              # 0a, revalue, 0b, Drop 1, then the drainer release on the live rows
STOCKN_DEMO=/some/scratch/demo.json node supabase/tests/stock_native/rehearse.mjs --base-only  # load the copy only

node --test src/lib/stock/stockNativeMigration.test.js  # the CI text test of the six Drop 0 files
node --test src/lib/stock/stockNative1Migration.test.js # the CI text test of the two Drop 1 files

# the drainer release (20261023a), on Drop 0 as it is live (0a and its revalue file in; copies with 0b, and with 0b and Drop 1)
node supabase/tests/stock_native/run.mjs --drainer --before-only --quick   # what needs no drainer file (green before it exists)
node supabase/tests/stock_native/run.mjs --drainer --quick                 # the whole drainer proof, 10 speed sites
node supabase/tests/stock_native/run.mjs --drainer                         # 50 speed sites, 3,000 checks

zsh supabase/tests/stock_native/fetch_checks.sh /some/scratch/checks.json a59a6d97-ffaa-470e-8bb7-04cba789f335   # the test company only
STOCKN_DEMO=/some/scratch/demo.json STOCKN_CHECKS=/some/scratch/checks.json node supabase/tests/stock_native/rehearse.mjs --drainer

node --test src/lib/stock/stockDrainerMigration.test.js  # the CI text test of the release and its rollback
```

Exit code 0 only when every check holds. Needs `/opt/homebrew/bin` (initdb, pg_ctl, postgres, psql,
pg_config) and a C compiler (the pg-safeupdate stand in).

Environment: `STOCKN_MIGRATION`, `STOCKN_ROLLBACK`, `STOCKN_REVALUE`, `STOCKN_REVALUE_ROLLBACK`,
`STOCKN_0B`, `STOCKN_0B_ROLLBACK`, `STOCKN_D1`, `STOCKN_D1_ROLLBACK`, `STOCKN_DRAINER`, `STOCKN_DRAINER_ROLLBACK`
point at other copies of the ten files (default: this repo's `supabase/migrations`); `STOCKN_CHECKS`
(rehearse.mjs only) a copy made by `fetch_checks.sh`; `STOCKN_KEEP=1` keeps the cluster and prints how to reach it;
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

Then Drop 1 (drop1.mjs), in Peter's order: 0a, its revalue file, 0b, then 20261024a.

19. The paste: refused without 0b, on a second run, with a changed body (md5) and off Ops, changing
    nothing; the check row (contract 1.11) against figures read before; no site row, login or link
    changes; categories seeded with no edit; order rules seeded, each ordered the day before, and the
    round trip of every site supplier row's days and cut off.
20. Every new table (RLS, exact grants, its read rule, the second step fence, no write policy), the four
    columns, the CHECKs, indexes and triggers; every new function (definer, search path, exact grants),
    internal helpers owner only, the anon key refused, stock_nightly_health for the service role only.
21. The Stock control levels with real roles and JWT claims: owner, ServOS staff, owner of another company
    and a role owner with no company (Their sites there), Stock control all with Purchasing only, a sites
    manager (company edits refused, par and its own local records allowed, price here and supplier here
    refused, a direct company column update refused by 0b), sites_full (price and supplier here at its own
    site only), an area manager, the one site company (every save as Drop 0, its order rules following
    its delivery days; a supplier pack saved exactly as today's Suppliers tab sends it, VAT rate row null
    or set, preferred flag and cost following), a sites manager's local supplier pack never moved to a
    company supplier nor made the supplier here, Purchased or made and Sold directly per site (company
    only), a new made item, the version rule, devices, customers, the anon key, no second step.
22. stock_items_page keyset pages with name ties, every filter, scope by group, a manager's own sites;
    stock_suppliers_page and stock_prices_page likewise; then a company of 50 sites (10 with --quick) and
    5,000 items: every page of 100 under 1 s, one item save under 3 s, nightly health under 8 s; the filter
    ids (one row read again, the same as on its page; never wider than the login sees; 100 at most).
23. Set sites (add, run out, remove refused in words, a local item), pause (everywhere, a site, days),
    Change prices (preview, live, dated: a site row on its own day, a company row waiting for the latest
    clock), categories, order rules (save, copy, conflict), a supplier unticked and ticked again, make
    company record, groups, suggestions, nightly health and Fix, go live, import (2,000 rows staged, recipe
    rows skipped, committed by the runner; a name only file is Same and changes nothing); then on the big
    company every bulk over 200 rows through the queue with sales running, a supplier with a pack for
    every item (5,000) through Copy a site, an import that links it and Fix, and a 10,001 row file (5,000
    items, a supplier, 5,000 packs naming them) staged 2,000 rows a call: no runner step over 1 s, every
    stage call under 4 s, no lock timeout, no dead outbox event.
24. Every order channel books exactly the same before and after Drop 1.
25. The Drop 1 rollback (the 24 Drop 0 bodies back by md5, nothing of Drop 1 left, no number moving),
    then Drop 1 again.

## The drainer release (drainer.mjs, run.mjs --drainer)

Section 1 builds the base database as above; then, instead of sections 2 to 18, Drop 0 is put in as it
is live (0a and its revalue file; one copy also with 0b, and one with 0b and Drop 1, the live state since
21 Oct 2026) and the drainer release is proved on copies:

19. The base: 0a and the revalue applied, the basket's rows added the way a demo file adds them, Drop 0's
    channels booked as the history the release compares, the 7 replaced and 21 checked bodies at their
    live md5, search_path and grants, everything the guard asks for there and nothing of the release.
20. The every channel basket (map 9.1, drainer contract 6.2; channels.mjs `basketEvents`) BEFORE the
    release, without and with 0b, booked by each channel's own writer at Provo, Location 2 and the one
    site venue: till cash, card, split, send to terminal, bar tab, kiosk, online, QR pay now and open
    tab, catering dated ahead (plain, part refunded before the event and netted, voided before the
    event), pay at table, MPOS, HubRise (and its cancel), ezCater, part refunds with and without a uid,
    a full refund, a refund the processor refused (undo), a sealed item going back to the shelf, a money
    only refund, a void after making and before sending, a booking check and a demo id check (skipped),
    staff discounts (check and item level, by preset and by label), a comp, loyalty by tender, by kind
    and the legacy credit, a promo tender, a modifier with its own recipe, a pack line dish, drive thru,
    gift card and booking deposit tenders. What v1 books is checked case by case.
21. The paste: the check row (contract 5.4, every column), its refusals (a second paste, before 0a, not
    Ops, a changed replaced or checked body, no pg_cron), and the in migration proof refusing a real
    difference (an archived recipe still linked with live sales, a recipe line on an archived pack).
22. What it made: discounts.kind and its CHECK, stock_day_sums.demo and its key, the queue columns and
    indexes, the three tables (RLS, grants, read rules, fences, no write policy, not in realtime), the
    option rule shape CHECK and org guard, the nine triggers, every function's language, definer,
    volatility, search_path, exact grants, result shape and arguments, the cron job.
23. The basket AFTER the release, without and with 0b: every movement, waste row and outbox event
    (flags included) identical to v1, net of VAT identical (the JS rule), `_sales_check_parts` giving the
    JS integers on every basket check, one stock_sale_takes row per sale that reached the posting step
    with per unit amounts adding up to the movements and each line's theoretical cost, no new flag.
24. The deliberate changes (map 8.1, contract 6.1), each with v1's and v2's figures side by side:
    archived recipe, item, pack and bridge (D1); made to order three levels down, a loop, the depth cap,
    no recipe, per site (D2); oat milk replacing milk at two sites (different units), no cheese, remove
    winning over replace, options on the dish's own recipe only, a rule with no site row (D3); a part
    refund after a recipe change giving back what the sale took (2 of 3), refunded food booked as waste
    and the sealed juice back on the shelf, an unmatched refund line, a refund with no uid (the sale's
    average), a sale booked before the release (refund_by_recipe), a full refund, a refused takes row
    never undoing the sale (D4, D6); stock_drainer_health naming every one of them.
25. Stock day totals: the paste queues every venue day that holds a movement (history 20, 45, 54 and
    60 days back included) and nothing else but today and the two days before; equal to the ledger on
    every venue day of the whole ledger; the demo markers; after inserts, updates (quantity, day, type,
    a many row update) and deletes; a day the totals never held (rows written with no trigger) gets a
    late row, a delete and a moving update, each queues the day (reason late) and the drain makes it
    whole, while an update that moves no figure and a row dated yesterday queue nothing; a post during a rebuild waits
    at most 500 ms and its day goes to the repair queue; a forced error (and a refusing repair queue)
    never stops the post; no delta lost to a rebuild during sales; the drain's backoff; two drains at
    once; an unknown clock (clock_known false), the clock arriving, a changed day start, the same clock
    again; a minute either side of a day start; stock_drainer_health's every field.
26. Sales day totals: every column of every basket row against an independent oracle (qty, gross, net,
    discounts, rewards, tax, theoretical cost, staff, comp, loyalty); sales_day_sums_check per day (net
    = the rule = the JS, theoretical cost = the ledger's sale value); `_sales_check_parts` against the JS
    on 40 parity rows (every tender and legacy path); `_sales_js_round` and `_sales_js_num`; a till close
    while the queue is locked or refusing still writes the check.
27. Speed: the drainer with every trigger off (v1) and on (v2), clean and busy (sales injected all
    through, and with the release day total rebuilds and drains beside it): every check done, 0 dead,
    the rate printed against 15,000 checks an hour company wide, the day totals equal to the ledger at
    every site after, one takes row per check, stock_drainer_health and sales_day_sums_check at scale.
28. Who may do what: the option tables' read rules per login, the second step fence, the anon key,
    stock_sale_takes and every internal closed (owner, till, anon, even the service role for the
    internals), the service role's rebuild under 8 s, discounts.kind written by a Back Office login under
    the live rules (refused without the second step and by the anon key), the 3 s anon limit.
29. The rollbacks: 0a's refused while the release is in; the release's own (its check row, the seven
    bodies back at their live md5, search_path and grants, every function exactly the base's, the old
    day totals key, the tables, triggers, job and backup rows gone, discounts.kind kept), the basket
    after it matching v1 again, then the release applying again.

`--before-only` runs 19, 20, the v1 half of 24 and the v1 speed: green before the drainer file exists.

0a ran live on 20 Oct 2026, so a copy fetched since then is taken AFTER 0a: its site rows carry
company_ref, and fetch_demo.sh then also copies 0a's company records (the stock_co_ tables) and the
venue clock. rehearse.mjs sees that, puts 0a on the empty base first (as on Ops) and loads the copy
with every live column. Step 3 then proves what 0a left on the real rows instead of linking them again
(every site row has its company record, no company row without a site, the writer re plans zero
writes, the twins, the archived keg, Location 2's nested packs, on hand equal to the ledger), and step 4
proves a second revalue paste refuses and changes nothing, with the ledger value equal to the books to
the penny. A copy taken before 0a (such as the one of 20 Oct) still runs the link and revalue checks.
Steps 5 (0b) and 6 (Drop 1, its check row against contract 1.11, its rollback, Drop 1 again) are the same.
Drop 1 ran live on 21 Oct 2026, so a copy fetched since then also carries its four columns on 0a's tables
(stock_co_items.category_id, stock_co_item_sites.paused_from and paused_until, stock_co_site_groups.row_version):
the loader leaves those out (the base has 0a only) and step 6 makes them again as the SQL editor did.

rehearse.mjs step 7 runs the drainer release on a copy of the live state as it is now (0a, its revalue
file, 0b and Drop 1 in): the check row with every difference 0, every venue day of the real ledger
queued and checked after the drain, a late row on the oldest day queued and rebuilt whole,
stock_drainer_health, the rollback; with `STOCKN_CHECKS` also the sales rule on every real check and a
replay of those checks as new sales before and after the release (identical movements, waste and
outbox events; part refunds with no uid shown aside, never giving back more than the sale took).

## Files

| File | What |
|---|---|
| run.mjs | the proof |
| drop1.mjs | sections 19 to 25: Drop 1 |
| base.mjs | the cluster, the psql helpers, the base database builder, the figures every link check compares |
| fixtures.mjs | ids, logins, devices and stock rows, and what 0a must find on them |
| channels.mjs | one sale per order channel, as each writer writes it, drained by the real drainer |
| drainer.mjs | the drainer release proof, sections 19 to 29 (run.mjs --drainer) |
| drainer_fixtures.mjs | the rows the drainer proof adds: the basket's extra rows and presets, the deliberate cases, the speed company, the sales rule parity rows |
| live_discounts.sql | public.discounts as Ops has it (RLS, grants, the two live policies), for the discounts.kind role tests |
| rehearse.mjs | 0a, revalue, 0b and Drop 1 on a copy of the live rows (or, on a copy taken after 0a, what 0a and the revalue left, then 0b and Drop 1), then the drainer release on that live state (step 7) |
| fetch_demo.sh | the read only copy, with 0a's company records and the venue clock once 0a is live (written outside the repo; names of people left out) |
| fetch_checks.sh | a read only copy of one company's recent closed checks, only the fields the stock and sales rules read (written outside the repo; nothing that names a person) |
| extra_schema.sql, live_shape.sql, live_policies.sql, live/ | the live shapes and texts (no rows) |
| live_indexes.sql, safeupdate_guard.c | from the Phase 1 harness (live indexes, the pg-safeupdate stand in) |

The repo is public: ids and neutral words only; copies of live rows stay outside it.
