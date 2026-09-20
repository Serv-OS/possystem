// supabase/functions/_shared/authorityLogLimiter.ts
//
// Keeps the authority log (the `[authority]` lines in the function log; stage 1 adds no table)
// from becoming an unbounded flood (18 Sep 2026, round three).
//
// Every refused or would-be refused call writes one line. Anybody with the public anon key can
// make those calls as fast as they like, each from a fresh anonymous session, so the log must
// not grow at the attacker's rate and must never slow a till down. Per function instance:
//   * per caller key (function, reason, caller, location): the first PER_KEY rows in a window
//     are written; the rest are counted and the count rides on that key's next written row
//     (detail.suppressed_before), so nothing is lost silently.
//   * per venue key (function, reason, location) for ANONYMOUS callers only: a flood from many
//     throwaway sessions against one venue is sampled the same way.
//   * a global cap per window across everything.
// Writing it is never awaited on the till path (loyalty-utils recordAuthority).
//
// PURE. No imports, so node tests load it directly.

export type LimiterOptions = {
  windowMs?: number;
  perKey?: number;
  perVenueAnonymous?: number;
  global?: number;
  now?: () => number;
};

export type LogKeyParts = {
  fn?: unknown;
  reason?: unknown;
  callerId?: unknown;
  locationId?: unknown;
  anonymous?: boolean | null;
};

export function createAuthorityLogLimiter(opts: LimiterOptions = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const perKey = opts.perKey ?? 5;
  const perVenue = opts.perVenueAnonymous ?? 30;
  const globalCap = opts.global ?? 120;
  const now = opts.now ?? (() => Date.now());

  let windowStart = now();
  let globalCount = 0;
  const keyCount = new Map<string, number>();
  const venueCount = new Map<string, number>();
  const suppressed = new Map<string, number>();
  let suppressedGlobal = 0;

  const roll = () => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      globalCount = 0;
      keyCount.clear();
      venueCount.clear();
    }
  };

  return {
    /**
     * May this row be written? When it may, `suppressedBefore` is how many rows for the same
     * caller key were dropped since the last one written (put it on the row).
     */
    admit(p: LogKeyParts): { write: boolean; suppressedBefore: number; key: string } {
      roll();
      const s = (v: unknown) => (v === null || v === undefined ? '' : String(v).slice(0, 80));
      const key = [s(p.fn), s(p.reason), s(p.callerId), s(p.locationId)].join('|');
      const venueKey = [s(p.fn), s(p.reason), s(p.locationId)].join('|');
      const k = keyCount.get(key) ?? 0;
      const v = venueCount.get(venueKey) ?? 0;
      const drop = globalCount >= globalCap || k >= perKey || (p.anonymous === true && v >= perVenue);
      if (drop) {
        suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
        suppressedGlobal++;
        return { write: false, suppressedBefore: 0, key };
      }
      keyCount.set(key, k + 1);
      if (p.anonymous === true) venueCount.set(venueKey, v + 1);
      globalCount++;
      const before = suppressed.get(key) ?? 0;
      suppressed.delete(key);
      // Bound the memory of suppressed keys too: a flood of throwaway sessions makes a new key
      // each time. Past 5000 keys the per key counts are dropped (the global count stays).
      if (suppressed.size > 5000) suppressed.clear();
      return { write: true, suppressedBefore: before, key };
    },
    /** Total rows dropped since this instance started (for the function log). */
    suppressedTotal() { return suppressedGlobal; },
  };
}
