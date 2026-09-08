-- v5.5.973 — account HOLDER name alongside sort code + account number.
-- Customer ask: when paying manually the owner checks the account name matches
-- the payee before sending — the bank shows a close-match warning otherwise
-- (UK Confirmation of Payee). Also covers joint/parent accounts where the
-- account name is NOT the staff member's own name.
begin;
alter table wf_staff add column if not exists bank_account_name text;
commit;
