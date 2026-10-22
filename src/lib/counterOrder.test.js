import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTER_DEFAULT_LABEL, COUNTER_TYPE, counterLabel, counterLabelToSave, counterCollect, counterCollectPatch, kioskCounterCollect, orderTypeChip, tipModuleFor,
} from './counterOrder.js';
import { isCounterCollectOrder, counterReadyText, kioskTileOn } from '../../supabase/functions/_shared/counterCollect.js';
import { parseCustomerLocation } from './customerHost.js';
import { kioskTextAllowed, kioskSubmitArgs } from './kioskCheckout.js';
import { kioskModeLabels, kioskDoneModel } from './kioskFlow.js';

test('the Counter collect QR is off for a venue that never saved it, and named "Counter collect"', () => {
  for (const row of [null, {}, { online_branding: null }, { online_branding: {} }, { online_branding: { collection: 'x' } }]) {
    assert.deepEqual(counterCollect(row), { qr: false, label: COUNTER_DEFAULT_LABEL });
  }
  assert.equal(COUNTER_DEFAULT_LABEL, 'Counter collect');
});

test('the QR switch reads only true, and the words are tidied', () => {
  const row = { online_branding: { collection: { kiosk: true, qr: 'yes', label: '  Collect   at counter ' } } };
  assert.deepEqual(counterCollect(row), { qr: false, label: 'Collect at counter' });
  assert.deepEqual(counterCollect({ collection: { qr: true } }), { qr: true, label: 'Counter collect' });
  assert.equal(counterLabel('x'.repeat(60)).length, 40);
  assert.equal(counterLabel('   '), 'Counter collect');
});

test('the kiosk tile comes from that kiosk\'s own settings, off before the database update', () => {
  assert.deepEqual(kioskCounterCollect({}), { on: false, label: 'Counter collect' });
  assert.deepEqual(kioskCounterCollect(null), { on: false, label: 'Counter collect' });
  assert.deepEqual(kioskCounterCollect({ kiosk_counter_collect: true, kiosk_label_counter_collect: 'Collect at counter' }),
    { on: true, label: 'Collect at counter' });
  assert.equal(kioskCounterCollect({ kiosk_counter_collect: 'true' }).on, false);
  assert.equal(counterLabelToSave('  Grab   it here '), 'Grab it here');
  assert.equal(counterLabelToSave('   '), null);
});

test('Online ordering\'s Save sends exactly the QR keys, blank words as null', () => {
  assert.deepEqual(counterCollectPatch({ qr: true, label: ' Collect at counter ' }), { collection: { qr: true, label: 'Collect at counter' } });
  assert.deepEqual(counterCollectPatch({ qr: 1, label: '' }), { collection: { qr: false, label: null } });
});

test('Counter collect books as dine in with no table on every channel (Peter: dine in for all tax reasons)', () => {
  assert.equal(COUNTER_TYPE, 'dine-in');
  // The kiosk tile sets orderType 'dineIn' with no table: the ready text may be asked for, and
  // submitOrder (card path guard) already writes 'dine-in' for it.
  assert.equal(kioskTextAllowed({ orderType: 'dineIn', tableNumber: '' }), true);
  assert.deepEqual(kioskSubmitArgs({ smsEnabled: true, orderType: 'dineIn', tableNumber: '', smsOn: true, phoneE164: '+447700900123' }), ['', '+447700900123']);
  assert.equal(kioskTextAllowed({ orderType: 'dineIn', tableNumber: '4' }), false);
});

test('the done screen tells a Counter collect customer to collect, an eat in customer to find a seat', () => {
  assert.equal(kioskDoneModel({ orderType: 'dineIn', counter: true, textSent: true }).messageKey, 'k2.done.counterText');
  assert.equal(kioskDoneModel({ orderType: 'dineIn', counter: true }).messageKey, 'k2.done.counter');
  assert.equal(kioskDoneModel({ orderType: 'dineIn' }).messageKey, 'k2.done.eatInAnywhere');
  assert.equal(kioskDoneModel({ orderType: 'dineIn', tableNumber: '4', counter: true }).messageKey, 'k2.done.eatInTable');
});

