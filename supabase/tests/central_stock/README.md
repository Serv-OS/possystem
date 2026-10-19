# Offline proof of 20261018c (central stock depletion, v5.11.77)

`run.mjs` builds a **local, throwaway PostgreSQL 17** that carries the stock fences (20261018a,
applied from `supabase/tests/stock_function_fences`) and the live shape of `closed_checks` and the
recipe tables, applies `supabase/migrations/20261018c_OPS_central_stock_depletion.sql` as the SQL
editor runs it, and then drives every rule as the roles PostgREST really uses. It never connects
to Supabase.

```sh
node supabase/tests/central_stock/run.mjs            # the whole proof, one target hour of load (about 12 min)
node supabase/tests/central_stock/run.mjs --quick    # a tenth of the load (about 3 min)
node supabase/tests/central_stock/run.mjs --print-md5
node supabase/tests/central_stock/run.mjs --review-only   # section 0 and section 16 (review round 1), about 3 min
CENTRAL_REPLAY_DIR=/path/to/provo/dumps node supabase/tests/central_stock/run.mjs   # also section 13
```

`initdb`, `pg_ctl` and `psql` from PATH or `/opt/homebrew/bin`. The cluster starts in a temp
folder with `log_lock_waits=on` and `deadlock_timeout=100ms` so the load section can count lock
waits, and stops at the end. Exit code 0 only when every check holds.

## How a call is made

Like PostgREST: log in as `authenticator`, `SET LOCAL ROLE` anon, authenticated or service_role,
set `request.jwt.claims`, the live statement timeouts (authenticated 8 s, anon 3 s). A paired till
is an anonymous session whose uid is on a bound `devices` row; a Back Office login is a
`user_locations` row; a stranger is an anonymous session bound to nothing. "SQL editor" logs in as
`postgres` with no claims (pg_cron, the demo files). `extra_schema.sql` also sets production's
default ACL (every new function granted to anon, authenticated and service_role) so the grants
audit means something, and a pg_cron stand in with the live `cron.schedule` signature.

## What it proves, by section

0. The guard constants: the md5 of 20261018a's fenced `post_stock_movement` and of the door text
   this file writes, and of 20261018a's `post_stock_transfer_leg` and its item order text; the self
   test leaves the role alone; the visible check reads `3|2|3|browser|0|1|0|0|1|4|1`; the transfer
   leg walks its three line loops in item id order; day one (no venue switched on) the cron drain
   returns at once; both files are ASCII only with no begin or commit of their own.
1. **Day one nothing moves.** A venue with recipes and no mode row enqueues nothing and its till
   still posts through the door. `stock_central_switch(venue, 'central', who)` turns one venue on
   and enqueues the last 2 hours of paid checks (grace window): a check the browser already posted
   lands as a duplicate by key, one row. The switch is not callable through the API.
2. **Enqueue.** A bound till or kiosk: one outbox row, writer device; a replay with ON CONFLICT DO
   NOTHING adds nothing; a venue without recipes or on the browser path: nothing; a stranger, a
   till of another venue and the bare anon key: writer public; demo and booking rows skipped;
   catering dated ahead waits until its time; a till clock 2 h ahead is booked at server time and
   flagged; a check older than 31 days, or closed before the venue switched on, is held; an outbox
   insert that fails never aborts the sale (a warning); 50 rows in one statement: one trigger pass.
3. **Drain, the one stock rule.** Wastage % is NOT applied to quantity; options with itemId
   deplete (mod qty x line qty), instruction and removed mods add nothing; usable %, pack tokens
   (`@<format id>`), unit bridges (slice to g), order type tags (takeaway cup, the drive thru rule,
   bar-tab as dine in, collection), kiosk id only lines, a size as its own itemId; every movement
   carries the item use area, the current cost and the sale time; forged checks are held unproven
   with nothing posted; a line whose unit cannot be resolved is skipped and the event flagged.
