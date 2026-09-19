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

- **The merge ships as v5.9.9.**
- **Check the master till AND every Sunmi till.**
- **Where to look:** the till's top bar, next to "What's new".
  - Or tap the Terminal status button: the Version row.
- **It must read exactly v5.9.9.** That is the NEW version number.
- **Sunmi tills keep old code.** A reload is not enough.
  - **Force stop the app:** swipe it away, or Settings, Apps, the app, Force stop.
  - **Then reopen it** and read the version again.
- **Do not go further until every till shows it.**
- **Why:** an old till does not know an ezCater order. It releases held orders and cancelled orders to the kitchen.

## 4. Deploy the edge functions

- **Claude runs the deploys, and Claude checks them.**
- **From the merged commit only.**
  - Fetch first.
  - `git rev-parse HEAD` must equal the merge commit shown on GitHub.
  - Not a branch, and not an older checkout.
- **With the Supabase CLI**, so `_shared` is bundled.
- **In this order:**
  - `catering-release`
  - `order-notify`
  - `review-request`
  - `uber-direct` (it imports `_shared/delivery-dispatch.ts`)
  - `ezcater-connect`
- **Last:** `ezcater-webhook`.
  - Everything above must already know an ezCater order when the first one lands.
- **Then Claude runs** `node scripts/check-deploys.mjs`, from that same checkout.
  - Every function must match.
  - It now dates each function by its folder AND every `_shared` file it imports.
  - So a change made only in `_shared/ezcaterCatering.js` shows as not live until redeployed.
- **Then Claude proves the new code is live.**
  - `npx supabase functions download <name>` for each of the six.
  - The five that import `_shared/ezcaterCatering.js` must contain `the staff alert from the earlier attempt is raised now`. Only the new code has that text.
  - `ezcater-webhook` must also contain `event read failed`.
  - `ezcater-connect` is unchanged by this merge, so `check-deploys` is its check.

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

- **Outside service only.** Both of these, not just Sync.
  - Outside service, or when no ezCater order is due to fire.
- **Run migration `20260919m`** first.
  - It switches sized line matching on, and it schedules the hourly sync.
  - So running it is itself outside service.
- **Then press Sync.**
- **Only exact matches link automatically.** Check the rest by hand.

## Known gap

- **Sales reports.** ezCater sales are not written to `closed_checks`, so they are in no sales report. This is older than this work and is not fixed here.
