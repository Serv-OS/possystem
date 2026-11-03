-- 20261116a ROLLBACK: puts venue_clock_sync back as it was before 5.12.48 (the venue rows already
-- corrected are left on their Platform zone; that is the right value).
begin;

CREATE OR REPLACE FUNCTION public.venue_clock_sync(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r          jsonb;
  v_loc      uuid;
  v_pid      uuid;
  v_tz       text;
  v_start    text;
  v_m        text[];
  v_ds       time;
  v_ops_tz   text;
  v_n        integer := 0;
  v_mis      jsonb := '[]'::jsonb;
  v_missing  jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'The venue clock is set by the platform only.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'venue_clock_sync: p_rows must be a list of venues.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'venue_clock_sync: at most 1000 venues at a time.' using errcode = '22023';
  end if;

  for r in select e from jsonb_array_elements(p_rows) as e loop
    continue when jsonb_typeof(r) is distinct from 'object';
    v_loc := null;
    v_pid := null;
    begin
      v_loc := nullif(btrim(r ->> 'ops_location_id'), '')::uuid;
    exception when invalid_text_representation then
      v_loc := null;
    end;
    continue when v_loc is null;
    select l.timezone into v_ops_tz from locations l where l.id = v_loc;
    continue when not found;

    -- a real zone name, and one this database knows (asked by using it, as report_day_sums does)
    v_tz := nullif(btrim(r ->> 'timezone'), '');
    continue when v_tz is null or v_tz !~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$';
    begin
      perform timestamp '2026-01-01 12:00' at time zone v_tz;
    exception when others then
      continue;
    end;

    v_start := nullif(btrim(r ->> 'business_day_start'), '');
    if v_start is null then
      v_ds := time '06:00';
    else
      v_m := regexp_match(v_start, '^([0-9]{1,2}):([0-9]{2})(:[0-9]{2})?$');
      continue when v_m is null or v_m[1]::integer > 23 or v_m[2]::integer > 59;
      v_ds := make_time(v_m[1]::integer, v_m[2]::integer, 0);
    end if;

    begin
      v_pid := nullif(btrim(r ->> 'platform_location_id'), '')::uuid;
    exception when invalid_text_representation then
      v_pid := null;
    end;

    insert into venue_clock (location_id, platform_location_id, timezone, day_start, synced_at, mismatch)
    values (v_loc, v_pid, v_tz, v_ds, now(),
            case when coalesce(btrim(v_ops_tz), '') <> v_tz
                 then format('Ops says %s, the platform says %s.', coalesce(nullif(btrim(v_ops_tz), ''), 'nothing'), v_tz) end)
    on conflict (location_id) do update
       set platform_location_id = excluded.platform_location_id,
           timezone = excluded.timezone,
           day_start = excluded.day_start,
           synced_at = excluded.synced_at,
           mismatch = excluded.mismatch;
    v_n := v_n + 1;
    if coalesce(btrim(v_ops_tz), '') <> v_tz then
      v_mis := v_mis || jsonb_build_array(jsonb_build_object('location_id', v_loc, 'ops_timezone', v_ops_tz,
                                                             'platform_timezone', v_tz));
    end if;
  end loop;

  select coalesce(jsonb_agg(q.id order by q.id), '[]'::jsonb) into v_missing
    from (select l.id from locations l
           where not exists (select 1 from venue_clock c where c.location_id = l.id)
           order by l.id
           limit 1000) q;
  return jsonb_build_object('ok', true, 'upserted', v_n, 'mismatches', v_mis, 'missing', v_missing);
end
$function$;

commit;
