// 28 Sep 2026: the v5.11.1 release review fixes (source pins; the flows need a live till).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('a later Collection paid on the reader keeps its scheduled entry, marked paid', () => {
  const store = read('../store/index.js');
  assert.match(store, /s\.orderQueue\.flatMap\(o => \(o\.ref !== existingRef \? \[o\] : \(o\.status === 'scheduled' \? \[markQueueEntryPaid\(o\)\] : \[\]\)\)\)/);
  assert.doesNotMatch(store, /: s\.orderQueue\.filter\(o => o\.ref !== existingRef\),/);
});

test('a reader job whose sale has landed on this till is marked reconciled', () => {
  const store = read('../store/index.js');
  assert.match(store, /import \{ patchPendingCheck, isPendingCheck \} from '\.\.\/sync\/DataSafe';/);
  assert.match(store, /if \(!isPendingCheck\(job\.closed_check_id\) && Date\.now\(\) - \(Number\(localClose\.closedAt\) \|\| 0\) > 30000\) \{\n\s*markJobReconciled\(job\.id\)\.catch\(\(\) => \{\}\);/);
  const ds = read('../sync/DataSafe.js');
  assert.match(ds, /export function isPendingCheck\(checkId\) \{/);
});

test('the payment pause runs on a monotonic clock', async () => {
  const src = read('./paymentBusy.js');
  assert.match(src, /performance\.now\(\)/);
  assert.match(src, /let clock = monotonic;/);
});
