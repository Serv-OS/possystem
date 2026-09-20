#!/usr/bin/env python3
"""File 2 (20260919b) on the local throwaway copy: its release gates, what it closes, and
that file 1 refuses to run after it."""
import json
import t
from t import as_, as_commit, expect, last, UID, L1, L2, L3, L4, run

DEV = {'till1': '40000000-0000-4000-8000-000000000001', 'kds1': '40000000-0000-4000-8000-000000000002',
       'kiosk1': '40000000-0000-4000-8000-000000000004', 'o1acme': '40000000-0000-4000-8000-000000000008'}

def j(o):
    try:
        return json.loads(last(o))
    except Exception:
        return {}

def q(x):
    return json.dumps(x).replace("'", "''")

def proof(ref, kind, amount, loc=L1, order_ref=None):
    meta = 'null' if order_ref is None else f"'{json.dumps({'order_ref': order_ref})}'::jsonb"
    run(f"insert into public.payment_proofs (processor, payment_ref, kind, location_id, amount_minor, verified_by, meta) values ('stripe', '{ref}', '{kind}', '{loc}', {amount}, 'test', {meta})")
    o, _, _ = run(f"select id from public.payment_proofs where payment_ref = '{ref}' and kind = '{kind}'")
    return o

t.reset()
out, err, rc = t.apply('20260919a_OPS_fence_1_after_release.sql')
expect('file A applies', rc == 0, err[-1500:])

# --- gate 0 (fix round 2): a full day after file A FIRST ran, recorded by the server
out, err, rc = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('file B stops while file A has been in for less than a full day (whatever else is ready)',
       rc != 0 and 'less than a full day ago' in err and 'Run this file again after' in err, err[-600:])
t.age_file_a(23)
out, err, rc = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('23 hours is still less than a full day', rc != 0 and 'less than a full day ago' in err, err[-600:])
t.age_file_a(25)

# --- gate 1: devices on the release, linked, with a device secret
out, err, rc = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('file B stops while devices run the old app', rc != 0 and 'not ready' in err and 'old app' in err, err[-600:])
run("update public.devices set client_caps = array['fence_v1','device_secret'] where status in ('active','online') and bound_via is not null")
out, err, rc = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('file B stops while a kept till has no device secret yet', rc != 0 and 'no device secret yet' in err, err[-600:])
for who in ['dev1', 'dev3', 'dev4', 'dup', 'owner1']:
    as_commit(who, "select public.device_issue_secret();")
run("update public.devices set client_caps = array['fence_v1','device_secret'] where status in ('active','online') and bound_via is not null")
o, _, _ = run("select count(*) from public.devices where status in ('active','online') and (bound_via is null or device_secret_hash is null)")
expect('every active device now linked with a secret', o == '0', o)

# --- gate 2: a device that is not linked but switched on in the last 24 hours
as_commit('attacker', f"select public.device_heartbeat('5.9.9', array['fence_v1'], '{DEV['kds1']}');")
as_commit('stranger', "select public.device_heartbeat(null, null, '40000000-0000-4000-8000-00000000000a');")
o, _, _ = run("select count(*) from public.device_unlinked_pings")
expect('MEDIUM: a stranger naming someone else\'s device id records nothing', o == '0', o)
run(f"insert into public.device_unlinked_pings (device_id, uid, last_at) values ('40000000-0000-4000-8000-00000000000a', '{UID['stranger']}', now())")
out, err, rc = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('MEDIUM: and even a ping row from a session that was never linked to that device cannot hold file B shut', rc != 0 and 'No customer order has gone through' in err, err[-600:])
run("delete from public.device_unlinked_pings")
as_commit('dev2', f"select public.device_heartbeat('5.9.9', array['fence_v1'], '{DEV['kds1']}');")
out, err, rc = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('file B stops while a device that WAS linked is switched on unpaired (a kiosk could take money it cannot save)',
       rc != 0 and 'switched on but not paired' in err and 'KDS 1' in err, err[-600:])
run("update public.device_unlinked_pings set last_at = now() - interval '2 days'")

# --- gate 3 (fix round 2): rows anyone could write no longer hold file B shut
as_commit('attacker', f"insert into public.order_queue (ref, location_id, type, source, status, items) values ('OLD-1', '{L1}', 'collection', 'online', 'prep', '[]');")
as_commit('rawanon', f"insert into public.order_queue (ref, location_id, type, source, status, items) values ('OLD-2', '{L3}', 'collection', 'qr', 'prep', '[]');")
o, _, _ = run("select string_agg(placed_via, ',' order by ref) from public.order_queue where ref in ('OLD-1', 'OLD-2')")
expect('an anonymous session and the raw anon key can still write orders straight in during file A (placed_via public)', o == 'public,public', o)
# ezCater orders become catering orders written by the server: they never block file B
as_commit('service', f"insert into public.order_queue (ref, location_id, type, source, status, items, customer) values ('EZ-1', '{L1}', 'delivery', 'catering', 'received', '[]', '{{\"channel\":\"ezcater\"}}');")
as_commit('dev1', f"insert into public.order_queue (ref, location_id, type, source, status, items) values ('HUB-1', '{L1}', 'collection', 'online', 'prep', '[]');")

