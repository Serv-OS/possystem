-- v5.5.57 — payment fields on order_queue + ledger of routed kiosk prints
-- Ops DB: tbetcegmszzotrwdtqhi

alter table order_queue add column if not exists paid boolean default false;
alter table order_queue add column if not exists payment_method text;
alter table order_queue add column if not exists kitchen_routed_at timestamptz;
