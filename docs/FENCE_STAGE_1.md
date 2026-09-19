# Database fence, stage 1: runbook for Peter

Written 18 Sep 2026, fix round 19 Sep 2026. Branch `fix/database-fence-1`.

## What this is

- **Problem**: anyone with the public app key could write about 35 Ops tables and 6 Platform tables.
- **Worst holes**: fake a till and become staff of any venue; **delete a whole company**; move your own login into any venue; read live pairing codes and gift card codes; wipe or fake orders, tables and payments.
- **Stage 1 fixes**: devices, orders, tables, payments, plus companies, venues and logins (every fence rests on those).
- **You run every SQL file yourself**, outside service. Claude never runs them.

## The order (it matters)

| Step | What | Where | When |
|---|---|---|---|
| 1 | **The app release** and its 5 edge functions | Vercel, Supabase functions | First |
| 2 | **Every till on the new version** | On the floor | Before step 3 |
| 3 | `20260919a_OPS_fence_1_safe_now.sql` | Ops SQL editor | Outside service |
| 4 | `20260919c_PLATFORM_fence_1_safe_now.sql` | Platform SQL editor | After step 1 |
| 5 | `20260919d_PLATFORM_fence_2_after_app.sql` | Platform SQL editor | After step 4 |
| 6 | `20260919b_OPS_fence_2_after_app.sql` | Ops SQL editor | A full day after step 3, outside service |

- **App first, always.** The live app (v5.9.8) can lose a till's login when the Wi-Fi blips, and it pairs by reading codes off the devices table. After step 3 neither works: a till still on the old app can end up **unlinked with no banner**, and it **cannot be paired** at all. The release never loses a till's login, re-links with a device secret, and shows a red banner with **Pair again** whenever a till is not linked.
- **Each file checks the project**. Paste it in the wrong one and it stops, changing nothing.
- **Each file is all or nothing**. If it stops with an error, nothing changed. Fix the cause and run it again.
- **Running a file twice is safe.** Step 3 refuses to run once step 6 has run (that is on purpose).
- **Each file ends with a check**. The editor shows one result row. What to expect is written below.
- **Each file ends with a roll back block** in comments. Every roll back puts back exactly what that file changed, and can run twice.

## Before you start

- **Backup**: Supabase dashboard, Database, Backups. Check today's backup exists for both projects.
- **Outside service**: steps 3 and 6 lock the busy tables for about 5 seconds. Tills may pause for those seconds.
- **Optional review** (read only, Ops SQL editor). Every login and the venues it is linked to:

```sql
select p.email, p.role as login_role, l.name as venue, ul.role as venue_role,
       (p.org_id = l.org_id) as same_company, ul.created_at::date as linked_on
  from public.user_locations ul
  join public.user_profiles p on p.id = ul.user_id
  join public.locations l on l.id = ul.location_id
 order by p.email, l.name;
```

- **What to look for**: on 19 Sep **2 logins** were linked to venues in more than one company, one of them to **5 venues in 4 companies**. If that is not you, remove the extra links in the admin portal before step 3.

## Step 1: the app release

- **What**: the release in `docs/FENCE_STAGE_1_APP.md` (built on this branch).
- **Edge functions to deploy**: `payment-proof` (new), `location-admin`, `gift-list`, `gift-resend`, `gift-fulfill`.
- **Both web addresses** must get it: app.serv-os.app and possystem-liard.vercel.app.
- **Back Office**: reload every open Back Office tab after the release (an old tab makes pairing codes in the browser; those stop working after step 3).
- **Print agents**: none ran on 16 Sep. If one runs, give it a key first (Back Office, Hardware, Production printing, **Issue a print agent key**).

## Step 2: every till on the new version

- **Why**: see "App first, always" above. This is the step that keeps tills linked.
- **Every till, KDS, kiosk and clock** must load the release once.
- **Sunmi tills**: a reload keeps the old code. **Force stop** the app (swipe it out of recents, or Settings, Apps, Force stop), then **open it again**.
- **Where to check (Back Office)**: Hardware, **Network & sync**. Each till shows `v` and its version; anything behind is flagged **OUT OF DATE**. Switch venue (the venue name with the pin, in the Back Office menu) to see each venue. KDS screens and kiosks show their version in the query below.
- **Where to check (every device, one query)**, read only, Ops SQL editor. Every row must show the release version:

