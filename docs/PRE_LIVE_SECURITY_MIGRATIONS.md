> **STATUS 8 Sep 2026: DRAFT, DO NOT RUN.** The adversarial pass found 12 breaks and 25 gaps (listed at the end of this file) that are not applied yet. Fix pass first.

# Pre live security migrations: runbook

Written 7 Sep 2026 against the 4 Aug readiness audit (`PRE_STAGE_READINESS.md`), the 5 and 6 Aug catalog baselines (`000_baseline_ops.sql`, `000_baseline_platform.sql`) and every call site in `src/` on that day.

Five SQL files. Three run now. Two wait for app changes.

**Nothing in this runbook is applied by Claude.** Claude cannot run DDL on either project. You paste each file into the SQL editor of the right project, press run, then paste the verification block at the bottom of the file.

## The files at a glance

| # | File | Project | Run when | Needs app change first |
|---|------|---------|----------|------------------------|
| 1 | `20260907b_ops_rls_1_fences_and_rpcs.sql` | Ops `tbetcegmszzotrwdtqhi` | Now | No |
| 2 | `20260907b_ops_rls_2_pairing.sql` | Ops | Now, then re pair unbound devices | No |
| 3 | `20260907b_ops_rls_3_after_app.sql` | Ops | After A1 to A14 and P1 are live | **Yes** |
| 4 | `20260907b_PLATFORM_anon_writes_1_safe_now.sql` | Platform `yhzjgyrkyjabvhblqxzu` | Now | No |
| 5 | `20260907b_PLATFORM_anon_writes_2_after_app.sql` | Platform | After P2 (section 1) and P3 (section 2) | **Yes** |

Each file starts with a guard that aborts if it is pasted into the wrong project. Each file is idempotent: you can run it twice.

## Order

1. **Snapshot** both projects first (Dashboard, Database, Backups).
2. Ops file 1.
3. Ops file 2, then **re pair** every device the notice lists.
4. Platform file 1 (independent of 2 and 3, any time).
5. Ship the app changes A1 to A14 and P1. Deploy to every device. Wait a day.
6. Ops file 3.
7. Ship P2, then run Platform file 2 section 1. Ship P3, then run section 2.

**Do not** use `supabase db push`. It would replay the obsolete 20260429 tenant RLS files.

## What is closed after files 1, 2 and 4 (no app change)

- **Customer PII** (finding 1): anonymous sessions and the raw anon key can no longer read, update or delete `customers`, `customer_locations`, `customer_orders`. Paired devices and Back Office users keep their own venues. Closed by restrictive fences.
- **Pairing theft** (finding 4): `claim_device` refuses a device bound to another session, codes are single use and expire, misses are rate limited, and the `devices` table is fenced.
- **Platform locations** (finding 2): no browser write path at all, not even by grant.
- **Ten of the fifteen "allow all"** tables (finding 3): activity_events, kds_tickets, table_reservations, eighty_six, item_variants, modifier_options, stamp_transactions, organisations, locations, devices. Plus writes on device_profiles.
- **Catalog writes** fenced only on `auth.role()`: menus, menu_categories, menu_category_links, stock_levels, config_pushes, discount_rules, tax_rates, tax_profiles, tax_profile_lines.
- **closed_checks** insert is no longer `WITH CHECK (true)`.
- **decrement_stock / restore_stock** pinned and fenced.
- **TRUNCATE / REFERENCES / TRIGGER** revoked from browser roles on both projects.
- **payment_devices** pairing secret withheld from the anon read.

## What waits for the app (files 3 and 5)

- `order_queue` and `active_sessions` keep "allow all" until the tracker, QR and catering screens call the new RPCs.
- The legacy `customers_all` trio stays (already neutralised by the fences) until attribution uses the RPC.
- The pairing screens keep an interim anonymous read of unbound rows with a live code.
- `device_profiles` reads stay open until the customer display uses the RPC.
- Platform loyalty, gift and card reader tables keep their `USING(true)` policies until the Back Office writes move behind an edge function.

---

## File 1: `20260907b_ops_rls_1_fences_and_rpcs.sql` (Ops, run now)

### What it does

