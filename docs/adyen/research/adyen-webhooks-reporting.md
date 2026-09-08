# Adyen Webhooks + Reporting + Reconciliation — verified from docs.adyen.com (fetched 2026-08-01)

All facts below were fetched from the cited pages; nothing is from memory. Where a page 404'd, the working replacement URL is noted.

---

## 1. Webhooks — overview and event catalog

Source: https://docs.adyen.com/development-resources/webhooks/ and https://docs.adyen.com/development-resources/webhooks/webhook-types

- **Model**: HTTP POST push of event-driven messages to an endpoint you define; used for async payment methods, state sync, and external events (onboarding, chargebacks, report generation).
- **Standard webhook payload structure** (webhook-types page):
  - `live` (boolean test/live), `notificationItems` array of `NotificationRequestItem` (typically **one item per JSON POST**; up to six for SOAP).
  - Each `NotificationRequestItem`: `eventCode`, `success` (boolean), `eventDate` (ISO 8601), `additionalData`, `originalReference` (PSP reference of the original payment, present on modifications like refunds/cancellations), plus pspReference/amount/merchant fields.
- **Default standard event codes** (webhook-types page):
  - Transaction: `AUTHORISATION`, `AUTHORISATION_ADJUSTMENT`, `CANCELLATION`, `CANCEL_OR_REFUND`, `CAPTURE`, `CAPTURE_FAILED`, `EXPIRE`, `HANDLED_EXTERNALLY`, `ORDER_OPENED`, `ORDER_CLOSED`, `REFUND`, `REFUND_FAILED`, `REFUNDED_REVERSED`, `REFUND_WITH_DATA`, `REPORT_AVAILABLE`, `VOID_PENDING_REFUND`.
  - Dispute: `CHARGEBACK`, `CHARGEBACK_REVERSED`, `NOTIFICATION_OF_CHARGEBACK`, `INFORMATION_SUPPLIED`, `NOTIFICATION_OF_FRAUD`, `PREARBITRATION_LOST`, `PREARBITRATION_WON`, `REQUEST_FOR_INFORMATION`, `SECOND_CHARGEBACK`, `DISPUTE_DEFENSE_PERIOD_ENDED`, `ISSUER_RESPONSE_TIMEFRAME_EXPIRED`, `ISSUER_COMMENTS`.
  - Payout: `PAYOUT_EXPIRE`, `PAYOUT_DECLINE`, `PAYOUT_THIRDPARTY`, `PAIDOUT_REVERSED`.
  - Non-default (must be enabled): `OFFER_CLOSED`, `RECURRING_CONTRACT`, `POSTPONED_REFUND`, `AUTHENTICATION`, `MANUAL_REVIEW_ACCEPT`/`MANUAL_REVIEW_REJECT` (risk settings).
