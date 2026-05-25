import { useState, useEffect, useRef } from 'react';

export default function UpdateBanner() {
  const [updateReady, setUpdateReady] = useState(false);
  const regRef = useRef(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const setup = () => {
      navigator.serviceWorker.getRegistration().then(reg => {
        if (!reg) return;
        regRef.current = reg;

        // Already waiting right now (e.g. page refreshed after new SW installed)
        if (reg.waiting) { setUpdateReady(true); return; }

        // Watch for new SW installing → waiting
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              // New SW is waiting — show banner
              regRef.current = reg;
              setUpdateReady(true);
            }
          });
        });
      });
    };

    setup();

    // Poll every 5 minutes — triggers update check in background
    const poll = setInterval(() => {
      navigator.serviceWorker.getRegistration().then(reg => {
        if (!reg) return;
        reg.update().then(() => {
          if (reg.waiting) { regRef.current = reg; setUpdateReady(true); }
        }).catch(() => {});
      });
    }, 5 * 60 * 1000);

    return () => clearInterval(poll);
  }, []);

  const applyUpdate = () => {
    const reg = regRef.current;
    if (reg?.waiting) {
      // Tell waiting SW to activate
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      // Reload once new SW takes control
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      }, { once: true });
    } else {
      window.location.reload(true);
    }
  };

  if (!updateReady) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 24,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 99999,
      background: '#1a1d27',
      border: '1.5px solid rgba(212,136,28,0.4)',
      borderRadius: 14,
      padding: '12px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
      minWidth: 300,
      maxWidth: 420,
    }}>
      <div style={{ fontSize: 22 }}>🔄</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', marginBottom: 2 }}>
          Update available
        </div>
        <div style={{ fontSize: 11, color: '#64748b' }}>
          A new version of Serv OS is ready
        </div>
      </div>
      <button
        onClick={applyUpdate}
        style={{
          background: '#C75A29',
          color: '#0b0c10',
          border: 'none',
          borderRadius: 9,
          padding: '9px 18px',
          fontSize: 13,
          fontWeight: 800,
          cursor: 'pointer',
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        Update now
      </button>
    </div>
  );
}
