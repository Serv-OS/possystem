// deviceFence.test.js: database fence stage 1, the till side (docs/FENCE_STAGE_1_APP.md A1 to A11).
//
// The rules under test:
//   - every new server call falls back to today's path while 20260919a1 is not run (PGRST202);
//   - a till is never unpaired because it could not read its own row (only status 'removed' is);
//   - an empty read while the link is uncertain is "unknown", never "no tables / no tickets";
//   - writes parked by a refusal are released on relink, never a stale quarantine;
//   - pairing codes are normalised and a refused claim never pairs locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FENCE_CAPS, isMissingRpc, isMissingColumn, isPermissionError, normalizePairingCode, formatPairingCode,
  claimRefusalMessage, deviceEntryFromClaim, classifyDeviceRead, decideDeviceRefresh,
  trustSharedRead, linkStateFromStatus, shouldShowLinkBanner, isParkedPermissionItem,
  releaseParkedItem, runDeviceLink, issuePairingCodeWithFallback, linkBannerText,
  pairingCodeHint, isServerPairingCode, SERVER_CODE_ALPHABET, shouldReleaseParkedOnLink,
  heartbeatArgs, legacyHeartbeatPatch, PARKED_LINK_STATUS, heartbeatNextStep, cardLinkDecision,
  cardLinkRefusalMessage, cardLinkCheckNeeded, CARD_LINK_STALE_MS, CARD_UNSUPPORTED_TRUST_MS,
  claimDeviceWithRetry, CLAIM_RETRY_DELAYS_MS,
} from './deviceFence.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const MISSING = { code: 'PGRST202', message: 'Could not find the function public.device_status without parameters in the schema cache' };

// ── small rules ──────────────────────────────────────────────────────────────

test('fence caps are exactly what file 2 waits for', () => {
  assert.deepEqual([...FENCE_CAPS], ['fence_v1', 'device_secret']);
  assert.ok(Object.isFrozen(FENCE_CAPS));
});

test('a missing server function is recognised by code or message, nothing else', () => {
  assert.equal(isMissingRpc(MISSING), true);
  assert.equal(isMissingRpc({ code: '42883', message: 'function public.x(text) does not exist' }), true);
  assert.equal(isMissingRpc({ message: 'function public.claim_device_v2 does not exist' }), true);
  assert.equal(isMissingRpc({ code: '42501', message: 'permission denied for function x' }), false);
  assert.equal(isMissingRpc({ message: 'Failed to fetch' }), false);
  assert.equal(isMissingRpc(null), false);
});

test('a refused write is recognised (42501, row level security, permission denied)', () => {
  assert.equal(isPermissionError({ code: '42501', message: 'x' }), true);
  assert.equal(isPermissionError({ message: 'new row violates row-level security policy for table "order_queue"' }), true);
  assert.equal(isPermissionError('permission denied for table print_jobs'), true);
  assert.equal(isPermissionError({ code: '23505', message: 'duplicate key' }), false);
  assert.equal(isPermissionError({ message: 'Failed to fetch' }), false);
  assert.equal(isPermissionError(null), false);
});

test('pairing codes ignore spaces, dashes and case; server codes show as XXXX-XXXX-XXXX', () => {
  assert.equal(normalizePairingCode(' abcd-efgh ijkl '), 'ABCDEFGHIJKL');
  assert.equal(normalizePairingCode('donut-4821'), 'DONUT4821');
  assert.equal(normalizePairingCode(null), '');
  assert.equal(formatPairingCode('abcdefghijkl'), 'ABCD-EFGH-IJKL');
  assert.equal(formatPairingCode('ABCD-EFGH-IJKL'), 'ABCD-EFGH-IJKL');
  assert.equal(formatPairingCode('DONUT-4821'), 'DONUT-4821', 'an old short code is shown as it is');
});

test('claim refusals always give plain words', () => {
  assert.equal(claimRefusalMessage({ ok: false, reason: 'expired', message: 'Server words' }), 'Server words');
  assert.match(claimRefusalMessage({ ok: false, reason: 'expired' }), /expired/);
  // 23 Sep 2026: the server no longer locks pairing (migration 20260923a); the words
  // stay for an old database and must not promise a wait that no longer exists.
  assert.match(claimRefusalMessage({ ok: false, reason: 'locked' }), /Try again shortly/);
  assert.match(claimRefusalMessage(null, { message: 'offline' }), /try again \(offline\)/);
  assert.equal(claimRefusalMessage(null, null), 'Pairing failed, try again');
});

test('the rpos-device record is built from claim_device_v2 and keeps no code', () => {
  const e = deviceEntryFromClaim({
    ok: true, device_id: 'd1', name: 'Till 1', type: 'pos', location_id: 'L1', profile_id: 'p1',
    device_secret: 's3cret', location: { id: 'L1', name: 'Provo', org_id: 'O1', timezone: 'America/Denver' },
  }, { now: () => '2026-09-18T10:00:00.000Z' });
  assert.deepEqual(e, {
    id: 'd1', name: 'Till 1', type: 'pos', locationId: 'L1', locationName: 'Provo', orgId: 'O1',
    profileId: 'p1', deviceSecret: 's3cret', pairedAt: '2026-09-18T10:00:00.000Z',
  });
  assert.ok(!('pairingCode' in e), 'codes are single use after the fence');
  assert.equal(deviceEntryFromClaim({ ok: false }), null);
});

// ── A5: never unpair on "can't read my row" ──────────────────────────────────

test('only a successful read of status removed is a removal', () => {
  assert.equal(classifyDeviceRead({ error: { message: 'Failed to fetch' }, row: null }), 'unknown');
  assert.equal(classifyDeviceRead({ error: null, row: null }), 'unknown');
  assert.equal(classifyDeviceRead({ error: null, row: { status: 'removed' } }), 'removed');
  assert.equal(classifyDeviceRead({ error: null, row: { status: 'active' } }), 'present');
});

test('refreshDevice decisions: unknown keeps the till, only the server can send it to pairing', () => {
  assert.equal(decideDeviceRefresh({ read: 'removed' }), 'removed');
  assert.equal(decideDeviceRefresh({ read: 'present' }), 'ok');
  assert.equal(decideDeviceRefresh({ read: 'unknown', readError: { message: 'net' } }), 'banner', 'a read error never unpairs');
  // FENCE STAGE 1 FALLBACK: before 20260919a1 reads are open, so no row is today's certain removal.
  assert.equal(decideDeviceRefresh({ read: 'unknown', statusSupported: false }), 'removed');
  assert.equal(decideDeviceRefresh({ read: 'unknown', statusSupported: true, linkOutcome: 'linked' }), 'ok');
  assert.equal(decideDeviceRefresh({ read: 'unknown', statusSupported: true, linkOutcome: 'relinked' }), 'ok');
  assert.equal(decideDeviceRefresh({ read: 'unknown', statusSupported: true, linkOutcome: 'lost', linkReason: 'invalid' }), 'pair');
  assert.equal(decideDeviceRefresh({ read: 'unknown', statusSupported: true, linkOutcome: 'lost', linkReason: 'not_bound' }), 'banner');
  assert.equal(decideDeviceRefresh({ read: 'unknown', statusSupported: true, linkOutcome: 'unknown' }), 'banner');
});

