# Database fence, stage 1: runbook for Peter

Written 18 Sep 2026. Branch `fix/database-fence-1`.

## What this is

- **Problem**: anyone with the public app key could write about 35 Ops tables and 6 Platform tables.
- **Worst holes**: fake a till and become staff of any venue; **delete a whole company** (and with it every venue, menu, staff member and subscription); move your own login into any venue; wipe or fake orders, tables and payments.
- **Stage 1 fixes**: devices, orders, tables, payments, plus companies, venues and logins (every fence rests on those).
- **You run every SQL file yourself**, outside service. Claude never runs them.

## The four files

| Step | File | Project | When |
|---|---|---|---|
| 1 | `20260919a_OPS_fence_1_safe_now.sql` | Ops | Now, outside service |
| 2 | `20260919c_PLATFORM_fence_1_safe_now.sql` | Platform | Now, any time |
| 3 | (the app release) | | After steps 1 and 2 |
| 4 | `20260919b_OPS_fence_2_after_app.sql` | Ops | After the release is on every device for a day |
| 5 | `20260919d_PLATFORM_fence_2_after_app.sql` | Platform | After the Back Office parts are live |

- **Each file checks the project**. Paste it in the wrong one and it stops, changing nothing.
- **Each file is all or nothing**. If it stops with an error, nothing changed. Fix the cause and run it again.
- **Running a file twice is safe.**
- **Each file ends with a check**. The editor shows one result row. What to expect is written below.
- **Each file ends with a roll back block** in comments.

## Before you start

- **Backup**: Supabase dashboard, Database, Backups. Check today's backup exists for both projects.
- **Outside service**: steps 1 and 4 lock a few busy tables for about 5 seconds. Tills may pause for those seconds.
- **Time**: about 10 minutes for step 1, plus walking to the tills in the re pair list.
- **Optional review** (read only, paste in the Ops SQL editor). It lists every login and the venues it is linked to. Look for anything you do not recognise:

```sql
select p.email, p.role as login_role, l.name as venue, ul.role as venue_role,
       (p.org_id = l.org_id) as same_company, ul.created_at::date as linked_on
  from public.user_locations ul
  join public.user_profiles p on p.id = ul.user_id
  join public.locations l on l.id = ul.location_id
 order by p.email, l.name;
```

- **What to look for**: on 18 Sep one owner login was linked to 5 venues in 4 companies. If that is not you, remove the extra links in the admin portal before step 1.

## Step 1: Ops file 1 (safe now)

**How**

1. Open the **Ops** project SQL editor (tbetcegmszzotrwdtqhi).
2. Paste all of `20260919a_OPS_fence_1_safe_now.sql`.
3. Press **Run**.

**Expect this result row**

- **allow_all_left**: `active_sessions, kds_tickets, order_queue, table_reservations` (file 4 closes those).
- **devices_kept**: `11` (it was 11 on 18 Sep).
- **devices_to_pair**: a list of venue, device name and type (12 on 18 Sep).
- **truncate_left**, **profile_policy_left**, **self_move_left**, **untrusted_links_left**: all `0`.

**If it stops with "STOPPED, NOTHING WAS CHANGED ... reach a venue only through their profile venue"**

- **Meaning**: a login can reach a venue only through its old profile setting, and that stops working.
- **On 18 Sep there were none**, so this only fires if something changed.
- **Fix**: send Claude the message. Or, if you know the person works there, paste their id into `v_keep` in step 4b of the file and run again.

**What closes**

- **Companies and venues**: nobody can delete them any more except you (super admin).
- **Logins**: nobody can move themselves into a venue, change their company, or switch on their own Back Office access.
- **Devices**: nobody can make a fake till. A paired till cannot be taken over with an old code.
- **Wipes**: TRUNCATE (which skips all rules) is gone from the app keys.
- **QR payments**: QR paid bills now reach reports (they were silently refused before).

**What staff see**

- **Nothing**, on the 11 tills that were used in the last 14 days.
- **The pairing screen** on the devices in `devices_to_pair`, at their next start. Pair them in step 1b.
- **Back Office "Show code"** is blank for paired tills. That is expected: press Regenerate when you need a code.
- **New codes last 60 minutes.** If a code "expired", press Regenerate.

**Step 1b: pair the listed devices again**

- On 18 Sep that was **12 devices**. The file marks them **removed**, so each one shows the pairing screen on its next start (never a till that half works):
  - **7** not seen for 14 days or more (1 clock, 1 kiosk, 5 tills, one of them with no venue).
  - **3** marked active that no till ever claimed (not seen for 30 days).
  - **2 tills signed in with a Back Office login that is not linked to that venue.** These were used this week. Either pair them again with a fresh code, or link that login to the venue in the admin portal first, then pair.
- **How**: Back Office, Hardware, Terminals (or Kiosks), press **Regenerate** on the device (its status says removed), type the code on the device.
- **Not used any more?** Press **Remove** instead.

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
-- the policies now on the fenced tables
select tablename, policyname, cmd from pg_policies
 where schemaname = 'public'
   and tablename in ('devices','organisations','locations','user_profiles','user_locations')
 order by 1, 2;
