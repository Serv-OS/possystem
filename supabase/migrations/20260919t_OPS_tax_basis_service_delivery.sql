-- 20260919t_OPS_tax_basis_service_delivery.sql  (Ops DB, hand apply in the SQL editor)
--
-- v5.9.12: US sales tax on the right amount.
--
-- 1. Two per tax line switches the engine reads (taxEngine.lineBasisSettings):
--      tax_service_charge  the line also taxes its share of a mandatory service charge
--      tax_delivery_fee    the line also taxes its share of the delivery fee
--    null = not set: the till applies the US default (service ON for an added-on
--    percentage line, delivery OFF). Back Office always writes an explicit value.
--
-- 2. Existing ADDED-ON (exclusive) percentage lines move to tax_basis
--    'post_discount' (discounts reduce the taxed amount, as in most US states).
--    Safe: until v5.9.12 no till ever passed a discounted price, so the old
--    'pre_discount' value on these rows was the column default, never a choice,
--    and no US check has been taken yet (The Cabin: 0 checks). Only rows this
--    migration has never seen (tax_service_charge still null) are moved, and the
--    next statement fills that column, so re-running never overrides a choice
--    made after it (Back Office always writes both switches explicitly).
--    Inclusive (UK VAT) lines are NOT touched: UK stays byte identical.
--
-- Re-runnable: every statement is IF NOT EXISTS or guarded. No transaction
-- wrapper (the SQL editor chokes on begin/commit).

alter table public.tax_profile_lines add column if not exists tax_service_charge boolean;
alter table public.tax_profile_lines add column if not exists tax_delivery_fee boolean;

comment on column public.tax_profile_lines.tax_service_charge is
  'v5.9.12: this line also taxes its share of a mandatory service charge. null = US default (on for exclusive rate lines).';
comment on column public.tax_profile_lines.tax_delivery_fee is
  'v5.9.12: this line also taxes its share of the delivery fee. null = default (off).';

update public.tax_profile_lines
   set tax_basis = 'post_discount'
 where mode = 'exclusive'
   and line_type = 'rate'
   and tax_basis = 'pre_discount'
   and tax_service_charge is null;

update public.tax_profile_lines
   set tax_service_charge = (mode = 'exclusive' and line_type = 'rate')
 where tax_service_charge is null;

update public.tax_profile_lines
   set tax_delivery_fee = false
 where tax_delivery_fee is null;

-- Verify after applying (expect: every exclusive rate line post_discount + service true,
-- every inclusive line pre_discount + false + false):
--   select mode, line_type, tax_basis, tax_service_charge, tax_delivery_fee, count(*)
--     from public.tax_profile_lines group by 1,2,3,4,5 order by 1,2;
