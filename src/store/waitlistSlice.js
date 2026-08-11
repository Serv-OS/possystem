// src/store/waitlistSlice.js
//
// Tables Ready — the store adapter for the walk-in waitlist / live table-queue.
// A factory spread into the single Zustand store. ALL estimation maths, the
// status lifecycle, and the row mappers live in ../lib/waitlist/waitlist.js
// (pure + unit-tested); this file owns ONLY the store wiring: optimistic state,
// CRM linkage, table-floor coupling (seatTable/clearTable), SMS dispatch, and
// table-absent-safe persistence via the data layer.
//
// Conventions honoured:
//  - camelCase in the store; the data layer owns snake_case mapping (waitlistToRow).
//  - STATIC imports only (dynamic import() silently fails in the Vite bundle).
//  - Always resolve a real locationId before any DB write (loc-demo trap guarded).
//  - Every DB call is table-absent-safe: the data layer swallows a missing
//    relation and returns {error}/empty, so nothing here throws at boot.

import {
  estimate,
  bandFor,
  STATUS,
  isActive,
  isStaleActive,
  canTransition,
  currentAverageWait,
  rowToWaitlist,
  waitlistToRow,
  actualWaitMin,
  DEFAULT_BANDS,
  DEFAULT_QUOTE_RULES,
  tablesView,
} from '../lib/waitlist/waitlist.js';
import { isTrainingMode } from '../lib/trainingMode.js';

import {
  computeTurnStats,
  mergeLearnedBands,
  quoteAccuracy,
} from '../lib/waitlist/learning.js';
import { WAITLIST_SMS_DEFAULTS } from '../lib/waitlist/messages.js';

import {
  loadWaitlist,
  upsertWaitlistEntry,
  upsertWaitlistEntries,
  insertWaitlistEvent,
  recordQuoteAccuracy,
  loadWaitlistConfig,
  saveWaitlistConfig,
  registerWaitlistDevice,
  claimWaitlistDevice,
  waitlistHeartbeat,
  waitlistPinLogin,
  loadClosedChecksForLearning,
  loadQuoteAccuracyRows,
  upsertTurnTimeStats,
} from '../lib/waitlist/waitlistData.js';

import { fetchCustomerByPhone, normalisePhone } from '../lib/customerLookup.js';
import { flushSingleSession } from '../sync/SessionSync.js';

import {
  supabase,
  isMock,
  getActiveLocationSync,
  getLocationId,
  ensureAuthToken,
  platformSupabase,
} from '../lib/supabase.js';

// ── internal helpers (module-scoped, not exposed on the store) ────────────────

const LOC_DEMO = 'loc-demo';
const isRealLoc = (id) => !!id && id !== LOC_DEMO;

// Resolve a real locationId (sync-first, async fallback). Mirrors upsertCustomer.
async function resolveLocationId() {
  const sync = getActiveLocationSync();
  if (isRealLoc(sync)) return sync;
  const resolved = await getLocationId().catch(() => null);
  return isRealLoc(resolved) ? resolved : null;
}

// Resolve org_id for the active location, caching it on the store like the rest
// of the codebase (get()._cachedOrgId). Best-effort; null is tolerated.
async function resolveOrgId(get, set, locId) {
  const cached = get()._cachedOrgId;
  if (cached) return cached;
  if (!supabase || !isRealLoc(locId)) return null;
  try {
    const { data: loc } = await supabase.from('locations').select('org_id').eq('id', locId).single();
    const orgId = loc?.org_id || null;
    if (orgId) set({ _cachedOrgId: orgId });
    return orgId;
  } catch {
    return null;
  }
}

// Active-config view: per-venue overrides if loaded, else the code defaults.
// Bands are returned ALREADY MERGED with the learned per-band turn times so the estimator
// automatically quotes off the venue's real dwell time once turn_time_stats has seeded
// (mergeLearnedBands replaces `turn` only where a band has enough learned samples; otherwise
// the config/code seed stands). waitlistLearnedTurns is null until refreshWaitlistLearning runs.
function cfgView(get) {
  const cfg = get().waitlistConfig;
  const configBands = (cfg && Array.isArray(cfg.bands) && cfg.bands.length) ? cfg.bands : DEFAULT_BANDS;
  const bands = mergeLearnedBands(configBands, get().waitlistLearnedTurns);
  const rules = {
    buffer: cfg?.buffer ?? DEFAULT_QUOTE_RULES.buffer,
    roundTo: cfg?.roundTo ?? DEFAULT_QUOTE_RULES.roundTo,
    maxQuote: cfg?.maxQuote ?? DEFAULT_QUOTE_RULES.maxQuote,
    defaultTurn: cfg?.defaultTurn ?? DEFAULT_QUOTE_RULES.defaultTurn,
  };
  return { bands, rules, smsEnabled: cfg?.smsEnabled !== false, sms: cfg?.sms ?? null };
}

