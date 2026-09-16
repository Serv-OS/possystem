-- 20260917_OPS_drive_thru_order_screens.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
-- Claude cannot apply production DDL by any route. Until this file runs, a till drive thru
-- order gets no order type key in order_status_feed and is absent from every order status TV.
--
-- Drive thru: the new order type (Peter, 16 Sep 2026). A till whose device profile enables it
-- writes order_queue.type = 'drive-thru'. Venues that never enable it write nothing new.
--
-- What changes: two helper functions are replaced with the same bodies as
-- 20260911_OPS_order_status_displays.sql plus the drive thru mapping. Nothing else moves.
--   1. _osd_type_key   'drivethru' and 'drivethrough' give 'drive-thru'. The function keeps
--                      letters only, so 'drive-thru', 'Drive Thru', 'drive_thru', 'driveThru'
--                      and 'drive-through' all arrive as one of those two. Every existing
--                      mapping is unchanged.
--   2. _osd_name       the placeholder list gains drive thru and drive through, so a till that
--                      types "Drive thru" as the customer name shows the order number instead.
--
-- Mirrors src/lib/orderScreen/orderScreenStatus.js (orderTypeKey and NAME_PLACEHOLDER_PATTERN).
-- Change both together. src/lib/orderScreen/orderScreenSql.test.js pins this file to the JS
-- and to the shipped 20260911 bodies.
--
-- Venues that never enable drive thru see no change: no existing type maps differently and no
-- existing name is judged differently unless it is literally "drive thru" or "drive through".
-- No table, policy, trigger or permission changes. Idempotent: create or replace only, so it is
-- safe to run twice. Run it after 20260911_OPS_order_status_displays.sql.
--
-- Also refreshes two column comments that list the order types (documentation only):
-- recipe_lines.order_types and print_routing.routing.
--
-- Rollback: re-run 20260911_OPS_order_status_displays.sql, which holds the earlier definitions
-- of both functions (that file recreates every order screen object, so run it whole).

-- Fail fast if anything holds a lock, instead of making order writes queue behind this script.
set lock_timeout = '3s';

do $guard$ begin
  if to_regclass('public.order_queue') is null or to_regclass('public.order_status_displays') is null then
    raise exception 'Wrong database. Run this on the Ops project, after 20260911_OPS_order_status_displays.sql.';
  end if;
end $guard$;

-- 1. Order type key: the shipped body plus drive thru --------------------------------------------

create or replace function public._osd_type_key(p_type text) returns text
language sql immutable as $$
  select case regexp_replace(lower(coalesce(p_type, '')), '[^a-z]', '', 'g')
    when 'dinein' then 'dine-in'
    when 'eatin' then 'dine-in'
    when 'takeaway' then 'takeaway'
    when 'takeout' then 'takeaway'
    when 'collection' then 'collection'
    when 'pickup' then 'collection'
    when 'delivery' then 'delivery'
    when 'drivethru' then 'drive-thru'
    when 'drivethrough' then 'drive-thru'
    else null
  end;
$$;

-- 2. Name shortening: the shipped body, with drive thru in the placeholder list -----------------

create or replace function public._osd_name(p_name text, p_format text) returns text
language plpgsql immutable as $$
declare
  n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  parts text[];
  first_part text;
  last_initial text;
begin
  if coalesce(p_format, 'short') = 'number' or n = '' then return null; end if;
  -- An @ or any digit (a phone number, an email address, a flat or table number) never shows.
  if n ~ '@|\d' then return null; end if;
  if n ~* '^(order\s*#?\s*\d+|hubrise customer|ezcater customer|guest|customer|walk\s*-?\s*in|counter|dine\s*-?\s*in|eat\s*-?\s*in|take\s*-?\s*away|collection|delivery|drive\s*-?\s*thru|drive\s*-?\s*through|table\s*\S+)$'
     or n ~ '^[0-9#\s]+$' then
    return null;
  end if;
  -- Letters, spaces, apostrophes and hyphens only, so a web address cannot render.
  n := btrim(regexp_replace(regexp_replace(n, '[^[:alpha:][:space:]''’-]', '', 'g'), '\s+', ' ', 'g'));
  if n !~ '[[:alpha:]]' then return null; end if;
  if n ~* '^(order\s*#?\s*\d+|hubrise customer|ezcater customer|guest|customer|walk\s*-?\s*in|counter|dine\s*-?\s*in|eat\s*-?\s*in|take\s*-?\s*away|collection|delivery|drive\s*-?\s*thru|drive\s*-?\s*through|table\s*\S+)$' then
    return null;
  end if;
  if p_format = 'full' then return left(n, 24); end if;
  parts := string_to_array(n, ' ');
  first_part := left(parts[1], 16);
  if array_length(parts, 1) = 1 then return first_part; end if;
  last_initial := upper(left(regexp_replace(parts[array_length(parts, 1)], '[^[:alpha:]]', '', 'g'), 1));
  if coalesce(last_initial, '') = '' then return first_part; end if;
  return first_part || ' ' || last_initial;
end $$;

-- 3. Privileges: create or replace keeps them on an existing function, but default privileges
--    hand EXECUTE to anon on a fresh one, so name anon every time (as 20260911 does).
revoke all on function public._osd_type_key(text) from public, anon;
revoke all on function public._osd_name(text, text) from public, anon;

-- 4. Documentation only: the column comments that enumerate the order types.
do $comments$ begin
  if to_regclass('public.recipe_lines') is not null then
    comment on column public.recipe_lines.order_types is
      'Order types this line applies to (jsonb array of dine-in|takeaway|collection|delivery|drive-thru). NULL/[] = all order types (shared base recipe). A line tagged takeaway also applies to a drive-thru sale when no line on the recipe names drive-thru.';
  end if;
  if to_regclass('public.print_routing') is not null then
    comment on column public.print_routing.routing is
      'Per centre routing keyed by centre id: { assignedCategories: text[], excludedItems: text[], orderTypes: text[] }. orderTypes absent or empty means all order types (dine-in, takeaway, collection, delivery, drive-thru).';
  end if;
end $comments$;
