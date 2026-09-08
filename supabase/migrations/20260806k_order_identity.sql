-- 20260806k_order_identity.sql
--
-- ⚠ OPS DB ONLY — project ref tbetcegmszzotrwdtqhi
--
-- Order numbers were never unique, and the order queue was keyed on them.
--
-- THE INTENT (from the owner): R1..R99 was never meant to be an identity. It is a DISPLAY
-- convenience so staff can call "order 47" across a collection counter. The number underneath was
-- always meant to be unlimited and unique. The implementation made the SHORT form the identity.
--
-- WHAT THAT ACTUALLY CAUSED, all verified live on 6 Aug 2026:
--   * next_order_number() and location_order_counters DO NOT EXIST. 20260430_order_number_counter.sql
--     was written in April and never applied, so src/lib/db.js always fell through to a PER-DEVICE
--     localStorage counter doing (cur % 99) + 1. Every till minted its own numbers.
--   * closed_checks holds 185 refs matching ^R[0-9]+$, and 27 of them have been used MORE THAN ONCE.
--   * order_queue's PRIMARY KEY is `ref` ALONE — a single global namespace shared by every venue.
--     A recycled ref does not error, it UPSERTS ONTO THE EXISTING ROW.
--
-- Two earlier attempts at this were rejected in review, and both failures are instructive:
--   * one keyed receipt de-duplication on the ref, which would have matched two unrelated sales and
--     silently suppressed a real customer's receipt;
--   * one seeded a per-location counter while the queue key was still global, so two venues would
--     mint the same ref and the second would overwrite the first venue's live order.
-- Part 1 below is what makes per-location numbering safe. It must come first.

begin;

do $guard$
begin
  if to_regclass('public.order_queue') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is for the OPS DB (tbetcegmszzotrwdtqhi). Wrong database — aborting.';
  end if;
end
$guard$;

-- ══════════════════════════════════════════════════════════════════════════
-- PART 1 — give the order queue a per-venue key. This is the actual defect.
-- ══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS CANNOT FAIL ON EXISTING DATA, so nobody has to be brave about it:
-- `ref` is CURRENTLY the primary key, so it is already globally unique. Adding a column to a key
-- can only ever make it more permissive. Verified anyway before writing this: 16 rows, zero NULL
-- location_id, zero NULL ref, and zero duplicate (location_id, ref) pairs.
--
-- The row count is asserted either side. A primary-key swap that silently drops rows would be the
-- worst possible outcome of a migration meant to protect orders, so it is checked rather than assumed.

do $part1$
declare
  n_before bigint;
  n_after  bigint;
begin
  select count(*) into n_before from public.order_queue;

  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.order_queue'::regclass and conname = 'order_queue_pkey'
  ) then
    -- Re-check rather than trust the comment above: if somebody has since inserted a genuine
    -- duplicate pair, abort loudly instead of half-applying.
    if exists (
      select 1 from public.order_queue group by location_id, ref having count(*) > 1
    ) then
      raise exception
        'order_queue has duplicate (location_id, ref) pairs — resolve those before re-running.';
    end if;
    if exists (select 1 from public.order_queue where location_id is null or ref is null) then
      raise exception 'order_queue has NULL location_id or ref — a primary key cannot span them.';
    end if;

    alter table public.order_queue drop constraint order_queue_pkey;
    alter table public.order_queue add constraint order_queue_pkey primary key (location_id, ref);
  end if;

  select count(*) into n_after from public.order_queue;
  if n_after <> n_before then
    raise exception 'order_queue row count changed during the key swap: % -> %. Rolling back.',
      n_before, n_after;
  end if;
end
$part1$;

comment on constraint order_queue_pkey on public.order_queue is
  'v5.5.986: was (ref) alone, which put every venue in ONE namespace — a recycled ref from another venue silently UPSERTED onto a live order. Order refs recycle (see next_order_number below and src/lib/db.js), so the venue must be part of the key. Client upserts use onConflict: location_id,ref.';

