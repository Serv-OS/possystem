# Offline proof of 20261019a (stock Phase 0, the safety pass, v5.11.79)

`run.mjs` builds a **local, throwaway PostgreSQL 17**, loads the live table shapes and row level
security of the stock tables (`schema.sql`, `policies.sql`), what central depletion reads
(`central_schema.sql`: `closed_checks`, payment proofs, the pg_cron stand in and production's
default function grants), the live 20261016 / 5 Aug function texts
(`../stock_function_fences/live`, `live/`), then the REAL `20261018a` and `20261018c` files exactly
as Peter ran them on 19 Oct 2026, then `supabase/migrations/20261019a_OPS_stock_phase0.sql` as the
SQL editor runs a paste (one transaction, stop on the first error). It never connects to Supabase.

```sh
node supabase/tests/stock_phase0/run.mjs              # the whole proof (about 6 minutes)
node supabase/tests/stock_phase0/run.mjs --quick      # fewer random sequences (about 2 minutes)
node supabase/tests/stock_phase0/run.mjs --print-md5  # the guard constants, then stop
node supabase/tests/stock_phase0/run.mjs --seed=1234  # replay the random runs of that seed
```

`initdb`, `pg_ctl` and `psql` from PATH or `/opt/homebrew/bin`. Exit code 0 only when every check
holds. After any change to a replaced function body, stamp the guard constants again (the
`--print-md5` output goes into the migration guard and the rollback check).

## How a call is made

Like PostgREST: log in as `authenticator`, `SET LOCAL ROLE` anon, authenticated or service_role,
set `request.jwt.claims`, the live limits (authenticated `statement_timeout` 8 s, anon 3 s,
`lock_timeout` 8 s). A paired till or kiosk is an anonymous session whose uid is on a bound
`devices` row; a Back Office login is a `user_locations` row; an owner reaches every venue of the
company with no link row; a stranger is an anonymous session bound to nothing. "SQL editor" logs in
as `postgres` with no claims (pg_cron, the demo files). The drainer runs as postgres
(`call public.stock_outbox_drain(5, 50, 0.05, true)`).

## What it proves, by section

1. **Guard constants.** The base texts are the live ones (read on Ops 19 Oct: 20261018a core
   `e9865d7c...`, 20261018c leg `541ac922...`, 20261018c late sale guard `d9792fc9...`); the door,
   the sweep, the switch, the mode lookup and the enqueue trigger keep 20261018c's text.
2. **Before 20261019a** the faults are there: a refund of a sale that never took stock off puts
   stock back; the receiver's cost is dragged by stock below zero; stock short on a transfer
   vanishes; no unit conversion; a delete wipes the ledger; a pack a recipe uses can be deleted;
   a transfer may name a venue of another company.
3. **The paste** applies in one transaction; the visible check reads
   `9|1|0|4|12|1|1|10|0|2|1|0|0|browser|{...}` here (no venue has a recipe in this database).
4. The caller rules of 20261018a are unchanged (till, kiosk, Back Office, service role post;
   stranger, bare anon key, another venue's till refused; another venue's item or area refused).
5. **Precision**: 8 decimal costs, one rounding of quantity, one on hand scale.
6. **Return cap**: never more back than the sale took, less earlier returns and their undos.
7. **Counts**: each line's counted time; a first count is Opening stock (costed, never 0, out of
   The Gap and variance); counting while trading never adds sales back; a late sale before the
   count is matched once; a sale in an area the count did not cover is not; only Back Office and
   owners approve.
8. **Receiving in one step**: below zero and unknown cost take the delivery price; the pack and
   price paid go on cost history; repeats post nothing twice.
9. **Invoices in one step**: duplicate numbers refused; an invoice for a received order is
   paperwork only.
10. **Waste**: never refused, tagged, product id on the row, one call.
11. **Deletes keep ledgers**: an item with history cannot be deleted; a pack in use cannot.
12. **Transfers** (the written live style test): send, part receive with a shortfall, cancel; unit
    conversion; Short on transfer booked at the sender (reversal then waste, on hand unchanged);
    one company only in the table rule and in the posting.
13. The order pad weekday is the venue's day, not UTC.
14. The Multi site menu's read only warning, "3 products have a recipe at Provo but none at
    Location 2"; a login that cannot see the menu, and a till, are refused. 14b: the cost rule
    per venue and who may call each new function.
15. **Random sequences** (10,000, seeded): I1 ledger, I2 areas, I3 exactly once on replay, I7
    return cap, every count approves.
16. **Count truth (I6)**: sales before, during and after a count, posted in any order.
17. **Cost (I9)**: the moving average equals a replay; below zero and unknown cost never drag it.
18. **Scale**: 5,000 items, a 2,250 line count approved in one call inside 8 s as the Back Office
    login; the recipe warning at 50 sites x 2,000 products inside 8 s, one row per site.
19. **Concurrency**: 8 tills sell while a 2,250 line count approves, a delivery lands and areas
    move: no deadlock, no timeout, I1 and I2 hold.
20. A second paste, the rollback (functions back byte for byte, every venue keeps its central
    mode, ledger untouched), the paste again, and the guard refusing a changed function or a
    missing 20261018a.
21. **Central stock is automatic** (Peter, 19 Oct): day one (a recipe venue with no row turns
    central with central_since now, through the switch and its 2 hour grace window, booked once by
    key; a venue switched by hand keeps its row; a venue backed out to browser stays there; a venue
    with no recipe gets no row); day one trading (the trigger queues, the till's own post is
    answered skipped central, the drainer posts once); a new venue (no row, nothing queued, then
    its first recipe link, saved by its own Back Office login, switches it in the same step with
    central_since that moment; an import or the SQL editor does the same; 100 links in one
    statement is one row); the hourly sweep after a first recipe; a back out (a later recipe link
    leaves it on the till path and the till posts as before); a second paste of 20261019a changes
    no mode; a **second paste of 20261018c stops at its guard with "Nothing was changed"** and
    changes nothing; the default stays browser (20261018c's own self test rule). Waste on the till
    through the database (the one product exploded there, wastage % not applied to quantity, a
    preview that writes nothing, a stranger refused). Late sales through the drainer: booked once
    from the time the line was counted; a sale made after the line was counted stands.
22. Without 20261018c the file stops and changes nothing.

## Check rows Peter reads before and after

Before the paste, in the SQL editor (read only):

```sql
select i.location_id, count(*) as items, sum(i.on_hand) as on_hand, sum(i.current_cost) as cost,
       (select count(*) from public.stock_movements m where m.location_id = i.location_id) as movements,
       (select sum(m.qty_base) from public.stock_movements m where m.location_id = i.location_id) as qty,
       (select sum(m.value_delta) from public.stock_movements m where m.location_id = i.location_id) as value
  from public.inventory_items i group by i.location_id order by 1;
```

The last column of the migration's visible check (`stock_sums`) must carry the same figures for
every venue: the migration moves no stock. The day one switch may queue the last 2 hours of paid
checks of a venue that turns central; those post on the next drain (a check its till already took
off lands as a duplicate by key).
