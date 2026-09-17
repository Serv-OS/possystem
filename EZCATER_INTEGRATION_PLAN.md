# ezCater Integration Plan

Researched 25 Aug 2026 against the official docs at `https://api.ezcater.io` (all 77 pages crawled, no login required). Every claim below is doc verified unless marked INFERENCE.

---

## Verdict

**Doable, and structurally close to the HubRise flow we already run.** Four edge functions, three new tables, reuse `order_queue`.

**The blocker is commercial, not technical.** Order accept and reject over the API is feature gated per brand by ezCater, and menu write permission needs a written request. Neither can be unlocked by building.

**There is no documented sandbox.** The words "sandbox", "staging", "test environment" and "rate limit" appear nowhere in the docs.

---

## THE TAX DECISION, read this first

**ezCater calculates, charges and in most states remits the sales tax itself.** Our tax profiles engine must NOT recompute it.

- Menu items carry a `taxCategory`, an **Avalara** classification. ezCater uses it to look up rates and charge tax per order.
- Orders carry `taxableAddress`, "either the origin (store) address or the destination (event) address". That is **destination sourcing**, which our cascade has no concept of.
- `totals.salesTaxRemittance` is literally "the sales tax remitted by ezCater".

**Who remits** (source: ezcater.com/company/tax-remittance):

- ezCater remits directly in **33 states plus DC**, including meals taxes (CT, ME, RI, VT, DC) and specials like Colorado's Retail Delivery Fee and Illinois's Restaurant Tax.
- ezCater remits **nothing** in **Alaska, Arizona, California, Delaware, Florida, Massachusetts, Mississippi, Missouri, Montana, Nevada, New Hampshire, New York, Oregon, Tennessee, Utah, Virginia**. There the payment includes all tax collected and the operator remits it.
- Even in facilitator states the operator still owes **locally administered** taxes, which ezCater passes through.

**Consequence:** an inbound ezCater order must not go through `computeOrderTaxUnified` / `buildChannelCloseFields`. Record `salesTax` and `salesTaxRemittance` verbatim plus the state from `taxableAddress`, and mark the check so reporting can split "tax we owe" from "tax ezCater already remitted".

This **inverts** the rule in `src/lib/channelMoney.js`, which deliberately distrusts channel tax and recomputes from our own `tax_profiles`. That rule is correct for HubRise (UK VAT, we are the seller of record). It is wrong for ezCater in 33 states. Recomputing would make the operator's US filings wrong in both directions.

---

## What the API is

- **GraphQL, one endpoint**, `https://api.ezcater.com/graphql`. Static bearer token, no OAuth, no refresh.
- Headers: `Authorization: <token>` (raw, no `Bearer` prefix shown in docs, CONFIRM), plus `apollographql-client-name` and `apollographql-client-version`. All operations must be named.
- Token issued by emailing `integrations@ezcater.com` to create an API user, then generated once in Partner Portal. **It cannot be recovered if lost.**

### Orders arrive as a pointer, not a payload

The webhook body carries `"payload": null`. It gives you `entity_id`, `parent_id` (the caterer) and a `key`. **You must call back with a GraphQL `order(id:)` query to get anything.** So ingest is a two legged operation.

Signature: header `X-Ezcater-Signature`, value `<timestamp>.<hex>`, HMAC SHA256 over `` `${timestamp}.${rawBody}` ``. Nearly identical to our `verifyHmac` in `_shared/hubrise.ts` apart from the timestamp prefix.

### Lifecycle quirks that will bite

- `uncancelled` is subscribable but **never actually fires**.
- **There is no `modified` event.** A modification arrives as a **second `accepted`** with the same order id. We must detect new versus existing.
- **Meal Program (Club Soda) orders never send `submitted` or `accepted`**, only `relish_finalized`, about 90 minutes before the event.
- "Cancelled for Replacement" sends **no** notification for the original order.
- ezCater explicitly advises re-querying the order **immediately before sending it to the kitchen**, because catering orders get edited for days.

### Accept and reject

