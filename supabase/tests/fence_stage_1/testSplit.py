#!/usr/bin/env python3
"""THE SPLIT (20 Sep 2026): a1 on its own.

Peter asked for the fence's first file to be cut in two so the biggest holes close now, before
the payment rules are finished: 20260919a1_OPS_fence_identity_devices.sql goes in on its own,
and 20260919a2_OPS_fence_public_orders.sql follows when it is ready.

So a1 has to be safe by itself. These checks prove three things on a throwaway copy:
  * a1 applies on its own, twice, and leaves the fence's own marks;
  * with ONLY a1 in, every surface that was working still works: a till, a kiosk, a KDS, a TV,
    the host stand, online, QR, catering and the order tracker all keep the exact paths they use
    today (the order tables still carry "allow all", the menu and venue reads are untouched, and
    the app's own fallback writes still go straight in, stamped 'public');
  * a2 refuses to run until a1 is in, and changes nothing when it refuses.
The roll back of a1 on its own is proved in testRollback.py.
"""
import json
import t
from t import as_, as_commit, expect, last, run, L1, L3, UID

def j(o):
    try:
        return json.loads(last(o))
    except Exception:
        return {}

# ---------- a2 refuses until a1 is in ----------------------------------------------------
t.reset()
o, e, r = t.apply(t.FILE_A2)
expect('a2 refuses on a database with no a1, and names the file to run first',
       r != 0 and 'STOPPED' in e and '20260919a1_OPS_fence_identity_devices.sql' in e, (e or '')[-500:])
o2, _, _ = run("select to_regprocedure('public.place_public_order(uuid, jsonb, jsonb, uuid[])') is null,"
               " (select count(*) from pg_policies where tablename = 'discount_rules' and policyname = 'discount_rules_write_bo'),"
               " to_regclass('public.fence_state') is null")
expect('and it changed nothing at all (no order function, no new rule, no fence_state)', o2 == 't|0|t', o2)

# ---------- a1 on its own ----------------------------------------------------------------
t.reset()
o, e, r = t.apply(t.FILE_A1)
expect('a1 applies on its own (one transaction)', r == 0, e[-1500:])
expect('a1 ends with its own verification row (11 columns)', last(o).count('|') == 10, last(o))
o2, e2, r2 = t.apply(t.FILE_A1)
expect('a1 applies a second time (idempotent)', r2 == 0, e2[-1500:])
o, _, _ = run("select (select value from public.fence_state where key = 'file_a'),"
              " (select count(*) from public.fence_state where key = 'file_a2')")
expect("a1 records itself for file 2's full day, and nothing pretends the payment half is in",
       o == '20260919a|0', o)
o, _, _ = run("select to_regprocedure('public.place_public_order(uuid, jsonb, jsonb, uuid[])') is null,"
              " to_regprocedure('public.settle_qr_tab(uuid, text, jsonb, uuid[])') is null,"
              " to_regprocedure('public.order_track_row(text, text)') is null")
expect('the payment half really is not in yet: the customer functions do not exist', o == 't|t|t', o)
o, _, _ = run("select to_regclass('public.payment_proofs') is not null,"
              " to_regclass('public.public_order_pending_checks') is not null,"
              " to_regprocedure('public._menu_item_floor_minor(jsonb, text, boolean, text)') is not null")
expect('but the tables and helpers a2 will need are already there, empty and private', o == 't|t|t', o)

# ---------- the devices half is whole: pairing works, which is the point of going first ----
o, e, r = as_commit('owner1', f"insert into public.devices (location_id, name, type) values ('{L1}', 'Split till', 'pos');"
                              " select public.issue_pairing_code(id)->>'code' from public.devices where name = 'Split till';")
code = last(o)
expect('PAIRING: Back Office issues a server pairing code with only a1 in',
       r == 0 and len(code) == 14 and code[4] == '-', o + e)
o, e, r = as_commit('newtill', f"select public.claim_device_v2('{code}')->>'ok';")
expect('and a new till pairs with it', last(o) == 'true', o + e)
o, e, r = as_commit('dev1', "select public.device_heartbeat('5.9.12', array['fence_v1'], '40000000-0000-4000-8000-000000000001')->>'bound';")
expect('TILL: a paired till still sends its heartbeat and is still bound', last(o) == 'true', (o + e)[-300:])
o, e, r = as_commit('dev1', "select public.device_issue_secret()->>'device_secret';")
expect('and collects its device secret', r == 0 and len(last(o)) > 20, (o + e)[-300:])

# ---------- with only a1 in, the floor is untouched --------------------------------------
# The four order tables keep "allow all" until file 2, so every surface carries on exactly as
# it does today. These are the writes each surface really makes.
o, _, _ = run("select string_agg(tablename, ', ' order by tablename) from pg_policies"
              " where schemaname = 'public' and policyname = 'allow all'"
              " and tablename in ('order_queue', 'kds_tickets', 'active_sessions', 'table_reservations')")
