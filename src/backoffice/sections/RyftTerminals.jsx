// src/backoffice/sections/RyftTerminals.jsx
// Pair / manage Ryft card readers (terminals) for this location. Self-contained
// and self-gating: renders nothing unless the location is on Ryft. Built ahead
// of hardware — the flow is ready; the live tap needs a physical Ryft terminal.

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../lib/supabase';

const S = {
  card:   { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:24, marginBottom:20 },
  h2:     { fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:4 },
  desc:   { fontSize:12, color:'var(--t4)', marginBottom:16, lineHeight:1.6 },
  label:  { fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.04em' },
  input:  { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  btn:    { padding:'9px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  btnPrim:{ background:'var(--acc)', color:'#0b0c10' },
  btnGhost:{ background:'transparent', color:'var(--t2)', border:'1px solid var(--bdr)' },
  btnDan: { background:'transparent', color:'var(--red)', border:'1px solid var(--red-b)' },
  err:    { padding:10, background:'var(--red-d)', color:'var(--red)', borderRadius:8, fontSize:12, border:'1px solid var(--red-b)', marginTop:10 },
  pill:   { fontSize:11, padding:'2px 8px', borderRadius:99, background:'var(--bg3)', color:'var(--t2)', textTransform:'uppercase', letterSpacing:'.05em', fontWeight:700, border:'1px solid var(--bdr)' },
};

async function callTerminals(action, payload) {
  const locId = await getActiveLocationSync();
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ryft-terminals`, {
    method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${token}` },
    body: JSON.stringify({ action, ops_location_id: locId, ...payload }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

export default function RyftTerminals() {
  const [state, setState] = useState(null);   // { processor, linked, terminals }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // register form
  const [serial, setSerial] = useState('');
  const [name, setName] = useState('');
  const [posDevice, setPosDevice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true); setError('');
    try { setState(await callTerminals('list', {})); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (loading) return null;                                   // stay quiet until we know
  if (!state || state.processor !== 'ryft') return null;      // invisible on non-Ryft venues

  const terminals = state.terminals || [];

  const register = async () => {
    setBusy(true); setError('');
    try {
      await callTerminals('register', { serial_number: serial.trim(), terminal_name: name || undefined, pos_device_id: posDevice || undefined });
      setSerial(''); setName(''); setPosDevice('');
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const remove = async (terminalId) => {
    if (!confirm('Remove this reader? It will be deregistered from Ryft.')) return;
    try { await callTerminals('unregister', { terminal_id: terminalId }); await load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div style={S.card}>
      <div style={S.h2}>💳 Ryft card readers</div>
      <div style={S.desc}>
        Pair a Ryft card reader to this location. Enter the serial number printed on the device (or from its shipping note) and it registers with Ryft, ready to take card-present payments.
      </div>

      {!state.linked ? (
        <div style={{ fontSize:13, color:'var(--t3)' }}>Set up card payments for this location first (Location Settings → Card payments), then pair your readers here.</div>
      ) : (
        <>
          {terminals.length > 0 && (
            <div style={{ border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden', marginBottom:16 }}>
              <div style={{ display:'grid', gridTemplateColumns:'1.3fr 1fr 1fr auto', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.04em', padding:'9px 14px', background:'var(--bg2)' }}>
                <div>Reader</div><div>Serial</div><div>Status</div><div></div>
              </div>
              {terminals.map(t => (
                <div key={t.id} style={{ display:'grid', gridTemplateColumns:'1.3fr 1fr 1fr auto', fontSize:13, padding:'10px 14px', borderTop:'1px solid var(--bdr)', alignItems:'center' }}>
                  <div>
                    <div style={{ color:'var(--t1)', fontWeight:600 }}>{t.label || 'Card reader'}</div>
                    <code style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono,monospace)' }}>{t.ryft_terminal_id}</code>
                  </div>
                  <div style={{ color:'var(--t2)', fontFamily:'var(--font-mono,monospace)', fontSize:12 }}>{t.serial_number || '—'}</div>
                  <div><span style={S.pill}>{t.status || 'registered'}</span></div>
                  <div style={{ textAlign:'right' }}><button onClick={() => remove(t.ryft_terminal_id)} style={{ ...S.btn, ...S.btnDan, padding:'5px 10px', fontSize:12 }}>Remove</button></div>
                </div>
              ))}
            </div>
          )}

          <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:10, padding:16 }}>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginBottom:12 }}>Pair a new reader</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <div>
                <label style={S.label}>Serial number</label>
                <input value={serial} onChange={e => setSerial(e.target.value)} placeholder="e.g. 25050808291100" style={{ ...S.input, fontFamily:'var(--font-mono,monospace)' }} />
              </div>
              <div>
                <label style={S.label}>Reader name (optional)</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Front till" style={S.input} />
              </div>
            </div>
            <div style={{ marginTop:12 }}>
              <label style={S.label}>Assign to POS device id (optional)</label>
              <input value={posDevice} onChange={e => setPosDevice(e.target.value)} placeholder="leave blank to make it available to any till" style={S.input} />
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>Bind a reader to a specific till, or leave blank so any till at this location can use it.</div>
            </div>
            <div style={{ marginTop:14, display:'flex', gap:10, alignItems:'center' }}>
              <button onClick={register} disabled={busy || !serial.trim()} style={{ ...S.btn, ...S.btnPrim }}>{busy ? 'Pairing…' : 'Pair reader'}</button>
              <button onClick={load} disabled={busy} style={{ ...S.btn, ...S.btnGhost }}>↻ Refresh</button>
              <span style={{ fontSize:11, color:'var(--t4)' }}>The venue address from your onboarding is used automatically.</span>
            </div>
          </div>
        </>
      )}

      {error && <div style={S.err}>{error}</div>}
    </div>
  );
}
