-- 20261002_public_order_vat_backfill.sql: write the VAT onto the 6 QR sales (and, optionally,
-- 3 Provo demo sales) that the server booked with tax_amount 0.
--
-- FOR PETER TO RUN in the Ops SQL editor (project tbetcegmszzotrwdtqhi). Not run by Claude.
-- No money moves. Nothing is deleted. Only closed_checks rows change, only the sales written out
-- in step 1 (by id), and on each only tax_amount, tax_breakdown and, where the sale was refunded,
-- the VAT on that one refund. Totals, tenders, items and status are never touched.
--
-- WHY. Since the public order functions went live (20 Sep 2026) the server threw away the VAT
-- of an online, QR pay now or catering order whenever the page sent it with more than 6 decimals
-- (5.60 at 20% arrives as 0.9333333333333327) and booked tax_amount 0, which every report reads
-- as zero rated. Found on 2 Oct 2026 on QR-FAUOB at Coffee Boy Leeds. The cause is fixed by
-- supabase/migrations/20261002b_OPS_public_order_vat.sql. RUN THAT FILE FIRST, so no new sale
-- can be booked with 0 while this one is being run. This file repairs the sales already booked.
--
-- THE SALES (read only review of every venue, 60 days back, at 13:20 BST on 2 Oct 2026; every
-- online, QR and catering check with tax_amount 0 and a total above 0 is in this list):
--   venue                 ref       total  VAT    state when reviewed
--   Coffee Boy Leeds      QR-FAUOB   5.60  0.93   paid
--   Coffee Boy Preston    QR-HAFUU   4.85  0.81   refunded in full, card, same day
--   Coffee Boy Preston    QR-186RY   5.85  0.97   refunded in full, card, same day
--   Coffee Boy Preston    QR-2ODON   4.40  0.73   refunded in full, card, same day
--   Coffee Boy Preston    QR-6CYF8   4.40  0.73   refunded in full, card, same day
--   Coffee Boy Preston    QR-PVON8   5.15  0.86   refunded in full, card, same day
--   Provo (demo)          OL-0NWKJ   1.95  0.32   paid   (optional, see PROVO)
--   Provo (demo)          OL-4FIAI   1.00  0.17   paid   (optional, see PROVO)
--   Provo (demo)          OL-909CZ   1.00  0.17   paid   (optional, see PROVO)
--   Leeds 0.93 and Preston 4.10 of VAT on 30.25 of sales. Provo 0.66 on 3.95.
--
-- NONE IS A ZERO RATED SALE. Each is one product, no tip, no service charge, no discount, no gift
-- card, loyalty or promo, and the product is on its own venue's Standard Rate (20%, inside the
-- price) with no order type override, read from menu_items on 2 Oct. The VAT is what the till's
-- own tax engine gives for the same line (src/lib/taxCompute.js, run in node): total / 6, rounded
-- as the till rounds it (5.85 books 0.97, as kiosk sale R3280 did on 30 Sep).
--
-- THE REFUNDED ONES. The 5 Preston sales were each refunded in full to the card. A refund
-- carries its own VAT (refunds[0].taxAmount) and the reports take it back off. On these it is
-- empty, because the sale had none. Both are filled in together, with the same figure, exactly
-- as QR sale QR-N2IYX at Huddersfield (booked correctly on 29 Sep, then refunded) carries 0.63
-- on the sale and 0.63 on its refund. So each day's VAT total does not move for Preston: the
-- sale's VAT and the refund's VAT cancel, as they do for every other refunded sale.
--
-- A PINNED SALE IS FILLED IN ONLY WHEN ALL OF THIS IS STILL TRUE (else it is left alone, the
-- result says why, and the others still go ahead):
--   it is the same online or QR sale at the same venue, not voided, of the reviewed total;
--   tax_amount is still 0 and it carries no tax breakdown; no tip, service charge, discount,
--   gift card, loyalty or promo; its lines still add up to its total; it is either paid with no
--   refund, or refunded with exactly one refund, for the whole total, with no VAT on it yet (for
--   the 5 Preston sales that must be the reviewed refund; a sale that was paid at the review
--   and has been refunded in full since is handled the same way); and the venue's Standard
--   Rate is still 20% inside the price.
--
-- WHAT IS WRITTEN, per sale:
--   tax_amount     the VAT above.
--   tax_breakdown  the till's record, by rate: one entry for the venue's own Standard Rate, with
--                  net, tax and gross, tagged "backfill" with the reason (the same shape the
--                  27 Sep Leeds reader backfill wrote). The Xero daily invoice splits by this.
--   refunds[0].taxAmount   the same VAT, on a refunded sale only (the 5 at Preston today).
--
-- ANY OTHER SALE BOOKED THE SAME WAY (an online, QR or catering check with tax_amount 0, no
-- breakdown and a total above 0, placed after the review and before 20261002b ran) is NOT
-- changed. It is listed at the bottom of the result as "found, not fixed" so Claude can review
-- its products and add it to a later file. It never stops the ones above.
--
-- HOW TO RUN. Paste the whole file into the Ops SQL editor and run it as is, all at once, never
-- a part of it (no transaction wrapper: the editor runs it as one transaction, so a stop anywhere
-- changes nothing, and the list it shows at the end is the result).
-- CHECK, first run: 6 rows say list = 'pinned', filled_in = true, vat_now = the VAT above and
-- left_alone empty. Provo's 3 show as 'found, not fixed' (switched off) unless PROVO is on.
-- A second run changes nothing (UPDATE 0) and the same rows say filled_in = true with
-- left_alone = 'already filled in by an earlier run', so running it twice is safe.
--
-- PROVO (optional): 3 test orders on the demo venue, 20 and 21 Sep, same fault. To fill them in
-- as well, change false to true on the one line marked PROVO and run the file again.
--
-- XERO.
--   Leeds: the nightly post sends 2 Oct to Xero at about 11:10 UK time on 3 Oct (03:10 in
--   California). Run this file before then and the 2 Oct invoice carries the 0.93 on the 20%
--   line. If it runs later, the invoice is already in Xero with 5.60 as zero rated: the app does
--   not send a posted day twice, so tell Claude and the one line is moved in Xero by hand.
--   Preston: 1 Oct is already in Xero, with these sales as 15.10 zero rated on the takings and
--   15.10 zero rated on the refunds. They cancel, so the VAT in Xero is right and nothing needs
--   adjusting. If someone pushes 1 Oct for Preston again, Back Office will say its VAT lines
--   have changed since it was posted. That is this fix, and it is safe to ignore.
--   Preston's 2 Oct has not posted yet and will go with the right lines.

