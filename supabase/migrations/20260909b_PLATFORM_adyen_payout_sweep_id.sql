-- The daily payout sweep on the venue row. PLATFORM project (yhzjgyrkyjabvhblqxzu).
--
-- 9 Sep 2026. merchant_adyen_accounts.payouts_ok is the CAPABILITY: Adyen
-- allows payouts to the venue's bank (sendToTransferInstrument allowed).
-- adyen-bp-webhook, adyen-financial (can_complete_setup) and the venue's own
-- Card payments screen all read it that way. Whether the venue is actually
-- PAID OUT (a daily push sweep from its balance account to its bank exists)
-- is a different fact, and folding it into payouts_ok told a venue Adyen had
-- approved to complete KYC again. So it gets its own column:
--
--   payout_sweep_id   the id of the active push sweep (SWPC...) to the venue's
--                     bank, written by adyen-terminal-admin (setup_sweep,
--                     golive_state, adyen_link) and adyen-onboard (status,
--                     setup_sweep); null when there is none.
--
-- The admin list chip PAYOUTS reads the two together (payouts_ok AND
-- payout_sweep_id). Until this runs, both functions write the column on its
-- own statement and answer a warning naming this file; the chip reads the
-- capability alone, as it always did.
--
-- Idempotent, bare statements, no transaction wrapper. Run by hand.

alter table public.merchant_adyen_accounts
  add column if not exists payout_sweep_id text;

comment on column public.merchant_adyen_accounts.payout_sweep_id is
  'The active daily push sweep (SWPC...) from the venue balance account to its bank, or null: PAID OUT. payouts_ok stays the capability (Adyen allows payouts). The admin list chip reads the two together.';
