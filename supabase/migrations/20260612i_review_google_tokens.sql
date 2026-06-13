-- 20260612i_review_google_tokens.sql  (OPS DB)
--
-- Stores the per-venue Google Business Profile OAuth connection. The refresh
-- token is a SECRET, so this table is service-role-only (RLS enabled, NO read
-- policy) — only the review-google / review-sync / review-reply edge functions
-- touch it. The non-secret connection status the back office shows comes back
-- through the review-google `status` action, never a direct client read.

create table if not exists review_google_tokens (
  location_id    text primary key,          -- ops location id
  company_id     uuid,
  account_name   text,                       -- "accounts/{id}"
  location_name  text,                        -- "accounts/{id}/locations/{id}" (the chosen GBP location)
  location_title text,                        -- human label
  account_email  text,                        -- the Google account that connected
  available      jsonb not null default '[]'::jsonb,  -- [{name,title}] when the account has >1 location
  refresh_token  text not null,               -- SECRET — never leaves the server
  scope          text,
  connected_by   uuid,
  connected_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table review_google_tokens enable row level security;
-- no policies → only the service role (edge functions) can read/write.

-- Short-lived OAuth state → location map (CSRF/hijack guard for the callback).
create table if not exists review_oauth_pending (
  nonce       text primary key,
  location_id text not null,
  company_id  uuid,
  created_at  timestamptz not null default now()
);
alter table review_oauth_pending enable row level security;  -- service-role only
