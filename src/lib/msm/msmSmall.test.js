// Multi site menu: the small pure pieces. Access (msmAccess.js), messages (msmNotify.js), sites
// (msmSites.js), the model's vocabulary (msmModel.js) and the paged readers (msmRead.js) against a
// stand in that enforces the 1,000 row cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFromRpc, callerAccess, isNotInstalled } from '../../../supabase/functions/_shared/msmAccess.js';
import { messageFor, recipients } from '../../../supabase/functions/_shared/msmNotify.js';
import { planAddSite, groupHints } from '../../../supabase/functions/_shared/msmSites.js';
import { checkChange, newItemId, newCategoryId, newMenuId, familyOf, normName, toPence, samePrice, sameValue, money2 } from '../../../supabase/functions/_shared/msmModel.js';
import { readCentral, readChanges } from '../../../supabase/functions/_shared/msmRead.js';
import { fakeClient } from './fakeClient.js';

test('access: only named people, while the company is on; not installed and any failure hide it', () => {
  const on = accessFromRpc({ data: { companies: [{ org_id: 'o1', org_name: 'Co', enabled: true, role: 'editor' }] } }, 'o1');
  assert.deepEqual([on.canOpen, on.canEdit, on.role, on.orgId], [true, true, 'editor', 'o1']);
  const viewer = accessFromRpc({ data: { companies: [{ org_id: 'o1', enabled: true, role: 'viewer' }] } });
  assert.deepEqual([viewer.canOpen, viewer.canEdit], [true, false]);
  assert.equal(accessFromRpc({ data: { companies: [{ org_id: 'o1', enabled: false, role: 'editor' }] } }).reason, 'switched_off');
  assert.equal(accessFromRpc({ data: { companies: [] } }).canOpen, false, 'an owner who is not named sees nothing');
  const missing = accessFromRpc({ error: { code: 'PGRST202', message: 'Could not find the function public.msm_my_access' } });
  assert.deepEqual([missing.installed, missing.canOpen], [false, false]);
  const broken = accessFromRpc({ error: { code: '500', message: 'timeout' } });
  assert.deepEqual([broken.installed, broken.canOpen, broken.reason], [true, false, 'read_failed'], 'fail closed');
  const two = accessFromRpc({ data: { companies: [{ org_id: 'a', enabled: true, role: 'viewer' }, { org_id: 'b', enabled: true, role: 'editor' }] } }, 'b');
  assert.equal(two.orgId, 'b', 'the company the person works in is picked');
  assert.equal(isNotInstalled({ code: '42P01' }), true);
});

test('who may call the publish runner: service role, the cron key the database confirms, or a signed in person', () => {
  assert.equal(callerAccess({ service: true }).by, 'service_role');
  assert.equal(callerAccess({ key: 'k', keyCheck: { data: true } }).by, 'cron_key');
  assert.equal(callerAccess({ key: 'k', keyCheck: { data: false } }).ok, false);
  assert.equal(callerAccess({ key: 'k', keyCheck: { error: { code: 'PGRST202' } } }).ok, false, 'no "before the migration" opening: fail closed');
  assert.equal(callerAccess({ user: { id: 'u' } }).by, 'user');
  assert.equal(callerAccess({ user: { id: null, error: {} } }).ok, false);
  assert.equal(callerAccess({}).reason, 'not_signed_in');
});

test('messages: the scheduler and every editor hear about a failure, in words', () => {
  const m = messageFor('will_fail', { title: 'Monday price rise', siteName: 'Site B', words: 'Site B will not get "Monday price rise": no 20% VAT rate.', when: 'Mon 20 Oct 05:55' });
  assert.equal(m.subject, 'Site B will not get "Monday price rise"');
  assert.match(m.text, /Fix it before then, or open the Multi site menu and press Retry for Site B afterwards/);
  assert.match(messageFor('late', { siteName: 'Site B', when: '06:00' }).text, /not being deployed/);
  assert.match(messageFor('done_with_failures', { doneCount: 5, siteCount: 6, failedSites: ['Site B'] }).subject, /done at 5 of 6 sites/);
  assert.doesNotMatch(messageFor('failed', { siteName: '<b>x</b>' }).html, /<b>x<\/b>/, 'escaped');
  const to = recipients([
    { user_id: 'a', email: 'A@example.test', role: 'editor' },
    { user_id: 'b', email: 'b@example.test', role: 'viewer' },
    { user_id: 'c', email: 'c@example.test', role: 'viewer' },
    { user_id: 'd', email: 'not an email', role: 'editor' },
    { user_id: 'e', email: 'a@example.test', role: 'editor' },
  ], 'c');
  assert.deepEqual(to, ['a@example.test', 'c@example.test'], 'editors and the scheduler, each address once');
});

