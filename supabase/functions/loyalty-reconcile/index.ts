// supabase/functions/loyalty-reconcile/index.ts
//
// THE RECONCILER loyalty-redeem's comment promises and nothing implemented.
//
// A points redemption settles on the PLATFORM db — loyalty_redeem_points debits
// customer_loyalty and inserts the loyalty_redemption_claims row in ONE transaction
// (migration 20260806c Section B). The audit row, ops.loyalty_transactions, is written
// afterwards by loyalty-redeem, because the two tables live on two separate Postgres
// clusters and no transaction can span them.
//
// loyalty-redeem retries that write three times and loyalty-refund reads the claim rows
// directly when the ledger has no redeem row for a check, so the MONEY is already
// recoverable. What is not recoverable is the REPORTING: a redemption whose ledger row
// never landed is missing from the Loyalty report, from Transactions, and from every
// per-venue points total, and the only trace of it is a log line plus one activity_events
// row. This function closes that.
//
// WHAT IT DOES
//   * pages claim rows off Platform, oldest first, inside a closed time window
//   * anti-joins them against ops.loyalty_transactions on idempotency_key — the join has
//     to happen HERE, in the function, because the two sides are different projects and no
//     SQL join can reach across them
//   * backfills each miss with the same upsert shape loyalty-redeem uses
//     (onConflict: 'idempotency_key', ignoreDuplicates: true), so a redemption still
//     retrying its own ledger write cannot end up with two rows
//   * returns counts, so a human can tell whether it is finding anything
//
// Body (all optional):
//   { lookback_hours?, after?, min_age_minutes?, max_scan?, max_backfill?, dry_run? }
//
// Auth: SERVICE ROLE ONLY. It reads and writes ledger rows for every tenant.
//
// Scheduled hourly by pg_cron — migration 20260806e_loyalty_reconcile_cron.sql.
//
// ── WHY IT IS BOUNDED, AND WHAT THE MARKERS MEAN ──────────────────────────────
// review-sync's sync_all shipped as "process every venue" and had to be given a batch, a
// wall clock and a `complete` flag after a truncated run turned out to be indistinguishable
// from a full one. Same discipline here, with the same failure in mind.
//
// The work queue itself drains: a claim stops being a miss the moment its ledger row exists,
// so nothing can be re-fixed forever. It is the SCAN that is unbounded — claims accumulate
// one row per redemption and are never deleted — so a run that always started at the oldest
// claim would eventually spend its whole budget re-reading ancient reconciled rows and never
// reach today's. Hence a LOOKBACK WINDOW: the default tick only looks at the last 7 days,
// which it can walk completely, and every claim gets 168 hourly chances inside it. Older
// ground is swept by hand with an explicit `after` or a large `lookback_hours`.
//
// `complete` is true only if the whole window was walked. When it is false, `stopped_on`
// says which bound was hit and `next_after` is the resume cursor to pass back as `after`.
// The window is closed at the top (created_at < now - min_age), so no row can be inserted
// into it mid-run and offset paging is stable for the length of an invocation.
//
// ── WHY IT IGNORES YOUNG CLAIMS ───────────────────────────────────────────────
// A redemption in flight has ALREADY inserted its claim row (that is the transaction that
// moved the points) and is milliseconds away from writing its ledger row. Reconciling that
// is not wrong — the upsert makes a double write impossible — but it would race the live
// path for no reason and report phantom "repairs" on every tick. min_age_minutes (default 5)
// keeps this function to redemptions that have genuinely finished failing.

import {
  cors, json, opsAdmin, platformAdmin,
} from '../_shared/loyalty-utils.ts';

