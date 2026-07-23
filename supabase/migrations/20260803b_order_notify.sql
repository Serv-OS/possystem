-- 20260803b_order_notify.sql — server-side order confirmation + ready notifications
--
-- Wires the Back Office → Messages "Orders" section for EVERY order channel at the database
-- layer: a trigger on order_queue calls the order-notify edge function via pg_net on
--   INSERT                  → event 'confirmed'   (order placed: online, kiosk, QR, POS, …)
--   UPDATE status → 'ready' → event 'ready'       (staff marked ready in OrdersHub)
-- Exclusions live in the edge fn (hubrise = 3rd party; catering has its own confirmation email;
-- delivery orders skip 'ready' — they get courier tracking). The trigger NEVER blocks the order
-- write: the http call is fire-and-forget inside its own exception guard.
--
-- notify_confirmed_at / notify_ready_at are claim-before-send stamps written by the edge fn
-- (same idempotency pattern as kitchen_routed_at) so retries never double-send.

begin;

alter table order_queue add column if not exists notify_confirmed_at timestamptz;
alter table order_queue add column if not exists notify_ready_at timestamptz;

create extension if not exists pg_net;

create or replace function tg_order_queue_notify() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  evt text;
begin
  if tg_op = 'INSERT' then
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

drop trigger if exists order_queue_notify on order_queue;
create trigger order_queue_notify
  after insert or update of status on order_queue
  for each row execute function tg_order_queue_notify();

commit;
