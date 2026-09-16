// src/lib/kds/kdsTicket.js
//
// Kitchen display: the pure rules behind a ticket card (v5.8.66 redesign).
// No React, no Supabase, so every rule here is tested in kdsTicket.test.js.
//
// ── THE DATA GAP THIS CLOSES ──────────────────────────────────────────────────
// Before v5.8.66 a kds_tickets row had no order type, no till name, no order number
// and no customer name of its own. Everything was squashed into table_label:
//   "Takeaway · Peter Roberts"   walk in with a name (sendToKitchen)
//   "dine-in"                     walk in with no name
//   "Bar · Neil"                  bar tab round (addRoundToTab)
//   "Kiosk R17" / "Online OL-X" / "HubRise HR-x" / "QR R4"  (routeKioskOrderPrints)
//   "Catering CA-5BEPG"           (catering-release edge function)
//   "Drive thru · Peter"          drive thru walk in with a name (16 Sep 2026, same writer).
//                                 A bare "drive-thru" (no name) is typed from meta ONLY: a
//                                 till on new code always stamps it, and a floor table can
//                                 be named "Drive thru", which must stay a table card.
//   "T1" / "Table t1.2" / "Petes Office Desk"   a table
// The writers now also stamp kds_tickets.meta (see buildTicketMeta). A row with no
// meta (written before the column existed, by a till still running old code, or
// replayed from the offline queue) is read back by parseLegacyTicket below.
//
// ⚠ table_label keeps its old format on purpose: fireCourse finds a table's tickets
// with .eq('table_label', table.label). Never change what goes in that column.

import { resolveLocalDateTime } from '../openingHours.js';

/**
 * Order type colours and labels. Delivery is Peter's fifth type (14 Sep 2026), drive thru
 * the sixth (16 Sep 2026). Drive thru is blue: nothing else on the board is blue, so it
 * reads apart from the five type colours and from the green / orange / red time status.
 */
export const KDS_TYPES = {
  dineinName:  { key: 'dineinName',  label: 'DINE-IN',    c: '#4ADE80', legend: 'Dine-in — name' },
  dineinTable: { key: 'dineinTable', label: 'DINE-IN',    c: '#2DD4BF', legend: 'Dine-in — table' },
  takeaway:    { key: 'takeaway',    label: 'TAKEAWAY',   c: '#F5A524', legend: 'Takeaway' },
  collection:  { key: 'collection',  label: 'COLLECTION', c: '#B08BFA', legend: 'Collection' },
  delivery:    { key: 'delivery',    label: 'DELIVERY',   c: '#F472B6', legend: 'Delivery' },
  drivethru:   { key: 'drivethru',   label: 'DRIVE THRU', c: '#60A5FA', legend: 'Drive thru' },
};
export const KDS_TYPE_KEYS = Object.keys(KDS_TYPES);

export const KDS_STATUS = {
  ok:      { key: 'ok',      label: 'ON TIME', c: '#4ADE80', bg: 'rgba(74,222,128,.13)' },
  caution: { key: 'caution', label: 'CAUTION', c: '#F5A524', bg: 'rgba(245,165,36,.14)' },
  late:    { key: 'late',    label: 'LATE',    c: '#FF6B6B', bg: 'rgba(255,107,107,.15)' },
};

/** Channel refs that the legacy label carries after a word: "Kiosk R17". */
const CHANNEL_WORDS = { kiosk: 'kiosk', online: 'online', qr: 'qr', hubrise: 'hubrise', catering: 'catering' };
/** The till name shown for orders that did not come from a till. */
export const CHANNEL_SOURCE = { kiosk: 'Kiosk', online: 'Online', qr: 'QR', hubrise: 'HubRise', catering: 'Catering' };

const clean = (v) => {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
  return s || null;
};
// Notes keep their line breaks: each line tidied, blank lines dropped.
const cleanNote = (v) => {
  const s = v == null ? '' : String(v).split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return s || null;
};

