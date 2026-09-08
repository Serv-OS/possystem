-- 20260806b_stamp_idem_index.sql
--
-- ⚠ OPS DB ONLY — project ref tbetcegmszzotrwdtqhi
--   (the guard below aborts if you run it against the Platform DB)
--
-- THIS ADDS NOTHING TO THE LIVE DATABASE. It makes something that is already
-- there rebuildable.
--
-- WHAT DEPENDS ON IT
-- supabase/functions/loyalty-redeem/index.ts:120 treats a 23505 unique violation
-- on the stamp_transactions INSERT as "this reward has already been handed over"
-- and returns already_processed. The comment above it (:98) is explicit that the
-- ledger row IS the redemption and that its UNIQUE idempotency_key is the only
-- thing that can settle two concurrent redeems — the availability pre-check at
-- :94 cannot, because both callers pass it before either inserts. Without the
-- index there is no 23505, both inserts succeed, and one completed stamp card
-- pays out twice. loyalty-earn/index.ts:237 reads the same key to skip
-- already-awarded stamps.
--
-- WHY IT NEEDED WRITING DOWN
-- stamp_transactions has NO `create table` anywhere in this repo —
-- PRE_STAGE_READINESS.md:66 lists it among 25 live Ops tables with no
-- reproducible DDL. So from source alone the constraint the redeem path relies
-- on is unprovable, which is exactly what two reviewers flagged.
--
-- VERIFIED LIVE 5 Aug 2026 against tbetcegmszzotrwdtqhi:
--     idx_stamp_txn_idempotency  UNIQUE (idempotency_key) WHERE idempotency_key IS NOT NULL
-- exists. There is NO live risk today, and applying this file to production is a
-- no-op. It exists so that a database rebuilt from migrations — staging, or a
-- restore — comes up with the same index instead of silently losing the only
-- guard on the redeem race.
--
-- ⚠ IT DOES NOT MAKE THE TABLE REPRODUCIBLE. stamp_transactions itself still has
-- no DDL in the repo, so this file cannot create the index on an empty database;
-- the precheck below fails loudly rather than letting a rebuild believe it is
-- covered. The fix for that is the `pg_dump --schema-only` replay described in
-- PRE_STAGE_READINESS.md:66, which needs Peter's DB password.

begin;

-- Wrong-database guard. Ops has user_locations and no billing_state; Platform is
-- the other way round (same test as 20260805c Section A).
do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception
      'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it — aborting.';
  end if;
end
$guard$;

do $precheck$
begin
  if to_regclass('public.stamp_transactions') is null then
    raise exception
      'public.stamp_transactions does not exist. This file reproduces an INDEX; the table itself has no CREATE TABLE in this repo (PRE_STAGE_READINESS.md:66). Restore the schema with pg_dump --schema-only from tbetcegmszzotrwdtqhi first — do not hand-write the table.';
  end if;
end
$precheck$;

-- Reproduced in the exact live form. The predicate is not what allows multiple
-- key-less rows — a plain UNIQUE index already permits many NULLs (NULLS
-- DISTINCT is the Postgres default) — it just keeps the index to the rows that
-- carry a key. It is written this way because that is what is live, and a
-- rebuild that differs from production is worth nothing.
--
-- Not CONCURRENTLY: it has to run inside this file's transaction, and on the
-- live database it is a no-op anyway.
create unique index if not exists idx_stamp_txn_idempotency
  on public.stamp_transactions (idempotency_key)
  where idempotency_key is not null;

-- `create unique index if not exists` matches on NAME ONLY. If an index of this
-- name already existed in some other shape — non-unique, or on another column —
-- the statement above would have quietly done nothing and the 23505 loyalty-redeem
-- depends on would never be raised. Assert the shape rather than assume it.
do $verify$
declare
  def text;
begin
  select pg_get_indexdef(i.indexrelid) into def
    from pg_index i
    join pg_class c     on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'idx_stamp_txn_idempotency';

  if def is null then
    raise exception 'idx_stamp_txn_idempotency was not created — aborting.';
  end if;
  if def not like '%UNIQUE%' or def not like '%(idempotency_key)%' then
    raise exception
      'idx_stamp_txn_idempotency exists but is not a UNIQUE index on idempotency_key (%). loyalty-redeem depends on the 23505 it raises — fix this by hand before going further.', def;
  end if;
end
$verify$;

commit;


-- ── Sibling indexes — NOT VERIFIED, DELIBERATELY NOT CREATED ──────────────
-- This file reproduces what is known to be live, and nothing else. These are the
-- other lookup shapes the loyalty code uses against stamp_transactions;
-- whether an index backs any of them was NOT checked against the live database,
-- so nothing is written for them here. Adding one would be a performance change,
-- which is a different kind of change from this file and needs its own decision.
-- Check them with the query at the bottom before either reproducing or adding:
--   (customer_id, program_id, type)  loyalty-redeem:79 and loyalty-otp:527
--                                    — a COUNT per programme, on the customer's
--                                      redeem path
--   (customer_id, type, program_id)  loyalty-balance:185 — one grouped read at
--                                      every balance lookup (kiosk/online/POS)
--   (created_at)                     reports/LoyaltyReport.jsx:66 — date-range
--                                      scan, ordered, limit 500
--
-- ── Post-apply verification (run separately) ──────────────────────────────
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public' and tablename = 'stamp_transactions'
--    order by indexname;
--
-- ── Smoke test ────────────────────────────────────────────────────────────
-- 1. Customer with a completed stamp card: redeem it at checkout — it applies once.
-- 2. Redeem the same completed card again on the same check — the second attempt
--    must come back already_processed / "Reward already redeemed", not a second
--    free item.
