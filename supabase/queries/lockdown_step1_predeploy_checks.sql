-- supabase/queries/lockdown_step1_predeploy_checks.sql
--
-- READ ONLY. Lockdown step 1 (18 Sep 2026). Run each block in the SQL editor of the project it
-- names, before the deploy and again after it. Nothing here writes.

-- ============================================================================================
-- 1. PLATFORM DB (yhzjgyrkyjabvhblqxzu): online gift card purchases that were paid (or claimed)
--    but have no card. Expect 0 rows before the deploy. Any row is a customer who paid and got
--    nothing: note the purchase id and, once the new gift-fulfill is deployed, fulfil it from
--    Back Office (or ask Claude to call gift-fulfill for it with the service role). A row with
--    status 'pending' and a Stripe payment intent older than an hour may be a delayed payment
--    (bank debit) that never came back: check it in the Stripe dashboard.
-- ============================================================================================
select id                          as purchase_id,
       status,
       processor,
       amount_minor,
       currency,
       location_id,
       created_at,
       updated_at,
       stripe_session_id,
       stripe_payment_intent_id,
       ryft_payment_session_id
  from public.gift_card_purchases
 where gift_card_id is null
   and (status in ('paid', 'fulfilling', 'fulfilled')
        or (status = 'pending' and stripe_payment_intent_id is not null and created_at < now() - interval '1 hour'))
 order by created_at;

-- Summary by status (for the note in the deploy log).
select status, count(*) as purchases, count(*) filter (where gift_card_id is null) as without_card
  from public.gift_card_purchases
 group by status
 order by status;

-- ============================================================================================
-- 2. PLATFORM DB: the drifted venues (a Platform id that is NOT the venue's Ops id). Copy the
--    platform_id values for check 3.
-- ============================================================================================
select id as platform_id, ops_location_id, name, company_id
  from public.locations
 where ops_location_id is not null and id <> ops_location_id
 order by name;

-- ============================================================================================
-- 3. OPS DB (tbetcegmszzotrwdtqhi): nobody made an Ops venue whose id is one of those Platform
--    ids (while Ops locations was world writable, that would have made its creator staff of the
--    real company). Paste the platform_id values from check 2. Expect 0 rows.
-- ============================================================================================
-- select l.id, l.name, l.org_id, l.created_at,
--        (select string_agg(coalesce(p.email, p.id::text), ', ') from public.user_locations ul
--           join public.user_profiles p on p.id = ul.user_id where ul.location_id = l.id) as linked_logins
--   from public.locations l
--  where l.id in ('<platform_id 1>', '<platform_id 2>', '<platform_id 3>');

-- ============================================================================================
-- 4. OPS DB: venues whose company looks moved (an org with no other venue, created recently, or
--    a venue whose org differs from the org of every login linked to it). Eyeball only.
-- ============================================================================================
select l.id, l.name, l.org_id, o.name as org_name, l.updated_at,
       (select count(*) from public.user_locations ul join public.user_profiles p on p.id = ul.user_id
         where ul.location_id = l.id and p.org_id is distinct from l.org_id and coalesce(p.role, '') <> 'super_admin') as linked_logins_of_another_org
  from public.locations l
  left join public.organisations o on o.id = l.org_id
 order by linked_logins_of_another_org desc, l.updated_at desc nulls last;
