// src/lib/waitlist/waitlistData.js
//
// Tables Ready — Supabase data layer for the walk-in waitlist / live table-queue.
//
// Every function is BOTH:
//   1. isMock-safe   — when supabase is null (local dev / placeholder keys) it returns
//                       empty data / { error:null } and never touches the network.
//   2. table-absent-safe — the migration (20260623t_tables_ready_waitlist.sql) MAY NOT be
//                       applied yet on a given venue's DB. A missing relation surfaces as a
//                       PostgREST "PGRST205" / "relation does not exist" error (or a 404).
//                       We catch it, log a single one-line warn, and return empty/null —
//                       we NEVER throw at boot.
//
// camelCase in JS, snake_case in the DB. Mapping for entries goes through
// rowToWaitlist / waitlistToRow in ./waitlist.js (single source of truth). Config has its
// own small camel<->snake mapper here (its shape is local to this file + the contract).
//
// Mirrors the idioms in src/lib/db.js (resolve-or-fail locationId, { data, error } shape).

import { supabase, isMock } from '../supabase';
import { rowToWaitlist, waitlistToRow, STATUS } from './waitlist';

// ── shared helpers ─────────────────────────────────────────────────────────────

// A "relation does not exist" / schema-cache-miss error means the migration isn't
// applied yet on this venue. Treat it as "no data", not a failure.
function isTableAbsent(error) {
  if (!error) return false;
  const code = error.code || '';
  const msg = (error.message || '').toLowerCase();
  return (
    code === 'PGRST205' ||           // PostgREST: table not found in schema cache
    code === '42P01' ||              // Postgres: undefined_table
    code === 'PGRST202' ||           // PostgREST: function not found (RPCs not migrated)
    code === '42883' ||             // Postgres: undefined_function
    msg.includes('does not exist') ||
    msg.includes('could not find the table') ||
    msg.includes('schema cache') ||
    msg.includes('not found')
  );
}

// One-line warn that distinguishes "feature not migrated yet" (info) from a real error.
function warnAbsentOr(error, where) {
  if (isTableAbsent(error)) {
    console.warn(`[waitlistData] ${where}: waitlist tables not present yet — apply 20260623t migration. (${error.code || error.message})`);
    return true;
  }
  return false;
}

// Statuses that drop OFF the live board (the queue load filters these out).
const INACTIVE_STATUSES = [
  STATUS.SEATED, STATUS.COMPLETED, STATUS.CANCELLED,
  STATUS.NO_SHOW, STATUS.WALKED_AWAY, STATUS.REMOVED,
];

// ── config camelCase <-> snake_case ─────────────────────────────────────────────
// cfg camelCase: { buffer, roundTo, maxQuote, defaultTurn, bands, zones, smsEnabled }
function rowToConfig(r) {
  if (!r) return null;
  return {
    buffer:      r.buffer_min ?? 5,
    roundTo:     r.round_to ?? 5,
    maxQuote:    r.max_quote ?? 120,
    defaultTurn: r.default_turn ?? 60,
    bands:       r.bands ?? null,   // null = use code defaults (DEFAULT_BANDS)
    zones:       r.zones ?? null,
    smsEnabled:  r.sms_enabled ?? true,
    sms:         r.sms_templates ?? null,   // {join,next,ready} editable bodies; null = code defaults
  };
}

function configToRow(cfg, locationId, orgId = null) {
  const c = cfg || {};
  return {
    location_id:  locationId,
    org_id:       orgId,
    buffer_min:   c.buffer ?? 5,
    round_to:     c.roundTo ?? 5,
    max_quote:    c.maxQuote ?? 120,
    default_turn: c.defaultTurn ?? 60,
    bands:         c.bands ?? null,
    zones:         c.zones ?? null,
    sms_enabled:   c.smsEnabled ?? true,
    sms_templates: c.sms ?? null,
    updated_at:    new Date().toISOString(),
  };
}

// ── the live queue ──────────────────────────────────────────────────────────────