```sql
select l.name as venue, d.name, d.type, d.app_version, d.last_seen,
       (select h.version from public.device_heartbeats h where h.device_id = d.id::text
         order by h.last_seen desc limit 1) as till_version
  from public.devices d left join public.locations l on l.id = d.location_id
 where d.status in ('active', 'online') and d.last_seen > now() - interval '14 days'
 order by 1, 2;
```

- **A device you cannot reach today**: that is fine only if it stays switched off until step 3 is done. Switched on later with the old app, it cannot pair: force stop and reopen it first.

## Step 3: Ops file A

**First, see exactly which devices will need pairing again** (read only, Ops SQL editor): paste all of `supabase/tests/fence_stage_1/precheck_devices.sql`. One row per device:

- **kept**: keeps working. Nothing to do.
- **unpaired_in_use**: used this week, but its link cannot be trusted. It will need pairing again.
- **removed**: not used for 14 days, no venue, or never paired. Nothing to do unless you still use it.

On 19 Sep (the numbers move every day, a till drops out after 14 idle days):

- **Kept: 10** (4 tills, 3 KDS, 2 handhelds, 1 kiosk).
- **Pair again: 2 tills** in use this week. Both are **signed in with an owner's Back Office login that is not linked to that venue** (one of them is the only device of its venue, so that venue has no linked till until it is paired again).
- **Removed: 11** (5 tills, 1 clock, 1 kiosk not used for 14 days; 1 till with no venue; 2 tills and 1 handheld never paired).

**If you can, close out the 2 "pair again" tills first**: settle open tables and bar tabs on them, or move them to another till. Nothing is lost if you do not (see below), but it is quicker.

**How**

1. Open the **Ops** project SQL editor (tbetcegmszzotrwdtqhi).
2. Paste all of `20260919a_OPS_fence_1_safe_now.sql`.
3. Press **Run**.

**Expect this result row**

- **allow_all_left**: `active_sessions, kds_tickets, order_queue, table_reservations` (step 6 closes those).
- **devices_kept**: about `10`.
- **to_pair_in_use**: the "pair again" tills from the pre-check (2 on 19 Sep).
- **removed_not_used**: about `11`.
- **codes_readable_by_strangers**: `false`.
- **truncate_left**, **profile_policy_left**, **self_move_left**, **untrusted_links_left**: all `0`.
- **placed_via_trigger**: `true`.

**If it stops**

- **"A till was busy ... press Run again"**: a till held a table for more than 3 seconds. Nothing changed. Wait 10 seconds and press **Run** again. The same for a "deadlock detected" message.
- **"reach a venue only through their profile venue"**: a login would lose a venue. On 19 Sep there were none. Send Claude the message, or, if you know the person works there, paste their id into `v_keep` in step 4b of the file and run again.
- **"File 2 (20260919b) has already run"**: nothing to do, the fence is already finished.

**What closes**

- **Companies and venues**: nobody can delete them any more except you (super admin).
- **Logins**: nobody can move themselves into a venue, change their company, or switch on their own Back Office access. A staff record can no longer reach a login at another venue.
- **Devices**: nobody can make a fake till. **A device's venue is pinned**: it can only move in Back Office by someone who manages both venues, and moving it unpairs it.
- **Pairing codes**: only that venue's Back Office and you can see them. Every old code is retired. A code works once, for 60 minutes.
- **Wipes**: TRUNCATE (which skips all rules) is gone from the app keys.
- **Online and QR orders**: "paid" is decided by the server from the real payment, never from a number the phone sends. An order it cannot prove yet reaches the venue marked **Payment being checked**.

**What staff see the moment it runs**

- **Kept tills**: nothing. Within a minute each one collects its device secret (it never needs a code again).
- **The "pair again" tills**: within a minute (or at their next save) a **red banner**: "This till is not linked to {venue}. Your open orders are safe on this till. Ask a manager to pair it again." with **Check again** and **Pair again**.
- **Their open tables, bar tabs and unsent work are not lost**:
  - **Open tables** stay on the till, and still reach the other tills (the tables table stays open to every till until step 6).
  - **Kitchen orders** still reach the kitchen (also open until step 6).
  - **Bar tabs** hidden on that till come back once it is paired.
  - **Paid bills** taken on it are kept on the till and sent once it is paired again.
  - **Anything else refused** while it is not linked waits on the till (kept, never dropped) and is sent once it is paired again.
  - Pairing it again to the **same venue** wipes nothing.
  - **Pair it again straight away**: until then it cannot see bar tabs or past bills, and staff may not be able to sign in after a restart.
