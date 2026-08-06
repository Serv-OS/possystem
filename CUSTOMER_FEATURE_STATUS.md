# The twelve features — what is actually built

Checked on 6 Aug 2026 against the **live databases and the deployed code**, not against what the
source claims. Every "built" below was confirmed reachable in the shipped bundle; every table and
column was confirmed to exist. Several things in this codebase have looked built and were not, so
that distinction is the whole point of this document.

---

## Ready now, no development

### 3. Future-dated pay rises ✅
Set a new rate with a start date and it applies automatically overnight, **at position level**, which
is what they asked for.

*Caveat worth knowing:* it has **never been used** — zero rate changes exist. The nightly job runs and
finds nothing every time, so the path is proven to run but has never actually moved anyone's pay.
Worth doing one dated rise before promising it.

### 11. Weekly checks and probe calibration ✅
Weekly checklists exist, the probe type exists, and a temperature reading can sit inside a checklist.
Exactly the ask.

*Caveat:* nothing has been run on the floor since 29 July, so it is built and deployed but unexercised.

### 12. Bank account name ✅
The field is there beside sort code and account number, and it saves. No staff record has one filled
in yet.

### 4a. Their 23rd → 22nd pay period ✅
Any monthly start day from 1 to 28 is supported. **They can set this themselves today.**

---

## Built, but switched off — two minutes, no code

### 1. Breaks ⚙️
This is the one that reads as missing but is not. A **per-venue default break** already exists, with
**auto-deduct at clock-out** and an hours threshold. It has simply **never been switched on at any
venue** — both live venues have it unset.

**To give them what they asked for:** Back Office → Workforce → Workforce settings → Default break
`30`, tick Auto-deduct, threshold `6` hours, Save. Per venue.

**Be honest about the 20 minutes.** Nothing in the system defaults to 20. The "20m" they saw is the
legal minimum badge: UK law requires 20 minutes over a 6-hour shift. **30 is a policy choice, not a
correction.** The code already refuses to auto-deduct below the statutory minimum, so a venue cannot
configure itself into breaking the law.

**Three real gaps if they push:** a staff member who punches a *short* break is not topped up to the
default (it is all-or-nothing); an unconfigured venue gets 0 minutes on manual timesheets but 30 on
rota shifts; and turning the policy on does not touch existing timesheets. ~3–4 hours.

---

## Partly there

### 7. Supplier price alerts — 2 days
Price changes **are** detected and recorded when an invoice is received, and there is a Price Changes
page. **Nobody is ever notified.** The detection works; the telling-someone does not. That is the
entire gap, and it is the part they asked for.

### 10. Delivery checks — 3–5 days
Deliveries exist and can be checked in, **but only against an open purchase order**. You cannot pick a
supplier, so a drop-in or an unexpected delivery cannot be recorded at all, and there are no preset
questions per supplier.

### 4c. Tips inside a custom pay period — 0.5 day to state honestly
With a 23rd→22nd period, the week straddling the boundary is counted whole into one side. Money is
never lost or double-counted, but the tips figure on a payslip will not match the 23–22 window
exactly. **Say this plainly rather than claiming period-exact tips.** Making it exact is 3–4 days.

---

## Not built

### 2. Deductions — 2–3 days
Nothing exists, and the **database actively forbids negative amounts** on pay and tips. That is a
deliberate guard, so this needs a proper adjustments table rather than a negative number squeezed into
an existing field.

**It carries legal weight, and the build has to reflect that:** a wage deduction needs the worker's
prior written authorisation (their contract clause), it must not take anyone below minimum wage, and
it must **never** come out of tips — the Tipping Act requires all tips to reach staff, which this app
already states on screen.

### 4b. "Paid on the last working day" — 1 day
No concept of a working day anywhere: no weekend skip, no bank holidays.

⚠️ **And there is a real bug underneath it.** For a period starting on the 23rd, the pay date resolves
in the **wrong month** — a 23 Jul–22 Aug period would show and store 31 July rather than the end of
August. Worth fixing regardless of whether they ask.

### 5. Attachments on announcements — 1 day
No column, no picker, no display. Straightforward: the document upload used elsewhere can be reused
with the same security fence. Add another half day to also deliver them to staff on the Time Clock.

⚠️ **See the SMS toggle below before demoing this screen.**

### 6. Training Documents grouping — 0.5 day
Documents exist but are one flat list with no grouping. A cosmetic version — grouping the existing
types under "Compliance" and "Training" headings — is half a day and no schema change.

### 8. Barcode scanning for stock counts — 2–3 days
No barcode field on items, no scanner handling in stock. The USB scanner wedge already used for staff
cards is reusable, which is most of the saving.

### 9. Storage locations — 2–3 weeks
The big one. Stock is held as **a single number per item**, so counting per area is not a screen, it
is a change to how stock itself is recorded. **Flag this early** so it does not get promised casually
alongside the small items.

---

## ⚠️ One thing to fix before they see the system again

**The Announcements screen has an SMS toggle that does nothing.** It saves the setting, and no message
is ever sent. A customer who ticks it will believe their team was texted.

This is worse than a missing feature, because it is a promise the screen makes and does not keep.
**Half a day to remove the toggle, 1.5 days to make it actually send.** Either is fine; leaving it is
not.

---

## Summary for the reply

| | Feature | Effort |
|---|---|---|
| ✅ | Future-dated pay rises, weekly checks, bank account name, their 23→22 pay period | none |
| ⚙️ | Breaks | **switch it on** |
| 🟠 | Price alerts | 2 days |
| 🟠 | Delivery checks | 3–5 days |
| 🔴 | Deductions | 2–3 days |
| 🔴 | Pay on last working day | 1 day |
| 🔴 | Announcement attachments | 1 day |
| 🔴 | Training document grouping | 0.5 day |
| 🔴 | Barcode scanning | 2–3 days |
| 🔴 | Storage locations | **2–3 weeks** |

Everything except storage locations totals roughly **two working weeks**. Storage locations on its own
is as large as all the rest combined.
