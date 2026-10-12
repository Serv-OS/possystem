// src/lib/quietTillWiring.test.js
//
// Source pins for the quiet till (v5.11.52, 12 Oct 2026).
//
// The master till sends QR, online, kiosk, delivery app and catering orders to the kitchen
// (routeKioskOrderPrints in store/index.js). It used to put a message on the till for EVERY
// such order, even when everything had worked: "Routing ...", then "routed" with a tick, or a
// warning that a kitchen screen had no printer. Every Coffee Boy venue runs kitchen screens with
// no printers, so that warning showed on every single order.
// Peter: "we dont want it to show on the POS a routing message, whats the point, it just needs
// to do it".
//
// The rule: an order that is routed with nothing wrong shows NOTHING on the till. The till
// speaks only when something needs attention. This file pins the rule by reading the source,
// and by running the lifted blocks with the store's own toast code on a clock, as
// masterTillWiring.test.js does for the blocks beside them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { orderTypeFallbackMessage, orderTypeLabelOf } from './productionRouting.js';
import { CHANGELOG } from './changelog.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));   // .../src/
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const count = (s, text) => s.split(text).length - 1;
const between = (s, from, to) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, 'start marker not found: ' + from);
  const b = s.indexOf(to, a + from.length);
  assert.ok(b > a, 'end marker not found: ' + to);
  return s.slice(a, b);
};
/** The same text with its comment lines left out. The comments say what was removed, in its own words. */
const codeOf = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const STORE = read('store/index.js');
const ROUTE = between(STORE, 'routeKioskOrderPrints: async', '\n  printHubriseReceipt: async');
const CODE = codeOf(ROUTE);
const CLAIM_END = ".select('ref, type');";
const TOAST_CALL = /\bshow(?:Delayed)?Toast\s*(?:\?\.)?\(/g;

// ── the words ────────────────────────────────────────────────────────────────

test('the three messages are gone: no "Routing", no "routed" and no "no printer mapped" on the till', () => {
  assert.ok(!/Routing \$\{/.test(CODE), 'the "Routing ..." message');
  assert.ok(!/routed (to|\u2192) /.test(CODE), 'the "routed" messages');
  assert.ok(!CODE.includes('\u2713'), 'the tick');
  assert.ok(!/no printer mapped/i.test(CODE), 'the "no printer mapped" warning');
  assert.ok(!CODE.includes('(KDS only)'));
  // Nothing in the action is a success message any more.
  assert.ok(!CODE.includes("'success'"));
  // The const that only the "Routing ..." message read went with it (an unused name is a lint error).
  assert.ok(!CODE.includes('srcUpper'));
  // What the action writes to the console is as it was.
  assert.equal(count(CODE, "console.log('[routeKioskOrderPrints] routed', order.ref, 'to', Object.keys(byCentre).length, 'centres');"), 1);
  assert.equal(count(CODE, "console.log('[routeKioskOrderPrints] ENTRY', order.ref, 'source:', order.source,"), 1);
  assert.equal(count(CODE, "'printer:', printerId ? `${centre.printer.name} (${printerId})` : 'NONE \u2014 KDS only, no paper',"), 1);
});

test('every message the action can raise, listed: seven, each one a problem, and none of them info or success once the order is claimed', () => {
  assert.equal((CODE.match(TOAST_CALL) || []).length, 7, 'a new message in this action must be added to this list on purpose');
  const claimAt = CODE.indexOf(CLAIM_END);
  assert.ok(claimAt > 0);

  // Before the claim (the order is NOT routed): overdue orders were held.
  const held = "showToast?.('Some overdue orders were held \u2014 release them manually in Orders', 'info', 6000);";
  assert.equal(count(CODE, held), 1);
  assert.ok(CODE.indexOf(held) < claimAt, 'the held message is raised before the claim, never on the routed path');

  // After the claim, each with its words and its type as written.
  const kept = [
    // One of the two toasts on a line that had no kitchen screen: a delivery app item that is not in our menu.
    "showToast?.(`\u26a0 ${srcLabel} ${order.ref}: ${unknown.length} item(s) not in our menu (${unknown.map(i => i.name).join(', ')}) \u2014 sent to default centre. Re-push the HubRise catalog.`, 'warning');",
    "useStore.getState().showToast?.(`${order.ref} did NOT reach the kitchen screen \u2014 ${kdsErr.message}`, 'error');",
    "showToast?.(`\u26a0 ${srcLabel} ${order.ref} did not print: ${reason}`, 'error');",
    // The order type fallback warning.
    "if (typeFallback) useStore.getState().showDelayedToast?.(orderTypeFallbackMessage(typeKey), 'warning', toastOnScreen ? 3000 : 0);",
    // The route notice of v5.11.51 (a line had no kitchen screen, or the order was sent before the menu was held).
    "setTimeout(() => useStore.getState().showToast?.(routeWords.toast, 'warning', 9000), (toastOnScreen ? 3200 : 0) + (typeFallback ? 3000 : 0));",
  ];
  for (const text of kept) {
    assert.equal(count(CODE, text), 1, text);
    assert.ok(CODE.indexOf(text) > claimAt, text);
  }
  // The seventh: the database column that stops double tickets is missing (once per session).
  assert.match(CODE, /useStore\.getState\(\)\.showToast\?\.\(\n\s*'\u26a0 Duplicate prints risk: [^\n]*',\n\s*'error', 15000\n\s*\);/);

  // So on the routed path every toast names its type, and it is a warning or an error.
  const routed = CODE.slice(claimAt);
  assert.equal((routed.match(TOAST_CALL) || []).length, 6);
  assert.ok(!/,\s*'info'\s*[,)]/.test(routed), 'no info toast once the order is claimed');
  assert.ok(!routed.includes("'success'"), 'no success toast once the order is claimed');
  // Between the claim and the kitchen ticket nothing is said at all (the "Routing ..." message sat here).
  const claimToStamp = between(CODE, CLAIM_END, 'let routeStamp = null;');
  assert.equal(count(claimToStamp, 'Toast'), 1, 'only the missing column error');
  assert.ok(claimToStamp.includes('useStore._colWarningShown = true;'), 'and that one is raised once per session');
});

// ── run as written ───────────────────────────────────────────────────────────

// The store's own toast code, lifted and run on a clock: showToast (one slot, a toast only ever
// clears itself) and showDelayedToast.
const TOAST_FROM = "  showToast: (msg,type='info',ms=2800) => {";
const TOAST_END = "  showDelayedToast: (msg,type='info',delayMs=3000) => { setTimeout(()=>get().showToast(msg,type), delayMs); },";
assert.ok(STORE.indexOf(TOAST_FROM) > 0 && STORE.indexOf(TOAST_END) > STORE.indexOf(TOAST_FROM), 'the toast code moved');
const TOAST_SRC = STORE.slice(STORE.indexOf(TOAST_FROM), STORE.indexOf(TOAST_END) + TOAST_END.length);

/** A till with the real toast slot and a clock. `screen` is every toast that was on it: [from, words, type, until]. */
const makeTill = () => {
  let now = 0;
  const timers = [];
  const screen = [];
  const state = { toast: null, printJobs: [] };
  const set = (patch) => {
    const p = typeof patch === 'function' ? patch(state) : patch;
    if ('toast' in p) {
      const open = screen.find((row) => row[3] === null);
      if (open) open[3] = now;                                  // it cleared itself, or the next one replaced it
      if (p.toast) screen.push([now, p.toast.msg, p.toast.type, null]);
    }
    Object.assign(state, p);
  };
  const get = () => state;
  const setTimeoutOnClock = (fn, ms) => { timers.push({ at: now + (ms || 0), fn }); };
  Object.assign(state, new Function('set', 'get', 'setTimeout', 'return {\n' + TOAST_SRC + '\n};')(set, get, setTimeoutOnClock));
  const runClock = () => {
    while (timers.length) {
      timers.sort((x, y) => x.at - y.at);                       // a stable sort: the same moment keeps its order
      const t = timers.shift();
      now = t.at;
      t.fn();
    }
  };
  return { state, screen, set, get, setTimeout: setTimeoutOnClock, runClock, useStore: { getState: get } };
};

// The end of the action as it is written: the "did not print" check, the order type warning, and
// the route notice. In the store the status write sits between the two blocks. Here they run back
// to back, as if that write took no time, which is the tightest the timing can be.
const TAIL_FROM = '      if (Object.keys(byCentre).length === 0) {\n        const dump = {';
const TAIL_END = "if (typeFallback) useStore.getState().showDelayedToast?.(orderTypeFallbackMessage(typeKey), 'warning', toastOnScreen ? 3000 : 0);";
const NOTICE_FROM = '      try {\n        if (routeWords && Object.keys(byCentre).length > 0) {';
const NOTICE_END = "} catch (e) { console.warn('[routeKioskOrderPrints] route notice failed:', e?.message || e); }";
const sliceIn = (s, from, end) => {
  const a = s.indexOf(from);
  assert.ok(a > 0, 'start marker not found: ' + from);
  const b = s.indexOf(end, a);
  assert.ok(b > a, 'end marker not found: ' + end);
  return s.slice(a, b + end.length);
};
const TAIL = sliceIn(ROUTE, TAIL_FROM, TAIL_END);
const NOTICE = sliceIn(ROUTE, NOTICE_FROM, NOTICE_END);
const TAIL_NAMES = ['byCentre', 'routingConfig', 'order', 'typeKey', 'console', 'orderTypeLabelOf', 'showToast', 'srcLabel', 'typeFallback',
  'useStore', 'orderTypeFallbackMessage', 'routeWords', 'logActivity', 'locId', 'routeStamp', 'setTimeout'];

/** Run the end of the action on a fresh till. `before` puts a message on the till first, as an earlier line of the action would. */
const runTail = (over = {}, before = null) => {
  const till = makeTill();
  const warned = []; const events = [];
  const env = {
    // The Coffee Boy set up: one order, one centre, a kitchen screen with no printer.
    byCentre: { drinks: [{ name: 'Latte' }] },
    routingConfig: { centres: [{ id: 'drinks', name: 'KDS drinks', printer: null }], routing: { drinks: { cats: ['coffee'] } } },
    order: { ref: 'QR-1', source: 'qr', items: [{ name: 'Latte', cat: 'coffee' }] },
    typeKey: 'takeaway', console: { warn: (...a) => warned.push(a.join(' ')), log: () => {} },
    orderTypeLabelOf, showToast: till.state.showToast, srcLabel: 'QR', typeFallback: false,
    useStore: till.useStore, orderTypeFallbackMessage, routeWords: null,
    logActivity: (loc, ev) => { events.push(ev); return Promise.resolve(); }, locId: 'loc-A', routeStamp: { deviceName: 'POS' },
    setTimeout: till.setTimeout,
    ...over,
  };
  if (before) before(till);
  new Function(...TAIL_NAMES, TAIL + '\n' + NOTICE)(...TAIL_NAMES.map((n) => env[n]));
  till.runClock();
  return { screen: till.screen, warned, events };
};
const FALLBACK = orderTypeFallbackMessage('takeaway');
const NOTICE_WORDS = { toast: 'QR-1: Latte went to Food. No kitchen screen is set for it.', title: 'No kitchen screen', body: 'B' };
const NOT_REACHED = 'QR-1 did NOT reach the kitchen screen \u2014 offline';
const notReached = (till) => till.state.showToast(NOT_REACHED, 'error');

test('run as written: an order routed with nothing wrong puts NOTHING on the till, printer or no printer', () => {
  const quiet = runTail();
  assert.deepEqual(quiet.screen, [], 'a kitchen screen with no printer is a chosen set up, not a fault');
  assert.deepEqual(quiet.events, []);
  assert.deepEqual(quiet.warned, []);
  // The same with a printer on the centre, and with several centres.
  const printer = { id: 'p1', name: 'Kitchen printer' };
  assert.deepEqual(runTail({ routingConfig: { centres: [{ id: 'drinks', name: 'Bar', printer }], routing: {} } }).screen, []);
  assert.deepEqual(runTail({
    byCentre: { food: [{ name: 'Toastie' }], drinks: [{ name: 'Latte' }] },
    routingConfig: { centres: [{ id: 'food', name: 'Food', printer }, { id: 'drinks', name: 'KDS drinks', printer: null }], routing: {} },
  }).screen, []);
});

test('run as written: the two warnings are still shown and read, at once when nothing is on the till', () => {
  // The order type warning alone: at once (it used to wait 3 seconds behind the routed toast).
  assert.deepEqual(runTail({ typeFallback: true }).screen, [[0, FALLBACK, 'warning', 2800]]);
  // The route notice alone: at once, for its full 9 seconds.
  const notice = runTail({ routeWords: NOTICE_WORDS });
  assert.deepEqual(notice.screen, [[0, NOTICE_WORDS.toast, 'warning', 9000]]);
  assert.equal(notice.events.length, 1, 'the activity feed keeps the same note');
  // Both: the order type warning first for its full time, then the notice. Neither cuts the other short.
  assert.deepEqual(runTail({ typeFallback: true, routeWords: NOTICE_WORDS }).screen, [
    [0, FALLBACK, 'warning', 2800],
    [3000, NOTICE_WORDS.toast, 'warning', 12000],
  ]);
});

test('run as written: a message already on the till is read in full first, then the warnings in turn', () => {
  // The kitchen screen refused the ticket a moment earlier in the action. Before v5.11.52 the
  // "routed" toast replaced that error the moment it was raised.
  assert.deepEqual(runTail({ typeFallback: true, routeWords: NOTICE_WORDS }, notReached).screen, [
    [0, NOT_REACHED, 'error', 2800],
    [3000, FALLBACK, 'warning', 5800],
    [6200, NOTICE_WORDS.toast, 'warning', 15200],
  ]);
  assert.deepEqual(runTail({ routeWords: NOTICE_WORDS }, notReached).screen, [
    [0, NOT_REACHED, 'error', 2800],
    [3200, NOTICE_WORDS.toast, 'warning', 12200],
  ]);
  assert.deepEqual(runTail({ typeFallback: true }, notReached).screen, [
    [0, NOT_REACHED, 'error', 2800],
    [3000, FALLBACK, 'warning', 5800],
  ]);
  // And with nothing more to say, the error simply stays for its time.
  assert.deepEqual(runTail({}, notReached).screen, [[0, NOT_REACHED, 'error', 2800]]);
});

test('run as written: nothing routed still says "did not print" with its reason, and the order type warning waits behind it', () => {
  const none = runTail({ byCentre: {}, routingConfig: { centres: [], routing: {} }, typeFallback: true, routeWords: NOTICE_WORDS });
  assert.deepEqual(none.screen, [
    [0, '\u26a0 QR QR-1 did not print: no production centres configured', 'error', 2800],
    [3000, FALLBACK, 'warning', 5800],
  ]);
  assert.deepEqual(none.events, [], 'no route notice when nothing was routed');
  assert.equal(none.warned.length, 1);
  assert.match(none.warned[0], /NOTHING ROUTED for QR-1/);
  // The other reasons, word for word as before.
  const reasonOf = (over) => runTail({ byCentre: {}, ...over }).screen[0][1];
  assert.equal(reasonOf({ routingConfig: { centres: [{ id: 'food' }], routing: {} } }),
    '\u26a0 QR QR-1 did not print: centres exist but no category routing rules');
  assert.equal(reasonOf({ order: { ref: 'QR-1', items: [{ name: 'Latte' }] } }),
    '\u26a0 QR QR-1 did not print: order items have no `cat` field \u2014 try refreshing customer browser');
  assert.equal(reasonOf({}),
    "\u26a0 QR QR-1 did not print: item cats (coffee) don't match any centre that takes Takeaway");
});

// ── the print job for a kitchen screen with no printer ───────────────────────

// routePrintJob has its own "No printer mapped" warning. It is raised before the first wait, so
// until v5.11.52 the "routed" toast replaced it in the same breath and nobody ever saw it. With
// that toast gone it would have shown on every order at a venue that runs screens only.
const PRINT_FROM = '  routePrintJob: async (job) => {';
const PRINT_HEAD = between(STORE, PRINT_FROM, '\n    // v4.6.8: Fire-marker jobs take a dedicated idempotency key').slice(PRINT_FROM.length);
const runPrintHead = (job, centres) => {
  const till = makeTill();
  const toasts = [];
  till.state.showToast = (...a) => toasts.push(a);
  till.state.printRouting = { centres, routing: {} };
  const fn = new Function('job', 'isTrainingMode', 'useStore', 'localStorage', 'set', 'get', PRINT_HEAD + "\n    return 'on to the printer';");
  const out = fn(job, () => false, till.useStore, { getItem: () => null }, till.set, till.get);
  return { out, toasts, jobs: till.state.printJobs };
};

test('the print job, run as written: a kitchen screen with no printer by choice says nothing, and a real fault still speaks', () => {
  assert.ok(!/\bawait\b/.test(codeOf(PRINT_HEAD)), 'the warning is raised before the first wait');
  const screenOnly = [{ id: 'drinks', name: 'KDS drinks', printer: null }];
  const job = { centreId: 'drinks', printerName: 'KDS drinks', items: [{ qty: 1, name: 'Latte' }], type: 'kitchen' };

  // A QR, online or kiosk order to a centre the saved routing holds with no printer.
  const quiet = runPrintHead({ ...job, kdsOnly: true }, screenOnly);
  assert.deepEqual(quiet.toasts, []);
  assert.equal(quiet.out, undefined, 'it stops there, as before: there is nothing to print on');
  assert.equal(quiet.jobs.length, 1);
  assert.equal(quiet.jobs[0].status, 'no-printer', 'the marker is still kept');
  assert.equal(quiet.jobs[0].centreId, 'drinks');

  // A till order (no mark): exactly as before, words and type.
  const tillOrder = runPrintHead(job, screenOnly);
  assert.deepEqual(tillOrder.toasts, [['No printer mapped for KDS drinks \u2014 ticket shown on KDS only', 'warn']]);
  assert.equal(tillOrder.jobs[0].status, 'no-printer');

  // The saved routing gives the centre a printer but this till's copy has none: paper was
  // expected and none came. That is a fault and the till says so.
  const fault = runPrintHead({ ...job, kdsOnly: false }, screenOnly);
  assert.deepEqual(fault.toasts, [['No printer mapped for KDS drinks \u2014 ticket shown on KDS only', 'warn']]);

  // This till knows a printer for the centre: it prints, whatever the mark says.
  const withPrinter = [{ id: 'drinks', name: 'Bar', printer: { id: 'p1', name: 'Bar printer' } }];
  for (const mark of [true, false, undefined]) {
    const prints = runPrintHead({ ...job, kdsOnly: mark }, withPrinter);
    assert.equal(prints.out, 'on to the printer');
    assert.deepEqual(prints.toasts, []);
    assert.deepEqual(prints.jobs, []);
  }
});

test('the mark has one writer: the channel route, from the printer the saved routing holds for the centre', () => {
  const storeCode = codeOf(STORE);
  assert.equal(count(storeCode, 'kdsOnly'), 2, 'one writer and one reader');
  assert.equal(count(storeCode, 'if (!job.kdsOnly) get().showToast(`No printer mapped for ${centre?.name || job.centreId} \u2014 ticket shown on KDS only`, \'warn\');'), 1);
  const loop = between(CODE, 'Object.entries(byCentre).forEach(([centreId, items]) => {', "console.log('[routeKioskOrderPrints] routed'");
  assert.equal(count(loop, 'const centre = routingConfig.centres?.find(c => c.id === centreId);'), 1);
  assert.equal(count(loop, 'const printerId = centre?.printer?.id || null;'), 1);
  assert.equal(count(loop, 'kdsOnly: !printerId,'), 1);
  // Words only: the job is still handed over for every centre, printer or not.
  assert.equal(count(loop, 'get().routePrintJob({'), 1);
  assert.ok(!/if \(printerId\)|if \(!printerId\)/.test(loop), 'no centre is skipped');
});

// ── a person's press: Orders, "Send to kitchen again" ────────────────────────

// The quiet rule is for the automatic route. A button a person presses must still answer.
// Until v5.11.52 the "Routing" and "routed" messages were the only sign that this button had
// worked: it had no busy state and no words of its own. With them gone a press that worked
// looked the same as a press that failed, and a forced press skips the once only checks, so
// every extra press puts the order on the kitchen screen again. The action stays quiet (the
// count of seven above is unchanged). It hands back an outcome and the button says the words.
const HUB = read('surfaces/OrdersHub.jsx');
const SENT_WORDS = 'Sent to the kitchen again';
const NOT_SENT_WORDS = 'Not sent. Check the connection and try again.';

test('the route hands back one outcome, at its very end, and says nothing about it itself', () => {
  const RETURN = 'return { sent: Object.keys(byCentre).length > 0 && !kitchenScreenRefused };';
  assert.equal(count(CODE, 'return { sent:'), 1, 'one outcome, in one place');
  assert.equal(count(CODE, RETURN), 1);
  // The last thing the action does: after the route notice, and straight before the catch.
  assert.ok(CODE.indexOf(RETURN) > CODE.indexOf(NOTICE_END), 'after the route notice');
  assert.match(CODE, /route notice failed:', e\?\.message \|\| e\); \}\n\s*return \{ sent: [^\n]*\n\s*\} catch \(e\) \{\n\s*console\.warn\('\[routeKioskOrderPrints\] failed:', e\?\.message\);\n\s*\}\n\s*\},\s*$/);
  // Every way out before the claim is settled hands back nothing (the button reads that as not sent).
  const early = CODE.slice(0, CODE.indexOf('const claimedRow = r.data?.[0] || null;'));
  assert.ok(early.includes("if (r.error) { console.warn('[routeKioskOrderPrints] claim failed', r.error); return; }"), 'a claim that failed (no connection) hands back nothing');
  assert.ok(!/return \{/.test(early), 'no outcome before the order is claimed');
  // The flag has one writer, set only when the kitchen screen refused the ticket.
  assert.equal(count(CODE, 'kitchenScreenRefused'), 3);
  assert.equal(count(CODE, 'let kitchenScreenRefused = false;'), 1);
  assert.match(CODE, /if \(kdsErr\) \{\n\s*kitchenScreenRefused = true;\n\s*console\.warn\('\[routeKioskOrderPrints\] kds insert', kdsErr\);/);
  // As written: sent only when a centre took the order and the kitchen screen did not refuse it.
  const sent = (byCentre, kitchenScreenRefused) => new Function('byCentre', 'kitchenScreenRefused', RETURN)(byCentre, kitchenScreenRefused);
  assert.deepEqual(sent({ drinks: [{}] }, false), { sent: true });
  assert.deepEqual(sent({ drinks: [{}] }, true), { sent: false });
  assert.deepEqual(sent({}, false), { sent: false });
  // The words belong to the button. The action holds neither line.
  assert.ok(!CODE.includes(SENT_WORDS) && !CODE.includes('Not sent.'));
});

test('the button: busy while it sends, and the press is the one in the handler', () => {
  assert.equal(count(HUB, 'const [kitchenBusy, setKitchenBusy] = useState(false);'), 1);
  assert.equal(count(HUB, '<button onClick={sendToKitchenAgain} disabled={kitchenBusy}'), 1);
  assert.equal(count(HUB, "{kitchenBusy ? 'Sending…' : '🍳 Send to kitchen again'}"), 1);
  assert.equal(count(HUB, 'sendToKitchenAgain'), 2, 'one handler, one button');
  // Still a forced press stamped manual, once in the file (masterTillWiring.test.js pins the same).
  assert.equal(count(HUB, "{ force: true, trigger: 'manual' }"), 1);
});

// The handler as it is written, lifted and run against a store with the real toast slot.
const PRESS_FROM = '  const sendToKitchenAgain = async () => {';
const PRESS_END = '    finally { setKitchenBusy(false); }\n  };';
const PRESS = sliceIn(HUB, PRESS_FROM, PRESS_END).slice(PRESS_FROM.length, -'\n  };'.length);
const AsyncFunction = (async () => {}).constructor;
const DID_NOT_PRINT = '⚠ QR QR-1 did not print: no production centres configured';

/** One press. `route(till)` stands in for the route: it may put a message on the till, and hands back its outcome. */
const press = async ({ route, viewOrder = { ref: 'QR-1', items: [{ name: 'Latte' }], _raw: { source: 'qr', type: 'takeaway' } }, kitchenBusy = false, before = null } = {}) => {
  const till = makeTill();
  const busy = []; const calls = [];
  if (before) before(till);
  till.state.routeKioskOrderPrints = async (order, opts) => { calls.push([order, opts, [...busy]]); return route ? route(till) : undefined; };
  const fn = new AsyncFunction('viewOrder', 'kitchenBusy', 'setKitchenBusy', 'useStore', 'showToast', PRESS);
  await fn(viewOrder, kitchenBusy, (v) => busy.push(v), till.useStore, till.state.showToast);
  // What is on the till when the press is over, before any toast times out.
  const shown = till.state.toast ? [till.state.toast.msg, till.state.toast.type] : null;
  return { shown, screen: till.screen, busy, calls };
};

test('a press, run as written: it worked, so the till says so once, and the button was busy meanwhile', async () => {
  const ok = await press({ route: () => ({ sent: true }) });
  assert.deepEqual(ok.shown, [SENT_WORDS, 'success']);
  assert.equal(ok.screen.length, 1);
  assert.deepEqual(ok.busy, [true, false], 'busy, then free again');
  // The route got the open order, forced and stamped manual, while the button was busy.
  assert.equal(ok.calls.length, 1);
  assert.deepEqual(ok.calls[0][0], { source: 'qr', type: 'takeaway', ref: 'QR-1', items: [{ name: 'Latte' }] });
  assert.deepEqual(ok.calls[0][1], { force: true, trigger: 'manual' });
  assert.deepEqual(ok.calls[0][2], [true]);
  // An older message that was still on the till makes way for the answer.
  const old = await press({ route: () => ({ sent: true }), before: (till) => till.state.showToast('QR-9 collected', 'info') });
  assert.deepEqual(old.shown, [SENT_WORDS, 'success']);
});

test('a press, run as written: nothing came back (no connection, a claim that failed, a throw inside the route), so the till says Not sent', async () => {
  const none = await press({ route: () => undefined });
  assert.deepEqual(none.shown, [NOT_SENT_WORDS, 'error']);
  assert.deepEqual(none.busy, [true, false]);
  // An older message on the till does not pass for an answer.
  const old = await press({ route: () => undefined, before: (till) => till.state.showToast('QR-9 collected', 'info') });
  assert.deepEqual(old.shown, [NOT_SENT_WORDS, 'error']);
  // A store with no route at all (it never happens, but the press must still answer).
  const till = makeTill();
  const said = [];
  await new AsyncFunction('viewOrder', 'kitchenBusy', 'setKitchenBusy', 'useStore', 'showToast', PRESS)(
    { ref: 'QR-1', items: [], _raw: {} }, false, () => {}, till.useStore, (...a) => said.push(a));
  assert.deepEqual(said, [[NOT_SENT_WORDS, 'error']]);
});

test('a press, run as written: a problem the route named itself stays on the till, the button does not talk over it', async () => {
  // Nothing was routed: the route said why.
  const noCentre = await press({ route: (till) => { till.state.showToast(DID_NOT_PRINT, 'error'); return { sent: false }; } });
  assert.deepEqual(noCentre.shown, [DID_NOT_PRINT, 'error']);
  assert.equal(noCentre.screen.length, 1);
  // The kitchen screen refused the ticket.
  const refused = await press({ route: (till) => { notReached(till); return { sent: false }; } });
  assert.deepEqual(refused.shown, [NOT_REACHED, 'error']);
  // It was sent, with a warning (a delivery app item that is not in our menu): the warning stays.
  const WARNED = '⚠ HubRise H-1: 1 item(s) not in our menu (Latte)';
  const warned = await press({ route: (till) => { till.state.showToast(WARNED, 'warning'); return { sent: true }; } });
  assert.deepEqual(warned.shown, [WARNED, 'warning']);
  assert.deepEqual(warned.busy, [true, false]);
});

test('a press, run as written: a throw is reported, the button is freed, and a second press while busy does nothing', async () => {
  const thrown = await press({ route: () => { throw new Error('boom'); } });
  assert.deepEqual(thrown.shown, ['Could not send: boom', 'error']);
  assert.deepEqual(thrown.busy, [true, false], 'never left busy');
  // Busy: the press is ignored. Nothing is sent a second time and nothing is said.
  const twice = await press({ route: () => ({ sent: true }), kitchenBusy: true });
  assert.deepEqual([twice.calls, twice.busy, twice.shown], [[], [], null]);
  // No order open: the same.
  const closed = await press({ route: () => ({ sent: true }), viewOrder: null });
  assert.deepEqual([closed.calls, closed.busy, closed.shown], [[], [], null]);
});

test('the words on the button are plain and hold no long dash', () => {
  for (const words of [SENT_WORDS, NOT_SENT_WORDS]) {
    assert.equal(count(HUB, `showToast('${words}'`), 1, words);
    assert.ok(!/[\u2013\u2014]/.test(words));
  }
  assert.ok(HUB.includes("if (outcome?.sent) showToast('Sent to the kitchen again', 'success');"));
  assert.ok(HUB.includes("else showToast('Not sent. Check the connection and try again.', 'error');"));
  const entry = CHANGELOG.find((e) => e.v === '5.11.52');
  const line = entry.items.filter((i) => /^Orders: Send to kitchen again now tells you what happened\./.test(i));
  assert.equal(line.length, 1);
  assert.ok(line[0].includes(SENT_WORDS) && line[0].includes('Not sent'));
});

// ── what the owner reads ─────────────────────────────────────────────────────

test('the release note says it in plain words, with no long dash', () => {
  const entry = CHANGELOG.find((e) => e.v === '5.11.52');
  assert.ok(entry, 'the 5.11.52 entry');
  const line = entry.items.filter((i) => /no longer shows a message/.test(i));
  assert.equal(line.length, 1);
  assert.match(line[0], /^Master till: when a QR, online, kiosk or delivery order is sent to the kitchen and all is well/);
  assert.match(line[0], /only speaks when something needs attention\.$/);
  for (const item of entry.items) assert.ok(!/[\u2013\u2014]/.test(item), 'a long dash in: ' + item.slice(0, 60));
});

test('this file holds no long dashes', () => {
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.ok(!/[\u2013\u2014]/.test(self));
});
