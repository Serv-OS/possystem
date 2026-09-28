// terminalJobCloser.test.js: which device books a sale the card machine approved, and its ref.
// 28 Sep 2026: at Coffee Boy Leeds (1 till, 2 kitchen screens) 204 of 318 reader sales from 25 to
// 27 Sep were booked by TerminalJobReconciler, 161 of them under a ref from another device's lease,
// because every device booked at once and beat the till's own checkout screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  closerRole, isKitchenScreen, closeWaitMs, isDue, createSightings,
  watchTerminalJob, isWatchedHere, checkoutOrderRef, usableOrderRef,
  WATCHED_LIMIT_MS, OTHER_TILL_WAIT_MS, FALLBACK_WAIT_MS,
} from './terminalJobCloser.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const POS1 = '4b682001-4374-4b24-9541-0cf8e74e57f7';   // Leeds POS 1
const KDS_FOOD = '20f75d03-3a71-4498-9496-8bcc3574abf8';
const job = (over = {}) => ({ id: 'job-1', status: 'approved', charge_minor: 380, pos_device_id: POS1, ...over });

test('roles: tills, kitchen screens, Back Office and host stands', () => {
  for (const mode of ['pos', 'bar', 'tables', 'orders', 'mpos', '']) assert.equal(closerRole({ mode }), 'till', mode);
  assert.equal(closerRole({ mode: 'kds' }), 'kitchen');
  assert.equal(closerRole({ mode: 'pos', pairedType: 'kds' }), 'kitchen', 'a device paired as a KDS, whatever its URL');
  assert.equal(closerRole({ mode: 'pos', deviceConfig: { defaultSurface: 'kds', profileName: 'Kitchen' } }), 'kitchen');
  for (const profileName of ['Counter', 'Bar 2', 'Server tablet']) {
    assert.equal(closerRole({ mode: 'pos', deviceConfig: { defaultSurface: 'kds', profileName } }), 'till', profileName);
  }
  assert.equal(closerRole({ mode: 'backoffice' }), 'office');
  assert.equal(closerRole({ mode: 'office' }), 'office');
  assert.equal(closerRole({ mode: 'bookings' }), 'host');
  assert.equal(closerRole({ mode: 'waitlist' }), 'host');
  assert.equal(isKitchenScreen({}), false);
});

test('the till that sent the job books it at once, unless its checkout screen is watching it', () => {
  assert.equal(closeWaitMs(job(), { role: 'till', myDeviceId: POS1 }), 0);
  assert.equal(closeWaitMs(job(), { role: 'till', myDeviceId: POS1, watchedHere: true }), WATCHED_LIMIT_MS);
});

test('every other device waits: another till 30 s, a kitchen screen or Back Office 90 s, a host stand never', () => {
  assert.equal(closeWaitMs(job(), { role: 'till', myDeviceId: 'another-till' }), OTHER_TILL_WAIT_MS);
  assert.equal(closeWaitMs(job(), { role: 'till', myDeviceId: null }), OTHER_TILL_WAIT_MS, 'an unpaired till is not the sender');
  assert.equal(closeWaitMs(job(), { role: 'kitchen', myDeviceId: KDS_FOOD }), FALLBACK_WAIT_MS);
  assert.equal(closeWaitMs(job(), { role: 'office', myDeviceId: null }), FALLBACK_WAIT_MS);
  assert.equal(closeWaitMs(job(), { role: 'host', myDeviceId: null }), Infinity);
  assert.ok(OTHER_TILL_WAIT_MS < FALLBACK_WAIT_MS, 'a till is preferred over a kitchen screen');
});

test('a job no till sent (Pay at table on the reader) books at once on a till, after 90 s elsewhere', () => {
  const pat = job({ pos_device_id: null, check_draft: { source: 'adyen_pay_at_table' } });
  assert.equal(closeWaitMs(pat, { role: 'till', myDeviceId: POS1 }), 0);
  assert.equal(closeWaitMs(pat, { role: 'kitchen', myDeviceId: KDS_FOOD }), FALLBACK_WAIT_MS);
  assert.equal(closeWaitMs(pat, { role: 'till', myDeviceId: POS1, watchedHere: true }), WATCHED_LIMIT_MS,
    'a job watched on this screen waits for it even when the job names no sender');
});

