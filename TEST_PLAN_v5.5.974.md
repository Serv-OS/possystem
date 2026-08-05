# Test plan — v5.5.974 (pre-stage hardening)

Everything changed in this release, and how to prove it works.

---

## The one test method that covers 90% of this

Almost every fix is the same shape: **a screen said "Saved" without checking that the database accepted it.**

So there are **two passes** for each screen below.

**Pass 1 — offline (proves the fix).**
1. Open **DevTools → Network → Offline** (or drop wifi).
2. Do the action.
3. **Expect:** a red banner naming what did *not* save, **no** green success message, and any value you changed **snaps back**.
4. **Fail =** a green tick, or silence, or the value staying changed on screen.

**Pass 2 — online (proves nothing broke).**
1. Back online. Do the same action.
2. **Expect:** it saves, you get the normal confirmation, and **it survives a hard refresh**.
3. **Fail =** an error on the happy path, or the value gone after refresh.

> The red banner is the existing **saveHealth** banner — top of screen, red, cannot be dismissed until the save succeeds.

---

## Back Office — screens to test

Work through these. Each one is **Settings → the screen**, then the action.

### Money and tax — do these first
| Screen | Action to test |
|---|---|
| **Tax rates** | Change which rate is **default**; **delete** a rate; on a fresh venue press **Seed rates** |
| **Discounts** | Create, edit, **delete** a discount |
| **Cash drawers** | Edit a drawer; delete a drawer |
| **Petty cash** | Record a **paid-out** and a **cash drop** |
| **Purchase orders** | **Cancel** a PO |
| **Stock items** | Change a **par level**; change the **default purchase unit**; delete a packaging format |
| **Stock counts** | Type a **counted quantity** into a count sheet |
| **Suppliers / Recipes** | **Archive** one of each |

**Extra check on Tax (three separate old bugs):**
- Seeding on a venue that already has rates must **not** report "12 rates added" when it added none.
- Setting a new default must **never** leave you with **two** defaults — check the list after.
- If the tax list fails to load, the POS must **keep the rates it already had** (it used to blank them).

### Configuration
| Screen | Action to test |
|---|---|
| **Print routing** | Change a routing rule; set the **venue receipt printer** |
| **Printers** | Add, rename, **delete** a printer |
| **Floor plan** | Move a table, add a table, **delete** a table |
| **Devices** | Rename a device; change its **profile**; **remove** a device; **regenerate** a pairing code |
| **Location settings** | Change **address**, **show item images**, POS settings |
| **Multi-location** | Rename a venue |
| **Challenge 21** | Change the setting |
| **Menu boards** | Save a board; publish a board |
| **Print menu** | Edit anything (it autosaves — watch for the false "saved") |
| **Location switcher** | Switch venue |

### Staff and workforce
| Screen | Action to test |
|---|---|
| **Staff** | **Add** a staff member; **delete** one; edit one |
| **Workforce → Rota** | **Publish** a rota |
| **Workforce → Time off** | **Approve** and **decline** a request |

**⚠ The most important one here — Rota publish.** Offline, press Publish.
**Expect:** it fails visibly and **no SMS or email goes to staff**.
Previously it messaged everyone about a rota that had not saved.

### Operations
| Screen | Action to test |
|---|---|
| **Maintenance** | Change status; **assign** to someone; raise a job; add a note |
| **Ops notifications** | **Delete** a rule |
| **Temperature** | Save a **schedule**; delete a schedule |
| **Ops devices** | **Unpair** a tablet |

### Customers
| Screen | Action to test |
|---|---|
| **Customers** | **Delete** a customer |

**⚠ This is a GDPR path.** Offline it must say it failed. It used to vanish the row from the screen while leaving the customer in the database — so you would have told someone they were erased when they were not.

---

## Other surfaces (not Back Office)

### Operations tablet — `?mode=ops`
**The most serious fix in this release.**

1. Open a checklist with a **temperature check**.
2. Offline, enter a reading and save.
3. **Expect:** an error. **Fail =** it ticks green.

Previously a manager entered a fridge temperature, watched it tick, and **no food-safety record was ever written**. Also test **ticking** and **unticking** a normal task.

### Manager app / MPOS / Time Clock
These three could not display **any** message at all — no errors, no confirmations. Same bug fixed in the Back Office in v5.5.971.

- **Manager app** (`?mode=manager`) — approve a timesheet
- **MPOS** (`?mode=mpos`) — send an order
- **Time Clock** (`?mode=clock`) — clock in with a **wrong PIN**

**Expect:** you now see a message. Previously: total silence.

### POS
Nothing on the POS changed in this release, but the store was touched, so smoke-test:
- Take a **cash** sale and a **card** sale end to end
- **Archive a menu item** in the Back Office → confirm it disappears from the POS after a push

---

## Server side

### Already live — you can check these now
| What | How to check |
|---|---|
| **ops-escalate** deployed | Operations → an unacknowledged alert should no longer be able to climb its escalation ladder without anyone being emailed |

### Needs you to apply — two migrations
These change the live database schema, which I am not permitted to do without you.

```bash
cd "/Users/peterroberts/Library/CloudStorage/Dropbox/POSUP/Claude Code/Test POS app/possystem" && npx -y supabase@2.106.0 db push --project-ref tbetcegmszzotrwdtqhi
```

Or paste each file into the Supabase SQL editor:

1. **`supabase/migrations/20260805_scheduled_automations.sql`** — fixes the terminal sweeper (failed **20,538 times in a row**) and starts purging the cron log. **No secrets needed.**
2. **`supabase/migrations/20260805b_edge_cron_bridge.sql`** — moves the four dead Vercel crons into the database.

**After applying, verify:**
```sql
select jobname, schedule, active from cron.job order by jobname;
```
Then wait 5 minutes and:
```sql
select j.jobname, d.status, d.return_message, d.end_time
  from cron.job_run_details d join cron.job j using (jobid)
 where d.end_time > now() - interval '15 minutes'
 order by d.end_time desc;
```
**Expect:** `paxpay-sweep` now shows **succeeded**, not failed.

---

## Two jobs I deliberately left switched OFF

Both **send messages to real customers**, and nobody has confirmed the recipient list is safe in this environment. The plumbing is complete and tested — enabling is one line each.

- **`marketing-run-hourly`** — the hourly campaign engine. `marketing_messages` already shows **6 sent + 1 opened**, so real mail has gone out of this database before. Turning this on starts sending for real, every hour.
- **`review-request-scan`** — texts recent customers asking for a review.

**To enable, once you are happy:**
```sql
select cron.alter_job((select jobid from cron.job where jobname='marketing-run-hourly'), active := true);
```

**Safer first step for marketing** — set the `MARKETING_SANDBOX=true` edge secret. Everything runs and logs exactly what it *would* have sent, without sending anything.

---

## What I could not verify myself

Being straight about the gaps:

- **No hands-on UI testing.** There is no test framework in this repo and the dev environment runs in mock mode, where writes short-circuit. I verified the build compiles and had an independent agent adversarially review the diff — but **the offline-pass test above is genuinely needed**, and it is the only way to be sure.
- **The two migrations are unapplied**, so the scheduling fixes are written and reviewed but **not yet live**.
- **`ops-escalate` cannot be end-to-end tested** until a rule points at someone with a real phone number or email. Right now the only rule targets the role **"MOD"**, and **no staff member has that role** — so it currently resolves to nobody. Worth fixing while you are in there.
