-- 20260930_link_barnsley_kiosk_card_sales.sql: link 12 Barnsley kiosk card sales to the card
-- machine payments that took the money, so the till can refund them to the card.
--
-- FOR PETER TO RUN in the Ops SQL editor (project tbetcegmszzotrwdtqhi). Not run by Claude.
-- No money moves. Nothing is deleted. Only closed_checks and terminal_jobs rows change, and only
-- the 12 sale and card payment pairs written out in step 1 (by id). Nothing else is ever updated.
--
-- WHY. Until the kiosk fix (fix/kiosk-refund-link-and-kds-notes) a kiosk card sale paid on an
-- Adyen card machine was booked under its own id with no processor (so the column default
-- 'stripe'), no card reference and no tenders. The card machine job pointed at a throwaway id
-- ('chk-kiosk-<uuid>') that never became a check and stayed 'approved' for ever. The till's
-- "Return to card" then said "via Stripe Terminal", showed "No card payment is linked to this
-- check", and could not reverse the card.
--
-- THE 12 PAIRS (all Coffee Boy Barnsley, all 30 Sep 2026, 106.70 in total), proven read only at
-- 17:35 BST on 30 Sep 2026 with the match rule below, each one to one:
--   R2576 21.35  R3127 5.50  R3128 4.80  R3129 4.00  R3280 5.85  R3281 5.85
--   R3432 5.85   R3483 5.80  R3509 15.05 R3635 9.70  R3886 12.05 R3962 10.90
--   The sale lands 1.5 to 3.3 seconds after the card payment, except R3281 (28 seconds).
--   Widened to 15 minutes either side, the only other checks of the same amount are till sales
--   (two 4.00 till sales near R3129), or the other 5.85 kiosk sale: R3280 (13:43:19) and R3281
--   (13:45:07) were two real 5.85 sales, each with its own card payment (settled 13:43:16 and
--   13:44:39), and neither can reach the other's window.
--   Barnsley's other 3 kiosk jobs that day took no money (2 declined, 1 never charged).
--
-- THE MATCH RULE (kept as a guard on every pinned pair, and used to list anything new):
--   same venue, check.kiosk_id = job.pos_device_id, check total in pence = job.charge_minor,
--   check closed between 5 seconds before and 60 seconds after the job settled, the job still
--   carries a throwaway 'chk-kiosk-' id, and the check is still unlinked (no tenders, no card
--   reference, no payment_intents).
--
-- A PINNED PAIR IS LINKED ONLY WHEN ALL OF THIS IS STILL TRUE (else it is left alone, and the
-- result says why; the other pairs still go ahead):
--   the sale is an unlinked kiosk sale with no gift card, loyalty or promo, of the pinned amount;
--   the job is the kiosk job, 'approved', not needs_human, on Adyen, with the pinned amount and
--   the pinned card reference; the match rule still pairs exactly these two; and neither of them
--   matches anything else (one to one).
--
-- ANY OTHER SALE THE RULE FINDS (a kiosk on an old bundle keeps making them until the code fix
-- reaches it) is NOT changed. It is listed at the bottom of the result as "found, not linked"
-- so Claude can add it to a later file after a review. It never stops the 12 above.
--
-- WHAT CHANGES, per linked pair:
--   closed_checks  processor = 'adyen', stripe_payment_intent_id = the job's transaction_id,
--                  tenders = [{ method card, amount = total less tip, tip, psp_ref, processor }]
--                  (the same shape the till and the fixed kiosk write).
--   terminal_jobs  closed_check_id = the real sale id, status 'approved' -> 'reconciled'
--                  (what the till does with its own jobs).
--
-- HOW TO RUN. Paste the whole file into the Ops SQL editor and run it as is, all at once, never
-- a part of it (no transaction wrapper: the editor runs it as one transaction, so a stop
-- anywhere changes nothing, and the list it shows at the end is the result).
-- CHECK, first run: 12 rows say list = 'pinned', linked = true, job_status = reconciled and
-- left_alone empty. Any 'found, not linked' rows below them were NOT changed: send them to Claude.
-- A second run changes nothing (UPDATE 0, UPDATE 0) and the same 12 rows say linked = true with
-- left_alone = 'already linked by an earlier run', so running it twice is safe.
--
-- PROVO (optional): Peter's 4 hardware test sales on 15 and 21 Sep (R34858, R40334, R40335,
-- R40511, own Visa), pinned in step 1 too. To link them as well, change false to true on the one
-- line marked PROVO and run the file again. Provo's older test R2 (Ryft, loyalty, no card
-- reference) is not pinned and is never changed.
--
-- R3127 (5.50, "Wrong item served", Nico, 12:33): see the OPTIONAL block at the bottom. It is
-- commented out on purpose. Run it ONLY after Barnsley confirms the customer was NOT given cash.

