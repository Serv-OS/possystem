-- 20261005a_OPS_venue_messages.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 1 new table, 2 functions and 1 realtime entry. Touches no existing  #
-- #  table and no existing row, so it is safe any time, service included.     #
-- ############################################################################
--
-- WHY (Peter, 5 Oct 2026: "another feature: we need to be able to send a notification, like a
-- message, to all customers or certain customers asking them to do things, like a POP UP from
-- the admin: send a message, in this case saying 'Hi, I have just made an update, you need to
-- do XYZ'.")
--   "Customers" are ServOS's customers: the venues. His calls: it pops up in Back Office AND on
--   tills, it stays until someone taps Got it, admin sees WHO did and when (one confirmation
--   clears it for that venue), and he sends to chosen companies or venues.
--
-- WHY A NEW TABLE (and not activity_events, which the till bell already reads)
--   Checked on the live database on 5 Oct 2026: activity_events has ONE policy, "allow all"
--   (using true, with check true). Anybody holding the public key that ships in the app can
--   read every venue's rows, write a row for any venue, acknowledge any row and delete any row.
--   A message from ServOS on that table could be read by another venue, forged by a stranger
--   ("Message from ServOS: call this number"), marked confirmed by somebody who never saw it,
--   or deleted. It also has no place for who sent it, a withdrawal or a second send, and
--   tightening it would break the kiosk, QR and online writers that rely on it being open.
--
-- WHAT THIS FILE DOES
--   public.venue_messages         one row per message PER VENUE (a send to 6 venues is 6 rows
--                                 sharing a broadcast_id). The row holds the text, who sent it,
--                                 and that venue's own confirmation or withdrawal.
--   Reading                       a venue reads ONLY its own rows: a Back Office login through
--                                 its venues, a paired TILL through its own venue. Kiosks,
--                                 kitchen screens and time clocks read nothing, so the read rule
--                                 is the same width as the confirm rule
--                                 (venue_message_reader_location_ids(), this table's own helper;
--                                 the fence's pos_accessible_location_ids() answers yes to every
--                                 bound device of the venue, a kiosk in public hands included).
--                                 The sender's identity columns and the confirming login's
--                                 email are not readable by a venue at all.
--   Writing                       nobody can insert, update or delete through the API. No
--                                 policy and no grant. ServOS sends, sends again and withdraws
--                                 through the venue-messages-admin edge function (service role,
--                                 after it has checked the caller is ServOS staff).
--   public.venue_message_confirm  the ONE thing a venue can change: Got it. It sets the confirm
--                                 fields of a waiting row of the caller's OWN venue and nothing
--                                 else. Back Office: the row keeps the login's EMAIL from its
--                                 own sign in token (a login cannot change that) next to the
--                                 name on its profile (which it can: full_name is free on a
--                                 login's own row, so the name alone proves nothing). Till: the
--                                 name of the member of staff signed in, as the till sends it,
--                                 and the row also keeps which till it was. Kiosks, kitchen
--                                 screens and time clocks are refused.
--   Realtime                      the table joins supabase_realtime so the pop up appears and
--                                 clears live. Realtime applies the same read rule per listener.
--
-- BEFORE AND AFTER IT RUNS
--   Before: the app works as today. No till or Back Office shows anything new (the read finds no
--   table and stays quiet), and Company Admin, Messages to venues says it needs this update.
--   After: deploy the venue-messages-admin function, then send from Company Admin.
--
-- Rollback: 20261005a_OPS_venue_messages_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.devices') is null then
    raise exception 'This is not the Ops database (device_profiles or devices is missing). Nothing was changed.';
  end if;
  if to_regprocedure('public.user_accessible_locations()') is null
     or to_regprocedure('public.is_anon_session()') is null then
    raise exception 'The fence helpers (user_accessible_locations, is_anon_session) are missing. This is not the database this file was written for. Nothing was changed.';
  end if;
end
$guard$;

-- Fail fast instead of making till reads queue behind this script (it only takes a lock on
-- locations for the foreign key, for a moment).
set local lock_timeout = '3s';

create table if not exists public.venue_messages (
  id                    uuid primary key default gen_random_uuid(),
  broadcast_id          uuid not null,
  location_id           uuid not null references public.locations(id) on delete cascade,
  kind                  text not null default 'info',
  title                 text,
  body                  text not null,
  sent_by               uuid,
  sent_by_name          text,
  sent_at               timestamptz not null default now(),
  resent_at             timestamptz,
  confirmed_at          timestamptz,
  confirmed_by          text,
  confirmed_via         text,
  confirmed_user_id     uuid,
  confirmed_email       text,
  confirmed_device_id   uuid,
  confirmed_device_name text,
  withdrawn_at          timestamptz,
  withdrawn_by          text,
  constraint venue_messages_kind_ok check (kind in ('info', 'action')),
  constraint venue_messages_body_ok check (char_length(body) between 1 and 600),
  constraint venue_messages_title_ok check (title is null or char_length(title) between 1 and 80),
  constraint venue_messages_via_ok check (confirmed_via is null or confirmed_via in ('till', 'backoffice')),
  constraint venue_messages_confirm_whole check ((confirmed_at is null) = (confirmed_by is null)),
  constraint venue_messages_once_per_venue unique (broadcast_id, location_id)
);

comment on table public.venue_messages is
  'Messages from ServOS to venues (5 Oct 2026). One row per message per venue. Written only by the venue-messages-admin edge function (service role); a venue reads its own rows and confirms through venue_message_confirm(). src/lib/venueMessageRules.js.';

-- For a database where an earlier draft of this file already made the table.
alter table public.venue_messages add column if not exists confirmed_email text;

create index if not exists venue_messages_location_sent_idx on public.venue_messages (location_id, sent_at desc);
create index if not exists venue_messages_sent_idx on public.venue_messages (sent_at desc);

-- ── Row level security, written out ─────────────────────────────────────────
alter table public.venue_messages enable row level security;

-- Nothing by default, then exactly what is needed. A venue may read these columns of its own
-- rows; sent_by and sent_by_name (which person at ServOS) and confirmed_email (the login behind
-- a Back Office Got it, for ServOS only) are left out on purpose.
revoke all on table public.venue_messages from public, anon, authenticated;
grant select (id, broadcast_id, location_id, kind, title, body, sent_at, resent_at,
              confirmed_at, confirmed_by, confirmed_via, confirmed_device_name, withdrawn_at)
  on table public.venue_messages to authenticated;
grant all on table public.venue_messages to service_role;

-- Who may read, as a set of venues. SECURITY DEFINER (it reads devices and, through
-- user_accessible_locations(), user_locations) and it answers:
--   * a Back Office login: its venues (user_locations, an owner's own company, a super admin);
--   * a paired TILL: the one venue it is bound to;
--   * a kiosk, a kitchen screen, a time clock, an Operations tablet (ops_devices): nothing.
--     WHY NOT pos_accessible_location_ids(): checked on the live database on 5 Oct 2026, it
--     answers yes to every bound device of the venue (16 kitchen screens, 3 kiosks, 1 clock)
--     and every active ops_devices row. A kiosk is a browser in public hands; the message and
--     the names of the staff who confirmed it must never be readable from one;
--   * anybody else, the bare public key included: nothing.
create or replace function public.venue_message_reader_location_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select k::uuid
    from public.user_accessible_locations() as k
   where k ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  union
  select d.location_id
    from public.devices d
   where d.device_uid = auth.uid()
     and d.bound_via is not null
     and d.status in ('active', 'online')
     and d.location_id is not null
     and coalesce(d.type, '') not in ('kiosk', 'kds', 'clock');
$fn$;

comment on function public.venue_message_reader_location_ids() is
  'Venues whose messages from ServOS the caller may read (5 Oct 2026): a Back Office login''s venues, or the venue of a paired till. Never a kiosk, kitchen screen, time clock or Operations tablet. Used only by the read rule on venue_messages.';

revoke all on function public.venue_message_reader_location_ids() from public, anon;
grant execute on function public.venue_message_reader_location_ids() to authenticated, service_role;

-- A venue reads only its own messages. The set form (one helper call for the whole statement,
-- not one per row: 20260927a).
drop policy if exists venue_messages_read_own_venue on public.venue_messages;
create policy venue_messages_read_own_venue on public.venue_messages
  as permissive for select to authenticated
  using (location_id in (select public.venue_message_reader_location_ids()));

-- No insert, update or delete policy: with row level security on, that means refused.

-- The second sign in step, as on every other table (20260919s). Skipped when that file has not
-- run on this database.
do $second_step$
begin
  if to_regprocedure('public.second_step_ok()') is not null
     and not exists (select 1 from pg_policy p
                      where p.polrelid = 'public.venue_messages'::regclass and p.polname = 'second_step_fence') then
    execute 'create policy second_step_fence on public.venue_messages as restrictive for all to authenticated '
         || 'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))';
  end if;
end
$second_step$;

-- ── Got it ──────────────────────────────────────────────────────────────────
-- The only change a venue can make. Returns jsonb, never raises for an ordinary refusal:
--   {ok:true,  state:'confirmed', already:false, confirmed_by, confirmed_at}
--   {ok:true,  state:'confirmed', already:true,  ...}     somebody else got there first
--   {ok:true,  state:'withdrawn'}                         ServOS took it back
--   {ok:false, reason:'not_allowed'}                      not this caller's venue, or no such row
--                                                         (one answer for both, so a stranger
--                                                         cannot probe which ids exist)
create or replace function public.venue_message_confirm(p_id uuid, p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_row     public.venue_messages%rowtype;
  v_via     text;
  v_name    text;
  v_dev_id  uuid;
  v_dev     text;
  v_user    uuid;
  v_email   text;
  v_ok      boolean;
  v_no      jsonb := jsonb_build_object('ok', false, 'reason', 'not_allowed');
begin
  if v_uid is null or p_id is null then
    return v_no;
  end if;

  select * into v_row from public.venue_messages m where m.id = p_id for update;
  if not found then
    return v_no;
  end if;

  if not public.is_anon_session()
     and v_row.location_id::text in (select public.user_accessible_locations()) then
    -- A Back Office login for this venue. Nothing the caller sends is used. The NAME is the one
    -- on its profile, which a login can edit on its own row (full_name is not pinned by
    -- user_profiles_fence_guard), so it is only a label. The PROOF is the email: taken from the
    -- sign in token itself (written by the auth server), then the profile's email (which the
    -- guard does pin). Company Admin shows both.
    -- The second sign in step, when this database has it (it does on production). Asked by
    -- name at run time: written as a plain call, a database WITHOUT 20260919s fails here with
    -- "function does not exist" (found on the local run, 5 Oct 2026).
    if to_regprocedure('public.second_step_ok()') is not null then
      execute 'select public.second_step_ok()' into v_ok;
      if v_ok is not true then
        return v_no;
      end if;
    end if;
    v_via := 'backoffice';
    v_user := v_uid;
    select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''))
      into v_name from public.user_profiles p where p.id = v_uid;
    v_email := nullif(btrim(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'), '');
    if v_email is null then
      select nullif(btrim(p.email), '') into v_email from public.user_profiles p where p.id = v_uid;
    end if;
    v_email := left(v_email, 320);
    v_name := coalesce(v_name, v_email, 'Back Office');
  else
    -- A till paired to THIS venue. Kiosks, kitchen screens and time clocks never confirm.
    select d.id, d.name into v_dev_id, v_dev
      from public.devices d
     where d.device_uid = v_uid
       and d.bound_via is not null
       and d.status in ('active', 'online')
       and d.location_id = v_row.location_id
       and coalesce(d.type, '') not in ('kiosk', 'kds', 'clock')
     order by d.bound_at desc nulls last
     limit 1;
    if v_dev_id is null then
      return v_no;
    end if;
    v_via := 'till';
    -- The member of staff signed in on that till (their till name), one line, 80 characters.
    v_name := nullif(left(btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]+', ' ', 'g'), '\s+', ' ', 'g')), 80), '');
    v_name := coalesce(v_name, nullif(btrim(v_dev), ''), 'Till');
  end if;

  if v_row.withdrawn_at is not null then
    return jsonb_build_object('ok', true, 'state', 'withdrawn');
  end if;
  if v_row.confirmed_at is not null then
    return jsonb_build_object('ok', true, 'state', 'confirmed', 'already', true,
                              'confirmed_by', v_row.confirmed_by, 'confirmed_at', v_row.confirmed_at);
  end if;

  update public.venue_messages m
     set confirmed_at = now(),
         confirmed_by = v_name,
         confirmed_via = v_via,
         confirmed_user_id = v_user,
         confirmed_email = v_email,
         confirmed_device_id = v_dev_id,
         confirmed_device_name = v_dev
   where m.id = p_id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'state', 'confirmed', 'already', false,
                            'confirmed_by', v_row.confirmed_by, 'confirmed_at', v_row.confirmed_at);
end
$fn$;

comment on function public.venue_message_confirm(uuid, text) is
  'Got it on a message from ServOS (5 Oct 2026). Sets only the confirm fields of a waiting row of the caller''s own venue. Back Office: the profile name as a label and the login''s email (from its token) as the proof. Till: paired to that venue, never a kiosk, kitchen screen or time clock.';

revoke all on function public.venue_message_confirm(uuid, text) from public, anon;
grant execute on function public.venue_message_confirm(uuid, text) to authenticated, service_role;

-- ── Realtime ────────────────────────────────────────────────────────────────
do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'venue_messages') then
    alter publication supabase_realtime add table public.venue_messages;
  end if;
end
$realtime$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): 1, true, 1 or 2, 0, 1, 1, 1.
--   policies is 2 when the second sign in step file (20260919s) has run here, which it has on
--   production, and 1 on a database without it.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'venue_messages') as table_added,
  (select c.relrowsecurity from pg_class c where c.oid = 'public.venue_messages'::regclass) as rls_on,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'venue_messages') as policies,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'venue_messages'
     and cmd in ('INSERT', 'UPDATE', 'DELETE')) as write_policies,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'venue_message_confirm') as confirm_function,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'venue_messages'
     and policyname = 'venue_messages_read_own_venue' and qual like '%venue_message_reader_location_ids%') as tills_only_read_rule,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'venue_messages') as realtime_on;
