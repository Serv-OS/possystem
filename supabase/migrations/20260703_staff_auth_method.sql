-- 20260703_staff_auth_method.sql — enforced per-staff sign-in method + sign-in audit (Ops DB).
-- Additive + reversible. Default 'pin' = no change for existing staff. A 'card' staff cannot sign
-- in with a PIN (enforced in the app) unless a manager arms a one-off override — this is the
-- security point (shared PINs no longer let anyone in as a card-staff).

alter table staff_members
  add column if not exists auth_method text not null default 'pin'
    check (auth_method in ('pin','card','fingerprint'));

comment on column staff_members.auth_method is
  'Enforced sign-in method: pin | card | fingerprint. Card-staff are refused PIN (manager override aside). v5.5.688';

-- Append-only accountability log: who signed in, how, on which device, approved by whom.
create table if not exists staff_auth_events (
  id           uuid primary key default gen_random_uuid(),
  location_id  text not null,
  staff_id     text,
  method       text not null check (method in ('pin','card','override','fingerprint')),
  device_id    text,
  approved_by  text,                                   -- manager staff id for an override
  created_at   timestamptz not null default now()
);
create index if not exists staff_auth_events_loc_idx on staff_auth_events (location_id, created_at desc);

-- RLS: devices (anon/authenticated POS sessions) may INSERT their own sign-in events; no client
-- SELECT policy → only the service role / Back Office (via an edge fn) can read the log.
alter table staff_auth_events enable row level security;
drop policy if exists staff_auth_events_insert on staff_auth_events;
create policy staff_auth_events_insert on staff_auth_events for insert to anon, authenticated with check (true);

-- Rollback:
-- drop table if exists staff_auth_events;
-- alter table staff_members drop column if exists auth_method;
