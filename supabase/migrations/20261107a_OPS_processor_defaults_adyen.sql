-- 20261107a_OPS_processor_defaults_adyen.sql (29 Oct 2026, v5.11.116). OPS project.
-- Adyen is the only processor ServOS works with. A closed bill written without a processor was
-- stamped 'stripe' (every cash bill), and a card job without one was stamped 'ryft'.
alter table public.closed_checks  alter column processor set default 'adyen';
alter table public.terminal_jobs  alter column processor set default 'adyen';
-- VERIFY (read only):
--   select table_name, column_default from information_schema.columns
--    where column_name = 'processor' and table_name in ('closed_checks','terminal_jobs');
