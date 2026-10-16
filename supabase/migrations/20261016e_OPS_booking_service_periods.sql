-- 20261016e_OPS_booking_service_periods.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  RUN 20261016b_OPS_bookings_core.sql FIRST (and 20261016c before this,   #
-- #  the agreed order is c, d, e, f). This file replaces the create_booking   #
-- #  that 20261016b writes, and PATCHES edit_booking in place (one check      #
-- #  added) so the fence 20261016c set is kept. It stops with a plain         #
-- #  message if edit_booking is not there yet or is not the expected version. #
-- #  Additive and safe to run twice. One transaction. No table is rewritten: #
-- #  four columns with constant defaults on booking_rules (a tiny table),     #
-- #  six internal helpers, create_booking replaced and edit_booking patched,  #
-- #  both with the same signatures and the same grants.                       #
-- #  Safe in service: no venue changes until it sets service periods, closed #
-- #  days or date blocks (every live venue today has none), and walk ins are #
-- #  never refused.                                                           #
-- ############################################################################
--
-- WHY (bookings audit, 16 Oct 2026, section 3 item 6)
--   A venue had one service window for every day (17:00 to 23:00 by default), so lunch and
--   dinner, closed Mondays, a Christmas closure, a private hire evening or a late licence could
--   not be set. Every booking only system a customer compares us with has service periods.
--   This adds, per venue, on booking_rules:
--     service_periods     jsonb  [{ id, name, days: [1..7], start: 'HH:MM', end: 'HH:MM',
--                                   lastSeating: 'HH:MM' | null }]
--                                days are ISO weekdays (1 Monday, 7 Sunday); an end at or before
--                                the start runs past midnight; lastSeating is the latest start,
--                                and never after 23:59
--     closed_weekdays     jsonb  [1..7]  no service at all on these days
--     date_blocks         jsonb  [{ id, from: 'YYYY-MM-DD', to, label, start?, end?, onlineOnly? }]
--                                no times = the whole service day; times = only those times
--     min_notice_minutes  int    online bookings need this much notice (the host stand never)
--   The existing widget_max_days_ahead is the maximum days ahead.
--   A booking belongs to the calendar date it starts on. A service may END past midnight, but
--   nobody is booked in after midnight: every free check (create_booking, edit_booking,
--   move_booking, the stand, the widget) reads one date's bookings, so a 00:30 seat filed under
--   Saturday could share a table with a Friday 23:30 one. The app has the same rules as tested
--   pure functions
--   (src/lib/bookings/optimiser.js and its edge copy).
--
-- WHAT THE DATABASE NOW REFUSES (create_booking, and edit_booking when the date or time moves)
--   outside_service   a time outside every service period that day, or after its last seating
--   closed_day        a closed weekday, or a weekday no period covers
--   blocked           a whole day block, or a time inside a timed block
--   too_soon, past, too_far_ahead   online bookings only (source 'widget' or 'online')
--   Each refusal carries message: the words the host stand and the widget show.
--   Never refused: walk ins (source 'walk_in' or status 'dining'); a venue with no service
--   periods keeps its single window unenforced here exactly as today (only closed days and
--   blocks, once set, apply to it); an edit that keeps the date and the time.
--
-- BEFORE THIS RUNS the app already works: the Rules screen and Back Office say the update is
-- needed and save nothing for service periods; the widget and the stand use the old window.
--
-- AFTER RUNNING
--   Read the check select at the bottom. Then deploy booking-widget (listed in the PR).

begin;

set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'edit_booking') then
    raise exception 'Run 20261016b_OPS_bookings_core.sql first: edit_booking is not on this database yet. Nothing was changed.';
  end if;
end $$;

