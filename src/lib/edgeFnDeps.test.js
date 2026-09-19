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

import { relativeSpecifiers, sharedDepsOf, deployPathsOf, staleFunctions } from '../../scripts/edgeFnDeps.mjs';

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

test('check-deploys hands its decision to staleFunctions with this checkout\'s git log', () => {
  const src = read('../../scripts/check-deploys.mjs');
  assert.match(src, /import \{ staleFunctions \} from '\.\/edgeFnDeps\.mjs';/);
  assert.match(src, /git log -1 --format=%ct -- "\$\{p\}"/);
  assert.match(src, /const stale = staleFunctions\(await res\.json\(\), lastCommitOf\);/);
  // The deploy it offers keeps JWT checking off: ezCater's notifications carry no Supabase JWT.
  assert.match(src, /functions deploy \$\{s\.slug\} --project-ref \$\{PROJECT\} --no-verify-jwt/);
});

test('staleFunctions: a change made ONLY in _shared reports every importing function as not live', () => {
  // A made up tree: two functions import the rules through _shared, one does not.
  const io = fakeIo({
    'supabase/functions/catering-release/index.ts': "import { r } from '../_shared/rules.js';",
    'supabase/functions/uber-direct/index.ts': "import { d } from '../_shared/dispatch.ts';",
    'supabase/functions/_shared/dispatch.ts': "import { r } from './rules.js';",
    'supabase/functions/_shared/rules.js': 'export const r = 1;',
    'supabase/functions/gift-redeem/index.ts': "import { g } from '../_shared/gift.ts';",
    'supabase/functions/_shared/gift.ts': 'export const g = 1;',
  });
  const H = 3600;
  const deployedAt = 1_800_000_000;                   // unix seconds, every function deployed then
  // A made up git history: each folder was last committed BEFORE its deploy. The only newer
  // commit is to _shared/rules.js, two days after the deploy.
  const history = {
    'supabase/functions/catering-release': deployedAt - 10 * H,
    'supabase/functions/uber-direct': deployedAt - 10 * H,
    'supabase/functions/gift-redeem': deployedAt - 10 * H,
    'supabase/functions/_shared/dispatch.ts': deployedAt - 10 * H,
    'supabase/functions/_shared/gift.ts': deployedAt - 10 * H,
    'supabase/functions/_shared/rules.js': deployedAt + 48 * H,
  };
  const calls = [];
  const lastCommitOf = (p) => { calls.push(p); return history[p] || 0; };
  const live = ['catering-release', 'uber-direct', 'gift-redeem', 'not-in-repo']
    .map((slug) => ({ slug, updated_at: deployedAt * 1000 }));

  const stale = staleFunctions(live, lastCommitOf, io);
  assert.deepEqual(stale.map((s) => s.slug).sort(), ['catering-release', 'uber-direct']);
  for (const s of stale) {
    assert.equal(s.newestPath, 'supabase/functions/_shared/rules.js', s.slug);
    assert.equal(s.hours, 48, s.slug);
  }
  // uber-direct reaches the rules only through another _shared file, and is still caught.
  assert.ok(calls.includes('supabase/functions/_shared/rules.js'));
  // A function whose folder has no commit is not in this repo: skipped, never reported.
  assert.equal(stale.some((s) => s.slug === 'not-in-repo'), false);

  // Control: the same history without the _shared commit reports nothing.
  const quiet = { ...history, 'supabase/functions/_shared/rules.js': deployedAt - 10 * H };
  assert.deepEqual(staleFunctions(live, (p) => quiet[p] || 0, io), []);
  // Deploy then commit a few minutes later is noise, not drift.
  const noise = { ...history, 'supabase/functions/_shared/rules.js': deployedAt + 0.5 * H };
  assert.deepEqual(staleFunctions(live, (p) => noise[p] || 0, io), []);
  // Redeployed after the _shared change: live again.
  const redeployed = live.map((f) => ({ ...f, updated_at: (deployedAt + 49 * H) * 1000 }));
  assert.deepEqual(staleFunctions(redeployed, lastCommitOf, io), []);
});