test('isDue counts only this device\'s own clock', () => {
  assert.equal(isDue(0, undefined, undefined), true);
  assert.equal(isDue(30_000, 1_000, 30_999), false);
  assert.equal(isDue(30_000, 1_000, 31_000), true);
  assert.equal(isDue(Infinity, 0, 1e12), false);
  assert.equal(isDue(30_000, undefined, 1e12), false, 'no sighting, no close');
});

test('sightings keep the FIRST time a job was seen and forget jobs no longer approved', () => {
  const s = createSightings();
  assert.equal(s.see('a', 100), 100);
  assert.equal(s.see('a', 900), 100);
  s.see('b', 200);
  s.keepOnly(['b']);
  assert.equal(s.size(), 1);
  assert.equal(s.see('a', 5_000), 5_000, 'seen again after it left the list: its wait starts again');
});

test('the checkout screen\'s watch is counted, and unwatching twice is harmless', () => {
  const off1 = watchTerminalJob('j-w');
  const off2 = watchTerminalJob('j-w');
  assert.equal(isWatchedHere('j-w'), true);
  off1(); off1();
  assert.equal(isWatchedHere('j-w'), true, 'the second mount still holds it');
  off2();
  assert.equal(isWatchedHere('j-w'), false);
  assert.equal(isWatchedHere(null), false);
  watchTerminalJob(null)();   // no job id: a no-op, never a throw
});

// ── A seeded model of the Leeds fleet ───────────────────────────────────────────
// Each device ticks every 8 s (±1.5 s jitter) at its own phase and first sees the job on its
// first tick after approval. The till's checkout screen watches the job until it books, 1.4 s
// after approval (1 s poll + the 350 ms hand off, as PaxTerminal does).
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x ^ (x >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 2 ** 32);
}
function simulate({ tillAlive, seed, rules }) {
  const r = rng(seed);
  const devices = [
    { name: 'POS 1', role: 'till', id: POS1 },
    { name: 'KDS Food', role: 'kitchen', id: KDS_FOOD },
    { name: 'Drinks KDS', role: 'kitchen', id: '28dd9a6e-7760-4111-930f-3d1276bef271' },
  ].map(d => ({ ...d, next: r() * 8000, every: 8000 + (r() - 0.5) * 3000, sight: createSightings() }));
  const screenBooksAt = tillAlive ? 1400 : Infinity;
  const j = job();
  for (let t = 0; t < 10 * 60_000; t += 50) {
    if (t >= screenBooksAt) return { by: 'POS 1 checkout screen', at: screenBooksAt };
    for (const d of devices) {
      if (t < d.next) continue;
      d.next += d.every;
      if (d.name === 'POS 1' && !tillAlive) continue;
      const first = d.sight.see(j.id, t);
      const watched = d.name === 'POS 1' && t < screenBooksAt;
      const wait = rules === 'old' ? 0 : closeWaitMs(j, { role: d.role, myDeviceId: d.id, watchedHere: watched });
      if (isDue(wait, first, t)) return { by: d.name + ' reconciler', at: t };
    }
  }
  return { by: null };
}

test('model: with the old rule another device often beats the till\'s screen; with the new rule never', () => {
  let oldLost = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const old = simulate({ tillAlive: true, seed, rules: 'old' });
    if (old.by !== 'POS 1 checkout screen') oldLost++;
    const now = simulate({ tillAlive: true, seed, rules: 'new' });
    assert.equal(now.by, 'POS 1 checkout screen', `seed ${seed}`);
  }
  assert.ok(oldLost > 400 * 0.2, `the old rule lost the race often (${oldLost} of 400)`);
});

test('model: the till is off (a reload, a crash): a kitchen screen still books it, never stranded', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const out = simulate({ tillAlive: false, seed, rules: 'new' });
    assert.match(String(out.by), /^(KDS Food|Drinks KDS) reconciler$/, `seed ${seed}`);
    assert.ok(out.at >= FALLBACK_WAIT_MS && out.at < FALLBACK_WAIT_MS + 20_000, `seed ${seed}: booked at ${out.at} ms`);
  }
});

// ── The ref ─────────────────────────────────────────────────────────────────────

test('the checkout freezes one ref: a walk in keeps the ticket\'s ref, a table mints, a bar tab is TAB-', () => {
  let minted = 0;
  const mint = () => { minted++; return 'R6577'; };
  assert.equal(checkoutOrderRef({ walkInRef: 'R6553', mint }), 'R6553');
  assert.equal(minted, 0, 'a walk in already sent to the kitchen mints nothing');
  assert.equal(checkoutOrderRef({ walkInRef: null, mint }), 'R6577');
  assert.equal(checkoutOrderRef({ isBarTab: true, walkInRef: 'R1', mint }), 'TAB-6577', 'a bar tab never takes a walk in ref');
  assert.equal(checkoutOrderRef({ walkInRef: '   ', mint }), 'R6577');
});

