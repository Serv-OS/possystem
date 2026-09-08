# PRE-STAGE READINESS AUDIT — 4 Aug 2026 (v5.5.973)

Five parallel auditors verified against the LIVE databases and the repo — not against docs or comments.
Where documentation disagreed with the database, the database won.

**Context:** dev only, no live customer data. Breaking changes are cheap NOW and expensive after staging.

## Already fixed during this audit
- **Privilege escalation CLOSED** — `handle_new_user()` minted `super_admin` from client-supplied metadata; anyone with the public anon key could self-promote, and 38 policies across 33 tables honour `is_super_admin()`. Migration `20260721d` (written 21 Jul) was never applied. Applied + verified today. Forensics: 1 super_admin, non-anonymous (owner). No exploitation.
- **Edge-function drift cleared** — 7 functions were committed-but-not-deployed (2 genuinely stale: 18 days and 5 days). All redeployed; deployed now matches committed.

## Scoreboard — 65 findings

| Severity | Count |
|---|---|
| blocker | 20 |
| high | 22 |
| medium | 17 |
| low | 6 |


---

# BLOCKER (20)

## 1. Platform DB has no tenant fence and cannot be fixed by SQL — platformSupabase runs as raw anon

- **Owner:** both  · **Effort:** 1-2 days (app rework: 17 write sites) + 2 hours SQL

src/lib/supabase.js:20 creates platformSupabase with persistSession:false, so all reads and 17 browser writes hit the platform DB as the raw anon role. That is why every platform policy is USING(true). Live consequences: locations_anon_update (UPDATE, public, true/true) lets any anon-key holder rewrite any venue's ops_db_url, payment_processor, currency, qr_service_charge_pct and online_slug; anon SELECT true exposes user_access (emails+roles), billing_invoices/billing_state (every merchant's GMV and fees), merchant_stripe_accounts (+your markups), companies, payment_devices (serials, registration_code, IPs); authenticated SELECT true exposes platform_settings including ryft_cost_percent (your cost basis); ALL true on customer_loyalty, loyalty_config/earning_rules/rewards/tiers, stamp_card_programs, customer_stamp_cards, gift_card_purchases allows read AND write of customer points balances and earning rules. Claude can do the app rework and the SQL; Peter must decide between 'give platformSupabase the real BO session' vs 'move writes behind edge functions'.

## 2. No migration ledger on either database — staging cannot be built from supabase/migrations

- **Owner:** both  · **Effort:** half a day to baseline + ongoing discipline

supabase_migrations.schema_migrations does not exist on ops (tbetcegmszzotrwdtqhi) or platform (yhzjgyrkyjabvhblqxzu); the schema itself is absent. 169 files sit in possystem/supabase/migrations/ with genuinely mixed applied-ness: 20260721_rls_stage1, 20260721b, 20260721e and today's 20260804c are applied, while 20260721c_rls_lock_user_identity (is_anon_session, is_privileged_ctx, can_claim_location, user_profiles_select_self, and all the REVOKEs) and 20260721d are not. Replaying the folder would produce a schema different from live. Staging must be seeded from pg_dump --schema-only of both live DBs as a 000_baseline.sql, and a real ledger started from there. Peter needs to agree the baseline approach; Claude can execute it. Also note 3 pg_cron jobs on ops (xero-nightly-sales, paxpay-sweep, wf-rate-changes-daily) exist in no migration and must be recreated on staging.

## 3. Live privilege escalation: 20260721c_rls_lock_user_identity.sql never applied — anon key can mint a super_admin

- **Owner:** both  · **Effort:** 1-2h to apply + smoke test create-user, BO login, POS pairing; Peter must snapshot first and accept the auth behaviour change

The 503-line migration that closes two CONFIRMED live escalation paths is not in the DB. Evidence, all from tbetcegmszzotrwdtqhi: (1) select proname ... where proname in ('is_anon_session','is_privileged_ctx','can_claim_location','guard_user_profiles','guard_user_locations','set_bo_access') -> 0 rows. (2) Live handle_new_user() body inserts role as coalesce(new.raw_user_meta_data->>'role','owner') — raw_user_meta_data is fully client-controlled, so signInAnonymously({options:{data:{role:'super_admin'}}}) writes role='super_admin'. The repo version (supabase/migrations/20260721c_rls_lock_user_identity.sql L40-56) hardcodes 'anon'/'owner' instead. (3) user_profiles policies: 'allow all' (cmd=ALL, qual=true, with_check=true) and 'Allow authenticated access' (qual = auth.role()='authenticated'). (4) user_locations policy 'user_locations_admin_write' (cmd=ALL, qual=true, with_check=true) — anyone can grant themselves any location. (5) Both anon AND authenticated hold SELECT/INSERT/UPDATE/DELETE/TRUNCATE on both tables. Effect: every 'pos_can_access(location_id) or is_super_admin()' policy in the database — including the ones 20260804c_rls_hardening added today for bar_tabs, menu_items and floor_tables — is defeated by a two-request escalation from the public anon key. No live customer data yet, which is exactly why this is cheap to fix now.

## 4. No migration tracking on either DB — 169 files applied by hand, no record of which

- **Owner:** both  · **Effort:** Half a day: create a ledger table, backfill it from this audit's applied/unapplied determination, adopt supabase db push for staging

select schemaname, tablename from pg_tables where schemaname='supabase_migrations' returns 0 rows on BOTH tbetcegmszzotrwdtqhi and yhzjgyrkyjabvhblqxzu (only auth/realtime/storage internal tables exist). There is no way to replay supabase/migrations/ onto a fresh staging project and know you produced the same schema — which is the root cause of every unapplied-migration finding in this audit. Compounding it: 6 migration files in the folder are deliberately-reverted or superseded (20260422_multi_location, 20260429_tenant_rls, 20260429_crm_tenant_rls, 20260430_super_admin_select, 20260611b/c/d, 20260625_active_sessions_audit) and sit in normal filename order. 20260804c_rls_hardening.sql's own header names 20260429_tenant_rls as 'the exact tables-vanishing regression that forced the original revert' — a naive folder replay onto staging would reintroduce it.

## 5. HACCP / ops breach escalation has never fired — a critical freezer breach is 36 days unescalated

- **Owner:** both  · **Effort:** 1 hr claude + Peter confirms recipients

ops_alerts row ce724fab-b1e5-41ba-8933-5be981a4b22f: type=temp_breach, severity=critical, 'Chest freezer breach · 8°C', status='sent', escalation_step=0, acknowledged_at=NULL, created_at 2026-06-29. All 3 ops_alerts rows are in the same state. ops-escalate (deployed v13) is only driven by /api/ops-cron, which is dormant because Vercel crons run on Production deployments only. The SMS/email escalation ladder — the entire point of the food-safety module — has zero recorded executions. 1 ops_notification_rules row is configured and waiting. Peter must confirm the recipient list is real before it starts paging people.

## 6. All 4 Vercel crons stay dormant in staging — staging is not a Production deployment

- **Owner:** both  · **Effort:** 2-3 hrs

DEV_ENVIRONMENT.md:10 — develop → staging → main maps to dev/stage/app.pos-up.com inside ONE Vercel project, so only main is Production. Standing up staging does NOT wake /api/marketing-cron, /api/ops-cron, /api/catering-cron or /api/hubrise-cron. Everything else is ready: all four routes are deployed and CRON_SECRET is set (probing dev.pos-up.com and possystem-liard.vercel.app returns 401 unauthorised, not the 500 'CRON_SECRET not set' branch), and all four run-secrets exist in Supabase. Fix: move ownership to pg_cron + pg_net (already installed: pg_cron 1.6.4, pg_net 0.20.0; pattern proven by xero-nightly-sales returning HTTP 200 today) and delete the crons block from vercel.json so main never double-fires. Peter must create the per-environment vault secrets (service-role key + base URL).

## 7. Staging schema cannot be built from the repo — 25 core tables have no CREATE TABLE, and neither project tracks migrations

- **Owner:** both  · **Effort:** 1-2 days

`supabase_migrations.schema_migrations` does not exist on EITHER project (42P01 on both tbetcegmszzotrwdtqhi and yhzjgyrkyjabvhblqxzu); there is no supabase/config.toml. Diffing 161 live Ops base tables against every `create table` in supabase/migrations (169 files), migrations/ (24 files) and root supabase-*.sql leaves 25 unreproducible: staff_members, tax_rates, device_profiles, printers, modifier_groups, customers, shifts, floor_tables, sections, item_variants, cash_drawers, cash_movements, drawer_sessions, active_sessions, device_heartbeats, print_jobs, print_routing, printer_agents, printer_health, customers, customer_locations, customer_orders, sms_messages, stamp_transactions, stock_levels. Spot-checked individually — 0 CREATE TABLE files each. Only viable path: `pg_dump --schema-only` from both live projects and replay into staging. Peter must supply the DB password; Claude can then drive the dump, replay, and diff-verify.

## 8. Native APK self-update channel is a single production bucket — a staging APK will silently reinstall itself as a prod-pointing APK

- **Owner:** both  · **Effort:** 0.5-1 day

All four modules hardcode the prod Ops storage bucket: android/app/.../UpdateChecker.java:56, mpos:54, menuboard:41, paxpay:54 all fetch tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/app-releases/latest*.json. Same applicationId and same signing key means the prod APK installs in place over a staging build within the 3h throttle, and the device becomes a prod terminal with no signal. Fix requires either a per-tier bucket/manifest name or a `-staging` applicationId. Claude can make the code change; Peter must rebuild, sign and publish. Also note live drift: repo android/release/latest.json says versionCode 11 / 2.0 but the published manifest says versionCode 10 / 1.9.

## 9. handle_new_user() still mints super_admin from client metadata — migration 20260721d written but never applied

- **Owner:** claude  · **Effort:** 5 minutes (one CREATE OR REPLACE) + 10 min verification

Live pg_get_functiondef on ops shows role = coalesce(new.raw_user_meta_data->>'role','owner'), fired by trigger on_auth_user_created on auth.users. Anonymous sign-in is enabled (358 of 366 auth.users are anonymous). signInAnonymously({options:{data:{role:'super_admin'}}}) therefore yields is_super_admin() = true, which defeats 38 policies across 33 tables — including every Stage-2 fence applied so far (bar_tabs, menu_items, floor_tables, closed_checks, staff_members, cash_drawers). The fix already exists at possystem/supabase/migrations/20260721d_handle_new_user_no_client_role.sql and also pins the missing search_path. Applying DDL to the live DB was blocked by the sandbox classifier this session, so this needs a Bash permission grant or Peter running it.

## 10. Proven cross-tenant read on ops DB under an anonymous JWT

- **Owner:** claude  · **Effort:** 1 day to author, 1 day to test on staging

Read-only probe with a real anonymous user's JWT claims returned all 6 locations, all 5 organisations, 366/366 user_profiles, 379/397 closed_checks, 710 kds_tickets, 724 print_jobs, 638 config_pushes, 19 devices, 35 receipt_emails, 7/7 customers, 11 user_locations. Three causes: (a) 15 literal 'allow all' USING(true) ALL policies; (b) 15 policies fenced only on auth.role()='authenticated', which an anonymous sign-in satisfies; (c) customers/customer_locations/customer_orders carry an explicit OR ((auth.jwt()->>'is_anonymous')::boolean = true) escape hatch, exposing full customer PII (phone, email, name, birthday, allergens, marketing_opt_in) for every tenant to any anonymous session.

## 11. Pairing codes have only 90,000 possible values and claim_device can steal an already-active device

- **Owner:** claude  · **Effort:** half a day (code + SQL), then re-pair 6 devices

src/backoffice/sections/DeviceRegistry.jsx:21 — genCode() = 10 adjectives x 9000 digits via Math.random(). Live claim_device(p_code) is SECURITY DEFINER, EXECUTE granted to anon, has no rate limit, no expiry, and matches any device with status <> 'removed' — including already-claimed active ones — then overwrites device_uid = auth.uid(). All 14 active devices still carry a pairing_code (never cleared). At Stage 3 this becomes THE tenant boundary: ~90k RPC calls buys pos_can_access for a real venue and simultaneously kicks the real till off its own RLS identity. Fix: crypto.getRandomValues + >=8 chars, gate claim_device to unpaired/unclaimed rows, add expiry, clear the code on successful pair, add a fail counter like terminal_staff_login already has.

## 12. paxpay-sweep has failed 20,538 consecutive times — terminal job sweeper has never once run

- **Owner:** claude  · **Effort:** 30 min

cron.job_run_details: jobid 2, 20,538 failures, 0 successes, every minute since 2026-07-21 20:29, latest 2026-08-05 02:46. Error: 'service role required' from terminal_jobs_sweep() line 4. Root cause: _terminal_is_service_role() reads the PostgREST GUC request.jwt.claims, which pg_cron (running as current_user=postgres) never sets, so the guard is always false. Migration supabase/migrations/20260724_terminal_retire_and_sweep.sql:136 scheduled it. Money-safety impact: abandoned PaxPay payments are never expired/quarantined, terminals wedge. Currently masked because retire_terminal_device() does the same expiry inline and there are 0 expired rows right now. Fix verified live (read-only): set_config('request.jwt.claims','{"role":"service_role"}',true) then _terminal_is_service_role() returns true as postgres. Apply via cron.alter_job, or add a terminal_jobs_sweep_cron() wrapper.

## 13. Print routing + printer registry save to localStorage first, then swallow the DB write entirely

- **Owner:** claude  · **Effort:** 1h

src/backoffice/sections/PrintRouting.jsx:39-47 (saveRoutingToDB) and :73-87 (saveVenueReceiptPrinter), plus src/backoffice/sections/PrinterRegistry.jsx:75-80 and :82-85. All four call save()/localStorage.setItem FIRST, then do an unchecked `await supabase...upsert/update/delete` inside a `try { } catch (e) { console.warn }`. supabase-js never throws (no .throwOnError anywhere; src/lib/supabase.js:8), so the catch is dead code and the error object is discarded. Result: the machine that edited the routing shows the new config forever from its own localStorage cache, while every other device and every future boot uses the old routing. Kitchen tickets go to the wrong station or nowhere. print_routing RLS is only `auth.role() = 'authenticated'` (verified live), so an expired BO session breaks every save while the screen still looks signed in. Fix: DB write first with error+row-count check, cache only on success, reportSave + showToast on failure.

## 14. Floor plan writes are fire-and-forget; delete is optimistic with a catch that cannot fire

- **Owner:** claude  · **Effort:** 1h

src/store/index.js:1193-1203 (updateTableLayout), :1204-1225 (addTableToLayout), :1228-1234 (removeTableFromLayout). upsertFloorTable is called without await; src/lib/db.js:344-346 logs the error with console.error and returns it to nobody. removeTableFromLayout does set() first then `deleteFloorTable(id, locId).catch(console.warn)` — supabase-js resolves with {error} rather than throwing, so that .catch never runs. Operator drags/renames/deletes tables, sees the change, and it is gone (or resurrected) on the next boot or config push. This directly violates the documented 'Tables MUST never be lost' invariant. Not covered by saveHealth despite db.js:142/224/281 right next to it.

## 15. Discount and auto-discount-rule saves/deletes swallow errors and mutate the POS store optimistically

- **Owner:** claude  · **Effort:** 1h

src/backoffice/sections/DiscountManager.jsx:552-568 (saveDiscount), :571-579 (removeDiscount), :587-609 (saveRule), :612-620 (removeRule) — all four catches are console.error only. The underlying writers src/lib/db.js:1596-1598 (upsertDiscount) and :1656-1658 (upsertDiscountRule) log the error and return it; the caller never inspects the return. deleteDiscount (db.js:1601-1606) and deleteDiscountRule (:1661-1666) return the query result unchecked. On a failed delete the row is removed from BO state AND pushed into the Zustand store via syncToStore(:542-549), so the POS stops offering it while the DB still has it — it returns on the next config push. On a failed save the editor just closes, which reads as success. Money path. Also uses `await import('../../lib/db.js')` inside click handlers (:555,:573,:590,:614), which CLAUDE.md explicitly bans.

## 16. Tax manager: seedRates claims success with zero error checking, and load() can push an empty tax table into the store

- **Owner:** claude  · **Effort:** 1h

src/backoffice/sections/TaxManager.jsx:187-195 — seedRates loops `await supabase.from('tax_rates').insert(...)` with no error check at all, then unconditionally flashes '✓ 12 rates added'. :164 — the 'unset all other defaults' update is unchecked, so a partial failure yields TWO default rates; verified live there is no DB constraint preventing this (only tax_rates_pkey exists; currently 1 default per location across 4 locations, so it is clean today). :182 — delete is unchecked. :136-151 — load() destructures only {data}, discards the error, then does useStore.setState({ taxRates: fetched.map(...) }) at :144; on a read failure that publishes an EMPTY tax table into the running app and simultaneously re-shows the 'Seed UK rates' button at :212, inviting a duplicate seed. HMRC-relevant.

## 17. insertCashMovement returns a success id even when the DB insert failed

- **Owner:** claude  · **Effort:** 30m

src/store/index.js:4206-4238. Line 4231-4232: `const { error } = await supabase.from('cash_movements').insert(row); if (error) console.warn(...); return row.id;` — the function hands back row.id regardless, so every caller (petty cash, cash drops, paid-outs, cash sales) records the movement as booked. Drawer variance, EOD close and the Z-report are then silently wrong with no trace anywhere in the UI. 165 rows in cash_movements on the ops DB today. Same file: updateCashDrawer (:3596-3602) and deleteCashDrawer (:3606-3616) are console.warn-only, and deleteCashDrawer removes the drawer from state before the write.

## 18. New staff members and their PINs can vanish silently — and every edit made before a refresh is discarded by design

- **Owner:** claude  · **Effort:** 2h

Three compounding faults. (1) src/backoffice/sections/StaffManager.jsx:244-251 — the staff_members insert reports failure with `console.error('Staff save failed:', ...)` only, then line 257 fires `showToast('<name> added', 'success')` unconditionally. (2) addStaffMember (src/store/index.js:289) stamps a local id of `s-${Date.now()}` while the DB lets Postgres mint a UUID, and the edit path early-returns for those ids at StaffManager.jsx:172 ('Nothing to update server-side') — so adding a staff member and then setting their PIN, role or permissions before a page refresh silently changes nothing, even when everything is healthy. (3) deleteMember (:263-271) is a bare unawaited `supabase.from('staff_members').update({active:false})` with no .then, followed by an unconditional 'Staff member removed' toast. Related: src/backoffice/sections/Workforce.jsx:141-149 ('Set as POS user') wraps both the staff_members upsert and markPosUser in a try/catch that cannot fire, then toasts '<name> added as a POS user'. Net effect: staff who cannot sign into the till, or a PIN that exists in one browser tab and nowhere else.

## 19. No config.toml: verify_jwt is unreproducible, and check-deploys.mjs --deploy would open 4 functions

