// src/lib/orgWipeRules.test.js: delete an organisation and wipe all its data, the shared rules
// (5 Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nameMatches, isUuid, isMissingWipeFunction, storagePrefixes, STORAGE_BUCKETS, wipeSummary, wipeDoneLine,
  ORG_WIPE_TITLE, NEEDS_UPDATE_LINE,
} from './orgWipeRules.js';

test('the typed name must be the name: trimmed, any case, inner spaces squeezed, never empty', () => {
  assert.equal(nameMatches('Alpha Cafe', 'Alpha Cafe'), true);
  assert.equal(nameMatches('  alpha   cafe ', 'Alpha Cafe'), true);
  assert.equal(nameMatches('Alpha Cafe Ltd', 'Alpha Cafe'), false);
  assert.equal(nameMatches('Alpha', 'Alpha Cafe'), false);
  assert.equal(nameMatches('', ''), false, 'an organisation with no name cannot be confirmed by typing nothing');
  assert.equal(nameMatches(null, 'Alpha Cafe'), false);
});

test('ids and missing functions', () => {
  assert.equal(isUuid('aaaaaaaa-0000-0000-0000-00000000000a'), true);
  assert.equal(isUuid('aaaaaaaa-0000-0000-0000-00000000000a; drop table x'), false);
  assert.equal(isMissingWipeFunction({ code: 'PGRST202', message: 'Could not find the function public.admin_wipe_organisation' }), true);
  assert.equal(isMissingWipeFunction({ code: '42883', message: 'function admin_wipe_locations(uuid[], boolean) does not exist' }), true);
  assert.equal(isMissingWipeFunction({ message: 'Wipe stopped: pinned still refused by a foreign key' }), false);
  assert.equal(isMissingWipeFunction(null), false);
});

test('storage: the two prefixes a venue uses, in every known bucket', () => {
  assert.deepEqual(storagePrefixes('11111111-0000-0000-0000-000000000001'), ['locations/11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001']);
  assert.deepEqual(storagePrefixes(''), []);
  for (const b of ['ops-files', 'wf-documents', 'invoice-scans', 'kiosk-assets', 'receipt-assets', 'web-assets', 'chat-photos', 'stock-invoice-inbox', 'report-exports']) {
    assert.ok(STORAGE_BUCKETS.includes(b), b);
  }
});

test('the summary adds the Ops blocks and the Platform blocks and names what people recognise', () => {
  const report = {
    locations: 2, logins: 3,
    ops: {
      venues: { tables: { closed_checks: 120, kds_tickets: 80, menu_items: 40, locations: 2 } },
      people: { tables: { user_profiles: 3 } },
      company: { tables: { customers: 15, organisations: 1 } },
    },
    platform: { locations_report: { tables: { adyen_payments: 50 } }, company_report: { tables: { gift_cards: 4, companies: 1 } } },
    storage: { files: 7 },
  };
  const s = wipeSummary(report);
  assert.equal(s.total, 316);
  assert.equal(s.lines[0], '2 locations');
  assert.equal(s.lines[1], '316 rows across 10 tables');
  assert.ok(s.lines.includes('120 closed checks'));
  assert.ok(s.lines.includes('80 kitchen tickets'));
  assert.ok(s.lines.includes('15 customers'));
  assert.ok(s.lines.includes('50 card payments'));
  assert.ok(s.lines.includes('4 gift cards'));
  assert.ok(s.lines.includes('3 Back Office logins removed'));
  assert.ok(s.lines.includes('7 stored files'));
  // a location preview: one flat Ops block, a flat Platform block
  const one = wipeSummary({ locations: 1, ops: { tables: { closed_checks: 1 } }, platform: { configured: true, tables: { adyen_payments: 2 } } });
  assert.equal(one.total, 3);
  assert.equal(one.lines[0], '1 location');
  assert.ok(one.lines.includes('1 closed check'));
  assert.equal(wipeSummary(null).total, 0);
});

test('the done line', () => {
  const line = wipeDoneLine('org', 'Alpha Cafe', { logins: 2, ops: { venues: { tables: { closed_checks: 3 } } }, storage: { files: 1, errors: [] } });
  assert.equal(line, '"Alpha Cafe" organisation deleted: 3 rows, 2 logins removed, 1 file.');
  const left = wipeDoneLine('location', 'Beta One', { ops: { tables: { menus: 1 } }, storage: { files: 0, errors: ['ops-files: timeout (3 files)'] } });
  assert.ok(left.startsWith('"Beta One" location deleted: 1 row.'));
  assert.ok(left.includes('could not be removed'));
});

test('the words', () => {
  assert.equal(ORG_WIPE_TITLE, 'Delete organisation: all locations and wipe all data');
  assert.ok(NEEDS_UPDATE_LINE.includes('20261125a') && NEEDS_UPDATE_LINE.includes('20261125b') && NEEDS_UPDATE_LINE.includes('org-admin'));
  assert.ok(!/[–—]/.test(ORG_WIPE_TITLE + NEEDS_UPDATE_LINE), 'no dashes');
});
