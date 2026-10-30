-- 20261110a_OPS_chat_hotfixes_mirror.sql
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). 5.11.122, 30 Oct 2026.
--
-- REPO MIRROR of the two chat hotfixes Peter RAN on 28 Oct 2026 right after 5.11.102 (team chat).
-- The live database already has both. This file exists so a fresh database, the local Postgres
-- harness and anyone reading the migrations see the same thing the live database runs. Safe to run
-- again on the live database: it changes nothing there.
--
-- HOTFIX 1 (no force RLS on the chat tables). 20261103a set FORCE ROW LEVEL SECURITY on every chat
-- table. The read helpers (chat_my_member_ids, chat_my_conversation_ids, chat_my_org_ids) run as the
-- table owner (security definer) and read chat_members, chat_profiles and chat_person_state. With
-- FORCE on, the owner is fenced too, so the chat_members rule calls the helper, which reads
-- chat_members, which calls the helper: Postgres stops the loop and refuses every staff app read
-- ("Chat could not load"). FORCE off: signed in people are still fenced by the same rules; only the
-- owner (our own helpers) and the service role see past them, as every other table here.
--
-- HOTFIX 2 (the second step skips chat paths). Every direct PostgREST request first runs
-- second_step_check_request(). A person who also has a Back Office login counts as Back Office there,
-- so at aal1 (the staff app has no second step by design) every chat read was 403 second_step_required.
-- Chat has its own fence (members only, through chat_my_*) and the team-chat function does every
-- write, so the check now returns early for /chat_<table> and /rpc/chat_<helper>. Everything else
-- (every Back Office table) is checked exactly as before.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS migration. Run it on the Ops database only. Nothing was changed.';
  end if;
  if to_regclass('public.chat_messages') is null or to_regprocedure('public.second_step_ok()') is null then
    raise exception 'Run 20261103a_OPS_team_chat and 20260919s_OPS_second_step first. Nothing was changed.';
  end if;
end $guard$;

set local lock_timeout = '3s';

-- Hotfix 1: no force row level security on the chat tables.
do $fix1$
declare t text;
begin
  foreach t in array array['chat_settings','chat_word_lists','chat_profiles','chat_conversations','chat_members',
                           'chat_messages','chat_reactions','chat_reports','chat_moderation_log','chat_person_state']
  loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I no force row level security', t);
    end if;
  end loop;
end $fix1$;

-- Hotfix 2: the request check skips the chat tables and the chat read helpers.
create or replace function public.second_step_check_request()
returns void
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  v_path text := current_setting('request.path', true);
begin
  -- Team chat (28 Oct 2026): the staff app's own reads, fenced by chat membership, never by the
  -- Back Office second step. Paths: /chat_<table> and /rpc/chat_<helper>.
  if v_path like '/chat\_%' or v_path like '/rpc/chat\_%' then
    return;
  end if;
  if not public.second_step_ok() then
    raise exception using
      errcode = '42501',
      message = 'second_step_required',
      detail  = 'This Back Office sign in has not finished its second step.',
      hint    = 'Sign out, then sign in again with Face ID, fingerprint or your authenticator app code.';
  end if;
end
$fn$;

-- VISIBLE CHECK. Expected: chat_tables 10, forced 0, rls_on 10, chat_skip true, still_checks_others true.
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'chat\_%' and c.relname <> 'chat_push_tokens') as chat_tables,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'chat\_%' and c.relforcerowsecurity) as forced,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'chat\_%' and c.relname <> 'chat_push_tokens' and c.relrowsecurity) as rls_on,
  position('/rpc/chat\_%' in p.prosrc) > 0 as chat_skip,
  position('second_step_required' in p.prosrc) > 0 as still_checks_others
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'second_step_check_request';
