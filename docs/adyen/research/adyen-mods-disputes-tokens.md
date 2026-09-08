# Adyen research — Modifications, Disputes, Tokens, Gift Cards
All facts fetched 1 Aug 2026 from docs.adyen.com (URLs cited per fact). No API keys used.

## Current API versions (from API Explorer home — https://docs.adyen.com/api-explorer/)
- **Checkout API: v72** (latest). Test base `https://checkout-test.adyen.com/v72`; live `https://{PREFIX}-checkout-live.adyenpayments.com/checkout/v72` — https://docs.adyen.com/api-explorer/Checkout/latest/overview
- **Disputes API: v30** — https://docs.adyen.com/api-explorer/Disputes/30/overview
- **Recurring API: v68**, **Payment (classic): v68**, **Management API: v3**, **Terminal API: v1** — https://docs.adyen.com/api-explorer/
- **Stored Value API: v46**. Base `https://pal-test.adyen.com/pal/servlet/StoredValue/v46` — official Adyen OpenAPI spec: https://github.com/Adyen/adyen-openapi/blob/main/json/StoredValueService-v46.json (the docs-site guide pages are JS-rendered and would not yield the base URL; version corroborated by https://docs.adyen.com/payment-methods/gift-cards/stored-value-api)

## 1. Captures — https://docs.adyen.com/online-payments/capture/
- **Automatic capture** is the default (immediate). **Delayed automatic capture**: configurable delay between auth and capture. **Manual capture**: explicit `POST /payments/{paymentPspReference}/captures` (Checkout API; needs `merchantAccount`, `amount`).
- **Single partial capture**: remaining balance is **auto-cancelled**; Adyen recommends flagging the payment as pre-authorisation.
- **Multiple partial captures**: remaining balance stays open for further captures — **disabled by default, requires Adyen Support enablement**.
- Capture settings configurable account-wide in Customer Area or per-request.
- Webhooks: `CAPTURE` (`success:true` = submitted to bank), `CAPTURE_FAILED` (rare post-submission scheme/issuer rejection).

## 2. Refunds — https://docs.adyen.com/online-payments/refund/
- **Referenced refund**: `POST /payments/{paymentPspReference}/refunds`. Partial and **multiple** refunds allowed; sum cannot exceed captured amount. Currency must match the authorisation.
- **Unreferenced refund** (no original payment): **requires approval from Adyen Support**; supported for cards, stored payment details, ACH Direct Debit, bank transfer (IBAN).
- Webhooks: `REFUND` (success = sent to scheme), `REFUND_FAILED` (can fail AFTER a success:true REFUND — needs merchant intervention), `REFUNDED_REVERSED` (funds came back to Adyen, e.g. bank transfer/iDEAL — contact shopper before retry).
- Funds can take **up to 40 business days** to reach the shopper depending on method.

### POS refunds (Terminal API) — https://docs.adyen.com/point-of-sale/basic-tapi-integration/refund-payment/
- **Referenced**: Terminal API `ReversalRequest`, matched by tender/PSP reference; always async; cannot over-refund or double-refund.
- **Unreferenced**: `PaymentRequest` with `PaymentType: Refund` — pays out to ANY card presented (e.g. gift recipient); sync or async depending on scheme/geography; not for QR wallets.
- Some schemes only support unreferenced (Dankort, Interac); refund authorisation is validated with issuers (Amex/Discover/MC/Visa can decline).

## 3. Cancels — https://docs.adyen.com/online-payments/cancel/
- `POST /payments/{paymentPspReference}/cancels` — cancel an uncaptured payment (funds released to shopper). After capture, cancel is impossible (use refund).
- **Technical cancel**: standalone `POST /cancels` using YOUR merchant reference (no PSP ref needed) — possible **up to 24 hours after authorisation**.
- Webhooks: `CANCELLATION` (PSP-ref route), `TECHNICAL_CANCEL` (own-ref route).

