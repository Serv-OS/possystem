# MPOS Spec — Phase 1 (locked 6 May 2026)

A phone-native mobile POS for servers and runners. Reuses the same Zustand store, sync, realtime, edge functions, and master/child failover as the desktop POS — only the UI is different. **Reimagined for phone-first ergonomics, not a shrunk desktop.**

## Strategic positioning

- Targets the same role as Toast Go 2, Square Register Go, Lightspeed Restaurant Go.
- Card-only — no cash drawer on a phone, so cash payments route to the counter via "Pay at counter".
- Stripe Tap to Pay (iPhone NFC, Android NFC) is the primary payment path. Falls back to assigned network reader (REST) if the phone can't do Tap to Pay or the location wants a fixed reader.
- Sunmi MPOS handhelds (V2s Plus, P2 Pro) are first-class — same Android shell as Sunmi tills.
- iPhone via Capacitor shell (Apple restricts NFC payment APIs to native apps; Safari PWA can't run Tap to Pay).

## Mental model

- One-handed, thumb-driven, portrait
- Server pulls phone out → completes one task → puts it away
- Single-task focus per screen, fast switching between tasks
- Bottom sheets and full-screen wizards instead of side panels and modals
- Swipe-left for actions on list rows, long-press for context menus
- Search-first menu (typing on phone is faster than 4-level drill-in)

## Information architecture

Bottom tab bar always visible:

- 🏠 **Home** — quick actions + recent activity
- 📋 **Orders** — every order this server has open or recently closed
- 🪑 **Tables** — list of tables at the location, grouped by section
- ⚙️ **Me** — staff profile, end shift, settings, what's new

Plus a persistent floating "+" button for instant new-order entry from any tab.

## Screens

| # | Screen | Purpose | Existing store actions |
|---|---|---|---|
| 1 | MHome | "Take order" CTA, last 5 orders, my open tables | — |
| 2 | MOrdersList | Sectioned: My open · Sent waiting payment · Ready for delivery · Recently closed (reprint) | `tables`, `closedChecks`, `orderQueue` |
| 3 | MTablesList | Phone-friendly list, my section first, status pills + elapsed time | `tables` |
| 4 | MMe | Profile, end shift, BO link (phone-friendly subset) | — |
| 5 | MNewOrder | Order-type chips → routes to next screen | `setOrderType` |
| 6 | MCoversPicker | Big +/− wheel to pick covers count | `seatTable` |
| 7 | MTableView | Table header, items list, "Add items" CTA, bottom action bar (Send · Pay · ⋯) | `addItem`, `sendToKitchen` |
| 8 | MMenu | Search-first, recent / favourites, drill-in by category | `menuItems`, `menuCategories` |
| 9 | MItemDetail | Full-screen modifier flow, qty stepper, special-instruction text | `addItem` (with mods) |
| 10 | MCartSheet | Pulls up from any screen. Swipe-left on a line for: Discount · Void · Comp · Move seat · Course | `applyItemDiscount`, `voidItem`, `compItem`, `setItemCourse` |
| 11 | MOrderActions | ⋯ menu: Apply order discount · Order note · Split bill · Print docket · Transfer table · Add diner | `applyOrderDiscount`, `splitCheck`, `transferTable` |
| 12 | MTender | Card · Pay at counter · Split. Tip preset before card | `recordWalkInClosed`, `recordClosedCheck` |
| 13 | MCardFlow | Tap to Pay (Phase 1B) / assigned reader REST / simulated | `stripe-process-payment-on-reader` |
| 14 | MPayAtCounter | "Send to counter for cash payment?" → routes to order queue with status `pending_cash` | `order_queue` insert |
| 15 | MReceiptPrompt | Email · Print at station · None. Capture email if missing | `sendReceiptEmail`, `routePrintJob` |
| 16 | MOrderDetail | Same actions as MTableView + "Reprint receipt", "Refund" (manager PIN) | `refundOrder` |
| 17 | MManagerPin | PIN sheet for actions requiring manager auth | `staffMembers` permissions |
| 18 | MDone | Paid confirmation, "Take next order" | — |

Screens that produce phone-specific behaviour (no desktop equivalent):

- **Voice ordering** (Phase 2) — large 🎤 button on Menu / TableView. Web Speech API live transcript → Claude LLM parses against menu (`api/ai.js` reuse) → confirmation screen → adds via existing `addItem`. ~4 days.
- **Scan-to-deliver** (Phase 2 runner mode) — camera scans order ref off the docket → marks delivered.
- **Photo capture for delivery handoff** (Phase 2) — selfie cam, attaches to order.

## Gestures

- **Swipe-left on cart line** → action sheet (Discount, Void, Comp, Move seat, Course)
- **Long-press on cart line** → quick comp/quick void with manager PIN
- **Pull down to refresh** on any list (tables, orders)
- **Swipe between courses** in firing screens
- **Tap-and-hold on Send** → "Send + print only kitchen, hold bar" advanced

## Device registration

MPOS pairs identically to POS via the existing pairing-code flow. The only addition is a new `defaultSurface = 'mpos'` value in `device_profiles`.

**BO changes (DeviceProfiles.jsx):**

```js
const SURFACES = [
  { id:'tables', label:'Floor plan', ... },
  { id:'pos',    label:'POS ordering', ... },
  { id:'bar',    label:'Bar tabs', ... },
  { id:'kds',    label:'Kitchen display', ... },
  { id:'mpos',   label:'MPOS (mobile)', icon:'📱', desc:'Phone or Sunmi handheld for servers and runners' },
];
```

**MPOS-specific profile fields** (new columns on `device_profiles` table):

| Field | Type | Default | Purpose |
|---|---|---|---|
| `runner_mode` | bool | false | Restricts UI to delivery-handoff flow only |
| `payment_mode` | text | `'tap_to_pay'` | `tap_to_pay` \| `assigned_reader` \| `pay_at_counter_only` |
| `assigned_reader_id` | uuid \| null | null | Optional fixed Stripe reader for this device |

`assigned_section`, `enabled_order_types`, `default_order_type` already exist — reuse.

**App boot:** identical flow to POS. After PairingScreen completes, the device fetches its profile, sees `default_surface === 'mpos'`, boots into `MPOSSurface`. URL `?mode=mpos` is supported but the device profile takes precedence (matches kiosk pattern at App.jsx:3551).

## Permissions / manager PIN

Reuses the existing `staff_members.permissions` array + `requiresManager` pattern from `DiscountModal.jsx:10`. Same actions require manager auth on MPOS as on desktop:

- **Comp 100%** — always
- **Void item after send** — manager
- **Refund any** — manager
- **Discount > 20%** — manager
- **End shift** — own permissions check (existing `eod`)

When an MPOS user triggers a managed action, `MManagerPin` slides up as a bottom sheet, manager taps name + enters PIN, action proceeds. PIN session lasts 90s for follow-up actions (so a manager doesn't re-enter for each line in a void-spree).

## Receipts (digital-first)

**Default**: email. Phone is a digital-native device — print is the exception, not the rule.

### Infrastructure (provider-agnostic — no provider chosen yet)

New abstraction so any provider can be plugged in later:

- **Edge function** `send-receipt` (new) — accepts `{ to, subject, html, location_id, check_id }`, dispatches via the configured provider
- **Provider adapter** lives in the edge function — initially a stub that logs + writes to `receipt_emails` table; flip to real provider (Resend / Postmark / SendGrid / SES / Mailgun) by changing one env var when picked
- **Schema**: new `receipt_emails` table for delivery audit (id, location_id, check_id, to_email, status, sent_at, provider_id, error)
- **Template**: HTML receipt template renders from the same data the print path uses (`buildReceiptModel`) — single source of truth
- **Customer email field**: reuses existing `customers.email` from CRM; captured at MReceiptPrompt if missing
- **Compliance**: VAT receipts require itemised tax — already in the receipt model

### Print fallback

When a customer wants paper, MPOS calls `routePrintJob` for the location's receipt printer (network-attached, served by master POS). The phone never holds a printer connection itself.

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| **1A** | Spec + device-kind (BO surface enum + profile fields) + scaffold (bottom nav + Home + Orders + Tables list + Me) | 2 days |
| **1B** | Order-taking flow (NewOrder → CoversPicker → TableView → Menu → ItemDetail → CartSheet → Send) | 4 days |
| **1C** | Tender flow (Tender → CardFlow REST + simulated, PayAtCounter, ReceiptPrompt with email infra, Done) | 3 days |
| **1D** | Order management (OrderActions ⋯ menu, swipe-left actions, ManagerPin, OrderDetail, refunds, recall) | 3 days |
| **1E** | Native shells: iOS Capacitor + Android (existing APK pattern, slimmed Tap to Pay artifact) | 5 days |
| **2** | Voice ordering, runner mode, scan-to-deliver, delivery photo capture, push notifications | ~7 days |
| **3** | Polish: accessibility (VoiceOver, Dynamic Type), gesture micro-animations, offline-aware UX, multi-language | ~5 days |

**Total Phase 1 (1A–1E)**: ~17 days. **Total Phase 1+2+3**: ~30 days.

## What stays untouched

- Zustand store actions — every store function keeps its current signature
- Realtime subscriptions, QueueSync, OfflineQueue
- All edge functions
- Print orchestrator + master/child failover
- Customer attribution / CRM
- Tax calculation (`calculateOrderTax`)
- Stripe Connect / billing layer

## What v5.5.59 (the minimal MPOS attempt) becomes

**Reverted on first commit of this spec.** The minimal MPOSSurface scoped only to walk-in + cash + simulated card was the wrong scope and would mislead anyone reading the codebase about what MPOS is meant to be. Replaced wholesale by the screens listed above.

## Open questions resolved

- ✅ Cash on MPOS: removed (no cash drawer on a phone)
- ✅ Runner mode: yes, same UI with `runner_mode = true` profile flag
- ✅ Receipt default: email (build provider-agnostic infra now, supplier picked later)
- ✅ Manager PIN: same actions as desktop, same permissions array
- ✅ Device pairing: same as POS, new `default_surface = 'mpos'`

## Files (final)

```
src/surfaces/MPOSSurface.jsx           — bottom-tab router, top-level state
src/surfaces/mpos/
  MHome.jsx
  MOrdersList.jsx
  MTablesList.jsx
  MMe.jsx
  MNewOrder.jsx
  MCoversPicker.jsx
  MTableView.jsx
  MMenu.jsx
  MItemDetail.jsx
  MCartSheet.jsx
  MOrderActions.jsx
  MDiscountPicker.jsx
  MTender.jsx
  MCardFlow.jsx
  MPayAtCounter.jsx
  MReceiptPrompt.jsx
  MOrderDetail.jsx
  MManagerPin.jsx
  MDone.jsx
src/lib/mpos/
  useBottomSheet.js     — drag-to-dismiss, snap points
  useSwipeActions.js    — swipe-left detection on list rows
  useThumbZone.js       — viewport split helper for one-handed reachability
supabase/functions/send-receipt/
  index.ts              — provider-agnostic email dispatcher
migrations/v5.5.60-mpos-device-profile.sql
migrations/v5.5.60-receipt-emails.sql
docs/MPOS-SPEC.md       — this document
```
