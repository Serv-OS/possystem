-- 20260629d_order_activity_trigger.sql
-- Feed "orders coming in" into the activity timeline from a SINGLE source — a trigger on order_queue —
-- so every channel (kiosk / QR / online / catering) is captured with no client edits and no per-till
-- duplication. EXCEPTION-GUARDED: a feed-write failure can NEVER block or roll back an order.
create or replace function public.log_order_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into activity_events (location_id, kind, severity, title, body, ref_type, ref_id)
    values (
      new.location_id, 'order', 'info',
      initcap(coalesce(nullif(new.source, ''), nullif(new.type, ''), 'New')) || ' order',
      nullif(new.ref, ''),
      'order', new.ref
    );
  exception when others then null;  -- the activity feed must never break ordering
  end;
  return new;
end $$;

drop trigger if exists order_queue_activity on order_queue;
create trigger order_queue_activity after insert on order_queue for each row execute function public.log_order_activity();
