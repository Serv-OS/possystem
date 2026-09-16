// Open orders and bar tabs stay the same on every till (lib/queueReconcile.js): a row the
// server removed is dropped, a row never sent is kept and published, the server's copy wins
// when it changed, and nothing is dropped on a capped read.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileList, isPending, syncStamp, changedKeys, canonicalJson, digest, keepBufferedWrite, stampedKeys } from './queueReconcile.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const keyOf = (o) => o.ref;
const hashOf = (o) => JSON.stringify({ ref: o.ref, status: o.status, total: o.total });
const isDone = (o) => o.status === 'collected';
const isTraining = (o) => o.training === true;
const synced = (o, at = 1000) => ({ ...o, _sync: syncStamp(hashOf(o), at) });

test('pending: no stamp, or a change since the stamp', () => {
  const a = { ref: 'R1', status: 'prep', total: 5 };
  assert.equal(isPending(a, hashOf), true, 'never confirmed');
  assert.equal(isPending(synced(a), hashOf), false, 'confirmed and unchanged');
  assert.equal(isPending({ ...synced(a), status: 'ready' }, hashOf), true, 'changed since confirmed');
  assert.equal(isPending(null, hashOf), false);
});

test('a synced order the server no longer has is dropped (the zombie case)', () => {
  const local = [synced({ ref: 'OLD', status: 'prep', total: 9 }), synced({ ref: 'R2', status: 'prep', total: 3 })];
  const remote = [synced({ ref: 'R2', status: 'prep', total: 3 })];
  const r = reconcileList({ local, remote, keyOf, hashOf, isDone, isTraining });
  assert.deepEqual(r.dropped, ['OLD']);
  assert.deepEqual(r.next.map(o => o.ref), ['R2']);
  assert.equal(r.changed, true);
  assert.deepEqual(r.publish, []);
});

test('an order never confirmed by the server is kept and published, never dropped', () => {
  const offline = { ref: 'NEW', status: 'received', total: 12 };
  const r = reconcileList({ local: [offline], remote: [], keyOf, hashOf, isDone, isTraining });
  assert.deepEqual(r.next, [offline]);
  assert.deepEqual(r.publish, ['NEW']);
  assert.deepEqual(r.dropped, []);
});

test('a confirmed order edited here but removed by the server is dropped, not re-published', () => {
  // Till A bumped it to ready while offline; till B collected it meanwhile. The edit is moot.
  const edited = { ...synced({ ref: 'E', status: 'prep', total: 1 }), status: 'ready' };
  const r = reconcileList({ local: [edited], remote: [], keyOf, hashOf, isDone, isTraining });
  assert.deepEqual(r.publish, []);
  assert.deepEqual(r.dropped, ['E']);
  assert.deepEqual(r.next, []);
  // Unless the read was capped: then it is simply kept (not published either)
  const r2 = reconcileList({ local: [edited], remote: [], keyOf, hashOf, isDone, isTraining, capped: true });
  assert.deepEqual(r2.dropped, []);
  assert.deepEqual(r2.publish, []);
  assert.equal(r2.next[0], edited);
});

test('an old unstamped copy (no buffered write) is dropped when the server lacks it, replaced when it has it', () => {
  const stale = { ref: 'OLD1', status: 'prep', total: 3 };
  const offline = { ref: 'OFF1', status: 'received', total: 4 };
  const buffered = new Set(['OFF1']);
  const isStale = (o) => !buffered.has(o.ref);
  const r = reconcileList({ local: [stale, offline], remote: [], keyOf, hashOf, isDone, isTraining, unconfirmedIsStale: isStale });
  assert.deepEqual(r.dropped, ['OLD1']);
  assert.deepEqual(r.publish, ['OFF1']);
  assert.deepEqual(r.next, [offline]);
  // The server still has the old copy, but newer: the server's copy wins, ours is not sent over it
  const serverNewer = synced({ ref: 'OLD1', status: 'ready', total: 3 }, 9000);
  const r2 = reconcileList({ local: [stale], remote: [serverNewer], keyOf, hashOf, isDone, isTraining, unconfirmedIsStale: isStale });
  assert.equal(r2.next[0].status, 'ready');
  assert.deepEqual(r2.updated, ['OLD1']);
  assert.deepEqual(r2.publish, []);
  // A young or buffered unstamped row on both sides still keeps ours (the flush sends it)
  const mineEdit = { ref: 'OFF1', status: 'ready', total: 4 };
  const r3 = reconcileList({ local: [mineEdit], remote: [synced({ ref: 'OFF1', status: 'received', total: 4 }, 9000)], keyOf, hashOf, isDone, isTraining, unconfirmedIsStale: isStale });
  assert.equal(r3.next[0].status, 'ready');
  assert.deepEqual(r3.updated, []);
});

