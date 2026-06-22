-- 20260623c_purchase_vat.sql
-- Per-item PURCHASE VAT (input VAT) for the stock system.
--
-- Background: today the stock costing engine treats every purchase price as the
-- cost, with no VAT awareness. For a VAT-registered venue, input VAT is reclaimable
-- so the TRUE cost (and therefore COGS/GP) must be NET (ex-VAT). Alcohol is the
-- canonical case: VAT on the buy AND the sell. This migration adds a per-item
-- purchase VAT rate (reusing the existing tax_rates), a per-supplier-price
-- "price includes VAT" flag (so an operator can type the gross invoice price and
-- have it stripped to net), and net/VAT/gross capture on POs and invoices.
--
-- Design invariants:
--   • The stored purchase price (supplier_products.pack_price, po_lines.unit_price,
--     supplier_invoice_lines.unit_price) keeps its existing meaning; NET cost is
--     DERIVED (strip VAT only when price_includes_tax). current_cost / item_cost_history
--     / stock_movements stay NET — no double-counting, no historical recompute.
--   • purchase_tax_rate_id is a SOFT reference to tax_rates(id) (resolved in app
--     against the loaded tax rates); null = zero-rated / no input VAT. Nullable,
--     default null → fully backward-compatible, no backfill required.
--
-- Additive and reversible. tax_rates lives in this same (Ops) DB.

-- Item-level default purchase VAT rate (flour → zero, vodka → 20%).
alter table inventory_items
  add column if not exists purchase_tax_rate_id uuid;

-- Per-supplier-product override + "the price I typed includes VAT" flag.
-- purchase_tax_rate_id null  → inherit the item-level rate.
-- price_includes_tax false   → pack_price is already NET (the default; "ex VAT").
-- price_includes_tax true    → pack_price is GROSS; net = pack_price / (1 + rate).
alter table supplier_products
  add column if not exists purchase_tax_rate_id uuid,
  add column if not exists price_includes_tax boolean not null default false;

-- Purchase orders: header VAT total (subtotal already exists; payable = subtotal + tax).
alter table purchase_orders
  add column if not exists tax numeric(14,2);

-- PO lines: frozen rate + VAT amount at save time (immune to later tax_rates edits).
alter table po_lines
  add column if not exists purchase_tax_rate_id uuid,
  add column if not exists line_tax numeric(14,2);

-- Supplier invoice lines: same per-line VAT capture for the VAT return + reconciliation.
alter table supplier_invoice_lines
  add column if not exists purchase_tax_rate_id uuid,
  add column if not exists line_tax numeric(14,2);
