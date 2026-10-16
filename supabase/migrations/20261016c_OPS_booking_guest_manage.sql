-- 20261016c_OPS_booking_guest_manage.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  RUN 20261016b_OPS_bookings_core.sql FIRST. This file stops, changing     #
-- #  nothing, when edit_booking is not there yet.                             #
-- #  Additive and safe to run twice. One transaction.                         #
-- #  One new table (booking_manage_tokens, one code per booking, closed to    #
-- #  the anon key) filled for every booking, and a trigger on bookings that   #
-- #  gives each new booking its code (it can never refuse a booking).         #
-- #  booking_rules gains three columns, booking_reminders five columns and    #
-- #  a wider kind list, one read policy for host stands, edit_booking gains   #
-- #  one line (the booking-widget function may call it), and the reminder    #
-- #  job runs every 5 minutes instead of every 15.                            #
-- #  Safe in service: no till reads anything new. The web app and the         #
-- #  functions work before and after (they feature detect every change).      #
-- ############################################################################
--
-- WHY (bookings audit 16 Oct 2026, section 3 items 1 and 2)
--   Every booking only system we compete with gives the guest a link to change or cancel, a
--   reminder the day before and on the day, and a message when anything changes. Today the
--   confirmation says "Need to change it? Call the venue" with no number, there is no reminder
--   at all (only the pre-order nag), and a failed text is retried every 15 minutes for ever
--   (101 failed sends to one demo number on 16 Oct).
--
-- WHAT THIS ADDS
--   1  booking_manage_tokens: a long random code for EVERY booking, minted by the database
--      whoever makes the booking (the booking page, the host stand, the till, Back Office), so
--      no app change is needed for the code to exist. It is the guest's key to
--      /book?manage=<code>. Every booking already made gets one too.
--      It is its own table, not a column on bookings, on purpose: bookings is still readable
--      with the public anon key (its old "allow all" policy) and is in the realtime feed, so a
--      code stored there could be read for every venue. This table has row level security,
--      no anon access at all, and is not in the realtime feed. Back Office logins and paired
--      host stands may read their own venue's codes (the Inspector's "Copy guest link").
--      The trigger that mints the code catches every error, so it can never stop a booking
--      being made; a booking that somehow has no code gets one the first time a function
--      needs it.
--   2  booking_rules.guest_manage_enabled (default on): guests may change or cancel online.
--      booking_rules.guest_messages_enabled (default on): the venue sends booking texts and
--      emails (confirmation, reminders, change and cancel messages).
--      booking_rules.guest_phone: the number guests are told to call (else the receipt phone).
--   3  booking_reminders becomes a proper send ledger: status (sending, sent, failed), attempts,
--      last_error, next_try_at and detail (what the guest was told: date, time, covers). A send
--      is tried at most 3 times. New kinds: reminder_day, reminder_2h, changed, cancelled.
--      Paired host stands may read it (the Inspector's Messages list).
--   4  edit_booking: the booking-widget function (service role) may call it. A guest change from
--      the manage page goes through the same guarded write as the host stand: the venue lock,
--      the free check, the seats check and the floor plan check. The rest of the function is
--      untouched; this file patches the fence line of whatever edit_booking is installed, and
--      re issues the grants by the function's own id, whatever its argument list is (the
--      final 20261016b has 11 arguments, an earlier draft had 10).
--   5  The booking-reminders job runs every 5 minutes (was 15), so a change or cancel made on
--      the host stand reaches the guest within 5 minutes.
--
-- AFTER RUNNING
--   Read the check select at the bottom. Then deploy the functions listed in the PR.

begin;

-- Fail fast rather than queue booking writes behind the trigger create: if a long transaction
-- holds bookings, this stops after 5 seconds and nothing is changed. Just run it again.
set local lock_timeout = '5s';

-- Wrong database guard (same test as 20260825f): Ops has user_locations and no billing_state.
do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking') then
    raise exception 'Run 20261016b_OPS_bookings_core.sql first (edit_booking is not there yet). Nothing was changed.';
  end if;
end
$guard$;

-- ── 1. booking_manage_tokens ─────────────────────────────────────────────────
-- 32 hex characters from a random uuid (122 random bits; short enough to keep the text message
-- short).
create table if not exists public.booking_manage_tokens (
  booking_id  text primary key references public.bookings(id) on delete cascade,
  location_id uuid not null,
  token       text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_at  timestamptz not null default now()
);
create index if not exists booking_manage_tokens_location_idx on public.booking_manage_tokens (location_id);
comment on table public.booking_manage_tokens is
  '16 Oct 2026: the guest''s key to /book?manage=<token> (change or cancel online), one per booking. Minted by the trigger bookings_mint_manage_token. Closed to the anon key; only the booking-widget function acts on it.';

