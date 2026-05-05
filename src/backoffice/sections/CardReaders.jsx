// src/backoffice/sections/CardReaders.jsx
// Pair, disconnect, and view status of the connected Stripe Reader (M2 / WisePOS / etc.)
// for the active location. Only meaningful when running inside the Sunmi APK
// (where window.RposStripeTerminal is available); shows a friendly placeholder
// otherwise.

import { useEffect, useState, useCallback } from 'react';
import {
  hasStripeTerminalBridge,
  initialize,
  checkPermissions,
  requestPermissions,
  discoverReaders,
  cancelDiscovery,
  connectReader,
  disconnectReader,
  getStatus,
  onStatusEvent,
  syncAuthTokenFromSession,
  resolvePlatformLocationId,
} from '../../lib/stripeTerminal';
import { getActiveLocationSync } from '../../lib/supabase';

const S = {
  page:    { padding: 0 },
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 24, maxWidth: 640, lineHeight: 1.5 },
  card:    { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: 'var(--sh)' },
  btn:     { padding: '9px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', color: '#0b0c10' },
  btnGhost:{ background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  btnDan:  { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)' },
  pill:    { fontSize: 11, padding: '2px 8px', borderRadius: 99, background: 'var(--bg3)', color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700, border: '1px solid var(--bdr)' },
  errorBox:{ padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--red-b)' },
  okBox:   { padding: 10, background: 'var(--grn-d)', color: 'var(--grn)', borderRadius: 8, marginBottom: 14, border: '1px solid var(--grn-b)', fontSize: 13 },
  reader:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, marginBottom: 8 },
};

