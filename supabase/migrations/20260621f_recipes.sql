-- v5.5.564 — Stock & Production: slice 3a (recipes & nested sub-recipes)
--
-- A recipe builds an output from component stock items (and/or other recipes).
--   MENU recipe → the spec of a sellable dish; linked to a menu_item via
--                 menu_item_recipes. Yield is 1 plate. Drives theoretical COGS/GP.
--   PREP/BATCH  → a sub-recipe that PRODUCES a MADE inventory_item (output_item_id);
--                 its rolled cost ÷ yield becomes that item's unit cost. Nesting:
--                 a recipe_line can reference a MADE item that has its own recipe.
--
-- Costing is computed by the engine in src/lib/stock/costing.js (recursive,
-- cycle-detected, memoised). Additive; existing tables untouched.

create table if not exists recipes (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null,
  name            text not null,
  recipe_type     text not null default 'MENU' check (recipe_type in ('MENU','PREP','BATCH')),
  output_item_id  uuid references inventory_items(id) on delete set null, -- PREP/BATCH only
  yield_qty       numeric(14,4) not null default 1,
  yield_unit      text not null default 'each',
  wastage_pct     numeric(6,3) not null default 0,
  gp_target_pct   numeric(6,3),            -- optional GP% target for dishes
  method          text,
  photo           text,
  status          text not null default 'active',
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists recipes_loc_idx on recipes(location_id) where archived_at is null;
create index if not exists recipes_output_idx on recipes(output_item_id);

create table if not exists recipe_lines (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null,
  recipe_id        uuid not null references recipes(id) on delete cascade,
  component_item_id uuid not null references inventory_items(id) on delete restrict,
  qty              numeric(14,4) not null,
  unit             text not null,
  usable_pct       numeric(6,3) not null default 100,   -- trim/yield loss (100 = none)
  sort_order       integer not null default 0,
  note             text,
  created_at       timestamptz not null default now()
);
create index if not exists recipe_lines_recipe_idx on recipe_lines(recipe_id);
create index if not exists recipe_lines_comp_idx on recipe_lines(component_item_id);

-- One menu product ↔ one recipe (its spec), with a portion multiplier (usually 1).
create table if not exists menu_item_recipes (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  menu_item_id  text not null,
  recipe_id     uuid not null references recipes(id) on delete cascade,
  portion       numeric(10,4) not null default 1,
  created_at    timestamptz not null default now(),
  unique (location_id, menu_item_id)
);
create index if not exists menu_item_recipes_recipe_idx on menu_item_recipes(recipe_id);

alter table recipes            enable row level security;
alter table recipe_lines       enable row level security;
alter table menu_item_recipes  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['recipes','recipe_lines','menu_item_recipes'] loop
    execute format('drop policy if exists %I_rls on %I;', t, t);
    execute format($f$
      create policy %I_rls on %I
        for all
        using (location_id in (select location_id from user_accessible_locations()))
        with check (location_id in (select location_id from user_accessible_locations()));
    $f$, t, t);
  end loop;
end $$;
