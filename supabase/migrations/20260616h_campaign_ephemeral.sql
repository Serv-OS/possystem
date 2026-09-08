-- Marketing v2 Phase 1: mark ephemeral Quick-Send blasts (hidden from the campaigns list, kept for reporting).
alter table campaigns add column if not exists ephemeral boolean not null default false;