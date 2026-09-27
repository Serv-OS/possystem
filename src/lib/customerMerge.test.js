// src/lib/customerMerge.test.js
//
// THE SCREEN AND THE FUNCTION AGREE (26 Sep 2026). Back Office builds the customer-merge body in
// one place (src/lib/customerMerge.js mergeRequestBody) and the function reads it in one place
// (validateMergeRequest). This holds the two together key for key, pins the door of the function
// (who is asked first, what a till may never do), and pins the Back Office wiring: the merge
// button, and "already on <name>. Merge them?" instead of the raw unique index error that Ela
// Stettner's till save showed as "DB error".
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  mergeRequestBody, clashText, exactIlike, clashHolder, movesText, stampLine, CUSTOMER_MERGE_FN,
  uniqueClashOf, canStaffMerge,
} from './customerMerge.js';
import { validateMergeRequest } from '../../supabase/functions/_shared/customerMergePlan.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const ELA = 'cd96ff83-22ca-4af1-9af9-7ca5de9f6597';
const BLANK = 'c462cbfc-be83-4ee9-9459-91ea0a682215';
const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';

test('the body the screen posts is the body the function reads, key for key', () => {
  const body = mergeRequestBody({ action: 'preview', targetId: ELA, sourceId: BLANK, locationId: LEEDS });
  assert.deepEqual(body, { action: 'preview', target_id: ELA, source_id: BLANK, location_id: LEEDS });
  assert.deepEqual(validateMergeRequest(body), { ok: true, action: 'preview', targetId: ELA, sourceId: BLANK, locationId: LEEDS, phoneChoice: null });
  const chosen = mergeRequestBody({ action: 'merge', targetId: ELA, sourceId: BLANK, locationId: LEEDS, phoneChoice: 'source' });
  assert.equal(chosen.phone_choice, 'source');
  assert.equal(validateMergeRequest(chosen).phoneChoice, 'source');
  assert.equal('phone_choice' in mergeRequestBody({ action: 'merge', targetId: ELA, sourceId: BLANK, locationId: LEEDS, phoneChoice: 'nonsense' }), false);
  assert.equal(CUSTOMER_MERGE_FN, 'customer-merge');
});