```

- **Smoke test** on a till: open a table, add an item, send it, take a cash payment, open a shift. Back Office: save a venue setting, switch venue, open Staff.

**Roll back**

- Paste the **ROLL BACK** block at the end of the file (remove the `-- ` at the start of each line).
- It puts back the open rules. It does not bring back retired codes or links: pair those devices again.

## Step 2: Platform file 1 (safe now)

**How**

1. Open the **Platform** project SQL editor (yhzjgyrkyjabvhblqxzu).
2. Paste all of `20260919c_PLATFORM_fence_1_safe_now.sql`.
3. Press **Run**.

**Expect**: `gift_writes_by_browser` false, `reader_protected_columns` false, `truncate_left` 0, and `gift_policies` lists three policies.

**What closes**

- **Gift purchases**: nobody can mark an online gift card paid or sent any more.
- **Card reader settings**: the Stripe configuration and uploaded screen fields are server only.
- **Wipes**: TRUNCATE gone. Platform venues: no browser writes at all.

**What staff see**: nothing. Card readers tipping save and the PAX idle image still work.

**Check**: Back Office, Card readers, change a tip and save. Gift cards, Online purchases still lists.

**Roll back**: the block at the end of the file.

## Step 3: the app release (Claude builds it, you test it)

- **The contract** is `docs/FENCE_STAGE_1_APP.md`.
- **Edge functions to deploy**: `payment-proof` (new), `location-admin`, `gift-list`, `gift-resend`, `gift-fulfill`.
- **Both web addresses** must get it: app.serv-os.app and possystem-liard.vercel.app.
- **Every till, KDS, kiosk and clock** must reload once to get it (a Sunmi may need a restart).
- **Print agents**: none ran on 16 Sep. If one runs, give it a key from Back Office first.

## Step 4: Ops file 2 (after the release)

**Wait until both of these are true** (read only checks):

```sql
-- 1. every active device on the new app (fence_v1 in client_caps)
select l.name as venue, d.name, d.type, d.app_version, d.client_caps, d.last_heartbeat_at
  from public.devices d left join public.locations l on l.id = d.location_id
 where d.status in ('active','online')
 order by 1, 2;
```

```sql
-- 2. a full day of customer orders through the new path (old_path must be 0)
select count(*) filter (where placed_via = 'rpc') as new_path,
       count(*) filter (where placed_via is distinct from 'rpc') as old_path
  from public.order_queue
 where source in ('online','qr','catering') and created_at > now() - interval '24 hours';
```

**How**: Ops SQL editor, paste `20260919b_OPS_fence_2_after_app.sql`, Run, outside service.

**The file checks it too.** If a device is not ready, or an old customer page still wrote an order, it stops and lists them. **Nothing changes** when it stops.

- **Device listed as "old app"**: switch it on and let it load for 2 minutes, then run again.
- **Device listed as "not paired"**: pair it, or press Remove if it is not used.

**Expect this result row**

- **open_policies_left**: `none`.
- **names_on_order_screens**: `true` (order screen TVs now show first names, as planned).
- **devices_readable_by_all**: `false`.
- **saved_codes_left**: `0`.
- **qr_floor_trigger**: `true`.

**What closes**

- **Orders, kitchen tickets, print jobs, tables, reservations, paid bills**: only the venue's own tills, Back Office, host stand (tables only) and server can touch them.
- **Customers** can only place, track and settle through the new server functions, and "paid" needs real proof from the card processor.
- **Devices**: nobody outside a venue can read its devices or pairing codes.

**What staff see**

- **Nothing**, if every device is on the new app.
- **A red banner** on a till that loses its link: "This till is not linked. Your open orders are safe on this till. Ask a manager to pair it again." Pair it; its work is sent once it is linked.
- **Order screen TVs** start showing first names.

**Smoke test**: online order and tracker, QR tab open, add a round, settle from the phone, catering order, kiosk order, KDS bump, a print, a table on the floor plan from a QR tab.

**Roll back**: the block at the end of the file puts back the open rules exactly.

## Step 5: Platform file 2 (after the Back Office parts)

**Wait until**: Card readers save and Gift cards, Online purchases work through the new server functions (contract P2 and P3), and gift resend works.

**How**: Platform SQL editor, paste `20260919d_PLATFORM_fence_2_after_app.sql`, Run.

**Expect**: `gift_readable_by_browser` false, `reader_writable_by_browser` false, `codes_left` equal to `kept_because_card_has_no_code` (normally 0).

**What closes**

- **Online gift card codes**: nobody can read them from the browser any more (today anyone can, and they are spendable).
- **Tip prompts**: nobody can change another venue's tipping screen.

**Roll back**: the block at the end of the file (cleared codes do not come back, each card keeps its own).

## Grandfathering: which devices keep working, and why

- **Kept**: a device used in the last 14 days, on a venue, active, bound to a device session (or to a Back Office login linked to that venue, or to you). **11 on 18 Sep.**
- **Why not re pair everything**: 11 tills were in use this week. Forcing all of them mid week is a bigger risk than the small chance one of them was faked.
- **Why not keep everything**: devices unused for 14 days, rows with no venue, the same till on two rows, and tills signed in with a login that is not linked to their venue carry trust nobody can vouch for.
- **Old codes are never trusted again**: every code was readable by anyone until today. A kept till can re link with its old code only from inside the venue network and only after its old login went quiet for 75 minutes. File 4 ends even that: tills then use a device secret.

## Things that catch people out

- **"Pairing code not found"** on a till that was fine yesterday: it was not used for 14 days. Regenerate in Back Office.
- **"Code expired"**: codes last 60 minutes now. Regenerate.
- **"Too many pairing attempts"**: wait 15 minutes. Wrong codes are limited on purpose.
- **"This device is paired and in use"** when you press Regenerate: the new Back Office asks before it disconnects a till.
- **Fixed but still broken?** Check the edge functions were deployed (`node scripts/check-deploys.mjs`).
- **Never** use `supabase db push`.

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
- **Prices**: the customer pages still work out totals in the browser; the server checks that money was taken, not that the price was right.
- **Customer display**: its broadcast channel can be joined by anyone who knows a till id.
