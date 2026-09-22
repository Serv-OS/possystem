// printerLane.test.js — two tickets must never dial the same printer at once.
//
// Peter, 22 Sep 2026, twice in one day: "the printer has disconnected and is not
// printing", "its just gone off again", "this was not happening until the last
// couple of days".
//
// It was never disconnected. The live row says:
//   failed to connect to /10.0.0.104 (port 9100) from /10.0.0.125 (port 45284)
//   after 5000ms: isConnected
// A thermal printer on 9100 takes ONE connection. The dispatcher fired every job
// in a batch at once, so a kiosk order (kitchen + receipt + drawer) opened three
// sockets to one machine. One printed; the others burned attempts until the
// receipt was failed_permanent, with the printer healthy the whole time.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createLanes, laneKeyOf, looksLikeCollision } from './printerLane.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 5));

// ── which printer a job belongs to ──────────────────────────────────────────

test('a job is queued by its printer, however it is identified', () => {
  assert.equal(laneKeyOf({ printer_id: 'p1' }), 'printer:p1');
  assert.equal(laneKeyOf({ printer_ip: '10.0.0.104', printer_port: 9100 }), 'net:10.0.0.104:9100');
  assert.equal(laneKeyOf({ printer_ip: '10.0.0.104' }), 'net:10.0.0.104:9100', 'port 9100 is the default');
  // No printer named: still serialised, per venue, because it resolves to the
  // venue's default printer — which is the same machine.
  assert.equal(laneKeyOf({ location_id: 'L1' }), 'venue:L1');
});

test('the same printer by id and by ip are still one lane each', () => {
  assert.notEqual(laneKeyOf({ printer_id: 'p1' }), laneKeyOf({ printer_ip: '10.0.0.104' }));
});

// ── the rule ────────────────────────────────────────────────────────────────

test('two jobs for ONE printer never overlap', async () => {
  const lanes = createLanes();
  let live = 0, maxLive = 0;
  const job = async () => {
    live++; maxLive = Math.max(maxLive, live);
    await tick();
    live--;
  };
  await Promise.all([lanes.run('net:10.0.0.104:9100', job), lanes.run('net:10.0.0.104:9100', job), lanes.run('net:10.0.0.104:9100', job)]);
  assert.equal(maxLive, 1, 'one socket at a time, which is all the printer has');
});

test('jobs for DIFFERENT printers do overlap', async () => {
  // A bar printer must never wait behind the kitchen.
  const lanes = createLanes();
  let live = 0, maxLive = 0;
  const job = async () => { live++; maxLive = Math.max(maxLive, live); await tick(); live--; };
  await Promise.all([lanes.run('printer:kitchen', job), lanes.run('printer:bar', job)]);
  assert.equal(maxLive, 2);
});

test('they run in the order they arrived', async () => {
  const lanes = createLanes();
  const order = [];
  await Promise.all(['a', 'b', 'c'].map((n) => lanes.run('printer:k', async () => { await tick(); order.push(n); })));
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('one job failing never stops the next ticket', async () => {
  const seen = [];
  const lanes = createLanes({ onError: (e) => seen.push(e.message) });
  const results = [];
  await Promise.all([
    lanes.run('printer:k', async () => { throw new Error('out of paper'); }),
    lanes.run('printer:k', async () => { results.push('second ticket printed'); }),
  ]);
  assert.deepEqual(results, ['second ticket printed']);
  assert.deepEqual(seen, ['out of paper'], 'and the failure is reported, not swallowed');
});

test('a lane empties itself when the work is done', async () => {
  const lanes = createLanes();
  assert.equal(lanes.idle(), true);
  const p = lanes.run('printer:k', async () => { await tick(); });
  assert.equal(lanes.depthOf('printer:k'), 1);
  assert.deepEqual(lanes.busy(), [{ key: 'printer:k', n: 1 }]);
  await p;
  assert.equal(lanes.depthOf('printer:k'), 0);
  assert.equal(lanes.idle(), true, 'no leak: a busy venue would otherwise grow a map for ever');
});

test('a logger that throws never breaks printing', async () => {
  const lanes = createLanes({ onError: () => { throw new Error('the logger is broken'); } });
  const done = [];
  await Promise.all([
    lanes.run('printer:k', async () => { throw new Error('first fails'); }),
    lanes.run('printer:k', async () => { done.push('still printed'); }),
  ]);
  assert.deepEqual(done, ['still printed']);
});

// ── telling a collision from a dead printer ─────────────────────────────────

test('THE TAIL OF THE ERROR IS WHAT MATTERS: unreachable is not a collision', () => {
  // The full message Android writes, which the first version of this test (and
  // of the code) got wrong by matching only its opening words:
  const real = 'failed to connect to /10.0.0.104 (port 9100) from /10.0.0.125 (port 46886) after 5000ms: isConnected failed: EHOSTUNREACH (No route to host)';
  assert.equal(looksLikeCollision(real), false,
    'the printer is genuinely off the network — extra patience here only delays the alarm');
  assert.equal(looksLikeCollision('isConnected failed: EHOSTDOWN (Host is down)'), false);
  assert.equal(looksLikeCollision('ECONNREFUSED 10.0.0.104:9100'), false,
    'something answers at that address but nothing listens on the print port: not a busy socket');
});

test('a plain timeout with no reason IS treated as a busy socket', () => {
  // 15 Provo failures look like this: the connect ran out of time with no OS
  // reason attached, which is what a printer already talking to someone looks like.
  assert.equal(looksLikeCollision('failed to connect to /10.0.0.104 (port 9100) after 5000ms'), true);
  assert.equal(looksLikeCollision('connect ETIMEDOUT'), true);
  assert.equal(looksLikeCollision('connection reset by peer'), true, 'the printer dropped the line mid job');
});

test('a printer that needs a human is never given extra patience', () => {
  assert.equal(looksLikeCollision('cover open'), false);
  assert.equal(looksLikeCollision('out of paper'), false);
  assert.equal(looksLikeCollision('local network permission denied'), false);
  assert.equal(looksLikeCollision(''), false);
  assert.equal(looksLikeCollision(null), false);
});

// ── the dispatcher really uses it ───────────────────────────────────────────

test('the orchestrator dispatches through the lanes, not all at once', () => {
  const src = read('../../sync/PrintOrchestrator.js');
  assert.match(src, /_lanes\.run\(key, async \(\) =>/, 'jobs go through a lane');
  assert.doesNotMatch(src, /\n\s*claimAndDispatch\(job\.id\);\n/,
    'the bare fire-and-forget loop that opened three sockets at once is gone');
  assert.match(src, /looksLikeCollision\(errMsg\)/, 'a busy socket is told apart from a dead printer');
  assert.match(src, /COLLISION_EXTRA_ATTEMPTS/, 'and it does not burn the ticket\'s last attempt');
});
