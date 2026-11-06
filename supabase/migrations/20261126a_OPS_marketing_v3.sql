-- 20261126a_OPS_marketing_v3.sql
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). 5.12.67, 6 Nov 2026. Marketing v3.
--
-- Peter: "Segment by item ordered. And/or logic. Loyalty points stamps into email campaigns.
-- Reviews on the website. Website links reports: website reporting as a whole, be able to find out
-- if someone has clicked on links from email campaigns and website traffic reports."
--
-- What this adds (additive only, safe to run twice):
--   1. marketing_item_buyers(org, item ids, category ids, days): the customers who ordered one of
--      those items, or anything in one of those categories, in the last N days, on EVERY channel.
--      Online and QR checks carry no customer_id, so a check is tied to a customer by customer_id,
--      the loyalty block's customer_id, the email on the check or the phone on the check.
--   2. marketing_resolve_segment rewritten: rules may now be GROUPS ({match, rules}) to three
--      levels deep, so "VIPs who ordered pizza OR lapsed customers with email" is one segment. Every
--      old flat definition is a one level group and resolves exactly as before. Values never reach
--      the SQL text: the definition is bound as $1 and each rule reads its own value out of it by
--      a path made of integers (jsonb_path style), cast to the column's type. New fields: customer_id
--      (an id list, used by the loyalty rules the function expands before calling), ordered_item and
--      ordered_category (value {items|categories, days}).
--   3. marketing_link_clicks: one row per click on a tracked link in a campaign or automation
--      email (the message, the campaign, the customer, the link, the time). Read by the company's
--      own Back Office logins; written only by the marketing-webhook function (service role).
--   4. website_visits: one row per page view on the venue's own website (page, referrer, utm,
--      a daily hashed visitor key, which message link brought them). No cookie. Written only by
--      the website-visit function (service role); read by the company's own logins.
--   5. marketing_link_report(org, since) and website_report(org, since): the two report reads.
--   6. review_feedback_public(location ids, min rating, limit): what a public website may show of
--      the Review Manager: rating, words, first name and last initial, date, source. Public rows
--      only, never an email, phone, customer id or private detail. Anon may call it.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS migration. Run it on the Ops database only. Nothing was changed.';
  end if;
  if to_regclass('public.customers') is null or to_regclass('public.closed_checks') is null
     or to_regclass('public.marketing_messages') is null or to_regclass('public.review_feedback') is null
     or to_regclass('public.customer_rfm') is null then
    raise exception 'customers, closed_checks, marketing_messages, review_feedback and customer_rfm must exist first. Nothing was changed.';
  end if;
end $guard$;

set local lock_timeout = '3s';

-- 1. Who ordered what ------------------------------------------------------------------------

-- The last ten digits of a phone, so +44 7700 900123 and 07700900123 are one number. Null under 7 digits.
create or replace function public._mkt_phone_key(p text) returns text
language sql immutable strict as $$
  select case when length(regexp_replace(p, '[^0-9]', '', 'g')) >= 7
              then right(regexp_replace(p, '[^0-9]', '', 'g'), 10) end
$$;
revoke all on function public._mkt_phone_key(text) from public, anon, authenticated;

