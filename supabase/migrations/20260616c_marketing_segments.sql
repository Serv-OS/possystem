-- Marketing & Promotions — Slice 3: segmentation + RFM.
-- Additive. Reuses the already-materialised RFM in customer_locations (visit_count, lifetime_revenue,
-- last/first_visit_at). Adds: (A) a per-customer RFM view, (B) a segments table, (C) an injection-safe
-- rule-tree resolver. Membership for dynamic segments is computed on demand (no stale member lists).

-- (A) Per-customer RFM rollup (org-wide across the customer's locations) ---------
-- Aggregates customer_locations up to the customer, joins demographic + derived recency/birthday fields.
-- Service-role only (edge fns + the resolver) — NOT exposed to anon/authenticated (would leak PII).
create or replace view customer_rfm as
select
  c.id                                              as customer_id,
  c.org_id,
  c.first_name, c.last_name, c.name, c.email, c.phone,
  c.birthday, c.marketing_opt_in, c.source, c.is_local,
  c.created_at                                      as signed_up_at,
  (current_date - c.created_at::date)              as signed_up_days,
  coalesce(sum(cl.visit_count), 0)                 as visit_count,
  coalesce(sum(cl.lifetime_revenue), 0)            as lifetime_revenue,
  max(cl.last_visit_at)                            as last_visit_at,
  min(cl.first_visit_at)                           as first_visit_at,
  (current_date - max(cl.last_visit_at)::date)     as days_since_visit,
  (c.email is not null and c.email <> '')          as has_email,
  (c.phone is not null and c.phone <> '')          as has_phone,
  case
    when c.birthday is null then null
    when to_date(to_char(current_date,'YYYY')||to_char(c.birthday,'MMDD'),'YYYYMMDD') >= current_date
      then to_date(to_char(current_date,'YYYY')||to_char(c.birthday,'MMDD'),'YYYYMMDD') - current_date
    else to_date(to_char(current_date + interval '1 year','YYYY')||to_char(c.birthday,'MMDD'),'YYYYMMDD') - current_date
  end                                              as birthday_in_days
from customers c
left join customer_locations cl on cl.customer_id = c.id
where c.deleted_at is null
group by c.id;

revoke all on customer_rfm from anon, authenticated;

-- (B) Saved segments (audience definitions) ------------------------------------
create table if not exists segments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  name          text not null,
  description   text,
  kind          text not null default 'dynamic' check (kind in ('dynamic','prebuilt')),
  prebuilt_key  text,                          -- set when kind='prebuilt'
  definition    jsonb not null default '{"match":"all","rules":[]}'::jsonb,
  member_count  integer,                       -- cached preview count (advisory)
  last_computed_at timestamptz,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists segments_org_idx on segments (org_id, created_at desc);
alter table segments enable row level security;
drop policy if exists segments_read on segments;
create policy segments_read on segments for select using (org_id::text in (select public.user_accessible_orgs()));

-- (C) Injection-safe rule-tree resolver ----------------------------------------
-- Translates a definition { match:'all'|'any', rules:[{field,op,value}] } into a query over
-- customer_rfm, always fenced to p_org. Field names are whitelisted → column expressions; operators
-- are whitelisted → SQL operators; values are rendered from jsonb (numbers/bools inline as their own
-- text form, strings via quote_literal) so no caller text reaches SQL unescaped.
create or replace function marketing_resolve_segment(p_org uuid, p_def jsonb, p_limit int default null)
returns table(customer_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_match  text := lower(coalesce(p_def->>'match','all'));
  v_join   text := case when v_match = 'any' then ' OR ' else ' AND ' end;
  v_rule   jsonb;
  v_field  text; v_op text; v_val jsonb; v_col text; v_lit text; v_clause text;
  v_elem   jsonb; v_in text[];
  v_clauses text[] := '{}';
  v_sql    text;
begin
  for v_rule in select * from jsonb_array_elements(coalesce(p_def->'rules','[]'::jsonb)) loop
    v_field := v_rule->>'field';
    v_op    := lower(coalesce(v_rule->>'op','eq'));
    v_val   := v_rule->'value';

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
      else null end;
    if v_col is null then continue; end if;   -- unknown field → ignored, never injected

    -- render a single jsonb scalar to a safe SQL literal
    v_lit := case jsonb_typeof(v_val)
      when 'number'  then (v_val#>>'{}')                 -- numeric: its text form is a valid literal
      when 'boolean' then (v_val#>>'{}')
      when 'string'  then quote_literal(v_val#>>'{}')
      else 'null' end;

    v_clause := case v_op
      when 'eq'        then v_col || ' = '  || v_lit
      when 'neq'       then v_col || ' <> ' || v_lit
      when 'gt'        then v_col || ' > '  || v_lit
      when 'gte'       then v_col || ' >= ' || v_lit
      when 'lt'        then v_col || ' < '  || v_lit
      when 'lte'       then v_col || ' <= ' || v_lit
      when 'contains'  then v_col || ' ilike ' || quote_literal('%' || coalesce(v_val#>>'{}','') || '%')
      when 'is_true'   then v_col || ' is true'
      when 'is_false'  then v_col || ' is false'
      when 'is_null'   then v_col || ' is null'
      when 'not_null'  then v_col || ' is not null'
      when 'in' then (
        select case when count(*) = 0 then 'false' else
          v_col || ' in (' || string_agg(
            case jsonb_typeof(e) when 'number' then e#>>'{}' when 'boolean' then e#>>'{}'
                 else quote_literal(e#>>'{}') end, ',') || ')' end
        from jsonb_array_elements(case when jsonb_typeof(v_val)='array' then v_val else '[]'::jsonb end) e)
      else null end;

    if v_clause is not null then v_clauses := array_append(v_clauses, v_clause); end if;
  end loop;

  v_sql := 'select customer_id from customer_rfm where org_id = ' || quote_literal(p_org::text) || '::uuid';
  if array_length(v_clauses, 1) > 0 then
    v_sql := v_sql || ' and (' || array_to_string(v_clauses, v_join) || ')';
  end if;
  if p_limit is not null and p_limit > 0 then v_sql := v_sql || ' limit ' || (p_limit)::text; end if;

  return query execute v_sql;
end $$;

revoke all on function marketing_resolve_segment(uuid, jsonb, int) from anon, authenticated;
