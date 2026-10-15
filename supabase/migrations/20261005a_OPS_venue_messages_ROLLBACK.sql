-- ROLLBACK for 20261005a_OPS_venue_messages.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops the venue_messages table, its two functions and its realtime entry. EVERY message
-- sent to venues and every confirmation (who tapped Got it, and when) is lost.
--
-- Nothing else is touched. Tills and Back Office need nothing: a pop up that is on screen goes
-- within a minute or two (the next read finds no table and clears it), and Company Admin,
-- Messages to venues goes back to saying it needs the database update.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.devices') is null then
    raise exception 'This is not the Ops database (device_profiles or devices is missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

do $realtime$
begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'venue_messages') then
    alter publication supabase_realtime drop table public.venue_messages;
  end if;
end
$realtime$;

drop function if exists public.venue_message_confirm(uuid, text);
drop table if exists public.venue_messages;
-- After the table: its read rule uses this one.
drop function if exists public.venue_message_reader_location_ids();

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0 and 0.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'venue_messages') as table_left,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('venue_message_confirm', 'venue_message_reader_location_ids')) as functions_left;