- **Helpers.** `user_accessible_locations()` and `user_accessible_orgs()` become SECURITY DEFINER with a pinned search_path (body unchanged, replaced in place because 136 policies depend on them). New helpers: `pos_accessible_location_keys()`, `pos_accessible_location_ids()`, `pos_accessible_org_ids()`, `caller_org_id()`, `is_active_public_location()`.
- **Customers.** Restrictive fences on the three customer tables that deny anonymous sessions and the raw key. Permissive tenant policies alongside the legacy ones. New RPCs `attribute_public_order` (online, QR, catering) and `customer_lookup_by_phone` (kiosk, display).
- **Allow all swaps.** activity_events, kds_tickets, table_reservations, eighty_six, item_variants, modifier_options, stamp_transactions, organisations, locations, device_profiles (writes). Restates the already gone user_locations and user_profiles "allow all". Adds a restrictive rule so an anonymous session can only read its own user_profiles row.
- **Public checkout.** order_queue and active_sessions get their replacement policies alongside "allow all" (no effect yet). closed_checks insert is narrowed. RPCs created: `order_track_check`, `order_track_row`, `qr_table_open_tabs`, `qr_tab_rounds`, `qr_table_tab_count`, `catering_day_load`, `sync_qr_table_session`, `qr_close_tab`.
- **Catalog.** The `*_auth_write` and "Allow authenticated access" write policies are replaced with tenant fences. Reads stay public.
- **Stock RPCs.** search_path pinned, quantity capped, caller fenced; EXECUTE revoked from public and anon. `upsert_customer_visit` revoked (no callers).
- **Grants.** TRUNCATE, REFERENCES, TRIGGER revoked from anon and authenticated on every table.

### What changes for people

- **Nothing** for Back Office users with a `user_locations` row.
- A Back Office user whose only access is `user_profiles.location_id` now **sees customers** (was blind).
- Paired kiosks and tills can now **save customers** (the old policy refused them; the console said "may be RLS").
- Online and QR order attribution keeps failing silently exactly as it does today, until A1 ships. Verify it really is dead today before you run the file:

```sql
select channel, count(*), max(created_at) from public.customer_orders
 where created_at > now() - interval '30 days' group by channel;
select source, count(*) from public.customers
 where created_at > now() - interval '30 days' group by source;
```

  If there are recent `online` rows, stop and tell Claude: the write path differs from the code read on 7 Sep.

- A till that never ran `claim_device` gets **no customer search results** until it re pairs. It already cannot read staff or closed checks.

### How to run

- Ops project, SQL editor, paste the whole file, run. Expect one notice about `handle_new_user`.
- Then paste the V block at the bottom, check each expectation.

### Smoke test

- Back Office: open Customers, edit one, save. Open Menu, save a category. Tax, save a rate.
- Till: search a customer by phone, attach to a check, close it. Check the activity bell still updates.
- Kiosk: place an order with a phone number. Back Office Customers should show it.
- Online: place an order, open the tracker link. Still works (allow all still on).
- QR: open a tab, add a round, settle. Still works.

### Roll back

