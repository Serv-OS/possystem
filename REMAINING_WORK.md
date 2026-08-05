# What's left to be 100% ready

> **Status 5 Aug 2026, v5.5.977.** Groups 2, 3.3, 3.4, 3.5, 4 and 5 (part) are **DONE** — see
> the strikethrough markers below. Group 1 is written and committed as
> `supabase/migrations/20260805c_anon_fences.sql` but **needs Peter to run it** (schema changes
> are blocked in the agent environment). Section B of that migration carries a real trade-off
> that needs a decision — see the note in Group 1.


Verified live on 5 Aug 2026 by five independent auditors, against the real databases — not copied from the earlier audit. Staging work is **out of scope**; this is product correctness only.

Tonight's fixes (v5.5.974–976) are **not** repeated here. Where an auditor checked an old claim and found it already fixed, it's listed under *Already closed* at the bottom.

---

# Group 1 — Security. The anon key is the whole problem

The public **anon key ships inside the browser bundle**. Anyone who opens the POS can copy it out and use it with `curl`. Everything below was proven with that key.

**This is the group that has to be done before a single real customer's data goes in.**

### 1.1 — `user_locations` is anon-writable. One INSERT collapses the entire fence 🔴
- `user_accessible_locations()` is the **only** fence on **108 of 143** policied tables
- That function reads `user_locations` — **and anon can INSERT into it**
- So an attacker grants themselves access to any venue, then every one of those 108 tables opens up legitimately
- **This is the single most important fix in this document**
- **Effort:** ~2 hours

### 1.2 — Ops anon key reads every tenant's data, including customer PII 🔴
- Verified readable with no login: `user_profiles` (366 rows), `organisations`, `locations`, `devices` (19), and **customer records with contact details**
- **Effort:** ~half a day

### 1.3 — Platform `locations_anon_update`: rewrite any column of any venue 🔴
Policy is `USING(true) WITH CHECK(true)`. Live consequences the auditor confirmed have real consumers:
- **`challenge_21_enabled`** — silently switch off age verification at every venue. *Licensing exposure*
- **`qr_service_charge_pct`** — applied to real customer totals, and has **no database constraint**; the 0–50% clamp is browser-side only
- **`online_slug` / `ops_location_id`** — redirect a venue's public orders into another tenant
- **`online_enabled=false`** — kill ordering platform-wide
- ⚠️ Correction to the earlier audit: **`ops_db_url` is dead code**, so the "full database pivot" claim was wrong. The real damage is the list above
- **Effort:** 1 hour for the policy + constraints; ~1–2 days for the full fix

### 1.4 — Anyone can fabricate billing 🔴
- `increment_gmv()` and `close_billing_period()` are `SECURITY DEFINER`, **executable by anon**, with **no caller check at all**
- Inflate any merchant's GMV → the logic is **promote-only**, so the tier can't be walked back inside the period. The merchant is over-billed
- Or close your own period early at a low GMV to dodge fees
- **Not in the original audit.** New find
- **Effort:** 10 minutes to revoke; half a day to move the call server-side

### 1.5 — Commercially sensitive data readable by anyone 🟠
Eight platform tables are `SELECT USING(true)`:
- **Your own margins** — `cardpresent_markup_percent`, `online_markup_percent`, pricing notes
- Every merchant's **GMV and plan**, every **staff email + role** (a ready-made phishing list), **Stripe account ids**, **terminal serials and registration codes**
- **Effort:** ~1 day

### 1.6 — Eight tables allow anon **DELETE** 🟠
- Policies named `service_all` are attached to `public`, which **includes anon** — the name says the intent was service-role only
- Covers **loyalty balances, stamp programmes, gift-card purchase records** with customer PII. Readable, rewritable, **wipeable**
- **Effort:** ~2 hours

> **The structural blocker:** the platform browser client runs with `persistSession:false`, so it has **no JWT at all**. That's *why* every policy is `true` — there's no identity to fence on. Policies alone can't fix it; those writes have to move behind edge functions. That's the ~1–2 day piece.

