-- 20261105a_OPS_chat_notifications.sql
-- Release 5.11.109, team chat notifications.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  One transaction: any error and nothing changes. It refuses a second run. #
-- #  Lock wait 3 s (it gives up, nothing changes). Run after UK close.        #
-- ############################################################################
--
-- WHAT IT CHANGES (Peter, 28 Oct 2026: notify always by default)
--   1. Every chat message pushes by default. The company setting Quiet when off shift stays, but a
--      new company now starts with it off (chat_settings.quiet_off_shift default false, and the
--      built in defaults for a company with no settings row), and the POSUP Test company row is
--      switched off.
--   2. Each person can choose Quiet when off shift for themselves in the staff app, Me tab
--      (chat_profiles.quiet_off_shift, default off; chat_me_quiet). A message is held back off
--      shift when the person chose it OR the company setting is on (chat_push_targets); urgent
--      announcements and @mentions by a manager or owner still come through, as before.
--   3. A push log (push_log: company, person, kind, sent or failed, the push service's status and
--      reason, when), written by the edge functions after every push and kept 30 days (the nightly
--      clean up). Owners and managers read the phone count and the last 20 pushes in Team chat,
--      Settings, Notifications (chat_notify_status). Nobody but the service role reads or writes it.
--   4. The chats list knows what is for you: chat_inbox answers, per chat, how many unread messages
--      are direct messages to you or @mention you (for_you), and your own chat profile id.
--   5. The phones handed to the push code carry their company and person (for the log).
--   Replaced, otherwise word for word as 20261103a (checked against the live database 28 Oct):
--   _chat_settings, chat_whoami, chat_push_targets, chat_push_staff_devices, chat_inbox, chat_purge.
--   New: chat_me_quiet, chat_notify_status (the service role only, like every chat function).
--
-- WHAT IT NEVER DOES
--   No message, member, group, staff, shift or login row changes. Only the POSUP Test company's
--   chat settings row is written.
--
-- ROLLBACK
--   20261105a_OPS_chat_notifications_ROLLBACK.sql

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.chat_push_targets(bigint)') is null or to_regclass('public.chat_profiles') is null
     or to_regclass('public.push_devices') is null then
    raise exception 'Team chat (20261103a) is not in this database yet. Run it first. Nothing was changed.';
  end if;
  if to_regclass('public.push_log') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_profiles' and column_name = 'quiet_off_shift') then
    raise exception 'Chat notifications (20261105a) has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ============================================================================
-- 1. TABLES
-- ============================================================================
alter table public.chat_settings alter column quiet_off_shift set default false;
comment on column public.chat_settings.quiet_off_shift is 'Quiet when off shift for the whole company. Off unless an owner turns it on (20261105a; was on by default in 20261103a).';

alter table public.chat_profiles add column quiet_off_shift boolean not null default false;
comment on column public.chat_profiles.quiet_off_shift is 'The person''s own Quiet when off shift (staff app, Me). Off by default (20261105a).';

create table public.push_log (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  member_id uuid,
  kind text not null default 'push' check (char_length(kind) between 1 and 40),
  ok boolean not null,
  status integer,
  reason text check (reason is null or char_length(reason) <= 200),
  created_at timestamptz not null default now()
);
create index push_log_org_time on public.push_log (org_id, created_at desc);
create index push_log_time on public.push_log (created_at);
comment on table public.push_log is 'One row per phone per push: sent (ok) or not, with the push service''s status and reason. Written by the edge functions, kept 30 days (chat_purge). Service role only (20261105a).';

alter table public.push_log enable row level security;
alter table public.push_log force row level security;
revoke all on public.push_log from public, anon, authenticated;
grant all on public.push_log to service_role;
revoke all on sequence public.push_log_id_seq from public, anon, authenticated;
grant usage, select on sequence public.push_log_id_seq to service_role;

-- Peter, 28 Oct 2026: notify always by default. The POSUP Test company row is the one row live.
update public.chat_settings set quiet_off_shift = false, updated_at = now()
 where org_id = 'a59a6d97-ffaa-470e-8bb7-04cba789f335' and quiet_off_shift;

