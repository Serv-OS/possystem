// src/backoffice/sections/PaxTerminals.jsx
//
// Pair a PAX card terminal (our own :paxpay app) to this location by claim code,
// and see whether it is online. Self-contained and self-gating, exactly like
// RyftTerminals — it renders nothing until it knows there is something to show.
//
// The terminal shows a code on its own screen; a manager types that code here.
// That is the whole pairing ceremony: the code is a capability you have to be
// physically standing in front of the device to read.
//
// SECURITY NOTE — nothing on this screen writes location_id. claim_terminal_device()
// is a SECURITY DEFINER RPC that validates the manager's access to the location and
// sets location_id itself. terminal_devices has no INSERT and no UPDATE policy at all.

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../lib/supabase';

const S = {
  card:    { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:24, marginBottom:20 },
  h2:      { fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:4 },
  desc:    { fontSize:12, color:'var(--t4)', marginBottom:16, lineHeight:1.6 },
  label:   { fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.04em' },
  input:   { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  btn:     { padding:'9px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  btnPrim: { background:'var(--acc)', color:'#0b0c10' },
  btnGhost:{ background:'transparent', color:'var(--t2)', border:'1px solid var(--bdr)' },
  btnDan:  { background:'transparent', color:'var(--red)', border:'1px solid var(--red-b)' },
  err:     { padding:10, background:'var(--red-d)', color:'var(--red)', borderRadius:8, fontSize:12, border:'1px solid var(--red-b)', marginTop:10 },
  ok:      { padding:10, background:'var(--bg2)', color:'var(--grn)', borderRadius:8, fontSize:12, border:'1px solid var(--bdr)', marginTop:10 },
  pill:    { fontSize:11, padding:'2px 8px', borderRadius:99, background:'var(--bg3)', color:'var(--t2)', textTransform:'uppercase', letterSpacing:'.05em', fontWeight:700, border:'1px solid var(--bdr)' },
  mono:    { fontFamily:'var(--font-mono, monospace)' },
};

/** Online if we've heard from it in the last two minutes (heartbeat is ~30s). */
function onlineState(lastSeenAt) {
  if (!lastSeenAt) return { online:false, text:'Never seen' };
  const age = Date.now() - new Date(lastSeenAt).getTime();
  if (age < 2 * 60_000) return { online:true, text:'Online' };
  const mins = Math.round(age / 60_000);
  if (mins < 60) return { online:false, text:`Last seen ${mins}m ago` };
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return { online:false, text:`Last seen ${hrs}h ago` };
  return { online:false, text:`Last seen ${new Date(lastSeenAt).toLocaleDateString()}` };
}

export default function PaxTerminals() {
  const [locationId, setLocationId] = useState(null);
  const [terminals, setTerminals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError('');
    try {
      const locId = getActiveLocationSync();
      if (!locId || locId === 'loc-demo') { setLoading(false); return; }
      setLocationId(locId);
      // RLS scopes this to the manager's own locations — no filter can widen it.
      const { data, error: e } = await supabase
        .from('terminal_devices')
        .select('id, label, serial_number, status, active, app_version, last_seen_at, claimed_at, bound_pos_device_id')
        .eq('location_id', locId)
        .neq('status', 'retired')
        .order('claimed_at', { ascending: false });
      if (e) throw new Error(e.message);
      setTerminals(data || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  // Heartbeats land every ~30s; refresh the "online" column so it isn't lying.
  useEffect(() => {
    const t = setInterval(() => { load(); }, 30_000);
    return () => clearInterval(t);
  }, []);

  const pair = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const { data, error: e } = await supabase.rpc('claim_terminal_device', {
        p_claim_code: code.trim(),
        p_location_id: locationId,      // validated server-side against user_locations
        p_label: label.trim() || null,
      });
      if (e) throw new Error(e.message);
      if (!data?.ok) throw new Error('Pairing did not complete — try the code again.');
      setCode(''); setLabel('');
      setNotice('Card terminal paired. It should show this venue within a few seconds.');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const retire = async (t) => {
    if (!confirm(`Unpair "${t.label || t.serial_number}"? It will stop accepting payments for this venue and will show a fresh pairing code.`)) return;
    setError('');
    try {
      // DELETE is the only policy on this table, and it is scoped to the
      // manager's own locations.
      const { error: e } = await supabase.from('terminal_devices').delete().eq('id', t.id);
      if (e) throw new Error(e.message);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (loading) return null;
  if (!locationId) return null;

  return (
    <div style={S.card}>
      <div style={S.h2}>🧾 PAX card terminals</div>
      <div style={S.desc}>
        Pair a PAX terminal running the ServOS payment app. The terminal shows a pairing code on its
        own screen — type it in below. Once paired it can pull an open table, take the whole bill and
        close it, and the POS can send a payment straight to it.
      </div>

      {terminals.length > 0 && (
        <div style={{ border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden', marginBottom:16 }}>
          <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr 1fr auto', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.04em', padding:'9px 14px', background:'var(--bg2)' }}>
            <div>Terminal</div><div>Serial</div><div>Status</div><div></div>
          </div>
          {terminals.map(t => {
            const st = onlineState(t.last_seen_at);
            return (
              <div key={t.id} style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr 1fr auto', fontSize:13, padding:'10px 14px', borderTop:'1px solid var(--bdr)', alignItems:'center' }}>
                <div>
                  <div style={{ color:'var(--t1)', fontWeight:600 }}>{t.label || 'Card terminal'}</div>
                  <div style={{ fontSize:11, color:'var(--t4)' }}>
                    {t.app_version ? `App ${t.app_version}` : 'Version unknown'}
                  </div>
                </div>
                <div style={{ ...S.mono, color:'var(--t2)', fontSize:12 }}>{t.serial_number || '—'}</div>
                <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                  <span style={{
                    width:8, height:8, borderRadius:'50%', flexShrink:0,
                    background: st.online ? 'var(--grn)' : 'var(--t4)',
                  }} />
                  <span style={{ fontSize:12, color: st.online ? 'var(--grn)' : 'var(--t3)' }}>{st.text}</span>
                </div>
                <div style={{ textAlign:'right' }}>
                  <button onClick={() => retire(t)} style={{ ...S.btn, ...S.btnDan, padding:'5px 10px', fontSize:12 }}>Unpair</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:10, padding:16 }}>
        <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginBottom:12 }}>Pair a terminal</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div>
            <label style={S.label}>Pairing code</label>
            <input
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter' && code.trim()) pair(); }}
              placeholder="e.g. 4F2A9C81BE"
              maxLength={16}
              style={{ ...S.input, ...S.mono, letterSpacing:'.12em' }}
            />
          </div>
          <div>
            <label style={S.label}>Name it (optional)</label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Handheld 1" style={S.input} />
          </div>
        </div>
        <div style={{ marginTop:14, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <button onClick={pair} disabled={busy || !code.trim()} style={{ ...S.btn, ...S.btnPrim }}>
            {busy ? 'Pairing…' : 'Pair terminal'}
          </button>
          <button onClick={load} disabled={busy} style={{ ...S.btn, ...S.btnGhost }}>↻ Refresh</button>
          <span style={{ fontSize:11, color:'var(--t4)' }}>
            Codes expire 30 minutes after the terminal was last online — restart it for a fresh one.
          </span>
        </div>
      </div>

      {notice && <div style={S.ok}>{notice}</div>}
      {error && <div style={S.err}>{error}</div>}
    </div>
  );
}