```sql
-- customers: remove the new fences (legacy *_all policies are still there)
drop policy if exists customers_fence on public.customers;
drop policy if exists customer_locations_fence on public.customer_locations;
drop policy if exists customer_orders_fence on public.customer_orders;
drop policy if exists customers_tenant on public.customers;
drop policy if exists customer_locations_tenant on public.customer_locations;
drop policy if exists customer_orders_tenant on public.customer_orders;
drop policy if exists up_no_anon_read_others on public.user_profiles;

-- the allow all swaps
create policy "allow all" on public.activity_events   for all to public using (true) with check (true);
create policy "allow all" on public.kds_tickets       for all to public using (true) with check (true);
create policy "allow all" on public.table_reservations for all to public using (true) with check (true);
create policy "allow all" on public.eighty_six        for all to public using (true) with check (true);
create policy "allow all" on public.item_variants     for all to public using (true) with check (true);
create policy "allow all" on public.modifier_options  for all to public using (true) with check (true);
create policy "allow all" on public.organisations     for all to public using (true) with check (true);
create policy "allow all" on public.locations         for all to public using (true) with check (true);
create policy "allow all" on public.device_profiles   for all to public using (true) with check (true);
create policy anon_read_stamp_tx on public.stamp_transactions for select to public using (true);
create policy service_all_stamp_tx on public.stamp_transactions for all to public using (true) with check (true);

-- catalog writes and closed_checks insert
create policy menus_auth_write on public.menus for all to public
  using (auth.role() in ('authenticated','anon')) with check (auth.role() in ('authenticated','anon'));
create policy menu_categories_auth_write on public.menu_categories for all to public
  using (auth.role() in ('authenticated','anon')) with check (auth.role() in ('authenticated','anon'));
create policy menu_category_links_auth_write on public.menu_category_links for all to public
  using (auth.role() in ('authenticated','anon')) with check (auth.role() in ('authenticated','anon'));
create policy stock_levels_auth_write on public.stock_levels for all to public
  using (auth.role() in ('authenticated','anon')) with check (auth.role() in ('authenticated','anon'));
create policy config_pushes_auth_write on public.config_pushes for all to public
  using (auth.role() in ('authenticated','anon')) with check (auth.role() in ('authenticated','anon'));
create policy "Allow authenticated access" on public.discount_rules for all to public using (auth.role() = 'authenticated');
create policy "Allow authenticated access" on public.tax_rates      for all to public using (auth.role() = 'authenticated');
drop policy if exists closed_checks_insert on public.closed_checks;
create policy "insert closed checks" on public.closed_checks for insert to public with check (true);

-- helpers back to invoker (only if something misbehaves; they are safe as definer)
alter function public.user_accessible_locations() security invoker;
alter function public.user_accessible_locations() reset search_path;
alter function public.user_accessible_orgs() security invoker;
alter function public.user_accessible_orgs() reset search_path;

-- grants
grant truncate, references, trigger on all tables in schema public to anon, authenticated;
grant execute on function public.decrement_stock(text, text, integer) to public, anon;
grant execute on function public.restore_stock(text, text, integer) to public, anon;
```

The new policies created by the file (names ending `_tenant`, `_read`, `_insert`, `_select`, `_update`, `_delete`, `_public_read`, `_public_insert`) are harmless next to "allow all" and can stay or be dropped by name. The new RPCs can stay. The original bodies of `decrement_stock` and `restore_stock` are in `000_baseline_ops.sql` lines 6899 and 7725 if you want them back exactly.

---

## File 2: `20260907b_ops_rls_2_pairing.sql` (Ops, run now, then re pair)

### What it does

- Adds `pairing_expires_at`, `device_secret_hash`, `secret_issued_at` to `devices`.
- Adds `device_claim_attempts` (5 misses per anonymous session, 5 minute lock).
- Trigger `devices_pairing_code_issued`: a new or changed code gets a **4 hour expiry** and **clears the binding** (device_uid, secret, paired_at). Regenerate now means move.
- Trigger `devices_anon_guard`: a till may only change status, last_seen, paired_at, session_token, app_version, and may clear its code. Everything else is Back Office only.
- `claim_device` keeps its name and signature. New rules: same session is a no op; **another session is refused**; unbound with a live code binds and clears the code; expired or missing code is refused. Every refusal returns NULL (the legacy callers already treat NULL as not paired) and counts as a miss. `claim_device_v2` returns `ok:false` with a `reason` (`not_found`, `already_paired`, `expired`) and a `message` the app can show.
- New: `claim_device_v2` (returns the row and a one time device secret), `reclaim_device` (re bind by secret, no code), `issue_pairing_code` (Back Office mints a 12 symbol server code).
- `devices` policies: own row, same venue, super admin. One **interim** arm lets an anonymous session read an unbound row with a live code, so the pairing screens still work until A10 and A11 ship.
- Data: codes on bound devices are cleared. Codes on unbound devices get a 7 day expiry.

### What changes on the floor (read before running)

- The file prints a **notice per device** that has no `device_uid` and is active or online (the audit counted 6). Each of those bounces to the pairing screen on its next refresh. Fix: Back Office, Devices, show or regenerate the code, type it on the till. Then it is bound and everything resumes.
- A till whose anonymous session rotated since it paired is in the same boat: regenerate and re pair.
- Re pairing any device now **needs a fresh code**. "Show code" on a paired device is blank. Press Regenerate.
- Back Office codes **expire after 4 hours**.
- Codes are still generated in the browser (90,000 values) until P1 and file 3. That is acceptable for now only because codes are single use, expire, and misses are rate limited.

### How to run

