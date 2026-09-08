# PaxPay — POS to terminal transport spec

Generated 21 Jul 2026. **DESIGN ONLY — not implemented.**

- **Mode 3** (POS sends a payment to the reader) — this document
- **Mode 2** (manual amount) — already built and running in `:paxpay`
- **Mode 1** (Table Pay) — layers on top; whole-bill only, staff PIN required

---

## How it works

1. **Pair** the PAX once: it shows a code, a manager types that code into Back Office → Card Readers. The terminal is now tied to one venue and one till.
2. **Staff tap Card** on the POS. The POS works out two numbers: the **bill** (for calculating tip %) and the **due** (what the card must actually take after gift cards and vouchers).
3. **POS writes a job row** to the database — amounts, tip settings, and a full snapshot of the check. This row is the single source of truth from here on.
4. **Terminal picks the job up** (it polls every few seconds; a realtime push just makes it faster). It claims the job so no other device can.
5. **Terminal shows the amount** and the table name, so the waiter confirms it is the right check before handing it over.
6. **Our tip screen runs on the terminal**, in the customer's hand. Bands come from the job row, not from a live lookup.
7. **Tip is committed to the database first**, before any card is touched. The row now says exactly what is about to be charged.
8. **Terminal charges the card** via the STS controller (one single total — base plus tip).
9. **Result is written back** to the job row. The check closes with base and tip recorded **separately**.
10. **If anything breaks**, the row survives. A sweeper and a POS-side reconciler finish the job later. If the outcome genuinely cannot be established, it goes to a **human queue** — never auto-retried, never dropped.

---

## Will it work

- **PROVEN on hardware today** — our app installs and runs on the PAX, resolves the STS controller package, launches it, receives `DEVICE_CONNECTED` in 293ms, and control returns. Tip maths produces one total. None of that is theory.
- **Ordinary engineering** — the job table, pairing, claim/lease, tip screen, result write, closed-check split, reconciler. Every pattern already exists in this codebase (`print_jobs` claim, `ops_devices` pairing, courier reserve-then-act, `OfflineQueue` replay). Nothing needs inventing.
- **Blocked on Ryft** — exactly two method bodies: `startTransaction` and `fetchResult`. One construction site in `PaymentFlow`. Everything else ships and is testable against the stub.
- **Honest gap** — until Ryft answer, there is **no server-side recovery** for a G8 charge. The terminal's own durable log is the only safety net. That is fine for a pilot, not for a rollout. Say so in the runbook.
- **One assumption unverified and load-bearing** — that the STS controller does not show its *own* tip prompt on top of ours. If it does, the whole tipping model dies. Ask now.

---

## The data model

```sql
-- ─────────────────────────────────────────────────────────────
-- 20260722_terminal_devices.sql   (OPS DB)
-- ─────────────────────────────────────────────────────────────
create table if not exists terminal_devices (
  id                  uuid primary key default gen_random_uuid(),
  device_uid          uuid not null default auth.uid(),  -- DB-stamped, never client-set
  serial_number       text not null,                     -- STABLE identity: survives reinstall
  location_id         uuid,                              -- NULL until a manager claims it
  org_id              uuid,
  claim_code          text,
  label               text,
  ryft_terminal_id    text,                              -- soft link -> Platform payment_devices
  bound_pos_device_id uuid,
  tip_config          jsonb,                             -- cache only; job row is authoritative
  status              text not null default 'unpaired',  -- unpaired | paired | retired
  active              boolean not null default true,
  app_version         text,
  last_seen_at        timestamptz,
  claimed_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists idx_td_code   on terminal_devices (lower(claim_code)) where claim_code is not null;
create unique index if not exists idx_td_serial on terminal_devices (serial_number)     where status = 'paired';
create unique index if not exists idx_td_ryft   on terminal_devices (ryft_terminal_id)  where status = 'paired';
create        index if not exists idx_td_uid    on terminal_devices (device_uid);   -- RLS filters on this; without it, seq scan
create        index if not exists idx_td_loc    on terminal_devices (location_id);

alter table terminal_devices enable row level security;

-- SAFE: a terminal can read ONLY the row it owns, so pairing codes are never
-- enumerable across tenants. Back Office reads only its own locations.
create policy td_select on terminal_devices for select using (
  device_uid = auth.uid()
  or location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);

-- SAFE because there is NO insert policy. Every anon session on the open internet
-- (kiosk, QR diner, online ordering) holds a valid auth.uid() -- granting them INSERT
-- into a payments table would be unbounded public write access. Registration goes
-- through register_terminal_device() only: idempotent per serial, rate-limited.

-- SAFE: retiring is a Back Office act, scoped to the manager's own locations.
create policy td_delete on terminal_devices for delete to authenticated using (
  location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);
-- NO UPDATE POLICY -- every mutation is a SECURITY DEFINER RPC below.
```

