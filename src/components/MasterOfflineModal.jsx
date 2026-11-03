import { useState } from 'react';
import { forceSyncFromSupabase } from '../sync/MasterSync';
import { Icon } from './ServOSIcons';

export default function MasterOfflineModal({ masterName, lastSeen }) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);

  const handleForceSync = async () => {
    setSyncing(true);
    setResult(null);
    const r = await forceSyncFromSupabase();
    setSyncing(false);
    setResult(r);
  };

  const ageSec = lastSeen?.last_seen
    ? Math.round((Date.now() - new Date(lastSeen.last_seen).getTime()) / 1000)
    : null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: '#0b0c10',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--bg1)',
        border: '2px solid #ef4444',
        borderRadius: 20,
        padding: '40px 36px',
        maxWidth: 460,
        width: '90%',
        textAlign: 'center',
        boxShadow: '0 0 60px rgba(239,68,68,0.25)',
      }}>
        <div style={{ fontSize: 52, marginBottom: 18, display: 'flex', justifyContent: 'center', color: '#ef4444' }}><Icon name="radio" size={52}/></div>

        <div style={{ fontSize: 22, fontWeight: 800, color: '#ef4444', marginBottom: 8 }}>
          Master POS offline
        </div>

        <div style={{ fontSize: 14, color: 'var(--t2)', fontWeight: 600, marginBottom: 4 }}>
          {masterName || 'Master terminal'} is not responding
        </div>

        {ageSec != null && (
          <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 24 }}>
            Last seen {ageSec < 60 ? `${ageSec}s` : `${Math.round(ageSec/60)}m`} ago
            {lastSeen?.version ? ` · v${lastSeen.version}` : ''}
          </div>
        )}

        <div style={{
          background: 'var(--bg3)', border: '1px solid var(--bdr)',
          borderRadius: 12, padding: '14px 18px', marginBottom: 24,
          fontSize: 13, color: 'var(--t2)', lineHeight: 1.8, textAlign: 'left',
        }}>
          <div style={{ fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>What to do:</div>
          <div>1. Power on <strong>{masterName || 'the master POS'}</strong></div>
          <div>2. Make sure it's on the same WiFi network</div>
          <div>3. Open the POS app and wait for it to load</div>
          <div style={{ marginTop: 8, color: 'var(--t4)', fontSize: 12 }}>
            This terminal will unlock automatically once the master responds.
          </div>
        </div>

        {result && (
          <div style={{
            padding: '10px 14px', borderRadius: 10, marginBottom: 16,
            background: result.ok ? 'var(--grn-d)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${result.ok ? 'var(--grn-b)' : 'rgba(239,68,68,0.3)'}`,
            fontSize: 12, color: result.ok ? 'var(--grn)' : '#ef4444',
          }}>
            {result.ok
              ? `✓ Synced ${result.sessionCount} sessions · ${result.checkCount} checks from cloud`
              : `✗ Sync failed: ${result.error}`}
          </div>
        )}

        <button
          onClick={handleForceSync}
          disabled={syncing}
          style={{
            width: '100%', padding: '14px', borderRadius: 12,
            cursor: syncing ? 'default' : 'pointer',
            fontFamily: 'inherit', fontWeight: 700, fontSize: 14,
            background: syncing ? 'var(--bg3)' : 'var(--bg3)',
            border: '1px solid var(--bdr2)',
            color: syncing ? 'var(--t4)' : 'var(--t2)',
            opacity: syncing ? 0.7 : 1,
          }}>
          {syncing ? '⟳  Syncing from cloud…' : '↓  Force sync from cloud'}
        </button>

        <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 14 }}>
          This terminal is locked until the master POS is back online
        </div>
      </div>
    </div>
  );
}
