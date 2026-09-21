-- 20260921t_OPS_order_track_collected.sql
--
-- THE CUSTOMER'S PAGE NEVER SAYS "COLLECTED".
--
-- Peter, live, 21 Sep 2026: order OL-909CZ was marked collected in Orders Hub
-- and the customer's tracking page stayed on "Ready".
--
-- WHY. Marking an order collected REMOVES it from order_queue. The tracker
-- reads order_track_row, which reads order_queue, so from that moment there is
-- nothing to read and the page keeps showing the last thing it saw. Worse,
-- _order_track_ok nests the TOKEN check inside `if v_q.ref is not null`, so
-- once the row is gone even a customer holding the right tracking token is
-- refused, and the answer is a flat null.
--
-- What the system does keep is order_status_marks, the row the order screens
-- use for exactly this reason: it records what the order departed FROM and
-- when. For OL-909CZ:
--   status ready, ready_at 18:43:33, departed_at 18:43:38, departed_from ready
--
-- THE RULE, AND WHY IT IS NOT A GUESS. A queue row can vanish for more than one
-- reason, and telling a customer "collected" when their order was cancelled is
-- worse than telling them nothing. So only an order that departed FROM 'ready'
-- or 'collected' is reported collected. Anything else keeps today's behaviour:
-- null, and the page holds its last known state. Same rule the TV uses, one
-- source of truth for both screens.
--
-- SAFE DURING SERVICE. Two function bodies, no table touched, no policy
-- changed, and every existing path answers exactly as it does today.

set local lock_timeout = '3s';

do $guard$
begin
  if to_regprocedure('public._order_track_ok(text, text, text)') is null
     or to_regprocedure('public.order_track_row(text, text, text)') is null then
    raise exception 'The public order fence (20260919a2) has not run on this database. Nothing was changed.';
  end if;
  if to_regclass('public.order_status_marks') is null then
    raise exception 'order_status_marks is missing (20260911 order screens). Nothing was changed.';
  end if;
end
$guard$;


-- ── The token is proof on its own, even after the order leaves the queue ────
create or replace function public._order_track_ok(p_location_id text, p_ref text, p_key text)
returns boolean
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_q      public.order_queue%rowtype;
  v_digits text := regexp_replace(coalesce(p_key, ''), '\D', '', 'g');
  v_bucket text := 'track:' || coalesce(p_location_id, '') || ':' || coalesce(p_ref, '');
begin
  if coalesce(p_location_id, '') = '' or coalesce(p_ref, '') = '' or coalesce(p_key, '') = '' then
    return false;
  end if;
  -- THE TOKEN FIRST, AND WITHOUT THE QUEUE ROW (21 Sep 2026). public_order_tokens
  -- outlives the order: it is minted at checkout and nothing deletes it when the
  -- till clears the board. It is the one key that proves "I am the person who
  -- placed this", so it must keep working after collection, or the customer is
  -- locked out of their own order the moment it is handed over.
  if exists (select 1 from public.public_order_tokens t
              where t.location_id = p_location_id and t.ref = p_ref and t.token = p_key) then
    return true;
  end if;
  select * into v_q from public.order_queue q where q.location_id = p_location_id and q.ref = p_ref;
  if v_q.ref is not null then
    -- The payment reference is on the order row, so this path still needs it.
    if length(p_key) >= 12
       and (coalesce(v_q.customer ->> 'payment_intent_id', '') = p_key
            or coalesce(v_q.customer ->> 'payment_ref', '') = p_key) then
      return true;
    end if;
  end if;
  if length(v_digits) = 4 and length(p_key) <= 8 then
    if public._fence_is_locked(v_bucket) or public._fence_is_locked('track:last4:global') then
      return false;
    end if;
    if v_q.ref is not null
       and right(regexp_replace(coalesce(v_q.customer ->> 'phone', ''), '\D', '', 'g'), 4) = v_digits then
      return true;
    end if;
    perform public._fence_count('track:last4:global', 20000, interval '10 minutes', interval '5 minutes');
  end if;
  perform public._fence_count(v_bucket, 10, interval '1 hour', interval '1 hour');
  return false;
end;
$function$;


