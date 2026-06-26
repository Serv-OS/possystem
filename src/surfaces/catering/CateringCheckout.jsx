// src/surfaces/catering/CateringCheckout.jsx
//
// Catering checkout. Pay-NOW (card, full charge — reuses the online payment plumbing: per-venue
// Stripe/Ryft via getLocationProcessor + createPaymentIntent + RyftPaymentForm) OR pay-LATER (order
// arrives confirmed-unpaid). Pay-now writes order_queue (paid=true) + closed_checks (paid, net) like
// the online flow; pay-later writes order_queue (paid=false). Money: major (£) on rows, minor at the
// Stripe/Ryft boundary. Deposits/invoicing are the Events module, not here.

import { useEffect, useMemo, useState } from 'react';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { supabase, ensureAuthToken } from '../../lib/supabase';
import { getStripeForAccount, createPaymentIntent } from '../../lib/stripeClient';
import { getLocationProcessor } from '../../lib/payments/processor';
import RyftPaymentForm from '../../components/RyftPaymentForm';
import { calculateOrderTax } from '../../lib/tax';
import { sendEmailReceipt } from '../../lib/sendReceipt';
import { getDeliveryQuote, recordDeliverySurcharge } from '../../lib/delivery/quoteService';

const money = (n, cur) => `${({ gbp: '£', usd: '$', eur: '€' }[cur] || '£')}${Number(n || 0).toFixed(2)}`;

// Build the UTC instant for a wall-clock time in the VENUE timezone (not the customer's
// browser). Used for the kitchen fire time (sent_at) and the sale date (closed_at) so a
// catering order fires + reports on the venue's clock regardless of where it was placed.
function wallTimeToInstantMs(dateStr, timeStr, tz) {
  if (!dateStr) return NaN;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '12:00').split(':').map(Number);
  const guess = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, 0);
  if (!tz) return guess;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = {}; dtf.formatToParts(new Date(guess)).forEach(x => { if (x.type !== 'literal') p[x.type] = +x.value; });
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return guess - (seen - guess);   // shift the guess by the venue's offset at that wall time
  } catch { return guess; }
}
const center = { maxWidth: 640, margin: '0 auto', padding: '0 16px' };
const lbl = { display: 'block', fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 5 };
const inp = { width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 10, padding: '9px 12px', fontSize: 14, fontFamily: 'inherit' };

