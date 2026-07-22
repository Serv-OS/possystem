/**
 * MasterSync — master/child device coordination
 *
 * Master device:
 *   - Writes a heartbeat to device_heartbeats every 10s
 *   - Is the source of truth for the location
 *
 * Child devices:
 *   - Check master heartbeat every 15s
 *   - If master not seen in 30s → emit 'master-offline' event
 *   - When master comes back → emit 'master-online' event
 *
 * Force sync:
 *   - Any device can call forceSyncFromSupabase() to pull
 *     the full authoritative state from Supabase
 */

import { supabase, isMock, getLocationId } from '../lib/supabase';
import { useStore } from '../store';

const HEARTBEAT_INTERVAL  = 10_000; // master writes every 10s
// Jitter every poller ±20% so a fleet of devices doesn't hit the API in
// lock-step (synchronized intervals = periodic thundering herds).
const jittered = ms => ms + Math.round((Math.random() - 0.5) * 0.4 * ms);
const _ipCache = { value: null, at: 0 };
const CHECK_INTERVAL      = 15_000; // children check every 15s
const STALE_THRESHOLD     = 30_000; // master considered offline after 30s

let _heartbeatTimer  = null;
let _checkTimer      = null;
let _masterLastSeen  = null;
let _masterOffline   = false;

// ── Master: write heartbeat ────────────────────────────────────────────────────
export async function startMasterHeartbeat({ deviceId, locationId, deviceName, version }) {
  if (isMock || !supabase) return;

  const beat = async () => {
    try {
      const tables = useStore.getState().tables || [];
      const openTables = tables.filter(t => t.session?.items?.length > 0).length;
      // Get local IP hint (best effort) — CACHED: spinning up an
      // RTCPeerConnection on every 10s beat is wasteful; the LAN IP barely
      // changes, so detect once and refresh every 10 minutes.
      let ip = _ipCache.value;
      if (Date.now() - _ipCache.at > 600_000) {
        _ipCache.at = Date.now();
        try {
          const pc = new RTCPeerConnection({ iceServers: [] });
          pc.createDataChannel('');
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await new Promise(r => setTimeout(r, 200));
          const sdp = pc.localDescription?.sdp || '';
          const m = sdp.match(/a=candidate:[^\r\n]+IN IP4 (\d+\.\d+\.\d+\.\d+)/);
          if (m && !m[1].startsWith('0.')) ip = m[1];
          pc.close();
        } catch {}
        _ipCache.value = ip;
      }

      await supabase.from('device_heartbeats').upsert({
        device_id:   deviceId,
        location_id: locationId,
        device_name: deviceName,
        role:        'master',
        last_seen:   new Date().toISOString(),
        version,
        open_tables: openTables,
        ip_hint:     ip,
      }, { onConflict: 'device_id' });
    } catch {}
  };

  await beat(); // immediate first beat
  _heartbeatTimer = setInterval(beat, jittered(HEARTBEAT_INTERVAL));
  console.log('[MasterSync] Heartbeat started — this device is MASTER');
}

// ── Child: monitor master heartbeat ───────────────────────────────────────────
export async function startChildMonitor({ locationId }) {
  if (isMock || !supabase) return;

  const check = async () => {
    try {
      const { data } = await supabase
        .from('device_heartbeats')
        .select('last_seen, device_name, open_tables, ip_hint, version')
        .eq('location_id', locationId)
        .eq('role', 'master')
        .order('last_seen', { ascending: false })
        .limit(1)
        .single();

      if (!data) {
        // No master record at all — may not be configured yet
        return;
      }

      const age = Date.now() - new Date(data.last_seen).getTime();
      _masterLastSeen = { ...data, ageMs: age };

      if (age > STALE_THRESHOLD && !_masterOffline) {
        _masterOffline = true;
        window.dispatchEvent(new CustomEvent('rpos-master-offline', { detail: _masterLastSeen }));
        console.warn('[MasterSync] Master offline — last seen', Math.round(age / 1000) + 's ago');
      } else if (age <= STALE_THRESHOLD && _masterOffline) {
        _masterOffline = false;
        window.dispatchEvent(new CustomEvent('rpos-master-online', { detail: _masterLastSeen }));
        console.log('[MasterSync] Master back online');
      }
    } catch {}
  };

  await check(); // immediate first check
  _checkTimer = setInterval(check, jittered(CHECK_INTERVAL));
}

export function getMasterStatus() {
  return { offline: _masterOffline, lastSeen: _masterLastSeen };
}

