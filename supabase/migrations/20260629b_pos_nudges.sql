-- 20260629b_pos_nudges.sql
-- DB-backed "nudge" so a manager can ping a stalled table to the tills RELIABLY (no broadcast timing
-- race). The Manager app INSERTs a row; the POS picks it up via the SAME postgres_changes realtime it
-- already uses for KDS tickets / sessions, then shows a toast + chime. Transient (rows are tiny + can
-- be pruned). RLS mirrors the existing POS-readable operational tables (kds_tickets/active_sessions =
-- "allow all"), which is how the anonymous till is able to read them over realtime.

create table if not exists pos_nudges (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null,
  table_label  text,
  covers       int,
  wait_mins    int,
  by_name      text,
  created_at   timestamptz not null default now()
);
create index if not exists pos_nudges_loc_idx on pos_nudges(location_id, created_at desc);

alter table pos_nudges enable row level security;
drop policy if exists "allow all" on pos_nudges;
create policy "allow all" on pos_nudges for all using (true) with check (true);

-- Stream INSERTs to subscribed tills (same publication the POS already listens on).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pos_nudges') then
    execute 'alter publication supabase_realtime add table pos_nudges';
  end if;
end $$;
