-- 20260806g_PLATFORM_claims_index.sql
--
-- ⚠ PLATFORM DB ONLY — project ref yhzjgyrkyjabvhblqxzu
--
-- loyalty_redemption_claims (created by 20260806c Section B) carries only its primary key on
-- idempotency_key. loyalty-reconcile filters and sorts it on created_at, so every page it reads
-- is a full scan and sort of a table its own header describes as append-only and never pruned.
--
-- Measured on a rebuilt copy at 300k rows: parallel sequential scan, ~6,750 shared buffers,
-- 290k rows discarded by the filter — per page, ten pages a tick, twenty-four ticks a day, on a
-- table that only grows. The identical query with this index was an index scan at ~78 buffers.
--
-- Composite rather than created_at alone: the reconciler pages with created_at as the sort key
-- and idempotency_key as the tie-break, so both columns in that order keep the whole page read
-- inside the index.

begin;

do $guard$
begin
  if to_regclass('public.loyalty_redemption_claims') is null then
    raise exception
      'loyalty_redemption_claims not found — this is for the PLATFORM DB (yhzjgyrkyjabvhblqxzu), and 20260806c Section B must be applied first. Aborting.';
  end if;
end
$guard$;

create index if not exists loyalty_redemption_claims_created_idx
  on public.loyalty_redemption_claims (created_at, idempotency_key);

comment on index public.loyalty_redemption_claims_created_idx is
  'Serves loyalty-reconcile''s paged anti-join scan. Without it each tick sequentially scans the whole append-only claims table.';

commit;
