# Offline proof of 20261019c (multi site stock, Phase 1 and 1b, v5.11.80)

`run.mjs` builds a **local, throwaway PostgreSQL 17** the way `../stock_phase0` does (the live shapes and
row level security of the stock tables, `extra_schema.sql` here for tax rates, staff and pars), copies the
Multi site menu helpers word for word from the REAL `20261017` file, then applies the REAL `20261018a`,
`20261018c`, `20261019` (every venue central, as live) and `20261019b`, then
`supabase/migrations/20261019c_OPS_stock_company.sql` as the SQL editor runs a paste (one transaction).
It never connects to Supabase.

```sh
node supabase/tests/stock_company/run.mjs            # the whole proof, 50 sites in the scale part (about 2 minutes)
node supabase/tests/stock_company/run.mjs --quick    # 10 sites in the scale part (about 30 seconds)
STOCK1_STOP_AT=6 STOCK1_KEEP=1 node supabase/tests/stock_company/run.mjs --quick
                                                     # stop after section 6 and keep the database (prints psql)
```

`initdb`, `pg_ctl` and `psql` from PATH or `/opt/homebrew/bin`. Exit code 0 only when every check holds.

## How a call is made

Like PostgREST: log in as `authenticator`, `SET LOCAL ROLE` authenticated, anon or service_role, the
request claims set, and the live limits (authenticated and service role `statement_timeout` 8 s, anon
3 s, `lock_timeout` 8 s). The runner (pg_cron) and the SQL editor log in as `postgres`
(`call public.msm_stock_run_due(30)`). The logins: super admin, stock Editor, stock Viewer, a menu editor
who is not a stock person, the owner (not added), site managers of two sites, another company's
manager, a bound till, a stranger, the bare anon key, the service role.

## What it proves, by section

0. The file: ASCII only, bare statements, no menu function (change sets, runner, guard) created or
   replaced, no menu table altered.
1. The paste applies in one transaction; the check row reads `20 | 63 | 15 | 1 | 0 | 0 | 0 | 0 | stock_sums`;
   every function that was there before has the same body after; no stock row moves; a second paste
   reads the same; the lock trigger's WHEN clause names company columns only; the planner and the
   runner cannot be run through the API; a Back Office login can no longer approve a count without the PIN.
2. Admin: only ServOS (second step) switches Shared stock; a company not on the Multi site menu is
   refused in words; switching it on puts EVERY site central (a site backed out by hand too) with
   `central_since`; a site created later or moved into the company is central from that moment; the
   stock people are their own list (a menu editor and the owner are not let in).
3. Fences for every login, on the pages and the writes; no direct writes to the company tables.
4. Start from a site: the site's live rows become the company list with company_ref stamped and NOTHING
   else; the self check plans zero writes; it runs once.
5. The lock at the site: company name, unit, archive, a company pack's delete, a company price, a
   forged company row, an unlink and the client side bypass are refused (naming the Editors); the
   site's own fields (notes, made here, preferred supplier, tracking, account number, order email,
   delivery days, pars, its own extra pack) save; waste and a sale on a company item post (the WHEN
   clause never fires); the base unit of an item with movements cannot change.
6. Location 2: links suggested (SKU and unit, then name and unit; a different unit is not), ticked,
   items switched on, preview rolled back, publish now through the runner: no quantity, cost, ledger,
   par, area or count change; linked rows keep their own stock, cost and preferred supplier; new rows
   start at 0 and no cost, get a preferred supplier once and their usual area; VAT maps to the site's
   own rate row; I8: a re publish plans zero writes.
7. A change scheduled for 05:00 on each site's clock; nothing runs before; another publish waits in
   words; Run now; one before and after row per changed row.
8. Undo: only the newest; company rows back at once; sites back within the minute; Location 2 back
   EXACTLY (every row of the five tables and its areas); re publish after Undo plans zero writes.
9. The health check stops a publish in words (no VAT rate at the site, a unit with no bridge); bad
   input is refused when staged (unknown unit, on hand from head office, a site of another company).
10. Keep the site's: the row becomes the site's own, the site can change it; Undo links it again.
11. Change prices (preview, company or chosen sites); CSV import of 5,000 rows in chunks of 2,000,
    the one bad row named, then into the draft in one call.
12. The usual six areas from head office; the site's own status card.
13. Count approval needs a manager PIN; a server's PIN is refused; five wrong PINs lock the login for
    15 minutes; the Manager app (service role) approves in one call.
14. Sales during a publish: 8 tills sell the same items while a publish rewrites 2,000 items at the
    site: 0 lock timeouts, 0 deadlocks, sale p95 under 300 ms, on hand equals the ledger.
15. Random drafts (seeded): publish moves no quantity, cost or ledger; re publish plans zero; Undo
    is exact.
16. Scale: 50 sites, 5,000 company items each with a pack and a supplier price, staged through the
    API in calls of 2,000; "every site" is one change per item; preview of 5 sites and publish each
    under the 8 s limit; first publish per site under 30 s; one change reaches 50 sites well under 10
    minutes; every screen read under 1 s and one row (never past the 1,000 row cap).
17. The rollback, then the paste again.
18. Without its prerequisites the file stops in words and changes nothing.

## The rehearsal on a copy of real stock (read only)

```sh
zsh supabase/tests/stock_company/fetch_demo.sh /private/tmp/<scratch>/demo.json <demo org id> <third company org id>
STOCK1_DEMO=/private/tmp/<scratch>/demo.json node supabase/tests/stock_company/rehearse.mjs
```

`fetch_demo.sh` reads the companies' stock rows through the Management API with `read_only: true` and
writes them OUTSIDE the repo (never commit the copy). `rehearse.mjs` loads the copy as it is (triggers
off while loading), runs the real migrations, Starts from Provo, links Location 2's own rows (single
matches), switches every item on there, publishes now through the runner, and proves: every check row
at Provo identical, no quantity, cost, ledger, area stock or par change at Location 2, the third company
identical, a re publish plans zero writes, Undo puts Location 2 and then Provo back exactly.

## Check rows Peter reads before and after the paste

```sql
select i.location_id, count(*) as items, sum(i.on_hand) as on_hand, sum(i.current_cost) as cost,
       (select count(*) from public.stock_movements m where m.location_id = i.location_id) as movements,
       (select sum(m.qty_base) from public.stock_movements m where m.location_id = i.location_id) as qty,
       (select sum(m.value_delta) from public.stock_movements m where m.location_id = i.location_id) as value
  from public.inventory_items i group by i.location_id order by 1;
```

The last column of the migration's check row (`stock_sums`) carries the same figures for every venue.
