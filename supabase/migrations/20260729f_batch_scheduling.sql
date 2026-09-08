-- 20260729f_batch_scheduling.sql — OPS DB
--
-- UNIFY THE TWO BATCH SYSTEMS. The Manager app's "batch cooks" run on prep_schedule —
-- free-text rows that never touch stock — while the real production engine
-- (recipes → production_batches → ledger) sits beside it, unscheduled. The owner's ask
-- ("we make these on this day, this many, and the system knows what top-up we need from
-- sales") needs them to be ONE system:
--
-- 1. prep_schedule learns which MADE ITEM (and recipe) a scheduled cook produces.
--    A linked cook, when recorded, produces a real batch: ingredients consumed,
--    output stocked, costs rolled. Unlinked rows keep working exactly as before.
-- 2. pos_can_access() now also accepts a claimed, active OPS DEVICE (the manager
--    tablet). One venue-fenced predicate for every paired device type — the manager
--    app could already read recipes via BO users but the tablet itself could not.
-- 3. production_batches: SELECT/INSERT/UPDATE via pos_can_access so a tablet-recorded
--    cook can write its batch row. DELETE stays BO-only.
-- 4. prep_schedule: SELECT via pos_can_access (the tablet reads its linked recipe id
--    at record time); writes stay BO-only — the plan is set in Back Office.

begin;

alter table prep_schedule
  add column if not exists output_item_id uuid,
  add column if not exists recipe_id uuid;

create or replace function public.pos_can_access(p_loc uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if p_loc is null then return false; end if;
  if p_loc::text in (select user_accessible_locations()) then return true; end if;
  if exists (select 1 from public.devices d
             where d.device_uid = auth.uid() and d.status in ('active','online') and d.location_id = p_loc)
  then return true; end if;
  return exists (select 1 from public.ops_devices o
                 where o.device_uid = auth.uid() and o.active and o.location_id = p_loc);
end $$;

create or replace function public.pos_can_access(p_loc text)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if p_loc is null then return false; end if;
  if p_loc in (select user_accessible_locations()) then return true; end if;
  if exists (select 1 from public.devices d
             where d.device_uid = auth.uid() and d.status in ('active','online') and d.location_id::text = p_loc)
  then return true; end if;
  return exists (select 1 from public.ops_devices o
                 where o.device_uid = auth.uid() and o.active and o.location_id::text = p_loc);
end $$;

drop policy if exists production_batches_rls on public.production_batches;
create policy production_batches_sel on public.production_batches for select using (public.pos_can_access(location_id));
create policy production_batches_ins on public.production_batches for insert with check (public.pos_can_access(location_id));
create policy production_batches_upd on public.production_batches for update
  using (public.pos_can_access(location_id)) with check (public.pos_can_access(location_id));
create policy production_batches_del on public.production_batches for delete
  using (location_id::text in (select public.user_accessible_locations()));

drop policy if exists prep_schedule_rls on public.prep_schedule;
create policy prep_schedule_sel on public.prep_schedule for select using (public.pos_can_access(location_id));
create policy prep_schedule_ins on public.prep_schedule for insert with check (location_id::text in (select public.user_accessible_locations()));
create policy prep_schedule_upd on public.prep_schedule for update
  using (location_id::text in (select public.user_accessible_locations()))
  with check (location_id::text in (select public.user_accessible_locations()));
create policy prep_schedule_del on public.prep_schedule for delete
  using (location_id::text in (select public.user_accessible_locations()));

commit;