## 4. Reversals — https://docs.adyen.com/online-payments/reversal/
- `POST /payments/{paymentPspReference}/reversals` = **cancel-or-refund**: cancels if uncaptured, refunds if captured — use when capture state is uncertain.
- **Cannot** be used when the payment has **multiple partial captures** or **split data (Adyen for Platforms)** — use explicit /cancels or /refunds there.
- Webhook: `CANCEL_OR_REFUND` (async result).

## 5. Pre-auth + incremental auth (BAR TABS)
### Online/ecom — https://docs.adyen.com/online-payments/adjust-authorisation/
- Flag with `additionalData.authorisationType: PreAuth` (vs default `FinalAuth`, which cannot be adjusted).
- Adjust endpoint (Checkout v72): `POST /payments/{paymentPspReference}/amountUpdates` — amount is the **updated TOTAL, not a delta**; `adjustAuthType` = `cardholderInitiatedTransaction` | `merchantInitiatedTransaction`; optional `industryUsage` (`delayedCharge`/`noShow`/`installment`); result async via `AUTHORISATION_ADJUSTMENT` webhook — https://docs.adyen.com/api-explorer/Checkout/72/post/payments/(paymentPspReference)/amountUpdates
- Two flows: **asynchronous** (reference by PSP ref + webhooks; simpler) vs **synchronous** (pass the `adjustAuthorisationData` blob from each response into the next request; immediate result but you must track the latest blob).
- **Scheme support** (MCC-dependent): Visa, Mastercard, Amex broadly supported (MCC 5542 fuel excluded); Discover limited MCC list incl. 5812/5813 (restaurants/bars) and 7011; CUP limited; Diners/JCB/Cartes Bancaires limited. Apple Pay/Google Pay work if the underlying card supports it; Klarna async only.
- **Validity**: Adyen default expiry 28 days (customisable). Visa: 5 days POS / 10 days CNP / 30 days pre-auth lodging-type MCCs. Mastercard: 7 days final auth / **30 days pre-auth**. Amex: 7 days. Discover: 10 (30 car rental/hotel). JCB: 1 year. (Both pages agree.)

### POS terminals — https://docs.adyen.com/point-of-sale/pre-authorisation/
- In Terminal API `PaymentRequest`, set `SaleData.SaleToAcquirerData`: `authorisationType=PreAuth` (+ `manualCapture=true` unless manual capture is account-wide).
- **Adjustments are made to the Adyen backend, NOT via the terminal** (increase/decrease/extend; same async-vs-sync blob model as above).
- Finish: `POST /payments/{paymentPspReference}/captures` with final total (original + adjustments), or `/cancels` if abandoned.
- Explicit hospitality use cases documented: pre-auth then adjust for extras, **tipping adjustment**, late charges. Bar-tab pattern = PreAuth at tab open → amountUpdates as tab grows → capture at close with tip.

## 6. Disputes
### API — https://docs.adyen.com/risk-management/disputes-api/ + https://docs.adyen.com/risk-management/disputes-api/disputes-api-reference/ + https://docs.adyen.com/api-explorer/Disputes/30/overview
- **Disputes API v30**, test base `https://ca-test.adyen.com/ca/services/DisputeService/v30`; auth = API key (`X-API-Key`) with the **"API dispute management" role** (may need Support enablement); separate live credentials at go-live.
- Endpoints: `POST /retrieveApplicableDefenseReasons` (returns scheme-specific defense reason codes + required document types), `POST /supplyDefenseDocument` (Base64 content), `POST /defendDispute`, `POST /acceptDispute`, `POST /deleteDisputeDefenseDocument`; plus pre-arbitration handling: `acceptPreArbitration`, `partialAcceptPreArbitration`, `declinePreArbitration` (guide page).
- Document limits: JPG/TIFF max 10 MB, PDF max 2 MB; Diners/Discover 3 MB; Mastercard max 19 pages; Klarna PDF only; RFI docs max 4 pages.
- Errors return `success:false` + `errorMessage` (e.g. "Dispute expired", "Dispute is not defendable").

