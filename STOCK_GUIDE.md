# ServOS Stock & Production — User Guide

A plain-English guide to running stock in ServOS. The golden rule first, then a
5-minute setup, then worked examples and how the reports work.

> **Golden rule: one unit per item.** Pick the unit you naturally hold an item in
> (litres for a keg, grams for mince, each for buns), buy in that unit, and recipe
> in that unit or one that converts to it (pints↔litres, kg↔g — automatic). Mixing
> *dimensions* (e.g. stock unit "each" but recipe in "pints") is the only thing that
> breaks, and the screen will warn you if you do.

---

## Where everything lives — Back office → Inventory / Produce / Purchasing

| Menu | Screen | What it's for |
|---|---|---|
| Inventory | **Overview** | Dashboard + a 5-step guided setup. Start here. |
| Inventory | **Stock items** | The things you hold/buy/make. Set unit, price, recipe-link. |
| Inventory | **Stock counts** | Walk the shelves, enter what you have, reconcile. |
| Inventory | **Wastage** | Record spoilage/breakage. |
| Inventory | **Daily counts** | (Legacy) menu-portion limits for 86'ing — separate from real stock. |
| Inventory | **Stock reports** | Valuation, Recipe GP, Movements, The Gap. |
| Produce | **Recipes** | Dish specs (cost & GP) + prep/sub-recipes. |
| Produce | **Batches** | Make a prep item (consumes ingredients, adds the made item). |
| Purchasing | **Suppliers / Purchase orders / Invoices** | Order and receive stock. |

---

## 5-minute setup (Inventory → Overview tells you where you are)

1. **Add stock items** (Inventory → Stock items → +). Give each a name and a **stock
   unit** (the unit you hold it in).
2. **Set a price** (item → Suppliers tab → "1 delivery unit = qty unit for £"). The
   cost per unit is worked out for you.
3. **Build recipes** (Produce → Recipes) and **link each to its menu item** — this is
   what makes a sale deplete stock and show a cost/GP.
4. **Count your stock** (Inventory → Stock counts → New count) so on-hand is real.
5. **Add suppliers & receive deliveries** (Purchasing) to keep stock and costs current.

---

## Worked example 1 — a keg of Heineken (drinks by volume)

1. **Stock items → +** → Name `Heineken`, **Stock unit = litres (l)**. Save.
2. **Suppliers tab → Add** → choose/add supplier → **`1 delivery unit = 54 l for £152`**
   → shows **£2.81/l**. Tick **Preferred**. (That's the cost done: 152 ÷ 54.)
3. **Stock tab → Set count → `54`** → on-hand 54 l, value £152.
4. **Produce → Recipes → + → Dish** → Name `Heineken Half`, link the menu item
   "Heineken Half", add ingredient **Heineken → uses `0.5` `pt`** → shows **£0.80**
   (half a pint = 0.284 l × £2.81; pints convert to litres automatically). A pint
   would be £1.60.
5. **Sell a Heineken Half on the POS** → the keg drops 0.284 l and £0.80 cost is
   logged. A 54 l keg ≈ **190 half-pints**.

## Worked example 2 — mince (food by weight)

1. Stock item `Beef mince`, **stock unit = grams (g)**.
2. Supplier: `1 delivery unit = 5 kg for £30` → **£0.006/g** (kg converts to g
   automatically).
3. In a burger recipe: **Beef mince → uses `150` `g`** → £0.90.

## Worked example 3 — a prep item you make (dough), then a batch

1. Stock item `Pizza dough`, **stock unit = each** (dough balls), **Type = Made here**.
2. Produce → Recipes → + → **Prep / sub-recipe** → produces `Pizza dough`, **yield 8
   each**, add ingredients (flour, water, oil). Its cost ÷ 8 becomes the dough's unit
   cost.
3. Use `Pizza dough` as an ingredient in your pizza dish recipe (uses 1 each).
4. **Produce → Batches → New** → pick the dough recipe → enter actual output (e.g. 8)
   → **Produce**: it consumes the flour/water/oil and adds 8 dough to stock at real
   cost. Selling a pizza then depletes 1 dough.

## Worked example 4 — ordering & receiving

- **Purchasing → Purchase orders → New** → pick supplier → add items (pack & price
  prefill from the item's supplier line) → **Save & mark sent** → when it arrives,
  **Receive into stock** (adds stock, updates cost).
- **Purchasing → Invoices → Scan/upload** → it reads the invoice → you match each line
  to a stock item (price-change flags shown) → **Post to stock**.

## Counts & "The Gap"

- **Stock counts → New count** → enter what you physically have → **Approve**. On-hand
  jumps to your count and the *difference* is recorded.
- **Stock reports → The Gap** shows, per item: what you sold/used (from recipes),
  received, wasted, and the **unexplained variance £** (your count vs what the system
  expected). Negative = loss to investigate (over-pour, spillage, theft). Only items
  you've counted appear.

## Reports (Inventory → Stock reports)

- **Valuation** — what your stock is worth right now.
- **Recipe GP** — plate cost, food-cost %, GP £/% per dish (red below target).
- **Movements** — every stock movement over a date range.
- **The Gap** — theoretical vs actual = unexplained loss.

All export to CSV.

---

## Notes / current limits
- Counter/bar/table sales deplete stock; **kiosk & online** depletion is a follow-up
  (server-side).
- Par-driven suggested ordering, supplier credit-requests, and a POS waste button are
  on the roadmap.
- "Daily counts" is the older menu-portion/86 tool and is separate from the costed
  stock system above.
