// src/lib/deviceFence.js: database fence stage 1, the till side (docs/FENCE_STAGE_1_APP.md, section 2).
//
// Pure helpers only (no Supabase, no window, no storage). The callers inject the rpc
// function and the storage writes, so node:test drives every branch, including the
// fallback to today's path when the new server functions do not exist yet.
//
// ORDER OF RELEASE: this app release can go live BEFORE Peter runs
// 20260919a1_OPS_fence_identity_devices.sql. Until then claim_device_v2, reclaim_device,
// device_status, device_issue_secret and device_heartbeat do not exist, PostgREST answers
// "function not found" (PGRST202, or 42883 from Postgres), and every caller falls back to
// the path the live app uses today.
//
// STAGE 1 CLEANUP (after 20260919b has run on Ops): delete the legacy branches marked
// "FENCE STAGE 1 FALLBACK" here and in their callers (grep that tag). After file 2 codes are
// single use and devices are unreadable to strangers, so the legacy code path is dead.

import { isTransportFailure } from './netRetry.js';

/** What this build can do. File 2 waits until every active device reports fence_v1. */
export const FENCE_CAPS = Object.freeze(['fence_v1', 'device_secret']);

/** The server function does not exist (yet): fall back to today's path. */
export function isMissingRpc(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === 'PGRST202' || code === '42883') return true;
  const msg = String(error.message || error.hint || '');
  return /could not find the function/i.test(msg) || /function [^\s]+ does not exist/i.test(msg);
}

/** A write refused by row level security or a revoked grant (the till lost its link). */
export function isPermissionError(error) {
  if (!error) return false;
  if (typeof error === 'string') return /row-level security|permission denied|\b42501\b/i.test(error);
  if (String(error.code || '') === '42501') return true;
  const msg = String(error.message || error.lastError || '');
  return /row-level security|permission denied|\b42501\b/i.test(msg);
}

/**
 * Codes are compared without spaces or dashes, in capitals (the server does the same). Fix round
 * (19 Sep): anything that is not a letter or a digit is dropped, so a code typed with the long
 * dash a phone keyboard or autocorrect puts in, dots or a stray space still
 * pairs.
 */
export function normalizePairingCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/** The server code alphabet (20260919a1 _fence_random_code): no 0, 1, I or O. */
export const SERVER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SERVER_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{12}$/;

/** A code in the server format (12 symbols), the only kind that pairs once 20260919a1 is in. */
export function isServerPairingCode(code) {
  return SERVER_CODE_RE.test(normalizePairingCode(code));
}

/**
 * A plain hint for a code that is clearly a mistyped SERVER code, shown before anything is sent.
 * The server answers every code that is not in its format "no longer valid" (it treats it as a
 * code from before the fence), which would send staff to Back Office for a new code when they
 * only misread one symbol. Old browser codes (a word and 4 digits, at most 10 symbols) are never
 * hinted: they still pair while 20260919a1 is not run.
 * Returns null (send it) or the words to show.
 */
export function pairingCodeHint(code) {
  const c = normalizePairingCode(code);
  if (!c) return 'Enter the pairing code from Back Office.';
  if (c.length === 12 && !SERVER_CODE_RE.test(c)) {
    return 'Check the code: pairing codes never use 0, 1, I or O (they are shown as XXXX-XXXX-XXXX).';
  }
  if (c.length >= 11 && c.length !== 12) {
    return 'A pairing code has 12 letters and numbers, shown as XXXX-XXXX-XXXX. Check the code.';
  }
  return null;
}

/** A server code (12 symbols) is shown XXXX-XXXX-XXXX; an old short code is shown as is. */
export function formatPairingCode(code) {
  const c = normalizePairingCode(code);
  if (c.length !== 12) return String(code || '');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}

/** Plain words for a claim refusal (the server sends a message; this is the backup). */
export function claimRefusalMessage(data, error) {
  if (data && data.message) return data.message;
  const reason = data && data.reason;
  if (reason === 'not_found') return 'Pairing code not found. Check the code in Back Office.';
  if (reason === 'expired') return 'This pairing code has expired. Issue a new one in Back Office.';
  if (reason === 'already_paired') return 'This device is already paired to another till. Issue a new code in Back Office to move it.';
  if (reason === 'locked') return 'Pairing is paused for a moment. Try again shortly.';   // the server stopped locking on 23 Sep 2026; kept for an old database
  // A request that never completed is the network, not the code. Apple's reviewer saw the
  // raw "TypeError: Load failed" (22 Sep 2026) and read it as a broken app.
  if (isTransportFailure(error)) {
    return 'Could not reach ServOS. Check the internet connection, then tap Pair this device again.';
  }
  if (error && error.message) return 'Pairing failed, try again (' + error.message + ')';
  return 'Pairing failed, try again';
}

