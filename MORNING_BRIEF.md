# Morning Brief — overnight speed & scale work (24 Jul 2026)

**TL;DR: the app is 70% smaller to download, the biggest database flood is fixed, the POS
render hot-spots are fixed, and loyalty/customer pages make far fewer round-trips. Three
versions shipped (v5.5.889 → 891), all build-verified and browser-verified on the built app.
One 30-second sign-off needed from you (below), then a 20-minute test list.**

---

## 1. What shipped while you slept

| Version | What it does |
|---|---|
| **v5.5.889** | App split into chunks: main download **5,164KB → 2,555KB**. Back Office (2.2MB) loads only for managers. Cash-drawer poll 15s → 60s. |
| **v5.5.890** | **The real lag fixes.** (1) Found a LEAKED hidden 15-second poll — its cleanup was never called, it stacked another copy on every surface switch, and IT was the 394,000-call database flood. Deleted. (2) POS product grid did full menu scans per tile per keystroke — now indexed. (3) Tax footer + category counts memoized. (4) MPOS booted everything TWICE (incl. a shift double-open window) — guarded. (5) The 1MB version-history list moved out of the main download → **main chunk now 1,533KB (gzip 375KB)**. |
| **v5.5.891** | Customer pages: menu photos lazy-load, storefront no longer downloads the whole menu snapshot for one list, venue lookup runs 3 reads in parallel. Loyalty: OTP send reads batched (was 4 sequential), balance N+1 removed. Both edge fns deployed + live regression-checked (your free-latte reward returns identically). |

**Database findings (from live query statistics):** the database itself is tiny and healthy —
the load was realtime broadcast decode + chatty clients. Indexes were already good; none needed.

## 2. ⚠ Needs YOU — 30 seconds

**Apply the realtime prune migration** (I'm blocked from infra changes overnight — deliberately):
`supabase/migrations/20260804b_realtime_prune.sql` — paste into the Supabase SQL editor (ops
project) or tell me "apply the prune" and I'll run it with you awake. It stops broadcast work
for 5 tables **nothing listens to** (terminal heartbeats/jobs, dead nudges, 2 config tables) —
the #1 database load. Tables + reads/writes completely untouched.

## 3. Confirmed problems for TODAY's bug-fixing (verified by adversarial review, in priority order)

1. **Every table-sync write goes to the server TWICE** — direct batch + OfflineQueue replay ~1s later (`SessionSync.js:106`). Halving write volume = the single biggest scale lever left.
2. **SessionReconciler downloads every session blob every 10s on every device** — duplicates the realtime channel it already has (`SessionReconciler.js:34`). Needs a delta/timestamp guard.
3. **POSSurface subscribes to the whole store** — every store write re-renders the entire 2,400-line surface (`POSSurface.jsx:44-75`). Selector migration = the big render win. Same for the open CheckoutModal during payment.
4. **SyncBridge remounts on every PIN sign-in/out** → full boot reload each time (`App.jsx:9989`).
5. **Boot runs twice** — useSupabaseInit duplicates six SyncBridge fetches on every POS start; both are also fully sequential (~14 awaited round-trips).
6. **TerminalJobReconciler polls every ~8s even on venues with no PAX terminal.**
7. **Config snapshot never cached on-device** — every boot waits on the network for the menu.
8. **MENU_ITEMS price memo has stale deps** — per-menu price tiers may not refresh on menu change (possible **pricing bug**, not just perf — check first).
9. Customers still download the 2.55MB→1.53MB *operational* chunk before their page's chunk — a separate customer entry point would fix; bigger job.

## 4. Stage-release safety punch list (before real customers)

- **Public checklist-photo bucket** (v5.5.617) — must be made private/signed-URL before prod.
- **POS-core RLS gap** (10 Jun audit, CRITICAL) + **cross-tenant stock-table RLS leak** (found during ops module) — both pre-date tonight; real-customer blockers.
- **Tills must reach v5.5.889+ once** (manual full restart on Sunmi) — after that auto-update handles itself. Fleet versions visible in BO → Network status.
- Marketing-blast concurrency: built, still undeployed — deploy before any big blast.

## 5. 20-minute test list for the tills (yesterday's fixes needing live taps)

1. **Stamp reward** — sign in as Peter Roberts at POS checkout → FREE Small Latte listed → redeem → applies + disappears.
2. **Promo code** — create an offer code → kiosk pay screen + online gift step → "gift card or promo code" field → discount applies; second use refused.
3. **OTP name** — request a code at each location → each shows its own name.
4. **Order SMS/email** — place online + kiosk order → confirmation text/email; mark ready in Orders Hub → ready text.
5. **Allergens** — attach customer, set allergens → auto-saves to profile (~1s, toast).
6. **Table-Pay close** (A50) + **single-item send** — still pending your hardware verification from yesterday.
