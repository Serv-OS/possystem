import { useState, useEffect } from 'react';
import { getQueueSize } from '../sync/OfflineQueue';
import { getPendingCount } from '../sync/DataSafe';
import { Icon } from './ServOSIcons';

export default function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [pendingChecks, setPendingChecks] = useState(0);

  // Check pending checks on mount
  useEffect(() => {
    const count = getPendingCount();
    if (count > 0) setPendingChecks(count);
  }, []);

  useEffect(() => {
    const onOffline = () => { setOffline(true); };
    const onOnline = async () => {
      setOffline(false);
      setSyncing(true);
      const [qSize, pChecks] = await Promise.all([getQueueSize(), Promise.resolve(getPendingCount())]);
      setPendingChecks(pChecks);
      setTimeout(() => { setSyncing(false); setPendingChecks(0); }, 5000);
    };

    window.addEventListener('rpos-offline', onOffline);
    window.addEventListener('rpos-online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('rpos-offline', onOffline);
      window.removeEventListener('rpos-online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  if (!offline && !syncing && pendingChecks === 0) return null;

  const bg = offline ? '#7f1d1d' : pendingChecks > 0 ? '#78350f' : '#14532d';
  const icon = offline ? 'bolt' : pendingChecks > 0 ? 'clock' : null;
  const msg = offline
    ? 'No internet — orders saved locally, will sync when reconnected'
    : pendingChecks > 0
      ? `Syncing ${pendingChecks} payment${pendingChecks !== 1 ? 's' : ''} to server…`
      : 'Back online — all data synced';

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 99999,
      background: bg, color: 'white',
      padding: '7px 16px',
      display: 'flex', alignItems: 'center', gap: 10,
      fontSize: 12, fontWeight: 700,
      transition: 'background .3s',
    }}>
      <span style={{ fontSize: 14, display: 'flex' }}>{icon ? <Icon name={icon} size={14}/> : '✓'}</span>
      {msg}
    </div>
  );
}