```sql
-- ─────────────────────────────────────────────────────────────
-- 20260722b_terminal_jobs.sql   (OPS DB)
-- ─────────────────────────────────────────────────────────────
create table if not exists terminal_jobs (
  id                 uuid primary key,        -- POS-minted. Also the G8 Idempotency-Key + log id.
  check_key          text not null,           -- `${locationId}:${tableId}:${sessionId}` (+`:leg2` for splits)
  location_id        uuid not null,           -- SERVER-resolved. Never trusted from the client.
  target_terminal_id uuid not null references terminal_devices(id),
  pos_device_id      uuid,
  training           boolean not null default false,

  -- THE THREE AMOUNTS. bigint minor units. Never floats. Never derived from each other.
  tip_basis_minor    bigint not null check (tip_basis_minor >= 0),   -- the BILL (tip % applies to this)
  due_minor          bigint not null check (due_minor > 0),          -- what the CARD must take, pre-tip
  tip_minor          bigint          check (tip_minor >= 0),         -- null until the tip screen settles
  charge_minor       bigint          check (charge_minor >= 0),      -- server-computed = due + tip
  reported_minor     bigint,                                        -- what the DEVICE claims. Compared, not trusted.
  currency           text not null default 'GBP',

  tip_config         jsonb not null,          -- FROZEN at dispatch. Audited against the rules that applied.
  closed_check_id    text not null,           -- pre-minted `chk-<ts>` so the check can close without the POS
  check_draft        jsonb not null,          -- everything recordClosedCheck needs EXCEPT the tip

  status             text not null default 'pending',
  -- pending | claimed | tipping | charging_unsent | charging | approved
  -- | declined | cancelled | expired | unknown | reconciled
  processor          text not null default 'ryft',
  transaction_id     text,
  auth_code          text,
  card               jsonb,
  decline_reason     text,
  simulated          boolean not null default false,

  claimed_by         uuid,
  claimed_at         timestamptz,
  claim_expires_at   timestamptz,
  reconcile_attempts integer not null default 0,
  needs_human        boolean not null default false,
  last_error         text,

  created_at         timestamptz not null default now(),
  dispatched_at      timestamptz,
  charged_at         timestamptz,             -- stamped BEFORE the card is touched
  settled_at         timestamptz,
  updated_at         timestamptz not null default now(),

  -- The money invariant, enforced by the DB rather than by a caller remembering.
  constraint tj_charge_identity
    check (charge_minor is null or tip_minor is null or charge_minor = due_minor + tip_minor)
);

-- MUTEX 1: one live job per payable check. Blocks the double-press / refresh / two-tills
-- double charge. terminal-job-create returns the EXISTING row on 23505 -- never a second job.
create unique index if not exists idx_tj_one_live_per_check on terminal_jobs (check_key)
  where status in ('pending','claimed','tipping','charging_unsent','charging','unknown');

-- MUTEX 2: one live job per terminal. A PAX can never hold two open charges.
create unique index if not exists idx_tj_one_live_per_terminal on terminal_jobs (target_terminal_id)
  where status in ('claimed','tipping','charging_unsent','charging','unknown');

create index if not exists idx_tj_target on terminal_jobs (target_terminal_id, created_at desc)
  where status in ('pending','claimed','tipping','charging_unsent','charging');
create index if not exists idx_tj_sweep  on terminal_jobs (claim_expires_at)
  where status in ('claimed','tipping','charging_unsent','charging','unknown');
create index if not exists idx_tj_human  on terminal_jobs (location_id) where needs_human;
create index if not exists idx_tj_check  on terminal_jobs (closed_check_id);

alter table terminal_jobs replica identity full;
do $$ begin alter publication supabase_realtime add table terminal_jobs;
exception when duplicate_object then null; end $$;

alter table terminal_jobs enable row level security;

-- SAFE: the target terminal reads ONLY jobs addressed to it, so a stolen anon token
-- from one venue cannot read another venue's checks or card data.
create policy tj_select_terminal on terminal_jobs for select using (
  target_terminal_id in (select id from terminal_devices where device_uid = auth.uid() and active)
);

-- SAFE: Back Office staff read their own locations for the reconcile screen.
create policy tj_select_bo on terminal_jobs for select using (
  location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);

-- DELIBERATELY NOT: a policy for the POS. pos_can_access() needs devices.device_uid,
-- which claim_device() stamps best-effort and BOTH call sites swallow the failure.
-- A till whose claim silently failed would dispatch fine and then be unable to read
-- its own job -- waiting forever on a card that was already charged. The POS reads
-- through the terminal-job-status edge function instead, which authorises the same
-- way terminal-job-create does.

-- NO INSERT / UPDATE / DELETE policies at all.
--   INSERT -> edge function (location_id must be server-resolved).
--   UPDATE -> SECURITY DEFINER RPCs (the tip split is money; it feeds tronc).
--   DELETE -> never. A money row is never deleted; cancelled/expired are states.
```

