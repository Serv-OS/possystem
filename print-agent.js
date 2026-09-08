#!/usr/bin/env node
/**
 * Restaurant OS Print Agent v3 (v4.3-aware)
 * =========================================
 * Subscribes to Supabase for print jobs, forwards to printer via TCP.
 *
 * What changed vs v2:
 *   1. ATOMIC CLAIM. Uses the v4.3 WHERE claimed_by IS NULL pattern so the
 *      agent can coexist with PrintOrchestrator on native-bridge devices
 *      without double-printing or losing races.
 *   2. Handles retries. Picks up 'failed' rows whose next_retry_at has
 *      passed, not just 'pending'.
 *   3. Writes 'printed' on success (was 'done'). Supabase query filters
 *      updated to include the full v4.3 vocabulary.
 *   4. Fills processed_at + agent_id + claim_expires_at so PrintOrchestrator
 *      won't reclaim jobs we're mid-dispatch on.
 *
 * Heartbeat + printer_health behaviour unchanged.
 *
 * Setup:
 *   1. npm install @supabase/supabase-js  (one-time)
 *   2. Copy print-agent.env.example -> print-agent.env, fill in keys
 *   3. node print-agent.js
 */

const net  = require('net');
const os   = require('os');
const { randomUUID } = require('crypto');

