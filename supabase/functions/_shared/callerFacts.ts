// supabase/functions/_shared/callerFacts.ts
//
// WHO IS CALLING a money function (gift cards, loyalty, promo, card refunds): the facts, read with
// the service role, and the decisions applied to them. Database fence stage 1 (19 Sep 2026).
//
// The functions used to take ANY JWT as authority, and an anonymous one is free to anybody holding
// the public anon key (signInAnonymously). Authority is now exactly one of:
//   * staff of the venue: a real (never anonymous) login with a user_locations link to the venue,
//     or a verified super admin (the database's user_accessible_locations() after 20260919a), or
//     a Platform company role for the venue's company (staffAccess.ts);
//   * a device BOUND to the venue: the device arm of pos_can_access (deviceAuthority.ts), which
//     after 20260919a needs bound_via (only the claim functions link a device) and before it is
//     the live rule of 18 Sep (fall back safely: a till keeps working until the fence runs);
//   * the loyalty member's own session token (loyalty-session.ts), for their own customer id;
//   * the service role (another edge function).
//
// This module has NO remote imports: the clients are passed in, so node tests drive it with a fake
// Supabase client (src/lib/moneyFunctionFence.test.js). loyalty-utils.ts builds the one instance
// the edge functions use, with the real service role clients.

import {
  decideLoyaltyAuthority, applyAuthorityMode, authorityLogRow,
  type AuthorityMode, type LoyaltyAuthority,
} from './loyalty-authority.ts';
import { inspectSessionToken, memberTokenCoversCheck } from './loyalty-session.ts';
import { decideStaffAccess, staffLocationKeys } from './staffAccess.ts';
import { createAuthorityLogLimiter } from './authorityLogLimiter.ts';
import { decideGiftStaffOnly } from './gift-authority.ts';
import {
  decideDeviceAccess, fenceStateFrom, isMissingSchema, loyaltyModeFor,
  type DeviceDecision, type FenceState,
} from './deviceAuthority.ts';

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A value safe to put in a PostgREST filter: the uuid itself, or the nil uuid (matches nothing). */
export function uuidOr0(v: unknown): string {
  return typeof v === 'string' && UUID_ONLY.test(v) ? v : NIL_UUID;
}

/** The device the client says it is, for the log only (never trusted). */
export function deviceHintOf(body: any): string | null {
  const v = body && typeof body === 'object' ? body.device_hint : null;
  return typeof v === 'string' && UUID_ONLY.test(v) ? v : null;
}

export type MemberSession = { customerId: string; companyId: string; phone: string | null; replay: boolean };

export type CallerFactsDeps = {
  /** Ops service role client (devices, ops_devices, user_profiles, user_locations, fence_state, closed_checks). */
  ops: any;
  /** Platform service role client (locations, user_company_roles). */
  platform: any;
  /** Read an environment variable (LOYALTY_AUTHORITY_MODE). */
  env?: (name: string) => string | undefined | null;
  /** The secret loyalty-otp signs member tokens with. */
  otpSecret: string;
  /** Build a JSON Response (the functions' own helper). */
  json: (body: unknown, status?: number) => Response;
  /** Clock, for the fence state cache. */
  now?: () => number;
  /** Where a log line goes (console.warn in production). */
  log?: (line: string, row: Record<string, unknown>) => void;
};

