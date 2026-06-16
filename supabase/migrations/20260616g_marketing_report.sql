-- Marketing & Promotions — Slice 7: reporting & attribution.
-- Read-only aggregation function (no new tables). Computes the whole marketing dashboard for an org
-- over a window in ONE call, server-side (GROUP BY + joins) so it isn't limited by PostgREST's row cap.
-- SECURITY DEFINER + org param; revoked from anon/authenticated (called by the marketing-report edge fn).
create or replace function marketing_report(p_org uuid, p_since timestamptz)
returns jsonb language sql security definer set search_path = public as $$
  with msg as (
    select * from marketing_messages where org_id = p_org and created_at >= p_since
  ),
  red as (
    select pr.discount_value, pr.order_id, pr.offer_id, pc.campaign_id
    from promo_redemptions pr
    left join promo_codes pc on pc.id = pr.promo_code_id
    where pr.org_id = p_org and pr.redeemed_at >= p_since
  ),
  rev as (
    select r.*, cc.total as order_total from red r left join closed_checks cc on cc.id = r.order_id
  )
  select jsonb_build_object(
    'messages', jsonb_build_object(
      'total',     (select count(*) from msg),
      'delivered', (select count(*) from msg where delivered_at is not null),
      'opened',    (select count(*) from msg where opened_at is not null),
      'clicked',   (select count(*) from msg where clicked_at is not null),
      'email',     (select count(*) from msg where channel = 'email'),
      'sms',       (select count(*) from msg where channel = 'sms'),
      'by_status', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb) from (select status, count(*) c from msg group by status) s)
    ),
    'redemptions', jsonb_build_object(
      'count',    (select count(*) from red),
      'discount', (select coalesce(sum(discount_value), 0) from red),
      'revenue',  (select coalesce(sum(order_total), 0) from rev)
    ),
    'campaigns', (
      select coalesce(jsonb_agg(x order by (x->>'sent')::int desc, x->>'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'campaign_id', c.id, 'name', c.name, 'status', c.status,
          'sent',     (select count(*) from msg where campaign_id = c.id),
          'opened',   (select count(*) from msg where campaign_id = c.id and opened_at is not null),
          'clicked',  (select count(*) from msg where campaign_id = c.id and clicked_at is not null),
          'redeemed', (select count(*) from red where campaign_id = c.id),
          'discount', (select coalesce(sum(discount_value), 0) from red where campaign_id = c.id),
          'revenue',  (select coalesce(sum(order_total), 0) from rev where campaign_id = c.id)
        ) x
        from campaigns c where c.org_id = p_org
      ) y
    ),
    'offers', (
      select coalesce(jsonb_agg(x order by (x->>'redeemed')::int desc, x->>'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'offer_id', o.id, 'name', o.name,
          'issued',   (select count(*) from promo_codes pc where pc.offer_id = o.id and pc.org_id = p_org),
          'redeemed', (select count(*) from promo_redemptions pr where pr.offer_id = o.id and pr.org_id = p_org),
          'discount', (select coalesce(sum(pr.discount_value), 0) from promo_redemptions pr where pr.offer_id = o.id and pr.org_id = p_org)
        ) x
        from offers o where o.org_id = p_org
      ) y
    )
  )
$$;
revoke all on function marketing_report(uuid, timestamptz) from anon, authenticated;
