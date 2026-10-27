-- 20261103a_OPS_team_chat.sql
-- Release 5.11.102, ServOS Team Chat.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  One transaction: any error and nothing changes. It refuses a second run. #
-- #  Lock wait 3 s (it gives up, nothing changes). Run after UK close.        #
-- ############################################################################
--
-- WHAT IT ADDS
--   1. Eleven chat tables, every row carrying org_id (the company): chat_settings, chat_word_lists,
--      chat_profiles (who a person is in chat: a staff member or a Back Office login),
--      chat_conversations (dm, group, venue, position, announce), chat_members, chat_messages,
--      chat_reactions, chat_reports, chat_moderation_log (append only, kept 6 years),
--      chat_person_state (muted or chat off), push_devices.
--      Two companies can never meet: every link between chat rows is a foreign key on
--      (id, org_id), so a row of company A cannot point at a row of company B, whoever writes it.
--   2. Reading: only a member of a conversation reads it (row level security). Staff app logins
--      have no Back Office rows; they are matched through wf_staff.portal_user_id inside three
--      SECURITY DEFINER helpers, so no policy reads another table itself. anon reads nothing.
--      The text a person deleted or a manager hid is in columns nobody but the server can read.
--   3. Writing: nobody writes these tables directly. anon and authenticated have no insert,
--      update or delete grant. Every change goes through the team-chat edge function, which
--      calls the chat_* functions below (service role only) and each function checks the rules:
--      the same company, a member, not muted, who may post, who may make groups, who may handle a
--      report (managers for their own venues, owners for every venue, never about themselves),
--      the DM setting, the 15 minute edit window, the typed reason for an owner opening a DM.
--   4. Venue groups: one per venue, everyone working there in it automatically (people at two
--      venues are in both), managers of the venue as its admins. A trigger on wf_staff keeps it
--      right when someone starts, moves or leaves; it never blocks a staff save (a failure is a
--      warning only). Built for every venue now (the backfill), and again on first use.
--   5. Realtime on chat_messages, chat_reactions and chat_members. A private storage bucket
--      chat-photos (the server hands out 1 hour links). A nightly clean up (pg_cron, 03:17 UTC):
--      messages older than the company's setting (2 years unless changed), the moderation log
--      after 6 years, phones not seen for 180 days.
--
-- WHAT IT NEVER DOES
--   It changes no staff, shift, venue or login row. The trigger only writes chat tables.
--
-- ROLLBACK
--   20261103a_OPS_team_chat_ROLLBACK.sql (refuses while chat messages exist and says how many).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.wf_staff') is null or to_regclass('public.locations') is null or to_regclass('public.user_profiles') is null
     or to_regclass('public.staff_members') is null then
    raise exception 'The staff and venue tables are missing. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'wf_staff' and column_name = 'portal_user_id') then
    raise exception 'wf_staff.portal_user_id is missing (the staff app migration 20260806f). Nothing was changed.';
  end if;
  if to_regclass('public.chat_messages') is not null or to_regprocedure('public.chat_send(uuid,uuid,text,jsonb,bigint,boolean,text,uuid[])') is not null then
    raise exception 'Team chat (20261103a) has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ============================================================================
-- 1. TABLES
-- ============================================================================
create table public.chat_settings (
  org_id uuid primary key,
  groups_by text not null default 'managers' check (groups_by in ('managers', 'everyone')),
  dm_scope text not null default 'company' check (dm_scope in ('company', 'venue', 'off')),
  filter_level text not null default 'standard' check (filter_level in ('strict', 'standard', 'custom')),
  ai_check boolean not null default true,
  keep_years integer not null default 2 check (keep_years in (1, 2, 3)),
  sms_backup_urgent boolean not null default true,
  quiet_off_shift boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.chat_settings is 'Team chat settings per company (org_id). No row = the defaults (20261103a).';

create table public.chat_word_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  kind text not null check (kind in ('block', 'allow')),
  phrase text not null check (char_length(phrase) between 1 and 80),
  created_at timestamptz not null default now(),
  created_by uuid
);
create unique index chat_word_lists_one on public.chat_word_lists (org_id, kind, lower(phrase));

create table public.chat_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  kind text not null check (kind in ('staff', 'office')),
  staff_id uuid,
  user_id uuid,
  display_name text not null check (char_length(display_name) between 1 and 80),
  photo text check (photo is null or char_length(photo) <= 300),
  privacy_ok_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (staff_id, org_id) references public.wf_staff (id, org_id) on delete set null (staff_id)
);
create unique index chat_profiles_staff on public.chat_profiles (org_id, staff_id) where staff_id is not null;
create unique index chat_profiles_user on public.chat_profiles (org_id, user_id) where user_id is not null;
create index chat_profiles_user_any on public.chat_profiles (user_id) where user_id is not null;
comment on table public.chat_profiles is 'Who a person is in team chat: a staff member (staff_id) or a Back Office login (user_id), in one company (20261103a).';

create table public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  kind text not null check (kind in ('dm', 'group', 'venue', 'position', 'announce')),
  name text check (name is null or char_length(name) <= 80),
  description text check (description is null or char_length(description) <= 500),
  photo text check (photo is null or char_length(photo) <= 300),
  location_id uuid,
  role_key text,
  post_policy text not null default 'everyone' check (post_policy in ('everyone', 'admins')),
  dm_key text,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz,
  unique (id, org_id),
  foreign key (created_by, org_id) references public.chat_profiles (id, org_id) on delete set null (created_by),
  foreign key (location_id, org_id) references public.locations (id, org_id) on delete cascade,
  check (kind <> 'venue' or location_id is not null),
  check (kind <> 'position' or role_key is not null),
  check ((kind = 'dm') = (dm_key is not null))
);
create unique index chat_conversations_dm on public.chat_conversations (org_id, dm_key) where kind = 'dm';
create unique index chat_conversations_venue on public.chat_conversations (org_id, location_id) where kind = 'venue';
create index chat_conversations_org_kind on public.chat_conversations (org_id, kind);

create table public.chat_members (
  conversation_id uuid not null,
  member_id uuid not null,
  org_id uuid not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  auto boolean not null default false,
  muted_until timestamptz,
  left_at timestamptz,
  left_reason text check (left_reason is null or left_reason in ('left', 'removed', 'auto', 'offboarded')),
  last_read_message_id bigint,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, member_id),
  foreign key (conversation_id, org_id) references public.chat_conversations (id, org_id) on delete cascade,
  foreign key (member_id, org_id) references public.chat_profiles (id, org_id) on delete cascade
);
create index chat_members_member on public.chat_members (member_id) where left_at is null;
comment on column public.chat_members.auto is 'Added by the automatic membership (venue, position and announcement groups); the sync keeps it right (20261103a).';

create table public.chat_messages (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  conversation_id uuid not null,
  sender_member_id uuid,
  body text not null default '' check (char_length(body) <= 4000),
  photos jsonb not null default '[]'::jsonb check (jsonb_typeof(photos) = 'array'),
  reply_to bigint,
  status text not null default 'visible' check (status in ('visible', 'hidden')),
  edited_at timestamptz,
  original_body text,
  deleted_at timestamptz,
  removed_body text,
  removed_photos jsonb,
  urgent boolean not null default false,
  mentions uuid[] not null default '{}',
  client_id text check (client_id is null or char_length(client_id) <= 64),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (conversation_id, org_id) references public.chat_conversations (id, org_id) on delete cascade,
  foreign key (sender_member_id, org_id) references public.chat_profiles (id, org_id) on delete set null (sender_member_id),
  foreign key (reply_to) references public.chat_messages (id) on delete set null
);
create index chat_messages_conv_time on public.chat_messages (conversation_id, created_at desc, id desc);
create index chat_messages_sender_time on public.chat_messages (sender_member_id, created_at desc);
create unique index chat_messages_client on public.chat_messages (sender_member_id, client_id) where client_id is not null;
create index chat_messages_org_time on public.chat_messages (org_id, created_at);
comment on column public.chat_messages.original_body is 'The text before the first edit. Server only (no grant) (20261103a).';
comment on column public.chat_messages.removed_body is 'The text when the sender deleted it or a manager hid it; body is then empty. Server only (20261103a).';

create table public.chat_reactions (
  message_id bigint not null,
  member_id uuid not null,
  emoji text not null check (char_length(emoji) between 1 and 16),
  org_id uuid not null,
  conversation_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (message_id, member_id, emoji),
  foreign key (message_id, org_id) references public.chat_messages (id, org_id) on delete cascade,
  foreign key (member_id, org_id) references public.chat_profiles (id, org_id) on delete cascade,
  foreign key (conversation_id, org_id) references public.chat_conversations (id, org_id) on delete cascade
);
create index chat_reactions_conv on public.chat_reactions (conversation_id);

create table public.chat_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  message_id bigint,
  conversation_id uuid,
  reporter_member_id uuid,
  offender_member_id uuid,
  reason text check (reason is null or char_length(reason) <= 500),
  source text not null default 'person' check (source in ('person', 'ai')),
  ai_label text check (ai_label is null or char_length(ai_label) <= 40),
  message_snapshot jsonb,
  status text not null default 'open' check (status in ('open', 'kept', 'hidden')),
  handled_by uuid,
  handled_at timestamptz,
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  foreign key (message_id, org_id) references public.chat_messages (id, org_id) on delete set null (message_id),
  foreign key (conversation_id, org_id) references public.chat_conversations (id, org_id) on delete set null (conversation_id)
);
create unique index chat_reports_one_person on public.chat_reports (message_id, reporter_member_id) where reporter_member_id is not null;
create unique index chat_reports_one_ai on public.chat_reports (message_id) where source = 'ai';
create index chat_reports_org_status on public.chat_reports (org_id, status, created_at desc);