/** Waits between pairing attempts when the request never left the device. */
export const CLAIM_RETRY_DELAYS_MS = Object.freeze([600, 1500]);

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Claim a device, trying again when the request never completed.
 *
 * WHY THIS IS SAFE TO REPEAT. claim_device_v2 binds the device to THIS session's uid.
 * If the first try never arrived, the second one pairs. If it did arrive and only the
 * reply was lost, the code is already spent, but _device_claim_core sees this session
 * holding that device and answers ok with already_bound (dry run against Ops, 22 Sep
 * 2026), so the till pairs either way. A refusal (ok:false) or any answered error is
 * returned at once: only a transport failure is retried.
 */
export async function claimDeviceWithRetry({ rpc, code, delays = CLAIM_RETRY_DELAYS_MS, sleep = defaultSleep } = {}) {
  let result = { data: null, error: null };
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    result = await rpc(code);
    if (!result || !isTransportFailure(result.error)) return result;
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  return result;
}

/**
 * Build the rpos-device record from a claim_device_v2 answer. No pairing code is kept:
 * codes are single use once the fence is in, the device secret replaces it.
 */
export function deviceEntryFromClaim(data, { now = () => new Date().toISOString() } = {}) {
  if (!data || !data.device_id) return null;
  return {
    id: data.device_id,
    name: data.name,
    type: data.type,
    locationId: data.location_id,
    locationName: (data.location && data.location.name) || 'Unknown',
    orgId: (data.location && data.location.org_id) || null,
    profileId: data.profile_id || null,
    deviceSecret: data.device_secret || null,
    pairedAt: now(),
  };
}

/**
 * Read of the till's own devices row (App.jsx refreshDevice, contract A5).
 * - 'removed': the read SUCCEEDED and the row says status removed. The only certain removal.
 * - 'present': the row came back.
 * - 'unknown': a read error, or no row (after file 2 a till that lost its link cannot see
 *   its own row, so "no row" proves nothing on its own).
 */
export function classifyDeviceRead({ error, row } = {}) {
  if (error) return 'unknown';
  if (!row) return 'unknown';
  if (row.status === 'removed') return 'removed';
  return 'present';
}

/**
 * What refreshDevice does after a read that was not 'present'.
 * - statusSupported false (the fence functions do not exist yet): reads are still open, so
 *   a successful read with no row is today's certain removal. FENCE STAGE 1 FALLBACK.
 * - otherwise only a relink that the server answered 'invalid' (the device was unpaired or
 *   removed in Back Office) shows the pairing screen; everything else keeps the till and
 *   shows the banner.
 * Returns 'removed' | 'pair' | 'banner' | 'ok'.
 */
export function decideDeviceRefresh({ read, readError, statusSupported, linkOutcome, linkReason } = {}) {
  if (read === 'removed') return 'removed';
  if (read === 'present') return 'ok';
  if (readError) return 'banner';
  if (statusSupported === false) return 'removed';
  if (linkOutcome === 'linked' || linkOutcome === 'relinked') return 'ok';
  if (linkOutcome === 'lost' && linkReason === 'invalid') return 'pair';
  return 'banner';
}

/**
 * A read of shared rows (active_sessions, order_queue, bar_tabs, kds_tickets) that returned
 * nothing proves nothing while this till may have lost its link: after file 2 row level
 * security hides every row from it. Contract A9: an empty read then is "unknown", never
 * "no tables" or "no tickets". A read that returned rows is real either way.
 */
export function trustSharedRead({ linkUncertain, rowCount } = {}) {
  if (!linkUncertain) return true;
  return Number(rowCount) > 0;
}

/**
 * Back Office: get a pairing code for a device from the SERVER (contract A6). A device that is
 * paired right now answers reason 'paired'; confirmPaired() is asked ("this till is in use")
 * and the call is repeated with p_force. FENCE STAGE 1 FALLBACK: while issue_pairing_code does
 * not exist, legacyIssue() writes a browser made code the way the live Back Office does.
 * Resolves { ok, code, expires_at, legacy } or { ok: false, reason, message }.
 */
