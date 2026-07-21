// supabase/functions/terminal-job-create
//
// PaxPay mode 3: the POS sends a payment job to a specific PAX terminal.
//
// WHY AN EDGE FUNCTION AND NOT AN RPC / RLS INSERT
//   terminal_jobs has NO insert policy — an anonymous kiosk/QR/online session
//   holds a valid auth.uid(), so an insert policy would be unbounded public write
//   access to a payments table. The insert therefore happens here, under the
//   service role, behind an explicit fence.
//
// THE FENCE (in this order — do not reorder)
//   1. A bearer token is required.
//   2. The TARGET TERMINAL row is loaded first, and location_id is taken FROM
//      THAT ROW. The body's location_id is only ever cross-checked, never used.
//      A lying client therefore cannot land a job at a venue it doesn't own.
//   3. The caller must additionally be either
//        (a) a signed-in user with user_locations access to that location, or
//        (b) a paired POS/kiosk device at that location (devices.device_uid =
//            caller.id) — the POS runs on an anonymous session.
//      Neither ⇒ 403.
//
// MONEY
//   The POS is the pricing engine, so tip_basis_minor / due_minor come from it —
//   but both are re-validated as non-negative bigints, due_minor > 0, and the
//   DB's own CHECK constraints (due_minor > 0, charge = due + tip) are the
//   backstop. charge_minor is NEVER accepted from the client; it is written
//   server-side by terminal_commit_tip once the tip settles.
//
// IDEMPOTENCY
//   The job id is minted by the POS before any network call. idx_tj_one_live_per_check
//   makes a second live job for the same check_key impossible; on 23505 we return
//   the EXISTING row rather than erroring, so a double-press / remount / refresh
//   re-attaches instead of double-charging. Only 23505 is treated that way —
//   every other error surfaces (spec money-safety rule 3 / rule 14).
//
// Spec: docs/PAXPAY_TRANSPORT_SPEC.md

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

const LIVE = ['pending', 'claimed', 'tipping', 'charging_unsent', 'charging', 'unknown'];

/** Whole non-negative integer, or null. Rejects floats, NaN, strings, Infinity. */
function minor(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) return null;
  if (v > 100_000_000) return null;   // £1,000,000 ceiling — a sanity stop, not a business rule
  return v;
}

