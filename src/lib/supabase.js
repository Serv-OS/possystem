import { createClient } from '@supabase/supabase-js';

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

export const supabase = isMock ? null : createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'rpos-auth',
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
    let mode = '';
    try { mode = new URL(window.location.href).searchParams.get('mode') || ''; } catch { /* no window */ }
    if (!mode) { try { mode = localStorage.getItem('rpos-device-mode') || ''; } catch { /* none */ } }
    return mode === 'office' || mode === 'backoffice' || mode === 'admin';
  } catch { return false; }
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
 * (paired via pairing code) do NOT — so we fall back to signInAnonymously()
 * which gives us a lightweight JWT with role='authenticated'. The same
 * approach QR and Online checkout already use.
 */
export const ensureAuthToken = async () => {
  if (!supabase) return null;
  const { data: existing } = await supabase.auth.getSession();
  const token = existing?.session?.access_token;
  if (token) return token;
  // v5.5.307: NEVER create an anonymous session in back-office / admin mode.
  // The Supabase client shares storageKey 'rpos-auth', so an anonymous session
  // created here would be picked up by BackOfficeApp.getSession() and mistaken
  // for a (userless) login — "blank back office, logged in with no user".
  // The back office only calls edge functions when a real user is signed in,
  // so returning null here is safe — it just means "not authenticated yet".
  // v5.5.311: use isBackOfficeMode() which also matches the 'backoffice'
  // spelling (the previous check only matched 'office', so a BO device whose
  // persisted mode is 'backoffice' and URL lacks ?mode= could still mint an
  // anon session → blank back office).
  if (isBackOfficeMode()) return null;
  // No session (POS device, expired, etc.) — anonymous sign-in
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error('Could not start auth session: ' + error.message);
  return data?.session?.access_token || null;
};

/**
 * v5.5.758 — POS-core RLS cutover, Stage 1: bind this already-paired POS-family device
 * (POS/KDS/bar/tables) to its location server-side on every boot, so the link survives
 * without a manual re-pair (a device that boots straight in never hits PairingScreen).
 * Secure: claim_device() stamps devices.device_uid from the JWT (auth.uid()), gated by the
 * pairing CODE — the proof of authorisation. We persist the code in rpos-device the first
 * time (read from the still-open devices row) so later boots re-claim without needing to
 * read the (Stage-3-locked) devices table. Best-effort — never throws into the boot path.
 */
export const claimPairedDeviceOnBoot = async () => {
  if (!supabase) return;
  let dev; try { dev = JSON.parse(localStorage.getItem('rpos-device') || 'null'); } catch { return; }
  if (!dev || !dev.id || dev.id === 'admin' || dev.adminMode || !dev.locationId) return;
  try {
    await ensureAuthToken();
    let code = dev.pairingCode;
    if (!code) {
      const { data } = await supabase.from('devices').select('pairing_code').eq('id', dev.id).maybeSingle();
      code = data?.pairing_code || null;
      if (code) { dev.pairingCode = code; try { localStorage.setItem('rpos-device', JSON.stringify(dev)); } catch { /* quota */ } }
    }
    if (code) await supabase.rpc('claim_device', { p_code: code });
  } catch (e) {
    console.warn('[boot] device claim failed (non-fatal):', e?.message);
  }
};

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