- `acceptOrder(orderId, acceptModification: Boolean = false)`. Accepting a modification without `acceptModification: true` returns `invalid_state_transition`.
- `rejectOrder(orderId, {reason, explanation})`, 23 reasons including `AT_DAILY_CAPACITY`, `STAFF_SHORTAGE`, `LACK_OF_INVENTORY`.
- Errors to handle explicitly: `404`, `403`, `feature_not_enabled`, `invalid_state_transition`.
- **We cannot amend an order.** No mutation exists.
- **UX cliff:** if we accept via API and the customer then edits, the modification **cannot** be accepted through the API. The operator is forced back into Partner Portal. Design around this, do not hide it.

### Menus

- `menuCreate` only. **There is no `menuUpdate`, no availability mutation, and no 86 mutation.** A change means creating a new dated menu.
- Not supported: nested modifiers, quantity modifiers, dayparts, zero price items, negative price choices.
- **Utensils are mandatory** and we have no utensils concept.
- **Equal Price Guarantee**: ezCater prices must match the venue's lowest online price.
- Lead times are whole hours, 5 to 72.

### Money

- **ezCater takes the payment**, weekly remittance. Commission is not in the docs, it is per contract. Third party sources suggest roughly 15% plus card fees for Marketplace and about 7% for ezOrdering, **unverified**.
- Amounts are in **subunits** as `subunits` (int32) and `subunitsV2` (string). Use `subunitsV2`. Note `catererTotalDue` is inconsistently a float in dollars.
- **Trap:** when `orderType === 'THIRD_PARTY_DELIVERY'`, ezCater does **not** pay the restaurant the tip or the delivery fee even though both appear in the response.

---

## Proposed build

### Edge functions (4)

- **`ezcater-webhook`** — verify signature, dedupe on notification id, resolve location from `parent_id`, fetch the order, ingest. Write the raw notification **before** fetching so the reconciler can replay. Transient failure returns 503. Unknown caterer returns 200 and logs, never 4xx.
- **`ezcater-order-status`** — accept, accept modification, reject. Second fence on `location_id`, mirroring `hubrise-order-status`. Surface `feature_not_enabled` as a specific operator message.
- **`ezcater-connect`** — Back Office only. Save token, create subscriber, list caterers, map each to a ServOS location, subscribe, disconnect. Scrubbed projection so the token never reaches a browser.
- **`ezcater-reconcile`** — pg_cron. Replay errored events, retry failed pushes, and **re-query orders approaching fire time** (the load bearing one).

Note the URL cannot carry the location the way HubRise's `?loc=` does: ezCater allows **one subscriber per API user** covering many caterers, so the location resolves from `parent_id`.

### Tables

Reuse **`order_queue`** (its `source` column has no CHECK constraint and was left open deliberately). `ref = 'EZ-' + order.uuid`. Everything else rides in the `customer` jsonb, same trick as HubRise and QR tabs.

New: **`ezcater_connections`** (keyed on subscriber, not location), **`ezcater_caterers`** (caterer uuid to location mapping), **`ezcater_events`** (dedupe plus raw replay), **`ezcater_order_links`**. RLS enabled with no policies, service role only.

**Migration that must ship first**, or every ezCater sale silently fails to book:

```sql
alter table public.closed_checks drop constraint if exists closed_checks_source_check;
alter table public.closed_checks add constraint closed_checks_source_check
  check (source = any (array[
    'pos','kiosk','online','mobile','catering','hubrise',
    'pax_table_pay','pos_send_to_terminal','adyen_pay_at_table','ezcater'
  ]::text[]));
```

This repo has been burned by that constraint four times. The invariant is: **new `record.source` means widen the constraint.**

### Front end touch points

Register `'ezcater'` in `src/lib/realtime.js` in three places (chime and alert, auto route gate, master backfill scan), add an EZCATER pill and an Accept/Reject branch to `OrdersHub.jsx`, and **add `'ezcater'` to `PREPAID_CHANNELS`** since ezCater always takes payment.

