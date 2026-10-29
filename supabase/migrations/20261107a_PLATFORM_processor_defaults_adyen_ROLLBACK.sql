-- Rollback of 20261107a_PLATFORM_processor_defaults_adyen.sql
alter table public.locations            alter column payment_processor set default 'stripe';
alter table public.gift_card_purchases  alter column processor         set default 'stripe';
alter table public.payment_devices      alter column processor         set default 'stripe';