-- 1. The reviewed pairs, by id. Only these can ever change.
create temp table _kiosk_pinned on commit drop as
select v.venue, v.location_id, v.ref, v.check_id, v.job_id::uuid as job_id, v.charge_minor::bigint as charge_minor, v.transaction_id
from (values
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R2576', '0026ad44-72b5-4aed-be5a-cb3393000059', '74614a00-6819-472c-9433-9ab18ec65930', 2135, 'dDyE001790760922000.WP5Q2Q2N6W43WGQ9'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3127', 'da5c451f-ee73-455a-9e51-14900d65b631', '5c60f4de-4bf7-47bf-b7d5-ad93965925a0',  550, '52DY001790767848000.CH7MJ6RXFPS9QMG3'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3128', '6b8ad05a-723a-4f5f-8327-6764ae4ba1c2', '6dbd3dc7-0ebf-4e50-8c02-b8611421e26d',  480, '52DY001790768087001.FKCSQLSKC3VKBVQ9'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3129', '594cba83-ee84-4644-92b9-d31a6bf1ac4d', 'cc1f542e-0df0-4b1c-a65e-067a1a2607d9',  400, '52DY001790768450002.N6QSVHWM3XD74MG3'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3280', 'f1d0fc0b-292d-4c98-bf60-e68807f70dbc', '3e803cc4-b29d-44b0-b14d-399932cb4bc4',  585, '52DY001790772191003.LJ6LVFJGWBBX86H6'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3281', 'a4e92e14-2514-4fd8-981a-38cc9de2c702', '7d046d92-f014-4342-aac9-b653b77253c8',  585, '52DY001790772267004.GZJMFGSXFPS9QMG3'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3432', '32a38d95-8682-4bdd-9439-1aaa4212be10', '23e2a12f-bb39-4908-93e8-fe59c8d7c587',  585, '52DY001790773807005.DTXWMSNKNB36DFG6'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3483', '25647e9c-3cef-4c5d-bf1d-d06dd39e3743', 'a614b108-17ed-4bc6-bfff-82fec24570aa',  580, '52DY001790773961006.TPD8R58LC3TTTQR9'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3509', '6322e18a-46a6-458d-b7d2-7b3a1130ce76', '39e89587-bdb8-4c4d-bd94-726441534604', 1505, '52DY001790774571007.V6HD27HHSXMKD5Z3'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3635', '7f94337f-a0a7-4dd3-b8e5-0e84f1e1918e', 'f63311be-d579-4354-919f-a58a06ef9e5b',  970, '52DY001790776946009.BG6HKSKGWBBX86H6'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3886', '33e2ffa5-6475-40c2-932c-dfabd2bc06f9', '98326a7d-f9df-4ca0-ba4c-a80b1e058561', 1205, '52DY001790778289010.QFBVWQXJPNDBG3Z3'),
  ('Barnsley', 'c5dd8483-f250-4868-9e46-709a74d78e2a', 'R3962', '6ecfe381-775b-40b9-a02b-d2e0967bb054', '441e0936-50bb-4330-84e8-501aa0982cfa', 1090, '52DY001790782107011.GBB7BLWXTC9JHDZ3'),
  ('Provo',    '7218c716-eeb4-4f96-b284-f3500823595c', 'R34858', '4ad0ffb3-15fb-4115-8328-ada060394293', '4a7b97df-6eb6-4c29-a711-1dcccd008bea', 300, 'c5gT001789491332000.RJG7SDJR9KM3QDG6'),
  ('Provo',    '7218c716-eeb4-4f96-b284-f3500823595c', 'R40334', '5d05220e-75c7-49d4-b7f2-c597a3202c09', '6fa4fa27-bd37-47e1-bfbc-af037bf7398c', 100, 'c5gT001790016600001.WSPQZJZPCCBNJQG3'),
  ('Provo',    '7218c716-eeb4-4f96-b284-f3500823595c', 'R40335', '6b6ef0ef-2953-491e-83ad-00e59c056497', 'ee902821-65be-4e74-96b2-37390cbf89bc', 100, 'c5gT001790016794002.M3RD4QKXZP7H5LQ9'),
  ('Provo',    '7218c716-eeb4-4f96-b284-f3500823595c', 'R40511', 'c8c6a855-a3c5-452e-84d4-1f079de1b976', '433c1e1a-6602-4d4a-8cb4-0f51b0dc0997', 115, 'c5gT001790017994003.Z2K2QHRPH8R54RQ9')
) as v(venue, location_id, ref, check_id, job_id, charge_minor, transaction_id)
where v.venue = 'Barnsley'
   or false;                                       -- PROVO: change false to true to link Provo's 4 too

