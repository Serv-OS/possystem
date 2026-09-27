-- 20260928a_OPS_discount_manager_scrub.sql   (Ops DB tbetcegmszzotrwdtqhi)
--
-- WHAT: a discount approved by a manager carried that manager's WHOLE staff record in
-- discounts[].manager: PIN in plain text, permissions, staff card id (nfcCardId), sign in method.
-- The till's discount screen stored it that way until v5.10.0. This reduces every such manager
-- to { id, name, role }, the shape v5.10.0 writes, so reports still show who approved it.
--
-- WHERE (read only query, 28 Sep 2026 00:05 UK): 11 closed_checks rows, nothing else.
--   Coffee Boy Leeds  9 checks  26 to 27 Sep  "Custom 100%", "Staff Discount 50%"  staff "Test"
--   Provo             2 checks  May and Aug   "Staff Meal"                          staff "Peter"
--   active_sessions, terminal_jobs.check_draft, kds_tickets, order_queue, print_jobs, bar_tabs,
--   shifts.z_report, ops_audit, config_pushes: none. They are still covered below, because a till
--   that has not reloaded onto v5.10.0 can write a new one until it does.
--
-- SAFE TO RUN AT ANY TIME, AND TO RUN AGAIN. Plain UPDATEs, no schema change, no transaction
-- wrapper (the SQL editor chokes on begin/commit). Each UPDATE touches only rows that still hold a
-- secret, so a second run changes 0 rows. Only the manager object inside a discount changes: labels,
-- amounts, items and totals are untouched. No trigger on closed_checks or terminal_jobs; the
-- active_sessions venue fence trigger only checks session._loc, which this does not change.
-- Tills get the cleaned rows through realtime as normal.
--
-- NO ROLLBACK ON PURPOSE: undoing it would put the PINs back.
--
-- AFTER RUNNING: change the PIN of the two staff above (Back Office, Staff), because those PINs
-- were readable by anything that could read a check at those venues.
--
-- HOW: run STEP 1 on its own and note the numbers. Run STEP 2 (the three updates). Run STEP 1
-- again: every count must be 0. Run STEP 1 again a day later; if a stale till wrote a new one,
-- run STEP 2 again.


-- ───────────────────────── STEP 1: READ ONLY, run first ─────────────────────────
-- One row per table and venue that still holds a staff record on a discount. No rows = clean.
select 'closed_checks' as tbl, c.location_id::text as location_id, l.name as venue, count(*) as rows_with_secret
from closed_checks c left join locations l on l.id::text = c.location_id::text
where jsonb_path_exists(c.discounts, '$[*].manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))')
   or jsonb_path_exists(c.items,     '$[*].discount.manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))')
group by 1, 2, 3
union all
select 'active_sessions', s.location_id::text, l.name, count(*)
from active_sessions s left join locations l on l.id::text = s.location_id::text
where jsonb_path_exists(s.session, '$.discounts[*].manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))')
   or jsonb_path_exists(s.session, '$.items[*].discount.manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))')
group by 1, 2, 3
union all
select 'terminal_jobs', j.location_id::text, l.name, count(*)
from terminal_jobs j left join locations l on l.id::text = j.location_id::text
where jsonb_path_exists(j.check_draft, '$.discounts[*].manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))')
   or jsonb_path_exists(j.check_draft, '$.items[*].discount.manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))')
group by 1, 2, 3
order by 1, 3;


