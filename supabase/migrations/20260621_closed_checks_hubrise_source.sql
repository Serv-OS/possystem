-- 20260621_closed_checks_hubrise_source.sql
-- Allow source='hubrise' on closed_checks so completed HubRise (delivery channel) orders
-- can be booked into sales history + reports, like online/kiosk/catering. Mirrors the
-- catering source addition (20260617i).
alter table closed_checks drop constraint if exists closed_checks_source_check;
alter table closed_checks add constraint closed_checks_source_check
  check (source = any (array['pos'::text, 'kiosk'::text, 'online'::text, 'mobile'::text, 'catering'::text, 'hubrise'::text]));
