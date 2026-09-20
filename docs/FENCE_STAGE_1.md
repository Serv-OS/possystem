# Runbook one: what to run now

Database fence, stage 1. Written 18 Sep 2026. Split into two runbooks on 20 Sep 2026. Branch `fix/database-fence-1`.

**Runbook two** is `docs/FENCE_STAGE_1_PAYMENTS.md`. It is the payment half, and it comes later.

## What this closes today

- **Companies**: a stranger with the public app key can no longer delete a company, and with it every venue, menu, staff record and bill inside it.
- **Venues**: nobody can create, rename or delete a venue that is not theirs.
- **Tills**: nobody can invent a till and become staff of your venue. That was the worst hole of the 18 Sep audit.
- **Pairing codes**: only that venue's Back Office and you can see a code. Every old code stops working. A new code lasts 60 minutes and works once.
- **Logins**: nobody can move their own login into your venue, change their company, or switch on their own Back Office access.
- **Wipes**: TRUNCATE, which ignores every rule, is gone from the app keys.
- **Print agents**: a print agent needs its own key now. The bare app key is not a print agent.

## What it does NOT close yet

- **Online, QR and catering orders still decide their own price and their own paid.** That is the payment half, runbook two. Until it runs, a doctored customer page can still tell the database what an order cost and that it was paid.
- **The order tables stay open**: orders, kitchen tickets, tables and reservations keep their old open rules until the last file of runbook two.
- **Nothing on the floor changes because of this.** It is the same exposure as today, not a new one.

## The order of the day

1. **App release** and its edge functions go live.
2. **Step 1b** SQL file, two columns. Safe during service.
3. **Every till on the new version.** Check it.
4. **File a1** in the Ops SQL editor, outside service.
5. **Pair the two tills** that need pairing again, straight away.
6. **Later**: runbook two.

**You run every SQL file yourself.** Claude never runs them.

## Rules that apply to every file

- **App first, always.** A till on the old app cannot pair once a1 has run.
- **All or nothing.** If a file stops with an error, nothing changed. Fix the cause and run it again.
- **Twice is safe.** Every file can be run again.
- **One result row** at the end of each file says what happened.
- **A roll back block** sits in the comments at the end of each file.
- **Never** use `supabase db push`.

## Before you start

- **Backup**: Supabase dashboard, Database, Backups. Check today's backup exists for **both** projects.
- **Outside service** for a1. It locks the busy tables for about 5 seconds. If a till holds one for more than 3 seconds the file gives up, changes nothing, and tells you to wait 10 seconds and press Run again.
- **Check your logins** (read only, Ops SQL editor). Look for a login linked to venues in more than one company. On 19 Sep there were 2, one of them across 4 companies. If that is not you, remove the extra links in the admin portal first.

```sql
select p.email, p.role as login_role, l.name as venue, ul.role as venue_role,
       (p.org_id = l.org_id) as same_company, ul.created_at::date as linked_on
  from public.user_locations ul
  join public.user_profiles p on p.id = ul.user_id
  join public.locations l on l.id = ul.location_id
 order by p.email, l.name;
```

## Step 1: the app release

- **What**: the release described in `docs/FENCE_STAGE_1_APP.md`.
- **Both web addresses** get it: app.serv-os.app and possystem-liard.vercel.app.
- **Edge functions do not deploy themselves.** Deploy the list below, in that order, the same day.
- **Back Office**: reload every open tab afterwards. An old tab makes pairing codes in the browser, and those stop working after a1.
- **Print agents**: if one runs, give it a key first. Back Office, Hardware, Production printing, **Issue a print agent key**.

### The edge functions, in this order

Each line is one command: `npx supabase functions deploy <name> --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt`

1. **`stripe-webhook-connect`**, **`ryft-webhook`**.
2. **`gift-purchase-status`**, then **`gift-fulfill`**.
3. **`loyalty-otp`**, then **`loyalty-balance`**. Keep this order or the loyalty portal shows no points.
4. **The rest, any order**: `gift-issue`, `gift-import`, `gift-bulk-create`, `gift-config`, `gift-void`, `gift-resend`, `gift-list`, `gift-lookup`, `gift-redeem`, `gift-reverse-redeem`, `loyalty-earn`, `loyalty-redeem`, `loyalty-refund`, `loyalty-config`, `loyalty-rewards`, `loyalty-enroll`, `loyalty-member-lookup`, `promo-redeem`, `marketing-admin`, `stripe-refund`, `ryft-refund`, `workforce-compute`.
5. **`payment-proof`** (deploy it again even if it is live) and `location-admin`. It is what the payment half reads later, so it must be current.

