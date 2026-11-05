-- 20261124a_OPS_device_profile_order_details.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 3 boolean columns to device_profiles. No data changes.              #
-- #  Takes a moment; outside service is best, as always.                      #
-- ############################################################################
--
-- WHY (Peter, 5 Nov 2026)
--   "Like the table flag number we can force to bring it up: a number of guests in the party,
--   order type, new customer question yes or no, yes equals flag on the KDS or production
--   ticket. These all need to be able to be turned off and on in the same place as the force
--   table flag feature." And: "its not that its forced, its that it pops up. I want one screen
--   that has this info and each one can be turned off and on."
--
-- WHAT THIS FILE DOES
--   One pop up on the till ("Order details") before a walk in order is sent or paid. It shows
--   only the parts switched on for the device profile, and the existing flag number is one of
--   them (device_profiles.dine_in_flag_prompt, 20260930c). This file adds the other three:
--
--   device_profiles.order_prompt_guests        boolean, default false. On: a dine in walk in
--                                              order asks how many guests are in the party.
--                                              Kitchen screens and tickets then show the covers,
--                                              and the closed check books them.
--   device_profiles.order_prompt_order_type    boolean, default false. On: the pop up asks staff
--                                              to pick the order type from the profile's enabled
--                                              types before the order goes.
--   device_profiles.order_prompt_new_customer  boolean, default false. On: the pop up asks
--                                              "New customer?" Yes or No. Yes puts a NEW CUSTOMER
--                                              mark on the kitchen screen card and the
--                                              production ticket.
--
-- WHY NEW COLUMNS (and not hidden_features)
--   hidden_features is a jsonb list that every Back Office build rewrites in full on save, so a
--   value hidden inside it would be wiped by a save from a Back Office build that does not know
--   it (the stale WebView problem). Old code never reads or writes a column it does not know.
--
-- BEFORE AND AFTER IT RUNS
--   Before: the app works as today. The flag number setting keeps working (its own column is
--   already there). Back Office shows the three new switches greyed out with "needs a database
--   update" and no save sends them.
--   After: refresh Back Office, open a device profile, and the three switches under "Order
--   details pop up" are live. Tills pick the values up when their profile next loads (boot, Push
--   to POS, the 5 minute refresh), like every profile setting.
--
-- Rollback: 20261124a_OPS_device_profile_order_details_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null then
    raise exception 'This is not the Ops database (device_profiles is missing). Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'device_profiles' and column_name = 'dine_in_flag_prompt'
  ) then
    raise exception 'Run 20260930c_OPS_device_profile_default_order_type.sql first (dine_in_flag_prompt is missing). Nothing was changed.';
  end if;
end
$guard$;

-- Fail fast on a busy table instead of making till and kiosk reads queue behind this script.
set local lock_timeout = '3s';

alter table public.device_profiles add column if not exists order_prompt_guests boolean not null default false;
alter table public.device_profiles add column if not exists order_prompt_order_type boolean not null default false;
alter table public.device_profiles add column if not exists order_prompt_new_customer boolean not null default false;

comment on column public.device_profiles.order_prompt_guests is
  'On: the till''s Order details pop up asks how many guests are in the party on a dine in walk in order before it is sent or paid. The covers go on the kitchen screen, the production ticket and the closed check (src/lib/tillOrderType.js). POS only.';
comment on column public.device_profiles.order_prompt_order_type is
  'On: the till''s Order details pop up asks staff to pick the order type (from the profile''s enabled types) before a walk in order is sent or paid (src/lib/tillOrderType.js). POS only.';
comment on column public.device_profiles.order_prompt_new_customer is
  'On: the till''s Order details pop up asks New customer? Yes or No before a walk in order is sent or paid. Yes marks the kitchen screen card and the production ticket NEW CUSTOMER (src/lib/tillOrderType.js). POS only.';

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): 3.
select count(*) as columns_added
from information_schema.columns
where table_schema = 'public' and table_name = 'device_profiles'
  and column_name in ('order_prompt_guests', 'order_prompt_order_type', 'order_prompt_new_customer');
