-- 20260528_gift_redeem_atomic.sql  (Platform DB: yhzjgyrkyjabvhblqxzu)
-- v5.5.314: atomic gift-card redemption.
--
-- The gift-redeem edge function previously did read-balance → validate →
-- insert-ledger → update-balance as separate statements. Two concurrent
-- redemptions of the SAME card (e.g. the same card used on two tills at once)
-- could both pass the stale balance check and overspend the card.
--
-- This RPC performs idempotency + balance check + decrement + ledger insert in
-- ONE transaction. The conditional UPDATE (WHERE balance_minor >= amount) takes
-- a row lock, so concurrent callers serialize: the 2nd sees the decremented
-- balance and returns 'insufficient' instead of overspending. A same-key retry
-- returns 'already_applied' (the unique_violation handler rolls back the
-- in-transaction decrement, so the balance is only ever debited once).
CREATE OR REPLACE FUNCTION public.redeem_gift_card_atomic(
  p_card_id uuid,
  p_company_id uuid,
  p_amount_minor int,
  p_idempotency_key text,
  p_location_id uuid,
  p_order_id text,
  p_channel text,
  p_staff_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_existing record;
  v_new_balance int;
  v_new_status text;
BEGIN
  -- Idempotency: a transaction with this card + key already exists?
  SELECT amount_minor, balance_after_minor INTO v_existing
    FROM gift_card_transactions
    WHERE card_id = p_card_id AND idempotency_key = p_idempotency_key
    LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('status','already_applied',
      'applied', abs(v_existing.amount_minor),
      'balance_after_minor', v_existing.balance_after_minor);
  END IF;

  -- Atomic conditional decrement (active + sufficient balance only).
  UPDATE gift_cards
    SET balance_minor = balance_minor - p_amount_minor
    WHERE id = p_card_id
      AND company_id = p_company_id
      AND status = 'active'
      AND balance_minor >= p_amount_minor
    RETURNING balance_minor INTO v_new_balance;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','insufficient');
  END IF;

  v_new_status := CASE WHEN v_new_balance <= 0 THEN 'redeemed' ELSE 'active' END;
  UPDATE gift_cards SET status = v_new_status WHERE id = p_card_id;

  INSERT INTO gift_card_transactions
    (card_id, company_id, type, amount_minor, balance_after_minor, location_id, order_id, channel, idempotency_key, staff_id)
  VALUES
    (p_card_id, p_company_id, 'redeem', -p_amount_minor, v_new_balance, p_location_id, p_order_id, p_channel, p_idempotency_key, p_staff_id);

  RETURN jsonb_build_object('status','ok',
    'applied', p_amount_minor,
    'balance_after_minor', v_new_balance,
    'new_status', v_new_status);

EXCEPTION WHEN unique_violation THEN
  -- A concurrent call with the same key won the ledger insert. The decrement
  -- above is rolled back with this subtransaction; return the committed result.
  SELECT amount_minor, balance_after_minor INTO v_existing
    FROM gift_card_transactions
    WHERE card_id = p_card_id AND idempotency_key = p_idempotency_key
    LIMIT 1;
  RETURN jsonb_build_object('status','already_applied',
    'applied', abs(COALESCE(v_existing.amount_minor, 0)),
    'balance_after_minor', v_existing.balance_after_minor);
END $fn$;
