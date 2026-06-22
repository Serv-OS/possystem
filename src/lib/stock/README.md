# Stock & Production Management — engine notes

Greenfield stock/production/costing system for ServOS, benchmarked against MarketMan
and Nory. This folder holds the **pure costing engine** (no I/O); everything else
(data layer, store, UI, edge functions) is wired on top in later slices.

## Architecture (confirmed)

- **Ledger-first.** The single source of truth for on-hand and inventory value is an
  append-only `stock_movements` ledger (slice 2). On-hand = `SUM(qty_base)`; corrections
  are reversing rows, never edits. The existing `stock_levels`/`eighty_six` daily-count
  system stays working as a derived cache.
- **Two cost models, kept strictly separate:**
  - **PURCHASED** items get cost from effective-dated invoice/pack history
    (`item_cost_history`), valued **moving-average** by default (`LAST_COST` optional per item).
  - **MADE** items get cost **bottom-up** from a recipe roll-up; a manually typed unit
    cost is never trusted for a MADE item.
- **Everything is normalised to a per-item `base_unit`** before costing.
- **AI invoice scanning** uses Claude vision behind a swappable provider interface (slice 7).
- **Ordering** is par-driven in v1; forecast-driven is phase 2.

## Files

| File | Purpose |
|---|---|
| `units.js` | Canonical units + same-dimension factors. Mirror of the `stock_units` DB seed. |
| `conversion.js` | `convert(qty, from, to, {itemConversions})` — the 3-layer conversion engine. |
| `costing.js` | `packBaseUnitCost`, `movingAverageCost`, `componentUnitCost`, `recipeCost`, GP helpers. |
| `costing.test.js` | `npm test` — costing maths (crate-of-24, nested recipe, GP, cycles). |

## Unit conversion — three layers

1. **Global same-dimension factor math** (`units.js`): everything reduces to a
   canonical unit per dimension — `each` (COUNT), `g` (WEIGHT), `ml` (VOLUME).
   `qtyB = qtyA × toCanonical(A) / toCanonical(B)`. Imperial volume is **UK** (en-GB):
   `1 floz = 28.4130625 ml`, `1 pt = 568.26125 ml`.

   | dim | canonical | factors |
   |---|---|---|
   | COUNT | each | each 1, dozen 12 |
   | WEIGHT | g | mg 0.001, g 1, kg 1000, oz 28.349523125, lb 453.59237 |
   | VOLUME | ml | ml 1, cl 10, l 1000, floz 28.4130625, pt 568.26125, gal 4546.09 |

2. **Item-specific cross-dimension bridges** (`inventory_item_conversions`): volume↔weight↔count
   for a given ingredient (density / piece weight), e.g. `1 each onion = 110 g`. Passed to
   `convert()` as `itemConversions`. The resolver BFS-walks global + bridge edges; if no path
   exists it **throws** — it never guesses.

3. **Yield / usable-%** (trim & cooking loss) is kept **out** of conversions — it lives on
   recipe lines (`usablePct`) and on the recipe (`wastagePct`) so it is never folded into a
   physical conversion factor.

## Costing rules

- **Pack → base-unit cost:** `base_unit_cost = pack_price ÷ base_content`, where
  `base_content = convert(pack_qty × inner_qty, inner_unit, base_unit)`. Store the pack
  facts and **derive** the unit cost — never store the unit cost as the only truth.
  *Worked example (the brief):* crate of 24 cans @ £40 → `base_content = 24`,
  `base_unit_cost = 40 / 24 = £1.6667`.
- **Moving average on receipt:** `new_avg = (onHand·oldAvg + recvQty·recvCost) / (onHand + recvQty)`.
- **Recipe roll-up:** `recipe_cost = Σ (lineQty→base ÷ usablePct) × component_base_unit_cost`,
  then `× (1 + wastagePct)`. A sub-recipe component costs `its_recipe_cost ÷ its_yield_in_base`.
  Recursion through `componentItemId` handles arbitrary nesting; **cycles are detected and
  rejected**; results are memoised so one price change re-costs the whole DAG in one pass.
- **GP** is computed against the **NET (ex-VAT)** selling price (matches Daily Trading P&L,
  where VAT is never profit): `food_cost% = cost / net_price`, `GP£ = net_price − cost`,
  `GP% = (net_price − cost) / net_price`.

## Tests

```bash
npm test          # node --test over src/**/*.test.js (Node's built-in runner)
```

Covers: same- and cross-dimension conversion (incl. UK imperial + multi-hop bridges),
the crate-of-24 pack maths flowing into a recipe's cost and GP, nested sub-recipe roll-up,
usable-%/wastage, moving-average, and cycle detection.

## Build slices

1. **Costing core** (this folder) — item types, packaging, supplier pack→unit cost,
   conversion engine, cost history. ✅ engine + schema + tests.
2. Ledger + real-time POS depletion (sale/void/refund post movements; idempotent).
3. Recipes & nested sub-recipes + POS-product↔recipe link.
4. Par levels + mobile stock counts (variance posting, approval).
5. Wastage (POS button + back-office log).
6. Production batches + CPU/commissary transfers.
7. Purchasing: par-driven POs, receiving, Claude-vision invoice scanning (price-change & credit flags).
8. Reporting: GP, theoretical-vs-actual "the gap", COGS, stock valuation, waste, reconciliation.
