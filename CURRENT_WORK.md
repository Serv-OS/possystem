# Session — 15 Aug 2026 (v5.6.81) — MPOS on an Adyen S1F2L, card on its OWN reader (task #104)

## Done (NOT committed, NOT deployed)
- MCardFlow gains TIER 0: `adyenLocalBridgeAvailable()` → mint a terminal job at THIS device's own
  terminal_devices row → `runAdyenLocalPayment` (prepare_local → 127.0.0.1:8443/nexo → report_local).
  `adyenLocalTerminal.js` had zero callers before this.
- `src/lib/payments/localTerminalIdentity.js` (new): serial from the bridge → `register_terminal_device`
  → own paired row + POIID. Claim code surfaced in MMe and on the card screen when the reader is not ready.
- `AdyenNexoBridge.java`: `getSerial()` (paxpay Prefs.serial ladder, cached in SharedPreferences) + `appVersion()`.
- `terminalJobs.dispatchTerminalJob({ localBridge:true })` suppresses the cloud 'start' kick (it would RACE).
- `adyen-terminal-charge` fence also accepts the job's OWN target terminal (terminal_devices.device_uid = auth.uid()).
- `adyen-terminal-admin` 'assign' can ADOPT a self-registered app-terminal row instead of minting a rival
  POIID row (+ `appTerminals` in 'list', + picker in AdyenTerminals.jsx). Without this the flow dead-ends.

## Next / blockers
- DEPLOY `adyen-terminal-charge` and `adyen-terminal-admin` (edge fns never auto-deploy).
- Build + upload the :mpos APK; point MPOS_URL at dev; the wrapper still boots to the v1.3-diag probe page.
- GO-LIVE BLOCKER: nexo local protection (SaleToPOISecuredMessage). TEST terminals only until then.
  Seam + TODO are in adyen-terminal-charge's prepare_local branch.
- No migration needed. Java not compiled here (no JRE on this machine).

---

# Session — 11 Aug 2026 (v5.6.25+) — Table Bookings module, Phases 1-3

## Context
Design handoff in ~/Downloads/design_handoff_table_bookings (README/INTEGRATION/OPTIMISER/SCHEMA/BUILD_ORDER + HTML prototype).
Peter's locked decisions: ONE unified CRM (extend customers, org-scoped = shared across venues), bookings REPLACE the old
table_reservations feature, manager-PIN pacing override, widget on the online-ordering subdomain pattern.
Memory: project_table_bookings.md carries the full decision + handoff-corrections list.

## Done (v5.6.25, live on develop)
- Migration 20260811b APPLIED to dev Ops DB: bookings/booking_tables/packages/package_lines/booking_preorders/
  booking_payments/booking_rules/booking_requests + customers gains tags/no_shows/shopper_reference/stored_payment_method_id.
  create_booking RPC = atomic free-check (advisory lock; double-book race PROVEN closed). Rules seeded all 6 venues.
- src/lib/bookings/optimiser.js — the combination engine, 16 unit tests incl. all 9 spec cases (335 total green).
- src/lib/bookings/bookingsData.js + src/store/bookingsSlice.js (loadBookingsFromDB, createBooking via RPC,
  seatBooking → seatTable(primary) + flushSingleSession, markBookingNoShow → customers.no_shows bump, rules, realtime appliers).
- Wiring: SyncBridge boot load (after reservations), realtime channel bookings:<loc> (+booking_tables), config-push
  snapshot keys packages/bookingRules with v5.5.833 guards, FloorPlanBuilder join-group authoring (booking_rules.join_groups).
- App dispatch ?mode=bookings (SyncBridge-backed) + ModeSelector card.

## In progress
- Phase 3 UI: background agent building src/surfaces/bookings/{BookingsSurface,DiaryScreen,BookScreen,FloorScreen,RulesScreen}.jsx
  per the handoff specs (servos skin, sv-glass, var(--acc)); it runs npm run build itself. Then: version bump + verify + push.
- Phase 3 remainder: TablesSurface reads bookings (replace ReservationSync path; keep setReservation as shim), joined-table
  outline on POS floor, sunset table_reservations.

## Next
- Phase 4 packages builder + queuePackageLines; Phase 5 Adyen (advanced-flow pattern proven 11 Aug on online checkout;
  ledger booking_payments is service-role-only) + widget via serverless → booking_requests. Cancellation wording needed from Peter.

---

# Session — 27 Jul 2026 (v5.5.903) — the PAX cancel window: a dead terminal job gives the gift card back

## Context
Closes the "⚠ Remaining" bullet logged by v5.5.902 below: **PAX cancel-after-dispatch**. The PAX path
debits at DISPATCH by design (the terminal is handed a due already net of the gift, and
`TerminalJobReconciler` can close the check from any till without the modal — a commit-time debit
would be skipped and the discount given away). The cost was that a job which then declined /
cancelled / timed out had already taken the balance with no check for `refundCheck` to reverse.

## What was done
- **NEW `reverseGiftCard()` in `lib/giftCommit.js`** — the mirror of `commitGiftCard`, and now the
  ONE `gift-reverse-redeem` request shape. NEVER THROWS; a null `idempotency_key` (failed commit =
  nothing debited) is skipped rather than 404'd. `store.refundCheck` was refactored onto it — it had
  been the only caller, and a second hand-rolled copy is how two callers drift apart.
- **`CheckoutModal.reverseDispatchedGift()`** — `paxGiftRef` holds what `startTerminalJob` debited.
  Fired from `PaxTerminal`'s `onFailed` (server-SETTLED declined/cancelled/expired) and again from
  its `onBack` (same states only — the retry staff get if the first attempt hit a network blip).
  Un-stages the card **synchronously first** so a cash tender landing mid-reversal can't book the leg
  AND hand the balance back. `onComplete` (approved) drops the handle — that debit is paid for.
- **`store.clearTable` → `_reverseTerminalJobGift(jobId, claimedKeys, reason)`** — cashing a table off
  while a job is live already cancelled the job (v5.5.851); it now reverses the gift the job debited,
  read from `check_draft.giftCard` via the fenced `fetchJob`. Two hard gates: only on `r.ok` (a
  server-CONFIRMED cancel is the only proof no card was charged), and never for a key the check being
  recorded already claims.
- **A successful reversal retires the check id.** The redeem row survives its own reversal, so
  re-applying the same card under the same check id derives the same `giftcommit:<check>:<card>` key,
  comes back `already_applied` and discounts the bill while debiting NOTHING. A failed reversal does
  the opposite — keeps the id and puts the leg back on the bill, so value the customer has already
  spent is still honoured (and lands on the check, where a refund can reverse it).
