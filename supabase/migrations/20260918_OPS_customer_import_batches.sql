-- 20260918_OPS_customer_import_batches.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL
-- editor. Claude cannot apply production DDL by any route.
--
-- Idempotent: create table if not exists, create index if not exists, and a
-- drop/add for every policy. Safe to run twice.
--
-- ────────────────────────────────────────────────────────────────────────────
-- THE APP WORKS BEFORE THIS FILE RUNS
-- ────────────────────────────────────────────────────────────────────────────
-- customer-import feature detects this table. A missing table answers 42P01
-- from Postgres, or PGRST205 from PostgREST's schema cache, and the function
-- treats both as "no batch list yet":
--
--   * the people still land in customers
--   * their opt in still lands in customer_consents
--   * their loyalty membership still lands in customer_loyalty
--   * their stamps still land in customer_stamp_cards
--   * every customer still carries its batch tag in customers.sources
--
-- The only thing missing is the list of past imports on the screen, and the
-- reply carries batch_table: false so the screen can say so in one plain line.
-- Nothing crashes and nothing is lost: the batch id is minted by the function
-- either way, and the tag on each customer is the durable record.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY THIS TABLE EXISTS
-- ────────────────────────────────────────────────────────────────────────────
-- Peter, 17 Sep 2026: "next week we start importing customer data for loyalty
-- from other platforms, moving stamp cards and auto creating their accounts."
--
-- A file of twenty thousand people arrives in slices of five hundred, one call
-- per slice, so the screen can show a bar. Every slice of one run carries the
-- same batch id. This row is that run: the file it came from, who ran it, what
-- it did, and which stamp card the stamps landed on.
--
-- It is what makes an import findable afterwards. Two things point back at it:
--
--   customers.source  = 'import'            the whole intake, as one segment
--   customers.sources @> ARRAY['import:<id>']  one exact run
--
-- `sources` and not `tags`, because `sources` is the append only channel list
-- that hubrise-ingest and wifi-capture already append to, it is NOT NULL
-- default {} so there is no null to trip over, and `source` is already a
-- marketing segment field, so "source is import" is an audience with nothing
-- new to whitelist. `tags` is written by nothing in the app and is nullable.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS TABLE IS NOT
-- ────────────────────────────────────────────────────────────────────────────
-- It is not the consent record. That is customer_consents, which is append only
-- and is what marketing-send reads before it emails anybody.
-- It is not the stamp record. That is stamp_transactions, whose UNIQUE
-- idempotency_key is the thing that stops a second run doubling a balance.
-- Deleting a row here loses the list, never a person, a permission or a stamp.

create table if not exists public.import_batches (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  company_id     uuid,
  program_id     uuid,
  filename       text,
  row_count      integer not null default 0,
  created_count  integer not null default 0,
  updated_count  integer not null default 0,
  skipped_count  integer not null default 0,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  notes          text
);

comment on table  public.import_batches           is 'One customer import run. Slices of one file share an id. See 20260918_OPS_customer_import_batches.sql.';
comment on column public.import_batches.org_id   is 'Ops tenant. Every Coffee Boy site shares one org, so an import reaches all three.';
comment on column public.import_batches.company_id is 'Platform company the loyalty memberships were written under.';
comment on column public.import_batches.program_id is 'The stamp card the stamps landed on. Null when the file carried no stamps.';
comment on column public.import_batches.notes    is 'The line the operator typed saying where these people opted in. Copied onto every consent row.';
comment on column public.import_batches.created_by is 'auth.uid() of the person who ran it. Null when the service role ran it.';

-- Newest first, per tenant. That is the only way the screen reads this table.
create index if not exists idx_import_batches_org_created
  on public.import_batches (org_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────────────────────
-- Read only, and only your own org's runs. There is deliberately NO insert,
-- update or delete policy: customer-import writes with the service role, which
-- is not subject to RLS, and nothing else has any business writing here.
--
-- The org test is the same join customers_all already uses (locations joined to
-- user_locations), so a user sees exactly the imports of the venues they can
-- already see the customers of. An anonymous session (kiosk, online, QR) is not
-- staff and gets nothing.

alter table public.import_batches enable row level security;

drop policy if exists import_batches_read on public.import_batches;
create policy import_batches_read on public.import_batches
  for select
  using (
    org_id in (
      select l.org_id
      from public.locations l
      join public.user_locations ul on ul.location_id = l.id
      where ul.user_id = auth.uid()
    )
  );

-- Belt and braces on the grants: the anon and authenticated roles may read (RLS
-- above still decides which rows), and neither may write.
revoke all on public.import_batches from anon, authenticated;
grant select on public.import_batches to anon, authenticated;
