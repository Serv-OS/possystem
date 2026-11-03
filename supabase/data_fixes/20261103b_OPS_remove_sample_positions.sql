-- 20261103b_OPS_remove_sample_positions.sql (5.12.50). Run in the Ops SQL editor. ASCII only.
--
-- Peter, 3 Nov 2026: "all apart from POSUP Test need to be gone, my test account can stay".
-- Opening Workforce at a site with no positions used to write nine sample positions with UK pay
-- (Server 12.21, Chef 15.50, Duty Manager 32,000); 5.12.50 stops that. This removes those samples at
-- every company except POSUP Test, and only rows nobody has touched: the exact sample label and pay,
-- never edited, and no staff record, shift or scheduled rate change using the position. A sample
-- position someone uses (or changed) is kept.

begin;

with sample(key, label, base_rate, salary_annual) as (values
  ('bartender', 'Bartender', 12.50, null), ('barback', 'Barback', 10.00, null),
  ('supervisor', 'Supervisor', 14.50, null), ('server', 'Server', 12.21, null),
  ('host', 'Host', 12.21, null), ('chef', 'Chef', 15.50, null),
  ('kp', 'Kitchen Porter', 11.50, null), ('dutymgr', 'Duty Manager', null, 32000),
  ('door', 'Door', 13.50, null))
delete from public.wf_roles r
 using sample s
 where r.org_id is distinct from 'a59a6d97-ffaa-470e-8bb7-04cba789f335'
   and r.key = s.key and r.label = s.label
   and r.base_rate is not distinct from s.base_rate::numeric
   and r.salary_annual is not distinct from s.salary_annual::numeric
   and r.updated_at <= r.created_at + interval '2 seconds'
   and not exists (select 1 from public.wf_staff x where x.location_id = r.location_id and x.role_key = r.key)
   and not exists (select 1 from public.wf_shifts x where x.location_id = r.location_id and x.role_key = r.key)
   and not exists (select 1 from public.wf_rate_changes x where x.location_id = r.location_id and x.role_key = r.key);

commit;

-- Check: sample positions left outside POSUP Test (only ones in use should remain).
select l.name as site, r.label as position_kept
  from public.wf_roles r join public.locations l on l.id = r.location_id
 where r.org_id is distinct from 'a59a6d97-ffaa-470e-8bb7-04cba789f335'
   and (r.key, r.label) in (('bartender','Bartender'),('barback','Barback'),('supervisor','Supervisor'),('server','Server'),
        ('host','Host'),('chef','Chef'),('kp','Kitchen Porter'),('dutymgr','Duty Manager'),('door','Door'))
 order by 1, 2;
