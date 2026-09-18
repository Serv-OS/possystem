-- 20260918_OPS_ezcater_catering_order_screens.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
-- Claude cannot apply production DDL by any route.
--
-- An ezCater order IS a catering order (Peter, 18 Sep 2026: "we need to ensure they follow the
-- same rules as the rest of our catering system"). From the same release the ezCater webhook
-- writes an order exactly as ServOS catering checkout does: status 'received', sent_at = the
-- KITCHEN FIRE time (food ready time minus the venue's catering prep time). Two lines of
-- order_status_feed were written for the old ezCater rows (status 'prep', sent_at = the event
-- time) and now treat ezCater differently from catering. This file makes them the same:
--
--   1. bucketed: a 'received' ezCater order no longer hides behind the "show unaccepted
--      delivery app orders" setting. ezCater orders are accepted in ezCater, never on our
--      till, so that setting has nothing to do with them. HubRise keeps the rule unchanged.
--   2. visible: the 60 minute early allowance for ezCater is gone. It existed because sent_at
--      used to be the event time; sent_at is now the kitchen fire time, so an ezCater order
--      shows when it fires, exactly like a catering order.
--   3. names: an ezCater name is typed by ezCater's customer, so it follows the catering name
--      rule (shown only after a status change made in a separate request).
--   4. the due index: the release reads "due, unfired catering" for BOTH sources now
--      (catering and ezcater). The old partial index covers source = 'catering' only, so two
--      partial indexes cover both: one per venue (the till release), one across venues (the
--      catering-release cron). The old index is left in place; it is harmless.
--
-- Nothing else in the function changes. The ezCater CHANNEL key (_osd_channel_key 'ezcater')
-- and its order number (_osd_number reads customer.ezcater_order_number) are untouched, so a
-- section can still pick ezCater on its own and the TV still shows ezCater's number.
--
-- RUN THIS FIRST, BEFORE THE EDGE FUNCTIONS ARE DEPLOYED. From that deploy the webhook writes a
-- new ezCater order as 'received', and until this file runs the TV feed hides a 'received'
-- ezCater order (it waits behind the "show unaccepted delivery app orders" setting) and shows it
-- up to 60 minutes before it fires. Nothing breaks and no order is lost either way; running this
-- first simply means the TVs are right from the first order.
--
-- Mirrors src/lib/orderScreen/orderScreenStatus.js evaluateOrder. Change both together.
-- src/lib/orderScreen/orderScreenSql.test.js pins this file to 20260911c line for line except
-- the two lines above.
--
-- Safe to run twice: it replaces one function and adds two indexes if missing, nothing else. Ownership, the security
-- barrier and every permission are untouched. Run it after
-- 20260911c_OPS_order_screen_names_follow_the_section.sql.
--
-- Rollback: re-run 20260911c_OPS_order_screen_names_follow_the_section.sql.

do $guard$ begin
  if to_regclass('public.order_status_displays') is null then
    raise exception 'Wrong database. Run this on the Ops project, after 20260911c_OPS_order_screen_names_follow_the_section.sql.';
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
  -- Hides nothing now: each section's own "Name on screen" choice decides what shows. It comes
  -- back below as names_enabled, to keep the payload shape steady for a TV on older JS.
  v_names := coalesce(public.order_status_names_enabled(), false);

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
            case when j.source = 'hubrise' and not v_unaccepted then null else 'received' end
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
                 or b.sent_at <= v_now)
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
             -- The section's own "Name on screen" choice is the only control here: _osd_name
             -- returns null when that section is set to Order number only, so the row shows
             -- its number instead. Customer typed names (kiosk, online, QR, catering) still
             -- show only after a status change made in a separate request. That does NOT stop
             -- a determined writer while anyone can update order_queue, which is the risk
             -- named at the top of this file.
             'name', case
               when l.source in ('kiosk','online','qr','catering','ezcater')
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

-- The due index for every catering source (point 4 above). IF NOT EXISTS, so safe to run twice.
create index if not exists idx_order_queue_catering_sources_due
  on public.order_queue (location_id, sent_at)
  where source in ('catering', 'ezcater') and kitchen_routed_at is null;
create index if not exists idx_order_queue_catering_sources_due_all
  on public.order_queue (sent_at)
  where source in ('catering', 'ezcater') and kitchen_routed_at is null;