// Read directly rather than via loyalty-utils: the shared module builds the clients from
// this key but does not export it, and the auth check below needs the value itself.
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const PAGE             = 200;      // claim rows per Platform read
const PROBE_CHUNK      = 50;       // keys per Ops anti-join probe — PostgREST sends `in` on the URL
const MAX_SCAN         = 2_000;    // claims EXAMINED per invocation
const MAX_SCAN_CAP     = 20_000;
const MAX_BACKFILL     = 200;      // ledger rows WRITTEN per invocation
const MAX_BACKFILL_CAP = 1_000;
// Deliberately UNDER call_edge_fn's pg_net timeout (timeout_milliseconds := 25000, migration
// 20260805b). pg_net giving up does not stop the isolate — the backfills still land — but the
// RESPONSE is discarded, and this function's response IS the report a human reads out of
// net._http_response. A scheduled tick that would run long therefore stops early and SAYS so,
// rather than doing its work invisibly. A hand-run sweep costs a few passes with `after`.
const RUN_BUDGET_MS    = 20_000;   // stop starting pages past this
const MIN_AGE_MIN      = 5;        // never touch a redemption younger than this
const LOOKBACK_HOURS   = 168;      // 7 days

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const clamp = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : dflt;
};

// ── Recovering the check id from the idempotency key ────────────────────────
// loyalty_transactions.location_id is NOT NULL and the claim row does not carry one, so it
// has to be re-derived. loyalty-redeem builds one of two key shapes (index.ts:203):
//   redeem:<closed_check_id>:<reward_id>              — the normal, check-anchored path
//   redeem:<customer_id>:<reward_id>:<30s window>     — no check id existed at redeem time
// The second is NOT a check id in disguise, so it must not be read as one; it is matched
// first and returns null. `(.+)` is greedy on purpose — a check id containing a colon
// (none seen live, but ids are free text) survives intact.
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const WINDOWED_KEY = new RegExp(`^redeem:${UUID}:${UUID}:\\d+$`);
const CHECKED_KEY  = new RegExp(`^redeem:(.+):${UUID}$`);

function checkIdFromKey(key: string): string | null {
  if (WINDOWED_KEY.test(key)) return null;
  const m = CHECKED_KEY.exec(key);
  return m ? m[1] : null;
}

