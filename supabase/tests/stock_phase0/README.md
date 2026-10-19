# Offline proof of 20261019b (stock Phase 0, the safety pass, v5.11.79)

`run.mjs` builds a **local, throwaway PostgreSQL 17**, loads the live table shapes and row level
security of the stock tables (`schema.sql`, `policies.sql`), what central depletion reads
(`central_schema.sql`: `closed_checks`, payment proofs, the pg_cron stand in and production's
default function grants), the live 20261016 / 5 Aug function texts
(`../stock_function_fences/live`, `live/`), then the REAL `20261018a` and `20261018c` files exactly
as Peter ran them on 19 Oct 2026 (section 21 also the REAL `20261019`, every venue central, as live
is), then `supabase/migrations/20261019b_OPS_stock_phase0.sql` as the SQL editor runs a paste (one
transaction, stop on the first error). It never connects to Supabase.

```sh
node supabase/tests/stock_phase0/run.mjs              # the whole proof (about 6 minutes)
node supabase/tests/stock_phase0/run.mjs --quick      # fewer random sequences (about 2 minutes)
node supabase/tests/stock_phase0/run.mjs --print-md5  # the guard constants, then stop
node supabase/tests/stock_phase0/run.mjs --seed=1234  # replay the random runs of that seed
PHASE0_MIGRATION=/path/old.sql PHASE0_ROLLBACK=/path/old_RB.sql node supabase/tests/stock_phase0/run.mjs --quick
                                                      # the same proof against another copy of the file
                                                      # (shows a new check failing before its fix)
```

`initdb`, `pg_ctl` and `psql` from PATH or `/opt/homebrew/bin`. Exit code 0 only when every check
holds. After any change to a replaced function body, stamp the guard constants again (the
`--print-md5` output goes into the migration guard and the rollback check).

## How a call is made

Like PostgREST: log in as `authenticator`, `SET LOCAL ROLE` anon, authenticated or service_role,
set `request.jwt.claims`, the live limits (authenticated and service role `statement_timeout` 8 s,
anon 3 s, `lock_timeout` 8 s; live `authenticator` carries 8 s, which binds the service role too). A paired till or kiosk is an anonymous session whose uid is on a bound
`devices` row; a Back Office login is a `user_locations` row; an owner reaches every venue of the
company with no link row; a stranger is an anonymous session bound to nothing. "SQL editor" logs in
as `postgres` with no claims (pg_cron, the demo files). The drainer runs as postgres
(`call public.stock_outbox_drain(5, 50, 0.05, true)`).

## What it proves, by section

1. **Guard constants.** The base texts are the live ones (read on Ops 19 Oct: 20261018a core
   `e9865d7c...`, 20261018c leg `541ac922...`, 20261018c late sale guard `d9792fc9...`); the door,
   the sweep, the switch, the mode lookup and the enqueue trigger keep 20261018c's text.
2. **Before 20261019b** the faults are there: a refund of a sale that never took stock off puts
   stock back; the receiver's cost is dragged by stock below zero; stock short on a transfer
   vanishes; no unit conversion; a delete wipes the ledger; a pack a recipe uses can be deleted;
   a transfer may name a venue of another company.
3. **The paste** applies in one transaction; the visible check reads `11|1|0|4|12|1|1|10|0|2|2|{...}`
   and no central stock mode row is written.
4. The caller rules of 20261018a are unchanged (till, kiosk, Back Office, service role post;
   stranger, bare anon key, another venue's till refused; another venue's item or area refused).
5. **Precision**: 8 decimal costs, one rounding of quantity, one on hand scale.
6. **Return cap**: never more back than the sale took, less earlier returns and their undos.
7. **Counts**: each line's counted time; a first count is Opening stock (costed, never 0, out of
   The Gap and variance); counting while trading never adds sales back; a late sale before the
   count is matched once; a sale in an area the count did not cover is not; only Back Office and
   owners approve.
7b. **An older count approved after a newer one** posts nothing (superseded: the newest count stands,
   on hand 80 not 70); a Back Office login cannot move `counted_at` (insert or update), add, change or
   remove a line of an approved count, reopen it, change its figures or delete it (the service role
   can); a stranger gets the same 42501 for another venue's count and a made up id, without waiting on
   that count's lock.