- **Removed devices**: nobody should be using them. One that is switched on shows the same red banner; pair it again the same way, or switch it off.
- **Why a banner and not the pairing screen**: file A hides the row from a till that is no longer linked, and marks a till used this week "Waiting for pairing", never "removed". The release throws a till to the pairing screen only when it can read its own row and the row says removed, so these tills keep running with their work and the banner. (Before this fix round a removed till was thrown to a blank pairing screen the moment file A ran.)

**Pair a till again**

1. In Back Office, **switch to its venue**: the venue name with the pin, in the Back Office menu (it says Switch location).
2. **Tills**: Hardware, **Terminals**. On a till marked **Waiting for pairing**, press **New pairing code**. On one marked **removed**, press **Show code**, then **New code**.
3. **Kiosks**: Channels, **Kiosks**. Press **↻** (New pairing code) on the kiosk and confirm: the code shows.
4. On the till, press **Pair again** on the red banner and type the code (with or without the dashes). It lasts **60 minutes**.
5. **Pair each till as its own device**, not with a Back Office login. One login can be the till identity of **one** till only: pairing a second till with the same login unpairs the first. For the 2 "pair again" tills: on the till, **sign that Back Office login out first** (the till then gets its own device session), then Pair again. Or, if that person really works at that venue, link their login to the venue in the admin portal first.
6. **Not used any more?** Press **Remove** instead.

**Check it worked** (read only, paste one at a time)

```sql
-- every device and what happened to it
select l.name as venue, d.name, d.type, d.status, d.bound_via, d.last_seen,
       (select event || ': ' || coalesce(detail, '') from public.device_claim_log g
         where g.device_id = d.id order by g.at desc limit 1) as last_event
  from public.devices d left join public.locations l on l.id = d.location_id
 order by l.name, d.name;
```

```sql
-- kept tills that have not collected their device secret yet (should empty within minutes)
select l.name as venue, d.name, d.type, d.last_seen
  from public.devices d left join public.locations l on l.id = d.location_id
 where d.bound_via is not null and d.device_secret_hash is null order by 1, 2;
```

- **Smoke test** on a till: open a table, add an item, send it, take a cash payment, open a shift. Back Office: save a venue setting, switch venue, open Staff, issue a pairing code.

**Roll back**

- Paste the **ROLL BACK** block at the end of the file (remove the `-- ` at the start of each line).
- It puts back exactly the rules, functions and write grants of 18 Sep. It does not bring back retired codes or links: pair those devices again.

## Step 4: Platform file C

**Wait until**: the release's edge functions are deployed. Check: Back Office, Hardware, **Card readers**, change a tip and press **Save**: it saves.

**How**: Platform SQL editor (yhzjgyrkyjabvhblqxzu), paste `20260919c_PLATFORM_fence_1_safe_now.sql`, Run.

**Expect**: `gift_writes_by_browser` false, `reader_writable_by_browser` false, `reader_policies` = `location_reader_settings_read SELECT`, `truncate_left` 0, and `gift_policies` lists three policies.

**What closes**

- **Gift purchases**: nobody can mark an online gift card paid or sent any more.
- **Card reader settings**: nobody can change any venue's tip prompts or put a fake "scan to pay" image on its readers from the browser. Back Office saves them through the server.
- **Wipes**: TRUNCATE gone. Platform venues: no browser writes at all.

**Check**: Card readers, change a tip and save. PAX terminals, change the idle image. Gift cards, Online purchases still lists.

**Roll back**: the block at the end of the file.

## Step 5: gift cards whose code leaked, then Platform file D

**The problem**: until step 5, the code of every gift card bought online sat in a table anyone could read. A code someone copied can still be spent.

**First, count them** (read only, Platform SQL editor). Write the numbers down:

```sql
select c.company_id, count(*) as live_cards, sum(c.balance_minor) as balance_minor
  from public.gift_card_purchases p
  join public.gift_cards c on c.id = p.gift_card_id
 where p.fulfilled_at is not null
   and c.status = 'active' and c.voided_at is null and c.balance_minor > 0
   and (c.expires_at is null or c.expires_at > now())
 group by c.company_id order by 2 desc;
```