-- ── 1. the columns ─────────────────────────────────────────────────────────
alter table public.booking_rules add column if not exists service_periods jsonb not null default '[]'::jsonb;
alter table public.booking_rules add column if not exists closed_weekdays jsonb not null default '[]'::jsonb;
alter table public.booking_rules add column if not exists date_blocks jsonb not null default '[]'::jsonb;
alter table public.booking_rules add column if not exists min_notice_minutes integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'booking_rules_service_periods_array') then
    alter table public.booking_rules add constraint booking_rules_service_periods_array
      check (jsonb_typeof(service_periods) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'booking_rules_closed_weekdays_array') then
    alter table public.booking_rules add constraint booking_rules_closed_weekdays_array
      check (jsonb_typeof(closed_weekdays) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'booking_rules_date_blocks_array') then
    alter table public.booking_rules add constraint booking_rules_date_blocks_array
      check (jsonb_typeof(date_blocks) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'booking_rules_min_notice_range') then
    alter table public.booking_rules add constraint booking_rules_min_notice_range
      check (min_notice_minutes between 0 and 20160);
  end if;
end $$;

comment on column public.booking_rules.service_periods is
  '16 Oct 2026: [{ id, name, days [1..7 ISO], start HH:MM, end HH:MM (at or before start = past midnight), lastSeating HH:MM | null }]. Empty = the single service_start to service_end window.';
comment on column public.booking_rules.closed_weekdays is
  '16 Oct 2026: ISO weekdays (1 Monday to 7 Sunday) with no service.';
comment on column public.booking_rules.date_blocks is
  '16 Oct 2026: [{ id, from, to, label, start?, end?, onlineOnly? }]. No times = the whole service day.';
comment on column public.booking_rules.min_notice_minutes is
  '16 Oct 2026: online bookings need this many minutes of notice. The host stand is never held to it.';

-- ── 2. helpers (internal) ──────────────────────────────────────────────────
-- 'HH:MM' (or 'H:MM') to minutes of the day; null when it is not a time of day. Nested CASE so
-- nothing is cast before the pattern matched (AND has no evaluation order in SQL).
create or replace function public._hm_min(p text)
returns integer
language sql
immutable
as $function$
  select case when p ~ '^\d{1,2}:\d{2}' then
    case when split_part(p, ':', 1)::int < 24 and substr(split_part(p, ':', 2), 1, 2)::int < 60
      then split_part(p, ':', 1)::int * 60 + substr(split_part(p, ':', 2), 1, 2)::int end
  end
$function$;

-- 'YYYY-MM-DD' to a date; null when it is not a real date (never an error mid booking).
create or replace function public._iso_date(p text)
returns date
language plpgsql
immutable
as $function$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p::date;
exception when others then
  return null;
end $function$;

-- An ISO weekday from a jsonb array element; null when it is not a whole number.
create or replace function public._iso_dow(p text)
returns integer
language sql
immutable
as $function$
  select case when p ~ '^\d{1,2}$' then p::int end
$function$;

-- ' (Christmas)' for a block's reason, or '' when none was typed. 'Closed' and 'Blocked' were
-- the editor's stand ins and read as no reason (never "closed for bookings (Closed)").
create or replace function public._block_reason_words(p text)
returns text
language sql
immutable
as $function$
  select coalesce(' (' || nullif(nullif(nullif(btrim(coalesce(p, '')), ''), 'Closed'), 'Blocked') || ')', '')
$function$;

-- The label of a whole day block on this service day, or null. p_online also sees the widget
-- only blocks and the older single blocked_dates (online only).
create or replace function public._booking_day_block(p_blocks jsonb, p_blocked_dates jsonb, p_day date, p_online boolean)
returns text
language plpgsql
immutable
as $function$
declare
  b jsonb;
  v_from date;
  v_to date;