export function stopMasterSync() {
  clearInterval(_heartbeatTimer);
  clearInterval(_checkTimer);
  _heartbeatTimer = null;
  _checkTimer = null;
}

// ── Force sync: pull authoritative state from Supabase ────────────────────────
export async function forceSyncFromSupabase() {
  if (isMock || !supabase) return { ok: false, error: 'Not connected' };

  try {
    const locationId = await getLocationId();
    if (!locationId) return { ok: false, error: 'No location' };

    const sod = new Date(); sod.setHours(0, 0, 0, 0);

    const [sessionsRes, checksRes, tablesRes] = await Promise.all([
      supabase.from('active_sessions').select('table_id,session,updated_at').eq('location_id', locationId),
      supabase.from('closed_checks').select('*').eq('location_id', locationId).gte('closed_at', sod.toISOString()).order('closed_at', { ascending: false }).limit(500),
      supabase.from('floor_tables').select('id,label,status').eq('location_id', locationId),
    ]);

    const store = useStore.getState();
    const patch = {};

    // Set of occupations (table_id + seatedAt) already cashed off, built from the checks
    // we JUST fetched — NOT from the store, whose closedChecks are updated further down.
    // Used so the keep-local branch below never preserves a ghost of a paid table.
    const closedOcc = new Set();
    (checksRes.data || []).forEach(c => {
      const tid = c.table_id ?? c.tableId;
      const s = c.seated_at ?? c.seatedAt;
      if (tid && s != null) closedOcc.add(`${tid}:${new Date(s).getTime()}`);
    });
    const occClosed = (tableId, sess) => {
      const s = sess?.seatedAt;
      return !!(tableId && s && closedOcc.has(`${tableId}:${s}`));
    };

    // Reconcile sessions — merge Supabase with local, preserving newer local data
    if (sessionsRes.data) {
      const sessionMap = {};
      sessionsRes.data.forEach(r => { if (r.table_id && r.session) sessionMap[r.table_id] = r.session; });

      patch.tables = store.tables.map(t => {
        const remote = sessionMap[t.id] || null;
        const local = t.session || null;
        // v5.5.283: Don't destroy local sessions that are newer or have unflushed data.
        // Previous behavior treated Supabase as fully authoritative, which wiped
        // local sessions that hadn't been synced yet.
        // ...UNLESS this occupation was already cashed off — then the local copy is a
        // ghost and preserving it is exactly the "table won't die" bug. Let it fall
        // through to clear (remote is null → session null → available).
        if (!remote && local?.items?.length > 0 && !occClosed(t.id, local)) {
          // Local has an active order but Supabase row is missing — keep local.
          // It will be flushed to Supabase on the next scheduleFlush() cycle.
          return t;
        }
        if (remote && local) {
          const remoteSeated = remote.seatedAt || 0;
          const localSeated = local.seatedAt || 0;
          if (localSeated > remoteSeated) return t; // local is newer
        }
        const session = remote;
        const status = session?.items?.length > 0 ? 'occupied' : session ? 'seated' : 'available';
        return { ...t, session, status };
      });
    }

    // Reconcile closed checks — merge Supabase + local, deduplicate
    if (checksRes.data) {
      const supabaseChecks = checksRes.data.map(c => ({
        ...c,
        closedAt: c.closed_at ? new Date(c.closed_at).getTime() : null,
        // seatedAt (epoch ms) lets isSessionClosed tombstone the paid occupation on
        // every device that boots or force-syncs, not just the one that took payment.
        seatedAt: c.seated_at ? new Date(c.seated_at).getTime() : (c.seatedAt || null),
        method: c.payment_method || c.method,
        orderType: c.order_type,
        tableLabel: c.table_label,
        tableId: c.table_id,
      }));
      const supabaseIds = new Set(supabaseChecks.map(c => c.id));
      const localOnly = (store.closedChecks || []).filter(c => !supabaseIds.has(c.id));
      patch.closedChecks = [...supabaseChecks, ...localOnly].sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    }

    useStore.setState(patch);

    // Update session backup
    if (patch.tables) {
      const backup = {};
      patch.tables.filter(t => t.session).forEach(t => { backup[t.id] = t.session; });
      try { localStorage.setItem('rpos-session-backup', JSON.stringify(backup)); } catch {}
    }

    return { ok: true, sessionCount: sessionsRes.data?.length || 0, checkCount: checksRes.data?.length || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