- **On 19 Sep**: **1 live card** (1 company), balance **£80.50**, out of 6 online purchases.
- **The safe option (proposed)**: **flag each card for its owner. Void nothing.** The owner decides card by card: leave it, or issue the buyer a new card for the same balance (Back Office, Gift cards) and void the old one. Watch these cards for unexpected spending for 30 days. The list for the owner (card id, last 4, balance, bought, last used) is the second query at the end of file D.

**Then run file D**

- **Wait until**: Back Office, Gift cards, **Online purchases** lists, and gift resend works.
- **How**: Platform SQL editor, paste `20260919d_PLATFORM_fence_2_after_app.sql`, Run.
- **Expect**: `gift_readable_by_browser` false, `codes_left` equal to `kept_because_card_has_no_code` (normally 0), `reader_writable_by_browser` false.
- **What closes**: online gift card codes, names and emails: nobody can read them from the browser any more.
- **Roll back**: the block at the end of the file (cleared codes do not come back; each card keeps its own).

## Step 6: Ops file B (a full day after step 3)

**Wait until all of these are true.** The file checks each one itself and stops, changing nothing, with the reason:

- **Every active device** reports the new app (`fence_v1`) **and** holds its device secret. Switch each kept device on for 2 minutes (Sunmi: force stop and reopen).
- **No unpaired device is switched on**: a till or kiosk that is on but not paired could take a card payment it can no longer save. Pair it again or switch it off.
- **File A has been in for a full day**, and no old customer page wrote an order in that day.
- **At least one customer order went through the new order function** in the last 7 days. On 19 Sep there were **no** online, QR or catering orders in 7 days, so **place one test online order** (pay with a real card and refund it, or use a gift card) and check it reached the till.

Read only checks you can run first:

```sql
-- 1. every active device on the new app, linked, with a device secret
select l.name as venue, d.name, d.type, d.app_version, d.client_caps, d.bound_via,
       d.device_secret_hash is not null as has_secret, d.last_heartbeat_at
  from public.devices d left join public.locations l on l.id = d.location_id
 where d.status in ('active', 'online')
 order by 1, 2;
```

```sql
-- 2. who wrote the customer orders of the last day (public must be 0; rpc must be 1 or more over 7 days)
select placed_via, count(*)
  from public.order_queue
 where source in ('online', 'qr', 'catering') and created_at > now() - interval '24 hours'
 group by 1;
```

- **ezCater orders** (catering orders from ezCater) are written by the server (`placed_via` server) and never block this step.

**How**: Ops SQL editor, paste `20260919b_OPS_fence_2_after_app.sql`, Run, outside service.

**Expect this result row**

- **open_policies_left**: `none`.
- **names_on_order_screens**: `true` (order screen TVs now show first names, as planned).
- **devices_readable_by_all**: `false`.
- **tills_without_secret**: `0`.
- **qr_floor_trigger**: `true`.

**What closes**

- **Orders, kitchen tickets, print jobs, tables, reservations, paid bills**: only the venue's own tills, Back Office, host stand (tables only) and server can touch them.
- **Customers** can only place, track, verify and settle through the new server functions.

**What staff see**

- **Nothing**, if every device is on the new app.
- **A red banner** on a till that loses its link; its work waits on the till and is sent once it is paired again.
- **Order screen TVs** start showing first names.

**Smoke test**: online order and tracker, QR tab open, add a round, a friend joins with the table code, settle from the phone, catering order, kiosk order, KDS bump, a print, a QR tab on the floor plan.

**Roll back**: the block at the end of the file puts back the open rules exactly (the QR floor trigger stays, it only ever writes QR sessions). After it, file A may run again.

## Things that catch people out

