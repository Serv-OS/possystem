import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { alcoholCategorySet, orderHasAlcohol, kioskTicketLabels, kioskShortRef, kioskTableForTicket, kdsVisibleNote, KIOSK_CHECK_ID } from './kioskStaffFlags.js';
import { buildTicketMeta, parseLegacyTicket, ticketView, needsTypeLookup, joinNotes, shortRef } from './kds/kdsTicket.js';

const CATS = [
  { id: 'drinks', parent_id: null },
  { id: 'cocktails', parent_id: 'drinks' },
  { id: 'zero', parent_id: 'cocktails' },
  { id: 'pizza', parent_id: null },
  { id: 'beer', parentId: 'drinks' },
];

test('a ticked parent includes every category under it', () => {
  const s = alcoholCategorySet(['drinks'], CATS);
  assert.deepEqual([...s].sort(), ['beer', 'cocktails', 'drinks', 'zero']);
  assert.equal(alcoholCategorySet([], CATS).size, 0);
  assert.equal(alcoholCategorySet(null, CATS).size, 0);
  assert.deepEqual([...alcoholCategorySet(['cocktails'], null)], ['cocktails']);
});

test('a cycle in bad data does not loop', () => {
  const s = alcoholCategorySet(['a'], [{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }]);
  assert.deepEqual([...s].sort(), ['a', 'b']);
});

test('basket lines and order items both count', () => {
  const set = alcoholCategorySet(['cocktails'], CATS);
  assert.equal(orderHasAlcohol([{ item: { cat: 'zero' } }], set), true);
  assert.equal(orderHasAlcohol([{ item: { cat: 'pizza', cats: ['cocktails'] } }], set), true);
  assert.equal(orderHasAlcohol([{ cat: 'cocktails', mods: [] }], set), true);
  assert.equal(orderHasAlcohol([{ item: { cat: 'pizza' } }], set), false);
  assert.equal(orderHasAlcohol([{ cat: 'cocktails', voided: true }], set), false);
  assert.equal(orderHasAlcohol([{ item: { cat: 'zero' } }], new Set()), false);
});

test('a modifier linked to an alcohol item counts', () => {
  const set = alcoholCategorySet(['drinks'], CATS);
  const byId = new Map([['shot', { id: 'shot', cat: 'beer' }]]);
  const line = { item: { cat: 'pizza' }, modsArray: [{ label: 'Beer', itemId: 'shot' }] };
  assert.equal(orderHasAlcohol([line], set, byId), true);
  assert.equal(orderHasAlcohol([line], set), false);
  assert.equal(orderHasAlcohol([{ cat: 'pizza', mods: [{ itemId: 'shot' }] }], set, { shot: { cat: 'beer' } }), true);
});

test('a size line uses the parent category', () => {
  const set = alcoholCategorySet(['drinks'], CATS);
  // kioskOrderItem writes the parent's cat on a size line.
  assert.equal(orderHasAlcohol([{ id: 'pint', itemId: 'pint', parentId: 'lager', cat: 'beer' }], set), true);
  assert.equal(orderHasAlcohol([{ item: { id: 'lager', cat: 'beer' }, variant: { id: 'pint' } }], set), true);
});

test('non kiosk labels are exactly today, on the row, the paper and the KDS meta', () => {
  const today = (o) => {
    const tableLabel = o.source === 'qr' && o.tableLabel ? `Table ${o.tableLabel}` : `${o.srcLabel} ${o.ref}`;
    const serverName = o.customer?.name || `${o.srcLabel} ${o.ref}`;
    return {
      tableLabel, serverName, printTableLabel: tableLabel, printServerName: serverName,
      // routeKioskOrderPrints' v5.8.66 meta test: order.source === 'qr' && !!order.tableLabel
      isTable: o.source === 'qr' && !!o.tableLabel,
      flagNote: null,
    };
  };
  const cases = [
    { source: 'qr', srcLabel: 'QR', ref: 'Q12', tableLabel: 'T5', customer: { name: 'Ann' } },
    { source: 'qr', srcLabel: 'QR', ref: 'Q13', tableLabel: null, customer: null },
    { source: 'online', srcLabel: 'Online', ref: 'OL-9', customer: { name: 'Bo' } },
    { source: 'hubrise', srcLabel: 'HubRise', ref: 'H1', customer: {} },
    { source: 'catering', srcLabel: 'Catering', ref: 'C1' },
  ];
  for (const o of cases) {
    const got = kioskTicketLabels({
      source: o.source, ref: o.ref, srcLabel: o.srcLabel, qrTableLabel: o.tableLabel,
      kioskTable: 'IGNORED', customerName: o.customer?.name, idCheck: true,
    });
    assert.deepEqual(got, today(o), o.source);
  }
});