create or replace function public.marketing_item_buyers(p_org uuid, p_items text[], p_cats text[], p_days int)
returns table(customer_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  with locs as (
    select l.id::text as id from public.locations l where l.org_id = p_org
  ),
  chk as (
    select c.id, c.customer_id, c.loyalty, c.customer_phone,
           case when jsonb_typeof(c.customer) = 'object' then c.customer else '{}'::jsonb end as cj,
           case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end as items
    from public.closed_checks c
    where c.location_id in (select id from locs)
      and c.closed_at >= now() - make_interval(days => greatest(coalesce(p_days, 90), 1))
      and not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))
      and not public._sales_is_demo(c.id)
  ),
  hit as (
    select k.* from chk k
    where exists (
      select 1
      from jsonb_array_elements(k.items) l
      left join public.menu_items mi
        on mi.id = coalesce(public.stock_js_key(l -> 'itemId'), public.stock_js_key(l -> 'id'))
       and mi.location_id in (select id from locs)
      where jsonb_typeof(l) = 'object'
        and not public.stock_js_truthy(l -> 'voided')
        and (
          coalesce(public.stock_js_key(l -> 'itemId'), public.stock_js_key(l -> 'id')) = any (coalesce(p_items, '{}'::text[]))
          or mi.parent_id = any (coalesce(p_items, '{}'::text[]))
          or (l ->> 'cat') = any (coalesce(p_cats, '{}'::text[]))
          or mi.cat = any (coalesce(p_cats, '{}'::text[]))
          or exists (
            select 1 from jsonb_array_elements_text(case when jsonb_typeof(l -> 'cats') = 'array' then l -> 'cats' else '[]'::jsonb end) x
            where x = any (coalesce(p_cats, '{}'::text[]))
          )
        )
    )
  ),
  ids as (
    select h.customer_id from hit h where h.customer_id is not null
    union
    select (h.loyalty ->> 'customer_id')::uuid from hit h
     where jsonb_typeof(h.loyalty) = 'object'
       and (h.loyalty ->> 'customer_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    union
    select cu.id from hit h
      join public.customers cu on cu.org_id = p_org and cu.deleted_at is null
       and cu.email is not null and lower(cu.email) = lower(h.cj ->> 'email')
     where nullif(h.cj ->> 'email', '') is not null
    union
    select cu.id from hit h
      join public.customers cu on cu.org_id = p_org and cu.deleted_at is null
       and public._mkt_phone_key(cu.phone) = public._mkt_phone_key(coalesce(nullif(h.customer_phone, ''), h.cj ->> 'phone'))
     where public._mkt_phone_key(coalesce(nullif(h.customer_phone, ''), h.cj ->> 'phone')) is not null
  )
  select distinct i.customer_id from ids i
   where i.customer_id is not null
     and exists (select 1 from public.customers cu where cu.id = i.customer_id and cu.org_id = p_org and cu.deleted_at is null)
$$;
revoke all on function public.marketing_item_buyers(uuid, text[], text[], int) from public, anon, authenticated;

-- 2. The resolver, with groups and bound values -----------------------------------------------

-- One node of the definition: a rule or a group. Returns the SQL for it, or null to ignore it.
-- p_path is the path to the node inside the definition ($1 at run time); it is only ever built
-- from the word "rules" and integers, so no text from the definition reaches the SQL.
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

create or replace function public.marketing_resolve_segment(p_org uuid, p_def jsonb, p_limit int default null)
returns table(customer_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_def   jsonb := case when jsonb_typeof(p_def) = 'object' then p_def else '{"match":"all","rules":[]}'::jsonb end;
  v_where text;
  v_sql   text;
begin
  v_where := coalesce(public._mkt_segment_clause(v_def, '{}'::text[], 1), 'true');
  v_sql := 'select r.customer_id from public.customer_rfm r where r.org_id = $2 and ' || v_where;
  if p_limit is not null and p_limit > 0 then v_sql := v_sql || ' limit ' || (p_limit::int)::text; end if;
  return query execute v_sql using v_def, p_org;
end $$;
revoke all on function public.marketing_resolve_segment(uuid, jsonb, int) from public, anon, authenticated;

-- 3. Link clicks -------------------------------------------------------------------------------
create table if not exists public.marketing_link_clicks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  message_id  uuid not null,
  campaign_id uuid,
  workflow_id uuid,
  customer_id uuid,
  url         text not null,
  user_agent  text,
  clicked_at  timestamptz not null default now(),
  constraint marketing_link_clicks_url_len check (char_length(url) between 1 and 2048)
);
create index if not exists marketing_link_clicks_org_idx on public.marketing_link_clicks (org_id, clicked_at desc);
create index if not exists marketing_link_clicks_message_idx on public.marketing_link_clicks (message_id);
create index if not exists marketing_link_clicks_customer_idx on public.marketing_link_clicks (customer_id) where customer_id is not null;
alter table public.marketing_link_clicks enable row level security;
alter table public.marketing_link_clicks force row level security;
drop policy if exists marketing_link_clicks_read on public.marketing_link_clicks;
create policy marketing_link_clicks_read on public.marketing_link_clicks for select
  using (org_id::text in (select public.user_accessible_orgs()));
revoke all on public.marketing_link_clicks from public, anon;
grant select on public.marketing_link_clicks to authenticated;

-- 4. Website visits ----------------------------------------------------------------------------
create table if not exists public.website_visits (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  location_id  uuid,
  host         text,
  path         text not null default '/',
  referrer     text,                       -- the referring host only, never a full url
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  message_id   uuid,                       -- the tracked email link that brought this visit (sv_m)
  campaign_id  uuid,
  workflow_id  uuid,
  visitor_key  text not null,              -- daily hash of ip + browser + site + secret; no cookie
  created_at   timestamptz not null default now(),
  constraint website_visits_path_len check (char_length(path) between 1 and 512)
);
create index if not exists website_visits_org_idx on public.website_visits (org_id, created_at desc);
create index if not exists website_visits_campaign_idx on public.website_visits (campaign_id) where campaign_id is not null;
alter table public.website_visits enable row level security;
alter table public.website_visits force row level security;
drop policy if exists website_visits_read on public.website_visits;
create policy website_visits_read on public.website_visits for select
  using (org_id::text in (select public.user_accessible_orgs()));
revoke all on public.website_visits from public, anon;
grant select on public.website_visits to authenticated;

-- 5. The two report reads ----------------------------------------------------------------------
create or replace function public.marketing_link_report(p_org uuid, p_since timestamptz)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with k as (
    select * from public.marketing_link_clicks where org_id = p_org and clicked_at >= p_since
  )
  select jsonb_build_object(
    'clicks',    (select count(*) from k),
    'customers', (select count(distinct customer_id) from k where customer_id is not null),
    'campaigns', (
      select coalesce(jsonb_agg(x order by (x ->> 'clicks')::int desc, x ->> 'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'campaign_id', c.id, 'name', c.name,
          'clicks',    (select count(*) from k where k.campaign_id = c.id),
          'customers', (select count(distinct k.customer_id) from k where k.campaign_id = c.id and k.customer_id is not null),
          'links', (
            select coalesce(jsonb_agg(y order by (y ->> 'clicks')::int desc, y ->> 'url'), '[]'::jsonb) from (
              select jsonb_build_object('url', k.url, 'clicks', count(*), 'customers', count(distinct k.customer_id)) y
              from k where k.campaign_id = c.id group by k.url
            ) z
          )
        ) x
        from public.campaigns c
        where c.org_id = p_org and exists (select 1 from k where k.campaign_id = c.id)
      ) y
    ),
    'workflows', (
      select coalesce(jsonb_agg(x order by (x ->> 'clicks')::int desc, x ->> 'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'workflow_id', w.id, 'name', w.name,
          'clicks',    (select count(*) from k where k.workflow_id = w.id),
          'customers', (select count(distinct k.customer_id) from k where k.workflow_id = w.id and k.customer_id is not null),
          'links', (
            select coalesce(jsonb_agg(y order by (y ->> 'clicks')::int desc, y ->> 'url'), '[]'::jsonb) from (
              select jsonb_build_object('url', k.url, 'clicks', count(*), 'customers', count(distinct k.customer_id)) y
              from k where k.workflow_id = w.id group by k.url
            ) z
          )
        ) x
        from public.workflows w
        where w.org_id = p_org and exists (select 1 from k where k.workflow_id = w.id)
      ) y
    ),
    'links', (
      select coalesce(jsonb_agg(y order by (y ->> 'clicks')::int desc, y ->> 'url'), '[]'::jsonb) from (
        select jsonb_build_object('url', k.url, 'clicks', count(*), 'customers', count(distinct k.customer_id)) y
        from k group by k.url order by count(*) desc limit 50
      ) z
    )
  )
$$;
revoke all on function public.marketing_link_report(uuid, timestamptz) from public, anon, authenticated;

-- Days are the venue's own days (the organisation's first venue's clock), as every other report.
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

-- 6. Reviews a public website may show ---------------------------------------------------------
-- "Jane S." from "Jane Smith"; "Guest" when there is no name.
create or replace function public._mkt_review_author(p_name text) returns text
language sql immutable as $$
  select case
    when nullif(btrim(coalesce(p_name, '')), '') is null then 'Guest'
    when split_part(btrim(p_name), ' ', 2) = '' then split_part(btrim(p_name), ' ', 1)
    else split_part(btrim(p_name), ' ', 1) || ' ' || left(split_part(btrim(p_name), ' ', 2), 1) || '.' end
$$;
revoke all on function public._mkt_review_author(text) from public, anon, authenticated;

create or replace function public.review_feedback_public(p_location_ids text[], p_min int default 4, p_limit int default 6)
returns table(rating int, comment text, author text, created_at timestamptz, source text)
language sql stable security definer set search_path = public, pg_temp as $$
  select rf.rating::int,
         left(rf.comment, 600),
         public._mkt_review_author(rf.customer_name),
         rf.created_at,
         coalesce(nullif(rf.source_platform, ''), 'card')
  from public.review_feedback rf
  where rf.location_id = any ((coalesce(p_location_ids, '{}'::text[]))[1:20])
    and rf.is_public is true
    and coalesce(rf.status, '') <> 'archived'
    and nullif(btrim(coalesce(rf.comment, '')), '') is not null
    and rf.rating >= least(greatest(coalesce(p_min, 4), 1), 5)
  order by rf.created_at desc
  limit least(greatest(coalesce(p_limit, 6), 1), 24)
$$;
revoke all on function public.review_feedback_public(text[], int, int) from public;
grant execute on function public.review_feedback_public(text[], int, int) to anon, authenticated;

-- Self check: the shape the functions and pages rely on.
do $check$
declare v_n int;
begin
  if to_regprocedure('public.marketing_item_buyers(uuid, text[], text[], int)') is null then raise exception 'marketing_item_buyers did not install'; end if;
  if to_regprocedure('public.marketing_resolve_segment(uuid, jsonb, int)') is null then raise exception 'marketing_resolve_segment did not install'; end if;
  if to_regprocedure('public.marketing_link_report(uuid, timestamptz)') is null then raise exception 'marketing_link_report did not install'; end if;
  if to_regprocedure('public.website_report(uuid, timestamptz)') is null then raise exception 'website_report did not install'; end if;
  if to_regprocedure('public.review_feedback_public(text[], int, int)') is null then raise exception 'review_feedback_public did not install'; end if;
  if not exists (select 1 from pg_class where relname = 'marketing_link_clicks' and relforcerowsecurity) then raise exception 'marketing_link_clicks is not forced'; end if;
  if not exists (select 1 from pg_class where relname = 'website_visits' and relforcerowsecurity) then raise exception 'website_visits is not forced'; end if;
  -- an old flat definition and a nested one both compile to SQL
  if public._mkt_segment_clause('{"match":"all","rules":[{"field":"visit_count","op":"gte","value":5}]}'::jsonb, '{}'::text[], 1)
     <> '(visit_count >= (($1 #>> ''{rules,0,value}''::text[])::numeric))' then
    raise exception 'flat definition compiles wrongly';
  end if;
  select count(*) into v_n from public.marketing_resolve_segment('00000000-0000-0000-0000-000000000000'::uuid,
    '{"match":"any","rules":[{"match":"all","rules":[{"field":"lifetime_revenue","op":"gte","value":250},{"field":"ordered_item","op":"in","value":{"items":["x"],"days":30}}]},{"field":"has_email","op":"is_true"}]}'::jsonb, 5);
  if v_n <> 0 then raise exception 'nested definition on an empty organisation should match nobody'; end if;
end $check$;

select 'marketing v3 installed' as check, now() as at,
       (select count(*) from public.marketing_link_clicks) as link_clicks,
       (select count(*) from public.website_visits) as website_visits;
