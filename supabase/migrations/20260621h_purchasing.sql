-- v5.5.567 — Stock & Production: slice 7 (purchasing — POs, receiving, invoices)
--
-- Suppliers already exist (20260621d). This adds purchase orders, their lines,
-- and scanned/keyed supplier invoices. Receiving a PO or posting an invoice writes
-- PURCHASE_RECEIPT movements to the stock ledger and updates effective-dated cost
-- (moving-average) via the existing post_stock_movement RPC + item_cost_history.
-- Additive; existing tables untouched.

create table if not exists purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  supplier_id   uuid references suppliers(id) on delete set null,
  reference     text,                       -- human PO number
  status        text not null default 'DRAFT' check (status in ('DRAFT','SENT','PARTIAL','RECEIVED','CANCELLED')),
  expected_date date,
  ordered_at    timestamptz,
  received_at   timestamptz,
  subtotal      numeric(14,2),
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists po_loc_idx on purchase_orders(location_id, created_at desc);

create table if not exists po_lines (
  id                  uuid primary key default gen_random_uuid(),
  location_id         uuid not null,
  po_id               uuid not null references purchase_orders(id) on delete cascade,
  inventory_item_id   uuid references inventory_items(id) on delete set null,
  supplier_product_id uuid references supplier_products(id) on delete set null,
  description         text,
  qty_packs           numeric(14,4) not null default 1,   -- packs ordered
  pack_qty            numeric(14,4) not null default 1,   -- packs of inner
  inner_qty           numeric(14,4) not null default 1,   -- inner content
  inner_unit          text not null default 'each',
  unit_price          numeric(12,4) not null default 0,   -- £ per pack
  qty_received        numeric(14,4) not null default 0,   -- packs received
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now()
);
create index if not exists po_lines_po_idx on po_lines(po_id);

create table if not exists supplier_invoices (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null,
  supplier_id     uuid references suppliers(id) on delete set null,
  po_id           uuid references purchase_orders(id) on delete set null,
  invoice_number  text,
  invoice_date    date,
  status          text not null default 'REVIEW' check (status in ('REVIEW','POSTED','VOID')),
  ocr_confidence  numeric(5,2),
  subtotal        numeric(14,2),
  tax             numeric(14,2),
  total           numeric(14,2),
  raw_json        jsonb,
  posted_at       timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists supplier_invoices_loc_idx on supplier_invoices(location_id, created_at desc);

create table if not exists supplier_invoice_lines (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null,
  invoice_id      uuid not null references supplier_invoices(id) on delete cascade,
  matched_item_id uuid references inventory_items(id) on delete set null,
  description     text,
  qty             numeric(14,4) not null default 0,
  unit            text not null default 'each',
  unit_price      numeric(12,4) not null default 0,    -- £ per `unit`
  line_total      numeric(14,2),
  flags           jsonb not null default '[]'::jsonb,  -- ['PRICE_UP','NEW_ITEM','MATH',…]
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists supplier_invoice_lines_inv_idx on supplier_invoice_lines(invoice_id);

alter table purchase_orders        enable row level security;
alter table po_lines               enable row level security;
alter table supplier_invoices      enable row level security;
alter table supplier_invoice_lines enable row level security;

do $$
declare t text;
begin
  foreach t in array array['purchase_orders','po_lines','supplier_invoices','supplier_invoice_lines'] loop
    execute format('drop policy if exists %I_rls on %I;', t, t);
    execute format($f$
      create policy %I_rls on %I
        for all
        using (location_id in (select location_id from user_accessible_locations()))
        with check (location_id in (select location_id from user_accessible_locations()));
    $f$, t, t);
  end loop;
end $$;
