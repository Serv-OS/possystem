-- v5.5.799 — per-location POS behaviour settings (Ops DB)
-- New jsonb home for POS-side location settings. First key:
--   takeaway_customer_details: 'full' (default — name+phone modal)
--                            | 'name' (single required name field only)
--                            | 'none' (no prompt — order goes straight through with its short ref)
-- Additive only — no data change, no default rows needed ('{}'::jsonb ≡ 'full').
alter table locations add column if not exists pos_settings jsonb not null default '{}'::jsonb;
