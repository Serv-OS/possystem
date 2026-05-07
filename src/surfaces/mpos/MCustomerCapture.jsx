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

import { useState } from 'react';
import { useStore } from '../../store';
import { Sx } from './MShellStyles';

export default function MCustomerCapture({ orderType, onContinue, onSkip, onBack }) {
  const { customer, setCustomer } = useStore();
  const [name, setName] = useState(customer?.name || '');
  const [phone, setPhone] = useState(customer?.phone || '');
  const [email, setEmail] = useState(customer?.email || '');
  const [address, setAddress] = useState(customer?.address || '');
  const [time, setTime] = useState(customer?.collectionTime || '');
  const [isASAP, setIsASAP] = useState(customer?.isASAP !== false);

  const isDelivery = orderType === 'delivery';
  const isCollection = orderType === 'collection';

  // Validation — name + phone required for collection/delivery. Address only
  // for delivery. Time only required when not ASAP.
  const errors = (() => {
    const e = {};
    if (isCollection || isDelivery) {
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
        {!isCollection && !isDelivery && (
          <button onClick={onSkip} style={{
            ...Sx.iconBtn, width:'auto', padding:'0 12px', minWidth:60,
            fontSize:12, fontWeight:700, color:'var(--t3)',
          }}>Skip</button>
        )}
      </div>

      <div style={Sx.scroller}>
        <div style={{ padding:'14px 16px 4px' }}>
          {/* Name */}
          <Field label="Customer name" required={isCollection || isDelivery} error={errors.name}>
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. James Wilson" autoComplete="name" autoCorrect="off"
              style={inputStyle}/>
          </Field>

          {/* Phone */}
          <Field label="Phone" required={isCollection || isDelivery} error={errors.phone}>
            <input
              value={phone} onChange={(e) => setPhone(e.target.value)}
              placeholder="07700 900 123" type="tel" inputMode="tel" autoComplete="tel"
              style={inputStyle}/>
          </Field>

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
        {!isCollection && !isDelivery && (
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
