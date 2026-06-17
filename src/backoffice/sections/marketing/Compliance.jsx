// src/backoffice/sections/marketing/Compliance.jsx
//
// Marketing → Compliance (slice 8): manage the suppression list. STOP / unsubscribe / bounce /
// complaint are added automatically (and ENFORCED at send time by marketing-send); this screen lets
// an operator review them, add a manual block, or remove one (e.g. a mistaken hard-bounce). Customers
// manage their own channel opt-ins via the preference centre linked in every marketing email.

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 820 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  input: { boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '6px 11px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  pill: { display: 'inline-block', padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t2)' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderTop: '1px solid var(--bdr2)' },
  err: { fontSize: 12, color: 'var(--red)' },
};

export default function Compliance() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState([]);
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('');
  const [add, setAdd] = useState({ channel: 'email', address: '' });
  const [msg, setMsg] = useState({});

  const call = (action, extra = {}) => supabase.functions.invoke('marketing-compliance', { body: { action, ops_location_id: locId, ...extra } })
    .then(({ data, error }) => { if (error) throw new Error(error.message); if (data?.error) throw new Error(data.error); return data; });

  const load = async (id = locId, f = {}) => {
    const { data } = await supabase.functions.invoke('marketing-compliance', { body: { action: 'list_suppressions', ops_location_id: id, channel: f.channel ?? channel ?? undefined, search: f.search ?? search ?? undefined } });
    setList(data?.suppressions || []);
  };

  useEffect(() => {
    (async () => { try { const id = await getActiveLocationSync(); setLocId(id); if (!supabase || !id) { setLoading(false); return; } await load(id); } catch {} finally { setLoading(false); } })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doAdd = async () => {
    if (!add.address.trim()) return;
    setMsg({ busy: true });
    try { await call('add_suppression', { channel: add.channel, address: add.address.trim(), reason: 'manual' }); setAdd({ ...add, address: '' }); setMsg({ ok: 'Added' }); setTimeout(() => setMsg({}), 1500); await load(); }
    catch (e) { setMsg({ err: e.message }); }
  };
  const remove = async (s) => { if (!window.confirm(`Remove the block on ${s.address}? They may receive marketing again.`)) return; try { await call('remove_suppression', { id: s.id }); await load(); } catch (e) { alert(e.message); } };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to manage compliance.</div>;

  return (
    <div>
      <h1 style={S.h1}>Compliance</h1>
      <div style={S.sub}>The suppression list — addresses that must never receive marketing. STOP replies, unsubscribes, hard bounces and spam complaints are added here automatically and blocked at send time. Customers manage their own channel preferences via the link in every email.</div>

      <div style={S.card}>
        <h2 style={S.h2}>Add a manual block</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select style={{ ...S.input, width: 'auto' }} value={add.channel} onChange={(e) => setAdd({ ...add, channel: e.target.value })}><option value="email">Email</option><option value="sms">SMS</option></select>
          <input style={{ ...S.input, flex: 1, minWidth: 220 }} value={add.address} onChange={(e) => setAdd({ ...add, address: e.target.value })} placeholder={add.channel === 'email' ? 'name@example.com' : '+447…'} onKeyDown={(e) => e.key === 'Enter' && doAdd()} />
          <button style={S.btn} onClick={doAdd} disabled={msg.busy || !add.address.trim()}>{msg.busy ? 'Adding…' : 'Block'}</button>
          {msg.ok && <span style={{ fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 }}>{msg.ok}</span>}
          {msg.err && <span style={S.err}>{msg.err}</span>}
        </div>
      </div>

      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <h2 style={{ ...S.h2, margin: 0 }}>Suppression list</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <select style={{ ...S.input, width: 'auto' }} value={channel} onChange={(e) => { setChannel(e.target.value); load(locId, { channel: e.target.value }); }}><option value="">All channels</option><option value="email">Email</option><option value="sms">SMS</option></select>
            <input style={{ ...S.input, width: 200 }} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(locId, { search })} placeholder="Search address…" />
          </div>
        </div>
        {list.length === 0 ? <div style={{ fontSize: 13, color: 'var(--t4)', padding: '10px 0' }}>No suppressed addresses.</div> : list.map((s) => (
          <div key={s.id} style={S.row}>
            <div style={{ minWidth: 0 }}>
              <span style={{ fontSize: 13.5, color: 'var(--t1)', fontFamily: 'var(--font-mono,monospace)' }}>{s.address}</span>
              <span style={{ ...S.pill, marginLeft: 8 }}>{s.channel}</span>
              <span style={{ ...S.pill, marginLeft: 6 }}>{s.reason}</span>
              <span style={{ fontSize: 11.5, color: 'var(--t4)', marginLeft: 8 }}>{new Date(s.created_at).toLocaleDateString('en-GB')}{s.source ? ` · ${s.source}` : ''}</span>
            </div>
            <button style={S.ghost} onClick={() => remove(s)}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}
