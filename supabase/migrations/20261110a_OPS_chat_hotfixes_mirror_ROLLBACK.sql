-- 20261110a_OPS_chat_hotfixes_mirror_ROLLBACK.sql
-- OPS DB ONLY. Puts back what 20261103a installed: FORCE row level security on the chat tables and the
-- request check without the chat skip. WARNING: this brings back the 28 Oct 2026 outage ("Chat could
-- not load" in the staff app). Only for a fresh database that never needed the hotfixes.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS rollback. Run it on the Ops database only. Nothing was changed.';
  end if;
end $guard$;

set local lock_timeout = '3s';

do $undo1$
declare t text;
begin
  foreach t in array array['chat_settings','chat_word_lists','chat_profiles','chat_conversations','chat_members',
                           'chat_messages','chat_reactions','chat_reports','chat_moderation_log','chat_person_state']
  loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I force row level security', t);
    end if;
  end loop;
end $undo1$;

create or replace function public.second_step_check_request()
returns void
language plpgsql
stable
security definer
set search_path to ''
as $fn$
begin
  if not public.second_step_ok() then
    raise exception using
      errcode = '42501',
      message = 'second_step_required',
      detail  = 'This Back Office sign in has not finished its second step.',
      hint    = 'Sign out, then sign in again with Face ID, fingerprint or your authenticator app code.';
  end if;
end
$fn$;

-- VISIBLE CHECK. Expected: forced 10, chat_skip false.
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'chat\_%' and c.relforcerowsecurity) as forced,
  position('/rpc/chat\_%' in p.prosrc) > 0 as chat_skip
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'second_step_check_request';
