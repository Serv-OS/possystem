// supabase/functions/_shared/otpServiceRules.js
//
// THE RULES OF A VENUE'S CODE TEXT SERVICE (22 Oct 2026, v5.11.94). Pure: no Deno, no network, no
// database. node --test drives every branch (src/lib/otpServiceRules.test.js); otpService.ts applies
// the decisions against Twilio and the two databases.
//
// WHY. Twilio Verify stamps the SERVICE's friendly name (30 characters) into every loyalty sign in
// code text: "Your <name> verification code is 123456". Each venue has its own service, so its texts
// carry the name set in Back Office for THAT venue. On 21 Oct 2026 four venues of one company had no
// service of their own, creating one failed twice, and their customers' codes went out from the
// shared fallback service under another venue's name. PR 317 (v5.11.90) made the send refuse rather
// than borrow a name. This module is the next step (Peter: "we need to make sure stuff like this
// never fails"): the service is made EAGERLY (when a venue is created, renamed, has its name set or
// has loyalty switched on), its state is checked every night and shown in Back Office with a Fix
// button, and a venue that is still not right raises an alert on the activity feed.
//
// Where the facts live (Platform message_templates, channel 'sms', keyed by the OPS location id,
// which is what every client sends):
//   'loyalty_otp_service:<opsLocationId>'  body_text = the venue's Twilio Verify service sid (VA...)
//   'loyalty_otp:<opsLocationId>'          body_text = the name override set under Messages
// The name a service must carry: the override when set and enabled, else the Ops venue name, else
// the Platform venue name, else the company name. Never a made up name.
//
// WHICH VENUES (22 Oct 2026, review): EVERY venue that is in the Platform database, whatever its
// company's loyalty switch says. A code text can be asked for from the kiosk (its own
// kiosk_loyalty_enabled switch, on by default), the online and QR ordering sign in (shown whatever
// loyalty says) and the loyalty app, so "loyalty is off, no code texts are sent" was not true and
// a venue left out of the check could fail with nobody told.
//
// THE COMPANY is always the one on the venue's Platform row. A company id sent by a caller (the
// kiosk sends one) is only compared with it: a pair that does not match makes nothing, so nobody
// can make text services or rows under a company by naming it.

import { isMissingCheck } from './cronKey.js';

export const SERVICE_ROW_TYPE = 'loyalty_otp_service';
export const OVERRIDE_ROW_TYPE = 'loyalty_otp';
export const AUDIT_KEY_CHECK = 'loyalty_otp_cron_ok';
export const AUDIT_TABLE = 'loyalty_otp_service_audit';
export const AUDIT_RUNS_TABLE = 'loyalty_otp_audit_runs';
/** A full nightly run older than this means the check has stopped (the watchdog says so). */
export const AUDIT_STALE_MINUTES = 26 * 60;
export const ALERT_REF_TYPE = 'loyalty_otp_service';
export const ALERT_ACTOR = 'ServOS nightly check';
export const ALERT_TITLE = 'Loyalty code texts are not set up for this venue';
export const ALERT_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;
export const AUDIT_BUDGET_MS = 60000;
export const AUDIT_CONCURRENCY = 3;
export const TWILIO_NAME_MAX = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** A Twilio Verify service sid: VA and 32 characters. The stored value, trimmed, or null. */
export function verifySidOf(v) {
  const s = String(v ?? '').trim();
  return /^VA[0-9a-zA-Z]{32}$/.test(s) ? s : null;
}

/** The row types for one venue. */
export const sidRowType = (opsLocationId) => `${SERVICE_ROW_TYPE}:${opsLocationId}`;
export const overrideRowType = (opsLocationId) => `${OVERRIDE_ROW_TYPE}:${opsLocationId}`;

/**
 * What Twilio will show for a name: trimmed, runs of white space made one space, cut to 30
 * characters. (Three live venue names carried double or triple spaces; the texts read better
 * without them, and two names that differ only in spacing are the same name.)
 */
