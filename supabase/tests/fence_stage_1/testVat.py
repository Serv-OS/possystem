#!/usr/bin/env python3
"""20260927c (settle_qr_tab books the VAT the guest's phone worked out) on the local throwaway
copy. Run after build_baseline.py: python3 testVat.py. Never Supabase.

27 Sep 2026: since the fence, the check for a QR tab the guest closes on their phone is written by
settle_qr_tab, which never set tax_amount, so a UK venue booked no VAT on it. The phone now sends
tax_amount and exclusive_tax in p_check (TabResumeScreen, headlessTax.qrTabSettleVat)."""
import json
import t
from t import as_, as_commit, expect, last, L1, run

FILE_VAT = '20260927c_OPS_settle_qr_tab_vat.sql'
SIG = "'public.settle_qr_tab(uuid, text, jsonb, uuid[])'::regprocedure"

def j(o):
    try:
        return json.loads(last(o))
    except Exception:
        return {}

def q(x):
    return json.dumps(x).replace("'", "''")

def proof(ref, kind, amount):
    run(f"insert into public.payment_proofs (processor, payment_ref, kind, location_id, amount_minor, verified_by) values ('stripe', '{ref}', '{kind}', '{L1}', {amount}, 'test')")

def beers(n):
    return [{'itemId': 'mi-beer', 'name': 'Beer', 'price': 6, 'qty': n}]

def open_tab(ref, pi, table, items, total, tip=0):
    proof(pi, 'preauth', 20000)
    order = {'ref': ref, 'source': 'qr', 'type': 'dine-in', 'items': items, 'total': total,
             'customer': {'name': 'Val', 'tableId': table, 'tableLabel': table, 'tab_open': True,
                          'payment_intent_id': pi, 'tip': tip}}
    o, e, r = as_commit('customer', f"select public.place_public_order('{L1}', '{q(order)}'::jsonb);")
    expect(f'tab {ref} is placed', j(o).get('ok') is True, o + e)

def settle(pi, check):
    return as_commit('customer', f"select public.settle_qr_tab('{L1}', '{pi}', '{q(check)}'::jsonb, '{{}}'::uuid[]);")

def booked(ref):
    """tax_amount, subtotal, tip, total, tax_breakdown, tenders of the check the server wrote."""
    o, _, _ = run(f"select json_build_array(tax_amount, subtotal, tip, total, tax_breakdown, to_jsonb(c) -> 'tenders') from public.closed_checks c where ref = '{ref}' and source = 'qr'")
    try:
        a = json.loads(o)
    except Exception:
        return None
    num = lambda v: None if v is None else round(float(v), 2)
    return {'tax': num(a[0]), 'subtotal': num(a[1]), 'tip': num(a[2]), 'total': num(a[3]), 'breakdown': a[4], 'tenders': a[5]}

def closes(ref, pi, table, items, total, capture, check, tip=0):
    open_tab(ref, pi, table, items, total, tip)
    proof(pi, 'capture', capture)
    o, e, r = settle(pi, check)
    return j(o), booked(ref), o + e

t.reset()
o, e, r = t.apply_a()
expect('a1 and a2 apply (the fence as it is live since 20 Sep)', r == 0, e[-2000:])
o, _, _ = run(f"select has_function_privilege('anon', {SIG}, 'execute')::text || '|' || has_function_privilege('authenticated', {SIG}, 'execute')::text")
grants_before = o

# ---------- the fault, on the live function: the phone's VAT is ignored and the check books null
st, b, d = closes('QR-V0', 'pi_vat_0', 'V0', beers(2), 12, 1200, {'table_label': 'Table V0', 'tax_amount': 2, 'exclusive_tax': 0})
expect('BEFORE 20260927c: a UK tab closed on the phone books tax_amount null, whatever the phone sends',
       st.get('ok') is True and b and b['tax'] is None and b['subtotal'] == 12.0, d + json.dumps(b))
before_tenders = b and b['tenders']

# ---------- the file
o, e, r = t.apply(FILE_VAT)
expect('20260927c applies cleanly (one transaction)', r == 0, e[-2000:])
expect('its check says the function books VAT', last(o).split('|')[0] == 't', o)
o, e, r = t.apply(FILE_VAT)
expect('20260927c applies a second time (idempotent, its guard passes on itself)', r == 0, e[-2000:])
o, _, _ = run(f"select has_function_privilege('anon', {SIG}, 'execute')::text || '|' || has_function_privilege('authenticated', {SIG}, 'execute')::text")
expect('the grants are exactly the ones 20260919a2 set', o == grants_before, o + ' vs ' + grants_before)

# ---------- UK inclusive VAT
st, b, d = closes('QR-V1', 'pi_vat_1', 'V1', beers(2), 12, 1200, {'table_label': 'Table V1', 'tax_amount': 2, 'exclusive_tax': 0})
expect('a UK tab closed on the phone books the VAT the phone worked out (2.00 on 12.00 of beer)',
       st.get('ok') is True and b['tax'] == 2.0, d + json.dumps(b))
expect('and nothing else moves: subtotal 12.00, tip 0, total 12.00, tax_breakdown [] (a UK whole bill, as before)',
       b['subtotal'] == 12.0 and b['tip'] == 0 and b['total'] == 12.0 and b['breakdown'] == [], json.dumps(b))
expect('the tenders are what they were without VAT (money untouched)',
       json.dumps(b['tenders'], sort_keys=True).replace('pi_vat_1', 'X') == json.dumps(before_tenders, sort_keys=True).replace('pi_vat_0', 'X'),
       json.dumps(b['tenders']) + ' vs ' + json.dumps(before_tenders))

