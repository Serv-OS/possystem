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
  const [devices, setDevices] = useState([]);  // configured POS tills + kiosks to bind to
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // register form
  const [serial, setSerial] = useState('');
  const [name, setName] = useState('');
  const [posDevice, setPosDevice] = useState('');
  const [busy, setBusy] = useState(false);
  // v5.5.826: terminals that already exist AT RYFT (bought via their Portal, or
  // provisioned by their support). Those can't be registered again — POST would
  // reject the duplicate — so we adopt them instead.
  const [available, setAvailable] = useState(null);

  const load = async () => {
    setLoading(true); setError('');
    try {
      setState(await callTerminals('list', {}));
      // The configured tills/kiosks at this location (Ops DB) — same source the
      // Stripe reader assignment uses. Best-effort; binding is optional.
      try {
        const locId = await getActiveLocationSync();
        const { data: devs } = await supabase.from('devices')
          .select('id, name, type').eq('location_id', locId).in('type', ['pos', 'kiosk']).order('name', { ascending: true });
        setDevices(devs || []);
      } catch { /* devices optional */ }
    }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const deviceName = (id) => { const d = devices.find(x => x.id === id); return d ? `${d.name} (${d.type})` : null; };

  if (loading) return null;                                   // stay quiet until we know
  // v5.5.808: if the list call FAILED we don't know whether this is a Ryft venue
  // — never vanish silently (the owner pairing terminals would see only the
  // Stripe screen with zero clues). Show the error + a retry.
  if (!state) {
    if (!error) return null;
    return (
      <div style={S.card}>
        <div style={S.h2}>💳 Ryft card readers</div>
        <div style={S.err}>Couldn't load the Ryft terminal panel: {error}</div>
        <div style={{ marginTop: 12 }}>
          <button onClick={load} style={{ ...S.btn, ...S.btnGhost }}>↻ Retry</button>
        </div>
      </div>
    );
  }
  if (state.processor !== 'ryft') return null;                // invisible on non-Ryft venues

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
  const findExisting = async () => {
    setBusy(true); setError('');
    try { const r = await callTerminals('available', {}); setAvailable(r.terminals || []); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const adopt = async (terminalId) => {
    setBusy(true); setError('');
    try {
      await callTerminals('adopt', { terminal_id: terminalId, terminal_name: name || undefined, pos_device_id: posDevice || undefined });
      setName(''); setPosDevice(''); setAvailable(null);
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
                    <div style={{ fontSize:11, color:'var(--t3)' }}>{t.bound_pos_device_id ? `→ ${deviceName(t.bound_pos_device_id) || 'assigned till'}` : 'Any till'}</div>
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
              <label style={S.label}>Assign to a till / kiosk (optional)</label>
              <select value={posDevice} onChange={e => setPosDevice(e.target.value)} style={S.input}>
                <option value="">Available to any till at this location</option>
                {devices.map(d => <option key={d.id} value={d.id}>{d.name} ({d.type})</option>)}
              </select>
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>
                {devices.length
                  ? 'Bind this reader to one device, or leave it open to all tills here.'
                  : 'No tills or kiosks configured yet — pair the reader now and assign it later from Device setup.'}
              </div>
            </div>
            <div style={{ marginTop:14, display:'flex', gap:10, alignItems:'center' }}>
              <button onClick={register} disabled={busy || !serial.trim()} style={{ ...S.btn, ...S.btnPrim }}>{busy ? 'Pairing…' : 'Pair reader'}</button>
              <button onClick={load} disabled={busy} style={{ ...S.btn, ...S.btnGhost }}>↻ Refresh</button>
              <span style={{ fontSize:11, color:'var(--t4)' }}>The venue address from your onboarding is used automatically.</span>
            </div>

            {/* Already registered with Ryft? Adopt it rather than re-registering. */}
            <div style={{ marginTop:16, paddingTop:14, borderTop:'1px solid var(--bdr)' }}>
              <div style={{ fontSize:12, color:'var(--t3)', marginBottom:8 }}>
                Bought the reader through Ryft, or already registered it in their portal? It's on your Ryft
                account already — link it here instead of pairing it again.
              </div>
              <button onClick={findExisting} disabled={busy} style={{ ...S.btn, ...S.btnGhost }}>
                {busy ? 'Checking…' : 'Find readers on my Ryft account'}
              </button>

              {available && available.length === 0 && (
                <div style={{ fontSize:12, color:'var(--t4)', marginTop:10 }}>
                  No readers found on your Ryft account for this venue. If you expected one, check you're in the
                  same environment (sandbox vs live) as the device.
                </div>
              )}

              {available && available.length > 0 && (
                <div style={{ display:'flex', flexDirection:'column', gap:8, marginTop:10 }}>
                  {available.map(t => (
                    <div key={t.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 12px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:9 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>{t.name || 'Unnamed reader'}</div>
                        <div style={{ fontSize:11, color:'var(--t4)', fontFamily:'var(--font-mono,monospace)' }}>
                          S/N {t.serial_number || '—'} · {t.id}
                        </div>
                      </div>
                      {t.already_linked
                        ? <span style={{ fontSize:11, fontWeight:700, color:'var(--grn)' }}>✓ Linked</span>
                        : <button onClick={() => adopt(t.id)} disabled={busy} style={{ ...S.btn, ...S.btnPrim }}>Link this reader</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {error && <div style={S.err}>{error}</div>}
    </div>
  );
}
