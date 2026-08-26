# Payment Services Reseller Agreement

**ServOS App Inc and FranPOS**

> **DRAFT FOR LEGAL REVIEW.** This draft was prepared to capture the commercial terms agreed by email on 26 August 2026 and the operational mechanics both sides need. It is not legal advice. Have a lawyer qualified in the governing jurisdiction review it before either party signs, in particular the liability, indemnity, termination and data clauses, and check the whole arrangement against Adyen's terms of service, which bind FranPOS directly and both parties indirectly.

Items in [square brackets] are open commercial points to settle before signature.

---

## Parties

This agreement is between:

1. **ServOS App Inc**, a company incorporated in [state/country], whose registered office is at [address] ("ServOS"), and
2. **[FranPOS legal entity name]**, a company incorporated in [state/country], whose registered office is at [address] ("FranPOS").

Each a "party", together the "parties".

## Background

(a) FranPOS holds a platform relationship with Adyen N.V. ("Adyen") under which merchants can be onboarded as sub-merchants and card payments can be acquired and settled.

(b) ServOS operates a point of sale platform for hospitality venues and wishes to offer card processing to its merchants using FranPOS's Adyen platform, with ServOS setting its own pricing to those merchants.

(c) Because processing runs on FranPOS's Adyen account, the full card fee margin settles to FranPOS. FranPOS retains its agreed share and pays the remainder to ServOS. This agreement sets out that arrangement.

## 1. Definitions

**"Buy Rate"** means the amounts FranPOS retains per Transaction under Schedule 1.

**"Interchange" or "IC"** means the interchange fees and card scheme fees set by the card schemes and passed through at cost.

**"Merchant"** means a customer of ServOS onboarded as a sub-merchant on FranPOS's Adyen platform under this agreement.

**"Merchant Rate"** means the fees ServOS charges a Merchant for processing, which ServOS sets in its sole discretion.

**"Residuals"** means, for each Transaction, the Merchant fee margin above Interchange, less the Buy Rate, as calculated under clause 5.

**"Transaction"** means a card payment processed for a Merchant through FranPOS's Adyen platform, including card-present and card-not-present payments.

**"Statement Period"** means a calendar month.

## 2. Appointment and scope

2.1 FranPOS appoints ServOS as a non-exclusive reseller of card processing services on FranPOS's Adyen platform for ServOS's Merchants in the Territory.

2.2 "Territory" means [the United States and the European Union], and any further regions the parties agree in writing. The parties acknowledge that EU onboarding paperwork is in progress at the date of this agreement and that go-live in each region is subject to Adyen's approval.

2.3 ServOS sets its own Merchant Rates and owns its Merchant relationships, including pricing, support and billing for its platform services. FranPOS's relationship with the Merchant is limited to what Adyen requires of the platform of record.

2.4 Nothing in this agreement makes either party the agent, partner or employee of the other.

## 3. Onboarding, KYC and compliance

3.1 Merchants are onboarded as sub-merchants through the processes FranPOS's Adyen platform requires, including know your customer, anti money laundering and sanctions checks. Neither party will board a merchant that fails these checks.

3.2 Each party will comply with the card scheme rules, PCI DSS to the extent applicable to its role, and all laws applicable to its performance. ServOS will not itself store, process or transmit full cardholder data outside of Adyen-provided mechanisms.

3.3 FranPOS will pass through to ServOS any Adyen or scheme requirement that affects Merchants (including mandatory disclosures, prohibited business categories and reserve requirements) promptly on becoming aware of it, and ServOS will implement it with its Merchants.

3.4 If Adyen or a card scheme requires the suspension or termination of a Merchant, FranPOS may do so and will notify ServOS as soon as it lawfully can. FranPOS will not otherwise suspend a Merchant without [5] business days' notice to ServOS except where continuing presents fraud, credit or compliance risk.

## 4. Pricing

4.1 The Buy Rate and the guidance sell range are set out in **Schedule 1**. The Buy Rate can only be changed as set out in clause 4.3.

4.2 ServOS may set any Merchant Rate at or above the Buy Rate. ServOS bears the margin risk on any Transaction priced below the Buy Rate.