**Transition RPCs** (all `security definer`, all fenced on `device_uid = auth.uid()` owning the target terminal):

| RPC | Grant | Rule |
|---|---|---|
| `register_terminal_device(serial, label)` | anon | idempotent per **serial**, returns existing row |
| `claim_terminal_device(code, loc, ryft_id)` | authenticated only | 30-min code TTL; retires any prior row with same serial |
| `terminal_heartbeat(app_version)` | anon | own row only |
| `terminal_job_claim(job)` | anon | CAS; raises if caller already holds a live job |
| `terminal_job_tip(job, tip_minor)` | anon | **caps the tip** server-side; computes `charge_minor`; → `charging_unsent` |
| `terminal_job_sent(job, txn_id)` | anon | `charging_unsent` → `charging`. The point of no return. |
| `terminal_job_complete(job, result)` | anon | writes outcome + finalises `closed_checks` |
| `terminal_job_aborted(job, reason)` | anon | only from `charging_unsent` → `cancelled`. Safe, deterministic. |
| `terminal_job_unknown(job, err)` | anon | any → `unknown`, `needs_human = true` |
| `terminal_job_cancel(job)` | authenticated | refuses once `charged_at` is set |
| `terminal_job_reconcile(job, outcome)` | **service_role only** | the sweeper's verdict |

---

## The three amounts

**Worked example.** £50 meal. Customer pays £45 with a gift card. Chooses a 10% tip.

| # | Name | Value | Why |
|---|---|---|---|
| **A** | **tip basis** | **£50.00** (`5000`) | The tip is for the *service*, not the leftover balance. Bands show "10% = £5.00". |
| **B** | **due** | **£5.00** (`500`) | £50 bill − £45 gift. What the card must actually take, pre-tip. |
| **C** | **charge** | **£10.00** (`1000`) | B + tip = 500 + 500. **The only number the card ever sees.** |
| **D** | **check face** | **£55.00** (`5500`) | `closed_checks.total`. Gift lives separately in `closed_checks.gift_card`. |

