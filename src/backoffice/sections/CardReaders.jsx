// src/backoffice/sections/CardReaders.jsx
// Back office card-reader registry — SCOPED TO THE ACTIVE LOCATION.
//
// What lives here:
//   • Register network/WiFi readers (Stripe S700, WisePOS E) for THIS location
//     using Stripe's pairing-code flow.
//   • Read-only inventory of all readers serving this location, including BT
//     readers paired by individual POS terminals.
//
// Bluetooth pairing happens at the POS terminal itself — see Status drawer.
// Cross-location oversight lives in the super-admin app (?mode=admin).

import { useEffect, useState, useCallback } from 'react';
import { supabase, platformSupabase, getActiveLocationSync } from '../../lib/supabase';
import { resolvePlatformLocationId } from '../../lib/stripeTerminal';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const S = {
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 20, maxWidth: 720, lineHeight: 1.5 },
  card:    { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: 'var(--sh)' },
  label:   { fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '.06em' },
  input:   { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  inputMono: { fontFamily: 'var(--font-mono, monospace)' },
  btn:     { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', color: '#0b0c10' },
  btnGhost:{ background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  btnDan:  { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)' },
  pill:    { fontSize: 11, padding: '2px 8px', borderRadius: 99, background: 'var(--bg3)', color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700, border: '1px solid var(--bdr)' },
  errorBox:{ padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--red-b)' },
  empty:   { padding: 14, fontSize: 13, color: 'var(--t3)', textAlign: 'center', background: 'var(--bg2)', borderRadius: 8, border: '1px dashed var(--bdr)' },
};

export default function CardReaders() {
  const [platformLocationId, setPlatformLocationId] = useState(null);
  const [locationName, setLocationName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [readers, setReaders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);

  const refresh = useCallback(async () => {
    if (!platformSupabase) {
      setError('Platform Supabase not configured');
      setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    try {
      const opsLocId = getActiveLocationSync();
      if (!opsLocId) {
        setError('No active location selected. Pick a location in the bottom-left corner of the back office.');
        setLoading(false);
        return;
      }
      const platformId = await resolvePlatformLocationId(opsLocId);
      if (!platformId) {
        setError('This location is not registered for billing yet. Contact platform admin.');
        setLoading(false);
        return;
      }
      setPlatformLocationId(platformId);

      const [{ data: loc }, { data: rdrs }] = await Promise.all([
        platformSupabase.from('locations').select('id, name, company_id').eq('id', platformId).maybeSingle(),
        platformSupabase.from('payment_devices')
          .select('id, stripe_reader_id, label, device_type, connection_kind, serial_number, status, last_seen_at, bound_pos_device_id, created_at, registration_code, ip_address, firmware_version, last_status_check_at')
          .eq('location_id', platformId)
          .order('created_at', { ascending: false }),
      ]);
      setLocationName(loc?.name ?? '(unknown)');
      setReaders(rdrs ?? []);

      if (loc?.company_id) {
        const { data: co } = await platformSupabase.from('companies').select('name').eq('id', loc.company_id).maybeSingle();
        setCompanyName(co?.name ?? '');
      }
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // ── Refresh live diagnostics from Stripe ──────────────────────────────
  const refreshStatusFromStripe = async () => {
    if (!platformLocationId) return;
    setRefreshingStatus(true); setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('not authenticated');
      const res = await fetch(`${FUNCTIONS_URL}/stripe-readers-status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ location_id: platformLocationId }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
      setLastRefreshedAt(Date.now());
      // Re-pull from DB so we see persisted updates
      await refresh();
    } catch (e) {
      setError(`Status refresh failed: ${e.message}`);
    } finally {
      setRefreshingStatus(false);
    }
  };

  const networkReaders = readers.filter(r => r.connection_kind === 'network');
  const bluetoothReaders = readers.filter(r => r.connection_kind === 'bluetooth');

  const onUnregister = async (rdr) => {
    if (!confirm(`Unregister "${rdr.label || rdr.serial_number}"? It will be removed from POSUP only — you will need to delete it from the Stripe dashboard separately.`)) return;
    const { error } = await platformSupabase.from('payment_devices').delete().eq('id', rdr.id);
    if (error) alert(`Failed: ${error.message}`); else refresh();
  };

  return (
    <div>
      <h1 style={S.h1}>Card readers</h1>
      <div style={S.sub}>
        Network readers (Stripe Reader S700, WisePOS E in WiFi mode) are registered here and serve all POS terminals at this location.
        Bluetooth readers (Stripe Reader M2) are paired at each POS terminal individually — they appear here read-only.
      </div>

      {error && <div style={S.errorBox}>{error}</div>}

      {loading ? (
        <div style={{ ...S.empty, marginBottom: 20 }}>Loading…</div>
      ) : (
        <>
          {/* Location header */}
          <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                {companyName && (
                  <div style={{ fontSize: 11, color: 'var(--acc)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
                    {companyName}
                  </div>
                )}
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)' }}>{locationName}</div>
                <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: 'var(--t3)' }}>
                  <span><strong style={{ color: 'var(--t1)' }}>{networkReaders.length}</strong> network</span>
                  <span><strong style={{ color: 'var(--t1)' }}>{bluetoothReaders.length}</strong> bluetooth</span>
                  {lastRefreshedAt && (
                    <span style={{ color: 'var(--t4)' }}>· Last checked {new Date(lastRefreshedAt).toLocaleTimeString()}</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={refreshStatusFromStripe} disabled={refreshingStatus || !platformLocationId} style={{ ...S.btn, ...S.btnGhost }}>
                  {refreshingStatus ? '⟳ Checking…' : '↻ Refresh status'}
                </button>
                <button onClick={() => setShowRegister(true)} disabled={!platformLocationId} style={{ ...S.btn, ...S.btnPrim }}>
                  + Register network reader
                </button>
              </div>
            </div>
          </div>

          {/* Network readers */}
          <div style={{ marginBottom: 18 }}>
            <div style={S.label}>Network readers</div>
            {networkReaders.length === 0 ? (
              <div style={S.empty}>None registered yet — click "+ Register network reader" above to add one.</div>
            ) : (
              networkReaders.map(r => (
                <ReaderRow key={r.id} reader={r} onUnregister={() => onUnregister(r)} />
              ))
            )}
          </div>

          {/* Bluetooth readers */}
          <div>
            <div style={S.label}>Bluetooth readers (paired by POS terminals)</div>
            {bluetoothReaders.length === 0 ? (
              <div style={S.empty}>None paired yet — pair from each POS terminal's Status panel.</div>
            ) : (
              bluetoothReaders.map(r => (
                <ReaderRow key={r.id} reader={r} onUnregister={() => onUnregister(r)} />
              ))
            )}
          </div>
        </>
      )}

      {showRegister && platformLocationId && (
        <RegisterNetworkReaderModal
          locationId={platformLocationId}
          locationName={locationName}
          onClose={() => setShowRegister(false)}
          onRegistered={() => { setShowRegister(false); refresh(); }}
        />
      )}
    </div>
  );
}

function ReaderRow({ reader, onUnregister }) {
  const [expanded, setExpanded] = useState(false);
  const isOnline = reader.status === 'online';
  const isNetwork = reader.connection_kind === 'network';
  const lastSeen = reader.last_seen_at ? new Date(reader.last_seen_at) : null;
  const lastCheck = reader.last_status_check_at ? new Date(reader.last_status_check_at) : null;
  const lastSeenAge = lastSeen ? Math.floor((Date.now() - lastSeen.getTime()) / 60000) : null;       // minutes

  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--bg2)', marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>
              {reader.label || reader.serial_number || '(unnamed)'}
            </div>
            <span style={{ fontSize: 10, fontWeight: 700, color: isOnline ? 'var(--grn)' : 'var(--t4)' }}>
              ● {reader.status || 'unknown'}
            </span>
            {isNetwork && reader.ip_address && (
              <span style={{ fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg3)', padding: '2px 7px', borderRadius: 6 }}>
                {reader.ip_address}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--font-mono, monospace)', marginTop: 3, wordBreak: 'break-all' }}>
            {reader.stripe_reader_id}{reader.serial_number ? ` · ${reader.serial_number}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={S.pill}>{reader.device_type?.replace(/_/g, ' ') || 'reader'}</span>
            <span style={S.pill}>{reader.connection_kind}</span>
            {reader.firmware_version && <span style={S.pill}>fw {reader.firmware_version}</span>}
            {reader.bound_pos_device_id && <span style={S.pill}>POS: {reader.bound_pos_device_id.slice(0, 8)}</span>}
            {lastSeenAge !== null && (
              <span style={{ ...S.pill, background: lastSeenAge < 5 ? 'var(--grn-d)' : lastSeenAge < 60 ? 'var(--bg3)' : 'var(--red-d)', color: lastSeenAge < 5 ? 'var(--grn)' : lastSeenAge < 60 ? 'var(--t2)' : 'var(--red)' }}>
                seen {lastSeenAge < 1 ? 'just now' : lastSeenAge < 60 ? `${lastSeenAge}m ago` : lastSeenAge < 1440 ? `${Math.floor(lastSeenAge/60)}h ago` : `${Math.floor(lastSeenAge/1440)}d ago`}
              </span>
            )}
            <button onClick={() => setExpanded(e => !e)} style={{ ...S.btn, ...S.btnGhost, padding: '3px 8px', fontSize: 11 }}>
              {expanded ? 'Hide details' : 'Diagnostics'}
            </button>
          </div>
        </div>
        <button onClick={onUnregister} style={{ ...S.btn, ...S.btnDan, padding: '6px 10px', fontSize: 12 }}>
          Unregister
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--bdr)', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, fontSize: 11 }}>
          <DiagRow label="Stripe reader ID" value={reader.stripe_reader_id} mono/>
          <DiagRow label="Serial number" value={reader.serial_number || '—'} mono/>
          <DiagRow label="Device type" value={reader.device_type?.replace(/_/g,' ') || '—'}/>
          <DiagRow label="Connection" value={reader.connection_kind}/>
          {isNetwork && <DiagRow label="IP address" value={reader.ip_address || 'unknown'} mono/>}
          {!isNetwork && <DiagRow label="Bound POS device" value={reader.bound_pos_device_id || '—'} mono/>}
          <DiagRow label="Firmware" value={reader.firmware_version || 'unknown'} mono/>
          <DiagRow label="Status" value={reader.status || 'unknown'}/>
          <DiagRow label="Last seen by Stripe" value={lastSeen ? lastSeen.toLocaleString() : 'never'}/>
          <DiagRow label="Last status check" value={lastCheck ? lastCheck.toLocaleString() : 'never'}/>
          <DiagRow label="Registered" value={reader.created_at ? new Date(reader.created_at).toLocaleString() : '—'}/>
          {isNetwork && <DiagRow label="Pairing code" value={reader.registration_code || '—'} mono/>}

          {isNetwork && reader.ip_address && (
            <div style={{ gridColumn: 'span 2', marginTop: 8, padding: 10, background: 'var(--bg3)', borderRadius: 8, fontSize: 11, color: 'var(--t3)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--t1)' }}>Troubleshooting tips:</strong><br/>
              • Reader IP <code style={{ color: 'var(--acc)', fontFamily: 'var(--font-mono, monospace)' }}>{reader.ip_address}</code> should be on the same subnet as your Sunmi terminals.<br/>
              • Confirm the reader can reach <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>api.stripe.com</code> on port 443 (most network outages here are firewall rules).<br/>
              • If "Last seen" is more than 5 minutes ago, the reader has lost connectivity — power-cycle it or check WiFi.<br/>
              • Click <em>Refresh status</em> at the top to fetch a fresh snapshot from Stripe.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiagRow({ label, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--t1)', fontFamily: mono ? 'var(--font-mono, monospace)' : 'inherit', wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}

function RegisterNetworkReaderModal({ locationId, locationName, onClose, onRegistered }) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setError(null);
    if (!/^[a-z]+-[a-z]+-[a-z]+$/i.test(code.trim())) {
      setError('Pairing code must be three words separated by hyphens (e.g. golden-aroma-circle)');
      return;
    }
    setSubmitting(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('not authenticated');
      const res = await fetch(`${FUNCTIONS_URL}/stripe-register-network-reader`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ location_id: locationId, registration_code: code.trim(), label: label.trim() || undefined }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
      onRegistered();
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ ...S.card, width: 480, maxWidth: 'calc(100vw - 32px)', marginBottom: 0, boxShadow: 'var(--sh3)' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ ...S.h1, fontSize: 18, marginBottom: 4 }}>Register network reader</h2>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>
          to <strong style={{ color: 'var(--t1)' }}>{locationName}</strong>
        </div>

        <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.5, marginBottom: 16, padding: 12, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8 }}>
          <strong style={{ color: 'var(--t1)' }}>How to find the pairing code:</strong><br/>
          Power on the reader and connect it to WiFi. On the reader's screen, navigate to <em>Settings → Generate pairing code</em>. Enter the three-word code below before it expires (1 minute).
        </div>

        <label style={S.label}>Pairing code</label>
        <input type="text" value={code} onChange={e => setCode(e.target.value.toLowerCase())} placeholder="golden-aroma-circle" style={{ ...S.input, ...S.inputMono }} autoFocus />

        <div style={{ height: 12 }}/>
        <label style={S.label}>Label (optional)</label>
        <input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="Front counter, terrace, etc." style={S.input}/>

        {error && <div style={{ ...S.errorBox, marginTop: 14 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} disabled={submitting} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          <button onClick={submit} disabled={submitting || !code} style={{ ...S.btn, ...S.btnPrim }}>
            {submitting ? 'Registering…' : 'Register reader'}
          </button>
        </div>
      </div>
    </div>
  );
}
