# Database fence, stage 1: the app contract

Branch `fix/database-fence-1` (from `main` at v5.9.8, 18 Sep 2026). This is the list of app changes the fence needs, written for the app agent who builds them. Every line number is `main` at 870ba2c8 (v5.9.8), checked by grep on 18 Sep.

The SQL is in `supabase/migrations`:

| File | Project | When |
|---|---|---|
| `20260919a_OPS_fence_1_safe_now.sql` | Ops | AFTER this release is on every till (fix round, 19 Sep: the release goes first). It creates every server function below. |
| `20260919b_OPS_fence_2_after_app.sql` | Ops | A full day after file A. It refuses to run until every active device reports `fence_v1` and holds its device secret, no unlinked device is switched on, no old customer page wrote `order_queue` for 24 hours, and at least one order went through `place_public_order` in 7 days. |
| `20260919c_PLATFORM_fence_1_safe_now.sql` | Platform | After this release and its edge functions (it closes `location_reader_settings` browser writes, so P2 must be live). |
| `20260919d_PLATFORM_fence_2_after_app.sql` | Platform | After P3 below is live. |

Peter runs every SQL file himself, outside service. The runbook is `docs/FENCE_STAGE_1.md`.

## Rules for this work

- **Tables must never be lost** (INVARIANTS.md, memory `feedback_tables_never_lost`). A refused write is NOT "no data": keep it, show the banner, send it again once the till is linked again.
- **Read the reconciler rules** before touching QueueSync, QueueReconciler or OfflineQueue (memory `project_queue_reconciler`). Nothing here changes those rules.
- Static imports only. No `loc-demo` writes. Money through `lib/currency.js`.
- Every new pure helper gets a `node --test` file (list at the end).
- Do not deploy, merge or run SQL. Peter does.
- The release must reach BOTH web addresses: `app.serv-os.app` (iOS shell, webshell apps) and `possystem-liard.vercel.app` (the Sunmi POS APK). Old Sunmi WebViews keep old code until reloaded (memory `reference_sunmi_webview_stale`), which is why file 2 checks every device itself.

## 0. Who is calling (identity key)

- **Till**: POS, bar, tables, MPOS, KDS, time clock, kiosk. An anonymous session bound to a `devices` row. After file 1 a row is trusted only when `bound_via` is set (a claim bound it).
- **Back Office**: a real login. Venue access is `user_locations` only, plus every venue for a verified super admin. `user_profiles.location_id` is now only "the venue Back Office opens on".
- **Host stand**: bookings or Tables Ready iPad, a `waitlist_devices` row. File 2 lets it write `active_sessions` and `table_reservations` of its venue.
- **Customer**: online, QR, catering, tracker. An anonymous session, or the raw anon key with no session. Never trusted by a table policy after file 2; only the functions in section 3.
- **Server**: edge functions on the service role. Unaffected by RLS.

## 1. The new server functions (created by file 1)

All return `jsonb` unless noted. `ok: false` always carries `reason` and a plain `message` you can show.

**Devices**

| Function | Who calls it | What it does |
|---|---|---|
| `claim_device(p_code text) returns uuid` | old code only | Kept for old WebViews. Same signature. NULL means not paired. |
| `claim_device_v2(p_code text)` | pairing screen, kiosk | Binds this session to the device with that live code. Returns `{ok, already_bound, device_id, location_id, name, type, status, profile_id, centre_id, receipt_printer_id, device_secret, location: {id, name, org_id, timezone}}`. `device_secret` is shown ONCE: store it. Reasons: `not_found`, `expired`, `already_paired`, `locked`. Codes are compared without spaces or dashes, in capitals. A code that is not in the server format (every code from before file A) always answers `not_found` ("no longer valid") and is never counted as a miss. There is no re-link by an old saved code any more: only the device secret re-links. |
| `reclaim_device(p_device_id uuid, p_device_secret text)` | boot, wake, after a 42501 | Re-links a till whose login changed. Reasons: `invalid`, `locked`. |
| `device_issue_secret()` | boot, once, on a till that is bound but has no secret | Gives an already paired till its secret, so grandfathered tills never need a code again. Reason: `not_bound`. |
| `device_status()` | boot, wake, after a 42501 | Read only: `{bound, device_id, location_id, status, name, has_secret}`. |
| `device_heartbeat(p_app_version text, p_caps text[], p_device_id uuid default null)` | every device, every 60 s | Updates last_seen, version and the capability list. Returns the same shape as `device_status`. File 2 waits for `p_caps` to contain `fence_v1` on every active device. `p_device_id` (fix round, A13): the device id saved locally; when this session is NOT linked to it the call is recorded, so file 2 can see a till or kiosk that is switched on but unpaired. |
| `issue_pairing_code(p_device_id uuid, p_force boolean default false)` | Back Office | Returns `{ok, code, expires_at}` (a 12 symbol server code shown `XXXX-XXXX-XXXX`, 60 minutes). For a device that is paired right now it returns `ok:false, reason 'paired'` unless `p_force` is true. A code is readable (devices.pairing_code) ONLY by Back Office of that venue and the super admin; a row holding a live code is hidden from everyone else, tills of the same venue included. A code any other writer puts on the row is replaced by a server code. |

**Customer pages**

