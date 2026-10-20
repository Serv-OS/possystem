-- live_shape.sql: the constraints and indexes the live Ops stock tables have (pg_constraint and
-- pg_indexes, read only, 20 Oct 2026) that the base schema and the real migrations do not make here.
-- Loaded by base.mjs after the real migrations, so 0a meets the tables as live has them. Left out on
-- purpose: deliveries.corrective_action_id's foreign key (corrective_actions is not a stock table and
-- is not in this database), and the live non stock guard triggers (devices_fence_tg,
-- locations_fence_guard, locations_seed_uk_tax_rates, organisations_fence_guard,
-- ul_block_role_self_change_trg, user_locations_fence_guard, msm_site_org_guard): no Drop 0 file
-- writes those tables, and the fixtures are inserted by the SQL editor, which they let through.

alter table public.deliveries add constraint deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])));
alter table public.production_batches add constraint production_batches_output_item_id_fkey FOREIGN KEY (output_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL;
alter table public.production_batches add constraint production_batches_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL;
alter table public.production_batches add constraint production_batches_status_check CHECK ((status = ANY (ARRAY['PLANNED'::text, 'DRAFT'::text, 'COMPLETED'::text, 'CANCELLED'::text])));
alter table public.staff_members add constraint staff_members_auth_method_check CHECK ((auth_method = ANY (ARRAY['pin'::text, 'card'::text, 'fingerprint'::text])));
alter table public.stock_count_areas add constraint stock_count_areas_count_area_uniq UNIQUE (count_id, area_id);
alter table public.stock_count_areas add constraint stock_count_areas_status_chk CHECK ((status = ANY (ARRAY['open'::text, 'complete'::text])));
alter table public.stock_site_settings add constraint stock_site_settings_cost_rule_ok CHECK ((cost_rule = ANY (ARRAY['price_list'::text, 'deliveries'::text])));
alter table public.stock_units add constraint stock_units_dimension_check CHECK ((dimension = ANY (ARRAY['COUNT'::text, 'WEIGHT'::text, 'VOLUME'::text])));
alter table public.storage_areas add constraint storage_areas_kind_chk CHECK ((kind = ANY (ARRAY['cellar'::text, 'walk_in'::text, 'fridge'::text, 'freezer'::text, 'dry_store'::text, 'bar'::text, 'kitchen'::text, 'other'::text])));
alter table public.storage_areas add constraint storage_areas_name_chk CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 60)));
CREATE INDEX IF NOT EXISTS deliveries_loc_idx ON public.deliveries USING btree (location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deliveries_po_idx ON public.deliveries USING btree (po_id);
CREATE INDEX IF NOT EXISTS menu_item_recipes_recipe_idx ON public.menu_item_recipes USING btree (recipe_id);
CREATE INDEX IF NOT EXISTS par_levels_loc_idx ON public.par_levels USING btree (location_id);
CREATE INDEX IF NOT EXISTS prep_schedule_loc_idx ON public.prep_schedule USING btree (location_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS production_batches_sched_day ON public.production_batches USING btree (location_id, schedule_id, planned_for) WHERE ((schedule_id IS NOT NULL) AND (status <> 'CANCELLED'::text));
CREATE UNIQUE INDEX IF NOT EXISTS staff_members_auth_user_id_unique ON public.staff_members USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS staff_members_nfc_card_uidx ON public.staff_members USING btree (location_id, nfc_card_id) WHERE (nfc_card_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS stock_count_areas_count_idx ON public.stock_count_areas USING btree (count_id);
CREATE INDEX IF NOT EXISTS stock_counts_loc_idx ON public.stock_counts USING btree (location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_transfers_loc_idx ON public.stock_transfers USING btree (location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_transfers_to_loc_idx ON public.stock_transfers USING btree (to_location_id, created_at DESC) WHERE (to_location_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS storage_areas_loc_idx ON public.storage_areas USING btree (location_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS storage_areas_name_uniq ON public.storage_areas USING btree (location_id, regexp_replace(lower(regexp_replace(regexp_replace(btrim(name), '[-_]'::text, ' '::text, 'g'::text), '\s+'::text, ' '::text, 'g'::text)), '^the '::text, ''::text)) WHERE (archived_at IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS storage_areas_receiving_uniq ON public.storage_areas USING btree (location_id) WHERE (is_receiving AND (archived_at IS NULL));