test('a bar tab with unsent changes that the server no longer lists is kept and flagged, an order is dropped', () => {
  const tab = { ...synced({ ref: 'T1', status: 'open', total: 10 }), total: 14 };   // a round added offline
  const r = reconcileList({ local: [tab], remote: [], keyOf, hashOf, isDone, isTraining, keepIfPending: () => true });
  assert.deepEqual(r.orphaned, ['T1']);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.next[0]._orphan, true);
  assert.equal(r.next[0].total, 14);
  assert.deepEqual(r.publish, []);
  // Already flagged: untouched, not "changed" again
  const r2 = reconcileList({ local: r.next, remote: [], keyOf, hashOf, isDone, isTraining, keepIfPending: () => true });
  assert.equal(r2.changed, false);
  assert.equal(r2.next[0], r.next[0]);
  // The default (orders): dropped
  const r3 = reconcileList({ local: [tab], remote: [], keyOf, hashOf, isDone, isTraining });
  assert.deepEqual(r3.dropped, ['T1']);
  // An unchanged stamped row is dropped even for tabs (nothing unsent to lose)
  const r4 = reconcileList({ local: [synced({ ref: 'T2', status: 'open', total: 1 })], remote: [], keyOf, hashOf, isDone, isTraining, keepIfPending: () => true });
  assert.deepEqual(r4.dropped, ['T2']);
});

test('when the buffered writes could not be read, a saved unstamped row is held: neither published nor dropped', () => {
  const saved = { ref: 'S1', status: 'prep', total: 3 };
  const r = reconcileList({ local: [saved], remote: [], keyOf, hashOf, isDone, isTraining, hold: () => true, unconfirmedIsStale: () => true });
  assert.deepEqual(r.publish, []);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.next, [saved]);
  assert.equal(r.changed, false);
});

test('an orphan flag is cleared once the server lists the row again', () => {
  const orphan = { ...synced({ ref: 'T1', status: 'open', total: 10 }), total: 14, _orphan: true };
  const server = synced({ ref: 'T1', status: 'open', total: 10 }, 1000);
  const r = reconcileList({ local: [orphan], remote: [server], keyOf, hashOf, isDone, isTraining, keepIfPending: () => true });
  assert.equal(r.next[0]._orphan, undefined);
  assert.equal(r.next[0].total, 14, 'still ours (pending)');
  assert.equal(r.changed, true);
});

test('a row confirmed after the read began is never dropped by that read (canDrop)', () => {
  const before = synced({ ref: 'B', status: 'prep', total: 1 });   // stamped before the read
  const during = synced({ ref: 'D', status: 'prep', total: 2 });   // stamped while the read was in flight
  const droppable = stampedKeys([before], keyOf);
  const r = reconcileList({ local: [before, during], remote: [], keyOf, hashOf, isDone, isTraining, canDrop: o => droppable.has(o.ref) });
  assert.deepEqual(r.dropped, ['B']);
  assert.deepEqual(r.next.map(o => o.ref), ['D']);
  assert.deepEqual(r.publish, []);
  assert.deepEqual([...stampedKeys([before, { ref: 'U', status: 'prep' }], keyOf)], ['B']);
});

