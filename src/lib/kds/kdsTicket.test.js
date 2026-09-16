// KDS redesign (v5.8.66): the rules behind a ticket card.
// Legacy labels below are REAL table_label / server values read from live kds_tickets
// on 14 Sep 2026, so an old ticket, or one from a till still running old code, still
// lands in the right type with the right name.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  KDS_TYPES, KDS_STATUS, buildTicketMeta, parseLegacyTicket, ticketMeta, needsTypeLookup, fallbackTypeForChannel,
  kdsTypeKey, ticketHeadline, identityLine, ticketLine, courseGroups, minutesSince, formatElapsed,
  statusOf, sortTickets, typeCounts, rollUp, shortRef, joinNotes, normaliseOrderType, applyQueueLookup, ticketView, identityParts, venueBusinessDayStart,
} from './kdsTicket.js';

test('six types, delivery is pink, drive thru is blue and red stays the LATE colour only', () => {
  assert.deepEqual(Object.keys(KDS_TYPES), ['dineinName', 'dineinTable', 'takeaway', 'collection', 'delivery', 'drivethru']);
  assert.equal(KDS_TYPES.delivery.c, '#F472B6');
  assert.equal(KDS_TYPES.delivery.label, 'DELIVERY');
  assert.equal(KDS_TYPES.drivethru.label, 'DRIVE THRU');
  assert.equal(KDS_TYPES.drivethru.legend, 'Drive thru');
  assert.ok(!Object.values(KDS_TYPES).some(t => t.c === '#FF6B6B'));
  // Drive thru is its own colour: not one of the other five types, not a time status colour.
  const others = Object.values(KDS_TYPES).filter(t => t.key !== 'drivethru').map(t => t.c.toUpperCase());
  const status = Object.values(KDS_STATUS).map(s => s.c.toUpperCase());
  assert.ok(!others.includes(KDS_TYPES.drivethru.c.toUpperCase()));
  assert.ok(!status.includes(KDS_TYPES.drivethru.c.toUpperCase()));
});

test('shortRef matches shortOrderRef in db.js exactly (the receipt number)', () => {
  const src = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  const m = /export function shortOrderRef\(ref\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'shortOrderRef not found in db.js');
  const dbShort = new Function('ref', m[1]);
  for (const ref of ['R32635', 'R17', 'R7', 'R100', 'OL-BVUIH', 'HR-g23er44', 'CA-5BEPG', 'TAB-1', '']) {
    assert.equal(shortRef(ref), dbShort(ref), ref);
  }
  assert.equal(shortRef('R32635'), '35');
});

test('normaliseOrderType accepts the spellings the app and channels write', () => {
  assert.equal(normaliseOrderType('Dine-in'), 'dine-in');
  assert.equal(normaliseOrderType('eat_in'), 'dine-in');
  assert.equal(normaliseOrderType('TAKEOUT'), 'takeaway');
  assert.equal(normaliseOrderType('pickup'), 'collection');
  assert.equal(normaliseOrderType('delivery'), 'delivery');
  assert.equal(normaliseOrderType('bar'), null);
  // Drive thru (16 Sep 2026): every spelling the till, the pricing jsonb and a person might write.
  for (const s of ['drive-thru', 'Drive thru', 'drive_thru', 'driveThru', 'drivethru', 'DRIVE THRU', 'drive-through', 'Drive Through']) {
    assert.equal(normaliseOrderType(s), 'drive-thru', s);
  }
  assert.equal(normaliseOrderType('drive'), null);
});

test('drive thru: a till ticket lands on the DRIVE THRU board type with its number', () => {
  const till = buildTicketMeta({ channel: 'till', orderType: 'drive-thru', customerName: 'Peter', orderRef: 'R32636', source: 'Till 1' });
  assert.equal(till.orderType, 'drive-thru');
  assert.equal(kdsTypeKey(till), 'drivethru');
  assert.equal(till.orderNo, '36');
  // Stamped meta reads back the same way.
  assert.equal(kdsTypeKey(ticketMeta({ meta: till })), 'drivethru');
  // A table is still a table whatever type the till had selected.
  assert.equal(kdsTypeKey(buildTicketMeta({ channel: 'table', orderType: 'drive-thru', isTable: true })), 'dineinTable');
  // Only the literal key: nothing else moves.
  assert.equal(kdsTypeKey({ orderType: 'takeaway' }), 'takeaway');
  assert.equal(kdsTypeKey({ orderType: null, channel: 'till' }), 'dineinName');
});

