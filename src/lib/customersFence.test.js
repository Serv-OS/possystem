// src/lib/customersFence.test.js
//
// Database fence stage 2, part 1: the customer records.
//
// Live on 20 Sep 2026, with nothing but the public app key that sits in every page, anyone
// could read every customer of every venue: the policies on customers, customer_locations
// and customer_orders each ended "or the caller is anonymous". These tests pin the app half
// of the fix: the pages ask the server instead, and they still work while the SQL file has
// not been run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isMissingFn } from './customerFenceRules.js';

const LOOKUP = readFileSync(new URL('./customerLookup.js', import.meta.url), 'utf8');
const ONLINE = readFileSync(new URL('../surfaces/online/OnlineCheckout.jsx', import.meta.url), 'utf8');
const QR = readFileSync(new URL('../surfaces/qr/QrCheckout.jsx', import.meta.url), 'utf8');
const SQL = readFileSync(new URL('../../supabase/migrations/20260921_OPS_customers_fence.sql', import.meta.url), 'utf8');

test('isMissingFn: only "the function is not there yet" takes the old path', () => {
  assert.equal(isMissingFn({ code: 'PGRST202' }), true, 'PostgREST unknown RPC');
  assert.equal(isMissingFn({ code: '42883' }), true, 'Postgres unknown function');
  assert.equal(isMissingFn({ message: 'Could not find the function public.customer_by_phone' }), true);
  assert.equal(isMissingFn({ message: 'function public.customer_by_phone(text, text) does not exist' }), true);
  // a refusal is NOT a missing function: it must never send us back to the table
  assert.equal(isMissingFn({ code: '42501', message: 'permission denied for table customers' }), false);
  assert.equal(isMissingFn({ code: 'PGRST301', message: 'JWT expired' }), false);
  assert.equal(isMissingFn(null), false);
  assert.equal(isMissingFn(undefined), false);
});

test('the lookup asks the server first, and only falls back when the function is missing', () => {
  const fn = LOOKUP.slice(LOOKUP.indexOf('export async function fetchCustomerByPhone'));
  const rpcAt = fn.indexOf("supabase.rpc('customer_by_phone'");
  const tableAt = fn.indexOf(".from('customers')");
  assert.ok(rpcAt > 0, 'the server function is called');
  assert.ok(tableAt > rpcAt, 'the table read is the fallback, not the first choice');
  const between = fn.slice(rpcAt, tableAt);
  assert.match(between, /isMissingFn\(rpc\.error\)/, 'the fallback is gated on the function being missing');
  // a refusal must return null, never read the table
  assert.match(fn.slice(rpcAt), /else if \(rpc\.error\)[\s\S]{0,200}return null;/);
});

test('attribution goes through the server, and its answer is final', () => {
  const fn = LOOKUP.slice(LOOKUP.indexOf('export async function attributeOnlineOrder'));
  const rpcAt = fn.indexOf("supabase.rpc('attribute_public_order'");
  assert.ok(rpcAt > 0, 'the server function is called');
  assert.match(fn.slice(rpcAt, rpcAt + 900), /p_key: trackKey/, "this order's own key is sent");
  // when the server answered at all, the direct writes are never reached
  assert.match(fn.slice(rpcAt), /if \(!isMissingFn\(rpc\.error\)\)[\s\S]{0,1400}if \(!customerId\) return null;/);
  // and when it did the work, we return without touching the tables
  assert.match(fn, /if \(serverDidIt\) \{[\s\S]{0,400}return customerId;/);
  // the welcome and the loyalty earn still happen on both paths
  assert.match(fn, /sendWelcomeFor\(customerId, locationId\)/);
  assert.match(fn, /earnForOnlineOrder\(\{ customerId, locationId, orderRecord, memberToken, memberCustomerId \}\)/);
});

test('every checkout sends the key that proves it placed the order', () => {
  const onlineCalls = ONLINE.split('attributeOnlineOrder({').slice(1);
  assert.equal(onlineCalls.length, 2, 'online has its two payment paths');
  for (const call of onlineCalls) {
    assert.match(call.slice(0, 900), /trackKey: chooseTrackKey\(\{ trackToken: placed\?\.trackToken/);
  }
  assert.match(QR, /trackKey: chooseTrackKey\(\{ trackToken: placed\?\.trackToken/);
  assert.match(ONLINE, /import \{[^}]*chooseTrackKey[^}]*\} from '\.\.\/\.\.\/lib\/publicOrder'/);
  assert.match(QR, /import \{[^}]*chooseTrackKey[^}]*\} from '\.\.\/\.\.\/lib\/publicOrder'/);
});

test('the SQL closes the anonymous escape hatch and keeps nothing open by accident', () => {
  // the three tables lose their old rule
  for (const t of ['customers', 'customer_locations', 'customer_orders']) {
    assert.match(SQL, new RegExp(`drop policy if exists ${t}_all on public\\.${t};`));
    assert.match(SQL, new RegExp(`create policy ${t}_venue on public\\.${t}`));
  }
  // grants are named, because schema public grants new functions to anon by default
  for (const fn of ['customer_org_visible\\(uuid\\)', 'customer_by_phone\\(text, text\\)',
    'attribute_public_order\\(text, text, text, jsonb, jsonb\\)']) {
    assert.match(SQL, new RegExp(`revoke all on function public\\.${fn} from public, anon, authenticated;`));
  }
  // the raw public key loses the tables outright
  for (const t of ['customers', 'customer_locations', 'customer_orders']) {
    assert.match(SQL, new RegExp(`revoke all on table public\\.${t} from anon;`));
  }
  // the file checks itself before it changes anything, and can be rolled back
  assert.match(SQL, /Self test: the public key can still reach a customer table/);
  assert.match(SQL, /Self test: an anonymous escape hatch is still on a customer table/);
  assert.match(SQL, /ROLL BACK/);
  // and it refuses to run on a database that has not had stage 1
  assert.match(SQL, /pos_can_access is missing/);
  assert.match(SQL, /_order_track_ok is missing/);
});

test('the attribution function only writes for someone who holds the order', () => {
  const fn = SQL.slice(SQL.indexOf('create or replace function public.attribute_public_order'));
  assert.match(fn, /_order_track_ok\(p_location_id, p_ref, p_key\) or public\.pos_can_access\(p_location_id\)/);
  assert.match(fn, /'reason', 'not_yours'/);
  // the order must exist at that venue
  assert.match(fn, /from public\.order_queue q[\s\S]{0,200}'no_order'/);
  // a name the venue curated is never overwritten, and a null name is never written
  assert.match(fn, /case when coalesce\(btrim\(name\), ''\) = '' and v_name <> '' then v_name else name end/);
  // one order row per ref, so a retry cannot double count a visit
  assert.match(fn, /if not exists \(select 1 from public\.customer_orders co[\s\S]{0,260}closed_check_id = p_ref\)/);
});

test('the lookup function answers only for the venue, and only with what the till shows', () => {
  const fn = SQL.slice(SQL.indexOf('create or replace function public.customer_by_phone'),
    SQL.indexOf('create or replace function public.attribute_public_order'));
  assert.match(fn, /if not public\.pos_can_access\(p_location_id\) then[\s\S]{0,60}return null;/);
  assert.match(fn, /jsonb_build_object\([\s\S]{0,200}'marketing_opt_in'/);
  for (const secret of ['notes', 'tags', 'stored_payment_method_id', 'allergens']) {
    assert.ok(!new RegExp(`'${secret}',`).test(fn), `${secret} is never returned`);
  }
});
