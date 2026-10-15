# Adyen rates alignment (15 Oct 2026, v5.11.63)

One rule module builds the split profile Adyen is sent and stamps our ledger from the rules read back from Adyen, so what the venue's bank receives and what Back Office shows are the same number.

## What was wrong

Adyen charges a venue from the split configuration profile on its store. Our ledger stamps `adyen_payments.commission_minor` at authorisation. The two were built apart and drifted three ways:

1. The ledger stamped every in person card at the credit price. Adyen's standard webhook sends `fundingSource` on almost no live payment (the setting Include Funding Source is off), while `paymentMethodVariant` (for example `visastandarddebit`) is on nearly every one.
2. The ledger stamped Visa and Mastercard commercial, corporate and fleet cards at the Amex tier. No Adyen rule did.
3. The ledger gave the venue its fee back in proportion on a refund. Adyen gave nothing back.

On the batch the owner checked the bank deduction was exactly 0.85 percent of the batch gross, with nothing back on refunds.

Owner's decision: the rates are the rates. Adyen must charge the rate card exactly, our stamp must equal what Adyen charges, and the history must tie to the bank.

## Adyen facts used (docs.adyen.com, Management API v3, read 15 Oct 2026)

Units. On `splitLogic.commission`: "a fixed amount (specified in minor units), a percentage (specified in basis points), or both." So 0.9 percent is `variablePercentage` 90; 1.1 percent plus 10p is 110 and `fixedAmount` 10. The commission block is marked required.

Conditions. `currency` (an ISO code, never ANY), `paymentMethod` ("a payment method variant, or ANY"), `fundingSource` (credit, debit, prepaid, deferred_debit, charged, ANY), `shopperInteraction` (Ecommerce, ContAuth, Moto, POS, ANY), `cardUsageType` and `cardRegion` (optional; card usage type "is in pilot phase").

Priority. "The priority of rules is:" currency, payment method or payment method variant, card usage type, card region, funding source, shopper interaction. "Within each priority, a rule that is more granular (more specific) takes precedence over a general rule." "We recommend that you always include a catch-all rule."

Refunds. `refund` is one of deductFromOneBalanceAccount ("Book the full refund or chargeback amount to your user's balance account."), deductFromLiableAccount, deductAccordingToSplitRatio ("according to the split ratio of the captured payment", "not supported for refunds and chargebacks of partial captures", pilot). A profile updated after authorisation but before capture applies to the capture; "the updated profile applies to refunds or chargebacks booked after the update."

Update mechanics. PATCH on a profile changes its description only; rules change one at a time. We keep the atomic approach: POST a new profile, PATCH the store to it, leave the old profile in place.

## The rules written (`rulesFromRateCard`)

Built from the rate card on facts both sides can see: the payment method variant and the shopper interaction. No rule names a funding source or a card usage type.

| Rule | paymentMethod | shopperInteraction | Price |
| --- | --- | --- | --- |
| A | amex | ANY | Amex and business cards |
| B | each business variant (commercial, corporate, business, purchasing, fleet) | ANY | Amex and business cards |
| C | each consumer debit or prepaid variant (and Maestro) | POS | In person debit, only when priced apart from credit |
| D | the same variants | Ecommerce | Online debit, only when priced apart from online credit |
| E | ANY | Moto | Keyed in |
| F | ANY | Ecommerce | Online |
| G | ANY | ContAuth | Online (a stored card pays the online price on both sides) |
| H | ANY | ANY | In person credit (the catch all) |

Currency GBP (or USD) on every rule. About 42 rules for the UK card. Every split logic key other than `commission`, `refund` and `refundCostAllocation` is copied from the catch all rule of the profile the store carries now (`preservedLogicFrom`); anything that is not what ServOS has always written is shown as a warning in the preview before it is carried over.

The variant lists live in `DEBIT_VARIANTS` and `BUSINESS_VARIANTS`. A variant no rule names pays the catch all on both sides, which is equal, and the Read panel lists such names seen in the last 30 days.

## The refund rule

`REFUND_FEE_POLICY` is one word in `adyenRules.js`. The default is `none`: `refund` deductFromOneBalanceAccount, `refundCostAllocation` deductFromLiableAccount, `chargeback` deductFromOneBalanceAccount, `chargebackCostAllocation` deductFromLiableAccount. In words: the venue bears the refund, keeps no fee back, and never pays Adyen's own cost of refunding or disputing. It is what every venue's bank has received since go live, it is not a pilot option, and one rule then covers history and future. `ratio` stays behind the constant.

Our side reads the same word from each row (`adyen_payments.fee_refund_policy`, null read as `none`): Back Office Payments, Payouts and payout detail, the statement, and the Xero card fees line all keep the full fee after a refund under `none`.

## The stamp (`stampForPayment`)

For each payment the webhook works out the facts (`paymentFacts`: currency, variant, funding source if sent, channel), then:

- authorised at or after the venue's `rates_live_at`: the rules entry governing that instant (`adyen_rules`, the rules read back from Adyen with our tier beside each), matched by Adyen's priority (`matchAdyenRule`). `rate_category` is the matched tier, `commission_minor` is `feeFor(amount, commission)` (basis points on the amount, half up, plus the pence), `fee_rule` is `adyen_rules:<profile id>`.
- authorised before `rates_live_at`: the flat charge Adyen took (`legacy_charge`), `fee_rule` `legacy_flat`, policy `none`. This is the restatement's own formula, so a backfill replay agrees with the restatement instead of undoing it. The card type label stays today's classifier's.
- a venue with no `rates_live_at`: today's behaviour, unchanged, `fee_rule` null.

No rule matched (a USD payment on a GBP venue, a rule we did not send): `commission_minor` null and `fee_rule` ending `:unmatched`. An unrated row is visible; a guessed one is not.

A CAPTURE that moves the amount restamps at the same rule the row carries (`restampForAmount`). A hold captured after the cutover is charged by Adyen under the new profile, so the capture instant decides for a row with no rule yet.

## The cutover, in order

1. Read first, write nothing: Admin, Processing, the venue, Card rates, Read what Adyen charges.
2. Run `supabase/migrations/20261015_PLATFORM_adyen_rates_cutover.sql` on the Platform project (five columns, if not exists).
3. Deploy, in this order: adyen-webhook, adyen-terminal-admin, adyen-financial, payments-admin, xero-sales; then the app.
4. Decide the refund rule (the default is `none`).
5. On each UK venue: Preview, read the before and after and the refund line, type LIVE, Write these rates to Adyen. That stamps `rates_live_at` from the server clock the moment the store PATCH succeeds, reads the new profile back onto the row, and fills `legacy_charge` from the previous profile's catch all.
6. Run `supabase/data_fixes/20261015_PLATFORM_adyen_rates_restatement.sql`: part 0 reads, part 1 (commented) fills any missing legacy charge, part 2 previews, part 3 restates pre cutover rows (fee_rule null only, live only, before `rates_live_at` only; the old figures are kept in `raw.restated`), part 4 is the tie check.
7. Switch on card type data from the third panel (or the Customer Area clicks it shows). A cross check, not a dependency.
8. Tomorrow: Read again on one venue, compare the first batch under the new rules with the bank, check the Xero Card fees line.

## Open questions only the owner or Adyen can answer

1. Refunds: `none` (the bank since go live) or `ratio` (what Back Office displayed)? Decided before the first Write.
2. Rounding: per payment half up at 85 basis points was 12p under the bank deduction on the batch checked; only batch gross times 0.85 percent landed exactly. Until Adyen says how it rounds, Payouts tie within pence.
3. What is on the store right now, and who edited it, if the Read panel does not show the 8 rule profile written on 22 Sep.
4. Does a rule with paymentMethod `amex` catch Amex corporate and prepaid variants? Same price either way; our matcher treats an Amex variant as matching the `amex` rule.
5. The demo venue's legacy charge (0.8 percent plus 5p; 15 live payments): restate or leave out.
6. The Management API property keys for Include Funding Source are not documented; the Read step shows what Adyen returns.
7. Stored card bookings pay the online price on both sides (this design) rather than the in person catch all (what Adyen did).
8. The live balance platform webhook to adyen-bp-webhook, so Adyen's own per payment commission lands in our records and the tie check becomes exact.

## Files

- `supabase/functions/_shared/adyenRules.js` and `src/lib/payments/adyenRules.js` (byte identical; the test proves it)
- `src/lib/payments/adyenRules.test.js`, `webhookStamp.test.js`, `restatement.test.js`
- `supabase/functions/_shared/adyenLink.ts` and `src/lib/payments/adyenLink.js`: `profileTiers` reads variant rules; `ratesOnAdyen` accepts both profile shapes; `ratesChangePreview` takes the rules that would be written
- `supabase/functions/_shared/venueFees.ts` and `src/lib/payments/venueFees.js`: the refund rule per row
- `supabase/functions/_shared/xeroCardFees.ts`: reads the policy column, retries without it
- `supabase/functions/adyen-webhook/index.ts`, `adyen-terminal-admin/index.ts` (read_split, webhook_settings, the extended preview and send), `adyen-financial/index.ts`, `payments-admin/index.ts`
- `src/admin/components/AdyenRatesPanel.jsx` (the three panels), `AdminBillingManager.jsx`, `AdyenGoLiveFlow.jsx`, `RateCardRows` note in `rateCard.js`, `AdyenPayments.jsx` tooltip
- `supabase/migrations/20261015_PLATFORM_adyen_rates_cutover.sql`, `supabase/data_fixes/20261015_PLATFORM_adyen_rates_restatement.sql`
