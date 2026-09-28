// src/lib/paymentBusyWiring.test.js (v5.11.x): every pay surface takes the busy flag and
// gives it back, and the update guards read it.
//
// The flag existed only as a reader: UpdateGuard checked window.__RPOS_BUSY and no file ever set
// it, so a release reloaded Leeds POS 1 mid card payment (27 Sep 2026). A perfect paymentBusy.js
// is worth nothing unless the surfaces hold it, which is wiring, which only reading the real
// files can check. Where a hold must be in place BEFORE a card starts, the test pins the order.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel) => fs.readFileSync(here(rel), 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;

const between = (src, startMarker, endMarker) => {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, `marker not found: ${startMarker}`);
  const j = endMarker ? src.indexOf(endMarker, i + startMarker.length) : src.length;
  assert.ok(j > i, `end marker not found after ${startMarker}: ${endMarker}`);
  return src.slice(i, j);
};
const before = (src, first, second, why) => {
  const a = src.indexOf(first);
  const b = src.indexOf(second);
  assert.ok(a >= 0, `${why}: missing ${first}`);
  assert.ok(b >= 0, `${why}: missing ${second}`);
  assert.ok(a < b, why);
};

// ── the hook ────────────────────────────────────────────────────────────────

test('usePaymentBusy holds while active and releases in the effect cleanup', () => {
  const hook = read('./usePaymentBusy.js');
  assert.ok(hook.includes("import { holdPaymentBusy } from './paymentBusy';"));
  // The release returned by holdPaymentBusy IS the effect cleanup: an unmount always releases.
  assert.ok(hook.includes('useEffect(() => (active ? holdPaymentBusy(reason) : undefined), [active, reason]);'));
});

// ── the readers ─────────────────────────────────────────────────────────────

test('UpdateGuard reads paymentBusy, never the dead global, and looks again right before reloading', () => {
  const g = read('../components/UpdateGuard.jsx');
  assert.ok(g.includes("import { canApplyUpdate, isPaymentBusy, subscribePaymentBusy, updateCountdownStep } from '../lib/paymentBusy';"));
  assert.ok(!/if \(window\.__RPOS_BUSY\)/.test(g), 'the old read of a flag nothing set is gone');
  // The countdown step decides from canApplyUpdate every tick (paused, not re-armed).
  assert.ok(g.includes('const step = updateCountdownStep({ left, mayApply: canApplyUpdate(), nowRequested: nowRef.current });'));
  // applyUpdate: the last thing before the reload is another look at the flag.
  const apply = between(g, 'async function applyUpdate() {', '\n}\n');
  before(apply, 'if (!canApplyUpdate()) return false;', 'window.location.reload();',
    'a payment that started while the caches cleared stops the reload');
  assert.equal(count(g, 'window.location.reload()'), 1, 'one reload, inside applyUpdate');
  // No setState updater runs a side effect any more.
  assert.ok(!g.includes('setCount(c =>'), 'the reload no longer lives inside a state updater');
});

test('UpdateGuard: Update now is refused while a payment holds, and never forces past the quiet period', () => {
  const g = read('../components/UpdateGuard.jsx');
  const now = between(g, 'const updateNow = () => {', '\n  };');
  assert.ok(now.includes('if (isPaymentBusy()) { setBusyNow(true); return; }'), 'refused while busy');
  assert.ok(now.includes('nowRef.current = true;'), 'otherwise the countdown applies it (after the quiet period)');
  assert.ok(!now.includes('applyUpdate('), 'the button never reloads directly');
  assert.ok(g.includes('onClick={updateNow}'));
  assert.ok(g.includes('disabled={busyNow}'));
  assert.ok(g.includes('useEffect(() => subscribePaymentBusy((n) => setBusyNow(n > 0)), []);'));
});

test('KioskAutoUpdate (KDS, boards, clock, bookings, manager) honours the same flag', () => {
  const k = read('../components/KioskAutoUpdate.jsx');
  assert.ok(k.includes("import { canApplyUpdate } from '../lib/paymentBusy';"));
  const check = between(k, 'const check = async () => {', '\n    };');
  before(check, 'if (!canApplyUpdate()) return;', "sessionStorage.setItem('kiosk-au-last'",
    'a busy skip does not burn the 10 minute loop guard');
  before(check, 'if (!canApplyUpdate()) return;', 'window.location.reload();', 'checked before the reload');
});