-- ───────────────────────── STEP 2: THE FIX ─────────────────────────
-- The same rule three times: in a discounts array (and in each item's own discount), a manager
-- that is an object becomes { id, name, role } with only the keys it had. Array order is kept.

-- 2a. closed_checks.discounts and closed_checks.items[].discount
update closed_checks c
set discounts = case when jsonb_typeof(c.discounts) = 'array' then (
      select coalesce(jsonb_agg(
        case when jsonb_typeof(d->'manager') = 'object'
          then d || jsonb_build_object('manager', jsonb_strip_nulls(jsonb_build_object(
                 'id', d->'manager'->'id', 'name', d->'manager'->'name', 'role', d->'manager'->'role')))
          else d end
        order by o), '[]'::jsonb)
      from jsonb_array_elements(c.discounts) with ordinality as e(d, o)
    ) else c.discounts end,
    items = case when jsonb_typeof(c.items) = 'array' then (
      select coalesce(jsonb_agg(
        case when jsonb_typeof(i->'discount'->'manager') = 'object'
          then jsonb_set(i, '{discount,manager}', jsonb_strip_nulls(jsonb_build_object(
                 'id', i->'discount'->'manager'->'id', 'name', i->'discount'->'manager'->'name', 'role', i->'discount'->'manager'->'role')))
          else i end
        order by o), '[]'::jsonb)
      from jsonb_array_elements(c.items) with ordinality as e(i, o)
    ) else c.items end
where jsonb_path_exists(c.discounts, '$[*].manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))')
   or jsonb_path_exists(c.items,     '$[*].discount.manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))');

-- 2b. active_sessions.session (open tables): session.discounts and session.items[].discount
update active_sessions s
set session = s.session
  || case when jsonb_typeof(s.session->'discounts') = 'array' then jsonb_build_object('discounts', (
       select coalesce(jsonb_agg(
         case when jsonb_typeof(d->'manager') = 'object'
           then d || jsonb_build_object('manager', jsonb_strip_nulls(jsonb_build_object(
                  'id', d->'manager'->'id', 'name', d->'manager'->'name', 'role', d->'manager'->'role')))
           else d end
         order by o), '[]'::jsonb)
       from jsonb_array_elements(s.session->'discounts') with ordinality as e(d, o)))
     else '{}'::jsonb end
  || case when jsonb_typeof(s.session->'items') = 'array' then jsonb_build_object('items', (
       select coalesce(jsonb_agg(
         case when jsonb_typeof(i->'discount'->'manager') = 'object'
           then jsonb_set(i, '{discount,manager}', jsonb_strip_nulls(jsonb_build_object(
                  'id', i->'discount'->'manager'->'id', 'name', i->'discount'->'manager'->'name', 'role', i->'discount'->'manager'->'role')))
           else i end
         order by o), '[]'::jsonb)
       from jsonb_array_elements(s.session->'items') with ordinality as e(i, o)))
     else '{}'::jsonb end
where jsonb_path_exists(s.session, '$.discounts[*].manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))')
   or jsonb_path_exists(s.session, '$.items[*].discount.manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))');

-- 2c. terminal_jobs.check_draft (a card reader job carries a copy of the bill's discounts)
update terminal_jobs j
set check_draft = j.check_draft
  || case when jsonb_typeof(j.check_draft->'discounts') = 'array' then jsonb_build_object('discounts', (
       select coalesce(jsonb_agg(
         case when jsonb_typeof(d->'manager') = 'object'
           then d || jsonb_build_object('manager', jsonb_strip_nulls(jsonb_build_object(
                  'id', d->'manager'->'id', 'name', d->'manager'->'name', 'role', d->'manager'->'role')))
           else d end
         order by o), '[]'::jsonb)
       from jsonb_array_elements(j.check_draft->'discounts') with ordinality as e(d, o)))
     else '{}'::jsonb end
  || case when jsonb_typeof(j.check_draft->'items') = 'array' then jsonb_build_object('items', (
       select coalesce(jsonb_agg(
         case when jsonb_typeof(i->'discount'->'manager') = 'object'
           then jsonb_set(i, '{discount,manager}', jsonb_strip_nulls(jsonb_build_object(
                  'id', i->'discount'->'manager'->'id', 'name', i->'discount'->'manager'->'name', 'role', i->'discount'->'manager'->'role')))
           else i end
         order by o), '[]'::jsonb)
       from jsonb_array_elements(j.check_draft->'items') with ordinality as e(i, o)))
     else '{}'::jsonb end
where jsonb_path_exists(j.check_draft, '$.discounts[*].manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))')
   or jsonb_path_exists(j.check_draft, '$.items[*].discount.manager ? (exists(@.pin) || exists(@.nfcCardId) || exists(@.permissions))');
