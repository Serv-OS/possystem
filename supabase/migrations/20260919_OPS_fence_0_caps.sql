-- 20260919_OPS_fence_0_caps.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  DATABASE FENCE, STAGE 1, STEP 1b. Run this WITH the app release          #
-- #  (runbook docs/FENCE_STAGE_1.md step 1b), BEFORE file 1 (20260919a).      #
-- #  It changes no policy, no grant and no row. It only gives devices the two #
-- #  columns the release writes to, so that file 1 can tell a till that is    #
-- #  really running the fence app from one that only reports a new version.   #
-- #  Safe during service: two nullable columns, nothing is rewritten.         #
-- ############################################################################
--
-- WHY THIS EXISTS (fix round 3, 19 Sep). File 1 must not run while any till is still on the
-- old app: after it, codes are hidden and old codes are retired, so a till left behind cannot
-- pair or re-link and is stranded. File 1 used to test that with a VERSION STRING, which does
-- not work: 5.9.10 and 5.9.11 both shipped without a line of the fence app, and every till on
-- the floor compares as new enough. So file 1 now asks for what the app ITSELF recorded, the
-- way file 2 (20260919b) already does: devices.client_caps must carry 'fence_v1'.
--
-- The release reports its capabilities on every heartbeat (src/lib/deviceFence.js FENCE_CAPS).
-- While file 1 has not run there is no device_heartbeat() function to report them to, so the
-- release writes them straight onto its own devices row (contract A14, legacyHeartbeatPatch).
-- It can only do that once the column exists, which is what this file is for. Run it with the
-- release; every till then proves itself within a minute of loading the new app.
--
-- device_secret_hash is here too, and only so that file 1's check reads the same on a re-run:
-- a till that already collected its secret from an earlier run of file 1 counts as ready even
-- if its capabilities were cleared. File 1 creates both columns itself as well, so running
-- this file is not strictly required; skipping it only means file 1 stops and tells you so.
--
-- RULES OF THE FILE: no begin or commit (the SQL editor runs the paste as one transaction);
-- every statement can run twice; roll back block in the comments at the end.

do $guard$
begin
  if to_regclass('public.devices') is null
     or to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS project (tbetcegmszzotrwdtqhi). This is not it. Nothing was changed.';
  end if;
end
$guard$;

alter table public.devices add column if not exists client_caps        text[];
alter table public.devices add column if not exists device_secret_hash text;

comment on column public.devices.client_caps is
  '20260919a fence: what the running app on this device can do (reported by device_heartbeat, or written by the device itself while that function does not exist). Files 1 and 2 wait until every device switched on reports fence_v1.';

-- What you should see: one row, "client_caps,device_secret_hash".
select string_agg(column_name, ',' order by column_name) as columns_added
  from information_schema.columns
 where table_schema = 'public' and table_name = 'devices'
   and column_name in ('client_caps', 'device_secret_hash');


-- -- ==========================================================================
-- -- ROLL BACK (20260919_OPS_fence_0_caps.sql)
-- -- ==========================================================================
-- -- Copy from the rule line above this heading to the end of the file, paste it into the Ops
-- -- SQL editor, select all (Cmd+A), press Cmd+/ once so every line loses its first "-- ",
-- -- and press Run. It can be run twice.
-- --
-- -- Only roll this back while file 1 (20260919a) is NOT in: file 1 needs both columns. The
-- -- first statement stops the roll back if it is.
-- do $rb_guard$
-- begin
--   if to_regclass('public.fence_state') is not null
--      and exists (select 1 from public.fence_state where key = 'file_a') then
--     raise exception 'STOPPED, NOTHING WAS CHANGED. Roll back 20260919a_OPS_fence_1_after_release.sql first: it needs these columns.';
--   end if;
-- end
-- $rb_guard$;
--
-- alter table public.devices drop column if exists client_caps;
-- alter table public.devices drop column if exists device_secret_hash;
--
-- -- What you should see: one row, an empty columns_left.
-- select coalesce(string_agg(column_name, ',' order by column_name), '') as columns_left
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'devices'
--    and column_name in ('client_caps', 'device_secret_hash');