-- 2. Stop if the pinned list itself is wrong (a pasted id twice). Checks nothing else.
do $guard$
begin
  if (select count(*) <> count(distinct check_id) or count(*) <> count(distinct job_id) from _kiosk_pinned) then
    raise exception 'STOP: the pinned list names a sale or a card payment twice. Nothing changed. Send Claude this message.';
  end if;
end
$guard$;

-- 3. Everything the match rule finds at these venues now, with its one to one counts.
create temp table _kiosk_rule on commit drop as
with jobs as (
  select j.*
  from public.terminal_jobs j
  where j.location_id in (select distinct p.location_id::uuid from _kiosk_pinned p)
    and j.check_draft->>'source' = 'kiosk_send_to_terminal'
    and j.closed_check_id like 'chk-kiosk-%'
    and j.status in ('approved', 'reconciled')      -- every job that may have taken money
    and j.charge_minor > 0
),
checks as (
  select c.*
  from public.closed_checks c
  where c.location_id in (select distinct p.location_id from _kiosk_pinned p)
    and c.source = 'kiosk'
    and c.tenders is null
    and c.stripe_payment_intent_id is null
    and c.payment_intents is null
),
pairs as (
  select c.id                as check_id,
         c.ref,
         c.location_id,
         c.total,
         c.closed_at,
         j.id                as job_id,
         j.status            as job_status,
         j.transaction_id,
         round(extract(epoch from c.closed_at - j.settled_at)::numeric, 2) as gap_s
  from jobs j
  join checks c
    on c.location_id = j.location_id::text
   and c.kiosk_id = j.pos_device_id
   and round(c.total * 100) = j.charge_minor
   and c.closed_at between j.settled_at - interval '5 seconds' and j.settled_at + interval '60 seconds'
)
select p.*,
       count(*) over (partition by p.job_id)   as per_job,
       count(*) over (partition by p.check_id) as per_check
from pairs p;