test('a pending row the server already holds exactly takes the server stamp (lost confirmation heals)', () => {
  const mine = { ref: 'H', status: 'prep', total: 2 };                  // sent, confirmation lost
  const server = synced({ ref: 'H', status: 'prep', total: 2 }, 7000);  // same content
  const r = reconcileList({ local: [mine], remote: [server], keyOf, hashOf, isDone, isTraining });
  assert.deepEqual(r.healed, ['H']);
  assert.equal(r.next[0]._sync.at, 7000);
  assert.equal(r.next[0]._sync.hash, hashOf(mine));
  assert.equal(isPending(r.next[0], hashOf), false);
  // Different content stays ours (the flush sends it)
  const serverOther = synced({ ref: 'H', status: 'ready', total: 2 }, 7000);
  const r2 = reconcileList({ local: [mine], remote: [serverOther], keyOf, hashOf, isDone, isTraining });
  assert.deepEqual(r2.healed, []);
  assert.equal(r2.next[0], mine);
});

test('canonicalJson: key order never changes a hash, arrays keep theirs, undefined is dropped', () => {
  const a = { items: [{ qty: 1, id: 'x', name: 'y' }], customer: { phone: '1', name: 'A' }, total: 12.5, staff: undefined };
  const b = { total: 12.5, customer: { name: 'A', phone: '1' }, items: [{ name: 'y', id: 'x', qty: 1 }] };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson([2, 1]), '[2,1]');
  assert.equal(canonicalJson({ d: new Date(0) }), '{"d":"1970-01-01T00:00:00.000Z"}');
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
});

test('digest: short, stable, and different for different rows', () => {
  const d = digest(canonicalJson({ ref: 'R1', total: 3 }));
  assert.match(d, /^[0-9a-f]{16}$/);
  assert.equal(d, digest(canonicalJson({ total: 3, ref: 'R1' })));
  assert.notEqual(d, digest(canonicalJson({ ref: 'R1', total: 3.01 })));
  assert.notEqual(digest('a'), digest('b'));
  assert.equal(digest(''), digest(undefined));
});

test('keepBufferedWrite: only a delete or drop recorded AFTER the write was buffered stops it', () => {
  const finishedAt = new Map([['queue:GONE', 5000], ['tab:T9', 5000]]);
  const isFinished = (kind, key, ts) => { const at = finishedAt.get(`${kind}:${key}`); return at !== undefined && at > ts; };
  assert.equal(keepBufferedWrite({ type: 'upsert', table: 'order_queue', payload: { ref: 'GONE' }, ts: 4000 }, isFinished), false, 'buffered before the row was finished');
  assert.equal(keepBufferedWrite({ type: 'upsert', table: 'order_queue', payload: { ref: 'GONE' }, ts: 6000 }, isFinished), true, 'buffered after it came back');
  assert.equal(keepBufferedWrite({ type: 'upsert', table: 'order_queue', payload: { ref: 'NEW', status: 'received' }, ts: 1 }, isFinished), true, 'absent from the store is not a reason');
  assert.equal(keepBufferedWrite({ type: 'upsert', table: 'bar_tabs', payload: { id: 'T1', status: 'closed' }, ts: 1 }, isFinished), true, 'a close made offline must reach the server');
  assert.equal(keepBufferedWrite({ type: 'upsert', table: 'bar_tabs', payload: { id: 'T9' }, ts: 4000 }, isFinished), false);
  assert.equal(keepBufferedWrite({ type: 'update', table: 'order_queue', payload: { ref: 'GONE' }, ts: 4000 }, isFinished), false, 'an update is a state write too');
  assert.equal(keepBufferedWrite({ type: 'delete', table: 'order_queue', match: { ref: 'GONE' } }, isFinished), true);
  assert.equal(keepBufferedWrite({ type: 'upsert', table: 'closed_checks', payload: { id: 'c' }, ts: 1 }, isFinished), true);
});

test('rows on the server only are adopted, unless this till is still deleting them', () => {
  const remote = [synced({ ref: 'A', status: 'prep', total: 1 }), synced({ ref: 'B', status: 'prep', total: 2 })];
  const r = reconcileList({ local: [], remote, keyOf, hashOf, isDone, isTraining, skipAdopt: new Set(['B']) });
  assert.deepEqual(r.adopted, ['A']);
  assert.deepEqual(r.next.map(o => o.ref), ['A']);
});

