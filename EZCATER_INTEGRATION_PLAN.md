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