**The two ways this goes wrong:**

- **Charge `A + tip` (£55)** → the gift card was already drained £45. The customer pays £45 **twice**. Chargeback.
- **Use B as the tip basis** → 10% of £5 = **50p** instead of £5. Tips collapse on every gift-carded sale. Staff robbed.

**Guards:**

- `due_minor > 0` is a **CHECK constraint** — a fully gift-carded check can never create a job.
- `charge_minor = due_minor + tip_minor` is a **CHECK constraint** — no code path can write a total that is not the sum of its parts.
- `charge_minor` is computed **server-side** in `terminal_job_tip`, from `due_minor` already on the row. The device supplies only the tip.
- **The refundable leg carries C, never D.** `payment_intents[].amountMinor = charge_minor`. Refunding against face value refunds money the card never paid.

**Note:** gift cards are spent at *apply* time (`CheckoutModal.jsx:791` fires `gift-redeem` immediately), so the credit set is immutable by dispatch. A declined job must fire `gift-reverse-redeem`. An **unknown** job must not — see rule 8.

---

## Money-safety rules

1. **One live job per check** — `idx_tj_one_live_per_check`, keyed on `check_key`, not on the button press. *Prevents:* double charge from a re-press, a modal remount, a page refresh, or a second till on the same table.
2. **One live job per terminal** — `idx_tj_one_live_per_terminal`. *Prevents:* a PAX abandoning a row in `charging` and picking up a different job after a restart.
3. **Job id is minted before any network call** and persisted to `localStorage` alongside `check_key` and `closed_check_id`. On `23505`, **return the existing job** and re-attach. Only `23505` counts as "already claimed" — every other error surfaces. *Prevents:* both a duplicate job and a swallowed real failure.
4. **Reserve before you charge** — `terminal_job_tip` commits `charge_minor` and `charged_at` **before** the controller is launched. If that write fails, do not charge. *Prevents:* a charge with no record of what was intended.
5. **Two charging states, not one** — `charging_unsent` (tip taken, request not yet dispatched → deterministically safe, auto-cancels on lease expiry) vs `charging` (dispatched, outcome unknown → reconcile). *Prevents:* the reconcile queue filling with ordinary customer cancellations, which trains staff to rubber-stamp the one job that genuinely matters.
6. **On timeout: query, never re-charge.** A start-transaction timeout is an **unknown**, not a failure. Call `lookupByReference(job_id)`. Never re-issue the start. *Prevents:* the double charge.
7. **`unknown` is a first-class state.** Never auto-retried (double charge), never dropped (lost sale), always `needs_human = true`. *Prevents:* both failures at once.
8. **`unknown` does not reverse the gift card.** Reversing against a charge that may have succeeded loses the money the other way. It blocks in both directions until a human decides. *Prevents:* refunding a gift card on a sale that went through.
9. **Terminal write-ahead log** — the intent is written to on-device SQLite before `startTransaction`, the result before any network attempt, and replayed **forever with no staleness floor**. This is the `ALWAYS_REPLAY` rule (`OfflineQueue.js:174-178`); `REPLAY_MAX_AGE_MS` must never apply to a payment result. *Prevents:* the lost sale when wifi dies after the card is charged.
10. **Intent is held, fact is always replayed.** A queued job older than `STALE_ORDER_FLOOR_MS` (2h) must **not** auto-charge on boot — mark it expired, hold for manual release. A completed charge replays however old. *Prevents:* a terminal left in a drawer overnight firing yesterday's tender.
11. **Server computes the money; the device only reports.** `charge_minor` is server-derived. The device's `reported_minor` is stored separately and compared — a mismatch sets `needs_human` and blocks the close. Tip is capped server-side at `greatest(tip_basis_minor, 2000)`. *Prevents:* a keypad bug or a rooted device charging £10,000.
12. **Server-side check finalisation ships paired with a POS reconciler, never before it.** `terminal_job_complete` writes `closed_checks`, but cannot run `clearTable`, stock depletion, loyalty earn or the receipt print. Without the reconciler, the table stays seated with a paid check on it and staff charge again. *Prevents:* turning a lost sale into a double charge.
13. **Training mode gated in three places** — `handleCardPress` (before the PAX branch), a `training` column set server-side, and `terminal_job_complete` refusing to write. The terminal renders a red banner and never launches the controller. *Prevents:* a real card charged from the training till, with no closed check.
14. **`23505` and a network error must reach opposite conclusions** on the cash-off path. `23505` = already recorded, stop. Network = unknown, keep replaying. `DataSafe.js:51-56` currently collapses both and needs a discriminated return. *Prevents:* the `App.jsx:7047` failure — a silent `{ok:true}` making the caller believe a write landed when no row existed.
15. **Cancel refuses once `charged_at` is set**, and the POS must not report "cancelled" until it observes the state. *Prevents:* staff being told a payment was cancelled while the card is being charged.