- Ops project, paste, run. Read the notices. Write down the device names.
- Paste the V block. Query 5 is the list of devices to re pair.
- Walk to each listed device and pair it.

### Smoke test

- Till already bound: reboot it. Still logged in, floor plan present, staff PINs work.
- Till in the notice list: shows the pairing screen. Regenerate its code in Back Office, type it. Works.
- Kiosk: same. Ryft or PAX "send to terminal" works after pairing.
- Wrong code five times from one till: sixth attempt says "too many pairing attempts" (any mix of unknown, expired or already paired codes counts).
- Back Office Devices: create a device, regenerate a code, remove a device. All three work.
- Wrong code typed on an unbound device that was just regenerated: refused, code stays valid.

### Roll back

```sql
drop trigger if exists devices_anon_guard on public.devices;
drop trigger if exists devices_pairing_code_issued on public.devices;
drop policy if exists devices_select on public.devices;
drop policy if exists devices_insert on public.devices;
drop policy if exists devices_update on public.devices;
drop policy if exists devices_delete on public.devices;
create policy "allow all" on public.devices for all to public using (true) with check (true);

-- claim_device back to the 13 Jul body
create or replace function public.claim_device(p_code text)
returns uuid language plpgsql security definer set search_path = public as $function$
declare
  v_loc uuid;
  v_id  uuid;
begin
  if auth.uid() is null then raise exception 'no auth session'; end if;
  select id, location_id into v_id, v_loc from public.devices
   where pairing_code = upper(trim(p_code)) and status <> 'removed' limit 1;
  if v_id is null then return null; end if;
  update public.devices set device_uid = auth.uid(), last_seen = now() where id = v_id;
  return v_loc;
end;
$function$;
grant execute on function public.claim_device(text) to public, anon, authenticated, service_role;

drop function if exists public.claim_device_v2(text);
drop function if exists public.reclaim_device(uuid, text);
drop function if exists public.issue_pairing_code(uuid);
drop function if exists public._claim_device_core(text, boolean);
```

The cleared codes cannot be restored. Regenerate in Back Office for any device that needs one. The three new columns and the attempts table can stay.

---

## File 3: `20260907b_ops_rls_3_after_app.sql` (Ops, only after the app)

### Needs first

- App changes **A1 to A14** and **P1** live on every device (list below).
- `online_kitchen_load(text)` deployed (20260902). The file refuses to run without it.
- **Zero** active or online devices without `device_uid`. The file refuses to run otherwise.

### What it does

- Drops "allow all" on `order_queue` and `active_sessions`.
- Drops `customers_all`, `customer_locations_all`, `customer_orders_all`.
- Removes the interim anonymous read by code on `devices`.
- The pairing trigger now **replaces browser codes with server codes**.
- `device_profiles` reads become tenant fenced.
- The kiosk arm leaves the two public INSERT carve outs.
- `decrement_stock` becomes paired device or Back Office only.

### Smoke test (all of these must pass, they are the flows that move to RPCs)

- Online: order, tracker page shows status and updates. Share link works. Track link from SMS on another phone works.
- QR: open tab, add a round, "settle bill" from a second phone with the join code, self close from the first phone. Floor plan shows the table busy and clears after close.
- Catering: date picker shows capacity, order pay later, order pay now.
- Kiosk: boot with cached id, order, branding shown. Customer display shows branding.
- Till: pair from scratch with a fresh code, reboot, clear site data and reboot (should self heal via the device secret).
- Back Office Devices: create a device. The code shown is the 12 symbol server one.

### Roll back

```sql
create policy "allow all" on public.order_queue     for all to public using (true) with check (true);
create policy "allow all" on public.active_sessions for all to public using (true) with check (true);
drop policy if exists device_profiles_read_tenant on public.device_profiles;
create policy device_profiles_read_open on public.device_profiles for select using (true);

-- customers legacy policies (as in 000_baseline_ops.sql 9195 to 9230)
create policy customers_all on public.customers for all to public
  using (org_id in (select l.org_id from locations l join user_locations ul on ul.location_id = l.id where ul.user_id = auth.uid())
         or auth.uid() is null or (auth.jwt()->>'is_anonymous')::boolean = true)
  with check (org_id in (select l.org_id from locations l join user_locations ul on ul.location_id = l.id where ul.user_id = auth.uid())
         or auth.uid() is null);
create policy customer_locations_all on public.customer_locations for all to public
  using (location_id in (select location_id from user_locations where user_id = auth.uid())
         or auth.uid() is null or (auth.jwt()->>'is_anonymous')::boolean = true)
  with check (location_id in (select location_id from user_locations where user_id = auth.uid()) or auth.uid() is null);
create policy customer_orders_all on public.customer_orders for all to public
  using (location_id in (select location_id from user_locations where user_id = auth.uid())
         or auth.uid() is null or (auth.jwt()->>'is_anonymous')::boolean = true)
  with check (location_id in (select location_id from user_locations where user_id = auth.uid()) or auth.uid() is null);
```