- **Owner:** peter  · **Effort:** 2-3h to author supabase/config.toml for all 117 functions and strip the blanket flag; Peter should review the webhook list

find . -name config.toml (excluding node_modules) returns nothing — verify_jwt exists only as remote state set ad hoc at deploy time. Hazard A: scripts/check-deploys.mjs:58 hardcodes --no-verify-jwt for every function it redeploys. One --deploy run silently flips gift-branding-public, send-sms, stripe-update-reader-display and terminal-job-reconcile from JWT-gated to public; a public send-sms is an open SMS-spend relay. Hazard B: supabase functions deploy defaults verify_jwt=TRUE, so standing up staging from the repo would 401 all 9 third-party webhooks at the gateway before the handler runs: stripe-webhook, stripe-webhook-connect, ryft-webhook, adyen-webhook, hubrise-webhook, uber-webhook, stuart-webhook, marketing-webhook, waitlist-sms-inbound. Payments would look like they work and never settle. Fix: commit supabase/config.toml with an explicit [functions.<slug>] verify_jwt for all 117, and delete the unconditional --no-verify-jwt from check-deploys.mjs.

## 20. stage.serv-os.app and app.serv-os.app serve a v4.1.0 build (1380 commits stale) against the LIVE production database

- **Owner:** peter  · **Effort:** hours

Asset hashes prove app.serv-os.app and stage.serv-os.app serve byte-identical `index-53-am0Ad.js`, while dev.serv-os.app and possystem-liard.vercel.app serve `index-XLSWq9fl.js`. The former returns no /version.json (predates v5.5.870); `git show origin/main:src/lib/version.js` = 4.1.0 with `<title>Restaurant OS</title>` and theme-color #d4881c — an exact match for the served bytes. `git rev-list --count origin/main..origin/develop` = 1380 (last main commit 2026-05-04). That stale bundle contains tbetcegmszzotrwdtqhi and yhzjgyrkyjabvhblqxzu, so it reads and writes the same production DBs as current develop. 'stage' is therefore not an environment — it is a second domain on a stale prod deployment. Needs a separate Vercel project/deployment with VITE_APP_TIER=stage and staging keys, plus a decision on what happens to the v4.1.0 main branch before go-live.


---

# HIGH (22)

## 1. POS APK hardcodes both its URL and its WebView origin allowlist — changing one without the other blocks every page load

- **Owner:** both  · **Effort:** hours

android/app/src/main/java/co/posup/rpos/MainActivity.java:16 sets POS_URL to https://possystem-liard.vercel.app/?mode=pos, and lines 89-90 gate navigation with `return !url.startsWith("https://possystem-liard.vercel.app") && !url.startsWith("https://tbetcegmszzotrwdtqhi.supabase.co")` — shouldOverrideUrlLoading returning true means BLOCK. Retargeting staging requires editing the URL, the allowlist app host, AND the allowlist Supabase host. A third constant is easy to miss: CustomerDisplayPresentation.java:25 has its own hardcoded rear-screen URL. :mpos MainActivity.java:31 and :menuboard MainActivity.java:24 point at dev.serv-os.app and have no origin check. No build flavors or buildConfigFields exist in :app/:mpos/:menuboard, so this is a source edit + rebuild, not a runtime switch. Corrects the stale memory note: possystem-liard and dev.serv-os.app serve identical bundles, so all three WebView apps currently point at the develop build.

## 2. Loyalty OTP and WiFi crypto keys derive from the service-role key, so a prod snapshot restored into staging breaks them

- **Owner:** both  · **Effort:** hours

supabase/functions/loyalty-otp/index.ts:48 uses `OTP_HMAC_SECRET ?? SUPABASE_SERVICE_ROLE_KEY ?? 'fallback-secret'` and supabase/functions/_shared/wifi-crypto.ts:17 uses `WIFI_SECRET || SUPABASE_SERVICE_ROLE_KEY`. Neither OTP_HMAC_SECRET nor WIFI_SECRET is set. The service-role key differs per project, so every stored WiFi binding becomes undecryptable and all loyalty OTP tokens invalidate the moment data moves between environments. Set both explicitly on prod BEFORE taking any snapshot, and mirror them to staging. Note the 'fallback-secret' literal is also a weak default worth removing.

## 3. 12 tables default location_id to the 'loc-demo' sentinel — silent write rejection at Stage 3

- **Owner:** claude  · **Effort:** 2 hours

closed_checks, config_pushes, discount_rules, discounts, eighty_six, floor_tables, kds_tickets, menu_categories, menu_items, menus, modifier_groups and sections all declare location_id text NOT NULL DEFAULT 'loc-demo'. 20 rows already sit on it (config_pushes 10, menu_categories 6, menus 4). 'loc-demo' is in no user's user_accessible_locations(), so at Stage 3 any write that omits location_id is rejected by WITH CHECK — and several writers swallow the error, so it fails silently. Drop the defaults and repoint the orphan rows before Stage 3.

## 4. ops_devices identity churn — root cause of the open checklist RLS bug, and the Stage-3 canary

- **Owner:** claude  · **Effort:** half a day

Live ops_devices holds 4 rows for one physical tablet; the most recently seen (2026-07-31) has location_id NULL and claimed_at NULL. register_ops_device() keys on device_uid = auth.uid(), so every time the anonymous uid rotates it INSERTs a new unclaimed row instead of re-claiming. ops_can_write() requires d.location_id = p_location_id, and NULL never matches — hence every checklist tick/photo is rejected. This resolves the 'prime suspect: location mismatch' question left open in possystem/OPS_CHECKLIST_RLS_HANDOVER.md. The same failure mode will hit every POS at Stage 3 whenever rpos-device.pairingCode is missing from localStorage, and claimPairedDeviceOnBoot currently fails to console.warn only — make it surface a 'needs re-pairing' state.

## 5. Three public storage buckets are writable by any anonymous session

- **Owner:** claude  · **Effort:** 2 hours

product-images, receipt-assets and kiosk-assets are public=true with write policies gated only on auth.role()='authenticated' and bucket_id — no path or location scoping. Any anonymous sign-in can overwrite or delete any venue's product images and receipt logos and host arbitrary files on your domain. Separately, the ops_evidence_device_insert/update/read policies contain a typo: storage.foldername(d.name) reads the ops_devices label ('Ops tablet') instead of the storage object's name, so the device branch is always false and paired ops tablets can never upload evidence photos.

## 6. check-deploys.mjs is blind to _shared/ drift and false-positives on timestamps — 15 real drifts missed, 7/7 flagged were clean

- **Owner:** claude  · **Effort:** 2h: replace the timestamp heuristic with the deployed-bundle byte-diff, then redeploy the 4 hubrise functions

scripts/check-deploys.mjs:33-41 compares git log -1 -- supabase/functions/<slug> against fn.updated_at. Two structural defects: (1) FALSE NEGATIVES — _shared/*.ts is inlined into every consumer bundle at deploy, but editing it never touches the slug directory. 13 of the 15 real drifts live there and are structurally invisible. It also iterates the REMOTE function list, so a never-deployed function can never appear. (2) FALSE POSITIVES — Supabase's updated_at does not reliably advance on redeploy. All 7 flagged functions are byte-identical to the repo: stripe-assign-reader-to-pos reports updated_at 2026-05-05 yet its deployed source contains customer_display_enabled (commit f0d422d, 2026-05-23); stripe-sync-location-reader-config contains stripe_s700 + updatedTerminalLocations (edfee75); the three stripe-* '2.6h' hits already carry esm.sh/stripe@14.21.0?target=denonext. Ground truth came from GET /v1/projects/{ref}/functions/{slug}/body, extracting original TypeScript from the eszip sourcemap sourcesContent and diffing against the repo. Real drift: 15 functions, of which 11 are type-only/comment-only/dead-export (ryft _shared on 7 fns, stripe-update-reader-display, send-welcome, catering-release, uber-direct) and safe to leave.

## 7. hubrise-webhook and hubrise-reconcile are booking inbound marketplace orders with ZERO VAT

- **Owner:** claude  · **Effort:** 15 min to redeploy 4 functions; then verify a test Deliveroo order's tax lines

Both live functions run a pre-v5.5.857 _shared/hubrise-map.ts. Deployed resolveTaxFrac uses `rid != null ? rateById.get(String(rid)) : null`; the repo version uses `: defaultRate`, plus the sibling change that lets a product resolve via the venue default when neither the variant children nor the parent carry tax config. Consequence: every inbound Deliveroo / UberEats / JustEat order booked through the live webhook records 0% VAT on any item set to 'Use default' in the item editor. This is a VAT-correctness bug on real revenue lines, not cosmetic drift. Also stale on the same shared modules: hubrise-inventory-push (_shared/hubrise-ingest.ts +181/-10, hubrise-map.ts +189/-7, hubrise.ts +16/-6) and hubrise-order-status (+152/-0, +121/-5, +2/-1) — these are missing the allergen-vocabulary normaliser that prevents HubRise 422-ing the entire catalog PUT on an unrecognised allergen name. Fix: redeploy hubrise-webhook, hubrise-reconcile, hubrise-inventory-push, hubrise-order-status.

## 8. waitlist-sms-inbound has NEVER been deployed (committed 24 Jun 2026, 6 weeks ago)

- **Owner:** claude  · **Effort:** 10 min to deploy with --no-verify-jwt; Peter then points the Twilio Messaging webhook at it

supabase/functions/waitlist-sms-inbound/ exists in the repo (commit d2b224c, v5.5.622, 2026-06-24) but is absent from the deployed list on tbetcegmszzotrwdtqhi — comm -23 of local dirs vs the 117 remote slugs returns exactly this one. check-deploys.mjs cannot detect it because it iterates the REMOTE list, so a function that was never deployed is structurally invisible. Dead as a result: guest replies to Tables Ready waitlist texts. Per the function header, C/CANCEL/X/NO (cancel entry), OK/HERE/Y/YES/OMW (confirm, stamps confirmed_at), and STOP/UNSUBSCRIBE/END/QUIT (writes a marketing_suppressions row) all go nowhere. The opt-out ledger in particular is a compliance surface — Twilio handles carrier-level STOP, but your own suppression list never learns about it. Needs verify_jwt=false since Twilio sends no JWT.

## 9. Hardcoded dev Supabase URL in all 4 cron routes and in xero_nightly_post() — cross-environment bleed

- **Owner:** claude  · **Effort:** 45 min

api/marketing-cron.js:36, api/hubrise-cron.js:32, api/ops-cron.js:23, api/catering-cron.js:24 all fall back to 'https://tbetcegmszzotrwdtqhi.supabase.co' (the DEV Ops project) when SUPABASE_URL/VITE_SUPABASE_URL is unset. The live DB function xero_nightly_post() hardcodes the same URL with no fallback at all. A staging or prod deploy with a missing env var, or a staging DB restored from this one, silently drives the dev database. Fix: fail loudly instead of falling back in the API routes, and move base URL + bearer into vault behind a single call_edge_fn(fn, body) helper.

## 10. Review ask engine and review sync have no scheduler at all — and review-sync cannot be cronned as written

- **Owner:** claude  · **Effort:** 1-2 hrs

review-request/index.ts:9 and :111 document scan_all as 'service-role; cron' and review-sync/index.ts:11 says 'for a scheduled cron', but neither appears in vercel.json nor cron.job. They only ever run from manual buttons in src/backoffice/sections/review/ReviewTriggers.jsx:182,196. Worse, review-sync/index.ts:57-58 requires ops_location_id and returns 400 without it — there is no fan-out action, so a cron literally cannot drive it. Needs a sync_all service-role branch mirroring review-request's scan_all at line 112, then a pg_cron job. The review growth engine currently only works when a human clicks.

## 11. Catering scheduled-fire safety net is dead; only a master-device 60s timer with a 2-hour floor covers it

- **Owner:** claude  · **Effort:** 30 min (covered by the pg_cron work)

catering-release (deployed v21) is only driven by the dormant /api/catering-cron. The sole live path is src/sync/SyncBridge.jsx:551 → src/store/index.js:2298 releaseDueCateringOrders, which is master-device-only, runs every 60s, and refuses anything whose fire time passed more than STALE_ORDER_FLOOR_MS = 2 hours ago (src/sync/staleness.js:17). If the master POS is asleep or offline across the fire window, the order never reaches the kitchen and nothing server-side rescues it. Already visible: 1 order_queue row with source='catering' and kitchen_routed_at IS NULL.

## 12. Device registry: revoking a terminal, regenerating a pairing code and reassigning a receipt printer are all unchecked

- **Owner:** claude  · **Effort:** 45m

src/backoffice/sections/DeviceRegistry.jsx:180 (cancelPairing delete), :188 (regenerateCode — the new code is shown on screen while the OLD code may still be valid in the DB), :195 (removeDevice, whose own confirm text says 'The terminal will be locked out immediately'), :204-216 (saveEdit — name, type, profile_id, centre_id, receipt_printer_id). Every one is a bare `await supabase.from('devices').update/delete(...)` with the result thrown away. A device you believe you revoked keeps taking payments; a till you reassigned to a different profile or receipt printer keeps its old config. Note DeviceProfiles.jsx already does this correctly (reportSave + 0-row check at :200-213) — copy that pattern here.

## 13. Archiving a menu item, size or variant fails silently while the UI reports success

- **Owner:** claude  · **Effort:** 45m

src/store/index.js:1171-1189 archiveMenuItem — both the parent and the children updates use `.then(({error}) => { if (error) console.error(...) })` after an optimistic set(). src/backoffice/sections/MenuManager.jsx:1330 (remove a size) and :2043-2053 (removeVariant) do the same and then fire showToast('Size removed')/showToast('Variant removed'). A size you 'removed' stays orderable at its old price on kiosk, online and QR until someone notices. These are menu writers in the exact family saveHealth was built for (db.js:142/224/281, store:103/110/149/156/176) and they were missed — this is the concrete remainder of task #82.

## 14. Rota publish notifies staff by SMS and email even when the publish write failed

- **Owner:** claude  · **Effort:** 1h

src/staff/wfData.js:398-403 publishShifts logs `console.warn('[wf] publishShifts:', error.message)` and returns normally. Its caller src/backoffice/sections/workforce/WfRota.jsx:523-545 then (a) writes a wf_audit row via logAudit claiming N shifts were published for the week — and logAudit itself is console.warn-only at wfData.js:872, (b) optimistically marks every shift 'published' in local state, and (c) sends every affected staff member their week's shifts by SMS and email. Staff are told about a rota that does not exist server-side and will not appear on their app. Same class: WfLeave.jsx:82-91 decide() reverts on throw, but decideTimeOff (wfData.js:511) never throws — so a failed approval shows 'Leave approved'. Also softDeleteStaff (:215), deleteShift (:395), deleteSection (:322), deleteDocument (:595), saveForecast (:815) are all warn-only.

## 15. LocationSettings drops address, item images and takeaway settings behind an empty catch while showing 'Saved'

- **Owner:** claude  · **Effort:** 20m

src/backoffice/sections/LocationSettings.jsx:302-311. The first save (platform DB, :281-291) is done properly with .select() and an error check, and there is a good comment at :268-273 explaining exactly why. The second save — ops DB `show_item_images`, `address`, `pos_settings.takeaway_customer_details` — is `try { await supabase.from('locations').update({...}).eq('id', locId); } catch {}`. Unchecked error, and a catch that can never fire. The screen shows the success state from the first write. Same shape at PrintMenu.jsx:149-153 (debounced autosave shows 'saved'), MultiLocation.jsx:54 (ops-side rename unchecked, 'Location updated' success), Challenge21.jsx:159, LocationSwitcher.jsx:129-133, MenuBoards.jsx:103/:146, Customers.jsx:526-534 (GDPR soft-delete — the row disappears from the UI but the customer is not erased).

## 16. The Manager app (?mode=manager) still has the exact bug v5.5.971 fixed for the Back Office — no toast renderer at all

- **Owner:** claude  · **Effort:** 1h

src/App.jsx:272 returns <ManagerSurface/> from a branch BEFORE ValidatedPOSApp, and App.jsx:723 is the only <Toast> in the POS tree — the same 'returns from an earlier branch' mechanism described in the v5.5.971 comment at BackOfficeApp.jsx:172-178. src/surfaces/ManagerSurface.jsx has zero toast plumbing. It renders src/surfaces/OperationsSurface.jsx (911 lines) via ManagerOps.jsx:13, and that file has no showToast and no Toast component anywhere. Inside it: OperationsSurface.jsx:599 (markDone), :612 (untick) and :646 (onTempSaved — the HACCP temperature reading) all optimistically set state then `await completeTask(...)` with the result discarded. A manager records a fridge temperature, sees it tick, and the food-safety record is never written. The photo path (:659) and sign-off (:668) do check — so the fix is small and local. MPOSSurface and TimeClockSurface are in the same no-toast position.

## 17. Back Office and Company Admin hardcode the production edge-function host for create-user

- **Owner:** claude  · **Effort:** minutes

src/backoffice/sections/StaffManager.jsx:303 and src/admin/CompanyAdminApp.jsx:330 both call fetch('https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/create-user', …) instead of routing through the configured supabase client. These are the only two absolute edge-function URLs in src/. A staging Back Office would create real users in the production Ops project. Should use supabase.functions.invoke() or derive the host from VITE_SUPABASE_URL.

## 18. All four Vercel cron handlers silently fall back to the production Supabase URL

- **Owner:** claude  · **Effort:** minutes

api/ops-cron.js:23, api/marketing-cron.js:36, api/hubrise-cron.js:32 and api/catering-cron.js:24 each resolve `process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://tbetcegmszzotrwdtqhi.supabase.co'`. If SUPABASE_URL is not set on the staging Vercel project, staging crons fire against production — every 1-5 minutes per vercel.json, with no error. The fallback should be removed so a missing var fails loudly, matching how these same files already 500 on a missing run-secret.

## 19. PLATFORM_SERVICE_KEY is read with no fallback but is not set — send-welcome and wallet-pass cannot reach the Platform DB today

- **Owner:** claude  · **Effort:** minutes

supabase/functions/send-welcome/index.ts:38 and supabase/functions/wallet-pass/index.ts:34 both do `Deno.env.get('PLATFORM_SERVICE_KEY') ?? ''`. That name is not among the 42 secrets set on the Ops project (the configured name is PLATFORM_SUPABASE_SERVICE_ROLE_KEY). order-notify/index.ts:30 handles it correctly with a two-name fallback. Both functions are deployed and are failing silently now — and the naming inconsistency will be re-inherited by staging. Fix by matching order-notify's fallback chain.

## 20. SaaS billing schema (20260727c) not applied to Platform DB — no subscription metering exists

- **Owner:** peter  · **Effort:** 30 min to apply the migration; Peter must confirm the plan/price table is final before it becomes the server source of truth

On yhzjgyrkyjabvhblqxzu: select tablename from pg_tables where schemaname='public' and tablename like '%billing%' returns only billing_state and billing_invoices — the legacy v2 schema. Missing: billing_plans, billing_usage, billing_charges, billing_usage_seen, accrue_gtv(), plan_for_gtv(), idx_billing_usage_period, uniq_billing_charge_real_per_period. The migration's own header states the legacy counter billing_state.gmv_this_month HAS NEVER BEEN INCREMENTED because incrementGmv() in src/lib/billing.js has zero call sites — so every venue reads £0 GTV and any threshold check silently never fires. src/lib/billingPlans.js:13 already documents billing_plans as 'the server's source of truth'. Going live without this means no GTV metering, no Free/Growth/Scale (£0/£149/£299) enforcement, no device allowance enforcement, and — because uniq_billing_charge_real_per_period is the migration's stated at-most-once-per-period guarantee — no structural protection against double-charging a venue when billing does get wired.

## 21. 39 referenced edge-function secrets unset; email provider may be silently discarding all mail

- **Owner:** peter  · **Effort:** 1-2h to set core-flow secrets on Ops and mirror the full set into the staging project

42 secrets set on Ops; 0 on Platform (consistent — Platform has no edge functions, but it means the Ops service-role key is the sole gate to the entire Platform DB). MUST RESOLVE: (a) RECEIPT_EMAIL_PROVIDER — all four senders default to 'log' (send-receipt/index.ts:3, order-notify:32, send-welcome:45, marketing-send:36). Only RESEND_API_KEY is set (POSTMARK_API_TOKEN and SENDGRID_API_KEY are not, and send-receipt:169 / marketing-send:148,159 THROW if selected). I was blocked from reading secret values — Peter must confirm the live value is 'resend', not 'log', or every receipt and order notification is being silently discarded. (b) PLATFORM_SERVICE_KEY naming split: order-notify/index.ts:30 falls back to PLATFORM_SUPABASE_SERVICE_ROLE_KEY, but wallet-pass/index.ts:34 does NOT — platformDb is null at line 50 and wallet passes are dead; send-welcome/index.ts:38 declares it and never uses it. Normalise on one name. (c) OTP_HMAC_SECRET (loyalty-otp:48) and WIFI_SECRET (_shared/wifi-crypto.ts:17) both silently fall back to SUPABASE_SERVICE_ROLE_KEY — working, but it couples loyalty OTP signing and every stored UniFi binding to the service key, so rotating it breaks them without warning. (d) MARKETING_SANDBOX unset = LIVE SENDS (marketing-send:44) — must be true on staging or you will email real customers from the staging project. (e) REVIEW_CARD_BASE / REVIEW_BO_BASE default to hardcoded https://possystem-liard.vercel.app (review-request:23, review-google:25) — staging review links would point at the dev deploy. EXPECTED-ABSENT (no action): ADYEN_* (14, not onboarded), UBER_DIRECT_* (7, Stuart is the live courier and its secrets are set), APPLE_*/GOOGLE_WALLET_* (7, deferred), XERO_APP_BASE.