export function twilioName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, TWILIO_NAME_MAX);
}

/**
 * May a code for `venueName` go out from a service whose current name is `serviceName`?
 * Only when Twilio would show the same words (case does not matter). An unreadable service
 * name (null) is never good enough.
 */
export function sameServiceName(serviceName, venueName) {
  if (serviceName == null) return false;
  const a = twilioName(serviceName).toLowerCase();
  const b = twilioName(venueName).toLowerCase();
  return !!a && a === b;
}

/**
 * The name this venue's service must carry: the override (when it is enabled and not blank), else
 * the Ops venue name, else the Platform venue name, else the company name. '' when there is none:
 * a service is never created with a made up name.
 */
export function desiredName({ override = '', overrideEnabled = true, opsName = '', platformName = '', companyName = '' } = {}) {
  const pick = (v) => twilioName(v);
  if (overrideEnabled !== false && pick(override)) return pick(override);
  return pick(opsName) || pick(platformName) || pick(companyName) || '';
}

/**
 * What to do for one venue.
 *   sidRow    the venue's stored service sid (null when it has none)
 *   sharedSid the shared fallback service's sid (env), '' when unknown
 *   twilio    { status: 'found' | 'missing' | 'unreadable', name } for sidRow, or null when not read
 *   desired   the name the service must carry (desiredName)
 * Returns { action, state }:
 *   action 'none' | 'create' | 'recreate' | 'rename' | 'wait'
 *   state  'ready' | 'no_name' | 'no_service' | 'points_at_shared' | 'missing_on_twilio'
 *          | 'twilio_unreadable' | 'name_drift'
 */
export function decideService({ sidRow = null, sharedSid = '', twilio = null, desired = '' } = {}) {
  if (!twilioName(desired)) return { action: 'wait', state: 'no_name' };
  const sid = verifySidOf(sidRow);
  if (!sid) return { action: 'create', state: 'no_service' };
  // The shared service is never this venue's own, and it is never renamed: give the venue its own.
  if (sharedSid && sid === String(sharedSid)) return { action: 'create', state: 'points_at_shared' };
  const status = twilio?.status;
  if (status === 'missing') return { action: 'recreate', state: 'missing_on_twilio' };
  if (status !== 'found') return { action: 'wait', state: 'twilio_unreadable' };
  if (sameServiceName(twilio.name, desired)) return { action: 'none', state: 'ready' };
  return { action: 'rename', state: 'name_drift' };
}

/** The states that mean "nothing is wrong". */
export const OK_STATES = new Set(['ready']);
export const isOkState = (state) => OK_STATES.has(String(state));

/**
 * Who may run the audit or an ensure (loyalty-otp is public: the kiosk calls it with the bare key).
 *   service  the caller is the service role
 *   staff    the caller is a signed in member of staff for the venue or company asked about
 *   key      the x-cron-key header ('' when none)
 *   check    { data, error } from rpc(AUDIT_KEY_CHECK, { p_key: key }), or null when not asked
 * Fails closed: no key and not staff, a wrong key, a failed check, or a database without the check
 * (before 20261022b) all refuse. Returns { ok, by, status, reason }.
 */
export function auditAccess({ service = false, staff = false, key = '', check = null } = {}) {
  if (service) return { ok: true, by: 'service_role', status: 200, reason: null };
  if (staff) return { ok: true, by: 'staff', status: 200, reason: null };
  if (!key) return { ok: false, by: null, status: 403, reason: 'not_allowed' };
  if (check?.error && isMissingCheck(check.error)) return { ok: false, by: null, status: 503, reason: 'needs_database_update' };
  if (check?.error) return { ok: false, by: null, status: 401, reason: 'cron_key_check_failed' };
  if (check && check.data === true) return { ok: true, by: 'cron_key', status: 200, reason: null };
  return { ok: false, by: null, status: 401, reason: 'wrong_cron_key' };
}

/** The table is missing (PostgREST PGRST205, Postgres 42P01, or their words). */
export function isMissingRelation(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '');
  return code === 'PGRST205' || code === '42P01' || /could not find the table|relation .* does not exist/i.test(msg);
}

