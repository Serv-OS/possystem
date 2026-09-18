-- 20260918_OPS_caller_authority_log.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Safe to run any time. Creates one new table; changes nothing existing.   #
-- #  Run it BEFORE deploying the loyalty and gift card functions of branch    #
-- #  fix/loyalty-giftcard-exposure (they write here; until it exists they     #
-- #  only print the same row to the function log and carry on).              #
-- ############################################################################
--
-- WHY (18 Sep 2026 audit, round two). loyalty-earn, loyalty-redeem, loyalty-refund,
-- loyalty-member-lookup and loyalty-balance now decide who the caller is (a claimed device of
-- the company, staff with the location, or the member's own token). Enforcing that today would
-- refuse real tills and kiosks whose device claim is missing, so they run in REPORT mode first
-- (LOYALTY_AUTHORITY_MODE unset or 'report'): every call is allowed exactly as before, and each
-- one that enforce mode would refuse is written HERE, so it can be read with read only SQL and
-- fixed at the venue before anyone sets LOYALTY_AUTHORITY_MODE=enforce.
-- gift-list, gift-lookup and gift-redeem enforce already; their refusals land here too
-- (outcome 'refused', mode 'enforce'). Round three adds the functions that enforce now:
-- gift-issue, gift-import, gift-bulk-create, gift-config, gift-void, gift-resend,
-- gift-reverse-redeem, gift-fulfill, loyalty-config and loyalty-rewards writes, loyalty-enroll,
-- loyalty-member-lookup; and loyalty-earn's own check reasons (check_not_found,
-- check_not_earnable, check_not_this_member).
-- The report (read only) is supabase/queries/caller_authority_report.sql.
--
-- Rows hold no token, gift card code, phone number or email. location_id, customer_id and
-- closed_check_id are TEXT on purpose: they are what the caller SENT, which may be anything.
--
-- Written only by edge functions with the service role. RLS on with no policies, and no grants
-- to anon or authenticated, so no app session can read or write it.

create table if not exists public.caller_authority_log (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  fn               text not null,          -- edge function, e.g. 'loyalty-earn'
  mode             text not null,          -- 'report' | 'enforce'
  outcome          text not null,          -- 'would_refuse' (report) | 'refused' (enforce)
  caller_kind      text,                   -- 'anonymous' | 'device_other' | 'user_no_access' | 'member' | 'none' ...
  reason           text,                   -- 'anonymous_no_device' | 'member_token_invalid' | ...
  caller_id        uuid,                   -- auth uid of the session (anonymous or not)
  caller_anonymous boolean,
  company_id       uuid,
  location_id      text,
  customer_id      text,
  closed_check_id  text,
  channel          text,                   -- 'pos' | 'kiosk' | 'online' | 'qr' | ...
  detail           jsonb,                  -- device_hint (the till or kiosk id the client says it is), suppressed_before, ...
  ops_location_id  uuid,                   -- round three: the venue's OPS id, resolved server side from whichever id was sent
  venue_name       text                    -- round three: the venue's name at the time, for the report
);

-- Round three (18 Sep 2026): for a copy of the table created from the first draft of this file.
alter table public.caller_authority_log add column if not exists ops_location_id uuid;
alter table public.caller_authority_log add column if not exists venue_name text;

create index if not exists caller_authority_log_created_idx on public.caller_authority_log (created_at desc);
create index if not exists caller_authority_log_fn_idx on public.caller_authority_log (fn, created_at desc);
create index if not exists caller_authority_log_location_idx on public.caller_authority_log (location_id, created_at desc);
create index if not exists caller_authority_log_ops_location_idx on public.caller_authority_log (ops_location_id, created_at desc);

alter table public.caller_authority_log enable row level security;
revoke all on public.caller_authority_log from anon, authenticated;

-- RETENTION (round three). The functions already rate limit what they write (per caller, per
-- venue for anonymous callers, and a global cap per minute per function instance; dropped rows
-- are counted in detail.suppressed_before), so the table grows at most a few thousand rows an
-- hour under a flood. Keep 30 days: enough to watch a report period and a fortnight after
-- enforce. purge_caller_authority_log() deletes older rows; service role only. Run it by hand
-- from the SQL editor, or schedule it with pg_cron if the extension is on:
--   select cron.schedule('purge-caller-authority-log', '17 3 * * *', 'select public.purge_caller_authority_log(30)');
create or replace function public.purge_caller_authority_log(p_keep_days integer default 30)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted bigint;
begin
  delete from public.caller_authority_log
   where created_at < now() - make_interval(days => greatest(coalesce(p_keep_days, 30), 1));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_caller_authority_log(integer) from public, anon, authenticated;
grant execute on function public.purge_caller_authority_log(integer) to service_role;

comment on table public.caller_authority_log is
  'Calls to loyalty and gift card edge functions that LOYALTY_AUTHORITY_MODE=enforce would refuse (report mode) or that were refused. Service role only. 18 Sep 2026.';
