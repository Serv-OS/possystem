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

**"Buy Rate"** means the amounts FranPOS retains per Transaction under Schedule 1. The Buy Rate comprises Interchange passed through at cost plus the Buy Rate Margin. Only the Buy Rate Margin is deducted in the Residual calculation under clause 5.1.

**"Buy Rate Margin"** means the components of the Buy Rate other than Interchange, being at the date of this agreement 0.10% of the Transaction amount plus 5 minor currency units per Transaction, as set out in Schedule 1 and as changed only under clause 4.3.

**"Interchange" or "IC"** means the interchange fees and the per transaction card scheme fees actually assessed by the card schemes on the relevant Transaction, as identified in Adyen's transaction level reporting, passed through at cost. Interchange excludes Adyen processing, platform or account fees, periodic, fixed or account level scheme charges, fines, penalties, and any FranPOS cost or internal allocation.

**"Merchant"** means a customer of ServOS onboarded as a sub-merchant on FranPOS's Adyen platform under this agreement.

**"Merchant Rate"** means the fees ServOS charges a Merchant for processing, which ServOS sets in its sole discretion.

**"Residuals"** means, for each Transaction, the amount owed by FranPOS to ServOS calculated under clause 5.1.

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

3.5 **Platform standing and notice.** FranPOS will keep its Adyen platform relationship in good standing and will not knowingly commit any act or omission that gives Adyen a right to suspend or terminate it. FranPOS will notify ServOS within [2] business days of receiving any notice from Adyen of breach, suspension, remediation requirement, material restriction or termination affecting the platform, or of becoming aware of any fact that makes any of these reasonably likely.

3.6 **Boarding, rate implementation and service levels.**

(a) FranPOS will submit each Merchant ServOS refers for onboarding within [2] business days of receiving a complete application and will use commercially reasonable efforts to complete boarding within [5] business days, subject to Adyen's own checks and timings. FranPOS will not decline or delay a Merchant that passes the checks in clause 3.1, except a merchant in a category prohibited under clause 3.3 or in a region not yet live under Schedule 3. Neither party commits to any minimum or maximum number of Merchants or volume of Transactions.

(b) FranPOS will implement on the platform the Merchant Rates ServOS instructs, and any change ServOS instructs, within [2] business days of the instruction, and will correct any misconfiguration within [2] business days of either party identifying it. If a Merchant is charged less than the instructed Merchant Rate, Residuals for the affected period are calculated as if the instructed rate had been applied and FranPOS bears the difference. If a Merchant is charged more than the instructed Merchant Rate, FranPOS funds the refund of the excess to the Merchant and Residuals for the affected period are calculated on the instructed rate.

(c) FranPOS will provide second line support to ServOS for platform, boarding, settlement and dispute queries: acknowledgement within [4] business hours, and resolution or a substantive escalation to Adyen within [1] business day for settlement affecting issues and [3] business days otherwise. FranPOS will maintain a named escalation contact and keep it current.

(d) Failure to deliver the report under clause 5.2(a), or an outage of the data access under clause 7.2 lasting more than [3] business days, does not delay or reduce any payment. ServOS's invoice computed from its transaction ledger under clause 5.2(b) remains payable in full on the normal date, and FranPOS may not initiate a reconciliation under clause 5.4 for that period until it has delivered the missing report or restored the access. FranPOS will restore the data access as a priority.

3.7 **Merchant terms.** ServOS will include in its agreement with each Merchant, in substance, the terms set out in Schedule 4. FranPOS may propose updates to Schedule 4 only where Adyen or the card schemes require them, with evidence of the underlying requirement, and ServOS will roll the updates out to Merchants within a commercially reasonable period, not exceeding any deadline Adyen or the scheme imposes. ServOS is not obliged to adopt wording beyond what Adyen or the card schemes actually require.

## 4. Pricing

4.1 The Buy Rate and the guidance sell range are set out in **Schedule 1**. The Buy Rate can only be changed as set out in clause 4.3.

4.2 ServOS may set any Merchant Rate at or above the Buy Rate. ServOS bears the margin risk on any Transaction priced below the Buy Rate.

