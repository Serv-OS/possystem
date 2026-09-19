import { createClient } from '@supabase/supabase-js';
import { resolveAuthToken, lastAuthOutcome, AUTH_OUTCOMES, DEFAULT_STORAGE_KEY } from './authSession';
import { runDeviceLink, FENCE_CAPS, isMissingRpc, isMissingColumn, heartbeatArgs, legacyHeartbeatPatch } from './deviceFence';
import { VERSION } from './version';

// ── Ops DB (POS operational data — source of truth for all POS operations) ───
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL  || '';
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
export const isMock  = import.meta.env.VITE_USE_MOCK === 'true' || !SUPABASE_URL || !SUPABASE_ANON;

// STAFF APP client (v5.5.997) — its OWN auth storage. The main client keeps one
// session per browser ('rpos-auth'); when the staff app used it, opening
// ?mode=staff next to the Back Office SIGNED THE BO OUT (the app rejected the
// BO session as not-a-staff-login and called signOut on the SHARED session),
// after which a POS tab minted an anonymous session and every BO write started
// failing RLS — the 6 Aug "changes are not saving / shifts" incident. An
// isolated storageKey means staff logins and logouts can never touch the BO or
// POS session, and vice versa.
export const staffSupabase = isMock ? null : createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { storageKey: 'rpos-staff-auth', persistSession: true, autoRefreshToken: true },
});

export const AUTH_STORAGE_KEY = DEFAULT_STORAGE_KEY;

export const supabase = isMock ? null : createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: AUTH_STORAGE_KEY,
  },
});

// ── Platform DB (company/user management — separate project) ──────────────────
const PLATFORM_URL  = import.meta.env.VITE_PLATFORM_SUPABASE_URL  || '';
const PLATFORM_ANON = import.meta.env.VITE_PLATFORM_SUPABASE_ANON_KEY || '';
export const platformSupabase = (PLATFORM_URL && PLATFORM_ANON)
  ? createClient(PLATFORM_URL, PLATFORM_ANON, { auth: { persistSession: false } })
  : null;

// Dynamic location ID — resolved from user_profiles in Ops DB
let _resolvedLocationId = null;

// v5.5.311: Is this browser running the back-office or admin surface?
// The 'rpos-bo-location' override and the anonymous-session block are
// back-office-only concepts — they must NEVER influence POS/MPOS/KDS/kiosk
// resolution (a paired terminal sharing a browser with the BO was resolving to
// the BO's location → cross-tenant reads/writes). Mode comes from the URL
// (?mode=) or the persisted rpos-device-mode. Accept all BO spellings.
export function isBackOfficeMode() {
  try {
    const mode = getDeviceMode();
    return mode === 'office' || mode === 'backoffice' || mode === 'admin';
  } catch { return false; }
}

// The surface this browser is running, resolved the same way isBackOfficeMode
// resolves it: the ?mode= query param first, then the persisted rpos-device-mode.
// Returns '' when neither is set (a browser that has not picked a mode yet).
export function getDeviceMode() {
  try {
    let mode = '';
    try { mode = new URL(window.location.href).searchParams.get('mode') || ''; } catch { /* no window */ }
    if (!mode) { try { mode = localStorage.getItem('rpos-device-mode') || ''; } catch { /* none */ } }
    return mode;
  } catch { return ''; }
}

// v5.7.57: Host stands are Tables Ready (?mode=waitlist) and Table Bookings
// (?mode=bookings). Both pair through waitlist_devices on an anonymous auth
// session, so they have NO devices row and NO user_profiles.location_id. In the
// database that makes them a different identity class from a till: the waitlist
// and bookings tables are fenced with waitlist_can_write(), while the money
// tables (shifts, closed_checks, cash_movements, drawer_sessions) are fenced
// with pos_can_access(), which a host stand deliberately fails.
//
// A host stand seats guests, it never takes money, so it must never touch the
// till tables. Anything on a shared boot path that writes one has to check this
// first, or the write is refused by RLS and surfaces as a raw Postgres error
// during an operation that actually succeeded.
const HOST_STAND_MODES = new Set(['waitlist', 'bookings']);
export function isHostStandMode() {
  return HOST_STAND_MODES.has(getDeviceMode());
}

