// The ORDER's declared allergies (26 Sep 2026, allergy v4).
//
// Peter, 26 Sep 2026 (Coffee Boy Leeds, none of 454 products carries allergen data): "even if
// allergies are not on products, when allergies are selected it should come up on the KDS and
// the ticket printed". v3 stamped the till's global Allergen filter onto each line as it was
// rung. The review of v3 found the flaw in that: the filter belongs to the DEVICE, the stamp
// belonged to the LINE, and neither was the order. A wrongly tapped chip stayed on lines rung
// under it, and a filter left on after one order leaked into the next. So the declaration now
// belongs to the ORDER, in one field per kind of order:
//   table session   session.declaredAllergens      rides the active_sessions jsonb, so it
//                                                   survives reopen, reload, other tills and
//                                                   every round
//   walk in         walkInOrder.declaredAllergens  and its order_queue row (customer jsonb,
//                                                   see queueCustomerWithDeclared)
//   bar tab         tab.declaredAllergens          on this till, and each round records it in
//                                                   bar_tabs.rounds (the only jsonb bar_tabs has)
//   scheduled       entry.declaredAllergens        its order_queue row, like a walk in
// The till's Allergen chips (store.allergens) EDIT the declaration of the order on screen
// (withDeclaration) and are LOADED from it whenever a different order comes on screen
// (followOrderOnScreen), so nothing carries over from one order to the next. The kitchen gets
// the order's declaration and nothing else: never the attached customer's saved list on top, so
// Clear all always works. Additive and optional: an order without the field declares nothing.
//
// v5 (26 Sep 2026, the review of v4):
//   - A walk in with nothing rung yet gets its order object on the first tap (withDeclaration),
//     so an allergy declared before the first item survives a trip to the Bar, a table or back.
//   - "Attach once" is judged against the guests whose profile THIS ORDER already took
//     (order.attachedProfiles), never the till's global customer, which follows staff from a
//     table onto the next walk in. The same record says what each attach ADDED, so taking the
//     wrong customer off removes exactly that and never an allergy staff declared themselves.
//   - An allergy declared after the kitchen has the order reaches it: order.kitchenAllergens is
//     what the kitchen holds, and kitchenAllergyUpdate says what it is missing (the store sends
//     an ALLERGY UPDATE docket and updates the open KDS tickets). Only additions travel: an
//     allergy taken off after the send stays with the kitchen, the safe side.
//
// v6 (26 Sep 2026, the review of v5):
//   - The kitchen update found "this order's" tickets by line uid across the whole location, and
//     uids restarted at i1 on every till and every reload, so a late allergy marked ANOTHER
//     guest's KDS ticket red and could list their food instead of this order's. Each send now
//     records its tickets on the order (order.kitchenTickets: the ticket id, its centre, the
//     line uids on it and the allergies it went with) and the update touches only those
//     tickets, by id. A line on no recorded ticket (an order sent before this) is matched by uid
//     AND by the order's own table label or order number (ticketIsOrders; a table's never older
//     than its session), never by uid alone. New line uids are unique per till and page load as
//     well (lineUidMaker).
//   - Each recorded ticket knows what it already carries, so a combine tells the kitchen only
//     about the food that lacks the allergy, and the update docket lists only food still in the
//     kitchen (kitchenUpdatePlan): nothing from a bumped ticket unless its course is still held.
//     A slow kds_tickets read never holds that docket back (the store's KITCHEN_ALLERGY_READ_MS).
//   - An update still waiting when the order leaves the till (paid, cleared, the operator
//     switched, the next order taken) goes at once, and a timer whose order has gone uses the
//     order as the last edit left it (the store), so the kitchen is never left without it.
//   - A reopened walk in knows what the kitchen already holds (reopenedAllergyFields), so its
//     next send, payment or chip tap never re-announces the same allergy.
//   - A table is the order on screen together with its SESSION (sessionKey: its id, or for a QR
//     table's session, which has none, where it came from and when it opened), so a table paid
//     or re-seated on another device reloads the chips, and a chip tap edits the order's
//     declaration, never the chips alone (toggledDeclaration), so it cannot drop an allergy it
//     did not touch.
//
// Pure: the only import is kioskAllergens.js, which imports nothing, so node:test loads this.

import { normaliseAllergenId } from './kioskAllergens.js';

/**
 * Allergen ids from several lists: normalised to the menu editor's ids ('dairy' lands on
 * 'milk'), blanks dropped, each once, in order. A lone id counts as a list of one.
 */