do $guard$
begin
  if to_regclass('public.closed_checks') is null or to_regclass('public.tax_rates') is null then
    raise exception 'This is not the Ops database (closed_checks is missing). Nothing was changed.';
  end if;
end
$guard$;

-- 1. The reviewed sales, by id. Only these can ever change.
create temp table _vat_pinned on commit drop as
select v.venue, v.location_id, v.ref, v.check_id, v.source, v.total::numeric as total, v.vat::numeric as vat,
       v.rate_id::uuid as rate_id, v.status, v.refund_id,
       (v.venue <> 'Provo'
        or false) as switched_on                    -- PROVO: change false to true to fill in Provo's 3 too
from (values
  ('Coffee Boy Leeds',   '1e252e7c-c875-4971-b91d-1e945c26956b', 'QR-FAUOB', 'chk-1790937346153-4st', 'qr', 5.60, 0.93, '6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf', 'paid',     null),
  ('Coffee Boy Preston', 'ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-HAFUU', 'chk-1790868254558-wxe', 'qr', 4.85, 0.81, '229a7558-c675-47e9-bb16-c756815591d9', 'refunded', 'ref-1790869634334'),
  ('Coffee Boy Preston', 'ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-186RY', 'chk-1790869201407-zlb', 'qr', 5.85, 0.97, '229a7558-c675-47e9-bb16-c756815591d9', 'refunded', 'ref-1790869622170'),
  ('Coffee Boy Preston', 'ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-2ODON', 'chk-1790869873784-qnz', 'qr', 4.40, 0.73, '229a7558-c675-47e9-bb16-c756815591d9', 'refunded', 'ref-1790870195753'),
  ('Coffee Boy Preston', 'ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-6CYF8', 'chk-1790924398687-39e', 'qr', 4.40, 0.73, '229a7558-c675-47e9-bb16-c756815591d9', 'refunded', 'ref-1790924858416'),
  ('Coffee Boy Preston', 'ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-PVON8', 'chk-1790926944865-gdu', 'qr', 5.15, 0.86, '229a7558-c675-47e9-bb16-c756815591d9', 'refunded', 'ref-1790927305097'),
  ('Provo',               '7218c716-eeb4-4f96-b284-f3500823595c', 'OL-0NWKJ', 'chk-OL-0NWKJ-18f1e2ef-180b-4095-be26-5a6695504b7a', 'online', 1.95, 0.32, 'e917d8ae-fd95-427c-9c4a-0e1cd144ad0e', 'paid', null),
  ('Provo',               '7218c716-eeb4-4f96-b284-f3500823595c', 'OL-4FIAI', 'chk-OL-4FIAI-efb7bf62-bffd-48e0-8a90-813563011c70', 'online', 1.00, 0.17, 'e917d8ae-fd95-427c-9c4a-0e1cd144ad0e', 'paid', null),
  ('Provo',               '7218c716-eeb4-4f96-b284-f3500823595c', 'OL-909CZ', 'chk-OL-909CZ-f8ba184b-e471-47e0-901b-ac51034e73b5', 'online', 1.00, 0.17, 'e917d8ae-fd95-427c-9c4a-0e1cd144ad0e', 'paid', null)
) as v(venue, location_id, ref, check_id, source, total, vat, rate_id, status, refund_id);