# --- gate 4: a quiet day never passes by itself
out, err, rc = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('MEDIUM: those rows do not stop file B; it stops only because no customer order has gone through the new function yet',
       rc != 0 and 'No customer order has gone through' in err, err[-600:])
p1 = proof('pi_test_1', 'card', 1000, order_ref='OL-TEST')
order = {'ref': 'OL-TEST', 'source': 'online', 'items': [{'itemId': 'mi-tea', 'name': 'Tea', 'price': 10, 'qty': 1}], 'total': 10, 'customer': {}}
o, e, r = as_commit('customer', f"select public.place_public_order('{L1}', '{q(order)}'::jsonb, '{q({'id': 'chk-OL-TEST-1', 'total': 10})}'::jsonb, array['{p1}']::uuid[]);")
expect('one real test order through the new function', j(o).get('paid') is True, o + e)

out, err, rc = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('file B applies once the app is live everywhere (ezCater, till, server and stray public rows do not block it)', rc == 0, err[-2000:])
print('   verify row:', last(out))
v = last(out).split('|')
expect('no open policy left, names on, devices not readable by all, every till has a secret, QR trigger on, 2 stray public rows counted',
       v == ['none', 't', 'f', '0', 't', '2'], last(out))
out, err, rc = t.apply('20260919b_OPS_fence_2_after_app.sql')
expect('file B applies a second time', rc == 0, err[-1500:])
out, err, rc = t.apply('20260919a_OPS_fence_1_after_release.sql')
expect('file A refuses to run after file B, and changes nothing', rc != 0 and 'has already run' in err, err[-600:])
o, _, _ = run("select count(*) from pg_policies where tablename = 'order_queue' and policyname = 'allow all'")
expect('order_queue is still closed after the refused re-run', o == '0', o)

# --- devices after file B (blocker 1 and 2 hold here too)
o, e, r = as_('attacker', "select count(*) from public.devices;")
expect('a stranger reads no device row', last(o) == '0', o + e)
o, e, r = as_('dev1', "select count(*) from public.devices where pairing_code is not null;")
expect('a till reads no pairing code', last(o) == '0', o + e)
o, e, r = as_commit('mallory', """
do $$ declare v_org uuid; v_loc uuid; v_dev uuid; v_code jsonb; begin
  insert into public.organisations (name, slug) values ('Mal', 'mal-co') returning id into v_org;
  insert into public.locations (org_id, name) values (v_org, 'Mal Cafe') returning id into v_loc;
  insert into public.user_locations (user_id, location_id, role) values (auth.uid(), v_loc, 'owner');
  insert into public.devices (location_id, name, type) values (v_loc, 'Mal till', 'pos') returning id into v_dev;
  v_code := public.issue_pairing_code(v_dev);
  perform public.claim_device_v2(v_code ->> 'code');
end $$;""")
mal_dev, _, _ = run("select id from public.devices where name = 'Mal till'")
o, e, r = as_('mallory', f"update public.devices set location_id = '{L1}' where id = '{mal_dev}';")
expect('after file B: the self paired login still cannot move its till to a victim venue', r != 0 and 'both venues' in e, e)
o, e, r = as_('mallory', f"insert into public.devices (id, location_id, name) values ('{mal_dev}', '{L1}', 'x') on conflict (id) do update set location_id = excluded.location_id;")
expect('after file B: nor by upsert', r != 0, e)
o, e, r = as_('mallory', f"select count(*) from public.order_queue where location_id = '{L1}'; select public.pos_can_access('{L1}'::text);")
expect('after file B: she reads no victim orders and is not staff there', last(o) == 'f', o + e)
o, e, r = as_('dev1b', "select coalesce(public.claim_device('APPLE-1111')::text, 'null');")
expect('no re-link by saved code after file B', last(o) == 'null', o + e)
o, e, r = as_commit('owner1', f"insert into public.devices (location_id, name, type, pairing_code, status) values ('{L1}', 'B till', 'pos', 'APPLE-9999', 'unpaired');")
o2, _, _ = run("select pairing_code from public.devices where name = 'B till'")
expect('a browser made code is replaced by a server code', o2 != 'APPLE-9999' and len(o2) == 14, o2)
o, e, r = as_commit('owner1', "select public.issue_pairing_code(id)->>'code' from public.devices where name = 'B till';")
code = last(o)
o, e, r = as_('newtill', f"select public.claim_device_v2('{code}')->>'ok';")
expect('new till pairs with the issued code', last(o) == 'true', o + e)

