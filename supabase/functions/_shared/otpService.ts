// supabase/functions/_shared/otpService.ts
//
// A VENUE'S CODE TEXT SERVICE, MADE AND CHECKED (22 Oct 2026, v5.11.94). The rules are in
// otpServiceRules.js (pure, node tested); this module applies them against Twilio Verify and the two
// databases. The clients are passed in, so one copy serves loyalty-otp (send, ensure_service, audit),
// message-templates (save, reset, service_status, fix_service), location-admin (a rename),
// provision-location (a new venue) and loyalty-config (loyalty switched on), and the node harness
// (src/lib/otpServiceEdge.test.js) drives it with stand in clients and a stand in Twilio.
//
//   ensureVenueService  one venue: read the facts, decide, and (when fix) create, recreate or rename
//                       its OWN service. The shared fallback service is never renamed and never
//                       recreated: a guard here refuses it before any Twilio call.
//   auditVenues         every venue in the Platform database (or one company's): ensure each, write
//                       the result to Ops loyalty_otp_service_audit, raise one feed alert per venue
//                       still not right (once a week), list legacy and orphan rows, leave one row in
//                       Ops loyalty_otp_audit_runs (what the watchdog reads), answer a summary.
//   recordVenueResult   one venue's result into the audit table (the send path, when it refused or
//                       repaired something), so the watchdog hears of it within minutes.
//
// Review fixes (22 Oct 2026): every venue is in scope, not only loyalty on companies (the kiosk,
// online and QR sign in send codes whatever the loyalty switch says); the company is ALWAYS the
// venue's Platform row's (a caller's company id is only compared with it); a venue missing from the
// Platform database is never given a service; a run for one company sees only that company's rows.

import { createVerifyService, setVerifyServiceName, readVerifyService, sharedVerifySid, verifyCredentialsPresent } from './twilio-verify.ts';
import { pagedRows } from './pagedRows.js';
import {
  OVERRIDE_ROW_TYPE, AUDIT_TABLE, AUDIT_RUNS_TABLE, ALERT_REF_TYPE, AUDIT_BUDGET_MS, AUDIT_CONCURRENCY,
  sidRowType, overrideRowType, verifySidOf, twilioName, desiredName, decideService, isOkState, venueWords,
  alertDue, alertRow, auditSummary, isMissingRelation, mapLimit, isUuid, classifyOtpRows, auditRunRow, auditRow,
} from './otpServiceRules.js';

type Client = any;

export type EnsureArgs = {
  ops: Client;
  platform: Client;
  opsLocationId: string;
  /**
   * The company the CALLER believes the venue belongs to (the kiosk sends one). Never used to
   * write: the company is always the venue's Platform row's, and a different one here answers
   * wrong_company with nothing made.
   */
  companyId?: string | null;
  /** Make the change (create, recreate, rename). false = report only. */
  fix?: boolean;
  now?: () => Date;
};

export type ServiceResult = {
  ok: boolean;
  state: string;
  action_taken: 'none' | 'created' | 'recreated' | 'renamed';
  service_sid: string | null;
  name: string | null;
  desired_name: string;
  twilio_error: string | null;
  location_id: string;
  company_id: string | null;
  checked_at: string;
  words: string;
  error?: string;
};

const errText = (e: unknown) => String((e as any)?.message || e || 'unknown error');
const settled = <T>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);

// The one place a Twilio rename is asked for. The shared service is never renamed: renaming it would
// change every other venue's texts, which is the 21 Oct 2026 failure the other way round.
async function renameOwnService(sid: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const shared = sharedVerifySid();
  if (!sid || (shared && sid === shared)) return { ok: false, error: 'refused: the shared text service is never renamed' };
  let r = await setVerifyServiceName(name, sid);
  if (!r.ok) r = await setVerifyServiceName(name, sid);   // one more try for a passing blip
  return { ok: r.ok, error: r.ok ? undefined : (r.error || 'rename failed') };
}

// Create a service named for the venue, twice if need be.
async function createOwnService(name: string): Promise<{ ok: boolean; sid?: string; error?: string }> {
  let r = await createVerifyService(name);
  if (!r.ok || !r.sid) r = await createVerifyService(name);
  return r;
}

async function readSidRow(platform: Client, companyId: string, rowType: string): Promise<string | null> {
  const { data } = await platform.from('message_templates').select('body_text').eq('company_id', companyId).eq('message_type', rowType).eq('channel', 'sms').maybeSingle();
  return verifySidOf(data?.body_text);
}

