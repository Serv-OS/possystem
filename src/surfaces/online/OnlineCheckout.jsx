// v5.5.121 — Online ordering checkout sheet w/ Stripe Elements payment.
// Two-step flow inside one sheet:
//   STEP 1: Details + when (name/phone/email/address, ASAP / scheduled slot)
//   STEP 2: Card details (Stripe Elements + CardElement, confirms via
//           stripe.confirmCardPayment using the same edge fn / connected-
//           account / markup-fee plumbing the operator UI already uses
//           — see src/lib/stripeClient.js + stripe-create-payment-intent
//           edge fn). channel='online' so online_markup_percent applies.
//
// Auth: online customers aren't logged in to Supabase, so we pass the env
// VITE_SUPABASE_ANON_KEY as the bearer (the edge fn accepts anon-role JWTs
// for online channel — same role the rest of the customer surface already
// uses to read menus / write to order_queue with the existing RLS policies).
//
// Order_queue write: only AFTER payment succeeds. status='received' immediately
// so the kitchen chime fires on the INSERT — no awaiting_payment placeholder
// needed any more (we kept that for the redirect-flow window where the
// customer left our page; with inline Elements the customer never leaves).

import { useEffect, useMemo, useState } from 'react';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { supabase, platformSupabase } from '../../lib/supabase';
import { getStripeForAccount, createPaymentIntent } from '../../lib/stripeClient';
import { attributeOnlineOrder } from '../../lib/customerLookup';
import { getDayWindows } from '../../lib/openingHours';

