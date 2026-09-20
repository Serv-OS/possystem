// supabase/functions/_shared/deviceAuthority.ts
//
// Is this session a paired device of THIS venue? The same test the database uses:
// public.pos_can_access(), device arm.
//
// WHY (database fence stage 1, 19 Sep 2026). The gift card, loyalty and refund functions took
// any JWT as authority, and an anonymous one is free to anybody holding the public anon key.
// The parked lockdown branch (fix/loyalty-giftcard-exposure) added a device arm, but it read
// `devices.device_uid` while the devices table was still writable by anybody, so the arm could be
// forged. Stage 1 fixes the table (20260919a): only the claim functions link a device, a link is
// trusted only when a claim bound it (`bound_via` set), a device's venue is pinned, and removing or
// unpairing a device clears its link. So the device arm is now exactly pos_can_access:
//
//   fenced (20260919a is in, fence_state has 'file_a'):
//     devices.device_uid = auth.uid() AND bound_via IS NOT NULL
//       AND status IN ('active', 'online') AND location_id = the venue
//     OR ops_devices.device_uid = auth.uid() AND active AND location_id = the venue
//   legacy (before 20260919a, or after its roll back): the same without bound_via, which is
//     the live pos_can_access of 18 Sep (forgeable until file A runs; nothing better exists
//     before it, and a till must keep working).
//
// The venue is the one the call acts for: its location id resolved to the OPS id (a Platform id
// is mapped through ops_location_id, see staffAccess.ts staffLocationKeys). A device of another
// venue, even of the same company, never passes: a till always sends its own venue.
//
// PURE. No imports, so node tests load it directly.

export type FenceState = 'fenced' | 'legacy' | 'unknown';

/** The statuses pos_can_access accepts. Anything else (removed, unpaired, awaiting_pairing) is not a device. */
export const DEVICE_LIVE_STATUSES = ['active', 'online'];

type PgError = { code?: string | null; message?: string | null; details?: string | null } | null | undefined;

/**
 * Is this PostgREST error "that table or column does not exist" (the fence has not run)?
 * 42P01 undefined table, 42703 undefined column, PGRST204 unknown column in the schema cache,
 * PGRST205 unknown table in the schema cache, PGRST200 unknown relation.
 */
export function isMissingSchema(error: PgError): boolean {
  if (!error) return false;
  const code = String(error.code || '');
  if (['42P01', '42703', 'PGRST204', 'PGRST205', 'PGRST200'].includes(code)) return true;
  const msg = `${error.message || ''} ${error.details || ''}`.toLowerCase();
  return /does not exist|could not find the (table|column)|schema cache/.test(msg);
}

/**
 * The fence state from a read of `fence_state` (service role):
 *   the 'file_a' row is there                 -> fenced
 *   no such table, or no 'file_a' row         -> legacy (before file A, or after its roll back,
 *                                                 which deletes the row)
 *   any other error (network, timeout)        -> unknown
 */
export function fenceStateFrom(res: { data?: Array<{ key?: unknown }> | null; error?: PgError }): FenceState {
  if (res?.error) return isMissingSchema(res.error) ? 'legacy' : 'unknown';
  const rows = Array.isArray(res?.data) ? res!.data! : [];
  return rows.some((r) => String(r?.key ?? '') === 'file_a') ? 'fenced' : 'legacy';
}

export type DeviceRow = {
  id?: string | null;
  device_uid?: string | null;
  location_id?: string | null;
  status?: string | null;
  bound_via?: string | null;
};
export type OpsDeviceRow = { device_uid?: string | null; location_id?: string | null; active?: boolean | null };

export type DeviceDecision = {
  ok: boolean;
  via: 'device' | 'ops_device' | null;
  /** Why it failed, for the log. */
  reason: 'no_session' | 'no_venue' | 'no_device' | 'not_bound' | 'not_live' | 'other_venue' | null;
};

/**
 * The device arm of pos_can_access for one venue. `devices` and `opsDevices` are the rows whose
 * device_uid is the caller (the gatherer filters on it; this checks it again). `fence` says
 * whether bound_via counts ('unknown' is treated as fenced: the stricter reading, and it only
 * happens on a failed read after the table exists).
 */
export function decideDeviceAccess(p: {
  uid: string | null | undefined;
  opsLocationId: string | null | undefined;
  fence: FenceState;
  devices?: DeviceRow[] | null;
  opsDevices?: OpsDeviceRow[] | null;
}): DeviceDecision {
  const uid = p.uid ? String(p.uid) : '';
  const venue = p.opsLocationId ? String(p.opsLocationId) : '';
  if (!uid) return { ok: false, via: null, reason: 'no_session' };
  if (!venue) return { ok: false, via: null, reason: 'no_venue' };
  const strict = p.fence !== 'legacy';
  const mine = (p.devices || []).filter((d) => !!d && String(d.device_uid ?? uid) === uid);
  const here = mine.filter((d) => String(d.location_id ?? '') === venue);
  const live = here.filter((d) => DEVICE_LIVE_STATUSES.includes(String(d.status ?? '')));
  const bound = strict ? live.filter((d) => !!d.bound_via) : live;
  if (bound.length) return { ok: true, via: 'device', reason: null };
  const ops = (p.opsDevices || []).filter((o) => !!o && String(o.device_uid ?? uid) === uid);
  if (ops.some((o) => o.active === true && String(o.location_id ?? '') === venue)) {
    return { ok: true, via: 'ops_device', reason: null };
  }
  let reason: DeviceDecision['reason'] = 'no_device';
  if (live.length) reason = 'not_bound';
  else if (here.length) reason = 'not_live';
  else if (mine.length || ops.length) reason = 'other_venue';
  return { ok: false, via: null, reason };
}

// ── The switch for the till loyalty paths ─────────────────────────────────
export type AuthorityMode = 'report' | 'enforce';

/**
 * LOYALTY_AUTHORITY_MODE for loyalty-earn, loyalty-redeem, loyalty-refund and the full view of
 * loyalty-balance (the till paths whose legitimate callers are paired devices):
 *   'enforce' (exact word, any case)  -> enforce now, whatever the fence says
 *   'report'  (exact word, any case)  -> report only (escape hatch: allow and log)
 *   unset, blank or anything else     -> FOLLOW THE FENCE: report while 20260919a has not run
 *                                        (a till's device link may be missing or forged, and a
 *                                        refusal there would cost real sales), enforce once it
 *                                        has (every kept till is bound; one that is not shows the
 *                                        red banner and takes no cards either). An unknown fence
 *                                        state enforces.
 * Every other money function (gift issue, void, reverse, fulfil, redeem by card id, refunds,
 * config and reward writes) is enforced always: its callers are staff or bound devices, or it
 * moves money to whoever calls it.
 */
export function loyaltyModeFor(envRaw: unknown, fence: FenceState): AuthorityMode {
  const v = typeof envRaw === 'string' ? envRaw.trim().toLowerCase() : '';
  if (v === 'enforce') return 'enforce';
  if (v === 'report') return 'report';
  return fence === 'legacy' ? 'report' : 'enforce';
}
