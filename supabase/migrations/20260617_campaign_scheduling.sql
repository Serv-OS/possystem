-- Marketing v2 Phase 3: scheduled/recurring sends + audience exclusions (additive).
alter table campaigns add column if not exists schedule jsonb not null default '{}'::jsonb;
alter table campaigns add column if not exists exclusion_segment_id uuid;