| Function | Key the customer holds | What it does |
|---|---|---|
| `place_public_order(p_location_id uuid, p_order jsonb, p_check jsonb default null, p_proof_ids uuid[] default '{}')` | a session, and payment proofs | Writes the `order_queue` row (and the `closed_checks` row when paid). Returns `{ok, ref, paid, status, payment_unverified, track_token, tab_join_code, check_id, due_minor}` or `ok:false` with `reason` in `no_session, venue, source, ref, ref_taken, items, customer, total, rate, payment, tab_not_verified, tab_closed, tab_not_yours, locked`. A retry by the same session returns the first answer with `idempotent: true`. PAID IS DECIDED BY THE SERVER (fix round): the amount due is the largest of `p_order.total`, `p_check.total` and the value of the lines less the discounts the order declares (`p_order.discounts`, see C15); paid means card plus gift proofs cover it. The paid check books the verified card amount. Unproven: `payment_unverified`, `customer.payment_state = 'checking'`, `customer.payment_ref` and `payment_processor` set, the check kept for `verify_public_order_payment`. |
| `verify_public_order_payment(p_location_id uuid, p_ref text, p_proof_ids uuid[] default '{}')` | the session that placed the order, or a till or Back Office of the venue | For an order in `payment_state 'checking'`: counts the proofs named plus any proof of the payments its check names; when they cover the amount due it writes the kept paid check, marks the order paid and `payment_state 'verified'`. Returns `{ok, paid, check_id}`, `{ok: true, paid: false, due_minor, proven_minor}` while still unproven, or `reason` `not_found` / `no_check` (a pay later order: take payment on the till). |
| `confirm_public_order_payment(p_location_id uuid, p_ref text, p_note text default null)` | a till or Back Office of the venue (never a customer) | Staff saw the payment in the processor but no proof arrived: writes the kept check as paid (the card amount the order still needed), `payment_state 'confirmed_by_staff'`, and who confirmed it. Put it behind a manager PIN. |
| `settle_qr_tab(p_location_id uuid, p_payment_intent_id text, p_check jsonb default '{}', p_proof_ids uuid[] default '{}')` | the tab's card payment id, plus a capture proof | Marks the tab's rounds collected and writes ONE closed check for what was really captured. Returns `{ok, closed, check_id, booked, shortfall}`; `reason` in `no_session, missing, not_captured, already_closed`. |
| `order_track_row(p_location_id text, p_ref text, p_key text)` | tracking token, or the QR card payment id, or the last 4 phone digits (old links) | The tracker row: `ref, status, total, items, collection_time, is_asap, type, source, sent_at, updated_at, paid, payment_state, customer {delivery_mode, collection_at, tip, tableLabel, phone (last 4 only)}`. NULL when the key is wrong. 10 wrong keys per order per hour lock only that order's last 4 path; a token or payment id always works. |
| `order_track_check(p_location_id text, p_ref text, p_key text) returns boolean` | same | The gate only. |
| `qr_table_open_tabs(p_location_id text, p_table_id text)` | the table (QR code) | `[{tab_handle, tab_ref, table_label, opened_at, processor, total, rounds, has_join_code}]`. No payment ids, no names, no codes. |
| `qr_tab_rounds(p_location_id text, p_payment_intent_id text)` | the tab's card payment id (the opener's stash) | `{tab: {payment_intent_id, processor, stripe_account, payment_session_id, ryft_customer_id, ryft_payment_method_id, payment_method_id, pre_auth_amount, tab_ref, table_id, table_label, tab_join_code, has_join_code, opened_at}, rounds: [{ref, status, items, total, created_at, sent_at, location_id, customer: {tip, service_charge, tableId, tableLabel, round_ref, processor, pre_auth_amount, payment_intent_id}}]}` or NULL. `tab_join_code` only comes back to the tab's opener session or a member (fix round); anyone else who only holds the payment id gets `has_join_code`. Only rows with `tab_open` count as rounds (a pay now order never joins a tab). |
| `qr_tab_join(p_location_id text, p_tab_handle text, p_join_code text)` | the handle plus the 6 digit table code | `{ok: true, tab, rounds}` (same shape, with the code). Reasons: `wrong_code`, `locked` (8 wrong per tab per hour), `staff_only` (an old tab with no code), `no_tab`. Called WITH a session, it remembers this session as a member: its rounds need no code afterwards (C16). |
| `qr_table_tab_count(p_location_id text, p_table_id text) returns integer` | the table | Distinct open tabs, for sub numbering. |
| `catering_day_load(p_location_id text, p_date date)` | the venue | `table(order_count integer, order_value numeric)`. |

**Print agents**: `print_agent_claim(p_token, p_agent_id, p_limit, p_claim_seconds)` returns `{ok, jobs: [...]}` with the jobs it claimed; `print_agent_report(p_token, p_job_id, p_agent_id, p_status, p_attempts, p_error, p_next_retry_at)`; Back Office `issue_print_agent_token(p_location_id, p_label)` returns the key once; `revoke_print_agent_token(p_token_id)`.

**Payment proofs**: table `payment_proofs`, service role only. Columns `id, processor, payment_ref, kind (card, preauth, capture, gift, loyalty), location_id (Ops id as text), amount_minor, currency, verified_at, verified_by, used_by_ref, used_at, meta`, unique on `(processor, payment_ref, kind)`. Only the new edge function in C0 writes it.

## 2. Tills and pairing

Line numbers are `main`. "Refused" below means PostgREST error code `42501` (or an update that matched 0 rows on a row the till owns).

**A1. Never swap a till's identity (gap B1).** `src/lib/supabase.js:144-164` `ensureAuthToken()` signs in anonymously whenever `getSession()` returns null, which includes a refresh that failed on the network (auth-js keeps the session on disk but returns null). The fix is written and tested but was never committed: port `src/lib/authSession.js` and `src/lib/authSession.test.js` from Peter's main checkout (`/Users/peterroberts/Library/CloudStorage/Dropbox/POSUP/Claude Code/Test POS app/possystem/src/lib/`, uncommitted, v5.8.57) and make `ensureAuthToken` call `resolveAuthToken({ auth: supabase.auth, storage: localStorage, storageKey: 'rpos-auth', allowAnonymous: !isBackOfficeMode() })` and return its `token`. Keep the return shape (a token or null, never throws). Re-add its INVARIANTS.md paragraph. 3 of the 12 anonymous tills on the live database have a login that is newer than their pairing, so this really happens.

**A2. Boot re-link with a secret, not a code (gaps B8, G12, G23).** `src/lib/supabase.js:197-213` `_claimDevice()`:
1. `ensureAuthToken()`.
2. If `dev.deviceSecret` is set: `rpc('reclaim_device', { p_device_id: dev.id, p_device_secret: dev.deviceSecret })`.
3. Else: `rpc('device_status')`. If `bound` is true: `rpc('device_issue_secret')` and save `device_secret` into `rpos-device` as `deviceSecret`.
4. Else, if `dev.pairingCode` is set (tills paired before this release): `rpc('claim_device_v2', { p_code: dev.pairingCode })`; on `ok` save `device_secret`. Fix round: this NEVER works after file A (every code issued before it is retired and there is no re-link by code); see A15.
5. Delete the `select('pairing_code')` read at `:205` (after file 1 bound rows have no readable code).
6. Any refusal: dispatch `window` event `rpos-device-link-lost` with the reason (A7 shows the banner). On success dispatch `rpos-device-relinked` (A8 replays parked writes).
7. Then `rpc('device_heartbeat', { p_app_version: VERSION, p_caps: FENCE_CAPS })` (A10).
Keep `claimPairedDeviceOnBoot` and `whenDeviceClaimed` (`store/index.js:4829-4834` awaits it before a shift opens).