-- ============================================================================
-- 2. FUNCTIONS (replaced)
-- ============================================================================
-- The defaults for a company with no settings row: Quiet when off shift is now off.
create or replace function public._chat_settings(p_org uuid) returns public.chat_settings
language sql stable security definer set search_path = public, pg_temp as $f$
  select coalesce((select s from public.chat_settings s where s.org_id = p_org),
                  row(p_org, 'managers', 'company', 'standard', true, 2, true, false, now(), null)::public.chat_settings)
$f$;

-- What the app needs to know about the caller, now with the person's own Quiet when off shift.
create or replace function public.chat_whoami(p_member uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  pw record;
  st public.chat_settings;
  ps public.chat_person_state;
begin
  select * into pw from public._chat_power(p_member);
  if pw.org_id is null then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  st := public._chat_settings(pw.org_id);
  select * into ps from public.chat_person_state where member_id = p_member;
  return jsonb_build_object('ok', true, 'member_id', p_member, 'org_id', pw.org_id, 'level', pw.level, 'active', pw.active,
    'manages', to_jsonb(pw.locs), 'venues', to_jsonb(pw.mylocs),
    'privacy_ok', (select privacy_ok_at is not null from public.chat_profiles where id = p_member),
    'my_quiet_off_shift', coalesce((select quiet_off_shift from public.chat_profiles where id = p_member), false),
    'chat_off', coalesce(ps.chat_off, false), 'muted_until', case when ps.muted_until > now() then ps.muted_until end,
    'settings', jsonb_build_object('groups_by', st.groups_by, 'dm_scope', st.dm_scope, 'filter_level', st.filter_level,
      'ai_check', st.ai_check, 'keep_years', st.keep_years, 'sms_backup_urgent', st.sms_backup_urgent, 'quiet_off_shift', st.quiet_off_shift));
end
$f$;

-- Who a new message should reach, and on which phones. The rules (Peter, 26 Oct 2026; 28 Oct):
--   everyone in the chat but the sender, never someone with chat off;
--   a chat they muted stays quiet, except an @mention of them or an urgent announcement;
--   quiet when off shift (the company setting OR the person's own choice, staff only): only urgent
--   announcements and @mentions by a manager or owner come through;
--   an urgent announcement also carries each staff member's mobile, for the text message backup
--   when no push lands (the setting).
-- 20261105a: each phone carries its company and person, for the push log.
create or replace function public.chat_push_targets(p_message bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  msg public.chat_messages;
  c public.chat_conversations;
  st public.chat_settings;
  v_sender_name text;
  v_sender_level text;
  v_urgent boolean;
  v_title text;
begin
  select * into msg from public.chat_messages where id = p_message;
  if not found or msg.deleted_at is not null or msg.status <> 'visible' then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into c from public.chat_conversations where id = msg.conversation_id;
  st := public._chat_settings(msg.org_id);
  select display_name into v_sender_name from public.chat_profiles where id = msg.sender_member_id;
  select level into v_sender_level from public._chat_power(msg.sender_member_id);
  v_urgent := msg.urgent and c.kind = 'announce';
  v_title := case when c.kind = 'dm' then coalesce(v_sender_name, 'New message')
                  when c.kind = 'announce' then coalesce(c.name, 'Announcement')
                  else coalesce(v_sender_name, 'Someone') || ' in ' || coalesce(c.name, 'your group') end;
  return jsonb_build_object('ok', true, 'conversation_id', c.id, 'kind', c.kind, 'urgent', v_urgent,
    'title', case when v_urgent then 'Urgent: ' || v_title else v_title end,
    'body', case when msg.body <> '' then left(msg.body, 200) when jsonb_array_length(msg.photos) > 0 then 'Photo' else '' end,
    'targets', coalesce((select jsonb_agg(t) from (
      select jsonb_build_object('member_id', m.member_id, 'staff_id', p.staff_id,
               'devices', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'platform', d.platform, 'token', d.token,
                   'subscription', d.subscription, 'environment', d.environment, 'app', d.app, 'org_id', d.org_id, 'member_id', d.member_id))
                 from public.push_devices d where d.member_id = m.member_id and d.app <> 'manager'), '[]'::jsonb),
               'sms', case when v_urgent and st.sms_backup_urgent and s.mobile is not null
                           then jsonb_build_object('mobile', s.mobile, 'location_id', s.location_id, 'currency', l.currency) end) as t
        from public.chat_members m
        join public.chat_profiles p on p.id = m.member_id
        left join public.wf_staff s on s.id = p.staff_id
        left join public.locations l on l.id = s.location_id
       where m.conversation_id = c.id and m.left_at is null and m.member_id is distinct from msg.sender_member_id
         and (p.staff_id is null or s.status <> 'leaver')
         and not exists (select 1 from public.chat_person_state ps where ps.member_id = m.member_id and ps.chat_off)
         and (m.muted_until is null or m.muted_until <= now() or m.member_id = any(msg.mentions) or v_urgent)
         and (not (st.quiet_off_shift or p.quiet_off_shift) or p.staff_id is null or v_urgent
              or (m.member_id = any(msg.mentions) and v_sender_level in ('manager', 'owner'))
              or public._chat_on_shift(p.staff_id))
       limit 3000) q), '[]'::jsonb));
