-- 20260806c_redeem_atomic.sql
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  ⚠⚠⚠  THIS FILE CONTAINS **TWO** MIGRATIONS FOR **TWO DIFFERENT**    ⚠⚠⚠ ║
-- ║  ⚠⚠⚠  DATABASES.  DO NOT PASTE THE WHOLE FILE INTO ONE SQL EDITOR.   ⚠⚠⚠ ║
-- ║                                                                          ║
-- ║    SECTION A  →  OPS DB        project ref  tbetcegmszzotrwdtqhi         ║
-- ║    SECTION B  →  PLATFORM DB   project ref  yhzjgyrkyjabvhblqxzu         ║
-- ║                                                                          ║
-- ║  Each section opens with a guard that ABORTS if you are connected to     ║
-- ║  the wrong project (same shape as 20260805c_anon_fences.sql), and each   ║
-- ║  is wrapped in its own begin;/commit;.  Run Section A, confirm, then     ║
-- ║  run Section B.                                                          ║
-- ║                                                                          ║
-- ║  ⚠ BOTH SECTIONS MUST BE APPLIED **BEFORE** promo-redeem and             ║
-- ║    loyalty-redeem are deployed — those functions call the RPCs below     ║
-- ║    and will 500 on every redemption until they exist.                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- WHY THIS EXISTS
-- v5.5.974-978 moved both redeem paths to "insert the idempotency guard row FIRST,
-- then do the consuming write". That killed double-deduction but opened two holes:
--
--   1. CRASH WINDOW. If the isolate dies (or is evicted, or the DB blips) between
--      the guard insert and the consuming write, the guard row survives while
--      nothing was consumed. The next call short-circuits on the guard row and
--      reports success. The customer got the discount, the code/points stayed
--      fully spendable, and nobody was told.
--
--   2. THE SHARPER RACE. Request A inserts the guard row and stalls. The client's
--      deadline fires and replays as request B. B hits the 23505 and returns
--      success. A then loses its compare-and-swap, DELETES its own guard row and
--      returns already_used. Net: nothing recorded, nothing consumed, and the
--      client was told it succeeded.
--
-- Both holes exist because the guard and the consuming write are two independent
-- round trips with a rollback DELETE papering over the gap. A transaction cannot
-- leave half of itself behind, so the fix is to put both writes inside one.
--
-- ⚠ WHY THERE IS A SECTION B — READ THIS BEFORE ASSUMING IT IS SCOPE CREEP.
--   The promo path is entirely on Ops (promo_codes / promo_redemptions / offers),
--   so one function on Ops closes it completely.
--   The loyalty POINTS path is NOT: the ledger row is ops.loyalty_transactions and
--   the balance is platform.customer_loyalty — two separate Postgres clusters.
--   Verified 6 Aug 2026: customer_loyalty does not exist on Ops, and
--   loyalty_transactions does not exist on Platform. No single-database function
--   can wrap that pair, so the atomic unit has to be built where the MONEY is —
--   the balance debit and its idempotency claim, together, on Platform. The Ops
--   ledger row then becomes an after-the-fact audit write that a retry re-lands
--   (see the header of loyalty-redeem/index.ts for the resulting ordering).
--
-- Column names, types and unique indexes below were read off both live databases
-- on 6 Aug 2026 (information_schema.columns + pg_indexes), not from this folder.
--
-- If you paste into the Supabase dashboard SQL editor it already opens its own
-- transaction, so the explicit `begin;` will log
-- "WARNING: there is already a transaction in progress". That is expected.


-- ══════════════════════════════════════════════════════════════════════════
--
--   SECTION A  ——  OPS DB ONLY  ——  project ref  tbetcegmszzotrwdtqhi
--
-- ══════════════════════════════════════════════════════════════════════════

begin;

-- Wrong-database guard. Ops has user_locations and no billing_state; Platform is
-- the other way round (verified 6 Aug 2026).
do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null
     or to_regclass('public.promo_codes') is null then
    raise exception
      'SECTION A must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it — aborting.';
  end if;