test('only paymentBusy.js writes window.__RPOS_BUSY, and no code reads it', () => {
  const SRC = here('../');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|jsx)$/.test(e.name) || /\.test\.js$/.test(e.name)) continue;
      const rel = path.relative(SRC, p);
      if (rel === path.join('lib', 'paymentBusy.js')) continue;
      const code = fs.readFileSync(p, 'utf8').split('\n')
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))          // comments may tell the history
        .join('\n');
      if (code.includes('__RPOS_BUSY')) offenders.push(rel);
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], 'read isPaymentBusy() / canApplyUpdate() instead');
  assert.ok(read('./paymentBusy.js').includes('window.__RPOS_BUSY = n;'));
});

// ── the terminal job layer ──────────────────────────────────────────────────

test('a card machine job holds the flag for its send and for as long as this till watches it', () => {
  const tj = read('./payments/terminalJobs.js');
  assert.ok(tj.includes("import { withPaymentBusy } from '../paymentBusy';"));
  assert.ok(tj.includes("export function dispatchTerminalJob(p) {\n  return withPaymentBusy('card machine job send', () => sendTerminalJob(p));\n}"));
  assert.ok(tj.includes("export function pollTerminalJob(jobId, opts) {\n  return withPaymentBusy('card machine job live', () => watchTerminalJob(jobId, opts));\n}"));
  assert.equal(count(tj, 'async function sendTerminalJob(p) {'), 1);
  assert.equal(count(tj, 'async function watchTerminalJob(jobId, { onUpdate, intervalMs = 1000, timeoutMs = 5 * 60_000, signal } = {}) {'), 1);
  // Nothing else can reach the unwrapped bodies from outside the module.
  assert.ok(!/export (async )?function (sendTerminalJob|watchTerminalJob)/.test(tj));
  // The training stop is still the first thing the send does.
  const send = between(tj, 'async function sendTerminalJob(p) {', 'const locationId =');
  assert.ok(send.includes('if (isTrainingMode()) {'));
});

// ── the surfaces ────────────────────────────────────────────────────────────

test('till checkout: busy for as long as the modal is open', () => {
  const co = read('../surfaces/CheckoutModal.jsx');
  assert.ok(co.includes("import { usePaymentBusy } from '../lib/usePaymentBusy';"));
  const modal = between(co, 'export default function CheckoutModal(', 'const startTerminalJob = async () => {');
  assert.equal(count(modal, "usePaymentBusy(true, 'checkout');"), 1);
  // Alongside the sign out block it has always had, at the top of the component.
  before(modal, 'blockSignout?.();', "usePaymentBusy(true, 'checkout');", 'next to the sign out block');
  assert.ok(modal.indexOf("usePaymentBusy(true, 'checkout');") < 1200, 'at the top of the component, before any branch');
});

test('card machine screen: busy while it is up, taken before its watch starts', () => {
  const px = read('../surfaces/PaxTerminal.jsx');
  assert.ok(px.includes("import { usePaymentBusy } from '../lib/usePaymentBusy';"));
  before(px, "usePaymentBusy(true, 'card machine screen');", 'pollTerminalJob(initialJob.id,', 'hold, then watch');
});

test('split bill: busy while open, and each card leg holds before it starts the card', () => {
  const sp = read('../components/SplitModal.jsx');
  assert.ok(sp.includes("import { usePaymentBusy } from '../lib/usePaymentBusy';"));
  const leg = between(sp, 'function SplitCardTerminal(', 'function SplitCashTender(');
  before(leg, "usePaymentBusy(true, 'split card leg');", 'useEffect(', 'the leg holds before any of its effects');
  const split = between(sp, 'export default function SplitModal(', '// ─ Build portions from mode');
  assert.equal(count(split, "usePaymentBusy(true, 'split bill');"), 1);
});

test('bar tab card hold (open): busy before the reader starts', () => {
  const tp = read('../components/TabPreAuthTerminal.jsx');
  assert.ok(tp.includes("import { usePaymentBusy } from '../lib/usePaymentBusy';"));
  before(tp, "usePaymentBusy(true, 'bar tab card hold');", 'let cancelled = false;', 'hold, then the effect that starts the reader');
});

test('bar tab close and hold increase: busy for the capture sheet, and around the increase call', () => {
  const bar = read('../surfaces/BarSurface.jsx');
  assert.ok(bar.includes("import { holdPaymentBusy } from '../lib/paymentBusy';"));
  assert.ok(bar.includes("import { usePaymentBusy } from '../lib/usePaymentBusy';"));
  assert.ok(bar.includes("usePaymentBusy(!!holdClose, 'bar tab close');"), 'held while the close sheet is up');
  const inc = between(bar, 'const increaseHold = async (tab) => {', 'const captureHeldTab = async (tab) => {');
  before(inc, "const releaseBusy = holdPaymentBusy('bar tab hold increase');", 'try {', 'taken before the call');
  assert.ok(inc.includes('} finally { setHoldBusy(false); releaseBusy(); }'), 'released however the call ends');
});

