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
// TIP CONFIG (v5.5.841)
//   NOT accepted from the client any more. Resolved here from the TARGET
//   TERMINAL'S OWN terminal_devices.tip_config — the value Back Office writes and
//   the operator can see — and normalised into both spellings the terminal parses.
//   See the block above `readBands` for the bug this replaces.
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
import { readTipOnReceipt } from '../_shared/tip_capture.ts';
import { shouldServerKick, clientOwnsCreateKick } from '../_shared/terminalKick.js';

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

// ═══════════════════════════════════════════════════════════════════════════════
// THE SERVER KICKS TOO (9 Sep 2026 incident, live venue, first in-person live card)
//
// An Adyen cloud job is born charging_unsent with charge_minor stamped, and until
// now ONLY the till followed it up with adyen-terminal-charge 'start'. The till
// never did (a Sunmi WebView on a stale bundle: the documented trap), so the
// reader was never asked and the job sat charging_unsent, nexo_service_id null,
// until the sweeper cancelled it. Same class as 19 Aug (v5.6.86 / v5.6.88).
//
// So the kick is now the SERVER'S responsibility as well. After the response
// below is committed, this function fires the same 'start' request that
// adyen-terminal-events uses for pay-at-table wake-ups (service-role bearer,
// {action:'start', job_id}) under EdgeRuntime.waitUntil. The fn's CAS
// (charging_unsent -> charging) makes the till's own kick and this one
// harmless duplicates: exactly one initiator ever reaches the reader.
//
// TIMING. The kick waits SERVER_KICK_GRACE_MS first. Two reasons:
//   1. the response to the till must be on the wire before anything else
//      happens (the till's UI keys off it), and
//   2. a fresh till kicks within a few hundred ms of that response. Letting it
//      win keeps today's behaviour for every up-to-date till, and keeps a
//      HALF-stale till (one that surfaces kickError but does not yet know the
//      IN_FLIGHT code) from seeing its own kick lose the CAS and printing
//      "could not reach the card machine" over a reader that is showing the
//      card prompt. A fully stale till never kicks at all, and for it 1.5s of
//      extra latency is the difference between a sale and a stranded job.
//
// NEVER for a job the device drives itself over the local nexo bridge (MPOS on
// an Adyen Android terminal, v5.6.81): there the cloud 'start' is a RACE for the
// same CAS, not a duplicate. shouldServerKick() refuses on the request's
// local_bridge flag, on the draft source only that flow writes, and on the
// terminal row and POS device row sharing one auth uid, so a stale MPOS bundle
// that never learned the flag is still recognised.
//
// NOR for the MPOS CLOUD flow (draft source 'mpos_cloud_terminal', v5.8.23).
// That client kicks 'start' itself within a few hundred ms of this response,
// and the bundles in the field (v5.8.23 to v5.8.44) treat a lost CAS as a
// failure: forgetJob + throw while the reader shows the prompt the server's
// kick put up. The customer taps, the job settles approved with no handle on
// the device, a retry mints a fresh id (the approved job is not LIVE, so
// idx_tj_one_live_per_check does not fire) and a SECOND prompt goes up for the
// same bill: the v5.5.844 class. clientOwnsCreateKick() refuses the create-time
// kick for that source. The sweep still covers it, because the sweep only
// fires when the client's own kick never landed (still charging_unsent 20s
// on), so there is nothing left to race.
//
// RECORDING THE ATTEMPT. terminal_jobs has no free jsonb/text column (last_error
// is the failure narrative, check_draft is the client's bill, verified_source
// belongs to settle) and a new column is DDL, which is blocked. So the attempt
// is a console line here, a `kick_scheduled` flag in the response, and a
// `kicked_by` marker on the start request that adyen-terminal-charge logs.
// ═══════════════════════════════════════════════════════════════════════════════
const SERVER_KICK_GRACE_MS = 1500;