// ── A9: an empty read while unlinked is unknown ──────────────────────────────

test('an empty read is believed only while the link is certain', () => {
  assert.equal(trustSharedRead({ linkUncertain: false, rowCount: 0 }), true);
  assert.equal(trustSharedRead({ linkUncertain: false, rowCount: 3 }), true);
  assert.equal(trustSharedRead({ linkUncertain: true, rowCount: 0 }), false, 'never "no tables"');
  assert.equal(trustSharedRead({ linkUncertain: true, rowCount: 2 }), true, 'rows that came back are real');
});

test('the reconcilers, MasterSync and the KDS load all ask before believing an empty read', () => {
  const sr = read('../sync/SessionReconciler.js');
  assert.ok(sr.includes("if (!trustSharedRead({ linkUncertain: isDeviceLinkUncertain(), rowCount: heads.length })) return;"));
  assert.ok(sr.indexOf('trustSharedRead(') < sr.indexOf('const supabaseOpen = new Map();'), 'before anything is healed or cleared');
  const qr = read('../sync/QueueReconciler.js');
  assert.ok(qr.includes('const qTrusted = !qHeads.error && Array.isArray(qHeads.data) && trustSharedRead({ linkUncertain: linkUnsure, rowCount: qHeads.data.length });'));
  assert.ok(qr.includes('const tTrusted = !tHeads.error && Array.isArray(tHeads.data) && trustSharedRead({ linkUncertain: linkUnsure, rowCount: tHeads.data.length });'));
  assert.ok(qr.includes('if (qTrusted) {') && qr.includes('if (tTrusted) {'), 'an untrusted list is skipped (ok = false), nothing dropped');
  const ms = read('../sync/MasterSync.js');
  assert.ok(ms.includes('if (sessionsRes.data && sessionsTrusted) {'), 'force sync leaves the tables alone on an untrusted empty read');
  const kds = read('../surfaces/kds/KDSSurface.jsx');
  assert.ok(kds.includes("if (data && !trustSharedRead({ linkUncertain: isDeviceLinkUncertain(), rowCount: data.length })) return;"), 'the KDS keeps its tickets on screen');
});

// ── A7: the banner ───────────────────────────────────────────────────────────

test('link state from device_status: missing function is unsupported, never lost', () => {
  assert.equal(linkStateFromStatus({ error: MISSING }), 'unsupported');
  assert.equal(linkStateFromStatus({ error: { message: 'Failed to fetch' } }), 'unknown');
  assert.equal(linkStateFromStatus({ data: { bound: true, device_id: 'd1' }, localDeviceId: 'd1' }), 'bound');
  assert.equal(linkStateFromStatus({ data: { bound: true, device_id: 'd2' }, localDeviceId: 'd1' }), 'unbound');
  assert.equal(linkStateFromStatus({ data: { bound: false } }), 'unbound');
  assert.equal(linkStateFromStatus({ data: null }), 'unknown');
});

test('the banner shows only when the server said the link is lost', () => {
  assert.equal(shouldShowLinkBanner({ lost: true }), true);
  assert.equal(shouldShowLinkBanner({ lost: false, suspect: true }), false, 'a refused write alone is not proof');
  assert.equal(shouldShowLinkBanner(null), false);
  const t = linkBannerText({ kind: 'till', venueName: 'Provo' });
  assert.equal(t.title, 'This till is not linked to Provo.');
  assert.match(t.body, /Your open orders are safe on this till/);
  assert.match(t.body, /Bar tabs hidden on this till come back/);
  assert.equal(linkBannerText({ kind: 'kiosk' }).title, 'This kiosk is not linked to its venue.');
});

test('the banner is mounted on every till surface', () => {
  const app = read('../App.jsx');
  assert.ok(app.includes('<MPOSSurface /><KioskStaffAlert /><DeviceLinkBanner /></>'), 'MPOS');
  assert.ok(app.includes('<TimeClockSurface /><DeviceLinkBanner /></>'), 'time clock');
  assert.ok(/\{body\}\s*\n\s*\{\/\*[^\n]*\*\/\}\s*\n\s*<DeviceLinkBanner \/>/.test(app), 'POS, bar, tables, KDS (ValidatedPOSApp)');
  assert.ok(read('../surfaces/KioskSurface.jsx').includes('<DeviceLinkBanner /><KioskHoursGate'), 'kiosk');
});

// ── A8: parked writes released on relink ─────────────────────────────────────

test('only writes parked by a refusal are released, keeping their buffered time', () => {
  const parked = { id: 1, status: 'failed_permanent', permanentFailure: true, attempts: 5, ts: 111, lastError: 'new row violates row-level security policy' };
  assert.equal(isParkedPermissionItem(parked), true);
  assert.equal(isParkedPermissionItem({ ...parked, status: 'retry_pending', permanentFailure: false, attempts: 2 }), true);
  assert.equal(isParkedPermissionItem({ ...parked, lastError: 'Failed to fetch' }), false, 'a network failure is not released here');
  assert.equal(isParkedPermissionItem({ ...parked, status: 'failed_stale' }), false, 'a stale quarantine stays quarantined');
  assert.equal(isParkedPermissionItem({ ...parked, status: 'dismissed' }), false);
  assert.equal(isParkedPermissionItem({ id: 2, status: 'pending', lastError: null }), false);
  const r = releaseParkedItem(parked);
  assert.equal(r.status, 'pending'); assert.equal(r.attempts, 0); assert.equal(r.permanentFailure, false);
  assert.equal(r.ts, 111, 'the staleness rules still judge the real age');
  assert.equal(r.id, 1);
});

test('OfflineQueue releases parked writes on rpos-device-relinked and keeps every guard', () => {
  const oq = read('../sync/OfflineQueue.js');
  assert.ok(oq.includes("window.addEventListener('rpos-device-relinked', async () => {"));
  assert.ok(oq.includes('await releaseParkedPermissionWrites();') && oq.includes('if (_isOnline) replayQueue(supabase);'));
  assert.ok(oq.includes('if (!isParkedPermissionItem(it)) continue;') && oq.includes('await dbPut(releaseParkedItem(it));'));
  // The replay itself is unchanged: before() and keep() still guard state writes.
  assert.ok(oq.includes('if (_guard && !reconciled && isStateWrite(it)) continue;'));
  assert.ok(oq.includes('try { keep = _guard.keep(it) !== false; } catch { keep = true; }'));
  const ds = read('../sync/DataSafe.js');
  assert.ok(ds.includes("window.addEventListener('rpos-device-relinked', () => { reconcilePendingChecks().catch(() => {}); });"), 'kept sales go again');
});

