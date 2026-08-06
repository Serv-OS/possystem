-- 20260806f_staff_portal.sql — the staff self-service app (?mode=staff).
--
-- WHY: training / announcements / timesheets / own-details need a staff-facing
-- surface, and the Time Clock is the wrong one — a 20-minute training module
-- would hold the shared clock-in tablet hostage. This is a personal-phone
-- portal instead.
--
-- AUTH MODEL (Peter, 6 Aug): onboarding emails the new starter a link; the link
-- lets them CREATE THEIR USER AND PASSWORD; from then on they log in with
-- email + password (Supabase Auth on the Ops project).
--   - wf_staff.portal_user_id links the HR record to their auth user.
--   - The invite link carries OUR OWN token (hash stored here, single-use,
--     7-day expiry) — same pattern as the contract e-sign links. No dependency
--     on Supabase email templates or redirect-URL config.
--   - The `staff-portal` edge fn (service_role, self-fenced like
--     workforce-clock) is the only thing that mints users and serves data.
--     A portal auth user gets NO user_profiles / user_locations rows, so all
--     BO RLS keeps treating them as nobody.

begin;

alter table public.wf_staff add column if not exists portal_user_id uuid;
alter table public.wf_staff add column if not exists portal_invite_hash text;
alter table public.wf_staff add column if not exists portal_invite_expires timestamptz;

-- One auth user maps to at most one staff record (multi-venue staff are one
-- wf_staff row per venue today; the fn picks by email at login, see fn notes).
create unique index if not exists idx_wf_staff_portal_user
  on public.wf_staff (portal_user_id) where portal_user_id is not null;

commit;