4. **Public orders.** A paid online, QR or catering check written by the server for a customer
   session posts once (proof: `public_order_tokens.paid` or `payment_proofs.used_by_ref`, written in
   the SAME transaction as the check: `stock_outbox.xact` against the proof row's xmin); a forged
   copy of the same ref, made after the real order (held unproven), BEFORE it (P2: held, the real
   one posts), or after a staff confirmed order (P4), never takes stock; a token paid in another
   transaction proves nothing.
5. **The door.** At a central venue a bound till's SALE_DEPLETION or RETURN post, and the service
   role's (stock-deplete), are answered `skipped: central`; waste, counts, the browser venue and the
   database itself still post; a stranger is still refused by the fence. Switch on with a sale the
   browser already did: one row. Switch back to browser: the door opens again.
6. **Refunds.** The till's entry written twice (pending, then card approved): one event. Food:
   the sale share reversed (unsale) and booked as WASTE with a waste_events row, on hand unchanged.
   Shelf items (`inventory_items.returns_to_shelf`) RETURN. A refund line without mods takes them
   from the stored line by uid, so options come back too. Capped at what the sale took less
   earlier refunds and voids (read from the ledger, so an old till's RETURN counts). A refused
   refund (Adyen `failed: true`, the till's `cardStatus: 'failed'`) is undone exactly once; an
   entry written already failed makes no event; a money only entry (Ryft) books nothing; a refund of
   a sale that never took stock posts nothing.
7. **Voids and late sales.** A tombstone wastes only lines marked fired or sent; a tombstone of a
   paid kiosk order (paid twin) books nothing; a HubRise cancel after booking (status voided) runs
   the full refund rule; a sale closed before an APPROVED count but booked after it gets the paired
   STOCK_COUNT_ADJ so on hand still equals the count; items edited or a check moved after close are
   held; tip, customer and loyalty updates enqueue nothing.
8. **The operator.** Only a Back Office login of the venue releases a held row; it posts once;
   edit rows cannot be released; the hourly sweep finds a check the trigger missed (held for a
   person); paused keeps events and refuses browser posts, resume drains; an event that fails 8
   times is dead with its error and a released dead row posts once; the purge keeps held rows.
9. **Visibility and grants.** `stock_venue_mode`, `stock_outbox_health` (signed in, own venue),
   `stock_outbox_watch` (service role only). The API cannot run the drainer, read the outbox, apply
   an event, call `stock_explode`, flip the switch or reach `_post_stock_movement`; RLS on and zero
   API grants on the four tables; `supabase_realtime` unchanged; a SECURITY DEFINER procedure
   cannot COMMIT (why the drainer is INVOKER, owner only); three cron jobs.
10. **Concurrency.** Eight tills inserting at one venue at once; three drainers called together
    (one at a time: the advisory lock is taken per transaction, so one may hand over to another
    between two events; every event done once); four sessions posting one key at once (one row);
    one event applied by two sessions at once (done once, gone once).
11. **Invariants.** I1 on hand = opening + sum of movements for every item; I3 no key twice; the
    area holding equals on hand; every paid check at the central venue has a sale event (the sweep
    finds the two deliberately broken ones first).
12. **Parity.** 1,000 random baskets (sizes, id only lines, mods with qty, instruction and removed
    mods, every order type spelling, odd quantities) through SQL `stock_explode` and
    `src/lib/stock/explode.js` (wastage 0): 0 quantities differ beyond 0.0001.
13. **Provo replay** (optional, needs the read only dumps outside the repo): every real check
    agrees between SQL and explode.js; the ledger comparison is reported, not asserted (wastage no
    longer multiplies, recipes were edited after sales).
14. **Second run, ROLLBACK, run again, the guard.** Twice passes its guard, and the second run
    waits for none of 7 open writers (a till insert, stock posts, the outbox, the switch tables);
    the ROLLBACK drops triggers and jobs, restores the 20261018a texts of `post_stock_movement` and
    `post_stock_transfer_leg` (md5), opens the door, keeps tables and movements; the migration applies again; 20261018a's own ROLLBACK run out of order takes the
    posting core away (events wait with 42883, nothing lost) and both migrations put it back; the
    file stops, changing nothing, without 20261018a or with a changed `post_stock_movement`.
15. **Load.** 50 sites, each 60 stock items and 80 recipes of 3 to 6 lines; 300 checks a site
    (30 with `--quick`) of 10 lines plus a modifier, inserted as bound tills; the cost of the
    trigger per sale (600 inserts, no op venue vs central venue); drain rate (checks/s, movements/s)
    against the 4.2 checks/s target; I1 and I3 over every site; lock waits over 100 ms and deadlocks
    from the server log; then 8 tills x 100 inserts at one site with a drainer running.

16. **Review round 1 (19 Oct 2026)**, a fresh database, each case failed on the first build:
    a. a walk in or table voided BEFORE send (course 0 drinks fired at add) books nothing; sent then
       voided books the waste; a held course 2 line nothing; an old tombstone (no sent key) wastes
       only fired lines that are not course 0.
    b. catering refunded in full, voided, or part refunded (5 of 20) before its event: nothing
       made, nothing wasted (15 made for the part refund); refunded after the event: waste; the
       undo of a refund netted before the event is held for a person and cannot be released.
    c. a refund or void of a sale that is dead, held unproven, missing (enqueue lost), paid then
       voided with both enqueues lost, or held before_switch: held or waiting with its sale, then
       booked right after the sale is released or swept (cans net 0, patty -1 as waste); a refund
       of a sale the till booked before the switch still runs at once.
    d. an undo in backoff and then a channel cancel: the void waits; all 3 cans back.
    e. a sale before an approved count and one after it, drained together (batch 50 and batch 1):
       on hand = the count less the later sale (the guard's own late rows are not counts).
    f. the sweep writes a lost refund, void and undo.
    g. a till insert open while the switch runs: the sweep books it once by the grace rule.
    h. a drain call cut off by a timeout in a session that stays open holds no lock.
    i. posted keeps a row count only.
    j. 3,000 events drained beside 400 Back Office waste posts on the 5 hottest items and 150
       twelve line transfers: 0 deadlocks, every transfer done, Back Office waits under 100 ms, I1
       holds and the two areas add up to on hand.

## Measured after review round 1 (19 Oct 2026, the same Mac, full run: 206 checks, exit 0)

- One target hour: 15,000 checks enqueued in 12.1 s; drained in 70.0 s = **214 checks/s, 5,634
  movements/s** with one commit per event; 0 lock waits over 100 ms, 0 deadlocks. Trigger cost
  0.34 ms a sale (259 ms vs 462 ms for 600 inserts).
- A 3,000 event backlog at one site drained in 18.2 s beside 400 Back Office waste posts on its 5
  hottest items (max wait 11 ms) and 150 twelve line transfers (max 9 ms, all done): **0
  deadlocks** (before the fix: 37 to 54 deadlocks, waits up to 7.8 s, 32 transfers failed).
- A second paste with 7 open writers holding their rows: 47 ms, waits for none of them.
- Day one (no venue switched on): the cron drain returns in about 12 ms, no run row.

## Measured (18 Oct 2026, this Mac, local PG 17.10, fsync off)

- Trigger cost on a sale write: 600 single row inserts as a bound till, 251 ms at a browser venue
  (the no op gate) against 446 ms at a central venue (one outbox row): **about 0.33 ms a sale**.
- One target hour: **15,000 checks x 10 lines (+1 modifier) enqueued in 12.1 s** of client time;
  **drained 15,000 events, 394,550 movements in 80.7 s = 186 checks/s, 4,888 movements/s** by one
  drainer (target 4.2 checks/s: about 44x headroom). I1 and I3 hold over every site.
- **0 lock waits over 100 ms and 0 deadlocks** during the load (server log, `log_lock_waits`). One target hour grows the outbox 32 MB and the ledger 174 MB (about 440 bytes a movement with indexes; retention is a follow up).
- 8 tills x 100 inserts at one site with a drainer running: 800 events done in 5.2 s, 0 deadlocks, I1 holds at that site.
- Quick run (1,500 checks): 200 checks/s, 5,257 movements/s, 0 lock waits over 100 ms, 0 deadlocks.
- Parity: 1,000 random baskets, 3,481 quantities, 0 differ (SQL 1.2 s for all). The 259 real Provo
  checks: SQL and explode.js agree on every quantity; of the 56 the till depleted, 34 match the
  ledger exactly and 22 differ (wastage no longer multiplies, recipes edited after the sale).
- Stock screens trail a sale by about 3 s, up to 60 s (the cron minute).

## After the switch, on the live database (read only SQL)

```sql
-- the backlog and health of one venue
select public.stock_outbox_health('<venue uuid>');
-- every paid check since the switch (last 7 days: done rows are purged after that) has a done sale event
select count(*) from closed_checks c join stock_depletion_mode m on m.location_id::text = c.location_id
 where m.mode = 'central' and c.closed_at >= greatest(m.central_since, now() - interval '7 days') and c.closed_at < now() - interval '2 minutes'
   and c.id not like 'demo-%' and coalesce(c.source, '') <> 'booking' and not coalesce(c.voided, false) and coalesce(c.status, 'paid') not in ('void', 'voided')
   and not exists (select 1 from stock_outbox o where o.location_id = m.location_id and o.check_id = c.id and o.kind = 'sale' and o.status = 'done');
-- I1: on hand equals the ledger
select count(*) from inventory_items i where i.location_id = '<venue uuid>'
   and i.on_hand <> coalesce((select sum(qty_base) from stock_movements m where m.inventory_item_id = i.id), 0);
-- I3: no key twice
select location_id, idempotency_key, count(*) from stock_movements where idempotency_key is not null group by 1, 2 having count(*) > 1;
-- the drainer's runs
select * from stock_outbox_runs order by id desc limit 10;
```
