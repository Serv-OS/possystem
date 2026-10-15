# Adyen rates alignment (15 Oct 2026, v5.11.63, review fixes v5.11.64)

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
| A | each Amex name (amex, amexcorporate, amexprepaid, amex_applepay and so on; `AMEX_VARIANTS`) | ANY | Amex and business cards |
| B | each business variant (commercial, corporate, business, purchasing, fleet, with and without a credit or debit word) | ANY | Amex and business cards |
| C | each consumer debit or prepaid variant (and Maestro) | POS | In person debit, only when priced apart from credit |
| D | the same variants | Ecommerce | Online debit, only when priced apart from online credit |
| E | ANY | Moto | Keyed in |
| F | ANY | Ecommerce | Online |
| G | ANY | ContAuth | Online (a stored card pays the online price on both sides) |
| H | ANY | ANY | In person credit (the catch all) |

Currency GBP (or USD) on every rule. About 67 rules for the UK card (Adyen's limit on rules per profile is not documented; the preview surfaces a refusal in plain words, and the fallback is trimming the unseen names from the lists). Every split logic key other than `commission`, `refund` and `refundCostAllocation` is copied from the catch all rule of the profile the store carries now (`preservedLogicFrom`); anything that is not what ServOS has always written is shown as a warning in the preview before it is carried over.

The variant lists live in `DEBIT_VARIANTS`, `BUSINESS_VARIANTS` and `AMEX_VARIANTS`. The matcher compares the variant alone (never the bare method), so a name no rule names pays the catch all on both sides, which is equal, and the Read panel lists every such name seen in the last 30 days, Amex names included. Whether Adyen reads a rule naming `amex` as the whole family or as one name therefore makes no difference: each name has its own rule.

## The refund rule

`REFUND_FEE_POLICY` is one word in `adyenRules.js`. The default is `none`: `refund` deductFromOneBalanceAccount, `refundCostAllocation` deductFromLiableAccount, `chargeback` deductFromOneBalanceAccount, `chargebackCostAllocation` deductFromLiableAccount. In words: the venue bears the refund, keeps no fee back, and never pays Adyen's own cost of refunding or disputing. It is what every venue's bank has received since go live, it is not a pilot option, and one rule then covers history and future. `ratio` stays behind the constant.

Our side reads the same word from each row (`adyen_payments.fee_refund_policy`, null read as `none`): Back Office Payments, Payouts and payout detail, the statement, and the Xero card fees line all keep the full fee after a refund under `none`.

Note: the null default is a platform wide display change, not only the UK stores the restatement marks. The evidence is one batch of one profile. Before another live profile's rows are left at the default, run the part 4 tie check on one of its batches; if that batch shows fees returned on refunds, set `fee_refund_policy` to `ratio` on that venue's rows in SQL.

## The stamp (`stampForPayment`)

For each payment the webhook works out the facts (`paymentFacts`: currency, variant, funding source if sent, channel), then:

- authorised at or after the venue's `rates_live_at`: the rules entry governing that instant (`adyen_rules`, the rules read back from Adyen with our tier beside each), matched by Adyen's priority (`matchAdyenRule`). `rate_category` is the matched tier, `commission_minor` is `feeFor(amount, commission)` (basis points on the amount, half up, plus the pence), `fee_rule` is `adyen_rules:<profile id>`.
- authorised before `rates_live_at`: the flat charge Adyen took (`legacy_charge`), `fee_rule` `legacy_flat`, policy `none`. This is the restatement's own formula, so a backfill replay agrees with the restatement instead of undoing it. The card type label stays today's classifier's.

`legacy_charge` is filled by the Write only when the previous profile was truly flat (one price on every rule, `legacyChargeFrom`). The 22 Sep profile on the UK stores was tiered (its catch all said 0.9 percent) while the bank took 0.85 percent on every card, so for them the Write leaves it empty and says so, and the figure is set from the bank in part 1 of the restatement file (an explicit overwrite).

A replay never demotes a stamp (`keepExistingStamp`): an unmarked answer (the venue row unreadable) on a row that carries a `fee_rule`, or the legacy answer on a hold captured at or after the cutover, leaves the row as it is. The webhook never caches a failed venue read, and caches a venue not yet cut over for five seconds only, so the window after a Write in which a payment could be stamped the old way is a few seconds; the Read panel counts such rows (missed the cutover) and a webhook backfill of that hour puts them right.
- a venue with no `rates_live_at`: today's behaviour, unchanged, `fee_rule` null.

No rule matched (a USD payment on a GBP venue, a rule we did not send): `commission_minor` null and `fee_rule` ending `:unmatched`. An unrated row is visible; a guessed one is not.

A CAPTURE that moves the amount restamps at the same rule the row carries (`restampForAmount`). A hold captured at or after the cutover is charged by Adyen under the new profile, so the capture instant decides for a row with no rule yet and for a row marked legacy.

## The cutover, in order

1. Read first, write nothing: Admin, Processing, the venue, Card rates, Read what Adyen charges.
2. Run `supabase/migrations/20261015_PLATFORM_adyen_rates_cutover.sql` on the Platform project (five columns, if not exists).
3. Deploy, in this order: adyen-webhook, adyen-terminal-admin, adyen-financial, payments-admin, xero-sales; then the app.
4. Decide the refund rule (the default is `none`).
5. On each UK venue: Preview, read the before and after and the refund line, type LIVE, Write these rates to Adyen. That stamps `rates_live_at` from the server clock the moment the store PATCH succeeds and reads the new profile back onto the row. It fills `legacy_charge` only for a truly flat previous profile; for the UK stores it says the charge must be set from the bank.
6. Run `supabase/data_fixes/20261015_PLATFORM_adyen_rates_restatement.sql`: part 0 reads, part 1 sets the legacy charge from the bank (85 basis points, no fixed fee, for the UK stores; an explicit overwrite), part 0 again to see it, part 2 previews with the basis points about to be applied on each row, part 3 restates pre cutover rows (fee_rule null only, live only, before `rates_live_at` only; the old figures are kept in `raw.restated`), part 4 is the tie check with the rounding residual per batch.
7. Switch on card type data from the third panel (or the Customer Area clicks it shows). The body sent adds to the webhook settings and never replaces them; the answer compares before and after key by key. Include Shopper Interaction matters for keyed in payments (our side infers Moto from the entry mode until Adyen sends its own word); the rest is a cross check.
8. Tomorrow: Read again on one venue, compare the first batch under the new rules with the bank (expect within a few pence of rounding, not to the penny, until Adyen says how it rounds), check the Xero Card fees line.
9. This week, not next: configure the live balance platform webhook to adyen-bp-webhook, so Adyen's own per payment commission lands in our records and the tie check becomes exact rather than a formula.

## Open questions only the owner or Adyen can answer

1. Refunds: `none` (the bank since go live) or `ratio` (what Back Office displayed)? Decided before the first Write.
2. Rounding: per payment half up at 85 basis points was 12p under the bank deduction on the batch checked; only batch gross times 0.85 percent landed exactly. Until Adyen says how it rounds, Payouts tie within pence.
3. What is on the store right now, and who edited it, if the Read panel does not show the 8 rule profile written on 22 Sep.
4. Does a rule with paymentMethod `amex` catch Amex corporate and prepaid variants? It no longer matters: every Amex name has its own rule and our matcher reads the variant alone, so both sides agree whichever way Adyen reads it.
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