4.3 FranPOS may amend the Buy Rate only: (a) to pass through a change imposed by Adyen or the card schemes, on the same notice FranPOS receives, with evidence of the underlying change; or (b) otherwise on not less than [90] days' written notice. A Buy Rate change applies to Transactions processed after the change takes effect, never retrospectively.

4.4 Interchange and scheme fees are pass-through at cost on both sides and are not marked up by FranPOS.

## 5. Residuals, reporting and invoicing

5.1 For each Transaction, the Residual owed by FranPOS to ServOS is:

> (Merchant fee margin charged above Interchange) less (Buy Rate percentage times the Transaction amount, plus the Buy Rate fixed fee)

calculated in the currency of the Transaction, rounded per Transaction using half-up rounding to the smallest currency unit.

5.2 Within [10] days of the end of each Statement Period:

(a) **FranPOS will provide** a transaction-level report for the period covering every Transaction for a Merchant: transaction reference, date, amount, currency, interchange and scheme fees charged, and the total fees withheld; and

(b) **ServOS will issue an invoice** to FranPOS for the Residuals for the period, itemised by Merchant and currency, one invoice per currency, computed from ServOS's transaction ledger.

5.3 FranPOS will pay each invoice within **[14] days** of receipt, in the invoiced currency, by bank transfer to the account ServOS designates in writing.

5.4 **Reconciliation.** If the parties' figures for a period differ by more than [1]%, they will reconcile at transaction level within [10] business days, using Adyen's records as the tie-breaker. The undisputed portion of any invoice is payable on the normal date regardless of an ongoing reconciliation.

5.5 **Late payment.** Overdue amounts bear interest at [the lesser of 1.5% per month and the maximum lawful rate], and ServOS may suspend boarding of new Merchants while any invoice is more than [30] days overdue.

5.6 **Audit.** Not more than [twice] a year, on [10] business days' notice, each party may have an independent accountant verify the other's records relevant to Residuals. If an underpayment above [2]% is found, FranPOS pays the shortfall plus the audit cost.

5.7 All amounts are exclusive of VAT, sales and similar taxes, which are payable additionally where applicable. Each party bears its own income taxes.

## 6. Refunds, chargebacks and losses

6.1 Where a Transaction is refunded, the treatment of its fees and Residual follows the treatment Adyen applies to FranPOS for that refund: to the extent FranPOS's own margin fees are returned or not levied on the refunded Transaction, the corresponding Residual is deducted from the next statement; to the extent they are not, the Residual stands. FranPOS's periodic report will identify refund fee treatment.

6.2 Chargebacks, chargeback fees and fraud losses on a Merchant's Transactions are for the account of that Merchant. As between the parties, where a loss cannot be recovered from the Merchant: [losses sit with ServOS, as the party that priced and boarded the Merchant / to be negotiated]. FranPOS will operate the dispute process made available by Adyen and give ServOS timely access to defend chargebacks.

6.3 Any reserve or holdback Adyen imposes in respect of a Merchant will be passed through to that Merchant and not funded from the other party's money.

## 7. Data and relationships

7.1 ServOS owns its Merchant relationships and its Merchant list. FranPOS processes Merchant and transaction data only to perform this agreement, to meet Adyen and legal obligations, and for its own settlement accounting.

7.2 FranPOS will give ServOS ongoing access to transaction-level data for ServOS's Merchants sufficient to operate support, reporting and the invoicing in clause 5, by [API access or scheduled report].

7.3 **Non-solicitation.** During this agreement and for [24] months after it ends, FranPOS will not use its position as platform of record, or data obtained under this agreement, to solicit ServOS's Merchants for any competing point of sale or payment service. The same restriction applies to ServOS in respect of merchants FranPOS boards outside this agreement and which become known to ServOS through this agreement.

7.4 Each party complies with applicable data protection law in respect of personal data it processes under this agreement, and the parties will put in place any data processing terms a party reasonably requires to evidence that.

## 8. Term and termination

8.1 This agreement runs from the date both parties sign it, for an initial term of [24] months, then continues until either party ends it on [180] days' written notice.