- **Bug found in passing (money):** `giftCardCheckRecord` only fell back to `staged.commit_key`, so
  re-staging an ALREADY-COMMITTED record (the failed-reversal path, and the documented "legacy
  consume-at-apply shape") wrote `idempotency_key: null` — the check showed the discount with nothing
  for a refund to reverse. Fallback chain now matches `commitGiftCard`'s.

## Verified
- `npm run build` clean. 16 logic checks on the pure helpers pass: request shape byte-identical to the
  old `refundCheck` body, null-key skip, no-token, 404, transport blow-up, `already_reversed` on a
  double call, the claimed-key guard (none / same leg / different card / split legs / failed leg), and
  the re-stage pass-through keeping its ledger key.
- **NOT live-tested** — local is mock, edge fns unreachable, and this needs real PAX hardware. Peter to
  test on a real till: apply a gift card → send to the PAX → **decline or cancel on the terminal** (the
  balance must come straight back and the card come off the bill), then re-apply and pay for real (the
  second redemption must actually debit); and send to the PAX then cash the table off instead.

## ⚠ Remaining / known edges
- **Modal closed (×) while the job is still LIVE, and it later dies on the terminal.** No reversal
  fires — nothing is watching the job, and cancelling on × would break the deliberate v5.5.862 design
  where jobs survive a modal close and the reconciler finishes them. Covered only if the table is
  later cashed off (`clearTable`). A background sweep for dead jobs holding a gift leg would close it.
- **A dispatch whose response was lost after the gift committed** is deliberately NOT reversed: the job
  row may exist and still be paid. The staged card stays put, so a retry or a cash tender re-commits
  idempotently onto the same check id and books it correctly.
- Counter/walk-in sales have no `clearTable` equivalent; the modal's `onFailed` / `onBack` cover them.
- `gift-redeem` still needs its v5.5.901 redeploy (see below) — unchanged by this session.

---

# Session — 27 Jul 2026 (v5.5.902) — the POS half: gift cards redeem at COMMIT (till + splits)

## Context
Closes the "**POS is NOT fixed**" item left open by v5.5.901 below. `CheckoutModal`'s `GiftCardEntry`
and `SplitModal`'s `SplitGiftCardTender` still called `gift-redeem` the instant staff tapped Apply —
with `order_id: tableId || 'walkin-<ts>'` and `order_id: portionId` respectively. Cancel the checkout
modal, or back out of a half-tendered split, and the customer's balance was gone with no check and no
reversal. Ported the v5.5.901 `lib/giftCommit.js` pattern to the till.

## What was done
- **`CheckoutModal` apply → `stageGiftCard`.** The `gift-lookup` call it already made is read-only and
  returns `card_id` + `balance` + `code_last4`, so the apply step needed no new network call — the old
  `gift-redeem` POST was simply deleted. The training-mode mock went with it (nothing reaches the
  server at apply any more); training is gated at COMMIT instead.
- **`complete()` is now async and commits first**, before `onComplete` writes the check (INVARIANTS
  "gift card redeem before order close"). Gift-covers-everything ⇒ `allowPartial:false` and a failed
  debit ABORTS the close, clears the staged card and returns staff to the gift screen with the reason.
  Any other leg (cash in the drawer, card captured) ⇒ `allowPartial:true` and the check is always
  recorded, with the shortfall stamped as `uncollected`.
- **`checkIdRef` / `getCheckId()`** — `paxCheckIdRef` promoted from PAX-only to THE check id for the
  checkout. It rides out as `paymentInfo.closedCheckId`; `buildCloseRecord`, `recordWalkInClosed` and
  `BarSurface.recordTabClosedCheck` adopt it as `closed_checks.id`. This is what makes the server's
  derived key (`giftcommit:<check>:<card>`) match the id `refundCheck` reads back off the check.
  Side benefit: the modal close and the terminal-job reconciler now agree on one id per PAX sale
  instead of minting two.
- **Splits key on `<checkId>:<portionId>`** — see INVARIANTS for why neither half alone is safe.
  `SplitGiftCardTender` stages; `CheckoutModal`'s SplitModal `onComplete` commits every leg as the
  split closes. Legs now land on the check (`giftCards` → `giftRecordFrom` → `gift_card.legs`), where
  they were recorded NOWHERE before — so a refund of a split check silently failed to restore anything.
- **`refundCheck` reverses every leg** via `giftLegs()`, skipping any leg whose commit failed
  (null key = nothing was debited = reversing would 404).
- **PAX debits at dispatch**, `allowPartial:false`, record into `check_draft.giftCard`, and
  `closeApprovedTerminalJob` books it (both the rich and headless paths booked `giftCard: null`).
  A failed debit aborts the dispatch — nothing is charged yet, so stopping is free.
- **Three bugs found and fixed in passing** (all pre-existing, all money):
  1. A fully gift-paid till check recorded `giftCard: undefined` — `complete()` read `giftApplied`
     state in the same tick it was set. Never refundable to the card. Fixed with `giftRef`.
  2. The gift card applied against the GROSS bill, so it could be over-drawn past an applied loyalty
     reward / promo code (the same over-draw the online half of v5.5.901 fixed).
  3. Apply a gift card then hit Split and the customer was charged their gift balance AND the full
     split. Splitting now removes the staged card with a toast (nothing has been debited).
- Also: staged card is removable (× on review, Remove on the gift screen); `SplitModal`'s
  `if (allPaid) setTimeout(onComplete)` fires once (it runs during render — every re-render used to
  queue another close, which is now money, not just a duplicate row).

## Verified
- `npm run build` clean. Logic checks on the pure helpers all pass (staging maths incl. partial
  balances, record shapes, training shape, single-vs-legs, refund unwrapping, and the four keying
  collision cases). Walked the real UI in mock mode: checkout modal, gift screen, card payment,
  bar-tab close — no console errors.
- **NOT live-tested** (local is mock; edge fns unreachable). Peter to test on a real till.

## ⚠ Remaining / known edges
- **`gift-redeem` still needs its v5.5.901 redeploy** via the Supabase dashboard for the
  server-derived key. The client is safe either way (the stable `commit_key` minted at apply is the
  key against the old function) — EXCEPT that split legs then key on the client key rather than
  `<check>:<portion>`, which is still unique per leg, so no collision either way.
- ~~**PAX cancel-after-dispatch**~~ — **DONE in v5.5.903** (section above): a settled declined/
  cancelled/expired job, and a confirmed cancel from `clearTable`, now reverse the debit.
- **Partial gift on a split portion still marks the portion fully paid** (v5.5.199 behaviour,
  deliberately untouched here). The uncollected remainder is at least now visible on the check.

---

# Session — 26 Jul 2026 (v5.5.901) — gift cards redeem at COMMIT, not at apply (kiosk + online)

## Context
Closes the ⚠ KNOWN issue logged in the v5.5.900 session below. `gift-redeem` was called with
`order_id: null` the instant a customer entered/tapped a card — the balance was debited before an
order existed. Abandon the basket, idle out, or fail the card payment and the money was GONE, with
no order and no reversal (the only `gift-reverse-redeem` caller is the POS refund path,
`store/index.js` ~4898). v5.5.900 widened the blast radius by routing EVERY kiosk guest through
the new gift/promo step. Same fix pattern as loyalty v5.5.896/898.

## What was done
- **NEW `src/lib/giftCommit.js`** (the gift twin of `lib/loyaltyRedeem.js`):
  - `stageGiftCard({cardId, code, codeLast4, balanceMinor, amountDueMinor})` — pure, no server.
    `applied = min(balance, due)` keeps partial-balance behaviour. Mints `commit_key` ONCE.
  - `commitGiftCard(staged, {functionsUrl, token, locationId, channel, closedCheckId, allowPartial})`
    — fires the real debit. **NEVER THROWS** (the customer has already paid the card leg, so a gift
    failure must never cost them the order). On `Insufficient balance` it retries with whatever IS
    left — unless `allowPartial:false` (gift-ONLY orders, where a short card must debit nothing).
  - `giftCardCheckRecord(staged, commit)` → the `closed_checks.gift_card` jsonb: `applied` is what
    the server ACTUALLY debited, `idempotency_key` is the key on the LEDGER ROW (see below), and a
    failed commit leaves the key null so a later refund skips the reversal instead of 404ing.
- **Kiosk** (`ScreenGiftPromo` + `submitOrder`):
  - Linked cards: staged from the OTP payload, ZERO network calls. Manual codes: `gift-lookup`
    (read-only) replaces `gift-redeem`; non-16-char input goes straight to the promo path;
    void / zero-balance / **expired** are caught at entry.
  - `submitOrder` commits the card BEFORE the `closed_checks` insert (INVARIANTS.md "gift card
    redeem before order close") and stamps the ACTUAL applied amount.
  - **checkIdRef**: the check id is minted once per basket, not per `submitOrder` call — it IS the
    server-side idempotency scope, so a retry with a fresh id would have double-debited.
  - Gift-covers-everything (no card leg) ABORTS the order if the commit fails: clears the staged
    card, sends the guest back to the gift step with the reason, balance untouched.
  - Applied gift card is now removable (`×`) — impossible before, since the money had already gone.
- **Online** (`OnlineCheckout`): `applyGiftCard` stages only (the `gift-lookup` step already
  existed); `commitGift()` fires in BOTH order paths — before the queue insert on the gift-only
  path (abort on failure, `allowPartial:false`), after it on the card-paid path (money already
  taken, the order must land). Apply now also nets off an applied promo/reward, so a card can't be
  over-drawn. Same `×` remove. `closed_checks.gift_card` moved to `giftCardCheckRecord` (the old
  `amount` key was read by nothing — only `card_id` + `idempotency_key` are consumed, by the POS
  refund reversal).
- **Edge fn `supabase/functions/gift-redeem/index.ts`** — optional `closed_check_id`. When present
  the idempotency key is DERIVED server-side (`giftcommit:<check>:<card>`), exactly like
  `loyalty-redeem`'s `redeem:<check>:<reward>`, so a client that mints a fresh key on retry still
  can't double-debit. Deliberately keys on the CHECK id, **never** `order_id` — the POS passes a
  `table_id` there, reused for every order that table ever takes. The response now echoes the
  effective `idempotency_key` (gift-reverse-redeem needs it verbatim). POS/split callers unaffected.

## ⚠ DEPLOY STEP FOR PETER
`gift-redeem` must be redeployed via the Supabase dashboard Code editor (CLI needs
`SUPABASE_ACCESS_TOKEN`). **The client is safe either way**: against the OLD function the stable
`commit_key` minted at apply time is still the idempotency key, so retries can't double-debit —
redeploying only adds the second (server-derived) belt.

## Remaining / notes
- NOT live-tested (local is mock mode — edge fns unreachable). Peter to test on a real kiosk +
  online: apply a card then WALK AWAY (balance must be untouched), partial-balance card, card that
  covers everything, and a POS refund of a kiosk gift order (reversal must still find the ledger row).
- ~~**POS is NOT fixed**~~ — **DONE in v5.5.902** (section above): `CheckoutModal` and `SplitModal`
  now stage at apply and debit at commit too.

---

# Session — 26 Jul 2026 (v5.5.900) — kiosk gift card / promo code get their OWN checkout step

## Context
Owner: "I thought we had a way to redeem gift cards and promos on the Kiosk but I cannot see
anywhere to actually redeem." The UI existed (v5.5.281 / v5.5.887) but was **unreachable**: it
lived inside ScreenPay gated on `cardState === 'idle'`, and ScreenPay auto-starts the card reader
on mount → `startCardPayment()` flips cardState to 'processing' within a frame. Only a signed-in
member holding a linked gift card (which suppressed auto-start) ever saw it. Shipped `3d1cd18`,
build clean, pushed to develop.

## What was done (src/surfaces/KioskApp.jsx)
- **NEW `ScreenGiftPromo`** + screen key `'gift'`, mirroring OnlineCheckout's gift step:
  `cart → tip → [loyalty if enabled] → gift → pay → done`. Code box is OPEN on arrival; ONE field
  takes a gift card or a promo code; linked cards still tap-to-apply; shows applied credits +
  "left to pay"; CTA `Continue to payment · £X →`.
- **ScreenPay slimmed**: lost props `onPromoApply / verifiedLoyalty / giftCardPayment /
  onGiftCardApply`, its gift state + both gift handlers, and the "auto-start reader after partial
  gift card applied" effect. Auto-start is now just `(cardState === 'idle' && total > 0)`. Its
  promo chip is read-only (the amount is already committed to the reader).
- Back: `pay → gift → loyalty|tip`. Early sign-in (`loyaltyReturnScreen`) still returns to orderType.

## Adversarial review caught 3 defects in the first cut (all fixed before push)
Ran an 11-agent workflow (4 review lenses → 7 verifications). 6 confirmed, 1 refuted.
- **ONE GIFT CARD PER ORDER** (found by all 4 lenses independently, HIGH). The moved block lost the
  old `showManualGC = !giftCardPayment && …` guard. `gift-redeem` debits server-side at apply and
  `giftCardPayment` REPLACES rather than accumulates → a second code silently destroyed the first
  card's balance (£20 order: card A £5 debited, then card B £10 debited, state = B only, guest pays
  £10 → £25 surrendered, £5 gone, closed check records only B). Fixed: once a gift card is applied
  the field only accepts a PROMO — `gift-redeem` is never called twice. Extracted `tryPromoCode()`
  so the fallthrough and the gift-applied path share one validate.
- **CTA race** (HIGH): "Continue to payment" was tappable while an apply was in flight → ScreenPay
  mounts and arms the reader at the PRE-gift amount. Fixed with `disabled={giftApplying}`.
- **Codes accepted with nothing left to pay** (MEDIUM): a single-use promo burned for zero benefit.
  Fixed with a `total <= 0` guard.
- **Idle timer ignored typing**: `onPointerDown` on the shell was the only activity signal, but
  on-screen-keyboard taps land on the IME overlay outside the React tree — the timer could fire
  mid-code-entry and wipe the basket. Shell now also resets on `onKeyDown` / `onInput` (helps the
  loyalty phone entry too).

## ⚠ KNOWN, PRE-EXISTING — NOT fixed here (spawned as its own task)
`gift-redeem` consumes balance at **APPLY** time (`order_id: null`), so abandoning / idle-timeout /
failed payment after applying FORFEITS the customer's gift-card money, with no reversal (the only
`gift-reverse-redeem` caller is the POS refund path, store/index.js ~4898). Verifiers ruled this
pre-existing, not a regression — but v5.5.900 routes EVERY guest through the step, widening
exposure. Proper fix = the v5.5.898 loyalty pattern (stage at apply, redeem at commit keyed to the
check id, idempotent server-side). Same issue exists on ONLINE.

## Remaining / notes
- NOT live-tested (local is mock mode — edge fns unreachable). Peter to test on a real kiosk:
  guest with a gift card code, guest with a promo code, member with a linked card, and a
  gift-card-covers-everything order (should reach pay showing "Fully covered → Place order").
- 5 lower-severity findings were NOT verified (workflow verified the top 7 of 12 by severity).
- Unrelated pre-existing bug surfaced by the review: `loyaltyReturnScreen` is not cleared by
  `resetSession`, so a stale value can make the NEXT customer's loyalty CTA read "Continue to
  menu →" and bounce them to orderType. Not touched.

---

# Session — 26 Jul 2026 (v5.5.898) — kiosk + online loyalty rewards redeem at COMMIT, not tap

## Context
Completes v5.5.896 (POS): kiosk loyalty screen + online rewards step consumed points/stamp cards
the moment a reward was TAPPED — before payment — so an abandoned basket or failed card payment
burned the reward. Both now mirror the POS pattern: tap is apply-only (stages the discount
locally), the real `loyalty-redeem` fires once the order exists, idempotent on `closed_check_id`.
Server needed NO changes. Shipped `5e8ceee`, build clean, pushed to develop.