# --- orders
o, e, r = as_('attacker', "select count(*) from public.order_queue;")
expect('a stranger reads no orders', last(o) == '0', o + e)
o, e, r = as_('attacker', f"insert into public.order_queue (ref, location_id, type, source, status, items) values ('X1', '{L1}', 'collection', 'online', 'prep', '[]');")
expect('a stranger cannot insert an order', r != 0, e)
o, e, r = as_('attacker', "with u as (update public.order_queue set status = 'collected' returning 1) select count(*) from u;")
expect('a stranger updates no order', last(o) == '0', o + e)
o, e, r = as_('dev1', f"insert into public.order_queue (ref, location_id, type, source, status, items) values ('POS-1', '{L1}', 'collection', 'pos', 'prep', '[]'); select count(*) from public.order_queue;")
expect('a till writes and reads its venue orders', r == 0 and int(last(o)) >= 1, o + e)
o, e, r = as_('dev1', f"insert into public.order_queue (ref, location_id, type, source, status, items) values ('POS-2', '{L3}', 'collection', 'pos', 'prep', '[]');")
expect('a till cannot write another venue orders', r != 0, e)
o, e, r = as_('dev4', f"insert into public.order_queue (ref, location_id, type, source, status, items) values ('K-1', '{L1}', 'collection', 'kiosk', 'prep', '[]');")
expect('a kiosk writes its venue orders', r == 0, e)
o, e, r = as_('owner1', "select count(*) from public.order_queue;")
expect('Back Office reads its orders', r == 0 and int(last(o)) >= 1, o + e)
o, e, r = as_('rawanon', f"insert into public.order_queue (ref, location_id, type, source, status, items) values ('X2', '{L1}', 'collection', 'online', 'prep', '[]');")
expect('raw anon key cannot insert orders', r != 0 and 'permission denied' in e, e)
o, e, r = as_('dev1', f"insert into public.kds_tickets (id, location_id, items) values ('k1', '{L1}', '[]');")
expect('a till writes KDS tickets', r == 0, e)
o, e, r = as_('attacker', f"insert into public.kds_tickets (id, location_id, items) values ('k2', '{L1}', '[]');")
expect('a stranger cannot write KDS tickets', r != 0, e)
o, e, r = as_('attacker', "select count(*) from public.kds_tickets;")
expect('a stranger reads no KDS tickets', last(o) == '0', o + e)
o, e, r = as_('dev1', f"insert into public.print_jobs (location_id, printer_id, printer_ip, job_type, payload, status) values ('{L1}', 'p', '1.2.3.4', 'receipt', 'eA==', 'pending');")
expect('a till writes print jobs', r == 0, e)
o, e, r = as_('rawanon', "select count(*) from public.print_jobs;")
expect('raw anon key reads no print jobs', last(o) == '0', o + e)
run(f"insert into public.print_jobs (location_id, printer_id, printer_ip, job_type, payload, status) values ('{L1}', 'p1', '10.0.0.5', 'receipt', 'eA==', 'pending');")
o, e, r = as_commit('owner1', f"select public.issue_print_agent_token('{L1}', 'agent')->>'token';")
agent = last(o)
o, e, r = as_('rawanon', f"select jsonb_array_length(public.print_agent_claim('{agent}', 'a1')->'jobs');")
expect('print agent still claims jobs with its key', last(o) == '1', o + e)
# --- tables
o, e, r = as_('dev1', f"insert into public.active_sessions (location_id, table_id, session) values ('{L1}', 't1', '{{}}');")
expect('a till writes table sessions', r == 0, e)
o, e, r = as_('attacker', "select count(*) from public.active_sessions;")
expect('a stranger reads no table sessions', last(o) == '0', o + e)
o, e, r = as_('attacker', f"insert into public.active_sessions (location_id, table_id, session) values ('{L1}', 't2', '{{}}');")
expect('a stranger cannot write table sessions', r != 0, e)
run(f"insert into public.waitlist_devices (device_uid, name, location_id, active) values ('{UID['customer']}', 'Host', '{L1}', true);")
o, e, r = as_('customer', f"insert into public.active_sessions (location_id, table_id, session) values ('{L1}', 't3', '{{}}');")
expect('the venue host stand still seats guests (B4)', r == 0, e)
o, e, r = as_('dev1', f"insert into public.table_reservations (location_id, table_id, reservation) values ('{L1}', 't1', '{{}}');")
expect('a till writes table reservations', r == 0, e)
o, e, r = as_('attacker', "select count(*) from public.table_reservations;")
expect('a stranger reads no reservations', last(o) == '0', o + e)
# --- payments
o, e, r = as_('attacker', f"insert into public.closed_checks (id, location_id, source, status, total) values ('fake', '{L1}', 'online', 'paid', 999);")
expect('a stranger cannot insert paid revenue (B3)', r != 0, e)
o, e, r = as_('dev1', f"insert into public.closed_checks (id, location_id, source, status, total) values ('real', '{L1}', 'pos', 'paid', 9);")
expect('a till closes a check', r == 0, e)
o, e, r = as_('dev4', f"insert into public.closed_checks (id, location_id, source, status, total, kiosk_id) values ('kio', '{L1}', 'kiosk', 'paid', 9, '{DEV['kiosk1']}');")
expect('a kiosk closes a check', r == 0, e)
# --- customer path end to end, with the QR floor trigger
run(f"insert into public.floor_tables (id, location_id, label) values ('ft-7', '{L1}', 'T7') on conflict do nothing;")
proof('pi_tab_000000009', 'preauth', 5000)
tab = {'ref': 'QR-B1', 'source': 'qr', 'type': 'dine-in', 'items': [{'itemId': 'mi-beer', 'name': 'Beer', 'price': 6, 'qty': 2}], 'total': 12,
       'customer': {'name': 'Bob', 'tableId': 'T7', 'tab_open': True, 'payment_intent_id': 'pi_tab_000000009'}}
