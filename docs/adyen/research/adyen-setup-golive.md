# Adyen: Account Setup, Test Env, Go-Live, SDKs — research report
All facts below come from pages fetched 2026-08-01. URL cited next to each fact.

## 1. Getting a TEST account today
- **Free, self-service** — "Get started with Adyen by creating a free test account"; no sales gate for test. https://docs.adyen.com/get-started-with-adyen/
- Signup form: https://www.adyen.com/signup — self-service, but "a test account doesn't guarantee you'll be approved as an Adyen customer" (live account is a separate application).
- **5-step path**: test account → build integration → apply for live account (eligibility checks) → sign contract + activate → configure live via go-live checklists. https://docs.adyen.com/get-started-with-adyen/
- Customer Areas: test = https://ca-test.adyen.com, live = https://ca-live.adyen.com
- Live-application requirements: https://docs.adyen.com/get-started-with-adyen/application-requirements

## 2. What works in test
**Online / e-com:**
- Test cards: **Visa 4111 1111 1111 1111**, **MC 5555 5555 5555 4444**, **Amex 3700 0000 0000 002** (all expiry 03/2030, CVC 737 / Amex 7373). 3DS2-enrolled cards: Visa 4917 6100 0000 0000, MC 5454 5454 5454 5454, Amex 3714 4963 5398 431. https://docs.adyen.com/development-resources/test-cards-and-credentials/test-card-numbers
- Testable in test env: payments + modifications (capture/refund), tokenization, risk features, 3DS2, result-code scenarios, webhooks. https://docs.adyen.com/development-resources/testing (refusal simulation detail: https://docs.adyen.com/development-resources/testing/result-codes)
- You can also create your own test cards. https://docs.adyen.com/development-resources/test-cards-and-credentials

**POS / terminals:**
- **No terminal simulator** is documented. Testing is done on **physical test terminals**: "For testing, you can order test payment terminals and an Adyen test card from your test Customer Area" (Devices > Orders & returns > New sales order; dispatch ~2 business days; terminals are **region-locked** to the ordering country). https://docs.adyen.com/point-of-sale/managing-terminals/order-terminals
- Adyen physical **test cards** (white-green v3 / blue-green v2) simulate brands, CVMs, declines, currencies; B2 test card sets also purchasable. **Real cards can't be used in test.** https://docs.adyen.com/point-of-sale/testing-pos-payments
- Terminal orders can also be placed **via Management API**. https://docs.adyen.com/point-of-sale/automating-terminal-management (linked from order-terminals page)
- Supported hardware families: Verifone Engage (P400 Plus, V400m, etc.), Android terminals (S1E/S1F, AMS1, M450, P630, S1U2, SFO1), NYC1 card reader; plus Tap to Pay iOS/Android SDKs. https://docs.adyen.com/point-of-sale

## 3. API credential model
- Credential = **username + API key + roles**; ws-user format: `ws_123456@Company.[YourCompanyAccount]`. https://docs.adyen.com/development-resources/api-credentials
- **Company-account credential** → company + ALL merchant accounts; **merchant-account credential** → that account only; can restrict to account groups. Same URL.
- **Key rotation**: new API key active immediately, old key stays valid 24h (or expire immediately); key is NOT re-viewable after leaving the page. Basic-auth password rotation kills old password instantly. Allowed-IP ranges supported; credentials can be deactivated, never deleted. Same URL.
- **Roles**: every credential needs ≥1 role; role catalog: https://docs.adyen.com/development-resources/api-credentials/roles
- **Client key** (for Drop-in/Components only): public, "32-character string encoding the API credential" + `test_`/`live_` prefix; requires **allowed origins** (wildcards OK, `https` mandatory in live; origins editable without regenerating the key); "The client key is not used when making requests to our APIs." https://docs.adyen.com/development-resources/client-side-authentication
- Auth types overview: https://docs.adyen.com/development-resources/api-authentication

