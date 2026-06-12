// src/backoffice/sections/reports/RyftDisputes.jsx
// Chargebacks / disputes for this location — captured live from Ryft. Each open
// dispute has a respondBy DEADLINE: act before it or it auto-Expires and the
// merchant loses the funds + a non-reclaimable fee. Accept (concede) or
// challenge (with a written defence).

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';
import { StatTile, EmptyState } from './_charts';
import { money } from '../../../lib/currency';

const OPEN = (s) => String(s || '').toLowerCase() === 'open';
const statusColor = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'won') return 'var(--grn)';
  if (['lost', 'expired'].includes(v)) return 'var(--red)';
  if (['accepted', 'challenged'].includes(v)) return 'var(--t2)';
  return 'var(--amb,#e8a020)'; // open / cancelled
};
function countdown(respondBy) {
  if (!respondBy) return null;
  const ms = new Date(respondBy).getTime() - Date.now();
  if (isNaN(ms)) return null;
  if (ms <= 0) return { text: 'deadline passed', urgent: true, over: true };
  const h = Math.floor(ms / 3.6e6), d = Math.floor(h / 24);
  return { text: d >= 1 ? `${d}d ${h % 24}h left` : `${h}h left`, urgent: h < 72, over: false };
}

async function callDisputes(action, payload) {
  const locId = await getActiveLocationSync();
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ryft-disputes`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ops_location_id: locId, ...payload }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

export default function RyftDisputes() {
  const [disputes, setDisputes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [challengeId, setChallengeId] = useState(null);
  const [defence, setDefence] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try { const r = await callDisputes('list', {}); setDisputes(r.disputes || []); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const accept = async (d) => {
    if (!confirm(`Accept this dispute and refund ${money((d.amount || 0) / 100, d.currency)} to the cardholder? This cannot be undone.`)) return;
    setBusyId(d.dispute_id); setError('');
    try { await callDisputes('accept', { dispute_id: d.dispute_id }); await load(); }
    catch (e) { setError(e.message); } finally { setBusyId(null); }
  };
  const challenge = async (d) => {
    if (!defence.trim()) { setError('Add a short written defence before challenging.'); return; }
    setBusyId(d.dispute_id); setError('');
    try { await callDisputes('challenge', { dispute_id: d.dispute_id, defence: defence.trim() }); setChallengeId(null); setDefence(''); await load(); }
    catch (e) { setError(e.message); } finally { setBusyId(null); }
  };

  if (loading) return <div style={{ padding: 24, color: 'var(--t3)' }}>Loading disputes…</div>;
  if (error && !disputes) return <EmptyState icon="⚠️" message={error} />;

  const list = disputes || [];
  const open = list.filter(d => OPEN(d.status));
  const atStake = open.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const cur = list[0]?.currency || 'GBP';

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
        <StatTile label="Open disputes" value={String(open.length)} color={open.length ? 'var(--amb,#e8a020)' : 'var(--t1)'} />
        <StatTile label="At stake (open)" value={money(atStake / 100, cur)} color={open.length ? 'var(--red)' : 'var(--t1)'} />
        <StatTile label="All disputes" value={String(list.length)} />
      </div>

      {error && <div style={{ padding: 10, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, fontSize: 12, border: '1px solid var(--red-b)', marginBottom: 14 }}>{error}</div>}

      {list.length === 0 ? (
        <EmptyState icon="🛡" message="No chargebacks. If a customer disputes a card payment it will appear here with a deadline to respond." />
      ) : list.map(d => {
        const cd = countdown(d.respond_by);
        const recs = Array.isArray(d.recommended_evidence) ? d.recommended_evidence : [];
        return (
          <div key={d.dispute_id} style={{ background: 'var(--bg1)', border: `1px solid ${OPEN(d.status) ? 'var(--amb,#e8a020)' : 'var(--bdr)'}`, borderRadius: 12, padding: 18, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--t1)' }}>{money((d.amount || 0) / 100, d.currency || cur)}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: statusColor(d.status), textTransform: 'uppercase', letterSpacing: '.04em' }}>{d.status}</span>
                  {OPEN(d.status) && cd && (
                    <span style={{ fontSize: 12, fontWeight: 700, color: cd.urgent ? 'var(--red)' : 'var(--t2)' }}>⏳ {cd.text}</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: 'var(--t2)' }}>{d.category}{d.reason_description ? ` · ${d.reason_description}` : (d.reason_code ? ` · ${d.reason_code}` : '')}</div>
                {recs.length > 0 && OPEN(d.status) && (
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 6 }}>Suggested evidence: {recs.join(', ')}</div>
                )}
              </div>
              {OPEN(d.status) && challengeId !== d.dispute_id && (
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button onClick={() => { setChallengeId(d.dispute_id); setDefence(''); setError(''); }} disabled={busyId === d.dispute_id} style={btn('prim')}>Challenge</button>
                  <button onClick={() => accept(d)} disabled={busyId === d.dispute_id} style={btn('ghost')}>Accept</button>
                </div>
              )}
            </div>

            {challengeId === d.dispute_id && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 }}>Your defence</div>
                <textarea value={defence} onChange={e => setDefence(e.target.value)} rows={4}
                  placeholder="Explain why this charge is valid — e.g. the customer dined in, the order and receipt details, signed/PIN-verified card-present, any communication. Be factual and specific."
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <button onClick={() => challenge(d)} disabled={busyId === d.dispute_id || !defence.trim()} style={btn('prim')}>{busyId === d.dispute_id ? 'Submitting…' : 'Submit challenge'}</button>
                  <button onClick={() => { setChallengeId(null); setDefence(''); }} disabled={busyId === d.dispute_id} style={btn('ghost')}>Cancel</button>
                  <span style={{ fontSize: 11, color: 'var(--t4)' }}>Submits your written defence to the card scheme.</span>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {list.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6 }}>
          <button onClick={load} style={{ background: 'none', border: 'none', color: 'var(--acc)', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: 0 }}>↻ Refresh</button> · Disputes are captured automatically and you're emailed the moment one is raised.
        </div>
      )}
    </div>
  );
}

function btn(kind) {
  const base = { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' };
  if (kind === 'prim') return { ...base, background: 'var(--acc)', color: '#0b0c10' };
  return { ...base, background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2,var(--bdr))' };
}
