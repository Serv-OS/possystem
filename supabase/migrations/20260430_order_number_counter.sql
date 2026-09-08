-- ============================================================================
-- v5.5.8 — PER-LOCATION ATOMIC ORDER NUMBER COUNTER
-- ============================================================================
--
-- Replaces the three pre-existing ref generators (kiosk Date.now() % 1000,
-- POS Math.random()*9000, in-memory ++_orderNum) with a single atomic counter
-- per location that produces R1, R2, ..., R99, R1, R2, ... — predictable,
-- low-collision, and shared across all devices at a single location.
--
-- Format: R<n> where n cycles 1-99. After 99 orders, wraps to R1 again.
-- That gives 99 orders of breathing room before a customer sees a repeat —
-- which is plenty for a typical service. (At v5.5.6 we were seeing repeats
-- within minutes due to the broken kiosk modulo.)
--
-- Multi-location: counter is keyed by location_id. Each location runs its
-- own independent 1-99 cycle.
--
-- Atomicity: a single INSERT ... ON CONFLICT DO UPDATE acquires a row lock,
-- so concurrent calls from multiple devices serialize correctly. No race.
--
-- Project: tbetcegmszzotrwdtqhi (RPOS Ops DB)
-- ============================================================================

-- Counter table — one row per location.
CREATE TABLE IF NOT EXISTS public.location_order_counters (
  location_id text PRIMARY KEY,
  counter int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.location_order_counters IS
  'v5.5.8: per-location atomic counter for customer-facing order numbers (R1-R99 cycle).';

-- Atomic next-number function.
-- Returns "R<n>" where n is the next number in the 1-99 cycle for this location.
-- Single statement ensures concurrent callers serialize on the row lock.
CREATE OR REPLACE FUNCTION public.next_order_number(p_location_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next int;
BEGIN
  INSERT INTO public.location_order_counters (location_id, counter, updated_at)
  VALUES (p_location_id, 1, now())
  ON CONFLICT (location_id) DO UPDATE
  SET counter = (location_order_counters.counter % 99) + 1,
      updated_at = now()
  RETURNING counter INTO v_next;
  RETURN 'R' || v_next;
END;
$$;

-- The function runs as the table owner (SECURITY DEFINER) so it bypasses
-- RLS on location_order_counters. We then grant EXECUTE to authenticated
-- users so anyone signed in can request a number.
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.next_order_number(text) TO authenticated;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'GRANT on next_order_number failed: %', SQLERRM;
END $$;

-- Enable RLS on the counter table itself (defense in depth — even though
-- only the SECURITY DEFINER function should be writing to it).
ALTER TABLE public.location_order_counters ENABLE ROW LEVEL SECURITY;

-- The function bypasses RLS, but if anyone tries to read the counter directly
-- (e.g., the back office wants to display "current order count this hour"),
-- they should only see their own location's row.
DO $$ BEGIN
  CREATE POLICY location_order_counters_rls_select
    ON public.location_order_counters FOR SELECT
    USING (
      auth.uid() IS NULL OR
      location_id IN (
        SELECT location_id::text FROM user_locations WHERE user_id = auth.uid()
        UNION
        SELECT location_id::text FROM user_profiles
          WHERE id = auth.uid() AND location_id IS NOT NULL
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- TEST after applying:
--
--   SELECT public.next_order_number('<your-location-uuid>');
--   -- Expect: 'R1' on first call, 'R2' on second, ... 'R99', 'R1' (cycles)
--
--   SELECT * FROM location_order_counters;
--   -- Expect: one row per location that's seen a call, with current counter value
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.next_order_number(text);
--   DROP TABLE IF EXISTS public.location_order_counters;