// Surfaces where a PERSON signs in with a password (Back Office, admin portal, Owner app,
// Staff app). The app start (useSupabaseInit) must never hand them an anonymous device session:
// the Owner app treated one as "signed in" and showed an empty dashboard with no login form,
// and an anonymous sign in racing a password sign in could overwrite it. Since the second sign
// in step (docs/SECOND_STEP.md) a person's session must be their own, finished with Face ID,
// fingerprint or an authenticator code. (ensureAuthToken itself keeps its old Back Office only
// rule, so a customer page never loses its anonymous checkout session because of a mode that
// was saved on the same address.)
const LOGIN_SURFACE_MODES = new Set(['office', 'backoffice', 'admin', 'owner', 'staff']);
export function isLoginSurfaceMode() {
  return LOGIN_SURFACE_MODES.has(getDeviceMode());
}

export const getLocationId = async () => {
  if (isMock) return 'loc-demo';
  if (_resolvedLocationId) return _resolvedLocationId;
  if (!supabase) return null;

  // v5.5.245: check localStorage FIRST (sync, instant) before any network call.
  // This matches getActiveLocationSync() priority and prevents hangs on POS
  // devices where supabase.auth.getUser() fails without an auth session.

  // Back office explicit location override — ONLY in back-office/admin mode.
  // v5.5.311: previously read unconditionally, so a POS/MPOS/KDS terminal
  // sharing a browser with the BO resolved to the BO's location → cross-tenant
  // reads/writes. POS modes must use the paired device location below.
  if (isBackOfficeMode()) {
    try {
      const boLoc = JSON.parse(localStorage.getItem('rpos-bo-location') || 'null');
      if (boLoc) { _resolvedLocationId = boLoc; return boLoc; }
    } catch {}
  }

  // POS: paired device locationId (moved BEFORE auth — localStorage is instant,
  // auth.getUser() is a network call that hangs on Android POS without a session)
  try {
    const paired = JSON.parse(localStorage.getItem('rpos-device') || 'null');
    if (paired?.locationId) {
      _resolvedLocationId = paired.locationId;
      return _resolvedLocationId;
    }
  } catch {}

  // Authenticated user — read location from user_profiles in Ops DB
  // (only reached when neither BO override nor device pairing is set)
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase.from('user_profiles').select('location_id').eq('id', user.id).single();
      if (profile?.location_id) {
        _resolvedLocationId = profile.location_id;
        return _resolvedLocationId;
      }
    }
  } catch {}

  return null;
};

export const setResolvedLocationId = (id) => {
  // v5.5.4: route through enforceTenantFence so the wipe decision is based on the
  // persistent rpos-active-location TAG (durable across reloads) instead of the
  // in-memory _resolvedLocationId (null on every fresh module load — which caused
  // a spurious wipe on every BO load in v5.5.3, taking rpos-device with it).
  enforceTenantFence(id);
  _resolvedLocationId = id;
};
export const clearResolvedLocationId = () => { _resolvedLocationId = null; };
export const LOCATION_ID = 'loc-demo';

