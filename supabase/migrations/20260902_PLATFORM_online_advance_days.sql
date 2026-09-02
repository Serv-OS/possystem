-- Allow (or refuse) online orders placed in advance.  PLATFORM project.
--
-- online_advance_days: how many days ahead a customer may schedule collection
-- or delivery. 0 = today only (no "Schedule" for another day). NULL = the old
-- behaviour, 7 days. Some venues only take orders for the day.

alter table public.locations
  add column if not exists online_advance_days integer;

comment on column public.locations.online_advance_days is
  'Max days ahead an online order may be scheduled. 0 = today only. NULL = 7 (legacy default).';