export async function issuePairingCodeWithFallback({ rpc, deviceId, force = false, confirmPaired, legacyIssue } = {}) {
  if (!rpc || !deviceId) return { ok: false, reason: 'missing', message: 'No device.' };
  const ask = async (f) => {
    try { return (await rpc('issue_pairing_code', { p_device_id: deviceId, p_force: f })) || {}; }
    catch (e) { return { error: e || { message: 'failed' } }; }
  };
  let r = await ask(!!force);
  if (r.error && isMissingRpc(r.error)) {
    if (!legacyIssue) return { ok: false, reason: 'unsupported', message: 'Pairing codes are not available yet.' };
    const code = await legacyIssue();
    return code ? { ok: true, code, expires_at: null, legacy: true } : { ok: false, reason: 'legacy_failed', message: 'Could not issue a new code. The previous code is still the valid one.' };
  }
  if (r.error) return { ok: false, reason: 'error', message: r.error.message || 'Could not issue a code.' };
  const d = r.data || {};
  if (d.ok === false && d.reason === 'paired' && !force) {
    const yes = confirmPaired ? await confirmPaired(d.message) : false;
    if (!yes) return { ok: false, reason: 'cancelled', message: 'No new code issued. The till stays paired.' };
    r = await ask(true);
    if (r.error) return { ok: false, reason: 'error', message: r.error.message || 'Could not issue a code.' };
    return r.data && r.data.ok ? { ok: true, code: r.data.code, expires_at: r.data.expires_at || null } : { ok: false, reason: (r.data && r.data.reason) || 'error', message: (r.data && r.data.message) || 'Could not issue a code.' };
  }
  if (d.ok) return { ok: true, code: d.code, expires_at: d.expires_at || null };
  return { ok: false, reason: d.reason || 'error', message: d.message || 'Could not issue a code.' };
}

/** The banner words (contract A7). Plain, calm, and says the open work is safe. */
export function linkBannerText({ kind, venueName } = {}) {
  const what = kind === 'kiosk' ? 'This kiosk' : 'This till';
  const where = venueName ? ` to ${venueName}` : ' to its venue';
  return {
    title: `${what} is not linked${where}.`,
    body: 'Your open orders are safe on this till. Ask a manager to pair it again. Bar tabs hidden on this till come back once it is paired, and work taken meanwhile is sent then.',
  };
}

/** Link state from a device_status / device_heartbeat answer. */
export function linkStateFromStatus({ data, error, localDeviceId } = {}) {
  if (error) return isMissingRpc(error) ? 'unsupported' : 'unknown';
  if (!data || typeof data !== 'object') return 'unknown';
  if (data.bound !== true) return 'unbound';
  if (localDeviceId && data.device_id && String(data.device_id) !== String(localDeviceId)) return 'unbound';
  return 'bound';
}

/** Should the red banner show? Only when the server said so; never on a guess. */
export function shouldShowLinkBanner(state) {
  return !!(state && state.lost === true);
}

/**
 * OfflineQueue status of an update or delete that changed 0 rows while this device was not
 * linked (fix round 2, lib/rowWriteFence.js). It is not retried until the device is linked
 * again, and it is never counted as a failure.
 */
export const PARKED_LINK_STATUS = 'parked_link';

/**
 * An OfflineQueue item parked because the server refused it while the till had no link.
 * On relink it is released (attempts and status reset) and replayed through every existing
 * guard. A stale quarantine (failed_stale) and a dismissed item are never released here, and
 * the buffered time (ts) is kept so the staleness rules still judge its real age.
 * Fix round 2: an update or delete that changed 0 rows while unlinked ('parked_link') too.
 */
export function isParkedPermissionItem(item) {
  if (!item || item.status === 'dismissed' || item.status === 'failed_stale') return false;
  if (item.status === PARKED_LINK_STATUS) return true;
  if (item.status !== 'retry_pending' && item.status !== 'failed_permanent' && !item.permanentFailure) return false;
  return isPermissionError(item.lastError || '');
}

export function releaseParkedItem(item) {
  return { ...item, attempts: 0, status: 'pending', permanentFailure: false, lastError: null, lastFailedAt: null };
}