// Best-effort resolution of the venue display name for SMS copy.
function venueName(get) {
  try {
    const id = get().currentLocationId;
    const loc = (get().locations || []).find((l) => l.id === id);
    return loc?.name || get().locationConfig?.name || 'us';
  } catch {
    return 'us';
  }
}

// Guard: ids we JUST transitioned to a TERMINAL status (seated / cancelled / no-show / …).
// A stale realtime echo still carrying the older ACTIVE row must not resurrect a party we
// just seated — that was the "seated the table but kept them in the queue with a Seat button"
// bug. Mirrors SessionSync's _lastSent='cleared' guard for table sessions.
const _recentlyTerminal = {};        // id -> timestamp
const TERMINAL_GUARD_MS = 90 * 1000; // ignore stale active echoes for 90s after seating/clearing

// debounce handle for recompute-driven persistence
let _recomputePersistTimer = null;
// debounce handle for realtime-INSERT-driven re-quoting (so a burst of inbound
// rows — e.g. several self-joins — coalesces into a single recompute pass).
let _realtimeRequoteTimer = null;

// ── the slice ─────────────────────────────────────────────────────────────────
export function waitlistSlice(set, get) {
  // Persist one entry to the DB (upsert + lifecycle event). Best-effort: a DB
  // blip never blocks the optimistic UI. The data layer is table-absent-safe.
  const persistEntry = async (entry, eventTo, actor) => {
    const locId = await resolveLocationId();
    if (!locId) return; // never write with loc-demo / unresolved
    const orgId = await resolveOrgId(get, set, locId);
    try {
      await upsertWaitlistEntry(entry, locId, orgId);
    } catch (e) {
      console.warn('[waitlist] upsertWaitlistEntry failed:', e?.message || e);
    }
    if (eventTo) {
      try {
        await insertWaitlistEvent({ entryId: entry.id, locationId: locId, from: null, to: eventTo, actor: actor || null });
      } catch (e) {
        console.warn('[waitlist] insertWaitlistEvent failed:', e?.message || e);
      }
    }
  };

  return {
    // ── state ────────────────────────────────────────────────────────────────
    waitlist: [],
    waitlistConfig: null,
    // Learned per-band turn times (computeTurnStats output) — null until the learning
    // loop runs. cfgView() merges these onto the config bands so the estimator uses them
    // automatically. waitlistAccuracy is the quoted-vs-actual scorecard for Insights.
    waitlistLearnedTurns: null,   // { '1-2': {avgTurn, n}, ... } | null
    waitlistAccuracy: null,       // { withinPct, mae, n } | null

    // ── floor view: store tables -> estimator table shape ─────────────────────
    // EXCLUDE merged child seats (t.parentId) — they double-count capacity.
    // status mapping: available->open, clearing->clearing, everything else->seated.
    waitlistTablesView: () => tablesView(get().tables || []),

    // Standalone floor loader for the host stand. The waitlist surface renders WITHOUT
    // SyncBridge (like Operations), so store.tables would otherwise be empty and the
    // estimator/Floor view would be blind. This loads floor_tables + active_sessions and
    // populates store.tables in the exact shape waitlistTablesView/FloorView expect. Live
    // table turns then flow via startRealtime()'s sessions channel; we also recompute quotes.
    loadWaitlistFloor: async (locationId) => {
      if (isMock || !supabase) return;
      const locId = isRealLoc(locationId) ? locationId : await resolveLocationId();
      if (!isRealLoc(locId)) return;
      try {
        const [{ data: floor }, { data: sessions }] = await Promise.all([
          supabase.from('floor_tables').select('*').eq('location_id', locId),
          supabase.from('active_sessions').select('table_id,session').eq('location_id', locId),
        ]);
        if (!Array.isArray(floor)) return;
        // Resolve table occupancy IDENTICALLY to the POS (SyncBridge.jsx hydration) so the waitlist
        // Floor and the POS Floor never disagree. The POS keys a table's session by the floor table
        // id and reads three sources in order: active_sessions, then the device-local backup
        // (rpos-session-backup) and emergency snapshot (rpos-session-snapshot) — which the POS writes
        // on every change and which rescue sessions whose active_sessions write silently failed
        // (a long-standing issue) and are shared across ?mode= surfaces in one browser. A previous
        // version of this loader used its OWN fuzzy id/label matching against active_sessions only;
        // that diverged from the POS and showed occupied tables as "Open" (and vice-versa). Mirror
        // the POS exactly: same key (t.id), same fallback chain.
        const sessionMap = {};
        (sessions || []).forEach((r) => { if (r.table_id && r.session) sessionMap[r.table_id] = r.session; });
        try {
          const lsBackup = JSON.parse(localStorage.getItem('rpos-session-backup') || '{}');
          Object.entries(lsBackup).forEach(([tid, sess]) => { if (sess && !sessionMap[tid]) sessionMap[tid] = sess; });
        } catch { /* ignore */ }
        try {
          const snap = JSON.parse(localStorage.getItem('rpos-session-snapshot') || '{}');
          if (snap?.sessions) Object.entries(snap.sessions).forEach(([tid, sess]) => { if (sess && !sessionMap[tid]) sessionMap[tid] = sess; });
        } catch { /* ignore */ }
        // Preserve a session we just seated locally if the DB poll hasn't caught up yet — never
        // clobber a table seated in the last 3 min (its active_sessions flush may be in flight).
        const existingById = Object.fromEntries((get().tables || []).map((t) => [t.id, t]));
        const RECENT_SEAT_MS = 3 * 60 * 1000;
        const tables = floor.map((t) => {
          const inMem = existingById[t.id];
          let session = sessionMap[t.id] || null;
          if (!session && inMem?.session?.seatedAt && (Date.now() - inMem.session.seatedAt) < RECENT_SEAT_MS) {
            session = inMem.session;
          }
          return {
            ...t,
            maxCovers: t.max_covers ?? t.maxCovers ?? 4,
            sortOrder: t.sort_order ?? t.sortOrder ?? 0,
            section: t.section ?? t.zone ?? null,
            parentId: t.parent_id ?? t.parentId ?? null,
            locationId: t.location_id ?? locId,
            status: session ? 'occupied' : 'available',
            session,
          };
        });
        set({ tables });
        get().recomputeWaitlistQuotes?.();
      } catch (e) {
        console.warn('[waitlist] loadWaitlistFloor failed (non-fatal):', e?.message || e);
      }
    },

    // ── CRM lookup ────────────────────────────────────────────────────────────
    // Returns a CRM card { customerId, name, ... } or null. Tolerates mock /
    // missing CRM. Used by the host "add party" sheet to pre-fill + flag returning.
    lookupGuestByPhone: async (phone) => {
      const phoneN = normalisePhone(phone);
      if (!phoneN) return null;
      try {
        const locId = await resolveLocationId();
        const card = await fetchCustomerByPhone(phoneN, locId || undefined);
        return card || null;
      } catch (e) {
        console.warn('[waitlist] lookupGuestByPhone failed:', e?.message || e);
        return null;
      }
    },

    // ── add a party to the queue ──────────────────────────────────────────────
    addParty: async ({ name, phone, size, sectionPref, notes, customer, customerId } = {}) => {
      const now = Date.now();
      const { bands, rules } = cfgView(get);

      // Link or create the CRM customer (best-effort; the queue works without it).
      let linkedId = customerId || customer?.customerId || null;
      const phoneN = phone ? normalisePhone(phone) : null;
      if (!linkedId && phoneN && !isMock) {
        try {
          linkedId = await get().upsertCustomer({ name, phone: phoneN, allergens: customer?.allergens });
        } catch (e) {
          console.warn('[waitlist] upsertCustomer (addParty) failed:', e?.message || e);
        }
      }

      // First quote — estimate over the LIVE floor + the parties already waiting.
      const tablesView = get().waitlistTablesView();
      const otherActive = (get().waitlist || []).filter((e) => isActive(e.status)).map((e) => ({ size: e.size, status: e.status, addedAt: e.addedAt }));
      const quote = estimate({ size: size || 1, sectionPref: sectionPref || null, tables: tablesView, waiting: otherActive, bands, rules });

      const entry = {
        id: `wl-${now}`,
        locationId: getActiveLocationSync() || null,
        customerId: linkedId || null,
        customer: customer || (linkedId ? { customerId: linkedId, name, phone: phoneN } : null),
        name: name || 'Guest',
        phone: phoneN || null,
        size: size || 1,
        quoted: quote,
        firstQuote: quote,
        status: STATUS.WAITING,
        sectionPref: sectionPref || null,
        notes: notes || '',
        seatedTableId: null,
        source: 'host',
        returning: !!linkedId,
        addedAt: now,
        quotedAt: now,
        notifiedAt: null,
        readyAt: null,
        seatedAt: null,
      };

      // Optimistic set first — the board updates instantly.
      set((s) => ({ waitlist: [...(s.waitlist || []), entry] }));

      // Persist (upsert + 'waiting' lifecycle event). Best-effort.
      await persistEntry(entry, STATUS.WAITING, get().staff?.name);

      // Join-confirmation SMS with their quote (transactional; sendWaitlistSMS guards phone + smsEnabled).
      get().sendWaitlistSMS?.(entry, 'join');

      // Adding a party shifts everyone's quote — recompute the rest.
      get().recomputeWaitlistQuotes();

      return entry;
    },

    // ── lifecycle transition (the single funnel for status changes) ───────────
    setWaitlistStatus: async (id, toStatus, opts = {}) => {
      const entry = (get().waitlist || []).find((e) => e.id === id);
      if (!entry) return;
      const from = entry.status;
      if (!canTransition(from, toStatus)) {
        console.warn(`[waitlist] illegal transition ${from} -> ${toStatus} for ${id}`);
        return;
      }

      const now = Date.now();
      const patch = { status: toStatus };
      if (toStatus === STATUS.NOTIFIED && !entry.notifiedAt) patch.notifiedAt = now;
      if (toStatus === STATUS.READY && !entry.readyAt) patch.readyAt = now;
      if (toStatus === STATUS.SEATED && !entry.seatedAt) patch.seatedAt = now;
      if (toStatus === STATUS.SEATED && opts.tableId) patch.seatedTableId = opts.tableId;

      const updated = { ...entry, ...patch };

      // Optimistic set.
      set((s) => ({ waitlist: (s.waitlist || []).map((e) => (e.id === id ? updated : e)) }));

      // Terminal transition (seated/cancelled/etc.): guard against a stale ACTIVE realtime echo
      // re-adding this party to the board for the next 90s (the "seated but stayed in the queue"
      // bug), and drop it from the live list now so the Seat button can't linger.
      if (!isActive(toStatus)) {
        _recentlyTerminal[id] = Date.now();
        set((s) => ({ waitlist: (s.waitlist || []).filter((e) => e.id !== id) }));
      }

      // Persist row + lifecycle event.
      await persistEntry(updated, toStatus, opts.actor || get().staff?.name);

      // ── side effects ────────────────────────────────────────────────────────
      if (toStatus === STATUS.SEATED && opts.tableId) {
        // Couple to the floor: seat the real table with the party's covers AND carry the guest
        // across — so the dine-in checkout can trigger the loyalty flow from their phone (or use
        // their existing membership). Mirrors how a reservation's customer flows onto the session.
        const seatCustomer = (updated.customer || updated.customerId || updated.phone) ? {
          customerId: updated.customerId || updated.customer?.customerId || null,
          name: updated.name || updated.customer?.name || 'Guest',
          phone: updated.phone || updated.customer?.phone || null,
          allergens: updated.customer?.allergens || [],
          marketingOptIn: updated.customer?.marketingOptIn,
        } : null;
        try {
          get().seatTable?.(opts.tableId, { covers: updated.size, server: get().staff?.name, customer: seatCustomer });
          // The host stand renders WITHOUT SyncBridge, so seatTable's in-memory session would
          // never reach active_sessions and the 30s floor poll would flip the table back to free.
          // Persist JUST this table (flushSingleSession) — NOT the global flushSessions, which from
          // the host stand's poll-snapshot view would write/delete every other table and wipe
          // POS-seated ones. Honours "tables MUST never be lost" without clobbering other devices.
          flushSingleSession(opts.tableId);
        } catch (e) {
          console.warn('[waitlist] seatTable failed:', e?.message || e);
        }
        // Close the learning loop: quoted vs actual.
        const actual = actualWaitMin(updated);
        if (actual != null) {
          const locId = await resolveLocationId();
          if (locId) {
            try {
              await recordQuoteAccuracy({
                entryId: updated.id,
                locationId: locId,
                band: bandFor(updated.size, cfgView(get).bands).label,
                quoted: updated.firstQuote ?? updated.quoted,
                actual,
              });
            } catch (e) {
              console.warn('[waitlist] recordQuoteAccuracy failed:', e?.message || e);
            }
          }
        }
        // Seating frees a slot in the model — re-quote the rest.
        get().recomputeWaitlistQuotes();
      }

      // Notify SMS on the guest-facing transitions.
      if (toStatus === STATUS.NOTIFIED) {
        get().sendWaitlistSMS?.(updated, 'next');
      } else if (toStatus === STATUS.READY) {
        get().sendWaitlistSMS?.(updated, 'ready');
      }
    },

    // ── convenience wrappers over setWaitlistStatus ───────────────────────────
    seatWaitlistParty: async (id, tableId = null) => {
      return get().setWaitlistStatus(id, STATUS.SEATED, tableId ? { tableId } : {});
    },

    cancelWaitlistParty: async (id, toStatus = STATUS.CANCELLED) => {
      return get().setWaitlistStatus(id, toStatus);
    },

    // Re-add a no-show / walked-away / cancelled party to the back of the queue.
    reAddParty: async (id) => {
      const entry = (get().waitlist || []).find((e) => e.id === id);
      if (!entry) return null;
      delete _recentlyTerminal[id]; // deliberate re-add — lift the terminal guard so it shows again
      if (!canTransition(entry.status, STATUS.WAITING)) {
        console.warn(`[waitlist] cannot re-add from ${entry.status}`);
        return null;
      }
      const now = Date.now();
      const { bands, rules } = cfgView(get);
      const tablesView = get().waitlistTablesView();
      const otherActive = (get().waitlist || [])
        .filter((e) => e.id !== id && isActive(e.status))
        .map((e) => ({ size: e.size, status: e.status, addedAt: e.addedAt }));
      const quote = estimate({ size: entry.size, sectionPref: entry.sectionPref, tables: tablesView, waiting: otherActive, bands, rules });

      const updated = {
        ...entry,
        status: STATUS.WAITING,
        quoted: quote,
        firstQuote: quote,
        addedAt: now,
        quotedAt: now,
        notifiedAt: null,
        readyAt: null,
        seatedAt: null,
        seatedTableId: null,
      };
      set((s) => ({ waitlist: (s.waitlist || []).map((e) => (e.id === id ? updated : e)) }));
      await persistEntry(updated, STATUS.WAITING, get().staff?.name);
      get().recomputeWaitlistQuotes();
      return updated;
    },

    // ── stale sweep (v5.6.24) ─────────────────────────────────────────────────
    // An active party older than STALE_ACTIVE_MS (6h) is an abandoned queue —
    // sweep it to 'removed' through the normal status funnel so the DB, the
    // audit ledger, and every other device agree. 'removed' (NOT 'no_show')
    // because Insights' No-show KPI exact-matches the no_show status and a
    // housekeeping sweep must not move a venue's service metrics. Idempotent;
    // no-ops when nothing is stale.
    sweepStaleWaitlist: async () => {
      const stale = (get().waitlist || []).filter((e) => isStaleActive(e));
      if (!stale.length) return 0;
      console.warn(`[waitlist] sweeping ${stale.length} stale part${stale.length === 1 ? 'y' : 'ies'} (active > 6h) → removed`);
      for (const e of stale) {
        try {
          await get().setWaitlistStatus(e.id, STATUS.REMOVED, { actor: 'system (stale sweep)' });
        } catch (err) {
          console.warn('[waitlist] stale sweep failed for', e.id, err?.message || err);
        }
      }
      return stale.length;
    },

    // ── live re-quoting ───────────────────────────────────────────────────────
    // Recompute `quoted` for every ACTIVE party against the live floor view and
    // the OTHER active parties. Shallow-set; debounced persistence of the rows
    // whose quote actually changed (keeps the DB warm without write storms).
    recomputeWaitlistQuotes: () => {
      const list = get().waitlist || [];
      if (!list.length) return;
      // Piggyback the stale sweep on the 60s requote tick (fire-and-forget;
      // no-ops unless something is genuinely stale).
      try { get().sweepStaleWaitlist?.(); } catch { /* no-op */ }
      const { bands, rules } = cfgView(get);
      const tablesView = get().waitlistTablesView();

      const changed = [];
      const next = list.map((e) => {
        if (!isActive(e.status)) return e;
        const others = list
          .filter((o) => o.id !== e.id && isActive(o.status))
          .map((o) => ({ size: o.size, status: o.status, addedAt: o.addedAt }));
        const q = estimate({ size: e.size, sectionPref: e.sectionPref, tables: tablesView, waiting: others, bands, rules });
        if (q === e.quoted) return e;
        const updated = { ...e, quoted: q, quotedAt: Date.now() };
        changed.push(updated);
        return updated;
      });

      if (!changed.length) return;
      set({ waitlist: next });

      // Debounced persist of the changed quotes only.
      clearTimeout(_recomputePersistTimer);
      _recomputePersistTimer = setTimeout(async () => {
        const locId = await resolveLocationId();
        if (!locId) return;
        const orgId = await resolveOrgId(get, set, locId);
        // Re-read latest (don't clobber a fresher status) and persist all changed quotes in ONE
        // batched upsert instead of a round-trip per party (a 40-party queue was 40 serial writes).
        const wl = get().waitlist || [];
        const freshChanged = changed
          .map((e) => wl.find((x) => x.id === e.id))
          .filter((fresh) => fresh && isActive(fresh.status));
        if (!freshChanged.length) return;
        try {
          await upsertWaitlistEntries(freshChanged, locId, orgId);
        } catch (err) {
          console.warn('[waitlist] recompute persist failed:', err?.message || err);
        }
      }, 800);
    },

    // ── SMS dispatch ──────────────────────────────────────────────────────────
    // kind: 'join' | 'next' | 'ready'. Best-effort; the send-sms edge fn handles
    // the sms_messages audit row. Skipped silently in mock / without a phone /
    // when SMS is disabled in config.
    sendWaitlistSMS: async (entry, kind) => {
      if (isMock || !supabase) return;
      if (isTrainingMode()) { console.log('[training] waitlist SMS suppressed →', entry?.phone); return; }
      if (!entry?.phone) return;
      const { smsEnabled } = cfgView(get);
      if (!smsEnabled) return;

      const phone = normalisePhone(entry.phone);
      if (!phone) return;

      const locId = await resolveLocationId();
      if (!locId) return;
      const orgId = await resolveOrgId(get, set, locId);

      // Honour a prior STOP — these are transactional, but we never text a guest who opted out.
      if (orgId) {
        try {
          const { data: supp } = await supabase.from('marketing_suppressions')
            .select('id').eq('org_id', orgId).eq('channel', 'sms').eq('address', phone).maybeSingle();
          if (supp) { console.info('[waitlist] SMS suppressed (prior STOP):', phone); return; }
        } catch { /* suppression table issues — fall through; send-sms is the backstop */ }
      }

      const venue = venueName(get);
      const first = (entry.name || 'there').split(' ')[0];
      const q = entry.quoted ?? entry.firstQuote;
      // Position in the live queue (1-based, by arrival) for the {position} merge tag.
      const active = (get().waitlist || []).filter((e) => isActive(e.status)).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      const pos = Math.max(1, active.findIndex((e) => e.id === entry.id) + 1);

      // Operator-editable per-venue templates (cfg.sms[kind]); fall back to built-in copy.
      const fill = (tpl) => String(tpl)
        .replace(/\{name\}|\{guest_name\}/g, first)
        .replace(/\{venue\}/g, venue || 'us')
        .replace(/\{size\}|\{party_size\}/g, String(entry.size || ''))
        .replace(/\{quote\}|\{quoted_wait\}/g, q != null ? String(q) : '')
        .replace(/\{position\}/g, String(pos));
      const tpl = cfgView(get).sms?.[kind];
      // Fallback uses the SAME shared default templates the BO editor shows (run through fill()),
      // so an un-configured venue sends exactly what the operator would see/edit — no divergence.
      const fallback = fill(WAITLIST_SMS_DEFAULTS[kind] || WAITLIST_SMS_DEFAULTS.ready);
      let message = (tpl && String(tpl).trim()) ? fill(tpl) : fallback;
      // Always carry the opt-out line (compliance) even if an operator template omitted it.
      if (!/\bstop\b/i.test(message)) message += ' Reply STOP to opt out.';

      try {
        const token = await ensureAuthToken();
        await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({
            to: phone,
            message,
            location_id: locId,
            type: 'waitlist',
            reference_id: entry.id,
          }),
        }).catch(() => {});
      } catch (e) {
        console.warn('[waitlist] sendWaitlistSMS failed (non-fatal):', e?.message || e);
      }
    },

    // ── learning loop ───────────────────────────────────────────────────────────
    // Refresh the learned turn-time model + the quote-accuracy scorecard from the DB.
    // 1) load recent dine-in closed checks (seat->close) -> computeTurnStats -> set
    //    waitlistLearnedTurns (cfgView merges these so EVERY future quote uses them).
    // 2) load quote_accuracy rows -> quoteAccuracy -> set waitlistAccuracy (for Insights).
    // 3) best-effort cache the learned model into turn_time_stats for other devices.
    // Fully mock / table-absent safe — the data layer returns empty/null and we no-op.
    refreshWaitlistLearning: async (locationId) => {
      const locId = isRealLoc(locationId) ? locationId : await resolveLocationId();
      if (!locId) return;

      // 1) learned turn times from historical dwell
      let stats = null;
      try {
        const { data: checks } = await loadClosedChecksForLearning(locId);
        if (Array.isArray(checks) && checks.length) {
          // Learn against the operator's CONFIGURED bands (pre-merge) so band boundaries
          // match what the estimator quotes with.
          const cfg = get().waitlistConfig;
          const configBands = (cfg && Array.isArray(cfg.bands) && cfg.bands.length) ? cfg.bands : DEFAULT_BANDS;
          stats = computeTurnStats(checks, { bands: configBands });
          set({ waitlistLearnedTurns: Object.keys(stats).length ? stats : null });
        }
      } catch (e) {
        console.warn('[waitlist] refreshWaitlistLearning (turns) failed:', e?.message || e);
      }

      // 2) quote-accuracy scorecard
      try {
        const { data: rows } = await loadQuoteAccuracyRows(locId);
        if (Array.isArray(rows) && rows.length) {
          set({ waitlistAccuracy: quoteAccuracy(rows) });
        }
      } catch (e) {
        console.warn('[waitlist] refreshWaitlistLearning (accuracy) failed:', e?.message || e);
      }

      // 3) best-effort cache the learned model for other devices / Insights
      if (stats && Object.keys(stats).length) {
        try {
          await upsertTurnTimeStats(locId, stats);
        } catch (e) {
          console.warn('[waitlist] upsertTurnTimeStats failed:', e?.message || e);
        }
      }

      // Learned turns can shift every quote — recompute the live board.
      try { get().recomputeWaitlistQuotes?.(); } catch { /* no-op */ }
    },

    // ── DB boot / config ──────────────────────────────────────────────────────
    loadWaitlistFromDB: async (locationId) => {
      const locId = isRealLoc(locationId) ? locationId : await resolveLocationId();
      if (!locId) return;
      try {
        const { data } = await loadWaitlist(locId);
        if (Array.isArray(data)) {
          // Merge: keep any optimistic local entries not yet in the DB result.
          const remoteIds = new Set(data.map((e) => e.id));
          const localExtras = (get().waitlist || []).filter((e) => !remoteIds.has(e.id) && isActive(e.status));
          set({ waitlist: [...data, ...localExtras] });
          // A reload can resurface yesterday's forgotten queue — sweep stale
          // actives to 'removed' BEFORE they pollute stats and quotes.
          try { await get().sweepStaleWaitlist?.(); } catch { /* no-op */ }
          // Loaded rows may include self-joins persisted with no quote (created
          // server-side). Re-quote the live board so every party — including a guest
          // watching their status page — has a fresh quoted_wait_min after a load.
          try { get().recomputeWaitlistQuotes?.(); } catch { /* no-op */ }
        }
      } catch (e) {
        console.warn('[waitlist] loadWaitlistFromDB failed:', e?.message || e);
      }
      try {
        const { data: cfg } = await loadWaitlistConfig(locId);
        if (cfg) set({ waitlistConfig: cfg });
      } catch (e) {
        console.warn('[waitlist] loadWaitlistConfig failed:', e?.message || e);
      }
      // Refresh the learning model on boot so quotes use the venue's real dwell time
      // (and Insights has its accuracy scorecard) without waiting for a manual trigger.
      try {
        await get().refreshWaitlistLearning?.(locId);
      } catch (e) {
        console.warn('[waitlist] refreshWaitlistLearning (boot) failed:', e?.message || e);
      }
    },

    // Apply a realtime payload from WaitlistSync (echo-suppression lives in the
    // sync layer; this just reconciles the in-memory list by id).
    applyWaitlistRealtime: (payload) => {
      if (!payload) return;
      const list = [...(get().waitlist || [])];
      if (payload.eventType === 'DELETE') {
        const id = payload.old?.id;
        if (!id) return;
        const next = list.filter((e) => e.id !== id);
        if (next.length !== list.length) set({ waitlist: next });
        return;
      }
      const row = payload.new;
      if (!row?.id) return;
      const incoming = rowToWaitlist(row);
      if (!incoming) return;
      // Drop rows that have left the active queue (seated/completed/etc.).
      if (!isActive(incoming.status)) {
        delete _recentlyTerminal[incoming.id]; // terminal status confirmed remotely — guard no longer needed
        const next = list.filter((e) => e.id !== incoming.id);
        if (next.length !== list.length) set({ waitlist: next });
        return;
      }
      // Guard: we just seated/cancelled this party locally — ignore a stale ACTIVE echo that
      // would resurrect it on the board (the persist's own echo, or an in-flight older write).
      if (_recentlyTerminal[incoming.id] && (Date.now() - _recentlyTerminal[incoming.id]) < TERMINAL_GUARD_MS) return;
      const idx = list.findIndex((e) => e.id === incoming.id);
      const isNew = idx === -1;
      if (isNew) list.push(incoming);
      else list[idx] = { ...list[idx], ...incoming };
      set({ waitlist: list });

      // A brand-new active party (host add echoed back, or — the F2 case — a guest
      // self-join arriving over realtime) shifts the model for everyone AND itself:
      // self-joins are created server-side with no quote, so recompute is what fills
      // their quoted_wait_min for the public status page. Only on genuine INSERTs of
      // an active row; status updates already re-quote through setWaitlistStatus.
      // Debounced so a burst of inbound rows coalesces; recompute never sends SMS,
      // so this can't double-fire the join text.
      if (isNew) {
        clearTimeout(_realtimeRequoteTimer);
        _realtimeRequoteTimer = setTimeout(() => {
          try { get().recomputeWaitlistQuotes?.(); } catch { /* no-op */ }
        }, 250);
      }
    },

    setWaitlistConfigLocal: (cfg) => {
      set({ waitlistConfig: { ...(get().waitlistConfig || {}), ...(cfg || {}) } });
    },

    saveWaitlistConfigDB: async () => {
      const cfg = get().waitlistConfig;
      if (!cfg) return;
      const locId = await resolveLocationId();
      if (!locId) return;
      try {
        await saveWaitlistConfig(locId, cfg);
      } catch (e) {
        console.warn('[waitlist] saveWaitlistConfigDB failed:', e?.message || e);
      }
      // A config change (bands/buffer) can move every quote — recompute.
      get().recomputeWaitlistQuotes();
    },

    // ── paired host-stand device lifecycle (thin RPC wrappers via data layer) ──
    registerWaitlistDevice: async (name) => {
      try {
        return await registerWaitlistDevice(name);
      } catch (e) {
        console.warn('[waitlist] registerWaitlistDevice failed:', e?.message || e);
        return null;
      }
    },
    claimWaitlistDevice: async (code, locationId) => {
      try {
        return await claimWaitlistDevice(code, locationId);
      } catch (e) {
        console.warn('[waitlist] claimWaitlistDevice failed:', e?.message || e);
        return null;
      }
    },
    waitlistHeartbeat: async () => {
      try {
        return await waitlistHeartbeat();
      } catch {
        return null;
      }
    },
    waitlistPinLogin: async (locationId, pin) => {
      try {
        return await waitlistPinLogin(locationId, pin);
      } catch (e) {
        console.warn('[waitlist] waitlistPinLogin failed:', e?.message || e);
        return null;
      }
    },

    // ── derived helper for the board header (avg wait now) ────────────────────
    waitlistAverageWait: () => currentAverageWait(get().waitlist || []),
  };
}

export default waitlistSlice;
