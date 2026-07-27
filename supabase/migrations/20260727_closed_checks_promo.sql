-- 20260727_closed_checks_promo.sql
--
-- THE COLUMN v5.5.887 FORGOT.
--
-- v5.5.887 put promo/offer redemption on every channel (POS, kiosk, online, QR) and started
-- stamping the redeemed code onto the check for receipts, refunds and reporting —
-- KioskApp.jsx writes `promo` into closed_checks. No migration ever created that column.
--
-- PostgREST validates every KEY in an insert payload against its schema cache BEFORE it looks
-- at any value, so `promo: null` was enough to fail the whole insert. The kiosk showed
--   "Could not find the 'promo' column of 'closed_checks' in the schema cache"
-- at the final Send — AFTER the gift card had been debited and the promo redeemed. The money
-- was gone and the sale existed nowhere.
--
-- The client is now defensive (v5.5.909 strips an unknown column and retries so the sale still
-- lands), but that is a net, not a fix. This is the fix.
--
-- Shape matches what the client writes:
--   { code, offer_id, label, discount_value }

begin;

alter table public.closed_checks
  add column if not exists promo jsonb;

comment on column public.closed_checks.promo is
  'Promo/offer code redeemed on this check: { code, offer_id, label, discount_value }. '
  'Written by every channel since v5.5.887. Null when no promo was used.';

-- Reporting reads this by code; partial so it costs nothing on the (majority) null rows.
create index if not exists idx_closed_checks_promo_code
  on public.closed_checks ((promo->>'code'))
  where promo is not null;

commit;

-- PostgREST caches the schema. After applying, reload it so the kiosk stops 404ing the column:
--   notify pgrst, 'reload schema';
