-- v5.5.188 — Per-reader customer display toggle
-- Run on PLATFORM DB (yhzjgyrkyjabvhblqxzu), NOT the ops DB.
--
-- Adds a boolean flag to payment_devices that controls whether the POS
-- pushes live cart items to the reader's customer-facing screen.
-- Default true preserves backward compatibility — existing readers
-- continue to show the cart without any action required.
--
-- Table-service restaurants can disable this per reader so the reader
-- stays on the idle screen until payment time.

ALTER TABLE payment_devices
  ADD COLUMN IF NOT EXISTS customer_display_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN payment_devices.customer_display_enabled IS
  'When true, the POS pushes live cart line items to this reader screen. Disable for table service where the reader is not customer-facing.';