Because orders sit for days they must be excluded from the live queue by the existing `_isFutureCatering` logic and released server side at fire time.

---

## Item matching (no Menus API)

We have the Orders API but **not** the Menus API, so the venue builds its ezCater menu by hand in the Partner Portal and their order lines arrive with `posItemId = null`. `itemId` is what KDS routing, 86, stock depletion and product reporting key on, so an unmatched line is a plain text ticket: no station, no stock, no product mix.

**The key is the normalised name.** Nothing else on a line can carry a link:

| field | can it key a link |
|---|---|
| `posItemId` | stable, but only ever set by `menuCreate`, which we do not have. When it IS set it already names our item. |
| `orderItems[].uuid` | the order LINE, not the product. New every order. **Never a key.** |
| `menuItemSizeId` | ezCater's menu side id. Every doc placeholder is written `ezcater-menu-version-...` and a publish returns a new `menuUuid`, so it looks scoped to a menu VERSION. Unpromised, so unsafe. |
| `name` | free text the venue typed. Stable until they retype it. **This is the key.** |

The cost is visible: rename the item on ezCater and the match must be made again. `ez_name` and `ez_group` keep the venue's own spelling verbatim so a screen can show what was actually seen.

**The rules** live in `src/lib/ezcaterMatch.js`, mirrored for the edge function in `supabase/functions/_shared/ezcaterMatch.ts`, held together by `src/lib/ezcaterMatchParity.test.js`:

- `normaliseItemName`: lower case, no punctuation, no bracketed suffix, no catering noise (`per person`, `serves 10`), no trailing size or container word (`Large`, `Half Pan`, `Full Tray`). Never strips a name away to nothing.
- `scoreMatch` / `suggestMatches`: a ranked shortlist for a person to pick from, with a short plain reason ("same name", "3 of 4 words match"). Deterministic, ties broken by name.
- `autoLinkDecision`: four rules in order: an existing link wins, then a `posItemId` that names a real item of ours, then ONE exact normalised name with no other exact match. **It never guesses between two items that match equally well**, which is the "Caesar Salad Small" and "Caesar Salad Large" case.
- `matchOptions`: the same against our modifier options, their `customizationTypeName` against our group name.
- `buildLinkKey` / `applyLinks` / `countMatches`: the read path both the app and the webhook share.

**Table:** `ezcater_item_links`, keyed `(location_id, kind, ez_key)`, service role only like the rest. Migration `supabase/migrations/20260917_OPS_ezcater_item_links.sql`, Peter runs it by hand. The app works before it runs: a missing table reads as "no links", which is exactly today's behaviour.

**The table is a sightings list first and a link table second.** A row is written the first time ezCater sends a name, with nothing on the other side of it, and a person says later what it is. So a row is in one of three states, all derived from the columns and none of them stored in a state column:

| state | columns | means |
|---|---|---|
| unmatched | no `menu_item_id`, no `option_id`, `matched_by` null | seen, nobody has decided |
| matched | `menu_item_id` or `option_id` set | routes, depletes stock, reports |
| ignored | no target, `matched_by = 'ignored'` | a person pressed "Not on our menu" |

The original target check only allowed the middle row, so an unmatched item could not be recorded at all. It was widened on 17 Sep. **If the migration was already run, run it again**: every constraint is a drop then an add, so a second run repairs the table in place.

### The screen

**Back Office, Channels, 3rd Party orders, "Item matching"** (`src/backoffice/sections/EzcaterItemMatching.jsx`, rendered at the bottom of `HubRise.jsx`, which is that section).

- Two tabs, **Items** and **Options**, each with the outstanding count on it.
- One plain line at the top: "4 of their items are not matched yet."
- Unmatched first, newest seen first. The newest unmatched item is the order sitting on the pass as a plain text ticket right now.
- Each row: their name verbatim, their option group, how many orders it has been on, then either what it is matched to with **Change**, or the picker.
- The picker is the matcher's top suggestions (with a short reason, "same name", "3 of 4 words match") and a search box for everything else. Search is plain substring, not the matcher: "cae" is not a whole token and scores zero.
- **Not on our menu** silences an item the venue never wants matched, for things like "Delivery Fee" and "Utensils".
- **Change** opens the picker over an already matched row without clearing it first. A mis-click must never leave an item routing nowhere.

