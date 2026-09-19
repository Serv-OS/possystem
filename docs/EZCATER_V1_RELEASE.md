# ezCater v1 release note

ezCater orders are filed as our own catering orders (ADR-023).
Switch it on in exactly this order. Do not skip ahead.

## 1. Merge and let the app deploy

- **Merge to main.**
- **Then Claude pushes main to develop.** The tills and Back Office load possystem-liard.vercel.app, which serves the develop build.
- **Wait for the app to deploy.** Vercel deploys develop by itself.

## 2. Set the catering prep time

- **Back Office, Channels, Catering ordering, Prep time (minutes).** Set it for this venue.
- **Why:** an ezCater order goes to the kitchen at event time minus this prep time.

## 3. Check every till has the NEW version

- **The merge ships as v5.9.9.**
- **Check the master till AND every Sunmi till.**
- **Where to look:** the till's top bar, next to "What's new".
  - Or tap the Terminal status button: the Version row.
- **It must read exactly v5.9.9.** That is the NEW version number.
- **Sunmi tills keep old code.** A reload is not enough.
  - **The app is "Serv OS POS".** That is its name in Settings, Apps.
  - **Force stop the app:** swipe it away, or Settings, Apps, the app, Force stop.
  - **Then reopen it** and read the version again.
- **Do the master till outside service**, or in a quiet minute.
  - While it is closed, no kiosk, online, QR or delivery app order reaches the kitchen.
  - And no catering order is released. The master does both.
  - It catches up when it reopens.
- **Do not go further until every till shows it.**
- **Why:** an old till does not know an ezCater order. It releases held orders and cancelled orders to the kitchen.

## 4. Deploy the edge functions

- **Claude runs the deploys, and Claude checks them.**
- **From the merged commit only.**
  - Fetch first.
  - `git rev-parse HEAD` must equal the merge commit shown on GitHub.
  - Not a branch, and not an older checkout.
- **With the Supabase CLI**, so `_shared` is bundled.
- **Every deploy has `--no-verify-jwt`.**
  - Without it, every ezCater notification gets a 401 and no ezCater order arrives.
  - There is no `config.toml`, so this flag is the only place that setting lives.
- **In this order:**
  - `catering-release`
  - `order-notify`
  - `review-request`
  - `uber-direct` (it imports `_shared/delivery-dispatch.ts`)
  - `ezcater-connect`
- **Last:** `ezcater-webhook`.
  - Everything above must already know an ezCater order when the first one lands.
- **The exact commands**, one at a time, in this order:

```
npx supabase functions deploy catering-release --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
npx supabase functions deploy order-notify --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
npx supabase functions deploy review-request --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
npx supabase functions deploy uber-direct --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
npx supabase functions deploy ezcater-connect --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
npx supabase functions deploy ezcater-webhook --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
```

- **Then Claude runs** `node scripts/check-deploys.mjs`, from that same checkout, with the token from `~/.zshenv` (the one in `~/.zshrc` is old and gives 401).
  - **The six functions above must match.**
  - **Other functions may show as behind.** That is older drift, not this release. Do NOT run `--deploy` for them as part of this release.
  - It now dates each function by its folder AND every `_shared` file it imports.
  - So a change made only in `_shared/ezcaterCatering.js` shows as not live until redeployed.
- **Then Claude checks the LIVE code**, not the checkout.
  - It reads what Supabase is serving: the Management API function body endpoint.
  - Into a new empty folder. Then it searches only the files in that folder.
  - A search of the checkout proves nothing: the checkout always has the new text.

```
LIVE=$(mktemp -d)
TOKEN=$(grep -o 'sbp_[A-Za-z0-9_]*' ~/.zshenv | tail -1)
for fn in catering-release order-notify review-request uber-direct ezcater-connect ezcater-webhook; do
  curl -sf -H "Authorization: Bearer $TOKEN" -H "User-Agent: Mozilla/5.0" \
    "https://api.supabase.com/v1/projects/tbetcegmszzotrwdtqhi/functions/$fn/body" -o "$LIVE/$fn.eszip"
done
grep -a -c 'the staff alert from the earlier attempt is raised now' "$LIVE"/*.eszip
grep -a -c "retry('event read failed')" "$LIVE/ezcater-webhook.eszip"
```

  - **Each file** is `<name>.eszip` in that folder: the live bundle of that function.
  - **The text** comes from `supabase/functions/_shared/ezcaterCatering.js`.
    - The five that import that file must each count at least 1 for `the staff alert from the earlier attempt is raised now`. Only the new code has that text.
    - Those five: `catering-release`, `order-notify`, `review-request`, `uber-direct`, `ezcater-webhook`.
  - `ezcater-webhook` must also contain `event read failed`.
    - In `ezcater-webhook.eszip`, from `supabase/functions/ezcater-webhook/index.ts`.
  - `ezcater-connect` does not import that file, and it is unchanged by this merge.
    - So `check-deploys` is its check. It must count 0 for the text above.
  - **Any 0 among the five means old code is serving.** Deploy that one again, then check again.

## 5. The old test order HKX77V

