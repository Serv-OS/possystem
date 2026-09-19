-- Read only catalog queries that produce the schema/*.json files the offline harness
-- needs. The dumps are not kept in git. Run each query (Ops project unless marked
-- Platform) through the Management API with read_only true, and save the JSON array it
-- returns under the file name given. No rows of data are read, only table shapes.

-- schema/columns.json (Ops)
select c.relname as t, a.attnum as n, a.attname as col, format_type(a.atttypid, a.atttypmod) as typ,
       pg_get_expr(d.adbin, d.adrelid) as def, a.attnotnull as nn
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
 where ns.nspname = 'public' and a.attnum > 0 and not a.attisdropped
   and c.relname in ('organisations','locations','user_profiles','user_locations','devices','device_heartbeats',
                     'ops_devices','waitlist_devices','order_queue','closed_checks','kds_tickets','print_jobs',
                     'active_sessions','table_reservations','bar_tabs','floor_tables','staff_members',
                     'activity_events','order_status_marks','order_status_pings','subscriptions')
 order by 1, 2;

-- schema/constraints.json (Ops): same table list
select conrelid::regclass::text as t, conname, contype, pg_get_constraintdef(oid) as def
  from pg_constraint
 where connamespace = 'public'::regnamespace
   and conrelid::regclass::text in ('organisations','locations','user_profiles','user_locations','devices',
       'device_heartbeats','ops_devices','waitlist_devices','order_queue','closed_checks','kds_tickets','print_jobs',
       'active_sessions','table_reservations','bar_tabs','floor_tables','staff_members','activity_events',
       'order_status_marks','order_status_pings','subscriptions')
 order by 1, contype desc, 2;

-- schema/policies.json (Ops): same table list
select tablename as t, policyname as p, permissive, roles::text as roles, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('organisations','locations','user_profiles','user_locations','devices','device_heartbeats',
       'ops_devices','waitlist_devices','order_queue','closed_checks','kds_tickets','print_jobs','active_sessions',
       'table_reservations','bar_tabs','floor_tables','staff_members','activity_events','order_status_marks',
       'order_status_pings','subscriptions')
 order by 1, 2;

-- schema/triggers.json (Ops)
select c.relname as t, t.tgname, pg_get_triggerdef(t.oid) as def, p.proname as fn
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid
 where n.nspname = 'public' and not t.tgisinternal
   and c.relname in ('organisations','locations','user_profiles','user_locations','devices','order_queue',
                     'closed_checks','kds_tickets','print_jobs','active_sessions','table_reservations','bar_tabs')
 order by 1, 2;

-- schema/functions.json (Ops)
select p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def,
       has_function_privilege('anon', p.oid, 'execute') as anon_x,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_x
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('is_anon_session','is_super_admin','pos_can_access','user_accessible_locations',
       'user_accessible_orgs','can_claim_location','claim_device','ul_block_role_self_change',
       'user_profiles_role_guard','waitlist_can_write','ops_can_write','log_order_activity',
       'tg_order_queue_notify','tg_order_status_marks','_touch_updated_at','order_status_names_enabled',
       'online_kitchen_load','floor_tables_guard_tombstone','floor_tables_stamp_updated_at',
       '_osd_caller_locations','register_ops_device','claim_ops_device','register_waitlist_device',
       'claim_waitlist_device','terminal_pos_close_session','_terminal_user_has_location','handle_new_user')
 order by 1;

-- schema/grants.json (Ops): same table list as columns.json
select t.relname as t, r.rolname as role,
       array_to_string(array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                              where has_table_privilege(r.rolname, t.oid, p)), ',') as privs,
       (select string_agg(a.attname, ',') from pg_attribute a
         where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
           and has_column_privilege(r.rolname, t.oid, a.attname, 'UPDATE')
           and not has_table_privilege(r.rolname, t.oid, 'UPDATE')) as col_upd
  from pg_class t
  join pg_namespace n on n.oid = t.relnamespace
  cross join (values ('anon'), ('authenticated')) r(rolname)
 where n.nspname = 'public'
   and t.relname in ('organisations','locations','user_profiles','user_locations','devices','device_heartbeats',
       'ops_devices','waitlist_devices','order_queue','closed_checks','kds_tickets','print_jobs','active_sessions',
       'table_reservations','bar_tabs','floor_tables','staff_members','activity_events','order_status_marks',
       'order_status_pings','subscriptions')
 order by 1, 2;

-- schema/p_columns.json (PLATFORM): the columns query above with this table list
--   ('gift_card_purchases','location_reader_settings','locations','gift_cards','billing_state')
-- schema/p_policies.json (PLATFORM): the policies query above with
--   ('gift_card_purchases','location_reader_settings','locations','gift_cards')
