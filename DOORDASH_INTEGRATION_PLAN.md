# DoorDash Integration Plan

Researched 25 Aug 2026 against `developer.doordash.com`. DoorDash sells **two separate products** and they solve different problems. Keep them apart.

- **Drive** = white label courier for our OWN orders. The **Stuart** analogue.
- **Marketplace** = orders placed in the DoorDash app arriving into the POS. The **HubRise / Deliveroo** analogue.

---

## Verdict

### Neither product exists in the UK

**This is the headline.** Drive operates in **US, Canada, Australia and New Zealand** only. Marketplace merchant availability is the same four countries. **Every ServOS venue today is in the UK, so both would deliver zero value right now.**

The UK DoorDash story is **Deliveroo**: DoorDash completed its acquisition on **2 October 2025**, and we already receive Deliveroo orders through HubRise. That is our DoorDash exposure in the UK and it already works.

### Drive: technically easy, commercially gated

- Slots in as a second `dispatch_backend` beside Stuart. The discriminator column, quote pipeline, surcharge engine, `courier_deliveries` table and tracker all already exist. **Roughly 3 to 4 days to a working sandbox dispatch.**
- Money units line up exactly: Drive returns fees in **cents**, and our whole surcharge pipeline is integer minor units. Stuart needs a pounds to pence conversion, Drive needs none.
- **Blocker, stated on three separate doc pages:** *"Production access to the Drive API is currently restricted, and we cannot provide a timeline for certification following development."* Sandbox is self serve. Production is not.
- Production gate: business details, **a payment method on file**, then a **30 to 60 minute Zoom demo** screen sharing an end to end test delivery. Credentials 5 to 10 days after approval.

### Marketplace: a partner programme, not an API

- *"Marketplace APIs are not yet generally available."* Application, assigned Technical Account Manager, certification **by screen recording**, and a 48 business hour support SLA.
- **SSIO OAuth onboarding is mandatory** for multi merchant platforms like ours. That phase alone is comparable in size to the entire HubRise integration.
- Requires us to **host two endpoints DoorDash calls**: a Menu Pull endpoint and an item availability poll endpoint. HubRise never needed either.
- Their "Established" partner tier wants **250+ DoorDash stores**, order failure rate under 1% and merchant cancel rate under 1%.

### Which first

**Drive first for code, Marketplace first for paperwork.** Neither is gated on engineering, so start both applications before writing anything.

---

## THE US COURIER GAP, which is the real finding

**Stuart operates in France, Poland and the UK only.** It cannot serve a US venue at all.

So the moment a US venue wants delivery from our own online ordering, **we have no courier**, and **DoorDash Drive is the only realistic option**. That, not Marketplace, is the reason to care about DoorDash.

### One structural change Drive forces

Stuart uses **per venue** credentials, so the venue owns its courier account and its own bill. Drive credentials are **developer scoped**, production approval is **per account**, and **the delivery is charged to the developer's credit card at creation**.

That turns delivery from a pass through into a **rebilled margin product**: ServOS pays the courier and bills the venue. The surcharge engine already models this (`true_cost_minor`, `customer_fee_minor`, `margin_minor` on `delivery_costs_actual` and `delivery_surcharges`), so the code is ready. **The cash flow, credit exposure and pricing conversation are not.**

---

## Drive: the build

**Auth:** JWT **HS256**, header `{"alg":"HS256","typ":"JWT","dd-ver":"DD-JWT-V1"}`, payload `aud:"doordash"`, `iss`=developer_id, `kid`=key_id. **Max lifetime 30 minutes**, sent as `Authorization: Bearer <jwt>`. Credentials are `developer_id` / `key_id` / `signing_secret`, the secret shown once.

**Endpoints:** `POST /drive/v2/quotes`, `POST /drive/v2/quotes/{id}/accept`, `POST /drive/v2/deliveries`, `GET`/`PATCH /drive/v2/deliveries/{id}`, `PUT .../{id}/cancel`. Base `https://openapi.doordash.com/drive/v2/`.

**Pricing (published, USD):** $9.75 base under 5 miles, +$0.75/mile to a 15 mile max, **$2.75 discount** if you collect a tip and pass 100% of it to DoorDash. **Returns cost 60%** of the original fee. Quotes expire in **5 minutes**.

**New files**

