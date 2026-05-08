-- v5.5.103 — Online ordering / QR table-side: per-location URL + enabled flags.
-- Run on the PLATFORM DB (yhzjgyrkyjabvhblqxzu).
--
-- online_slug   — DNS-friendly subdomain ("peters-cafe" → peters-cafe.serv-os.app)
-- online_enabled — whether remote online ordering is exposed at that URL
-- qr_enabled    — whether table-side QR scanning fires into POS sessions

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS online_slug    text,
  ADD COLUMN IF NOT EXISTS online_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS qr_enabled     boolean NOT NULL DEFAULT false;

-- Slug must be unique across the whole platform (it IS a domain).
CREATE UNIQUE INDEX IF NOT EXISTS locations_online_slug_key
  ON public.locations (online_slug)
  WHERE online_slug IS NOT NULL;

COMMENT ON COLUMN public.locations.online_slug IS
  'DNS-friendly slug. Becomes <slug>.serv-os.app for online + QR surfaces. Unique across platform.';
COMMENT ON COLUMN public.locations.online_enabled IS
  'Master switch for remote online ordering at <slug>.serv-os.app/.';
COMMENT ON COLUMN public.locations.qr_enabled IS
  'Master switch for QR table-side ordering at <slug>.serv-os.app/t/<table-id>.';
