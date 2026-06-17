// src/backoffice/sections/marketing/SendingDomain.jsx
//
// Settings → Email domain: connect a venue's own domain so email (marketing + receipts) sends from a
// branded, authenticated address instead of the shared serv-os.app sender — better deliverability +
// brand trust. Add domain → add the shown DNS records → Verify → set From → Make active. Until a domain
// is verified + active, everything safely falls back to the platform sender. All via marketing-domains.

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18, maxWidth: 760, lineHeight: 1.5 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 820 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 4px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  field: { marginBottom: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12, color: 'var(--red)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  pill: { display: 'inline-block', padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 800, marginLeft: 8 },
  th: { textAlign: 'left', fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '6px 8px', borderBottom: '1px solid var(--bdr)' },
  td: { fontSize: 12, color: 'var(--t1)', padding: '7px 8px', borderBottom: '1px solid var(--bdr2)', fontFamily: 'var(--font-mono,monospace)', wordBreak: 'break-all' },
  copy: { padding: '2px 7px', borderRadius: 6, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontSize: 11, fontWeight: 700 },
};
const STATUS = {
  verified: ['Verified', 'var(--grn)', 'var(--grn-d, rgba(0,150,0,.12))'],
  pending: ['Pending', 'var(--amber,#d98a00)', 'rgba(217,138,0,.12)'],
  not_started: ['Not started', 'var(--t3)', 'var(--bg2)'],
  partially_verified: ['Partial', 'var(--amber,#d98a00)', 'rgba(217,138,0,.12)'],
  partially_failed: ['Partial fail', 'var(--red)', 'var(--red-d,rgba(200,0,0,.12))'],
  temporary_failure: ['DNS changed', 'var(--red)', 'var(--red-d,rgba(200,0,0,.12))'],
  failed: ['Failed', 'var(--red)', 'var(--red-d,rgba(200,0,0,.12))'],
};