test('buildTicketMeta: tables and bar tabs never carry a number, tills carry the short one', () => {
  const table = buildTicketMeta({ channel: 'table', orderType: 'takeaway', orderRef: 'R123', source: 'Till 2', staff: 'Neil' });
  assert.equal(table.orderNo, null);
  assert.equal(table.orderType, 'dine-in');
  assert.equal(table.isTable, true);
  assert.equal(table.source, 'Till 2');

  const bar = buildTicketMeta({ channel: 'bar', customerName: 'Neil', orderRef: 'R5' });
  assert.equal(bar.orderNo, null);
  assert.equal(kdsTypeKey(bar), 'dineinName');

  const till = buildTicketMeta({ channel: 'till', orderType: 'takeaway', customerName: '  Peter  Roberts ', orderRef: 'R32635' });
  assert.equal(till.orderNo, '35');
  assert.equal(till.customerName, 'Peter Roberts');
});

test('buildTicketMeta: a delivery app code wins over our ref (Peter: #8455)', () => {
  const m = buildTicketMeta({ channel: 'hubrise', orderType: 'delivery', orderRef: 'HR-g23er44', appCode: '8455', source: 'Deliveroo' });
  assert.equal(m.orderNo, '8455');
  assert.equal(kdsTypeKey(m), 'delivery');
  const noCode = buildTicketMeta({ channel: 'hubrise', orderType: 'delivery', orderRef: 'HR-g23er44', appCode: '' });
  assert.equal(noCode.orderNo, 'HR-g23er44');
});

test('buildTicketMeta: QR at a table is a table ticket', () => {
  const m = buildTicketMeta({ channel: 'qr', orderType: 'dine-in', isTable: true, orderRef: 'R44' });
  assert.equal(kdsTypeKey(m), 'dineinTable');
  assert.equal(m.orderNo, null);
});

test('legacy labels from live data parse to the right type, name and number', () => {
  const cases = [
    [{ table_label: 'Takeaway · Peter Roberts', server: 'Peter' }, 'takeaway', 'Peter Roberts', 'Peter'],
    [{ table_label: 'Dine-in · J', server: 'Peter' }, 'dineinName', 'J', 'Peter'],
    [{ table_label: 'Collection · Peter Roberts', server: 'Peter' }, 'collection', 'Peter Roberts', 'Peter'],
    [{ table_label: 'dine-in', server: 'Peter' }, 'dineinName', null, 'Peter'],
    [{ table_label: 'Bar · Neil', server: 'Neil' }, 'dineinName', 'Neil', 'Neil'],
    [{ table_label: 'T1', server: 'Peter Roberts' }, 'dineinTable', null, 'Peter Roberts'],
    [{ table_label: 'Table t1.2', server: 'Peter Roberts' }, 'dineinTable', null, 'Peter Roberts'],
    [{ table_label: 'Petes Office Desk', server: 'Peter' }, 'dineinTable', null, 'Peter'],
    // Drive thru (16 Sep 2026): the till's label ("Drive thru · Name") and the hand typed spellings.
    [{ table_label: 'Drive thru · Peter Roberts', server: 'Neil' }, 'drivethru', 'Peter Roberts', 'Neil'],
    [{ table_label: 'Drive-thru · Peter', server: 'Peter' }, 'drivethru', 'Peter', 'Peter'],
    [{ table_label: 'Drive through · Sam', server: 'Peter' }, 'drivethru', 'Sam', 'Peter'],
    // A bare drive thru label with no meta is a TABLE. A till on new code always stamps meta
    // for its bare "drive-thru", so a no meta row reading "Drive thru" is a table named after
    // the lane, and a legacy venue with such a table keeps its table card.
    [{ table_label: 'Drive thru', server: 'Peter' }, 'dineinTable', null, 'Peter'],
    [{ table_label: 'drive-thru', server: 'Peter' }, 'dineinTable', null, 'Peter'],
    [{ table_label: 'Drive thru bay 2', server: 'Peter' }, 'dineinTable', null, 'Peter'],
  ];
  for (const [row, type, name, staff] of cases) {
    const m = parseLegacyTicket(row);
    assert.equal(kdsTypeKey(m), type, row.table_label);
    assert.equal(m.customerName, name, row.table_label);
    assert.equal(m.staff, staff, row.table_label);
    assert.equal(m.legacy, true);
  }
});