/** Store the venue's sid row: a new row, or the existing one pointed at the new service. A lost race keeps the winner. */
async function storeSidRow(platform: Client, companyId: string, opsLocationId: string, sid: string, existed: boolean, nowIso: string): Promise<string> {
  const rowType = sidRowType(opsLocationId);
  if (existed) {
    const { error } = await platform.from('message_templates').update({ body_text: sid, enabled: true, updated_at: nowIso })
      .eq('company_id', companyId).eq('message_type', rowType).eq('channel', 'sms');
    if (error) throw new Error(`could not store the service row: ${error.message}`);
    return sid;
  }
  const { error } = await platform.from('message_templates').insert({ company_id: companyId, message_type: rowType, channel: 'sms', body_text: sid, enabled: true });
  if (error) {
    // (company_id, message_type, channel) is unique: a second send or a Fix pressed twice raced us. Use the winner.
    const winner = await readSidRow(platform, companyId, rowType);
    if (winner) return winner;
    throw new Error(`could not store the service row: ${error.message}`);
  }
  return sid;
}

export async function ensureVenueService(a: EnsureArgs): Promise<ServiceResult> {
  const { ops, platform } = a;
  const opsLocationId = String(a.opsLocationId || '').trim();
  const fix = a.fix !== false;
  const now = (a.now || (() => new Date()))();
  const nowIso = now.toISOString();
  const base = (): ServiceResult => ({
    ok: false, state: 'unknown', action_taken: 'none', service_sid: null, name: null, desired_name: '', twilio_error: null,
    location_id: opsLocationId, company_id: null, checked_at: nowIso, words: '',
  });
  const finish = (r: ServiceResult): ServiceResult => {
    r.ok = isOkState(r.state);
    r.words = venueWords(r);
    return r;
  };
  const out = base();
  if (!isUuid(opsLocationId)) return finish({ ...out, state: 'not_provisioned', error: 'location id is not a uuid' });

  // 1. The facts, in one batch. The venue's Platform row decides the company; without it there is
  //    no venue to make a service for (a made up location id never reaches Twilio).
  const [platRes, opsLoc] = await Promise.all([
    platform.from('locations').select('id, name, company_id').eq('ops_location_id', opsLocationId).maybeSingle()
      .then((r: any) => ({ data: r?.data ?? null, error: r?.error ?? null }), (e: unknown) => ({ data: null, error: { message: errText(e) } })),
    ops.from('locations').select('name').eq('id', opsLocationId).maybeSingle().then((r: any) => r?.data ?? null, () => null),
  ]);
  if (platRes.error) return finish({ ...out, state: 'db_unreadable', error: String(platRes.error.message || platRes.error) });
  const platLoc = platRes.data;
  const companyId = platLoc?.company_id ? String(platLoc.company_id) : null;
  if (!platLoc || !companyId) return finish({ ...out, state: 'not_provisioned' });
  if (a.companyId && String(a.companyId) !== companyId) {
    console.error('[otp-service] company does not match the venue, nothing made', JSON.stringify({ location_id: opsLocationId, asked: String(a.companyId), venue_company: companyId }));
    return finish({ ...out, state: 'wrong_company' });
  }
  out.company_id = companyId;

  const [rowsRes, coRes] = await Promise.allSettled([
    platform.from('message_templates').select('message_type, body_text, enabled').eq('company_id', companyId).eq('channel', 'sms')
      .in('message_type', [overrideRowType(opsLocationId), sidRowType(opsLocationId)]).limit(10),
    platform.from('companies').select('name').eq('id', companyId).maybeSingle(),
  ]);
  // A failed read of the venue's rows is never "no service": that would make a second one.
  const rowsAns: any = settled(rowsRes);
  if (!rowsAns || rowsAns.error) return finish({ ...out, state: 'db_unreadable', error: String(rowsAns?.error?.message || 'message_templates could not be read') });
  const rows: any[] = rowsAns.data || [];
  const override = rows.find((r) => r.message_type === overrideRowType(opsLocationId)) || null;
  const sidRowRaw = rows.find((r) => r.message_type === sidRowType(opsLocationId)) || null;
  const sidRow = verifySidOf(sidRowRaw?.body_text);
  const companyName = (settled(coRes) as any)?.data?.name || '';

  out.desired_name = desiredName({
    override: override?.body_text || '', overrideEnabled: override ? override.enabled !== false : true,
    opsName: opsLoc?.name || '', platformName: platLoc?.name || '', companyName,
  });
  out.service_sid = sidRow;

  if (!verifyCredentialsPresent()) return finish({ ...out, state: 'not_configured' });

  // 2. What Twilio says about the venue's own service (never the shared one: it is not this venue's).
  const shared = sharedVerifySid();
  let twilio: { status: 'found' | 'missing' | 'unreadable'; name: string | null; error?: string } | null = null;
  if (sidRow && !(shared && sidRow === shared)) {
    twilio = await readVerifyService(sidRow);
    out.name = twilio.name;
    if (twilio.status !== 'found') out.twilio_error = twilio.error || null;
  }

  // 3. The decision.
  const d = decideService({ sidRow, sharedSid: shared, twilio, desired: out.desired_name });
  out.state = d.state;
  if (d.action === 'none' || d.action === 'wait' || !fix) return finish(out);

  // 4. The fix.
  try {
    if (d.action === 'create' || d.action === 'recreate') {
      const made = await createOwnService(out.desired_name);
      if (!made.ok || !made.sid) {
        out.twilio_error = made.error || 'create failed';
        console.error('[otp-service] create verify service failed', JSON.stringify({ location_id: opsLocationId, company_id: companyId, state: d.state, error: out.twilio_error }));
        return finish(out);
      }
      const stored = await storeSidRow(platform, companyId, opsLocationId, made.sid, !!sidRowRaw, nowIso);
      out.service_sid = stored;
      if (stored !== made.sid) {
        // Another call won the race and stored its own new service; that one is named the same way.
        const again = await readVerifyService(stored);
        out.name = again.name;
        out.state = again.status === 'found' && twilioName(again.name || '').toLowerCase() === out.desired_name.toLowerCase() ? 'ready' : d.state;
        out.action_taken = 'none';
        return finish(out);
      }
      out.name = out.desired_name;
      out.state = 'ready';
      out.action_taken = d.action === 'recreate' ? 'recreated' : 'created';
      out.twilio_error = null;
      return finish(out);
    }
    if (d.action === 'rename') {
      const renamed = await renameOwnService(sidRow as string, out.desired_name);
      if (!renamed.ok) {
        out.twilio_error = renamed.error || 'rename failed';
        console.error('[otp-service] rename verify service failed', JSON.stringify({ location_id: opsLocationId, company_id: companyId, sid: sidRow, error: out.twilio_error }));
        return finish(out);
      }
      out.name = out.desired_name;
      out.state = 'ready';
      out.action_taken = 'renamed';
      return finish(out);
    }
  } catch (e) {
    out.twilio_error = errText(e);
    console.error('[otp-service] fix failed', JSON.stringify({ location_id: opsLocationId, company_id: companyId, state: d.state, error: out.twilio_error }));
  }
  return finish(out);
}