- `supabase/functions/_shared/doordash.ts`, a direct sibling of `_shared/stuart.ts`: `signDriveJwt` (Deno Web Crypto), quote / accept / create / get / cancel, `mapDoorDashStatus`, `parseDriveDelivery`. Cache the JWT ~25 minutes (Stuart's cache is ~30 days).
- `supabase/functions/doordash-webhook/index.ts`, sibling of `stuart-webhook`. Auth is **Basic Auth**, not a `?key=` param and **not HMAC** (DoorDash documents no signature).

**Migration**, additive:

1. Widen **both** `dispatch_backend` CHECK constraints to add `'doordash'`. There are two: on `venue_uber_config` and on `courier_deliveries`. **Missing the second one silently breaks dispatch**, and that exact failure is already recorded in our changelog.
2. Add `doordash_external_business_id` and `doordash_external_store_id` to `venue_uber_config`.

**Webhook tenancy, the one real design constraint.** DoorDash allows **one webhook endpoint per environment** across the whole developer account, so we cannot use the `?loc=` trick that `stuart-webhook` and `hubrise-webhook` both rely on. Fix: set `external_delivery_id` to the `courier_deliveries.id` uuid at creation. It is globally unique, DoorDash echoes it on every event, and the handler derives `location_id` from the row.

**Refactor this codebase needs anyway.** There is a real discriminator (`dispatch_backend`) but **no abstraction layer**: about six places hand write `if (x === 'stuart')`, and the naming is Uber's throughout even though Stuart is the live provider. Adding a third provider is exactly when a small `_shared/courier-providers.ts` registry pays for itself. Sites to touch: the dispatch and quote branches in `_shared/delivery-dispatch.ts` and `uber-direct/index.ts`, `refreshStuartRow` (becomes `refreshCourierRow`), the three `dispatch_backend === 'stuart'` guards, the cancel branch, the `set_stuart_creds` / `test_stuart` / `disconnect_stuart` actions, the status maps in `src/lib/delivery/status.js`, and about 30 hardcoded "Stuart" strings in `UberDirect.jsx` (line 105 force sets `dispatch_backend:'stuart'` whenever courier mode is on).

Leave `delivery_mode === 'uber'` alone: it is a boolean "is courier" flag wearing a provider's name, orthogonal to `dispatch_backend`. Just do not let `'doordash'` leak into it.

**Phases:** 0 paperwork (day one, it is the long pole) → 1 prove the JWT and a quote against sandbox → 2 migration plus dispatch branch → 3 webhook and tracker → 4 cancel, returns, Back Office provider selector → 5 the Zoom demo. **Phases 1 to 4 are 3 to 4 days. Phase 0 and 5 are the schedule.**

---

## Marketplace: the build

Mirror the HubRise six, plus the two hosted endpoints.

| New function | HubRise analogue | Note |
|---|---|---|
| `doordash-connect` | `hubrise-connect` | Much bigger: full SSIO OAuth. Better template is `xero-*` (per venue OAuth with refresh) since the merchant JWT expires after **1 hour** |
| `doordash-order` | `hubrise-webhook` | Inbound `OrderCreate`, Basic Auth not HMAC |
| `doordash-menu` | `hubrise-catalog-push` | **Double duty**: pushes menus AND hosts the Menu Pull endpoint DoorDash calls |
| `doordash-order-status` | `hubrise-order-status` | Accept / reject / Order Ready Signal |
| `doordash-inventory-push` | `hubrise-inventory-push` | 86ing plus a hosted availability poll endpoint |
| `doordash-reconcile` | `hubrise-reconcile` | Same pg_cron pattern |

**Reuse `order_queue`** with `source='doordash'`, `ref='DD-<order.id>'`. Its `source` column has no CHECK. **But `closed_checks_source_check` does**, so widen it or every booking silently fails. Same invariant as ezCater and the four previous times this repo has been burned.

**Money:** DoorDash order money is in **cents**, `order_queue.total` is major units. Divide by 100 in exactly one place, the mapper.

**Path to POS and KDS needs no new code**, only two whitelist entries in `src/lib/realtime.js` (chime/alert gate and master backfill scan). The existing realtime channel, `routeKioskOrderPrints` atomic claim and `order_queue_notify` trigger all work unchanged. Six more whitelists for reporting and filters.

**One real behavioural difference from HubRise:** returning `202` gives us only **3 to 8 minutes** to confirm the order or it auto fails. HubRise has no deadline. That needs a hard timer, probably in `doordash-reconcile`.

**Do not** ride the `source='hubrise'` pipe with `customer.channel='DoorDash'`. Billing keys off `venue.hubrise` in the admin portal and the pipe name would be a lie.

---

## Drive versus Stuart, honestly

| | Stuart | DoorDash Drive |
|---|---|---|
| **UK** | **129 cities, France / Poland / UK. Live in production today** | **Not available** |
| **US** | **None. Cannot serve a US venue at all** | Broad US coverage. **The only option** |
| **Auth** | OAuth2 client_credentials, token cached ~30 days | JWT HS256, 30 min max |
| **Billing** | Per venue, venue is the biller | **Developer's card, charged at delivery creation.** ACH invoicing on request |
| **Webhook** | Per venue URL, shared secret in `?key=` | **One endpoint per environment**, Basic Auth |
| **Production gate** | Venue signs up with Stuart | **Restricted, no published timeline**, plus a live Zoom demo |

**For the UK: no contest, do not build Drive.** **For the US: Drive or nothing.**

---

## Open questions only DoorDash can answer

**Drive**

1. **When does production access realistically reopen?** They refuse to give a timeline on three pages. Everything else is moot until this is answered.
2. **Can a POS platform hold ONE developer account and dispatch for many merchant businesses?** The Business/Store model implies yes but no doc addresses platform or reseller use. This decides whether the plan above is even permitted.
3. If not, does **every venue** need its own production approval and Zoom demo? That would be unworkable.
4. Is per venue billing possible, or is the developer's card always the payer?
5. CA / AU / NZ price cards. Only USD pricing is published.
6. Any UK Drive equivalent on the roadmap now they own Deliveroo?

**Marketplace**

7. **Are they accepting new POS partners at all?** "Not yet generally available" plus a 250 store bar is a high floor for a platform with six UK venues and no US venues yet.
8. Which base host is correct, `api.doordash.com` or `openapi.doordash.com`? **The docs contradict each other.**
9. Can the Orders webhook be self configured in the portal, or must DoorDash configure it? **The docs contradict each other here too.**
10. Can `merchant_supplied_id` round trip our own `menu_items.id` on items **and** item options, the way HubRise refs do? If not we need a SKU mapping table this codebase deliberately does not have.
11. Commission for a POS referred merchant, and does ServOS earn anything? (Published merchant rates: Basic 15%, Plus 25%, Premier 30%, pickup 6%.)
12. Does owning Deliveroo create a UK path, or does Deliveroo's own partner API remain the UK route?
