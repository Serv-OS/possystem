/**
 * onlineHeader.pins.test.js: source pins for the online ordering header (5.12.34).
 *
 * The page owns the timing choice and OnlineCheckout reads it through props; the slot rule and
 * the Day / Time pick have one home each; the header block is online only; the search reads the
 * section rows in the menu language; the sibling venues are read with the customer's own clients.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
const checkout = read('src/surfaces/online/OnlineCheckout.jsx');
const surface = read('src/surfaces/online/OnlineSurface.jsx');
const block = read('src/surfaces/online/OnlineHeaderBlock.jsx');

test('OnlineCheckout reads the page timing through props and settles it with the shared rule', () => {
  assert.match(checkout, /timing: timingProp = null, onTimingChange = null, delivery: deliveryProp = null, onDeliveryChange = null/);
  assert.match(checkout, /const timing = timingProp \|\| ownTiming;/);
  assert.match(checkout, /settleTiming\(timing, slots, \{ orderAheadOnly \}\)/);
  assert.match(checkout, /const baseLeadMin = leadMinutesFor\(location\)/);
  assert.match(checkout, /const advanceDays = advanceDaysFor\(location\)/);
  assert.doesNotMatch(checkout, /useState\(orderAheadOnly \? 'scheduled' : 'asap'\)/, 'no second copy of the timing state');
});

test('the slot rule and the Day / Time pick have one home each', () => {
  assert.match(checkout, /import \{ buildCollectionSlots \} from '\.\.\/\.\.\/lib\/online\/collectionSlots'/);
  assert.match(checkout, /import SlotPicker from '\.\/SlotPicker'/);
  assert.doesNotMatch(checkout, /function buildCollectionSlots/);
  assert.doesNotMatch(checkout, /function SlotPicker/);
  assert.doesNotMatch(checkout, /function nextIsoDate/);
  assert.match(surface, /import \{ buildCollectionSlots \} from '\.\.\/\.\.\/lib\/online\/collectionSlots'/);
  assert.match(block, /import SlotPicker from '\.\/SlotPicker'/);
});

test('the page hands its timing and the delivery address seam to the checkout', () => {
  assert.match(surface, /timing=\{timing\} onTimingChange=\{setTiming\}/);
  assert.match(surface, /delivery=\{delivery\} onDeliveryChange=\{setDelivery\}/);   // 5.12.35: the address object, not a line of text
  assert.match(surface, /initialTiming\(\{ orderAheadOnly: !!closedInfo \}\)/);
  assert.match(surface, /settleTiming\(timing, slots, \{ orderAheadOnly \}\)/);
});

test('the header block is online only; QR keeps its table pill and the prep pill left the online hero', () => {
  assert.match(surface, /\{!isQr && \(\s*<OnlineHeaderBlock/);
  assert.match(surface, /\[\{ label: `Table \$\{effectiveTableLabel\}` \}\]\.concat\(prepBanner/);
  assert.match(surface, /: \[\{ label: 'Open now', dot: true, green: true \}\]\)/);
  assert.equal((surface.match(/\.concat\(prepBanner/g) || []).length, 1, 'only the QR pill row carries the wait pill');
  assert.doesNotMatch(surface, /if \(!isCounter\) setOrderType\(null\)/, 'the pill no longer sends the customer back to the welcome screen');
  assert.match(surface, /sheet === 'type' && !isQr/);
  assert.match(surface, /sheet === 'timing' && !isQr/);
  assert.match(surface, /sheet === 'location' && !isQr/);
});

test('search reads the section rows in the menu language', () => {
  assert.match(surface, /searchMenuRows\(rows, query, \{ name: tItemName, description: tItemDescription, section:/);
  assert.match(surface, /topCategories\.flatMap\(c => itemsForCat\(c\.id\)/);
});

test('sibling venues come through the customer clients the page already holds, never a service key', () => {
  assert.match(surface, /loadSiblingVenues\(\{ platformSupabase, supabase, companyId: location\.company_id, currentId: location\.id \}\)/);
  for (const f of ['src/lib/online/siblingVenues.js', 'src/surfaces/online/OnlineHeaderBlock.jsx', 'src/surfaces/online/OnlineSurface.jsx']) {
    assert.doesNotMatch(read(f), /service_role|SERVICE_ROLE/i, f);
  }
  assert.match(surface, /siblingVenueUrl\(v\?\.online_slug, .*customerUrl\)/);
});

test('no em or en dashes in the new files', () => {
  for (const f of ['src/lib/online/collectionSlots.js', 'src/lib/online/orderTiming.js', 'src/lib/online/siblingVenues.js', 'src/lib/online/menuSearch.js',
    'src/surfaces/online/OnlineHeaderBlock.jsx', 'src/surfaces/online/SlotPicker.jsx', 'src/surfaces/online/useNarrowOnline.js']) {
    assert.doesNotMatch(read(f), /[–—]/, f);
  }
});
