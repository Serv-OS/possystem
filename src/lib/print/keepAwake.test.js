// keepAwake.test.js — the printer must not be asleep when an order lands.
//
// Peter, 22 Sep 2026, through one evening: "its just gone offline again!",
// "clicking print wakes it back up and reconects it", "nothing has changed on
// the printer its been sat there the entire time", "this is very stressful".
//
// His own evidence is what pins the diagnosis: ping ANSWERED while port 9100
// refused, then later ping failed too, and pressing print always brought it
// back. That is a print server going to sleep and waking on traffic.
//
// So we knock. The rules below are what make knocking safe: it must print
// nothing, it must never open a socket while a real ticket is going out, and it
// must go quiet on its own whenever real printing is happening.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  STATUS_QUERY_BYTES, KEEP_AWAKE_MS, statusQueryBase64, shouldKnock, jitterFor, startKeepAwake,
} from './keepAwake.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('what we send is the ESC/POS status query, which prints nothing', () => {
  // DLE EOT n. Not ESC @ (that would reset the printer's settings), and not an
  // empty connection (that is what leaves a socket half open on some units).
  assert.deepEqual([...STATUS_QUERY_BYTES], [0x10, 0x04, 0x01]);
  assert.equal(statusQueryBase64(), Buffer.from([0x10, 0x04, 0x01]).toString('base64'));
  // nothing in here can put ink on paper: no line feed, no cut, no text
  assert.equal(STATUS_QUERY_BYTES.includes(0x0a), false, 'no line feed');
  assert.equal(STATUS_QUERY_BYTES.includes(0x1d), false, 'no GS (cut)');
});

test('we knock only when the printer has been left alone', () => {
  const now = 1_000_000;
  assert.equal(shouldKnock({ lastContactAt: null, now }), true, 'never spoken to: knock');
  assert.equal(shouldKnock({ lastContactAt: now - 10_000, now }), false, 'just printed: leave it');
  assert.equal(shouldKnock({ lastContactAt: now - KEEP_AWAKE_MS - 1, now }), true);
  assert.equal(shouldKnock({ lastContactAt: null, now, enabled: false }), false, 'switched off means off');
});

test('two tills in one venue do not knock at the same moment', () => {
  const a = jitterFor('till-A');
  const b = jitterFor('till-B');
  assert.notEqual(a, b);
  for (const id of ['till-A', 'till-B', '', null]) {
    const j = jitterFor(id);
    assert.ok(j >= 0 && j < 20_000, 'inside the jitter window');
  }
  assert.equal(jitterFor('till-A'), a, 'stable for one device, so it does not wander');
});

// ── the loop ────────────────────────────────────────────────────────────────

function harness(over = {}) {
  const sent = [];
  let timerFn = null;
  const api = startKeepAwake({
    deviceId: 'till-A',
    printers: () => [{ id: 'p1', ip: '10.0.0.104', port: 9100 }],
    lastContact: () => null,
    send: async (p, b64) => { sent.push({ ip: p.ip, b64 }); },
    setTimer: (fn) => { timerFn = fn; return 1; },
    clearTimer: () => { timerFn = null; },
    ...over,
  });
  return { api, sent, run: () => timerFn && timerFn(), get live() { return !!timerFn; } };
}

test('a round knocks on each printer with the status query', async () => {
  const h = harness();
  await h.api.knockNow();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].ip, '10.0.0.104');
  assert.equal(h.sent[0].b64, statusQueryBase64());
});

test('a printer that printed a moment ago is left alone', async () => {
  const h = harness({ lastContact: () => Date.now() - 5_000 });
  await h.api.knockNow();
  assert.deepEqual(h.sent, [], 'a real ticket already woke it');
});

test('a knock that fails never throws at the caller', async () => {
  const seen = [];
  const h = harness({
    send: async () => { throw new Error('connect timeout'); },
    onContact: (p, ok, err) => seen.push([p.ip, ok, err.message]),
  });
  await h.api.knockNow();   // must not reject
  assert.deepEqual(seen, [['10.0.0.104', false, 'connect timeout']]);
});

test('a printer with no address is skipped, not dialled', async () => {
  const h = harness({ printers: () => [{ id: 'bt1', name: 'Bluetooth' }, { id: 'p1', ip: '10.0.0.104' }] });
  await h.api.knockNow();
  assert.equal(h.sent.length, 1);
});

test('switching it off stops the knocking without stopping printing', async () => {
  const h = harness({ enabled: () => false });
  await h.api.knockNow();
  assert.deepEqual(h.sent, []);
});

test('stop really stops', async () => {
  const h = harness();
  assert.equal(h.live, true);
  h.api.stop();
  assert.equal(h.live, false);
  await h.api.knockNow();
  assert.deepEqual(h.sent, [], 'no knocking after stop');
});

test('a broken printer list is survived, never thrown', async () => {
  const h = harness({ printers: () => { throw new Error('storage gone'); } });
  await h.api.knockNow();
  assert.deepEqual(h.sent, []);
});

// ── it must go through the lane ─────────────────────────────────────────────

test('the orchestrator sends every knock through the printer lane', () => {
  // This is what makes a scheduled knock safe: it queues behind a real ticket
  // instead of opening a second socket to a one-connection-at-a-time printer.
  const src = read('../../sync/PrintOrchestrator.js');
  assert.match(src, /send: \(p\) => _lanes\.run\(/, 'the knock is queued in the lane');
  assert.match(src, /STATUS_QUERY_BYTES/);
  assert.match(src, /_keepAwake\?\.stop\(\)/, 'and it is stopped with the orchestrator');
  // a real print records contact, so the knock stays quiet while the venue is busy
  assert.match(src, /_lastContact\.set\(laneKeyOf\(job\), Date\.now\(\)\)/);
});

test('printService can list the printers to keep awake', () => {
  const src = read('../printer.js');
  assert.match(src, /knownPrinters\(\)/);
  assert.match(src, /if \(!ip\) continue;/, 'a printer with no address is not dialled');
});