For `devices_select`, `closed_checks_insert`, `order_queue_public_insert`, the pairing trigger body and `decrement_stock`, re run the matching section of file 1 or file 2 (they are idempotent and restore the pre file 3 shape).

---

## File 4: `20260907b_PLATFORM_anon_writes_1_safe_now.sql` (Platform, run now)

### What it does

- Restates the drop of `locations_anon_update` and revokes **every** write grant on `locations` from anon and authenticated.
- Drops the three dead bluetooth policies on `payment_devices`.
- `payment_devices`: column level SELECT for the browser roles. Withheld: `registration_code`, `stripe_account_id`, `registered_by_user_id`. A DO block checks every granted column exists first.
- Revokes EXECUTE from public, anon, authenticated on `get_effective_markup`, `upsert_customer_stamp_card`, `redeem_gift_card_atomic`, `get_plan_and_fee_for_gmv`. Only edge functions call them.
- Revokes TRUNCATE, REFERENCES, TRIGGER from anon and authenticated on every table.

### Smoke test

- Open `/online/<slug>` in a private window. Venue resolves.
- Till: card payment on a network reader. Reader discovery works.
- Back Office Card readers screen lists readers.
- Back Office Location settings save (goes through location-admin, unaffected).

### Roll back

```sql
grant select on table public.payment_devices to anon, authenticated;
grant execute on function public.get_effective_markup(uuid, text) to anon, authenticated;
grant execute on function public.upsert_customer_stamp_card(uuid, uuid, uuid) to anon, authenticated;
grant execute on function public.redeem_gift_card_atomic(uuid, uuid, integer, text, uuid, text, text, uuid) to anon, authenticated;
grant execute on function public.get_plan_and_fee_for_gmv(numeric, text) to anon, authenticated;
grant truncate, references, trigger on all tables in schema public to anon, authenticated;
grant insert, delete on table public.locations to anon, authenticated;
```

Do **not** recreate `locations_anon_update`. If a Back Office save on platform locations fails, the fix is a whitelist entry in `supabase/functions/location-admin`, not a policy.

---

## File 5: `20260907b_PLATFORM_anon_writes_2_after_app.sql` (Platform, only after the app)

### Needs first

- Section 1 needs **P2** (card reader settings through location-admin).
- Section 2 needs **P3** (loyalty and gift screens through a service role function).

### What it does

- Section 1: drops the insert and update policies on `location_reader_settings`, revokes browser writes. Reads stay.
- Section 2: the six `service_all` style policies become `to service_role` (customer_loyalty, loyalty_tiers, loyalty_config, stamp_card_programs, customer_stamp_cards, gift_card_purchases). The two `anon_read_stamp_*` policies go too. Browser write grants revoked.

### Smoke test

- Back Office Card readers: save tipping prompts. Idle screen upload.
- Back Office Loyalty: list members, adjust points, edit a tier, toggle a stamp programme, delete a programme.
- Back Office Customers: loyalty panel loads. Reports, loyalty report loads.
- Back Office Online ordering: loyalty enabled flag loads.
- Back Office Gift cards: purchases tab lists.
- Kiosk and portal: phone lookup returns balance (edge functions, unaffected).

### Roll back

