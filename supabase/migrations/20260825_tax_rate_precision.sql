-- 20260825_tax_rate_precision.sql  (ops DB — hand-apply via the SQL editor)
--
-- tax_rates.rate was numeric with 2dp-effective storage in places, which cannot
-- hold US-style rates like 8.875% (stored as the decimal 0.08875 — needs 5dp,
-- and combined city/county/state rates go finer). numeric(9,6) holds any real
-- percentage to a millionth. The app works BEFORE this is applied: rates simply
-- stay at their current precision until the column is widened.
begin;
alter table public.tax_rates alter column rate type numeric(9,6);
commit;
