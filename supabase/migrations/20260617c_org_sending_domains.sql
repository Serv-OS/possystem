-- Custom sending domains — per-org branded email (via Resend). Additive, org-scoped RLS.
-- A venue verifies its own domain (DNS records) once; the senders then send From that domain.
-- The From is ONLY used when status='verified' AND is_active — otherwise the senders fall back to
-- the platform default, so a missing/broken custom domain can never block a receipt.
create table if not exists org_sending_domains (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  domain            text not null,                          -- e.g. mail.thefoxinn.co.uk
  resend_domain_id  text,                                   -- Resend domain object id
  region            text not null default 'eu-west-1',
  status            text not null default 'not_started'
                    check (status in ('not_started','pending','verified','partially_verified','partially_failed','temporary_failure','failed')),
  dns_records       jsonb not null default '[]'::jsonb,     -- cached Resend records[] for the BO screen
  from_name         text,
  from_address      text,
  reply_to          text,
  is_active         boolean not null default false,         -- gate: only send-from when true AND verified
  last_checked_at   timestamptz,
  verified_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, domain)
);
create unique index if not exists org_sending_domains_one_active on org_sending_domains (org_id) where is_active;
create index if not exists org_sending_domains_org_idx on org_sending_domains (org_id);
alter table org_sending_domains enable row level security;
drop policy if exists org_sending_domains_read on org_sending_domains;
create policy org_sending_domains_read on org_sending_domains for select using (org_id::text in (select public.user_accessible_orgs()));