/**
 * Contract A12 (fix round): when are parked permission writes released?
 * - 'rpos-device-relinked': always (the link came back during this page).
 * - 'rpos-device-linked': ONCE per page. After "Pair again" (or any pairing) the page reloads and
 *   the boot link answers 'linked', not 'relinked', so the relinked event never fires and the
 *   writes refused while the till was unlinked would stay parked for good. Once per page, because
 *   the link check answers 'linked' again on every wake and after every refusal: releasing each
 *   time would replay a write refused for another reason, be refused again and loop.
 * Anything else (lost, unknown, unsupported, legacy) releases nothing.
 */
export function shouldReleaseParkedOnLink({ event, outcome, releasedOnLinkThisPage = false } = {}) {
  if (event === 'rpos-device-relinked' || outcome === 'relinked') return true;
  if (event === 'rpos-device-linked' || outcome === 'linked') return !releasedOnLinkThisPage;
  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Contract A10 and A13: the device_heartbeat arguments. p_device_id is the device id saved on this
 * till (or the kiosk id), so the server can record a device that is switched on but not linked
 * (file B refuses to run while one is). Only a real uuid is sent: anything else would make the
 * whole call fail with 22P02 and the heartbeat would be lost.
 */
export function heartbeatArgs({ version, caps = FENCE_CAPS, deviceId } = {}) {
  const args = { p_app_version: version == null ? null : String(version), p_caps: [...(caps || [])] };
  if (deviceId && UUID_RE.test(String(deviceId))) args.p_device_id = String(deviceId);
  return args;
}

/**
 * Contract A14: while device_heartbeat does not exist (20260919a1 not run), the till writes its
 * own last_seen, app_version and capabilities, so file A can tell a till that really runs this
 * release from one that only reports a new version number. That is the whole gate on file A
 * (fix round 3, 19 Sep): 5.9.10 and 5.9.11 both shipped without a line of the fence app, so a
 * version comparison waved the entire fleet through. Only those three columns: after file A a
 * linked till may write nothing else on its row, and the status is never touched here.
 * client_caps arrives with 20260919_OPS_fence_0_caps.sql (runbook step 1b); until that is run
 * the column does not exist, and sendDeviceHeartbeat drops it and writes the other two.
 * FENCE STAGE 1 FALLBACK.
 */
export function legacyHeartbeatPatch({ version, caps = FENCE_CAPS, now = () => new Date().toISOString() } = {}) {
  return {
    last_seen: now(),
    app_version: version == null ? null : String(version).slice(0, 40),
    client_caps: [...(caps || [])],
  };
}

/** A write refused because the column is not there yet (20260919_OPS_fence_0_caps.sql not run). */
export function isMissingColumn(error, column) {
  if (!error) return false;
  if (String(error.code || '') === 'PGRST204' || String(error.code || '') === '42703') return true;
  const msg = String(error.message || error.hint || '');
  if (column && new RegExp(`column [^\\s]*${column}[^\\s]* does not exist`, 'i').test(msg)) return true;
  return /could not find the '[^']+' column/i.test(msg);
}

/**
 * Re-link this till at boot (contract A2), falling back to today's path while the fence
 * functions do not exist.
 *
 * @param {Function} o.rpc              (name, args) => Promise<{data, error}>
 * @param {object}   o.device           { id, deviceSecret, pairingCode }
 * @param {Function} o.readLegacyCode   () => Promise<string|null>, today's SELECT pairing_code (fallback only)
 * @param {Function} o.saveSecret       (secret) => void
 * @param {Function} o.saveLegacyCode   (code) => void (fallback only)
 * @param {Function} o.forgetLegacyCode () => void, drop the saved pairing code (contract A15)
 * @param {boolean}  o.allowLegacy      run today's claim when the new functions are missing (boot only)
 * @returns {Promise<{outcome: string, reason?: string, message?: string}>}
 *   outcome: 'skipped' | 'legacy' | 'unsupported' | 'linked' | 'relinked' | 'lost' | 'unknown'
 */
