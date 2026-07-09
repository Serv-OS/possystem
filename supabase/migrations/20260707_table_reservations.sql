-- 20260707_table_reservations.sql
-- Cross-device table reservations, in a DEDICATED table — deliberately ISOLATED from active_sessions
-- so a reservation can NEVER touch (or be mistaken for) a table with a live order. One row per
-- (location_id, table_id). RLS mirrors the POS-readable operational tables (kds_tickets /
-- active_sessions / pos_nudges = "allow all") so the anonymous till reads/writes it over the same
-- realtime it already uses. REPLICA IDENTITY FULL so DELETE events carry table_id (used to clear a
-- cancelled reservation on the other devices).

create table if not exists public.table_reservations (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null,
  table_id     text not null,
  reservation  jsonb not null,
  updated_at   timestamptz not null default now(),
  unique (location_id, table_id)
);
create index if not exists table_reservations_loc_idx on public.table_reservations(location_id);

alter table public.table_reservations enable row level security;
drop policy if exists "allow all" on public.table_reservations;
create policy "allow all" on public.table_reservations for all using (true) with check (true);

alter table public.table_reservations replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'table_reservations') then
    execute 'alter publication supabase_realtime add table table_reservations';
  end if;
end $$;