/**
 * v5.5.183: Get a valid Supabase access token for edge-function calls.
 * Back-office users already have a session (signInWithPassword). POS devices
 * (paired via pairing code) do NOT, so we fall back to signInAnonymously()
 * which gives us a lightweight JWT with role='authenticated'. The same
 * approach QR and Online checkout already use.
 *
 * v5.8.57 (ported into the database fence release, contract A1): AN ANONYMOUS SIGN-IN
 * MUST NEVER REPLACE AN IDENTITY THAT STILL EXISTS. auth-js reports session === null both
 * for "this browser has no session" and for "the refresh call failed on the network, the
 * session is still in storage" (AuthRetryableFetchError; see the proof written up in
 * lib/authSession.js). This used to take the second case as the first and mint a NEW
 * auth.uid(), which silently cut a paired till, kiosk or TV off from every row fenced on
 * its old one (devices.device_uid, menu_board_screens.device_uid).
 *
 * resolveAuthToken rides out a short outage (two retries, under a second in total) and
 * then falls back to the token already in storage while it is still valid. It only ever
 * signs in anonymously when storage holds no refresh token.
 *
 * The contract callers see is UNCHANGED: a token string, or null, and the only throw is
 * still the anonymous sign-in failing on a device with no identity.
 */
export const ensureAuthToken = async () => {
  if (!supabase) return null;
  // v5.5.307 / v5.5.311: NEVER create an anonymous session in back-office / admin mode.
  // The Supabase client shares storageKey 'rpos-auth', so an anonymous session created
  // here would be picked up by BackOfficeApp.getSession() and mistaken for a (userless)
  // login. The back office still gets the retry and the stored-token fallback.
  const res = await resolveAuthToken({
    auth: supabase.auth,
    storage: typeof localStorage !== 'undefined' ? localStorage : null,
    storageKey: AUTH_STORAGE_KEY,
    allowAnonymous: !isBackOfficeMode(),
  });
  if (res.outcome === AUTH_OUTCOMES.ANON_FAILED) {
    throw new Error('Could not start auth session: ' + (res.error?.message || 'unknown error'));
  }
  if (res.outcome === AUTH_OUTCOMES.STORED || res.outcome === AUTH_OUTCOMES.HELD) {
    console.warn('[auth] session refresh is failing. Keeping this device identity rather than signing in anonymously. Outcome:', res.outcome);
  }
  return res.token;
};

/** Last auth outcome, for on-device diagnostics. */
export const getAuthTokenOutcome = () => lastAuthOutcome();

/**
 * v5.5.758 — POS-core RLS cutover, Stage 1: bind this already-paired POS-family device
 * (POS/KDS/bar/tables) to its location server-side on every boot, so the link survives
 * without a manual re-pair (a device that boots straight in never hits PairingScreen).
 * Secure: claim_device() stamps devices.device_uid from the JWT (auth.uid()), gated by the
 * pairing CODE — the proof of authorisation. We persist the code in rpos-device the first
 * time (read from the still-open devices row) so later boots re-claim without needing to
 * read the (Stage-3-locked) devices table. Best-effort — never throws into the boot path.
 */
/**
 * v5.8.99: the claim is a PROMISE now. Writes that RLS gates on the device link (a shift, a cash
 * drawer) can await it, because the claim is a network round trip and the staff PIN arrives
 * within a second of boot. Before this, the first shift of the day was often refused with
 * "new row violates row-level security policy" and the save health bar told staff their work
 * was not saving (Peter, 17 Sep 2026).
 */
let _claimPromise = null;

/** Resolves true when the device claim finished, false when it is not applicable or too slow. */
export const whenDeviceClaimed = (waitMs = 4000) => {
  if (!_claimPromise) return Promise.resolve(false);
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res(false), waitMs); });
  return Promise.race([_claimPromise.then(() => true).catch(() => false), timeout]).finally(() => clearTimeout(timer));
};

export const claimPairedDeviceOnBoot = () => {
  _claimPromise = _claimDevice();
  return _claimPromise;
};

// Database fence stage 1 (contract A2): the boot re-link uses the device SECRET, never a
// code read back from the table. Order: reclaim_device (secret), else device_status and, for
// a till that is bound but has no secret yet (every grandfathered till), device_issue_secret,
// else claim_device_v2 with the code saved before this release (works until file 2). A
// refusal dispatches rpos-device-link-lost (the banner, components/DeviceLinkBanner.jsx), a
// re-link dispatches rpos-device-relinked (parked writes are sent again), and the heartbeat
// then reports fence_v1.
// FENCE STAGE 1 FALLBACK: while 20260919a is not run the new functions are missing and
// runDeviceLink runs today's claim (read pairing_code once, then claim_device). Remove the
// readLegacyCode and saveLegacyCode arguments below once 20260919b has run.
export const KIOSK_ID_KEY = 'rpos-kiosk-id';
export const KIOSK_SECRET_KEY = 'rpos-kiosk-secret';

