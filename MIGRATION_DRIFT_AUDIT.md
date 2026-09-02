# MIGRATION DRIFT AUDIT — Ops DB (tbetcegmszzotrwdtqhi)

**Date:** 7 Aug 2026.
**Method:** no migration ledger exists, so application state was inferred. Every object each migration creates (tables, columns, functions, triggers, policies, indexes, constraints, types, views, buckets, cron jobs) was extracted from the SQL and probed against the live system catalogs via the Supabase Management API. Dynamic drops (format() loops), realtime publication membership, cron.job, data seeds and column types were verified individually where the static probe was inconclusive.
**Scope:** the LIVE Ops DB only. 26 files target the Platform DB (yhzjgyrkyjabvhblqxzu) and are NOT assessed here. The mixed two-section files (20260525, 20260528 hardening, 20260805c, 20260806c) had their Ops section verified, Platform section not.

## Headline

| Verdict | Count |
|---|---|
| **Applied fully** (incl. superseded-by-later-migration objects) | 155 |
| **Platform DB target, out of scope** | 26 |
| **Partially present** | 3 |
| **Not applied / not in effect** | 3 |
| **Removed deliberately** | 1 |

**Bottom line: exactly ONE substantive unapplied Ops migration exists, and it is already the documented BLOCKER-1: `20260721c_rls_lock_user_identity.sql`.** Everything else missing is either the obsolete April tenant-RLS scheme (superseded, must NOT be applied), a handful of stray policies masked by the known wide-open legacy policies, or a deliberate teardown. No silently broken user-visible feature of the `staff_auth_link` class was found. All post-baseline migrations (5 Aug onward) are verified applied.

## Findings that need action or awareness

### F1. `20260721c_rls_lock_user_identity.sql` — NOT applied (known, sequenced — do not blind-apply)
- **Missing live:** `is_privileged_ctx`, `guard_user_profiles`, `guard_user_locations`, `set_bo_access`, `is_anon_session`, `can_claim_location`; triggers `trg_guard_user_profiles` / `trg_guard_user_locations`; constraints `user_profiles_role_chk`, `user_locations_user_fk`; the `up_*` policy set; the anon/authenticated REVOKEs.
- **Still live instead:** wide-open `"Allow authenticated access"` on `user_profiles`.
- **User-visible impact:** none. `set_bo_access` is called nowhere in app code. This is a security exposure, not a breakage.
- **Already narrowed since the 4 Aug audit:** `20260721d` (applied) fixed `handle_new_user()` role minting; `20260806f` applied the `ul_*` policy rework + `ul_block_role_self_change_trg` on `user_locations`; `20260805c` Section A fences anonymous writes. Remaining hole: any real authenticated user can still read all user_profiles rows, and the RLS root stays soft until 20260721c lands.
- **Why it must wait:** PRE_STAGE_READINESS.md — `user_accessible_locations()` must become SECURITY DEFINER first (136 policies across 63 tables depend on it), and it needs sequencing with the `devices` trust-anchor fence.

### F2. `20260429_tenant_rls.sql` + `20260429_crm_tenant_rls.sql` — never took effect, now OBSOLETE
- **Missing live:** all ~60 `*_rls_select/insert/update/delete` policies.
- **Live reality:** the same tables carry legacy `"allow all"` / `"Allow authenticated access"` policies or the newer staged scheme (`closed_checks_read`, `*_sel/_write/_upd/_del`, `*_tenant`).
- **User-visible impact:** none functionally. This IS the documented POS-core RLS gap (anon key can read closed_checks, kds_tickets, etc.).
- **⚠ Do NOT apply now:** 20260804c's written deferral rationale — locking these tables today breaks the QR flow, kiosk loyalty lookup, anonymous order INSERT after payment, and OrderTracker realtime. Recommend annotating both files as superseded so nobody replays them.

### F3. `20260422_multi_location.sql` — partial
- `kds_tickets_select_by_user_locations` never took effect (`kds_tickets` still `"allow all"`). The closed_checks policy was superseded by `20260713e`. Impact: cross-venue kds reads possible with the anon key. Same gap family as F2, same deferral logic.