export default function OnlineCheckout({ cart, theme, location, orderType, loyalty, onClose, onPlaced }) {
  const opsLocationId = location.ops_location_id || location.id; // ops DB
  const platformLocationId = location.id;                         // platform DB
  const tz = location.timezone || 'Europe/London';
  const leadMin = Number(location.online_collection_lead_min) || 30;

  // Payment step: 'details' or 'pay'
  const [step, setStep] = useState('details');
  const [pi, setPi] = useState(null);             // { client_secret, stripe_account, ... }
  const [stripePromise, setStripePromise] = useState(null);

  // Customer details
  const [name, setName]   = useState('');
  const [phone, setPhone] = useState(loyalty?.phone || '');
  const [email, setEmail] = useState('');
  const [address1, setAddress1] = useState('');
  const [postcode, setPostcode] = useState('');
  const [notes, setNotes] = useState('');

  // Timing — ASAP or scheduled
  const [timeMode, setTimeMode] = useState('asap'); // 'asap' | 'scheduled'
  const [slot, setSlot]         = useState(null);

  // Submit
  const [working, setWorking] = useState(false);
  const [error, setError]     = useState('');

  // Subtotal
  const subtotal = useMemo(() => cart.reduce((s, l) => {
    const unit = l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
    return s + unit * (l.qty || 1);
  }, 0), [cart]);

  // Build collection slots — every 15 min between (now + leadMin) and the
  // next close time, snapped to :00 / :15 / :30 / :45.
  const slots = useMemo(() => buildCollectionSlots(location, tz, leadMin), [location, tz, leadMin]);

  // When the customer first picks Schedule, auto-select the earliest slot
  // so the dropdowns aren't empty and "Place order" isn't blocked on a
  // micro-interaction.
  useEffect(() => {
    if (timeMode === 'scheduled' && !slot && slots.length) setSlot(slots[0]);
  }, [timeMode, slot, slots]);

  const muted   = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBdr = theme.isLight ? '#ececef' : '#2a2a30';
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';

  const isDelivery = orderType === 'delivery';
  const valid = useMemo(() => {
    if (!name.trim()) return false;
    if (!/^\+?[0-9 ]{7,}$/.test(phone)) return false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
    if (isDelivery && (!address1.trim() || !postcode.trim())) return false;
    if (timeMode === 'scheduled' && !slot) return false;
    return true;
  }, [name, phone, email, address1, postcode, isDelivery, timeMode, slot]);

  // Compose order ref + customer + items + collection ISO once details are valid.
  // Used by both the createPaymentIntent description/metadata and the
  // post-payment order_queue write.
  const orderShape = useMemo(() => {
    const collectionAt = timeMode === 'asap'
      ? new Date(Date.now() + leadMin * 60_000)
      : (slot ? new Date(slot.iso) : new Date(Date.now() + leadMin * 60_000));
    const sentAt = new Date(collectionAt.getTime() - leadMin * 60_000);
    const ref = `OL-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const customer = {
      name: name.trim(),
      phone: phone.replace(/\s+/g, ''),
      email: email.trim(),
      ...(isDelivery ? { address: { line1: address1.trim(), postcode: postcode.trim().toUpperCase() } } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    // v5.5.128: include cat / cats / parentId on the queued items so the
    // operator-side production routing (routeKioskOrderPrints → centresForItem)
    // can bucket them into the right kitchen station even if the master
    // device's local menuItems cache hasn't loaded a matching row yet.
    // Pulled from the cart line if present (set by OnlineSurface when the
    // item was added) — falls back to undefined if not, in which case the
    // master still does its own menuItems lookup as a safety net.
    // v5.5.132: stamp items as already 'sent' + fired:true. Online orders
    // are paid before they enter order_queue — the kitchen DOES have them,
    // there's no operator decision pending. Without these flags the
    // operator's queue UI shows them as "to send" and the operator has
    // to manually open + click save-and-send before anything fires.
    const items = cart.map(l => ({
      itemId: l.itemId, name: l.name, price: l.price,
      qty: l.qty || 1, mods: l.mods || [],
      cat: l.cat || null,
      cats: l.cats || null,
      parentId: l.parentId || null,
      kitchenName: l.kitchenName || null,
      status: 'sent',
      fired: true,
      course: 1,
    }));
    return { ref, collectionAt, sentAt, customer, items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]); // freeze on step transition so ref stays stable

  // Step 1 → 2: create the PaymentIntent on the location's connected
  // Stripe account, then load Stripe.js with that account ID.
  const continueToPayment = async () => {
    if (!valid) { setError('Please complete the highlighted fields.'); return; }
    setWorking(true); setError('');
    try {
      // The edge fn rejects raw anon keys ("Invalid token") — it expects
      // a real Supabase user JWT. For online customers we use anonymous
      // auth: get a one-shot signed-in session (role='authenticated' with
      // is_anonymous=true), use its access_token as the bearer, then sign
      // back out so we don't keep stale sessions hanging on the device.
      // REQUIRES: Anonymous sign-ins enabled in Supabase Auth settings.
      let authToken = null;
      try {
        const existing = await supabase?.auth.getSession();
        authToken = existing?.data?.session?.access_token || null;
        if (!authToken) {
          const { data, error: anonErr } = await supabase.auth.signInAnonymously();
          if (anonErr) throw new Error('Could not start payment session: ' + anonErr.message + '. Enable Anonymous sign-ins in your Supabase Auth settings.');
          authToken = data?.session?.access_token;
        }
      } catch (e) {
        throw new Error('Payment auth failed: ' + (e?.message || 'unknown'));
      }
      if (!authToken) throw new Error('Could not obtain auth token for payment.');
      const { ref, customer } = orderShape;
      const piRes = await createPaymentIntent({
        authToken,
        locationId: platformLocationId,
        amountMinor: Math.round(subtotal * 100),
        currency: 'gbp',
        channel: 'online',
        description: `Online order ${ref} · ${customer.name}`,
        paymentMethodTypes: ['card'],
        metadata: {
          source: 'online',
          ref,
          ops_location_id: String(opsLocationId),
          customer_name: customer.name,
          customer_email: customer.email,
          customer_phone: customer.phone,
          order_type: orderType,
        },
      });
      if (!piRes?.client_secret) throw new Error('Payment could not start. Please try again.');
      setPi(piRes);
      setStripePromise(getStripeForAccount(piRes.stripe_account));
      setStep('pay');
    } catch (e) {
      console.error('[OnlineCheckout] createPaymentIntent failed:', e);
      setError(e?.message || 'Could not start payment.');
    } finally {
      setWorking(false);
    }
  };

  // Called by the inner ConfirmStep after stripe.confirmCardPayment succeeds.
  // Writes the order_queue row (status='received' so the operator chimes/
  // sees it instantly), clears cart, hands ref up to OnlineSurface so it
  // shows the live OrderTracker.
  const onPaymentSuccess = async (paymentIntent) => {
    try {
      const { ref, collectionAt, sentAt, customer, items } = orderShape;
      const collectionTimeLabel = collectionAt.toLocaleTimeString('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const queueRow = {
        ref,
        location_id: opsLocationId,
        type: orderType,
        // v5.5.137: paid online orders go straight to 'prep' — payment is
        // confirmed, the kitchen owns it. 'received' was a redundant stage
        // that required the operator to manually advance every order.
        // KDS auto-status integration (next commit) ties bumped → ready
        // → collected so operators don't touch the order at all.
        status: 'prep',
        source: 'online',
        items, customer,
        total: subtotal,
        sent_at: sentAt.toISOString(),
        collection_time: collectionTimeLabel,
        is_asap: timeMode === 'asap',
      };
      const { error: insErr } = await supabase.from('order_queue').insert(queueRow);
      if (insErr) {
        console.error('[OnlineCheckout] order_queue write failed AFTER payment:', insErr);
        setError('Payment succeeded but we could not save the order. Contact the venue with ref ' + ref + '.');
        return;
      }

      // v5.5.127: also write to closed_checks so the paid online order shows
      // up in History / EOD / Payments reports identically to in-store paid
      // orders. status='paid' (not 'open') because Stripe already collected.
      // The receipt formatter prints check.ref as "ORDER #" — no extra wiring.
      try {
        const closedCheck = {
          id: `chk-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
          ref,
          location_id: opsLocationId,
          server: 'Online',
          staff_id: null,
          covers: 1,
          order_type: orderType,
          customer,
          items: items.map(i => ({ ...i, voided: false })),
          discounts: [],
          subtotal,
          service: 0,
          tip: 0,
          tax_amount: null,
          total: subtotal,
          method: 'card',
          drawer_id: null,
          shift_id: null,
          closed_at: new Date().toISOString(),
          status: 'paid',
          refunds: [],
          table_id: null,
          table_label: `Online ${ref}`,
          source: 'online', // v5.5.140: tag closed_checks for report filtering
        };
        const { error: ccErr } = await supabase.from('closed_checks').insert(closedCheck);
        if (ccErr) console.warn('[OnlineCheckout] closed_checks insert failed:', ccErr.message);
      } catch (e) {
        console.warn('[OnlineCheckout] closed_checks write threw:', e?.message);
      }

      // Customer profile: every online order/visit flows into the same CRM
      // the operator UI uses (customers + customer_locations + customer_orders).
      // Fire-and-forget — a CRM blip never blocks the confirmation flow.
      attributeOnlineOrder({
        phone: customer.phone,
        name: customer.name,
        email: customer.email,
        marketingOptIn: false,
        locationId: opsLocationId,
        orderRecord: { ref, total: subtotal, items, type: orderType },
      }).catch(e => console.warn('[OnlineCheckout] attribute failed:', e?.message || e));

      onPlaced?.({ ref, collectionAt, total: subtotal, paymentIntent });
    } catch (e) {
      console.error('[OnlineCheckout] post-payment write failed:', e);
      setError('Payment succeeded but we could not save the order. Contact the venue with ref ' + orderShape.ref + '.');
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 600,
        maxHeight: '96vh', overflowY: 'auto',
        background: theme.bg, color: theme.fg,
        borderRadius: '18px 18px 0 0',
        boxShadow: '0 -10px 40px rgba(0,0,0,0.3)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
      }}>
        <div style={{ padding: '12px 0 6px', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 44, height: 5, borderRadius: 3, background: cardBdr }}/>
        </div>

        <div style={{ padding: '8px 24px 16px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.02em' }}>
              {step === 'pay' ? 'Payment' : 'Checkout'}
            </div>
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{isDelivery ? 'Delivery' : 'Collection'} · {cart.length} item{cart.length === 1 ? '' : 's'} · £{subtotal.toFixed(2)}</div>
          </div>
          <button onClick={step === 'pay' ? () => { setStep('details'); setPi(null); setError(''); } : onClose}
            className="op-btn"
            style={{
              padding: '0 14px', height: 36, borderRadius: 99, border: `1px solid ${cardBdr}`,
              background: inputBg, color: theme.fg,
              fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            }}>{step === 'pay' ? '← Edit' : '×'}</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 6, padding: '0 24px 14px' }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: theme.accent }}/>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: step === 'pay' ? theme.accent : cardBdr }}/>
        </div>

        {step === 'pay' && pi && stripePromise ? (
          <Elements stripe={stripePromise} options={{ clientSecret: pi.client_secret, appearance: { theme: theme.isLight ? 'stripe' : 'night' } }}>
            <PayStep
              pi={pi} subtotal={subtotal} theme={theme} cardBdr={cardBdr} inputBg={inputBg} muted={muted}
              cart={cart}
              onPaid={onPaymentSuccess}
              onError={setError}
              error={error}
            />
          </Elements>
        ) : (
        <div style={{ padding: '0 24px 12px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* 1. Your details */}
          <SectionTitle>Your details</SectionTitle>
          <Field label="Name" value={name} onChange={setName} placeholder="Full name" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Phone" value={phone} onChange={setPhone} placeholder="07700 900000" type="tel" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
            <Field label="Email" value={email} onChange={setEmail} placeholder="you@example.com" type="email" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          </div>
          {isDelivery && (
            <>
              <Field label="Delivery address" value={address1} onChange={setAddress1} placeholder="House / flat number, street" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
              <Field label="Postcode" value={postcode} onChange={setPostcode} placeholder="SW1A 1AA" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
            </>
          )}
          <Field label="Notes (optional)" value={notes} onChange={setNotes} placeholder="Buzzer / leave at door / dietary…" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>

          {/* 2. When? */}
          <SectionTitle>When?</SectionTitle>
          <div style={{ display: 'flex', gap: 8 }}>
            <ModeChip active={timeMode === 'asap'} onClick={() => setTimeMode('asap')}
              theme={theme} cardBdr={cardBdr}>
              ⚡ ASAP <span style={{ opacity: 0.6, marginLeft: 4 }}>· ~{leadMin} min</span>
            </ModeChip>
            <ModeChip active={timeMode === 'scheduled'} onClick={() => setTimeMode('scheduled')}
              theme={theme} cardBdr={cardBdr}>
              🗓 Schedule
            </ModeChip>
          </div>
          {timeMode === 'scheduled' && (
            <SlotPicker slots={slots} value={slot} onChange={setSlot} theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          )}

          {/* 3. Summary */}
          <SectionTitle>Order summary</SectionTitle>
          <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '12px 14px' }}>
            {cart.map(line => {
              const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
              return (
                <div key={line.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>{line.qty || 1} × {line.name}</span>
                  <span style={{ fontWeight: 700 }}>£{(unit * (line.qty || 1)).toFixed(2)}</span>
                </div>
              );
            })}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>Total</span>
              <span style={{ fontSize: 18, fontWeight: 900 }}>£{subtotal.toFixed(2)}</span>
            </div>
          </div>
        </div>
        )}

        {/* Sticky bottom button — only shown on details step (PayStep has its own) */}
        {step === 'details' && (
          <div style={{
            position: 'sticky', bottom: 0,
            padding: '14px 24px calc(14px + env(safe-area-inset-bottom)) 24px',
            background: theme.bg, borderTop: `1px solid ${cardBdr}`,
          }}>
            {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{error}</div>}
            <button onClick={continueToPayment} disabled={!valid || working} className="op-btn-primary" style={{
              width: '100%', padding: '16px 22px', borderRadius: 14,
              background: valid ? theme.accent : `${theme.fg}20`,
              color: valid ? contrastFg(theme.accent) : `${theme.fg}60`,
              border: 'none', fontSize: 16, fontWeight: 800, cursor: valid && !working ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>{working ? 'Starting payment…' : 'Continue to payment'}</span>
              <span>£{subtotal.toFixed(2)}</span>
            </button>
            <div style={{ fontSize: 10, color: muted, textAlign: 'center', marginTop: 8 }}>
              🔒 Card details next, processed securely by Stripe.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PayStep — renders the CardElement + Pay button. Lives inside <Elements>
// so it can use useStripe() / useElements() to confirm the PaymentIntent.
function PayStep({ pi, subtotal, theme, cardBdr, inputBg, muted, cart, onPaid, onError, error }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!stripe || !elements) return;
    setBusy(true); onError('');
    const card = elements.getElement(CardElement);
    const { error: stripeErr, paymentIntent } = await stripe.confirmCardPayment(pi.client_secret, {
      payment_method: { card },
    });
    setBusy(false);
    if (stripeErr) {
      onError(stripeErr.message || 'Card declined.');
      return;
    }
    if (paymentIntent?.status === 'succeeded') {
      await onPaid(paymentIntent);
    } else {
      onError(`Payment status: ${paymentIntent?.status || 'unknown'}.`);
    }
  };

  return (
    <>
      <div style={{ padding: '0 24px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionTitle>Card details</SectionTitle>
        <div style={{
          padding: 14, borderRadius: 12, border: `1.5px solid ${cardBdr}`,
          background: inputBg,
        }}>
          <CardElement options={{
            style: { base: {
              color: theme.fg,
              fontSize: '16px',
              fontFamily: 'inherit',
              '::placeholder': { color: theme.isLight ? '#9a9aa1' : '#7d7d85' },
            } },
          }}/>
        </div>
        <div style={{ fontSize: 11, color: muted, lineHeight: 1.5 }}>
          Test mode: use card <code style={{ fontFamily: 'monospace', fontWeight: 700 }}>4242 4242 4242 4242</code> · any future expiry · any CVC.
        </div>

        {/* Mini summary so customer sees what they're paying for */}
        <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '12px 14px', marginTop: 4 }}>
          {cart.map(line => {
            const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
            return (
              <div key={line.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0 }}>{line.qty || 1} × {line.name}</span>
                <span style={{ fontWeight: 700 }}>£{(unit * (line.qty || 1)).toFixed(2)}</span>
              </div>
            );
          })}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 800 }}>Total</span>
            <span style={{ fontSize: 18, fontWeight: 900 }}>£{subtotal.toFixed(2)}</span>
          </div>
        </div>
      </div>

      <div style={{
        position: 'sticky', bottom: 0,
        padding: '14px 24px calc(14px + env(safe-area-inset-bottom)) 24px',
        background: theme.bg, borderTop: `1px solid ${cardBdr}`,
      }}>
        {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{error}</div>}
        <button onClick={submit} disabled={busy || !stripe} className="op-btn-primary" style={{
          width: '100%', padding: '16px 22px', borderRadius: 14,
          background: theme.accent, color: contrastFg(theme.accent),
          border: 'none', fontSize: 16, fontWeight: 800, cursor: busy ? 'wait' : 'pointer',
          fontFamily: 'inherit', opacity: busy ? 0.7 : 1,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>{busy ? 'Processing payment…' : 'Pay & place order'}</span>
          <span>£{subtotal.toFixed(2)}</span>
        </button>
        <div style={{ fontSize: 10, color: muted, textAlign: 'center', marginTop: 8 }}>
          🔒 Your order is only sent to the kitchen once payment clears.
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function SectionTitle({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em', textTransform: 'uppercase', opacity: 0.7 }}>{children}</div>;
}

function Field({ label, value, onChange, placeholder, type = 'text', theme, cardBdr, inputBg }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: theme.isLight ? '#6b6b70' : '#a0a0a8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{label}</div>
      <input type={type} value={value || ''} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          width: '100%', padding: '12px 14px', borderRadius: 10,
          background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`,
          fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
        }}/>
    </div>
  );
}

function ModeChip({ active, onClick, theme, cardBdr, children }) {
  return (
    <button onClick={onClick} className="op-btn" style={{
      flex: 1, padding: '16px 16px', borderRadius: 12,
      // Active = solid accent fill + contrast text + checkmark.
      // Inactive = transparent with thin border, dimmed.
      background: active ? theme.accent : 'transparent',
      color: active ? contrastFg(theme.accent) : theme.fg,
      border: `2px solid ${active ? theme.accent : cardBdr}`,
      boxShadow: active ? `0 4px 14px ${theme.accent}55` : 'none',
      fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
      opacity: active ? 1 : 0.7,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    }}>
      {active && <span style={{ fontSize: 14 }}>✓</span>}
      {children}
    </button>
  );
}

function SlotPicker({ slots, value, onChange, theme, cardBdr, inputBg }) {
  if (!slots.length) {
    return <div style={{ padding: 14, fontSize: 12, color: theme.isLight ? '#6b6b70' : '#a0a0a8', background: inputBg, borderRadius: 10, border: `1px solid ${cardBdr}` }}>
      No collection slots available right now. Try ASAP, or come back during opening hours.
    </div>;
  }
  // Group by day, preserving insertion order (already chronological)
  const byDay = {};
  slots.forEach(s => {
    if (!byDay[s.day]) byDay[s.day] = [];
    byDay[s.day].push(s);
  });
  const days = Object.keys(byDay);
  // If no value yet, default to first slot of first day so the time
  // dropdown isn't blank when the customer first picks Schedule.
  const selectedDay = value ? value.day : days[0];
  const selectedTime = value ? value.iso : '';
  const timesForDay = byDay[selectedDay] || [];

  const handleDayChange = (day) => {
    const list = byDay[day] || [];
    if (list.length) onChange(list[0]);
  };
  const handleTimeChange = (iso) => {
    const slot = (byDay[selectedDay] || []).find(s => s.iso === iso);
    if (slot) onChange(slot);
  };

  const selectStyle = {
    width: '100%', padding: '12px 14px', borderRadius: 10,
    background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`,
    fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
    fontWeight: 600,
    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
    backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' stroke='%23${(theme.isLight ? '6b6b70' : 'a0a0a8')}' stroke-width='1.6' fill='none' stroke-linecap='round'/></svg>")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 14px center',
    paddingRight: 36,
    cursor: 'pointer',
  };
  const labelStyle = { fontSize: 11, fontWeight: 700, color: theme.isLight ? '#6b6b70' : '#a0a0a8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, display: 'block' };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      <div>
        <label style={labelStyle}>Day</label>
        <select value={selectedDay} onChange={e => handleDayChange(e.target.value)} style={selectStyle}>
          {days.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Time</label>
        <select value={selectedTime} onChange={e => handleTimeChange(e.target.value)} style={selectStyle}>
          {timesForDay.map(s => (
            <option key={s.iso} value={s.iso}>{s.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the next ~24h of valid collection slots.
// Slots are 15-min increments inside opening windows, starting at the
// earliest slot ≥ now+leadMin, snapped to :00/:15/:30/:45.
function buildCollectionSlots(location, tz, leadMin) {
  const hours = location.opening_hours;
  if (!hours?.weekly) return [];
  const out = [];
  const now = new Date();
  const earliest = new Date(now.getTime() + leadMin * 60_000);
  // Round up to next 15-min boundary
  const m = earliest.getMinutes();
  const ceil = Math.ceil(m / 15) * 15;
  earliest.setMinutes(ceil, 0, 0);

  // Walk up to 7 days ahead, generate slots inside open windows ≥ earliest
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 24 * 60 * 60_000);
    const windows = getDayWindows(hours, tz, probe);
    if (!windows.length) continue;
    const dayLabel = probe.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
    for (const w of windows) {
      const [oh, om] = w.open.split(':').map(Number);
      const [ch, cm] = w.close.split(':').map(Number);
      // Earliest valid slot in this window
      const cur = new Date(probe);
      cur.setHours(oh, om, 0, 0);
      const end = new Date(probe);
      end.setHours(ch, cm, 0, 0);
      while (cur.getTime() < end.getTime()) {
        if (cur.getTime() >= earliest.getTime()) {
          out.push({
            iso: cur.toISOString(),
            day: dayOffset === 0 ? 'Today' : (dayOffset === 1 ? 'Tomorrow' : dayLabel),
            label: cur.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
          });
        }
        cur.setMinutes(cur.getMinutes() + 15);
      }
    }
    if (out.length >= 60) break; // reasonable upper bound
  }
  return out;
}

function contrastFg(hex) {
  if (!hex) return '#fff';
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  if (n.length !== 6) return '#fff';
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? '#0b0c10' : '#ffffff';
}
