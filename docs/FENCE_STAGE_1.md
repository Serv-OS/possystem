# Database fence, stage 1: runbook for Peter

Written 18 Sep 2026, fix rounds 1 and 2 on 19 Sep 2026 (round 2 added the money edge functions). Branch `fix/database-fence-1`.

## What this is

- **Problem**: anyone with the public app key could write about 35 Ops tables and 6 Platform tables.
- **Worst holes**: fake a till and become staff of any venue; **delete a whole company**; move your own login into any venue; read live pairing codes and gift card codes; wipe or fake orders, tables and payments.
- **Stage 1 fixes**: devices, orders, tables, payments, plus companies, venues and logins (every fence rests on those).
- **You run every SQL file yourself**, outside service. Claude never runs them.

## The order (it matters)

| Step | What | Where | When |
|---|---|---|---|
| 1 | **The app release** and its edge functions (30, in the order in step 1) | Vercel, Supabase functions | First |
| 1b | `20260919_OPS_fence_0_caps.sql` (two columns, nothing else) | Ops SQL editor | With step 1, safe during service |
| 2 | **Every till on the new version** | On the floor | Before step 3 |
| 3 | `20260919a_OPS_fence_1_after_release.sql` | Ops SQL editor | Outside service |
| 4 | `20260919c_PLATFORM_fence_1_after_release.sql` | Platform SQL editor | After step 1 |
| 5 | `20260919d_PLATFORM_fence_2_after_app.sql` | Platform SQL editor | After step 4 |
| 6 | `20260919b_OPS_fence_2_after_app.sql` | Ops SQL editor | A full day after step 3, outside service |

- **New names (fix round 2)**: files A and C used to end `_safe_now.sql`. Both wait for the app release, so they now end `_after_release.sql`.
- **App first, always.** The live app (v5.9.8) can lose a till's login when the Wi-Fi blips, and it pairs by reading codes off the devices table. After step 3 neither works: a till still on the old app can end up **unlinked with no banner**, and it **cannot be paired** at all. The release never loses a till's login, re-links with a device secret, and shows a red banner with **Pair again** whenever a till is not linked.
- **Step 3 checks this itself, and it does NOT trust a version number** (fix round 3): it stops, changing nothing, while any device switched on in the last 2 hours has not **reported the release itself**, and names each one with the version it last reported. Every till on the release says what it can do (`client_caps` `fence_v1`) within a minute of loading it; nothing else can say it. This replaced a check against a version string, which was useless: **v5.9.10 and v5.9.11 both shipped without a line of the fence app**, so every till on the floor passed it.
- **The fence release has no version number yet.** It goes out as v5.9.12 or later, and Claude fills the real number into `src/lib/version.js` and the changelog at release. Nothing in the SQL depends on it: step 3 only prints it.
- **Step 1b is why step 3 can check that.** It adds two columns to `devices` and nothing else: no policy, no grant, no row. Run it with the release, before the tills reload, so each one can record what it can do. It is safe during service. Skip it and step 3 stops and tells you to run it.
- **Each file checks the project**. Paste it in the wrong one and it stops, changing nothing.
- **Each file is all or nothing**. If it stops with an error, nothing changed. Fix the cause and run it again.
- **Running a file twice is safe.** Step 3 refuses to run once step 6 has run (that is on purpose). Step 6 refuses to run until **24 hours after step 3 first ran** (it reads the time step 3 recorded).
- **Each file ends with a check**. The editor shows one result row. What to expect is written below.
- **Each file ends with a roll back block** in comments. Every roll back puts back exactly what that file changed (function grants included), and can run twice. See "How to roll back" below.

## How to roll back

