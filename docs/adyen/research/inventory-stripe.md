# STRIPE Audit — Full Inventory for Adyen Migration

Repo root: `/Users/peterroberts/Library/CloudStorage/Dropbox/POSUP/Claude Code/Test POS app/possystem`

## Architecture summary

- **Model:** Stripe **Connect direct charges** on per-location connected accounts (`acct_...`), platform revenue via `application_fee_amount` computed from `get_effective_markup` RPC (platform DB). All card-present flows are **server-driven REST** (no Terminal SDK on device since v5.5.58) against BBPOS WisePOS E / S700 network readers: create PI → `processPaymentIntent` on reader → client polls ~1s. Online = Stripe.js Elements + `confirmCardPayment`. Gift purchase = hosted Stripe Checkout Session. QR/bar tabs = manual-capture pre-auth + capture/increment/off-session-overage.
- **Two DBs:** merchant accounts, readers, reader settings, webhook events live on **Platform DB** (`yhzjgyrkyjabvhblqxzu`); checks/orders on **Ops DB** (`tbetcegmszzotrwdtqhi`). All 17 `stripe-*` edge fns are deployed to Ops project but write mostly to Platform DB via `PLATFORM_SUPABASE_SERVICE_ROLE_KEY`.
- **Ryft precedent:** dual-processor plumbing already exists (`locations.payment_processor`, `closed_checks.processor`, `payments-processor` fn, per-surface dispatch). Adyen slots in as a third (or replacement) value on this switch — follow the Ryft pattern.

---

## 1. Edge functions — `supabase/functions/stripe-*` (17)

### stripe-create-payment-intent (135 lines)
- **Purpose:** create PI on connected account with `application_fee_amount` from markup (`get_effective_markup(location_id, channel)`; channel `'card_present'|'online'`); supports `capture_method: manual` and `setup_future_usage: 'off_session'` (QR tab saved-card overage).
- **In:** `{location_id, amount_minor, currency(gbp|usd|eur), channel, payment_method_types, capture_method, setup_future_usage, closed_check_id, description, metadata}`. **Out:** `{client_secret, payment_intent_id, status, stripe_account, markup_percent, application_fee_minor}`.
- **Reads:** platform `merchant_stripe_accounts(stripe_account_id, charges_enabled)`. Writes nothing.
- **Callers:** `src/lib/stripeClient.js:createPaymentIntent()` → OnlineCheckout.jsx:635, QrCheckout.jsx:275, CateringCheckout.jsx:171, AdminStripeTest.jsx:69; direct fetch in MCardFlow.jsx:109 (Tap to Pay path).
- **Adyen equiv:** `POST /sessions` or `/payments` on the merchant's Adyen account (or split with `splits[]` for the platform fee) returning a session/clientKey for Web Drop-in; must support manual capture + tokenisation (`storePaymentMethod`/`recurringProcessingModel: UnscheduledCardOnFile`).

