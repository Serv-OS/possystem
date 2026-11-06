-- 20261126b_PLATFORM_customer_app.sql
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 1 function, service role only. Changes no data by itself.          #
-- ############################################################################
--
-- WHY (6 Nov 2026)
--   Delete my account in the native customer app (Peter, 18 Sep 2026: wipe personal data, end
--   the membership and stamps, keep sales and gift ledgers). The membership (customer_loyalty,
--   the points balance) and the stamp card progress (customer_stamp_cards) live here, in the
--   Platform database; the personal fields live on Ops (20261126a_OPS_customer_app.sql).
--
-- WHAT THIS FILE ADDS
--   public.customer_app_end_loyalty(p_customer_id uuid)
--     One transaction: the customer's customer_loyalty rows (the membership, its points balance,
--     member code and wallet pass serial) and customer_stamp_cards rows (stamp progress) are
--     deleted; a member this person referred keeps their own membership and loses only the
--     referred_by pointer. Gift cards and gift card transactions are NOT touched (they are
--     matched by phone and the money stays), and the Ops ledgers (loyalty_transactions,
--     stamp_transactions) are another database. Answers a jsonb report with the points and
--     stamps forfeited. Safe to run twice (the second run finds nothing).
--
-- WHO MAY CALL
--   The service role only (the customer-app edge function, after it verified the member's own
--   token). Revoked from public, anon and authenticated.
--
-- Rollback: 20261126b_PLATFORM_customer_app_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.customer_loyalty') is null or to_regclass('public.customer_stamp_cards') is null then
    raise exception 'This is not the Platform database (customer_loyalty or customer_stamp_cards is missing). Nothing was changed.';
  end if;
end
$guard$;

create or replace function public.customer_app_end_loyalty(p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  pts bigint := 0;
  stamps bigint := 0;
  n_members integer := 0;
  n_cards integer := 0;
  n_referrals integer := 0;
begin
  if p_customer_id is null then
    raise exception 'customer id required';
  end if;

  select coalesce(sum(points_balance), 0) into pts from public.customer_loyalty where customer_id = p_customer_id;
  select coalesce(sum(stamps_collected), 0) into stamps from public.customer_stamp_cards where customer_id = p_customer_id;

  -- People this member referred keep their membership; only the pointer goes.
  update public.customer_loyalty set referred_by = null
   where referred_by in (select id from public.customer_loyalty where customer_id = p_customer_id);
  get diagnostics n_referrals = row_count;

  delete from public.customer_stamp_cards where customer_id = p_customer_id;
  get diagnostics n_cards = row_count;

  delete from public.customer_loyalty where customer_id = p_customer_id;
  get diagnostics n_members = row_count;

  return jsonb_build_object(
    'ok', true,
    'customer_id', p_customer_id,
    'memberships_ended', n_members,
    'points_forfeited', pts,
    'stamp_cards_ended', n_cards,
    'stamps_forfeited', stamps,
    'referrals_unlinked', n_referrals,
    'kept', jsonb_build_array('gift_cards', 'gift_card_transactions')
  );
end
$fn$;

-- ===== Who may call: the service role only =====
revoke all on function public.customer_app_end_loyalty(uuid) from public, anon, authenticated;
grant execute on function public.customer_app_end_loyalty(uuid) to service_role;

comment on function public.customer_app_end_loyalty(uuid) is
  'Customer app Delete my account (Platform side): ends the loyalty membership and the stamp cards; keeps gift cards. Service role only; the customer-app edge function calls it after verifying the member''s token.';

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): 1 function, nothing for the public key.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'customer_app_end_loyalty') as functions_added,
  has_function_privilege('anon', 'public.customer_app_end_loyalty(uuid)', 'execute') as anon_can_end,
  has_function_privilege('authenticated', 'public.customer_app_end_loyalty(uuid)', 'execute') as login_can_end,
  has_function_privilege('service_role', 'public.customer_app_end_loyalty(uuid)', 'execute') as service_can_end;
