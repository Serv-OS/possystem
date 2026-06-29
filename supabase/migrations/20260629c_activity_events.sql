-- 20260629c_activity_events.sql
-- One operational ACTIVITY FEED for the tills: orders coming in, manager nudges / things needing
-- action, menu & price changes, and ops/compliance signals — all in one timeline the floor can scan.
-- The POS reads it over the SAME postgres_changes realtime it already uses for KDS/sessions, shows a
-- bell + slide-over panel, and chimes/toasts for action items. RLS mirrors the other POS-readable
-- operational tables ("allow all"), which is how the anonymous tills read+write them over realtime.

create table if not exists activity_events (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null,
  kind         text not null,                       -- order | nudge | menu | stock | ops | system
  severity     text not null default 'info',        -- info | action | urgent
  title        text not null,
  body         text,
  ref_type     text,                                -- e.g. 'table' | 'order' | 'item' | 'maintenance'
  ref_id       text,
  actor_name   text,
  acked_at     timestamptz,
  acked_by     text,
  created_at   timestamptz not null default now()
);
create index if not exists activity_events_loc_idx on activity_events(location_id, created_at desc);

alter table activity_events enable row level security;
drop policy if exists "allow all" on activity_events;
create policy "allow all" on activity_events for all using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_events') then
    execute 'alter publication supabase_realtime add table activity_events';
  end if;
end $$;
