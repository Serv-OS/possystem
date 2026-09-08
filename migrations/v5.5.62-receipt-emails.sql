-- v5.5.62 — receipt_emails delivery audit table
-- Ops DB: tbetcegmszzotrwdtqhi
-- Provider-agnostic email-receipt audit log. The send-receipt edge function
-- writes a row here per dispatch attempt. Provider can be swapped later by
-- changing one env var (RECEIPT_EMAIL_PROVIDER) and the credentials secrets.

create table if not exists receipt_emails (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  check_id text,
  to_email text not null,
  subject text,
  status text not null default 'pending',
  -- pending | queued | sent | failed
  provider text,
  provider_message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists receipt_emails_location_idx on receipt_emails(location_id);
create index if not exists receipt_emails_check_idx on receipt_emails(check_id) where check_id is not null;
create index if not exists receipt_emails_status_idx on receipt_emails(status);

alter table receipt_emails enable row level security;
drop policy if exists "allow read all" on receipt_emails;
create policy "allow read all" on receipt_emails for select to anon, authenticated using (true);
-- Writes happen via the edge function (service_role) only.
