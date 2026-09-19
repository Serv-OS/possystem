#!/usr/bin/env node
// scripts/check-deploys.mjs — WHICH EDGE FUNCTIONS ARE NOT LIVE?
//
// WHY THIS EXISTS: the web app auto-deploys on push to develop, but Supabase edge
// functions deploy MANUALLY. A fix can be written, reviewed, committed and still not be
// running — which is exactly how "gift cards redeem at COMMIT" (v5.5.901) sat undeployed
// for 59 days while everyone believed it shipped. Git being green tells you nothing about
// what is actually serving traffic.
//
// Usage:  SUPABASE_ACCESS_TOKEN=... node scripts/check-deploys.mjs [--deploy]
//   (no flag)  report only
//   --deploy   deploy every function whose committed code is newer than its live version
//
// Sub-hour differences are ignored: deploying and then committing seconds later is normal
// and would otherwise bury the real drift in noise.
//
// _SHARED COUNTS (18 Sep 2026). A deploy bundles the function's folder AND every _shared file it
// imports, so a function is dated by the newest commit to ANY of those (scripts/edgeFnDeps.mjs).
// Before this, a change made only in _shared read as live while the old code was still serving.
// Run it from the checkout you deployed from: the dates are read from THIS checkout's git log.

import { execSync } from 'node:child_process';
import { deployPathsOf } from './edgeFnDeps.mjs';

const PROJECT = 'tbetcegmszzotrwdtqhi';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const DO_DEPLOY = process.argv.includes('--deploy');
const MIN_HOURS = 1;   // below this it is deploy/commit ordering noise, not drift

if (!TOKEN) { console.error('SUPABASE_ACCESS_TOKEN not set'); process.exit(1); }

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/functions`, {
  headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'Mozilla/5.0' },
});
if (!res.ok) { console.error('list failed:', res.status, await res.text()); process.exit(1); }

const stale = [];
for (const fn of await res.json()) {
  const dir = `supabase/functions/${fn.slug}`;
  let committed;
  try {
    committed = Number(execSync(`git log -1 --format=%ct -- ${dir}`, { encoding: 'utf8' }).trim());
  } catch { continue; }
  if (!committed) continue;                       // not in this repo
  // The folder plus every _shared file it ships: the newest commit to any of them.
  let newestPath = dir;
  for (const p of deployPathsOf(fn.slug).slice(1)) {
    try {
      const t = Number(execSync(`git log -1 --format=%ct -- "${p}"`, { encoding: 'utf8' }).trim());
      if (t > committed) { committed = t; newestPath = p; }
    } catch { /* not committed yet: nothing to date it by */ }
  }
  const deployed = fn.updated_at / 1000;
  const hours = (committed - deployed) / 3600;
  if (hours > MIN_HOURS) stale.push({ slug: fn.slug, hours, newestPath });
}

stale.sort((a, b) => b.hours - a.hours);
if (!stale.length) { console.log('✅ every edge function is live with its committed code'); process.exit(0); }

console.log(`⚠ ${stale.length} edge function(s) NOT LIVE with committed code:\n`);
for (const s of stale) {
  const age = s.hours > 48 ? `${(s.hours / 24).toFixed(0)} days` : `${s.hours.toFixed(1)}h`;
  const why = s.newestPath.includes('/_shared/') ? `  (newest change: ${s.newestPath})` : '';
  console.log(`   ${s.slug.padEnd(34)} ${age} behind${why}`);
}

if (!DO_DEPLOY) { console.log('\nRe-run with --deploy to ship them.'); process.exit(1); }

console.log('\nDeploying…');
for (const s of stale) {
  try {
    execSync(`npx supabase functions deploy ${s.slug} --project-ref ${PROJECT} --no-verify-jwt`,
             { stdio: 'pipe', encoding: 'utf8' });
    console.log(`   ✅ ${s.slug}`);
  } catch (e) {
    console.log(`   ❌ ${s.slug} — ${String(e.stderr || e.message).split('\n')[0]}`);
  }
}