### stripe-process-payment-on-reader (250)
- **Purpose:** THE in-person flow. Resolves ops `devices` row → platform `locations` (`ops_location_id` OR direct id) → `payment_devices` bound to that POS (`bound_pos_device_id`) → `merchant_stripe_accounts`; creates `card_present` PI (markup via `get_effective_markup(..., 'cardpresent')` — NOTE spelling differs from create-payment-intent's `'card_present'`); pushes cart to reader (`setReaderDisplay`), calls `terminal.readers.processPaymentIntent` with `process_config.tipping.amount_eligible` (on-reader tip) or `skip_tipping:true`; stamps `payment_devices.status/last_seen_at/ip_address/firmware_version`.
- **In:** `{pos_device_id, amount_minor(≥30), currency, line_items?, closed_check_id?, skip_tipping?, capture_method?('manual' = bar-tab hold)}`. **Out:** `{payment_intent_id, reader_id, reader_label, tipping_enabled, capture_method, stripe_account_id, ...}`.
- **Callers:** CheckoutModal.jsx:260, SplitModal.jsx, KioskApp.jsx:3049, MCardFlow.jsx:184, TabPreAuthTerminal.jsx.
- **Adyen equiv:** Adyen Terminal API (cloud) `PaymentRequest` to the assigned terminal (POIID), with on-terminal tipping config and pre-auth support (`authorisationType: PreAuth`); must return an id the POS can poll or receive sync result for.

### stripe-poll-reader-action (117)
- **Purpose:** ~1s poll during payment: retrieves PI (expand `latest_charge`) + reader action; returns PI status, reader action status/failure, and a **card-present receipt block** `{brand,last4,read_method,auth_code,aid,application_name,cvm,account_type}` (UK card-scheme receipt fields, formatted by `src/lib/cardReceipt.js`), plus `is_terminal_state`/`is_success`.
- **Callers:** CheckoutModal.jsx:302, SplitModal, KioskApp.jsx:3089, MCardFlow.jsx:204, TabPreAuthTerminal (detects `requires_capture` for holds).
- **Adyen equiv:** Terminal API is synchronous (or use `/status` TransactionStatusRequest + webhooks); MUST surface the same EMV receipt fields (Adyen returns AID/auth code/CVM in `additionalResponse`) — receipts legally depend on them.

### stripe-cancel-reader-action (141)
- **Purpose:** abort in-flight payment: `readers.cancelAction` (with before/after diag), cancel PI, reset reader display to a zero-amount "Welcome" cart (Stripe rejects empty line_items).
- **In:** `{payment_intent_id?, reader_id?, location_id, currency?}` — reader-only mode (no PI) = force-cancel stuck reader.
- **Callers:** CheckoutModal (unmount guard :128 + cancel), SplitModal, KioskApp:2929, TabPreAuthTerminal, BarSurface.jsx:425 (release hold on tab void), forceCancelReader.js, CardReaders.jsx:313 (BO force-cancel button).
- **Adyen equiv:** Terminal API `AbortRequest` + `/payments/{id}/cancels` (auth reversal for holds) + idle-display reset.

### stripe-refund (127)
- **Purpose:** refund a PI on the connected account, with per-leg `idempotencyKey` (`refund:<check>:<pi>`) for multi-card splits; metadata `{closed_check_id, staff_id, location_id, source:'pos_refund'}`.
- **Caller:** `refundCheck()` in `src/store/index.js` (~:5152) — allocates refund across `closed_checks.payment_intents[]` legs front-to-fill, routes by `closed_checks.processor`.
- **Adyen equiv:** `POST /payments/{pspReference}/refunds` with idempotency key; async result arrives by REFUND webhook — the POS fire-and-forget pattern must tolerate that.

### stripe-increment-authorization (60)
- **Purpose:** raise a bar-tab hold on the existing manual-capture PI (`paymentIntents.incrementAuthorization`); returns `{ok:false,error}` at HTTP 200 when the issuer doesn't support it so the client falls back.
- **Caller:** BarSurface.jsx:448 ("step up hold").
- **Adyen equiv:** `/payments/{pspReference}/amountUpdates` (adjust authorisation) — same graceful-fallback contract.

### stripe-terminal-connection-token (55)
- **Purpose:** issues Terminal connection token scoped to connected account. Legacy: was for the (removed) Android Terminal SDK; still referenced by MPOS Tap to Pay native bridge (TapToPayBridge fetches it, per changelog).
- **Adyen equiv:** none needed for cloud Terminal API; if using Adyen POS Mobile SDK (Tap to Pay), replace with the SDK's session/setup call.

### stripe-register-network-reader (143)
- **Purpose:** admin registers reader by registration code: ensures Stripe **Terminal Location** exists (creates one, persists `locations.stripe_terminal_location_id`), `terminal.readers.create`, **inserts platform `payment_devices`** row (`stripe_reader_id, stripe_account_id, device_type, connection_kind:'network', serial_number, label, registration_code, status, last_seen_at, registered_by_user_id, bound_pos_device_id`); rolls back Stripe reader on DB failure. Also lazy-upserts `platform_users` for the caller.
- **Caller:** CardReaders.jsx:502.
- **Adyen equiv:** terminal ordering/boarding is done in Adyen dashboard; equivalent = "claim/assign terminal to store" API (Management API `/terminals` + terminal assignment) writing the same `payment_devices` row keyed by POIID instead of `rdr_`.

### stripe-unregister-reader (147)
- **Purpose:** remove reader: cancelAction, if last reader at location clear splashscreen off shared Terminal Configuration, `readers.del`, delete `payment_devices` row.
- **Caller:** CardReaders.jsx:161.
- **Adyen equiv:** Management API terminal unassignment + row delete; replicate "leave device clean" behaviour.

### stripe-readers-status (125)
- **Purpose:** BO live-status refresh: `readers.retrieve` per network reader; writes back `payment_devices.ip_address, firmware_version, status, serial_number, label, device_type, last_status_check_at, last_seen_at`.
- **Callers:** CardReaders.jsx:121, StatusDrawerCardReaders.jsx:85 (POS status drawer).
- **Adyen equiv:** Management API `GET /terminals` / terminal connectivity status feeding the same columns.

### stripe-assign-reader-to-pos (87)
- **Purpose:** bind/unbind a network reader to a POS/kiosk device: validates ops `devices` row type ∈ pos|kiosk and same location (cross-DB via `locations.ops_location_id`); updates `payment_devices.bound_pos_device_id` (+ `customer_display_enabled`).
- **Callers:** CardReaders.jsx:283 and :581.
- **Adyen equiv:** pure internal mapping — keep table, swap the reader id semantics (POIID); no Adyen call required.

### stripe-sync-location-reader-config (184)
- **Purpose:** reads `location_reader_settings` (tipping_enabled, tip_percentages, allow_custom_tip, smart_tip_threshold_minor, idle_screen_*) → create/update Stripe **Terminal Configuration** (tipping per currency + splashscreen for wisepos_e/s700) → assigns via `terminal.locations.update({configuration_overrides})`; persists `stripe_configuration_id`, `stripe_configuration_synced_at`.
- **Caller:** CardReaders.jsx:792 (Save reader settings).
- **Adyen equiv:** Terminal settings API (gratuities/tipping config per store/terminal) + standalone branding upload; same settings table drives it.

### stripe-upload-reader-splashscreen (162)
- **Purpose:** base64 image → Stripe Files API (`purpose: terminal_reader_splashscreen`, ≤512KB, PNG/JPEG) on connected account; writes `location_reader_settings.idle_screen_file_id/mime/uploaded_at/uploaded_by/idle_screen_enabled`; `action:'remove'` clears. NOTE: PaxTerminals.jsx shares the same venue idle image via `idle_screen_image_url` (human-viewable copy).
- **Caller:** CardReaders.jsx:689/729.
- **Adyen equiv:** Management API terminal branding/logo upload; keep the settings columns, replace `file_` id with Adyen's asset reference.

### stripe-update-reader-display (173)
- **Purpose:** live cart on reader screen: resolves POS device → bound reader (falls back to ANY reader at location), skips if a payment action in progress, `setReaderDisplay` cart (or two-step clear: cancelAction + zero-amount "Ready for next order" cart).
- **Caller:** `src/lib/readerDisplay.js` (debounced 600ms from POSSurface.jsx:469 whenever the cart changes; per-reader toggle cached from `payment_devices.customer_display_enabled`).
- **Adyen equiv:** Terminal API `DisplayRequest` (or accept feature loss on terminals without cart display) — this is a marquee UX feature, flag if Adyen device can't do it.

### stripe-link-merchant (104)
- **Purpose:** super_admin pastes `acct_...`: validates via `accounts.retrieve`, upserts `merchant_stripe_accounts` (location_id, company_id, stripe_account_id, link_method:'admin_manual', charges_enabled, payouts_enabled, details_submitted, country, default_currency, capabilities, requirements, linked_at), ensures `billing_state` row.
- **Callers:** AdminBillingManager.jsx:728 (StripeLinkModal), `stripeClient.js:linkMerchantAccount()`.
- **Adyen equiv:** link an Adyen `merchantAccount`/balance account per location → new `merchant_adyen_accounts` table mirroring `merchant_ryft_accounts`; onboarding status from Adyen (KYC) instead of charges_enabled.

### stripe-webhook (56) — platform account
- **Events:** ALL platform events; verifies `STRIPE_WEBHOOK_SECRET`; **writes:** `stripe_webhook_events(id, type, livemode, account_id:null, payload, processed_at)` — dedupe on PK 23505. Log-only, no business logic.
- **Adyen equiv:** single Adyen standard-webhook endpoint with HMAC verification → `adyen_webhook_events` ledger; must ACK `[accepted]`.

### stripe-webhook-connect (153) — connected accounts
- **Events handled:** `account.updated` / `account.application.deauthorized` / `capability.updated` → update `merchant_stripe_accounts` status columns (+`last_webhook_at`); `checkout.session.completed` with `metadata.type=gift_card_purchase` → set `gift_card_purchases.status='paid'`, `stripe_payment_intent_id`, then server-to-server call `gift-fulfill` (issues + emails the card). `payment_intent.succeeded/payment_failed`, `charge.refunded` — **logged only** (closed_checks reconciliation explicitly deferred).
- **Adyen equiv:** AUTHORISATION/CAPTURE/REFUND/CHARGEBACK webhooks + KYC notification webhooks; MUST preserve the gift-fulfilment contract: metadata keys `type=gift_card_purchase` + `purchase_id` → call `gift-fulfill` (ryft-webhook already replicates this — copy it).

---

## 2. Vercel serverless — `api/`

### api/stripe-capture.js (119)
- Captures a manual-capture PI on a connected account (`Stripe-Account` header, raw REST). Clamps to `amount_capturable`, reports `shortfall`/`capped_from_overage`. Requires **Vercel** env `STRIPE_SECRET_KEY` (separate store from Supabase secrets!).
- **Callers:** OrdersHub.jsx:439/675 (operator close & charge QR tab; force-close), TabResumeScreen.jsx:57 (customer self "Close & pay"), BarSurface.jsx:481 (capture bar-tab hold at close).
- **Adyen equiv:** `/payments/{pspReference}/captures` with amount ≤ authorised; keep shortfall reporting for the overage step.

### api/stripe-charge-overage.js (106)
- New PI `off_session=true, confirm=true` on the saved `payment_method` (stored at tab open via `setup_future_usage='off_session'`) to charge bill−preauth remainder; surfaces decline codes.
- **Callers:** OrdersHub.jsx:482, TabResumeScreen.jsx:97.
- **Adyen equiv:** `/payments` with `shopperReference` + stored `recurringDetailReference` (`shopperInteraction: ContAuth`, `recurringProcessingModel: UnscheduledCardOnFile`).

---

## 3. Client libraries — `src/lib/`

| File | Status | What it does | Adyen action |
|---|---|---|---|
| `stripe.js` (189) | **DEAD scaffold** — no importers (changelog-only refs); mock Terminal SDK flow | delete |
| `stripeClient.js` (95) | LIVE — `loadStripe` per connected account (`{stripeAccount}` cache), `createPaymentIntent()`, `linkMerchantAccount()` helpers | replace with Adyen Web (Drop-in/Components) loader keyed by merchantAccount + clientKey; new create-session helper |
| `networkReader.js` (69) | resolves platform location (`locations.id`/`ops_location_id`) + reads assigned reader from `payment_devices` (`connection_kind='network'`, `bound_pos_device_id`, selects `stripe_reader_id, customer_display_enabled, ...`) | keep; rename `stripe_reader_id` → terminal POIID |
| `readerDisplay.js` (136) | debounced live-cart push → `stripe-update-reader-display`; localStorage toggle `rpos-reader-display-enabled` | repoint at Adyen display fn or gate off |
| `forceCancelReader.js` (55) | resolves assigned reader, calls `stripe-cancel-reader-action` reader-only | repoint at Adyen abort fn |
| `payments/processor.js` | per-location dispatch `'stripe'|'ryft'` via `payments-processor` fn; **fail-safe defaults to 'stripe'** with `definitive:false` | add/replace `'adyen'`; audit every fail-safe default |
| `tapToPay.js` | promise wrapper for MPOS native bridge `window.RposTapToPay` (Stripe Tap to Pay on Android; SDK lives in the separate mpos APK, main `android/` wrapper had Terminal SDK ripped out v5.5.58) | Adyen POS Mobile SDK rewrite of the native module, or drop feature (see memory: MPOS tap-to-pay decision open) |
| `cardReceipt.js` | maps Stripe `read_method`/CVM strings (`contactless_emv`, `magnetic_stripe_track2`...) to UK receipt labels | add Adyen entry-mode mapping |
| `currency.js` | `stripeCurrency()` returns lowercase ISO ('gbp') — used by ~15 files | harmless rename; Adyen wants UPPERCASE ISO + minor units |

---

## 4. Surfaces (who runs which flow)

**POS checkout — `src/surfaces/CheckoutModal.jsx`** (~2200): reader REST flow (process→poll→cancel), unmount auto-cancel guard (:121-130), tip captured ON reader (Stripe) vs on-screen (Ryft/PAX), training-mode fake PI `pi_training`; `complete()` records `stripePaymentIntentId`, `paymentIntents[]`, `cardReceipt`, `processor`. Adyen: same state machine, new endpoints, decide tip-on-terminal.

**Split — `src/components/SplitModal.jsx`**: same reader flow per card portion; emits `paymentIntents[]` (one per leg) so multi-card refunds work. Adyen: one terminal payment per leg, keep leg array shape.

**Bar tabs — `src/surfaces/BarSurface.jsx` + `src/components/TabPreAuthTerminal.jsx`**: pre-auth hold via `capture_method:'manual'` on reader (poll detects `requires_capture`), tab stores `preAuthPaymentIntentId`/`preAuthStripeAccount`/`preAuthHeldMinor`; step-up via stripe-increment-authorization; release via stripe-cancel-reader-action; capture at close via `/api/stripe-capture`. **Pre-auth is currently Stripe-only** (`canPreAuth` disabled on definitive Ryft venues, BarSurface:186-196) — Adyen card-present pre-auth restores this on Ryft-blocked venues.

**Kiosk — `src/surfaces/KioskApp.jsx`** (:3019-3110): server-driven reader payment with `skip_tipping:true` (kiosk collects tip in own UI), poll loop, cancel handles both processors. Adyen: same, terminal must accept skip-tip.

**MPOS — `src/surfaces/mpos/MCardFlow.jsx`** (314): 3-tier — (1) native Tap to Pay: `stripe-create-payment-intent` (`channel:'card_present'`) + native `tapCollect` with `VITE_STRIPE_TERMINAL_LOCATION_ID`/`deviceConfig.tapTerminalLocationId`; (2) assigned reader REST flow; (3) simulated. Adyen: tiers 2 easy, tier 1 = native SDK work.

**Online — `src/surfaces/online/OnlineCheckout.jsx`** (~2000): Elements `CardElement` + `confirmCardPayment` (:1889-1911); PI net of gift/loyalty; writes `order_queue` + `closed_checks` (`stripe_payment_intent_id`, `payment_intents`, `processor`, `method:'card'|'split'`). Adyen: Drop-in/Components + `/payments`; Apple Pay/Google Pay comes almost free here (post-launch task).

**QR — `src/surfaces/qr/QrCheckout.jsx`, `TabResumeScreen.jsx`, `OrdersHub.jsx`**: pay-now (auto capture) or open-tab (manual capture + `setup_future_usage:'off_session'`); tab identity lives in `order_queue.customer` jsonb + localStorage stash (`qrTabStorage`) — fields `payment_intent_id`, `stripe_account`, `payment_method_id`, `processor`, `tab_ref`, `tab_join_code` (NEVER `bar_tabs` — invariant). Close = capture (+ overage). Adyen: pre-auth `/payments` + tokenisation; stash Adyen pspReference + shopperReference/token in the same jsonb keys.

**Catering — `src/surfaces/catering/CateringCheckout.jsx`**: pay-now via `createPaymentIntent` + Elements (mirrors OnlineCheckout PayStep); writes closed_check `source:'catering'` with same PI columns.

**Gift purchase — `src/surfaces/gift/GiftPurchaseSurface.jsx` + `GiftSuccessSurface.jsx`**: calls `gift-checkout-session` → redirect to Stripe **Checkout hosted page** (`checkout_url`); success page polls `gift-purchase-status` by `session_id` (`cs_...`) or `purchase_id`. Adyen: **no hosted-checkout parity decision needed** — either Adyen Pay by Link / Hosted Checkout, or copy the Ryft in-page pattern already built in `gift-checkout-session` (v5.5.911). Fulfilment webhook contract (§1 webhook-connect) must carry over.

**BO Card readers — `src/backoffice/sections/CardReaders.jsx`** (~1030): full reader admin — register (code), unregister, refresh status, assign to POS, customer-display toggle, force-cancel, tipping settings, splashscreen upload, config sync (`stripe_configuration_synced_at` shown). Adyen: rewrite against Management API; keep `payment_devices` as the source of truth.

**POS status drawer — `src/components/StatusDrawerCardReaders.jsx`**: reads `payment_devices`, calls stripe-readers-status.

**BO DeviceProfiles — `src/backoffice/sections/DeviceProfiles.jsx`**: ops `device_profiles.assigned_reader_id` + `payment_mode` (`'tap_to_pay'|'assigned_reader'`) + `customer_display_mode` (`'auto'|'reader'|...`) — profile-level reader prefs (actual binding is platform `payment_devices.bound_pos_device_id`).

**Admin — `src/admin/sections/AdminBillingManager.jsx`** (processor toggle Stripe|Ryft per location, Stripe markup pricing via `payments-admin` actions `stripe_pricing`/`stripe_unlink`, StripeLinkModal) and `AdminStripeTest.jsx` (end-to-end test PI + Elements). Adyen: add processor option + Adyen account panel + test harness.

**Reports/EOD:** `EODClose.jsx:100` counts `method === 'card' || method === 'stripe'`; `reports/Payments.jsx:18` buckets any method containing 'stripe'/'terminal'. Adyen: keep writing `method:'card'`; add 'adyen' to bucket matchers if a new method string is introduced.

---

## 5. Stripe-specific data model

**Platform DB (`yhzjgyrkyjabvhblqxzu`):**
- `merchant_stripe_accounts` — location_id (unique), company_id, stripe_account_id, link_method, charges_enabled, payouts_enabled, details_submitted, country, default_currency, capabilities jsonb, requirements jsonb, linked_at, last_webhook_at, cardpresent_markup_percent, online_markup_percent, pricing_notes. → new `merchant_adyen_accounts` mirror (Ryft did exactly this).
- `payment_devices` — id, location_id, **stripe_reader_id** (`rdr_...`; BT rows store serial), **stripe_account_id**, device_type, connection_kind ('network'|'bluetooth'), serial_number, label, registration_code, status, last_seen_at, last_status_check_at, ip_address, firmware_version, registered_by_user_id, **bound_pos_device_id** (ops devices.id), customer_display_enabled, processor (default 'stripe'), ryft_terminal_id. → add adyen terminal id (POIID) column; keep binding column.
- `location_reader_settings` — location_id, tipping_enabled, tip_percentages int[], allow_custom_tip, smart_tip_threshold_minor, **stripe_configuration_id**, **stripe_configuration_synced_at**, idle_screen_enabled, **idle_screen_file_id** (`file_...`), idle_screen_mime, idle_screen_uploaded_at/by, idle_screen_image_url (PAX-shared copy).
- `locations` — **payment_processor** ('stripe'|'ryft' check constraint — must widen for 'adyen'), **stripe_terminal_location_id** (`tml_...`), ops_location_id.
- `stripe_webhook_events` — id (event id, PK dedupe), type, livemode, account_id, payload jsonb, processed_at, processing_error.
- `gift_card_purchases` — **stripe_session_id** (`cs_...`), **stripe_account_id**, **stripe_payment_intent_id**, processor, ryft_payment_session_id, status pending→paid.
- `billing_state` — location_id, company_id, current_period_currency (seeded by stripe-link-merchant).
- `platform_settings` + RPC **`get_effective_markup(p_location_id, p_channel)`** — platform fee %; ⚠ called with `'card_present'` (create-payment-intent) vs `'cardpresent'` (process-on-reader, gift session uses `'online'`) — verify both keys resolve before porting.

**Ops DB (`tbetcegmszzotrwdtqhi`):**
- `closed_checks` — **stripe_payment_intent_id** text (legacy single id, v5.5.301), **payment_intents jsonb** `[{id, amountMinor, card?}]` (v5.5.323 migration `20260529_closed_checks_payment_intents.sql`; card receipt block attached per leg v5.5.719), **processor** text default 'stripe', method includes literal `'stripe'` historically. Written by: store `finalizeCheck` paths (index.js:4415/4550/4858/4939), db.js:556-558 (mapping in/out at :649/:692), DataSafe.js:163 (offline reconcile), OnlineCheckout, QrCheckout, CateringCheckout, OrdersHub tab close. → Adyen writes pspReference into the same columns; refund router keys off `processor`.
- `order_queue.customer` jsonb (QR tabs) — payment_intent_id, stripe_account, payment_method_id, processor, payment_session_id (ryft).
- `device_profiles` — assigned_reader_id, payment_mode, customer_display_mode.
- `devices` — type ∈ pos|kiosk gate used by payment fns.

---

## 6. Config / secrets / deps

- **Supabase edge secrets (ops project):** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`.
- **Vercel env (separate store!):** `STRIPE_SECRET_KEY` (fallbacks STRIPE_API_KEY/TEST/LIVE) for api/stripe-capture + stripe-charge-overage.
- **Vite:** `VITE_STRIPE_PUBLISHABLE_KEY` (stripeClient + isMock gate in dead stripe.js), `VITE_STRIPE_TERMINAL_LOCATION_ID` (MPOS Tap to Pay).
- **npm:** `@stripe/react-stripe-js@^6.3.0`, `@stripe/stripe-js@^9.4.0` (package.json:14-15).
- **Stripe pin:** `stripe@14.21.0` esm.sh, apiVersion `2024-06-20` in every fn.
- **Dashboard-side config (not in repo):** two webhook endpoints (`/functions/v1/stripe-webhook`, `/stripe-webhook-connect` with "listen to connected accounts" ticked), connected accounts, Terminal locations/configurations.
- ⚠ Edge fns deploy MANUALLY (memory: check-deploys drift) — the Adyen cutover plan must include `scripts/check-deploys.mjs` verification.

## 7. Migration gotchas (found in code, not guessed)

1. **Fail-safe defaults are 'stripe' everywhere** (processor.js, gift-checkout-session, CheckoutModal, db.js `processor || 'stripe'`). If Stripe is decommissioned these fail-safes become fail-broken — the default must flip to Adyen (or hard-error) as part of cutover, including for historical refunds of `pi_...` ids.
2. **Historical refunds:** closed_checks rows carry `pi_...` ids forever; keep stripe-refund + STRIPE_SECRET_KEY alive for the refund window even after new payments move to Adyen.
3. **Amount floor** `amount_minor ≥ 30` (process-on-reader:78) is Stripe's minimum — Adyen's differs.
4. **On-reader tipping** (`process_config.tipping.amount_eligible`, skip_tipping override semantics v5.5.174/272) and **live cart display** are deeply-tuned UX; verify the chosen Adyen terminal supports both before promising parity.
5. **Split-fee model:** `application_fee_amount` on direct charges → Adyen platform fees use `splits[]`/balance accounts — the `get_effective_markup` maths survives, the API shape doesn't.
6. **Gift fulfilment contract:** metadata `type=gift_card_purchase` + `purchase_id` → gift-fulfill; breaking these two keys silently ships no card to a paying customer (comment in gift-checkout-session:150).
7. **Ops↔platform location double-lookup** (`or(ops_location_id.eq.X,id.eq.X)`) is replicated in 6+ fns — port it verbatim into every Adyen fn or centralise it.
8. **QR-tab off-session overage** relies on card-on-file saved during the SAME pre-auth (`setup_future_usage`) — Adyen needs explicit tokenisation on the pre-auth `/payments` call or the overage feature dies for tabs opened after cutover.
9. `currency.js stripeCurrency()` lowercase vs Adyen uppercase ISO; `stripe_currency`-style naming crosses ~15 files.
10. Legacy `src/lib/stripe.js` scaffold and `stripe-terminal-connection-token` (post-Tap-to-Pay decision) are deletable — don't waste porting effort.