-- 20261127a_OPS_marketing_multisite.sql
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Run in the Supabase SQL editor. Safe to run twice.
-- Rollback: 20261127a_OPS_marketing_multisite_ROLLBACK.sql
--
-- 6 Nov 2026 (5.12.68). Peter: "we dont have multi site for marketing where someone can see all
-- marketing data in one place ... we do need to think about how we expand the reporting and
-- things to support much more multi site functions". The marketing tables were already company
-- wide; nothing split them by venue. This adds, all additive:
--   1. marketing_venue_customers(org, venue ids, days, mode): the customers who visited one of
--      these venues (visit_count > 0 on customer_locations, last visit inside the window when days
--      is given) or whose HOME venue (the venue they visit most) is one of them.
--   2. _mkt_segment_clause learns two fields: venue {venues, days} and home_venue {venues}.
--      Everything else in the resolver is word for word 20261126a. Campaign and automation site
--      scope reuses these rules (the engine wraps the audience in a venue rule).
--   3. marketing_report_sites(org, since): the marketing report split by venue. Sent, opened and
--      clicked go to the customer's home venue (every marketing_messages row, campaign or
--      automation alike, counted once); redeemed, discount and revenue go to the venue where the
--      code was used (promo_redemptions.location_id; every redemption once, campaign or automation
--      code alike). Per campaign and per automation the same split (automation sends through
--      workflow_step_sends). Messages to customers with no venue
--      yet are counted under unassigned.
--   4. website_report(org, since, host): a third argument filters one website (host), and a
--      sites list (host, venue, visits, visitors, from campaigns) is always over the whole company,
--      so the picker shows every site. The two argument form stays as a thin wrapper (no default
--      on the third argument, so the two never collide, and re-running 20261126a only puts the
--      old two argument body back until this file is run again).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS migration. Run it on the Ops database only. Nothing was changed.';
  end if;
  if to_regclass('public.customer_locations') is null or to_regclass('public.website_visits') is null
     or to_regprocedure('public.marketing_item_buyers(uuid, text[], text[], int)') is null then
    raise exception 'Run 20261126a_OPS_marketing_v3.sql first. Nothing was changed.';
  end if;
end $guard$;

set local lock_timeout = '3s';

