# HubRise Integration — Architecture, Data Model & Build Plan

> Status: **code-complete, ready to deploy** (built v5.5.547). Go-live needs the operator
> to register a HubRise OAuth app + set secrets, then apply the migration and deploy the
> edge functions (see **Go-live runbook** at the bottom). All facts below are from the
> official HubRise docs (`www.hubrise.com/developers/*`) captured during research.

## What this is

HubRise is a commerce-data hub that sits between ordering **channels** (HubRise's own
online ordering, plus the Deliveroo / Uber Eats / Just Eat connectors) and a POS. This
integration makes ServOS a connected HubRise EPOS app so that, **per venue**:

1. **Inbound orders** — channel orders flow into the ServOS Orders Hub + KDS and auto-print,
   exactly like online/kiosk orders; ServOS pushes status back (accepted → in prep → ready →
   completed / rejected) so the channel and customer are kept in sync.
2. **Catalog push** — the ServOS menu (categories → items → modifiers, prices, variants) is
   published to HubRise so connected channels show the right catalog.
3. **Inventory / 86 sync** — when an item is 86'd or runs out, ServOS pushes stock `"0"` to
   HubRise so channels stop selling it (and un-86 restores it).

> **Out of scope (by owner decision):** customer / loyalty sync to the HubRise Customer List.
> We still read the customer block embedded on inbound orders (for the receipt / CRM), but we
> do not write ServOS customers up to HubRise.

## Key HubRise facts the build relies on (doc-cited)

- **Auth:** every API call carries `X-Access-Token`; base `https://api.hubrise.com/v1`.
  A connection is created by OAuth2 (authorize at `manager.hubrise.com/oauth2/v1/authorize`,
  exchange code at `POST manager.hubrise.com/oauth2/v1/token` with HTTP-Basic
  `client_id:client_secret`) **or** by a personal access token the operator creates in their
  HubRise back office. The token-exchange response returns the bound
  `account_id / location_id / catalog_id / customer_list_id` — that's how we learn what we're
  connected to. Tokens are long-lived (no refresh flow); `401` ⇒ prompt reconnect.
- **Catalog is ONE document** — `PUT /catalogs/:id` with `{name, data:{variants, categories,
  products, option_lists, deals, discounts, charges}}` is a **whole-document replace** (no
  per-product endpoints). Cross-refs use **client-supplied string `ref`s** — so we use our own
  menu_item / category / modifier ids as the HubRise `ref`s end-to-end. Prices are strings:
  `"9.80 GBP"`. Account-level catalog auto-shares to all locations; we create a **location-level**
  catalog.
- **Inventory is separate from the catalog** — `PATCH /catalogs/:id/location/inventory` with an
  array of `{sku_ref|option_ref, stock, expires_at?}`. `stock:"0"` = sold out; `stock:null`
  (PATCH) removes the entry = unlimited; omitted sku = unlimited. Quantity-based, not a boolean.
