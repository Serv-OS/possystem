// PrintAgentKeys: database fence stage 1, contract G3.
//
// A LAN print agent (print-agent.js, rpos-print-agent.js) used to read and write print_jobs with
// the bare public key. The fence closes that table to it, so each agent gets a key issued here,
// for this venue only. The key is shown ONCE (the server keeps only its hash). This browser
// remembers the ids and labels of the keys it issued (never the keys) so they can be revoked
// from here: there is no list function in the database, on purpose.
import { useEffect, useState } from 'react';
import { supabase, getLocationId } from '../../lib/supabase';
import { isMissingRpc } from '../../lib/deviceFence';

const storeKey = (loc) => `rpos-print-agent-keys:${loc}`;
const readIssued = (loc) => { try { return JSON.parse(localStorage.getItem(storeKey(loc)) || '[]'); } catch { return []; } };
const writeIssued = (loc, list) => { try { localStorage.setItem(storeKey(loc), JSON.stringify(list)); } catch { /* quota */ } };

export default function PrintAgentKeys({ S = {} }) {
  const [loc, setLoc] = useState(null);
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState([]);
  const [shown, setShown] = useState(null);     // { id, token } just issued
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getLocationId().then((l) => { if (l && l !== 'loc-demo') { setLoc(l); setIssued(readIssued(l)); } }).catch(() => {});
  }, []);

  const issue = async () => {
    if (!loc || busy) return;
    setBusy(true); setMsg(''); setShown(null);
    try {
      const { data, error } = await supabase.rpc('issue_print_agent_token', { p_location_id: loc, p_label: label.trim() || null });
      if (error) {
        setMsg(isMissingRpc(error) ? 'Print agent keys are available once the database update (20260919a) has run.' : (error.message || 'Could not issue a key.'));
        return;
      }
      if (!data?.ok || !data.token) { setMsg('Could not issue a key.'); return; }
      const next = [{ id: data.id, label: label.trim() || 'Print agent', issuedAt: new Date().toISOString() }, ...issued];
      setIssued(next); writeIssued(loc, next);
      setShown({ id: data.id, token: data.token });
      setLabel('');
    } finally { setBusy(false); }
  };

  const revoke = async (row) => {
    if (!window.confirm(`Revoke the key "${row.label}"? The agent using it stops printing until it gets a new key.`)) return;
    const { data, error } = await supabase.rpc('revoke_print_agent_token', { p_token_id: row.id });
    if (error) { setMsg(error.message || 'Could not revoke the key.'); return; }
    if (data && data.ok === false && data.reason !== 'not_found') { setMsg('Could not revoke the key.'); return; }
    const next = issued.filter((r) => r.id !== row.id);
    setIssued(next); writeIssued(loc, next);
    if (shown?.id === row.id) setShown(null);
  };

  const copy = async () => { try { await navigator.clipboard.writeText(shown.token); setMsg('Key copied.'); } catch { /* select it by hand */ } };

  return (
    <>
      <div style={S.h2}>Print agent key</div>
      <div style={{ padding:'0 14px 14px' }}>
        <div style={{ fontSize:12, color:'var(--t3)', lineHeight:1.5, marginBottom:8 }}>
          Only for a computer running the print agent. Tills need nothing here.
        </div>
        <input style={S.input} value={label} placeholder="Name, e.g. Kitchen PC" onChange={(e) => setLabel(e.target.value)} />
        <button onClick={issue} disabled={!loc || busy}
          style={{ marginTop:8, width:'100%', padding:'8px 10px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--acc)', color:'#fff', fontWeight:700, fontSize:12, cursor: (!loc || busy) ? 'default' : 'pointer', fontFamily:'inherit' }}>
          {busy ? 'Issuing…' : 'Issue a print agent key'}
        </button>
        {shown && (
          <div style={{ marginTop:10, padding:10, borderRadius:8, border:'1px solid var(--acc-b, var(--bdr))', background:'var(--acc-d, var(--bg2))' }}>
            <div style={{ fontSize:11, color:'var(--t3)', marginBottom:4 }}>Shown once. Put it in print-agent.env as PRINT_AGENT_TOKEN.</div>
            <div style={{ fontFamily:'monospace', fontSize:11, wordBreak:'break-all', color:'var(--t1)' }}>{shown.token}</div>
            <button onClick={copy} style={{ marginTop:6, padding:'4px 10px', borderRadius:6, border:'1px solid var(--bdr)', background:'var(--bg1)', color:'var(--t1)', fontSize:11, cursor:'pointer', fontFamily:'inherit' }}>Copy</button>
          </div>
        )}
        {issued.length > 0 && (
          <div style={{ marginTop:10 }}>
            {issued.map((r) => (
              <div key={r.id} style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'var(--t2)', padding:'4px 0' }}>
                <span style={{ flex:1 }}>{r.label}</span>
                <button onClick={() => revoke(r)} style={{ padding:'2px 8px', borderRadius:6, border:'1px solid var(--bdr)', background:'transparent', color:'#ef4444', fontSize:11, cursor:'pointer', fontFamily:'inherit' }}>Revoke</button>
              </div>
            ))}
          </div>
        )}
        {msg && <div style={{ marginTop:8, fontSize:12, color:'var(--t3)' }}>{msg}</div>}
      </div>
    </>
  );
}
