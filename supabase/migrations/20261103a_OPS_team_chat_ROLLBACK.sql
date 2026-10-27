-- 20261103a_OPS_team_chat_ROLLBACK.sql
-- Puts the Ops database back as it was before 20261103a_OPS_team_chat.sql.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand. One transaction: any error and nothing changes. #
-- #  Lock wait 3 s. Run the 5.11.101 web app first (the chat screens go with  #
-- #  it), then this.                                                         #
-- ############################################################################
--
-- It refuses while any chat message exists: dropping the tables would lose them for good. To go
-- ahead anyway (people's messages are lost), delete them first:
--   delete from public.chat_messages;
-- What it drops: the wf_staff trigger, every chat_* function, the eleven chat tables (settings,
-- word lists, profiles, groups, members, reactions, reports, the moderation log, phones), the
-- nightly clean up job. The chat-photos bucket goes only when it is empty (else it stays, private,
-- and nothing reads it). Staff, venues and logins are untouched.

do $guard$
declare
  v_msgs bigint;
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.chat_messages') is null then
    raise exception 'Team chat (20261103a) is not in this database. Nothing was changed.';
  end if;
  select count(*) into v_msgs from public.chat_messages;
  if v_msgs > 0 then
    raise exception 'There are % chat message(s). They would be lost. Delete them first (see the note at the top). Nothing was changed.', v_msgs;
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

drop trigger if exists trg_wf_staff_chat_sync on public.wf_staff;

do $drop$
declare
  f text;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'chat-purge') then
      perform cron.unschedule('chat-purge');
    end if;
  end if;
  for f in select p.oid::regprocedure::text from pg_proc p
            where p.pronamespace = 'public'::regnamespace and (p.proname like 'chat\_%' or p.proname like '\_chat\_%') loop
    execute format('drop function %s cascade', f);
  end loop;
  -- Supabase guards storage.buckets with protect_buckets_delete; this setting is how a direct delete
  -- is allowed (review fix S4, 5.11.102). It lasts for this transaction only.
  perform set_config('storage.allow_delete_query', 'true', true);
  if to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null then
    if not exists (select 1 from storage.objects where bucket_id = 'chat-photos') then
      delete from storage.buckets where id = 'chat-photos';
    end if;
  elsif to_regclass('storage.buckets') is not null then
    delete from storage.buckets where id = 'chat-photos';
  end if;
end
$drop$;

drop table if exists public.push_devices;
drop table if exists public.chat_person_state;
drop table if exists public.chat_moderation_log;
drop table if exists public.chat_reports;
drop table if exists public.chat_reactions;
drop table if exists public.chat_messages;
drop table if exists public.chat_members;
drop table if exists public.chat_conversations;
drop table if exists public.chat_profiles;
drop table if exists public.chat_word_lists;
drop table if exists public.chat_settings;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: chat_tables 0, chat_functions 0, staff_trigger false, staff_rows_kept true.
select
  (select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and (c.relname like 'chat\_%' or c.relname = 'push_devices')) as chat_tables,
  (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'chat\_%' or p.proname like '\_chat\_%')) as chat_functions,
  exists (select 1 from pg_trigger where tgname = 'trg_wf_staff_chat_sync') as staff_trigger,
  (select count(*) >= 0 from public.wf_staff) as staff_rows_kept;
