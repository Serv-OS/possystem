/**
 * tillOrderType.test.js: the till's default order type and the dine in flag number (Peter,
 * Coffee Boy, 30 Sep 2026). Run: `node --test src/lib/tillOrderType.test.js`.
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
} from './tillOrderType.js';
import { buildTicketMeta, ticketHeadline, kdsTypeKey } from './kds/kdsTicket.js';

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
  has(src, "import { defaultOrderTypeFor, orderFlag, flagTableLabel, flagTicketLabel, cleanFlagNumber } from '../lib/tillOrderType';", 'import');
  // The store's initial orderType comes from the cached device config (a plain reload never
  // reaches setDeviceConfig: every boot path is change gated in App.jsx deviceConfigChanged).
  has(src, "  orderType: (() => {\n    try {\n      const raw = sessionStorage.getItem('rpos-terminal-config') || localStorage.getItem('rpos-device-config');\n      return defaultOrderTypeFor(raw ? JSON.parse(raw) : null);\n    } catch { return 'dine-in'; }\n  })(),", 'boot default');
  assert.ok(!src.includes("\n  orderType: 'dine-in',\n"), 'the literal dine in start is gone');
  // setDeviceConfig (boot, Apply to this terminal, Push to POS) applies it only while nothing is rung up.
  has(src, "if (!get().activeTableId && !get().walkInOrder?.items?.length) {\n      const startType = defaultOrderTypeFor(finalConfig);", 'setDeviceConfig');
  // clearWalkIn goes back to the default, not always dine in.
  has(src, "clearWalkIn: () => set(s => ({ walkInOrder:null, customer:null, orderType:defaultOrderTypeFor(s.deviceConfig), pendingLoyaltyReward:null }))", 'clearWalkIn');
  // Floor tables still open as dine in (Peter: real tables must stay dine in).
  assert.ok((src.match(/surface:'pos', orderType:'dine-in'/g) || []).length >= 4, 'table opens set dine-in');
  has(src, "set({ activeTableId:tableId, surface:'pos', orderType:'dine-in', walkInOrder:null, customer:null });", 'openTable stays dine-in');
});

test('store: a flag order is a table ticket on the KDS, the paper, the queue and the closed check', () => {
  const src = read('../store/index.js');
  has(src, "setWalkInTableFlag: (flag) => set(s => ({ walkInOrder: { ...(s.walkInOrder || {}), tableFlag: cleanFlagNumber(flag) } }))", 'setWalkInTableFlag');
  has(src, "const flag = orderFlag(order, orderType);\n      const label = flag ? flagTicketLabel(flag, ref)", 'kitchen label');
  has(src, "channel: 'till', orderType, isTable: !!flag,", 'KDS meta isTable');
  has(src, "...(flag ? { tableFlag: flag } : {}) },", 'queue entry carries the flag');
  // With no customer the ticket label must not become the customer's name ("Table 30 · #09").
  has(src, "customer: { ...(customer ? { ...customer } : { name: flag ? '' : label }),", 'flag order has no fake customer name');
  has(src, "tableLabel: flagTableLabel(orderFlag(walkInOrder, orderType)),", 'closed check table label');
  // The label is built from the ref, so the ref must be taken first.
  const refAt = src.indexOf('const ref = order.ref || getNextOrderRefLocal();\n      // 30 Sep 2026');
  const labelAt = src.indexOf('const label = flag ? flagTicketLabel(flag, ref)');
  assert.ok(refAt > 0 && labelAt > refAt, 'ref is taken before the label');
});

test('POSSurface: the flag is asked before Send and before Pay, and cannot be skipped', () => {
  const src = read('../surfaces/POSSurface.jsx');
  has(src, "import FlagNumberModal from '../components/FlagNumberModal';", 'import');
  has(src, "const flagNeeded = needsFlagPrompt({ deviceConfig, orderType, activeTableId, walkInOrder });", 'flagNeeded');
  has(src, "if (flagNeeded) { setFlagPromptFor('send'); return; }", 'Send asks first');
  // An order that already has its flag sends as Table <n>, never through the table picker.
  has(src, "if (walkInFlag) {\n        setShowCheckout(false);\n        sendToKitchen();\n        clearWalkIn();\n        showToast(`${flagTableLabel(walkInFlag)} sent`, 'success');\n        return;\n      }", 'a flagged order sends straight through');
  has(src, "if (flagNeeded) { setFlagPromptFor('pay'); return; }", 'Pay asks first');
  has(src, "onCheckout={()=>{ setShowReview(false); if(items.length>0) { if (flagNeeded) setFlagPromptFor('pay'); else setShowCheckout(true); } }}", 'Review checkout asks first');
  has(src, "{flagPromptFor && <FlagNumberModal action={flagPromptFor} onConfirm={onFlagEntered} onClose={()=>setFlagPromptFor(null)}/>}", 'modal render');
  // After the flag: set on the order, then the usual send (no table picker) or the usual pay gates.
  has(src, "setWalkInTableFlag(flag);", 'flag saved on the order');
  has(src, "if (next === 'send') {\n      setShowCheckout(false);\n      sendToKitchen();\n      clearWalkIn();", 'send after the flag');
  has(src, "} else if (next === 'pay') {\n      proceedToCheckout();", 'pay after the flag');
  // The order header shows the flag; the drive thru header literal is untouched.
  has(src, ":walkInFlag?flagTableLabel(walkInFlag):orderTypeLabel} · {staff?.name}", 'order header');
  // The receipt and the tip slip printed at pay say Table <n> (the closed check books the same).
  has(src, "const tableLabel = activeTable?.label || flagTableLabel(walkInFlag) || null;", 'receipt table label');
  has(src, "tableLabel: activeTable?.label || flagTableLabel(walkInFlag) || null,", 'tip slip table label');
  // The reader job's draft carries it too, for a check the closer books from the draft.
  const checkout = read('../surfaces/CheckoutModal.jsx');
  has(checkout, "import { orderFlag, flagTableLabel } from '../lib/tillOrderType';", 'checkout import');
  has(checkout, "tableLabel: tableId || flagTableLabel(orderFlag(useStore.getState().walkInOrder, orderType)) || null,", 'checkDraft table label');
  const modal = read('../components/FlagNumberModal.jsx');
  // No Skip button or label: the comment says why, the markup never offers one.
  assert.ok(!/>\s*Skip|['"`]Skip/i.test(modal), 'the keypad has no skip');
  has(modal, 'disabled={!flag}', 'confirm needs a number');
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
  has(src, 'const keep = tillOrderColumnsToKeep(touched, _tillOrderColumns);', 'guard asks the rule');
  has(src, 'const keptTillOrder = await keepTillOrderColumns(row, touched);', 'guard runs on save');
  has(src, '...(_tillOrderColumns === true ? {\n      [DEFAULT_ORDER_TYPE_COLUMN]: cleanDefaultOrderType(p.defaultOrderType, p.enabledOrderTypes),\n      [FLAG_PROMPT_COLUMN]: p.dineInFlagPrompt === true,\n    } : {}),', 'toDbRow sends only when ready');
  has(src, 'defaultOrderType: p[DEFAULT_ORDER_TYPE_COLUMN] || null,', 'mapped default');
  has(src, 'dineInFlagPrompt: p[FLAG_PROMPT_COLUMN] === true,', 'mapped flag');
  has(src, '<TillOrderTypeSettings form={form} upd={upd}/>', 'editor block');
  has(src, 'need a database update first', 'greyed out before the migration');
  // Apply to this terminal hands both to the till.
  has(src, 'defaultOrderType: prof.defaultOrderType || null,', 'apply to this terminal');
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
});
