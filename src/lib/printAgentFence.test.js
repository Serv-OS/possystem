// printAgentFence.test.js: database fence stage 1, contract G1 to G3. The LAN print agents move
// to the venue key functions (print_agent_claim / print_agent_report), keep today's path only as
// the marked fallback, and the anon key is no longer written in git.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('rpos-print-agent.js reads the key from the environment (no JWT in git)', () => {
  const src = read('../../rpos-print-agent.js');
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(src), 'no anon key literal');
  assert.ok(src.includes("process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY"));
  assert.ok(src.includes("rpc('print_agent_claim'") && src.includes("rpc('print_agent_report'"));
  assert.ok(src.includes('FENCE STAGE 1 FALLBACK'));
  assert.ok(src.includes("if (!LOCATION_ID) {"), 'the old direct mode never prints every venue');
});

test('print-agent.js claims and reports through the key, polls instead of realtime in key mode', () => {
  const src = read('../../print-agent.js');
  assert.ok(src.includes("const PRINT_AGENT_TOKEN = process.env.PRINT_AGENT_TOKEN || '';"));
  assert.ok(src.includes("supabase.rpc('print_agent_claim', {") && src.includes("supabase.rpc('print_agent_report', {"));
  assert.ok(src.includes('const channel = tokenMode ? null : supabase'), 'no realtime subscription in key mode');
  assert.ok(src.includes('if (!tokenMode) supabase.from(\'print_jobs\').upsert({'), 'the fast path audit upsert is legacy only');
  assert.ok(src.includes('setInterval(drainEligible, tokenMode ? TOKEN_POLL_MS : POLL_MS);'));
  // Every direct print_jobs write sits in reportJob's legacy branch or the legacy fast path.
  const writes = [...src.matchAll(/supabase\.from\('print_jobs'\)\.(update|upsert)\(/g)].map(m => m.index);
  const legacyStart = src.indexOf("supabase.from('print_jobs').update(patch).eq('id', jobId);");
  for (const i of writes) {
    const ok = i === legacyStart || src.slice(Math.max(0, i - 40), i).includes('if (!tokenMode)');
    assert.ok(ok, 'a direct print_jobs write outside the legacy branches');
  }
  assert.ok(read('../../print-agent.env.example').includes('PRINT_AGENT_TOKEN='));
});

test('Back Office issues and revokes agent keys on the Production printing screen', () => {
  const ui = read('../backoffice/sections/PrintAgentKeys.jsx');
  assert.ok(ui.includes("supabase.rpc('issue_print_agent_token', { p_location_id: loc, p_label:"));
  assert.ok(ui.includes("supabase.rpc('revoke_print_agent_token', { p_token_id: row.id })"));
  assert.ok(!/localStorage\.setItem\([^)]*token/.test(ui), 'the key itself is never stored in the browser');
  assert.ok(read('../backoffice/sections/PrintRouting.jsx').includes('<PrintAgentKeys S={S} />'));
});