## 4. Live URLs + which need the prefix
- **Live URL prefix** = hex + company name, e.g. `1797a841fbb37ca7-AdyenDemo`; from live CA > Developers > API URLs > Prefix. https://docs.adyen.com/development-resources/live-endpoints
- **Checkout API**: test `https://checkout-test.adyen.com/v72`; live `https://{PREFIX}-checkout-live.adyenpayments.com/checkout/v72` — **prefix required**. https://docs.adyen.com/api-explorer/Checkout/72/overview
- **Classic PAL Payments API**: live `https://[prefix]-pal-live.adyenpayments.com/pal/servlet/Payment/[version]/...` — prefix required. https://docs.adyen.com/development-resources/live-endpoints
- **Cloud Terminal API**: **NO prefix** — regional endpoints. Test `https://device-api-test.adyen.com/v1/merchants/{merchantAccount}/devices/{deviceId}/sync|async`; live `device-api-live.adyen.com` (EU), `-us`, `-au`, `-nea`, `-apse` variants. Note: these `device-api` endpoints are current; the old `terminal-api-*` endpoints are relegated to a legacy collapsible. `/sync` holds the connection 150+ s for the result; `/async` returns 200 immediately, result via webhook. https://docs.adyen.com/point-of-sale/design-your-integration/choose-your-architecture/cloud/
- **Management API**: **NO prefix** — `https://management-test.adyen.com/v3` / `https://management-live.adyen.com/v3`. https://docs.adyen.com/api-explorer/Management/3/overview

## 5. PCI / SAQ by integration style
- **Drop-in/Components** → **SAQ A**: "qualifies you for the simplest form of PCI validation (SAQ A)". https://docs.adyen.com/payment-methods/cards/web-drop-in
- **API-only with encrypted card details** (Adyen client-side encryption) → **SAQ A**. https://docs.adyen.com/online-payments/api-only
- **API-only raw card data** → **SAQ D** ("most extensive form") + must be pre-approved by your Adyen account manager. https://docs.adyen.com/payment-methods/cards/raw-card-data
- SAQ A merchants ALSO need a **quarterly vulnerability scan**. https://docs.adyen.com/online-payments/pci-dss-compliance
- **In-person (terminals)**: Adyen default is **E2EE** → merchant completes only **SAQ B-IP** ("relatively easy questionnaire"); optional P2PE mode → SAQ P2PE (33 requirements) + P2PE Instruction Manual (terminal inspections, audit trails). https://docs.adyen.com/development-resources/e2ee-p2pe-comparison
- PCI DSS **v4.0.1** (from 31 Mar 2025) removed reqs 6.4.3 (payment-page scripts) + 11.6.1 (tamper detection) from SAQ A — they still apply under SAQ D/onsite assessment. https://docs.adyen.com/development-resources/pci-dss-compliance-guide/saq-a-eligibility
- Adyen publishes **SRI hashes** per adyen-web version for script security. https://docs.adyen.com/development-resources/pci-dss-compliance-guide/script-security
- Guide root + merchant levels (annual validation; Adyen = PCI DSS Level 1 Service Provider): https://docs.adyen.com/development-resources/pci-dss-compliance-guide, https://docs.adyen.com/development-resources/pci-dss-compliance-guide/merchant-levels

## 6. Rate limits
- **No global published rate-limit page** — https://docs.adyen.com/development-resources/rate-limits returns 404, and the Checkout v72 overview states no limits. Limits are documented **per-API on API Explorer overviews** where they exist, e.g. Legal Entity Management: live 700 req/5 s, test 200 req/5 s, 5 failed req/10 s. https://docs.adyen.com/api-explorer/legalentity/3/overview
- Go-live checklist separately requires protections against **card-testing attacks** on your side. https://docs.adyen.com/online-payments/go-live-checklist

## 7. SDK inventory
- **Server libraries** in C#/Go/Java/Node/PHP/Python/Ruby via package managers; Terminal API **cloud** supported in C#, Go, Java, Node, PHP, Ruby; Terminal API **local** (with local-protection crypto) only C#, Java, Node. https://docs.adyen.com/development-resources/libraries
- **Node**: `@adyen/api-library` — requires **Node.js 18+**, default HTTP client is **node `https`** (custom client injectable, axios example shown). **No Deno/edge-runtime support mentioned anywhere.** Supports Checkout **v72**, Payments **v68**, Management **v3**. https://github.com/Adyen/adyen-node-api-library
  - Practical read for our stack: for Supabase Edge Functions (Deno), plan to **raw-REST** (as done for Ryft) — the SDK targets Node's stdlib; nothing in Adyen docs claims Deno compat. It's plain JSON-over-HTTPS with an `X-API-Key` header, so raw REST is low-friction.
