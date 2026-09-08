-- Marketing reporting — add per-workflow (drip) performance to marketing_report().
-- Workflow sends are attributed via workflow_step_sends (which carries workflow_id + the step's
-- email_message_id + the unique promo code it issued) — NOT via marketing_messages.workflow_id, so this
-- works on all historical data even though the engine previously didn't stamp workflow_id on messages.
--   opens/clicks  → workflow_step_sends.email_message_id → marketing_messages.opened_at/clicked_at
--   redemptions   → workflow_step_sends.promo_code = promo_redemptions.code (deduped on redemption id)
-- Window semantics mirror the campaign block: sends/opens/clicks are in-window (step send created_at),
-- enrolled/completed are in-window (enrolled_at/completed_at), redemptions are in-window (redeemed_at)
-- regardless of when the code was sent.
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
  ),
  wss as (   -- workflow step sends in window that actually dispatched a message
    select workflow_id, email_message_id, promo_code
    from workflow_step_sends
    where org_id = p_org and created_at >= p_since and status in ('sent','partial')
  ),
  wred as (  -- redemptions in window attributed to the workflow whose step issued that code (dedupe on pr.id)
    select distinct pr.id as redemption_id, s.workflow_id, pr.discount_value, cc.total as order_total
    from workflow_step_sends s
    join promo_redemptions pr on pr.org_id = p_org and pr.code = s.promo_code and pr.redeemed_at >= p_since
    left join closed_checks cc on cc.id = pr.order_id
    where s.org_id = p_org and coalesce(s.promo_code, '') <> ''
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
    ),
    'workflows', (
      select coalesce(jsonb_agg(x order by (x->>'sent')::int desc, x->>'enrolled' desc, x->>'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'workflow_id', w.id, 'name', w.name, 'status', w.status,
          'enrolled',  (select count(*) from workflow_enrollments e where e.org_id = p_org and e.workflow_id = w.id and e.enrolled_at  >= p_since),
          'completed', (select count(*) from workflow_enrollments e where e.org_id = p_org and e.workflow_id = w.id and e.completed_at >= p_since),
          'active',    (select count(*) from workflow_enrollments e where e.org_id = p_org and e.workflow_id = w.id and e.status = 'active'),
          'sent',      (select count(*) from wss where wss.workflow_id = w.id),
          'opened',    (select count(*) from wss join marketing_messages mm on mm.id = wss.email_message_id where wss.workflow_id = w.id and mm.opened_at  is not null),
          'clicked',   (select count(*) from wss join marketing_messages mm on mm.id = wss.email_message_id where wss.workflow_id = w.id and mm.clicked_at is not null),
          'redeemed',  (select count(*) from wred where wred.workflow_id = w.id),
          'discount',  (select coalesce(sum(discount_value), 0) from wred where wred.workflow_id = w.id),
          'revenue',   (select coalesce(sum(order_total), 0) from wred where wred.workflow_id = w.id)
        ) x
        from workflows w where w.org_id = p_org
      ) y
    )
  )
$$;
revoke all on function marketing_report(uuid, timestamptz) from anon, authenticated;