**Data path.** `ezcater_item_links` is service role only, so Back Office never touches it directly: `ezcater-connect` gained `items_list` and `items_save`, wrapped in `src/lib/ezcater.js`. `items_save` rebuilds `ez_key` from the name with the shared rules and verifies the target really is on that venue's menu. Our own menu is read straight from the browser, so the matcher runs client side.

**Before the migration, and before the edge function is deployed,** the screen shows one line, "Item matching is not switched on yet", and nothing else. All three ways to be in that state are one check, `isMatchingOff()` in `src/lib/ezcaterItemRows.js`. That file is the whole view model and is tested in `ezcaterItemRows.test.js`; the screen is a shell over it.

**Still owed:** nothing writes a sighting row yet. `ezcater-webhook` has to upsert one per line and per customization as it maps an order, bumping `seen_count` and `last_seen_at`, and it must never overwrite a row whose `source` is `'manual'`.

---

## Phases

- **Phase 0, commercial.** Get an API user, a token, confirmation that accept and reject is enabled for the brand, and an answer on test access. Nothing is testable without this.
- **Phase 1, prove the pipe.** `ezcater-connect` plus `ezcater-webhook`, the migration and the tables. Test: a `DIRECT_ENTRY` order against a non live caterer lands in `order_queue` with correct items, headcount and event time.
- **Phase 2, close the loop.** `ezcater-order-status`, the OrdersHub branch, realtime registration, and a `bookEzcaterSale` path with pass through tax.
- **Phase 3, survive reality.** `ezcater-reconcile` with event replay, push retry and the pre fire re-query. Handle the second `accepted`, mid prep cancellation, and `relish_finalized`.
- **Phase 4, reporting.** Facilitator state remittance split, reconciliation against the weekly statement.
- **Phase 5, optional, menu push.** Only if manual Partner Portal setup proves painful, because nested modifiers and utensils are real work.

**Out of scope:** 86 sync (not supported), status push beyond accept and reject (no mutations exist), modification accept after API accept (Partner Portal only).

---

## Questions only ezCater can answer

1. Is there a POS partner programme, or do we onboard per brand as the integrator on each restaurant's API user? Decides one subscriber or one per customer.
2. Will they enable the accept and reject feature flag for our brands, and how long does that take?
3. Will they grant `menuCreate` permission? They reserve the right to withhold it.
4. **Is there any test environment at all?** If not, is a non live caterer plus self placed `DIRECT_ENTRY` orders the intended pattern?
5. **Webhook retry policy**, and which response codes count as success or permanent failure. Undocumented, and it decides how aggressive the reconciler must be.
6. **Rate limits.** Not published, and the pre fire re-query pattern multiplies our call volume.
7. Confirm the query name: the Orders page mentions `orderById` but every example uses `order(id:)`.
8. Confirm `Authorization` really is the raw token with no `Bearer` prefix.
9. The Features page says "if participating in the Menus API, light 86ing is available". **What is the mechanism?** No mutation is documented.
10. Actual commission, and what `pointOfSaleIntegrationFee` represents.
11. **Get the tax position in writing:** confirm the operator treats `salesTax` minus `salesTaxRemittance` as their own liability, that we should not recompute, and get the current facilitator state list since it changes.
12. Is there a per settlement tax statement we can reconcile against, API or portal only?
13. **Can a venue type our item id into the Partner Portal by hand,** so `posItemId` arrives on a menu we never pushed? Nothing in 78 doc pages says either way. A yes removes the need for name matching entirely.
14. **Is `menuItemSizeId` stable across a menu republish,** or is it scoped to the menu version the placeholders suggest? A yes gives us a proper id to key links on instead of the name.
15. Does `orderItems[].uuid` change when a customer modifies an order? Undocumented, and it decides whether a line can be diffed across modifications.
