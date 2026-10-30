// supabase/functions/terminal-job-cancel
//
// The POS's "cancel this terminal payment" for a job that has NOT reached the reader.
//
// FLOW
//   1. Run terminal_job_cancel AS THE CALLER (its own fence: a device at the job's
//      location, or a BO user). Pre-charge (pending/claimed/tipping) → 'cancelled',
//      done. A raise means "no access" → 401/403. The kiosk uses this path.
//   2. The RPC refuses once charged_at is set. A LIVE card prompt is not cancelled
//      here: the till and the kiosk abort an Adyen job on the reader itself through
//      adyen-terminal-charge ('abort'), which settles from the reader's own verdict.
//      This function answers a plain 409 so a caller never believes a live prompt
//      was called off when nothing reached the reader.
//
// 29 Oct 2026 (Drop D): ServOS works with Adyen only. The Ryft void branch that used
// to live here (cancelTerminalAction + session verdict) is gone with the processor.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SETTLED = ['approved', 'declined', 'cancelled', 'expired', 'reconciled'];
const settledState = (s: string) => (s === 'reconciled' ? 'approved' : s === 'expired' ? 'cancelled' : s);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);

  let body: { job_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const jobId = String(body.job_id ?? '');
  if (!jobId) return json({ error: 'job_id required' }, 400);

  // ── 1. Fenced pre-charge cancel, AS THE CALLER ──────────────────────────────
  // terminal_job_cancel raises on no-access and, for a not-yet-charging job,
  // flips it to 'cancelled'. Delegating the fence here means we never diverge from
  // the RPC's own auth rules (device at the location, or a BO user).
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: rpcRes, error: rpcErr } = await caller.rpc('terminal_job_cancel', { p_job_id: jobId });
  if (rpcErr) {
    const msg = rpcErr.message || 'cancel failed';
    const code = /no session/i.test(msg) ? 401 : /no access/i.test(msg) ? 403 : 400;
    return json({ error: msg }, code);
  }
  // ok:true → pre-charge, cancelled cleanly, nothing ever reached the reader.
  if (rpcRes?.ok) return json({ ok: true, state: 'cancelled', status: 'cancelled', phase: 'pre_charge' });

  // The caller is authorised (the RPC didn't raise) but the job is LIVE or settled.
  const { data: job, error: jobErr } = await opsAdmin
    .from('terminal_jobs').select('id, status').eq('id', jobId).maybeSingle();
  if (jobErr) return json({ error: jobErr.message }, 500);
  if (!job) return json({ error: 'job not found' }, 404);

  // Already resolved — report it, never re-settle.
  if (SETTLED.includes(job.status)) {
    const st = settledState(job.status);
    return json({ ok: true, state: st, status: st, job_status: job.status, phase: 'already_settled' });
  }

  // ── 2. Live: the reader owns the cancel ─────────────────────────────────────
  return json({
    ok: false,
    code: 'LIVE_ON_READER',
    job_status: job.status,
    error: 'a live card prompt is cancelled on the reader',
  }, 409);
});
