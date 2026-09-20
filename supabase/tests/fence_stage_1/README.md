# Offline tests for the stage 1 fence migrations

These run the five `20260919*` migrations (`20260919a1_OPS_fence_identity_devices.sql`, `20260919a2_OPS_fence_public_orders.sql`, `20260919b_OPS_fence_2_after_app.sql`, `20260919c_PLATFORM_fence_1_after_release.sql`, `20260919d_PLATFORM_fence_2_after_app.sql`) against a **local, throwaway Postgres 17** that copies the live shape of the tables they touch. They never connect to Supabase.

- `schema/*.json`: read only catalog dumps of the stage 1 tables (columns, constraints, unique indexes, policies, functions with their full ACL, triggers, grants; no rows). They are NOT kept in git: produce them with the read only queries in `schema_queries.sql` and save each result under the name it gives. Fix round 2 added the tables the server prices orders from (menu_items, modifier_groups, discount_rules, offers, promo_codes, promo_redemptions, loyalty_transactions, stamp_transactions), `indexes.json`, and `acl` on `functions.json`.
- `build_baseline.py`: turns the dumps into `.baseline.sql` (roles `anon`, `authenticated`, `service_role`, an `auth` schema with `uid()`, `users` and `sessions`, the tables, the live policies, functions, function ACLs and grants).
- `seed.sql`: made up companies, venues, logins and devices in every state the live data has (grandfathered, stale, duplicate, no venue, a till signed in with a login from another venue, a stranger who signs up with a real login), every device switched on in the last 2 hours reporting the fence app (fix round 3: `20260919_OPS_fence_0_caps.sql` has run and `client_caps` carries `fence_v1`, which is what file A gates on), and a small menu (items, a size, a menu tier, modifier groups of every kind: pick many, pick with qty and a nested sub group, with free and minus priced options), automatic deals, offers and promo codes. Fix round 4 adds the rows that are on a venue's menu but the storefront never sells (a variants parent, an archived item, an option only sub item, an 86'd item), rows the server cannot price (no pricing at all, and `{"base": 0}`), a sub item the venue DOES sell on its own, and an item hidden from Online. The last three are honest, sellable rows: fix round 5 uses them to prove the fence prices them like any other (no storefront reads `visibility.online`, and nothing hides a 0.00 row). `eighty_six` is a live table that is not part of the catalog dump, so `build_baseline.py` creates the two columns the app and the fence use.
- `precheck_devices.sql`: the runbook's read only pre-check (what file A will do to each device). `testA.py` proves it predicts the file exactly.
- `testA.py` (file 1: identity, the device exploit of 18 Sep and every variant, pairing codes, throttles, device secrets, venue codes, public orders priced by the server: normal orders with options, sizes, tiers, deals, promo codes and loyalty, the seven ways "paid" was forged plus the eighth of fix round 3 (a minus priced option repeated until the line is free, on an order and on a tab round, with the group and group-max rules and every legitimate option beside it), the ninth and tenth of fix round 4 (a loyalty reward with no money value of its own valued at the dearest item on the basket, including the reviewer's two scenarios to the penny; and a row the storefront never sells riding along free), the eleventh of fix round 5 (loyalty redemptions added up with no ceiling: ONE reward counts now, capped at the goods less the venue's deals and the promo code, and a percent reward is worked out on that same figure), what the storefront really does sell being paid normally on every channel, QR tabs and their hold, closing a tab, the tip a tab books, payment being checked and short), `testTrip.py` (file 1 stops, changing nothing: an unlinked profile venue, the fleet as it is today with no fence capability, a till with no capability, a heartbeat that cannot hold the file shut, step 1b skipped, a busy till), `testB.py` (file 2: its gates, what it closes, file 1 refusing to run after it), `testP.py` (both Platform files), `testRollback.py` (every roll back section, pasted whole and uncommented once, run twice, compared with the state before its file, function ACLs included, and each one refusing while the later file is in).

## Run

