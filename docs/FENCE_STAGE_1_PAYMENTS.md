# Runbook two: the payment half, later

Database fence, stage 1, second half. Written 20 Sep 2026. Branch `fix/database-fence-1`.

**Runbook one** is `docs/FENCE_STAGE_1.md`. Do that first. Nothing here runs until file a1 is in.

## What this half closes

- **The price of a customer order is ours, not the phone's.** The server prices every line from your own menu, by item id, and never below your menu price.
- **Paid is ours too.** An order counts as paid only when a real payment the server can see covers what the server says it costs.
- **Discounts must be provable**: your own automatic deals, a real promo code (used up once), and a loyalty reward really redeemed for that order. Nothing else comes off.
- **A tip is only money taken above the bill.** A page cannot turn your takings into a tip, or a courier fee, or added on sales tax.
- **What paid each bill** is the server's answer: the card, the gift card, the loyalty and promo credits, each held to what the server proved.
- **Deals and stamp cards**: only your Back Office can change an automatic deal, and only the server can write the stamp card ledger.

## The order

1. **The tenders migration**, if you have not run it.
2. **Three pre-checks**, read only. Fix or accept what they list.
3. **File a2** in the Ops SQL editor, outside service.
4. **The Platform files**, C then D.
5. **The last Ops file** (20260919b), a full day after a1 ran, outside service.

## Step 1: the tenders migration (prerequisite)

- **Run `supabase/migrations/20260919n_OPS_closed_checks_tenders.sql`** in the **Ops** SQL editor if you have not. It came with v5.9.11.
- **Safe any time**, service included.
- **What it adds**: `closed_checks.tenders`, the list of what paid each bill: the card with its processor reference, the gift card with its card id, the loyalty and promo credits.
- **Check it is there.** This must answer `1`:

```sql
select count(*) from information_schema.columns
 where table_schema = 'public' and table_name = 'closed_checks' and column_name = 'tenders';
```

- **Without the column nothing is lost and no money is misposted**: a2 also writes each bill's own `method` and `payment_method` from what it proved. What you lose is the detail: the processor reference, the gift card id, and the true split of a mixed payment.

## Step 2: three pre-checks (read only)

These say nothing is wrong. They tell you which rows the server will price differently, so nothing surprises you on the night.

**1. Items priced 0.00 on a menu (Ops).** Each hit is free on the menu named, and only there, because the page tells the server which menu it priced on. An older page names no menu, and then the item is charged at its lowest price above zero, so the order arrives **Payment short** rather than free. If a row here should never be free, price it.

```sql
select id, name, pricing from public.menu_items
 where coalesce(archived, false) = false and pricing->'menus' is not null
   and exists (select 1 from jsonb_each(pricing->'menus') t
                where jsonb_typeof(t.value) = 'object'
                  and (t.value->>'all' = '0' or t.value->>'base' = '0' or t.value->>'dineIn' = '0'
                       or t.value->>'collection' = '0' or t.value->>'delivery' = '0' or t.value->>'takeaway' = '0'));
```

**2. Free item rewards that name no item (Platform).** Each one gives away the cheapest line on the order, capped at **£15.00**, or the reward's own ceiling if it has one. Name the items and the cap never comes into it. Back Office now warns in red on any such reward or stamp card.

```sql
select id, name, reward_type, reward_value from public.loyalty_rewards
 where reward_type = 'free_item' and coalesce(jsonb_array_length(reward_value->'eligible_items'), 0) = 0;
select id, name, reward_type, reward_config from public.stamp_card_programs
 where coalesce(reward_type, 'free_item') = 'free_item'
   and coalesce(jsonb_array_length(reward_config->'eligible_items'), 0) = 0;
```

**3. Modifier options with no id (Ops).** The server matches an option by its id. One with no id is worth nothing to it, so it is charged at what the page said and never less than zero. Nobody is overcharged and nothing is refused.

```sql
select g.id, g.name, count(*) as options_with_no_id
  from public.modifier_groups g
  cross join lateral jsonb_array_elements(case when jsonb_typeof(g.options) = 'array' then g.options else '[]'::jsonb end) o
 where jsonb_typeof(o) = 'object' and coalesce(o->>'id', '') = ''
 group by g.id, g.name order by 3 desc;
```

## Step 3: run file a2

- **Where**: the **Ops** SQL editor (tbetcegmszzotrwdtqhi).
- **When**: outside service. It locks the orders tables for a moment.
- **What**: paste all of `supabase/migrations/20260919a2_OPS_fence_public_orders.sql` and press **Run**.
- **It refuses unless a1 is in** and says so, changing nothing.

**Expect this result row**

- **rules_open_to_customers**: `false`.
- **stamp_ledger_open**: `false`.
- **order_functions**: `4`. **tab_functions**: `4`. **tracker_functions**: `2`.
- **order_fns_need_a_session**: `true`.
- **allow_all_left**: `active_sessions, kds_tickets, order_queue, table_reservations`. Step 5 closes those.