**A3. Pairing screen (gaps B1, B10).** `src/surfaces/PairingScreen.jsx`:
- Replace `:17-35` (the SELECT by code with `locations(*)` and the UPDATE before the claim) and `:41-46` (the best effort claim) with one call: `const { data, error } = await supabase.rpc('claim_device_v2', { p_code: clean })` after `await ensureAuthToken()`. If `error` or `!data?.ok`, show `data?.message || 'Pairing failed, try again'` and stop. Never pair locally when the claim failed (today a failed claim still pairs locally and leaves a silently untrusted till).
- Build `deviceEntry` (`:58-68`) from `data`: `id: data.device_id, name: data.name, type: data.type, locationId: data.location_id, locationName: data.location?.name, orgId: data.location?.org_id, profileId: data.profile_id, deviceSecret: data.device_secret`. Drop `pairingCode` (codes are single use now).
- `:74-86` KDS config uses `data.centre_id` (returned).
- `:147` `maxLength={12}` becomes `maxLength={16}`, and `clean` strips spaces (`code.replace(/\s+/g, '').toUpperCase()`); the server ignores dashes. Placeholder `XXXX-XXXX-XXXX`.
- `:55` `enforceTenantFence(data.location_id)` stays. If the new venue differs from `rpos-active-location` and `rpos-pending-checks` or the offline queue hold unsent work, flush them first (DataSafe reconcile) and warn before wiping (pairing map section 4.1).

**A4. Kiosk pairing and boot (gap G12).** `src/surfaces/KioskSurface.jsx`:
- `:59-111` `tryPair`: replace the SELECT by code (`:65-69`) and `claim_device` (`:84-89`) with `claim_device_v2`. Save `device_secret` to a new key `rpos-kiosk-secret` and add that key to `TENANT_FENCE_KEEP` in `src/lib/supabase.js:263-276`. The UPDATE at `:92-100` may stay for `session_token`, `last_seen`, `status: 'online'`, but drop `pairing_code: null` (the server already cleared it).
- `:41-55` `loadPaired`: on boot, if `device_status()` says not bound and a secret is stored, `reclaim_device(id, secret)`; if bound without a secret, `device_issue_secret()`.
- `:46-50` (gap B3): only clear the local pairing when the read SUCCEEDED and returned a row with `status === 'removed'`, or when `device_status()` succeeded and the device id no longer exists. A read error or a missing row is "unknown": keep the pairing and show the banner (A7).
- `src/surfaces/KioskApp.jsx:1086` (`last_seen` after every order): replace with `rpc('device_heartbeat', ...)`.

**A5. Never unpair on "can't read my row" (gap B3).** `src/App.jsx:651-670` `refreshDevice`: `.single()` returns `data: null` on a network error AND (after file 2) when RLS hides the row. Change to: `const { data, error } = await ...maybeSingle()`. If `error`: keep everything, `setDeviceValid(true)`, show the banner. If `!data`: call `device_status()`; only when that call succeeds and says the device was removed (or `reclaim_device` answers `invalid`) show the pairing screen; otherwise banner. Keep `status === 'removed'` as the only certain removal. The same at `:774` (`refreshDeviceProfile` already no-ops) and the realtime handler `:855-873`. The session token writes at `:654` and `:669` stay (a till may write its own `session_token`), but a refused token write must NOT lead to `setDeviceValid('kicked')`; show the banner instead.

