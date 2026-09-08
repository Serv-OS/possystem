# Adyen In-Person Payments — Research Report (fetched from docs.adyen.com, 1 Aug 2026)

Every fact below was taken from a live fetch of the cited URL. One page (partial payments) 404'd on direct fetch but its exact text was recovered via search snippets of the same URL — flagged inline.

---

## 1. Terminal API — protocol, message format, versions

- **Protocol**: Terminal API is "based on the nexo Retailer Protocol" (nexo Sale to POI), JSON messages, no library required. "The current protocol version is **3.0**." — https://docs.adyen.com/point-of-sale/design-your-integration/terminal-api
- **Message structure**: every request is wrapped in a `SaleToPOIRequest`; responses mirror as `SaleToPOIResponse`. — https://docs.adyen.com/point-of-sale/design-your-integration/terminal-api
- **MessageHeader fields** (from make-a-payment page — https://docs.adyen.com/point-of-sale/basic-tapi-integration/make-a-payment):
  - `ProtocolVersion`: "3.0"
  - `MessageClass`: "Service" (also Device, Event)
  - `MessageCategory`: e.g. "Payment", "Input"
  - `MessageType`: "Request" / "Response"
  - `ServiceID`: "1-10 alphanumeric characters. Must be unique within the last 48 hours for the terminal (POIID) being used."
  - `SaleID`: "Your unique ID for the POS system component to send this request from."
  - `POIID`: "The unique ID of the terminal... Format: [device model]-[serial number]" e.g. `P400-123456789`
- **API Explorer version**: Terminal API shows as "**v1 latest**" and is not date-versioned like other Adyen APIs. 16 request types documented: Login/Logout, EnableService, Admin, Payment, CardAcquisition, StoredValue, Reversal, Reconciliation, GetTotals, BalanceInquiry, TransactionStatus, Abort, Diagnosis, Display, Input, Print, CardReaderAPDU. — https://docs.adyen.com/api-explorer/terminal-api/latest/overview
- **Enable it**: Customer Area > Devices > Device settings > Integrations > toggle "Enable terminal API". — https://docs.adyen.com/point-of-sale/design-your-integration/terminal-api

## 2. Cloud vs local — endpoints, sync vs async

Source pages: https://docs.adyen.com/point-of-sale/design-your-integration/choose-your-architecture and https://docs.adyen.com/point-of-sale/design-your-integration/choose-your-architecture/cloud

- **Local**: POS calls the terminal directly — `https://<terminal-ip>:8443/nexo` (port 8443, path `/nexo`); Android apps on-terminal can use `localhost`/`127.0.0.1`. **Synchronous only.** Requires adding Adyen's certificate to your POS app and encrypting messages. Needs DHCP reservation/static IPs.
- **Cloud**: POS calls Adyen; Adyen forwards to the terminal. Sync OR async. Dynamic IPs fine. "Cloud communications is easier to implement but does not support all use cases. Local communications... can be more robust but requires an additional effort."
- **Current cloud endpoints** (deviceId must equal the `POIID`):
  - Test: `https://device-api-test.adyen.com/v1/merchants/{merchantAccount}/devices/{deviceId}/sync` (and `/async`)
  - Live EU: `https://device-api-live.adyen.com/...`; US: `device-api-live-us`; AU: `device-api-live-au`; APSE: `device-api-live-apse`; NEA: `device-api-live-nea` — same path pattern, `/sync` and `/async`.
- **Legacy endpoints** (`terminal-api-test.adyen.com`, `terminal-api-live.adyen.com`, `terminal-api-live-us.adyen.com`, …) remain supported but: "There will be no future development on the old endpoints, but we continue to support them." — https://docs.adyen.com/api-explorer/terminal-api/latest/overview and https://docs.adyen.com/point-of-sale/design-your-integration/choose-your-architecture/cloud
- **Auth**: `x-API-key` header; credential needs the **Cloud Device API** role. — https://docs.adyen.com/point-of-sale/design-your-integration/choose-your-architecture/cloud
- **Sync call**: keep connection open; "The request must use an extended time-out of more than 150 seconds."
- **Async call**: immediate HTTP 200; result delivered to your **event notifications endpoint**; "we retry sending asynchronous Terminal API responses up to three times, but only if the HTTP response code you send is 5xx." Optional "guarantee payment response delivery" feature keeps resending until acknowledged. — https://docs.adyen.com/point-of-sale/design-your-integration/choose-your-architecture/cloud (event notifications setup: /point-of-sale/design-your-integration/notifications/event-notifications)
- **Timeout handling**: payments expire after 150 s (cloud) / 120 s (local); then send `TransactionStatusRequest` referencing the original via `MessageReference` containing `SaleID`, `ServiceID`, `MessageCategory`; response is Success (with original response in `RepeatedResponseMessageBody`), InProgress, or NotFound. — https://docs.adyen.com/point-of-sale/basic-tapi-integration/verify-transaction-status

## 3. Hardware — Adyen-supplied ONLY; no PAX/Sunmi

- **Critical**: Terminal API integration uses "PCI-certified payment terminals **that are supplied by Adyen**." No mention anywhere of third-party hardware (PAX, Sunmi, or independently-bought Verifone) being able to run Adyen. — https://docs.adyen.com/point-of-sale/what-we-support/solutions
- The terminals catalog (https://docs.adyen.com/point-of-sale/what-we-support/select-your-terminals — full data via its .md source) lists **only Adyen's own range**. So: **PAX A920/A50 and Sunmi payment devices cannot run Adyen in-person payments.** The migration paths are (a) Adyen terminals, (b) Tap to Pay on phones via POS Mobile SDK, (c) NYC1 card reader, or (d) your POS app running ON an Adyen Android terminal.
- **Current UK/US models** (from https://docs.adyen.com/point-of-sale/what-we-support/select-your-terminals.md — UK and US/NA both ✓ unless noted):
  - **Mobile/portable**: AMS1 (Android, battery, camera), e285p (pocket-sized), S1E2L (Android, barcode scanner), S1E4Pro (Android, drop/dust/splash-proof — **UK only, not US**), S1F2 (Android, built-in printer + barcode scanner), S1F4Pro (Android, Wi-Fi+4G, camera, printer), V400m (built-in printer), V400m with Bluetooth base station.
  - **Countertop**: M400, M450 (Android), P400 Plus, P630 (Android), SFO1 (Android, 8-inch display), V400c Plus (printer).
  - **Unattended**: S1U2 (Android, outdoor), UX300 (mount-in-kiosk); UX410 "no longer available for new orders".
  - **Card reader**: NYC1 / NYC1 with dock (pairs with phone via Bluetooth). — https://docs.adyen.com/point-of-sale/user-manuals
  - **Deprecated**: e315, e355, MX925, VX6xx/VX8xx series. Note: "PCI PTS 5 payment terminals will no longer be available for order starting April 30, 2026." — https://docs.adyen.com/point-of-sale/user-manuals
- **Restaurant/handheld fit** (docs-derived, not an explicit Adyen recommendation): pay-at-table requires a **portable terminal with integrated printer + Wi-Fi and cellular** (see §6), which points to **S1F2, S1F4Pro, V400m**; S1E4Pro (UK) for rugged no-printer handheld; the docs themselves publish no named per-vertical recommendation. — https://docs.adyen.com/point-of-sale/pay-at-x
- **Android terminal manufacturers/OS** (https://docs.adyen.com/point-of-sale/android-terminals): AMS1/S1E-family = Castles, M450/P630 = Verifone, SFO1 = Datecs; Android versions range 7.1.2–13 by model.

## 4. Your own POS app ON Adyen Android terminals

- "An Android payment terminal is a mobile all-in-one device that is capable of running Android apps" — you can run your own POS app on the terminal. — https://docs.adyen.com/point-of-sale/android-terminals
- Distribution is NOT Google Play: "You need to upload the app to Adyen, and then distribute the app to the terminals either on a schedule, using profiles, or using API requests." App requirements/restrictions at /point-of-sale/android-terminals/app-requirements (incl. debugging security restrictions). — https://docs.adyen.com/point-of-sale/android-terminals
- On-terminal apps can hit local Terminal API at `localhost`/`127.0.0.1:8443/nexo`. — https://docs.adyen.com/point-of-sale/design-your-integration/choose-your-architecture
- Extras: kiosk mode, barcode scanning, accessibility mode, remote troubleshooting, payment-flow theme customization. — https://docs.adyen.com/point-of-sale/android-terminals

## 5. Tap to Pay + POS Mobile SDK (phone as reader?)

- **iOS** (https://docs.adyen.com/point-of-sale/mobile-ios, requirements at https://docs.adyen.com/point-of-sale/mobile-ios/requirements):
  - Two modes: Tap to Pay on iPhone, or NYC1 Bluetooth card reader.
  - "The iPhone model must be iPhone XS or later." "Minimum required iOS version on the mobile device: 18.4." Device passcode mandatory (enforced from SDK 3.18.0). Xcode 16+ to build.
  - **Countries — Tap to Pay on iPhone: UK ✓ and US ✓** (also AU, CA, EU excl. GR, JP, HK, MX, NZ, SG, UAE). — https://docs.adyen.com/point-of-sale/ipp-mobile
  - Apple **entitlement** required (separate TEST and LIVE; LIVE can take weeks). SDK consumes **Terminal API PaymentRequests** (`Payment.Request` → `PaymentService.performTransaction`). — https://docs.adyen.com/point-of-sale/mobile-ios/build/tap-to-pay
  - **Session endpoints**: current = `https://softposconfig-test.adyen.com/softposconfig/v3/auth/certificate` (+ regional live variants incl. US); legacy `/checkout/possdk/v68/sessions` still works but "we are deprecating them." — https://docs.adyen.com/point-of-sale/mobile-ios/build/tap-to-pay
- **Android** (https://docs.adyen.com/point-of-sale/mobile-android, requirements at https://docs.adyen.com/point-of-sale/mobile-android/requirements):
  - Any Android phone/tablet that: "Must not have an integrated card reader", "Must have an integrated NFC reader", touch screen, "Must support hardware key attestation and be Google-certified". Android 12+ with security patch ≥ 5 Mar 2022. "The SDK expires every six months" — forced updates.
  - **So a Sunmi payment device (integrated reader) is excluded**; a Google-certified reader-less Sunmi/consumer device meeting attestation could qualify — the docs restrict by criteria, not manufacturer.
  - **Countries — Tap to Pay on Android: US ✓ but UK ✗** (supported: AU, EU excl. GR, HK, MY, MX, NZ, SG, UAE, US; "Not supported: Canada, Japan, UK"). — https://docs.adyen.com/point-of-sale/ipp-mobile
  - Card readers: NYC1 (PIN, SDK 2.4.0+) and NYC1-SCR (non-PIN); NYC1 dock needs Adyen's power adapter, firmware ≥ 3.X.00.76.
  - Third Android option: **Android Payments app** (runs on Adyen Android terminals). — https://docs.adyen.com/point-of-sale/mobile-android
- **Migration implication**: UK handheld strategy cannot be Tap to Pay on Android today — use Adyen handheld terminals (or Tap to Pay on iPhone) in the UK.

## 6. Hospitality features

- **Tipping** — 4 methods (https://docs.adyen.com/point-of-sale/tipping):
  1. **From POS app**: send `PaymentTransaction.AmountsReq.RequestedAmount` + `TipAmount`; "The terminal shows the original transaction amount and the tip amount. The customer then uses the terminal to confirm the tip, change the amount, or decline." Response: `AmountsResp.TipAmount`, `AmountsResp.AuthorizedAmount` (total incl. tip), minor-unit values in `posAmountGratuityValue`. "All terminal models are supported, except unattended terminals." — https://docs.adyen.com/point-of-sale/tipping/tipping-from-cash-register
  2. **From terminal**: terminal prompts fixed amounts / percentages / custom, or total-amount entry; can also be triggered per-payment with tender option `AskGratuity` ("Triggers tipping from the terminal"). — https://docs.adyen.com/point-of-sale/tipping/tipping-from-terminal and https://docs.adyen.com/point-of-sale/add-data/tender-options.md
  3. **On receipt** (US-style tip-adjust): "a pre-authorisation request to allow the customer to write a tip on the receipt," then adjust and capture. — https://docs.adyen.com/point-of-sale/tipping/tipping-on-receipt
  4. **Standalone**: account-configured tip prompt on every payment. — https://docs.adyen.com/point-of-sale/standalone/standalone-build/set-up-standalone#configure-tipping
- **Pay at table** (https://docs.adyen.com/point-of-sale/pay-at-x):
  - Terminal-initiated flow "at a table, in a hotel room, or curbside"; supports "equal and unequal split payments", all account payment methods + cash, tipping.
  - Hardware: "The payment terminal must have an integrated printer and support both Wi-Fi and cellular connections" — portable terminals only.
  - Flow: staff authenticates on terminal (reference number or employee card swipe) → terminal sends **`SaleWakeUp` event notification** to POS → POS finds the bill → optional `PrintRequest` (bill) → `PaymentRequest` with `PaymentData.SplitPaymentFlag: true`, `SaleData.SaleTransactionID` = bill id, `AmountsReq.RequestedAmount` + `PaidAmount` (amount already paid) → repeat until balance zero; "POS system keeps track of the amount that has been paid already."
  - Caveat: "Authentication by swiping the employee card is not supported on Android payment terminals."
- **Referencing sales**: `SaleData.SaleTransactionID.TransactionID` = "your reference to identify a payment... In your Customer Area and Adyen reports, this will show as the **merchant reference**" (unique value per payment recommended). Response `POIData.POITransactionID.TransactionID` = "unique transaction identifier" — contains the terminal tender reference and Adyen **PSP reference**; "You should store each transaction identifier" for refunds/reconciliation. — https://docs.adyen.com/point-of-sale/basic-tapi-integration/make-a-payment and https://docs.adyen.com/point-of-sale/design-your-integration/terminal-api
- **Partial approvals** (page: https://docs.adyen.com/point-of-sale/partial-payments — NOTE: direct fetch returned 404 during research; exact text recovered via search snippets of that URL, corroborated twice):
  - Enable per-payment with tender option `AllowPartialAuthorisation` in `SaleData.SaleToAcquirerData` ("Flags that a partial approval is allowed and it is possible that the authorized amount is lower than the requested amount" — syntax `"SaleToAcquirerData": "tenderOption=AllowPartialAuthorisation"` or Base64 JSON). — https://docs.adyen.com/point-of-sale/add-data/tender-options.md
  - Response: `Response.Result: Partial`; `PaymentResult.AmountsResp.AuthorizedAmount` may be less than requested; `AdditionalResponse` carries `posOriginalAmountValue`/`posAuthAmountValue`.
  - Follow-up: "make a second partial payment request for the remaining amount, with a `SaleReferenceID` that allows you to identify the two partial payments as belonging together"; warning: "ensure that your POS app alerts your staff to the fact that there is an amount remaining to be paid." Test with amounts ending in 139.
  - **Gift cards**: same mechanism — providers Givex, Intersolve, SVS, Fiserv/ValueLink; `PaymentInstrumentType: StoredValue`, `StoredValueAccountType: GiftCard`; "If the gift card balance is not enough, you make a follow-up payment request to let the shopper pay the remainder with another card or cash." — https://docs.adyen.com/point-of-sale/alternative-payment-methods/gift-cards-terminal-api/payment (overview + balance/activate/load/refund/void: https://docs.adyen.com/point-of-sale/alternative-payment-methods/gift-cards-terminal-api)
- **Offline / store-and-forward** (https://docs.adyen.com/point-of-sale/offline-payment):
  - Two mechanisms: Offline EMV (chip floor limit, contactless floor limit) and Store-and-Forward; limits ("Store-and-forward max. amount", "Max. payments" per terminal) configured by Adyen Support; settings visible under Devices > Device settings > Payment features.
  - "Supported with: A Terminal API integration with payment terminals using **local communications**. Standalone payment terminals with a built-in printer. Mobile SDK solutions: Tap to Pay on iPhone and iOS card reader."
  - Cloud caveat: "With payment terminals using cloud communications, it is not very useful to enable offline payments... an offline payment can only work if the loss of internet access happens after the terminal has already received the payment request through the cloud."
  - Mobile SDK "can perform store-and-forward transactions for 24 consecutive hours"; stored payments retried (Auto Rescue) for one calendar month.
  - Liability: "You are fully liable for the risk of failed captures, chargebacks, and disputes related to payments that you process offline." Offline responses have `"offline": true` + `offlineAuthCode`, no PSP reference at approval time.
  - **Migration note**: if offline resilience matters per-venue, that argues for local (or hybrid) rather than pure cloud Terminal API.

## 7. Boarding & fleet management (Management API)

- **Management API latest = v3**; test `https://management-test.adyen.com/v3`, live `https://management-live.adyen.com/v3`. — https://docs.adyen.com/api-explorer/Management/latest/overview
- Old **POS Terminal Management API (postfmapi) is deprecated** (from 1 Jan 2025, support stopped 1 Apr 2025) — use Management API. — https://docs.adyen.com/api-explorer/postfmapi/1/overview
- **Roles needed** on the API credential: "Management API—Terminal ordering read/write", "—Stores read/write", "—Terminal settings read/write", "—Terminal actions read/write". — https://docs.adyen.com/point-of-sale/automating-terminal-management
- **Endpoints** (https://docs.adyen.com/point-of-sale/automating-terminal-management and https://docs.adyen.com/point-of-sale/automating-terminal-management/assign-terminals-api):
  - `GET /terminals` — paginated fleet list (id, model, serial, assignment status, connectivity).
  - `POST /terminals/{terminalId}/reassign` — body: `companyId` | `merchantId` (+ required boolean `inventory`: "true assigns to inventory (cannot process transactions); false removes from inventory") | `storeId`. terminalId format `[Device model]-[Serial number]`. Returns 200, processed asynchronously.
  - `PATCH /terminals/{terminalId}/terminalSettings`; `POST /terminals/scheduleActions`.
  - Ordering: `POST|GET|PATCH /companies/{companyId}/terminalOrders`.
  - Stores (per-venue): `POST /merchants/{merchantId}/stores`, `GET /merchants/{merchantId}/stores`, `PATCH .../stores/{storeId}`.
  - Rate limits (live): ~160 writes/min, ~2000 reads/min per endpoint group.
- **Assignment mechanics**: reassignment "can take up to three hours before the reassignment takes effect" (terminal syncs every 3 h); bulk CSV reassignment in Customer Area (In-person payments > Payment devices > Terminals > More options > Bulk reassignment); Customer Area assignment needs "Merchant POS Terminal Management Admin role". — https://docs.adyen.com/point-of-sale/managing-terminals/assign-terminals
- **Boarding** (on-device): terminal must be assigned (or store selected on-screen) and "will not be able to board unless the merchant account or store has at least one payment method configured"; power on → connect network → confirm store → reboots; "The boarding process can take up to 30 minutes." — https://docs.adyen.com/point-of-sale/managing-terminals/board-terminal

## 8. Key migration takeaways for the POS SaaS

- **Hardware is the hard constraint**: existing PAX A920/A50 and Sunmi payment devices cannot be re-used with Adyen ("terminals that are supplied by Adyen" only — https://docs.adyen.com/point-of-sale/what-we-support/solutions). Plan a hardware swap per venue, or run the POS app on Adyen Android terminals (S1F2/S1F4Pro handhelds, P630/M450/SFO1 countertop).
- **Best current API surface**: Terminal API (nexo 3.0, "v1 latest", not date-versioned) over the new `device-api-*` cloud endpoints; Management API **v3** for stores/terminals; POS Mobile SDK with `softposconfig/v3` session endpoint (not the deprecated `/checkout/possdk/v68/sessions`).
- **UK gap**: Tap to Pay on Android is not available in the UK (iPhone is) — https://docs.adyen.com/point-of-sale/ipp-mobile.
- **Offline gap**: cloud Terminal API effectively has no store-and-forward — choose local comms where venue-level resilience is required — https://docs.adyen.com/point-of-sale/offline-payment.