-- 4. Each pinned pair with every value as it was BEFORE, and why it is left alone (if it is).
create temp table _kiosk_link on commit drop as
select p.venue,
       p.location_id,
       p.ref,
       p.check_id,
       p.job_id,
       p.charge_minor,
       p.transaction_id,
       c.total,
       coalesce(c.tip, 0)  as tip,
       c.status            as check_status,
       c.processor         as processor_before,
       j.status            as job_status_before,
       j.closed_check_id   as job_check_before,
       r.gap_s,
       case
         when c.id is not null and j.id is not null
          and c.stripe_payment_intent_id = p.transaction_id
          and c.tenders->0->>'psp_ref' = p.transaction_id
          and j.status = 'reconciled'
          and j.closed_check_id = p.check_id
         then 'already linked by an earlier run'
         else concat_ws(', ',
           case when c.id is null then 'sale not found' end,
           case when j.id is null then 'card payment not found' end,
           case when c.id is not null and (c.tenders is not null or c.stripe_payment_intent_id is not null or c.payment_intents is not null)
                then 'sale already carries a payment' end,
           case when c.id is not null and not (c.gift_card is null and c.loyalty is null and c.promo is null)
                then 'gift card, loyalty or promo on the sale' end,
           case when c.id is not null and round(c.total * 100) is distinct from p.charge_minor
                then 'sale amount is not the pinned amount' end,
           case when j.id is not null and j.status <> 'approved' then 'job already ' || j.status end,
           case when j.needs_human then 'job needs a person' end,
           case when j.id is not null and j.processor is distinct from 'adyen' then 'job not on Adyen' end,
           case when j.id is not null and j.charge_minor is distinct from p.charge_minor
                then 'job amount is not the pinned amount' end,
           case when j.id is not null and j.transaction_id is distinct from p.transaction_id
                then 'card reference is not the pinned one' end,
           case when j.id is not null and j.closed_check_id not like 'chk-kiosk-%'
                then 'job already points at a sale' end,
           case when r.check_id is null then 'the match rule no longer pairs them' end,
           case when (select count(*) from _kiosk_rule x where x.check_id = p.check_id or x.job_id = p.job_id) > 1
                then 'not one to one (another sale or card payment also matches)' end)
       end as left_alone
from _kiosk_pinned p
left join public.closed_checks c
  on c.id = p.check_id and c.location_id = p.location_id and c.source = 'kiosk'
left join public.terminal_jobs j
  on j.id = p.job_id and j.location_id = p.location_id::uuid
 and j.check_draft->>'source' = 'kiosk_send_to_terminal'
left join _kiosk_rule r
  on r.check_id = p.check_id and r.job_id = p.job_id;

-- 5. Link each pinned sale to its card payment (only while it is still unlinked).
update public.closed_checks c
   set processor = 'adyen',
       stripe_payment_intent_id = k.transaction_id,
       tenders = jsonb_build_array(jsonb_build_object(
         'method',    'card',
         'amount',    trim_scale(round((k.total - k.tip)::numeric, 2)),
         'tip',       trim_scale(round(k.tip::numeric, 2)),
         'psp_ref',   k.transaction_id,
         'processor', 'adyen'))
  from _kiosk_link k
 where k.left_alone = ''
   and c.id = k.check_id
   and c.location_id = k.location_id
   and c.source = 'kiosk'
   and c.tenders is null
   and c.stripe_payment_intent_id is null
   and c.payment_intents is null;

-- 6. Close each pinned job like the till does, pointing it at the sale that exists. Only a job
--    whose sale now carries exactly its transaction id, and only while it is still 'approved'.
update public.terminal_jobs j
   set closed_check_id = k.check_id,
       status = 'reconciled',
       settled_at = coalesce(j.settled_at, now()),
       updated_at = now()
  from _kiosk_link k
  join public.closed_checks c on c.id = k.check_id and c.location_id = k.location_id
 where k.left_alone = ''
   and j.id = k.job_id
   and j.location_id = k.location_id::uuid
   and j.check_draft->>'source' = 'kiosk_send_to_terminal'
   and j.status = 'approved'
   and j.needs_human = false
   and j.transaction_id = k.transaction_id
   and j.closed_check_id like 'chk-kiosk-%'
   and c.processor = 'adyen'
   and c.stripe_payment_intent_id = j.transaction_id;