- **Web**: `@adyen/adyen-web` — current major is **Web v6**, paired with **Checkout API v72** (docs reference "Adyen Web v6" + "Checkout API v72" upgrade guides). Mobile: **Adyen iOS v5**, **Adyen Android v5**. https://docs.adyen.com/online-payments/build-your-integration/ and https://github.com/Adyen/adyen-web (no first-class React wrapper mentioned in README; Drop-in/Components are framework-agnostic JS)
- **Versioning policy**: version lives in the URL path (`/v72/payments`); old versions maintained indefinitely; "classic" APIs (Payment/Recurring/Payout/BinLookup) treat added response fields as breaking, new APIs don't; latest version = check API Explorer; API Diff Tool available. https://docs.adyen.com/development-resources/versioning
- Bonus: Adyen ships an **MCP server** for AI-assisted development. https://docs.adyen.com/development-resources/mcp-server

## 8. Management API (programmatic config) — fits our multi-venue model
- v3 manages: **merchant accounts + stores**, **API credentials** (API keys, client keys), users, **webhooks** (create/update/test at company or merchant level), payment methods, **terminals** (assignment, actions, settings at multiple hierarchy levels), **terminal orders**, Android files, **payout settings**, split configs. https://docs.adyen.com/api-explorer/Management/3/overview
- Webhook endpoints: `POST /companies/{companyId}/webhooks` and `POST /merchants/{merchantId}/webhooks`. https://docs.adyen.com/api-explorer/Management/3/post/merchants/(merchantId)/webhooks
- Terminal/config-change events arrive via **Management Webhooks** (e.g. `terminalSettings.modified`). https://docs.adyen.com/api-explorer/ManagementNotification/3/post/terminalSettings.modified
- **Account structure**: company account (core entity) → merchant accounts ("Your payments are processed in sub-accounts called merchant accounts" — payouts/settlement sit here) → **stores** for physical POS locations; **account groups** for cross-account search (one merchant account per group only). Multi-venue guidance: https://docs.adyen.com/account/account-structure and https://docs.adyen.com/account/define-account-structure

## 9. Webhooks model (needed for go-live)
- HTTP POST to your endpoint; **acknowledge with 2xx**, store, then process. HMAC signature verification documented separately. Types cover payments, disputes, reports, onboarding, terminal settings. https://docs.adyen.com/development-resources/webhooks, https://docs.adyen.com/development-resources/webhooks/secure-webhooks, https://docs.adyen.com/development-resources/webhooks/webhook-types

## 10. Go-live checklists
**Online** (34 items; highlights): create extra merchant accounts; user roles + 2FA; add payment methods; bank details + payout settings + Settlement details report + optional Reserve; risk profile + card-testing protection + 3DS/Dynamic 3DS; PCI attestation done; generate LIVE API key; switch endpoints to live URLs; set up live webhooks (2xx acks, all event types); end-to-end live tests (refusals, refunds/partial refunds, manual capture, 3DS, tokenization). https://docs.adyen.com/online-payments/go-live-checklist

**POS / Terminal API**: live account + contract; merchant accounts ~4 business days; **store request form** ~2 business days after; bank account per payout currency; payout schedule (default Sales-Day); order **live** terminals (~4 days; "Test terminals cannot process live payments"); enable Terminal API + assign terminals to stores; cloud: new live API key + switch to live regional endpoints; local: live certificate + **mandatory encryption** ("A live terminal will not accept API requests without encryption"); board terminals; live low-value payment + refund test (Received → Authorised → Settled). https://docs.adyen.com/point-of-sale/get-started/go-live-tapi

**Pre-go-live integration checklists**: https://docs.adyen.com/online-payments/integration-checklist and https://docs.adyen.com/point-of-sale/get-started/tapi-checklist

## Key takeaways for our migration
- **Start today free**: self-serve test account at adyen.com/signup; live account is a later, sales/contract-gated application — factor lead times (merchant accounts ~4 d, stores ~2 d, terminals ~4 d).
- **Order test terminals early** — no simulator; physical test terminal + Adyen test card, region-locked (order UK and US units separately).
- **Best current versions**: Checkout API **v72**, Management API **v3**, Adyen Web **v6**, Terminal API via **device-api** regional endpoints (not the legacy terminal-api hosts).
- **Prefix rules**: Checkout/PAL live need the per-company prefix; Terminal API cloud and Management API do not.
- **PCI**: Drop-in or encrypted API-only = SAQ A (+quarterly scan); terminals under default E2EE = SAQ B-IP; avoid raw card data (SAQ D + eligibility gate).
- **Edge functions**: use raw REST from Deno (SDK is Node-18+/node-https based, no Deno support documented) — same pattern as Ryft.
- **Management API v3 covers our whole per-venue automation surface**: stores, terminal orders/assignment/settings, webhooks, credentials, payout settings — programmatic venue onboarding is viable.