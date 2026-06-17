-- A/B subject testing for campaigns.
--   campaigns.variants        — [] or [{key:'a',subject},{key:'b',subject}] (subject-line variants)
--   campaign_sends.variant_key — which variant each recipient was assigned (deterministic split in the engine)
-- marketing_ab_report(org, campaign) → per-variant sent/opened/clicked/redeemed for the winner readout.

alter table campaigns       add column if not exists variants jsonb not null default '[]'::jsonb;
alter table campaign_sends  add column if not exists variant_key text;
create index if not exists campaign_sends_variant_idx on campaign_sends (campaign_id, variant_key) where variant_key is not null;

create or replace function marketing_ab_report(p_org uuid, p_campaign uuid)
returns jsonb language sql security definer set search_path = public as $$
  with s as (
    select customer_id, variant_key, email_message_id
    from campaign_sends
    where org_id = p_org and campaign_id = p_campaign and variant_key is not null
  ),
  agg as (
    select s.variant_key,
           count(*)                                            as sent,
           count(*) filter (where mm.opened_at  is not null)   as opened,
           count(*) filter (where mm.clicked_at is not null)   as clicked
    from s left join marketing_messages mm on mm.id = s.email_message_id
    group by s.variant_key
  ),
  red as (
    -- A redemption counts for a variant only if the code was issued by THIS campaign and the
    -- redeeming customer was actually sent that variant.
    select s.variant_key, count(distinct pr.id) as redeemed
    from promo_redemptions pr
    join promo_codes pc on pc.id = pr.promo_code_id and pc.campaign_id = p_campaign
    join s on s.customer_id = pr.customer_id
    where pr.org_id = p_org
    group by s.variant_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'variant',  a.variant_key,
           'sent',     a.sent,
           'opened',   a.opened,
           'clicked',  a.clicked,
           'redeemed', coalesce(r.redeemed, 0)
         ) order by a.variant_key), '[]'::jsonb)
  from agg a left join red r on r.variant_key = a.variant_key;
$$;

revoke all on function marketing_ab_report(uuid, uuid) from anon, authenticated;