create table public.chat_moderation_log (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  at timestamptz not null default now(),
  actor_member_id uuid,
  actor_name text,
  action text not null,
  conversation_id uuid,
  message_id bigint,
  target_member_id uuid,
  report_id uuid,
  reason text,
  detail jsonb not null default '{}'::jsonb
);
create index chat_moderation_log_org_at on public.chat_moderation_log (org_id, at desc);
comment on table public.chat_moderation_log is 'Append only. Kept 6 years, then the nightly clean up removes it (20261103a).';

create table public.chat_person_state (
  member_id uuid primary key,
  org_id uuid not null,
  muted_until timestamptz,
  chat_off boolean not null default false,
  reason text check (reason is null or char_length(reason) <= 500),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  foreign key (member_id, org_id) references public.chat_profiles (id, org_id) on delete cascade
);

create table public.push_devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  member_id uuid not null,
  platform text not null check (platform in ('apns', 'webpush')),
  token text not null check (char_length(token) between 8 and 1000),
  subscription jsonb,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (platform, token),
  foreign key (member_id, org_id) references public.chat_profiles (id, org_id) on delete cascade
);
create index push_devices_member on public.push_devices (member_id);

-- The moderation log is append only.
create function public._chat_log_append_only() returns trigger language plpgsql set search_path = public, pg_temp as $f$
begin
  if tg_op = 'DELETE' and old.at < now() - interval '6 years' then return old; end if;
  raise exception using errcode = '42501', message = 'chat_moderation_log is append only';
end
$f$;
create trigger chat_moderation_log_append_only before update or delete on public.chat_moderation_log
  for each row execute function public._chat_log_append_only();

-- ============================================================================
-- 2. WHO IS WHO
-- ============================================================================

