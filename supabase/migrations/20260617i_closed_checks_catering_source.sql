-- Allow source='catering' on closed_checks (paid catering orders write a closed_checks row like online).
-- The existing CHECK only permitted pos/kiosk/online/mobile, which silently broke catering pay-now.
alter table closed_checks drop constraint if exists closed_checks_source_check;
alter table closed_checks add constraint closed_checks_source_check
  check (source = any (array['pos'::text, 'kiosk'::text, 'online'::text, 'mobile'::text, 'catering'::text]));