test('kiosk labels: the number, the table and CHECK ID', () => {
  const base = { source: 'kiosk', ref: 'R1247', srcLabel: 'Kiosk', orderType: 'dine-in' };
  // New design, take away or sit anywhere: no name, the row keeps the full ref (the KDS reads
  // it back as #47 and looks the order type up by it), the paper shows the short number.
  assert.deepEqual(kioskTicketLabels({ ...base }), {
    tableLabel: 'Kiosk R1247', serverName: 'Kiosk R1247',
    printTableLabel: 'Kiosk #47', printServerName: 'Kiosk #47', isTable: false, flagNote: null,
  });
  // A table: a table ticket labelled with the table and the number, on the row and the paper.
  assert.deepEqual(kioskTicketLabels({ ...base, kioskTable: '12' }), {
    tableLabel: 'Table 12 · #47', serverName: 'Kiosk R1247',
    printTableLabel: 'Table 12 · #47', printServerName: 'Kiosk #47', isTable: true, flagNote: null,
  });
  // CHECK ID: the KDS note, the paper Server line, and a row server that leads with the number.
  assert.deepEqual(kioskTicketLabels({ ...base, kioskTable: 'B5', idCheck: true }), {
    tableLabel: 'Table B5 · #47', serverName: '#47 · CHECK ID',
    printTableLabel: 'Table B5 · #47', printServerName: 'Kiosk #47 · CHECK ID', isTable: true, flagNote: KIOSK_CHECK_ID,
  });
  assert.deepEqual(kioskTicketLabels({ ...base, idCheck: true }), {
    tableLabel: 'Kiosk R1247', serverName: '#47 · CHECK ID',
    printTableLabel: 'Kiosk #47', printServerName: 'Kiosk #47 · CHECK ID', isTable: false, flagNote: 'CHECK ID',
  });
  assert.deepEqual(kioskTicketLabels({ ...base, kioskTable: '  ', idCheck: false }), kioskTicketLabels({ ...base }));
  // A name typed on the current design: the row is exactly what it was before (name, full ref
  // label), and the name never replaces the number, which the label and the paper header carry.
  assert.deepEqual(kioskTicketLabels({ ...base, customerName: 'Peter' }), {
    tableLabel: 'Kiosk R1247', serverName: 'Peter',
    printTableLabel: 'Kiosk #47', printServerName: 'Peter', isTable: false, flagNote: null,
  });
  assert.deepEqual(kioskTicketLabels({ ...base, kioskTable: '12', customerName: 'Peter', idCheck: true }), {
    tableLabel: 'Table 12 · #47', serverName: 'Peter · CHECK ID',
    printTableLabel: 'Table 12 · #47', printServerName: 'Peter · CHECK ID', isTable: true, flagNote: 'CHECK ID',
  });
});

test('a table left on a take away kiosk order never reaches staff', () => {
  // Today's kiosk: Eat in, table 12, Back, Take away. submitOrder still saves kiosk_table_number 12.
  assert.equal(kioskTableForTicket('12', 'takeaway'), null);
  assert.equal(kioskTableForTicket('12', 'collection'), null);
  assert.equal(kioskTableForTicket('12', null), null);
  assert.equal(kioskTableForTicket('12', undefined), null);
  assert.equal(kioskTableForTicket(' 12 ', 'dine-in'), '12');
  assert.equal(kioskTableForTicket('  ', 'dine-in'), null);
  assert.equal(kioskTableForTicket(null, 'dine-in'), null);
  assert.equal(kioskTableForTicket(7, 'dine-in'), '7');
  const base = { source: 'kiosk', ref: 'R1247', srcLabel: 'Kiosk', kioskTable: '12' };
  const plain = { source: 'kiosk', ref: 'R1247', srcLabel: 'Kiosk' };
  for (const orderType of ['takeaway', null]) {
    // Paper, the row and the meta input are exactly the no table ticket.
    assert.deepEqual(kioskTicketLabels({ ...base, orderType }), kioskTicketLabels({ ...plain, orderType }), String(orderType));
    assert.deepEqual(kioskTicketLabels({ ...base, orderType, customerName: 'Peter', idCheck: true }), kioskTicketLabels({ ...plain, orderType, customerName: 'Peter', idCheck: true }));
  }
  const labels = kioskTicketLabels({ ...base, orderType: 'takeaway' });
  assert.equal(labels.tableLabel, 'Kiosk R1247');
  assert.equal(labels.printTableLabel, 'Kiosk #47');
  assert.equal(labels.isTable, false);
  // The KDS: with meta and from the row alone it is a take away headed #47, never DINE-IN (table).
  const row = { table: labels.tableLabel, server: labels.serverName, table_label: labels.tableLabel };
  const withMeta = ticketView({ ...row, meta: stampedMeta({ source: 'kiosk', typeKey: 'takeaway', customer: null, ref: 'R1247', labels, srcLabel: 'Kiosk' }) });
  assert.equal(withMeta.typeKey, 'takeaway');
  assert.equal(withMeta.headline, '#47');
  const legacyMeta = parseLegacyTicket(row);
  const fromRow = ticketView({ ...row, meta: legacyMeta }, needsTypeLookup(legacyMeta) ? { ref: 'R1247', type: 'takeaway', customer: {} } : null);
  assert.equal(fromRow.typeKey, 'takeaway');
  assert.equal(fromRow.headline, '#47');
  // And the store asks for the table through the eat in rule, for the labels and order_queue.
  const src = fs.readFileSync(new URL('../store/index.js', import.meta.url), 'utf8');
  assert.equal(src.split('kioskTable = kioskTableForTicket(kc?.data?.kiosk_table_number, typeKey);').length - 1, 1);
  assert.equal(src.split('kioskTable, orderType: typeKey, customerName: order.customer?.name, idCheck,').length - 1, 1);
});

