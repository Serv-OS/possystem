// src/surfaces/catering/CateringCheckout.jsx
//
// Catering checkout. Commit 1: PAY-LATER placement only — writes an order_queue row
// (source='catering', status='received', paid=false, event_date) so it lands in the Orders hub and
// inherits the existing order notifications. Card payment (pay-now + deposit, reusing Stripe/Ryft) is
// commit 2. Money is major (£) on order_queue, matching the online-order convention.

import { useMemo, useState } from 'react';
import { supabase, ensureAuthToken } from '../../lib/supabase';

const money = (n, cur) => `${({ gbp: '£', usd: '$', eur: '€' }[cur] || '£')}${Number(n || 0).toFixed(2)}`;
const center = { maxWidth: 640, margin: '0 auto', padding: '0 16px' };
const lbl = { display: 'block', fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 5 };
const inp = { width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 10, padding: '9px 12px', fontSize: 14, fontFamily: 'inherit' };

export default function CateringCheckout({ location, cfg, cart, theme, cur, fulfilment, eventDate, eventTime, subtotal, onBack }) {
  const opsId = location.ops_location_id || location.id;
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [addr1, setAddr1] = useState('');
  const [postcode, setPostcode] = useState('');
  const [taxId, setTaxId] = useState('');
  const [promo, setPromo] = useState('');
  const [notes, setNotes] = useState('');
  const [tipPct, setTipPct] = useState(0);
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState(null);   // { ref }
  const [err, setErr] = useState('');

  const isDelivery = fulfilment === 'delivery';
  const deliveryFee = isDelivery ? (cfg.delivery_fee_minor ? cfg.delivery_fee_minor / 100 : 0) : 0;  // flat fee (per-mile deferred)
  const tip = useMemo(() => (cfg.tips_enabled && tipPct ? +(subtotal * tipPct / 100).toFixed(2) : 0), [cfg.tips_enabled, tipPct, subtotal]);
  const total = +(subtotal + deliveryFee + tip).toFixed(2);

  const valid = name.trim() && /^\+?[0-9 ]{7,}$/.test(phone) && (!isDelivery || (addr1.trim() && postcode.trim()));

  const place = async () => {
    if (!valid) { setErr('Please complete the required fields.'); return; }
    setBusy(true); setErr('');
    try {
      await ensureAuthToken();
      const ref = `CA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const items = cart.map((l) => ({ itemId: l.itemId, name: l.name, price: l.price, qty: l.qty || 1, mods: l.mods || [], notes: l.notes || '', cat: l.cat || null, cats: l.cats || null, parentId: l.parentId || null, kitchenName: l.kitchenName || null, status: 'received', fired: false, course: 1 }));
      const customer = {
        name: name.trim(), phone: phone.replace(/\s+/g, ''), email: email.trim() || null,
        ...(isDelivery ? { address: { line1: addr1.trim(), postcode: postcode.trim().toUpperCase() } } : {}),
        fulfilment, event_time: eventTime,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(taxId.trim() ? { tax_id: taxId.trim() } : {}),
        ...(promo.trim() ? { promo_code: promo.trim().toUpperCase() } : {}),
        ...(tip ? { tip } : {}),
        ...(deliveryFee ? { delivery_fee: deliveryFee } : {}),
        pay_later: true,
      };
      const row = {
        ref, location_id: opsId, type: fulfilment, status: 'received', source: 'catering',
        event_date: eventDate, collection_time: eventTime, is_asap: false, paid: false,
        items, customer, total, sent_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('order_queue').insert(row);
      if (error) throw error;
      setPlaced({ ref });
    } catch (e) { setErr(e?.message || 'Could not place the order.'); } finally { setBusy(false); }
  };

  if (placed) return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24, fontFamily: 'inherit', color: '#0f172a' }}>
      <div>
        <div style={{ fontSize: 44 }}>✅</div>
        <h2 style={{ margin: '8px 0' }}>Enquiry received</h2>
        <div style={{ color: '#475569' }}>Your catering order <b>{placed.ref}</b> for <b>{eventDate} at {eventTime}</b> is in. {location.name} will confirm and arrange payment with you.</div>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', paddingBottom: 40, fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif', color: '#0f172a' }}>
      <header style={{ background: theme.accent, color: '#fff', padding: '16px 0' }}>
        <div style={center}><button onClick={onBack} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: 0 }}>← Back to menu</button><div style={{ fontSize: 19, fontWeight: 800, marginTop: 4 }}>Checkout</div></div>
      </header>
      <div style={{ ...center, paddingTop: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>{fulfilment === 'delivery' ? 'Delivery' : 'Collection'} · {eventDate} at {eventTime}</div>
          <div style={{ fontSize: 13, color: '#475569' }}>{cart.reduce((n, l) => n + (l.qty || 1), 0)} items · subtotal {money(subtotal, cur)}{deliveryFee ? ` · delivery ${money(deliveryFee, cur)}` : ''}{tip ? ` · tip ${money(tip, cur)}` : ''} · <b>total {money(total, cur)}</b></div>
        </div>

        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={lbl}>Name *</label><input style={inp} value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><label style={lbl}>Phone *</label><input style={inp} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44…" /></div>
          </div>
          <div style={{ marginTop: 12 }}><label style={lbl}>Email</label><input style={inp} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="for your confirmation" /></div>
          {isDelivery && (
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginTop: 12 }}>
              <div><label style={lbl}>Delivery address *</label><input style={inp} value={addr1} onChange={(e) => setAddr1(e.target.value)} /></div>
              <div><label style={lbl}>Postcode *</label><input style={inp} value={postcode} onChange={(e) => setPostcode(e.target.value)} /></div>
            </div>
          )}
          {cfg.allow_tax_exempt && <div style={{ marginTop: 12 }}><label style={lbl}>Tax / VAT number <span style={{ color: '#94a3b8', fontWeight: 500 }}>optional</span></label><input style={inp} value={taxId} onChange={(e) => setTaxId(e.target.value)} /></div>}
          {cfg.allow_promo && <div style={{ marginTop: 12 }}><label style={lbl}>Promo code <span style={{ color: '#94a3b8', fontWeight: 500 }}>optional</span></label><input style={inp} value={promo} onChange={(e) => setPromo(e.target.value)} /></div>}
          {cfg.tips_enabled && (
            <div style={{ marginTop: 12 }}><label style={lbl}>Add a tip</label>
              <div style={{ display: 'flex', gap: 8 }}>{[0, Number(cfg.tip_default_pct) || 10, 15, 20].filter((v, i, a) => a.indexOf(v) === i).map((p) => <button key={p} onClick={() => setTipPct(p)} style={{ padding: '8px 14px', borderRadius: 99, border: '1px solid #cbd5e1', background: tipPct === p ? theme.accent : '#fff', color: tipPct === p ? '#fff' : '#0f172a', cursor: 'pointer', fontWeight: 700 }}>{p === 0 ? 'No tip' : `${p}%`}</button>)}</div>
            </div>
          )}
          <div style={{ marginTop: 12 }}><label style={lbl}>Notes for the venue <span style={{ color: '#94a3b8', fontWeight: 500 }}>dietary needs, setup, etc.</span></label><textarea style={{ ...inp, minHeight: 70, resize: 'vertical' }} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>

          {err && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 12 }}>{err}</div>}
          <button onClick={place} disabled={busy || !valid} style={{ marginTop: 16, width: '100%', padding: '13px', borderRadius: 10, border: 'none', background: theme.accent, color: '#fff', fontWeight: 800, fontSize: 15, cursor: valid ? 'pointer' : 'default', opacity: valid && !busy ? 1 : 0.5 }}>
            {busy ? 'Placing…' : `Place order — pay later (${money(total, cur)})`}
          </button>
          <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 8, textAlign: 'center' }}>The venue will confirm and arrange payment. Card payment online is coming soon.</div>
        </div>
      </div>
    </div>
  );
}
