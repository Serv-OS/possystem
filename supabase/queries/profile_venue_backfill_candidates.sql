-- supabase/queries/profile_venue_backfill_candidates.sql
--
-- OPS DB (tbetcegmszzotrwdtqhi). READ ONLY. Run this BEFORE 20260918d_OPS_profile_venue_lock.sql.
--
-- Lists every real (non anonymous, non super admin) login whose profile venue
-- (user_profiles.location_id) has NO venue link (user_locations row). Today that profile venue
-- is access; after 20260918d it is not. 20260918d links ONLY the ids you confirm, because the
-- hole is open until it runs: anyone could have pointed their profile at somebody else's venue.
--
-- For each row, check before confirming:
--   * same_company is yes (the login's company is the venue's company);
--   * you know the email: a real owner or manager of that venue, not a stranger;
--   * signed_up is not suspiciously recent.
-- Expected on 18 Sep 2026: exactly 1 row (the one legacy owner). Paste the id(s) you confirm
-- into v_confirmed in step 1 of 20260918d. Anyone you do not confirm only loses the access the
-- profile venue gave them; a venue owner can add them back from Staff.
select p.id                                            as user_id,
       p.email,
       p.role,
       p.location_id                                   as profile_venue_id,
       l.name                                          as profile_venue,
       case when p.org_id is not distinct from l.org_id then 'yes' else 'NO' end as same_company,
       u.created_at::date                              as signed_up,
       u.last_sign_in_at::date                         as last_sign_in,
       (select count(*) from public.user_locations x where x.user_id = p.id) as other_venue_links
  from public.user_profiles p
  join auth.users u on u.id = p.id
  join public.locations l on l.id = p.location_id
 where p.location_id is not null
   and not coalesce(u.is_anonymous, false)
   and coalesce(p.role, '') <> 'super_admin'
   and not exists (select 1 from public.user_locations ul
                    where ul.user_id = p.id and ul.location_id = p.location_id)
 order by u.created_at;
