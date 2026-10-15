-- 20261008b_OPS_update_emails.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 1 new table. Touches no existing table and no existing row, so it   #
-- #  is safe any time, service included.                                      #
-- ############################################################################
--
-- WHY (Peter, 8 Oct 2026): he writes a what's new email for clients each week. "Do we have a
-- way to email it to people that are registered in the back office? Right now it's only a few
-- and I can manually send, but would be good to be able to send it out."
--   His calls: a panel on Company Admin, Messages to venues. Subject plus a body in simple
--   Markdown with a live preview; pick companies (all or some); every owner or manager login
--   with Back Office access and an email gets one email; a test to himself first, and Send only
--   opens once a test of the current text has gone; one row per person per send, kept here.
--
-- WHY A NEW TABLE (and not receipt_emails or marketing_messages)
--   receipt_emails is a venue's own receipts (venue scoped, read by the venue). marketing_messages
--   is a venue's marketing to ITS customers, with consent and unsubscribe rules that do not apply
--   to a service notice from ServOS to an account holder. This is ServOS writing to its clients:
--   it needs who sent it, which login got it, which company that login is for, what the provider
--   said, and a safe second try (one row per person per send), and none of it readable by a
--   venue. Same shape as venue_messages (20261005a): written only by an edge function under the
--   service role, after it has checked the caller is ServOS staff.
--
-- WHAT THIS FILE DOES
--   public.update_emails    one row per RECIPIENT per send (a send to 7 people is 7 rows sharing
--                           a broadcast_id). The row holds the subject and the Markdown body as
--                           sent, who it went to (email, login id, name, company, role), who sent
--                           it, the provider and its id, and queued / sent / failed with the
--                           provider's error. A test the sender sent to themself is a row too,
--                           marked is_test, so the server can see that the text was tested
--                           before it lets a real send go.
--   Reading and writing     nobody through the API. Row level security on, no policy, no grant
--                           to anon or authenticated. The update-emails-admin edge function
--                           (service role) is the only reader and the only writer.
--   One send, one text      (broadcast_id, to_email) is unique: a second try of the same send
--                           after a lost reply can never email the same person twice. The
--                           function refuses a changed text under an old id (409).
--
-- BEFORE AND AFTER IT RUNS
--   Before: the app works as today. Company Admin, Messages to venues shows the Email an update
--   panel and says it needs this update. Nothing can be sent.
--   After: deploy the update-emails-admin function, then send from Company Admin.
--
-- Rollback: 20261008b_OPS_update_emails_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.devices') is null then
    raise exception 'This is not the Ops database (device_profiles or devices is missing). Nothing was changed.';
  end if;
  if to_regclass('public.user_profiles') is null or to_regclass('public.organisations') is null then
    raise exception 'user_profiles or organisations is missing. This is not the database this file was written for. Nothing was changed.';
  end if;
end
$guard$;

-- Fail fast instead of making anything queue behind this script.
set local lock_timeout = '3s';

create table if not exists public.update_emails (
  id            uuid primary key default gen_random_uuid(),
  broadcast_id  uuid not null,
  subject       text not null,
  body_md       text not null,
  to_email      text not null,
  to_user_id    uuid,
  to_name       text,
  org_id        uuid,
  role          text,
  sent_by       uuid,
  sent_by_name  text,
  sent_at       timestamptz not null default now(),
  provider      text,
  provider_id   text,
  status        text not null default 'queued',
  error         text,
  is_test       boolean not null default false,
  constraint update_emails_status_ok check (status in ('queued', 'sent', 'failed')),
  constraint update_emails_subject_ok check (char_length(subject) between 1 and 120),
  constraint update_emails_body_ok check (char_length(body_md) between 1 and 15000),
  constraint update_emails_email_ok check (char_length(to_email) between 3 and 320),
  constraint update_emails_once_per_person unique (broadcast_id, to_email)
);

comment on table public.update_emails is
  'Emails from ServOS to Back Office logins (8 Oct 2026). One row per recipient per send; a test to the sender is a row marked is_test. Written and read only by the update-emails-admin edge function (service role). supabase/functions/_shared/updateEmailRules.js.';

-- For a database where an earlier draft of this file already made the table.
alter table public.update_emails add column if not exists is_test boolean not null default false;

create index if not exists update_emails_sent_idx on public.update_emails (sent_at desc);
create index if not exists update_emails_broadcast_idx on public.update_emails (broadcast_id);
-- The "was this text tested by this sender" lookup before a real send.
create index if not exists update_emails_test_idx on public.update_emails (sent_by, is_test, sent_at desc);

-- ── Row level security, written out ─────────────────────────────────────────
alter table public.update_emails enable row level security;

-- Nothing for anybody through the API: no policy, no grant. A venue never reads another
-- venue's owners' addresses, and nobody can forge or alter a send. The service role (the edge
-- function) does everything.
revoke all on table public.update_emails from public, anon, authenticated;
grant all on table public.update_emails to service_role;

-- No read, insert, update or delete policy: with row level security on, that means refused.
-- No second step fence policy either: it would guard a door that is not there (authenticated
-- holds no grant on this table at all).

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): 1, true, 0, 0, 1, 1.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'update_emails') as table_added,
  (select c.relrowsecurity from pg_class c where c.oid = 'public.update_emails'::regclass) as rls_on,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'update_emails') as policies,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'update_emails' and grantee in ('anon', 'authenticated')) as api_grants,
  (select count(*) from pg_constraint
    where conrelid = 'public.update_emails'::regclass and conname = 'update_emails_once_per_person') as once_per_person,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'update_emails' and column_name = 'is_test') as test_column;
