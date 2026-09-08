-- v5.5.968 — Adyen adversarial-review hardening (ops DB)
-- Findings from the 22-agent money-safety review of v5.5.967 (task #84).
begin;

-- ServiceIDs are now 10 random base36 chars (collision-resistant capability
-- tokens). Enforce uniqueness so a collision can never settle the wrong job —
-- the CAS update that stamps it simply fails and the initiator re-mints.
create unique index if not exists idx_tj_nexo_service
  on terminal_jobs (nexo_service_id) where nexo_service_id is not null;

-- Stripe bar-tab holds need the connected-account id to be captured/released
-- from ANOTHER till (the ref alone 400s at Stripe without the acct context).
alter table bar_tabs add column if not exists pre_auth_account text;

commit;
