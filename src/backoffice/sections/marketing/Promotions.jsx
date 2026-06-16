// src/backoffice/sections/marketing/Promotions.jsx
//
// Marketing → Promotions (slice 1): create offers, issue one-time promo codes, look up / void codes.
// All reads/writes go through the marketing-admin edge fn (org-scoped, resolved server-side from the
// active location). The actual reward applies at the till via promo-redeem + the existing discount slot.

import { useEffect, useMemo, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 760 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  field: { marginBottom: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12, color: 'var(--red)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  pill: { display: 'inline-block', padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t2)' },
  code: { fontFamily: 'var(--font-mono,monospace)', background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 6, padding: '2px 8px', fontSize: 13, fontWeight: 700, color: 'var(--t1)' },
  offerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderTop: '1px solid var(--bdr2)' },
};

const REWARD_TYPES = [
  ['fixed', '£ off'], ['percent', '% off'], ['free_item', 'Free / discounted item'],
  ['free_delivery', 'Free delivery'], ['points_bonus', 'Bonus points'],
];
const rewardSummary = (o) => {
  if (o.reward_label) return o.reward_label;
  switch (o.reward_type) {
    case 'percent': return `${o.reward_value}% off`;
    case 'fixed': return `£${Number(o.reward_value).toFixed(2)} off`;
    case 'free_item': return 'Free item';
    case 'free_delivery': return 'Free delivery';
    case 'points_bonus': return `${o.reward_value} bonus points`;
    default: return 'Offer';
  }
};
const BLANK = { name: '', description: '', reward_type: 'fixed', reward_value: 5, reward_label: '', min_spend: '', valid_from: '', valid_to: '', per_customer_limit: 1, code_prefix: '', code_length: 5, active: true };