// ── A2: the boot re-link and its fallback ────────────────────────────────────

const fakeRpc = (answers) => {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push([name, args]);
    const a = answers[name];
    if (typeof a === 'function') return a(args, calls);
    return a || { data: null, error: MISSING };
  };
  return { rpc, calls };
};

test('A2 fallback: before 20260919a1 the boot runs today\'s claim with the saved or read code', async () => {
  const { rpc, calls } = fakeRpc({ claim_device: { data: 'L1', error: null } });
  const saved = [];
  const r = await runDeviceLink({
    rpc, device: { id: 'd1', pairingCode: null },
    readLegacyCode: async () => 'DONUT-4821', saveLegacyCode: (c) => saved.push(c),
  });
  assert.equal(r.outcome, 'legacy');
  assert.deepEqual(saved, ['DONUT-4821']);
  assert.deepEqual(calls.map(c => c[0]), ['device_status', 'claim_device']);
  assert.deepEqual(calls[1][1], { p_code: 'DONUT-4821' });
});

test('A2 fallback is boot only: a wake never repeats the old claim', async () => {
  const { rpc, calls } = fakeRpc({});
  const r = await runDeviceLink({ rpc, device: { id: 'd1', pairingCode: 'X' }, allowLegacy: false });
  assert.equal(r.outcome, 'unsupported');
  assert.deepEqual(calls.map(c => c[0]), ['device_status']);
});

test('A2: a till with a secret re-links with reclaim_device, never a code', async () => {
  const { rpc, calls } = fakeRpc({ reclaim_device: { data: { ok: true, already_bound: false, device_id: 'd1' }, error: null } });
  const r = await runDeviceLink({ rpc, device: { id: 'd1', deviceSecret: 's', pairingCode: 'OLD' } });
  assert.equal(r.outcome, 'relinked');
  assert.deepEqual(calls, [['reclaim_device', { p_device_id: 'd1', p_device_secret: 's' }]]);
});

test('A2: a bound till without a secret collects one (every grandfathered till)', async () => {
  const saved = [];
  const { rpc, calls } = fakeRpc({
    device_status: { data: { bound: true, device_id: 'd1', has_secret: false }, error: null },
    device_issue_secret: { data: { ok: true, device_id: 'd1', device_secret: 'new' }, error: null },
  });
  const r = await runDeviceLink({ rpc, device: { id: 'd1' }, saveSecret: (s) => saved.push(s) });
  assert.equal(r.outcome, 'linked');
  assert.deepEqual(saved, ['new']);
  assert.deepEqual(calls.map(c => c[0]), ['device_status', 'device_issue_secret']);
});

test('A2: a bound till that has its secret asks for nothing more', async () => {
  const { rpc, calls } = fakeRpc({
    reclaim_device: { data: { ok: true, already_bound: true, device_id: 'd1' }, error: null },
  });
  const r = await runDeviceLink({ rpc, device: { id: 'd1', deviceSecret: 's' } });
  assert.equal(r.outcome, 'linked');
  assert.equal(calls.length, 1);
});

test('A15: once the fence functions exist a saved code is never sent, and it is dropped', async () => {
  const saved = [];
  let forgot = 0;
  const { rpc, calls } = fakeRpc({
    device_status: { data: { bound: false }, error: null },
    claim_device_v2: { data: { ok: true, device_id: 'd1', device_secret: 'fresh' }, error: null },
  });
  const r = await runDeviceLink({ rpc, device: { id: 'd1', pairingCode: 'OLDCODE' }, saveSecret: (s) => saved.push(s), forgetLegacyCode: () => { forgot += 1; } });
  assert.equal(r.outcome, 'lost', 'only the secret, or pairing again, links the till');
  assert.deepEqual(calls.map(c => c[0]), ['device_status'], 'no claim with an old code (file A retired them all)');
  assert.equal(forgot, 1, 'the dead code is removed from rpos-device');
  assert.deepEqual(saved, []);
});

test('A15: before 20260919a1 the saved code is still today\'s boot claim (fallback), never dropped', async () => {
  let forgot = 0;
  const { rpc, calls } = fakeRpc({ claim_device: { data: 'L1', error: null } });
  const r = await runDeviceLink({ rpc, device: { id: 'd1', pairingCode: 'DONUT-4821' }, forgetLegacyCode: () => { forgot += 1; } });
  assert.equal(r.outcome, 'legacy');
  assert.deepEqual(calls.map(c => c[0]), ['device_status', 'claim_device']);
  assert.equal(forgot, 0);
});

test('A2: a refused secret and no code is "lost" with the server\'s reason (the banner)', async () => {
  const { rpc } = fakeRpc({
    reclaim_device: { data: { ok: false, reason: 'invalid', message: 'This till needs to be paired again from Back Office.' }, error: null },
    device_status: { data: { bound: false }, error: null },
  });
  const r = await runDeviceLink({ rpc, device: { id: 'd1', deviceSecret: 'wrong' } });
  assert.equal(r.outcome, 'lost');
  assert.equal(r.reason, 'invalid');
  assert.match(r.message, /paired again/);
});

test('A2: a network error is unknown, never lost', async () => {
  const { rpc } = fakeRpc({ device_status: async () => { throw new Error('Failed to fetch'); } });
  const r = await runDeviceLink({ rpc, device: { id: 'd1' } });
  assert.equal(r.outcome, 'unknown');
  const { rpc: rpc2 } = fakeRpc({ reclaim_device: { data: null, error: { message: 'timeout' } } });
  assert.equal((await runDeviceLink({ rpc: rpc2, device: { id: 'd1', deviceSecret: 's' } })).outcome, 'unknown');
});

test('A2: a till bound as ANOTHER device never counts as this till', async () => {
  const saved = [];
  const { rpc } = fakeRpc({
    device_status: { data: { bound: true, device_id: 'OTHER', has_secret: true }, error: null },
    device_issue_secret: { data: { ok: true, device_id: 'OTHER', device_secret: 'x' }, error: null },
  });
  const r = await runDeviceLink({ rpc, device: { id: 'd1', pairingCode: 'C' }, saveSecret: (s) => saved.push(s) });
  assert.equal(r.outcome, 'lost');
  assert.deepEqual(saved, []);
});

