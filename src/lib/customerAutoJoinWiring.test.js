// src/lib/customerAutoJoinWiring.test.js
//
// WHERE THE TILL MAY JOIN BY EMAIL, AND WHERE IT NEVER MAY (27 Sep 2026). Source pins.
//
// Peter decided the till joins a customer by email with no question to staff, but ONLY in the two
// interactive forms where staff typed the phone and the email: the POS customer modal and the MPOS
// capture sheet. Order close (attributeOrderToCustomer), an order reopened from the Orders Hub,
// the customer display (captureLoyaltyByPhone) and every background save are fed by data the
// public key can write (order_queue, active_sessions, the display), so they stay PHONE ONLY, as
// before. These pins fail if any of them starts joining by email.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const read = (rel) => fs.readFileSync(path.resolve(SRC, rel), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** The source of one store action, from its name to the next top level action. */
function action(src, name) {
  const start = src.indexOf(`\n  ${name}: async`);
  assert.ok(start > 0, `store action ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}[A-Za-z_$][\w$]*: /);
  return next > 0 ? rest.slice(0, next) : rest;
}

/** One exported function's source from a module. */
function fn(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nexport (async )?function /);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('ONLY the two interactive customer forms call the join by email', () => {
  const callers = walk(SRC)
    .filter((f) => /autoJoinCustomerByEmail\b/.test(code(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(callers, ['components/CustomerModal.jsx', 'store/index.js', 'surfaces/mpos/MCustomerCapture.jsx']);
  // and the run itself is reached only through the store action
  const runners = walk(SRC)
    .filter((f) => /\bautoJoinCustomer\(/.test(code(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(runners, ['lib/customerAutoJoinRun.js', 'store/index.js']);
});

test('(d) order close, every save and the background paths stay phone only', () => {
  const store = code(read('store/index.js'));
  const upsert = action(store, 'upsertCustomer');
  assert.match(upsert, /return await upsertCustomerRow\(\{ db: supabase, orgId, c, phoneN \}\)/);
  assert.doesNotMatch(upsert, /autoJoin|ilike|'email'/);
  const close = action(store, 'attributeOrderToCustomer');
  assert.match(close, /await get\(\)\.upsertCustomer\(customer\)/);
  assert.doesNotMatch(close, /autoJoin|customer-merge|CUSTOMER_MERGE_FN|ilike\('email'/);
  // the phone only save never reads by email
  const row = fn(read('lib/customerAutoJoinRun.js'), 'upsertCustomerRow');
  assert.doesNotMatch(code(row), /ilike|eq\('email'|or\(/);
  assert.match(code(row), /\.eq\('org_id', orgId\)\.eq\('phone', phoneN\)\.is\('deleted_at', null\)/);
});

test('(d) the Orders Hub reopen, the kiosk and the customer display never join by email', () => {
  for (const f of ['surfaces/OrdersHub.jsx', 'surfaces/KioskApp.jsx', 'surfaces/POSSurface.jsx', 'surfaces/TablesSurface.jsx', 'lib/customerLookup.js']) {
    assert.doesNotMatch(code(read(f)), /autoJoin|customer-merge|customer-join-notice/, f);
  }
  // the customer display only has a phone: it still makes the empty profile and texts the sign up link
  const lookup = code(read('lib/customerLookup.js'));
  const start = lookup.indexOf('export async function captureLoyaltyByPhone(');
  const body = lookup.slice(start, lookup.indexOf('\nexport async function', start + 10));
  assert.match(body, /\.insert\(\{ org_id: orgId, phone: phoneN, phone_raw: rawPhone, name: '', marketing_opt_in: false \}\)/);
  assert.match(body, /functions\/v1\/send-welcome/);
  assert.doesNotMatch(body, /email/i);
});

test('the POS customer modal joins only on an email typed in it, with the phone fields showing', () => {
  const src = code(read('components/CustomerModal.jsx'));
  assert.match(src, /if \(!nameOnly && phone\.trim\(\) && typeof autoJoinCustomerByEmail === 'function'\)/);
  assert.match(src, /autoJoinCustomerByEmail\(customer, \{ openedWithEmail: existing\?\.email \|\| '' \}\)/);
  // before the save and the hand on, so the order uses the joined profile
  const join = src.indexOf('autoJoinCustomerByEmail(customer');
  assert.ok(join > 0 && join < src.indexOf('addToHistory(customer);') && join < src.indexOf('onConfirm(customer);'));
  // a second tap while it checks does nothing
  assert.match(src, /if \(busyRef\.current\) return;/);
  assert.match(src, /onClick=\{handleConfirm\} disabled=\{busy\}/);
  // the toast is delayed so the caller's attach toast cannot paint over it
  assert.match(src, /\(showDelayedToast \|\| showToast\)\(joined\.toast/);
  // closed while it checks: the customer is not attached afterwards
  assert.match(src, /const cancel = \(\) => \{ closedRef\.current = true; onCancel\?\.\(\); \};/);
  assert.equal((src.match(/onClick=\{onCancel\}/g) || []).length, 0, 'every close goes through cancel');
  const closed = src.indexOf('if (closedRef.current) return;');
  assert.ok(closed > join && closed < src.indexOf('addToHistory(customer);'));
});

test('the MPOS capture sheet joins only on an email typed in it', () => {
  const src = code(read('surfaces/mpos/MCustomerCapture.jsx'));
  assert.match(src, /const \[openedWithEmail\] = useState\(customer\?\.email \|\| ''\);/);
  assert.match(src, /autoJoinCustomerByEmail\(next, \{ openedWithEmail \}\)/);
  const join = src.indexOf('autoJoinCustomerByEmail(next');
  assert.ok(join > 0 && join < src.indexOf('setCustomer(next);'));
  assert.match(src, /disabled=\{!valid \|\| busy\}/);
  // Back or Skip while it checks: the sheet does not carry on to the menu afterwards
  assert.match(src, /const onBack = \(\) => \{ leftRef\.current = true; backProp\?\.\(\); \};/);
  assert.match(src, /const onSkip = \(\) => \{ leftRef\.current = true; skipProp\?\.\(\); \};/);
  const left = src.indexOf('if (leftRef.current) return;');
  assert.ok(left > join && left < src.indexOf('setCustomer(next);'));
});

test("the store's join: training mode and mock write nothing; customer-merge waits for the device link", () => {
  const store = code(read('store/index.js'));
  const a = action(store, 'autoJoinCustomerByEmail');
  assert.match(a, /if \(isTrainingMode\(\)\) return none;/);
  assert.match(a, /if \(isMock \|\| !supabase\) return none;/);
  assert.match(a, /locId === 'loc-demo'/);
  assert.match(a, /postMerge: postCustomerMerge/);
  assert.match(a, /sendNotice: \(body\) => postJoinNotice\(\{ \.\.\.body, location_id: locId \}\)/);
  const merge = store.slice(store.indexOf('async function postCustomerMerge('), store.indexOf('async function postJoinNotice('));
  assert.match(merge, /await whenDeviceClaimed\(\);/);
  assert.match(merge, /claimPairedDeviceOnBoot\(\)/);
  assert.match(merge, /functions\/v1\/\$\{CUSTOMER_MERGE_FN\}/);
  assert.match(store, /functions\/v1\/customer-join-notice/);
});

test('the join module never touches a gift card, never picks a phone for the till, never imports a client', () => {
  const run = code(read('lib/customerAutoJoinRun.js'));
  const rules = code(read('lib/customerAutoJoin.js'));
  for (const s of [run, rules]) {
    assert.doesNotMatch(s, /gift/i);
    assert.doesNotMatch(s, /import\.meta|from '\.\/supabase'|from '\.\.\/store'/);
  }
  // a till never chooses between two phones: no phone_choice is ever sent
  assert.doesNotMatch(run, /phoneChoice|phone_choice/);
  // the claim only ever writes into a phone that is still empty as read
  const claim = fn(read('lib/customerAutoJoinRun.js'), 'claimPhoneForProfile');
  assert.match(claim, /q = exactly\(q, 'phone', holder\.phone \?\? null\);/);
  assert.match(claim, /q = exactly\(q, 'phone_raw', holder\.phone_raw \?\? null\);/);
  assert.match(claim, /q = exactly\(q, 'email', holder\.email \?\? null\);/);
});
