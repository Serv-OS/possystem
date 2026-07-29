-- 20260729e_waste_events_device_write.sql — OPS DB
--
-- THE LAST LEG OF POS WASTE. 20260729d gave paired tills READ on the stock model, but
-- waste_events kept its BO-only FOR ALL policy — so the till's insert was refused, the
-- modal stayed open with a missable error toast, and staff could not tell whether the
-- waste recorded. It had not. (The stock movements never posted either: the flow stops
-- when the event insert fails, so the ledger stayed consistent — nothing recorded at all.)
--
-- Devices get SELECT + INSERT via pos_can_access — a device only ever passes for ITS OWN
-- location's rows, so the tenant wall holds. UPDATE/DELETE stay BO-only: a till records
-- waste, it does not edit history.

begin;
drop policy if exists waste_events_rls on public.waste_events;
drop policy if exists waste_events_sel on public.waste_events;
drop policy if exists waste_events_ins on public.waste_events;
drop policy if exists waste_events_upd on public.waste_events;
drop policy if exists waste_events_del on public.waste_events;
create policy waste_events_sel on public.waste_events for select using (public.pos_can_access(location_id));
create policy waste_events_ins on public.waste_events for insert with check (public.pos_can_access(location_id));
create policy waste_events_upd on public.waste_events for update
  using (location_id::text in (select public.user_accessible_locations()))
  with check (location_id::text in (select public.user_accessible_locations()));
create policy waste_events_del on public.waste_events for delete
  using (location_id::text in (select public.user_accessible_locations()));
commit;
