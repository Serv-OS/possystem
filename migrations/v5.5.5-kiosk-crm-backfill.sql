-- ============================================================================
-- v5.5.5 — KIOSK CRM BACKFILL
-- ============================================================================
--
-- Pre-v5.5.5 kiosk orders stamped customer + customer_phone on closed_checks
-- but never called attributeOrderToCustomer, so:
--   - no row in customers
--   - no row in customer_locations
--   - no row in customer_orders
--   - closed_checks.customer_id is NULL
--
-- This migration retroactively wires those orders into the CRM.
--
-- IDEMPOTENT: ON CONFLICT clauses + 'where customer_id is null' guard. Safe
-- to re-run; won't double-count visits.
--
-- BEFORE RUNNING:
--   1. Take a snapshot
--   2. Skim query (a) below to see how many rows will be affected
--   3. Verify the candidate orders look right before running the writes
--
-- Project: tbetcegmszzotrwdtqhi (RPOS Ops DB)
-- ============================================================================


-- ── (a) PREVIEW: how many kiosk closed_checks need backfill? ─────────────────

SELECT
  cc.location_id,
  l.name as location_name,
  count(*) as kiosk_orders_needing_backfill,
  min(cc.closed_at) as oldest,
  max(cc.closed_at) as newest,
  sum(cc.total) as total_revenue
FROM closed_checks cc
JOIN locations l ON l.id = cc.location_id
WHERE cc.source = 'kiosk'
  AND cc.customer_phone IS NOT NULL
  AND cc.customer_id IS NULL
GROUP BY cc.location_id, l.name
ORDER BY l.name;
-- Inspect the totals before running the writes.


-- ── (b) BACKFILL customers table ─────────────────────────────────────────────
-- For every distinct (org, normalised-phone) pair across kiosk closed_checks,
-- ensure a customers row exists. ON CONFLICT prevents duplicates.

WITH candidate_customers AS (
  SELECT DISTINCT ON (l.org_id, normalised_phone)
    l.org_id,
    normalised_phone as phone,
    cc.customer_phone as phone_raw,
    cc.customer as name
  FROM closed_checks cc
  JOIN locations l ON l.id = cc.location_id
  CROSS JOIN LATERAL (
    -- Normalise phone the same way _normalisePhone in the app does:
    -- strip non-digit/+ chars, then keep + or detect UK 07xxx → +44.
    SELECT
      CASE
        WHEN regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g') ~ '^\+'
          THEN regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g')
        WHEN regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') ~ '^07' AND
             length(regexp_replace(cc.customer_phone, '[^0-9]', '', 'g')) = 11
          THEN '+44' || substring(regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') from 2)
        WHEN regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') ~ '^44'
          THEN '+' || regexp_replace(cc.customer_phone, '[^0-9]', '', 'g')
        ELSE regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g')
      END as normalised_phone
  ) np
  WHERE cc.source = 'kiosk'
    AND cc.customer_phone IS NOT NULL
    AND cc.customer_id IS NULL
    AND length(normalised_phone) >= 7
  ORDER BY l.org_id, normalised_phone, cc.closed_at DESC -- newest name wins
)
INSERT INTO customers (org_id, phone, phone_raw, name, created_at, updated_at)
SELECT org_id, phone, phone_raw, COALESCE(name, 'Customer'), now(), now()
FROM candidate_customers
ON CONFLICT (org_id, phone) DO NOTHING;
-- Adjust the conflict target above if your customers unique constraint is
-- named differently — the v4.6.62 migration uses (org_id, phone).


-- ── (c) BACKFILL customer_locations ──────────────────────────────────────────
-- Aggregate visit_count + lifetime_revenue from kiosk closed_checks per
-- (customer_id, location_id), then upsert. last_visit_at is set to the most
-- recent of the kiosk orders.

WITH per_customer_location AS (
  SELECT
    c.id as customer_id,
    cc.location_id,
    count(*) as visit_count,
    sum(cc.total) as lifetime_revenue,
    max(cc.closed_at) as last_visit_at
  FROM closed_checks cc
  JOIN locations l ON l.id = cc.location_id
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g') ~ '^\+'
          THEN regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g')
        WHEN regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') ~ '^07' AND
             length(regexp_replace(cc.customer_phone, '[^0-9]', '', 'g')) = 11
          THEN '+44' || substring(regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') from 2)
        WHEN regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') ~ '^44'
          THEN '+' || regexp_replace(cc.customer_phone, '[^0-9]', '', 'g')
        ELSE regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g')
      END as normalised_phone
  ) np
  JOIN customers c ON c.org_id = l.org_id AND c.phone = normalised_phone
  WHERE cc.source = 'kiosk'
    AND cc.customer_phone IS NOT NULL
    AND cc.customer_id IS NULL
  GROUP BY c.id, cc.location_id
)
INSERT INTO customer_locations
  (customer_id, location_id, visit_count, lifetime_revenue, last_visit_at)
SELECT customer_id, location_id, visit_count, lifetime_revenue, last_visit_at
FROM per_customer_location
ON CONFLICT (customer_id, location_id) DO UPDATE SET
  visit_count = customer_locations.visit_count + EXCLUDED.visit_count,
  lifetime_revenue = customer_locations.lifetime_revenue + EXCLUDED.lifetime_revenue,
  last_visit_at = GREATEST(customer_locations.last_visit_at, EXCLUDED.last_visit_at);


-- ── (d) BACKFILL customer_orders ─────────────────────────────────────────────
-- One row per kiosk closed_check, keyed by closed_check_id (= cc.id) so
-- re-running is a no-op.

INSERT INTO customer_orders
  (customer_id, location_id, closed_check_id, ordered_at, total, channel, item_summary)
SELECT
  c.id as customer_id,
  cc.location_id,
  cc.id::text as closed_check_id,  -- closed_check_id may be text in your schema
  cc.closed_at as ordered_at,
  cc.total,
  'kiosk' as channel,
  -- Reduce items array to {name, qty, price} entries
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('name', it->>'name', 'qty', it->'qty', 'price', it->'price'))
       FROM jsonb_array_elements(cc.items) it),
    '[]'::jsonb
  ) as item_summary
