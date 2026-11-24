/**
 * tableChecks.js: the rules for more than one check on a table (T6, T6.2, T6.3).
 * Peter, Provo, 24 Nov 2026: "how do we open another check on the same table?"
 *
 * A second check is a child table: id `<parent>-<n>`, label `<parent label>.<n>`, parentId set.
 * It is never drawn on the floor plan; staff reach it through its parent table.
 *
 * Three rules live here so the store, the floor plan and the till agree:
 *
 *   1. The number of a new check is the lowest one not in use. Counting the children (the old
 *      rule) gave a number already taken once an earlier check had been paid: with T6.2 paid and
 *      T6.3 still open, the next check was numbered 3 again and landed on T6.3's id.
 *   2. Paying or closing the first check never takes the other checks with it. The old rule
 *      dropped every child when the parent closed, so an unpaid T6.2 left the floor when T6 paid.
 *   3. A table whose first check is closed but which still holds an open check is not free. It
 *      reads as occupied and its checks stay one tap away.
 *
 * Pure, import free, so node:test can load it (tableChecks.test.js).
 */

/** The lines still on a check (a voided line is not on it). */
export function liveItems(session) {
  return Array.isArray(session?.items) ? session.items.filter(i => i && !i.voided) : [];
}

/** True when the table holds a check with at least one line still on it. */
export function hasLiveItems(table) {
  return liveItems(table?.session).length > 0;
}

/** The other checks open on a table: its children that hold a session. */
export function openChecksOf(tables, parentId) {
  if (!parentId || !Array.isArray(tables)) return [];
  return tables.filter(t => t && t.parentId === parentId && t.session);
}

/** The id and label a table's check number n takes. */
export function checkIdFor(parentId, n) {
  return `${parentId}-${n}`;
}
export function checkLabelFor(parentLabel, n) {
  return `${parentLabel}.${n}`;
}

/**
 * The number the next check on this table takes: the lowest from 2 up whose id is not in use.
 * Every table is looked at, not only the children, so an id held by anything is never reused.
 */
export function nextCheckNumber(tables, parentId) {
  const used = new Set((Array.isArray(tables) ? tables : []).map(t => t?.id));
  let n = 2;
  while (used.has(checkIdFor(parentId, n))) n += 1;
  return n;
}

/**
 * The tables after one check leaves the floor (paid, closed, or closed on a card reader).
 *
 *   A child check: it is removed. Its parent is freed only when no other check is left on the
 *   table and the parent itself holds no lines (the rule the store always had).
 *
 *   A first check (the parent): the table's own check is cleared. Every other check that still
 *   holds lines STAYS, under the same parent. A check with nothing on it goes with the parent.
 *
 * A table that is not there is a no-op (the same array comes back).
 */
export function afterCheckDropped(tables, tableId) {
  const list = Array.isArray(tables) ? tables : [];
  const table = list.find(t => t?.id === tableId);
  if (!table) return list;

  if (table.parentId) {
    const remaining = list.filter(t => t.id !== tableId);
    const parent = remaining.find(t => t.id === table.parentId);
    const childIds = (parent?.childIds || []).filter(id => id !== tableId);
    return remaining.map(t => {
      if (t.id !== table.parentId) return t;
      if (childIds.length === 0 && !hasLiveItems(parent)) return { ...t, status: 'available', session: null, childIds: [] };
      return { ...t, childIds };
    });
  }

  const children = list.filter(t => t.parentId === tableId);
  const kept = new Set(children.filter(hasLiveItems).map(t => t.id));
  const gone = new Set(children.filter(t => !kept.has(t.id)).map(t => t.id));
  // childIds can name a check this device no longer holds; those go too.
  return list
    .filter(t => !gone.has(t.id))
    .map(t => (t.id === tableId ? { ...t, status: 'available', session: null, childIds: [...kept] } : t));
}

/**
 * What the floor shows for a table. A table with no check of its own that still holds another
 * open check reads 'occupied'; anything else keeps its own status.
 */
export function floorStatus(table, tables) {
  if (!table) return 'available';
  if (!table.session && !table.parentId && openChecksOf(tables, table.id).length > 0) return 'occupied';
  return table.status;
}

/**
 * The checks staff can pick from on a table: its own (when it has one) and then the others, in
 * check number order.
 */
export function checksToPick(tables, parent) {
  if (!parent) return [];
  const num = (t) => { const m = /-(\d+)$/.exec(String(t.id)); return m ? Number(m[1]) : 0; };
  const others = openChecksOf(tables, parent.id).sort((a, b) => num(a) - num(b));
  return parent.session ? [parent, ...others] : others;
}

/**
 * Where a new check goes when staff press Send or Pay, decided at that moment (the table may
 * have been paid on another till since New check was tapped):
 *   { action: 'split', tableId }   the table still holds a check: a separate check beside it
 *   { action: 'seat',  tableId }   the table is free again: the order seats it as its first check
 *   null                           the table is gone: the order stays a walk in
 */
export function newCheckTarget(tables, tableId) {
  const list = Array.isArray(tables) ? tables : [];
  const parent = list.find(t => t?.id === tableId && !t.parentId);
  if (!parent) return null;
  if (parent.session || openChecksOf(list, parent.id).length > 0) return { action: 'split', tableId: parent.id };
  return { action: 'seat', tableId: parent.id };
}