4.3 FranPOS may amend the Buy Rate only: (a) to pass through a change imposed by Adyen or the card schemes, on the same notice FranPOS receives, with evidence of the underlying change; or (b) otherwise on not less than [90] days' written notice. A Buy Rate change applies to Transactions processed after the change takes effect, never retrospectively.

4.4 Interchange and scheme fees are pass-through at cost on both sides and are not marked up by FranPOS.

4.5 FranPOS will configure each Merchant's pricing on the Adyen platform at the Merchant Rate ServOS notifies in writing, and will implement each notified rate or rate change within [5] business days of the notice. FranPOS will maintain that configuration until ServOS notifies a change, and will collect Merchant fees at that rate through the platform. If Transactions are charged below the notified Merchant Rate, other than at ServOS's written direction or where a lower rate is required by Adyen, the card schemes or applicable law, the Residual on those Transactions is calculated under clause 5.1 as if the notified Merchant Rate had been charged. FranPOS's report under clause 5.2(a) will state the rate actually applied to each Transaction.

## 5. Residuals, reporting and invoicing

5.1 For each Transaction, the Residual owed by FranPOS to ServOS is:

> (Merchant Fees less Actual Interchange) less the Buy Rate Margin

"Merchant Fees" means the processing fees payable by the Merchant for that Transaction at the Merchant Rate. "Actual Interchange" means the interchange fees and card scheme fees actually assessed on that Transaction, as reported in Adyen transaction level data. Actual Interchange is deducted once and only once in this calculation, and no part of it forms part of the Buy Rate Margin. The Residual is calculated in the currency of the Transaction and rounded per Transaction using half-up rounding to the smallest currency unit.

5.2 Within [10] days of the end of each Statement Period:

(a) **FranPOS will provide** a transaction-level report for the period covering every Transaction for a Merchant: transaction reference, date, amount, currency, interchange and scheme fees as assessed on that Transaction in Adyen's transaction level reporting, and the total fees withheld; and

(b) **ServOS will issue an invoice** to FranPOS for the Residuals for the period, itemised by Merchant and currency, one invoice per currency, computed from ServOS's transaction ledger.

5.3 FranPOS will pay each invoice within **[14] days** of receipt, in the invoiced currency, by bank transfer to the account ServOS designates in writing.

5.4 **Reconciliation.** If the parties' figures for a period differ by more than [1]%, they will reconcile at transaction level within [10] business days, using Adyen's records as the tie-breaker. The undisputed portion of any invoice is payable on the normal date regardless of an ongoing reconciliation. An amount is disputed for the purposes of this clause only to the extent FranPOS has, on or before the due date for payment, notified ServOS in writing of the specific Transactions and amounts disputed and the reasons for the dispute.

5.5 **Late payment.** Overdue amounts bear interest at [the lesser of 1.5% per month and the maximum lawful rate], and ServOS may suspend boarding of new Merchants while any invoice is more than [30] days overdue.

5.6 **Audit.** Not more than [twice] a year, on [10] business days' notice, each party may have an independent accountant verify the other's records relevant to Residuals. If an underpayment above [2]% is found, FranPOS pays the shortfall plus the audit cost.

5.7 All amounts are exclusive of VAT, sales and similar taxes, which are payable additionally where applicable. Each party bears its own income taxes.

5.8 **No set-off.** FranPOS pays all amounts due to ServOS under this agreement in full, without set-off, counterclaim, deduction or withholding of any kind, except: (a) refund adjustments identified in the periodic report under clause 6.1; (b) amounts ServOS has agreed in writing may be deducted; (c) amounts finally determined as owing from ServOS to FranPOS under the reconciliation in clause 5.4, the audit in clause 5.6, or a final non-appealable judgment of a court of competent jurisdiction; and (d) any deduction or withholding required by law, in which case FranPOS deducts only the minimum required, pays it to the relevant authority when due, and promptly gives ServOS evidence of payment and reasonable cooperation to reduce or reclaim it. Any other claim FranPOS has against ServOS, including under clause 6.2 or clause 9.4, must be invoiced separately with supporting detail and pursued as an ordinary debt, not netted against Residuals. No reserve or holdback Adyen imposes on FranPOS, whether at platform level or otherwise, may be funded from Residuals or from any other amount due to ServOS.

5.9 **Protection of accrued Residuals.**

