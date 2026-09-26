-- 20260926a_OPS_active_sessions_venue_fence.sql  (Ops DB, Peter runs)
--
-- VENUE FENCE for table sessions (v5.9.71, 26 Sep 2026). Provo's demo orders were published
-- under Coffee Boy Leeds, Barnsley and Barnsley Train Station by one browser that followed the
-- Back Office venue switch. The app now tags every session with its venue (session._loc) and
-- refuses to publish it anywhere else; this trigger is the database's own copy of that rule,
-- so no client, old or new, can write a session tagged for one venue under another.
-- Untagged sessions (created before v5.9.71) are not judged here.

create or replace function public._active_sessions_venue_fence()
returns trigger
language plpgsql
as $$
begin
  if new.session is not null
     and (new.session ? '_loc')
     and nullif(new.session->>'_loc', '') is not null
     and (new.session->>'_loc') is distinct from new.location_id::text then
    raise exception 'venue fence: this session belongs to venue %, not %', new.session->>'_loc', new.location_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists active_sessions_venue_fence on public.active_sessions;
create trigger active_sessions_venue_fence
  before insert or update on public.active_sessions
  for each row execute function public._active_sessions_venue_fence();

-- ── CLEAN UP the rows that leaked (26 Sep 2026): Provo's four demo tables at the four real venues.
-- 19 rows at the time of writing: Coffee Boy Barnsley 4, Barnsley Train Station 7, Coffee Boy Leeds 1, Leeds 7.
delete from public.active_sessions
 where table_id in ('t-1776905960241','t-1776905987058','t-1783614852190','t-1783614852190-2','t-1776905987058-2','t-1776905944421','t1')
   and location_id in ('1e252e7c-c875-4971-b91d-1e945c26956b',   -- Coffee Boy Leeds
                       '3f915972-7107-4f70-9b3d-de80ba9ab0c2',   -- Coffee Boy Barnsley Train Station
                       'aa7835ea-9798-4d38-8e69-e0186ae523ea',   -- Leeds
                       'c5dd8483-f250-4868-9e46-709a74d78e2a');  -- Coffee Boy Barnsley
