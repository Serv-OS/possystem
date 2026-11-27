-- 20261216a_CHECK_read_only.sql
--
-- READ ONLY. Run any time after 20261216a on Ops: it changes nothing.
-- Expected after 20261216a (and before any Combo is set up in a group menu):
--   column_ok t, check_ok t, guard_md5_ok t, start_md5_ok t, apply_md5_ok t, functions 3,
--   anon_function_rights 0, guards_in_order t, group_combos 0, sites_keeping_steps 0,
--   site_combos_with_steps (any number: Combos built at the sites themselves)
-- before 20261216a: column_ok f and the three md5 flags f (the bodies are then the live ones:
--   guard e36061b4ce3b7974741e5e39b8dca496, start 188ea598a5d54f40932f5eae8583aeb0, apply 87be2da005dea0d49a4d068660ac8b8c).
select
  (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'msm_products' and column_name = 'combo' and data_type = 'jsonb') as column_ok,
  (select count(*) = 1 from pg_constraint where conrelid = 'public.msm_products'::regclass and conname = 'msm_products_combo_shape_check' and convalidated) as check_ok,
  (select md5(p.prosrc) = '1227d666540e48107c8e74aab91d3494' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_changes_guard') as guard_md5_ok,
  (select md5(p.prosrc) = '2abda0780f63ce0ae2080ee49a0021f8' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_start_version') as start_md5_ok,
  (select md5(p.prosrc) = 'cded0bbdf09a050156cb9674ab0e815b' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_apply_site') as apply_md5_ok,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_start_version', 'msm_apply_site')) as functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'msm%' and has_function_privilege('anon', p.oid, 'execute')) as anon_function_rights,
  ((select string_agg(t.tgname::text, ',' order by t.tgname::text collate "C") from pg_trigger t
     where t.tgrelid = 'public.msm_changes'::regclass and not t.tgisinternal) = 'msm_changes_guard,msm_changes_guard_category') as guards_in_order,
  (select count(*) from public.msm_products where to_jsonb(msm_products) ? 'combo' and to_jsonb(msm_products) -> 'combo' <> 'null'::jsonb) as group_combos,
  (select count(*) from public.msm_product_sites where jsonb_typeof(kept) = 'object' and kept ? 'combo') as sites_keeping_steps,
  (select count(*) from public.menu_items where to_jsonb(menu_items) ? 'combo' and to_jsonb(menu_items) -> 'combo' <> 'null'::jsonb) as site_combos_with_steps;