### F4. `20260430_super_admin_select.sql` — partial
- 7 super-admin read policies absent (`organisations`, `locations`, `user_profiles`, `user_locations`). Invisible today because those tables are wide open anyway. **Trap:** when the RLS lockdown lands, super-admin cross-org reads silently die unless these (or equivalents) ship in the same change.

### F5. `20260430_order_number_counter.sql` — partial, harmless
- Table + `next_order_number()` are live (this was the location_order_counters drift case, fixed Aug 2026), but `location_order_counters_rls_select` was never applied: RLS is ON with ZERO policies. No impact — the RPC is SECURITY DEFINER and nothing reads the table directly.

### F6. `20260625_active_sessions_audit.sql` — absent by design
- Applied 25 Jun, deliberately torn down 13 Jul during the self-heal work. Not drift. Annotate the file as retired.

## Known-deliberate holdouts, cross-checked

| Item | Memory said | Live reality |
|---|---|---|
| `20260623t` waitlist | NOT applied (owner-gated) | **Now APPLIED** — all objects + `waitlist_entries` in realtime publication. Memory updated. |
| `20260721c` | priv-esc FIXED | Fix was `20260721d` + `20260806f` + anon fences. `20260721c` itself is still the open BLOCKER-1 (F1). |
| `20260625` audit trigger | torn down 13 Jul | Confirmed absent. Matches. |
| 3 cron jobs "in no migration" (readiness doc) | must be recreated for staging | Outdated — `20260715b`, `20260724`, `20260804_wf_rate_changes` + `20260805b` now cover all of them. |

## Platform DB follow-up (out of scope here, flagged)

26 files target yhzjgyrkyjabvhblqxzu and were not assessed. One concrete risk found in passing: the `location-admin` edge fn calls `location_branding_merge` / `challenge21_reset` RPCs on the Platform DB — if `20260806_PLATFORM_location_rpcs.sql` is unapplied there, BO branding save and the Challenge-21 reset fail. The same audit method works on the platform project on request.

## Full per-file table