/** The device this browser is paired as: a till (rpos-device) or a kiosk (rpos-kiosk-id). */
export function readLocalDevice() {
  try {
    const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
    if (dev && dev.id && dev.id !== 'admin' && !dev.adminMode && dev.locationId) {
      return { kind: 'till', id: dev.id, deviceSecret: dev.deviceSecret || null, pairingCode: dev.pairingCode || null, locationName: dev.locationName || null };
    }
  } catch { /* fall through */ }
  try {
    if (getDeviceMode() === 'kiosk') {
      const id = localStorage.getItem(KIOSK_ID_KEY);
      if (id) return { kind: 'kiosk', id, deviceSecret: localStorage.getItem(KIOSK_SECRET_KEY) || null, pairingCode: null, locationName: null };
    }
  } catch { /* none */ }
  return null;
}

/** Keep the one time device secret the server handed out (shown once, never readable again). */
export function saveDeviceSecret(kind, secret) {
  if (!secret) return;
  if (kind === 'kiosk') { localStorage.setItem(KIOSK_SECRET_KEY, secret); return; }
  const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
  if (!dev) return;
  dev.deviceSecret = secret;
  localStorage.setItem('rpos-device', JSON.stringify(dev));
}

const dispatchLink = (name, detail) => {
  try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* no window */ }
};

/**
 * Report this build to the server (contract A10). Resolves the device_heartbeat answer,
 * { unsupported: true } while the function does not exist, or null on a failure.
 * Fix round (19 Sep):
 *   A13: the device id saved on this till (or the kiosk id) goes with it, so the server can see a
 *        device that is switched on but not linked (file B waits until there is none).
 *   A14: while device_heartbeat does not exist, this till writes its own last_seen and
 *        app_version, so the runbook's step 2 query shows every till is on this release BEFORE
 *        file A. FENCE STAGE 1 FALLBACK (the KDS also keeps its db.js updateDeviceHeartbeat).
 */
export const sendDeviceHeartbeat = async () => {
  if (!supabase) return null;
  const local = readLocalDevice();
  try {
    const { data, error } = await supabase.rpc('device_heartbeat', heartbeatArgs({ version: VERSION, caps: FENCE_CAPS, deviceId: local?.id }));
    if (error) {
      if (!isMissingRpc(error)) return null;
      if (local?.id) {
        try {
          const patch = legacyHeartbeatPatch({ version: VERSION });
          const { error: patchErr } = await supabase.from('devices').update(patch).eq('id', local.id);
          if (patchErr && isMissingColumn(patchErr, 'client_caps')) {
            // Step 1b (20260919_OPS_fence_0_caps.sql) is not run yet: write the rest, so the
            // runbook's version query still shows this build.
            const { client_caps: _caps, ...rest } = patch;
            await supabase.from('devices').update(rest).eq('id', local.id);
          }
        } catch { /* best effort: the row stays as it was */ }
      }
      return { unsupported: true };
    }
    return data || null;
  } catch { return null; }
};

// The last answer of the device link on this page (contract A12: OfflineQueue may start after
// the boot link already answered, so it asks here instead of waiting for an event it missed).
let _lastLinkOutcome = null;
export const getLastDeviceLinkOutcome = () => _lastLinkOutcome;

/**
 * Re-link this browser's device and tell the app what happened. allowLegacy runs today's
 * claim when the fence functions are missing (boot only, so a wake never repeats it).
 */
