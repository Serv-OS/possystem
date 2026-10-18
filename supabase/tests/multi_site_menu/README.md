# Offline test for the Multi site menu migration

`run.mjs` applies `supabase/migrations/20261017_OPS_multi_site_menu.sql`, then round 2's
`20261017c_OPS_multi_site_menu_groups.sql` and then `20261018_OPS_multi_site_menu_category_fields.sql`
on top (as Peter runs them), to a **local, throwaway
Postgres 17** that copies the shape of the live Ops database, then checks every rule as the roles
PostgREST really uses, and drives the publish path **end to end with the real planner, health
check and push builder** (`supabase/functions/_shared/msm*.js`), exactly as `msm-publish` runs
them. It never connects to Supabase.

- `baseline.sql`: the Supabase roles WITH production's default privileges (new tables and
  functions are granted to anon and authenticated, the trap the migration must undo by name), the
  auth helpers as live, the vault, pg_net and pg_cron stand ins, and the menu tables with their live
  column lists (read 17 Oct 2026).
- `run.mjs`: two made up companies (two sites and one), a ServOS person, an editor, a viewer, an
  owner who was NOT added, and another company's editor.

## Run

```sh
initdb -D <scratch>/data -U postgres --auth=trust -E UTF8
LC_ALL=C pg_ctl -D <scratch>/data -o "-p 55991 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start
node supabase/tests/multi_site_menu/run.mjs
pg_ctl -D <scratch>/data stop
```

`MSM_PGHOST` and `MSM_PGPORT` override the address.

## The edge function itself

```sh
node supabase/tests/multi_site_menu/edge.mjs
```

Bundles `supabase/functions/msm-publish/index.ts` with rolldown (the bundler Vite ships), swaps
the Supabase client for `supabaseMock.mjs` (every call becomes real SQL on the harness database, as
the service role or as the signed in person, so grants, row level security and the functions all
apply), stands in `Deno.serve` and `Deno.env`, and calls the handler like the job and the Back
Office do. 17 Oct 2026: **27 of 27**: who may call it, publish now by the editor's call (a viewer is
refused), a scheduled set run by the job at its time and not before, a blocking problem at one site
while the other publishes, the pre check an hour before (words, no writes, the central tables not
touched), a company switched off pausing its sets, late marked once, and every message noted once
in the ledger, and a warm worker that never plans from an earlier request's list of changes. It found one real bug on its first run: two new categories whose central ids shared
their first 12 characters got the same venue id (the database refused the second; the planner now
falls back to the whole id).

## What run.mjs proves (17 Oct 2026: 134 of 134)

- The file applies as one transaction, twice; its check row reads as the file says.
- Only ServOS with the second step switches a company on and adds people; nobody adds themselves.
- The import writes the central tables only and changes nothing at any venue; it refuses a site of
  another company and a product id from another venue; a second import is refused.
- Row level security: the public key reads nothing; a viewer reads; the owner who was not added,
  and another company's editor, read nothing; central rows cannot be written from the browser.
- Staging: a site of another company, a field that is not allowed, a product not in the menu,
  another venue's product id and another company's editor are all refused.
- Schedule: due times on each site's clock (the database and the screen agree on both clock change
  weekends, London and Los Angeles); a scheduled set is frozen; unschedule keeps every change.
