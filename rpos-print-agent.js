#!/usr/bin/env node
/**
 * Restaurant OS — Standalone Print Agent
 *
 * Zero dependencies. Just run: node rpos-print-agent.js
 *
 * This script:
 *   1. Polls Supabase every 2 seconds for pending print jobs
 *   2. Sends ESC/POS bytes to the printer via TCP port 9100
 *   3. Marks jobs complete in Supabase
 *
 * Requirements: Node.js 18+ (for built-in fetch)
 * No npm install needed.
 *
 * Database fence stage 1 (contract G2):
 *   - The public key is read from the environment (SUPABASE_KEY or SUPABASE_ANON_KEY). It used
 *     to be written in this file, in git (INVARIANTS: the anon key never appears in git).
 *   - With PRINT_AGENT_TOKEN (Back Office, Production printing, "Print agent key") the agent
 *     claims and reports jobs through print_agent_claim / print_agent_report, which is the only
 *     way in once 20260919b closes print_jobs to the bare key.
 *   - FENCE STAGE 1 FALLBACK: without a key, or while those functions do not exist, it polls
 *     print_jobs directly as before. Remove that mode once 20260919b has run.
 *
 * Environment: SUPABASE_URL (optional), SUPABASE_KEY, PRINT_AGENT_TOKEN, LOCATION_ID (legacy
 * mode filter and logs only).
 */

'use strict';
const net = require('net');
const { randomUUID } = require('crypto');

// ─── Config (from the environment) ───────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://tbetcegmszzotrwdtqhi.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
const LOCATION_ID   = process.env.LOCATION_ID || '';
const TOKEN         = process.env.PRINT_AGENT_TOKEN || '';
const POLL_MS       = 2000;  // check for jobs every 2 seconds
const AGENT_ID      = 'rpos-' + randomUUID();

if (!SUPABASE_KEY) {
  console.error('\n  SUPABASE_KEY not set. Run: SUPABASE_KEY=<anon public key> PRINT_AGENT_TOKEN=<key from Back Office> node rpos-print-agent.js\n');
  process.exit(1);
}
let tokenMode = !!TOKEN;

// ─── Send bytes to printer via TCP ───────────────────────────────────────────
function sendToPrinter(ip, port, bytes) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer  = setTimeout(() => { socket.destroy(); reject(new Error('Timeout')); }, 8000);

    socket.connect(port || 9100, ip, () => {
      socket.write(Buffer.from(bytes), err => {
        if (err) { clearTimeout(timer); socket.destroy(); reject(err); return; }
        setTimeout(() => { clearTimeout(timer); socket.destroy(); resolve(); }, 200);
      });
    });
    socket.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ─── Supabase helpers (using native fetch, no SDK) ───────────────────────────
const headers = {
  'apikey':        SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type':  'application/json',
  'Prefer':        'return=minimal',
};

async function rpc(name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.message) || `rpc ${name} failed: ${res.status}`);
    err.code = data && data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}
const isMissingRpc = (e) => !!e && (e.code === 'PGRST202' || e.code === '42883' || /could not find the function/i.test(String(e.message || '')));

async function getPendingJobs() {
  if (tokenMode) {
    try {
      const data = await rpc('print_agent_claim', { p_token: TOKEN, p_agent_id: AGENT_ID, p_limit: 5, p_claim_seconds: 60 });
      if (!data || data.ok !== true) {
        if (data && data.reason === 'bad_key') console.error('  PRINT_AGENT_TOKEN was refused (revoked or wrong). Issue a new key in Back Office.');
        return [];
      }
      return Array.isArray(data.jobs) ? data.jobs : [];
    } catch (e) {
      if (!isMissingRpc(e)) throw e;
      console.warn('  print_agent_claim does not exist yet: running without the key (legacy mode)');
      tokenMode = false;
    }
  }
  // FENCE STAGE 1 FALLBACK: the direct read. It needs the venue (it used to be written in this
  // file): without LOCATION_ID it would print every venue's jobs, so it prints nothing.
  if (!LOCATION_ID) {
    if (!getPendingJobs._warned) { console.error('  LOCATION_ID not set: set it, or give the agent a PRINT_AGENT_TOKEN.'); getPendingJobs._warned = true; }
    return [];
  }
  const url = `${SUPABASE_URL}/rest/v1/print_jobs?status=eq.pending&order=created_at.asc&limit=5&location_id=eq.${LOCATION_ID}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
  return res.json();
}

async function updateJob(id, status, error, attempts = null) {
  if (tokenMode) {
    // The report function knows 'sending', 'printed', 'failed' and 'failed_permanent'. A failed
    // job is tried again in 30 s, and given up after 5 tries (the claim would retry it at once).
    let mapped = status === 'printing' ? 'sending' : status === 'done' ? 'printed' : status;
    if (mapped === 'failed' && attempts != null && attempts >= 5) mapped = 'failed_permanent';
    try {
      await rpc('print_agent_report', {
        p_token: TOKEN, p_job_id: id, p_agent_id: AGENT_ID, p_status: mapped,
        p_attempts: attempts, p_error: error ? String(error).slice(0, 500) : null,
        p_next_retry_at: mapped === 'failed' ? new Date(Date.now() + 30000).toISOString() : null,
      });
    } catch (e) { console.warn(`    report failed: ${e.message}`); }
    return;
  }
  // FENCE STAGE 1 FALLBACK: the direct update.
  const body = { status };
  if (error)            body.error      = String(error).slice(0, 500);
  if (status === 'done') body.printed_at = new Date().toISOString();

  await fetch(`${SUPABASE_URL}/rest/v1/print_jobs?id=eq.${id}`, {
    method:  'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body:    JSON.stringify(body),
  });
}

// ─── Process a single job ─────────────────────────────────────────────────────
async function processJob(job) {
  const { id, printer_ip, printer_port, payload, job_type } = job;
  const attempts = (Number(job.attempts) || 0) + 1;
  console.log(`  → Job ${String(id).slice(0,8)}… [${job_type}] to ${printer_ip}`);

  if (!printer_ip) {
    await updateJob(id, 'failed', 'No printer IP on job', attempts);
    console.log('    ✗ No printer IP');
    return;
  }

  try {
    await updateJob(id, 'printing', null, attempts);
    const bytes = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
    await sendToPrinter(printer_ip, printer_port || 9100, bytes);
    await updateJob(id, 'done', null, attempts);
    console.log('    ✓ Printed');
  } catch (err) {
    await updateJob(id, 'failed', err.message, attempts);
    console.log(`    ✗ Failed: ${err.message}`);
  }
}

// ─── Main poll loop ───────────────────────────────────────────────────────────
let running = false;

async function poll() {
  if (running) return;
  running = true;
  try {
    const jobs = await getPendingJobs();
    for (const job of jobs) {
      await processJob(job);
    }
  } catch (err) {
    console.error(`  Poll error: ${err.message}`);
  }
  running = false;
}

console.log('');
console.log('  🖨  Restaurant OS Print Agent (standalone)');
console.log('  ──────────────────────────────────────────');
console.log(`  Project:    ${SUPABASE_URL.split('//')[1].split('.')[0]}`);
console.log(`  Location:   ${LOCATION_ID || '(from the key)'}`);
console.log(`  Mode:       ${tokenMode ? 'venue key' : 'legacy (no PRINT_AGENT_TOKEN)'}`);
console.log(`  Polling:    every ${POLL_MS / 1000}s`);
console.log('');
console.log('  Waiting for print jobs... (Ctrl+C to stop)');
console.log('');

poll(); // immediate first poll
setInterval(poll, POLL_MS);