---

# Group 2 — Money that goes missing

### 2.1 — Petty cash entries never reach the database 🔴 *(confirmed)*
- Float added, cash drop, expense paid out, adjustment — all appended to an **in-memory array and nothing else**
- `cash_movements` never gets a row
- So every one is **invisible to drawer variance, EOD close and the Z report**
- This is a missing write, not a swallowed one — tonight's sweep couldn't catch it
- **Effort:** ~1 hour

### 2.2 — MPOS: card taken, sale not recorded 🔴
- Happens **after** the card is approved
- If closing the check fails, the only handling is `console.warn` — then it advances to the receipt screen anyway with an empty check
- Result: **money captured, no `closed_checks` row, nothing in the Z report, table still shows occupied.** The operator sees a normal receipt prompt
- Sister bug: `try { sendToKitchen() } catch {}` — the customer pays for food the kitchen never saw
- **Effort:** ~45 minutes

### 2.3 — Loyalty and promo redemptions are never deducted 🟠
- All four channels show the discount, take the payment, then fire the redeem call **without awaiting or checking it**
- Fails silently → the stamp / points / one-time code are **never consumed and can be redeemed again, indefinitely**
- Kiosk is worst: `fetch().catch()` only, and **fetch doesn't reject on 4xx/5xx**, so a 401 or 500 is completely invisible
- The code comment claims idempotency protects against double-deduction — the real failure is **under**-deduction
- **Effort:** ~3 hours

### 2.4 — Two "buy default" pack sizes can coexist 🟡
- Two unchecked "clear the others" writes, **no database constraint**, and readers use `.find()` on an unordered fetch
- Which one wins is **nondeterministic and can differ between devices** → purchase orders built against the wrong pack size
- No duplicates in live data today
- **Effort:** ~45 min + a migration

---

# Group 3 — Looks armed, isn't

### 3.1 — Food-safety escalation reaches nobody 🔴
- The only live rule targets role **"MOD"** — **no record in any of the three role tables can hold that value**
- Tonight's code fix works; the **configuration** points at no one
- Three June temperature breaches are still unacknowledged
- **Effort:** minutes to reconfigure, plus a UI guard so a role that matches nobody can't be saved silently

### 3.2 — Your lapsed-customer campaign never fires 🟠
- "Haven't seen you in a while" is a **one-off**; the scheduler only picks up **automations** and **scheduled** sends
- It has only ever run when clicked
- Needs converting to a **lapsed automation** — then it checks daily and sends **once per customer per month**
- **Effort:** minutes, once you pick the day threshold

### 3.3 — The POS cash-drawer sign-in lock isn't in the shipped app 🟠
- The gate lives inside a **dead function** that nothing calls; `POSLockOverlay.jsx` is imported by nothing
- Confirmed absent from the built bundle
- So a till with a drawer in a closed state is **fully usable** — staff take cash sales with no declared opening float, and **every cash-up on that till is meaningless**
- **Needs your decision:** was removing this deliberate?
- **Effort:** ~1 hour

### 3.4 — Course firing doesn't reach the kitchen for 30 live items 🟠
- The `fireCourse` copy of the routing logic passes a **menu-item** parent map where a **category** parent map is expected
- Different key spaces, so the category-ancestor walk can never take a step
- Any item whose production centre is set on the **parent** category resolves to no centre — **30 active items** here: Coffee 13, Draught 10, Bottles 6, Cider 1
- The toast still says *"Course 2 fired to kitchen"*
- This is the **same duplication that caused tonight's table-transfer bug**. The kiosk copy was checked and is clean
- **Effort:** ~30 minutes

### 3.5 — Reprinted kitchen tickets 🟡
- Mark-printed uses `.then(ok, err)`, but PostgREST **resolves** on a database rejection rather than rejecting — so the error callback never fires
- The job stays claimed, the reclaimer flips it back to pending, and **the ticket prints twice**
- No evidence it's fired yet
- **Effort:** ~45 minutes