(a) Residuals accrue to ServOS Transaction by Transaction as each Transaction is processed. From the moment the corresponding margin settles to FranPOS, FranPOS holds the Residual portion for ServOS on trust, as ServOS's property and not as part of FranPOS's general funds.

(b) FranPOS will pay accrued but unpaid Residuals into a segregated bank account used only for reseller residuals, funding it at least [weekly] from settlement receipts, and will not use the balance as working capital or grant any third party rights over it.

(c) At signature, FranPOS grants ServOS a security interest over the segregated account and over all accrued but unpaid Residuals as security for FranPOS's payment obligations under this clause 5, and will promptly execute the filings and control agreements needed to perfect it, including a UCC-1 financing statement where the governing law makes that the route to perfection.

(d) The parties will use reasonable efforts to have the Residual portion paid to ServOS directly by split settlement from the platform where Adyen's facilities allow it. ServOS may require implementation at any time, and FranPOS will execute whatever instructions Adyen requires to give effect to it.

(e) If a Credit Event occurs: all accrued Residuals become immediately due and payable without notice, the payment term in clause 5.3 becomes [3] business days for all later periods, including the tail periods under clause 8.3(a) notwithstanding its reference to the normal statement cycle, and split settlement under clause 5.9(d) becomes mandatory to the extent Adyen permits it.

(f) "Credit Event" means any of the following: FranPOS becomes insolvent or enters any insolvency, administration, receivership or comparable process, a creditor levies execution over a material part of FranPOS's assets, FranPOS fails to pay two consecutive invoices when due, or FranPOS ceases or threatens to cease to carry on business.

## 6. Refunds, chargebacks, losses and settlement

6.1 Where a Transaction is refunded in whole or in part, the Residual for that Transaction is reduced only if, and only to the extent that, the fees charged to the Merchant on the refunded amount are actually returned to the Merchant or not levied. Any such reduction is shared between the parties in the same proportion as the original split of the margin above Interchange between the Buy Rate and the Residual. To the extent fees charged to the Merchant are retained on a refunded Transaction, the Residual stands. FranPOS's report under clause 5.2(a) will identify, for each refund, the fees returned, the fees retained and the resulting Residual adjustment, and ServOS may verify these figures against Adyen's records under clause 5.4.

6.2 Chargebacks, chargeback fees and fraud losses on a Merchant's Transactions are for the account of that Merchant. As between the parties, where a chargeback loss cannot be recovered from the Merchant after FranPOS has first applied any reserve, holdback or pending settlement held for that Merchant and has made commercially reasonable efforts to recover from the Merchant, the chargeback amount and the scheme chargeback fee are borne by ServOS, except to the extent the loss results from FranPOS failing to operate the dispute process, missing a scheme deadline, failing to give ServOS timely access to defend the chargeback, or suspending or terminating the Merchant before recovery other than as required under clause 3.4. Scheme fines and any loss arising from FranPOS's own acts or omissions are for FranPOS's account. No other category of loss passes to ServOS unless the parties agree it in writing. The Residual attributable to a charged back Transaction may be reversed on the next statement in the same way as clause 6.1. All other amounts payable by ServOS under this clause are invoiced by FranPOS separately with transaction level support, are payable on [30] days' terms, are not set off against Residuals, and are subject to clause 9.3. FranPOS will operate the dispute process made available by Adyen and give ServOS timely access to defend chargebacks.

6.3 Any reserve or holdback Adyen imposes in respect of a Merchant will be passed through to that Merchant and not funded from the other party's money.

6.4 **Merchant settlement.** Merchant settlement funds flow from Adyen to Merchants under Adyen's payout arrangements. FranPOS will not route, hold or commingle Merchant settlement funds through its own accounts except where Adyen's platform design requires it, and in that case will hold them separately from its own funds and pass them on promptly, without deduction beyond the Merchant Rate and any amounts Adyen itself deducts. FranPOS will notify ServOS within [1] business day of becoming aware of any payout delay, hold or reserve affecting a Merchant, with the reason where known and updates as they arise, and will escalate to Adyen promptly on ServOS's request. As between the parties, ServOS owns Merchant facing communication about settlement, except where Adyen, a card scheme or law requires FranPOS to communicate directly, in which case FranPOS will inform ServOS in advance where lawfully able.