---

## Files to change

**New files**

| Path | What | Size |
|---|---|---|
| `supabase/migrations/20260722_terminal_devices.sql` | table + RLS + 4 RPCs | ~180 lines |
| `supabase/migrations/20260722b_terminal_jobs.sql` | table + RLS + 10 RPCs | ~350 lines |
| `supabase/functions/terminal-job-create/index.ts` | server-resolves location, inserts, returns existing on 23505 | ~150 lines |
| `supabase/functions/terminal-job-status/index.ts` | the POS's read path (**not** RLS — see D6) | ~60 lines |
| `supabase/functions/terminal-job-reconcile/index.ts` | cron sweeper, service_role only, **never charges** | ~150 lines |
| `src/lib/payments/terminalJobs.js` | mint / persist `check_key` / dispatch / poll / cancel | ~250 lines |
| `src/lib/payments/terminalReconciler.js` | boot + reconnect: finish checks the POS missed | ~120 lines |
| `src/surfaces/PaxTerminal.jsx` | waiting screen, cancel, blocking `unknown` state | ~200 lines |
| `src/backoffice/sections/UnreconciledPayments.jsx` | the human queue, manager-role only | ~200 lines |
| `android/.../TerminalJobStore.java` | on-device SQLite WAL | ~150 lines |
| `android/.../JobPoller.java` | 12s poll + claim + realtime nudge | ~200 lines |

**Changed files**

| Path | What | Size |
|---|---|---|
| **`src/surfaces/CheckoutModal.jsx`** | ⚠️ **BOTH LANDMINES — see below** | ~60 lines |
| `src/components/SplitModal.jsx` | same branch, per-leg `check_key` (`:leg2`) | ~40 lines |
| `src/backoffice/sections/CardReaders.jsx` | pair-by-code panel; skip the Stripe config sync on Ryft venues | ~120 lines |
| `src/lib/db.js` | `refund_route` column; `simulated` flag | ~20 lines |
| `src/sync/DataSafe.js` | discriminate `23505` from network failure | ~15 lines |
| `src/store/index.js` | refund routes on `refund_route`, not `processor` | ~20 lines |
| `supabase/functions/ryft-terminal-payment/index.ts` | add the missing `idempotencyKey`; fee base = `due_minor`; drop the `?? devices[0]` fallback | ~10 lines |
| `android/.../TipConfig.java` | smart bands; `fromJobJson` **fails closed** | ~50 lines |
| `android/.../MainActivity.java` | `TipConfig.fromJson(job)`; key from the job row, not `UUID.randomUUID()` | ~30 lines |
| `android/.../G8CloudClient.java` | add `lookupByReference()` to the interface | ~15 lines |

### ⚠️ LANDMINE 1 — the `displayUsesScreen()` gate

`CheckoutModal.jsx:1357-1366` (**note: line numbers have drifted — anchor on the text, not the number**).

