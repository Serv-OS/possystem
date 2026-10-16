-- 20261016c_OPS_booking_guest_manage.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  RUN 20261016b_OPS_bookings_core.sql FIRST. This file stops, changing     #
-- #  nothing, when edit_booking is not there yet.                             #
-- #  Additive and safe to run twice. One transaction.                         #
-- #  bookings gains one column (manage_token, filled for every row: the      #
-- #  table is rewritten once, about 180 rows, under a 5 second lock limit).   #
-- #  booking_rules gains three columns, booking_reminders five columns and    #
-- #  a wider kind list, one read policy for host stands, edit_booking gains   #
-- #  one line (the booking-widget function may call it), and the reminder    #
-- #  job runs every 5 minutes instead of every 15.                            #
-- #  Safe in service: no till reads or writes anything new. The web app and   #
-- #  the functions work before and after (they feature detect every change). #
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
--   1  bookings.manage_token: a long random code minted by the database for EVERY new booking,
--      whoever makes it (the booking page, the host stand, the till, Back Office), so no app
--      change is needed for the code to exist. It is the guest's key to /book?manage=<code>.
--      Every booking already made gets one too.
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
--      untouched; this file patches the fence line of whatever edit_booking is installed.
--   5  The booking-reminders job runs every 5 minutes (was 15), so a change or cancel made on
--      the host stand reaches the guest within 5 minutes.
--
-- AFTER RUNNING
--   Read the check select at the bottom. Then deploy the functions listed in the PR.

begin;

-- Fail fast rather than queue booking reads behind the ALTERs: if a long transaction holds
-- bookings, this stops after 5 seconds and nothing is changed. Just run it again.
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

-- ── 1. bookings.manage_token ─────────────────────────────────────────────────
-- 64 hex characters from two random uuids, the same shape as preorder_token. A volatile
-- default fills every existing row with its own value when the column is added.
alter table public.bookings
  add column if not exists manage_token text
  default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
-- A second run, or a row written by a client that sent null on purpose: give it a code.
update public.bookings
   set manage_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
 where manage_token is null;
create unique index if not exists bookings_manage_token_key on public.bookings (manage_token);
comment on column public.bookings.manage_token is
  '16 Oct 2026: the guest''s key to /book?manage=<token> (change or cancel online). Minted by the database for every booking. Only the booking-widget function acts on it.';

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
comment on column public.booking_reminders.status is
  '16 Oct 2026: sending (claimed), sent, or failed (tried attempts times; retried until 3).';
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
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking'
   limit 1;
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

-- The grants edit_booking had (20261016b), re issued.
revoke all on function public.edit_booking(text, uuid, date, time without time zone, integer, integer, text[], text, text, jsonb) from public;
grant execute on function public.edit_booking(text, uuid, date, time without time zone, integer, integer, text[], text, text, jsonb)
  to anon, authenticated, service_role;

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
--   manage_token_col 1, bookings_without_token 0, manage_token_unique 1, rules_new_cols 3,
--   ledger_new_cols 5, ledger_kinds_ok 1, host_stand_read 1, edit_service_role 1,
--   edit_fence_kept 1, edit_anon_grant 1, cron_every_5 1
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings' and column_name = 'manage_token') as manage_token_col,
  (select count(*) from public.bookings where manage_token is null) as bookings_without_token,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'bookings_manage_token_key') as manage_token_unique,
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
  (select case when has_function_privilege('anon',
     'public.edit_booking(text, uuid, date, time without time zone, integer, integer, text[], text, text, jsonb)', 'execute')
     then 1 else 0 end) as edit_anon_grant,
  (select count(*) from cron.job where jobname = 'booking-reminders-nudge' and schedule = '*/5 * * * *') as cron_every_5;