- **Cancel it on ezCater.**
- **Then clear it from the till.** Pick one:
  - Orders Hub: tap it straight through to Collected.
    - Only AFTER `order-notify` is live.
    - It reads as paid and texts nobody.
  - Or: Cancel order on MPOS.

## 6. Place a fresh test order

- **Place it on ezCater.** Make it more than the prep time ahead.
- **Check Back Office, Channels, Advance orders.** It shows as "ezCater" plus the order number.
- **Check the fire time.** It goes to the kitchen at event time minus prep time.
- **If ezCater has not accepted it** by then, it is held and the bell shows one urgent alert.

**Menu sync comes in a later release.** Nothing to run or press for it in this one.

## Known gap

- **Sales reports.** ezCater sales are not written to `closed_checks`, so they are in no sales report. This is older than this work and is not fixed here.

# Menu sync, a later release

This part ships later, as its own release, after v5.9.9 above (ADR-024).
Nothing in it is needed for v5.9.9. Switch it on in exactly this order.

## 1. Merge and let the app deploy

- **Merge to main.** Claude sets the version number at the merge.
- **Then Claude pushes main to develop**, as in step 1 above. Back Office loads the develop build.
- **Wait for the app to deploy.** Vercel deploys develop by itself.
- **Reload every Back Office tab** that shows 3rd Party orders.
  - An old tab saves matches that orders do not use.
  - After step 3 an old tab's save is refused, and it says to reload.
- **The tills do not change.** No force stop this time.

## 2. Deploy the two edge functions

- **Claude runs the deploys, and Claude checks them.**
- **From the merged commit only**, as in step 4 above.
  - Fetch first. `git rev-parse HEAD` must equal the merge commit.
- **Every deploy has `--no-verify-jwt`.** Without it no ezCater order arrives.
- **In this order:** `ezcater-connect` first, then `ezcater-webhook` last.
  - Both work before step 3. They keep the old matching rules until then.

```
npx supabase functions deploy ezcater-connect --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
npx supabase functions deploy ezcater-webhook --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
```

- **Then Claude runs** `node scripts/check-deploys.mjs`. Both must match.
- **Then Claude checks the LIVE code**, the same way as step 4 above.

```
LIVE=$(mktemp -d)
TOKEN=$(grep -o 'sbp_[A-Za-z0-9_]*' ~/.zshenv | tail -1)
for fn in ezcater-connect ezcater-webhook; do
  curl -sf -H "Authorization: Bearer $TOKEN" -H "User-Agent: Mozilla/5.0" \
    "https://api.supabase.com/v1/projects/tbetcegmszzotrwdtqhi/functions/$fn/body" -o "$LIVE/$fn.eszip"
done
grep -a -c 'no synced option on this item with this exact name' "$LIVE"/*.eszip
```

  - **Both must count at least 1.** Only the new code has that text.
    - It comes from `supabase/functions/_shared/ezcaterMenuSync.ts`, which both ship.
  - **A 0 means old code is serving.** Deploy that one again, then check again.

## 3. Run the migration, outside service

- **Outside service only**, or when no ezCater order is due to fire.
- **Run `20260919m_OPS_ezcater_menu_sync_v1.sql`** in the SQL editor.
  - OPS project only. Needs `20260917_OPS_ezcater_item_links.sql` first.
  - **Ran an older copy of it before?** Run this one anyway. It is safe to run twice.
- **From here until step 4** every ezCater line prints by name.

## 4. Press Sync straight away

- **Item matching: press Sync ezCater menu.**
- **Only exact names match themselves.** Match the rest by hand.
  - Each item shows its size, so you never match blind.
  - Each option shows its item. A match on "Large, on Pizza" is for Pizza only.

### If the first Sync fails

- **Orders are safe.** Every ezCater line prints by name, as plain text.
  - Nothing is routed to the wrong item. The kitchen reads the name.
- **Press Sync ezCater menu again.** Wait a minute first if it says a sync is running.
- **Where to see the error:**
  - The message shown straight after you press Sync.
  - The grey line under the Sync button: "The last try did not complete", then the reason.
- **Call Claude if:**
  - The second Sync fails too.
  - It says "Menu sync is not switched on yet". Step 3 did not run, or ran an older copy.
  - It says "Could not read the saved matches" or "No ezCater caterer is linked".
  - It says "Some of it did not complete" and names a column.
- **Claude reads** the `ezcater_menu_syncs` row for the venue (status and error), then fixes it.

## 5. Check your earlier matches once

- **Your earlier matches carry over.**
- **Where the ezCater name now says a size**, the card asks you to check it once.
  - For example: Turkey Sandwich, now sold only as Box.
  - Most single size items are like this.
  - Tap **Still right**, or **Change**.
  - Until you do, that item prints by name.

## The new rule

- **Orders only use matches made before the order.** Exact names found by the sync, or matches staff saved.
- **A match is used only for the exact name and size it was made for.**
  - And only when ezCater's id for it is on that match.
- **Nothing is guessed from a name.** Anything else prints by name, as plain text.
- **When ezCater renames an item or a size**, press Sync. The new name needs its own match.