```js
const handleCardPress = () => {
  // Training keeps the existing simulated flow -- a job row would dispatch a REAL
  // charge to a REAL terminal, and terminal_job_complete bypasses db.js:489.
  if (isTrainingMode()) { setScreen('card_terminal'); return; }

  // PAX: the tip is chosen ON THE TERMINAL, in the customer's hand. displayUsesScreen()
  // asks "is there a stationary second screen at THIS till?" -- correct answer is no,
  // and irrelevant. A handheld's customer_display_mode is 'off' or 'reader'; even at
  // 'auto' the tip request would go to a screen back at the counter. Deliberately bypassed.
  // paxLookupDone gates the race: a press before the lookup lands must NOT silently
  // take the old path and produce a different tip on the same bill.
  if (paxLookupDone && cardProcessor === 'ryft' && paxTarget) { startTerminalJob(); return; }

  const canAskCustomer = cardProcessor === 'ryft' && !skipTip
    && tipCfg?.tipping_enabled !== false && displayUsesScreen();
  if (canAskCustomer) { askCustomerForTip(); return; }
  setScreen('card_terminal');
};
```

`skipTip` is **not** used to bypass the terminal — it folds into the frozen config as `enabled: false`, so one rule lives in one place.

### ⚠️ LANDMINE 2 — the tip-recording line

`CheckoutModal.jsx:~1750`. Today `pi?.processor === 'ryft' ? tipAmt : …` throws away the terminal's real figure and reads `tipAmt`, which is `0` on this path. £1.10 leaves the card and `tip: 0` is written.

```js
// Keyed on pi.tipMinor PRESENCE, not on processor -- the display-based Ryft path
// (counter + second screen) must keep working unchanged.
// `grand` IS what we asked the reader to capture. Subtracting `total` (the GROSS bill)
// understates the tip by exactly any gift/loyalty/promo credit and Math.max clamps it
// to 0 -- that is a LIVE bug on Stripe today. £50 bill + £45 gift + £5 tip records £0.
const realTip =
    pi?.tipMinor != null      ? Math.max(0, pi.tipMinor / 100)                    // PAX -- authoritative
  : pi?.processor === 'ryft'  ? tipAmt                                            // Ryft REST -- POS-chosen
  : receivedGbp != null       ? Math.max(0, +(receivedGbp - grand).toFixed(2))    // Stripe reader -- FIXED
  : 0;
```

On the PAX path derive both legs from the job's **integers** — `tip = job.tip_minor/100`, `amountMinor = job.charge_minor` — never round twice.

---

## Build order

| # | Milestone | Demonstrable by | Needs Ryft? |
|---|---|---|---|
| **1** | **Stripe gift-card tip fix** (one line, `grand` not `total`) | Gift card + reader tip → correct `closed_checks.tip` | **No — ship today, alone** |
| **2** | **Missing `Idempotency-Key`** on `ryft-terminal-payment` | Retried invoke does not double-charge | **No — live risk, ship today** |
| **3** | **Location-id resolution** for `location_reader_settings` (POS uses raw ops id; BO writes platform id) | BO sets 10% → POS reads 10%, not the `[15,18,20]` default | **No** |
| **4** | **Fee base = `due_minor`** + a test that nothing reduces `closed_checks.tip` | Tip-gross invariant green | **No** |
| **5** | **Send Ryft the ask** (list below) — longest lead time, gates rollout | — | — |
| **6** | `terminal_devices` migration + BO pairing panel | Pair a PAX, see it online. No payments involved. | **No** |
| **7** | `terminal_jobs` migration + both mutex indexes + all RPCs | `psql` alone: two inserts on one `check_key` → `23505` | **No** |
| **8** | Training gates + `terminal-job-status` read path + `check_draft` completeness | Training till cannot dispatch; draft carries `staff_id`/`source`/`ref` | **No** |
| **9** | `terminal-job-create` + `startTerminalJob` + the `handleCardPress` branch | POS dispatches, row appears, POS polls it | **No** |
| **10** | Terminal: register / claim / heartbeat / poll / WAL / `TipConfig.fromJson` | **Full end-to-end on real hardware against the stub.** Tip screen, controller launch, result, check closes with tip split. | **No** |
| **11** | Server finalisation **+** POS reconciler (ship together, never apart) | Kill the POS mid-sale → check still closes, table clears | **No** |
| **12** | Sweeper + `unknown` quarantine + BO screen + runbook | Force an unknown → lands in the queue, manager resolves | **No** |
| **13** | `SplitModal` per-leg jobs | Split 3 ways on one PAX | **No** |
| **14** | `HttpG8CloudClient` — one new file, one construction site, `SIMULATED = false` | Real card charged | **YES** |

