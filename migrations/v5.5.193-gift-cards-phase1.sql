-- ============================================================================
-- Gift Cards Phase 1: Schema Migration
-- Target: Platform DB (yhzjgyrkyjabvhblqxzu)
-- Version: v5.5.193
-- ============================================================================

-- ── 1. gift_brand_config ────────────────────────────────────────────────────
-- One row per company. Org-level gift card settings and defaults.
CREATE TABLE IF NOT EXISTS gift_brand_config (
  company_id       uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled          boolean   NOT NULL DEFAULT false,
  currency         text      NOT NULL DEFAULT 'gbp',
  pin_threshold_minor  integer NOT NULL DEFAULT 10000,      -- 100.00 in minor units
  default_expiry_months integer,                             -- null = never expires
  max_card_value_minor  integer NOT NULL DEFAULT 50000,      -- 500.00
  min_card_value_minor  integer NOT NULL DEFAULT 500,        -- 5.00
  hmac_secret      text      NOT NULL,                       -- per-org HMAC key for code lookup index
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 2. gift_cards ───────────────────────────────────────────────────────────
-- Every issued gift card. Code stored as hash, lookup via HMAC index.
CREATE TABLE IF NOT EXISTS gift_cards (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code_hash             text NOT NULL,                      -- argon2id hash of full 16-char code
  code_lookup           text NOT NULL,                      -- HMAC-SHA256 for fast retrieval
  code_last4            text NOT NULL,                      -- last 4 chars, plaintext for support
  initial_amount_minor  bigint NOT NULL CHECK (initial_amount_minor > 0),
  balance_minor         bigint NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','redeemed','voided','expired')),
  issued_at             timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,                        -- null = never
  issued_by_staff_id    uuid,                               -- ops staff_members.id (cross-db ref)
  issued_at_location_id uuid,                               -- which location issued
  recipient_name        text,
  recipient_email       text,
  note                  text,
  voided_at             timestamptz,
  voided_by             uuid,
  voided_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Unique on code_lookup (one HMAC per code, used for fast resolution)
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_code_lookup
  ON gift_cards (code_lookup);

-- Org scoped queries
CREATE INDEX IF NOT EXISTS idx_gift_cards_company_id
  ON gift_cards (company_id);

-- Support lookup by last4 within an org
CREATE INDEX IF NOT EXISTS idx_gift_cards_company_last4
  ON gift_cards (company_id, code_last4);

-- Expiry sweeps
CREATE INDEX IF NOT EXISTS idx_gift_cards_expires_at
  ON gift_cards (expires_at)
  WHERE expires_at IS NOT NULL AND status = 'active';

-- ── 3. gift_card_transactions ───────────────────────────────────────────────
-- Append-only ledger. amount_minor is signed: positive = credit, negative = debit.
-- SUM(amount_minor) for a card should always equal gift_cards.balance_minor.
CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id           uuid NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type              text NOT NULL CHECK (type IN ('issue','redeem','refund','void')),
  amount_minor      bigint NOT NULL,                        -- signed: + credit, - debit
  balance_after_minor bigint NOT NULL,                      -- snapshot after this tx
  location_id       uuid,
  order_id          text,
  channel           text CHECK (channel IN ('pos','online','kiosk','backoffice')),
  idempotency_key   text,
  staff_id          uuid,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: one key per card
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_card_tx_idempotency
  ON gift_card_transactions (card_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Card history queries
CREATE INDEX IF NOT EXISTS idx_gift_card_tx_card_id
  ON gift_card_transactions (card_id, created_at DESC);

-- Org scoped queries
CREATE INDEX IF NOT EXISTS idx_gift_card_tx_company_id
  ON gift_card_transactions (company_id);

-- Order reference lookups (for reverse-redeem)
CREATE INDEX IF NOT EXISTS idx_gift_card_tx_order_id
  ON gift_card_transactions (order_id)
  WHERE order_id IS NOT NULL;

-- ── 4. gift_card_pins ───────────────────────────────────────────────────────
-- Separate table for PIN hashes. One-to-one with gift_cards.
CREATE TABLE IF NOT EXISTS gift_card_pins (
  card_id     uuid PRIMARY KEY REFERENCES gift_cards(id) ON DELETE CASCADE,
  pin_hash    text NOT NULL,                                -- argon2id hash
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 5. Updated-at triggers ──────────────────────────────────────────────────
-- Reuse existing set_updated_at() function.
CREATE TRIGGER trg_gift_brand_config_updated_at
  BEFORE UPDATE ON gift_brand_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_gift_cards_updated_at
  BEFORE UPDATE ON gift_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_gift_card_pins_updated_at
  BEFORE UPDATE ON gift_card_pins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No trigger on gift_card_transactions (append-only, never updated).

-- ── 6. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE gift_brand_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_card_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_card_pins ENABLE ROW LEVEL SECURITY;

-- Read: authenticated users can read rows in their company
CREATE POLICY gift_brand_config_select ON gift_brand_config
  FOR SELECT TO authenticated
  USING (company_id IN (
    SELECT company_id FROM user_company_roles WHERE user_id = auth.uid()
  ));

CREATE POLICY gift_cards_select ON gift_cards
  FOR SELECT TO authenticated
  USING (company_id IN (
    SELECT company_id FROM user_company_roles WHERE user_id = auth.uid()
  ));

CREATE POLICY gift_card_tx_select ON gift_card_transactions
  FOR SELECT TO authenticated
  USING (company_id IN (
    SELECT company_id FROM user_company_roles WHERE user_id = auth.uid()
  ));

CREATE POLICY gift_card_pins_select ON gift_card_pins
  FOR SELECT TO authenticated
  USING (card_id IN (
    SELECT id FROM gift_cards WHERE company_id IN (
      SELECT company_id FROM user_company_roles WHERE user_id = auth.uid()
    )
  ));

-- Writes: service_role only (edge functions). No insert/update/delete policies
-- for authenticated users. All mutations go through edge functions.

-- Service role bypasses RLS by default, so no explicit policies needed for it.

-- ── 7. Comments ─────────────────────────────────────────────────────────────
COMMENT ON TABLE gift_brand_config IS 'Per-org gift card configuration and defaults';
COMMENT ON TABLE gift_cards IS 'All issued gift cards. Code stored hashed, balance cached.';
COMMENT ON TABLE gift_card_transactions IS 'Append-only ledger of all gift card balance changes';
COMMENT ON TABLE gift_card_pins IS 'Optional PIN hashes for high-value gift cards';
COMMENT ON COLUMN gift_cards.code_hash IS 'argon2id hash of the full 16-char gift card code';
COMMENT ON COLUMN gift_cards.code_lookup IS 'HMAC-SHA256 of code using per-org secret, for fast indexed retrieval';
COMMENT ON COLUMN gift_cards.balance_minor IS 'Cached balance in minor currency units. Reconciled on every write.';
COMMENT ON COLUMN gift_card_transactions.amount_minor IS 'Signed amount: positive = credit (issue, refund), negative = debit (redeem, void)';
COMMENT ON COLUMN gift_brand_config.hmac_secret IS 'Per-org HMAC-SHA256 key for gift card code lookup index generation';