test('supabase.js boot claim goes through runDeviceLink, and no longer reads pairing_code except as the fallback', () => {
  const src = read('./supabase.js');
  assert.ok(src.includes('res = await runDeviceLink({'));
  assert.ok(src.includes("const _claimDevice = () => linkDevice({ allowLegacy: true });"));
  const i = src.indexOf(".select('pairing_code')");
  assert.ok(i > 0 && src.slice(Math.max(0, i - 400), i).includes('FENCE STAGE 1 FALLBACK'), 'the code read is marked as the stage 1 fallback');
  assert.ok(src.includes("dispatchLink('rpos-device-link-lost', detail)") && src.includes("dispatchLink('rpos-device-relinked', detail)"));
  assert.ok(src.includes("'rpos-kiosk-secret',"), 'the kiosk secret survives a tenant fence wipe');
  // A1: ensureAuthToken goes through resolveAuthToken. The second sign in step widened the
  // "no anonymous session here" rule from Back Office to every surface a person signs in on
  // (office, backoffice, admin, owner, staff); customer pages and the POS family are untouched.
  assert.ok(src.includes('allowAnonymous: !isLoginSurfaceMode(),'), 'A1: ensureAuthToken uses resolveAuthToken');
});

// ── A3, A4: pairing screens ──────────────────────────────────────────────────

test('the pairing screen never pairs locally when the claim was refused', () => {
  const src = read('../surfaces/PairingScreen.jsx');
  assert.ok(src.includes('await claimDeviceWithRetry({') && src.includes("supabase.rpc('claim_device_v2', { p_code })"));
  const refused = src.indexOf('} else if (rpcErr || !res?.ok) {');
  const stored = src.indexOf("localStorage.setItem('rpos-device'");
  assert.ok(refused > 0 && stored > refused);
  assert.ok(src.slice(refused, refused + 200).includes('return setError(claimRefusalMessage(res, rpcErr));'), 'a refusal returns before anything is stored');
  assert.ok(src.includes('if (rpcErr && isMissingRpc(rpcErr)) {') && src.includes('const old = await legacyPair(typed);'), 'FENCE STAGE 1 FALLBACK only when the function is missing');
  assert.ok(src.includes('maxLength={20}') && src.includes('placeholder="XXXX-XXXX-XXXX"'));
});

test('the kiosk only forgets its pairing on a successful read of status removed', () => {
  const src = read('../surfaces/KioskSurface.jsx');
  assert.ok(src.includes("const read = classifyDeviceRead({ error, row: data });"));
  assert.ok(src.includes("if (read === 'removed') {"));
  assert.ok(!src.includes("if (error || !data) {\n      console.warn('[KioskSurface] paired kiosk not found, clearing local pairing'"), 'the old "any error unpairs" branch is gone');
  assert.ok(src.includes("localStorage.setItem(KIOSK_SECRET_KEY, res.device_secret)"));
});

test('App.jsx refreshDevice reads with maybeSingle and a refused token write is never a kick', () => {
  const src = read('../App.jsx');
  assert.ok(src.includes(".select('id, status, profile_id, name, session_token').eq('id', pairedDevice.id).maybeSingle();"));
  assert.ok(src.includes('const decision = decideDeviceRefresh({ read, readError, statusSupported, linkOutcome: link?.outcome, linkReason: link?.reason });'));
  assert.ok(src.includes("if (!isReclaim && !tokenWriteRefused && data.session_token && data.session_token !== mySessionToken) {"));
  assert.ok(src.includes("if (updatedToken && updatedToken !== mySessionToken && !tokenWriteRefused) {"));
});

// ── A6: Back Office codes come from the server ───────────────────────────────

test('A6: a server code, confirming before a paired till is moved', async () => {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push(args);
    if (!args.p_force) return { data: { ok: false, reason: 'paired', message: 'in use' }, error: null };
    return { data: { ok: true, code: 'ABCDEFGHIJKL', expires_at: '2026-09-18T11:00:00Z' }, error: null };
  };
  const asked = [];
  const r = await issuePairingCodeWithFallback({ rpc, deviceId: 'd1', confirmPaired: async (m) => { asked.push(m); return true; } });
  assert.deepEqual(r, { ok: true, code: 'ABCDEFGHIJKL', expires_at: '2026-09-18T11:00:00Z' });
  assert.deepEqual(asked, ['in use']);
  assert.deepEqual(calls.map(c => c.p_force), [false, true]);
  const no = await issuePairingCodeWithFallback({ rpc, deviceId: 'd1', confirmPaired: async () => false });
  assert.equal(no.ok, false); assert.equal(no.reason, 'cancelled');
});

test('A6 fallback: before 20260919a1 the browser code is written the old way', async () => {
  const rpc = async () => ({ data: null, error: MISSING });
  const r = await issuePairingCodeWithFallback({ rpc, deviceId: 'd1', legacyIssue: async () => 'BAKER-3225' });
  assert.deepEqual(r, { ok: true, code: 'BAKER-3225', expires_at: null, legacy: true });
  const f = await issuePairingCodeWithFallback({ rpc, deviceId: 'd1', legacyIssue: async () => null });
  assert.equal(f.ok, false, 'a code the database did not take is never shown');
});

test('A11: DevSwitcher (read every code of the venue) is deleted', () => {
  assert.equal(fs.existsSync(fileURLToPath(new URL('../components/DevSwitcher.jsx', import.meta.url))), false);
});

// ── Fix round (19 Sep 2026): docs/FENCE_STAGE_1_APP.md section 11 ──────────────

test('pairing screen: the server code format pairs with or without dashes, spaces or a long dash', () => {
  const code = 'ABCD-EFGH-JK23';
  for (const typed of ['ABCD-EFGH-JK23', 'abcdefghjk23', 'ABCD EFGH JK23', ' abcd\u2013efgh\u2014jk23 ', 'ABCD.EFGH.JK23']) {
    assert.equal(normalizePairingCode(typed), 'ABCDEFGHJK23', typed);
    assert.equal(isServerPairingCode(typed), true, typed);
    assert.equal(pairingCodeHint(typed), null, `${typed} is sent as is`);
  }
  assert.equal(formatPairingCode('abcdefghjk23'), code);
  assert.equal(SERVER_CODE_ALPHABET.length, 32);
  for (const bad of '01IO') assert.equal(SERVER_CODE_ALPHABET.includes(bad), false);
});

