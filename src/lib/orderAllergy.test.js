// The ORDER's declared allergies (26 Sep 2026, allergy v4). Peter: "even if allergies are not on
// products, when allergies are selected it should come up on the KDS and the ticket printed".
// Coffee Boy Leeds has 454 products and not one carries allergen data, so no case below uses
// item.allergens. The helpers are pure; the store's actions are one line calls of them, and the
// source pins at the bottom prove every send path and every order switch path uses them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  allergenIds, sameIds, orderDeclared, orderOnScreen, declarationFor, sendDeclared, onScreenDeclared,
  withDeclaration, seedDeclared, withSeededCart, sameGuest, attachCustomer, sessionWithCustomer,
  profileAdds, movedFromWalkIn, followOrderOnScreen, queueCustomerWithDeclared, declaredFromQueueCustomer,
  detachCustomer, profileTaken, seatedProfiles, mergeProfiles, guestKey, confirmedGuestAllergens, customerWithPhone,
  kitchenLines, kitchenAllergyUpdate, kitchenOnly, kitchenAfterSend, kitchenKeyFor, kitchenOrderByKey, kitchenToldPatch,
  ticketHoldsLines, carryOrderAllergy, allergyFieldsDiffer,
  tableOnScreen, toggledDeclaration, kitchenTicketsOf, kitchenTicketsAfterSend, kitchenHeld, kitchenUpdatePlan,
  ticketIsOrders, retagOrderTicket, reopenedAllergyFields, lineUidMaker, sessionKey,
} from './orderAllergy.js';
import { ticketAllergy, orderAllergyLine, declaredAllergyLine, ticketAllergyBanner } from './kds/kdsTicket.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
/** The body of a store action `name: (...) => {` up to its closing `  },` (two space indent). */
const action = (src, name) => {
  const m = new RegExp(`\\n {2}${name}: [^\\n]*=> \\{[\\s\\S]*?\\n {2}\\},\\n`).exec(src);
  assert.ok(m, `${name} not found`);
  return m[0];
};

// The store's actions, as the pure calls they make (pinned below), so a whole till session can
// be played through without React or Supabase.
let _n = 0;
const newId = () => `ORD-T${++_n}`;   // the store passes _newOrderId
// v6: a chip tap starts from the ORDER's declaration (toggledDeclaration), as the store does.
const toggle = (s, id) => ({ ...s, ...withDeclaration(s, toggledDeclaration(s, id), 1, newId) });
const clearAll = (s) => ({ ...s, ...withDeclaration(s, [], 1, newId) });
const attach = (s, c) => ({ ...s, ...attachCustomer(s, c, 1, newId).patch });
const detach = (s, c) => { const r = detachCustomer(s, c, 1); return r ? { ...s, ...r.patch } : s; };
const go = (s, patch) => { const next = { ...s, ...patch }; return { ...next, ...(followOrderOnScreen(next, s) || {}) }; };
const tableSession = (state, id) => state.tables.find(t => t.id === id)?.session;
const line = (over) => ({ uid: 'u1', name: 'Flat white', qty: 1, status: 'pending', ...over });
const SAM = { name: 'Sam', phone: '07700 900123', allergens: ['nuts'] };

const base = (over = {}) => ({
  surface: 'pos', activeTableId: null, activeTabId: null, walkInOrder: null, customer: null, allergens: [],
  tables: [
    { id: 't1', label: 'T1', session: { id: 'ORD-1', items: [line()], declaredAllergens: [] } },
    { id: 't2', label: 'T2', session: { id: 'ORD-2', items: [line({ uid: 'u2' })], declaredAllergens: ['milk'] } },
    { id: 't3', label: 'T3', session: { id: 'ORD-3', items: [line({ uid: 'u3' })] } },   // an old session, no field
  ],
  tabs: [],
  ...over,
});

test('allergenIds and sameIds: normalised, blanks dropped, each once; order and spelling do not matter', () => {
  assert.deepEqual(allergenIds(['nuts', 'Dairy'], null, ['milk', '', '  '], 'Soya'), ['nuts', 'milk', 'soy']);
  assert.deepEqual(allergenIds(), []);
  assert.ok(sameIds(['milk', 'nuts'], ['nuts', 'dairy']));
  assert.ok(!sameIds(['milk'], ['milk', 'nuts']));
  assert.ok(sameIds(undefined, []));
});

test('orderDeclared: an old order without the field declares nothing; a tab read back from bar_tabs uses its last round', () => {
  assert.deepEqual(orderDeclared({ declaredAllergens: ['nuts'] }), ['nuts']);
  assert.deepEqual(orderDeclared({ items: [line()] }), []);            // an old session: none
  assert.deepEqual(orderDeclared(null), []);
  const fromRow = { id: 'tab-1', rounds: [{ declaredAllergens: ['eggs'] }, { declaredAllergens: ['nuts'] }] };
  assert.deepEqual(orderDeclared(fromRow), ['nuts']);                   // the last round's record
  assert.deepEqual(orderDeclared({ ...fromRow, declaredAllergens: [] }), []);   // this till's field wins
});

test('orderOnScreen: the Bar\'s open tab only on the Bar surface, else the active table, else the walk in', () => {
  const s = base({ activeTableId: 't2', walkInOrder: { id: 'w' }, tabs: [{ id: 'tab-1' }], activeTabId: 'tab-1' });
  assert.equal(orderOnScreen(s).key, 'table:t2:ORD-2');                  // v6: the table AND its session
  assert.equal(orderOnScreen({ ...s, surface: 'bar' }).key, 'tab:tab-1');
  assert.equal(orderOnScreen({ ...s, surface: 'bar', activeTabId: null }).key, 'table:t2:ORD-2');   // a handheld never opens tabs
  assert.equal(orderOnScreen({ ...s, activeTableId: null }).key, 'walkin');
  assert.equal(orderOnScreen({ ...s, activeTableId: null }).holder.id, 'w');
  assert.equal(orderOnScreen(base()).holder, null);                      // nothing rung yet
  // declarationFor: what the chips load for that order, never the chips already showing.
  assert.deepEqual(declarationFor(base({ activeTableId: 't2', allergens: ['eggs'] })), ['milk']);
  assert.deepEqual(declarationFor(base({ activeTableId: 't3', allergens: ['eggs'] })), []);
  assert.deepEqual(declarationFor(base({ allergens: ['eggs'] })), []);
});

test('withDeclaration: a staff edit writes the chips AND the order on screen, nothing else', () => {
  const s = base({ activeTableId: 't1' });
  const p = withDeclaration(s, ['nuts'], 123);
  assert.deepEqual(p.allergens, ['nuts']);
  assert.deepEqual(p.tables.find(t => t.id === 't1').session.declaredAllergens, ['nuts']);
  assert.equal(p.tables.find(t => t.id === 't1').session.lastUpdated, 123);   // publishes to the other tills
  assert.equal(p.tables.find(t => t.id === 't2'), s.tables[1]);                // another table never changes
  assert.ok(!('walkInOrder' in p));
  // The walk in, and the Bar's tab.
  const w = withDeclaration(base({ walkInOrder: { id: 'w', items: [line()] } }), ['milk'], 1);
  assert.deepEqual(w.walkInOrder.declaredAllergens, ['milk']);
  const b = withDeclaration(base({ surface: 'bar', activeTabId: 'tab-1', tabs: [{ id: 'tab-1', rounds: [] }, { id: 'tab-2', rounds: [] }] }), ['eggs'], 1);
  assert.deepEqual(b.tabs[0].declaredAllergens, ['eggs']);
  assert.ok(!('declaredAllergens' in b.tabs[1]));
  // v5: a walk in with nothing rung gets its order object (with the store's order number), so the
  // declaration outlives an order switch. Clearing when there is no order makes none.
  const made = withDeclaration(base(), ['nuts'], 1, () => 'ORD-9');
  assert.deepEqual(made.allergens, ['nuts']);
  assert.deepEqual(made.walkInOrder, { id: 'ORD-9', items: [], subtotal: 0, total: 0, declaredAllergens: ['nuts'] });
  assert.deepEqual(withDeclaration(base(), [], 1, () => 'ORD-9'), { allergens: [] });
  // A table that is not seated yet: the chips alone (seedDeclared hands them to its session).
  const unseated = base({ activeTableId: 't9', tables: [{ id: 't9', label: 'T9', session: null }] });
  assert.deepEqual(withDeclaration(unseated, ['nuts'], 1, () => 'ORD-9'), { allergens: ['nuts'] });
  // Already declared exactly this: the order is left alone (no republish).
  assert.deepEqual(Object.keys(withDeclaration(base({ activeTableId: 't2' }), ['milk'], 1)), ['allergens']);
});

test('the wrongly tapped chip: Tree nuts from the profile, Eggs tapped by mistake, Clear all, send: nothing prints, even with the customer still attached', () => {
  let s = base({ walkInOrder: { id: 'w', items: [line()], declaredAllergens: [] } });
  s = attach(s, SAM);                                  // the profile adds Tree nuts once
  assert.deepEqual(s.walkInOrder.declaredAllergens, ['nuts']);
  s = toggle(s, 'eggs');                               // the wrong tap
  assert.deepEqual(s.walkInOrder.declaredAllergens, ['nuts', 'eggs']);
  s = clearAll(s);                                     // staff clear both
  s = attach(s, { ...SAM, name: 'Sam B' });            // the same guest re-set (an edit): adds nothing
  assert.deepEqual(s.walkInOrder.declaredAllergens, []);
  assert.deepEqual(s.customer.allergens, ['nuts'], 'the profile keeps its list, the order does not');
  // What the send reads, and what it prints.
  const declared = sendDeclared(s.walkInOrder, s.allergens, true);
  assert.deepEqual(declared, []);
  assert.equal(ticketAllergy(s.walkInOrder.items[0], declared), null);
  assert.equal(orderAllergyLine(declared, s.walkInOrder.items), null);
  assert.equal(declaredAllergyLine(onScreenDeclared(s)), null, 'the order panel banner is gone too');
});

test('a table\'s second round keeps the allergy, and its chips still warn', () => {
  let s = go(base(), { activeTableId: 't1' });
  s = toggle(s, 'nuts');
  const round1 = sendDeclared(tableSession(s, 't1'), s.allergens, true);
  assert.equal(orderAllergyLine(round1, tableSession(s, 't1').items), 'TREE NUTS');
  // The send marks the line sent; round 2 is rung onto the same session (addItem keeps its field).
  s = { ...s, tables: s.tables.map(t => (t.id === 't1' ? { ...t, session: { ...seedDeclared(t.session, s, 'table', 't1'), items: [line({ status: 'sent' }), line({ uid: 'r2' })] } } : t)) };
  const round2 = sendDeclared(tableSession(s, 't1'), s.allergens, true);
  assert.equal(ticketAllergy(line({ uid: 'r2' }), round2), 'TREE NUTS');
  assert.deepEqual(s.allergens, ['nuts'], 'the product filter and the AllergenModal read these');
});

test('reopening a table loads its declaration; switching to a different order loads that order\'s, never the last one\'s', () => {
  let s = base({ walkInOrder: { id: 'w', items: [line()], declaredAllergens: ['sesame'] }, allergens: ['sesame'] });
  s = go(s, { activeTableId: 't2' });
  assert.deepEqual(s.allergens, ['milk'], 'T2 declared milk');
  s = go(s, { activeTableId: 't1' });
  assert.deepEqual(s.allergens, [], 'T1 declared nothing: the milk does not carry over');
  s = go(s, { activeTableId: 't3' });
  assert.deepEqual(s.allergens, [], 'an old session without the field loads nothing');
  s = go(s, { activeTableId: null });
  assert.deepEqual(s.allergens, ['sesame'], 'back at the counter: the walk in\'s own');
  s = go(s, { walkInOrder: null });
  assert.deepEqual(s.allergens, ['sesame'], 'no order switch, no load (clearWalkIn loads for itself)');
  assert.equal(followOrderOnScreen(s, s), null);
  // The Bar surface and back.
  const bar = base({ activeTableId: 't2', allergens: ['milk'], activeTabId: 'tab-1', tabs: [{ id: 'tab-1', declaredAllergens: ['eggs'] }] });
  const onBar = go(bar, { surface: 'bar' });
  assert.deepEqual(onBar.allergens, ['eggs']);
  assert.deepEqual(go(onBar, { surface: 'pos' }).allergens, ['milk']);
});