/**
 * 'Dine in' / 'eat_in' / 'TAKEOUT' / 'pickup' / 'drive_thru' → the five order type keys, else null.
 * Everything but letters is stripped first, so 'drive-thru', 'drive thru', 'drive_thru',
 * 'driveThru' and 'drivethru' all land on the same case, and 'drive-through' on the next.
 */
export function normaliseOrderType(type) {
  switch (String(type ?? '').toLowerCase().replace(/[^a-z]/g, '')) {
    case 'dinein': case 'eatin': case 'counter': return 'dine-in';
    case 'takeaway': case 'takeout': return 'takeaway';
    case 'collection': case 'collect': case 'pickup': return 'collection';
    case 'delivery': return 'delivery';
    case 'drivethru': case 'drivethrough': return 'drive-thru';
    default: return null;
  }
}

/**
 * 'R32635' → '35', the number printed on the receipt as ORDER # 35.
 * Same rule as shortOrderRef in src/lib/db.js (kept in step by a test), copied here
 * so this file stays free of the Supabase client.
 */
export function shortRef(ref) {
  if (typeof ref !== 'string') return ref == null ? null : String(ref);
  const m = /^R(\d+)$/.exec(ref);
  if (!m) return ref;
  return m[1].length > 2 ? m[1].slice(-2) : m[1];
}

/**
 * What a writer stamps into kds_tickets.meta. Every field is optional.
 *   channel     'table' | 'till' | 'bar' | 'kiosk' | 'online' | 'qr' | 'hubrise' | 'catering'
 *   orderType   raw order type, normalised here
 *   isTable     true when the ticket belongs to a table (table orders, QR at a table)
 *   customerName, orderRef (full ref, shortened here for display), appCode (delivery app
 *   code, wins over the ref), source (till name), staff, note (order level kitchen note)
 */
export function buildTicketMeta({ channel, orderType, isTable = false, customerName, orderRef, appCode, source, staff, note } = {}) {
  const ch = clean(channel);
  const table = !!isTable || ch === 'table';
  // Tables show no number (Peter, 14 Sep 2026). Bar tabs have no order number either.
  const orderNo = table || ch === 'bar' ? null : (clean(appCode) || clean(shortRef(clean(orderRef))));
  return {
    v: 1,
    channel: ch,
    orderType: table || ch === 'bar' ? 'dine-in' : normaliseOrderType(orderType),
    isTable: table,
    customerName: clean(customerName),
    orderNo,
    source: clean(source),
    staff: clean(staff),
    note: cleanNote(note),
  };
}

/** Join an order note and a customer note without repeating the same words twice. */
export function joinNotes(...notes) {
  const seen = new Set();
  const out = [];
  for (const n of notes) {
    const s = cleanNote(n);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out.length ? out.join('\n') : null;
}

/**
 * Read a row written with no meta. Returns the same shape as buildTicketMeta, with
 * orderType null where the label cannot say (kiosk, online, HubRise, catering). The
 * screen fills those from order_queue by ref (see needsTypeLookup) and then falls
 * back to fallbackTypeForChannel.
 */
export function parseLegacyTicket(row) {
  const label = clean(row?.table_label ?? row?.table) || '';
  const server = clean(row?.server);

  // The till writes the type label and a name ("Takeaway · Sam", "Drive thru · Peter"); a
  // hand typed "Drive-thru · Peter" or "Drive through · Peter" reads the same way.
  let m = /^(takeaway|collection|delivery|dine[- ]?in|eat[- ]?in|counter|drive[- ]?thru|drive[- ]?through)\s*·\s*(.+)$/i.exec(label);
  if (m) {
    return { ...buildTicketMeta({ channel: 'till', orderType: m[1], customerName: m[2], staff: server }), legacy: true };
  }
  // Bare labels with no name. Drive thru is NOT here on purpose: a till on new code always
  // stamps meta for its bare "drive-thru", so a no meta row reading "Drive thru" is a floor
  // table of that name and must stay a table card.
  m = /^(takeaway|collection|delivery|dine[- ]?in|eat[- ]?in)$/i.exec(label);
  if (m) {
    return { ...buildTicketMeta({ channel: 'till', orderType: m[1], staff: server }), legacy: true };
  }
  m = /^Bar\s*·\s*(.+)$/i.exec(label);
  if (m) {
    return { ...buildTicketMeta({ channel: 'bar', customerName: m[1], staff: server }), legacy: true };
  }
  m = /^(Kiosk|Online|QR|HubRise|Catering)\s+(\S+)$/i.exec(label);
  if (m) {
    const channel = CHANNEL_WORDS[m[1].toLowerCase()];
    // routeKioskOrderPrints wrote the customer name into `server`, or the label again
    // when there was no name. catering-release writes the name (or 'Catering').
    const name = server && server !== label && server.toLowerCase() !== 'catering' ? server : null;
    return {
      ...buildTicketMeta({ channel, customerName: name, orderRef: m[2], source: CHANNEL_SOURCE[channel] }),
      orderType: null, orderRef: m[2], legacy: true,
    };
  }
  // Anything else is a table label ("T1", "Table t1.2", "Petes Office Desk"). QR
  // orders at a table were written as "Table T5", which reads correctly as a table.
  return { ...buildTicketMeta({ channel: 'table', staff: server }), legacy: true, tableLabel: label || null };
}

/** The ticket's meta: stamped by a writer when present, otherwise read from the label. */
export function ticketMeta(row) {
  const raw = row?.meta;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.v) {
    // orderNo was already shortened by the writer. Pass it through as-is (as appCode), or a
    // delivery app code shaped like "R4821" would be shortened a second time to "21".
    return buildTicketMeta({ ...raw, orderRef: null, appCode: raw.orderNo });
  }
  return parseLegacyTicket(row);
}