## 22. Ops DB still has allow-all RLS on locations and device_profiles; tightening it for staging will activate every silent failure above at once

- **Owner:** peter  · **Effort:** decision + migration

Verified live on tbetcegmszzotrwdtqhi via pg_policies. `locations` carries a policy literally named 'allow all' with USING true / WITH CHECK true for roles {public} (alongside two narrower policies, which are OR'd and therefore irrelevant). `device_profiles` has the same 'allow all' true/true policy. tax_rates, discounts, discount_rules and print_routing are gated only by `auth.role() = 'authenticated'`, with anon SELECT still open (e.g. floor_tables_anon_read USING true) — precisely the shape that produced the v5.5.951 vanishing-categories incident: reads keep working on an expired session while every write dies. Two decisions needed from you: (1) the order of operations — fix the swallowing BEFORE tightening RLS, or a whole class of writers starts failing invisibly on day one of staging; (2) approve a small migration adding `create unique index tax_rates_one_default on tax_rates (location_id) where is_default;` — free now with no customer data (12 rows, 1 default per location, all clean), expensive to backfill later.


---

# MEDIUM (17)

## 1. Marketing sends are not sandboxed — the hourly cron will send for real the moment it wakes

- **Owner:** both  · **Effort:** 15 min

MARKETING_SANDBOX is absent from the 42 Supabase edge secrets while RESEND_API_KEY and TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER are all set, so marketing-send/index.ts:284 evaluates sandbox=false. marketing_messages already shows 6 'sent' + 1 'opened'. Current blast radius is small (7 customers, 4 opted in; the one active campaign is type='one_off', which campaign-engine.ts:324 filters out of runDueCampaigns) — but staging will likely clone this data and then start running the engine hourly for the first time. Peter should decide the per-environment policy; set MARKETING_SANDBOX=true on staging.

## 2. closed_checks INSERT is still WITH CHECK (true) — revenue rows can be fabricated

- **Owner:** claude  · **Effort:** 1 hour, coupled to the public-checkout carve-out design

Live policy 'insert closed checks' on public.closed_checks is INSERT with with_check = true, while SELECT/UPDATE/DELETE are correctly on pos_can_access(location_id). Any anon-key holder can insert arbitrary closed_checks rows for any location. These feed billing GMV. It needs replacing with pos_can_access OR a narrow public-checkout carve-out (the four public callers are OnlineCheckout.jsx:934,1069, QrCheckout.jsx:440, CateringCheckout.jsx:207, TabResumeScreen.jsx:138).

## 3. Blanket anon/authenticated grants incl. TRUNCATE on every table in both DBs

- **Owner:** claude  · **Effort:** 1 hour

information_schema.role_table_grants shows SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER granted to both anon and authenticated on 159 of 161 ops tables and all 36 platform tables. RLS is the only fence. PostgreSQL RLS covers SELECT/INSERT/UPDATE/DELETE/MERGE only — TRUNCATE is governed purely by the grant, so no policy will ever cover it. I could not run a live TRUNCATE proof (the sandbox classifier blocked the DDL probe), so treat that as documented behaviour rather than a demonstrated exploit; practical reach via PostgREST is low. Revoke TRUNCATE/REFERENCES/TRIGGER and re-grant DML per-command as part of the end-state script.

## 4. user_accessible_locations() is SECURITY INVOKER while 136 policies depend on it

- **Owner:** claude  · **Effort:** 30 minutes, but must land BEFORE user_profiles/user_locations are locked down

The helper reads user_locations and user_profiles as the caller. 136 policies across 63 tables call it. Both source tables currently have allow-all policies, which is the only reason it behaves consistently today. The moment Stage 3 locks them down, this helper's result changes under every dependent policy, with recursion risk. Make it SECURITY DEFINER with a pinned search_path first. Related: handle_new_user, decrement_stock and restore_stock are the 3 SECURITY DEFINER functions with no search_path pin (67 others are correctly pinned).

## 5. Order numbers still using the collision-prone local fallback — 20260430_order_number_counter.sql unapplied

- **Owner:** claude  · **Effort:** 10 min to apply; verify next_order_number() returns R1, R2, ... and wraps at 99

Neither public.location_order_counters nor public.next_order_number(text) exists on tbetcegmszzotrwdtqhi. src/lib/db.js:58 RPCs next_order_number on every single order; src/lib/db.js:65 logs '[getNextOrderRef] RPC next_order_number failed: ... — using local fallback. Apply v5.5.8 migration to fix.' So every customer-facing order ref today comes from the local generator the migration was written to replace (kiosk Date.now()%1000 / POS Math.random()*9000 / in-memory counter), which the migration header says was producing repeats within minutes. Every order also pays for one failing round-trip. Cheap to fix and it removes a class of duplicate-order-number support tickets before real venues see them.

## 6. staff_members.auth_user_id missing — BO access linking for staff is degraded

- **Owner:** claude  · **Effort:** 10 min to apply 20260430_staff_auth_link.sql

information_schema.columns has no auth_user_id on staff_members, and staff_members_auth_user_id_unique does not exist. src/backoffice/sections/StaffManager.jsx:75 selects the column, :77 catches the PGRST204/column-missing error and :78 warns 'auth_user_id column missing — falling back. Run supabase/migrations/20260430_staff_auth_link.sql to enable BO access linking.' The fallback path also drops nfc_card_id and auth_method from the BO view (:80), so staff card / fingerprint login linkage is not manageable from the back office.

## 7. terminal_devices has no write policies — only td_select is live

- **Owner:** claude  · **Effort:** 10 min: apply the td_delete block from 20260722_terminal_devices.sql:83

pg_policies for terminal_devices returns exactly one row: td_select (device_uid = auth.uid() OR location in user_locations OR super_admin). supabase/migrations/20260722_terminal_devices.sql:83 also creates td_delete for authenticated, which is absent. Client-side retire/delete of a PAX terminal from the back office is blocked; edge functions using service_role are unaffected, so this may be masked today. Worth closing before staging so terminal lifecycle is testable end-to-end.

## 8. Two PaxPay sweepers exist and neither runs — pick one before staging

- **Owner:** claude  · **Effort:** 20 min + a decision

terminal-job-reconcile/index.ts:3 says 'The PaxPay sweeper. Runs on a schedule (cron) under the SERVICE ROLE.' It is deployed (v3, verify_jwt=true) but scheduled nowhere. The DB function terminal_jobs_sweep() does the same three transitions and IS scheduled (broken). Fixing the DB job and also scheduling the edge fn would double-sweep. Decide: DB job as the sweeper + edge fn as the human-verdict relay (its 'resolve' action), or retire the DB job.

## 9. cron.job_run_details grows unbounded — 20,565 rows / 5.5 MB, +1,441/day, no purge

- **Owner:** claude  · **Effort:** 5 min

pg_cron does not purge run history by default and no purge job exists. Almost all of it is the paxpay-sweep failure log. Add a daily 'cron-log-purge' job deleting rows with end_time older than 7 days. Do this in the same migration that creates the new jobs, before staging inherits the pattern.

## 10. Ops and stock sections toast success on writes they never checked

- **Owner:** claude  · **Effort:** 2h

Operations: OpsMaintenance.jsx:39 (setStatus), :40 (assign — toasts 'Assigned to X'), :43 (createMaintenance — toasts 'Raised'), :46 (addMaintenanceNote — toasts 'Note added'); OpsNotifications.jsx:69 (deleteNotificationRule — toasts 'Rule removed'); OpsTemperature.jsx:127 (upsertSchedule loop, then toasts 'Saved') and :132 (deleteSchedule); OpsDevices.jsx:58 (removeOpsDevice — toasts 'Tablet unpaired'). Stock: StockItems.jsx:413 (upsertParLevel — par and reorder point, drives ordering), :515 and :573 (delete conversion bridge / packaging format), :574 (setUnitDefault — wrong purchase unit means wrong PO quantities and costs), :680 (delete supplier product price link); StockCounts.jsx:102 and :105 (saveCountLine — counted quantities silently lost); PurchaseOrders.jsx:157 (setPOStatus CANCELLED); Suppliers.jsx:53 (setSupplierArchived — toasts 'Archived'); Recipes.jsx:170 (setRecipeArchived). All the underlying lib/stock/* and lib/ops/* helpers already return {error} correctly — the callers just ignore it, so these are one-line fixes each.

## 11. No seed or fixture path exists to stand up a test venue

- **Owner:** claude  · **Effort:** 1 day

scripts/ contains only check-deploys.mjs, screenshots.mjs and simulate-billing.mjs. The one seed file, supabase/migrations/20260628_ops_demo_seed.sql, covers only Ops-module content (temp units, checklists, one maintenance request) and hardcodes `loc uuid := '7218c716-…'` — no menu, staff, devices or tax rates. src/data/seed.js and src/staff/seed.js are in-browser mocks for VITE_USE_MOCK. scripts/screenshots.mjs consumes a seeded venue rather than creating one. Minimum viable venue, measured against the working demo venue: Ops locations row, Platform locations+companies row (via the provision-location edge fn), >=1 staff_members with PIN, >=1 devices + device_profiles per surface, >=1 tax_rates, >=1 menus/menu_categories/menu_items; floor_tables, printers and cash_drawers only if table service / printing / cash are in scope. Recommend scripts/seed-venue.mjs taking a slug and provisioning all of it.

## 12. Customer kiosk path /k is dead — it parses to a mode the dispatch does not accept

- **Owner:** claude  · **Effort:** minutes

src/lib/customerUrl.js:130 maps `pathname.startsWith('/k')` to mode 'kiosk', but CUSTOMER_MODES at src/App.jsx:184 lists only online, qr, gift, gift_balance, gift_success, account, review, wifi, catering, waitlist, waitlist_status. A customer hitting <slug>.serv-os.app/k falls through to the operator dispatch and sees the device pairing screen. The match is also far too loose — /kitchen, /knowledge and any other /k* path hit it. Either add 'kiosk' to CUSTOMER_MODES or delete the branch, and tighten the match to an exact '/k'.

## 13. 8 of 19 devices have no device_uid — 6 of them are active/online and will lose all access at Stage 3

- **Owner:** peter  · **Effort:** 15 minutes per device, on-site

devices holds 19 rows, 11 with device_uid. Unclaimed and still active/online: 2 handheld (active), 1 kiosk (online), 3 pos (active). pos_can_access requires device_uid = auth.uid() AND status IN ('active','online'), so these are locked out the moment allow-all is dropped unless they boot with a cached rpos-device.pairingCode. Needs Peter (or site staff) to re-pair the physical terminals; Claude can produce the list and a BO banner that flags unclaimed devices.

## 14. Rotate both projects' anon keys as part of the staging cutover

- **Owner:** peter  · **Effort:** 1 hour plus a coordinated redeploy

The anon key ships in the browser bundle, and blockers 1, 3 and 4 mean anyone who has held it since 21 Jul could have taken super_admin. Forensics today show 1 super_admin, non-anonymous (the owner), and 358 anonymous profiles all on role='owner' — so there is no evidence of exploitation. Still, rotate both the ops and platform anon keys during the cutover and do not carry dev secrets into staging. Needs Peter's Supabase account and a coordinated Vercel env update.

## 15. customers, active_sessions, order_queue, devices, device_profiles, kds_tickets still anon allow-all

- **Owner:** peter  · **Effort:** Multi-day: SECURITY DEFINER RPCs + client call-site migration per table, then a policy-swap migration

Confirmed live on tbetcegmszzotrwdtqhi: active_sessions / order_queue / devices / device_profiles each have a single policy named 'allow all' (cmd=ALL, qual=true); kds_tickets likewise; customers has customers_all with an explicit anon carve-out ((auth.uid() IS NULL) OR is_anonymous = true). 20260804c_rls_hardening.sql (applied today) explicitly DEFERS these with a written rationale for each — locking them now breaks the QR flow, kiosk loyalty lookup, anonymous order INSERT after payment, and OrderTracker realtime. Raising it here because it interacts with the 20260721c blocker: devices is the trust anchor of pos_can_access(), and 20260804c's own closing note says 'until devices is fenced, a determined attacker can still forge a devices row to satisfy pos_can_access'. Applying 20260721c hardens the user_profiles/user_locations root but leaves the devices route open, so the two need sequencing as one plan rather than independent tickets. Not a staging blocker on its own — but it is the reason staging must not be pointed at any real customer data.

## 16. 39 secrets referenced by edge-function code are not configured, including the entire Adyen, Apple Wallet, Google Wallet and Uber Direct blocks

- **Owner:** peter  · **Effort:** 1 day

Code reads 77 distinct Deno.env names; 42 are set on the Ops project. Unset: ADYEN_* (14), APPLE_* (5), GOOGLE_WALLET_* (2), UBER_DIRECT_* (5), POSTMARK_API_TOKEN, SENDGRID_API_KEY, MARKETING_EMAIL_FROM, MARKETING_PREF_BASE, MARKETING_WEBHOOK_BASE, MARKETING_SANDBOX, REVIEW_BO_BASE, REVIEW_CARD_BASE, XERO_APP_BASE, WIFI_SECRET, OTP_HMAC_SECRET, PLATFORM_SERVICE_KEY. For staging most can be sandbox (Stripe test, Ryft sandbox, ADYEN_ENV=test, STUART_ENV=sandbox); only the Supabase URLs/keys and CUSTOMER_DOMAIN must be real. Three set-but-unused secrets can be pruned: SUPABASE_JWKS, SUPABASE_PUBLISHABLE_KEYS, SUPABASE_SECRET_KEYS.

## 17. CUSTOMER_DOMAIN value cannot be verified and drives customer-facing links in gift, loyalty and welcome emails

- **Owner:** peter  · **Effort:** minutes

send-welcome:39, gift-resend:21, gift-fulfill:43 and wallet-pass:35 all read `CUSTOMER_DOMAIN ?? 'serv-os.app'`. The secret is set on the Ops project but the Management API returns a digest, not the plaintext, so it cannot be confirmed from here. If it currently reads 'serv-os.app' while the app runs on the dev tier, gift and loyalty emails are already sending customers to prod-tier URLs that do not match the environment that issued them. Peter should confirm the value in the dashboard and set it per tier (stage.serv-os.app for staging).


---

# LOW (6)

## 1. wf-rate-changes-daily has never executed — verify its first run

- **Owner:** claude  · **Effort:** 5 min (tomorrow)

cron.job jobid 3, schedule '5 3 * * *', active=true, created today by supabase/migrations/20260804_wf_rate_changes.sql:102. Zero rows in cron.job_run_details. apply_due_wf_rate_changes() is SECURITY DEFINER with no role guard, so unlike terminal_jobs_sweep it should succeed. 0 scheduled rows to apply right now, so nothing is at risk — but confirm the first successful run before trusting it in staging.

## 2. PWA manifest map is out of sync with the mode dispatch in both directions

- **Owner:** claude  · **Effort:** minutes

public/manifest-{bar,kds,tables,orders}.json advertise start_url '/?mode=bar' etc., but App.jsx has no branch for any of them — installing those PWAs lands on plain POS. Conversely the map at index.html:20-27 omits admin, customer-display and ryft-test, so those install as 'Serv OS POS' with the POS manifest. backoffice is correctly aliased to office at line 19. Worth reconciling before staging so every installed home-screen icon opens the surface it claims.

## 3. Tooling and a handful of edge functions hardcode prod hosts, so they cannot target or correctly serve staging

- **Owner:** claude  · **Effort:** hours

scripts/check-deploys.mjs:19 pins `const PROJECT = 'tbetcegmszzotrwdtqhi'` — it cannot audit a staging project. scripts/screenshots.mjs:19,23,24 pins possystem-liard.vercel.app, LOC 7218c716-…, PIN 1111 and 7 device UUIDs. Edge-function prod fallbacks: adyen-create-session/index.ts:73 (return_url), review-request/index.ts:23, review-google/index.ts:25, wallet-pass/index.ts:338 (origins allowlist) all default to possystem-liard.vercel.app; xero-connect/index.ts:25 defaults to dev.serv-os.app with XERO_APP_BASE unset, so prod Xero OAuth currently redirects to the dev host. src/backoffice/sections/wifi/WifiSetup.jsx:179 prints the prod Supabase host in walled-garden setup instructions. Note the codebase is otherwise clean on tenant IDs — the only UUID literal in all of src/ is the nil UUID at src/lib/ops/checklists.js:113.

## 4. waitlist-sms-inbound exists in the repo but has never been deployed

- **Owner:** claude  · **Effort:** minutes

117 functions are deployed to the Ops project against 118 function directories in supabase/functions; the missing slug is waitlist-sms-inbound. scripts/check-deploys.mjs reports clean because it only compares commit time against deploy time for functions that already exist remotely — it cannot see a function that was never deployed at all. Worth extending the script to flag repo dirs with no remote counterpart. Also record for staging provisioning that 113 of 117 are verify_jwt=false; the four that verify JWT and must NOT get --no-verify-jwt are stripe-update-reader-display, gift-branding-public, send-sms and terminal-job-reconcile.

## 5. stock-deplete and promo-redeem accept unauthenticated writes from the open internet

- **Owner:** peter  · **Effort:** Design decision; if fenced, ~half a day to add a device/venue token check to both

Both are verify_jwt=false, use SERVICE_ROLE, and perform no caller check whatsoever — by documented design (their own headers say 'verify_jwt=false; accepts anon (kiosk/online) + authenticated callers'). stock-deplete/index.ts:123-155 takes {location_id, check_id, items} from any caller and posts post_stock_movement rows against that venue's ledger. promo-redeem/index.ts:66+ lets any caller validate or redeem promo codes for any location_id (the compare-and-swap makes it race-safe, not authorised). Not deploy drift, and not urgent with no live venues — but worth an explicit decision before staging, since both are reachable with nothing but the function URL. For contrast, workforce-onboarding (unguessable token) and adyen-terminal-events (basic auth, fails closed) are correctly gated.

## 6. Confirm the Vercel plan allows 4 sub-hourly crons (moot if pg_cron takes over)

- **Owner:** peter  · **Effort:** 5 min

vercel.json declares 4 cron jobs at */2, */5, */5 and hourly. Vercel Hobby caps at 2 jobs, once-daily; Pro is required for this configuration. Custom domains on dev.pos-up.com suggest Pro already, but it has never been exercised because the crons have never run. Becomes irrelevant if the crons block is deleted in favour of pg_cron, which is the recommendation.


---

# Full auditor reports



## RLS / multi-tenant security

> All findings below were read from the **live databases today (2026-08-04)**, not from docs or comments. Where a doc/migration disagreed with the DB, the DB wins and I say so.

---

# HEADLINE

**Stage 1 is done. Stage 2 is ~65% done by accident (105 of 161 ops tables are genuinely fenced). But a single unapplied migration makes all of it worthless, and the Platform DB has no fence at all.**

Do **not** start Stage 3 until items 1–5 are closed. Stage 3 makes `claim_device()` and `is_super_admin()` the entire tenant boundary — and both are currently broken.

---

# 1. BLOCKER — anyone can mint themselves `super_admin` with just the public anon key

The live function (`pg_get_functiondef` on ops DB, today):

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER      -- no search_path
AS $function$
  insert into public.user_profiles (id, email, full_name, role, bo_access)
  values (new.id, new.email, ...,
          coalesce(new.raw_user_meta_data->>'role','owner'),   -- ← CLIENT-SUPPLIED
          case when new.is_anonymous then false else true end)
$function$
```

- Trigger `on_auth_user_created AFTER INSERT ON auth.users` — **confirmed live**.
- Anonymous sign-in is **enabled and in heavy use**: `auth.users` = 366 rows, **358 anonymous**.
- `supabase.auth.signInAnonymously({ options:{ data:{ role:'super_admin' }}})` → `user_profiles.role = 'super_admin'` → `is_super_admin()` returns true.
- **38 live policies across 33 tables** are `... OR is_super_admin()`. That includes everything Stage 2 has already fenced: `bar_tabs`, `menu_items`, `floor_tables`, `closed_checks`, `staff_members`, `cash_drawers`, `shifts`, `drawer_sessions`.

**The fix already exists and was never applied**: `possystem/supabase/migrations/20260721d_handle_new_user_no_client_role.sql` (written 21 Jul, replaces the coalesce with the literal `'owner'` and pins `search_path`). The live DB still has the vulnerable body.

**This is the one thing to run today.** Every other fence is decorative until it lands.

---

# 2. BLOCKER — proven cross-tenant read as an anonymous JWT (ops DB)

I ran a read-only probe under a real anonymous user's JWT claims. Visible rows vs actual rows:

| table | anon JWT sees | actual |
|---|---|---|
| `locations` | **6** | 6 |
| `organisations` | **5** | 5 |
| `user_profiles` | **366** | 366 |
| `closed_checks` | **379** | 397 |
| `kds_tickets` | **710** | 710 |
| `print_jobs` | **724** | 724 |
| `config_pushes` | **638** | 638 |
| `devices` | **19** | 19 |
| `receipt_emails` | **35** | 35 |
| `customers` | **7** | 7 |
| `user_locations` | **11** | 11 |
| `tax_rates` / `printers` / `discounts` / `stock_levels` | all | all |

*(Correctly fenced and returning 0: `wf_staff`, `wf_timesheets`, `table_reservations`; partial: `staff_members` 4/10, `closed_checks` 379/397.)*

Three root causes:

**(a) 15 literal allow-all policies** — `USING(true) WITH CHECK(true)`, cmd=`ALL`, role=`public`:
`active_sessions`, `activity_events`, `device_profiles`, `devices`, `eighty_six`, `item_variants`, `kds_tickets`, `locations`, `modifier_options`, `order_queue`, `organisations`, `table_reservations`, `user_locations`, `user_profiles`, `stamp_transactions` — all still named `"allow all"`.

**(b) 15 policies fenced only on `auth.role()`** — and an anonymous sign-in **is** `role='authenticated'`, so these fence nothing:
`config_pushes`, `discount_rules`, `discounts`, `locations`, `menu_categories`, `menu_category_links`, `menus`, `organisations`, `print_routing`, `printer_agents`, `printer_health`, `printers`, `stock_levels`, `tax_rates`, `user_profiles`.

**(c) the `is_anonymous` escape hatch** — my automated allow-all detector missed these because the expression isn't literally `true`:

```sql
-- customers_all / customer_locations_all / customer_orders_all  (cmd=ALL, role=public)
USING ( org_id IN (...user's orgs...)
        OR auth.uid() IS NULL
        OR ((auth.jwt() ->> 'is_anonymous')::boolean = true) )   -- ← always true for kiosk/QR/online
```

`customers` carries `phone, phone_raw, email, name, birthday, allergens, marketing_opt_in, notes`. Any anonymous session can **SELECT / UPDATE / DELETE every venue's customer PII**, and a raw anon key (no session, `auth.uid() IS NULL`) can INSERT. This came from a deliberate "fix" (changelog v-entry: *"Policy now adds OR is_anonymous=true clause"*) — it fixed the symptom by removing the fence.

---

# 3. BLOCKER — the Platform DB has effectively no tenant fence, and it cannot be fixed by SQL alone

`src/lib/supabase.js:20`
```js
export const platformSupabase = (PLATFORM_URL && PLATFORM_ANON)
  ? createClient(PLATFORM_URL, PLATFORM_ANON, { auth: { persistSession: false } })
  : null;
```

**`persistSession:false` means every platform query the browser makes runs as the raw `anon` role — there is never a user JWT.** That is *why* every platform policy is `true`. You cannot tighten the platform DB until this changes.

There are **17 direct browser writes** to platform tables (all as anon):
`AdminBillingManager.jsx:312` (`platform_settings`), `Challenge21.jsx:135,159`, `MultiLocation.jsx:55`, `MenuAppearance.jsx:169`, `OnlineOrdering.jsx:263,278`, `ReviewCard.jsx:157` (all `locations`), `CardReaders.jsx:781` (`location_reader_settings`), `LoyaltyManager.jsx:1532,1538,1625,1745,1835,1838,1855,1857`.

Worst live policies on platform (REF `yhzjgyrkyjabvhblqxzu`):

| policy | table | effect |
|---|---|---|
| `locations_anon_update` — `UPDATE`, public, `USING(true) WITH CHECK(true)` | `locations` | any anon-key holder can rewrite **`ops_db_url`**, `payment_processor`, `currency`, `qr_service_charge_pct`, `online_slug`, `stripe_terminal_location_id` for **any** venue. Rewriting `ops_db_url` is a full pivot. |
| `anon can read user_access` — `SELECT true` to `anon` | `user_access` | every platform user's **email + role + company** |
| `bs_read_all` / `inv_read_all` — `SELECT true` to anon | `billing_state`, `billing_invoices` | every merchant's **GMV, tier, fees, transfer IDs** |
| `msa_read_all` — `SELECT true` to anon | `merchant_stripe_accounts` | `stripe_account_id` + **your markup %** per merchant |
| `ps_read` — `SELECT true` to authenticated | `platform_settings` | **`ryft_cost_percent`** — your cost basis and every default markup |
| `pd_read_all` / `pd_*_bt` | `payment_devices` | serials, `registration_code`, `ip_address` readable by anon; bluetooth rows **insertable/updatable/deletable by anon with no location fence** |
| `service_all` — `ALL true` | `customer_loyalty`, `loyalty_config`, `loyalty_earning_rules`, `loyalty_rewards`, `loyalty_tiers`, `stamp_card_programs`, `customer_stamp_cards`, `gift_card_purchases` | read **and write** every customer's points balance, earning rules, stamp programs, gift purchases |

The changelog is explicit that `locations_anon_update` was a knowing shortcut (*"This unblocks Save immediately. Tighten the predicate later"*). It was never tightened.

**Correctly locked (RLS on, zero policies → service_role only):** `merchant_adyen_accounts`, `adyen_payments`, `adyen_payouts`, `adyen_payout_lines`, `merchant_adyen_disputes`, `adyen_webhook_events` — **your item (e) checks out**. No client code touches them (grep of `src/` finds only a changelog mention), so the no-policy posture is correct, not accidental. Same for `ryft_payments`, `ryft_webhook_events`, `stripe_webhook_events`, `merchant_ryft_disputes`, `loyalty_otp_codes`, `message_templates`.

**On ops, `wf_rate_changes` is fenced** — 4 per-command policies on `user_accessible_locations()`. One caveat: `location_id` is **nullable** there, and a NULL fails the predicate, so a null-location row would be invisible to everyone.

---

# 4. BLOCKER — the Stage-3 tenant boundary is a 90,000-value guess

`src/backoffice/sections/DeviceRegistry.jsx:21`
```js
const ADJECTIVES = ['APPLE','BAKER','CEDAR','DONUT','EMBER','FROST','GROVE','HONEY','IVORY','JAZZY'];
const genCode = () => `${ADJECTIVES[Math.floor(Math.random()*10)]}-${Math.floor(1000+Math.random()*9000)}`;
```

10 × 9000 = **90,000 codes**, from `Math.random()`. And the live `claim_device`:

```sql
CREATE FUNCTION public.claim_device(p_code text) RETURNS uuid SECURITY DEFINER ...
  select id, location_id into v_id, v_loc from public.devices
  where pairing_code = upper(trim(p_code)) and status <> 'removed' limit 1;   -- ← any device, incl. ACTIVE
  update public.devices set device_uid = auth.uid(), last_seen = now() where id = v_id;
```

- **EXECUTE granted to `anon`** (confirmed via `has_function_privilege`).
- **No rate limit. No expiry. No "must be unpaired" check.**
- **Codes are never cleared**: all 14 `active` devices still carry a `pairing_code` (`length = 10`).

So post-Stage-3, ~90k RPC calls gets an attacker `pos_can_access(location_id)` for a real venue — full read/write of that venue's `closed_checks`, `staff_members`, `cash_drawers`, `customers`, `order_queue` — **and simultaneously kicks the real till off its own RLS identity** by overwriting `device_uid`.

Contrast `claim_ops_device()`, which correctly requires the caller to already hold `user_accessible_locations()` for the target. `claim_device` has no such gate.

---

# 5. BLOCKER — there is no migration ledger on either database

```
ERROR: 42P01: relation "supabase_migrations.schema_migrations" does not exist
```
— on **both** ops and platform. The `supabase_migrations` schema does not exist at all.

169 files sit in `possystem/supabase/migrations/`, and applied-ness is genuinely mixed. Verified today:

| migration | status (verified against live objects) |
|---|---|
| `20260713c_pos_device_location_link.sql` | ✅ applied (`claim_device`, `pos_can_access`, `devices.device_uid` all present) |
| `20260721_rls_stage1_low_risk.sql` | ✅ applied (all 9 `*_tenant` policies present) |
| `20260721b_storage_kiosk_assets_lockdown.sql` | ✅ applied |
| `20260721c_rls_lock_user_identity.sql` | ❌ **NOT applied** — `is_anon_session`, `is_privileged_ctx`, `can_claim_location` don't exist; `user_profiles_select_self` missing; the `REVOKE ... FROM anon, authenticated` never ran |
| `20260721d_handle_new_user_no_client_role.sql` | ❌ **NOT applied** (see item 1) |
| `20260721e_modifier_groups_super_admin.sql` | ✅ applied |
| `20260804c_rls_hardening.sql` | ✅ applied today (`bar_tabs_tenant`, `menu_items_write_tenant`, `floor_tables_*_tenant` all live) |

**Consequence for staging:** you cannot build a staging DB by replaying `supabase/migrations/` — you'd get a *different* schema from what's live. Staging must be seeded from `pg_dump --schema-only` of the live ops and platform DBs. This is the same silent-drift failure mode as the edge-function deploy drift, one layer down.

---

# 6. Second-tier findings (verified, not blockers on their own)

**`loc-demo` sentinel is a Stage-3 landmine.** 12 tables have `location_id text NOT NULL DEFAULT 'loc-demo'`: `closed_checks`, `config_pushes`, `discount_rules`, `discounts`, `eighty_six`, `floor_tables`, `kds_tickets`, `menu_categories`, `menu_items`, `menus`, `modifier_groups`, `sections`. **20 rows already sit on it** (`config_pushes` 10, `menu_categories` 6, `menus` 4). `'loc-demo'` is in nobody's `user_accessible_locations()`, so at Stage 3 every write that omits `location_id` gets rejected by `WITH CHECK` — and several writers swallow the error. Drop the defaults before Stage 3.

**Storage policy bug — ops evidence uploads can never succeed from a device.**
```sql
-- policy ops_evidence_device_insert, live
EXISTS (SELECT 1 FROM ops_devices d
        WHERE d.device_uid = auth.uid() AND d.active
          AND (storage.foldername(d.name))[1] = d.location_id::text)
```
`d.name` is the ops_devices **label** ("Ops tablet"), not the storage object path. It should be bare `name` (the object). The device branch is therefore always false.

**Three public buckets are writable by any anonymous session.** `product-images`, `receipt-assets`, `kiosk-assets` are `public = true` with write policies gated only on `auth.role() = 'authenticated'` — no bucket-path/location scoping. Any anon sign-in can overwrite or delete any venue's product images and receipt logos, and host arbitrary files on your domain. (`invoice-scans`, `ops-evidence`, `wf-documents` are correctly private and path-scoped; `app-releases` is public-read with no write policy — correct for APK distribution.)

**`ops_devices` identity churn — this is the root cause of your open `OPS_CHECKLIST_RLS_HANDOVER.md` bug.**
```
name         loc                                    active  has_uid  claimed_at   last_seen_at
Ops tablet   NULL                                   t       t        NULL         2026-07-31   ← most recent
Ops tablet   7218c716-eeb4-4f96-b284-f3500823595c   t       t        2026-07-29   2026-07-29
Ops tablet   NULL                                   t       t        NULL         2026-07-17
Ops tablet   NULL                                   t       t        NULL         2026-06-29
```
`register_ops_device()` keys on `device_uid = auth.uid()`. When the anonymous uid rotates, it **inserts a brand-new row with `location_id` NULL** instead of re-claiming. `ops_can_write()` requires `d.location_id = p_location_id` — NULL never matches → every checklist write is rejected. The doc's "prime suspect: location mismatch" was right; it's a NULL, on the newest row. **This is the exact failure that will hit POS at Stage 3** whenever `rpos-device.pairingCode` is absent from localStorage.

**`closed_checks` INSERT is still `WITH CHECK (true)`** while its SELECT/UPDATE/DELETE are properly on `pos_can_access`. Anyone can fabricate revenue rows — which feed billing GMV.

**Blanket grants.** `anon` and `authenticated` hold `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` on **159 of 161** ops tables and **all 36** platform tables (`information_schema.role_table_grants`). RLS is the only fence. Note PostgreSQL RLS covers SELECT/INSERT/UPDATE/DELETE/MERGE only — **TRUNCATE is governed purely by the grant**, so no policy you write will ever cover it. (I could not run a live TRUNCATE proof — the sandbox classifier blocked the DDL probe — so treat that as documented behaviour, not a demonstrated exploit. Practical reachability via PostgREST is low; revoke it as defence-in-depth.)

**`user_accessible_locations()` is SECURITY INVOKER** while **136 policies across 63 tables** depend on it. It reads `user_locations` and `user_profiles`, both of which currently have allow-all policies. The moment Stage 3 locks those two down, this helper's behaviour changes under every policy that calls it, with recursion risk. Make it `SECURITY DEFINER` **before** touching `user_profiles`/`user_locations`.

**3 SECURITY DEFINER functions with no `search_path` pin**: `handle_new_user`, `decrement_stock`, `restore_stock`. (67 others are correctly pinned.)

**8 of 19 devices have no `device_uid`** — and 6 of those are `active`/`online` (2 handheld, 1 kiosk, 3 pos). They lose all access at Stage 3 unless they boot with a cached pairing code or re-pair.

---

# 7. What Stage 2 and Stage 3 actually involve now

**Stage 2 is mostly done — 105 of 161 ops tables carry a real fence.** The pattern is proven in production: 37 policies on 27 tables use `pos_can_access`, 136 on 63 tables use `user_accessible_locations()`, and paired anonymous devices exercise them daily (`staff_members`, `cash_drawers`, `shifts`, `closed_checks` since 13 Jul). **The device branch works.** That materially de-risks everything below.

**Stage 2 remainder** — swap policy, don't remove yet:
- Replace the 15 `auth.role()`-only policies with `pos_can_access(location_id) OR is_super_admin()`.
- Replace the `is_anonymous` escape hatch on `customers` / `customer_locations` / `customer_orders`.
- Add `pos_can_access` policies alongside the 15 remaining `"allow all"` policies.

**Stage 3** = drop the `"allow all"` policies, plus the two things Stage 3 *actually* depends on that nobody has done: **fix `claim_device` hardening (item 4) and the `loc-demo` defaults (item 6)**.

**Public-checkout carve-outs — the exact list.** These run with an anonymous JWT and no paired device, so they need explicit narrow policies:

| table | commands | callers |
|---|---|---|
| `order_queue` | INSERT, UPDATE | `online/OnlineCheckout.jsx:885,995` · `qr/QrCheckout.jsx:231,425` · `catering/CateringCheckout.jsx:154,192` · `qr/TabResumeScreen.jsx:129` |
| `closed_checks` | INSERT | `OnlineCheckout.jsx:934,1069` · `QrCheckout.jsx:440` · `CateringCheckout.jsx:207` · `TabResumeScreen.jsx:138` |
| `customers`, `customer_locations`, `customer_orders` | INSERT, UPDATE | `src/lib/customerLookup.js:227,292,296,355,361,374` |
| `active_sessions` | UPSERT, DELETE | `src/lib/qrTableSession.js:63,88` (QR table sessions) |
| **read-only** for storefront | SELECT | `menus`, `menu_categories`, `menu_category_links`, `menu_items`, `modifier_groups`, `modifier_options`, `floor_tables`, `eighty_six`, `stock_levels`, `stock_units`, `menu_boards`, `locations` |

Two notes on that list:
- There is **no "publicly orderable" flag on ops `locations`** (columns are `id, org_id, name, address, timezone, currency, status, ...`). `online_enabled` / `qr_enabled` live on **platform** `locations`, which ops RLS cannot see. You need either `locations.status = 'active'` as the gate or a new `public_ordering_enabled boolean` on ops `locations`. (This is the same trap that made a previous attempt reference a non-existent `locations.published`.)
- `item_variants`, `modifier_options`, `receipt_emails`, `stock_units`, `printer_agents`, `stamp_transactions` show **zero direct client writes** in `src/`. Strong candidates for service-role-only (RLS on, no policy) rather than a carve-out.

---

# 8. Recommended sequencing — yes, go straight to the end state, but in this order

No live data means you should skip the "alongside" dance and cut straight through. The gates matter more than the stages.

**Gate 0 — today, no app release needed.** Pure SQL, nothing can break:
1. Apply `20260721d` (kills the super_admin escalation).
2. `ALTER FUNCTION user_accessible_locations() SECURITY DEFINER` + pin `search_path` on the 3 unpinned functions.
3. `REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated` (both DBs).
4. Fix the `storage.foldername(d.name)` → `(name)` typo — this also unblocks the open checklist bug.
5. Drop the 12 `DEFAULT 'loc-demo'` clauses and repoint the 20 orphan rows.

**Gate 1 — one app release, then SQL.** Harden pairing before it becomes load-bearing:
- `genCode()` → `crypto.getRandomValues`, ≥8 chars from an unambiguous alphabet (~10¹² space).
- `claim_device` → only match `status = 'unpaired' OR device_uid IS NULL`; add an expiry column; clear `pairing_code` on successful pair; add a fail counter like `terminal_staff_login` already has.
- Make `claimPairedDeviceOnBoot` **loud** (surface "device needs re-pairing") instead of `console.warn` — otherwise Stage 3 lockouts are invisible.
- Re-pair the 6 active/online devices that have no `device_uid`.

**Gate 2 — build staging, and cut it over FIRST.**
- `pg_dump --schema-only` both live DBs → `000_baseline.sql`. **Start a real migration ledger from that baseline.** Don't try to replay the 169 files.
- Apply the **full end-state RLS** to staging only: drop every allow-all, add the carve-outs above, re-grant per-command instead of `ALL`.
- Run the whole matrix on staging: POS pair → order → close; KDS; kiosk; online; QR (incl. tab resume); catering; waitlist; ops checklist; back office save paths; **realtime** (18 tables are in `supabase_realtime` and Postgres Changes enforces RLS per subscriber — a device that fails `pos_can_access` silently stops receiving updates).
- Only then apply the identical script to dev, and carry it to prod as the same file.

**Gate 3 — Platform DB. This one is an app change, not a SQL change.**
`persistSession:false` must go. Either give `platformSupabase` the real BO session (the BO already holds one on the ops client), or move the 17 writes behind edge functions. Until one of those ships, `locations_anon_update` and friends **cannot** be tightened without breaking the back office. Treat this as its own workstream — it is the single largest piece of remaining work and it is on the critical path to go-live, because it exposes your cost basis and every merchant's GMV.

**One judgement call worth flagging:** items 1, 3 and 4 mean the current dev environment should be treated as **already compromised-capable** — anyone who has ever had the anon key (it ships in the browser bundle) could have taken super_admin at any point since 21 Jul. Forensics today show only 1 super_admin and it is non-anonymous, so there is no evidence of exploitation. But rotate both projects' anon keys as part of the staging cutover, and don't carry any dev secrets into staging.

---

# 9. Evidence index

- Ops policy dump: `pg_policies` on `tbetcegmszzotrwdtqhi` — 283 policies, 161 tables, **0 with RLS disabled**, 18 with RLS on and no policies.
- Grants: `information_schema.role_table_grants` — 159/161 ops and 36/36 platform tables grant full DML+TRUNCATE to both `anon` and `authenticated`.
- `pos_can_access` exists in **two overloads** (`text`, `uuid`), both `SECURITY DEFINER`, both checking user-locations → paired `devices` → `ops_devices`.
- `devices`: 19 rows, **11 with `device_uid`**, 8 without. `ops_devices` 4/4, `waitlist_devices` 5/5.
- Key files: `possystem/src/lib/supabase.js:20` (platform client), `:105-123` (`ensureAuthToken`), `:136-152` (`claimPairedDeviceOnBoot`); `possystem/src/backoffice/sections/DeviceRegistry.jsx:20-21` (`genCode`); `possystem/src/surfaces/PairingScreen.jsx:38-66`; `possystem/supabase/migrations/20260721c_rls_lock_user_identity.sql` and `20260721d_handle_new_user_no_client_role.sql` (both unapplied); `possystem/OPS_CHECKLIST_RLS_HANDOVER.md` (now root-caused).
- pg_cron on ops: 3 jobs (`xero-nightly-sales`, `paxpay-sweep` @ every minute, `wf-rate-changes-daily`) — these need recreating on staging; they are not in any migration.


## Deploy integrity

# AUDIT 2 — DEPLOY INTEGRITY (code that exists but isn't running)

Repo: `/Users/peterroberts/Library/CloudStorage/Dropbox/POSUP/Claude Code/Test POS app/possystem`
HEAD: `b01b0b3` v5.5.973 (2026-08-04). Ops DB `tbetcegmszzotrwdtqhi` (117 edge fns), Platform DB `yhzjgyrkyjabvhblqxzu` (0 edge fns, 0 secrets).

**Headline: the tool you rely on to detect drift is itself broken in both directions.** It reported 7 stale functions — all 7 are actually identical to the repo. It missed 15 that genuinely differ, and 1 that was never deployed at all. Separately, one repo migration that closes a *confirmed live privilege-escalation path* has never been applied.

---

## (a) `scripts/check-deploys.mjs` output — and why it's wrong

### Raw output (full drift list as reported)
```
⚠ 7 edge function(s) NOT LIVE with committed code:
   stripe-assign-reader-to-pos        18 days behind
   stripe-sync-location-reader-config 5 days behind
   stripe-link-merchant               2.6h behind
   stripe-terminal-connection-token   2.6h behind
   stripe-webhook                     2.6h behind
   ryft-tab                           1.4h behind
   ryft-create-payment-session        1.4h behind
```

### Ground truth (byte-diff of deployed source vs repo)
I pulled every function's deployed bundle from `GET /v1/projects/{ref}/functions/{slug}/body`, extracted the original TypeScript from the embedded sourcemap `sourcesContent`, and diffed it against the repo file. That is the actual source Deno is running, not a timestamp guess.

**All 7 flagged functions are byte-identical to the repo.** Verified by probe: `stripe-assign-reader-to-pos` reports `updated_at = 2026-05-05` but its deployed source contains `customer_display_enabled` (added 2026-05-23, commit `f0d422d`). `stripe-sync-location-reader-config` contains `stripe_s700` and `updatedTerminalLocations` (added 2026-05-23, `edfee75`). The three `stripe-*` "2.6h" hits already carry `esm.sh/stripe@14.21.0?target=denonext`, i.e. the post-commit code. **Supabase's `updated_at` is stale for these functions — the script's whole signal is unreliable.**

### Three structural defects in the script

1. **False positives** — `scripts/check-deploys.mjs:36` compares `git log -1 -- supabase/functions/<slug>` against `fn.updated_at`. `updated_at` does not reliably advance on redeploy. 7/7 flagged were clean.
2. **False negatives (the serious one)** — line 33 scopes the git check to `supabase/functions/${fn.slug}` only. **`_shared/*.ts` is inlined into every consumer bundle at deploy time.** Editing `_shared/ryft.ts` or `_shared/hubrise-map.ts` never touches the slug directory, so the script is structurally blind to it. That is where 13 of the 15 real drifts live.
3. It iterates the **remote** list, so a function that was never deployed can never appear (see BLOCKER-6).

### The REAL drift list — 15 functions running source that differs from the repo

| Function | Drifted file | Δ | Functional? |
|---|---|---|---|
| **hubrise-inventory-push** | `_shared/hubrise-ingest.ts`, `hubrise-map.ts`, `hubrise.ts` | +181/-10, +189/-7, +16/-6 | **YES** |
| **hubrise-order-status** | `_shared/hubrise-ingest.ts`, `hubrise-map.ts`, `hubrise.ts` | +152/-0, +121/-5, +2/-1 | **YES** |
| **hubrise-webhook** | `_shared/hubrise-map.ts` | +9/-2 | **YES — wrong VAT** |
| **hubrise-reconcile** | `_shared/hubrise-map.ts` | +9/-2 | **YES — wrong VAT** |
| catering-release | `_shared/hubrise.ts` | +2/-1 | no (dead `getCatalog` export) |
| uber-direct | `_shared/hubrise.ts` | +2/-1 | no |
| ryft-terminal-cancel | `_shared/ryft.ts` | +116/-12 | no (additive + types) |
| ryft-refund / ryft-disputes / payments-onboard | `_shared/ryft.ts` | +16/-2 | no (type-only) |
| ryft-terminal-payment / -poll / ryft-terminals | `_shared/ryft.ts` | +7/-0 | no (unused `getTerminal`) |
| send-welcome | `_shared/message-types.ts` | +19/-0 | no (type fields it doesn't read) |
| stripe-update-reader-display | `index.ts` | +40/-7 | no (comments + one log prefix) |

**The one that costs money:** `hubrise-webhook` and `hubrise-reconcile` run pre-v5.5.857 `_shared/hubrise-map.ts`. Deployed `resolveTaxFrac` returns `0` when an item has no explicit `tax_rate_id`; the repo version falls back to the venue's default rate:
```diff
-    const r = rid != null ? rateById.get(String(rid)) : null;
+    const r = rid != null ? rateById.get(String(rid)) : defaultRate;
```
Every inbound Deliveroo / UberEats / JustEat order booked through the live webhook is therefore recorded with **zero VAT** on any item that relies on "Use default". `hubrise-inventory-push`/`-order-status` are much further behind and are missing the allergen-vocabulary normaliser that stops HubRise 422-ing the whole catalog PUT.

---

## (b) MIGRATIONS — 169 files, **no tracking table on either DB**

```sql
select schemaname, tablename from pg_tables where schemaname='supabase_migrations';
-- 0 rows on tbetcegmszzotrwdtqhi AND on yhzjgyrkyjabvhblqxzu
```
Only `auth.schema_migrations`, `realtime.schema_migrations`, `storage.migrations` exist — all Supabase-internal. **Every one of the 169 migrations has been applied by hand with no record of which.** That is the root cause of everything below and the biggest risk to a staging cutover: there is no way to replay the folder onto a fresh project and know you got the same schema.

I inferred state by extracting every created object (tables, columns, functions, indexes, policies, triggers, constraints, views) from each file and checking existence in both live DBs (2,199 + 518 columns, 82 + 8 routines, 283 + 39 policies, plus the `storage` schema separately).

### Good news: the most recent 25 are clean
`20260729e` → `20260804d` are **all APPLIED**, including `20260801_PLATFORM_adyen_foundation` (18/18), `20260804c_rls_hardening` (6/6), `20260804_wf_rate_changes` (9/9). `20260804b_realtime_prune.sql` is applied too — `pos_nudges`, `modifier_groups`, `print_routing`, `terminal_devices`, `terminal_jobs` are all absent from `pg_publication_tables where pubname='supabase_realtime'`.

### GENUINELY UNAPPLIED

**1. `20260721c_rls_lock_user_identity.sql` (503 lines) — CRITICAL, see BLOCKER-1.**
```sql
select proname from pg_proc join pg_namespace ... where nspname='public' and proname in
 ('is_anon_session','is_privileged_ctx','can_claim_location','guard_user_profiles','guard_user_locations','set_bo_access');
-- 0 rows
```
Would create: 5 defence layers over `user_profiles`/`user_locations` — a fixed `handle_new_user()`, 6 helper/guard functions, ~14 replacement RLS policies, revoked `anon`/`authenticated` DML, a CHECK constraint and FK.

**2. `20260727c_saas_billing.sql` — Platform DB, NOT APPLIED.**
```sql
-- PLATFORM: select tablename from pg_tables where schemaname='public' and tablename like '%billing%';
--   billing_state, billing_invoices     ← legacy v2 schema only
-- missing: billing_plans, billing_usage, billing_charges, billing_usage_seen
-- missing: accrue_gtv(), plan_for_gtv(), idx_billing_usage_period, uniq_billing_charge_real_per_period
```
Would create the usage-triggered SaaS billing engine (Free/Growth/Scale at £0/£149/£299 by GTV) plus the UNIQUE index that is the *only* thing preventing a double-charge in a period. The migration's own header states the legacy counter `billing_state.gmv_this_month` **has never been incremented** (`incrementGmv()` has zero call sites), so today every venue reads £0. `src/lib/billingPlans.js:13` already treats `billing_plans` as the server's source of truth.

**3. `20260430_order_number_counter.sql` — NOT APPLIED.** No `location_order_counters` table, no `next_order_number(text)` function. `src/lib/db.js:58` RPCs it on every order and `src/lib/db.js:65` logs `"— using local fallback. Apply v5.5.8 migration to fix."` So all order refs still come from the collision-prone local generator this migration was written to replace, plus a wasted failing round-trip per order.

**4. `20260430_staff_auth_link.sql` — NOT APPLIED.** `staff_members.auth_user_id` absent, `staff_members_auth_user_id_unique` absent. `src/backoffice/sections/StaffManager.jsx:77-80` detects this and degrades (its own warning names the migration). BO-access linking for staff records is dead.

**5. `20260722_terminal_devices.sql` — PARTIAL.** Only `td_select` exists live; `td_delete` (file line 83) is missing. Client-side retire/delete of a PAX terminal is blocked (edge fns using service_role still work).

### Verified NOT blockers (checked, don't waste time)
- `20260429_tenant_rls` (1/57), `20260429_crm_tenant_rls` (1/11), `20260422_multi_location`, `20260430_super_admin_select` — **deliberately reverted**. `20260804c_rls_hardening.sql` names it: *"the exact 'tables vanishing' regression that forced the original revert of 20260429_tenant_rls"*. But these files still sit in `supabase/migrations/` in filename order — a landmine for anyone replaying the folder onto staging.
- `20260611b/c/d` platform Ryft pricing — superseded by `20260611e_platform_ryft_markup_only.sql`, which **is** applied (`markup_percent`, `markup_fixed_pence`, `default_ryft_markup_percent`, `default_ryft_markup_fixed_pence` all present on Platform).
- `20260625_active_sessions_audit` — intentionally torn down 13 Jul.
- `20260525_loyalty_core` missing `idx_loyalty_tx_idempotency` — harmless, the UNIQUE constraint `loyalty_transactions_idempotency_key_key` exists and provides the index.
- `20260729d`, `20260627`, `20260608`, `20260713`, `20260621g`, `20260622b`, `20260629` flagged PARTIAL — all false positives from `execute format('... %1$I_rls ...')` DO-loops. Live policies confirmed present under the generated names (`inventory_items_sel/_upd/_del/_write`, `production_batches_*`, `waste_events_*`, `prep_schedule_*`).
- `20260609`, `20260713b`, `20260715c`, `20260721b`, `20260729b` — storage-schema policies, all present in `pg_policies where schemaname='storage'`.

---

## (c) SECRETS — 39 referenced but not set on Ops; Platform has ZERO

42 secrets set on `tbetcegmszzotrwdtqhi`. **0 on `yhzjgyrkyjabvhblqxzu`** (it has no edge functions, so that's consistent — but it means the Ops service-role key is the sole gate to the entire Platform DB).

### Required-for-core-flow — must resolve before staging
| Secret | Consumer | Behaviour when unset |
|---|---|---|
| `PLATFORM_SERVICE_KEY` | `wallet-pass/index.ts:34`, `send-welcome/index.ts:38`, `order-notify/index.ts:30` | **Naming split.** `order-notify` falls back to `PLATFORM_SUPABASE_SERVICE_ROLE_KEY`; **`wallet-pass` does not** — `platformDb` becomes `null` (line 50) and wallet passes are dead. `send-welcome` declares it and never uses it. |
| `POSTMARK_API_TOKEN`, `SENDGRID_API_KEY` | `send-receipt/index.ts:151,169`, `marketing-send/index.ts:148,159`, `order-notify:35`, `send-welcome:48` | Only `RESEND_API_KEY` is set. These **throw** if `RECEIPT_EMAIL_PROVIDER` points at them. Also: provider defaults to `'log'` in all four functions — **Peter must confirm the live value is `resend`, not `log`**, or every receipt and order notification is silently discarded. (I was blocked from reading secret values.) |
| `OTP_HMAC_SECRET` | `loyalty-otp/index.ts:48`, `wallet-pass:71` | Falls back to `SUPABASE_SERVICE_ROLE_KEY`. Works — but couples loyalty OTP signing to the service key; rotating either silently invalidates the other. |
| `WIFI_SECRET` | `_shared/wifi-crypto.ts:17` | Same fallback-to-service-role coupling. Rotating the service key silently invalidates every stored UniFi binding. |
| `MARKETING_SANDBOX` | `marketing-send/index.ts:44` | Unset = **live sends**. On staging this means real emails/SMS to real customers. Must be `true` on the staging project. |
| `REVIEW_CARD_BASE`, `REVIEW_BO_BASE` | `review-request/index.ts:23`, `review-google/index.ts:25` | Default to hardcoded `https://possystem-liard.vercel.app`. Staging review links would point at the dev Vercel deploy. |
| `MARKETING_EMAIL_FROM`, `MARKETING_PREF_BASE`, `MARKETING_WEBHOOK_BASE` | `marketing-send/index.ts:37,46,48` | Sane defaults; set on staging so preference/unsub links resolve to the staging host. |

### Optional / expected-absent
- `ADYEN_*` (14) — Adyen not onboarded. All 5 `adyen-*` functions are deployed and will fail closed.
- `UBER_DIRECT_*` (7) — Uber Direct courier entirely non-functional; Stuart is the live courier and its 4 secrets **are** set.
- `APPLE_*` (5) + `GOOGLE_WALLET_*` (2) — wallet passes deferred.
- `XERO_APP_BASE` — `xero-connect` only.

---

## (d) verify_jwt — no `config.toml` exists anywhere in the repo

`find . -name config.toml -not -path ./node_modules/*` → **nothing**. `verify_jwt` exists only as remote per-function state set at deploy time. It is not declared, not reviewed, and **not reproducible on a new project**.

**Current live state:** 113 functions `verify_jwt=false`, 4 `verify_jwt=true`:

| Function | Verdict |
|---|---|
| `gift-branding-public` | Works (`giftHelpers.js:36` sends the anon key as Bearer, which satisfies the gateway) but the function's own header says *"public endpoint … without auth"*. Inconsistent; harmless. |
| `send-sms` | Works. Server callers pass `SERVICE_ROLE` (`order-notify:80`, `review-request:34`); client passes a session token (`waitlistSlice.js:542`, `wfData.js:116`) — but that call is `...(token ? {Authorization} : {})`, so a null token yields a **silent 401 at the gateway**. |
| `stripe-update-reader-display` | Correct. `readerDisplay.js:91` early-returns without a token. |
| `terminal-job-reconcile` | No live caller found (`UnresolvedPayments.jsx:31` explicitly says why it doesn't use it). Fine. |

### Two concrete hazards

1. **`scripts/check-deploys.mjs:58` will silently open those 4 functions.** The `--deploy` path hardcodes `--no-verify-jwt` for *every* stale function. One run flips `gift-branding-public`, `send-sms`, `stripe-update-reader-display` and `terminal-job-reconcile` from JWT-gated to fully public. `send-sms` becoming public is an open SMS-spend relay.
2. **A fresh staging project will 401 every third-party webhook.** `supabase functions deploy` defaults `verify_jwt=TRUE`. These 9 receive no Supabase JWT and would be rejected at the gateway before the handler runs: `stripe-webhook`, `stripe-webhook-connect`, `ryft-webhook`, `adyen-webhook`, `hubrise-webhook`, `uber-webhook`, `stuart-webhook`, `marketing-webhook`, `waitlist-sms-inbound`. Payments would appear to work and then never settle.

**Fix:** commit `supabase/config.toml` with an explicit `[functions.<slug>] verify_jwt` line for all 117, and delete the blanket `--no-verify-jwt` from `check-deploys.mjs`.

### Design note (not drift, but worth a decision before real money)
Two `verify_jwt=false` functions use `SERVICE_ROLE` with **no caller auth whatsoever** — by documented design:
- `stock-deplete/index.ts:123-155` — any internet caller can POST `{location_id, check_id, items}` and write `post_stock_movement` rows against any venue.
- `promo-redeem/index.ts:66+` — any caller can `validate`/`redeem` promo codes for any `location_id`.

`workforce-onboarding` (unguessable token) and `adyen-terminal-events` (basic auth, fails closed) are correctly gated. `wifi-capture`, `review-submit`, `gift-purchase-status`, `gift-branding-public` are intentionally public.

### Scheduling sanity check
Ops `cron.job` holds 3 pure-SQL jobs (`xero-nightly-sales`, `paxpay-sweep`, `wf-rate-changes-daily`) — no HTTP, so no verify_jwt exposure. External scheduling runs from `vercel.json` crons (`/api/marketing-cron`, `/api/hubrise-cron`, `/api/ops-cron`, `/api/catering-cron`), which must be re-pointed for staging.

---

## Cross-cutting recommendation for staging cutover

The deep byte-diff harness I built for this audit is the thing you actually need — it reads the deployed bundle and compares real source *including* `_shared/`. I'd replace `check-deploys.mjs`'s timestamp heuristic with it before cutover; otherwise staging inherits the same blindness that let `_shared/hubrise-map.ts` sit two months stale on the live webhook.

Also: move the 6 reverted/superseded migrations (`20260422_multi_location`, `20260429_tenant_rls`, `20260429_crm_tenant_rls`, `20260430_super_admin_select`, `20260611b/c/d`, `20260625_active_sessions_audit`) into `supabase/migrations/_superseded/` so a staging replay in filename order cannot resurrect the tables-vanishing regression.


## Scheduled automations

## AUDIT 3 — SCHEDULED AUTOMATIONS

**Headline:** of the 8 things in this repo that need a timer, **1 works**, **1 is scheduled but has failed 20,538 times in a row**, **1 has never fired yet**, and **5 have no trigger at all**. Standing up staging does **not** fix them — it makes 4 of them wake up pointed at the **wrong database**.

---

### (a) vercel.json — confirmed

`/Users/peterroberts/.../possystem/vercel.json` lines 5-10:

| path | schedule | route file exists? |
|---|---|---|
| `/api/marketing-cron` | `0 * * * *` (hourly) | ✅ `api/marketing-cron.js` |
| `/api/hubrise-cron` | `*/2 * * * *` | ✅ `api/hubrise-cron.js` |
| `/api/ops-cron` | `*/5 * * * *` | ✅ `api/ops-cron.js` |
| `/api/catering-cron` | `*/5 * * * *` | ✅ `api/catering-cron.js` |

All four are **deployed and reachable**, and `CRON_SECRET` **is** set on Vercel — I probed both hosts and got `401 {"error":"unauthorised"}`, not the `500 CRON_SECRET not set` fail-secure branch:

```
https://dev.pos-up.com/api/{marketing,ops,catering,hubrise}-cron        -> 401
https://possystem-liard.vercel.app/api/{...}-cron                        -> 401
```

All four Supabase-side run-secrets also exist (`MARKETING_RUN_SECRET`, `OPS_ESCALATE_SECRET`, `CATERING_RELEASE_SECRET`, `HUBRISE_RECONCILE_SECRET`). **The wiring is complete. Only the trigger is missing.**

⚠ **`DEV_ENVIRONMENT.md:10`** — `develop -> staging -> main` maps to `dev / stage / app.pos-up.com` in **one Vercel project**. Only `main` is Production. **Standing up staging will NOT wake these crons.** They stay dormant until `main` ships.

⚠ **Hardcoded DEV fallback in all four routes** — `marketing-cron.js:36`, `hubrise-cron.js:32`, `ops-cron.js:23`, `catering-cron.js:24`:
```js
process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://tbetcegmszzotrwdtqhi.supabase.co'
```
If staging/prod ever runs these without `SUPABASE_URL` set, it silently drives the **dev Ops DB**.

---

### (b) LIVE OPS DB (`tbetcegmszzotrwdtqhi`)

**pg_cron 1.6.4 and pg_net 0.20.0 are both installed.** Platform DB (`yhzjgyrkyjabvhblqxzu`) has **neither** — and needs neither (0 sweeper/cleanup functions there).

`SELECT jobname, schedule, command, active FROM cron.job`:

| jobid | jobname | schedule | command | active |
|---|---|---|---|---|
| 1 | `xero-nightly-sales` | `10 4 * * *` | `select public.xero_nightly_post()` | t |
| 2 | `paxpay-sweep` | `* * * * *` | `select public.terminal_jobs_sweep(200);` | t |
| 3 | `wf-rate-changes-daily` | `5 3 * * *` | `select public.apply_due_wf_rate_changes();` | t |

`cron.job_run_details`:

| jobid | status | runs | first | last |
|---|---|---|---|---|
| 1 | **succeeded** | 20 | 2026-07-16 04:10 | 2026-08-04 04:10 |
| 2 | **failed** | **20,538** | 2026-07-21 20:29 | 2026-08-05 02:46 |
| 3 | — | **0 (never run)** | — | — |

#### 🔴 `paxpay-sweep` — 100% failure rate, every minute, for 15 days

```
ERROR:  service role required
CONTEXT:  PL/pgSQL function terminal_jobs_sweep(integer) line 4 at RAISE
```

Root cause — `terminal_jobs_sweep()` line 4 calls `_terminal_is_service_role()`, which reads a **PostgREST** GUC that pg_cron never sets:
```sql
select coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb ->> 'role','') = 'service_role'
```
pg_cron runs as `current_user = postgres` with **no JWT claims** → always false → the sweep aborts before doing any work. The migration that scheduled it (`supabase/migrations/20260724_terminal_retire_and_sweep.sql:136`) even carries the comment *"terminal_jobs_sweep() has existed since 20260722c and has never once run"* — it still hasn't.

**I verified the fix works** (read-only, on the live DB):
```sql
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public._terminal_is_service_role();   -- → true, as current_user=postgres
```

Blast radius today is contained only by luck: `terminal_jobs` has 63 rows and **0 currently expired-and-unswept**. `retire_terminal_device()` (same migration, ~line 101) does the identical expiry inline, which has been masking the gap.

#### 🟠 `wf-rate-changes-daily` — created but never fired
Zero rows in `job_run_details`. Job was created today (`supabase/migrations/20260804_wf_rate_changes.sql:102`); next tick is 03:05 UTC. `apply_due_wf_rate_changes()` is SECURITY DEFINER with **no role guard**, so it will succeed when it fires. 0 scheduled rows to apply, so nothing is currently at risk. **Verify tomorrow.**

#### 🟢 `xero-nightly-sales` — genuinely working
20/20 succeeded. `net._http_response` id 47, `2026-08-04 04:10:00`, **status 200**, body `{"ok":true,"empty":true,"date":"2026-08-03"}`. **This is the proven pg_cron → pg_net → edge-function pattern to copy** — it authenticates with vault secret `xero_cron_key` (which `xero-sales/index.ts:45` byte-compares against `SUPABASE_SERVICE_ROLE_KEY`).

⚠ But `xero_nightly_post()` **hardcodes** `https://tbetcegmszzotrwdtqhi.supabase.co` in its body. A staging DB restored from this one will POST to the **dev** project.

#### 🟠 `cron.job_run_details` grows unbounded
20,565 rows / 5,496 kB, **+1,441/day**, no purge job. Mostly the paxpay failures.

---

### (c) Every schedule-dependent feature — what fires it TODAY

| # | Feature | Fired today by | Works in staging? |
|---|---|---|---|
| 1 | **Marketing automations** (birthday / lapsed / recurring / forecast) — `_shared/campaign-engine.ts:321` | **Nothing.** Only the BO "Run now" button. **Evidence: all 4 `campaign_runs` rows have `run_key` containing `:force:`** — zero scheduled runs, ever | ❌ No |
| 2 | **Scheduled one-off campaigns** (`status='scheduled'` + `schedule.send_at`) — `campaign-engine.ts:331` | Nothing. A BO user can schedule a send that **silently never sends** | ❌ No |
| 3 | **Drip workflows** — `_shared/workflow-engine.ts`, driven by `marketing-run` | Nothing (0 workflows exist, so no evidence yet) | ❌ No |
| 4 | **Sending-domain health refresh** — `marketing-run/index.ts:51` | Nothing. Domain status goes stale | ❌ No |
| 5 | **Ops / HACCP breach escalation** — `ops-escalate` | **Nothing. Never run once.** 🔴 See below | ❌ No |
| 6 | **Catering scheduled fire** — `catering-release` | Server side dead. **Client fallback only:** `SyncBridge.jsx:551` → `store/index.js:2298 releaseDueCateringOrders`, 60 s timer, **MASTER DEVICE ONLY**, with a **2-hour floor** (`sync/staleness.js:17`). Miss the window → order never reaches the kitchen. **1 catering row already sits with `kitchen_routed_at IS NULL`** | ⚠ Device-dependent |
| 7 | **HubRise passive-event drain + status-push retry** — `hubrise-reconcile` | Nothing. Active webhook still works (47 events, 0 unprocessed) — but **anything the webhook misses is never recovered** | ❌ No |
| 8 | **PaxPay terminal sweeper (DB)** — `terminal_jobs_sweep()` | `paxpay-sweep` — **scheduled, 100% failing** | ❌ Broken |
| 9 | **PaxPay sweeper (edge fn)** — `terminal-job-reconcile/index.ts:3` *"Runs on a schedule (cron)"* | **Nothing.** Deployed v3, never scheduled anywhere. **Two sweepers, neither running** | ❌ No |
| 10 | **Workforce rate-change applier** — `apply_due_wf_rate_changes()` | `wf-rate-changes-daily` (never fired yet) + a lazy BO fallback when the rates screen opens | ✅ Likely — verify |
| 11 | **Xero nightly sales** — `xero_nightly_post()` | `xero-nightly-sales` — **working** | ✅ but hardcoded URL |
| 12 | **Review "ask" engine** — `review-request` `scan_all`, `index.ts:9,111` *"service-role; cron"* | **Nothing — not even a dormant Vercel cron.** Only manual scan/`send_now` from `ReviewTriggers.jsx:182,196`. The growth engine never runs by itself | ❌ No |
| 13 | **Review inbound platform sync** — `review-sync/index.ts:11` *"for a scheduled cron"* | **Nothing.** Worse: `review-sync/index.ts:57-58` **requires `ops_location_id`** and has **no fan-out action** — a cron literally cannot drive it as written | ❌ No — needs code |
| 14 | Session reconciler / `active_sessions` self-heal — `SessionReconciler.js:197` | Device-side 10 s timer | ✅ Device-dependent, not scheduled |
| 15 | Boot staleness + scheduled collection orders — `SyncBridge.jsx:545` | Device-side 60 s timer, master-only | ✅ Device-dependent |
| 16 | Print stuck-job reclaim — `PrintOrchestrator.js:138` | Device-side 15 s timer | ✅ Device-dependent |
| 17 | Order notifications | **DB trigger** `order_queue_notify` (verified enabled, `tgenabled='O'`) — event-driven, not scheduled | ✅ Yes |
| 18 | Platform DB (billing/overage) | Nothing scheduled and nothing needs to be — `api/stripe-capture.js` and `api/stripe-charge-overage.js` are POS-invoked, not crons | ✅ N/A |

#### 🔴 The single most damning piece of evidence

`ops_alerts` on the live Ops DB:

```
id       ce724fab-b1e5-41ba-8933-5be981a4b22f
type     temp_breach
severity critical
title    "Chest freezer breach · 8°C"
status   sent
escalation_step 0
acknowledged_at NULL
created_at 2026-06-29 20:52:48+00
```

A **critical food-safety breach, unacknowledged for 36 days, escalation_step still 0**. All 3 `ops_alerts` rows are in this state. The HACCP escalation ladder — SMS + email to the MOD, the reason the module exists — **has never fired a single time**. There is 1 `ops_notification_rules` row waiting for it.

#### 🟠 Marketing is NOT sandboxed
`MARKETING_SANDBOX` is **absent** from the 42 Supabase secrets, while `RESEND_API_KEY`, `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER` are all present → `marketing-send/index.ts:284` evaluates `sandbox = false`. `marketing_messages` already shows **6 `sent` + 1 `opened`** — real mail has gone out. When the hourly cron wakes, it sends for real.

Blast radius **today** is small: 7 customers / 4 opted in, and the one `active` campaign is `type='one_off'`, which `runDueCampaigns` (`campaign-engine.ts:324`) filters out (`.eq('type','automation')`). But this must be a **deliberate per-environment decision** before staging clones this data.

✅ **No deploy drift** — `node scripts/check-deploys.mjs` → *"every edge function is live with its committed code"* (117 deployed).

---

### (d) Recommended fix — pg_cron + pg_net, exact jobs

**Why pg_cron and not Vercel:** with one Vercel project and `develop → staging → main`, staging is never "Production", so Vercel crons stay dormant through the entire staging phase. pg_cron lives **inside each database**, so staging schedules staging's work and prod schedules prod's — no cross-environment bleed, and no `SUPABASE_URL`-fallback landmine. It is also already proven working here (xero, HTTP 200).

**Step 0 — kill the hardcoded-URL class of bug (do this first).** Put both the bearer and the base URL in vault so a restored staging DB can't call dev:

```sql
-- Peter: run once per environment, in the Supabase SQL editor (needs the service-role key)
select vault.create_secret('<THIS PROJECT service_role key>', 'edge_cron_key', 'pg_cron → edge fns');
select vault.create_secret('https://<THIS PROJECT ref>.supabase.co', 'edge_fn_base', 'this env base URL');
```

```sql
-- claude: one caller, URL + key in exactly one place
create or replace function public.call_edge_fn(p_fn text, p_body jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare k text; base text;
begin
  select decrypted_secret into k    from vault.decrypted_secrets where name='edge_cron_key' limit 1;
  select decrypted_secret into base from vault.decrypted_secrets where name='edge_fn_base'  limit 1;
  if k is null or base is null then
    raise warning 'call_edge_fn: vault not configured for this environment — %', p_fn;
    return null;
  end if;
  return net.http_post(
    url     := base || '/functions/v1/' || p_fn,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||k),
    body    := p_body,
    timeout_milliseconds := 25000);
end $$;
revoke execute on function public.call_edge_fn(text,jsonb) from public, anon, authenticated;
```
Then rewrite `xero_nightly_post()` to use `call_edge_fn('xero-sales', …)` instead of its hardcoded URL.

**Step 1 — unbreak `paxpay-sweep` (highest priority):**
```sql
select cron.alter_job(
  (select jobid from cron.job where jobname='paxpay-sweep'),
  command := $$select set_config('request.jwt.claims','{"role":"service_role"}',true);
              select public.terminal_jobs_sweep(200);$$);
```
Verified: the GUC survives into the SECURITY DEFINER call in the same transaction, and the fence stays intact for every other caller. (Cleaner long-term: a `terminal_jobs_sweep_cron()` wrapper that sets the claim, `revoke`d from `public/anon/authenticated`.) Then **decide**: keep the DB sweep and leave `terminal-job-reconcile` as manual/ops-only, or retire the DB job and schedule the edge fn — **do not run both.**

**Step 2 — the exact jobs to create:**
```sql
-- replaces the 4 dormant Vercel crons, same cadences
select cron.schedule('marketing-run-hourly',   '0 * * * *',  $$select public.call_edge_fn('marketing-run')$$);
select cron.schedule('ops-escalate-5min',      '*/5 * * * *',$$select public.call_edge_fn('ops-escalate')$$);
select cron.schedule('catering-release-5min',  '*/5 * * * *',$$select public.call_edge_fn('catering-release')$$);
select cron.schedule('hubrise-reconcile-2min', '*/2 * * * *',$$select public.call_edge_fn('hubrise-reconcile')$$);

-- never had ANY scheduler
select cron.schedule('review-request-scan',    '0 * * * *',
  $$select public.call_edge_fn('review-request', '{"action":"scan_all"}'::jsonb)$$);
-- review-sync: schedule ONLY after adding a sync_all fan-out (see below)
-- select cron.schedule('review-sync-6h','0 */6 * * *',
--   $$select public.call_edge_fn('review-sync', '{"action":"sync_all"}'::jsonb)$$);

-- hygiene
select cron.schedule('cron-log-purge', '30 2 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
```

**Step 3 — code change:** add a `sync_all` service-role branch to `supabase/functions/review-sync/index.ts` (it currently 400s without `ops_location_id` at line 58), mirroring `review-request`'s `scan_all` at line 112.

**Step 4 — delete the `crons` block from `vercel.json`.** Once pg_cron owns the schedule, leaving it in means the day `main` ships you get **double-firing** — plus the dev-URL fallback fires with it. Keep the `api/*-cron.js` routes as manual/emergency triggers; they're fail-secure and already 401 correctly.

**Step 5 — per-environment gate before staging goes live:** set `MARKETING_SANDBOX=true` on staging (and confirm `false` on prod), so a cloned customer table can't be mailed for real by the newly-woken hourly job.


## Silent-failure sweep

## AUDIT 4 — SILENT FAILURE SWEEP (Back Office writers)

Repo: `/Users/peterroberts/Library/CloudStorage/Dropbox/POSUP/Claude Code/Test POS app/possystem`
Code state verified at **v5.5.973** (`src/lib/version.js:1`). Live DB queried, not assumed.

---

## 0. The headline (read this first)

**Two structural facts make almost every "protected" BO writer in this codebase a decoration:**

**1. `supabase-js` never throws.** No `.throwOnError()` anywhere; client built plain at `src/lib/supabase.js:8` and `:20`, `@supabase/supabase-js ^2.103.0`. So this extremely common pattern **cannot ever fire its catch** for a real Postgres/RLS/PostgREST error:
```js
try { await supabase.from('x').update(y).eq('id', id); } catch (e) { console.warn(...) }
```
The error lands in the discarded `{ error }` object. The `catch` only ever sees network/JS faults. **~40 sites in the BO use exactly this shape.**

**2. RLS denial is a filter, not an error.** A blocked `.update()`/`.delete()` returns `error: null` and **0 rows**. Only **3 files in the entire repo** check row counts: `ReceiptBranding.jsx`, `StaffManager.jsx`, `DeviceProfiles.jsx`.

**Staging-specific danger:** the writers below currently *succeed* partly because Ops DB still has permissive policies. Verified live:
- `locations` → policy **`allow all`**, `USING true / WITH CHECK true`, roles `{public}`
- `device_profiles` → policy **`allow all`**, `USING true / WITH CHECK true`
- `tax_rates`, `discounts`, `discount_rules`, `print_routing` → only `auth.role() = 'authenticated'`

**The moment you tighten RLS for staging, dozens of currently-working writers start failing — and every one of them fails silently.** Fix the swallowing *before* the RLS work, not after.

---

## (a) Silent-failure write paths — full sweep

### A1. `try { await supabase… } catch {}` — the catch can never fire
| File:line | Writer | Operator sees on failure |
|---|---|---|
| `src/backoffice/sections/PrintRouting.jsx:39-47` | `saveRoutingToDB` — print centres + category routing | **Nothing.** `save(data)` writes localStorage *first* (line 41), so this browser shows the new routing forever |
| `src/backoffice/sections/PrintRouting.jsx:73-87` | `saveVenueReceiptPrinter` | Nothing; localStorage mirrored first (line 75) |
| `src/backoffice/sections/PrinterRegistry.jsx:75-80` | `savePrinterToDB` (upsert) | Nothing; `savePrinters()` writes localStorage separately |
| `src/backoffice/sections/PrinterRegistry.jsx:82-85` | `deletePrinterFromDB` | Nothing |
| `src/backoffice/sections/LocationSettings.jsx:304-311` | `address`, `show_item_images`, `pos_settings.takeaway_customer_details` | **"Saved" ✓** — the *first* update (platform DB, line 281) is checked; this second one is `catch {}` |
| `src/backoffice/sections/PrintMenu.jsx:149-153` | debounced print-menu autosave | **"saved"** badge; `catch` sets `''` but never runs |
| `src/backoffice/sections/Challenge21.jsx:159` | `resetCounter` | Counter shows 0 locally; DB unchanged |
| `src/backoffice/LocationSwitcher.jsx:129-133` | `user_profiles.location_id` on venue switch | Page reloads; wrong location silently persists |
| `src/backoffice/sections/MenuBoards.jsx:103` | `retireScreen` delete | Screen reappears on reload |
| `src/backoffice/sections/CompanyAdmin.jsx:76-83` | link creating user → new org | `✓ "X" created`; owner ends up with no org |
| `src/backoffice/sections/LoyaltyManager.jsx:1622-1627` | delete loyalty tier (`catch {}`) | Row reappears |
| `src/store/index.js:4319-4324` | `challenge_21_counter` increment | Local counter advances, DB does not |

### A2. `console.error` / `console.warn` only — no user feedback
| File:line | Writer | Operator sees |
|---|---|---|
| `src/lib/db.js:1596-1598` | `upsertDiscount` | logs only, returns `{error}` to a caller that ignores it |
| `src/lib/db.js:1656-1658` | `upsertDiscountRule` | same |
| `src/lib/db.js:344-346` | `upsertFloorTable` | logs only |
| `src/backoffice/sections/DiscountManager.jsx:567,578,608,619` | save/delete discount + rule | **Editor closes = looks saved** |
| `src/backoffice/sections/StaffManager.jsx:251` | new staff member insert | **`"<name> added" success` toast fires anyway** (line 257) |
| `src/backoffice/sections/MenuManager.jsx:1330` | archive a size/variant | `"Size removed"` toast; item still live on kiosk/online |
| `src/backoffice/sections/MenuManager.jsx:2047-2049` | `removeVariant` | `"Variant removed"` toast |
| `src/store/index.js:1174-1187` | `archiveMenuItem` (+ children) | Item vanishes from BO, still orderable |
| `src/store/index.js:4231-4232` | `insertCashMovement` | **returns `row.id` even on failure** — caller believes it recorded |
| `src/store/index.js:3596-3602` | `updateCashDrawer` | nothing |
| `src/store/index.js:3606-3616` | `deleteCashDrawer` | drawer gone from UI, still in DB |
| `src/store/index.js:2816-2817` | `upsertCustomer` update | nothing |
| `src/staff/wfData.js:215` | `softDeleteStaff` | leaver never recorded |
| `src/staff/wfData.js:220` | `markPosUser` | HR↔POS link missing |
| `src/staff/wfData.js:322,395,401,511,595,773,815,872` | delete section / delete shift / **publishShifts** / **decideTimeOff** / delete doc / delete template / saveForecast / **logAudit** | nothing |
| `src/backoffice/sections/Workforce.jsx:141-149` | "Set as POS user" (`staff_members` upsert **+** `markPosUser`) | **`"<name> added as a POS user"` success toast** |
| `src/backoffice/sections/CompanyAdmin.jsx:83` | org link | nothing |

### A3. Unchecked `.update()` / `.delete()` / awaited helper — result discarded
| File:line | Writer | Operator sees |
|---|---|---|
| `src/backoffice/sections/TaxManager.jsx:164` | unset all other `is_default` before setting a new one | nothing → **two default tax rates** |
| `src/backoffice/sections/TaxManager.jsx:182` | delete tax rate | rate reappears after reload, no message |
| `src/backoffice/sections/TaxManager.jsx:187-195` | `seedRates` — inserts in a loop, **zero error handling** | **`✓ 12 rates added`** unconditionally |
| `src/backoffice/sections/TaxManager.jsx:140` | `load()` discards `error`, then pushes result into Zustand (`:144`) | On read failure: `taxRates: []` **and** the "Seed UK rates" buttons appear (`:212`) → double-seed |
| `src/backoffice/sections/DeviceRegistry.jsx:180` | `cancelPairing` delete | orphan device row keeps its pairing code |
| `src/backoffice/sections/DeviceRegistry.jsx:188` | `regenerateCode` | **new code shown on screen, old code still valid in DB** |
| `src/backoffice/sections/DeviceRegistry.jsx:195` | `removeDevice` ("terminal will be locked out immediately") | device keeps trading |
| `src/backoffice/sections/DeviceRegistry.jsx:204-216` | `saveEdit` — profile / centre / **receipt printer** | editor closes; reload shows old values |
| `src/backoffice/sections/Customers.jsx:526-534` | GDPR soft-delete (`deleted_at`) | `onDeleted()` fires, row disappears from UI, **customer not erased** |
| `src/backoffice/sections/MenuBoards.jsx:146` | delete board | reappears |
| `src/backoffice/sections/MultiLocation.jsx:54` | ops-DB `locations.name` (platform one **is** checked at `:55`) | `"Location updated" success` |
| `src/backoffice/sections/LoyaltyManager.jsx:1358` | `loyalty_transactions` ledger insert after a manual points adjust | balance changed, **ledger row missing** |
| `src/backoffice/sections/LoyaltyManager.jsx:1532,1538` | tier update / insert | `"Tier updated" / "Tier created"` |
| `src/backoffice/sections/LoyaltyManager.jsx:1745` | stamp-card program active toggle | toggle flips back on reload |
| `src/backoffice/sections/StockItems.jsx:413` | `upsertParLevel` (par + reorder point) | nothing; `setParBase` already applied |
| `src/backoffice/sections/StockItems.jsx:515,573` | delete conversion bridge / packaging format | row reappears |
| `src/backoffice/sections/StockItems.jsx:574` | `setUnitDefault` (purchase/count default) | wrong unit → wrong PO qty & cost |
| `src/backoffice/sections/StockItems.jsx:680` | delete supplier product (price link) | reappears |
| `src/backoffice/sections/StockCounts.jsx:102,105` | `saveCountLine` (each line + "save all") | counted quantities silently lost |
| `src/backoffice/sections/PurchaseOrders.jsx:157` | `setPOStatus(…, 'CANCELLED')` | PO shows cancelled, still open |
| `src/backoffice/sections/Suppliers.jsx:53` | `setSupplierArchived` | **`'Archived'` toast** |
| `src/backoffice/sections/Recipes.jsx:170` | `setRecipeArchived` | nothing |
| `src/backoffice/sections/operations/OpsNotifications.jsx:69` | `deleteNotificationRule` | **`'Rule removed'` success** |
| `src/backoffice/sections/operations/OpsTemperature.jsx:127` | `upsertSchedule` loop | **`'Saved'` success** |
| `src/backoffice/sections/operations/OpsTemperature.jsx:132` | `deleteSchedule` | nothing |
| `src/backoffice/sections/operations/OpsMaintenance.jsx:39,40,43,46` | status / assign / create / note | **all four toast success** |
| `src/backoffice/sections/operations/OpsDevices.jsx:58` | `removeOpsDevice` | **`'Tablet unpaired'`** |
| `src/surfaces/OperationsSurface.jsx:599,612,646` | HACCP checklist tick / untick / **temperature reading** | task ticks on screen; record never written |
| `src/backoffice/sections/StaffManager.jsx:266` | `deleteMember` — bare fire-and-forget, no `.then` | **`'Staff member removed'`** |
| `src/backoffice/sections/StaffManager.jsx:122-134` | `saveStaffToSupabase` / `deleteStaffFromSupabase` | unchecked (currently unreferenced — dead code, worth deleting) |

### A4. Optimistic setState with no revert
- `src/store/index.js:1193-1203` `updateTableLayout` → `upsertFloorTable(full)` **not awaited**
- `src/store/index.js:1204-1225` `addTableToLayout` → same
- `src/store/index.js:1228-1234` `removeTableFromLayout` → `set()` first, then `deleteFloorTable(…).catch(console.warn)` — **the `.catch` can never fire** (no throw)
- `src/backoffice/sections/DiscountManager.jsx:575-577` — removes from UI *and* pushes the shrunken list into the POS store (`syncToStore`)
- `src/backoffice/sections/Workforce.jsx:132-135` `removeStaff`
- `src/backoffice/sections/workforce/WfLeave.jsx:82-91` — reverts on `throw`, but `decideTimeOff` never throws
- `src/backoffice/sections/StockItems.jsx:411-413` `setParBase` before the write
- `src/backoffice/sections/Challenge21.jsx:159-160`

### A5. Latent bug found while sweeping (not error-related, same damage class)
`src/backoffice/sections/StaffManager.jsx:228` calls `addStaffMember(member)`; `src/store/index.js:289` stamps `id: 's-'+Date.now()`, while the DB insert (`:244`) lets Postgres mint a UUID. The edit path then **deliberately early-returns for `s-` ids**:
```js
// StaffManager.jsx:172
if (String(id).startsWith('s-')) return;   // "Nothing to update server-side"
```
→ **Add a staff member, then immediately set their PIN / role / permissions: every one of those edits is silently discarded until a page refresh.** No error, no toast, no DB row changed. This is live today regardless of RLS.

---

## (b) Which of these are money / config damage

**Money — direct**
- **Tax rates** (`TaxManager.jsx:164,182,187-195`) — wrong VAT on every sale; no DB constraint stops two defaults (verified: `tax_rates` has only `tax_rates_pkey`; currently 1 default per location across 4 locations, so it is clean *now*)
- **Discounts + auto-discount rules** (`DiscountManager.jsx` + `db.js:1596,1656`) — a "deleted" discount is removed from the POS store but still in the DB and returns on the next config push
- **Cash movements** (`store/index.js:4231`) — drops, paid-outs, petty cash; corrupts drawer variance and the Z-report
- **Cash drawers** (`store/index.js:3596,3606`)
- **Loyalty** — points adjusted without a ledger row (`LoyaltyManager.jsx:1358`); tier thresholds (`:1532,1538`)
- **Stock costing** — par levels, unit defaults, supplier price links (`StockItems.jsx:413,574,680`), count lines (`StockCounts.jsx:102`), PO cancel (`PurchaseOrders.jsx:157`)
- **Payroll-adjacent** — rota publish, leave decisions, forecast (`wfData.js:401,511,815`)

**Config — operationally destructive**
- **Printer routing** (`PrintRouting.jsx:39-47,73-87`) + **printer registry** (`PrinterRegistry.jsx:75-85`) — worst of the set: localStorage-first means the editing machine *never* shows the truth
- **Floor plan** (`store/index.js:1193-1234`) — violates the documented "Tables MUST never be lost" invariant
- **Device profiles / registry** (`DeviceRegistry.jsx:180-216`) — revoked terminal keeps trading; stale pairing codes
- **Staff & PINs** (`StaffManager.jsx:228-266`, `Workforce.jsx:141-149`) — staff who can't sign in, or PINs that exist only in one browser tab
- **Menu items / variants** (`MenuManager.jsx:1330,2047`, `store:1174`) — a "removed" size stays orderable at its old price on kiosk/online
- **Menu boards, print menu, location settings, Challenge 21, GDPR erasure, HACCP records**

---

## (c) saveHealth coverage — confirmed by grep

`reportSave` is called from **exactly 4 files, 12 call sites**:

| File | Sites |
|---|---|
| `src/store/index.js` | `:103` menu, `:110` menu delete, `:149` category, `:156` category delete, `:176` item |
| `src/lib/db.js` | `:142` category, `:224` item, `:281` modifier group |
| `src/backoffice/sections/DeviceProfiles.jsx` | `:209,:213,:249,:253,:271` |
| `src/backoffice/sections/MenuManager.jsx` | `:3424,:3427,:3445,:3449,:3496` (quick screen only) |

Consumer: `src/backoffice/BackOfficeApp.jsx:83,199` → `SaveHealthBanner`, mounted at `:520`.

**Not covered (task #82 is still ~90% open):**
- **Every** section in tables A1–A4 above
- Notably: `store/index.js` `archiveMenuItem` (`:1174`) is a **menu** writer and still console-only — the same family saveHealth was built for
- `db.js:344 upsertFloorTable`, `db.js:1596 upsertDiscount`, `db.js:1656 upsertDiscountRule` sit right next to the three that *do* report
- All of `src/staff/wfData.js`, all of `src/lib/stock/*`, all of `src/lib/ops/*`

**Toast rendering:** the v5.5.971 fix (`BackOfficeApp.jsx:179-195`, mounted `:521`) covers the authenticated BO shell only. **`?mode=manager` has the identical original bug** — `App.jsx:272` returns `<ManagerSurface/>` from a branch *before* `ValidatedPOSApp`, which is the only place `<Toast>` renders (`App.jsx:723`). `ManagerSurface.jsx` has zero toast plumbing, and `src/surfaces/OperationsSurface.jsx` (911 lines, HACCP temperature + checklists, rendered inside it via `ManagerOps.jsx:13`) has **no toast and no `showToast` at all**. Same for `MPOSSurface` and `TimeClockSurface`.

---

## (d) Top 10 ranked (damage × likelihood) + quick wins

See the structured `blockers` list. Summary of the ordering logic:

- **Likelihood is high across the board** because expired-JWT is the dominant real-world trigger (`tax_rates`/`discounts`/`discount_rules`/`print_routing` policies are literally `auth.role() = 'authenticated'`, and reads stay alive on the anon SELECT policies — the exact v5.5.951 "Premium Sauces" mechanism), and because the RLS tightening you need for staging will *manufacture* the failure across all of them at once.
- **Damage is highest** where the failure is (i) money, (ii) invisible on the editing machine (localStorage-first), or (iii) accompanied by a success toast.

**Quick wins — now cheap because toasts render (est. 3-4 hours for all of them):**
1. Ship a shared helper, e.g. `src/lib/saveGuard.js`:
   ```js
   export async function guardedSave(entity, promise, { rows = false } = {}) {
     const res = await promise;
     const err = res?.error ||
       (rows && (!res?.data || res.data.length === 0)
         ? new Error(`${entity}: 0 rows matched — RLS or missing row`) : null);
     reportSave(entity, err);
     if (err) useStore.getState().showToast?.(`${entity} NOT saved — ${err.message}`, 'error');
     return { ...res, ok: !err };
   }
   ```
2. Mechanically wrap: `TaxManager` (4 sites), `DiscountManager` (4), `DeviceRegistry` (4), `StaffManager` addMember + deleteMember (2), `LocationSettings:306`, `MultiLocation:54`, `PrintRouting` (2), `PrinterRegistry` (2), `MenuManager:1330/2047`, `store:1174` — that alone is the top 8 blockers.
3. Add `.select('id')` + 0-row check on every `.update()`/`.delete()` against an RLS'd table (copy `ReceiptBranding.jsx:148-156`, the best example in the repo).
4. Add an eslint rule banning `try { await supabase.… } catch` without an `error` destructure — 40 sites of dead code today.
5. Stop the localStorage-first pattern in `PrintRouting`/`PrinterRegistry`: write DB first, cache on success only.
6. DB (cheap now, expensive later): `create unique index tax_rates_one_default on tax_rates (location_id) where is_default;`



## Staging cutover mechanics

## AUDIT 5 — STAGING CUTOVER MECHANICS + CONFIG

**Verified against code + both live Supabase projects on 4 Aug 2026. Repo `develop` @ v5.5.973.**

### Headline: there is currently ONE environment, not three

| Host | Build served | Branch | DB it writes to |
|---|---|---|---|
| `dev.serv-os.app` | `index-XLSWq9fl.js` — **v5.5.973** | develop | Ops `tbetcegmszzotrwdtqhi` + Platform `yhzjgyrkyjabvhblqxzu` |
| `possystem-liard.vercel.app` | `index-XLSWq9fl.js` — **v5.5.973** (identical) | develop | same |
| `app.serv-os.app` | `index-53-am0Ad.js` — **v4.1.0** | main | **same** |
| `stage.serv-os.app` | `index-53-am0Ad.js` — **v4.1.0** (identical alias) | main | **same** |

Evidence: asset hashes fetched from each host; `dev`+`liard` return `/version.json` = `5.5.973`, `app`+`stage` return HTML (no `version.json` — predates v5.5.870). `git show origin/main:src/lib/version.js` = `4.1.0`, `<title>Restaurant OS</title>`, `theme-color #d4881c` — exactly matching the bytes served on `app`/`stage`. `git rev-list --count origin/main..origin/develop` = **1380**.

Three consequences:
- **`stage.serv-os.app` is not a staging environment** — it is a second domain on the stale prod deployment.
- **`app.serv-os.app` is a 3-month-old app with write access to the live database.** Anyone opening it runs v4.1.0 against current data.
- Going live = promoting develop→main, which jumps `app.serv-os.app` from v4.1.0 to v5.5.973 in one step, on a schema that has drifted 1380 commits.

---

### (a) ENTRY POINTS — definitive current list

**Operator surfaces** (`src/App.jsx` dispatch, lines 184–288):

| `?mode=` | Line | Renders | Needs pairing? |
|---|---|---|---|
| `ryft-test` | 190 | `RyftTestSurface` (sandbox only) | no |
| `admin` | 237 | `CompanyAdminApp` | no |
| `kiosk` | 240 | `KioskSurface` | no |
| `customer-display` | 246 | `CustomerDisplaySurface` | no |
| `owner` | 250 | `OwnerSurface` | no |
| `menuboard` | 255 | `MenuBoardSurface` | self-pairs |
| `ops` | 262 | **redirect → `?mode=manager`** (retired v5.5.754) | — |
| `waitlist` | 267 | `WaitlistSurface` | self-pairs |
| `manager` | 272 | `ManagerSurface` | self-pairs |
| `office` / `backoffice` | 275 | `BackOfficeApp` (lazy) | no — email login |
| `mpos` | 284 | `MPOSSurface` | **yes** |
| `clock` | 288 | `TimeClockSurface` | **yes** |
| *(none / `pos`)* | 292 | `ValidatedPOSApp` → POS, or **KDS** if `pairedDevice.type==='kds'` (App.jsx:677) | **yes** |

**Customer surfaces** (`src/lib/customerUrl.js`, all path-based on `<slug>.<CUSTOMER_ROOT>`):

`/` → online · `/t/<id>` → qr · `/gift` · `/gift/balance` · `/gift/success` · `/account` · `/review` · `/wifi` · `/guest/...` (UniFi portal → wifi) · `/catering` · `/waitlist` · `/waitlist/status`

Non-slug customer paths (work on any host): `/order/<groupSlug>` (group picker), `/cater/<groupSlug>` (catering picker), `/sign/<token>` (workforce contract signing, App.jsx:187).

Query-param fallback for pre-DNS testing: `?loc=<slug>&surface=<mode>`.

**Dead / broken:**
- **`/k` is dead.** `customerUrl.js:130` parses it to `mode:'kiosk'`, but `CUSTOMER_MODES` at `App.jsx:184` does **not** include `'kiosk'` — so `<slug>.serv-os.app/k` falls through to the operator dispatch and shows the pairing screen. (Also a loose match: `/kitchen`, `/knowledge` etc. all hit it.)
- **`?mode=ai` does not exist.** The AI assistant is an in-POS surface (`surface==='ai'`, App.jsx:720), not a mode. Memory note is stale.
- **`?mode=staff` removed** (folded into BO Workforce).
- **4 dead PWA manifests**: `public/manifest-{bar,kds,tables,orders}.json` advertise `start_url:/?mode=bar` etc., but no dispatch branch exists — installing them lands on plain POS.
- **3 modes have no manifest** (`index.html:20-27` map): `admin`, `customer-display`, `ryft-test` → all silently install as "Serv OS POS". `backoffice` is correctly aliased to `office` at line 19.

---

### (b) NATIVE APPS — what each points at TODAY

| Module | Constant | file:line | Points at |
|---|---|---|---|
| `:app` (POS) | `POS_URL` | `android/app/src/main/java/co/posup/rpos/MainActivity.java:16` | `https://possystem-liard.vercel.app/?mode=pos` |
| `:app` rear screen | `DISPLAY_URL` | `android/app/src/main/java/co/posup/rpos/CustomerDisplayPresentation.java:25` | `https://possystem-liard.vercel.app/?mode=customer-display` |
| `:mpos` | `MPOS_URL` | `android/mpos/src/main/java/co/posup/rpos/mpos/MainActivity.java:31` | `https://dev.serv-os.app/?mode=mpos` |
| `:menuboard` | `MENUBOARD_URL` | `android/menuboard/src/main/java/co/posup/rpos/menuboard/MainActivity.java:24` | `https://dev.serv-os.app/?mode=menuboard` |
| `:paxpay` | `supabaseUrl` (native, no WebView) | `android/paxpay/build.gradle:46` | Ops project, overridable via `PAXPAY_SUPABASE_URL` |

**Correction to memory:** the note "POS APK→prod, MPOS/menuboard→dev" is wrong. `possystem-liard.vercel.app` and `dev.serv-os.app` serve byte-identical bundles — **all three WebView apps point at the develop build today.**

**What must change for staging:**

1. **POS URL** — `MainActivity.java:16`.
2. **POS WebView origin allowlist** — `MainActivity.java:89-90`:
   ```java
   return !url.startsWith("https://possystem-liard.vercel.app") &&
          !url.startsWith("https://tbetcegmszzotrwdtqhi.supabase.co");
   ```
   `shouldOverrideUrlLoading` returns `true` = **block**. Change `POS_URL` without changing this and every staging navigation is blocked. Both the app host **and** the staging Supabase host must be added.
3. **Rear-display URL** — `CustomerDisplayPresentation.java:25` (separate constant, easy to miss).
4. **MPOS / menuboard URLs** — one line each. Neither has an origin check, so only the constant changes.
5. **No build flavors exist.** `grep buildConfigField|productFlavors` over `:app`, `:mpos`, `:menuboard` returns nothing — only `:paxpay` reads config from gradle properties/env. Retargeting requires **editing Java and rebuilding**, so a staging APK is a distinct artifact, not a runtime switch.

**Self-update implication — this is the sharp edge:**

`UpdateChecker.MANIFEST_URL` is hardcoded to the **production Ops bucket** in every module (`app/…/UpdateChecker.java:56`, `mpos:54`, `menuboard:41`, `paxpay:54`) — all four read `tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/app-releases/latest*.json`. There is one update channel, and it is prod's.

So: **flash a staging APK, and within 3 hours it downloads and installs the prod-pointing APK over itself.** Same `applicationId`, same signing key, so it installs in place and the device silently becomes a prod terminal. Staging needs either a separate bucket per tier or a `-staging` applicationId with its own manifest name.

Also live drift: repo `android/release/latest.json` says `versionCode 11 / "2.0"`, but the published manifest in storage says `versionCode 10 / "1.9"`. The v2.0 POS build (NFC sign-in) was never announced to tills.

---

### (c) ENV / SECRETS MATRIX

**Frontend (`VITE_*`)** — 11 vars referenced. `src/lib/supabase.js:4-20` and `src/lib/env.js:14-15`:

| Var | Must be real for staging? | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | **REAL** | Ops project. Empty ⇒ `isMock=true` (supabase.js:6) — app silently runs on fixtures |
| `VITE_SUPABASE_ANON_KEY` | **REAL** | same |
| `VITE_PLATFORM_SUPABASE_URL` | **REAL** | Platform project |
| `VITE_PLATFORM_SUPABASE_ANON_KEY` | **REAL** | empty ⇒ `platformSupabase = null` ⇒ every customer surface dies |
| `VITE_APP_TIER` | **REAL** — set to `stage` | drives `CUSTOMER_ROOT` (env.js:23) and `OPERATOR_HOST` (env.js:86). **Not set in `.env.local`** — defaults to `'dev'` |
| `VITE_CUSTOMER_DOMAIN` | real | defaults `serv-os.app` |
| `VITE_USE_MOCK` | `false` | |
| `VITE_STRIPE_PUBLISHABLE_KEY` | **test key fine** | |
| `VITE_STRIPE_TERMINAL_LOCATION_ID` | test | |
| `VITE_MAPBOX_TOKEN` | test | |

`.env.example` documents only 5 of these — it is missing both `VITE_PLATFORM_*` vars, which are load-bearing.

**Edge functions** — code reads **77** distinct env names; **42** are set on the Ops project. Platform project has **0 functions deployed** (all 117 live on Ops and reach Platform via `PLATFORM_SUPABASE_SERVICE_ROLE_KEY`) — good, staging only needs one functions project.

*Must be real:* `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL` (auto-injected by Supabase — free), plus `PLATFORM_SUPABASE_URL` + `PLATFORM_SUPABASE_SERVICE_ROLE_KEY` (**manual**), plus `CUSTOMER_DOMAIN` (must be `stage.serv-os.app`).

*Can be sandbox:* Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`), Ryft (`RYFT_*`, `RYFT_API_BASE` → sandbox), Twilio (`TWILIO_*` — test creds or a real cheap number), Resend/Postmark/SendGrid, Adyen (`ADYEN_ENV=test`), Stuart (`STUART_ENV=sandbox`), Uber Direct, HubRise, Xero.

*Shared secrets that must match Vercel:* `MARKETING_RUN_SECRET`, `OPS_ESCALATE_SECRET`, `HUBRISE_RECONCILE_SECRET`, `CATERING_RELEASE_SECRET`, `CRON_SECRET` — the four `api/*-cron.js` handlers 500 if their pair is unset.

**39 secrets are read by code but not set today** — the whole Adyen block (14), Apple Wallet (5), Google Wallet (2), Uber Direct (5), plus `POSTMARK_API_TOKEN`, `SENDGRID_API_KEY`, `MARKETING_EMAIL_FROM`, `MARKETING_*_BASE`, `REVIEW_BO_BASE`, `REVIEW_CARD_BASE`, `XERO_APP_BASE`, `WIFI_SECRET`, `OTP_HMAC_SECRET`, `PLATFORM_SERVICE_KEY`.

**Two live bugs surfaced by that diff:**
- `supabase/functions/send-welcome/index.ts:38` and `supabase/functions/wallet-pass/index.ts:34` read `PLATFORM_SERVICE_KEY` **with no fallback** (`?? ''`). It is not set. `order-notify/index.ts:30` gets it right (`PLATFORM_SUPABASE_SERVICE_ROLE_KEY ?? PLATFORM_SERVICE_KEY`). Those two functions cannot reach the Platform DB today.
- `supabase/functions/xero-connect/index.ts:25` — `XERO_APP_BASE || 'https://dev.serv-os.app'`. Unset, so prod Xero OAuth redirects to the dev host.

**Env-derived crypto — not portable:** `OTP_HMAC_SECRET` (`loyalty-otp:48`) and `WIFI_SECRET` (`_shared/wifi-crypto.ts:17`) both fall back to `SUPABASE_SERVICE_ROLE_KEY`. Since the service-role key differs per project, **restoring a prod DB snapshot into staging silently breaks every stored WiFi binding and invalidates loyalty OTP tokens.** Set both explicitly before any snapshot restore.

`waitlist-sms-inbound` exists in the repo but is **not deployed** (117 deployed vs 118 repo dirs). `check-deploys.mjs` reports clean otherwise. 113 of 117 are `verify_jwt=false`; the 4 that verify JWT are `stripe-update-reader-display`, `gift-branding-public`, `send-sms`, `terminal-job-reconcile` — these must **not** get `--no-verify-jwt` when redeployed to staging.

---

### (d) DATA — there is no seed path, and no reproducible schema

**This is the biggest blocker.** A staging Supabase project cannot be built from this repo.

- **No migration tracking on either project.** `select … from supabase_migrations.schema_migrations` → `42P01: relation does not exist` on **both** `tbetcegmszzotrwdtqhi` and `yhzjgyrkyjabvhblqxzu`. There is no `supabase/config.toml`. Migrations have only ever been applied by hand.
- **25 live Ops tables have no `CREATE TABLE` anywhere in the repo.** Diffing the 161 live base tables against every `create table` across `supabase/migrations/` (169 files), `migrations/` (24 files) and the root `supabase-*.sql`:

  `active_sessions, cash_drawers, cash_movements, customer_locations, customer_orders, customers, device_heartbeats, device_profiles, drawer_sessions, floor_tables, item_variants, modifier_groups, modifier_options, print_jobs, print_routing, printer_agents, printer_health, printers, sections, shifts, sms_messages, staff_members, stamp_transactions, stock_levels, tax_rates`

  Spot-checked individually: `staff_members`, `tax_rates`, `device_profiles`, `printers`, `modifier_groups`, `customers`, `shifts` → **0 files** contain a CREATE TABLE. These are core POS tables, not edge cases.

  **The only viable path is `pg_dump --schema-only` from both live projects** → replay into staging. Needs the DB password.

**Seed/fixture:** none for a venue.
- `supabase/migrations/20260628_ops_demo_seed.sql` seeds **only Ops-module content** (temp units, checklists, one maintenance request) and is hardcoded to `loc uuid := '7218c716-…'`. No menu, no staff, no devices.
- `src/data/seed.js` / `src/staff/seed.js` are in-browser mock data for `VITE_USE_MOCK`, not DB seeds.
- `scripts/screenshots.mjs` **assumes** a fully-populated venue — it hardcodes `LOC = '7218c716-…'`, `PIN = '1111'`, and 7 pre-existing device UUIDs. It is a consumer of a seeded venue, not a producer.

**Minimum data for a venue to function** (measured against the working demo venue `7218c716-…`):

| Table | Demo count | Required? |
|---|---|---|
| Ops `locations` | 1 | **yes** |
| Platform `locations` (+ `companies`) | 1 | **yes** — created by the `provision-location` edge fn, which mirrors Ops→Platform. Without it every platform feature errors "No platform row found" |
| `staff_members` | 4 | **yes** — at least 1 with a PIN |
| `devices` | 8 | **yes** — 1 per surface; reusing one trips the session-kick |
| `device_profiles` | 4 | **yes** |
| `tax_rates` | 3 | **yes** |
| `menus` / `menu_categories` / `menu_items` | 2 / 27 / 151 | **yes** — ≥1 each |
| `floor_tables` | 26 | only for table service |
| `printers` | 1 | only for kitchen printing |
| `cash_drawers` | 1 | only for cash |
| `sections` | 0 | optional |

Recommended: write a `scripts/seed-venue.mjs` that takes a slug and provisions all of the above + calls `provision-location`. It does not exist.

---

### (e) HARDCODED PRODUCTION HOSTS / IDs

**Frontend — ships to the browser, bypasses the configured client (worst offenders):**
- `src/admin/CompanyAdminApp.jsx:330` — `fetch('https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/create-user', …)`
- `src/backoffice/sections/StaffManager.jsx:303` — identical hardcoded call

  These are the **only two** absolute edge-function URLs in `src/`. A staging Back Office would create users in the **production** Ops project.
- `src/backoffice/sections/wifi/WifiSetup.jsx:179` — prints `tbetcegmszzotrwdtqhi.supabase.co` as walled-garden setup text (cosmetic, but wrong instructions on staging).
- `src/lib/customerUrl.js:32` — `possystem-liard` in `NON_SLUG_SUBDOMAINS` (harmless, but note `'stage'` is already reserved there, which is correct).

**Vercel serverless — silent prod fallback:**
- `api/ops-cron.js:23`, `api/marketing-cron.js:36`, `api/hubrise-cron.js:32`, `api/catering-cron.js:24` all do:
  `process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://tbetcegmszzotrwdtqhi.supabase.co'`

  Forget `SUPABASE_URL` on the staging Vercel project and **staging crons fire against production** — no error, `vercel.json` schedules them every 1–5 min.

**Edge functions — prod-host fallbacks:**
- `adyen-create-session/index.ts:73` — `return_url` defaults to `https://possystem-liard.vercel.app/`
- `review-request/index.ts:23` — `REVIEW_CARD_BASE ?? 'https://possystem-liard.vercel.app'` (unset)
- `review-google/index.ts:25` — `REVIEW_BO_BASE ?? 'https://possystem-liard.vercel.app'` (unset)
- `wallet-pass/index.ts:338` — `origins: ['https://possystem-liard.vercel.app']`
- `xero-connect/index.ts:25` — `XERO_APP_BASE || 'https://dev.serv-os.app'` (unset)
- `send-welcome:39`, `gift-resend:21`, `gift-fulfill:43`, `wallet-pass:35` — `CUSTOMER_DOMAIN ?? 'serv-os.app'`. The secret **is** set on Ops but its value is not readable via the API (returns a digest) — Peter must confirm it matches the tier, or gift/loyalty emails will link customers to the wrong environment.

**Tooling:**
- `scripts/check-deploys.mjs:19` — `const PROJECT = 'tbetcegmszzotrwdtqhi'` — cannot check a staging project.
- `scripts/screenshots.mjs:19,23,24` — `possystem-liard.vercel.app`, `LOC = '7218c716-…'`, `PIN = '1111'`, 7 hardcoded device UUIDs.

**Good news on UUIDs:** the codebase is clean. Grepping all six live location/company UUIDs across `src/`, `api/`, `supabase/`, `android/`, `scripts/` returns hits **only** in `20260628_ops_demo_seed.sql` and `screenshots.mjs`. The only UUID literal in all of `src/` is the nil UUID at `src/lib/ops/checklists.js:113`. No tenant IDs are baked into application code.

---

### Suggested order of work

1. Schema dump both projects → staging projects (nothing else can proceed).
2. Point `stage.serv-os.app` at its own Vercel deployment with `VITE_APP_TIER=stage` and staging keys; free it from the main-branch alias.
3. Decide what happens to `app.serv-os.app` / v4.1.0 before it becomes the go-live target.
4. Fix the hardcoded/fallback prod hosts (small, mechanical, all in one pass).
5. Build the venue seed script.
6. Split the APK update channel, then cut staging APKs.
