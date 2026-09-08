-- v5.5.56 — Add source column to order_queue
-- Ops DB: tbetcegmszzotrwdtqhi
-- Tracks where orders originate (pos, kiosk, online, etc.)

alter table order_queue add column if not exists source text default 'pos';