```sql
create policy location_reader_settings_insert on public.location_reader_settings for insert to public with check (true);
create policy location_reader_settings_write  on public.location_reader_settings for update to public using (true) with check (true);
grant insert, update, delete on table public.location_reader_settings to anon, authenticated;

drop policy if exists service_all on public.customer_loyalty;
create policy service_all on public.customer_loyalty for all to public using (true) with check (true);
drop policy if exists service_all on public.loyalty_tiers;
create policy service_all on public.loyalty_tiers for all to public using (true) with check (true);
drop policy if exists service_all on public.loyalty_config;
create policy service_all on public.loyalty_config for all to public using (true) with check (true);
drop policy if exists service_all_stamp_programs on public.stamp_card_programs;
create policy service_all_stamp_programs on public.stamp_card_programs for all to public using (true) with check (true);
create policy anon_read_stamp_programs on public.stamp_card_programs for select to public using (true);
drop policy if exists service_all_stamp_cards on public.customer_stamp_cards;
create policy service_all_stamp_cards on public.customer_stamp_cards for all to public using (true) with check (true);
create policy anon_read_stamp_cards on public.customer_stamp_cards for select to public using (true);
drop policy if exists gift_card_purchases_service on public.gift_card_purchases;
create policy gift_card_purchases_service on public.gift_card_purchases for all to public using (true) with check (true);
grant insert, update, delete on table
  public.customer_loyalty, public.loyalty_tiers, public.loyalty_config,
  public.stamp_card_programs, public.customer_stamp_cards, public.gift_card_purchases
to anon, authenticated;
```

---

## App changes

Each one is small. The RPCs already exist after files 1 and 2, so these can ship one at a time and be tested against the live database before file 3 runs.

### Group A: Ops customer surfaces (before file 3)

- **A1** `src/lib/customerLookup.js` `attributeOnlineOrder` (line 260 onward). Replace the three table round trips with one call: `supabase.rpc('attribute_public_order', { p_location_id, p_ref: orderRecord.ref, p_phone: phone, p_name: name, p_email: email, p_marketing_opt_in, p_total: orderRecord.total, p_items: summary, p_channel: 'online' | 'qr' })`. Keep the welcome send and loyalty earn after it. Drop the `last_seen_at` write (the column does not exist). Callers: `OnlineCheckout.jsx:1108` and `:1253`, `QrCheckout.jsx:512`.
- **A2** `src/surfaces/online/OrderTracker.jsx:44`. Poll with `supabase.rpc('order_track_row', { p_location_id, p_ref, p_last4 })`. Pass `p4` down from OnlineSurface. The realtime channel at `:81` can stay (it goes quiet once "allow all" is gone) or trigger a re poll on any event.
- **A3** `src/surfaces/online/OnlineSurface.jsx`. `:141` becomes `rpc('qr_table_open_tabs', { p_location_id, p_table_id })` (returns `tab_handle` instead of payment ids). `:187` becomes `rpc('qr_tab_rounds', { p_location_id, p_payment_intent_id: stashed.payment_intent_id })`. `:230` becomes `rpc('order_track_check', { p_location_id, p_ref, p_last4 })`.
- **A4** `src/surfaces/qr/QrCheckout.jsx:371`. `rpc('qr_table_tab_count', { p_location_id, p_table_id })`, then `subNum = count + 1`.
- **A5** `src/lib/qrTableSession.js`. Body becomes `supabase.rpc('sync_qr_table_session', { p_location_id, p_table_id })`. Same export name, same callers.
- **A6** `src/surfaces/qr/TabResumeScreen.jsx:142`. `rpc('qr_close_tab', { p_location_id: locId, p_payment_intent_id: tab.payment_intent_id })`. Keep the closed_checks insert after it.
- **A7** `src/surfaces/qr/JoinTabScreen.jsx`. The join code check moves server side: call `rpc('qr_tab_rounds', { p_location_id, p_tab_handle: tab.tab_handle, p_join_code })`. Empty result means wrong code.
- **A8** `src/surfaces/catering/CateringSurface.jsx:131` and `:217`. `rpc('catering_day_load', { p_location_id: opsId, p_date: ds })` returns `order_count` and `order_value`.
- **A9** `src/lib/prepTime.js:153` to `:159`. Delete the direct read fallback. `online_kitchen_load` must be deployed.
- **A10** `src/surfaces/PairingScreen.jsx`. Replace the `select('*, locations(*)').eq('pairing_code')` at `:18` and the update at `:30` with `const { data } = await supabase.rpc('claim_device_v2', { p_code })`. Use `data.location`, `data.profile_id`, `data.centre_id`, `data.receipt_printer_id`. Store `data.device_secret` in `rpos-device` as `deviceSecret`. When `data.ok` is false show `data.message` (reasons: `not_found`, `already_paired`, `expired`); a thrown error means the caller is locked out for five minutes.
- **A11** `src/surfaces/KioskSurface.jsx:56` to `:83`. Same as A10. The post claim update can stay (own row) or go.
- **A12** `src/lib/supabase.js:175` `claimPairedDeviceOnBoot`. If `dev.deviceSecret` is present call `rpc('reclaim_device', { p_device_id: dev.id, p_device_secret })`. If it returns `ok: false`, or the secret is missing and the row is not bound, show a **visible** "this till needs re pairing" banner instead of `console.warn`. Drop the `select('pairing_code')` read at `:183`.
- **A13** `src/surfaces/CustomerDisplaySurface.jsx:84` and `src/surfaces/KioskApp.jsx:85`. `rpc('device_profile_public', { p_profile_id })` returns the branding keys as one object.
- **A14** `src/surfaces/online/OnlineCheckout.jsx` (`decrementOnlineStock`, lines 62 and 69). Remove the client `decrement_stock` calls. `depleteForSaleServer` (stock-deplete, service role) already runs at `:1099` and `:1241`. Kiosk keeps its call (it is a paired device).

