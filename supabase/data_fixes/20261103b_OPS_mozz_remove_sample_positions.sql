-- 20261103b_OPS_mozz_remove_sample_positions.sql (5.12.50). Run in the Ops SQL editor. ASCII only.
--
-- Peter, 3 Nov 2026: a new site should start with no positions. Opening Workforce at a site with none
-- used to write nine sample positions with UK pay (Server 12.21, Chef 15.50, Duty Manager 32,000).
-- 5.12.50 stops that. This removes the samples already written at Mozz Sourdough Pizza ONLY, and only
-- rows nobody has touched: the exact sample label and pay, never edited, and no staff record, shift
-- or scheduled rate change using the position. Anything else is left alone.

begin;

with sample(key, label, base_rate, salary_annual) as (values
  ('bartender', 'Bartender', 12.50, null), ('barback', 'Barback', 10.00, null),
  ('supervisor', 'Supervisor', 14.50, null), ('server', 'Server', 12.21, null),
  ('host', 'Host', 12.21, null), ('chef', 'Chef', 15.50, null),
  ('kp', 'Kitchen Porter', 11.50, null), ('dutymgr', 'Duty Manager', null, 32000),
  ('door', 'Door', 13.50, null))
delete from public.wf_roles r
 using sample s
 where r.org_id = '70f9bd4f-a676-4a8f-aa9a-6d640df9d26d'
   and r.key = s.key and r.label = s.label
   and r.base_rate is not distinct from s.base_rate::numeric
   and r.salary_annual is not distinct from s.salary_annual::numeric
   and r.updated_at <= r.created_at + interval '2 seconds'
   and not exists (select 1 from public.wf_staff x where x.location_id = r.location_id and x.role_key = r.key)
   and not exists (select 1 from public.wf_shifts x where x.location_id = r.location_id and x.role_key = r.key)
   and not exists (select 1 from public.wf_rate_changes x where x.location_id = r.location_id and x.role_key = r.key);

commit;

-- Check: every Mozz site should show 0 positions.
select l.name, count(r.id) as positions
  from public.locations l left join public.wf_roles r on r.location_id = l.id
 where l.org_id = '70f9bd4f-a676-4a8f-aa9a-6d640df9d26d'
 group by l.name order by l.name;
