-- 20260918d_OPS_ezcater_server_owned_rows.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
-- Claude cannot apply production DDL by any route.
--
-- ezCater review round 5 (18 Sep 2026). Two things, both about order_queue rows whose source is
-- 'catering' or 'ezcater'. Those rows are SERVER OWNED: the catering checkout, the ezCater
-- webhook and the release write them; a till may drop one from its own memory (a held order is
-- kept out of the live queue) but must never delete it in the database.
--
--   1. A till can no longer delete one. The new app code never tries (QueueSync, removeFromQueue
--      and the offline replay all skip them), but a Sunmi or iPad still running older code will,
--      and the old code deleted an ezCater order the moment ezCater moved it later: the order
--      vanished before the kitchen ever had it. A BEFORE DELETE trigger skips the delete of such a
--      row when the caller is a till (the anon or authenticated role). The service role and the
--      SQL editor can still delete. Skipping (return null) is silent on purpose: an old till
--      treats the delete as done and carries on; the row stays.
--
--   2. ezcater_order_links remembers what the kitchen had. The link survives a delete of the
--      order_queue row, so a later ezCater notification can tell "the kitchen had it" from "a new
--      order" and never inserts a fired order again as a fresh unfired one (it would fire twice).
--      Three columns, kept by a trigger on order_queue for ezCater rows:
--        kitchen_fired_at  the first kitchen_routed_at the row ever had (never cleared)
--        queue_status      the row's last status
--        queue_gone_at     when the row was deleted (cleared when it is written again)
--      Read by supabase/functions/_shared/ezcaterIngest.ts writeEzcaterOrder through
--      goneOrderPlan (_shared/ezcaterCatering.js). Until this file runs the link has none of these
--      columns and a gone order is written back for staff to check, marked as already sent, never
--      printed again automatically.
--
-- The trigger never waits on another ORDER write (INVARIANTS.md): it touches only the one
-- ezcater_order_links row of the same order, and only for ezCater rows when kitchen_routed_at or
-- status changed, or on delete.
--
-- Safe to run twice. Rollback:
--   drop trigger if exists order_queue_server_owned_delete on public.order_queue;
--   drop trigger if exists order_queue_ezcater_link_track on public.order_queue;
--   drop function if exists public.order_queue_server_owned_delete();
--   drop function if exists public.order_queue_ezcater_link_track();
--   (the three link columns are harmless to leave)

do $guard$ begin
  if to_regclass('public.order_queue') is null or to_regclass('public.ezcater_order_links') is null then
    raise exception 'Wrong database. Run this on the Ops project, after 20260825e_ezcater.sql.';
  end if;
end $guard$;

alter table public.ezcater_order_links add column if not exists kitchen_fired_at timestamptz;
alter table public.ezcater_order_links add column if not exists queue_status text;
alter table public.ezcater_order_links add column if not exists queue_gone_at timestamptz;

-- Orders already fired or finished before this file ran: record it now, while their rows exist.
update public.ezcater_order_links l
   set kitchen_fired_at = coalesce(l.kitchen_fired_at, q.kitchen_routed_at),
       queue_status = q.status
  from public.order_queue q
 where q.source = 'ezcater' and q.location_id::text = l.location_id and q.ref = l.ref;

-- 1. Tills never delete a server owned row.
create or replace function public.order_queue_server_owned_delete()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
begin
  if old.source in ('catering', 'ezcater') and v_role in ('anon', 'authenticated') then
    return null;   -- a till: the row stays (server owned)
  end if;
  return old;
end
$fn$;

drop trigger if exists order_queue_server_owned_delete on public.order_queue;
create trigger order_queue_server_owned_delete
  before delete on public.order_queue
  for each row execute function public.order_queue_server_owned_delete();

-- 2. The link remembers what the kitchen had.
create or replace function public.order_queue_ezcater_link_track()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    if old.source = 'ezcater' then
      update public.ezcater_order_links
         set kitchen_fired_at = coalesce(kitchen_fired_at, old.kitchen_routed_at),
             queue_status = old.status,
             queue_gone_at = now()
       where location_id = old.location_id::text and ref = old.ref;
    end if;
    return old;
  end if;
  if new.source = 'ezcater' and (
       tg_op = 'INSERT'
       or new.kitchen_routed_at is distinct from old.kitchen_routed_at
       or new.status is distinct from old.status) then
    update public.ezcater_order_links
       set kitchen_fired_at = coalesce(kitchen_fired_at, new.kitchen_routed_at),
           queue_status = new.status,
           queue_gone_at = null
     where location_id = new.location_id::text and ref = new.ref;
  end if;
  return new;
end
$fn$;

revoke all on function public.order_queue_ezcater_link_track() from public, anon, authenticated;

drop trigger if exists order_queue_ezcater_link_track on public.order_queue;
create trigger order_queue_ezcater_link_track
  after insert or update or delete on public.order_queue
  for each row execute function public.order_queue_ezcater_link_track();
