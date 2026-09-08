-- 20260901_PLATFORM_busy_prep_time.sql   ── PLATFORM DB (yhzjgyrkyjabvhblqxzu)
--
-- Collection lead time that rises with how busy the kitchen actually is.
--
-- Today the lead time is a single fixed number: set 30 minutes and every order
-- promises 30 minutes, whether there is nothing on and one order in, or a
-- Saturday with forty tickets waiting. The second case is where a venue takes an
-- order it cannot make in time, and the customer arrives to wait.
--
-- The rule is deliberately simple enough for an operator to reason about:
--   for every <step_orders> live orders, add <step_minutes>, capped at <max>.
--
-- All three are NULL by default, which means the behaviour is exactly what it is
-- today until somebody opts in. Nothing changes for any existing venue.

alter table public.locations
  add column if not exists online_busy_step_orders  integer,
  add column if not exists online_busy_step_minutes integer,
  add column if not exists online_busy_max_minutes  integer;

comment on column public.locations.online_busy_step_orders is
  'Busy prep rule: how many LIVE orders (accepted but not yet ready) count as one step. '
  'NULL or 0 disables the rule and the flat online_collection_lead_min applies.';
comment on column public.locations.online_busy_step_minutes is
  'Busy prep rule: minutes added per completed step.';
comment on column public.locations.online_busy_max_minutes is
  'Busy prep rule: ceiling on the ADDED minutes, so a backlog can never quote an absurd wait. '
  'NULL means the app default applies.';