-- ══════════════════════════════════════════════════════════════════════════
-- PART 2 — the atomic counter that was written in April and never applied.
-- ══════════════════════════════════════════════════════════════════════════
-- Shape, SECURITY DEFINER choice, single-statement row lock and grant are all taken from
-- 20260430_order_number_counter.sql, which was sound. Three deliberate changes:
--   * counter is bigint and only ever INCREASES. The original did (counter % 99) + 1, which is the
--     recycling this migration exists to end.
--   * each location is seeded ABOVE every ref already issued anywhere, derived from the data.
--   * EXECUTE is revoked from public (CREATE FUNCTION grants it by default) and granted only to
--     authenticated. Kiosk and online sign in anonymously and still hold `authenticated`, so they
--     are unaffected; an unauthenticated caller can no longer burn order numbers.
--
-- Per-location seeding is only safe BECAUSE of Part 1. Without the venue in the queue key, two
-- locations counting independently would eventually mint the same ref and overwrite each other.

create table if not exists public.location_order_counters (
  location_id text primary key,
  counter     bigint      not null default 0,
  updated_at  timestamptz not null default now()
);

alter table public.location_order_counters enable row level security;

do $seed$
declare
  v_floor bigint;
begin
  -- Highest number ever issued, across BOTH tables. Anything at or below this could collide with a
  -- ref that already exists; order_queue's key would absorb the collision as an UPSERT.
  select greatest(
           coalesce((select max((regexp_replace(ref,'^R',''))::bigint)
                       from public.closed_checks where ref ~ '^R[0-9]+$'), 0),
           coalesce((select max((regexp_replace(ref,'^R',''))::bigint)
                       from public.order_queue   where ref ~ '^R[0-9]+$'), 0)
         ) + 1000
    into v_floor;

  -- Seed every location that exists or has ever issued a ref. `where ... < excluded.counter` means
  -- a re-run can only ever move a counter FORWARD; it can never reissue a number already handed out.
  insert into public.location_order_counters (location_id, counter, updated_at)
  select l.id::text, v_floor, now() from public.locations l
  union
  select distinct q.location_id, v_floor, now() from public.order_queue q where q.location_id is not null
  on conflict (location_id) do update
    set counter    = excluded.counter,
        updated_at = now()
    where location_order_counters.counter < excluded.counter;

  -- Baked into the function body so a location created LATER also starts above the legacy band
  -- rather than at 1.
  execute format($fn$
    create or replace function public.next_order_number(p_location_id text)
    returns text
    language plpgsql
    security definer
    set search_path = public
    as $body$
    declare v_next bigint;
    begin
      insert into public.location_order_counters (location_id, counter, updated_at)
      values (p_location_id, %s, now())
      on conflict (location_id) do update
        set counter = location_order_counters.counter + 1, updated_at = now()
      returning counter into v_next;
      return 'R' || v_next;
    end;
    $body$;
  $fn$, v_floor);
end
$seed$;

-- ⚠ `from public` is NOT enough on this project, and the first apply proved it: the function came
-- out with anon=X still on its ACL. Supabase ships ALTER DEFAULT PRIVILEGES in schema public that
-- grants EXECUTE to anon on every newly created function, and that is an EXPLICIT grant to a named
-- role — revoking from PUBLIC does not remove it. anon must be named. The same trap is documented
-- in the schema baseline (000_baseline_ops.sql, section 10a) and it silently re-opens anything a
-- migration assumes it has closed.
revoke all on function public.next_order_number(text) from public;
revoke execute on function public.next_order_number(text) from anon;
grant execute on function public.next_order_number(text) to authenticated, service_role;

comment on function public.next_order_number(text) is
  'Atomic per-location order number. Monotonic — never wraps. Seeded above every ref already issued so it cannot collide with historical R1..R99. The single-statement upsert serialises concurrent callers on the row lock.';

commit;


-- ── Verify ────────────────────────────────────────────────────────────────
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid='public.order_queue'::regclass and contype='p';
--     -> PRIMARY KEY (location_id, ref)
--
--   select count(*) from order_queue;            -- must still be 16
--   select location_id, counter from location_order_counters;
--   select public.next_order_number('7218c716-eeb4-4f96-b284-f3500823595c');   -- R1100 or higher
--
-- ⚠ Once this is applied, NEVER run 20260430_order_number_counter.sql. Its CREATE OR REPLACE would
--   overwrite the function body and put the counter back into a 1-99 cycle.
