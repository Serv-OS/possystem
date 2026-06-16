-- Marketing & Promotions — Slice 2: sending infrastructure (message log + suppression list).
-- Additive. Ops DB, org-scoped RLS. Consent lives in customer_consents (reused); this adds the
-- per-send message ledger (for delivery/engagement + attribution) and the hard-block suppression list.

-- (A) Every marketing send (one row per recipient per channel) -----------------
create table if not exists marketing_messages (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  company_id          uuid,
  customer_id         uuid,
  campaign_id         uuid,                                -- reserved (slice 4)
  workflow_id         uuid,                                -- reserved (slice 6)
  template_id         uuid,                                -- reserved (slice 5)
  channel             text not null check (channel in ('email','sms')),
  to_address          text not null,                       -- email or E.164 phone
  subject             text,
  preview             text,                                -- short body preview (audit; not full HTML)
  status              text not null default 'queued'
                      check (status in ('queued','sandbox','sent','delivered','opened','clicked','bounced','complained','failed','suppressed','no_consent','unreachable')),
  provider            text,
  provider_message_id text,
  error               text,
  promo_code          text,                                -- attached code (links to promo_codes)
  sent_at             timestamptz,
  delivered_at        timestamptz,
  opened_at           timestamptz,
  clicked_at          timestamptz,
  idempotency_key     text,
  created_at          timestamptz not null default now()
);
create unique index if not exists marketing_messages_idem_uidx on marketing_messages (idempotency_key) where idempotency_key is not null;
create index if not exists marketing_messages_org_idx on marketing_messages (org_id, created_at desc);
create index if not exists marketing_messages_customer_idx on marketing_messages (customer_id);
create index if not exists marketing_messages_campaign_idx on marketing_messages (campaign_id);
create index if not exists marketing_messages_provider_idx on marketing_messages (provider_message_id) where provider_message_id is not null;
alter table marketing_messages enable row level security;
drop policy if exists marketing_messages_read on marketing_messages;
create policy marketing_messages_read on marketing_messages for select using (org_id::text in (select public.user_accessible_orgs()));

-- (B) Hard-block suppression list (unsubscribe / STOP / bounce / complaint) -----
create table if not exists marketing_suppressions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  channel             text not null check (channel in ('email','sms')),
  address             text not null,                       -- normalised email (lower) or E.164 phone
  reason              text not null default 'unsubscribe'
                      check (reason in ('unsubscribe','stop','bounce','complaint','manual')),
  source              text,
  customer_id         uuid,
  created_at          timestamptz not null default now()
);
-- Plain-column unique index (not lower(address)): suppress() always normalises the address before
-- insert (email lower-cased, phone whitespace-stripped), and PostgREST upsert onConflict can only
-- target real columns, not an expression index.
create unique index if not exists marketing_suppressions_uidx on marketing_suppressions (org_id, channel, address);
create index if not exists marketing_suppressions_org_idx on marketing_suppressions (org_id, channel);
alter table marketing_suppressions enable row level security;
drop policy if exists marketing_suppressions_read on marketing_suppressions;
create policy marketing_suppressions_read on marketing_suppressions for select using (org_id::text in (select public.user_accessible_orgs()));
