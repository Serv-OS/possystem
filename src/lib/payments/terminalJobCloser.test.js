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
  watchCheckout, adoptBookedSale, adoptedSaleBanner,
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
  // 30 Sep 2026: watched by job id (the card screen) OR by check id (the checkout, before any job exists).
  assert.match(tick, /const watchedHere = isWatchedHere\(job\.id, job\.closed_check_id\);/);
  assert.match(tick, /closeWaitMs\(job, \{ \.\.\.me, watchedHere \}\)/);
  // and what it booked comes back, for the adoption below
  assert.match(tick, /const booked = await useStore\.getState\(\)\.closeApprovedTerminalJob\(job\);/);
  assert.match(tick, /adoptBookedSale\(\{ job, booked, myDeviceId: me\.myDeviceId, watchedHere, walkInRef, fmt: moneyMinor \}\)/);
  assert.match(tick, /if \(adopt\.clearWalkIn\) st\.clearWalkIn\?\.\(\);/);
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

// ── 30 Sep 2026: the checkout's own watch, before any job exists ────────────
// Huddersfield 30 Sep: the checkout waited for the whole tender before it mounted PaxTerminal, so
// nothing was watching; the sending till's reconciler booked R5737 0.1 s after approval, and the
// same order was rung again (R5739). The checkout now marks its CHECK watched when Card is pressed.

test('watchCheckout holds the sending till\'s wait at 30 s for a job whose closed_check_id matches, before any card screen mounts', () => {
  const j = job({ id: 'job-c1', closed_check_id: 'chk-1790768566981' });
  assert.equal(isWatchedHere(j.id, j.closed_check_id), false);
  assert.equal(closeWaitMs(j, { role: 'till', myDeviceId: POS1, watchedHere: isWatchedHere(j.id, j.closed_check_id) }), 0, 'unwatched: books at once');
  const off = watchCheckout('chk-1790768566981');
  assert.equal(isWatchedHere(j.id, j.closed_check_id), true, 'watched by check id, no PaxTerminal mark needed');
  assert.equal(isWatchedHere('some-other-job', j.closed_check_id), true, 'any job of that check');
  assert.equal(isWatchedHere(j.id), false, 'the job id alone is not marked');
  const wait = closeWaitMs(j, { role: 'till', myDeviceId: POS1, watchedHere: isWatchedHere(j.id, j.closed_check_id) });
  assert.ok(wait >= WATCHED_LIMIT_MS, `sender waits at least ${WATCHED_LIMIT_MS}: ${wait}`);
  assert.equal(wait, 30_000);
  off();
  assert.equal(isWatchedHere(j.id, j.closed_check_id), false, 'released on unmount');
  assert.equal(closeWaitMs(j, { role: 'till', myDeviceId: POS1, watchedHere: isWatchedHere(j.id, j.closed_check_id) }), 0, 'after release the sender waits 0');
});

test('watchCheckout is counted, unwatching twice is harmless, and no id is a no-op', () => {
  const a = watchCheckout('chk-x');
  const b = watchCheckout('chk-x');
  a(); a();
  assert.equal(isWatchedHere(null, 'chk-x'), true, 'the second mark still holds it');
  b();
  assert.equal(isWatchedHere(null, 'chk-x'), false);
  watchCheckout(null)();
  watchCheckout('')();
  assert.equal(isWatchedHere(null, null), false);
});

test('the check watch and the job watch are independent marks', () => {
  const offJob = watchTerminalJob('job-i');
  assert.equal(isWatchedHere('job-i', 'chk-i'), true);
  assert.equal(isWatchedHere('job-other', 'chk-i'), false);
  offJob();
  const offChk = watchCheckout('chk-i');
  assert.equal(isWatchedHere('job-i', 'chk-i'), true);
  assert.equal(isWatchedHere('job-i'), false);
  offChk();
});

// ── 30 Sep 2026: adopting a sale booked after the checkout closed ───────────
const fmt = (minor, cur) => `${cur === 'USD' ? '$' : '£'}${(minor / 100).toFixed(2)}`;
const hudJob = (over = {}) => job({
  id: '97c6176c', closed_check_id: 'chk-1790768566981', charge_minor: 1165, currency: 'GBP',
  pos_device_id: 'ff1b5fb8', check_draft: { source: 'pos_send_to_terminal', orderRef: 'R5737', tableId: null },
  ...over,
});
const booked = (over = {}) => ({ booked: true, created: true, ref: 'R5737', closedCheckId: 'chk-1790768566981', ...over });

test('banner wording (Peter\'s words, no dashes)', () => {
  const t = adoptedSaleBanner({ ref: 'R5737', amount: '£11.65' });
  assert.equal(t, 'Card approved after the checkout closed: R5737 £11.65 is booked. Do not take payment again.');
  assert.ok(!/[\u2013\u2014]/.test(t));
});

test('the sending till books its own unwatched job: the matching cart is cleared and the banner shown', () => {
  const r = adoptBookedSale({ job: hudJob(), booked: booked(), myDeviceId: 'ff1b5fb8', watchedHere: false, walkInRef: 'R5737', fmt });
  assert.equal(r.clearWalkIn, true);
  assert.equal(r.banner, 'Card approved after the checkout closed: R5737 £11.65 is booked. Do not take payment again.');
});

