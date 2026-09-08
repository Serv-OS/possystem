import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { forceSyncFromSupabase, getMasterStatus } from '../../sync/MasterSync';

// Numeric semver compare: returns >0 if a is newer than b. (v5.5.870 fleet version flagging)
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

export default function NetworkStatus() {
  const [devices, setDevices] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadDevices = async () => {
    if (!supabase) return;
    try {
      const locationId = JSON.parse(localStorage.getItem('rpos-bo-location') || 'null')
        || JSON.parse(localStorage.getItem('rpos-device') || '{}').locationId;
      if (!locationId) return;
      const { data } = await supabase
        .from('device_heartbeats')
        .select('*')
        .eq('location_id', locationId)
        .order('last_seen', { ascending: false });
      setDevices(data || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    loadDevices();
    const t = setInterval(loadDevices, 15000 + Math.round((Math.random() - 0.5) * 6000)); // ±3s jitter
    return () => clearInterval(t);
  }, []);

  const handleForceSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    const r = await forceSyncFromSupabase();
    setSyncing(false);
    setSyncResult(r);
    if (r.ok) loadDevices();
  };

  const now = Date.now();
  // The newest version any till reports is the target; anything behind it is flagged OUT OF DATE.
  // (Tills self-update via UpdateGuard, but this makes a device that can't/won't update visible.)
  const targetVersion = devices.reduce((m, d) => (cmpVersion(d.version, m) > 0 ? d.version : m), '0.0.0');

  return (
    <div style={{ padding: '24px', maxWidth: 700 }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Network & Sync</div>
        <div style={{ fontSize: 13, color: 'var(--t3)' }}>Monitor device connectivity and force a full data reconciliation</div>
      </div>

      {/* Device heartbeats */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 12 }}>
          Devices on network
        </div>

        {loading ? (
          <div style={{ padding: 20, color: 'var(--t4)', fontSize: 13 }}>Loading…</div>
        ) : devices.length === 0 ? (
          <div style={{ padding: '16px', borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--bdr)', fontSize: 13, color: 'var(--t4)' }}>
            No devices have checked in yet. Open a POS terminal to start the heartbeat.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {devices.map(d => {
              const ageSec = Math.round((now - new Date(d.last_seen).getTime()) / 1000);
              const online = ageSec < 30;
              const isMaster = d.role === 'master';
              const outOfDate = d.version && cmpVersion(d.version, targetVersion) < 0;
              return (
                <div key={d.device_id} style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '14px 16px', borderRadius: 12,
                  background: outOfDate ? 'var(--red-d, #3a1a1a)' : 'var(--bg2)',
                  border: `1.5px solid ${outOfDate ? 'var(--red, #dc2626)' : online ? (isMaster ? 'var(--acc-b)' : 'var(--grn-b)') : 'var(--bdr)'}`,
                }}>
                  {/* Status dot */}
                  <div style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: online ? (isMaster ? 'var(--acc)' : 'var(--grn)') : 'var(--t4)' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', display: 'flex', gap: 8, alignItems: 'center' }}>
                      {d.device_name || d.device_id}
                      {isMaster && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: 'var(--acc-d)', color: 'var(--acc)', border: '1px solid var(--acc-b)' }}>MASTER</span>}
                      {outOfDate && <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 20, background: 'var(--red, #dc2626)', color: '#fff' }}>⚠ OUT OF DATE — restart this till</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2 }}>
                      {online ? `Active · ${ageSec}s ago` : `Offline · ${ageSec > 60 ? Math.round(ageSec/60)+'m' : ageSec+'s'} ago`}
                      {d.open_tables > 0 ? ` · ${d.open_tables} open table${d.open_tables !== 1 ? 's' : ''}` : ''}
                      {d.version ? ` · v${d.version}` : ''}
                      {d.ip_hint ? ` · ${d.ip_hint}` : ''}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: online ? (isMaster ? 'var(--acc)' : 'var(--grn)') : 'var(--t4)' }}>
                    {online ? '●  Online' : '○  Offline'}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <button onClick={loadDevices} style={{ marginTop: 10, padding: '6px 14px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg3)', color: 'var(--t3)', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
          ↻ Refresh
        </button>
      </div>

      {/* Force sync */}
      <div style={{ padding: '20px', borderRadius: 14, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>Force sync this device</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 16, lineHeight: 1.6 }}>
          Pulls the latest sessions and today's closed checks from Supabase and reconciles them with this device's local state.
          Use this when a device has missed updates — for example after a network outage, or when the data on two terminals doesn't match.
        </div>

        {syncResult && (
          <div style={{
            padding: '10px 14px', borderRadius: 10, marginBottom: 12,
            background: syncResult.ok ? 'var(--grn-d)' : 'var(--red-d)',
            border: `1px solid ${syncResult.ok ? 'var(--grn-b)' : 'var(--red-b)'}`,
            fontSize: 12, color: syncResult.ok ? 'var(--grn)' : 'var(--red)',
          }}>
            {syncResult.ok
              ? `✓ Synced ${syncResult.sessionCount} open session${syncResult.sessionCount !== 1 ? 's' : ''} and ${syncResult.checkCount} closed check${syncResult.checkCount !== 1 ? 's' : ''} from Supabase`
              : `✗ Sync failed — ${syncResult.error}`}
          </div>
        )}

        <button
          onClick={handleForceSync}
          disabled={syncing}
          style={{
            padding: '12px 24px', borderRadius: 10, cursor: syncing ? 'default' : 'pointer',
            fontFamily: 'inherit', fontWeight: 700, fontSize: 13,
            background: syncing ? 'var(--bg3)' : 'var(--acc)', color: syncing ? 'var(--t3)' : '#0b0c10',
            border: 'none', opacity: syncing ? 0.7 : 1,
          }}>
          {syncing ? '⟳  Syncing from Supabase…' : '↓  Force sync now'}
        </button>
      </div>

      {/* How master-child works */}
      <div style={{ marginTop: 20, padding: '16px', borderRadius: 12, background: 'var(--bg3)', border: '1px solid var(--bdr)', fontSize: 12, color: 'var(--t3)', lineHeight: 1.7 }}>
        <strong style={{ color: 'var(--t2)' }}>How master-child works:</strong> One terminal is designated as the Master in Device Profiles.
        It broadcasts a heartbeat every 10 seconds. All other terminals check the heartbeat every 15 seconds —
        if the master has not been seen in 30 seconds, child terminals show a blocking error screen.
        Staff can force sync from cloud or continue in degraded mode.
      </div>
    </div>
  );
}
