-- v5.5.196 — Gift Card Purchases table (Platform DB)
--
-- Tracks customer-initiated online gift card purchases. Created when a
-- customer starts a Stripe Checkout Session, updated on payment success
-- (status → 'paid'), and again when the card is issued (status → 'fulfilled').
--
-- The gift-checkout-session edge function creates the row.
-- The stripe-webhook-connect handler updates status on checkout.session.completed.
-- The gift-fulfill edge function issues the card and updates status to 'fulfilled'.

CREATE TABLE IF NOT EXISTS gift_card_purchases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  location_id     uuid NOT NULL,

  -- Payment
  amount_minor    integer NOT NULL CHECK (amount_minor > 0),
  currency        text NOT NULL DEFAULT 'gbp',
  stripe_session_id   text,             -- Stripe Checkout Session ID
  stripe_account_id   text,             -- Connected account ID
  stripe_payment_intent_id text,        -- Resolved after payment

  -- Sender
  sender_name     text NOT NULL,
  sender_email    text NOT NULL,

  -- Recipient
  recipient_name  text NOT NULL,
  recipient_email text NOT NULL,
  message         text,                  -- Optional personal message
  delivery_type   text NOT NULL DEFAULT 'email',  -- 'email' | 'self'

  -- Fulfillment
  status          text NOT NULL DEFAULT 'pending',  -- pending → paid → fulfilled
  gift_card_id    uuid REFERENCES gift_cards(id),   -- Set on fulfillment
  code_last4      text,                              -- Set on fulfillment
  fulfilled_at    timestamptz,

  -- Timestamps
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Index for webhook lookup by Stripe session ID
CREATE INDEX IF NOT EXISTS idx_gift_card_purchases_session
  ON gift_card_purchases(stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- Index for company listing
CREATE INDEX IF NOT EXISTS idx_gift_card_purchases_company
  ON gift_card_purchases(company_id, created_at DESC);

-- RLS: service_role only (edge functions handle all access)
ALTER TABLE gift_card_purchases ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users in the company to view purchases (back office)
CREATE POLICY gift_card_purchases_company_read ON gift_card_purchases
  FOR SELECT
  USING (
    company_id IN (
      SELECT company_id FROM user_company_roles
      WHERE user_id = auth.uid()
    )
  );

-- Service role can do everything (edge functions)
CREATE POLICY gift_card_purchases_service ON gift_card_purchases
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_gift_card_purchases_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gift_card_purchases_updated_at
  BEFORE UPDATE ON gift_card_purchases
  FOR EACH ROW
  EXECUTE FUNCTION update_gift_card_purchases_updated_at();