// Load active waitlist entries for a location. Filters OUT terminal statuses
// (seated/completed/cancelled/no_show/walked_away/removed), caps at 500, oldest first.
export async function loadWaitlist(locationId) {
  if (isMock || !supabase) return { data: [] };
  if (!locationId || locationId === 'loc-demo') return { data: [] };
  try {
    const { data, error } = await supabase
      .from('waitlist_entries')
      .select('*')
      .eq('location_id', locationId)
      .not('status', 'in', `(${INACTIVE_STATUSES.join(',')})`)
      .order('added_at', { ascending: true })
      .limit(500);
    if (error) {
      if (!warnAbsentOr(error, 'loadWaitlist')) {
        console.warn('[waitlistData] loadWaitlist failed:', error.message);
      }
      return { data: [] };
    }
    return { data: (data || []).map(rowToWaitlist).filter(Boolean) };
  } catch (e) {
    if (!warnAbsentOr(e, 'loadWaitlist')) console.warn('[waitlistData] loadWaitlist threw:', e?.message || e);
    return { data: [] };
  }
}

// Upsert a single entry (waitlistToRow handles the camel->snake map). onConflict id.
export async function upsertWaitlistEntry(entry, locationId, orgId) {
  if (isMock || !supabase) return { error: null };
  if (!locationId || locationId === 'loc-demo') {
    console.warn('[waitlistData] upsertWaitlistEntry: no real locationId — write skipped');
    return { error: new Error('No locationId') };
  }
  try {
    const row = waitlistToRow(entry, locationId, orgId);
    const { error } = await supabase.from('waitlist_entries').upsert(row, { onConflict: 'id' });
    if (error) {
      if (!warnAbsentOr(error, 'upsertWaitlistEntry')) {
        console.warn('[waitlistData] upsertWaitlistEntry failed:', error.message);
      }
      return { error };
    }
    return { error: null };
  } catch (e) {
    if (!warnAbsentOr(e, 'upsertWaitlistEntry')) console.warn('[waitlistData] upsertWaitlistEntry threw:', e?.message || e);
    return { error: e };
  }
}

// Append a lifecycle event to the audit ledger (waitlist_status_events).
export async function insertWaitlistEvent({ entryId, locationId, from, to, actor }) {
  if (isMock || !supabase) return { error: null };
  if (!locationId || locationId === 'loc-demo' || !entryId || !to) return { error: null };
  try {
    const { error } = await supabase.from('waitlist_status_events').insert({
      location_id: locationId,
      waitlist_entry_id: entryId,
      from_status: from || null,
      to_status: to,
      actor: actor || null,
    });
    if (error) {
      if (!warnAbsentOr(error, 'insertWaitlistEvent')) {
        console.warn('[waitlistData] insertWaitlistEvent failed:', error.message);
      }
      return { error };
    }
    return { error: null };
  } catch (e) {
    if (!warnAbsentOr(e, 'insertWaitlistEvent')) console.warn('[waitlistData] insertWaitlistEvent threw:', e?.message || e);
    return { error: e };
  }
}

// Record quoted vs actual once seated — closes the learning loop / powers Insights accuracy.
export async function recordQuoteAccuracy({ entryId, locationId, band, quoted, actual }) {
  if (isMock || !supabase) return { error: null };
  if (!locationId || locationId === 'loc-demo' || !entryId) return { error: null };
  try {
    const { error } = await supabase.from('quote_accuracy').insert({
      location_id: locationId,
      waitlist_entry_id: entryId,
      party_band: band || null,
      quoted_wait_min: quoted ?? null,
      actual_wait_min: actual ?? null,
    });
    if (error) {
      if (!warnAbsentOr(error, 'recordQuoteAccuracy')) {
        console.warn('[waitlistData] recordQuoteAccuracy failed:', error.message);
      }
      return { error };
    }
    return { error: null };
  } catch (e) {
    if (!warnAbsentOr(e, 'recordQuoteAccuracy')) console.warn('[waitlistData] recordQuoteAccuracy threw:', e?.message || e);
    return { error: e };
  }
}

// ── learning loop: historical dwell time + quote accuracy ────────────────────────
// These feed src/lib/waitlist/learning.js (computeTurnStats / quoteAccuracy). All three
// are isMock-safe AND table-absent-safe: closed_checks.seated_at is added by the 20260623t
// migration, and turn_time_stats / quote_accuracy are created by it. Until applied (or on
// older venues) a missing column/relation surfaces as PGRST/42xxx and we return empty/null.

