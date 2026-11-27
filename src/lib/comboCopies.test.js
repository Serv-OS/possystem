// 5.12.124: the Edge Functions cannot import from src, so supabase/functions/_shared/combo.js is a
// copy of src/lib/combo.js (the publish planner and the health check read a Combo's steps with it).
// The two must never drift: everything below the first line is the same, byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');
const body = (p) => read(p).split('\n').slice(1).join('\n');

test('the two copies of the Combo rules are the same below their first line', () => {
  assert.equal(body('../../supabase/functions/_shared/combo.js'), body('./combo.js'));
});

test('the rules import nothing, so the copy runs in an Edge Function as it is', () => {
  assert.doesNotMatch(read('./combo.js'), /^\s*import\s/m);
});

test('the publish planner and the health check read the copy beside them, never the one in src', () => {
  for (const f of ['msmPlan.js', 'msmHealth.js']) {
    const src = read(`../../supabase/functions/_shared/${f}`);
    assert.match(src, /from '\.\/combo\.js';/, `${f} reads the shared copy`);
    assert.doesNotMatch(src, /from '[^']*src\/lib\/combo/, `${f} never reaches into src`);
  }
});