-- 1. The customers of a venue ----------------------------------------------------------------
-- p_mode 'visited': visited one of the venues (last visit inside p_days when given, any time when null).
-- p_mode 'home': the venue they visit most (ties: the most recent visit) is one of the venues.
-- Only the organisation's own venues count; a foreign id in the list matches nobody.
create or replace function public.marketing_venue_customers(p_org uuid, p_venues text[], p_days int, p_mode text)
returns table(customer_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  with locs as (
    select l.id from public.locations l where l.org_id = p_org and l.id::text = any (coalesce(p_venues, '{}'::text[]))
  ),
  home as (
    select distinct on (cl.customer_id) cl.customer_id, cl.location_id
    from public.customer_locations cl
    join public.locations l on l.id = cl.location_id and l.org_id = p_org
    where coalesce(cl.visit_count, 0) > 0
    order by cl.customer_id, cl.visit_count desc, cl.last_visit_at desc nulls last, cl.location_id
  ),
  hit as (
    select cl.customer_id
    from public.customer_locations cl
    where coalesce(p_mode, 'visited') <> 'home'
      and cl.location_id in (select id from locs)
      and coalesce(cl.visit_count, 0) > 0
      and (p_days is null or cl.last_visit_at >= now() - make_interval(days => greatest(p_days, 1)))
    union
    select h.customer_id from home h
    where coalesce(p_mode, 'visited') = 'home' and h.location_id in (select id from locs)
  )
  select distinct c.id
  from public.customers c
  join hit on hit.customer_id = c.id
  where c.org_id = p_org and c.deleted_at is null
$$;
revoke all on function public.marketing_venue_customers(uuid, text[], int, text) from public, anon, authenticated;

-- 2. The clause builder with the two venue fields ----------------------------------------------
create or replace function public._mkt_segment_clause(p_def jsonb, p_path text[], p_depth int)
returns text
language plpgsql immutable as $$
declare
  v_node   jsonb := p_def #> p_path;
  v_p      text;                 -- '{rules,0,value}' style literal for this node's value
  v_pv     text;                 -- the value path literal
  v_field  text; v_op text; v_col text; v_type text;
  v_match  text; v_join text;
  v_parts  text[] := '{}';
  v_part   text;
  v_i      int;
  v_n      int;
  v_val    text;
  v_arr    text;
begin
  if v_node is null or jsonb_typeof(v_node) <> 'object' then return null; end if;

  -- A group: {match, rules:[...]}
  if jsonb_typeof(v_node -> 'rules') = 'array' and (v_node ->> 'field') is null then
    if p_depth > 3 then return null; end if;              -- deeper than three levels: ignored
    v_match := lower(coalesce(v_node ->> 'match', 'all'));
    v_join := case when v_match = 'any' then ' OR ' else ' AND ' end;
    v_n := jsonb_array_length(v_node -> 'rules');
    for v_i in 0 .. v_n - 1 loop
      v_part := public._mkt_segment_clause(p_def, p_path || array['rules', v_i::text], p_depth + 1);
      if v_part is not null then v_parts := array_append(v_parts, v_part); end if;
    end loop;
    if array_length(v_parts, 1) is null then return 'true'; end if;
    return '(' || array_to_string(v_parts, v_join) || ')';
  end if;

  -- A rule: {field, op, value}
  v_field := v_node ->> 'field';
  v_op := lower(coalesce(v_node ->> 'op', 'eq'));
  v_col := case v_field
    when 'visit_count'      then 'visit_count'
    when 'lifetime_revenue' then 'lifetime_revenue'
    when 'days_since_visit' then 'days_since_visit'
    when 'signed_up_days'   then 'signed_up_days'
    when 'birthday_in_days' then 'birthday_in_days'
    when 'marketing_opt_in' then 'marketing_opt_in'
    when 'has_email'        then 'has_email'
    when 'has_phone'        then 'has_phone'
    when 'is_local'         then 'is_local'
    when 'source'           then 'source'
    when 'never_visited'    then '(last_visit_at is null)'
    when 'has_birthday'     then '(birthday is not null)'
    when 'customer_id'      then 'customer_id'
    when 'ordered_item'     then 'ordered_item'
    when 'ordered_category' then 'ordered_category'
    when 'venue'            then 'venue'
    when 'home_venue'       then 'home_venue'
    else null end;
  if v_col is null then return null; end if;              -- unknown field: ignored, never injected
  v_type := case v_field
    when 'visit_count' then 'numeric' when 'lifetime_revenue' then 'numeric' when 'days_since_visit' then 'numeric'
    when 'signed_up_days' then 'numeric' when 'birthday_in_days' then 'numeric'
    when 'source' then 'text' when 'customer_id' then 'uuid'
    else 'boolean' end;

  -- The value path literal: only "rules", integers and "value" ever go in it.
  v_pv := '''{' || array_to_string(p_path || array['value'], ',') || '}''::text[]';
  if v_pv !~ '^''\{(rules,[0-9]+,)*value\}''::text\[\]$' then return null; end if;

  -- 5.12.68: visited one of these venues (in the last N days) / their home venue is one of these.
  -- The mode word is fixed here, never read from the definition.
  if v_field in ('venue', 'home_venue') then
    v_arr := '(case when jsonb_typeof($1 #> (' || v_pv || ' || ''{venues}''::text[])) = ''array'''
          || ' then array(select jsonb_array_elements_text($1 #> (' || v_pv || ' || ''{venues}''::text[]))) else ''{}''::text[] end)';
    v_val := 'customer_id in (select b.customer_id from public.marketing_venue_customers($2, ' || v_arr || ', '
          || 'nullif($1 #>> (' || v_pv || ' || ''{days}''::text[]), '''')::int, '
          || case when v_field = 'home_venue' then '''home''' else '''visited''' end || ') b)';
    return case when v_op in ('not_in', 'neq', 'is_false') then 'not (' || v_val || ')' else v_val end;
  end if;

  -- Bought this / bought from this category in the last N days (every channel).
  if v_field in ('ordered_item', 'ordered_category') then
    v_arr := '(case when jsonb_typeof($1 #> (' || v_pv || ' || ''{' || case when v_field = 'ordered_item' then 'items' else 'categories' end || '}''::text[])) = ''array'''
          || ' then array(select jsonb_array_elements_text($1 #> (' || v_pv || ' || ''{' || case when v_field = 'ordered_item' then 'items' else 'categories' end || '}''::text[]))) else ''{}''::text[] end)';
    v_val := 'customer_id in (select b.customer_id from public.marketing_item_buyers($2, '
          || case when v_field = 'ordered_item' then v_arr else 'null::text[]' end || ', '
          || case when v_field = 'ordered_category' then v_arr else 'null::text[]' end || ', '
          || 'coalesce(nullif($1 #>> (' || v_pv || ' || ''{days}''::text[]), '''')::int, 90)) b)';
    return case when v_op in ('not_in', 'neq', 'is_false') then 'not (' || v_val || ')' else v_val end;
  end if;

  -- A scalar value, cast to the column's type at run time.
  v_val := case v_type
    when 'numeric' then '(($1 #>> ' || v_pv || ')::numeric)'
    when 'boolean' then '(($1 #>> ' || v_pv || ')::boolean)'
    when 'uuid'    then '(($1 #>> ' || v_pv || ')::uuid)'
    else '($1 #>> ' || v_pv || ')' end;
  -- A list value (op in / not_in), typed the same way; a non array reads as an empty list.
  v_arr := '(case when jsonb_typeof($1 #> ' || v_pv || ') = ''array'' then array(select '
        || case v_type when 'numeric' then '(x)::numeric' when 'boolean' then '(x)::boolean' when 'uuid' then '(x)::uuid' else 'x' end
        || ' from jsonb_array_elements_text($1 #> ' || v_pv || ') x) else ''{}''::' || v_type || '[] end)';

  return case v_op
    when 'eq'       then v_col || ' = ' || v_val
    when 'neq'      then v_col || ' <> ' || v_val
    when 'gt'       then v_col || ' > ' || v_val
    when 'gte'      then v_col || ' >= ' || v_val
    when 'lt'       then v_col || ' < ' || v_val
    when 'lte'      then v_col || ' <= ' || v_val
    when 'contains' then v_col || ' ilike (''%'' || ' || v_val || ' || ''%'')'
    when 'is_true'  then v_col || ' is true'
    when 'is_false' then v_col || ' is false'
    when 'is_null'  then v_col || ' is null'
    when 'not_null' then v_col || ' is not null'
    when 'in'       then v_col || ' = any (' || v_arr || ')'
    when 'not_in'   then 'not (' || v_col || ' = any (' || v_arr || '))'
    else null end;
end $$;
revoke all on function public._mkt_segment_clause(jsonb, text[], int) from public, anon, authenticated;

-- 3. The marketing report split by venue -------------------------------------------------------
create or replace function public.marketing_report_sites(p_org uuid, p_since timestamptz)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with loc as (
    select l.id, l.id::text as id_text, coalesce(l.name, l.id::text) as name
    from public.locations l where l.org_id = p_org
  ),
  home as (
    select distinct on (cl.customer_id) cl.customer_id, cl.location_id
    from public.customer_locations cl
    join loc on loc.id = cl.location_id
    where coalesce(cl.visit_count, 0) > 0
    order by cl.customer_id, cl.visit_count desc, cl.last_visit_at desc nulls last, cl.location_id
  ),
  msg as (
    select m.id, m.campaign_id, m.opened_at, m.clicked_at, h.location_id as home_loc
    from public.marketing_messages m
    left join home h on h.customer_id = m.customer_id
    where m.org_id = p_org and m.created_at >= p_since
  ),
  red as (
    select pr.id, pr.discount_value, pr.location_id as loc_text, pc.campaign_id, cc.total as order_total
    from public.promo_redemptions pr
    left join public.promo_codes pc on pc.id = pr.promo_code_id
    left join public.closed_checks cc on cc.id = pr.order_id
    where pr.org_id = p_org and pr.redeemed_at >= p_since
  ),
  wss as (
    select s.workflow_id, s.promo_code, h.location_id as home_loc, mm.opened_at, mm.clicked_at
    from public.workflow_step_sends s
    left join public.marketing_messages mm on mm.id = coalesce(s.email_message_id, s.sms_message_id)
    left join home h on h.customer_id = mm.customer_id
    where s.org_id = p_org and s.created_at >= p_since and s.status in ('sent', 'partial')
  ),
  wred as (
    select distinct pr.id, s.workflow_id, pr.discount_value, pr.location_id as loc_text, cc.total as order_total
    from public.workflow_step_sends s
    join public.promo_redemptions pr on pr.org_id = p_org and pr.code = s.promo_code and pr.redeemed_at >= p_since
    left join public.closed_checks cc on cc.id = pr.order_id
    where s.org_id = p_org and coalesce(s.promo_code, '') <> ''
  ),
  clk as (
    select k.id, k.campaign_id, k.workflow_id, h.location_id as home_loc
    from public.marketing_link_clicks k
    left join home h on h.customer_id = k.customer_id
    where k.org_id = p_org and k.clicked_at >= p_since
  )
  select jsonb_build_object(
    'venues', (
      select coalesce(jsonb_agg(x order by (x ->> 'sent')::int desc, x ->> 'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'location_id', loc.id, 'name', loc.name,
          'sent',        (select count(*) from msg where msg.home_loc = loc.id),
          'opened',      (select count(*) from msg where msg.home_loc = loc.id and msg.opened_at is not null),
          'clicked',     (select count(*) from msg where msg.home_loc = loc.id and msg.clicked_at is not null),
          'link_clicks', (select count(*) from clk where clk.home_loc = loc.id),
          'redeemed',    (select count(*) from red where red.loc_text = loc.id_text),
          'discount',    (select coalesce(sum(discount_value), 0) from red where red.loc_text = loc.id_text),
          'revenue',     (select coalesce(sum(order_total), 0) from red where red.loc_text = loc.id_text)
        ) x from loc
      ) y
    ),
    'unassigned', jsonb_build_object(
      'sent',    (select count(*) from msg where msg.home_loc is null),
      'opened',  (select count(*) from msg where msg.home_loc is null and msg.opened_at is not null),
      'clicked', (select count(*) from msg where msg.home_loc is null and msg.clicked_at is not null),
      'redeemed', (select count(*) from red where red.loc_text is null or red.loc_text not in (select id_text from loc))
    ),
    'campaigns', (
      select coalesce(jsonb_agg(x order by x ->> 'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'campaign_id', c.id, 'name', c.name, 'status', c.status,
          'venues', (
            select coalesce(jsonb_agg(z order by (z ->> 'sent')::int desc, z ->> 'name'), '[]'::jsonb) from (
              select jsonb_build_object(
                'location_id', loc.id, 'name', loc.name,
                'sent',     (select count(*) from msg where msg.campaign_id = c.id and msg.home_loc = loc.id),
                'opened',   (select count(*) from msg where msg.campaign_id = c.id and msg.home_loc = loc.id and msg.opened_at is not null),
                'clicked',  (select count(*) from msg where msg.campaign_id = c.id and msg.home_loc = loc.id and msg.clicked_at is not null),
                'redeemed', (select count(*) from red where red.campaign_id = c.id and red.loc_text = loc.id_text),
                'revenue',  (select coalesce(sum(order_total), 0) from red where red.campaign_id = c.id and red.loc_text = loc.id_text)
              ) z from loc
              where exists (select 1 from msg where msg.campaign_id = c.id and msg.home_loc = loc.id)
                 or exists (select 1 from red where red.campaign_id = c.id and red.loc_text = loc.id_text)
            ) q
          )
        ) x
        from public.campaigns c
        where c.org_id = p_org
          and (exists (select 1 from msg where msg.campaign_id = c.id) or exists (select 1 from red where red.campaign_id = c.id))
      ) y
    ),
    'workflows', (
      select coalesce(jsonb_agg(x order by x ->> 'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'workflow_id', w.id, 'name', w.name, 'status', w.status,
          'venues', (
            select coalesce(jsonb_agg(z order by (z ->> 'sent')::int desc, z ->> 'name'), '[]'::jsonb) from (
              select jsonb_build_object(
                'location_id', loc.id, 'name', loc.name,
                'sent',     (select count(*) from wss where wss.workflow_id = w.id and wss.home_loc = loc.id),
                'opened',   (select count(*) from wss where wss.workflow_id = w.id and wss.home_loc = loc.id and wss.opened_at is not null),
                'clicked',  (select count(*) from wss where wss.workflow_id = w.id and wss.home_loc = loc.id and wss.clicked_at is not null),
                'redeemed', (select count(*) from wred where wred.workflow_id = w.id and wred.loc_text = loc.id_text),
                'revenue',  (select coalesce(sum(order_total), 0) from wred where wred.workflow_id = w.id and wred.loc_text = loc.id_text)
              ) z from loc
              where exists (select 1 from wss where wss.workflow_id = w.id and wss.home_loc = loc.id)
                 or exists (select 1 from wred where wred.workflow_id = w.id and wred.loc_text = loc.id_text)
            ) q
          )
        ) x
        from public.workflows w
        where w.org_id = p_org
          and (exists (select 1 from wss where wss.workflow_id = w.id) or exists (select 1 from wred where wred.workflow_id = w.id))
      ) y
    )
  )
$$;
revoke all on function public.marketing_report_sites(uuid, timestamptz) from public, anon, authenticated;

-- 4. The website report with a site filter and a sites list ------------------------------------
create or replace function public.website_report(p_org uuid, p_since timestamptz, p_host text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with tz as (
    select coalesce((select l.timezone from public.locations l where l.org_id = p_org order by l.created_at nulls last, l.id limit 1), 'Europe/London') as z
  ),
  vall as (
    select w.*, (w.created_at at time zone (select z from tz))::date as day
    from public.website_visits w where w.org_id = p_org and w.created_at >= p_since
  ),
  v as (
    select * from vall where p_host is null or host = p_host
  )
  select jsonb_build_object(
    'host',     p_host,
    'sites', (
      select coalesce(jsonb_agg(x order by (x ->> 'visits')::int desc, x ->> 'host'), '[]'::jsonb) from (
        select jsonb_build_object('host', host, 'location_id', location_id,
                                  'name', (select l.name from public.locations l where l.id = vall.location_id),
                                  'visits', count(*), 'visitors', count(distinct visitor_key),
                                  'from_campaigns', count(*) filter (where campaign_id is not null or workflow_id is not null)) x
        from vall group by host, location_id
      ) y
    ),
    'visits',   (select count(*) from v),
    'visitors', (select count(distinct visitor_key) from v),
    'from_campaigns', (select count(*) from v where campaign_id is not null or workflow_id is not null),
    'days', (
      select coalesce(jsonb_agg(x order by x ->> 'day'), '[]'::jsonb) from (
        select jsonb_build_object('day', day, 'visits', count(*), 'visitors', count(distinct visitor_key),
                                  'from_campaigns', count(*) filter (where campaign_id is not null or workflow_id is not null)) x
        from v group by day
      ) y
    ),
    'pages', (
      select coalesce(jsonb_agg(x order by (x ->> 'visits')::int desc, x ->> 'path'), '[]'::jsonb) from (
        select jsonb_build_object('path', path, 'visits', count(*), 'visitors', count(distinct visitor_key)) x
        from v group by path order by count(*) desc limit 30
      ) y
    ),
    'referrers', (
      select coalesce(jsonb_agg(x order by (x ->> 'visits')::int desc, x ->> 'referrer'), '[]'::jsonb) from (
        select jsonb_build_object('referrer', coalesce(nullif(referrer, ''), '(direct)'), 'visits', count(*), 'visitors', count(distinct visitor_key)) x
        from v group by coalesce(nullif(referrer, ''), '(direct)') order by count(*) desc limit 30
      ) y
    ),
    'sources', (
      select coalesce(jsonb_agg(x order by (x ->> 'visits')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('source', coalesce(nullif(utm_source, ''), '(none)'), 'medium', coalesce(nullif(utm_medium, ''), ''), 'visits', count(*), 'visitors', count(distinct visitor_key)) x
        from v group by coalesce(nullif(utm_source, ''), '(none)'), coalesce(nullif(utm_medium, ''), '') order by count(*) desc limit 30
      ) y
    ),
    'campaigns', (
      select coalesce(jsonb_agg(x order by (x ->> 'visits')::int desc, x ->> 'name'), '[]'::jsonb) from (
        select jsonb_build_object('campaign_id', c.id, 'name', c.name,
                                  'visits', (select count(*) from v where v.campaign_id = c.id),
                                  'visitors', (select count(distinct visitor_key) from v where v.campaign_id = c.id)) x
        from public.campaigns c where c.org_id = p_org and exists (select 1 from v where v.campaign_id = c.id)
        union all
        select jsonb_build_object('workflow_id', w.id, 'name', w.name || ' (automation)',
                                  'visits', (select count(*) from v where v.workflow_id = w.id),
                                  'visitors', (select count(distinct visitor_key) from v where v.workflow_id = w.id)) x
        from public.workflows w where w.org_id = p_org and exists (select 1 from v where v.workflow_id = w.id)
      ) y
    )
  )
$$;
revoke all on function public.website_report(uuid, timestamptz, text) from public, anon, authenticated;

-- The two argument form every existing caller uses: every site.
create or replace function public.website_report(p_org uuid, p_since timestamptz)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select public.website_report(p_org, p_since, null::text)
$$;
revoke all on function public.website_report(uuid, timestamptz) from public, anon, authenticated;

-- Self check: the shape the functions and pages rely on.
do $check$
declare v_n int;
begin
  if to_regprocedure('public.marketing_venue_customers(uuid, text[], int, text)') is null then raise exception 'marketing_venue_customers did not install'; end if;
  if to_regprocedure('public.marketing_report_sites(uuid, timestamptz)') is null then raise exception 'marketing_report_sites did not install'; end if;
  if to_regprocedure('public.website_report(uuid, timestamptz, text)') is null then raise exception 'website_report(org, since, host) did not install'; end if;
  if to_regprocedure('public.website_report(uuid, timestamptz)') is null then raise exception 'website_report(org, since) wrapper did not install'; end if;
  if public._mkt_segment_clause('{"match":"all","rules":[{"field":"visit_count","op":"gte","value":5}]}'::jsonb, '{}'::text[], 1)
     <> '(visit_count >= (($1 #>> ''{rules,0,value}''::text[])::numeric))' then
    raise exception 'flat definition compiles wrongly';
  end if;
  if position('marketing_venue_customers($2' in public._mkt_segment_clause('{"match":"all","rules":[{"field":"venue","op":"in","value":{"venues":["x"],"days":30}}]}'::jsonb, '{}'::text[], 1)) = 0 then
    raise exception 'venue rule does not compile to the venue function';
  end if;
  select count(*) into v_n from public.marketing_resolve_segment('00000000-0000-0000-0000-000000000000'::uuid,
    '{"match":"all","rules":[{"field":"home_venue","op":"in","value":{"venues":["x"]}}]}'::jsonb, 5);
  if v_n <> 0 then raise exception 'venue rule on an empty organisation should match nobody'; end if;
end $check$;

select 'marketing multisite installed' as check, now() as at,
       (select count(*) from public.locations) as venues_total,
       (select count(*) from public.customer_locations where coalesce(visit_count, 0) > 0) as customer_venue_rows;