export type AuditArgs = {
  ops: Client;
  platform: Client;
  fix?: boolean;
  /** One company only (a staff run, or loyalty just switched on). null = every venue in the Platform database. */
  companyId?: string | null;
  budgetMs?: number;
  now?: () => Date;
  /** Who started it, for the audit rows and the log ('cron_key', 'service_role', 'staff', 'loyalty_on'). */
  by?: string;
};

const RUNS_KEEP_DAYS = 90;

/** One venue's result into the audit table (the send path). Never throws; a missing table is fine. */
export async function recordVenueResult(ops: Client, result: ServiceResult, by: string): Promise<void> {
  try {
    if (!result || !isUuid(result.location_id)) return;
    const { error } = await ops.from(AUDIT_TABLE).upsert([auditRow(result, by)], { onConflict: 'location_id' });
    if (error && !isMissingRelation(error)) console.error('[otp-service] audit row not written', JSON.stringify({ location_id: result.location_id, error: error.message }));
  } catch (e) {
    console.error('[otp-service] audit row not written', errText(e));
  }
}

/** The run row for the watchdog. A run that could not even start (it threw) passes its error here. */
export async function recordAuditRun(ops: Client, summary: any, o: { companyId?: string | null; fix?: boolean; by?: string; now?: () => Date }): Promise<string> {
  const at = (o.now || (() => new Date()))();
  try {
    const { error } = await ops.from(AUDIT_RUNS_TABLE).insert(auditRunRow(summary, { companyId: o.companyId || null, fix: o.fix !== false, by: o.by, at }));
    if (error && isMissingRelation(error)) return 'missing: needs database update 20261022b';
    if (error) { console.error('[otp-service] audit run row not written', error.message); return 'failed'; }
    // Keep 90 days (one row a night plus the odd hand run). Best effort.
    await ops.from(AUDIT_RUNS_TABLE).delete().lt('ran_at', new Date(at.getTime() - RUNS_KEEP_DAYS * 86400000).toISOString());
    return 'written';
  } catch (e) {
    console.error('[otp-service] audit run row not written', errText(e));
    return 'failed';
  }
}