- **Why so many**: every gift card, loyalty, promo and card refund function used to accept **any** login, and anyone can get one from the public app key. Each one now checks who is calling.
- **Leave the secret `LOYALTY_AUTHORITY_MODE` unset.** Until a1 runs, those functions only log a caller they would refuse. From a1 they refuse it.
- **Smoke test after deploying**: issue a small gift card, find it by its last 4, void it. Save a loyalty setting. On a till: a sale for a loyalty member, a reward, a gift card by code, a card refund.
- **Check nothing is left behind**: `node scripts/check-deploys.mjs`.

## Step 1b: two columns (safe during service)

- **What**: paste `supabase/migrations/20260919_OPS_fence_0_caps.sql` into the **Ops** SQL editor and press Run.
- **When**: the same time as step 1, before the tills reload if you can.
- **What it does**: adds two nullable columns to `devices` and nothing else. No policy, no grant, no row.
- **Why**: those columns are where a till records that it runs the new app. a1 will not run until every till switched on has said so.
- **Expect**: one row, `client_caps,device_secret_hash`.
- **If it says a till was busy**: nothing changed, wait 10 seconds and press Run again.

## Step 2: every till on the new version

- **Every till, KDS, kiosk and clock** must load the release once.
- **Sunmi tills keep the old code on a reload.** Force stop the app (swipe it out of recents, or Settings, Apps, Force stop) and open it again.
- **In Back Office**: Hardware, Network and sync. Anything behind shows **OUT OF DATE**. Switch venue to see each one.
- **Or one query** (read only, Ops). Every row seen today must show **true** under `reports_fence_app`. A version number on its own proves nothing.

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

- **a1 checks this itself** and stops while any device seen in the last 2 hours has not reported the new app. It names each one.
- **A device you cannot reach today** is fine only if it stays switched off. Switched on later with the old app it cannot pair: force stop and reopen it first.

## Step 3: run file a1

**First, see which devices will need pairing again** (read only, Ops): paste all of `supabase/tests/fence_stage_1/precheck_devices.sql`. One row per device.

- **kept**: keeps working, nothing to do.
- **unpaired_in_use**: used this week, but its link cannot be trusted. It needs pairing again.
- **removed**: not used for 14 days, no venue, or never paired. Nothing to do unless you still use it.

On 19 Sep: **kept 10**, **pair again 2 tills**, **removed 11**. The numbers move every day.

**The two pair again tills stop taking cards the moment a1 runs.** Nothing is charged and nothing is charged twice. Have a Back Office login ready and pair them first thing.

**How**

1. Open the **Ops** SQL editor (tbetcegmszzotrwdtqhi).
2. Paste all of `supabase/migrations/20260919a1_OPS_fence_identity_devices.sql`.
3. Press **Run**.
4. Read the result row below.
5. **Pair the pair again tills straight away.**

**Expect this result row**

- **allow_all_left**: `active_sessions, kds_tickets, order_queue, table_reservations`. Runbook two closes those.
- **devices_kept**: about `10`.
- **to_pair_in_use**: the tills the pre-check named.
- **codes_readable_by_strangers**: `false`.
- **truncate_left**, **profile_policy_left**, **self_move_left**, **untrusted_links_left**: all `0`.
- **placed_via_trigger**: `true`.
- **print_agent_table**: `true`.

## What staff see the moment a1 runs

- **Kept tills**: nothing. Each one collects a device secret within a minute, with no restart and no reload.
- **Pair again tills**: a red banner. "This till is not linked to {venue}. Your open orders are safe on this till. Ask a manager to pair it again." with **Check again** and **Pair again**.
- **Their work is safe**. Open tables, bar tabs, kitchen orders and paid bills stay on the till and are sent once it is paired.
- **Card payments stop on those tills** until they are paired. Take cash or use another till.
- **A kiosk that is not linked** never starts its card reader. The customer sees "Please ask a member of staff" and nothing is charged.
- **Everything else carries on**: online, QR, catering, the order tracker, the KDS, the TVs, the host stand, bookings and printing all work exactly as they did this morning.

