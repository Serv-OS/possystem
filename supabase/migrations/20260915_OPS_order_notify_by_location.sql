-- 20260915_OPS_order_notify_by_location.sql
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
--
-- Order texts were silently lost when two venues had an order with the same ref (finding F13).
--
-- Why
--   Order refs are per venue (next_order_number counts per location, and order_queue's key has
--   been (location_id, ref) since 20260806k). The notify trigger sent only { ref, event }, so
--   order-notify loaded the order with .eq('ref', ref).maybeSingle(). With the same ref at a
--   second venue that read returns 2 rows, PostgREST answers PGRST116, and the function returns
--   "order gone": no text. The replay ledger order_notifications is keyed (ref, event), so a text
--   sent for one venue's R12 also blocks every other venue's R12, for ever.
--   Verified on live 14 Sep 2026: 16 refs in order_queue are held by more than one venue
--   (48 rows), 10 ledger rows sit on those refs, none of those rows carries a notify stamp, and
--   two venues' counters are both at 1099, so both will issue R1100 next.
--
-- Adds
--   1. order_notify_ledger (location_id, ref, event)   the replay ledger, per venue
--   2. backfill of that ledger from order_queue's claim stamps (every order already texted)
--   3. tg_order_queue_notify()                          same trigger, now also sends location_id
--
-- Safety
--   Idempotent. Nothing on order_queue changes: no column, no key, no lock beyond the function swap.
--   The trigger still never blocks an order write (the http call stays inside its own guard) and
--   keeps the 6 hour age gate from 20260730b.
--   order_notifications (the old ledger) is NOT altered. Both deploy orders work:
--     * function deployed first, this not yet run: the payload has no location_id, the function
--       takes exactly today's path.
--     * this run first, function not yet deployed: the old function ignores location_id and
--       keeps using order_notifications, exactly as today.
--   Texts already sent live in order_notifications, which does not say which venue each was for.
--   Step 2 copies every stamped order into order_notify_ledger under its own venue, so those
--   orders can never be texted twice. For a legacy row with no stamped order left, the new function
--   blocks only when no other venue's order with that ref accounts for the row and the order being
--   texted already existed when it was written (5 minute allowance). Another venue's R1100 is not
--   blocked by this venue's R1100.
--
-- Rollback (only if needed). Run BOTH steps, in this order.
--   1. Copy the per venue ledger back into the old one FIRST. After this migration every text is
--      recorded only in order_notify_ledger; the reverted trigger sends no location_id, so the
--      function reads only order_notifications, and without this step a stale device replaying a
--      row would text those customers again:
--        insert into public.order_notifications (ref, event, sent_at)
--          select ref, event, min(sent_at) from public.order_notify_ledger group by ref, event
--        on conflict (ref, event) do nothing;
--   2. Re-run the create or replace function block from 20260730b_order_notify_replay_guard.sql.
--   Leave order_notify_ledger in place (an unused table is harmless).

set lock_timeout = '3s';

do $$ begin
  if to_regclass('public.order_queue') is null or to_regclass('public.order_notifications') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'Wrong database. Run this on the Ops project (tbetcegmszzotrwdtqhi).';
  end if;
end $$;

-- 1. Per venue replay ledger ------------------------------------------------------------------------
create table if not exists public.order_notify_ledger (
  location_id text        not null,
  ref         text        not null,
  event       text        not null,
  sent_at     timestamptz not null default now(),
  primary key (location_id, ref, event)
);

comment on table public.order_notify_ledger is
  'order-notify replay ledger, one row per (location_id, ref, event), ever. Refs repeat across venues, so the venue is part of the key. Replaces order_notifications (keyed ref, event) for trigger payloads that carry location_id. Service role only.';

alter table public.order_notify_ledger enable row level security;
-- Service role only (the edge function). No client policies on purpose. Supabase default
-- privileges grant anon and authenticated on new tables, and revoking from public does not
-- remove those named grants, so they are revoked by name.
revoke all on table public.order_notify_ledger from public, anon, authenticated;
grant select, insert, update, delete on table public.order_notify_ledger to service_role;

-- 2. Backfill from the claim stamps ----------------------------------------------------------------
-- Every order_queue row with a stamp was claimed for a text on that event, at its own venue. Copy
-- each into the per venue ledger so a replay of it is refused on the new path, whatever the old
-- (ref, event) row says. Re-running adds nothing (on conflict do nothing).
insert into public.order_notify_ledger (location_id, ref, event, sent_at)
  select location_id::text, ref, 'confirmed', notify_confirmed_at
    from public.order_queue
   where notify_confirmed_at is not null and location_id is not null and ref is not null
on conflict (location_id, ref, event) do nothing;

insert into public.order_notify_ledger (location_id, ref, event, sent_at)
  select location_id::text, ref, 'ready', notify_ready_at
    from public.order_queue
   where notify_ready_at is not null and location_id is not null and ref is not null
on conflict (location_id, ref, event) do nothing;

-- 3. The trigger sends the venue ----------------------------------------------------------------------
create or replace function public.tg_order_queue_notify() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  evt text;
begin
  if tg_op = 'INSERT' then
    -- Age gate: a "confirmed" for an order placed >6h ago is never right — it is a
    -- stale device replaying its queue, not a customer placing an order.
    if coalesce(new.created_at, now()) < now() - interval '6 hours' then
      return new;
    end if;
    evt := 'confirmed';
  elsif new.status = 'ready' and coalesce(old.status, '') <> 'ready' then
    evt := 'ready';
  else
    return new;
  end if;

  -- Fire-and-forget: a notification failure must never fail the order itself.
  -- location_id: refs are per venue, so the function needs both to find the one order.
  begin
    perform net.http_post(
      url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/order-notify',
      body := jsonb_build_object('ref', new.ref, 'event', evt, 'location_id', new.location_id),
      headers := jsonb_build_object('Content-Type', 'application/json')
    );
  exception when others then
    null;
  end;

  return new;
end;
$$;

-- The trigger itself is unchanged (after insert or update of status); recreate it only if missing.
do $$ begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.order_queue'::regclass and tgname = 'order_queue_notify' and not tgisinternal
  ) then
    create trigger order_queue_notify
      after insert or update of status on public.order_queue
      for each row execute function public.tg_order_queue_notify();
  end if;
end $$;

notify pgrst, 'reload schema';

-- Checks after running:
--   select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.order_notify_ledger'::regclass and contype = 'p';
--     -> PRIMARY KEY (location_id, ref, event)
--   select position('location_id' in pg_get_functiondef('public.tg_order_queue_notify'::regproc)) > 0;   (true)

-- VISIBLE CHECK (the SQL editor shows this last result). ledger_ready and trigger_sends_location must be
-- true; ledger_rows is at least the number of stamps copied in step 2 (6 on 14 Sep 2026).
select
  to_regclass('public.order_notify_ledger') is not null as ledger_ready,
  (select count(*) from public.order_notify_ledger) as ledger_rows,
  position('''location_id'', new.location_id' in pg_get_functiondef('public.tg_order_queue_notify'::regproc)) > 0 as trigger_sends_location;