export const linkDevice = async ({ allowLegacy = true } = {}) => {
  if (!supabase) return { outcome: 'skipped' };
  const dev = readLocalDevice();
  if (!dev) return { outcome: 'skipped' };
  let res;
  try {
    await ensureAuthToken();
    res = await runDeviceLink({
      rpc: (name, args) => (args ? supabase.rpc(name, args) : supabase.rpc(name)),
      device: dev,
      allowLegacy,
      saveSecret: (secret) => { try { saveDeviceSecret(dev.kind, secret); } catch { /* quota */ } },
      // FENCE STAGE 1 FALLBACK (today's path, tills only).
      readLegacyCode: dev.kind === 'till' ? async () => {
        const { data } = await supabase.from('devices').select('pairing_code').eq('id', dev.id).maybeSingle();
        return data?.pairing_code || null;
      } : null,
      saveLegacyCode: dev.kind === 'till' ? (code) => {
        const cur = JSON.parse(localStorage.getItem('rpos-device') || 'null');
        if (cur) { cur.pairingCode = code; localStorage.setItem('rpos-device', JSON.stringify(cur)); }
      } : null,
      // Contract A15: once the fence functions exist a saved code can never re-link: drop it.
      forgetLegacyCode: dev.kind === 'till' ? () => {
        const cur = JSON.parse(localStorage.getItem('rpos-device') || 'null');
        if (cur && 'pairingCode' in cur) { delete cur.pairingCode; localStorage.setItem('rpos-device', JSON.stringify(cur)); }
      } : null,
    });
  } catch (e) {
    console.warn('[boot] device link failed (non-fatal):', e?.message);
    res = { outcome: 'unknown', message: e?.message };
  }
  const detail = { ...res, kind: dev.kind, deviceId: dev.id };
  _lastLinkOutcome = res.outcome;
  if (res.outcome === 'lost') dispatchLink('rpos-device-link-lost', detail);
  else if (res.outcome === 'relinked') dispatchLink('rpos-device-relinked', detail);
  else if (res.outcome === 'linked') dispatchLink('rpos-device-linked', detail);
  else if (res.outcome === 'legacy' || res.outcome === 'unsupported') dispatchLink('rpos-device-link-unsupported', detail);
  if (res.outcome !== 'skipped') { sendDeviceHeartbeat(); }
  return res;
};

const _claimDevice = () => linkDevice({ allowLegacy: true });

// ──────────────────────────────────────────────────────────────────
// v5.5.3 — TENANT FENCE  (hotfixed in v5.5.4)
//
// Every boot, pairing, and explicit location switch routes through enforceTenantFence
// to guarantee that location-scoped localStorage state from a previously-active
// location is wiped before the new location's app initialisation reads from it.
//
// Without this, a single browser used at Loc 1 then re-paired (or BO-switched) to
// Loc 2 would carry Loc 1's open sessions, closed checks, KDS tickets, config
// snapshot, printers, device profiles, etc. into Loc 2's hydrated state — because
// every one of those localStorage keys is bare-named (no location_id in the key).
//
// The fence works in two parts:
//   1. enforceTenantFence(activeLocId): on every boot/pair/switch, compare the
//      active location to the rpos-active-location tag in localStorage. If they
//      DIFFER (real mismatch), purgeStaleLocationData() wipes every rpos-* key
//      except the always-keep set. Then stamps the new tag.
//   2. Application code calls enforceTenantFence as the very first thing in its
//      boot path so the wipe happens before any reader hydrates from localStorage.
//
// v5.5.4: REMOVED the "tag missing → wipe for safety" branch from the previous
// release. That branch fired on EVERY existing terminal upgrading to v5.5.3,
// wiping rpos-device and bouncing every POS to the PairingScreen. The wipe also
// took the in-flight session backup with it, causing fired-courses state to be
// lost and kitchen tickets to reprint on the next save+send.
//
// The new behaviour: on first v5.5.4 boot for an existing terminal, the tag is
// absent but localStorage already contains data scoped to whatever location the
// terminal was previously paired to (rpos-device.locationId). The active location
// is the same, so no wipe is needed — just stamp the tag and continue. The wipe
// only fires when there's an actual MISMATCH between the current active location
// and the recorded tag, which is the only scenario where stale data is a hazard.
//
// Keys that always survive a wipe:
//   rpos-auth          — Supabase auth token; lives across all locations
//   rpos-bo-location   — the BO location override; the wipe trigger itself
//   rpos-active-location — the tenant fence tag; written immediately after wipe
//   rpos-device-mode   — pos|office|admin selector; cross-location
//   rpos-theme         — UI preference; cross-location
//   rpos-device        — POS pairing record. Carries locationId in its body and
//                        IS the location anchor on POS terminals. Wiping it
//                        unpairs the terminal. v5.5.4: added to keep set so
//                        a wipe can't bounce a paired terminal to PairingScreen.
//                        On legitimate re-pair to a different location, the
//                        PairingScreen flow OVERWRITES rpos-device explicitly,
//                        so keeping it across wipes does not block re-pairing.
// ──────────────────────────────────────────────────────────────────