/** A legacy channel ticket whose type is only known to order_queue. */
export function needsTypeLookup(meta) {
  return !!(meta?.legacy && !meta.orderType && meta.orderRef);
}

/** Used only when order_queue has no row for a legacy channel ticket. */
export function fallbackTypeForChannel(channel) {
  if (channel === 'hubrise') return 'delivery';
  if (channel === 'online' || channel === 'catering') return 'collection';
  return 'dine-in';
}

/** Six board types from an order type and whether it is a table. */
export function kdsTypeKey(meta) {
  if (meta?.isTable) return 'dineinTable';
  switch (meta?.orderType || fallbackTypeForChannel(meta?.channel)) {
    case 'takeaway': return 'takeaway';
    case 'collection': return 'collection';
    case 'delivery': return 'delivery';
    case 'drive-thru': return 'drivethru';
    default: return 'dineinName';
  }
}

/**
 * The big line. A table shows its table label. Anything else shows the customer name,
 * or the order number when there is no name (Peter, 14 Sep 2026), or Walk-in when an
 * old ticket has neither.
 */
export function ticketHeadline(meta, tableLabel) {
  if (meta?.isTable) return clean(tableLabel) || 'Table';
  if (meta?.customerName) return meta.customerName;
  if (meta?.orderNo) return `#${meta.orderNo}`;
  return 'Walk-in';
}

/**
 * The identity line under the badge: "Till 2  |  #35".
 * The number drops when it is already the headline, the till name drops when the
 * POS name switch is off. Two spaces, a pipe, two spaces (design spec).
 */
export function identityLine(meta, headline, opts = {}) {
  return identityParts(meta, headline, opts).join('  |  ');
}

/** The same segments as identityLine, for a renderer that keeps each one unbroken. */
export function identityParts(meta, headline, { showSource = true } = {}) {
  const num = meta?.orderNo ? `#${meta.orderNo}` : null;
  return [
    showSource ? meta?.source : null,
    num && num !== headline ? num : null,
  ].filter(Boolean);
}

/** mods arrive as strings from the till but as objects from catering (v5.5.913). */
export const modText = (m) => String(m?.name ?? m?.label ?? m ?? '').trim();

/**
 * One order line for the board. The till packs allergens into mods as "⚠ MILK · GLUTEN"
 * and item notes as "📝 No cheese". Allergens come out into their own line (design
 * spec). Item notes stay in the modifier list exactly as today (Peter: leave as is).
 */
