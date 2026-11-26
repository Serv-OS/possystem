-- ROLLBACK for 20261208a_OPS_stock_import_unit_bridges.sql. OPS DB ONLY. ASCII only.
-- Puts the three import functions back exactly as they were before it (the bodies production held on
-- 25 Nov 2026). Unit bridges the import already made stay: they are ordinary unit bridges, and the item
-- page still shows and edits them. Staged import rows of the kind 'bridge' are history; while any exist
-- the kind check keeps allowing them (dropping it back would refuse the table), otherwise it goes back.
-- Run the app rollback first (below 5.12.99), or an import file of unit bridges is refused with
-- 'The field "kind" must be one of ...'. Safe to run twice.

begin;

do $guard$
begin
  if to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS migration. Run it on the Ops database only. Nothing was changed.';
  end if;
end $guard$;

set local lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.stock_import_stage(p_job uuid, p_rows jsonb, p_meta jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_uuid text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_j stock_co_import_jobs;
  v_org uuid;
  v_sites uuid[];
  v_g jsonb;
  v_chk jsonb;
  v_n integer := 0;
  v_rsites uuid[];
  v_counts jsonb;
  e jsonb;
begin
  if p_job is null then
    if p_meta is null or jsonb_typeof(p_meta) <> 'object' or coalesce(p_meta ->> 'org_id', '') !~* v_uuid then
      raise exception 'A new import needs its company (org_id).' using errcode = '22023';
    end if;
    if coalesce(p_meta ->> 'source', 'csv') not in ('csv', 'nory', 'marketman') then
      raise exception 'The field "source" must be one of: csv, nory, marketman.' using errcode = '22023';
    end if;
    v_org := lower(p_meta ->> 'org_id')::uuid;
    if jsonb_typeof(p_meta -> 'sites') = 'array' then
      if exists (select 1 from jsonb_array_elements(p_meta -> 'sites') x where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~* v_uuid) then
        raise exception 'The field "sites" must be a list of sites.' using errcode = '22023';
      end if;
      v_sites := array(select distinct lower(x)::uuid from jsonb_array_elements_text(p_meta -> 'sites') x order by 1);
    end if;
    v_sites := coalesce(v_sites, '{}'::uuid[]);
    v_g := public.stock_co__guard(v_org, 'inventory', 'company',
                                  case when cardinality(v_sites) > 0 then v_sites else array[public.stock_co__org_site(v_org)] end);
    insert into stock_co_import_jobs (org_id, source, file_name, sites, created_by, created_by_name)
    values (v_org, coalesce(p_meta ->> 'source', 'csv'), left(nullif(btrim(coalesce(p_meta ->> 'file_name', '')), ''), 200), v_sites,
            v_uid, v_g ->> 'name')
    returning * into v_j;
  else
    select * into v_j from stock_co_import_jobs j where j.id = p_job;
    if v_j.id is null or not (v_j.created_by = v_uid or public.stock_level(v_uid, v_j.org_id) = 'all') then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    perform public.stock_co__guard(v_j.org_id, 'inventory', 'company',
                                   case when cardinality(v_j.sites) > 0 then v_j.sites else array[public.stock_co__org_site(v_j.org_id)] end);
    select * into v_j from stock_co_import_jobs j where j.id = p_job for update;
    if v_j.status not in ('staging', 'checked') then
      raise exception 'This import has already started.' using errcode = '55000';
    end if;
  end if;
  if p_rows is not null and jsonb_typeof(p_rows) <> 'null' then
    if jsonb_typeof(p_rows) <> 'array' then
      raise exception 'The field "rows" must be a list.' using errcode = '22023';
    end if;
    if jsonb_array_length(p_rows) > 2000 then
      raise exception 'Send 2,000 rows or fewer at a time.' using errcode = '22023';
    end if;
    for e in
      select x.value from jsonb_array_elements(p_rows) x
       order by case when (x.value ->> 'row_no') ~ '^[0-9]{1,9}$' then (x.value ->> 'row_no')::integer end nulls first
    loop
      if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'row_no', '') !~ '^[0-9]{1,9}$' or (e ->> 'row_no')::integer < 1 then
        raise exception 'Each row needs its row number (row_no).' using errcode = '22023';
      end if;
      if coalesce(e ->> 'kind', '') not in ('item', 'supplier', 'supplier_item', 'par', 'recipe') then
        raise exception 'The field "kind" must be one of: item, supplier, supplier_item, par, recipe.' using errcode = '22023';
      end if;
      if jsonb_typeof(e -> 'data') is distinct from 'object' then
        raise exception 'Row % has no fields.', e ->> 'row_no' using errcode = '22023';
      end if;
      v_rsites := null;
      if jsonb_typeof(e -> 'sites') = 'array' then
        if exists (select 1 from jsonb_array_elements(e -> 'sites') x where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~* v_uuid) then
          raise exception 'The field "sites" must be a list of sites.' using errcode = '22023';
        end if;
        v_rsites := array(select distinct lower(x)::uuid from jsonb_array_elements_text(e -> 'sites') x order by 1);
        if exists (select 1 from unnest(v_rsites) s where not exists (select 1 from locations l where l.id = s and l.org_id = v_j.org_id)) then
          raise exception 'That site is not in this company.' using errcode = '22023';
        end if;
      end if;
      v_chk := case when jsonb_typeof(e -> 'skip') = 'boolean' and (e ->> 'skip')::boolean
                    then jsonb_build_object('action', 'skip')
                    else public.stock_co__import_check_row(v_j.id, e ->> 'kind', e -> 'data') end;
      insert into stock_co_import_rows (job_id, row_no, org_id, kind, data, sites, action, problem, target_id)
      values (v_j.id, (e ->> 'row_no')::integer, v_j.org_id, e ->> 'kind', e -> 'data', v_rsites, v_chk ->> 'action', v_chk ->> 'problem',
              nullif(v_chk ->> 'target_id', '')::uuid)
      on conflict (job_id, row_no) do update
        set kind = excluded.kind, data = excluded.data, sites = excluded.sites, action = excluded.action, problem = excluded.problem,
            target_id = excluded.target_id, done = false;
      v_n := v_n + 1;
    end loop;
  end if;
  select jsonb_build_object('rows', count(*), 'new', count(*) filter (where r.action = 'new'),
                            'change', count(*) filter (where r.action = 'change'), 'same', count(*) filter (where r.action = 'same'),
                            'skip', count(*) filter (where r.action = 'skip'), 'problem', count(*) filter (where r.action = 'problem'),
                            'new_items', count(*) filter (where r.action = 'new' and r.kind = 'item'),
                            'price_changes', count(*) filter (where r.action = 'change' and r.kind = 'supplier_item'))
    into v_counts
    from stock_co_import_rows r where r.job_id = v_j.id;
  update stock_co_import_jobs j set counts = v_counts, row_version = j.row_version + 1, updated_at = now() where j.id = v_j.id;
  return jsonb_build_object('ok', true, 'job_id', v_j.id, 'staged', v_n, 'counts', v_counts);
