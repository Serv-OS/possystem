/**
 * edgeFnDeps.test.js - scripts/check-deploys.mjs dates a function by its folder AND every _shared
 * file it ships (18 Sep 2026). Before this, a change made only in _shared read as live while the
 * old code was still serving (_shared/ezcaterCatering.js is imported by five functions).
 * Run: `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { relativeSpecifiers, sharedDepsOf, deployPathsOf } from '../../scripts/edgeFnDeps.mjs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The real repo, read from its root whatever directory the tests run in.
const repoIo = {
  read: (p) => fs.readFileSync(path.join(ROOT, p), 'utf8'),
  exists: (p) => { try { return fs.statSync(path.join(ROOT, p)).isFile(); } catch { return false; } },
  list: (d) => { try { return fs.readdirSync(path.join(ROOT, d)); } catch { return []; } },
};
// A made up tree, so the walk is pinned without the repo.
const fakeIo = (files) => ({
  read: (p) => { if (!(p in files)) throw new Error(`no ${p}`); return files[p]; },
  exists: (p) => p in files,
  list: (d) => Object.keys(files).filter((p) => path.posix.dirname(p) === d).map((p) => path.posix.basename(p)),
});

test('relativeSpecifiers: static, re-export, bare and dynamic imports; remote ones are ignored', () => {
  const src = [
    "import { a } from '../_shared/a.ts';",
    'import {\n  b,\n} from "../_shared/b.js";',
    "export { c } from './c.ts';",
    "import './d.ts';",
    "const e = await import('../_shared/e.ts');",
    "import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';",
    '// a comment naming _shared/f.ts is not an import',
  ].join('\n');
  assert.deepEqual(relativeSpecifiers(src).sort(), ['../_shared/a.ts', '../_shared/b.js', '../_shared/e.ts', './c.ts', './d.ts']);
  assert.deepEqual(relativeSpecifiers(null), []);
});

test('sharedDepsOf follows _shared imports through other _shared files, once each, cycles included', () => {
  const io = fakeIo({
    'supabase/functions/fn/index.ts': "import { x } from '../_shared/x.ts';\nimport { h } from './helper.ts';",
    'supabase/functions/fn/helper.ts': "import { y } from '../_shared/y.js';",
    'supabase/functions/fn/README.md': "import { z } from '../_shared/z.ts';",
    'supabase/functions/_shared/x.ts': "import { r } from './rules.js';\nimport { y } from './y.js';",
    'supabase/functions/_shared/y.js': "import { x } from './x.ts';",
    'supabase/functions/_shared/rules.js': 'export const r = 1;',
    'supabase/functions/_shared/z.ts': 'export const z = 1;',
    'supabase/functions/other/index.ts': "import { r } from '../_shared/rules.js';",
  });
  assert.deepEqual(sharedDepsOf('fn', io), [
    'supabase/functions/_shared/rules.js', 'supabase/functions/_shared/x.ts', 'supabase/functions/_shared/y.js',
  ]);
  assert.deepEqual(deployPathsOf('fn', io)[0], 'supabase/functions/fn');
  assert.deepEqual(sharedDepsOf('missing', io), []);
  // An import of a file that is not there is not listed (nothing to date it by).
  const gone = fakeIo({ 'supabase/functions/g/index.ts': "import '../_shared/nope.ts';" });
  assert.deepEqual(sharedDepsOf('g', gone), []);
});

test('the six ezCater release functions: each ships _shared/ezcaterCatering.js where it imports it', () => {
  const shipsRules = ['catering-release', 'order-notify', 'review-request', 'uber-direct', 'ezcater-webhook'];
  for (const fn of shipsRules) {
    const deps = sharedDepsOf(fn, repoIo);
    assert.ok(deps.includes('supabase/functions/_shared/ezcaterCatering.js'), fn);
    // ezcaterCatering.js imports cateringRules.js, so that is dated too.
    assert.ok(deps.includes('supabase/functions/_shared/cateringRules.js'), `${fn} through ezcaterCatering.js`);
  }
  // uber-direct only reaches the rules through the courier dispatcher.
  assert.ok(sharedDepsOf('uber-direct', repoIo).includes('supabase/functions/_shared/delivery-dispatch.ts'));
  assert.doesNotMatch(read('../../supabase/functions/uber-direct/index.ts'), /_shared\/ezcaterCatering\.js/);
  // ezcater-connect ships its own _shared files, not the catering rules.
  const connect = sharedDepsOf('ezcater-connect', repoIo);
  assert.ok(connect.includes('supabase/functions/_shared/ezcater.ts'));
  assert.equal(connect.includes('supabase/functions/_shared/ezcaterCatering.js'), false);
});

test('check-deploys dates each function by its folder AND its _shared files', () => {
  const src = read('../../scripts/check-deploys.mjs');
  assert.match(src, /import \{ deployPathsOf \} from '\.\/edgeFnDeps\.mjs';/);
  assert.match(src, /for \(const p of deployPathsOf\(fn\.slug\)\.slice\(1\)\) \{/);
  assert.match(src, /if \(t > committed\) \{ committed = t; newestPath = p; \}/);
  assert.match(src, /const hours = \(committed - deployed\) \/ 3600;/);
  assert.match(src, /stale\.push\(\{ slug: fn\.slug, hours, newestPath \}\)/);
});