test('attaching a customer adds their saved allergies once; the same guest again, or the table hydrate, adds nothing', () => {
  let s = base({ activeTableId: 't1' });
  const first = attachCustomer(s, SAM, 1);
  assert.deepEqual(first.brings, ['nuts']);
  s = { ...s, ...first.patch };
  assert.deepEqual(tableSession(s, 't1').declaredAllergens, ['nuts']);
  s = clearAll(s);
  // The same guest by phone in another format, or by id, is not a new attach.
  assert.ok(sameGuest(SAM, { phone: '+44 7700 900123' }));
  assert.ok(sameGuest({ id: 7, phone: '1' }, { id: '7' }));
  assert.ok(!sameGuest({ id: 7 }, { id: 8, phone: SAM.phone }));
  assert.ok(!sameGuest(null, SAM));
  assert.deepEqual(attachCustomer(s, { ...SAM, phone: '+447700900123' }, 1).brings, []);
  assert.deepEqual({ ...s, ...attachCustomer(s, { ...SAM, phone: '+447700900123' }, 1).patch }.allergens, [], 'a cleared allergy stays cleared');
  // A different guest adds theirs to what is declared.
  s = toggle(s, 'eggs');
  s = attach(s, { name: 'Jo', phone: '07000 000001', allergens: ['milk', 'eggs'] });
  assert.deepEqual(tableSession(s, 't1').declaredAllergens, ['eggs', 'milk']);
  // A guest with no saved allergies changes only the customer.
  assert.deepEqual(Object.keys(attachCustomer(s, { name: 'Al', phone: '07000 000002' }, 1).patch), ['customer']);
  // The floor plan's Add guest writes the session directly, same rule.
  const sess = sessionWithCustomer({ declaredAllergens: ['eggs'], customer: null }, SAM, 5);
  assert.deepEqual(sess.declaredAllergens, ['eggs', 'nuts']);
  assert.equal(sess.lastUpdated, 5);
  // v5: "already on the order" is the ORDER's record of whose profile it took, not session.customer.
  const took = sessionWithCustomer({ declaredAllergens: [], customer: null }, SAM, 5);
  assert.deepEqual(took.attachedProfiles, [{ guest: { phone: SAM.phone, name: 'Sam' }, added: ['nuts'] }]);
  assert.deepEqual(sessionWithCustomer({ ...took, declaredAllergens: [] }, SAM, 6).declaredAllergens, [], 'cleared stays cleared');
  // A session from before v5 shows its guest but never took the profile: attaching adds it.
  assert.deepEqual(sessionWithCustomer({ declaredAllergens: [], customer: SAM }, SAM, 5).declaredAllergens, ['nuts']);
  assert.equal(sessionWithCustomer({ declaredAllergens: ['nuts'], customer: SAM }, null).customer, null);
});

test('a scheduled collection order keeps its allergy through the queue row and prints it when it fires later', () => {
  // Rung and declared at the counter, sent as a collection for later.
  const walkIn = { id: 'w', ref: '#41', items: [line()], declaredAllergens: ['nuts'] };
  const declared = sendDeclared(walkIn, ['nuts'], true);
  const entry = { ref: '#41', status: 'scheduled', customer: { name: 'Sam', collectionTime: '18:30' }, items: [line()], declaredAllergens: declared };
  // Its order_queue row carries it in the customer jsonb and reads it back (another till, a reload).
  const rowCustomer = queueCustomerWithDeclared(entry.customer, entry.declaredAllergens);
  assert.deepEqual(rowCustomer, { name: 'Sam', collectionTime: '18:30', declaredAllergens: ['nuts'] });
  const back = declaredFromQueueCustomer(rowCustomer);
  assert.deepEqual(back.customer, entry.customer);
  assert.deepEqual(orderDeclared({ ...entry, ...back }), ['nuts']);
  // At fire time the chips belong to whatever is on screen (here a table with milk): not used.
  const reconstructed = { id: 'ORD-scheduled', items: entry.items, declaredAllergens: orderDeclared(entry) };
  const atFire = sendDeclared(reconstructed, ['milk'], false);
  assert.deepEqual(atFire, ['nuts']);
  assert.equal(orderAllergyLine(atFire, reconstructed.items), 'TREE NUTS');
});

test('order_queue carriage: a row with no declaration is written exactly as before, and a clear elsewhere is taken', () => {
  const c = { name: 'Sam', phone: '07700 900123' };
  assert.deepEqual(queueCustomerWithDeclared(c, []), c);
  assert.deepEqual(queueCustomerWithDeclared(null, undefined), {});
  assert.deepEqual(queueCustomerWithDeclared({ ...c, declaredAllergens: ['nuts'] }, []), c, 'a stale key is never sent back');
  assert.deepEqual(declaredFromQueueCustomer(c), { customer: c, declaredAllergens: [] });
  assert.deepEqual(declaredFromQueueCustomer(null), { customer: null, declaredAllergens: [] });
});

test('a bar tab keeps its allergy across rounds, and a different tab loads its own', () => {
  const tabs = [{ id: 'tab-a', rounds: [], declaredAllergens: ['nuts'] }, { id: 'tab-b', rounds: [] }];
  let s = base({ surface: 'bar', activeTabId: 'tab-a', tabs, allergens: ['nuts'] });
  const r1 = sendDeclared(s.tabs[0], s.allergens, true);
  const r2 = sendDeclared(s.tabs[0], s.allergens, true);
  assert.equal(orderAllergyLine(r1, []), 'TREE NUTS');
  assert.equal(orderAllergyLine(r2, []), 'TREE NUTS');
  s = go(s, { activeTabId: 'tab-b' });
  assert.deepEqual(s.allergens, []);
  assert.deepEqual(sendDeclared(s.tabs[1], ['nuts'], false), [], 'tab B never gets tab A\'s');
  s = go(s, { activeTabId: 'tab-a' });
  assert.deepEqual(s.allergens, ['nuts']);
  s = go(s, { activeTabId: null });                    // closeTab
  assert.deepEqual(s.allergens, []);
});

test('an old session without the field sends none, on screen or not', () => {
  const old = base().tables[2].session;
  assert.deepEqual(sendDeclared(old, [], true), []);             // on screen: its chips loaded as []
  assert.deepEqual(sendDeclared(old, ['nuts'], false), []);      // a payment time fire from another screen
  assert.equal(ticketAllergy(old.items[0], sendDeclared(old, ['nuts'], false)), null);
  // Only a staff tap on screen declares for it (and writes the field).
  const s = toggle(go(base(), { activeTableId: 't3' }), 'nuts');
  assert.deepEqual(tableSession(s, 't3').declaredAllergens, ['nuts']);
});

test('seedDeclared: an order created as the order on screen takes the chips; any other order starts with none', () => {
  const pending = base({ allergens: ['nuts'] });                 // tapped before anything was rung
  assert.deepEqual(seedDeclared({ id: 'w' }, pending, 'walkin').declaredAllergens, ['nuts']);
  assert.deepEqual(seedDeclared({ id: 'w' }, { ...pending, activeTableId: 't1' }, 'walkin').declaredAllergens, []);
  assert.deepEqual(seedDeclared({ id: 'ORD-9' }, { ...pending, activeTableId: 't1' }, 'table', 't1').declaredAllergens, ['nuts']);
  assert.deepEqual(seedDeclared({ id: 'ORD-9' }, { ...pending, activeTableId: 't1' }, 'table', 't2').declaredAllergens, []);
  const has = { id: 'w', declaredAllergens: ['milk'] };
  assert.equal(seedDeclared(has, pending, 'walkin'), has);
  // A counter cart parked on an operator switch keeps the chips it was rung under.
  assert.deepEqual(withSeededCart({ ...pending, walkInOrder: { id: 'w', items: [line()] } }).walkInOrder.declaredAllergens, ['nuts']);
  assert.equal(withSeededCart(pending), pending);
});

test('profileAdds: only allergies the profile does not hold; never a removal', () => {
  assert.deepEqual(profileAdds(['nuts', 'milk'], { allergens: ['dairy'] }), ['nuts']);
  assert.deepEqual(profileAdds([], { allergens: ['nuts'] }), []);
  assert.deepEqual(profileAdds(['eggs'], null), ['eggs']);
});

test('movedFromWalkIn: the counter\'s Seat, Merge and New check move the walk in\'s own lines', () => {
  const wi = { items: [line({ uid: 'a' }), line({ uid: 'b' })] };
  assert.ok(movedFromWalkIn(wi, [line({ uid: 'b' })]));
  assert.ok(!movedFromWalkIn(wi, [line({ uid: 'pkg-1' })]));   // a booking's package lines
  assert.ok(!movedFromWalkIn(null, [line({ uid: 'a' })]));
});

// ── Source pins: every send path reads the ORDER's declaration ─────────────────────

test('source pin: sendToKitchen reads the order being sent (table session or walk in), never a customer\'s saved list', () => {
  const store = read('../store/index.js');
  const send = action(store, 'sendToKitchen');
  assert.match(send, /return sendDeclared\(session, st\.allergens, !bypassSchedule && tableOnScreen\(st, tableId\)\);/);
  assert.match(send, /return sendDeclared\(st\.walkInOrder, st\.allergens, !bypassSchedule && on\.kind === 'walkin'\);/);
  assert.ok(!/allergens\s*[:,)]\s*[^\n]*customer\??\.allergens|customer\??\.allergens/.test(send), 'no customer.allergens on top of the declaration');
  assert.match(send, /allergy: orderAllergyLine\(tableAllergens, pendingItems\),/);
  assert.match(send, /allergy: orderAllergyLine\(walkInAllergens, pendingItems\),/);
  assert.match(send, /createKdsTickets\(pendingItems, [^\n]*tableMeta, tableAllergens\)/);
  assert.match(send, /createKdsTickets\(pendingItems, [^\n]*walkInMeta, walkInAllergens\)/);
  // Read once, before the scheduled branch returns early; the scheduled entry and the queue entry carry it.
  const at = send.indexOf('const walkInAllergens = declaredAllergens(null);');
  assert.ok(at > -1 && at < send.indexOf('if (!bypassSchedule && customer?.collectionTime && !customer?.isASAP)'));
  assert.equal((send.match(/declaredAllergens: walkInAllergens,/g) || []).length, 3, 'the scheduled entry, the queue entry and the sent walk in');
  assert.match(send, /items: pendingItems\.map\(i => \(\{ \.\.\.i \}\)\),/, 'no line stamping on the scheduled entry');
  assert.match(send, /walkInOrder: \{ \.\.\.\(s\.walkInOrder\|\|\{\}\), declaredAllergens: walkInAllergens,/);
  assert.ok(!/guestAllergens|heldAllergens|orderDeclaredAllergens/.test(send));
});