test('on both sides: the server wins when it changed, ours wins while pending', () => {
  const mine = synced({ ref: 'X', status: 'prep', total: 5 }, 1000);
  const serverNewer = synced({ ref: 'X', status: 'ready', total: 5 }, 2000);
  const r = reconcileList({ local: [mine], remote: [serverNewer], keyOf, hashOf, isDone, isTraining });
  assert.equal(r.next[0].status, 'ready');
  assert.equal(r.next[0]._sync.at, 2000);
  assert.deepEqual(r.updated, ['X']);
  // Same content, same stamp: untouched, not "changed"
  const same = reconcileList({ local: [mine], remote: [synced({ ref: 'X', status: 'prep', total: 5 }, 1000)], keyOf, hashOf, isDone, isTraining });
  assert.equal(same.changed, false);
  assert.equal(same.next[0], mine);
  // Pending local edit beats a server copy: the flush is about to send it
  const pendingMine = { ...mine, status: 'collected' };
  const r2 = reconcileList({ local: [pendingMine], remote: [serverNewer], keyOf, hashOf, isDone, isTraining });
  assert.equal(r2.next[0].status, 'collected');
  assert.deepEqual(r2.updated, []);
});

test('training rows and done rows are left alone', () => {
  const training = { ref: 'T', status: 'prep', total: 4, training: true };
  const collected = synced({ ref: 'C', status: 'collected', total: 4 });
  const r = reconcileList({ local: [training, collected], remote: [], keyOf, hashOf, isDone, isTraining });
  assert.deepEqual(r.next.map(o => o.ref), ['T', 'C']);
  assert.deepEqual(r.publish, []);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.changed, false);
});

test('a capped or partial server read never drops anything', () => {
  const local = [synced({ ref: 'OLD', status: 'prep', total: 9 })];
  const r = reconcileList({ local, remote: [], keyOf, hashOf, isDone, isTraining, capped: true });
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.next.map(o => o.ref), ['OLD']);
});

test('changedKeys: new keys and keys the server moved since our stamp', () => {
  const local = [synced({ ref: 'A', status: 'prep', total: 1 }, 1000), synced({ ref: 'B', status: 'prep', total: 1 }, 5000)];
  const heads = [{ key: 'A', at: 1000 }, { key: 'B', at: 6000 }, { key: 'C', at: 10 }, null];
  assert.deepEqual(changedKeys(local, heads, keyOf), ['B', 'C']);
  assert.deepEqual(changedKeys([], [], keyOf), []);
});