-- 2. Stop if the pinned list itself is wrong (a pasted id twice, or a VAT that is not the
--    standard rate share of its total). Checks nothing else.
do $guard$
begin
  if (select count(*) <> count(distinct check_id) from _vat_pinned) then
    raise exception 'STOP: the pinned list names a sale twice. Nothing changed. Send Claude this message.';
  end if;
  if exists (select 1 from _vat_pinned p where abs(p.vat - p.total / 6) > 0.006 or p.vat <= 0 or p.vat >= p.total) then
    raise exception 'STOP: a pinned VAT is not one sixth of its total. Nothing changed. Send Claude this message.';
  end if;
end
$guard$;

-- 3. Each pinned sale with every value as it was BEFORE, and why it is left alone (if it is).
create temp table _vat_fix on commit drop as
select p.venue,
       p.location_id,
       p.ref,
       p.check_id,
       p.total,
       p.vat,
       p.status          as status_reviewed,
       p.refund_id,
       p.switched_on,
       c.status          as status_before,
       c.tax_amount      as vat_before,
       c.tax_breakdown   as breakdown_before,
       c.refunds -> 0 -> 'taxAmount' as refund_vat_before,
       jsonb_array_length(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) as refunds_before,
       coalesce(jsonb_array_length(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end), 0) as lines,
       t.id              as rate_id,
       case when t.id is not null then jsonb_build_object(
              'id', t.id, 'code', t.code, 'name', t.name, 'rate', trim_scale(t.rate), 'type', t.type,
              'active', t.active, 'appliesTo', to_jsonb(t.applies_to), 'isDefault', t.is_default) end as rate,
       case
         when c.id is not null
          and c.tax_amount = p.vat
          and jsonb_typeof(c.tax_breakdown) = 'object' and c.tax_breakdown ? 'backfill'
          and (jsonb_array_length(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) = 0
               or (jsonb_typeof(c.refunds -> 0 -> 'taxAmount') = 'number' and (c.refunds -> 0 ->> 'taxAmount')::numeric = p.vat))
         then 'already filled in by an earlier run'
         else concat_ws(', ',
           case when c.id is null then 'sale not found' end,
           case when c.voided is true or c.status in ('void', 'voided') then 'sale is voided' end,
           case when c.id is not null and c.tax_amount is distinct from 0 then 'VAT is no longer 0' end,
           case when c.id is not null and not (c.tax_breakdown is null or c.tax_breakdown = '[]'::jsonb)
                then 'sale already carries a tax breakdown' end,
           case when c.id is not null and c.total is distinct from p.total then 'total is not the reviewed amount' end,
           case when c.id is not null and not (coalesce(c.tip, 0) = 0 and coalesce(c.service, 0) = 0
                                               and (c.discounts is null or c.discounts = '[]'::jsonb)
                                               and c.gift_card is null and c.loyalty is null and c.promo is null)
                then 'tip, service charge, discount or credit on the sale' end,
           case when c.id is not null and (
                  select coalesce(sum(
                           ((i ->> 'price')::numeric
                            + coalesce((select sum((m ->> 'price')::numeric)
                                          from jsonb_array_elements(case when jsonb_typeof(i -> 'mods') = 'array' then i -> 'mods' else '[]'::jsonb end) m
                                         where jsonb_typeof(m -> 'price') = 'number'), 0))
                           * (case when jsonb_typeof(i -> 'qty') = 'number' then (i ->> 'qty')::numeric else 1 end)), 0)
                    from jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) i
                   where jsonb_typeof(i -> 'price') = 'number' and coalesce(i ->> 'voided', 'false') <> 'true'
                ) is distinct from p.total
                then 'lines do not add up to the total' end,
           -- Paid with no refund, or refunded with ONE refund of the whole total and no VAT on it
           -- (the reviewed refund, where one was reviewed).
           case when c.id is not null and not (
                  (c.status = 'paid'
                   and jsonb_array_length(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) = 0
                   and p.refund_id is null)
                  or
                  (c.status = 'refunded'
                   and jsonb_typeof(c.refunds) = 'array'
                   and jsonb_array_length(c.refunds) = 1
                   and (p.refund_id is null or c.refunds -> 0 ->> 'id' = p.refund_id)
                   and jsonb_typeof(c.refunds -> 0 -> 'amount') = 'number'
                   and (c.refunds -> 0 ->> 'amount')::numeric = p.total
                   and coalesce(c.refunds -> 0 -> 'taxAmount', 'null'::jsonb) in ('null'::jsonb, '0'::jsonb)))
                then 'not paid with no refund, and not refunded by one refund of the whole total with no VAT on it (state now: '
                     || coalesce(c.status, 'none') || ')' end,
           case when t.id is null then 'venue Standard Rate missing, or not 20% inside the price' end)
       end as left_alone