test('legacy channel tickets: name from server, number from label, type looked up later', () => {
  const kiosk = parseLegacyTicket({ table_label: 'Kiosk R19', server: 'Peter Roberts' });
  assert.equal(kiosk.channel, 'kiosk');
  assert.equal(kiosk.customerName, 'Peter Roberts');
  assert.equal(kiosk.orderNo, '19');
  assert.equal(kiosk.source, 'Kiosk');
  assert.equal(kiosk.staff, null);
  assert.equal(needsTypeLookup(kiosk), true);

  const noName = parseLegacyTicket({ table_label: 'Online OL-BVUIH', server: 'Online OL-BVUIH' });
  assert.equal(noName.customerName, null);
  assert.equal(noName.orderNo, 'OL-BVUIH');

  const catering = parseLegacyTicket({ table_label: 'Catering CA-5BEPG', server: 'Neil Brorsen' });
  assert.equal(catering.customerName, 'Neil Brorsen');
  assert.equal(catering.source, 'Catering');

  assert.equal(fallbackTypeForChannel('hubrise'), 'delivery');
  assert.equal(fallbackTypeForChannel('online'), 'collection');
  assert.equal(fallbackTypeForChannel('kiosk'), 'dine-in');
});

test('ticketMeta prefers stamped meta and ignores a junk meta value', () => {
  const stamped = ticketMeta({ table_label: 'Takeaway · Old Name', meta: { v: 1, channel: 'till', orderType: 'collection', customerName: 'New Name', orderNo: '35', source: 'Till 2' } });
  assert.equal(stamped.customerName, 'New Name');
  assert.equal(kdsTypeKey(stamped), 'collection');
  assert.equal(stamped.orderNo, '35');
  assert.equal(stamped.legacy, undefined);
  assert.equal(needsTypeLookup(stamped), false);

  const junk = ticketMeta({ table_label: 'Takeaway · Old Name', meta: [] });
  assert.equal(junk.customerName, 'Old Name');
});

test('headline: table label, else name, else the order number big, else Walk-in', () => {
  assert.equal(ticketHeadline({ isTable: true }, 'Table 3'), 'Table 3');
  assert.equal(ticketHeadline({ customerName: 'William Austin-Fitzgerald', orderNo: '42' }), 'William Austin-Fitzgerald');
  assert.equal(ticketHeadline({ customerName: null, orderNo: '35' }), '#35');
  assert.equal(ticketHeadline({}), 'Walk-in');
});

test('identity line: two spaces, pipe, two spaces; the number drops when it is the headline', () => {
  const m = { source: 'Drive Thru 2', orderNo: '43' };
  assert.equal(identityLine(m, 'Peter Roberts'), 'Drive Thru 2  |  #43');
  assert.equal(identityLine(m, 'Peter Roberts', { showSource: false }), '#43');
  assert.equal(identityLine(m, '#43'), 'Drive Thru 2');
  assert.equal(identityLine({ source: 'Till 2', orderNo: null }, 'Table 3'), 'Till 2');
  assert.equal(identityLine({ source: null, orderNo: null }, 'Table 3'), '');
  assert.deepEqual(identityParts({ source: 'Catering', orderNo: 'CA-5BEPG' }, 'Oliver Brandt'), ['Catering', '#CA-5BEPG']);
});