expect('order_queue, kds_tickets, active_sessions and table_reservations still have "allow all"',
       o == 'active_sessions, kds_tickets, order_queue, table_reservations', o)

ORDER = ("insert into public.order_queue (ref, location_id, type, customer, items, total, status, source, paid)"
         " values ('%s', '" + L1 + "', 'collection', '{\"name\": \"Ann\"}'::jsonb,"
         " '[{\"itemId\": \"mi-tea\", \"name\": \"Tea\", \"price\": 10, \"qty\": 1}]'::jsonb, 10, 'prep', '%s', true);")
o, e, r = as_commit('customer', ORDER % ('SPLIT-ONLINE', 'online'))
expect("ONLINE: the storefront can still write its order the way it does today (the app's own fallback)", r == 0, e[-300:])
o, e, r = as_commit('customer', ORDER % ('SPLIT-QR', 'qr'))
expect('QR: the same for a QR order', r == 0, e[-300:])
o, e, r = as_commit('customer', ORDER % ('SPLIT-CATERING', 'catering'))
expect('CATERING: and for a catering order', r == 0, e[-300:])
o, _, _ = run("select string_agg(placed_via, ',' order by ref) from public.order_queue where ref like 'SPLIT-%'")
expect('each one is stamped placed_via public, which is what file 2 waits for', o == 'public,public,public', o)
o, e, r = as_('customer', "select count(*) from public.order_queue where ref = 'SPLIT-ONLINE';")
expect("TRACKER: the customer can still read their own order row (today's tracker path)", last(o) == '1', o + e)
o, e, r = as_commit('customer', "insert into public.closed_checks (id, ref, location_id, source, status, total)"
                                " values ('chk-split-qr', 'SPLIT-QR', '" + L1 + "', 'qr', 'paid', 10);")
expect('and a paid QR check is still written, and "qr" is accepted now (that fix is in a1)', r == 0, e[-300:])

o, e, r = as_commit('dev1', "insert into public.kds_tickets (id, location_id, items) values ('split-k1', '" + L1 + "', '[]');")
expect('KDS: a kitchen ticket is still written', r == 0, e[-300:])
o, e, r = as_commit('dev1', "insert into public.active_sessions (location_id, table_id, session) values ('" + L1 + "', 'split-t1', '{}');")
expect('HOST STAND and TABLES: a table session is still written', r == 0, e[-300:])
o, e, r = as_commit('dev1', "insert into public.table_reservations (location_id, table_id, reservation) values ('" + L1 + "', 'split-t1', '{}');")
expect('BOOKINGS: a reservation is still written', r == 0, e[-300:])
o, e, r = as_commit('dev1', "insert into public.print_jobs (location_id, printer_id, printer_ip, job_type, payload, status)"
                            " values ('" + L1 + "', 'p1', '10.0.0.5', 'receipt', 'eA==', 'pending');")
expect('PRINTING: a print job is still queued for the agent', r == 0, e[-300:])
o, e, r = as_('rawanon', "select count(*) from public.print_jobs where location_id = '" + L1 + "';")
expect('and the print agent (bare anon key, no session) still reads its queue', r == 0 and int(last(o) or 0) >= 1, o + e)
o, e, r = as_('customer', "select count(*) from public.menu_items where location_id = '" + L1 + "';")
expect('MENU: the storefront, the kiosk and a TV still read the menu', int(last(o) or 0) > 5, o + e)
o, e, r = as_('rawanon', "select count(*) from public.locations where id = '" + L1 + "';")
expect('VENUE: the bare anon key still reads the venue row (kiosk, online, QR, catering, boards)', last(o) == '1', o + e)
o, e, r = as_('customer', "select count(*) from public.discount_rules where location_id = '" + L1 + "';")
expect('DEALS: the automatic discount rules are still readable, and a1 does not touch them', r == 0 and int(last(o) or 0) >= 1, o + e)
o, _, _ = run("select has_table_privilege('anon', 'public.discount_rules', 'INSERT'),"
              " has_table_privilege('authenticated', 'public.stamp_transactions', 'INSERT')")
expect("and they are still open to write: closing them is the payment half's job, not a1's", o == 't|t', o)

# ---------- then a2 goes in on top and the payment half starts --------------------------
o, e, r = t.apply(t.FILE_A2)
expect('a2 applies on top of a1', r == 0, e[-1500:])
o, _, _ = run("select has_table_privilege('anon', 'public.discount_rules', 'INSERT'),"
              " has_table_privilege('authenticated', 'public.stamp_transactions', 'INSERT'),"
              " to_regprocedure('public.place_public_order(uuid, jsonb, jsonb, uuid[])') is not null")
expect('and NOW the deal tables are closed and the order function exists', o == 'f|f|t', o)
o, _, _ = run("select count(*) from public.order_queue where ref like 'SPLIT-%'")
expect('the orders written while only a1 was in are untouched', o == '3', o)

t.finish()
