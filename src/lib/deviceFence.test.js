// deviceFence.test.js: database fence stage 1, the till side (docs/FENCE_STAGE_1_APP.md A1 to A11).
//
// The rules under test:
//   - every new server call falls back to today's path while 20260919a is not run (PGRST202);
//   - a till is never unpaired because it could not read its own row (only status 'removed' is);
//   - an empty read while the link is uncertain is "unknown", never "no tables / no tickets";
//   - writes parked by a refusal are released on relink, never a stale quarantine;
//   - pairing codes are normalised and a refused claim never pairs locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FENCE_CAPS, isMissingRpc, isPermissionError, normalizePairingCode, formatPairingCode,
  claimRefusalMessage, deviceEntryFromClaim, classifyDeviceRead, decideDeviceRefresh,
  trustSharedRead, linkStateFromStatus, shouldShowLinkBanner, isParkedPermissionItem,
  releaseParkedItem, runDeviceLink, issuePairingCodeWithFallback, linkBannerText,
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
  assert.match(claimRefusalMessage({ ok: false, reason: 'locked' }), /Wait 15 minutes/);
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
  // FENCE STAGE 1 FALLBACK: before 20260919a reads are open, so no row is today's certain removal.
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

test('A2 fallback: before 20260919a the boot runs today\'s claim with the saved or read code', async () => {
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

test('A2: an unbound till paired before this release re-links once with its saved code', async () => {
  const saved = [];
  const { rpc } = fakeRpc({
    device_status: { data: { bound: false }, error: null },
    claim_device_v2: { data: { ok: true, device_id: 'd1', device_secret: 'fresh' }, error: null },
  });
  const r = await runDeviceLink({ rpc, device: { id: 'd1', pairingCode: 'OLDCODE' }, saveSecret: (s) => saved.push(s) });
  assert.equal(r.outcome, 'relinked');
  assert.deepEqual(saved, ['fresh']);
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

test('A2: a code that belongs to another device never counts as this till', async () => {
  const saved = [];
  const { rpc } = fakeRpc({
    device_status: { data: { bound: false }, error: null },
    claim_device_v2: { data: { ok: true, device_id: 'OTHER', device_secret: 'x' }, error: null },
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
  assert.ok(src.includes('allowAnonymous: !isBackOfficeMode(),'), 'A1: ensureAuthToken uses resolveAuthToken');
});

// ── A3, A4: pairing screens ──────────────────────────────────────────────────

test('the pairing screen never pairs locally when the claim was refused', () => {
  const src = read('../surfaces/PairingScreen.jsx');
  assert.ok(src.includes("await supabase.rpc('claim_device_v2', { p_code: clean })"));
  const refused = src.indexOf('} else if (rpcErr || !res?.ok) {');
  const stored = src.indexOf("localStorage.setItem('rpos-device'");
  assert.ok(refused > 0 && stored > refused);
  assert.ok(src.slice(refused, refused + 200).includes('return setError(claimRefusalMessage(res, rpcErr));'), 'a refusal returns before anything is stored');
  assert.ok(src.includes('if (rpcErr && isMissingRpc(rpcErr)) {') && src.includes('const old = await legacyPair(typed);'), 'FENCE STAGE 1 FALLBACK only when the function is missing');
  assert.ok(src.includes('maxLength={16}') && src.includes('placeholder="XXXX-XXXX-XXXX"'));
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

test('A6 fallback: before 20260919a the browser code is written the old way', async () => {
  const rpc = async () => ({ data: null, error: MISSING });
  const r = await issuePairingCodeWithFallback({ rpc, deviceId: 'd1', legacyIssue: async () => 'BAKER-3225' });
  assert.deepEqual(r, { ok: true, code: 'BAKER-3225', expires_at: null, legacy: true });
  const f = await issuePairingCodeWithFallback({ rpc, deviceId: 'd1', legacyIssue: async () => null });
  assert.equal(f.ok, false, 'a code the database did not take is never shown');
});

test('A11: DevSwitcher (read every code of the venue) is deleted', () => {
  assert.equal(fs.existsSync(fileURLToPath(new URL('../components/DevSwitcher.jsx', import.meta.url))), false);
});