test('ticketLine: allergens come out, item notes stay as modifier lines, object mods read', () => {
  const l = ticketLine({ qty: 2, name: 'Burger', mods: ['Rare', '⚠ MILK · GLUTEN', '📝 No cheese', { name: 'Brioche Bun' }] }, 3);
  assert.deepEqual(l.mods, ['Rare', '📝 No cheese', 'Brioche Bun']);
  assert.equal(l.allergen, 'MILK · GLUTEN');
  assert.equal(l.qty, 2);
  assert.equal(l.index, 3);
  assert.equal(ticketLine({ name: 'X', mods: 'Oat milk' }).mods[0], 'Oat milk');
});

test('courseGroups: firing first, hold after, voided lines left off', () => {
  const g = courseGroups([
    { qty: 1, name: 'Soup', course: 1 },
    { qty: 1, name: 'Steak', course: 2 },
    { qty: 1, name: 'Water', course: 0 },
    { qty: 1, name: 'Gone', course: 1, voided: true },
  ], [0, 1]);
  assert.deepEqual(g.map(x => x.label), ['IMMEDIATE — FIRING', 'COURSE 1 — FIRING', 'COURSE 2 — HOLD']);
  assert.deepEqual(g[1].lines.map(l => l.name), ['Soup']);
  assert.equal(g[1].lines[0].index, 0);
  assert.deepEqual(courseGroups([{ qty: 1, name: 'A' }], []).map(x => x.label), ['COURSE 1 — FIRING']);
});

test('minutes, format and status against the thresholds', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  assert.equal(minutesSince(now - 9.9 * 60000, now), 9);
  assert.equal(minutesSince('not a date', now), 0);
  assert.equal(minutesSince(now + 60000, now), 0);
  assert.equal(formatElapsed(65), '1h 5m');
  assert.equal(formatElapsed(7), '7m');
  assert.equal(statusOf(9, 10, 15).label, 'ON TIME');
  assert.equal(statusOf(10, 10, 15).label, 'CAUTION');
  assert.equal(statusOf(15, 10, 15).label, 'LATE');
});

test('sortTickets: oldest first, held to the end only when the switch is on', () => {
  const t = [{ id: 'a', sentAt: 3 }, { id: 'b', sentAt: 1, held: true }, { id: 'c', sentAt: 2 }];
  assert.deepEqual(sortTickets(t).map(x => x.id), ['c', 'a', 'b']);
  assert.deepEqual(sortTickets(t, { heldToEnd: false }).map(x => x.id), ['b', 'c', 'a']);
});

test('typeCounts: All first, zero counts hidden unless active', () => {
  const tickets = [{ typeKey: 'takeaway' }, { typeKey: 'takeaway' }, { typeKey: 'delivery' }];
  assert.deepEqual(typeCounts(tickets).map(c => [c.key, c.count]), [['all', 3], ['takeaway', 2], ['delivery', 1]]);
  assert.deepEqual(typeCounts(tickets, 'collection').map(c => c.key), ['all', 'takeaway', 'collection', 'delivery']);
  // Drive thru is a sixth pill, after delivery, with its own colour and legend.
  const withDt = typeCounts([...tickets, { typeKey: 'drivethru' }]);
  assert.deepEqual(withDt.map(c => [c.key, c.count]), [['all', 4], ['takeaway', 2], ['delivery', 1], ['drivethru', 1]]);
  assert.equal(withDt.at(-1).label, 'Drive thru');
  assert.equal(withDt.at(-1).c, KDS_TYPES.drivethru.c);
  assert.deepEqual(typeCounts(tickets, 'drivethru').map(c => c.key), ['all', 'takeaway', 'delivery', 'drivethru']);
});

