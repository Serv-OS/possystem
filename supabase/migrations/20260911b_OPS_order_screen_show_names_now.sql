-- 20260911b_OPS_order_screen_show_names_now.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
--
-- Adds the per screen override "Show customer names now" (Back Office, Channels, Order
-- screens). order_status_feed still hides every name while order_queue keeps its "allow all"
-- policy, UNLESS that screen's own config has settings.showNamesNow = true.
--
-- Safe to run twice: it only replaces one function. Grants, ownership and the security
-- barrier are unchanged. Run it after 20260911_OPS_order_status_displays.sql.
--
-- Rollback: re-run 20260911_OPS_order_status_displays.sql, which holds the old definition.

do $guard$ begin
  if to_regclass('public.order_status_displays') is null then
    raise exception 'Wrong database. Run this on the Ops project, after 20260911_OPS_order_status_displays.sql.';
  end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.order_status_feed(p_screen_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  s record;
  d record;
  v_venue record;
  v_loc text;
  v_linger integer;
  v_max_age integer;
  v_unaccepted boolean;
  v_names boolean;
  v_rows jsonb;
  v_count integer;
begin
  if v_uid is null then
    return jsonb_build_object('paired', false, 'reason', 'no_session', 'server_now', v_now);
  end if;
  select ms.id, ms.location_id, ms.order_display_id, ms.status into s
    from public.menu_board_screens ms
   where ms.id = p_screen_id and ms.device_uid = v_uid;
  if s.id is null then
    return jsonb_build_object('paired', false, 'reason', 'no_screen', 'server_now', v_now);
  end if;
  if s.status is distinct from 'paired' or s.order_display_id is null or s.location_id is null then
    return jsonb_build_object('paired', false, 'reason', 'not_assigned', 'server_now', v_now);
  end if;
  select * into d from public.order_status_displays od
   where od.id = s.order_display_id and od.location_id = s.location_id;
  if d.id is null then
    return jsonb_build_object('paired', false, 'reason', 'not_assigned', 'server_now', v_now);
  end if;

  select l.name, l.timezone into v_venue from public.locations l where l.id = s.location_id;
  v_loc := s.location_id::text;
  v_linger := public._osd_int(d.settings->>'lingerMinutes', 2, 0, 30);
  v_max_age := public._osd_int(d.settings->>'maxAgeHours', 6, 1, 24);
  v_unaccepted := coalesce(d.settings->>'showUnacceptedPlatform', 'false') = 'true';
  -- Names stay hidden while order_queue carries a policy that lets any caller insert or update
  -- it (order_status_names_enabled), because words typed by anyone would land on a customer
  -- facing TV. A venue may accept that risk for ONE screen with that screen's own setting.
  v_names := coalesce(public.order_status_names_enabled(), false)
             or coalesce((d.settings->>'showNamesNow')::boolean, false);

  if not d.is_active then
    v_rows := '[]'::jsonb; v_count := 0;
  else
    with sec as (
      select (e.ord - 1)::int as idx, e.val as sec
        from jsonb_array_elements(d.sections) with ordinality as e(val, ord)
       where e.ord <= 4 and jsonb_typeof(e.val) = 'object'
    ),
    src as (
      select q.ref, q.source, q.type, q.status, q.sent_at, q.created_at,
             jsonb_build_object('name', q.customer->>'name', 'channel', q.customer->>'channel',
                                'collectionCode', q.customer->>'collectionCode',
                                'ezcater_order_number', q.customer->>'ezcater_order_number') as cust,
             m.status_changed_at, m.first_seen_at, null::timestamptz as departed_at, false as departed
        from public.order_queue q
        left join public.order_status_marks m on m.location_id = q.location_id and m.ref = q.ref
       where q.location_id = v_loc
         and q.status in ('received','scheduled','prep','ready','collected')
      union all
      select m.ref, m.source, m.type, m.departed_from, null::timestamptz, null::timestamptz,
             coalesce(m.snapshot, '{}'::jsonb), m.status_changed_at, m.first_seen_at, m.departed_at, true
        from public.order_status_marks m
       where m.location_id = v_loc
         and v_linger > 0
         and m.departed_at is not null
         and m.departed_at > v_now - make_interval(mins => v_linger)
         and m.departed_from in ('ready','collected')
         and not exists (select 1 from public.order_queue q2 where q2.location_id = v_loc and q2.ref = m.ref)
    ),
    enriched as (
      select x.*,
             public._osd_channel_key(x.source, x.cust->>'channel') as ch,
             public._osd_type_key(x.type) as tk,
             c.dispatch_backend as courier_backend, c.status as courier_status,
             c.picked_at as courier_picked_at, c.updated_at as courier_updated_at,
             h.hr_status, h.updated_at as hr_updated_at
        from src x
        left join lateral (
          select cd.dispatch_backend, cd.status, cd.picked_at, cd.updated_at
            from public.courier_deliveries cd
           where cd.location_id = v_loc and cd.order_ref = x.ref
             and cd.status not in ('canceled','returned','failed')
           order by cd.created_at desc
           limit 1
        ) c on true
        left join public.hubrise_order_links h
          on x.source = 'hubrise' and h.ref = x.ref and h.location_id = v_loc
    ),
    placed as (
      select e.*, s1.idx as sec_idx, s1.sec as sec
        from enriched e
        left join lateral (
          select sec.idx, sec.sec from sec
           where e.ch is not null and e.tk is not null
             and coalesce(sec.sec->'channels', '[]'::jsonb) ? e.ch
             and coalesce(sec.sec->'orderTypes', '[]'::jsonb) ? e.tk
           order by sec.idx
           limit 1
        ) s1 on true
    ),
    judged as (
      select p.*,
        case
          -- A deleted row lingers from its EARLIEST collection signal, so an order a courier
          -- or the platform already finished never comes back when staff clear it later.
          when p.departed then least(
            p.departed_at,
            case when p.courier_backend is not null and (p.courier_picked_at is not null or p.courier_status in ('dropoff','delivered'))
                 then coalesce(p.courier_picked_at, p.courier_updated_at) end,
            case when p.hr_status = 'completed' then p.hr_updated_at end)
          when p.status = 'collected' then p.status_changed_at
          when p.courier_backend is not null and (p.courier_picked_at is not null or p.courier_status in ('dropoff','delivered'))
            then coalesce(p.courier_picked_at, p.courier_updated_at)
          when p.hr_status = 'completed' then p.hr_updated_at
          else null
        end as collected_at
      from placed p
    ),
    bucketed as (
      select j.*,
        case
          when j.collected_at is not null then 'collected'
          when j.departed or j.status = 'collected' then null
          when j.status in ('received','scheduled') then
            case when j.source in ('hubrise','ezcater') and not v_unaccepted then null else 'received' end
          when j.status = 'prep' then 'preparing'
          when j.status = 'ready' then 'ready'
          else null
        end as bucket
      from judged j
    ),
    visible as (
      select b.* from bucketed b
       where b.sec_idx is not null
         and b.bucket is not null
         and (
           (b.bucket = 'collected' and v_linger > 0 and b.collected_at > v_now - make_interval(mins => v_linger))
           or
           (b.bucket <> 'collected'
            -- A till pre order waits as scheduled with no fire time. It shows once the till fires it.
            and not (b.status = 'scheduled' and b.sent_at is null)
            and (b.sent_at is null
                 or b.sent_at <= v_now + case when b.source = 'ezcater' then interval '60 minutes' else interval '0 minutes' end)
            and coalesce(case when b.sent_at is not null then least(b.sent_at, v_now) end, b.created_at, v_now)
                >= v_now - make_interval(hours => v_max_age)
            and coalesce(b.sec->'statuses', '[]'::jsonb) ? b.bucket)
         )
    ),
    ranked as (
      select v.*,
             case v.bucket when 'ready' then 0 when 'preparing' then 1 when 'received' then 2 else 3 end as rnk,
             coalesce(v.status_changed_at, v.sent_at, v.created_at, v_now) as since_at,
             public._osd_number(v.ref, v.source, v.cust, v.courier_backend) as num_base,
             count(*) over () as total_rows
        from visible v
    ),
    limited as (
      select r.*,
             row_number() over (order by r.sec_idx, r.rnk, r.since_at, r.ref) as rn,
             -- Two rows in one section with the same 3 character online, catering or QR code
             -- would look identical, so those rows show 4 characters instead.
             case when r.ref ~ '^(OL|CA|QR)-' and count(*) over (partition by r.sec_idx, r.num_base) > 1
                  then right(r.ref, 4) else r.num_base end as num
        from ranked r
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'key', left(md5(v_loc || ':' || l.ref), 12),
             'section_id', l.sec->>'id',
             'section_index', l.sec_idx,
             'bucket', l.bucket,
             'number', l.num,
             -- No names at all while order_queue is open to any writer (see NAMES at the top).
             -- Customer typed names (kiosk, online, QR, catering) then show only after a status
             -- change made in a separate request. That alone does NOT stop an attacker while
             -- anyone can update order_queue; only the fence does, which is why v_names gates it.
             'name', case
               when not v_names then null
               when l.source in ('kiosk','online','qr','catering')
                and not coalesce(l.status_changed_at > l.first_seen_at, false) then null
               else public._osd_name(l.cust->>'name', l.sec->>'nameFormat')
             end,
             'channel', l.ch,
             'channel_name', case when l.ch = 'other_app' then left(nullif(btrim(l.cust->>'channel'), ''), 20) end,
             'courier', l.courier_backend,
             'order_type', l.tk,
             'since', l.since_at,
             'expires_at', case when l.bucket = 'collected' then l.collected_at + make_interval(mins => v_linger) end
           ) order by l.rn), '[]'::jsonb),
           coalesce(max(l.total_rows), 0)
      into v_rows, v_count
      from limited l
     where l.rn <= 200;
  end if;

  return jsonb_build_object(
    'paired', true, 'active', d.is_active, 'server_now', v_now, 'location_key', v_loc,
    'names_enabled', v_names,
    -- timezone here is the LEGACY ops column. The TV prefers the platform venue zone
    -- (fetchVenueTimezone) and uses this only as a last resort.
    'venue', jsonb_build_object('name', v_venue.name, 'timezone', v_venue.timezone),
    'display', jsonb_build_object('id', d.id, 'version', d.version, 'name', d.name,
       'orientation', d.orientation, 'rotate', d.rotate, 'sections', d.sections,
       'labels', d.labels, 'settings', d.settings, 'theme', d.theme),
    'rows', v_rows, 'truncated', v_count > 200);
end $function$;