end
$function$;

CREATE OR REPLACE FUNCTION public.stock_co__import_check_row(p_job uuid, p_kind text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org uuid;
  v_name text := nullif(btrim(coalesce(p_data ->> 'name', '')), '');
  v_unit text := lower(nullif(btrim(coalesce(p_data ->> 'base_unit', '')), ''));
  v_id uuid;
  v_n integer;
  v_sup uuid;
  v_item uuid;
  v_loc uuid;
  v_x record;
  v_num text;
  k text;
begin
  select j.org_id into v_org from stock_co_import_jobs j where j.id = p_job;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('action', 'problem', 'problem', 'This row has no fields.');
  end if;
  -- the numbers a row may carry must be numbers, 0 or more
  foreach k in array array['pack_qty', 'inner_qty', 'pack_price', 'par_level', 'reorder_point', 'min_level', 'min_order_value',
                           'shelf_life_days', 'payment_terms_days', 'purchase_vat_rate'] loop
    v_num := nullif(btrim(coalesce(p_data ->> k, '')), '');
    if v_num is not null and v_num !~ '^[0-9]+(\.[0-9]+)?$' then
      return jsonb_build_object('action', 'problem', 'problem', format('"%s" in %s is not a number, 0 or more.', left(v_num, 40), k));
    end if;
  end loop;
  if p_kind = 'recipe' then
    -- Drop 2: a recipe row {name, kind, food_kind, yield_qty, yield_unit, output_item, lines [{item, item_sku,
    -- qty, unit, usable_pct, order_types}], sites, till_product}
    if v_name is null then
      return jsonb_build_object('action', 'problem', 'problem', 'Add the recipe''s name.');
    end if;
    if coalesce(nullif(p_data ->> 'kind', ''), 'dish') not in ('dish', 'batch', 'prep') then
      return jsonb_build_object('action', 'problem', 'problem', 'Kind must be dish, batch or prep.');
    end if;
    if coalesce(nullif(p_data ->> 'food_kind', ''), 'food') not in ('food', 'drink', 'meal_deal') then
      return jsonb_build_object('action', 'problem', 'problem', 'Type must be food, drink or meal_deal.');
    end if;
    if nullif(btrim(coalesce(p_data ->> 'yield_unit', '')), '') is not null
       and not exists (select 1 from stock_units u where u.code = lower(btrim(p_data ->> 'yield_unit'))) then
      return jsonb_build_object('action', 'problem', 'problem',
        format('"%s" is not a unit ServOS knows (g, kg, ml, l, each, ...).', left(p_data ->> 'yield_unit', 20)));
    end if;
    if jsonb_typeof(p_data -> 'lines') <> 'array' or jsonb_array_length(p_data -> 'lines') = 0 then
      return jsonb_build_object('action', 'problem', 'problem', 'Add at least one ingredient line.');
    end if;
    for v_x in select e.value as ln, e.ord from jsonb_array_elements(p_data -> 'lines') with ordinality e(value, ord) loop
      v_item := null;
      select i.id into v_item from stock_co_items i
       where i.org_id = v_org and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(v_x.ln ->> 'item', '')))
       order by i.created_at, i.id limit 1;
      if v_item is null and nullif(btrim(coalesce(v_x.ln ->> 'item_sku', '')), '') is not null then
        select i.id into v_item from stock_co_items i
         where i.org_id = v_org and i.archived_at is null and lower(i.sku) = lower(btrim(v_x.ln ->> 'item_sku'))
         order by i.created_at, i.id limit 1;
      end if;
      if v_item is null and not exists (select 1 from stock_co_import_rows r
                                         where r.job_id = p_job and r.kind = 'item' and r.action = 'new'
                                           and lower(btrim(r.data ->> 'name')) = lower(btrim(coalesce(v_x.ln ->> 'item', '')))) then
        return jsonb_build_object('action', 'problem', 'problem',
          format('Line %s: %s is not a stock item here.', v_x.ord, left(coalesce(v_x.ln ->> 'item', v_x.ln ->> 'item_sku', ''), 80)));
      end if;
      if nullif(btrim(coalesce(v_x.ln ->> 'unit', '')), '') is null
         or not exists (select 1 from stock_units u where u.code = lower(btrim(v_x.ln ->> 'unit'))) then
        return jsonb_build_object('action', 'problem', 'problem',
          format('Line %s: "%s" is not a unit ServOS knows (g, kg, ml, l, each, ...).', v_x.ord, left(coalesce(v_x.ln ->> 'unit', ''), 20)));
      end if;
      v_num := nullif(btrim(coalesce(v_x.ln ->> 'qty', '')), '');
      if v_num is null or v_num !~ '^[0-9]+(\.[0-9]+)?$' or v_num::numeric <= 0 then
        return jsonb_build_object('action', 'problem', 'problem', format('Line %s: the amount must be a number above 0.', v_x.ord));
      end if;
    end loop;
    if coalesce(nullif(p_data ->> 'kind', ''), 'dish') in ('batch', 'prep') then
      v_item := null;
      select i.id into v_item from stock_co_items i
       where i.org_id = v_org and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(p_data ->> 'output_item', '')))
       order by i.created_at, i.id limit 1;
      if v_item is null and not exists (select 1 from stock_co_import_rows r
                                         where r.job_id = p_job and r.kind = 'item' and r.action = 'new'
                                           and lower(btrim(r.data ->> 'name')) = lower(btrim(coalesce(p_data ->> 'output_item', '')))) then
        return jsonb_build_object('action', 'problem', 'problem',
          format('%s is not a stock item here.', left(coalesce(nullif(p_data ->> 'output_item', ''), 'The made item'), 80)));
      end if;
    end if;
    select c.id into v_id from stock_co_recipes c
     where c.org_id = v_org and c.archived_at is null and lower(c.name) = lower(v_name)
     order by c.created_at, c.id limit 1;
    if v_id is null then
      return jsonb_build_object('action', 'new');
    end if;
    if exists ((select lower(btrim(coalesce(x ->> 'item', ''))), nullif(x ->> 'qty', '')::numeric, lower(btrim(coalesce(x ->> 'unit', ''))),
                       coalesce(nullif(x ->> 'usable_pct', '')::numeric, 100)
                  from jsonb_array_elements(p_data -> 'lines') x
                except all
                select lower(i.name), l.qty, l.unit, coalesce(l.usable_pct, 100)
                  from stock_co_recipe_lines l join stock_co_items i on i.id = l.component_item_id where l.recipe_id = v_id)
               union all
               (select lower(i.name), l.qty, l.unit, coalesce(l.usable_pct, 100)
                  from stock_co_recipe_lines l join stock_co_items i on i.id = l.component_item_id where l.recipe_id = v_id
                except all
                select lower(btrim(coalesce(x ->> 'item', ''))), nullif(x ->> 'qty', '')::numeric, lower(btrim(coalesce(x ->> 'unit', ''))),
                       coalesce(nullif(x ->> 'usable_pct', '')::numeric, 100)
                  from jsonb_array_elements(p_data -> 'lines') x)) then
      return jsonb_build_object('target_id', v_id, 'action', 'change');
    end if;
    return jsonb_build_object('target_id', v_id, 'action', 'same');
  elsif p_kind = 'item' then
    if v_name is null or v_unit is null then
      return jsonb_build_object('action', 'problem', 'problem', 'Add a name and a base unit.');
    end if;
    if not exists (select 1 from stock_units u where u.code = v_unit) then
      return jsonb_build_object('action', 'problem', 'problem', format('"%s" is not a unit ServOS knows (g, kg, ml, l, each, ...).', left(v_unit, 20)));
    end if;
    if coalesce(p_data ->> 'type', '') <> '' and p_data ->> 'type' not in ('food', 'drink', 'other') then
      return jsonb_build_object('action', 'problem', 'problem', 'Type must be food, drink or other.');
    end if;
    select count(*), min(i.id::text)::uuid into v_n, v_id from stock_co_items i
     where i.org_id = v_org and i.archived_at is null and lower(i.name) = lower(v_name) and i.base_unit = v_unit;
    if v_n <> 1 then
      v_id := null;
      if nullif(btrim(coalesce(p_data ->> 'sku', '')), '') is not null then
        select count(*), min(i.id::text)::uuid into v_n, v_id from stock_co_items i
         where i.org_id = v_org and i.archived_at is null and lower(i.sku) = lower(btrim(p_data ->> 'sku'));
        if v_n <> 1 then
          v_id := null;
        end if;
      end if;
    end if;
    if v_id is null then
      return jsonb_build_object('action', 'new');
    end if;
    select * into v_x from stock_co_items i where i.id = v_id;
    return jsonb_build_object('target_id', v_id, 'action',
      case when (nullif(btrim(coalesce(p_data ->> 'category', '')), '') is not null
                  and lower(btrim(p_data ->> 'category')) is distinct from lower(btrim(coalesce(v_x.category, ''))))
             or (nullif(p_data ->> 'type', '') is not null and p_data ->> 'type' is distinct from v_x.type)
             or (nullif(btrim(coalesce(p_data ->> 'sku', '')), '') is not null and btrim(p_data ->> 'sku') is distinct from v_x.sku)
             or (nullif(btrim(coalesce(p_data ->> 'barcode', '')), '') is not null and btrim(p_data ->> 'barcode') is distinct from v_x.barcode)
             or (nullif(p_data ->> 'shelf_life_days', '') is not null
                 and (p_data ->> 'shelf_life_days')::numeric::integer is distinct from v_x.shelf_life_days)
             or (nullif(p_data ->> 'purchase_vat_rate', '') is not null
                 and (p_data ->> 'purchase_vat_rate')::numeric is distinct from v_x.purchase_vat_rate)
           then 'change' else 'same' end);
  elsif p_kind = 'supplier' then
    if v_name is null then
      return jsonb_build_object('action', 'problem', 'problem', 'Add the supplier''s name.');
    end if;
    select m.id into v_id from stock_co_suppliers m
     where m.org_id = v_org and m.archived_at is null and lower(m.name) = lower(v_name)
     order by m.created_at, m.id limit 1;
    if v_id is null then
      return jsonb_build_object('action', 'new');
    end if;
    select * into v_x from stock_co_suppliers m where m.id = v_id;
    return jsonb_build_object('target_id', v_id, 'action',
      case when (nullif(btrim(coalesce(p_data ->> 'email', '')), '') is not null and btrim(p_data ->> 'email') is distinct from v_x.email)
             or (nullif(btrim(coalesce(p_data ->> 'phone', '')), '') is not null and btrim(p_data ->> 'phone') is distinct from v_x.phone)
             or (nullif(btrim(coalesce(p_data ->> 'contact_name', '')), '') is not null
                 and btrim(p_data ->> 'contact_name') is distinct from v_x.contact_name)
           then 'change' else 'same' end);
  elsif p_kind = 'supplier_item' then
    if nullif(btrim(coalesce(p_data ->> 'supplier', '')), '') is null
       or coalesce(nullif(btrim(coalesce(p_data ->> 'item', '')), ''), nullif(btrim(coalesce(p_data ->> 'item_sku', '')), '')) is null then
      return jsonb_build_object('action', 'problem', 'problem', 'Add the supplier and the stock item.');
    end if;
    if nullif(p_data ->> 'pack_price', '') is null or nullif(p_data ->> 'inner_unit', '') is null then
      return jsonb_build_object('action', 'problem', 'problem', 'Add the pack price and its unit.');
    end if;
    if not exists (select 1 from stock_units u where u.code = lower(btrim(p_data ->> 'inner_unit'))) then
      return jsonb_build_object('action', 'problem', 'problem',
        format('"%s" is not a unit ServOS knows (g, kg, ml, l, each, ...).', left(p_data ->> 'inner_unit', 20)));
    end if;
    select m.id into v_sup from stock_co_suppliers m
     where m.org_id = v_org and m.archived_at is null and lower(m.name) = lower(btrim(p_data ->> 'supplier'))
     order by m.created_at, m.id limit 1;
    if v_sup is null and not exists (select 1 from stock_co_import_rows r
                                      where r.job_id = p_job and r.kind = 'supplier' and r.action = 'new'
                                        and lower(btrim(r.data ->> 'name')) = lower(btrim(p_data ->> 'supplier'))) then
      return jsonb_build_object('action', 'problem', 'problem',
        format('No supplier called %s. Add it to the file or the list first.', left(p_data ->> 'supplier', 80)));
    end if;
    -- by name first (the name index), then by the item's sku
    select i.id into v_item from stock_co_items i
     where i.org_id = v_org and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(p_data ->> 'item', '')))
     order by i.created_at, i.id limit 1;
    if v_item is null and nullif(btrim(coalesce(p_data ->> 'item_sku', '')), '') is not null then
      select i.id into v_item from stock_co_items i
       where i.org_id = v_org and i.archived_at is null and lower(i.sku) = lower(btrim(p_data ->> 'item_sku'))
       order by i.created_at, i.id limit 1;
    end if;
    if v_item is null and not exists (select 1 from stock_co_import_rows r
                                       where r.job_id = p_job and r.kind = 'item' and r.action = 'new'
                                         and lower(btrim(r.data ->> 'name')) = lower(btrim(coalesce(p_data ->> 'item', '')))) then
      return jsonb_build_object('action', 'problem', 'problem',
        format('No stock item called %s. Add it to the file or the list first.', left(coalesce(p_data ->> 'item', p_data ->> 'item_sku'), 80)));
    end if;
    if v_sup is null or v_item is null then
      return jsonb_build_object('action', 'new');
    end if;
    select si.id into v_id from stock_co_supplier_items si
     where si.org_id = v_org and si.supplier_id = v_sup and si.archived_at is null
       and nullif(btrim(coalesce(p_data ->> 'supplier_sku', '')), '') is not null and lower(si.sku) = lower(btrim(p_data ->> 'supplier_sku'))
     order by si.created_at, si.id limit 1;
    if v_id is null then
      select si.id into v_id from stock_co_supplier_items si
       where si.org_id = v_org and si.supplier_id = v_sup and si.item_id = v_item and si.archived_at is null
         and si.pack_qty = coalesce(nullif(p_data ->> 'pack_qty', '')::numeric, 1)
         and si.inner_qty = coalesce(nullif(p_data ->> 'inner_qty', '')::numeric, 1)
         and si.inner_unit = lower(btrim(p_data ->> 'inner_unit'))
       order by si.created_at, si.id limit 1;
    end if;
    if v_id is null then
      return jsonb_build_object('action', 'new');
    end if;
    select * into v_x from stock_co_supplier_items si where si.id = v_id;
    return jsonb_build_object('target_id', v_id, 'action',
      case when (p_data ->> 'pack_price')::numeric is distinct from v_x.pack_price then 'change' else 'same' end);
  elsif p_kind = 'par' then
    -- by name first (the name index), then by the item's sku
    select i.id into v_item from stock_co_items i
     where i.org_id = v_org and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(p_data ->> 'item', '')))
     order by i.created_at, i.id limit 1;
    if v_item is null and nullif(btrim(coalesce(p_data ->> 'item_sku', '')), '') is not null then
      select i.id into v_item from stock_co_items i
       where i.org_id = v_org and i.archived_at is null and lower(i.sku) = lower(btrim(p_data ->> 'item_sku'))
       order by i.created_at, i.id limit 1;
    end if;
    select l.id into v_loc from locations l where l.org_id = v_org and lower(l.name) = lower(btrim(coalesce(p_data ->> 'site', '')))
     order by l.id limit 1;
    if v_loc is null then
      return jsonb_build_object('action', 'problem', 'problem', format('No site called %s.', left(coalesce(p_data ->> 'site', ''), 80)));
    end if;
    if v_item is null and not exists (select 1 from stock_co_import_rows r
                                       where r.job_id = p_job and r.kind = 'item' and r.action = 'new'
                                         and lower(btrim(r.data ->> 'name')) = lower(btrim(coalesce(p_data ->> 'item', '')))) then
      return jsonb_build_object('action', 'problem', 'problem',
        format('No stock item called %s. Add it to the file or the list first.', left(coalesce(p_data ->> 'item', p_data ->> 'item_sku', ''), 80)));
    end if;
    return jsonb_build_object('action', 'change', 'target_id', v_item);
  end if;
  return jsonb_build_object('action', 'problem', 'problem', 'This kind of row is not known.');
