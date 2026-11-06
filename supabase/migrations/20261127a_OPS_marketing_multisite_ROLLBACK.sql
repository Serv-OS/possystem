-- 20261127a_OPS_marketing_multisite_ROLLBACK.sql
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Undoes 20261127a_OPS_marketing_multisite.sql: puts the
-- 20261126a clause builder and website_report back word for word, drops the venue customers
-- function and the per venue marketing report. A saved segment with a venue rule then reads that
-- rule as an unknown field (ignored), so it matches MORE people; a campaign with a site scope sends
-- to its whole segment. Put the app back on the previous version first. Safe to run twice.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS rollback. Run it on the Ops database only. Nothing was changed.';
  end if;
end $guard$;

drop function if exists public.marketing_report_sites(uuid, timestamptz);

-- 20261126a website_report, word for word (replaces the wrapper), then the three argument form goes.
create or replace function public.website_report(p_org uuid, p_since timestamptz)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with tz as (
    select coalesce((select l.timezone from public.locations l where l.org_id = p_org order by l.created_at nulls last, l.id limit 1), 'Europe/London') as z
  ),
  v as (
    select w.*, (w.created_at at time zone (select z from tz))::date as day
    from public.website_visits w where w.org_id = p_org and w.created_at >= p_since
  )
  select jsonb_build_object(
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
revoke all on function public.website_report(uuid, timestamptz) from public, anon, authenticated;
drop function if exists public.website_report(uuid, timestamptz, text);

-- 20261126a _mkt_segment_clause, word for word.
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

drop function if exists public.marketing_venue_customers(uuid, text[], int, text);

do $check$
begin
  if to_regprocedure('public.marketing_venue_customers(uuid, text[], int, text)') is not null then raise exception 'marketing_venue_customers still there'; end if;
  if to_regprocedure('public.website_report(uuid, timestamptz)') is null then raise exception 'website_report(org, since) did not come back'; end if;
  if public._mkt_segment_clause('{"match":"all","rules":[{"field":"venue","op":"in","value":{"venues":["x"]}}]}'::jsonb, '{rules,0}'::text[], 2) is not null then
    raise exception 'the venue rule should be ignored again';
  end if;
end $check$;

select 'marketing multisite rolled back' as check, now() as at;
