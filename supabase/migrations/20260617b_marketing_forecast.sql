-- Marketing v2 Phase 4 (#6): sum a venue-org's actual sales over a period for the forecast trigger.
-- Server-side aggregate so it isn't capped by PostgREST row limits. closed_checks.location_id is text;
-- locations.id is uuid → cast. SECURITY DEFINER + org param; revoked from anon/authenticated.
create or replace function marketing_period_sales(p_org uuid, p_start timestamptz, p_end timestamptz)
returns numeric language sql security definer set search_path = public as $$
  select coalesce(sum(cc.total), 0)
  from closed_checks cc
  where cc.location_id in (select id::text from locations where org_id = p_org)
    and cc.closed_at >= p_start and cc.closed_at <= p_end;
$$;
revoke all on function marketing_period_sales(uuid, timestamptz, timestamptz) from anon, authenticated;
