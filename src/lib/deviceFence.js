// src/lib/deviceFence.js: database fence stage 1, the till side (docs/FENCE_STAGE_1_APP.md, section 2).
//
// Pure helpers only (no Supabase, no window, no storage). The callers inject the rpc
// function and the storage writes, so node:test drives every branch, including the
// fallback to today's path when the new server functions do not exist yet.
//
// ORDER OF RELEASE: this app release can go live BEFORE Peter runs
// 20260919a_OPS_fence_1_safe_now.sql. Until then claim_device_v2, reclaim_device,
// device_status, device_issue_secret and device_heartbeat do not exist, PostgREST answers
// "function not found" (PGRST202, or 42883 from Postgres), and every caller falls back to
// the path the live app uses today.
//
// STAGE 1 CLEANUP (after 20260919b has run on Ops): delete the legacy branches marked
// "FENCE STAGE 1 FALLBACK" here and in their callers (grep that tag). After file 2 codes are
// single use and devices are unreadable to strangers, so the legacy code path is dead.

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

/** Codes are compared without spaces or dashes, in capitals (the server does the same). */
export function normalizePairingCode(code) {
  return String(code || '').replace(/[\s-]+/g, '').toUpperCase();
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
  if (reason === 'locked') return 'Too many pairing attempts. Wait 15 minutes and try again.';
  if (error && error.message) return 'Pairing failed, try again (' + error.message + ')';
  return 'Pairing failed, try again';
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
 * An OfflineQueue item parked because the server refused it while the till had no link.
 * On relink it is released (attempts and status reset) and replayed through every existing
 * guard. A stale quarantine (failed_stale) and a dismissed item are never released here, and
 * the buffered time (ts) is kept so the staleness rules still judge its real age.
 */
export function isParkedPermissionItem(item) {
  if (!item || item.status === 'dismissed' || item.status === 'failed_stale') return false;
  if (item.status !== 'retry_pending' && item.status !== 'failed_permanent' && !item.permanentFailure) return false;
  return isPermissionError(item.lastError || '');
}

export function releaseParkedItem(item) {
  return { ...item, attempts: 0, status: 'pending', permanentFailure: false, lastError: null, lastFailedAt: null };
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
 * @param {boolean}  o.allowLegacy      run today's claim when the new functions are missing (boot only)
 * @returns {Promise<{outcome: string, reason?: string, message?: string}>}
 *   outcome: 'skipped' | 'legacy' | 'unsupported' | 'linked' | 'relinked' | 'lost' | 'unknown'
 */
export async function runDeviceLink({ rpc, device, readLegacyCode, saveSecret, saveLegacyCode, allowLegacy = true } = {}) {
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

  // 3. Not bound. A till paired before this release still has its code (until file 2).
  if (device.pairingCode) {
    const c = await call('claim_device_v2', { p_code: device.pairingCode });
    if (!c.error && c.data && c.data.ok && String(c.data.device_id) === String(device.id)) {
      keepSecret(c.data);
      return { outcome: 'relinked' };
    }
    if (c.error && !isMissingRpc(c.error)) return { outcome: 'unknown', message: c.error.message };
    if (!c.error && c.data && c.data.ok === false && !secretRefusal) secretRefusal = c.data;
  }

  const reason = (secretRefusal && secretRefusal.reason) || 'not_bound';
  return { outcome: 'lost', reason, message: (secretRefusal && secretRefusal.message) || 'This till is not paired.' };
}