export default function CardReaders() {
  const bridgePresent = hasStripeTerminalBridge();
  const [status, setStatus] = useState(() => getStatus());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [discoveredReaders, setDiscoveredReaders] = useState([]);
  const [discovering, setDiscovering] = useState(false);
  const [permsGranted, setPermsGranted] = useState(false);
  const [platformLocationId, setPlatformLocationId] = useState(null);

  // Resolve platform location id once (we need it to scope reader pairings)
  useEffect(() => {
    (async () => {
      const ops = getActiveLocationSync();
      if (!ops) return;
      const platformId = await resolvePlatformLocationId(ops);
      setPlatformLocationId(platformId);
    })();
  }, []);

  // Subscribe to status events
  useEffect(() => {
    if (!bridgePresent) return;
    return onStatusEvent(() => setStatus(getStatus()));
  }, [bridgePresent]);

  // Init + permissions on mount
  const initAndCheckPerms = useCallback(async () => {
    setError(null);
    try {
      await syncAuthTokenFromSession();
      await initialize();
      const perms = await checkPermissions();
      setPermsGranted(!!perms?.granted);
      setStatus(getStatus());
    } catch (e) {
      setError(`Init failed: ${e.message}`);
    }
  }, []);

  useEffect(() => {
    if (bridgePresent) initAndCheckPerms();
  }, [bridgePresent, initAndCheckPerms]);

  const handleRequestPerms = async () => {
    setBusy(true); setError(null);
    try {
      await requestPermissions();
      // Native perms dialog runs async; re-check after a short delay
      setTimeout(async () => {
        const p = await checkPermissions();
        setPermsGranted(!!p?.granted);
      }, 1500);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const handleDiscover = async () => {
    if (discovering) {
      try { await cancelDiscovery(); } catch {}
      setDiscovering(false);
      return;
    }
    setDiscoveredReaders([]); setError(null);
    setDiscovering(true);
    try {
      await discoverReaders((readers) => setDiscoveredReaders(readers));
    } catch (e) {
      setError(`Discovery failed: ${e.message}`);
    } finally {
      setDiscovering(false);
    }
  };

  const handleConnect = async (reader) => {
    if (!platformLocationId) { setError('No location resolved — sign in to a location first.'); return; }
    setBusy(true); setError(null);
    try {
      await connectReader(reader.serialNumber, platformLocationId);
      setStatus(getStatus());
      setDiscoveredReaders([]);
      try { await cancelDiscovery(); } catch {}
      setDiscovering(false);
    } catch (e) {
      setError(`Connect failed: ${e.message}`);
    } finally { setBusy(false); }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect the card reader? Card payments will be unavailable until you reconnect.')) return;
    setBusy(true); setError(null);
    try {
      await disconnectReader();
      setStatus(getStatus());
    } catch (e) {
      setError(`Disconnect failed: ${e.message}`);
    } finally { setBusy(false); }
  };

  // ── Render ────────────────────────────────────────────────────────────
  if (!bridgePresent) {
    return (
      <div style={S.page}>
        <h1 style={S.h1}>Card readers</h1>
        <div style={S.sub}>
          Pair Stripe Reader M2 (Bluetooth) for card-present payments at this location.
        </div>
        <div style={{ ...S.card, textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📱</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>Hardware bridge not detected</div>
          <div style={{ fontSize: 13, color: 'var(--t3)', maxWidth: 420, margin: '0 auto', lineHeight: 1.5 }}>
            Card-reader pairing is only available when running inside the POSUP Sunmi APK.
            On a regular browser, card payments fall back to the test "simulate" flow.
          </div>
        </div>
      </div>
    );
  }

  const connectedReader = status?.reader;
  const isConnected = !!connectedReader;

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Card readers</h1>
      <div style={S.sub}>
        Pair the Stripe Reader M2 to this device. Power on the M2 by holding its power button for 4 seconds —
        when its LEDs flash blue it is in pairing mode. Then click "Scan for readers".
      </div>

      {error && <div style={S.errorBox}>{error}</div>}

      {/* ── Connected reader ─────────────────────────────────────────── */}
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
              Connected reader
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)' }}>
              {isConnected ? (connectedReader.label || connectedReader.serialNumber) : 'Not connected'}
            </div>
          </div>
          {isConnected && (
            <button onClick={handleDisconnect} disabled={busy} style={{ ...S.btn, ...S.btnDan }}>Disconnect</button>
          )}
        </div>

        {isConnected ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={S.pill}>{connectedReader.deviceType?.replace(/_/g, ' ') || 'Reader'}</span>
            <span style={S.pill}>{(connectedReader.batteryLevel != null ? `${Math.round(connectedReader.batteryLevel * 100)}%` : '—')}</span>
            <span style={S.pill}>{status.connection || 'connected'}</span>
            <code style={{ fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--font-mono, monospace)' }}>{connectedReader.serialNumber}</code>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--t3)' }}>
            No reader paired with this device yet.
          </div>
        )}
      </div>

      {/* ── Permissions check ────────────────────────────────────────── */}
      {!permsGranted && (
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>Permissions required</div>
          <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 12 }}>
            Bluetooth and (on older Android) location permissions are required to scan for card readers.
          </div>
          <button onClick={handleRequestPerms} disabled={busy} style={{ ...S.btn, ...S.btnPrim }}>
            Grant permissions
          </button>
        </div>
      )}

      {/* ── Discovery + connect ──────────────────────────────────────── */}
      {permsGranted && !isConnected && (
        <div style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>
              {discovering ? `Scanning… (${discoveredReaders.length} found)` : 'Pair a new reader'}
            </div>
            <button onClick={handleDiscover} disabled={busy || !platformLocationId} style={{ ...S.btn, ...(discovering ? S.btnGhost : S.btnPrim) }}>
              {discovering ? 'Stop scanning' : 'Scan for readers'}
            </button>
          </div>

          {!platformLocationId && (
            <div style={{ ...S.errorBox, marginBottom: 0 }}>
              No location selected — pick a location in the back office before pairing a reader.
            </div>
          )}

          {discoveredReaders.length > 0 && (
            <div>
              {discoveredReaders.map((r) => (
                <div key={r.serialNumber} style={S.reader}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{r.label || r.serialNumber}</div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--font-mono, monospace)' }}>{r.deviceType?.replace(/_/g, ' ')} · {r.serialNumber}</div>
                  </div>
                  <button onClick={() => handleConnect(r)} disabled={busy} style={{ ...S.btn, ...S.btnPrim }}>
                    Connect
                  </button>
                </div>
              ))}
            </div>
          )}

          {discovering && discoveredReaders.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--t3)', textAlign: 'center', padding: 20 }}>
              No readers found yet — make sure the M2 is powered on and in pairing mode (hold power 4s, blue flashing LEDs).
            </div>
          )}
        </div>
      )}
    </div>
  );
}