function scheduleServerKick(jobId: string, why: string) {
  const run = async () => {
    await new Promise((r) => setTimeout(r, SERVER_KICK_GRACE_MS));
    try {
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/adyen-terminal-charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
        body: JSON.stringify({ action: 'start', job_id: jobId, kicked_by: 'terminal-job-create' }),
      });
      const out = await res.text();
      console.log(`[terminal-job-create] server kick for job ${jobId} (${why}): ${res.status} ${out.slice(0, 200)}`);
    } catch (e) {
      console.error(`[terminal-job-create] server kick for job ${jobId} failed to send: ${(e as Error)?.message || e}`);
    }
  };
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(run());
  else run();
  console.log(`[terminal-job-create] server kick scheduled for job ${jobId} in ${SERVER_KICK_GRACE_MS}ms (${why})`);
}

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
  tip_config?: Record<string, unknown>;   // LEGACY — see the tip block below
  suppress_tip?: boolean;                 // per-sale "no tip on this one" (bar tab / takeaway)
  closed_check_id?: string;
  check_draft?: Record<string, unknown>;
  training?: boolean;
  local_bridge?: boolean;       // 9 Sep 2026: THIS device drives the reader over the local nexo
                                // bridge (MPOS on an Adyen terminal) - the server must NOT cloud-kick.
                                // Mirrors terminalJobs.js p.localBridge; a stale bundle omits it and
                                // is still caught by the draft source / shared-uid checks.
  surface?: string;             // v5.7.5: 'pos' = main POS checkout; gates tip-on-receipt manual capture
  table_check?: boolean;        // v5.7.6: rides with surface:'pos' - true when the check is attached
                                // to a table/session, false for a counter/walk-in sale. Under scope
                                // 'table_checks' only true opens a tip window; missing = false (a
                                // stale till fails toward normal capture-at-payment behaviour).
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIP CONFIG — RESOLVED SERVER-SIDE, FROM THE TERMINAL'S OWN ROW
//
// v5.5.841. The bug this replaces: the POS built the frozen tip_config itself and
// sent `{"enabled":true, "percentages":null, …}`. TipConfig.fromJobJson on the
// terminal reads ONLY `percentBands` or `tip_percentages`, so it saw "tipping on,
// no bands" and — correctly, fail-closed — rendered no tip prompt at all. To the
// operator that is indistinguishable from tipping being switched off, at a venue
// where Back Office says it is on.
//
// THE SOURCE OF TRUTH IS terminal_devices.tip_config. That is what Back Office
// writes (set_terminal_settings, migration 20260723) and what the operator can
// actually see and change, and it is already stored normalised by
// _terminal_norm_tip_config. terminal_start_table_payment freezes the same column
// onto the job row — so mode 1 and mode 3 now agree by construction instead of by
// two clients happening to build the same object.
//
// normTipConfig below is a LINE-FOR-LINE PORT of _terminal_norm_tip_config
// (supabase/migrations/20260723_terminal_settings.sql § 2). If you change one,
// change both — a divergence here is a tip prompt that silently disappears.
// ═══════════════════════════════════════════════════════════════════════════════

/** Bands, in the three spellings that have ever been written. First array wins. */
function readBands(p: Record<string, unknown> | null): unknown[] | null {
  if (!p) return null;
  for (const k of ['percentBands', 'tip_percentages', 'percentages']) {
    const v = (p as Record<string, unknown>)[k];
    if (Array.isArray(v)) return v;
  }
  return null;
}

/** Postgres `(x)::boolean` semantics, plus the JSON `true`/`false` this actually sees. */
function boolOf(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 't' || s === 'yes' || s === 'y' || s === '1') return true;
    if (s === 'false' || s === 'f' || s === 'no' || s === 'n' || s === '0') return false;
  }
  return null;
}

/** The fail-closed shape. BOTH spellings, so neither parser has to guess. */
const TIP_OFF = { enabled: false, tipping_enabled: false } as const;

/**
 * Port of _terminal_norm_tip_config. Emits BOTH vocabularies, or an explicit OFF.
 * NEVER emits a null band list — that is the exact shape that caused this bug.
 */
function normTipConfig(p: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ...TIP_OFF };

  const enabled = boolOf(p.enabled) ?? boolOf(p.tipping_enabled) ?? false;
  if (!enabled) return { ...TIP_OFF };

  const raw = readBands(p) ?? [];
  const pcts: number[] = [];
  for (const el of raw) {
    const n = typeof el === 'number' ? el : Number(el);
    // 0%, a negative, a NaN or an absurd band is a broken row, not a tip option.
    if (!Number.isFinite(n) || n <= 0 || n > 100) continue;
    if (pcts.length >= 5) break;      // 5 buttons is all the screen has
    pcts.push(n);
  }
  // Tipping on with no usable band is not a state the terminal can render, and
  // inventing 10/12.5/15 would put percentages in front of a customer nobody at
  // the venue agreed to. Off is the honest answer.
  if (pcts.length === 0) return { ...TIP_OFF };

  const allowCustom = boolOf(p.allowCustom) ?? boolOf(p.allow_custom) ?? true;

  let thresh: number | null = null;
  const t = Number(p.smartThresholdMinor);
  if (Number.isFinite(t) && Number.isInteger(t) && t >= 0) thresh = t;

  return {
    enabled: true,
    tipping_enabled: true,      // Back Office vocabulary
    percentBands: pcts,
    tip_percentages: pcts,      // Back Office vocabulary
    allowCustom,
    allow_custom: allowCustom,
    smartThresholdMinor: thresh,
    // allowNoTip is NOT configurable and never will be. Trapping a customer on a
    // tip screen is not a setting; the terminal hard-codes it true regardless.
    allowNoTip: true,
  };
}

