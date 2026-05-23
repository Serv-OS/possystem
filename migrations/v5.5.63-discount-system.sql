-- v5.5.63: Discount System
-- Adds two tables for custom discount management:
--   discounts       — manual presets staff can apply at POS (replaces hardcoded PRESETS)
--   discount_rules  — auto-discount rules triggered by cart contents (buy X get Y)
-- Both are location-scoped and synced to POS via config push.

-- 1. Manual discount presets
CREATE TABLE IF NOT EXISTS public.discounts (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  location_id text NOT NULL DEFAULT 'loc-demo',
  name text NOT NULL,
  type text NOT NULL DEFAULT 'percent',        -- 'percent' | 'amount'
  value numeric(10,4) NOT NULL DEFAULT 0,
  scope text NOT NULL DEFAULT 'global',        -- 'global' | 'category'
  category_ids text[] DEFAULT '{}',
  requires_manager boolean DEFAULT false,
  active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discounts_location ON public.discounts(location_id);
ALTER TABLE public.discounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated access" ON public.discounts FOR ALL USING (auth.role() = 'authenticated');

-- 2. Auto-discount rules
CREATE TABLE IF NOT EXISTS public.discount_rules (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  location_id text NOT NULL DEFAULT 'loc-demo',
  name text NOT NULL,
  active boolean DEFAULT true,
  trigger_type text NOT NULL DEFAULT 'buy_x',  -- 'buy_x' | 'bundle' (meal deal)
  trigger_category_ids text[] DEFAULT '{}',
  trigger_qty integer NOT NULL DEFAULT 2,
  reward_type text NOT NULL DEFAULT 'percent', -- 'percent' | 'amount' | 'free' | 'fixed_price'
  reward_value numeric(10,4) DEFAULT 0,
  reward_qty integer DEFAULT 1,
  reward_category_ids text[] DEFAULT '{}',
  trigger_groups jsonb DEFAULT NULL,            -- bundle mode: [{categoryIds:[], qty:1}, ...]
  channels jsonb DEFAULT '{"pos":true,"online":true,"qr":true,"kiosk":true}',
  schedule jsonb DEFAULT NULL,                 -- future: day/time scheduling
  priority integer DEFAULT 0,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discount_rules_location ON public.discount_rules(location_id);
ALTER TABLE public.discount_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated access" ON public.discount_rules FOR ALL USING (auth.role() = 'authenticated');