export function ticketLine(item, index) {
  const all = (Array.isArray(item?.mods) ? item.mods : (item?.mods ? [item.mods] : []))
    .map(modText).filter(Boolean);
  const allergens = [];
  const mods = [];
  for (const t of all) {
    if (t.startsWith('⚠')) allergens.push(t.replace(/^⚠\s*/, ''));
    else mods.push(t);
  }
  if (Array.isArray(item?.allergens)) {
    for (const a of item.allergens) { const s = clean(a); if (s) allergens.push(s.toUpperCase()); }
  }
  return {
    index,
    qty: Number(item?.qty) || 0,
    name: String(item?.name || 'Item'),
    mods,
    allergen: allergens.length ? allergens.join(' · ') : null,
    course: item?.course ?? 1,
    bumped: !!item?._bumped,
    voided: !!item?.voided,
  };
}

const COURSE_LABEL = { 0: 'Immediate', 1: 'Course 1', 2: 'Course 2', 3: 'Course 3' };

/**
 * Items grouped by course, firing courses first, each with its chip text:
 * "COURSE 1 — FIRING", "COURSE 2 — HOLD", "IMMEDIATE — FIRING". Voided lines are
 * left off the board.
 */
export function courseGroups(items, firedCourses) {
  const fired = Array.isArray(firedCourses) && firedCourses.length ? firedCourses : [0, 1];
  const lines = (Array.isArray(items) ? items : []).map(ticketLine).filter(l => !l.voided);
  const byCourse = new Map();
  for (const l of lines) {
    if (!byCourse.has(l.course)) byCourse.set(l.course, []);
    byCourse.get(l.course).push(l);
  }
  const groups = [...byCourse.entries()].map(([course, ls]) => {
    const firing = fired.includes(course);
    const name = (COURSE_LABEL[course] || `Course ${course}`).toUpperCase();
    return { course, firing, label: `${name} — ${firing ? 'FIRING' : 'HOLD'}`, lines: ls };
  });
  return [
    ...groups.filter(g => g.firing).sort((a, b) => a.course - b.course),
    ...groups.filter(g => !g.firing).sort((a, b) => a.course - b.course),
  ];
}

/** Whole minutes since sent. An unknown or future time reads as 0, never NaN (v5.5.914). */
export function minutesSince(sentAt, now) {
  const ts = sentAt instanceof Date ? sentAt.getTime()
    : typeof sentAt === 'string' ? new Date(sentAt).getTime() : Number(sentAt);
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - ts) / 60000));
}

