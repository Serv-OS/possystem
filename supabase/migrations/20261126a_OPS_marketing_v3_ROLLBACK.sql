-- 20261126a_OPS_marketing_v3_ROLLBACK.sql
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Undoes 20261126a_OPS_marketing_v3.sql.
-- WARNING: drops every recorded link click and every website visit. Segments saved with groups,
-- item rules or loyalty rules stay in the segments table; the old resolver below reads a group as
-- a rule with no field (ignored) and an item rule as an unknown field (ignored), so such a segment
-- matches MORE people than it did. Put the app back on the previous version first.
-- Safe to run twice.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS rollback. Run it on the Ops database only. Nothing was changed.';
  end if;
end $guard$;

drop function if exists public.review_feedback_public(text[], int, int);
drop function if exists public._mkt_review_author(text);
drop function if exists public.website_report(uuid, timestamptz);
drop function if exists public.marketing_link_report(uuid, timestamptz);
drop table if exists public.website_visits;
drop table if exists public.marketing_link_clicks;

-- The slice 3 resolver (20260616c_marketing_segments.sql), word for word.
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

drop function if exists public._mkt_segment_clause(jsonb, text[], int);
drop function if exists public.marketing_item_buyers(uuid, text[], text[], int);
drop function if exists public._mkt_phone_key(text);

select 'marketing v3 rolled back' as check, now() as at,
       to_regprocedure('public.marketing_resolve_segment(uuid, jsonb, int)') is not null as resolver_present,
       to_regclass('public.website_visits') is null as visits_gone;