test('Orders hub tab closes: every capture is busy from its start to its finally', () => {
  const oh = read('../surfaces/OrdersHub.jsx');
  assert.ok(oh.includes("import { holdPaymentBusy } from '../lib/paymentBusy';"));
  // The state setter is private: every caller goes through the wrapper that holds and releases.
  assert.ok(oh.includes('const [closingTabRef, setClosingTabRefState] = useState(null);'));
  assert.equal(count(oh, 'setClosingTabRefState('), 1, 'only the wrapper sets the state');
  assert.ok(oh.includes("if (!closingBusyRef.current) closingBusyRef.current = holdPaymentBusy('tab close');"));
  assert.ok(oh.includes('useEffect(() => () => { closingBusyRef.current?.(); closingBusyRef.current = null; }, []);'), 'released on unmount');
  for (const fn of [
    'const releaseAdyenHold = async (',
    'const closeShortQrTab = async (',
    'const forceCloseQrTab = async (',
    'const forceCloseTab = async (',
  ]) {
    const start = oh.indexOf(fn);
    assert.ok(start > 0, fn);
    const body = oh.slice(start, oh.indexOf('\n  };\n', start));
    const sets = body.match(/setClosingTabRef\((?!null)[^)]+\)/g) || [];
    assert.equal(sets.length, 1, `${fn} marks the capture once`);
    const afterSet = body.slice(body.indexOf(sets[0]));
    assert.ok(/\n\s+try \{/.test(afterSet.slice(0, 200)), `${fn}: the try follows the mark`);
    assert.ok(/finally \{\n\s+setClosingTabRef\(null\);/.test(afterSet), `${fn}: the finally clears it`);
  }
});

test('MPOS: the card flow holds before it starts the card; tip pass and card screens hold too', () => {
  const mc = read('../surfaces/mpos/MCardFlow.jsx');
  assert.ok(mc.includes("import { usePaymentBusy } from '../../lib/usePaymentBusy';"));
  before(mc, "usePaymentBusy(true, 'mpos card');", 'runFlow();', 'hold, then the effect that runs the card');
  const mp = read('../surfaces/MPOSSurface.jsx');
  assert.ok(mp.includes("import { usePaymentBusy } from '../lib/usePaymentBusy';"));
  before(mp, "usePaymentBusy(flow.screen === 'tender' || flow.screen === 'card', 'mpos pay');",
    "if (flow.screen === 'newOrder') {", 'called before any screen returns (rules of hooks)');
});

test('kiosk: the pay gate holds before ScreenPay can mount, and the order booking holds too', () => {
  const gate = read('../surfaces/kiosk/KioskPayLinkGate.jsx');
  assert.ok(gate.includes("import { usePaymentBusy } from '../../lib/usePaymentBusy';"));
  before(gate, "usePaymentBusy(true, 'kiosk pay');", 'confirmLinkBeforeCard()', 'held from the gate mounting');
  before(gate, "usePaymentBusy(true, 'kiosk pay');", "if (gate.phase === 'ok') return children;", 'before ScreenPay mounts');
  const kiosk = read('../surfaces/KioskApp.jsx');
  assert.ok(kiosk.includes("import { usePaymentBusy } from '../lib/usePaymentBusy';"));
  before(kiosk, "usePaymentBusy(submitting, 'kiosk order');", 'const submitOrder = useCallback(',
    'declared with the state, outside submitOrder (kioskCardPathGuard.test.js fingerprints it)');
  const pay = between(kiosk, 'function ScreenPay(', 'const cardDueAmount = total;');
  assert.ok(!pay.includes('PaymentBusy'), 'ScreenPay itself is untouched');
});

test('every card start behind the link gate also holds the busy flag (a new card surface must too)', () => {
  const SRC = here('../');
  const missing = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|jsx)$/.test(e.name) || /\.test\.js$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (!src.includes('confirmLinkBeforeCard()')) continue;
      const rel = path.relative(SRC, p);
      if (rel === path.join('lib', 'deviceLink.js')) continue;
      if (!/usePaymentBusy\(|holdPaymentBusy\(/.test(src)) missing.push(rel);
    }
  };
  walk(SRC);
  assert.deepEqual(missing, [], 'each file that starts a card also marks the device payment busy');
});
