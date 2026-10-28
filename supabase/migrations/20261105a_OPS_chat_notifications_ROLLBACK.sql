-- 20261105a_OPS_chat_notifications_ROLLBACK.sql
-- Puts the Ops database back as it was before 20261105a_OPS_chat_notifications.sql.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand. One transaction: any error and nothing changes. #
-- #  Lock wait 3 s. Put the edge functions team-chat, staff-portal and        #
-- #  manager-approve back first (5.11.106), then this.                       #
-- ############################################################################
--
-- What it does: the six replaced chat functions go back to their 20261103a text word for word;
-- chat_me_quiet and chat_notify_status are dropped; the push log is dropped (its rows are lost,
-- they are only a 30 day record); each person's own Quiet when off shift is dropped; a new
-- company's Quiet when off shift starts on again. The POSUP Test company keeps it off (the row is
-- not touched; an owner can turn it on in Team chat, Settings).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.push_log') is null then
    raise exception 'Chat notifications (20261105a) is not in this database. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

create or replace function public._chat_settings(p_org uuid) returns public.chat_settings
language sql stable security definer set search_path = public, pg_temp as $f$
  select coalesce((select s from public.chat_settings s where s.org_id = p_org),
                  row(p_org, 'managers', 'company', 'standard', true, 2, true, true, now(), null)::public.chat_settings)
$f$;

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
    'chat_off', coalesce(ps.chat_off, false), 'muted_until', case when ps.muted_until > now() then ps.muted_until end,
    'settings', jsonb_build_object('groups_by', st.groups_by, 'dm_scope', st.dm_scope, 'filter_level', st.filter_level,
      'ai_check', st.ai_check, 'keep_years', st.keep_years, 'sms_backup_urgent', st.sms_backup_urgent, 'quiet_off_shift', st.quiet_off_shift));
end
$f$;

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
                   'subscription', d.subscription, 'environment', d.environment, 'app', d.app))
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
         and (not st.quiet_off_shift or p.staff_id is null or v_urgent
              or (m.member_id = any(msg.mentions) and v_sender_level in ('manager', 'owner'))
              or public._chat_on_shift(p.staff_id))
       limit 3000) q), '[]'::jsonb));
end
$f$;

create or replace function public.chat_push_staff_devices(p_staff_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $f$
  select jsonb_build_object('ok', true, 'staff', coalesce((select jsonb_agg(jsonb_build_object('staff_id', p.staff_id,
           'devices', (select jsonb_agg(jsonb_build_object('id', d.id, 'platform', d.platform, 'token', d.token,
                         'subscription', d.subscription, 'environment', d.environment, 'app', d.app)) from public.push_devices d where d.member_id = p.id and d.app <> 'manager')))
    from public.chat_profiles p
   where p.staff_id = any(coalesce(p_staff_ids, '{}'::uuid[]))
     and exists (select 1 from public.push_devices d where d.member_id = p.id and d.app <> 'manager')), '[]'::jsonb))
$f$;

create or replace function public.chat_inbox(p_member uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  pw record;
begin
  select * into pw from public._chat_power(p_member);
  if pw.org_id is null or not pw.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if exists (select 1 from public.chat_person_state ps where ps.member_id = p_member and ps.chat_off) then return jsonb_build_object('ok', false, 'code', 'chat_off'); end if;
  return jsonb_build_object('ok', true,
    'convs', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('my_role', m.role, 'muted_until', m.muted_until,
                'last_read_message_id', m.last_read_message_id,
                'unread', (select count(*) from public.chat_messages x where x.conversation_id = c.id and x.id > coalesce(m.last_read_message_id, 0)
                             and x.sender_member_id is distinct from p_member),
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
  return jsonb_build_object('ok', true, 'messages', v_msgs, 'log', v_log, 'devices', v_dev);
end
$f$;

drop function if exists public.chat_me_quiet(uuid, boolean);
drop function if exists public.chat_notify_status(uuid);
drop table if exists public.push_log;
alter table public.chat_profiles drop column if exists quiet_off_shift;
alter table public.chat_settings alter column quiet_off_shift set default true;
comment on column public.chat_settings.quiet_off_shift is null;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: chat_functions 53, open_to_api 3, push_log false, person_quiet false,
-- company_default_quiet true.
select
  (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'chat\_%' or p.proname like '\_chat\_%')) as chat_functions,
  (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'chat\_%' or p.proname like '\_chat\_%')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) as open_to_api,
  to_regclass('public.push_log') is not null as push_log,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_profiles' and column_name = 'quiet_off_shift') as person_quiet,
  (public._chat_settings(gen_random_uuid())).quiet_off_shift as company_default_quiet;
