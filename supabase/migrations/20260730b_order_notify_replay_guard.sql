-- 20260730b_order_notify_replay_guard.sql   (OPS DB — APPLIED LIVE 30 Jul 2026)
--
-- A months-stale POS came online and its QueueSync re-INSERTED week-old
-- order_queue rows (the originals were long gone). The notify trigger fires
-- 'confirmed' on every INSERT and its claim stamp (notify_confirmed_at) lives ON
-- the row — a re-created row has a fresh null stamp, so five customers got
-- "order confirmed" texts for 23 Jul orders on 30 Jul.
--
-- Two guards, both server-side so NO client (however ancient) can replay:
--   1. order_notifications ledger — one row per (ref, event), FOREVER. Survives
--      order_queue row deletion/re-creation. The edge fn claims here first.
--   2. Trigger age gate — an INSERT whose created_at is older than 6 hours never
--      even calls out (replayed payloads carry their original created_at —
--      verified on the live zombies).

begin;

create table if not exists order_notifications (
  ref     text not null,
  event   text not null,
  sent_at timestamptz not null default now(),
  primary key (ref, event)
);
alter table order_notifications enable row level security;
-- service-role only (the edge fn); no client policies on purpose.

-- Backfill from the existing per-row stamps so live rows can't re-claim.
insert into order_notifications (ref, event, sent_at)
  select ref, 'confirmed', notify_confirmed_at from order_queue where notify_confirmed_at is not null
on conflict do nothing;
insert into order_notifications (ref, event, sent_at)
  select ref, 'ready', notify_ready_at from order_queue where notify_ready_at is not null
on conflict do nothing;

create or replace function tg_order_queue_notify() returns trigger
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
  begin
    perform net.http_post(
      url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/order-notify',
      body := jsonb_build_object('ref', new.ref, 'event', evt),
      headers := jsonb_build_object('Content-Type', 'application/json')
    );
  exception when others then
    null;
  end;

  return new;
end;
$$;

commit;
