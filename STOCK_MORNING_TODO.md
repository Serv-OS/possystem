# Stock build — morning checklist (23 Jun)

Everything below is **built, deployed and building clean** (v5.5.569 → v5.5.573).
Two DB migrations are **NOT yet applied** because they need your sign-off — apply
those first, then test line by line.

## 1. Apply the two pending migrations (needs your OK)

These are additive, idempotent, and don't touch existing tables:

- `supabase/migrations/20260622_par_counts.sql`  → par_levels, stock_counts, stock_count_lines
- `supabase/migrations/20260622b_wastage.sql`     → waste_events

Until these run, **Stock counts** and **Wastage** screens will show empty / fail to
save (they're guarded — nothing crashes). Everything else already works (their tables
were applied earlier: stock_foundation, stock_movements, recipes, production_batches,
purchasing).

Say the word and I'll apply both via the Management API; or run them in the Supabase
SQL editor yourself.

## 2. Test checklist (line by line)

**Already live (tables applied):**
- [ ] Inventory → **Overview**: stats + 5-step checklist + recent movements render.
- [ ] Stock items: add "Heineken", unit = litres; Suppliers tab → "54 l for £152" → shows £2.81/l.
- [ ] Stock items → Stock tab → Set count 54 → on-hand 54 l, value £152, movement logged.
- [ ] Produce → Recipes → Dish "Heineken Half" linked to menu item, uses 0.5 pt → £0.80, GP shows.
- [ ] Sell a Heineken Half on POS → keg on-hand drops 0.284 l; Stock tab shows a "Sale".
- [ ] Produce → Recipes → Prep recipe producing a made item; Produce → Batches → produce it → ingredients consumed, made item added.
- [ ] Purchasing → Suppliers → add one; Purchase orders → create → send → receive → stock up, cost updated.
- [ ] Purchasing → Invoices → scan a real invoice → match lines → post → stock up.
- [ ] Stock reports → Valuation / Recipe GP / Movements all populate + CSV export.
- [ ] Daily counts → variant rows read "Heineken Half" (not bare "Half").

**After applying the two migrations:**
- [ ] Inventory → Stock counts → New count → enter counts → Approve → on-hand reconciles, variance recorded.
- [ ] Stock reports → The Gap → counted items show variance £.
- [ ] Inventory → Wastage → log waste → comes off stock, valued; 30-day log + total.

## 3. Known limits / next (not blocking)
- Kiosk & online sales don't deplete stock yet (anonymous users can't read recipe
  tables under RLS) — needs a small server-side function. POS/bar/table do deplete.
- Par-level editing UI + par-driven suggested ordering (par_levels table is ready).
- POS-side waste button (back-office wastage works now).
- Supplier credit-requests from invoice discrepancies; CPU/commissary transfers.
- Dish GP uses the menu base price; exact ex-VAT handling is a later polish.

See `STOCK_GUIDE.md` for the full how-to.
