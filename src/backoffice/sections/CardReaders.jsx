// src/backoffice/sections/CardReaders.jsx
// Back office card-reader registry.
//
// Two concerns from BO:
//   1. NETWORK READERS (S700, WisePOS E in WiFi mode): registered HERE using
//      Stripe's pairing-code flow. Belongs in BO because one network reader
//      can serve multiple POS terminals at the same location.
//   2. ALL READERS overview: BT readers paired by individual POS terminals
//      surface here read-only so admins can see "what's where" across the
//      whole platform without having to walk around each terminal.
//
// Bluetooth pairing itself happens in the POS Status drawer — that's the
// physical device's responsibility.

import { useEffect, useState, useCallback } from 'react';
import { supabase, platformSupabase } from '../../lib/supabase';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const S = {
  page:    { padding: 0 },
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 24, maxWidth: 700, lineHeight: 1.5 },
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
};

export default function CardReaders({ authUser }) {
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [readers, setReaders] = useState([]);
  const [filterCompanyId, setFilterCompanyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [registerModalLoc, setRegisterModalLoc] = useState(null);

  const refresh = useCallback(async () => {
    if (!platformSupabase) {
      setError('Platform Supabase not configured');
      setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    try {
      const [{ data: cos }, { data: locs }, { data: rdrs }] = await Promise.all([
        platformSupabase.from('companies').select('id, name').order('name'),
        platformSupabase.from('locations').select('id, name, company_id').order('name'),
        platformSupabase.from('payment_devices')
          .select('id, location_id, stripe_reader_id, label, device_type, connection_kind, serial_number, status, last_seen_at, bound_pos_device_id, created_at, registration_code')
          .order('created_at', { ascending: false }),
      ]);
      setCompanies(cos ?? []);
      setLocations(locs ?? []);
      setReaders(rdrs ?? []);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const filteredLocations = filterCompanyId ? locations.filter(l => l.company_id === filterCompanyId) : locations;
  const companyName = (id) => companies.find(c => c.id === id)?.name ?? '(unknown)';
  const readersByLocation = (locId) => readers.filter(r => r.location_id === locId);

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Card readers</h1>
      <div style={S.sub}>
        Network readers (Stripe Reader S700, WisePOS E in WiFi mode) are registered here per location and serve all POS terminals at that location.
        Bluetooth readers (Stripe Reader M2) are paired at each POS terminal individually — they appear here read-only.
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={filterCompanyId} onChange={e => setFilterCompanyId(e.target.value)} style={{ ...S.input, width: 320 }}>
          <option value="">All companies ({companies.length})</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={refresh} disabled={loading} style={{ ...S.btn, ...S.btnGhost }}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
          {readers.length} reader{readers.length === 1 ? '' : 's'} across {filteredLocations.length} location{filteredLocations.length === 1 ? '' : 's'}
        </div>
      </div>

      {error && <div style={S.errorBox}>{error}</div>}

      {filteredLocations.map((loc) => (
        <LocationBlock
          key={loc.id}
          location={loc}
          companyName={companyName(loc.company_id)}
          readers={readersByLocation(loc.id)}
          onRegisterClick={() => setRegisterModalLoc(loc)}
          onUnregister={async (rdr) => {
            if (!confirm(`Unregister "${rdr.label || rdr.serial_number}"? It will be removed from POSUP only — you will need to delete it from the Stripe dashboard separately.`)) return;
            const { error } = await platformSupabase.from('payment_devices').delete().eq('id', rdr.id);
            if (error) alert(`Failed: ${error.message}`); else refresh();
          }}
        />
      ))}

      {registerModalLoc && (
        <RegisterNetworkReaderModal
          location={registerModalLoc}
          onClose={() => setRegisterModalLoc(null)}
          onRegistered={() => { setRegisterModalLoc(null); refresh(); }}
        />
      )}
    </div>
  );
}

function LocationBlock({ location, companyName, readers, onRegisterClick, onUnregister }) {
  const networkReaders = readers.filter(r => r.connection_kind === 'network');
  const bluetoothReaders = readers.filter(r => r.connection_kind === 'bluetooth');
  return (
    <div style={S.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--acc)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
            {companyName}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)' }}>{location.name}</div>
          <div style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--font-mono, monospace)' }}>{location.id}</div>
        </div>
        <button onClick={onRegisterClick} style={{ ...S.btn, ...S.btnPrim }}>+ Register network reader</button>
      </div>

      {/* Network readers */}
      <div style={{ marginBottom: 12 }}>
        <div style={S.label}>Network readers ({networkReaders.length})</div>
        {networkReaders.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--t4)', padding: '8px 0' }}>None registered yet</div>
        ) : (
          networkReaders.map(r => (
            <ReaderRow key={r.id} reader={r} onUnregister={() => onUnregister(r)}/>
          ))
        )}
      </div>

      {/* Bluetooth readers */}
      <div>
        <div style={S.label}>Bluetooth readers ({bluetoothReaders.length})</div>
        {bluetoothReaders.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--t4)', padding: '8px 0' }}>None paired — pair at each POS terminal's Status panel</div>
        ) : (
          bluetoothReaders.map(r => <ReaderRow key={r.id} reader={r} onUnregister={() => onUnregister(r)}/>)
        )}
      </div>
    </div>
  );
}

function ReaderRow({ reader, onUnregister }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--bg2)', marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{reader.label || reader.serial_number}</div>
          <div style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--font-mono, monospace)', marginTop: 2 }}>
            {reader.stripe_reader_id} · {reader.serial_number || 'no serial'}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={S.pill}>{reader.device_type?.replace(/_/g,' ')}</span>
            <span style={S.pill}>{reader.connection_kind}</span>
            <span style={S.pill}>{reader.status || 'unknown'}</span>
            {reader.bound_pos_device_id && <span style={S.pill}>POS: {reader.bound_pos_device_id.slice(0, 8)}</span>}
          </div>
        </div>
        <button onClick={onUnregister} style={{ ...S.btn, ...S.btnDan, padding: '6px 10px', fontSize: 12 }}>
          Unregister
        </button>
      </div>
    </div>
  );
}

function RegisterNetworkReaderModal({ location, onClose, onRegistered }) {
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
        body: JSON.stringify({
          location_id: location.id,
          registration_code: code.trim(),
          label: label.trim() || undefined,
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
          to <strong style={{ color: 'var(--t1)' }}>{location.name}</strong>
        </div>

        <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.5, marginBottom: 16, padding: 12, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8 }}>
          <strong style={{ color: 'var(--t1)' }}>How to find the pairing code:</strong><br/>
          Power on the reader and connect it to WiFi. On the reader's screen, navigate to <em>Settings → Generate pairing code</em>. Enter the three-word code below before it expires (1 minute).
        </div>

        <label style={S.label}>Pairing code</label>
        <input type="text" value={code} onChange={e => setCode(e.target.value.toLowerCase())} placeholder="golden-aroma-circle" style={{ ...S.input, ...S.inputMono }} autoFocus/>

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