from _vat_pinned p
left join public.closed_checks c
  on c.id = p.check_id and c.location_id = p.location_id and c.source = p.source
left join public.tax_rates t
  on t.id = p.rate_id and t.location_id::text = p.location_id
 and t.rate = 0.2 and t.type = 'inclusive' and t.active is true;

-- 4. Fill in the VAT, the breakdown by rate and (refunded sales) the VAT on the refund. Only a
--    switched on sale that passed every check above, and only while its VAT is still 0.
update public.closed_checks c
   set tax_amount = k.vat,
       tax_breakdown = jsonb_build_object(
         'total', k.total,
         'source', 'legacy',
         'backfill', 'VAT filled in 2 Oct 2026: the server booked 0 for this public order (fixed by 20261002b)',
         'subtotal', k.total - k.vat,
         'totalTax', k.vat,
         'breakdown', jsonb_build_array(jsonb_build_object(
           'net', k.total - k.vat, 'tax', k.vat, 'rate', k.rate, 'gross', k.total, 'items', k.lines)),
         'exclusiveTax', 0,
         'hasExclusiveTax', false),
       refunds = case when k.refunds_before = 1
                      then jsonb_set(c.refunds, '{0,taxAmount}', to_jsonb(k.vat))
                      else c.refunds end
  from _vat_fix k
 where k.switched_on
   and k.left_alone = ''
   and c.id = k.check_id
   and c.location_id = k.location_id
   and c.tax_amount = 0
   and (c.tax_breakdown is null or c.tax_breakdown = '[]'::jsonb)
   and c.total = k.total
   and jsonb_array_length(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) = k.refunds_before;

-- 5. AFTER: every pinned sale as it is now, next to what it was, then anything else booked the
--    same way (NOT changed). Expect the pinned rows to say filled_in = true, with left_alone
--    empty the first time.
select case when k.switched_on then 'pinned' else 'found, not fixed' end as list,
       k.venue,
       k.ref,
       k.total,
       c.status,
       k.vat_before,
       c.tax_amount as vat_now,
       coalesce(c.tax_amount = k.vat and c.tax_breakdown ? 'backfill', false) as filled_in,
       c.tax_breakdown -> 'breakdown' -> 0 -> 'rate' ->> 'name' as rate_now,
       k.refund_vat_before,
       c.refunds -> 0 -> 'taxAmount' as refund_vat_now,
       case when k.switched_on then k.left_alone
            else 'Provo demo sale, switched off (see PROVO at the top): nothing changed' end as left_alone,
       k.check_id
from _vat_fix k
left join public.closed_checks c on c.id = k.check_id and c.location_id = k.location_id
union all
select 'found, not fixed',
       coalesce((select l.name from public.locations l where l.id::text = c.location_id), c.location_id),
       c.ref,
       c.total,
       c.status,
       c.tax_amount,
       c.tax_amount,
       false,
       null,
       c.refunds -> 0 -> 'taxAmount',
       c.refunds -> 0 -> 'taxAmount',
       'not in the reviewed list: nothing changed. Send this row to Claude.',
       c.id
from public.closed_checks c
where c.source in ('qr', 'online', 'catering')
  and c.closed_at >= '2026-09-20'
  and c.total > 0
  and c.tax_amount = 0
  and (c.tax_breakdown is null or c.tax_breakdown = '[]'::jsonb)
  and c.voided is not true
  and coalesce(c.status, '') not in ('void', 'voided')
  and not exists (select 1 from _vat_pinned p where p.check_id = c.id)
order by 1 desc, 2, 3;
