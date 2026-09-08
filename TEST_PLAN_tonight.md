# What to test — v5.5.974 → v5.5.979

Everything changed across this run, and how to prove each piece works.

**Live on develop:** `1f27944` (974) · `24db301` (975) · `3e5dfb4` (976) · `93aee7a` (977) · `5bdf9ff` (978) · `73b467f` (979)

**Applied to the databases so far:** both scheduler migrations, and `20260805c` (the anon-key fences, both sections).

**Still to apply — two pastes, order matters:**
1. **Ops batch** — `20260806c` Section A + `20260806d`
2. **Platform batch** — `20260806c` Section B + `20260806_PLATFORM_location_rpcs`

Four edge functions are committed but **deliberately not deployed** until those land, because a function deployed before its migration returns 500 on every call.

---

## Part 1 — The one method that covers most of it

Around **50 places** used to say "Saved" without ever checking the database. Each screen gets **two passes**.

**Pass 1 — offline. This is the test that proves the fix.**
1. DevTools → **Network → Offline** (or drop wifi)
2. Do the action
3. **Expect:** a red banner naming what did **not** save, **no** green tick, and any value you changed **snaps back**
4. **Fail =** a green tick, or silence, or the value staying changed on screen

**Pass 2 — online.** Same action. Expect it to save **and survive a hard refresh**.

---

## Part 2 — Money. Do these first.

### Petty cash — it was never reaching the database at all
1. Back Office → **Petty cash** → record a **Float added** and a **Cash drop**
2. **Expect:** they appear in **Reports → Cash drawer** and in the **EOD** pay-ins figure

Previously every manual entry went into an in-memory list and nowhere else — invisible to drawer variance, EOD and the Z report.

> ⚠️ Watch for one specific thing: the Back Office calls a pay-in **"Float"**, but the reports read a different name internally. That mapping was added — so if a Float you record **doesn't** show as opening float in the Cash drawer report, tell me, because that's the bit to check.

### MPOS — a card taken without the sale recorded
1. MPOS, take a **card payment**
2. Kill the network **immediately after approval**
3. **Expect:** a blocking screen saying the payment was taken but the sale isn't recorded, and it retries. **Fail =** it goes to the receipt screen as if nothing happened
4. Then let it retry and confirm **exactly one** sale in Transactions — not two

### Rewards must be deducted
1. Apply a **loyalty reward** and a **promo code**, complete the sale
2. **Expect:** points/stamps deducted, promo code marked used
3. Try the **same code again** — it must be refused

### Refund gives the points back
Refund a sale that used a loyalty reward. **Expect the points returned.**

### Other money screens (offline pass)
Tax rates (default, delete, seed) · Discounts · Cash drawers · Purchase orders (cancel) · Stock items (par level, purchase unit, preferred pack) · Stock counts · Suppliers/Recipes archive

**Three separate old Tax bugs:** seeding on a venue that already has rates must not claim "12 rates added"; setting a new default must never leave **two** defaults; a failed load must **keep** the rates the POS already had.

---

## Part 3 — Kitchen and printing

### Firing a course — this has never worked for some items
1. Put items on a table across **two courses**
2. **Fire course 2**
3. **Expect a docket at the kitchen station**

Affected here: **30 live items** — Coffee 13, Draught 10, Bottles 6, Cider 1. Anything whose production centre is set on a *parent* category. The screen said "fired" and the kitchen was never told.

### Transfer a table
Put sent items on a table, transfer it. **Expect a transfer notice to print.** Also test **combining** into an occupied table.

### Kitchen tickets shouldn't double-print
Normal service. Watch for any ticket printing **twice** — the retry logic couldn't see rejected writes and would resend.

---

## Part 4 — The two that need real hardware

### ⚠️ Cash drawer lock — this can stop a till trading
The sign-in lock has been **absent from the app for months** and is now back.

1. On a till with a drawer **not open**, sign in
2. **Expect:** a lock screen asking for the opening float, **with a Sign out button**
3. Declare a float → till unlocks
4. **Cash up** → drawer goes idle → lock returns → **Sign out works**

**If anything traps you with no way out, tell me immediately** — that's the failure mode I most want to hear about.

### ⚠️ Challenge 21 on a real till
1. Sell enough alcohol to reach the trigger count
2. **Expect the ID prompt** to fire
3. Do an ID check → counter resets

The count is now decided **by the server**, not the till. If a till's pairing has quietly lapsed you'll get a red *"counter NOT recorded"* toast on every alcohol sale — deliberate, but it will look like a new fault.

---

## Part 5 — Back Office screens (offline pass)

**Config:** Print routing · Printers · Floor plan (move/add/delete/resize a table) · Devices · Location settings · Multi-location · Challenge 21 · Menu boards · Print menu · Location switcher

**Menu:** remove a **variant** and a **size** · archive an item · quick screen · item images

**Staff:** add/delete staff · **Rota publish** · Time off approve/decline

> **⚠️ Rota publish, offline.** It must fail visibly and **no SMS or email may reach staff.** It used to message everyone about a rota that hadn't saved.

**Operations:** Maintenance (status, assign, raise, note) · Ops notifications · Temperature schedules · Unpair a tablet

**Customers:** delete a customer offline — it must say it failed. This is the **GDPR** path; it used to vanish the row on screen while leaving the person in the database.

**After the Platform paste:** Menu appearance · Challenge 21 reset · Review card logo

---

## Part 6 — Things that had never worked

- **What's New** — open it. The whole file used to throw, so every release note you've written has been unreadable in the app
- **"Needed today"** prep panel in Batches — a missing import meant it never appeared
- **Pizza tab** — opening it crashed the **entire application** to a red error page. No venue has a pizza product yet, so it had never fired
- **Manager / MPOS / Time Clock** — these three could not display **any** message at all. Try a wrong PIN on the Time Clock; you should now see an error

---

## Part 7 — Scheduled jobs

```sql
select jobname, schedule, active from cron.job order by jobname;
```

Then after a few minutes:

```sql
select j.jobname, d.status, d.return_message, d.start_time
  from cron.job_run_details d join cron.job j using (jobid)
 where d.start_time > now() - interval '30 minutes'
 order by d.start_time desc;
```

**Expect every row `succeeded`.** Confirmed already: `paxpay-sweep` succeeded for the first time after **20,538 consecutive failures**, and the edge-function bridge returned **HTTP 200**.

**Marketing is hourly *checking*, not hourly sending.**

---

## Part 8 — Known and deliberately not fixed

- **Ops escalation reaches nobody** — the only rule targets role **"MOD"**, which no staff member has. The code works; the configuration points at no one
- **Your "Haven't seen you in a while" campaign never fires by itself** — it's a one-off, and the scheduler only picks up automations and scheduled sends
- **Pay-later catering** promos reference an id that exists nowhere, because there's no sale record until payment is taken later
- **`promo-redeem` crash window** — if the function dies mid-call a code can be recorded as used but never consumed. Under-deduction, the safer direction, but it needs the reconciler
- **`payment_devices`** still leaks every terminal's pairing code to the anon key. Migration written (`20260805d`), not applied

---

## How this was verified, and what was not

**Verified:** clean build at every commit · **crash-class lint went from ~70 to 0** repo-wide (that check found two live crashes the build does not catch) · multiple adversarial review rounds, which found **real defects in every single pass** including one worse than the bug it replaced · the schedulers proven live · both new migrations executed against a scratch PostgreSQL 17 before shipping.

**Not verified:** no hands-on clicking. There is no test framework here and local dev runs in mock mode where writes short-circuit. **Part 1's offline pass, and Part 4's two hardware tests, are the real proof and still need doing.**