/** Does a client-supplied config genuinely carry at least one usable band? */
function carriesBands(p: Record<string, unknown> | null | undefined): boolean {
  const arr = readBands((p ?? null) as Record<string, unknown> | null);
  if (!arr) return false;
  return arr.some((el) => {
    const n = typeof el === 'number' ? el : Number(el);
    return Number.isFinite(n) && n > 0 && n <= 100;
  });
}

/** Did the caller explicitly ask for NO tip on this particular sale? */
function tipSuppressed(body: Body): boolean {
  if (body.suppress_tip === true) return true;
  // Legacy clients express the same thing as enabled:false inside tip_config.
  const c = body.tip_config;
  if (!c || typeof c !== 'object') return false;
  const e = boolOf((c as Record<string, unknown>).enabled)
        ?? boolOf((c as Record<string, unknown>).tipping_enabled);
  return e === false;
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
    .select('id, location_id, status, active, label, tip_config, bound_pos_device_id, adyen_terminal_id, serial_number, device_uid')
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
  // The POS device's auth uid rides along for the server-kick decision below:
  // when it equals the target terminal row's device_uid, the till IS the reader.
  let posDeviceUid: string | null = null;
  if (pos_device_id) {
    const { data: posDev } = await opsAdmin
      .from('devices').select('id, device_uid, device_profiles(training_mode)').eq('id', pos_device_id).maybeSingle();
    const prof = (posDev as any)?.device_profiles;
    const flag = Array.isArray(prof) ? prof[0]?.training_mode : prof?.training_mode;
    if (flag === true) training = true;
    posDeviceUid = ((posDev as any)?.device_uid as string | null) ?? null;
  }
  if (training) {
    return json({
      error: 'training mode — this till cannot dispatch a payment to a card terminal',
      training: true,
    }, 409);
  }

  // ── 3a. Assignment fence (v5.5.859) — server-side twin of findPaxTerminal's
  // rule. A terminal a manager assigned to a specific till takes payments from
  // THAT till only; the client resolver already refuses, but a stale bundle or a
  // hand-rolled caller must not be able to route around an assignment. Unassigned
  // terminals stay open to any till at the venue. Service-role callers (server
  // automation, admin tooling) bypass, same as the caller fence above.
  const boundTill = (term as any).bound_pos_device_id as string | null;
  if (!isServiceRole && boundTill && boundTill !== pos_device_id) {
    return json({
      error: `${term.label || 'This card terminal'} is assigned to a different till. `
           + 'Use that till, or reassign the terminal in Back Office → Card readers.',
      code: 'TERMINAL_ASSIGNED_ELSEWHERE',
    }, 409);
  }

  // ── 3b. Resolve the tip config. THE TERMINAL'S OWN ROW WINS ───────────────
  //
  // Precedence, highest first:
  //   1. An explicit per-sale suppression (bar tab / takeaway / collection, or a
  //      legacy client sending enabled:false). This can only ever make the job
  //      LESS tippable, so it is always safe to honour and it is the one thing
  //      the till genuinely knows that the terminal does not.
  //   2. A client config that GENUINELY CARRIES BANDS — kept so a caller with a
  //      real, deliberate override still works.
  //   3. terminal_devices.tip_config — Back Office's own value, which is what the
  //      operator sees and what terminal_start_table_payment already freezes.
  //
  // Whatever wins is normalised, so the row carries BOTH spellings the terminal
  // parses and NEVER a null band list. There is no path out of here that writes
  // "enabled with nothing to show".
  const deviceTip = (term as any).tip_config as Record<string, unknown> | null;
  let tipSource: string;
  let tipInput: Record<string, unknown> | null;
  if (tipSuppressed(body)) {
    tipSource = 'suppressed-by-caller';
    tipInput = null;
  } else if (carriesBands(tip_config)) {
    tipSource = 'client-override';
    tipInput = tip_config as Record<string, unknown>;
  } else {
    tipSource = deviceTip ? 'terminal_devices.tip_config' : 'none-configured';
    tipInput = deviceTip;
  }
  const resolvedTipConfig = normTipConfig(tipInput);
  // Loud on purpose. "Tipping is off" was a silent branch for a week; an unlogged
  // branch is a bug.
  console.log('[terminal-job-create] tip_config resolved', JSON.stringify({
    job_id, terminal: target_terminal_id, source: tipSource,
    client_sent_bands: carriesBands(tip_config),
    device_had_config: !!deviceTip,
    result: resolvedTipConfig,
  }));

  // ── 3c. Demo reader (v5.6.92) — the TERMINAL ROW is the authority, again ───
  // The browser demo reader (?mode=readerdemo) self-registers with a serial the
  // surface mints as DEMO-… (register_terminal_device stores it verbatim; a real
  // PAX serial or paxpay's AID-<ANDROID_ID> ladder can never start with DEMO-).
  // Jobs addressed to such a terminal are marked simulated=true, because
  // terminal_report_result only settles a device-reported outcome on SIMULATED
  // jobs — on a real job the report is an advisory claim and the job would
  // strand in 'charging' until the sweeper parked it needs_human. Simulated
  // also means the real charge paths refuse it outright (terminal-job-charge /
  // adyen-terminal-charge both 409 on simulated), so a demo job can never touch
  // a processor. The booked check stays auditable: the demo reader reports a
  // DEMO-… transaction id, which lands on the closed check.
  const isDemoTerminal = String((term as any).serial_number ?? '').toUpperCase().startsWith('DEMO-');
  if (isDemoTerminal) {
    console.log('[terminal-job-create] demo terminal — job will be simulated', JSON.stringify({
      job_id, terminal: target_terminal_id, serial: (term as any).serial_number,
    }));
  }

  // ── 3d. Tip on printed receipt (v5.7.5, US signature flow) ────────────────
  // capture_mode='manual' makes adyen-terminal-charge authorise WITHOUT
  // capturing (PreAuth + manualCapture, on-reader tip prompt forced off); the
  // written tip is captured later via adyen-modify tip_capture, and the
  // adyen-capture-sweep cron captures the original amount when the venue's
  // window closes. Stamped ONLY when ALL of:
  //   - the CLIENT says this is a main-POS checkout (surface:'pos' - MPOS,
  //     kiosk, QR and pay-at-table never send it),
  //   - the VENUE turned the setting on (locations.pos_settings.tip_on_receipt,
  //     read server-side - the client cannot assert it),
  //   - the setting's SCOPE matches the sale (v5.7.6): 'all_pos' takes every
  //     main-POS card payment paper; 'table_checks' takes only checks the till
  //     marked table_check:true (attached to a table/session) - counter and
  //     walk-in sales keep the on-reader tip prompt. A missing table_check
  //     under 'table_checks' means NO manual capture: a stale till that never
  //     learned the flag fails toward the normal capture-at-payment flow,
  //     never toward an unexpected hold,
  //   - the job routes to Adyen (term.adyen_terminal_id) OR the demo reader
  //     (simulated jobs mirror the whole flow; their capture rows are inserted
  //     by terminal_report_result and short-circuit before any processor).
  // Bar-tab pre-auth holds never pass here (holds have no terminal_jobs row),
  // so the "sale only" rule holds by construction.
  let captureMode: string | null = null;
  if (body.surface === 'pos' && (term.adyen_terminal_id || isDemoTerminal)) {
    const { data: loc } = await opsAdmin.from('locations')
      .select('pos_settings').eq('id', locationId).maybeSingle();
    const tor = readTipOnReceipt(loc?.pos_settings);
    const scopeHit = tor.scope === 'all_pos' || body.table_check === true;
    if (tor.enabled && scopeHit) {
      captureMode = 'manual';
      console.log('[terminal-job-create] tip-on-receipt venue - capture_mode=manual', JSON.stringify({
        job_id, terminal: target_terminal_id, capture_hours: tor.capture_hours,
        scope: tor.scope, table_check: body.table_check === true, simulated: isDemoTerminal,
      }));
    } else if (tor.enabled) {
      // Loud on purpose - "the slip did not print" and "the reader asked for a
      // tip" both start with proving which branch this create took.
      console.log('[terminal-job-create] tip-on-receipt scope miss - normal capture', JSON.stringify({
        job_id, terminal: target_terminal_id, scope: tor.scope, table_check: body.table_check === true,
      }));
    }
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
    tip_config: resolvedTipConfig,
    closed_check_id,
    check_draft,
    simulated: isDemoTerminal,
    // v5.7.5: 'manual' = tip-on-receipt hold, absent = capture at auth. Only
    // included when set, so the insert keeps working before migration
    // 20260823_tip_on_receipt.sql is hand-applied (edge fns deploy separately).
    ...(captureMode ? { capture_mode: captureMode } : {}),
    // The terminal row is the PROCESSOR authority too (v5.6.46): a terminal
    // linked to an Adyen POIID routes its jobs to adyen-terminal-charge; the
    // PAX/Ryft fleet keeps 'ryft'. No client input trusted.
    //
    // Lifecycle by fleet: PAX walks pending→claimed→tipping→charging_unsent ON
    // the device. An AMS1 has no on-device app — its tip prompt rides inside
    // the nexo PaymentRequest — so the job is born charging_unsent, ready for
    // the till's adyen-terminal-charge 'start' kick (CAS makes dupes harmless).
    status: term.adyen_terminal_id ? 'charging_unsent' : 'pending',
    processor: term.adyen_terminal_id ? 'adyen' : 'ryft',
    // Adyen-born jobs need the server-computed charge NOW: on PAX the
    // on-device tip walk stamps charge_minor, but an AMS1 job goes straight
    // to 'start', whose money-safety gate refuses a null charge. Base charge
    // = due; the gratuity the customer picks on the reader arrives on top in
    // the PaymentResponse and the settle writer records it (tj_charge_identity
    // holds: tip_minor stays NULL until settle).
    ...(term.adyen_terminal_id ? { charge_minor: due } : {}),
    claim_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    dispatched_at: new Date().toISOString(),
  };

  let { data: inserted, error: insErr } = await opsAdmin
    .from('terminal_jobs').insert(row).select().maybeSingle();

  // Migration 20260823_tip_on_receipt.sql not applied yet: never lose the sale
  // over the new column - retry without it (the job just captures at auth).
  if (insErr && captureMode && (insErr.code === '42703' || /capture_mode.*does not exist|does not exist.*capture_mode/i.test(insErr.message ?? ''))) {
    console.error('[terminal-job-create] capture_mode column missing - retrying without tip-on-receipt hold');
    const { capture_mode: _cm, ...rowNoCapture } = row as Record<string, unknown>;
    ({ data: inserted, error: insErr } = await opsAdmin
      .from('terminal_jobs').insert(rowNoCapture).select().maybeSingle());
  }

  // The server-side kick decision, shared by the fresh-insert and re-attach
  // paths. Same inputs the till's own rule uses, plus the three local-bridge
  // signals and the client-owns-the-kick source (see the block above
  // scheduleServerKick).
  const kickPlan = (job: Record<string, unknown>) => {
    if (clientOwnsCreateKick(job)) return { kick: false, reason: 'mpos cloud flow kicks itself; sweep covers a lost kick' };
    return shouldServerKick(job, {
      localBridge: body.local_bridge === true,
      terminalDeviceUid: ((term as any).device_uid as string | null) ?? null,
      posDeviceUid,
    });
  };

  if (!insErr && inserted) {
    const plan = kickPlan(inserted as Record<string, unknown>);
    if (plan.kick) scheduleServerKick(inserted.id, `fresh insert: ${plan.reason}`);
    else console.log(`[terminal-job-create] no server kick for job ${inserted.id}: ${plan.reason}`);
    return json({ ok: true, job: inserted, existing: false, kick_scheduled: plan.kick, kick_reason: plan.reason });
  }

  // ONLY a unique violation means "already recorded". Anything else is a real
  // failure and must surface — collapsing the two is how a caller comes to
  // believe a write landed when no row exists.
  if (insErr && insErr.code === '23505') {
    // TWO unique indexes can raise this, and they mean COMPLETELY different things.
    // The original handler only looked for the first, so the second surfaced as
    // "a conflicting job exists but could not be read back" — which told the
    // operator nothing and sent us chasing amounts that were never the problem.
    //
    //   idx_tj_one_live_per_check     -> the SAME BILL already has a live payment.
    //                                    Idempotent: hand back the existing job so a
    //                                    double-press re-attaches instead of double-charging.
    //   idx_tj_one_live_per_terminal  -> a DIFFERENT bill is mid-payment on this terminal.
    //                                    Not idempotent, not an error in the code — the
    //                                    machine is simply busy, and the operator needs to
    //                                    be told that in those words.

    // 1. Same check — re-attach.
    const { data: sameCheck } = await opsAdmin
      .from('terminal_jobs').select('*')
      .or(`id.eq.${job_id},check_key.eq.${check_key}`)
      .in('status', LIVE)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    if (sameCheck) {
      // v5.6.88's re-attach re-kick, now server-side too: a job whose first
      // kick was lost is still charging_unsent here, and every retry lands on
      // this branch. shouldServerKick refuses anything already 'charging'.
      //
      // kickPlan closes over THIS request's terminal row and POS device uid.
      // The existing job may be addressed elsewhere (a second device retrying
      // the same table check, matched by check_key): its target terminal and
      // pos_device_id can differ, and the shared-uid local-bridge signal would
      // then be judged on the wrong rows. Refuse the server kick in that case;
      // the retrying till kicks it itself and the sweep covers a lost kick.
      const addressedElsewhere = sameCheck.target_terminal_id !== target_terminal_id
        || (sameCheck.pos_device_id ?? null) !== (pos_device_id ?? null);
      const plan = addressedElsewhere
        ? { kick: false, reason: 're-attach to a job addressed elsewhere; till kicks' }
        : kickPlan(sameCheck as Record<string, unknown>);
      if (plan.kick) scheduleServerKick(sameCheck.id, `re-attach: ${plan.reason}`);
      else console.log(`[terminal-job-create] no server kick on re-attach to job ${sameCheck.id}: ${plan.reason}`);
      return json({ ok: true, job: sameCheck, existing: true, kick_scheduled: plan.kick, kick_reason: plan.reason });
    }

    // 2. Terminal busy with another bill. Note the narrower status set: this index
    //    deliberately excludes 'unknown' (20260725) — an unverified payment parks in
    //    the reconcile queue and must never take a terminal out of service.
    const { data: busy } = await opsAdmin
      .from('terminal_jobs')
      .select('id, check_key, status, due_minor, charge_minor, check_draft')
      .eq('target_terminal_id', target_terminal_id)
      .in('status', ['claimed', 'tipping', 'charging_unsent', 'charging'])
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    if (busy) {
      const where = (busy.check_draft as Record<string, unknown> | null)?.tableLabel;
      const amt = ((busy.charge_minor ?? busy.due_minor ?? 0) as number) / 100;
      return json({
        error: `That card machine is already taking a payment${where ? ` for ${where}` : ''}`
             + ` (£${amt.toFixed(2)}). Wait for it to finish, or send this one to another terminal.`,
        code: 'TERMINAL_BUSY',
        busy_job_id: busy.id,
        busy_status: busy.status,
      }, 409);
    }

    // 3. THE PRIMARY KEY. id is POS-minted and deliberately reused for a check so
    //    a retry is idempotent — but the POS keeps that handle in localStorage and
    //    only clears it on certain exits. Close the modal another way and the NEXT
    //    payment on the same check re-sends a SETTLED job's id, which collides on
    //    the pkey. Both lookups above filter on live status, so they miss it and
    //    the operator got "another payment was being set up" for what is really
    //    "you already used that id".
    //
    //    Look it up with NO status filter and say so precisely, so the till can
    //    drop the stale handle and retry with a fresh id instead of erroring at a
    //    member of staff.
    const { data: settled } = await opsAdmin
      .from('terminal_jobs')
      .select('id, status, charge_minor, due_minor')
      .eq('id', job_id)
      .maybeSingle();
    if (settled) {
      return json({
        error: 'That payment reference has already been used and settled.',
        code: 'JOB_ALREADY_SETTLED',
        job_status: settled.status,
        job_id: settled.id,
      }, 409);
    }

    // 4. Genuinely nothing to find — the conflicting row settled between the
    //    insert and these reads. Safe to retry.
    return json({
      error: 'Another payment was being set up at the same moment. Try again.',
      code: 'CONFLICT_RACE',
    }, 409);
  }

  return json({ error: insErr?.message ?? 'insert failed', code: insErr?.code ?? null }, 500);
});