o, e, r = as_commit('customer', f"select public.place_public_order('{L1}', '{q(tab)}'::jsonb)->>'ok';")
expect('QR tab opened through the function', last(o) == 'true', o + e)
o, e, r = run(f"select session->>'source', (session->>'subtotal')::numeric = 12 from public.active_sessions where location_id = '{L1}' and table_id = 'ft-7'")
expect('the tab shows on the floor plan (server trigger), at the server price', o == 'qr|t', o)
evil = dict(tab, ref='QR-EVIL', customer=dict(tab['customer'], name='Eve'))
o, e, r = as_('attacker', f"select public.place_public_order('{L1}', '{q(evil)}'::jsonb)->>'reason';")
expect('after file B a stranger still cannot add a round to the tab', last(o) == 'tab_not_yours', o + e)
payq = {'ref': 'QR-PAYB', 'source': 'qr', 'type': 'dine-in', 'items': [{'itemId': 'mi-pizza', 'name': 'Pizza', 'price': 12, 'qty': 1}], 'total': 12,
        'customer': {'tableId': 'T8', 'payment_intent_id': 'pi_payb_00001'}}
run(f"insert into public.floor_tables (id, location_id, label) values ('ft-8', '{L1}', 'T8') on conflict do nothing;")
o, e, r = as_commit('customer', f"select public.place_public_order('{L1}', '{q(payq)}'::jsonb, '{q({'id': 'chk-payb', 'total': 12, 'stripe_payment_intent_id': 'pi_payb_00001'})}'::jsonb);")
o2, _, _ = run(f"select count(*) from public.active_sessions where location_id = '{L1}' and table_id = 'ft-8'")
expect('an unproven QR pay now order does not reach the floor plan', j(o).get('payment_unverified') is True and o2 == '0', o + o2)
proof('pi_payb_00001', 'card', 1200)
o, e, r = as_commit('customer', f"select public.verify_public_order_payment('{L1}', 'QR-PAYB');")
o2, _, _ = run(f"select session->>'source' from public.active_sessions where location_id = '{L1}' and table_id = 'ft-8'")
expect('once verified it is paid and reaches the floor plan', j(o).get('paid') is True and o2 == 'qr', o + o2)
proof('pi_tab_000000009', 'capture', 1200)
o, e, r = as_commit('customer', f"select public.settle_qr_tab('{L1}', 'pi_tab_000000009')->>'closed';")
expect('customer closes the tab after capture', last(o) == '1', o + e)
o, e, r = run(f"select count(*) from public.active_sessions where location_id = '{L1}' and table_id = 'ft-7'")
expect('the closed tab leaves the floor plan', o == '0', o)
o, e, r = as_('rawanon', f"select public.order_track_row('{L1}', 'QR-B1', 'pi_tab_000000009')->>'status';")
expect('tracker by card payment id (QR)', last(o) == 'collected', o + e)

t.finish()