const TENANT_FENCE_KEEP = new Set([
  'rpos-auth',
  'rpos-bo-location',
  'rpos-active-location',
  'rpos-device-mode',
  'rpos-theme',
  'rpos-device',
  'rpos-mbscreen',   // menu-board screen pairing record (its own device identity; no rpos-device)
  // Self order kiosk pairing and its customer language (KioskSurface.jsx, i18n.js). A kiosk
  // has no rpos-device, so without these a location switch would unpair it.
  'rpos-kiosk-id',
  'rpos-kiosk-token',
  'rpos-kiosk-lang',
  // Database fence stage 1 (contract A4): the kiosk's one time device secret. Wiping it
  // would force a re-pair with a new Back Office code.
  'rpos-kiosk-secret',
]);

/**
 * Synchronously resolve the location_id this browser is currently scoped to.
 * Reads localStorage only — no Supabase call. Used by the boot-time tenant
 * fence which must run before any async work.
 *
 * Priority matches getLocationId() so the fence agrees with later resolution:
 *   1. rpos-bo-location    (set by LocationSwitcher; BO mode override)
 *   2. rpos-device         (POS pairing; carries locationId)
 *   3. null                (no location yet — pre-pairing or unauthenticated)
 */
export function getActiveLocationSync() {
  // v5.5.311: honour the BO override only in back-office/admin mode (see
  // getLocationId). POS/MPOS/KDS/kiosk must resolve via the paired device.
  if (isBackOfficeMode()) {
    try {
      const bo = JSON.parse(localStorage.getItem('rpos-bo-location') || 'null');
      if (bo) return bo;
    } catch { /* fall through */ }
  }
  try {
    const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
    if (dev?.locationId) return dev.locationId;
  } catch { /* fall through */ }
  return null;
}

/**
 * Wipe every location-scoped key from localStorage and sessionStorage. Reason
 * is logged so any unexplained state loss in production is traceable.
 */
export function purgeStaleLocationData(reason) {
  let wiped = 0;
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('rpos-') && !TENANT_FENCE_KEEP.has(k)) toRemove.push(k);
    }
    toRemove.forEach(k => { localStorage.removeItem(k); wiped++; });
  } catch (e) {
    console.warn('[tenantFence] localStorage wipe failed:', e?.message || e);
  }
  try {
    const toRemove = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('rpos-') && !TENANT_FENCE_KEEP.has(k)) toRemove.push(k);
    }
    toRemove.forEach(k => { sessionStorage.removeItem(k); wiped++; });
  } catch (e) {
    console.warn('[tenantFence] sessionStorage wipe failed:', e?.message || e);
  }
  // v5.5.11: clear in-memory location config cache too. The cache is keyed by
  // location_id so it's per-location, but on a real location switch we also
  // want to invalidate any stale entries (e.g., if the location row was edited
  // in the BO between this device's last read and the switch).
  try {
    // Dynamic import — locationTime is a sibling module and importing it at
    // the top of supabase.js would create a circular dep (locationTime imports
    // from supabase).
    import('./locationTime').then(m => m.clearLocationConfigCache?.()).catch(() => {});
  } catch (e) { void e; }
  console.warn('[tenantFence] purged', wiped, 'stale keys —', reason);
}