-- 7. AFTER: every pinned pair as it is now, next to what it was, then anything else the rule
--    found (NOT changed). Expect the pinned rows to say linked = true and job_status =
--    reconciled, with left_alone empty the first time.
select 'pinned' as list,
       k.venue,
       k.ref,
       k.total,
       k.check_status,
       k.processor_before,
       c.processor,
       coalesce(c.stripe_payment_intent_id = k.transaction_id
         and c.tenders->0->>'psp_ref' = k.transaction_id, false) as linked,
       c.tenders,
       k.job_status_before,
       j.status as job_status,
       coalesce(j.closed_check_id = k.check_id, false) as job_points_at_sale,
       k.gap_s,
       k.left_alone,
       k.check_id,
       k.job_id::text as job_id
from _kiosk_link k
left join public.closed_checks c on c.id = k.check_id and c.location_id = k.location_id
left join public.terminal_jobs j on j.id = k.job_id
union all
select 'found, not linked',
       case r.location_id when 'c5dd8483-f250-4868-9e46-709a74d78e2a' then 'Barnsley'
                          when '7218c716-eeb4-4f96-b284-f3500823595c' then 'Provo'
                          else r.location_id end,
       r.ref,
       r.total,
       null, null, null,
       false,
       null,
       r.job_status,
       null,
       false,
       r.gap_s,
       'not in the reviewed list: nothing changed (' || r.per_job || ' job match, ' || r.per_check || ' check match)',
       r.check_id,
       r.job_id::text
from _kiosk_rule r
where not exists (select 1 from _kiosk_pinned p where p.check_id = r.check_id or p.job_id = r.job_id)
order by 1 desc, 2, 3;

-- ===========================================================================================
-- OPTIONAL, R3127 ONLY. Run on its own, and ONLY after Barnsley confirms the R3127 customer
-- (Mastercard debit ending 3840) was NOT handed 5.50 in cash.
--
-- R3127 was recorded as refunded at 12:33 BST (tender card, cardStatus 'none', no legs) while
-- the card was never linked, and Adyen shows nothing refunded. This turns that recorded refund
-- into a FAILED card reversal. Reload the till afterwards (it keeps its own copy of the check):
-- Check history then shows "Retry card reversal" on R3127, and one tap sends the 5.50 back to
-- the card on Adyen. It does nothing unless the steps above linked R3127 first, and it does
-- nothing on a second run.
--
-- update public.closed_checks
--    set refunds = jsonb_set(
--          jsonb_set(refunds, '{0,legs}', jsonb_build_array(jsonb_build_object(
--            'id',          '52DY001790767848000.CH7MJ6RXFPS9QMG3',
--            'processor',   'adyen',
--            'amountMinor', 550,
--            'brand',       'mc',
--            'last4',       '3840',
--            'status',      'failed',
--            'ref',         null,
--            'error',       'card was not linked when refunded; linked 30 Sep 2026',
--            'at',          (extract(epoch from now()) * 1000)::bigint))),
--          '{0,cardStatus}', '"failed"')
--  where id = 'da5c451f-ee73-455a-9e51-14900d65b631'
--    and location_id = 'c5dd8483-f250-4868-9e46-709a74d78e2a'
--    and stripe_payment_intent_id = '52DY001790767848000.CH7MJ6RXFPS9QMG3'
--    and jsonb_array_length(refunds) = 1
--    and refunds->0->>'id' = 'ref-1790767991906'
--    and refunds->0->>'cardStatus' = 'none'
--    and jsonb_array_length(refunds->0->'legs') = 0;
-- -- CHECK: UPDATE 1 the first time, UPDATE 0 after.
-- ===========================================================================================