begin
  for b in select value from jsonb_array_elements(case when jsonb_typeof(p_blocks) = 'array' then p_blocks else '[]'::jsonb end) loop
    v_from := public._iso_date(b->>'from');
    continue when v_from is null;
    -- a block with both times is a timed block, checked on its own
    continue when public._hm_min(b->>'start') is not null and public._hm_min(b->>'end') is not null
                  and public._hm_min(b->>'end') > public._hm_min(b->>'start');
    continue when coalesce(b->>'onlineOnly', 'false') = 'true' and not p_online;
    v_to := coalesce(public._iso_date(b->>'to'), v_from);
    if p_day between v_from and v_to then
      return coalesce(nullif(btrim(b->>'label'), ''), 'Closed');
    end if;
  end loop;
  if p_online and jsonb_typeof(p_blocked_dates) = 'array' and p_blocked_dates ? to_char(p_day, 'YYYY-MM-DD') then
    return 'Not taking online bookings';
  end if;
  return null;
end $function$;

-- Why a booking cannot start at p_time on p_date at this venue, or null when it can.
-- Returns { ok:false, error, message }. Mirrors bookingTimeRefusal in src/lib/bookings/optimiser.js
-- with legacyWindow false: a venue with no service periods has no window enforced here.
create or replace function public._booking_time_refusal(p_location_id uuid, p_date date, p_time time without time zone, p_source text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  r             record;
  p             jsonb;
  v_online      boolean := coalesce(p_source, '') in ('widget', 'online');
  v_t           int := extract(hour from p_time)::int * 60 + extract(minute from p_time)::int;
  v_dow         int := extract(isodow from p_date)::int;
  v_days        text[] := array['Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays','Sundays'];
  v_tz          text;
  v_now         timestamp;
  v_until       int;
  v_custom      boolean := false;
  v_day_block   text;
  v_closed      boolean;
  v_s int; v_e int; v_l int;
  v_own         int := 0;
  v_hit         boolean := false;
  v_parts       text[];
  v_open        text;
  v_bs int; v_be int;
begin
  if p_date is null or p_time is null or coalesce(p_source, '') = 'walk_in' then
    return null;
  end if;
  select br.service_periods, br.closed_weekdays, br.date_blocks, br.min_notice_minutes,
         br.widget_max_days_ahead, br.blocked_dates
    into r
    from booking_rules br where br.location_id = p_location_id;
  if not found then
    return null;
  end if;

  -- Online only: days ahead, past, notice, on the VENUE clock.
  if v_online then
    select l.timezone into v_tz from locations l where l.id = p_location_id;
    v_now := now() at time zone coalesce(nullif(v_tz, ''), 'Europe/London');
    if r.widget_max_days_ahead is not null and r.widget_max_days_ahead >= 0
       and p_date - v_now::date > r.widget_max_days_ahead then
      return jsonb_build_object('ok', false, 'error', 'too_far_ahead',
        'message', 'Online bookings open ' || r.widget_max_days_ahead || ' days ahead. Pick an earlier date.');
    end if;
    v_until := (p_date - v_now::date) * 1440 + v_t
               - (extract(hour from v_now)::int * 60 + extract(minute from v_now)::int);
    if v_until <= 0 then
      return jsonb_build_object('ok', false, 'error', 'past', 'message', 'That time has gone. Pick a later time.');
    end if;
    if v_until < coalesce(r.min_notice_minutes, 0) then
      return jsonb_build_object('ok', false, 'error', 'too_soon',
        'message', 'Online bookings need ' ||
          case when r.min_notice_minutes % 60 = 0
               then (r.min_notice_minutes / 60) || case when r.min_notice_minutes = 60 then ' hour' else ' hours' end
               else r.min_notice_minutes || ' minutes' end
          || ' notice. Pick a later time, or call the venue.');
    end if;
  end if;

  -- Timed blocks on this calendar day.
  for p in select value from jsonb_array_elements(case when jsonb_typeof(r.date_blocks) = 'array' then r.date_blocks else '[]'::jsonb end) loop
    continue when public._iso_date(p->>'from') is null;
    v_bs := public._hm_min(p->>'start');
    v_be := public._hm_min(p->>'end');
    continue when v_bs is null or v_be is null or v_be <= v_bs;
    continue when coalesce(p->>'onlineOnly', 'false') = 'true' and not v_online;
    continue when not (p_date between public._iso_date(p->>'from')
                       and coalesce(public._iso_date(p->>'to'), public._iso_date(p->>'from')));
    if v_t >= v_bs and v_t < v_be then
      return jsonb_build_object('ok', false, 'error', 'blocked',
        'message', substr(p->>'start', 1, 5) || ' to ' || substr(p->>'end', 1, 5) || ' on ' || to_char(p_date, 'Dy FMDD Mon')
          || ' is blocked' || public._block_reason_words(p->>'label') || '. Pick another time.');
    end if;
  end loop;

  v_day_block := public._booking_day_block(r.date_blocks, r.blocked_dates, p_date, v_online);
  v_closed := jsonb_typeof(r.closed_weekdays) = 'array' and exists (
    select 1 from jsonb_array_elements_text(r.closed_weekdays) x where public._iso_dow(x) = v_dow);

  -- A period counts when its times are times of day and it has at least one weekday.
  v_custom := jsonb_typeof(r.service_periods) = 'array' and exists (
    select 1 from jsonb_array_elements(r.service_periods) e
     where public._hm_min(e->>'start') is not null and public._hm_min(e->>'end') is not null
       and jsonb_typeof(e->'days') = 'array'
       and exists (select 1 from jsonb_array_elements_text(e->'days') d where public._iso_dow(d) between 1 and 7));

  if not v_custom then
    -- No service periods: the single window is not enforced here (as today). Closed days and
    -- whole day blocks, once set, still apply.
    if v_day_block is not null then
      return jsonb_build_object('ok', false, 'error', 'blocked',
        'message', to_char(p_date, 'Dy FMDD Mon') || ' is closed for bookings' || public._block_reason_words(v_day_block) || '. Pick another day.');
    end if;
    if v_closed then
      return jsonb_build_object('ok', false, 'error', 'closed_day',
        'message', 'The venue is closed on ' || v_days[v_dow] || '. Pick another day.');
    end if;
    return null;
  end if;

  for p in select value from jsonb_array_elements(r.service_periods) loop
    v_s := public._hm_min(p->>'start');
    v_e := public._hm_min(p->>'end');
    continue when v_s is null or v_e is null or jsonb_typeof(p->'days') <> 'array';
    if v_e <= v_s then v_e := v_e + 1440; end if;
    v_l := v_e - 1;
    if public._hm_min(p->>'lastSeating') is not null then
      v_l := public._hm_min(p->>'lastSeating');
      if v_l < v_s then v_l := v_l + 1440; end if;
      v_l := greatest(v_s, least(v_l, v_e - 1));
    end if;
    -- no new seating after midnight (a booking belongs to the day it starts on)
    v_l := least(v_l, 1439);
    if v_day_block is null and not v_closed
       and exists (select 1 from jsonb_array_elements_text(p->'days') d where public._iso_dow(d) = v_dow) then
      v_own := v_own + 1;
      if v_t >= v_s and v_t <= v_l then v_hit := true; end if;
    end if;
  end loop;

  if v_hit then
    return null;
  end if;
  if v_day_block is not null then
    return jsonb_build_object('ok', false, 'error', 'blocked',
      'message', to_char(p_date, 'Dy FMDD Mon') || ' is closed for bookings' || public._block_reason_words(v_day_block) || '. Pick another day.');
  end if;
  if v_own = 0 then
    return jsonb_build_object('ok', false, 'error', 'closed_day',
      'message', case when v_closed then 'The venue is closed on ' || v_days[v_dow] || '. Pick another day.'
                      else 'There is no service on ' || v_days[v_dow] || '. Pick another day.' end);
  end if;

  select array_agg(substr(e->>'start', 1, 5) || ' to ' || substr(e->>'end', 1, 5)
                   || case when public._hm_min(e->>'lastSeating') is not null
                           then ' (last seating ' || substr(e->>'lastSeating', 1, 5) || ')' else '' end
                   order by public._hm_min(e->>'start'))
    into v_parts
    from jsonb_array_elements(r.service_periods) e
   where public._hm_min(e->>'start') is not null and public._hm_min(e->>'end') is not null
     and jsonb_typeof(e->'days') = 'array'
     and exists (select 1 from jsonb_array_elements_text(e->'days') d where public._iso_dow(d) = v_dow);
  v_open := case
    when coalesce(array_length(v_parts, 1), 0) = 0 then ''
    when array_length(v_parts, 1) = 1 then v_parts[1]
    else array_to_string(v_parts[1:array_length(v_parts, 1) - 1], ', ') || ' and ' || v_parts[array_length(v_parts, 1)] end;
  return jsonb_build_object('ok', false, 'error', 'outside_service',
    'message', to_char(p_time, 'HH24:MI') || ' is outside service hours.'
      || case when v_open <> '' then ' Open ' || v_open || '.' else '' end || ' Pick another time.');
end $function$;

-- Internal only (Supabase grants new functions to anon and authenticated directly, so both
-- are revoked by name as well as public).
revoke all on function public._hm_min(text) from public, anon, authenticated;
revoke all on function public._iso_date(text) from public, anon, authenticated;
revoke all on function public._iso_dow(text) from public, anon, authenticated;
revoke all on function public._block_reason_words(text) from public, anon, authenticated;
revoke all on function public._booking_day_block(jsonb, jsonb, date, boolean) from public, anon, authenticated;
revoke all on function public._booking_time_refusal(uuid, date, time without time zone, text) from public, anon, authenticated;

comment on function public._booking_time_refusal(uuid, date, time without time zone, text) is
  '16 Oct 2026 (bookings audit section 3 item 6): why a booking cannot start then (service periods, closed days, date blocks, online notice and days ahead), or null. Internal: called by create_booking and edit_booking.';

-- ── 3. create_booking: 20261016b's body plus the service period check ─────
create or replace function public.create_booking(
  p_id text, p_location_id uuid, p_booking_date date, p_start_time time without time zone,
  p_turn_minutes integer, p_covers integer, p_table_ids text[], p_primary_table_id text,
  p_customer_id uuid default null::uuid, p_customer jsonb default null::jsonb,
  p_status text default 'confirmed'::text, p_source text default 'host'::text,
  p_package_id text default null::text, p_note text default ''::text,
  p_created_by text default null::text, p_pacing_override_by text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_conflict record;
  v_org uuid;
  v_off text;
  v_refusal jsonb;
  v_start_min int := extract(hour from p_start_time)::int * 60 + extract(minute from p_start_time)::int;
  v_end_min int := v_start_min + p_turn_minutes;
begin
  if p_table_ids is null or array_length(p_table_ids, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no tables supplied');
  end if;
  if not (p_primary_table_id = any(p_table_ids)) then
    return jsonb_build_object('ok', false, 'error', 'primary table must be a member');
  end if;

  -- 16 Oct 2026 (bookings audit item 21): every table must be on this venue's floor plan.
  select x into v_off from unnest(p_table_ids) as x
   where not exists (select 1 from floor_tables f where f.id = x and f.location_id = p_location_id::text)
   limit 1;
  if v_off is not null then
    return jsonb_build_object('ok', false, 'error', 'unknown_table', 'table_id', v_off);
  end if;

  -- 16 Oct 2026 (bookings audit section 3 item 6): service periods, closed days, date blocks,
  -- and for online bookings the notice and days ahead. Walk ins are never refused.
  if coalesce(p_status, 'confirmed') <> 'dining' then
    v_refusal := public._booking_time_refusal(p_location_id, p_booking_date, p_start_time, coalesce(p_source, 'host'));
    if v_refusal is not null then
      return v_refusal;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('bookings:' || p_location_id::text));

  select b.id, b.customer->>'name' as name, bt.table_id into v_conflict
  from bookings b
  join booking_tables bt on bt.booking_id = b.id
  where b.location_id = p_location_id
    and b.booking_date = p_booking_date
    and b.status not in ('departed','cancelled','no_show','expired')
    and bt.table_id = any(p_table_ids)
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) < v_end_min
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) + b.turn_minutes > v_start_min
  limit 1;

  if found then
    return jsonb_build_object('ok', false, 'error', 'table_taken',
      'table_id', v_conflict.table_id, 'booking_id', v_conflict.id);
  end if;

  select org_id into v_org from locations where id = p_location_id;

  insert into bookings (id, location_id, org_id, customer_id, customer, booking_date, start_time,
    turn_minutes, covers, primary_table_id, status, source, package_id, note, created_by, pacing_override_by)
  values (p_id, p_location_id, v_org, p_customer_id, p_customer, p_booking_date, p_start_time,
    p_turn_minutes, p_covers, p_primary_table_id, coalesce(p_status,'confirmed'),
    coalesce(p_source,'host'), p_package_id, coalesce(p_note,''), p_created_by, p_pacing_override_by);

  insert into booking_tables (location_id, booking_id, table_id, is_primary)
  select p_location_id, p_id, t, (t = p_primary_table_id) from unnest(p_table_ids) as t;

  return jsonb_build_object('ok', true, 'id', p_id);