-- ── An order that left the queue can still answer for itself ───────────────
create or replace function public.order_track_row(p_location_id text, p_ref text, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_row  jsonb;
  v_mark public.order_status_marks%rowtype;
begin
  if not public._order_track_ok(p_location_id, p_ref, p_key) then
    return null;
  end if;
  select jsonb_build_object(
           'ref', q.ref, 'status', q.status, 'total', q.total, 'items', q.items,
           'collection_time', q.collection_time, 'is_asap', q.is_asap, 'type', q.type,
           'source', q.source, 'sent_at', q.sent_at, 'updated_at', q.updated_at, 'paid', q.paid,
           'payment_state', case when q.customer ->> 'payment_state' = 'short' then 'checking'
                                 else q.customer ->> 'payment_state' end,
           'customer', jsonb_strip_nulls(jsonb_build_object(
               'delivery_mode', q.customer ->> 'delivery_mode',
               'collection_at', q.customer ->> 'collection_at',
               'tip', q.customer -> 'tip',
               'tableLabel', q.customer ->> 'tableLabel',
               'phone', nullif(right(regexp_replace(coalesce(q.customer ->> 'phone', ''), '\D', '', 'g'), 4), ''))))
    into v_row
    from public.order_queue q
   where q.location_id = p_location_id and q.ref = p_ref;
  if v_row is not null then
    return v_row;
  end if;

  -- The till has taken it off the board. order_status_marks remembers what it
  -- departed FROM, which is the only honest way to tell a collection from a
  -- cancellation, and anything other than ready/collected stays null rather
  -- than telling a customer their cancelled order was handed over.
  select * into v_mark from public.order_status_marks m
   where m.location_id = p_location_id and m.ref = p_ref;
  if v_mark.ref is null or v_mark.departed_at is null then
    return null;
  end if;
  if coalesce(v_mark.departed_from, '') not in ('ready', 'collected') then
    return null;
  end if;
  -- Deliberately thin: the items and the total went with the queue row, and the
  -- page already has them. It merges this over what it is showing.
  return jsonb_build_object(
    'ref', v_mark.ref,
    'status', 'collected',
    'type', v_mark.type,
    'source', v_mark.source,
    'updated_at', v_mark.departed_at,
    'departed', true);
end;
$function$;

revoke all on function public._order_track_ok(text, text, text) from public, anon, authenticated;
grant execute on function public._order_track_ok(text, text, text) to service_role;
revoke all on function public.order_track_row(text, text, text) from public;
grant execute on function public.order_track_row(text, text, text) to anon, authenticated, service_role;


-- ── Self test ───────────────────────────────────────────────────────────────
do $check$
declare
  v_mark public.order_status_marks%rowtype;
  v_tok  text;
  v_out  jsonb;
begin
  -- the private helper stays private, the public one stays public
  if has_function_privilege('anon', 'public._order_track_ok(text, text, text)', 'execute') then
    raise exception 'Self test: the token check is reachable with the public key. Nothing was changed.';
  end if;
  if not has_function_privilege('anon', 'public.order_track_row(text, text, text)', 'execute') then
    raise exception 'Self test: the tracker can no longer read its own row. Nothing was changed.';
  end if;

  -- a collected order with a token now answers "collected"
  select m.* into v_mark
    from public.order_status_marks m
    join public.public_order_tokens t on t.location_id = m.location_id and t.ref = m.ref
   where m.departed_at is not null and coalesce(m.departed_from, '') in ('ready', 'collected')
     and not exists (select 1 from public.order_queue q
                      where q.location_id = m.location_id and q.ref = m.ref)
   limit 1;
  if v_mark.ref is not null then
    select t.token into v_tok from public.public_order_tokens t
     where t.location_id = v_mark.location_id and t.ref = v_mark.ref limit 1;
    v_out := public.order_track_row(v_mark.location_id, v_mark.ref, v_tok);
    if coalesce(v_out ->> 'status', '') <> 'collected' then
      raise exception 'Self test: a collected order still does not say collected. Nothing was changed.';
    end if;
  end if;

  -- and a wrong key is still refused
  if public.order_track_row('7218c716-eeb4-4f96-b284-f3500823595c', 'OL-909CZ', 'not-the-token') is not null then
    raise exception 'Self test: the wrong key was accepted. Nothing was changed.';
  end if;
end
$check$;


-- ── Check it worked: the order Peter reported ───────────────────────────────
-- Expect status = collected, departed = true.
select public.order_track_row(
         m.location_id, m.ref,
         (select t.token from public.public_order_tokens t
           where t.location_id = m.location_id and t.ref = m.ref limit 1)) as tracker_now
from public.order_status_marks m
where m.ref = 'OL-909CZ';


-- ============================================================================
-- ROLL BACK: restore the two bodies as they were (the token check nested inside
-- the queue-row branch, and no mark fallback). Nothing else needs undoing.
-- ============================================================================