8.2 Either party may terminate immediately on written notice if the other: (a) commits a material breach not cured within [30] days of notice; (b) becomes insolvent; or (c) loses a licence, registration or platform relationship necessary to perform (including FranPOS's Adyen platform relationship).

8.3 **Effects of termination.** On any termination or expiry:

(a) **Residual tail.** FranPOS pays Residuals on all Transactions processed up to the date each Merchant is migrated off the platform, on the normal statement cycle. Termination does not cut off Residuals already earned.

(b) **Migration.** FranPOS will cooperate in good faith, for up to [180] days, with the orderly migration of Merchants to an alternative acquirer or platform of ServOS's choosing, including executing consents and providing data reasonably needed, at no charge beyond direct pass-through costs. Merchants are not FranPOS's to retain.

(c) Clauses 5 (for the tail period), 6, 7, 9, 10 and 11 survive termination.

## 9. Liability

9.1 Nothing in this agreement excludes liability for fraud, or for anything that cannot lawfully be excluded.

9.2 Neither party is liable for loss of profits, revenue or goodwill, or for indirect or consequential loss, except that unpaid Residuals, unpaid invoices and amounts due under the indemnities are direct debts, not excluded loss.

9.3 Each party's aggregate liability in any 12 month period is capped at [the greater of the Residuals paid or payable in that period and USD [50,000]], except for: unpaid Residuals; breach of clause 7 (data and non-solicitation); confidentiality; and the indemnities, which are [uncapped / capped at a higher figure to be agreed].

9.4 Each party indemnifies the other against third party claims arising from its breach of scheme rules, data protection law or its obligations to Adyen.

## 10. Confidentiality

Each party keeps the other's non-public business information confidential, uses it only for this agreement, and discloses it only to those who need it and are bound to equivalent confidence, or where law or a regulator requires. The Buy Rate and the terms of this agreement are confidential.

## 11. General

11.1 **Notices** in writing to the addresses above, by hand, courier or email [addresses], effective on delivery.

11.2 **Assignment** only with the other party's written consent, not to be unreasonably withheld, except to an affiliate or in a sale of substantially the whole business, on notice.

11.3 **Entire agreement.** This agreement and its schedules are the whole agreement on their subject and supersede prior discussions, including the email exchange of 26 August 2026, which is captured in Schedule 1.

11.4 **Variation** only in writing signed by both parties.

11.5 **Governing law and forum:** [the State of Delaware, USA / to be agreed], and the courts of that jurisdiction.

---

## Schedule 1: Pricing

As agreed by email on 26 August 2026.

| Item | Rate |
|---|---|
| Buy Rate payable to FranPOS | Interchange + **0.10%** + **5** minor currency units per Transaction |
| ServOS guidance sell range | Interchange + **0.45% to 0.60%** + **6** minor currency units per Transaction |
| Card-not-present | Same rates; Interchange itself is higher for card-not-present, and passes through at cost |

Notes:

(a) "Minor currency units" means cents for USD and EUR and pence for GBP, applied in the currency of the Transaction.

(b) The guidance sell range does not limit ServOS's Merchant Rates (clause 4.2). ServOS may price above or below it and bears the consequence either way.

(c) Interchange and scheme fees pass through at cost with no FranPOS markup (clause 4.4).

## Schedule 2: Settlement mechanics

(a) Statement Period: calendar month.

(b) ServOS invoices from its transaction ledger, one invoice per currency per period, numbered FP-YYYY-MM-CCY (for example FP-2026-08-GBP), itemised per Merchant with transaction count, volume, gross margin, Buy Rate share and net Residual.

(c) FranPOS's monthly report per clause 5.2(a) is delivered to [email/SFTP/API] by day [10] of the following month.

(d) Payment per clause 5.3 to: [ServOS bank details], reference the invoice number.

(e) First Statement Period: the calendar month in which the first live Transaction is processed.

## Schedule 3: Territory and go-live

(a) European Union: onboarding paperwork in progress at signature; go-live on Adyen approval.

(b) United States: [status/date].

(c) Each region goes live only when Adyen has approved the arrangement for that region and both parties have confirmed in writing.

---

**Signed for ServOS App Inc**

Name: ............................. Title: ............................. Date: .............................

**Signed for [FranPOS legal entity]**

Name: ............................. Title: ............................. Date: .............................