end
$guard$;

-- ──────────────────────────────────────────────────────────────────────────
-- A1. promo_redeem_atomic — the promo guard row and the use consumption
-- ──────────────────────────────────────────────────────────────────────────
-- Replaces promo-redeem's three-round-trip sequence (insert ledger → CAS
-- uses_count → delete ledger on a lost CAS) with one transaction.
--
-- The caller still owns eligibility (status/expiry/venue/min-spend/per-customer
-- limit) — that needs the offer row and the basket, and re-deriving it here would
-- duplicate computeDiscount(). What moves in here is only the part that has to be
-- indivisible: the consumption of a use and the ledger row recording it.
--
-- p_expected_uses is promo_codes.uses_count as the caller read it during
-- eligibility. Keeping the compare-and-swap (rather than relying on the row lock
-- alone) means a code whose state moved under a slow evaluate() is refused rather
-- than redeemed against a stale discount.
--
-- Result is discriminated, never a bare boolean:
--   {"result":"redeemed","redemption_id":<uuid>,"uses_count":<int>}
--   {"result":"already_used"}      — lost the CAS, or the code is spent
--   {"result":"idempotent_hit"}    — this idempotency_key already redeemed
--   {"result":"not_found"}         — the code row disappeared between calls
create or replace function public.promo_redeem_atomic(
  p_code_id         uuid,
  p_expected_uses   integer,
  p_offer_id        uuid,
  p_org_id          uuid,
  p_code            text,
  p_customer_id     uuid,
  p_location_id     text,
  p_order_id        text,
  p_staff_id        uuid,
  p_basket_value    numeric,
  p_discount_value  numeric,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_code   public.promo_codes%rowtype;
  v_new    integer;
  v_red_id uuid;
begin
  -- Serialises every concurrent redemption of THIS code. Everything below runs
  -- with the row locked, so neither the idempotency probe nor the guard can be
  -- overtaken between the read and the write.
  select * into v_code from public.promo_codes where id = p_code_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if p_idempotency_key is not null
     and exists (select 1 from public.promo_redemptions
                  where idempotency_key = p_idempotency_key) then
    return jsonb_build_object('result', 'idempotent_hit');
  end if;

  if v_code.uses_count is distinct from p_expected_uses
     or v_code.uses_count >= coalesce(v_code.uses_allowed, 1) then
    return jsonb_build_object('result', 'already_used');
  end if;

  v_new := v_code.uses_count + 1;

  insert into public.promo_redemptions (
    promo_code_id, offer_id, org_id, code, customer_id, location_id,
    order_id, staff_id, basket_value, discount_value, idempotency_key
  ) values (
    p_code_id, p_offer_id, p_org_id, p_code, p_customer_id, p_location_id,
    p_order_id, p_staff_id, p_basket_value, p_discount_value, p_idempotency_key
  ) returning id into v_red_id;

  update public.promo_codes set
    uses_count           = v_new,
    status               = case when v_new >= coalesce(uses_allowed, 1) then 'redeemed' else status end,
    redeemed_at          = now(),
    redeemed_order_id    = p_order_id,
    redeemed_location_id = p_location_id,
    redeemed_value       = p_discount_value,
    redeemed_staff_id    = p_staff_id,
    updated_at           = now()
  where id = p_code_id;

  -- Was a separate best-effort call in the edge function. Same database, same
  -- transaction, so it now either happens with the redemption or not at all.
  update public.offers
     set redeemed_count = coalesce(redeemed_count, 0) + 1,
         updated_at     = now()
   where id = p_offer_id;

  return jsonb_build_object('result', 'redeemed', 'redemption_id', v_red_id, 'uses_count', v_new);

exception when unique_violation then
  -- Only reachable if two callers share an idempotency key across DIFFERENT codes
  -- (the row lock serialises same-code callers, and the probe above catches them).
  -- The handler's subtransaction rolls the block back, so no use was consumed here.
  return jsonb_build_object('result', 'idempotent_hit');
end;
$fn$;

-- service_role only: the only caller is the promo-redeem edge function, which
-- holds SUPABASE_SERVICE_ROLE_KEY. `public` must be named explicitly — EXECUTE is
-- granted to PUBLIC by default and revoking anon/authenticated alone leaves it.
revoke all on function public.promo_redeem_atomic(
  uuid, integer, uuid, uuid, text, uuid, text, text, uuid, numeric, numeric, text
) from public, anon, authenticated;

grant execute on function public.promo_redeem_atomic(
  uuid, integer, uuid, uuid, text, uuid, text, text, uuid, numeric, numeric, text
) to service_role;

commit;

-- ── SECTION A post-apply verification (run separately) ────────────────────
-- select proname, prosecdef, proconfig, proacl from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and proname = 'promo_redeem_atomic';
-- -- prosecdef must be true, proconfig must contain search_path=public, and
-- -- proacl must show service_role=X with no anon/authenticated/PUBLIC entry.


-- ══════════════════════════════════════════════════════════════════════════
--
--   SECTION B  ——  PLATFORM DB ONLY  ——  project ref  yhzjgyrkyjabvhblqxzu
--
-- ══════════════════════════════════════════════════════════════════════════

begin;

-- Wrong-database guard.
do $guard$
begin
  if to_regclass('public.billing_state') is null
     or to_regclass('public.user_locations') is not null
     or to_regclass('public.customer_loyalty') is null then
    raise exception
      'SECTION B must be run against the PLATFORM DB (yhzjgyrkyjabvhblqxzu). This is not it — aborting.';
  end if;
end
$guard$;

-- ──────────────────────────────────────────────────────────────────────────
-- B1. loyalty_redemption_claims — the idempotency anchor for the points debit
-- ──────────────────────────────────────────────────────────────────────────
-- There is no loyalty ledger on Platform (loyalty_transactions lives on Ops), so
-- the debit had nothing on its own database to be idempotent against. This is
-- that anchor, and nothing else: one row per settled debit, keyed by the same
-- idempotency_key the Ops ledger row carries.
--
-- It doubles as the durable record if the Ops ledger write afterwards fails —
-- membership, points, reward and timestamp are all here.
create table if not exists public.loyalty_redemption_claims (
  idempotency_key text        primary key,
  membership_id   uuid        not null,
  company_id      uuid,
  reward_id       uuid,
  points          integer     not null,
  balance_after   integer     not null,
  created_at      timestamptz not null default now()
);

-- RLS on with NO policies: only service_role (which bypasses RLS) and the
-- SECURITY DEFINER function below can reach it. The revoke is defence in depth
-- against a permissive policy being pasted in from the dashboard later.
alter table public.loyalty_redemption_claims enable row level security;
revoke all on table public.loyalty_redemption_claims from anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- B2. loyalty_redeem_points — claim + debit, in one transaction
-- ──────────────────────────────────────────────────────────────────────────
-- Replaces loyalty-utils' updateBalance() for the REDEEM path only (earn and
-- refund still use it, and are unaffected — they are not idempotency-keyed).
--
-- updateBalance() is a read-modify-compare-and-swap with no key, which is why the
-- edge function could not simply re-run it after a crash: a second call debits a
-- second time. Keyed here, a replay is a no-op that returns the settled numbers.
--
-- points_redeemed_total and loyalty_rewards.total_redeemed were separate
-- best-effort calls in the edge function; both are on this database and both are
-- now inside the same transaction as the debit, so they cannot drift from it.
--
-- Result is discriminated, never a bare balance:
--   {"result":"redeemed","balance":<int>,"points_deducted":<int>}
--   {"result":"already_redeemed","balance":<int>,"points_deducted":<int>}
--   {"result":"insufficient","balance":<int>}
--   {"result":"not_found"}
create or replace function public.loyalty_redeem_points(
  p_membership_id   uuid,
  p_points          integer,
  p_idempotency_key text,
  p_reward_id       uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_member public.customer_loyalty%rowtype;
  v_claim  public.loyalty_redemption_claims%rowtype;
  v_new    integer;
begin
  -- Without a key this function has no idempotency at all, which is the whole
  -- point of it — refuse rather than silently behaving like the old path.
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'loyalty_redeem_points requires an idempotency key';
  end if;
  if coalesce(p_points, 0) < 0 then
    raise exception 'loyalty_redeem_points: p_points must not be negative';
  end if;

  -- Lock first, then probe: this serialises concurrent redemptions for the member,
  -- so the claim lookup cannot be overtaken between the read and the insert.
  select * into v_member from public.customer_loyalty where id = p_membership_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into v_claim from public.loyalty_redemption_claims
   where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'result', 'already_redeemed',
      'balance', coalesce(v_member.points_balance, 0),
      'points_deducted', v_claim.points);
  end if;

  if coalesce(v_member.points_balance, 0) < p_points then
    return jsonb_build_object('result', 'insufficient', 'balance', coalesce(v_member.points_balance, 0));
  end if;

  v_new := coalesce(v_member.points_balance, 0) - p_points;

  update public.customer_loyalty set
    points_balance        = v_new,
    points_redeemed_total = coalesce(points_redeemed_total, 0) + p_points,
    last_redeem_at        = now()
  where id = p_membership_id;

  insert into public.loyalty_redemption_claims
    (idempotency_key, membership_id, company_id, reward_id, points, balance_after)
  values
    (p_idempotency_key, p_membership_id, v_member.company_id, p_reward_id, p_points, v_new);

  if p_reward_id is not null then
    update public.loyalty_rewards
       set total_redeemed = coalesce(total_redeemed, 0) + 1,
           updated_at     = now()
     where id = p_reward_id;
  end if;

  return jsonb_build_object('result', 'redeemed', 'balance', v_new, 'points_deducted', p_points);

