-- 20261107a_PLATFORM_processor_defaults_adyen.sql (29 Oct 2026, v5.11.116). PLATFORM project.
-- Adyen is the only processor ServOS works with. These column defaults still said 'stripe', so a
-- row written without a processor was labelled for a processor no live venue uses.
alter table public.locations            alter column payment_processor set default 'adyen';
alter table public.gift_card_purchases  alter column processor         set default 'adyen';
alter table public.payment_devices      alter column processor         set default 'adyen';
-- VERIFY (read only):
--   select table_name, column_name, column_default from information_schema.columns
--    where column_name in ('payment_processor','processor') and table_name in ('locations','gift_card_purchases','payment_devices');
