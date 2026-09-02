-- Kitchen load for the online storefront, counted server-side.
--
-- WHY THIS EXISTS
-- The storefront quotes a wait that scales with how busy the kitchen is. It has
-- to count three things: open floor-plan tables, open bar tabs, and the order
-- queue. It reads them on an ANONYMOUS session, because that is what a customer
-- browsing a menu is.
--
-- bar_tabs is tenant-fenced by pos_can_access(), which an anonymous session
-- never satisfies. RLS does not raise an error in that case. It filters every
-- row and returns a count of ZERO, which is indistinguishable from a bar with
-- no tabs open. So a pub with fifteen tabs on read as completely quiet, the
-- busy rule never fired, and customers were quoted the flat lead time during
-- the exact rush the rule exists to handle.
--
-- SECURITY DEFINER lets the count see past RLS. It returns TWO INTEGERS and
-- nothing else: no order contents, no customer data, no tab names. Knowing that
-- a venue is busy is the same thing the storefront already tells the customer.
--
-- live_orders   what the Orders Hub shows (accepted, not finished)
-- kitchen_load  the same minus anything already 'ready' on the pass
--
-- Pre-orders are held out by sent_at, the kitchen fire moment, NOT by status:
-- online pre-orders are written as 'prep' the moment they are paid for, so a
-- status test would count a Saturday order book against a Monday quote.

-- NOTE ON TYPES: location_id is uuid on active_sessions but text on
-- floor_tables, bar_tabs and order_queue. The parameter is therefore text and
-- every comparison casts to text, so no branch can fail on "operator does not
-- exist: text = uuid". The first draft of this function did exactly that.
create or replace function public.online_kitchen_load(p_location_id text)
returns table (live_orders integer, kitchen_load integer)
language sql
stable
security definer
set search_path = public
as $$
  with tbl as (
    -- Only sessions whose table is still on the floor plan. Orphan sessions
    -- left behind by table splits are not tables anybody can serve.
    select count(*)::int as n
    from active_sessions a
    join floor_tables f on f.id::text = a.table_id::text
                       and f.location_id = a.location_id::text
    where a.location_id::text = p_location_id
  ),
  tab as (
    select count(*)::int as n
    from bar_tabs
    where location_id = p_location_id
      and status is distinct from 'closed'
  ),
  q as (
    select
      count(*)::int as n_live,
      count(*) filter (where status is distinct from 'ready')::int as n_load
    from order_queue
    where location_id = p_location_id
      and status not in ('collected', 'paid', 'cancelled')
      and (sent_at is null or sent_at <= now())
  )
  select (tbl.n + tab.n + q.n_live)::int,
         (tbl.n + tab.n + q.n_load)::int
  from tbl, tab, q;
$$;

comment on function public.online_kitchen_load(text) is
  'Busy-prep counts for the online storefront. Returns only two integers so an anonymous customer session can read kitchen depth without reading any order or customer data.';

revoke all on function public.online_kitchen_load(text) from public;
grant execute on function public.online_kitchen_load(text) to anon, authenticated;