end
$f$;

-- The phones of some staff members (rota, swap and open shift messages from staffNotify.ts).
create or replace function public.chat_push_staff_devices(p_staff_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $f$
  select jsonb_build_object('ok', true, 'staff', coalesce((select jsonb_agg(jsonb_build_object('staff_id', p.staff_id,
           'devices', (select jsonb_agg(jsonb_build_object('id', d.id, 'platform', d.platform, 'token', d.token,
                         'subscription', d.subscription, 'environment', d.environment, 'app', d.app, 'org_id', d.org_id, 'member_id', d.member_id)) from public.push_devices d where d.member_id = p.id and d.app <> 'manager')))
    from public.chat_profiles p
   where p.staff_id = any(coalesce(p_staff_ids, '{}'::uuid[]))
     and exists (select 1 from public.push_devices d where d.member_id = p.id and d.app <> 'manager')), '[]'::jsonb))
$f$;

-- My chats, with unread counts, and (20261105a) how many of those are for me: every unread message
-- in a direct message, and unread messages that @mention me elsewhere. Plus my own profile id.
create or replace function public.chat_inbox(p_member uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  pw record;
begin
  select * into pw from public._chat_power(p_member);
  if pw.org_id is null or not pw.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if exists (select 1 from public.chat_person_state ps where ps.member_id = p_member and ps.chat_off) then return jsonb_build_object('ok', false, 'code', 'chat_off'); end if;
  return jsonb_build_object('ok', true, 'member_id', p_member,
    'convs', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('my_role', m.role, 'muted_until', m.muted_until,
                'last_read_message_id', m.last_read_message_id,
                'unread', (select count(*) from public.chat_messages x where x.conversation_id = c.id and x.id > coalesce(m.last_read_message_id, 0)
                             and x.sender_member_id is distinct from p_member),
                'for_you', (select count(*) from public.chat_messages x where x.conversation_id = c.id and x.id > coalesce(m.last_read_message_id, 0)
                             and x.sender_member_id is distinct from p_member and x.deleted_at is null
                             and (c.kind = 'dm' or p_member = any(x.mentions))),
                'last', (select public._chat_message_json(x) from public.chat_messages x where x.conversation_id = c.id order by x.id desc limit 1))
              order by c.last_message_at desc nulls last)
       from public.chat_members m join public.chat_conversations c on c.id = m.conversation_id
      where m.member_id = p_member and m.left_at is null and c.archived_at is null and c.org_id = pw.org_id), '[]'::jsonb),
    'dm_members', coalesce((select jsonb_agg(jsonb_build_object('conversation_id', m2.conversation_id, 'member_id', m2.member_id))
       from public.chat_members m1 join public.chat_conversations c on c.id = m1.conversation_id and c.kind = 'dm'
       join public.chat_members m2 on m2.conversation_id = c.id
      where m1.member_id = p_member and m1.left_at is null), '[]'::jsonb),
    'profiles', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'kind', p.kind) order by p.display_name)
       from (select * from public.chat_profiles where org_id = pw.org_id order by display_name limit 3000) p), '[]'::jsonb));
end
$f$;

-- Nightly clean up. In batches, so one run stays well inside the time limit; the next night continues.
create or replace function public.chat_purge() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  v_msgs int;
  v_log int;
  v_dev int;
