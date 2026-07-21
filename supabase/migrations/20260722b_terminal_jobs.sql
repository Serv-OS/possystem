-- ─────────────────────────────────────────────────────────────────────────────
-- 20260722b_terminal_jobs.sql   (OPS DB)
--
-- PaxPay: one row per payment dispatched to a PAX terminal. This row — not the
-- POS's memory, not the terminal's memory — is the single source of truth for
-- the money from the moment the job is created.
--
-- Spec: docs/PAXPAY_TRANSPORT_SPEC.md § "The data model" + § "Money-safety rules".
--
-- SECURITY MODEL (payments table — the same rules as terminal_devices)
--   * NO INSERT / UPDATE / DELETE POLICIES AT ALL.
--       INSERT -> terminal-job-create edge function (location_id server-resolved).
--       UPDATE -> SECURITY DEFINER RPCs (20260722c). The tip split is money; it
--                 feeds tronc under the Tipping Act 2023.
--       DELETE -> never. A money row is never deleted; cancelled/expired are states.
--   * An anonymous session (kiosk / QR / online) holds a valid auth.uid(). An
--     INSERT policy here would let anyone on the internet mint payment jobs.
--   * SELECT is fenced to the target terminal's own jobs, or to Back Office staff
--     at that location.
--
-- DO NOT add an INSERT, UPDATE or DELETE policy to this table.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists terminal_jobs (
  id                 uuid primary key,        -- POS-minted. Also the idempotency key + log id.
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
  reported_minor     bigint,                                         -- what the DEVICE claims. Compared, not trusted.
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

  -- The money invariant, enforced by the DB rather than by a caller remembering it.
  constraint tj_charge_identity
    check (charge_minor is null or tip_minor is null or charge_minor = due_minor + tip_minor)
);

-- MUTEX 1: one live job per payable check. Blocks the double-press / refresh /
-- two-tills double charge. terminal-job-create returns the EXISTING row on 23505
-- — it never mints a second job.
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

-- SELECT (terminal) — the target terminal reads ONLY jobs addressed to it, so a
-- stolen anon token from one venue cannot read another venue's checks or card data.
drop policy if exists tj_select_terminal on terminal_jobs;
create policy tj_select_terminal on terminal_jobs for select using (
  target_terminal_id in (select id from terminal_devices where device_uid = auth.uid() and active)
);

-- SELECT (Back Office) — staff read their own locations for the reconcile screen.
drop policy if exists tj_select_bo on terminal_jobs;
create policy tj_select_bo on terminal_jobs for select using (
  location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);

-- DELIBERATELY NOT: a SELECT policy for the POS till. pos_can_access() depends on
-- devices.device_uid, which claim_device() stamps best-effort and both call sites
-- swallow the failure. A till whose claim silently failed would dispatch fine and
-- then be unable to read its own job — waiting forever on a card that was already
-- charged. The POS reads through the terminal-job-status edge function instead,
-- which authorises the same way terminal-job-create does.

-- NO INSERT / UPDATE / DELETE POLICIES. See the header.


-- ─────────────────────────────────────────────────────────────────────────────
-- active_sessions: server-readable authoritative bill (for Table Pay, mode 1)
--
-- WHY: terminal_start_table_payment() must never trust an amount from the
-- terminal, and it must not fork the POS pricing engine into SQL (item
-- discounts, check discounts, scheduled auto-discounts, per-profile service
-- charge, delivery surcharge and tax all live in JS and change often — a SQL
-- re-implementation would drift and quietly mischarge).
--
-- So the POS — which OWNS the pricing engine — stamps its own computed totals
-- onto the session row it already writes every flush (SessionSync.js). The
-- terminal cannot write these columns (active_sessions RLS is unchanged and the
-- terminal never writes sessions), and terminal_start_table_payment REFUSES to
-- create a job when total_minor is absent. Fail closed: no stamped total, no
-- Table Pay — never a guessed amount.
--
-- Separate columns, deliberately NOT inside the `session` jsonb: the jsonb blob
-- is compared verbatim by SessionSync's _lastSent latch and by
-- SessionReconciler's full-session diff. Adding derived fields inside it would
-- perturb both, and "tables MUST never be lost between updates" outranks tidiness.
-- ─────────────────────────────────────────────────────────────────────────────
alter table active_sessions add column if not exists subtotal_minor bigint;
alter table active_sessions add column if not exists total_minor    bigint;
alter table active_sessions add column if not exists totals_at      timestamptz;
