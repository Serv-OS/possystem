-- 20260623u_waitlist_inbound_sms.sql
-- Two-way Tables Ready SMS — fields the inbound handler (waitlist-sms-inbound edge fn) needs.
-- Additive + reversible only. Reuses the existing sms_messages audit table for venue/entry
-- resolution (type='waitlist', reference_id = waitlist_entries.id) and marketing_suppressions
-- for STOP opt-out (same channel='sms' + org_id + address contract as marketing-webhook).
--
-- The guest can reply to a waitlist text:
--   C / CANCEL / X          -> cancel their entry (status -> 'cancelled')
--   OK / HERE / ON MY WAY / Y / YES / OMW  -> confirm / mark on-the-way (no new status enum;
--                            stamped on the entry as confirmed_at + guest_reply, board shows a chip)
--   STOP / UNSUBSCRIBE / etc -> opt out (marketing_suppressions row, like marketing-webhook)
--
-- We deliberately do NOT add a new status value (avoids touching the TRANSITIONS map / RLS / the
-- INACTIVE_STATUSES filter). "On the way / confirmed" is an attribute of an entry that is still
-- waiting|notified|ready, surfaced via confirmed_at. Cancel reuses the existing 'cancelled' status.

-- ── additive columns on the live queue ────────────────────────────────────────
alter table public.waitlist_entries
  add column if not exists confirmed_at      timestamptz,   -- guest texted OK / on-the-way
  add column if not exists last_guest_reply  text,          -- raw normalised keyword last received (audit/UI)
  add column if not exists last_reply_at     timestamptz;   -- when the last inbound reply landed

-- ── inbound side of the audit ledger (mirror of the outbound sms_messages row) ─
-- Logged for every inbound text the venue receives on its waitlist number, whether or not it
-- matched an active entry — so an operator can see "guest replied but we couldn't match them".
create table if not exists public.waitlist_sms_inbound (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid references public.locations(id),
  org_id            uuid,
  waitlist_entry_id text,                 -- soft ref to waitlist_entries.id (null = unmatched)
  from_number       text not null,        -- guest E.164
  to_number         text,                 -- the venue's Twilio number the guest texted
  body              text,                 -- raw message body
  keyword           text,                 -- normalised intent: cancel|confirm|stop|unknown
  action            text,                 -- what we did: cancelled|confirmed|opted_out|ignored|no_match
  provider_sid      text,                 -- Twilio MessageSid (idempotency)
  received_at       timestamptz not null default now()
);
create index if not exists waitlist_sms_inbound_loc_idx   on public.waitlist_sms_inbound (location_id, received_at desc);
create index if not exists waitlist_sms_inbound_entry_idx on public.waitlist_sms_inbound (waitlist_entry_id);
-- FULL unique index (not partial): PostgREST upsert onConflict='provider_sid' needs a real unique
-- constraint as the conflict target; a partial (WHERE not null) index isn't accepted. Postgres
-- treats NULLs as distinct, so unmatched inbounds with a null sid still insert fine.
create unique index if not exists waitlist_sms_inbound_sid_idx on public.waitlist_sms_inbound (provider_sid);

-- RLS: read-only for BO / the claimed device; the edge fn writes with the service-role (bypasses).
alter table public.waitlist_sms_inbound enable row level security;
drop policy if exists waitlist_sms_inbound_sel on public.waitlist_sms_inbound;
create policy waitlist_sms_inbound_sel on public.waitlist_sms_inbound for select
  using (public.waitlist_can_write(location_id));

-- ── realtime: the live board also reflects an inbound reply (confirmed chip) ────
-- waitlist_entries is already in the publication (migration 20260623t); confirmed_at flows
-- through the existing entries subscription. waitlist_sms_inbound is service-role written and
-- read on demand by the host stand, so it does NOT need to be in the realtime publication.
