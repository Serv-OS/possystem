# Adyen for Platforms — research report (all facts from pages fetched 1 Aug 2026)

## 1. Which model Adyen recommends for a POS ISV

- **Decision page**: https://docs.adyen.com/adyen-for-platforms-model — compares two AfP flavours:
  - **Marketplace model** (https://docs.adyen.com/marketplaces): **online payments only**; "In-person payments: Not supported", "Payment facilitators: Not supported". For businesses where "your brand is known to both your users and their customers".
  - **Platform model** (https://docs.adyen.com/platforms/): supports **in-person payments and payment facilitators**. Explicitly targeted at "a commerce platform, **ordering or point-of-sale solution, retail management system**, or you are a payment facilitator". → **This is the recommended model for our case** (POS SaaS with terminals, kiosk, QR).
- **Classic Platforms is legacy**: https://docs.adyen.com/classic-platforms says "This page is for classic Adyen for Platforms integrations. If you are just starting your implementation, refer to our new integration guide" (→ /adyen-for-platforms-model). Classic = Account API v6 / Fund API v6 (listed at https://docs.adyen.com/api-explorer/). **Do not build on Classic.**

### Alternative: plain merchant-account-per-venue (no balance platform)
- Standard structure = **company account → merchant accounts → stores**: https://docs.adyen.com/account/account-structure ("The company account holds all your merchant accounts"; "The merchant account is where you receive the payout of funds, as well as the reports used for reconciliation").
- Guidance at https://docs.adyen.com/account/define-account-structure: "we recommend that you have as few merchant accounts as possible"; "You need at least one merchant account for **each legal entity that you process payments with**"; "a single merchant account can be associated with only one acquiring region"; "We recommend creating separate merchant accounts for ecommerce (online payments) and in-person payments"; more merchant accounts = more payout batches; separate merchant accounts are how you scope user permissions.
- POS-specific: https://docs.adyen.com/point-of-sale/design-your-integration/determine-account-structure — hierarchy company → merchant → **store** (store IDs identify physical locations); at least one merchant account per country/region; for many locations Adyen recommends "a merchant account per legal entity, country/region, or brand, with store IDs underneath"; consolidated model = one bank transfer per settlement currency.
- **Implication**: the standard model keys merchant accounts to *your* legal entities. Independent restaurant venues are separate legal entities that need onboarding/KYC and their own payouts — that is exactly what the Platform model provides (sub-merchant onboarding + per-venue balance accounts). The /adyen-for-platforms-model page's ISV recommendation (Platform model for "point-of-sale solution" providers) is the closest-to-official steer.

## 2. Current AfP architecture (Platform model)

Source: https://docs.adyen.com/platforms/account-structure-resources/platform-structure
- **Balance platform** — regional container; "a balance platform and merchant account in each region that you are registered and wish to acquire payments" (e.g. one EU/UK, one US).
- **Legal entity** — KYC object for the platform and for each user (venue owner business).
- **Account holder** — represents a user, defines "their payment processing capabilities"; has ≥1 balance account.
- **Balance account** — per-currency; "hold your user's funds"; payout requires an attached transfer instrument.
- **Transfer instrument** — the user's "verified bank account" for payouts.
- **Business line** — user's industry info per country.
- **Store** — "the physical locations of your user's businesses", "tied to the respective merchant accounts"; routes payments to the right merchant account.
- **Liable balance account** — holds the *platform's* funds (commission lands here; chargebacks/fees default here). Docs: https://docs.adyen.com/platforms/manage-liable-accounts
- Fund flow: stores → merchant accounts → balance platform → split into user balance accounts + liable account → payout via transfer instruments.

**APIs and current versions** (from https://docs.adyen.com/api-explorer/):
- Legal Entity Management API **v4** (onboarding/KYC objects)
- Balance Platform Configuration API **v2** (account holders, balance accounts, sweeps)
- Transfers API **v4** (fund movements/payout tracking)
- Management API **v3** (stores, terminals, payment methods, split profiles)
- Checkout API **v72** (online payments)
- Terminal API **v1** (in-person)
- Disputes API v30; Classic Platforms Account/Fund v6 (legacy — avoid)

## 3. Onboarding sub-merchants (hosted vs API-only vs components)

Source: https://docs.adyen.com/platforms/onboard-users
- **Hosted onboarding** — Adyen-hosted UI; two starts: "onboarding on invite" (Customer Area + share link, SMS auth) or **API-initiated** (create resources + onboarding link via API, redirect user). Supports organizations, individuals, sole props; 40+ countries incl **US, UK, EU**. Features: instant bank account verification via online-banking login (select countries), ID-document scan autofill (v3/v4). Pros per docs: minimal effort, reduced compliance burden, higher verification pass rates.
- **API-only** — you build the UI, submit data via **Legal Entity Management API** + **Configuration API**; works anywhere AfP is supported; you own compliance/data handling.
- **Onboarding components** — embeddable Adyen UI components inside your own UI; components create the resources automatically. Docs: https://docs.adyen.com/platforms/onboard-users/components
- **Hosted onboarding versions**: "The latest stable onboarding version is **v4**"; Adyen gives "approximately 6-12 months" notice before sunsetting a version. v4 enforces PCI forms + Terms of Service at onboarding. Source: https://docs.adyen.com/platforms/onboard-users/onboarding-versions
- Step sequence hub: https://docs.adyen.com/platforms/onboard-users/onboarding-steps (nav page; per-resource pages under /platforms/manage-legal-entities, /platforms/manage-account-holders, /platforms/manage-balance-accounts, /platforms/manage-transfer-instruments, /platforms/manage-stores).

## 4. KYC liability and obligations

Source: https://docs.adyen.com/platforms/verification-overview
- "As required by payment industry regulations, **Adyen must verify the users** in your platform before you can process payments, pay out their funds..." — **Adyen carries the regulatory KYC obligation**; the platform's job is collecting data and facilitating remediation.
- **Capabilities** (receive payments, send funds, etc.) are granted/restricted per verification outcome. Docs: https://docs.adyen.com/platforms/verification-overview/capabilities
- Deadlines ~**30 days** (fund transfers/banking) to **60 days** (receiving payments); "Users are allowed to continue using the capabilities while the deadline is active"; unresolved → capability disallowed.
- **Payment facilitator data duty**: "your user is considered the **Merchant of Record**"; you must send sub-merchant data — store config fields `email`, `id` (≤15 alphanumeric), `mcc`, `name` (≤22 chars, appears on statements); or per-request Terminal API `subMerchantId` (≤19 chars) + `subMerchantCity/Country/PostalCode/Street/TaxId/Mcc`. Standalone terminals support store-config only. Source: https://docs.adyen.com/platforms/in-person-payments/payment-facilitators

## 5. Routing a payment to a sub-merchant

- **Online**: add a **`splits` array to POST /payments or POST /sessions** (Checkout API). Split item fields: `type`, `account` (the **balanceAccountId** — not needed for `Commission`), `amount.currency`, `amount.value`, `reference` (required for `BalanceAccount`). Types: **`BalanceAccount`** (sale amount to venue), **`Commission`** (your fee → auto-books to liable balance account), **`PaymentFee`**, `Remainder`, `TopUp`. Source: https://docs.adyen.com/platforms/online-payments/split-transactions/split-payments-at-authorization (also split-at-capture variant: /platforms/online-payments/split-transactions/split-payments-at-capture)
- **In-person**: POS app uses **Terminal API**; payment is processed "through your user's store, into their merchant account", then the balance platform; you supply `merchantAccount` + `store` + split instructions. "If you do not provide any split instructions...the whole transaction amount and fees are booked to your liable balance account." Sources: https://docs.adyen.com/platforms/in-person-payments , https://docs.adyen.com/platforms/quickstart-guide/payments
- **Automatic splits (recommended for POS)**: **split configuration profiles** linked to each venue's **store**; rules = conditions (currency, payment method, funding source, shopper interaction, card region) + logic (**Commission** as fixed minor units and/or basis points, transaction-fee booking, refund/chargeback allocation, Tip, Surcharge, DCC Markup, Remainder). Managed via **Management API** or Customer Area. "Any split instruction that you send in a request overrides the automatic split." Source: https://docs.adyen.com/platforms/automatic-split-configuration
- **Refunds**: total refund with no splits → "funds are deducted according to the split ratio of the payment authorization"; specify `splits` to control funding; must reuse the original split `reference`/pspReference values; missing/closed balance account → falls back to liable account. Source: https://docs.adyen.com/platforms/online-payments/split-transactions/split-refunds (in-person: /platforms/in-person-payments/split-transactions/split-refunds)
- **Chargebacks**: default "Adyen withdraws the disputed funds from your platform's **liable balance account**"; alternatives: book to one user balance account, or split per original ratio; `costAllocationAccount` routes chargeback fees separately; payment-level logic overrides balance-platform default. Source: https://docs.adyen.com/platforms/online-payments/split-transactions/split-chargebacks

## 6. Platform fees / revenue share

Source: https://docs.adyen.com/platforms/online-payments/transaction-fees
- Default: Adyen's costs "are deducted from your liable balance account" (platform absorbs).
- You can pass to venues via fee split types: granular **`Interchange`**, **`SchemeFee`**, **`AdyenCommission`**, **`AdyenMarkup`**; aggregates **`AcquiringFees`** (interchange+scheme), **`AdyenFees`** (commission+markup), **`PaymentFee`** (all).
- If you send no fee-split instruction, "Adyen automatically updates the request to include the PaymentFee split type".
- Your revenue = **Commission splits** (per-request or basis-points/fixed in split profiles) booked to your liable balance account. Tiered/processing costs cannot be allocated per-payment.

## 7. Payouts per venue

- **Managed payouts** (Adyen-managed logic): one schedule per balance account per currency; frequencies **weekdays / weekly (chosen day) / monthly (chosen date)**; "Standard" (2-day) vs "Accelerated" (1-day) arrival; minimum payout amount, retained amount, custom bank-statement description; **local payouts only** (same country+currency); configured "with the help of your Adyen contact". Source: https://docs.adyen.com/platforms/managed-payouts
- **Custom payouts / sweeps** (self-managed): schedules created via **Balance Platform Configuration API** ("sweep" resource) per balance account — trigger threshold, full-balance or fixed amount, reserve to keep; webhook `balancePlatform.balanceAccountSweep.created`; execution tracked via Transfers API (`balancePlatform.transfer.updated`). Sources: https://docs.adyen.com/platforms/custom-payouts/scheduled-payouts , settlement-delay config: https://docs.adyen.com/platforms/custom-payouts/configure-settlement-delay , on-demand: https://docs.adyen.com/platforms/custom-payouts/on-demand-payouts
- Sales-day closing time configurable: https://docs.adyen.com/platforms/settle-funds/configure-closing-time
- Reporting for venues/back-office: balance platform accounting/balance/statement/payout/fee reports — https://docs.adyen.com/platforms/reports-and-fees

## 8. Terminals and stores (platform model)

- **Stores**: created/managed via **Management API** (e.g. `PATCH /merchants/{merchantId}/stores/{storeId}`); store links to the user's legal entity **through business lines**; statuses Active / Inactive (blocks new transactions, captures still possible) / Closed (permanent). Source: https://docs.adyen.com/platforms/manage-stores
- **Terminals**: order via Customer Area or **Management API**; drop-ship to venues or bulk-ship; assign terminal → store, board, then it processes for that venue; cloud vs local Terminal API integration. Source: https://docs.adyen.com/platforms/quickstart-guide/terminals

## 9. Unified Commerce linkage (same shopper online + in-store)

- Overview (insights/experiences/engagement across channels): https://docs.adyen.com/unified-commerce
- **Recognition mechanics**: online — match `shopperEmail`, then use stored `shopperReference` + `storedPaymentMethodId` in `/paymentMethods` to show saved cards; in-store — card acquisition request returns the card **`alias`** (and "the `shopperReference` if you have previously stored it on our platform"). Tokens saved from a point-of-sale payment can be used to prefill/friction-free online checkout using `shopperReference` + `recurring.recurringDetailReference`/`storedPaymentMethodId`; email can link multiple aliases/tokens to one shopper. Sources: https://docs.adyen.com/unified-commerce/loyalty-program/recognize-customers , https://docs.adyen.com/online-payments/tokenization , https://docs.adyen.com/online-payments/tokenization/create-tokens
- Note: fetched pages did not state the account-structure precondition for token portability (same company/merchant account) — verify with Adyen during commercial onboarding.

## 10. Gaps / follow-ups (page exists, detail not surfaced in fetched excerpt)

- Exact sweep schedule enums (daily/weekly/monthly/cron) — check Balance Platform Configuration API v2 reference: https://docs.adyen.com/api-explorer/balanceplatform/latest/overview
- Exact store-creation required fields — Management API v3 reference via https://docs.adyen.com/platforms/manage-stores
- Exact LEM v4 endpoint sequence — per-resource pages under https://docs.adyen.com/platforms/onboard-users/onboarding-steps and https://docs.adyen.com/api-explorer/legalentity/latest/overview
- Card-scheme payfac registration thresholds — not stated on the fetched payment-facilitators page; commercial question for Adyen.

## Bottom line for our migration

- **Use the Platform model** (not Marketplace — it lacks in-person; not Classic — legacy; not merchant-account-per-venue — merchant accounts map to *your* legal entities, and Adyen's own page recommends Platform for POS/retail-management ISVs).
- **Best current versions**: LEM **v4**, Balance Platform Configuration **v2**, Transfers **v4**, Management **v3**, Checkout **v72**, hosted onboarding **v4**.
- **Per venue**: legal entity + account holder + balance account + transfer instrument + business line + store; route every payment with `store` + `splits` (or a split configuration profile on the store); take revenue as `Commission` splits; pay out per venue via managed payouts or sweeps.