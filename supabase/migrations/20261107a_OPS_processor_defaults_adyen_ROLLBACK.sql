-- Rollback of 20261107a_OPS_processor_defaults_adyen.sql
alter table public.closed_checks  alter column processor set default 'stripe';
alter table public.terminal_jobs  alter column processor set default 'ryft';
