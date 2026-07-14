// src/backoffice/sections/CardReaders.jsx
// Back office card-reader registry — SCOPED TO THE ACTIVE LOCATION.
//
// What lives here:
//   • Register network/WiFi readers (Stripe S700, WisePOS E) for THIS location
//     using Stripe's pairing-code flow.
//   • Read-only inventory of network readers serving this location.
//
// v5.5.58: Bluetooth support removed. Card readers are WiFi-only end-to-end —
// pairing, payments and tipping all run through the Stripe REST API on the
// reader's own screen. The Stripe Terminal SDK is no longer in the APK.
// Cross-location oversight lives in the super-admin app (?mode=admin).

import { useEffect, useState, useCallback } from 'react';
import { supabase, platformSupabase, getActiveLocationSync } from '../../lib/supabase';
import { resolvePlatformLocationId } from '../../lib/networkReader';
import { stripeCurrency } from '../../lib/currency';
import RyftTerminals from './RyftTerminals';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const S = {
  page:    { padding: '32px 40px', maxWidth: 1080 },
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 28, maxWidth: 720, lineHeight: 1.5 },
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
  const [opsLocationId, setOpsLocationId] = useState(null);
  const [locationName, setLocationName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [readers, setReaders] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [reassignReader, setReassignReader] = useState(null);

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
      setOpsLocationId(opsLocId);
      const platformId = await resolvePlatformLocationId(opsLocId);
      if (!platformId) {
        setError('This location is not registered for billing yet. Contact platform admin.');
        setLoading(false);
        return;
      }
      setPlatformLocationId(platformId);

      const [{ data: loc }, { data: rdrs }, { data: devs }] = await Promise.all([
        platformSupabase.from('locations').select('id, name, company_id').eq('id', platformId).maybeSingle(),
        platformSupabase.from('payment_devices')
          .select('id, stripe_reader_id, label, device_type, connection_kind, serial_number, status, last_seen_at, bound_pos_device_id, created_at, registration_code, ip_address, firmware_version, last_status_check_at, customer_display_enabled')
          .eq('location_id', platformId)
          .order('created_at', { ascending: false }),
        // Devices live in Ops DB. Pull POS + kiosk types only — those are what can take payments.
        supabase.from('devices')
          .select('id, name, type, status')
          .eq('location_id', opsLocId)
          .in('type', ['pos', 'kiosk'])
          .order('name', { ascending: true }),
      ]);
      setLocationName(loc?.name ?? '(unknown)');
      setReaders(rdrs ?? []);
      setDevices(devs ?? []);

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

  const onUnregister = async (rdr) => {
    if (!confirm(`Unregister "${rdr.label || rdr.serial_number}"? It will be removed from POSUP and from Stripe.`)) return;
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('not authenticated');
      const res = await fetch(`${FUNCTIONS_URL}/stripe-unregister-reader`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ reader_id: rdr.id }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
      refresh();
    } catch (e) {
      alert(`Unregister failed: ${e.message}`);
    }
  };

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Card readers</h1>
      <div style={S.sub}>
        Network readers (Stripe Reader S700, WisePOS E in WiFi mode) are registered here and serve all POS terminals at this location.
      </div>

      {/* Ryft terminals — self-gating: only renders when this location is on Ryft */}
      <RyftTerminals />

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
                  <span><strong style={{ color: 'var(--t1)' }}>{networkReaders.length}</strong> network reader{networkReaders.length === 1 ? '' : 's'}</span>
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
                <ReaderRow key={r.id} reader={r} devices={devices} platformLocationId={platformLocationId} onUnregister={() => onUnregister(r)} onReassign={() => setReassignReader(r)} />
              ))
            )}
          </div>

          {/* Reader settings — tipping + idle screen */}
          <ReaderSettingsPanel locationId={platformLocationId} />
        </>
      )}

      {showRegister && platformLocationId && (
        <RegisterNetworkReaderModal
          locationId={platformLocationId}
          locationName={locationName}
          devices={devices}
          onClose={() => setShowRegister(false)}
          onRegistered={() => { setShowRegister(false); refresh(); }}
        />
      )}

      {reassignReader && (
        <ReassignReaderModal
          reader={reassignReader}
          devices={devices}
          onClose={() => setReassignReader(null)}
          onSaved={() => { setReassignReader(null); refresh(); }}
        />
      )}
    </div>
  );
}

