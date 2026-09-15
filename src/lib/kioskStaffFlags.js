/**
 * kioskStaffFlags.js: what staff see for a kiosk order (decision 16 and the table rule).
 *
 *   Alcohol: an order with an item from a Challenge 21 alcohol category (or any category
 *   under one) is marked CHECK ID for staff to check at handover. The customer is only told.
 *   Table: the kiosk table number reaches the kitchen ticket and the order screens.
 *
 * Every non kiosk order keeps exactly today's ticket labels (kioskTicketLabels, tested).
 *
 * Pure: no imports, so node:test can load it (kioskStaffFlags.test.js).
 */

const parentOf = (c) => (c ? (c.parent_id ?? c.parentId ?? null) : null);

/**
 * The ticked alcohol category ids plus every category below them.
 * categories: menu_categories rows (parent_id) or store rows (parentId).
 */
export function alcoholCategorySet(ids, categories) {
  const set = new Set((Array.isArray(ids) ? ids : []).filter(v => v != null && v !== ''));
  if (!set.size) return set;
  const list = Array.isArray(categories) ? categories.filter(Boolean) : [];
  let grew = true;
  // Walk down until nothing new joins (a cycle in bad data cannot loop forever: each pass
  // must add an id, and there are finitely many).
  while (grew) {
    grew = false;
    for (const c of list) {
      const p = parentOf(c);
      if (c.id != null && p != null && set.has(p) && !set.has(c.id)) {
        set.add(c.id);
        grew = true;
      }
    }
  }
  return set;
}

function lineCats(line) {
  const out = [];
  if (!line) return out;
  const src = line.item && typeof line.item === 'object' ? line.item : line;
  if (src.cat != null) out.push(src.cat);
  if (Array.isArray(src.cats)) out.push(...src.cats);
  if (line.parentCat != null) out.push(line.parentCat);
  return out;
}

/**
 * True when any line is alcohol.
 *   lines: kiosk basket lines ({ item: { cat, cats }, modsArray }) or order items
 *          ({ id, itemId, parentId, cat, mods }). A size line carries its parent's category.
 *   set:   alcoholCategorySet(...)
 *   itemsById: optional Map (or object) of menu rows. With it, a picked modifier linked to an
 *          alcohol item (mod.itemId) counts, and an order item is also checked against its own
 *          menu row and its parent's row (order items carry only `cat`, so an item that is
 *          alcohol only through `cats` is still found). The kiosk and the staff ticket pass
 *          the same kind of menu rows, so the customer and staff answers agree.
 */
export function orderHasAlcohol(lines, set, itemsById) {
  if (!(set instanceof Set) || set.size === 0) return false;
  const lookup = (id) => {
    if (!itemsById || id == null) return null;
    if (itemsById instanceof Map) return itemsById.get(id) || null;
    return itemsById[id] || null;
  };
  for (const line of (Array.isArray(lines) ? lines : [])) {
    if (!line || line.voided) continue;
    if (lineCats(line).some(c => set.has(c))) return true;
    if (!(line.item && typeof line.item === 'object')) {
      for (const id of [line.parentId, line.itemId, line.id]) {
        const row = lookup(id);
        if (row && lineCats(row).some(c => set.has(c))) return true;
      }
    }
    const mods = Array.isArray(line.modsArray) ? line.modsArray : (Array.isArray(line.mods) ? line.mods : []);
    for (const m of mods) {
      const row = m && typeof m === 'object' ? lookup(m.itemId) : null;
      if (row && lineCats(row).some(c => set.has(c))) return true;
    }
  }
  return false;
}

/** db.js shortOrderRef, mirrored so this file stays import free: 'R1247' gives '47'. */
export function kioskShortRef(ref) {
  if (typeof ref !== 'string') return ref;
  const m = /^R(\d+)$/.exec(ref);
  if (!m) return ref;
  return m[1].length > 2 ? m[1].slice(-2) : m[1];
}

/** The flag staff read on a kiosk order with alcohol (decision 16). */
export const KIOSK_CHECK_ID = 'CHECK ID';

/**
 * The kiosk table staff are told about: only on an eat in order ('dine-in', the order type
 * routeKioskOrderPrints resolves). Today's kiosk keeps a table typed before the customer went
 * Back and picked Take away, and submitOrder still saves it on the order
 * (closed_checks.kiosk_table_number), so a take away (or an order of unknown type) must never
 * become a table ticket, a Table badge or a table headline. Returns the trimmed table or null.
 */