- **Orders** — single JSON doc: `status`, `service_type` (`delivery|collection|eat_in`), `ref`
  (channel's order no.), `private_ref` (ours), `collection_code` (short handover no.),
  `expected_time`, `confirmed_time`, `asap`, `items[]` (each `product_name, sku_name, sku_ref,
  price, quantity, options[], deal_line`), `deals{}` map, `discounts[]`, `charges[]` (tips +
  service + delivery all live here — **no dedicated tip/service/tax fields**), `payments[]`
  (PAID is derived: empty payments ⇒ unpaid), `delivery{}` (courier/driver), and an **embedded
  `customer{}`** (first/last name, phone E.164, address_1/2, postal_code, city, country,
  delivery_notes, sms_marketing/email_marketing). **All money is `"<amount> <CCY>"` strings.**
- **Real-time intake = Callbacks.** Register `POST /callback` with `{url, events:{order:[create,
  update]}}`. HubRise POSTs each event; `new_state` carries the **full order** on `create`.
  Delivery is **at-least-once**: HMAC-signed (`X-HubRise-Hmac-SHA256` = HMAC-SHA256 of the raw
  body keyed with our `client_secret`), retried 6× (1→32 min) then **dropped**; we must ACK
  `200` within 20 s. We therefore: **verify HMAC → dedup on the event `id` via a DB unique
  constraint inside the txn → ACK fast → return 5xx (never 4xx) for transient failures.**
  A **passive callback** (`GET/DELETE /callback/events[/:id]`) is the durable replay path — the
  reconcile cron drains it to catch anything missed (List-Orders only filters by *created_at*,
  so it cannot reconcile status changes). A client does **not** receive callbacks for events it
  generated itself (so our own status PATCHes don't echo back).
- **Status push-back = `PATCH /locations/:id/orders/:id`** with `{status, confirmed_time?}`.
  Verbatim enum: `new → received → accepted → in_preparation → awaiting_collection →
  in_delivery → completed`, anomalies `rejected / cancelled / delivery_failed`
  (`awaiting_shipment` is deprecated). Orders need not pass every step. No structured rejection
  reason field (use `seller_notes`); no idempotency primitive ⇒ we apply a **monotonic status
  state-machine** so a stale retry can't move `completed` back to `accepted`.
- **Rate limits** (per connection): 500/min, 2,500/hr, 10,000/day; heavy GETs (incl. full
  catalog) capped at **10/min** — read stock via the inventory GET, not a catalog pull.

## Data model (Ops DB — new migration `20260620_hubrise.sql`)

All tables are **service-role only** (RLS enabled, no policies) — same pattern as
`review_google_tokens`. The Back Office reads status through the `hubrise-connect` edge fn, never
the table directly. The access token never reaches the browser.

| table | purpose |
|---|---|
| `hubrise_connections` | per-venue: `access_token` (SECRET), bound HubRise `account/location/catalog/customer_list` ids, currency, status, callback ids, last-push/sync timestamps, `auto_accept` + `default_prep_minutes` policy |
| `hubrise_oauth_pending` | short-lived OAuth `state` (CSRF guard), like `review_oauth_pending` |
| `hubrise_events` | **dedup/idempotency**: `event_id` PK (the HubRise event id) + processing status — the unique constraint that makes at-least-once delivery safe |
| `hubrise_order_links` | maps `order_queue.ref` ⇄ `hubrise_order_id` (+ channel, service_type, last pushed status, monotonic guard) for status push-back & reconcile |

`order_queue` is **not** schema-churned on the hot path: HubRise orders are written with
`source='hubrise'`, and the HubRise `order_id` / channel / collection_code / address / paid flag
ride in the existing `order_queue.customer` jsonb (same approach as QR open-tabs). The migration
also `DROP CONSTRAINT IF EXISTS order_queue_source_check` defensively so `'hubrise'` is accepted.

## Edge functions (Ops project)

| function | role | auth |
|---|---|---|
| `hubrise-connect` | OAuth start + callback (code→token), personal-token connect, status, register/unregister callbacks, push-catalog trigger, disconnect | Bearer user (location access) or service-role; OAuth callback validates `state` |
| `hubrise-webhook` | **active callback receiver** — verify HMAC, dedup on event id, map `order.create/update` → `order_queue` (+ `hubrise_order_links`), ACK 200 fast | public (HMAC) |
| `hubrise-catalog-push` | build the HubRise catalog from ServOS menus and `PUT` it; create catalog + register callbacks on first push | Bearer user or service-role |
| `hubrise-inventory-push` | `PATCH` inventory — push `"0"` for 86'd items, `null` to restore; full resync builds the whole set | Bearer user or service-role |
| `hubrise-order-status` | `PATCH` a HubRise order's status from a ServOS advance/accept/reject (monotonic), set `confirmed_time` on accept | Bearer user or service-role |
| `hubrise-reconcile` | cron: drain the **passive** event log (replay missed actives), retry failed status pushes, refresh inventory | `x-run-secret` (Vercel cron) or service-role |

Shared libs: `_shared/hubrise.ts` (API client + HMAC verify + money helpers) and
`_shared/hubrise-map.ts` (catalog mapper, order→order_queue mapper, status mapping).

`api/hubrise-cron.js` (+ `vercel.json` cron) invokes `hubrise-reconcile` every minute with
`x-run-secret`, mirroring the `marketing-cron` pattern.

## Front-end

- **BO → Channels → "Delivery channels (HubRise)"** (`src/backoffice/sections/HubRise.jsx`):
  connect (OAuth or paste token), connection status, **Push menu to HubRise**, **Resync stock**,
  auto-accept + prep-time policy, sync log, disconnect.
- **OrdersHub**: HubRise orders get a channel badge + an **Accept (prep mins) / Reject** gate
  before the normal received→prep→ready→collected flow; each transition calls
  `hubrise-order-status` (server-side PATCH, token stays server-side).
- **realtime.js**: `'hubrise'` added to the chime + auto-print whitelist so channel orders are
  unmissable and auto-printed on the master device.
- **printer.js**: `buildHubRiseDeliveryTicket()` — a delivery-aware ticket (big channel + handover
  code header, customer/address/phone, expected time, PAID/UNPAID marker, items+mods+notes,
  ⚠ special-instructions block).
- `src/lib/hubrise.js`: thin client wrappers that call the edge fns with the user's auth token.

## Build slices

1. **Foundation** — migration + `_shared/hubrise.ts` + `_shared/hubrise-map.ts`.
2. **Connect** — `hubrise-connect` + BO section + client lib (operator can link a venue + push catalog).
3. **Inbound orders** — `hubrise-webhook` + realtime whitelist + OrdersHub accept/reject + `hubrise-order-status` + delivery ticket.
4. **Inventory** — `hubrise-inventory-push` + 86-toggle hook.
5. **Reliability** — `hubrise-reconcile` + `api/hubrise-cron.js` + `vercel.json`.

## Go-live runbook (operator + authorized deploy)

1. **Register a HubRise OAuth app** (HubRise back office → Settings → Developer): set the redirect
   URI to `https://<ops-project>.supabase.co/functions/v1/hubrise-connect?action=oauth_callback`.
   Note the `client_id` + `client_secret`.
2. **Set Supabase edge secrets** (Ops project): `HUBRISE_CLIENT_ID`, `HUBRISE_CLIENT_SECRET`,
   `HUBRISE_APP_BASE` (the BO URL to return to), and reuse `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.
3. **Set Vercel env**: `HUBRISE_RECONCILE_SECRET` (and the matching edge secret) for the cron.
4. **Apply** `supabase/migrations/20260620_hubrise.sql` (Ops DB).
5. **Deploy** the six `hubrise-*` edge functions.
6. **Connect a venue** in the BO, **Push menu**, place a test channel order, watch it land in the
   Orders Hub + print, advance it, and confirm status flows back in HubRise.

> Steps 4–5 (migration apply + edge-fn deploy) are gated on explicit owner authorization +
> the Supabase PAT, consistent with this project's security posture.