alter table public.booking_manage_tokens enable row level security;
revoke all on public.booking_manage_tokens from public, anon, authenticated;
grant select on public.booking_manage_tokens to authenticated;
grant all on public.booking_manage_tokens to service_role;

-- Reads: a Back Office login for the venue, or a paired host stand at it. No insert, update or
-- delete policy: writes stay with the trigger and the service role.
drop policy if exists "bo read" on public.booking_manage_tokens;
create policy "bo read" on public.booking_manage_tokens
  for select to authenticated
  using (location_id::text in (select public.user_accessible_locations()));
drop policy if exists "host stand read" on public.booking_manage_tokens;
create policy "host stand read" on public.booking_manage_tokens
  for select to authenticated
  using (location_id in (select public.waitlist_writable_location_uuids()));
-- The Back Office second step fence every other table has (20260919s), when it is installed.
do $fence$
begin
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'second_step_ok')
     and not exists (select 1 from pg_policy where polrelid = 'public.booking_manage_tokens'::regclass and polname = 'second_step_fence') then
    execute 'create policy second_step_fence on public.booking_manage_tokens as restrictive for all to authenticated '
            'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))';
  end if;
end
$fence$;

-- The trigger: every new booking gets its code. Any error is caught and logged as a warning,
-- so a booking is never refused because of its code (the functions mint a missing one).
create or replace function public.bk_mint_manage_token()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    insert into public.booking_manage_tokens (booking_id, location_id)
    values (new.id, new.location_id)
    on conflict (booking_id) do nothing;
  exception when others then
    raise warning 'booking % has no guest link code yet (%)', new.id, sqlerrm;
  end;
  return null;
end
$function$;
revoke all on function public.bk_mint_manage_token() from public, anon, authenticated;

drop trigger if exists bookings_mint_manage_token on public.bookings;
create trigger bookings_mint_manage_token
  after insert on public.bookings
  for each row execute function public.bk_mint_manage_token();

-- Every booking already made.
insert into public.booking_manage_tokens (booking_id, location_id)
select b.id, b.location_id from public.bookings b where b.location_id is not null
on conflict (booking_id) do nothing;

-- ── 2. booking_rules: the venue's switches and the phone guests call ────────
alter table public.booking_rules add column if not exists guest_manage_enabled boolean not null default true;
alter table public.booking_rules add column if not exists guest_messages_enabled boolean not null default true;
alter table public.booking_rules add column if not exists guest_phone text;
comment on column public.booking_rules.guest_manage_enabled is
  '16 Oct 2026: guests may change or cancel online up to cancellation_window_hours before the booking.';
comment on column public.booking_rules.guest_messages_enabled is
  '16 Oct 2026: the venue sends booking confirmations, reminders and change or cancel messages by text and email.';
comment on column public.booking_rules.guest_phone is
  '16 Oct 2026: the number booking messages and the guest page tell guests to call. Empty = the phone on the receipt.';

-- ── 3. booking_reminders: a send ledger with a retry limit ──────────────────
alter table public.booking_reminders drop constraint if exists booking_reminders_kind_check;
alter table public.booking_reminders add constraint booking_reminders_kind_check
  check (kind = any (array['preorder', 'confirmation', 'reminder_day', 'reminder_2h', 'changed', 'cancelled']));
alter table public.booking_reminders add column if not exists status text not null default 'sent';
alter table public.booking_reminders add column if not exists attempts integer not null default 1;
alter table public.booking_reminders add column if not exists last_error text;
alter table public.booking_reminders add column if not exists next_try_at timestamptz;
alter table public.booking_reminders add column if not exists detail jsonb;
alter table public.booking_reminders drop constraint if exists booking_reminders_status_check;
alter table public.booking_reminders add constraint booking_reminders_status_check
  check (status = any (array['sending', 'sent', 'failed']));
create index if not exists booking_reminders_retry_idx
  on public.booking_reminders (next_try_at) where status = 'failed';
create index if not exists booking_reminders_sending_idx
  on public.booking_reminders (sent_at) where status = 'sending';
comment on column public.booking_reminders.status is
  '16 Oct 2026: sending (claimed; a claim older than 10 minutes counts as a failed try), sent, or failed (tried attempts times; retried until 3).';
comment on column public.booking_reminders.detail is
  '16 Oct 2026: what the guest was told in this message: { date, time, covers }. The change check compares against it.';

-- Paired host stands read the ledger for the Inspector's Messages list (select only; writes stay
-- with the service role, there is no insert, update or delete policy). Same predicate as the
-- booking_payments host stand read (20260825f).
drop policy if exists "host stand read" on public.booking_reminders;
create policy "host stand read" on public.booking_reminders
  for select to authenticated
  using (location_id in (select public.waitlist_writable_location_uuids()));

