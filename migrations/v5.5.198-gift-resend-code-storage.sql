-- v5.5.198 — Store plaintext code on gift_card_purchases for resend
--
-- The gift card code is hashed (argon2id) on the gift_cards table and cannot
-- be recovered. To support re-sending the delivery email from the back office,
-- we store the code on the purchase record at fulfillment time.
--
-- Security: gift_card_purchases has RLS. Only users with a user_company_roles
-- row for the same company can SELECT, and only service_role can INSERT/UPDATE.
-- The code is already emailed to the recipient, so storing it here for admin
-- resend purposes doesn't expand its exposure.
--
-- Run on: Platform DB (yhzjgyrkyjabvhblqxzu)

ALTER TABLE gift_card_purchases
  ADD COLUMN IF NOT EXISTS fulfilled_code text;

COMMENT ON COLUMN gift_card_purchases.fulfilled_code IS
  'Plaintext 16-char gift card code, stored at fulfillment for resend capability. Only visible to company admins via RLS.';
