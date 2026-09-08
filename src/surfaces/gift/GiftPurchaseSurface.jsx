// v5.5.205 — Customer-facing gift card purchase page.
// URL: https://<slug>.serv-os.app/gift
//
// Flow:
//   1. Customer picks an amount (presets or custom)
//   2. Enters sender + recipient details + optional message
//   3. Clicks "Buy gift card" → calls gift-checkout-session edge function
//   4. Redirected to Stripe Checkout (hosted page on merchant's connected acct)
//   5. On success, Stripe webhook fires → gift-fulfill issues card + emails it
//   6. Customer lands on /gift/success with session_id in query string

import { useState, useEffect, useMemo } from 'react';
import { callGiftPublic, formatAmount, PRESET_AMOUNTS, buildGiftTheme, fetchGiftBranding, giftUrl } from './giftHelpers';
import RyftPaymentForm from '../../components/RyftPaymentForm';

export default function GiftPurchaseSurface({ location }) {
  const [giftBranding, setGiftBranding] = useState(null);
  useEffect(() => {
    fetchGiftBranding(location?.company_id).then(b => { if (b) setGiftBranding(b); });
  }, [location?.company_id]);
  const t = useMemo(() => buildGiftTheme(location, giftBranding), [location, giftBranding]);
  // Amount (minor units)
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [customAmount, setCustomAmount] = useState('');
  const [isCustom, setIsCustom] = useState(false);

  // Sender
  const [senderName, setSenderName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [senderPhone, setSenderPhone] = useState('');

  // Recipient
  const [deliveryType, setDeliveryType] = useState('email'); // 'email' | 'self'
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [message, setMessage] = useState('');

  // State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // v5.5.911: a Ryft venue pays IN-PAGE — Ryft has no hosted checkout page to redirect
  // to. The server hands back a payment session it created; this holds it.
  const [ryftSession, setRyftSession] = useState(null);

  // Resolve the amount
  const amountMinor = useMemo(() => {
    if (isCustom) {
      const v = parseFloat(customAmount);
      return Number.isFinite(v) && v >= 5 ? Math.round(v * 100) : 0;
    }
    return selectedPreset || 0;
  }, [isCustom, customAmount, selectedPreset]);

  // v5.5.220: phone mandatory — links purchase to customer profile for loyalty
  const phoneClean = senderPhone.replace(/[^\d+]/g, '');
  const phoneValid = phoneClean.length >= 10;
  const canSubmit = amountMinor >= 500 && senderName.trim() && senderEmail.trim() && phoneValid
    && (deliveryType === 'self' || (recipientName.trim() && recipientEmail.trim()));

  const handleBuy = async () => {
    if (!canSubmit || loading) return;
    setLoading(true);
    setError('');
    try {
      const body = {
        company_id: location.company_id,
        location_id: location.id,
        amount_minor: amountMinor,
        sender_name: senderName.trim(),
        sender_email: senderEmail.trim(),
        sender_phone: senderPhone.trim(),
        recipient_name: deliveryType === 'self' ? senderName.trim() : recipientName.trim(),
        recipient_email: deliveryType === 'self' ? senderEmail.trim() : recipientEmail.trim(),
        message: message.trim() || null,
        delivery_type: deliveryType,
        success_url: (() => {
          const loc = new URLSearchParams(window.location.search).get('loc');
          return `${window.location.origin}/gift/success?session_id={CHECKOUT_SESSION_ID}${loc ? `&loc=${encodeURIComponent(loc)}` : ''}`;
        })(),
        cancel_url: giftUrl('/gift'),
      };
      const data = await callGiftPublic('gift-checkout-session', body);
      // v5.5.911 — the SERVER decides the processor, and answers in one of two shapes.
      if (data.processor === 'ryft' && data.clientSecret) {
        setRyftSession(data);     // stay on the page; the embedded form takes it from here
        setLoading(false);
      } else if (data.checkout_url) {
        window.location.href = data.checkout_url;      // Stripe — unchanged
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      setError(err.message || 'Something went wrong');
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden',
      WebkitOverflowScrolling: 'touch',
      background: t.bg, color: t.text,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '40px 20px 60px',
    }}>
      {/* Header — v5.5.208: larger logo, org name instead of location */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        {t.logo && (
          <img src={t.logo} alt={t.companyName || location.name} style={{
            height: 96, width: 'auto', maxWidth: 300, borderRadius: 18, objectFit: 'contain',
            background: '#fff', padding: '12px 18px', boxSizing: 'border-box',
            boxShadow: '0 6px 22px rgba(0,0,0,0.18)', marginBottom: 16,
          }}/>
        )}
        {!t.logo && <div style={{ fontSize: 26, fontWeight: 800 }}>{t.companyName || location.name}</div>}
        <div style={{ fontSize: 13, color: t.textMuted, marginTop: 4 }}>
          Send a gift card to someone special
        </div>
      </div>

      <div style={{ width: '100%', maxWidth: 420 }}>

        {/* ── Amount selection ───────────────────────────── */}
        <Section title="Choose an amount" t={t}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10,
          }}>
            {PRESET_AMOUNTS.map(amt => (
              <AmountChip
                key={amt}
                label={formatAmount(amt)}
                selected={!isCustom && selectedPreset === amt}
                onClick={() => { setSelectedPreset(amt); setIsCustom(false); }}
                t={t}
              />
            ))}
          </div>

          {/* Custom amount */}
          <div style={{ marginTop: 12 }}>
            <button
              onClick={() => { setIsCustom(true); setSelectedPreset(null); }}
              style={{
                width: '100%', padding: '12px 16px', borderRadius: 10,
                border: `1px solid ${isCustom ? t.accent : t.border}`,
                background: isCustom ? t.accent + '18' : 'transparent',
                color: isCustom ? t.accent : t.textMuted,
                fontSize: 13, fontWeight: 700, cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {isCustom ? 'Custom amount:' : 'Enter custom amount…'}
            </button>
            {isCustom && (
              <div style={{ position: 'relative', marginTop: 8 }}>
                <span style={{
                  position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
                  color: t.textMuted, fontSize: 18, fontWeight: 700,
                }}>£</span>
                <input
                  type="number"
                  min="5"
                  max="500"
                  step="0.01"
                  value={customAmount}
                  onChange={e => setCustomAmount(e.target.value)}
                  placeholder="25.00"
                  autoFocus
                  style={{
                    width: '100%', padding: '14px 16px 14px 32px', borderRadius: 10,
                    border: `1px solid ${t.border}`, background: t.inputBg, color: t.text,
                    fontSize: 18, fontWeight: 700, boxSizing: 'border-box', outline: 'none',
                  }}
                  onFocus={e => e.target.style.borderColor = t.accent}
                  onBlur={e => e.target.style.borderColor = t.border}
                />
                {customAmount && parseFloat(customAmount) < 5 && (
                  <div style={{ fontSize: 11, color: t.error, marginTop: 4 }}>Minimum £5.00</div>
                )}
              </div>
            )}
          </div>
        </Section>

        {/* ── Your details ───────────────────────────────── */}
        <Section title="Your details" t={t}>
          <Input label="Your name" value={senderName} onChange={setSenderName} placeholder="Your name" t={t} />
          <Input label="Your email" type="email" value={senderEmail} onChange={setSenderEmail} placeholder="you@email.com" t={t} />
          <Input label="Your mobile number" type="tel" value={senderPhone} onChange={v => setSenderPhone(v.replace(/[^0-9 +]/g, ''))} placeholder="07xxx xxx xxx" t={t} inputMode="tel" />
        </Section>

        {/* ── Delivery ───────────────────────────────────── */}
        <Section title="Send to" t={t}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <ToggleChip
              label="Someone else"
              selected={deliveryType === 'email'}
              onClick={() => setDeliveryType('email')}
              t={t}
            />
            <ToggleChip
              label="Myself"
              selected={deliveryType === 'self'}
              onClick={() => setDeliveryType('self')}
              t={t}
            />
          </div>

          {deliveryType === 'email' && (
            <>
              <Input label="Recipient name" value={recipientName} onChange={setRecipientName} placeholder="Their name" t={t} />
              <Input label="Recipient email" type="email" value={recipientEmail} onChange={setRecipientEmail} placeholder="them@email.com" t={t} />
              <div style={{ marginTop: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: t.textMuted, display: 'block', marginBottom: 6 }}>
                  Personal message <span style={{ fontWeight: 400, color: t.textDim }}>(optional)</span>
                </label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder="Enjoy your meal! 🎉"
                  maxLength={200}
                  rows={3}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10,
                    border: `1px solid ${t.border}`, background: t.inputBg, color: t.text,
                    fontSize: 14, resize: 'none', boxSizing: 'border-box',
                    fontFamily: 'inherit', outline: 'none',
                  }}
                  onFocus={e => e.target.style.borderColor = t.accent}
                  onBlur={e => e.target.style.borderColor = t.border}
                />
                <div style={{ fontSize: 11, color: t.textDim, textAlign: 'right', marginTop: 2 }}>
                  {message.length}/200
                </div>
              </div>
            </>
          )}
        </Section>

        {/* ── Ryft: pay in-page (v5.5.911) ────────────────
            Ryft has no hosted checkout page to redirect to, so once the server has
            created the payment session the customer pays right here. onSuccess ONLY
            navigates — the card is issued by ryft-webhook on PaymentSession.captured,
            never from this callback, which the browser could assert. */}
        {ryftSession && (
          <div style={{
            background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius,
            padding: '20px 24px', marginBottom: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: t.textMuted }}>Paying</span>
              <span style={{ fontSize: 22, fontWeight: 800 }}>{formatAmount(amountMinor)}</span>
            </div>
            <RyftPaymentForm
              session={ryftSession}
              amountMinor={amountMinor}
              currency={ryftSession.currency || 'gbp'}
              locationId={location?.id}
              channel="online"
              merchantName={t.displayName || location?.name || ''}
              customerEmail={senderEmail.trim()}
              showSessionId={false}
              payLabel={`Pay ${formatAmount(amountMinor)}`}
              onSuccess={() => {
                // giftUrl() adds its own ?loc= for the multi-location case, so append
                // with the right separator rather than a second '?'.
                const base = giftUrl('/gift/success');
                window.location.href =
                  `${base}${base.includes('?') ? '&' : '?'}purchase_id=${encodeURIComponent(ryftSession.purchase_id)}`;
              }}
              onError={(e) => setError(e?.message || 'Payment failed — please try again')}
            />
          </div>
        )}

        {/* ── Summary + buy button ───────────────────────── */}
        {!ryftSession && amountMinor > 0 && (
          <div style={{
            background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius,
            padding: '20px 24px', marginBottom: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: t.textMuted }}>Gift card value</span>
              <span style={{ fontSize: 22, fontWeight: 800 }}>{formatAmount(amountMinor)}</span>
            </div>
            {deliveryType === 'email' && recipientName && (
              <div style={{ fontSize: 12, color: t.textMuted, marginTop: 8 }}>
                Delivered by email to <b style={{ color: t.text }}>{recipientName}</b>
              </div>
            )}
            {deliveryType === 'self' && (
              <div style={{ fontSize: 12, color: t.textMuted, marginTop: 8 }}>
                Sent to your email
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{
            padding: '12px 16px', borderRadius: 10, background: t.error + '18',
            border: `1px solid ${t.error}30`, color: t.error, fontSize: 13,
            marginBottom: 16, textAlign: 'center',
          }}>
            {error}
          </div>
        )}

        <button
          onClick={handleBuy}
          disabled={!canSubmit || loading}
          style={{
            width: '100%', padding: '16px 0', borderRadius: 99,
            background: (!canSubmit || loading) ? t.textDim : t.accent,
            color: t.accentText, border: 'none', fontWeight: 800, fontSize: 16,
            cursor: (!canSubmit || loading) ? 'not-allowed' : 'pointer',
            opacity: (!canSubmit || loading) ? 0.5 : 1,
            marginBottom: 16,
          }}
        >
          {loading ? 'Redirecting to payment…' : `Buy ${amountMinor > 0 ? formatAmount(amountMinor) : ''} Gift Card`}
        </button>

        {/* Links */}
        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <a
            href={giftUrl('/gift/balance')}
            style={{ color: t.accent, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}
          >
            Check gift card balance →
          </a>
        </div>

        <div style={{ textAlign: 'center', marginTop: 32, fontSize: 11, color: t.textDim }}>
          Powered by Serv OS
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Section({ title, children, t }) {
  return (
    <div style={{
      background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius,
      padding: '24px 24px 20px', marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 800, color: t.text, textTransform: 'uppercase',
        letterSpacing: '0.08em', marginBottom: 14, opacity: 0.7,
      }}>{title}</div>
      {children}
    </div>
  );
}

function Input({ label, value, onChange, placeholder, type = 'text', t, inputMode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: t.textMuted, display: 'block', marginBottom: 6 }}>
        {label}
      </label>
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%', padding: '12px 14px', borderRadius: 10,
          border: `1px solid ${t.border}`, background: t.inputBg, color: t.text,
          fontSize: 14, boxSizing: 'border-box', outline: 'none',
          fontFamily: 'inherit',
        }}
        onFocus={e => e.target.style.borderColor = t.accent}
        onBlur={e => e.target.style.borderColor = t.border}
      />
    </div>
  );
}

function AmountChip({ label, selected, onClick, t }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '14px 8px', borderRadius: 10,
        border: `1px solid ${selected ? t.accent : t.border}`,
        background: selected ? t.accent : 'transparent',
        color: selected ? t.accentText : t.text, fontWeight: 800, fontSize: 16,
        cursor: 'pointer', textAlign: 'center',
      }}
    >
      {label}
    </button>
  );
}

function ToggleChip({ label, selected, onClick, t }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '10px 14px', borderRadius: 10,
        border: `1px solid ${selected ? t.accent : t.border}`,
        background: selected ? t.accent : 'transparent',
        color: selected ? t.accentText : t.textMuted,
        fontWeight: 700, fontSize: 13, cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}