test('pairing screen: a mistyped server code is caught before the server calls it "no longer valid"', () => {
  assert.match(pairingCodeHint('ABCD-EFGH-JK20'), /never use 0, 1, I or O/, 'a zero');
  assert.match(pairingCodeHint('ABCD-EFGH-IK23'), /never use 0, 1, I or O/, 'an I');
  assert.match(pairingCodeHint('ABCD-EFGH-JK2'), /12 letters and numbers/, 'one short');
  assert.match(pairingCodeHint('ABCD-EFGH-JK234'), /12 letters and numbers/, 'one long');
  assert.match(pairingCodeHint(''), /Enter the pairing code/);
  // Old browser codes (a word and 4 digits) still go to the server while 20260919a1 is not run.
  for (const old of ['DONUT-4821', 'NOODLE-1034', 'BAKER-3225']) assert.equal(pairingCodeHint(old), null, old);
});

test('pairing screens use the hint and take a 14 character code (old code stopped at 12)', () => {
  const ps = read('../surfaces/PairingScreen.jsx');
  const hint = ps.indexOf('const hint = pairingCodeHint(code);');
  assert.ok(hint > 0 && hint < ps.indexOf('await claimDeviceWithRetry({'), 'the hint runs before the claim');
  const ks = read('../surfaces/KioskSurface.jsx');
  assert.ok(ks.includes('const hint = pairingCodeHint(codeNorm);') && ks.includes('maxLength={20}'));
});

test('A12: parked writes are released on the first "linked" of a page (after Pair again) and on every relink', () => {
  assert.equal(shouldReleaseParkedOnLink({ event: 'rpos-device-relinked' }), true);
  assert.equal(shouldReleaseParkedOnLink({ event: 'rpos-device-relinked', releasedOnLinkThisPage: true }), true);
  assert.equal(shouldReleaseParkedOnLink({ event: 'rpos-device-linked' }), true, 'the boot link after a pairing reload');
  assert.equal(shouldReleaseParkedOnLink({ event: 'rpos-device-linked', releasedOnLinkThisPage: true }), false, 'never a loop on every wake');
  assert.equal(shouldReleaseParkedOnLink({ outcome: 'linked' }), true);
  for (const outcome of ['lost', 'unknown', 'unsupported', 'legacy', 'skipped']) assert.equal(shouldReleaseParkedOnLink({ outcome }), false, outcome);
  const oq = read('../sync/OfflineQueue.js');
  assert.ok(oq.includes("window.addEventListener('rpos-device-linked', async () => {"));
  assert.ok(oq.includes('const bootLink = getLastDeviceLinkOutcome();'), 'a boot link that answered before the queue started still counts');
  // Release keeps every guard: only parked permission items, buffered time kept, replay unchanged.
  const parked = { id: 9, status: 'failed_permanent', permanentFailure: true, attempts: 5, ts: 42, lastError: 'permission denied for table bar_tabs' };
  assert.equal(isParkedPermissionItem(parked), true);
  assert.equal(releaseParkedItem(parked).ts, 42);
  assert.ok(oq.includes('if (_guard && !reconciled && isStateWrite(it)) continue;'), 'before() still guards');
  assert.ok(oq.includes('try { keep = _guard.keep(it) !== false; } catch { keep = true; }'), 'keep() still guards');
  assert.ok(read('./supabase.js').includes('_lastLinkOutcome = res.outcome;'));
});

test('A13: the heartbeat names the device this till thinks it is (a real uuid only)', () => {
  const id = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  assert.deepEqual(heartbeatArgs({ version: '5.9.9', deviceId: id }), { p_app_version: '5.9.9', p_caps: [...FENCE_CAPS], p_device_id: id });
  assert.deepEqual(heartbeatArgs({ version: '5.9.9', deviceId: 'admin' }), { p_app_version: '5.9.9', p_caps: [...FENCE_CAPS] }, 'never a 22P02');
  assert.deepEqual(heartbeatArgs({ version: '5.9.9' }), { p_app_version: '5.9.9', p_caps: [...FENCE_CAPS] });
  const src = read('./supabase.js');
  assert.ok(src.includes("supabase.rpc('device_heartbeat', heartbeatArgs({ version: VERSION, caps: FENCE_CAPS, deviceId: local?.id }))"));
});

test('A14: before 20260919a1 the till writes its own last_seen, version and capabilities', () => {
  const p = legacyHeartbeatPatch({ version: '5.9.9', now: () => '2026-09-19T10:00:00.000Z' });
  assert.deepEqual(p, { last_seen: '2026-09-19T10:00:00.000Z', app_version: '5.9.9', client_caps: [...FENCE_CAPS] });
  assert.ok(!('status' in p), 'the status is never touched (a linked till may write only its heartbeat after file A)');
  const src = read('./supabase.js');
  const i = src.indexOf("const patch = legacyHeartbeatPatch({ version: VERSION });");
  assert.ok(i > 0, 'the fallback write');
  assert.ok(src.slice(Math.max(0, i - 400), i).includes('if (!isMissingRpc(error)) return null;'), 'only while the function is missing');
  assert.ok(!read('../surfaces/KioskSurface.jsx').includes("update({ last_seen: new Date().toISOString() }).eq('id', id)"), 'the kiosk no longer writes it twice');
});

test('fix round 3: the capability is what file A gates on, and a venue without step 1b still reports its build', () => {
  // File a1 (20260919a1) tests client_caps, NOT a version string: 5.9.10 and 5.9.11 both shipped
  // without the fence app, so a version comparison passed the whole fleet.
  const fileA = read('../../supabase/migrations/20260919a1_OPS_fence_identity_devices.sql');
  assert.ok(fileA.includes("d.client_caps @> array['fence_v1']"), 'file A asks for the capability');
  assert.ok(!/v_release\s+constant/.test(fileA), 'and no version constant is left to gate on');
  assert.ok(fileA.includes('20260919_OPS_fence_0_caps.sql'), 'it names the file that adds the column');
  const prep = read('../../supabase/migrations/20260919_OPS_fence_0_caps.sql');
  assert.ok(prep.includes('add column if not exists client_caps        text[]'), 'step 1b adds it');
  const prepSql = prep.split('\n').filter(l => l.trim() && !l.trim().startsWith('--')).join('\n');
  assert.ok(!/create policy|drop policy|revoke |grant |delete from|update public/i.test(prepSql),
    'step 1b changes no policy, no grant and no row');
  // Until step 1b is run the column is not there; the write is retried without it.
  assert.equal(isMissingColumn({ code: 'PGRST204', message: "Could not find the 'client_caps' column of 'devices'" }, 'client_caps'), true);
  assert.equal(isMissingColumn({ code: '42703', message: 'column "client_caps" does not exist' }, 'client_caps'), true);
  assert.equal(isMissingColumn({ code: '42501', message: 'permission denied' }, 'client_caps'), false);
  assert.equal(isMissingColumn(null), false);
  const src = read('./supabase.js');
  assert.ok(src.includes("if (patchErr && isMissingColumn(patchErr, 'client_caps')) {"), 'the retry');
  assert.ok(src.includes('const { client_caps: _caps, ...rest } = patch;'), 'without the capability, so last_seen and the version still land');
});