st, b, d = closes('QR-V2', 'pi_vat_2', 'V2', beers(2), 13, 1300, {'table_label': 'Table V2', 'tax_amount': 2, 'exclusive_tax': 0}, tip=1)
expect('with a real tip: sale 12.00, tip 1.00, VAT 2.00, total 13.00',
       b['subtotal'] == 12.0 and b['tip'] == 1.0 and b['tax'] == 2.0 and b['total'] == 13.0, d + json.dumps(b))

st, b, d = closes('QR-V3', 'pi_vat_3', 'V3', beers(1), 6, 600, {'table_label': 'Table V3'})
expect('a phone on an older bundle sends no VAT: null, exactly as before', st.get('ok') is True and b['tax'] is None and b['subtotal'] == 6.0, d + json.dumps(b))

# ---------- the page's figure is only ever a clamped number
st, b, d = closes('QR-V4', 'pi_vat_4', 'V4', beers(1), 6, 600, {'tax_amount': '1.00'})
expect('a VAT sent as a string is not a number: null', b['tax'] is None, d + json.dumps(b))
st, b, d = closes('QR-V5', 'pi_vat_5', 'V5', beers(1), 6, 600, {'tax_amount': -3})
expect('a negative VAT books 0.00, never less', b['tax'] == 0.0 and b['subtotal'] == 6.0, d + json.dumps(b))
st, b, d = closes('QR-V6', 'pi_vat_6', 'V6', beers(1), 6, 600, {'tax_amount': 999})
expect('a VAT above the goods books at most the goods (6.00), never more than was taken', b['tax'] == 6.0 and b['total'] == 6.0, d + json.dumps(b))
st, b, d = closes('QR-V7', 'pi_vat_7', 'V7', beers(1), 7, 700, {'tax_amount': 999}, tip=1)
expect('and never the tip: at most 6.00 of a 7.00 capture with a 1.00 tip', b['tax'] == 6.0 and b['tip'] == 1.0, d + json.dumps(b))
st, b, d = closes('QR-V8', 'pi_vat_8', 'V8', beers(1), 6, 600, {'tax_amount': 1, 'exclusive_tax': 'x'})
expect('an added-on part that is not a number counts as none', b['tax'] == 1.0 and b['subtotal'] == 6.0 and b['breakdown'] == [], d + json.dumps(b))

# ---------- added-on (US) tax: QR round totals include it, so it comes out of the subtotal
st, b, d = closes('QR-V9', 'pi_vat_9', 'V9', beers(2), 13.2, 1320, {'tax_amount': 1.2, 'exclusive_tax': 1.2})
expect('added-on tax: subtotal 12.00 (goods), tax 1.20, total 13.20 as taken',
       st.get('ok') is True and b['subtotal'] == 12.0 and b['tax'] == 1.2 and b['total'] == 13.2 and b['tip'] == 0, d + json.dumps(b))
bd = b['breakdown'] or {}
expect('and a record built by the server from the two numbers, flagged so reports read it as booked',
       isinstance(bd, dict) and bd.get('hasExclusiveTax') is True and float(bd.get('totalTax')) == 1.2
       and float(bd.get('exclusiveTax')) == 1.2 and bd.get('breakdown') == [] and set(bd) == {'totalTax', 'exclusiveTax', 'hasExclusiveTax', 'breakdown', 'source'},
       json.dumps(bd))
st, b, d = closes('QR-V10', 'pi_vat_10', 'V10', beers(1), 6, 600, {'tax_amount': 0.5, 'exclusive_tax': 50})
expect('an added-on part above the VAT is clamped to the VAT (subtotal 5.50, never below)', b['tax'] == 0.5 and b['subtotal'] == 5.5, d + json.dumps(b))

# ---------- everything else is the 20260919a2 function
open_tab('QR-V11', 'pi_vat_11', 'V11', beers(2), 12)
proof('pi_vat_11', 'capture', 500)
o, e, r = settle('pi_vat_11', {'tax_amount': 2})
expect('a short capture still closes nothing and books nothing', j(o).get('reason') == 'short' and booked('QR-V11') is None, o + e)
o, e, r = as_('attacker', f"select public.settle_qr_tab('{L1}', 'pi_vat_11', '{q({'tax_amount': 2})}'::jsonb, '{{}}'::uuid[])->>'reason';")
expect('a stranger still cannot close it', last(o) == 'not_yours', o + e)
o, e, r = settle('pi_vat_1', {'tax_amount': 5})
expect('closing an already closed tab again changes nothing (VAT stays 2.00)', j(o).get('reason') == 'already_closed' and booked('QR-V1')['tax'] == 2.0, o + e)

# ---------- the guard: never replace a function changed on the database since 20260919a2
run("create or replace function public.settle_qr_tab(p_location_id uuid, p_payment_intent_id text, p_check jsonb default '{}'::jsonb, p_proof_ids uuid[] default '{}'::uuid[]) returns jsonb language sql as $$ select '{\"hotfix\": true}'::jsonb $$")
o, e, r = t.apply(FILE_VAT)
o2, _, _ = run(f"select position('hotfix' in pg_get_functiondef({SIG})) > 0")
expect('20260927c refuses on a settle_qr_tab it was not written against, and changes nothing', r != 0 and 'not the 20260919a2 version' in e and o2 == 't', e[-500:] + o2)

t.finish()
