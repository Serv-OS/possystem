-- 2026-04-21-receipt-control.sql
-- Adds auto-print-on-close device toggle and per-location receipt branding.
--
-- Run on Ops Supabase BEFORE deploying the matching code (code reads these
-- columns with safe defaults so running code against the unmigrated schema
-- is non-fatal, but the Back Office toggle/branding form won't persist).

-- ── 1. Device-profile toggle ─────────────────────────────────────────────────
-- Whether a terminal should auto-print a customer receipt when a check closes.
-- true = legacy behaviour (always print). false = only print if staff ticks
-- the "Print receipt" checkbox on the pay screen for that transaction.
alter table device_profiles
  add column if not exists auto_print_receipt_on_close boolean not null default true;

-- ── 2. Per-location receipt branding ─────────────────────────────────────────
-- Header logo, business name/address/phone/tax id, footer message, and QR
-- (upload-mode OR generated-from-URL mode). Shape is documented in
-- src/lib/receiptBranding.js. All fields optional; missing branding falls
-- back to the plain text-only receipt we've had since v4.0.
alter table locations
  add column if not exists receipt_branding jsonb;

-- ── 3. Storage bucket (manual step — cannot be created via SQL) ──────────────
-- In Supabase Studio → Storage, create a bucket named "receipt-assets".
-- Make it PUBLIC (so the Sunmi and iOS bridges can fetch logos without a
-- signed URL on every print). Path convention: locations/{location_id}/header.{ext}
-- and locations/{location_id}/qr.{ext}.
--
-- RLS policy for inserts (paste into Storage → Policies → receipt-assets):
--   create policy "Staff can upload their location's receipt assets"
--     on storage.objects for insert to authenticated
--     with check (
--       bucket_id = 'receipt-assets'
--       and (storage.foldername(name))[1] = 'locations'
--       and (storage.foldername(name))[2] in (
--         select location_id::text from users_locations where user_id = auth.uid()
--       )
--     );
