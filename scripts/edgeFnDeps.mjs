// scripts/edgeFnDeps.mjs: WHICH FILES DOES AN EDGE FUNCTION SHIP?
//
// WHY THIS EXISTS: `supabase functions deploy <slug>` bundles the function's own folder AND
// every supabase/functions/_shared file it imports, directly or through another _shared file.
// scripts/check-deploys.mjs used to date a function by its own folder only, so a change made
// only in _shared (18 Sep 2026: _shared/ezcaterCatering.js, imported by six functions) read as
// "live" while the deployed code was still the old one. This lists the whole set, so the
// deploy check dates a function by the newest commit to ANY file it ships.
//
// Pure apart from the file reads, which the caller can swap out (the test does).

import fs from 'node:fs';
import path from 'node:path';

const FUNCTIONS_DIR = 'supabase/functions';
const SHARED_DIR = `${FUNCTIONS_DIR}/_shared`;

/** Every relative module specifier in one source file: static imports, re-exports, import(). */
export function relativeSpecifiers(src) {
  const out = new Set();
  const text = String(src ?? '');
  const res = [
    /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,          // import x from './a' and export { x } from './a'
    /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,        // import './a'
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g, // import('./a')
  ];
  for (const re of res) for (const m of text.matchAll(re)) out.add(m[1]);
  return [...out];
}

const defaultIo = {
  read: (p) => fs.readFileSync(p, 'utf8'),
  exists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  list: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } },
};

/**
 * The _shared files a function ships, as repo relative paths, sorted. Follows imports from every
 * source file in the function's own folder, then from each _shared file reached, until nothing
 * new turns up. Only files under supabase/functions/_shared are returned (the function's own
 * folder is dated as a whole already, and remote https imports are not in the repo).
 */
export function sharedDepsOf(slug, io = defaultIo) {
  const dir = `${FUNCTIONS_DIR}/${slug}`;
  const queue = io.list(dir)
    .filter((f) => /\.(m?[jt]sx?)$/.test(f))
    .map((f) => `${dir}/${f}`);
  const seen = new Set(queue);
  const shared = new Set();
  while (queue.length) {
    const file = queue.shift();
    let src = '';
    try { src = io.read(file); } catch { continue; }
    for (const spec of relativeSpecifiers(src)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!target.startsWith(`${SHARED_DIR}/`)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      if (!io.exists(target)) continue;
      shared.add(target);
      queue.push(target);
    }
  }
  return [...shared].sort();
}

/** Every path whose newest commit dates the function: its own folder plus its _shared files. */
export function deployPathsOf(slug, io = defaultIo) {
  return [`${FUNCTIONS_DIR}/${slug}`, ...sharedDepsOf(slug, io)];
}
