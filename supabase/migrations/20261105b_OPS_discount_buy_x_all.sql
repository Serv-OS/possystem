-- 20261105b_OPS_discount_buy_x_all.sql
-- Release 5.11.109, automatic deals: the new rule type Buy X, discount the lot.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  One transaction: any error and nothing changes. Safe to run twice.       #
-- #  Lock wait 3 s (it gives up, nothing changes). Run after UK close, and    #
-- #  BEFORE the 5.11.109 web app goes live.                                   #
-- ############################################################################
--
-- WHY: Back Office, Discounts gets a third automatic deal, Buy X, discount the lot
-- (discount_rules.trigger_type 'buy_x_all': 6 donuts, 15% off all 6). Every app works it out in
-- lib/discountEngine.js, and the server works out the same deals again for every online, kiosk
-- and QR order (public._public_order_auto, called by place_public_order). The server function
-- knew only 'bundle' and 'buy_x' and skipped anything else, so an order with the new deal would
-- be valued by the server at full price while the page charged the deal price.
--
-- WHAT IT CHANGES: public._public_order_auto only. It is the 20261020a function (live, checked
-- word for word on 28 Oct 2026) with one more branch for 'buy_x_all'. Every other rule, figure and
-- answer is exactly as before. CREATE OR REPLACE keeps who may run it (the service role only).
-- discount_rules.trigger_type is plain text with no check constraint (checked live), so no table
-- changes. No rule row is written.
--
-- ROLLBACK: 20261105b_OPS_discount_buy_x_all_ROLLBACK.sql (puts the 20261020a function back).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public._public_order_auto(text,text,jsonb)') is null or to_regclass('public.discount_rules') is null then
    raise exception 'public._public_order_auto or discount_rules is missing: not the Ops database this file was written for. Nothing was changed.';
  end if;
  if position('line_minor' in pg_get_functiondef('public._public_order_auto(text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'Run 20261020a_OPS_channel_parity_2.sql first. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public._public_order_auto(p_loc text, p_channel text, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tz      text;
  u_line    integer[];
  u_price   bigint[];
  u_used    boolean[];
  l_cat     text[];
  l_cats    jsonb[];
  v_n       integer := 0;
  v_total   bigint := 0;
  v_applied jsonb := '[]'::jsonb;
  r         public.discount_rules%rowtype;
  g         jsonb;
  v_ids     text[];
  v_rids    text[];
  v_avail   integer[];
  v_deal    integer[];
  v_reward  integer[];
  v_pick    integer[];
  v_claim   integer[];
  v_need    integer;
  v_fire    integer;
  v_count   integer;
  v_save    bigint;
  v_orig    bigint;
  v_rtype   text;
  v_rv      numeric;
  v_gi      integer;
  k         integer;
  u_save    bigint[];
  v_lsave   jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('total_minor', 0, 'rules', '[]'::jsonb);
  end if;
  select coalesce(nullif(l.timezone, ''), 'Europe/London') into v_tz from public.locations l where l.id::text = p_loc;

  select array_agg(x ->> 'cat' order by li), array_agg(coalesce(x -> 'cats', '[]'::jsonb) order by li)
    into l_cat, l_cats
    from jsonb_array_elements(p_lines) with ordinality as l(x, li);
  select array_agg(li::integer order by li, q), array_agg(coalesce((x ->> 'unit')::bigint, 0) order by li, q)
    into u_line, u_price
    from jsonb_array_elements(p_lines) with ordinality as l(x, li)
    cross join lateral generate_series(1, greatest(1, least(999, coalesce((x ->> 'qty')::integer, 1)))) as q;
  v_n := coalesce(cardinality(u_line), 0);
  if v_n = 0 or v_n > 5000 then
    return jsonb_build_object('total_minor', 0, 'rules', '[]'::jsonb);
  end if;
  u_used := array_fill(false, array[v_n]);
  u_save := array_fill(0::bigint, array[v_n]);

  for r in
    select * from public.discount_rules d
     where d.location_id = p_loc and d.active is true
     order by d.priority desc nulls last, d.sort_order nulls last, d.created_at, d.id
  loop
    if r.channels is not null and public._fence_js_truthy(r.channels)
       and not public._fence_js_truthy(r.channels -> p_channel) then
      continue;
    end if;
    if not (public._fence_rule_live(r.schedule, v_tz, now())
            or public._fence_rule_live(r.schedule, v_tz, now() - interval '20 minutes')) then
      continue;
    end if;
    v_rtype := coalesce(r.reward_type, 'percent');
    v_rv := coalesce(r.reward_value, 0);

    if coalesce(r.trigger_type, 'buy_x') = 'bundle' then
      continue when jsonb_typeof(r.trigger_groups) is distinct from 'array' or jsonb_array_length(r.trigger_groups) = 0;
      v_fire := null;
      for v_gi in 0 .. jsonb_array_length(r.trigger_groups) - 1 loop
        g := r.trigger_groups -> v_gi;
        v_ids := case when public._fence_js_truthy(g -> 'categoryIds')
                      then case when jsonb_typeof(g -> 'categoryIds') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'categoryIds')) else '{}'::text[] end
                      when public._fence_js_truthy(g -> 'category_ids')
                      then case when jsonb_typeof(g -> 'category_ids') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'category_ids')) else '{}'::text[] end
                      else '{}'::text[] end;
        v_need := greatest(1, floor(public._fence_num(coalesce(g ->> 'qty', '1')))::integer);
        select count(*) into v_count
          from generate_subscripts(u_line, 1) s
         where not u_used[s] and public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_ids);
        if v_count < v_need then
          v_fire := 0;
          exit;
        end if;
        v_fire := least(coalesce(v_fire, v_count / v_need), v_count / v_need);
      end loop;
      continue when coalesce(v_fire, 0) < 1;
      v_orig := 0;
      v_claim := '{}'::integer[];
      for v_gi in 0 .. jsonb_array_length(r.trigger_groups) - 1 loop
        g := r.trigger_groups -> v_gi;
        v_ids := case when public._fence_js_truthy(g -> 'categoryIds')
                      then case when jsonb_typeof(g -> 'categoryIds') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'categoryIds')) else '{}'::text[] end
                      when public._fence_js_truthy(g -> 'category_ids')
                      then case when jsonb_typeof(g -> 'category_ids') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'category_ids')) else '{}'::text[] end
                      else '{}'::text[] end;
        v_need := greatest(1, floor(public._fence_num(coalesce(g ->> 'qty', '1')))::integer);
        v_pick := array(select s from generate_subscripts(u_line, 1) s
                         where not u_used[s] and public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_ids)
                         order by u_price[s], s
                         limit v_need * v_fire);
        v_orig := v_orig + coalesce((select sum(u_price[s]) from unnest(v_pick) s), 0);
        v_claim := v_claim || v_pick;
      end loop;
      v_save := round(greatest(0, v_orig - v_rv * 100 * v_fire))::bigint;
      continue when v_save <= 0;
      foreach k in array v_claim loop
        u_used[k] := true;
      end loop;
      -- 20261020a: each unit's part of the saving, by its price (lib/discountEngine.js spreads a
      -- bundle's saving over its items the same way).
      if v_orig > 0 then
        foreach k in array v_claim loop
          u_save[k] := u_save[k] + round(u_price[k]::numeric * v_save / v_orig)::bigint;
        end loop;
      end if;

    elsif coalesce(r.trigger_type, 'buy_x') = 'buy_x' then
      v_ids := coalesce(r.trigger_category_ids, '{}'::text[]);
      v_rids := coalesce(r.reward_category_ids, '{}'::text[]);
      v_need := coalesce(r.trigger_qty, 2) + coalesce(r.reward_qty, 1);
      continue when v_need <= 0;
      v_avail := array(select s from generate_subscripts(u_line, 1) s
                        where not u_used[s] and public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_ids)
                        order by u_price[s], s);
      continue when coalesce(cardinality(v_avail), 0) < v_need;
      v_fire := cardinality(v_avail) / v_need;
      v_deal := v_avail[1 : v_need * v_fire];
      v_reward := v_deal[1 : greatest(0, coalesce(r.reward_qty, 1) * v_fire)];
      if coalesce(cardinality(v_rids), 0) > 0 then
        v_reward := array(select s from unnest(v_reward) with ordinality as a(s, o)
                           where public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_rids)
                           order by o);
      end if;
      continue when coalesce(cardinality(v_reward), 0) = 0;
      select coalesce(sum(case v_rtype
                            when 'percent' then round(u_price[s] * v_rv / 100)
                            when 'amount'  then least(round(v_rv * 100), u_price[s])
                            when 'free'    then u_price[s]
                            else 0 end), 0)::bigint
        into v_save
        from unnest(v_reward) s;
      continue when v_save <= 0;
      foreach k in array v_deal loop
        u_used[k] := true;
      end loop;
      -- 20261020a: each reward unit's own saving (the sum above, unit by unit).
      foreach k in array v_reward loop
        u_save[k] := u_save[k] + (case v_rtype
                                    when 'percent' then round(u_price[k] * v_rv / 100)
                                    when 'amount'  then least(round(v_rv * 100), u_price[k])
                                    when 'free'    then u_price[k]
                                    else 0 end)::bigint;
      end loop;
    elsif coalesce(r.trigger_type, 'buy_x') = 'buy_x_all' then
      -- 20261105b (v5.11.109): Buy X, discount the lot. Once the order holds trigger_qty units from
      -- the categories, the percent or amount comes off EVERY one of them; once per full set, the
      -- cheapest units first when there are more (lib/discountEngine.js, the same rule).
      v_ids := coalesce(r.trigger_category_ids, '{}'::text[]);
      v_need := coalesce(r.trigger_qty, 2);
      continue when v_need <= 0;
      v_avail := array(select s from generate_subscripts(u_line, 1) s
                        where not u_used[s] and public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_ids)
                        order by u_price[s], s);
      continue when coalesce(cardinality(v_avail), 0) < v_need;
      v_fire := cardinality(v_avail) / v_need;
      v_deal := v_avail[1 : v_need * v_fire];
      select coalesce(sum(case v_rtype
                            when 'percent' then round(u_price[s] * v_rv / 100)
                            when 'amount'  then least(round(v_rv * 100), u_price[s])
                            when 'free'    then u_price[s]
                            else 0 end), 0)::bigint
        into v_save
        from unnest(v_deal) s;
      continue when v_save <= 0;
      foreach k in array v_deal loop
        u_used[k] := true;
        u_save[k] := u_save[k] + (case v_rtype
                                    when 'percent' then round(u_price[k] * v_rv / 100)
                                    when 'amount'  then least(round(v_rv * 100), u_price[k])
                                    when 'free'    then u_price[k]
                                    else 0 end)::bigint;
      end loop;
    else
      continue;
    end if;

    v_total := v_total + v_save;
    v_applied := v_applied || jsonb_build_array(jsonb_build_object('rule_id', r.id, 'name', r.name, 'saving_minor', v_save));
  end loop;

  -- 20261020a (v5.11.81): what the deals took off each line, by the line's place in the order
  -- (_public_order_value's 'n'), so the check books a deal's VAT on the lines it hit.
  select coalesce(jsonb_agg(jsonb_build_object('n', (p_lines -> (t.li - 1) ->> 'n')::integer, 'saving_minor', t.sv) order by t.li), '[]'::jsonb)
    into v_lsave
    from (select u_line[s] as li, sum(u_save[s])::bigint as sv
            from generate_subscripts(u_line, 1) s
           group by u_line[s]) t
   where t.sv > 0 and coalesce(p_lines -> (t.li - 1) ->> 'n', '') ~ '^[0-9]{1,6}$';
  return jsonb_build_object('total_minor', v_total, 'rules', v_applied, 'line_minor', v_lsave);
end;
$function$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: buy_x_all 1, line_minor 1, anon_can_run false, authenticated_can_run false.
select
  (select case when position('buy_x_all' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.oid = 'public._public_order_auto(text,text,jsonb)'::regprocedure) as buy_x_all,
  (select case when position('line_minor' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.oid = 'public._public_order_auto(text,text,jsonb)'::regprocedure) as line_minor,
  has_function_privilege('anon', 'public._public_order_auto(text,text,jsonb)'::regprocedure, 'execute') as anon_can_run,
  has_function_privilege('authenticated', 'public._public_order_auto(text,text,jsonb)'::regprocedure, 'execute') as authenticated_can_run;