-- The power of one chat profile, read from the database (never from the caller):
--   level   staff | manager | owner   (owner = an owner or Admin of the company, every venue)
--   locs    the venues a manager handles (null for an owner: all)
--   mylocs  the venues the person works at (staff: location + venue_ids; Back Office: user_locations)
--   active  false for a leaver, or a Back Office profile with no reach left in the company
-- ServOS staff (super admin) get no special power in chat (DMs are private).
create function public._chat_power(p_member uuid, out org_id uuid, out level text, out locs uuid[], out mylocs uuid[], out uid uuid, out active boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  p public.chat_profiles;
  s public.wf_staff;
  v_owner boolean;
begin
  select * into p from public.chat_profiles where id = p_member;
  if not found then return; end if;
  org_id := p.org_id; level := 'staff'; locs := '{}'; mylocs := '{}'; active := true;
  if p.staff_id is not null then
    select * into s from public.wf_staff where id = p.staff_id;
    if not found or s.status = 'leaver' then
      active := false;
      return;
    end if;
    uid := s.portal_user_id;
    mylocs := array(select distinct x from unnest(array[s.location_id] || coalesce(s.venue_ids, '{}'::uuid[])) x where x is not null);
  elsif p.user_id is not null then
    uid := p.user_id;
  else
    active := false;
    return;
  end if;
  if uid is not null then
    v_owner := exists (select 1 from public.user_profiles up where up.id = uid and up.org_id = p.org_id and lower(coalesce(up.role, '')) in ('owner', 'admin'))
      or exists (select 1 from public.user_locations ul join public.locations l on l.id = ul.location_id
                  where ul.user_id = uid and l.org_id = p.org_id and lower(ul.role) in ('owner', 'admin'));
    if v_owner then
      level := 'owner'; locs := null;
    else
      locs := array(select distinct ul.location_id from public.user_locations ul join public.locations l on l.id = ul.location_id
                     where ul.user_id = uid and l.org_id = p.org_id and lower(ul.role) = 'manager');
      if cardinality(locs) > 0 then level := 'manager'; end if;
    end if;
    mylocs := array(select distinct x from unnest(mylocs || array(
                select ul.location_id from public.user_locations ul join public.locations l on l.id = ul.location_id
                 where ul.user_id = uid and l.org_id = p.org_id)) x where x is not null);
  end if;
  -- A manager on the till (staff_members, linked through wf_staff.pos_user_id: the Manager app's PIN)
  -- is a manager of that venue even with no Back Office login.
  if level = 'staff' and s.pos_user_id is not null then
    locs := array(select distinct sm.location_id from public.staff_members sm join public.locations l on l.id = sm.location_id
                   where sm.id = s.pos_user_id and coalesce(sm.active, true) and l.org_id = p.org_id
                     and (lower(coalesce(sm.role, '')) in ('manager', 'owner') or coalesce(sm.permissions, '[]'::jsonb) ? 'manager_approvals'));
    if cardinality(locs) > 0 then level := 'manager'; else locs := '{}'; end if;
  end if;
  if p.staff_id is null and level = 'staff' and cardinality(mylocs) = 0 then active := false; end if;
end
$f$;

-- RLS helpers. The only place a policy looks at another table. auth.uid() is the caller.
create function public.chat_my_member_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $f$
  select p.id from public.chat_profiles p
   where auth.uid() is not null
     and (
       p.staff_id in (select s.id from public.wf_staff s where s.portal_user_id = auth.uid() and s.status <> 'leaver')
       or (p.user_id = auth.uid()
           and (exists (select 1 from public.user_locations ul join public.locations l on l.id = ul.location_id
                         where ul.user_id = auth.uid() and l.org_id = p.org_id)
                or exists (select 1 from public.user_profiles up where up.id = auth.uid() and up.org_id = p.org_id)))
     )
     and not exists (select 1 from public.chat_person_state ps where ps.member_id = p.id and ps.chat_off)
$f$;

create function public.chat_my_conversation_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $f$
  select m.conversation_id from public.chat_members m
   where m.left_at is null and m.member_id in (select public.chat_my_member_ids())
$f$;

create function public.chat_my_org_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $f$
  select distinct p.org_id from public.chat_profiles p where p.id in (select public.chat_my_member_ids())
$f$;

-- One line in the moderation log.
create function public._chat_log(p_org uuid, p_actor uuid, p_action text, p_conversation uuid, p_message bigint,
  p_target uuid, p_report uuid, p_reason text, p_detail jsonb)
returns void language sql volatile security definer set search_path = public, pg_temp as $f$
  insert into public.chat_moderation_log (org_id, actor_member_id, actor_name, action, conversation_id, message_id, target_member_id, report_id, reason, detail)
  values (p_org, p_actor, (select display_name from public.chat_profiles where id = p_actor), p_action, p_conversation, p_message,
          p_target, p_report, left(p_reason, 500), coalesce(p_detail, '{}'::jsonb))
$f$;

create function public._chat_settings(p_org uuid) returns public.chat_settings
language sql stable security definer set search_path = public, pg_temp as $f$
  select coalesce((select s from public.chat_settings s where s.org_id = p_org),
                  row(p_org, 'managers', 'company', 'standard', true, 2, true, true, now(), null)::public.chat_settings)
$f$;

-- May this actor handle something about this person (a report, a mute, chat off)? null = yes, else a code.
create function public._chat_can_moderate(p_actor uuid, p_offender uuid, p_conv_location uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  a record;
  o record;
begin
  select * into a from public._chat_power(p_actor);
  if a.org_id is null or not a.active then return 'no_member'; end if;
  if a.level = 'staff' then return 'not_allowed'; end if;
  if p_offender is not null and p_offender = p_actor then return 'own_report'; end if;
  if p_offender is not null then
    select * into o from public._chat_power(p_offender);
    if o.org_id is distinct from a.org_id then return 'not_found'; end if;
    if a.level = 'owner' then return null; end if;
    if o.level = 'owner' then return 'not_allowed'; end if;
    if o.mylocs && a.locs then return null; end if;
  elsif a.level = 'owner' then
    return null;
  end if;
  if p_conv_location is not null and p_conv_location = any(a.locs) then return null; end if;
  return 'not_allowed';
end
$f$;

-- ============================================================================
-- 3. AUTOMATIC MEMBERSHIP
-- ============================================================================

-- Venue groups for every venue of the company, staff profiles for everyone working there, and the
-- members of every venue, position and announcement group as they should be: staff at the venue (or
-- in the position), managers of the venue as admins. p_staff limits it to one person (the trigger).
-- Someone a manager removed stays removed; someone who left a venue automatically comes back if they
-- return. Leavers leave every conversation.
create function public.chat_sync_org(p_org uuid, p_staff uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  v_groups int := 0;
  v_joined int := 0;
  v_left int := 0;
  v_off int := 0;
begin
  if p_org is null then return jsonb_build_object('ok', false, 'code', 'no_org'); end if;
  if p_staff is null then
    insert into public.chat_conversations (org_id, kind, name, location_id, post_policy)
    select l.org_id, 'venue', left(coalesce(nullif(trim(l.name), ''), 'Venue'), 80), l.id, 'everyone'
      from public.locations l where l.org_id = p_org
    on conflict (org_id, location_id) where kind = 'venue' do nothing;
    get diagnostics v_groups = row_count;
  else
    insert into public.chat_conversations (org_id, kind, name, location_id, post_policy)
    select l.org_id, 'venue', left(coalesce(nullif(trim(l.name), ''), 'Venue'), 80), l.id, 'everyone'
      from public.wf_staff s join public.locations l on l.org_id = s.org_id and (l.id = s.location_id or l.id = any(s.venue_ids))
     where s.id = p_staff and s.org_id = p_org
    on conflict (org_id, location_id) where kind = 'venue' do nothing;
    get diagnostics v_groups = row_count;
  end if;

  insert into public.chat_profiles (org_id, kind, staff_id, display_name)
  select s.org_id, 'staff', s.id, left(coalesce(nullif(trim(s.name), ''), 'Team member'), 80)
    from public.wf_staff s where s.org_id = p_org and s.status <> 'leaver' and (p_staff is null or s.id = p_staff)
  on conflict (org_id, staff_id) where staff_id is not null do nothing;
  update public.chat_profiles p set display_name = left(coalesce(nullif(trim(s.name), ''), 'Team member'), 80), updated_at = now()
    from public.wf_staff s
   where p.staff_id = s.id and p.org_id = p_org and (p_staff is null or s.id = p_staff)
     and p.display_name is distinct from left(coalesce(nullif(trim(s.name), ''), 'Team member'), 80);

  with want0 as (
    select c.id as conversation_id, p.id as member_id, 'member'::text as role
      from public.wf_staff s
      join public.chat_profiles p on p.org_id = s.org_id and p.staff_id = s.id
      join public.chat_conversations c on c.org_id = s.org_id and c.archived_at is null and (
             (c.kind = 'venue' and (c.location_id = s.location_id or c.location_id = any(s.venue_ids)))
          or (c.kind = 'announce' and (c.location_id is null or c.location_id = s.location_id or c.location_id = any(s.venue_ids)))
          or (c.kind = 'position' and c.role_key = s.role_key and (c.location_id is null or c.location_id = s.location_id or c.location_id = any(s.venue_ids))))
     where s.org_id = p_org and s.status <> 'leaver' and (p_staff is null or s.id = p_staff)
    union all
    select c.id, p.id, 'admin'
      from public.user_locations ul
      join public.chat_conversations c on c.org_id = p_org and c.kind in ('venue', 'announce') and c.location_id = ul.location_id and c.archived_at is null
      join public.chat_profiles p on p.org_id = p_org and (p.user_id = ul.user_id or p.staff_id in (
             select s2.id from public.wf_staff s2 where s2.org_id = p_org and s2.portal_user_id = ul.user_id and s2.status <> 'leaver'))
     where lower(ul.role) in ('owner', 'admin', 'manager')
       and (p_staff is null or p.staff_id = p_staff)
  ), want as (
    select conversation_id, member_id, min(role) as role from want0 group by 1, 2
  ), ins as (
    insert into public.chat_members (conversation_id, member_id, org_id, role, auto)
    select w.conversation_id, w.member_id, p_org, w.role, true from want w
    on conflict (conversation_id, member_id) do update
      set left_at = case when chat_members.left_reason = 'auto' then null else chat_members.left_at end,
          left_reason = case when chat_members.left_reason = 'auto' then null else chat_members.left_reason end,
          role = case when chat_members.auto then excluded.role else chat_members.role end
      where chat_members.left_reason = 'auto' or (chat_members.auto and chat_members.left_at is null and chat_members.role is distinct from excluded.role)
    returning 1
  ), gone as (
    update public.chat_members m set left_at = now(), left_reason = 'auto'
      from public.chat_conversations c, public.chat_profiles p
     where c.id = m.conversation_id and p.id = m.member_id and c.org_id = p_org and m.org_id = p_org
       and c.kind in ('venue', 'announce', 'position') and m.auto and m.left_at is null
       and (p_staff is null or p.staff_id = p_staff)
       and not exists (select 1 from want w where w.conversation_id = m.conversation_id and w.member_id = m.member_id)
    returning 1
  )
  select (select count(*) from ins), (select count(*) from gone) into v_joined, v_left;

  -- Leavers leave every conversation (their DMs and groups too).
  update public.chat_members m set left_at = now(), left_reason = 'offboarded'
    from public.chat_profiles p join public.wf_staff s on s.id = p.staff_id
   where p.id = m.member_id and m.org_id = p_org and p.org_id = p_org and s.status = 'leaver' and m.left_at is null
     and (p_staff is null or s.id = p_staff);
  get diagnostics v_off = row_count;

  return jsonb_build_object('ok', true, 'groups', v_groups, 'joined', v_joined, 'left', v_left, 'offboarded', v_off);
end
$f$;

-- The wf_staff trigger: someone starts, moves, is renamed or leaves. Never blocks the staff save.
create function public._chat_staff_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  begin
    perform public.chat_sync_org(new.org_id, new.id);
  exception when others then
    raise warning 'team chat sync skipped for staff %: %', new.id, sqlerrm;
  end;
  return null;
end
$f$;
create trigger trg_wf_staff_chat_sync after insert or update of status, location_id, venue_ids, name, role_key, portal_user_id
  on public.wf_staff for each row execute function public._chat_staff_changed();

-- The chat profile of a caller the edge function has proved: a staff member (p_staff) or a Back
-- Office login (p_user) with reach in this company. Returns { ok, member_id, created }.
create function public.chat_profile_for(p_org uuid, p_staff uuid, p_user uuid, p_name text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  v_id uuid;
  v_name text;
  v_created boolean := false;
begin
  if p_staff is not null then
    select left(coalesce(nullif(trim(s.name), ''), 'Team member'), 80) into v_name
      from public.wf_staff s where s.id = p_staff and s.org_id = p_org and s.status <> 'leaver';
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    select id into v_id from public.chat_profiles where org_id = p_org and staff_id = p_staff;
    if v_id is null then
      insert into public.chat_profiles (org_id, kind, staff_id, display_name) values (p_org, 'staff', p_staff, v_name)
      on conflict (org_id, staff_id) where staff_id is not null do nothing returning id into v_id;
      v_created := v_id is not null;
      if v_id is null then select id into v_id from public.chat_profiles where org_id = p_org and staff_id = p_staff; end if;
    end if;
  elsif p_user is not null then
    if not (exists (select 1 from public.user_locations ul join public.locations l on l.id = ul.location_id where ul.user_id = p_user and l.org_id = p_org)
            or exists (select 1 from public.user_profiles up where up.id = p_user and up.org_id = p_org)) then
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
    v_name := left(coalesce(nullif(trim(p_name), ''), 'Manager'), 80);
    select id into v_id from public.chat_profiles where org_id = p_org and user_id = p_user;
    if v_id is null then
      insert into public.chat_profiles (org_id, kind, user_id, display_name) values (p_org, 'office', p_user, v_name)
      on conflict (org_id, user_id) where user_id is not null do nothing returning id into v_id;
      v_created := v_id is not null;
      if v_id is null then select id into v_id from public.chat_profiles where org_id = p_org and user_id = p_user; end if;
    end if;
  else
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'member_id', v_id, 'created', v_created);
end
$f$;

-- What the app needs to know about the caller.
create function public.chat_whoami(p_member uuid) returns jsonb
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

create function public.chat_privacy_ok(p_member uuid) returns jsonb
language sql volatile security definer set search_path = public, pg_temp as $f$
  update public.chat_profiles set privacy_ok_at = coalesce(privacy_ok_at, now()) where id = p_member returning jsonb_build_object('ok', true)
$f$;

-- ============================================================================
-- 4. MESSAGES
-- ============================================================================

-- The common gate for a person acting in a conversation: same company, active, member, not chat off.
-- Returns null when fine, else a code. Fills c and m.
create function public._chat_gate(p_member uuid, p_conversation uuid, out code text, out c public.chat_conversations, out m public.chat_members, out pw_level text, out pw_org uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  pw record;
begin
  select * into pw from public._chat_power(p_member);
  if pw.org_id is null or not pw.active then code := 'no_member'; return; end if;
  pw_level := pw.level; pw_org := pw.org_id;
  select * into c from public.chat_conversations where id = p_conversation and org_id = pw.org_id;
  if not found then code := 'not_found'; return; end if;
  select * into m from public.chat_members where conversation_id = c.id and member_id = p_member;
  if not found or m.left_at is not null then code := 'not_member'; return; end if;
  if exists (select 1 from public.chat_person_state ps where ps.member_id = p_member and ps.chat_off) then code := 'chat_off'; return; end if;
end
$f$;

create function public._chat_message_json(p public.chat_messages) returns jsonb
language sql immutable set search_path = public, pg_temp as $f$
  select to_jsonb(p) - 'original_body' - 'removed_body' - 'removed_photos'
$f$;

-- Send. p_photos: [{ path, w, h, caption }] already uploaded under <org>/<conversation>/.
-- p_client_id makes a retry safe: the same id from the same person returns the first message.
create function public.chat_send(p_member uuid, p_conversation uuid, p_body text, p_photos jsonb, p_reply_to bigint,
  p_urgent boolean, p_client_id text, p_mentions uuid[])
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  g record;
  msg public.chat_messages;
  v_body text := btrim(coalesce(p_body, ''));
  v_photos jsonb := coalesce(p_photos, '[]'::jsonb);
  v_mentions uuid[];
  v_until timestamptz;
begin
  select * into g from public._chat_gate(p_member, p_conversation);
  if g.code is not null then return jsonb_build_object('ok', false, 'code', g.code); end if;
  if (g.c).archived_at is not null then return jsonb_build_object('ok', false, 'code', 'archived'); end if;
  select muted_until into v_until from public.chat_person_state where member_id = p_member;
  if v_until > now() then return jsonb_build_object('ok', false, 'code', 'muted', 'until', v_until); end if;
  if ((g.c).post_policy = 'admins' or (g.c).kind = 'announce') and (g.m).role <> 'admin' and g.pw_level <> 'owner' then
    return jsonb_build_object('ok', false, 'code', 'admins_only');
  end if;
  if coalesce(p_urgent, false) and ((g.c).kind <> 'announce' or ((g.m).role <> 'admin' and g.pw_level <> 'owner')) then
    return jsonb_build_object('ok', false, 'code', 'urgent_not_allowed');
  end if;
  if jsonb_typeof(v_photos) <> 'array' or jsonb_array_length(v_photos) > 10 then
    return jsonb_build_object('ok', false, 'code', 'bad_photos');
  end if;
  if exists (select 1 from jsonb_array_elements(v_photos) x
              where jsonb_typeof(x) <> 'object' or coalesce(x->>'path', '') not like (g.pw_org::text || '/' || p_conversation::text || '/%')
                 or x->>'path' like '%..%' or char_length(coalesce(x->>'caption', '')) > 300) then
    return jsonb_build_object('ok', false, 'code', 'bad_photos');
  end if;
  if v_body = '' and jsonb_array_length(v_photos) = 0 then return jsonb_build_object('ok', false, 'code', 'empty'); end if;
  if char_length(v_body) > 4000 then return jsonb_build_object('ok', false, 'code', 'too_long'); end if;
  if p_client_id is not null then
    select * into msg from public.chat_messages where sender_member_id = p_member and client_id = p_client_id;
    if found then return jsonb_build_object('ok', true, 'duplicate', true, 'message', public._chat_message_json(msg)); end if;
  end if;
  if p_reply_to is not null and not exists (select 1 from public.chat_messages where id = p_reply_to and conversation_id = p_conversation) then
    return jsonb_build_object('ok', false, 'code', 'bad_reply');
  end if;
  if (select count(*) from public.chat_messages where sender_member_id = p_member and created_at > now() - interval '10 seconds') >= 20 then
    return jsonb_build_object('ok', false, 'code', 'too_fast');
  end if;
  v_mentions := array(select distinct cm.member_id from public.chat_members cm
                       where cm.conversation_id = p_conversation and cm.left_at is null and cm.member_id = any(coalesce(p_mentions, '{}'::uuid[]))
                         and cm.member_id <> p_member);
  begin
    insert into public.chat_messages (org_id, conversation_id, sender_member_id, body, photos, reply_to, urgent, mentions, client_id)
    values (g.pw_org, p_conversation, p_member, v_body, v_photos, p_reply_to, coalesce(p_urgent, false), v_mentions, p_client_id)
    returning * into msg;
  exception when unique_violation then
    select * into msg from public.chat_messages where sender_member_id = p_member and client_id = p_client_id;
    return jsonb_build_object('ok', true, 'duplicate', true, 'message', public._chat_message_json(msg));
  end;
  update public.chat_conversations set last_message_at = msg.created_at where id = p_conversation
    and (last_message_at is null or last_message_at < msg.created_at);
  update public.chat_members set last_read_message_id = greatest(coalesce(last_read_message_id, 0), msg.id)
   where conversation_id = p_conversation and member_id = p_member;
  -- A DM the other person had closed opens again for them.
  if (g.c).kind = 'dm' then
    update public.chat_members set left_at = null, left_reason = null
     where conversation_id = p_conversation and left_reason = 'left';
  end if;
  return jsonb_build_object('ok', true, 'message', public._chat_message_json(msg), 'kind', (g.c).kind);
end
$f$;

-- Edit: the sender, within 15 minutes, while it is visible.
create function public.chat_edit(p_member uuid, p_message bigint, p_body text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  msg public.chat_messages;
  g record;
  v_body text := btrim(coalesce(p_body, ''));
begin
  select * into msg from public.chat_messages where id = p_message for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into g from public._chat_gate(p_member, msg.conversation_id);
  if g.code is not null then return jsonb_build_object('ok', false, 'code', g.code); end if;
  if msg.sender_member_id is distinct from p_member then return jsonb_build_object('ok', false, 'code', 'not_yours'); end if;
  if msg.deleted_at is not null or msg.status <> 'visible' then return jsonb_build_object('ok', false, 'code', 'gone'); end if;
  if msg.created_at < now() - interval '15 minutes' then return jsonb_build_object('ok', false, 'code', 'too_late'); end if;
  if v_body = '' and jsonb_array_length(msg.photos) = 0 then return jsonb_build_object('ok', false, 'code', 'empty'); end if;
  if char_length(v_body) > 4000 then return jsonb_build_object('ok', false, 'code', 'too_long'); end if;
  update public.chat_messages set original_body = coalesce(original_body, body), body = v_body, edited_at = now()
   where id = p_message returning * into msg;
  return jsonb_build_object('ok', true, 'message', public._chat_message_json(msg));
end
$f$;

-- Delete: the sender, any time. The text is kept for the server only (reports, the law), body empties.
create function public.chat_delete(p_member uuid, p_message bigint) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  msg public.chat_messages;
  pw record;
begin
  select * into pw from public._chat_power(p_member);
  if pw.org_id is null or not pw.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  select * into msg from public.chat_messages where id = p_message and org_id = pw.org_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if msg.sender_member_id is distinct from p_member then return jsonb_build_object('ok', false, 'code', 'not_yours'); end if;
  if msg.deleted_at is not null then return jsonb_build_object('ok', true, 'message', public._chat_message_json(msg)); end if;
  update public.chat_messages
     set deleted_at = now(), removed_body = coalesce(removed_body, body), removed_photos = coalesce(removed_photos, photos),
         body = '', photos = '[]'::jsonb
   where id = p_message returning * into msg;
  return jsonb_build_object('ok', true, 'message', public._chat_message_json(msg));
end
$f$;

create function public.chat_react(p_member uuid, p_message bigint, p_emoji text, p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  msg public.chat_messages;
  g record;
  v_emoji text := btrim(coalesce(p_emoji, ''));
begin
  if char_length(v_emoji) not between 1 and 16 or v_emoji ~ '\s' then return jsonb_build_object('ok', false, 'code', 'bad_emoji'); end if;
  select * into msg from public.chat_messages where id = p_message;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into g from public._chat_gate(p_member, msg.conversation_id);
  if g.code is not null then return jsonb_build_object('ok', false, 'code', g.code); end if;
  if coalesce(p_on, true) then
    if msg.deleted_at is not null or msg.status <> 'visible' then return jsonb_build_object('ok', false, 'code', 'gone'); end if;
    if (select count(*) from public.chat_reactions where message_id = p_message and member_id = p_member) >= 8 then
      return jsonb_build_object('ok', false, 'code', 'too_many');
    end if;
    insert into public.chat_reactions (message_id, member_id, emoji, org_id, conversation_id)
    values (p_message, p_member, v_emoji, msg.org_id, msg.conversation_id) on conflict do nothing;
  else
    delete from public.chat_reactions where message_id = p_message and member_id = p_member and emoji = v_emoji;
  end if;
  return jsonb_build_object('ok', true);
end
$f$;

create function public.chat_read(p_member uuid, p_conversation uuid, p_message bigint) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  g record;
begin
  select * into g from public._chat_gate(p_member, p_conversation);
  if g.code is not null and g.code <> 'chat_off' then return jsonb_build_object('ok', false, 'code', g.code); end if;
  if not exists (select 1 from public.chat_messages where id = p_message and conversation_id = p_conversation) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  update public.chat_members set last_read_message_id = greatest(coalesce(last_read_message_id, 0), p_message)
   where conversation_id = p_conversation and member_id = p_member;
  return jsonb_build_object('ok', true);
end
$f$;

-- ============================================================================
-- 5. CONVERSATIONS AND MEMBERS
-- ============================================================================

-- A DM with one colleague (one per pair). The company setting decides who may: company (anyone in
-- the company), venue (people who share a venue), off (nobody). Managers and owners may always.
create function public.chat_dm_open(p_member uuid, p_other uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
  o record;
  st public.chat_settings;
  v_key text;
  v_id uuid;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if exists (select 1 from public.chat_person_state ps where ps.member_id = p_member and ps.chat_off) then return jsonb_build_object('ok', false, 'code', 'chat_off'); end if;
  if p_other is null or p_other = p_member then return jsonb_build_object('ok', false, 'code', 'bad_member'); end if;
  select * into o from public._chat_power(p_other);
  if o.org_id is distinct from a.org_id then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if not o.active or exists (select 1 from public.chat_person_state ps where ps.member_id = p_other and ps.chat_off) then
    return jsonb_build_object('ok', false, 'code', 'unavailable');
  end if;
  st := public._chat_settings(a.org_id);
  if a.level = 'staff' then
    if st.dm_scope = 'off' then return jsonb_build_object('ok', false, 'code', 'dm_off'); end if;
    if st.dm_scope = 'venue' and not (a.mylocs && o.mylocs) and o.level = 'staff' then
      return jsonb_build_object('ok', false, 'code', 'dm_scope');
    end if;
  end if;
  v_key := least(p_member::text, p_other::text) || ':' || greatest(p_member::text, p_other::text);
  insert into public.chat_conversations (org_id, kind, dm_key, created_by) values (a.org_id, 'dm', v_key, p_member)
  on conflict (org_id, dm_key) where kind = 'dm' do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.chat_conversations where org_id = a.org_id and kind = 'dm' and dm_key = v_key; end if;
  insert into public.chat_members (conversation_id, member_id, org_id, role) values (v_id, p_member, a.org_id, 'member'), (v_id, p_other, a.org_id, 'member')
  on conflict (conversation_id, member_id) do nothing;
  update public.chat_members set left_at = null, left_reason = null where conversation_id = v_id and member_id = p_member and left_reason = 'left';
  return jsonb_build_object('ok', true, 'conversation_id', v_id);
end
$f$;

-- Make a group. kind group: managers (or everyone, by the setting), members chosen. kind position:
-- everyone in a position (at one venue, or the company for an owner). kind announce: everyone at a
-- venue (or the company), only admins post. A manager makes position and announcement groups for
-- their own venues; only an owner makes company wide ones. Venue groups and DMs are not made here.
create function public.chat_group_create(p_member uuid, p_kind text, p_name text, p_description text, p_location uuid,
  p_role_key text, p_post_policy text, p_members uuid[])
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
  st public.chat_settings;
  v_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_policy text := coalesce(p_post_policy, 'everyone');
  v_members uuid[] := coalesce(p_members, '{}'::uuid[]);
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if exists (select 1 from public.chat_person_state ps where ps.member_id = p_member and ps.chat_off) then return jsonb_build_object('ok', false, 'code', 'chat_off'); end if;
  if p_kind not in ('group', 'position', 'announce') then return jsonb_build_object('ok', false, 'code', 'bad_kind'); end if;
  if char_length(v_name) not between 1 and 80 then return jsonb_build_object('ok', false, 'code', 'bad_name'); end if;
  if char_length(coalesce(p_description, '')) > 500 then return jsonb_build_object('ok', false, 'code', 'too_long'); end if;
  if v_policy not in ('everyone', 'admins') then return jsonb_build_object('ok', false, 'code', 'bad_policy'); end if;
  if cardinality(v_members) > 500 then return jsonb_build_object('ok', false, 'code', 'too_many'); end if;
  if p_location is not null and not exists (select 1 from public.locations where id = p_location and org_id = a.org_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if exists (select 1 from unnest(v_members) x where not exists (select 1 from public.chat_profiles p where p.id = x and p.org_id = a.org_id)) then
    return jsonb_build_object('ok', false, 'code', 'cross_company');
  end if;
  st := public._chat_settings(a.org_id);
  if p_kind = 'group' then
    if a.level = 'staff' and st.groups_by <> 'everyone' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  else
    if a.level = 'staff' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
    if a.level = 'manager' and (p_location is null or not (p_location = any(a.locs))) then
      return jsonb_build_object('ok', false, 'code', 'not_allowed');
    end if;
    if p_kind = 'position' and nullif(btrim(coalesce(p_role_key, '')), '') is null then return jsonb_build_object('ok', false, 'code', 'bad_role'); end if;
    if p_kind = 'announce' then v_policy := 'admins'; end if;
  end if;
  insert into public.chat_conversations (org_id, kind, name, description, location_id, role_key, post_policy, created_by)
  values (a.org_id, p_kind, v_name, nullif(btrim(coalesce(p_description, '')), ''), p_location,
          case when p_kind = 'position' then btrim(p_role_key) end, v_policy, p_member)
  returning id into v_id;
  insert into public.chat_members (conversation_id, member_id, org_id, role) values (v_id, p_member, a.org_id, 'admin');
  if p_kind = 'group' then
    insert into public.chat_members (conversation_id, member_id, org_id, role)
    select v_id, x, a.org_id, 'member' from (select distinct unnest(v_members) as x) u where x <> p_member
    on conflict do nothing;
  else
    perform public.chat_sync_org(a.org_id);
  end if;
  perform public._chat_log(a.org_id, p_member, 'group.create', v_id, null, null, null, null, jsonb_build_object('kind', p_kind, 'name', v_name));
  return jsonb_build_object('ok', true, 'conversation_id', v_id);
end
$f$;

-- May this person run a group (rename, members, archive)? An admin of it, an owner, or a manager of its venue.
create function public._chat_can_admin(p_member uuid, c public.chat_conversations) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  a record;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is distinct from c.org_id or not a.active then return false; end if;
  if a.level = 'owner' then return true; end if;
  if a.level = 'manager' and c.location_id is not null and c.location_id = any(a.locs) then return true; end if;
  return exists (select 1 from public.chat_members m where m.conversation_id = c.id and m.member_id = p_member and m.left_at is null and m.role = 'admin')
     and not exists (select 1 from public.chat_person_state ps where ps.member_id = p_member and ps.chat_off);
end
$f$;

-- Rename, describe, photo, who posts, archive. p_patch keys: name, description, photo, post_policy, archived (true|false).
create function public.chat_group_update(p_member uuid, p_conversation uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
  c public.chat_conversations;
  v_name text;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  select * into c from public.chat_conversations where id = p_conversation and org_id = a.org_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if c.kind = 'dm' then return jsonb_build_object('ok', false, 'code', 'not_a_group'); end if;
  if not public._chat_can_admin(p_member, c) then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  p_patch := coalesce(p_patch, '{}'::jsonb);
  if p_patch ? 'name' then
    v_name := btrim(coalesce(p_patch->>'name', ''));
    if char_length(v_name) not between 1 and 80 then return jsonb_build_object('ok', false, 'code', 'bad_name'); end if;
    c.name := v_name;
  end if;
  if p_patch ? 'description' then
    if char_length(coalesce(p_patch->>'description', '')) > 500 then return jsonb_build_object('ok', false, 'code', 'too_long'); end if;
    c.description := nullif(btrim(coalesce(p_patch->>'description', '')), '');
  end if;
  if p_patch ? 'photo' then c.photo := nullif(left(coalesce(p_patch->>'photo', ''), 300), ''); end if;
  if p_patch ? 'post_policy' then
    if c.kind = 'announce' then return jsonb_build_object('ok', false, 'code', 'bad_policy'); end if;
    if p_patch->>'post_policy' not in ('everyone', 'admins') then return jsonb_build_object('ok', false, 'code', 'bad_policy'); end if;
    c.post_policy := p_patch->>'post_policy';
  end if;
  if p_patch ? 'archived' then
    c.archived_at := case when (p_patch->>'archived')::boolean then coalesce(c.archived_at, now()) end;
  end if;
  update public.chat_conversations set name = c.name, description = c.description, photo = c.photo, post_policy = c.post_policy,
         archived_at = c.archived_at, updated_at = now() where id = c.id;
  perform public._chat_log(a.org_id, p_member, 'group.update', c.id, null, null, null, null, p_patch);
  return jsonb_build_object('ok', true);
end
$f$;

-- Members: add, remove, admin, member. Venue, position and announcement groups fill themselves, so
-- only admin and member change there. Everyone named must be in the same company.
create function public.chat_members_change(p_member uuid, p_conversation uuid, p_op text, p_targets uuid[]) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
  c public.chat_conversations;
  v_targets uuid[] := coalesce(p_targets, '{}'::uuid[]);
  v_n int := 0;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  select * into c from public.chat_conversations where id = p_conversation and org_id = a.org_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if c.kind = 'dm' then return jsonb_build_object('ok', false, 'code', 'not_a_group'); end if;
  if p_op not in ('add', 'remove', 'admin', 'member') then return jsonb_build_object('ok', false, 'code', 'bad_op'); end if;
  if cardinality(v_targets) = 0 or cardinality(v_targets) > 500 then return jsonb_build_object('ok', false, 'code', 'bad_member'); end if;
  if exists (select 1 from unnest(v_targets) x where not exists (select 1 from public.chat_profiles p where p.id = x and p.org_id = a.org_id)) then
    return jsonb_build_object('ok', false, 'code', 'cross_company');
  end if;
  if not public._chat_can_admin(p_member, c) then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  if c.kind <> 'group' and p_op in ('add', 'remove') then return jsonb_build_object('ok', false, 'code', 'automatic'); end if;
  if p_op = 'add' then
    insert into public.chat_members (conversation_id, member_id, org_id, role)
    select c.id, x, a.org_id, 'member' from (select distinct unnest(v_targets) as x) u
    on conflict (conversation_id, member_id) do update set left_at = null, left_reason = null where chat_members.left_at is not null;
    get diagnostics v_n = row_count;
  elsif p_op = 'remove' then
    update public.chat_members set left_at = now(), left_reason = 'removed'
     where conversation_id = c.id and member_id = any(v_targets) and left_at is null;
    get diagnostics v_n = row_count;
  else
    update public.chat_members set role = p_op where conversation_id = c.id and member_id = any(v_targets) and left_at is null;
    get diagnostics v_n = row_count;
  end if;
  perform public._chat_log(a.org_id, p_member, 'members.' || p_op, c.id, null, null, null, null, jsonb_build_object('members', to_jsonb(v_targets), 'changed', v_n));
  return jsonb_build_object('ok', true, 'changed', v_n);
end
$f$;

create function public.chat_leave(p_member uuid, p_conversation uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  g record;
begin
  select * into g from public._chat_gate(p_member, p_conversation);
  if g.code is not null and g.code <> 'chat_off' then return jsonb_build_object('ok', false, 'code', g.code); end if;
  if (g.c).kind in ('venue', 'position', 'announce') then return jsonb_build_object('ok', false, 'code', 'automatic'); end if;
  update public.chat_members set left_at = now(), left_reason = 'left' where conversation_id = p_conversation and member_id = p_member;
  return jsonb_build_object('ok', true);
end
$f$;

create function public.chat_mute(p_member uuid, p_conversation uuid, p_until timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  g record;
begin
  select * into g from public._chat_gate(p_member, p_conversation);
  if g.code is not null and g.code <> 'chat_off' then return jsonb_build_object('ok', false, 'code', g.code); end if;
  update public.chat_members set muted_until = case when p_until is null or p_until <= now() then null else p_until end
   where conversation_id = p_conversation and member_id = p_member;
  return jsonb_build_object('ok', true);
end
$f$;

-- ============================================================================
-- 6. REPORTS AND MODERATION
-- ============================================================================

create function public.chat_report(p_member uuid, p_message bigint, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  msg public.chat_messages;
  g record;
  v_id uuid;
begin
  select * into msg from public.chat_messages where id = p_message;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into g from public._chat_gate(p_member, msg.conversation_id);
  if g.code is not null and g.code <> 'chat_off' then return jsonb_build_object('ok', false, 'code', g.code); end if;
  if msg.sender_member_id = p_member then return jsonb_build_object('ok', false, 'code', 'own_message'); end if;
  if char_length(coalesce(p_reason, '')) > 500 then return jsonb_build_object('ok', false, 'code', 'too_long'); end if;
  insert into public.chat_reports (org_id, message_id, conversation_id, reporter_member_id, offender_member_id, reason, source, message_snapshot)
  values (msg.org_id, msg.id, msg.conversation_id, p_member, msg.sender_member_id, nullif(btrim(coalesce(p_reason, '')), ''), 'person',
          jsonb_build_object('body', coalesce(nullif(msg.body, ''), msg.removed_body), 'photos', coalesce(msg.removed_photos, msg.photos), 'created_at', msg.created_at))
  on conflict (message_id, reporter_member_id) where reporter_member_id is not null do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.chat_reports where message_id = msg.id and reporter_member_id = p_member;
  else
    perform public._chat_log(msg.org_id, p_member, 'report', msg.conversation_id, msg.id, msg.sender_member_id, v_id, p_reason, '{}'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'report_id', v_id);
end
$f$;

-- The AI check (after send, never blocking): it only ever opens a report.
create function public.chat_report_ai(p_message bigint, p_label text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  msg public.chat_messages;
  v_id uuid;
begin
  select * into msg from public.chat_messages where id = p_message;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  insert into public.chat_reports (org_id, message_id, conversation_id, offender_member_id, reason, source, ai_label, message_snapshot)
  values (msg.org_id, msg.id, msg.conversation_id, msg.sender_member_id, left(p_reason, 500), 'ai', left(p_label, 40),
          jsonb_build_object('body', coalesce(nullif(msg.body, ''), msg.removed_body), 'photos', msg.photos, 'created_at', msg.created_at))
  on conflict (message_id) where source = 'ai' do nothing returning id into v_id;
  if v_id is not null then
    perform public._chat_log(msg.org_id, null, 'report.ai', msg.conversation_id, msg.id, msg.sender_member_id, v_id, p_label, '{}'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'report_id', v_id);
end
$f$;

-- A manager or owner acts. p_action:
--   hide (a message, or the message of p_report)   keep (the report: the message stays, or comes back)
--   mute_person / unmute_person (p_target, p_until)  remove (p_target from p_conversation)
--   chat_off / chat_on (p_target)
-- Managers handle people at their own venues (or messages in their venues' groups), owners everyone,
-- nobody anything about themselves. Every action is in the moderation log.
create function public.chat_mod(p_member uuid, p_action text, p_report uuid, p_message bigint, p_target uuid,
  p_conversation uuid, p_until timestamptz, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
  r public.chat_reports;
  msg public.chat_messages;
  c public.chat_conversations;
  v_offender uuid := p_target;
  v_code text;
  v_conv uuid := p_conversation;
  v_msg bigint := p_message;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if p_action not in ('hide', 'keep', 'mute_person', 'unmute_person', 'remove', 'chat_off', 'chat_on') then
    return jsonb_build_object('ok', false, 'code', 'bad_action');
  end if;
  if char_length(coalesce(p_note, '')) > 500 then return jsonb_build_object('ok', false, 'code', 'too_long'); end if;
  if p_report is not null then
    select * into r from public.chat_reports where id = p_report and org_id = a.org_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    v_msg := coalesce(v_msg, r.message_id);
    v_conv := coalesce(v_conv, r.conversation_id);
    v_offender := coalesce(v_offender, r.offender_member_id);
  end if;
  if v_msg is not null then
    select * into msg from public.chat_messages where id = v_msg and org_id = a.org_id for update;
    if not found and p_action = 'hide' then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if found then
      v_conv := coalesce(v_conv, msg.conversation_id);
      v_offender := coalesce(v_offender, msg.sender_member_id);
    end if;
  end if;
  if p_action in ('hide') and v_msg is null then return jsonb_build_object('ok', false, 'code', 'bad_message'); end if;
  if p_action = 'keep' and p_report is null then return jsonb_build_object('ok', false, 'code', 'bad_report'); end if;
  if p_action in ('mute_person', 'unmute_person', 'remove', 'chat_off', 'chat_on') and v_offender is null then
    return jsonb_build_object('ok', false, 'code', 'bad_member');
  end if;
  if v_conv is not null then
    select * into c from public.chat_conversations where id = v_conv and org_id = a.org_id;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  end if;
  v_code := public._chat_can_moderate(p_member, v_offender, c.location_id);
  if v_code is not null then return jsonb_build_object('ok', false, 'code', v_code); end if;

  if p_action = 'hide' then
    if msg.status <> 'hidden' then
      update public.chat_messages set status = 'hidden', removed_body = coalesce(removed_body, body), removed_photos = coalesce(removed_photos, photos),
             body = '', photos = '[]'::jsonb where id = msg.id;
    end if;
    update public.chat_reports set status = 'hidden', handled_by = p_member, handled_at = now(), note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note)
     where message_id = msg.id and status = 'open';
  elsif p_action = 'keep' then
    if msg.id is not null and msg.status = 'hidden' then
      update public.chat_messages set status = 'visible', body = coalesce(removed_body, ''), photos = coalesce(removed_photos, '[]'::jsonb),
             removed_body = null, removed_photos = null where id = msg.id and deleted_at is null;
    end if;
    update public.chat_reports set status = 'kept', handled_by = p_member, handled_at = now(), note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note)
     where (id = p_report or (msg.id is not null and message_id = msg.id)) and status in ('open', 'hidden');
  elsif p_action in ('mute_person', 'unmute_person') then
    insert into public.chat_person_state (member_id, org_id, muted_until, reason, updated_by)
    values (v_offender, a.org_id, case when p_action = 'mute_person' then coalesce(p_until, now() + interval '24 hours') end, p_note, p_member)
    on conflict (member_id) do update set muted_until = excluded.muted_until, reason = coalesce(excluded.reason, chat_person_state.reason),
      updated_at = now(), updated_by = p_member;
  elsif p_action = 'remove' then
    if v_conv is null then return jsonb_build_object('ok', false, 'code', 'bad_conversation'); end if;
    if c.kind = 'dm' then return jsonb_build_object('ok', false, 'code', 'not_a_group'); end if;
    update public.chat_members set left_at = now(), left_reason = 'removed' where conversation_id = v_conv and member_id = v_offender and left_at is null;
  else
    insert into public.chat_person_state (member_id, org_id, chat_off, reason, updated_by)
    values (v_offender, a.org_id, p_action = 'chat_off', p_note, p_member)
    on conflict (member_id) do update set chat_off = excluded.chat_off, reason = coalesce(excluded.reason, chat_person_state.reason),
      updated_at = now(), updated_by = p_member;
  end if;
  if p_report is not null and p_action not in ('hide', 'keep') then
    update public.chat_reports set handled_by = p_member, handled_at = now() where id = p_report and handled_at is null;
  end if;
  perform public._chat_log(a.org_id, p_member, 'mod.' || p_action, v_conv, v_msg, v_offender, p_report, p_note,
    case when p_until is not null then jsonb_build_object('until', p_until) else '{}'::jsonb end);
  return jsonb_build_object('ok', true);
end
$f$;

-- What a manager sees of a report: the message and 5 before and 5 after it (10 around), logged.
-- A DM stays private otherwise.
create function public.chat_report_context(p_member uuid, p_report uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
  r public.chat_reports;
  c public.chat_conversations;
  msg public.chat_messages;
  v_code text;
  v_rows jsonb;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  select * into r from public.chat_reports where id = p_report and org_id = a.org_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into c from public.chat_conversations where id = r.conversation_id and org_id = a.org_id;
  v_code := public._chat_can_moderate(p_member, r.offender_member_id, c.location_id);
  if v_code is not null then return jsonb_build_object('ok', false, 'code', v_code); end if;
  select * into msg from public.chat_messages where id = r.message_id;
  if found then
    select coalesce(jsonb_agg(x order by (x->>'id')::bigint), '[]'::jsonb) into v_rows from (
      select (to_jsonb(m) - 'original_body' - 'removed_body' - 'removed_photos') || jsonb_build_object('sender_name', p.display_name,
               'removed_text', case when m.id = msg.id then m.removed_body end) as x
        from (
          (select * from public.chat_messages where conversation_id = msg.conversation_id and id < msg.id order by id desc limit 5)
          union all select * from public.chat_messages where id = msg.id
          union all
          (select * from public.chat_messages where conversation_id = msg.conversation_id and id > msg.id order by id limit 5)
        ) m left join public.chat_profiles p on p.id = m.sender_member_id
    ) q;
  end if;
  perform public._chat_log(a.org_id, p_member, 'report.view', r.conversation_id, r.message_id, r.offender_member_id, r.id, null, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'report', to_jsonb(r), 'conversation', jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name),
    'messages', coalesce(v_rows, '[]'::jsonb));
end
$f$;

-- An owner opens a whole DM: a typed reason (at least 10 letters) is required and logged.
create function public.chat_owner_open_dm(p_member uuid, p_conversation uuid, p_reason text, p_before bigint, p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
  c public.chat_conversations;
  v_rows jsonb;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if a.level <> 'owner' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then return jsonb_build_object('ok', false, 'code', 'reason_required'); end if;
  select * into c from public.chat_conversations where id = p_conversation and org_id = a.org_id;
  if not found or c.kind <> 'dm' then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if exists (select 1 from public.chat_members m where m.conversation_id = c.id and m.member_id = p_member) then
    return jsonb_build_object('ok', false, 'code', 'own_report');
  end if;
  select coalesce(jsonb_agg(x order by (x->>'id')::bigint), '[]'::jsonb) into v_rows from (
    select (to_jsonb(m) - 'original_body' - 'removed_body' - 'removed_photos') || jsonb_build_object('sender_name', p.display_name, 'removed_text', m.removed_body) as x
      from (select * from public.chat_messages where conversation_id = c.id and (p_before is null or id < p_before) order by id desc limit v_limit) m
      left join public.chat_profiles p on p.id = m.sender_member_id
  ) q;
  perform public._chat_log(a.org_id, p_member, 'owner.open_dm', c.id, null, null, null, btrim(p_reason), jsonb_build_object('before', p_before, 'limit', v_limit));
  return jsonb_build_object('ok', true, 'messages', v_rows,
    'members', (select coalesce(jsonb_agg(jsonb_build_object('member_id', p.id, 'name', p.display_name)), '[]'::jsonb)
                  from public.chat_members m join public.chat_profiles p on p.id = m.member_id where m.conversation_id = c.id));
end
$f$;

-- ============================================================================
-- 7. SETTINGS, WORD LISTS, EXPORT, PHONES
-- ============================================================================

create function public.chat_settings_save(p_member uuid, p_settings jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
  st public.chat_settings;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if a.level <> 'owner' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  st := public._chat_settings(a.org_id);
  p_settings := coalesce(p_settings, '{}'::jsonb);
  begin
    if p_settings ? 'groups_by' then st.groups_by := p_settings->>'groups_by'; end if;
    if p_settings ? 'dm_scope' then st.dm_scope := p_settings->>'dm_scope'; end if;
    if p_settings ? 'filter_level' then st.filter_level := p_settings->>'filter_level'; end if;
    if p_settings ? 'ai_check' then st.ai_check := (p_settings->>'ai_check')::boolean; end if;
    if p_settings ? 'keep_years' then st.keep_years := (p_settings->>'keep_years')::int; end if;
    if p_settings ? 'sms_backup_urgent' then st.sms_backup_urgent := (p_settings->>'sms_backup_urgent')::boolean; end if;
    if p_settings ? 'quiet_off_shift' then st.quiet_off_shift := (p_settings->>'quiet_off_shift')::boolean; end if;
    insert into public.chat_settings (org_id, groups_by, dm_scope, filter_level, ai_check, keep_years, sms_backup_urgent, quiet_off_shift, updated_at, updated_by)
    values (a.org_id, st.groups_by, st.dm_scope, st.filter_level, st.ai_check, st.keep_years, st.sms_backup_urgent, st.quiet_off_shift, now(), p_member)
    on conflict (org_id) do update set groups_by = excluded.groups_by, dm_scope = excluded.dm_scope, filter_level = excluded.filter_level,
      ai_check = excluded.ai_check, keep_years = excluded.keep_years, sms_backup_urgent = excluded.sms_backup_urgent,
      quiet_off_shift = excluded.quiet_off_shift, updated_at = now(), updated_by = p_member;
  exception when check_violation or invalid_text_representation or not_null_violation then
    return jsonb_build_object('ok', false, 'code', 'bad_setting');
  end;
  perform public._chat_log(a.org_id, p_member, 'settings.save', null, null, null, null, null, p_settings);
  return jsonb_build_object('ok', true);
end
$f$;

-- Replace a company's block or allow list (at most 500 phrases).
create function public.chat_words_save(p_member uuid, p_kind text, p_phrases text[]) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
  v_n int;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if a.level <> 'owner' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  if p_kind not in ('block', 'allow') then return jsonb_build_object('ok', false, 'code', 'bad_kind'); end if;
  if cardinality(coalesce(p_phrases, '{}'::text[])) > 500 then return jsonb_build_object('ok', false, 'code', 'too_many'); end if;
  if exists (select 1 from unnest(p_phrases) x where char_length(btrim(x)) > 80) then return jsonb_build_object('ok', false, 'code', 'too_long'); end if;
  delete from public.chat_word_lists where org_id = a.org_id and kind = p_kind;
  insert into public.chat_word_lists (org_id, kind, phrase, created_by)
  select a.org_id, p_kind, x, p_member from (select distinct on (lower(btrim(y))) btrim(y) as x from unnest(coalesce(p_phrases, '{}'::text[])) y where btrim(y) <> '') q;
  get diagnostics v_n = row_count;
  perform public._chat_log(a.org_id, p_member, 'words.save', null, null, null, null, null, jsonb_build_object('kind', p_kind, 'count', v_n));
  return jsonb_build_object('ok', true, 'count', v_n);
end
$f$;

-- Everything one person wrote (a subject access request, or a disciplinary). Owner only, logged.
create function public.chat_export_person(p_member uuid, p_target uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
  t public.chat_profiles;
  v_rows jsonb;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if a.level <> 'owner' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then return jsonb_build_object('ok', false, 'code', 'reason_required'); end if;
  select * into t from public.chat_profiles where id = p_target and org_id = a.org_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'at', m.created_at, 'conversation', coalesce(c.name, c.kind), 'kind', c.kind,
           'text', coalesce(nullif(m.body, ''), m.removed_body, ''), 'edited_at', m.edited_at, 'original_text', m.original_body,
           'deleted_at', m.deleted_at, 'hidden', m.status = 'hidden', 'photos', jsonb_array_length(coalesce(m.removed_photos, m.photos)))
           order by m.id), '[]'::jsonb) into v_rows
    from (select * from public.chat_messages where sender_member_id = t.id and org_id = a.org_id order by id limit 20000) m
    join public.chat_conversations c on c.id = m.conversation_id;
  perform public._chat_log(a.org_id, p_member, 'export_person', null, null, t.id, null, btrim(p_reason), jsonb_build_object('messages', jsonb_array_length(v_rows)));
  return jsonb_build_object('ok', true, 'person', jsonb_build_object('member_id', t.id, 'name', t.display_name, 'kind', t.kind), 'messages', v_rows);
end
$f$;

create function public.chat_push_register(p_member uuid, p_platform text, p_token text, p_subscription jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $f$
declare
  a record;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if p_platform not in ('apns', 'webpush') or char_length(coalesce(p_token, '')) not between 8 and 1000 then
    return jsonb_build_object('ok', false, 'code', 'bad_device');
  end if;
  insert into public.push_devices (org_id, member_id, platform, token, subscription, last_seen)
  values (a.org_id, p_member, p_platform, p_token, p_subscription, now())
  on conflict (platform, token) do update set org_id = excluded.org_id, member_id = excluded.member_id,
    subscription = coalesce(excluded.subscription, push_devices.subscription), last_seen = now();
  delete from public.push_devices where member_id = p_member and id not in
    (select id from public.push_devices where member_id = p_member order by last_seen desc limit 10);
  return jsonb_build_object('ok', true);
end
$f$;

-- Nightly clean up. In batches, so one run stays well inside the time limit; the next night continues.
create function public.chat_purge() returns jsonb
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

-- ============================================================================
-- 7b. READS FOR THE SERVER (service role only)
-- ============================================================================
-- The Manager app runs on a paired device with a PIN, so it has no personal login and row level
-- security shows it nothing: it reads its chats through these, as the PIN holder's profile. Back
-- Office reads groups, reports and the log through the rest, each scoped by the database.

-- My chats, with my marker, unread count, newest message, DM members and the company's names.
create function public.chat_inbox(p_member uuid) returns jsonb
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

-- One page of a chat I am in: newest first (p_before for older), or only those after p_after (a poll).
create function public.chat_thread(p_member uuid, p_conversation uuid, p_before bigint, p_after bigint, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  g record;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_msgs jsonb;
begin
  select * into g from public._chat_gate(p_member, p_conversation);
  if g.code is not null then return jsonb_build_object('ok', false, 'code', g.code); end if;
  select coalesce(jsonb_agg(public._chat_message_json(x) order by x.id desc), '[]'::jsonb) into v_msgs
    from (select * from public.chat_messages where conversation_id = p_conversation
            and (p_before is null or id < p_before) and (p_after is null or id > p_after) order by id desc limit v_limit) x;
  return jsonb_build_object('ok', true, 'messages', v_msgs,
    'reactions', coalesce((select jsonb_agg(jsonb_build_object('message_id', r.message_id, 'member_id', r.member_id, 'emoji', r.emoji))
       from public.chat_reactions r where r.conversation_id = p_conversation
        and r.message_id in (select (e->>'id')::bigint from jsonb_array_elements(v_msgs) e)), '[]'::jsonb));
end
$f$;

-- The members of a chat I am in (names, admin, read marker for Seen by).
create function public.chat_members_list(p_member uuid, p_conversation uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  g record;
begin
  select * into g from public._chat_gate(p_member, p_conversation);
  if g.code is not null then return jsonb_build_object('ok', false, 'code', g.code); end if;
  return jsonb_build_object('ok', true, 'members', coalesce((select jsonb_agg(jsonb_build_object('member_id', m.member_id, 'role', m.role,
      'last_read_message_id', m.last_read_message_id, 'left_at', m.left_at))
    from (select * from public.chat_members where conversation_id = p_conversation and left_at is null limit 3000) m), '[]'::jsonb));
end
$f$;

-- Back Office: the groups this person runs. Owners every group of the company; managers their
-- venues' groups and any group they are an admin of. Never DMs.
create function public.chat_admin_groups(p_member uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  a record;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if a.level = 'staff' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  return jsonb_build_object('ok', true, 'groups', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name,
      'description', c.description, 'location_id', c.location_id, 'role_key', c.role_key, 'post_policy', c.post_policy,
      'archived_at', c.archived_at, 'last_message_at', c.last_message_at,
      'members', (select count(*) from public.chat_members m where m.conversation_id = c.id and m.left_at is null)) order by c.kind, c.name)
    from public.chat_conversations c
   where c.org_id = a.org_id and c.kind <> 'dm'
     and (a.level = 'owner' or c.location_id = any(a.locs)
          or exists (select 1 from public.chat_members m where m.conversation_id = c.id and m.member_id = p_member and m.role = 'admin' and m.left_at is null))), '[]'::jsonb));
end
$f$;

-- Back Office: the members of one group, with where they work and their position.
create function public.chat_admin_members(p_member uuid, p_conversation uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  a record;
  c public.chat_conversations;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  select * into c from public.chat_conversations where id = p_conversation and org_id = a.org_id;
  if not found or c.kind = 'dm' then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if not public._chat_can_admin(p_member, c) then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  return jsonb_build_object('ok', true, 'members', coalesce((select jsonb_agg(jsonb_build_object('member_id', p.id, 'name', p.display_name, 'kind', p.kind,
      'role', m.role, 'auto', m.auto, 'location_id', s.location_id, 'role_key', s.role_key) order by p.display_name)
    from public.chat_members m join public.chat_profiles p on p.id = m.member_id left join public.wf_staff s on s.id = p.staff_id
   where m.conversation_id = c.id and m.left_at is null), '[]'::jsonb));
end
$f$;

-- Back Office: people to pick for a group, with venue and position filters, and the company's
-- venues and positions for the filters. Managers and owners only.
create function public.chat_people(p_member uuid, p_location uuid, p_role_key text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  a record;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if a.level = 'staff' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  return jsonb_build_object('ok', true,
    'people', coalesce((select jsonb_agg(jsonb_build_object('member_id', p.id, 'name', p.display_name, 'kind', p.kind,
        'location_id', s.location_id, 'venue_ids', to_jsonb(coalesce(s.venue_ids, '{}'::uuid[])), 'role_key', s.role_key) order by p.display_name)
      from (select * from public.chat_profiles where org_id = a.org_id order by display_name limit 3000) p
      left join public.wf_staff s on s.id = p.staff_id
     where (p.staff_id is null or s.status <> 'leaver')
       and (p_location is null or s.location_id = p_location or p_location = any(s.venue_ids))
       and (nullif(p_role_key, '') is null or s.role_key = p_role_key)), '[]'::jsonb),
    'venues', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name) order by l.name) from public.locations l where l.org_id = a.org_id), '[]'::jsonb),
    'positions', coalesce((select jsonb_agg(distinct s.role_key) from public.wf_staff s where s.org_id = a.org_id and s.role_key is not null and s.status <> 'leaver'), '[]'::jsonb));
end
$f$;

-- Reports to check, in this person's reach (managers: their venues' people and groups; owners: all;
-- nobody sees a report about themselves). p_status: open (default) or all.
create function public.chat_reports_list(p_member uuid, p_status text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  a record;
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 300);
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if a.level = 'staff' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  return jsonb_build_object('ok', true, 'reports', coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
    select jsonb_build_object('id', r.id, 'status', r.status, 'source', r.source, 'ai_label', r.ai_label, 'reason', r.reason,
             'created_at', r.created_at, 'handled_at', r.handled_at, 'note', r.note, 'message_id', r.message_id,
             'text', r.message_snapshot->>'body', 'photos', jsonb_array_length(coalesce(r.message_snapshot->'photos', '[]'::jsonb)),
             'conversation_id', r.conversation_id, 'conversation_kind', c.kind, 'conversation_name', c.name,
             'offender_member_id', r.offender_member_id, 'offender_name', po.display_name,
             'reporter_name', pr.display_name, 'handled_by_name', ph.display_name,
             'message_status', case when mm.id is null then 'gone' when mm.deleted_at is not null then 'deleted' else mm.status end) as x
      from public.chat_reports r
      left join public.chat_conversations c on c.id = r.conversation_id
      left join public.chat_profiles po on po.id = r.offender_member_id
      left join public.chat_profiles pr on pr.id = r.reporter_member_id
      left join public.chat_profiles ph on ph.id = r.handled_by
      left join public.chat_messages mm on mm.id = r.message_id
     where r.org_id = a.org_id and (coalesce(p_status, 'open') = 'all' or r.status = 'open')
       and public._chat_can_moderate(p_member, r.offender_member_id, c.location_id) is null
     order by r.created_at desc limit v_limit) q), '[]'::jsonb));
end
$f$;

-- The moderation log. Owners and Admins only.
create function public.chat_log_list(p_member uuid, p_before bigint, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  a record;
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if a.level <> 'owner' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  return jsonb_build_object('ok', true, 'log', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'at', l.at, 'actor', l.actor_name,
      'action', l.action, 'conversation_id', l.conversation_id, 'message_id', l.message_id, 'target', pt.display_name,
      'reason', l.reason, 'detail', l.detail) order by l.id desc)
    from (select * from public.chat_moderation_log where org_id = a.org_id and (p_before is null or id < p_before) order by id desc limit v_limit) l
    left join public.chat_profiles pt on pt.id = l.target_member_id), '[]'::jsonb));
end
$f$;

-- The company's DMs (who and when, never what), so an owner can pick one to open with a reason.
create function public.chat_dm_list(p_member uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  a record;
begin
  select * into a from public._chat_power(p_member);
  if a.org_id is null or not a.active then return jsonb_build_object('ok', false, 'code', 'no_member'); end if;
  if a.level <> 'owner' then return jsonb_build_object('ok', false, 'code', 'not_allowed'); end if;
  return jsonb_build_object('ok', true, 'dms', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'last_message_at', c.last_message_at,
      'names', (select jsonb_agg(p.display_name order by p.display_name) from public.chat_members m join public.chat_profiles p on p.id = m.member_id where m.conversation_id = c.id))
      order by c.last_message_at desc nulls last)
    from (select * from public.chat_conversations where org_id = a.org_id and kind = 'dm' order by last_message_at desc nulls last limit 500) c
    where not exists (select 1 from public.chat_members m where m.conversation_id = c.id and m.member_id = p_member)), '[]'::jsonb));
end
$f$;

-- ============================================================================
-- 8. GRANTS AND ROW LEVEL SECURITY
-- ============================================================================
do $grants$
declare
  t text;
  f text;
begin
  foreach t in array array['chat_settings', 'chat_word_lists', 'chat_profiles', 'chat_conversations', 'chat_members', 'chat_messages',
                           'chat_reactions', 'chat_reports', 'chat_moderation_log', 'chat_person_state', 'push_devices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
  revoke all on sequence public.chat_messages_id_seq, public.chat_moderation_log_id_seq from public, anon, authenticated;
  grant usage, select on sequence public.chat_messages_id_seq, public.chat_moderation_log_id_seq to service_role;

  -- Every function: the service role only, except the three read helpers the policies call.
  for f in select p.oid::regprocedure::text from pg_proc p
            where p.pronamespace = 'public'::regnamespace and (p.proname like 'chat\_%' or p.proname like '\_chat\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  grant execute on function public.chat_my_member_ids(), public.chat_my_conversation_ids(), public.chat_my_org_ids() to authenticated;
end
$grants$;

-- Reads, for members only. No insert, update or delete policy exists: nobody but the service role writes.
grant select on public.chat_conversations, public.chat_members, public.chat_reactions, public.chat_settings to authenticated;
grant select (id, org_id, conversation_id, sender_member_id, body, photos, reply_to, status, edited_at, deleted_at, urgent, mentions, client_id, created_at)
  on public.chat_messages to authenticated;
grant select (id, org_id, kind, display_name, photo) on public.chat_profiles to authenticated;

create policy chat_conversations_member_read on public.chat_conversations for select to authenticated
  using (id in (select public.chat_my_conversation_ids()));
create policy chat_members_member_read on public.chat_members for select to authenticated
  using (conversation_id in (select public.chat_my_conversation_ids()));
create policy chat_messages_member_read on public.chat_messages for select to authenticated
  using (conversation_id in (select public.chat_my_conversation_ids()));
create policy chat_reactions_member_read on public.chat_reactions for select to authenticated
  using (conversation_id in (select public.chat_my_conversation_ids()));
create policy chat_profiles_company_read on public.chat_profiles for select to authenticated
  using (org_id in (select public.chat_my_org_ids()));
create policy chat_settings_company_read on public.chat_settings for select to authenticated
  using (org_id in (select public.chat_my_org_ids()));

-- ============================================================================
-- 9. REALTIME, PHOTOS, CLEAN UP, BACKFILL
-- ============================================================================
do $extras$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['chat_messages', 'chat_reactions', 'chat_members'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('chat-photos', 'chat-photos', false) on conflict (id) do nothing;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $c$select cron.schedule('chat-purge', '17 3 * * *', 'select public.chat_purge()')$c$;
  end if;
end
$extras$;

select public.chat_sync_org(o.org_id) from (select distinct org_id from public.locations where org_id is not null) o;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: chat_tables 11, chat_functions 46, open_to_api 3 (the three read helpers,
-- authenticated only), anon_can_read false, authenticated_can_write false, member_policies 6,
-- write_policies 0, venue_groups = the number of venues, realtime_tables 3 (0 where there is no
-- supabase_realtime publication), staff_trigger true.
select
  (select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and c.relname in ('chat_settings', 'chat_word_lists', 'chat_profiles', 'chat_conversations', 'chat_members', 'chat_messages',
                      'chat_reactions', 'chat_reports', 'chat_moderation_log', 'chat_person_state', 'push_devices')) as chat_tables,
  (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'chat\_%' or p.proname like '\_chat\_%')) as chat_functions,
  (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'chat\_%' or p.proname like '\_chat\_%')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) as open_to_api,
  exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and (c.relname like 'chat\_%' or c.relname = 'push_devices')
    and has_table_privilege('anon', c.oid, 'select')) as anon_can_read,
  exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and (c.relname like 'chat\_%' or c.relname = 'push_devices')
    and (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
         or has_table_privilege('authenticated', c.oid, 'delete') or has_table_privilege('anon', c.oid, 'insert'))) as authenticated_can_write,
  (select count(*)::int from pg_policies where schemaname = 'public' and cmd = 'SELECT' and (tablename like 'chat\_%' or tablename = 'push_devices')) as member_policies,
  (select count(*)::int from pg_policies where schemaname = 'public' and cmd <> 'SELECT' and (tablename like 'chat\_%' or tablename = 'push_devices')) as write_policies,
  (select count(*)::int from public.chat_conversations where kind = 'venue') = (select count(*)::int from public.locations where org_id is not null) as venue_groups,
  (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
    and tablename in ('chat_messages', 'chat_reactions', 'chat_members')) as realtime_tables,
  exists (select 1 from pg_trigger where tgname = 'trg_wf_staff_chat_sync' and tgrelid = 'public.wf_staff'::regclass) as staff_trigger;