test('rollUp: split by modifiers, qty summed, held and ticked and unfired skipped', () => {
  const r = rollUp([
    { firedCourses: [0, 1], items: [{ qty: 2, name: 'Flat white' }, { qty: 1, name: 'Flat white', mods: ['Oat milk'] }] },
    { firedCourses: [0, 1], items: [{ qty: 1, name: 'Flat white' }, { qty: 5, name: 'Steak', course: 2 }, { qty: 4, name: 'Done', _bumped: true }] },
    { held: true, firedCourses: [0, 1], items: [{ qty: 9, name: 'Flat white' }] },
    { firedCourses: [0, 1], items: [{ qty: 1, name: 'Burger', mods: ['⚠ SESAME'] }, { qty: 1, name: 'Burger' }] },
  ]);
  assert.deepEqual(r.map(x => [x.name, x.mods, x.qty]), [
    ['Flat white', [], 3],
    ['Burger', [], 1],
    ['Burger', ['⚠ SESAME'], 1],
    ['Flat white', ['Oat milk'], 1],
  ]);
});

test('joinNotes drops blanks and repeats', () => {
  assert.equal(joinNotes('Waiting in bay 3', '', null, 'waiting in bay 3', 'No utensils'), 'Waiting in bay 3\nNo utensils');
  assert.equal(joinNotes('', null), null);
  // a stamped two line note survives the read back
  const m = ticketMeta({ meta: buildTicketMeta({ channel: 'till', note: joinNotes('Bay 3', 'No utensils') }) });
  assert.equal(m.note, 'Bay 3\nNo utensils');
});

test('applyQueueLookup: a legacy HubRise ticket gets its type, app code and channel', () => {
  const legacy = parseLegacyTicket({ table_label: 'HubRise HR-g23er44', server: 'HubRise HR-g23er44' });
  const filled = applyQueueLookup(legacy, { type: 'delivery', customer: { name: 'Sam', channel: 'Deliveroo', collectionCode: '8455', notes: 'No utensils' } });
  assert.equal(kdsTypeKey(filled), 'delivery');
  assert.equal(filled.orderNo, '8455');
  assert.equal(filled.source, 'Deliveroo');
  assert.equal(filled.customerName, 'Sam');
  assert.equal(filled.note, 'No utensils');
  assert.equal(applyQueueLookup(legacy, null), legacy);
  const kiosk = applyQueueLookup(parseLegacyTicket({ table_label: 'Kiosk R17', server: 'Peter' }), { type: 'takeaway', customer: { collectionCode: '9' } });
  assert.equal(kdsTypeKey(kiosk), 'takeaway');
  assert.equal(kiosk.orderNo, '17');
  // An order_queue row typed drive-thru fills a legacy channel ticket the same way.
  const dt = applyQueueLookup(parseLegacyTicket({ table_label: 'Online OL-DT1', server: 'Online OL-DT1' }), { type: 'drive-thru', customer: { name: 'Ava' } });
  assert.equal(kdsTypeKey(dt), 'drivethru');
  assert.equal(dt.customerName, 'Ava');
});

test('ticketView: a drive thru till ticket is a DRIVE THRU card, no meta or stamped', () => {
  const stamped = ticketView({
    id: 'k3', table: 'Drive-thru · Peter', covers: 1, firedCourses: [0, 1],
    items: [{ qty: 2, name: 'Burger', course: 1 }],
    meta: buildTicketMeta({ channel: 'till', orderType: 'drive-thru', customerName: 'Peter', orderRef: 'R32636', source: 'Till 1', staff: 'Neil' }),
  });
  assert.equal(stamped.typeKey, 'drivethru');
  assert.equal(stamped.type.label, 'DRIVE THRU');
  assert.equal(stamped.headline, 'Peter');
  assert.equal(identityLine(stamped.meta, stamped.headline), 'Till 1  |  #36');

  // No meta, the till's named label: still a drive thru card.
  const legacy = ticketView({ id: 'k4', table: 'Drive thru · Peter', server: 'Neil', covers: 1, items: [] });
  assert.equal(legacy.typeKey, 'drivethru');
  assert.equal(legacy.headline, 'Peter');
  assert.equal(legacy.meta.legacy, true);
  // A bare "drive-thru" from a till on new code carries meta, and that is what types it.
  const bare = ticketView({
    id: 'k5', table: 'drive-thru', covers: 1, items: [],
    meta: buildTicketMeta({ channel: 'till', orderType: 'drive-thru', orderRef: 'R32637', source: 'Till 1', staff: 'Peter' }),
  });
  assert.equal(bare.typeKey, 'drivethru');
  assert.equal(bare.headline, '#37');
  // A no meta row whose label is exactly "Drive thru" is a floor table of that name, not a walk in.
  const named = ticketView({ id: 'k6', table: 'Drive thru', server: 'Peter', covers: 2, items: [] });
  assert.equal(named.typeKey, 'dineinTable');
  assert.equal(named.headline, 'Drive thru');
  assert.equal(named.meta.legacy, true);
});

