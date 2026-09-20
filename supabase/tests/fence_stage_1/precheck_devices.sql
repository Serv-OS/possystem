-- READ ONLY. What 20260919a will do to every device, before you run it (runbook step 3).
-- Paste in the Ops SQL editor. It changes nothing. One row per device:
--   kept             keeps working, nothing to do
--   unpaired_in_use  used this week: it will show the red banner "not linked"; pair it
--                    again with Pair again on the till and a new code from Back Office
--   removed          not used for 14 days, no venue, or never paired: nothing to do
--                    unless you still use it (then pair it again the same way)
-- The same rule as section 6b of the file (testA.py checks they agree).
with facts as (
  select d.id, d.name, d.location_id, d.type, d.status, d.device_uid, d.paired_at, d.created_at,
         greatest(d.last_seen, (select max(h.last_seen) from public.device_heartbeats h where h.device_id = d.id::text)) as seen_at,
         coalesce((select u.is_anonymous from auth.users u where u.id = d.device_uid), false) as uid_is_anon,
         exists (select 1 from public.user_locations ul where ul.user_id = d.device_uid and ul.location_id = d.location_id) as uid_linked_here,
         exists (select 1 from public.user_profiles p where p.id = d.device_uid and p.role = 'super_admin') as uid_is_super
    from public.devices d
), judged as (
  select f.*,
         (f.device_uid is not null and f.location_id is not null and f.status in ('active', 'online')
          and f.seen_at > now() - interval '14 days'
          and (f.uid_is_anon or f.uid_linked_here or f.uid_is_super)) as eligible,
         (f.location_id is not null and f.status in ('active', 'online')
          and f.seen_at is not null and f.seen_at > now() - interval '14 days') as recent
    from facts f
), ranked as (
  select j.*,
         row_number() over (partition by j.device_uid
                            order by j.eligible desc, j.seen_at desc nulls last, j.paired_at desc nulls last, j.created_at desc) as rn
    from judged j
)
select coalesce(l.name, 'no venue') as venue,
       r.name as device,
       r.type,
       case
         when r.device_uid is not null and r.eligible and r.rn = 1 then 'kept'
         when r.device_uid is not null and r.recent then 'unpaired_in_use'
         when r.device_uid is not null then 'removed'
         when r.status in ('active', 'online') and r.recent then 'unpaired_in_use'
         when r.status in ('active', 'online') then 'removed'
         else 'untouched'
       end as fate,
       case
         when r.device_uid is not null and r.eligible and r.rn = 1 then 'used in the last 14 days'
         when r.device_uid is null then 'never paired by a till'
         when r.location_id is null then 'no venue'
         when r.status not in ('active', 'online') then 'status ' || coalesce(r.status, 'none')
         when r.seen_at is null or r.seen_at <= now() - interval '14 days' then 'not used for 14 days'
         when not (r.uid_is_anon or r.uid_linked_here or r.uid_is_super) then 'signed in with a Back Office login that is not linked to this venue'
         else 'the same till is on a newer row'
       end as why,
       r.seen_at::date as last_used
  from ranked r
  left join public.locations l on l.id = r.location_id
 order by case when r.device_uid is not null and r.eligible and r.rn = 1 then 3
               when r.status in ('active', 'online') and r.recent then 1 else 2 end,
          1, 2;