### Dispute webhooks — https://docs.adyen.com/risk-management/disputes-api/dispute-notifications/
- Enable via **Standard webhook** in Customer Area + select all dispute events; for `CHARGEBACK_REVERSED`/`SECOND_CHARGEBACK`/`PREARBITRATION_*` also enable "Include originalReference for CHARGEBACK_REVERSED" under Webhooks > Risk settings.
- Event codes: `NOTIFICATION_OF_FRAUD` (TC40/SAFE, informational), `REQUEST_FOR_INFORMATION`, `NOTIFICATION_OF_CHARGEBACK` (**starts the defense period**), `INFORMATION_SUPPLIED`, `CHARGEBACK`, `SECOND_CHARGEBACK` (defense declined — Lost), `CHARGEBACK_REVERSED`, `PREARBITRATION_OPEN/WON/LOST`, `SCHEME_ARBITRATION_WON/LOST`, `DISPUTE_DEFENSE_PERIOD_ENDED`, `ISSUER_RESPONSE_TIMEFRAME_EXPIRED` (Won), `ISSUER_COMMENTS`.
- Key fields: dispute `pspReference` (stable across the dispute's events), `originalReference` (disputed payment), `disputeStatus`, **`defensePeriodEndsAt`**.

## 7. Tokenization (loyalty / one-click reorder)
- Overview — https://docs.adyen.com/online-payments/tokenization/ : tokens live in the Adyen Vault, keyed by a **unique `shopperReference`**; sessions flow keeps you SAQ A; network tokens + Account Updater keep tokens alive across card reissue.
- Create — https://docs.adyen.com/online-payments/tokenization/create-tokens/ : via `POST /sessions` (simplest) or `POST /payments`; standalone `POST /storedPaymentMethods` (create token without a payment) **only on Checkout v70+**. `RECURRING_CONTRACT` webhook is legacy ("no longer working on development") — use **"Recurring tokens life cycle events"** webhooks: `recurring.token.created` / `.disabled` / `.updated` / `.alreadyExisting`.
- Pay — https://docs.adyen.com/online-payments/tokenization/make-token-payments/ :
  - **One-click (shopper present, e.g. online reorder)**: `/sessions` or `/payments` with `paymentMethod.storedPaymentMethodId`, `shopperReference` (**min 3 chars, case-sensitive**), `shopperInteraction: Ecommerce`, `recurringProcessingModel: CardOnFile`.
  - **Merchant-initiated**: `/payments` only (not /sessions), Checkout **v49+**, `shopperInteraction: ContAuth`, `recurringProcessingModel: Subscription` (fixed interval) or `UnscheduledCardOnFile` (variable, e.g. top-ups/late bar-tab charge). `shopperReference` must match token creation.
- Manage — https://docs.adyen.com/online-payments/tokenization/managing-tokens/ : `GET /storedPaymentMethods?merchantAccount=...&shopperReference=...` (list; response includes `supportedRecurringProcessingModels`); `DELETE /storedPaymentMethods/{storedPaymentMethodId}`; update card details via zero-amount `/payments` (CardOnFile only; **v70+ requires extra Support configuration**).
- POS note: token creation from in-person payments exists at https://docs.adyen.com/point-of-sale/recurring-payments (found via search; not fetched in depth).

## 8. Gift cards
### What Adyen supports
- **Providers** (POS page, fully rendered — https://docs.adyen.com/point-of-sale/alternative-payment-methods/gift-cards-terminal-api/): **Givex** (full: activate, pay, balance, load, refund, cash-out, deactivate), **SVS**, **Fiserv (ex-ValueLink)**, **Intersolve** (all: activate/pay/balance/load/refund/cash-out), plus local gift cards (payments only) in **UK**, DK, FR, NL, NO, SE. Terminal entry via scan / swipe / manual keyed entry.
- **Ecommerce flow** — balance check `POST /paymentMethods/balance` (Checkout v72 — https://docs.adyen.com/api-explorer/Checkout/72/post/paymentMethods/balance), then **partial payments via `/orders`** — https://docs.adyen.com/online-payments/partial-payments/ : `POST /orders` (amount + reference) → responses carry `orderData` + `remainingAmount`, pass updated `orderData` into each successive `/payments` (gift card then card); order expires **24 h** (or custom `expiresAt`); `POST /orders/cancel` cancels/refunds constituent payments; webhooks `ORDER_OPENED` / `ORDER_CLOSED`; after completion refund individual payments via `/payments/{ref}/refunds`.
- **Stored Value API v46** (back-office gift ops, online + POS): endpoints `/issue`, `/changeStatus` (activate/deactivate), `/load`, `/checkBalance`, `/mergeBalance`, `/voidTransaction`; base `https://pal-test.adyen.com/pal/servlet/StoredValue/v46`; BasicAuth or API key — spec: https://github.com/Adyen/adyen-openapi/blob/main/json/StoredValueService-v46.json ; guide index: https://docs.adyen.com/payment-methods/gift-cards/stored-value-api . Accepted `paymentMethod.type` values per search of the guide pages: `givex`, `svs`, `valuelink` (+ Intersolve card types for changeStatus) — i.e. the value ledger always lives at a **partner processor**, not in an Adyen-owned ledger.

### Can our platform-DB gift card system stay OURS? — **YES**
- Adyen's gift-card machinery (balance check, /orders split tender, Stored Value API, terminal gift flows) exists ONLY to route gift tenders to the supported external processors (Givex/SVS/Fiserv/Intersolve/local schemes). Nothing in `/payments`, Terminal API, `/captures` or `/refunds` requires the gift portion of a sale to pass through Adyen at all.
- Keep the model we already run on Stripe/Ryft: redeem from our own `gift card` tables platform-side, then send **only the card remainder** to Adyen as an ordinary payment (online `/payments` or Terminal API `PaymentRequest`).
- **Implications**:
  - We do NOT use `/orders`, `/paymentMethods/balance`, or Stored Value API for our own cards — those only speak to the partner processors.
  - Our cards cannot be swiped/scanned **on the Adyen terminal itself**; entry/lookup stays in our POS UI (which is how it works today).
  - Adyen reporting/payouts show only the card component; gift liability and split-tender maths remain our platform's books (per-venue reports must merge the two — same as now).
  - Mixed-tender refunds: our platform decides the split — gift portion re-credits our ledger, card portion goes to Adyen `/payments/{ref}/refunds`. Refunding MORE than the card capture to a card is an **unreferenced refund** and needs Adyen Support approval (https://docs.adyen.com/online-payments/refund/).
  - If we later want terminal-native gift swipes or third-party gift processing, migration path = move the ledger to Givex/Intersolve etc. and adopt Stored Value API v46 + `/orders`.

## Recommended versions for the migration
- **Checkout API v72** (payments, captures, refunds, cancels, reversals, amountUpdates, orders, storedPaymentMethods, paymentMethods/balance) — https://docs.adyen.com/api-explorer/Checkout/latest/overview
- **Disputes API v30** — https://docs.adyen.com/api-explorer/Disputes/30/overview
- **Terminal API v1** (in-person; pre-auth via SaleToAcquirerData) — https://docs.adyen.com/api-explorer/
- **Stored Value API v46** — only if/when gift cards move onto Adyen-partner rails.

## Caveats
- docs.adyen.com gift-card guide pages (`/payment-methods/gift-cards/*`) render mostly client-side; provider/endpoint details above were grounded via the fully-rendered POS gift-card page, the Checkout v72 API explorer, and Adyen's official OpenAPI GitHub spec instead.
- Disputes API live base URL is not printed in the docs (test = `ca-test.adyen.com/ca/services/DisputeService/v30`; live requires new credentials at go-live) — https://docs.adyen.com/api-explorer/Disputes/30/overview
- Multiple partial captures and unreferenced refunds both need **Adyen Support enablement** — flag in onboarding calls.