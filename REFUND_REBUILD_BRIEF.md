# Refund path rebuild — brief (written 15 Aug 2026, v5.6.78)

Peter, 15 Aug: *"lets start building this fix for refunding path and being able to
refund to different cards etc — needs tidying up and the refund hasnt even hit Adyen"*

## The headline

`store.refundCheck` (`src/store/index.js:5516`) is **bookkeeping only**. Its own comment
says it: *"closed_checks update, no card reversal (Stripe/Ryft), no gift/loyalty refund."*
It writes `closed_checks.refunds[]` and flips `status`, and stops. **No refund on any
processor has ever returned money automatically** — staff reverse by hand in the
provider dashboard. That is the real defect; the Adyen gap is a symptom of it.

## Three defects, in the order I'd fix them

### 1. Tips and service charge are never refunded (task #108)
- The refund amount comes from ITEMS only: `amount || refundItems.reduce((s, ri) => s + ri.price * ri.refundQty, 0)` (`store/index.js:5531`).
- Full-vs-partial is decided by `totalRefunded >= chk.subtotal` (`:5535`) — **subtotal**, so tip and service can never be inside a "full" refund.
- Consequences: the customer keeps paying a tip on a meal they did not have; `closed_checks.tax_amount` stays overstated so **VAT is wrong**; and tips already distributed through `wf_tronc_lines` are never clawed back.
- Fix: full refund returns `total` (items + service + tip); partial refunds need an explicit tip/service portion; the status threshold compares against `total`; tronc must be notified.
- Smallest of the three, affects EVERY sale ever taken. Do it first.

### 2. No card reversal on any processor (task #107)
- Nothing calls out to a processor. For Adyen the plumbing already exists —
  `supabase/functions/adyen-modify` does `/payments/{psp}/refunds` (also captures,
  cancels, amountUpdates). It is fenced on a BO user + bound to the `adyen_payments`
  ledger, so check that fence before reusing it.
- ⚠️ `refundCheck` routes anything that is not `'ryft'` to Stripe, so an Adyen check
  currently aims at Stripe and lands nowhere. Route by `check.processor` properly.
- ⚠️ `PaxTerminal`'s onComplete hardcodes `'ryft'` as the processor, so a card sale
  taken on an **Adyen** reader through the till books `processor: 'ryft'`, while
  `closeApprovedTerminalJob` books `'adyen'` for the same sale. Fix this first or
  refund routing will be wrong for exactly the sales you care about.

### 3. Split checks cannot pick a card (task #107, same build)
- The DATA is already there. A split check (reader-finished OR till-finished) carries
  `payment_intents` = one entry per leg: `{ id: transactionId, amountMinor, card: {brand,last4,...} }`,
  the till/final leg FIRST. Written by `store.closeApprovedTerminalJob` (`priorLegs`/
  `legIntents`, ~`:4950`) and by `CheckoutModal.complete()` (v5.6.76, ~`:1609`).
- The UI has no concept of legs: `CheckHistory.jsx:384` and `Transactions.jsx:211` both
  call `refundCheck(id, …)` all-or-nothing.
- Build: a per-leg picker showing brand/last4 + amount, refund clamped to that leg's
  charge, each leg's reversal routed by its own processor.

## Ground truth worth keeping

- A live 4-way split books ONE `closed_checks` row: `method:'split'`, `total` = every
  leg's charge (so it INCLUDES all tips), `tip` = sum of leg tips, `payment_intents`
  summing to `total`. Verified live on T3 (£99.57) and T4.
- `_terminal_paid_legs_for(location, table, sessionId, seatedAt)` is the canonical
  "what has this occupation paid" scan. `active_sessions.paid_minor`/`paid_legs` are a
  trigger-maintained projection of it (migration `20260815c`).

## Two traps that cost most of 15 Aug

1. **Edge functions deploy MANUALLY and drift silently.** Run
   `SUPABASE_ACCESS_TOKEN=… node scripts/check-deploys.mjs` BEFORE debugging anything
   that looks "fixed but still broken". Hours went into a paid-state bug whose only
   cause was an undeployed function.
2. **`supabase-js` RESOLVES with `{data, error}`; it does not reject.** So
   `.rpc(...).then(ok, err)` has a **dead error handler** and a failing call logs
   NOTHING. Always destructure `{ error }` and log it. This pattern hid the same bug
   through three rounds of fixes.

Also: this Adyen reader firmware has contradicted the docs three times (menu
`OutputFormat`, the `MenuEntryNumber` selection mask, and `TextInput` vs the documented
`DigitInput` for amounts). Trust the reader's own response over the documentation, and
never let an unparsed success exit through the same path as a deliberate cancel.