export function allergenIds(...lists) {
  const out = [];
  for (const list of lists) {
    const arr = Array.isArray(list) ? list : (list == null ? [] : [list]);
    for (const raw of arr) {
      const id = normaliseAllergenId(raw);
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** The same allergies, whatever the order or spelling. */
export function sameIds(a, b) {
  const x = allergenIds(a);
  const y = allergenIds(b);
  return x.length === y.length && x.every(id => y.includes(id));
}

/**
 * The allergies an order object declares. An order without the field declares nothing: an old
 * session, or a queue row written before this change. A bar tab read back from bar_tabs (a
 * reload, another till) has no column for it, so its LAST round's record stands in: the
 * declaration that tab's most recent round went to the kitchen with.
 */
export function orderDeclared(order) {
  if (Array.isArray(order?.declaredAllergens)) return allergenIds(order.declaredAllergens);
  const rounds = Array.isArray(order?.rounds) ? order.rounds : [];
  const last = rounds[rounds.length - 1];
  return allergenIds(last?.declaredAllergens);
}

/**
 * Which party a table session is (v6): its id. A session without one (a QR table's, which
 * qrTableSession.js builds with no id) by where it came from and when it opened, so a table
 * with such a session is still a different order from the same table with none, and from the
 * next one. '' for no session.
 */
export function sessionKey(session) {
  if (!session) return '';
  if (session.id != null && session.id !== '') return String(session.id);
  return `${session.source || 'open'}@${session.seatedAt ?? session.openedAt ?? ''}`;
}

/**
 * The order this till has on screen, and the object that holds its declaration (null when that
 * order does not exist yet: a walk in with nothing rung, a table not seated). The Bar's open tab
 * first, but only on the Bar surface (a handheld never opens tabs, so its activeTabId stays
 * null), then the active table, then the walk in. `key` changes exactly when a different order
 * comes on screen. v6: a table's key holds its session (sessionKey), because a new party at the
 * same table is a different order (the review of v5: a table paid or re-seated on another device
 * while this till showed it kept the last party's chips, and the next party printed them).
 */
export function orderOnScreen(state) {
  const s = state || {};
  if (s.surface === 'bar' && s.activeTabId) {
    return { kind: 'tab', key: `tab:${s.activeTabId}`, id: s.activeTabId, holder: (s.tabs || []).find(t => t.id === s.activeTabId) || null };
  }
  if (s.activeTableId) {
    const holder = (s.tables || []).find(t => t.id === s.activeTableId)?.session || null;
    return { kind: 'table', key: `table:${s.activeTableId}:${sessionKey(holder)}`, id: s.activeTableId, holder };
  }
  return { kind: 'walkin', key: 'walkin', id: null, holder: s.walkInOrder || null };
}

/** The chips to show when `state`'s order comes on screen: that order's declaration, [] when it has none. */
export function declarationFor(state) {
  return orderDeclared(orderOnScreen(state).holder);
}

/** Is table `tableId` the order on screen? (v6: the key holds the session too, so compare kind and id.) */
export function tableOnScreen(state, tableId) {
  const on = orderOnScreen(state);
  return on.kind === 'table' && on.id === tableId;
}

/**
 * What goes to the kitchen for `order` at send time: its declaration. The one exception is an
 * order ON SCREEN that does not carry the field yet (a walk in created by a path that did not
 * seed it), where the chips staff are looking at ARE its declaration. The chips are loaded from
 * the order on every switch, so for an old order they read [] until staff tap one.
 */
export function sendDeclared(order, chips, onScreen) {
  if (Array.isArray(order?.declaredAllergens)) return allergenIds(order.declaredAllergens);
  return onScreen ? allergenIds(chips) : orderDeclared(order);
}

/** The declaration of the order on screen, as the kitchen would get it now (the order panel banner). */
export function onScreenDeclared(state) {
  return sendDeclared(orderOnScreen(state).holder, state?.allergens, true);
}

/**
 * A chip tapped: the declaration of the order on screen with `id` added or taken off (v6). It
 * starts from the ORDER's declaration, not the chips: the review of v5 showed a table adopted
 * from another till still showing the old chips, where a tap on Gluten wrote [gluten] and
 * dropped the MILK the order declared. An order without the field (an old session) starts from
 * the chips, which are its declaration then (sendDeclared).
 */
export function toggledDeclaration(state, id) {
  const cur = onScreenDeclared(state);
  const [n] = allergenIds(id);
  if (!n) return cur;
  return cur.includes(n) ? cur.filter(a => a !== n) : [...cur, n];
}

/** The guests whose saved allergies this order already took, and what each one ADDED. */
export function attachedProfiles(order) {
  return Array.isArray(order?.attachedProfiles) ? order.attachedProfiles.filter(e => e && e.guest) : [];
}

/** The part of a customer that says who they are, for order.attachedProfiles (never their whole record). */
export function guestKey(c) {
  const out = {};
  const id = c?.id ?? c?.customerId;
  if (id != null && id !== '') out.id = String(id);
  if (c?.phone) out.phone = String(c.phone);
  if (c?.name) out.name = String(c.name);
  return out;
}

/**
 * The order-side patch that sets the declaration of the order on screen to `next`, and records
 * `attach` (a customer's profile being added) in the same step. Each earlier attach record keeps
 * only the allergies that are still declared and were declared before this edit: an allergy
 * staff cleared, or cleared and tapped again themselves, is theirs from then on, not the
 * profile's, so taking that customer off later never removes it.
 */
function declare(s, on, next, now, newId, attach = null) {
  const h = on.holder;
  const before = h ? orderDeclared(h) : [];
  const kept = attachedProfiles(h).map(e => ({
    ...e, added: allergenIds(e.added).filter(id => next.includes(id) && before.includes(id)),
  }));
  const fields = { declaredAllergens: next, ...((kept.length || attach) ? { attachedProfiles: attach ? [...kept, attach] : kept } : {}) };
  if (on.kind === 'tab') {
    return { tabs: (s.tabs || []).map(t => (t.id === on.id ? { ...t, ...fields } : t)) };
  }
  if (on.kind === 'table') {
    return { tables: (s.tables || []).map(t => (t.id === on.id && t.session ? { ...t, session: { ...t.session, ...fields, lastUpdated: now } } : t)) };
  }
  // The walk in. With nothing rung yet it has no order object, so the first allergy creates one
  // (v5): the chips alone were lost on the next order switch, because the follower reloads the
  // walk in's own declaration when staff come back to it. `newId` is the store's order number.
  const base = h || { ...(typeof newId === 'function' ? { id: newId() } : {}), items: [], subtotal: 0, total: 0 };
  return { walkInOrder: { ...base, ...fields } };
}

/**
 * A staff edit (a chip, Clear all, a customer's saved allergies added): the partial state that
 * sets the chips AND the declaration of the order on screen, together, so the two can never
 * differ. A table session gets lastUpdated like addItem gives it, so the change publishes and
 * wins over an older active_sessions row. The order is left untouched when it already declares
 * exactly these, so a no op never re-publishes the table. v5: a walk in with nothing rung yet
 * gets its order object here (`newId` makes its number), so the declaration outlives an order
 * switch; a table that is not seated yet still has the chips alone until its session exists
 * (seedDeclared hands them over).
 */
export function withDeclaration(state, ids, now = Date.now(), newId = null) {
  const s = state || {};
  const next = allergenIds(ids);
  const patch = { allergens: next };
  const on = orderOnScreen(s);
  const h = on.holder;
  if (!h && (on.kind !== 'walkin' || !next.length)) return patch;
  if (h && Array.isArray(h.declaredAllergens) && sameIds(h.declaredAllergens, next)) return patch;
  return { ...patch, ...declare(s, on, next, now, newId) };
}

/**
 * An order object being created (or written for the first time) as the order on screen (`kind`,
 * and for a table or tab its `id`) takes the chips as its declaration: staff may tap Tree nuts
 * before ringing anything. An order that already carries the field keeps it. When the order is
 * not the one on screen it starts with nothing, never another order's chips.
 */
export function seedDeclared(order, state, kind, id = null) {
  if (Array.isArray(order?.declaredAllergens)) return order;
  const on = orderOnScreen(state);
  const chips = on.kind === kind && (id == null || on.id === id) ? state?.allergens : [];
  return { ...(order || {}), declaredAllergens: allergenIds(chips) };
}

/**
 * `state` with its walk in carrying its declaration (seedDeclared), for parking the counter cart
 * on an operator switch: a parked cart must come back with the allergies it was rung under. The
 * same state object when there is nothing to seed.
 */
export function withSeededCart(state) {
  const wi = state?.walkInOrder;
  if (!wi || Array.isArray(wi.declaredAllergens)) return state;
  return { ...state, walkInOrder: seedDeclared(wi, state, 'walkin') };
}

const lastDigits = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);

/**
 * Is `b` the same guest as `a`? By phone when both have one (the last ten digits, so 07700 900123
 * and +44 7700 900123 match; the phone is who a customer IS here, upsertCustomer keys on it, and
 * the same person can carry a local cache id and a database id), else by customer id when both
 * have one, else by name when neither has a phone.
 */
export function sameGuest(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = lastDigits(a.phone);
  const pb = lastDigits(b.phone);
  if (pa && pb) return pa === pb;
  const ida = a.id ?? a.customerId;
  const idb = b.id ?? b.customerId;
  if (ida != null && ida !== '' && idb != null && idb !== '') return String(ida) === String(idb);
  if (pa || pb) return false;
  return !!a.name && String(a.name).trim().toLowerCase() === String(b.name || '').trim().toLowerCase();
}

/** Has this order already taken `c`'s saved allergies? (order.attachedProfiles, v5) */
export function profileTaken(order, c) {
  return !!c && attachedProfiles(order).some(e => sameGuest(e.guest, c));
}

/**
 * Attaching customer `c`: their saved allergies are ADDED to the order's declaration once, when
 * this ORDER has not taken that guest's profile before (v5: judged on the order, never on the
 * till's global customer, which stays on screen when staff go from a table to the walk in).
 * Re-setting the same guest (an edit of their details, a save to their profile) adds nothing, so
 * an allergy staff cleared stays cleared. The attach is recorded on the order with what it ADDED,
 * so taking the wrong customer off (detachCustomer) removes exactly that. A walk in with nothing
 * rung yet gets its order object (see declare). Returns the state patch plus `brings` (the
 * guest's saved list, for the red toast).
 */
export function attachCustomer(state, c, now = Date.now(), newId = null) {
  const s = state || {};
  const brings = allergenIds(c?.allergens);
  const on = orderOnScreen(s);
  if (!c || !brings.length || profileTaken(on.holder, c)) return { patch: { customer: c ?? null }, brings: [] };
  const current = onScreenDeclared(s);
  const next = allergenIds(current, brings);
  const attach = { guest: guestKey(c), added: brings.filter(id => !current.includes(id)) };
  return { patch: { customer: c, allergens: next, ...declare(s, on, next, now, newId, attach) }, brings };
}

/**
 * Taking customer `c` off the order on screen (the wrong person was attached): the allergies
 * their attach ADDED come off the order's declaration, nothing else. An allergy staff declared
 * themselves, before or after the attach, stays even when the profile holds it too. Null when
 * this order never took `c`'s profile (nothing to take off).
 */
export function detachCustomer(state, c, now = Date.now()) {
  const s = state || {};
  const on = orderOnScreen(s);
  const h = on.holder;
  const entries = attachedProfiles(h);
  const theirs = entries.filter(e => sameGuest(e.guest, c));
  if (!h || !theirs.length) return null;
  const drop = allergenIds(...theirs.map(e => e.added));
  const next = onScreenDeclared(s).filter(id => !drop.includes(id));
  const rest = entries.filter(e => !theirs.includes(e));
  const fields = { declaredAllergens: next, attachedProfiles: rest };
  let holderPatch;
  if (on.kind === 'tab') holderPatch = { tabs: (s.tabs || []).map(t => (t.id === on.id ? { ...t, ...fields } : t)) };
  else if (on.kind === 'table') holderPatch = { tables: (s.tables || []).map(t => (t.id === on.id && t.session ? { ...t, session: { ...t.session, ...fields, lastUpdated: now } } : t)) };
  else holderPatch = { walkInOrder: { ...h, ...fields } };
  return { patch: { allergens: next, ...holderPatch }, dropped: drop };
}

/**
 * The same attach rule for a table session written directly (the floor plan's Add guest, a
 * profile save, taking the guest off): a guest this order has not taken before adds their saved
 * allergies to the session's declaration once, recorded like attachCustomer, with lastUpdated
 * so the change publishes. The same guest, or no guest, changes only the customer.
 */
export function sessionWithCustomer(session, c, now = Date.now()) {
  const next = { ...session, customer: c || null };
  const brings = allergenIds(c?.allergens);
  if (!c || !brings.length || profileTaken(session, c)) return next;
  const current = orderDeclared(session);
  return {
    ...next,
    declaredAllergens: allergenIds(current, brings),
    attachedProfiles: [...attachedProfiles(session), { guest: guestKey(c), added: brings.filter(id => !current.includes(id)) }],
    lastUpdated: now,
  };
}

/** Attach records from several orders joined into one, each guest once (the first record wins). */
export function mergeProfiles(...lists) {
  const out = [];
  for (const list of lists) {
    for (const e of (Array.isArray(list) ? list : [])) {
      if (e?.guest && !out.some(o => sameGuest(o.guest, e.guest))) out.push(e);
    }
  }
  return out;
}

/** The attach record for an order CREATED with guest `c` on it (seating a table with its guest). */
export function seatedProfiles(c, declaredBefore = []) {
  const brings = allergenIds(c?.allergens);
  if (!c || !brings.length) return [];
  const before = allergenIds(declaredBefore);
  return [{ guest: guestKey(c), added: brings.filter(id => !before.includes(id)) }];
}

/**
 * The declared allergies the attached customer's profile does not hold yet: what an explicit
 * "Save to profile" would add. Never a removal (taking an allergy off a profile stays a
 * deliberate act in Back Office, the v5.5.882 rule).
 */
export function profileAdds(declared, customer) {
  const have = allergenIds(customer?.allergens);
  return allergenIds(declared).filter(id => !have.includes(id));
}

/** True when `items` came from the walk in (the counter's Seat, Merge and New check move its lines). */
export function movedFromWalkIn(walkInOrder, items) {
  const uids = new Set((walkInOrder?.items || []).map(i => i?.uid).filter(Boolean));
  return (Array.isArray(items) ? items : []).some(i => i?.uid && uids.has(i.uid));
}

/**
 * The store's order switch rule, as a pure function of two states: when a different order comes
 * on screen (another table, the walk in, a bar tab, the Bar surface and back) the chips become
 * THAT order's declaration, [] when it has none. Never carried over from the previous order.
 * Null when nothing needs writing.
 * v6: a table's session paid, cleared or replaced under the same table (another device, the
 * session reconciler) is a different order too, because the key holds the session (the review
 * of v5: the next party at the table inherited the last party's chips and printed them). The
 * same order changing under the same key is not followed: the active table's session is never
 * replaced by another till's copy (SessionReconciler and the broadcast merge keep the active
 * table local), fireScheduledOrder puts the walk in it borrowed back as it was, and the other
 * walk in swaps (the Orders Hub reopen, the operator switch, clearWalkIn) set the chips themselves.
 */
export function followOrderOnScreen(state, prev) {
  const now = orderOnScreen(state);
  if (now.key === orderOnScreen(prev).key) return null;
  const want = orderDeclared(now.holder);
  return sameIds(want, state?.allergens) ? null : { allergens: want };
}

/**
 * order_queue has no column for the declaration, so it rides in the row's customer jsonb, where
 * the other order level extras live (QR open tabs, collection codes). Empty means no key at all,
 * so a row without a declaration is written exactly as before (the same sync hash). A stale key
 * already inside the customer object is always replaced, never sent back.
 */
export function queueCustomerWithDeclared(customer, declared) {
  const { declaredAllergens: _stale, ...rest } = (customer && typeof customer === 'object') ? customer : {};
  const ids = allergenIds(declared);
  return ids.length ? { ...rest, declaredAllergens: ids } : rest;
}

/**
 * The other half: a queue row's customer jsonb read back into { customer, declaredAllergens }.
 * declaredAllergens is ALWAYS set ([] when the row has none), so a reconcile merge of the
 * server's copy replaces a declaration another till cleared instead of keeping this till's.
 */
export function declaredFromQueueCustomer(customer) {
  if (!customer || typeof customer !== 'object' || !('declaredAllergens' in customer)) {
    return { customer: customer || null, declaredAllergens: [] };
  }
  const { declaredAllergens, ...rest } = customer;
  return { customer: rest, declaredAllergens: allergenIds(declaredAllergens) };
}

// ── Customer details typed on the till (v5, 26 Sep 2026) ───────────────────────────
// The review of v4 found the till carrying ONE guest's saved allergies onto ANOTHER: the
// customer modal started from the attached customer's list and kept it when the phone was
// changed to a different person, and the customer display's phone capture spread the attached
// customer under the new phone. v4 made that print on the docket, and the modal's history save
// wrote it onto the new person's profile.

/**
 * The saved allergies of the guest the customer modal is confirming: the database profile's when
 * the phone matched one that holds some; else the customer being edited, but only when the typed
 * details are the SAME guest (sameGuest); else none. Never another person's list.
 */
export function confirmedGuestAllergens(existing, typed, match = null) {
  if (Array.isArray(match?.allergens) && match.allergens.length) return match.allergens;
  if (existing && sameGuest(existing, typed) && Array.isArray(existing.allergens)) return existing.allergens;
  return [];
}

/**
 * The attached customer with a phone number captured on the customer display. A different phone
 * is a different person: the previous guest's saved allergies and customer id do not come with
 * it (they would be declared on this order and, at close, written onto the new phone's profile).
 */
export function customerWithPhone(cur, phone, name) {
  const c = cur || {};
  const other = !!lastDigits(c.phone) && lastDigits(c.phone) !== lastDigits(phone);
  const { allergens: _allergens, id: _id, customerId: _customerId, ...rest } = c;
  return { ...(other ? rest : c), phone, name: name || c.name };
}

// ── The kitchen's copy of the declaration (v5, 26 Sep 2026) ────────────────────────
// The review of v4 proved an allergy declared AFTER the send never reached the kitchen: a held
// course fired with none, and the tickets made at the send kept none, while the till's banner
// said the kitchen would show it. order.kitchenAllergens is what the kitchen holds for the lines
// it already has (set at every send, and after every update). When the order declares an allergy
// the kitchen does not hold, the store tells the kitchen (an ALLERGY UPDATE docket to each centre
// with the order's food, and the open KDS tickets updated). Additions only: an allergy taken off
// after the send stays with the kitchen, and the till says so (kitchenOnly).
// v6: which tickets are the order's is recorded at each send (order.kitchenTickets, below), so
// the update never looks for them by line uid across the location.

/** The order's lines the kitchen already has (sent, not voided, not a revenue only line). */
export function kitchenLines(order) {
  return (Array.isArray(order?.items) ? order.items : []).filter(i => i && i.status === 'sent' && !i.voided && !i.noKitchen);
}

/**
 * The kitchen tickets the sends made for this order (v6): { id, centreId, uids, allergens } each,
 * where allergens is what that ticket carries (the send's declaration, then every update). The
 * review of v5: line uids alone are not unique (every till and every reload started at i1), so
 * the update matched another guest's ticket. A ticket id is.
 */
export function kitchenTicketsOf(order) {
  return (Array.isArray(order?.kitchenTickets) ? order.kitchenTickets : [])
    .filter(r => r && r.id)
    .map(r => ({
      id: String(r.id),
      centreId: r.centreId || null,
      uids: (Array.isArray(r.uids) ? r.uids : []).filter(Boolean).map(String),
      allergens: allergenIds(r.allergens),
    }));
}

/** The order's ticket records after a send made `newTickets` carrying `sentIds`. */
export function kitchenTicketsAfterSend(order, newTickets, sentIds) {
  const made = (Array.isArray(newTickets) ? newTickets : []).filter(t => t && t.id).map(t => ({
    id: String(t.id),
    centreId: t.centreId || null,
    uids: (Array.isArray(t.items) ? t.items : []).map(i => i?.uid).filter(Boolean).map(String),
    allergens: allergenIds(sentIds),
  }));
  return [...kitchenTicketsOf(order), ...made];
}

/** The records of tickets that hold any of the order's kitchen lines (a split moves lines away). */
function ownRecords(order, lines) {
  const own = new Set(lines.map(i => i.uid).filter(Boolean).map(String));
  return kitchenTicketsOf(order).filter(r => r.uids.some(u => own.has(u)));
}

/** Everything the kitchen was told for the order's lines: the order's record and each ticket's. */
export function kitchenHeld(order) {
  const lines = kitchenLines(order);
  return allergenIds(order?.kitchenAllergens, ...ownRecords(order, lines).map(r => r.allergens));
}

/**
 * What the kitchen is missing for `order`: null when it has no lines yet or already holds every
 * declared allergy; else { ids (what it will hold: its own plus the new), added, lines, stale,
 * loose }. v6: `stale` are the order's recorded tickets that lack a declared allergy (a ticket
 * that already carries it is left alone, so a combine never re-announces the moved food), and
 * `loose` are kitchen lines on no recorded ticket (an order sent before v6, a walk in reopened
 * on another till), judged against order.kitchenAllergens as before. `lines` is both.
 */
export function kitchenAllergyUpdate(order) {
  const lines = kitchenLines(order);
  if (!lines.length) return null;
  const declared = orderDeclared(order);
  const told = allergenIds(order?.kitchenAllergens);
  const recs = ownRecords(order, lines);
  const covered = new Set(recs.flatMap(r => r.uids));
  const unrecorded = lines.filter(i => !i.uid || !covered.has(String(i.uid)));
  const looseAdded = unrecorded.length ? declared.filter(id => !told.includes(id)) : [];
  const stale = recs.filter(r => declared.some(id => !r.allergens.includes(id)));
  if (!stale.length && !looseAdded.length) return null;
  const staleUids = new Set(stale.flatMap(r => r.uids));
  const loose = looseAdded.length ? unrecorded : [];
  return {
    ids: allergenIds(kitchenHeld(order), declared),
    added: allergenIds(...stale.map(r => declared.filter(id => !r.allergens.includes(id))), looseAdded),
    lines: lines.filter(i => (i.uid && staleUids.has(String(i.uid))) || loose.includes(i)),
    stale,
    loose,
  };
}

/** Allergies the kitchen was told for lines it has, which the order no longer declares. */
export function kitchenOnly(order) {
  if (!kitchenLines(order).length) return [];
  const declared = orderDeclared(order);
  return kitchenHeld(order).filter(id => !declared.includes(id));
}

/** What the kitchen holds after a send of `sentIds` (nothing new when the send had no lines). */
export function kitchenAfterSend(order, sentIds, sentAnything) {
  return sentAnything ? allergenIds(order?.kitchenAllergens, sentIds) : allergenIds(order?.kitchenAllergens);
}

/**
 * The key the store's kitchen update timer uses for an order: the table and its session (a new
 * party at the same table is a different order), or the walk in by its order number. Null when
 * the order has nothing in the kitchen yet (the next send carries the declaration) or is a bar
 * tab (each round carries the tab's). `target` is { tableId } for a table written off screen,
 * { walkIn: true } for the walk in, else the order on screen.
 */
export function kitchenKeyFor(state, target = null) {
  const s = state || {};
  if (target?.walkIn) {
    const wi = s.walkInOrder;
    return wi?.id && kitchenLines(wi).length ? `walkin:${wi.id}` : null;
  }
  if (target?.tableId) {
    const session = (s.tables || []).find(t => t.id === target.tableId)?.session;
    return session && kitchenLines(session).length ? `table:${target.tableId}:${sessionKey(session)}` : null;
  }
  const on = orderOnScreen(s);
  if (on.kind === 'table') return kitchenKeyFor(s, { tableId: on.id });
  if (on.kind === 'walkin' && on.holder?.id && kitchenLines(on.holder).length) return `walkin:${on.holder.id}`;
  return null;
}

/**
 * The order a kitchen key names, if it is still there: { kind, order, tableId, label }. A table
 * is found by building each table's own key, so an id with a colon in it cannot be misread.
 */
export function kitchenOrderByKey(state, key) {
  const s = state || {};
  const k = String(key || '');
  if (k.startsWith('table:')) {
    const table = (s.tables || []).find(t => t?.session && `table:${t.id}:${sessionKey(t.session)}` === k);
    if (!table) return null;
    return { kind: 'table', order: table.session, tableId: table.id, label: table.label || table.id };
  }
  if (k.startsWith('walkin:')) {
    const wi = s.walkInOrder;
    if (!wi || String(wi.id) !== k.slice(7)) return null;
    return { kind: 'walkin', order: wi, tableId: null, label: wi.ref || null };
  }
  return null;
}

/**
 * State patch recording that the kitchen now holds `ids` for the order `found` names: the
 * order's kitchenAllergens and each of its ticket records. v6: only that exact order (the same
 * session, the same walk in number), because `found` can be the order as a timer last saw it
 * after it left this till, and a new party at the table, or the next walk in, is never marked
 * told. A walk in's Orders Hub entry keeps what the kitchen was told even when the walk in has
 * gone, so a reopen on any till brings it back and does not announce it again.
 */
export function kitchenToldPatch(state, found, ids, now = Date.now()) {
  const s = state || {};
  const told = allergenIds(ids);
  const withTold = (o) => ({
    ...o,
    kitchenAllergens: allergenIds(o?.kitchenAllergens, told),
    ...(Array.isArray(o?.kitchenTickets) ? { kitchenTickets: kitchenTicketsOf(o).map(r => ({ ...r, allergens: allergenIds(r.allergens, told) })) } : {}),
  });
  const orderId = String(found?.order?.id ?? '');
  if (found?.kind === 'table') {
    const party = sessionKey(found.order);
    return { tables: (s.tables || []).map(t => (t.id === found.tableId && t.session && sessionKey(t.session) === party ? { ...t, session: { ...withTold(t.session), lastUpdated: now } } : t)) };
  }
  if (found?.kind === 'walkin') {
    const patch = {};
    const wi = s.walkInOrder;
    if (wi && String(wi.id ?? '') === orderId) patch.walkInOrder = withTold(wi);
    const ref = found.order?.ref;
    if (ref && (s.orderQueue || []).some(o => o.ref === ref)) {
      patch.orderQueue = s.orderQueue.map(o => (o.ref === ref
        ? { ...o, declaredAllergens: allergenIds(orderDeclared(o), told), ...(Array.isArray(o.kitchenTickets) ? { kitchenTickets: withTold(o).kitchenTickets } : {}) }
        : o));
    }
    return patch;
  }
  return {};
}

/** True when a kitchen ticket holds any of the order's lines (by line uid). */
export function ticketHoldsLines(ticket, uids) {
  const set = uids instanceof Set ? uids : new Set(uids || []);
  return (Array.isArray(ticket?.items) ? ticket.items : []).some(i => i?.uid && set.has(i.uid));
}

/**
 * Is a kitchen ticket (a store ticket or a kds_tickets row) this order's, for a line on no
 * recorded ticket (v6)? A walk in by its order number (meta.orderNo, what the KDS shows), a table
 * by its label, and never a ticket sent before the order began (`scope.since`, the session's
 * seatedAt: the last party at the same table). The review of v5: matching on the line uid alone
 * marked another guest's ticket. A minute of grace covers another till's clock.
 */
export function ticketIsOrders(ticket, scope) {
  if (!ticket || !scope) return false;
  const at = Number(ticket.sentAt ?? (ticket.sent_at ? Date.parse(ticket.sent_at) : NaN));
  if (Number(scope.since) > 0 && Number.isFinite(at) && at < Number(scope.since) - 60000) return false;
  if (scope.orderNo) return String(ticket.meta?.orderNo ?? '') === String(scope.orderNo);
  if (scope.label) return String(ticket.table ?? ticket.table_label ?? '') === String(scope.label);
  return false;
}

/**
 * A ticket known to be this order's, with every line's `allergy` and meta.allergy set to `line`.
 * meta is only touched when the ticket has one: a row written before the meta column is read from
 * its table label, and a meta of { allergy } alone would blank its header. Null when it already
 * shows exactly this.
 */
export function retagOrderTicket(ticket, line) {
  if (!line || !ticket || !Array.isArray(ticket.items)) return null;
  const items = ticket.items.map(i => (i && i.allergy !== line ? { ...i, allergy: line } : i));
  const hasMeta = !!ticket.meta && typeof ticket.meta === 'object';
  const itemsSame = items.every((i, n) => i === ticket.items[n]);
  if (itemsSame && (!hasMeta || ticket.meta.allergy === line)) return null;
  return { ...ticket, items, ...(hasMeta ? { meta: { ...ticket.meta, allergy: line } } : {}) };
}

/**
 * Where a kitchen update goes (v6). `upd` is kitchenAllergyUpdate's. `ticketState(id)` is the
 * kitchen's own record of a ticket: 'live' (pending or held), 'gone' (bumped), undefined when
 * this till cannot tell. `looseTickets` are live tickets already known to be this order's
 * (ticketIsOrders) that may hold its loose lines. Returns { retag (ticket ids to mark), docket
 * ([centreId, lines] for the ALLERGY UPDATE docket), route (loose lines on no known ticket, which
 * the store routes the way the send did) }. The review of v5: the docket listed food already
 * served. Now a line is listed only while it is still in the kitchen: on a live ticket, on one
 * this till cannot see (the safe side), or in a course still held. Nothing is listed when the
 * kitchen has none of it left; the next send carries the declaration anyway.
 */
export function kitchenUpdatePlan(upd, ticketState, looseTickets = []) {
  const retag = [];
  const docket = new Map();
  const seen = new Set();
  const put = (centreId, l) => {
    const k = `${centreId}|${l.uid || l.name}`;
    if (!centreId || seen.has(k)) return;
    seen.add(k);
    if (!docket.has(centreId)) docket.set(centreId, []);
    docket.get(centreId).push(l);
  };
  const byUid = new Map((upd?.lines || []).filter(l => l?.uid).map(l => [String(l.uid), l]));
  for (const r of (upd?.stale || [])) {
    const state = typeof ticketState === 'function' ? ticketState(r.id) : undefined;
    if (state === 'live' && !retag.includes(r.id)) retag.push(r.id);
    for (const u of r.uids) {
      const l = byUid.get(u);
      if (l && (state !== 'gone' || l.fired === false)) put(r.centreId, l);
    }
  }
  const route = [];
  for (const l of (upd?.loose || [])) {
    const on = (Array.isArray(looseTickets) ? looseTickets : []).filter(t => l.uid && ticketHoldsLines(t, [l.uid]));
    if (!on.length) { route.push(l); continue; }
    for (const t of on) {
      if (!retag.includes(t.id)) retag.push(t.id);
      put(t.centreId ?? t.centre_id, l);
    }
  }
  return { retag, docket: [...docket.entries()], route };
}

/**
 * The allergy fields of a walk in reopened from its Orders Hub entry (v6). The entry's
 * declaration is what the kitchen got at the send (plus every update since, kitchenToldPatch),
 * so when the reopened lines were sent the kitchen already holds it. The review of v5: without
 * this a reopen treated the whole declaration as new, and the next send, payment or chip tap
 * printed a false "ALLERGY UPDATE ... NEW" docket for food the kitchen already had marked.
 */
export function reopenedAllergyFields(entry, items = entry?.items) {
  const declared = orderDeclared(entry);
  const out = { declaredAllergens: declared };
  if (kitchenLines({ items }).length) out.kitchenAllergens = declared;
  const recs = kitchenTicketsOf(entry);
  if (recs.length) out.kitchenTickets = recs;
  return out;
}

/**
 * The store's line uid maker (v6): `i`, a tag made once per page load from the time and a random
 * number, then a counter. The review of v5: `i${n}` from 1 on every till and every reload, so two
 * orders at one venue shared uids. Pure given its seed, so the test can pin it.
 */
export function lineUidMaker(now = Date.now(), rand = Math.random()) {
  const tag = `${Math.floor(Math.abs(Number(now) || 0)).toString(36)}${Math.floor(Math.abs(Number(rand) || 0) * 46656).toString(36).padStart(3, '0')}`;
  let n = 1;
  return () => `i${tag}-${n++}`;
}

// ── Carrying the declaration where a session is rebuilt or synced (v5) ───────────

/** The allergy fields a session carries, only those it has (a QR rebuild keeps a till's). */
export function carryOrderAllergy(session) {
  const out = {};
  if (Array.isArray(session?.declaredAllergens)) out.declaredAllergens = allergenIds(session.declaredAllergens);
  if (Array.isArray(session?.kitchenAllergens)) out.kitchenAllergens = allergenIds(session.kitchenAllergens);
  if (Array.isArray(session?.attachedProfiles)) out.attachedProfiles = session.attachedProfiles;
  // v6: and which kitchen tickets are the order's, so a late allergy still finds them by id.
  if (Array.isArray(session?.kitchenTickets)) out.kitchenTickets = kitchenTicketsOf(session);
  return out;
}

/** True when two sessions differ in any allergy field (SyncBridge publishes the change). */
export function allergyFieldsDiffer(a, b) {
  if (!sameIds(a?.declaredAllergens, b?.declaredAllergens)) return true;
  if (!sameIds(a?.kitchenAllergens, b?.kitchenAllergens)) return true;
  // v6: the ticket records too (a kitchen update marks what each ticket now carries).
  if (JSON.stringify(kitchenTicketsOf(a)) !== JSON.stringify(kitchenTicketsOf(b))) return true;
  return JSON.stringify(attachedProfiles(a)) !== JSON.stringify(attachedProfiles(b));
}