begin
  delete from public.chat_messages where id in (
    select m.id from public.chat_messages m left join public.chat_settings s on s.org_id = m.org_id
     where m.created_at < now() - make_interval(years => coalesce(s.keep_years, 2)) limit 5000);
  get diagnostics v_msgs = row_count;
  delete from public.chat_moderation_log where id in (select id from public.chat_moderation_log where at < now() - interval '6 years' limit 5000);
  get diagnostics v_log = row_count;
  delete from public.chat_reports where created_at < now() - interval '6 years';
  delete from public.push_devices where last_seen < now() - interval '180 days';
  get diagnostics v_dev = row_count;
  -- 20261105a: the push log keeps 30 days.
  delete from public.push_log where id in (select id from public.push_log where created_at < now() - interval '30 days' limit 20000);
  return jsonb_build_object('ok', true, 'messages', v_msgs, 'log', v_log, 'devices', v_dev);
end
$f$;

-- ============================================================================
-- 3. FUNCTIONS (new)
-- ============================================================================
-- The staff app, Me: Quiet when off shift for myself.
create function public.chat_me_quiet(p_member uuid, p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  pw record;
begin
  select * into pw from public._chat_power(p_member);
  if pw.org_id is null or not pw.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  update public.chat_profiles set quiet_off_shift = coalesce(p_on, false), updated_at = now() where id = p_member;
  return jsonb_build_object('ok', true, 'my_quiet_off_shift', coalesce(p_on, false));
end
$f$;

-- Team chat, Settings, Notifications (owners and managers): how many phones have notifications on
-- in the company, and the last 20 pushes, sent or failed.
create function public.chat_notify_status(p_member uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  pw record;
begin
  select * into pw from public._chat_power(p_member);
  if pw.org_id is null or not pw.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if pw.level not in ('owner', 'manager') then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  return jsonb_build_object('ok', true,
    'phones', (select count(*) from public.push_devices d where d.org_id = pw.org_id and d.app <> 'manager'),
    'people', (select count(distinct d.member_id) from public.push_devices d where d.org_id = pw.org_id and d.app <> 'manager'),
    'iphones', (select count(*) from public.push_devices d where d.org_id = pw.org_id and d.platform = 'apns' and d.app <> 'manager'),
    'browsers', (select count(*) from public.push_devices d where d.org_id = pw.org_id and d.platform = 'webpush'),
    'pushes', coalesce((select jsonb_agg(jsonb_build_object('at', l.created_at, 'name', coalesce(p.display_name, 'Someone'), 'kind', l.kind,
                 'ok', l.ok, 'status', l.status, 'reason', l.reason) order by l.created_at desc, l.id desc)
       from (select * from public.push_log where org_id = pw.org_id order by created_at desc, id desc limit 20) l
       left join public.chat_profiles p on p.id = l.member_id), '[]'::jsonb));
end
$f$;

-- ============================================================================
-- 4. GRANTS: every chat function, the service role only (bar the three read helpers, unchanged)
-- ============================================================================
do $grants$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p
            where p.pronamespace = 'public'::regnamespace and (p.proname like 'chat\_%' or p.proname like '\_chat\_%')
              and p.proname not in ('chat_my_member_ids', 'chat_my_conversation_ids', 'chat_my_org_ids') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$grants$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: chat_functions 55, open_to_api 3 (the three read helpers, as before),
-- push_log true, push_log_api_can_read false, person_quiet true, company_default_quiet false,
-- posup_test_quiet false (or null when that company has no settings row), quiet_companies = the
-- number of companies that still have Quiet when off shift on (0 unless an owner turned it on).
select
  (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'chat\_%' or p.proname like '\_chat\_%')) as chat_functions,
  (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'chat\_%' or p.proname like '\_chat\_%')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) as open_to_api,
  to_regclass('public.push_log') is not null as push_log,
  (has_table_privilege('anon', 'public.push_log', 'select') or has_table_privilege('authenticated', 'public.push_log', 'select')
    or has_table_privilege('authenticated', 'public.push_log', 'insert')) as push_log_api_can_read,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_profiles' and column_name = 'quiet_off_shift') as person_quiet,
  (public._chat_settings(gen_random_uuid())).quiet_off_shift as company_default_quiet,
  (select quiet_off_shift from public.chat_settings where org_id = 'a59a6d97-ffaa-470e-8bb7-04cba789f335') as posup_test_quiet,
  (select count(*)::int from public.chat_settings where quiet_off_shift) as quiet_companies;