### Group P: Back Office and edge functions

- **P1** (before file 3) `src/backoffice/sections/DeviceRegistry.jsx:182` `setPairingCode(data.pairing_code || code)`. `src/backoffice/sections/KioskRegistry.jsx:108` add `.select().single()` to the regenerate update and show `data.pairing_code` at `:115`. Or replace both `genCode` calls with `rpc('issue_pairing_code', { p_device_id })`. Also move `genCode` to `crypto.getRandomValues` while you are there.
- **P2** (before file 5 section 1) `supabase/functions/location-admin/index.ts`: add action `save_reader_settings` with the same `authed()` fence and a column whitelist. `src/backoffice/sections/CardReaders.jsx:814` calls it.
- **P3** (before file 5 section 2) A service role `loyalty-admin` edge function fenced like `location-admin.authed()` (Ops `user_locations` lookup, super admin fallback, company resolved server side). Move the reads and writes in `LoyaltyManager.jsx`, `Customers.jsx:145/:157`, `reports/LoyaltyReport.jsx:45/:48`, `OnlineOrdering.jsx:69`, `GiftCards.jsx:1266` onto it.

### Optional (nice, not required by any file)

- `src/lib/customerLookup.js:86` `fetchCustomerByPhone` and `:201` `captureLoyaltyByPhone`: use `rpc('customer_lookup_by_phone', { p_location_id, p_phone })` so the kiosk never reads `customers` directly.
- `src/backoffice/sections/DeviceRegistry.jsx:23` and `KioskRegistry.jsx:28`: browser `genCode` becomes unnecessary once P1 uses `issue_pairing_code`.

---

## Things that catch people out

- **Fixed but still broken?** Check edge function deploy drift first (`node scripts/check-deploys.mjs`). These files do not deploy functions.
- **A till shows the pairing screen after file 2.** Expected for any device the notice listed. Regenerate its code in Back Office and pair. It is bound after that.
- **Show code is blank on a paired device.** Expected. Press Regenerate.
- **Code says expired.** Back Office codes last 4 hours. Regenerate.
- **Kiosk says "welcome back" for nobody.** The kiosk is not bound. Re pair it.
- **QR tabs missing from the floor plan after file 3.** A5 is not deployed, or the till in question is not bound.
- **Tracker blank after file 3.** A2 or A3 not deployed on the customer domain.
- **Back Office loyalty blank after file 5.** P3 not live. Roll back section 2 with the block above.
- **No migration ledger exists.** Keep a note of the date and time you ran each file. Staging must be built from a fresh `pg_dump --schema-only`, never from a folder replay.

## Verification in one place

After files 1, 2 and 4:

