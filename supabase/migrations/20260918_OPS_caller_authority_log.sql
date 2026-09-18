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
-- (outcome 'refused', mode 'enforce').
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
  detail           jsonb
);

create index if not exists caller_authority_log_created_idx on public.caller_authority_log (created_at desc);
create index if not exists caller_authority_log_fn_idx on public.caller_authority_log (fn, created_at desc);
create index if not exists caller_authority_log_location_idx on public.caller_authority_log (location_id, created_at desc);

alter table public.caller_authority_log enable row level security;
revoke all on public.caller_authority_log from anon, authenticated;

comment on table public.caller_authority_log is
  'Calls to loyalty and gift card edge functions that LOYALTY_AUTHORITY_MODE=enforce would refuse (report mode) or that were refused. Service role only. 18 Sep 2026.';