---

# Group 4 — Crashes waiting to happen

Found by eslint. The **Vite build does not catch these** — that's how tonight's two crashes hid.

### 4.1 — Pizza tab takes down the whole app 🟠
- `MenuManager` uses four pizza constants it never imports
- Throws during render → the app-wide error boundary swaps **the entire application** for a red error page, POS shell included
- Latent only because no venue has a pizza product yet — **fires the first time anyone uses the feature**
- **Effort:** 2 minutes

### 4.2 — "Needed today" prep panel never appears 🟡
- `Batches.jsx` uses `supabase` without importing it; the effect throws before it can do anything
- Fails as an unhandled rejection, so nothing is logged — the feature just looks empty
- **Effort:** 2 minutes

### 4.3 — Per-line discounts can be removed on the POS but never applied 🟡
- The handler calls a function that doesn't exist, and no control renders that would reach it. MPOS is the only surface that can apply one
- **Effort:** 5 min to remove, 1–2 h to implement

### 4.4 — Dead code carrying guaranteed crashes 🟡
- Four unreachable components would throw instantly if wired up. They're also the **noise that hid tonight's two real crashes** in the eslint output
- Deleting them makes `no-undef` a trustworthy signal
- **Effort:** ~30 minutes

---

# Group 5 — Smaller

- **MenuManager variant/size archive** is console-only and shows a green toast regardless. That file wasn't touched tonight. Also missing a `location_id` filter — ~20 min
- **Ops/stock helper internals** still swallow partial failures; `assignMaintenance` returns hardcoded success, so **the assignee is never alerted** — ~1 hour
- **No 0-row detection** in those helpers: a policy matching nothing reads as success — folded into the above
- **`review-sync` still can't be scheduled** — it requires a location id and has no fan-out action — ~1 hour
- **Two conditional React hooks** in StockItems — fragility, not currently reachable — 10 min
- **Rename "Workflow" → "Journey"** in the marketing UI, since "automation" already means something else — ~30 min

---

# Recommended order

| # | What | Why first | Effort |
|---|---|---|---|
| 1 | **`user_locations` write fence** (1.1) | One insert defeats 108 tables' protection | 2 h |
| 2 | **Revoke billing functions** (1.4) | 10-minute fix for invoice fabrication | 10 min |
| 3 | **Money paths** (2.1, 2.2) | Cash and card sales silently unrecorded | 2 h |
| 4 | **Two-minute crashes** (4.1, 4.2) | Trivial, one takes down the whole app | 5 min |
| 5 | **Course firing** (3.4) | 30 live items don't reach the kitchen | 30 min |
| 6 | **Escalation recipients** (3.1) | Food safety currently reaches nobody | 30 min |
| 7 | **Anon read/delete policies** (1.2, 1.5, 1.6) | Big win, mostly mechanical | 1–2 d |
| 8 | **Edge-function bridge** (1.3) | The structural fix; unblocks the rest | 1–2 d |
| 9 | Redemptions, everything else | | 1 d |

**Roughly 5–7 focused days.** Items 1–6 are about **half a day together** and remove the worst of it.

---

# Already closed (checked, don't re-do)

- `insertCashMovement` no longer returns an id for a rejected insert
- `openCashDrawer` awaits the ledger write and suppresses the success toast when it's lost
- `transferTable`'s kitchen-notice crash — helper now shared at module scope
- **The kiosk copy of the routing helper is clean** — checked specifically; it's a faithful copy with neither the scope bug nor the drift
- `giftCommit.js` error handling is sound
- `db.js` closed-check writers resolve location defensively and return real errors
- The bare catches in the online order tracker are benign (clipboard / share)
- The privilege escalation in `handle_new_user()` is still closed
- No duplicate packaging defaults, and no print jobs stuck, in live data right now