test('CHECK ID shows on a KDS screen with Kitchen notes switched off', () => {
  const note = joinNotes(KIOSK_CHECK_ID, 'No onions please');
  assert.equal(kdsVisibleNote(note, true), note);
  assert.equal(kdsVisibleNote(note, false), KIOSK_CHECK_ID);
  assert.equal(kdsVisibleNote(KIOSK_CHECK_ID, false), KIOSK_CHECK_ID);
  assert.equal(kdsVisibleNote('No onions please', false), null);
  assert.equal(kdsVisibleNote('No onions please', true), 'No onions please');
  assert.equal(kdsVisibleNote('Say CHECK ID to the chef', false), null);
  assert.equal(kdsVisibleNote(null, true), null);
  assert.equal(kdsVisibleNote('  ', true), null);
  // The note routeKioskOrderPrints stamps for an alcohol order, through the real KDS view.
  const labels = kioskTicketLabels({ source: 'kiosk', ref: 'R1247', srcLabel: 'Kiosk', orderType: 'takeaway', idCheck: true });
  const view = ticketView({ table_label: labels.tableLabel, server: labels.serverName, meta: stampedMeta({ source: 'kiosk', typeKey: 'takeaway', customer: { notes: 'Extra ketchup' }, ref: 'R1247', labels, srcLabel: 'Kiosk' }) });
  assert.equal(kdsVisibleNote(view.note, false), KIOSK_CHECK_ID);
  // Both card layouts draw the note through it, never through show.notes alone.
  const card = fs.readFileSync(new URL('../surfaces/kds/KdsTicketCard.jsx', import.meta.url), 'utf8');
  assert.equal(card.split('show.notes && view.note').length - 1, 0);
  assert.equal(card.split('const note = kdsVisibleNote(view.note, show.notes);').length - 1, 2);
  assert.equal(card.split('{note && <NoteBlock note={note} ').length - 1, 2);
});

test('kiosk short number matches the KDS (and so db.js shortOrderRef)', () => {
  for (const ref of ['R32635', 'R1247', 'R17', 'R7', 'R100', 'OL-BVUIH', '']) assert.equal(kioskShortRef(ref), shortRef(ref), ref);
});

// What routeKioskOrderPrints stamps into kds_tickets.meta for a channel order (store/index.js).
function stampedMeta({ source, typeKey, customer, ref, labels, srcLabel }) {
  return buildTicketMeta({
    channel: source || 'kiosk',
    orderType: typeKey,
    isTable: labels.isTable,
    customerName: customer?.name,
    orderRef: ref,
    appCode: null,
    source: srcLabel,
    note: labels.flagNote ? joinNotes(labels.flagNote, customer?.notes) : customer?.notes,
  });
}

test('routeKioskOrderPrints builds the meta the way these tests do', () => {
  const src = fs.readFileSync(new URL('../store/index.js', import.meta.url), 'utf8');
  for (const line of [
    'orderType: typeKey,\n        isTable: ticketIsTable,',
    'note: flagNote ? joinNotes(flagNote, order.customer?.notes) : order.customer?.notes,',
    'table_label: tableLabel,\n        server: serverName,',
    'tableLabel: printTableLabel,\n          server: printServerName,',
  ]) assert.equal(src.split(line).length - 1, 1, line);
});