export async function runDeviceLink({ rpc, device, readLegacyCode, saveSecret, saveLegacyCode, forgetLegacyCode, allowLegacy = true } = {}) {
  if (!rpc || !device || !device.id) return { outcome: 'skipped' };
  const call = async (name, args) => {
    try { return (await rpc(name, args)) || {}; } catch (e) { return { error: e || { message: 'failed' } }; }
  };
  const legacy = async () => {
    if (!allowLegacy) return { outcome: 'unsupported' };
    // FENCE STAGE 1 FALLBACK: today's boot claim (read the code once, then claim_device).
    let code = device.pairingCode || null;
    if (!code && readLegacyCode) {
      try { code = await readLegacyCode(); } catch { code = null; }
      if (code && saveLegacyCode) { try { saveLegacyCode(code); } catch { /* quota */ } }
    }
    if (code) await call('claim_device', { p_code: code });
    return { outcome: 'legacy' };
  };
  const keepSecret = (data) => {
    if (data && data.device_secret && saveSecret) { try { saveSecret(data.device_secret); } catch { /* quota */ } }
  };

  // 1. A device secret re-links a till whose login changed.
  let secretRefusal = null;
  if (device.deviceSecret) {
    const r = await call('reclaim_device', { p_device_id: device.id, p_device_secret: device.deviceSecret });
    if (r.error && isMissingRpc(r.error)) return legacy();
    if (!r.error && r.data && r.data.ok) {
      return { outcome: r.data.already_bound ? 'linked' : 'relinked' };
    }
    if (!r.error && r.data && r.data.ok === false) secretRefusal = r.data;
    else if (r.error) return { outcome: 'unknown', message: r.error.message };
  }

  // 2. Is this session already the paired till?
  const s = await call('device_status');
  const st = linkStateFromStatus({ data: s.data, error: s.error, localDeviceId: device.id });
  if (st === 'unsupported') return legacy();
  if (st === 'unknown') return { outcome: 'unknown', message: s.error && s.error.message };
  if (st === 'bound') {
    if (!device.deviceSecret || s.data.has_secret !== true) {
      const iss = await call('device_issue_secret');
      if (!iss.error && iss.data && iss.data.ok) keepSecret(iss.data);
    }
    return { outcome: 'linked' };
  }

  // 3. Not bound. Contract A15 (fix round): a code saved before this release can never re-link
  // a till once the fence functions exist (file A retired every old code, and there is no
  // re-link by code at all: only the device secret re-links). So it is not sent (it would only
  // be answered "no longer valid"), and it is dropped from rpos-device. Only the device
  // secret, or pairing again with a new code from Back Office, links this till again.
  if (device.pairingCode && forgetLegacyCode) {
    try { forgetLegacyCode(); } catch { /* storage */ }
  }

  const reason = (secretRefusal && secretRefusal.reason) || 'not_bound';
  return { outcome: 'lost', reason, message: (secretRefusal && secretRefusal.message) || 'This till is not paired.' };
}

/**
 * Fix round 2 (HIGH): what a heartbeat answer asks for next. The release goes out BEFORE file A,
 * so a till that stays on screen booted while device_status did not exist and never asked for its
 * device secret. After file A its next heartbeat says bound, so the heartbeat itself must start
 * the secret collection (device_issue_secret, through the normal re-link), or the till keeps
 * running without one until it restarts and cannot re-link by itself if its login changes.
 *   linkState       linkStateFromStatus of the heartbeat answer
 *   serverHasSecret the answer's has_secret
 *   localHasSecret  this device holds its secret (rpos-device.deviceSecret or rpos-kiosk-secret)
 *   lost, suspect   the link monitor's state
 * Returns 'relink' (check and re-link), 'collect_secret' (bound: collect the secret) or 'none'.
 */
export function heartbeatNextStep({ linkState, serverHasSecret, localHasSecret, lost = false, suspect = false } = {}) {
  if (linkState === 'unbound') return lost ? 'none' : 'relink';
  if (linkState !== 'bound') return 'none';
  if (lost || suspect) return 'relink';
  if (serverHasSecret !== true || !localHasSecret) return 'collect_secret';
  return 'none';
}

/** How long a confirmed link is trusted when the check before a card payment cannot reach the server. */
export const CARD_LINK_STALE_MS = 3 * 60 * 1000;

/** How long "the fence functions do not exist yet" is trusted before a card payment asks again. */
export const CARD_UNSUPPORTED_TRUST_MS = 90 * 1000;

/**
 * Fix round 2: does a card payment need a fresh device_status first? Always, except while the
 * fence functions do not exist yet (before 20260919a1), which a heartbeat or check said in the last
 * 90 seconds on a device that is neither lost nor suspect: there is no link to check then, and a
 * round trip before every card payment would only slow the till. The heartbeat asks every 60
 * seconds, so within a minute of file A every payment is checked. FENCE STAGE 1 FALLBACK.
 */
export function cardLinkCheckNeeded({ supported, lost = false, suspect = false, unsupportedAgoMs = null, trustMs = CARD_UNSUPPORTED_TRUST_MS } = {}) {
  if (lost || suspect) return true;
  if (supported !== false) return true;
  if (unsupportedAgoMs === null || unsupportedAgoMs === undefined || unsupportedAgoMs < 0) return true;
  return unsupportedAgoMs > trustMs;
}

