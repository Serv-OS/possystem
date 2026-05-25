-- ═══════════════════════════════════════════════════════════════════════════
-- v5.5.218 — Loyalty Core: Points Engine
-- Run PLATFORM DB portion in Platform DB SQL editor
-- Run OPS DB portion in Ops DB SQL editor
-- ═══════════════════════════════════════════════════════════════════════════

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  PLATFORM DB (yhzjgyrkyjabvhblqxzu)                                     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ── Loyalty Config (one per company) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_config (
  company_id    UUID PRIMARY KEY REFERENCES companies(id),
  enabled       BOOLEAN DEFAULT false,
  currency      TEXT DEFAULT 'GBP',

  -- Points configuration
  points_enabled           BOOLEAN DEFAULT true,
  points_per_currency_unit NUMERIC(8,2) DEFAULT 1,    -- points earned per £1 spent
  points_currency_value    NUMERIC(8,4) DEFAULT 0.01, -- value of 1 point in currency (£0.01)
  points_rounding          TEXT DEFAULT 'floor',       -- floor|ceil|round
  points_expiry_months     INTEGER DEFAULT NULL,       -- NULL = never expire

  -- Earning exclusions
  earn_on_gift_card_purchase BOOLEAN DEFAULT false,
  earn_on_staff_discount     BOOLEAN DEFAULT false,
  earn_on_comps              BOOLEAN DEFAULT false,
  earn_on_delivery_fee       BOOLEAN DEFAULT false,
  earn_on_service_charge     BOOLEAN DEFAULT false,
  earn_on_tax                BOOLEAN DEFAULT false,
  excluded_category_ids      TEXT[] DEFAULT '{}',
  excluded_item_ids          TEXT[] DEFAULT '{}',

  -- Registration incentives
  registration_bonus    INTEGER DEFAULT 0,          -- welcome bonus points
  birthday_bonus        INTEGER DEFAULT 0,          -- birthday points
  referral_bonus        INTEGER DEFAULT 0,          -- referrer gets
  referral_referee_bonus INTEGER DEFAULT 0,         -- referee gets

  -- Branding (portal/wallet pass)
  branding JSONB DEFAULT '{}',
  -- { accent_color, logo_url, hero_url, background, foreground, card_bg }

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── Loyalty Tiers ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER DEFAULT 0,
  color       TEXT DEFAULT '#cd7f32',
  icon        TEXT DEFAULT 'star',

  -- Qualification thresholds (any one met = qualified)
  min_points_earned   INTEGER DEFAULT 0,
  min_visits          INTEGER DEFAULT 0,
  min_spend_minor     INTEGER DEFAULT 0,
  qualification_period TEXT DEFAULT 'rolling_12m',

  -- Benefits
  points_multiplier  NUMERIC(5,2) DEFAULT 1.0,
  perks              JSONB DEFAULT '[]',

  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_tiers_company ON loyalty_tiers(company_id, sort_order);

-- ── Customer Loyalty Membership ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_loyalty (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id     UUID NOT NULL,                  -- FK to ops.customers.id
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Balances
  points_balance        INTEGER DEFAULT 0,
  points_earned_total   INTEGER DEFAULT 0,
  points_redeemed_total INTEGER DEFAULT 0,
  points_expired_total  INTEGER DEFAULT 0,

  -- Tier
  tier_id         UUID REFERENCES loyalty_tiers(id) ON DELETE SET NULL,
  tier_qualified_at TIMESTAMPTZ,

  -- Denormalised stats (updated on every earn)
  visit_count          INTEGER DEFAULT 0,
  lifetime_spend_minor INTEGER DEFAULT 0,

  -- Identification
  member_code     TEXT UNIQUE,                    -- "SRV-A7K9M2"
  referral_code   TEXT UNIQUE,                    -- "REF-B3X8P4"
  referred_by     UUID REFERENCES customer_loyalty(id) ON DELETE SET NULL,

  -- Profile
  birthday        DATE,
  wallet_pass_serial TEXT,

  -- Dates
  enrolled_at     TIMESTAMPTZ DEFAULT now(),
  last_earn_at    TIMESTAMPTZ,
  last_redeem_at  TIMESTAMPTZ,
  points_expire_at TIMESTAMPTZ,

  UNIQUE(customer_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_loyalty_company ON customer_loyalty(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_loyalty_member ON customer_loyalty(member_code);
CREATE INDEX IF NOT EXISTS idx_customer_loyalty_customer ON customer_loyalty(customer_id);

-- ── Rewards Catalog ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  icon        TEXT DEFAULT 'gift',

  -- Cost
  points_cost INTEGER NOT NULL,

  -- What you get
  reward_type  TEXT NOT NULL,   -- 'discount_fixed'|'discount_pct'|'free_item'|'bonus_points'
  reward_value JSONB DEFAULT '{}',
  -- discount_fixed: { amount_minor: 500 }              => £5 off
  -- discount_pct:   { percentage: 10, max_minor: 2000 } => 10% off, max £20
  -- free_item:      { item_id, item_name }
  -- bonus_points:   { points: 100 }

  -- Availability
  active       BOOLEAN DEFAULT true,
  location_ids TEXT[] DEFAULT '{}',     -- empty = all locations
  channels     TEXT[] DEFAULT '{pos,kiosk,online,qr}',
  min_order_minor INTEGER DEFAULT 0,

  -- Limits
  max_per_order     INTEGER DEFAULT 1,
  max_per_customer  INTEGER DEFAULT NULL,
  total_available   INTEGER DEFAULT NULL,
  total_redeemed    INTEGER DEFAULT 0,

  sort_order   INTEGER DEFAULT 0,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_company ON loyalty_rewards(company_id, active);

-- ── Earning Rules ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_earning_rules (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,  -- 'spend'|'visit'|'product'|'category'|'time'
  active      BOOLEAN DEFAULT true,
  priority    INTEGER DEFAULT 0,

  -- Conditions
  conditions  JSONB DEFAULT '{}',

  -- Reward
  multiplier       NUMERIC(5,2) DEFAULT 1.0,
  bonus_points     INTEGER DEFAULT 0,

  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_earning_rules_company ON loyalty_earning_rules(company_id, active);

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE loyalty_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_loyalty ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_earning_rules ENABLE ROW LEVEL SECURITY;

-- Service role (edge functions) has full access. Authenticated users read-only
-- via company scope. We use permissive policies and tighten later.
CREATE POLICY "service_all" ON loyalty_config FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON loyalty_tiers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON customer_loyalty FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON loyalty_rewards FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON loyalty_earning_rules FOR ALL USING (true) WITH CHECK (true);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  OPS DB (tbetcegmszzotrwdtqhi)                                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ── Loyalty Transactions (append-only ledger) ────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id     UUID NOT NULL,
  company_id      UUID NOT NULL,
  location_id     TEXT NOT NULL,

  type            TEXT NOT NULL,  -- 'earn'|'redeem'|'expire'|'refund'|'bonus'|'adjust'
  points          INTEGER NOT NULL,         -- positive for earn, negative for redeem/expire
  balance_after   INTEGER NOT NULL,

  -- Source
  source          TEXT,           -- 'purchase'|'reward'|'referral'|'birthday'|'manual'|'welcome'
  channel         TEXT,           -- 'pos'|'kiosk'|'online'|'qr'|'backoffice'
  closed_check_id TEXT,
  reward_id       UUID,

  -- Idempotency
  idempotency_key TEXT UNIQUE,

  -- Earning audit
  qualifying_amount_minor INTEGER,
  multiplier_applied      NUMERIC(5,2),
  earning_rule_id         UUID,
  tier_at_time            TEXT,

  staff_id    TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_customer ON loyalty_transactions(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_company ON loyalty_transactions(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_check ON loyalty_transactions(closed_check_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_idempotency ON loyalty_transactions(idempotency_key);

-- ── Add loyalty column to closed_checks ──────────────────────────────────
ALTER TABLE closed_checks ADD COLUMN IF NOT EXISTS
  loyalty JSONB DEFAULT NULL;
  -- { customer_id, member_code, points_earned, points_redeemed,
  --   reward_applied: {id,name,discount_minor}, tier_at_time }

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON loyalty_transactions FOR ALL USING (true) WITH CHECK (true);
