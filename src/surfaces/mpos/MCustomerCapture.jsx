// MCustomerCapture — captures customer details for collection / delivery
// orders. Sits between MNewOrder (type pick) and MMenu so the order has a
// customer attached before any items are added — required because kitchen
// tickets, queue rows and email receipts all need at minimum a name.
//
// Required fields by order type:
//   • takeaway   → optional (legacy, customer just walks out with the bag)
//   • collection → name + phone (so staff can call out the order); collection time
//   • delivery   → name + phone + address; ASAP or scheduled time
//
// Skips itself when the type is takeaway or dine-in (those don't need it).

import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { Sx } from './MShellStyles';

export default function MCustomerCapture({ orderType, onContinue, onSkip, onBack }) {
  const { customer, setCustomer, searchCustomers, searchCustomersLive } = useStore();
  const [name, setName] = useState(customer?.name || '');
  const [phone, setPhone] = useState(customer?.phone || '');
  const [email, setEmail] = useState(customer?.email || '');
  const [address, setAddress] = useState(customer?.address || '');
  const [time, setTime] = useState(customer?.collectionTime || '');
  const [isASAP, setIsASAP] = useState(customer?.isASAP !== false);

  // v5.5.341: customer search — find a returning customer by name/phone and
  // prefill (same lookup the counter POS uses). Results hide once one is picked.
  const [results, setResults] = useState([]);
  const [searchActive, setSearchActive] = useState(false);
  useEffect(() => {
    if (!searchActive) return;
    const phoneDigits = phone.replace(/[^\d+]/g, '');
    const q = phoneDigits.length >= 6 ? phone : name.trim().length >= 3 ? name.trim() : '';
    if (!q) { setResults([]); return; }
    try { if (typeof searchCustomers === 'function') setResults(searchCustomers(q).slice(0, 6)); } catch {}
    const t = setTimeout(async () => {
      try {
        const live = typeof searchCustomersLive === 'function' ? await searchCustomersLive(q) : [];
        if (live && live.length) {
          const seen = new Set();
          const merged = [...live, ...(typeof searchCustomers === 'function' ? searchCustomers(q) : [])]
            .filter(c => { const k = c.phone || c.email || c.id; if (seen.has(k)) return false; seen.add(k); return true; })
            .slice(0, 6);
          setResults(merged);
        }
      } catch {}
    }, 250);
    return () => clearTimeout(t);
  }, [name, phone, searchActive]);

  const selectCustomer = (c) => {
    setName(c.name || '');
    setPhone(c.phone || '');
    setEmail(c.email || '');
    setSearchActive(false);
    setResults([]);
  };

  const isDelivery = orderType === 'delivery';
  const isCollection = orderType === 'collection';
  const isTakeaway = orderType === 'takeaway';
  // v5.5.341: takeaway now requires customer details too, matching the counter
  // POS (name + phone required for every walk-in order type).
  const needsCustomer = isTakeaway || isCollection || isDelivery;

  // Validation — name + phone required for collection/delivery. Address only
  // for delivery. Time only required when not ASAP.
  const errors = (() => {
    const e = {};
    if (needsCustomer) {
      if (!name.trim()) e.name = 'Customer name required';
      if (!phone.trim()) e.phone = 'Phone required';
    }
    if (isDelivery && !address.trim()) e.address = 'Delivery address required';
    if (!isASAP && (isCollection || isDelivery) && !time.trim()) e.time = 'Pick a time or tick ASAP';
    return e;
  })();
  const valid = Object.keys(errors).length === 0;

  const submit = () => {
    if (!valid) return;
    setCustomer({
      name: name.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      address: address.trim() || null,
      collectionTime: isASAP ? null : time.trim() || null,
      isASAP,
    });
    onContinue?.();
  };

  return (
    <div style={Sx.shell}>
      <div style={Sx.header}>
        <button onClick={onBack} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>Customer details</div>
          <div style={Sx.hSub}>{(orderType || '').toUpperCase()} order</div>
        </div>
        {!needsCustomer && (
          <button onClick={onSkip} style={{
            ...Sx.iconBtn, width:'auto', padding:'0 12px', minWidth:60,
            fontSize:12, fontWeight:700, color:'var(--t3)',
          }}>Skip</button>
        )}
      </div>

      <div style={Sx.scroller}>
        <div style={{ padding:'14px 16px 4px' }}>
          {/* Name */}
          <Field label="Customer name" required={needsCustomer} error={errors.name}>
            <input
              value={name} onChange={(e) => { setName(e.target.value); setSearchActive(true); }}
              placeholder="e.g. James Wilson" autoComplete="name" autoCorrect="off"
              style={inputStyle}/>
          </Field>

          {/* Phone */}
          <Field label="Phone" required={needsCustomer} error={errors.phone}>
            <input
              value={phone} onChange={(e) => { setPhone(e.target.value); setSearchActive(true); }}
              placeholder="07700 900 123" type="tel" inputMode="tel" autoComplete="tel"
              style={inputStyle}/>
          </Field>

          {/* v5.5.341: matching existing customers — tap to prefill */}
          {searchActive && results.length > 0 && (
            <div style={{ marginTop:-6, marginBottom:14, border:'1px solid var(--bdr2)', borderRadius:10, overflow:'hidden', background:'var(--bg2)' }}>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', padding:'8px 12px', borderBottom:'1px solid var(--bdr)' }}>
                {results.length} matching customer{results.length === 1 ? '' : 's'}
              </div>
              {results.map((c, i) => (
                <button key={(c.phone || c.id || '') + i} onClick={() => selectCustomer(c)} style={{
                  width:'100%', display:'flex', alignItems:'center', gap:10, padding:'11px 12px', textAlign:'left',
                  background:'transparent', border:'none', borderTop: i === 0 ? 'none' : '1px solid var(--bdr)',
                  cursor:'pointer', fontFamily:'inherit',
                }}>
                  <span style={{ width:30, height:30, borderRadius:8, background:'var(--acc-d)', color:'var(--acc)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:800, flexShrink:0 }}>
                    {(c.name || '?').slice(0,1).toUpperCase()}
                  </span>
                  <span style={{ flex:1, minWidth:0 }}>
                    <span style={{ display:'block', fontSize:13, fontWeight:700, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.name || 'Customer'}</span>
                    <span style={{ display:'block', fontSize:11, color:'var(--t3)' }}>{c.phone || c.email || '—'}{typeof c.points === 'number' ? ` · ${c.points} pts` : ''}</span>
                  </span>
                  <span style={{ fontSize:11, color:'var(--acc)', fontWeight:700, flexShrink:0 }}>Use →</span>
                </button>
              ))}
            </div>
          )}

          {/* Email — optional, surfaces here so receipt can email later */}
          <Field label="Email" sub="Used for receipt — optional">
            <input
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@example.com" type="email" inputMode="email"
              autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              style={inputStyle}/>
          </Field>

          {/* Address — delivery only */}
          {isDelivery && (
            <Field label="Delivery address" required error={errors.address}>
              <textarea
                value={address} onChange={(e) => setAddress(e.target.value.slice(0, 240))}
                placeholder="House, street, town, postcode"
                style={{ ...inputStyle, minHeight:64, resize:'vertical' }}/>
            </Field>
          )}

          {/* Collection / delivery time */}
          {(isCollection || isDelivery) && (
            <Field label="When?">
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <button
                  onClick={() => setIsASAP(!isASAP)}
                  style={{
                    flex:1, padding:'12px', borderRadius:11,
                    border:`1.5px solid ${isASAP ? 'var(--acc)' : 'var(--bdr2)'}`,
                    background: isASAP ? 'var(--acc-d)' : 'var(--bg2)',
                    color: isASAP ? 'var(--acc)' : 'var(--t2)',
                    fontSize:13, fontWeight:800, cursor:'pointer', fontFamily:'inherit',
                  }}>
                  ⚡ {isASAP ? 'ASAP — selected' : 'Tap for ASAP'}
                </button>
                <input
                  value={time} onChange={(e) => { setTime(e.target.value); setIsASAP(false); }}
                  type="time" disabled={isASAP}
                  style={{ ...inputStyle, flex:1, opacity: isASAP ? .4 : 1 }}/>
              </div>
              {errors.time && <div style={errorStyle}>{errors.time}</div>}
            </Field>
          )}
        </div>
      </div>

      <div style={Sx.bottom}>
        {!valid && Object.keys(errors).length > 0 && (
          <div style={{ marginBottom:8, padding:8, borderRadius:8, background:'var(--red-d)', color:'var(--red)', fontSize:11, fontWeight:700, border:'1px solid var(--red-b)', textAlign:'center' }}>
            Fill in the highlighted fields to continue
          </div>
        )}
        <button onClick={submit} disabled={!valid} style={{ ...Sx.btnPrim, opacity: valid ? 1 : .5 }}>
          Continue to menu
        </button>
        {!needsCustomer && (
          <button onClick={onSkip} style={{ ...Sx.btnGhost, marginTop:8 }}>Skip — no customer details</button>
        )}
      </div>
    </div>
  );
}

const inputStyle = {
  width:'100%', padding:'12px 14px', borderRadius:10, border:'1px solid var(--bdr2)',
  background:'var(--bg2)', color:'var(--t1)', fontSize:14, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
};
const errorStyle = { marginTop:4, fontSize:11, color:'var(--red)', fontWeight:700 };

function Field({ label, sub, required, error, children }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:6 }}>
        <span style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em' }}>
          {label}{required ? ' *' : ''}
        </span>
        {sub && <span style={{ fontSize:10, color:'var(--t4)' }}>{sub}</span>}
      </div>
      {children}
      {error && <div style={errorStyle}>{error}</div>}
    </div>
  );
}
