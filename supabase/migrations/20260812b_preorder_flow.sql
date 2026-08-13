-- ═══════════════════════════════════════════════════════════════════════════
-- Table Bookings — the pre-order FLOW (Peter, 12 Aug, after testing the
-- widget): a package that requires pre-orders must ASK — per guest, one
-- choice per course group (starters / mains / desserts) — either at booking
-- (when inside the deadline) or later via a tokened guest link with email +
-- SMS reminders.
--
--  · packages.preorder_days_before — how many days before the visit choices
--    must be in. 0 = at booking whenever possible.
--  · bookings.preorder_token — unguessable token for the guest completion
--    page (/book?preorder=<token>). Minted server-side only.
--  · booking_reminders — append-only send ledger (idempotency: one row per
--    booking/kind/channel), read by the booking-reminders fn.
-- Idempotent + re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════
begin;

alter table public.packages add column if not exists preorder_days_before integer not null default 0
  check (preorder_days_before between 0 and 60);

alter table public.bookings add column if not exists preorder_token text;
create unique index if not exists idx_bookings_preorder_token
  on public.bookings(preorder_token) where preorder_token is not null;

create table if not exists public.booking_reminders (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  booking_id text not null references public.bookings(id) on delete cascade,
  kind text not null default 'preorder' check (kind in ('preorder','confirmation')),
  channel text not null check (channel in ('email','sms')),
  sent_to text,
  sent_at timestamptz not null default now(),
  unique (booking_id, kind, channel)
);

alter table public.booking_reminders enable row level security;
-- Service-role writes only (the reminders fn); BO may read.
revoke all on public.booking_reminders from anon, authenticated;
do $$ begin
  create policy "bo read" on public.booking_reminders for select
    using (location_id::text in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;
grant select on public.booking_reminders to authenticated;

commit;
