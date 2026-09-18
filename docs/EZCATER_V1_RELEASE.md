# ezCater v1 release note

ezCater orders are filed as our own catering orders (ADR-023).
This is the order to switch it on in.

## 1. Deploy, in this order

- **App first.** Put the new app build on every till.
- **Reload Sunmi tills.** Their WebView keeps old code until reloaded.
- **Then these edge functions**, with the Supabase CLI so `_shared` is bundled:
  - `catering-release`
  - `order-notify`
  - `review-request`
  - `uber-direct` (it imports `_shared/delivery-dispatch.ts`)
- **Last:** `ezcater-webhook`.
  - It must go last. Everything above must already know an ezCater order when the first one lands.

## 2. The old test order HKX77V

- **Cancel it on ezCater.**
- **Then clear it from the till.** Pick one:
  - Orders Hub: tap it straight through to Collected.
    - Only AFTER `order-notify` is live.
    - It reads as paid and texts nobody.
  - Or: Cancel order on MPOS.

## 3. Check it works

- **Set the prep time.** Back Office, Catering settings, prep time, for this venue.
- **Place a fresh test order** on ezCater.
  - Make it more than the prep time ahead.
- **Check Back Office Catering.** It shows as "ezCater" plus the order number.
- **Check the fire time.** It goes to the kitchen at event time minus prep time.
- **If ezCater has not accepted it** by then, it is held and the bell shows one urgent alert.

## Known gap

- **Sales reports.** ezCater sales are not written to `closed_checks`, so they are in no sales report. This is older than this work and is not fixed here.
