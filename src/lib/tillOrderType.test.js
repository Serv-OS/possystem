/**
 * tillOrderType.test.js: the till's default order type and the dine in flag number (Peter,
 * Coffee Boy, 30 Sep 2026), and the Order details pop up the flag became one part of (Peter,
 * 5 Nov 2026: "I want one screen that has this info and each one can be turned off and on").
 * Run: `node --test src/lib/tillOrderType.test.js`.
 *
 * The pure rules first; then the wiring, read as text the way driveThruTill.test.js does,
 * because the store and the surfaces have no pure helper to call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  defaultOrderTypeFor, cleanDefaultOrderType, defaultOrderTypeSummary, tillOrderColumnsReady,
  tillOrderColumnsToKeep, cleanFlagNumber, needsFlagPrompt, orderFlag, flagTableLabel, flagTicketLabel,
  ORDER_TYPE_KEYS, DEFAULT_ORDER_TYPE_COLUMN, FLAG_PROMPT_COLUMN, TILL_ORDER_FIELDS,
  TILL_PROMPT_FIELDS, GUESTS_PROMPT_COLUMN, ORDER_TYPE_PROMPT_COLUMN, NEW_CUSTOMER_PROMPT_COLUMN, GUESTS_MAX, NEW_CUSTOMER_LABEL,
  tillPromptColumnsReady, tillPromptColumnsToKeep, cleanGuests, orderDetailsSections, orderDetailsOn, needsOrderDetails,
  orderCovers, orderIsNewCustomer, cleanOrderDetails, orderDetailsSummary,
} from './tillOrderType.js';
import { buildTicketMeta, ticketHeadline, kdsTypeKey, ticketMeta, ticketView } from './kds/kdsTicket.js';
import { buildKitchenTicketDoc } from './printDoc.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const has = (text, needle, where) => assert.ok(text.includes(needle), `${where} carries ${needle}`);

// ── Default order type ───────────────────────────────────────────────────────

test('the explicit default wins when it is enabled', () => {
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: ['dine-in', 'takeaway'], defaultOrderType: 'takeaway' }), 'takeaway');
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: ['dine-in', 'drive-thru'], defaultOrderType: 'drive-thru' }), 'drive-thru');
});

test('a default that is not enabled is ignored', () => {
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: ['dine-in', 'takeaway'], defaultOrderType: 'drive-thru' }), 'dine-in');
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: ['takeaway', 'collection'], defaultOrderType: 'dine-in' }), 'takeaway');
});

test('Huddersfield: the only enabled type is the default, with no column needed', () => {
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: ['drive-thru'] }), 'drive-thru');
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: ['takeaway'], defaultOrderType: null }), 'takeaway');
});

test('dine in when enabled, else the first enabled, else dine in', () => {
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: ['takeaway', 'dine-in', 'collection'] }), 'dine-in');
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: ['collection', 'takeaway'] }), 'collection');
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: [] }), 'dine-in');          // a KDS profile
  assert.equal(defaultOrderTypeFor(null), 'dine-in');
  assert.equal(defaultOrderTypeFor({}), 'dine-in');
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: 'takeaway' }), 'dine-in'); // bad shape
  assert.equal(defaultOrderTypeFor({ enabledOrderTypes: [null, 'takeaway'] }), 'takeaway');
});

test('Back Office stores a known, still enabled type, else automatic', () => {
  assert.equal(cleanDefaultOrderType('takeaway', ['dine-in', 'takeaway']), 'takeaway');
  assert.equal(cleanDefaultOrderType('takeaway', ['dine-in']), null);
  assert.equal(cleanDefaultOrderType('pizza', ['pizza']), null);
  assert.equal(cleanDefaultOrderType('', ['dine-in']), null);
  assert.equal(cleanDefaultOrderType(null, ['dine-in']), null);
  assert.equal(cleanDefaultOrderType('dine-in', null), null);
  for (const t of ORDER_TYPE_KEYS) assert.equal(cleanDefaultOrderType(t, [t]), t);
});

test('the summary names the type, or Automatic with what that gives', () => {
  const label = (t) => ({ 'dine-in': 'Dine in', takeaway: 'Takeaway', 'drive-thru': 'Drive thru' })[t] || t;
  assert.equal(defaultOrderTypeSummary({ enabledOrderTypes: ['dine-in', 'takeaway'], defaultOrderType: 'takeaway' }, label), 'Takeaway');
  assert.equal(defaultOrderTypeSummary({ enabledOrderTypes: ['dine-in', 'takeaway'] }, label), 'Automatic (Dine in)');
  assert.equal(defaultOrderTypeSummary({ enabledOrderTypes: ['drive-thru'] }, label), 'Automatic (Drive thru)');
  assert.equal(defaultOrderTypeSummary({ enabledOrderTypes: ['dine-in'], defaultOrderType: 'takeaway' }, label), 'Automatic (Dine in)');
  assert.equal(defaultOrderTypeSummary({ enabledOrderTypes: ['takeaway'] }), 'Automatic (takeaway)');
});

test('the columns are ready when a select(*) row carries default_order_type', () => {
  assert.equal(DEFAULT_ORDER_TYPE_COLUMN, 'default_order_type');
  assert.equal(FLAG_PROMPT_COLUMN, 'dine_in_flag_prompt');
  assert.equal(tillOrderColumnsReady({ id: 'p1', default_order_type: null }), true);
  assert.equal(tillOrderColumnsReady({ id: 'p1', default_order_type: 'takeaway' }), true);
  assert.equal(tillOrderColumnsReady({ id: 'p1', enabled_order_types: ['dine-in'] }), false);
  assert.equal(tillOrderColumnsReady(null), false);
  assert.equal(tillOrderColumnsReady('row'), false);
});

test('stale tab guard: keep the stored value for the keys this session did not touch, once the columns exist', () => {
  assert.deepEqual(TILL_ORDER_FIELDS, [['defaultOrderType', 'default_order_type'], ['dineInFlagPrompt', 'dine_in_flag_prompt']]);
  // A rename touched neither: both are kept from the database.
  assert.deepEqual(tillOrderColumnsToKeep(new Set(['name']), true), TILL_ORDER_FIELDS);
  // Starts on was changed here: only the flag switch is kept.
  assert.deepEqual(tillOrderColumnsToKeep(new Set(['defaultOrderType']), true), [['dineInFlagPrompt', 'dine_in_flag_prompt']]);
  assert.deepEqual(tillOrderColumnsToKeep(new Set(['defaultOrderType', 'dineInFlagPrompt']), true), []);
  // Before the migration the fresh read must not name the columns.
  assert.deepEqual(tillOrderColumnsToKeep(new Set(['name']), false), []);
  assert.deepEqual(tillOrderColumnsToKeep(new Set(['name']), null), []);
  // An unknown caller (no touched set) keeps today's full overwrite.
  assert.deepEqual(tillOrderColumnsToKeep(null, true), []);
  assert.deepEqual(tillOrderColumnsToKeep(['name'], true), []);
});

// ── Flag number ──────────────────────────────────────────────────────────────

test('a flag is 1 to 4 digits, nothing else', () => {
  assert.equal(cleanFlagNumber('30'), '30');
  assert.equal(cleanFlagNumber(7), '7');
  assert.equal(cleanFlagNumber(' 12 '), '12');
  assert.equal(cleanFlagNumber('12345'), '1234');
  assert.equal(cleanFlagNumber('B5'), '5');
  assert.equal(cleanFlagNumber('abc'), null);
  assert.equal(cleanFlagNumber(''), null);
  assert.equal(cleanFlagNumber(null), null);
  assert.equal(cleanFlagNumber(undefined), null);
});

test('the prompt shows only for a dine in walk in order without a flag, with the switch on', () => {
  const on = { dineInFlagPrompt: true };
  assert.equal(needsFlagPrompt({ deviceConfig: on, orderType: 'dine-in', activeTableId: null, walkInOrder: { items: [{}] } }), true);
  assert.equal(needsFlagPrompt({ deviceConfig: on, orderType: 'dine-in', activeTableId: null, walkInOrder: null }), true);
  // Already has its flag: never asks twice (Send then Pay, or a reopened order).
  assert.equal(needsFlagPrompt({ deviceConfig: on, orderType: 'dine-in', activeTableId: null, walkInOrder: { tableFlag: '30' } }), false);
  // A floor table has a table.
  assert.equal(needsFlagPrompt({ deviceConfig: on, orderType: 'dine-in', activeTableId: 't1', walkInOrder: null }), false);
  // Other order types never ask.
  for (const t of ['takeaway', 'collection', 'delivery', 'drive-thru']) {
    assert.equal(needsFlagPrompt({ deviceConfig: on, orderType: t, activeTableId: null, walkInOrder: null }), false, t);
  }
  // Switch off, missing, or the column not there yet: never asks.
  assert.equal(needsFlagPrompt({ deviceConfig: { dineInFlagPrompt: false }, orderType: 'dine-in', activeTableId: null }), false);
  assert.equal(needsFlagPrompt({ deviceConfig: {}, orderType: 'dine-in', activeTableId: null }), false);
  assert.equal(needsFlagPrompt({ deviceConfig: null, orderType: 'dine-in', activeTableId: null }), false);
  assert.equal(needsFlagPrompt(), false);
});

test('the order carries its flag only while it is dine in', () => {
  assert.equal(orderFlag({ tableFlag: '30' }, 'dine-in'), '30');
  assert.equal(orderFlag({ tableFlag: '30' }, 'takeaway'), null);   // typed, then switched to takeaway
  assert.equal(orderFlag({ tableFlag: null }, 'dine-in'), null);
  assert.equal(orderFlag(null, 'dine-in'), null);
  assert.equal(orderFlag({ tableFlag: 'x' }, 'dine-in'), null);
});

test('Table 30 for the receipt and Orders; Table 30 · #09 for the kitchen, like a kiosk flag', () => {
  assert.equal(flagTableLabel('30'), 'Table 30');
  assert.equal(flagTableLabel(null), null);
  assert.equal(flagTableLabel(''), null);
  assert.equal(flagTicketLabel('30', 'R1209'), 'Table 30 · #09');
  assert.equal(flagTicketLabel('30', 'R7'), 'Table 30 · #7');
  assert.equal(flagTicketLabel('30', '#6720'), 'Table 30 · #6720');   // an old style ref keeps its number
  assert.equal(flagTicketLabel('30', null), 'Table 30');
  assert.equal(flagTicketLabel('30', ''), 'Table 30');
  assert.equal(flagTicketLabel(null, 'R1209'), null);
});

test('no floor table can be named like a flag ticket, so fireCourse never matches one', () => {
  // Floor tables are short labels (T1, 12, B5). The ticket label always carries " · #".
  assert.match(flagTicketLabel('12', 'R1247'), /^Table 12 · #\d+$/);
  assert.notEqual(flagTicketLabel('12', 'R1247'), 'Table 12');
  assert.notEqual(flagTicketLabel('12', 'R1247'), '12');
});

test('the KDS shows the flag ticket as a table: headline is the label, board type is table', () => {
  const meta = buildTicketMeta({ channel: 'till', orderType: 'dine-in', isTable: true, orderRef: 'R1209', source: 'Till 1', staff: 'Sam' });
  assert.equal(meta.isTable, true);
  assert.equal(meta.orderNo, null);   // tables show no number (Peter, 14 Sep 2026)
  assert.equal(ticketHeadline(meta, flagTicketLabel('30', 'R1209')), 'Table 30 · #09');
  assert.equal(kdsTypeKey(meta), 'dineinTable');
  // Without a flag the walk in ticket is exactly as before.
  const plain = buildTicketMeta({ channel: 'till', orderType: 'dine-in', isTable: false, orderRef: 'R1209' });
  assert.equal(plain.isTable, false);
  assert.equal(ticketHeadline(plain, 'dine-in'), '#09');
  assert.equal(kdsTypeKey(plain), 'dineinName');
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('store: the default applies at boot and profile apply, after every walk in, never on a table', () => {
  const src = read('../store/index.js');
  has(src, "import { defaultOrderTypeFor, orderFlag, flagTableLabel, flagTicketLabel, cleanFlagNumber, orderCovers, orderIsNewCustomer, cleanOrderDetails } from '../lib/tillOrderType';", 'import');
  // The store's initial orderType comes from the cached device config (a plain reload never
  // reaches setDeviceConfig: every boot path is change gated in App.jsx deviceConfigChanged).
  has(src, "  orderType: (() => {\n    try {\n      const raw = sessionStorage.getItem('rpos-terminal-config') || localStorage.getItem('rpos-device-config');\n      return defaultOrderTypeFor(raw ? JSON.parse(raw) : null);\n    } catch { return 'dine-in'; }\n  })(),", 'boot default');
  assert.ok(!src.includes("\n  orderType: 'dine-in',\n"), 'the literal dine in start is gone');
  // setDeviceConfig (boot, Apply to this terminal, Push to POS) applies it only while nothing is rung up.
  has(src, "if (!get().activeTableId && !get().walkInOrder?.items?.length) {\n      const startType = defaultOrderTypeFor(finalConfig);", 'setDeviceConfig');
  // clearWalkIn goes back to the default, not always dine in.
  // v5.11.78 round 1: it also drops the delivery quote (a fee an opened order brought must not stay).
  has(src, "clearWalkIn: () => set(s => ({ walkInOrder:null, customer:null, orderType:defaultOrderTypeFor(s.deviceConfig), pendingLoyaltyReward:null, deliveryQuote:null }))", 'clearWalkIn');
  // Floor tables still open as dine in (Peter: real tables must stay dine in).
  assert.ok((src.match(/surface:'pos', orderType:'dine-in'/g) || []).length >= 4, 'table opens set dine-in');
  has(src, "set({ activeTableId:tableId, surface:'pos', orderType:'dine-in', walkInOrder:null, customer:null });", 'openTable stays dine-in');
});

test('store: a flag order is a table ticket on the KDS, the paper, the queue and the closed check', () => {
  const src = read('../store/index.js');
  has(src, "setWalkInTableFlag: (flag) => set(s => ({ walkInOrder: { ...(s.walkInOrder || {}), tableFlag: cleanFlagNumber(flag) } }))", 'setWalkInTableFlag');
  has(src, "const flag = orderFlag(order, orderType);\n      const label = flag ? flagTicketLabel(flag, ref)", 'kitchen label');
  has(src, "channel: 'till', orderType, isTable: !!flag,", 'KDS meta isTable');
  has(src, "...(flag ? { tableFlag: flag } : {}),", 'queue entry carries the flag');
  // With no customer the ticket label must not become the customer's name ("Table 30 · #09").
  has(src, "customer: { ...(customer ? { ...customer } : { name: flag ? '' : label }),", 'flag order has no fake customer name');
  has(src, "tableLabel: flagTableLabel(orderFlag(walkInOrder, orderType)),", 'closed check table label');
  // The label is built from the ref, so the ref must be taken first.
  const refAt = src.indexOf('const ref = order.ref || getNextOrderRefLocal();\n      // 30 Sep 2026');
  const labelAt = src.indexOf('const label = flag ? flagTicketLabel(flag, ref)');
  assert.ok(refAt > 0 && labelAt > refAt, 'ref is taken before the label');
});

test('POSSurface: the pop up is asked before Send and before Pay, and cannot be skipped', () => {
  const src = read('../surfaces/POSSurface.jsx');
  has(src, "import OrderDetailsModal from '../components/OrderDetailsModal';", 'import');
  assert.ok(!src.includes('FlagNumberModal'), 'the old flag modal is gone from the till');
  has(src, "const detailsNeeded = needsOrderDetails({ deviceConfig, orderType, activeTableId, walkInOrder });", 'detailsNeeded');
  has(src, "if (!afterDetails && detailsNeeded) { setDetailsFor('send'); return; }", 'Send asks first');
  // An order that already has its flag sends as Table <n>, never through the table picker; the
  // flag and the type are read fresh from the store (after the pop up this render is stale).
  has(src, "const walkInFlag = orderFlag(fresh.walkInOrder, typeNow);", 'flag read fresh');
  has(src, "if (walkInFlag) {\n        setShowCheckout(false);\n        sendToKitchen();\n        clearWalkIn();\n        showToast(`${flagTableLabel(walkInFlag)} sent`, 'success');\n        return;\n      }", 'a flagged order sends straight through');
  has(src, "if (sendsWithoutPrompt({ orderType: typeNow, mode: takeawayCustomerDetails, hasName: !!customerNow?.name })) {", 'the no prompt send reads the fresh type');
  has(src, "if (detailsNeeded) { setDetailsFor('pay'); return; }", 'Pay asks first');
  has(src, "onCheckout={()=>{ setShowReview(false); if(items.length>0) { if (detailsNeeded) setDetailsFor('pay'); else setShowCheckout(true); } }}", 'Review checkout asks first');
  has(src, "{detailsFor && <OrderDetailsModal action={detailsFor} deviceConfig={deviceConfig} ask={detailsNeeded} orderType={orderType} enabledOrderTypes={allowedOrderTypes} walkInOrder={walkInOrder} onConfirm={onDetailsEntered} onClose={()=>setDetailsFor(null)}/>}", 'modal render');
  // The counter choice on the send modal answers the pop up first too.
  has(src, "if (needsOrderDetails({ deviceConfig, orderType: 'dine-in', activeTableId: null, walkInOrder: store.walkInOrder })) { setDetailsFor('send'); return; }", 'counter order asks');
  // After the answers: onto the order, then the type (a type that needs details stops at that
  // form), then the usual send (as Table <n> with a flag, else the usual path) or the pay gates.
  has(src, "setWalkInOrderDetails(answers);", 'answers saved on the order');
  has(src, "if (answers.orderType && answers.orderType !== orderType) {\n      handleTypeChange(answers.orderType);\n      if (promptsOnTypeChange({ orderType: answers.orderType, mode: takeawayCustomerDetails })) return;\n    }", 'type picked on the pop up');
  has(src, "handleSend({ afterDetails: true });", 'send after the pop up skips the pop up');
  has(src, "} else if (next === 'pay') {\n      proceedToCheckout();", 'pay after the pop up');
  // The order header shows the flag; the covers are the guests typed (dine in only).
  has(src, ":walkInFlag?flagTableLabel(walkInFlag):orderTypeLabel} · {staff?.name}", 'order header');
  has(src, "const covers = session?.covers || orderCovers(walkInOrder, orderType) || 2;", 'covers from the pop up');
  // The receipt and the tip slip printed at pay say Table <n> (the closed check books the same).
  has(src, "const tableLabel = activeTable?.label || flagTableLabel(walkInFlag) || null;", 'receipt table label');
  has(src, "tableLabel: activeTable?.label || flagTableLabel(walkInFlag) || null,", 'tip slip table label');
  // The reader job's draft carries it too, for a check the closer books from the draft.
  const checkout = read('../surfaces/CheckoutModal.jsx');
  has(checkout, "import { orderFlag, flagTableLabel } from '../lib/tillOrderType';", 'checkout import');
  has(checkout, "tableLabel: tableId || flagTableLabel(orderFlag(useStore.getState().walkInOrder, orderType)) || null,", 'checkDraft table label');
  const modal = read('../components/OrderDetailsModal.jsx');
  // No Skip button or label: the comment says why, the markup never offers one.
  assert.ok(!/>\s*Skip|['"`]Skip/i.test(modal), 'the pop up has no skip');
  has(modal, 'disabled={!ready}', 'confirm needs every shown part');
  has(modal, "const showFlag = on.flag && dineIn && !cleanFlagNumber(walkInOrder?.tableFlag);", 'flag only on dine in');
  has(modal, "const showGuests = on.guests && dineIn && !cleanGuests(walkInOrder?.covers);", 'guests only on dine in');
  has(modal, 'ariaLabel="New customer: yes"', 'Yes');
  has(modal, 'ariaLabel="New customer: no"', 'No');
  has(modal, '>Order type</label>', 'order type part');
});

test('store: the pop up answers live on the order; guests are the covers and Yes marks the ticket', () => {
  const src = read('../store/index.js');
  has(src, "setWalkInOrderDetails: (answers) => set(s => {\n    const { orderType: _type, ...rest } = cleanOrderDetails(answers);\n    return { walkInOrder: { ...(s.walkInOrder || {}), ...rest } };\n  }),", 'setWalkInOrderDetails');
  has(src, "const walkInCovers = orderCovers(order, orderType) || 1;\n      const newCustomer = orderIsNewCustomer(order);", 'covers and new customer read from the order');
  has(src, "note: joinNotes(order.orderNote, customer?.notes),\n        newCustomer,\n      });", 'KDS meta carries newCustomer');
  has(src, "createKdsTickets(pendingItems, label, staff?.name || 'Server', walkInCovers, wiFiredOnSend, walkInMeta);", 'tickets carry the covers');
  has(src, "type: 'kitchen',\n          newCustomer,\n        });", 'print job carries newCustomer');
  has(src, "newCustomer: job.newCustomer === true,   // 5 Nov 2026", 'docket gets newCustomer');
  has(src, "itemLabel: `ITEM ${i + 1} OF ${total}`, reprint: !!job.reprint, newCustomer: job.newCustomer === true,", 'sticker dockets get it too');
  has(src, "...(newCustomer ? { newCustomer: true } : {}) },", 'queue entry carries newCustomer');
  has(src, "...(walkInCovers > 1 ? { covers: walkInCovers } : {}),", 'queue entry carries the covers');
  assert.equal((src.match(/covers: orderCovers\(walkInOrder, orderType\) \|\| 1,/g) || []).length, 2, 'the closed check and its tax both book the guests');
  // The pop up's mark on the card and the docket.
  const card = read('../surfaces/kds/KdsTicketCard.jsx');
  has(card, "import { NEW_CUSTOMER_LABEL } from '../../lib/tillOrderType';", 'card imports the label');
  assert.equal((card.match(/<NewCustomerBadge view=\{view\}/g) || []).length, 2, 'card and pop out both show it');
  has(read('./kds/kdsTicket.js'), "newCustomer: newCustomer === true,", 'buildTicketMeta keeps it');
  has(read('./printDoc.js'), "if (newCustomer) b.center().line('** NEW CUSTOMER **').left();", 'docket prints it big');
});

test('device profile: both fields ride the one mapping, the compare gate, pairing and the offline cache', () => {
  const app = read('../App.jsx');
  has(app, 'defaultOrderType: row.default_order_type || null,', 'profileRowToProfile default');
  has(app, 'dineInFlagPrompt: row.dine_in_flag_prompt === true,', 'profileRowToProfile flag');
  has(app, 'defaultOrderType: profile.defaultOrderType || null,', 'configFromProfile default');
  has(app, 'dineInFlagPrompt: profile.dineInFlagPrompt === true,', 'configFromProfile flag');
  has(app, "'defaultOrderType', 'dineInFlagPrompt',", 'CONFIG_COMPARE_KEYS');
  has(read('../surfaces/PairingScreen.jsx'), 'defaultOrderType: profile.defaultOrderType || null,', 'PairingScreen');
  has(read('../sync/SyncBridge.jsx'), 'defaultOrderType: p.default_order_type || null,', 'SyncBridge cache');
  // 5 Nov 2026: the pop up's three switches ride every one of the same paths.
  for (const [key, col] of TILL_PROMPT_FIELDS) {
    has(app, `${key}: row.${col} === true,`, `profileRowToProfile ${key}`);
    has(app, `${key}: profile.${key} === true,`, `configFromProfile ${key}`);
    has(app, `${key}: existingConfig?.${key} === true,`, `minConfig ${key}`);
    has(read('../surfaces/PairingScreen.jsx'), `${key}: profile.${key} === true,`, `PairingScreen ${key}`);
    has(read('../sync/SyncBridge.jsx'), `${key}: p.${col} === true,`, `SyncBridge ${key}`);
  }
  has(app, "'promptGuests', 'promptOrderType', 'promptNewCustomer',", 'CONFIG_COMPARE_KEYS 5 Nov');
});

test('Back Office: the columns are sent only once they exist, and the default is kept only while enabled', () => {
  const src = read('../backoffice/sections/DeviceProfiles.jsx');
  has(src, 'let _tillOrderColumns = isMock ? true : null;', 'readiness flag');
  has(src, 'if (profileData?.length) setTillOrderColumns(tillOrderColumnsReady(profileData[0]));', 'rows say whether the columns exist');
  // The editor block watches the flag, so one open before the answer lands redraws itself.
  has(src, 'const ready = useTillOrderColumns();', 'editor block watches readiness');
  has(src, '_tillOrderWatchers.forEach(fn => fn());', 'setter notifies watchers');
  has(src, 'return useSyncExternalStore(subscribeTillOrderColumns, readTillOrderColumns);', 'a module value read through useSyncExternalStore');
  // The stale tab guard: untouched keys keep the stored value, only once the columns exist.
  has(src, 'const keep = [...tillOrderColumnsToKeep(touched, _tillOrderColumns), ...tillPromptColumnsToKeep(touched, _tillPromptColumns)];', 'guard asks both rules');
  has(src, 'const keptTillOrder = await keepTillOrderColumns(row, touched);', 'guard runs on save');
  has(src, '...(_tillOrderColumns === true ? {\n      [DEFAULT_ORDER_TYPE_COLUMN]: cleanDefaultOrderType(p.defaultOrderType, p.enabledOrderTypes),\n      [FLAG_PROMPT_COLUMN]: p.dineInFlagPrompt === true,\n    } : {}),', 'toDbRow sends only when ready');
  has(src, 'defaultOrderType: p[DEFAULT_ORDER_TYPE_COLUMN] || null,', 'mapped default');
  has(src, 'dineInFlagPrompt: p[FLAG_PROMPT_COLUMN] === true,', 'mapped flag');
  has(src, '<TillOrderTypeSettings form={form} upd={upd}/>', 'editor block');
  has(src, 'need a database update first', 'greyed out before the migration');
  // Apply to this terminal hands both to the till.
  has(src, 'defaultOrderType: prof.defaultOrderType || null,', 'apply to this terminal');
  // 5 Nov 2026: the three new columns behind their own flag, in the same section as the flag.
  has(src, 'let _tillPromptColumns = isMock ? true : null;', 'second readiness flag');
  has(src, 'if (profileData?.length) setTillPromptColumns(tillPromptColumnsReady(profileData[0]));', 'rows say whether the new columns exist');
  has(src, '...(_tillPromptColumns === true ? Object.fromEntries(TILL_PROMPT_FIELDS.map(([formKey, col]) => [col, p[formKey] === true])) : {}),', 'toDbRow sends the three only when ready');
  has(src, '...Object.fromEntries(TILL_PROMPT_FIELDS.map(([formKey, col]) => [formKey, p[col] === true])),', 'mapped three');
  for (const key of ['dineInFlagPrompt', 'promptGuests', 'promptOrderType', 'promptNewCustomer']) has(src, `key:'${key}'`, `switch ${key}`);
  has(src, "const disabled = part.ready === 'prompt' && promptReady !== true;", 'the three are greyed until 20261124a, the flag is not');
  has(src, '<ConfigRow label="Order details pop up" value={orderDetailsSummary(prof)}', 'profile card row');
  for (const key of ['promptGuests', 'promptOrderType', 'promptNewCustomer']) has(src, `${key}: prof.${key} === true,`, `apply to this terminal ${key}`);
});

test('migration and rollback exist and are idempotent', () => {
  const up = read('../../supabase/migrations/20260930c_OPS_device_profile_default_order_type.sql');
  has(up, 'add column if not exists default_order_type text', 'default column');
  has(up, 'add column if not exists dine_in_flag_prompt boolean not null default false', 'flag column');
  has(up, "in ('dine-in', 'takeaway', 'collection', 'delivery', 'drive-thru')", 'known types check');
  has(up, "set local lock_timeout = '3s';", 'lock timeout');
  has(up, "notify pgrst, 'reload schema';", 'schema reload');
  const down = read('../../supabase/migrations/20260930c_OPS_device_profile_default_order_type_ROLLBACK.sql');
  has(down, 'drop column if exists default_order_type', 'rollback default');
  has(down, 'drop column if exists dine_in_flag_prompt', 'rollback flag');
  // 5 Nov 2026: the pop up's three columns, guarded on the 20260930c column being there first.
  const up2 = read('../../supabase/migrations/20261124a_OPS_device_profile_order_details.sql');
  for (const col of [GUESTS_PROMPT_COLUMN, ORDER_TYPE_PROMPT_COLUMN, NEW_CUSTOMER_PROMPT_COLUMN]) has(up2, `add column if not exists ${col} boolean not null default false`, col);
  has(up2, "Run 20260930c_OPS_device_profile_default_order_type.sql first", 'needs the flag column first');
  has(up2, "set local lock_timeout = '3s';", 'lock timeout');
  has(up2, "notify pgrst, 'reload schema';", 'schema reload');
  assert.ok(!/[^\u0020-\u007e\n]/.test(up2), 'ASCII only (pbcopy)');
  const down2 = read('../../supabase/migrations/20261124a_OPS_device_profile_order_details_ROLLBACK.sql');
  for (const col of [GUESTS_PROMPT_COLUMN, ORDER_TYPE_PROMPT_COLUMN, NEW_CUSTOMER_PROMPT_COLUMN]) has(down2, `drop column if exists ${col}`, `rollback ${col}`);
  assert.ok(!/[^\u0020-\u007e\n]/.test(down2), 'rollback ASCII only');
});

// ── Order details pop up (5 Nov 2026) ────────────────────────────────────────

test('the three new columns are ready when a select(*) row carries order_prompt_guests; the flag column alone is not enough', () => {
  assert.equal(tillPromptColumnsReady({ id: 'p1', dine_in_flag_prompt: true, order_prompt_guests: false }), true);
  assert.equal(tillPromptColumnsReady({ id: 'p1', dine_in_flag_prompt: true }), false);
  assert.equal(tillPromptColumnsReady(null), false);
  assert.deepEqual(TILL_PROMPT_FIELDS.map(([, col]) => col), [GUESTS_PROMPT_COLUMN, ORDER_TYPE_PROMPT_COLUMN, NEW_CUSTOMER_PROMPT_COLUMN]);
  // The stale tab guard, the same rule as the first two columns.
  assert.deepEqual(tillPromptColumnsToKeep(new Set(['promptGuests']), true).map(([k]) => k), ['promptOrderType', 'promptNewCustomer']);
  assert.deepEqual(tillPromptColumnsToKeep(new Set(), false), []);
  assert.deepEqual(tillPromptColumnsToKeep(null, true), []);
});

test('guests are a whole number from 1 to 99', () => {
  assert.equal(cleanGuests('4'), 4);
  assert.equal(cleanGuests(4), 4);
  assert.equal(cleanGuests('12'), 12);
  assert.equal(cleanGuests('0'), null);
  assert.equal(cleanGuests(''), null);
  assert.equal(cleanGuests(null), null);
  assert.equal(cleanGuests('abc'), null);
  assert.equal(cleanGuests('250'), GUESTS_MAX);
  assert.equal(cleanGuests(-3), null);
});

test('each part has its own switch; the pop up is on when any is', () => {
  assert.deepEqual(orderDetailsSections({ dineInFlagPrompt: true }), { flag: true, guests: false, orderType: false, newCustomer: false });
  assert.deepEqual(orderDetailsSections({ promptGuests: true, promptOrderType: true, promptNewCustomer: true }), { flag: false, guests: true, orderType: true, newCustomer: true });
  assert.deepEqual(orderDetailsSections(null), { flag: false, guests: false, orderType: false, newCustomer: false });
  assert.equal(orderDetailsOn({ promptNewCustomer: true }), true);
  assert.equal(orderDetailsOn({}), false);
  assert.equal(orderDetailsSummary({ dineInFlagPrompt: true, promptGuests: true, promptOrderType: true, promptNewCustomer: true }), 'Flag number, guests, order type, new customer');
  assert.equal(orderDetailsSummary({ promptNewCustomer: true }), 'New customer');
  assert.equal(orderDetailsSummary({}), null);
});

test('the pop up asks only the parts that are on and still unanswered; never on a floor table', () => {
  const all = { dineInFlagPrompt: true, promptGuests: true, promptOrderType: true, promptNewCustomer: true };
  assert.deepEqual(needsOrderDetails({ deviceConfig: all, orderType: 'dine-in', activeTableId: null, walkInOrder: { items: [{}] } }),
    { flag: true, guests: true, orderType: true, newCustomer: true });
  // Answered parts drop out one by one.
  assert.deepEqual(needsOrderDetails({ deviceConfig: all, orderType: 'dine-in', activeTableId: null, walkInOrder: { tableFlag: '30', covers: 4, orderTypeChosen: true, newCustomer: false } }), null);
  assert.deepEqual(needsOrderDetails({ deviceConfig: all, orderType: 'dine-in', activeTableId: null, walkInOrder: { tableFlag: '30', covers: 4, orderTypeChosen: true } }),
    { flag: false, guests: false, orderType: false, newCustomer: true });
  // No means answered too: only an unanswered question asks.
  assert.equal(needsOrderDetails({ deviceConfig: { promptNewCustomer: true }, orderType: 'takeaway', activeTableId: null, walkInOrder: { newCustomer: false } }), null);
  // The flag and the guests are dine in only; the type and the question ask on every type.
  assert.deepEqual(needsOrderDetails({ deviceConfig: all, orderType: 'takeaway', activeTableId: null, walkInOrder: null }),
    { flag: false, guests: false, orderType: true, newCustomer: true });
  // A floor table never asks.
  assert.equal(needsOrderDetails({ deviceConfig: all, orderType: 'dine-in', activeTableId: 't1', walkInOrder: null }), null);
  // Everything off: nothing pops up (the flag rule is unchanged).
  assert.equal(needsOrderDetails({ deviceConfig: {}, orderType: 'dine-in', activeTableId: null, walkInOrder: null }), null);
  assert.equal(needsOrderDetails(), null);
  // The 30 Sep 2026 rule and the pop up agree on the flag.
  assert.equal(needsOrderDetails({ deviceConfig: { dineInFlagPrompt: true }, orderType: 'dine-in', activeTableId: null, walkInOrder: null }).flag,
    needsFlagPrompt({ deviceConfig: { dineInFlagPrompt: true }, orderType: 'dine-in', activeTableId: null, walkInOrder: null }));
});

test('the order carries its guests only while it is dine in; Yes alone is a new customer', () => {
  assert.equal(orderCovers({ covers: 4 }, 'dine-in'), 4);
  assert.equal(orderCovers({ covers: 4 }, 'takeaway'), null);
  assert.equal(orderCovers({}, 'dine-in'), null);
  assert.equal(orderCovers(null, 'dine-in'), null);
  assert.equal(orderIsNewCustomer({ newCustomer: true }), true);
  assert.equal(orderIsNewCustomer({ newCustomer: false }), false);
  assert.equal(orderIsNewCustomer({ newCustomer: 'yes' }), false);
  assert.equal(orderIsNewCustomer(null), false);
  assert.equal(NEW_CUSTOMER_LABEL, 'NEW CUSTOMER');
});

test('the answers are cleaned for the order; a part not shown keeps its old value', () => {
  assert.deepEqual(cleanOrderDetails({ orderType: 'takeaway', tableFlag: '0030', covers: '6', newCustomer: true }),
    { orderTypeChosen: true, orderType: 'takeaway', tableFlag: '0030', covers: 6, newCustomer: true });
  assert.deepEqual(cleanOrderDetails({ newCustomer: 'yes' }), { orderTypeChosen: true, newCustomer: false });
  assert.deepEqual(cleanOrderDetails({ orderType: 'bogus' }), { orderTypeChosen: true });
  assert.deepEqual(cleanOrderDetails({}), { orderTypeChosen: true });
  assert.deepEqual(cleanOrderDetails(), { orderTypeChosen: true });
});

test('a new customer ticket: the meta keeps the mark, the view shows it, the docket prints it big', () => {
  const meta = buildTicketMeta({ channel: 'till', orderType: 'dine-in', orderRef: 'R1209', newCustomer: true });
  assert.equal(meta.newCustomer, true);
  assert.equal(buildTicketMeta({ channel: 'till', orderType: 'dine-in' }).newCustomer, false);
  assert.equal(ticketMeta({ meta }).newCustomer, true, 'a stored row reads the mark back');
  assert.equal(ticketView({ id: 'k1', meta, covers: 4, items: [] }).newCustomer, true);
  assert.equal(ticketView({ id: 'k1', meta, covers: 4, items: [] }).coversLabel, '4 cv', 'the guests show as covers');
  assert.equal(ticketView({ id: 'k2', meta: buildTicketMeta({ channel: 'till', orderType: 'takeaway' }), covers: 1, items: [] }).newCustomer, false);
  const doc = buildKitchenTicketDoc({ table: 'Table 30 · #09', server: 'Sam', covers: 4, centreName: 'Hot kitchen', items: [{ qty: 1, name: 'Latte' }], sentAt: Date.now(), newCustomer: true });
  const text = JSON.stringify(doc);
  assert.ok(text.includes('** NEW CUSTOMER **'), 'docket line');
  assert.ok(text.includes('Covers: 4'), 'docket covers');
  assert.ok(!JSON.stringify(buildKitchenTicketDoc({ table: 'T1', items: [], sentAt: Date.now() })).includes('NEW CUSTOMER'), 'not on an ordinary docket');
});