**A6. Back Office device screens (gap B1, G3, P1).**
- `src/backoffice/sections/DeviceRegistry.jsx:162-183` `startPairing`: insert WITHOUT `pairing_code`, `.select().single()`, then `rpc('issue_pairing_code', { p_device_id: data.id })` and show `res.code` (`:182` `setPairingCode(code)` becomes `setPairingCode(res.code)`).
- `:204-219` `regenerateCode`: `rpc('issue_pairing_code', { p_device_id, p_force })`. When it answers `reason: 'paired'`, confirm "This till is in use. A new code disconnects it until it is paired again." and call again with `p_force: true`. Show `res.code` and `res.expires_at` ("valid for 60 minutes").
- `:22-23` delete `genCode` (Math.random, 90,000 values).
- `:450-453` shows `d.pairing_code` for unpaired rows: keep (the new code is readable by Back Office of that venue).
- `src/backoffice/sections/KioskRegistry.jsx:76-103` (insert: already shows `data.pairing_code` from the returned row; drop `pairing_code: code` and call `issue_pairing_code` after the insert, show its code) and `:105-118` (regenerate: `issue_pairing_code(id, true)` and show the returned code, not the one the browser made at `:115`). Delete `generatePairingCode` (`:26-31`).
- Since the fix round, file A already replaces a browser made code with a server code (and hides every live code from anyone but that venue's Back Office and the super admin); these changes make Back Office show the code that works.

**A7. The lapse banner (pairing map section 3).** New component mounted by every till surface (POS, bar, tables, MPOS, KDS, kiosk, clock). It shows, fixed and red: "This till is not linked to {venue}. Your open orders are safe on this till. Ask a manager to pair it again." Drive it from `device_status()` at boot, on `visibilitychange` (visible), on `online`, on `rpos-device-link-lost`, and on any write refused with code `42501` (add a hook in the Supabase error paths of SessionSync, QueueSync, OfflineQueue, DataSafe, printer.js, db.js). When `reclaim_device` succeeds it hides itself. Say plainly that hidden bar tabs come back after re-pairing (QueueReconciler hides confirmed rows after 3 empty reads, `src/sync/QueueReconciler.js:41`, `:94-101`).

**A8. Replay writes parked during a lapse (pairing map section 4.2).** `src/sync/OfflineQueue.js:16` parks a write after 5 failures (`:188-191`), and replay only runs on `online` or at boot (`:399-419`). Add: on `rpos-device-relinked`, reset `attempts` and `status` of items whose `lastError` is a permission error (42501, "row-level security", "permission denied") and replay them. Keep every existing guard (`before()`, `keep()`, the reconciler rules). Kitchen tickets and print jobs written during a lapse must arrive.

**A9. Tables never lost on an empty read (gap G23).** After file 2 a till with no link reads 0 rows from `active_sessions`, `order_queue`, `kds_tickets`. `SessionReconciler`, `MasterSync.forceSyncFromSupabase`, `QueueReconciler` and the KDS load (`src/surfaces/kds/KDSSurface.jsx:254-256`, which replaces the screen with an empty read) must treat an empty read while `device_status().bound` is false (or after a 42501) as "unknown", never as "no tables" or "no tickets". Pin it with a test.

**A10. Heartbeat everywhere.** One helper `deviceHeartbeat()` calling `rpc('device_heartbeat', { p_app_version: VERSION, p_caps: FENCE_CAPS })` every 60 s while visible, and on boot. `FENCE_CAPS = ['fence_v1', 'device_secret']`, and only when A1 to A9 are in the build. Replace `src/lib/db.js:1014-1021` `updateDeviceHeartbeat` (KDS, `src/surfaces/kds/KDSSurface.jsx:207`) and `src/surfaces/KioskApp.jsx:1086`; add it to POS, bar, tables, MPOS and the time clock boot. `src/surfaces/kds/KDSSurface.jsx:107` (`kds_settings` on its own row) needs no change.

**A11. `src/components/DevSwitcher.jsx:15`** reads every pairing code of the venue. It is mounted nowhere: delete the file.

## 3. Customer pages

**C0. New edge function `payment-proof`** (`supabase/functions/payment-proof/index.ts`, service role, `verify_jwt=false`, CORS like the others). Body: `{ ops_location_id, processor: 'stripe' | 'ryft' | 'adyen' | 'gift' | 'loyalty', kind: 'card' | 'preauth' | 'capture' | 'gift' | 'loyalty', payment_ref }`. It never trusts the body for money:
- **stripe**: find the venue's connected account from the Platform (`merchant_stripe_accounts` via `platform locations.ops_location_id`), `GET /v1/payment_intents/{id}` with `Stripe-Account`. Require `metadata.ops_location_id === ops_location_id`. `card`: status `succeeded`, amount = `amount_received`. `preauth`: status `requires_capture`, amount = `amount_capturable`. `capture`: status `succeeded`, amount = `amount_received`. Overage charges (`/api/stripe-charge-overage`) are `card` proofs of their own intent.
- **ryft**: fetch the payment session (same credentials as `ryft-tab` and `ryft-create-payment-session`); map `Approved` or captured to `card` or `capture`, an authorised hold to `preauth`; check the session's merchant is the venue's account.
- **adyen**: the online flow already calls Adyen from `adyen-checkout` (server side). Either write the proof there when the result is `Authorised` (and on `tab_capture` for `capture`), or look the psp reference up in the Platform `adyen_payments` table the webhook fills. Check the merchant account is the venue's.
- **gift**: read the Platform `gift_card_transactions` row whose `idempotency_key = payment_ref` (the `giftcommit:<checkId>:<card>` key `commitGift` returns), type redeem, for a card of the venue's company. Amount = the debit.
- **loyalty**: the loyalty ledger row for that idempotency key (points or stamp redemption). Amount = its money value.
- Upsert `payment_proofs` on `(processor, payment_ref, kind)` with `verified_by: 'payment-proof'` and return `{ ok, proof_id, amount_minor, kind }`. Never write a proof for a payment it could not see.
- Rate limit per caller (a session may ask for about 30 proofs in 10 minutes).

**C1. Online checkout, card (gaps B2, B3).** `src/surfaces/online/OnlineCheckout.jsx:1141-1300` `onPaymentSuccess`:
1. `payId` as today (`:1146-1148`).
2. `payment-proof` with `{ ops_location_id: opsLocationId, processor, kind: 'card', payment_ref: payId }`. Retry 3 times over about 5 s.
3. Build `queueRow` (`:1152-1180`) and `closedCheck` (`:1207-1254`) exactly as today, then ONE call: `rpc('place_public_order', { p_location_id: opsLocationId, p_order: queueRow, p_check: closedCheck, p_proof_ids: proofId ? [proofId] : [] })`. Remove the direct insert at `:1181` and `:1255`.
4. If `paid` is false (`payment_unverified`): the order still reached the kitchen as unpaid; tell the customer "Your order is in. The venue will confirm your payment." and log an activity event. Never drop the order: the money was taken.
5. The gift, promo and loyalty commits, stock depletion, attribution and delivery dispatch after it stay as they are.
6. `onPlaced` (`:1297`) also passes `trackToken: res.track_token` (gap B12).

**C2. Online checkout, gift only (gaps B3, B12).** `src/surfaces/online/OnlineCheckout.jsx:1011-1135` `onGiftOnlyPayment`: after `commitGift` succeeds (`:1019`), call `payment-proof` with `{ processor: 'gift', kind: 'gift', payment_ref: giftCommit.idempotency_key }`, then `place_public_order` with `queueRow` (`:1033-1056`) and `closedCheck` (`:1066-1105`) and the proof id. Remove `:1057` and `:1106`. If the reward covers the whole bill with loyalty only, run `redeemLoyaltyAfterOrder` BEFORE placing and send a `loyalty` proof (a zero total check needs a gift or loyalty proof to count as paid). `onPlaced` (`:1130`) passes `trackToken`.

**C3. Tracker (gaps B12, G6).** `src/surfaces/online/OnlineSurface.jsx:1004-1008`: keep `info.trackToken` in state next to `trackerRef`, and pass `trackKey={trackToken}` to `OrderTracker` (`:733`). `:713` (QR close jumps to the tracker) passes the tab's `payment_intent_id` as the key.
`src/surfaces/online/OrderTracker.jsx`:
- `:44-52` poll: `rpc('order_track_row', { p_location_id: locationId, p_ref: orderRef, p_key: trackKey })` every 5 s. NULL means "not found or wrong key": keep the last good state.
- `:78-94` realtime channel on `order_queue`: remove (after file 2 a customer receives nothing from it, and today it pushes every order of the venue, customer blocks included, to any phone).
- `:330-345` `ShareLink`: link `?track=REF&t=TOKEN`; keep reading old `?p=LAST4` links.
`src/surfaces/online/OnlineSurface.jsx:214-240` (`?track=` gate): `rpc('order_track_check', { p_location_id: opsLocationId, p_ref: trackRef, p_key: t || p })`, keep the key for the tracker.

**C4. QR, open tabs at the table (gaps G4, G17).** `src/surfaces/online/OnlineSurface.jsx:137-179`: `rpc('qr_table_open_tabs', { p_location_id: opsLocationId, p_table_id: String(tableId) })` returns handles, not payment ids. `tableTabs` holds `{tab_handle, tab_ref, table_label, opened_at, processor, total, rounds (a count), has_join_code}`; nothing else.
**C5. QR, resume my own tab.** `:183-200`: `rpc('qr_tab_rounds', { p_location_id: opsLocationId, p_payment_intent_id: stashed.payment_intent_id })`. NULL means the tab is closed: clear the stash. Use `result.tab` for the tab fields and `result.rounds` for the rounds.
**C6. QR, join someone's tab (gap G5).** `:672-690` `JoinTabScreen` `onJoin`: make it async and call `rpc('qr_tab_join', { p_location_id: opsLocationId, p_tab_handle: openTabAtTable.tab_handle, p_join_code: code })`; on `ok`, `enterTab({ ...result.tab, rounds: result.rounds })`; show `result.message` otherwise. `onSettleTab` (`:652-664`) matches the opener by comparing `md5` is not possible in the browser, so compare the stash's `tab_ref` with the tab's `tab_ref` instead. `src/surfaces/qr/JoinTabScreen.jsx:25` awaits `onJoin`; `:55` keeps `inputMode="numeric"` (codes are 6 digits); `:69-74` enable at 4 or more digits (old tabs have 4 digit codes). `hasCode` comes from `has_join_code`.
**C7. QR, table sub number.** `src/surfaces/qr/QrCheckout.jsx:367-390`: `rpc('qr_table_tab_count', { p_location_id: opsLocationId, p_table_id: String(tableId) })`, then `subNum = count + 1`.
**C8. QR, pay now or open a tab.** `src/surfaces/qr/QrCheckout.jsx:347-555` `onPaymentSuccess`:
- `payment-proof` with `kind: 'preauth'` for an open tab, `kind: 'card'` for pay now (Stripe `payId`, Ryft session id, Adyen psp reference).
- One `rpc('place_public_order', { p_location_id: opsLocationId, p_order: queueRow, p_check: tabMode ? null : closedCheckRow, p_proof_ids })`. Remove the inserts at `:459` and `:474`.
- The table code comes back as `res.tab_join_code` (6 digits, made by the server). Use it in the stash (`:528`) and in `onPlaced` (`:551`) instead of `tabJoinCode`; delete the Math.random code (`:96-103`) and stop sending `tab_join_code` in `customer` (`:421`; the server ignores it anyway).
- Delete `syncQrTableSession(...)` at `:549`: after file 2 a trigger keeps the floor plan.
**C9. QR, add a round.** `src/surfaces/qr/QrCheckout.jsx:222-265` `addToExistingTab`: one `rpc('place_public_order', { p_location_id: opsLocationId, p_order: queueRow })` (the tab's card payment id is in `customer.payment_intent_id`). On `reason: 'tab_not_verified'` (a tab opened before this release has no hold proof) call `payment-proof` with `kind: 'preauth'` for that payment id and retry once. `reason: 'tab_closed'` means start a new order. Delete `:257` `syncQrTableSession`.
**C10. QR, close and pay (gaps G16, G17).** `src/surfaces/qr/TabResumeScreen.jsx:36-189`: the capture calls (`:49-79`) and overage calls (`:81-131`) stay. Then `payment-proof` with `kind: 'capture'` and `payment_ref` = the tab's `payment_intent_id` (Ryft: the session id; Adyen: the psp reference), plus a `kind: 'card'` proof for an overage intent, then `rpc('settle_qr_tab', { p_location_id: locId, p_payment_intent_id: tab.payment_intent_id, p_check: { table_label }, p_proof_ids: overageProofIds })`. Remove `:136-147` (direct update) and `:149-179` (direct insert). The closed check now books what was captured; a shortfall is recorded for staff.
**C11. Catering.** `src/surfaces/catering/CateringCheckout.jsx:226-240` `placeLater`: `rpc('place_public_order', { p_location_id: opsId, p_order: cateringRow })` instead of `:232`. `:260-300` `finalizeNow`: `payment-proof` (`kind: 'card'`), then one `place_public_order` with `cateringPaidRow` and `closedCheck`; remove `:270` and `:286`. `src/surfaces/catering/CateringSurface.jsx:131` and `:217`: `rpc('catering_day_load', { p_location_id: opsId, p_date })` and read `order_count` and `order_value` (they summed `total` of non cancelled rows).
**C12. Busy time.** `src/lib/prepTime.js:150-160`: delete the fallback that reads `active_sessions`, `bar_tabs` and `order_queue` directly; `online_kitchen_load(text)` is live.
**C13. Sessions first.** Every customer write path calls `ensureAuthToken()` (or `signInAnonymously`) before `place_public_order` and `settle_qr_tab` (they need a session). The tracker and QR reads work without one.
**C14. Old tab screens.** A customer tab opened before this release: C5 and C10 work (payment id stash). Joining by phone works only if it had a 4 digit code (checked on the server now); otherwise `staff_only`.

## 4. Staff paths that touch the same rows

**S1. `src/lib/qrTableSession.js:20-97`** is still used by the Orders Hub force close (`src/surfaces/OrdersHub.jsx:713`). Its upsert at `:88` overwrites a table's session even when a till owns it (a tables never lost risk). Change it now to skip the upsert and the delete unless the existing session has `source === 'qr'` (the server version in file 1 does exactly this). After file 2 remove the call at `OrdersHub.jsx:713`: the `order_queue_qr_floor` trigger does it.
**S2.** Till, kiosk, KDS and Back Office writers of `order_queue`, `kds_tickets`, `print_jobs`, `active_sessions`, `table_reservations`, `bar_tabs`, `closed_checks` need NO code change: they pass as a paired device or a Back Office login of the venue (list in section 7). They DO need A7 to A9 (banner, replay, empty read is unknown).

## 5. Print agents (gap G24)

**G1. `print-agent.js`.** `:44-45` read `PRINT_AGENT_TOKEN` (and keep `LOCATION_ID` only for logs). Replace `atomicClaim` (`:213-229`) and `drainEligible` (`:299-318`) with `rpc('print_agent_claim', { p_token, p_agent_id: AGENT_ID, p_limit: 20, p_claim_seconds: CLAIM_TTL_MS / 1000 })`; replace every `print_jobs` update (`:80`, `:252`, `:257-260`, `:273-277`, `:282-286`) with `rpc('print_agent_report', { p_token, p_job_id, p_agent_id, p_status, p_attempts, p_error, p_next_retry_at })`. The realtime INSERT and UPDATE subscriptions (`:333-366`) receive nothing once file 2 closes the table to the anon key: poll every 2 s instead. The broadcast fast path (`:374-426`) may stay, but its `print_jobs` upsert at `:403` becomes `print_agent_report` with status `printed` for that job id (the till writes the row itself). `printer_agents` and `printer_health` writes are stage 2 tables and keep working for now. Update `print-agent.env.example`.
**G2. `rpos-print-agent.js`.** `:19-21` has the anon key HARDCODED in git (INVARIANTS: the anon key never appears in git): read it from the environment. `:40-70` move to the same two functions with `PRINT_AGENT_TOKEN`.
**G3. Back Office.** A "Print agent key" button (Production printing screen) calling `issue_print_agent_token(p_location_id, p_label)`, showing the key once, with Revoke (`revoke_print_agent_token`).
On 16 Sep no venue ran a print agent; the master till's PrintOrchestrator is a till and needs nothing.

## 6. Platform (the browser is always the raw anon key there)

**P2. Card reader settings (before 20260919d).** Add action `save_reader_settings` to `supabase/functions/location-admin/index.ts` next to `save_location` (`:422`), behind the same `authed()` fence (`:371`), taking the Platform location id and a whitelist: `tipping_enabled, tip_percentages (1 to 5 integers between 1 and 99), allow_custom_tip, smart_tip_threshold_minor, idle_screen_enabled, idle_screen_image_url`; upsert on `location_id`. Then `src/backoffice/sections/CardReaders.jsx:812-819` calls it (the Stripe sync call after it stays), and `src/backoffice/sections/PaxTerminals.jsx:469-473` calls it with only `idle_screen_image_url`. Reads (`CardReaders.jsx:786`, `:836`, `PaxTerminals.jsx:182`) stay direct.
**P3. Online gift purchases (before 20260919d).** Add action `purchases` to `supabase/functions/gift-list/index.ts` that returns the columns `GiftCards.jsx` shows (`id, amount_minor, currency, sender_name, sender_email, recipient_name, recipient_email, delivery_type, status, code_last4, created_at, fulfilled_at`; NOT `fulfilled_code`) for the caller's company, and ONLY for staff of that company: `gift-list` today accepts any JWT (`authenticateCaller`), which is the "any JWT is not authority" hole (memory `reference_edge_fn_any_jwt_authority`). Mirror `user_accessible_locations()`: a Back Office login linked to a venue of that company, or a super admin (the parked branch `fix/loyalty-giftcard-exposure` has `_shared/staffAccess.ts` for this). Then `src/backoffice/sections/GiftCards.jsx:1264-1270` calls it. `supabase/functions/gift-resend/index.ts:113-125` reads the code from `gift_cards.code_plain` (by `gift_card_id`) instead of `gift_card_purchases.fulfilled_code`; `supabase/functions/gift-fulfill/index.ts:345-356` stops writing `fulfilled_code` (keep `code_last4`).

## 7. Writers that need no change (already fine)

- **Back Office logins of the venue** (user_locations, or super admin): `DeviceRegistry.jsx` edit and delete (`:222-260`), `KioskRegistry.jsx:121`, `LocationSettings.jsx:300`, `PrintRouting.jsx:101`, `AdyenTerminals.jsx:532`, `TaxManager.jsx:557`, `:583`, `MenuManager.jsx:3893` and `lib/db.js:1142` (`saveQuickScreenIds`), `PrintMenu.jsx:154`, `ReceiptBranding.jsx:149`, `lib/orderScreen/orderScreenData.js`, `CateringOrders.jsx:41`, `tablePlanDb.js:96-98`, `BackOfficeApp.jsx:1211`, `:1215`.
- **Company Admin** (`CompanyAdmin.jsx:61-148`): keeps working. A new company and its first venue are stamped with `created_by` by the server, and the creator's self claim (`:133`) checks that instead of the profile company.
- **LocationSwitcher** (`LocationSwitcher.jsx:134`), **StaffManager** (`:69`, `:283` own venue; `:101-110` teammate emails; `:408` teammate Back Office access): keep working for venues the login is linked to (or any venue for the super admin). A manager cannot switch an owner's access; nobody can switch their own.
- **Admin portal** (`src/admin/CompanyAdminApp.jsx`): super admin session, unaffected. Without a session its anon fallback now fails on these tables (sign in first).
- **Paired tills, kiosks and KDS of the venue** (device arm): `QueueSync.js:265`, `:484-521`, `store/index.js:3042`, `:3112-3124`, `:3721`, `:3888`, `:3936`, `:7167`, `:7277`, `:7404-7409`, `:7469-7534`, `:7663`, `:7822`, `OrdersHub.jsx:432`, `:615`, `:631`, `:815`, `KDSSurface.jsx:223-493`, `lib/db.js:608-699`, `:833-913`, `DataSafe.js:51-167`, `MasterSync.js:167-168`, `SessionSync.js:213-369`, `SessionReconciler.js:44-92`, `ReservationSync.js:64-115`, `printer.js:553-704`, `PrintOrchestrator.js:229-646`, `PrintRetrier.js:151-291`, `StatusDrawer.jsx:56-272`, `KioskApp.jsx:960`, `:967`, `:1018`, `CheckoutModal.jsx:1154`, `:1366`.
- **Host stands** (`waitlist_devices`): `store/waitlistSlice.js:190`, `BookingsSurface.jsx:133`, `SessionSync.flushSingleSession` from `bookingsSlice.js` and `waitlistSlice.js` (file 2 gives them `active_sessions` and `table_reservations` of their venue). `lib/waitlist/waitlistData.js:236` reads `closed_checks`, which a host stand could never read (unchanged, stage 2).
- **Edge functions** (service role): order-notify, catering-release, hubrise, ezcater, adyen and ryft webhooks, tip capture, send-receipt, stock-deplete, booking-widget, owner and manager snapshots.
- **Order screens**: `order_status_feed()` only. File 2 turns on `order_status_names_enabled()`, so first names start showing (INVARIANTS: after a status change in a separate request).

## 8. Tests to add (`npm test`)

- `authSession.test.js` (port it, A1).
- Pairing: code normalising (spaces, dashes, case), `claim_device_v2` result mapping to `rpos-device`, "error or empty is unknown, only removed is removed" (A3, A5).
- Lapse: the banner decision from `device_status` and 42501; OfflineQueue releasing parked permission errors on `rpos-device-relinked` without breaking `before()` and `keep()` (A7, A8).
- Empty read while unlinked never clears tables, orders or KDS tickets (A9), pinned next to `queueReconcile.test.js`.
- Customer: building `p_order` and `p_check` from the existing rows (same keys as today), `payment_unverified` handling, tracker key choice (token, payment id, last 4), QR table code handling (C1 to C11).

## 9. What `fence_v1` means

A device may send `p_caps` containing `fence_v1` only when its build has A1 to A10. File 2 checks every active device for it, because a till on old code would wipe its pairing (B3) or lose tickets (G23) once the tables close. After this release is deployed: check the Network Status screen (or the runbook query) until every active device shows the new version, then Peter runs file 2.

## 10. Built (app release, 18 Sep 2026) and the stage 1 cleanup list

**Order of release.** The app release works BEFORE and AFTER file 1: every new server call falls back to today's path when PostgREST answers "function not found" (PGRST202 / 42883), or when an edge function or action is not deployed yet. Since the fix round (19 Sep) the release MUST go first and be on every till before file 1: file 1 retires every old pairing code and hides live codes, so a till still on the old app can neither re-link after a login change nor pair at all. File 2 (and Platform file D) still come last, as the runbook says.

**Where the rules live.** Pure, tested: `src/lib/deviceFence.js` (tills), `src/lib/publicOrder.js` (customer pages), `supabase/functions/_shared/paymentProofRules.js` (C0), `_shared/readerSettingsPatch.js` (P2), `_shared/companyStaffAccess.js` (P3). Wiring: `src/lib/supabase.js` (`linkDevice`, `sendDeviceHeartbeat`), `src/lib/deviceLink.js` (link state, monitor, heartbeat), `src/components/DeviceLinkBanner.jsx`, `src/lib/publicOrderClient.js`, `src/lib/readerSettingsClient.js`, `src/backoffice/sections/PrintAgentKeys.jsx`.

**Not done as written, and why**

- `KioskApp.jsx` `last_seen` after every order (A4, A10) is NOT replaced: it sits inside `submitOrder`, which `kioskCardPathGuard.test.js` freezes (Peter's card path reliability bar). The bound kiosk may still write its own `last_seen` under the file 1 trigger, and `DeviceLinkBanner` sends `device_heartbeat` (with `fence_v1`) every 60 s on the kiosk.
- `syncQrTableSession` calls in `QrCheckout.jsx` (C8, C9) and `OrdersHub.jsx` (S1) are KEPT until file 2: removing them before the `order_queue_qr_floor` trigger exists would take QR tabs off the floor plan. They now only ever write or remove a QR owned session (S1), so no till session can be overwritten.
- Adyen proofs (C0) read the Platform `adyen_payments` ledger the webhook fills; `adyen-checkout` was not changed (money path). A webhook that lands after the ~12 s proof retry places the order unpaid and `payment_unverified` (staff confirm), never drops it. The webhook marks `capture_required` only when the notification says PreAuth, so an uncaptured Adyen authorisation with `capture_required` null counts as a hold proof (otherwise online Adyen QR tabs could not open), and the same row counts as a card proof. A customer holding a real authorisation at the venue could therefore present an online Adyen tab hold as a pay now payment; closing that fully needs adyen-checkout to write the proof itself (`kind` known at payment time), left for stage 2.
- Loyalty proofs record amount 1 (a marker): the loyalty ledgers hold points, not money. Enough for `place_public_order`, which only needs a gift or loyalty proof above zero for a zero total check.
- Back Office can revoke only print agent keys issued from that browser (it remembers ids, never keys): file 1 has no list function for `print_agent_tokens`.
- Online gift purchases through `gift-list` no longer carry `fulfilled_code` (P3), so the Back Office list shows the last 4 digits and no Voucher button for them.
- **SQL note (fixed in the fix round):** `place_public_order` now keeps a paid catering check's `closed_at` from the page (the event time, within a year ahead), like the old catering path; every other public check is dated now.

**STAGE 1 CLEANUP (after 20260919b has run on Ops, and D on Platform).** Delete every branch tagged `FENCE STAGE 1 FALLBACK` (grep the tag): `runDeviceLink` legacy branch and `linkDevice` `readLegacyCode` / `saveLegacyCode`; `decideDeviceRefresh` statusSupported false branch; `PairingScreen.legacyPair`; `KioskSurface.legacyKioskPair` and the loadPaired no-row probe; `DeviceRegistry.genCode` / `KioskRegistry.generatePairingCode` and their `legacyIssue`; `updateDeviceHeartbeat` direct write; `placePublicOrderWithFallback` legacy and `proofUnavailable` branches and every `legacyInsert` / `legacySettle` / `publicRead` legacy read in the customer pages; the legacy mode of both print agents; `saveReaderSettingsWithFallback` legacy write; the `GiftCards.jsx` direct purchases read. Also remove the `syncQrTableSession` calls in `QrCheckout.jsx` (2) and `OrdersHub.jsx` (1), and the device `pairingCode` field from old `rpos-device` records.

## 11. Fix round (19 Sep 2026): app changes the new SQL needs

Three reviewers checked stage 1; the SQL was fixed on this branch (files A to D, harness `supabase/tests/fence_stage_1`, runbook). What changed in the SQL, in one line each:

- **Devices**: a device's venue is pinned (moves only by super admin or a Back Office login of BOTH venues, and a move unpairs it); only the claim functions link a device; a linked till writes only its heartbeat columns.
- **Codes**: readable only by that venue's Back Office and the super admin, even in file A; every old code is retired; there is no re-link by an old saved code at all (device secret only); throttles never refuse a live code.
- **Paid**: decided by the server from the order's own amount due and verified money; an unproven order is `payment_state 'checking'` with its check kept for `verify_public_order_payment` or `confirm_public_order_payment`.
- **QR tabs**: only the opener, a member (joined with the code) or a round carrying the code may add a round; a pay now order never carries another tab's payment id.
- **Order of release**: this release goes FIRST, on every till, then file A.

Everything below is for the app agent. Each item names the file and the line on this branch.

**Tills**

- **A12. Parked writes after a re-pair.** After "Pair again" (or any pairing) the page reloads and the boot link answers `linked`, not `relinked`, so `rpos-device-relinked` never fires and OfflineQueue keeps permission refused writes (for example bar tab writes made while unlinked) parked for good. Release them on `rpos-device-linked` as well (`src/sync/OfflineQueue.js`, next to the `rpos-device-relinked` listener at `:431`). DataSafe needs nothing: it resends kept sales at boot and every 30 s. Test: a parked permission item is released on `rpos-device-linked`, and `before()` / `keep()` still hold.
- **A13. Heartbeat names the device.** `sendDeviceHeartbeat` (`src/lib/supabase.js:267`) passes `p_device_id: readLocalDevice()?.id` (the kiosk its kiosk id). File B refuses to run while a device that is not linked is switched on (a kiosk that would take money it can no longer save), and this is how it knows.
- **A14. The version is visible before file A.** When `device_heartbeat` does not exist yet (`unsupported`), `deviceHeartbeat()` in `src/lib/deviceLink.js` writes `devices.app_version` and `last_seen` on its own row directly, for POS, bar, tables, MPOS, clock and kiosk (the KDS already does this in `src/lib/db.js` `updateDeviceHeartbeat`). The runbook's step 2 query reads it to prove every till is on the release before file A. FENCE STAGE 1 FALLBACK.
- **A15. Saved pairing codes are dead.** After file A every code issued before it is retired and there is no re-link by code, so `runDeviceLink` step 3 (`claim_device_v2` with `dev.pairingCode`) and `readLegacyCode` / `saveLegacyCode` can never succeed. Once `device_status` is supported, delete `pairingCode` from `rpos-device` and skip step 3. Harmless meanwhile: the server answers an old format code `not_found` and never counts it as a miss.
- **A16. Old WebViews cannot pair after file A.** The old pairing screen reads the code off the devices table, and codes are hidden now. No change in this release can fix an old build; the runbook says force stop and reopen. Nothing to build.

**Customer pages**

- **C15. Online order total and declared discounts** (`src/surfaces/online/OnlineCheckout.jsx` `queueRow` at `:1045` and `:1212`):
  - `total` must be what the customer is charged across card and gift card: `(remainingMinor + giftAppliedMinor) / 100` (net of the promo code and the loyalty reward; auto discounts are already net).
  - Add a top level `discounts` to `p_order`: `[{type: 'auto', label, amount_minor}]` for each auto discount, `{type: 'promo', label: code, amount_minor: promoAppliedMinor}`, `{type: 'loyalty', label: reward name, amount_minor: rewardDiscountMinor}`. The server subtracts them from the value of the lines and writes the result into `customer.order_pricing` for staff to see.
  - The card path must redeem the loyalty reward BEFORE placing and attach its `loyalty` proof, as the gift only path does (`:1075`): a declared loyalty discount counts only with a redemption proof.
  - The card path must also send the gift card proof (`payment-proof` kind `gift` with `giftCommit.idempotency_key`, after `commitGift` at `:1252`), as the gift only path does (`:1090`): card plus gift must cover the order total.
  - Without these, every order with a gift card, a promo code or a reward arrives "Payment being checked" (safe, but staff must confirm each one). A promo that covers the whole bill has no payment to prove at stage 1 and always arrives "Payment being checked".
- **C16. QR rounds and joining** (`src/surfaces/qr/QrCheckout.jsx:222-265` `addToExistingTab`, `src/surfaces/online/OnlineSurface.jsx` `JoinTabScreen` `onJoin`):
  - Stop stripping the code: send `p_order.tab_join_code` = the tab's code (the stash's `tab_join_code`, or `tab.tab_join_code` from `qr_tab_join`).
  - Call `ensureCustomerSession()` BEFORE `qr_tab_join`, so the server remembers this phone as a member.
  - Handle `reason: 'tab_not_yours'` ("Ask the person who opened this tab for the table code") and `'locked'`.
  - `qr_tab_rounds` returns `tab_join_code` only to the opener and members; the resume screen keeps reading the code from the stash.
- **C17. "The venue is confirming your payment".** After `place_public_order` answers `payment_unverified`, keep checking in the background for about 3 minutes: `payment-proof` again for the same payment, then `verify_public_order_payment(p_location_id, ref, [proof_id])`. Show "Your order is in. The venue is confirming your payment." and the same in the tracker while `order_track_row` says `payment_state: 'checking'`. Never ask the customer to pay again.
- **C18. payment-proof binds a payment to its order** (`supabase/functions/payment-proof/index.ts`, `_shared/paymentProofRules.js`): record the processor's own order reference in `meta.order_ref` (Stripe `payment_intent.metadata.ref`, which every customer page already sets; Adyen the `merchantReference` in `adyen_payments.raw`; Ryft the session metadata when it has one). The server then never lets a payment made for one order pay another. For a loyalty redemption with a fixed money value (`reward_value.amount_minor`), record that value as `amount_minor` (the server caps a declared loyalty discount at it); otherwise keep the marker 1.
- **C19. `reason: 'payment'`.** A QR order with no payment (not a tab, no check) is refused. No current flow sends one; show the message if it happens.

**Staff**

- **S3. "Payment being checked" in the Orders Hub** (`src/surfaces/OrdersHub.jsx` `isOrderPaid` at `:85`, the charge step at `:1582`): an order with `customer.payment_state === 'checking'` is neither paid nor unpaid.
  - Show an amber "Payment being checked" badge. Never offer the charge step or "take payment" for it (today an unverified QR or catering order looks unpaid and invites a second charge; an unverified online order looks paid and never gets its closed check).
  - "Check payment": `payment-proof` with `customer.payment_processor`, `customer.payment_ref`, kind `card`, then `verify_public_order_payment` with the proof id.
  - "Confirm payment" (manager PIN): `confirm_public_order_payment` with a note.
  - Both write the kept paid check for reports. Pin it with a test (a helper that answers 'paid', 'unpaid' or 'checking').
- **S4. INVARIANTS.md** ("Database fence stage 1"): add that a device's venue never changes while it is linked (moving it unpairs it); pairing codes are readable only by that venue's Back Office and the super admin; "paid" on a public order is decided by the server from verified money against the amount due; `payment_state 'checking'` is a third state that is never charged again.