test('refused writes never lose work: Pair again to the same venue wipes nothing, another venue asks first', () => {
  const sb = read('./supabase.js');
  assert.ok(sb.includes('if (activeLocId && lastActive && activeLocId !== lastActive) {'), 'only a real venue change wipes local data');
  assert.ok(sb.includes("'rpos-device',") && sb.includes("'rpos-kiosk-secret',"), 'the pairing record and kiosk secret survive any wipe');
  const ps = read('../surfaces/PairingScreen.jsx');
  const send = ps.indexOf('try { await reconcilePendingChecks(); }');
  const claim = ps.indexOf('await claimDeviceWithRetry({');
  assert.ok(send > 0 && claim > send, 'unsent sales and queued writes are sent BEFORE the claim');
  const ask = ps.indexOf('if (prevLoc && data.location_id && prevLoc !== data.location_id) {');
  const fence = ps.indexOf('enforceTenantFence(data.location_id);');
  assert.ok(ask > 0 && fence > ask, 'a different venue with unsent work asks before anything is wiped');
  assert.ok(read('../components/DeviceLinkBanner.jsx').includes('<PairingScreen onPaired={() => window.location.reload()} />'), 'the reload is what A12 releases the parked writes on');
});

// ── Fix round 2 (19 Sep 2026) ────────────────────────────────────────────────

test('fix round 2: a write that changed 0 rows while unlinked (parked_link) is released on relink', () => {
  assert.equal(PARKED_LINK_STATUS, 'parked_link');
  const parked = { id: 4, status: 'parked_link', attempts: 0, lastError: 'row-level security: 0 rows changed', ts: 123, zeroRows: true };
  assert.equal(isParkedPermissionItem(parked), true);
  const r = releaseParkedItem(parked);
  assert.equal(r.status, 'pending');
  assert.equal(r.ts, 123, 'the buffered time is kept');
  assert.equal(r.zeroRows, true, 'still marked, so a new write of the row queues behind it until it lands');
  assert.equal(isParkedPermissionItem({ ...parked, status: 'dismissed' }), false);
  assert.equal(isParkedPermissionItem({ ...parked, status: 'failed_stale' }), false);
});

test('fix round 2 (HIGH): the heartbeat collects a missing device secret, no restart needed', () => {
  // Booted before file A (no secret anywhere); after file A the heartbeat says bound.
  assert.equal(heartbeatNextStep({ linkState: 'bound', serverHasSecret: false, localHasSecret: false }), 'collect_secret');
  assert.equal(heartbeatNextStep({ linkState: 'bound', serverHasSecret: true, localHasSecret: false }), 'collect_secret');
  assert.equal(heartbeatNextStep({ linkState: 'bound', serverHasSecret: false, localHasSecret: true }), 'collect_secret');
  assert.equal(heartbeatNextStep({ linkState: 'bound', serverHasSecret: true, localHasSecret: true }), 'none');
  assert.equal(heartbeatNextStep({ linkState: 'bound', serverHasSecret: true, localHasSecret: true, suspect: true }), 'relink');
  assert.equal(heartbeatNextStep({ linkState: 'bound', serverHasSecret: true, localHasSecret: true, lost: true }), 'relink');
  assert.equal(heartbeatNextStep({ linkState: 'unbound' }), 'relink');
  assert.equal(heartbeatNextStep({ linkState: 'unbound', lost: true }), 'none', 'already on the banner: the monitor re-checks on wake and online');
  for (const st of ['unsupported', 'unknown']) assert.equal(heartbeatNextStep({ linkState: st }), 'none', st);
  const dl = read('./deviceLink.js');
  const hb = dl.slice(dl.indexOf('export async function deviceHeartbeat()'), dl.indexOf('export function noteWriteRefused('));
  assert.ok(hb.includes('const next = heartbeatNextStep({') && hb.includes("if (next !== 'none') checkDeviceLink();"), 'the heartbeat acts on it');
  assert.ok(hb.includes('serverHasSecret: res.has_secret === true, localHasSecret: !!local.deviceSecret'));
  assert.ok(dl.includes("if (st === 'bound' && !state.lost && !state.suspect && local && local.deviceSecret && data && data.has_secret === true) {"), 'linked only when the secret is on both sides');
});

test('fix round 2 (HIGH): no card payment on a device that is not linked', () => {
  assert.deepEqual(cardLinkDecision({ linkState: 'bound' }), { ok: true, reason: 'linked' });
  assert.deepEqual(cardLinkDecision({ linkState: 'unbound' }), { ok: false, reason: 'not_linked' });
  assert.deepEqual(cardLinkDecision({ linkState: 'unbound', relinkOutcome: 'relinked' }), { ok: true, reason: 'relinked' });
  assert.deepEqual(cardLinkDecision({ linkState: 'unbound', relinkOutcome: 'linked' }), { ok: true, reason: 'relinked' });
  assert.deepEqual(cardLinkDecision({ linkState: 'unbound', relinkOutcome: 'lost' }), { ok: false, reason: 'not_linked' });
  assert.deepEqual(cardLinkDecision({ linkState: 'not_device' }), { ok: true, reason: 'not_device' });
  assert.deepEqual(cardLinkDecision({ linkState: 'unsupported' }), { ok: true, reason: 'unsupported' });
  // The check itself failed: a device the server said is lost never pays; one linked moments ago does.
  assert.deepEqual(cardLinkDecision({ linkState: 'unknown', lost: true, boundAgoMs: 1000 }), { ok: false, reason: 'not_linked' });
  assert.deepEqual(cardLinkDecision({ linkState: 'unknown', boundAgoMs: 1000 }), { ok: true, reason: 'recently_linked' });
  assert.deepEqual(cardLinkDecision({ linkState: 'unknown', boundAgoMs: CARD_LINK_STALE_MS + 1, hasSecret: true }), { ok: false, reason: 'unknown' });
  assert.deepEqual(cardLinkDecision({ linkState: 'unknown', boundAgoMs: null, hasSecret: true }), { ok: false, reason: 'unknown' });
  assert.deepEqual(cardLinkDecision({ linkState: 'unknown', supported: false }), { ok: true, reason: 'unsupported' });
  assert.match(cardLinkRefusalMessage({ kind: 'kiosk' }), /ask a member of staff\. Nothing has been charged\./);
  assert.match(cardLinkRefusalMessage({ kind: 'till', venueName: 'Beta', reason: 'not_linked' }), /^This till is not linked to Beta, so it cannot take card payments\. Nothing has been charged\./);
  assert.match(cardLinkRefusalMessage({ kind: 'till', reason: 'unknown' }), /Could not check that this till is linked/);
  // Before file A no round trip is added: only while a check said "unsupported" in the last 90 s.
  assert.equal(cardLinkCheckNeeded({ supported: false, unsupportedAgoMs: 1000 }), false);
  assert.equal(cardLinkCheckNeeded({ supported: false, unsupportedAgoMs: CARD_UNSUPPORTED_TRUST_MS + 1 }), true);
  assert.equal(cardLinkCheckNeeded({ supported: false, unsupportedAgoMs: null }), true);
  assert.equal(cardLinkCheckNeeded({ supported: false, unsupportedAgoMs: 1000, lost: true }), true);
  assert.equal(cardLinkCheckNeeded({ supported: false, unsupportedAgoMs: 1000, suspect: true }), true);
  assert.equal(cardLinkCheckNeeded({ supported: true, unsupportedAgoMs: 1000 }), true);
  assert.equal(cardLinkCheckNeeded({ supported: null }), true);
});