test('source pin: the payment time fires, the scheduled fire, the reprint, the bar round, the move docket and channel orders', () => {
  const store = read('../store/index.js');
  // Payment time fires go through sendToKitchen with the order's own id.
  assert.match(action(store, 'clearTable'), /if \(hasUnfired\) get\(\)\.sendToKitchen\(\{ fireAll: true, tableId \}\);/);
  assert.match(store, /get\(\)\.sendToKitchen\(\{ fireAll: true, tableId: null \}\);/);
  // The scheduled fire puts the entry's own declaration on the order it sends.
  const fire = action(store, 'fireScheduledOrder');
  assert.match(fire, /declaredAllergens: orderDeclared\(entry\),/);
  assert.match(fire, /get\(\)\.sendToKitchen\(\{ bypassSchedule: true, tableId: null \}\);/);
  // The reprint: the reprinted order's declaration.
  const reprint = action(store, 'reprintKitchenTickets');
  assert.match(reprint, /\? sendDeclared\(session, reprintState\.allergens, tableOnScreen\(reprintState, table\.id\)\)/);
  assert.match(reprint, /: sendDeclared\(reprintState\.walkInOrder, reprintState\.allergens, orderOnScreen\(reprintState\)\.kind === 'walkin'\);/);
  assert.match(reprint, /allergy: ticketAllergy\(i, reprintAllergens\),/);
  // The bar round: the TAB's declaration (plus what a POS hand over brings), recorded on the round.
  const round = action(store, 'addRoundToTab');
  assert.match(round, /sendDeclared\(_capTab, _decState\.allergens, _decOn\.kind === 'tab' && _decOn\.id === tabId\),\n\s+opts\?\.declaredAllergens,/);
  assert.match(round, /note, declaredAllergens: tabDeclared \};/);
  assert.match(round, /declaredAllergens:tabDeclared\}; \}\) \}\)\);/);
  assert.match(round, /allergy: orderAllergyLine\(tabDeclared, centreItems\),/);
  assert.match(round, /allergy: ticketAllergy\(i, tabDeclared\),/);
  assert.ok(!/state\.allergens/.test(round), 'a round never reads the chips of whatever is on screen');
  // The table move docket, and a combine keeps both orders' allergies.
  const transfer = action(store, 'transferTable');
  assert.match(transfer, /allergy: ticketAllergy\(i, orderDeclared\(mergedSession\)\),/);
  assert.match(transfer, /declaredAllergens: allergenIds\(orderDeclared\(to\.session\), orderDeclared\(from\.session\)\),/);
  // Channel orders: the order's own (queue entry or raw row), never customer.allergens.
  assert.match(store, /const channelDeclared = allergenIds\(order\.declaredAllergens, order\.customer\?\.declaredAllergens\);/);
  assert.match(store, /allergy: orderAllergyLine\(channelDeclared, order\.items\),/);
  assert.match(store, /allergy: ticketAllergy\(i, channelDeclared\),/);
  // Nowhere in the store does a ticket read a customer's saved list.
  assert.ok(!/ticketAllergy\([^)]*customer/.test(store));
  assert.ok(!/orderAllergyLine\([^)]*customer\?\.allergens/.test(store));
});

test('source pin: the order_queue row carries the declaration, and a session change to it publishes', () => {
  const qs = read('../sync/QueueSync.js');
  assert.match(qs, /customer: queueCustomerWithDeclared\(o\.customer, o\.declaredAllergens\),/);
  assert.match(qs, /const \{ customer, declaredAllergens \} = declaredFromQueueCustomer\(row\.customer\);/);
  const bridge = read('../sync/SyncBridge.jsx');
  assert.match(bridge, /if \(allergyFieldsDiffer\(t\.session, p\.session\)\) return true;/);
});

// ── Source pins: staff edits and every order switch ────────────────────────────────

test('source pin: the chips EDIT the order on screen; attaching adds once; nothing stamps a line', () => {
  const store = read('../store/index.js');
  // v5: each passes the store's walk in numbering and queues the kitchen update.
  // v6: a tap edits the ORDER's declaration (toggledDeclaration), never the chips alone.
  assert.match(store, /toggleAllergen: id => \{\n\s+set\(s => withDeclaration\(s, toggledDeclaration\(s, id\), Date\.now\(\), _newOrderId\)\);\n\s+get\(\)\._queueKitchenAllergy\(\);/);
  assert.ok(!/s\.allergens\.includes\(id\)/.test(action(store, 'toggleAllergen')));
  assert.match(store, /clearAllergens: \(\) => \{\n\s+set\(s => withDeclaration\(s, \[\], Date\.now\(\), _newOrderId\)\);\n\s+get\(\)\._queueKitchenAllergy\(\);/);
  assert.match(store, /setAllergens: \(arr\) => \{\n\s+set\(s => withDeclaration\(s, Array\.isArray\(arr\) \? arr : \[\], Date\.now\(\), _newOrderId\)\);\n\s+get\(\)\._queueKitchenAllergy\(\);/);
  assert.match(store, /const _newOrderId = \(\) => `ORD-\$\{\+\+_orderNum\}`;/);
  assert.ok(!/loadAllergens|mirrorFilterOntoOrder|orderFilterFor|holdScheduledAllergies|guestAllergens:/.test(store));
  const setCustomer = /setCustomer: \(c, \{ declare = true \} = \{\}\) => \{[\s\S]*?\n {2}\},\n/.exec(store);
  assert.ok(setCustomer, 'setCustomer not found');
  assert.match(setCustomer[0], /if \(!declare\) \{ set\(\{ customer: c \}\); return; \}/);
  assert.match(setCustomer[0], /const \{ patch, brings \} = attachCustomer\(get\(\), c, Date\.now\(\), _newOrderId\);/);
  assert.match(setCustomer[0], /if \(brings\.length\) \{\n\s+get\(\)\._queueKitchenAllergy\(\);/);
  assert.match(store, /\? \{ \.\.\.t, session: sessionWithCustomer\(t\.session, c\) \}/);
  // A new order takes the chips (staff may tap before ringing), in addItem and addCustomItem.
  assert.equal((store.match(/seedDeclared\(s\.walkInOrder\|\|\{id:`ORD-\$\{\+\+_orderNum\}`\}, s, 'walkin'\)/g) || []).length, 2);
  assert.equal((store.match(/, s, 'table', activeTableId\);/g) || []).length, 2);
  assert.match(store, /\}, s, 'table', tableId\);/, 'saveTableSession');
  // The save to a profile is explicit and passes the list it saves.
  assert.match(store, /saveAllergensToCustomer: async \(customer, list = get\(\)\.allergens\) => \{/);
});

test('source pin: every order switch loads that order\'s declaration', () => {
  const store = read('../store/index.js');
  // The follower: any change of the order on screen (table, tab, Bar surface), today's paths and later ones.
  assert.match(store, /useStore\.subscribe\(\(state, prev\) => \{\n\s+const patch = followOrderOnScreen\(state, prev\);\n\s+if \(patch\) useStore\.setState\(patch\);\n\}\);/);
  // Seating declares the guest's saved list (the attach) and shows it.
  const seat = action(store, 'seatTable');
  assert.match(seat, /const declaredAllergens = allergenIds\(seatCustomer\?\.allergens\);/);
  assert.match(seat, /customer: seatCustomer,\n\s+declaredAllergens,/);
  assert.match(seat, /allergens: declaredAllergens \}\);/);
  // The counter's Seat, Merge and New check carry the walk in's declaration to the table.
  for (const name of ['seatTableWithItems', 'mergeItemsToTable', 'splitTableCheck']) {
    const a = action(store, name);
    assert.match(a, /movedFromWalkIn\(st\.walkInOrder, (items|newItems|splitItems)\)/, name);
    assert.match(a, /\? sendDeclared\(st\.walkInOrder, st\.allergens, orderOnScreen\(st\)\.kind === 'walkin'\)/, name);
  }
  assert.match(action(store, 'seatTableWithItems'), /customer:null, allergens: declaredAllergens \}\);/);
  assert.match(action(store, 'splitTableCheck'), /declaredAllergens: childDeclared,[\s\S]*allergens: childDeclared,/);
  assert.match(action(store, 'mergeItemsToTable'), /allergens: orderDeclared\(s\.tables\.find\(t => t\.id === tableId\)\?\.session\) \}\)\);/);
  // Opening a table from the floor plan; a transfer or combine.
  assert.match(action(store, 'openTableInPOS'), /allergens: orderDeclared\(t\?\.session\) \}\);/);
  assert.match(action(store, 'transferTable'), /return \{ tables, activeTableId: toId, allergens: declarationFor\(\{ \.\.\.s, tables, activeTableId: toId \}\) \};/);
  // The walk in swaps that change no order key load for themselves.
  assert.match(action(store, 'clearWalkIn'), /set\(s => \(\{ walkInOrder:null, customer:null, orderType:'dine-in', pendingLoyaltyReward:null, allergens: declarationFor\(\{ \.\.\.s, walkInOrder: null \}\) \}\)\);/);
  const login = action(store, 'login');
  assert.match(login, /operatorSwitchPatch\(withSeededCart\(get\(\)\), newStaff, Date\.now\(\)\)/);
  assert.match(login, /'walkInOrder' in patch \? \{ \.\.\.patch, allergens: declarationFor\(\{ \.\.\.s, \.\.\.patch \}\) \} : patch/);
  assert.match(action(store, 'logout'), /const patch = logoutPatch\(withSeededCart\(s\), Date\.now\(\)\); return \{ \.\.\.patch, allergens: declarationFor\(\{ \.\.\.s, \.\.\.patch \}\) \};/);
  // A bar tab opened for a POS walk in starts with its declaration.
  assert.match(store, /declaredAllergens: allergenIds\(declaredAllergens\) \};/);
});

test('source pin: Orders Hub, MPOS and the Bar load the order they put on screen', () => {
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.match(hub, /const reopenDeclared = orderDeclared\(o\._raw \|\| o\);/);
  assert.match(hub, /declaredAllergens: reopenDeclared,\n\s+\},\n\s+allergens: reopenDeclared,/);
  assert.match(hub, /\.\.\.reopenedAllergyFields\(o\._raw \|\| o, payItems\),\n\s+\},\n\s+allergens: orderDeclared\(o\._raw \|\| o\),/);
  const mpos = read('../surfaces/MPOSSurface.jsx');
  assert.match(mpos, /useStore\.setState\(\{ walkInOrder: null, customer: null, activeTableId: null, allergens: \[\] \}\);/);
  assert.match(mpos, /useStore\.setState\(\{ walkInOrder: null, allergens: orderDeclared\(table\.session\) \}\);/);
  assert.equal((mpos.match(/useStore\.setState\(\{ walkInOrder: null, customer: null, allergens: \[\] \}\);/g) || []).length, 2);
  assert.match(mpos, /if \(!tableId\) useStore\.setState\(\{ walkInOrder: null, customer: null \}\);[\s\S]{0,400}?useStore\.setState\(\{ allergens: \[\] \}\);/);
  const picker = read('../surfaces/mpos/MAllergenPicker.jsx');
  assert.match(picker, /const toggle = \(id\) => toggleAllergen\(id\);/);
  assert.match(picker, /const clearAll = \(\) => clearAllergens\(\);/);
  assert.ok(!/setState\(\{ allergens/.test(picker));
  const bar = read('../surfaces/BarSurface.jsx');
  // The follower loads each tab; the Bar only ever CLEARS a tab's declaration (v5 banner, below).
  assert.ok(!/loadAllergens|setAllergens|toggleAllergen/.test(bar), 'the Bar never sets chips of its own');
  assert.match(bar, /const res = addRoundToTab\(activeTab\.id, roundItems, roundNote\);/);
});

