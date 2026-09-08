-- v4.6.5 — Cross-device sync for walk-in orders and bar tabs
-- Ops DB: tbetcegmszzotrwdtqhi
-- Paste into Supabase SQL Editor and Run.

create table if not exists order_queue (
  ref text primary key,
  location_id text not null,
  type text not null,
  customer jsonb default '{}'::jsonb,
  items jsonb default '[]'::jsonb,
  total numeric(10,2) default 0,
  status text default 'received',
  staff text,
  created_at timestamptz default now(),
  sent_at timestamptz,
  collection_time text,
  is_asap boolean default false,
  updated_at timestamptz default now()
);
create index if not exists idx_order_queue_location on order_queue(location_id);
create index if not exists idx_order_queue_status on order_queue(location_id, status);

create table if not exists bar_tabs (
  id text primary key,
  location_id text not null,
  ref text,
  name text not null,
  seat_id text,
  table_id text,
  opened_by text,
  opened_at timestamptz default now(),
  status text default 'open',
  pre_auth boolean default false,
  pre_auth_amount numeric(10,2) default 0,
  rounds jsonb default '[]'::jsonb,
  note text default '',
  total numeric(10,2) default 0,
  updated_at timestamptz default now()
);
create index if not exists idx_bar_tabs_location on bar_tabs(location_id);
create index if not exists idx_bar_tabs_status on bar_tabs(location_id, status);

alter table order_queue enable row level security;
alter table bar_tabs enable row level security;
drop policy if exists "allow all" on order_queue;
drop policy if exists "allow all" on bar_tabs;
create policy "allow all" on order_queue for all using (true) with check (true);
create policy "allow all" on bar_tabs for all using (true) with check (true);

alter table order_queue replica identity full;
alter table bar_tabs replica identity full;

do $$
begin
  begin alter publication supabase_realtime add table order_queue; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table bar_tabs; exception when duplicate_object then null; end;
end $$;

create or replace function _touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;
drop trigger if exists trg_order_queue_updated_at on order_queue;
drop trigger if exists trg_bar_tabs_updated_at on bar_tabs;
create trigger trg_order_queue_updated_at before update on order_queue for each row execute function _touch_updated_at();
create trigger trg_bar_tabs_updated_at before update on bar_tabs for each row execute function _touch_updated_at();