| Migration | Verdict | Evidence |
|---|---|---|
| 000_baseline_ops.sql | APPLIED | all 1277 schema probes present |
| 000_baseline_platform.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260422_multi_location.sql | PARTIAL | kds_tickets_select_by_user_locations never in effect (kds_tickets live policy is "allow all"). closed_checks half superseded by 20260713e (closed_checks_read live). |
| 20260422_reports_schema_hardening.sql | APPLIED | all 4 schema probes present |
| 20260429_crm_tenant_rls.sql | NOT IN EFFECT, OBSOLETE | 0 of 10 customers/customer_* RLS policies live. Live tables carry customers_all etc. Superseded by the staged RLS programme. Do not apply. |
| 20260429_tenant_rls.sql | NOT IN EFFECT, OBSOLETE | 1 of 57 probes live. None of the *_rls_select/insert/update/delete policies exist. Live tables carry legacy "allow all"/"Allow authenticated access" or the later staged scheme. Do not apply. |
| 20260430_bo_access_flag.sql | APPLIED | all 1 schema probes present |
| 20260430_order_number_counter.sql | PARTIAL | Table + next_order_number() live (SECURITY DEFINER). location_order_counters_rls_select absent: RLS is ON with ZERO policies. No functional impact, RPC bypasses RLS. |
| 20260430_staff_auth_link.sql | APPLIED | all 3 schema probes present |
| 20260430_super_admin_select.sql | PARTIAL | 7 super-admin policies absent. Masked today by wide-open legacy policies on the same tables. Must be reconciled when the RLS lockdown lands. |
| 20260508_online_slug.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260508_opening_hours.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260525_loyalty_core.sql | APPLIED (Ops section) | Ops section: loyalty_transactions + 3 indexes live; "allow all" policy superseded by loyalty_transactions_tenant (20260721 stage1); idx_loyalty_tx_idempotency superseded by UNIQUE constraint loyalty_transactions_idempotency_key_key. Platform section not assessed. |
| 20260528_gift_redeem_atomic.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260528_tenant_integrity_hardening.sql | APPLIED (Ops section) | All Ops probes present. Platform section not assessed. |
| 20260529_closed_checks_payment_intents.sql | APPLIED | all 1 schema probes present |
| 20260529_location_currency.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260608_workforce.sql | APPLIED | 57/58 static probes + dynamically generated trg_wf_*_touch triggers all verified live (parser artifact on format()). |
| 20260609_wf_documents_storage.sql | APPLIED | all 8 schema probes present |
| 20260609b_wf_doc_templates.sql | APPLIED | all 11 schema probes present |
| 20260610_pay_period_anchor.sql | APPLIED | all 2 schema probes present |
| 20260610b_timesheet_breaks.sql | APPLIED | all 2 schema probes present |
| 20260610c_payroll_runs.sql | APPLIED | all 7 schema probes present |
| 20260610d_scale_indexes.sql | APPLIED | all 4 schema probes present |
| 20260610e_platform_loyalty_otp_rls.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260610f_pos_core_indexes.sql | APPLIED | all 5 schema probes present |
| 20260611_platform_ryft_foundation.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260611b_platform_ryft_pricing.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260611c_platform_ryft_pricing_v2.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260611d_platform_ryft_sell_rates.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260611e_platform_ryft_markup_only.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260611f_platform_ryft_cost.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260612_ryft_disputes.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260612b_ryft_webhook_dedupe.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260612c_ryft_payments_ledger.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260612e_review_manager.sql | APPLIED | all 16 schema probes present |
| 20260612f_review_platforms_expand.sql | APPLIED | all 2 schema probes present |
| 20260612g_review_engine.sql | APPLIED | all 12 schema probes present |
| 20260612h_review_platforms_connectable_only.sql | APPLIED | all 2 schema probes present |
| 20260612i_review_google_tokens.sql | APPLIED | all 2 schema probes present |
| 20260612j_review_card_background.sql | APPLIED | all 2 schema probes present |
| 20260613_menu_boards.sql | APPLIED | all 6 schema probes present |
| 20260614_menu_board_screens.sql | APPLIED | all 12 schema probes present |
| 20260614b_menu_board_screens_hardening.sql | APPLIED | all 1 schema probes present |
| 20260615_wifi_capture.sql | APPLIED | all 17 schema probes present |
| 20260615b_wifi_loyalty.sql | APPLIED | all 2 schema probes present |
| 20260616_marketing_offers.sql | APPLIED | all 13 schema probes present |
| 20260616b_marketing_messaging.sql | APPLIED | all 11 schema probes present |
| 20260616c_marketing_segments.sql | APPLIED | all 5 schema probes present |
| 20260616d_marketing_campaigns.sql | APPLIED | all 13 schema probes present |
| 20260616e_campaign_email_blocks.sql | APPLIED | all 1 schema probes present |
| 20260616f_marketing_workflows.sql | APPLIED | all 13 schema probes present |
| 20260616g_marketing_report.sql | APPLIED | all 1 schema probes present |
| 20260616h_campaign_ephemeral.sql | APPLIED | all 1 schema probes present |
| 20260617_campaign_scheduling.sql | APPLIED | all 2 schema probes present |
| 20260617b_marketing_forecast.sql | APPLIED | all 1 schema probes present |
| 20260617c_org_sending_domains.sql | APPLIED | all 4 schema probes present |
| 20260617d_set_active_domain.sql | APPLIED | all 1 schema probes present |
| 20260617e_campaign_ab.sql | APPLIED | all 4 schema probes present |
| 20260617f_marketing_report_workflows.sql | APPLIED | all 1 schema probes present |
| 20260617g_catering_site_settings.sql | APPLIED | all 5 schema probes present |
| 20260617h_catering_public.sql | APPLIED | all 3 schema probes present |
| 20260617i_closed_checks_catering_source.sql | APPLIED | all 1 schema probes present |
| 20260617j_catering_menu_ids_text.sql | APPLIED | catering_site_settings.menu_ids is text[] (udt _text) live. |
| 20260617k_catering_fire_time.sql | APPLIED | all 1 schema probes present |
| 20260620_hubrise.sql | APPLIED | all 8 schema probes present |
| 20260621_closed_checks_hubrise_source.sql | APPLIED | all 1 schema probes present |
| 20260621b_hubrise_auto_print_receipt.sql | APPLIED | all 1 schema probes present |
| 20260621c_device_profiles_order_notifications.sql | APPLIED | all 1 schema probes present |
| 20260621d_stock_foundation.sql | APPLIED | all 17 schema probes present |
| 20260621e_stock_movements.sql | APPLIED | all 7 schema probes present |
| 20260621f_recipes.sql | APPLIED | all 8 schema probes present |
| 20260621g_production_batches.sql | APPLIED | production_batches_rls superseded by 20260713 then 20260729f. |
| 20260621h_purchasing.sql | APPLIED | all 8 schema probes present |
| 20260622_par_counts.sql | APPLIED | all 6 schema probes present |
| 20260622b_wastage.sql | APPLIED | waste_events_rls superseded by 20260729e. |
| 20260623_unit_defaults.sql | APPLIED | all 2 schema probes present |
| 20260623b_usage_rates.sql | APPLIED | all 1 schema probes present |
| 20260623c_purchase_vat.sql | APPLIED | all 8 schema probes present |
| 20260623d_waste_sale_value.sql | APPLIED | all 1 schema probes present |
| 20260623m_catering_scheduled_fire.sql | APPLIED | all 2 schema probes present |
| 20260623p_loyalty_points_stamps_toggles.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260623t_tables_ready_waitlist.sql | APPLIED | all 28 schema probes present |
| 20260623u_waitlist_inbound_sms.sql | APPLIED | all 8 schema probes present |
| 20260623v_waitlist_self_service.sql | APPLIED | all 10 schema probes present |
| 20260624_operations_foundation.sql | APPLIED | all 31 schema probes present |
| 20260624b_operations_rpcs.sql | APPLIED | all 7 schema probes present |
| 20260624c_scale_indexes.sql | APPLIED | all 4 schema probes present |
| 20260624d_recipe_order_types.sql | APPLIED | all 1 schema probes present |
| 20260625_active_sessions_audit.sql | REMOVED DELIBERATELY | Applied 25 Jun, torn down 13 Jul (active_sessions self-heal work). Not drift. Annotate file as retired. |
| 20260625_operations_checklists.sql | APPLIED | all 8 schema probes present |
| 20260626_fix_ops_device_code.sql | APPLIED | all 1 schema probes present |
| 20260627_ops_device_read_rls.sql | APPLIED | all 3 schema probes present |
| 20260628_device_training_mode.sql | APPLIED | all 1 schema probes present |
| 20260628_ops_demo_seed.sql | APPLIED | Seed rows live: 6 temp_units + 5 ops_checklists at demo location 7218c716. |
| 20260629_prep_schedule.sql | APPLIED | prep_schedule_rls superseded by 20260729f. |
| 20260629_uber_direct_delivery.sql | APPLIED | all 12 schema probes present |
| 20260629b_delivery_mode.sql | APPLIED | all 2 schema probes present |
| 20260629b_pos_nudges.sql | APPLIED | "allow all" policy replaced by later RLS files; table + realtime pruning verified. |
| 20260629c_activity_events.sql | APPLIED | all 3 schema probes present |
| 20260629c_courier_dispatch_idempotency.sql | APPLIED | all 1 schema probes present |
| 20260629d_order_activity_trigger.sql | APPLIED | all 2 schema probes present |
| 20260630_stuart_per_location.sql | APPLIED | all 3 schema probes present |
| 20260630b_stuart_courier_check_and_env.sql | APPLIED | all 2 schema probes present |
| 20260630c_courier_times.sql | APPLIED | all 3 schema probes present |
| 20260701_staff_nfc_card.sql | APPLIED | all 2 schema probes present |
| 20260702_signout_policy.sql | APPLIED | all 3 schema probes present |
| 20260703_staff_auth_method.sql | APPLIED | all 4 schema probes present |
| 20260707_table_reservations.sql | APPLIED | all 3 schema probes present |
| 20260713_stock_rls_cross_tenant_fix.sql | APPLIED, SUPERSEDED | Its *_rls policies were replaced wholesale by 20260729d (*_sel/_write/_upd/_del scheme, verified live on all 7 stock tables). |
| 20260713b_ops_evidence_private_bucket.sql | APPLIED | all 4 schema probes present |
| 20260713c_pos_device_location_link.sql | APPLIED | all 4 schema probes present |
| 20260713d_rls_lock_staff_cash.sql | APPLIED | all 8 schema probes present |
| 20260713e_rls_lock_closed_checks_read.sql | APPLIED | all 7 schema probes present |
| 20260713f_rls_lock_modifier_group_writes.sql | APPLIED | all 7 schema probes present |
| 20260713g_PLATFORM_location_reader_settings_write.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260713h_PLATFORM_reader_idle_image_url.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260713i_print_menu_config.sql | APPLIED | all 1 schema probes present |
| 20260713j_menu_item_dietary_tags.sql | APPLIED | all 1 schema probes present |
| 20260715_xero.sql | APPLIED | all 5 schema probes present |
| 20260715b_xero_nightly.sql | APPLIED | all 2 schema probes present |
| 20260715c_invoice_scans.sql | APPLIED | all 4 schema probes present |
| 20260718_PLATFORM_location_coords.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260719_PLATFORM_ryft_terminal_pairing.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260721_rls_stage1_low_risk.sql | APPLIED | all 20 schema probes present |
| 20260721b_storage_kiosk_assets_lockdown.sql | APPLIED | all 2 schema probes present |
| 20260721c_rls_lock_user_identity.sql | NOT APPLIED (KNOWN BLOCKER) | PRE_STAGE_READINESS BLOCKER-1. 6 guard/helper functions, 2 guard triggers, 2 constraints, up_* policies all absent. Legacy "Allow authenticated access" still on user_profiles. Deliberately sequenced: user_accessible_locations must become SECURITY DEFINER first. |
| 20260721d_handle_new_user_no_client_role.sql | APPLIED | all 1 schema probes present |
| 20260721e_modifier_groups_super_admin.sql | APPLIED | all 3 schema probes present |
| 20260721f_backfill_device_receipt_printers.sql | APPLIED | Data backfill verified: 8 devices have receipt_printer_id. |
| 20260722_terminal_devices.sql | APPLIED | td_delete policy dropped by 20260724 (retire-not-delete model). |
| 20260722b_terminal_jobs.sql | APPLIED | all 12 schema probes present |
| 20260722c_terminal_rpcs.sql | APPLIED | all 18 schema probes present |
| 20260723_terminal_settings.sql | APPLIED | all 7 schema probes present |
| 20260724_terminal_retire_and_sweep.sql | APPLIED | all 4 schema probes present |
| 20260725_unknown_does_not_block_terminal.sql | APPLIED | all 1 schema probes present |
| 20260726_resolve_terminal_job.sql | APPLIED | all 1 schema probes present |
| 20260727_closed_checks_promo.sql | APPLIED | all 2 schema probes present |
| 20260727_terminal_pos_close.sql | APPLIED | all 6 schema probes present |
| 20260727b_gift_purchases_ryft.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260727c_saas_billing.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260728_hubrise_image_cache.sql | APPLIED | all 1 schema probes present |
| 20260729_terminal_jobs_ryft_settle.sql | APPLIED | all 8 schema probes present |
| 20260729b_ops_evidence_bo_upload.sql | APPLIED | all 2 schema probes present |
| 20260729c_usage_by_weekday.sql | APPLIED | all 1 schema probes present |
| 20260729d_pos_stock_read_rls.sql | APPLIED | all 1 schema probes present |
| 20260729e_waste_events_device_write.sql | APPLIED | all 5 schema probes present |
| 20260729f_batch_scheduling.sql | APPLIED | all 13 schema probes present |
| 20260729g_planned_batches.sql | APPLIED | all 5 schema probes present |
| 20260729h_closed_checks_source_terminal.sql | APPLIED | all 1 schema probes present |
| 20260730_option_group_order.sql | APPLIED | all 1 schema probes present |
| 20260730_terminal_double_charge_guard.sql | APPLIED | all 2 schema probes present |
| 20260730b_order_notify_replay_guard.sql | APPLIED | all 2 schema probes present |
| 20260731_quick_screen_auto.sql | APPLIED | all 3 schema probes present |
| 20260731_terminal_ryft_link.sql | APPLIED | all 2 schema probes present |
| 20260801_PLATFORM_adyen_foundation.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260801_terminal_paid_guard_occupation.sql | APPLIED | all 2 schema probes present |
| 20260801b_ops_adyen_terminals.sql | APPLIED | all 7 schema probes present |
| 20260801c_terminal_jobs_nexo.sql | APPLIED | all 1 schema probes present |
| 20260801d_adyen_review_hardening.sql | APPLIED | all 2 schema probes present |
| 20260802_tj_paid_guard_index.sql | APPLIED | all 1 schema probes present |
| 20260803_terminal_pos_close_session.sql | APPLIED | all 1 schema probes present |
| 20260803b_order_notify.sql | APPLIED | all 4 schema probes present |
| 20260804_devices_app_version.sql | APPLIED | all 1 schema probes present |
| 20260804_terminal_kiosk_binding.sql | APPLIED | all 2 schema probes present |
| 20260804_wf_rate_changes.sql | APPLIED | all 10 schema probes present |
| 20260804b_ops_checklists_monthly.sql | APPLIED | all 1 schema probes present |
| 20260804b_realtime_prune.sql | APPLIED | pg_publication_tables verified: pos_nudges, modifier_groups, print_routing, terminal_devices, terminal_jobs all absent from supabase_realtime. |
| 20260804c_rls_hardening.sql | APPLIED | all 9 schema probes present |
| 20260804c_temp_probe_type.sql | APPLIED | all 1 schema probes present |
| 20260804d_wf_bank_account_name.sql | APPLIED | all 1 schema probes present |
| 20260805_scheduled_automations.sql | APPLIED | all 1 schema probes present |
| 20260805b_edge_cron_bridge.sql | APPLIED | cron.job live: catering-release-5min, hubrise-reconcile-2min, marketing-run-hourly, ops-escalate-5min, review-request-scan, xero-nightly-sales, cron-log-purge. |
| 20260805c_anon_fences.sql | APPLIED (Section A, Ops) | 22 Ops probes live incl. up_no_anon_* / ul_no_anon_* fences. All 6 misses sit in Section B (Platform): locations_qr_* constraints + loyalty service_all policies. Platform section not assessed. |
| 20260805d_payment_devices_columns.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260806_PLATFORM_location_rpcs.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260806b_stamp_idem_index.sql | APPLIED | idx_stamp_txn_idempotency live on stamp_transactions. |
| 20260806c_redeem_atomic.sql | APPLIED (Section A, Ops) | promo_redeem_atomic() live. Misses (loyalty_redemption_claims, loyalty_redeem_points) are Section B (Platform), not assessed. |
| 20260806d_review_last_attempt.sql | APPLIED | all 2 schema probes present |
| 20260806e_loyalty_reconcile_cron.sql | APPLIED | cron job loyalty-reconcile-hourly live. |
| 20260806f_staff_portal.sql | APPLIED | all 4 schema probes present |
| 20260806f_ul_role_pin_and_claims_index.sql | APPLIED | all 2 schema probes present |
| 20260806g_PLATFORM_claims_index.sql | PLATFORM DB | Targets yhzjgyrkyjabvhblqxzu, not assessed against Ops. |
| 20260806g_training.sql | APPLIED | all 5 schema probes present |
| 20260806h_ops_alert_types.sql | APPLIED | all 1 schema probes present |
| 20260806i_training_content.sql | APPLIED | all 5 schema probes present |
| 20260806j_portal_columns_locked.sql | APPLIED | all 2 schema probes present |
| 20260806k_order_identity.sql | APPLIED | all 3 schema probes present |

