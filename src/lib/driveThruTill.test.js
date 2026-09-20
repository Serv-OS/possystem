/**
 * driveThruTill.test.js: the till and MPOS carry drive thru everywhere the other walk in
 * types are listed. Run: `node --test src/lib/driveThruTill.test.js`.
 *
 * Companion to driveThru.test.js (which pins the shared lists). These surfaces have no
 * pure helper to call, so the source is read as text: every branch a venue reaches after
 * ticking drive thru on a device profile must key on the literal 'drive-thru', and a venue
 * that never ticks it must see nothing new (the gates below). Copy decisions (Peter,
 * 16 Sep 2026): label 'Drive thru', upper case 'DRIVE THRU', icon 🚗, name only prompt,
 * heading '🚗 Drive thru order', button 'Confirm drive thru', kitchen label 'Drive thru · Name'.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const has = (text, needle, where) => assert.ok(text.includes(needle), `${where} carries ${needle}`);
const hasRe = (text, re, where) => assert.ok(re.test(text), `${where} matches ${re}`);

function declaration(src, name, file) {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*[\\[{]`).exec(src);
  assert.ok(m, `${file}: ${name} is declared as an array or object`);
  const ends = [src.indexOf('];', m.index), src.indexOf('};', m.index)].filter(i => i >= 0);
  return src.slice(m.index, Math.min(...ends) + 2);
}

// ── Till ─────────────────────────────────────────────────────────────────────

test('POSSurface.jsx: drive thru follows takeaway through the prompt, Send and the modal result', () => {
  const src = read('../surfaces/POSSurface.jsx');
  // Quick service 'none' fast path on the segmented control.
  has(src, "takeawayCustomerDetails === 'none' && (t === 'takeaway' || t === 'collection' || t === 'drive-thru')", 'handleTypeChange');
  // Send never falls into OrderTypeModal for a drive thru order.
  has(src, "orderType === 'delivery' || orderType === 'drive-thru')", 'preSelected');
  has(src, "takeawayCustomerDetails === 'none' && (orderType === 'takeaway' || orderType === 'collection' || orderType === 'drive-thru')", 'skipDetails');
  // The modal result reaches setOrderType + sendToKitchen like takeaway and collection.
  has(src, "result.type === 'takeaway' || result.type === 'collection' || result.type === 'drive-thru'", 'OrderTypeModal onComplete');
  // Segment icon and on screen label.
  has(src, "t==='drive-thru'?'drivethru'", 'iconName');
  hasRe(declaration(src, 'ORDER_TYPE_LABEL', 'POSSurface.jsx'), /'drive-thru':\s*'Drive thru'/, 'ORDER_TYPE_LABEL');
  has(src, ':orderTypeLabel} · {staff?.name}', 'order header');
  // The default allowed list stays without drive thru: OFF unless the profile ticks it.
  has(src, "deviceConfig?.enabledOrderTypes || ['dine-in', 'takeaway', 'collection']", 'allowedOrderTypes default');
});

test('ServOSIcons.jsx: a drivethru glyph exists for the segmented control', () => {
  hasRe(declaration(read('../components/ServOSIcons.jsx'), 'PATHS', 'ServOSIcons.jsx'), /\n\s+drivethru:\s*'<path/, 'PATHS');
});

test('OrderTypeModal.jsx: drive thru entry, quick service fast path, name only step, profile gate', () => {
  const src = read('../components/OrderTypeModal.jsx');
  const types = declaration(src, 'TYPES', 'OrderTypeModal.jsx');
  hasRe(types, /id:\s*'drive-thru',\s*label:\s*'Drive thru',\s*icon:\s*'🚗'/, 'TYPES');
  has(src, "(type.id === 'takeaway' || type.id === 'collection' || type.id === 'drive-thru') && takeawayMode === 'none'", 'handleTypeSelect');
  has(src, "onComplete({ type: 'drive-thru', name: form.name.trim(), phone: '', time: '', isASAP: true, orderType: 'drive-thru', channel: 'drive-thru' })", 'confirmDriveThru');
  has(src, "selectedType?.id === 'drive-thru'", 'details step');
  has(src, 'Confirm drive thru', 'button copy');
  // Only the drive thru entry is gated by the device profile; the older six stay as they were.
  has(src, "TYPES.filter(t => t.id !== 'drive-thru' || enabledOrderTypes.includes('drive-thru'))", 'visibleTypes');
  has(src, '{visibleTypes.map(type => (', 'type picker renders the gated list');
});

test('CustomerModal.jsx: name only, heading, subtitle and button', () => {
  const src = read('../components/CustomerModal.jsx');
  has(src, "const isDriveThru = orderType === 'drive-thru';", 'isDriveThru');
  has(src, 'const nameOnly = isDriveThru || (', 'nameOnly');
  has(src, "isDriveThru ? '🚗 Drive thru order'", 'heading');
  has(src, "isDriveThru ? 'Confirm drive thru →'", 'button');
  // No slot grid and no address for drive thru: those stay keyed on collection and delivery.
  has(src, '{isCollection && (', 'slot grid gate');
  has(src, '{isDelivery && (<>', 'address gate');
});

test('CheckoutModal.jsx: drive thru skips the tip prompt and the context label reads Drive thru', () => {
  const src = read('../surfaces/CheckoutModal.jsx');
  has(src, "const skipTip  = isBarTab || orderType==='takeaway' || orderType==='collection' || orderType==='drive-thru';", 'skipTip');
  has(src, "const orderTypeLabel = orderType === 'drive-thru' ? 'Drive thru' : orderType;", 'contextLabel map');
});

test('ReceiptModal.jsx and CollectionQueue.jsx: on screen labels', () => {
  const r = read('../components/ReceiptModal.jsx');
  has(r, "const orderTypeLabel = orderType === 'drive-thru' ? 'Drive thru' : orderType;", 'ReceiptModal label');
  has(r, '{tableLabel || orderTypeLabel}', 'ReceiptModal preview header');
  const q = read('../components/CollectionQueue.jsx');
  has(q, "order.type === 'drive-thru' ? '🚗'", 'CollectionQueue icon');
  has(q, "order.type === 'drive-thru' ? 'Drive thru'", 'CollectionQueue label');
});

test('OrdersHub.jsx: the Drive thru tab has its own colour and shows only where drive thru is on', () => {
  const src = read('../surfaces/OrdersHub.jsx');
  const tabs = declaration(src, 'FILTER_TABS', 'OrdersHub.jsx');
  hasRe(tabs, /id:'drive-thru',\s*label:'Drive thru',\s*icon:'🚗',\s*color:'#ec4899'/, 'FILTER_TABS');
  const colours = declaration(src, 'SECTION_COLORS', 'OrdersHub.jsx');
  const hexes = [...colours.matchAll(/'#([0-9a-f]{6})'/gi)].map(m => m[1].toLowerCase());
  assert.equal(hexes.length, 7, 'seven section colours');
  assert.equal(new Set(hexes).size, hexes.length, 'every section colour is distinct');
  has(src, "const visibleTabs = driveThruOn ? FILTER_TABS : FILTER_TABS.filter(t => t.id !== 'drive-thru');", 'tab gate');
  has(src, '{visibleTabs.map(tab => {', 'tab strip renders the gated list');
});

// ── MPOS ─────────────────────────────────────────────────────────────────────

test('MPOS: picker entry, capture gate, name only capture, cart label, orders filter', () => {
  hasRe(declaration(read('../surfaces/mpos/MNewOrder.jsx'), 'TYPES', 'MNewOrder.jsx'), /id:'drive-thru',\s*label:'Drive thru',\s*icon:'🚗'/, 'MNewOrder TYPES');
  const s = read('../surfaces/MPOSSurface.jsx');
  has(s, "type === 'takeaway' || type === 'drive-thru') {", 'customerCapture gate');
  has(s, "orderType === 'drive-thru' ? 'DRIVE THRU'", 'menu header');
  const c = read('../surfaces/mpos/MCustomerCapture.jsx');
  has(c, 'const needsCustomer = isTakeaway || isCollection || isDelivery || isDriveThru;', 'needsCustomer');
  has(c, "if (!isDriveThru && !phone.trim()) e.phone = 'Phone required';", 'phone not required');
  has(c, "{isDriveThru ? 'DRIVE THRU' : (orderType || '').toUpperCase()} order", 'header');
  hasRe(declaration(read('../surfaces/mpos/MCartSheet.jsx'), 'labelMap', 'MCartSheet.jsx'), /'drive-thru':'Drive thru'/, 'labelMap');
  const o = read('../surfaces/mpos/MOrdersList.jsx');
  hasRe(declaration(o, 'FILTERS', 'MOrdersList.jsx'), /id:'drive-thru',\s*label:'Drive thru'/, 'FILTERS');
  has(o, "FILTERS.filter(f => f.id !== 'drive-thru')", 'filter chip gate');
});

// ── Store label maps ─────────────────────────────────────────────────────────

test('store/index.js: kitchen label, receipt header words and the channel ticket customer block', () => {
  const src = read('../store/index.js');
  has(src, "const walkInTypeLabel = (t) => t === 'drive-thru' ? 'Drive thru' : `${t.charAt(0).toUpperCase()}${t.slice(1)}`;", 'walkInTypeLabel');
  const uses = src.match(/\$\{walkInTypeLabel\(orderType\)\} · \$\{customer\.name\}/g) || [];
  assert.equal(uses.length, 2, 'both sendToKitchen labels (scheduled and live) use walkInTypeLabel');
  assert.ok(!src.includes('orderType.charAt(0).toUpperCase()+orderType.slice(1)'), 'no inline capitalised label remains');
  const headers = src.match(/=== 'drive-thru' \? 'Drive thru' : 'Order'/g) || [];
  assert.equal(headers.length, 2, 'both receipt header maps (HubRise print and reprint) name Drive thru');
  has(src, "_svcType === 'drive-thru' || order.source === 'hubrise'", '_isDeliveryish');
});

// ── The gates that keep other venues unchanged ───────────────────────────────

test('seed and fallback profiles never enable drive thru on their own', () => {
  for (const [rel, name] of [['../App.jsx', 'App.jsx'], ['../surfaces/PairingScreen.jsx', 'PairingScreen.jsx'], ['../store/index.js', 'store/index.js'], ['../surfaces/mpos/MNewOrder.jsx', 'MNewOrder.jsx']]) {
    const src = read(rel);
    const lists = [...src.matchAll(/enabledOrderTypes\s*(?:\|\||:|=)\s*\[([^\]]*)\]/g)].map(m => m[1]);
    assert.ok(lists.length, `${name} has at least one enabledOrderTypes default`);
    for (const l of lists) assert.ok(!l.includes('drive-thru'), `${name} default ${l} does not switch drive thru on`);
  }
});
