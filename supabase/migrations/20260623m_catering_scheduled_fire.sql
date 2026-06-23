-- ============================================================================
-- Catering scheduled-fire support (hold until event day, fire to kitchen at prep time).
-- 1) catering_public_settings now also returns the venue's IANA timezone, so the catering
--    storefront computes the kitchen fire time + sale date on the VENUE's clock, not the
--    customer's browser timezone.
-- 2) Ensure order_queue.kitchen_routed_at exists — it's the atomic cross-device claim that
--    routeKioskOrderPrints uses so a catering order fires (prints) exactly once across all
--    devices. (No-op if already present.)
-- ============================================================================

create or replace function catering_public_settings(p_location uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select (to_jsonb(c) - 'created_at' - 'updated_at')
         || jsonb_build_object('venue_timezone', coalesce(l.timezone, 'Europe/London'))
  from catering_site_settings c
  join locations l on l.id = c.location_id
  where c.location_id = p_location and c.enabled = true;
$$;
grant execute on function catering_public_settings(uuid) to anon, authenticated;

alter table order_queue add column if not exists kitchen_routed_at timestamptz;