-- ── 4. edit_booking: the booking-widget function may call it ────────────────
-- The fence asks for a signed in login, a paired till or a paired stand (auth.uid()). A
-- function using the service role key has no auth.uid(), so a guest change was refused as
-- 'no access'. This adds "or the caller is the service role" to that one test. The service
-- role can already write any table; nothing new is opened to a browser.
do $patch$
declare
  v_def text;
  v_new text;
  n     int;
begin
  select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking';
  if n <> 1 then
    raise exception 'There are % edit_booking functions, expected 1. Nothing was changed. Send this message to Claude.', n;
  end if;
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking';
  if position('service_role' in v_def) > 0 then
    raise notice 'edit_booking already lets the service role in, left as it is';
    return;
  end if;
  v_new := replace(v_def,
    'if auth.uid() is null or not (',
    'if coalesce(auth.role(), '''') <> ''service_role'' and (auth.uid() is null or not (');
  v_new := replace(v_new,
    E'  ) then\n    return jsonb_build_object(''ok'', false, ''error'', ''no access'');',
    E'  )) then\n    return jsonb_build_object(''ok'', false, ''error'', ''no access'');');
  if v_new = v_def
     or position('service_role' in v_new) = 0
     or position(E')) then\n    return jsonb_build_object(''ok'', false, ''error'', ''no access'');' in v_new) = 0 then
    raise exception 'edit_booking is not the version 20261016b installed (its fence lines differ). Nothing was changed. Send this message to Claude.';
  end if;
  execute v_new;
end
$patch$;

-- The grants edit_booking had (20261016b), re issued. Named by the function's own id, so this
-- works whatever its argument list is.
do $grants$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking'
  loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('grant execute on function %s to anon, authenticated, service_role', r.sig);
  end loop;
end
$grants$;

-- ── 5. the reminder job every 5 minutes ──────────────────────────────────────
-- Same job as 20260825d (pg_net straight to the function URL, which survived the 22 Sep
-- upgrade because it does not go through edge_base_url), new cadence. Each run is ledger gated,
-- so a faster cadence can never send twice.
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'booking-reminders-nudge';
    perform cron.schedule(
      'booking-reminders-nudge',
      '*/5 * * * *',
      $job$
      select net.http_post(
        url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/booking-reminders',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := '{"action": "send_due"}'::jsonb
      );
      $job$
    );
  else
    raise warning 'pg_cron is not installed: booking reminders will not run on a schedule';
  end if;
end
$cron$;

commit;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   tokens_table 1, bookings_without_token 0, token_trigger 1, tokens_closed_to_anon 1,
--   tokens_policies 2, rules_new_cols 3, ledger_new_cols 5, ledger_kinds_ok 1,
--   host_stand_read 1, edit_service_role 1, edit_fence_kept 1, edit_anon_grant 1, cron_every_5 1
select
  (select count(*) from pg_class where oid = to_regclass('public.booking_manage_tokens') and relrowsecurity) as tokens_table,
  (select count(*) from public.bookings b where b.location_id is not null
     and not exists (select 1 from public.booking_manage_tokens t where t.booking_id = b.id)) as bookings_without_token,
  (select count(*) from pg_trigger where tgrelid = 'public.bookings'::regclass and tgname = 'bookings_mint_manage_token' and not tgisinternal) as token_trigger,
  (select case when has_table_privilege('anon', 'public.booking_manage_tokens', 'select') then 0 else 1 end) as tokens_closed_to_anon,
  (select count(*) from pg_policy where polrelid = 'public.booking_manage_tokens'::regclass and polname in ('bo read', 'host stand read')) as tokens_policies,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_rules'
      and column_name in ('guest_manage_enabled', 'guest_messages_enabled', 'guest_phone')) as rules_new_cols,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_reminders'
      and column_name in ('status', 'attempts', 'last_error', 'next_try_at', 'detail')) as ledger_new_cols,
  (select count(*) from pg_constraint where conname = 'booking_reminders_kind_check'
     and pg_get_constraintdef(oid) like '%reminder_2h%') as ledger_kinds_ok,
  (select count(*) from pg_policy where polrelid = 'public.booking_reminders'::regclass and polname = 'host stand read') as host_stand_read,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking'
     and pg_get_functiondef(p.oid) like '%service_role%') as edit_service_role,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking'
     and pg_get_functiondef(p.oid) like '%waitlist_can_write(p_location_id)%') as edit_fence_kept,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking'
     and has_function_privilege('anon', p.oid, 'execute')) as edit_anon_grant,
  (select count(*) from cron.job where jobname = 'booking-reminders-nudge' and schedule = '*/5 * * * *') as cron_every_5;