test('QueueSync uses the rule at boot, stamps every confirmed row, and the reconciler runs on the till', () => {
  const qs = fs.readFileSync(path.join(here, '../sync/QueueSync.js'), 'utf8');
  assert.ok(qs.includes("from '../lib/queueReconcile'"));
  assert.ok(qs.includes('reconcileList('), 'boot goes through the rule, not a union');
  assert.ok(!/\[\.\.\.local, \.\.\.remote\.filter/.test(qs), 'the old union is gone');
  assert.ok(qs.includes('_sync'), 'rows carry the sync stamp');
  const rec = fs.readFileSync(path.join(here, '../sync/QueueReconciler.js'), 'utf8');
  assert.ok(rec.includes('reconcileList(') && rec.includes('changedKeys('));
  assert.match(rec, /setInterval\(/);
  assert.ok(rec.includes("addEventListener('online'") && rec.includes('visibilitychange'));
  assert.ok(rec.includes('setReplayGuard({ before: beforeReplay, keep: keepBufferedWrite })'), 'a reconnect re-checks the server before buffered writes replay');
  assert.ok(/latchRows\(r\.next\);\s*\n\s*if \(r\.changed\) useStore\.setState/.test(rec), 'adopted and updated rows are latched before the store change wakes the flush');
  assert.ok(qs.includes('export function latchQueueRows(') && qs.includes('latchQueueRows(r.next)'), 'boot latches the same way');
  // The store is read after the network wait and written in the same synchronous step
  for (const fn of ['applyQueueReconcile', 'applyTabReconcile']) {
    const body = rec.slice(rec.indexOf(`function ${fn}(`), rec.indexOf('\n}\n', rec.indexOf(`function ${fn}(`)));
    assert.ok(body.includes('useStore.getState()'), `${fn} reads the store itself`);
    assert.ok(!/\bawait\b/.test(body), `${fn} has no await between read and write`);
  }
  assert.ok(rec.includes('if (_pass) return _pass;'), 'one pass at a time, shared with the replay guard');
  assert.ok(rec.includes('await whenQueueBootSettled();'), 'the first pass waits for the boot read');
  assert.ok(rec.includes('primeQueueSync(loc);'), 'location and latches are primed before the first hash');
  assert.ok(rec.includes('const droppableQ = stampedKeys(st.orderQueue') && rec.indexOf('const droppableQ') < rec.indexOf('Promise.race([Promise.all(['), 'droppable keys are snapshotted before the heads read');
  assert.equal((rec.match(/canDrop: [ot] => droppable\.has\(String\([ot]\.(ref|id)\)\)/g) || []).length, 2, 'both lists pass canDrop');
  assert.equal((rec.match(/unconfirmedIsStale: staleUnconfirmedRule\('(queue|tab)', buffered\)/g) || []).length, 2, 'both lists apply the stale copy rule every pass');
  assert.ok(rec.includes("bufferedUpsertKeys('order_queue')") && rec.includes("bufferedUpsertKeys('bar_tabs')"), 'the pass knows which rows have a buffered write');
  assert.ok(rec.includes('if (ok && !partial) markQueuesJudged();'), 'a full read (not capped, not an unbelieved empty read) unlocks the flush for old copies');
  assert.ok(rec.includes('r.adopted.forEach(k => noteAdopted(kind, k));'), 'an adopted row is remembered as adopted');
  assert.ok(rec.includes('_emptyQ = (qHeads.data.length === 0 && droppableQ.size > 0) ? _emptyQ + 1 : 0;') && rec.includes('_emptyQ < EMPTY_STREAK'), 'an empty read while holding confirmed rows is not believed until it repeats');
  assert.equal((rec.match(/keepIfPending: \(\) => true/g) || []).length, 1, 'tabs with unsent changes are kept in the pass');
  assert.ok(rec.includes("window.dispatchEvent(new CustomEvent('rpos-queue-orphaned'"), 'orphaned tabs are surfaced');
  assert.ok(rec.includes('keepRule(item, (kind, key, ts) => isFinishedAfter(kind, key, ts))'), 'the replay keep rule is time aware');
  assert.ok(rec.includes('Date.now() - _lastPass.at < REUSE_PASS_MS) return true;'), 'a replay reuses a pass that just finished');
  assert.ok(qs.includes('const rowHash = (row) => digest(canonicalJson(row));') && qs.includes('rowHash(queueToRow(') && qs.includes('rowHash(tabToRow('), 'hashes are digests of canonical rows');
  assert.equal((qs.match(/const payload = rowHash\(row\);/g) || []).length, 2, 'both flush latches hold the same digest');
  assert.equal((qs.match(/new Map\((queue|tab)Upserts\.map\(r => \[r\.(ref|id), rowHash\(r\)\]\)\)/g) || []).length, 2, 'both confirmations compare the same digest');
  assert.equal((qs.match(/unconfirmedIsStale: staleUnconfirmedRule\('(queue|tab)', buf[QT]\), canDrop: [ot] => droppable[QT]\.has\(String\([ot]\.(ref|id)\)\)/g) || []).length, 2, 'boot applies the stale copy rule and canDrop to both lists');
  assert.ok(qs.includes('const droppableQ = stampedKeys(useStore.getState().orderQueue') && qs.indexOf('const droppableQ') < qs.indexOf('await Promise.all([\n      openQueueQuery(_locationId).limit'), 'boot snapshots droppable keys before the read');
  assert.ok(qs.includes('primeQueueSync(_locationId);') && qs.indexOf('primeQueueSync(_locationId);') < qs.indexOf('await Promise.all([\n      openQueueQuery(_locationId).limit'), 'latch seeded before the boot read');
  assert.equal((qs.match(/if \(!_judged && ![ot]\._sync && _bootUnstamped[QT]\.has\(String\([ot]\.(ref|id)\)\)\) continue;/g) || []).length, 2, 'the flush holds only copies from before this boot until a full read judged them');
  assert.ok(qs.includes('export function captureQueueBoot(') && qs.includes('if (!buffered) return () => false;') && qs.includes('return boot.has(k) && !buffered.has(k) && boot.get(k) > STALE_UNCONFIRMED_MS;'), 'only a saved unstamped boot row with no buffered write, old AT BOOT, can be an old copy');
  assert.ok(qs.includes('_bootUnstampedQ.set(String(o.ref), queueAgeMs(o));') && qs.includes('_bootUnstampedT.set(String(t.id), tabAgeMs(t));'), 'the age is frozen at boot');
  assert.ok(qs.includes('export function holdUnknownRule(') && qs.includes("hold: holdUnknownRule('queue', bufQ),") && qs.includes("hold: holdUnknownRule('tab', bufT),"), 'unreadable evidence holds saved rows at boot');
  assert.equal((rec.match(/hold: holdUnknownRule\('(queue|tab)', buffered\)/g) || []).length, 2, 'unreadable evidence holds saved rows in the pass');
  assert.ok(rec.includes('let partial = !bufQ || !bufT;'), 'unreadable evidence never counts as a full read');
  assert.ok(qs.includes('&& bufQ && bufT) markQueuesJudged();'), 'boot is judged only with readable evidence');
  assert.ok(!qs.includes('_bootGate.then(flushQueues)') && qs.includes('if (immediate) { _debounceTimer = null; flushQueues(); return; }'), 'a new row is written to disk at once, never behind the boot read');
  assert.equal((qs.match(/_sync: syncStamp\(ourPayload, Math\.max\(incoming\._sync\.at/g) || []).length, 2, 'an own echo stamps the payload that was sent');
  assert.ok(qs.includes(".neq('status', 'closed').select('id, updated_at')") && qs.includes("notMatch: { status: 'closed' }"), 'a tab update never re-opens a closed tab, live or replayed');
  assert.ok(rec.includes('async function publishAfterCheck(') && rec.includes('finishedRefsOnServer(toCheck.map(k => ({ ref: k, createdAt:') && rec.includes('if (f === null) return;'), 'a pass never re-creates an order that has a closed check');
  assert.ok(rec.includes('if (r.publish.length) _pendingChecks.push(publishAfterCheck(stateKey, kind, r.publish, publishRows, markDropped));') && !/publishRows\(r\.publish\)/.test(rec), 'the pass publishes only through the closed check');
  assert.ok(rec.includes('await Promise.allSettled(checks);'), 'a pass resolves only after its closed check tests landed');
  assert.ok(rec.includes('if (_lastPass && _lastPass.ok && !_pass'), 'only a successful pass is reused by the replay');
  assert.ok(rec.includes("rej(new Error('head read timed out'))"), 'a hung head read cannot pin the pass');
  assert.ok(rec.includes('const newlyOrphaned = (r.orphaned || []).filter(k => !wasOrphan.has(String(k)));'), 'the orphan warning fires once');
  assert.ok(rec.includes('payloadHash(item.payload) === cur._sync.hash) return false;'), 'a buffered copy of a confirmed payload is not replayed');
  assert.ok(qs.includes('_lastSentQueue[ref] = queueHash(o); }') && qs.includes('_lastSentTab[id] = tabHash(t); }') && !qs.includes('for (const ref of r.publish) delete _lastSentQueue[ref];'), 'boot never publishes blind: the first pass does, after the closed check');
  assert.ok(qs.includes('else if (isPendingLocal(queue[idx], queueHash)) return;') && qs.includes("incoming.status === 'closed' && tabs[idx].status !== 'closed' && !tabs[idx]._orphan"), 'a foreign echo never overwrites unsent changes; a close over an unsent round flags the tab');
  assert.ok(rec.includes("const isPaidHere = (o) => !!(o && (o.paid === true || o.customer?.paid === true));") && rec.includes('keys.filter(k => !isPaidHere('), 'an order paid and kept on this till is not judged by its own closed check');
  assert.ok(qs.includes("if (at >= (createdAt.get(String(c.ref)) || 0)) out.add(String(c.ref));"), 'only a check closed after this copy was created counts (order numbers are re used)');
  assert.ok(qs.includes('export function noteQueueRemovals(') && qs.includes('export function isFinishedAfter(') && qs.includes('export function noteAdopted('), 'removals and adoptions are recorded when they happen');
  assert.ok(qs.includes('if (v.adoptedAt !== undefined && at >= v.adoptedAt) return false;'), 'a write buffered after the row came back replays again');
  assert.equal((qs.match(/queueWrite\(\{ type: 'update', table: '(order_queue|bar_tabs)'/g) || []).length, 2, 'confirmed rows are updated, never upserted');
  assert.equal((qs.match(/\.update\(row\)\.eq\(/g) || []).length, 2, 'the live write for a confirmed row is an update');
  assert.ok(qs.includes('if (!confirmedAt.has(k)) return row;'), 'an update the server did not return stamps nothing');
  assert.equal((qs.match(/keepIfPending: \(\) => true/g) || []).length, 1, 'tabs with unsent changes are kept at boot');
  assert.ok(qs.includes('export function scheduleQueueFlush(immediate = false)') && qs.includes('export function hasNewUnsentRows('), 'a new order or tab is flushed at once');
  const oq2 = fs.readFileSync(path.join(here, '../sync/OfflineQueue.js'), 'utf8');
  assert.ok(oq2.includes("for (const [k, v] of Object.entries(item.notMatch || {})) q = q.neq(k, v);"), 'the replay honours the guard');
  assert.ok(oq2.includes("} else if (item.type === 'update') {") && oq2.includes("it.type === 'update' ? `x|${it.table}`"), 'the replay knows update writes');
  assert.ok(oq2.includes("return null; }") && oq2.includes("it.status === 'dismissed') continue;") && !oq2.includes('it.permanentFailure || it.status'), 'a refused write is still evidence, an unreadable store is unknown');
  assert.ok(qs.includes('function duePublish(') && qs.includes('PUBLISH_RETRY_MS'), 'publishing is rate limited per row');
  assert.ok(!qs.includes('rpos-queue-stamped'), 'no one shot upgrade flag: the age rule holds on every boot');
  const oq = fs.readFileSync(path.join(here, '../sync/OfflineQueue.js'), 'utf8');
  assert.ok(oq.includes('export function setReplayGuard(') && oq.includes('await _guard.before()') && oq.includes('_guard.keep(it)'));
  assert.ok(oq.includes('if (_guard && !reconciled && isStateWrite(it)) continue;'), 'state writes stay queued when the server could not be re-checked');
  assert.ok(oq.includes('export async function bufferedUpsertKeys('));
  const bridge = fs.readFileSync(path.join(here, '../sync/SyncBridge.jsx'), 'utf8');
  assert.ok(bridge.includes('startQueueReconciler()') && bridge.includes('stopQueueReconciler()'));
  assert.ok(bridge.includes('const removed = noteQueueRemovals(prev.orderQueue, state.orderQueue) + noteTabRemovals(prev.tabs, state.tabs);'), 'the store subscriber records removals');
  assert.ok(bridge.includes('if (isApplyingRef.current && !removed) return;'), 'a change applied from another tab is not flushed twice, but a removal always is');
  assert.ok(bridge.includes('scheduleQueueFlush(hasNewUnsentRows(prev.orderQueue, state.orderQueue, prev.tabs, state.tabs));'), 'a new order is flushed at once');
  assert.ok(/useStore\.setState\(parsed\);[\s\S]{0,400}if \(!isMock\) captureQueueBoot\(\);/.test(bridge), 'boot rows are captured right after the saved list is applied');
});