type Claim = {
  idempotency_key: string;
  membership_id: string;
  company_id: string | null;
  reward_id: string | null;
  points: number;
  balance_after: number;
  created_at: string;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Service role only. `!token` is load-bearing and is not paranoia: SUPABASE_SERVICE_ROLE_KEY
  // resolves to '' if the secret is ever missing from the environment, and a bare
  // unauthenticated POST sends '' too — without this check the comparison succeeds and the
  // function fails OPEN, handing every tenant's ledger to anyone who can reach the URL.
  // A sibling function shipped exactly that way; review-sync/index.ts:151 carries the same note.
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token || token !== SERVICE_ROLE) return json({ error: 'service role required' }, 403);

  // pg_cron always posts '{}' via call_edge_fn. A hand-run `curl` with no body should not be
  // a 400 — every parameter has a default.
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }

  const lookbackHours = clamp(body.lookback_hours, 1, 87_600, LOOKBACK_HOURS);   // cap: 10 years
  const minAgeMin     = clamp(body.min_age_minutes, 1, 1_440, MIN_AGE_MIN);
  const maxScan       = clamp(body.max_scan, 1, MAX_SCAN_CAP, MAX_SCAN);
  const maxBackfill   = clamp(body.max_backfill, 1, MAX_BACKFILL_CAP, MAX_BACKFILL);
  const dryRun        = body.dry_run === true;

  const now        = Date.now();
  const windowEnd  = new Date(now - minAgeMin * 60_000).toISOString();
  const windowStart = typeof body.after === 'string' && body.after.trim()
    // Inclusive resume: re-examining the boundary row costs one probe and cannot double-write,
    // whereas an exclusive cursor would skip any row sharing that exact timestamp.
    ? new Date(body.after).toISOString()
    : new Date(now - lookbackHours * 3_600_000).toISOString();

  if (windowStart >= windowEnd) {
    return json({ ok: true, complete: true, scanned: 0, note: 'empty window', window_start: windowStart, window_end: windowEnd });
  }

  const deadline = now + RUN_BUDGET_MS;

  let offset = 0;
  let scanned = 0, missing = 0, backfilled = 0, raced = 0, unresolved = 0, failed = 0;
  let lastSeen: string | null = null;
  // Set only when a run stops PART WAY THROUGH a page; see the backfill cap below.
  let resumeAt: string | null = null;
  let exhausted = false;
  let stoppedOn: string | null = null;
  const unresolvedKeys: string[] = [];
  const backfilledKeys: string[] = [];

  while (true) {
    if (Date.now() > deadline)    { stoppedOn = 'run_budget';   break; }
    if (scanned >= maxScan)       { stoppedOn = 'scan_cap';     break; }
    if (backfilled >= maxBackfill){ stoppedOn = 'backfill_cap'; break; }

    const pageSize = Math.min(PAGE, maxScan - scanned);
    const { data: claims, error: claimErr } = await platformAdmin
      .from('loyalty_redemption_claims')
      .select('idempotency_key, membership_id, company_id, reward_id, points, balance_after, created_at')
      .gte('created_at', windowStart)
      .lt('created_at', windowEnd)
      .order('created_at', { ascending: true })
      .order('idempotency_key', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (claimErr) {
      // The table is created by migration 20260806c Section B, on Platform. Say so plainly —
      // otherwise this reads as a transient outage and gets retried forever by the cron.
      const notThere = /does not exist|Could not find the table|schema cache/i.test(claimErr.message || '');
      return json({
        error: notThere
          ? 'loyalty_redemption_claims is missing on the Platform DB — apply migration 20260806c Section B (yhzjgyrkyjabvhblqxzu) before scheduling this function.'
          : `claims read failed: ${claimErr.message}`,
      }, notThere ? 503 : 500);
    }

    const page = (claims ?? []) as Claim[];
    if (page.length === 0) { exhausted = true; break; }
    offset  += page.length;
    scanned += page.length;
    lastSeen = page[page.length - 1].created_at;

    // ── The anti-join ────────────────────────────────────────────────────────
    // One indexed lookup per chunk against the UNIQUE idempotency_key on Ops.
    // NEVER swallow this error. A failed probe returns no keys, every claim on the page then
    // looks like a miss, and the run reports a pile of "repairs" it did not make (the upsert
    // stops it corrupting anything, but the numbers would be a lie). Fail loudly so the cron
    // surfaces it — the same reason review-sync refuses to answer `complete` on a failed
    // queue read.
    const present = new Set<string>();
    for (const keys of chunk(page.map((c) => c.idempotency_key), PROBE_CHUNK)) {
      const { data, error } = await opsAdmin
        .from('loyalty_transactions')
        .select('idempotency_key')
        .in('idempotency_key', keys);
      if (error) return json({ error: `ledger probe failed: ${error.message}`, scanned, backfilled }, 500);
      for (const r of data ?? []) present.add(r.idempotency_key as string);
    }

    const gaps = page.filter((c) => !present.has(c.idempotency_key));
    if (gaps.length === 0) {
      if (page.length < pageSize) { exhausted = true; break; }
      continue;
    }
    missing += gaps.length;
    console.warn(`[loyalty-reconcile] ${gaps.length} claim(s) with no Ops ledger row`, gaps.map((g) => g.idempotency_key));

    // ── Rebuild what the ledger row needs but the claim does not carry ───────
    // customer_id and company_id are both NOT NULL on loyalty_transactions and the claim holds
    // only membership_id, so the membership rows are mandatory. Losing this read would make
    // every gap unresolvable and the run would report a clean, useless pass.
    const members = new Map<string, { customer_id: string; company_id: string }>();
    for (const ids of chunk([...new Set(gaps.map((g) => g.membership_id))], PROBE_CHUNK)) {
      const { data, error } = await platformAdmin
        .from('customer_loyalty')
        .select('id, customer_id, company_id')
        .in('id', ids);
      if (error) return json({ error: `membership read failed: ${error.message}`, scanned, backfilled }, 500);
      for (const m of data ?? []) members.set(m.id, { customer_id: m.customer_id, company_id: m.company_id });
    }

    // location_id, from the check the redemption was anchored to.
    const checkIds = [...new Set(gaps.map((g) => checkIdFromKey(g.idempotency_key)).filter(Boolean) as string[])];
    const checkLoc = new Map<string, string>();
    for (const ids of chunk(checkIds, PROBE_CHUNK)) {
      const { data, error } = await opsAdmin.from('closed_checks').select('id, location_id').in('id', ids);
      if (error) return json({ error: `closed_checks read failed: ${error.message}`, scanned, backfilled }, 500);
      for (const c of data ?? []) checkLoc.set(c.id, c.location_id);
    }

    // Second source — loyalty-redeem's own alert row, and the one that carries most of the
    // real traffic. The windowed key shape is not the exception: of the five redeem rows on Ops
    // today four are windowed (the POS redeems BEFORE the check id exists), so checkIdFromKey
    // returns null for them and the lookup above finds nothing. But when the ledger write
    // failed — the case this function exists for — loyalty-redeem raised an activity_events row
    // with ref_id = the idempotency key and the location_id it was actually called with. That
    // is the redemption's own record of its venue, not an inference from it.
    const alertLoc = new Map<string, string>();
    for (const keys of chunk(gaps.map((g) => g.idempotency_key), PROBE_CHUNK)) {
      const { data, error } = await opsAdmin
        .from('activity_events')
        .select('ref_id, location_id')
        .eq('ref_type', 'loyalty_redemption')
        .in('ref_id', keys);
      // Fatal, like the other location sources. Swallowing it would silently demote rows this
      // job could have fixed into `unresolved`, i.e. hand a person work that was never theirs.
      if (error) return json({ error: `activity_events read failed: ${error.message}`, scanned, backfilled }, 500);
      for (const a of data ?? []) if (a.ref_id && a.location_id) alertLoc.set(a.ref_id, a.location_id);
    }

    // Third and last source (a windowed key whose isolate died before it could even raise the
    // alert): a single-venue company has exactly one answer. A multi-venue company does NOT,
    // and this will not pick one — an invented location_id would quietly corrupt every
    // per-venue loyalty total, which is the reporting this function exists to fix. Those rows
    // are counted as `unresolved` and left for a human.
    const companyIds = [...new Set(
      gaps.map((g) => g.company_id ?? members.get(g.membership_id)?.company_id).filter(Boolean) as string[],
    )];
    const soleLoc = new Map<string, string | null>();
    for (const ids of chunk(companyIds, PROBE_CHUNK)) {
      const { data, error } = await platformAdmin.from('locations').select('company_id, ops_location_id').in('company_id', ids);
      if (error) return json({ error: `locations read failed: ${error.message}`, scanned, backfilled }, 500);
      const byCompany = new Map<string, Set<string>>();
      for (const l of data ?? []) {
        if (!l.ops_location_id) continue;
        if (!byCompany.has(l.company_id)) byCompany.set(l.company_id, new Set());
        byCompany.get(l.company_id)!.add(l.ops_location_id);
      }
      for (const [cid, set] of byCompany) soleLoc.set(cid, set.size === 1 ? [...set][0] : null);
    }

    // Reward names, so the backfilled row reads like the one loyalty-redeem would have written.
    // Cosmetic — a missing name never blocks the backfill.
    const rewardName = new Map<string, string>();
    const rewardIds = [...new Set(gaps.map((g) => g.reward_id).filter(Boolean) as string[])];
    for (const ids of chunk(rewardIds, PROBE_CHUNK)) {
      const { data } = await platformAdmin.from('loyalty_rewards').select('id, name').in('id', ids);
      for (const r of data ?? []) rewardName.set(r.id, r.name);
    }

    // ── Backfill ─────────────────────────────────────────────────────────────
    for (const c of gaps) {
      if (backfilled >= maxBackfill) {
        // Resume from THIS row, not from the end of the page. The other two stops (run budget,
        // scan cap) fire at the top of the loop with the previous page fully handled, so the
        // page's last created_at is a correct cursor for them. This one fires MID-page: the
        // gaps after c have not been looked at, and `after` is inclusive-from, so reporting
        // lastSeen here would step straight over them.
        stoppedOn = 'backfill_cap';
        resumeAt = c.created_at;
        break;
      }

      const member = members.get(c.membership_id);
      const companyId = c.company_id ?? member?.company_id ?? null;
      const checkId = checkIdFromKey(c.idempotency_key);
      const locationId = (checkId ? checkLoc.get(checkId) : null)
        ?? alertLoc.get(c.idempotency_key)
        ?? (companyId ? soleLoc.get(companyId) ?? null : null);

      if (!member?.customer_id || !companyId || !locationId) {
        unresolved++;
        if (unresolvedKeys.length < 10) unresolvedKeys.push(c.idempotency_key);
        console.error('[loyalty-reconcile] cannot rebuild ledger row', JSON.stringify({
          idempotency_key: c.idempotency_key,
          membership_id: c.membership_id,
          have_customer: !!member?.customer_id, have_company: !!companyId, have_location: !!locationId,
        }));
        continue;
      }

      // Field for field what loyalty-redeem/index.ts:272 writes, with two honest differences:
      // channel is not recorded on the claim so it stays null rather than being guessed, and the
      // note says where the row came from. staff_id is likewise unknown here.
      const row = {
        customer_id: member.customer_id,
        company_id: companyId,
        location_id: locationId,
        type: 'redeem',
        points: -Math.abs(c.points),          // ledger stores redeems negative; the claim stores the magnitude
        balance_after: c.balance_after,        // the balance the Platform transaction actually settled on
        source: 'reward',
        channel: null,
        closed_check_id: checkId,
        reward_id: c.reward_id,
        idempotency_key: c.idempotency_key,
        staff_id: null,
        note: `Redeemed: ${c.reward_id ? rewardName.get(c.reward_id) ?? 'reward' : 'reward'} — backfilled by loyalty-reconcile`,
        created_at: c.created_at,              // the redemption's own time, not the repair's
      };

      if (dryRun) {
        backfilled++;
        if (backfilledKeys.length < 10) backfilledKeys.push(c.idempotency_key);
        continue;
      }

      // The SAME shape loyalty-redeem uses. ON CONFLICT DO NOTHING on the unique
      // idempotency_key: if that function's own retry lands the row between our probe and this
      // write, this is a no-op instead of a duplicate. `.select()` is what tells the two apart —
      // with DO NOTHING, RETURNING yields rows only for an insert that actually happened, so a
      // race is reported as `raced` rather than counted as a repair.
      const { data: ins, error: insErr } = await opsAdmin
        .from('loyalty_transactions')
        .upsert(row, { onConflict: 'idempotency_key', ignoreDuplicates: true })
        .select('idempotency_key');

      if (insErr) {
        failed++;
        console.error('[loyalty-reconcile] backfill failed', c.idempotency_key, insErr.message);
        continue;
      }
      if (ins?.length) {
        backfilled++;
        if (backfilledKeys.length < 10) backfilledKeys.push(c.idempotency_key);
      } else {
        raced++;
      }
    }

    if (stoppedOn) break;
    if (page.length < pageSize) { exhausted = true; break; }
  }

  return json({
    ok: true,
    // True only if the whole window was walked. Anything else means rows were not looked at,
    // and `next_after` is where to pick up.
    complete: exhausted,
    stopped_on: stoppedOn,
    scanned,
    missing,          // claims with no ledger row
    backfilled,       // ledger rows this run created
    raced,            // the live retry landed it first — not a failure
    unresolved,       // a miss we could not rebuild (see unresolved_keys); needs a human
    failed,           // the insert itself errored
    dry_run: dryRun || undefined,
    window_start: windowStart,
    window_end: windowEnd,
    next_after: exhausted ? null : (resumeAt ?? lastSeen),
    samples: {
      unresolved_keys: unresolvedKeys,
      backfilled_keys: backfilledKeys,
    },
  });
});