export default function SendingDomain() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [domains, setDomains] = useState([]);
  const [newDomain, setNewDomain] = useState('');
  const [busy, setBusy] = useState('');     // action in flight
  const [msg, setMsg] = useState({});       // { [id|'add']: text }
  const [edit, setEdit] = useState({});     // per-domain { from_name, from_address, reply_to }
  const [test, setTest] = useState({});     // per-domain test email

  const call = (action, extra = {}) => supabase.functions.invoke('marketing-domains', { body: { action, ops_location_id: locId, ...extra } })
    .then(({ data, error }) => { if (error) throw new Error(error.message); if (data?.error) throw new Error(data.error); return data; });

  const load = async (id = locId) => {
    const { data } = await supabase.functions.invoke('marketing-domains', { body: { action: 'list_domains', ops_location_id: id } });
    setDomains(data?.domains || []);
  };
  useEffect(() => {
    (async () => { try { const id = await getActiveLocationSync(); setLocId(id); if (!supabase || !id) { setLoading(false); return; } await load(id); } catch {} finally { setLoading(false); } })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async () => {
    if (!newDomain.trim()) return;
    setBusy('add'); setMsg({});
    try { await call('add_domain', { domain: newDomain.trim() }); setNewDomain(''); await load(); }
    catch (e) { setMsg({ add: e.message }); } finally { setBusy(''); }
  };
  const act = async (id, action, extra) => {
    setBusy(id + action); setMsg((m) => ({ ...m, [id]: '' }));
    try { const d = await call(action, { id, ...extra }); await load(); return d; }
    catch (e) { setMsg((m) => ({ ...m, [id]: e.message })); } finally { setBusy(''); }
  };
  const copy = (t) => { try { navigator.clipboard.writeText(t); } catch {} };
  const sendTest = async (d) => {
    const to = (test[d.id] || '').trim();
    if (!to) { setMsg((m) => ({ ...m, [d.id]: 'Enter a test email' })); return; }
    setBusy(d.id + 'test');
    try {
      const { data, error } = await supabase.functions.invoke('marketing-send', { body: { action: 'send', ops_location_id: locId, channel: 'email', to: { email: to }, subject: 'Test from your branded domain', html: '<p>This is a test — it should arrive from your own domain.</p>', bypass_consent: true } });
      if (error) throw new Error(error.message);
      setMsg((m) => ({ ...m, [d.id]: `Test → ${data?.status || 'ok'}` }));
    } catch (e) { setMsg((m) => ({ ...m, [d.id]: e.message })); } finally { setBusy(''); }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to set up your sending domain.</div>;

  return (
    <div>
      <h1 style={S.h1}>Email domain</h1>
      <div style={S.sub}>Send email from your own domain (e.g. <code>hello@mail.yourvenue.com</code>) instead of the shared sender. This improves deliverability and means customers see <i>your</i> brand. You'll add a few DNS records at your domain registrar. Until a domain is verified &amp; active, email keeps sending from the default address.</div>

      {domains.map((d) => {
        const st = STATUS[d.status] || STATUS.not_started;
        const e = edit[d.id] || { from_name: d.from_name || '', from_address: d.from_address || `hello@${d.domain}`, reply_to: d.reply_to || '' };
        const recs = Array.isArray(d.dns_records) ? d.dns_records : [];
        return (
          <div key={d.id} style={S.card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <h2 style={S.h2}>{d.domain}
                <span style={{ ...S.pill, color: st[1], background: st[2] }}>{st[0]}</span>
                {d.is_active && <span style={{ ...S.pill, color: 'var(--acc)', background: 'var(--bg2)' }}>ACTIVE</span>}
              </h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={S.ghost} onClick={() => act(d.id, 'verify_domain')} disabled={busy === d.id + 'verify_domain'}>{busy === d.id + 'verify_domain' ? 'Checking…' : 'Verify / refresh'}</button>
                <button style={{ ...S.ghost, color: 'var(--red)' }} onClick={() => { if (window.confirm(`Remove ${d.domain}?`)) act(d.id, 'delete_domain'); }}>Remove</button>
              </div>
            </div>

            {d.status !== 'verified' && (
              <div style={{ marginTop: 10 }}>
                <div style={S.hint}>Add these records in your DNS, then click <b>Verify</b>. Paste the <b>Name/Host exactly as shown — do not add your domain after it</b> (most registrars append it automatically). DNS usually takes ~15 minutes.</div>
                {recs.length > 0 ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
                    <thead><tr><th style={S.th}>Type</th><th style={S.th}>Name / Host</th><th style={S.th}>Value</th><th style={{ ...S.th, textAlign: 'right' }}>Status</th></tr></thead>
                    <tbody>
                      {recs.map((r, i) => (
                        <tr key={i}>
                          <td style={S.td}>{r.type}{r.priority != null ? ` (pri ${r.priority})` : ''}</td>
                          <td style={S.td}>{r.name} <button style={S.copy} onClick={() => copy(r.name)}>copy</button></td>
                          <td style={S.td}>{r.value} <button style={S.copy} onClick={() => copy(r.value)}>copy</button></td>
                          <td style={{ ...S.td, textAlign: 'right', color: r.status === 'verified' ? 'var(--grn)' : 'var(--t3)' }}>{r.status || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <div style={{ ...S.hint, marginTop: 8 }}>No DNS records yet — try Verify / refresh.</div>}
                <div style={{ ...S.hint, marginTop: 8 }}>Recommended: also add a DMARC record (<code>_dmarc</code> → <code>v=DMARC1; p=none; rua=mailto:you@yourvenue.com</code>) for best inbox placement.</div>
              </div>
            )}

            {d.status === 'verified' && (
              <div style={{ marginTop: 12 }}>
                <div style={S.row2}>
                  <div style={S.field}><label style={S.label}>From name</label><input style={S.input} value={e.from_name} onChange={(ev) => setEdit((x) => ({ ...x, [d.id]: { ...e, from_name: ev.target.value } }))} placeholder="The Fox Inn" /></div>
                  <div style={S.field}><label style={S.label}>From address</label><input style={S.input} value={e.from_address} onChange={(ev) => setEdit((x) => ({ ...x, [d.id]: { ...e, from_address: ev.target.value } }))} placeholder={`hello@${d.domain}`} /></div>
                </div>
                <div style={S.field}><label style={S.label}>Reply-to <span style={{ color: 'var(--t4)', fontWeight: 500 }}>(a monitored inbox — replies go here)</span></label><input style={S.input} value={e.reply_to} onChange={(ev) => setEdit((x) => ({ ...x, [d.id]: { ...e, reply_to: ev.target.value } }))} placeholder="bookings@yourvenue.com" /></div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button style={S.btn} onClick={() => act(d.id, 'set_from', { from_name: e.from_name, from_address: e.from_address, reply_to: e.reply_to })} disabled={busy === d.id + 'set_from'}>Save From</button>
                  {!d.is_active && <button style={S.ghost} onClick={() => act(d.id, 'set_active', { active: true })}>Make active</button>}
                  {d.is_active && <button style={S.ghost} onClick={() => act(d.id, 'set_active', { active: false })}>Deactivate</button>}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                  <input style={{ ...S.input, maxWidth: 240 }} value={test[d.id] || ''} onChange={(ev) => setTest((t) => ({ ...t, [d.id]: ev.target.value }))} placeholder="you@example.com" />
                  <button style={S.ghost} onClick={() => sendTest(d)} disabled={busy === d.id + 'test'}>{busy === d.id + 'test' ? 'Sending…' : 'Send test'}</button>
                </div>
              </div>
            )}
            {msg[d.id] && <div style={{ ...(/(→|sent|ok)/i.test(msg[d.id]) ? S.ok : S.err), marginTop: 10 }}>{msg[d.id]}</div>}
          </div>
        );
      })}

      <div style={S.card}>
        <h2 style={S.h2}>{domains.length ? 'Add another domain' : 'Connect your domain'}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <input style={{ ...S.input, maxWidth: 320 }} value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="mail.yourvenue.com" onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button style={S.btn} onClick={add} disabled={busy === 'add' || !newDomain.trim()}>{busy === 'add' ? 'Adding…' : 'Add domain'}</button>
        </div>
        <div style={S.hint}>Use a <b>subdomain</b> like <code>mail.yourvenue.com</code> (recommended — protects your main domain and won't clash with your existing email).</div>
        {msg.add && <div style={{ ...S.err, marginTop: 8 }}>{msg.add}</div>}
      </div>
    </div>
  );
}