export function createCallerFacts(deps: CallerFactsDeps) {
  const { ops, platform, json } = deps;
  const env = deps.env ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string, row: Record<string, unknown>) => console.warn(line, JSON.stringify(row)));

  // ── The venue a call acts for ─────────────────────────────────────────
  /**
   * Its OPS location id (the id devices and user_locations use) and its company, from one
   * Platform read. The id may arrive as the Ops id or the Platform id; only the RESOLVED Ops id
   * counts (staffAccess.ts staffLocationKeys).
   */
  async function resolveVenue(locationId: unknown): Promise<{ opsLocationId: string | null; companyId: string | null }> {
    const id = typeof locationId === 'string' ? locationId.trim() : '';
    if (!UUID_ONLY.test(id)) return { opsLocationId: null, companyId: null };
    try {
      const { data: pls } = await platform.from('locations')
        .select('id, ops_location_id, company_id')
        .or(`id.eq.${id},ops_location_id.eq.${id}`)
        .limit(5);
      const r = staffLocationKeys(id, pls || []);
      return { opsLocationId: r.keys[0] ?? null, companyId: r.companyId };
    } catch {
      return { opsLocationId: null, companyId: null };
    }
  }

  // ── Has the fence (20260919a) run? Cached for a minute ────────────────
  let fenceCache: { state: FenceState; at: number } | null = null;
  const FENCE_TTL_MS = 60_000;

  /** 'fenced' once fence_state has 'file_a' (file A records it; its roll back deletes it). */
  async function fenceState(): Promise<FenceState> {
    const t = now();
    if (fenceCache && t - fenceCache.at < FENCE_TTL_MS) return fenceCache.state;
    let state: FenceState = 'unknown';
    try {
      const res = await ops.from('fence_state').select('key').eq('key', 'file_a').limit(1);
      state = fenceStateFrom(res);
    } catch {
      state = 'unknown';
    }
    if (state === 'unknown') return fenceCache ? fenceCache.state : 'unknown';   // a blip keeps the last answer
    fenceCache = { state, at: t };
    return state;
  }

  /**
   * Is the caller a device BOUND to this venue? The device arm of pos_can_access
   * (deviceAuthority.ts): after 20260919a a devices row with device_uid = the caller, bound_via
   * set, status active or online, at this venue, or an active ops_devices row there; before it the
   * same without bound_via. Never throws: a failed read is "not a device".
   */
  async function callerDeviceFor(user: any, opsLocationId: string | null): Promise<DeviceDecision & { fence: FenceState }> {
    const uid = user?.id ? String(user.id) : '';
    if (!uid || !opsLocationId || !UUID_ONLY.test(opsLocationId)) {
      return { ...decideDeviceAccess({ uid, opsLocationId, fence: 'legacy' }), fence: 'unknown' };
    }
    let fence = await fenceState();
    let devices: any[] = [];
    try {
      const cols = fence === 'legacy' ? 'id, device_uid, location_id, status' : 'id, device_uid, location_id, status, bound_via';
      let res: any = await ops.from('devices').select(cols).eq('device_uid', uid).limit(10);
      if (res?.error && fence !== 'legacy' && isMissingSchema(res.error)) {
        // No bound_via column: 20260919a has not run (the fence read failed on the way here).
        fence = 'legacy';
        res = await ops.from('devices').select('id, device_uid, location_id, status').eq('device_uid', uid).limit(10);
      }
      devices = res?.error ? [] : ((res?.data as any[]) || []);
    } catch { devices = []; }
    let opsDevices: any[] = [];
    try {
      const res: any = await ops.from('ops_devices').select('device_uid, location_id, active').eq('device_uid', uid).limit(10);
      opsDevices = res?.error ? [] : ((res?.data as any[]) || []);
    } catch { opsDevices = []; }
    return { ...decideDeviceAccess({ uid, opsLocationId, fence, devices, opsDevices }), fence };
  }

  /**
   * Is this signed in, NON anonymous user staff for the location (or, with no location, for the
   * company)? The SAME rule as the database's user_accessible_locations() after 20260919a:
   * user_locations ONLY (user_profiles.location_id is never access), plus a verified super admin,
   * plus a Platform user_company_roles row for the location's own company. Never throws: a failed
   * read is "not staff".
   */
  async function callerIsStaffFor(user: any, locationId: string | null, companyId: string | null): Promise<boolean> {
    if (!user || user.is_anonymous || !user.id) return false;
    try {
      const [{ data: prof }, { data: uls }, { data: ucr }] = await Promise.all([
        ops.from('user_profiles').select('role').eq('id', user.id).maybeSingle(),
        ops.from('user_locations').select('location_id').eq('user_id', user.id).limit(1000),
        platform.from('user_company_roles').select('company_id').eq('user_id', user.id).limit(200),
      ]);
      let locationKeys: string[] = [];
      let company = companyId ? String(companyId) : null;
      let companyOpsLocationIds: string[] = [];
      if (locationId) {
        // ONLY the resolved Ops id is checked, never the raw id as well (the drifted venues).
        const { data: pls } = await platform.from('locations')
          .select('id, ops_location_id, company_id')
          .or(`id.eq.${uuidOr0(locationId)},ops_location_id.eq.${uuidOr0(locationId)}`)
          .limit(5);
        const resolved = staffLocationKeys(String(locationId), pls || []);
        locationKeys = resolved.keys;
        // A company role only counts for the location's OWN company, never one named by the caller.
        company = resolved.companyId;
      } else if (company) {
        const { data: locs } = await platform.from('locations').select('ops_location_id').eq('company_id', company).limit(500);
        companyOpsLocationIds = (locs || []).map((r: any) => r.ops_location_id).filter(Boolean).map(String);
      }
      return decideStaffAccess({
        user,
        role: prof?.role ?? null,
        userLocationIds: (uls || []).map((r: any) => r.location_id).filter(Boolean).map(String),
        companyRoleCompanyIds: (ucr || []).map((r: any) => r.company_id).filter(Boolean).map(String),
        locationKeys,
        companyId: company,
        companyOpsLocationIds,
      }).ok;
    } catch (e) {
      console.warn('[staff] access check failed:', (e as any)?.message || e);
      return false;
    }
  }

  /**
   * Staff, or a device bound to the venue named by locationId (whose company, when given, must be
   * `companyId`, the company the call resolved from that same location). The device arm is only
   * asked when the staff arm failed.
   */
  async function callerStaffOrDevice(user: any, locationId: string | null, companyId: string | null): Promise<{
    staff: boolean; device: boolean; deviceReason: string | null; opsLocationId: string | null; fence: FenceState | null;
  }> {
    const staff = await callerIsStaffFor(user, locationId, companyId);
    if (staff) return { staff, device: false, deviceReason: null, opsLocationId: null, fence: null };
    if (!user?.id) return { staff, device: false, deviceReason: 'no_session', opsLocationId: null, fence: null };
    const venue = await resolveVenue(locationId);
    if (!venue.opsLocationId) return { staff, device: false, deviceReason: 'no_venue', opsLocationId: null, fence: null };
    if (companyId && venue.companyId && String(venue.companyId) !== String(companyId)) {
      return { staff, device: false, deviceReason: 'other_venue', opsLocationId: venue.opsLocationId, fence: null };
    }
    const d = await callerDeviceFor(user, venue.opsLocationId);
    return { staff, device: d.ok, deviceReason: d.ok ? null : d.reason, opsLocationId: venue.opsLocationId, fence: d.fence };
  }

  /** LOYALTY_AUTHORITY_MODE and the fence: report before 20260919a, enforce after it. */
  async function loyaltyMode(): Promise<AuthorityMode> {
    return loyaltyModeFor(env('LOYALTY_AUTHORITY_MODE'), await fenceState());
  }

  // ── The log ───────────────────────────────────────────────────────────
  const limiter = createAuthorityLogLimiter({ now });

  /**
   * One `[authority]` line in the function log (stage 1 adds no table: Supabase dashboard, Edge
   * Functions, Logs, search "[authority]"). Rate limited, never awaited, never throws.
   */
  function recordAuthority(row: Record<string, unknown>): void {
    try {
      const admit = limiter.admit({
        fn: row.fn, reason: row.reason, callerId: row.caller_id, locationId: row.location_id,
        anonymous: row.caller_anonymous === true,
      });
      if (!admit.write) return;
      const full: Record<string, unknown> = { ...row };
      if (admit.suppressedBefore > 0) {
        full.detail = { ...((row.detail as Record<string, unknown>) ?? {}), suppressed_before: admit.suppressedBefore };
      }
      log('[authority]', full);
    } catch (e) {
      console.warn('[authority] record failed:', (e as any)?.message || e);
    }
  }

  /**
   * The member session for a token, or null. A token past its 24 hours still counts for ONE thing:
   * the order it was live for (closedCheckId names a closed check at this location, closed while
   * the token was live), so a parked redemption can replay days later.
   */
  async function memberSessionFor(token: unknown, opts: { closedCheckId?: unknown; locationId?: unknown } = {}): Promise<MemberSession | null> {
    const t = await inspectSessionToken(token, deps.otpSecret);
    if (!t) return null;
    if (!t.expired) return { customerId: t.customerId, companyId: t.companyId, phone: t.phone, replay: false };
    const checkId = typeof opts.closedCheckId === 'string' ? opts.closedCheckId : '';
    const locId = typeof opts.locationId === 'string' ? opts.locationId : '';
    if (!checkId || !locId) return null;
    try {
      const { data: chk } = await ops.from('closed_checks').select('closed_at').eq('id', checkId).eq('location_id', locId).maybeSingle();
      if (chk?.closed_at && memberTokenCoversCheck(t.issuedAt, Date.parse(chk.closed_at))) {
        return { customerId: t.customerId, companyId: t.companyId, phone: t.phone, replay: true };
      }
    } catch { /* treat as no session */ }
    return null;
  }

  /**
   * The whole fence for loyalty-earn, loyalty-redeem and loyalty-refund (and the full view of
   * loyalty-member-lookup, loyalty-balance and loyalty-enroll): gather the facts, decide, apply the
   * mode, log. allow false means enforce refused: return `response`.
   */
  async function checkLoyaltyAuthority(p: {
    fn: string;
    caller: any;
    locationId: string | null;
    companyId: string;
    customerId: string;
    memberToken?: unknown;
    closedCheckId?: unknown;
    channel?: unknown;
    /** false: a member token never authorises this call (loyalty-refund). Default true. */
    memberAllowed?: boolean;
    /** Force a mode for this function whatever LOYALTY_AUTHORITY_MODE and the fence say. */
    modeOverride?: AuthorityMode;
    deviceHint?: unknown;
  }): Promise<{
    allow: boolean; mode: AuthorityMode; decision: LoyaltyAuthority; response: Response | null;
    memberSession: MemberSession | null;
  }> {
    const mode = p.modeOverride ?? await loyaltyMode();
    const memberAllowed = p.memberAllowed !== false;
    const memberTokenSent = typeof p.memberToken === 'string' && p.memberToken.length > 0;
    const memberSession = memberTokenSent && memberAllowed
      ? await memberSessionFor(p.memberToken, { closedCheckId: p.closedCheckId, locationId: p.locationId })
      : null;
    const memberGood = !!memberSession && memberSession.customerId === String(p.customerId) && memberSession.companyId === String(p.companyId);
    // A bad, expired or refused member token never short cuts the staff and device arms. The facts
    // are only gathered when the member arm did not already pass.
    let staffHasLocation = false;
    let device = false;
    let deviceReason: string | null = null;
    if (!memberGood && p.caller) {
      const f = await callerStaffOrDevice(p.caller, p.locationId, p.companyId);
      staffHasLocation = f.staff;
      device = f.device;
      deviceReason = f.deviceReason;
    }
    const decision = decideLoyaltyAuthority({
      user: p.caller,
      memberTokenSent,
      memberSession,
      staffHasLocation,
      device,
      deviceReason,
      customerId: String(p.customerId),
      companyId: String(p.companyId),
      memberAllowed,
    });
    const applied = applyAuthorityMode(decision, mode);
    if (applied.record) {
      recordAuthority(authorityLogRow({
        fn: p.fn, mode, outcome: applied.outcome, decision, user: p.caller,
        companyId: p.companyId, locationId: p.locationId, customerId: p.customerId,
        closedCheckId: p.closedCheckId, channel: p.channel, deviceHint: p.deviceHint,
        detail: deviceReason ? { device_reason: deviceReason } : null,
      }));
    }
    if (!applied.allow && !decision.ok) {
      return { allow: false, mode, decision, memberSession, response: json({ error: decision.error, code: 'loyalty_authority', reason: decision.reason }, decision.status) };
    }
    return { allow: true, mode, decision, memberSession, response: null };
  }

  /**
   * Staff only, enforced always: gift-issue, gift-import, gift-bulk-create, gift-config, gift-void,
   * gift-resend, and the writes of loyalty-config and loyalty-rewards. Returns null when the caller
   * is staff for the location (or company), else the refusal Response, and logs the refusal.
   */
  async function requireStaff(p: {
    fn: string; caller: any; locationId: string | null; companyId: string | null; what: string; body?: any;
  }): Promise<Response | null> {
    const staff = await callerIsStaffFor(p.caller, p.locationId, p.companyId);
    const d = decideGiftStaffOnly({ user: p.caller, staff }, p.what);
    if (d.ok) return null;
    recordAuthority(authorityLogRow({
      fn: p.fn, mode: 'enforce', outcome: 'refused',
      decision: { ok: false, reason: d.reason, callerKind: !p.caller ? 'none' : (p.caller.is_anonymous ? 'anonymous' : 'user_no_access') },
      user: p.caller, companyId: p.companyId, locationId: p.locationId,
      channel: p.body?.channel ?? null, deviceHint: deviceHintOf(p.body),
    }));
    return json({ error: d.error, code: 'staff_only', reason: d.reason }, d.status);
  }

  return {
    resolveVenue, fenceState, callerDeviceFor, callerIsStaffFor, callerStaffOrDevice, loyaltyMode,
    recordAuthority, memberSessionFor, checkLoyaltyAuthority, requireStaff,
  };
}