test('customer-merge reads its body ONLY through validateMergeRequest, and asks who is calling first', () => {
  const src = code(read('../../supabase/functions/customer-merge/index.ts'));
  assert.match(src, /const r: any = validateMergeRequest\(body\);/);
  assert.doesNotMatch(src, /\bbody\.[a-z_]+/, 'no key is read from the body directly');
  // The second step check comes straight after the preflight, as in every Back Office function.
  const pre = src.indexOf("if (req.method === 'OPTIONS')");
  const second = src.indexOf('secondStepRefusal(req)');
  assert.ok(pre >= 0 && second > pre && second - pre < 120);
  // Staff or device is settled BEFORE any customer is read: a stranger learns nothing.
  assert.ok(src.indexOf('await roleFacts(') < src.indexOf('await readMergeFacts('));
  assert.ok(src.indexOf('callerDeviceFor(user, venue.opsLocationId)') < src.indexOf('await readMergeFacts('));
  assert.match(src, /if \(!staff && !device\)[\s\S]{0,300}status|if \(!staff && !device\)[\s\S]{0,300}403/);
  // The till test (blank shell) is made by decideMergeCaller on the plan's source.
  assert.match(src, /decideMergeCaller\(\{[\s\S]*sourceBlank: first\.source_blank/);
  // Only a person chooses between two phones.
  assert.match(src, /const phoneChoice = decision\.as === 'device' \? null : r\.phoneChoice;/);
  // The venue's organisation is always the OPS row's (Platform locations has no org_id).
  assert.match(src, /opsAdmin\.from\('locations'\)\.select\('org_id'\)\.eq\('id', venue\.opsLocationId\)/);
  // A refused plan never writes, and a failed step says it is safe to ask again.
  assert.ok(src.indexOf('if (!plan.ok)') < src.indexOf('await applyMerge('));
  assert.match(src, /retry_safe: true/);
  // 27 Sep 2026: a resume only hands over what nobody else holds now, so the plan gets the holders;
  // and a till gets back only what its screen shows.
  assert.match(src, /latestConsent: facts\.latestConsent, holders: facts\.holders, now \}/);
  assert.match(src, /survivor: survivorForCaller\(survivor\.customer, decision\.as\),/);
  assert.doesNotMatch(src, /survivor: survivor\.customer/);
});

test('Back Office: the merge button is gated by the same rule, and a clash offers the merge', () => {
  const src = read('../backoffice/sections/Customers.jsx');
  assert.match(src, /from '\.\.\/\.\.\/lib\/customerMerge'/);
  assert.match(src, /body: JSON\.stringify\(mergeRequestBody\(\{ action, targetId, sourceId, phoneChoice, locationId: getActiveLocationSync\(\) \|\| await getLocationId\(\) \}\)\)/);
  assert.match(src, /\$\{FUNCTIONS_URL\}\/\$\{CUSTOMER_MERGE_FN\}/);
  assert.match(src, /setCanMerge\(canStaffMerge\(\{/);
  // 27 Sep 2026: the role read runs beside the customer list, never in front of it.
  const roleAt = src.indexOf('const { data: { user: me } } = await supabase.auth.getUser();');
  const listAt = src.indexOf('const { data: customerRows, error: custErr } = await supabase');
  assert.ok(roleAt > 0 && listAt > roleAt);
  const iifeAt = src.lastIndexOf('(async () => {', roleAt);
  assert.ok(iifeAt > 0 && roleAt - iifeAt < 80, 'inside its own async block');
  assert.doesNotMatch(src.slice(iifeAt - 20, iifeAt), /await\s*$/, 'and not awaited');
  assert.match(src.slice(roleAt, listAt), /\}\)\(\);/);
  assert.match(src, /\{canMerge && \(\s*<button onClick=\{\(\) => setMerge\(\{ other: null \}\)\} style=\{btnSmall\}>Merge with another customer…<\/button>/);
  // The save: a unique index refusal becomes "already on <name>. Merge them?", not an alert.
  const save = src.slice(src.indexOf('const handleSave = async'), src.indexOf('const handleDelete = async'));
  assert.match(save, /const field = uniqueClashOf\(err\);/);
  assert.ok(save.indexOf('uniqueClashOf(err)') < save.indexOf("alert('Save failed: '"));
  assert.match(save, /setClash\(\{ field, holder \}\);\s*return;/);
  assert.match(src, /\{clashText\(clash\.field, clash\.holder\)\}/);
  assert.match(src, /setMerge\(\{ other: clash\.holder \}\)/);
  // After a merge the survivor is selected and the folded in profile leaves the list.
  assert.match(src, /onMerged=\{handleMerged\}/);
  assert.match(src, /setSelectedId\(survivor\.id\);/);
  // Nothing new says it with a dash.
  const added = src.slice(src.indexOf('// ── 26 Sep 2026: merge two profiles of one person'), src.indexOf('// ── v4.6.64: View tabs'));
  assert.ok(added.length > 1000);
  assert.doesNotMatch(added, /[–—]/);
  const callBlock = src.slice(src.indexOf('async function callMerge('), src.indexOf('const fmtMoney'));
  assert.doesNotMatch(callBlock, /[–—]/);
});

test('the new files carry no dash punctuation', () => {
  for (const f of [
    '../../supabase/functions/customer-merge/index.ts',
    '../../supabase/functions/_shared/customerMergePlan.js',
    '../../supabase/functions/_shared/customerMergeRun.js',
    './customerMerge.js',
  ]) assert.doesNotMatch(read(f), /[–—]/, f);
});

test('clash words, the exact email pattern and who holds it', () => {
  assert.equal(clashText('email', { name: 'Ela Stettner' }), 'This email is already on Ela Stettner. Merge them?');
  assert.equal(clashText('phone', { name: '' }), 'This phone number is already on another customer with no name. Merge them?');
  assert.equal(clashText('email', null), 'This email is already on another customer.');
  assert.equal(exactIlike(' ela_s%x@hotmail.com '), 'ela\\_s\\%x@hotmail.com');
  const rows = [
    { id: 'me', email: 'elastettner@hotmail.com' },
    { id: 'x', email: 'elastettnerx@hotmail.com' },
    { id: ELA, email: 'ElaStettner@Hotmail.com', name: 'Ela Stettner' },
  ];
  assert.equal(clashHolder('email', 'elastettner@hotmail.com', rows, 'me').id, ELA);
  assert.equal(clashHolder('email', '', rows), null);
  assert.equal(clashHolder('phone', '+447415748167', [{ id: BLANK, phone: '+447415748167' }]).id, BLANK);
  assert.equal(clashHolder('phone', '07415 748167', [{ id: BLANK, phone: '+447415748167', phone_raw: '07415 748167' }]).id, BLANK);
  // The re-exported rules are the function's own.
  assert.equal(uniqueClashOf({ code: '23505', message: 'duplicate key value violates unique constraint "idx_customers_org_email"' }), 'email');
  assert.equal(canStaffMerge({ linkRole: 'manager' }), true);
});

test('what moves and stamp lines, in words', () => {
  assert.equal(movesText([{ label: 'orders', one: 'order', rows: 3 }, { label: 'consent records', one: 'consent record', rows: 1 }, { label: 'bookings', rows: 0 }, { label: 'receipts', rows: null }]), '3 orders, 1 consent record, some receipts');
  assert.equal(movesText(null), '');
  assert.equal(stampLine({ name: 'Free Drink', stamps_required: 10, stamps_collected: 2, completed_count: 0 }), '2/10 Free Drink');
  assert.equal(stampLine({ name: 'Free Drink', stamps_required: 10, stamps_collected: 3, completed_count: 2 }), '3/10 Free Drink, 2 completed');
  assert.equal(stampLine(null), '');
});
