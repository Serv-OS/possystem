-- 20261123a_OPS_update_email_blocks.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 1 new table. Touches no existing table and no existing row, so it   #
-- #  is safe any time, service included.                                      #
-- ############################################################################
--
-- WHY (Peter, 5 Nov 2026): "Admin Area Emails Blocking. Be able to remove a user or delete a
-- user and add unsubscribe button to emails so they dont receive them again." Then: "just been
-- able to remove or delete a user and it removes them from the email part."
--   So: on Company Admin, Email an update, a person can be removed from the list (and put back),
--   and every update email carries an unsubscribe link that removes the person by itself. Both
--   land here, one row per address. The recipient picker leaves these addresses out of every
--   send from then on.
--
-- WHAT THIS FILE DOES
--   public.update_email_blocks   one row per ADDRESS that never gets an update email again.
--                                Who it is (address, login id and name when known), why
--                                (removed by ServOS staff on the screen, or unsubscribed from
--                                an email), who did it and when.
--   Reading and writing          nobody through the API. Row level security on, no policy, no
--                                grant to anon or authenticated. The update-emails-admin edge
--                                function (service role) is the only reader and the only writer.
--                                The unsubscribe link in an email reaches that function with a
--                                signed token for ONE address; the function checks the signature
--                                and writes the row. Nothing on the link can block anyone else.
--
-- BEFORE AND AFTER IT RUNS
--   Before: the app works as today. The screen's Removed from emails card says it needs this
--           update; Remove and the unsubscribe link say the same. Sends go to everyone as before.
--   After:  deploy the update-emails-admin function. Remove, Put back and the unsubscribe link
--           work; the recipient list and every send leave blocked addresses out.
--
-- Rollback: 20261123a_OPS_update_email_blocks_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.devices') is null then
    raise exception 'This is not the Ops database (device_profiles or devices is missing). Nothing was changed.';
  end if;
  if to_regclass('public.update_emails') is null then
    raise exception 'update_emails is missing: run 20261008b_OPS_update_emails.sql first. Nothing was changed.';
  end if;
end
$guard$;

-- Fail fast instead of making anything queue behind this script.
set local lock_timeout = '3s';

create table if not exists public.update_email_blocks (
  email          text primary key,
  user_id        uuid,
  name           text,
  org_id         uuid,
  reason         text not null default 'removed',
  blocked_by     uuid,
  blocked_by_name text,
  blocked_at     timestamptz not null default now(),
  constraint update_email_blocks_reason_ok check (reason in ('removed', 'unsubscribed')),
  constraint update_email_blocks_email_ok check (char_length(email) between 3 and 320 and email = lower(email))
);

comment on table public.update_email_blocks is
  'Addresses that never get a ServOS update email again (5 Nov 2026): removed on Company Admin or unsubscribed from an email. Written and read only by the update-emails-admin edge function (service role). supabase/functions/_shared/updateEmailRules.js.';

create index if not exists update_email_blocks_at_idx on public.update_email_blocks (blocked_at desc);

-- Row level security, written out
alter table public.update_email_blocks enable row level security;

-- Nothing for anybody through the API: no policy, no grant. The service role (the edge
-- function) does everything, after it has checked who is asking.
revoke all on table public.update_email_blocks from public, anon, authenticated;
grant all on table public.update_email_blocks to service_role;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): 1, true, 0, 0.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'update_email_blocks') as table_added,
  (select c.relrowsecurity from pg_class c where c.oid = 'public.update_email_blocks'::regclass) as rls_on,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'update_email_blocks') as policies,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'update_email_blocks' and grantee in ('anon', 'authenticated')) as api_grants;