function ReaderRow({ reader, devices, onUnregister, onReassign, platformLocationId }) {
  const [expanded, setExpanded] = useState(false);
  const [forceCancelling, setForceCancelling] = useState(false);
  const [forceCancelResult, setForceCancelResult] = useState(null);
  // v5.5.188: per-reader customer display toggle
  const [displayEnabled, setDisplayEnabled] = useState(reader.customer_display_enabled !== false);
  const [displaySaving, setDisplaySaving] = useState(false);

  const handleDisplayToggle = async () => {
    const newVal = !displayEnabled;
    setDisplayEnabled(newVal); // optimistic
    setDisplaySaving(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('not authenticated');
      const res = await fetch(`${FUNCTIONS_URL}/stripe-assign-reader-to-pos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          reader_id: reader.id,
          pos_device_id: reader.bound_pos_device_id || null,
          customer_display_enabled: newVal,
        }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
    } catch (e) {
      setDisplayEnabled(!newVal); // revert
      alert(`Failed to update: ${e.message}`);
    } finally {
      setDisplaySaving(false);
    }
  };

  // v5.5.179: force-cancel any in-flight action on the reader. Calls
  // stripe-cancel-reader-action with reader_id only (no payment_intent_id)
  // so it just runs cancelAction + reset display. Useful when the reader
  // is stuck on a payment screen and the POS isn't around to cancel it.
  const forceCancel = async () => {
    if (!platformLocationId) { setForceCancelResult({ error: 'No platform location id' }); return; }
    if (!confirm(`Force-cancel any active payment on ${reader.label || reader.stripe_reader_id}? This will void the current transaction on the reader screen.`)) return;
    setForceCancelling(true); setForceCancelResult(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      const res = await fetch(`${FUNCTIONS_URL}/stripe-cancel-reader-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          reader_id: reader.stripe_reader_id,
          location_id: platformLocationId,
          currency: stripeCurrency(),
          // No payment_intent_id — server skips the PI.cancel step
        }),
      });
      const j = await res.json();
      setForceCancelResult(j);
    } catch (e) {
      setForceCancelResult({ error: e?.message || 'failed' });
    } finally {
      setForceCancelling(false);
    }
  };

  const isOnline = reader.status === 'online';
  const isNetwork = reader.connection_kind === 'network';
  const lastSeen = reader.last_seen_at ? new Date(reader.last_seen_at) : null;
  const lastCheck = reader.last_status_check_at ? new Date(reader.last_status_check_at) : null;
  const lastSeenAge = lastSeen ? Math.floor((Date.now() - lastSeen.getTime()) / 60000) : null;       // minutes

  const boundDevice = reader.bound_pos_device_id
    ? (devices ?? []).find(d => d.id === reader.bound_pos_device_id)
    : null;
  const boundLabel = reader.bound_pos_device_id
    ? (boundDevice ? `${boundDevice.name} (${boundDevice.type})` : `unknown device · ${reader.bound_pos_device_id.slice(0, 8)}`)
    : null;

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

          {/* Assigned-to display */}
          <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: boundLabel ? 'var(--acc-d)' : 'var(--bg3)', border: '1px solid', borderColor: boundLabel ? 'var(--acc-b)' : 'var(--bdr)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
              Assigned to
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: 'var(--t1)', fontWeight: boundLabel ? 700 : 400 }}>
                {boundLabel ?? (isNetwork ? 'Not assigned to any POS or kiosk yet' : 'Auto-bound to paired POS')}
              </div>
              {isNetwork && onReassign && (
                <button onClick={onReassign} style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: 11 }}>
                  {boundLabel ? 'Reassign' : 'Assign'}
                </button>
              )}
            </div>
          </div>

          {/* Customer display toggle */}
          <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: displayEnabled ? 'var(--bg3)' : 'var(--bg2)', border: '1px solid var(--bdr)', opacity: displaySaving ? 0.6 : 1, transition: 'opacity .2s' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: displaySaving ? 'wait' : 'pointer' }}>
              <div onClick={displaySaving ? undefined : handleDisplayToggle} style={{
                width: 38, height: 20, borderRadius: 10, position: 'relative', flexShrink: 0,
                background: displayEnabled ? 'var(--grn)' : 'var(--bg4)', transition: 'all .2s', cursor: displaySaving ? 'wait' : 'pointer',
              }}>
                <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: displayEnabled ? 20 : 2, transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.3)' }}/>
              </div>
              <div onClick={displaySaving ? undefined : handleDisplayToggle}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>Customer display</div>
                <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 1 }}>
                  {displayEnabled
                    ? 'Live cart items shown on reader screen as they\'re rung up'
                    : 'Reader screen stays idle — for table service where reader isn\'t customer-facing'}
                </div>
              </div>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={S.pill}>{reader.device_type?.replace(/_/g, ' ') || 'reader'}</span>
            <span style={S.pill}>{reader.connection_kind}</span>
            {reader.firmware_version && <span style={S.pill}>fw {reader.firmware_version}</span>}
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
        <div style={{ display:'flex', gap:6, flexDirection:'column', alignItems:'flex-end' }}>
          {isNetwork && (
            <button onClick={forceCancel} disabled={forceCancelling} style={{ ...S.btn, ...S.btnGhost, padding: '6px 10px', fontSize: 12, color:'var(--red, #c0392b)', borderColor:'var(--red, #c0392b)' }}>
              {forceCancelling ? '⟳ Cancelling…' : '⛔ Force cancel'}
            </button>
          )}
          <button onClick={onUnregister} style={{ ...S.btn, ...S.btnDan, padding: '6px 10px', fontSize: 12 }}>
            Unregister
          </button>
        </div>
      </div>
      {forceCancelResult && (
        <div style={{
          marginTop:10, padding:'8px 12px', borderRadius:8, fontSize:11,
          background: forceCancelResult.error || (forceCancelResult.errors?.length) ? 'var(--red-d, #fde0d6)' : 'var(--grn-d, #d4f5dc)',
          color: forceCancelResult.error || (forceCancelResult.errors?.length) ? 'var(--red, #c0392b)' : 'var(--grn, #1a6b3a)',
          fontFamily:'var(--font-mono, monospace)', wordBreak:'break-all',
        }}>
          {forceCancelResult.error
            ? `❌ ${forceCancelResult.error}`
            : forceCancelResult.diag
              ? `✓ pre: ${forceCancelResult.diag.pre_action_type || 'none'}/${forceCancelResult.diag.pre_action_status || 'idle'} → post: ${forceCancelResult.diag.post_action_status || 'idle'}${forceCancelResult.errors?.length ? ' · errors: ' + forceCancelResult.errors.join(', ') : ''}`
              : '✓ Reader cancel sent'}
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--bdr)', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, fontSize: 11 }}>
          <DiagRow label="Stripe reader ID" value={reader.stripe_reader_id} mono/>
          <DiagRow label="Serial number" value={reader.serial_number || '—'} mono/>
          <DiagRow label="Device type" value={reader.device_type?.replace(/_/g,' ') || '—'}/>
          <DiagRow label="Connection" value={reader.connection_kind}/>
          {isNetwork && <DiagRow label="IP address" value={reader.ip_address || 'unknown'} mono/>}
          <DiagRow label="Bound POS/kiosk" value={boundLabel || '—'}/>
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

function RegisterNetworkReaderModal({ locationId, locationName, devices, onClose, onRegistered }) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [boundDeviceId, setBoundDeviceId] = useState('');
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
        body: JSON.stringify({
          location_id: locationId,
          registration_code: code.trim(),
          label: label.trim() || undefined,
          bound_pos_device_id: boundDeviceId || undefined,
        }),
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

        <div style={{ height: 12 }}/>
        <label style={S.label}>Assign to POS or kiosk (optional — can do later)</label>
        <select value={boundDeviceId} onChange={e => setBoundDeviceId(e.target.value)} style={S.input}>
          <option value="">— Don't assign yet —</option>
          {(devices ?? []).map(d => (
            <option key={d.id} value={d.id}>{d.name} ({d.type})</option>
          ))}
        </select>
        {(devices ?? []).length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>
            No POS or kiosk devices found at this location. Pair a device first under <em>Devices</em>, then come back to assign this reader.
          </div>
        )}

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