/**
 * Fix round 2 (HIGH): may this device START a card payment? After 20260919a1 (and for every
 * kind after 20260919b) a till or kiosk that is not linked cannot save the check the card pays
 * for: the kiosk's closed_checks insert is refused after the card was charged, and nothing keeps
 * that order. So the link is checked BEFORE the reader or terminal starts.
 *   linkState      a fresh device_status: 'bound' | 'unbound' | 'unsupported' | 'unknown' | 'not_device'
 *   relinkOutcome  when unbound: the answer of one re-link with the device secret
 *   lost           the monitor's state (the server said this device is not linked)
 *   suspect        a write was refused and the link has not been confirmed since
 *   supported      false while the fence functions do not exist (today's path)
 *   boundAgoMs     since the server last said this device is linked (null: never on this page)
 *   hasSecret      this device holds its device secret (only file A's own functions hand one out)
 * Returns { ok, reason }: reason 'not_device' | 'unsupported' | 'linked' | 'relinked' |
 * 'recently_linked' | 'never_fenced' | 'not_linked' | 'unknown'.
 *
 * NEVER WORSE THAN TODAY (fix round, 20 Sep 2026). The release goes out BEFORE file a1, so on a
 * device that has never had a fence answer the only thing this check can add is a refusal the
 * live app would not have made: a first card payment whose device_status does not answer within
 * 5 seconds came out 'unknown' and was refused, and on an Adyen terminal that IS the reader (the
 * on-device nexo path) that payment works today with Supabase unreachable. So a device that has
 * NOTHING to go on takes today's path: no fence answer on this page (supported null), never told
 * it is linked (boundAgoMs null), and no device secret, which only claim_device_v2, reclaim_device
 * or device_issue_secret can have handed out. It closes by itself: once a1 is in, the first
 * heartbeat collects the secret, and from then on this branch can never be reached. It never
 * weakens a real refusal: 'unbound', a lost monitor state and a suspect one all refuse above it.
 */
export function cardLinkDecision({ linkState, relinkOutcome = null, lost = false, suspect = false, supported = null, boundAgoMs = null, hasSecret = false, maxStaleMs = CARD_LINK_STALE_MS } = {}) {
  if (linkState === 'not_device') return { ok: true, reason: 'not_device' };
  if (linkState === 'unsupported') return { ok: true, reason: 'unsupported' };   // FENCE STAGE 1 FALLBACK: before 20260919a1
  if (linkState === 'bound') return { ok: true, reason: 'linked' };
  if (linkState === 'unbound') {
    if (relinkOutcome === 'relinked' || relinkOutcome === 'linked') return { ok: true, reason: 'relinked' };
    return { ok: false, reason: 'not_linked' };
  }
  // The check itself failed (network). Never on a device the server said is not linked.
  if (lost) return { ok: false, reason: 'not_linked' };
  if (supported === false) return { ok: true, reason: 'unsupported' };           // FENCE STAGE 1 FALLBACK
  if (boundAgoMs !== null && boundAgoMs !== undefined && boundAgoMs >= 0 && boundAgoMs <= maxStaleMs) {
    return { ok: true, reason: 'recently_linked' };
  }
  // Nothing to go on, and nothing the fence has ever handed this device: today's path.
  // FENCE STAGE 1 FALLBACK (see the note above; it closes itself once a secret exists).
  if (!suspect && supported === null && (boundAgoMs === null || boundAgoMs === undefined) && !hasSecret) {
    return { ok: true, reason: 'never_fenced' };
  }
  return { ok: false, reason: 'unknown' };
}

/** Plain words for a card payment refused by cardLinkDecision (kiosk: for the customer). */
export function cardLinkRefusalMessage({ kind, venueName, reason } = {}) {
  if (kind === 'kiosk') {
    return 'This kiosk cannot take card payments right now. Please ask a member of staff. Nothing has been charged.';
  }
  if (reason === 'unknown') {
    return 'Could not check that this till is linked, so the card payment was not started. Check the connection and try again, take cash, or use another till. Nothing has been charged.';
  }
  const where = venueName ? ` to ${venueName}` : ' to its venue';
  return `This till is not linked${where}, so it cannot take card payments. Nothing has been charged. Take cash or use another till, and ask a manager to pair it again.`;
}