export async function auditVenues(a: AuditArgs) {
  const { ops, platform } = a;
  const fix = a.fix !== false;
  const budget = a.budgetMs ?? AUDIT_BUDGET_MS;
  const nowFn = a.now || (() => new Date());
  const started = nowFn().getTime();
  const by = a.by || 'unknown';
  const companyId = a.companyId ? String(a.companyId) : null;
  const errors: string[] = [];

  // 1. The venues: every venue in the Platform database (a code text can be asked for at any of
  //    them: kiosk, online, QR, the loyalty app), or one company's. Keyed by the Ops id.
  let allLocs: any[] = [];
  try {
    allLocs = await pagedRows('Platform locations', () => {
      let q = platform.from('locations').select('id, ops_location_id, company_id, name').order('id');
      if (companyId) q = q.eq('company_id', companyId);
      return q;
    });
  } catch (e) { errors.push(`Platform locations: ${errText(e)}`); }
  const venues = allLocs.filter((l) => l.company_id && isUuid(l.ops_location_id));
  const companies = new Set(venues.map((l) => String(l.company_id)));

  // 2. Each venue, a few at once, inside the time budget. The company passed is the row's own.
  const results = await mapLimit(venues, AUDIT_CONCURRENCY, async (v: any) => {
    if (nowFn().getTime() - started > budget) return { location_id: v.ops_location_id, company_id: v.company_id, skipped: 'out of time: runs again tomorrow' };
    return ensureVenueService({ ops, platform, opsLocationId: String(v.ops_location_id), companyId: String(v.company_id), fix, now: nowFn });
  });
  for (const r of results as any[]) if (r && r.error && !r.state) errors.push(`venue: ${r.error}`);

  // 3. Rows that belong to no venue of their company: the legacy company wide rows, and venue rows
  //    whose venue is gone or is another company's. A run for one company reads that company's
  //    rows only, so staff never see another company's ids.
  let legacyRows: any[] = [];
  let orphanRows: any[] = [];
  try {
    // One scan: 'loyalty_otp' is a prefix of both row kinds ('loyalty_otp:<loc>', 'loyalty_otp_service:<loc>').
    const otpRows = await pagedRows('code text rows', () => {
      let q = platform.from('message_templates').select('company_id, message_type').eq('channel', 'sms').like('message_type', `${OVERRIDE_ROW_TYPE}%`).order('id');
      if (companyId) q = q.eq('company_id', companyId);
      return q;
    });
    const sorted = classifyOtpRows(otpRows, allLocs);
    legacyRows = sorted.legacy;
    orphanRows = sorted.orphan;
  } catch (e) { errors.push(`row scan: ${errText(e)}`); }

  // 4. The audit table (Ops, 20261022b). A database without it is said, never a failure.
  let auditTable = 'written';
  const checked = (results as any[]).filter((r: any) => r && !r.skipped && r.state);
  if (checked.length) {
    try {
      const { error } = await ops.from(AUDIT_TABLE).upsert(checked.map((r: any) => auditRow(r, by)), { onConflict: 'location_id' });
      if (error && isMissingRelation(error)) auditTable = 'missing: needs database update 20261022b';
      else if (error) { auditTable = 'failed'; errors.push(`audit table: ${error.message}`); }
    } catch (e) { auditTable = 'failed'; errors.push(`audit table: ${errText(e)}`); }
  }

  // 5. One feed alert per venue still not right, once a week, only after a real fix attempt.
  const alerted: string[] = [];
  if (fix) {
    for (const r of checked) {
      if (isOkState(r.state)) continue;
      try {
        const { data: latest } = await ops.from('activity_events').select('created_at, acked_at')
          .eq('location_id', r.location_id).eq('ref_type', ALERT_REF_TYPE).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (!alertDue({ latest: latest || null, now: nowFn().getTime() })) continue;
        const { error } = await ops.from('activity_events').insert(alertRow(r));
        if (error) errors.push(`alert ${r.location_id}: ${error.message}`); else alerted.push(r.location_id);
      } catch (e) { errors.push(`alert ${r.location_id}: ${errText(e)}`); }
    }
  }

  const summary: any = {
    ...auditSummary(results, { legacy_rows: legacyRows, orphan_rows: orphanRows }),
    by, fix, companies: companies.size, venues: venues.length, audit_table: auditTable, alerted, errors,
    results: checked, ms: nowFn().getTime() - started,
  };
  summary.ok = summary.ok && errors.length === 0;

  // 6. The run row: the watchdog reads it to know the nightly check ran and finished.
  summary.run_row = await recordAuditRun(ops, summary, { companyId, fix, by, now: nowFn });
  console.log(`[loyalty-otp] audit summary ${JSON.stringify({ ...summary, results: undefined })}`);
  return summary;
}
