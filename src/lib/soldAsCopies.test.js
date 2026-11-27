// 5.12.115: the edge functions cannot import from src, so supabase/functions/_shared/soldAs.js is
// a copy of src/lib/soldAs.js (the publish planner and the delivery platform export read it).
// The two must never drift: everything below the first line is the same, byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const body = (p) => readFileSync(join(here, p), 'utf8').split('\n').slice(1).join('\n');

test('the two copies of the Sold as rule are the same below their first line', () => {
  assert.equal(body('../../supabase/functions/_shared/soldAs.js'), body('./soldAs.js'));
});

test('the publish planner reads the copy beside it, never the one in src', () => {
  const plan = readFileSync(join(here, '../../supabase/functions/_shared/msmPlan.js'), 'utf8');
  assert.match(plan, /from '\.\/soldAs\.js';/);
  assert.doesNotMatch(plan, /src\/lib\/soldAs/.source ? /from '[^']*src\/lib\/soldAs/ : /x^/);
});