test('the kiosk menu header shows the venue name only after the Counter collect tile, other types unchanged', () => {
  assert.equal(kioskModeLabels({ orderType: 'dineIn', counterLabel: 'Collect at counter' }).title, 'Collect at counter');
  assert.equal(kioskModeLabels({ orderType: 'dineIn', counterLabel: 'Collect at counter' }).subKey, 'k2.menu.collect');
  assert.equal(kioskModeLabels({ orderType: 'takeaway', counterLabel: 'Collect at counter' }).title, undefined);
  assert.deepEqual(kioskModeLabels({ orderType: 'dineIn' }), { titleKey: 'k2.menu.eatIn', subKey: 'k2.menu.anywhere', vars: {} });
  assert.deepEqual(kioskModeLabels({ orderType: 'takeaway' }), { titleKey: 'k2.menu.takeaway', subKey: 'k2.menu.collect', vars: {} });
});

test('the counter link opens the counter page; table links and the bare host are unchanged', () => {
  const at = (pathname, search = '') => parseCustomerLocation({ hostname: 'coffeeboy.serv-os.app', pathname, search }, { customerRoot: 'serv-os.app' });
  assert.equal(at('/counter').mode, 'counter');
  assert.equal(at('/counter/').mode, 'counter');
  assert.equal(at('/', '?surface=counter').mode, 'counter');
  assert.equal(at('/t/5').mode, 'qr');
  assert.equal(at('/catering').mode, 'catering');
  assert.equal(at('/').mode, 'online');
  assert.equal(at('/counter').slug, 'coffeeboy');
});

test('the ready text goes to the counter for kiosk collection and marked web orders only', () => {
  // Kiosk: the tile books as dine in, so only at a venue with the kiosk tile on, and only dine in.
  assert.equal(isCounterCollectOrder({ source: 'kiosk', type: 'dine-in', customer: { phone: '+44' } }, { kioskTileOn: true }), true);
  assert.equal(isCounterCollectOrder({ source: 'kiosk', type: 'takeaway', customer: { phone: '+44' } }, { kioskTileOn: true }), false);
  // A venue that never switched it on: every kiosk text exactly as before.
  assert.equal(isCounterCollectOrder({ source: 'kiosk', type: 'dine-in', customer: { phone: '+44' } }), false);
  assert.equal(isCounterCollectOrder({ source: 'kiosk', type: 'takeaway' }), false);
  // The ready text reads the switch from the kiosk's own profile row (order-notify kioskProfile).
  assert.equal(kioskTileOn({ kiosk_counter_collect: true }), true);
  assert.equal(kioskTileOn({ kiosk_counter_collect: 'yes' }), false);
  assert.equal(kioskTileOn({ kiosk_new_design: true }), false);
  assert.equal(kioskTileOn(null), false);
  assert.equal(isCounterCollectOrder({ source: 'online', type: 'dine-in', customer: { counter_collect: true } }), true);
  // Online ordering's own Collection, QR at a table, the till and delivery keep their own text.
  assert.equal(isCounterCollectOrder({ source: 'online', type: 'collection', customer: {} }), false);
  assert.equal(isCounterCollectOrder({ source: 'qr', type: 'dine-in', customer: { tableId: 'T5' } }), false);
  assert.equal(isCounterCollectOrder({ source: 'pos', type: 'takeaway', customer: {} }), false);
  assert.equal(isCounterCollectOrder({ source: 'online', type: 'delivery', customer: { counter_collect: true } }), false);
  assert.equal(isCounterCollectOrder({ source: 'kiosk', type: 'delivery' }, { kioskTileOn: true }), false);
  assert.equal(isCounterCollectOrder(null), false);
});

test('the ready text says ready to collect at the counter', () => {
  assert.equal(counterReadyText({ firstName: 'Sam', ref: 'OL-AB12C', venueName: 'Coffee Boy Preston' }),
    'Hi Sam, your order #OL-AB12C is ready to collect at the counter at Coffee Boy Preston.');
  assert.equal(counterReadyText({ ref: 'R1234', shortRef: '34', venueName: 'Coffee Boy Preston' }),
    'Your order 34 is ready to collect at the counter at Coffee Boy Preston.');
  assert.equal(counterReadyText({ ref: 'R1' }), 'Your order #R1 is ready to collect at the counter.');
});

test('the counter page names its type with the venue name; online types keep theirs', () => {
  assert.deepEqual(orderTypeChip('dine-in', { counterLabel: 'Collect at counter' }), { icon: '🛎', label: 'Collect at counter' });
  assert.equal(orderTypeChip('dine-in').label, 'Dine-in');
  assert.equal(orderTypeChip('takeaway').label, 'Take away');
  assert.equal(orderTypeChip('collection').label, 'Collection');
  assert.equal(orderTypeChip('delivery').label, 'Delivery');
  assert.equal(orderTypeChip('dine-in').label, 'Dine-in');
  assert.equal(tipModuleFor({ counter: true }), 'qr');
  assert.equal(tipModuleFor({}), 'online');
});