test('add a site: every product on sale, another site\'s own extras left out; copy prices only where they differ', () => {
  const central = {
    menu: { id: 'm1' }, sites: [{ location_id: 's1' }],
    products: [
      { id: 'p1', name: 'Latte', default_price: 3, family_base: 'm-latte' },
      { id: 'p2', name: 'Pie', default_price: 4, site_only_location_id: 's1' },
      { id: 'p3', name: 'Gone', default_price: 1, archived: true },
      { id: 'p4', name: 'Cola', default_price: 2 },
    ],
    productSites: [{ product_id: 'p1', location_id: 's1', price: 3.2, active: true }, { product_id: 'p4', location_id: 's1', price: 2, active: true }],
  };
  const a = planAddSite(central, { locationId: 'new-site-0000abcd' });
  assert.deepEqual(a.changes.map((c) => c.target), ['menu_site', 'product_site', 'product_site']);
  assert.equal(a.changes[1].after.venue_item_id, 'm-latte_0000abcd');
  assert.equal(a.changes[1].after.price, null);
  const copy = planAddSite(central, { locationId: 'new-site-0000abcd', prices: 'copy', copyFrom: 's1' });
  assert.equal(copy.changes.find((c) => c.entity_id === 'p1').after.price, 3.2);
  assert.equal(copy.changes.find((c) => c.entity_id === 'p4').after.price, null, 'equal to the default: follows it');
  assert.match(planAddSite(central, { locationId: 's1' }).words, /already in the group menu/);
});

test('site group hints: sites that share many prices', () => {
  const productSites = [];
  for (let i = 0; i < 25; i++) {
    productSites.push({ product_id: `p${i}`, location_id: 'siteb', price: 3 + i / 100 });
    productSites.push({ product_id: `p${i}`, location_id: 'sitec', price: 3 + i / 100 });
    productSites.push({ product_id: `p${i}`, location_id: 'other', price: 9 });
  }
  assert.deepEqual(groupHints({ productSites }), [{ a: 'siteb', b: 'sitec', shared: 25 }]);
});

test('the vocabulary: ids, families, names, money', () => {
  assert.equal(newItemId({ id: '12345678-9abc-4def-8000-000000000000' }, 'x-aaaa1111'), 'msm-123456789abc_aaaa1111');
  assert.equal(newItemId({ id: 'u', family_base: 'm-latte' }, 'loc-0000bbbb'), 'm-latte_0000bbbb');
  assert.equal(newCategoryId('12345678-9abc-4def-8000-000000000000', 'loc-0000bbbb'), 'msmc-123456789abc_0000bbbb');
  assert.equal(newMenuId('12345678-9abc-4def-8000-000000000000', 'loc-0000bbbb'), 'menu-msm-123456789abc_0000bbbb');
  assert.equal(familyOf({ id: 'm-1_5c26956b' }), 'm-1');
  assert.equal(familyOf({ id: 'x', master_id: 'm-9' }), 'm-9');
  assert.equal(familyOf({ id: 'plain' }), 'plain');
  assert.equal(normName('  Fish & Chips!! '), 'fish and chips');
  assert.equal(toPence('2.85'), 285);
  assert.equal(toPence(0.1 + 0.2), 30);
  assert.equal(samePrice(2.8, '2.80'), true);
  assert.equal(sameValue({ a: [1, { b: null }] }, { a: [1, {}] }), true);
  assert.equal(money2(-1.5), '-1.50');
  assert.equal(checkChange({ target: 'product', op: 'update', entity_id: 'p', after: { name: 'x' } }).ok, true);
  assert.equal(checkChange({ target: 'product', op: 'update', entity_id: 'p', location_id: 's', after: {} }).ok, false);
  assert.equal(checkChange({ target: 'product_site', op: 'create', entity_id: 'p', location_id: 's', after: {} }).ok, false);
  assert.equal(checkChange({ target: 'menu_site', op: 'remove', entity_id: 'm', location_id: 's', after: {} }).ok, false);
});

test('the readers page past the 1,000 row cap and a failed page is a failed read', async () => {
  const productSites = [];
  const products = [];
  for (let i = 0; i < 1500; i++) {
    products.push({ id: `p${String(i).padStart(4, '0')}`, menu_id: 'm1', sort_order: 0 });
    productSites.push({ product_id: `p${String(i).padStart(4, '0')}`, location_id: 's1' });
    productSites.push({ product_id: `p${String(i).padStart(4, '0')}`, location_id: 's2' });
  }
  products.push({ id: 'other', menu_id: 'm2', sort_order: 0 });
  productSites.push({ product_id: 'other', location_id: 's1' });
  const client = fakeClient({ msm_menus: [{ id: 'm1' }], msm_menu_sites: [], msm_categories: [], msm_category_sites: [], msm_modifier_groups: [], msm_modifier_group_sites: [], msm_products: products, msm_product_sites: productSites, msm_site_groups: [] });
  const c = await readCentral(client, 'm1');
  assert.equal(c.ok, true);
  assert.equal(c.products.length, 1500);
  assert.equal(c.productSites.length, 3000, 'all 3,000 rows, not the first 1,000');
  assert.equal(c.productSites[0].msm_products, undefined, 'the join column is stripped');
  const broken = await readCentral(fakeClient({}, { fail: { msm_products: 'boom' } }), 'm1');
  assert.equal(broken.ok, false);
  assert.equal(broken.products, null, 'never "no rows"');
  const ch = await readChanges(fakeClient({ msm_changes: [{ id: 'a', change_set_id: 's', created_at: '1' }] }), 's');
  assert.equal(ch.rows.length, 1);
});
