-- 20260621b — per-venue "auto-print customer receipt for incoming delivery orders" toggle.
alter table hubrise_connections add column if not exists auto_print_receipt boolean not null default true;
