// bulkScope.test.js — sharing many products at once must be safe and honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bulkScopeTargets, runBulkScope, bulkScopeWords, bulkScopeConfirmWords } from './bulkScope.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const items = [
  { id: 'a', name: 'Americano', scope: 'local' },
  { id: 'b', name: 'Latte', scope: 'shared' },
  { id: 'c', name: 'Large', parentId: 'a', scope: 'local' },        // a size child
  { id: 'd', name: 'Oat milk', type: 'subitem', scope: 'local' },  // a sub-item
  { id: 'e', name: 'Old', archived: true, scope: 'local' },
];

test('targets are top-level, live products not already at that scope', () => {
  assert.deepEqual(bulkScopeTargets(items, 'shared').map((i) => i.id), ['a']);
  assert.deepEqual(bulkScopeTargets(items, 'local').map((i) => i.id), ['b']);
  assert.deepEqual(bulkScopeTargets(items, 'global').map((i) => i.id), ['a', 'b']);
});

test('it runs ONE product at a time, in order', async () => {
  // Two promotions at once would race to create the same peer category twice.
  let inFlight = 0, maxInFlight = 0; const order = [];
  const setScope = async (item) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    order.push(item.id); inFlight--;
    return { ok: true, action: 'promoted', createdCount: 3 };
  };
  const r = await runBulkScope({ targets: bulkScopeTargets(items, 'global'), scope: 'global', setScope });
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(r.promoted, 2); assert.equal(r.copies, 6); assert.equal(r.failed.length, 0);
});

test('one failure does not stop the rest, and is named', async () => {
  const setScope = async (item) => item.id === 'a' ? { ok: false, error: { message: 'not in an org' } } : { ok: true, action: 'rescoped' };
  const r = await runBulkScope({ targets: bulkScopeTargets(items, 'global'), scope: 'global', setScope });
  assert.equal(r.done, 2); assert.equal(r.ok.length, 1); assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].error, 'not in an org');
  assert.match(bulkScopeWords(r, 'global'), /1 product failed: Americano \(not in an org\)/);
});

test('a thrown error is a failure, not a crash', async () => {
  const r = await runBulkScope({ targets: [items[0]], scope: 'shared', setScope: async () => { throw new Error('boom'); } });
  assert.equal(r.failed[0].error, 'boom');
});

test('it can be stopped between products', async () => {
  let n = 0;
  const r = await runBulkScope({ targets: bulkScopeTargets(items, 'global'), scope: 'global', setScope: async () => ({ ok: true, action: 'rescoped' }), shouldStop: () => n++ >= 1 });
  assert.equal(r.done, 1); assert.equal(r.stopped, true);
  assert.match(bulkScopeWords(r, 'global'), /Stopped early/);
});

test('the words say what happened, in plain English', () => {
  assert.equal(bulkScopeWords({ promoted: 2, copies: 6, rescoped: 0, demoted: 0, failed: [] }, 'shared'), '2 products shared out to other venues (6 copies made).');
  assert.equal(bulkScopeWords({ promoted: 0, copies: 0, rescoped: 0, demoted: 1, failed: [] }, 'local'), '1 product set to local here.');
  assert.match(bulkScopeConfirmWords(12, 'shared', 5), /share 12 products with every venue.*5 other venues.*one product at a time/);
  assert.match(bulkScopeConfirmWords(1, 'local'), /set 1 product to Local at this venue only/);
});

test('the Items list has the strip and runs it through runBulkScope', () => {
  const src = read('../backoffice/sections/MenuManager.jsx');
  assert.match(src, /import \{ bulkScopeTargets, runBulkScope, bulkScopeWords, bulkScopeConfirmWords \} from '\.\.\/\.\.\/lib\/bulkScope'/);
  assert.match(src, /Sharing quick apply/);
  assert.match(src, /window\.confirm\(bulkScopeConfirmWords\(/, 'nothing moves without a confirm');
  assert.match(src, /runBulkScope\(\{ targets, scope: bulkScope, setScope: setMenuItemScope/);
});