const quote = (s) => `"${twilioName(s)}"`;

/**
 * Plain words for one venue's result, shown in Back Office under Messages > Verification code and
 * in the Add location and rename replies. No dashes.
 */
export function venueWords(result) {
  const r = result || {};
  const twilioSaid = r.twilio_error ? ` The text provider said: ${String(r.twilio_error).trim()}.` : '';
  switch (r.state) {
    case 'ready': return `Text service: ready as ${quote(r.name || r.desired_name)}`;
    case 'no_name': return 'Not set up: this venue has no name yet. Give it a name in Location settings, or set a business name here.';
    case 'no_service': return `Not set up: this venue has no text service of its own yet.${twilioSaid}`;
    case 'points_at_shared': return `Not set up: this venue points at the shared text service, which carries another name.${twilioSaid}`;
    case 'missing_on_twilio': return `Not set up: this venue's text service no longer exists at the text provider.${twilioSaid}`;
    case 'twilio_unreadable': return `Could not check: the text provider could not be read just now.${twilioSaid}`;
    case 'name_drift': return `Not set up: the text service is named ${quote(r.name)} but should be ${quote(r.desired_name)}.${twilioSaid}`;
    case 'not_provisioned': return 'Not set up: this venue is not in the platform database yet. Open Company Admin and provision it.';
    case 'wrong_company': return 'Not set up: the request named a different company from the one this venue belongs to, so nothing was made.';
    case 'db_unreadable': return 'Could not check: the platform database could not be read just now.';
    case 'not_configured': return 'Not set up: the text provider is not configured on the server.';
    default: return `Could not check: ${String(r.error || r.state || 'unknown').trim()}.`;
  }
}

/**
 * Is a new feed alert due for a venue that is still not right? One open alert per venue per week:
 * `latest` is the newest activity_events row for the venue with ref_type 'loyalty_otp_service'
 * ({ created_at, acked_at }), or null. Due when there is none, the last one was acknowledged, or it
 * is older than seven days.
 */
export function alertDue({ latest = null, now = Date.now() } = {}) {
  if (!latest) return true;
  if (latest.acked_at) return true;
  const at = new Date(latest.created_at).getTime();
  if (!Number.isFinite(at)) return true;
  return now - at > ALERT_REPEAT_MS;
}

/** The activity_events row for a venue that is still not right after the fix attempt. */
export function alertRow(result) {
  return {
    location_id: result.location_id,
    kind: 'system',
    severity: 'action',
    title: ALERT_TITLE,
    body: `${venueWords(result)} Open Back Office > Messages > Verification code and press Fix.`.slice(0, 600),
    ref_type: ALERT_REF_TYPE,
    ref_id: String(result.location_id),
    actor_name: ALERT_ACTOR,
  };
}

/**
 * The one line summary of an audit run: counts by state, the venues to alert, and the legacy or
 * orphan rows found. `results` are ensureVenueService answers (a skipped venue has `skipped`).
 */
export function auditSummary(results, extras = {}) {
  const list = Array.isArray(results) ? results : [];
  const byState = {};
  const notReady = [];
  const skipped = [];
  let ready = 0;
  for (const r of list) {
    if (!r) continue;
    if (r.skipped) { skipped.push(r.location_id ?? null); continue; }
    const st = String(r.state || 'unknown');
    byState[st] = (byState[st] || 0) + 1;
    if (isOkState(st)) ready += 1;
    else notReady.push({ location_id: r.location_id ?? null, company_id: r.company_id ?? null, state: st, words: venueWords(r), twilio_error: r.twilio_error ?? null });
  }
  return {
    ok: notReady.length === 0 && skipped.length === 0,
    checked: list.length - skipped.length,
    ready,
    by_state: byState,
    not_ready: notReady,
    skipped,
    legacy_rows: extras.legacy_rows ?? [],
    orphan_rows: extras.orphan_rows ?? [],
  };
}

