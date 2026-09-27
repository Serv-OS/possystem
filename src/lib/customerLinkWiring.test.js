// src/lib/customerLinkWiring.test.js
//
// WHERE "LINK TO EXISTING MEMBER" IS WIRED, AND WHAT IT MAY NEVER DO (27 Sep 2026). Source pins.
//
// Peter: "if a customer adds their number and then a staff member can link that to a profile that
// currently has no number". Coffee Boy Leeds: "we have details disabled so only the phone number
// is there for takeaway and collection so nowhere to type those details in". The chip offers the
// link whatever the details setting; the search lists only profiles with no phone; a tap calls
// customer-merge with the till's own session (the server's empty shell rule is the authority).
// These pins fail if the wiring drifts.
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

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const callersOf = (re) => walk(SRC)
  .filter((f) => re.test(code(fs.readFileSync(f, 'utf8'))))
  .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
  .sort();

test('the chip: "Link to existing member" shows for a new customer, whatever the details setting, never in training', () => {
  const pos = code(read('surfaces/POSSurface.jsx'));
  assert.match(pos, /import LinkMemberModal from '\.\.\/components\/LinkMemberModal';/);
  assert.match(pos, /import \{ canOfferLink, displayProfileLooksBlank \} from '\.\.\/lib\/customerLink';/);
  assert.match(pos, /\{canOfferLink\(customer\)&&!isTrainingMode\(\)&&\(/);
  assert.match(pos, /onClick=\{\(\)=>setLinkMemberFor\(customer\)\}[^>]*>Link to existing member<\/button>/);
  // the offer depends on the customer only, never on takeawayCustomerDetails or nameOnly
  const offer = pos.slice(pos.indexOf('{canOfferLink(customer)'), pos.indexOf('Link to existing member</button>'));
  assert.doesNotMatch(offer, /takeawayCustomerDetails|nameOnly|orderType/);
  assert.doesNotMatch(code(read('lib/customerLink.js')), /takeawayCustomerDetails|nameOnly|orderType/);
  // the chip sits inside the customer chip, next to the phone line
  const chip = pos.indexOf('{customerInitials(customer.name, customer.phone)}');
  const button = pos.indexOf('{canOfferLink(customer)&&');
  const edit = pos.indexOf('>Edit</button>', chip);
  assert.ok(chip > 0 && button > chip && button < edit);
  assert.match(pos, /\{linkMemberFor&&<LinkMemberModal customer=\{linkMemberFor\} onLinked=\{applyMemberLink\} onClose=\{\(\)=>setLinkMemberFor\(null\)\}\/>\}/);
});

test('the display marks an empty profile, so a typed order name (name only form) still gets the offer', () => {
  const pos = code(read('surfaces/POSSurface.jsx'));
  assert.match(pos, /const next = \{ \.\.\.cur, phone, name: res\.name \|\| cur\.name \|\| '', stampSummary: stamps, blankProfile: displayProfileLooksBlank\(res\) \};/);
  assert.match(pos, /delete next\.memberLinked;\s*setCustomer\(next\);/);
});

test('after the link the order becomes the member, a table keeps them, and the display greets them', () => {
  const pos = code(read('surfaces/POSSurface.jsx'));
  const fnStart = pos.indexOf('const applyMemberLink = (res, linkedFrom) => {');
  assert.ok(fnStart > 0);
  const fn = pos.slice(fnStart, pos.indexOf('\n  };', fnStart));
  assert.match(fn, /showToast\?\.\(res\.toast, 'success'\);/);
  assert.match(fn, /String\(cur\.phone \?\? ''\) !== String\(linkedFrom\?\.phone \?\? ''\)/, 'never rewrites an order that moved on');
  assert.match(fn, /setCustomer\(res\.customer\);/);
  assert.match(fn, /st\.setSessionCustomer\(tblId, res\.customer\)/);
  assert.match(fn, /if \(res\.loyalty && displayUsesScreen\(\)\) \{ try \{ publishLoyalty\(res\.loyalty\); \}/);
});

test('the search: the till customer search with { phoneless: true }, ONLY profiles with no phone', () => {
  const modal = code(read('components/LinkMemberModal.jsx'));
  assert.match(modal, /await searchCustomersLive\(term, \{ phoneless: true \}\)/);
  assert.match(modal, /setFound\(\{ term, rows: phonelessResults\(live\) \}\);/, 'the list is filtered again on screen');
  assert.match(modal, /const rows = term && found\.term === term \? found\.rows : \[\];/, 'a list is shown only for the text on screen now');
  assert.match(modal, /no phone<\/span>/, 'each result is marked "no phone"');
  const store = code(read('store/index.js'));
  const search = action(store, 'searchCustomersLive');
  assert.match(search, /const phoneless = opts\?\.phoneless === true;/);
  assert.match(search, /if \(orgId && phoneless\) \{\s*enriched = \(await searchPhonelessMembers\(\{ db: supabase, orgId, q: term \}\)\)\.rows;/);
  // it stops before the phone fallback and before the till's customer cache is touched
  const stop = search.indexOf('if (phoneless) return phonelessResults(enriched);');
  assert.ok(stop > 0 && stop < search.indexOf('phoneFilters') && stop < search.indexOf('set({ customerHistory'));
  // the query itself asks for no phone
  const run = code(read('lib/customerLinkRun.js'));
  const q = run.slice(run.indexOf('export async function searchPhonelessMembers('), run.indexOf('export async function readLinkFacts('));
  assert.match(q, /\.eq\('org_id', orgId\)\.is\('deleted_at', null\)\.is\('phone', null\)/);
  assert.match(q, /\.or\(`name\.ilike\.%\$\{term\}%,email\.ilike\.%\$\{term\}%`\)/);
  assert.match(q, /const term = linkSearchTerm\(q\);/);
});

test('the tap: one store action, the till session, customer-merge through the same guarded call as the email join', () => {
  const modal = code(read('components/LinkMemberModal.jsx'));
  assert.match(modal, /await linkOrderCustomerToMember\(customer, row\)/);
  assert.match(modal, /if \(busyRef\.current \|\| !row\?\.id\) return;/, 'a second tap while it links does nothing');
  assert.doesNotMatch(modal, /confirm\(|window\.confirm|Are you sure/, 'Peter: automatic, no extra question');
  const store = code(read('store/index.js'));
  const a = action(store, 'linkOrderCustomerToMember');
  assert.match(a, /if \(isTrainingMode\(\)\) return linkRefused\('training'\);/);
  assert.match(a, /if \(isMock \|\| !supabase\) return linkRefused\('offline'\);/);
  assert.match(a, /locId === 'loc-demo'/);
  assert.match(a, /postMerge: postCustomerMerge,/);
  assert.match(a, /sendNotice: \(body\) => postJoinNotice\(\{ \.\.\.body, location_id: locId \}\),/);
  assert.match(a, /lookup: \(phone\) => fetchCustomerByPhone\(phone, locId\),/, 'stamps through the lookup the display uses');
  // the only callers
  assert.deepEqual(callersOf(/linkOrderCustomerToMember\b/), ['components/LinkMemberModal.jsx', 'store/index.js']);
  assert.deepEqual(callersOf(/\blinkOrderCustomer\(/), ['lib/customerLinkRun.js', 'store/index.js']);
  // the merge: source = the empty profile the phone is on, target = the member; preview first
  const run = code(read('lib/customerLinkRun.js'));
  assert.match(run, /joinShellIntoProfile\(\{ postMerge, locId, sourceId: d\.source\.id, targetId: m\.id \}\)/);
  assert.doesNotMatch(run, /phoneChoice|phone_choice/, 'a till never chooses between two phones');
  assert.doesNotMatch(run, /gift/i);
  assert.doesNotMatch(run, /import\.meta|from '\.\/supabase'|from '\.\.\/store'/);
});

test('order close still never joins, and the customer display still only makes the empty profile', () => {
  const store = code(read('store/index.js'));
  const close = action(store, 'attributeOrderToCustomer');
  assert.doesNotMatch(close, /linkOrderCustomer|searchPhonelessMembers|customer-merge/);
  for (const f of ['surfaces/OrdersHub.jsx', 'surfaces/KioskApp.jsx', 'lib/customerLookup.js', 'surfaces/CustomerDisplaySurface.jsx']) {
    assert.doesNotMatch(code(read(f)), /linkOrderCustomer|customer-merge|customer-join-notice/, f);
  }
});

test('MPOS has no order chip to offer it on: its cart shows the name only and its capture needs a name', () => {
  const cart = code(read('surfaces/mpos/MCartSheet.jsx'));
  assert.doesNotMatch(cart, /customerInitials|customerLabel|stampChip/);
  const capture = code(read('surfaces/mpos/MCustomerCapture.jsx'));
  assert.match(capture, /if \(!name\.trim\(\)\) e\.name = 'Customer name required';/);
});
