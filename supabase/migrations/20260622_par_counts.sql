-- v5.5.572 — Stock & Production: par levels + stock counts (slice 4)
--
-- par_levels: target/reorder/min per item per location (drives low-stock + future
-- suggested ordering). stock_counts + stock_count_lines: a counting session that,
-- on APPROVAL, posts STOCK_COUNT_ADJ movements (delta = counted − current on-hand)
-- via post_stock_movement — so on-hand reconciles to the physical count and the
-- correction IS the "gap". Expected qty is snapshotted at count-start. Additive.

create table if not exists par_levels (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null,
  inventory_item_id uuid not null references inventory_items(id) on delete cascade,
  par_level         numeric(14,4),
  reorder_point     numeric(14,4),
  min_level         numeric(14,4),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (location_id, inventory_item_id)
);
create index if not exists par_levels_loc_idx on par_levels(location_id);

create table if not exists stock_counts (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  name          text,
  count_type    text not null default 'FULL' check (count_type in ('FULL','PARTIAL','SPOT')),
  status        text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','APPROVED','CANCELLED')),
  storage_area  text,
  started_by    uuid,
  started_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  approved_by   uuid,
  approved_at   timestamptz,
  variance_value numeric(14,2),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists stock_counts_loc_idx on stock_counts(location_id, created_at desc);

create table if not exists stock_count_lines (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null,
  count_id          uuid not null references stock_counts(id) on delete cascade,
  inventory_item_id uuid not null references inventory_items(id) on delete cascade,
  counted_qty       numeric(14,4),
  expected_qty      numeric(14,4),          -- snapshot of on-hand at count start
  variance_qty      numeric(14,4),
  unit_cost         numeric(12,5),
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now()
);
create index if not exists stock_count_lines_count_idx on stock_count_lines(count_id);

alter table par_levels        enable row level security;
alter table stock_counts      enable row level security;
alter table stock_count_lines enable row level security;

do $$
declare t text;
begin
  foreach t in array array['par_levels','stock_counts','stock_count_lines'] loop
    execute format('drop policy if exists %I_rls on %I;', t, t);
    execute format($f$
      create policy %I_rls on %I
        for all
        using (location_id in (select location_id from user_accessible_locations()))
        with check (location_id in (select location_id from user_accessible_locations()));
    $f$, t, t);
  end loop;
end $$;