// Auto-load print-agent.env
try {
  const fs = require('fs'), path = require('path');
  const ef = path.join(__dirname, 'print-agent.env');
  if (fs.existsSync(ef)) {
    fs.readFileSync(ef, 'utf8').split('\n').forEach(l => {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
  }
} catch {}

// Config
const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://tbetcegmszzotrwdtqhi.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
const LOCATION_ID    = process.env.LOCATION_ID  || '';
const PRINTER_PORT   = parseInt(process.env.PRINTER_PORT || '9100');
const POLL_MS        = parseInt(process.env.POLL_MS      || '3000');
const TCP_TIMEOUT    = parseInt(process.env.TCP_TIMEOUT  || '5000');
const HEARTBEAT_MS   = parseInt(process.env.HEARTBEAT_MS || '30000');
const CLAIM_TTL_MS   = parseInt(process.env.CLAIM_TTL_MS || '30000');
const AGENT_VERSION  = '3.0.0';

// Retry schedule must mirror PrintOrchestrator so failure behaviour is consistent
const RETRY_SCHEDULE_MS = [0, 2_000, 10_000, 30_000, 120_000];
const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;

if (!SUPABASE_KEY) {
  console.error('\n  SUPABASE_KEY not set.\n');
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { timeout: 30000 },
});

const AGENT_ID = randomUUID();
const HOSTNAME  = os.hostname();

const knownPrinterIds = new Set();
const inflight = new Set();
// FAST PATH dedup: idempotency_key -> timestamp of broadcast print. When the
// postgres INSERT realtime arrives ~500ms after our broadcast print, we look
// up the key and skip dispatch (the upsert path marked the row done).
const broadcastHandled = new Map();

async function markRowPrinted(jobId) {
  try {
    await supabase.from('print_jobs').update({
      status: 'printed', processed_at: new Date().toISOString(),
      claimed_by: null, claim_expires_at: null, error_message: null,
    }).eq('id', jobId);
  } catch {}
}

// Heartbeat. Errors surfaced (not swallowed) so upsert failures are visible.
let _heartbeatErrLogged = false;
async function sendHeartbeat() {
  if (!LOCATION_ID) {
    if (!_heartbeatErrLogged) {
      console.warn('  heartbeat: skipped, LOCATION_ID not set');
      _heartbeatErrLogged = true;
    }
    return;
  }
  try {
    const { error } = await supabase.from('printer_agents').upsert({
      id:          AGENT_ID,
      location_id: LOCATION_ID,
      hostname:    HOSTNAME,
      version:     AGENT_VERSION,
      last_seen:   new Date().toISOString(),
      printer_ids: [...knownPrinterIds],
      status:      'online',
    }, { onConflict: 'id' });
    if (error && !_heartbeatErrLogged) {
      console.warn('  heartbeat upsert failed:', error.message);
      _heartbeatErrLogged = true;
    }
  } catch (e) {
    if (!_heartbeatErrLogged) {
      console.warn('  heartbeat threw:', e.message);
      _heartbeatErrLogged = true;
    }
  }
}

async function markAgentOffline() {
  if (!LOCATION_ID) return;
  try {
    await supabase.from('printer_agents').upsert({
      id: AGENT_ID, location_id: LOCATION_ID, status: 'offline',
      last_seen: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch {}
}

// Startup self-check: show what's actually in the queue so config issues are
// visible immediately instead of manifesting as silent "no jobs".
async function startupSelfCheck() {
  try {
    const { data: all } = await supabase
      .from('print_jobs')
      .select('location_id, status')
      .in('status', ['pending', 'failed', 'claimed', 'sending'])
      .limit(500);

    if (!all) { console.log('  self-check: no data returned'); return; }

    const byLoc = {};
    all.forEach(r => {
      byLoc[r.location_id] = byLoc[r.location_id] || { pending: 0, failed: 0, claimed: 0, sending: 0 };
      byLoc[r.location_id][r.status] = (byLoc[r.location_id][r.status] || 0) + 1;
    });

    const locs = Object.keys(byLoc);
    if (locs.length === 0) {
      console.log('  self-check: queue is empty, no pending or in-flight jobs anywhere');
    } else {
      console.log('  self-check: current queue state by location:');
      for (const loc of locs) {
        const s = byLoc[loc];
        const hit = !LOCATION_ID || loc === LOCATION_ID;
        const marker = hit ? '[MATCH]' : '[skip ]';
        console.log(`    ${marker} ${loc}  pending=${s.pending||0} failed=${s.failed||0} claimed=${s.claimed||0} sending=${s.sending||0}`);
      }
      if (LOCATION_ID && !locs.includes(LOCATION_ID)) {
        console.warn(`  WARNING: LOCATION_ID ${LOCATION_ID} has zero active jobs. Is this the right location?`);
      }
    }
  } catch (e) {
    console.warn('  self-check failed:', e.message);
  }
}

async function updatePrinterHealth(printerId, status, error = null) {
  if (!LOCATION_ID || !printerId) return;
  try {
    const now = new Date().toISOString();
    const patch = {
      printer_id:  printerId,
      location_id: LOCATION_ID,
      status,
      last_job_at: now,
      updated_at:  now,
    };
    if (status === 'online') {
      patch.last_success_at = now;
      patch.consecutive_failures = 0;
    } else {
      patch.last_error_at = now;
      patch.last_error = error || 'Unknown error';
      const { data: cur } = await supabase
        .from('printer_health')
        .select('consecutive_failures')
        .eq('printer_id', printerId)
        .maybeSingle()
        .catch(() => ({ data: null }));
      patch.consecutive_failures = (cur?.consecutive_failures || 0) + 1;
    }
    await supabase.from('printer_health').upsert(patch, { onConflict: 'printer_id' });
  } catch {}
}

function printTCP(ip, port, bytes) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer  = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP timeout (${TCP_TIMEOUT}ms) to ${ip}:${port}`));
    }, TCP_TIMEOUT);
    socket.connect(port, ip, () => {
      socket.write(Buffer.from(bytes), err => {
        if (err) { clearTimeout(timer); socket.destroy(); return reject(err); }
        setTimeout(() => { clearTimeout(timer); socket.destroy(); resolve(); }, 200);
      });
    });
    socket.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

async function atomicClaim(jobId) {
  const claimExpires = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from('print_jobs')
    .update({
      claimed_by:       AGENT_ID,
      claimed_at:       new Date().toISOString(),
      claim_expires_at: claimExpires,
      status:           'claimed',
    })
    .eq('id', jobId)
    .is('claimed_by', null)
    .in('status', ['pending', 'failed'])
    .select()
    .single();
  if (error || !data) return null;
  return data;
}

async function processClaimedJob(job) {
  const ip        = job.printer_ip;
  const port      = job.printer_port || PRINTER_PORT;
  const printerId = job.printer_id;
  const shortId   = String(job.id).slice(0, 8);
  const attempts  = (job.attempts || 0) + 1;

  if (printerId) knownPrinterIds.add(printerId);

  if (!ip) {
    await recordFailure(job, attempts, 'No printer IP configured');
    console.error(`  [${shortId}] no printer IP, attempt ${attempts}/${MAX_ATTEMPTS}`);
    return;
  }

  let bytes;
  try { bytes = Buffer.from(job.payload, 'base64'); }
  catch { await recordFailure(job, attempts, 'Invalid payload (base64 decode failed)'); return; }

  try {
    await supabase.from('print_jobs').update({ status: 'sending', attempts }).eq('id', job.id);
  } catch {}

  try {
    await printTCP(ip, port, bytes);
    await supabase.from('print_jobs').update({
      status: 'printed', processed_at: new Date().toISOString(), agent_id: AGENT_ID,
      claimed_by: null, claim_expires_at: null, error_message: null,
    }).eq('id', job.id);
    await updatePrinterHealth(printerId, 'online');
    console.log(`  [${shortId}] ok ${bytes.length}b -> ${ip}:${port} (${job.job_type}, attempt ${attempts})`);
  } catch (err) {
    const msg = err.message || 'TCP failure';
    await recordFailure(job, attempts, msg);
    await updatePrinterHealth(printerId, 'error', msg);
    console.error(`  [${shortId}] fail attempt ${attempts}/${MAX_ATTEMPTS}: ${msg}`);
  }
}

async function recordFailure(job, attempts, errMsg) {
  if (attempts >= MAX_ATTEMPTS) {
    await supabase.from('print_jobs').update({
      status: 'failed_permanent', attempts, error_message: errMsg, error: errMsg,
      agent_id: AGENT_ID, claimed_by: null, claim_expires_at: null,
      processed_at: new Date().toISOString(),
    }).eq('id', job.id);
    return;
  }
  const delayMs = RETRY_SCHEDULE_MS[attempts] ?? RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1];
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  await supabase.from('print_jobs').update({
    status: 'failed', attempts, error_message: errMsg, error: errMsg,
    agent_id: AGENT_ID, next_retry_at: nextRetryAt,
    claimed_by: null, claim_expires_at: null,
  }).eq('id', job.id);
}

async function claimAndDispatch(jobId) {
  if (inflight.has(jobId)) return;
  inflight.add(jobId);
  try {
    const claimed = await atomicClaim(jobId);
    if (!claimed) return;
    await processClaimedJob(claimed);
  } finally { inflight.delete(jobId); }
}

async function drainEligible() {
  const nowIso = new Date().toISOString();
  let q = supabase.from('print_jobs')
    .select('id, status, next_retry_at, created_at')
    .is('claimed_by', null)
    .in('status', ['pending', 'failed'])
    .or(`status.eq.pending,and(status.eq.failed,next_retry_at.lte.${nowIso})`)
    .order('created_at', { ascending: true })
    .limit(20);
  if (LOCATION_ID) q = q.eq('location_id', LOCATION_ID);
  const { data, error } = await q;
  if (error) { console.error('  drain error:', error.message); return; }
  if (data?.length) {
    console.log(`  draining ${data.length} eligible job(s)`);
    for (const j of data) await claimAndDispatch(j.id);
  }
}

async function main() {
  console.log('\n  Restaurant OS Print Agent v3 (v4.3-aware)');
  console.log('  -----------------------------------------');
  console.log(`  Supabase:  ${SUPABASE_URL}`);
  console.log(`  Location:  ${LOCATION_ID || 'all locations'}`);
  console.log(`  Agent ID:  ${AGENT_ID.slice(0, 8)}...`);
  console.log(`  Hostname:  ${HOSTNAME}`);
  console.log(`  Heartbeat: every ${HEARTBEAT_MS / 1000}s`);
  console.log(`  Poll:      every ${POLL_MS / 1000}s`);
  console.log('\n  Outbound only. Waiting for jobs...\n');

  await sendHeartbeat();
  await startupSelfCheck();
  await drainEligible();

  const channel = supabase
    .channel('print-jobs-agent-v3')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'print_jobs',
      ...(LOCATION_ID ? { filter: `location_id=eq.${LOCATION_ID}` } : {}),
    }, payload => {
      const job = payload.new;
      if (!job || job.status !== 'pending') return;
      // FAST PATH dedup: if we already printed this via the broadcast channel,
      // skip the dispatch and just mark the row as printed.
      if (job.idempotency_key && broadcastHandled.has(job.idempotency_key)) {
        markRowPrinted(job.id).catch(() => {});
        return;
      }
      claimAndDispatch(job.id);
    })
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'print_jobs',
      ...(LOCATION_ID ? { filter: `location_id=eq.${LOCATION_ID}` } : {}),
    }, payload => {
      const job = payload.new;
      if (!job) return;
      if (job.claimed_by) return;
      if (job.status === 'pending') { claimAndDispatch(job.id); return; }
      if (job.status === 'failed' && job.next_retry_at) {
        const readyAt = new Date(job.next_retry_at).getTime();
        const delay = Math.max(0, readyAt - Date.now());
        setTimeout(() => claimAndDispatch(job.id), delay);
      }
    })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') console.log('  realtime subscribed\n');
      if (status === 'CLOSED')     console.log('  realtime closed, polling only');
    });

  // FAST PATH — broadcast channel. The web app fires a Supabase Realtime
  // broadcast with the print bytes embedded the moment a server taps Print.
  // We dispatch immediately on receipt — no postgres write, no realtime
  // fanout from logical replication, no claim round-trip. End-to-end ~250ms
  // vs 2-9s for the postgres path.
  if (LOCATION_ID) {
    const fastChannel = supabase
      .channel(`print-fast:${LOCATION_ID}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'print' }, async ({ payload }) => {
        if (!payload || !payload.idempotency_key) return;
        const key = payload.idempotency_key;
        if (broadcastHandled.has(key)) return;
        broadcastHandled.set(key, Date.now());
        const ip   = payload.printer_ip;
        const port = payload.printer_port || PRINTER_PORT;
        const shortId = key.slice(0, 8);
        if (!ip) {
          console.warn(`  [fast ${shortId}] no printer IP in broadcast payload, falling back to postgres`);
          broadcastHandled.delete(key);
          return;
        }
        let bytes;
        try { bytes = Buffer.from(payload.payload_b64 || '', 'base64'); }
        catch {
          console.warn(`  [fast ${shortId}] bad base64 payload`);
          broadcastHandled.delete(key);
          return;
        }
        const t0 = Date.now();
        try {
          await printTCP(ip, port, bytes);
          const elapsed = Date.now() - t0;
          console.log(`  [fast ${shortId}] ok ${bytes.length}b -> ${ip}:${port} in ${elapsed}ms`);
          // Upsert audit row to status='printed'. ON CONFLICT (idempotency_key)
          // means whether the web app's INSERT or this upsert lands first,
          // the row ends up consistent.
          supabase.from('print_jobs').upsert({
            location_id:     payload.location_id,
            printer_id:      payload.printer_id,
            printer_ip:      payload.printer_ip,
            printer_port:    payload.printer_port,
            job_type:        payload.job_type || 'receipt',
            payload:         payload.payload_b64,
            status:          'printed',
            idempotency_key: key,
            processed_at:    new Date().toISOString(),
            attempts:        1,
            agent_id:        AGENT_ID,
            metadata:        payload.metadata || null,
          }, { onConflict: 'idempotency_key' }).then(() => {}, (e) => {
            console.warn(`  [fast ${shortId}] audit upsert failed: ${e?.message}`);
          });
          updatePrinterHealth(payload.printer_id, 'online').catch(() => {});
        } catch (err) {
          console.error(`  [fast ${shortId}] tcp failed: ${err.message} — postgres path will retry`);
          broadcastHandled.delete(key);
          updatePrinterHealth(payload.printer_id, 'error', err.message).catch(() => {});
        }
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') console.log('  fast-path broadcast subscribed\n');
      });

    // Periodic prune so the dedup map can't grow unbounded
    setInterval(() => {
      const cutoff = Date.now() - 5 * 60_000;
      for (const [k, ts] of broadcastHandled) {
        if (ts < cutoff) broadcastHandled.delete(k);
      }
    }, 60_000);
  }

  setInterval(drainEligible, POLL_MS);
  setInterval(() => { _heartbeatErrLogged = false; sendHeartbeat(); }, HEARTBEAT_MS);

  const shutdown = async (sig) => {
    console.log(`\n  ${sig} received, shutting down...`);
    await markAgentOffline();
    supabase.removeChannel(channel);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
