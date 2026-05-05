// src/components/StatusDrawerCardReaders.jsx
// Card readers section for the Terminal status drawer (POS side).
//
// Two reader categories visible to the cashier:
//   • Bluetooth reader paired to THIS POS terminal (Stripe Reader M2). Pairing
//     happens here. Persisted in localStorage and bound to the rpos-device id.
//   • Network readers registered to this LOCATION in BO. Cashier picks one to
//     "use on this terminal" — connection is per-checkout, not persistent.
//
// Outside the Sunmi APK the bridge isn't present — we render a placeholder
// explaining where pairing actually lives.

import { useState, useEffect, useCallback } from 'react';
import {
  hasStripeTerminalBridge,
  getBridgeDiagnostics,
  initialize,
  checkPermissions, requestPermissions,
  discoverReaders, cancelDiscovery,
  connectReader, disconnectReader,
  getStatus, onStatusEvent,
  syncAuthTokenFromSession,
  resolvePlatformLocationId,
  getSavedPairing, savePairing, clearPairing,
  getPosDeviceId,
} from '../lib/stripeTerminal';
import { getActiveLocationSync, platformSupabase } from '../lib/supabase';

const Sx = {
  pill:    { fontSize: 10, padding: '2px 7px', borderRadius: 99, background: 'var(--bg3)', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, border: '1px solid var(--bdr)' },
  rowCard: { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--bg2)', marginBottom: 6 },
  btnXs:   { padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', color: '#0b0c10' },
  btnGhost:{ background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  btnDan:  { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)' },
  errorBox:{ padding: 9, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 8, fontSize: 11, border: '1px solid var(--red-b)', lineHeight: 1.4 },
};

export default function StatusDrawerCardReaders() {
  const bridgePresent = hasStripeTerminalBridge();
  const posDeviceId = getPosDeviceId();
  const [bridgeStatus, setBridgeStatus] = useState(() => getStatus());
  const [permsGranted, setPermsGranted] = useState(false);
  const [permsCheckedAt, setPermsCheckedAt] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredReaders, setDiscoveredReaders] = useState([]);
  const [savedPairing, setSavedPairing] = useState(getSavedPairing());
  const [networkReaders, setNetworkReaders] = useState([]);
  const [platformLocationId, setPlatformLocationId] = useState(null);

  // ── Effects ─────────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const ops = getActiveLocationSync();
      if (!ops) return;
      const platformId = await resolvePlatformLocationId(ops);
      setPlatformLocationId(platformId);
    })();
  }, []);

  useEffect(() => {
    if (!bridgePresent) return;
    const off = onStatusEvent(() => setBridgeStatus(getStatus()));
    return off;
  }, [bridgePresent]);

  useEffect(() => {
    const update = () => setSavedPairing(getSavedPairing());
    window.addEventListener('posup-paired-reader-updated', update);
    return () => window.removeEventListener('posup-paired-reader-updated', update);
  }, []);

  // Load network reader assigned to THIS pos device
  useEffect(() => {
    if (!platformLocationId || !platformSupabase || !posDeviceId) return;
    (async () => {
      const { data } = await platformSupabase
        .from('payment_devices')
        .select('id, stripe_reader_id, label, device_type, connection_kind, status, last_seen_at, serial_number, ip_address')
        .eq('location_id', platformLocationId)
        .eq('connection_kind', 'network')
        .eq('bound_pos_device_id', posDeviceId)
        .order('label', { ascending: true });
      setNetworkReaders(data ?? []);
    })();
  }, [platformLocationId, posDeviceId]);

  // Initial bridge probe + perms check
  const probe = useCallback(async () => {
    if (!bridgePresent) return;
    try {
      await syncAuthTokenFromSession();
      await initialize();
      const p = await checkPermissions();
      setPermsGranted(!!p?.granted);
      setBridgeStatus(getStatus());
      setPermsCheckedAt(Date.now());
    } catch (e) {
      setError(`Init failed: ${e.message}`);
    }
  }, [bridgePresent]);

  useEffect(() => { probe(); }, [probe]);

  // ── Actions ────────────────────────────────────────────────────────────

  const handleRequestPerms = async () => {
    setBusy(true); setError(null);
    try {
      await requestPermissions();
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
    setDiscoveredReaders([]); setError(null); setDiscovering(true);
    try {
      await discoverReaders((readers) => setDiscoveredReaders(readers));
    } catch (e) {
      setError(`Discovery failed: ${e.message}`);
    } finally {
      setDiscovering(false);
    }
  };

  const handleConnect = async (reader) => {
    if (!platformLocationId) { setError('No location resolved'); return; }
    setBusy(true); setError(null);
    try {
      await connectReader(reader.serialNumber, platformLocationId);
      savePairing({
        serialNumber: reader.serialNumber,
        deviceType: reader.deviceType,
        label: reader.label || reader.serialNumber,
        locationId: platformLocationId,
      });

      // Best-effort: register the BT reader in payment_devices so it shows up
      // in the BO inventory. This uses anon write; if RLS blocks, we just skip.
      try {
        const status = getStatus();
        const stripeReaderId = status?.reader?.serialNumber || reader.serialNumber;
        if (platformSupabase && stripeReaderId) {
          await platformSupabase.from('payment_devices').upsert({
            location_id: platformLocationId,
            stripe_reader_id: stripeReaderId,
            stripe_account_id: 'unknown',                                 // BT readers don't have a Stripe rdr_ id
            device_type: reader.deviceType || 'stripe_m2',
            connection_kind: 'bluetooth',
            serial_number: reader.serialNumber,
            label: reader.label || reader.serialNumber,
            bound_pos_device_id: posDeviceId,
            status: 'online',
            last_seen_at: new Date().toISOString(),
          }, { onConflict: 'stripe_reader_id' });
        }
      } catch (e) {
        // Non-fatal — the reader is paired locally either way
        console.warn('[CardReaders] failed to upsert into payment_devices:', e.message);
      }

      setBridgeStatus(getStatus());
      setDiscoveredReaders([]);
      try { await cancelDiscovery(); } catch {}
      setDiscovering(false);
    } catch (e) {
      setError(`Connect failed: ${e.message}`);
    } finally { setBusy(false); }
  };

  const handleDisconnect = async (alsoForget = false) => {
    setBusy(true); setError(null);
    try {
      await disconnectReader();
      if (alsoForget) clearPairing();
      setBridgeStatus(getStatus());
    } catch (e) {
      setError(`Disconnect failed: ${e.message}`);
    } finally { setBusy(false); }
  };

  const handleReconnectSaved = async () => {
    if (!savedPairing) return;
    setBusy(true); setError(null);
    try {
      await connectReader(savedPairing.serialNumber, savedPairing.locationId);
      setBridgeStatus(getStatus());
    } catch (e) {
      setError(`Reconnect failed: ${e.message}`);
    } finally { setBusy(false); }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  const connectedReader = bridgeStatus?.reader;
  const isConnected = !!connectedReader;
  const showRescan = !isConnected || (savedPairing && connectedReader?.serialNumber !== savedPairing.serialNumber);

  if (!bridgePresent) {
    const diag = getBridgeDiagnostics();
    return (
      <div style={{ padding: '8px 0' }}>
        <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.5, marginBottom: 8 }}>
          The native card-reader bridge isn't responding.
        </div>
        <details style={{ fontSize: 10, color: 'var(--t3)', background: 'var(--bg3)', borderRadius: 6, padding: 8 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Bridge diagnostics</summary>
          <pre style={{ margin: '6px 0 0', fontSize: 10, fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
{`window:                  ${diag.hasWindow}
window.RposStripeTerminal: ${diag.hasNative}
.isAvailable() defined:  ${diag.hasIsAvailable}
.isAvailable() returned: ${JSON.stringify(diag.isAvailableResult)} (${diag.isAvailableType})
exposed methods:         ${diag.methods.length > 0 ? diag.methods.join(', ') : '(none enumerable — bridges often hide their methods from Object.keys, this is normal)'}
error:                   ${diag.error ?? '(none)'}
user agent:              ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`}
          </pre>
        </details>
        <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 8, lineHeight: 1.5 }}>
          If you're inside the Sunmi APK and seeing this message, the bridge didn't load. Likely causes: an old APK without the Stripe bridge, or the StripeTerminalBridge class failed to register. Make sure you're on v{typeof window !== 'undefined' && window.RPOS_VERSION ? window.RPOS_VERSION : '5.5.51 or later'}.
        </div>
      </div>
    );
  }

  return (
    <div>
      {error && <div style={Sx.errorBox}>{error}</div>}

      {/* ── Bluetooth (this POS) ──────────────────────────────────────── */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 6 }}>
          Bluetooth · This terminal
        </div>

        {isConnected && connectedReader ? (
          <div style={Sx.rowCard}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {connectedReader.label || connectedReader.serialNumber}
                </div>
                <div style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--font-mono, monospace)' }}>{connectedReader.serialNumber}</div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--grn)' }}>● live</span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={Sx.pill}>{connectedReader.deviceType?.replace(/_/g, ' ') || 'reader'}</span>
              {connectedReader.batteryLevel != null && (
                <span style={Sx.pill}>{Math.round(connectedReader.batteryLevel * 100)}%</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => handleDisconnect(false)} disabled={busy} style={{ ...Sx.btnXs, ...Sx.btnGhost }}>
                Disconnect
              </button>
              <button onClick={() => { if (confirm('Forget this paired reader on this terminal?')) handleDisconnect(true); }} disabled={busy} style={{ ...Sx.btnXs, ...Sx.btnDan }}>
                Forget
              </button>
            </div>
          </div>
        ) : savedPairing ? (
          <div style={Sx.rowCard}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  {savedPairing.label || savedPairing.serialNumber}
                </div>
                <div style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--font-mono, monospace)' }}>{savedPairing.serialNumber}</div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t4)' }}>○ paired · idle</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={handleReconnectSaved} disabled={busy} style={{ ...Sx.btnXs, ...Sx.btnPrim }}>
                Reconnect
              </button>
              <button onClick={() => { if (confirm('Forget this paired reader?')) clearPairing(); }} disabled={busy} style={{ ...Sx.btnXs, ...Sx.btnDan }}>
                Forget
              </button>
            </div>
          </div>
        ) : (
          <div style={{ ...Sx.rowCard, textAlign: 'center', padding: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 8 }}>No reader paired with this terminal</div>
            {permsCheckedAt > 0 && !permsGranted ? (
              <button onClick={handleRequestPerms} disabled={busy} style={{ ...Sx.btnXs, ...Sx.btnPrim }}>
                Grant Bluetooth permissions
              </button>
            ) : (
              <button
                onClick={async () => {
                  // First-time path: request perms inline if we haven't checked yet,
                  // so the user always gets to a working scan with one tap.
                  if (permsCheckedAt === 0 || !permsGranted) {
                    await handleRequestPerms();
                    if (!permsGranted) return;
                  }
                  handleDiscover();
                }}
                disabled={busy}
                style={{ ...Sx.btnXs, ...Sx.btnPrim }}
              >
                {discovering ? 'Scanning…' : permsGranted ? 'Pair Stripe Reader M2' : 'Connect reader'}
              </button>
            )}
            {error && <div style={{ ...Sx.errorBox, marginTop: 8, fontSize: 10 }}>{error}</div>}
          </div>
        )}

        {/* Discovery results */}
        {discovering && (
          <div style={{ ...Sx.rowCard, marginTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t2)' }}>
                Scanning… ({discoveredReaders.length} found)
              </div>
              <button onClick={handleDiscover} disabled={busy} style={{ ...Sx.btnXs, ...Sx.btnGhost }}>Stop</button>
            </div>
            <div style={{ fontSize: 10, color: 'var(--t4)', marginBottom: 8, lineHeight: 1.4 }}>
              Hold the M2 power button for 4 seconds — when its LEDs flash blue it's in pairing mode.
            </div>
            {discoveredReaders.map((r) => (
              <div key={r.serialNumber} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--bdr)' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>{r.label || r.serialNumber}</div>
                  <div style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--font-mono, monospace)' }}>{r.deviceType?.replace(/_/g,' ')}</div>
                </div>
                <button onClick={() => handleConnect(r)} disabled={busy} style={{ ...Sx.btnXs, ...Sx.btnPrim }}>
                  Pair
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Network reader assigned to this terminal ─────────────── */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 6 }}>
          Network · This terminal
        </div>
        {networkReaders.length === 0 ? (
          <div style={{ ...Sx.rowCard, padding: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.5 }}>
              No network reader assigned to this terminal.<br/>
              <span style={{ color: 'var(--t4)' }}>An admin can assign a network reader (Stripe S700, WisePOS E) to this device in <strong style={{ color: 'var(--acc)' }}>Back office → Card readers</strong>.</span>
            </div>
          </div>
        ) : (
          networkReaders.map((r) => (
            <div key={r.id} style={Sx.rowCard}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{r.label || r.serial_number}</div>
                  <div style={{ fontSize: 10, color: 'var(--t4)' }}>
                    {(r.device_type || '').replace(/_/g, ' ')} · {r.status || 'unknown'}
                    {r.ip_address && (<> · <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>{r.ip_address}</code></>)}
                  </div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, color: r.status === 'online' ? 'var(--grn)' : 'var(--t4)' }}>
                  ● {r.status === 'online' ? 'live' : (r.status || 'unknown')}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 8, lineHeight: 1.4 }}>
        Terminal id: <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>{posDeviceId || '(not configured)'}</code>
      </div>
    </div>
  );
}
