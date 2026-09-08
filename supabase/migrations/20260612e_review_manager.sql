-- 20260612e_review_manager.sql  (OPS DB)
--
-- Review Manager — reputation module. Operational, location-scoped, lives next
-- to closed_checks/order_queue in the Ops DB. Reads are tenant-fenced via the
-- standard user_accessible_locations() RLS; all WRITES go through service-role
-- edge functions (the public review card submits anonymously, staff actions go
-- through authed edge fns), so no INSERT/UPDATE policies are granted to clients.
--
-- location_id is the OPS location id (matches user_accessible_locations()).
-- company_id is denormalised from the platform location for reporting/rollups.

-- ── per-venue config: routing threshold, copy, AI behaviour ─────────────────
create table if not exists review_settings (
  location_id            text primary key,
  company_id             uuid,
  enabled                boolean not null default true,
  threshold              smallint not null default 3 check (threshold between 1 and 5),
  page_title             text,
  intro_copy             text,                 -- "How did we do?"
  thanks_public_copy     text,                 -- shown on the happy/auto-publish screen
  thanks_private_copy    text,                 -- shown on the unhappy/recovery screen
  ai_auto_draft          boolean not null default true,
  ai_auto_send_hours     integer,              -- null = never auto-send (off by default)
  brand_voice            text,                 -- system-prompt steer for Claude
  custom_copy            jsonb not null default '{}'::jsonb,  -- per-rating overrides
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ── the feedback itself (card-origin OR platform-synced) ────────────────────
create table if not exists review_feedback (
  id               uuid primary key default gen_random_uuid(),
  location_id      text not null,
  company_id       uuid,
  customer_id      uuid,                        -- linked CRM customer, if known
  customer_name    text,
  customer_email   text,
  customer_phone   text,
  rating           smallint not null check (rating between 1 and 5),
  comment          text,
  private_detail   text,                        -- extra "what happened" from the recovery form
  is_public        boolean not null,            -- DERIVED server-side: rating >= threshold
  origin           text not null default 'card' check (origin in ('card','synced')),
  channel          text check (channel in ('email','sms','qr','wifi','web')),
  source_platform  text check (source_platform in ('google','tripadvisor','facebook')),
  external_review_id text,                      -- platform id, for dedup of synced reviews
  published_to     jsonb not null default '[]'::jsonb,  -- [{platform,status,at}]
  status           text not null default 'new' check (status in ('new','drafted','approved','resolved','archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists review_feedback_loc_created on review_feedback(location_id, created_at desc);
create index if not exists review_feedback_status on review_feedback(location_id, status);
create unique index if not exists review_feedback_external_uq on review_feedback(external_review_id) where external_review_id is not null;

-- ── AI-drafted replies (public reply OR private recovery), human-approved ────
create table if not exists review_replies (
  id           uuid primary key default gen_random_uuid(),
  feedback_id  uuid not null references review_feedback(id) on delete cascade,
  location_id  text not null,
  kind         text not null check (kind in ('public_reply','private_recovery')),
  ai_draft     text,
  edited_text  text,                            -- human edit overwrites the draft
  tone         text,
  status       text not null default 'pending' check (status in ('pending','approved','sent','posted','skipped')),
  approved_by  uuid,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists review_replies_feedback on review_replies(feedback_id);
create index if not exists review_replies_status on review_replies(location_id, status);

-- ── connected platforms (auto-publish targets + inbound sync sources) ───────
create table if not exists review_platform_links (
  id               uuid primary key default gen_random_uuid(),
  location_id      text not null,
  company_id       uuid,
  platform         text not null check (platform in ('google','tripadvisor','facebook')),
  enabled          boolean not null default false,
  url              text,
  external_place_id text,
  last_synced_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (location_id, platform)
);

-- ── dashboard theme rollups (AI-extracted) ──────────────────────────────────
create table if not exists review_themes (
  id           uuid primary key default gen_random_uuid(),
  location_id  text not null,
  label        text not null,
  count        integer not null default 0,
  sentiment    text not null check (sentiment in ('positive','negative')),
  period_start date,
  updated_at   timestamptz not null default now()
);
create index if not exists review_themes_loc on review_themes(location_id, sentiment);

-- ── RLS: tenant-fenced READS for staff; writes are service-role only ────────
alter table review_settings        enable row level security;
alter table review_feedback        enable row level security;
alter table review_replies         enable row level security;
alter table review_platform_links  enable row level security;
alter table review_themes          enable row level security;

do $$ begin
  create policy review_settings_read on review_settings for select
    using (location_id in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy review_feedback_read on review_feedback for select
    using (location_id in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy review_replies_read on review_replies for select
    using (location_id in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy review_platform_links_read on review_platform_links for select
    using (location_id in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy review_themes_read on review_themes for select
    using (location_id in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;