8. **Receiving in one step**: below zero and unknown cost take the delivery price; the pack and
   price paid go on cost history; repeats post nothing twice; a till, a kiosk or another venue's Ops
   tablet cannot receive (it would set the cost); the service role and the owner can.
9. **Invoices in one step**: duplicate numbers refused; an invoice for a received order is
   paperwork only; the same invoice with no number sent twice (and two retries at once) posts once by
   its client id.
10. **Waste**: never refused, tagged, product id on the row, one call; a stock item waste with no
    lines (SQL null, JSON null or an empty list) takes its own quantity off.
11. **Deletes keep ledgers**: an item with history cannot be deleted; a pack in use cannot.
12. **Transfers** (the written live style test): send, part receive with a shortfall, cancel; unit
    conversion; Short on transfer booked at the sender (reversal then waste, on hand unchanged);
    one company only in the table rule and in the posting. Rounding (I5): 11.6438 ml received in full
    lands as 0.0116 l with no Short on transfer; 11.6958 ml never lands as 0.0117 l; a property run
    over ml/l, g/kg, each and a unit bridge, full and part receives: never more arrives than was
    sent, and sent = received + short within half a 4th decimal step of the coarser unit.
13. The order pad weekday is the venue's day, not UTC: `stock_usage_weekday_page` and
    `stock_usage_rates_page` answer one row per item (7 values), 1,000 items a call.
14. The Multi site menu's read only warning, "3 products have a recipe at Provo but none at
    Location 2"; a login that cannot see the menu, and a till, are refused. 14b: the cost rule
    per venue and who may call each new function; a stranger or another company is told the default
    cost rule and "not the same company".
15. **Random sequences** (10,000, seeded): I1 ledger, I2 areas, I3 exactly once on replay
    (invoices with and without a number included), I7 return cap, every count approves.
16. **Count truth (I6)**: sales before, during and after a count, posted in any order; and two or
    three counts of one item approved in any order (newest first too): the newest count is the truth.
17. **Cost (I9)**: the moving average equals a replay; below zero and unknown cost never drag it.
18. **Scale**: 5,000 items, a 2,250 line count approved in one call inside 8 s as the Back Office
    login; the recipe warning at 50 sites x 2,000 products inside 8 s, one row per site; the usage
    reads page by page (each at most 1,000 rows): all 5,000 items, 7 days each, the same totals as an
    uncapped sum (the old read answers more than 1,000 rows there).
19. **Concurrency**: 8 tills sell while a 2,250 line count approves, a delivery lands and areas
    move: no deadlock, no timeout, I1 and I2 hold.
19b. **Saves racing writers**: a one statement count sheet save racing a receipt behind a till sale
    (D1); two invoices behind an item edit (D2); invoices in pairs with their items in opposite orders
    (N2); 8 sessions of count sheet saves, order line saves, receipts, invoices, approvals, waste and
    sales (N): no 40P01, 57014 or 55P03, on hand equals the ledger.
20. A second paste, the rollback (functions back byte for byte, every venue keeps its central
    mode, ledger untouched), the paste again, and the guard refusing a changed function or a
    missing 20261018a.
21. **On top of 20261019** (every venue central, as live): 20261019b writes no mode and queues
    nothing; a check is booked by the drainer and the till's own post is answered skipped central; a
    new venue is central when created and its first recipe link changes nothing; a venue backed out
    by hand stays on the till path; a second paste of 20261019b changes no mode; a **second paste of
    20261018c stops at its guard with "Nothing was changed"**; the default stays browser. Waste on
    the till through the database (the one product exploded there, wastage % not applied to
    quantity, a preview that writes nothing, a stranger refused). Late sales through the drainer:
    booked once from the time the line was counted; a sale made after the line was counted stands.
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
every venue: the migration moves no stock and switches no venue. Cost may show more zeros after the
point afterwards (168.30576 before, 168.30576000 after; 100.20520 as 100.20520000): the same number,
in the wider 8 decimal column.