export function kioskTableForTicket(kioskTable, orderType) {
  if (orderType !== 'dine-in') return null;
  const table = kioskTable == null ? '' : String(kioskTable).trim();
  return table || null;
}

/**
 * The order level kitchen note a KDS screen shows. With the screen's Kitchen notes switch on,
 * the whole note. With it off, only the CHECK ID line a kiosk order with alcohol carries (it
 * leads the note, joinNotes(CHECK ID, notes)), so staff on every screen see the ID check.
 * Returns the text to show, or null.
 */
export function kdsVisibleNote(note, notesOn) {
  if (typeof note !== 'string' || !note.trim()) return null;
  if (notesOn) return note;
  const first = note.split('\n')[0].trim();
  return first === KIOSK_CHECK_ID ? KIOSK_CHECK_ID : null;
}

/**
 * The kitchen labels for a channel order, for all three places staff read them:
 *   tableLabel, serverName             the kds_tickets row (table_label, server)
 *   printTableLabel, printServerName   the printed kitchen ticket (header, Server line)
 *   isTable, flagNote                  what kds_tickets.meta needs (v5.8.66 KDS redesign)
 *
 * Not kiosk: exactly today's values. The row and the paper are the same strings, isTable is
 * QR at a table (as routeKioskOrderPrints has stamped it since v5.8.66) and there is no flag.
 *
 * Kiosk, ONE rule for the paper, the KDS meta and the KDS reader of rows without meta:
 *   1. The number, not a name (decision 8). Every kiosk ticket carries the short number the
 *      customer holds, "#47" (db.js shortOrderRef; the KDS shortens a full ref the same way).
 *      The new design never collects a name, so its tickets are headed by the number. A name
 *      typed on the current design is shown the way the KDS redesign shows any name, with the
 *      number beside it, never in place of it.
 *   2. A kiosk table on an EAT IN order (orderType 'dine-in', kioskTableForTicket) makes it a table ticket (KDS rule: a table shows its label) labelled with
 *      the table AND the number, "Table 12 · #47": unlike a till table, a kiosk order is still
 *      called by its number. No till table is ever named like that, so fireCourse, which finds a
 *      table's tickets by table_label, can never pick a kiosk ticket up.
 *   3. CHECK ID (decision 16) is the KDS note (flagNote) and goes on the paper Server line.
 *   4. The row keeps what src/lib/kds/kdsTicket.js parseLegacyTicket reads (a ticket saved
 *      before kds_tickets.meta exists, or retried without it, is read from the row alone):
 *      with no table the label stays "Kiosk R1247", the FULL ref, which the KDS shortens to #47
 *      and uses to look the order type up in order_queue (a short "Kiosk 47" would find no
 *      order and every kiosk takeaway would show as dine in); server stays the name, or the
 *      label again when there is none. With CHECK ID the server is "#47 · CHECK ID" (or the
 *      name and CHECK ID), which that reader shows as the headline, so the flag is never lost.
 */
export function kioskTicketLabels({ source, ref, srcLabel, qrTableLabel, kioskTable, orderType, customerName, idCheck } = {}) {
  const fallback = `${srcLabel} ${ref}`;
  if (source !== 'kiosk') {
    const tableLabel = source === 'qr' && qrTableLabel ? `Table ${qrTableLabel}` : fallback;
    const serverName = customerName || fallback;
    return {
      tableLabel,
      serverName,
      printTableLabel: tableLabel,
      printServerName: serverName,
      isTable: source === 'qr' && !!qrTableLabel,
      flagNote: null,
    };
  }
  const number = `#${kioskShortRef(ref)}`;
  const table = kioskTableForTicket(kioskTable, orderType) || '';
  const name = customerName == null ? '' : String(customerName).trim();
  const tableTicket = table ? `Table ${table} · ${number}` : null;
  return {
    tableLabel: tableTicket || fallback,
    // No flag: byte for byte what routeKioskOrderPrints wrote before (customer name or the label).
    serverName: idCheck ? `${name || number} · ${KIOSK_CHECK_ID}` : (customerName || fallback),
    printTableLabel: tableTicket || `${srcLabel} ${number}`,
    printServerName: (name || `${srcLabel} ${number}`) + (idCheck ? ` · ${KIOSK_CHECK_ID}` : ''),
    isTable: !!table,
    flagNote: idCheck ? KIOSK_CHECK_ID : null,
  };
}
