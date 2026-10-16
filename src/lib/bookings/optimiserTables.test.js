// optimiserTables.test.js: the host stand only offers real floor plan tables (16 Oct 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimiserTables } from './optimiserTables.js';

test('rebuilt and removed tables, and split children, never reach the optimiser', () => {
  const out = optimiserTables([
    { id: 't1', label: 'T1', maxCovers: 4, section: 'main' },
    { id: 't1.1', label: 'T1.1', parentId: 't1' },
    { id: 'old', label: 'Removed table', planRemoved: true, rebuilt: true },
    { id: 'gone', label: 'T9', planRemoved: true },
    { id: 'reb', label: 'Removed table', rebuilt: true },
    null,
    { id: 't2' },
  ]);
  assert.deepEqual(out, [
    { id: 't1', label: 'T1', covers: 4, section: 'main' },
    { id: 't2', label: 't2', covers: 2, section: null },
  ]);
  assert.deepEqual(optimiserTables(null), []);
});
