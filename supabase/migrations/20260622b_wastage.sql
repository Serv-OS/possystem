-- v5.5.573 — Stock & Production: wastage logging (slice 5)
--
-- Recording waste posts a WASTE movement (negative, valued at current cost) so
-- on-hand and "the gap" stay correct (waste is a KNOWN, explained loss). waste_events
-- holds the reason/audit; the ledger holds the stock effect. Additive.

create table if not exists waste_events (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null,
  inventory_item_id uuid references inventory_items(id) on delete set null,
  item_name         text,                 -- snapshot for the log if item later removed
  qty               numeric(14,4) not null,
  unit              text not null default 'each',
  qty_base          numeric(14,4),
  reason            text,
  note              text,
  cost_value        numeric(14,2),
  source            text not null default 'backoffice',  -- backoffice | pos
  logged_by         uuid,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create index if not exists waste_events_loc_idx on waste_events(location_id, occurred_at desc);

alter table waste_events enable row level security;
drop policy if exists waste_events_rls on waste_events;
create policy waste_events_rls on waste_events
  for all
  using (location_id in (select location_id from user_accessible_locations()))
  with check (location_id in (select location_id from user_accessible_locations()));
