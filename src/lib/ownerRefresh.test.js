// ownerRefresh.test.js — the Owner app's refresh must never fail in silence.
//
// 27 Sep 2026: "the owner app doesn't refresh on the click refresh". The button did call
// the server; the call simply never came back on a phone that had been asleep (a stalled
// auth lock, or a socket the OS had dropped). Nothing in the screen ever finished, so the
// "Updated HH:MM" line stayed put, no error appeared, and the arrow gave no sign of life.
// A refresh that cannot answer must say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withTimeout, TimeoutError } from './withTimeout.js';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('the owner refresh is raced against a timer, and says so when it loses', async () => {
  const src = read('../surfaces/OwnerSurface.jsx');

  // The snapshot call cannot hang for ever. (2 Oct 2026: it now sends the quick filter's
  // period, and This month, the heavier read, is given longer before it is called lost.)
  assert.ok(src.includes("await withTimeout(\n        supabase.functions.invoke('owner-snapshot', { body: { period: want } }),\n        want === 'month' ? MONTH_LOAD_TIMEOUT_MS : LOAD_TIMEOUT_MS, 'Owner snapshot')"),
    'the snapshot call is wrapped in withTimeout');
  assert.match(src, /const LOAD_TIMEOUT_MS = \d+;/);
  assert.match(src, /const MONTH_LOAD_TIMEOUT_MS = \d+;/);

  // A call that never answers reads as a connection problem, not silence.
  assert.ok(src.includes('e instanceof TimeoutError'), 'a timeout is told apart from a server error');
  assert.ok(src.includes('Could not reach ServOS. Tap the arrow to try again, or close and reopen the app.'));

  // The arrow shows it is working, and cannot be tapped twice into two calls.
  assert.ok(src.includes('disabled={busy}') && src.includes("{busy ? '⋯' : '↻'}"), 'the arrow shows the refresh running');
  // Only the latest request owns the arrow (chips can be tapped while one is in flight), and
  // the latest one always gives it back.
  assert.ok(src.includes('finally { if (mine === seq.current) { setBusy(false); setLoading(false); } }'), 'the button always comes back');
  assert.ok(src.includes('const mine = ++seq.current;'), 'every request takes the next number');
});

test('withTimeout rejects a call that never answers, and passes one that does', async () => {
  const never = new Promise(() => {});
  await assert.rejects(() => withTimeout(never, 20, 'Owner snapshot'), (e) => e instanceof TimeoutError);
  assert.equal(await withTimeout(Promise.resolve('ok'), 50, 'Owner snapshot'), 'ok');
});

test('the manager app cannot hang on its snapshot either', () => {
  const src = read('./manager/data.js');
  assert.ok(src.includes('MANAGER_SNAPSHOT_TIMEOUT_MS'), 'the snapshot call has a timer');
  assert.ok(src.includes("'Manager snapshot')"), 'it is raced against that timer');
  assert.ok(src.includes('e instanceof TimeoutError ? MANAGER_UNREACHABLE'), 'a timeout reads as a connection problem');
  assert.ok(!/withTimeout\([\s\S]{0,200}manager-approve/.test(src), 'writes are NOT given a timeout: a lost reply must not look like a failed approval');
});