test('NEVER WORSE THAN TODAY: a device the fence has never touched still starts a card payment', () => {
  // The release ships BEFORE file a1. On a device with no fence answer on this page and no device
  // secret, a device_status that does not answer in 5 s used to come out 'unknown' and REFUSE a
  // payment the live app would have taken (an Adyen terminal that is its own reader takes it over
  // the local bridge with Supabase unreachable). That device now takes today's path.
  const nothingKnown = { linkState: 'unknown', supported: null, boundAgoMs: null, hasSecret: false };
  assert.deepEqual(cardLinkDecision(nothingKnown), { ok: true, reason: 'never_fenced' },
    'first card payment, slow network, nothing the fence has ever said: it starts');
  assert.deepEqual(cardLinkDecision({ ...nothingKnown, boundAgoMs: undefined }), { ok: true, reason: 'never_fenced' },
    'an undefined boundAgoMs is the same as never');

  // IT CLOSES BY ITSELF. The moment a1 is in, the first heartbeat collects the device secret
  // (deviceFence heartbeatNextStep 'collect_secret'), and a device that holds one can never reach
  // the branch again: a check it cannot make is 'unknown' and the payment is refused.
  assert.deepEqual(cardLinkDecision({ ...nothingKnown, hasSecret: true }), { ok: false, reason: 'unknown' },
    'a device that HAS a secret and cannot check refuses');
  assert.deepEqual(cardLinkDecision({ ...nothingKnown, supported: true }), { ok: false, reason: 'unknown' },
    'a device that has had a fence answer on this page refuses');

  // IT NEVER WEAKENS A REAL REFUSAL.
  assert.deepEqual(cardLinkDecision({ ...nothingKnown, linkState: 'unbound' }), { ok: false, reason: 'not_linked' },
    'the server said unbound: refused, secret or no secret');
  assert.deepEqual(cardLinkDecision({ ...nothingKnown, lost: true }), { ok: false, reason: 'not_linked' },
    'the monitor was told this device is not linked: refused');
  assert.deepEqual(cardLinkDecision({ ...nothingKnown, suspect: true }), { ok: false, reason: 'unknown' },
    'a write was refused and the link is not confirmed since: refused');
  // A stale "linked ages ago" is still not good enough on its own.
  assert.deepEqual(cardLinkDecision({ linkState: 'unknown', supported: null, boundAgoMs: CARD_LINK_STALE_MS + 1, hasSecret: false }),
    { ok: false, reason: 'unknown' }, 'it has been told it is linked before, so it is held to the check');

  // The live gate hands the decision both new facts, read from THIS device.
  const dl = read('./deviceLink.js');
  const gate = dl.slice(dl.indexOf('export async function confirmLinkBeforeCard()'), dl.indexOf('let _started = false;'));
  assert.ok(gate.includes('suspect: state.suspect'), 'the gate passes the suspect state');
  assert.ok(gate.includes('hasSecret: !!local.deviceSecret'), 'and whether this device holds its device secret');
  // Every card path goes through that one gate, so the kiosk and the handheld follow the same rule.
  for (const [file, why] of [['../surfaces/kiosk/KioskPayLinkGate.jsx', 'kiosk ScreenPay'],
                             ['../surfaces/mpos/MCardFlow.jsx', 'MPOS, including the on-device Adyen bridge'],
                             ['../surfaces/CheckoutModal.jsx', 'the till'],
                             ['../components/TabPreAuthTerminal.jsx', 'a bar tab card hold'],
                             ['../components/SplitModal.jsx', 'a split payment']]) {
    assert.ok(read(file).includes('confirmLinkBeforeCard()'), `${why} uses the one gate`);
  }
  // MPOS: the gate is still BEFORE the local Adyen bridge, which is the path this fix protects.
  const mc = read('../surfaces/mpos/MCardFlow.jsx');
  assert.ok(mc.indexOf('const linkGate = await confirmLinkBeforeCard();') < mc.indexOf('if (adyenLocalBridgeAvailable())'),
    'the gate runs before the on-device terminal, and now answers ok on a device the fence never touched');
});