export default function CateringCheckout({ location, cfg, cart, taxRates, theme, cur, fulfilment, eventDate, eventTime, subtotal, onBack }) {
  const opsId = location.ops_location_id || location.id;
  const platformLocationId = location.id;
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [email, setEmail] = useState('');
  const [addr1, setAddr1] = useState(''); const [postcode, setPostcode] = useState('');
  const [taxId, setTaxId] = useState(''); const [promo, setPromo] = useState(''); const [notes, setNotes] = useState('');
  const [tipPct, setTipPct] = useState(0);
  const [promoApplied, setPromoApplied] = useState(null);  // { code, amount, name }
  const [promoErr, setPromoErr] = useState(''); const [promoBusy, setPromoBusy] = useState(false);
  const [payMode, setPayMode] = useState('now');           // 'now' | 'later'
  const [step, setStep] = useState('details');             // 'details' | 'pay'
  const [processor, setProcessor] = useState('stripe');
  const [pi, setPi] = useState(null); const [stripePromise, setStripePromise] = useState(null);
  const [busy, setBusy] = useState(false); const [placed, setPlaced] = useState(null); const [err, setErr] = useState('');

  useEffect(() => { getLocationProcessor(platformLocationId).then(setProcessor).catch(() => {}); }, [platformLocationId]);

  const isDelivery = fulfilment === 'delivery';
  // v5.5.653: catering delivery now uses the SHARED delivery engine — same self/courier mode +
  // configured fee as POS/online. A catering event is in the FUTURE, so we use the configured
  // fee (scheduled=true; no live quote) and dispatch the courier at FIRE time, not now. Falls
  // back to the legacy catering flat fee (cfg.delivery_fee_minor) if the engine isn't set up.
  const [deliveryQuote, setDeliveryQuote] = useState(null);
  useEffect(() => {
    if (!isDelivery || !addr1.trim() || !postcode.trim()) { setDeliveryQuote(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      const q = await getDeliveryQuote({ opsLocationId: opsId, dropoff: { line1: addr1.trim(), postcode: postcode.trim().toUpperCase() }, orderSubtotalMinor: Math.round(subtotal * 100), scheduled: true });
      if (live) setDeliveryQuote(q);
    }, 500);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDelivery, addr1, postcode, subtotal, opsId]);
  const engineFeeMinor = (isDelivery && deliveryQuote?.available) ? (deliveryQuote.customerFeeMinor || 0) : null;
  const deliveryFee = isDelivery ? ((engineFeeMinor != null ? engineFeeMinor : (cfg.delivery_fee_minor || 0)) / 100) : 0;
  const tip = useMemo(() => (cfg.tips_enabled && tipPct ? +(subtotal * tipPct / 100).toFixed(2) : 0), [cfg.tips_enabled, tipPct, subtotal]);
  const discount = promoApplied?.amount || 0;
  const total = Math.max(0, +(subtotal + deliveryFee + tip - discount).toFixed(2));
  const totalMinor = Math.round(total * 100);
  const valid = name.trim() && /^\+?[0-9 ]{7,}$/.test(phone) && (!isDelivery || (addr1.trim() && postcode.trim())) && (payMode === 'later' || email.trim());

  const ref = useMemo(() => `CA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, []);
  const buildItems = () => cart.map((l) => ({ itemId: l.itemId, name: l.name, price: l.price, qty: l.qty || 1, mods: l.mods || [], notes: l.notes || '', cat: l.cat || null, cats: l.cats || null, parentId: l.parentId || null, kitchenName: l.kitchenName || null, status: 'received', fired: false, course: 1 }));
  const buildCustomer = (pay) => ({
    name: name.trim(), phone: phone.replace(/\s+/g, ''), email: email.trim() || null,
    ...(isDelivery ? { address: { line1: addr1.trim(), postcode: postcode.trim().toUpperCase() } } : {}),
    fulfilment, event_date: eventDate, event_time: eventTime,
    ...(notes.trim() ? { notes: notes.trim() } : {}), ...(taxId.trim() ? { tax_id: taxId.trim() } : {}),
    ...(promoApplied ? { promo_code: promoApplied.code, promo_discount: promoApplied.amount } : {}), ...(tip ? { tip } : {}), ...(deliveryFee ? { delivery_fee: deliveryFee } : {}),
    ...(isDelivery && deliveryQuote?.mode ? { delivery_mode: deliveryQuote.mode } : {}),   // fire-time dispatch reads this
    ...pay,
  });
  const promoReason = (r, min) => ({ not_found: "That code isn't valid.", expired: 'That code has expired.', already_used: 'That code has already been used.', voided: 'That code is no longer valid.', inactive: "That offer isn't active.", not_yet_active: "That offer hasn't started yet.", wrong_venue: "That code isn't valid here.", usage_limit: 'That code has reached its limit.', customer_required: 'That code is linked to an account — order signed in to use it.', customer_mismatch: 'That code is linked to a different account.', min_spend: `Spend at least ${money(min || 0, cur)} to use this code.` }[r] || "That code can't be used.");
  const applyPromo = async () => {
    const code = promo.trim(); if (!code) return;
    setPromoBusy(true); setPromoErr(''); setPromoApplied(null);
    try {
      const { data, error } = await supabase.functions.invoke('promo-redeem', { body: { action: 'validate', code, location_id: opsId, basket: { subtotal } } });
      if (error) throw new Error(error.message);
      if (!data?.valid) { setPromoErr(promoReason(data?.reason, data?.min_spend)); return; }
      setPromoApplied({ code: code.toUpperCase(), amount: Number(data.discount?.amount || 0), name: data.offer?.name || 'Promo' });
    } catch (e) { setPromoErr(e?.message || 'Could not check that code.'); } finally { setPromoBusy(false); }
  };
  const redeemPromo = async (orderRef) => {
    if (!promoApplied) return;
    try { await supabase.functions.invoke('promo-redeem', { body: { action: 'redeem', code: promoApplied.code, order_id: orderRef, location_id: opsId, basket_value: subtotal, idempotency_key: `${orderRef}:${promoApplied.code}` } }); } catch { /* best-effort; discount already shown to the guest */ }
  };
  const discountLine = promoApplied ? [{ type: 'promo', code: promoApplied.code, label: promoApplied.name, amount: promoApplied.amount }] : [];
  // v5.5.653: log the delivery quote + surcharge for margin reporting (best-effort). The
  // courier itself is dispatched at FIRE time (releaseDueCateringOrders), not now.
  const logDeliverySurcharge = () => {
    if (!isDelivery || !deliveryQuote?.available) return;
    recordDeliverySurcharge({ opsLocationId: opsId, orderRef: ref, quote: { ...deliveryQuote, dropoff: { line1: addr1.trim(), postcode: postcode.trim().toUpperCase() } } }).catch(() => {});
  };
  // A catering order is HELD until its event day. The kitchen needs `prep_time_minutes`, so it FIRES
  // that many minutes before the order's OWN event time (sent_at = event − prep, in the venue
  // timezone). Each order fires relative to its own event time, so multiple same-day orders at
  // different times each fire at the right moment. It stays out of the live queue (QueueSync excludes
  // future catering); the master "release due catering" tick fires it via routeKioskOrderPrints
  // (atomic kitchen_routed_at claim → once across devices). status stays 'received' (BO Catering
  // reads kitchen_routed_at, not status, for "In kitchen"). Sales date to the event day (eventMs).
  const prepMin = Math.max(0, Number(cfg?.prep_time_minutes) || 0);
  const eventMs = wallTimeToInstantMs(eventDate, eventTime || '12:00', cfg?.venue_timezone);
  const fireMs = isNaN(eventMs) ? NaN : eventMs - prepMin * 60000;
  const queueRow = (paid, pay) => {
    return {
      ref, location_id: opsId, type: fulfilment, status: 'received', source: 'catering',
      event_date: eventDate, collection_time: eventTime, is_asap: false,
      paid, items: buildItems(), customer: buildCustomer(pay), total,
      sent_at: new Date(isNaN(fireMs) ? Date.now() : fireMs).toISOString(),
      ...(paid ? { payment_method: 'card' } : {}),
    };
  };
  // Snapshot everything the confirmation screen needs, so it renders the full
  // branded receipt independent of any later state change.
  const placedSnapshot = (paid, emailedTo) => ({
    ref, paid, emailedTo: emailedTo || null,
    items: buildItems(), customerName: name.trim(),
    isDelivery, eventDate, eventTime,
    address: isDelivery ? { line1: addr1.trim(), postcode: postcode.trim().toUpperCase() } : null,
    subtotal, deliveryFee, tip, discount, total, promoName: promoApplied?.name || null,
  });

  // ── PAY LATER ──────────────────────────────────────────────────────
  const placeLater = async () => {
    if (!valid) { setErr('Please complete the required fields.'); return; }
    setBusy(true); setErr('');
    try {
      await ensureAuthToken();
      const { error } = await supabase.from('order_queue').insert(queueRow(false, { pay_later: true }));
      if (error) throw error;
      await redeemPromo(ref);
      logDeliverySurcharge();
      setPlaced(placedSnapshot(false, null));
    } catch (e) { setErr(e?.message || 'Could not place the order.'); } finally { setBusy(false); }
  };

  // ── PAY NOW (card) ─────────────────────────────────────────────────
  const startPayNow = async () => {
    if (!valid) { setErr('Please complete the required fields.'); return; }
    setErr('');
    if (processor === 'ryft') { setStep('pay'); return; }
    setBusy(true);
    try {
      const token = await ensureAuthToken();
      const piRes = await createPaymentIntent({
        authToken: token, locationId: platformLocationId, amountMinor: totalMinor, currency: cur, channel: 'online',
        description: `Catering order ${ref} · ${name.trim()} · ${eventDate}`,
        paymentMethodTypes: ['card'],
        metadata: { source: 'catering', ref, ops_location_id: String(opsId), customer_name: name.trim(), customer_email: email.trim(), customer_phone: phone.replace(/\s+/g, ''), order_type: fulfilment, event_date: eventDate },
      });
      if (!piRes?.client_secret) throw new Error('Payment could not start. Please try again.');
      setPi(piRes); setStripePromise(getStripeForAccount(piRes.stripe_account)); setStep('pay');
    } catch (e) { setErr(e?.message || 'Payment could not start.'); } finally { setBusy(false); }
  };

  const finalizeNow = async (paymentIntent) => {
    setBusy(true); setErr('');
    try {
      await ensureAuthToken();
      const payId = paymentIntent?.id || null;
      const pay = { payment_intent_id: payId, processor, pay_later: false };
      // order_queue (paid)
      await supabase.from('order_queue').insert(queueRow(true, pay));
      logDeliverySurcharge();
      // closed_checks (paid, net) — mirrors the online paid-order record. Sales are dated to the
      // event day at the event time, so a pre-order counts on the day of the event — not the day it
      // was placed. Payment is still captured now. (eventMs is computed once in the component body.)
      const taxBk = calculateOrderTax(cart.map((l) => ({ price: l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0), qty: l.qty || 1, taxRateId: l.taxRateId, taxOverrides: l.taxOverrides })), taxRates || [], fulfilment);
      const closedAt = isNaN(eventMs) ? new Date().toISOString() : new Date(eventMs).toISOString();
      const closedCheck = {
        id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, ref, location_id: opsId, server: 'Catering', staff_id: null, covers: 1,
        order_type: fulfilment, customer: buildCustomer(pay), items: buildItems().map((i) => ({ ...i, voided: false })), discounts: discountLine,
        subtotal, service: deliveryFee, tip, tax_amount: taxBk?.totalTax || null, total, method: 'card',
        closed_at: closedAt, status: 'paid', refunds: [], table_id: null, table_label: `Catering ${ref}`,
        source: 'catering', stripe_payment_intent_id: payId, payment_intents: payId ? [{ id: payId, amountMinor: totalMinor }] : null, processor,
      };
      await supabase.from('closed_checks').insert(closedCheck);
      await redeemPromo(ref);
      // Email the customer their confirmation/receipt (best-effort; never blocks the
      // on-screen confirmation). Reuses the receipt pipeline; the just-inserted
      // closed_checks row clears the send-receipt tenant fence via check_id.
      const toEmail = email.trim();
      if (toEmail) {
        sendEmailReceipt({
          to: toEmail, locationId: opsId, locationLabel: location.name,
          check: {
            id: closedCheck.id, ref, items: closedCheck.items, customer: closedCheck.customer,
            closedAt: closedAt, total, method: 'card', service: deliveryFee, tip,
            discountAmount: discount, taxAmount: taxBk?.totalTax || 0, taxBreakdown: taxBk, server: 'Catering',
          },
        }).catch(() => { /* best-effort; on-screen confirmation already shown */ });
      }
      setPlaced(placedSnapshot(true, toEmail || null));
    } catch (e) { setErr(e?.message || 'Payment captured but saving the order failed — please contact the venue with your reference.'); } finally { setBusy(false); }
  };

  // ── Confirmation ───────────────────────────────────────────────────
  if (placed) {
    const P = placed;
    const lineTotal = (it) => ((Number(it.price) || 0) + (it.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0)) * (it.qty || 1);
    const sumRow = (label, value, opts = {}) => (
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: opts.big ? 16 : 13.5, fontWeight: opts.big ? 800 : 500, color: opts.muted ? '#475569' : '#0f172a', ...(opts.top ? { borderTop: '1px solid #e2e8f0', marginTop: 6, paddingTop: 8 } : {}) }}>
        <span>{label}</span><span>{value}</span>
      </div>
    );
    return (
      <div style={{ position: 'fixed', inset: 0, overflowY: 'auto', background: theme.bg || '#f5f5f5', color: theme.fg || '#0f172a', fontFamily: '-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif' }}>
        <header style={{ background: theme.brand, color: '#fff', padding: '16px 0' }}>
          <div style={{ ...center, display: 'flex', alignItems: 'center', gap: 12 }}>
            {theme.logo && <img src={theme.logo} alt={theme.name} style={{ width: 38, height: 38, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />}
            <div style={{ fontSize: 19, fontWeight: 800 }}>{theme.name || location.name}</div>
          </div>
        </header>
        <div style={{ ...center, paddingTop: 24, paddingBottom: 40 }}>
          <div style={{ textAlign: 'center', marginBottom: 18 }}>
            <div style={{ fontSize: 44 }}>{P.paid ? '✅' : '📩'}</div>
            <h2 style={{ margin: '8px 0 4px' }}>{P.paid ? 'Order confirmed' : 'Enquiry received'}</h2>
            <div style={{ color: '#475569', fontSize: 14 }}>Order <b style={{ color: theme.fg || '#0f172a' }}>{P.ref}</b> · {P.isDelivery ? 'Delivery' : 'Collection'} <b style={{ color: theme.fg || '#0f172a' }}>{P.eventDate} at {P.eventTime}</b></div>
            <div style={{ color: '#475569', fontSize: 14, marginTop: 4 }}>{P.paid ? `${location.name} has received your payment of ${money(P.total, cur)}.` : `${location.name} will confirm and arrange payment with you.`}</div>
            {P.emailedTo && <div style={{ color: '#16a34a', fontSize: 13, marginTop: 6, fontWeight: 700 }}>✉ Confirmation sent to {P.emailedTo}</div>}
          </div>

          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 16, color: '#0f172a' }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Your order</div>
            {P.items.map((it, i) => {
              const mods = (it.mods || []).map((m) => m?.name || m?.label || m).filter(Boolean);
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', fontSize: 13.5, borderBottom: '1px solid #f1f5f9' }}>
                  <div>
                    <div>{(it.qty || 1) > 1 ? <b>{it.qty}× </b> : null}{it.name}</div>
                    {mods.length > 0 && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>+ {mods.join(' · ')}</div>}
                    {it.notes ? <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, fontStyle: 'italic' }}>{it.notes}</div> : null}
                  </div>
                  <div style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{money(lineTotal(it), cur)}</div>
                </div>
              );
            })}
            <div style={{ marginTop: 8 }}>
              {sumRow('Subtotal', money(P.subtotal, cur), { muted: true })}
              {P.deliveryFee > 0 && sumRow('Delivery', money(P.deliveryFee, cur), { muted: true })}
              {P.tip > 0 && sumRow('Tip', money(P.tip, cur), { muted: true })}
              {P.discount > 0 && sumRow(`Promo${P.promoName ? ` · ${P.promoName}` : ''}`, `−${money(P.discount, cur)}`, { muted: true })}
              {sumRow('Total', money(P.total, cur), { big: true, top: true })}
            </div>
          </div>

          <div style={{ marginTop: 14, fontSize: 13, color: '#475569' }}>
            <div><b style={{ color: theme.fg || '#0f172a' }}>{P.isDelivery ? 'Delivery to' : 'Collection by'}:</b> {P.customerName}</div>
            {P.address && <div style={{ marginTop: 2 }}>{P.address.line1}, {P.address.postcode}</div>}
          </div>

          <button onClick={() => onBack && onBack()} style={{ marginTop: 20, width: '100%', padding: '12px', borderRadius: 10, border: `1px solid ${theme.brand}`, background: 'transparent', color: theme.brand, fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>Back to menu</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', paddingBottom: 40, background: theme.bg || '#f5f5f5', color: theme.fg || '#0f172a', fontFamily: '-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif' }}>
      <header style={{ background: theme.brand, color: '#fff', padding: '16px 0' }}>
        <div style={{ ...center, display: 'flex', alignItems: 'center', gap: 12 }}>
          {theme.logo && <img src={theme.logo} alt={theme.name} style={{ width: 38, height: 38, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />}
          <div>
            <button onClick={() => (step === 'pay' ? setStep('details') : onBack())} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: 0 }}>← {step === 'pay' ? 'Back to details' : 'Back to menu'}</button>
            <div style={{ fontSize: 19, fontWeight: 800, marginTop: 4 }}>Checkout</div>
          </div>
        </div>
      </header>
      <div style={{ ...center, paddingTop: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>{isDelivery ? 'Delivery' : 'Collection'} · {eventDate} at {eventTime}</div>
          <div style={{ fontSize: 13, color: '#475569' }}>{cart.reduce((n, l) => n + (l.qty || 1), 0)} items · subtotal {money(subtotal, cur)}{deliveryFee ? ` · delivery ${money(deliveryFee, cur)}` : ''}{tip ? ` · tip ${money(tip, cur)}` : ''}{discount ? ` · promo −${money(discount, cur)}` : ''} · <b>total {money(total, cur)}</b></div>
        </div>

        {step === 'pay' ? (
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 16 }}>
            {processor === 'ryft' ? (
              <RyftPaymentForm amountMinor={totalMinor} currency={cur} locationId={platformLocationId} channel="online" merchantName={location?.name || ''} customerEmail={email.trim()} payLabel={`Pay ${money(total, cur)}`} onSuccess={finalizeNow} onError={(e) => setErr(e?.message || 'Payment failed')} />
            ) : pi && stripePromise ? (
              <Elements stripe={stripePromise} options={{ clientSecret: pi.client_secret, appearance: { theme: 'stripe' } }}>
                <CateringPayStep theme={theme} total={total} cur={cur} pi={pi} onPaid={finalizeNow} onError={setErr} />
              </Elements>
            ) : <div>Starting payment…</div>}
            {err && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 12 }}>{err}</div>}
          </div>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label style={lbl}>Name *</label><input style={inp} value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div><label style={lbl}>Phone *</label><input style={inp} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44…" /></div>
            </div>
            <div style={{ marginTop: 12 }}><label style={lbl}>Email {payMode === 'now' ? '*' : <span style={{ color: '#94a3b8', fontWeight: 500 }}>for your confirmation</span>}</label><input style={inp} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            {isDelivery && (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginTop: 12 }}>
                <div><label style={lbl}>Delivery address *</label><input style={inp} value={addr1} onChange={(e) => setAddr1(e.target.value)} /></div>
                <div><label style={lbl}>Postcode *</label><input style={inp} value={postcode} onChange={(e) => setPostcode(e.target.value)} /></div>
              </div>
            )}
            {cfg.allow_tax_exempt && <div style={{ marginTop: 12 }}><label style={lbl}>Tax / VAT number <span style={{ color: '#94a3b8', fontWeight: 500 }}>optional</span></label><input style={inp} value={taxId} onChange={(e) => setTaxId(e.target.value)} /></div>}
            {cfg.allow_promo && (
              <div style={{ marginTop: 12 }}>
                <label style={lbl}>Promo code <span style={{ color: '#94a3b8', fontWeight: 500 }}>optional</span></label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input style={inp} value={promo} disabled={!!promoApplied} onChange={(e) => { setPromo(e.target.value); setPromoErr(''); }} />
                  {promoApplied
                    ? <button onClick={() => { setPromoApplied(null); setPromo(''); }} style={{ padding: '0 16px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontWeight: 700 }}>Remove</button>
                    : <button onClick={applyPromo} disabled={promoBusy || !promo.trim()} style={{ padding: '0 16px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff', cursor: promo.trim() ? 'pointer' : 'default', fontWeight: 700, opacity: promo.trim() && !promoBusy ? 1 : 0.5 }}>{promoBusy ? '…' : 'Apply'}</button>}
                </div>
                {promoApplied && <div style={{ color: '#16a34a', fontSize: 12.5, marginTop: 5, fontWeight: 700 }}>✓ {promoApplied.name}: −{money(promoApplied.amount, cur)}</div>}
                {promoErr && <div style={{ color: '#dc2626', fontSize: 12.5, marginTop: 5 }}>{promoErr}</div>}
              </div>
            )}
            {cfg.tips_enabled && (
              <div style={{ marginTop: 12 }}><label style={lbl}>Add a tip</label>
                <div style={{ display: 'flex', gap: 8 }}>{[0, Number(cfg.tip_default_pct) || 10, 15, 20].filter((v, i, a) => a.indexOf(v) === i).map((p) => <button key={p} onClick={() => setTipPct(p)} style={{ padding: '8px 14px', borderRadius: 99, border: '1px solid #cbd5e1', background: tipPct === p ? theme.brand : '#fff', color: tipPct === p ? '#fff' : '#0f172a', cursor: 'pointer', fontWeight: 700 }}>{p === 0 ? 'No tip' : `${p}%`}</button>)}</div>
              </div>
            )}
            <div style={{ marginTop: 12 }}><label style={lbl}>Notes for the venue <span style={{ color: '#94a3b8', fontWeight: 500 }}>dietary needs, setup, etc.</span></label><textarea style={{ ...inp, minHeight: 70, resize: 'vertical' }} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>

            {cfg.allow_pay_later && (
              <div style={{ marginTop: 14 }}><label style={lbl}>Payment</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[['now', 'Pay now by card'], ['later', 'Pay later']].map(([m, t]) => <button key={m} onClick={() => setPayMode(m)} style={{ padding: '9px 14px', borderRadius: 10, border: `1px solid ${payMode === m ? theme.brand : '#cbd5e1'}`, background: payMode === m ? theme.brand : '#fff', color: payMode === m ? '#fff' : '#0f172a', cursor: 'pointer', fontWeight: 700 }}>{t}</button>)}
                </div>
              </div>
            )}

            {err && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 12 }}>{err}</div>}
            <button onClick={payMode === 'later' ? placeLater : startPayNow} disabled={busy || !valid} style={{ marginTop: 16, width: '100%', padding: '13px', borderRadius: 10, border: 'none', background: theme.brand, color: '#fff', fontWeight: 800, fontSize: 15, cursor: valid ? 'pointer' : 'default', opacity: valid && !busy ? 1 : 0.5 }}>
              {busy ? 'Please wait…' : payMode === 'later' ? `Place order — pay later (${money(total, cur)})` : `Continue to payment (${money(total, cur)})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Stripe card entry — inside <Elements> so it can confirm the PaymentIntent (mirrors OnlineCheckout's PayStep).
function CateringPayStep({ theme, total, cur, pi, onPaid, onError }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!stripe || !elements) return;
    setBusy(true); onError('');
    const card = elements.getElement(CardElement);
    const { error: stripeErr, paymentIntent } = await stripe.confirmCardPayment(pi.client_secret, { payment_method: { card } });
    setBusy(false);
    if (stripeErr) { onError(stripeErr.message || 'Card declined.'); return; }
    if (paymentIntent?.status === 'succeeded') await onPaid(paymentIntent);
    else onError(`Payment status: ${paymentIntent?.status || 'unknown'}.`);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontWeight: 800 }}>Card details</div>
      <div style={{ padding: 14, borderRadius: 12, border: '1.5px solid #cbd5e1', background: '#fff' }}>
        <CardElement options={{ style: { base: { color: '#0f172a', fontSize: '16px', fontFamily: 'inherit', '::placeholder': { color: '#9a9aa1' } } } }} />
      </div>
      <button onClick={submit} disabled={busy} style={{ width: '100%', padding: '13px', borderRadius: 10, border: 'none', background: theme.brand, color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Processing…' : `Pay ${money(total, cur)}`}</button>
    </div>
  );
}
