# Adyen Online Payments — Current Recommended Integration (researched 2026-08-01, all facts fetched from docs.adyen.com)

Research method note: Adyen docs are client-rendered, but every page is also served as clean Markdown by appending `.md` to the URL (stated at https://docs.adyen.com/llms.txt). All facts below were pulled from fetched pages; source URL follows each fact.

## 1. Latest Checkout API version + base URLs

- **Latest version: v72** — API Explorer shows v72 as latest. https://docs.adyen.com/api-explorer/Checkout/latest/overview
- **v72 released 2026-04-15** — release-notes entry "2026-04-15 — Checkout API — Version 72". Breaking change: new server-side validations on ~16 request params (`reference`, `returnUrl`, `shopperEmail`, `billingAddress.postalCode`, `metadata`, `telephoneNumber`, etc.) — requests failing validation are now rejected; plus `holderName` card-number detection ("Invalid card holder name"). https://docs.adyen.com/online-payments/release-notes — upgrade guide: https://docs.adyen.com/online-payments/upgrade-your-integration/upgrade-to-checkout-api-v72
- **Test base URL:** `https://checkout-test.adyen.com/v72` https://docs.adyen.com/api-explorer/Checkout/latest/overview
- **Live base URL:** `https://{PREFIX}-checkout-live.adyenpayments.com/checkout/v72` — prefix is "a hex-encoded random part and your company name" (e.g. `1797a841fbb37ca7-AdyenDemo`), found in **live Customer Area > Developers > API URLs > Prefix**. Each company account gets a unique hostname. https://docs.adyen.com/development-resources/live-endpoints/
- **Region pinning:** all API requests for the same payment session must use the same live endpoint region — mixing regions for `/payments` and `/payments/details` can break 3DS2 auth. https://docs.adyen.com/online-payments/build-your-integration/sessions-flow (Test and go live section)
- Note: some doc code samples still show `v71` in curl examples; `/paymentLinks` examples already show `v72`. Endpoint pattern is identical — just use v72.

## 2. Recommended flow: Sessions vs Advanced

Source for this whole section: https://docs.adyen.com/online-payments/build-your-integration/

- **Sessions flow is the default recommendation:** "Sessions flow is the default integration that we recommend and that meets the requirements for most online payments integrations."
- **Sessions flow** = ONE server call to `/sessions`; Adyen sends payment data server→your client; redirects/actions handled client-side. Effort: "Light".
- **Advanced flow** = THREE server calls: `/paymentMethods`, `/payments`, `/payments/details`; Adyen responds server→server; redirects/actions can be confirmed server-side. Effort: "Medium".
- **Middle option — "Sessions flow with additional methods":** client-side libraries can also call `/payments` + `/payments/details` from your server so you get responses server-side (2–3 requests).
- **You need Advanced (or Sessions+additional methods) for:** partial payment with a gift card + another method; confirming redirects/additional actions on your server; server-side checks (e.g. inventory) before payment; updating the amount before payment (cart changes); Apple Pay / Google Pay **express checkout**; reordering payment methods per transaction; inserting a T&C step.
  - Relevance for the POS app: gift-card split payments and server-side order checks are core hospitality flows — plan for Advanced flow (or Sessions + additional methods) rather than plain Sessions.
- **/sessions request** (https://docs.adyen.com/online-payments/build-your-integration/sessions-flow): required = `merchantAccount`, `amount` (minor units), `returnUrl` (no PII allowed in URL), `reference` (min 3 chars). Recommended: `countryCode`, `channel: "Web"`, `shopperEmail` + `shopperReference` (used in risk checks + 3DS). Session expiry default **1 hour**, max **24 hours** (`expiresAt`). New in v72: `payable: false` to allow updating the amount after session creation.
- Server-side API libraries exist for Java, PHP, .NET, Node, Python, Ruby, Go (e.g. `npm install --save @adyen/api-library`; Node.js 18+). https://docs.adyen.com/online-payments/build-your-integration/sessions-flow

## 3. Drop-in vs Components for web (custom React checkout)

- **Web Drop-in** = "Use our pre-built UI for accepting payments"; **Web Components** = "Use our customizable UI components" — per-payment-method components you mount into your own layout. https://docs.adyen.com/online-payments/build-your-integration/sessions-flow
- **For a custom React checkout: Web Components fits.** Docs explicitly address React/Vue: "use references instead of selectors and ... do not re-render the DOM element" the component mounts into. https://docs.adyen.com/online-payments/build-your-integration/sessions-flow
- A third option, **Web Hosted Checkout** ("quick-to-integrate hosted solution"), also exists on the same page — not relevant for custom UIs.
- **Current web library: Adyen Web v6 — latest 6.41.0 (2026-07-16)**; each v6 release "requires Checkout API v69 or later", latest releases say "We recommend that you use Checkout API v72 or later." https://docs.adyen.com/online-payments/release-notes
- Install: `npm install @adyen/adyen-web --save`; `import { AdyenCheckout, Card } from '@adyen/adyen-web'` + `import '@adyen/adyen-web/styles/adyen.css'` (tree-shakeable in v6). CDN embed alternative requires SRI integrity hashes published per version in release notes. https://docs.adyen.com/online-payments/build-your-integration/sessions-flow
- `AdyenCheckout` config (Sessions/Components): required `session`, `environment` (test → `live`/`live-us`/`live-au`/`live-nea`/`live-in` matching your live endpoint region), `amount`, `countryCode`, `locale`, plus `clientKey`; required events `onPaymentCompleted`, `onPaymentFailed`; `onSubmit`/`onAdditionalDetails` needed for the additional-methods use cases; `showPayButton`/`.submit()` for your own Pay button (PayPal buttons don't support `.submit()`). https://docs.adyen.com/online-payments/build-your-integration/sessions-flow
- Best-practice constraints: avoid iframes (must be same-domain if used), avoid WebViews in native apps, SSR must init `AdyenCheckout` client-side. https://docs.adyen.com/online-payments/build-your-integration/sessions-flow

## 4. Client key vs API key

Source: https://docs.adyen.com/development-resources/client-side-authentication/

- **Client key** = public, client-side only: renders secure card fields, encrypts card details, detects card type. "The client key is not used when making requests to our APIs. For API requests, you need to get an API key."
- Format: `test_` or `live_` prefix + 32-char string (e.g. `test_870be2...`).
- Generate: Customer Area > **Developers > API credentials** > select credential > **Client settings > Authentication > Client key** tab > **Generate client key**; repeat in live CA for live.
- **Allowed origins required:** domains you'll serve checkout from; wildcards allowed (`https://*.example.org`); must be `https` in live; origins are linked to the API credential so you can edit them without regenerating the key. (Multi-venue note: add every venue's ordering domain/subdomain.)
- **API key** = server-side secret, sent as `x-api-key` header on Checkout API calls (see curl examples). https://docs.adyen.com/online-payments/build-your-integration/sessions-flow

## 5. Idempotency

Source: https://docs.adyen.com/development-resources/api-idempotency/

- Header: `idempotency-key: <key>`, max **64 chars**, UUID v4 recommended; supported on POST requests (e.g. `/payments`).
- Keys valid "for a minimum period of 7 days after first submission"; repeat request returns the first response; verify via `idempotency-key` response header.
- Scoped to **company account level**; duplicates NOT checked across different regional endpoints.
- Two simultaneous identical keys → HTTP 422/409, error code **704** "request already processed or in progress", with `transient-error: true` header = safe to retry.
- Security caveat: downgrading a credential's access doesn't stop retrieval of past responses via old keys.

## 6. 3D Secure 2

Source: https://docs.adyen.com/online-payments/3d-secure/

- Two flows: **Native 3DS2** (in-page/app authentication, better conversion) and **Redirect 3DS2** (issuer site; "might lead to lower conversion rates").
- **Sessions flow: zero extra work** — "You do not need additional configuration to support 3D Secure 2. The Sessions flow integration has built-in support for 3D Secure 2." Advanced flow: follow the per-platform Drop-in/Components 3DS guides (child pages: /online-payments/3d-secure/native-3ds2, /online-payments/3d-secure/redirect-3ds2).
- Frictionless vs challenge flows both handled; compliance context: PSD2 SCA (EEA) and **UK Payment Services Regulations 2017**; liability shift rules. (US: 3DS not mandated; docs list 3DS "for regulation compliance" guide at /online-payments/3d-secure-for-regulation-compliance.)
- CSP gotcha: strict Content-Security-Policy can block native 3DS2 challenge loading (Adyen doesn't publish a URL list); set `authenticationData.threeDSRequestData.nativeThreeDS: "disabled"` in `/sessions` to force redirect flow instead. https://docs.adyen.com/online-payments/build-your-integration/sessions-flow
- `shopperEmail` is "used in a number of risk checks, and for 3D Secure" — send it. https://docs.adyen.com/online-payments/build-your-integration/sessions-flow

## 7. Apple Pay enablement (web)

Sources: https://docs.adyen.com/payment-methods/apple-pay/ and https://docs.adyen.com/payment-methods/apple-pay/web-component/

- Two certificate routes: **Adyen's Apple Pay certificate** (recommended path, least work) or **your own merchant identity certificate**.
- With `/sessions` + Adyen's certificate: "you do not need to add any additional configuration for Apple Pay" in the Component.
- Setup: add Apple Pay in Customer Area (needs **Change payment methods** role) + set up certificate. Testing requires Apple's test cards + a Sandbox tester Apple ID; "An Apple Developer account is required to create Sandbox testers... even when using Adyen's certificate."
- **Go-live (Adyen certificate):** download Adyen's domain association file and host it at `/.well-known/apple-developer-merchantid-domain-association` (exact filename) on **every domain and subdomain** offering Apple Pay; add Apple Pay in live CA; manage/verify domains in live CA > Payment Methods > (Apple Pay) > **Apple Pay domains**. Working example file: https://eu.adyen.link/.well-known/apple-developer-merchantid-domain-association
- **Go-live (own certificate):** complete Apple's domain verification per domain, implement `onValidateMerchant` event, allow Apple's IPs + `out.adyen.com` through your firewall.
- Live API credential needs the **API Clientside Encryption Payments** role.
- iframe caveat: Safari 16 or earlier requires iframe origin to match top-level origin.
- Availability: catalog lists Apple Pay for **GB and US** (among many). https://docs.adyen.com/payment-methods

## 8. Google Pay enablement (web)

Source: https://docs.adyen.com/payment-methods/google-pay/web-component/

- Setup: add Google Pay in your Customer Area (/payment-methods/add-payment-methods); load the Google Pay API JavaScript library; mount the Component.
- Config: `configuration.gatewayMerchantId` = your Adyen merchant/company account name; `configuration.merchantId` = your Google Merchant ID — "can be anything for testing"; before go-live get it from the **Google Pay & Wallet Console** (https://pay.google.com/business/console).
- **Go-live:** (1) API credential has **API Clientside Encryption Payments** role; (2) configure Google Merchant ID in live CA; (3) complete Google's **request production access** steps for web.
- Testing: enroll in Google's test card suite; to test 3DS2 you must use Amex or Discover test cards (only brands triggering challenge in test).
- Availability: catalog lists Google Pay for **GB and US**. https://docs.adyen.com/payment-methods

## 9. Payment method availability — UK + US (restaurant-relevant)

Source: payment methods catalog, https://docs.adyen.com/payment-methods (each method links to its own page):

- **Visa, Mastercard, Amex, Discover:** all listed for GB and US (Amex/Discover US confirmed; Discover GB confirmed).
- **Apple Pay / Google Pay:** GB + US (wallets).
- **PayPal:** GB + US; Direct flow; Web Drop-in + Web Components; refunds/partial refunds/separate+partial captures/recurring supported.
- **Klarna:** *Pay later* = GB (not US). *Pay over time* = GB **and** US. Redirect flow; full refund/capture feature set.
- **Cash App Pay:** US only (wallet, Direct flow). **Cash App Afterpay:** US only (BNPL). **Venmo:** US only (Web Drop-in/Components).
- **ACH Direct Debit:** US + Puerto Rico, USD.
- **Afterpay:** AU/CA/NZ only — no UK "Clearpay" row exists in the catalog.

## 10. Pay by Link (invoices / catering deposits)

Sources: https://docs.adyen.com/unified-commerce/pay-by-link and https://docs.adyen.com/unified-commerce/pay-by-link/create-payment-links/api

- Hosted Adyen payment page; create links via **API, Customer Area, or iOS app**; customizable with brand name/logo.
- **API:** POST `/paymentLinks` on Checkout API (docs example uses `https://checkout-test.adyen.com/v72/paymentLinks`). Required: `merchantAccount`, `reference`, `amount`. Optional: `expiresAt` (default link expiry **24 hours**), `shopperLocale`, `description`. **Reusable payment links** supported. Idempotency-key supported on the request.
- Links are auto-removed **3 months** after creation.
- **Before your first live link:** you must add a terms & conditions URL in live CA > **Payments > Payment link settings** (must name the legal entity of the merchant account creating the link).
- Settings page (/unified-commerce/pay-by-link/settings) controls available options; supported methods list at /unified-commerce/pay-by-link/supported-payment-methods.

## Migration-decision summary for the POS app

- Target **Checkout API v72** + **Adyen Web v6 (6.41.0)** now — v72's stricter field validation is easier to build against from day one than to retrofit.
- Custom React checkout ⇒ **Web Components** (not Drop-in), via npm.
- Gift-card split payments + server-side order checks (hospitality core) ⇒ plan the **Advanced flow** or **Sessions + additional methods**, not plain Sessions — per Adyen's own use-case table. Express wallet checkout (kiosk/QR fast paths) also requires this.
- Per-venue multi-domain online ordering ⇒ every domain needs: allowed-origin on the client key, Apple Pay domain-association file, and (if per-venue merchant accounts) its own `gatewayMerchantId` value.
- Idempotency keys are only guaranteed 7 days and scoped to company account — design payment retry logic around that window.