test('one rule: the KDS shows a kiosk ticket the same with meta and from the row alone', () => {
  const cases = [
    // [what, order type, customer, table, alcohol, headline, board type]
    ['new design take away', 'takeaway', null, '', false, '#47', 'takeaway'],
    ['new design sit anywhere', 'dine-in', null, '', false, '#47', 'dineinName'],
    ['new design at a table', 'dine-in', null, '12', false, 'Table 12 · #47', 'dineinTable'],
    ['new design take away with alcohol', 'takeaway', null, '', true, '#47', 'takeaway'],
    ['new design table with alcohol', 'dine-in', null, 'B5', true, 'Table B5 · #47', 'dineinTable'],
    ['current design, named', 'takeaway', { name: 'Peter Roberts' }, '', false, 'Peter Roberts', 'takeaway'],
    ['current design, named, with alcohol', 'takeaway', { name: 'Peter Roberts' }, '', true, 'Peter Roberts', 'takeaway'],
  ];
  for (const [what, typeKey, customer, table, alcohol, headline, type] of cases) {
    const labels = kioskTicketLabels({ source: 'kiosk', ref: 'R1247', srcLabel: 'Kiosk', kioskTable: table, orderType: typeKey, customerName: customer?.name, idCheck: alcohol });
    const row = { table: labels.tableLabel, server: labels.serverName, table_label: labels.tableLabel };
    // With meta (after 20260914_OPS_kds_redesign.sql).
    const withMeta = ticketView({ ...row, meta: stampedMeta({ source: 'kiosk', typeKey, customer, ref: 'R1247', labels, srcLabel: 'Kiosk' }) });
    // From the row alone: the KDS asks order_queue for the type by the ref it reads.
    const legacyMeta = parseLegacyTicket(row);
    const queueRow = needsTypeLookup(legacyMeta)
      ? (legacyMeta.orderRef === 'R1247' ? { ref: 'R1247', type: typeKey, customer: customer || {} } : null)
      : null;
    if (needsTypeLookup(legacyMeta)) assert.equal(legacyMeta.orderRef, 'R1247', `${what}: the row keeps the full ref for the type lookup`);
    const fromRow = ticketView({ ...row, meta: legacyMeta }, queueRow);

    assert.equal(withMeta.typeKey, type, `${what}: board type with meta`);
    assert.equal(fromRow.typeKey, type, `${what}: board type from the row`);
    assert.equal(withMeta.headline, headline, `${what}: headline with meta`);
    // The number is always on the ticket: in the headline, or beside a name.
    for (const [path, v] of [['meta', withMeta], ['row', fromRow]]) {
      const shown = [v.headline, ...(v.meta.orderNo && `#${v.meta.orderNo}` !== v.headline ? [`#${v.meta.orderNo}`] : [])].join(' | ');
      assert.ok(shown.includes('#47'), `${what}: #47 shown (${path}: ${shown})`);
      if (!customer) assert.ok(v.headline.startsWith(table ? `Table ${table} · #47` : '#47'), `${what}: number led headline (${path}: ${v.headline})`);
    }
    if (!alcohol) assert.equal(fromRow.headline, headline, `${what}: headline from the row`);
    if (alcohol) {
      assert.ok(String(withMeta.note).startsWith('CHECK ID'), `${what}: CHECK ID note with meta`);
      assert.ok(`${fromRow.headline} ${fromRow.staff || ''}`.includes('CHECK ID'), `${what}: CHECK ID from the row`);
    }
  }
});

test('customer and staff agree: an item that is alcohol only through cats, and a linked modifier', async () => {
  const { kioskOrderItem } = await import('./kioskLine.js');
  const set = alcoholCategorySet(['drinks'], CATS);
  const spritz = { id: 'spritz', name: 'Spritz', cat: 'pizza', cats: ['pizza', 'cocktails'] };
  const burger = { id: 'burger', name: 'Burger', cat: 'pizza' };
  const rum = { id: 'rum', name: 'Rum shot', cat: 'beer' };
  const byId = new Map([spritz, burger, rum].map(r => [r.id, r]));
  const carts = [
    [{ key: 'a', item: spritz, name: 'Spritz', qty: 1, linePrice: 7, modsArray: [] }],
    [{ key: 'b', item: burger, name: 'Burger', qty: 1, linePrice: 9, modsArray: [{ label: 'Add a rum shot', price: 3, groupLabel: 'Extras', itemId: 'rum' }] }],
  ];
  for (const cart of carts) {
    const customer = orderHasAlcohol(cart, set, byId);
    const staff = orderHasAlcohol(cart.map(kioskOrderItem), set, byId);
    assert.equal(customer, true);
    assert.equal(staff, customer);
  }
  // Without the menu rows an order item cannot see cats.
  assert.equal(orderHasAlcohol(carts[0].map(kioskOrderItem), set), false);
});
