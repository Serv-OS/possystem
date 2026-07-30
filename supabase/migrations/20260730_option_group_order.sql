-- 20260730_option_group_order.sql   (OPS DB — APPLIED LIVE 30 Jul 2026)
--
-- Combined option-flow ordering (v5.5.948). An item's modifier groups and
-- instruction groups are two separately-assigned lists with no way to sort one
-- against the other; every surface hard-coded "instructions first" (v5.5.947).
-- This column stores ONE combined order — an array of group ids mixing both
-- kinds — written by drag-reordering on Back Office → item → Flow, and read by
-- src/lib/optionFlow.js on POS / kiosk / online / MPOS. Null = default order
-- (instructions first, then modifier groups as assigned).

alter table menu_items add column if not exists option_group_order jsonb;