end
$function$;

CREATE OR REPLACE FUNCTION public.stock_co__import_apply(p_job uuid, p_after integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_j stock_co_import_jobs;
  v_by text;
  v_weight integer := 0;
  v_rows integer := 0;
  v_last integer := coalesce(p_after, 0);
  v_refused jsonb := '[]'::jsonb;
  v_sites uuid[];
  v_id uuid;
  v_sup uuid;
  v_item uuid;
  v_loc uuid;
  v_site_item uuid;
  v_si stock_co_supplier_items;
  v_new stock_co_items;
  v_x uuid;
  v_s uuid;
  v_days jsonb;
  v_cut text;
  v_tl uuid[] := '{}'::uuid[];
  v_ti uuid[] := '{}'::uuid[];
  v_yl uuid[] := '{}'::uuid[];
  v_yi uuid[] := '{}'::uuid[];
  v_ul uuid[] := '{}'::uuid[];
  v_us uuid[] := '{}'::uuid[];
  r record;
  d jsonb;
  v_lines jsonb;
  v_ln jsonb;
  v_put jsonb;
  v_on jsonb;
begin
  select * into v_j from stock_co_import_jobs j where j.id = p_job for update;
  if v_j.id is null then
    return jsonb_build_object('last_row', v_last, 'rows', 0, 'finished', true, 'refused', '[]'::jsonb);
  end if;
  v_by := coalesce(nullif(btrim(coalesce(v_j.created_by_name, '')), ''), 'import');
  perform set_config('servos.stock_co_source', 'import', true);
  for r in
    select * from stock_co_import_rows x
     where x.job_id = p_job and x.row_no > v_last
     order by x.row_no
     limit 300
  loop
    exit when v_weight >= 300;
    v_last := r.row_no;
    v_rows := v_rows + 1;
    d := r.data;
    v_sites := array(select l.id from locations l
                      where l.org_id = v_j.org_id and l.id = any(coalesce(r.sites, v_j.sites))
                      order by l.id);
    -- a par row needs the items of the rows before it ticked at their sites first
    if r.kind = 'par' and cardinality(v_tl) > 0 then
      perform public.stock_co__import_flush(v_tl, v_ti, v_by, 'tick');
      v_tl := '{}'::uuid[];
      v_ti := '{}'::uuid[];
    end if;
    begin
      if r.done or r.action in ('skip', 'problem') then
        null;
      elsif r.kind = 'recipe' then
        -- Drop 2: a recipe row through stock_co__recipe_put, then on at the row's sites (no till link:
        -- Recipe missing offers it)
        v_lines := '[]'::jsonb;
        for v_ln in select e.value from jsonb_array_elements(case when jsonb_typeof(d -> 'lines') = 'array' then d -> 'lines' else '[]'::jsonb end) e loop
          v_item := null;
          select i.id into v_item from stock_co_items i
           where i.org_id = v_j.org_id and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(v_ln ->> 'item', '')))
           order by i.created_at, i.id limit 1;
          if v_item is null and nullif(btrim(coalesce(v_ln ->> 'item_sku', '')), '') is not null then
            select i.id into v_item from stock_co_items i
             where i.org_id = v_j.org_id and i.archived_at is null and lower(i.sku) = lower(btrim(v_ln ->> 'item_sku'))
             order by i.created_at, i.id limit 1;
          end if;
          if v_item is null then
            raise exception 'The stock item % of this recipe is not there.', coalesce(v_ln ->> 'item', v_ln ->> 'item_sku', '')
              using errcode = '22023';
          end if;
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'component_item_id', v_item, 'qty', nullif(v_ln ->> 'qty', '')::numeric, 'unit', lower(btrim(coalesce(v_ln ->> 'unit', ''))),
            'usable_pct', nullif(v_ln ->> 'usable_pct', '')::numeric,
            'order_types', case when jsonb_typeof(v_ln -> 'order_types') = 'array' then v_ln -> 'order_types' end));
        end loop;
        v_item := null;
        if coalesce(nullif(d ->> 'kind', ''), 'dish') in ('batch', 'prep') then
          select i.id into v_item from stock_co_items i
           where i.org_id = v_j.org_id and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(d ->> 'output_item', '')))
           order by i.created_at, i.id limit 1;
          if v_item is null then
            raise exception 'The made item % of this recipe is not there.', coalesce(d ->> 'output_item', '') using errcode = '22023';
          end if;
        end if;
        v_id := r.target_id;
        if v_id is null or not exists (select 1 from stock_co_recipes c where c.id = v_id and c.archived_at is null) then
          select c.id into v_id from stock_co_recipes c
           where c.org_id = v_j.org_id and c.archived_at is null and lower(c.name) = lower(btrim(d ->> 'name'))
           order by c.created_at, c.id limit 1;
        end if;
        if v_id is null or r.action = 'change' then
          v_put := public.stock_co__recipe_put(v_j.org_id, null,
                     jsonb_build_object('kind', coalesce(nullif(d ->> 'kind', ''), 'dish'), 'name', btrim(d ->> 'name'),
                                        'food_kind', nullif(d ->> 'food_kind', ''),
                                        'yield_qty', coalesce(nullif(d ->> 'yield_qty', '')::numeric, 1),
                                        'yield_unit', coalesce(nullif(lower(btrim(coalesce(d ->> 'yield_unit', ''))), ''), 'each'),
                                        'output_item_id', v_item)
                     || case when v_id is null then '{}'::jsonb else jsonb_build_object('id', v_id) end,
                     public.stock_co__recipe_lines_clean(v_j.org_id, null, v_lines),
                     jsonb_build_object('uid', v_j.created_by, 'name', v_by), 'import');
          v_id := (v_put ->> 'id')::uuid;
        end if;
        foreach v_s in array v_sites loop
          v_on := public.stock_co__recipe_on_at(v_id, v_s, null, 'Added by ' || v_by, v_by);
          if not coalesce((v_on ->> 'ok')::boolean, false) and jsonb_array_length(v_refused) < 50 then
            v_refused := v_refused || jsonb_build_array(jsonb_build_object('row_no', r.row_no, 'location_id', v_s, 'error', left(v_on ->> 'error', 300)));
          end if;
        end loop;
        update stock_co_import_rows x set target_id = v_id where x.job_id = p_job and x.row_no = r.row_no;
        v_weight := v_weight + 2 + jsonb_array_length(v_lines) * greatest(cardinality(v_sites), 1);
      elsif r.kind = 'item' then
        v_id := r.target_id;
        if v_id is null or not exists (select 1 from stock_co_items i where i.id = v_id and i.archived_at is null) then
          -- matched again at commit time: a row earlier in the file may have made it
          select i.id into v_id from stock_co_items i
           where i.org_id = v_j.org_id and i.archived_at is null and lower(i.name) = lower(btrim(d ->> 'name'))
             and i.base_unit = lower(btrim(d ->> 'base_unit'))
           order by i.created_at, i.id limit 1;
        end if;
        if v_id is null then
          v_new := jsonb_populate_record(null::stock_co_items, jsonb_build_object(
                     'id', gen_random_uuid(), 'org_id', v_j.org_id, 'name', btrim(d ->> 'name'),
                     'base_unit', lower(btrim(d ->> 'base_unit')), 'type', nullif(d ->> 'type', ''),
                     'sku', nullif(btrim(coalesce(d ->> 'sku', '')), ''), 'barcode', nullif(btrim(coalesce(d ->> 'barcode', '')), ''),
                     'shelf_life_days', nullif(d ->> 'shelf_life_days', '')::numeric::integer,
                     'purchase_vat_rate', nullif(d ->> 'purchase_vat_rate', '')::numeric,
                     'allergens', case when jsonb_typeof(d -> 'allergens') = 'array' then d -> 'allergens' else '[]'::jsonb end,
                     'returns_to_shelf', false, 'exclude_from_gp', false, 'key_item', false,
                     'row_version', 1, 'created_at', now(), 'updated_at', now(), 'updated_by', v_j.created_by));
          v_new.category_id := public.stock_co__category_for(v_j.org_id, d ->> 'category');
          v_new.category := (select c.name from stock_co_categories c where c.id = v_new.category_id);
          insert into stock_co_items select (v_new).*;
          v_id := v_new.id;
          perform public.stock_co__log(v_j.org_id, null, 'item', v_id, 'created', null, to_jsonb(v_new) - array['updated_at', 'row_version', 'created_at', 'updated_by'], 'import');
          if jsonb_typeof(d -> 'count_pack') = 'object' and nullif(d -> 'count_pack' ->> 'name', '') is not null
             and coalesce(nullif(d -> 'count_pack' ->> 'qty_in_base', '')::numeric, 0) > 0 then
            insert into stock_co_packs (org_id, item_id, name, qty_in_base, is_count_default, is_purchase_default)
            values (v_j.org_id, v_id, btrim(d -> 'count_pack' ->> 'name'), (d -> 'count_pack' ->> 'qty_in_base')::numeric, true, false);
          end if;
        else
          update stock_co_items i
             set category_id = case when nullif(btrim(coalesce(d ->> 'category', '')), '') is not null
                                    then public.stock_co__category_for(v_j.org_id, d ->> 'category') else i.category_id end,
                 type = case when nullif(d ->> 'type', '') is not null then d ->> 'type' else i.type end,
                 sku = case when nullif(btrim(coalesce(d ->> 'sku', '')), '') is not null then btrim(d ->> 'sku') else i.sku end,
                 barcode = case when nullif(btrim(coalesce(d ->> 'barcode', '')), '') is not null then btrim(d ->> 'barcode') else i.barcode end,
                 shelf_life_days = case when nullif(d ->> 'shelf_life_days', '') is not null then (d ->> 'shelf_life_days')::numeric::integer
                                        else i.shelf_life_days end,
                 purchase_vat_rate = case when nullif(d ->> 'purchase_vat_rate', '') is not null then (d ->> 'purchase_vat_rate')::numeric
                                          else i.purchase_vat_rate end,
                 row_version = i.row_version + 1, updated_at = now(), updated_by = v_j.created_by
           where i.id = v_id and r.action = 'change';
          update stock_co_items i set category = (select c.name from stock_co_categories c where c.id = i.category_id)
           where i.id = v_id and r.action = 'change' and i.category is distinct from (select c.name from stock_co_categories c where c.id = i.category_id);
          if r.action = 'change' then
            perform public.stock_co__log(v_j.org_id, null, 'item', v_id, 'import', null, d, 'import');
          end if;
        end if;
        -- ticked at its sites (and a changed item written at its sites) once per step, below
        v_tl := v_tl || v_sites;
        v_ti := v_ti || array_fill(v_id, array[cardinality(v_sites)]);
        if r.action = 'change' then
          select v_yl || coalesce(array_agg(s.location_id), '{}'::uuid[]), v_yi || coalesce(array_agg(s.item_id), '{}'::uuid[])
            into v_yl, v_yi
            from stock_co_item_sites s where s.item_id = v_id;
        end if;
        update stock_co_import_rows x set target_id = v_id where x.job_id = p_job and x.row_no = r.row_no;
        v_weight := v_weight + 1 + greatest(cardinality(v_sites), (select count(*)::integer from stock_co_item_sites s where s.item_id = v_id));
      elsif r.kind = 'supplier' then
        v_id := r.target_id;
        if v_id is null then
          select m.id into v_id from stock_co_suppliers m
           where m.org_id = v_j.org_id and m.archived_at is null and lower(m.name) = lower(btrim(d ->> 'name'))
           order by m.created_at, m.id limit 1;
        end if;
        if v_id is null then
          insert into stock_co_suppliers (org_id, name, contact_name, phone, email, payment_terms_days, min_order_value, accepts_price_changes, order_method)
          values (v_j.org_id, btrim(d ->> 'name'), nullif(btrim(coalesce(d ->> 'contact_name', '')), ''), nullif(btrim(coalesce(d ->> 'phone', '')), ''),
                  nullif(btrim(coalesce(d ->> 'email', '')), ''), nullif(d ->> 'payment_terms_days', '')::numeric::integer,
                  nullif(d ->> 'min_order_value', '')::numeric, true, 'email')
          returning id into v_id;
          perform public.stock_co__log(v_j.org_id, null, 'supplier', v_id, 'created', null, d, 'import');
        elsif r.action = 'change' then
          update stock_co_suppliers m
             set email = coalesce(nullif(btrim(coalesce(d ->> 'email', '')), ''), m.email),
                 phone = coalesce(nullif(btrim(coalesce(d ->> 'phone', '')), ''), m.phone),
                 contact_name = coalesce(nullif(btrim(coalesce(d ->> 'contact_name', '')), ''), m.contact_name),
                 row_version = m.row_version + 1, updated_at = now()
           where m.id = v_id;
          perform public.stock_co__log(v_j.org_id, null, 'supplier', v_id, 'import', null, d, 'import');
        end if;
        foreach v_s in array v_sites loop
          select ss.site_supplier_id into v_x from stock_co_supplier_sites ss where ss.supplier_id = v_id and ss.location_id = v_s;
          if v_x is null then
            v_x := public.stock_co__new_site_supplier(v_id, v_s);
            perform public.stock_co__log(v_j.org_id, v_s, 'supplier_site', v_id, 'can_order', to_jsonb(false), to_jsonb(true), 'import');
          end if;
          -- the site's own values only where it has none
          update suppliers t
             set account_number = coalesce(t.account_number, nullif(btrim(coalesce(d ->> 'account_number', '')), '')),
                 min_order_value = coalesce(t.min_order_value, nullif(d ->> 'min_order_value', '')::numeric),
                 delivery_days = case when coalesce(jsonb_array_length(case when jsonb_typeof(t.delivery_days) = 'array' then t.delivery_days end), 0) = 0
                                       and jsonb_typeof(d -> 'delivery_days') = 'array' then d -> 'delivery_days' else t.delivery_days end,
                 cutoff_time = coalesce(t.cutoff_time, nullif(btrim(coalesce(d ->> 'cutoff_time', '')), '')),
                 row_version = t.row_version + 1, updated_at = now()
           where t.id = v_x and t.location_id = v_s
             and ((t.account_number is null and nullif(btrim(coalesce(d ->> 'account_number', '')), '') is not null)
                  or (t.min_order_value is null and nullif(d ->> 'min_order_value', '') is not null)
                  or (coalesce(jsonb_array_length(case when jsonb_typeof(t.delivery_days) = 'array' then t.delivery_days end), 0) = 0
                      and jsonb_typeof(d -> 'delivery_days') = 'array' and jsonb_array_length(d -> 'delivery_days') > 0)
                  or (t.cutoff_time is null and nullif(btrim(coalesce(d ->> 'cutoff_time', '')), '') is not null));
          if found then
            perform public.stock_co__seed_order_rules(v_x);
            select z.delivery_days, z.cutoff_time into v_days, v_cut from public.stock_co__derive_days(v_x) z;
            update suppliers t set delivery_days = v_days, cutoff_time = v_cut
             where t.id = v_x and t.location_id = v_s
               and (t.delivery_days, t.cutoff_time) is distinct from (v_days, v_cut);
          end if;
          v_ul := v_ul || v_s;
          v_us := v_us || v_id;
        end loop;
        update stock_co_import_rows x set target_id = v_id where x.job_id = p_job and x.row_no = r.row_no;
        v_weight := v_weight + 1 + cardinality(v_sites);
      elsif r.kind = 'supplier_item' then
        select m.id into v_sup from stock_co_suppliers m
         where m.org_id = v_j.org_id and m.archived_at is null and lower(m.name) = lower(btrim(d ->> 'supplier'))
         order by m.created_at, m.id limit 1;
        select i.id into v_item from stock_co_items i
         where i.org_id = v_j.org_id and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(d ->> 'item', '')))
         order by i.created_at, i.id limit 1;
        if v_item is null and nullif(btrim(coalesce(d ->> 'item_sku', '')), '') is not null then
          select i.id into v_item from stock_co_items i
           where i.org_id = v_j.org_id and i.archived_at is null and lower(i.sku) = lower(btrim(d ->> 'item_sku'))
           order by i.created_at, i.id limit 1;
        end if;
        if v_sup is null or v_item is null then
          raise exception 'The supplier or the stock item of this row is not there.' using errcode = '22023';
        end if;
        v_id := r.target_id;
        if v_id is null or not exists (select 1 from stock_co_supplier_items si where si.id = v_id and si.archived_at is null) then
          select si.id into v_id from stock_co_supplier_items si
           where si.org_id = v_j.org_id and si.supplier_id = v_sup and si.item_id = v_item and si.archived_at is null
             and si.pack_qty = coalesce(nullif(d ->> 'pack_qty', '')::numeric, 1)
             and si.inner_qty = coalesce(nullif(d ->> 'inner_qty', '')::numeric, 1)
             and si.inner_unit = lower(btrim(d ->> 'inner_unit'))
           order by si.created_at, si.id limit 1;
        end if;
        select l.id into v_loc from locations l
         where l.org_id = v_j.org_id and nullif(btrim(coalesce(d ->> 'site', '')), '') is not null and lower(l.name) = lower(btrim(d ->> 'site'))
         order by l.id limit 1;
        if v_id is null then
          insert into stock_co_supplier_items (org_id, item_id, supplier_id, supplier_product_name, sku, pack_description, pack_qty, inner_qty,
                                               inner_unit, pack_price, currency, purchase_vat_rate, price_includes_tax)
          values (v_j.org_id, v_item, v_sup, nullif(btrim(coalesce(d ->> 'supplier_product_name', '')), ''),
                  nullif(btrim(coalesce(d ->> 'supplier_sku', '')), ''), nullif(btrim(coalesce(d ->> 'pack_description', '')), ''),
                  coalesce(nullif(d ->> 'pack_qty', '')::numeric, 1), coalesce(nullif(d ->> 'inner_qty', '')::numeric, 1),
                  lower(btrim(d ->> 'inner_unit')), round((d ->> 'pack_price')::numeric, 4),
                  coalesce(nullif(upper(btrim(coalesce(d ->> 'currency', ''))), ''),
                           (select coalesce(l.currency, 'GBP') from locations l where l.org_id = v_j.org_id order by l.created_at, l.id limit 1)),
                  nullif(d ->> 'purchase_vat_rate', '')::numeric, coalesce((d ->> 'price_includes_tax')::boolean, false))
          returning * into v_si;
          v_id := v_si.id;
          perform public.stock_co__log(v_j.org_id, null, 'supplier_item', v_id, 'created', null, d, 'import');
        elsif v_loc is not null then
          perform public.stock_co__price_apply(v_j.org_id, jsonb_build_array(jsonb_build_object('supplier_item_id', v_id, 'item_id', v_item,
                    'location_id', v_loc, 'after', round((d ->> 'pack_price')::numeric, 4))));
        elsif r.action = 'change' then
          perform public.stock_co__price_apply(v_j.org_id, jsonb_build_array(jsonb_build_object('supplier_item_id', v_id, 'item_id', v_item,
                    'location_id', null, 'after', round((d ->> 'pack_price')::numeric, 4))));
        end if;
        select v_yl || coalesce(array_agg(s.location_id), '{}'::uuid[]), v_yi || coalesce(array_agg(s.item_id), '{}'::uuid[])
          into v_yl, v_yi
          from stock_co_item_sites s
          join stock_co_supplier_sites ss on ss.supplier_id = v_sup and ss.location_id = s.location_id
         where s.item_id = v_item;
        update stock_co_import_rows x set target_id = v_id where x.job_id = p_job and x.row_no = r.row_no;
        v_weight := v_weight + 1 + (select count(*)::integer from stock_co_item_sites s where s.item_id = v_item);
      elsif r.kind = 'par' then
        select i.id into v_item from stock_co_items i
         where i.org_id = v_j.org_id and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(d ->> 'item', '')))
         order by i.created_at, i.id limit 1;
        if v_item is null and nullif(btrim(coalesce(d ->> 'item_sku', '')), '') is not null then
          select i.id into v_item from stock_co_items i
           where i.org_id = v_j.org_id and i.archived_at is null and lower(i.sku) = lower(btrim(d ->> 'item_sku'))
           order by i.created_at, i.id limit 1;
        end if;
        select l.id into v_loc from locations l where l.org_id = v_j.org_id and lower(l.name) = lower(btrim(coalesce(d ->> 'site', '')))
         order by l.id limit 1;
        select s.site_item_id into v_site_item from stock_co_item_sites s where s.item_id = v_item and s.location_id = v_loc;
        if v_site_item is null then
          raise exception '% is not on at %. Tick it there first.', coalesce(d ->> 'item', 'This item'), coalesce(d ->> 'site', 'that site')
            using errcode = '22023';
        end if;
        insert into par_levels (location_id, inventory_item_id, par_level, reorder_point, min_level, updated_at)
        values (v_loc, v_site_item, nullif(d ->> 'par_level', '')::numeric, nullif(d ->> 'reorder_point', '')::numeric,
                nullif(d ->> 'min_level', '')::numeric, now())
        on conflict (location_id, inventory_item_id)
          do update set par_level = coalesce(excluded.par_level, par_levels.par_level),
                        reorder_point = coalesce(excluded.reorder_point, par_levels.reorder_point),
                        min_level = coalesce(excluded.min_level, par_levels.min_level), updated_at = now();
        perform public.stock_co__log(v_j.org_id, v_loc, 'item_site', v_item, 'par', null, d, 'import');
        v_weight := v_weight + 1;
      end if;
      update stock_co_import_rows x set done = true where x.job_id = p_job and x.row_no = r.row_no;
    exception
      when lock_not_available or deadlock_detected or query_canceled then
        raise;
      when others then
        update stock_co_import_rows x set done = true, problem = left(sqlerrm, 300) where x.job_id = p_job and x.row_no = r.row_no;
        if jsonb_array_length(v_refused) < 50 then
          v_refused := v_refused || jsonb_build_array(jsonb_build_object('row_no', r.row_no, 'error', left(sqlerrm, 300)));
        end if;
    end;
  end loop;
  -- the site writes of this step, once per site: ticks, then suppliers, then items
  perform public.stock_co__import_flush(v_tl, v_ti, v_by, 'tick');
  perform public.stock_co__import_flush(v_ul, v_us, v_by, 'suppliers');
  perform public.stock_co__import_flush(v_yl, v_yi, v_by, 'items');
  perform set_config('servos.stock_co_source', '', true);
  return jsonb_build_object('last_row', v_last, 'rows', v_rows, 'refused', v_refused,
                            'finished', not exists (select 1 from stock_co_import_rows x where x.job_id = p_job and x.row_no > v_last));
end
$function$;

do $kind$
begin
  if not exists (select 1 from public.stock_co_import_rows where kind = 'bridge') then
    alter table public.stock_co_import_rows drop constraint if exists stock_co_import_rows_kind_check;
    alter table public.stock_co_import_rows add constraint stock_co_import_rows_kind_check
      check (kind = any (array['item'::text, 'supplier'::text, 'supplier_item'::text, 'par'::text, 'recipe'::text]));
  end if;
end $kind$;

do $check$
declare
  r record;
begin
  for r in
    select * from (values ('stock_import_stage', 'a4a7f104ccc8fb94aa4e262bbc9a9bc1', '1d9e5845ed729c476e2ff9aa42c11696'),
      ('stock_co__import_check_row', '0af01137551d69b5e3511eb4911f1025', '7007b29b56d6f961fe98e04ae50dbf4b'),
      ('stock_co__import_apply', '53fdb5e3c97bda88307d87486d085f17', 'c5fe2a30a1fafd5deb31fb474f7e805b')) v(fn, before, after)
  loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = r.fn and md5(p.prosrc) = r.before) then
      raise exception '% did not go back', r.fn;
    end if;
  end loop;
end $check$;

notify pgrst, 'reload schema';

commit;
