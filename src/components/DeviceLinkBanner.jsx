// DeviceLinkBanner: database fence stage 1, contract A7.
//
// Mounted by every till surface (POS, bar, tables, MPOS, KDS, time clock, kiosk). It starts the
// device link monitor (lib/deviceLink.js: boot check, wake, online, refused writes, the 60 s
// heartbeat) and shows a fixed red bar ONLY when the server said this device is no longer the
// paired till. It never unpairs anything and never touches open orders: "Pair again" opens the
// pairing screen over the till, and pairing the same device keeps every table, tab and queued
// order (same venue, so the tenant fence wipes nothing).
import { useEffect, useState } from 'react';
import { getDeviceLinkState, subscribeDeviceLink, startDeviceLinkMonitor, checkDeviceLink } from '../lib/deviceLink';
import { shouldShowLinkBanner, linkBannerText } from '../lib/deviceFence';
import { readLocalDevice } from '../lib/supabase';
import PairingScreen from '../surfaces/PairingScreen';

export default function DeviceLinkBanner() {
  const [link, setLink] = useState(() => getDeviceLinkState());
  const [pairing, setPairing] = useState(false);

  useEffect(() => {
    const off = subscribeDeviceLink(setLink);
    startDeviceLinkMonitor();
    checkDeviceLink();
    return off;
  }, []);

  if (pairing) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 10050, background: 'var(--bg-base, #0f1117)', overflow: 'auto' }}>
        <PairingScreen onPaired={() => window.location.reload()} />
        <button onClick={() => setPairing(false)}
          style={{ position: 'fixed', top: 16, right: 16, padding: '10px 16px', borderRadius: 10, border: '1px solid var(--bdr, #334155)', background: 'var(--bg1, #1e293b)', color: 'var(--t1, #fff)', fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>
          Back to the till
        </button>
      </div>
    );
  }

  if (!shouldShowLinkBanner(link)) return null;
  const local = readLocalDevice();
  const text = linkBannerText({ kind: local?.kind, venueName: local?.locationName });
  return (
    <div role="alert" style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10040,
      background: '#b91c1c', color: '#fff', padding: '10px 16px',
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      fontFamily: 'inherit', boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
    }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ fontWeight: 800, fontSize: 15 }}>{text.title}</div>
        <div style={{ fontSize: 13, opacity: 0.95, marginTop: 2 }}>{text.body}</div>
      </div>
      <button onClick={() => checkDeviceLink()}
        style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.6)', background: 'transparent', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
        Check again
      </button>
      <button onClick={() => setPairing(true)}
        style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#fff', color: '#b91c1c', fontWeight: 800, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
        Pair again
      </button>
    </div>
  );
}