Milestones 1–4 are independently shippable fixes to **live money paths**. They should not wait on the PAX programme.

---

## What we still need from Ryft

1. **The G8:Cloud REST spec** — base URL, auth, start-transaction and result endpoints.
2. **Does start-transaction accept an idempotency key?** If not, every timeout is permanently unknown. **Go-live blocker.**
3. **Can we look up a transaction by our own merchant reference?** Without it there is no recovery from a start-transaction timeout. **Go-live blocker.**
4. **Where does the G8 credential live** — may it sit on the device, or must the call originate server-side? Decides whether the swap points at `HttpG8CloudClient` or `EdgeProxyG8CloudClient`. Same one line either way.
5. **Does the STS controller show its own tip prompt** on top of ours? If yes, the customer is double-prompted and the whole model needs rethinking. Cheap to ask, expensive to discover.
6. **How is a G8 transaction refunded**, and what identifier does it use? Today a PAX sale would route to the wrong refund path.
7. **Does `platformFee` survive** when we send one combined total?
8. **What identifier addresses a terminal over G8** — the Ryft `tmnl_` id, the serial, or a TID? We capture all three on heartbeat now, because it is free today and unavailable retroactively.

---

## Risks

1. **Double tip prompt.** If the STS controller shows its own tip screen, the customer is asked twice and the second amount is invisible to us. The entire feature rests on this being false, and it is unverified. **Confirm before go-live.**
2. **No server-side recovery until the spec lands.** The reconciler cannot query G8. A PAX that is lost, wiped, or dies mid-charge loses the sale record — recoverable only by hand against the Ryft dashboard. Bounded, documented, pilot-only. **Must be in the runbook, not discovered by the operator.**
3. **Anonymous bearer token on a device that moves money.** The PAX's anon session sits on a unit carried round a venue and left on tables. Scoped to its own jobs, heartbeat-gated, BO-revocable — better than `devices`/`claim_device`, but not eliminated. Needs a rotation story before wide rollout.
4. **Amount drift between dispatch and charge.** `check_draft` is frozen; the live cart is not. A round added after dispatch produces a check whose items and charged amount disagree. **Must lock the check while a job is live.**
5. **Tip stranded with no recipient.** An `unknown` job means the customer was charged a gratuity that never reaches tronc. Under the Tipping Act 2023 an indefinitely unresolved job is a statutory breach. The queue needs an SLA and no "dismiss" button.
6. **The reconcile queue becomes noise.** If ordinary customer cancellations land there, staff rubber-stamp it and the one genuine unknown gets mis-resolved. The `charging_unsent` / `charging` split exists solely to prevent this — do not collapse it.
7. **`tip_percentages int[]` cannot express 12.5%**, which is the app's own default. Back Office literally cannot produce it. Migrate to `numeric[]` **before** the first venue configures bands.
8. **Cross-DB soft link rots.** `terminal_devices.ryft_terminal_id` → Platform `payment_devices`, text, no FK, nothing cleans it up. A retired PAX leaves a dangling id. Needs a BO consistency check.
9. **Scope temptation.** Once the transport works against the stub it will look finished. It is not — `SIMULATED = true` means no card is ever charged. Keep that flag on the terminal's own screen, prefix every stub txn id `STUB-`, and add a trigger asserting `simulated = false` on any production `closed_checks` write.