- **Order**: roll back the LATER file first. Step 6 before step 3 before step 1b (Ops); step 5 before step 4 (Platform). A roll back run in the wrong order stops at its first line, changes nothing, and says which file to roll back first.
- **Step 1b almost never needs rolling back**: two nullable columns hurt nothing, and step 3 needs them.
- **How**:
  1. In the file, find the heading **ROLL BACK** near the end.
  2. Copy from the `-- -- ====` line just above it to the very end of the file.
  3. Paste it into the SQL editor of the same project.
  4. Select all (**Cmd+A**), then press **Cmd+/** once. Every line loses its first `-- `. The notes still start with `-- ` and stay notes.
  5. Press **Run**.

## Before you start

- **Backup**: Supabase dashboard, Database, Backups. Check today's backup exists for both projects.
- **Run `20260919n_OPS_closed_checks_tenders.sql` first if you have not** (it came with v5.9.11, the Xero business day release). It adds `closed_checks.tenders`, which says what paid each check. Step 3's own order function keeps that on every online, QR and catering check it writes, and falls back to one card tender when a page sends none, so the accounts still balance either way. Without the column nothing breaks: the key is dropped and the sale is still recorded.
- **Outside service**: steps 3 and 6 lock the busy tables for about 5 seconds. Tills may pause for those seconds. No step reads a whole table to do its work, however big your history is (fix round 5: step 3's one widened rule on past bills is added without re-reading them, which it never needed to do). Every step, **step 1b included**, gives up after 3 seconds if a till is holding a table, changes nothing, and tells you to wait 10 seconds and press Run again.
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
- **Edge functions to deploy**: all of the list below, **in that order**, on the same day as the web app. Edge functions do not deploy by themselves.
- **Both web addresses** must get it: app.serv-os.app and possystem-liard.vercel.app.
- **Back Office**: reload every open Back Office tab after the release (an old tab makes pairing codes in the browser; those stop working after step 3).
- **Print agents**: none ran on 16 Sep. If one runs, give it a key first (Back Office, Hardware, Production printing, **Issue a print agent key**).

### Step 1 edge functions, in this order

**Why so many (19 Sep)**: every gift card, loyalty, promo and card refund function used to accept **any login**, and anybody can get one from the public app key. Now each one checks **who is calling** (a till linked to that venue, a Back Office login of that venue, the loyalty member themselves, or someone typing a full gift card or promo code). The rules, per function: `docs/FENCE_STAGE_1_APP.md` section 13.

Each line is one command, from the repo: `npx supabase functions deploy <name> --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt`

1. **`stripe-webhook-connect`**, **`ryft-webhook`**: a paid online gift card whose card could not be issued yet is now retried by Stripe and Ryft (it used to be dropped).
2. **`gift-purchase-status`**, then **`gift-fulfill`**: a gift card is issued only when Stripe or Ryft confirm the payment, one card per purchase, and only for the webhook or your Back Office.
3. **`loyalty-otp`**, then **`loyalty-balance`**: the member's sign in now carries the phone they proved; the portal refresh sends it. Keep this order, or the loyalty portal shows no points after step 3.
4. **The rest, any order**: `gift-issue`, `gift-import`, `gift-bulk-create`, `gift-config`, `gift-void`, `gift-resend`, `gift-list`, `gift-lookup`, `gift-redeem`, `gift-reverse-redeem`, `loyalty-earn`, `loyalty-redeem`, `loyalty-refund`, `loyalty-config`, `loyalty-rewards`, `loyalty-enroll`, `loyalty-member-lookup`, `promo-redeem`, `marketing-admin`, `stripe-refund`, `ryft-refund`, `workforce-compute`.
5. **`payment-proof` (deploy it again even if it is already live)** and, if not deployed yet, `location-admin`. Fix round 4: `payment-proof` now records what a loyalty reward IS (a free item and the items it covers, or a percent), which is how the server values it after step 3. Fix round 6: it records a free item reward that names **no** item too, which is the stamp card default. Without this deploy every free item, stamp card and percent redemption arrives **Payment short** for staff to confirm.

- **Not needed**, although `node scripts/check-deploys.mjs` may list them: `booking-reminders`, `customer-import`, `loyalty-reconcile`, `message-templates`, `order-notify`, `send-welcome`. Each bundles a shared file that changed (`_shared/loyalty-utils.ts` directly, or `_shared/gift-card-utils.ts` through `_shared/template-resolver.ts`), but the parts they use did not change in any way that matters: the clients, `json`, `authenticateCaller`, `resolveCompanyForLocation`, `getOrCreateConfig`, `generateMemberCode`, `generateReferralCode`, and `cors` (which only gained the `x-member-token` header). None of them moves money or balances. Deploying them anyway is harmless.
- **Leave the secret `LOYALTY_AUTHORITY_MODE` unset.** Until step 3, loyalty earn, redeem, refund and the till's points lookup only **log** a caller they would refuse (a till whose link is missing keeps working). From the moment step 3 runs they **refuse** it by themselves. Emergency only: set it to `report` (Supabase dashboard, Edge Functions, Secrets) and they go back to logging.
- **Everything else refuses at once**, from the deploy: issuing, importing, voiding or configuring gift cards needs a Back Office login of that venue; putting a spend back on a gift card or refunding a card payment needs that venue's till or Back Office.
- **Check it worked** (smoke test, straight after deploying): Back Office: issue a small gift card, find it by its last 4, void it; Online purchases lists; save a loyalty setting. Till: a sale for a loyalty member (points toast), a reward, a gift card by its code, a card refund. Online: sign in with the text code and use a reward (the points go down).
- **Refusals are in the function logs**: Supabase dashboard, Edge Functions, the function, Logs, search `[authority]`. Before step 3 a line there names a caller that step 3 will refuse (for example a till to pair again).
- **After step 3, what changes for staff**: a till with the red banner also cannot earn or redeem points, put money back on a gift card or refund a card (it says so; pair it again, or refund from Back Office). An online guest who does not sign in with the text code earns no points.
- **Check the deploys**: `node scripts/check-deploys.mjs` lists anything committed but not deployed.

## Step 1b: Ops, two columns (safe during service)

- **What**: paste `supabase/migrations/20260919_OPS_fence_0_caps.sql` into the Ops SQL editor and press **Run**.
- **When**: the same time as step 1. Before the tills reload, if you can.
- **What it does**: adds two nullable columns to `devices` and **nothing else**. No policy, no grant, no row is touched, and nothing is rewritten, so it is safe while the venue is trading.
- **Why**: those columns are where a till on the release records what it can do. Step 3 will not run until every till switched on has recorded it. Without this file no till can, and step 3 stops.
- **Expect**: one row, `client_caps,device_secret_hash`.
- **If it says "A till was busy with the devices table ... press Run again"** (fix round 5): adding a column needs the devices table to itself for a moment, and a till was holding it. Nothing changed. Wait 10 seconds and press **Run** again. It gives up after 3 seconds rather than making every till queue behind it, which is why this one is safe to run mid service.
- **Running it twice is safe.** Its roll back is in the comments at the end of the file, and refuses while step 3 is in.

## Step 2: every till on the new version

- **Why**: see "App first, always" above. This is the step that keeps tills linked.
- **Every till, KDS, kiosk and clock** must load the release once.
- **Sunmi tills**: a reload keeps the old code. **Force stop** the app (swipe it out of recents, or Settings, Apps, Force stop), then **open it again**.
- **Where to check (Back Office)**: Hardware, **Network & sync**. Each till shows `v` and its version; anything behind is flagged **OUT OF DATE**. Switch venue (the venue name with the pin, in the Back Office menu) to see each venue. KDS screens and kiosks show their version in the query below.
- **Where to check (every device, one query)**, read only, Ops SQL editor. Every row seen today must show `fence_v1` in `reports_fence_app`. The version columns are there to read, not to judge by: a new number alone does not mean the fence app. Old Sunmi tills that ran for days without a restart only show up through `heartbeat_version`, so this query reads both:

```sql
select l.name as venue, d.name, d.type, d.status,
       coalesce(d.client_caps @> array['fence_v1'], false) as reports_fence_app,
       d.app_version, h.version as heartbeat_version,
       greatest(d.last_seen, h.last_seen) as last_seen
  from public.devices d
  left join public.locations l on l.id = d.location_id
  left join lateral (select hb.version, hb.last_seen from public.device_heartbeats hb
                      where hb.device_id = d.id::text order by hb.last_seen desc limit 1) h on true
 where greatest(d.last_seen, h.last_seen) > now() - interval '14 days'
 order by 1, 2;
```

- **Step 3 checks this itself**: it stops while any device seen in the last 2 hours runs an older app or reports no version, and names each one. A device switched off stops counting 2 hours after it was last seen.
- **Every device reports itself** (fix rounds 2 and 3): every till, bar, tables screen, handheld, KDS, kiosk and clock on the release sends its version **and what it can do** with its heartbeat every minute while it is on, and every pairing writes it too. So a device on the release is never named by step 3; one that is named really is not running it.

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

**The 2 "pair again" tills stop taking cards the moment step 3 runs.** Their card payments are refused until they are paired again (nothing is charged, nothing is charged twice). So have a Back Office login ready and **pair them first thing**, straight after step 3 (step 5 below). For a venue whose only device is one of these tills that is cash only until it is paired, unless you link that owner's login to the venue in the admin portal before step 3 (then the till is kept).

**How**

1. Open the **Ops** project SQL editor (tbetcegmszzotrwdtqhi).
2. Paste all of `20260919a_OPS_fence_1_after_release.sql`.
3. Press **Run**.
4. Check the result row (below).
5. **Straight away, pair the "pair again" tills** (see "Pair a till again" below). Until then they take no card payments.

**Expect this result row**

- **allow_all_left**: `active_sessions, kds_tickets, order_queue, table_reservations` (step 6 closes those).
- **devices_kept**: about `10`.
- **to_pair_in_use**: the "pair again" tills from the pre-check (2 on 19 Sep).
- **removed_not_used**: about `11`.
- **codes_readable_by_strangers**: `false`.
- **truncate_left**, **profile_policy_left**, **self_move_left**, **untrusted_links_left**: all `0`.
- **placed_via_trigger**: `true`.
- **rules_open_to_customers**, **stamp_ledger_open**: both `false`.

**If it stops**

- **"... device(s) switched on in the last 2 hours have not reported the app release: ..."**: each named device has not said it runs the fence app (the version in brackets is the last one it reported). Force stop and reopen it (Sunmi), or reload it, and **leave it on for two minutes** so it reports itself. Or switch it off: it stops counting 2 hours after it was last seen. Then press **Run** again.
- **"Run 20260919_OPS_fence_0_caps.sql first"**: step 1b was skipped, so no device can prove anything. Run step 1b, wait two minutes, then press **Run** again.
- **"A till was busy ... press Run again"**: a till held a table for more than 3 seconds, or a deadlock was found. Nothing changed. Wait 10 seconds and press **Run** again.
- **"reach a venue only through their profile venue"**: a login would lose a venue. On 19 Sep there were none. Send Claude the message, or, if you know the person works there, paste their id into `v_keep` in step 4b of the file and run again.
- **"File 2 (20260919b) has already run"**: nothing to do, the fence is already finished.

**What closes**

- **Companies and venues**: nobody can delete them any more except you (super admin).
- **Logins**: nobody can move themselves into a venue, change their company, or switch on their own Back Office access. A staff record can no longer reach a login at another venue.
- **Devices**: nobody can make a fake till. **A device's venue is pinned**: it can only move in Back Office by someone who manages both venues, and moving it unpairs it.
- **Pairing codes**: only that venue's Back Office and you can see them. Every old code is retired. A code works once, for 60 minutes.
- **Wipes**: TRUNCATE (which skips all rules) is gone from the app keys.
- **Online, QR and catering orders**: "paid" is decided by the server. It prices the order ITSELF from your menu (each item and option by its id, never below your menu price, whole quantities), takes off only discounts it can prove (your automatic deals, a real promo code, which it uses up, and a loyalty reward redeemed for that order, worth only what the server can work that reward out to be), and checks the real payment covers that. An order it cannot prove yet reaches the venue marked **Payment being checked**. An order paid less than your menu says reaches the venue marked **Payment short**, with what was paid and what was due. Neither is ever marked paid by itself.
- **Only what your storefront really sells is priced** (fix round 4, narrowed in fix round 5): a line that is a size's parent row, an option only sub item, an archived item or an item that is **86'd** is one the server cannot value. It still goes to the kitchen, under your menu's own name, but the order arrives **Payment short** (or **Payment being checked**) for staff to confirm, and it is never free. Before round 4 those lines were worth nothing and rode along on a paid ticket.
  - **Two rules were dropped in round 5 because they were stricter than your own storefront**, and were turning honest fully paid orders into Payment short and refusing QR tab rounds outright. **"Hidden from Online"** (the Visible on toggle in Back Office) is a switch no storefront reads: an item you switch off is still on the Online and QR menu and still selling, so the server now prices it like any other. And a **0.00 item** (tap water, cutlery, a no charge side, an item with no price typed in) is priced at 0.00, because that is exactly what your storefront charges for it.
  - **`sold_alone` is deliberately looser here than on the storefront.** Online and the delivery app catalog hide any item whose Sold alone is off, whatever its type; the server hides only a **sub item** whose Sold alone is off. That column defaults to off in the database, so the strict rule would have refused real products. It costs nothing: such a line is priced at your menu price like any other.
  - **A 0.00 typed into a per menu price is a real price** (fix round 6). If an item is 4.00 normally and 0.00 on your kids menu, your storefront charges 0.00 for it on that menu, so the server prices it at 0.00 too. It used to hold the line at the 4.00 base and an honest, fully paid order came out short. The server cannot know which menu a basket was built on, so it takes the **lowest** price any of your menus gives that item, which is the same rule it has always used for your other menu prices.
  - **An extra the server cannot find on your menu is charged at your price for that name** (fix round 6). An option id that is on none of your modifier groups used to cost whatever the page said, so "Bacon" with a made up id rode a kitchen ticket at 0.00 while your own Bacon is 5.00, and the order still counted as fully paid. Such an option is now charged at the dearest price you charge for an option of that name. Free text your menu has no option for ("No onions", "Well done") is still free, because the storefront's own instruction boxes send ids that are on no group by design. A free extra printed on a kitchen ticket is still not proof the server priced it: it may simply be an instruction the customer typed.
- **One loyalty reward per order** (fix round 5): loyalty rewards used to be added together with no ceiling, so two genuine rewards redeemed against one bill (the storefront only ever applies one, but the page can be crafted) took a 125 pound order to 0.00 and it booked as **paid with no money at all**. Now the single dearest reward the server can value counts, and the whole loyalty discount can never be more than what is **left** to pay after your own automatic deals and any promo code. An order that claims more than that arrives **Payment short** for staff.
  - **A percent reward is worked out exactly where your storefront works it out** (fix round 6): on the basket after your **automatic deals**, before any promo code, with the promo code coming off beside it. Round 5 worked it out after the promo as well, which asked for more than our own page had charged: a guest using a 50 percent reward and a 10 percent code on a 125 pound basket was asked for 50.00, paid 50.00, and still landed in Payment short with no kitchen ticket and no way for "Check payment" to clear it.
  - **A free item reward that names no item is the cheapest line on the order** (fix round 6), which is what your storefront gives away, and what a stamp card normally is. The server used to value it at nothing, so **every** stamp card redemption arrived Payment short with the guest's stamp already spent.
- **A tip can only be money taken above the bill** (fix round 5 for a QR tab close, fix round 6 everywhere else): the tip was the last money field on a check still decided by the phone. A 95 pound order paid with a real 95 pound card payment could be sent with a subtotal of 0.00 and a tip of 95.00: the venue booked a **0.00 sale** and then paid 95 pounds of its own takings out through tronc, the Daily Trading P&L and the Xero posting. On every online, QR and catering check the server now books its **own** subtotal (your menu prices for what was ordered), allows a service charge and then a tip only out of money the payment really took **over** what the order owed, and rebuilds the tender list from its own figures whenever what the page sent does not add up (or claims a method no storefront takes, such as cash).
- **Discount deals and stamp cards**: only your Back Office can add or change an automatic deal (anyone could before), and only the server can write the stamp card ledger.
- **QR tabs**: a round that would take the tab past its card hold is refused. Only the person who opened the tab, someone who joined it with the table code, or staff can close it, and only the tab's own card payment counts. The app now sizes a new tab's card hold to at least its first round, so a first round is never refused (fix round 2).

**What staff see the moment it runs**

- **Kept tills**: nothing. Within a minute each one collects its device secret (it never needs a code again). A till that stays on screen collects it on its next heartbeat: no restart, no reload (fix round 2).
- **The "pair again" tills**: within a minute (or at their next save) a **red banner**: "This till is not linked to {venue}. Your open orders are safe on this till. Ask a manager to pair it again." with **Check again** and **Pair again**.
- **Their open tables, bar tabs and unsent work are not lost**:
  - **Open tables** stay on the till, and still reach the other tills (the tables table stays open to every till until step 6).
  - **Kitchen orders** still reach the kitchen (also open until step 6).
  - **What "open until step 6" costs you for that day and night.** Four tables keep their old "allow all" rules between step 3 and step 6, on purpose, so nothing on the floor breaks while the release beds in: `order_queue`, `closed_checks`, `active_sessions` and `kds_tickets`. Until step 6 runs, **anyone who has the public app key can still wipe a venue's order queue, insert an order marked paid, or book a fake past bill** (all four were proven on the test harness). It is the same exposure as today, not a new one, and step 3 closes everything else. Do not stretch the 24 hours: run step 6 the next day, outside service.
  - **Bar tabs** hidden on that till come back once it is paired.
  - **Paid bills** taken on it are kept on the till and sent once it is paired again.
  - **Changes to rows it can no longer see** (fix round 2): a bar tab closed or deleted, a refund, a table cleared, an order moved on, a kitchen ticket bumped, a print job marked. The database answers these with "nothing changed" instead of an error, so the till now counts what really changed. If nothing did and the till is not linked, the change waits on the till, in order, and is sent once it is paired again (proven with a fake database in `src/sync/offlineQueueFence.test.js`). Before this, the till counted them as sent, and a tab paid on it stayed open everywhere else. Pair it again the same day: a paid tab or table leaving the floor is always sent, but other kept changes older than 12 hours are held on the till (never sent blind, never dropped).
  - **Anything else refused** while it is not linked waits on the till (kept, never dropped) and is sent once it is paired again.
  - Pairing it again to the **same venue** wipes nothing.
  - **Pair it again straight away**: until then it cannot see bar tabs or past bills, and staff may not be able to sign in after a restart.
  - **Card payments stop on it the moment step 3 runs, until it is paired again.** The till itself checks its link before it starts any card payment, capture or card hold (fix round 2) and says why ("This till is not linked ... so it cannot take card payments. Nothing has been charged."); the card reader functions check it too. Nothing is charged twice; take cash or use another till. For a venue whose only device is one of these tills, that means cash only until it is paired: better, before step 3, link that owner's login to the venue in the admin portal (if they really work there), and the till is kept.
- **A kiosk that is not linked** (fix round 2) never starts its card reader: the customer sees "Please ask a member of staff" and nothing is charged. Before this it took the card and then could not save the order (after step 6). Pair it again (Channels, Kiosks).
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

- See "How to roll back" at the top. If step 6 has run, roll it back first: this one stops and says so.
- It puts back exactly the rules, functions, function grants and write grants of 18 Sep. It does not bring back retired codes or links: pair those devices again. Running step 3 again later starts step 6's full day again.

## Step 4: Platform file C

**Wait until**: the release's edge functions are deployed. Check: Back Office, Hardware, **Card readers**, change a tip and press **Save**: it saves.

**First, reload every Back Office tab** (fix round 3). A tab left open from before the release reads the online gift purchases list straight from the table; the release reads it through `gift-list` instead. An earlier draft of this file kept an "anyone may read" policy on that table to cover such a tab, but step 5 drops it minutes later, so it bought nothing and left a money table readable with the public key. It is gone: reload the tabs instead.

**How**: Platform SQL editor (yhzjgyrkyjabvhblqxzu), paste `20260919c_PLATFORM_fence_1_after_release.sql`, Run.

**Expect**: `gift_writes_by_browser` false, `reader_writable_by_browser` false, `reader_policies` = `location_reader_settings_read SELECT`, `truncate_left` 0, and `gift_policies` = `gift_card_purchases_company_read SELECT, gift_card_purchases_server ALL`.

**What closes**

- **Gift purchases**: nobody can mark an online gift card paid or sent any more.
- **Card reader settings**: nobody can change any venue's tip prompts or put a fake "scan to pay" image on its readers from the browser. Back Office saves them through the server.
- **Wipes**: TRUNCATE gone. Platform venues: no browser writes at all.

**Check**: Card readers, change a tip and save. PAX terminals, change the idle image. Gift cards, Online purchases still lists.

**Roll back**: the block at the end of the file (see "How to roll back"). If step 5 has run, roll it back first: this one stops and says so.

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
- **Roll back**: the block at the end of the file (see "How to roll back"; cleared codes do not come back, each card keeps its own).

## Step 6: Ops file B (a full day after step 3)

**Wait until all of these are true.** The file checks each one itself and stops, changing nothing, with the reason:

- **File A has been in for a full day**: 24 hours after step 3 FIRST ran (step 3 records the time; running it again later does not move it). Before that the file says when you may run it.
- **Every active device** reports the new app (`fence_v1`) **and** holds its device secret. Switch each kept device on for 2 minutes (Sunmi: force stop and reopen).
- **No unpaired device is switched on**: a till or kiosk that is on but not paired could take a card payment it can no longer save. Pair it again or switch it off. Only a device's own former session can report this, so nobody else can hold the file shut.
- **At least one customer order went through the new order function** in the last 7 days. On 19 Sep there were **no** online, QR or catering orders in 7 days, so **place one test online order** (pay with a real card and refund it, or use a gift card) and check it reached the till.
- **Fix round 2**: orders written straight into the orders table by an unknown caller no longer stop the file (anyone could write one during step 3's day, to hold it shut). The day after step 3 is what gives old customer pages time to reload. The result row counts them for you (`public_orders_24h`).

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
-- 2. who wrote the customer orders of the last day (rpc must be 1 or more over 7 days;
--    public rows no longer block the file, but look at them: real looking orders there
--    mean an old page may still be open somewhere, so wait another day)
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
- **public_orders_24h**: for information (usually `0`): customer orders of the last day written straight into the table by an unknown caller. From now on nobody can.

**What closes**

- **Orders, kitchen tickets, print jobs, tables, reservations, paid bills**: only the venue's own tills, Back Office, host stand (tables only) and server can touch them.
- **Customers** can only place, track, verify and settle through the new server functions.

**What staff see**

- **Nothing**, if every device is on the new app.
- **A red banner** on a till that loses its link; its work waits on the till and is sent once it is paired again.
- **Order screen TVs** start showing first names.

**Smoke test**: online order and tracker, QR tab open, add a round, a friend joins with the table code, settle from the phone, catering order, kiosk order, KDS bump, a print, a QR tab on the floor plan.

**Roll back**: the block at the end of the file (see "How to roll back") puts back the open rules exactly (the QR floor trigger stays, it only ever writes QR sessions). Roll this one back BEFORE step 3's. After it, file A may run again, or be rolled back.

## Things that catch people out

- **"That pairing code is no longer valid"**: it is a code from before step 3. Every old code is retired. Issue a new one.
- **"Pairing code not found"**: check the code, or issue a new one. Codes last **60 minutes** and work **once**.
- **"Too many pairing attempts"**: that device tried 6 wrong codes. Wait 15 minutes.
- **A till on the old app cannot pair** after step 3 (its pairing screen looks the code up first, and codes are hidden). It says **"Pairing code not found"** for every code, even a brand new one. **Force stop and reopen** it so it loads the new app (the new pairing screen shows the version under the box and the words "Type it with or without the dashes"), then pair it.
- **"Check the code: pairing codes never use 0, 1, I or O"**: the new pairing screen caught a misread symbol before sending it. Codes use letters and the digits 2 to 9 only.
- **"This device is paired and in use"** when you issue a code: Back Office asks before it disconnects a till.
- **Payment being checked**: an online, QR or catering order whose payment the server could not prove yet (usually a slow card processor). It is **not unpaid**: never charge it again. On the order in the Orders Hub, staff press **Check payment**; a manager can press **Confirm payment** after seeing the payment in the card processor. Both write the paid bill for reports.
- **Payment short** (fix round 2): the customer paid less than your menu says the order costs (a doctored page, a deal that ended while they paid, or an item that is no longer on the menu). The Orders Hub, the handheld and the kitchen ticket show **Payment short** with what was paid and what was due. **Never charge the full amount again.** Take the difference on the till if you want it, then a manager presses **Confirm payment** with a note (it books only what the online payment took, so nothing is counted twice).
  - **New in fix round 4**, two honest orders that now arrive this way instead of paid: a **loyalty reward the server could not value** (its redemption was too slow for the proof, or it is a free item that is not on the order), and a **line the storefront does not really sell** (86'd, archived, or a size's parent row). Both come through with the food, at the full menu price, for staff to confirm. If you see a lot of one of them, the cause is usually on your menu: an item that is 86'd all day, for instance.
  - **Fix round 5 took two of these away again**, because they were not doctored orders at all: an item **hidden from Online** (a switch the storefront does not read, so it is still selling) and a **0.00 item** (tap water, a free side) are now priced normally, and a QR tab round carrying one is accepted instead of refused.
  - **New in fix round 5**: an order claiming **more than one loyalty reward**, or a reward worth more than the bill has left, arrives Payment short with the one reward the server could value already taken off.
  - **Fix round 6 took three more away**, all of them honest customers who had paid in full: a **percent reward used with a promo code** (the server worked the percent out after the promo, our own page works it out before), a **stamp card reward that names no item** (the server valued it at nothing, our own page gives the cheapest line away), and an **item priced 0.00 on one of your menus** (the server held it at its base price). All three are now priced exactly as the storefront prices them.
  - **New in fix round 6**: an order carrying an **extra the server cannot find on your menu** but sent under one of your own option names arrives Payment short, charged at your price for that name. Genuine free text ("No onions", "Well done") is unaffected.
- **A QR tab marked Payment short** (fix round 2): the guest closed the tab on their phone and their card was charged, but for less than the tab. The Orders Hub shows **Payment short, paid X of Y** and the button **Close (already charged)**: it closes the tab booking only what the card paid, and never charges the card again. Take the rest on the till as its own sale.
- **"Please ask a member of staff" on a kiosk** (fix round 2): the kiosk is not linked to its venue, so it did not start the card reader. Nothing was charged. Pair it again.
- **"This till is not linked ... so it cannot take card payments"** (fix round 2): the till lost its link (red banner). Nothing was charged. Take cash or use another till, and pair it again.
- **Payment being checked QR orders on the floor plan** (fix round 2): a QR order whose payment the server has not proven yet is not put on the table until it is proven or a manager confirms it (rounds of an open tab always are).
- **"This round would take the tab past its card hold"**: a QR tab can only run up to its card hold. The guest closes the tab from their phone and starts a new one, or staff take the order on the till.
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
- **discounts** (manual till presets): open writes. (discount_rules, the automatic deals, is fenced by step 3 since fix round 2: the server prices orders from them.)
- **eighty_six**: anyone can mark items sold out at any venue.
- **item_variants, modifier_options**: open writes.
- **menu_categories, menu_category_links, menus**: write rules only check "is logged in", which an anonymous session passes.
- **package_lines, packages**: open writes.
- **print_routing, printer_agents, printer_health, printers**: open writes (print agents heartbeat here).
- **stamp_transactions**: open read (customer ids). Writes are server only since fix round 2.
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
- **gift and loyalty functions**: DONE in stage 1 (19 Sep): every gift card, loyalty, promo and card refund function now checks who is calling (step 1 list above; the parked branch `fix/loyalty-giftcard-exposure` stays parked, its function work is carried into this branch).
- **ryft-tab** (found 19 Sep, not changed): capture, void and overage of a Ryft tab hold accept any login, so a guest could release their own hold. The QR close on the phone uses it, so it needs the settle_qr_tab rules first.
- **send-welcome**: any login can make it send the welcome text or email to any customer id (a cost, not money).
- **workforce-clock**: any login plus a PIN clocks in at any venue; no PIN attempt limit.
- **uber-direct track_order**: courier details by venue and order reference.
- **order-notify**: finds orders by reference only.
- **Prices** (fix round 2, tightened in fix round 4, tips and tenders closed in fix round 6): the server now prices every online, QR and catering order from the menu and proves every discount, so the food itself can no longer be underpaid, and the subtotal, service charge, tip and tender list on the bill it books are its own. Still what the page says: delivery fees and US sales tax (a doctored page can leave those off, which only ever undercharges the customer), and a promo code's per customer limit (the server has no customer identity). The automatic deals the server works out follow the storefront's rules exactly; two deals of the same priority on the same items may be applied in a different order and show "Payment short" (staff confirm).
- **Loyalty rewards** (fix round 4, matched to the storefront in fix round 6): a reward is now worth only what the server can work out it is worth. A fixed amount reward is worth its amount; a percent reward that percent of the basket after your automatic deals (where the storefront works it out); a **free item** reward the cheapest matching item on that order (matched by name as well as by id, because loyalty is per company and menu ids are per site), or, when it names no item at all, simply the cheapest line on the order, which is what the storefront gives away. Anything else is worth **nothing** and the order arrives **Payment short** for staff to confirm: a reward redeemed too slowly for its proof to be written, a free item reward for something that is not on the order, or a reward set up in a shape the server does not know. Until round 4 a reward with no money value of its own (a free item, which is what stamp cards give, or a percent) was worth the **dearest single item on the basket** and stacked once per redemption: one genuine free coffee took 95 pounds off, and two took 190.
- **Promo codes** (fix round 2): a promo that covers a whole bill is now proven by the server and the order is paid. A catering pay later order only checks its code (the page records the use), so the same single use code on two pay later orders at the same moment can still count twice.
- **Customer display**: its broadcast channel can be joined by anyone who knows a till id.
