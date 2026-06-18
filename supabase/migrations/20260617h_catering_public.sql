-- Catering ordering — public read + order tagging (Module 1, step 2).
-- 1) Anonymous guests can't read catering_site_settings (RLS-fenced), so expose just the public config
--    via a SECURITY DEFINER RPC that returns the row ONLY when the site is enabled. No edge fn needed.
-- 2) event_date on order_queue so catering orders can be capacity-gated + shown on the calendar.

create or replace function catering_public_settings(p_location uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select to_jsonb(c) - 'created_at' - 'updated_at'
  from catering_site_settings c
  where c.location_id = p_location and c.enabled = true;
$$;
grant execute on function catering_public_settings(uuid) to anon, authenticated;

alter table order_queue add column if not exists event_date date;
create index if not exists order_queue_event_date_idx on order_queue (location_id, event_date) where event_date is not null;
