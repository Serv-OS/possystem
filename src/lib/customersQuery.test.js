// customersQuery.test.js: the Customers page at 8,000 customers (v5.9.78).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { customerSearchOr, mergeCustomerRows, enrichCustomer, CUSTOMER_PAGE_SIZE, customerListCaption, idChunks } from './customersQuery.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('a search term becomes one PostgREST or filter over name, email and phone', () => {
  assert.equal(customerSearchOr('smi'), 'name.ilike."%smi%",email.ilike."%smi%",phone.ilike."%smi%"');
  assert.equal(customerSearchOr('0777 123'), 'name.ilike."%0777 123%",email.ilike."%0777 123%",phone.ilike."%0777 123%",phone.ilike."%0777123%",phone_raw.ilike."%0777123%"', 'digits also match the stored phone without spaces');
  assert.equal(customerSearchOr('a'), null, 'one character is not a search');
  assert.equal(customerSearchOr('  '), null);
  assert.equal(customerSearchOr('o"neil, (jr)'), 'name.ilike."%o\'neil, (jr)%",email.ilike."%o\'neil, (jr)%",phone.ilike."%o\'neil, (jr)%"'.replace(/o'neil/g, 'oneil'), 'quotes are dropped, commas and brackets are safe inside the quoted value');
});

test('server finds join the loaded list without duplicates and never replace an enriched row', () => {
  const loaded = [{ id: 'a', name: 'Ann', totalSpend: 10 }];
  const out = mergeCustomerRows(loaded, [{ id: 'a', name: 'Ann (server)' }, { id: 'b', name: 'Bob' }]);
  assert.deepEqual(out.map((c) => c.id), ['a', 'b']);
  assert.equal(out[0].totalSpend, 10);
  assert.equal(mergeCustomerRows(loaded, []), loaded, 'nothing new: the same array');
  assert.deepEqual(mergeCustomerRows(null, [{ id: 'x' }]).map((c) => c.id), ['x']);
});

test('per venue stats roll up as before', () => {
  const c = enrichCustomer({ id: 'a' }, [{ lifetime_revenue: '12.5', visit_count: 2, last_visit_at: '2026-09-01' }, { lifetime_revenue: 3, visit_count: 0, last_visit_at: '2026-09-20' }]);
  assert.equal(c.totalSpend, 15.5); assert.equal(c.totalVisits, 2); assert.equal(c.lastVisit, '2026-09-20'); assert.equal(c.siteCount, 1);
  assert.deepEqual(enrichCustomer({ id: 'b' }).stats, []);
});

test('the caption says the list is a page once it is full', () => {
  assert.equal(CUSTOMER_PAGE_SIZE, 1000);
  assert.equal(customerListCaption(12, false), '');
  assert.equal(customerListCaption(1000, false), 'Showing the first 1,000 customers. Search finds the rest.');
  assert.equal(customerListCaption(1000, true), 'Searching every customer…');
});

test('pins: the page reads in key order, stats by venue, searches the database, and never calls a failed read "no customers"', () => {
  const src = read('../backoffice/sections/Customers.jsx');
  assert.match(src, /\.order\('updated_at', \{ ascending: false \}\)\n\s+\.limit\(CUSTOMER_PAGE_SIZE\);/, 'v5.9.80: newest first (the set form rule and index made it 16 ms)');
  assert.doesNotMatch(src, /\.in\('customer_id', ids\)/, 'no 1,000 id lists in the URL');
  assert.match(src, /\.in\('location_id', locIds\)/, 'stats by venue');
  assert.doesNotMatch(src, /\.from\('customer_loyalty'\)[^;]*\.eq\('company_id', platLoc\.company_id\);/, 'v5.9.80: never the whole company in one read (1,000 row cap)');
  assert.match(src, /const chunks = idChunks\(custIds\);/);
  assert.match(src, /\.eq\('company_id', companyId\)\.in\('customer_id', slice\)\)\);\n\s+const loyaltyRows/, 'loyalty for the customers on screen, slice by slice');
  assert.match(src, /\.eq\('company_id', companyId\)\.in\('customer_id', slice\)\)\);\n\s+const cards/, 'stamp cards the same way');
  assert.match(src, /loadLoyaltyFor\(companyId, fresh\.map\(\(c\) => c\.id\), hasStampPrograms\)/, 'search finds get their points and stamps too');
  assert.match(src, /const orFilter = customerSearchOr\(search\);/);
  assert.match(src, /\.or\(orFilter\)\n\s+\.limit\(100\);/);
  assert.match(src, /if \(custErr\) \{ setLoadError\(/, 'a failed read is reported');
  assert.match(src, /The customer list could not be read/);
  assert.match(src, /if \(seq !== searchSeq\.current\) return;/, 'a late answer for an old term is dropped');
  const mig = read('../../supabase/migrations/20260926b_OPS_customers_visible_orgs.sql');
  assert.match(mig, /using \(org_id in \(select public\.visible_customer_orgs\(\)\)\)/, 'the policy is in set form (once per statement)');
  assert.match(mig, /create index if not exists customers_org_updated_idx on public\.customers \(org_id, updated_at desc\)/);
});

test('ids are read in URL sized slices, deduped, never empty slices', () => {
  // v5.9.80: Coffee Boy has 8,028 loyalty records; a read by company stopped at the 1,000 row cap.
  const ids = Array.from({ length: 401 }, (_, i) => `id-${i}`);
  const ch = idChunks(ids);
  assert.deepEqual(ch.map((c) => c.length), [150, 150, 101]);
  assert.deepEqual(idChunks(['a', 'a', null, 'b'], 1), [['a'], ['b']]);
  assert.deepEqual(idChunks([]), []);
  assert.deepEqual(idChunks(undefined), []);
});
