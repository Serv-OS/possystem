-- Marketing & Promotions — Slice 4: campaign + trigger engine.
-- Additive. Org-scoped RLS. A campaign targets a segment (slice 3) and/or a trigger (e.g. birthday),
-- optionally attaches an offer (slice 1) so each recipient gets a unique single-use promo code, and
-- sends via marketing-send (slice 2, consent/suppression/sandbox enforced there).
--
-- Idempotency model (the "never twice" guarantee for the birthday scenario):
--   campaign_runs  unique (campaign_id, run_key)     → a campaign runs at most once per day-window,
--                                                       even if Vercel Cron double-fires.
--   campaign_sends unique (campaign_id, customer_id, dedupe_key)
--                                                     → a given customer gets a given OCCURRENCE at
--                                                       most once. For birthday, dedupe_key keys on the
--                                                       birthday's year (bday:2026), NOT the run date,
--                                                       so adjacent-day matches / re-runs never resend.

create table if not exists campaigns (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  name         text not null,
  description  text,
  type         text not null default 'automation' check (type in ('one_off','automation')),
  status       text not null default 'draft' check (status in ('draft','scheduled','active','paused','archived')),
  channel      text not null default 'email' check (channel in ('email','sms','both')),
  segment_id   uuid,                                   -- audience (one_off) / extra filter (automation)
  trigger      jsonb not null default '{}'::jsonb,     -- { type:'birthday'|'date'|'manual', days_before, ... }
  schedule     jsonb not null default '{}'::jsonb,     -- { send_time, ... } (advisory; cron time is fixed)
  subject      text,                                   -- email subject (merge tags)
  email_html   text,                                   -- email body (merge tags) — slice 5 adds the builder
  sms_body     text,                                   -- sms body (merge tags)
  from_name    text,
  offer_id     uuid,                                   -- attach → issue a unique promo code per recipient
  last_run_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists campaigns_org_idx on campaigns (org_id, created_at desc);
create index if not exists campaigns_active_idx on campaigns (status, type) where status = 'active';
alter table campaigns enable row level security;
drop policy if exists campaigns_read on campaigns;
create policy campaigns_read on campaigns for select using (org_id::text in (select public.user_accessible_orgs()));

create table if not exists campaign_runs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  campaign_id  uuid not null,
  run_key      text not null,                          -- e.g. 'birthday:2026-06-16' (the day-window)
  status       text not null default 'running' check (status in ('running','done','error','skipped')),
  candidates   integer not null default 0,
  sent         integer not null default 0,
  skipped      integer not null default 0,
  failed       integer not null default 0,
  error        text,
  run_at       timestamptz not null default now(),
  finished_at  timestamptz
);
create unique index if not exists campaign_runs_uidx on campaign_runs (campaign_id, run_key);
create index if not exists campaign_runs_org_idx on campaign_runs (org_id, run_at desc);
alter table campaign_runs enable row level security;
drop policy if exists campaign_runs_read on campaign_runs;
create policy campaign_runs_read on campaign_runs for select using (org_id::text in (select public.user_accessible_orgs()));

create table if not exists campaign_sends (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  campaign_id      uuid not null,
  run_id           uuid,
  customer_id      uuid not null,
  dedupe_key       text not null,                      -- 'bday:2026' (occurrence) / 'oneoff'
  channel          text,                               -- 'email' | 'sms' | 'both'
  email_message_id uuid,
  sms_message_id   uuid,
  promo_code       text,
  status           text not null default 'pending' check (status in ('pending','sent','partial','skipped','failed')),
  error            text,
  created_at       timestamptz not null default now()
);
create unique index if not exists campaign_sends_uidx on campaign_sends (campaign_id, customer_id, dedupe_key);
create index if not exists campaign_sends_org_idx on campaign_sends (org_id, created_at desc);
create index if not exists campaign_sends_run_idx on campaign_sends (run_id);
alter table campaign_sends enable row level security;
drop policy if exists campaign_sends_read on campaign_sends;
create policy campaign_sends_read on campaign_sends for select using (org_id::text in (select public.user_accessible_orgs()));
