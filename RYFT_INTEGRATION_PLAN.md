# Ryft + Stripe dual-processor integration plan

Goal: run **both Stripe and Ryft** as first-class payment processors across the entire
system (POS card-present, MPOS, online, QR, kiosk; refunds; holds; marketplace
payouts; webhooks), with **per-location choice** of processor and **zero regression**
to existing Stripe venues.

Sources read: Ryft [API reference](https://developer.ryftpay.com/documentation/api/reference/openapi),
[process payments](https://developer.ryftpay.com/documentation/get_started/process_payments),
[embedded SDK setup](https://developer.ryftpay.com/documentation/get_started/process_payments/embedded_sdk/initial_setup).

---

## 1. Stripe ↔ Ryft concept map

| Capability | Stripe (today) | Ryft (target) |
|---|---|---|
| Base API | `api.stripe.com` | `api.ryftpay.com/v1` (sandbox `sandbox-api.ryftpay.com/v1`) |
| Auth | `STRIPE_SECRET_KEY`; `Stripe-Account` header for connected acct | API key in `Authorization` header (secret backend / public `pk_…` client); sub-account via `accountId` |
| Online payment object | PaymentIntent (+ `client_secret`) | **Payment Session** `POST /payment-sessions` → `{ id: ps_…, clientSecret }` |
| Statuses | requires_payment_method → processing → succeeded | PendingPayment → **Approved** → **Captured** |
| Client SDK | `@stripe/stripe-js` + Payment Element / `confirmCardPayment` | `<script src="https://embedded.ryftpay.com/v2/ryft.min.js">` → `Ryft.init({publicKey, clientSecret, accountId})` → `Ryft.attemptPayment()` |
| Manual capture (holds) | `capture_method: 'manual'` → capture/cancel PI | `captureFlow: 'Manual'` → `POST /payment-sessions/{id}/captures` / `/voids` |
| Refund | `refunds.create` | `POST /payment-sessions/{id}/refunds` |
| Saved card (off-session, tab overage) | `setup_future_usage` + `pm_…` | `POST /customers` + `GET /customers/{id}/payment-methods` |
| In-person / card-present | Stripe Terminal network readers (S700, WisePOS E); server `processPaymentIntent` + poll reader action | **Ryft Android terminals** (EMV/NFC/magstripe); `POST /in-person/terminals/{id}/payment`, `…/cancel-action`, `…/confirm-receipt`, `…/refund`; poll `/in-person/orders` |
| Marketplace / per-merchant | Connect connected accounts (`acct_…`), `application_fee_amount` | Sub-accounts `POST /accounts`, hosted onboarding `POST /account-links`, KYB `/persons`, `/payout-methods`, **`platformFee`** on the session |
| Apple/Google Pay | Payment Element wallets | Embedded SDK wallets + Apple Pay domain registration |
| Webhooks | `stripe-webhook` / `-connect` (Stripe sig) | new `ryft-webhook`: HMAC-SHA256 of body, header `Signature`; events e.g. `PaymentSession.captured` |
| Disputes | Stripe dashboard / webhooks | `/disputes` (accept / evidence / challenge) |

**Key takeaways**
- Online/QR/kiosk: near 1:1 — swap "create PaymentIntent + Stripe Elements" for
  "create Payment Session + Ryft embedded SDK". Both have manual capture for the
  bar-tab hold, refunds, and wallets.
- In-person is the **divergent** piece: Ryft uses **its own Android terminals**, a
  different hardware ecosystem from Stripe's S700/WisePOS. A Ryft location uses Ryft
  terminals; a Stripe location uses Stripe readers. The reader-management UI needs a
  Ryft variant (register / take payment / cancel / receipt / tipping).
- Marketplace maps cleanly: per-location sub-account + `platformFee` instead of
  connected account + `application_fee_amount`.

---

## 2. Architecture — a processor-agnostic seam

Today Stripe is hardcoded with **no abstraction**. Introduce one thin seam on each side.

### Server (edge functions) — a router + per-processor modules
Replace direct `stripe-*` calls behind processor-neutral entry points that read the
location's processor and dispatch. Return a **normalised** shape to the client.

- `payments-create-session` → `{ processor, sessionId, clientSecret, publishableKey, accountId, markupPercent }`
  (Stripe path returns PI client_secret; Ryft path returns Payment Session clientSecret.)
- `payments-capture`, `payments-void`, `payments-refund` — route by the **processor stored on the original payment**, never the location's current processor (a Stripe check must refund via Stripe even after the venue switches).
- In-person: `terminal-take-payment`, `terminal-cancel`, `terminal-status` — dispatch to Stripe Terminal vs Ryft in-person endpoints.
- Reader management: keep `stripe-*reader*`; add parallel `ryft-*terminal*` (register, take-payment, cancel-action, confirm-receipt, tipping config).
- Marketplace: keep `stripe-link-merchant` + add `ryft-create-account` / `ryft-account-link` (hosted onboarding) / `ryft-payout-methods`.
- Webhooks: add `ryft-webhook` (HMAC-SHA256, `Signature` header) that normalises into the same internal handling as Stripe events.
- Shared helper module `_shared/processor.ts`: `resolveProcessor(location_id)`, `ryftFetch(path, body, {secretKey, accountId})`, signature verify.

### Client — one `PaymentSurface` that renders the right SDK
- `src/lib/payments/` with `createSession()` (calls `payments-create-session`) and a
  `<PaymentSurface processor=…>` that mounts **Stripe Elements** or the **Ryft embedded
  SDK** (`Ryft.init` + `Ryft.attemptPayment`) off the normalised response.
- CheckoutModal / OnlineCheckout / QrCheckout / KioskApp call `createSession()` +
  render `<PaymentSurface>` instead of Stripe-specific code.
- `VITE_RYFT_PUBLIC_KEY` alongside `VITE_STRIPE_PUBLISHABLE_KEY` (or return the
  publishable/public key from the create-session response so the client stays dumb).

---

## 3. Data model changes (Platform + Ops DB)

- `locations.payment_processor` text default `'stripe'` (`'stripe' | 'ryft'`) — the per-venue switch. (Optionally `payment_processor_config` jsonb.)
- `merchant_ryft_accounts` (mirror of `merchant_stripe_accounts`): `location_id`, `ryft_account_id`, `charges_enabled`, `payouts_enabled`, `details_submitted`, `requirements` jsonb, `linked_by_user_id`, `linked_at`. (Parallel table = no risky migration of existing Stripe rows.)
- `closed_checks`: add `payment_processor` text; generalise the `payment_intents` jsonb entries to `{ processor, id, amountMinor }`. Keep `stripe_payment_intent_id` for back-compat reads.
- `bar_tabs`: `card_hold_pi_id` / `payment_method_id` become processor-neutral ids; add `payment_processor`.
- `order_queue`: `payment_intent_id` neutral; rename/duplicate `stripe_account` → `processor_account` (keep old column populated during transition).
- `payment_devices`: add `processor` + `ryft_terminal_id`; existing `stripe_reader_id` stays for Stripe.
- Secrets (Supabase function env): `RYFT_SECRET_KEY`, `RYFT_WEBHOOK_SECRET`, `RYFT_PUBLIC_KEY` (sandbox first), alongside the existing `STRIPE_*`.

---

## 4. Phased delivery (each phase shippable, Stripe untouched until cutover)

**Phase 0 — Foundations (no behaviour change)**
- `_shared/processor.ts` helper, `RYFT_*` sandbox secrets, `locations.payment_processor` column (defaults everyone to Stripe), `merchant_ryft_accounts` table. Client `payments/` scaffolding that still 100% delegates to Stripe.

**Phase 1 — Ryft online/QR/kiosk card payments (sandbox)**
- `payments-create-session` Ryft path (`POST /payment-sessions`, manual vs auto capture).
- `<PaymentSurface>` Ryft renderer (embedded SDK) + wallets.
- `payments-refund` Ryft path. Bar-tab hold via `captureFlow: Manual` + `/captures` + `/voids`.
- A test location flipped to `payment_processor='ryft'` in sandbox; full online/QR/kiosk happy-path + refund + hold/capture/void verified.

**Phase 2 — Ryft marketplace onboarding + payouts**
- `ryft-create-account` + hosted `account-links` onboarding in Back Office (mirrors the Stripe "link merchant" UX), `platformFee` wired into the session, payout methods, account status surfaced.
- `ryft-webhook` (account/payment/payout events) normalised.

**Phase 3 — Ryft in-person terminals**
- Ryft terminal registration + `terminal-take-payment` / `cancel` / `confirm-receipt` / tipping in the reader-management UI (parallel to the Stripe Terminal screens).
- CheckoutModal + Kiosk card-present path dispatches by processor.
- Decide hardware: Ryft Android terminals (their range) — confirm models, whether tap-to-pay/Bluetooth or network, and migration of existing Stripe-reader venues.

**Phase 4 — Refund/report/reconciliation parity + production cutover**
- Refund routing by original processor; reports show processor per transaction; `/balances` + `/balance-transactions` reconciliation; disputes surfaced.
- Move from sandbox to production keys; pilot one venue on Ryft; then expose the processor choice in onboarding.

---

## 5. Risks / decisions needed

1. **In-person hardware** — Ryft terminals are a different device family from Stripe S700/WisePOS. Which Ryft models? Tap-to-Pay on Android? Do existing Stripe-reader venues stay on Stripe, or migrate? (Biggest scope driver.)
2. **Per-location vs per-tenant processor** — one processor per location (recommended) or can a location run both?
3. **Refund-after-switch** — refunds must follow the *original* payment's processor (handled by storing `payment_processor` on each check).
4. **Marketplace economics** — `platformFee` (Ryft) vs `application_fee_amount` (Stripe markup): confirm the fee model matches the Ryft deal.
5. **Sandbox access** — need Ryft sandbox secret + public keys and a sandbox sub-account to build Phase 1.
6. **Security dependency** — the multi-tenant RLS cutover (separate plan) should land around the same window; new `merchant_ryft_accounts` / processor columns go in tenant-fenced from day one.

---

## 6. Effort shape (rough)
- Phase 0–1 (online/QR/kiosk + refunds + holds on Ryft, sandbox): the core, ~the bulk of the value.
- Phase 2 (marketplace): moderate.
- Phase 3 (in-person terminals): largest single piece, hardware-dependent.
- Phase 4 (parity + cutover): moderate.

Stripe stays the live default throughout; Ryft is additive and gated behind
`locations.payment_processor` until a venue is explicitly switched.