test('usableOrderRef takes a real ref and refuses anything else', () => {
  for (const ok of ['R6577', 'TAB-6577', '#6720']) assert.equal(usableOrderRef(ok), ok);
  for (const bad of [null, undefined, '', '  ', 42, {}, 'x'.repeat(41)]) assert.equal(usableOrderRef(bad), null, String(bad));
});

// ── Wiring (source pins) ────────────────────────────────────────────────────────

test('wiring: the reconciler waits its turn before booking, and never runs on a host stand', () => {
  const src = read('../../sync/TerminalJobReconciler.js');
  assert.match(src, /if \(closerRole\(\{ mode: getDeviceMode\(\) \}\) === 'host'\) return;/);
  const tick = src.slice(src.indexOf('const tick = async () => {'), src.indexOf('await tick();'));
  const wait = tick.indexOf('if (!isDue(wait, firstSeen, now)) continue;');
  const close = tick.indexOf('closeApprovedTerminalJob(job)');
  assert.ok(wait > 0 && close > wait, 'the wait comes before the close');
  assert.match(tick, /closeWaitMs\(job, \{ \.\.\.me, watchedHere: isWatchedHere\(job\.id\) \}\)/);
  assert.match(tick, /_sightings\.keepOnly\(jobs\.map\(j => j\.id\)\);/);
});

test('wiring: the till\'s card machine screen marks the job it watches', () => {
  const src = read('../../surfaces/PaxTerminal.jsx');
  assert.match(src, /useEffect\(\(\) => watchTerminalJob\(initialJob\?\.id\), \[initialJob\?\.id\]\);/);
});

test('wiring: the checkout freezes the ref into the job and hands it to its own close', () => {
  const src = read('../../surfaces/CheckoutModal.jsx');
  const job = src.slice(src.indexOf('const startTerminalJob = async () => {'), src.indexOf('const handleCardPress = () => {'));
  assert.ok(job.indexOf('const orderRef = getOrderRef();') > job.indexOf('await confirmLinkBeforeCard();'),
    'minted after the link check, which stays the first thing a card start does');
  assert.ok(job.indexOf('orderRef,') > 0 && job.indexOf('orderRef,') < job.indexOf("source: 'pos_send_to_terminal',"),
    'in the check draft');
  assert.match(src, /\.\.\.\(orderRefRef\.current \? \{ orderRef: orderRefRef\.current \} : \{\}\),/);
});

test('wiring: every writer books the frozen ref (table, walk in, bar tab, and the reconciler)', () => {
  const store = read('../../store/index.js');
  assert.match(store, /const ref = usableOrderRef\(paymentInfo\.orderRef\) \|\| getNextOrderRefLocal\(\);/, 'buildCloseRecord');
  const recon = store.slice(store.indexOf('closeApprovedTerminalJob: async (job) => {'), store.indexOf('_reverseTerminalJobGift: async'));
  assert.match(recon, /const frozenRef = usableOrderRef\(d\.orderRef\);/);
  assert.match(recon, /\.\.\.\(frozenRef \? \{ orderRef: frozenRef \} : \{\}\),/, 'rich path, through buildCloseRecord');
  assert.match(recon, /ref: frozenRef \|\| getNextOrderRefLocal\(\),/, 'headless path');
  const walk = store.slice(store.indexOf('recordWalkInClosed: (walkInOrder'), store.indexOf('recordWalkInClosed: (walkInOrder') + 12000);
  const stamp = walk.indexOf('set({ walkInOrder: { ...walkInOrder, ref: frozenRef } });');
  assert.ok(stamp > 0 && stamp < walk.indexOf("get().sendToKitchen({ fireAll: true, tableId: null });"),
    'the walk in takes the ref BEFORE the kitchen send, so the ticket shows it');
  assert.match(walk, /ref: existingRef \|\| frozenRef \|\| getNextOrderRefLocal\(\),/);
  const bar = read('../../surfaces/BarSurface.jsx');
  assert.match(bar, /ref: usableOrderRef\(payInfo\?\.orderRef\) \|\| \('TAB-' \+ getNextOrderRefLocal\(\)\.slice\(1\)\),/);
});
