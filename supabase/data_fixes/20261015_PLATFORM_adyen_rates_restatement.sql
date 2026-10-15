-- 20261015_PLATFORM_adyen_rates_restatement.sql
-- PLATFORM project. Peter runs this in the Supabase SQL editor, in the order below, AFTER
--   1. supabase/migrations/20261015_PLATFORM_adyen_rates_cutover.sql (the columns)
--   2. the v5.11.63 deploy (adyen-webhook first)
--   3. Write these rates to Adyen on each venue's Card rates box (that sets rates_live_at)
-- Every part is safe to run twice. No venue name, profile id or figure is written in this file:
-- the profile ids are read from the rows at run time and shown by part 0.
--
-- WHAT IT DOES. Payments authorised before a venue's cutover were charged by Adyen at the flat
-- rate of the profile the store carried (a flat 0.85% on every card, nothing back on refunds),
-- while our ledger stamped them from the rate card. This restates commission_minor on those rows
-- to what Adyen took, marks each one (fee_rule legacy_flat, fee_refund_policy none) so nothing is
-- restated twice and the webhook backfill agrees with it, and keeps the old figures in raw.restated.
-- rate_category is left alone: it names the card type the venue sees as a chip, and a business card
-- charged 0.85% is still a business card.

-- ── PART 0, READ ONLY: what is on the rows now ───────────────────────────────────────────────
-- One line per live venue: its profile id, its cutover instant, its legacy charge, and how many
-- live payments would be restated by part 3 as things stand.
select
  m.location_id,
  m.split_profile_id,
  m.rates_live_at,
  m.legacy_charge,
  (select count(*) from public.adyen_payments p
     where p.location_id = m.location_id and p.live = true and p.fee_rule is null
       and m.rates_live_at is not null and p.authorised_at < m.rates_live_at) as rows_to_restate,
  (select count(*) from public.adyen_payments p
     where p.location_id = m.location_id and p.live = true and p.fee_rule = 'legacy_flat') as rows_already_restated
from public.merchant_adyen_accounts m
where m.environment = 'live'
order by m.rates_live_at nulls last, m.location_id;

-- ── PART 1, THE LEGACY CHARGE PER PROFILE ────────────────────────────────────────────────────
-- set_split fills legacy_charge itself from the previous profile's catch all rule when it writes
-- the new rates, so for most venues this is already set and the statement touches nothing.
-- Fill in the profile id shown by part 0 for the five UK stores (they share one). The figures are
-- what the Read what Adyen charges panel showed for that profile BEFORE the write: 85 basis
-- points, no fixed fee, nothing back on refunds.
-- update public.merchant_adyen_accounts
--    set legacy_charge = '{"percent_bp": 85, "fixed_minor": 0, "refund": "none"}'::jsonb,
--        updated_at = now()
--  where environment = 'live'
--    and legacy_charge is null
--    and rates_live_at is not null
--    and split_profile_id = '<PROFILE ID FROM PART 0>';
--
-- The demo venue's old profile took 80 basis points plus 5 pence on its catch all. Set it the
-- same way with its own profile id, or leave it out (15 live payments).
-- update public.merchant_adyen_accounts
--    set legacy_charge = '{"percent_bp": 80, "fixed_minor": 5, "refund": "none"}'::jsonb,
--        updated_at = now()
--  where environment = 'live'
--    and legacy_charge is null
--    and rates_live_at is not null
--    and split_profile_id = '<DEMO PROFILE ID FROM PART 0>';

-- ── PART 2, PREVIEW (READ ONLY): what part 3 would do, per venue ─────────────────────────────
-- Rows, the fees as stamped now, the fees as Adyen took them, and the difference. Run it, read
-- it, and only then run part 3. A venue with no rates_live_at or no legacy_charge is not here.
with venue as (
  select location_id, rates_live_at,
         (legacy_charge->>'percent_bp')::numeric as bp,
         coalesce((legacy_charge->>'fixed_minor')::int, 0) as fixed
    from public.merchant_adyen_accounts
   where environment = 'live' and legacy_charge is not null and rates_live_at is not null
)
select
  v.location_id,
  count(*) as rows_to_restate,
  sum(coalesce(p.commission_minor, 0)) as fees_now_minor,
  sum(case when p.success then floor(p.amount_minor * v.bp / 10000 + 0.5) + v.fixed else 0 end) as fees_adyen_took_minor,
  sum(case when p.success then floor(p.amount_minor * v.bp / 10000 + 0.5) + v.fixed else 0 end) - sum(coalesce(p.commission_minor, 0)) as difference_minor
