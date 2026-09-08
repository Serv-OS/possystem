-- Catering kitchen-fire time: on the event day, the time catering orders should fire into the
-- kitchen (KDS + production tickets). HH:MM (venue local). Used by the catering order's sent_at +
-- (future) the in-app scheduler. Also the moment catering sales are dated to (production-day sales).
alter table catering_site_settings add column if not exists kitchen_fire_time text;
