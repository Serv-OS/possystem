-- ============================================================================
-- PLATFORM DB (yhzjgyrkyjabvhblqxzu) — NOT the Ops DB.
--
-- Fix Supabase CRITICAL advisor `rls_disabled_in_public` on loyalty_otp_codes:
-- the table held live SMS one-time codes with RLS DISABLED, so the public
-- anon key could read every code (defeating OTP verification) or harvest
-- phone numbers. The table is only ever touched by the loyalty-otp edge
-- function via the PLATFORM service-role key, which BYPASSES RLS — so enabling
-- RLS with NO public policies (default-deny for anon/authenticated) closes the
-- hole without affecting the OTP flow. Grants are revoked as defence in depth.
-- ============================================================================

alter table public.loyalty_otp_codes enable row level security;
alter table public.loyalty_otp_codes force row level security;

-- No anon/authenticated policies: this is a server-only table. Service role
-- bypasses RLS, so the edge function is unaffected.
revoke all on public.loyalty_otp_codes from anon, authenticated;
