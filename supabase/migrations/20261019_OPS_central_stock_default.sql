-- 20261019_OPS_central_stock_default.sql
--
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Peter runs this by hand in the SQL editor.
-- Needs 20261018a and 20261018c first (both run 19 Oct 2026).
--
-- WHY (Peter, 19 Oct 2026): "turn central stock on now for everyone, this is the standard ...
-- any new venues get this, I don't want to have to turn this on each time, this needs to be the
-- default."
--
-- WHAT IT DOES
--   1. Every venue that has no central stock row yet is switched to central now, through
--      stock_central_switch (the tested path: it sets central_since and books the last 2 hours
--      of sales of a venue that has recipes, once).
--   2. A new trigger on locations switches every NEW venue to central the moment it is created,
--      through the same function. If the switch ever fails, the venue is still created (a
--      warning only): creating a venue must never fail because of stock.
--   stock_depletion_default stays 'browser' on purpose: 20261018c's own self test expects it, and
--   every venue now has its own row, so the default is never read.
--   stock_central_switch(venue, 'browser' | 'paused', who) stays as the back out tool.
--
-- Safe to run twice. Bare statements, no begin or commit: the SQL editor runs the paste as one
-- transaction, so any error means nothing changed.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.stock_central_switch(uuid,text,text)') is null or to_regclass('public.stock_depletion_mode') is null then
    raise exception 'Run 20261018c_OPS_central_stock_depletion.sql first. Nothing was changed.';
  end if;
end
$guard$;

-- 1. Every existing venue without a row: central now.
select public.stock_central_switch(l.id, 'central', 'default 20261019')
  from public.locations l
 where not exists (select 1 from public.stock_depletion_mode m where m.location_id = l.id);

-- 2. Every new venue: central from the moment it is created.
create or replace function public._stock_central_on_new_venue() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from stock_depletion_mode m where m.location_id = new.id) then
    perform stock_central_switch(new.id, 'central', 'new venue');
  end if;
  return new;
exception when others then
  raise warning 'central stock was not switched on for new venue % (%). The venue was created; run stock_central_switch for it.', new.id, sqlerrm;
  return new;
end $$;

revoke all on function public._stock_central_on_new_venue() from public, anon, authenticated, service_role;

drop trigger if exists locations_central_stock_on_create on public.locations;
create trigger locations_central_stock_on_create
  after insert on public.locations
  for each row execute function public._stock_central_on_new_venue();

comment on function public._stock_central_on_new_venue() is
  'Every new venue uses central stock depletion from the moment it is created (Peter, 19 Oct 2026). Never blocks the insert. 20261019.';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   venues = every venue, venues_central = the same number, venues_not_central 0,
--   new_venue_trigger 1, trigger_open_to_api 0, default_mode browser (kept on purpose).
select
  (select count(*) from public.locations) as venues,
  (select count(*) from public.locations l join public.stock_depletion_mode m on m.location_id = l.id where m.mode = 'central') as venues_central,
  (select count(*) from public.locations l where not exists (select 1 from public.stock_depletion_mode m where m.location_id = l.id and m.mode = 'central')) as venues_not_central,
  (select count(*) from pg_trigger t where t.tgrelid = 'public.locations'::regclass and t.tgname = 'locations_central_stock_on_create' and not t.tgisinternal) as new_venue_trigger,
  (select count(*) from unnest(array['anon', 'authenticated', 'service_role']) r(name)
    where has_function_privilege(r.name, 'public._stock_central_on_new_venue()'::regprocedure, 'execute')) as trigger_open_to_api,
  (select mode from public.stock_depletion_default) as default_mode;
