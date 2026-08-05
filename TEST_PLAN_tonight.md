# What to test — v5.5.974 → v5.5.976

Everything changed tonight, and how to prove each piece works.
Supersedes `TEST_PLAN_v5.5.974.md`.

**Live on develop:** `1f27944` (974) → `24db301` (975) → `3e5dfb4` (976).
**Applied to the Ops database:** both scheduler migrations.

---

## Part 1 — The one method that covers most of it

Around **50 places** used to say "Saved" without ever checking the database. So each screen gets **two passes**.

**Pass 1 — offline. This is the test that proves the fix.**
1. DevTools → **Network → Offline** (or drop wifi)
2. Do the action
3. **Expect:** a red banner naming what did **not** save, **no** green tick, and any value you changed **snaps back**
4. **Fail =** a green tick, or silence, or the value staying changed on screen

**Pass 2 — online. Proves nothing broke.**
1. Back online, same action
2. **Expect:** saves normally, **and survives a hard refresh**

> The red banner is the existing **saveHealth** banner — top of screen, can't be dismissed until a save succeeds.

---

## Part 2 — Back Office screens

### Money and tax — highest value, do these first
| Screen | Action |
|---|---|
| **Tax rates** | Change the **default** rate; delete a rate; on a fresh venue press **Seed rates** |
| **Discounts** | Create, edit, **delete** |
| **Cash drawers** | Edit a drawer; delete a drawer |
| **Petty cash** | Record a **paid-out** and a **cash drop** |
| **Purchase orders** | **Cancel** a PO |
| **Stock items** | Change a **par level**; change the **default purchase unit**; delete a packaging format; change the **preferred supplier pack** |
| **Stock counts** | Type a **counted quantity**; press **Save progress**; **Approve** a count |
| **Suppliers / Recipes** | **Archive** one of each |

**Three separate old Tax bugs — check all three:**
- Seeding on a venue that already has rates must **not** claim "12 rates added" when it added none
- Setting a new default must **never** leave **two** defaults — check the list after
- If the tax list fails to load, the POS must **keep the rates it already had** (it used to blank them)

**Stock counts, specifically:** approving now **aborts** if any line failed to save. Previously a lost line meant stock silently reconciled to the old number.

### Configuration
| Screen | Action |
|---|---|
| **Print routing** | Change a rule; set the **venue receipt printer** |
| **Printers** | Add, rename, **delete** |
| **Floor plan** | Move a table, add a table, **delete** a table, rename one, change **width/height** |
| **Devices** | Rename; change **profile**; **remove**; **regenerate** a pairing code |
| **Location settings** | Change **address**, **show item images** |
| **Multi-location** | Rename a venue |
| **Challenge 21** | Change the setting |
| **Menu boards** | Save a board; publish |
| **Print menu** | Edit anything (autosaves — watch for a false "saved") |
| **Location switcher** | Switch venue |

**Floor plan + Staff — I changed how typing commits.** Table **width/height** and the **staff name** field now save when you **click away or press Enter**, not on every keystroke. Type a new name, click away, confirm it saves. Previously each character fired its own save.

**Location switcher — order changed.** It now writes your profile **first** and only then switches. Offline it should say it failed and **leave you where you were**, with your cached data intact.

### Staff and workforce
| Screen | Action |
|---|---|
| **Staff** | **Add**; **delete**; edit role / PIN |
| **Rota** | **Publish** |
| **Time off** | **Approve** and **decline** |

**⚠ The important one — Rota publish.** Offline, press Publish.
**Expect:** it fails visibly and **no SMS or email reaches staff**.
It used to message everyone about a rota that hadn't saved.

### Operations
| Screen | Action |
|---|---|
| **Maintenance** | Change status; **assign**; raise a job; add a note |
| **Ops notifications** | **Delete** a rule |
| **Temperature** | Save a **schedule**; delete one |
| **Ops devices** | **Unpair** a tablet |

### Customers
**Delete a customer** offline. It must say it failed.
**⚠ GDPR path** — it used to vanish the row from screen while leaving the person in the database. You'd have told someone they were erased when they weren't.

---

## Part 3 — Other surfaces