- **"That pairing code is no longer valid"**: it is a code from before step 3. Every old code is retired. Issue a new one.
- **"Pairing code not found"**: check the code, or issue a new one. Codes last **60 minutes** and work **once**.
- **"Too many pairing attempts"**: that device tried 6 wrong codes. Wait 15 minutes.
- **A till on the old app cannot pair** after step 3 (its pairing screen looks the code up first, and codes are hidden). It says **"Pairing code not found"** for every code, even a brand new one. **Force stop and reopen** it so it loads the new app (the new pairing screen shows the version under the box and the words "Type it with or without the dashes"), then pair it.
- **"Check the code: pairing codes never use 0, 1, I or O"**: the new pairing screen caught a misread symbol before sending it. Codes use letters and the digits 2 to 9 only.
- **"This device is paired and in use"** when you issue a code: Back Office asks before it disconnects a till.
- **Payment being checked**: an online, QR or catering order whose payment the server could not prove yet (usually a slow card processor). It is **not unpaid**: never charge it again. On the order in the Orders Hub, staff press **Check payment**; a manager can press **Confirm payment** after seeing the payment in the card processor. Both write the paid bill for reports.
- **Fixed but still broken?** Check the edge functions were deployed (`node scripts/check-deploys.mjs`).
- **Never** use `supabase db push`.

## Superseded files: never run these

- **`20260907b_*`** (five files): the first draft of this fence. Marked SUPERSEDED.
- **Branch `fix/loyalty-giftcard-exposure`** (parked, never merged): `20260918d_OPS_profile_venue_lock.sql`, `20260918e_OPS_venues_write_fence.sql`, `20260918_PLATFORM_gift_purchases_server_only.sql` and `20260918b_PLATFORM_gift_purchases_clear_codes.sql` are **superseded by this fence**. Running any of them after step 3 quietly rewrites the fence (same policy names, older rules). Do not run them. (`20260918_OPS_caller_authority_log.sql` on the same branch belongs to the parked edge function work, not to this fence.)

## Stage 2: still open after stage 1 (listed, not built)

**Ops tables**

- **activity_events**: "allow all", the activity bell can be spammed or read by anyone.
- **booking_preorders, booking_rules, booking_tables, bookings**: open write policies; bookings need their own fence.
- **config_pushes**: any session can write a menu snapshot for any venue.
- **device_profiles**: "allow all"; kiosk and customer display read branding from it.
- **discount_rules, discounts**: open writes.
- **eighty_six**: anyone can mark items sold out at any venue.
- **item_variants, modifier_options**: open writes.
- **menu_categories, menu_category_links, menus**: write rules only check "is logged in", which an anonymous session passes.
- **package_lines, packages**: open writes.
- **print_routing, printer_agents, printer_health, printers**: open writes (print agents heartbeat here).
- **stamp_transactions**: open read and write.
- **stock_levels**: open writes; `decrement_stock` and `restore_stock` have no search_path pin and no caller check.
- **tax_rates, tax_profiles, tax_profile_lines**: write rules only check "is logged in".
- **customers, customer_locations, customer_orders**: the anonymous escape hatch (customer PII), plus `attribute_public_order`.
- **receipt_emails**: readable by anyone.
- **staff_members**: a paired till receives every PIN of its venue (PINs are checked in the browser).
- **ops_devices**: its own fence is correct once logins are fixed (stage 1), but anon still holds write grants.
- **locations.created_by**: readable by anyone with the rest of the venue row (it names the login that created a new venue; it grants nothing since stage 1).

**Platform tables**

- **customer_loyalty, customer_stamp_cards, loyalty_config, loyalty_tiers, stamp_card_programs**: open to anyone; needs the Back Office loyalty screens moved to a server function first.
- **payment_devices**: three dead bluetooth write policies and the column read grant from 20260907b.
- **location_reader_settings reads**: tipping settings of every venue stay readable.

**Server code that trusts the caller too much**

- **api/stripe-capture.js and api/stripe-charge-overage.js** (Vercel): no login at all; anyone with a card payment id can capture or charge a saved card.
- **stripe-process-payment-on-reader**: trusts the till id sent in the body.
- **gift and loyalty functions**: "any login" is treated as authority (branch `fix/loyalty-giftcard-exposure` has the fix, parked).
- **workforce-clock**: any login plus a PIN clocks in at any venue; no PIN attempt limit.
- **uber-direct track_order**: courier details by venue and order reference.
- **order-notify**: finds orders by reference only.
- **Prices**: the customer pages still work out prices and discounts in the browser. Stage 1 makes "paid" mean "the real payment covers what the order itself says it costs" (its lines, less the discounts it declares, which staff can see); checking the prices themselves against the menu is stage 2.
- **Promo codes**: a promo that covers a whole online bill has no payment to prove, so that order arrives as "Payment being checked" until stage 2 adds a promo proof.
- **Customer display**: its broadcast channel can be joined by anyone who knows a till id.