/** '7m', '1h 5m'. */
export function formatElapsed(mins) {
  const m = Math.max(0, Math.floor(Number(mins) || 0));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** Time status against the two per screen thresholds. */
export function statusOf(mins, caution, late) {
  if (mins >= late) return KDS_STATUS.late;
  if (mins >= caution) return KDS_STATUS.caution;
  return KDS_STATUS.ok;
}

/** Oldest first. With heldToEnd, held tickets go after every live one, oldest first. */
export function sortTickets(tickets, { heldToEnd = true } = {}) {
  const key = (t) => (Number.isFinite(t?.sentAt) ? t.sentAt : 0);
  return [...(tickets || [])].sort((a, b) => {
    if (heldToEnd && !!a.held !== !!b.held) return a.held ? 1 : -1;
    return key(a) - key(b);
  });
}

/** Header pills: All first, then each type. A zero count is hidden unless it is the active filter. */
export function typeCounts(tickets, activeFilter = 'all') {
  const list = tickets || [];
  const all = { key: 'all', label: 'All', c: '#E6ECE9', count: list.length };
  const perType = KDS_TYPE_KEYS.map(k => ({
    key: k, label: KDS_TYPES[k].legend, c: KDS_TYPES[k].c,
    count: list.filter(t => t.typeKey === k).length,
  }));
  return [all, ...perType.filter(p => p.count > 0 || p.key === activeFilter)];
}

/**
 * TO MAKE: everything still to cook on the visible board.
 * Split by modifiers (Peter kept today's rule), quantities summed, largest first.
 * Skips held tickets (Peter, 14 Sep 2026), items already ticked, voided lines, and
 * courses that are not fired yet. Allergen and note lines are part of the key, so an
 * allergy order is never merged into a plain one.
 */
export function rollUp(tickets) {
  const map = new Map();
  for (const tk of tickets || []) {
    if (tk.held) continue;
    const fired = Array.isArray(tk.firedCourses) && tk.firedCourses.length ? tk.firedCourses : [0, 1];
    (tk.items || []).forEach((it, i) => {
      const line = ticketLine(it, i);
      if (line.bumped || line.voided) return;
      if (!fired.includes(line.course)) return;
      const detail = [...line.mods, ...(line.allergen ? [`⚠ ${line.allergen}`] : [])];
      const key = line.name + '||' + detail.slice().sort().join('~');
      const row = map.get(key);
      if (row) row.qty += line.qty;
      else map.set(key, { key, name: line.name, mods: detail, qty: line.qty });
    });
  }
  // Ties: by name, then the plain line before its modified versions, so the list never
  // reshuffles between two renders of the same board.
  return [...map.values()].sort((a, b) =>
    b.qty - a.qty || a.name.localeCompare(b.name) || a.mods.length - b.mods.length || a.key.localeCompare(b.key));
}

/**
 * Fill a legacy channel ticket from its order_queue row (type, name, delivery app code
 * and channel). A missing row leaves the meta as it was; kdsTypeKey then uses
 * fallbackTypeForChannel.
 */
export function applyQueueLookup(meta, queueRow) {
  if (!needsTypeLookup(meta) || !queueRow) return meta;
  const c = queueRow.customer && typeof queueRow.customer === 'object' ? queueRow.customer : {};
  const hub = meta.channel === 'hubrise';
  return {
    ...meta,
    orderType: normaliseOrderType(queueRow.type) || normaliseOrderType(c.serviceType) || null,
    customerName: meta.customerName || clean(c.name),
    orderNo: (hub && clean(c.collectionCode)) || meta.orderNo,
    source: (hub && clean(c.channel)) || meta.source,
    note: meta.note || cleanNote(c.notes),
  };
}

/**
 * Everything a card needs that does not change second to second.
 *   row      a mapped ticket { id, table, server, covers, sentAt, items, firedCourses, held, meta }
 *   queueRow the order_queue row for a legacy channel ticket, when known
 */
export function ticketView(row, queueRow = null) {
  const meta = applyQueueLookup(row?.meta || parseLegacyTicket(row), queueRow);
  const typeKey = kdsTypeKey(meta);
  const headline = ticketHeadline(meta, row?.table);
  const covers = Number(row?.covers) || 0;
  return {
    ...row,
    meta,
    typeKey,
    type: KDS_TYPES[typeKey],
    headline,
    // Covers show when there is more than one, as before (walk ins are written as 1).
    coversLabel: covers > 1 ? `${covers} cv` : null,
    staff: meta.staff,
    note: meta.note,
    groups: courseGroups(row?.items, row?.firedCourses),
  };
}

/**
 * The start of the venue's trading day as a real instant: businessDayStart ("06:00") on
 * the venue's own clock, yesterday's if that time has not come yet today.
 * Used by History (today only) and Recall last. Replaces getBusinessDayStart from
 * locationTime.js for the KDS: that helper reads the date in the DEVICE's time zone and
 * applies the venue offset with the wrong sign, so a London venue's day started at 07:00
 * in summer and History was empty from 06:00 to 07:00 (found in review, 14 Sep 2026).
 * An unknown time zone throws; the caller falls back.
 */
export function venueBusinessDayStart(now, timeZone, businessDayStart = '06:00') {
  const tz = timeZone || 'Europe/London';
  const [h, m] = String(businessDayStart || '06:00').split(':').map(Number);
  const startMin = (Number.isFinite(h) ? h : 6) * 60 + (Number.isFinite(m) ? m : 0);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(now))) parts[p.type] = p.value;
  const nowMin = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  let day = `${parts.year}-${parts.month}-${parts.day}`;
  if (nowMin < startMin) {
    day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - 1)).toISOString().slice(0, 10);
  }
  return resolveLocalDateTime(day, startMin, tz);
}
