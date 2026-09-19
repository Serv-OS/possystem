# ezCater v1 release note

ezCater orders are filed as our own catering orders (ADR-023).
Switch it on in exactly this order. Do not skip ahead.

## 1. Merge and let the app deploy

- **Merge to main.**
- **Wait for the app to deploy.** It deploys itself from main.

## 2. Set the catering prep time

- **Back Office, Catering settings, prep time.** Set it for this venue.
- **Why:** an ezCater order goes to the kitchen at event time minus this prep time.

## 3. Check every till has the NEW version

- **Check the master till AND every Sunmi till.**
- **Where to look:** the top bar of the till screen, beside "What's new" (it reads like v5.8.100).
  - Or tap the Terminal status button: the Version row.
- **It must show the NEW version number.**
- **Sunmi tills keep old code** until they are fully reloaded. Reload any that do not show it.
- **Do not go further until every till shows it.**
- **Why:** an old till does not know an ezCater order. It releases held orders and cancelled orders to the kitchen.

## 4. Deploy the edge functions

- **From the merged commit.** Check out main at the merge, not a branch.
- **With the Supabase CLI**, so `_shared` is bundled.
- **In this order:**
  - `catering-release`
  - `order-notify`
  - `review-request`
  - `uber-direct` (it imports `_shared/delivery-dispatch.ts`)
- **Last:** `ezcater-webhook`.
  - Everything above must already know an ezCater order when the first one lands.
- **Then run** `node scripts/check-deploys.mjs`. Every function must match.

## 5. The old test order HKX77V

- **Cancel it on ezCater.**
- **Then clear it from the till.** Pick one:
  - Orders Hub: tap it straight through to Collected.
    - Only AFTER `order-notify` is live.
    - It reads as paid and texts nobody.
  - Or: Cancel order on MPOS.

## 6. Place a fresh test order

- **Place it on ezCater.** Make it more than the prep time ahead.
- **Check Back Office Catering.** It shows as "ezCater" plus the order number.
- **Check the fire time.** It goes to the kitchen at event time minus prep time.
- **If ezCater has not accepted it** by then, it is held and the bell shows one urgent alert.

## 7. Menu sync

- **Run migration `20260919m`** first.
- **Then press Sync.**
  - Outside service, or when no ezCater order is due to fire.
- **Only exact matches link automatically.** Check the rest by hand.

## Known gap

- **Sales reports.** ezCater sales are not written to `closed_checks`, so they are in no sales report. This is older than this work and is not fixed here.