## Pair a till again

1. In Back Office, **switch to its venue** (the venue name with the pin).
2. **Tills**: Hardware, Terminals. On a till marked **Waiting for pairing** press **New pairing code**. On one marked **removed** press **Show code**, then **New code**.
3. **Kiosks**: Channels, Kiosks, press the refresh arrow and confirm.
4. On the till, press **Pair again** on the red banner and type the code. It lasts 60 minutes.
5. **Pair each till as its own device**, not with a Back Office login. One login can be the identity of one till only.
6. **Not used any more?** Press **Remove** instead.

## Check it worked

```sql
-- every device and what happened to it
select l.name as venue, d.name, d.type, d.status, d.bound_via, d.last_seen,
       (select event || ': ' || coalesce(detail, '') from public.device_claim_log g
         where g.device_id = d.id order by g.at desc limit 1) as last_event
  from public.devices d left join public.locations l on l.id = d.location_id
 order by l.name, d.name;
```

```sql
-- kept tills that have not collected their device secret yet (empties within minutes)
select l.name as venue, d.name, d.type, d.last_seen
  from public.devices d left join public.locations l on l.id = d.location_id
 where d.bound_via is not null and d.device_secret_hash is null order by 1, 2;
```

- **Smoke test on a till**: open a table, add an item, send it, take a cash payment, open a shift.
- **Smoke test in Back Office**: save a venue setting, switch venue, open Staff, issue a pairing code.

## If a1 stops

- **"device(s) switched on in the last 2 hours have not reported the app release"**: each named device is not on the new app. Force stop and reopen it, leave it on for two minutes, then Run again. Or switch it off: it stops counting 2 hours after it was last seen.
- **"Run 20260919_OPS_fence_0_caps.sql first"**: step 1b was skipped. Run it, wait two minutes, Run again.
- **"A till was busy ... press Run again"**: nothing changed. Wait 10 seconds and Run again.
- **"reach a venue only through their profile venue"**: a login would lose a venue. Send Claude the message, or, if you know the person works there, paste their id into `v_keep` in section 4b of the file and Run again.
- **"File 2 (20260919b) has already run"**: the whole fence is finished. Nothing to do.

## Roll back a1

- **One line**: copy from the `-- -- ====` rule above **ROLL BACK** at the end of the file to the very end, paste it into the Ops SQL editor, select all, press **Cmd+/** once, press **Run**.
- **Order**: roll back the later files first. If the payment half (a2) is in, roll that back first. If the last file (20260919b) is in, roll that back before both. This block stops and says so.
- **What comes back**: exactly the rules, functions, grants and write grants of 18 Sep.
- **What does not**: retired pairing codes and the links the fence removed. Pair those devices again.

## Things that catch people out

- **"That pairing code is no longer valid"**: it is from before a1. Every old code is retired. Issue a new one.
- **"Pairing code not found"**: check the code, or issue a new one. Codes last 60 minutes and work once.
- **"Too many pairing attempts"**: that device tried 6 wrong codes. Wait 15 minutes.
- **A till on the old app cannot pair** and says "Pairing code not found" for every code. Force stop and reopen it, then pair it.
- **"Check the code: pairing codes never use 0, 1, I or O"**: a misread symbol. Codes use letters and the digits 2 to 9 only.
- **"This device is paired and in use"**: Back Office is asking before it disconnects a till.
- **"This till is not linked ... so it cannot take card payments"**: the red banner. Nothing was charged. Pair it again.
- **Fixed but still broken?** Check the edge functions were deployed: `node scripts/check-deploys.mjs`.

## Never run these

- **`20260907b_*`** (five files): the first draft of this fence.
- **Branch `fix/loyalty-giftcard-exposure`**: `20260918d`, `20260918e`, `20260918_PLATFORM_gift_purchases_server_only.sql`, `20260918b_PLATFORM_gift_purchases_clear_codes.sql`. This fence supersedes them.

## Then, when you are ready

- **Runbook two**: `docs/FENCE_STAGE_1_PAYMENTS.md`. The payment half (a2), the Platform files, and the last Ops file a full day after a1.
