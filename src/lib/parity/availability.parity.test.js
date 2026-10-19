// availability.parity.test.js: what each channel sells, and that every channel reaches stock (v5.11.78).
// Run: node --test src/lib/parity/availability.parity.test.js
//
// STOCK DEPLETION IS NOT CHANGED HERE. It belongs to the central stock work (v5.11.77,
// feat/central-stock-depletion), which depletes from the booked sale itself: every closed_checks
// row, whoever writes it. So the parity rule for stock is "every channel books a closed check".
// This file proves each channel's writer is there (ezCater's is new in v5.11.78: it booked none).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU } from './fixtures.js';
import { isOptionOnlyItem } from '../menuRules.js';
import { readRepo, between } from './src.js';

test('stock reach: every channel books a closed check, so the central stock depletion sees every sale', () => {
  const store = readRepo('src/store/index.js');
  const writers = [
    ['table service (recordClosedCheck)', between(store, 'recordClosedCheck: (tableId, paymentInfo = {}) => {', 'closeApprovedTerminalJob: async'), /insertClosedCheck\(record\);/],
    ['reader close, Table Pay, pay at table (closeApprovedTerminalJob)', between(store, 'closeApprovedTerminalJob: async (job) => {', '_reverseTerminalJobGift: async ('), /await upsertClosedCheck\(record\);/],
    ['bar tab (recordWalkInClosedCheck)', between(store, 'recordWalkInClosedCheck: (record, paymentInfo = {}) => {', 'recordWalkInClosed: (walkInOrder'), /insertClosedCheck\(fullRecord\)/],
    ['counter, drive thru, MPOS, HubRise balance at the till (recordWalkInClosed)', between(store, 'recordWalkInClosed: (walkInOrder', 'refundCheck: async'), /insertClosedCheck\(record\);/],
    ['HubRise prepaid (bookChannelSale)', between(store, 'bookChannelSale: async (o) => {', '\n  },\n'), /writeClosedCheckRow\(/],
  ];
  for (const [name, src, re] of writers) assert.match(src, re, name);
  assert.match(readRepo('src/surfaces/KioskApp.jsx'), /await writeClosedCheckRow\(supabase, checkRow, \{ tag: 'kiosk'/, 'kiosk');
  assert.match(readRepo('src/surfaces/online/OnlineCheckout.jsx'), /check: closedCheck,/, 'online (place_public_order writes the check)');
  assert.match(readRepo('src/surfaces/qr/QrCheckout.jsx'), /check: closedCheckRow,/, 'QR pay now');
  assert.match(readRepo('src/surfaces/catering/CateringCheckout.jsx'), /check: closedCheck,/, 'catering pay now');
  assert.match(readRepo('src/surfaces/OrdersHub.jsx'), /writeClosedCheckRow\(supabase, tabCheck, \{ tag: 'forceCloseQrTab' \}\)/, 'QR tab force close');
  const settle = readRepo('supabase/migrations/20261019a_OPS_channel_parity.sql');
  assert.match(between(settle, 'CREATE OR REPLACE FUNCTION public.settle_qr_tab(', '$function$;'), /insert into public\.closed_checks/, 'QR tab closed on the phone');
  assert.match(readRepo('supabase/functions/ezcater-webhook/index.ts'), /await sb\.from\('closed_checks'\)\.insert\(plan\.row\);/, 'ezCater (v5.11.78; a revision per change since v5.11.81)');
});

test('catering: an option only sub item is never sold as a product, the till\'s and the server\'s rule', () => {
  const oat = MENU.find((m) => m.id === 'oat');
  assert.equal(isOptionOnlyItem(oat), true);
  const s = readRepo('src/surfaces/catering/CateringSurface.jsx');
  assert.match(between(s, 'const itemsForCat = (catId) => items.filter((i) =>', ');'), /!isOptionOnlyItem\(i\)/);
});

test('catering: an item 86\'d while a guest browses greys out live, as on the online page', () => {
  const s = readRepo('src/surfaces/catering/CateringSurface.jsx');
  assert.match(s, /supabase\.channel\(`catering-86:\$\{opsId\}`\)/);
  assert.match(s, /\{ event: '\*', schema: 'public', table: 'eighty_six', filter: `location_id=eq\.\$\{opsId\}` \}/);
  assert.match(s, /return \(\) => \{ try \{ if \(e86chan\) supabase\.removeChannel\(e86chan\); \} catch/);
});
