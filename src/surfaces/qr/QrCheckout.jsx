// v5.5.145 — QR table-side checkout (commit 1: pay-now path only)
//
// Mirrors OnlineCheckout but for in-venue table service:
//   - No collection/delivery address; always dine-in
//   - No scheduled-time picker; always ASAP
//   - Tip selector (5% / 10% / 12.5% / 15% / Custom / No tip)
//   - Service charge auto-applied if location.qr_service_charge_pct is set
//   - Single "Pay & send to kitchen" button; Stripe Elements card input
//   - On success: writes closed_checks (status=paid, source=qr,
//     table_label='Table T5') AND order_queue (source='qr', type='dine-in',
//     status=prep, tableLabel) — kitchen routes via existing
//     routeKioskOrderPrints, prints with TABLE T5 header, KDS shows it
//
// Open-tab path (with Stripe pre-auth + bar_tabs row) lands in commit 2.
// Email receipts land in commit 3 (needs Resend/SES infra).

import { useEffect, useMemo, useState } from 'react';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { supabase } from '../../lib/supabase';
import { getStripeForAccount, createPaymentIntent } from '../../lib/stripeClient';
import { attributeOnlineOrder } from '../../lib/customerLookup';
import { calculateOrderTax } from '../../lib/tax';

export default function QrCheckout({ cart, theme, location, tableId, tableLabel, loyalty, taxRates = [], onClose, onPlaced }) {
  const opsLocationId      = location.ops_location_id || location.id;
  const platformLocationId = location.id;
  const tz                 = location.timezone || 'Europe/London';
  const serviceChargePct   = Number(location.qr_service_charge_pct ?? 0);
  // v5.5.149: open-tab support is BO-toggleable. When the venue allows tabs
  // we surface the customer-facing warning message + (commit 3b) a Pay-now
  // / Open-tab radio. paymentMode='pay_now' is the safe default.
  const paymentMode    = location.qr_payment_mode || 'pay_now';
  const tabWarning     = (location.qr_tab_warning_message || '').trim();
  const tabsAllowed    = paymentMode === 'open_tab' || paymentMode === 'both';

  const [step, setStep] = useState('details');
  const [pi, setPi] = useState(null);
  const [stripePromise, setStripePromise] = useState(null);

  const [name, setName]   = useState(loyalty?.name  || '');
  const [phone, setPhone] = useState(loyalty?.phone || '');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');

  const [tipMode, setTipMode] = useState('10');                // '0' | '5' | '10' | '12.5' | '15' | 'custom'
  const [customTip, setCustomTip] = useState('');

  // v5.5.150: payNow vs openTab. Defaults sensibly per location.qr_payment_mode:
  //   pay_now  → forced 'pay_now'
  //   open_tab → forced 'open_tab'
  //   both     → customer chooses, defaults to 'pay_now'
  const [payChoice, setPayChoice] = useState(
    paymentMode === 'open_tab' ? 'open_tab' : 'pay_now'
  );
  const isOpenTab = payChoice === 'open_tab';
  const tabPreAuthAmount = Number(location.qr_tab_pre_auth_amount ?? 100);

  const [working, setWorking] = useState(false);
  const [error, setError]     = useState('');

  const muted   = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBdr = theme.isLight ? '#ececef' : '#2a2a30';
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';

  const subtotal = useMemo(() => cart.reduce((s, l) => {
    const unit = l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
    return s + unit * (l.qty || 1);
  }, 0), [cart]);

  const serviceCharge = useMemo(() =>
    serviceChargePct > 0 ? +(subtotal * serviceChargePct / 100).toFixed(2) : 0,
    [subtotal, serviceChargePct]);

  const tipAmount = useMemo(() => {
    if (tipMode === 'custom') return Math.max(0, Number(customTip) || 0);
    if (tipMode === '0') return 0;
    return +(subtotal * Number(tipMode) / 100).toFixed(2);
  }, [tipMode, customTip, subtotal]);

  const total = useMemo(
    () => +(subtotal + serviceCharge + tipAmount).toFixed(2),
    [subtotal, serviceCharge, tipAmount]
  );

  // v5.5.154: UK VAT breakdown over the gross subtotal — items only.
  // Service charge and tip aren't VAT-rated. UK uses inclusive tax so
  // the figure shown is "incl. VAT £X.XX", not added on top.
  const taxBreakdown = useMemo(() => calculateOrderTax(
    cart.map(l => ({
      price: l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0),
      qty: l.qty || 1,
      taxRateId: l.taxRateId || l.tax_rate_id || null,
      taxOverrides: l.taxOverrides || l.tax_overrides || {},
    })),
    taxRates,
    'dine-in',
  ), [cart, taxRates]);

  const valid = useMemo(() => {
    if (!name.trim()) return false;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
    return true;
  }, [name, email]);

  const orderShape = useMemo(() => {
    const ref = `QR-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const customer = {
      name: name.trim(),
      phone: phone.replace(/\s+/g, ''),
      email: email.trim(),
      tableId,
      tableLabel: tableLabel || tableId,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    const items = cart.map(l => ({
      itemId: l.itemId, name: l.name, price: l.price,
      qty: l.qty || 1, mods: l.mods || [],
      cat: l.cat || null,
      cats: l.cats || null,
      parentId: l.parentId || null,
      kitchenName: l.kitchenName || null,
      // v5.5.145: stamp items as already 'sent' + fired:true (paid order
      // means kitchen owns it now, no operator click needed). Mirrors what
      // OnlineCheckout does for paid online orders.
      status: 'sent',
      fired: true,
      course: 1,
    }));
    return { ref, customer, items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const continueToPayment = async () => {
    if (!valid) { setError('Please enter your name (and a valid email if provided).'); return; }
    setWorking(true); setError('');
    try {
      // Anonymous sign-in so the connected-account edge fn accepts the JWT
      // (same path OnlineCheckout uses).
      let authToken = null;
      const existing = await supabase?.auth.getSession();
      authToken = existing?.data?.session?.access_token || null;
      if (!authToken) {
        const { data, error: anonErr } = await supabase.auth.signInAnonymously();
        if (anonErr) throw new Error('Could not start payment session: ' + anonErr.message);
        authToken = data?.session?.access_token;
      }
      if (!authToken) throw new Error('Could not obtain auth token for payment.');

      const { ref, customer } = orderShape;
      // v5.5.150: open-tab path uses captureMethod='manual' + a pre-auth
      // hold (set in BO). Pay-now path captures immediately for the actual
      // total. Same edge fn either way; the captureMethod flag is what
      // changes Stripe's behaviour.
      const piRes = await createPaymentIntent({
        authToken,
        locationId: platformLocationId,
        amountMinor: isOpenTab
          ? Math.round(tabPreAuthAmount * 100)
          : Math.round(total * 100),
        currency: 'gbp',
        channel: 'online', // applies online_markup_percent on the connected account
        captureMethod: isOpenTab ? 'manual' : 'automatic',
        description: isOpenTab
          ? `QR Tab open · Table ${tableLabel || tableId} · ${ref} · ${customer.name}`
          : `QR Table ${tableLabel || tableId} — ${ref} — ${customer.name}`,
        paymentMethodTypes: ['card'],
        metadata: {
          source: 'qr',
          ref,
          ops_location_id: String(opsLocationId),
          table_id: String(tableId || ''),
          table_label: String(tableLabel || tableId || ''),
          customer_name: customer.name,
          customer_email: customer.email,
          customer_phone: customer.phone,
          subtotal: String(subtotal),
          service_charge: String(serviceCharge),
          tip: String(tipAmount),
          tab_open: isOpenTab ? 'true' : 'false',
        },
      });
      if (!piRes?.client_secret) throw new Error('Payment could not start. Please try again.');
      setPi(piRes);
      setStripePromise(getStripeForAccount(piRes.stripe_account));
      setStep('pay');
    } catch (e) {
      console.error('[QrCheckout] createPaymentIntent failed:', e);
      setError(e?.message || 'Could not start payment.');
    } finally {
      setWorking(false);
    }
  };

  const onPaymentSuccess = async (paymentIntent) => {
    try {
      const { ref, customer, items } = orderShape;
      const tableLabelStr = `Table ${tableLabel || tableId || '?'}`;

      // v5.5.150: stash payment metadata in the order_queue.customer jsonb
      // (no schema migration needed). Force-close on POS reads these fields,
      // calls /api/stripe-capture, then writes closed_checks + marks the
      // queue row collected. tab_open=true tells the operator UI it's an
      // unpaid tab so it can show a "Force close & charge" button instead
      // of the regular advance buttons.
      const customerWithPayment = {
        ...customer,
        payment_intent_id: paymentIntent?.id || null,
        stripe_account: pi?.stripe_account || null,
        ...(isOpenTab ? {
          tab_open: true,
          tab_opened_at: new Date().toISOString(),
          pre_auth_amount: tabPreAuthAmount,
          tab_running_total: total,
          // v5.5.151: snapshot the venue's surcharge config at tab-open time
          // so the operator's force-close can apply auto-surcharge without
          // another platform.locations fetch. Snapshotting also means a
          // BO config change after tabs are open doesn't retroactively
          // change the policy customers already agreed to.
          tab_surcharge_pct:           Number(location.qr_tab_left_open_surcharge_pct ?? 0),
          tab_surcharge_fixed:         Number(location.qr_tab_left_open_surcharge_fixed ?? 0),
          tab_force_close_after_min:   Number(location.qr_tab_force_close_after_minutes ?? 0),
        } : { paid: true }),
      };

      // 1. order_queue — kitchen routing fires off this INSERT (master device
      // realtime handler). source='qr' + type='dine-in' + table_label so the
      // kitchen ticket prints "TABLE T5" header, the orders panel shows it
      // in the right bucket. No sent_at delay — fire immediately, even for
      // open-tab orders (table-service pattern: cook now, pay later).
      const queueRow = {
        ref,
        location_id: opsLocationId,
        type: 'dine-in',
        status: 'prep',
        source: 'qr',
        items, customer: customerWithPayment,
        total,
        sent_at: new Date().toISOString(),
        collection_time: null,
        is_asap: true,
      };
      const { error: qErr } = await supabase.from('order_queue').insert(queueRow);
      if (qErr) {
        console.error('[QrCheckout] order_queue write failed AFTER payment:', qErr);
        setError(isOpenTab
          ? `Card was authorised but we could not save the tab. Please show this to staff. Ref ${ref}.`
          : `Payment succeeded but we could not save the order. Please show this to staff. Ref ${ref}.`);
        return;
      }

      // 2. closed_checks — only on PAY-NOW orders. For open-tab the bill
      // isn't paid yet (status is requires_capture in Stripe) — closed_checks
      // gets written on force-close-and-capture by the operator (commit 3c).
      if (!isOpenTab) {
        try {
          await supabase.from('closed_checks').insert({
            id: `chk-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
            ref,
            location_id: opsLocationId,
            server: 'QR',
            staff_id: null,
            covers: 1,
            order_type: 'dine-in',
            customer: customerWithPayment,
            items: items.map(i => ({ ...i, voided: false })),
            discounts: [],
            subtotal,
            service: serviceCharge,
            tip: tipAmount,
            tax_amount: taxBreakdown?.totalTax || null, // v5.5.154: VAT for reports + receipt
            total,
            method: 'card',
            drawer_id: null,
            shift_id: null,
            closed_at: new Date().toISOString(),
            status: 'paid',
            refunds: [],
            table_id: tableId || null,
            table_label: tableLabelStr,
            source: 'qr',
          });
        } catch (e) {
          console.warn('[QrCheckout] closed_checks insert failed:', e?.message);
        }
      }

      // 3. Customer CRM (fire-and-forget — phone optional for QR, only
      // attributes when phone provided so we don't clutter the customer
      // table with anonymous one-shot scans).
      if (customer.phone) {
        attributeOnlineOrder({
          phone: customer.phone, name: customer.name, email: customer.email,
          marketingOptIn: false,
          locationId: opsLocationId,
          orderRecord: { ref, total, items, type: 'dine-in' },
        }).catch(e => console.warn('[QrCheckout] attribute failed:', e?.message));
      }

      onPlaced?.({ ref, total, paymentIntent });
    } catch (e) {
      console.error('[QrCheckout] post-payment write failed:', e);
      setError('Payment succeeded but we could not save the order. Show this to staff. Ref ' + orderShape.ref + '.');
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 600, maxHeight: '96vh', overflowY: 'auto',
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
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
              Table {tableLabel || tableId || '?'} · {cart.length} item{cart.length === 1 ? '' : 's'} · £{total.toFixed(2)}
            </div>
          </div>
          <button onClick={step === 'pay' ? () => { setStep('details'); setPi(null); setError(''); } : onClose}
            style={{
              padding: '0 14px', height: 36, borderRadius: 99, border: `1px solid ${cardBdr}`,
              background: inputBg, color: theme.fg,
              fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            }}>{step === 'pay' ? '← Edit' : '×'}</button>
        </div>

        <div style={{ display: 'flex', gap: 6, padding: '0 24px 14px' }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: theme.accent }}/>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: step === 'pay' ? theme.accent : cardBdr }}/>
        </div>

        {step === 'pay' && pi && stripePromise ? (
          <Elements stripe={stripePromise} options={{ clientSecret: pi.client_secret, appearance: { theme: theme.isLight ? 'stripe' : 'night' } }}>
            <PayStep
              pi={pi} subtotal={subtotal} serviceCharge={serviceCharge} tipAmount={tipAmount} total={total}
              tableLabel={tableLabel || tableId}
              theme={theme} cardBdr={cardBdr} inputBg={inputBg} muted={muted}
              cart={cart} taxBreakdown={taxBreakdown}
              onPaid={onPaymentSuccess} onError={setError} error={error}
              isOpenTab={isOpenTab} tabPreAuthAmount={tabPreAuthAmount}
            />
          </Elements>
        ) : (
        <div style={{ padding: '0 24px 12px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <SectionTitle>Your details</SectionTitle>
          <Field label="Name" value={name} onChange={setName} placeholder="Your name (so we know whose order this is)" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Phone (optional)" value={phone} onChange={setPhone} placeholder="07700 900000" type="tel" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
            <Field label="Email (optional)" value={email} onChange={setEmail} placeholder="for receipt" type="email" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          </div>
          <Field label="Notes for the kitchen (optional)" value={notes} onChange={setNotes} placeholder="Allergies, preferences, etc." theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>

          {/* v5.5.150: Pay-now / Open-tab choice — only when venue allows
              both. Open-tab pre-authorises the card; the bill is captured
              when staff close the tab from the POS. */}
          {paymentMode === 'both' && (
            <>
              <SectionTitle>How would you like to pay?</SectionTitle>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <PayChoiceCard active={payChoice === 'pay_now'} onClick={() => setPayChoice('pay_now')}
                  theme={theme} cardBdr={cardBdr} inputBg={inputBg}
                  title="💳 Pay now" sub="Pay this round and we'll bring it over."/>
                <PayChoiceCard active={payChoice === 'open_tab'} onClick={() => setPayChoice('open_tab')}
                  theme={theme} cardBdr={cardBdr} inputBg={inputBg}
                  title="📋 Open tab" sub={`Hold £${tabPreAuthAmount} on your card; staff close the tab when you're done.`}/>
              </div>
            </>
          )}

          <SectionTitle>Tip</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
            {['0','5','10','12.5','15','custom'].map(opt => (
              <TipChip key={opt} active={tipMode === opt} onClick={() => setTipMode(opt)}
                theme={theme} cardBdr={cardBdr}>
                {opt === '0' ? 'No tip' : opt === 'custom' ? '✏️' : `${opt}%`}
              </TipChip>
            ))}
          </div>
          {tipMode === 'custom' && (
            <Field label="Custom tip (£)" value={customTip} onChange={setCustomTip} placeholder="0.00" type="number" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          )}

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
            <SummaryLine label="Subtotal" value={subtotal} muted={muted}/>
            {/* v5.5.154: UK VAT breakdown — required on every customer-
                facing total for compliance. Inclusive: shown as "incl."
                on top of the subtotal which already contains the tax. */}
            {taxBreakdown.totalTax > 0 && taxBreakdown.breakdown.map((b, i) => (
              <SummaryLine key={`vat-${i}`}
                label={`incl. ${b.rate.name || `VAT ${(Number(b.rate.rate) * 100).toFixed(0)}%`}`}
                value={b.tax} muted={muted}/>
            ))}
            {serviceCharge > 0 && <SummaryLine label={`Service charge (${serviceChargePct}%)`} value={serviceCharge} muted={muted}/>}
            {tipAmount > 0 && <SummaryLine label="Tip" value={tipAmount} muted={muted}/>}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>Total</span>
              <span style={{ fontSize: 18, fontWeight: 900 }}>£{total.toFixed(2)}</span>
            </div>
          </div>
        </div>
        )}

        {step === 'details' && (
          <div style={{
            position: 'sticky', bottom: 0,
            padding: '14px 24px calc(14px + env(safe-area-inset-bottom)) 24px',
            background: theme.bg, borderTop: `1px solid ${cardBdr}`,
          }}>
            {/* v5.5.149: customer-facing tab guardrail warning. Only shown
                when the venue allows open tabs; hidden for pay-now-only
                venues since the surcharge wouldn't apply to them. */}
            {tabsAllowed && tabWarning && (
              <div style={{
                marginBottom: 10, padding: '10px 12px', borderRadius: 10,
                background: '#fef3c7', border: '1px solid #f59e0b',
                color: '#78350f', fontSize: 12, fontWeight: 600, lineHeight: 1.5,
              }}>
                {tabWarning}
              </div>
            )}
            {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{error}</div>}
            <button onClick={continueToPayment} disabled={!valid || working}
              className={valid && !working ? 'op-btn-primary' : undefined}
              style={{
                width: '100%', padding: '16px 22px', borderRadius: 14,
                background: valid ? theme.accent : `${theme.fg}20`,
                color: valid ? contrastFg(theme.accent) : `${theme.fg}60`,
                border: 'none', fontSize: 16, fontWeight: 800,
                cursor: valid && !working ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
              <span>{working ? 'Starting payment…' : (isOpenTab ? 'Continue — open a tab' : 'Continue to payment')}</span>
              <span>£{(isOpenTab ? tabPreAuthAmount : total).toFixed(2)}{isOpenTab ? ' hold' : ''}</span>
            </button>
            <div style={{ fontSize: 10, color: muted, textAlign: 'center', marginTop: 8 }}>
              {isOpenTab
                ? `🔒 We'll hold £${tabPreAuthAmount} on your card. Final bill is taken when staff close the tab.`
                : '🔒 Card next, processed securely by Stripe.'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PayStep({ pi, subtotal, serviceCharge, tipAmount, total, tableLabel, theme, cardBdr, inputBg, muted, cart, taxBreakdown, onPaid, onError, error, isOpenTab, tabPreAuthAmount }) {
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
    if (stripeErr) { onError(stripeErr.message || 'Card declined.'); return; }
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
        <div style={{ padding: 14, borderRadius: 12, border: `1.5px solid ${cardBdr}`, background: inputBg }}>
          <CardElement options={{
            style: { base: {
              color: theme.fg, fontSize: '16px', fontFamily: 'inherit',
              '::placeholder': { color: theme.isLight ? '#9a9aa1' : '#7d7d85' },
            } },
          }}/>
        </div>
        <div style={{ fontSize: 11, color: muted, lineHeight: 1.5 }}>
          Test mode: <code style={{ fontFamily: 'monospace', fontWeight: 700 }}>4242 4242 4242 4242</code> · any future expiry · any CVC.
        </div>
        <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '12px 14px', marginTop: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Table {tableLabel || '?'} · paying now
          </div>
          {cart.map(line => {
            const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
            return (
              <div key={line.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0 }}>{line.qty || 1} × {line.name}</span>
                <span style={{ fontWeight: 700 }}>£{(unit * (line.qty || 1)).toFixed(2)}</span>
              </div>
            );
          })}
          <SummaryLine label="Subtotal" value={subtotal} muted={muted}/>
          {taxBreakdown?.totalTax > 0 && taxBreakdown.breakdown.map((b, i) => (
            <SummaryLine key={`vat-${i}`}
              label={`incl. ${b.rate.name || `VAT ${(Number(b.rate.rate) * 100).toFixed(0)}%`}`}
              value={b.tax} muted={muted}/>
          ))}
          {serviceCharge > 0 && <SummaryLine label="Service charge" value={serviceCharge} muted={muted}/>}
          {tipAmount > 0 && <SummaryLine label="Tip" value={tipAmount} muted={muted}/>}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 800 }}>Total</span>
            <span style={{ fontSize: 18, fontWeight: 900 }}>£{total.toFixed(2)}</span>
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
          <span>{busy
            ? (isOpenTab ? 'Authorising…' : 'Processing payment…')
            : (isOpenTab ? 'Authorise & open tab' : 'Pay & send to kitchen')}</span>
          <span>£{(isOpenTab ? tabPreAuthAmount : total).toFixed(2)}{isOpenTab ? ' hold' : ''}</span>
        </button>
        <div style={{ fontSize: 10, color: muted, textAlign: 'center', marginTop: 8 }}>
          {isOpenTab
            ? `🔒 £${tabPreAuthAmount} card hold. Actual bill taken when staff close the tab.`
            : '🔒 Your order goes to the kitchen the moment payment clears.'}
        </div>
      </div>
    </>
  );
}

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

function PayChoiceCard({ active, onClick, title, sub, theme, cardBdr, inputBg }) {
  return (
    <button onClick={onClick} className="op-btn"
      style={{
        padding: '14px 14px', borderRadius: 14,
        background: active ? `${theme.accent}28` : inputBg,
        color: theme.fg,
        border: `${active ? 3 : 1.5}px solid ${active ? theme.accent : cardBdr}`,
        boxShadow: active ? `0 4px 14px ${theme.accent}40` : 'none',
        cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
        opacity: active ? 1 : 0.85,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
      <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
      <div style={{ fontSize: 11, color: theme.isLight ? '#6b6b70' : '#a0a0a8', lineHeight: 1.4 }}>{sub}</div>
    </button>
  );
}

function TipChip({ active, onClick, theme, cardBdr, children }) {
  return (
    <button onClick={onClick} className="op-btn"
      style={{
        padding: '12px 6px', borderRadius: 12,
        background: active ? theme.accent : 'transparent',
        color: active ? contrastFg(theme.accent) : theme.fg,
        border: `2px solid ${active ? theme.accent : cardBdr}`,
        boxShadow: active ? `0 4px 14px ${theme.accent}55` : 'none',
        fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
        opacity: active ? 1 : 0.75,
      }}>{children}</button>
  );
}

function SummaryLine({ label, value, muted }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, color: muted }}>
      <span>{label}</span>
      <span>£{value.toFixed(2)}</span>
    </div>
  );
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