/**
 * The boot-time + pair-time fence. Wipes location-scoped state ONLY when the
 * active location differs from the persistent rpos-active-location tag. Always
 * stamps the tag with the current active location.
 *
 * v5.5.4: no longer wipes when the tag is absent (first-ever boot). On first
 * boot, localStorage state is from the same single location the terminal was
 * previously paired to, so wiping is unnecessary and harmful.
 *
 * Pass an explicit activeLocId when you know the value (e.g. immediately after
 * pairing). Pass undefined to have it read from localStorage.
 */
export function enforceTenantFence(activeLocId) {
  if (activeLocId === undefined) activeLocId = getActiveLocationSync();
  let lastActive = null;
  try { lastActive = localStorage.getItem('rpos-active-location'); } catch { /* fall through */ }

  if (activeLocId && lastActive && activeLocId !== lastActive) {
    // Real switch detected — wipe stale data from the previous location.
    purgeStaleLocationData('tenantFence: location changed ' + lastActive + ' -> ' + activeLocId);
  }
  // No "tag missing → wipe" branch in v5.5.4. Existing localStorage data
  // is from the terminal's last-known location and is safe to keep on the
  // first v5.5.4 boot. Only real mismatches trigger a wipe.

  if (activeLocId) {
    try { localStorage.setItem('rpos-active-location', activeLocId); } catch { /* fall through */ }
  }
  return activeLocId;
}


// ──────────────────────────────────────────────────────────────────
// v4.7.1 — Back Office location switching
//
// The existing getLocationId() reads 'rpos-bo-location' from localStorage
// as a manual override. setLocationId writes to that key, clears the
// in-memory resolver cache, and emits a custom event so consumers can
// re-fetch their data.
//
// getAvailableLocations() returns every location the current authenticated
// user has access to via user_locations + a join to locations.
// ──────────────────────────────────────────────────────────────────

export const setLocationId = (locId) => {
  if (locId == null) {
    localStorage.removeItem('rpos-bo-location');
  } else {
    localStorage.setItem('rpos-bo-location', JSON.stringify(locId));
  }
  // Bust the cached resolved id so the next getLocationId() picks up the change.
  _resolvedLocationId = locId || null;
  // Notify consumers — the back office can listen for this and reload data.
  try { window.dispatchEvent(new CustomEvent('rpos-location-changed', { detail: { locationId: locId } })); } catch {}
  return locId;
};

/**
 * Returns the locations the current user has access to. Uses user_locations
 * join. Falls back to the user's profile location if user_locations is empty.
 * Mock-mode returns a single sentinel location.
 */
export const getAvailableLocations = async () => {
  if (isMock) return [{ id: 'loc-demo', name: 'Demo Location' }];
  if (!supabase) return [];
  try {
    const { data: { user } = {} } = await supabase.auth.getUser();
    if (!user) return [];
    // user_locations row(s) for this user
    const { data: links, error: e1 } = await supabase
      .from('user_locations')
      .select('location_id, role')
      .eq('user_id', user.id);
    if (e1 || !links) return [];
    if (links.length === 0) return [];
    const locIds = [...new Set(links.map(r => r.location_id).filter(Boolean))];
    if (locIds.length === 0) return [];
    const { data: locs, error: e2 } = await supabase
      .from('locations')
      .select('id, name, org_id')
      .in('id', locIds)
      .order('name');
    if (e2) return [];
    return locs || [];
  } catch (e) {
    console.warn('[supabase] getAvailableLocations failed:', e?.message || e);
    return [];
  }
};