### Operations tablet (inside the Manager app)
**The most serious fix in this release.**
1. Open a checklist containing a **temperature check**
2. Offline, enter a reading and save
3. **Expect:** an error. **Fail =** it ticks green

A manager used to enter a fridge temperature, watch it tick, and **no food-safety record was written**. Also test **ticking** and **unticking** an ordinary task, and the **photo** and **sign-off** steps.

### Manager app / MPOS / Time Clock
These three could not display **any** message at all — no errors, no confirmations.

- **Manager** (`?mode=manager`) — approve a timesheet
- **MPOS** (`?mode=mpos`) — send an order
- **Time Clock** (`?mode=clock`) — clock in with a **wrong PIN**

**Expect:** you now see a message. Before: total silence.

---

## Part 4 — Two crashes that were never noticed

### Transfer a table → the kitchen is told
**This has never worked.** The transfer-notice code called a helper that only existed inside a different function, so it threw instantly into a catch that only logged to the console.

1. Put sent items on a table
2. **Transfer it** to another table
3. **Expect:** a transfer notice **prints at the kitchen/bar station**
4. Before: you saw "Transferred to Table 12" and the kitchen learned nothing

Test **combining** into an occupied table too.

### What's New opens
Open **What's New**. It should now list the releases. The whole file used to throw on load, so every release note you've written has been unreadable in the app.

---

## Part 5 — Scheduled jobs (now live, and verifiable)

All nine jobs run automatically. Verify with:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

Then, after a few minutes:

```sql
select j.jobname, d.status, d.return_message, d.start_time
  from cron.job_run_details d join cron.job j using (jobid)
 where d.start_time > now() - interval '30 minutes'
 order by d.start_time desc;
```

**Expect every row `succeeded`.** Already confirmed tonight: `paxpay-sweep` **succeeded** for the first time after **20,538 consecutive failures**, and `hubrise-reconcile` returned **HTTP 200**.

To see what the edge functions actually replied:

```sql
select id, status_code, left(content, 200), created from net._http_response order by id desc limit 10;
```

**Cadence:** paxpay every minute · hubrise every 2 min · catering + ops-escalate every 5 min · marketing + review-ask hourly · log purge, pay-rate changes and Xero nightly.

**Marketing is hourly *checking*, not hourly sending.** A send only happens when a campaign is genuinely due.

---

## Part 6 — Things worth watching rather than testing

- **Ops escalation reaches nobody right now.** The one live rule targets role **"MOD"** and no staff member has that role. The code is fixed; the *configuration* isn't. Give the rule a real recipient, then trigger a temperature breach and confirm the email arrives.
- **Your "Haven't seen you in a while" campaign never fires by itself** — it's a one-off, and the scheduler only picks up automations and scheduled sends. It needs converting to a **lapsed automation**.
- **Three June temperature alerts** are still unacknowledged. `ops-escalate` now runs every 5 minutes and will act on them.

---

## Part 7 — Known and deliberately not fixed tonight

Tracked as task #86:

- **Petty cash entries added from Back Office may never reach `cash_movements`** — being verified. If confirmed, they're missing from drawer variance, EOD and the Z report.
- Helper internals in `lib/ops/data.js` and `lib/stock/*.js` still swallow partial failures — `setUnitDefault` can leave **two** buy defaults.
- No 0-row check in those helpers: an RLS policy matching nothing still reads as success.
- **MPOS payment path** proceeds to the receipt screen even if closing the check failed.
- Two more copies of the kitchen-routing helper remain (one of them caused tonight's transfer bug).
- Four surfaces now carry a near-identical toast component — should be one component above the surface switch.

---

## How I verified, and what I did not

- **Verified:** clean build; **eslint clean of `no-undef`** across every changed file (that check is what found both crashes — the Vite build does *not* catch them); an independent adversarial review of the full diff, which found **7 regressions the fix agents had introduced**, all fixed before commit; and the scheduler proven live against the real database.
- **Not verified:** no hands-on UI clicking. There's no test framework here and local dev runs in mock mode where writes short-circuit. **Part 1's offline pass is the real proof and still needs doing.**