from public.adyen_payments p
join venue v on v.location_id = p.location_id
where p.live = true and p.authorised_at < v.rates_live_at and p.fee_rule is null
group by v.location_id
order by v.location_id;

-- ── PART 3, THE RESTATEMENT (WRITES; run once part 2 reads right) ────────────────────────────
-- Only live rows, only before the venue's cutover, only rows nobody has stamped under the new
-- scheme (fee_rule is null). The old figures are kept in raw.restated. Run twice, the second run
-- touches no row.
with venue as (
  select location_id, rates_live_at,
         (legacy_charge->>'percent_bp')::numeric as bp,
         coalesce((legacy_charge->>'fixed_minor')::int, 0) as fixed
    from public.merchant_adyen_accounts
   where environment = 'live' and legacy_charge is not null and rates_live_at is not null
)
update public.adyen_payments p
   set commission_minor = case when p.success then floor(p.amount_minor * v.bp / 10000 + 0.5) + v.fixed else null end,
       fee_rule = 'legacy_flat',
       fee_refund_policy = 'none',
       raw = coalesce(p.raw, '{}'::jsonb) || jsonb_build_object('restated', jsonb_build_object(
               'at', now(),
               'was_commission_minor', p.commission_minor,
               'was_rate_category', p.rate_category,
               'percent_bp', v.bp,
               'fixed_minor', v.fixed)),
       updated_at = now()
  from venue v
 where p.location_id = v.location_id
   and p.live = true
   and p.authorised_at < v.rates_live_at
   and p.fee_rule is null;

-- ── PART 4, THE TIE CHECK (READ ONLY): each settlement batch beside the bank ─────────────────
-- Per settlement batch of each venue: gross of the venue's Settled lines, less its refund lines,
-- less the restated fees on the matched payments, which is what the bank should have received.
-- Expect a few pence of rounding per batch, never pounds: per payment half up at 85 basis points
-- came to 12 pence under 0.85% of the batch gross on the batch checked on 15 Oct 2026, and only
-- the batch gross times 0.85% landed on the bank figure exactly. Adyen's own rounding is an open
-- question for Adyen support.
-- Fill in the venue's location id (part 0) and, if wanted, a batch reference.
-- with lines as (
--   select l.payout_id, l.line_type, l.gross_minor, l.psp_reference
--     from public.adyen_payout_lines l
--     join public.adyen_payouts po on po.id = l.payout_id
--    where po.location_id = '<LOCATION ID>' or l.location_id = '<LOCATION ID>'
-- ), fees as (
--   select psp_reference, commission_minor, fee_rule from public.adyen_payments where location_id = '<LOCATION ID>'
-- )
-- select
--   li.payout_id,
--   sum(case when li.line_type in ('Settled', 'SettledExternally') then li.gross_minor else 0 end) as settled_minor,
--   sum(case when li.line_type in ('Refunded', 'RefundedExternally') then li.gross_minor else 0 end) as refunded_minor,
--   sum(case when li.line_type in ('Settled', 'SettledExternally') then coalesce(f.commission_minor, 0) else 0 end) as fees_minor,
--   sum(case when li.line_type in ('Settled', 'SettledExternally') then li.gross_minor - coalesce(f.commission_minor, 0)
--            when li.line_type in ('Refunded', 'RefundedExternally') then li.gross_minor else 0 end) as venue_receives_minor,
--   count(*) filter (where li.line_type in ('Settled', 'SettledExternally') and f.commission_minor is null) as settled_lines_with_no_fee
-- from lines li
-- left join fees f on f.psp_reference = li.psp_reference
-- group by li.payout_id
-- order by li.payout_id desc;