test('a cart that does not match is NEVER cleared, but the banner still warns', () => {
  for (const walkInRef of ['R5738', null, undefined, '']) {
    const r = adoptBookedSale({ job: hudJob(), booked: booked(), myDeviceId: 'ff1b5fb8', walkInRef, fmt });
    assert.equal(r.clearWalkIn, false, String(walkInRef));
    assert.ok(r.banner, 'the money is booked whatever is on screen: say so');
  }
  // a table check never clears the counter cart, even on a ref match
  const t = adoptBookedSale({ job: hudJob({ check_draft: { source: 'pos_send_to_terminal', orderRef: 'R5737', tableId: 'T3' } }), booked: booked(), myDeviceId: 'ff1b5fb8', walkInRef: 'R5737', fmt });
  assert.equal(t.clearWalkIn, false);
});

test('nothing is adopted when the checkout was watching, on another till, for Pay at table, or when nothing was booked', () => {
  const base = { job: hudJob(), booked: booked(), myDeviceId: 'ff1b5fb8', walkInRef: 'R5737', fmt };
  assert.deepEqual(adoptBookedSale({ ...base, watchedHere: true }), { clearWalkIn: false, banner: null }, 'the checkout finishes it');
  assert.deepEqual(adoptBookedSale({ ...base, myDeviceId: KDS_FOOD }), { clearWalkIn: false, banner: null }, 'a kitchen screen or another till');
  assert.deepEqual(adoptBookedSale({ ...base, myDeviceId: null }), { clearWalkIn: false, banner: null });
  assert.deepEqual(adoptBookedSale({ ...base, job: hudJob({ pos_device_id: null }) }), { clearWalkIn: false, banner: null });
  assert.deepEqual(adoptBookedSale({ ...base, job: hudJob({ check_draft: { source: 'pax_table_pay', orderRef: 'R5737' } }) }), { clearWalkIn: false, banner: null });
  assert.deepEqual(adoptBookedSale({ ...base, booked: null }), { clearWalkIn: false, banner: null });
  assert.deepEqual(adoptBookedSale({ ...base, booked: { booked: false } }), { clearWalkIn: false, banner: null });
  assert.deepEqual(adoptBookedSale({ ...base, booked: { booked: false, alreadyLocal: true } }), { clearWalkIn: false, banner: null }, 'this till already had the sale');
  assert.deepEqual(adoptBookedSale({}), { clearWalkIn: false, banner: null });
});

test('the banner names the booked ref, and falls back to the draft ref, and the job\'s currency', () => {
  const r = adoptBookedSale({ job: hudJob({ currency: 'USD', charge_minor: 650 }), booked: booked({ ref: null }), myDeviceId: 'ff1b5fb8', walkInRef: null, fmt });
  assert.equal(r.banner, 'Card approved after the checkout closed: R5737 $6.50 is booked. Do not take payment again.');
  const noFmt = adoptBookedSale({ job: hudJob(), booked: booked(), myDeviceId: 'ff1b5fb8', walkInRef: null });
  assert.equal(noFmt.banner, 'Card approved after the checkout closed: R5737 11.65 is booked. Do not take payment again.');
});

test('wiring: the checkout watches its check before the link gate, the gift commit and the create, and releases on unmount', () => {
  const src = read('../../surfaces/CheckoutModal.jsx');
  assert.match(src, /import \{ checkoutOrderRef, watchCheckout \} from '\.\.\/lib\/payments\/terminalJobCloser';/);
  const job = src.slice(src.indexOf('const startTerminalJob = async () => {'), src.indexOf('const handleCardPress = () => {'));
  const watch = job.indexOf('watchThisCheck();');
  assert.ok(watch > 0, 'the watch is taken inside startTerminalJob');
  const helper = src.slice(src.indexOf('const watchThisCheck = () => {'), src.indexOf('const startTerminalJob = async () => {'));
  assert.match(helper, /const watchId = getCheckId\(\);/);
  assert.match(helper, /checkWatchRef\.current = \{ id: watchId, off: watchCheckout\(watchId\) \};/);
  assert.ok(watch < job.indexOf('confirmLinkBeforeCard()'), 'before the link gate');
  assert.ok(watch < job.indexOf('commitGift('), 'before the gift commit');
  assert.ok(watch < job.indexOf('dispatchTerminalJob({'), 'before the create');
  assert.match(src, /useEffect\(\(\) => \(\) => \{ checkWatchRef\.current\?\.off\?\.\(\); checkWatchRef\.current = null; \}, \[\]\);/);
});

test('wiring: the store hands back what it booked, and the walk in takes the frozen ref at the first send', () => {
  const store = read('../../store/index.js');
  const close = store.slice(store.indexOf('closeApprovedTerminalJob: async (job) => {'), store.indexOf('_reverseTerminalJobGift: async ('));
  assert.match(close, /return \{ booked: true, created: !!created, ref: record\.ref \|\| null, closedCheckId: record\.id, source: record\.source \|\| null \};/);
  assert.match(close, /return \{ booked: false, alreadyLocal: true \};/);
  assert.match(store, /freezeWalkInRef: \(ref\) => \{/);
  const co = read('../../surfaces/CheckoutModal.jsx');
  assert.match(co, /if \(!tableId && !isBarTab\) useStore\.getState\(\)\.freezeWalkInRef\?\.\(orderRef\);/);
  assert.match(read('../../App.jsx'), /<CardAdoptedBanner \/>/);
});