test('fix round 2 (HIGH): every card start on a till or kiosk checks the link FIRST', () => {
  const before = (src, gateAt, marker, why) => {
    const m = src.indexOf(marker, gateAt);
    assert.ok(gateAt > 0 && m > gateAt, why);
  };
  const GATE = 'const linkGate = await confirmLinkBeforeCard();';
  const co = read('../surfaces/CheckoutModal.jsx');
  const rest = co.indexOf('const runRestFlow = async () => {');
  const restGate = co.indexOf(GATE, rest);
  before(co, restGate, "if (processor === 'ryft') return runRyftTerminalFlow();", 'checkout: before the Ryft terminal');
  before(co, restGate, '/functions/v1/stripe-process-payment-on-reader', 'checkout: before the Stripe reader');
  const job = co.indexOf('const startTerminalJob = async () => {');
  const jobGate = co.indexOf(GATE, job);
  before(co, jobGate, 'await dispatchTerminalJob({', 'checkout: before a terminal job (and before a gift debit for it)');
  assert.ok(jobGate - job < 400, 'the gate is the first thing the terminal job does');
  const sp = read('../components/SplitModal.jsx');
  const spGate = sp.indexOf(GATE);
  before(sp, spGate, 'runPaxJob(opsLocationId, target);', 'split: before the terminal job');
  before(sp, spGate, 'runRyftPayment(opsLocationId);', 'split: before Ryft');
  const tp = read('../components/TabPreAuthTerminal.jsx');
  before(tp, tp.indexOf(GATE), '/functions/v1/stripe-process-payment-on-reader', 'bar tab hold');
  const mc = read('../surfaces/mpos/MCardFlow.jsx');
  const mcGate = mc.indexOf(GATE);
  before(mc, mcGate, 'await runAdyenLocalTerminalFlow();', 'MPOS: before the on device terminal');
  before(mc, mcGate, 'await runTapToPayFlow();', 'MPOS: before Tap to Pay');
  before(mc, mcGate, 'await runCloudTerminalFlow(terminal);', 'MPOS: before a cloud terminal');
  const bar = read('../surfaces/BarSurface.jsx');
  const barFn = bar.indexOf('const captureHeldTab = async (tab) => {');
  before(bar, bar.indexOf(GATE, barFn), "await fetch('/api/stripe-capture', {", 'bar: before a hold capture');
  const oh = read('../surfaces/OrdersHub.jsx');
  const qrFn = oh.indexOf('const forceCloseQrTab = async (tab) => {');
  before(oh, oh.indexOf(GATE, qrFn), "await fetch('/api/stripe-capture', {", 'QR tab close: before the capture');
  const tabFn = oh.indexOf('const forceCloseTab = async (o) => {');
  before(oh, oh.indexOf(GATE, tabFn), "await fetch('/api/stripe-capture', {", 'QR tab force close: before the capture');
  // The kiosk: ScreenPay starts the reader on mount, so it only MOUNTS behind the link gate, in
  // the old kiosk and in the new design. ScreenPay and submitOrder are untouched (card path guard).
  const kiosk = read('../surfaces/KioskApp.jsx');
  assert.ok(kiosk.includes("{screen === 'pay' && <KioskPayLinkGate "), 'old kiosk: the pay screen is gated');
  assert.ok(kiosk.includes("onCancel={resetSession}><ScreenPay brandColor={brandColor} total={grandTotal}"), 'old kiosk: ScreenPay is the gate\'s child');
  assert.ok(kiosk.includes('return <KioskV2Root engine={engine} ScreenPay={LinkedScreenPay} />;'), 'new design: gated ScreenPay');
  assert.ok(kiosk.includes('function LinkedScreenPay(props) {'), 'a module level component (a stable type, never remounted)');
  const gate = read('../surfaces/kiosk/KioskPayLinkGate.jsx');
  assert.ok(gate.includes("if (gate.phase === 'ok') return children;"), 'the reader starts only after the server said linked');
  assert.ok(gate.indexOf('confirmLinkBeforeCard()') > 0);
  assert.ok(!/submitOrder\(|startCardPayment|dispatchTerminalJob|stripe-process-payment-on-reader/.test(gate), 'the gate never touches the card path itself');
});

test('fix round 2 (MEDIUM): every surface reports its build on the heartbeat, and every last_seen write carries it', () => {
  const sb = read('./supabase.js');
  assert.ok(sb.includes("supabase.rpc('device_heartbeat', heartbeatArgs({ version: VERSION, caps: FENCE_CAPS, deviceId: local?.id }))"));
  const app = read('../App.jsx');
  assert.ok(app.includes("if (deviceMode === 'mpos') return <><SyncBridge onSyncPulse={handleSyncPulse}/><MposDeviceProfileSync pairedDevice={pairedDevice}/><MPOSSurface /><KioskStaffAlert /><DeviceLinkBanner /></>;"));
  assert.ok(app.includes("if (deviceMode === 'clock') return <><KioskAutoUpdate /><TimeClockSurface /><DeviceLinkBanner /></>;"));
  assert.ok(app.includes('<DeviceLinkBanner />\n      {showKioskStaffAlert && <KioskStaffAlert />}'), 'POS, bar, tables, orders and KDS');
  assert.ok(read('../surfaces/KioskSurface.jsx').includes('return <><DeviceLinkBanner /><KioskHoursGate kiosk={kiosk} onUnpair={unpair}/></>;'), 'kiosk');
  assert.ok(read('../components/DeviceLinkBanner.jsx').includes('startDeviceLinkMonitor();'), 'the banner runs the 60 s heartbeat');
  assert.ok(app.includes('startChildHeartbeat({ deviceId: pairedDevice.id, locationId: locId, deviceName: pairedDevice.name, version: VERSION });'), 'device_heartbeats rows carry it too');
  assert.ok(read('./db.js').includes("update({ status: 'online', last_seen: new Date().toISOString(), app_version: VERSION })"), 'KDS');
  assert.ok(read('../surfaces/PairingScreen.jsx').includes('app_version: VERSION,'), 'the old pairing write');
  assert.ok(read('../surfaces/KioskSurface.jsx').includes('app_version: VERSION,'), 'the kiosk pairing write');
});


// 22 Sep 2026: Apple rejected the KDS under 2.1(a) after pairing died with the browser's
// own words, "TypeError: Load failed" (a request that never left the iPad). The server was
// healthy the whole time.
test('a dropped pairing request says so in plain words, and is tried again', async () => {
  assert.equal(
    claimRefusalMessage(null, new TypeError('Load failed')),
    'Could not reach ServOS. Check the internet connection, then tap Pair this device again.');
  assert.equal(
    claimRefusalMessage(null, { message: 'NetworkError when attempting to fetch resource' }),
    'Could not reach ServOS. Check the internet connection, then tap Pair this device again.');

  // Two dropped requests, then the server answers: the till still pairs.
  let calls = 0;
  const slept = [];
  const flaky = async () => {
    calls += 1;
    if (calls < 3) return { data: null, error: new TypeError('Load failed') };
    return { data: { ok: true, device_id: 'd1' }, error: null };
  };
  const ok = await claimDeviceWithRetry({ rpc: flaky, code: 'ABCD2345EFGH', sleep: async (ms) => { slept.push(ms); } });
  assert.equal(calls, 3);
  assert.deepEqual(slept, [...CLAIM_RETRY_DELAYS_MS]);
  assert.equal(ok.data.ok, true);

  // A refusal the server actually sent is NOT retried, and neither is an answered error.
  let refusals = 0;
  const refused = async () => { refusals += 1; return { data: { ok: false, reason: 'expired' }, error: null }; };
  await claimDeviceWithRetry({ rpc: refused, code: 'ABCD2345EFGH', sleep: async () => {} });
  assert.equal(refusals, 1);
  let answered = 0;
  const denied = async () => { answered += 1; return { data: null, error: { message: 'permission denied for function claim_device_v2' } }; };
  await claimDeviceWithRetry({ rpc: denied, code: 'ABCD2345EFGH', sleep: async () => {} });
  assert.equal(answered, 1);

  // Both pairing screens go through the retry.
  assert.ok(read('../surfaces/PairingScreen.jsx').includes('await claimDeviceWithRetry({'), 'till');
  assert.ok(read('../surfaces/KioskSurface.jsx').includes('await claimDeviceWithRetry({'), 'kiosk');
});