- **API version**: standard webhooks are documented in API Explorer as **Webhooks v1** (e.g. https://docs.adyen.com/api-explorer/Webhooks/1/post/CHARGEBACK , https://docs.adyen.com/api-explorer/Webhooks/1/post/NOTIFICATION_OF_CHARGEBACK , https://docs.adyen.com/api-explorer/Webhooks/1/post/PAYOUT_DECLINE ). Platform report webhooks live under `api-explorer/report-webhooks/latest` (see section 5).

### Chargeback lifecycle order
Sources: https://docs.adyen.com/risk-management/disputes-api/dispute-notifications , https://docs.adyen.com/risk-management/understanding-disputes/dispute-process-and-flow (surfaced via docs search)
1. `NOTIFICATION_OF_CHARGEBACK` — dispute opened, defensible; starts the ~30-day defense period; can arrive right after payment is Settled/Refunded.
2. `CHARGEBACK` — account debited (NotificationOfChargeback + Chargeback journals booked).
3. `INFORMATION_SUPPLIED` — defense documents submitted.
4. `CHARGEBACK_REVERSED` (won) or `SECOND_CHARGEBACK` (issuer disputes again).
5. All events for one dispute share the **same PSP reference**.

### Platforms (Balance Platform) webhooks — different envelope
Source: https://docs.adyen.com/development-resources/webhooks/webhook-types
- Payload: `data` (event-specific object), `environment`, `timestamp` (ISO 8601), `type` (event identifier) — NOT NotificationRequestItem.
- Webhook families: Transfer ("fund movements from initiation to completion"), Transaction, Balance, Configuration, Dispute (Issuing), Report (balance platform report availability), Network Token, Onboarding, Capital, Card Order, Negative Balance Compensation Warning, etc.

---

## 2. HMAC signature validation

Source: https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures (note: the older `/development-resources/webhooks/verify-hmac-signatures` URL 404s — it now lives under `/secure-webhooks/`)

- **Signed payload** = colon-joined concatenation, strict order:
  `pspReference : originalReference : merchantAccountCode : merchantReference : value : currency : eventCode : success`
  Example from docs: `"7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true"` (empty fields = empty string).
- **Algorithm**: HMAC-**SHA256** over the UTF-8 binary payload, key = hex HMAC key converted to binary; result **Base64-encoded**.
- **Location**: standard webhooks carry it in `additionalData.hmacSignature`. Some other webhook types (e.g. recurring token lifecycle) put the signature **in the request header** instead.
- **Key management**: one HMAC key per webhook endpoint, generated in Customer Area → Developers → Webhooks; test and live have different keys (configure-and-manage page). On rotation, keep accepting the previous key "for some time" (propagation delay).
- **Library support**: Adyen server libraries ship HMAC validators for Java, PHP, C#, JavaScript, Ruby, Python.

---

## 3. Accepted-response contract + retry/queue semantics

Sources: https://docs.adyen.com/development-resources/webhooks/handle-webhook-events , https://docs.adyen.com/development-resources/webhooks/troubleshoot , https://docs.adyen.com/development-resources/webhooks/configure-and-manage

- **Accept contract**: respond with a **2xx HTTP status (200 or 202)** within **10 seconds**. Acceptance is based on the status code — no `[accepted]` body is required in the current docs (handle-webhook-events + webhooks overview pages).
- **On failure** (no 2xx within 10s): webhook marked **Failing** and queued.
- **Retry schedule** (troubleshoot page, exact):
  - Immediate retries at **9s, 18s, 27s**;
  - then queued retries at **2 min, 5 min, 10 min, 15 min, 30 min, 1 h, 2 h, 4 h, 8 h**;
  - automatic retrying continues **up to 30 days**.
  - "Retry queues are separate for each webhook endpoint."
  - Manual **Retry** / **Ignore** (permanently drop) available in Customer Area; alert emails after 5 failed attempts, after 7 days failing, and on recovery.
- **Ordering**: NOT guaranteed — "always check the timestamp"; some webhooks include `sequenceNumber`. Duplicates possible: same `eventCode` + `pspReference`; docs say design for dedupe and "use the details from the latest webhook event".
- **Best practice** (handle page): ack immediately, process async; verify HMAC before processing; use Adyen server libraries.
- **Endpoint requirements** (configure-and-manage): HTTPS with **TLSv1.2 or TLSv1.3**; live allows HTTPS only on ports **443, 8443, 8843** (test also allows HTTP 80/8080/8888). Auth options on your endpoint: Basic auth, HMAC, or **OAuth 2.0** (Standard webhook type only; token TTL ≥ 3599s). Configure at **company account level** (recommended) with include/exclude lists of merchant accounts — relevant for per-venue merchant-account routing.

---

## 4. Reporting — merchant-account reports

Index: https://docs.adyen.com/reporting/

### 4.1 Getting reports automatically (REPORT_AVAILABLE flow)
Source: https://docs.adyen.com/reporting/automatically-get-reports
- On generation Adyen sends a **`REPORT_AVAILABLE`** webhook where **`pspReference` = the report file name** and **`reason` = the download URL**.
- Download = **HTTP GET** on that URL authenticated with a dedicated **"Report user" API credential** holding the **Merchant Report Download role** — either its **API key** or **Basic auth** username/password.
- Supports `Accept-Encoding: gzip` compression. Manual alternative: https://docs.adyen.com/reporting/manually-get-reports .

### 4.2 Settlement details report (the per-payout, per-transaction workhorse)
Source: https://docs.adyen.com/reporting/settlement-reconciliation/transaction-level/settlement-details-report (old `/reporting/settlement-detail-report` 404s)
- **Formats**: CSV (default), XLS_GEN, TSV, XML, XMLE. Generation: manual, or automatic **daily/weekly/monthly/at batch close**. Merchant-account level only.
- **Batch model**: one settlement batch per payout cycle; **Batch Number** = "the sequence number of the settlement"; batch closes per the merchant account's payout frequency.
- **Type (journal) values**: `Settled`, `Refunded`, `Chargeback`, `SecondChargeback`, `ChargebackReversed`, `RefundedReversed`, `Fee`, `MerchantPayout`, `DepositCorrection`, `InvoiceDeduction`, `BalanceTransfer`, installment types, etc.
- **Default columns** (exact names): Company Account, Merchant Account, Psp Reference, Merchant Reference, Payment Method, Creation Date, TimeZone, Type, Modification Reference, Gross Currency, Gross Debit (GC), Gross Credit (GC), Exchange Rate, Net Currency, Net Debit (NC), Net Credit (NC), Commission (NC), Markup (NC), Scheme Fees (NC), Interchange (NC), Payment Method Variant, Modification Merchant Reference, Batch Number, Reserved4–10.
  - Fee breakdown per transaction: **Commission** (acquirer commission withheld), **Markup**, **Scheme Fees**, **Interchange**.
- **Payout reconciliation**: the **`MerchantPayout`** row is the actual bank payout for the batch (reference, batch number, bank account); sum of Net Credit − Net Debit per Batch Number should match it.
- **Tips**: optional column **`Gratuity Amount`** — "the additional gratuity amount on the payment"; also **`Surcharge Amount`**.
- **Splits**: optional columns **`Split Settlement`** (key/value detail), **`Split Payment Data`**, **`Balance Currency`**, **`Net Debit (BC)`/`Net Credit (BC)`**, **`Balance Platform Debit`/`Credit`**, **`Funds Destination`**.

### 4.3 Batch-level alternative
Source: https://docs.adyen.com/reporting/settlement-reconciliation — batch-level reconciliation uses the **Aggregate settlement details report** ( https://docs.adyen.com/reporting/settlement-reconciliation/batch-level/aggregate-settlement-details-report ) to match payout batches to bank statements with per-batch commission costs; transaction-level uses Settlement details / External settlement detail / Advancements detail reports.

### 4.4 Payment accounting report (full lifecycle, invoice matching)
Source: https://docs.adyen.com/reporting/invoice-reconciliation/payment-accounting-report (lives under invoice-reconciliation; bare `/reporting/payment-accounting-report` 404s)
- Purpose: "match up fees to payment statuses and perform invoice reconciliation"; covers lifecycle status changes/events/modifications for all transactions. Company + merchant accounts. CSV (default), XLS_GEN, TSV.
- **Record Types** (60+), e.g.: Received, Authorised, AuthorisedPending, Refused, Cancelled, Expired, Error, SentForSettle, Settled, SettledExternally, SettledReversed, SentForRefund, Refunded, RefundFailed, Chargeback, SecondChargeback, ChargebackReversed, PaidOut, PayoutFailed, installment variants.
- **Key columns**: Main Amount; register movements Received (PC), Authorised (PC), Captured (PC), **Payable (SC)** ("will be paid out"); fee columns **Commission (SC)**, **Markup (SC)**, **Scheme Fees (SC)**, **Interchange (SC)**, **Processing Fee (FC)**; optional **Gratuity Amount** and **Surcharge Amount**.

### 4.5 Monthly invoice
Source: https://docs.adyen.com/reporting/invoice-reconciliation/ and https://docs.adyen.com/reporting/invoice-reconciliation/payment-processing-invoice
- **Payment processing invoice**: monthly, company-account level (all merchant accounts under the same legal entity), downloaded from Customer Area → **Reconciliation > Invoices**.
- Structure: summary ("Already deducted from settlement" vs "Amount due") + details sections "Specification of final calculation including discounts" and "Specification of amounts already deducted from settlement".
- **"Amount due"** = month-end calculated costs minus already-deducted amounts; it is **deducted from the next settlement batch**.
- Reconcile it against the **Interactive payment accounting report** + **Settlement details report**.

---

## 5. Platforms (per-venue payouts on Adyen for Platforms / balance accounts)

Index: https://docs.adyen.com/platforms/reports-and-fees

- **Report set**: Balance Platform **Accounting** report (all balance changes daily, per account holder/balance account), **Balance** report (daily opening/closing balances), **Statement** report, **Payout** report, **Fee** report.
- **Split payments in reports**: the Accounting report shows splits as "two (or more) separate lines with **Category `platformPayment`**"; matching lines join via **`Psp Payment Psp Reference`**.
- **Fee types tracked**: Interchange, Scheme fees, Markup, Commission; Processing fees per instruction; monthly Fund Transfer / Payout / KYC Service fees; US-specific FanF and Merchant Location fees.

### 5.1 Payout report (per sub-merchant payout reconciliation)
Source: https://docs.adyen.com/platforms/reports-and-fees/payout-report
- Daily file `balanceplatform_payout_report_YYYY_MM_DD.csv`, generated ~02:00 CEST covering midnight–midnight CEST; empty file if no payouts.
- Filter per venue via **Account Holder + Balance Account + Currency**; columns include Balance Platform, Account Holder, Balance Account, Transfer Id, Transaction Id, Booking Date, Value Date, Category, Type, Status, Currency, **Balance (PC)**, **Rolling Balance (PC)** (zeroes out when the payout completes), Payout Date (CET).

### 5.2 Getting platform reports + webhook
Source: https://docs.adyen.com/platforms/prepare-reports/generate-download-reports (via https://docs.adyen.com/platforms/prepare-reports )
- Availability webhook: **`balancePlatform.report.created`** (API Explorer: https://docs.adyen.com/api-explorer/report-webhooks/latest/post/balancePlatform.report.created ) — "contains the URL at which you can download the report" (plus file name, report type).
- Download via HTTP GET using an API credential with the **BalancePlatform Report Download role** (Customer Area role: "Download Balance Platform reports"). Formats: CSV (all), TSV (Accounting only).

### 5.3 Cross-report join logic (payments → venue balances)
Source: https://docs.adyen.com/platforms/reconciliation-use-cases/reconcile-payments (parent: https://docs.adyen.com/platforms/reconciliation-use-cases )
- Combine **Payment Accounting Report** (lifecycle: Received → Authorised → SentForSettle) with **Balance Platform Accounting Report** (fund distribution after SentForSettle).
- Joins: **`Psp Reference`** (payment report) = **`Psp Payment Psp Reference`** (balance platform report); plus `Merchant Reference`, `Transfer Id`, `Transaction Id`.
- Example split of a EUR 100 payment: EUR 97.00 credit to the venue's balance account, EUR 3.00 commission credit to the platform's liable account, EUR −2.57 fee debit — each its own row; per-split `Status` progresses received → authorised → **captured** (Balance (PC) impacts the account only at "captured").
- Timing: **Booking Date** = funds distributed (at SentForSettle); **Value Date** = funds usable (typically T+2).

---

## 6. Notes / gotchas for the migration

- **Two webhook worlds**: classic merchant-account webhooks (NotificationRequestItem, HMAC in `additionalData`, Webhooks v1) vs Balance Platform webhooks (`type`/`data` envelope, e.g. `balancePlatform.report.created`). A platform-based per-venue payout design will need both.
- **Report download URL arrives inside the webhook** in both worlds: classic = `REPORT_AVAILABLE` with URL in `reason`; platforms = `balancePlatform.report.created` with URL in payload. Separate download credentials/roles: "Merchant Report Download role" vs "BalancePlatform Report Download role".
- **Retry window is 30 days with a fixed backoff ladder** (9s/18s/27s then 2m→8h) and per-endpoint queues; duplicates and out-of-order delivery are explicitly possible — dedupe on `eventCode`+`pspReference`, order by timestamp/`sequenceNumber`.
- **Tips**: `Gratuity Amount` is an optional (non-default) column on both the Settlement details and Payment accounting reports — it must be added to the report configuration for tip reconciliation.
- **Moved URLs seen during research** (avoid stale links): HMAC page now under `/secure-webhooks/`; settlement details under `/reporting/settlement-reconciliation/transaction-level/`; payment accounting under `/reporting/invoice-reconciliation/`.