## 7. Data and relationships

7.1 ServOS owns its Merchant relationships and its Merchant list. FranPOS processes Merchant and transaction data only to perform this agreement, to meet Adyen and legal obligations, and for its own settlement accounting.

7.2 FranPOS will give ServOS ongoing access to transaction-level data for ServOS's Merchants sufficient to operate support, reporting and the invoicing in clause 5, by [API access or scheduled report]. The report or API extract will be in a commonly readable, portable format and ServOS may retain copies. On request, not more than once per Statement Period, FranPOS will also provide the sub-merchant onboarding records for ServOS's Merchants that ServOS would reasonably need to board those Merchants with an alternative acquirer, subject to applicable data protection law and Adyen's terms.

7.3 **Non-solicitation.** During this agreement and for [24] months after it ends, FranPOS will not use its position as platform of record, or data obtained under this agreement, to solicit ServOS's Merchants for any competing point of sale or payment service. The same restriction applies to ServOS in respect of merchants FranPOS boards outside this agreement and which become known to ServOS through this agreement.

7.4 Each party complies with applicable data protection law in respect of personal data it processes under this agreement, and the parties will put in place any data processing terms a party reasonably requires to evidence that.

## 8. Term and termination

8.1 This agreement runs from the date both parties sign it, for an initial term of [24] months, then continues until either party ends it on [180] days' written notice.