FROM closed_checks cc
JOIN locations l ON l.id = cc.location_id
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g') ~ '^\+'
        THEN regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g')
      WHEN regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') ~ '^07' AND
           length(regexp_replace(cc.customer_phone, '[^0-9]', '', 'g')) = 11
        THEN '+44' || substring(regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') from 2)
      WHEN regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') ~ '^44'
        THEN '+' || regexp_replace(cc.customer_phone, '[^0-9]', '', 'g')
      ELSE regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g')
    END as normalised_phone
) np
JOIN customers c ON c.org_id = l.org_id AND c.phone = normalised_phone
WHERE cc.source = 'kiosk'
  AND cc.customer_phone IS NOT NULL
  AND cc.customer_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM customer_orders co WHERE co.closed_check_id = cc.id::text
  );


-- ── (e) STAMP customer_id BACK ONTO closed_checks ────────────────────────────

UPDATE closed_checks cc
   SET customer_id = c.id
  FROM locations l, customers c,
  LATERAL (
    SELECT
      CASE
        WHEN regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g') ~ '^\+'
          THEN regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g')
        WHEN regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') ~ '^07' AND
             length(regexp_replace(cc.customer_phone, '[^0-9]', '', 'g')) = 11
          THEN '+44' || substring(regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') from 2)
        WHEN regexp_replace(cc.customer_phone, '[^0-9]', '', 'g') ~ '^44'
          THEN '+' || regexp_replace(cc.customer_phone, '[^0-9]', '', 'g')
        ELSE regexp_replace(cc.customer_phone, '[^0-9+]', '', 'g')
      END as normalised_phone
  ) np
 WHERE cc.location_id = l.id
   AND c.org_id = l.org_id
   AND c.phone = normalised_phone
   AND cc.source = 'kiosk'
   AND cc.customer_phone IS NOT NULL
   AND cc.customer_id IS NULL;


-- ── (f) VERIFY — after running (b)-(e), this should return 0 ─────────────────

SELECT count(*) as still_unattributed
FROM closed_checks
WHERE source = 'kiosk'
  AND customer_phone IS NOT NULL
  AND customer_id IS NULL;
-- Expect: 0. If non-zero, those rows have a phone format the normaliser
-- couldn't handle (international numbers without +country code, etc.).
-- Inspect with: SELECT customer_phone FROM closed_checks WHERE customer_id
-- IS NULL AND source = 'kiosk' AND customer_phone IS NOT NULL LIMIT 20;

-- ============================================================================
