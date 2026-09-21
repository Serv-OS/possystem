// src/lib/printPickup.test.js
//
// A kitchen ticket must not wait on the slow scan, and the order number must get its
// own time on screen.
//
// LIVE, 21 Sep 2026, Provo. Peter put two orders through the kiosk: "the first one went
// through didnt print, second one eventually printed but it was super slow to print", and
// "in both situations the notification didnt stay on the screen for very long".
//
// The print rows say it plainly. The second order's kitchen job was created at 18:53:31
// and not picked up until 18:53:43: twelve seconds. Nothing is wrong with the dispatcher,
// it is the DISCOVERY: the realtime INSERT is what normally picks a job up in about a
// tenth of a second, and the backstop scan behind it is twenty seconds and deliberately
// slow, because the print table is empty most of the day. Every moment the socket is
// down (a reload, a wifi blip, a deploy) an INSERT lands with nobody listening, and the
// ticket then waits for that slow scan.
//
// And the done screen: the idle clock runs from the customer's last TOUCH, which is
// before they pay. Taking the card and writing the order can take most of a minute, and
// every second of it came off the time the customer had to read the order number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ORCH = readFileSync(new URL('../sync/PrintOrchestrator.js', import.meta.url), 'utf8');
const KIOSK = readFileSync(new URL('../surfaces/KioskApp.jsx', import.meta.url), 'utf8');

test('the queue is swept the moment the socket comes back', () => {
  // SUBSCRIBED fires on the first connect AND every reconnect, which is exactly when an
  // INSERT may have been missed.
  assert.match(ORCH, /\.subscribe\(\(status\) => \{[\s\S]{0,400}if \(status === 'SUBSCRIBED'\) \{[\s\S]{0,200}tick\(\);/);
  assert.match(ORCH, /setTimeout\(\(\) => \{ if \(_running\) tick\(\); \}, RESUBSCRIBE_SWEEP_MS\);/,
    'and again a moment later, for a row still landing as the socket came up');
  assert.match(ORCH, /const RESUBSCRIBE_SWEEP_MS = 1_500;/);
});

test('while there is work, the next look is seconds away, not twenty', () => {
  assert.match(ORCH, /const BUSY_POLL_MS\s+= 2_000;/);
  assert.match(ORCH, /if \(data\.length\) armBusySweep\(\);/);
  const helper = ORCH.slice(ORCH.indexOf('function armBusySweep'), ORCH.indexOf('async function tick'));
  assert.match(helper, /if \(!_running \|\| _busyTimer\) return;/, 'never stacked');
  assert.match(helper, /_busyTimer = null;/, 'and it stops by itself when a sweep comes back empty');
});

test('the idle backstop is untouched, so an empty venue costs the same as before', () => {
  // The 20s/30s scan is deliberately slow (the comment in the file argues the cost);
  // this fix is bursts around real events, never a faster steady poll.
  assert.match(ORCH, /const MASTER_POLL_MS\s+= 20_000;/);
  assert.match(ORCH, /const CHILD_POLL_MS\s+= 30_000;/);
});

test('the fast timer is cleared when the orchestrator stops', () => {
  // A one-shot timer left armed across a stop is how a stopped dispatcher claims a job
  // it will never print (the v5.7.12 handoff trap).
  assert.match(ORCH, /clearTimeout\(_busyTimer\);/);
  assert.match(ORCH, /_pollTimer = _busyTimer = _reclaimTimer/);
});

test('the done screen starts its own clock, so a slow payment does not eat it', () => {
  assert.match(KIOSK, /useEffect\(\(\) => \{\s*\n\s*if \(screen === 'done'\) resetIdle\(\);\s*\n\s*\}, \[screen, resetIdle\]\);/);
  // and NOT by editing submitOrder, which the card path guard fingerprints: money code
  // does not get touched for a screen timing fix (owner rule).
  const submit = KIOSK.slice(KIOSK.indexOf('const submitOrder = useCallback'), KIOSK.indexOf("'[kiosk] submit failed'"));
  assert.doesNotMatch(submit, /resetIdle\(\)/, 'submitOrder is byte for byte what the guard expects');
});