8.2 Either party may terminate immediately on written notice if the other: (a) commits a material breach not cured within [30] days of notice; (b) becomes insolvent; or (c) loses a licence, registration or platform relationship necessary to perform (including FranPOS's Adyen platform relationship).

8.3 **Effects of termination.** On any termination or expiry:

(a) **Residual tail.** FranPOS pays Residuals on all Transactions processed up to the date each Merchant is migrated off the platform, on the normal statement cycle. Termination does not cut off Residuals already earned.

(b) **Migration.** FranPOS will cooperate in good faith, for up to [180] days, with the orderly migration of Merchants to an alternative acquirer or platform of ServOS's choosing, including executing consents and providing data reasonably needed, at no charge beyond direct pass-through costs. Merchants are not FranPOS's to retain.

(c) Clauses 4.5 (for the tail period), 5 (for the tail period), 6, 7, 8.4, 9, 10 and 11 survive termination.

8.4 **Platform loss and merchant continuity.** If Adyen suspends or terminates FranPOS's platform relationship, or gives notice of either:

(a) FranPOS will notify ServOS immediately and the migration obligations in clause 8.3(b) apply at once, on an expedited basis, without waiting for termination of this agreement;

(b) FranPOS will use best efforts to secure from Adyen a wind down period during which Merchants can continue processing, and will not agree any wind down plan affecting Merchants without consulting ServOS;

(c) Residuals remain payable on all Transactions processed up to the last day of processing. If FranPOS receives from Adyen any termination payment, residual buyout or similar amount attributable in whole or in part to Merchants' Transactions, FranPOS will pay ServOS the share of that amount corresponding to the proportion that Residuals paid or payable to ServOS bore to the total margin on Merchants' Transactions (Buy Rate Margin plus Residuals) over the [12] months before the trigger event, or the whole term of this agreement if shorter;

(d) within [2] business days of the trigger event, FranPOS will deliver to ServOS a complete extract of the onboarding records and transaction-level data for ServOS's Merchants, in a portable format, so that ServOS can board Merchants with an alternative acquirer without further cooperation from FranPOS if FranPOS is unable to provide it.

## 9. Liability

9.1 Nothing in this agreement excludes liability for fraud, or for anything that cannot lawfully be excluded.

9.2 Neither party is liable for loss of profits, revenue or goodwill, or for indirect or consequential loss, except that unpaid Residuals, unpaid invoices and amounts due under the indemnities are direct debts, not excluded loss.

9.3 Each party's aggregate liability in any 12 month period is capped at [the greater of the Residuals paid or payable in that period and USD [50,000]], except for: unpaid Residuals; breach of clause 7 (data and non-solicitation); confidentiality; and the indemnities, which are [uncapped / capped at a higher figure to be agreed].

9.4 Each party indemnifies the other against third party claims arising from its breach of scheme rules, data protection law or its obligations to Adyen.

## 10. Confidentiality

Each party keeps the other's non-public business information confidential, uses it only for this agreement, and discloses it only to those who need it and are bound to equivalent confidence, or where law or a regulator requires. The Buy Rate and the terms of this agreement are confidential.

## 11. General

11.1 **Notices** in writing to the addresses above, by hand, courier or email [addresses], effective on delivery.

11.2 **Assignment and change of control.**

(a) Neither party may assign this agreement without the other party's prior written consent, not to be unreasonably withheld, except that either party may assign it on written notice to an affiliate, or in a sale of substantially the whole of its business to a buyer that is not a competitor of the other party, provided in each case that the assignee first agrees in writing with the other party to be bound by this agreement.

(b) A "change of control" of a party occurs when a person or group of connected persons that does not control it at the date of this agreement acquires, directly or indirectly, more than 50% of its voting shares or the power to direct its management and policies. A "competitor of ServOS" means a person materially engaged in point of sale software or merchant payment services.

(c) FranPOS will notify ServOS in writing within [10] business days of any change of control of FranPOS and of any assignment of this agreement by FranPOS.

(d) If FranPOS undergoes a change of control, or assigns this agreement, and the new controller or assignee is a competitor of ServOS, ServOS may terminate this agreement on [60] days' written notice, given within [90] days of ServOS learning of the event, without penalty and whether or not the initial term has expired.

(e) On any assignment by FranPOS or change of control of FranPOS, and whether or not ServOS terminates, FranPOS will procure that the assignee or new controller and its group honour this agreement, including clauses 4 (pricing), 5 (residuals, reporting and invoicing), 7 (data and relationships, including non-solicitation) and 10 (confidentiality), and use Merchant and transaction data obtained under this agreement only as this agreement permits.

(f) If ServOS terminates under this clause 11.2, clause 8.3 applies and the migration period in clause 8.3(b) extends to [270] days.

11.3 **Entire agreement.** This agreement and its schedules are the whole agreement on their subject and supersede prior discussions, including the email exchange of 26 August 2026, which is captured in Schedule 1.

11.4 **Variation** only in writing signed by both parties.

11.5 **Governing law and forum:** [the State of Delaware, USA / to be agreed], and the courts of that jurisdiction.

11.6 **Escalation and continuity.** Before starting court proceedings, other than for urgent injunctive relief or to recover undisputed sums, the parties will escalate any dispute as follows: first to a senior executive of each party, who will meet within [10] business days of a written escalation notice, and then, if the dispute remains unresolved [20] business days after that meeting, to mediation under [the AAA commercial mediation rules / the CEDR Model Mediation Procedure, to match the governing law chosen in clause 11.5]. While any dispute is ongoing, and unless this agreement has been validly terminated under clause 8, each party will continue to perform its obligations, including payment of undisputed amounts, boarding of Merchants (subject always to clause 3.4), provision of the reports in clause 5.2(a) and the data access in clause 7.2. Nothing in this clause limits either party's termination rights under clause 8 or any suspension required by Adyen or the card schemes.

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

## Schedule 4: Required Merchant terms

Each agreement between ServOS and a Merchant must contain, in substance:

(a) acceptance of the sub merchant terms Adyen requires, including Adyen's prohibited and restricted business categories;

(b) the Merchant's consent to know your customer, anti money laundering and sanctions checks, and to the sharing of the data needed for those checks with FranPOS and Adyen;

(c) ServOS's right to suspend or terminate processing for the Merchant where Adyen or a card scheme requires it, including where clause 3.4 of this agreement is invoked;

(d) the Merchant's liability to ServOS for chargebacks, chargeback fees, fines, penalties and reserves arising from its own Transactions, and ServOS's right to recover those amounts, including by set off against sums otherwise due to the Merchant;

(e) the pass-through of any reserve or holdback Adyen imposes in respect of the Merchant, consistent with clause 6.3;

(f) the mandatory disclosures the card schemes require, including receipt requirements; and

(g) the PCI DSS obligations applicable to the Merchant's card acceptance environment.

---

**Signed for ServOS App Inc**

Name: ............................. Title: ............................. Date: .............................

**Signed for [FranPOS legal entity]**

Name: ............................. Title: ............................. Date: .............................
