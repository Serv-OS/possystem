-- v5.5.967 — Adyen terminal jobs: persist the nexo ServiceID.
-- Terminal API status recovery (TransactionStatusRequest) addresses the original
-- payment by SaleID+ServiceID — if the sync call dies mid-tender, the ServiceID
-- is the ONLY key that can find out what happened. It must live on the job row,
-- not in a process's memory (the whole lesson of the Ryft recovery work).
begin;
alter table terminal_jobs add column if not exists nexo_service_id text;
commit;