- Publish: the server claims due runs once, starts the version once, writes each venue in place
  (the Latte's own Lunch price untouched), creates a new category with its menu link, sends it to
  the same kitchen centre as the category it was sent like, inserts the config push with
  `pushSource`, writes the activity feed and the exact before and after; a second apply does
  nothing; a site with its own price gets nothing and no push.
- A venue saved between the read and the write is refused whole, then published on a fresh read.
- An option price follows its sub item.
- The write path refuses another venue's product, an id that exists, a venue owned column, another
  venue's category and the venue's menu tier prices.
- Failures in words, retry, the notification ledger (once), late (once), the job posts only when
  something is due, the cron key check, cancel, switching a company off pauses its sets and lifts the
  lock, switching it on resumes them.
- A new product moved into a category made later in the same set starts (dependency order, links
  checked at commit); throwing away a new product takes its site rows, a new category still used
  is kept, a whole draft still goes in one go.
- A scheduled run 7 hours late is never started by itself (failed in words once, Retry runs it); a
  Push to POS that landed after the read makes the site read again; a company switched off mid run
  leaves the site waiting.
- The write path refuses a venue's own product, option or category link (not managed by this menu),
  and a price change publishes even when the product already had a broken link.
- The roll back leaves no msm_ object and every venue row.

## Round 2 (option groups, sub items, VAT by order type), 17 Oct 2026

`round2.mjs` runs inside `run.mjs` (216 of 216 with round 1's checks), and `edge.mjs` now applies
20261017c too (34 of 34). They prove: the guard for the four new targets and VAT by order type; an
option price at one site writes ONLY that option by its venue id while an option the site added stays
put; the planner's picture of every written group equals the database row (patch, add, off, back
on, reorder) and the till push entry equals the row as Push to POS maps it; a new option gets
`opt-msm-<12 hex>` recorded centrally (two options sharing their first 12 characters never share an
id: the harness found that, the second gets the whole id); the same version twice gives one option; a
sub item missing at a site is added as option only and recorded; VAT keys one by one with a site's
counter key and explicit null untouched and only that site's rates; the tax profile copy cleared and
put back by Undo, a real profile refused; a save holding a row makes publish wait BEFORE the
fingerprint; keys the database does not know are refused ("redeploy msm-publish, then press Retry"); the managed lists,
sold recently and trading now; `msm__is_legacy_mirror` against the shared fixture list
(`src/lib/msm/msmMirrorFixtures.js`, the same list the planner and the till's engine are pinned to);
the one time refresh (`msm_import_groups`) saved only when every site is as read, once, never while a
draft holds option group changes, and then publishing would change nothing; the edge function's
refresh action, the contract fallback, and a group publish through the runner. The round 2 roll back
runs first, then round 1's.

## 17 Oct 2026 verification (248 of 248 with round 1's checks; edge.mjs 34 of 34)

`round2.mjs` also proves: a new VAT rate over a generated copy of the OLD rate publishes with the
copy cleared in the same write (the till then charges the new rate); a run whose worker died is not
claimed again after 5 tries, it fails in words, and Retry starts the count again (a busy moment after
a Retry goes back in the queue); an import from a page still on round 1 (no options) is refused in
words; sold recently and trading now need the second sign in step. `run.mjs` checks the round 2
check row's new columns (icon_ok, stuck_capped, retry_resets) and that the round 2 roll back puts the
scheduler functions and the group site foreign key back exactly as round 1 made them.

## 17 Oct 2026 recheck (270 of 270 with round 1's checks; edge.mjs 34 of 34)

22 more checks: 21 in `round2.mjs` (named RECHECK) and 1 in `run.mjs` (the check row). `round2.mjs`
also proves, through the database: a site's own product with NO Standard price is
brought in keeping "no price" (`kept.no_price`), the guard takes it (and refuses a `no_price` that is
not true, or one with a price of its own), publishing it writes nothing; a group price change leaves
that site with no price and says so, and the write path refuses a price nobody set there; a price set
there on purpose lands and takes `no_price` away; Undo writes "no price" again. A turn on whose id is
already the site's own product (in this menu) is refused at once, in words (Bring it in links it). A
takeaway Zero Rate on a product with sizes lands on the product and every size at each site (each
site's own rate, nothing else on the rows, a size's counter key kept), one VAT change per row, and
Undo puts every row back exactly; the write path takes an explicit null a size copies from its
product. `run.mjs` checks the round 2 check row's new column (no_price_ok).

## 17 Oct 2026 recheck, screens and drafts (282 of 282 with round 1's checks; edge.mjs 34 of 34)

12 more checks, all in `round2.mjs` (named BUILDER B). `round2.mjs` also proves, through the database: a product with an option group turned on at a site
where the group is not, then off again before publishing, leaves NOTHING in the draft (its two
option rows come out with it); Undo stages the turn on again exactly (the guard takes it) and it
publishes (the product and its group at that site). A third site of the company that already sells
the group's Latte as its own copy, plus a product of its own, JOINS (Add a site's "Join with what it
sells now", `msmBringIn.planJoinSite`): the guard takes the site row and the link, publishing writes
nothing there and sends no push, the site is in the group menu writing into its own menu, and its
rows are exactly as they were. A plain Add a site over a site's own product is still blocked, in
words that point to the join.

## 18 Oct 2026 follow up (290 of 290 with round 1's checks; edge.mjs 34 of 34)

8 more checks: 7 in `round2.mjs` (named FOLLOW UP) and 1 in `run.mjs` (the check row's new column,
category_fields_ok). Through the database: a category the group menu already has takes only "send
like" and removed or back; a new name, a new place or a new colour is refused in words (also on a
removal, and beside a send like); a new category takes every field and can be edited again before
publishing. `src/lib/msm/msmFollowUp.test.js` pins these counts to the files.

## 18 Oct 2026 recheck, the category rule as its own step (297 of 297 with round 1's checks; edge.mjs 34 of 34)

7 more checks: 1 in `round2.mjs` (named FOLLOW UP) and 6 in `run.mjs`. 20261017c had already run on
Ops (18 Oct) when the follow up wrote the category rule into it, so Ops never got the rule. The file
is back byte for byte as Ops ran it (every msm_ function body on Ops matched it, read only) and the
rule is its own file, `20261018_OPS_multi_site_menu_category_fields.sql`: one function and one
trigger, `msm_changes_guard_category`, which fires after `msm_changes_guard` (name order). `run.mjs`
now checks that 20261017c's check row has 15 columns and its guard no category rule (the old 18 Oct
check row check, reworded); that 20261018 applies once and twice, its check row reads
`t|t|0|0|2`, and every function 20261017c left is untouched; and that the 20261018 roll back runs
first, leaves no trigger or function, and touches nothing else. `edge.mjs` applies 20261018 too.
`round2.mjs` checks that the main guard still answers first. The FOLLOW UP checks above now pass
through the 20261018 trigger (they failed against 20261017c alone, as Ops is now).
`src/lib/msm/msmRunOnOps.test.js` pins 20261017c to the file Ops ran: any later change goes in a new
migration.