## What was done
- **Kiosk** (`src/surfaces/KioskApp.jsx`):
  - `redeemReward` in ScreenLoyalty rewritten apply-only, mirroring `lib/loyaltyRedeem.js` math
    (fixed/percent/free-item; free-item BLOCKS with "Add X to your order first" when the eligible
    item isn't in the cart; discount capped at subtotal). Stages
    `{reward_id|stampProgramId, customer_id, pending_commit:true, …}` into `loyaltyRedemption`.
  - Fixed latent crash in passing: ScreenLoyalty never received `cart` (ReferenceError inside the
    old free-item branch — AFTER the server had consumed the reward). Now passed as a prop.
  - `submitOrder`: fires `loyalty-redeem` next to the promo-redeem call with
    `closed_check_id: checkId`, `channel:'kiosk'`, stamp vs points branch, customer_id from the
    staged reward (fallback `verifiedLoyalty?.customer?.id`). Fire-and-forget.
  - `closed_checks.loyalty` payload now also carries `stamp_program_id`.
- **Online** (`src/surfaces/online/OnlineCheckout.jsx`):
  - `redeemReward` apply-only (same math, `eligibleIds` vs `l.itemId`, kept the existing
    cheapest-in-cart fallback when no eligible items configured; kept the
    `discountedSubtotalMinor - giftAppliedMinor` cap). Free-item now blocks like kiosk/POS.
  - New `redeemLoyaltyAfterOrder(closedCheckId)` beside `redeemPromoAfterOrder`; called at BOTH
    payment-success sites (`onGiftOnlyPayment` + `onPaymentSuccess`) with `closedCheck.id`
    (fallback `online-<ref>`), `channel:'online'`, `location_id: opsLocationId` (server 400s
    without it). Both `closed_checks.loyalty` payloads carry `stamp_program_id`.

## Concurrent-session note (important)
A parallel session committed `3e0587f` (v5.5.897, appearance hub) from the SAME working tree
mid-edit — it swept the finished KioskApp loyalty changes into that commit. Nothing lost; the
kiosk half shipped in 3e0587f, the online half + version/changelog in `5e8ceee` (v5.5.898).

## Remaining / notes
- NOT live-tested (local is mock mode — edge fns unreachable). Suggest Peter test on
  dev.serv-os.app: OTP sign-in at kiosk + online, tap a stamp reward, abandon → balance intact;
  complete an order → exactly one redemption row keyed to the check id.
- `removeReward` online now genuinely costs nothing (previously removing an applied reward did
  NOT refund the already-consumed points — that bug disappears with apply-only).
- Kiosk applied-reward confirmation box is still gated on `pointsEnabled` (pre-existing quirk;
  stamp-only venues don't see the green "applied!" box — the discount still applies).

---

# Session — 24 Jul 2026 (v5.5.887 review → v5.5.888) — promo codes on kiosk + online: verified + hardened

## Context
Task: promo/offer code entry on KIOSK + ONLINE checkout (field existed only on POS/catering). A
parallel session shipped the feature as v5.5.887 (`2e176f2`) mid-review; this session verified that
implementation line-by-line against the promo-redeem edge fn + POS reference wiring, found 3 real
defects, and shipped the fixes as v5.5.888 (`26af53c`). Build clean, pushed to develop.

## v5.5.887 (parallel session) — verified sound
- One field takes gift card OR promo on both surfaces (kiosk: gift-redeem fails → promo validate
  fallthrough, no length gate so short codes work; online: <16 chars straight to promo, 16+ falls
  through on gift-lookup miss). Discount lines + removable ×, correct totals math on both
  (kiosk `grandTotal`, online `remainingMinor`), promo on kiosk `closed_checks.promo` + online
  Stripe metadata, redeem AFTER order success at ALL success paths (incl. online no-card
  `fullyPaid → onGiftOnlyPayment` when a promo covers the whole bill). No training mode on kiosk
  surface at all — nothing to gate (POS store path already gated).

## v5.5.888 (this session) — 3 defects fixed
- **Online redeem omitted `customer_id`** (validate sent it, redeem didn't): a customer-locked
  (personal) code granted the discount then redeem silently failed `customer_required` — code
  stayed live for reuse; per-customer limits lost ledger attribution. Now passes
  `loyalty?.loyalty?.customer_id` + warns on refused redeem instead of discarding the response.
- **Kiosk idempotency key `${ref}:${code}` collides**: order refs recycle R1–R99
  (`next_order_number` counter % 99), so a multi-use campaign code silently skipped uses_count +
  ledger rows once a ref repeated (approaches ~50% skip rate at 50+ redemptions). Key now carries a
  per-submission `crypto.randomUUID()` — correct scope, since kiosk fires redeem exactly once per
  submission (fire-and-forget, no retry; a full submitOrder retry gets a NEW ref anyway, so the old
  key never provided retry-dedup).
- **Kiosk sent no `customer_id` at validate or redeem**: personal codes were unusable at kiosk even
  when OTP-signed-in. Both calls now pass `verifiedLoyalty?.customer?.id` (+ added to submitOrder deps).

## Remaining / notes
- Kiosk validate basket = `total` (post-tip, post-credit) — matches the POS reference
  (CheckoutModal:1341 passes its running total) but differs from online (goods subtotal). Server
  uses it only for min_spend + percent math; consistent-enough, left as-is.
- Cosmetic: online gift-step button says "Continue to card payment" when a promo fully covers the
  bill on a no-loyalty venue (it actually places the order directly). Rare (100%-off promo), not fixed.
- NOT live-tested: needs a real promo code on dev.serv-os.app (local is mock mode — edge fns
  unreachable). Suggest Peter test: short code at kiosk pay screen + online gift step.

---

# Session — 23 Jul 2026 (v5.5.877) — share-product data-integrity fix (3 bugs) — DEPLOYED + LIVE-VERIFIED by Peter ✅

## Shipped (commit c2200cd on develop; build clean, 256/256 tests pass, no new lint errors)
Three confirmed bugs in the "share a product to another location" flow (`setMenuItemScope` /
`setMenuCategoryScope` in `src/lib/db.js`). v5.5.12 was a PARTIAL fix; these finish it.
- **Bug 1 — variants.** (a) Children are now fetched by `parent_id` ALWAYS (was gated on the exact
  string `type==='variants'`, so combo/pizza/mis-typed parents copied to peers with no sizes). (b)
  Sharing a variant CHILD directly used to build `parent_id:null` → standalone product at peers;
  `setMenuItemScope` now redirects a child to its parent (`_depth`-bounded), and the BO Sharing
  control is hidden on children (`!item.parentId`, MenuManager ~2136).
- **Bug 2 — category not in menu.** Peer categories were written with `menu_id:null` and NO
  `menu_category_links` row → invisible on POS/Bar/Kiosk/Online/Catering whenever a menu is pinned
  (only MPOS's `!c.menuId` escape hatch showed them). `setMenuCategoryScope` now attaches each peer
  category to that location's default menu (`resolvePeerDefaultMenu`) via BOTH `menu_id` and a
  `linkCategoryToMenu` row, and rewrites `parent_id` to the peer parent so sub-cats stay nested.
- **Bug 3 — modifiers.** New `shareModifierGroupsToLocation` recursively copies each assigned
  `modifier_groups` row (+ nested `subGroupId` groups + sold-alone `itemId` sub-items) to each peer
  with deterministic ids `<srcId>_<peerSuffix>` (no scope/master_id column on modifier_groups — the
  id IS the link), and repoints the peer item's/variant's `assigned_modifier_groups` at them.
- Idempotent (all upserts by deterministic id). LIMITATION: items shared BEFORE v5.5.877 keep their
  old incomplete copies — demote to Local, then re-share, to pull sizes/menu-placement/modifiers.

## Verified
- **LIVE-VERIFIED 23 Jul 2026 by Peter on dev.serv-os.app** ("yes that worked!") — shared a product
  across locations end-to-end: sizes mapped under the master, item in its category, modifiers present.
- Version raced twice with parallel sessions (5.5.874 and 5.5.876 both got claimed mid-session) —
  landed as v5.5.877, rebased onto the loyalty-SMS + Stripe-admin commits.

## Remaining (small)
- Products shared BEFORE v5.5.877 still have incomplete peer copies. Repair per product:
  Local → Shared again. A bulk "re-share all" sweep would be nicer — deferred.
- MPOS is the only surface with the `!c.menuId` null-menu escape hatch (MMenu.jsx:91) — a category
  with no menu shows there but nowhere else. Inconsistent read rule, worth unifying someday.
- POSSurface.jsx:1384 sidebar count only checks `i.cat`, ignores `i.cats[]` — cosmetic count drift.

---

# Session — 22 Jul 2026 evening (v5.5.852 → v5.5.855) — HubRise sign-off sheet, live tests with Peter

## Shipped (all deployed + live-verified against real orders)
- **v5.5.852** ⏱ Delay pills (+10/15/20/30) added to the full-screen new-order POPUP (v5.5.849 only
  put them on the Orders Hub card; staff accept from the popup). PROVEN live: plain accept →
  confirmed_time None (order evm3rbb); delay +15 → confirmed_time = tap+15m store-local (kq64b93).
- **Catalog tax-rate push** (edge fn only, commit 30f1214): every product publishes HubRise's
  product-level `tax_rate {delivery, collection, eat_in}` resolved from OUR tax_rates +
  menu_items.tax_overrides — same chain the booking engine uses. Verified in the live catalog
  (39/85 products; Slaw = 0/0/20 override case). ⚠ 72/135 items (46/85 published) have NO tax
  rate in BO → publish nothing + book £0 VAT. Peter owes a tagging sweep (offered to list them).
- **v5.5.853 — channel money model.** NEW `src/lib/channelMoney.js` buildChannelCloseFields =
  THE single builder for every figure a HubRise sale books (invariant: items(incl mods) −
  discounts + delivery + service + tip = headline total; paid/due from decoded payments[]).
  Booked items follow the NATIVE line contract (unit price incl mods — checkTotals/receipts/
  refunds all do price×qty). Used by: Orders-Hub collected path AND a new recordWalkInClosed
  `_channelRef` intercept (charging a part-paid channel order at the till: charges exactly the
  DUE, books the same deterministic `chk-hr-<ref>` id, pushes 'collected', drawer opens for the
  amount taken). openOrder builds a payment COPY (folded mods, one line per charge, NEGATIVE
  "Paid — X" line per channel payment, channel discounts as check discounts, itemId stripped so
  auto-discounts can't fire, serviceChargeWaived). Receipts: named discount lines print/email/SMS
  (was NOTHING itemised, even for POS discounts), Delivery line, per-leg payments, "Service"
  label un-hardcoded from "(12.5%)". Reports: Exceptions reads d.label (real names — was generic
  for ALL discounts), SalesSummary + CSV gain "plus Delivery charges" (reads customer.delivery_fee,
  all sources). db.js closedCheckRow now maps tax_breakdown (was computed, NEVER persisted).
  LIVE-VERIFIED end-to-end on HR-8qjnnyy: 61.75 − 12.65 + 1.50 = 50.60; Cash 33.85 + POS cash
  16.75; HubRise → completed.
- **v5.5.854** (a) removed-ingredient options decode as "No X" + removed:true (was showing
  "Mozzarella" as an ADDED topping — allergen safety); (b) fully-PAID channel orders book at
  ACCEPT (store bookChannelSale; idempotent deterministic id; OrdersHub collected call = safety
  net; hubrise-ingest VOIDS the booked check server-side on channel cancel); (c) Order types
  report gains a BY-SOURCE table + CSV (POS/kiosk/online/QR/catering + each platform BY NAME);
  (d) POSSurface auto-courier-quote skipped for `_channelRef` orders (was quoting OUR Stuart on
  Deliveroo's address → "Delivery unavailable — out of range" + payment block).
- **v5.5.855** Transactions: channel sales were badged "POS" (label map fallback) → now the
  platform name; filter gains Delivery channels/Catering buckets.
- **hubrise-map.ts** also: option_list_name decoded onto mods as groupLabel (tickets still print
  option-name-only per v4.6.10).
- **CRM upsert verified live** (task #68): "Thomas B." +353768887706 → customers + customer_locations
  (visit 1, £38.70) + customer_orders on the first with-identifier order after deploy.

## Open / next
1. **Real-VAT live proof needs an injector client** — Dev Tools sends canned unknown refs (tax
   books £0 conservatively). Peter to create a 2nd OAuth client (manager.hubrise.com → SETTINGS →
   DEVELOPER), then I drive the OAuth once and can fire real-menu orders (Og Wings + Slaw case:
   expect £3.33 VAT — builder unit-verified). My direct-token order 7qj99bg sits invisible in
   HubRise ('new', a client never gets its own events) — cancel it when the injector exists.
2. **kq64b93** (−£5.31, paid) still open in queue — mark collected (or leave; books via safety net).
3. **Tax-rate tagging sweep** — list the 72 untagged items for Peter.
4. Sheet rows answered this session (paste-ready copy given): confirmed_time, invalid sku_refs,
   tax rates (push-not-decode), options decode + invalid-ref display, discounts decode/ref usage.
5. Still on the sheet: #59 variants per (menu × service type), #60 push OUR orders into HubRise,
   redirect-URI check at manager.hubrise.com, Peter's owner cells.
6. Mod qty >1 nuance: channelMoney counts mod qty; OrdersHub card/kitchen line sums ignore it
   (kiosk/online mods have no qty — only exotic channel orders could differ). Flag if seen.

---

# Session — 20 Jul 2026 (v5.5.809 → v5.5.828)

## Shipped
- **v5.5.809–812** Reports: "All reports" rename; catalog redesigned two-pane (rail, search, pinned, recent,
  dense rows) mapped to theme tokens so dark mode holds.
- **v5.5.813–817** Menu manager visual pass + COST/GP% on the Items list (recipe-derived, **ex-VAT net price**
  so it agrees with Inventory → Reports → Recipe GP). Category filter + collapse/expand.
  Item grid **locked to the POS's real 6-column grid** — it's a layout editor, so it must never reflow.
- **v5.5.819** FIX: item supplier resolved from the purchasing link (`supplier_products`), not just the
  optional `default_supplier_id`. Same bug had silently emptied the By-supplier GP ranking.
- **v5.5.820** FIX: deleted dishes no longer haunt Recipe GP (archived items left orphan recipes).
- **v5.5.823** Stock counts: delete a count / remove a line (guarded — APPROVED counts are ledger history).
- **v5.5.824** Produce + Purchasing brought onto the shared visual standard (6 screens, 44 hardcoded colours
  → 0). Surveyed first; deliberately did NOT force report chrome onto the master-detail editors.
- **v5.5.825** FIX: un-86 now clears an exhausted count. POSSurface blocks `remaining <= 0` independently of
  the 86 list, so un-86 was silently doing nothing.
- **v5.5.826** Ryft: `adopt` an already-registered terminal (+ `available` listing).
- **v5.5.827 → 828** Ryft tipping wired to location_reader_settings, then the on-screen picker REMOVED.

## In progress / next
1. **Tip on the customer-facing display** (agreed, not started) — see [[project-ryft-roadmap]] for the design
   and the race condition to handle.
2. **Disable PAX printer** — `receiptPrintingSource: 'PointOfSale'` + the two confirm-receipt calls.
   Getting it wrong VOIDS transactions. Not to be rushed.
3. **Hide Stripe-only reader settings on Ryft venues** (screensaver, live cart) — they currently save and
   silently do nothing.
4. **Untested on hardware:** decline (`4000000000001000` CVV 222), cancel mid-payment, split, refund.
5. `--bg0` is referenced by 8 stock screens but defined nowhere in globals.css — latent, wants one sweep.
6. Ryft week-2 hardening (task #52) — auth fences, refund integrity, webhook durability, **kiosk is Stripe-only**.

## Also queued
- **Card fees on tips in reports** (raised 20 Jul). Fee on the tip portion is a VENUE COST — the Tipping Act
  2023 forbids netting it off the tip. Needs: gross tip preserved for tronc, tip-portion fee as a P&L cost
  line, and a note that on Ryft the tip split is OUR figure (their API reports only the single requested
  amount), unlike Stripe which reports the tip separately. See [[project-uk-tipping-rules]].

## Watch out
- Ryft **cannot do tipping at all** — verified exhaustively. Processor choice is per-venue now.
- Edge-fn **deploy drift**: `payments-admin` sat a month behind source. Check deploy vs source dates first.
- The `/functions/{slug}/body` API returns an **ESZIP archive**, not source — grepping it gives false negatives.


---

# Serv OS / RPOS — session handoff

> **Current build: v5.5.807** · live: https://possystem-liard.vercel.app · dev: https://dev.serv-os.app · repo: **Serv-OS/possystem** (branch `develop`, Vercel auto-deploys).
> Multi-tenant hospitality POS (React 19 + Vite, Zustand, Supabase; no TypeScript, no tests). First customer is UK / GBP.
> **Pillars:** don't break working functionality · resolve the real `locationId` before any DB write (never `loc-demo`) · CSS vars not hardcoded colours · bump `src/lib/version.js` + add a `CHANGELOG` entry in `src/App.jsx` on every web deploy · money is `numeric`, never float.

Read alongside: **`CLAUDE.md`** (architecture/orientation), **`DECISIONS.md`** (ADRs), **`INVARIANTS.md`** (hard rules).

---

## What Serv OS is

A SaaS restaurant/bar POS with many device "surfaces" off one codebase (URL `?mode=…`): POS till, MPOS (mobile), Bar, Floor/Tables, KDS, Kiosk, Orders Hub, Customer Display, **Time Clock**, Back Office, and customer-facing Online/QR/Loyalty/Gift web flows. Two Supabase projects: **Ops DB** `tbetcegmszzotrwdtqhi` (all operational data, scoped by `location_id`, hosts the edge functions) and **Platform DB** `yhzjgyrkyjabvhblqxzu` (orgs, users, loyalty, gift cards). Back-office users authenticate with Supabase Auth; POS/clock/kiosk devices pair to a location and use **anonymous auth**.

---

## Recent arc (this block of sessions)

### Venue picker design-handoff redesign (v5.5.807) — SHIPPED
`GroupOrderSurface.jsx` rebuilt to the owner's design handoff (Figtree on cream,
1080px two-column grid: venue cards + sticky map; <900px single column, map on
top at 240px). The branded MenuTheme `MenuHeader` stays on top (owner constraint);
everything below follows the handoff, with ONE deliberate deviation: the design's
brand red (#C7503B) maps to the group's own theme accent (`readableOn` for text on
it), cream neutrals verbatim. New per-card: live status pill (Open / Closing soon
≤60min / Closed, 60s re-tick), plain-English status line ("Opens tomorrow at
9am"), hours trimmed to Today+Tomorrow with the full week behind an "All opening
times" disclosure (today bolded) — all venue-tz aware via lib/openingHours.
Geolocation: "Use my location" button (NEVER prompts on load; silent locate only
when permission already granted) → haversine nearest-first sort, "1.2 mi away"
distances, "Nearest to you" badge, auto-select nearest; failure = neutral
fallback (unsorted, no distances — no fake point). Map: **Leaflet 1.9.4 + OSM
tiles** (new dep — the "Mapbox stack" is geocoding-only fetch helpers, no
renderer; the delivery live map is Stuart's iframe), muted tile filter, numbered
teardrop pins synced to card hover/select, you-are-here dot, fitBounds;
coincident venues (same address) fan pins ±17px so both stay clickable. Coords:
NEW platform `locations.latitude/longitude` (additive,
`20260718_PLATFORM_location_coords.sql`, applied) — both posup-test venues
backfilled by geocoding their shared demo address (1426 Shoal Drive, San Mateo).
No coords → no distance/pin; none at all → no map. Catering picker keeps its own
face inside the same layout (badges, "Order catering", no open/closed). Kept:
single-venue skip, remembered-venue banner (restyled), address fallback chain,
"Powered by Serv OS". Figtree added to index.html. Verified in-browser against
real data at desktop + 375px incl. locate grant (stubbed coords) + deny paths.
Owner-confirmed decision (18 Jul 2026): `src/backoffice/sections/Items.jsx` (the
v4.6.1 "dedicated Items library", never imported anywhere, unreachable since it was
written) is DELETED rather than mounted. Everything it offered — including its one
distinctive feature, local/shared/global ownership scope — now lives in MenuManager's
own Items tab (`ItemsLibrary`), which is the single item editor going forward.
Mounting it would have created a second, less-capable parallel item editor (no
sizes/spacers/combos/instruction groups). Rationale recorded as **ADR-022** in
DECISIONS.md; CLAUDE.md folder listing updated. Recoverable from git history
pre-v5.5.806 if the focused-library UX is ever wanted again. The earlier Items.jsx
archive-wipe/partial-save fixes (v5.5.801) remain relevant only as history.

### Closed-venue online ordering + picker details (v5.5.802) — SHIPPED
Owner feedback on Location 2's closed page (plain black screen, dead button). Now:
the closed gate (`CustomerBoot.jsx` → new `ClosedScreen`) is themed with the same
MenuTheme engine as the storefront (readTheme/deriveVars/MenuHeader; graceful default
when `online_branding` is null). "Order ahead for later" WORKS — enters
`OnlineSurface` with a `closedInfo` prop: full menu browsable, persistent sticky
"Closed — opens …" banner (measured height offsets the sticky category header),
header pill swaps off "Open now", and `OnlineCheckout orderAheadOnly` forces the
scheduled slot picker (no ASAP; slots only exist inside opening windows). If reopen
is >7 days out / hours unset → button says "Browse the menu" and OnlineCart's
checkout is disabled with the reason (`checkoutDisabledReason`). QR closed gate
unchanged. Group picker (`GroupOrderSurface.jsx`): venue cards show the address
(platform `locations.address`, falling back to ops `locations.address` — that's the
populated one) + full weekly hours via `formatHoursPreview`; catering picker keeps
fulfilment badges (own hours) but gains the address. Verified in-browser against
real data (Location 2 genuinely closed at test time). PRE-EXISTING bug spotted, not
fixed: `buildCollectionSlots` (OnlineCheckout) builds slot Dates with device-local
`setHours` but labels them in venue tz — slots skew when the customer's device tz ≠
venue tz.

### Items-library archive wipe fix (v5.5.801) — SHIPPED
Latent data loss in `src/backoffice/sections/Items.jsx`: `onArchiveToggle` pushed
`upsertMenuItem({ id, archived })` — but db.js `upsertMenuItem` builds a FULL row,
defaulting every missing field (name→'Item', pricing→{base:0}, cat/parent_id→null,
mods→[]), so an archive/restore could wipe the item's real data. Now uses new db.js
`setMenuItemArchived(id, archived)` — a targeted `update({archived, updated_at})`
with the location fence, mirroring `archiveMenuItem`. Same class in `onSave`: its
enumerated payload omitted tags/visibility/soldAlone/centreId/taxRateId/taxOverrides/
instruction groups/org/master/lockedFields → now spreads the full post-update store
item first. Audited ALL other `upsertMenuItem(` callers (BackOfficeApp push,
SyncBridge, store ×3) — all pass full items, safe. Did NOT touch upsertMenuItem's
defaulting (store paths rely on it). IMPORTANT context: **Items.jsx is currently
DEAD code — nothing imports it** (the BO nav "Items" tab is MenuManager's own tab,
which archives via the safe store actions); the fix future-proofs the designated
replacement component before anyone re-mounts it. Verified: clean build; dev-mock
archive→restore of 8oz Ribeye in MenuManager kept name/price/type/mods/category.

### Duplicate-name guard + auto-modifiable type (v5.5.798) — SHIPPED
Owner bug 1: he could add the same product twice. Rule (new `findDuplicateProductName`
export in store/index.js): within a location, live TOP-LEVEL products (parentId null,
not subitem/spacer, not archived) must have unique display names (menuName||name,
trim+lowercase). Wired: store `addMenuItem` (refuses, returns null — callers alert) and
`updateMenuItem` (backstop; only fires when the name CHANGES, so pre-existing duplicates
— demo DB has "Asahi" ×2 — stay editable until renamed); MenuManager add-product, clone
prompt, Items.jsx library add/save, AI `add_menu_item`. The ItemEditor POS-button-name
input is now DRAFT-BUFFERED (commit on blur/Enter) with an inline red error — a hard
per-keystroke guard would make "Coke Zero" untypeable while "Coke" exists; side effect:
the v5.5.796 rename cascade now fires once per rename, not per keystroke (verified in
dev mock: cascade still updates modifier-group options). Store toasts do NOT render in
?mode=office — that's why errors are inline + window.alert.
Owner bug 2: attaching modifier groups didn't set the type, and POSSurface `needsModal`
hard-skips type='simple' → options screen never opened. The old auto-flip only watched
legacy `patch.modifierGroups`; now `assignedModifierGroups` flips simple↔modifiable in
`updateMenuItem`/`addMenuItem` (never when 'type' is in the same patch; never for
subitem/variants/combo/pizza/spacer; won't downgrade while instruction groups remain)
+ a db.js `upsertMenuItem` safety net (simple + mods attached + top-level ⇒ modifiable).
Items.jsx saves now pass type/parentId to the DB write (partial payloads were silently
resetting them). NOTE: instruction-groups-only items still stay 'simple' (till skips
their sheet) — same bug class, not in scope, flag if the owner hits it.

### Multi-site group ordering link (v5.5.797) — SHIPPED
Toast-style ONE link for restaurant groups: `/order/<groupSlug>` (or `?group=`) renders a
branded venue-picker landing page; the customer picks a venue and is handed to that venue's
EXISTING online / catering URLs (per-venue flows untouched, read-only end to end).
- **Resolution:** groupSlug = platform `companies.slug` (column already existed, unique +
  anon-readable — NO migration needed; demo group slug is `posup-test`) → `locations` rows by
  `company_id`. Venue "slug" for ordering links is `platform.locations.online_slug` (subdomain
  `<slug>.serv-os.app` or same-origin `?loc=` fallback via `customerUrl()` in `lib/env.js`).
- **New:** `src/surfaces/GroupOrderSurface.jsx` (MenuTheme engine — `readTheme`/`deriveVars` +
  `MenuHeader` from the first branded online-enabled venue; per-venue OPEN/CLOSED via
  `lib/openingHours` on platform `opening_hours`; Catering button gated on the anon-safe
  `catering_public_settings` RPC returning non-null; localStorage `rpos-group-last:<slug>`
  drives an "Order again from <venue>?" banner — never a forced redirect).
- **Wiring:** `customerUrl.js` parses `/order/<slug>` + `?group=` → `mode:'group'` (+ `order`
  reserved subdomain); App.jsx routes it before venue CustomerBoot; `groupOrderUrl()` in
  `lib/env.js`. BO → Online ordering shows a read-only "Group ordering link" card when the
  company has >1 location (BO's platform reads run as anon role — count sees all company venues).
- **Owner feedback round (next version): pickers split + single-venue skip.** Catering is a
  separate face of the business — `/order/<group>` is now ONLINE-ONLY (no catering button);
  NEW `/cater/<group>` (or `?cater=`) lists ONLY catering-enabled venues with Delivery /
  Collection badges (from `catering_public_settings` — `takeout_enabled`/`delivery_enabled`/
  `takeout_dining_option` are already anon-exposed, no RPC change). Exactly ONE eligible venue
  → the picker is skipped (`location.replace` straight into the venue's site) for BOTH pickers.
  Separate localStorage keys (`rpos-group-last:` online, `rpos-group-cater:` catering).
  BO: Catering ordering settings gained a "Group catering link" card (`groupCaterUrl()`);
  the Online ordering card is online-only and cross-references it.
- **Deferred:** postcode/geo search + distance sort, company-level branding (uses first venue's),
  a pretty dedicated group domain (link is same-origin today), venue photos on the cards.

### Product rename now cascades into modifier groups (v5.5.796) — SHIPPED
Owner bug: renaming a product in BO menu manager left the OLD name on that product where
it appears as an option inside modifier groups. Root cause: the existing rename cascade in
`updateMenuItem` (store/index.js) only matched legacy composite option ids
(`opt-NNN-m-<id>`) — it never checked `opt.itemId`, which is how the BO modifier editor
has linked options to items since (MenuManager "Add option from Items list"), and the
`-m-` tail never matches items whose ids don't start with `m-`. Fix at the same choke
point: cascade now matches (1) `opt.itemId === item.id`, (2) the legacy id forms, and
(3) options with NO itemId whose name equals the OLD item name (trim+lowercase — mirrors
`resolveOptItemId`'s 86-fallback so name-linked options keep following the item). Changed
groups persist via `_saveModGroup` (now returns success) and a failure toasts
"Item saved — modifier lists may need a manual refresh" — the item save itself never
fails on a group-save error. Groups reach tills via the config-push snapshot
(`modifierGroupDefs`) + direct `modifier_groups` fetch at boot; no render-path changes.
Verified in dev mock: UI rename of a sub-item updated both an itemId-linked option and a
name-only option live in the modifier editor.

### Checkout compact layout (v5.5.793) — SHIPPED
Owner request from live portrait-till screenshots: staff go straight to payment, so the
payment controls must NEVER need a scroll to reach. `CheckoutModal.jsx` review screen is
now a flex column: the bill-items list (+ loyalty banner) scrolls in its own region
(`flex:'1 1 auto', minHeight:0, overflowY:auto`) while totals / Print receipt / payment
tiles / gift+split stay pinned below (`flexShrink:0`); every other checkout screen keeps
the original whole-body scroll (conditional style on the body div). Card/Cash tiles are
~half height (icon+name on one row, single merged subtitle); "Gift card or promo code" +
"Split check" are two half-width buttons on one row. Layout only — zero payment-logic
changes. Verified in dev mock at 1280×800 and 800×1280 with a 12-line order.

### Paying always fires production (v5.5.792) — SHIPPED
Owner bug: counter/walk-up staff ring items and go STRAIGHT to payment (e.g. cash) without
tapping Save & send — the check closed paid but NO KDS ticket / kitchen print ever fired.
Fix at the **store choke point**: `recordWalkInClosed` (walk-in/takeaway/counter) and
`clearTable` (tables, gated on `paymentInfo?.method` so a manual Close-table never fires)
now call `sendToKitchen({ fireAll: true, tableId })` when any line was never fired.
`fireAll` is a new mode inside `sendToKitchen` (store/index.js): picks up pending AND
sent-but-HELD lines (`isUnsentLine`), fires ALL courses at once (owner spec: course
sequencing is over when the customer pays — one combined send per production centre,
normal print routing), and skips `maybeAutoSignout('send')` (payment path has its own).
Double-fire safe: sent+fired lines are excluded, so Send→Pay makes exactly one ticket and
paying a table with a held course fires only the held lines. Covers POS + MPOS (both close
via the store fns); Bar tabs fire rounds at add time so nothing unsent exists at close.
Root causes: (1) v4.4.7 refactor (`a5741d1`) read the table ROW instead of `.session` in
POSSurface's pay-time check → tables never fired; (2) the walk-in pre-fire lived only in
POSSurface → MPOS table payments had no fire; both pre-fire blocks removed from
`handlePayComplete` in favour of the store hook. Training gating unchanged (leaf fns).
Verified in dev mock: pay-without-send fires 1 combined ticket (all `fired:true`);
Send→Pay adds none; C1+C2 pay-without-send fires both at once; table with held C2 fires
only the toffee on pay; manual Close table fires nothing.

### Order panel follows adds (v5.5.791) — SHIPPED
Owner UX report: on a long order, tapping menu items appended the new line out of view at the
bottom of the basket. The POS order panel (and the Bar round-being-built) now auto-scrolls the
just-added line into view and flashes it (~1s accent fade, new `.line-flash` keyframe in
`globals.css`). Also fires on a qty increase of an existing line (+ stepper on POS; same-item
merge on Bar). Implementation: an effect diffs the items list (uid→qty map in a ref) so unrelated
re-renders never re-trigger, baseline resets on table/walk-in/tab switch; lines carry
`data-line-uid`, scroll via `scrollIntoView` on the panel ref — **no rAF** (never fires on
hidden/background tabs; smooth on visible tills, instant when `document.hidden`). Files:
`POSSurface.jsx`, `BarSurface.jsx`, `styles/globals.css`. **MPOS skipped** — its menu and cart are
separate full screens (no visible basket while tapping), so the pattern doesn't apply.

### Triple item naming actually wired (v5.5.790) — SHIPPED
Owner bug: menu items have three names (POS button / RECEIPT / KITCHEN-KDS) but receipts and the
KDS/kitchen tickets always printed the POS name. Root cause: order lines only snapshotted `name` at
add time — the save/load paths (`receipt_name`/`kitchen_name` columns, SyncBridge/BackOfficeApp/
realtime/useSupabaseInit mappings, config-push snapshot, both item upsert paths) were all already
correct.
- **New resolvers** `kitchenOverride(item)` / `receiptOverride(item)` in `src/lib/itemDisplay.js`:
  return the explicit name ONLY when it differs from the item's base `name` (both save paths default
  the DB columns to the display name, so a populated column ≠ explicitly set). Lines carry the
  override or `null` — synthesized variant line names ("Lager — Pint") and no-override items render
  exactly as before.
- **Line snapshot:** store `addItem` (POS/MPOS/tables), `BarSurface.addToRound` (bar tabs),
  `KioskApp.submitOrder` itemsPayload, `OnlineSurface.addToCart` (+receiptName; feeds online + QR),
  and the online/QR/catering checkout queue-item builders. Names ride into `active_sessions`,
  `closed_checks` and `order_queue` jsonb, so KDS via `routeKioskOrderPrints` and receipt reprints/
  emails from history all see them.
- **Render:** `printer.js` `buildCustomerReceipt`+`buildReceiptHtml` → `receiptName || name`,
  `buildKitchenTicket` → `kitchenName || name`; `sendReceipt.js` (all 3 bodies) → `receiptName ||
  name`. Existing consumers (store `createKdsTickets`/`addRoundToTab`/`transferTable`/
  `routeKioskOrderPrints`, OrdersHub, ReceiptModal) already read the fallback chains.
- POS on-screen order panel + customer-facing surfaces intentionally keep the POS/menu name.
  Modifiers were explicitly out of scope. Verified in dev mock (seed "Soup of the day" → Orders hub
  shows "SOUP"; pre-existing lines unchanged). Build clean.

### Workforce rota — standard shifts, copy shift/week, clash warnings (v5.5.789) — SHIPPED
Owner ask: preset "standard shifts" for speed, copy shifts and whole weeks, and flag holiday/
availability clashes when placing someone. All in `WfRota.jsx` + a new pure helper:
- **Standard shifts:** venue presets (name/start/finish/break/section/colour) stored on
  `wf_venue_settings.settings.shiftTemplates` (jsonb — NO new table). "Standard shifts" button on the
  rota manages them; they render as one-tap prefill chips in the add/edit-shift modal. Saved via the
  full-settings upsert (`saveSettings` writes the whole row — always spread the existing settings).
- **Copy shift:** "Copy" in the shift editor → person + day pickers → draft copy. Rate is
  RE-snapshotted for the target person (`resolveRate`), never carried across.
- **Copy week:** header button → target week picker (default next week) → all shifts cloned as
  DRAFTS via `saveShiftsBulk` (one round-trip). Skips leavers (not in the `loadStaff` list — it
  excludes `status='leaver'`) and copies that would overlap existing shifts in the target week
  (loaded fresh before insert). Jumps the view to the target week; audit-logged (`rota.copy_week`).
- **Clash warnings:** `src/staff/wfClash.js` (pure, unit-tested — `wfClash.test.js`, 6 tests):
  hard shift-overlap block (`findClash`, moved out of WfRota) + soft warnings from APPROVED
  `wf_time_off` rows covering the date and `wf_availability.per_day` (`{day:0..6 Mon-first,
  state:'unavailable'}`). Warnings NEVER block — modal shows "⚠ Jane is on holiday that day" and the
  button becomes "Save anyway"/"Copy anyway"; grid chips of flagged shifts get an amber ⚠. Copy-week
  places flagged shifts but counts them in the results toast ("N with warnings").
- Verified in dev mock mode end-to-end (templates → chip prefill → warning → save anyway → copy
  shift → copy week). Build clean, 248/248 node tests pass.

### Menu-category membership sweep (v5.5.786–788) — SHIPPED
The rule (POS v4.7.6): a category is "in menu M" if `menu_categories.menu_id === M` (primary home)
**OR** a `menu_category_links` row joins it (or its parent) to M. Several surfaces applied only half:
- **v5.5.786 OnlineSurface** — links-ONLY filter dropped home-menu categories with no link row
  (Salads/Sides/Dessert vanished online). Fixed to primary-OR-linked.
- **v5.5.788 sweep of the other surfaces:** **CateringSurface** had the same links-only bug against
  `catering_public_settings.menu_ids` → now primary-OR-linked(-or-parent-linked), keeping the
  no-menus-chosen → show-all legacy path. **MPOS MMenu** had the MIRROR bug (primary `menuId` only,
  links ignored — linked categories showed on POS/bar, never on the phone) → now fetches
  `fetchMenuCategoryLinks()` like BarSurface v5.5.741 and applies primary-OR-linked; search inherits.
  **KioskApp** already had primary-OR-linked; added the missing parent-linked clause for sub-categories.
  KioskSurface = pairing wrapper only (no filtering); BarSurface fixed earlier (v5.5.741).
- **Checklist for any NEW surface that picks categories by menu:** primary `menu_id` OR linked OR
  parent-linked — never links-only, never primary-only.

### Cross-device table reservations (v5.5.740) — SHIPPED (isolated design)
Peter: a reservation made on one POS didn't show on the others. Root cause: `setReservation` only
updated local `store.tables` (`_updateTable`); nothing persisted, and the real-time table sync
(`active_sessions`) only carries tables with an open ORDER.
- **First attempt (REVERTED):** carried reservations as a `{__reserved:true}` marker session inside
  `active_sessions`. Adversarial review found 10 issues — it leaked as phantom occupied/seated/stalled
  tables into the SyncBridge boot loader, SessionReconciler, MasterSync, `rpos-session-backup`,
  `manager-snapshot`, `owner-snapshot`, Back Office overview — and could **overwrite a live order**.
  Reverted whole (nothing shipped).
- **Shipped design:** a DEDICATED, isolated table **`public.table_reservations`** (migration
  `20260707`, applied: unique per loc+table, permissive RLS, REPLICA IDENTITY FULL, in
  `supabase_realtime`) + **`src/sync/ReservationSync.js`** on its own realtime channel. It touches ONLY
  `table_reservations` — never `active_sessions`, SessionSync, the session backup, reports, or the
  snapshots. **Safety invariant:** `_applyReservation`/`_clearReservation` start with
  `if (t.session) return t` — a live order is never wiped/downgraded. Verified by a 2nd review (all
  findings low-severity reservation-robustness; zero live-order risk), then those fixed: `_lastSent`
  latches only after a confirmed write (checks `.error`); `loadReservations` reconciles (heals missed
  realtime events); reconnect + 30s periodic self-heal; flush trigger ignores broadcast echoes
  (`isApplyingRef`). Wired in SyncBridge; `setReservation` stamps `reservedAt`.
- **Design rule going forward:** table-state that must sync and ISN'T a live order gets its own
  table + channel — never overload `active_sessions`.

### AI assistant wired across the system (v5.5.735) — SHIPPED (phase 1)
Peter: assistant said "couldn't find any info" about a donut that went to 86; wants it to answer most questions in detail. Root cause: it could 86 an item but had NO read tool over the 86 list, and `getStoreState` only passed 8 slices.
- **Architecture** (unchanged): `api/ai.js` = stateless proxy (mode foh/boh/rota → allowlist + system prompt → Anthropic). Tools execute CLIENT-side in `src/lib/aiTools.js` `executeTool(name, input, storeState)` — reads the passed store snapshot AND already imports the ops-DB `supabase` client for direct queries. `AIChat.jsx` runs the tool loop + builds `getStoreState()`.
- **7 new read tools** (in aiTools.js + api/ai.js TOOL_DEFINITIONS, added to BOTH ALLOWED_TOOLS_FOH/BOH): `get_86_status` (resolves archived names from DB so a 86'd-then-archived item is never misreported), `get_stock_status`, `lookup_item` (price/allergens/variants/mods/stock/86), `search_activity` (activity_events "when/who did X"), `get_order_queue`, `get_waitlist`, `get_menu_overview`.
- **86 now logs to activity_events** (`store.toggle86` → `logActivity(kind:'stock', actorName:staff)`), so 86 changes show in the bell feed AND `search_activity` finds them going forward. Past 86s have no history but `get_86_status` still reports them + since-when from the `eighty_six.created_at` row.
- **getStoreState widened**: + dailyCounts, orderQueue, waitlist, staffMembers, discountPresets, menus. **Model** bumped `claude-sonnet-4-6` → `claude-sonnet-5`.
- Reviewed by a 15-agent adversarial pass (RLS/columns/model-id/donut path): 11/12 refuted, 1 low finding fixed. DB columns verified vs QueueSync (order_queue) + activity.js (activity_events).
- **DEFERRED (phase 2)**: customers/loyalty + gift cards (Platform DB — the AI's `supabase` is ops-DB only), staff-on-shift (wf_timesheets — RLS review), deliveries (courier_deliveries), full report tools, and a "reason" field on 86. Can't live-test locally (needs the deployed ANTHROPIC_API_KEY) — Peter verifies on dev.

### Menu-cache-on-sign-in + per-user checkout (v5.5.734) — SHIPPED
Two fixes shipped together.
- **Category flicker on every login (Peter reported "categories move around then move back").** Root cause: `<SyncBridge>` is rendered in BOTH the PIN-screen and signed-in branches (App.jsx:8651 + :8660), so it **remounts on every login** and re-runs boot hydration — which applied the pushed config snapshot (correct order) then let a parallel direct DB re-fetch overwrite `menuCategories` with a DB-ordered copy. Fix: the pushed snapshot is now **authoritative** for menu data; `SyncBridge` guards the DB-fetch writes for menuItems/menuCategories/menus/modifierGroupDefs with `!snapHas(k)` (DB is a fallback only when nothing was pushed). A new Push to POS still refreshes via realtime. This is the "cache the menu, only refresh on push, function locally" model Peter asked for.
- **Per-operator counter checkout on a shared till.** Switch operator → outgoing person's in-progress COUNTER order (`walkInOrder` + customer/orderType/pendingLoyaltyReward/deliveryQuote) is PARKED under their staff id (`heldOrders`), incoming person gets their own held order back (toast "Your held order is back — N items") or a clean empty checkout. Table orders untouched (live on `tables[].session`). Pure logic + 14 tests in `src/lib/cartHold.js`; store `login`/`logout` call `operatorSwitchPatch`/`logoutPatch`. In-memory holds (like walkInOrder itself — ephemeral until sent/paid).
- **4 regressions caught by adversarial review + fixed before ship** (all verified CLOSED by a second review): (HIGH) card-swap mid-payment nulling the live cart → CardUserSwitch refuses to switch while `_signoutBlock > 0`; (HIGH) card-swap with a table open destroying the dormant counter cart → `hasHoldableCart` no longer gates on `activeTableId`; (HIGH) sent-but-unpaid order double-recorded (held + Orders Hub) → sent orders (`sentAt`/`ref`) are never parked, they stay in Orders Hub; (MED) pay/send auto-sign-out timer signing out the NEXT operator → identity check + `login`/`logout` cancel the pending `_autoSignoutTimer`. ⚠ Known residual (accepted): `BarSurface.captureHeldTab` charges without holding `_signoutBlock`, but a swap there can't orphan the charge (record built from the `tab` closure, not live state).

### Per-device auto sign-out policy (v5.5.731 + v5.5.732 guard) — SHIPPED
Peter: "program user behavior … sit on a device profile level. How do users log out: Manually (scan another card / user-icon logout), Timed (15-second increments of no activity), or by cashing off / clicking send on an order." Manual card-swap already existed (`CardUserSwitch`). Added the other two triggers, configurable per device profile.
- **Migration** `supabase/migrations/20260702_signout_policy.sql` (APPLIED): `device_profiles += signout_idle_seconds int / signout_on_pay bool / signout_on_send bool` (all default off → existing tills unchanged).
- **BO** `DeviceProfiles.jsx`: DB↔profile map both ways + new-form defaults + a "Sign-out behaviour" editor (idle `<select>` Off…5min in 15s steps + on-pay / on-send toggles).
- **Boot** `App.jsx` config builder threads `deviceConfig.signout = {idleSeconds,onPay,onSend}`.
- **Idle trigger** = `<AutoSignout>` component in the POS staff shell (next to `<CardUserSwitch>`): pointerdown/keydown/wheel/touchstart re-arm the timer; on fire it `logout()` + toast. Guarded ≥5s.
- **Pay/send trigger** = store `maybeAutoSignout('pay'|'send')` — 1.4s after the confirmation toast, re-checks `staff`, then `logout()`. Hooked after "Sent to kitchen" (send) + in `recordClosedCheck` and the walk-in pay path (pay).
- **v5.5.732 payment-safety guard (important):** a re-entrant store counter `_signoutBlock` + `blockSignout()/unblockSignout()`. `CheckoutModal` and `TabPreAuthTerminal` hold it while mounted, so a customer taking >15s to tap the reader (NOT POS DOM activity) can't trip the idle timer, unmount checkout, and orphan a charge. While held, the idle timer **re-arms instead of logging out** → a genuinely-idle till still signs out once the payment finishes. `maybeAutoSignout` is intentionally NOT blocked (it fires only after the payment completes).

### ServOS Manager app — NEW surface `?mode=manager` (v5.5.694) — ALL 5 TABS LIVE (read); writes deferred
The owner app + ops tablet merged into one **role-adaptive phone app** (Capacitor store build later; separate from the Sunmi POS APK). Build prompt: `ServOS Manager - Claude Code prompt.md`; design: `ServOS Manager - design spec.html` (reuse the existing `[data-skin=servos]` glass system — confirmed, no new CSS).

**Done (additive, shipped, 194 tests green):**
- **Pure engine + tests** in `src/lib/manager/`: `floor.js` (open-table states + the configurable **stalled** rule), `team.js` (on-shift / no-show / break-due / live labour pennies), `timesheets.js` (anomaly flags), `kitchen.js` (below-par + 86 + batch status), `access.js` (role→tab flags per §3 presets + per-person permission overrides). Each `*.test.js`.
- **Surface** `src/surfaces/ManagerSurface.jsx` + `src/surfaces/manager/*` — mirrors `OperationsSurface` boot (pairs via **ops_devices** claim-code + heartbeat → staff PIN via `opsPinLogin`), floating bottom tab bar (Home/Reports/Team/Ops/Kitchen) gated by role, dark/light toggle, `CardErrorBoundary`. **All 5 tabs now render LIVE data** (read-only): Home glance, Reports (takings + floor + stalled nudge), Team (on-shift/no-shows/breaks/live labour), Ops (compliance/maintenance/alerts, reuses `lib/ops/data`), Kitchen (below-par stock by supplier). Management *writes* (approvals, raise-PO, batch cooks) are the remaining slices.
- Wired: `App.jsx` dispatch (`deviceMode==='manager'` → `<KioskAutoUpdate/><ManagerSurface/>`) + import; ModeSelector "Manager" card.
- **(v5.5.692) `manager-snapshot` edge fn DEPLOYED + Reports/Team LIVE.** `supabase/functions/manager-snapshot/index.ts` (single venue, `requireToken` + fence: device claimed to this loc via `ops_devices.device_uid=auth.uid()` **+ `active=true`** (v5.5.693 hardening — a decommissioned till can't read takings), or `user_locations`/super_admin). Returns today money (net=`closed_checks.subtotal` ex-VAT, mirrors owner-snapshot), live floor (`active_sessions.session`→`floor.js`), live team (`wf_timesheets`+today `wf_shifts`+`wf_staff` names+`effective_rate`→`team.js`), and (v5.5.693) **kitchen** (below-par stock — see next). Client: `src/lib/manager/data.js`. ⚠ tz: reads `locations.timezone` from OPS DB (owner-snapshot uses PLATFORM) — defaults Europe/London (fine for the UK customer; revisit for non-UK).
- **(v5.5.693) Kitchen LIVE (read-only).** Snapshot returns a `kitchen.items` block from the **greenfield stock system** (`inventory_items` + `par_levels` + `suppliers`, all confirmed live in ops DB — 6 tracked items, 1 par). `ManagerKitchen` renders below-par/reorder stock grouped by supplier (one PO each) via the tested `kitchen.js` `belowPar`/`bySupplier`. The kitchen read is isolated (`try/catch` → `[]`) so a stock-read failure never breaks money/floor/team. NOTE: `eightySixed` is hard-`false` for ingredients (the `eighty_six` table keys menu items, not inventory items) — fine for v1; 86-overlay is a later enhancement. **`prep_schedule` does NOT exist** (confirmed) — batch cooks need that NEW additive table.
- **(v5.5.694) Live Home + shared snapshot.** Snapshot lifted into `ManagerSurface` (one 30s poll, passed via `ctx.snap`/`ctx.snapErr`/`ctx.refreshSnap`); Home/Reports/Team/Kitchen all read it → **instant tab switches, single network call**. **ManagerHome** now a live "at a glance": net-sales (ex-VAT) hero + pulse tiles (open tables / on shift / to order), each role-gated and tapping to its tab; reuses `classifyFloor`/`onShiftNow`/`belowPar` so the numbers match the detail tabs.
- **(v5.5.695) Ops FOLDED IN — full writes, ONE codebase (per Peter's "remove the standalone OPS view … so there isn't multiple surfaces to manage").** Extracted `OperationsSurface`'s post-auth body into a shared exported **`OpsContent({loc,venueName,operator,onLogout,chrome})`**. Standalone `?mode=ops` renders `<OpsContent chrome />` (AppShell header+bell — unchanged); **Manager Ops tab** (`ManagerOps.jsx`) renders `<OpsContent chrome={false} />` bare inside the Manager Shell, alerts via a bell on the Ops Home card. Manager Ops is now the FULL interactive Ops (temp rounds + breach→corrective→auto-maintenance, opening/closing/cleaning checklists w/ photo sign-off, goods-in delivery checks, maintenance, alerts) — replaced the old read-only dashboard. Writes go through the same location-fenced `lib/ops/data` + `lib/ops/checklists`. Adversarial review (10 agents): **6 raised, 0 real**. Theme: OpsContent does NOT force the dark skin (only the standalone default does) → embedded follows the Manager light/dark toggle. **`?mode=ops` kept working — NO prod cutover** (entry point + ModeSelector "Ops" card still there). ⚠ **Open decision:** whether to fully retire the `?mode=ops` entry/ModeSelector card now that the Manager app covers it (staff PIN = Home/Ops/Kitchen). ⚠ **Pre-existing gap (flagged, NOT fixed here):** ops writes don't honour training mode — but `isTrainingMode()` can't be true on `ops_devices`-paired devices (training flag is `device_profiles`-only), so it never fires; do a dedicated guard pass if ops ever runs on a training till.
- **OUT (decided this turn):** owner-reports-as-home / multi-venue switch — Peter: "that looks more hard to do, leave that one out." Single venue stays.

**Verification of the money/auth endpoint:** adversarial review workflow `wf_196d11bb-be7` (26 agents) — **23 raised, 0 confirmed real**. Money mirrors owner-snapshot, the 3-path fence holds, data shapes align. Two noted-not-fixed: (a) `active`-flag hardening → applied v5.5.693; (b) floor `lastFiredAtMs` = `session.sentAt` is the FIRST kitchen send, so the "stalled since last course" heuristic measures since-first-send (the session shape has no per-course fire timestamp — fixing needs POS-core/store changes, out of additive Manager scope).

**Build-out of the 4 mockup functions (Peter picked all four, 29 Jun):**
- **(v5.5.697) Role tick-boxes DONE** — `StaffManager.jsx` PERM_GROUPS got a "Manager app" group (`manager_reports/team/approvals/ops/kitchen`); per-person overrides on top of the role preset, persisted via the existing `togglePerm`/`permissions text[]` path. No migration.
- **(v5.5.697) Home bento DONE** — `ManagerHome.jsx` rebuilt to the "balanced dashboard" mockup: takings hero (ex-VAT) + sub-stats, "needs you now" bar, live 2×2 status bento (Floor/Team/Ops/Kitchen), all role-gated from `ctx.snap` + the engines.
- **(v5.5.697) Kitchen incoming DONE** — snapshot adds `kitchen.deliveries` (open SENT/PARTIAL POs + delivery status) + `ops{openMaintenance,activeAlerts}`; `ManagerKitchen.jsx` shows "on order · incoming". Goods-in CHECK stays in Ops → Deliveries.
- **(v5.5.698) Team approvals DONE — PIN-secured.** New `manager-approve` edge fn (deployed): double-fenced — device authorised for venue + the approver **resolved server-side from their PIN** (re-matched against `staff_members`; NEVER a client-supplied id) + must be Manager/Owner or have `manager_approvals`. Writes `wf_timesheets.status='approved'` / `wf_time_off.status='approved'|'denied'` + appends `wf_audit` under the resolved person. Snapshot `team` now returns `pendingTimesheets`+`pendingTimeOff`. `ManagerTeam` Approvals section is PIN-locked until a manager unlocks. ⚠ An adversarial review CAUGHT a real privilege-escalation/audit-forgery hole (client-supplied operator_id) → fixed by PIN re-verification + re-verified `fixed=true`. Residual (non-blocking): no DB unique on `staff_members(location_id,pin)` (PINs assumed unique per location, matches ops_pin_login).
- **(v5.5.699) Kitchen batch cooks DONE — migration APPLIED (Peter authorised 29 Jun).** New `20260629_prep_schedule.sql` → **`prep_schedule`** (recurring template, RLS = `user_accessible_locations`, BO-edited) + **`prep_log`** (daily completion, RLS = `ops_can_write` so a claimed device can record). `src/lib/prep.js` (fetch/save/delete schedule + `recordPrep` — training-gated, upsert one-per-day on `(location_id,schedule_id,prep_date)`). Snapshot `kitchen.batches` = today's scheduled prep (today's weekday via `days_of_week` 0=Sun..6=Sat; null/empty=every day) + today's `prep_log`, passing raw dueDate+dueTime (client builds dueAtMs in venue tz). `ManagerKitchen` "Batch cooks · today" via `kitchen.js` `groupBatches` (overdue/due/done) + one-tap **Record**. NEW BO screen **`OpsPrepSchedule.jsx`** (Operations → Prep schedule) wired in `BackOfficeApp.jsx`. **ALL 4 mockup functions now done.**
- **Still not built:** raise-PO from the app (goods-in/check stays in Ops → Deliveries); Capacitor packaging.
5. **Multi-venue — OUT OF SCOPE (decided).** The Manager app runs **one venue** (the paired location); no venue switcher, no cross-location rollups. An owner with multiple sites uses the (more complex) web Back Office. `multi_venue` removed from `access.js` (v5.5.691).
6. **Capacitor packaging** (iOS + Android store builds, push for no-shows/approvals, secure token storage, biometric unlock) — native, needs tooling + Apple/Play accounts; Sunmi POS APK path untouched.

**Reuse map** (full): workflow `wh82a4sfc` output — `tasks/wh82a4sfc.output`. **Guardrails:** out-of-scope = payments/checkout, POS core, KDS, courier/delivery seam, broad RLS pass — stop & ask.

### 0. MPOS Android app (NEW, v5.5.474) + phone Tap-to-Pay verdict
**Android MPOS app shipped as an order-taker.** The `:mpos` Gradle module (own `applicationId co.posup.rpos.mpos`, own CI `build-mpos.yml`) is a thin WebView → `?mode=mpos`, same "one module per device app" pattern as `:app`/`:menuboard`. Card payments use the surface's existing flows (assigned WisePOS/Ryft reader, or simulated). **No native Tap to Pay on Android** — the customer is standardising on **Ryft, which has no Android SoftPOS**. Doc: `android/MPOS_TAP_TO_PAY.md`. Pending: its own app icon (the "S. MPOS" mark) — placeholder icons in place until the asset file is dropped.

**Phone Tap-to-Pay decision is OPEN (verified June 2026, run `wf_26d03500-f0a`).** Adversarially confirmed (3/3 voters): **Ryft Tap to Pay on iPhone does NOT exist** — Apple's UK Tap-to-Pay-on-iPhone PSP list (https://developer.apple.com/tap-to-pay/regions/) excludes Ryft; Ryft's iOS SDK is in-app card + Apple Pay only; Ryft in-person = PAX hardware terminals. So "tap on the phone, no hardware" is **only** buildable via **Stripe** (iPhone via Stripe Terminal iOS SDK, or the Android Stripe-Terminal route), which means **Stripe as a second in-person processor** alongside Ryft. To stay 100% on Ryft, the only option is a **Ryft PAX terminal (extra hardware)**.
- **Reusable for whichever phone-tap path:** the `window.RposTapToPay` bridge contract, `src/lib/tapToPay.js`, and the `MCardFlow.jsx` native branch are processor/OS-agnostic (an iOS Swift `WKWebView` + `TapToPayBridge.swift` implements the same contract; the web side is reused). The Android-native Stripe Terminal layer built earlier this session was **removed** when scope changed to "order-taking Android app"; it's recoverable from git history if the Stripe-on-Android path is chosen.
- **Decision needed from user:** (a) "phone, no hardware" ⇒ Stripe (iPhone or Android) + accept a 2nd processor; or (b) "all in-person on Ryft" ⇒ Ryft PAX terminal + accept hardware. Then: iPhone (App Store/TestFlight, Apple entitlement, no sideload) vs Android (sideloadable today).

### 1. ServOS visual reskin (POS + Back Office)
"Liquid glass" design system applied across POS + Back Office, **zero behaviour change** — scoped via `data-skin="servos"` on `<html>`, light/dark via `[data-theme]` (persisted to `rpos-theme`). Customer-facing online/QR/kiosk UIs deliberately untouched. Back-office sidebar reorganised into a 10-section collapsible IA (`NAV_IA` in `BackOfficeApp.jsx`). Shared tokens/classes in `src/styles/globals.css`; brand in `ServOSBrand.jsx`; line-icon set in `ServOSIcons.jsx`.

### 2. Workforce module (NEW — the big one)
A complete staff-management system inside Back Office (sidebar group **Workforce**), per-location, wired to live financials. Sections: **Dashboard · Rota · Timesheets · Time off & availability · Staff · Onboarding · Compliance · Positions & rates · Tronc/tips · Announcements · Workforce settings.** See the dedicated section below.

### 3. Time Clock surface (NEW)
Dedicated `?mode=clock` tablet for staff to clock in/out + take breaks via PIN. Punches write timesheets server-side and feed the Workforce timesheets → pay → tronc/accrual chain. See below.

### 4. Tronc ↔ Tips report tie
Workforce → Tronc now **pulls the real weekly pool from the POS** (card tips + service charge from `closed_checks`, same data the Tips report uses) instead of a manual figure; the Tips report cross-references the audited Workforce payout.

### 5. Workforce depth — onboarding, documents, profiles, SMS, AI rota
- **Onboarding** is a real per-starter pipeline: offer letter, Right-to-Work upload, contract, bank details, POS access (the "first shift" step was removed).
- **Compliance** does **real file upload** to a **private `wf-documents` bucket** (per-location Storage RLS; short-lived signed URLs) instead of pasting a URL. A held doc with no expiry reads as Valid (RTW).
- **Staff profile** — click a staff member for a detail modal (pay/override, contact, **address + emergency contact**, documents, holiday, onboarding, recent timesheets, **bank details for payroll**).
- **Rota notifications** — publishing **texts each affected person** their shifts via `send-sms`.
- **AI rota builder** — Rota → "Build with AI" drafts a week from availability + coverage + forecast + target labour % via `/api/ai` (no-tools `rota` mode); inserted as draft.

### 6. Workforce depth (latest) — templates, e-sign, UK holiday, pay periods, rota actuals, payroll bank
- **Offer/contract templates** (`wf_doc_templates`): create/edit reusable templates with `{{merge}}` fields (Workforce → Settings); onboarding picks one, merges the person's details, and sends. Modelled on Deputy / Workforce.com. Built-in UK defaults.
- **In-app e-sign**: contract "Generate" → **"Sign now"** opens `/sign/<token>` on-device (or Email / Copy link) → candidate types name to sign; signature+timestamp+IP stored. Public page + `workforce-onboarding` edge fn; renders the merged contract inline.
- **UK holiday**: **hourly/irregular** staff accrue **12.07%** of worked hours (server-side, `accrual.run` skips salaried); **salaried** get a fixed **28-day** allowance. For variable-hours staff "a day" of leave = their **average paid hours per day** (`avgHoursPerDay`/`isHourly` in `labour.js`). WfLeave shows basis/accrued/taken/remaining per person.
- **Pay periods**: monthly, configurable start day (e.g. 26th → 26th–25th) on `wf_venue_settings`. Workforce → Pay **"Run payroll"** scopes approved timesheets to the period (`wfWeek.payPeriod`; `pay.period` edge fn takes from/to) with prev/next nav.
- **Rota actuals**: footer now shows **Actual wage** (from timesheets) + **Labour % (plan)** and **Labour % (actual)** alongside scheduled wage + forecast/actual sales.
- **Payroll bank**: full account stored (org-RLS-fenced) + sort + masked; shown on the staff profile so staff can be paid.
- **Email/SMS via SDK**: all workforce `send-receipt`/`send-sms`/`workforce-compute` calls go through `supabase.functions.invoke` (correct gateway auth) — fixed offers/contracts not sending.

### 7. (newest) Payments choice (Ryft), Review Manager + Google, Reporting suite, Owner app
- **Ryft payments** built alongside Stripe (dual-processor, chosen per location): card-present (CheckoutModal), online/QR/kiosk, **bar-tab pre-auth** (store card → capture on close), refunds, **disputes** (accept/challenge with a respond-by deadline), a reconciliation ledger (`ryft_payments`) kept in sync by webhooks, and admin onboarding/connect. Edge fns `ryft-*`, `payments-onboard/admin/processor`. See `RYFT_INTEGRATION_PLAN.md`.
- **Review Manager** (Back Office → Customers → Reviews): de-gated, **compliance-safe** (UK DMCC 2024 / US FTC Oct-2024 — no review-gating) reputation module. Approvals queue, branded customer review card at `/review` (inherits the venue brand kit + uploadable background), trigger engine (POS-driven SMS ask), dashboard, settings. Pulls/replies through **real platform APIs only** — Google (live path), TheFork/Trustpilot (stubbed until OAuth built). `review-*` edge fns + `review_*` tables.
- **Google connection** (one-time *platform* OAuth, not per customer): `review-google` flow + `_shared/google-reviews.ts`. OAuth client **"ServOS Reviews"** created + Supabase `GOOGLE_OAUTH_CLIENT_ID/_SECRET` set (13 Jun); each venue just clicks **Connect Google**. **v4 review-DATA API access is PENDING Google approval** (case `1-2668000040500`, ~7–10 business days — see Open items). Full state in memory `reference_google_review_oauth.md`.
- **Reporting suite** (Back Office → Reports):
  - **Daily trading (P&L)** — Sales → "Daily trading (P&L)". `trading-report` edge fn. Per-day operator **forecast** (with a "same weekday last year" suggestion learned from `closed_checks`) → full P&L ladder: **gross takings → less VAT (collected for HMRC, never profit) → net sales (ex-VAT) → less COGS (configurable %) → gross profit → less labour (theoretical rota vs actual timesheets) → less overhead → operating profit**, with per-day table (Gross/VAT/Net columns) + totals. VAT from `closed_checks.tax_amount` (fallback `total−net−service−tip`); gross = net + VAT (the `total` column is unreliable). COGS%/overhead stored in `wf_venue_settings.settings` jsonb — **no schema change**.
  - **Payroll** — Staff → "Payroll". Reads closed `wf_payroll_runs`; per-run wages/tips, expandable per-staff breakdown, CSV.
- **Owner app** (`?mode=owner`): mobile-first PWA. Back-office login → top-down snapshot across every location the owner can access (today net vs forecast, % to forecast, labour %, orders, avg check, tips, live orders + open tables, WTD vs last week, top sellers) in one `owner-snapshot` edge-fn call. Light/dark toggle (shared `rpos-theme`). Real ServOS logo via `ServOSBrand` components. `src/surfaces/OwnerSurface.jsx`.

### 8. (newest) Digital Menu Board (NEW)
A TV / Android-TV menu-board surface + a Back Office builder (Channels → **Menu boards**). Build a "screen" (a `menu_boards` row): pick categories (**drag to reorder**; mark any **Full width** to make a hero band), set orientation / columns / branding / **marketing mode** (fullscreen image or video, no menu), then Publish. The display (`?mode=menuboard`) **auto-fits to one screen** — columns fill **top-to-bottom** (`column-fill:auto` with an explicit integer column count so overflow is actually detected) and type scales up to fill the height; it never clips, even at large "Text size" (which maps to column count: more columns = bigger type). Shows descriptions, dietary badges, **allergens (comma-separated, on their own line under the description)**, variant sizes (indented with a price gap), and **"Sold out"** from the live 86 system. Live over Realtime on Publish; cache-first so it survives offline.
**Screen pairing** (NEW): a screen opened with no `?board` self-registers and shows a high-entropy **pairing code**; in Back Office → Channels → Menu boards → **Paired screens**, enter the code + pick a board to assign it (then reassign / unpair / remove, each with an Online / last-seen indicator). The device learns its board over Realtime (+ 20s poll + 60s heartbeat) and renders it live. New **`menu_board_screens`** table with **device-scoped RLS** (a device only sees its own row; BO only its venue's screens) + `SECURITY DEFINER` `claim`/`set`/`heartbeat` RPCs — no cross-tenant code enumeration. Hardened after a 5-agent adversarial RLS review: **~39-bit codes** (8-char unambiguous, was ~17-bit) + a **30-min claim TTL**. `?board=<id>` direct links still work as a manual fallback. Files: `src/surfaces/MenuBoardSurface.jsx`, `src/backoffice/sections/MenuBoards.jsx`; migrations `20260613_menu_boards.sql` + `20260614*_menu_board_screens*.sql`; spec `MENU_BOARD_PLAN.md`.

### (earlier in this block) Bar-tab card holds, multi-currency (`lib/currency.js`, `locations.currency`), MPOS hardening (86 on modifiers, tax breakdown, customer search), customer-display loyalty + theme.

---

## Workforce module — how it works (for whoever picks this up)

**Front end** — `src/backoffice/sections/Workforce.jsx` is the router; the staff list + add/edit modals live there. Each section is its own component in `src/backoffice/sections/workforce/` (`WfRota`, `WfTimesheets`, `WfTronc`, `WfPay`, `WfLeave`, `WfOnboarding`, `WfCompliance`, `WfAnnouncements`, `WfSettings`). Shared building blocks:
- `src/staff/wfData.js` — **the data-access layer**. Location/org-scoped CRUD for every `wf_*` table + `loadActualSales` / `loadTipPool` (from `closed_checks`) + `invokeCompute` (calls the edge function). Maps snake_case ↔ camelCase. Has a `localStorage` fallback when `isMock` so it's testable without a backend.
- `src/staff/wfUi.jsx` — shared ServOS UI primitives (Card, Badge, EmptyState, table styles, colours).
- `src/staff/wfWeek.js` — current-week (Mon–Sun) date model for the rota.
- `src/staff/labour.js` — labour engine: `resolveRate` (override → role base → salaried equiv, with provenance), `hoursOf`, `labourPct`, `troncRun` (largest-remainder, penny-exact), `accrueHolidayHours` (12.07%).

**Database** — `supabase/migrations/20260608_workforce.sql` (APPLIED to Ops DB). 18 `wf_*` tables (`wf_staff`, `wf_roles`, `wf_sections`, `wf_venue_settings`, `wf_shifts`, `wf_timesheets`, `wf_holiday_accrual`, `wf_time_off`, `wf_availability`, `wf_tronc_runs`, `wf_tronc_lines`, `wf_documents`, `wf_sales_forecast`, `wf_user_roles`, `wf_audit`, `wf_swap_requests`, `wf_onboarding`, `wf_announcements`, `wf_doc_templates`). Later migrations add bank/holiday/pay-period columns + the wf-documents bucket (`20260609*`, `20260609b`). Key properties:
- **Real tenant RLS** (NOT "allow all"): location-scoped via `user_accessible_locations()`, PII (`wf_staff`) org-scoped via `user_accessible_orgs()` — anonymous kiosk/clock sessions get an empty fence and cannot read payroll/PII. Helpers are defined in this migration (self-sufficient) + super-admin bypass.
- Money is `numeric` + currency-stamped; pay **rate/source snapshotted** onto shifts/timesheets so historical pay is reproducible.
- `wf_audit` + `wf_holiday_accrual` are **append-only** (UPDATE/DELETE/TRUNCATE revoked from client roles; audit has a prev_hash/row_hash chain).
- FKs onto staff are `ON DELETE RESTRICT` + staff are **soft-deleted** (`status='leaver'`) — pay/compliance history is never destroyed. Composite `(…,org_id)` FKs prevent cross-tenant linking. Finalised tronc runs are immutable (trigger).

**Server-side compute** — `supabase/functions/workforce-compute` (DEPLOYED). Pay-critical maths never runs on the client. Actions: `tronc.run` (largest-remainder split of the pool by published-shift hours × role points, writes `wf_tronc_runs`+`wf_tronc_lines`+audit), `accrual.run` (12.07% of approved hours → `wf_holiday_accrual`), `pay.period` (per-staff pay from approved timesheets), `labour` (daily sales). Runs as service-role; enforces the tenant fence itself by checking the caller's location access.

**The flow:** add staff → "Set as POS user" (creates a till login in `staff_members`, links `wf_staff.pos_user_id`) → build & **publish** the rota → staff clock in/out on the Time Clock → approve timesheets → Pay + Tronc + holiday accrual compute from the approved hours.

---

## Time Clock surface — how it works

`src/surfaces/TimeClockSurface.jsx`, routed by `deviceMode === 'clock'` in `App.jsx` (after the device-pairing check; pairs like a POS). Selectable in `ModeSelector.jsx`. Full-screen PIN pad → status (clocked out / on shift since / on break) → **Clock in / Start break / End break / Clock out** with a confirmation, then auto-returns to the pad.

Punches are written **server-side** by `supabase/functions/workforce-clock` (DEPLOYED): it validates the entered PIN against `staff_members` for the device's location (PINs never reach the client — more secure than the POS PIN pad), maps to `wf_staff` (auto-creating a minimal HR record if the POS user has none), snapshots the pay rate at clock-in, tracks the in-progress break via `wf_timesheets.break_open_at`, and computes `actual_hours`/`variance`/`pay_amount` at clock-out. These timesheets are exactly what Workforce → Timesheets/Pay/Tronc consume.

---

## Surfaces / modes

`?mode=` → `pos` · `mpos` · `bar` · `tables` · `kds` · `kiosk` · `orders` · `customer-display` · `clock` · **`menuboard`** (digital menu board — pairs to a board via a code, or open `?board=<id>` directly) · **`owner`** (owner snapshot PWA — BO login, no device pairing) · `office` (Back Office) · `admin` (internal Company Admin). Customer web: `/online/:slug`, `/customer/*`, `/gift/*`, `/qr/*`, `/sign/<token>` (Workforce contract e-sign), **`/review`** (Review Manager customer card). Mode is chosen in `ModeSelector` and saved to `rpos-device-mode` (the owner app is URL-bookmarked, not a device tile).

---

## Two Supabase projects + key tables

| | Ops DB `tbetcegmszzotrwdtqhi` | Platform DB `yhzjgyrkyjabvhblqxzu` |
|---|---|---|
| Holds | POS operational data + **all edge functions** | orgs, users, loyalty, gift cards |
| Client | `supabase` (lib/supabase.js) | `platformSupabase` |

**Ops tables:** `menu_items/categories/menus`, `modifier_groups`, `active_sessions`, `closed_checks`, `floor_tables`, `config_pushes`, `stock_levels`, `eighty_six`, `locations`, `device_profiles`, `pos_devices`, `staff_members`, `user_profiles`, `user_locations`, `order_queue`, `tax_rates`, `discount_definitions`, the 18 **`wf_*`** Workforce tables, **`review_*`** (Review Manager incl. `review_settings`, `review_google_tokens`, `review_requests`), **`ryft_payments`** (reconciliation ledger), **`menu_boards`** (digital menu-board screens/content) + **`menu_board_screens`** (paired physical TVs; device-scoped RLS + claim/set/heartbeat RPCs). **Edge functions** (Deno): gift/loyalty/stripe/send-* + `workforce-compute` / `workforce-clock` / `workforce-onboarding` + **`trading-report`** (Daily P&L) + **`owner-snapshot`** (owner app) + **`review-*`** (review-admin/sync/reply/submit/request/google) + **`ryft-*`** / **`payments-*`** (dual-processor payments). All `verify_jwt=false` and enforce their own tenant fence. **Storage:** private `wf-documents` bucket + `receipt-assets` (review card backgrounds). SMS (Twilio) + email (Resend) configured. **Platform env (Ops project) secrets** include `GOOGLE_OAUTH_CLIENT_ID/_SECRET`, `RYFT_SECRET_KEY`, Stripe + Resend keys.

---

## Build / deploy

```bash
npm run dev        # mock mode locally (isMock; no Supabase)
npm run build      # MUST be clean before pushing
git add … && git commit && git push origin develop   # Vercel auto-deploys
```
Every deploy: bump `src/lib/version.js` + add a top-of-array `CHANGELOG` entry in `src/App.jsx`. Edge functions deploy via the Supabase CLI (`SUPABASE_ACCESS_TOKEN=<PAT> npx supabase functions deploy <name> --project-ref tbetcegmszzotrwdtqhi`) — native bundler, no Docker needed. DB migrations are applied via the Supabase Management API (`POST /v1/projects/<ref>/database/query`) or the dashboard SQL editor.

---

## Open items / outstanding TODOs

### 🔴 Time-sensitive — don't forget
1. **Google review-data API approval — PENDING.** Business Profile **v4** access request submitted **13 Jun 2026**, case **`1-2668000040500`**, Google quoted **~7–10 business days** (≈ **24–27 Jun 2026**). Until granted, OAuth/"Connect Google" works but review list/reply calls **403**. **CHECK around 24–27 Jun**: the approval email lands on the submitting account **peter@posup.co.uk** (and/or the support case). When approved → enable the now-ungated "Google My Business API" in the `servos-crm` project; reviews then flow. (Full state: memory `reference_google_review_oauth.md`.)
2. **Revoke the Supabase PAT** used 13 Jun to deploy `trading-report`/`owner-snapshot` and to apply the `menu_board_screens` migrations — https://supabase.com/dashboard/account/tokens → Revoke (unless more deploys are imminent). Lives only in `/tmp/sbtoken`; never commit it.

### Review Manager / Google — to go fully live
3. **Consent screen → External + Google verification** of the `business.manage` scope. It's currently **Internal** (serv-os.app Workspace), but the verified Business Profile (**POSUP**) sits on `peter@posup.co.uk` *outside* that org — so even *testing* the Connect flow needs **External + Testing mode + peter@posup.co.uk added as a Test user**. Full verification removes the "unverified app" warning so any external venue can connect.
4. **TheFork + Trustpilot OAuth** connect flows (currently stubbed in `_shared/review-platforms.ts`). Rule: only surface a platform once a real connect exists.
5. **Review ask-engine cron** — schedule `review-request scan_all` (~every 15 min) so post-visit SMS asks fire automatically (manual run-now works today).

### Stock / inventory — deferred by user (memory `project_post_launch_tasks.md`)
6. **Finish the stock system, starting with `cost_price` on `menu_items`** (none today). Unlocks **real COGS** in Daily trading (P&L) + owner app (currently an estimated flat %). Thread via the 3 standard spots (db.js item upsert, store save path, SyncBridge mapping) + a MenuManager cost field.

### Reporting / owner app — polish
7. Owner app: optional "View on phone" QR in Back Office; deeper drill-downs.
8. Daily trading: surface a per-day **service charge / tips** line (tracked, not yet shown); CSV export.

### Menu board — built & live; still open
8a. **Pagination / auto-rotate** for menus too long for one screen, and/or **rotate between multiple boards** on one screen (e.g. food → drinks → promo).
8b. **Dayparting / scheduling** — auto-switch board by time of day (breakfast → lunch → dinner → marketing at close).
8c. **Fire TV / Android-TV APK flavor** (`menuboard` product flavor in `android/AUTO_UPDATE_PLAN.md`) + sideload guide, so it runs as a real installed app that boots straight to `?mode=menuboard`. *(The web surface + pairing are done; this is the device packaging.)*
8d. **Display hardening** — overscan safe-margins, nightly reload, burn-in mitigation for 24/7 screens.
8e. *(optional)* Rate-limit / lockout on `claim_menu_board_screen` — entropy (~39-bit) + 30-min TTL already make brute-force infeasible; a per-caller throttle is belt-and-braces, deferred.

### Workforce — still open from the prior block
9. **Workforce → Dashboard** legacy tiles → wire to live rota/sales.
10. **"Who's on shift now"** live view + optional clock-in shortcut on the POS PIN screen.
11. **UK vs US tip distribution** — offer the UK Tronc (hours × points) method inside the Tips *report* for UK venues (report is US-model; Workforce → Tronc is UK).
12. Swap-request approvals + announcements SMS (publish-rota SMS is live).

### Platform / infra — post-launch (memory `project_post_launch_tasks.md`)
13. **Apple Pay / Google Pay wallets** on online ordering (`<PaymentElement>` + per-venue Apple Pay domain verification).
14. Android self-update → production signing/CI (`android/AUTO_UPDATE_PLAN.md`). *(Menu Board web surface + pairing now built — see items 8a–8d; the Android `menuboard` flavor is 8c.)*
15. Multi-currency tail (denomination sets), bar-tab pre-auth refinements, `resolveCompanyForLocation` dedup, code-split bundles, commit `send-sms` source.

## Ops / secrets note
A Supabase **Personal Access Token** was used 13 Jun 2026 to deploy `trading-report` + `owner-snapshot` (written to `/tmp/sbtoken`, NOT committed). **Revoke it** once no more deploys are pending (item 2). `GOOGLE_OAUTH_CLIENT_ID/_SECRET`, `RYFT_SECRET_KEY`, Stripe + Resend keys live **only** in the Ops project's Edge Function secrets — never repo/bundle. Vercel env holds the real `VITE_SUPABASE_*`; `.env.local` is placeholders (mock).

## Session 22–23 Jul 2026 (night) — Ryft PAX: first real charges + pairing consolidation
**DONE:** First-ever end-to-end sandbox charges through our PAX app (dispatch→claim→tip→charge→PRESENT CARD→tap→approved→verified-settle→durable close) — repeatedly, including owner-run counter sales. Root-caused+fixed: DEVICE_CONNECTED gating (fallback→then parallel charge), in_flight double-CAS (markDispatched skips server flip on real path), terminal-id drift 404 (explicit-id link). Pairing CONSOLIDATED to one flow (PaxTerminals + per-terminal Connect-to-Ryft; RyftTerminals sunset; re-pair carries the link; migration 20260731). POS status drawer processor-aware; assignment=fence (client+server, v5.5.859). R1 Table-Pay double-charge closed (20260730) then made occupation-aware after a live false-block (20260801, reviewed CONFIRM-SAFE, + idx 20260802 + INVARIANTS.md). Durable mode-3 cash-off + per-sale counter keys (v5.5.862). Terminal 2.0-rc6: ~6s pickup, parallel charge, hands-free auto-return result screen; OTA channel live (versionCode 12). A50 paired+Ryft-linked via the new flow (first try). Scale audit (24 agents): pilot-ready verdict, risks ranked.
**FAILED (twice, reverted, parked):** PointOfSale receipts — controller awaits confirm-receipt DURING tender; both attempts voided live taps; controller settings PIN unknown (1111/1234 wrong); A50 never receives payment pushes. → Ryft email drafted (receipts config + confirm contract + A50 binding). PAX prints again temporarily.
**IN FLIGHT:** #73 🔴 reconciled-without-closed_checks-row bug (job ae318770 £2.85 recovered to 'approved'; suspects: 862 close changes × upsertClosedCheck ok-semantics × dropTableFromFloor) — FIX FIRST. #64 failed-payments route (owner sign-off directive): safe:true→SAFE_NO_CHARGE, webhook settles terminal_jobs, evidence-based sweeper, WAL latch server-clear. #74 hot-swap-safe readers (dispatch handshake, visible routing, one-action replace, no double-binding).
**Fleet state:** A920 = only dispatch terminal, unbound (all tills). A50 pos_dispatch=false until Ryft fixes push binding. Both rc6.

## 24 Jul 2026 (overnight) — speed & scale hardening (v5.5.889–891)
- Bundle split: main 5,164KB → 1,533KB (lazy BackOfficeApp + CustomerBoot + WhatsNewModal/CHANGELOG → src/lib/changelog.js — CONVENTION MOVED, see CLAUDE.md rule 7).
- Killed leaked 15s cash-drawer poll (the real 394k-call source), POS grid/tax/counts memos, MPOS double-init guard, SyncBridge ref-equal short-circuits.
- Customer pages: narrowed config_pushes select (online+catering), lazy images, parallel slug reads. Edge: loyalty-otp send reads batched, loyalty-balance N+1 removed (deployed + regression-verified).
- STAGED awaiting owner: migrations/20260804b_realtime_prune.sql (ALTER PUBLICATION blocked overnight).
- Full prioritized backlog + stage-release safety punch list: MORNING_BRIEF.md.