exception when unique_violation then
  -- Only reachable if the same key is used against two DIFFERENT memberships (the
  -- row lock serialises same-member callers). The handler's subtransaction rolls
  -- the debit back, so nothing was deducted here.
  select * into v_claim from public.loyalty_redemption_claims
   where idempotency_key = p_idempotency_key;
  return jsonb_build_object(
    'result', 'already_redeemed',
    'balance', coalesce((select points_balance from public.customer_loyalty where id = p_membership_id), 0),
    'points_deducted', coalesce(v_claim.points, p_points));
end;
$fn$;

-- service_role only. Note the contrast with redeem_gift_card_atomic() on this same
-- database, which is not SECURITY DEFINER and is executable by anon — do not copy
-- that as the pattern.
revoke all on function public.loyalty_redeem_points(uuid, integer, text, uuid)
  from public, anon, authenticated;

grant execute on function public.loyalty_redeem_points(uuid, integer, text, uuid)
  to service_role;

commit;

-- ── SECTION B post-apply verification (run separately) ────────────────────
-- select proname, prosecdef, proconfig, proacl from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and proname = 'loyalty_redeem_points';
-- select relrowsecurity, relacl from pg_class
--  where oid = 'public.loyalty_redemption_claims'::regclass;
--
-- ── SMOKE TEST (both sections applied, both functions deployed) ────────────
-- 1. POS: apply a single-use promo code and pay. The code must show as redeemed
--    and a promo_redemptions row must exist. Re-firing the same order id must
--    come back idempotent, not consume a second use.
-- 2. POS: redeem a points reward and pay. Balance drops once; one
--    loyalty_transactions row (Ops) and one loyalty_redemption_claims row
--    (Platform) with the same idempotency_key.
-- 3. Kiosk/online: same two, anonymous session path.
-- 4. Stamp-card reward redemption still works (that path is unchanged).