```sql
-- Ops: only order_queue and active_sessions may still say allow all
select tablename from pg_policies where schemaname = 'public' and policyname = 'allow all' order by 1;
-- Ops: the only auth.role() write policy left must be user_profiles "Allow authenticated access" (20260721c replaces it)
select tablename, policyname from pg_policies where schemaname = 'public' and cmd in ('ALL','INSERT','UPDATE','DELETE')
   and (coalesce(qual,'') like '%auth.role()%' or coalesce(with_check,'') like '%auth.role()%');
-- Ops: no is_anonymous hatch is reachable (the *_all policies exist but are fenced)
select tablename, policyname, permissive from pg_policies
 where tablename in ('customers','customer_locations','customer_orders') order by 1, 2;
-- Ops: devices bound
select count(*) filter (where device_uid is null) as unbound, count(*) as total
  from public.devices where status in ('active','online');
-- Platform: no write policy on locations, no bluetooth policies
select tablename, policyname, cmd from pg_policies
 where tablename in ('locations','payment_devices') order by 1, 2;
```

After files 3 and 5:

```sql
-- Ops: nothing says allow all, nothing mentions is_anonymous
select tablename, policyname from pg_policies
 where schemaname = 'public'
   and (policyname = 'allow all' or coalesce(qual,'') like '%is_anonymous%' or coalesce(with_check,'') like '%is_anonymous%');
-- Platform: every policy on the loyalty, gift and reader settings tables is service_role or a read
select tablename, policyname, cmd, roles from pg_policies
 where tablename in ('customer_loyalty','loyalty_tiers','loyalty_config','stamp_card_programs',
                     'customer_stamp_cards','gift_card_purchases','location_reader_settings')
 order by 1, 2;
```

## Verifier findings not yet applied (8 Sep 2026)

Breaks, each must be fixed before the file it names is run:
1. Ops file 2 keeps an interim anonymous SELECT arm on devices that exposes a live pairing code to any anonymous session. Remove the arm. Never publish a code through a SELECT policy. Split file 2 so the policy change waits for P1.
2. attribute_public_order proves an order with an order_queue row that any anon key holder can insert, so cross venue PII updates reopen once A1 ships. Proof must be something only the payment path writes (payment_verified_at or paid_ref set by the capture functions and webhooks).
3. order_queue_public_insert and closed_checks_insert let any anon key holder fabricate orders and paid revenue at any venue (every location defaults to status active). Move both inserts behind the capture edge functions.
4. user_profiles keeps Allow authenticated access with column UPDATE grants on location_id, org_id and bo_access. Add a restrictive self update policy and a BEFORE UPDATE guard trigger.
5. A paired device can rewrite its whole ops locations row (the device arm exists only for quick_screen_ids). Add a BEFORE UPDATE trigger that limits anonymous sessions to the quick screen columns.
6. receipt_emails has allow read all (every venue's customer emails readable anonymously) and print_jobs allows anonymous injection. Fence both to pos_accessible_location_keys with service role writes.
7. Platform: after file 4 only locations is closed. location_reader_settings and customer_loyalty stay writable by anyone. Build P3 first (customer_loyalty balances are money), then run file 5 section 2 the same day.
8. Boot re claim: claimPairedDeviceOnBoot passes the cached code on every boot. File 2 nulls codes on bound rows, so every boot counts as a miss and locks the device out. _claim_device_core must first match the caller by device_uid and treat that as idempotent.
9. Back Office new operator bootstrap: organisations_select blocks the INSERT RETURNING in CompanyAdmin.jsx. Add a SECURITY DEFINER create_organisation RPC.
10. Server generated 14 character codes do not fit the PairingScreen input (maxLength 12). Normalise dashes on both sides or raise maxLength.
11. A13 must not touch KioskApp.jsx (it needs the full device_profiles row). Restrict A13 to CustomerDisplaySurface.
12. The order tracker opened straight after checkout has no phone, so order_track_row refuses. Pass customer.phone in the onPlaced payload and keep it in state.

Gaps to close in the same pass: rollback blocks are not exact for files 1 and 4 (policies and grants named in the findings). Browser pairing codes stay at 90,000 values until file 3, so ship P1 first. QR tab RPCs return the whole customer jsonb including payment ids, and the join code is 4 digits from Math.random. order_track RPCs have no throttle on the 4 digit last4. activity_events anonymous insert is spammable. locations.status = active gates nothing. device_profiles.location_id may be null on legacy rows. Numeric casts in sync_qr_table_session and qr_close_tab can raise after a capture succeeded. Kiosks do not self bind after file 2. File 1 verification query 5 and the handle_new_user notice sentence are wrong. closed_checks_source_check does not allow source qr (pre existing, QR paid records never land). A7 is under specified for the TabResumeScreen capture fields.