interface Body {
  job_id?: string;
  check_key?: string;
  target_terminal_id?: string;
  location_id?: string;         // cross-checked only — never trusted
  pos_device_id?: string;
  tip_basis_minor?: number;
  due_minor?: number;
  currency?: string;
  tip_config?: Record<string, unknown>;
  closed_check_id?: string;
  check_draft?: Record<string, unknown>;
  training?: boolean;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);

  let caller: { id: string } | null = null;
  let isServiceRole = false;
  if (token === SERVICE_ROLE) {
    isServiceRole = true;
  } else {
    try {
      const { data } = await opsAdmin.auth.getUser(token);
      caller = data?.user ? { id: data.user.id } : null;
    } catch { caller = null; }
    if (!caller) return json({ error: 'unauthorized' }, 401);
  }

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const {
    job_id, check_key, target_terminal_id, pos_device_id,
    closed_check_id, check_draft, tip_config,
  } = body;

  if (!job_id || !check_key || !target_terminal_id || !closed_check_id || !check_draft) {
    return json({ error: 'job_id, check_key, target_terminal_id, closed_check_id and check_draft are required' }, 400);
  }

  const tipBasis = minor(body.tip_basis_minor);
  const due = minor(body.due_minor);
  if (tipBasis === null) return json({ error: 'tip_basis_minor must be a whole number of minor units' }, 400);
  if (due === null || due <= 0) {
    // due_minor > 0 is also a CHECK constraint — a fully gift-carded check can
    // never create a job, because there is nothing for the card to take.
    return json({ error: 'due_minor must be a whole number of minor units greater than zero' }, 400);
  }

  // ── 1. The terminal row IS the location authority ──────────────────────────
  const { data: term, error: termErr } = await opsAdmin
    .from('terminal_devices')
    .select('id, location_id, status, active, label')
    .eq('id', target_terminal_id)
    .maybeSingle();
  if (termErr) return json({ error: termErr.message }, 500);
  if (!term) return json({ error: 'terminal not found' }, 404);
  if (term.status !== 'paired' || !term.active) return json({ error: 'terminal is not paired' }, 409);
  if (!term.location_id) return json({ error: 'terminal has no location' }, 409);

  const locationId: string = term.location_id;   // SERVER-resolved. The body's value is never used.
  if (body.location_id && body.location_id !== locationId) {
    return json({ error: 'terminal belongs to a different location' }, 403);
  }

  // ── 2. Caller fence ────────────────────────────────────────────────────────
  if (!isServiceRole && caller) {
    const [{ data: ul }, { data: prof }, { data: dev }] = await Promise.all([
      opsAdmin.from('user_locations').select('location_id')
        .eq('user_id', caller.id).eq('location_id', locationId).maybeSingle(),
      opsAdmin.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
      opsAdmin.from('devices').select('id')
        .eq('device_uid', caller.id).eq('location_id', locationId).limit(1).maybeSingle(),
    ]);
    if (!ul && prof?.role !== 'super_admin' && !dev) {
      return json({ error: 'no access to this location' }, 403);
    }
  }

  // ── 3. Training mode — resolved SERVER-side from the dispatching device ────
  // A training till must never dispatch a real charge to a real terminal. The
  // client's own flag is honoured when set (the POS gates before it ever gets
  // here) but it can only ever make the job MORE restrictive, never less.
  // training_mode lives on device_profiles (20260628_device_training_mode.sql);
  // devices.profile_id is the link.
  let training = body.training === true;
  if (pos_device_id) {
    const { data: posDev } = await opsAdmin
      .from('devices').select('id, device_profiles(training_mode)').eq('id', pos_device_id).maybeSingle();
    const prof = (posDev as any)?.device_profiles;
    const flag = Array.isArray(prof) ? prof[0]?.training_mode : prof?.training_mode;
    if (flag === true) training = true;
  }
  if (training) {
    return json({
      error: 'training mode — this till cannot dispatch a payment to a card terminal',
      training: true,
    }, 409);
  }

  // ── 4. Insert. On 23505 return the EXISTING live job for this check ────────
  const row = {
    id: job_id,
    check_key,
    location_id: locationId,
    target_terminal_id,
    pos_device_id: pos_device_id ?? null,
    training: false,
    tip_basis_minor: tipBasis,
    due_minor: due,
    currency: String(body.currency || 'GBP').toUpperCase().slice(0, 3),
    tip_config: tip_config ?? { enabled: false },
    closed_check_id,
    check_draft,
    status: 'pending',
    processor: 'ryft',
    claim_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    dispatched_at: new Date().toISOString(),
  };

  const { data: inserted, error: insErr } = await opsAdmin
    .from('terminal_jobs').insert(row).select().maybeSingle();

  if (!insErr && inserted) return json({ ok: true, job: inserted, existing: false });

  // ONLY a unique violation means "already recorded". Anything else is a real
  // failure and must surface — collapsing the two is how a caller comes to
  // believe a write landed when no row exists.
  if (insErr && insErr.code === '23505') {
    const { data: existing } = await opsAdmin
      .from('terminal_jobs').select('*')
      .or(`id.eq.${job_id},check_key.eq.${check_key}`)
      .in('status', LIVE)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    if (existing) return json({ ok: true, job: existing, existing: true });
    return json({ error: 'a conflicting job exists but could not be read back', code: '23505' }, 409);
  }

  return json({ error: insErr?.message ?? 'insert failed', code: insErr?.code ?? null }, 500);
});