// Lookback window for learning — recent enough to track the venue's CURRENT pace, deep
// enough to clear the minSamples gate per band. ~60 days.
const LEARNING_LOOKBACK_DAYS = 60;

// Load recent dine-in closed checks that have a seated_at (so seat->close turn time exists).
// Returns [{ seatedAt(ms), closedAt(ms), covers }] — exactly the shape computeTurnStats wants.
// Rows missing either timestamp are dropped here; learning.turnMinutes also re-guards them.
export async function loadClosedChecksForLearning(locationId) {
  if (isMock || !supabase) return { data: [] };
  if (!locationId || locationId === 'loc-demo') return { data: [] };
  try {
    const sinceIso = new Date(Date.now() - LEARNING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('closed_checks')
      .select('seated_at,closed_at,covers')
      .eq('location_id', locationId)
      .eq('order_type', 'dine-in')
      .not('seated_at', 'is', null)
      .gte('closed_at', sinceIso)
      .order('closed_at', { ascending: false })
      .limit(5000);
    if (error) {
      if (!warnAbsentOr(error, 'loadClosedChecksForLearning')) {
        console.warn('[waitlistData] loadClosedChecksForLearning failed:', error.message);
      }
      return { data: [] };
    }
    const checks = (data || [])
      .map((r) => ({
        seatedAt: r.seated_at ? new Date(r.seated_at).getTime() : null,
        closedAt: r.closed_at ? new Date(r.closed_at).getTime() : null,
        covers: r.covers ?? null,
      }))
      .filter((c) => c.seatedAt != null && c.closedAt != null);
    return { data: checks };
  } catch (e) {
    if (!warnAbsentOr(e, 'loadClosedChecksForLearning')) console.warn('[waitlistData] loadClosedChecksForLearning threw:', e?.message || e);
    return { data: [] };
  }
}

// Load the recorded quoted-vs-actual rows for accuracy scoring (learning.quoteAccuracy).
// Returns [{ quoted, actual, band }] in camelCase.
export async function loadQuoteAccuracyRows(locationId) {
  if (isMock || !supabase) return { data: [] };
  if (!locationId || locationId === 'loc-demo') return { data: [] };
  try {
    const { data, error } = await supabase
      .from('quote_accuracy')
      .select('quoted_wait_min,actual_wait_min,party_band')
      .eq('location_id', locationId)
      .order('recorded_at', { ascending: false })
      .limit(2000);
    if (error) {
      if (!warnAbsentOr(error, 'loadQuoteAccuracyRows')) {
        console.warn('[waitlistData] loadQuoteAccuracyRows failed:', error.message);
      }
      return { data: [] };
    }
    const rows = (data || []).map((r) => ({
      quoted: r.quoted_wait_min ?? null,
      actual: r.actual_wait_min ?? null,
      band: r.party_band ?? null,
    }));
    return { data: rows };
  } catch (e) {
    if (!warnAbsentOr(e, 'loadQuoteAccuracyRows')) console.warn('[waitlistData] loadQuoteAccuracyRows threw:', e?.message || e);
    return { data: [] };
  }
}

// Best-effort persist of the learned per-band averages so Insights (and other devices)
// can read them without recomputing. statsByBand = { '1-2': {avgTurn, n}, ... } (the
// computeTurnStats output). One row per band per location (upsert on location_id+party_band
// with section_id null for the venue-wide model). Silently no-ops if the relation is absent.
export async function upsertTurnTimeStats(locationId, statsByBand) {
  if (isMock || !supabase) return { error: null };
  if (!locationId || locationId === 'loc-demo') return { error: null };
  const entries = Object.entries(statsByBand || {});
  if (!entries.length) return { error: null };
  try {
    const nowIso = new Date().toISOString();
    const rows = entries.map(([band, s]) => ({
      location_id: locationId,
      section_id: null,
      party_band: band,
      avg_turn_min: s?.avgTurn ?? null,
      sample_count: s?.n ?? 0,
      updated_at: nowIso,
    }));
    // This is a fresh snapshot of the in-memory learned model (one row per band, venue-wide).
    // Replace-per-location (delete then insert) so the table never accumulates duplicate band
    // rows across boots — no unique index needed, and Insights reads a clean one-row-per-band set.
    await supabase.from('turn_time_stats').delete().eq('location_id', locationId).is('section_id', null);
    const { error } = await supabase.from('turn_time_stats').insert(rows);
    if (error) {
      if (!warnAbsentOr(error, 'upsertTurnTimeStats')) {
        console.warn('[waitlistData] upsertTurnTimeStats failed:', error.message);
      }
      return { error };
    }
    return { error: null };
  } catch (e) {
    if (!warnAbsentOr(e, 'upsertTurnTimeStats')) console.warn('[waitlistData] upsertTurnTimeStats threw:', e?.message || e);
    return { error: e };
  }
}

// ── per-venue config ────────────────────────────────────────────────────────────

// Load the venue config row (or null — code defaults apply). camelCase out.
export async function loadWaitlistConfig(locationId) {
  if (isMock || !supabase) return { data: null };
  if (!locationId || locationId === 'loc-demo') return { data: null };
  try {
    const { data, error } = await supabase
      .from('waitlist_config')
      .select('*')
      .eq('location_id', locationId)
      .maybeSingle();
    if (error) {
      if (!warnAbsentOr(error, 'loadWaitlistConfig')) {
        console.warn('[waitlistData] loadWaitlistConfig failed:', error.message);
      }
      return { data: null };
    }
    return { data: rowToConfig(data) };
  } catch (e) {
    if (!warnAbsentOr(e, 'loadWaitlistConfig')) console.warn('[waitlistData] loadWaitlistConfig threw:', e?.message || e);
    return { data: null };
  }
}

// Persist the venue config (upsert on location_id PK). camelCase in.
export async function saveWaitlistConfig(locationId, cfg) {
  if (isMock || !supabase) return { error: null };
  if (!locationId || locationId === 'loc-demo') {
    console.warn('[waitlistData] saveWaitlistConfig: no real locationId — write skipped');
    return { error: new Error('No locationId') };
  }
  try {
    const row = configToRow(cfg, locationId);
    const { error } = await supabase.from('waitlist_config').upsert(row, { onConflict: 'location_id' });
    if (error) {
      if (!warnAbsentOr(error, 'saveWaitlistConfig')) {
        console.warn('[waitlistData] saveWaitlistConfig failed:', error.message);
      }
      return { error };
    }
    return { error: null };
  } catch (e) {
    if (!warnAbsentOr(e, 'saveWaitlistConfig')) console.warn('[waitlistData] saveWaitlistConfig threw:', e?.message || e);
    return { error: e };
  }
}

// ── paired-tablet RPCs (thin supabase.rpc wrappers, return the jsonb) ───────────
// All four are SECURITY DEFINER server functions. They may not exist yet (migration
// not applied) → return null rather than throwing so the host surface degrades softly.

async function _callRpc(fn, args, where) {
  if (isMock || !supabase) return null;
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      if (!warnAbsentOr(error, where)) {
        console.warn(`[waitlistData] ${where} failed:`, error.message);
      }
      return null;
    }
    return data ?? null;
  } catch (e) {
    if (!warnAbsentOr(e, where)) console.warn(`[waitlistData] ${where} threw:`, e?.message || e);
    return null;
  }
}

// register_waitlist_device(p_name) -> { id, claim_code, location_id }
export async function registerWaitlistDevice(name) {
  return _callRpc('register_waitlist_device', { p_name: name ?? null }, 'registerWaitlistDevice');
}

// claim_waitlist_device(p_code, p_location_id) -> { id, location_id }
export async function claimWaitlistDevice(code, locationId) {
  return _callRpc('claim_waitlist_device', { p_code: code, p_location_id: locationId }, 'claimWaitlistDevice');
}

// waitlist_device_heartbeat() -> { claimed, location_id?, name? }
export async function waitlistHeartbeat() {
  return _callRpc('waitlist_device_heartbeat', {}, 'waitlistHeartbeat');
}

// waitlist_pin_login(p_location_id, p_pin) -> { ok, id?, name?, role?, permissions? }
export async function waitlistPinLogin(locationId, pin) {
  return _callRpc('waitlist_pin_login', { p_location_id: locationId, p_pin: pin }, 'waitlistPinLogin');
}