test('ticketView: a stamped till ticket with no name shows its receipt number big', () => {
  const v = ticketView({
    id: 'k1', table: 'takeaway', covers: 1, firedCourses: [0, 1],
    items: [{ qty: 1, name: 'Chips', course: 1 }],
    meta: buildTicketMeta({ channel: 'till', orderType: 'takeaway', orderRef: 'R32635', source: 'Till 1', staff: 'Neil' }),
  });
  assert.equal(v.typeKey, 'takeaway');
  assert.equal(v.headline, '#35');
  assert.equal(identityLine(v.meta, v.headline), 'Till 1');
  assert.equal(v.coversLabel, null);
  assert.equal(v.staff, 'Neil');
  assert.equal(v.groups[0].label, 'COURSE 1 — FIRING');
});

test('ticketView: a table ticket shows the table, the till, covers and no number', () => {
  const v = ticketView({
    id: 'k2', table: 'Table 3', covers: 4, items: [],
    meta: buildTicketMeta({ channel: 'table', isTable: true, source: 'Till 2', staff: 'Sian', note: 'Birthday, bring the cake last' }),
  });
  assert.equal(v.typeKey, 'dineinTable');
  assert.equal(v.headline, 'Table 3');
  assert.equal(identityLine(v.meta, v.headline), 'Till 2');
  assert.equal(v.coversLabel, '4 cv');
  assert.equal(v.note, 'Birthday, bring the cake last');
});

test('stamped meta: a delivery app code that looks like a receipt ref is not shortened again', () => {
  const stamped = buildTicketMeta({ channel: 'hubrise', orderType: 'delivery', orderRef: 'HR-x', appCode: 'R4821' });
  assert.equal(stamped.orderNo, 'R4821');
  assert.equal(ticketMeta({ meta: stamped }).orderNo, 'R4821');
  const till = buildTicketMeta({ channel: 'till', orderType: 'takeaway', orderRef: 'R32635' });
  assert.equal(ticketMeta({ meta: till }).orderNo, '35');
});

test('venueBusinessDayStart: the venue clock, not the device clock, and DST correct', () => {
  const iso = (d) => d.toISOString();
  // London in summer (BST, UTC+1). 06:30 local is 05:30Z, the day started at 06:00 local = 05:00Z.
  assert.equal(iso(venueBusinessDayStart(Date.parse('2026-09-14T05:30:00Z'), 'Europe/London', '06:00')), '2026-09-14T05:00:00.000Z');
  // 05:59 local is still yesterday's trading day.
  assert.equal(iso(venueBusinessDayStart(Date.parse('2026-09-14T04:59:00Z'), 'Europe/London', '06:00')), '2026-09-13T05:00:00.000Z');
  // London in winter (GMT).
  assert.equal(iso(venueBusinessDayStart(Date.parse('2026-12-01T07:00:00Z'), 'Europe/London', '06:00')), '2026-12-01T06:00:00.000Z');
  // New York (EDT, UTC-4), midnight start.
  assert.equal(iso(venueBusinessDayStart(Date.parse('2026-09-14T16:00:00Z'), 'America/New_York', '00:00')), '2026-09-14T04:00:00.000Z');
  // Missing settings fall back to London 06:00.
  assert.equal(iso(venueBusinessDayStart(Date.parse('2026-09-14T05:30:00Z'))), '2026-09-14T05:00:00.000Z');
  assert.throws(() => venueBusinessDayStart(Date.now(), 'Not/AZone'));
});
