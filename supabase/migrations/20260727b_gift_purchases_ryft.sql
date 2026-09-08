-- 20260727b_gift_purchases_ryft.sql
--
-- ⚠ PLATFORM DB (yhzjgyrkyjabvhblqxzu) — NOT the Ops DB. gift_card_purchases lives on
-- the platform side alongside merchant_stripe_accounts / merchant_ryft_accounts.
--
-- Gift cards could only ever be sold through Stripe: gift-checkout-session hard-requires
-- a merchant_stripe_accounts row with charges_enabled, so a Ryft venue was refused with
-- "Payments not configured for this venue". v5.5.911 adds a Ryft branch, which needs two
-- things this table has never had: which processor took the money, and the Ryft payment
-- session id (the Stripe columns are the only identifiers today).
--
-- Purely additive. Every existing row keeps processor='stripe' and the whole Stripe path
-- is untouched.

begin;

alter table gift_card_purchases
  add column if not exists processor text not null default 'stripe',
  add column if not exists ryft_payment_session_id text;

comment on column gift_card_purchases.processor is
  'Which processor took the money: stripe | ryft. Decided server-side in '
  'gift-checkout-session from locations.payment_processor.';

comment on column gift_card_purchases.ryft_payment_session_id is
  'Ryft payment session id. The Ryft twin of stripe_session_id — ryft-webhook matches '
  'PaymentSession.captured back to this purchase via metadata.purchase_id and stamps it here.';

create index if not exists idx_gift_card_purchases_ryft_session
  on gift_card_purchases (ryft_payment_session_id)
  where ryft_payment_session_id is not null;

commit;

-- PostgREST caches the schema; reload it so the edge functions see the new columns:
--   notify pgrst, 'reload schema';
