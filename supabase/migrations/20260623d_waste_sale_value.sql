-- 20260623d_waste_sale_value.sql
-- Capture the LOST SALE VALUE (forgone revenue) on a waste event, not just the
-- stock cost. When a sellable menu item is wasted, the venue loses both the stock
-- (cost_value) AND the sale it would have made (sale_value = sell price × qty).
-- Additive, nullable — existing rows keep sale_value null.

alter table waste_events
  add column if not exists sale_value numeric(14,2);
