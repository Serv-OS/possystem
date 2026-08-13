-- ═══════════════════════════════════════════════════════════════════════════
-- Bookings — terms + conditional card rules (Peter's widget test, 13 Aug):
--  · packages.terms — per-event terms & conditions shown on the widget
--  · booking_rules.booking_terms — the venue's standard booking terms
--  · booking_rules.card_capture_min_covers — card hold only for parties of at
--    least N (0 = every booking). Prepay/deposit packages always charge.
-- Idempotent + re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════
begin;

alter table public.packages add column if not exists terms text not null default '';
alter table public.booking_rules add column if not exists booking_terms text not null default '';
alter table public.booking_rules add column if not exists card_capture_min_covers integer not null default 0
  check (card_capture_min_covers between 0 and 100);

commit;
