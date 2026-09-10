-- OUR liable balance account id, per environment and region. PLATFORM project (yhzjgyrkyjabvhblqxzu).
--
-- Adyen for Platforms, confirmed on docs.adyen.com 9 Sep 2026: the commission
-- in a split configuration ALWAYS lands in the platform's liable balance
-- account, so no rule ever names it and nothing here needs it to route money.
-- The go live flow's step 5 (Payouts and commission) only SHOWS it, as a grey
-- id with Copy, so an admin can see where ServOS's share goes.
--
-- Optional, and never a gate: adyen-terminal-admin reads the secret named
-- ADYEN_LIVE_UK_LIABLE_BALANCE_ACCOUNT (ADYEN_LIVE_US_..., ADYEN_... on test)
-- first, then this column, and shows nothing when neither is set. The column
-- is read on its own statement, so the function works before this runs.
--
-- Idempotent, bare statements, no transaction wrapper. Run by hand.

alter table public.adyen_platform_settings
  add column if not exists liable_balance_account_id text;

comment on column public.adyen_platform_settings.liable_balance_account_id is
  'ServOS own liable balance account (BA...) on this environment and region: where the commission of every split lands. Shown by the go live flow (step 5); never used to route money (Adyen books the commission there on its own).';