end $function$;

revoke all on function public.create_booking(text, uuid, date, time without time zone, integer, integer, text[], text, uuid, jsonb, text, text, text, text, text, text) from public;
grant execute on function public.create_booking(text, uuid, date, time without time zone, integer, integer, text[], text, uuid, jsonb, text, text, text, text, text, text)
  to anon, authenticated, service_role;

-- ── 4. edit_booking: one check patched in, whatever fence is installed ─────
-- NOT replaced wholesale: 20261016c patches the fence of the installed edit_booking so the
-- booking-widget function (service role) can move a guest's booking, and a full body here would
-- silently undo that. This reads the installed body, adds one variable and one check block at
-- two fixed anchors from 20261016b, and leaves every other line (the fence included) as it is.
-- Safe to run twice: a body that already has the check is left alone.
-- The check runs only when the date or the time moves, so a note, guest, covers or table fix on
-- a booking made before the periods were set always saves. A guest's own move (the
-- booking-widget function, which has no auth.uid() and only passes the fence through 20261016c)
-- is held to the online rules (notice, past, online only blocks); everyone else to the host
-- stand's rules.
do $patch$
declare
  v_def text;
  v_new text;
  v_decl_anchor  constant text := E'  v_window    boolean;\n';
  v_check_anchor constant text := E'  -- 16 Oct 2026: what this edit changes.';
  v_check text := $chk$  -- 16 Oct 2026 (bookings audit section 3 item 6): a new date or time must be inside a service
  -- period and not on a closed day or a block. A caller with no auth.uid() got past the fence
  -- only as the booking-widget function (a guest's own change), held to the online rules.
  if (v_bk.booking_date is distinct from p_booking_date or v_bk.start_time is distinct from p_start_time)
     and coalesce(v_bk.source, 'host') <> 'walk_in' then
    v_refusal := public._booking_time_refusal(p_location_id, p_booking_date, p_start_time,
      case when auth.uid() is null then 'widget' else 'host' end);
    if v_refusal is not null then
      return v_refusal;
    end if;
  end if;

$chk$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking'
     and pg_get_function_identity_arguments(p.oid) = 'p_id text, p_location_id uuid, p_booking_date date, p_start_time time without time zone, p_turn_minutes integer, p_covers integer, p_table_ids text[], p_primary_table_id text, p_note text, p_customer jsonb';
  if v_def is null then
    raise exception 'edit_booking (the 20261016b version) is not on this database. Nothing was changed. Send this message to Claude.';
  end if;
  if position('_booking_time_refusal' in v_def) > 0 then
    raise notice 'edit_booking already has the service period check, left as it is';
    return;
  end if;
  if position(v_decl_anchor in v_def) = 0 or position(v_check_anchor in v_def) = 0 then
    raise exception 'edit_booking is not the version 20261016b/c installed (its lines differ). Nothing was changed. Send this message to Claude.';
  end if;
  v_new := replace(v_def, v_decl_anchor, v_decl_anchor || E'  v_refusal   jsonb;\n');
  v_new := replace(v_new, v_check_anchor, v_check || v_check_anchor);
  execute v_new;
end
$patch$;

revoke all on function public.edit_booking(text, uuid, date, time without time zone, integer, integer, text[], text, text, jsonb) from public;
grant execute on function public.edit_booking(text, uuid, date, time without time zone, integer, integer, text[], text, text, jsonb)
  to anon, authenticated, service_role;

comment on function public.edit_booking(text, uuid, date, time without time zone, integer, integer, text[], text, text, jsonb) is
  '16 Oct 2026 (bookings audit items 10 and section 3 item 6): edit a booking''s date, time, turn, covers, note, guest and tables in one transaction under the venue lock, with the same free check as create_booking and move_booking, the floor plan check, the seats check, and the service period check when the date or time moves.';

commit;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   rules_new_columns 4, helpers 6, helper_not_public 1, create_has_rules 1, create_has_floor_check 1,
--   edit_has_rules 1, edit_has_fence 1, edit_keeps_guest_fence 1 (0 means 20261016c has not run
--   yet: run it next, it still works after this file), create_anon_grant 1, edit_auth_grant 1,
--   venues_with_periods = venues that set service periods (0 until someone does),
--   sample_christmas_block Christmas, sample_bad_date_is_null true, sample_hm_810 810,
--   sample_no_reason_words empty, sample_reason_words ' (Christmas)'
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_rules'
      and column_name in ('service_periods', 'closed_weekdays', 'date_blocks', 'min_notice_minutes')) as rules_new_columns,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_hm_min', '_iso_date', '_iso_dow', '_block_reason_words', '_booking_day_block', '_booking_time_refusal')) as helpers,
  (select case when has_function_privilege('anon', 'public._booking_time_refusal(uuid, date, time without time zone, text)', 'execute') then 0 else 1 end) as helper_not_public,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking'
     and pg_get_functiondef(p.oid) like '%_booking_time_refusal%') as create_has_rules,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking'
     and pg_get_functiondef(p.oid) like '%unknown_table%') as create_has_floor_check,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking'
     and pg_get_functiondef(p.oid) like '%_booking_time_refusal%') as edit_has_rules,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking'
     and pg_get_functiondef(p.oid) like '%no access%') as edit_has_fence,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking'
     and pg_get_functiondef(p.oid) like '%service_role%') as edit_keeps_guest_fence,
  (select case when has_function_privilege('anon', 'public.create_booking(text, uuid, date, time without time zone, integer, integer, text[], text, uuid, jsonb, text, text, text, text, text, text)', 'execute') then 1 else 0 end) as create_anon_grant,
  (select case when has_function_privilege('authenticated', 'public.edit_booking(text, uuid, date, time without time zone, integer, integer, text[], text, text, jsonb)', 'execute') then 1 else 0 end) as edit_auth_grant,
  (select count(*) from booking_rules where jsonb_array_length(service_periods) > 0) as venues_with_periods,
  (select public._booking_day_block('[{"from":"2026-12-25","to":"2026-12-26","label":"Christmas"}]'::jsonb, '[]'::jsonb, date '2026-12-26', false)) as sample_christmas_block,
  (select public._iso_date('2026-13-45') is null) as sample_bad_date_is_null,
  (select public._hm_min('13:30')) as sample_hm_810,
  (select public._block_reason_words('Closed')) as sample_no_reason_words,
  (select public._block_reason_words('Christmas')) as sample_reason_words;