function ReassignReaderModal({ reader, devices, onClose, onSaved }) {
  const [boundDeviceId, setBoundDeviceId] = useState(reader.bound_pos_device_id || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('not authenticated');
      const res = await fetch(`${FUNCTIONS_URL}/stripe-assign-reader-to-pos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          reader_id: reader.id,
          pos_device_id: boundDeviceId || null,
        }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
      onSaved();
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ ...S.card, width: 460, maxWidth: 'calc(100vw - 32px)', marginBottom: 0, boxShadow: 'var(--sh3)' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ ...S.h1, fontSize: 18, marginBottom: 4 }}>Assign reader</h2>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--t1)' }}>{reader.label || reader.serial_number}</strong>
        </div>

        <label style={S.label}>POS or kiosk</label>
        <select value={boundDeviceId} onChange={e => setBoundDeviceId(e.target.value)} style={S.input} autoFocus>
          <option value="">— Unassign (no device uses this reader) —</option>
          {(devices ?? []).map(d => (
            <option key={d.id} value={d.id}>{d.name} ({d.type})</option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6, lineHeight: 1.5 }}>
          The selected POS or kiosk will use this reader automatically when taking card payments.
          Other devices at this location will not see it as their default reader.
        </div>

        {error && <div style={{ ...S.errorBox, marginTop: 14 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} disabled={submitting} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={{ ...S.btn, ...S.btnPrim }}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Reader settings (tipping + idle screen) ────────────────────────────
function ReaderSettingsPanel({ locationId }) {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedNote, setSavedNote] = useState(null);

  // Local edit state
  const [tipEnabled, setTipEnabled] = useState(true);
  const [tipPcts, setTipPcts] = useState([15, 18, 20]);
  const [allowCustom, setAllowCustom] = useState(true);
  const [smartThreshold, setSmartThreshold] = useState('');

  // Screensaver state
  const [ssEnabled, setSsEnabled] = useState(false);
  const [ssFileId, setSsFileId] = useState(null);
  const [ssPreview, setSsPreview] = useState(null);   // data URL for preview
  const [ssUploading, setSsUploading] = useState(false);
  const [ssError, setSsError] = useState(null);
  const [ssNote, setSsNote] = useState(null);
  const [ssImageUrl, setSsImageUrl] = useState(null);   // viewable Storage URL (Stripe file ids aren't renderable)

  // ── Screensaver upload handler ──────────────────────────────────────
  const handleSsUpload = async (file) => {
    setSsError(null); setSsNote(null); setSsUploading(true);
    try {
      // Validate client-side
      const allowed = ['image/png', 'image/jpeg', 'image/jpg'];
      if (!allowed.includes(file.type)) {
        throw new Error(`Unsupported image type: ${file.type}. Use PNG or JPEG.`);
      }
      if (file.size > 512 * 1024) {
        throw new Error(`Image too large (${Math.round(file.size / 1024)} KB). Max 512 KB.`);
      }

      // Read file as base64
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          // Strip the "data:image/...;base64," prefix
          const b64 = dataUrl.split(',')[1];
          resolve(b64);
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });

      // Show local preview immediately
      const previewUrl = URL.createObjectURL(file);
      setSsPreview(previewUrl);

      // Call edge function
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('Not authenticated');

      const res = await fetch(`${FUNCTIONS_URL}/stripe-upload-reader-splashscreen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          location_id: locationId,
          image_base64: base64,
          mime_type: file.type,
          action: 'upload',
        }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);

      setSsFileId(j.file_id);
      setSsEnabled(true);
      // Also stash a VIEWABLE copy in Storage so the back office previews the real image on
      // reload (Stripe file objects aren't directly renderable). Best-effort — the Stripe upload
      // above is the source of truth for what the reader shows.
      try {
        const ext = file.type === 'image/png' ? 'png' : 'jpg';
        const path = `reader-idle/${locationId}.${ext}`;
        const { error: upErr } = await supabase.storage.from('receipt-assets').upload(path, file, { upsert: true, contentType: file.type });
        if (!upErr) { const { data: pub } = supabase.storage.from('receipt-assets').getPublicUrl(path); if (pub?.publicUrl) setSsImageUrl(`${pub.publicUrl}?t=${Date.now()}`); }
      } catch { /* preview-only; non-fatal */ }
      setSsNote(`Uploaded (${j.size_kb} KB) — tap "Save & sync to readers" to push to devices`);
    } catch (e) {
      setSsError(String(e?.message ?? e));
    } finally {
      setSsUploading(false);
    }
  };

  // ── Screensaver remove handler ──────────────────────────────────────
  const handleSsRemove = async () => {
    setSsError(null); setSsNote(null); setSsUploading(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('Not authenticated');

      const res = await fetch(`${FUNCTIONS_URL}/stripe-upload-reader-splashscreen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          location_id: locationId,
          action: 'remove',
        }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);

      setSsFileId(null);
      setSsPreview(null);
      setSsImageUrl(null);
      setSsEnabled(false);
      setSsNote('Screensaver removed — tap "Save & sync to readers" to update devices');
    } catch (e) {
      setSsError(String(e?.message ?? e));
    } finally {
      setSsUploading(false);
    }
  };

  useEffect(() => {
    if (!locationId || !platformSupabase) return;
    (async () => {
      const { data } = await platformSupabase.from('location_reader_settings')
        .select('*').eq('location_id', locationId).maybeSingle();
      if (data) {
        setSettings(data);
        setTipEnabled(data.tipping_enabled);
        setTipPcts(data.tip_percentages ?? [15, 18, 20]);
        setAllowCustom(data.allow_custom_tip);
        setSmartThreshold(data.smart_tip_threshold_minor != null ? String(data.smart_tip_threshold_minor / 100) : '');
        setSsEnabled(!!data.idle_screen_enabled);
        setSsFileId(data.idle_screen_file_id || null);
        setSsImageUrl(data.idle_screen_image_url || null);
        if (data.idle_screen_image_url) setSsPreview(data.idle_screen_image_url);   // show the real image on reload
      }
    })();
  }, [locationId]);

  const save = async () => {
    setSaving(true); setError(null); setSavedNote(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('not authenticated');

      // 1. Update our settings table directly via platform supabase
      const cleanedPcts = tipPcts.filter(p => Number.isFinite(p) && p > 0 && p < 100).slice(0, 5);
      const thresholdMinor = smartThreshold ? Math.round(Number(smartThreshold) * 100) : null;
      const { error: updErr } = await platformSupabase.from('location_reader_settings').update({
        tipping_enabled: tipEnabled,
        tip_percentages: cleanedPcts.length > 0 ? cleanedPcts : [15, 18, 20],
        allow_custom_tip: allowCustom,
        smart_tip_threshold_minor: thresholdMinor,
        idle_screen_enabled: ssEnabled,
        idle_screen_image_url: ssImageUrl,
      }).eq('location_id', locationId);
      if (updErr) throw updErr;

      // 2. Sync to Stripe Terminal Configuration
      const res = await fetch(`${FUNCTIONS_URL}/stripe-sync-location-reader-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ location_id: locationId }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);

      setSavedNote(`Settings synced — ${j.readers_updated}/${j.readers_total} readers updated`);
      if (j.reader_errors?.length > 0) {
        setSavedNote(prev => `${prev}. Some readers had errors: ${j.reader_errors.map(e => `${e.reader} (${e.error})`).join(', ')}`);
      }
      // Refresh local settings from DB
      const { data: refreshed } = await platformSupabase.from('location_reader_settings')
        .select('*').eq('location_id', locationId).maybeSingle();
      setSettings(refreshed);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return null;

  return (
    <div style={{ ...S.card, marginTop: 24 }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Reader settings</div>
      <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 16, lineHeight: 1.5 }}>
        Controls how the customer-facing reader behaves at this location. Saved settings sync to Stripe and apply to all readers here.
      </div>

      {/* Tipping toggle */}
      <div style={{ padding: 12, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={tipEnabled} onChange={e => setTipEnabled(e.target.checked)} style={{ width: 16, height: 16 }}/>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Enable tipping prompt on reader</div>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
              Customer sees tip percentage buttons before tapping their card. Disable for fast-casual / counter service where tipping isn't appropriate.
            </div>
          </div>
        </label>
      </div>

      {tipEnabled && (
        <div style={{ paddingLeft: 26 }}>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>Tip preset percentages (up to 5)</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {tipPcts.map((p, i) => (
                <input
                  key={i}
                  type="number"
                  value={p}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    setTipPcts(prev => prev.map((x, idx) => idx === i ? (Number.isFinite(v) ? v : 0) : x));
                  }}
                  style={{ ...S.input, width: 72, textAlign: 'center' }}
                  min={1} max={50}
                />
              ))}
              {tipPcts.length < 5 && (
                <button onClick={() => setTipPcts(prev => [...prev, 25])} style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: 12 }}>
                  + Add
                </button>
              )}
              {tipPcts.length > 1 && (
                <button onClick={() => setTipPcts(prev => prev.slice(0, -1))} style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: 12 }}>
                  − Remove last
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6 }}>
              Reader screen will show these as tap buttons. Common: 15 / 18 / 20.
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={allowCustom} onChange={e => setAllowCustom(e.target.checked)} style={{ width: 14, height: 14 }}/>
              <span style={{ fontSize: 12, color: 'var(--t1)' }}>Allow customer to enter a custom tip amount</span>
            </label>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>Smart-tip threshold (currency major units, optional)</label>
            <input
              type="number"
              value={smartThreshold}
              onChange={e => setSmartThreshold(e.target.value)}
              placeholder="e.g. 10"
              style={{ ...S.input, width: 160 }}
              step="0.01" min="0"
            />
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4, lineHeight: 1.4 }}>
              Below this amount, the reader shows fixed-amount tip suggestions (£1, £2, £3) instead of percentages. Leave blank to always use percentages.
            </div>
          </div>
        </div>
      )}

      {/* ── Screensaver / idle screen ──────────────────────────────── */}
      <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Idle screen / screensaver</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 14, lineHeight: 1.5 }}>
          Display a custom image on the reader screen when no payment is in progress. Great for branding, promotions, or a welcome message. Image must be PNG or JPEG, max 512 KB.
        </div>

        <div style={{ padding: 12, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={ssEnabled} onChange={e => setSsEnabled(e.target.checked)} style={{ width: 16, height: 16 }}/>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Enable idle screen image</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                {ssFileId
                  ? 'A screensaver image is uploaded. Toggle off to show the default Stripe screen.'
                  : 'Upload an image below to display when the reader is idle.'}
              </div>
            </div>
          </label>
        </div>

        {/* Upload / preview area */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Preview */}
          {(ssPreview || ssFileId) && (
            <div style={{
              width: 180, height: 108, borderRadius: 10, overflow: 'hidden',
              border: '2px solid var(--bdr2)', background: 'var(--bg3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              position: 'relative', flexShrink: 0,
            }}>
              {ssPreview ? (
                <img src={ssPreview} alt="Screensaver preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--t4)', textAlign: 'center', padding: 8 }}>
                  Image uploaded<br/><span style={{ fontSize: 10, fontFamily: 'var(--font-mono)' }}>{ssFileId}</span>
                </div>
              )}
              {ssFileId && (
                <div style={{
                  position: 'absolute', top: 4, right: 4, width: 8, height: 8,
                  borderRadius: '50%', background: ssEnabled ? 'var(--grn)' : 'var(--t4)',
                  border: '1.5px solid var(--bg1)',
                }} title={ssEnabled ? 'Active' : 'Disabled'}/>
              )}
            </div>
          )}

          {/* Upload controls */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '14px 16px', borderRadius: 10, cursor: ssUploading ? 'wait' : 'pointer',
              border: '2px dashed var(--bdr2)', background: 'var(--bg2)',
              color: 'var(--t2)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
              transition: 'all .15s',
            }}
            onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--acc)'; }}
            onDragLeave={e => { e.currentTarget.style.borderColor = 'var(--bdr2)'; }}
            onDrop={e => {
              e.preventDefault();
              e.currentTarget.style.borderColor = 'var(--bdr2)';
              const file = e.dataTransfer.files[0];
              if (file) handleSsUpload(file);
            }}>
              <input
                type="file"
                accept="image/png,image/jpeg"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleSsUpload(f); e.target.value = ''; }}
              />
              <span style={{ fontSize: 18 }}>{ssUploading ? '⏳' : '🖼️'}</span>
              {ssUploading ? 'Uploading to Stripe…' : ssFileId ? 'Replace image' : 'Choose image or drag & drop'}
            </label>

            {ssFileId && (
              <button
                onClick={handleSsRemove}
                disabled={ssUploading}
                style={{
                  marginTop: 8, padding: '6px 12px', borderRadius: 6, fontSize: 11,
                  fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                  background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)',
                }}>
                Remove image
              </button>
            )}

            {ssError && <div style={{ ...S.errorBox, marginTop: 8, fontSize: 12 }}>{ssError}</div>}
            {ssNote && (
              <div style={{ marginTop: 8, padding: 8, background: 'var(--grn-d)', color: 'var(--grn)', borderRadius: 6, fontSize: 11, border: '1px solid var(--grn-b, var(--grn))' }}>
                ✓ {ssNote}
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 10, lineHeight: 1.45 }}>
              Recommended: 1080 × 1920 pixels for WisePOS E / S700. PNG or JPEG, max 512 KB. After uploading, tap "Save & sync to readers" below to push it to your readers.
            </div>
          </div>
        </div>
      </div>

      {error && <div style={{ ...S.errorBox, marginTop: 14 }}>{error}</div>}
      {savedNote && (
        <div style={{ marginTop: 12, padding: 10, background: 'var(--grn-d)', color: 'var(--grn)', borderRadius: 8, fontSize: 12, border: '1px solid var(--grn-b, var(--grn))' }}>
          ✓ {savedNote}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <button onClick={save} disabled={saving} style={{ ...S.btn, ...S.btnPrim }}>
          {saving ? 'Saving…' : 'Save & sync to readers'}
        </button>
        {settings.stripe_configuration_synced_at && (
          <span style={{ fontSize: 11, color: 'var(--t4)' }}>
            Last synced {new Date(settings.stripe_configuration_synced_at).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}
