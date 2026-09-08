// supabase/functions/terminal-job-status
//
// The POS's READ path for a terminal job. Deliberately not RLS.
//
// terminal_jobs has a SELECT policy for the target terminal and one for Back
// Office users, but NOT one for the POS till. pos_can_access() depends on
// devices.device_uid, which claim_device() stamps best-effort and both call
// sites swallow the failure. A till whose claim silently failed would dispatch a
// job fine and then be unable to read it back — waiting forever on a card that
// was already charged. So the POS reads through here, authorised exactly the way
// terminal-job-create authorises.
//
//   POST { job_id }                    → one job
//   POST { job_ids: [...] }            → several (boot reconciler)
//   POST { location_id, needs_human }  → the human queue for a venue (BO screen)
//
// Read-only. This function never writes and never charges.
//
// Spec: docs/PAXPAY_TRANSPORT_SPEC.md § "Files to change" (D6).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Card PANs never exist here (the processor returns brand/last4 only), but be
// explicit about what leaves the server anyway.
const COLS = 'id, check_key, location_id, target_terminal_id, pos_device_id, training,'
  + ' tip_basis_minor, due_minor, tip_minor, charge_minor, reported_minor, currency,'
  + ' tip_config, closed_check_id, check_draft, status, processor, transaction_id,'
  + ' auth_code, card, decline_reason, simulated, needs_human, last_error,'
  + ' acknowledged_total_minor,'
  + ' created_at, dispatched_at, charged_at, settled_at, updated_at';

/** Can this caller see jobs at this location? Same fence as terminal-job-create. */
async function canRead(callerId: string, locationId: string): Promise<boolean> {
  const [{ data: ul }, { data: prof }, { data: dev }] = await Promise.all([
    opsAdmin.from('user_locations').select('location_id')
      .eq('user_id', callerId).eq('location_id', locationId).maybeSingle(),
    opsAdmin.from('user_profiles').select('role').eq('id', callerId).maybeSingle(),
    opsAdmin.from('devices').select('id')
      .eq('device_uid', callerId).eq('location_id', locationId).limit(1).maybeSingle(),
  ]);
  return !!ul || prof?.role === 'super_admin' || !!dev;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);

  let callerId: string | null = null;
  const isServiceRole = token === SERVICE_ROLE;
  if (!isServiceRole) {
    try {
      const { data } = await opsAdmin.auth.getUser(token);
      callerId = data?.user?.id ?? null;
    } catch { callerId = null; }
    if (!callerId) return json({ error: 'unauthorized' }, 401);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const ids: string[] = body?.job_id ? [body.job_id]
    : Array.isArray(body?.job_ids) ? body.job_ids.filter((x: unknown) => typeof x === 'string').slice(0, 50)
    : [];

  // ── by id(s) ───────────────────────────────────────────────────────────────
  if (ids.length) {
    const { data, error } = await opsAdmin.from('terminal_jobs').select(COLS).in('id', ids);
    if (error) return json({ error: error.message }, 500);
    const rows = data ?? [];
    if (!rows.length) return json({ jobs: [] });

    if (!isServiceRole && callerId) {
      // Authorise per location, once each — a batch must not leak a job from a
      // venue the caller has no access to.
      const locs = [...new Set(rows.map((r: any) => r.location_id))];
      const allowed = new Set<string>();
      for (const loc of locs) if (await canRead(callerId, loc)) allowed.add(loc);
      const visible = rows.filter((r: any) => allowed.has(r.location_id));
      if (!visible.length) return json({ error: 'no access to these jobs' }, 403);
      return json({ jobs: visible });
    }
    return json({ jobs: rows });
  }

  // ── the human queue for a venue ────────────────────────────────────────────
  const locationId: string | undefined = body?.location_id;
  if (!locationId) return json({ error: 'job_id, job_ids or location_id required' }, 400);
  if (!isServiceRole && callerId && !(await canRead(callerId, locationId))) {
    return json({ error: 'no access to this location' }, 403);
  }

  let q = opsAdmin.from('terminal_jobs').select(COLS).eq('location_id', locationId);
  if (body?.needs_human === true) q = q.eq('needs_human', true);
  if (Array.isArray(body?.statuses) && body.statuses.length) q = q.in('status', body.statuses.slice(0, 12));
  const { data, error } = await q.order('created_at', { ascending: false }).limit(Math.min(Number(body?.limit) || 100, 200));
  if (error) return json({ error: error.message }, 500);

  let jobs = data ?? [];

  // v5.6.70 — a PARTIAL on-reader split leg must NEVER reach a reconciler.
  // It is captured money with no check of its own: the FINAL leg of the split
  // books one check for the whole occupation (draft.priorLegs). The client has
  // the same guard, but the client is exactly what cannot be trusted here — a
  // till on a stale bundle (the documented Sunmi WebView failure mode) would
  // otherwise book the part payment as a full close and clear a live table
  // mid-meal. The queue-inspection paths (needs_human / explicit job_ids) still
  // return them so a manager can always SEE the money.
  if (!body?.needs_human && Array.isArray(body?.statuses) && body.statuses.includes('approved')) {
    jobs = jobs.filter((j: any) => j?.check_draft?.partial !== true);
  }

  // v5.5.846: attach the CURRENT server-side bill so the POS reconciler can refuse to
  // close a Table-Pay job whose live total moved after the terminal froze its amount.
  // Runs under service role (reading active_sessions is already authorised here), so
  // this exposes no new payments-read surface — it is exactly the figure the till
  // itself would compute. Matched on the SAME occupation (session id): a re-seat mints
  // a new session whose total is a different bill, so a stale row never masquerades as
  // the live one. No live match → null → the reconciler closes from the frozen draft.
  if (jobs.length && Array.isArray(body?.statuses) && body.statuses.includes('approved')) {
    const tableIds = [...new Set(
      jobs.map((j: any) => j?.check_draft?.tableId).filter(Boolean),
    )];
    if (tableIds.length) {
      const { data: sess } = await opsAdmin.from('active_sessions')
        .select('table_id, session, total_minor')
        .eq('location_id', locationId)
        .in('table_id', tableIds as string[]);
      const byTable = new Map((sess ?? []).map((r: any) => [r.table_id, r]));
      for (const j of jobs as any[]) {
        const row = j?.check_draft?.tableId ? byTable.get(j.check_draft.tableId) : null;
        j.live_total_minor =
          (row && String(row.session?.id) === String(j?.check_draft?.sessionId))
            ? row.total_minor
            : null;
      }
    }
  }

  return json({ jobs });
});