/** Run fn over list with at most `limit` at once; results in list order. Never rejects for one item. */
export async function mapLimit(list, limit, fn) {
  const items = Array.isArray(list) ? list : [];
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: String(e?.message || e) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit || 1, items.length)) }, worker));
  return out;
}

/**
 * Legacy and orphan code text rows. `rows` are Platform message_templates rows ({ company_id,
 * message_type }) whose type starts 'loyalty_otp'; `locs` are Platform locations ({ company_id,
 * ops_location_id }). Legacy: the old company wide rows. Orphan: a per venue row whose venue is not
 * a venue OF THAT ROW'S COMPANY (gone, or written under another company). The caller passes only
 * the rows and venues it may see: a run for one company passes that company's only.
 */
export function classifyOtpRows(rows, locs) {
  const known = new Set((Array.isArray(locs) ? locs : []).map((l) => `${l.company_id}|${l.ops_location_id}`));
  const legacy = [];
  const orphan = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = String(r?.message_type || '');
    if (t === SERVICE_ROW_TYPE || t === OVERRIDE_ROW_TYPE) { legacy.push({ company_id: r.company_id, message_type: t }); continue; }
    if (!t.startsWith(`${SERVICE_ROW_TYPE}:`) && !t.startsWith(`${OVERRIDE_ROW_TYPE}:`)) continue;
    const loc = t.slice(t.indexOf(':') + 1);
    if (loc && !known.has(`${r.company_id}|${loc}`)) orphan.push({ company_id: r.company_id, message_type: t });
  }
  return { legacy, orphan };
}

/**
 * The row an audit run leaves in Ops loyalty_otp_audit_runs (20261022b), so the watchdog can see
 * that the nightly check ran, and finished, without reading any log. company_id null = a run over
 * every venue (the nightly job); a run for one company says which.
 */
export function auditRunRow(summary, { companyId = null, fix = true, by = 'unknown', at = new Date() } = {}) {
  const s = summary || {};
  const errors = (Array.isArray(s.errors) ? s.errors : []).map((e) => String(e).slice(0, 300)).slice(0, 20);
  return {
    ran_at: (at instanceof Date ? at : new Date(at)).toISOString(),
    run_by: String(by || 'unknown'),
    company_id: companyId || null,
    fix: fix !== false,
    ok: s.ok === true && errors.length === 0,
    checked: Number(s.checked) || 0,
    ready: Number(s.ready) || 0,
    not_ready: Array.isArray(s.not_ready) ? s.not_ready.length : 0,
    skipped: Array.isArray(s.skipped) ? s.skipped.length : 0,
    errors,
    ms: Number.isFinite(Number(s.ms)) ? Math.round(Number(s.ms)) : null,
  };
}

/** Is this result a venue's real state (worth the audit table)? Not when the venue or company did not check out. */
export function recordable(result) {
  return !!result && !!result.state && !['not_provisioned', 'wrong_company', 'db_unreadable'].includes(String(result.state));
}

/**
 * Should a SEND leave its result in the audit table? Only when it tells the watchdog something
 * new about a real venue: the send was refused (customers there cannot sign in), or the send's
 * repair changed something (a refusal earlier may now be cleared). Never for a request whose
 * venue or company did not check out: those are not a venue's state.
 */
export function sendShouldRecord(result, refused) {
  const r = result || {};
  if (!recordable(r)) return false;
  if (refused) return true;
  return !!r.action_taken && r.action_taken !== 'none';
}

/** The audit table row for one venue's result. */
export function auditRow(result, by) {
  const r = result || {};
  return {
    location_id: r.location_id, company_id: r.company_id, ok: isOkState(r.state), state: r.state, action_taken: r.action_taken || 'none',
    service_sid: r.service_sid ?? null, name: r.name ?? null, desired_name: r.desired_name ?? '', twilio_error: r.twilio_error ?? null,
    run_by: String(by || 'unknown'), checked_at: r.checked_at || new Date().toISOString(),
  };
}