test('source pin: the till shows ONE order banner with Clear, and saves a profile only when asked', () => {
  const pos = read('../surfaces/POSSurface.jsx');
  assert.match(pos, /const declaredOnScreen = onScreenDeclared\(\{ surface: 'pos', activeTableId, tables, walkInOrder, allergens \}\);/);
  assert.match(pos, />ALLERGY: \{declaredLine\}<\/span>/);
  assert.match(pos, /<button onClick=\{clearAllergens\} aria-label="Clear the allergies on this order"/);
  assert.match(pos, /\{declaredNotOnProfile\.length>0&&\(\n\s+<button onClick=\{saveDeclaredToProfile\}/);
  assert.match(pos, /const updatedId = await st\.saveAllergensToCustomer\(cust, list\);/);
  assert.match(pos, /const list = allergenIds\(cust\.allergens, adds\);/, 'additions only');
  // The v5.5.882 auto save is gone: no timer writes a profile from a chip change.
  assert.ok(!/_lastAllergenSaveRef|\}, \[allergens, customer\?\.phone\]\)/.test(pos));
  // The table hydrate shows the guest without declaring anything, and never sets the chips.
  assert.match(pos, /setCustomer\(sessionCust, \{ declare: false \}\);/);
  assert.ok(!/setAllergens\(sessionCust/.test(pos));
  // No per line allergy display (the order banner is the one place).
  const row = /function OrderItem\(\{[\s\S]*?\n\}\n/.exec(pos);
  assert.ok(row && !/declaredAllergy|guestAllergens/.test(row[0]));
  // Paying no longer clears: clearTable / clearWalkIn put the next order on screen and it loads.
  assert.ok(!/clearCustomer\(\);\n\s+clearAllergens\(\);/.test(pos));
  // The POS hands a walk in's declaration to the bar tab it goes to.
  assert.match(pos, /store\.openTab\(\{ name: result\.tabName, declaredAllergens: onScreenDeclared\(store\) \}\)/);
  assert.match(pos, /store\.addRoundToTab\(result\.tabId, items, '', \{ declaredAllergens: onScreenDeclared\(store\) \}\)/);
  // Taking the wrong customer off removes what their attach added (the order's record), nothing else.
  assert.match(pos, /if \(orderType === 'dine-in' && activeTableId\) setSessionCustomer\(activeTableId, null\);\n\s+dropCustomerAllergies\(customer\);\n\s+clearCustomer\(\);/);
  const cart = read('../surfaces/mpos/MCartSheet.jsx');
  assert.match(cart, /const declaredLine = declaredAllergyLine\(onScreenDeclared\(\{ surface, activeTabId, tabs, activeTableId, tables, walkInOrder, allergens \}\)\);/);
  assert.match(cart, /⚠ ALLERGY: \{declaredLine\}<\/span>/);
  assert.match(cart, /<button onClick=\{\(\) => clearAllergens\(\)\} aria-label="Clear the allergies on this order"/);
  assert.ok(!/guestAllergens/.test(cart));
});

// ── v5 (26 Sep 2026): the review of v4 ──────────────────────────────────────────

test('v5, major 1: Tree nuts tapped before the first item survives the Bar, a table peek and back, and prints', () => {
  let s = toggle(base(), 'nuts');                        // an empty walk in: the tap makes its order
  assert.ok(s.walkInOrder?.id, 'the walk in has an order number');
  assert.deepEqual(s.walkInOrder.items, []);
  assert.deepEqual(s.walkInOrder.declaredAllergens, ['nuts']);
  const bar = { surface: 'bar', activeTabId: 'tab-x', tabs: [{ id: 'tab-x', rounds: [] }] };
  s = go(s, bar);
  assert.deepEqual(s.allergens, [], 'the tab declares nothing');
  s = go(s, { surface: 'pos', activeTabId: null });
  assert.deepEqual(s.allergens, ['nuts'], 'back at the counter: the walk in still has it');
  s = go(s, { activeTableId: 't2' });                    // peek at T2 (milk)
  assert.deepEqual(s.allergens, ['milk']);
  s = go(s, { activeTableId: null });
  assert.deepEqual(s.allergens, ['nuts']);
  // Ring (addItem keeps the order object and its field), send: the ticket carries it.
  const rung = { ...seedDeclared(s.walkInOrder, s, 'walkin'), items: [line()] };
  assert.equal(rung.id, s.walkInOrder.id);
  const declared = sendDeclared(rung, s.allergens, true);
  assert.equal(orderAllergyLine(declared, rung.items), 'TREE NUTS');
  assert.equal(ticketAllergy(rung.items[0], declared), 'TREE NUTS');
});

test('v5, major 1: a customer attached before ringing keeps their allergy through the Bar and back (the review\'s case c)', () => {
  const ANN = { name: 'Ann', phone: '07700 900555', allergens: ['peanuts'] };
  let s = attach(base(), ANN);
  assert.deepEqual(s.walkInOrder.declaredAllergens, ['peanuts']);
  assert.deepEqual(s.walkInOrder.attachedProfiles, [{ guest: { phone: ANN.phone, name: 'Ann' }, added: ['peanuts'] }]);
  s = go(go(s, { surface: 'bar', activeTabId: 'tab-x', tabs: [{ id: 'tab-x', rounds: [] }] }), { surface: 'pos', activeTabId: null });
  assert.deepEqual(s.allergens, ['peanuts']);
  s = attach(s, ANN);                                     // attached again: the order has her already
  assert.deepEqual(s.walkInOrder.declaredAllergens, ['peanuts']);
  assert.equal(s.walkInOrder.attachedProfiles.length, 1);
  const rung = { ...seedDeclared(s.walkInOrder, s, 'walkin'), items: [line()] };
  assert.equal(orderAllergyLine(sendDeclared(rung, s.allergens, true), rung.items), 'PEANUTS');
  // An operator swap with nothing rung gives the next operator a clean checkout (cartHold):
  // the empty order object is not holdable, so nothing of Ann's reaches them.
  assert.deepEqual(declarationFor({ ...s, walkInOrder: null }), []);
});

test('v5, major 2: a table\'s guest left on screen at the walk in; attaching them again declares their allergies there', () => {
  const SAMM = { name: 'Sam', phone: '07700 900777', allergens: ['milk'] };
  // T1 took Sam's profile (the floor plan's Add guest), then was sent; the till goes to the walk in
  // with Sam still showing (the table hydrate never clears the customer at the walk in).
  let s = base({ activeTableId: 't1' });
  s = { ...s, tables: s.tables.map(t => (t.id === 't1' ? { ...t, session: sessionWithCustomer(t.session, SAMM, 1) } : t)), customer: SAMM };
  assert.deepEqual(tableSession(s, 't1').declaredAllergens, ['milk']);
  s = go(s, { activeTableId: null });
  assert.deepEqual(s.allergens, [], 'the walk in is a new order');
  assert.equal(s.customer, SAMM, 'the till still shows Sam');
  assert.ok(!profileTaken(s.walkInOrder, SAMM), 'judged on THIS order, not the global customer');
  const res = attachCustomer(s, SAMM, 1, newId);
  assert.deepEqual(res.brings, ['milk']);
  s = { ...s, ...res.patch };
  const rung = { ...seedDeclared(s.walkInOrder, s, 'walkin'), items: [line()] };
  assert.equal(orderAllergyLine(sendDeclared(rung, s.allergens, true), rung.items), 'MILK');
  // Still once per order: attached again on the walk in, nothing more.
  assert.deepEqual(attachCustomer(s, SAMM, 1, newId).brings, []);
});

test('v5: the same guest by phone whatever their id (a local cache id and a database id are one person)', () => {
  assert.ok(sameGuest({ id: 'c1690000', phone: '07700 900123' }, { id: 'uuid-9', phone: '+44 7700 900123' }));
  assert.ok(!sameGuest({ id: 'uuid-9', phone: '07700 900123' }, { id: 'uuid-9', phone: '07000 111222' }), 'a different phone is a different person');
  assert.deepEqual(guestKey({ id: 7, name: 'Sam', phone: '1', allergens: ['nuts'], email: 'x' }), { id: '7', phone: '1', name: 'Sam' });
  assert.deepEqual(mergeProfiles([{ guest: { phone: '07700 900123' }, added: ['nuts'] }], [{ guest: { phone: '+447700900123' }, added: [] }, { guest: { name: 'Jo' }, added: [] }]).length, 2);
  assert.deepEqual(seatedProfiles({ name: 'Sam', phone: '1', allergens: ['nuts', 'milk'] }, ['milk']), [{ guest: { phone: '1', name: 'Sam' }, added: ['nuts'] }]);
  assert.deepEqual(seatedProfiles({ name: 'Al' }), []);
});

test('v5, major 3: the customer modal never carries one guest\'s allergies onto another', () => {
  const SAMP = { id: 'uuid-1', name: 'Sam', phone: '07700 900123', allergens: ['milk'] };
  // Editing Sam's details, same phone in another format: Sam's own list survives (v5.5.894).
  assert.deepEqual(confirmedGuestAllergens(SAMP, { name: 'Sam B', phone: '+44 7700 900123' }), ['milk']);
  // Typed into a different guest, Jo: a new phone with no profile, or a profile holding none.
  assert.deepEqual(confirmedGuestAllergens(SAMP, { name: 'Jo', phone: '07000 111222' }), []);
  assert.deepEqual(confirmedGuestAllergens(SAMP, { name: 'Jo', phone: '07000 111222' }, { name: 'Jo', phone: '+447000111222', allergens: [] }), []);
  // Jo's own profile holds eggs: Jo's list.
  assert.deepEqual(confirmedGuestAllergens(SAMP, { name: 'Jo', phone: '07000 111222' }, { allergens: ['eggs'] }), ['eggs']);
  assert.deepEqual(confirmedGuestAllergens(null, { name: 'Jo', phone: '07000 111222' }), []);
  // End to end: the order Sam was on, milk cleared by staff, the modal turned into Jo: no MILK.
  let s = attach(base({ walkInOrder: { id: 'w', items: [line()], declaredAllergens: [] } }), SAMP);
  s = clearAll(s);
  const jo = { name: 'Jo', phone: '07000 111222', ...(() => { const a = confirmedGuestAllergens(SAMP, { name: 'Jo', phone: '07000 111222' }); return a.length ? { allergens: a } : {}; })() };
  s = attach(s, jo);
  assert.deepEqual(s.walkInOrder.declaredAllergens, []);
  assert.equal(orderAllergyLine(sendDeclared(s.walkInOrder, s.allergens, true), s.walkInOrder.items), null);
});

test('v5, major 3: the customer display\'s phone capture never carries the attached guest onto another phone', () => {
  const cur = { id: 'uuid-1', name: 'Sam', phone: '07700 900123', allergens: ['milk'], email: 'sam@x' };
  const other = customerWithPhone(cur, '07000 111222', null);
  assert.equal(other.allergens, undefined);
  assert.equal(other.id, undefined);
  assert.equal(other.phone, '07000 111222');
  const same = customerWithPhone(cur, '+447700900123', 'Samuel');
  assert.deepEqual(same.allergens, ['milk']);
  assert.equal(same.id, 'uuid-1');
  assert.equal(same.name, 'Samuel');
  assert.deepEqual(customerWithPhone(null, '07000 1', 'Al'), { phone: '07000 1', name: 'Al' });
  // A name only customer gaining a phone keeps what staff gave them.
  assert.deepEqual(customerWithPhone({ name: 'Al', allergens: ['eggs'] }, '07000 1', null).allergens, ['eggs']);
});

test('v5, major 4: Tree nuts declared after the send (course 2 held) reaches the kitchen, once', () => {
  const sent = [line({ uid: 'a', status: 'sent', fired: true, course: 1 }), line({ uid: 'b', status: 'sent', fired: false, course: 2 })];
  let s = base({ activeTableId: 't1' });
  s = { ...s, tables: s.tables.map(t => (t.id === 't1' ? { ...t, session: { ...t.session, items: sent, declaredAllergens: [], kitchenAllergens: [] } } : t)) };
  assert.equal(kitchenAllergyUpdate(tableSession(s, 't1')), null, 'the kitchen has everything declared');
  assert.equal(kitchenKeyFor(s), 'table:t1:ORD-1');
  s = toggle(s, 'nuts');                                   // the guest mentions it during starters
  const upd = kitchenAllergyUpdate(tableSession(s, 't1'));
  assert.deepEqual(upd.added, ['nuts']);
  assert.deepEqual(upd.ids, ['nuts']);
  assert.deepEqual(upd.lines.map(i => i.uid), ['a', 'b'], 'the held main too');
  // The order's open tickets get it on every line and in meta; the last party's ticket at T1 does not.
  const uids = new Set(upd.lines.map(i => i.uid));
  const ticket = { id: 'k1', table: 'T1', centreId: 'pc1', meta: { channel: 'table', allergy: null }, items: [{ uid: 'a', name: 'Soup', course: 1 }, { uid: 'b', name: 'Steak', course: 2, fired: false }] };
  assert.ok(ticketHoldsLines(ticket, uids));
  const tagged = retagOrderTicket(ticket, 'TREE NUTS');
  assert.deepEqual(tagged.items.map(i => i.allergy), ['TREE NUTS', 'TREE NUTS']);
  assert.equal(tagged.meta.allergy, 'TREE NUTS');
  assert.equal(tagged.meta.channel, 'table', 'the rest of meta stays');
  assert.equal(ticketAllergyBanner(tagged.meta, tagged.items), 'TREE NUTS');
  assert.ok(!ticketHoldsLines({ id: 'k0', items: [{ uid: 'z', name: 'Old party' }] }, uids));
  assert.equal(retagOrderTicket(tagged, 'TREE NUTS'), null, 'already shows it');
  // A row written before the meta column keeps meta null (its header is read from the label);
  // the KDS banner then comes from the lines.
  const legacy = retagOrderTicket({ ...ticket, meta: null }, 'TREE NUTS');
  assert.equal(legacy.meta, null);
  assert.equal(ticketAllergyBanner(null, legacy.items), 'TREE NUTS');
  // Told: recorded on the order (published), so nothing more to tell.
  const found = kitchenOrderByKey(s, 'table:t1:ORD-1');
  assert.equal(found.label, 'T1');
  s = { ...s, ...kitchenToldPatch(s, found, upd.ids, 9) };
  assert.deepEqual(tableSession(s, 't1').kitchenAllergens, ['nuts']);
  assert.equal(tableSession(s, 't1').lastUpdated, 9);
  assert.equal(kitchenAllergyUpdate(tableSession(s, 't1')), null);
  // Milk added too: only milk is new, the kitchen then holds both.
  s = toggle(s, 'milk');
  assert.deepEqual(kitchenAllergyUpdate(tableSession(s, 't1')).added, ['milk']);
  assert.deepEqual(kitchenAllergyUpdate(tableSession(s, 't1')).ids, ['nuts', 'milk']);
});

test('v5, major 4: taken off after the send stays with the kitchen, and the till says so', () => {
  const session = { id: 'ORD-5', items: [line({ status: 'sent' })], declaredAllergens: [], kitchenAllergens: ['nuts'] };
  assert.equal(kitchenAllergyUpdate(session), null, 'a removal never travels');
  assert.deepEqual(kitchenOnly(session), ['nuts']);
  assert.deepEqual(kitchenOnly({ ...session, declaredAllergens: ['nuts'] }), []);
  assert.deepEqual(kitchenOnly({ ...session, items: [line()] }), [], 'nothing in the kitchen yet');
  // A send records what its tickets carried; a send that made no ticket records nothing new.
  assert.deepEqual(kitchenAfterSend(session, ['milk'], true), ['nuts', 'milk']);
  assert.deepEqual(kitchenAfterSend(session, ['milk'], false), ['nuts']);
  assert.deepEqual(kitchenAfterSend({}, [], true), []);
  // Voided and revenue only lines are not the kitchen's.
  assert.equal(kitchenLines({ items: [line({ status: 'sent', voided: true }), line({ status: 'sent', noKitchen: true }), line()] }).length, 0);
});

test('v5, major 4: which order a kitchen update belongs to', () => {
  const sentLine = line({ status: 'sent' });
  const s = base({
    tables: [{ id: 't1', label: 'T1', session: { id: 'ORD-1', items: [sentLine], declaredAllergens: ['nuts'] } }],
    walkInOrder: { id: 'ORD-7', ref: '#41', items: [sentLine], declaredAllergens: ['eggs'] },
    orderQueue: [{ ref: '#41', declaredAllergens: [] }, { ref: '#42' }],
  });
  assert.equal(kitchenKeyFor(s), 'walkin:ORD-7');
  assert.equal(kitchenKeyFor(s, { walkIn: true }), 'walkin:ORD-7');
  assert.equal(kitchenKeyFor(s, { tableId: 't1' }), 'table:t1:ORD-1');
  assert.equal(kitchenKeyFor({ ...s, walkInOrder: { id: 'ORD-8', items: [line()] } }), null, 'nothing in the kitchen yet: the send carries it');
  assert.equal(kitchenKeyFor({ ...s, surface: 'bar', activeTabId: 'tab-1', tabs: [{ id: 'tab-1', rounds: [] }] }), null, 'a tab: each round carries it');
  // A new party at the same table (another session id) is not the order the timer was for.
  assert.equal(kitchenOrderByKey(s, 'table:t1:ORD-0'), null);
  assert.equal(kitchenOrderByKey(s, 'walkin:ORD-6'), null);
  // The walk in: its Orders Hub entry keeps the allergy for a reopen on any till.
  const found = kitchenOrderByKey(s, 'walkin:ORD-7');
  const patch = kitchenToldPatch(s, found, ['eggs'], 1);
  assert.deepEqual(patch.walkInOrder.kitchenAllergens, ['eggs']);
  assert.deepEqual(patch.orderQueue[0].declaredAllergens, ['eggs']);
  assert.equal(patch.orderQueue[1], s.orderQueue[1]);
});

test('v5, minor: taking the wrong customer off removes what their attach added, never a staff tap they share', () => {
  const WRONG = { name: 'Wrong', phone: '07000 999999', allergens: ['milk', 'nuts'] };
  let s = base({ walkInOrder: { id: 'w', items: [line()], declaredAllergens: [] } });
  s = toggle(s, 'milk');                                   // the guest told staff: milk
  s = attach(s, WRONG);                                    // the wrong profile also holds milk
  assert.deepEqual(s.walkInOrder.declaredAllergens, ['milk', 'nuts']);
  assert.deepEqual(s.walkInOrder.attachedProfiles[0].added, ['nuts'], 'only what the attach ADDED');
  const res = detachCustomer(s, { name: 'Wrong', phone: '+447000999999' }, 1);
  assert.deepEqual(res.dropped, ['nuts']);
  s = { ...s, ...res.patch };
  assert.deepEqual(s.walkInOrder.declaredAllergens, ['milk'], 'MILK stays on the order and the docket');
  assert.deepEqual(s.allergens, ['milk']);
  assert.deepEqual(s.walkInOrder.attachedProfiles, []);
  // An allergy the profile added, cleared and then tapped again by staff is theirs: it stays.
  let t = attach(base({ walkInOrder: { id: 'w', items: [line()], declaredAllergens: [] } }), SAM);
  t = toggle(clearAll(t), 'nuts');
  assert.deepEqual(t.walkInOrder.attachedProfiles[0].added, []);
  t = detach(t, SAM);
  assert.deepEqual(t.walkInOrder.declaredAllergens, ['nuts']);
  // A table: the session's own record.
  let u = attach(base({ activeTableId: 't1' }), SAM);
  u = detach(u, SAM);
  assert.deepEqual(tableSession(u, 't1').declaredAllergens, []);
  assert.equal(tableSession(u, 't1').lastUpdated, 1);
  // A customer this order never took: nothing to take off.
  assert.equal(detachCustomer(base(), SAM, 1), null);
});

test('v5, minor: a bar tab\'s declaration can be cleared, and the next round then carries none', () => {
  // A tab read back from bar_tabs (a reload): its last round's record stands in.
  let s = base({ surface: 'bar', activeTabId: 'tab-a', tabs: [{ id: 'tab-a', rounds: [{ declaredAllergens: ['nuts'] }] }], allergens: ['nuts'] });
  assert.deepEqual(onScreenDeclared(s), ['nuts']);
  s = clearAll(s);
  assert.deepEqual(s.tabs[0].declaredAllergens, []);
  assert.deepEqual(orderDeclared(s.tabs[0]), [], 'the tab\'s own field wins over the last round');
  assert.deepEqual(sendDeclared(s.tabs[0], s.allergens, true), []);
});

test('v5, minor: a QR rebuild keeps a till\'s declaration; SyncBridge publishes every allergy field', () => {
  assert.deepEqual(carryOrderAllergy({ items: [], declaredAllergens: ['Dairy'], kitchenAllergens: [], attachedProfiles: [{ guest: { name: 'A' }, added: [] }] }),
    { declaredAllergens: ['milk'], kitchenAllergens: [], attachedProfiles: [{ guest: { name: 'A' }, added: [] }] });
  assert.deepEqual(carryOrderAllergy({ items: [] }), {});
  assert.deepEqual(carryOrderAllergy(null), {});
  const a = { declaredAllergens: ['nuts'], kitchenAllergens: ['nuts'], attachedProfiles: [] };
  assert.ok(!allergyFieldsDiffer(a, { ...a, declaredAllergens: ['nuts'] }));
  assert.ok(allergyFieldsDiffer(a, { ...a, declaredAllergens: [] }));
  assert.ok(allergyFieldsDiffer(a, { ...a, kitchenAllergens: [] }));
  assert.ok(allergyFieldsDiffer(a, { ...a, attachedProfiles: [{ guest: { name: 'A' }, added: [] }] }));
  assert.ok(!allergyFieldsDiffer({}, { declaredAllergens: [] }), 'an old session and an empty one agree');
});

// ── v5 source pins ─────────────────────────────────────────────────────────────

test('source pin v5: the kitchen hears a late allergy: timer after an edit, at once on a send or a fire', () => {
  const store = read('../store/index.js');
  assert.match(store, /const KITCHEN_ALLERGY_SETTLE_MS = 4000;/);
  const tell = action(store, 'tellKitchenAllergy');
  assert.match(tell, /const upd = found \? kitchenAllergyUpdate\(found\.order\) : null;\n\s+if \(!upd\) return false;/);
  assert.match(tell, /kdsTickets: \(s\.kdsTickets \|\| \[\]\)\.map\(tk => \(isOrders\(tk\) \? \(retagOrderTicket\(tk, line\) \|\| tk\) : tk\)\),\n\s+\.\.\.kitchenToldPatch\(s, found, upd\.ids, Date\.now\(\)\),/);
  assert.match(tell, /type: 'allergy-update', allergy: line, added: addedLine,/);
  assert.match(tell, /resolveCentresForItem\(i, routingConfig, routingCtx\)/, 'lines on no known ticket are routed like the send');
  assert.match(tell, /\.in\('status', \['pending', 'held'\]\)/);
  assert.match(tell, /const next = retagOrderTicket\(row, line\);/);
  assert.match(tell, /table: 'kds_tickets', type: 'update',\n\s+payload: \{ items: next\.items, \.\.\.\(next\.meta && row\.meta \? \{ meta: next\.meta \} : \{\}\) \},/);
  assert.ok(!/import\(/.test(tell), 'static imports only');
  // Flush points: the send (before its new tickets) and the course fire (before the fire docket).
  const send = action(store, 'sendToKitchen');
  const flushAt = send.indexOf("get().flushKitchenAllergy(targetTableId ? { tableId: targetTableId } : { walkIn: true });");
  assert.ok(flushAt > -1 && flushAt < send.indexOf('const createKdsTickets'));
  assert.match(send, /kitchenAllergens: kitchenAfterSend\(t\.session, tableAllergens, newTickets\.length > 0\),/);
  assert.match(send, /kitchenAllergens: kitchenAfterSend\(s\.walkInOrder, walkInAllergens, newTickets\.length > 0\),/);
  const fire = action(store, 'fireCourse');
  assert.ok(fire.indexOf('get().flushKitchenAllergy({ tableId: get().activeTableId });') < fire.indexOf("type: 'fire-marker'"));
  assert.match(fire, /\.\.\.\(fireAllergy \? \{ allergy: fireAllergy \} : \{\}\),/);
  // The edits that queue it.
  assert.match(action(store, 'setSessionCustomer'), /get\(\)\._queueKitchenAllergy\(\{ tableId \}\);/);
  assert.match(action(store, 'mergeItemsToTable'), /get\(\)\._queueKitchenAllergy\(\{ tableId \}\);/);
  assert.match(action(store, 'transferTable'), /if \(destHasSession\) get\(\)\._queueKitchenAllergy\(\{ tableId: toId \}\);/);
  assert.match(action(store, 'transferTable'), /get\(\)\.flushKitchenAllergy\(\{ tableId: fromId \}\);\n\s+get\(\)\.flushKitchenAllergy\(\{ tableId: toId \}\);\n\s+const \{ tables \} = get\(\);/, 'a waiting update goes before the move');
  const flush = action(store, 'flushKitchenAllergy');
  assert.match(flush, /try \{[\s\S]*\} catch \(e\) \{/, 'never throws into a send');
  // routePrintJob: its own builder, never split per item, never a kitchen ticket.
  const route = action(store, 'routePrintJob');
  assert.match(route, /const isAllergyUpdate = job\.type === 'allergy-update';/);
  assert.match(route, /if \(!isFireMarker && !isTransferNotice && !isAllergyUpdate && centre\?\.splitPerItem\) \{/);
  assert.match(route, /\? await printService\.printAllergyUpdateTicket\(\{/);
  assert.match(route, /\.\.\.\(job\.allergy \? \{ allergy: job\.allergy \} : \{\}\),/, 'the fire marker carries it');
  const printer = read('./printer.js');
  assert.match(printer, /async printAllergyUpdateTicket\(ticketData, printerId = null, opts = \{\}\) \{/);
  assert.match(printer, /buildAllergyUpdateTicketDoc\(ticketData, \{ cols: resolvePrinterSpec\(printer\)\.cols \}\)/);
});

test('source pin v5: attach once is the order\'s record everywhere a guest joins an order', () => {
  const store = read('../store/index.js');
  assert.match(action(store, 'seatTable'), /attachedProfiles: seatedProfiles\(seatCustomer\),/);
  assert.match(action(store, 'seatTableWithItems'), /attachedProfiles: mergeProfiles\(movedWalkIn \? attachedProfiles\(st\.walkInOrder\) : \[\], seatedProfiles\(customer, walkInDeclared\)\),/);
  assert.match(action(store, 'transferTable'), /attachedProfiles: mergeProfiles\(attachedProfiles\(to\.session\), attachedProfiles\(from\.session\)\),/);
  assert.match(action(store, 'dropCustomerAllergies'), /const res = detachCustomer\(get\(\), c\);/);
  // The customer modal: the same guest's list only, and never written to a profile from here.
  const modal = read('../components/CustomerModal.jsx');
  assert.match(modal, /const finalAllergens = confirmedGuestAllergens\(existing, \{ name: name\.trim\(\), phone: phone\.trim\(\) \}, matchedProfile\);/);
  assert.ok(!/Array\.isArray\(existing\?\.allergens\) \? existing\.allergens/.test(modal), 'no longer starts from the attached customer');
  assert.match(modal, /addToHistory\(customer, \{ saveAllergens: false \}\);/);
  assert.match(action(store, 'addToHistory'), /get\(\)\.upsertCustomer\(saveAllergens \? c : \{ \.\.\.c, allergens: undefined \}\)/);
  // The customer display's phone capture.
  const pos = read('../surfaces/POSSurface.jsx');
  assert.match(pos, /setCustomer\(customerWithPhone\(cur, phone, res\.name\)\);/);
  assert.ok(!/setCustomer\(\{ \.\.\.cur, phone/.test(pos));
});

test('source pin v5: the till shows what the kitchen still has, offers the profile\'s missing allergies, and the Bar can clear a tab', () => {
  const pos = read('../surfaces/POSSurface.jsx');
  assert.match(pos, /const kitchenStillHas = kitchenOnly\(activeTableId \? session : walkInOrder\);/);
  assert.match(pos, /The kitchen still has \{declaredAllergyLine\(kitchenStillHas\)\} for this order\. Tell them if that was a mistake\./);
  assert.match(pos, /<button onClick=\{\(\)=>setAllergens\(allergenIds\(declaredOnScreen, profileNotDeclared\)\)\}[^>]*>Add to this order<\/button>/);
  const cart = read('../surfaces/mpos/MCartSheet.jsx');
  assert.match(cart, /const kitchenStillLine = declaredAllergyLine\(kitchenOnly\(/);
  const bar = read('../surfaces/BarSurface.jsx');
  assert.match(bar, /const tabAllergyLine = activeTab \? declaredAllergyLine\(onScreenDeclared\(\{ surface: 'bar', activeTabId, tabs, allergens \}\)\) : null;/);
  assert.match(bar, /<button onClick=\{clearAllergens\} aria-label="Clear the allergies on this tab"/);
  const qr = read('./qrTableSession.js');
  assert.match(qr, /\.\.\.carryOrderAllergy\(existing\?\.session\),/);
});

// ── v6 (26 Sep 2026): the review of v5 ──────────────────────────────────────────
// Peter's ask stands: "when allergies are selected it should come up on the KDS and the ticket
// printed". The review of v5 proved the late ALLERGY UPDATE could mark ANOTHER guest's ticket,
// could be lost when the order left the till inside the settle time, re-announced a reopened
// order, and left the last party's chips on a table paid on another device.

const live = () => 'live';
const docketNames = (plan) => plan.docket.map(([cid, ls]) => [cid, ls.map(l => l.name)]);

test('v6, blocker: two orders share a line uid; a late allergy touches only THIS order\'s recorded ticket', () => {
  // Line uids were i1, i2 ... on every till and after every reload: T1's soup and another till's
  // takeaway latte were both i1, and v5 marked Jo's LATTE "TREE NUTS" and printed it instead.
  const soup = line({ uid: 'i1', name: 'Soup', status: 'sent', fired: true, course: 1 });
  const ownTicket = { id: 'kds-t1', table: 'T1', centreId: 'pc1', status: 'pending', meta: { channel: 'table', allergy: null }, items: [{ uid: 'i1', name: 'SOUP', course: 1 }] };
  const joTicket = { id: 'kds-jo', table: 'Takeaway · Jo', centreId: 'pc1', status: 'pending', meta: { channel: 'till', orderNo: '41', allergy: null }, items: [{ uid: 'i1', name: 'LATTE', course: 1 }] };
  // The send records its tickets on the order: id, centre, line uids, what they carried.
  let session = { id: 'ORD-1', items: [soup], declaredAllergens: [], kitchenAllergens: [] };
  session = { ...session, kitchenTickets: kitchenTicketsAfterSend(session, [ownTicket], []) };
  assert.deepEqual(session.kitchenTickets, [{ id: 'kds-t1', centreId: 'pc1', uids: ['i1'], allergens: [] }]);
  assert.deepEqual(kitchenTicketsAfterSend(session, [], ['nuts']), session.kitchenTickets, 'a send that made no ticket adds none');
  let s = base({ activeTableId: 't1', tables: [{ id: 't1', label: 'T1', session }] });
  s = toggle(s, 'nuts');                                     // declared after the send
  const upd = kitchenAllergyUpdate(tableSession(s, 't1'));
  assert.deepEqual(upd.stale.map(r => r.id), ['kds-t1']);
  assert.deepEqual(upd.loose, []);
  const plan = kitchenUpdatePlan(upd, live, []);
  assert.deepEqual(plan.retag, ['kds-t1'], 'only the order\'s own ticket, by its id');
  assert.deepEqual(docketNames(plan), [['pc1', ['Soup']]], 'the docket lists T1\'s soup, never the latte');
  assert.deepEqual(plan.route, []);
  // Told once: the order and its ticket record now hold it.
  s = { ...s, ...kitchenToldPatch(s, kitchenOrderByKey(s, 'table:t1:ORD-1'), upd.ids, 5) };
  assert.deepEqual(tableSession(s, 't1').kitchenTickets[0].allergens, ['nuts']);
  assert.equal(kitchenAllergyUpdate(tableSession(s, 't1')), null);
  // A line on no recorded ticket (sent before v6) is matched by its uid AND this order's own
  // table label or order number, never by the uid alone.
  assert.ok(ticketIsOrders(ownTicket, { label: 'T1' }));
  assert.ok(!ticketIsOrders(joTicket, { label: 'T1' }), 'the same uid on another order is not this order\'s');
  assert.ok(ticketIsOrders(joTicket, { orderNo: '41' }));
  assert.ok(!ticketIsOrders(ownTicket, { orderNo: '41' }));
  assert.ok(ticketIsOrders({ table_label: 'T1', items: [] }, { label: 'T1' }), 'a kds_tickets row');
  assert.ok(!ticketIsOrders(joTicket, null));
  // ...and never a ticket sent before this party sat down (the last party's at the same table).
  const seated = 1790000000000;
  assert.ok(!ticketIsOrders({ ...ownTicket, sentAt: seated - 5 * 60000 }, { label: 'T1', since: seated }));
  assert.ok(ticketIsOrders({ ...ownTicket, sentAt: seated + 1000 }, { label: 'T1', since: seated }));
  assert.ok(ticketIsOrders({ table_label: 'T1', sent_at: new Date(seated - 30000).toISOString(), items: [] }, { label: 'T1', since: seated }), 'a minute of grace for another till\'s clock');
  assert.ok(!ticketIsOrders({ table_label: 'T1', sent_at: new Date(seated - 3600000).toISOString(), items: [] }, { label: 'T1', since: seated }));
  assert.ok(ticketIsOrders(ownTicket, { label: 'T1', since: seated }), 'a ticket with no time is judged by its label');
  const legacy = { id: 'ORD-2', items: [soup], declaredAllergens: ['nuts'], kitchenAllergens: [] };
  const lupd = kitchenAllergyUpdate(legacy);
  assert.deepEqual(lupd.loose.map(l => l.uid), ['i1']);
  const scoped = [ownTicket, joTicket].filter(t => ticketHoldsLines(t, ['i1']) && ticketIsOrders(t, { label: 'T1' }));
  const lplan = kitchenUpdatePlan(lupd, live, scoped);
  assert.deepEqual(lplan.retag, ['kds-t1']);
  assert.deepEqual(docketNames(lplan), [['pc1', ['Soup']]]);
  // Nothing known holds it: routed the way the send routed it (the store's fallback).
  assert.deepEqual(kitchenUpdatePlan(lupd, live, []).route.map(l => l.uid), ['i1']);
});

test('v6, blocker: new line uids are unique per till and per page load', () => {
  const a = lineUidMaker(1790000000000, 0.25);
  const b = lineUidMaker(1790000000000, 0.75);               // another till loaded in the same millisecond
  const c = lineUidMaker(1790000000001, 0.25);               // this till after a reload
  const first = [a(), b(), c()];
  assert.equal(new Set(first).size, 3);
  assert.match(first[0], /^i[0-9a-z]+-1$/);
  assert.equal(a(), first[0].replace(/-1$/, '-2'), 'then a counter');
});

test('v6, major: the order leaves the till inside the settle time; the kitchen is still told, and nothing lands on the next order', () => {
  // (C1) a walk in sent and kept on screen for payment; the guest mentions a nut allergy at the tender.
  const soup = line({ uid: 'ix-1', name: 'Soup', status: 'sent', fired: true });
  const rec = { id: 'kds-w', centreId: 'pc1', uids: ['ix-1'], allergens: [] };
  let s = base({ walkInOrder: { id: 'ORD-7', ref: 'R41', items: [soup], declaredAllergens: [], kitchenAllergens: [], kitchenTickets: [rec] }, orderQueue: [{ ref: 'R41', declaredAllergens: [], kitchenTickets: [rec] }] });
  s = toggle(s, 'nuts');
  const key = kitchenKeyFor(s, { walkIn: true });
  assert.equal(key, 'walkin:ORD-7');
  const last = kitchenOrderByKey(s, key);                    // what the settle timer keeps (the store's `last`)
  // Paid and cleared before the timer runs: nothing is on screen, or the next order is.
  const after = { ...s, walkInOrder: null, allergens: [] };
  assert.equal(kitchenOrderByKey(after, key), null);
  const found = kitchenOrderByKey(after, key) || last;
  const upd = kitchenAllergyUpdate(found.order);
  assert.deepEqual(upd.added, ['nuts'], 'the kitchen is told all the same');
  const patch = kitchenToldPatch(after, found, upd.ids, 1);
  assert.ok(!('walkInOrder' in patch), 'nothing is recorded on whatever order is on screen now');
  assert.deepEqual(patch.orderQueue[0].declaredAllergens, ['nuts'], 'its Orders Hub entry remembers the kitchen has it');
  assert.deepEqual(patch.orderQueue[0].kitchenTickets[0].allergens, ['nuts']);
  // (C2) a table paid inside the settle time and the next party seated there: the kitchen is told
  // for the paid party, and the new party is never marked told.
  const sent = { id: 'ORD-1', items: [soup], declaredAllergens: [], kitchenAllergens: [], kitchenTickets: [rec] };
  let t = toggle(base({ activeTableId: 't1', tables: [{ id: 't1', label: 'T1', session: sent }] }), 'sesame');
  const tkey = kitchenKeyFor(t, { tableId: 't1' });
  const tlast = kitchenOrderByKey(t, tkey);
  t = { ...t, tables: [{ id: 't1', label: 'T1', session: { id: 'ORD-9', items: [soup], declaredAllergens: [] } }] };
  assert.equal(kitchenOrderByKey(t, tkey), null, 'another session at the same table is another order');
  assert.deepEqual(kitchenAllergyUpdate(tlast.order).added, ['sesame']);
  assert.deepEqual(kitchenToldPatch(t, tlast, ['sesame'], 1).tables, t.tables, 'the new party is untouched');
});

test('v6, major: an Orders Hub reopen of a sent walk in announces nothing the kitchen already has', () => {
  // The counter's "send now, pay at collection": sent with TREE NUTS, cleared, reopened later.
  const soup = line({ uid: 'ia-1', name: 'Soup', status: 'sent', fired: true });
  const here = { ref: 'R41', items: [soup], declaredAllergens: ['nuts'], kitchenTickets: [{ id: 'kds-a', centreId: 'pc1', uids: ['ia-1'], allergens: ['nuts'] }] };
  const elsewhere = { ref: 'R41', items: [soup], declaredAllergens: ['nuts'] };   // QueueSync carries the declaration only
  for (const e of [here, elsewhere]) {
    // OrdersHub.openOrder's walk in, as it builds it.
    const reopen = () => base({ walkInOrder: { id: 'ORD-R41', ref: e.ref, items: e.items, ...reopenedAllergyFields(e, e.items), declaredAllergens: orderDeclared(e) }, allergens: orderDeclared(e) });
    const s = reopen();
    assert.deepEqual(s.walkInOrder.kitchenAllergens, ['nuts'], 'the kitchen got it at the send');
    assert.equal(kitchenAllergyUpdate(s.walkInOrder), null, 'reopened: nothing new');
    // (a) an item added and sent, or paid: the flush before the send or the payment time fire finds nothing.
    const plusGarlic = { ...s.walkInOrder, items: [...s.walkInOrder.items, line({ uid: 'ia-2', name: 'Garlic bread' })] };
    assert.equal(kitchenAllergyUpdate(plusGarlic), null);
    // (b) a chip tapped and untapped.
    assert.equal(kitchenAllergyUpdate(toggle(toggle(s, 'milk'), 'milk').walkInOrder), null);
    // (c) Clear all: the till says the kitchen still has it.
    assert.deepEqual(kitchenOnly(clearAll(reopen()).walkInOrder), ['nuts']);
    // A really new allergy still travels, and only it is NEW.
    assert.deepEqual(kitchenAllergyUpdate(toggle(reopen(), 'milk').walkInOrder).added, ['milk']);
  }
  assert.deepEqual(reopenedAllergyFields(here).kitchenTickets, here.kitchenTickets);
  // An entry never sent (a scheduled order reopened before it fired): the first send carries it.
  assert.deepEqual(reopenedAllergyFields({ ref: 'R42', items: [line({ uid: 'ib-1' })], declaredAllergens: ['nuts'] }), { declaredAllergens: ['nuts'] });
});

test('v6, major: a table paid or re-seated on another device reloads the chips; a tap never drops what the order declares', () => {
  // (B3) T3's party declared PEANUTS; the session is closed elsewhere under the same table id.
  const t3 = (session) => [{ id: 't3', label: 'T3', session }];
  let s = go(base({ tables: t3({ id: 'ORD-3', items: [line({ status: 'sent' })], declaredAllergens: ['peanuts'] }) }), { activeTableId: 't3' });
  assert.equal(orderOnScreen(s).key, 'table:t3:ORD-3');
  assert.deepEqual(s.allergens, ['peanuts']);
  s = go(s, { tables: t3(null) });
  assert.deepEqual(s.allergens, [], 'the paid party\'s chips go with it');
  // The next party's first item makes a session that takes the chips on screen: none.
  assert.deepEqual(seedDeclared({ id: 'ORD-4', items: [] }, s, 'table', 't3').declaredAllergens, []);
  // A new party seated at the same table on another till: its own declaration.
  s = go(s, { tables: t3({ id: 'ORD-5', items: [], declaredAllergens: ['sesame'] }) });
  assert.deepEqual(s.allergens, ['sesame']);
  assert.ok(tableOnScreen(s, 't3') && !tableOnScreen(s, 't1'));
  // (B2) T2 on screen with no session adopts another till's session that declares MILK.
  const t2 = (session) => [{ id: 't2', label: 'T2', session }];
  let b = go(base({ tables: t2(null) }), { activeTableId: 't2' });
  assert.deepEqual(b.allergens, []);
  b = go(b, { tables: t2({ id: 'ORD-R1', items: [], declaredAllergens: ['milk'] }) });
  assert.deepEqual(b.allergens, ['milk'], 'the adopted order\'s declaration');
  b = toggle(b, 'gluten');
  assert.deepEqual(tableSession(b, 't2').declaredAllergens, ['milk', 'gluten'], 'MILK is kept');
  // Even with stale chips a tap starts from the order: it cannot drop an allergy it did not touch.
  const stale = { ...b, allergens: [] };
  assert.deepEqual(toggledDeclaration(stale, 'eggs'), ['milk', 'gluten', 'eggs']);
  assert.deepEqual(toggledDeclaration(stale, 'milk'), ['gluten'], 'untapping takes off only that one');
  assert.deepEqual(toggledDeclaration(stale, ''), ['milk', 'gluten']);
  // An old session without the field: the chips are its declaration.
  assert.deepEqual(toggledDeclaration(base({ activeTableId: 't3', allergens: ['fish'] }), 'nuts'), ['fish', 'nuts']);
  // The same order under the same key is not reloaded (a no op).
  assert.equal(followOrderOnScreen(b, b), null);
});

test('v6, major: a QR table\'s session has no id; it is still a party of its own', () => {
  // qrTableSession.js builds a QR table's session with no id. Keyed by the id alone, a QR party
  // paid on the guest's phone while this till showed the table looked like "no change", so its
  // chips stayed for whoever sat there next.
  const qr = (over = {}) => ({ source: 'qr', openedAt: 1790000000000, items: [line({ status: 'sent' })], ...over });
  assert.equal(sessionKey(null), '');
  assert.equal(sessionKey({ id: 'ORD-9' }), 'ORD-9');
  assert.equal(sessionKey(qr()), 'qr@1790000000000');
  assert.equal(sessionKey({ items: [], seatedAt: 5 }), 'open@5');
  assert.notEqual(sessionKey(qr()), sessionKey(qr({ openedAt: 1790000900000 })), 'the next QR party is another order');
  const t4 = (session) => [{ id: 't4', label: 'T4', session }];
  let s = go(base({ tables: t4(qr({ declaredAllergens: ['sesame'] })) }), { activeTableId: 't4' });
  assert.deepEqual(s.allergens, ['sesame']);
  s = go(s, { tables: t4(null) });                            // the guest paid on their phone
  assert.deepEqual(s.allergens, [], 'the paid QR party\'s chips go with it');
  s = go(s, { tables: t4(qr({ openedAt: 1790000900000 })) });   // a new QR party there
  assert.deepEqual(s.allergens, []);
  // The kitchen update finds that party by its key and marks only it told.
  const sent = qr({ declaredAllergens: ['nuts'], kitchenAllergens: [] });
  const k = base({ tables: t4(sent) });
  const key = kitchenKeyFor(k, { tableId: 't4' });
  assert.equal(key, 'table:t4:qr@1790000000000');
  assert.equal(kitchenOrderByKey(k, key).order, sent);
  const next = { tables: t4(qr({ openedAt: 1790000900000, declaredAllergens: [] })) };
  assert.equal(kitchenOrderByKey(next, key), null, 'another QR party at the same table');
  assert.deepEqual(kitchenToldPatch(next, kitchenOrderByKey(k, key), ['nuts'], 1).tables, next.tables);
  // An id with a colon in it is still found (each table's own key is built and compared).
  const odd = { tables: [{ id: 't5', label: 'T5', session: { id: 'ORD:7', items: [line({ status: 'sent' })] } }] };
  assert.equal(kitchenOrderByKey(odd, kitchenKeyFor(odd, { tableId: 't5' })).tableId, 't5');
});

test('v6, minor: the update docket lists only food still in the kitchen, and none when all of it was served', () => {
  const soup = line({ uid: 's1', name: 'Soup', status: 'sent', fired: true, course: 1 });
  const steak = line({ uid: 's2', name: 'Steak', status: 'sent', fired: false, course: 2 });   // course 2 held
  const order = { id: 'ORD-1', items: [soup, steak], declaredAllergens: ['nuts'], kitchenAllergens: [],
    kitchenTickets: [{ id: 'k1', centreId: 'pc1', uids: ['s1', 's2'], allergens: [] }] };
  const upd = kitchenAllergyUpdate(order);
  // The starters were served (the ticket bumped): the soup is not listed, the held steak is.
  const bumped = kitchenUpdatePlan(upd, () => 'gone');
  assert.deepEqual(bumped.retag, [], 'a bumped ticket is left alone');
  assert.deepEqual(docketNames(bumped), [['pc1', ['Steak']]]);
  // Everything served: no docket at all (the next send carries the declaration anyway).
  assert.deepEqual(kitchenUpdatePlan(kitchenAllergyUpdate({ ...order, items: [soup] }), () => 'gone'), { retag: [], docket: [], route: [] });
  // Still cooking, or a ticket this till cannot see (the safe side): listed.
  assert.deepEqual(docketNames(kitchenUpdatePlan(upd, live)), [['pc1', ['Soup', 'Steak']]]);
  assert.deepEqual(docketNames(kitchenUpdatePlan(upd, () => undefined)), [['pc1', ['Soup', 'Steak']]]);
  assert.deepEqual(kitchenUpdatePlan(upd, () => undefined).retag, []);
  // One line on two tickets (a payment time fire re-sent the held course) is listed once per centre.
  const twice = { ...order, kitchenTickets: [...order.kitchenTickets, { id: 'k2', centreId: 'pc1', uids: ['s2'], allergens: [] }] };
  const p2 = kitchenUpdatePlan(kitchenAllergyUpdate(twice), live);
  assert.deepEqual(p2.retag, ['k1', 'k2']);
  assert.deepEqual(docketNames(p2), [['pc1', ['Soup', 'Steak']]]);
  assert.deepEqual(kitchenUpdatePlan(null, live), { retag: [], docket: [], route: [] });
});

test('v6, minor: a combine tells the kitchen only about the food that lacks the allergy', () => {
  // T1 (TREE NUTS, sent) combined into T2 (sent, none): the moved soup already carries it.
  const t1 = { id: 'ORD-1', items: [line({ uid: 'a1', name: 'Soup', status: 'sent', fired: true })], declaredAllergens: ['nuts'], kitchenAllergens: ['nuts'], kitchenTickets: [{ id: 'k-t1', centreId: 'pc1', uids: ['a1'], allergens: ['nuts'] }] };
  const t2 = { id: 'ORD-2', items: [line({ uid: 'b1', name: 'Ribeye', status: 'sent', fired: true })], declaredAllergens: [], kitchenAllergens: [], kitchenTickets: [{ id: 'k-t2', centreId: 'pc1', uids: ['b1'], allergens: [] }] };
  // The fields transferTable writes on the merged session.
  const merged = { ...t2, items: [...t2.items, ...t1.items], declaredAllergens: allergenIds(orderDeclared(t2), orderDeclared(t1)), kitchenTickets: [...kitchenTicketsOf(t2), ...kitchenTicketsOf(t1)] };
  const upd = kitchenAllergyUpdate(merged);
  assert.deepEqual(upd.stale.map(r => r.id), ['k-t2']);
  assert.deepEqual(upd.lines.map(l => l.name), ['Ribeye'], 'the soup is not announced a third time');
  assert.deepEqual(upd.added, ['nuts']);
  assert.deepEqual(kitchenHeld(merged), ['nuts']);
  assert.deepEqual(kitchenOnly({ ...merged, declaredAllergens: [] }), ['nuts'], 'cleared later: the kitchen still has it');
  // A QR rebuild and SyncBridge carry the records like the other allergy fields.
  assert.deepEqual(carryOrderAllergy({ kitchenTickets: [{ id: 'k1', centreId: 'pc1', uids: ['a'], allergens: ['Dairy'] }] }),
    { kitchenTickets: [{ id: 'k1', centreId: 'pc1', uids: ['a'], allergens: ['milk'] }] });
  assert.ok(allergyFieldsDiffer({ kitchenTickets: [] }, { kitchenTickets: [{ id: 'k1', uids: [], allergens: [] }] }));
  assert.ok(!allergyFieldsDiffer({ kitchenTickets: [{ id: 'k1', uids: ['a'], allergens: ['nuts'] }] }, { kitchenTickets: [{ id: 'k1', uids: ['a'], allergens: ['nuts'] }] }));
});

// ── v6 source pins ─────────────────────────────────────────────────────────────

test('source pin v6: each send records its tickets, and the update touches only those (or this order\'s by label or number)', () => {
  const store = read('../store/index.js');
  assert.match(store, /const uid = lineUidMaker\(\);/);
  assert.ok(!/let _itemUid = 1;/.test(store));
  const send = action(store, 'sendToKitchen');
  assert.match(send, /\.\.\.\(newTickets\.length \? \{ kitchenTickets: kitchenTicketsAfterSend\(t\.session, newTickets, tableAllergens\) \} : \{\}\),/);
  assert.match(send, /const wiKitchenTickets = newTickets\.length \? kitchenTicketsAfterSend\(order, newTickets, walkInAllergens\) : null;/);
  assert.equal((send.match(/\.\.\.\(wiKitchenTickets \? \{ kitchenTickets: wiKitchenTickets \} : \{\}\),/g) || []).length, 2, 'the queue entry and the sent walk in');
  assert.match(action(store, 'transferTable'), /kitchenTickets: \[\.\.\.kitchenTicketsOf\(to\.session\), \.\.\.kitchenTicketsOf\(from\.session\)\],/);
  const tell = action(store, 'tellKitchenAllergy');
  assert.ok(!/retagTicket\(|ticketHoldsLines\(tk, uids\)/.test(tell), 'never any ticket at the location by line uid alone');
  assert.match(tell, /\? \{ label: found\.label, since: found\.order\?\.seatedAt \}\n\s+: \{ orderNo: buildTicketMeta\(\{ channel: 'till', orderRef: found\.order\?\.ref \}\)\.orderNo \};/);
  assert.match(tell, /const isLoose = \(tk\) => looseUids\.size > 0 && ticketHoldsLines\(tk, looseUids\) && ticketIsOrders\(tk, scope\);/);
  assert.match(tell, /const isOrders = \(tk\) => !!tk && tk\.status !== 'bumped' && \(staleIds\.has\(tk\.id\) \|\| isLoose\(tk\)\);/);
  assert.match(tell, /supabase\.from\('kds_tickets'\)\.select\(cols\)\.eq\('location_id', locId\)\.in\('id', recIds\)/, 'the recorded tickets, read by id');
  assert.match(tell, /const dbLoose = openRows\.filter\(r => liveRow\(r\) && isLoose\(r\)\);/);
  // Only food still in the kitchen is printed; nothing when all of it was served.
  assert.match(tell, /printUpdate\(kitchenUpdatePlan\(upd, localState\('gone'\), localLoose\)\);/);
  assert.match(tell, /printUpdate\(got\?\.plan \|\| kitchenUpdatePlan\(upd, localState\(undefined\), localLoose\)\);/);
  // A hung kds_tickets read never holds the paper back: the docket goes from this till's view,
  // and the KDS rows are still updated when the read comes back.
  assert.match(tell, /try \{ got = await withTimeout\(readKitchen, KITCHEN_ALLERGY_READ_MS, 'Allergy update read'\); \}/);
  assert.match(tell, /const toRetag = got \? got\.toRetag : \(\(await readKitchen\)\?\.toRetag \|\| \[\]\);/);
  assert.match(store, /import \{ withTimeout \} from '\.\.\/lib\/withTimeout';/);
  assert.match(store, /const KITCHEN_ALLERGY_READ_MS = 2500;/);
  // Nothing left to print: all of it served, or (said out loud) no production centre takes it.
  assert.match(tell, /if \(!byCentre\.size\) \{\n[\s\S]*?if \(plan\.route\.length && routingHasCentres\) \{\n\s+get\(\)\.showToast\(`ALLERGY \$\{line\} for \$\{label\} was NOT sent to the kitchen: [^`]*Tell the kitchen directly\.`, 'error'\);\n\s+\}\n\s+return;\n\s+\}/);
  assert.match(tell, /routingHasCentres = \(routingConfig\.centres \|\| \[\]\)\.length > 0;/);
});

test('source pin v6: an update still waiting goes at once wherever the order leaves the till', () => {
  const store = read('../store/index.js');
  const first = (body, flush, then, name) => {
    const f = body.indexOf(flush);
    const t = body.indexOf(then);
    assert.ok(f > -1 && t > -1 && f < t, `${name}: the kitchen is told before the order goes`);
  };
  const WALK_IN = 'get().flushKitchenAllergy({ walkIn: true });';
  first(action(store, 'clearTable'), 'get().flushKitchenAllergy({ tableId });', 'if (hasUnfired) get().sendToKitchen({ fireAll: true, tableId });', 'clearTable');
  const closed = action(store, 'recordWalkInClosed');
  first(closed, WALK_IN, 'get().sendToKitchen({ fireAll: true, tableId: null });', 'recordWalkInClosed');
  // Telling the kitchen writes the walk in, so the payment time fire reads the live one again.
  assert.match(closed, /const wasLive = walkInOrder === get\(\)\.walkInOrder;\n\s+get\(\)\.flushKitchenAllergy\(\{ walkIn: true \}\);\n\s+if \(wasLive\) walkInOrder = get\(\)\.walkInOrder \|\| walkInOrder;/);
  first(action(store, 'clearWalkIn'), WALK_IN, 'walkInOrder:null', 'clearWalkIn');
  first(action(store, 'login'), WALK_IN, 'operatorSwitchPatch(', 'login');
  first(action(store, 'logout'), WALK_IN, 'logoutPatch(', 'logout');
  for (const name of ['seatTableWithItems', 'mergeItemsToTable', 'splitTableCheck']) first(action(store, name), WALK_IN, 'const st = get();', name);
  first(action(store, 'fireScheduledOrder'), WALK_IN, 'const prev = {', 'fireScheduledOrder');
  // A timer whose order has gone uses the order as the last edit left it.
  const tell = action(store, 'tellKitchenAllergy');
  assert.match(tell, /if \(pending\) \{ clearTimeout\(pending\.timer\); _kitchenAllergyTimers\.delete\(key\); \}/);
  assert.match(tell, /const found = kitchenOrderByKey\(st, key\) \|\| pending\?\.last \|\| null;/);
  const queue = action(store, '_queueKitchenAllergy');
  assert.match(queue, /_kitchenAllergyTimers\.set\(key, \{ timer, last: kitchenOrderByKey\(st, key\) \}\);/);
  assert.match(queue, /const timer = setTimeout\(\(\) => \{\n\s+try \{ get\(\)\.tellKitchenAllergy\(key\); \}/, 'plain setTimeout; the entry stays for tellKitchenAllergy to read');
  // The surfaces that drop or replace the walk in: MPOS (a new order, a table opened, all done,
  // take the next order) and the Orders Hub reopen (both branches).
  const mpos = read('../surfaces/MPOSSurface.jsx');
  assert.equal((mpos.match(/useStore\.getState\(\)\.flushKitchenAllergy\(\{ walkIn: true \}\);\n\s+useStore\.setState\(\{ walkInOrder: null/g) || []).length, 4);
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.equal((hub.match(/useStore\.getState\(\)\.flushKitchenAllergy\(\{ walkIn: true \}\);\n\s+useStore\.setState\(\{\n\s+walkInOrder: \{/g) || []).length, 2);
});

test('source pin v6: a reopen knows what the kitchen holds; a table is its session; a tap edits the order', () => {
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.match(hub, /import \{ orderDeclared, reopenedAllergyFields \} from '\.\.\/lib\/orderAllergy';/);
  assert.match(hub, /\.\.\.reopenedAllergyFields\(o\._raw \|\| o, o\.items \|\| \[\]\),\n\s+declaredAllergens: reopenDeclared,/);
  assert.match(hub, /\.\.\.reopenedAllergyFields\(o\._raw \|\| o, payItems\),/);
  const lib = read('./orderAllergy.js');
  assert.match(lib, /key: `table:\$\{s\.activeTableId\}:\$\{sessionKey\(holder\)\}`/);
  assert.match(lib, /return session && kitchenLines\(session\)\.length \? `table:\$\{target\.tableId\}:\$\{sessionKey\(session\)\}` : null;/);
  const store = read('../store/index.js');
  // No store code compares a table's key by its id alone any more.
  assert.ok(!/\.key === `table:/.test(store));
  assert.match(action(store, 'setSessionCustomer'), /return tableOnScreen\(s, tableId\) \? \{ tables, allergens: declarationFor\(\{ \.\.\.s, tables \}\) \} : \{ tables \};/);
});