export default function Promotions() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [offers, setOffers] = useState([]);
  const [editing, setEditing] = useState(null);     // offer being created/edited, or null
  const [save, setSave] = useState({});
  const [issued, setIssued] = useState({});          // { [offerId]: { code, busy } }
  const [lookupCode, setLookupCode] = useState('');
  const [lookup, setLookup] = useState(null);

  const call = (action, extra = {}) => supabase.functions.invoke('marketing-admin', { body: { action, ops_location_id: locId, ...extra } })
    .then(({ data, error }) => { if (error) { throw new Error(error.message); } if (data?.error) throw new Error(data.error); return data; });

  const loadOffers = async (id = locId) => {
    const { data } = await supabase.functions.invoke('marketing-admin', { body: { action: 'list_offers', ops_location_id: id } });
    setOffers(data?.offers || []);
  };

  useEffect(() => {
    (async () => {
      try {
        const id = await getActiveLocationSync(); setLocId(id);
        if (!supabase || !id) { setLoading(false); return; }
        await loadOffers(id);
      } catch {} finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveOffer = async () => {
    const o = editing;
    if (!o?.name?.trim()) { setSave({ err: 'Give the offer a name.' }); return; }
    setSave({ busy: true });
    try {
      const offer = {
        ...(o.id ? { id: o.id } : {}),
        name: o.name.trim(), description: o.description || null,
        reward_type: o.reward_type, reward_value: Number(o.reward_value) || 0, reward_label: o.reward_label || null,
        min_spend: o.min_spend === '' ? null : Number(o.min_spend),
        valid_from: o.valid_from || null, valid_to: o.valid_to || null,
        per_customer_limit: Number(o.per_customer_limit) || 1,
        code_prefix: (o.code_prefix || '').toUpperCase(), code_length: Number(o.code_length) || 5,
        active: !!o.active,
      };
      await call('save_offer', { offer });
      setEditing(null); setSave({ done: true }); setTimeout(() => setSave((s) => (s.done ? {} : s)), 2000);
      await loadOffers();
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };

  const issueCode = async (offerId) => {
    setIssued((s) => ({ ...s, [offerId]: { busy: true } }));
    try {
      const d = await call('issue_code', { offer_id: offerId });
      setIssued((s) => ({ ...s, [offerId]: { code: d.code } }));
      await loadOffers();
    } catch (e) { setIssued((s) => ({ ...s, [offerId]: { err: e.message } })); }
  };

  const doLookup = async () => {
    if (!lookupCode.trim()) return;
    setLookup({ busy: true });
    try { const d = await call('lookup_code', { code: lookupCode.trim() }); setLookup(d); }
    catch (e) { setLookup({ err: e.message }); }
  };
  const voidCode = async (code) => {
    if (!window.confirm(`Void code ${code}? It can no longer be redeemed.`)) return;
    try { await call('void_code', { code }); await doLookup(); } catch (e) { setLookup((l) => ({ ...l, err: e.message })); }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to manage promotions.</div>;

  return (
    <div>
      <h1 style={S.h1}>Promotions</h1>
      <div style={S.sub}>Create offers and issue promo codes. Codes are redeemed at the till and fully attributed back to the campaign and customer.</div>

      {/* Offers */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ ...S.h2, margin: 0 }}>Offers</h2>
          {!editing && <button style={S.btn} onClick={() => setEditing({ ...BLANK })}>+ New offer</button>}
        </div>
        {!editing && offers.length === 0 && <div style={{ ...S.hint, padding: '14px 0' }}>No offers yet. Create one to start issuing codes.</div>}
        {!editing && offers.map((o) => {
          const iss = issued[o.id] || {};
          return (
            <div key={o.id} style={S.offerRow}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{o.name} <span style={{ ...S.pill, marginLeft: 6, color: o.active ? 'var(--grn)' : 'var(--t4)' }}>{o.active ? 'Active' : 'Off'}</span></div>
                <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{rewardSummary(o)}{o.min_spend ? ` · min £${Number(o.min_spend).toFixed(2)}` : ''} · issued {o.issued_count || 0} · redeemed {o.redeemed_count || 0}</div>
                {iss.code && <div style={{ marginTop: 6 }}><span style={S.code}>{iss.code}</span> <span style={S.ok}>✓ issued</span></div>}
                {iss.err && <div style={S.err}>{iss.err}</div>}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button style={S.ghost} onClick={() => issueCode(o.id)} disabled={iss.busy}>{iss.busy ? 'Issuing…' : 'Issue code'}</button>
                <button style={S.ghost} onClick={() => setEditing({ ...BLANK, ...o, min_spend: o.min_spend ?? '', valid_from: (o.valid_from || '').slice(0, 10), valid_to: (o.valid_to || '').slice(0, 10) })}>Edit</button>
              </div>
            </div>
          );
        })}

        {editing && (
          <div style={{ marginTop: 6 }}>
            <div style={S.field}><label style={S.label}>Offer name</label><input style={S.input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Birthday treat" /></div>
            <div style={S.row3}>
              <div style={S.field}><label style={S.label}>Reward</label>
                <select style={S.input} value={editing.reward_type} onChange={(e) => setEditing({ ...editing, reward_type: e.target.value })}>
                  {REWARD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div style={S.field}><label style={S.label}>{editing.reward_type === 'percent' ? 'Percent' : editing.reward_type === 'points_bonus' ? 'Points' : 'Value (£)'}</label><input style={S.input} type="number" value={editing.reward_value} onChange={(e) => setEditing({ ...editing, reward_value: e.target.value })} /></div>
              <div style={S.field}><label style={S.label}>Min spend (£) <span style={{ color: 'var(--t4)', fontWeight: 500 }}>opt.</span></label><input style={S.input} type="number" value={editing.min_spend} onChange={(e) => setEditing({ ...editing, min_spend: e.target.value })} placeholder="none" /></div>
            </div>
            <div style={S.field}><label style={S.label}>Reward label <span style={{ color: 'var(--t4)', fontWeight: 500 }}>(shown on the code/receipt — optional)</span></label><input style={S.input} value={editing.reward_label} onChange={(e) => setEditing({ ...editing, reward_label: e.target.value })} placeholder={editing.reward_type === 'free_item' ? 'Free dessert' : 'e.g. £5 off your visit'} /></div>
            <div style={S.row2}>
              <div style={S.field}><label style={S.label}>Valid from <span style={{ color: 'var(--t4)', fontWeight: 500 }}>opt.</span></label><input style={S.input} type="date" value={editing.valid_from} onChange={(e) => setEditing({ ...editing, valid_from: e.target.value })} /></div>
              <div style={S.field}><label style={S.label}>Valid to <span style={{ color: 'var(--t4)', fontWeight: 500 }}>opt.</span></label><input style={S.input} type="date" value={editing.valid_to} onChange={(e) => setEditing({ ...editing, valid_to: e.target.value })} /></div>
            </div>
            <div style={S.row3}>
              <div style={S.field}><label style={S.label}>Uses per customer</label><input style={S.input} type="number" value={editing.per_customer_limit} onChange={(e) => setEditing({ ...editing, per_customer_limit: e.target.value })} /></div>
              <div style={S.field}><label style={S.label}>Code prefix</label><input style={S.input} value={editing.code_prefix} onChange={(e) => setEditing({ ...editing, code_prefix: e.target.value.toUpperCase() })} placeholder="BDAY" maxLength={12} /></div>
              <div style={S.field}><label style={S.label}>Code length</label><input style={S.input} type="number" min={4} max={12} value={editing.code_length} onChange={(e) => setEditing({ ...editing, code_length: e.target.value })} /></div>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, fontSize: 13, color: 'var(--t2)' }}>
              <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} style={{ accentColor: 'var(--acc)' }} /> Active (codes can be redeemed)
            </label>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button style={S.btn} onClick={saveOffer} disabled={save.busy}>{save.busy ? 'Saving…' : (editing.id ? 'Save offer' : 'Create offer')}</button>
              <button style={S.ghost} onClick={() => { setEditing(null); setSave({}); }}>Cancel</button>
              {save.err && <span style={S.err}>{save.err}</span>}
            </div>
          </div>
        )}
        {save.done && !editing && <div style={{ ...S.ok, marginTop: 10 }}>✓ Saved</div>}
      </div>

      {/* Code lookup */}
      <div style={S.card}>
        <h2 style={S.h2}>Look up a code</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...S.input, maxWidth: 260 }} value={lookupCode} onChange={(e) => setLookupCode(e.target.value)} placeholder="BDAY-7F3K9" onKeyDown={(e) => e.key === 'Enter' && doLookup()} />
          <button style={S.btn} onClick={doLookup} disabled={lookup?.busy}>{lookup?.busy ? 'Looking…' : 'Look up'}</button>
        </div>
        {lookup?.err && <div style={{ ...S.err, marginTop: 8 }}>{lookup.err}</div>}
        {lookup && lookup.found === false && <div style={{ ...S.hint, marginTop: 8 }}>No code found.</div>}
        {lookup?.found && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.8 }}>
            <div><span style={S.code}>{lookup.code.code}</span> <span style={{ ...S.pill, marginLeft: 6, color: lookup.code.status === 'redeemed' ? 'var(--grn)' : lookup.code.status === 'voided' ? 'var(--red)' : 'var(--t2)' }}>{lookup.code.status}</span></div>
            <div>Offer: <b>{lookup.offer?.name || '—'}</b> ({rewardSummary(lookup.offer || {})})</div>
            <div>Uses: {lookup.code.uses_count}/{lookup.code.uses_allowed}{lookup.code.expires_at ? ` · expires ${new Date(lookup.code.expires_at).toLocaleDateString('en-GB')}` : ''}</div>
            {(lookup.redemptions || []).length > 0 && (
              <div style={{ marginTop: 6 }}>Redemptions:
                {lookup.redemptions.map((r, i) => <div key={i} style={{ fontSize: 12, color: 'var(--t3)' }}>· {new Date(r.redeemed_at).toLocaleString('en-GB')} — £{Number(r.discount_value || 0).toFixed(2)} (order {r.order_id || '—'})</div>)}
              </div>
            )}
            {lookup.code.status !== 'voided' && <button style={{ ...S.ghost, color: 'var(--red)', marginTop: 10 }} onClick={() => voidCode(lookup.code.code)}>Void code</button>}
          </div>
        )}
      </div>
    </div>
  );
}