```sh
initdb -D /some/scratch/pgdata -U postgres --auth=trust -E UTF8
LC_ALL=en_US.UTF-8 pg_ctl -D /some/scratch/pgdata -o "-p 55432 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start
python3 build_baseline.py
python3 testA.py && python3 testTrip.py && python3 testSplit.py && python3 testB.py && python3 testP.py && python3 testRollback.py
pg_ctl -D /some/scratch/pgdata stop    # and delete the folder
```

`FENCE_PGHOST` and `FENCE_PGPORT` override the address. Every migration is applied the way the Supabase SQL editor runs a paste: the whole file as ONE transaction (`psql -1 -f`), so a file that stops has changed nothing. A roll back is run the way the runbook says: the whole section from its `-- -- ====` rule to the end of the file, each line losing its first `-- `.

On 19 Sep (fix round 2): 325, 12, 56, 20 and 39 checks (452), all passing.
On 19 Sep (fix round 3, rebased on v5.9.11): 349, 25, 56, 21 and 39 checks (490), all passing.
On 19 Sep (fix round 4): 373, 25, 56, 21 and 39 checks (514), all passing. `20260919_OPS_fence_0_caps.sql` (step 1b) is run by `testTrip.py`; `seed.sql` does what it does, because it is the state of the database on the night file A is pasted.
On 19 Sep (fix round 5): 393, 25, 56, 21 and 39 checks (534), all passing.
On 20 Sep (THE SPLIT): 434, 25, 31, 56, 21 and 48 checks (615), all passing (testA, testTrip, testSplit, testB, testP, testRollback).
On 20 Sep (fix round 7): 430, 25, 56, 21 and 39 checks (571), all passing.
On 19 Sep (fix round 6): 407, 25, 56, 21 and 39 checks (548), all passing. The rule this round: the
server must charge EXACTLY what our own storefront charged, and where the two differ the storefront
wins, because the customer paid what we asked. New in `testA.py`, each with the honest case PAID and
the matching forgery still refused: a percent reward used WITH a promo code (the percent comes off the
basket after the venue's automatic deals, `OnlineCheckout.jsx:891` and `:291`, with the promo beside it
at `:338`, so 50 percent plus MULTI10 on a 125 pound basket pays 50.00 and is paid, while two 50 percent
rewards are still ONE); a free item reward that names no item, the stamp card default, worth the cheapest
line the server priced (`OnlineCheckout.jsx:911-913`), while three such stamp cards still take off one
cheapest line; a menu tier typed as 0.00 priced at 0.00 (`menuPricing.js` `menuTierPrice:78-80`), while
the item beside it is still floored at its own price; an option id on no modifier group charged at the
venue's price for that NAME, while genuine free text stays free and still reaches the kitchen; and the
money on the check itself, where a 95 pound order sent as subtotal 0.00 with a 95 pound tip now books a
95.00 sale, no tip and a rebuilt card tender, an honest 2.00 tip is kept, and a card sale declared as
cash is rebuilt as the card it was. `seed.sql` gains `mi-kidsdrink` (`{"base": 4, "menus": {"menu-kids":
{"all": 0}}}`). Every one of those was run against the round 5 file first: the two blockers refused the
honest customer who had paid in full, the 0.00 tier came out short, and the check booked the phone's
own subtotal, tip and tenders. New in `testA.py`: the ELEVENTH way to forge paid (loyalty redemptions added up with no ceiling, the reviewer's three scenarios to the penny: two 50 percent rewards on 125 pounds, 10 plus 20 percent, three stamp free coffees against one coffee), one reward of each kind on its own still paying the order, a percent reward taken off what is LEFT after the venue's deal and the promo code, and the FIX ROUND 5 block: an item hidden from Online, a 0.00 item and an item with no pricing are all sold and PAID like any other, a plain live item is paid on all five channels (online, delivery, drive thru, QR, catering), a QR tab round carrying a free side is accepted instead of refused, and a QR tab's tip is capped at what the card took over the rounds. Every one of those was run against the round 4 file first: the three loyalty scenarios booked as PAID for nothing, the honest orders came out "short", the tab round was refused and the tab booked subtotal 0.00 with a 95 pound tip.

Each check runs as a PostgREST caller would: `set local role` plus `request.jwt.claims` (and `request.headers` for the caller's network), inside a transaction that is rolled back unless the test needs the change to stay.

## Fix round 7 (20 Sep 2026)

Round 6 kept the rule ("charge exactly what our own storefront charged") but broke the honest
direction twice, and both are in `testA.py` now, each with the honest case PAID and the forgery
still refused:

- **An option the server cannot match by id is worth NOTHING.** Round 6 charged it at the
  dearest menu price of any option with the same NAME, which charged the storefront's OWN free
  instruction picks and typed notes: they arrive with an `ig-<group>-<value>` id that is on no
  modifier group (`OnlineItemSheet.jsx:450`) or with no id at all (`InlineItemFlow.jsx:271`,
  `ProductModal.jsx:169`, `kioskBasket.js:51`), always at price 0. At a venue whose instruction
  wording matches one of its option names ("Sauce", "Cheese") a guest who had paid in full came
  out short with no kitchen ticket. New checks: three free instruction picks PAID and printed
  free on the ticket and on the check; the accepted cost written down (a made up option id can
  ride a ticket for nothing); and a minus priced unmatched option still unable to take a penny
  off, so round 3's forgery stays shut.
- **A 0.00 menu tier is a price on its own menu only.** Round 6 let it into the lowest price of
  any menu, so an item free on one menu was free to order on all of them (the reviewer's basket:
  one 3.00 Coffee plus ten 0.00 Kids Squash, PAID for 3.00). The page now sends `menu_id` (the
  surface's `effectiveMenuId`), the server prices from that menu, and with no menu id it ignores
  0.00 tiers and floors at the lowest price above zero. New checks: the kids menu order PAID on
  `menu-kids` and the menu kept on the order; the same basket SHORT with no menu named and with
  a different menu named; the honest old page order short rather than free; and the happy hour
  2.50 tier priced both ways.

And four more, each with its honest case beside it: a free item reward that names no item is
bounded (15.00, or the programme's own `max_minor`); the tender SPLIT is proven, not just its
sum (a 95.00 card sale moved onto a loyalty line, and a gift card leg with no gift debit, are
both rebuilt); the check's own `method` and `payment_method` are the server's, so a card sale
declared as cash books as card even with no `tenders` column; a courier fee and added-on US
sales tax are out of the tip headroom while UK inclusive VAT is not; and a closed QR tab carries
a server built tender list.

## The split (20 Sep 2026)

File A is two files now, because Peter asked for the identity and device half to go in before the
payment rules were finished: `20260919a1_OPS_fence_identity_devices.sql` (sections 0 to 6g plus
the print agent keys) and `20260919a2_OPS_fence_public_orders.sql` (section 6h and section 7).
It was a cut, not a rewrite: every rule is byte for byte what it was, and the only change to a
copied statement is the lock list, because each half locks the tables it really touches.

- `t.apply_a()` and `t.rollback_a()` run both halves in the right order, so every older check
  reads the same as before.
- `testSplit.py` (new, 31 checks) is a1 on its own: it applies and is idempotent, a2 refuses
  until it is in and changes nothing when it refuses, pairing and heartbeats work, and with only
  a1 in a till, a kiosk, a KDS, the host stand, bookings, printing, online, QR, catering and the
  order tracker all still use the exact paths they use today (the order tables keep "allow all",
  the customer writes still go straight in stamped `public`, the menu and venue reads are
  untouched, and the deal tables are still open because closing them is a2's job).
- `testRollback.py` gained the a1-alone roll back (back to exactly the 18 Sep state with no
  payment half in), a1 refusing to roll back while a2 is in, and a2 refusing while file B is in.
- `testA.py` applies a1 then a2 and checks each half's own verification row.