**Smoke test**: an online order and its tracker, a QR tab opened and a round added, a friend joining with the table code, the tab settled from the phone, a catering order, a kiosk order.

## What staff see after a2

- **Payment being checked**: the server could not prove the payment yet, usually a slow card processor. It is **not unpaid**. Never charge it again. Staff press **Check payment**; a manager can press **Confirm payment** after seeing the money in the processor.
- **Payment short**: the customer paid less than your menu says. The Orders Hub, the handheld and the kitchen ticket show what was paid and what was due. **Never charge the full amount again.** Take the difference on the till if you want it, then a manager presses **Confirm payment** with a note, and only what the online payment took is booked.
- **Honest orders that can arrive short**: a loyalty reward the server could not value, a line your storefront does not really sell (86'd, archived, a size's parent row), a free item stamp card above the 15.00 cap, and a kids menu order from a page opened before the release. All come through with the food, at menu price, for staff to confirm.
- **A QR tab marked Payment short**: the guest closed the tab and their card was charged for less than the tab. Press **Close (already charged)**. The card is never charged again. Take the rest on the till as its own sale.
- **"This round would take the tab past its card hold"**: the guest closes the tab and starts a new one, or staff take the order on the till.

## Step 4: the Platform files

**File C**

- **Wait until** the release's edge functions are deployed.
- **First reload every Back Office tab.**
- **How**: Platform SQL editor (yhzjgyrkyjabvhblqxzu), paste `20260919c_PLATFORM_fence_1_after_release.sql`, Run.
- **Expect**: `gift_writes_by_browser` false, `reader_writable_by_browser` false, `truncate_left` 0.
- **What closes**: nobody can mark an online gift card paid or sent, and nobody can change a venue's reader settings from a browser.
- **Check**: Card readers, change a tip and save. Gift cards, Online purchases still lists.

**File D**

- **First count the exposed cards** (read only, Platform). Write the numbers down. On 19 Sep: 1 live card, £80.50.

```sql
select c.company_id, count(*) as live_cards, sum(c.balance_minor) as balance_minor
  from public.gift_card_purchases p
  join public.gift_cards c on c.id = p.gift_card_id
 where p.fulfilled_at is not null
   and c.status = 'active' and c.voided_at is null and c.balance_minor > 0
   and (c.expires_at is null or c.expires_at > now())
 group by c.company_id order by 2 desc;
```

- **The safe option**: flag each card for its owner, void nothing. The owner decides: leave it, or issue a new card for the same balance and void the old one. Watch them for 30 days.
- **How**: Platform SQL editor, paste `20260919d_PLATFORM_fence_2_after_app.sql`, Run.
- **Expect**: `gift_readable_by_browser` false, `codes_left` equal to `kept_because_card_has_no_code` (normally 0).

## Step 5: the last Ops file (a full day after a1)

**Wait until all of these are true.** The file checks each one and stops, changing nothing, with the reason.

- **a1 has been in for a full day**: 24 hours after it FIRST ran. Running it again does not move that time.
- **a2 is in.** The customer pages need its functions once this file closes the tables.
- **Every active device** reports the new app and holds its device secret. Switch each one on for two minutes.
- **No unpaired device is switched on.** Pair it again or switch it off.
- **At least one customer order has gone through the new order function** in the last 7 days. Place one test online order and check it reached the till.

```sql
-- who wrote the customer orders of the last day (rpc must be 1 or more over 7 days)
select placed_via, count(*)
  from public.order_queue
 where source in ('online', 'qr', 'catering') and created_at > now() - interval '24 hours'
 group by 1;
```

- **How**: Ops SQL editor, paste `20260919b_OPS_fence_2_after_app.sql`, Run, outside service.
- **Expect**: `open_policies_left` none, `names_on_order_screens` true, `devices_readable_by_all` false, `tills_without_secret` 0, `qr_floor_trigger` true.
- **What closes**: orders, kitchen tickets, print jobs, tables, reservations and paid bills belong to the venue's own tills, Back Office and server. Customers reach them only through the server functions.
- **What staff see**: nothing, if every device is on the new app. Order screen TVs start showing first names.
- **Smoke test**: online order and tracker, QR tab, a round, a friend joining, settle from the phone, catering order, kiosk order, KDS bump, a print, a QR tab on the floor plan.

## Roll back order

- **Later file first, always.**
- **The last Ops file** (20260919b) comes out before a2. Its block is at the end of its own file.
- **a2** comes out before a1. Its block is at the end of `20260919a2_OPS_fence_public_orders.sql`. It puts the deal tables back exactly as they were on 18 Sep. The server functions stay: nothing calls them once the app is back on its old path, and every order already placed keeps its prices and its paid bill.
- **a1** comes out last. Its block is in runbook one.
- **Platform**: D before C.
- **Each block refuses** while a later file is in, and says which to roll back first.

## Still open after stage 1

- **Stage 2 tables**: activity events, bookings, preorders, booking rules. They keep their open rules and need their own fence.
- **Never** use `supabase db push`.
